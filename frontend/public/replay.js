/* 由 sync_web_player.py 从 viz/player.html 生成；源文件 sha256=d5842aeae4a5189d5b3914af9096a3fbd300cdbba63a041aeebe55ce2c04384a；请勿直接改 */
"use strict";
/* ---------------- 数据解码：与 engine/replay.py::decode_frames 保持一致 ---------------- */
function decodeReplay(rep){
  var meta = rep.meta || {}, cfg = meta.cfg || {};
  var turns = cfg.turnsPerDay || 24;
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
var S = {rep:null, frames:[], idx:0, playing:false, speed:1, last:0, acc:0};

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
  var an = legendOf(rep).animals;
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
  var crops = legendOf(rep).crops;
  for (var i=0;i<100;i++){
    var c = cells[i], code = cellCode(p,i), ex = (p.extra||{})[i];
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
  var l = legendOf(rep);
  var html = "";
  for (var code in l.crops){
    var nm = l.crops[code];
    html += '<span><i style="background:' + (CROP_COLOR[nm] || "#6b8e4e") + '"></i>' + nm + "</span>";
  }
  html += '<span><i style="background:var(--locked)"></i>未解锁</span>';
  html += '<span><i style="background:var(--weed)"></i>杂草</span>';
  html += '<span><i style="background:#4a3f2c"></i>鸡舍/牧场</span>';
  html += '<span><i style="background:#4da3ff"></i>已浇水</span>';
  el.innerHTML = html;
}

function paintMarket(rep, f){
  var items = legendOf(rep).items, el = document.getElementById("mkt");
  var prev = S.frames[Math.max(0, S.idx-24)] || f;
  var html = "";
  for (var i=0;i<items.length;i++){
    var p = f.mkt.prices[i], iv = f.mkt.inv[i], p0 = prev.mkt.prices[i] || p;
    var d = p - p0, cls = d > 0 ? "up" : (d < 0 ? "down" : "");
    html += "<tr><td>" + items[i] + '</td><td class="n ' + cls + '">' + p +
            '</td><td class="n" style="color:var(--muted)">' + iv + "</td></tr>";
  }
  el.innerHTML = html;
}

function paintActs(rep, f){
  var el = document.getElementById("acts"), html = "", labels = (rep.meta.labels||["A","B"]);
  for (var i=0;i<2;i++){
    var a = f.act[i] || {}, p = f.p[i];
    var rows = [];
    if (a.farmer) rows.push('<span class="k">农夫</span> <span class="op">' + fmtOp(a.farmer) + "</span>");
    var hands = a.hands || [];
    for (var h=0;h<hands.length;h++) rows.push('<span class="k">雇工' + (h+1) + '</span> <span class="op">' + fmtOp(hands[h]) + "</span>");
    var mkt = a.market || [];
    for (var m=0;m<mkt.length;m++) rows.push('<span class="k">市场</span> <span class="op">' + fmtOp(mkt[m]) + "</span>");
    if (!rows.length) rows.push('<span class="k">（无动作）</span>');
    var own = [];
    for (var k in (p.shed||{})) own.push(k + "×" + p.shed[k]);
    for (var k2 in (p.seeds||{})) own.push("种子 " + k2 + "×" + p.seeds[k2]);
    html += '<div class="side"><div><span class="nm ' + (i===0?"nmA":"nmB") + '">' + (labels[i]||("seat"+i)) +
            "</span> <span class='k'>现金 " + fmtMoney(p.money) + (f.dead[i] ? " · 已判负" : "") + "</span></div>" +
            rows.join("<br>") + '<div class="k" style="margin-top:4px">库存 ' + (own.join("、") || "空") + "</div></div>";
  }
  el.innerHTML = html;
}

function paintChart(rep){
  var cv = document.getElementById("cvMoney");
  var ctx = cv.getContext("2d");
  var W = cv.width, H = cv.height;
  ctx.clearRect(0,0,W,H);
  var frames = S.frames;
  if (!frames.length) return;
  var max = 1;
  for (var i=0;i<frames.length;i++){
    for (var s=0;s<frames[i].p.length;s++){
      var m = frames[i].p[s].money || 0;
      if (m > max) max = m;
    }
  }
  ctx.strokeStyle = "#2c3344"; ctx.lineWidth = 1;
  for (var g=0; g<=4; g++){
    var y = 10 + (H-30) * g / 4;
    ctx.beginPath(); ctx.moveTo(34, y); ctx.lineTo(W-6, y); ctx.stroke();
  }
  var colors = ["#5aa9ff","#ffb347"];
  for (var si=0; si<2; si++){
    ctx.strokeStyle = colors[si]; ctx.lineWidth = 2; ctx.beginPath();
    for (var j=0;j<frames.length;j++){
      var x = 34 + (W-42) * j / Math.max(1, frames.length-1);
      var yv = 10 + (H-30) * (1 - (frames[j].p[si] ? (frames[j].p[si].money||0) : 0) / max);
      if (j === 0) ctx.moveTo(x, yv); else ctx.lineTo(x, yv);
    }
    ctx.stroke();
  }
  ctx.strokeStyle = "#ffffff55"; ctx.beginPath();
  var cx = 34 + (W-42) * S.idx / Math.max(1, frames.length-1);
  ctx.moveTo(cx, 6); ctx.lineTo(cx, H-18); ctx.stroke();
  ctx.fillStyle = "#98a2b3"; ctx.font = "11px sans-serif";
  ctx.fillText("0", 8, H-16); ctx.fillText("step " + frames[Math.min(S.idx,frames.length-1)].t, cx+3, H-16);
  ctx.fillText(fmtMoney(max), 4, 16);
}

/* ---------------- 主渲染 ---------------- */
function render(){
  if (!S.frames.length) return;
  S.idx = Math.max(0, Math.min(S.idx, S.frames.length-1));
  var f = S.frames[S.idx], rep = S.rep;
  document.getElementById("tStep").textContent = "step " + f.t + " / 第 " + f.day + " 天 " + f.hour + " 时";
  document.getElementById("clock").textContent = "第 " + f.day + " 天 " + f.hour + " 时 · 现金 " +
      fmtMoney(f.p[0].money) + " vs " + fmtMoney(f.p[1].money);
  for (var i=0;i<2;i++){
    var p = f.p[i];
    document.getElementById("money" + (i===0?"A":"B")).textContent = fmtMoney(p.money) +
        "  |  雇工 " + (p.hands||[]).length;
    paintBoard(rep, S.cells[i], p, i);
  }
  document.getElementById("seek").value = String(S.idx);
  if (history.replaceState) history.replaceState(null, "", "#t=" + f.t);
  paintMarket(rep, f);
  paintActs(rep, f);
  paintChart(rep);
}

function tick(ts){
  if (!S.playing) return;
  if (!S.last) S.last = ts;
  var dt = (ts - S.last) / 1000; S.last = ts;
  S.acc += dt * S.speed * 12;             // 12 步/秒 × 倍速
  while (S.acc >= 1){
    S.acc -= 1;
    if (S.idx >= S.frames.length-1){ setPlaying(false); break; }
    S.idx++;
  }
  render();
  if (S.playing) requestAnimationFrame(tick);
}
function setPlaying(on){
  S.playing = on;
  document.getElementById("play").textContent = on ? "⏸ 暂停" : "▶ 播放";
  S.last = 0;
  if (on) requestAnimationFrame(tick);
}

/* ---------------- 载入 ---------------- */
function loadReplay(rep){
  if (!rep || !rep.frames){ throw new Error("不是回放文件（缺 frames）"); }
  if (String(rep.format||"").indexOf("k4u-arena-replay") !== 0){ throw new Error("格式不匹配：" + rep.format); }
  S.rep = rep; S.frames = decodeReplay(rep); S.idx = 0;
  var meta = rep.meta || {}, labels = meta.labels || ["A","B"];
  document.getElementById("nameA").textContent = labels[0];
  document.getElementById("nameB").textContent = labels[1];
  document.getElementById("tSeed").textContent = "seed " + meta.seed;
  document.getElementById("tWinner").textContent = "结果 " + (meta.winner === "draw" ? "平局" : ((meta.winner||"?") + " 胜")) +
      " · " + (meta.end_reason || "?") + " · 终局 " + fmtMoney((meta.final_cash||[])[0]) + " vs " + fmtMoney((meta.final_cash||[])[1]);
  document.getElementById("tEngine").textContent = "引擎 " + String(meta.engine_sha256||"").slice(0,8) +
      " · " + (meta.delta ? "增量帧" : "全量帧") + " · 每 " + (meta.sample_every||1) + " 步";
  S.cells = [buildBoard(document.getElementById("boardA")), buildBoard(document.getElementById("boardB"))];
  paintLegend(document.getElementById("legA"), rep);
  paintLegend(document.getElementById("legB"), rep);
  document.getElementById("main").hidden = false;
  document.getElementById("controls").hidden = false;
  document.getElementById("drop").style.display = "none";
  var seek = document.getElementById("seek");
  seek.max = String(S.frames.length-1); seek.value = "0";
  render();
}

function fail(e){
  document.getElementById("err").textContent = "载入失败：" + (e && e.message ? e.message : e);
}

function boot(){
  // 先取参数：loadReplay→render 会 replaceState 改写 hash，之后再读就拿不到了
  var hash = location.hash || "";
  var m = /#src=([^&]+)/.exec(hash);
  var mt = /[#&]t=(\d+)/.exec(hash);
  var wantT = mt ? (parseInt(mt[1], 10) || 0) : null;
  if (m){
    fetch(decodeURIComponent(m[1])).then(function(r){ if(!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(rep){
        loadReplay(rep);
        if (wantT !== null){ S.idx = wantT; render(); }
      }).catch(fail);
  }
  document.getElementById("file").addEventListener("change", function(ev){
    var f = ev.target.files[0]; if (!f) return;
    var fr = new FileReader();
    fr.onload = function(){ try { loadReplay(JSON.parse(fr.result)); } catch(e){ fail(e); } };
    fr.readAsText(f);
  });
  var drop = document.getElementById("drop");
  ["dragenter","dragover"].forEach(function(t){
    drop.addEventListener(t, function(e){ e.preventDefault(); drop.classList.add("hot"); });
  });
  ["dragleave","drop"].forEach(function(t){
    drop.addEventListener(t, function(e){ e.preventDefault(); drop.classList.remove("hot"); });
  });
  drop.addEventListener("drop", function(e){
    var f = e.dataTransfer.files[0]; if (!f) return;
    var fr = new FileReader();
    fr.onload = function(){ try { loadReplay(JSON.parse(fr.result)); } catch(err){ fail(err); } };
    fr.readAsText(f);
  });
  document.getElementById("play").addEventListener("click", function(){ setPlaying(!S.playing); });
  document.getElementById("spd").addEventListener("click", function(){
    S.speed = S.speed === 1 ? 4 : (S.speed === 4 ? 16 : (S.speed === 16 ? 64 : 1));
    document.getElementById("spd").textContent = "速度 " + S.speed + "×";
  });
  function bump(d){ setPlaying(false); S.idx += d; render(); }
  document.getElementById("b1").addEventListener("click", function(){ bump(-1); });
  document.getElementById("f1").addEventListener("click", function(){ bump(1); });
  document.getElementById("bd").addEventListener("click", function(){ bump(-24); });
  document.getElementById("fd").addEventListener("click", function(){ bump(24); });
  document.getElementById("end").addEventListener("click", function(){ setPlaying(false); S.idx = S.frames.length-1; render(); });
  document.getElementById("seek").addEventListener("input", function(ev){
    setPlaying(false); S.idx = parseInt(ev.target.value,10) || 0; render();
  });
  window.addEventListener("keydown", function(e){
    if (e.key === " "){ e.preventDefault(); setPlaying(!S.playing); }
    if (e.key === "ArrowRight") bump(1);
    if (e.key === "ArrowLeft") bump(-1);
  });
}
boot();
