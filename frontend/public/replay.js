/* 由 sync_web_player.py 从 viz/player.html 生成；源文件 sha256=e7d17bba4222fbb6f5282ecf22d50c2be20f1c23490717f9f11cc283ae920bf2；请勿直接改 */
"use strict";
/* ---------------- 数据解码：与 engine/replay.py::decode_frames 保持一致 ---------------- */
function decodeReplay(rep){
  var meta = rep.meta || {}, cfg = meta.cfg || {};
  var turns = Math.max(1, Number(cfg.turnsPerDay) || 24);
  var tiles = [null,null], extra = [null,null];
  var town = [], prices = [], mktInv = [], dead = [false,false];
  var rows = [{shed:{},seeds:{},inv:[]},{shed:{},seeds:{},inv:[]}];
  var out = [];
  var frames = rep.frames || [];
  for (var fi=0; fi<frames.length; fi++){
    var f = frames[fi];
    if ("town" in f) town = f.town;
    if (f.mkt){ if (f.mkt.prices) prices = f.mkt.prices; if (f.mkt.inv) mktInv = f.mkt.inv; }
    if ("dead" in f) dead = f.dead;
    var patch = f.patch, xpatch = f.xpatch, cur = [];
    for (var i=0;i<f.p.length;i++){
      var src = f.p[i];
      if (!patch){
        tiles[i] = String(src.tiles || "").split("");
        extra[i] = {};
        var ex = src.extra || {};
        for (var k in ex) extra[i][parseInt(k,10)] = ex[k];
      } else {
        if (patch[i]){
          var codes = (tiles[i] || []).slice();
          for (var k2 in patch[i]) codes[parseInt(k2,10)] = patch[i][k2];
          tiles[i] = codes;
        }
        if (xpatch && xpatch[i]){
          var exx = {};
          for (var kk in (extra[i]||{})) exx[kk] = extra[i][kk];
          var px = xpatch[i];
          for (var k3 in px){
            if (px[k3] === null) delete exx[parseInt(k3,10)];
            else exx[parseInt(k3,10)] = px[k3];
          }
          extra[i] = exx;
        }
      }
      for (var r=0;r<3;r++){
        var key = ["shed","seeds","inv"][r];
        if (key in src) rows[i][key] = src[key];
      }
      cur.push({pos:src.pos, hands:src.hands||[], money:src.money,
                tiles:(tiles[i]||[]).join(""), extra:extra[i]||{},
                shed:rows[i].shed, seeds:rows[i].seeds, inv:rows[i].inv});
    }
    var t = f.t|0;
    out.push({t:t, day:Math.floor(t/turns), hour:t%turns, p:cur,
              mkt:{prices:prices, inv:mktInv}, town:town,
              act:f.act||{}, dead:dead});
  }
  return out;
}

/* ---------------- 渲染辅助 ---------------- */
var CROP_COLOR = {WHEAT:"#d9b44a",CARROT:"#e07b39",TOMATO:"#e04f4f",STRAWBERRY:"#d94f8a",MELON:"#7ac74f"};
var ANIMAL_GLYPH = {GOOSE:"🦢",COW:"🐄",SHEEP:"🐑"};
var OPS_CN = {};
var S = {rep:null, frames:[], idx:0, renderedIdx:-1, playing:false, speed:1, last:0, acc:0, raf:0, src:"", turns:24, legend:null, tileKeys:[[],[]], chart:null, loadSeq:0};

function escapeText(value){
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}

// Sampled replays use engine steps, not array indices, for links and day jumps.
function indexAtStep(step, forward){
  var frames = S.frames, lo = 0, hi = frames.length;
  while (lo < hi){ var mid = (lo + hi) >>> 1; if (frames[mid].t < step) lo = mid + 1; else hi = mid; }
  if (!frames.length) return 0;
  if (forward || (lo < frames.length && frames[lo].t === step)) return Math.min(lo, frames.length - 1);
  return Math.max(0, lo - 1);
}

function fmtMoney(v){ return v===null||v===undefined ? "–" : Math.round(v).toLocaleString("en-US"); }
function fmtOp(op){
  if (op === null || op === undefined) return "PASS";
  if (Array.isArray(op)) return op.join(" ");
  return String(op);
}
function flip(m){
  // 兼容两种图例写法：{code:name} 直接用，{name:code} 翻转过来
  var out = {};
  for (var k in (m||{})){
    var v = m[k];
    if (/^[0-9A-Fa-f]$/.test(k)) out[k] = v; else out[v] = k;
  }
  return out;
}
function legendOf(rep){
  var l = rep.legend || {};
  return {crops:flip(l.crops), animals:flip(l.animals), items:l.items||[]};
}
function cellCode(p, i){
  var s = p.tiles || "";
  return s.charAt(i) || "0";
}
function cropFromCode(rep, code, p, i){
  var crops = legendOf(rep).crops;
  for (var k in crops) if (crops[k] === undefined) continue;
  // crops: {code: name}
  if (crops[code]) return crops[code];
  var ex = (p.extra||{})[i];
  if (ex && ex[0] === 1) return crops[ex[1]] || "";
  return "";
}
function animalFromCode(rep, code, p, i){
  var an = (S.legend || legendOf(rep)).animals;
  if (an[code]) return an[code];
  var ex = (p.extra||{})[i];
  if (ex && ex[0] === 2) return an[ex[1]] || "";
  return "";
}

function buildBoard(el){
  el.innerHTML = "";
  var cells = [];
  for (var i=0;i<100;i++){
    var d = document.createElement("div");
    d.className = "cell";
    el.appendChild(d);
    cells.push(d);
  }
  return cells;
}

function paintBoard(rep, cells, p, side){
  var crops = S.legend.crops;
  for (var i=0;i<100;i++){
    var c = cells[i], code = cellCode(p,i), ex = (p.extra||{})[i];
    var occupants = (p.hands || []).map(function(h){ return h && h[0] === i%10 && h[1] === Math.floor(i/10); });
    var farmer = p.pos && p.pos[0] === i%10 && p.pos[1] === Math.floor(i/10);
    var signature = code + ":" + JSON.stringify(ex || null) + ":" + occupants.join(",") + ":" + Boolean(farmer);
    if (S.tileKeys[side][i] === signature) continue;
    S.tileKeys[side][i] = signature;
    var cls = "cell", inner = "";
    var bg = "";
    if (code === "L"){ cls += " locked"; }
    else if (code === "W"){ cls += " weed"; inner = "草"; }
    else if (code === "C" || code === "S"){ bg = "#4a3f2c"; inner = code === "C" ? "舍" : "场"; }
    else if (code === "c" || code === "s"){
      bg = "#4a3f2c";
      cls += " animal";
      var animal = animalFromCode(rep, code, p, i);
      inner = ANIMAL_GLYPH[animal] || "兽";
      if (ex && ex[4] === 0) inner += "!";      // 没喂
    } else if (code !== "0"){
      var crop = crops[code] || (ex && crops[ex[1]]) || "";
      bg = CROP_COLOR[crop] || "#6b8e4e";
      cls += " plant";
      inner = crop ? crop.charAt(0) : "";
    }
    c.className = cls;
    c.style.background = bg;
    c.textContent = "";
    if (inner) c.appendChild(document.createTextNode(inner));   // 作物首字母/动物/杂草标记先画
    var yieldUnits = ex ? (ex[0] === 1 ? ex[4] : (ex[0] === 2 ? ex[3] : 0)) : 0;
    if (yieldUnits > 0){
      var y = document.createElement("span");
      y.className = "y"; y.textContent = String(yieldUnits);
      c.appendChild(y);
    }
    if (ex && ex[0] === 1 && ex[3] === 1){
      var w = document.createElement("i"); w.className = "wet"; c.appendChild(w);
    }
    if (ex && ex[0] === 1 && ex[6] > 0){
      var ft = document.createElement("i"); ft.className = "fert"; c.appendChild(ft);
    }
    // 单位：农夫 + 雇工
    var pos = p.pos, hands = p.hands || [];
    for (var h=0; h<hands.length; h++){
      var hp = hands[h];
      if (hp && hp[0] === i%10 && hp[1] === Math.floor(i/10)){
        var e2 = document.createElement("span");
        e2.className = "u h"; e2.title = "雇工" + (h+1);
        c.appendChild(e2);
      }
    }
    if (pos && pos[0] === i%10 && pos[1] === Math.floor(i/10)){
      var e3 = document.createElement("span");
      e3.className = "u f " + (side === 0 ? "a" : "b");
      e3.title = "农夫";
      c.appendChild(e3);
    }
  }
}

function paintLegend(el, rep){
  var l = S.legend || legendOf(rep);
  var html = "";
  for (var code in l.crops){
    var nm = l.crops[code];
    html += '<span><i style="background:' + (CROP_COLOR[nm] || "#6b8e4e") + '"></i>' + escapeText(nm) + "</span>";
  }
  html += '<span><i style="background:var(--locked)"></i>未解锁</span>';
  html += '<span><i style="background:var(--weed)"></i>杂草</span>';
  html += '<span><i style="background:#4a3f2c"></i>鸡舍/牧场</span>';
  html += '<span><i style="background:#4da3ff"></i>已浇水</span>';
  el.innerHTML = html;
}

function paintMarket(rep, f){
  var items = S.legend.items, el = document.getElementById("mkt");
  var prev = S.frames[indexAtStep(f.t - S.turns, false)] || f;
  var html = "";
  for (var i=0;i<items.length;i++){
    var p = f.mkt.prices[i], iv = f.mkt.inv[i], p0 = prev.mkt.prices[i] || p;
    var d = p - p0, cls = d > 0 ? "up" : (d < 0 ? "down" : "");
    html += "<tr><td>" + escapeText(items[i]) + '</td><td class="n ' + cls + '">' + escapeText(p) +
            '</td><td class="n" style="color:var(--muted)">' + escapeText(iv) + "</td></tr>";
  }
  el.innerHTML = html;
}

function paintActs(rep, f){
  var el = document.getElementById("acts"), html = "", labels = ((rep.meta || {}).labels||["A","B"]);
  for (var i=0;i<2;i++){
    var a = f.act[i] || {}, p = f.p[i];
    var rows = [];
    if (a.farmer) rows.push('<span class="k">农夫</span> <span class="op">' + escapeText(fmtOp(a.farmer)) + "</span>");
    var hands = a.hands || [];
    for (var h=0;h<hands.length;h++) rows.push('<span class="k">雇工' + (h+1) + '</span> <span class="op">' + escapeText(fmtOp(hands[h])) + "</span>");
    var mkt = a.market || [];
    for (var m=0;m<mkt.length;m++) rows.push('<span class="k">市场</span> <span class="op">' + escapeText(fmtOp(mkt[m])) + "</span>");
    if (!rows.length) rows.push('<span class="k">（无动作）</span>');
    var own = [];
    for (var k in (p.shed||{})) own.push(escapeText(k) + "×" + escapeText(p.shed[k]));
    for (var k2 in (p.seeds||{})) own.push("种子 " + escapeText(k2) + "×" + escapeText(p.seeds[k2]));
    html += '<div class="side"><div><span class="nm ' + (i===0?"nmA":"nmB") + '">' + escapeText(labels[i]||("seat"+i)) +
            "</span> <span class='k'>现金 " + fmtMoney(p.money) + (f.dead[i] ? " · 已判负" : "") + "</span></div>" +
            rows.join("<br>") + '<div class="k" style="margin-top:4px">库存 ' + (own.join("、") || "空") + "</div></div>";
  }
  el.innerHTML = html;
}

function prepareChart(){
  var points = [], min = 0, max = 1;
  for (var i=0; i<S.frames.length; i++){
    var f = S.frames[i], a = Number(f.p[0].money) || 0, b = Number(f.p[1].money) || 0;
    min = Math.min(min,a,b); max = Math.max(max,a,b);
    points.push([f.t,a,b]);
  }
  S.chart = {points:points,min:min,max:max,first:points[0][0],span:Math.max(1,points[points.length-1][0]-points[0][0]),base:document.createElement("canvas"),width:0,height:0};
  buildChartBase();
}

// Curves and their scale are rebuilt only when the file, theme, or canvas size changes.
function buildChartBase(){
  if (!S.chart) return;
  var cv = document.getElementById("cvMoney"), ratio = window.devicePixelRatio || 1;
  var W = Math.max(200, Math.round(cv.clientWidth * ratio)), H = Math.max(100, Math.round(cv.clientHeight * ratio));
  cv.width = W; cv.height = H;
  var chart = S.chart, base = chart.base;
  base.width = W; base.height = H; chart.width = W; chart.height = H; chart.ratio = ratio;
  var ctx = base.getContext("2d"), css = getComputedStyle(document.documentElement);
  chart.colors = [css.getPropertyValue("--a").trim(),css.getPropertyValue("--b").trim()];
  chart.marker = css.getPropertyValue("--marker").trim(); chart.muted = css.getPropertyValue("--muted").trim();
  ctx.fillStyle = css.getPropertyValue("--panel").trim(); ctx.fillRect(0,0,W,H);
  var left = 48*ratio, top = 12*ratio, bottom = H-26*ratio, right = W-8*ratio;
  chart.left = left; chart.right = right; chart.top = top; chart.bottom = bottom;
  ctx.strokeStyle = css.getPropertyValue("--grid").trim(); ctx.lineWidth = ratio;
  for (var g=0;g<=4;g++){
    var y = top+(bottom-top)*g/4;
    ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();
  }
  ctx.save();ctx.beginPath();ctx.rect(left,top,right-left,bottom-top);ctx.clip();
  for (var side=0;side<2;side++){
    ctx.strokeStyle = chart.colors[side];ctx.lineWidth = 2*ratio;ctx.beginPath();
    for (var j=0;j<chart.points.length;j++){
      var point = chart.points[j], x = left+(right-left)*(point[0]-chart.first)/chart.span;
      var py = bottom-(bottom-top)*(point[side+1]-chart.min)/(chart.max-chart.min);
      if (!j) ctx.moveTo(x,py);else ctx.lineTo(x,py);
    }
    ctx.stroke();
  }
  ctx.restore();ctx.fillStyle = chart.muted;ctx.font = 10*ratio+"px sans-serif";
  ctx.fillText(fmtMoney(chart.max),2*ratio,top+4*ratio);ctx.fillText(fmtMoney(chart.min),2*ratio,bottom);
}

function paintChart(){
  if (!S.chart || !S.frames.length) return;
  var cv = document.getElementById("cvMoney"), ctx = cv.getContext("2d"), chart = S.chart, ratio = chart.ratio;
  ctx.clearRect(0,0,cv.width,cv.height);ctx.drawImage(chart.base,0,0);
  var step = S.frames[S.idx].t, x = chart.left+(chart.right-chart.left)*(step-chart.first)/chart.span;
  ctx.strokeStyle = chart.marker;ctx.lineWidth = ratio;ctx.beginPath();ctx.moveTo(x,chart.top);ctx.lineTo(x,chart.bottom);ctx.stroke();
  ctx.fillStyle = chart.muted;ctx.font = 10*ratio+"px sans-serif";
  ctx.fillText("step "+step,Math.min(x+3*ratio,cv.width-90*ratio),cv.height-6*ratio);
}

/* ---------------- 主渲染 ---------------- */
function render(force){
  if (!S.frames.length) return;
  S.idx = Math.max(0,Math.min(S.idx,S.frames.length-1));
  if (!force && S.renderedIdx === S.idx) return;
  S.renderedIdx = S.idx;
  var f = S.frames[S.idx], rep = S.rep;
  document.getElementById("tStep").textContent = "step "+f.t+" / 第 "+f.day+" 天 "+f.hour+" 时";
  document.getElementById("clock").textContent = "第 "+f.day+" 天 "+f.hour+" 时 · 现金 "+fmtMoney(f.p[0].money)+" vs "+fmtMoney(f.p[1].money);
  for (var i=0;i<2;i++){
    var p = f.p[i];
    document.getElementById("money"+(i===0?"A":"B")).textContent = fmtMoney(p.money)+" | 雇工 "+(p.hands||[]).length;
    paintBoard(rep,S.cells[i],p,i);
  }
  document.getElementById("seek").value = String(S.idx);
  var params = new URLSearchParams(location.hash.slice(1));
  if (S.src) params.set("src",S.src);else params.delete("src");
  params.set("t",String(f.t));
  var hash = "#"+params.toString();
  if (history.replaceState && hash !== location.hash){try {history.replaceState(null,"",hash);}catch(_e){}}
  paintMarket(rep,f);paintActs(rep,f);paintChart();
}

function tick(ts){
  if (!S.playing) return;
  if (!S.last) S.last = ts;
  var dt = Math.min(0.25,(ts-S.last)/1000);S.last = ts;
  S.acc += dt*S.speed*12;
  var before = S.idx;
  while (S.idx < S.frames.length-1){
    var interval = Math.max(1,S.frames[S.idx+1].t-S.frames[S.idx].t);
    if (S.acc < interval) break;
    S.acc -= interval;S.idx++;
  }
  if (before !== S.idx) render();
  if (S.idx >= S.frames.length-1) setPlaying(false);
  if (S.playing) S.raf = requestAnimationFrame(tick);
}
function setPlaying(on){
  if (on && !S.frames.length) return;
  if (S.playing === on) return;
  S.playing = on;S.last = 0;S.acc = 0;
  cancelAnimationFrame(S.raf);
  var button = document.getElementById("play"), label = on ? "暂停" : "播放";
  button.textContent = on ? "⏸" : "▶";button.title = label;button.setAttribute("aria-label",label);
  if (on) S.raf = requestAnimationFrame(tick);
}

/* ---------------- 载入 ---------------- */
function loadReplay(rep, options){
  options = options || {};
  if (!rep || !Array.isArray(rep.frames)) throw new Error("不是回放文件（缺 frames）");
  if (String(rep.format||"").indexOf("k4u-arena-replay") !== 0) throw new Error("格式不匹配："+rep.format);
  var frames = decodeReplay(rep);
  if (!frames.length) throw new Error("回放没有可显示的帧");
  for (var j=0;j<frames.length;j++){
    if (frames[j].p.length < 2) throw new Error("回放需要两位选手");
    if (j && frames[j].t < frames[j-1].t) throw new Error("回放时间顺序无效");
  }
  setPlaying(false);S.rep = rep;S.frames = frames;S.idx = 0;S.renderedIdx = -1;S.src = options.src || "";S.legend = legendOf(rep);S.tileKeys = [[],[]];
  var meta = rep.meta || {}, labels = meta.labels || ["A","B"];
  S.turns = Math.max(1,Number((meta.cfg || {}).turnsPerDay)||24);
  if (options.t !== null && options.t !== undefined) S.idx = indexAtStep(options.t,false);
  document.getElementById("nameA").textContent = labels[0] || "A";
  document.getElementById("nameB").textContent = labels[1] || "B";
  document.getElementById("tSeed").textContent = "seed "+meta.seed;
  document.getElementById("tWinner").textContent = "结果 "+(meta.winner === "draw" ? "平局" : ((meta.winner||"?")+" 胜"))+" · "+(meta.end_reason || "?")+" · 终局 "+fmtMoney((meta.final_cash||[])[0])+" vs "+fmtMoney((meta.final_cash||[])[1]);
  document.getElementById("tEngine").textContent = "引擎 "+String(meta.engine_sha256||"").slice(0,8)+" · "+(meta.delta ? "增量帧" : "全量帧")+" · 每 "+(meta.sample_every||1)+" 步";
  if (!S.cells) S.cells = [buildBoard(document.getElementById("boardA")),buildBoard(document.getElementById("boardB"))];
  paintLegend(document.getElementById("legA"),rep);paintLegend(document.getElementById("legB"),rep);
  document.getElementById("main").hidden = false;document.getElementById("controls").hidden = false;
  document.getElementById("drop").style.display = "none";document.getElementById("err").textContent = "";
  var seek = document.getElementById("seek");seek.max = String(S.frames.length-1);seek.value = String(S.idx);
  prepareChart();render();
}
function fail(e){
  document.getElementById("drop").style.display = "block";
  document.getElementById("loadbox").textContent = "";
  document.getElementById("err").textContent = "载入失败："+(e && e.message ? e.message : e);
}
function applyTheme(mode){
  var dark = mode === "dark" || (mode === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme",dark ? "dark" : "light");
  try {localStorage.setItem("radar.theme",mode);}catch(_e){}
  if (S.chart){buildChartBase();paintChart();}
}
function boot(){
  var theme = document.getElementById("theme"), saved;
  try {saved = localStorage.getItem("radar.theme");}catch(_e){}
  theme.value = ["light","dark","system"].indexOf(saved) >= 0 ? saved : "light";applyTheme(theme.value);
  theme.addEventListener("change",function(){applyTheme(theme.value);});
  if (window.matchMedia){
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change",function(){if (theme.value === "system") applyTheme("system");});
  }
  var params = new URLSearchParams(location.hash.slice(1)), src = params.get("src"), t = params.get("t");
  var wantT = t !== null && /^\d+$/.test(t) ? Number(t) : null;
  // 只加载本站回放接口（2026-10-31 安全修复：#src= 原先可指向任意地址，靠 CSP connect-src 'self' 兜底）
  if (src && !/^\/api\/arena\/replays\/[A-Za-z0-9-]{1,64}$/.test(src)){
    fail(new Error("只能播放本站回放（/api/arena/replays/<id>），其余请用本地文件打开"));
    src = null;
  }
  if (src){
    var remoteLoad = ++S.loadSeq;
    document.getElementById("loadbox").textContent = "加载回放…";
    fetch(src).then(function(r){if(!r.ok) throw new Error("HTTP "+r.status);return r.json();})
      .then(function(rep){if (remoteLoad === S.loadSeq) loadReplay(rep,{src:src,t:wantT});})
      .catch(function(error){if (remoteLoad === S.loadSeq) fail(error);});
  }
  function readFile(file){
    if (!file) return;
    var localLoad = ++S.loadSeq;
    setPlaying(false);
    var fr = new FileReader();
    fr.onload = function(){if (localLoad !== S.loadSeq) return;try {loadReplay(JSON.parse(fr.result),{src:""});}catch(e){fail(e);}};
    fr.onerror = function(){if (localLoad === S.loadSeq) fail(new Error("无法读取文件"));};fr.readAsText(file);
  }
  document.getElementById("openFile").addEventListener("click",function(){document.getElementById("file").click();});
  document.getElementById("file").addEventListener("change",function(ev){readFile(ev.target.files[0]);ev.target.value = "";});
  var drop = document.getElementById("drop");
  ["dragenter","dragover"].forEach(function(type){drop.addEventListener(type,function(e){e.preventDefault();drop.classList.add("hot");});});
  ["dragleave","drop"].forEach(function(type){drop.addEventListener(type,function(e){e.preventDefault();drop.classList.remove("hot");});});
  drop.addEventListener("drop",function(e){readFile(e.dataTransfer.files[0]);});
  document.getElementById("play").addEventListener("click",function(){setPlaying(!S.playing);});
  document.getElementById("spd").addEventListener("change",function(ev){S.speed = Number(ev.target.value);});
  function bump(amount){setPlaying(false);S.idx += amount;render();}
  function day(direction){setPlaying(false);if (S.frames.length){S.idx = indexAtStep(S.frames[S.idx].t+direction*S.turns,direction>0);render();}}
  document.getElementById("b1").addEventListener("click",function(){bump(-1);});
  document.getElementById("f1").addEventListener("click",function(){bump(1);});
  document.getElementById("bd").addEventListener("click",function(){day(-1);});
  document.getElementById("fd").addEventListener("click",function(){day(1);});
  document.getElementById("end").addEventListener("click",function(){setPlaying(false);S.idx = S.frames.length-1;render();});
  document.getElementById("seek").addEventListener("input",function(ev){setPlaying(false);S.idx = Number(ev.target.value)||0;render();});
  window.addEventListener("keydown",function(e){
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (e.key === " "){e.preventDefault();setPlaying(!S.playing);}
    if (e.key === "ArrowRight"){e.preventDefault();bump(1);}
    if (e.key === "ArrowLeft"){e.preventDefault();bump(-1);}
  });
  document.addEventListener("visibilitychange",function(){S.last = 0;});
  if (window.ResizeObserver){
    var observer = new ResizeObserver(function(){if (S.chart){buildChartBase();paintChart();}});
    observer.observe(document.getElementById("cvMoney"));
  }else window.addEventListener("resize",function(){if (S.chart){buildChartBase();paintChart();}});
}
boot();
