import { useState } from 'react'
import CopyButton from './CopyButton'
import { useDialog } from '../hooks/useDialog'
import { luoguUrl, promptOf } from '../aggregate'

/**
 * 提示词专用复制按钮（v3.11）：复制「该题实际生效的提示词」（专属定制或标准模板拼装），
 * 复制成功后若该题在洛谷存在附件，弹出小窗提醒去洛谷题目页下载附件并放入工作区。
 * 全站提示词复制口（题目抽屉 / 提交表单 / 管理台题目表 / 提示词库）统一走本组件。
 */
export default function PromptCopyButton({
  problem, modelId, label = '一键复制', okLabel = '已复制', toast, size = 'small', kind = '', title,
}) {
  const [showNotice, setShowNotice] = useState(false)
  const dialogRef = useDialog(() => setShowNotice(false))
  const text = promptOf(problem, modelId)
  const url = luoguUrl(problem?.pid)

  return (
    <>
      <CopyButton
        text={text}
        label={label}
        okLabel={okLabel}
        toast={toast}
        size={size}
        kind={kind}
        title={title}
        onCopied={() => { if (problem?.hasAttachments) setShowNotice(true) }}
      />
      {showNotice && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowNotice(false) }}>
          <div ref={dialogRef} className="modal" role="alertdialog" aria-modal="true" aria-label="附件下载提醒" tabIndex={-1}>
            <div className="modal-head">
              <h3>📎 该题附有题目附件</h3>
              <button type="button" className="icon-btn close" onClick={() => setShowNotice(false)}>✕</button>
            </div>
            <div className="callout">
              刚复制的提示词要求被测模型<strong>只读取题目附件</strong>。请先前往洛谷题目页
              （{problem?.pid}）下载全部附件，放到 <code>{'{模型id}_{题号}'}</code> 工作区文件夹内，再把提示词发给模型。
            </div>
            <div className="modal-foot">
              {url && (
                <a className="btn primary" href={url} target="_blank" rel="noopener noreferrer"
                  onClick={() => setShowNotice(false)}>
                  打开洛谷原题 ↗
                </a>
              )}
              <button type="button" className="btn ghost" onClick={() => setShowNotice(false)}>知道了</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
