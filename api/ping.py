# -*- coding: utf-8 -*-
"""
api/ping.py - Vercel Python Serverless 函数：健康检查

前端 checkServer() 调用 /api/ping 判断「洛谷自动抓取是否可用」。
"""
import json
import time


def handler(environ, start_response):
    body = json.dumps({
        "ok": True,
        "app": "算法雷达站",
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
    }, ensure_ascii=False).encode("utf-8")
    start_response("200 OK", [("Content-Type", "application/json; charset=utf-8")])
    return [body]
