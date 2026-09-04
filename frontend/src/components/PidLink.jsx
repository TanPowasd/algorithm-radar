import { luoguUrl } from '../aggregate'

/**
 * 题号外链：点击在新标签页打开洛谷对应题目页。
 *
 * @param {string} pid       题号（P1001 / B2001 / CF10A …）
 * @param {string} [label]   显示文本，缺省为题号本身（滚榜列头要去掉前缀只显示数字）
 * @param {boolean} [icon]   是否在题号后带 ↗ 外链标记（大字号标题处可关掉）
 *
 * 注意：嵌在可点击容器（矩阵行头、表格行）里时，调用方要自行 stopPropagation，
 * 否则外链跳转会连带触发父级的抽屉/详情。
 */
export default function PidLink({ pid, label, icon = true, className = '', title, ...rest }) {
  const key = String(pid ?? '').trim().toUpperCase()
  const url = luoguUrl(key)
  const text = label ?? key
  if (!url) {
    return <span className={className || undefined} {...rest}>{text}</span>
  }
  return (
    <a
      className={className ? `pid-link ${className}` : 'pid-link'}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={title ?? `在洛谷打开 ${key}`}
      data-pid={key}
      {...rest}
    >
      {text}
      {icon && <span className="ext" aria-hidden="true">↗</span>}
    </a>
  )
}
