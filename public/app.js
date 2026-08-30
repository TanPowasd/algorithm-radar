/* 算法雷达站 - 前端逻辑
   数据模型：一条记录 = 一次测试（某 AI 组合做某题），内嵌 submissions 提交列表
   （每次洛谷提交 = {score 得分0-100可空, result 判定, note 说明}）。
   统计区分「首次提交 AC」与「最终提交 AC」两个口径。数据存 localStorage。 */
"use strict";

/* ================= 常量 ================= */

const DIFF_NAMES = ["暂无评定", "入门", "普及−", "普及/提高−", "普及+/提高", "提高+/省选−", "省选/NOI−", "NOI/NOI+/CTSC"];

const RESULTS = ["AC", "WA", "TLE", "MLE", "RE", "CE", "未解出"];

const CATEGORY_ORDER = ["模拟/枚举", "贪心", "二分/分治", "搜索", "动态规划", "图论", "数据结构", "树", "字符串", "数学", "计算几何"];

const SERIES_COLORS = ["#58a6ff", "#3fb950", "#bc8cff", "#f0883e", "#f85149", "#39c5cf", "#d2a8ff", "#7ee787", "#ffa657", "#ff7b72"];

// 思考等级（thinking effort）：不同模型可不同，旧记录默认 max
const THINKING_LEVELS = ["max", "high", "medium", "low", "off"];
const DEFAULT_THINKING = "max";

const LS_RECORDS = "radar.records.v1";
const LS_PROBLEMS = "radar.problems.v1";
const LS_AUTH = "radar.auth.v1";

// 管理员账号（用户名明文，密码仅存 SHA-256 哈希，代码中不含明文密码）
const ADMIN_USERNAME = "TanPowasd";
const ADMIN_PASSWORD_HASH = "ee4e61b4ac9747fca1f4c9b8a64c63279bd296da662e0488f2d8ee2f68045004";

/* ================= 状态 ================= */

let records = [];      // 测试记录数组
let problems = {};     // 题目信息缓存 {pid: {title, difficulty, categories, ...}}
let isAdmin = false;   // 是否管理员登录
let visibleSeries = new Set();
let radarDim = "category";     // category | difficulty
let radarMetric = "first";     // first 首轮提交AC（默认）| final 最终提交AC | avgscore 平均分
let matrixMode = "score";      // score 首轮均分（默认）| finalscore 最终轮均分 | status 提交状态
let radarChart = null;
let tbarChart = null;
let sortState = { key: "date", dir: -1 };
let filters = { series: "", difficulty: "", category: "", result: "", keyword: "", thinking: "" };
let editingId = null;
let formCategories = [];
let formSubs = [];     // 表单中的提交列表 [{score:"", result:"AC", note:""}]
let pendingImport = null;
let cachedScrapedDifficulty = null; // 当前表单题号对应的「洛谷爬取难度」参考值（不自动填充，仅供提示）

/* ================= 工具 ================= */

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function normalizePid(pid) {
  return String(pid || "").trim().toUpperCase();
}

const PID_RE = /^[A-Z]{1,3}_?[A-Z0-9_]{2,20}$/;

function seriesKey(r) {
  return r.variant ? `${r.model} · ${r.variant}` : r.model;
}

function seriesList() {
  return [...new Set(records.map(seriesKey))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function seriesColor(label) {
  const list = seriesList();
  const idx = Math.max(0, list.indexOf(label));
  return SERIES_COLORS[idx % SERIES_COLORS.length];
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

/* ---------- 提交（轮次）相关 ---------- */

function normalizeSub(s) {
  let score = s && s.score != null && s.score !== "" ? Number(s.score) : null;
  if (score != null && (!Number.isFinite(score) || score < 0)) score = 0;
  if (score != null && score > 100) score = 100;
  score = score == null ? null : Math.round(score);
  const result = RESULTS.includes(s && s.result) ? s.result : "未解出";
  return { score, result, note: String((s && s.note) || "").trim() };
}

/** 旧格式记录迁移：补 submissions；思考等级默认 max；审核状态默认已通过（存量数据不丢） */
function migrateRecord(r) {
  if (!Array.isArray(r.submissions) || r.submissions.length === 0) {
    r.submissions = [{ score: r.result === "AC" ? 100 : null, result: r.result || "未解出", note: "" }];
  }
  r.submissions = r.submissions.map(normalizeSub);
  delete r.attempts; // 旧字段：含义由提交列表承接
  if (!THINKING_LEVELS.includes(r.thinking)) r.thinking = DEFAULT_THINKING; // 旧记录默认 max
  if (r.status !== "approved" && r.status !== "pending") r.status = "approved"; // 存量视为已通过
  if (r.author !== "admin" && r.author !== "guest") r.author = "admin";        // 存量视为管理员数据
  return r;
}

const isApproved = (r) => r.status !== "pending";        // 已通过（含存量）
const isPending = (r) => r.status === "pending";         // 待审核
const canEdit = (r) => isAdmin && isApproved(r);         // 管理员可编辑已通过记录
const canDelete = (r) => isAdmin;                        // 仅管理员可删除

const lastSub = (r) => r.submissions[r.submissions.length - 1];
const firstSub = (r) => r.submissions[0];
const isPassed = (r) => lastSub(r).result === "AC";        // 最终提交 AC
const isFirstPassed = (r) => firstSub(r).result === "AC";  // 首轮提交 AC（每次测试的第一轮）
const passedOf = (r) => (radarMetric === "first" ? isFirstPassed(r) : isPassed(r));

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

/* ---------- 存取 ---------- */

/** 云端同步：把 records/problems 推送到共享存储（Vercel /api/sync 代理） */
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

/** 从云端拉取共享数据；未配置/失败时返回 null（前端静默降级为纯本地） */
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

function saveState() {
  try {
    localStorage.setItem(LS_RECORDS, JSON.stringify(records));
    localStorage.setItem(LS_PROBLEMS, JSON.stringify(problems));
  } catch (e) {
    toast("本地保存失败（存储空间不足？）：" + e.message, "err");
  }
  // 本地保存成功后，异步推送到云端（多设备共享）
  pushCloud();
}

function loadState() {
  try { records = JSON.parse(localStorage.getItem(LS_RECORDS) || "[]") || []; } catch { records = []; }
  try { problems = JSON.parse(localStorage.getItem(LS_PROBLEMS) || "{}") || {}; } catch { problems = {}; }
  if (!Array.isArray(records)) records = [];
  records = records.map(migrateRecord);
}

/* ================= 筛选 ================= */

/** 已通过（计入统计）的记录 */
const approvedRecords = () => records.filter(isApproved);

function applyFilters() {
  const kw = filters.keyword.trim().toLowerCase();
  return approvedRecords().filter((r) => {
    if (filters.series && seriesKey(r) !== filters.series) return false;
    if (filters.difficulty !== "" && String(r.difficulty) !== filters.difficulty) return false;
    if (filters.category && !(r.categories || []).includes(filters.category)) return false;
    if (filters.result === "final" && !isPassed(r)) return false;
    if (filters.result === "first" && !isFirstPassed(r)) return false;
    if (filters.result === "fail" && isPassed(r)) return false;
    if (filters.thinking && r.thinking !== filters.thinking) return false;
    if (kw) {
      const hay = `${r.pid} ${r.title || ""} ${r.note || ""} ${r.model} ${r.variant || ""} ${r.thinking || ""} ` +
        r.submissions.map((s) => `${s.score == null ? "" : s.score + "分"} ${s.result} ${s.note}`).join(" ")
      ;
      if (!hay.toLowerCase().includes(kw)) return false;
    }
    return true;
  });
}

/* ================= 雷达图 ================= */

/** 首轮得分：无分数返回 null（不记录），有分数返回分数 */
function firstRoundScore(r) {
  const sc = firstSub(r).score;
  return sc == null ? null : sc;
}

function axisStats(recs) {
  const map = new Map();
  for (const r of recs) {
    const keys = radarDim === "category"
      ? (r.categories && r.categories.length ? r.categories : ["其他/未标注"])
      : [String(r.difficulty == null ? -1 : r.difficulty)];
    const ac = passedOf(r) ? 1 : 0;
    const sc = firstRoundScore(r);
    for (const k of keys) {
      if (!map.has(k)) map.set(k, { label: k, total: 0, ac: 0, scoreSum: 0, scoreCnt: 0 });
      const s = map.get(k);
      s.total += 1;
      s.ac += ac;
      if (sc != null) { s.scoreSum += sc; s.scoreCnt += 1; }
    }
  }
  return map;
}

function radarAxes(recs) {
  const stats = axisStats(recs);
  let keys = [...stats.keys()];
  if (radarDim === "category") {
    keys.sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b, "zh-Hans-CN");
    });
  } else {
    keys.sort((a, b) => Number(a) - Number(b));
  }
  return keys.map((k) => {
    const s = stats.get(k);
    const label = radarDim === "category" ? s.label : DIFF_NAMES[Number(k)] || "未知难度";
    return { key: k, label, total: s.total, ac: s.ac };
  });
}

function renderRadar(recs) {
  const axes = radarAxes(recs);
  const labels = axes.map((a) => a.label);

  const shown = seriesList().filter((s) => visibleSeries.has(s));
  const isAvg = radarMetric === "avgscore";
  const datasets = shown.map((s) => {
    const mine = recs.filter((r) => seriesKey(r) === s);
    const myStats = axisStats(mine);
    const data = axes.map((a) => {
      const st = myStats.get(a.key);
      if (!st || st.total === 0) return null;
      if (isAvg) {
        if (!st.scoreCnt) return null;
        return Math.round((st.scoreSum / st.scoreCnt) * 10) / 10;
      }
      return Math.round((st.ac / st.total) * 1000) / 10;
    });
    const statArr = axes.map((a) => {
      const st = myStats.get(a.key);
      return st
        ? { ac: st.ac, total: st.total, scoreSum: st.scoreSum, scoreCnt: st.scoreCnt }
        : null;
    });
    const color = seriesColor(s);
    return {
      label: s, data, _stats: statArr,
      backgroundColor: color + "22",
      borderColor: color,
      borderWidth: 2,
      pointBackgroundColor: color,
      pointRadius: 3,
      spanGaps: false,
      // 未作答的轴：不画点、不连线（避免 null 被误画到 0 或错位）
      pointHoverRadius: 4,
    };
  });

  if (radarChart) radarChart.destroy();
  const ctx = $("#radar").getContext("2d");
  radarChart = new Chart(ctx, {
    type: "radar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        r: {
          min: 0, max: 100,
          ticks: {
            stepSize: 20,
            callback: (v) => (isAvg ? v + "分" : v + "%"),
            backdropColor: "transparent", color: "#8b949e",
          },
          grid: { color: "rgba(139,148,158,.18)" },
          angleLines: { color: "rgba(139,148,158,.18)" },
          pointLabels: { color: "#c9d1d9", font: { size: 12 } },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const st = c.dataset._stats && c.dataset._stats[c.dataIndex];
              const v = c.parsed.r;
              if (!st) return `${c.dataset.label}：未作答`;
              if (isAvg) {
                if (v == null) return `${c.dataset.label}：无计分数据`;
                return `${c.dataset.label}：均分 ${v} 分（首轮，${st.scoreCnt} 次计分）`;
              }
              const metricName = radarMetric === "first" ? "首轮AC" : "最终AC";
              return `${c.dataset.label}：${v == null ? "未作答" : v + "%"}（${metricName} ${st.ac}/${st.total}）`;
            },
          },
        },
      },
    },
  });

  if (!records.length) {
    $("#radar-hint").textContent = "还没有任何记录——点击右上角「提交记录」开始积累数据。";
  } else {
    const m = radarMetric === "avgscore"
      ? "首轮平均分（无分数的轮次不记录）"
      : `${radarMetric === "first" ? "首轮提交 AC" : "最终提交 AC"} 的测试通过率`;
    const d = radarDim === "category" ? "算法类别（来自洛谷标签自动归类）" : "难度等级（洛谷八档）";
    $("#radar-hint").textContent = `轴值 = ${m}，按${d}分轴；未作答的轴显示为空缺。`;
  }
}

/* ================= 模型 × 思考等级 平均分 柱状图 ================= */

/** 某「模型×思考等级」组合的平均分：该组合所有记录中，有分数轮次的平均（无分数不记录）。
    取整；无分数返回 null。 */
function comboAvg(s, thinking, recs) {
  const mine = recs.filter((r) => seriesKey(r) === s && (r.thinking || DEFAULT_THINKING) === thinking);
  let total = 0, cnt = 0;
  for (const r of mine) {
    for (const sub of r.submissions) {
      if (sub.score == null) continue; // 无分数的不记录
      total += sub.score;
      cnt += 1;
    }
  }
  return cnt ? Math.round(total / cnt) : null;
}

function renderThinkingBar(recs) {
  const wrap = $("#tbar");
  if (!wrap) return;

  if (tbarChart) tbarChart.destroy();

  // 组合 = 出现的模型系列 × 该系列用过的思考等级；只统计有分数数据的
  const combos = [];
  for (const s of seriesList()) {
    if (!visibleSeries.has(s)) continue; // 尊重系列显隐
    const usedT = [...new Set(recs.filter((r) => seriesKey(r) === s).map((r) => r.thinking || DEFAULT_THINKING))];
    for (const t of usedT) {
      const avg = comboAvg(s, t, recs);
      if (avg == null) continue; // 无分数数据不显示
      combos.push({ label: `${s} · ${t}`, series: s, thinking: t, avg });
    }
  }
  // 按平均分从高到低排序
  combos.sort((a, b) => b.avg - a.avg);

  if (!combos.length) {
    $("#tbar-hint").textContent = "暂无数据——先录入带思考等级与分数的记录。";
    return;
  }

  const labels = combos.map((c) => c.label);
  const data = combos.map((c) => c.avg);
  const colors = combos.map((c) => seriesColor(c.series));

  tbarChart = new Chart(wrap.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "平均分",
        data,
        backgroundColor: colors.map((c) => c + "cc"),
        borderColor: colors,
        borderWidth: 1,
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: "#c9d1d9", font: { size: 11 } }, grid: { display: false } },
        y: {
          min: 0, max: 100,
          ticks: { stepSize: 20, callback: (v) => v + "分", color: "#8b949e" },
          grid: { color: "rgba(139,148,158,.18)" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const v = c.parsed.y;
              return `${c.label}：${v} 分`;
            },
          },
        },
      },
    },
  });

  $("#tbar-hint").textContent = "柱长 = 该「模型 × 思考等级」组合所有有分数轮次的平均分（无分数轮次不记录），按平均分从高到低排列。";
}

/* ================= 系列图例 ================= */

function renderSeriesLegend(recs) {
  const wrap = $("#series-legend");
  const list = seriesList();
  if (!list.length) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = list.map((s) => {
    const mine = recs.filter((r) => seriesKey(r) === s);
    // 图例数值与雷达图口径一致：
    // - 平均分模式：所有有分记录的首轮均分
    // - AC 模式：雷达图各轴 AC 率的平均值（未作答轴不计入），与图上点对应
    let rate;
    if (radarMetric === "avgscore") {
      const sums = mine.map(firstRoundScore).filter((x) => x != null);
      rate = sums.length ? Math.round(sums.reduce((a, b) => a + b, 0) / sums.length) + "分" : "–";
    } else {
      const myStats = axisStats(mine);
      let sum = 0, cnt = 0;
      for (const st of myStats.values()) {
        if (st.total > 0) { sum += st.ac / st.total; cnt += 1; }
      }
      rate = cnt ? Math.round((sum / cnt) * 100) + "%" : "–";
    }
    const off = visibleSeries.has(s) ? "" : "off";
    return `<span class="series-chip ${off}" data-series="${escapeHtml(s)}" title="雷达图各轴AC率的平均值（未作答轴不计入）">
      <span class="dot" style="background:${seriesColor(s)}"></span>
      ${escapeHtml(s)} <span class="rate">${rate}</span>
    </span>`;
  }).join("");
  wrap.querySelectorAll(".series-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const s = chip.dataset.series;
      if (visibleSeries.has(s)) visibleSeries.delete(s); else visibleSeries.add(s);
      renderAll();
    });
  });
}

/* ================= 覆盖矩阵 ================= */

function renderMatrix(recs) {
  const wrap = $("#matrix-wrap");
  const pids = [...new Set(recs.map((r) => r.pid))];
  const series = seriesList().filter((s) => recs.some((r) => seriesKey(r) === s));
  const isScoreMode = matrixMode === "score" || matrixMode === "finalscore";

  // 均分模式下列（模型）按「全题目均分」降序排列；无计分数据排最后
  if (isScoreMode) {
    series.sort((a, b) => (seriesOverallAvg(b, recs) ?? -1) - (seriesOverallAvg(a, recs) ?? -1));
    // 行（题目）按「当前口径下有分数轮次的均分」降序排列；无分数排最后
    pids.sort((a, b) => (problemAvg(b, recs) ?? -1) - (problemAvg(a, recs) ?? -1));
  } else {
    pids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  // 均分模式图例提示
  const hintEl = $("#matrix-hint");
  if (matrixMode === "score") {
    hintEl.textContent = "数值 = 该 AI 组合在此题的多次测试中「首轮得分」的平均值（无分数的轮次不记录，不计入均分）。";
    hintEl.hidden = false;
  } else if (matrixMode === "finalscore") {
    hintEl.textContent = "数值 = 该 AI 组合在此题的多次测试中「最终轮得分」的平均值（无分数的轮次不记录，不计入均分）。";
    hintEl.hidden = false;
  } else {
    hintEl.textContent = "";
    hintEl.hidden = true;
  }

  if (!pids.length) {
    wrap.innerHTML = '<p class="muted" style="padding:16px">暂无记录。点击右上角「提交记录」开始。</p>';
    return;
  }

  const pidInfo = {};
  for (const r of recs) {
    if (!pidInfo[r.pid]) pidInfo[r.pid] = { title: r.title, difficulty: r.difficulty };
    else {
      if (!pidInfo[r.pid].title && r.title) pidInfo[r.pid].title = r.title;
      if (pidInfo[r.pid].difficulty == null && r.difficulty != null) pidInfo[r.pid].difficulty = r.difficulty;
    }
  }

  let html = '<table><thead><tr><th>题目</th>';
  for (const s of series) html += `<th title="${escapeHtml(s)}">${escapeHtml(s)}</th>`;
  html += "</tr></thead><tbody>";

  for (const pid of pids) {
    const info = pidInfo[pid] || {};
    const cache = problems[pid] || {};
    const title = info.title || cache.title || "";
    const diff = info.difficulty != null ? info.difficulty : cache.difficulty;
    html += `<tr><td><a class="pid-link" href="https://www.luogu.com.cn/problem/${encodeURIComponent(pid)}" target="_blank" rel="noopener">${escapeHtml(pid)}</a> ${diffTagHtml(diff)}
      ${title ? `<span class="m-title">${escapeHtml(title)}</span>` : ""}</td>`;
    for (const s of series) {
      const rs = recs.filter((r) => r.pid === pid && seriesKey(r) === s);
      if (!rs.length) {
        html += '<td class="mcell none">未做</td>';
        continue;
      }
      if (matrixMode === "score") {
        html += scoreCellHtml(s, pid, rs, "首轮");
        continue;
      }
      if (matrixMode === "finalscore") {
        html += scoreCellHtml(s, pid, rs, "最终轮");
        continue;
      }
      // 多次测试同题：先看通过的，再看最近的
      rs.sort((a, b) => (isPassed(b) - isPassed(a)) || String(b.date).localeCompare(String(a.date)));
      const best = rs[0];
      const fin = lastSub(best);
      const cls = fin.result === "AC" ? "ac" : fin.result === "未解出" ? "giveup" : "fail";
      const n = best.submissions.length;
      const text = (fin.result === "AC" ? "AC" : fin.result) + (n > 1 ? `<span class="cnt">·${n}次</span>` : "");
      const tipLines = best.submissions.map((x, i) =>
        `第${i + 1}次：${x.result}${x.score != null ? " " + x.score + "分" : ""}${x.note ? "（" + x.note + "）" : ""}`);
      const tip = `${s} · ${pid}\n${tipLines.join("\n")}` +
        (best.minutes != null ? `\n总用时：${best.minutes} 分钟` : "") +
        `\n日期：${best.date}` + (best.note ? `\n备注：${best.note}` : "") +
        (rs.length > 1 ? `\n（该组合共 ${rs.length} 次测试，取${isPassed(best) ? "通过" : "最近"}的一次）` : "");
      const cntTests = rs.length > 1 ? ` <span class="cnt">×${rs.length}测</span>` : "";
      html += `<td class="mcell ${cls}" title="${escapeHtml(tip)}">${text}${cntTests}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody>";

  // 底部汇总行：全题目均分（均分模式）或 AC数/题数（提交状态模式）
  html += `<tfoot><tr><th>${isScoreMode ? "全题目均分" : "总计"}</th>`;
  for (const s of series) {
    if (isScoreMode) {
      const avg = seriesOverallAvg(s, recs);
      const tip = `${s}\n全题目均分：${avg == null ? "–" : avg + " 分"}`;
      const cls = avg == null ? "score-na" : avg >= 100 ? "score-100" : avg >= 80 ? "score-hi" : avg >= 60 ? "score-mid" : "score-lo";
      html += `<td class="mcell ${cls}" title="${escapeHtml(tip)}">${avg == null ? "–" : avg + "分"}</td>`;
    } else {
      const mine = recs.filter((r) => seriesKey(r) === s);
      const ac = mine.filter(isPassed).length;
      const tip = `${s}\n通过：${ac} / ${mine.length} 题`;
      html += `<td class="mcell total" title="${escapeHtml(tip)}">${ac}/${mine.length}</td>`;
    }
  }
  html += "</tr></tfoot></table>";
  wrap.innerHTML = html;
}

/* 某模型在当前矩阵口径下的「全题目均分」：该模型所有记录的 submissions 中，
   记了分的提交轮次分数总和 ÷ 记分轮次数（无分数的轮次不计入）。返回取整均分；无记分返回 null。 */
function seriesOverallAvg(s, recs) {
  const mine = recs.filter((r) => seriesKey(r) === s);
  let total = 0, cnt = 0;
  for (const r of mine) {
    for (const sub of r.submissions) {
      if (sub.score == null) continue; // 无分数的不记录
      total += sub.score;
      cnt += 1;
    }
  }
  return cnt ? Math.round(total / cnt) : null;
}

/* 某题在当前矩阵口径下的「有分数轮次均分」：所有模型对该题的所有测试中，
   取对应轮次（score→首轮，finalscore→最终轮）的有分数记录，加总 ÷ 记分轮次数。
   返回取整均分；无记分返回 null。与单元格/排序口径一致。 */
function problemAvg(pid, recs) {
  const rs = recs.filter((r) => r.pid === pid);
  const isFirst = matrixMode === "score";
  let total = 0, cnt = 0;
  for (const r of rs) {
    const sub = isFirst ? firstSub(r) : lastSub(r);
    const sc = sub.score;
    if (sc == null) continue; // 无分数的不记录
    total += sc;
    cnt += 1;
  }
  return cnt ? Math.round(total / cnt) : null;
}

/* 均分单元格：多次测试取指定轮次（首轮/最终轮）得分的平均值（无分数的轮次不记录，不计入均分） */
function scoreCellHtml(s, pid, rs, roundLabel) {
  let sum = 0, cnt = 0;
  const per = [];
  const isFirst = roundLabel === "首轮";
  for (const r of rs) {
    const sub = isFirst ? firstSub(r) : lastSub(r);
    const sc = sub.score;
    if (sc == null) continue; // 无分数的不记录
    sum += sc;
    cnt += 1;
    per.push(sc);
  }
  if (!cnt) {
    return '<td class="mcell score-na" title="' + escapeHtml(`${s} · ${pid}\n该题共 ${rs.length} 次测试，均未记录得分`) + '">–</td>';
  }
  const avg = Math.round(sum / cnt);
  // 满分（100）用特殊金色标记，与 80–99 的绿色区分
  const cls = avg >= 100 ? "score-100" : avg >= 80 ? "score-hi" : avg >= 60 ? "score-mid" : "score-lo";
  const avgLine = `${avg}分`;
  const perLine = per.join("、") + "（分）";
  const cntLine = `${rs.length} 次测试${rs.length === cnt ? "" : `（其中 ${cnt} 次记分）`}`;
  return `<td class="mcell ${cls}" title="${escapeHtml(`${s} · ${pid}\n${roundLabel}均分：${avg} 分（${perLine}，${cntLine}）`)}">${avgLine}</td>`;
}

/* ================= 明细表 ================= */

function renderTable(recs) {
  const wrap = $("#records-wrap");
  if (!recs.length) {
    wrap.innerHTML = '<p class="muted" style="padding:16px">没有符合筛选条件的记录。</p>';
    return;
  }

  const cols = [
    { key: "date", label: "日期" },
    { key: "series", label: "AI 组合" },
    { key: "thinking", label: "思考" },
    { key: "pid", label: "题号" },
    { key: "title", label: "题目" },
    { key: "difficulty", label: "难度" },
    { key: "categories", label: "算法类别" },
    { key: "chain", label: "提交轨迹", nosort: true },
    { key: "subs", label: "次数" },
    { key: "minutes", label: "用时" },
    { key: "note", label: "备注", nosort: true },
  ];

  const sorted = [...recs].sort((a, b) => {
    const k = sortState.key, dir = sortState.dir;
    let va, vb;
    if (k === "series") { va = seriesKey(a); vb = seriesKey(b); }
    else if (k === "categories") { va = (a.categories || []).join(","); vb = (b.categories || []).join(","); }
    else if (k === "subs") { va = a.submissions.length; vb = b.submissions.length; }
    else { va = a[k]; vb = b[k]; }
    if (va == null) va = (typeof vb === "number") ? -Infinity : "";
    if (vb == null) vb = (typeof va === "number") ? -Infinity : "";
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb), "zh-Hans-CN", { numeric: true }) * dir;
  });

  let html = "<table><thead><tr>";
  for (const c of cols) {
    if (c.nosort) { html += `<th>${c.label}</th>`; continue; }
    const arrow = sortState.key === c.key ? (sortState.dir > 0 ? " ▲" : " ▼") : "";
    html += `<th class="sortable" data-key="${c.key}">${c.label}${arrow}</th>`;
  }
  html += "<th>操作</th></tr></thead><tbody>";

  for (const r of sorted) {
    const mins = r.minutes != null && r.minutes !== "" ? r.minutes + " 分钟" : "";
    const cats = (r.categories || []).map((c) => `<span class="cat-tag">${escapeHtml(c)}</span>`).join("");
    const fin = lastSub(r);
    const finTip = `最终：第${r.submissions.length}次提交 ${fin.result}` +
      (isFirstPassed(r) ? "；首轮即 AC" : `；首轮提交 ${firstSub(r).result}`);
    html += `<tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(seriesKey(r))}</td>
      <td><span class="think-tag" title="思考等级">${escapeHtml(r.thinking || DEFAULT_THINKING)}</span></td>
      <td><a class="pid-link" href="https://www.luogu.com.cn/problem/${encodeURIComponent(r.pid)}" target="_blank" rel="noopener">${escapeHtml(r.pid)}</a></td>
      <td>${escapeHtml(r.title || "")}</td>
      <td>${diffTagHtml(r.difficulty)}</td>
      <td>${cats}</td>
      <td><span class="chain" title="${escapeHtml(finTip)}">${chainHtml(r)}</span></td>
      <td>${r.submissions.length}</td>
      <td>${mins}</td>
      <td class="note-cell">${escapeHtml(r.note || "")}</td>
      <td>${isAdmin
        ? `<button class="btn small" data-edit="${r.id}">编辑</button>
           <button class="btn small danger" data-del="${r.id}">删除</button>`
        : '<span class="muted" style="font-size:11px">仅管理员可改</span>'}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  wrap.innerHTML = html;

  wrap.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (sortState.key === k) sortState.dir *= -1;
      else sortState = { key: k, dir: 1 };
      renderAll();
    });
  });
  wrap.querySelectorAll("button[data-edit]").forEach((b) => {
    b.addEventListener("click", () => openModal(Number(b.dataset.edit)));
  });
  wrap.querySelectorAll("button[data-del]").forEach((b) => {
    b.addEventListener("click", () => {
      const id = Number(b.dataset.del);
      const rec = records.find((r) => r.id === id);
      if (!rec) return;
      if (!confirm(`删除测试：${seriesKey(rec)} · ${rec.pid}（含 ${rec.submissions.length} 次提交）？`)) return;
      records = records.filter((r) => r.id !== id);
      saveState(); renderAll();
      toast("已删除", "ok");
    });
  });
}

/* ================= 筛选控件 & 统计 ================= */

function renderFilterOptions() {
  const seriesSel = $("#f-series");
  const cur = filters.series;
  seriesSel.innerHTML = '<option value="">全部 AI 组合</option>' +
    seriesList().map((s) => `<option${s === cur ? " selected" : ""}>${escapeHtml(s)}</option>`).join("");

  const dSel = $("#f-difficulty");
  const curD = filters.difficulty;
  dSel.innerHTML = '<option value="">全部难度</option>' +
    DIFF_NAMES.map((n, i) => `<option value="${i}"${String(i) === curD ? " selected" : ""}>${n}</option>`).join("");

  const cats = [...new Set(records.flatMap((r) => r.categories || []))];
  cats.sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b, "zh-Hans-CN");
  });
  const cSel = $("#f-category");
  const curC = filters.category;
  cSel.innerHTML = '<option value="">全部算法类别</option>' +
    cats.map((c) => `<option${c === curC ? " selected" : ""}>${escapeHtml(c)}</option>`).join("");

  // 思考等级筛选（只显示数据里出现过的等级）
  const tSel = $("#f-thinking-filter");
  const curT = filters.thinking;
  const usedT = [...new Set(records.map((r) => r.thinking).filter(Boolean))];
  tSel.innerHTML = '<option value="">全部思考等级</option>' +
    THINKING_LEVELS.filter((t) => usedT.includes(t)).map((t) => `<option value="${t}"${t === curT ? " selected" : ""}>${t}</option>`).join("");
}

function pctStr(num, den) {
  return den ? Math.round((num / den) * 100) + "%" : "–";
}

function renderStats() {
  const appr = approvedRecords();
  const n = appr.length;
  $("#stat-records").textContent = n;
  $("#stat-series").textContent = seriesList().length;
  $("#stat-problems").textContent = new Set(appr.map((r) => r.pid)).size;
  $("#stat-firstrate").textContent = pctStr(appr.filter(isFirstPassed).length, n);  // 首轮 AC 率
  $("#stat-finalrate").textContent = pctStr(appr.filter(isPassed).length, n);
}

function renderDatalists() {
  $("#dl-models").innerHTML = [...new Set(records.map((r) => r.model))].map((m) => `<option value="${escapeHtml(m)}">`).join("");
  $("#dl-variants").innerHTML = [...new Set(records.map((r) => r.variant).filter(Boolean))].map((m) => `<option value="${escapeHtml(m)}">`).join("");
  const cats = [...new Set([...CATEGORY_ORDER, ...records.flatMap((r) => r.categories || [])])];
  $("#dl-cats").innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}">`).join("");
}

function renderAll() {
  const recs = applyFilters();
  renderStats();
  renderFilterOptions();
  renderDatalists();
  renderSeriesLegend(recs);
  renderRadar(recs);
  renderThinkingBar(recs);
  renderMatrix(recs);
  renderTable(recs);
  renderPending();
  renderAuthUI();
}

/* ================= 管理员 / 审核 ================= */

function saveAuth() {
  try { localStorage.setItem(LS_AUTH, JSON.stringify({ admin: isAdmin })); } catch { /* ignore */ }
}

function loadAuth() {
  try { isAdmin = !!(JSON.parse(localStorage.getItem(LS_AUTH) || "{}").admin); } catch { isAdmin = false; }
}

/** 计算字符串的 SHA-256 十六进制哈希（浏览器原生，无需依赖） */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function doLogin() {
  const user = $("#login-user").value.trim();
  const pass = $("#login-pass").value;
  const hash = await sha256Hex(pass);
  if (user === ADMIN_USERNAME && hash === ADMIN_PASSWORD_HASH) {
    isAdmin = true;
    saveAuth();
    $("#login-modal").hidden = true;
    $("#login-user").value = "";
    $("#login-pass").value = "";
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

function renderAuthUI() {
  $("#btn-login").hidden = isAdmin;
  $("#btn-logout").hidden = !isAdmin;
  $("#btn-export").hidden = !isAdmin;
  $("#btn-import").hidden = !isAdmin;
  $("#btn-admin").hidden = !isAdmin;
}

/** 待审核摘要（仅管理员可见，完整审核在独立审核台 /admin.html） */
function renderPending() {
  const card = $("#pending-card");
  const wrap = $("#pending-wrap");
  if (!isAdmin) { card.hidden = true; return; }
  const pend = records.filter(isPending);
  card.hidden = false;
  $("#pending-count").textContent = pend.length ? `（${pend.length} 条）` : "";
  if (!pend.length) {
    wrap.innerHTML = '<p class="muted" style="padding:16px">暂无待审核提交。</p>';
    return;
  }
  const rows = pend.slice(0, 8).map((r) => `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(seriesKey(r))}</td>
      <td><span class="think-tag">${escapeHtml(r.thinking || DEFAULT_THINKING)}</span></td>
      <td><a class="pid-link" href="https://www.luogu.com.cn/problem/${encodeURIComponent(r.pid)}" target="_blank" rel="noopener">${escapeHtml(r.pid)}</a></td>
      <td>${escapeHtml(r.title || "")}</td>
      <td>${diffTagHtml(r.difficulty)}</td>
    </tr>`).join("");
  wrap.innerHTML = `<table><thead><tr>
      <th>日期</th><th>AI 组合</th><th>思考</th><th>题号</th><th>题目</th><th>难度</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <p class="hint" style="margin-top:10px"><a class="pid-link" href="/admin.html">前往审核台处理全部 ${pend.length} 条待审核提交 →</a></p>`;
}

/* ================= 表单：提交列表编辑器 ================= */

function renderSubRows() {
  const wrap = $("#sub-rows");
  wrap.innerHTML = formSubs.map((s, i) => `
    <div class="sub-row" data-i="${i}">
      <span class="sub-num">第${i + 1}次</span>
      <select data-field="result">
        ${RESULTS.map((x) => `<option value="${x}"${x === s.result ? " selected" : ""}>${x}</option>`).join("")}
      </select>
      <input type="number" data-field="score" min="0" max="100" step="1" placeholder="得分" value="${s.score === "" ? "" : s.score}">
      <input type="text" data-field="note" class="sub-note" placeholder="说明（如：告知得分后修改）" value="${escapeHtml(s.note)}">
      <button type="button" class="sub-del" data-del="${i}" ${formSubs.length <= 1 ? "disabled" : ""} title="删除本次提交">✕</button>
    </div>`).join("");

  wrap.querySelectorAll(".sub-row").forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelectorAll("[data-field]").forEach((el) => {
      const field = el.dataset.field;
      const ev = el.tagName === "SELECT" ? "change" : "input";
      el.addEventListener(ev, () => {
        formSubs[i][field] = field === "score" ? el.value : el.value;
        updateSubSummary();
      });
    });
    row.querySelector("[data-del]").addEventListener("click", () => {
      formSubs.splice(i, 1);
      renderSubRows();
    });
  });
  updateSubSummary();
}

function updateSubSummary() {
  const n = formSubs.length;
  if (!n) { $("#sub-summary").textContent = ""; return; }
  const f = normalizeSub(formSubs[0]);
  const l = normalizeSub(formSubs[n - 1]);
  const fmt = (s) => s.result + (s.score != null ? ` ${s.score}分` : "");
  $("#sub-summary").textContent = `共 ${n} 次提交 · 首次 ${fmt(f)} · 最终 ${fmt(l)}` +
    (l.result === "AC" ? " ✓" : "");
}

function openModal(editId = null) {
  // 游客只能新增（提交后待审核），不能编辑已有记录
  if (editId != null && !isAdmin) { toast("仅管理员可编辑记录", "err"); return; }
  editingId = editId;
  formCategories = [];

  const diffSel = $("#f-difficulty-input");
  diffSel.innerHTML = '<option value="">– 未知 –</option>' +
    DIFF_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join("");

  if (editId != null) {
    const r = records.find((x) => x.id === editId);
    if (!r) return;
    $("#modal-title").textContent = "编辑测试";
    $("#f-model").value = r.model;
    $("#f-variant").value = r.variant || "";
    $("#f-thinking").value = THINKING_LEVELS.includes(r.thinking) ? r.thinking : DEFAULT_THINKING;
    $("#f-pid").value = r.pid;
    $("#f-title").value = r.title || "";
    diffSel.value = r.difficulty == null ? "" : String(r.difficulty);
    $("#f-minutes").value = r.minutes == null ? "" : r.minutes;
    $("#f-date").value = r.date || todayStr();
    $("#f-note").value = r.note || "";
    formCategories = [...(r.categories || [])];
    formSubs = r.submissions.map((s) => ({ score: s.score == null ? "" : s.score, result: s.result, note: s.note }));
  } else {
    $("#modal-title").textContent = "提交测试";
    $("#f-model").value = "";
    $("#f-variant").value = "";
    $("#f-thinking").value = DEFAULT_THINKING; // 新记录默认 max
    $("#f-pid").value = "";
    $("#f-title").value = "";
    diffSel.value = "";
    $("#f-minutes").value = "";
    $("#f-date").value = todayStr();
    $("#f-note").value = "";
    formSubs = [{ score: "", result: "AC", note: "" }];
  }
  renderFormChips();
  renderSubRows();
  $("#fetch-status").textContent = "";
  $("#fetch-status").className = "fetch-status";
  $("#modal").hidden = false;
  $("#f-model").focus();
}

function closeModal() {
  $("#modal").hidden = true;
  editingId = null;
}

function renderFormChips() {
  const wrap = $("#cat-chips");
  wrap.innerHTML = formCategories.length
    ? formCategories.map((c, i) =>
      `<span class="cat-chip">${escapeHtml(c)}<button type="button" data-i="${i}" title="移除">✕</button></span>`).join("")
    : '<span class="muted" style="font-size:12px">暂无类别——可通过「获取题目信息」自动归类，或手动添加</span>';
  wrap.querySelectorAll("button[data-i]").forEach((b) => {
    b.addEventListener("click", () => {
      formCategories.splice(Number(b.dataset.i), 1);
      renderFormChips();
    });
  });
}

async function fetchProblemInfo(force = false) {
  const pid = normalizePid($("#f-pid").value);
  const status = $("#fetch-status");
  if (!pid) { status.textContent = "请先填写题号"; status.className = "fetch-status err"; return; }
  if (!PID_RE.test(pid)) { status.textContent = "题号格式不太对（示例：P1001 / B2001 / CF10A）"; status.className = "fetch-status err"; return; }

  const cached = problems[pid];
  if (cached && !force) {
    fillProblemInfo(cached);
    cachedScrapedDifficulty = cached.manual ? null : (cached.difficulty ?? null);
    status.textContent = `已用本地缓存（${cached.manual ? "手动维护" : "抓取于 " + (cached.fetchedAt || "早前")}）`;
    status.className = "fetch-status ok";
    return;
  }

  status.textContent = "正在从洛谷抓取…";
  status.className = "fetch-status loading";
  try {
    const resp = await fetch(`/api/luogu?pid=${encodeURIComponent(pid)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    // 爬取难度仅作为「参考值」缓存（cachedScrapedDifficulty），不自动填充到表单
    cachedScrapedDifficulty = data.difficulty ?? null;
    problems[pid] = { ...data, manual: false };
    saveState();
    fillProblemInfo(data);
    status.textContent = `抓取成功：${data.title}（洛谷难度：${DIFF_NAMES[data.difficulty] || "未知"}，请自行确认后选择）`;
    status.className = "fetch-status ok";
  } catch (e) {
    status.textContent = "抓取失败：" + e.message + "。可手动填写题目名称/难度/类别后直接保存。";
    status.className = "fetch-status err";
  }
}

function fillProblemInfo(info) {
  // 难度：不自动填充「洛谷爬取值」（不可靠）；仅当本地缓存里有「用户手动选择过」的难度时自动带出
  if (info.title) $("#f-title").value = info.title;
  const cachedManual = info.manual && info.difficulty != null;
  if (cachedManual) $("#f-difficulty-input").value = String(info.difficulty);
  if (Array.isArray(info.categories) && info.categories.length) {
    formCategories = [...new Set([...info.categories])];
    renderFormChips();
  }
}

function saveRecord(e) {
  e.preventDefault();
  const model = $("#f-model").value.trim();
  const variant = $("#f-variant").value.trim();
  const pid = normalizePid($("#f-pid").value);
  const title = $("#f-title").value.trim();
  const diffRaw = $("#f-difficulty-input").value;
  const minutesRaw = $("#f-minutes").value;
  const date = $("#f-date").value || todayStr();
  const note = $("#f-note").value.trim();
  const thinkingRaw = $("#f-thinking").value;
  const thinking = THINKING_LEVELS.includes(thinkingRaw) ? thinkingRaw : DEFAULT_THINKING;

  if (!model) { toast("请填写 AI 名称", "err"); return; }
  if (!pid || !PID_RE.test(pid)) { toast("题号格式不正确（示例：P1001 / B2001 / CF10A）", "err"); return; }
  if (diffRaw === "") { toast("请选择难度（洛谷自动难度不可靠，需手动选择）", "err"); return; }

  const submissions = formSubs.map(normalizeSub);
  if (!submissions.length) { toast("至少需要一次提交记录", "err"); return; }

  // 类别兜底：表单没填但本地缓存里有该题的类别，则沿用缓存（难度已强制手动选择）
  const cachedCats = (problems[pid] && problems[pid].categories) || [];
  const rec = {
    id: editingId != null ? editingId : Date.now(),
    model, variant, pid, title,
    thinking,
    difficulty: Number(diffRaw),
    categories: formCategories.length ? [...formCategories] : [...cachedCats],
    submissions,
    minutes: minutesRaw === "" ? null : Math.max(0, parseInt(minutesRaw, 10) || 0),
    date, note,
    // 权限：管理员保存=已通过；游客新增=待审核；编辑已有记录保留原状态
    status: editingId != null ? (records.find((x) => x.id === editingId) || {}).status : (isAdmin ? "approved" : "pending"),
    author: isAdmin ? "admin" : "guest",
    updatedAt: new Date().toISOString(),
  };

  // 顺手把表单里的题目信息并入缓存（含用户选择的难度，写回缓存供下次自动带出）
  if (title || formCategories.length || problems[pid] && problems[pid].difficulty !== rec.difficulty) {
    const prev = problems[pid] || {};
    problems[pid] = {
      pid,
      title: title || prev.title || "",
      difficulty: rec.difficulty,                     // 用户本次选择的难度写回缓存
      categories: formCategories.length ? [...formCategories] : (prev.categories || []),
      tags: prev.tags || [],
      manual: true,
      fetchedAt: prev.fetchedAt || "",
    };
  }

  if (editingId != null) {
    const idx = records.findIndex((r) => r.id === editingId);
    rec.createdAt = (records[idx] && records[idx].createdAt) || rec.updatedAt;
    records[idx] = rec;
    toast("已更新测试", "ok");
  } else {
    rec.createdAt = rec.updatedAt;
    records.push(rec);
    toast(isAdmin ? `已保存测试（${submissions.length} 次提交）` : "已提交，等待管理员审核", "ok");
  }
  if (!visibleSeries.has(seriesKey(rec))) visibleSeries.add(seriesKey(rec));
  saveState();
  closeModal();
  renderAll();
}

/* ================= 导入 / 导出 ================= */

function exportJson() {
  // 权限：仅管理员可导出 JSON（游客只能提交测评记录）
  if (!isAdmin) { toast("仅管理员可导出 JSON", "err"); return; }
  const payload = {
    app: "算法雷达站",
    version: 2,
    exportedAt: new Date().toISOString(),
    records,
    problems,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `算法雷达站数据_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("已导出 " + records.length + " 条测试记录", "ok");
}

function handleImportFile(file) {
  // 权限：仅管理员可导入 JSON（游客只能提交测评记录）
  if (!isAdmin) { toast("仅管理员可导入 JSON", "err"); return; }
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch {
      toast("文件不是合法 JSON", "err");
      return;
    }
    const recs = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(recs)) {
      toast("文件里没有 records 数组", "err");
      return;
    }
    pendingImport = {
      records: recs.map(migrateRecord),
      problems: (data && typeof data.problems === "object" && data.problems) || {},
    };
    $("#import-desc").textContent =
      `文件包含 ${recs.length} 条测试记录、${Object.keys(pendingImport.problems).length} 个题目缓存。` +
      `当前浏览器中有 ${records.length} 条记录。「合并」按记录 ID 去重后并入；「替换」会清空现有数据后导入。`;
    $("#import-modal").hidden = false;
  };
  reader.readAsText(file, "utf-8");
}

function doImport(mode) {
  if (!pendingImport) return;
  if (mode === "replace") {
    records = [];
  }
  const byId = {};
  for (const r of records) byId[r.id] = r;
  for (const r of pendingImport.records) {
    if (!r || !r.model || !r.pid || !r.submissions) continue; // 跳过不合法行
    byId[r.id != null ? r.id : Date.now() + Math.floor(Math.random() * 1e6)] = r;
  }
  records = Object.values(byId);
  for (const [pid, info] of Object.entries(pendingImport.problems)) {
    if (!problems[pid]) problems[pid] = info;
  }
  saveState();
  $("#import-modal").hidden = true;
  pendingImport = null;
  visibleSeries = new Set(seriesList());
  renderAll();
  toast(`导入完成，现有 ${records.length} 条测试记录`, "ok");
}

/* ================= 事件绑定 & 启动 ================= */

function bindEvents() {
  $("#btn-add").addEventListener("click", () => openModal());
  $("#btn-login").addEventListener("click", () => { $("#login-modal").hidden = false; $("#login-user").focus(); });
  $("#btn-logout").addEventListener("click", doLogout);
  $("#login-close").addEventListener("click", () => { $("#login-modal").hidden = true; });
  $("#login-cancel").addEventListener("click", () => { $("#login-modal").hidden = true; });
  $("#login-modal").addEventListener("click", (e) => { if (e.target === $("#login-modal")) $("#login-modal").hidden = true; });
  $("#login-form").addEventListener("submit", (e) => { e.preventDefault(); doLogin(); });
  $("#modal-close").addEventListener("click", closeModal);
  $("#btn-cancel").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) closeModal(); });
  $("#record-form").addEventListener("submit", saveRecord);

  $("#btn-fetch").addEventListener("click", () => fetchProblemInfo(false));
  // 输入题号后防抖自动抓取（兼容只触发 input 的输入方式）
  let pidFetchTimer = null;
  $("#f-pid").addEventListener("input", (e) => {
    clearTimeout(pidFetchTimer);
    const pid = normalizePid(e.target.value);
    cachedScrapedDifficulty = null;   // 题号变更时清空上一题的洛谷难度参考值
    if (!pid || !PID_RE.test(pid)) return;
    pidFetchTimer = setTimeout(() => {
      if (normalizePid($("#f-pid").value) === pid) fetchProblemInfo(false);
    }, 600);
  });

  $("#btn-add-sub").addEventListener("click", () => {
    formSubs.push({ score: "", result: "WA", note: "" });
    renderSubRows();
  });

  $("#f-cat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = e.target.value.trim();
      if (v && !formCategories.includes(v)) formCategories.push(v);
      e.target.value = "";
      renderFormChips();
    }
  });

  $("#radar-dim").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      radarDim = b.dataset.dim;
      $("#radar-dim").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      renderAll();
    });
  });
  $("#radar-metric").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      radarMetric = b.dataset.metric;
      $("#radar-metric").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      renderAll();
    });
  });

  $("#matrix-mode").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      matrixMode = b.dataset.mode;
      $("#matrix-mode").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      const statusMode = matrixMode === "status";
      $("#matrix-legend-status").hidden = !statusMode;
      $("#matrix-legend-score").hidden = statusMode;
      // 只刷新矩阵，避免无谓重建雷达图（雷达图不受矩阵模式影响）
      renderMatrix(applyFilters());
    });
  });

  $("#f-series").addEventListener("change", (e) => { filters.series = e.target.value; renderAll(); });
  $("#f-difficulty").addEventListener("change", (e) => { filters.difficulty = e.target.value; renderAll(); });
  $("#f-category").addEventListener("change", (e) => { filters.category = e.target.value; renderAll(); });
  $("#f-result").addEventListener("change", (e) => { filters.result = e.target.value; renderAll(); });
  $("#f-thinking-filter").addEventListener("change", (e) => { filters.thinking = e.target.value; renderAll(); });
  $("#f-keyword").addEventListener("input", (e) => { filters.keyword = e.target.value; renderAll(); });
  $("#btn-clear-filter").addEventListener("click", () => {
    filters = { series: "", difficulty: "", category: "", result: "", keyword: "", thinking: "" };
    $("#f-keyword").value = "";
    $("#f-series").value = ""; $("#f-difficulty").value = "";
    $("#f-category").value = ""; $("#f-result").value = "";
    $("#f-thinking-filter").value = "";
    renderAll();
  });

  $("#btn-export").addEventListener("click", exportJson);
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) handleImportFile(e.target.files[0]);
    e.target.value = "";
  });
  $("#import-close").addEventListener("click", () => { $("#import-modal").hidden = true; pendingImport = null; });
  $("#import-cancel").addEventListener("click", () => { $("#import-modal").hidden = true; pendingImport = null; });
  $("#import-merge").addEventListener("click", () => doImport("merge"));
  $("#import-replace").addEventListener("click", () => {
    if (records.length && !confirm(`确定要替换吗？现有 ${records.length} 条记录将被清空。`)) return;
    doImport("replace");
  });
}

async function checkServer() {
  try {
    const resp = await fetch("/api/ping");
    const data = await resp.json();
    if (data.ok) {
      $("#tag-version").textContent = "本地服务已连接（洛谷自动抓取可用）";
    }
  } catch {
    $("#tag-version").textContent = "本地服务未连接——洛谷自动抓取不可用，可在表单中手动填写题目信息";
  }
}

async function init() {
  loadState();
  loadAuth();
  // 多设备共享：启动时尝试从云端拉取（云端有数据则覆盖本地）
  const cloud = await pullCloud();
  if (cloud && cloud.records && cloud.records.length) {
    records = cloud.records.map(migrateRecord);
    if (cloud.problems && typeof cloud.problems === "object") problems = cloud.problems;
    saveState(); // 写回本地
  }
  visibleSeries = new Set(seriesList());
  bindEvents();
  renderAll();
  checkServer();
}

document.addEventListener("DOMContentLoaded", init);
