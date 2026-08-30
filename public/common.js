/* 算法雷达站 · 公共模块（主页与审核台共用）
   包含：主题切换、Toast、HTML 转义、API 客户端、记录展示辅助函数。
   数据的权威副本在服务端；前端不持有任何凭据，权限由服务端 Cookie 会话判定。 */
"use strict";

/* ================= 常量 ================= */

const DIFF_NAMES = ["暂无评定", "入门", "普及−", "普及/提高−", "普及+/提高", "提高+/省选−", "省选/NOI−", "NOI/NOI+/CTSC"];
const RESULTS = ["AC", "WA", "TLE", "MLE", "RE", "CE", "未解出"];
const THINKING_LEVELS = ["max", "high", "medium", "low", "off"];
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

function seriesKey(r) {
  return r.variant ? `${r.model} · ${r.variant}` : r.model;
}

function seriesColorFrom(list, label) {
  const idx = list.indexOf(label);
  return SERIES_COLORS[(idx < 0 ? 0 : idx) % SERIES_COLORS.length];
}

function diffTagHtml(diff) {
  if (diff == null || diff < 0 || diff > 7) return '<span class="muted">–</span>';
  return `<span class="diff-tag d-${diff}">${escapeHtml(DIFF_NAMES[diff])}</span>`;
}

function subBadge(s, i) {
  const scorePart = s.score != null ? `${s.score}分` : "";
  const tip = `第${i + 1}次提交：${s.result}` +
    (s.score != null ? `，${s.score} 分` : "") +
    (s.note ? `（${s.note}）` : "");
  return `<span class="sub-badge b-${escapeHtml(s.result)}" title="${escapeHtml(tip)}">${scorePart || escapeHtml(s.result)}</span>`;
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
