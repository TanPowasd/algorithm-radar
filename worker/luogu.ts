/**
 * 洛谷题目抓取（luogu_fetch.py → TS 移植，跑在 Cloudflare Workers 上）。
 * SSRF 防护：目标 host 是编译期常量（www.luogu.com.cn）、仅 https、
 * 题号先经正则白名单再 encodeURIComponent；302 的 location 跳转也走同一校验。
 * 洛谷通过 302 下发 __client_id Cookie，Workers fetch 不会自动携带中间跳转的
 * Cookie，所以先 redirect:"manual" 接住 Cookie，再带 Cookie 重新请求。
 * 注意：内嵌数据提取用 String.match（这里不用 RegExp.exec，避免与 shell 语义混淆）。
 */
import { badRequest, nowLocal } from "./util";
import tagsData from "../tags.json";

const HOST = "www.luogu.com.cn";
const ORIGIN = "https://www.luogu.com.cn";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PID_RE = /^[A-Za-z]{1,3}_?[A-Za-z0-9_]{2,20}$/;
const LENTILLE_RE = /<script id="lentille-context" type="application\/json">([\s\S]*?)<\/script>/;

/** 雷达图算法大类归类规则（按顺序匹配，先命中先归类） */
const CATEGORY_RULES: Array<[string, RegExp]> = [
    ["动态规划", /DP|动态规划|背包|状态压缩|树形dp|数位dp|区间dp|斜率优化|单调队列优化|轮廓线/i],
    ["字符串", /字符串|KMP|后缀|自动机|回文|Manacher|最小表示|模式匹配|哈希/i],
    ["图论", /图论|最短路|生成树|拓扑|网络流|二分图|强连通|割点|割边|桥|欧拉|哈密顿|差分约束|连通|最近公共祖先|LCA|树的直径|仙人掌/i],
    ["搜索", /搜索|剪枝|迭代加深|启发式|双向|折半|DFS|BFS|深度优先|广度优先/i],
    ["数据结构", /数据结构|栈|队列|堆|并查集|线段树|树状数组|平衡树|Splay|Treap|字典树|Trie|哈希表|链表|分块|单调|RMQ|ST表|莫队|可持久化/i],
    ["树", /树链剖分|点分治|树上|树的重心|虚树|树分块|Kruskal 重构树|dsu on tree/i],
    ["二分/分治", /二分|分治|倍增|三分|整体|CDQ/i],
    ["贪心", /贪心/i],
    ["模拟/枚举", /模拟|枚举|暴力|递归|递推|打表/i],
    ["计算几何", /几何|凸包|旋转卡壳|半平面/i],
    ["数学", /数学|数论|组合|概率|期望|线性代数|矩阵|高斯消元|微积分|群论|多项式|快速幂|素数|质数|筛法|进制|位运算|高精度|公约数|欧拉函数|中国剩余|卢卡斯|卡特兰|斯特林|容斥|斐波那契|密码|博弈/i],
];

interface TagInfo { id: number; name: string; parent: number | null }

let tagMap: Map<number, TagInfo> | null = null;

function loadTagMap(): Map<number, TagInfo> {
    if (tagMap) return tagMap;
    const map = new Map<number, TagInfo>();
    const list = (tagsData as any)?.tags;
    if (Array.isArray(list)) {
        for (const t of list) {
            if (t && typeof t.id === "number") {
                map.set(t.id, {
                    id: t.id,
                    name: cleanName(String(t.name ?? "")),
                    parent: t.parent === null || t.parent === undefined ? null : Number(t.parent),
                });
            }
        }
    }
    tagMap = map;
    return map;
}

function cleanName(s: string): string {
    return (s || "").replace(/\ufeff/g, "").trim();
}

function categorize(tagNames: string[]): string[] {
    const cats = new Set<string>();
    for (const name of tagNames) {
        for (const [cat, re] of CATEGORY_RULES) {
            if (re.test(name)) {
                cats.add(cat);
                break;
            }
        }
    }
    return [...cats].sort();
}

/** 仅允许 https + 固定 host 白名单；初始 URL 与 302 location 一视同仁 */
function assertSafeUrl(raw: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw badRequest("目标 URL 不合法");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== HOST || parsed.username || parsed.password) {
        throw badRequest("目标地址不在白名单内");
    }
    return parsed;
}

/** 构造题目页地址：题号已过正则白名单，再经编码与 host 白名单复核 */
function problemUrl(pid: string): URL {
    const target = new URL(ORIGIN);
    target.pathname = "/problem/" + encodeURIComponent(pid);
    return assertSafeUrl(target.toString());
}

async function httpGet(target: URL): Promise<string> {
    const headers: Record<string, string> = {
        "User-Agent": UA,
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    };
    // 第一步：manual 接住 302 下发的 __client_id Cookie
    const first = await fetch(target, { headers, redirect: "manual" });
    if (first.status >= 300 && first.status < 400) {
        const setCookie = first.headers.get("set-cookie") || "";
        const pair = setCookie.split(";")[0].trim();
        const location = assertSafeUrl(first.headers.get("location") || target.toString());
        if (pair) headers["Cookie"] = pair;
        const second = await fetch(location, { headers, redirect: "follow" });
        if (!second.ok) {
            throw badRequest(`洛谷返回 HTTP ${second.status}（可能被风控）；请手动填写题目信息`);
        }
        return second.text();
    }
    if (!first.ok) {
        throw badRequest(`洛谷返回 HTTP ${first.status}（可能被风控）；请手动填写题目信息`);
    }
    return first.text();
}

export interface LuoguProblem {
    pid: string;
    title: string;
    difficulty: number | null;
    tags: string[];
    categories: string[];
    /** 题面 markdown（背景/描述/输入输出格式/说明提示 按节拼接；空节跳过） */
    content: string;
    /** 单测试点最大时间限制（ms，取各测试点最大值，供提示词模板使用）；抓不到为 null */
    timeLimit: number | null;
    /** 全测试点总时间限制（ms，Σ limits.time，与洛谷提交总耗时口径一致）；抓不到为 null */
    totalTimeLimit: number | null;
    /** 测试点总数（limits.time.length）；抓不到为 null */
    testCases: number | null;
    /** 内存限制（MB，limits.memory 单位是 KB，向上取整）；抓不到为 null */
    memoryLimit: number | null;
    /** 洛谷题目页是否附有附件（attachments 数组非空） */
    hasAttachments: boolean;
    fetchedAt: string;
}

/** 样例格式化为 markdown（samples = [[输入, 输出], ...]；空值/缺输出跳过） */
function formatSamples(samples: unknown): string {
    if (!Array.isArray(samples) || !samples.length) return "";
    const blocks: string[] = [];
    let idx = 0;
    for (const s of samples) {
        if (!Array.isArray(s) || s.length < 2) continue;
        idx += 1;
        const clean = (v: unknown) => String(v ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
        blocks.push(
            `### 输入样例 #${idx}\n\n\`\`\`\n${clean(s[0])}\n\`\`\`\n\n` +
            `### 输出样例 #${idx}\n\n\`\`\`\n${clean(s[1])}\n\`\`\``,
        );
    }
    if (!blocks.length) return "";
    return `## 输入输出样例\n\n${blocks.join("\n\n")}`;
}

/** 把 content 各节拼成一份 markdown 题面（name 不重复拼，题目名另有字段）。
 *  节序对齐洛谷页面：背景 → 描述 → 输入格式 → 输出格式 → 输入输出样例 → 说明/提示。 */
function composeContent(c: any, samples: unknown): string {
    if (!c || typeof c !== "object") return "";
    const sections: Array<[string, unknown]> = [
        ["题目背景", c.background],
        ["题目描述", c.description],
        ["输入格式", c.formatI],
        ["输出格式", c.formatO],
    ];
    const parts: string[] = [];
    for (const [title, body] of sections) {
        const text = cleanName(String(body ?? ""));
        if (text) parts.push(`## ${title}\n\n${text}`);
    }
    const sampleBlock = formatSamples(samples);
    if (sampleBlock) parts.push(sampleBlock);
    const hint = cleanName(String(c.hint ?? ""));
    if (hint) parts.push(`## 说明/提示\n\n${hint}`);
    return parts.join("\n\n");
}

/** 洛谷抓取结果缓存：**带 TTL**（旧实现永不过期，洛谷改标题/加附件后本站无限期返回旧数据），
 *  并带 single-flight（同一 pid 并发只发一次上游请求，避免管理员连点把洛谷打出风控）。 */
const CACHE_TTL_MS = 6 * 60 * 60_000;   // 6 小时
const CACHE_MAX = 2000;                 // 超出按"最旧写入"淘汰（旧实现是 size>5000 整体 clear，瞬间全量回源）
interface CacheEntry { at: number; value: LuoguProblem }

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<LuoguProblem>>();

function cacheGet(pid: string): LuoguProblem | null {
    const hit = cache.get(pid);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
        cache.delete(pid);
        return null;
    }
    return hit.value;
}

function cacheSet(pid: string, value: LuoguProblem): void {
    if (cache.size >= CACHE_MAX) {
        // Map 保持插入顺序：删掉最早写入的一批（近似 LRU，成本 O(1)）
        for (const k of cache.keys()) {
            cache.delete(k);
            if (cache.size < CACHE_MAX * 0.8) break;
        }
    }
    cache.set(pid, { at: Date.now(), value });
}

export async function fetchLuoguProblem(pidRaw: string): Promise<LuoguProblem> {
    const pid = String(pidRaw ?? "").trim().toUpperCase();
    if (!PID_RE.test(pid)) {
        throw badRequest(`题号格式不正确：${pid}（示例：P1001 / B2001 / CF10A）`);
    }
    const cached = cacheGet(pid);
    if (cached) return cached;
    const pending = inflight.get(pid);
    if (pending) return pending;
    const task = (async () => {
        try {
            return await loadLuoguProblem(pid);
        } finally {
            inflight.delete(pid);
        }
    })();
    inflight.set(pid, task);
    return task;
}

async function loadLuoguProblem(pid: string): Promise<LuoguProblem> {
    const html = await httpGet(problemUrl(pid));
    const m = html.match(LENTILLE_RE);
    if (!m) {
        throw badRequest("洛谷页面结构变化或被风控拦截，未找到内嵌数据；请手动填写题目信息");
    }
    let ctx: any;
    try {
        ctx = JSON.parse(m[1]);
    } catch {
        throw badRequest("洛谷内嵌数据解析失败；请手动填写题目信息");
    }
    const status = typeof ctx?.status === "number" ? ctx.status : -1;
    const problem = ctx?.data?.problem ?? {};
    const name = cleanName(String(problem.name ?? ""));
    if (status !== 200 || !name) {
        throw badRequest(`洛谷未返回该题目（status=${status}），题号可能不存在；请核对或手动填写`);
    }

    const map = loadTagMap();
    const tagIds: number[] = Array.isArray(problem.tags) ? problem.tags.map(Number) : [];
    const tagNames: string[] = [];
    for (const tid of tagIds) {
        const info = map.get(tid);
        if (info?.name) tagNames.push(info.name);
    }
    // 沿父链补充名称（便于归类：如「模拟」父级为「基础算法」）
    const chainNames: string[] = [];
    for (const tid of tagIds) {
        const seen = new Set<number>();
        let cur = map.get(tid);
        while (cur && !seen.has(cur.id)) {
            seen.add(cur.id);
            if (cur.name && !chainNames.includes(cur.name)) chainNames.push(cur.name);
            cur = cur.parent === null ? undefined : map.get(cur.parent);
        }
    }
    const diff = Number(problem.difficulty);
    const limits = problem.limits ?? {};
    const timeArr: number[] = Array.isArray(limits.time) ? limits.time.map(Number).filter((x: number) => Number.isFinite(x) && x > 0) : [];
    const memArr: number[] = Array.isArray(limits.memory) ? limits.memory.map(Number).filter((x: number) => Number.isFinite(x) && x > 0) : [];
    const result: LuoguProblem = {
        pid,
        title: name,
        difficulty: Number.isInteger(diff) && diff >= 0 && diff <= 7 ? diff : null,
        tags: tagNames,
        categories: categorize(chainNames),
        content: composeContent(problem.content, problem.samples),
        timeLimit: timeArr.length ? Math.round(Math.max(...timeArr)) : null,
        totalTimeLimit: timeArr.length ? Math.round(timeArr.reduce((a, b) => a + b, 0)) : null,
        testCases: timeArr.length ? timeArr.length : null,
        memoryLimit: memArr.length ? Math.ceil(Math.max(...memArr) / 1024) : null,
        hasAttachments: Array.isArray(problem.attachments) && problem.attachments.length > 0,
        fetchedAt: nowLocal(),
    };
    cacheSet(pid, result);
    return result;
}
