import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const hostedWindows = Boolean(process.env.CI) && process.platform === 'win32'

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
    // work than Linux and macOS. Keep one Windows worker and give only that CI
    // harness a larger outer watchdog; behavior-specific deadlines remain
    // explicit in their tests and production code. Other CI hosts retain two.
    maxWorkers: process.env.CI ? (process.platform === 'win32' ? 1 : 2) : undefined,
    testTimeout: hostedWindows ? 20_000 : 5_000,
    reporters: ['default'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}']
    }
  }
})
