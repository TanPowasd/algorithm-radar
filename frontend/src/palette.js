/**
 * 配色系统（纯展示层，不参与任何统计口径）。
 *
 * 规则：
 *  1. 「厂商」决定色相 —— 同一厂商的不同模型、不同思考等级共用同一支色相（同色）；
 *  2. 「模型」决定明度 —— 同厂商内每个模型在色相不变的前提下明度/饱和分级，便于一眼分清版本；
 *  3. 「思考等级」决定填充强度 —— 用底色透明度 + 45° 斜纹密度编码（等级越高越实、纹越密）。
 *
 * 厂商来源：模型目录 /api/models 的 vendor 字段优先；未填写时回落到内置前缀猜测表，
 * 再落不到组名则为「未标注厂商」（自成一色）。管理员在「模型管理」里补全厂商即可精确控制分组。
 */

/** 16 支均匀散布的色相，深浅主题通用（青/蓝/柠檬优先，贴近参考视觉） */
export const VENDOR_HUES = [
  189, 216, 82, 266, 338, 30, 156, 300,
  52, 128, 244, 8, 108, 286, 172, 204,
]

/** 厂商前缀猜测表（仅用于展示分组，命中即止；可在模型管理里用 vendor 覆盖） */
const VENDOR_GUESS = [
  [/^deepseek/i, 'DeepSeek'],
  [/^(chatgpt|gpt|o[1-9](?:[-_ ]|$)|codex|davinci)/i, 'OpenAI'],
  [/^(claude|opus|sonnet|haiku|fable)/i, 'Anthropic'],
  [/^(gemini|gemma|bard)/i, 'Google'],
  [/^(qwen|tongyi)/i, '阿里云'],
  [/^(glm|chatglm|codegeex)/i, '智谱'],
  [/^(kimi|moonshot)/i, '月之暗面'],
  [/^(doubao|seed[- ]?ckpt)/i, '字节跳动'],
  [/^(grok)/i, 'xAI'],
  [/^(longcat)/i, '美团'],
  [/^(hunyuan|hy[0-9])/i, '腾讯'],
  [/^(ernie|文心)/i, '百度'],
  [/^(minimax|abab|mini[- ]?max)/i, 'MiniMax'],
  [/^(step[- ]?flash|stepfn|step)/i, '阶跃星辰'],
  [/^(spark|星火)/i, '科大讯飞'],
  [/^(mistral|mixtral|magistral)/i, 'Mistral'],
  [/^(llama|meta[- ]?llama)/i, 'Meta'],
  [/^(groq|granite|watson)/i, 'IBM'],
  [/^(ernie|sensetime|nova|streamlaw|nano|书生|paddle)/i, '其他'],
  [/^(intern[- ]?lm|internlm)/i, '上海AI实验室'],
]

export function guessVendor(name) {
  const s = String(name || '').trim()
  for (const [re, vendor] of VENDOR_GUESS) if (re.test(s)) return vendor
  const head = s.split(/[-_.\s/]+/)[0]
  return head ? head.toLowerCase() : '未标注厂商'
}

/** 模型名 → 厂商名（目录 vendor 优先） */
export function makeVendorOf(models) {
  const byName = new Map()
  for (const m of models || []) {
    const v = String(m.vendor || '').trim()
    if (v) byName.set(m.name, v)
  }
  return (name) => byName.get(name) || guessVendor(name)
}

/* ---------------- HSL → hex（保证调用方可以继续拼 '22' 之类的 alpha） ---------------- */

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360
  s = Math.max(0, Math.min(100, s)) / 100
  l = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [r + m, g + m, b + m].map((v) => Math.round(v * 255))
}

export function hslToHex(h, s, l) {
  const [r, g, b] = hslToRgb(h, s, l)
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** rgba() 字符串（画布斜纹用） */
export function hexRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** 同一厂商内第 i 个模型的明度阶梯（明→暗交替，保证相邻可辨） */
function shadeOf(i) {
  const step = [0, -12, +10, -20, +16, -5, +22, -16][i % 8]
  const round = Math.floor(i / 8)
  return step + round * 6
}

/**
 * 生成「系列（模型）→ 颜色」映射。
 * @param {string[]} series 系列名列表（已排序）
 * @param {(name:string)=>string} vendorOf 厂商解析
 * @param {boolean} dark 是否深色主题（影响明度基线，保证对比度）
 * @param {boolean|{shade?: boolean}} [opts=true] 是否按明度/饱和度阶梯区分同厂商不同模型；为 false 时同厂商全部模型使用同一种基准色（不调整明度与饱和度）
 */
export function vendorColorMap(series, vendorOf, dark = true, opts = {}) {
  const shade = typeof opts === 'boolean' ? opts : (opts?.shade ?? true)
  const colors = new Map()
  const vendors = [...new Set(series.map((s) => vendorOf(s)))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  const hueOf = new Map()
  vendors.forEach((v, i) => hueOf.set(v, VENDOR_HUES[i % VENDOR_HUES.length]))
  const seen = new Map()
  const baseL = dark ? 62 : 44
  const baseSat = 82
  for (const s of series) {
    const vendor = vendorOf(s)
    const hue = hueOf.get(vendor)
    if (!shade) {
      colors.set(s, hslToHex(hue, baseSat, baseL))
      continue
    }
    const idx = seen.get(vendor) || 0
    seen.set(vendor, idx + 1)
    const l = Math.max(dark ? 40 : 24, Math.min(dark ? 82 : 62, baseL + shadeOf(idx)))
    const sat = Math.max(38, 82 - (idx % 3) * 12)
    colors.set(s, hslToHex(hue, sat, l))
  }
  return colors
}

/** 厂商图例：厂商 → {hue, color, models[]} */
export function vendorLegend(series, vendorOf, dark = true, opts = {}) {
  const colors = vendorColorMap(series, vendorOf, dark, opts)
  const groups = new Map()
  for (const s of series) {
    const v = vendorOf(s)
    if (!groups.has(v)) groups.set(v, { vendor: v, models: [], swatch: null })
    const g = groups.get(v)
    g.models.push(s)
    if (!g.swatch) {
      const hue = [...new Set(series.map((x) => vendorOf(x)))].indexOf(v)
      g.swatch = colors.get(s)
      g.hue = VENDOR_HUES[(hue >= 0 ? hue : 0) % VENDOR_HUES.length]
    }
  }
  return [...groups.values()].sort((a, b) => a.vendor.localeCompare(b.vendor, 'zh-Hans-CN'))
}

/* ---------------- 思考等级 → 填充强度 / 斜纹密度 ---------------- */

/** 与 THINKING_LEVELS 对齐：ultra…off */
export const LEVEL_ALPHA = { ultra: 0.95, max: 0.84, xhigh: 0.72, high: 0.6, medium: 0.48, low: 0.36, off: 0.24 }
/** 斜纹间距 px（越小越密 = 思考等级越高）；off 用点阵区分 */
export const LEVEL_HATCH = { ultra: 5, max: 7, xhigh: 9, high: 12, medium: 16, low: 22, off: 0 }

export const levelAlpha = (t) => LEVEL_ALPHA[t] ?? 0.5
export const levelHatch = (t) => LEVEL_HATCH[t] ?? 12

/**
 * 在给定矩形内画「同色 + 斜纹」填充（Canvas 2D）。
 * 斜纹按等级密度编码，颜色仍是厂商色 —— 同厂商不同模型/不同等级视觉上同色系。
 */
export function fillLevelBar(ctx, rect, color, thinking) {
  const { x, y, w, h } = rect
  if (w <= 0 || h <= 0) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.fillStyle = hexRgba(color, levelAlpha(thinking))
  ctx.fillRect(x, y, w, h)
  const gap = levelHatch(thinking)
  if (gap > 0) {
    ctx.strokeStyle = hexRgba(color, 0.95)
    ctx.lineWidth = Math.max(1, gap <= 7 ? 1.8 : 1.2)
    ctx.beginPath()
    const span = w + h
    for (let o = -h; o < span; o += gap) {
      ctx.moveTo(x + o, y + h)
      ctx.lineTo(x + o + h, y)
    }
    ctx.stroke()
  } else {
    // 关闭思考：只留细点阵，表示「不思考」
    ctx.fillStyle = hexRgba(color, 0.85)
    for (let yy = y + 4; yy < y + h; yy += 9) {
      for (let xx = x + 4; xx < x + w; xx += 9) ctx.fillRect(xx, yy, 1.6, 1.6)
    }
  }
  ctx.strokeStyle = hexRgba(color, 0.98)
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  ctx.restore()
}

/** 图例用：CSS 背景（与画布斜纹同一套密度语义） */
export function levelSwatchStyle(color, thinking) {
  const a = levelAlpha(thinking)
  const gap = levelHatch(thinking)
  const base = hexRgba(color, a)
  if (!gap) return { background: `radial-gradient(circle at 3px 3px, ${hexRgba(color, 0.9)} 1.2px, ${base} 1.4px)`, backgroundSize: '9px 9px' }
  const line = hexRgba(color, 0.95)
  return {
    background: `repeating-linear-gradient(135deg, ${line} 0 1.6px, ${base} 1.6px ${gap}px)`,
  }
}
