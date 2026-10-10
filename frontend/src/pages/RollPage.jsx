import { useCallback, useState } from 'react'
import Topbar from '../components/Topbar'
import RollBoardView from '../views/RollBoardView'
import ProblemDrawer from '../components/ProblemDrawer'
import { useApp } from '../state'
import PageHeading from '../components/PageHeading'

/**
 * 滚榜页（ACM Board）· 独立路由 /roll —— 把 v1 时代的滚榜视图原样搬进新站。
 *
 * 语义映射（与 v1 一致）：
 *   团队 = 模型（seriesKey = model）、队员 = 该模型的思考等级；
 *   一次上机 = 一条测评记录，解题判定 = 该条记录最后一轮的 result === 'AC'；
 *   回放时间轴 = 记录录入时间（createdAt），逐笔把「上机结果」刷进榜单。
 *
 * 数据口径：D1 里全部已审核记录（含 2026-09-05 21:19 之前的历史数据），
 * 所以榜上既有 v2 的记录也有旧记录；单元格分数是记录里的洛谷原始分。
 */
export default function RollPage() {
  const app = useApp()
  const [drawer, setDrawer] = useState(null)
  const openDetail = useCallback((pid, model) => setDrawer({ pid, model: model || null }), [])
  const total = (app.data && Array.isArray(app.data.records) ? app.data.records : []).length

  return (
    <>
      <Topbar hud={{ samples: total, models: 0, view: 'roll' }} />
      <main className="layout">
        <PageHeading title="滚榜回放" description="按录入时间逐笔揭晓全部历史成绩。团队代表模型，队员代表思考等级。" eyebrow="ALGORITHM RADAR / REPLAY" />
        <RollBoardView onOpenDetail={openDetail} />
        {drawer && (
          <ProblemDrawer
            pid={drawer.pid}
            highlightModel={drawer.model}
            onClose={() => setDrawer(null)}
            blankEmpty
          />
        )}
      </main>
    </>
  )
}
