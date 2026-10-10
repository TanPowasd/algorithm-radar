/**
 * 单个比赛的完整页面（/arena/:slug）；从比赛目录进入。
 */
import { useParams } from 'react-router-dom'
import Topbar from '../components/Topbar'
import ArenaView from '../views/ArenaView'

export default function ArenaPage() {
  const { slug = 'kaggriculture' } = useParams()
  return (
    <>
      <Topbar />
      <main className="layout management-layout">
        <ArenaView slug={slug} />
      </main>
    </>
  )
}
