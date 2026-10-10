import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDemoData, demoMiddleware } from './demo-data.mjs'
import { weightedRoundScore, V2_CUTOFF_ISO } from '../src/score.js'

const fixture = JSON.parse(readFileSync(new URL('../selftest/fixture.basic.json', import.meta.url), 'utf8'))
const original = JSON.stringify(fixture)
const demo = createDemoData(fixture)
const dispatch = (url, method = 'GET') => {
  const result = { headers: {}, status: 200 }
  demoMiddleware(demo)({ url, method }, { setHeader: (key, value) => { result.headers[key] = value },
    end: (body) => { result.body = body }, set statusCode(value) { result.status = value } })
  return result
}
for (const path of ['/data?view=compact', '/session', '/problems/P1001', '/contributors', '/competitions',
  '/competitions/kaggriculture', '/arena/replays/demo', '/arena/h2h?a=A&b=B', '/export/public?format=csv', '/export/public?format=json']) {
  assert.equal(dispatch(path).status, 200, path)
}
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(dispatch('/data', method).status, 405)
assert.equal(dispatch('/missing').status, 404)
assert.equal(dispatch('/problems/P999999').status, 404)
assert.equal(JSON.parse(dispatch('/contributors').body).contributors[0].contributions, demo.data.records.length)
const summary = JSON.parse(dispatch('/data?view=compact').body).problems.P1001
assert.equal(summary.content, undefined)
assert.equal(summary.hasContent, true)
assert.match(JSON.parse(dispatch('/problems/P1001').body).problem.content, /合成题面/)
assert.ok(demo.data.records.every((record) => record.status === 'approved' && !record.deletedAt && record.createdAt >= V2_CUTOFF_ISO))
assert.ok(demo.data.records.some((record) => record.submissions.some((submission) => weightedRoundScore(submission.score, submission) !== null)))
const csv = dispatch('/export/public?format=csv')
assert.match(csv.headers['Content-Type'], /text\/csv/)
assert.match(csv.headers['Content-Disposition'], /\.csv/)
assert.ok(csv.body.startsWith('\ufeffid,model'))
assert.equal(JSON.stringify(fixture), original, 'Demo enrichment must not mutate the canonical fixture')
console.log('PASS demo reads, readonly guard, compact/detail contract, contributor totals, populated rating and CSV/JSON export')
