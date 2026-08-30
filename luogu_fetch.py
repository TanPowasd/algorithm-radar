# -*- coding: utf-8 -*-
"""
luogu_fetch.py - 洛谷题目信息抓取核心逻辑

由 server.py 的 /api/luogu 接口调用（浏览器直连洛谷会被跨域与风控拦住，
所以必须由服务端代抓）。仅用 Python 标准库，零依赖。
"""
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

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
    ("树", r"树链剖分|点分治|树上|树的重心|虚树|树分块|Kruskal 重构树|dsu on tree"),
    ("二分/分治", r"二分|分治|倍增|三分|整体|CDQ"),
    ("贪心", r"贪心"),
    ("模拟/枚举", r"模拟|枚举|暴力|递归|递推|打表"),
    ("计算几何", r"几何|凸包|旋转卡壳|半平面"),
    ("数学", r"数学|数论|组合|概率|期望|线性代数|矩阵|高斯消元|微积分|群论|多项式|快速幂|素数|质数|筛法|进制|位运算|高精度|公约数|欧拉函数|中国剩余|卢卡斯|卡特兰|斯特林|容斥|斐波那契|密码|博弈"),
]

_HTTP = threading.local()
_TAG_MAP = {}
_TAG_MAP_LOCK = threading.Lock()

_LENTILLE_RE = re.compile(
    r'<script id="lentille-context" type="application/json">(.*?)</script>', re.S
)
PID_RE = re.compile(r"^[A-Za-z]{1,3}_?[A-Za-z0-9_]{2,20}$")


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


def load_tag_map():
    """标签 ID -> 名称。优先读项目根 tags.json（种子文件）；没有则联网拉取（仅入内存）"""
    global _TAG_MAP
    with _TAG_MAP_LOCK:
        if _TAG_MAP:
            return _TAG_MAP
        data = None
        # Vercel 函数工作目录可能不同：优先用本文件所在目录的 tags.json
        here = os.path.dirname(os.path.abspath(__file__))
        for cand in (os.path.join(here, "tags.json"), "tags.json"):
            try:
                with open(cand, "r", encoding="utf-8") as f:
                    data = json.load(f)
                break
            except (OSError, ValueError):
                data = None
        if not data or "tags" not in data:
            try:
                data = json.loads(_http_get("https://www.luogu.com.cn/_lfe/tags/zh-CN"))
            except Exception as e:  # 离线兜底：无映射则按未知标签处理
                print("[warn] 拉取洛谷标签表失败：%s" % e, file=__import__("sys").stderr)
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
