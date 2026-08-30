# -*- coding: utf-8 -*-
"""
api/sync.py - Vercel Python Serverless 函数：多设备数据同步代理

前端把 records/problems 通过本函数读写到外部 JSON 存储（JSONBin），
实现多台电脑访问同一网址时共享同一份数据。

环境变量（Vercel 控制台 → Settings → Environment Variables 配置）：
  JSONBIN_API_KEY - JSONBin 的 Master Key
  JSONBIN_BIN_ID  - JSONBin 的 Bin ID（bin 内容初始化为 {"records":[],"problems":{}}）

前端行为：
  GET  /api/sync  -> 拉取共享数据（未配置时返回 503，前端静默降级为纯本地）
  POST /api/sync  -> 推送共享数据
"""
import json
import os
import urllib.request

API_KEY = os.environ.get("JSONBIN_API_KEY", "")
BIN_ID = os.environ.get("JSONBIN_BIN_ID", "")

BASE = "https://api.jsonbin.io/v3/b/%s" % BIN_ID


def _headers():
    return {
        "X-Master-Key": API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def handler(environ, start_response):
    cors = [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type"),
    ]
    method = environ.get("REQUEST_METHOD", "GET")

    if method == "OPTIONS":
        start_response("204 No Content", cors)
        return [b""]

    if not API_KEY or not BIN_ID:
        body = json.dumps({"error": "sync not configured"}, ensure_ascii=False).encode("utf-8")
        start_response("503 Service Unavailable", [("Content-Type", "application/json; charset=utf-8")] + cors)
        return [body]

    try:
        if method == "GET":
            req = urllib.request.Request(BASE + "/latest", headers=_headers())
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            body = json.dumps(data.get("record", {}), ensure_ascii=False).encode("utf-8")
            start_response("200 OK", [("Content-Type", "application/json; charset=utf-8")] + cors)
            return [body]

        elif method == "POST":
            length = int(environ.get("CONTENT_LENGTH") or 0)
            payload = environ["wsgi.input"].read(length) if length else b"{}"
            req = urllib.request.Request(BASE, data=payload, method="PUT", headers=_headers())
            with urllib.request.urlopen(req, timeout=20) as resp:
                resp.read()
            start_response("200 OK", [("Content-Type", "application/json; charset=utf-8")] + cors)
            return [b'{"ok":true}']

        else:
            start_response("405 Method Not Allowed", [("Content-Type", "application/json; charset=utf-8")] + cors)
            return [b'{"error":"method not allowed"}']

    except Exception as e:
        body = json.dumps({"error": "sync failed: %s" % e}, ensure_ascii=False).encode("utf-8")
        start_response("502 Bad Gateway", [("Content-Type", "application/json; charset=utf-8")] + cors)
        return [body]
