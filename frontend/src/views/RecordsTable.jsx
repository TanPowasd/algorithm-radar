import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApp } from '../state'
import { api } from '../api/client'
import DeleteRecordButton from '../components/DeleteRecordButton'
import PidLink from '../components/PidLink'
import {
  applyFilters, difficultyName, fmtClock, fmtDateTime, lastSub, recordLine, recordTs, subBadgeClass, seriesKey,
  seriesList, THINKING_LABELS, isPending, providerLabel, reviewerLabel, filterByModels, filterByContributor,
} from '../aggregate'
import { useUrlState } from '../hooks/useUrlState'

const PAGE_SIZE = 50
const FILTER_KEYS = ['keyword', 'series', 'difficulty', 'category', 'result', 'thinking', 'onlyMine']

function diffClass(d) { return `d-${d ?? 0}` }

/** 分数文案：v2（decimal）按指定位数（true 兼容 5 位）；悬停提示始终给 5 位完整值；老版保持原样 */
const scoreText = (score, decimal) => (score === null || score === undefined ? '' : (decimal ? Number(score).toFixed(typeof decimal === 'number' ? decimal : 5) : String(score)))
const scoreTitle = (score, decimal) => (score === null || score === undefined ? '无分' : (decimal ? Number(score).toFixed(5) : String(score)))

export default function RecordsTable({ onOpenDetail, onEdit, isAdmin, blankEmpty = false, defaultExpanded = false, decimal = false }) {
  const { data, session, nicknameOf, nameByUid, focusModels, focusContributor, toast, refreshAll } = useApp()
  const url = useUrlState('rec')
  const [filters, setFilters] = useState(() => {
    const init = { keyword: '', series: '', difficulty: '', category: '', result: '', thinking: '', onlyMine: false }
    for (const k of FILTER_KEYS) {
      const v = url.get(k, '')
      if (k === 'onlyMine') {
        if (v === '1' || v === 'true') init.onlyMine = true
      } else if (v) {
        init[k] = v
      }
    }
    return init
  })
  const [sort, setSort] = useState(() => {
    const k = url.get('sort', 'date')
    const d = url.get('dir', 'desc')
    return { key: k, dir: d === 'asc' ? 'asc' : 'desc' }
  })
  const [page, setPage] = useState(() => Number(url.get('page', '')) || 0)
  const [collapsed, setCollapsed] = useState(() => {
    // v2 直接在页面里切换视图，进来看就该是展开的
    if (defaultExpanded) return false
    const hasUrlQuery = Boolean(
      url.get('keyword') || url.get('series') || url.get('difficulty') ||
      url.get('category') || url.get('result') || url.get('thinking') ||
      url.get('onlyMine') || url.get('page')
    )
    if (hasUrlQuery) return false
    try {
      const v = localStorage.getItem('radar.records.collapsed')
      return v === null ? true : v === 'true'
    } catch {
      return true
    }
  })

  const toggleCollapse = () => {
    setCollapsed((v) => {
      const next = !v
      try { localStorage.setItem('radar.records.collapsed', String(next)) } catch {}
      return next
    })
  }

  useEffect(() => {
    let focusTimer
    const focusSearch = () => {
      setCollapsed(false)
      try { localStorage.setItem('radar.records.collapsed', 'false') } catch {}
      clearTimeout(focusTimer)
      focusTimer = setTimeout(() => {
        const el = document.getElementById('f-keyword')
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
          el.focus()
          el.select?.()
        }
      }, 60)
    }
    const onKey = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('[aria-modal="true"]')) return
      const tag = e.target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        focusSearch()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('radar:focus-records', focusSearch)
    return () => {
      clearTimeout(focusTimer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('radar:focus-records', focusSearch)
    }
  }, [])

  const isMyRecord = useCallback((r) => Boolean(
    session.loggedIn && (
      (session.uid && r.authorId === session.uid)
    )
  ), [session.loggedIn, session.uid])

  const visibleSource = useMemo(() => {
    // 所有通过记录（受贡献者视角 + 模型聚焦约束）+ 当前登录者自己的待审记录（不受贡献者筛选影响，保持可改）
    const list = (data.records || []).filter((r) => !isPending(r) || isMyRecord(r))
    return [
      ...filterByContributor(filterByModels(list.filter((r) => !isPending(r)), focusModels), focusContributor),
      ...list.filter(isPending),
    ]
  }, [data.records, focusModels, focusContributor, isMyRecord])

  const filtered = useMemo(() => {
    let list = visibleSource
    if (filters.onlyMine) {
      list = list.filter(isMyRecord)
    }
    return applyFilters(list, { ...filters, includePending: true })
  }, [visibleSource, filters, isMyRecord])

  const myTotalCount = useMemo(() => {
    if (!session.loggedIn) return 0
    return (data.records || []).filter(isMyRecord).length
  }, [data.records, session.loggedIn, isMyRecord])

  const sorted = useMemo(() => {
    const list = [...filtered]
    const { key, dir } = sort
    const mul = dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      let va = a[key]
      let vb = b[key]
      if (key === 'date') return (recordTs(a) - recordTs(b)) * mul
      if (key === 'difficulty') { va = va ?? -1; vb = vb ?? -1; return (va - vb) * mul }
      if (key === 'minutes' || key === 'memory') { va = va ?? -1; vb = vb ?? -1; return (va - vb) * mul }
      if (key === 'submissions') {
        va = lastSub(a)?.score ?? -1
        vb = lastSub(b)?.score ?? -1
        return (va - vb) * mul
      }
      va = String(va ?? '')
      vb = String(vb ?? '')
      return va.localeCompare(vb, 'zh-Hans-CN') * mul
    })
    return list
  }, [filtered, sort])

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const safePage = Math.min(page, pages - 1)
  const pageRows = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  /* ---------- 管理员/站长：勾选批量删除（走既有 bulk 接口，reject = 软删除进回收站） ---------- */
  const [selected, setSelected] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  // 记录被删掉/换数据后，自动把已消失的 id 从选择里剔掉（切筛选不会误清选择）
  const knownIds = useMemo(() => new Set((data.records || []).map((r) => r.id)), [data.records])
  const selIds = useMemo(() => new Set([...selected].filter((id) => knownIds.has(id))), [selected, knownIds])
  const selectedRecords = useMemo(
    () => (data.records || []).filter((r) => selIds.has(r.id)), [data.records, selIds])
  const allPageSelected = pageRows.length > 0 && pageRows.every((r) => selIds.has(r.id))

  const toggleRow = (id) => setSelected((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })
  const togglePage = () => setSelected((s) => {
    const n = new Set(s)
    if (allPageSelected) pageRows.forEach((r) => n.delete(r.id))
    else pageRows.forEach((r) => n.add(r.id))
    return n
  })

  const bulkDelete = async () => {
    if (!selectedRecords.length) return
    const preview = selectedRecords.slice(0, 6).map((r) => `· ${recordLine(r)}`).join('\n')
    const ok = window.confirm(
      `把选中的 ${selectedRecords.length} 条测评记录移入回收站？\n\n${preview}${selectedRecords.length > 6 ? `\n… 等共 ${selectedRecords.length} 条` : ''}\n\n`
      + '删除 = 软删除进回收站，统计/矩阵/榜单/滚榜立即不再计入；\n可在「审核台 → 回收站」恢复，或在那里永久清除。')
    if (!ok) return
    setBulkBusy(true)
    try {
      const res = await api('/api/records/bulk', {
        method: 'POST',
        body: { ids: selectedRecords.map((r) => r.id), action: 'reject' },
      })
      setSelected(new Set())
      await refreshAll()
      toast(`已移入回收站 ${res.affected} 条`)
    } catch (e) {
      toast(e.message || '批量删除失败', 'err')
    } finally {
      setBulkBusy(false)
    }
  }

  const seriesOpts = seriesList(visibleSource)
  useEffect(() => {
    if (filters.series && !seriesOpts.includes(filters.series)) {
      setFilters((f) => ({ ...f, series: '' }))
    }
  }, [seriesOpts.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  const categoryOpts = useMemo(() => {
    const set = new Set()
    visibleSource.forEach((r) => (r.categories || []).forEach((c) => set.add(c)))
    return [...set].sort()
  }, [visibleSource])

  /** 筛选/排序/翻页写进 URL（?rec:keyword=…），刷新与分享都保持现场 */
  const setF = (patch) => {
    setFilters((f) => ({ ...f, ...patch }))
    setPage(0)
    const urlPatch = { ...patch, page: '' }
    if ('onlyMine' in patch) {
      urlPatch.onlyMine = patch.onlyMine ? '1' : ''
    }
    url.setMany(urlPatch)
  }
  const setSortBoth = (next) => {
    setSort(next)
    url.setMany({ sort: next.key, dir: next.dir })
  }
  const goPage = (p) => {
    setPage(p)
    url.set('page', p === 0 ? '' : p)
  }
  const clearAll = () => {
    const blank = { keyword: '', series: '', difficulty: '', category: '', result: '', thinking: '', onlyMine: false }
    setFilters(blank)
    setPage(0)
    url.setMany({ ...blank, onlyMine: '', page: '' })
  }

  const th = (key, label) => (
    <th
      className={`sortable ${sort.key === key ? 'sorted' : ''}`}
      title="点击切换排序"
      onClick={() => setSortBoth({ key, dir: sort.key === key ? (sort.dir === 'asc' ? 'desc' : 'asc') : 'desc' })}
    >
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )

  const hasFilter = !!(filters.keyword || filters.series || filters.difficulty !== '' || filters.category || filters.result || filters.thinking || filters.onlyMine)

  const onHeadClick = (e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a')) return
    toggleCollapse()
  }

  return (
    <div className="card" id="records-card">
      <div
        className="card-head"
        style={{ marginBottom: collapsed ? 0 : undefined, cursor: 'pointer', userSelect: 'none' }}
        onClick={onHeadClick}
      >
        <h2>测评明细</h2>
        <span className="hint" id="records-count">
          {hasFilter ? `已筛选 ${filtered.length} 条` : `${filtered.length} 条`}
        </span>
        <div className="card-tools">
          {hasFilter && (
            <button
              type="button"
              className="btn small ghost"
              onClick={(e) => { e.stopPropagation(); clearAll(); }}
            >
              清除筛选
            </button>
          )}
          {collapsed ? (
            <button
              type="button"
              className="btn small ghost"
              onClick={(e) => { e.stopPropagation(); toggleCollapse(); }}
              title="展开测评明细表格"
            >
              展开明细 ▾
            </button>
          ) : (
            <>
              <span className="hint">时间列 = 测评日期 + 录入时分</span>
              <button
                type="button"
                className="btn small ghost"
                onClick={(e) => { e.stopPropagation(); toggleCollapse(); }}
                title="收起测评明细表格"
              >
                收起明细 ▴
              </button>
            </>
          )}
        </div>
      </div>
      {!collapsed && (
        <>
          <div className="filters">
        <input
          id="f-keyword" placeholder="搜索 题号/标题/模型/备注…（按 F 聚焦）" value={filters.keyword}
          onChange={(e) => setF({ keyword: e.target.value })}
        />
        <select id="f-series" value={filters.series} onChange={(e) => setF({ series: e.target.value })}>
          <option value="">全部模型</option>
          {seriesOpts.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select id="f-difficulty" value={filters.difficulty} onChange={(e) => setF({ difficulty: e.target.value })}>
          <option value="">全部难度</option>
          {Object.entries({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 }).map(([d]) => (
            <option key={d} value={d}>{difficultyName(Number(d))}</option>
          ))}
        </select>
        <select id="f-category" value={filters.category} onChange={(e) => setF({ category: e.target.value })}>
          <option value="">全部类别</option>
          {categoryOpts.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select id="f-thinking-filter" value={filters.thinking} onChange={(e) => setF({ thinking: e.target.value })}>
          <option value="">全部思考等级</option>
          {Object.entries(THINKING_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select id="f-result" value={filters.result} onChange={(e) => setF({ result: e.target.value })}>
          <option value="">全部结果</option>
          <option value="first">首轮 AC</option>
          <option value="final">最终 AC</option>
          <option value="fail">未通过</option>
        </select>
        {session.loggedIn && (
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              cursor: 'pointer',
              userSelect: 'none',
              fontSize: 'var(--fs-sm)',
              padding: '4px 10px',
              borderRadius: 'var(--r-sm)',
              background: filters.onlyMine ? 'var(--accent-soft)' : 'var(--surface-2)',
              border: '1px solid',
              borderColor: filters.onlyMine ? 'var(--accent)' : 'var(--border-soft)',
              color: filters.onlyMine ? 'var(--accent)' : 'var(--text-2)',
            }}
            title="仅查看当前登录账号提交的评测记录（含已通过与待审核）"
          >
            <input
              type="checkbox"
              checked={filters.onlyMine}
              onChange={(e) => setF({ onlyMine: e.target.checked })}
              style={{ margin: 0 }}
            />
            <span>仅看我的提交{myTotalCount > 0 ? ` (${myTotalCount})` : ''}</span>
          </label>
        )}
      </div>
      {isAdmin && selIds.size > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="批量操作">
          <span>已选 <b>{selIds.size}</b> 条</span>
          <button className="btn small danger" onClick={bulkDelete} disabled={bulkBusy}>
            {bulkBusy ? '删除中…' : '删除所选（移入回收站）'}
          </button>
          <button className="btn small ghost" onClick={() => setSelected(new Set())} disabled={bulkBusy}>取消选择</button>
          <span className="chain">软删除可在审核台回收站恢复</span>
        </div>
      )}
      <div className="table-scroll" id="records-wrap">
        <table className={`data${isAdmin ? ' has-check' : ''}`}>
          <thead>
            <tr>
              {isAdmin && (
                <th className="row-check">
                  <input type="checkbox" checked={allPageSelected} onChange={togglePage}
                    title={`全选/取消本页 ${pageRows.length} 条`} aria-label="全选本页" />
                </th>
              )}
              {th('model', '模型')}
              {th('pid', '题目')}
              {th('difficulty', '难度')}
              {th('thinking', '思考')}
              {th('agent', 'Agent')}
              {th('tokenSource', 'Token 来源')}
              {th('submissions', '提交轨迹')}
              {th('minutes', '用时')}
              {th('memory', '内存')}
              {th('date', '时间')}
              {th('author', '提供者')}
              {th('reviewerId', '审核人')}
              {th('note', '备注')}
              {(isAdmin || session.loggedIn) && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => {
              const myRec = isMyRecord(r)
              const canEdit = isAdmin || myRec
              return (
                <tr key={r.id} className={`${selIds.has(r.id) ? 'picked' : ''} ${r.status === 'pending' ? 'row-pending' : ''}`}>
                  {isAdmin && (
                    <td className="row-check">
                      <input
                        type="checkbox" checked={selIds.has(r.id)} onChange={() => toggleRow(r.id)}
                        aria-label={`选择 ${seriesKey(r)} ${r.pid}`}
                      />
                    </td>
                  )}
                  <td className="sticky-col">
                    {seriesKey(r)}{r.variant ? <span className="chain">（{r.variant}）</span> : null}
                  </td>
                  <td>
                    <PidLink pid={r.pid} />
                    <div
                      className="chain pid-detail"
                      data-detail={r.pid}
                      onClick={() => onOpenDetail && onOpenDetail(r.pid, seriesKey(r))}
                      title={`${r.pid} ${r.title || ''} · 点击查看本站详情`}
                    >{r.title}</div>
                  </td>
                  <td><span className={`diff-tag ${diffClass(r.difficulty)}`}>{difficultyName(r.difficulty)}</span></td>
                  <td><span className={`think-tag lv-${r.thinking}`}>{THINKING_LABELS[r.thinking] || r.thinking}</span></td>
                  <td>{r.agent || (blankEmpty ? null : <span className="chain">—</span>)}</td>
                  <td>{r.tokenSource || (blankEmpty ? null : <span className="chain">—</span>)}</td>
                  <td>
                    {(r.submissions || []).map((s, i) => (
                      <span key={i} className={`sub-badge ${subBadgeClass(s.score)}`} title={`第${i + 1}轮 ${s.result} ${scoreTitle(s.score, decimal)} ${s.note || ''}`}>
                        {s.score === null || s.score === undefined ? s.result : scoreText(s.score, decimal)}
                      </span>
                    ))}
                  </td>
                  <td className="num">{r.minutes ?? (blankEmpty ? '' : '—')}</td>
                  <td className="num">{r.memory ?? (blankEmpty ? '' : '—')}</td>
                  <td title={`测评日期 ${r.date}\n录入时间 ${fmtDateTime(r.createdAt)}\n更新时间 ${fmtDateTime(r.updatedAt)}`}>
                    <div className="tcell">
                      <span className="t-date">{r.date}</span>
                      <span className="t-time">{fmtClock(r.createdAt) || (blankEmpty ? '' : '—:—')}</span>
                    </div>
                  </td>
                  <td title={r.authorId ? `提供者 ID #${r.authorId}` : '网站首次录入的历史数据'}>
                    {providerLabel(r, nicknameOf)}
                  </td>
                  <td title={r.reviewerId ? `审核人 ID #${r.reviewerId}` : (r.status === 'approved' ? '网站首次录入的历史数据' : '尚未审核')}>
                    {reviewerLabel(r, nameByUid) || <span className="chain">待审核</span>}
                    <div className="chain">{r.reviewedAt ? fmtDateTime(r.reviewedAt) : ''}</div>
                  </td>
                  <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.note}>{r.note || (blankEmpty ? '' : '—')}</td>
                  {(isAdmin || session.loggedIn) && (
                    <td className="actions">
                      {canEdit && (
                        <button
                          className="btn small ghost"
                          onClick={() => onEdit(r)}
                          title={myRec && !isAdmin ? '修改我提交的记录（保存后将重新进入待审核状态）' : '编辑记录'}
                        >
                          编辑
                        </button>
                      )}
                      {isAdmin && <DeleteRecordButton record={r} />}
                      {r.status === 'pending' && (
                        <span
                          className="status-tag pending"
                          title={myRec ? '您提交或修改的记录，正等待管理员审核' : '待管理员审核'}
                        >
                          待审
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
            {!pageRows.length && (
              <tr><td colSpan={(isAdmin || session.loggedIn) ? (isAdmin ? 15 : 14) : 13}><div className="empty">没有符合筛选条件的记录</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pager">
          <button className="btn small ghost" disabled={safePage === 0} onClick={() => goPage(safePage - 1)}>上一页</button>
          <span className="pages">{safePage + 1} / {pages}</span>
          <button className="btn small ghost" disabled={safePage >= pages - 1} onClick={() => goPage(safePage + 1)}>下一页</button>
        </div>
      )}
        </>
      )}
    </div>
  )
}
