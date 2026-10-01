/** 对抗赛的公共元数据：思考强度取值、标签、选手身份拼接 */
export const THINKING_LEVELS = [
  { code: '', label: '未标注' },
  { code: 'low', label: '低' },
  { code: 'medium', label: '中' },
  { code: 'high', label: '高' },
  { code: 'xhigh', label: '极高' },
  { code: 'max', label: 'max' },
]

export function thinkingLabel(code) {
  const hit = THINKING_LEVELS.find((t) => t.code === (code || ''))
  return hit ? hit.label : String(code || '')
}

/** 选手显示名：名字 · 思考强度 */
export function entityLabel(name, thinking) {
  const t = thinkingLabel(thinking)
  return t && t !== '未标注' ? name + ' · ' + t : name
}

/** 下拉框里把「名字 + 思考强度」打包成一个值 */
export const ENTITY_SEP = '\u0000'
export const packEntity = (name, thinking) => name + ENTITY_SEP + (thinking || '')
export const unpackEntity = (v) => {
  const i = String(v || '').indexOf(ENTITY_SEP)
  return i < 0 ? { name: String(v || ''), thinking: '' } : { name: v.slice(0, i), thinking: v.slice(i + 1) }
}
