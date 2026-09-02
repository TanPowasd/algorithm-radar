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

export function themeColors() {
  return {
    text: cssVar('--text-2') || '#99a3b5',
    grid: cssVar('--chart-grid') || 'rgba(255,255,255,0.08)',
    accent: cssVar('--accent') || '#4d9dff',
  }
}
