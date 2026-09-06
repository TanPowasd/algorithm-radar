import { useState } from 'react'
import CopyButton from './CopyButton'
import { useDialog } from '../hooks/useDialog'
import { copyText } from '../hooks/copyText'
import { luoguUrl, promptOf } from '../aggregate'
import { useApp } from '../state'

/** 记住上次复制提示词时选的模型，下次预选 */
const LS_LAST_MODEL = 'radar.prompt.lastModel'

function readLastModel() {
  try { return localStorage.getItem(LS_LAST_MODEL) || '' } catch { return '' }
}
function writeLastModel(name) {
  try { localStorage.setItem(LS_LAST_MODEL, name) } catch { /* 忽略 */ }
}

/**
 * 提示词专用复制按钮（v3.11）：复制「该题实际生效的提示词」（专属定制或标准模板拼装）。
 * - 调用方已带模型上下文（modelId 有值，如提交表单）→ 点击直接复制，文件夹名按该模型注入；
 * - 没有模型上下文 → 点击先弹「选择模型」小窗，选中后自动填入 {模型id} 占位符再复制
 *   （也可留空保留占位符由测试者手动替换）；上次选择的模型会预选。
 * 复制成功后若该题在洛谷存在附件，弹出小窗提醒去洛谷题目页下载附件并放入工作区。
 * 全站提示词复制口（题目抽屉 / 提交表单 / 管理台题目表 / 提示词库）统一走本组件。
 */
export default function PromptCopyButton({
  problem, modelId, label = '一键复制', okLabel = '已复制', toast, size = 'small', kind = '', title,
}) {
  const { models } = useApp()
  const [choosing, setChoosing] = useState(false)
  const [picked, setPicked] = useState(readLastModel)
  const [showNotice, setShowNotice] = useState(false)
  const chooserRef = useDialog(() => setChoosing(false))
  const noticeRef = useDialog(() => setShowNotice(false))
  const url = luoguUrl(problem?.pid)

  const sortedModels = [...(models || [])].map((m) => m.name).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  const needsChooser = !modelId

  const doCopy = async (withModel) => {
    const ok = await copyText(promptOf(problem, withModel))
    if (!ok) {
      toast?.('复制失败，请手动选择文本', 'err')
      return false
    }
    if (withModel) writeLastModel(withModel)
    toast?.(withModel ? `已复制（工作区：${withModel}_${problem?.pid || ''}）` : '已复制到剪贴板')
    return true
  }

  const click = async (e) => {
    e.stopPropagation()
    if (needsChooser) {
      setPicked(readLastModel())
      setChoosing(true)
      return
    }
    if (await doCopy(modelId) && problem?.hasAttachments) setShowNotice(true)
  }

  const confirmCopy = async () => {
    const withModel = picked || undefined
    if (await doCopy(withModel)) {
      setChoosing(false)
      if (problem?.hasAttachments) setShowNotice(true)
    }
  }

  return (
    <>
      {needsChooser ? (
        <button
          type="button"
          className={`btn copy-btn ${size === 'small' ? 'small' : ''} ${kind}`}
          onClick={click}
          title={title || '选择模型并复制提示词'}
        >
          ⧉ {label}
        </button>
      ) : (
        <CopyButton
          text={promptOf(problem, modelId)}
          label={label}
          okLabel={okLabel}
          toast={toast}
          size={size}
          kind={kind}
          title={title}
          onCopied={() => { if (problem?.hasAttachments) setShowNotice(true) }}
        />
      )}

      {choosing && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setChoosing(false) }}>
          <div ref={chooserRef} className="modal" role="dialog" aria-modal="true" aria-label="选择测试模型" tabIndex={-1}>
            <div className="modal-head">
              <h3>🤖 选择本次测试的模型</h3>
              <button type="button" className="icon-btn close" onClick={() => setChoosing(false)}>✕</button>
            </div>
            <div className="field">
              <label>模型 ID（填入提示词的工作区文件夹名「{`{模型id}_${problem?.pid || ''}`}」）</label>
              <select value={picked} onChange={(e) => setPicked(e.target.value)} autoFocus>
                <option value="">（不填 — 保留 {'{模型id}'} 占位符）</option>
                {sortedModels.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <span className="chain">已收录模型来自「AI 模型管理」；选择结果会被记住，下次复制预选。</span>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn ghost" onClick={() => setChoosing(false)}>取消</button>
              <button type="button" className="btn primary" onClick={confirmCopy}>复制提示词</button>
            </div>
          </div>
        </div>
      )}

      {showNotice && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowNotice(false) }}>
          <div ref={noticeRef} className="modal" role="alertdialog" aria-modal="true" aria-label="附件下载提醒" tabIndex={-1}>
            <div className="modal-head">
              <h3>📎 该题附有题目附件</h3>
              <button type="button" className="icon-btn close" onClick={() => setShowNotice(false)}>✕</button>
            </div>
            <div className="callout">
              刚复制的提示词要求被测模型<strong>只读取题目附件</strong>。请先前往洛谷题目页
              （{problem?.pid}）下载全部附件，放到工作区文件夹内，再把提示词发给模型。
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
