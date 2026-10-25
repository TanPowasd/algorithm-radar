import { V2_CUTOFF_ISO, weightedRoundScore } from './score'

/**
 * v2 数据层：把 new.json（v2 自己的数据文件）转成直接可渲染的数据集。
 *   1) 时间线：只保留 createdAt ≥ V2_CUTOFF_ISO 的记录（2026-09-05 21:19 北京时间之后）；
 *   2) 分数：每一轮的 score 换成加权分（原始分 × 原始分权重 × 时间权重 × 空间权重）；
 * 转换只在这一个地方做 —— 矩阵 / 详情 / 统计 / 排名拿到的都是同一份加权数据，
 * 所以同一道题在任何页面看到的加权分必然是同一个数。
 * 算不出加权分的轮次（缺每轮时间/内存）score 置 null：
 * 页面直接留空 —— 绝不回退显示洛谷原始分，也不显示「—」占位。
 */
export function toV2Dataset(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const problems = src.problems && typeof src.problems === 'object' ? src.problems : {}
  const all = Array.isArray(src.records) ? src.records : []
  const kept = all.filter((r) => typeof (r && r.createdAt) === 'string' && r.createdAt >= V2_CUTOFF_ISO)
  const records = kept.map((r) => {
    const problem = problems[r.pid]
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
