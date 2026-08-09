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
    // Windows hosted runners serialize substantially more filesystem/process
    // work than Linux and macOS. Keep one Windows worker so semantic 5s
    // deadlines measure the behavior under test instead of cross-file I/O
    // contention; every file still runs, and the other CI hosts retain two.
    maxWorkers: process.env.CI ? (process.platform === 'win32' ? 1 : 2) : undefined,
    reporters: ['default'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}']
    }
  }
})
