/* 算法雷达站 - 前端逻辑（v2）
   数据模型：一条记录 = 一次测试（某 AI 组合做某题），内嵌 submissions 提交列表
   （每次洛谷提交 = {score 得分0-100可空, result 判定, note 说明}）。
   统计区分「首次提交 AC」与「最终提交 AC」两个口径。

   v2 架构：权威数据在服务端（store.py），前端只做增量 API 调用；
   登录/审核/导出/导入全部由服务端鉴权（auth.py），前端不持有任何凭据。
   常量与基础工具（$、api、toast、escapeHtml、图表常量等）来自 common.js，
   本文件不再重复声明，避免全局词法冲突。 */
"use strict";

/* ================= 状态 ================= */

let records = [];        // 测试记录数组（服务端快照：游客仅含已通过；管理员含待审核）
let problems = {};       // 题目信息缓存 {pid: {title, difficulty, categories, ...}}
let isAdmin = false;     // 是否管理员（由 /api/session 判定）
let username = "";
let canSetup = false;    // 是否允许初始化管理员（未配置且本机回环）
let configured = true;   // 服务端是否已配置管理员账号
let visibleSeries = new Set();
let radarDim = "category";     // category | difficulty
let radarMetric = "first";     // first 首轮提交AC（默认）| final 最终提交AC | avgscore 平均分
let matrixMode = "score";      // score 首轮均分（默认）| finalscore 最终轮均分 | status 提交状态
let currentView = "matrix";    // matrix 矩阵图（默认）| radar 雷达图 | bar 柱状图
let radarChart = null;
let tbarChart = null;
let sortState = { key: "date", dir: -1 };
let filters = { series: "", difficulty: "", category: "", result: "", keyword: "", thinking: "" };
let editingId = null;
let formCategories = [];
let formSubs = [];       // 表单中的提交列表 [{score:"", result:"AC", note:""}]
let pendingImport = null;
let cachedScrapedDifficulty = null; // 当前表单题号对应的「洛谷爬取难度」参考值（不自动填充，仅供提示）
let serverOffline = false;   // 启动时服务器不可达且无本地缓存（空态文案据此切换）
let tablePage = 1;           // 明细表当前页码
const TABLE_PAGE_SIZE = 50;  // 明细表每页条数
const BAR_MIN_SAMPLES = 5;   // 柱状图显示门槛：组合至少需要的记分样本量
const prevStats = {};        // 统计卡上一次数值（数字滚动动画用）

/* ================= 工具 ================= */

function seriesList() {
  return [...new Set(records.map(seriesKey))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function seriesColor(label) {
  return seriesColorFrom(seriesList(), label);
}

/** 旧格式记录迁移（前端兜底；服务端 store.py 也会做同样清洗） */
function migrateRecord(r) {
  if (!r || typeof r !== "object") return null;
  if (!Array.isArray(r.submissions) || r.submissions.length === 0) {
    r.submissions = [{ score: r.result === "AC" ? 100 : null, result: r.result || "未解出", note: "" }];
  }
  r.submissions = r.submissions.map(normalizeSub);
  delete r.attempts; // 旧字段：含义由提交列表承接
  if (!THINKING_LEVELS.includes(r.thinking)) r.thinking = DEFAULT_THINKING;
  if (r.status !== "approved" && r.status !== "pending") r.status = "approved";
  if (r.author !== "admin" && r.author !== "guest") r.author = "admin";
  return r;
}

/* ---------- 提交（轮次）相关 ---------- */

const passedOf = (r) => (radarMetric === "first" ? isFirstPassed(r) : isPassed(r));

/* ================= 公告栏 ================= */

/* 站点公告：改这里的文字即可（支持简单 HTML 如 <b>/<a>；内容固定在代码里，不含用户输入）。
   显示规则：每天首次打开显示；「今天关闭」后当天不再出现；「本次关闭」仅当前标签页内不再出现（新标签页会再显示）。 */
const ANNOUNCEMENT_HTML = `
  <b>感谢数据提交 🙏</b>
  提交时请填写 <b>Agent</b> 与 <b>Token 来源</b>（官方 API 或套餐请填写「官方」）；版本/策略请留空，谢谢。`;

const LS_NOTICE_DAY = "radar.notice.dismissedDay";       // 「今天关闭」：记录关闭时的日期
const SS_NOTICE_SESSION = "radar.notice.dismissedSession"; // 「本次关闭」：仅当前标签页有效

function noticeDismissed() {
  try {
    if (localStorage.getItem(LS_NOTICE_DAY) === todayStr()) return true;
  } catch { /* 隐私模式下忽略 */ }
  try {
    if (sessionStorage.getItem(SS_NOTICE_SESSION) === "1") return true;
  } catch { /* 隐私模式下忽略 */ }
  return false;
}

function maybeShowNotice() {
  const el = $("#notice");
  if (!el || !ANNOUNCEMENT_HTML.trim() || noticeDismissed()) return;
  $("#notice-body").innerHTML = ANNOUNCEMENT_HTML;
  el.hidden = false;
}

function dismissNotice(scope) {
  try {
    if (scope === "today") localStorage.setItem(LS_NOTICE_DAY, todayStr());
    else sessionStorage.setItem(SS_NOTICE_SESSION, "1");
  } catch { /* 存储不可用时仅隐藏当前页面 */ }
  const el = $("#notice");
  if (el) el.hidden = true;
}

/* ================= 会话 & 数据 ================= */

async function loadSession() {
  const s = await api("/api/session");
  isAdmin = !!s.admin;
  username = s.username || "";
  canSetup = !!s.canSetup;
  configured = !!s.configured;
  return s;
}

/** 从服务端拉取权威数据并渲染；失败时抛错（由 init 兜底到离线缓存） */
async function refreshData() {
  const data = await api("/api/data");
  records = (data.records || []).map(migrateRecord).filter(Boolean);
  problems = (data.problems && typeof data.problems === "object") ? data.problems : {};
  saveCache({ revision: data.revision, records, problems });
  renderAll();
}

function applyPendingVisibility() {
  // 服务端快照已按权限过滤（游客看不到 pending），这里只需根据数据渲染
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
        r.submissions.map((s) => `${s.score == null ? "" : s.score + "分"} ${s.result} ${s.note}`).join(" ");
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
            backdropColor: "transparent", color: cssVar("--muted", "#8b949e"),
          },
          grid: { color: cssVar("--chart-grid", "rgba(139,148,158,.18)") },
          angleLines: { color: cssVar("--chart-grid", "rgba(139,148,158,.18)") },
          pointLabels: { color: cssVar("--text-2", "#c9d1d9"), font: { size: 12 } },
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

/** 某「模型×思考等级」组合的平均分与样本数：该组合所有记录中，有分数轮次的平均
    （无分数不记录）。返回 {avg, count}；无分数返回 null。 */
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
  return cnt ? { avg: Math.round(total / cnt), count: cnt } : null;
}

function renderThinkingBar(recs) {
  const wrap = $("#tbar");
  if (!wrap) return;

  if (tbarChart) tbarChart.destroy();

  // 组合 = 出现的模型系列 × 该系列用过的思考等级；只统计有分数数据、且样本量达到门槛的组合
  const combos = [];
  for (const s of seriesList()) {
    if (!visibleSeries.has(s)) continue; // 尊重系列显隐
    const usedT = [...new Set(recs.filter((r) => seriesKey(r) === s).map((r) => r.thinking || DEFAULT_THINKING))];
    for (const t of usedT) {
      const res = comboAvg(s, t, recs);
      if (res == null) continue; // 无分数数据不显示
      if (res.count < BAR_MIN_SAMPLES) continue; // 样本量不足的组合不显示，避免小样本均值误导
      combos.push({ label: `${s} · ${t}`, series: s, thinking: t, avg: res.avg, count: res.count });
    }
  }
  // 按平均分从高到低排序
  combos.sort((a, b) => b.avg - a.avg);

  if (!combos.length) {
    $("#tbar-hint").textContent = `暂无满足条件的组合——需要同一「模型 × 思考等级」组合下至少 ${BAR_MIN_SAMPLES} 个有分数的轮次。`;
    return;
  }

  const labels = combos.map((c) => c.label);
  const data = combos.map((c) => c.avg);
  const colors = combos.map((c) => seriesColor(c.series));
  const counts = combos.map((c) => c.count);

  // 柱顶标签插件：在每个柱子上方绘制「n=参与数据量」
  const barTopLabel = {
    id: "barTopLabel",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      const ds = chart.data.datasets[0];
      chart.data.labels.forEach((label, i) => {
        const bar = meta.data[i];
        if (!bar || ds.data[i] == null) return;
        const n = ds._counts ? ds._counts[i] : null;
        if (n == null) return;
        ctx.save();
        ctx.font = "600 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = cssVar("--muted", "#8b949e");
        ctx.fillText(`n=${n}`, bar.x, bar.y - 3);
        ctx.restore();
      });
    },
  };

  tbarChart = new Chart(wrap.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "平均分",
        data,
        _counts: counts,
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
        x: { ticks: { color: cssVar("--text-2", "#c9d1d9"), font: { size: 11 } }, grid: { display: false } },
        y: {
          min: 0, max: 100,
          ticks: { stepSize: 20, callback: (v) => v + "分", color: cssVar("--muted", "#8b949e") },
          grid: { color: cssVar("--chart-grid", "rgba(139,148,158,.18)") },
        },
      },
      layout: { padding: { top: 22 } },   // 给柱顶标签留空间
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const v = c.parsed.y;
              const n = c.dataset._counts ? c.dataset._counts[c.dataIndex] : null;
              return `${c.label}：均分 ${v} 分（${n != null ? n + " 个数据参与" : "无数据"}）`;
            },
          },
        },
      },
    },
    plugins: [barTopLabel],
  });

  $("#tbar-hint").textContent = `柱长 = 该「模型 × 思考等级」组合所有有分数轮次的平均分（无分数轮次不记录）；仅显示样本量 n ≥ ${BAR_MIN_SAMPLES} 的组合，柱顶 n = 参与统计的数据量，按平均分从高到低排列。`;
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
    if (serverOffline) {
      wrap.innerHTML = '<div class="empty"><strong>无法连接服务器</strong>若服务正在休眠，首次唤醒约需 30–60 秒；恢复后刷新页面即可。</div>';
    } else if (!records.length) {
      wrap.innerHTML = '<div class="empty"><strong>还没有任何测试记录</strong>录入第一条「AI × 洛谷题目」测试后，这里会生成覆盖矩阵。<br>' +
        '<button type="button" class="btn primary" id="btn-empty-add">＋ 提交第一条记录</button></div>';
      const cta = $("#btn-empty-add");
      if (cta) cta.addEventListener("click", () => openModal());
    } else {
      wrap.innerHTML = '<div class="empty"><strong>没有符合当前筛选条件的记录</strong>试试清空筛选，或切换到其他视图。</div>';
    }
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

  // 汇总行（全题目均分 / 总计）放在第一行：不滚动就能对比各模型的整体水平
  html += `<tr class="sum-row"><th>${isScoreMode ? "全题目均分" : "总计"}</th>`;
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
  html += "</tr>";

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
  html += "</tbody></table>";
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
  $("#records-count").textContent = `共 ${recs.length} 条`;
  if (!recs.length) {
    wrap.innerHTML = serverOffline && !records.length
      ? '<div class="empty"><strong>无法连接服务器</strong>恢复连接并刷新后，这里会显示明细记录。</div>'
      : '<div class="empty"><strong>没有符合筛选条件的记录</strong>试试调整或清空筛选条件。</div>';
    return;
  }

  const cols = [
    { key: "date", label: "日期" },
    { key: "series", label: "AI 组合" },
    { key: "agentToken", label: "Agent / Token" },
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
    else if (k === "agentToken") { va = agentTokenText(a); vb = agentTokenText(b); }
    else if (k === "categories") { va = (a.categories || []).join(","); vb = (b.categories || []).join(","); }
    else if (k === "subs") { va = a.submissions.length; vb = b.submissions.length; }
    else { va = a[k]; vb = b[k]; }
    if (va == null) va = (typeof vb === "number") ? -Infinity : "";
    if (vb == null) vb = (typeof va === "number") ? -Infinity : "";
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb), "zh-Hans-CN", { numeric: true }) * dir;
  });

  // 分页：只渲染当前页，避免大数据量一次性拼出上万行 DOM
  const pages = Math.max(1, Math.ceil(sorted.length / TABLE_PAGE_SIZE));
  if (tablePage > pages) tablePage = pages;
  if (tablePage < 1) tablePage = 1;
  const pageRows = sorted.slice((tablePage - 1) * TABLE_PAGE_SIZE, tablePage * TABLE_PAGE_SIZE);

  let html = "<table><thead><tr>";
  for (const c of cols) {
    if (c.nosort) { html += `<th>${c.label}</th>`; continue; }
    const arrow = sortState.key === c.key ? (sortState.dir > 0 ? " ▲" : " ▼") : "";
    html += `<th class="sortable" data-key="${c.key}">${c.label}${arrow}</th>`;
  }
  html += "<th>操作</th></tr></thead><tbody>";

  for (const r of pageRows) {
    const mins = r.minutes != null && r.minutes !== "" ? r.minutes + " 分钟" : "";
    const cats = (r.categories || []).map((c) => `<span class="cat-tag">${escapeHtml(c)}</span>`).join("");
    const fin = lastSub(r);
    const finTip = `最终：第${r.submissions.length}次提交 ${fin.result}` +
      (isFirstPassed(r) ? "；首轮即 AC" : `；首轮提交 ${firstSub(r).result}`);
    html += `<tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(seriesKey(r))}${r.variant ? ` <span class="muted" title="版本/策略（不参与分组）">· ${escapeHtml(r.variant)}</span>` : ""}</td>
      <td class="agent-cell">${escapeHtml(agentTokenText(r))}</td>
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
        ? `<button class="btn small" data-edit="${escapeHtml(r.id)}">编辑</button>
           <button class="btn small danger" data-del="${escapeHtml(r.id)}">删除</button>`
        : '<span class="muted" style="font-size:11px">仅管理员可改</span>'}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  wrap.innerHTML = html;

  if (pages > 1) {
    const pager = document.createElement("div");
    pager.className = "table-pager";
    pager.innerHTML =
      `<span class="page-info">第 ${tablePage} / ${pages} 页 · 共 ${sorted.length} 条</span>` +
      `<button type="button" class="btn small" data-page="prev"${tablePage <= 1 ? " disabled" : ""}>上一页</button>` +
      `<button type="button" class="btn small" data-page="next"${tablePage >= pages ? " disabled" : ""}>下一页</button>`;
    pager.querySelectorAll("[data-page]").forEach((b) => {
      b.addEventListener("click", () => {
        tablePage += b.dataset.page === "next" ? 1 : -1;
        renderTable(applyFilters());
      });
    });
    wrap.appendChild(pager);
  }

  wrap.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (sortState.key === k) sortState.dir *= -1;
      else sortState = { key: k, dir: 1 };
      renderAll();
    });
  });
  wrap.querySelectorAll("button[data-edit]").forEach((b) => {
    b.addEventListener("click", () => openModal(b.dataset.edit));
  });
  wrap.querySelectorAll("button[data-del]").forEach((b) => {
    b.addEventListener("click", () => deleteRecord(b.dataset.del));
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

/** 统计卡数字滚动动画（尊重系统「减少动态效果」设置；值未变化时直接写入） */
function animateStat(el, to, suffix = "") {
  const from = Object.prototype.hasOwnProperty.call(prevStats, el.id) ? prevStats[el.id] : null;
  prevStats[el.id] = to;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (from == null || from === to || reduced) { el.textContent = to + suffix; return; }
  const t0 = performance.now(), dur = 320;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = p * (2 - p);
    el.textContent = Math.round(from + (to - from) * eased) + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderStats() {
  const appr = approvedRecords();
  const n = appr.length;
  animateStat($("#stat-records"), n);
  animateStat($("#stat-series"), seriesList().length);
  animateStat($("#stat-problems"), new Set(appr.map((r) => r.pid)).size);
  const first = n ? Math.round(appr.filter(isFirstPassed).length / n * 100) : null;
  const final = n ? Math.round(appr.filter(isPassed).length / n * 100) : null;
  if (first == null) { $("#stat-firstrate").textContent = "–"; prevStats["stat-firstrate"] = null; }
  else animateStat($("#stat-firstrate"), first, "%");
  if (final == null) { $("#stat-finalrate").textContent = "–"; prevStats["stat-finalrate"] = null; }
  else animateStat($("#stat-finalrate"), final, "%");
}

function renderDatalists() {
  $("#dl-models").innerHTML = [...new Set(records.map((r) => r.model))].map((m) => `<option value="${escapeHtml(m)}">`).join("");
  $("#dl-variants").innerHTML = [...new Set(records.map((r) => r.variant).filter(Boolean))].map((m) => `<option value="${escapeHtml(m)}">`).join("");
  $("#dl-agents").innerHTML = [...new Set(records.map((r) => r.agent).filter(Boolean))].map((v) => `<option value="${escapeHtml(v)}">`).join("");
  $("#dl-tokens").innerHTML = [...new Set(records.map((r) => r.tokenSource).filter(Boolean))].map((v) => `<option value="${escapeHtml(v)}">`).join("");
  const cats = [...new Set([...CATEGORY_ORDER, ...records.flatMap((r) => r.categories || [])])];
  $("#dl-cats").innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}">`).join("");
}

function switchView(view) {
  if (!["matrix", "radar", "bar"].includes(view)) view = "matrix";
  currentView = view;
  document.querySelectorAll(".view-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
    b.setAttribute("aria-selected", b.dataset.view === view ? "true" : "false");
  });
  document.querySelectorAll(".view-panel").forEach((p) => {
    p.hidden = p.dataset.view !== view;
  });
  // Chart.js 在隐藏容器中尺寸为 0，切回可见视图时重建图表以保证正确渲染
  if (view === "radar") {
    if (radarChart) { radarChart.destroy(); radarChart = null; }
    const recs = applyFilters();
    renderSeriesLegend(recs);
    renderRadar(recs);
  } else if (view === "bar") {
    if (tbarChart) { tbarChart.destroy(); tbarChart = null; }
    renderThinkingBar(applyFilters());
  } else {
    renderMatrix(applyFilters());
  }
}

function renderAll() {
  tablePage = 1;   // 数据或筛选变化后回到第一页
  const recs = applyFilters();
  renderStats();
  renderFilterOptions();
  renderDatalists();
  renderTable(recs);
  renderPending();
  renderAuthUI();
  // 只重绘当前可见视图的图表：隐藏容器里的 Chart.js 尺寸为 0，重建无意义还拖慢每次筛选
  if (currentView === "radar") {
    renderSeriesLegend(recs);
    renderRadar(recs);
  } else if (currentView === "bar") {
    renderThinkingBar(recs);
  } else {
    renderMatrix(recs);
  }
}

/* ================= 管理员 / 审核 ================= */

/** 按钮忙态：禁用并替换文字，防止等待响应期间连点造成重复提交 */
function setBtnBusy(btn, busy, busyText = "") {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
}

async function doLogin() {
  const user = $("#login-user").value.trim();
  const pass = $("#login-pass").value;
  if (!user || !pass) { toast("请输入用户名与口令", "err"); return; }
  const btn = $("#btn-login-submit");
  if (btn.disabled) return;
  setBtnBusy(btn, true, "登录中…");
  try {
    await api("/api/login", { method: "POST", body: { username: user, password: pass } });
    $("#login-modal").hidden = true;
    $("#login-user").value = "";
    $("#login-pass").value = "";
    toast("已登录为管理员", "ok");
    await loadSession();
    await refreshData();
  } catch (e) {
    toast(e.message || "登录失败", "err");
  } finally {
    setBtnBusy(btn, false);
  }
}

async function doLogout() {
  try { await api("/api/logout", { method: "POST" }); } catch { /* 服务端不可达也继续本地登出 */ }
  isAdmin = false;
  username = "";
  toast("已退出登录", "ok");
  renderAll();
  await refreshData().catch(() => {});
}

async function doSetup() {
  const user = $("#setup-user").value.trim();
  const pass = $("#setup-pass").value;
  const pass2 = $("#setup-pass2").value;
  if (!user) { toast("请填写用户名", "err"); return; }
  if (pass.length < 8) { toast("口令至少需要 8 个字符", "err"); return; }
  if (pass !== pass2) { toast("两次输入的口令不一致", "err"); return; }
  const btn = $("#btn-setup-submit");
  if (btn.disabled) return;
  setBtnBusy(btn, true, "创建中…");
  try {
    await api("/api/setup", { method: "POST", body: { username: user, password: pass } });
    $("#setup-modal").hidden = true;
    toast("管理员账号已创建并登录", "ok");
    await loadSession();
    await refreshData();
  } catch (e) {
    toast(e.message || "初始化失败", "err");
  } finally {
    setBtnBusy(btn, false);
  }
}

function renderAuthUI() {
  $("#who-text").textContent = isAdmin ? (username || "管理员") : "游客";
  $("#who").classList.toggle("is-admin", isAdmin);
  $("#btn-login").hidden = isAdmin || !configured;
  $("#btn-setup").hidden = !canSetup;
  $("#btn-logout").hidden = !isAdmin;
  $("#btn-export").hidden = !isAdmin;
  $("#btn-import").hidden = !isAdmin;
  $("#btn-admin").hidden = !isAdmin;
  $("#btn-migrate").hidden = !isAdmin;
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
    <p class="hint"><a class="pid-link" href="/admin.html">前往审核台处理全部 ${pend.length} 条待审核提交 →</a></p>`;
}

/* ================= 记录操作（服务端 API） ================= */

async function deleteRecord(id) {
  const rec = records.find((r) => r.id === id);
  if (!rec) return;
  if (!confirm(`删除测试：${seriesKey(rec)} · ${rec.pid}（含 ${rec.submissions.length} 次提交）？`)) return;
  try {
    await api(`/api/records/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("已删除", "ok");
    await refreshData();
  } catch (e) {
    toast(e.message || "删除失败", "err");
  }
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
        formSubs[i][field] = el.value;
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
    $("#f-agent").value = r.agent || "";
    $("#f-token-source").value = r.tokenSource || "";
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
    $("#f-agent").value = "";
    $("#f-token-source").value = "";
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
    const data = await api(`/api/luogu?pid=${encodeURIComponent(pid)}`);
    // 爬取难度仅作为「参考值」缓存（cachedScrapedDifficulty），不自动填充到表单
    cachedScrapedDifficulty = data.difficulty ?? null;
    problems[pid] = { ...data, manual: false };
    fillProblemInfo(data);
    status.textContent = `抓取成功：${data.title}（洛谷难度：${DIFF_NAMES[data.difficulty] || "未知"}，请自行确认后选择）`;
    status.className = "fetch-status ok";
  } catch (e) {
    status.textContent = "抓取失败：" + (e.message || e) + "。可手动填写题目名称/难度/类别后直接保存。";
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

async function saveRecord(e) {
  e.preventDefault();
  const btn = $("#btn-save");
  if (btn.disabled) return;   // 请求进行中，忽略重复提交
  const model = $("#f-model").value.trim();
  const variant = $("#f-variant").value.trim();
  const agent = $("#f-agent").value.trim();
  const tokenSource = $("#f-token-source").value.trim();
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
  const payload = {
    model, variant, pid, title,
    thinking,
    agent, tokenSource,
    difficulty: Number(diffRaw),
    categories: formCategories.length ? [...formCategories] : [...cachedCats],
    submissions,
    minutes: minutesRaw === "" ? null : Math.max(0, parseInt(minutesRaw, 10) || 0),
    date, note,
  };

  setBtnBusy(btn, true, "保存中…");
  try {
    let message = "";
    if (editingId != null) {
      await api(`/api/records/${encodeURIComponent(editingId)}`, { method: "PUT", body: { record: payload } });
      message = "已更新测试";
    } else {
      const res = await api("/api/records", { method: "POST", body: { record: payload } });
      message = (res && res.message) || (isAdmin ? "已保存测试" : "已提交，等待管理员审核");
    }
    toast(message, "ok");
    closeModal();
    await refreshData();
    // 新记录加入系列显隐
    if (!visibleSeries.has(seriesKey({ model, variant }))) visibleSeries.add(seriesKey({ model, variant }));
  } catch (err) {
    toast((err && err.message) || "保存失败", "err");
  } finally {
    setBtnBusy(btn, false);
  }
}

/* ================= 导入 / 导出 / 旧数据迁移 ================= */

async function exportJson() {
  try {
    const data = await api("/api/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `算法雷达站数据_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已导出 " + (data.records || []).length + " 条测试记录", "ok");
  } catch (e) {
    toast((e && e.message) || "导出失败", "err");
  }
}

function handleImportFile(file) {
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
      records: recs.map(migrateRecord).filter(Boolean),
      problems: (data && typeof data.problems === "object" && data.problems) || {},
    };
    $("#import-desc").textContent =
      `文件包含 ${recs.length} 条测试记录、${Object.keys(pendingImport.problems).length} 个题目缓存。` +
      `当前服务器有 ${records.length} 条记录。「合并」按记录 ID 去重后并入；「替换」会清空现有数据后导入。`;
    $("#import-modal").hidden = false;
  };
  reader.readAsText(file, "utf-8");
}

async function doImport(mode) {
  if (!pendingImport) return;
  try {
    const res = await api("/api/import", { method: "POST", body: { mode, data: pendingImport } });
    $("#import-modal").hidden = true;
    pendingImport = null;
    toast(`导入完成，共 ${(res && res.imported) || 0} 条记录`, "ok");
    visibleSeries = new Set(seriesList());
    await refreshData();
  } catch (e) {
    toast((e && e.message) || "导入失败", "err");
  }
}

/** 从旧版前端（localStorage radar.records.v1）迁移数据到服务端（合并模式） */
async function migrateLegacy() {
  let legacyRecords = [], legacyProblems = {};
  try { legacyRecords = JSON.parse(localStorage.getItem("radar.records.v1") || "[]") || []; } catch { legacyRecords = []; }
  try { legacyProblems = JSON.parse(localStorage.getItem("radar.problems.v1") || "{}") || {}; } catch { legacyProblems = {}; }
  if (!Array.isArray(legacyRecords)) legacyRecords = [];
  const recs = legacyRecords.map(migrateRecord).filter(Boolean);
  if (!recs.length) { toast("没有找到旧版本地数据（radar.records.v1）", "err"); return; }
  if (!confirm(`将旧版浏览器本地数据导入服务器（合并模式，按记录 ID 去重）：\n${recs.length} 条记录、${Object.keys(legacyProblems).length} 个题目缓存。\n确定导入？`)) return;
  try {
    const res = await api("/api/import", {
      method: "POST",
      body: { mode: "merge", data: { records: recs, problems: legacyProblems } },
    });
    toast(`迁移完成，导入 ${(res && res.imported) || 0} 条记录`, "ok");
    visibleSeries = new Set(seriesList());
    await refreshData();
  } catch (e) {
    toast("迁移失败：" + ((e && e.message) || e), "err");
  }
}

/* ================= 连接状态 ================= */

async function checkServer() {
  const conn = $("#conn");
  const connText = $("#conn-text");
  try {
    await api("/api/ping");
    conn.classList.add("ok");
    conn.classList.remove("bad");
    connText.textContent = "服务已连接 · 洛谷抓取可用";
  } catch {
    conn.classList.add("bad");
    conn.classList.remove("ok");
    connText.textContent = "服务器未连接（离线只读缓存）";
  }
}

/* ================= 事件绑定 & 启动 ================= */

function bindEvents() {
  // 主题切换后重建图表：Chart.js 的颜色在构造时读取，需跟随 CSS 变量重新取值
  document.addEventListener("themechange", () => renderAll());
  // 公告栏两种关闭方式
  $("#notice-hide-session").addEventListener("click", () => dismissNotice("session"));
  $("#notice-hide-today").addEventListener("click", () => dismissNotice("today"));
  document.querySelectorAll(".view-tab").forEach((b) => {
    b.addEventListener("click", () => switchView(b.dataset.view));
  });
  $("#btn-add").addEventListener("click", () => openModal());
  $("#btn-login").addEventListener("click", () => { $("#login-modal").hidden = false; $("#login-user").focus(); });
  $("#btn-setup").addEventListener("click", () => { $("#setup-modal").hidden = false; $("#setup-user").focus(); });
  $("#btn-logout").addEventListener("click", doLogout);
  $("#login-close").addEventListener("click", () => { $("#login-modal").hidden = true; });
  $("#login-cancel").addEventListener("click", () => { $("#login-modal").hidden = true; });
  $("#login-modal").addEventListener("click", (e) => { if (e.target === $("#login-modal")) $("#login-modal").hidden = true; });
  $("#login-form").addEventListener("submit", (e) => { e.preventDefault(); doLogin(); });
  $("#setup-close").addEventListener("click", () => { $("#setup-modal").hidden = true; });
  $("#setup-cancel").addEventListener("click", () => { $("#setup-modal").hidden = true; });
  $("#setup-modal").addEventListener("click", (e) => { if (e.target === $("#setup-modal")) $("#setup-modal").hidden = true; });
  $("#setup-form").addEventListener("submit", (e) => { e.preventDefault(); doSetup(); });
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
  // 关键字输入防抖：每敲一个字不必全量重渲
  let kwTimer = null;
  $("#f-keyword").addEventListener("input", (e) => {
    filters.keyword = e.target.value;
    clearTimeout(kwTimer);
    kwTimer = setTimeout(renderAll, 250);
  });
  $("#btn-clear-filter").addEventListener("click", () => {
    clearTimeout(kwTimer);
    filters = { series: "", difficulty: "", category: "", result: "", keyword: "", thinking: "" };
    $("#f-keyword").value = "";
    $("#f-series").value = ""; $("#f-difficulty").value = "";
    $("#f-category").value = ""; $("#f-result").value = "";
    $("#f-thinking-filter").value = "";
    renderAll();
  });

  $("#btn-export").addEventListener("click", exportJson);
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#btn-migrate").addEventListener("click", migrateLegacy);
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

async function init() {
  initTheme();
  bindEvents();
  renderAuthUI();
  maybeShowNotice();

  try {
    await loadSession();
  } catch { /* 服务器不可达时保持游客态 */ }
  renderAuthUI();

  try {
    await refreshData();
  } catch (e) {
    // 离线兜底：展示本地只读缓存；连缓存都没有则标记离线，空态里给出提示
    const cache = loadCache();
    if (cache) {
      records = (cache.records || []).map(migrateRecord).filter(Boolean);
      problems = (cache.problems && typeof cache.problems === "object") ? cache.problems : {};
      renderAll();
      toast("无法连接服务器，正在显示本地缓存（只读）", "err");
    } else {
      serverOffline = true;
      $("#boot-title").textContent = "无法连接服务器";
    }
  }
  $("#boot-loading").hidden = true;   // 无论成功、缓存兜底还是离线，都撤掉首屏加载提示
  visibleSeries = new Set(seriesList());
  renderAll();   // 填充系列后重绘，确保雷达图/柱状图首次加载即显示
  switchView("matrix");   // 默认显示矩阵图
  checkServer();
}

document.addEventListener("DOMContentLoaded", init);
