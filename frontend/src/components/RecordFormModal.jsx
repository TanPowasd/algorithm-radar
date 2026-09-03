import { useMemo, useState } from 'react'
import { useApp } from '../state'
import { api } from '../api/client'
import { normalizeSub, RESULTS, THINKING_LEVELS, THINKING_LABELS, DEFAULT_THINKING, todayStr, PID_RE } from '../aggregate'

function Field({ label, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  )
}

export default function RecordFormModal({ editRecord, lockPid, onClose }) {
  const { data, models, toast, refreshAll } = useApp()
  const isEdit = !!editRecord

  const problemOptions = useMemo(() => {
    const list = Object.values(data.problems || {})
    list.sort((a, b) => (a.difficulty ?? 9) - (b.difficulty ?? 9) || a.pid.localeCompare(b.pid))
    return list
  }, [data.problems])

  const [form, setForm] = useState(() => {
    const r = editRecord
    return {
      model: r?.model || '',
      variant: r?.variant || '',
      thinking: r?.thinking || DEFAULT_THINKING,
      agent: r?.agent || '',
      tokenSource: r?.tokenSource || '',
      pid: r?.pid || lockPid || '',
      title: r?.title || '',
      difficulty: r?.difficulty ?? '',
      categories: r?.categories || [],
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

  const applyProblem = (pid) => {
    const p = data.problems?.[pid]
    setForm((f) => ({
      ...f,
      pid,
      title: p?.title || f.title,
      difficulty: p?.difficulty ?? f.difficulty,
      categories: f.categories.length ? f.categories : (p?.categories || []),
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
    if (form.difficulty === '' || form.difficulty === null) return setError('请选择难度')
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
        title: form.title,
        difficulty: Number(form.difficulty),
        categories: form.categories,
        submissions: form.submissions.map(normalizeSub),
        minutes: form.minutes === '' ? null : Number(form.minutes),
        memory: form.memory === '' ? null : Number(form.memory),
        date: form.date,
        note: form.note,
      }
      if (isEdit) {
        await api(`/api/records/${editRecord.id}`, { method: 'PUT', body: { record: payload } })
        toast('已更新测评记录')
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

        <div className="grid3">
          <Field label="AI 模型（已收录）*">
            <input list="dl-models" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="选择已收录模型…"
              onInput={(e) => { /* 允许清空；提交时校验 */ }} />
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
          </Field>
          <Field label="题名">
            <input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="选题目后自动带入" />
          </Field>
          <Field label="难度 *">
            <select value={form.difficulty} onChange={(e) => set({ difficulty: e.target.value })}>
              <option value="">选择难度…</option>
              {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{['', '入门', '普及−', '普及/提高−', '普及+/提高', '提高+/省选−', '省选/NOI−', 'NOI/NOI+/CTSC'][d]}</option>)}
            </select>
          </Field>
        </div>

        {form.pid && data.problems?.[form.pid]?.prompt && (
          <div className="callout" style={{ position: 'relative', paddingRight: 90 }}>
            <strong style={{ color: 'var(--accent)' }}>该题推荐提示词</strong>
            <span className="chain">（统一测试口径）</span>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-sm)', color: 'var(--text)', marginTop: 4, maxHeight: 120, overflowY: 'auto' }}>
              {data.problems[form.pid].prompt}
            </div>
            <button
              type="button"
              className="btn small"
              style={{ position: 'absolute', top: 10, right: 10 }}
              onClick={() => {
                navigator.clipboard.writeText(data.problems[form.pid].prompt)
                  .then(() => toast('推荐提示词已复制'))
                  .catch(() => toast('复制失败，请手动选择文本', 'err'))
              }}
            >复制</button>
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
