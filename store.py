# -*- coding: utf-8 -*-
"""
store.py - 数据存储与校验（服务端权威数据）

旧版把 records 全量存在浏览器 localStorage，再整体 POST 覆盖服务端文件，导致
两个问题：跨设备的「更新」丢失（合并判据只看数组长度），以及任何人都能覆盖全量数据。
现在服务端持有权威数据，前端只做增量操作（新增 / 更新 / 删除 / 审核），
localStorage 退化为离线只读缓存。

要点：
  * 每条记录写入前经 sanitize_record 白名单清洗，长度与取值范围都被限制，
    避免前端传入任意字段或超大字符串把数据文件撑爆。
  * 写盘为「临时文件 + os.replace」原子替换，进程被中断也不会留下半截 JSON。
  * revision 单调递增，前端据此判断是否需要重新拉取（乐观并发）。
  * Gist 备份保持可选（配置了 GIST_TOKEN / GIST_ID 才启用），失败不影响主存储。
"""
import json
import os
import re
import sys
import threading
import time
import urllib.request
import uuid

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.environ.get("DATA_FILE") or os.path.join(BASE_DIR, "data.json")

GIST_TOKEN = os.environ.get("GIST_TOKEN", "")
GIST_ID = os.environ.get("GIST_ID", "")
GIST_FILENAME = "algorithm-radar-data.json"

DATA_VERSION = 3

RESULTS = ("AC", "WA", "TLE", "MLE", "RE", "CE", "未解出")
THINKING_LEVELS = ("max", "high", "medium", "low", "off")
DEFAULT_THINKING = "max"
STATUSES = ("approved", "pending")

PID_RE = re.compile(r"^[A-Z]{1,3}_?[A-Z0-9_]{2,20}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# 各字段长度上限（字符数）
MAX_MODEL = 80
MAX_VARIANT = 80
MAX_TITLE = 200
MAX_NOTE = 1000
MAX_SUB_NOTE = 300
MAX_CATEGORY = 40
MAX_CATEGORIES = 12
MAX_SUBMISSIONS = 40
MAX_RECORDS = 20000
MAX_PROBLEMS = 20000
MAX_TAGS = 30

_LOCK = threading.RLock()
_CACHE = None       # 内存中的权威数据（进程内唯一副本）


class ValidationError(ValueError):
    """请求数据不合法（对应 HTTP 400）"""


# ---------------------------------------------------------------- 清洗与校验

def _text(value, limit, field):
    if value is None:
        return ""
    if not isinstance(value, (str, int, float)):
        raise ValidationError("%s 类型不正确" % field)
    s = str(value).replace("\x00", "").strip()
    if len(s) > limit:
        raise ValidationError("%s 过长（上限 %d 字）" % (field, limit))
    return s


def _int_or_none(value, lo, hi, field):
    if value is None or value == "":
        return None
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        raise ValidationError("%s 必须是数字" % field)
    if n < lo or n > hi:
        raise ValidationError("%s 超出范围（%d–%d）" % (field, lo, hi))
    return n


def sanitize_submission(raw):
    if not isinstance(raw, dict):
        raise ValidationError("提交轮次格式不正确")
    result = raw.get("result")
    if result not in RESULTS:
        raise ValidationError("提交结果必须是 %s 之一" % "/".join(RESULTS))
    return {
        "score": _int_or_none(raw.get("score"), 0, 100, "得分"),
        "result": result,
        "note": _text(raw.get("note"), MAX_SUB_NOTE, "提交说明"),
    }


def sanitize_record(raw, existing=None, author="guest", status=None):
    """把前端传入的记录清洗为白名单结构。existing 非空时表示更新（保留 id/创建时间）"""
    if not isinstance(raw, dict):
        raise ValidationError("记录格式不正确")

    model = _text(raw.get("model"), MAX_MODEL, "AI 名称")
    if not model:
        raise ValidationError("请填写 AI 名称")

    pid = _text(raw.get("pid"), 24, "题号").upper()
    if not PID_RE.match(pid):
        raise ValidationError("题号格式不正确（示例：P1001 / B2001 / CF10A）")

    difficulty = _int_or_none(raw.get("difficulty"), 0, 7, "难度")
    if difficulty is None:
        raise ValidationError("请选择难度")

    subs_raw = raw.get("submissions")
    if not isinstance(subs_raw, list) or not subs_raw:
        raise ValidationError("至少需要一次提交记录")
    if len(subs_raw) > MAX_SUBMISSIONS:
        raise ValidationError("提交轮次过多（上限 %d 次）" % MAX_SUBMISSIONS)
    submissions = [sanitize_submission(s) for s in subs_raw]

    cats_raw = raw.get("categories") or []
    if not isinstance(cats_raw, list):
        raise ValidationError("算法类别格式不正确")
    categories, seen = [], set()
    for c in cats_raw[:MAX_CATEGORIES]:
        name = _text(c, MAX_CATEGORY, "算法类别")
        if name and name not in seen:
            seen.add(name)
            categories.append(name)

    date = _text(raw.get("date"), 10, "日期") or time.strftime("%Y-%m-%d")
    if not DATE_RE.match(date):
        raise ValidationError("日期格式必须是 YYYY-MM-DD")

    thinking = raw.get("thinking")
    if thinking not in THINKING_LEVELS:
        thinking = DEFAULT_THINKING

    now = _now_iso()
    rec = {
        "id": (existing or {}).get("id") or _new_id(),
        "model": model,
        "variant": _text(raw.get("variant"), MAX_VARIANT, "版本/策略"),
        "pid": pid,
        "title": _text(raw.get("title"), MAX_TITLE, "题目名称"),
        "thinking": thinking,
        "difficulty": difficulty,
        "categories": categories,
        "submissions": submissions,
        "minutes": _int_or_none(raw.get("minutes"), 0, 100000, "用时"),
        "date": date,
        "note": _text(raw.get("note"), MAX_NOTE, "备注"),
        "status": status if status in STATUSES else (existing or {}).get("status") or "pending",
        "author": (existing or {}).get("author") or ("admin" if author == "admin" else "guest"),
        "createdAt": (existing or {}).get("createdAt") or now,
        "updatedAt": now,
    }
    return rec


def sanitize_problem(pid, raw):
    """题目缓存条目清洗（题名/难度/标签/类别）"""
    pid = _text(pid, 24, "题号").upper()
    if not PID_RE.match(pid) or not isinstance(raw, dict):
        return None, None
    tags, seen = [], set()
    for t in (raw.get("tags") or [])[:MAX_TAGS]:
        name = _text(t, MAX_CATEGORY, "标签")
        if name and name not in seen:
            seen.add(name)
            tags.append(name)
    cats, seen = [], set()
    for c in (raw.get("categories") or [])[:MAX_CATEGORIES]:
        name = _text(c, MAX_CATEGORY, "算法类别")
        if name and name not in seen:
            seen.add(name)
            cats.append(name)
    return pid, {
        "pid": pid,
        "title": _text(raw.get("title"), MAX_TITLE, "题目名称"),
        "difficulty": _int_or_none(raw.get("difficulty"), 0, 7, "难度"),
        "tags": tags,
        "categories": cats,
        "manual": bool(raw.get("manual")),
        "fetchedAt": _text(raw.get("fetchedAt"), 40, "抓取时间"),
    }


def migrate_record(raw):
    """兼容旧数据（数字 id / 无 submissions / 无 status），失败返回 None 而不是整体报错"""
    if not isinstance(raw, dict):
        return None
    data = dict(raw)
    if not isinstance(data.get("submissions"), list) or not data["submissions"]:
        legacy = data.get("result")
        data["submissions"] = [{
            "score": 100 if legacy == "AC" else None,
            "result": legacy if legacy in RESULTS else "未解出",
            "note": "",
        }]
    if data.get("difficulty") is None:
        data["difficulty"] = 0
    status = data.get("status") if data.get("status") in STATUSES else "approved"
    author = data.get("author") if data.get("author") in ("admin", "guest") else "admin"
    try:
        rec = sanitize_record(data, existing={
            "id": str(data.get("id")) if data.get("id") not in (None, "") else None,
            "status": status,
            "author": author,
            "createdAt": _text(data.get("createdAt"), 40, "创建时间") or None,
        }, status=status)
    except ValidationError:
        return None
    rec["updatedAt"] = _text(data.get("updatedAt"), 40, "更新时间") or rec["updatedAt"]
    return rec


# ---------------------------------------------------------------- 读写

def _empty():
    return {"version": DATA_VERSION, "revision": 0, "records": [], "problems": {}, "updatedAt": _now_iso()}


def _normalize_bundle(raw):
    """把任意来源（磁盘 / Gist / 导入文件）的数据规整为标准结构，跳过坏行"""
    if not isinstance(raw, dict):
        return _empty()
    out = _empty()
    seen_ids = set()
    for item in (raw.get("records") or [])[:MAX_RECORDS]:
        rec = migrate_record(item)
        if rec is None or rec["id"] in seen_ids:
            continue
        seen_ids.add(rec["id"])
        out["records"].append(rec)
    problems = raw.get("problems")
    if isinstance(problems, dict):
        for pid, info in list(problems.items())[:MAX_PROBLEMS]:
            key, clean = sanitize_problem(pid, info)
            if key:
                out["problems"][key] = clean
    try:
        out["revision"] = max(0, int(raw.get("revision") or 0))
    except (TypeError, ValueError):
        out["revision"] = 0
    return out


def load(refresh=False):
    """载入权威数据：内存缓存 → 磁盘 → Gist 恢复"""
    global _CACHE
    with _LOCK:
        if _CACHE is not None and not refresh:
            return _CACHE
        raw = None
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            raw = None
        if raw is None:
            raw = _gist_read()
            if raw is not None:
                _CACHE = _normalize_bundle(raw)
                _persist(backup=False)
                return _CACHE
        _CACHE = _normalize_bundle(raw)
        return _CACHE


def _persist(backup=True):
    """原子写盘（+ 可选 Gist 备份）。调用方需持有 _LOCK"""
    data = _CACHE
    tmp = DATA_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, DATA_FILE)
    except OSError as e:
        print("[warn] 数据写盘失败：%s" % e, file=sys.stderr)
        try:
            os.remove(tmp)
        except OSError:
            pass
    if backup:
        threading.Thread(target=_gist_write, args=(json.dumps(data, ensure_ascii=False),), daemon=True).start()


def _commit():
    """递增 revision 并落盘。调用方需持有 _LOCK"""
    _CACHE["revision"] = int(_CACHE.get("revision") or 0) + 1
    _CACHE["updatedAt"] = _now_iso()
    _persist()
    return _CACHE["revision"]


def snapshot(include_pending):
    """给前端的数据快照：游客只看已通过的记录（待审核内容不外泄）"""
    data = load()
    with _LOCK:
        records = [dict(r) for r in data["records"] if include_pending or r["status"] == "approved"]
        return {
            "revision": data["revision"],
            "updatedAt": data["updatedAt"],
            "records": records,
            "problems": {k: dict(v) for k, v in data["problems"].items()},
        }


# ---------------------------------------------------------------- 记录操作

def add_record(raw, author):
    """新增记录：管理员直接通过，游客进入待审核"""
    data = load()
    with _LOCK:
        if len(data["records"]) >= MAX_RECORDS:
            raise ValidationError("记录数量已达上限（%d）" % MAX_RECORDS)
        rec = sanitize_record(raw, author=author, status="approved" if author == "admin" else "pending")
        data["records"].append(rec)
        _merge_problem_from_record(rec, raw)
        rev = _commit()
    return rec, rev


def update_record(rid, raw):
    """更新记录（仅管理员调用）。状态保持不变"""
    data = load()
    with _LOCK:
        idx = _index_of(rid)
        if idx is None:
            raise KeyError(rid)
        existing = data["records"][idx]
        rec = sanitize_record(raw, existing=existing, author="admin", status=existing["status"])
        data["records"][idx] = rec
        _merge_problem_from_record(rec, raw)
        rev = _commit()
    return rec, rev


def delete_record(rid):
    data = load()
    with _LOCK:
        idx = _index_of(rid)
        if idx is None:
            raise KeyError(rid)
        data["records"].pop(idx)
        rev = _commit()
    return rev


def set_status(rid, status):
    if status not in STATUSES:
        raise ValidationError("状态不合法")
    data = load()
    with _LOCK:
        idx = _index_of(rid)
        if idx is None:
            raise KeyError(rid)
        data["records"][idx]["status"] = status
        data["records"][idx]["updatedAt"] = _now_iso()
        rev = _commit()
    return data["records"][idx], rev


def bulk_status(ids, status):
    """批量审核；返回实际影响的条数"""
    if status not in STATUSES:
        raise ValidationError("状态不合法")
    data = load()
    with _LOCK:
        wanted = set(str(i) for i in (ids or []))
        n = 0
        for rec in data["records"]:
            if rec["id"] in wanted and rec["status"] != status:
                rec["status"] = status
                rec["updatedAt"] = _now_iso()
                n += 1
        rev = _commit() if n else data["revision"]
    return n, rev


def bulk_delete(ids):
    data = load()
    with _LOCK:
        wanted = set(str(i) for i in (ids or []))
        before = len(data["records"])
        data["records"] = [r for r in data["records"] if r["id"] not in wanted]
        n = before - len(data["records"])
        rev = _commit() if n else data["revision"]
    return n, rev


def put_problem(pid, info):
    """写入/更新题目缓存条目"""
    key, clean = sanitize_problem(pid, info)
    if not key:
        raise ValidationError("题号格式不正确")
    data = load()
    with _LOCK:
        if key not in data["problems"] and len(data["problems"]) >= MAX_PROBLEMS:
            raise ValidationError("题目缓存已达上限")
        prev = data["problems"].get(key) or {}
        merged = dict(prev)
        merged.update({k: v for k, v in clean.items() if v not in (None, "", [])})
        merged["pid"] = key
        merged["manual"] = clean["manual"] or prev.get("manual", False)
        if clean["difficulty"] is not None:
            merged["difficulty"] = clean["difficulty"]
        data["problems"][key] = merged
        rev = _commit()
    return merged, rev


def import_bundle(raw, mode):
    """导入数据（仅管理员）。mode: replace 覆盖全部 / merge 按 id 合并（取 updatedAt 较新的）"""
    incoming = _normalize_bundle(raw if isinstance(raw, dict) else {"records": raw})
    data = load()
    with _LOCK:
        if mode == "replace":
            data["records"] = incoming["records"]
            data["problems"] = incoming["problems"]
        else:
            by_id = {r["id"]: r for r in data["records"]}
            for rec in incoming["records"]:
                old = by_id.get(rec["id"])
                if old is None or (rec.get("updatedAt") or "") > (old.get("updatedAt") or ""):
                    by_id[rec["id"]] = rec
            data["records"] = list(by_id.values())
            for pid, info in incoming["problems"].items():
                data["problems"].setdefault(pid, info)
        if len(data["records"]) > MAX_RECORDS:
            raise ValidationError("导入后记录数超出上限（%d）" % MAX_RECORDS)
        rev = _commit()
    return len(incoming["records"]), rev


# ---------------------------------------------------------------- 内部工具

def _index_of(rid):
    rid = str(rid)
    for i, r in enumerate(_CACHE["records"]):
        if r["id"] == rid:
            return i
    return None


def _merge_problem_from_record(rec, raw):
    """保存记录时顺手把题目信息并入缓存（调用方需持有 _LOCK）"""
    pid = rec["pid"]
    prev = _CACHE["problems"].get(pid) or {}
    src = raw.get("problem") if isinstance(raw.get("problem"), dict) else {}
    _, clean = sanitize_problem(pid, {
        "title": rec["title"] or prev.get("title"),
        "difficulty": rec["difficulty"],
        "tags": src.get("tags") or prev.get("tags") or [],
        "categories": rec["categories"] or prev.get("categories") or [],
        "manual": True,
        "fetchedAt": prev.get("fetchedAt") or src.get("fetchedAt") or "",
    })
    if clean:
        _CACHE["problems"][pid] = clean


def _new_id():
    return uuid.uuid4().hex[:16]


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------- Gist 备份

def gist_enabled():
    return bool(GIST_TOKEN and GIST_ID)


def _gist_headers():
    return {
        "Authorization": "token %s" % GIST_TOKEN,
        "Accept": "application/vnd.github+json",
        "User-Agent": "AlgorithmRadar/2.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _gist_read():
    if not gist_enabled():
        return None
    try:
        req = urllib.request.Request("https://api.github.com/gists/%s" % GIST_ID, headers=_gist_headers())
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        files = payload.get("files") or {}
        chosen = files.get(GIST_FILENAME) or next(iter(files.values()), None)
        if chosen and chosen.get("content"):
            return json.loads(chosen["content"])
    except Exception as e:
        print("[warn] Gist 读取失败：%s" % e, file=sys.stderr)
    return None


def _gist_write(content):
    if not gist_enabled():
        return
    try:
        body = json.dumps({"files": {GIST_FILENAME: {"content": content}}}).encode("utf-8")
        req = urllib.request.Request(
            "https://api.github.com/gists/%s" % GIST_ID,
            data=body, method="PATCH", headers=_gist_headers())
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
    except Exception as e:
        print("[warn] Gist 备份失败：%s" % e, file=sys.stderr)
