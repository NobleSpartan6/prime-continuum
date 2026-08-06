import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
    reporters: ['default'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}']
    }
  }
})
