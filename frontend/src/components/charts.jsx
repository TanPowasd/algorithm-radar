import Chart from 'chart.js/auto'

// 调试/测试便利：暴露到 window（生产无副作用，仅引用）
if (typeof window !== 'undefined' && !window.Chart) window.Chart = Chart

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** 创建图表：统一 responsive 设置与主题色 */
export function makeChart(canvas, config) {
  return new Chart(canvas, {
    responsive: true,
    maintainAspectRatio: false,
    ...config,
  })
}

/** 图表取色：统一从 CSS 变量读，日间/夜间自动跟随（变量在 styles.css 里定义） */
export function themeColors() {
  return {
    text: cssVar('--text-2') || '#8fa2bc',
    grid: cssVar('--chart-grid') || 'rgba(143,162,188,0.18)',
    accent: cssVar('--accent') || '#5ad9ff',
    accent2: cssVar('--accent-2') || '#6f8cff',
    accent3: cssVar('--accent-3') || '#b8ff5c',
    surface: cssVar('--surface') || '#0b0e16',
  }
}
