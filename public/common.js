/* 算法雷达站 · 公共模块（主页与审核台共用）
   包含：主题切换、Toast、HTML 转义、API 客户端、记录展示辅助函数。
   数据的权威副本在服务端；前端不持有任何凭据，权限由服务端 Cookie 会话判定。 */
"use strict";

/* ================= 常量 ================= */

const DIFF_NAMES = ["暂无评定", "入门", "普及−", "普及/提高−", "普及+/提高", "提高+/省选−", "省选/NOI−", "NOI/NOI+/CTSC"];
const RESULTS = ["AC", "WA", "TLE", "MLE", "RE", "CE", "未解出"];
/* 思考等级 7 级（按投入程度降序，与 store.py 白名单一致）；旧数据 5 级取值是子集，天然兼容 */
const THINKING_LEVELS = ["ultra", "max", "xhigh", "high", "medium", "low", "off"];
const DEFAULT_THINKING = "max";
const CATEGORY_ORDER = ["模拟/枚举", "贪心", "二分/分治", "搜索", "动态规划", "图论", "数据结构", "树", "字符串", "数学", "计算几何", "其他/未标注"];
const SERIES_COLORS = ["#5aa9ff", "#46c266", "#b98cff", "#f0913e", "#f2635a", "#39c5cf", "#e4b53d", "#7ee787", "#ff9db1", "#8b9dff"];
const PID_RE = /^[A-Z]{1,3}_?[A-Z0-9_]{2,20}$/;

const LS_THEME = "radar.theme";
const LS_CACHE = "radar.cache.v3";   // 离线只读缓存（服务器不可达时用于展示）

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ================= 主题 ================= */

function initTheme() {
  let theme = null;
  try { theme = localStorage.getItem(LS_THEME); } catch { /* 隐私模式下忽略 */ }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.dataset.theme = theme;
  const btn = $("#btn-theme");
  if (btn) btn.addEventListener("click", toggleTheme);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(LS_THEME, next); } catch { /* ignore */ }
  document.dispatchEvent(new CustomEvent("themechange", { detail: next }));
}

/** 读取当前主题下的 CSS 变量值（供 Chart.js 使用，保证图表跟随主题） */
function cssVar(name, fallback = "") {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/* ================= Toast ================= */

function toast(msg, type = "") {
  const el = $("#toast");
  if (!el) return;
  el.classList.remove("leaving");
  el.textContent = msg;
  el.className = "toast " + type;
  el.hidden = false;
  clearTimeout(toast._t);
  clearTimeout(toast._t2);
  toast._t = setTimeout(() => {
    el.classList.add("leaving");
    toast._t2 = setTimeout(() => {
      el.hidden = true;
      el.classList.remove("leaving");
    }, 200);
  }, type === "err" ? 5000 : 3200);
}

/* ================= 文本处理 ================= */

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function normalizePid(pid) {
  return String(pid || "").trim().toUpperCase();
}

/** 已发布题目的排序键列表：难度降序、同难度按题号（数字感知）。
    problems 是服务端题目目录 {pid: {title, difficulty, ...}}，即「游客可提交的题目全集」。 */
function sortedProblemPids(problemMap) {
  return Object.keys(problemMap || {}).sort((a, b) => {
    const da = problemMap[a] && problemMap[a].difficulty;
    const db = problemMap[b] && problemMap[b].difficulty;
    const na = da == null ? -1 : da, nb = db == null ? -1 : db;
    if (nb !== na) return nb - na;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ================= API 客户端 ================= */

/** 从 Cookie 读取 CSRF 令牌（服务端下发的非 HttpOnly Cookie；会话 Cookie 是 HttpOnly，读不到） */
function csrfToken() {
  const m = /(?:^|;\s*)radar_csrf=([^;]+)/.exec(document.cookie || "");
  return m ? decodeURIComponent(m[1]) : "";
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** 统一请求封装：自动带 CSRF 头、解析错误信息、附带同源 Cookie */
async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  const init = { method, credentials: "same-origin", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = csrfToken();

  let resp;
  try {
    resp = await fetch(path, init);
  } catch {
    throw new ApiError("无法连接服务器，请确认服务已启动", 0);
  }
  let data = null;
  const text = await resp.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!resp.ok) {
    throw new ApiError((data && data.error) || `请求失败（HTTP ${resp.status}）`, resp.status);
  }
  return data || {};
}

/* ================= 记录辅助 ================= */

const lastSub = (r) => r.submissions[r.submissions.length - 1];
const firstSub = (r) => r.submissions[0];
const isPassed = (r) => lastSub(r).result === "AC";
const isFirstPassed = (r) => firstSub(r).result === "AC";
const isPending = (r) => r.status === "pending";
const isApproved = (r) => r.status !== "pending";

/** AI 组合 = 模型名（版本/策略仅作为记录字段展示，不参与分组统计——矩阵列、雷达系列、筛选均按模型聚合） */
function seriesKey(r) {
  return r.model;
}

/** Agent / Token 来源合并展示文本（明细表与审核台共用）；两者都空返回空串 */
function agentTokenText(r) {
  const agent = r.agent || "";
  const token = r.tokenSource || "";
  if (agent && token) return `${agent} / ${token}`;
  return agent || token;
}

function seriesColorFrom(list, label) {
  const idx = list.indexOf(label);
  return SERIES_COLORS[(idx < 0 ? 0 : idx) % SERIES_COLORS.length];
}

function diffTagHtml(diff) {
  if (diff == null || diff < 0 || diff > 7) return '<span class="muted">–</span>';
  return `<span class="diff-tag d-${diff}">${escapeHtml(DIFF_NAMES[diff])}</span>`;
}

/** 分数档位类名：与矩阵图口径一致（100 紫 / ≥80 绿 / 60–79 橙 / <60 红）；无分返回 null（按判定结果着色） */
function scoreTierClass(score) {
  if (score == null) return null;
  if (score >= 100) return "b-100";
  if (score >= 80) return "b-hi";
  if (score >= 60) return "b-mid";
  return "b-lo";
}

function subBadge(s, i) {
  const hasScore = s.score != null;
  const scorePart = hasScore ? `${s.score}分` : "";
  const tier = scoreTierClass(s.score);
  const cls = tier || `b-${escapeHtml(s.result)}`;
  const tip = `第${i + 1}次提交：${s.result}` +
    (hasScore ? `，${s.score} 分` : "") +
    (s.note ? `（${s.note}）` : "");
  return `<span class="sub-badge ${cls}" title="${escapeHtml(tip)}">${scorePart || escapeHtml(s.result)}</span>`;
}

function chainHtml(r) {
  return r.submissions.map(subBadge).join('<span class="arrow">→</span>');
}

/** 表单里的提交轮次 → 提交给服务端的形状（服务端还会再校验一次） */
function normalizeSub(s) {
  let score = s && s.score !== "" && s.score != null ? Number(s.score) : null;
  if (score != null && !Number.isFinite(score)) score = null;
  if (score != null) score = Math.min(100, Math.max(0, Math.round(score)));
  return {
    score,
    result: RESULTS.includes(s && s.result) ? s.result : "未解出",
    note: String((s && s.note) || "").trim(),
  };
}

/* ================= 弹窗辅助 ================= */

function openOverlay(sel) {
  const el = $(sel);
  if (!el) return;
  el.hidden = false;
  document.body.classList.add("modal-open");
  const first = el.querySelector("input, select, textarea, button");
  if (first) first.focus();
}

function closeOverlay(sel) {
  const el = $(sel);
  if (el) el.hidden = true;
  if (!$$(".modal-overlay").some((o) => !o.hidden)) document.body.classList.remove("modal-open");
}

/** 给弹窗绑定「点遮罩关闭 + Esc 关闭 + 关闭按钮」 */
function bindOverlay(sel, closeSelectors = []) {
  const el = $(sel);
  if (!el) return;
  el.addEventListener("click", (e) => { if (e.target === el) closeOverlay(sel); });
  closeSelectors.forEach((s) => {
    const b = $(s);
    if (b) b.addEventListener("click", () => closeOverlay(sel));
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = $$(".modal-overlay").filter((o) => !o.hidden);
  if (open.length) closeOverlay("#" + open[open.length - 1].id);
});

/* ================= 离线缓存 ================= */

function saveCache(bundle) {
  try {
    localStorage.setItem(LS_CACHE, JSON.stringify({
      revision: bundle.revision, records: bundle.records, problems: bundle.problems, cachedAt: Date.now(),
    }));
  } catch { /* 超出配额时忽略：服务端才是权威存储 */ }
}

function loadCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_CACHE) || "null");
    if (raw && Array.isArray(raw.records)) return raw;
  } catch { /* ignore */ }
  return null;
}

/* ================= 返回顶部（移动端长页刚需；注入式，页面无需写标记） ================= */

function initBackTop() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "back-top";
  btn.title = "回到顶部";
  btn.setAttribute("aria-label", "回到顶部");
  btn.textContent = "↑";
  btn.addEventListener("click", () => {
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  });
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      btn.classList.toggle("show", window.scrollY > 400);
      ticking = false;
    });
  }, { passive: true });
  document.body.appendChild(btn);
}

/* ================= 发布新题（主页与管理台共用） =================
   流程：题号 → 「抓取」由服务端代抓洛谷补全 → 核对/修改 → 发布（写入题目目录）。
   发布成功后广播 problemschanged 事件，页面各自刷新数据。 */

function initProblemPublish() {
  const overlay = $("#problem-publish-modal");
  if (!overlay) return;

  const diffSel = $("#pub-difficulty");
  diffSel.innerHTML = '<option value="">– 未知 –</option>' +
    DIFF_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join("");

  let lastFetch = null;   // 最近一次抓取结果（发布时附带 tags / fetchedAt）

  function openPublish() {
    $("#pub-pid").value = "";
    $("#pub-title").value = "";
    diffSel.value = "";
    $("#pub-cats").value = "";
    const status = $("#pub-status");
    status.textContent = "";
    status.className = "fetch-status";
    lastFetch = null;
    openOverlay("#problem-publish-modal");
    $("#pub-pid").focus();
  }

  async function fetchInfo() {
    const pid = normalizePid($("#pub-pid").value);
    const status = $("#pub-status");
    if (!pid) { status.textContent = "请先填写题号"; status.className = "fetch-status err"; return; }
    if (!PID_RE.test(pid)) { status.textContent = "题号格式不太对（示例：P1001 / B2001 / CF10A）"; status.className = "fetch-status err"; return; }
    status.textContent = "正在从洛谷抓取…";
    status.className = "fetch-status loading";
    try {
      const data = await api(`/api/luogu?pid=${encodeURIComponent(pid)}`);
      lastFetch = data;
      $("#pub-title").value = data.title || "";
      if (data.difficulty != null) diffSel.value = String(data.difficulty);
      $("#pub-cats").value = (data.categories || []).join(", ");
      status.textContent = `抓取成功：${data.title || pid}（洛谷难度 ${DIFF_NAMES[data.difficulty] || "未知"}，发布前请核对）`;
      status.className = "fetch-status ok";
    } catch (e) {
      status.textContent = "抓取失败：" + (e.message || e) + "。可手动填写题名/难度/类别后直接发布。";
      status.className = "fetch-status err";
    }
  }

  async function submitPublish(e) {
    e.preventDefault();
    const btn = $("#pub-submit");
    if (btn.disabled) return;
    const pid = normalizePid($("#pub-pid").value);
    const title = $("#pub-title").value.trim();
    const diffRaw = diffSel.value;
    if (!pid || !PID_RE.test(pid)) { toast("题号格式不正确（示例：P1001 / B2001 / CF10A）", "err"); return; }
    if (diffRaw === "") { toast("请选择难度（洛谷自动难度不可靠，需核对后选择）", "err"); return; }
    const cats = $("#pub-cats").value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    const payload = {
      pid,
      problem: {
        title,
        difficulty: Number(diffRaw),
        categories: [...new Set(cats)],
        tags: (lastFetch && lastFetch.tags) || [],
        manual: true,
        fetchedAt: (lastFetch && lastFetch.fetchedAt) || "",
      },
    };
    setBtnBusy(btn, true, "发布中…");
    try {
      await api("/api/problems", { method: "POST", body: payload });
      toast(`题目 ${pid} 已发布，游客现在可以提交该题的测试`, "ok");
      closeOverlay("#problem-publish-modal");
      document.dispatchEvent(new CustomEvent("problemschanged"));
    } catch (err) {
      toast((err && err.message) || "发布失败", "err");
    } finally {
      setBtnBusy(btn, false);
    }
  }

  const fetchBtn = $("#pub-fetch");
  if (fetchBtn) fetchBtn.addEventListener("click", fetchInfo);
  $("#pub-pid").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); fetchInfo(); }
  });
  $("#publish-form").addEventListener("submit", submitPublish);
  bindOverlay("#problem-publish-modal", ["#pub-close", "#pub-cancel"]);
}

/* 页面各自绑定「发布新题」入口按钮（id 相同：btn-new-problem） */
function bindPublishEntry() {
  const btn = $("#btn-new-problem");
  if (btn) btn.addEventListener("click", openProblemPublish);
}

/* 供空态等场景直接调用（app.js 空态里的「发布新题」按钮） */
function openProblemPublish() {
  const overlay = $("#problem-publish-modal");
  if (!overlay) { toast("本页不支持发布题目，请到管理台操作", "err"); return; }
  overlay.hidden = false;
  document.body.classList.add("modal-open");
  $("#pub-pid").focus();
}

/* 公共初始化（脚本位于 body 末尾加载，DOM 已就绪） */
initBackTop();
initProblemPublish();
bindPublishEntry();
