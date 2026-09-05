import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 独立只读演示：仅使用入库的合成测试样本，不连接 D1 或线上 API。
const fixture = JSON.parse(readFileSync(new URL('./selftest/fixture.basic.json', import.meta.url), 'utf8'))
const data = { ...fixture, revision: 1, records: fixture.records.filter((r) => r.status === 'approved') }
const contributors = [{ username: 'selftest', nickname: '全民制作人', uid: null, role: 'legacy',
  count: data.records.length, createdAt: '2026-07-01T00:00:00.000Z' }]

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'readonly-synthetic-demo',
      configureServer(server) {
        server.middlewares.use('/api', (req, res) => {
          const path = new URL(req.url, 'http://localhost').pathname
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.end(JSON.stringify({ error: '只读演示不保存数据，请使用本地 Worker 测试写入。' }))
            return
          }
          const payloads = {
            '/ping': { ok: true },
            '/session': { loggedIn: false, configured: true, canSetup: false },
            '/data': data,
            '/models': { models: fixture.models },
            '/contributors': { contributors },
            '/export/public': data,
          }
          res.statusCode = path in payloads ? 200 : 404
          res.end(JSON.stringify(payloads[path] || { error: '演示接口不存在' }))
        })
      },
      transformIndexHtml(html) {
        return html.replace('<title>', '<title>[合成数据预览] ')
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5176, strictPort: true },
})
