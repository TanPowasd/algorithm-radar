import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Topbar from '../components/Topbar'
import PromptCopyButton from '../components/PromptCopyButton'
import PidLink from '../components/PidLink'
import { useApp } from '../state'
import { difficultyName, luoguUrl, promptOf, standardPrompt, DIFFICULTY_NAMES } from '../aggregate'

export default function PromptsPage() {
  const { data, toast } = useApp()

  // 题目列表，从 data.problems 取出
  const problemList = useMemo(() => {
    return Object.values(data.problems || {}).sort((a, b) => {
      // 默认按难度升序，难度相同按题号字典序
      const da = a.difficulty ?? 99
      const db = b.difficulty ?? 99
      if (da !== db) return da - db
      return String(a.pid).localeCompare(String(b.pid))
    })
  }, [data.problems])

  // 统计数据
  const stats = useMemo(() => {
    const total = problemList.length
    const customCount = problemList.filter((p) => Boolean(p.prompt && p.prompt.trim())).length
    const standardCount = total - customCount
    return { total, customCount, standardCount }
  }, [problemList])

  // 当前聚焦选中的题目（默认选第一道题或空）
  const [selectedPid, setSelectedPid] = useState(() => {
    return problemList[0]?.pid || 'P1001'
  })

  // 手动输入的自定义题号（允许查询未在题库收录的洛谷题）
  const [inputPid, setInputPid] = useState('')

  // 过滤状态
  const [keyword, setKeyword] = useState('')
  const [diffFilter, setDiffFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all') // all | custom | standard

  // 筛选后的题目列表
  const filteredList = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    return problemList.filter((p) => {
      if (diffFilter !== 'all' && String(p.difficulty ?? '') !== diffFilter) return false
      const hasCustom = Boolean(p.prompt && p.prompt.trim())
      if (typeFilter === 'custom' && !hasCustom) return false
      if (typeFilter === 'standard' && hasCustom) return false

      if (!q) return true
      const matchPid = String(p.pid).toLowerCase().includes(q)
      const matchTitle = String(p.title || '').toLowerCase().includes(q)
      const matchTags = (p.tags || []).some((t) => String(t).toLowerCase().includes(q))
      return matchPid || matchTitle || matchTags
    })
  }, [problemList, keyword, diffFilter, typeFilter])

  // 计算当前聚焦题目的详细信息（raw 供 PromptCopyButton 判断附件与拼装模板）
  const activeProblem = useMemo(() => {
    const targetPid = String(selectedPid || '').trim().toUpperCase() || (problemList[0]?.pid || 'P1001')
    const found = data.problems?.[targetPid]
    if (found) {
      return {
        pid: found.pid,
        title: found.title || '（未命名）',
        difficulty: found.difficulty,
        tags: Array.isArray(found.tags) ? found.tags : [],
        isCustom: Boolean(found.prompt && String(found.prompt).trim()),
        prompt: promptOf(found),
        raw: found,
        isExisting: true,
      }
    }
    // 未收录的题号
    return {
      pid: targetPid,
      title: '外部题目 / 自定义题号',
      difficulty: null,
      tags: [],
      isCustom: false,
      prompt: standardPrompt({ pid: targetPid }),
      raw: null,
      isExisting: false,
    }
  }, [selectedPid, data.problems, problemList])

  const handleSelectPid = (pid) => {
    setSelectedPid(pid)
    setInputPid('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleCustomInputSubmit = (e) => {
    e.preventDefault()
    const raw = inputPid.trim().toUpperCase()
    if (!raw) return
    setSelectedPid(raw)
  }

  return (
    <>
      <Topbar />
      <main className="layout">
        <div className="page-head">
          <div>
            <h2>推荐提示词库</h2>
            <span className="desc">
              统一测试口径 · 向所有人开放 · 支持按题号快速查阅与一键复制标准评测提示词
            </span>
          </div>
        </div>

        {/* 顶部统计卡片 */}
        <div className="stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="stat">
            <div className="s-label"><span className="tone-dot tone-accent" />收录题目总量</div>
            <div className="s-value">{stats.total}</div>
          </div>
          <div className="stat">
            <div className="s-label"><span className="tone-dot tone-green" />专属定制提示词</div>
            <div className="s-value">{stats.customCount}</div>
          </div>
          <div className="stat">
            <div className="s-label"><span className="tone-dot tone-purple" />统一标准模板</div>
            <div className="s-value">{stats.standardCount}</div>
          </div>
        </div>

        {/* 核心工作区：当前选中题目的推荐提示词展示与复制 */}
        <div className="card" style={{ border: '1px solid var(--accent-soft)', boxShadow: 'var(--glow)' }}>
          <div className="card-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <PidLink pid={activeProblem.pid} />
                  <span>· {activeProblem.title}</span>
                </h2>
                {activeProblem.difficulty !== null && (
                  <span className={`diff-tag d-${activeProblem.difficulty}`}>
                    {difficultyName(activeProblem.difficulty)}
                  </span>
                )}
                {activeProblem.isCustom ? (
                  <span className="status-tag role-admin" title="由管理员专门为该题定制的统一测试口径">
                    专属定制
                  </span>
                ) : (
                  <span className="status-tag role-contributor" title="遵循雷达站标准的统一测试口径模板">
                    标准统一模板
                  </span>
                )}
                {!activeProblem.isExisting && (
                  <span className="status-tag role-legacy">未收录题目</span>
                )}
              </div>
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {activeProblem.tags.map((t) => (
                  <span key={t} className="cat-tag">{t}</span>
                ))}
                {luoguUrl(activeProblem.pid) && (
                  <a
                    href={luoguUrl(activeProblem.pid)}
                    target="_blank"
                    rel="noreferrer"
                    className="chain"
                    style={{ fontSize: 'var(--fs-xs)', textDecoration: 'underline' }}
                  >
                    前往洛谷查看原题面 ↗
                  </a>
                )}
              </div>
            </div>

            {/* 快速定位任意题号输入框 */}
            <form onSubmit={handleCustomInputSubmit} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="text"
                placeholder="输入任意题号如 P1002"
                value={inputPid}
                onChange={(e) => setInputPid(e.target.value)}
                style={{ width: 170, padding: '4px 10px', fontSize: 'var(--fs-sm)' }}
              />
              <button type="submit" className="btn small">查看</button>
            </form>
          </div>

          <div className="callout prompt-box" style={{ marginTop: 'var(--sp-2)' }}>
            <div className="prompt-head">
              <span className="prompt-title">该题推荐提示词内容</span>
              <span className="chain">（建立工作区文件夹后发送给待测 AI 模型；发送前把 <code>{'{模型id}'}</code> 占位符替换为实际模型名）</span>
              <PromptCopyButton
                problem={activeProblem.raw || { pid: activeProblem.pid }}
                toast={toast}
                label="一键复制本题提示词"
                okLabel="已复制提示词"
              />
            </div>
            <pre style={{ maxHeight: 280, overflowY: 'auto', padding: '12px 16px', background: 'var(--surface-3)', borderRadius: 'var(--r-sm)' }}>
              {activeProblem.prompt}
            </pre>
          </div>
        </div>

        {/* 规范指南 Callout */}
        <div className="callout" style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.6 }}>
          <strong>统一口径说明：</strong>
          为确保不同模型在算法题上的横向对比公平客观，雷达站建议评测者使用上述统一推荐提示词。提示词要求被测模型：
          ① 在限定的 <code>{'{模型id}_{题号}'}</code> 工作区文件夹内独立完成（禁止联网、搜索、网页抓取与读取工作区外的本地文件，禁止背题）；
          ② 直接以站点录入的题面 markdown 与时间/内存限制作答依据；
          ③ 给出最终可交付的文件（含附件的题请先从洛谷下载附件放入工作区）。
          题号旁的「{activeProblem.isCustom ? '专属定制' : '标准统一模板'}」标记表示该题使用管理员定制提示词还是标准模板。
        </div>

        {/* 全量题目提示词检索表 */}
        <div className="card">
          <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h2 style={{ margin: 0 }}>题目索引与提示词快捷复制</h2>
              <span className="hint">点击「复制」快速获取提示词，点击「聚焦」查看完整内容</span>
            </div>

            {/* 筛选栏 */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="search"
                placeholder="搜索题号 / 题名 / 标签…"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                style={{ width: 200, padding: '4px 10px', fontSize: 'var(--fs-sm)' }}
              />
              <select
                value={diffFilter}
                onChange={(e) => setDiffFilter(e.target.value)}
                style={{ padding: '4px 8px', fontSize: 'var(--fs-sm)' }}
              >
                <option value="all">全部难度</option>
                {Object.entries(DIFFICULTY_NAMES).map(([idx, name]) => (
                  <option key={idx} value={String(idx)}>{name}</option>
                ))}
              </select>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                style={{ padding: '4px 8px', fontSize: 'var(--fs-sm)' }}
              >
                <option value="all">全部类型</option>
                <option value="custom">仅专属定制</option>
                <option value="standard">仅标准模板</option>
              </select>
            </div>
          </div>

          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 100 }}>题号</th>
                  <th>题名</th>
                  <th style={{ width: 100 }}>难度</th>
                  <th>标签</th>
                  <th style={{ width: 110 }}>口径类型</th>
                  <th style={{ minWidth: 260 }}>提示词预览</th>
                  <th style={{ width: 140, textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredList.map((p) => {
                  const hasCustom = Boolean(p.prompt && p.prompt.trim())
                  const finalPrompt = promptOf(p)
                  const isCurrent = activeProblem.pid === p.pid

                  return (
                    <tr
                      key={p.pid}
                      style={{ background: isCurrent ? 'var(--accent-soft)' : undefined }}
                    >
                      <td>
                        <PidLink pid={p.pid} />
                      </td>
                      <td>
                        <span style={{ fontWeight: 600 }}>{p.title}</span>
                      </td>
                      <td>
                        <span className={`diff-tag d-${p.difficulty ?? 0}`}>
                          {difficultyName(p.difficulty)}
                        </span>
                      </td>
                      <td style={{ maxWidth: 220, whiteSpace: 'normal' }}>
                        {(p.tags || []).slice(0, 5).map((t) => (
                          <span key={t} className="cat-tag">{t}</span>
                        ))}
                        {(p.tags || []).length > 5 && <span className="chain">…</span>}
                      </td>
                      <td>
                        {hasCustom ? (
                          <span className="status-tag role-admin" style={{ fontSize: 'var(--fs-xs)' }}>专属定制</span>
                        ) : (
                          <span className="status-tag role-contributor" style={{ fontSize: 'var(--fs-xs)' }}>统一模板</span>
                        )}
                      </td>
                      <td>
                        <div
                          style={{
                            maxWidth: 320,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            color: 'var(--text-2)',
                            fontSize: 'var(--fs-xs)',
                          }}
                          title={finalPrompt}
                        >
                          {finalPrompt}
                        </div>
                      </td>
                      <td className="actions" style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          <button
                            type="button"
                            className="btn small ghost"
                            onClick={() => handleSelectPid(p.pid)}
                            title="在顶部卡片中展开并查看此题提示词"
                          >
                            聚焦
                          </button>
                          <PromptCopyButton
                            problem={p}
                            toast={toast}
                            size="small"
                            label="复制"
                            okLabel="已复制"
                            title="复制该题提示词"
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {!filteredList.length && (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty">没有匹配的题目</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </>
  )
}
