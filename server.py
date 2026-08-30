# -*- coding: utf-8 -*-
"""
算法雷达站 - 本地/线上服务器（仅 Python 标准库，零依赖）

职责：
  1. 提供前端静态页面（public/ 下固定白名单文件，不接受来自请求的路径）
  2. 洛谷题目信息代理抓取（题目名/难度/算法标签），结果缓存在内存
  3. 服务端权威数据存储（store.py）：records / problems 的增删改与审核
  4. 管理员鉴权（auth.py）：PBKDF2 口令 + HMAC 签名会话 Cookie + CSRF + 登录限流

与旧版的关键差异：
  * 权限校验在服务端完成。前端不再持有任何凭据，也不能自称管理员。
  * /api/sync 全量覆盖接口已移除，改为细粒度的增量接口（避免匿名清库）。
  * 所有写操作校验 CSRF 令牌与请求体大小，记录经白名单清洗后入库。

启动：
  python server.py                  # 本地，仅监听 127.0.0.1
  python server.py --set-password   # 交互式设置管理员账号（生成 credentials.json）
"""
import getpass
import json
import os
import sys
import threading
import time
import urllib.parse
import webbrowser
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import auth
import luogu_fetch
import store
from luogu_fetch import DIFFICULTY_NAMES, fetch_luogu_problem

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

PORT = int(os.environ.get("PORT", "8471"))
SESSION_COOKIE = "radar_session"
CSRF_COOKIE = "radar_csrf"

MAX_BODY = 2 * 1024 * 1024          # 普通写请求体上限 2 MB
MAX_IMPORT_BODY = 16 * 1024 * 1024  # 导入接口上限 16 MB

# 反向代理（Render 等）后才信任 X-Forwarded-* 头；本地默认不信任，避免伪造 IP 绕过限流
TRUST_PROXY = os.environ.get("TRUST_PROXY", "1" if os.environ.get("RENDER") else "0") == "1"

# 题目信息内存缓存：{pid: info}，仅供本次运行加速
PROBLEM_CACHE = {}
CACHE_LOCK = threading.Lock()

# ---------------------------------------------------------------- 静态文件白名单
STATIC_WHITELIST = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/admin.html": ("admin.html", "text/html; charset=utf-8"),
    "/admin.js": ("admin.js", "application/javascript; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/common.js": ("common.js", "application/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/vendor/chart.umd.js": (os.path.join("vendor", "chart.umd.js"), "application/javascript; charset=utf-8"),
}

# 内容安全策略：只允许同源资源，禁止内联脚本/内联样式与被嵌入 iframe
CSP = (
    "default-src 'none'; "
    "script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; "
    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)


def read_static_file(url_path):
    entry = STATIC_WHITELIST.get(url_path)
    if entry is None:
        return None
    rel, ctype = entry
    disk_path = os.path.join(PUBLIC_DIR, rel)
    if not os.path.isfile(disk_path):
        return None
    with open(disk_path, "rb") as f:
        return f.read(), ctype


def get_problem_info(pid):
    pid = pid.strip().upper()
    with CACHE_LOCK:
        cached = PROBLEM_CACHE.get(pid)
    if cached:
        return cached
    info = fetch_luogu_problem(pid)
    with CACHE_LOCK:
        if len(PROBLEM_CACHE) > 5000:
            PROBLEM_CACHE.clear()
        PROBLEM_CACHE[pid] = info
    return info


class HttpError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "AlgorithmRadar/2.0"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------ 基础工具
    def _client_key(self):
        ip = self.client_address[0] if self.client_address else "?"
        if TRUST_PROXY:
            fwd = self.headers.get("X-Forwarded-For")
            if fwd:
                ip = fwd.split(",")[0].strip() or ip
        return ip

    def _is_https(self):
        if os.environ.get("FORCE_SECURE_COOKIE") == "1":
            return True
        if TRUST_PROXY and (self.headers.get("X-Forwarded-Proto") or "").lower() == "https":
            return True
        return False

    def _cookies(self):
        jar = cookies.SimpleCookie()
        raw = self.headers.get("Cookie")
        if raw:
            try:
                jar.load(raw)
            except cookies.CookieError:
                return {}
        return {k: v.value for k, v in jar.items()}

    def _set_cookie(self, name, value, http_only=True, max_age=auth.SESSION_TTL):
        parts = ["%s=%s" % (name, value), "Path=/", "SameSite=Strict", "Max-Age=%d" % max_age]
        if http_only:
            parts.append("HttpOnly")
        if self._is_https():
            parts.append("Secure")
        self._pending_cookies.append("; ".join(parts))

    def _clear_cookie(self, name):
        parts = ["%s=" % name, "Path=/", "SameSite=Strict", "Max-Age=0"]
        if self._is_https():
            parts.append("Secure")
        self._pending_cookies.append("; ".join(parts))

    def _send(self, code, content, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(content, (dict, list)):
            content = json.dumps(content, ensure_ascii=False).encode("utf-8")
        elif isinstance(content, str):
            content = content.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        if ctype.startswith("text/html"):
            self.send_header("Content-Security-Policy", CSP)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        for c in getattr(self, "_pending_cookies", []):
            self.send_header("Set-Cookie", c)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def _query(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def _read_json(self, limit=MAX_BODY):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise HttpError(400, "Content-Length 不合法")
        if length <= 0:
            return {}
        if length > limit:
            raise HttpError(413, "请求体过大（上限 %d MB）" % (limit // (1024 * 1024)))
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise HttpError(400, "请求体不是合法 JSON")
        return data

    def log_message(self, fmt, *args):
        print("[%s] %s" % (time.strftime("%H:%M:%S"), fmt % args))

    # ------------------------------------------------------------ 鉴权
    def _current_admin(self):
        """返回已登录的管理员用户名，未登录返回 None；必要时续签会话"""
        token = self._cookies().get(SESSION_COOKIE)
        username, should_renew = auth.verify_session(token)
        if username and should_renew:
            self._set_cookie(SESSION_COOKIE, auth.issue_session(username))
        return username

    def _require_admin(self):
        username = self._current_admin()
        if not username:
            raise HttpError(401, "需要管理员登录")
        return username

    def _require_csrf(self):
        jar = self._cookies()
        if not auth.csrf_ok(jar.get(CSRF_COOKIE), self.headers.get("X-CSRF-Token")):
            raise HttpError(403, "CSRF 校验失败，请刷新页面后重试")

    def _ensure_csrf_cookie(self):
        """保证浏览器持有 CSRF 令牌，并把它回传给前端（前端放进请求头）"""
        token = self._cookies().get(CSRF_COOKIE)
        if not token or len(token) < 16:
            token = auth.new_csrf_token()
            self._set_cookie(CSRF_COOKIE, token, http_only=False)
        return token

    def _is_loopback(self):
        return (self.client_address[0] if self.client_address else "") in ("127.0.0.1", "::1", "localhost")

    def _rate_limit(self, limiter, name):
        wait = limiter.retry_after(self._client_key())
        if wait:
            raise HttpError(429, "%s请求过于频繁，请 %d 秒后再试" % (name, wait))

    # ------------------------------------------------------------ 路由
    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        self._pending_cookies = []
        path = urllib.parse.urlparse(self.path).path
        try:
            if path.startswith("/api/"):
                self._api(method, path)
            elif method != "GET":
                raise HttpError(405, "方法不允许")
            else:
                served = read_static_file(path)
                if served is None:
                    raise HttpError(404, "页面不存在")
                content, ctype = served
                if ctype.startswith("text/html"):
                    self._ensure_csrf_cookie()
                self._send(200, content, ctype)
        except HttpError as e:
            self._send(e.code, {"error": e.message})
        except store.ValidationError as e:
            self._send(400, {"error": str(e)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:                      # 兜底：不泄露堆栈细节给客户端
            print("[error] %s %s -> %r" % (method, path, e), file=sys.stderr)
            self._send(500, {"error": "服务器内部错误"})

    def _api(self, method, path):
        # 变更类请求统一先过 CSRF 与写限流
        if method in ("POST", "PUT", "DELETE") and path not in ("/api/login",):
            self._require_csrf()
            self._rate_limit(auth.WRITE_LIMITER, "写入")
            auth.WRITE_LIMITER.hit(self._client_key())

        if path == "/api/ping" and method == "GET":
            return self._send(200, {
                "ok": True,
                "app": "算法雷达站",
                "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                "difficultyNames": DIFFICULTY_NAMES,
            })

        if path == "/api/session" and method == "GET":
            csrf = self._ensure_csrf_cookie()
            username = self._current_admin()
            return self._send(200, {
                "admin": bool(username),
                "username": username or "",
                "configured": auth.is_configured(),
                "canSetup": (not auth.is_configured()) and self._is_loopback(),
                "csrfToken": csrf,
                "gistBackup": store.gist_enabled(),
            })

        if path == "/api/setup" and method == "POST":
            return self._handle_setup()

        if path == "/api/login" and method == "POST":
            return self._handle_login()

        if path == "/api/logout" and method == "POST":
            self._clear_cookie(SESSION_COOKIE)
            return self._send(200, {"ok": True})

        if path == "/api/data" and method == "GET":
            username = self._current_admin()
            return self._send(200, store.snapshot(include_pending=bool(username)))

        if path == "/api/luogu" and method == "GET":
            return self._handle_luogu()

        if path == "/api/records" and method == "POST":
            payload = self._read_json()
            username = self._current_admin()
            if not username and os.environ.get("ALLOW_GUEST_SUBMIT", "1") != "1":
                raise HttpError(403, "本站已关闭游客提交，请先登录")
            rec, rev = store.add_record(payload.get("record") or payload, "admin" if username else "guest")
            return self._send(200, {
                "ok": True, "record": rec, "revision": rev,
                "message": "已保存并计入统计" if username else "已提交，等待管理员审核",
            })

        if path.startswith("/api/records/"):
            return self._handle_record_item(method, path)

        if path == "/api/problems" and method == "POST":
            payload = self._read_json()
            info, rev = store.put_problem(payload.get("pid"), payload.get("problem") or payload)
            return self._send(200, {"ok": True, "problem": info, "revision": rev})

        if path == "/api/export" and method == "GET":
            self._require_admin()
            data = store.snapshot(include_pending=True)
            data["app"] = "算法雷达站"
            data["version"] = store.DATA_VERSION
            data["exportedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            return self._send(200, data)

        if path == "/api/import" and method == "POST":
            self._require_admin()
            payload = self._read_json(limit=MAX_IMPORT_BODY)
            mode = "replace" if payload.get("mode") == "replace" else "merge"
            n, rev = store.import_bundle(payload.get("data") or {}, mode)
            return self._send(200, {"ok": True, "imported": n, "revision": rev})

        raise HttpError(404, "接口不存在")

    def _handle_record_item(self, method, path):
        rest = path[len("/api/records/"):]
        parts = [p for p in rest.split("/") if p]

        if parts == ["bulk"] and method == "POST":
            self._require_admin()
            payload = self._read_json()
            ids = payload.get("ids") or []
            if not isinstance(ids, list) or len(ids) > store.MAX_RECORDS:
                raise HttpError(400, "ids 不合法")
            action = payload.get("action")
            if action == "approve":
                n, rev = store.bulk_status(ids, "approved")
            elif action == "reject":
                n, rev = store.bulk_delete(ids)
            else:
                raise HttpError(400, "action 必须是 approve 或 reject")
            return self._send(200, {"ok": True, "affected": n, "revision": rev})

        if not parts:
            raise HttpError(404, "接口不存在")
        rid = urllib.parse.unquote(parts[0])
        if len(rid) > 64:
            raise HttpError(400, "记录 id 不合法")

        try:
            if len(parts) == 1 and method == "PUT":
                self._require_admin()
                payload = self._read_json()
                rec, rev = store.update_record(rid, payload.get("record") or payload)
                return self._send(200, {"ok": True, "record": rec, "revision": rev})

            if len(parts) == 1 and method == "DELETE":
                self._require_admin()
                rev = store.delete_record(rid)
                return self._send(200, {"ok": True, "revision": rev})

            if parts[1:] == ["status"] and method == "POST":
                self._require_admin()
                payload = self._read_json()
                rec, rev = store.set_status(rid, payload.get("status"))
                return self._send(200, {"ok": True, "record": rec, "revision": rev})
        except KeyError:
            raise HttpError(404, "记录不存在（可能已被其他设备删除）")

        raise HttpError(405, "方法不允许")

    def _handle_setup(self):
        """首次初始化管理员账号：仅允许在未配置且来自本机回环时进行"""
        if auth.is_configured():
            raise HttpError(409, "管理员账号已存在，如需修改请运行 python server.py --set-password")
        if not self._is_loopback():
            raise HttpError(403, "为安全起见，初始化只能在服务器本机完成（见 README）")
        payload = self._read_json()
        username = str(payload.get("username") or "").strip()
        password = str(payload.get("password") or "")
        if len(password) < auth.MIN_PASSWORD_LEN:
            raise HttpError(400, "口令至少需要 %d 个字符" % auth.MIN_PASSWORD_LEN)
        try:
            auth.save_credentials(username, password)
        except ValueError as e:
            raise HttpError(400, str(e))
        self._set_cookie(SESSION_COOKIE, auth.issue_session(username))
        print("[setup] 管理员账号已创建：%s" % username)
        return self._send(200, {"ok": True, "admin": True, "username": username})

    def _handle_login(self):
        key = self._client_key()
        wait = auth.LOGIN_LIMITER.retry_after(key)
        if wait:
            raise HttpError(429, "登录尝试过多，请 %d 秒后再试" % wait)
        # 登录同样需要 CSRF 令牌（页面加载时已下发）
        self._require_csrf()
        payload = self._read_json(limit=8192)
        username = str(payload.get("username") or "").strip()
        password = str(payload.get("password") or "")
        cfg = auth.load_config()
        if not auth.is_configured():
            raise HttpError(409, "尚未设置管理员账号，请在服务器本机完成初始化")
        ok = (username == cfg["username"]) and auth.verify_password(password, cfg["passwordHash"])
        if not ok:
            auth.LOGIN_LIMITER.hit(key)
            time.sleep(0.35)                    # 轻微延迟，抬高在线爆破成本
            raise HttpError(401, "用户名或口令错误")
        auth.LOGIN_LIMITER.reset(key)
        self._set_cookie(SESSION_COOKIE, auth.issue_session(username))
        return self._send(200, {"ok": True, "admin": True, "username": username})

    def _handle_luogu(self):
        self._rate_limit(auth.FETCH_LIMITER, "题目抓取")
        auth.FETCH_LIMITER.hit(self._client_key())
        pid = (self._query().get("pid") or [""])[0]
        if len(pid) > 24:
            raise HttpError(400, "题号过长")
        try:
            return self._send(200, get_problem_info(pid))
        except ValueError as e:
            raise HttpError(404, str(e))
        except Exception as e:
            raise HttpError(502, "抓取洛谷失败：%s；请手动填写题目信息" % e)


# ---------------------------------------------------------------- CLI

def cmd_set_password():
    print("=" * 52)
    print("  设置算法雷达站管理员账号")
    print("=" * 52)
    current = auth.load_config().get("username")
    if current:
        print("当前管理员：%s（继续将覆盖）" % current)
    username = input("用户名：").strip()
    pw1 = getpass.getpass("口令（至少 %d 位，输入时不回显）：" % auth.MIN_PASSWORD_LEN)
    pw2 = getpass.getpass("再输入一次：")
    if pw1 != pw2:
        print("两次输入不一致，已取消。")
        return 1
    try:
        envs = auth.save_credentials(username, pw1)
    except ValueError as e:
        print("失败：%s" % e)
        return 1
    print("\n已写入 %s（该文件已被 .gitignore 忽略，请勿提交）" % auth.CRED_FILE)
    print("\n部署到 Render / 其他平台时，把以下环境变量填进平台配置即可（不必上传该文件）：")
    for k, v in envs.items():
        print("  %s=%s" % (k, v))
    return 0


def main():
    if "--set-password" in sys.argv:
        sys.exit(cmd_set_password())

    os.chdir(BASE_DIR)
    luogu_fetch.load_tag_map()
    store.load()

    port = int(os.environ.get("PORT", str(PORT)))
    # 部署平台注入 PORT 时必须监听 0.0.0.0；本地默认仅回环，数据不出本机
    host = os.environ.get("HOST", "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
    httpd = ThreadingHTTPServer((host, port), Handler)
    url = "http://%s:%d/" % ("127.0.0.1" if host == "0.0.0.0" else host, port)

    print("=" * 52)
    print("  算法雷达站 已启动")
    print("  地址: %s" % url)
    print("  数据: %s（服务端权威存储）" % store.DATA_FILE)
    print("  备份: %s" % ("GitHub Gist 已启用" if store.gist_enabled() else "未配置 Gist（仅本地文件）"))
    if auth.is_configured():
        print("  管理员: %s（已配置）" % auth.load_config()["username"])
    else:
        print("  管理员: 未设置 —— 打开页面点「初始化管理员」，或运行 python server.py --set-password")
    if host == "0.0.0.0" and not auth.is_configured():
        print("  [警告] 正在对外监听但未设置管理员账号：审核与删除等接口将全部拒绝访问。")
    print("  按 Ctrl+C 停止")
    print("=" * 52)

    if os.environ.get("RENDER") != "true" and host != "0.0.0.0":
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        httpd.shutdown()


if __name__ == "__main__":
    main()
