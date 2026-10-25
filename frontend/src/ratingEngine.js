import { bestThinkingCell, isApproved, matrixCell, seriesKey } from './aggregate.js'
import {
  RATING_ANCHOR, RATING_BOOTSTRAP, RATING_MIN_PROBLEMS, RATING_PRIOR_TAU, RATING_SCALE,
  arenaGaussian, arenaRandom, createIrtSolver, emptyIrtStats, ratingNormalizedScore, setIrtCell,
} from './score.js'
import { RATING_VERSION } from './ratingVersion.js'

export { RATING_VERSION } from './ratingVersion.js'
const DEFAULT_SEED = 'k4u-rating-v3'
const MAX_BOOTSTRAP_BYTES = 32 * 1024 * 1024
const pause = () => new Promise((resolve) => setTimeout(resolve, 0))
const cellKey = (model, pid) => JSON.stringify([model, pid])
const now = () => performance.now()

function graphFingerprint(keys) {
  let hash = 2166136261
  for (const key of keys) {
    for (const c of key) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619)
    hash = Math.imul(hash ^ 0, 16777619)
  }
  return hash >>> 0
}

export class RatingCancelled extends Error {
  constructor() { super('Rating calculation cancelled'); this.name = 'RatingCancelled' }
}

function compactRecord(record) {
  return {
    id: record.id, model: seriesKey(record), pid: record.pid, thinking: record.thinking,
    status: record.status,
    submissions: (record.submissions || []).map((sub) => ({ score: sub.score ?? null, result: sub.result })),
  }
}

export function ratingCellValue(records, model, pid, mode) {
  if (!records.length || mode === 'status') return null
  if (mode === 'bestLevel' || mode === 'bestScore') {
    return bestThinkingCell(records, mode === 'bestLevel' ? 'level' : 'score', 'trajectory').value ?? null
  }
  const cell = matrixCell(records, model, pid)
  return (mode === 'final' ? cell.finalInfo : cell.trajectoryInfo)?.avg ?? null
}

async function fit(stats, players, initialStrengths, initialDifficulties, opts, cancelled) {
  const solve = async (initStrengths, initDiffs, limit) => {
    const solver = createIrtSolver(players, stats, {
      ...opts, initialStrengths: initStrengths, initialDifficulties: initDiffs, maxIterations: limit,
    })
    let lastYield = now()
    while (!solver.done) {
      if (cancelled()) throw new RatingCancelled()
      solver.advance(32)
      if (!solver.done && now() - lastYield >= 8) { await pause(); lastYield = now() }
    }
    if (cancelled()) throw new RatingCancelled()
    return solver
  }
  const hasWarm = Boolean(initialStrengths?.size || initialDifficulties?.size)
  let solver = await solve(initialStrengths, initialDifficulties, hasWarm ? 2000 : 10000)
  const warmIterations = hasWarm ? solver.iterations : 0
  let fallback = false
  if (!solver.converged && hasWarm) {
    fallback = true
    solver = await solve(null, null, 10000)
  }
  if (!solver.converged) throw new Error('Rating did not converge within 10000 iterations')
  return {
    ratings: solver.ratings(), strengths: solver.strengths(), difficulties: solver.difficulties(),
    iterations: solver.iterations, maxDelta: solver.maxDelta, warmIterations, fallback,
  }
}

/** One engine belongs to one epoch, visibility scope, and matrix metric. */
export class IncrementalRatingEngine {
  constructor({ mode = 'bestLevel', seed = DEFAULT_SEED, bootstrap = RATING_BOOTSTRAP, ...opts } = {}) {
    this.mode = mode
    this.seed = seed
    this.bootstrap = bootstrap
    this.opts = opts
    this.records = new Map()
    this.cells = new Map()
    this.byProblem = new Map()
    this.scoredByProblem = new Map()
    this.problemIds = new Set()
    this.activeCells = new Map()
    this.activeByProblem = new Map()
    this.stats = emptyIrtStats()
    this.strengths = new Map()
    this.difficulties = new Map()
    this.ratings = new Map()
    this.samples = []
    this.sampleCellKeys = []
    this.graphFingerprint = 0
    this.lastDiagnostics = {}
    this.ready = false
    this.pointCurrent = false
  }

  update(records, problems) {
    const affected = new Set(), seen = new Set()
    const nextProblems = new Set(Object.values(problems || {}).map((problem) => problem.pid).filter(Boolean))
    const touch = (record) => affected.add(cellKey(record.model, record.pid))
    const remove = (id, old) => {
      this.cells.get(cellKey(old.record.model, old.record.pid))?.records.delete(id)
      touch(old.record)
      this.records.delete(id)
    }
    let changedRecords = 0
    for (let i = 0; i < records.length; i++) {
      const source = records[i]
      if (!isApproved(source)) continue
      const id = source.id ?? `anonymous:${i}`
      if (seen.has(id)) throw new Error('Duplicate record id in rating input')
      seen.add(id)
      const record = compactRecord(source)
      const fingerprint = JSON.stringify(record)
      const old = this.records.get(id)
      if (old?.fingerprint === fingerprint) continue
      changedRecords++
      if (old) remove(id, old)
      const key = cellKey(record.model, record.pid)
      let cell = this.cells.get(key)
      if (!cell) {
        cell = { key, model: record.model, pid: record.pid, records: new Map(), value: null }
        this.cells.set(key, cell)
        if (!this.byProblem.has(record.pid)) this.byProblem.set(record.pid, new Map())
        this.byProblem.get(record.pid).set(record.model, cell)
      }
      cell.records.set(id, record)
      this.records.set(id, { record, fingerprint })
      touch(record)
    }
    for (const [id, old] of this.records) {
      if (!seen.has(id)) { changedRecords++; remove(id, old) }
    }
    for (const [key, cell] of this.cells) {
      if (this.problemIds.has(cell.pid) !== nextProblems.has(cell.pid)) affected.add(key)
    }
    this.problemIds = nextProblems

    const changedCells = [], affectedProblems = new Set()
    for (const key of affected) {
      const cell = this.cells.get(key)
      if (!cell) continue
      const value = nextProblems.has(cell.pid)
        ? ratingCellValue([...cell.records.values()], cell.model, cell.pid, this.mode) : null
      if (!Object.is(value, cell.value)) {
        cell.value = value
        changedCells.push(cell)
        affectedProblems.add(cell.pid)
        if (value !== null) {
          let scored = this.scoredByProblem.get(cell.pid)
          if (!scored) { scored = new Map(); this.scoredByProblem.set(cell.pid, scored) }
          scored.set(cell.model, cell)
        } else {
          const scored = this.scoredByProblem.get(cell.pid)
          if (scored) {
            scored.delete(cell.model)
            if (!scored.size) this.scoredByProblem.delete(cell.pid)
          }
        }
      }
    }

    const changes = []
    let changedEdges = 0
    for (const pid of affectedProblems) {
      const scored = this.scoredByProblem.get(pid)
      const comparative = (scored?.size || 0) >= 2
      const prevActive = this.activeByProblem.get(pid)
      const prevSize = prevActive?.size || 0
      if (!comparative) {
        if (prevActive) {
          changedEdges += prevSize * (prevSize - 1) / 2
          for (const old of prevActive.values()) {
            this.activeCells.delete(old.id)
            setIrtCell(this.stats, old, 0)
            changes.push({ id: old.id, old, next: null })
          }
          this.activeByProblem.delete(pid)
        }
        continue
      }
      let nextActive = prevActive
      if (!nextActive) { nextActive = new Map(); this.activeByProblem.set(pid, nextActive) }
      let modifiedModels = 0
      for (const [model, old] of [...nextActive.entries()]) {
        if (!scored.has(model)) {
          nextActive.delete(model)
          this.activeCells.delete(old.id)
          setIrtCell(this.stats, old, 0)
          changes.push({ id: old.id, old, next: null })
          modifiedModels++
        }
      }
      for (const [model, cell] of scored) {
        const id = cell.key
        const old = nextActive.get(model) || null
        const y = ratingNormalizedScore(cell.value, this.opts.cap, this.opts.tau)
        const next = y === null ? null : { id, pid, model, score: cell.value, y }
        if (!old && !next || old && next && old.y === next.y) continue
        if (next) {
          nextActive.set(model, next)
          this.activeCells.set(id, next)
          setIrtCell(this.stats, next, 1)
        } else {
          nextActive.delete(model)
          this.activeCells.delete(id)
          setIrtCell(this.stats, old, 0)
        }
        changes.push({ id, old, next })
        modifiedModels++
      }
      if (!nextActive.size) this.activeByProblem.delete(pid)
      if (modifiedModels > 0) {
        const n = Math.max(prevSize, nextActive.size)
        const untouched = Math.max(0, n - modifiedModels)
        changedEdges += n * (n - 1) / 2 - untouched * (untouched - 1) / 2
      }
    }

    for (const key of affected) {
      const cell = this.cells.get(key)
      if (cell && !cell.records.size) {
        this.cells.delete(key)
        const models = this.byProblem.get(cell.pid)
        models?.delete(cell.model)
        if (models && !models.size) this.byProblem.delete(cell.pid)
      }
    }

    const graphChanged = changes.some(({ old, next }) => !old || !next)
    if (graphChanged) {
      this.samples = []
      this.sampleCellKeys = [...this.activeCells.keys()].sort()
      this.graphFingerprint = graphFingerprint(this.sampleCellKeys)
    } else if (changes.length && this.samples.length) {
      const cellIndex = new Map(this.sampleCellKeys.map((id, i) => [id, i]))
      for (const sample of this.samples) {
        if (!sample) continue
        for (const change of changes) {
          const count = sample.multiplicity[cellIndex.get(change.id)]
          if (count > 0) setIrtCell(sample.stats, change.next, count)
        }
      }
    }
    if (changes.length) { this.ready = false; this.pointCurrent = false }

    let edges = 0
    for (const byModel of this.activeByProblem.values()) edges += byModel.size * (byModel.size - 1) / 2
    return {
      changedRecords, affectedCells: affected.size, changedCells: changedCells.length,
      changedActiveCells: changes.length, activeCells: this.activeCells.size,
      changedEdges, graphChanged, edges,
      records: this.records.size, players: this.stats.models.size,
    }
  }

  pointRows(fitted) {
    const anchor = this.opts.anchor ?? RATING_ANCHOR
    const scale = this.opts.scale ?? RATING_SCALE
    const minProblems = this.opts.minProblems ?? RATING_MIN_PROBLEMS
    return new Map([...fitted].map(([model, rating]) => {
      const mStat = this.stats.models.get(model)
      const problems = mStat?.problems || 0
      let games = 0
      for (const byModel of this.activeByProblem.values()) {
        if (byModel.has(model)) games += byModel.size - 1
      }
      const share = mStat?.wy || 0
      const avgMastery = problems ? share / problems : null
      const winShare = 1 / (1 + Math.pow(10, -(rating - anchor) / scale))
      const lowSample = problems < minProblems
      return [model, {
        rating, problems, games, share, avgMastery, winShare, lowSample, lo: null, hi: null,
        status: lowSample ? `样本少(${problems} 题)` : '正式榜',
      }]
    }))
  }

  async calculate(records, problems, { emit = () => {}, cancelled = () => false } = {}) {
    const started = now()
    const delta = this.update(records, problems)
    const diagnostics = { ...delta, incremental: true, cacheHit: this.ready && !delta.changedActiveCells }
    if (diagnostics.cacheHit) {
      this.lastDiagnostics = {
        ...this.lastDiagnostics, ...diagnostics, iterations: 0, warmIterations: 0,
        sampleIterations: 0, pointMs: 0, elapsedMs: now() - started,
      }
      emit({ kind: 'ready', ratings: this.ratings, diagnostics: this.lastDiagnostics })
      return this.ratings
    }
    const players = [...this.stats.models.keys()].sort()
    if (!players.length) {
      this.ratings = new Map()
      this.strengths = new Map()
      this.difficulties = new Map()
      this.ready = true
      this.pointCurrent = true
      this.lastDiagnostics = { ...diagnostics, pointMs: now() - started, elapsedMs: now() - started }
      emit({ kind: 'ready', ratings: this.ratings, diagnostics: this.lastDiagnostics })
      return this.ratings
    }
    if (!this.pointCurrent) {
      const fitted = await fit(this.stats, players, this.strengths, this.difficulties, this.opts, cancelled)
      this.strengths = fitted.strengths
      this.difficulties = fitted.difficulties
      this.ratings = this.pointRows(fitted.ratings)
      this.pointCurrent = true
      Object.assign(diagnostics, {
        iterations: fitted.iterations, warmIterations: fitted.warmIterations,
        coldFallback: fitted.fallback, maxDelta: fitted.maxDelta,
      })
    }
    diagnostics.pointMs = now() - started
    emit({ kind: 'point', ratings: this.ratings, diagnostics: { ...diagnostics } })
    if (cancelled()) throw new RatingCancelled()

    const cells = this.sampleCellKeys.map((id) => this.activeCells.get(id))
    const comparativeProblems = this.activeByProblem.size
    const estimatedBytes = this.bootstrap * (cells.length * 68 + comparativeProblems * 96 + players.length * 120)
    const retain = estimatedBytes <= (this.opts.maxBootstrapBytes ?? MAX_BOOTSTRAP_BYTES)
    const existingSamples = this.samples.filter(Boolean).length
    const priorTau = Math.max(1e-6, Number(this.opts.priorTau) || RATING_PRIOR_TAU)
    const priorStd = 1 / Math.sqrt(priorTau)
    const values = new Map(players.map((model) => [model, []]))
    let sampleIterations = 0
    let lastYield = now()
    for (let b = 0; b < this.bootstrap; b++) {
      if (cancelled()) throw new RatingCancelled()
      let sample = this.samples[b]
      if (!sample) {
        const random = arenaRandom(`${this.seed}:${b}:${this.graphFingerprint}`)
        const multiplicity = new Uint32Array(cells.length)
        for (let i = 0; i < cells.length; i++) multiplicity[Math.floor(random() * cells.length)]++
        const stats = emptyIrtStats()
        for (let i = 0; i < cells.length; i++) {
          if (multiplicity[i] > 0) setIrtCell(stats, cells[i], multiplicity[i])
        }
        const priorTargets = Float64Array.from(players, () => arenaGaussian(random) * priorStd)
        sample = { multiplicity, priorTargets, stats, strengths: null, difficulties: null }
        if (retain) this.samples[b] = sample
      }
      const fitted = await fit(
        sample.stats,
        players,
        sample.strengths || this.strengths,
        sample.difficulties || this.difficulties,
        { ...this.opts, priorTargets: sample.priorTargets },
        cancelled,
      )
      sampleIterations += fitted.iterations
      sample.strengths = fitted.strengths
      sample.difficulties = fitted.difficulties
      for (const model of players) values.get(model).push(fitted.ratings.get(model))
      if (now() - lastYield >= 8) { await pause(); lastYield = now() }
    }
    if (cancelled()) throw new RatingCancelled()
    this.ratings = new Map([...this.ratings].map(([model, row]) => {
      const valuesForModel = values.get(model).sort((a, b) => a - b)
      return [model, {
        ...row,
        lo: valuesForModel.length ? valuesForModel[Math.floor(valuesForModel.length * 0.025)] : null,
        hi: valuesForModel.length ? valuesForModel[Math.min(valuesForModel.length - 1, Math.floor(valuesForModel.length * 0.975))] : null,
      }]
    }))
    this.ready = true
    this.lastDiagnostics = {
      ...diagnostics, bootstrap: this.bootstrap, bootstrapReused: existingSamples === this.bootstrap,
      bootstrapRetained: retain, bootstrapBytes: retain ? estimatedBytes : 0,
      sampleIterations, elapsedMs: now() - started,
    }
    emit({ kind: 'ready', ratings: this.ratings, diagnostics: this.lastDiagnostics })
    return this.ratings
  }

  checkpoint() {
    return {
      version: RATING_VERSION, mode: this.mode, seed: this.seed, bootstrap: this.bootstrap,
      records: [...this.records.values()].map(({ record }) => record), problemIds: [...this.problemIds],
      strengths: [...this.strengths], difficulties: [...this.difficulties], ratings: [...this.ratings], ready: this.ready,
    }
  }

  restore(checkpoint) {
    if (checkpoint?.version !== RATING_VERSION || checkpoint.mode !== this.mode
      || checkpoint.seed !== this.seed || checkpoint.bootstrap !== this.bootstrap) return false
    try {
      if (!Array.isArray(checkpoint.records) || !Array.isArray(checkpoint.problemIds)) return false
      this.update(checkpoint.records, Object.fromEntries(checkpoint.problemIds.map((pid) => [pid, { pid }])))
      const players = new Set(this.stats.models.keys())
      const compProblems = new Set(this.activeByProblem.keys())
      const ratings = new Map(checkpoint.ratings)
      const strengths = new Map(checkpoint.strengths)
      const difficulties = new Map(checkpoint.difficulties || [])
      if (ratings.size !== players.size || strengths.size !== players.size || difficulties.size !== compProblems.size) return false
      for (const model of players) {
        if (!Number.isFinite(ratings.get(model)?.rating) || !Number.isFinite(strengths.get(model)) || strengths.get(model) <= 0) return false
      }
      for (const pid of compProblems) {
        if (!Number.isFinite(difficulties.get(pid))) return false
      }
      this.ratings = ratings
      this.strengths = strengths
      this.difficulties = difficulties
      this.ready = checkpoint.ready === true
      this.pointCurrent = true
      return true
    } catch { return false }
  }
}
