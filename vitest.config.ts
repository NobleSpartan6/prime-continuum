import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const hostedWindows = Boolean(process.env.CI) && process.platform === 'win32'
const githubActions = process.env.GITHUB_ACTIONS === 'true'

export function vitestWorkerLimit(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform
): number {
  return Boolean(environment.CI) && platform === 'win32' ? 1 : 2
}

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
    // Keep local runs bounded as well. High-core developer machines otherwise
    // oversubscribe the filesystem-heavy host/runtime suites and produce
    // timeout/cleanup failures that disappear under the CI worker policy.
    maxWorkers: vitestWorkerLimit(),
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
