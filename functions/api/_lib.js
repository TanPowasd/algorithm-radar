// Cloudflare Pages Functions 共享库：洛谷抓取 + 标签归类
// 由 functions/api/luogu.js 和 sync.js 复用

const LUOGU_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const DIFFICULTY_NAMES = {
  0: "暂无评定", 1: "入门", 2: "普及−", 3: "普及/提高−", 4: "普及+/提高",
  5: "提高+/省选−", 6: "省选/NOI−", 7: "NOI/NOI+/CTSC",
};

// 算法大类归类规则（顺序匹配，先命中先归类），与 Python 版一致
const CATEGORY_RULES = [
  ["动态规划", /DP|动态规划|背包|状态压缩|树形dp|数位dp|区间dp|斜率优化|单调队列优化|轮廓线/i],
  ["字符串", /字符串|KMP|后缀|自动机|回文|Manacher|最小表示|模式匹配|哈希/i],
  ["图论", /图论|最短路|生成树|拓扑|网络流|二分图|强连通|割点|割边|桥|欧拉|哈密顿|差分约束|连通|最近公共祖先|LCA|树的直径|仙人掌/i],
  ["搜索", /搜索|剪枝|迭代加深|启发式|双向|折半|DFS|BFS|深度优先|广度优先/i],
  ["数据结构", /数据结构|栈|队列|堆|并查集|线段树|树状数组|平衡树|Splay|Treap|字典树|Trie|哈希表|链表|分块|单调|RMQ|ST表|莫队|可持久化/i],
  ["二分/分治", /二分|分治|倍增|三分|整体|CDQ/i],
  ["贪心", /贪心/i],
  ["模拟/枚举", /模拟|枚举|暴力|递归|递推|打表/i],
  ["计算几何", /几何|凸包|旋转卡壳|半平面/i],
  ["数学", /数学|数论|组合|概率|期望|线性代数|矩阵|高斯消元|微积分|群论|多项式|快速幂|素数|质数|筛法|进制|位运算|高精度|公约数|欧拉函数|中国剩余|卢卡斯|卡特兰|斯特林|容斥|斐波那契|密码|博弈/i],
];

const PID_RE = /^[A-Za-z]{1,3}_?[A-Za-z0-9_]{2,20}$/;
const LENTILLE_RE = /<script id="lentille-context" type="application\/json">(.*?)<\/script>/s;

let tagMapCache = null;

async function fetchText(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": LUOGU_UA,
      Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    redirect: "follow",
  });
  return resp.text();
}

// 读取 tags.json（已复制到 functions/ 目录，随函数一起打包）
async function loadTagMap(env) {
  if (tagMapCache) return tagMapCache;
  let data = null;
  try {
    const resp = await fetch(new URL("../tags.json", import.meta.url));
    if (resp.ok) data = await resp.json();
  } catch (e) { /* 忽略 */ }
  if (!data || !Array.isArray(data.tags)) {
    // 兜底：联网拉取标签表
    try {
      data = JSON.parse(await fetchText("https://www.luogu.com.cn/_lfe/tags/zh-CN"));
    } catch (e) { return {}; }
  }
  tagMapCache = {};
  for (const t of data.tags || []) tagMapCache[t.id] = t;
  return tagMapCache;
}

const cleanName = (s) => (typeof s === "string" ? s.replace(/\ufeff/g, "").trim() : "");

function categorize(tagNames) {
  const cats = new Set();
  for (const name of tagNames) {
    for (const [cat, re] of CATEGORY_RULES) {
      if (re.test(name)) { cats.add(cat); break; }
    }
  }
  return [...cats].sort();
}

export async function fetchLuoguProblem(pid, env) {
  pid = String(pid || "").trim().toUpperCase();
  if (!PID_RE.test(pid)) {
    throw new Error("题号格式不正确：" + pid + "（示例：P1001 / B2001 / CF10A）");
  }
  const html = await fetchText("https://www.luogu.com.cn/problem/" + encodeURIComponent(pid));
  const m = LENTILLE_RE.exec(html);
  if (!m) throw new Error("洛谷页面结构变化或被风控拦截，未找到内嵌数据；请手动填写题目信息");
  let ctx;
  try { ctx = JSON.parse(m[1]); } catch (e) { throw new Error("洛谷内嵌数据解析失败；请手动填写题目信息"); }

  const problem = (ctx.data && ctx.data.problem) || {};
  if (ctx.status !== 200 || !problem.name) {
    throw new Error("洛谷未返回该题目（status=" + ctx.status + "），题号可能不存在；请核对或手动填写");
  }

  const tagMap = await loadTagMap(env);
  const tagNames = [];
  for (const tid of problem.tags || []) {
    const info = tagMap[tid];
    if (info) { const nm = cleanName(info.name); if (nm) tagNames.push(nm); }
  }

  // 沿父链补充名称（便于归类）
  const chainNames = [];
  for (const tid of problem.tags || []) {
    const seen = new Set();
    let cur = tagMap[tid];
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const nm = cleanName(cur.name);
      if (nm && !chainNames.includes(nm)) chainNames.push(nm);
      cur = cur.parent != null ? tagMap[cur.parent] : null;
    }
  }
  const categories = categorize(chainNames);

  let diff = problem.difficulty;
  diff = diff == null ? null : Number(diff);
  if (!(diff in DIFFICULTY_NAMES)) diff = null;

  return {
    pid,
    title: cleanName(problem.name),
    difficulty: diff,
    tags: tagNames,
    categories,
    fetchedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
  };
}
