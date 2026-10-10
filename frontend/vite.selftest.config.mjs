import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 自检构建：把 selftest/entry.jsx 编成 Node 可执行的 SSR bundle。
 * 用法：npm --prefix frontend run selftest
 */
export default defineConfig({
  plugins: [react()],
  ssr: { noExternal: ['lucide-react', '@tanstack/react-virtual', '@tanstack/virtual-core'] },
  build: {
    ssr: 'selftest/entry.jsx',
    outDir: '.selftest',
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    rollupOptions: { output: { format: 'es', entryFileNames: 'entry.mjs' } },
  },
})
