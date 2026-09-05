import { useMemo, useState } from 'react'
import { useApp } from '../state'
import { api } from '../api/client'
import { normalizeSub, RESULTS, THINKING_LEVELS, THINKING_LABELS, DEFAULT_THINKING, todayStr, DIFFICULTY_NAMES } from '../aggregate'
import CopyButton from './CopyButton'

/** 测评难度选项：1–7（value 字符串，与 select 的 state 一致） */
const REC_DIFF_OPTIONS = Object.entries(DIFFICULTY_NAMES)
  .filter(([d]) => d !== '0')
  .map(([value, label]) => ({ value, label }))

function Field({ label, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  )
}

export default function RecordFormModal({ editRecord, lockPid, onClose }) {
  const { data, models, toast, refreshAll, isAdmin } = useApp()
  const isEdit = !!editRecord

  const problemOptions = useMemo(() => {
    const list = Object.values(data.problems || {})
    list.sort((a, b) => (a.difficulty ?? 9) - (b.difficulty ?? 9) || a.pid.localeCompare(b.pid))
    return list
  }, [data.problems])

  /** 题目目录 = 题名/难度/类别的唯一事实来源；目录里没有时才允许回退/手填 */
  const catalogOf = (pid) => (pid ? data.problems?.[pid] || null : null)
  const hasCatalogDiff = (p) => p && p.difficulty !== null && p.difficulty !== undefined && Number(p.difficulty) > 0

  const [form, setForm] = useState(() => {
    const r = editRecord
    const pid = r?.pid || lockPid || ''
    const p = catalogOf(pid) // ← 从矩阵格子「+ 提交测评」进来时也要立刻带出题名与难度
    return {
      model: r?.model || '',
      variant: r?.variant || '',
      thinking: r?.thinking || DEFAULT_THINKING,
      agent: r?.agent || '',
      tokenSource: r?.tokenSource || '',
      pid,
      title: p?.title ?? r?.title ?? '',
      difficulty: hasCatalogDiff(p) ? String(p.difficulty)
        : (r?.difficulty === null || r?.difficulty === undefined ? '' : String(r.difficulty)),
      categories: r?.categories?.length ? r.categories : (p?.categories || []),
      submissions: r?.submissions?.map((s) => ({ ...s })) || [{ score: '', result: 'AC', note: '' }],
      minutes: r?.minutes ?? '',
      memory: r?.memory ?? '',
      date: r?.date || todayStr(),
      note: r?.note || '',
    }
  })
  const [catInput, setCatInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const selectedProblem = catalogOf(form.pid)
  const diffLocked = hasCatalogDiff(selectedProblem)

  /** 换题目 = 题名/难度/类别整体以题目目录为准重新带入（不再残留上一题的值） */
  const applyProblem = (pid) => {
    const p = catalogOf(pid)
    setForm((f) => ({
      ...f,
      pid,
      title: p ? (p.title || '') : f.title,
      difficulty: hasCatalogDiff(p) ? String(p.difficulty) : (p ? '' : f.difficulty),
      categories: p ? [...(p.categories || [])] : f.categories,
    }))
  }

  const datalists = useMemo(() => {
    const agents = new Set()
    const tokens = new Set()
    const variants = new Set()
    for (const r of data.records || []) {
      if (r.agent) agents.add(r.agent)
      if (r.tokenSource) tokens.add(r.tokenSource)
      if (r.variant) variants.add(r.variant)
    }
    return { agents: [...agents], tokens: [...tokens], variants: [...variants] }
  }, [data.records])

  const modelNames = useMemo(() => {
    // 收录制：只能提交/编辑为已收录模型（未收录模型即使出现在历史记录里也不可选）
    const fromTable = models.map((m) => m.name)
    const sorted = [...fromTable].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    // 编辑场景：若当前记录的模型不在目录（历史隐藏数据），仍显示为占位以便识别
    if (isEdit && editRecord?.model && !fromTable.includes(editRecord.model)) {
      return [{ name: editRecord.model, placeholder: true }, ...sorted]
    }
    return sorted.map((name) => ({ name }))
  }, [models, data.records, isEdit, editRecord])

  const addCat = () => {
    const name = catInput.trim()
    if (!name) return
    if (!form.categories.includes(name)) set({ categories: [...form.categories, name] })
    setCatInput('')
  }

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    const modelInCatalog = models.some((m) => m.name === form.model.trim())
    if (!form.model.trim()) return setError('请选择已收录的 AI 模型')
    if (!modelInCatalog) return setError(`模型「${form.model.trim()}」尚未收录：请先让管理员在「AI 模型管理」中添加`)
    if (!form.pid) return setError('请选择已发布的题目')
    // 题名与难度以题目目录为准：目录里有就直接用（提交者改不了），确实没有才用手动补的值
    const finalTitle = selectedProblem ? (selectedProblem.title || form.title) : form.title
    const finalDifficulty = hasCatalogDiff(selectedProblem)
      ? Number(selectedProblem.difficulty)
      : Number(form.difficulty)
    if (!finalDifficulty) {
      return setError(`题目 ${form.pid} 在目录里没有难度信息：请联系管理员在「题目管理 → 编辑」补全`)
    }
    if (!form.submissions.length) return setError('至少需要一次提交记录')
    setBusy(true)
    try {
      const payload = {
        model: form.model.trim(),
        variant: form.variant,
        thinking: form.thinking,
        agent: form.agent,
        tokenSource: form.tokenSource,
        pid: form.pid,
        title: finalTitle,
        difficulty: finalDifficulty,
        categories: form.categories,
        submissions: form.submissions.map(normalizeSub),
        minutes: form.minutes === '' ? null : Number(form.minutes),
        memory: form.memory === '' ? null : Number(form.memory),
        date: form.date,
        note: form.note,
      }
      if (isEdit) {
        const res = await api(`/api/records/${editRecord.id}`, { method: 'PUT', body: { record: payload } })
        toast(res.message || '已更新测评记录')
      } else {
        const res = await api('/api/records', { method: 'POST', body: { record: payload } })
        toast(res.message || '已保存')
      }
      await refreshAll()
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal wide" onSubmit={submit}>
        <div className="modal-head">
          <h3>{isEdit ? `编辑测评 · ${editRecord.id}` : '提交测评记录'}</h3>
          <button type="button" className="icon-btn close" onClick={onClose}>✕</button>
        </div>

        {isEdit && !isAdmin && (
          <div className="callout" style={{ marginBottom: 'var(--sp-3)', borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' }}>
            <strong>提示：</strong>您正在修改自己提交的评测记录。保存后该记录将<strong>重新进入待审核状态</strong>，需管理员再次审核通过后计入统计。
          </div>
        )}

        <div className="grid3">
          <Field label="AI 模型（已收录）*">
            <input list="dl-models" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="选择已收录模型…" />
            <datalist id="dl-models">
              {modelNames.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.placeholder ? '（当前模型未收录，收录后恢复显示）' : ''}
                </option>
              ))}
            </datalist>
            <span className="chain" style={{ marginTop: 2 }}>
              只能选择「AI 模型管理」中已收录的模型；历史记录模型由管理员收录后自动显示。
            </span>
          </Field>
          <Field label="版本 / 策略">
            <input list="dl-variants" value={form.variant} onChange={(e) => set({ variant: e.target.value })} placeholder="可留空" />
            <datalist id="dl-variants">{datalists.variants.map((v) => <option key={v} value={v} />)}</datalist>
          </Field>
          <Field label="思考等级">
            <select value={form.thinking} onChange={(e) => set({ thinking: e.target.value })}>
              {THINKING_LEVELS.map((t) => <option key={t} value={t}>{THINKING_LABELS[t]}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid3">
          <Field label="Agent 工具">
            <input list="dl-agents" value={form.agent} onChange={(e) => set({ agent: e.target.value })} placeholder="如 Claude Code" />
            <datalist id="dl-agents">{datalists.agents.map((v) => <option key={v} value={v} />)}</datalist>
          </Field>
          <Field label="Token 来源">
            <input list="dl-tokens" value={form.tokenSource} onChange={(e) => set({ tokenSource: e.target.value })} placeholder="官方 API / 套餐填「官方」" />
            <datalist id="dl-tokens">{datalists.tokens.map((v) => <option key={v} value={v} />)}</datalist>
          </Field>
          <Field label="日期 *">
            <input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} />
          </Field>
        </div>

        <div className="grid3">
          <Field label="洛谷题目（仅已发布）*">
            <select value={form.pid} disabled={!!lockPid && !isEdit} onChange={(e) => applyProblem(e.target.value)}>
              <option value="">选择题目…</option>
              {problemOptions.map((p) => <option key={p.pid} value={p.pid}>{p.pid} · {p.title}</option>)}
            </select>
            {lockPid && !isEdit && <span className="chain">已按你点击的格子锁定题目，如需换题请关闭后重新进入</span>}
          </Field>
          <Field label="题名">
            <input value={form.title} onChange={(e) => set({ title: e.target.value })}
              disabled={!!selectedProblem} readOnly={!!selectedProblem}
              className={selectedProblem ? 'locked' : undefined}
              placeholder="选题目后自动带入" />
            {selectedProblem
              ? <span className="chain">🔒 题目目录带入，不可修改</span>
              : <span className="chain">选择题目后自动带入</span>}
          </Field>
          <Field label="难度 *">
            <select value={form.difficulty} onChange={(e) => set({ difficulty: e.target.value })}
              disabled={diffLocked} className={diffLocked ? 'locked' : undefined}>
              <option value="">选择难度…</option>
              {REC_DIFF_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {diffLocked
              ? <span className="chain">🔒 题目目录带入，不可修改</span>
              : <span className="chain">{selectedProblem ? '该题目录里还没有难度，请手动选择（并提醒管理员补全题目信息）' : '选择题目后自动带入'}</span>}
          </Field>
        </div>

        {isEdit && selectedProblem && (
          (editRecord?.title && editRecord.title !== (selectedProblem.title || ''))
          || (hasCatalogDiff(selectedProblem) && Number(editRecord?.difficulty) !== Number(selectedProblem.difficulty))
        ) && (
          <div className="callout" style={{ marginBottom: 'var(--sp-3)' }}>
            这条记录存的题名/难度与题目目录不一致（目录：{selectedProblem.pid} {selectedProblem.title} · 难度 {selectedProblem.difficulty}）。
            已按<strong>目录为准</strong>锁定，保存后会以目录值写回；要改题目信息请到「题目管理 → 编辑」。
          </div>
        )}

        {form.pid && data.problems?.[form.pid]?.prompt && (
          <div className="callout prompt-box" style={{ paddingRight: 12 }}>
            <div className="prompt-head">
              <span className="prompt-title">该题推荐提示词</span>
              <span className="chain">（统一测试口径 · 粘贴到你的 Agent 前先读一遍）</span>
              <CopyButton text={data.problems[form.pid].prompt} toast={toast} />
            </div>
            <pre style={{ maxHeight: 160, overflowY: 'auto' }}>{data.problems[form.pid].prompt}</pre>
          </div>
        )}

        <Field label="算法类别（回车添加）">
          <input
            list="dl-cats"
            value={catInput}
            onChange={(e) => setCatInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCat() } }}
            placeholder="输入后回车；可留空"
          />
          <datalist id="dl-cats">
            {['动态规划', '字符串', '图论', '搜索', '数据结构', '树', '二分/分治', '贪心', '模拟/枚举', '计算几何', '数学'].map((c) => <option key={c} value={c} />)}
          </datalist>
          <div className="cat-chips">
            {form.categories.map((c) => (
              <span key={c} className="cat-tag">
                {c}
                <button type="button" onClick={() => set({ categories: form.categories.filter((x) => x !== c) })}>✕</button>
              </span>
            ))}
          </div>
        </Field>

        <Field label="提交轮次（每轮：判定 / 得分 0–100 / 说明；无分数留空则不计入均分）">
          <div className="sub-rows">
            {form.submissions.map((s, i) => (
              <div className="sub-row" key={i}>
                <select
                  value={s.result}
                  onChange={(e) => set({ submissions: form.submissions.map((x, j) => j === i ? { ...x, result: e.target.value } : x) })}
                >
                  {RESULTS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <input
                  type="number" min="0" max="100" placeholder="得分"
                  value={s.score ?? ''}
                  onChange={(e) => set({ submissions: form.submissions.map((x, j) => j === i ? { ...x, score: e.target.value === '' ? null : Number(e.target.value) } : x) })}
                />
                <input
                  placeholder="本轮说明（可空）"
                  value={s.note || ''}
                  onChange={(e) => set({ submissions: form.submissions.map((x, j) => j === i ? { ...x, note: e.target.value } : x) })}
                />
                <button type="button" className="icon-btn del" title="删除本轮"
                  onClick={() => set({ submissions: form.submissions.filter((_, j) => j !== i) })}
                  disabled={form.submissions.length <= 1}
                >✕</button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn small" onClick={() => set({ submissions: [...form.submissions, { score: '', result: 'WA', note: '' }] })}>
              + 添加一轮
            </button>
            <span className="sub-summary">
              共 {form.submissions.length} 轮；有分数轮次 {form.submissions.filter((s) => s.score !== null && s.score !== '').length} 个
            </span>
          </div>
        </Field>

        <div className="grid3">
          <Field label="总用时（分钟）">
            <input type="number" min="0" value={form.minutes ?? ''} onChange={(e) => set({ minutes: e.target.value })} />
          </Field>
          <Field label="内存（MB）">
            <input type="number" min="0" value={form.memory ?? ''} onChange={(e) => set({ memory: e.target.value })} />
          </Field>
          <Field label="备注">
            <input value={form.note} onChange={(e) => set({ note: e.target.value })} />
          </Field>
        </div>

        {error && <div className="form-error">{error}</div>}
        {!isEdit && !lockPid && (
          <div className="callout">
            提交后{`「管理员」直接计入统计，「贡献者」进入待审核队列`}。游客不可提交，需注册并等待站长审核。
          </div>
        )}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </div>
  )
}
