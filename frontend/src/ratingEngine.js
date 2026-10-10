import { bestThinkingCell, isApproved, matrixCell, seriesKey } from './aggregate.js'
import {
  ARENA_BOOTSTRAP, ARENA_MIN_GAMES, applyArenaGame, arenaOutcome, arenaRandom,
  createBradleyTerrySolver, emptyArenaStats,
} from './score.js'
import { RATING_VERSION } from './ratingVersion.js'

export { RATING_VERSION } from './ratingVersion.js'
const DEFAULT_SEED = 'k4u-rating-v1'
const MAX_BOOTSTRAP_BYTES = 32 * 1024 * 1024
const pause = () => new Promise((resolve) => setTimeout(resolve, 0))
const cellKey = (model, pid) => JSON.stringify([model, pid])
const edgeKey = (pid, a, b) => JSON.stringify([pid, a, b])
const now = () => performance.now()
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

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
    return bestThinkingCell(records, mode === 'bestLevel' ? 'level' : 'score', 'avgscore').value ?? null
  }
  const cell = matrixCell(records, model, pid)
  return (mode === 'final' ? cell.finalInfo : cell.scoreInfo)?.avg ?? null
}

async function fit(stats, players, initialStrengths, opts, cancelled) {
  const solve = async (initial, limit) => {
    const solver = createBradleyTerrySolver(players, stats, {
      ...opts, initialStrengths: initial, maxIterations: limit,
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
  let solver = await solve(initialStrengths, initialStrengths?.size ? 2000 : 10000)
  const warmIterations = initialStrengths?.size ? solver.iterations : 0
  let fallback = false
  if (!solver.converged && initialStrengths?.size) {
    fallback = true
    solver = await solve(null, 10000)
  }
  if (!solver.converged) throw new Error('Rating did not converge within 10000 iterations')
  return {
    ratings: solver.ratings(), strengths: solver.strengths(), iterations: solver.iterations,
    maxDelta: solver.maxDelta, warmIterations, fallback,
  }
}

/** One engine belongs to one epoch, visibility scope, and matrix metric. */
export class IncrementalRatingEngine {
  constructor({ mode = 'bestLevel', seed = DEFAULT_SEED, bootstrap = ARENA_BOOTSTRAP, ...opts } = {}) {
    this.mode = mode
    this.seed = seed
    this.bootstrap = bootstrap
    this.opts = opts
    this.records = new Map()
    this.cells = new Map()
    this.byProblem = new Map()
    this.problemIds = new Set()
    this.edges = new Map()
    this.stats = emptyArenaStats()
    this.strengths = new Map()
    this.ratings = new Map()
    this.samples = []
    this.sampleEdgeKeys = []
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
        cell = { model: record.model, pid: record.pid, records: new Map(), value: null }
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
    const changedCells = []
    for (const key of affected) {
      const cell = this.cells.get(key)
      if (!cell) continue
      const value = nextProblems.has(cell.pid)
        ? ratingCellValue([...cell.records.values()], cell.model, cell.pid, this.mode) : null
      if (!Object.is(value, cell.value)) {
        cell.value = value
        changedCells.push(cell)
      }
    }
    const visited = new Set(), changes = []
    for (const cell of changedCells) {
      for (const other of this.byProblem.get(cell.pid)?.values() || []) {
        if (other.model === cell.model) continue
        const [a, b] = [cell, other].sort((x, y) => compare(x.model, y.model))
        const id = edgeKey(cell.pid, a.model, b.model)
        if (visited.has(id)) continue
        visited.add(id)
        const old = this.edges.get(id) || null
        const share = a.value === null || b.value === null ? null : arenaOutcome(a.value, b.value)
        const next = share === null ? null : { id, a: a.model, b: b.model, s: share }
        if (!old && !next || old && next && old.s === next.s) continue
        if (old) applyArenaGame(this.stats, old, -1)
        if (next) { this.edges.set(id, next); applyArenaGame(this.stats, next) }
        else this.edges.delete(id)
        changes.push({ id, old, next })
      }
    }
    for (const key of affected) {
      const cell = this.cells.get(key)
      if (cell && !cell.records.size) {
        this.cells.delete(key)
        const models = this.byProblem.get(cell.pid)
        models.delete(cell.model)
        if (!models.size) this.byProblem.delete(cell.pid)
      }
    }
    const graphChanged = changes.some(({ old, next }) => !old || !next)
    if (graphChanged) {
      this.samples = []
      this.sampleEdgeKeys = [...this.edges.keys()].sort()
      this.graphFingerprint = graphFingerprint(this.sampleEdgeKeys)
    } else if (changes.length && this.samples.length) {
      const edgeIndex = new Map(this.sampleEdgeKeys.map((id, i) => [id, i]))
      for (const sample of this.samples) {
        if (!sample) continue
        for (const change of changes) {
          const count = sample.multiplicity[edgeIndex.get(change.id)]
          applyArenaGame(sample.stats, change.old, -count)
          applyArenaGame(sample.stats, change.next, count)
        }
      }
    }
    if (changes.length) { this.ready = false; this.pointCurrent = false }
    return {
      changedRecords, affectedCells: affected.size, changedCells: changedCells.length,
      changedEdges: changes.length, graphChanged, edges: this.edges.size,
      records: this.records.size, players: this.stats.totals.size,
    }
  }

  pointRows(fitted) {
    return new Map([...fitted].map(([model, rating]) => {
      const games = this.stats.totals.get(model) || 0
      const share = this.stats.wins.get(model) || 0
      return [model, {
        rating, games, share, winShare: games ? share / games : null, lo: null, hi: null,
        status: games >= ARENA_MIN_GAMES ? '正式榜' : `对局少(${games} 局)`,
      }]
    }))
  }

  async calculate(records, problems, { emit = () => {}, cancelled = () => false } = {}) {
    const started = now()
    const delta = this.update(records, problems)
    const diagnostics = { ...delta, incremental: true, cacheHit: this.ready && !delta.changedEdges }
    if (diagnostics.cacheHit) {
      this.lastDiagnostics = {
        ...this.lastDiagnostics, ...diagnostics, iterations: 0, warmIterations: 0,
        sampleIterations: 0, pointMs: 0, elapsedMs: now() - started,
      }
      emit({ kind: 'ready', ratings: this.ratings, diagnostics: this.lastDiagnostics })
      return this.ratings
    }
    const players = [...this.stats.totals.keys()].sort()
    if (!players.length) {
      this.ratings = new Map(); this.strengths = new Map(); this.ready = true; this.pointCurrent = true
      this.lastDiagnostics = { ...diagnostics, pointMs: now() - started, elapsedMs: now() - started }
      emit({ kind: 'ready', ratings: this.ratings, diagnostics: this.lastDiagnostics })
      return this.ratings
    }
    if (!this.pointCurrent) {
      const fitted = await fit(this.stats, players, this.strengths, this.opts, cancelled)
      this.strengths = fitted.strengths
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
    const edges = this.sampleEdgeKeys.map((id) => this.edges.get(id))
    const uniquePairs = [...this.stats.opponents.values()].reduce((sum, others) => sum + others.size, 0)
    const estimatedBytes = this.bootstrap * (edges.length * 4 + uniquePairs * 48 + players.length * 80)
    const retain = estimatedBytes <= (this.opts.maxBootstrapBytes ?? MAX_BOOTSTRAP_BYTES)
    const existingSamples = this.samples.filter(Boolean).length
    const values = new Map(players.map((model) => [model, []]))
    let sampleIterations = 0
    let lastYield = now()
    for (let b = 0; b < this.bootstrap; b++) {
      if (cancelled()) throw new RatingCancelled()
      let sample = this.samples[b]
      if (!sample) {
        const random = arenaRandom(`${this.seed}:${b}:${this.graphFingerprint}`)
        const multiplicity = new Uint32Array(edges.length)
        for (let i = 0; i < edges.length; i++) multiplicity[Math.floor(random() * edges.length)]++
        const stats = emptyArenaStats()
        for (let i = 0; i < edges.length; i++) applyArenaGame(stats, edges[i], multiplicity[i])
        sample = { multiplicity, stats, strengths: null }
        if (retain) this.samples[b] = sample
      }
      const fitted = await fit(sample.stats, players, sample.strengths, this.opts, cancelled)
      sampleIterations += fitted.iterations
      sample.strengths = fitted.strengths
      for (const model of players) values.get(model).push(fitted.ratings.get(model))
      if (now() - lastYield >= 8) { await pause(); lastYield = now() }
    }
    if (cancelled()) throw new RatingCancelled()
    this.ratings = new Map([...this.ratings].map(([model, row]) => {
      const valuesForModel = values.get(model).sort((a, b) => a - b)
      return [model, {
        ...row, lo: valuesForModel.length ? valuesForModel[Math.floor(valuesForModel.length * 0.025)] : null,
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
      strengths: [...this.strengths], ratings: [...this.ratings], ready: this.ready,
    }
  }

  restore(checkpoint) {
    if (checkpoint?.version !== RATING_VERSION || checkpoint.mode !== this.mode
      || checkpoint.seed !== this.seed || checkpoint.bootstrap !== this.bootstrap) return false
    try {
      if (!Array.isArray(checkpoint.records) || !Array.isArray(checkpoint.problemIds)) return false
      this.update(checkpoint.records, Object.fromEntries(checkpoint.problemIds.map((pid) => [pid, { pid }])))
      const players = new Set(this.stats.totals.keys())
      const ratings = new Map(checkpoint.ratings)
      const strengths = new Map(checkpoint.strengths)
      if (ratings.size !== players.size || strengths.size !== players.size) return false
      for (const model of players) {
        if (!Number.isFinite(ratings.get(model)?.rating) || !Number.isFinite(strengths.get(model)) || strengths.get(model) <= 0) return false
      }
      this.ratings = ratings; this.strengths = strengths
      this.ready = checkpoint.ready === true; this.pointCurrent = true
      return true
    } catch { return false }
  }
}
