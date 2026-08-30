/* 算法雷达站 - 审核台（管理员专用页面）
   独立于主页 app.js，复用相同的 localStorage 数据与登录态。
   功能：查看待审核的游客提交、筛选、单个/批量通过或拒绝。 */
"use strict";

/* ================= 常量（与 app.js 保持一致） ================= */

const THINKING_LEVELS = ["max", "high", "medium", "low", "off"];
const DEFAULT_THINKING = "max";
const DIFF_NAMES = ["暂无评定", "入门", "普及−", "普及/提高−", "普及+/提高", "提高+/省选−", "省选/NOI−", "NOI/NOI+/CTSC"];
const RESULTS = ["AC", "WA", "TLE", "MLE", "RE", "CE", "未解出"];

const LS_RECORDS = "radar.records.v1";
const LS_PROBLEMS = "radar.problems.v1";
const LS_AUTH = "radar.auth.v1";

const ADMIN_USERNAME = "TanPowasd";
const ADMIN_PASSWORD_HASH = "ee4e61b4ac9747fca1f4c9b8a64c63279bd296da662e0488f2d8ee2f68045004";

/* ================= 状态 ================= */

let records = [];
let problems = {};
let isAdmin = false;

/* ================= 工具 ================= */

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function seriesKey(r) {
  return r.variant ? `${r.model} · ${r.variant}` : r.model;
}

function seriesList() {
  return [...new Set(records.map(seriesKey))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function diffTagHtml(diff) {
  if (diff == null || diff < 0 || diff > 7) return '<span class="muted">–</span>';
  return `<span class="diff-tag d-${diff}">${DIFF_NAMES[diff]}</span>`;
}

function toast(msg, type = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast " + type;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function normalizeSub(s) {
  let score = s && s.score != null && s.score !== "" ? Number(s.score) : null;
  if (score != null && (!Number.isFinite(score) || score < 0)) score = 0;
  if (score != null && score > 100) score = 100;
  score = score == null ? null : Math.round(score);
  const result = RESULTS.includes(s && s.result) ? s.result : "未解出";
  return { score, result, note: String((s && s.note) || "").trim() };
}

function migrateRecord(r) {
  if (!Array.isArray(r.submissions) || r.submissions.length === 0) {
    r.submissions = [{ score: r.result === "AC" ? 100 : null, result: r.result || "未解出", note: "" }];
  }
  r.submissions = r.submissions.map(normalizeSub);
  delete r.attempts;
  if (!THINKING_LEVELS.includes(r.thinking)) r.thinking = DEFAULT_THINKING;
  if (r.status !== "approved" && r.status !== "pending") r.status = "approved";
  if (r.author !== "admin" && r.author !== "guest") r.author = "admin";
  return r;
}

function subBadge(s, i) {
  const scorePart = s.score != null ? `${s.score}分` : "";
  const tip = `第${i + 1}次提交：${s.result}` + (s.score != null ? `，${s.score} 分` : "") + (s.note ? `（${s.note}）` : "");
  return `<span class="sub-badge b-${escapeHtml(s.result)}" title="${escapeHtml(tip)}">${scorePart || escapeHtml(s.result)}</span>`;
}

function chainHtml(r) {
  return r.submissions.map(subBadge).join('<span class="arrow">→</span>');
}

function saveState() {
  try {
    localStorage.setItem(LS_RECORDS, JSON.stringify(records));
  } catch (e) {
    toast("保存失败：" + e.message, "err");
  }
  // 多设备共享：审核操作后同步推送到云端
  pushCloud();
}

/** 云端同步：推送 records/problems 到共享存储（Vercel /api/sync 代理） */
async function pushCloud() {
  try {
    await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records, problems }),
    });
  } catch (e) {
    console.warn("云端同步推送失败（不影响本地）：", e);
  }
}

/** 从云端拉取共享数据；未配置/失败返回 null */
async function pullCloud() {
  try {
    const resp = await fetch("/api/sync", { method: "GET" });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !Array.isArray(data.records)) return null;
    return data;
  } catch (e) {
    console.warn("云端同步拉取失败（使用本地数据）：", e);
    return null;
  }
}

function loadState() {
  try { records = JSON.parse(localStorage.getItem(LS_RECORDS) || "[]") || []; } catch { records = []; }
  try { problems = JSON.parse(localStorage.getItem(LS_PROBLEMS) || "{}") || {}; } catch { problems = {}; }
  if (!Array.isArray(records)) records = [];
  records = records.map(migrateRecord);
}

/* ================= 登录 ================= */

function saveAuth() {
  try { localStorage.setItem(LS_AUTH, JSON.stringify({ admin: isAdmin })); } catch { /* ignore */ }
}

function loadAuth() {
  try { isAdmin = !!(JSON.parse(localStorage.getItem(LS_AUTH) || "{}").admin); } catch { isAdmin = false; }
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function doLogin(e) {
  e.preventDefault();
  const user = $("#login-user").value.trim();
  const pass = $("#login-pass").value;
  const hash = await sha256Hex(pass);
  if (user === ADMIN_USERNAME && hash === ADMIN_PASSWORD_HASH) {
    isAdmin = true;
    saveAuth();
    toast("已登录为管理员", "ok");
    renderAll();
  } else {
    toast("用户名或密码错误", "err");
  }
}

function doLogout() {
  isAdmin = false;
  saveAuth();
  toast("已退出登录", "ok");
  renderAll();
}

/* ================= 渲染 ================= */

function renderAll() {
  $("#login-gate").hidden = isAdmin;
  $("#work-area").hidden = !isAdmin;
  $("#btn-logout").hidden = !isAdmin;
  if (!isAdmin) return;
  renderSummary();
  renderFilterSeries();
  renderPending();
}

function renderSummary() {
  const pend = records.filter((r) => r.status === "pending");
  const today = new Date().toISOString().slice(0, 10);
  const todayCnt = records.filter((r) => String(r.date).startsWith(today)).length;
  const guestCnt = records.filter((r) => r.author === "guest").length;
  $("#stat-pending").textContent = pend.length;
  $("#stat-today").textContent = todayCnt;
  $("#stat-guest").textContent = guestCnt;
}

function renderFilterSeries() {
  const sel = $("#f-series");
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部 AI 组合</option>' +
    seriesList().map((s) => `<option${s === cur ? " selected" : ""}>${escapeHtml(s)}</option>`).join("");
}

function renderPending() {
  const wrap = $("#pending-wrap");
  const kw = $("#f-keyword").value.trim().toLowerCase();
  const seriesF = $("#f-series").value;
  const pend = records.filter((r) => r.status === "pending")
    .filter((r) => !seriesF || seriesKey(r) === seriesF)
    .filter((r) => !kw ||
      `${r.model} ${r.variant || ""} ${r.pid} ${r.title || ""} ${r.note || ""}`.toLowerCase().includes(kw))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.id - a.id));

  if (!pend.length) {
    wrap.innerHTML = '<p class="empty-tip">没有符合条件的待审核提交 🎉</p>';
    return;
  }

  const rows = pend.map((r) => `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(seriesKey(r))}</td>
      <td><span class="think-tag">${escapeHtml(r.thinking || DEFAULT_THINKING)}</span></td>
      <td><a class="pid-link" href="https://www.luogu.com.cn/problem/${encodeURIComponent(r.pid)}" target="_blank" rel="noopener">${escapeHtml(r.pid)}</a></td>
      <td>${escapeHtml(r.title || "")}</td>
      <td>${diffTagHtml(r.difficulty)}</td>
      <td><span class="sub-chain">${chainHtml(r)}</span></td>
      <td class="note-cell">${escapeHtml(r.note || "")}</td>
      <td>
        <div class="review-actions">
          <button class="btn small" data-approve="${r.id}">通过</button>
          <button class="btn small danger" data-reject="${r.id}">拒绝</button>
        </div>
      </td>
    </tr>`).join("");

  wrap.innerHTML = `<table class="review-table"><thead><tr>
      <th>日期</th><th>AI 组合</th><th>思考</th><th>题号</th><th>题目</th><th>难度</th><th>提交轨迹</th><th>备注</th><th>操作</th>
    </tr></thead><tbody>${rows}</tbody></table>`;

  wrap.querySelectorAll("button[data-approve]").forEach((b) => {
    b.addEventListener("click", () => {
      const rec = records.find((x) => x.id === Number(b.dataset.approve));
      if (!rec) return;
      rec.status = "approved";
      saveState();
      renderAll();
      toast("已通过，计入统计", "ok");
    });
  });
  wrap.querySelectorAll("button[data-reject]").forEach((b) => {
    b.addEventListener("click", () => {
      const rec = records.find((x) => x.id === Number(b.dataset.reject));
      if (!rec) return;
      if (!confirm(`拒绝并删除：${seriesKey(rec)} · ${rec.pid}？`)) return;
      records = records.filter((x) => x.id !== rec.id);
      saveState();
      renderAll();
      toast("已拒绝并删除", "ok");
    });
  });
}

/* ================= 批量操作 ================= */

function approveAll() {
  const pend = records.filter((r) => r.status === "pending");
  if (!pend.length) { toast("没有待审核提交", "err"); return; }
  if (!confirm(`确定全部通过 ${pend.length} 条提交？`)) return;
  pend.forEach((r) => { r.status = "approved"; });
  saveState();
  renderAll();
  toast(`已通过 ${pend.length} 条`, "ok");
}

function rejectAll() {
  const pend = records.filter((r) => r.status === "pending");
  if (!pend.length) { toast("没有待审核提交", "err"); return; }
  if (!confirm(`确定拒绝并删除全部 ${pend.length} 条提交？此操作不可撤销！`)) return;
  const ids = new Set(pend.map((r) => r.id));
  records = records.filter((r) => !ids.has(r.id));
  saveState();
  renderAll();
  toast(`已拒绝 ${pend.length} 条`, "ok");
}

/* ================= 事件 & 启动 ================= */

function bindEvents() {
  $("#login-form").addEventListener("submit", doLogin);
  $("#btn-logout").addEventListener("click", doLogout);
  $("#btn-approve-all").addEventListener("click", approveAll);
  $("#btn-reject-all").addEventListener("click", rejectAll);
  $("#f-keyword").addEventListener("input", renderPending);
  $("#f-series").addEventListener("change", renderPending);
}

async function init() {
  loadState();
  loadAuth();
  // 多设备共享：启动时拉取云端数据（有则覆盖本地）
  const cloud = await pullCloud();
  if (cloud && cloud.records && cloud.records.length) {
    records = cloud.records.map(migrateRecord);
    if (cloud.problems && typeof cloud.problems === "object") problems = cloud.problems;
    saveState();
  }
  bindEvents();
  renderAll();
}

document.addEventListener("DOMContentLoaded", init);
