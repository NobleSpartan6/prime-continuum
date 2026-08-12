import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { rendererStartupBudgetPlugin } from './renderer-startup-budget'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react(), rendererStartupBudgetPlugin()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
})
