# -*- coding: utf-8 -*-
"""
api/luogu.py - Vercel Python Serverless 函数

Vercel 的 Python 运行时要求提供一个 `handler`（接收 environ/start_response，
返回可迭代 body）。这里复用 luogu_fetch.py 的抓取逻辑，对 /api/luogu?pid=XXX
返回题目 JSON（与本地 server.py 的 /api/luogu 相同）。
"""
import json
import sys
import os

# 确保能 import 到项目根的 luogu_fetch.py
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import luogu_fetch  # noqa: E402


def handler(environ, start_response):
    from urllib.parse import parse_qs

    # 注意：Vercel 会把 /api/luogu 路由到此函数，PATH_INFO 可能为 "/" 或空，
    # 因此不做路径校验，直接处理查询参数。
    cors_headers = [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type"),
    ]

    if environ.get("REQUEST_METHOD") == "OPTIONS":
        start_response("204 No Content", cors_headers)
        return [b""]

    # QUERY_STRING 形如 "pid=P1001"，直接 parse_qs（不要再用 urlparse 包一层）
    qs = parse_qs(environ.get("QUERY_STRING", ""))
    pid = (qs.get("pid") or [""])[0]

    try:
        info = luogu_fetch.fetch_luogu_problem(pid)
        body = json.dumps(info, ensure_ascii=False).encode("utf-8")
        start_response("200 OK", [("Content-Type", "application/json; charset=utf-8")] + cors_headers)
        return [body]
    except ValueError as e:
        body = json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8")
        start_response("404 Not Found", [("Content-Type", "application/json; charset=utf-8")] + cors_headers)
        return [body]
    except Exception as e:
        body = json.dumps({"error": "抓取洛谷失败：%s；请手动填写题目信息" % e}, ensure_ascii=False).encode("utf-8")
        start_response("502 Bad Gateway", [("Content-Type", "application/json; charset=utf-8")] + cors_headers)
        return [body]
