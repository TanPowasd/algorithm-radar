import { build } from 'vite'
import { fileURLToPath } from 'node:url'

export async function loadRatingModule(file) {
  const entry = fileURLToPath(new URL(file, import.meta.url))
  const result = await build({
    configFile: false, logLevel: 'silent',
    build: { ssr: entry, write: false, minify: false, target: 'node22' },
  })
  const code = result.output.find((part) => part.type === 'chunk' && part.isEntry).code
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

export function ratingFixture(models = 5, problems = 12, seed = 11) {
  let state = seed >>> 0
  const random = () => { state = Math.imul(state, 1664525) + 1013904223; return (state >>> 0) / 4294967296 }
  const records = [], catalog = {}
  for (let p = 0; p < problems; p++) {
    const pid = `P${1000 + p}`
    catalog[pid] = { pid, title: `Problem ${p}` }
    for (let m = 0; m < models; m++) {
      records.push({
        id: `${p}:${m}`, model: `Model-${m}`, pid, thinking: 'high', status: 'approved',
        createdAt: '2026-09-10T00:00:00Z',
        submissions: [{ score: 15 + random() * 90, result: 'WA' }, { score: 10 + random() * 100, result: 'AC' }],
      })
    }
  }
  return { records, problems: catalog }
}
