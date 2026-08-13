import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ControlError } from '../../src/main/control/errors'
import {
  bundledHostdEnvironment,
  bundledHostdInvocation,
  bundledHostdLaunchArguments,
  bundledHostdPaths,
  bundledHostdServeArguments,
  coordinateLocalHostdReadiness,
  replaceVerifiedLocalHostd,
  requireCompatibleLocalHostd,
  retireVerifiedLocalHostd,
  verifyBundledHostExecutables
} from '../../src/main/control/local-hostd'

describe('bundled hostd launch contract', () => {
  const buildIdentity = Object.freeze({
    contractVersion: 1 as const,
    bundleSha256: 'a'.repeat(64),
    runtimeTrustAnchorId: 'b'.repeat(64)
  })
  const health = (
    hostdBuildIdentity?: typeof buildIdentity,
    capabilities: string[] = []
  ) => ({
    protocolVersion: 1 as const,
    hostdVersion: '0.1.0',
    ...(hostdBuildIdentity ? { hostdBuildIdentity } : {}),
    startedAt: '2026-08-13T00:00:00.000Z',
    checkedAt: '2026-08-13T00:00:01.000Z',
    serviceState: 'ready' as const,
    host: {
      hostId: 'host-local',
      displayName: 'Local Mac',
      kind: 'local' as const,
      connectionPaths: [],
      reachability: 'online' as const,
      compatibility: 'compatible' as const,
      platform: { os: 'macos' as const, architecture: 'arm64' as const },
      attentionCounts: { total: 0, unread: 0, questions: 0, approvals: 0 }
    },
    capabilities
  })

  it('accepts only the exact current hostd bundle and runtime trust anchor', async () => {
    let closed = false
    const connection = {
      request: async <T = unknown>() => health(buildIdentity) as unknown as T,
      close: () => { closed = true }
    }
    await expect(requireCompatibleLocalHostd(connection, buildIdentity)).resolves.toBe(connection)
    expect(closed).toBe(false)
  })

  it('preserves a legacy hostd and fails closed instead of launching over it', async () => {
    let closed = false
    const connection = {
      request: async <T = unknown>() => health() as unknown as T,
      close: () => { closed = true }
    }
    await expect(requireCompatibleLocalHostd(connection, buildIdentity)).rejects.toMatchObject({
      code: 'hostd.legacy_restart_required',
      retryable: false
    })
    expect(closed).toBe(true)
  })

  it('retires an exact quiescent predecessor and starts the current build only after endpoint absence', async () => {
    const observedIdentity = { ...buildIdentity, bundleSha256: 'c'.repeat(64) }
    const predecessorHealth = health(observedIdentity, ['hostd_graceful_retire_v1'])
    const order: string[] = []
    const connection = {
      request: async <T = unknown>(method: string, payload: unknown): Promise<T> => {
        expect(method).toBe('host.retire')
        expect(payload).toEqual({
          expectedHostId: predecessorHealth.host.hostId,
          expectedBuildIdentity: observedIdentity
        })
        order.push('retire')
        return {
          retirementVersion: 1,
          state: 'accepted',
          expectedHostId: predecessorHealth.host.hostId,
          hostdBuildIdentity: observedIdentity
        } as T
      },
      close: vi.fn()
    }

    await replaceVerifiedLocalHostd({
      connection,
      health: predecessorHealth,
      observedIdentity,
      expectedIdentity: buildIdentity,
      waitForEndpointAbsence: async () => {
        order.push('absent')
        return true
      },
      startCurrent: async () => { order.push('start') }
    })

    expect(order).toEqual(['retire', 'absent', 'start'])
    expect(connection.close).toHaveBeenCalledOnce()
  })

  it('does not reinterpret an exact identity-drift rejection as retirement', async () => {
    const observedIdentity = { ...buildIdentity, bundleSha256: 'c'.repeat(64) }
    const predecessorHealth = health(observedIdentity, ['hostd_graceful_retire_v1'])
    const waitForEndpointAbsence = vi.fn(async () => true)
    const connection = {
      request: async <T = unknown>(): Promise<T> => {
        throw new ControlError('host.host_retire_identity_mismatch', 'identity drifted')
      },
      close: vi.fn()
    }

    await expect(retireVerifiedLocalHostd({
      connection,
      health: predecessorHealth,
      observedIdentity,
      expectedIdentity: buildIdentity,
      waitForEndpointAbsence
    })).rejects.toMatchObject({ code: 'host.host_retire_identity_mismatch' })
    expect(waitForEndpointAbsence).not.toHaveBeenCalled()
    expect(connection.close).toHaveBeenCalledOnce()
  })

  it('accepts a dropped retirement response only after endpoint absence is proven', async () => {
    const observedIdentity = { ...buildIdentity, bundleSha256: 'c'.repeat(64) }
    const predecessorHealth = health(observedIdentity, ['hostd_graceful_retire_v1'])
    const dropped = () => ({
      request: async <T = unknown>(): Promise<T> => {
        throw new ControlError('transport.ended', 'response dropped', { retryable: true })
      },
      close: vi.fn()
    })

    await expect(retireVerifiedLocalHostd({
      connection: dropped(),
      health: predecessorHealth,
      observedIdentity,
      expectedIdentity: buildIdentity,
      waitForEndpointAbsence: async () => true
    })).resolves.toBeUndefined()

    const startCurrent = vi.fn(async () => undefined)
    await expect(replaceVerifiedLocalHostd({
      connection: dropped(),
      health: predecessorHealth,
      observedIdentity,
      expectedIdentity: buildIdentity,
      waitForEndpointAbsence: async () => false,
      startCurrent
    })).rejects.toMatchObject({ code: 'hostd.retirement_unconfirmed' })
    expect(startCurrent).not.toHaveBeenCalled()
  })

  it('coalesces concurrent retirement/startup work for one endpoint', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const operation = vi.fn(async () => { await gate })
    const first = coordinateLocalHostdReadiness('test-endpoint', operation)
    const second = coordinateLocalHostdReadiness('test-endpoint', operation)
    expect(operation).toHaveBeenCalledOnce()
    release()
    await Promise.all([first, second])
  })

  it('rejects a different verified build without retiring its sessions', async () => {
    let closed = false
    const connection = {
      request: async <T = unknown>() => health({ ...buildIdentity, bundleSha256: 'c'.repeat(64) }) as unknown as T,
      close: () => { closed = true }
    }
    await expect(requireCompatibleLocalHostd(connection, buildIdentity)).rejects.toMatchObject({
      code: 'hostd.build_identity_mismatch',
      retryable: false
    })
    expect(closed).toBe(true)
  })

  it('binds a packaged hostd to the exact packaged runtime seed', () => {
    const resources = path.resolve('C:/PrimeContinuim/resources')
    const paths = bundledHostdPaths(
      { isPackaged: true, getAppPath: () => path.resolve('C:/ignored') },
      resources,
      'win32'
    )

    expect(paths).toEqual({
      attestation: path.join(path.resolve('C:/ignored'), 'out', 'main', 'runtime-attestation.json'),
      browserExecutable: path.join(resources, 'browser-runtime', 'electron.exe'),
      hostExecutable: path.join(resources, 'host-runtime', 'node.exe'),
      hostdScript: path.join(resources, 'hostd', 'hostd.cjs'),
      runtimeSeed: path.join(resources, 'runtime-seed')
    })
    expect(
      bundledHostdServeArguments(paths, '\\\\.\\pipe\\prime-test', path.resolve('C:/PrimeContinuim/data'))
    ).toEqual([
      paths.hostdScript,
      'serve',
      '--socket',
      '\\\\.\\pipe\\prime-test',
      '--data-dir',
      path.resolve('C:/PrimeContinuim/data'),
      '--runtime-seed',
      paths.runtimeSeed,
      '--browser-executable',
      paths.browserExecutable
    ])
  })

  it('uses the build output as the development seed without probing it', () => {
    const applicationRoot = path.resolve('C:/PrimeContinuim/source')
    expect(
      bundledHostdPaths(
        { isPackaged: false, getAppPath: () => applicationRoot },
        path.resolve('C:/ignored/resources'),
        'win32'
      )
    ).toEqual({
      attestation: path.join(applicationRoot, 'node_modules', '.cache', 'prime-continuim', 'development-runtime-attestation.json'),
      browserExecutable: process.execPath,
      hostExecutable: path.join(applicationRoot, 'node_modules', 'node', 'node.exe'),
      hostdScript: path.join(applicationRoot, 'out', 'hostd', 'hostd.cjs'),
      runtimeSeed: path.join(applicationRoot, 'out', 'runtime')
    })
  })

  it('keeps the imported hostd path out of argv[1] during the package smoke', () => {
    const resources = path.resolve('C:/PrimeContinuim/resources')
    const paths = bundledHostdPaths(
      { isPackaged: true, getAppPath: () => path.resolve('C:/ignored') },
      resources,
      'win32'
    )
    const endpoint = '\\\\.\\pipe\\prime-test'
    const dataDirectory = path.resolve('C:/PrimeContinuim/data')
    const serveArguments = bundledHostdServeArguments(paths, endpoint, dataDirectory)
    const launchArguments = bundledHostdLaunchArguments(paths, endpoint, dataDirectory, true)

    expect(launchArguments[0]).toBe('-e')
    expect(launchArguments[1]).toContain(
      'const [wrapperIdentity, hostdPath, ...hostdArguments] = process.argv.slice(1);'
    )
    expect(launchArguments[1]).toContain('invalid hostd smoke wrapper identity')
    expect(launchArguments[2]).toBe('prime-continuim-package-smoke-wrapper')
    expect(path.basename(launchArguments[2] ?? '')).not.toBe('hostd.cjs')
    expect(launchArguments.slice(3)).toEqual(serveArguments)
    expect(bundledHostdLaunchArguments(paths, endpoint, dataDirectory, false)).toEqual(serveArguments)
    expect(bundledHostdInvocation(paths, endpoint, dataDirectory, false)).toEqual({
      executable: path.join(resources, 'host-runtime', 'node.exe'),
      args: serveArguments
    })
  })

  it('terminates the package-smoke host when parent stdin ends without data', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prime-package-smoke-wrapper-'))
    try {
      const hostdPath = path.join(root, 'hostd.cjs')
      await writeFile(
        hostdPath,
        `exports.runHostdCli = () => new Promise((resolve) => {
  process.stdout.write('READY\\n')
  process.once('SIGTERM', () => { process.stdout.write('STOPPED\\n'); resolve(0) })
})
`,
        'utf8'
      )
      const paths = { attestation: path.join(root, 'attestation.json'), browserExecutable: process.execPath, hostExecutable: process.execPath, hostdScript: hostdPath, runtimeSeed: path.join(root, 'runtime') }
      const launch = bundledHostdLaunchArguments(paths, 'endpoint', root, true)
      const child = spawn(process.execPath, launch, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let stdout = ''
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
        if (stdout.includes('READY')) child.stdin.end()
      })
      const result = await new Promise<{ code: number | null; stderr: string }>((resolvePromise, rejectPromise) => {
        let stderr = ''
        child.stderr.on('data', (chunk) => { stderr += String(chunk) })
        child.once('error', rejectPromise)
        child.once('exit', (code) => resolvePromise({ code, stderr }))
      })
      expect(result).toEqual({ code: 0, stderr: '' })
      expect(stdout).toContain('STOPPED')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes parent-process Node injection while preserving ordinary environment values', () => {
    expect(
      bundledHostdEnvironment({
        Path: 'C:\\Windows',
        PRIME_API_KEY: 'provider-key',
        NODE_OPTIONS: '--require attacker.js',
        node_path: 'C:\\untrusted',
        electron_run_as_node: '0'
      })
    ).toEqual({
      Path: 'C:\\Windows',
      PRIME_API_KEY: 'provider-key'
    })
  })

  it('fails closed when either separately attested executable drifts or aliases the other', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prime-host-executable-'))
    try {
      const hostExecutable = path.join(root, 'node')
      const browserExecutable = path.join(root, 'electron')
      const attestationPath = path.join(root, 'attestation.json')
      await Promise.all([
        writeFile(hostExecutable, 'standalone-node'),
        writeFile(browserExecutable, 'browser-electron'),
      ])
      const digest = (value: string) => createHash('sha256').update(value).digest('hex')
      await writeFile(attestationPath, JSON.stringify({
        guiRuntime: { kind: 'electron', electronVersion: '43.3.0', nodeVersion: '24.18.1', modulesAbi: '148', napiVersion: '10', platform: process.platform, arch: process.arch, executableSha256: digest('browser-electron') },
        hostRuntime: { kind: 'node', nodeVersion: '24.14.0', modulesAbi: '137', napiVersion: '10', platform: process.platform, arch: process.arch, executableSha256: digest('standalone-node') },
      }))
      const paths = { attestation: attestationPath, browserExecutable, hostExecutable, hostdScript: path.join(root, 'hostd.cjs'), runtimeSeed: path.join(root, 'runtime') }
      await expect(verifyBundledHostExecutables(paths)).resolves.toBeUndefined()
      await writeFile(hostExecutable, 'drifted-node')
      await expect(verifyBundledHostExecutables(paths)).rejects.toThrow('does not match')
      await expect(verifyBundledHostExecutables({ ...paths, hostExecutable: browserExecutable })).rejects.toThrow('must be distinct')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
