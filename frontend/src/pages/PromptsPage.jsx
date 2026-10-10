import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import Topbar from '../components/Topbar'
import PromptCopyButton from '../components/PromptCopyButton'
import PidLink from '../components/PidLink'
import PageHeading from '../components/PageHeading'
import { useApp } from '../state'
import { useProblem } from '../hooks/useProblem'
import { difficultyName, luoguUrl, promptOf, standardPrompt, DIFFICULTY_NAMES } from '../aggregate'

export default function PromptsPage() {
  const { data, toast } = useApp()
  const workspaceRef = useRef(null)
  const [expandedPid, setExpandedPid] = useState('')
  const [page, setPage] = useState(0)

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
    return problemList[0]?.pid || ''
  })
  const resolvedPid = selectedPid || problemList[0]?.pid || 'P1001'
  const detail = useProblem(resolvedPid)

  // 手动输入的自定义题号（允许查询未在题库收录的洛谷题）
  const [inputPid, setInputPid] = useState('')

  // 过滤状态
  const [keyword, setKeyword] = useState('')
  const deferredKeyword = useDeferredValue(keyword)
  const [diffFilter, setDiffFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all') // all | custom | standard

  // 筛选后的题目列表
  const filteredList = useMemo(() => {
    const q = deferredKeyword.trim().toLowerCase()
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
  }, [problemList, deferredKeyword, diffFilter, typeFilter])
  const pages = Math.max(1, Math.ceil(filteredList.length / 20))
  const currentPage = Math.min(page, pages - 1)
  const visibleProblems = filteredList.slice(currentPage * 20, (currentPage + 1) * 20)

  // 计算当前聚焦题目的详细信息（raw 供 PromptCopyButton 判断附件与拼装模板）
  const activeProblem = useMemo(() => {
    const targetPid = String(resolvedPid).trim().toUpperCase()
    const found = data.problems?.[targetPid] ? detail.problem || data.problems[targetPid] : null
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
  }, [resolvedPid, data.problems, detail.problem])

  const handleSelectPid = (pid) => {
    setSelectedPid(pid)
    setExpandedPid(pid)
    setInputPid('')
    workspaceRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }

  const handleCustomInputSubmit = (e) => {
    e.preventDefault()
    const raw = inputPid.trim().toUpperCase()
    if (!raw) return
    setSelectedPid(raw)
    setExpandedPid(raw)
  }

  return (
    <>
      <Topbar />
      <main className="layout" aria-busy={keyword !== deferredKeyword}>
        <PageHeading title="推荐提示词库" description="选题、复制，开始评测。完整模板与使用说明按需展开。" eyebrow="ALGORITHM RADAR / PROMPTS" />

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
        <div className="card prompt-workspace" ref={workspaceRef} style={{ scrollMarginTop: 'calc(var(--shell-height) + 16px)' }}>
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
                aria-label="查阅题号"
                placeholder="输入任意题号如 P1002"
                value={inputPid}
                onChange={(e) => setInputPid(e.target.value)}
                style={{ width: 170, padding: '4px 10px', fontSize: 'var(--fs-sm)' }}
              />
              <button type="submit" className="btn small">查看</button>
            </form>
          </div>

          <div className="prompt-box" style={{ marginTop: 'var(--sp-2)' }}>
            {detail.error && <div className="form-error" role="alert">{detail.error}<button className="btn small" onClick={detail.retry}>重试</button></div>}
            <div className="prompt-head">
              <span className="chain">复制时可选择模型，自动填入工作区名称。</span>
              <PromptCopyButton
                problem={activeProblem.raw || { pid: activeProblem.pid }}
                toast={toast}
                label="复制本题提示词"
                kind="primary"
                okLabel="已复制提示词"
              />
            </div>
            <p className="prompt-preview">{detail.loading ? '加载题面…' : activeProblem.prompt.split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 130) + (activeProblem.prompt.length > 130 ? '…' : '')}</p>
            <details key={activeProblem.pid} className="content-disclosure" open={expandedPid === activeProblem.pid} onToggle={(event) => {
              if (event.currentTarget.open !== (expandedPid === activeProblem.pid)) setExpandedPid(event.currentTarget.open ? activeProblem.pid : '')
            }}>
              <summary><ChevronDown size={16} /><span>完整提示词</span><small>{activeProblem.prompt.length.toLocaleString()} 字 · 可直接复制</small></summary>
              <pre>{detail.loading ? '加载题面…' : activeProblem.prompt}</pre>
            </details>
          </div>
        </div>

        {/* 规范指南 Callout */}
        <details className="content-disclosure prompt-guide">
          <summary><ChevronDown size={16} /><span>使用步骤与统一评测口径</span><small>首次评测时阅读</small></summary>
          <div className="disclosure-body" style={{ fontSize: 'var(--fs-sm)' }}>
          建立工作区文件夹后发送给待测 AI；保留占位符时，先把 <code>{'{模型id}'}</code> 替换为实际模型名。
          <strong>统一口径说明：</strong>
          为确保不同模型在算法题上的横向对比公平客观，雷达站建议评测者使用上述统一推荐提示词。提示词要求被测模型：
          ① 在限定的 <code>{'{模型id}_{题号}'}</code> 工作区文件夹内独立完成（禁止联网、搜索、网页抓取与读取工作区外的本地文件，禁止背题）；
          ② 直接以站点录入的题面 markdown 与时间/内存限制作答依据；
          ③ 给出最终可交付的文件（含附件的题请先从洛谷下载附件放入工作区）。
          题号旁的「{activeProblem.isCustom ? '专属定制' : '标准统一模板'}」标记表示该题使用管理员定制提示词还是标准模板。
          </div>
        </details>

        {/* 全量题目提示词检索表 */}
        <div className="card">
          <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h2 style={{ margin: 0 }}>题目索引</h2>
              <span className="hint">直接复制，或查看完整提示词。</span>
            </div>

            {/* 筛选栏 */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="search"
                aria-label="搜索提示词题目"
                placeholder="搜索题号 / 题名 / 标签…"
                value={keyword}
                onChange={(e) => {setKeyword(e.target.value); setPage(0)}}
                style={{ width: 200, padding: '4px 10px', fontSize: 'var(--fs-sm)' }}
              />
              <select
                value={diffFilter}
                aria-label="题目难度"
                onChange={(e) => {setDiffFilter(e.target.value); setPage(0)}}
                style={{ padding: '4px 8px', fontSize: 'var(--fs-sm)' }}
              >
                <option value="all">全部难度</option>
                {Object.entries(DIFFICULTY_NAMES).map(([idx, name]) => (
                  <option key={idx} value={String(idx)}>{name}</option>
                ))}
              </select>
              <select
                value={typeFilter}
                aria-label="提示词类型"
                onChange={(e) => {setTypeFilter(e.target.value); setPage(0)}}
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
                  <th style={{ width: 140, textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleProblems.map((p) => {
                  const hasCustom = Boolean(p.prompt && p.prompt.trim())
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
                      <td className="actions" style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          <button
                            type="button"
                            className="btn small ghost"
                            onClick={() => handleSelectPid(p.pid)}
                            aria-label={`查看 ${p.pid} 提示词`}
                            title="在顶部卡片中展开并查看此题提示词"
                          >
                            查看
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
                    <td colSpan={6}>
                      <div className="empty">没有匹配的题目</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="prompt-pager"><span role="status">{filteredList.length} 道题 · 第 {currentPage + 1} / {pages} 页</span><div>
            <button className="btn small ghost" aria-label="上一页题目" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} />上一页</button>
            <button className="btn small ghost" aria-label="下一页题目" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>下一页<ChevronRight size={16} /></button>
          </div></div>
        </div>
      </main>
    </>
  )
}
