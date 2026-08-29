# -*- coding: utf-8 -*-
"""
算法雷达站 - 本地辅助服务器（仅用 Python 标准库，零依赖）

职责：
  1. 提供前端静态页面（static/ 下固定白名单文件）
  2. 洛谷题目信息代理抓取（题目名/难度/算法标签），结果缓存在内存中
     - 洛谷新版数据内嵌于题目页 lentille-context JSON 中（2026-08-29 实测验证）
     - 标签 ID 到名称的映射使用项目根 tags.json（洛谷官方标签表，version zh-CN/2026082918）

说明：竞赛记录与题目缓存由前端保存在浏览器 localStorage 中（页面内可导出/导入
     JSON 备份），本服务器不写入任何数据文件——所有文件访问均为固定白名单，
     不接受来自请求的路径，从结构上杜绝路径穿越。

启动：python server.py （或双击 start.bat），浏览器访问 http://127.0.0.1:8471/
"""
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

PORT = int(os.environ.get("PORT", "8471"))

LUOGU_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# 洛谷难度档位（数字 -> 名称），顺序即展示顺序
DIFFICULTY_NAMES = {
    0: "暂无评定",
    1: "入门",
    2: "普及−",
    3: "普及/提高−",
    4: "普及+/提高",
    5: "提高+/省选−",
    6: "省选/NOI−",
    7: "NOI/NOI+/CTSC",
}

# 雷达图算法大类的归类规则（按顺序匹配，先命中先归类）。
# 对题目的每个标签，沿「标签自身 -> 父标签 -> ... 顶级标签」的名称链依次匹配。
CATEGORY_RULES = [
    ("动态规划", r"DP|动态规划|背包|状态压缩|树形dp|数位dp|区间dp|斜率优化|单调队列优化|轮廓线"),
    ("字符串", r"字符串|KMP|后缀|自动机|回文|Manacher|最小表示|模式匹配|哈希"),
    ("图论", r"图论|最短路|生成树|拓扑|网络流|二分图|强连通|割点|割边|桥|欧拉|哈密顿|差分约束|连通|最近公共祖先|LCA|树的直径|仙人掌"),
    ("搜索", r"搜索|剪枝|迭代加深|启发式|双向|折半|DFS|BFS|深度优先|广度优先"),
    ("数据结构", r"数据结构|栈|队列|堆|并查集|线段树|树状数组|平衡树|Splay|Treap|字典树|Trie|哈希表|链表|分块|单调|RMQ|ST表|莫队|可持久化"),
    ("二分/分治", r"二分|分治|倍增|三分|整体|CDQ"),
    ("贪心", r"贪心"),
    ("模拟/枚举", r"模拟|枚举|暴力|递归|递推|打表"),
    ("计算几何", r"几何|凸包|旋转卡壳|半平面"),
    ("数学", r"数学|数论|组合|概率|期望|线性代数|矩阵|高斯消元|微积分|群论|多项式|快速幂|素数|质数|筛法|进制|位运算|高精度|公约数|欧拉函数|中国剩余|卢卡斯|卡特兰|斯特林|容斥|斐波那契|密码|博弈"),
]

# ---------------------------------------------------------------- 静态文件白名单
# 只允许读取下面这些固定文件，键为 URL 路径，值为 (磁盘字面量路径, Content-Type)

STATIC_WHITELIST = {
    "/": ("static/index.html", "text/html; charset=utf-8"),
    "/index.html": ("static/index.html", "text/html; charset=utf-8"),
    "/style.css": ("static/style.css", "text/css; charset=utf-8"),
    "/app.js": ("static/app.js", "application/javascript; charset=utf-8"),
    "/vendor/chart.umd.js": ("static/vendor/chart.umd.js", "application/javascript; charset=utf-8"),
}


def read_static_file(url_path):
    """按白名单读取静态文件，返回 (bytes, ctype) 或 None"""
    entry = STATIC_WHITELIST.get(url_path)
    if entry is None:
        return None
    disk_path, ctype = entry
    if not os.path.isfile(disk_path):
        return None
    with open(disk_path, "rb") as f:
        return f.read(), ctype


# ---------------------------------------------------------------- 洛谷抓取

_HTTP = threading.local()
_TAG_MAP = {}
_TAG_MAP_LOCK = threading.Lock()
# 题目信息内存缓存：{pid: info}，仅供本次运行加速，不落盘
PROBLEM_CACHE = {}
CACHE_LOCK = threading.Lock()


def _opener():
    """每个线程一个带 CookieJar 的 opener（洛谷通过 302 下发 __client_id Cookie）"""
    jar = getattr(_HTTP, "jar", None)
    if jar is None:
        jar = CookieJar()
        _HTTP.jar = jar
        _HTTP.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    return _HTTP.opener


def _http_get(url, timeout=20):
    req = urllib.request.Request(url, headers={
        "User-Agent": LUOGU_UA,
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    resp = _opener().open(req, timeout=timeout)
    return resp.read().decode("utf-8", errors="replace")


_LENTILLE_RE = re.compile(
    r'<script id="lentille-context" type="application/json">(.*?)</script>', re.S
)
PID_RE = re.compile(r"^[A-Za-z]{1,3}_?[A-Za-z0-9_]{2,20}$")


def load_tag_map():
    """标签 ID -> 名称。优先读项目根 tags.json（种子文件）；没有则联网拉取（仅入内存）"""
    global _TAG_MAP
    with _TAG_MAP_LOCK:
        if _TAG_MAP:
            return _TAG_MAP
        data = None
        try:
            with open("tags.json", "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = None
        if not data or "tags" not in data:
            try:
                data = json.loads(_http_get("https://www.luogu.com.cn/_lfe/tags/zh-CN"))
            except Exception as e:  # 离线兜底：无映射则按未知标签处理
                print("[warn] 拉取洛谷标签表失败：%s" % e, file=sys.stderr)
                return {}
        _TAG_MAP = {t["id"]: t for t in data.get("tags", [])}
        return _TAG_MAP


def clean_name(s):
    if not isinstance(s, str):
        return ""
    return s.replace("\ufeff", "").strip()


def categorize(tag_names):
    """把标签名列表映射到算法大类集合"""
    cats = set()
    for name in tag_names:
        for cat, pattern in CATEGORY_RULES:
            if re.search(pattern, name, re.I):
                cats.add(cat)
                break
    return sorted(cats)


def fetch_luogu_problem(pid):
    """抓取洛谷题目信息。返回 dict 或抛出 ValueError（含可读错误信息）"""
    pid = pid.strip().upper()
    if not PID_RE.match(pid):
        raise ValueError("题号格式不正确：%s（示例：P1001 / B2001 / CF10A）" % pid)

    html = _http_get("https://www.luogu.com.cn/problem/%s" % urllib.parse.quote(pid))
    m = _LENTILLE_RE.search(html)
    if not m:
        raise ValueError("洛谷页面结构变化或被风控拦截，未找到内嵌数据；请手动填写题目信息")
    try:
        ctx = json.loads(m.group(1))
    except ValueError:
        raise ValueError("洛谷内嵌数据解析失败；请手动填写题目信息")

    status = ctx.get("status")
    problem = (ctx.get("data") or {}).get("problem") or {}
    if status != 200 or not problem.get("name"):
        raise ValueError("洛谷未返回该题目（status=%s），题号可能不存在；请核对或手动填写" % status)

    tag_map = load_tag_map()
    tag_names = []
    for tid in problem.get("tags") or []:
        info = tag_map.get(tid)
        if info:
            tag_names.append(clean_name(info.get("name", "")))
    tag_names = [t for t in tag_names if t]

    # 沿父链补充名称（便于归类：如「模拟」父级为「基础算法」）
    chain_names = []
    for tid in problem.get("tags") or []:
        seen = set()
        cur = tag_map.get(tid)
        while cur and cur["id"] not in seen:
            seen.add(cur["id"])
            nm = clean_name(cur.get("name", ""))
            if nm and nm not in chain_names:
                chain_names.append(nm)
            cur = tag_map.get(cur.get("parent"), {})
    categories = categorize(chain_names)

    diff = problem.get("difficulty")
    try:
        diff = int(diff) if diff is not None else None
    except (TypeError, ValueError):
        diff = None

    return {
        "pid": pid,
        "title": clean_name(problem.get("name")),
        "difficulty": diff if diff in DIFFICULTY_NAMES else None,
        "tags": tag_names,
        "categories": categories,
        "fetchedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def get_problem_info(pid):
    """优先内存缓存，未命中则抓取"""
    pid = pid.strip().upper()
    with CACHE_LOCK:
        cached = PROBLEM_CACHE.get(pid)
    if cached:
        return cached
    info = fetch_luogu_problem(pid)
    with CACHE_LOCK:
        PROBLEM_CACHE[pid] = info
    return info


# ---------------------------------------------------------------- HTTP 服务

class Handler(BaseHTTPRequestHandler):
    server_version = "AlgorithmRadar/1.0"

    # ---- 基础工具 ----
    def _send(self, code, content, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(content, (dict, list)):
            content = json.dumps(content, ensure_ascii=False).encode("utf-8")
        elif isinstance(content, str):
            content = content.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(content)

    def _query(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---- 路由 ----
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/ping":
                self._send(200, {
                    "ok": True,
                    "app": "算法雷达站",
                    "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "difficultyNames": DIFFICULTY_NAMES,
                })
            elif path == "/api/luogu":
                pid = (self._query().get("pid") or [""])[0]
                try:
                    info = get_problem_info(pid)
                    self._send(200, info)
                except ValueError as e:
                    self._send(404, {"error": str(e)})
                except Exception as e:
                    self._send(502, {"error": "抓取洛谷失败：%s；请手动填写题目信息" % e})
            else:
                served = read_static_file(path)
                if served is None:
                    self._send(404, {"error": "not found"})
                else:
                    content, ctype = served
                    self._send(200, content, ctype)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self._send(500, {"error": "服务器内部错误：%s" % e})


def main():
    os.chdir(BASE_DIR)  # 静态文件与 tags.json 均为固定相对路径，先把工作目录切到项目根
    load_tag_map()  # 启动时确保标签表可用（本地种子或联网拉取）
    # 监听地址/端口可用环境变量覆盖（部署到线上平台时使用），默认仅本机
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", str(PORT)))
    server = ThreadingHTTPServer((host, port), Handler)
    url = "http://%s:%d/" % (host if host != "0.0.0.0" else "127.0.0.1", port)
    print("=" * 46)
    print("  算法雷达站 已启动")
    print("  地址: %s" % url)
    print("  数据保存在浏览器 localStorage 中")
    print("  按 Ctrl+C 停止")
    print("=" * 46)
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        server.shutdown()


if __name__ == "__main__":
    main()
