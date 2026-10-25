import { V2_CUTOFF_ISO, computeProblemTimeAnchors, weightedRoundScore } from './score'

/**
 * v2 数据层：把 new.json（v2 自己的数据文件）转成直接可渲染的数据集。
 *   1) 时间线：只保留 createdAt ≥ V2_CUTOFF_ISO 的记录（2026-09-05 21:19 北京时间之后）；
 *   2) 时间锚点：基于题目全测试点总时限 totalTimeLimit 与同题已过审 100 分 AC 耗时做经验贝叶斯校准；
 *   3) 分数：每一轮的 score 换成加权分（原始分 × 原始分权重 × 正确率门控时空效能因子）；
 * 转换只在这一个地方做 —— 矩阵 / 详情 / 统计 / 排名拿到的都是同一份加权数据，
 * 所以同一道题在任何页面看到的加权分必然是同一个数。
 * 算不出加权分的轮次（缺每轮时间/内存）score 置 null：
 * 页面直接留空 —— 绝不回退显示洛谷原始分，也不显示「—」占位。
 */
export function toV2Dataset(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const rawProblems = src.problems && typeof src.problems === 'object' ? src.problems : {}
  const all = Array.isArray(src.records) ? src.records : []
  const kept = all.filter((r) => typeof (r && r.createdAt) === 'string' && r.createdAt >= V2_CUTOFF_ISO)
  const anchors = computeProblemTimeAnchors(kept, rawProblems)
  const problems = {}
  for (const [pid, prob] of Object.entries(rawProblems)) {
    if (!prob || typeof prob !== 'object') {
      problems[pid] = prob
      continue
    }
    const timeAnchor = anchors.get(pid)
    problems[pid] = timeAnchor !== undefined ? { ...prob, timeAnchor } : prob
  }
  const records = kept.map((r) => {
    const problem = problems[r.pid] || (anchors.has(r.pid) ? { timeAnchor: anchors.get(r.pid) } : undefined)
    const submissions = (Array.isArray(r.submissions) ? r.submissions : []).map((s) => ({
      ...s,
      score: weightedRoundScore(s && s.score, s, problem),
    }))
    return { ...r, submissions }
  })
  return {
    epoch: src.epoch || '0',
    scope: src.scope || 'public',
    revision: typeof src.revision === 'number' ? src.revision : 0,
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : '',
    records,
    problems,
  }
}

/** 空数据集（文件缺失/为空时的兜底形状，供页面空态使用） */
export const V2_EMPTY = { revision: 0, updatedAt: '', records: [], problems: {} }
