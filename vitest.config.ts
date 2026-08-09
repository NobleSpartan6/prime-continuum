import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const hostedWindows = Boolean(process.env.CI) && process.platform === 'win32'
const githubActions = process.env.GITHUB_ACTIONS === 'true'
const windowsUiaCompileTest = 'tests/scripts/codex-subscription-provider-e2e-uia-windows.test.ts'
const runWindowsUiaCompileTest = process.env.PRIME_CONTINUIM_WINDOWS_UIA_COMPILE === 'true'

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
    // The real Windows UI Automation compiler probe is run in its own bounded
    // workflow step. Only the broad hosted-Windows suite omits that exact file;
    // local Windows and every non-Windows source suite retain normal discovery.
    ...(hostedWindows && !runWindowsUiaCompileTest ? { exclude: [windowsUiaCompileTest] } : {}),
    // Windows hosted runners serialize substantially more filesystem/process
    // work than Linux and macOS. Keep one Windows worker and give only that CI
    // harness a larger outer watchdog; behavior-specific deadlines remain
    // explicit in their tests and production code. Other CI hosts retain two.
    maxWorkers: process.env.CI ? (process.platform === 'win32' ? 1 : 2) : undefined,
    testTimeout: hostedWindows ? 60_000 : 5_000,
    // Keep the readable console report while also publishing exact failing-test
    // annotations. Public workflow logs are otherwise reduced to a generic
    // process exit for unauthenticated reviewers.
    reporters: githubActions ? ['default', 'github-actions'] : ['default'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}']
    }
  }
})
