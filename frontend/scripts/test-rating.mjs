import assert from 'node:assert/strict'
import { loadRatingModule, ratingFixture } from './rating-test-helpers.mjs'

const engineModule = await loadRatingModule('../src/ratingEngine.js')
const score = await loadRatingModule('../src/score.js')
const aggregate = await loadRatingModule('../src/aggregate.js')
const clientModule = await loadRatingModule('../src/ratingClient.js')
const checkpointModule = await loadRatingModule('../src/ratingCheckpoint.js')
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
    if (mode === 'bestLevel' || mode === 'bestScore') value = aggregate.bestThinkingCell(group, mode === 'bestLevel' ? 'level' : 'score').value
    else if (mode !== 'status') {
      const cell = aggregate.matrixCell(group, model, pid)
      value = (mode === 'final' ? cell.finalInfo : cell.scoreInfo)?.avg ?? null
    }
    if (value === null) continue
    if (!byProblem.has(pid)) byProblem.set(pid, [])
    byProblem.get(pid).push({ model, score: value })
  }
  const games = score.arenaGames(byProblem)
  const players = [...new Set(games.flatMap((game) => [game.a, game.b]))].sort()
  return {
    games, stats: score.arenaStats(games),
    ratings: score.bradleyTerry(players, games, { converge: true, tolerance: 1e-8 }),
  }
}

function compareReference(engine, records, problems, mode) {
  const expected = reference(records, problems, mode)
  assert.equal(engine.edges.size, expected.games.length)
  assert.deepEqual([...engine.stats.totals].sort(), [...expected.stats.totals].sort())
  for (const [model, share] of expected.stats.wins) near(engine.stats.wins.get(model), share, 1e-8)
  assert.equal(engine.ratings.size, expected.ratings.size)
  for (const [model, rating] of expected.ratings) near(engine.ratings.get(model).rating, rating)
}

test('weighted score, null, anchors, and legacy solver exports', () => {
  assert.equal(score.weightedRoundScore(100, { timeMs: 1000, memoryMb: 125 }), 100)
  assert.equal(score.weightedRoundScore(100, { timeMs: 0, memoryMb: 125 }), null)
  assert.equal(score.weightedRoundScore(null, { timeMs: 1000, memoryMb: 125 }), null)
  const tied = score.bradleyTerry(['a', 'b'], [{ a: 'a', b: 'b', s: 0.5 }])
  near(tied.get('a'), 1000)
  near(tied.get('b'), 1000)
  assert.equal(score.arenaOutcome(0, 0), 0.5)
  const a = score.arenaRandom('same'), b = score.arenaRandom('same')
  assert.deepEqual(Array.from({ length: 20 }, a), Array.from({ length: 20 }, b))
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
  const games = []
  for (let i = 0; i < 5; i++) {
    games.push({ a: players[i], b: players[i + 1], s: i % 2 ? 0.23 : 0.86 })
    games.push({ a: players[i + 6], b: players[i + 7], s: i % 2 ? 0.4 : 0.8 })
  }
  const stats = score.arenaStats(games)
  const solve = (initialStrengths) => {
    const solver = score.createBradleyTerrySolver(players, stats, { initialStrengths, tolerance: 1e-9 })
    while (!solver.done) solver.advance(32)
    assert.equal(solver.converged, true)
    assert.ok(solver.iterations >= 3)
    return solver
  }
  const cold = solve(null)
  const warm = solve(new Map(players.map((model, i) => [model, i % 2 ? 1e6 : 1e-6])))
  for (const [model, rating] of cold.ratings()) near(warm.ratings().get(model), rating, 1e-6)
  near([...warm.ratings().values()].reduce((sum, value) => sum + value, 0) / players.length, 1000, 1e-8)
  assert.throws(() => score.bradleyTerry(players, games, { converge: true, maxIterations: 1 }), /did not converge/)
})

test('incremental score edit reuses draws and matches cold point and intervals', async () => {
  const fixture = ratingFixture()
  const engine = new IncrementalRatingEngine(options)
  await engine.calculate(fixture.records, fixture.problems)
  const multiplicity = engine.samples[0].multiplicity
  const edited = structuredClone(fixture.records)
  edited[0].submissions[0].score += 6
  await engine.calculate(edited, fixture.problems)
  compareReference(engine, edited, fixture.problems, 'bestLevel')
  assert.equal(engine.lastDiagnostics.affectedCells, 1)
  assert.equal(engine.lastDiagnostics.changedEdges, 4)
  assert.equal(engine.lastDiagnostics.graphChanged, false)
  assert.equal(engine.lastDiagnostics.bootstrapReused, true)
  assert.equal(engine.samples[0].multiplicity, multiplicity)
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
    records = records.filter((record) => record.model === 'Model-0')
    await verify()
    assert.equal(engine.ratings.size, 0)
    records = []
    await verify()
  }
})

test('same-level records retain round weights and a removed winner restores the fallback', async () => {
  const records = [
    { id: '1', model: 'A', pid: 'P1', thinking: 'high', submissions: [{ score: 90 }, { score: 30 }] },
    { id: '2', model: 'A', pid: 'P1', thinking: 'high', submissions: [{ score: 30 }] },
    { id: '3', model: 'A', pid: 'P1', thinking: 'low', submissions: [{ score: 99 }] },
    { id: '4', model: 'B', pid: 'P1', thinking: 'low', submissions: [{ score: 50 }] },
  ]
  const engine = new IncrementalRatingEngine({ ...options, bootstrap: 0 })
  const problems = { P1: { pid: 'P1' } }
  await engine.calculate(records, problems)
  assert.equal(engine.byProblem.get('P1').get('A').value, 50)
  await engine.calculate(records.slice(2), problems)
  assert.equal(engine.byProblem.get('P1').get('A').value, 99)
  compareReference(engine, records.slice(2), problems, 'bestLevel')
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
  const fixture = ratingFixture(10, 20)
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

test('graph changes regenerate deterministic draws even when the edge count is unchanged', async () => {
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
