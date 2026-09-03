import { useState } from 'react'
import { useApp } from '../state'
import { api } from '../api/client'
import { PID_RE, DIFFICULTY_NAMES } from '../aggregate'

/** 难度选项：value = 实际难度值字符串（'' 为选择占位）。直接由共享难度表生成，杜绝档位错位。 */
const DIFF_OPTIONS = [
  { value: '', label: '选择难度…' },
  ...Object.entries(DIFFICULTY_NAMES).map(([value, label]) => ({ value, label })),
]

function parseTags(text) {
  return text.split(/[、,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
}

/**
 * 发布新题 / 编辑题目（共用表单）。
 * - 发布：输题号自动抓洛谷补全，失败可手动填写；initialPid 用于“未收录历史数据”一键跳转发布
 * - 编辑：传入 editProblem（题目对象）→ 题号锁定，保存走 PUT（全量覆盖）
 */
export default function PublishModal({ onClose, initialPid, onPublished, editProblem }) {
  const { toast, refreshAll } = useApp()
  const isEdit = !!editProblem
  const [form, setForm] = useState(() => ({
    pid: (editProblem?.pid || initialPid || '').toUpperCase(),
    title: editProblem?.title || '',
    difficulty: editProblem?.difficulty === null || editProblem?.difficulty === undefined
      ? '' : String(editProblem.difficulty),
    tags: (editProblem?.tags || []).join('、'),
    prompt: editProblem?.prompt || '',
    manual: Boolean(editProblem?.manual),
  }))
  const [fetchState, setFetchState] = useState(null) // {kind, text}
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const doFetch = async () => {
    const pid = form.pid.trim().toUpperCase()
    if (!pid) return
    setFetchState({ kind: '', text: '正在抓取洛谷…' })
    try {
      const info = await api(`/api/luogu?pid=${encodeURIComponent(pid)}`)
      set({
        pid: info.pid,
        title: info.title || form.title,
        // 难度转字符串以匹配下拉 option value（'' 表示暂无/未评定）
        difficulty: info.difficulty === null || info.difficulty === undefined
          ? '' : String(info.difficulty),
        tags: (info.tags || []).join('、'),
        manual: false,
      })
      setFetchState({ kind: 'ok', text: `抓取成功：${info.title || info.pid}` })
    } catch (e) {
      setFetchState({ kind: 'err', text: e.message })
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    const pid = form.pid.trim().toUpperCase()
    if (!PID_RE.test(pid)) return setError('题号格式不正确（示例：P1001 / B2001 / CF10A）')
    setBusy(true)
    try {
      const problem = {
        title: form.title.trim(),
        difficulty: form.difficulty === '' ? null : Number(form.difficulty),
        tags: parseTags(form.tags),
        prompt: form.prompt,
        manual: form.manual,
      }
      if (isEdit) {
        // 编辑 = 题号不变，全量覆盖（允许清空标签/提示词）
        await api(`/api/problems/${encodeURIComponent(pid)}`, { method: 'PUT', body: { problem } })
        toast(`题目 ${pid} 已更新`)
      } else {
        await api('/api/problems', { method: 'POST', body: { pid, problem } })
        toast(`题目 ${pid} 已发布`)
      }
      await refreshAll()
      onPublished && onPublished()
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <h3>{isEdit ? `编辑题目 · ${form.pid}` : '发布新题'}</h3>
          <button type="button" className="icon-btn close" onClick={onClose}>✕</button>
        </div>
        {!isEdit ? (
          <div className="callout">
            输入洛谷题号点「抓取」自动补全标题与难度（仅管理员可用）；被风控拦截时可直接手动填写后发布。
            游客与贡献者只能对<strong>已发布</strong>的题目提交测评。
          </div>
        ) : (
          <div className="callout">
            编辑题目信息（题号不可更改）。保存将<strong>全量覆盖</strong>标题、难度、标签与推荐提示词；
            该题下的历史测评记录不受影响。
          </div>
        )}
        <div className="field">
          <label>洛谷题号 *</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={form.pid} disabled={isEdit}
              onChange={(e) => set({ pid: e.target.value.toUpperCase() })} placeholder="P1001 / B2001 / CF10A" />
            <button type="button" className="btn" id="pub-fetch" onClick={doFetch} disabled={busy || isEdit}>抓取</button>
          </div>
        </div>
        {fetchState && <div className={`fetch-status ${fetchState.kind}`} id="fetch-status">{fetchState.text}</div>}
        <div className="grid2">
          <div className="field">
            <label>题名 *</label>
            <input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="A+B Problem" />
          </div>
          <div className="field">
            <label>难度 *</label>
            <select value={form.difficulty} onChange={(e) => set({ difficulty: e.target.value })}>
              {DIFF_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label || '选择难度…'}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label>算法标签（顿号/逗号分隔，可空）</label>
          <input value={form.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="模拟、字符串、2010" />
          {isEdit && <span className="chain">编辑保存后标签将被下方内容整体替换（留空 = 清空标签）。</span>}
        </div>
        <div className="field">
          <label>推荐提示词（该题的统一测试提示词，可空）</label>
          <textarea
            value={form.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            placeholder="贴上推荐给所有贡献者使用的统一提示词，例如：请独立完成这道洛谷题，给出完整可提交的 C++17 代码，只输出代码块。"
            rows={4}
          />
          <span className="chain">
            {isEdit
              ? '编辑保存后提示词被下方内容整体替换（留空 = 移除推荐提示词）。'
              : '提示词会展示在题目详情抽屉与提交表单里，供所有人一键复制；再次发布同题号可更新。'}
          </span>
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-sm)', color: 'var(--text-2)' }}>
          <input type="checkbox" checked={form.manual} onChange={(e) => set({ manual: e.target.checked })} />
          标记为手动录入
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? '保存中…' : isEdit ? '保存修改' : '发布'}</button>
        </div>
      </form>
    </div>
  )
}
