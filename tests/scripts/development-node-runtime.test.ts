import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPinnedDevelopmentNodeRuntime,
  DevelopmentNodeRuntimeError,
  readPinnedDevelopmentNodeVersion,
  readPinnedDevelopmentPnpmVersion,
} from '../../scripts/development-node-runtime.mjs'

const projectRoot = resolve(import.meta.dirname, '..', '..')

describe('development Node.js runtime policy', () => {
  it('keeps pnpm runtime management, .node-version, and the lockfile on one exact checksummed version', () => {
    const pinnedVersion = readPinnedDevelopmentNodeVersion(projectRoot)
    const pinnedPnpmVersion = readPinnedDevelopmentPnpmVersion(projectRoot)
    const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'))
    expect(manifest.packageManager).toBe(`pnpm@${pinnedPnpmVersion}`)
    expect(Number.parseInt(pinnedPnpmVersion, 10)).toBeGreaterThanOrEqual(11)
    expect(manifest.devEngines?.runtime).toEqual({
      name: 'node',
      version: pinnedVersion,
      onFail: 'download',
    })

    const workspaceConfig = readFileSync(resolve(projectRoot, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspaceConfig).toMatch(/^runtimeOnFail: download\s*$/m)

    const lockfile = readFileSync(resolve(projectRoot, 'pnpm-lock.yaml'), 'utf8')
    const escapedVersion = pinnedVersion.replaceAll('.', '\\.')
    expect(lockfile).toMatch(
      new RegExp(`node:\\r?\\n\\s+specifier: runtime:${escapedVersion}\\r?\\n\\s+version: runtime:${escapedVersion}`),
    )
    const runtimeBlock = lockfile.match(
      new RegExp(`  node@runtime:${escapedVersion}:[\\s\\S]+?(?=\\r?\\nsnapshots:)`),
    )?.[0]
    expect(runtimeBlock).toBeDefined()
    expect(runtimeBlock).toContain(`version: ${pinnedVersion}`)
    expect(runtimeBlock).toContain('hasBin: true')
    expect(runtimeBlock).toContain(`node-v${pinnedVersion}-win-x64.zip`)
    const urls = runtimeBlock?.match(/^\s+url: /gm) ?? []
    const integrities = runtimeBlock?.match(/^\s+integrity: sha256-/gm) ?? []
    expect(urls.length).toBeGreaterThan(0)
    expect(integrities).toHaveLength(urls.length)
  })

  it('accepts only the exact pinned runtime', () => {
    const pinnedVersion = readPinnedDevelopmentNodeVersion(projectRoot)
    expect(assertPinnedDevelopmentNodeRuntime({
      projectRoot,
      actualVersion: `v${pinnedVersion}`,
      execPath: 'C:\\managed-node\\node.exe',
    })).toBe(pinnedVersion)
  })

  it('fails before workflow work with exact recovery guidance when runtime management is bypassed', () => {
    expect(() => assertPinnedDevelopmentNodeRuntime({
      projectRoot,
      actualVersion: 'v22.5.1',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
    })).toThrowError(expect.objectContaining<DevelopmentNodeRuntimeError>({
      name: 'DevelopmentNodeRuntimeError',
      message: expect.stringContaining(
        'Run `pnpm install` with the repo-pinned pnpm v11.9.0 so pnpm can download the pinned runtime',
      ),
    }))

    try {
      assertPinnedDevelopmentNodeRuntime({
        projectRoot,
        actualVersion: 'v22.5.1',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
      })
    } catch (error) {
      expect(error).toBeInstanceOf(DevelopmentNodeRuntimeError)
      expect((error as Error).message).toContain('No workflow lock or build was started.')
    }
  })

  it('runs the exact runtime assertion before acquiring the workflow lock', () => {
    const source = readFileSync(resolve(projectRoot, 'scripts', 'run-workflow.mjs'), 'utf8')
    const mainStart = source.indexOf('async function main()')
    const runtimeAssertion = source.indexOf(
      'assertPinnedDevelopmentNodeRuntime({ projectRoot: PROJECT_ROOT })',
      mainStart,
    )
    const lockAcquisition = source.indexOf('await acquireWorkflowLock(', mainStart)
    expect(mainStart).toBeGreaterThanOrEqual(0)
    expect(runtimeAssertion).toBeGreaterThan(mainStart)
    expect(lockAcquisition).toBeGreaterThan(runtimeAssertion)
  })
})
