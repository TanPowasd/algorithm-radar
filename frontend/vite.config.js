import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 开发态：前端 5174（5173 常被其他应用占用），/api 反代到 wrangler pages dev(8788)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
    },
  },
})
