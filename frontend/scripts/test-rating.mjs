import assert from 'node:assert/strict'
import { loadRatingModule, ratingFixture } from './rating-test-helpers.mjs'

const engineModule = await loadRatingModule('../src/ratingEngine.js')
const score = await loadRatingModule('../src/score.js')
const aggregate = await loadRatingModule('../src/aggregate.js')
const clientModule = await loadRatingModule('../src/ratingClient.js')
const checkpointModule = await loadRatingModule('../src/ratingCheckpoint.js')
const v2data = await loadRatingModule('../src/v2data.js')
const { IncrementalRatingEngine, RatingCancelled } = engineModule
const options = { bootstrap: 12, seed: 'rating-test', tolerance: 1e-7 }
let passed = 0
const tests = []
const test = (name, run) => tests.push([name, run])
const near = (actual, expected, epsilon = 0.0001) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`)

function reference(records, problems, mode) {
  const groups = new Map()
  for (const record of records.filter(aggregate.isApproved)) {
    if (!problems[record.pid]) continue
    const key = JSON.stringify([record.model, record.pid])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(record)
  }
  const byProblem = new Map()
  for (const [key, group] of groups) {
    const [model, pid] = JSON.parse(key)
    let value = null
    if (mode === 'bestLevel' || mode === 'bestScore') value = aggregate.bestThinkingCell(group, mode === 'bestLevel' ? 'level' : 'score', 'trajectory').value
    else if (mode !== 'status') {
      const cell = aggregate.matrixCell(group, model, pid)
      value = (mode === 'final' ? cell.finalInfo : cell.trajectoryInfo)?.avg ?? null
    }
    if (value === null) continue
    if (!byProblem.has(pid)) byProblem.set(pid, [])
    byProblem.get(pid).push({ pid, model, score: value })
  }
  const comparativeCells = []
  let edges = 0
  for (const list of byProblem.values()) {
    if (list.length < 2) continue
    comparativeCells.push(...list)
    edges += list.length * (list.length - 1) / 2
  }
  const stats = score.irtStats(comparativeCells)
  const players = [...stats.models.keys()].sort()
  return {
    cells: comparativeCells,
    edges,
    stats,
    ratings: score.irtFit(players, stats, { converge: true, tolerance: 1e-8 }),
  }
}

function compareReference(engine, records, problems, mode) {
  const expected = reference(records, problems, mode)
  assert.equal(engine.activeCells.size, expected.cells.length)
  assert.equal(engine.lastDiagnostics?.edges ?? 0, expected.edges)
  assert.deepEqual([...engine.stats.models.keys()].sort(), [...expected.stats.models.keys()].sort())
  for (const [model, stat] of expected.stats.models) {
    assert.equal(engine.stats.models.get(model).problems, stat.problems)
    near(engine.stats.models.get(model).wy, stat.wy, 1e-10)
    const row = engine.ratings.get(model)
    assert.equal(row.problems, stat.problems)
    assert.equal(row.lowSample, stat.problems < score.RATING_MIN_PROBLEMS)
    assert.equal(row.status, stat.problems < score.RATING_MIN_PROBLEMS ? `样本少(${stat.problems} 题)` : '正式榜')
  }
  assert.equal(engine.ratings.size, expected.ratings.size)
  for (const [model, rating] of expected.ratings) near(engine.ratings.get(model).rating, rating)
  if (engine.ratings.size) {
    const mean = [...engine.ratings.values()].reduce((sum, row) => sum + row.rating, 0) / engine.ratings.size
    near(mean, 1000, 1e-7)
  }
}

test('weighted score, problem-adaptive anchors, AC dominance, multi-round trajectory, and normalized mastery', () => {
  assert.equal(score.weightedRoundScore(100, { timeMs: 1000, memoryMb: 125 }), 100)
  assert.equal(score.weightedRoundScore(100, { timeMs: 8000, memoryMb: 512 }, { timeLimit: 8000, memoryLimit: 2048 }), 100)
  assert.equal(score.weightedRoundScore(100, { timeMs: 0, memoryMb: 125 }), null)
  assert.equal(score.weightedRoundScore(null, { timeMs: 1000, memoryMb: 125 }), null)
  assert.equal(score.RATING_SCORE_CAP, 140)
  assert.equal(score.ratingNormalizedScore(null), null)
  near(score.ratingNormalizedScore(70), 0.5, 1e-12)
  assert.ok(score.ratingNormalizedScore(0) > 0 && score.ratingNormalizedScore(140) < 1)
  // Correctness dominance theorem: even extreme slow/heavy 100 AC strictly beats ultra-fast <=80 WA
  const slowHeavyAc = score.weightedRoundScore(100, { timeMs: 1e7, memoryMb: 1e5 }, { timeLimit: 1000, memoryLimit: 512 })
  const fastLean80 = score.weightedRoundScore(80, { timeMs: 0.01, memoryMb: 0.01 }, { timeLimit: 1000, memoryLimit: 512 })
  assert.ok(slowHeavyAc > fastLean80, `${slowHeavyAc} must exceed ${fastLean80}`)
  // Multi-round discounted envelope axioms
  assert.equal(score.trajectoryScore([]), null)
  assert.equal(score.trajectoryScore([null, null]), null)
  assert.equal(score.trajectoryScore([100]), 100)
  assert.equal(score.trajectoryScore([100, 30]), 100)
  assert.equal(score.trajectoryScore([null, 100]), 85)
  assert.ok(score.trajectoryScore([100]) > score.trajectoryScore([90, 100]))
  assert.ok(score.trajectoryScore([90, 100]) > score.trajectoryScore([60, 100]))
  assert.ok(score.trajectoryScore([60, 100]) > score.trajectoryScore([0, 100]))
  assert.ok(score.trajectoryScore([0, 100]) > score.trajectoryScore([0, 0, 100]))
  assert.ok(score.trajectoryScore([100, 120]) > score.trajectoryScore([100]))
  assert.ok(score.trajectoryScore([100, 120]) < score.trajectoryScore([120]))
  // Equal scores yield exact 1000 anchor
  const tied = score.irtFit(['a', 'b'], [{ pid: 'P1', model: 'a', score: 85 }, { pid: 'P1', model: 'b', score: 85 }])
  near(tied.get('a'), 1000, 1e-9)
  near(tied.get('b'), 1000, 1e-9)
  const a = score.arenaRandom('same'), b = score.arenaRandom('same')
  assert.deepEqual(Array.from({ length: 20 }, a), Array.from({ length: 20 }, b))
})

test('Empirical-Bayes multi-testcase time anchor calibrates summed Luogu timeMs fairly', () => {
  // 1) Prior anchor hierarchy: standard 10 * 1000ms = 10000ms -> 1000ms exact identity
  assert.equal(score.priorTimeAnchorMs({ timeLimit: 1000, totalTimeLimit: 10000, testCases: 10 }), 1000)
  assert.equal(score.priorTimeAnchorMs({ timeLimit: 2000, testCases: 56 }), 11200)
  assert.equal(score.priorTimeAnchorMs({ timeLimit: 8000 }), 8000)
  assert.equal(score.priorTimeAnchorMs({}), 1000)

  // 2) Ynoi heavy 56-case problem (P12082): single limit 2000ms, summed limit 112000ms, peer ACs ~54s
  const problems = {
    P12082: { pid: 'P12082', timeLimit: 2000, totalTimeLimit: 112000, testCases: 56, memoryLimit: 512 },
    P17240: { pid: 'P17240', timeLimit: 3500, totalTimeLimit: 259000, testCases: 74, memoryLimit: 512 },
  }
  const records = [
    { id: 'y1', model: 'M1', pid: 'P12082', status: 'approved', createdAt: '2026-09-10T00:00:00Z',
      submissions: [{ score: 100, timeMs: 50650, memoryMb: 128, result: 'AC' }] },
    { id: 'y2', model: 'M2', pid: 'P12082', status: 'approved', createdAt: '2026-09-10T00:00:00Z',
      submissions: [{ score: 100, timeMs: 54250, memoryMb: 128, result: 'AC' }] },
    { id: 'y3', model: 'M3', pid: 'P12082', status: 'approved', createdAt: '2026-09-10T00:00:00Z',
      submissions: [{ score: 100, timeMs: 65000, memoryMb: 128, result: 'AC' }] },
    // Fast 0/60 WA and unapproved pending records MUST NOT pollute the peer AC anchor
    { id: 'y-wa', model: 'FastFail', pid: 'P12082', status: 'approved', createdAt: '2026-09-10T00:00:00Z',
      submissions: [{ score: 60, timeMs: 5, memoryMb: 4, result: 'WA' }] },
    { id: 'y-pend', model: 'Pending', pid: 'P12082', status: 'pending', createdAt: '2026-09-10T00:00:00Z',
      submissions: [{ score: 100, timeMs: 1, memoryMb: 4, result: 'AC' }] },
    // Duplicate thinking variants of M3 get 1 model vote, not multiple votes
    { id: 'y3-low', model: 'M3', pid: 'P12082', status: 'approved', createdAt: '2026-09-10T00:00:00Z',
      submissions: [{ score: 100, timeMs: 65000, memoryMb: 128, result: 'AC' }] },
    // IOI small-subtask problem (P17240): summed limit 259s, peer ACs 100ms vs 200ms
    { id: 's1', model: 'M1', pid: 'P17240', status: 'approved', createdAt: '2026-09-10T00:00:00Z',
      submissions: [{ score: 100, timeMs: 100, memoryMb: 64, result: 'AC' }] },
    { id: 's2', model: 'M2', pid: 'P17240', status: 'approved', createdAt: '2026-09-10T00:00:00Z',
      submissions: [{ score: 100, timeMs: 200, memoryMb: 64, result: 'AC' }] },
    { id: 's3', model: 'M3', pid: 'P17240', status: 'approved', createdAt: '2026-09-10T00:00:00Z',
      submissions: [{ score: 100, timeMs: 150, memoryMb: 64, result: 'AC' }] },
  ]
  const anchors = score.computeProblemTimeAnchors(records, problems)
  // Exact 3-model EB log-mean check (M3 deduplicated; FastFail & Pending ignored)
  const expectedP12082 = Math.exp((2 * Math.log(11200) + Math.log(50650) + Math.log(54250) + Math.log(65000)) / 5)
  near(anchors.get('P12082'), expectedP12082, 1e-6)

  const ds = v2data.toV2Dataset({ problems, records })
  assert.deepEqual(Object.keys(ds.problems), ['P12082', 'P17240'])
  const wtYnoi = score.timeWeight(54250, ds.problems.P12082)
  assert.ok(wtYnoi > 0.90, `Ynoi median AC timeWeight ${wtYnoi} should not be docked to 0.77`)
  // P17240 speed spread between 100ms and 200ms is preserved (instead of saturating at 1.248 vs 25900ms)
  const s1Score = ds.records.find((r) => r.id === 's1').submissions[0].score
  const s2Score = ds.records.find((r) => r.id === 's2').submissions[0].score
  assert.ok(s1Score - s2Score > 1.0, `Expected meaningful speed spread on P17240: ${s1Score} vs ${s2Score}`)
})

test('Quasi-Rasch IRT eliminates easy-problem ceiling penalty, cherry-picking bias, and narrow 1-problem CIs', () => {
  // 1) Cherry-picking & ceiling-compression regression:
  // Strong solves all 8 problems (5 hard + 3 easy near ceiling); Cherry only plays the 5 hard problems and loses 0-5 to Strong;
  // Weak plays all 8 problems (scores poorly on hard, ~114 on easy).
  const byProblem = new Map()
  for (let i = 0; i < 5; i++) {
    byProblem.set(`Hard-${i}`, [
      { model: 'Strong', score: 125 },
      { model: 'Cherry', score: 65 },
      { model: 'Average', score: 45 },
      { model: 'Weak', score: 5 },
    ])
  }
  const hardOnly = score.irtRating(byProblem, { seed: 'irt-check', bootstrap: 120 })
  for (let i = 0; i < 3; i++) {
    byProblem.set(`Easy-${i}`, [
      { model: 'Strong', score: 136 },
      { model: 'Average', score: 122 },
      { model: 'Weak', score: 112 },
    ])
  }
  // Add a 1-problem tourist on Easy-0 (faces 3 opponents, or even 12 opponents!)
  byProblem.get('Easy-0').push({ model: 'Tourist-1Prob', score: 128 })
  const full = score.irtRating(byProblem, { seed: 'irt-check', bootstrap: 200 })

  // Strong swept Cherry 5-0 and dominated Easy problems -> must substantially outrank Cherry!
  assert.ok(full.get('Strong').rating - full.get('Cherry').rating > 120,
    `Strong (${full.get('Strong').rating}) must outrank Cherry (${full.get('Cherry').rating}) by >120 Elo`)
  // Participating in easy problems at top speed must not collapse Strong vs Weak gap
  assert.ok(full.get('Strong').rating > hardOnly.get('Strong').rating - 15)
  // 1-problem Tourist shrinks toward 1000, is marked low-sample, and has wider 95% CI than 8-problem Strong!
  const tourist = full.get('Tourist-1Prob')
  const strong = full.get('Strong')
  assert.equal(tourist.problems, 1)
  assert.equal(tourist.lowSample, true)
  assert.equal(tourist.status, '样本少(1 题)')
  assert.equal(strong.lowSample, false)
  assert.equal(strong.status, '正式榜')
  assert.ok(Math.abs(tourist.rating - 1000) < 40, `1-problem model should shrink near 1000, got ${tourist.rating}`)
  assert.ok((tourist.hi - tourist.lo) > (strong.hi - strong.lo),
    `1-problem CI width (${tourist.hi - tourist.lo}) must exceed 8-problem CI width (${strong.hi - strong.lo})`)
})

test('point precedes 200 deterministic bootstrap intervals', async () => {
  const fixture = ratingFixture(3, 5)
  const events = []
  const engine = new IncrementalRatingEngine({ seed: 'default-200' })
  await engine.calculate(fixture.records, fixture.problems, { emit: (event) => events.push(event) })
  assert.deepEqual(events.map((event) => event.kind), ['point', 'ready'])
  assert.equal(events[0].ratings.get('Model-0').lo, null)
  assert.ok(Number.isFinite(events[1].ratings.get('Model-0').lo))
  assert.equal(engine.samples.length, 200)
  assert.ok(engine.lastDiagnostics.maxDelta < 0.0001)
  const cold = new IncrementalRatingEngine({ seed: 'default-200' })
  await cold.calculate(fixture.records, fixture.problems)
  assert.deepEqual([...engine.ratings], [...cold.ratings])
})

test('cold and deliberately poor warm starts converge on sparse and disconnected graphs', () => {
  const players = Array.from({ length: 12 }, (_, i) => `m${i}`)
  const cells = []
  for (let i = 0; i < 5; i++) {
    cells.push({ pid: `PA-${i}`, model: players[i], score: i % 2 ? 22 : 124 })
    cells.push({ pid: `PA-${i}`, model: players[i + 1], score: i % 2 ? 115 : 28 })
    cells.push({ pid: `PB-${i}`, model: players[i + 6], score: i % 2 ? 38 : 118 })
    cells.push({ pid: `PB-${i}`, model: players[i + 7], score: i % 2 ? 96 : 24 })
  }
  const stats = score.irtStats(cells)
  const solve = (initialStrengths, initialDifficulties = null) => {
    const solver = score.createIrtSolver(players, stats, { initialStrengths, initialDifficulties, tolerance: 1e-9 })
    while (!solver.done) solver.advance(32)
    assert.equal(solver.converged, true)
    assert.ok(solver.iterations >= 3)
    return solver
  }
  const cold = solve(null)
  const warm = solve(
    new Map(players.map((model, i) => [model, i % 2 ? 1e6 : 1e-6])),
    new Map([...stats.problems.keys()].map((pid, i) => [pid, i % 2 ? 2200 : 100])),
  )
  for (const [model, rating] of cold.ratings()) near(warm.ratings().get(model), rating, 1e-6)
  for (const [pid, diff] of cold.difficulties()) near(warm.difficulties().get(pid), diff, 1e-6)
  near([...warm.ratings().values()].reduce((sum, value) => sum + value, 0) / players.length, 1000, 1e-8)
  assert.throws(() => score.irtFit(players, stats, { converge: true, maxIterations: 1 }), /did not converge/)
})

test('incremental score edit reuses draws and matches cold point and intervals', async () => {
  const fixture = ratingFixture()
  const engine = new IncrementalRatingEngine(options)
  await engine.calculate(fixture.records, fixture.problems)
  const multiplicity = engine.samples[0].multiplicity
  const priorTargets = engine.samples[0].priorTargets
  const edited = structuredClone(fixture.records)
  edited[0].submissions[0].score += 6
  await engine.calculate(edited, fixture.problems)
  compareReference(engine, edited, fixture.problems, 'bestLevel')
  assert.equal(engine.lastDiagnostics.affectedCells, 1)
  assert.equal(engine.lastDiagnostics.changedActiveCells, 1)
  assert.equal(engine.lastDiagnostics.changedEdges, 4)
  assert.equal(engine.lastDiagnostics.graphChanged, false)
  assert.equal(engine.lastDiagnostics.bootstrapReused, true)
  assert.equal(engine.samples[0].multiplicity, multiplicity)
  assert.equal(engine.samples[0].priorTargets, priorTargets)
  const cold = new IncrementalRatingEngine(options)
  await cold.calculate(edited, fixture.problems)
  for (const [model, row] of engine.ratings) {
    near(row.lo, cold.ratings.get(model).lo)
    near(row.hi, cold.ratings.get(model).hi)
  }
})

test('all metrics replay insert, delete, rename, pending, missing and catalog changes', async () => {
  for (const mode of ['bestLevel', 'bestScore', 'avg', 'final', 'status']) {
    const fixture = ratingFixture(4, 7)
    const engine = new IncrementalRatingEngine({ ...options, mode, bootstrap: 3 })
    let records = structuredClone(fixture.records), problems = structuredClone(fixture.problems)
    const verify = async () => {
      await engine.calculate(records, problems)
      compareReference(engine, records, problems, mode)
    }
    await verify()
    records.push({ ...records[0], id: 'higher', thinking: 'max', submissions: [{ score: 70, result: 'AC' }] })
    await verify()
    records.at(-1).submissions[0].score = null
    await verify()
    records.pop()
    await verify()
    records[1].model = 'New-model'
    await verify()
    records[2].status = 'pending'
    await verify()
    delete problems.P1001
    await verify()
    problems.P1001 = { pid: 'P1001' }
    await verify()
    // Single-model comparative guard + recovery when a second model returns
    const singleOnly = records.filter((record) => record.model === 'Model-0')
    const backup = records
    records = singleOnly
    await verify()
    assert.equal(engine.ratings.size, 0)
    records = backup.filter((record) => record.model === 'Model-0' || (record.model === 'New-model' && record.pid === 'P1000'))
    await verify()
    if (mode !== 'status') assert.equal(engine.ratings.size, 2)
    records = []
    await verify()
  }
})

test('same-level records combine trajectory scores, unshadow null higher levels, and restore fallback', async () => {
  const records = [
    { id: '0', model: 'A', pid: 'P1', thinking: 'max', submissions: [{ score: null }] },
    { id: '1', model: 'A', pid: 'P1', thinking: 'high', submissions: [{ score: 40 }, { score: 80 }] },
    { id: '2', model: 'A', pid: 'P1', thinking: 'high', submissions: [{ score: 30 }] },
    { id: '3', model: 'A', pid: 'P1', thinking: 'low', submissions: [{ score: 99 }] },
    { id: '4', model: 'B', pid: 'P1', thinking: 'low', submissions: [{ score: 50 }] },
  ]
  const engine = new IncrementalRatingEngine({ ...options, bootstrap: 0 })
  const problems = { P1: { pid: 'P1' } }
  await engine.calculate(records, problems)
  // id '0' (max, null) does not shadow 'high'; id '1' trajectory = 40 + 0.85*(80-40) = 74; avg with id '2' (30) = 52
  assert.equal(engine.byProblem.get('P1').get('A').value, 52)
  await engine.calculate(records.slice(3), problems)
  assert.equal(engine.byProblem.get('P1').get('A').value, 99)
  compareReference(engine, records.slice(3), problems, 'bestLevel')
})

test('unchanged input bypasses fitting and descriptive edits do not invalidate rating', async () => {
  const fixture = ratingFixture(3, 4)
  const engine = new IncrementalRatingEngine(options)
  await engine.calculate(fixture.records, fixture.problems)
  const ratings = engine.ratings
  const records = fixture.records.map((record) => ({ ...record, note: 'edited note', updatedAt: '2026-10-01' }))
  const events = []
  await engine.calculate(records, fixture.problems, { emit: (event) => events.push(event.kind) })
  assert.equal(engine.ratings, ratings)
  assert.deepEqual(events, ['ready'])
})

test('cancellation prevents ready and the next request resumes safely', async () => {
  const fixture = ratingFixture(4, 5)
  const engine = new IncrementalRatingEngine(options)
  let cancelled = false
  const events = []
  await assert.rejects(engine.calculate(fixture.records, fixture.problems, {
    cancelled: () => cancelled,
    emit: (event) => { events.push(event.kind); cancelled = true },
  }), RatingCancelled)
  assert.deepEqual(events, ['point'])
  assert.equal(engine.ready, false)
  await engine.calculate(fixture.records, fixture.problems)
  compareReference(engine, fixture.records, fixture.problems, 'bestLevel')
  assert.equal(engine.ready, true)
})

test('real event-loop cancellation interrupts intervals and resumes to the cold result', async () => {
  const fixture = ratingFixture(20, 40)
  const engine = new IncrementalRatingEngine({ ...options, bootstrap: 200 })
  let cancelled = false
  let timer
  const events = []
  await assert.rejects(engine.calculate(fixture.records, fixture.problems, {
    cancelled: () => cancelled,
    emit: (event) => {
      events.push(event.kind)
      if (event.kind === 'point') timer = setTimeout(() => { cancelled = true }, 0)
    },
  }), RatingCancelled)
  clearTimeout(timer)
  assert.deepEqual(events, ['point'])
  assert.ok(engine.samples.length < 200)
  await engine.calculate(fixture.records, fixture.problems)
  const cold = new IncrementalRatingEngine({ ...options, bootstrap: 200 })
  await cold.calculate(fixture.records, fixture.problems)
  for (const [model, row] of cold.ratings) {
    near(engine.ratings.get(model).rating, row.rating)
    near(engine.ratings.get(model).lo, row.lo)
    near(engine.ratings.get(model).hi, row.hi)
  }
})

test('graph changes regenerate deterministic draws even when the cell count is unchanged', async () => {
  const fixture = ratingFixture(4, 6)
  const engine = new IncrementalRatingEngine(options)
  await engine.calculate(fixture.records, fixture.problems)
  const draws = engine.samples[0].multiplicity
  const renamed = fixture.records.map((record) => record.model === 'Model-0' ? { ...record, model: 'Renamed' } : record)
  await engine.calculate(renamed, fixture.problems)
  assert.equal(engine.lastDiagnostics.graphChanged, true)
  assert.notEqual(engine.samples[0].multiplicity, draws)
  const cold = new IncrementalRatingEngine(options)
  await cold.calculate(renamed, fixture.problems)
  for (const [model, row] of cold.ratings) {
    near(engine.ratings.get(model).rating, row.rating)
    near(engine.ratings.get(model).lo, row.lo)
    near(engine.ratings.get(model).hi, row.hi)
  }
  const ratings = engine.ratings
  await engine.calculate([...renamed].reverse(), fixture.problems)
  assert.equal(engine.ratings, ratings)
  assert.equal(engine.lastDiagnostics.changedRecords, 0)
})

test('compact public checkpoint restores and fresh records still invalidate it', async () => {
  const fixture = ratingFixture(4, 4)
  const engine = new IncrementalRatingEngine(options)
  await engine.calculate(fixture.records, fixture.problems)
  const checkpoint = engine.checkpoint()
  assert.ok(!JSON.stringify(checkpoint).includes('createdAt'))
  const restored = new IncrementalRatingEngine(options)
  assert.equal(restored.restore(structuredClone(checkpoint)), true)
  await restored.calculate(fixture.records, fixture.problems)
  assert.equal(restored.lastDiagnostics.cacheHit, true)
  fixture.records[0].submissions[0].score += 10
  await restored.calculate(fixture.records, fixture.problems)
  compareReference(restored, fixture.records, fixture.problems, 'bestLevel')
  assert.equal(new IncrementalRatingEngine({ ...options, seed: 'wrong' }).restore(checkpoint), false)
})

test('memory budget preserves deterministic intervals without retaining bootstrap states', async () => {
  const fixture = ratingFixture(3, 4)
  const engine = new IncrementalRatingEngine({ ...options, maxBootstrapBytes: 0 })
  await engine.calculate(fixture.records, fixture.problems)
  assert.equal(engine.samples.length, 0)
  assert.equal(engine.lastDiagnostics.bootstrapRetained, false)
  const cold = new IncrementalRatingEngine(options)
  await cold.calculate(fixture.records, fixture.problems)
  assert.deepEqual([...engine.ratings], [...cold.ratings])
})

test('client ignores cancelled and superseded messages and excludes private checkpoints', async () => {
  const messages = [], events = []
  const worker = { postMessage: (message) => messages.push(message), terminate() {} }
  const client = clientModule.createRatingClient(worker)
  const cancel = client.calculate({ scope: 'private', cachePublic: true }, (event) => events.push(event.kind), 'test')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const request = messages.find((message) => message.type === 'calculate')
  cancel()
  worker.onmessage({ data: { id: request.id, kind: 'ready', ratings: [] } })
  assert.deepEqual(events, [])
  client.calculate({ scope: 'private', cachePublic: true }, (event) => events.push(event.kind), 'test')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const second = messages.findLast((message) => message.type === 'calculate')
  worker.onmessage({ data: { id: second.id, kind: 'ready', ratings: [] } })
  worker.onmessage({ data: { id: second.id, kind: 'error', error: 'late' } })
  assert.deepEqual(events, ['ready'])
  let opened = false
  globalThis.indexedDB = { open() { opened = true; throw new Error('must not open private store') } }
  assert.equal(await checkpointModule.loadRatingCheckpoint({ scope: 'owner', cachePublic: true }), null)
  await checkpointModule.saveRatingCheckpoint({ scope: 'owner', cachePublic: true }, { ready: true })
  assert.equal(opened, false)
  delete globalThis.indexedDB
  client.dispose()
})

for (const [name, run] of tests) {
  await run()
  passed++
  console.log(`PASS ${name}`)
}
console.log(`${passed}/${tests.length} rating checks passed`)
