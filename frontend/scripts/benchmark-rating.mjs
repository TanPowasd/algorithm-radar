import { readFileSync } from 'node:fs'
import { loadRatingModule, ratingFixture } from './rating-test-helpers.mjs'

const { IncrementalRatingEngine } = await loadRatingModule('../src/ratingEngine.js')
const { toV2Dataset } = await loadRatingModule('../src/v2data.js')
const runs = Number(process.env.RATING_RUNS || 5)
const bootstrap = Number(process.env.RATING_BOOTSTRAP || 200)
const largeBootstrap = Number(process.env.RATING_LARGE_BOOTSTRAP || bootstrap)
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]
const summarize = (values) => ({
  changedCells: values.at(-1).changedCells, changedEdges: values.at(-1).changedEdges,
  edges: values.at(-1).edges, graphChanged: values.at(-1).graphChanged,
  bootstrapReused: values.at(-1).bootstrapReused, bootstrapRetained: values.at(-1).bootstrapRetained,
  iterations: values.at(-1).iterations, sampleIterations: values.at(-1).sampleIterations,
  medianPointMs: percentile(values.map((value) => value.pointMs), 0.5),
  p95PointMs: percentile(values.map((value) => value.pointMs), 0.95),
  medianIntervalsMs: percentile(values.map((value) => Math.max(0, value.elapsedMs - value.pointMs)), 0.5),
  p95IntervalsMs: percentile(values.map((value) => Math.max(0, value.elapsedMs - value.pointMs)), 0.95),
  medianElapsedMs: percentile(values.map((value) => value.elapsedMs), 0.5),
  p95ElapsedMs: percentile(values.map((value) => value.elapsedMs), 0.95),
})

async function benchmark(name, input, samples, repetitions = runs) {
  const results = { cold: [], scoreEdit: [], newEdge: [], unchanged: [] }
  let intervalsValid = true
  for (let run = 0; run < repetitions; run++) {
    const fixture = structuredClone(input)
    const engine = new IncrementalRatingEngine({ bootstrap: samples, seed: 'benchmark-v1' })
    const calculate = async (phase) => {
      await engine.calculate(fixture.records, fixture.problems)
      process.stderr.write(`${name} ${run + 1}/${repetitions} ${phase}: point=${engine.lastDiagnostics.pointMs.toFixed(1)}ms total=${engine.lastDiagnostics.elapsedMs.toFixed(1)}ms\n`)
      results[phase].push({ ...engine.lastDiagnostics })
      for (const row of engine.ratings.values()) {
        intervalsValid &&= Number.isFinite(row.rating) && Number.isFinite(row.lo)
          && Number.isFinite(row.hi) && row.lo <= row.hi
      }
    }
    await calculate('cold')
    const edited = fixture.records.find((record) => (record.submissions || []).some((sub) => typeof sub.score === 'number'))
    if (edited) edited.submissions.find((sub) => typeof sub.score === 'number').score += 1
    await calculate('scoreEdit')
    if (edited) fixture.records.push({
      ...edited, id: 'benchmark-new-edge', model: 'Benchmark-New-model',
      submissions: [{ score: 65, result: 'WA' }],
    })
    await calculate('newEdge')
    await calculate('unchanged')
  }
  return {
    name, synthetic: !name.startsWith('actual'), models: new Set(input.records.map((record) => record.model)).size,
    problems: Object.keys(input.problems).length, records: input.records.length,
    bootstrap: samples, runs: repetitions, intervalsValid,
    ...Object.fromEntries(Object.entries(results).map(([kind, values]) => [kind, summarize(values)])),
    ...(process.env.RATING_RAW_TIMINGS === '1' ? { timings: Object.fromEntries(Object.entries(results).map(([kind, values]) => [kind,
      values.map(({ pointMs, elapsedMs }) => ({ pointMs, intervalsMs: Math.max(0, elapsedMs - pointMs), elapsedMs }))])) } : {}),
    heapMiB: process.memoryUsage().heapUsed / 1024 / 1024,
  }
}

const profiles = []
if (process.env.RATING_SOURCE_URL || process.env.RATING_SOURCE_FILE) {
  let raw
  if (process.env.RATING_SOURCE_URL) {
    const response = await fetch(process.env.RATING_SOURCE_URL)
    if (!response.ok) throw new Error(`Rating source returned HTTP ${response.status}`)
    raw = await response.json()
  } else raw = JSON.parse(readFileSync(process.env.RATING_SOURCE_FILE, 'utf8'))
  if (!Array.isArray(raw.records) || !raw.problems) throw new Error('Rating source is not a snapshot')
  const actual = toV2Dataset(raw)
  actual.records = actual.records.filter((record) => record.status === 'approved')
  profiles.push(await benchmark('actual-public-data', actual, bootstrap))
}
profiles.push(await benchmark('current-dimensions-34x11', ratingFixture(34, 11, 41), bootstrap))
profiles.push(await benchmark('large-10000-records', ratingFixture(50, 200, 41), largeBootstrap))
if (largeBootstrap !== bootstrap && process.env.RATING_SKIP_LARGE_FULL !== '1') {
  const fixture = ratingFixture(50, 200, 41)
  const engine = new IncrementalRatingEngine({ bootstrap, seed: 'benchmark-v1' })
  await engine.calculate(fixture.records, fixture.problems)
  profiles.push({
    name: 'large-10000-records-production-bootstrap', synthetic: true, runs: 1,
    ...engine.lastDiagnostics, intervalsMs: engine.lastDiagnostics.elapsedMs - engine.lastDiagnostics.pointMs,
    intervalsValid: [...engine.ratings.values()].every((row) => Number.isFinite(row.lo) && Number.isFinite(row.hi) && row.lo <= row.hi),
  })
}
console.log(JSON.stringify({
  node: process.version, scoring: 'Quasi-Rasch IRT damped Newton <0.0001 Elo for three iterations; seed benchmark-v1',
  note: largeBootstrap === bootstrap ? 'All profiles use the production bootstrap count.'
    : 'Large repeated profile reduces bootstrap count to bound runtime; an additional production-count cold run is reported separately.',
  profiles,
}, null, 2))
