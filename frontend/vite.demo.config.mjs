import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createDemoData, demoMiddleware } from './scripts/demo-data.mjs'

// 独立只读演示：仅使用入库的合成测试样本，不连接 D1 或线上 API。
const fixture = JSON.parse(readFileSync(new URL('./selftest/fixture.basic.json', import.meta.url), 'utf8'))
const demo = createDemoData(fixture)

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'readonly-synthetic-demo',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split('?')[0] === '/replay') req.url = req.url.replace('/replay', '/replay.html')
          next()
        })
        server.middlewares.use('/api', demoMiddleware(demo))
      },
      transformIndexHtml(html) {
        return html.replace('<title>', '<title>[合成数据预览] ')
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5176, strictPort: true },
})
