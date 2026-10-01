/**
 * 单个比赛的完整页面（/arena/:slug）。正文在 views/ArenaView，主界面「比赛」页签复用同一份。
 */
import { useParams } from 'react-router-dom'
import Topbar from '../components/Topbar'
import ArenaView from '../views/ArenaView'

export default function ArenaPage() {
  const { slug = 'kaggriculture' } = useParams()
  return (
    <>
      <Topbar />
      <main className="layout">
        <ArenaView slug={slug} />
      </main>
    </>
  )
}
