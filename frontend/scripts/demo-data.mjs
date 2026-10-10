// All enrichment stays in the local demo. The source fixture and production APIs are unchanged.
export function createDemoData(fixture) {
  const stamp = '2026-10-01T08:00:00.000Z'
  const problems = Object.fromEntries(Object.entries(fixture.problems).map(([pid, problem], index) => [pid, {
    ...problem, prompt: index % 2 ? '' : problem.prompt, timeLimit: 1000, memoryLimit: 125, hasContent: true,
    content: `# ${problem.title}\n\n> 合成题面，仅用于界面演示，并非洛谷原题。\n\n给定两个整数 a 和 b，输出它们的和。\n\n## 输入格式\n一行两个整数，以空格分隔。\n\n## 输出格式\n输出 a + b。\n\n## 样例\n输入：1 2\n输出：3`,
  }]))
  const records = fixture.records.filter((record) => record.status === 'approved' && !record.deletedAt).map((record, index) => {
    const createdAt = new Date(Date.parse(stamp) + index * 60000).toISOString()
    return { ...record, date: createdAt.slice(0, 10), createdAt, updatedAt: createdAt,
      submissions: record.submissions.map((submission, round) => ({ ...submission, timeMs: 250 + (index * 37 + round * 71) % 1400, memoryMb: 24 + index % 110 })),
      note: '合成数据演示 · 非真实测评',
    }
  })
  const data = { epoch: 'synthetic-demo-v2', scope: 'public', revision: 1, updatedAt: stamp, problems, records }
  const contributors = [{ username: 'selftest', nickname: '合成样本贡献者', uid: null, role: 'legacy',
    contributions: records.length, problems: new Set(records.map((record) => record.pid)).size,
    models: new Set(records.map((record) => record.model)).size, joinedAt: stamp, lastDate: records.at(-1)?.createdAt || stamp }]
  const names = fixture.models.slice(0, 2).map((model) => model.name)
  const competition = { id: 'kaggriculture', slug: 'kaggriculture', name: '农场对抗赛', subtitle: '合成对局 · 只读演示',
    scoreModel: '1v1_cash', status: 'live', sort: 1, matches: 2, replays: 1, rulesUrl: '', createdAt: stamp, lastPlayedAt: stamp }
  const matches = [0, 1].map((index) => ({ id: `demo-match-${index}`, competitionId: competition.id,
    aName: names[0], bName: names[1], aThinking: '', bThinking: '', winner: index ? 'B' : 'A',
    aCash: index ? 3500 : 4800, bCash: index ? 4800 : 3500, margin: 1300, games: 1,
    aWins: index ? 0 : 1, bWins: index ? 1 : 0, note: '合成单局战绩', author: 'selftest', authorId: null, playedAt: stamp, createdAt: stamp }))
  const standings = names.map((name) => ({ name, thinking: '', matches: 2, wins: 1, losses: 1, draws: 0,
    winRate: 0.5, netAvg: 0, netTotal: 0, bestWin: 1300, games: 2, gameWins: 1, gameLosses: 1, gameWinRate: 0.5, elo: 1500 }))
  const replay = { format: 'k4u-arena-replay/1', meta: { seed: 7, labels: names, winner: 'A', end_reason: 'cash',
    final_cash: [4800, 3500], cfg: { turnsPerDay: 24 }, sample_every: 3 },
    legend: { crops: { 1: 'WHEAT' }, animals: {}, items: [] },
    frames: Array.from({ length: 80 }, (_, index) => ({ t: index * 3, town: [], mkt: { prices: [], inv: [] },
      p: [0, 1].map((player) => ({ pos: [index % 10, player + 3], hands: [], money: 3000 + index * (player ? 13 : 41),
        tiles: Array.from({ length: 100 }, (_, cell) => cell % 10 === index % 10 ? '1' : '0').join(''), extra: {}, shed: {}, seeds: {}, inv: [] })),
      act: { a: ['PASS'], b: ['PASS'] } })) }
  const replays = [{ id: 'demo', competitionId: competition.id, aName: names[0], bName: names[1], seed: 7, winner: 'A',
    frames: replay.frames.length, steps: 237, bytes: Buffer.byteLength(JSON.stringify(replay)), author: 'selftest', createdAt: stamp }]
  return { data, models: fixture.models, contributors, competition, matches, standings, replay, replays }
}

export function demoMiddleware(demo) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    const send = (payload, status = 200) => {
      res.statusCode = status
      res.end(JSON.stringify(payload))
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'GET') return send({ error: '这是只读演示，登录、注册和写入请使用完整本地服务。' }, 405)
    if (path === '/export/public') {
      const csv = url.searchParams.get('format') === 'csv'
      res.setHeader('Content-Disposition', `attachment; filename="algorithm-radar-demo.${csv ? 'csv' : 'json'}"`)
      if (!csv) return send(demo.data)
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      const fields = ['id', 'model', 'pid', 'thinking', 'date', 'note']
      const escape = (value) => '"' + String(value ?? '').replaceAll('"', '""') + '"'
      return res.end('\ufeff' + [fields.join(','), ...demo.data.records.map((record) => fields.map((key) => escape(record[key])).join(','))].join('\r\n'))
    }
    if (path.startsWith('/problems/')) {
      const problem = demo.data.problems[decodeURIComponent(path.slice('/problems/'.length))]
      return problem ? send({ ok: true, problem }) : send({ error: '演示题库未收录此题，可使用标准模板。' }, 404)
    }
    if (path === '/data') {
      if (url.searchParams.get('view') !== 'compact') return send(demo.data)
      const problems = Object.fromEntries(Object.entries(demo.data.problems).map(([pid, problem]) => {
        const { content, ...summary } = problem
        return [pid, { ...summary, hasContent: Boolean(content), hasPrompt: Boolean(problem.prompt) }]
      }))
      return send({ ...demo.data, problems })
    }
    const payloads = {
      '/ping': { ok: true },
      '/session': { loggedIn: false, configured: true, canSetup: false, demo: true },
      '/models': { models: demo.models },
      '/contributors': { contributors: demo.contributors },
      '/competitions': { ok: true, competitions: [demo.competition] },
      '/competitions/kaggriculture': { ok: true, revision: 1, competition: demo.competition, competitionId: demo.competition.id,
        matches: demo.matches, standings: demo.standings, replays: demo.replays,
        pagination: { total: demo.matches.length, hasMore: false, nextCursor: null, limit: 300 } },
      '/arena/matches': { ok: true, matches: demo.matches, pagination: { total: demo.matches.length, hasMore: false, nextCursor: null, limit: 300 } },
      '/arena/replays': { ok: true, replays: demo.replays },
      '/arena/replays/demo': demo.replay,
    }
    if (path === '/arena/h2h') {
      const side = (name) => ({ name, seriesWins: 1, seriesLosses: 1, seriesDraws: 0, gameWins: 1, gameLosses: 1, cashAvg: 4150, netAvg: 0, bestWin: 1300 })
      return send({ ok: true, a: side(url.searchParams.get('a')), b: side(url.searchParams.get('b')), series: demo.matches, eloA: 1500, eloB: 1500 })
    }
    return path in payloads ? send(payloads[path]) : send({ error: '此功能不包含在本地演示中。' }, 404)
  }
}
