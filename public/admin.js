/* 算法雷达站 - 审核台（管理员专用页面，v2）
   独立于主页 app.js。数据与权限全部由服务端提供：
     - /api/session 判定登录态（HttpOnly Cookie 会话，前端无凭据）
     - /api/data 拉取含待审核记录的完整快照（仅管理员可见 pending）
     - /api/records/<id>/status 单个审核
     - /api/records/bulk 批量通过 / 拒绝
   常量与基础工具（$、api、toast、escapeHtml、系列工具等）来自 common.js。 */
"use strict";

/* ================= 状态 ================= */

let records = [];
let problems = {};
let isAdmin = false;
let username = "";
let configured = false;
let canSetup = false;
let keyword = "";
let seriesFilter = "";

/* ================= 工具 ================= */

function seriesList() {
  return [...new Set(records.map(seriesKey))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function migrateRecord(r) {
  if (!r || typeof r !== "object") return null;
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

/* ================= 数据 & 会话 ================= */

async function loadSession() {
  const s = await api("/api/session");
  isAdmin = !!s.admin;
  username = s.username || "";
  configured = !!s.configured;
  canSetup = !!s.canSetup;
  return s;
}

async function refreshData() {
  const data = await api("/api/data");
  records = (data.records || []).map(migrateRecord).filter(Boolean);
  problems = (data.problems && typeof data.problems === "object") ? data.problems : {};
}

async function doLogin(e) {
  e.preventDefault();
  const user = $("#login-user").value.trim();
  const pass = $("#login-pass").value;
  if (!user || !pass) { toast("请输入用户名与口令", "err"); return; }
  try {
    await api("/api/login", { method: "POST", body: { username: user, password: pass } });
    toast("已登录为管理员", "ok");
    await initApp();
  } catch (err) {
    toast((err && err.message) || "登录失败", "err");
  }
}

async function doLogout() {
  try { await api("/api/logout", { method: "POST" }); } catch { /* ignore */ }
  isAdmin = false;
  username = "";
  toast("已退出登录", "ok");
  renderAll();
}

/* ================= 渲染 ================= */

function renderAll() {
  const gate = $("#login-gate");
  const work = $("#work-area");
  $("#btn-setup").hidden = !canSetup;
  if (!isAdmin) {
    gate.hidden = false;
    work.hidden = true;
    $("#btn-logout").hidden = true;
    $("#who-text").textContent = "未登录";
    $("#who").classList.remove("is-admin");
    $("#gate-note").hidden = configured || canSetup;
    return;
  }
  gate.hidden = true;
  work.hidden = false;
  $("#btn-logout").hidden = false;
  $("#who-text").textContent = username || "管理员";
  $("#who").classList.add("is-admin");
  renderSummary();
  renderFilterSeries();
  renderPending();
  renderProblems();
}

/* ================= 题目管理 ================= */

function renderProblems() {
  const wrap = $("#problems-wrap");
  const pids = sortedProblemPids(problems);
  if (!pids.length) {
    wrap.innerHTML = '<p class="empty-tip">还没有发布题目——点右上角「发布新题」从洛谷抓取并发布第一道题。</p>';
    return;
  }
  const rows = pids.map((pid) => {
    const info = problems[pid] || {};
    const cnt = records.filter((r) => r.pid === pid).length;
    return `<tr>
      <td><a class="pid-link" href="https://www.luogu.com.cn/problem/${encodeURIComponent(pid)}" target="_blank" rel="noopener">${escapeHtml(pid)}</a></td>
      <td>${escapeHtml(info.title || "")}</td>
      <td>${diffTagHtml(info.difficulty)}</td>
      <td>${(info.categories || []).map((c) => `<span class="cat-tag">${escapeHtml(c)}</span>`).join("")}</td>
      <td class="num">${cnt}</td>
      <td><button class="btn small danger" data-del-problem="${escapeHtml(pid)}" ${cnt ? "disabled title=\"先删除该题的全部测试记录\"" : ""}>删除</button></td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `<table><thead><tr>
      <th>题号</th><th>题目</th><th>难度</th><th>算法类别</th><th>记录数</th><th>操作</th>
    </tr></thead><tbody>${rows}</tbody></table>`;

  wrap.querySelectorAll("button[data-del-problem]").forEach((b) => {
    b.addEventListener("click", () => deleteProblem(b.dataset.delProblem));
  });
}

async function deleteProblem(pid) {
  if (!confirm(`删除题目 ${pid}？该操作不可恢复（不影响已有测试记录以外的数据）。`)) return;
  try {
    await api(`/api/problems/${encodeURIComponent(pid)}`, { method: "DELETE" });
    toast(`已删除题目 ${pid}`, "ok");
    await refreshData();
    renderAll();
  } catch (e) {
    toast((e && e.message) || "删除失败", "err");
  }
}

function renderSummary() {
  const pend = records.filter((r) => r.status === "pending");
  const today = new Date().toISOString().slice(0, 10);
  const todayCnt = records.filter((r) => String(r.date).startsWith(today)).length;
  const guestCnt = records.filter((r) => r.author === "guest").length;
  const approvedCnt = records.filter((r) => r.status === "approved").length;
  $("#stat-pending").textContent = pend.length;
  $("#stat-today").textContent = todayCnt;
  $("#stat-guest").textContent = guestCnt;
  $("#stat-approved").textContent = approvedCnt;
}

function renderFilterSeries() {
  const sel = $("#f-series");
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部 AI 组合</option>' +
    seriesList().map((s) => `<option${s === cur ? " selected" : ""}>${escapeHtml(s)}</option>`).join("");
}

function renderPending() {
  const wrap = $("#pending-wrap");
  const kw = keyword.trim().toLowerCase();
  const pend = records.filter((r) => r.status === "pending")
    .filter((r) => !seriesFilter || seriesKey(r) === seriesFilter)
    .filter((r) => !kw ||
      `${r.model} ${r.variant || ""} ${r.agent || ""} ${r.tokenSource || ""} ${r.pid} ${r.title || ""} ${r.note || ""}`.toLowerCase().includes(kw))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.id - a.id));

  if (!pend.length) {
    wrap.innerHTML = '<p class="empty-tip">没有符合条件的待审核提交 🎉</p>';
    return;
  }

  const rows = pend.map((r) => `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(seriesKey(r))}${r.variant ? ` <span class="muted">· ${escapeHtml(r.variant)}</span>` : ""}</td>
      <td class="agent-cell">${escapeHtml(agentTokenText(r))}</td>
      <td><span class="think-tag">${escapeHtml(r.thinking || DEFAULT_THINKING)}</span></td>
      <td><a class="pid-link" href="https://www.luogu.com.cn/problem/${encodeURIComponent(r.pid)}" target="_blank" rel="noopener">${escapeHtml(r.pid)}</a></td>
      <td>${escapeHtml(r.title || "")}</td>
      <td>${diffTagHtml(r.difficulty)}</td>
      <td><span class="sub-chain">${chainHtml(r)}</span></td>
      <td class="note-cell">${escapeHtml(r.note || "")}</td>
      <td>
        <div class="review-actions">
          <button class="btn small" data-approve="${escapeHtml(r.id)}">通过</button>
          <button class="btn small danger" data-reject="${escapeHtml(r.id)}">拒绝</button>
        </div>
      </td>
    </tr>`).join("");

  wrap.innerHTML = `<table class="review-table"><thead><tr>
      <th>日期</th><th>AI 组合</th><th>Agent / Token</th><th>思考</th><th>题号</th><th>题目</th><th>难度</th><th>提交轨迹</th><th>备注</th><th>操作</th>
    </tr></thead><tbody>${rows}</tbody></table>`;

  wrap.querySelectorAll("button[data-approve]").forEach((b) => {
    b.addEventListener("click", () => setStatus(b.dataset.approve, "approved"));
  });
  wrap.querySelectorAll("button[data-reject]").forEach((b) => {
    b.addEventListener("click", () => rejectOne(b.dataset.reject));
  });
}

/* ================= 审核操作（服务端 API） ================= */

async function setStatus(id, status) {
  const rec = records.find((x) => x.id === id);
  if (!rec) return;
  try {
    await api(`/api/records/${encodeURIComponent(id)}/status`, {
      method: "POST",
      body: { status },
    });
    toast("已通过，计入统计", "ok");
    await refreshData();
    renderAll();
  } catch (e) {
    toast((e && e.message) || "操作失败", "err");
  }
}

async function rejectOne(id) {
  const rec = records.find((x) => x.id === id);
  if (!rec) return;
  if (!confirm(`拒绝并删除：${seriesKey(rec)} · ${rec.pid}？`)) return;
  try {
    await api(`/api/records/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("已拒绝并删除", "ok");
    await refreshData();
    renderAll();
  } catch (e) {
    toast((e && e.message) || "操作失败", "err");
  }
}

async function approveAll() {
  const pend = records.filter((r) => r.status === "pending");
  if (!pend.length) { toast("没有待审核提交", "err"); return; }
  if (!confirm(`确定全部通过 ${pend.length} 条提交？`)) return;
  try {
    const res = await api("/api/records/bulk", {
      method: "POST",
      body: { ids: pend.map((r) => r.id), action: "approve" },
    });
    toast(`已通过 ${(res && res.affected) || 0} 条`, "ok");
    await refreshData();
    renderAll();
  } catch (e) {
    toast((e && e.message) || "操作失败", "err");
  }
}

async function rejectAll() {
  const pend = records.filter((r) => r.status === "pending");
  if (!pend.length) { toast("没有待审核提交", "err"); return; }
  if (!confirm(`确定拒绝并删除全部 ${pend.length} 条提交？此操作不可撤销！`)) return;
  try {
    const res = await api("/api/records/bulk", {
      method: "POST",
      body: { ids: pend.map((r) => r.id), action: "reject" },
    });
    toast(`已拒绝 ${(res && res.affected) || 0} 条`, "ok");
    await refreshData();
    renderAll();
  } catch (e) {
    toast((e && e.message) || "操作失败", "err");
  }
}

/* ================= 事件 & 启动 ================= */

function bindEvents() {
  $("#login-form").addEventListener("submit", doLogin);
  $("#btn-logout").addEventListener("click", doLogout);
  $("#btn-setup").addEventListener("click", () => {
    if (!canSetup) { toast("初始化仅可在服务器本机且未配置时进行", "err"); return; }
    location.href = "/";
  });
  $("#btn-refresh").addEventListener("click", async () => {
    try { await refreshData(); renderAll(); toast("已刷新", "ok"); }
    catch (e) { toast((e && e.message) || "刷新失败", "err"); }
  });
  $("#btn-approve-all").addEventListener("click", approveAll);
  $("#btn-reject-all").addEventListener("click", rejectAll);
  $("#f-keyword").addEventListener("input", (e) => { keyword = e.target.value; renderPending(); });
  $("#f-series").addEventListener("change", (e) => { seriesFilter = e.target.value; renderPending(); });
  // 发布新题成功（common.js 广播）后刷新目录与列表
  document.addEventListener("problemschanged", async () => {
    try { await refreshData(); renderAll(); } catch { /* ignore */ }
  });
}

async function initApp() {
  bindEvents();
  try {
    await loadSession();
  } catch { /* 服务器不可达时保持未登录 */ }
  try {
    await refreshData();
  } catch (e) {
    toast((e && e.message) || "无法连接服务器", "err");
  }
  renderAll();
}

document.addEventListener("DOMContentLoaded", () => initApp());
