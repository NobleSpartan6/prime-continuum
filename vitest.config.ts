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
    // Hosted runners expose enough logical CPUs to start many heavyweight
    // process/filesystem suites concurrently, but not enough sustained I/O to
    // keep their 5s semantic deadlines meaningful. Every file still runs;
    // CI merely uses a deterministic two-worker ceiling.
    maxWorkers: process.env.CI ? 2 : undefined,
    reporters: ['default'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}']
    }
  }
})
