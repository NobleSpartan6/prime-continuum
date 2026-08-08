import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflowPath = resolve('.github/workflows/cross-platform-source.yml')
const workflow = readFileSync(workflowPath, 'utf8')

describe('cross-platform source CI policy', () => {
  it('runs the exact source gates on stable Linux, Windows, and macOS hosts', () => {
    expect(workflow).toContain('ubuntu-24.04')
    expect(workflow).toContain('windows-2025')
    expect(workflow).toContain('macos-15')
    expect(workflow).toContain('node-version-file: .node-version')
    expect(workflow).toContain('version: 11.9.0')
    expect(workflow).toContain('pnpm install --frozen-lockfile --ignore-scripts')
    expect(workflow).toContain('run: pnpm typecheck')
    expect(workflow).toContain('run: pnpm test')
    expect(workflow).toContain('run: pnpm build')
  })

  it('pins every external action and grants no mutation or secret-bearing authority', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain('timeout-minutes: 20')
    expect(workflow).toContain('fail-fast: false')
    expect(workflow).not.toContain('pull_request_target')
    expect(workflow).not.toMatch(/\b(?:write-all|id-token|packages|actions):\s+write\b/)
    expect(workflow).not.toMatch(/\bsecrets\s*\./)

    const actionReferences = [...workflow.matchAll(/^\s*uses:\s+([^@\s]+)@([^\s#]+)/gm)]
    expect(actionReferences.map((match) => [match[1], match[2]])).toEqual([
      ['actions/checkout', 'd23441a48e516b6c34aea4fa41551a30e30af803'],
      ['pnpm/action-setup', '0977fd99725f1db4007ccb2928dbb4e90d06cc86'],
      ['actions/setup-node', '249970729cb0ef3589644e2896645e5dc5ba9c38'],
    ])
    expect(actionReferences.every((match) => /^[0-9a-f]{40}$/.test(match[2]!))).toBe(true)
  })
})
