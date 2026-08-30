# -*- coding: utf-8 -*-
"""
算法雷达站 - 本地辅助服务器（仅用 Python 标准库，零依赖）

职责：
  1. 提供前端静态页面（public/ 下固定白名单文件）
  2. 洛谷题目信息代理抓取（题目名/难度/算法标签），结果缓存在内存中
     - 抓取逻辑见 luogu_fetch.py（本地 server 与 Vercel 函数共用）
     - 标签 ID 到名称的映射使用项目根 tags.json（洛谷官方标签表，version zh-CN/2026082918）

说明：竞赛记录与题目缓存由前端保存在浏览器 localStorage 中（页面内可导出/导入
     JSON 备份），本服务器不写入任何数据文件——所有文件访问均为固定白名单，
     不接受来自请求的路径，从结构上杜绝路径穿越。

启动：python server.py （或双击 start.bat），浏览器访问 http://127.0.0.1:8471/
"""
import json
import os
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import luogu_fetch
from luogu_fetch import DIFFICULTY_NAMES, fetch_luogu_problem

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

PORT = int(os.environ.get("PORT", "8471"))

# 题目信息内存缓存：{pid: info}，仅供本次运行加速，不落盘
PROBLEM_CACHE = {}
CACHE_LOCK = threading.Lock()

# ---------------------------------------------------------------- 静态文件白名单
# 只允许读取下面这些固定文件，键为 URL 路径，值为 (磁盘字面量路径, Content-Type)

STATIC_WHITELIST = {
    "/": ("public/index.html", "text/html; charset=utf-8"),
    "/index.html": ("public/index.html", "text/html; charset=utf-8"),
    "/admin.html": ("public/admin.html", "text/html; charset=utf-8"),
    "/admin.js": ("public/admin.js", "application/javascript; charset=utf-8"),
    "/style.css": ("public/style.css", "text/css; charset=utf-8"),
    "/app.js": ("public/app.js", "application/javascript; charset=utf-8"),
    "/vendor/chart.umd.js": ("public/vendor/chart.umd.js", "application/javascript; charset=utf-8"),
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


# ---------------------------------------------------------------- 洛谷抓取（逻辑在 luogu_fetch.py）

def get_problem_info(pid):
    """优先内存缓存，未命中则抓取（抓取逻辑见 luogu_fetch.fetch_luogu_problem）"""
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
    luogu_fetch.load_tag_map()  # 启动时确保标签表可用（本地种子或联网拉取）
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
    # 仅在本地交互环境自动打开浏览器；无头服务器（Render 等）静默跳过
    if os.environ.get("RENDER") != "true" and os.environ.get("DISPLAY", "") != "":
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        server.shutdown()


if __name__ == "__main__":
    main()
