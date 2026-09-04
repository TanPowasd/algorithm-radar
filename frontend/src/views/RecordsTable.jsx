import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../state'
import { api } from '../api/client'
import DeleteRecordButton from '../components/DeleteRecordButton'
import PidLink from '../components/PidLink'
import {
  applyFilters, difficultyName, fmtClock, fmtDateTime, lastSub, recordLine, recordTs, subBadgeClass, seriesKey,
  seriesList, THINKING_LABELS, isPending, providerLabel, reviewerLabel, filterByModels,
} from '../aggregate'
import { useUrlState } from '../hooks/useUrlState'

const PAGE_SIZE = 50
const FILTER_KEYS = ['keyword', 'series', 'difficulty', 'category', 'result', 'thinking']

function diffClass(d) { return `d-${d ?? 0}` }

export default function RecordsTable({ onOpenDetail, onEdit, isAdmin }) {
  const { data, nicknameOf, nameByUid, focusModels, toast, refreshAll } = useApp()
  const url = useUrlState('rec')
  const [filters, setFilters] = useState(() => {
    const init = { keyword: '', series: '', difficulty: '', category: '', result: '', thinking: '' }
    for (const k of FILTER_KEYS) {
      const v = url.get(k, '')
      if (v) init[k] = v
    }
    return init
  })
  const [sort, setSort] = useState(() => {
    const k = url.get('sort', 'date')
    const d = url.get('dir', 'desc')
    return { key: k, dir: d === 'asc' ? 'asc' : 'desc' }
  })
  const [page, setPage] = useState(() => Number(url.get('page', '')) || 0)

  const approved = useMemo(() => filterByModels(
    (data.records || []).filter((r) => !isPending(r)), focusModels), [data.records, focusModels])
  const filtered = useMemo(() => applyFilters(approved, filters), [approved, filters])

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

  const seriesOpts = seriesList(approved)
  useEffect(() => {
    if (filters.series && !seriesOpts.includes(filters.series)) {
      setFilters((f) => ({ ...f, series: '' }))
    }
  }, [seriesOpts.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  const categoryOpts = useMemo(() => {
    const set = new Set()
    approved.forEach((r) => (r.categories || []).forEach((c) => set.add(c)))
    return [...set].sort()
  }, [approved])

  /** 筛选/排序/翻页写进 URL（?rec:keyword=…），刷新与分享都保持现场 */
  const setF = (patch) => {
    setFilters((f) => ({ ...f, ...patch }))
    setPage(0)
    url.setMany({ ...patch, page: '' })
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
    const blank = { keyword: '', series: '', difficulty: '', category: '', result: '', thinking: '' }
    setFilters(blank)
    setPage(0)
    url.setMany({ ...blank, page: '' })
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

  const hasFilter = !!(filters.keyword || filters.series || filters.difficulty !== '' || filters.category || filters.result || filters.thinking)

  return (
    <div className="card" id="records-card">
      <div className="card-head">
        <h2>测评明细</h2>
        <span className="hint" id="records-count">{filtered.length} 条</span>
        <div className="card-tools">
          <span className="hint">时间列 = 测评日期 + 录入时分</span>
          {hasFilter ? (
            <button className="btn small ghost" onClick={clearAll}>清除筛选</button>
          ) : null}
        </div>
      </div>
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
              {isAdmin && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <tr key={r.id} className={selIds.has(r.id) ? 'picked' : ''}>
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
                <td>{r.agent || <span className="chain">—</span>}</td>
                <td>{r.tokenSource || <span className="chain">—</span>}</td>
                <td>
                  {(r.submissions || []).map((s, i) => (
                    <span key={i} className={`sub-badge ${subBadgeClass(s.score)}`} title={`第${i + 1}轮 ${s.result} ${s.score ?? '无分'} ${s.note || ''}`}>
                      {s.score ?? s.result}
                    </span>
                  ))}
                </td>
                <td className="num">{r.minutes ?? '—'}</td>
                <td className="num">{r.memory ?? '—'}</td>
                <td title={`测评日期 ${r.date}\n录入时间 ${fmtDateTime(r.createdAt)}\n更新时间 ${fmtDateTime(r.updatedAt)}`}>
                  <div className="tcell">
                    <span className="t-date">{r.date}</span>
                    <span className="t-time">{fmtClock(r.createdAt) || '—:—'}</span>
                  </div>
                </td>
                <td title={r.authorId ? `提供者 ID #${r.authorId}` : '网站首次录入的历史数据'}>
                  {providerLabel(r, nicknameOf)}
                </td>
                <td title={r.reviewerId ? `审核人 ID #${r.reviewerId}` : (r.status === 'approved' ? '网站首次录入的历史数据' : '尚未审核')}>
                  {reviewerLabel(r, nameByUid) || <span className="chain">待审核</span>}
                  <div className="chain">{r.reviewedAt ? fmtDateTime(r.reviewedAt) : ''}</div>
                </td>
                <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.note}>{r.note || '—'}</td>
                {isAdmin && (
                  <td className="actions">
                    <button className="btn small ghost" onClick={() => onEdit(r)}>编辑</button>
                    <DeleteRecordButton record={r} />
                    {r.status === 'pending' && <span className="status-tag pending">待审</span>}
                  </td>
                )}
              </tr>
            ))}
            {!pageRows.length && (
              <tr><td colSpan={isAdmin ? 15 : 13}><div className="empty">没有符合筛选条件的记录</div></td></tr>
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
    </div>
  )
}
