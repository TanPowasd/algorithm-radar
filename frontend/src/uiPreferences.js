export const UI_STORAGE_KEY = 'radar.ui.preferences.v1'

export const DEFAULT_UI_PREFERENCES = {
  style: 'clean', fontSize: 16, sidebarCollapsed: false, motion: 'system', precision: 'compact',
  features: {
    competitions: true, records: true, contributors: true, prompts: true,
    rollboard: true, stats: true, scoreLegend: true, thinkingLabels: true, shortcuts: false,
  },
}

export const FEATURE_OPTIONS = [
  { key: 'competitions', label: '比赛', description: '比赛目录、交锋与回放入口' },
  { key: 'records', label: '测评明细', description: '查看逐轮记录的页签' },
  { key: 'prompts', label: '推荐提示词', description: '资料分组中的提示词入口' },
  { key: 'contributors', label: '贡献者', description: '资料分组中的贡献者名册' },
  { key: 'rollboard', label: '滚榜回放', description: '资料分组中的滚榜入口' },
  { key: 'stats', label: '统计概览', description: '评测页顶部的统计摘要' },
  { key: 'scoreLegend', label: '分数图例', description: '矩阵底部的分数颜色说明' },
  { key: 'thinkingLabels', label: '思考等级', description: '成绩下方的思考等级标注' },
  { key: 'shortcuts', label: '快捷键按钮', description: '页面右下角的快捷键说明入口' },
]

export function normalizeUiPreferences(value) {
  const source = value && typeof value === 'object' ? value : {}
  const features = { ...DEFAULT_UI_PREFERENCES.features }
  for (const key of Object.keys(features)) {
    if (typeof source.features?.[key] === 'boolean') features[key] = source.features[key]
  }
  return {
    style: ['clean', 'compact', 'vscode'].includes(source.style) ? source.style : 'clean',
    fontSize: [16, 18, 20].includes(source.fontSize) ? source.fontSize : 16,
    sidebarCollapsed: typeof source.sidebarCollapsed === 'boolean' ? source.sidebarCollapsed : false,
    motion: source.motion === 'off' ? 'off' : 'system',
    precision: source.precision === 'full' ? 'full' : 'compact',
    features,
  }
}

/** 分数显示位数：精简模式统一 1 位小数；完整模式保留原有口径（原始分 2 位、加权分 5 位）。 */
export function scoreDigits(preferences, fullDigits) {
  return preferences?.precision === 'full' ? fullDigits : 1
}

export function readUiPreferences() {
  try { return normalizeUiPreferences(JSON.parse(localStorage.getItem(UI_STORAGE_KEY))) }
  catch { return normalizeUiPreferences(null) }
}

export function applyUiPreferences(root, preferences) {
  root.setAttribute('data-ui-style', preferences.style)
  root.setAttribute('data-sidebar', preferences.sidebarCollapsed ? 'collapsed' : 'expanded')
  root.setAttribute('data-motion', preferences.motion)
  root.style.setProperty('--reading-size', preferences.fontSize + 'px')
}
