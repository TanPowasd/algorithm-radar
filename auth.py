# -*- coding: utf-8 -*-
"""
auth.py - 管理员鉴权（口令哈希 / 会话签名 / CSRF / 登录限流）

全部只用 Python 标准库。设计要点：

  * 口令只以 PBKDF2-HMAC-SHA256（随机盐 + 24 万次迭代）保存，校验在服务端完成，
    前端代码里不含任何凭据（旧版把用户名与裸 SHA-256 哈希写在 app.js 里，等于公开）。
  * 会话 = HMAC-SHA256 签名令牌，写入 HttpOnly + SameSite=Strict Cookie，
    浏览器脚本读不到，也不能被第三方站点带上。
  * 变更类请求（POST/PUT/DELETE）额外校验 CSRF 令牌（双提交：Cookie + X-CSRF-Token 头）。
  * 登录失败按 IP 滑动窗口限流，阻止在线爆破。

凭据来源优先级：环境变量（部署平台）> credentials.json（本机，已加入 .gitignore）。
本机首次使用可执行 `python server.py --set-password` 设置，或在浏览器里用回环地址完成初始化。
"""
import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
import threading
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CRED_FILE = os.path.join(BASE_DIR, "credentials.json")

# 硬编码默认管理员（仅作代码内兜底，方便本机开箱即用）：
#   用户名 TanPowasd / 口令 powasd
# 口令不以明文存储，仅保存 PBKDF2 哈希（与 credentials.json 同格式）。
# 优先级：环境变量 ADMIN_USERNAME / ADMIN_PASSWORD_HASH > credentials.json > 本默认值。
# 如需修改，请设置环境变量或运行 `python server.py --set-password`。
DEFAULT_ADMIN_USERNAME = "TanPowasd"
DEFAULT_ADMIN_PASSWORD_HASH = "pbkdf2_sha256$240000$2ckAUyQXe7y1_wxwFUlk4Q$SNErQODQTjGG3gPoMXVp4OThjdZauu2W3uSdShD1pPw"

PBKDF2_ITERATIONS = 240000
SESSION_TTL = 12 * 3600          # 会话有效期（秒）
SESSION_RENEW_AFTER = 3600       # 距签发超过 1 小时则在响应中续签
MIN_PASSWORD_LEN = 8

_LOCK = threading.Lock()
_CONFIG = None            # 缓存的凭据配置
_MEMORY_SECRET = None     # 磁盘不可写时的临时会话密钥（重启即失效）


# ---------------------------------------------------------------- 口令哈希

def hash_password(password):
    """返回 `pbkdf2_sha256$迭代次数$盐$哈希`（均为 base64url，无填充）"""
    if not isinstance(password, str) or len(password) < MIN_PASSWORD_LEN:
        raise ValueError("口令至少需要 %d 个字符" % MIN_PASSWORD_LEN)
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return "pbkdf2_sha256$%d$%s$%s" % (PBKDF2_ITERATIONS, _b64e(salt), _b64e(digest))


def verify_password(password, stored):
    """常数时间比对口令与存储哈希。格式不合法或不匹配都返回 False"""
    if not password or not stored:
        return False
    try:
        algo, iters, salt_b64, hash_b64 = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        iters = int(iters)
        salt = _b64d(salt_b64)
        expected = _b64d(hash_b64)
    except (ValueError, binascii.Error):
        return False
    if iters < 1000 or not salt or not expected:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iters)
    return hmac.compare_digest(actual, expected)


# ---------------------------------------------------------------- 凭据配置

def load_config(refresh=False):
    """读取管理员凭据配置。返回 {"username", "passwordHash", "sessionSecret"}"""
    global _CONFIG
    with _LOCK:
        if _CONFIG is not None and not refresh:
            return _CONFIG
        file_cfg = {}
        try:
            with open(CRED_FILE, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                file_cfg = loaded
        except (OSError, ValueError):
            file_cfg = {}
        cfg = {
            "username": os.environ.get("ADMIN_USERNAME") or file_cfg.get("username") or DEFAULT_ADMIN_USERNAME,
            "passwordHash": os.environ.get("ADMIN_PASSWORD_HASH") or file_cfg.get("passwordHash") or DEFAULT_ADMIN_PASSWORD_HASH,
            "sessionSecret": os.environ.get("SESSION_SECRET") or file_cfg.get("sessionSecret") or "",
        }
        _CONFIG = cfg
        return cfg


def is_configured():
    cfg = load_config()
    return bool(cfg["username"] and cfg["passwordHash"])


def save_credentials(username, password):
    """写入 credentials.json（含随机会话密钥）。返回可用于部署平台的环境变量字典"""
    username = (username or "").strip()
    if not username:
        raise ValueError("用户名不能为空")
    if len(username) > 64:
        raise ValueError("用户名过长")
    payload = {
        "username": username,
        "passwordHash": hash_password(password),
        "sessionSecret": load_config().get("sessionSecret") or secrets.token_hex(32),
        "note": "本文件含管理员凭据，请勿提交到仓库（.gitignore 已忽略）。口令仅以 PBKDF2 哈希保存。",
    }
    tmp = CRED_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CRED_FILE)
    load_config(refresh=True)
    return {
        "ADMIN_USERNAME": payload["username"],
        "ADMIN_PASSWORD_HASH": payload["passwordHash"],
        "SESSION_SECRET": payload["sessionSecret"],
    }


def _session_secret():
    """会话签名密钥：配置里没有就临时生成（重启后旧会话失效，但不影响安全性）"""
    global _MEMORY_SECRET
    cfg = load_config()
    if cfg.get("sessionSecret"):
        return cfg["sessionSecret"].encode("utf-8")
    with _LOCK:
        if _MEMORY_SECRET is None:
            _MEMORY_SECRET = secrets.token_bytes(32)
        return _MEMORY_SECRET


# ---------------------------------------------------------------- 会话令牌

def issue_session(username):
    """签发会话令牌：base64url(payload).base64url(HMAC)"""
    payload = {"u": username, "iat": int(time.time()), "exp": int(time.time()) + SESSION_TTL}
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    body = _b64e(raw)
    sig = _b64e(hmac.new(_session_secret(), body.encode("ascii"), hashlib.sha256).digest())
    return "%s.%s" % (body, sig)


def verify_session(token):
    """校验会话令牌，返回 (用户名, 是否建议续签)；无效返回 (None, False)"""
    if not token or token.count(".") != 1:
        return None, False
    body, sig = token.split(".")
    try:
        expected = hmac.new(_session_secret(), body.encode("ascii"), hashlib.sha256).digest()
    except Exception:
        return None, False
    try:
        if not hmac.compare_digest(_b64d(sig), expected):
            return None, False
        payload = json.loads(_b64d(body).decode("utf-8"))
    except (ValueError, binascii.Error, UnicodeDecodeError):
        return None, False
    if not isinstance(payload, dict):
        return None, False
    now = int(time.time())
    if int(payload.get("exp") or 0) <= now:
        return None, False
    # 口令/用户名变更后旧会话立即失效
    if payload.get("u") != load_config().get("username"):
        return None, False
    return payload["u"], (now - int(payload.get("iat") or 0)) > SESSION_RENEW_AFTER


def new_csrf_token():
    return secrets.token_urlsafe(24)


def csrf_ok(cookie_token, header_token):
    """双提交校验：Cookie 中的 CSRF 令牌必须与请求头一致"""
    if not cookie_token or not header_token:
        return False
    return hmac.compare_digest(str(cookie_token), str(header_token))


# ---------------------------------------------------------------- 限流

class RateLimiter:
    """按键（通常是 IP）计数的滑动窗口限流器"""

    def __init__(self, limit, window, block=0):
        self.limit = limit
        self.window = window
        self.block = block          # 超限后的额外冷却时间
        self._hits = {}
        self._blocked = {}
        self._lock = threading.Lock()

    def retry_after(self, key):
        """返回还需等待的秒数；0 表示可以继续"""
        now = time.time()
        with self._lock:
            until = self._blocked.get(key, 0)
            if until > now:
                return int(until - now) + 1
            hits = [t for t in self._hits.get(key, []) if now - t < self.window]
            self._hits[key] = hits
            if len(hits) >= self.limit:
                return int(self.window - (now - hits[0])) + 1
            return 0

    def hit(self, key):
        """记录一次（失败）尝试，超限则进入冷却"""
        now = time.time()
        with self._lock:
            hits = [t for t in self._hits.get(key, []) if now - t < self.window]
            hits.append(now)
            self._hits[key] = hits
            if self.block and len(hits) >= self.limit:
                self._blocked[key] = now + self.block
            if len(self._hits) > 4096:      # 兜底清理，避免内存无限增长
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] > self.window * 4]:
                    self._hits.pop(k, None)
                    self._blocked.pop(k, None)

    def reset(self, key):
        with self._lock:
            self._hits.pop(key, None)
            self._blocked.pop(key, None)


# 登录：10 分钟内 6 次失败 → 冷却 10 分钟
LOGIN_LIMITER = RateLimiter(limit=6, window=600, block=600)
# 洛谷代抓：每分钟 30 次（保护本机与洛谷两端）
FETCH_LIMITER = RateLimiter(limit=30, window=60)
# 写操作：每分钟 60 次
WRITE_LIMITER = RateLimiter(limit=60, window=60)


# ---------------------------------------------------------------- 小工具

def _b64e(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(text):
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)
