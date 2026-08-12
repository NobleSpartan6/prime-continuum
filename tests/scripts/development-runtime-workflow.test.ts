import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createDevelopmentBuildPlan,
  createDevelopmentHostBuildPlan,
  createDevelopmentWorkflowPlan,
  createPreviewWorkflowPlan,
} from '../../scripts/development-workflow-plan.mjs'
import {
  createDesktopLaunchEnvironment,
  createWorkflowStepEnvironment,
  DESKTOP_LAUNCH_ENVIRONMENT_BOUNDARY,
} from '../../scripts/workflow-step-environment.mjs'
import {
  ensurePrimeAgentRuntime,
  PrimeAgentRuntimeSetupError,
  type RuntimeCommand,
  type RuntimeCommandResult,
} from '../../scripts/ensure-prime-agent-runtime.mjs'
import {
  createRuntimeNamespaceCheckpoint,
  prepareDevelopmentRuntime,
  type DevelopmentRuntimeState,
} from '../../scripts/prepare-development-runtime.mjs'

describe('development runtime workflow', () => {
  it('locks in the verified development-integrity startup order outside Vite output', () => {
    const projectRoot = resolve('C:/prime-continuim-workflow-fixture')
    const plan = createDevelopmentWorkflowPlan(projectRoot)

    expect(plan.map((step) => step.label)).toEqual([
      'Verify the Electron desktop runtime',
      'Prepare the development Prime Agent runtime',
      'Build the development-integrity host service',
      'Start the desktop development server',
    ])
    expect(plan.map((step) => step.kind)).toEqual(['node', 'node', 'node', 'pnpm'])

    const runtimeRoot = resolve(projectRoot, 'out', 'runtime')
    const attestationPath = resolve(
      projectRoot,
      'node_modules',
      '.cache',
      'prime-continuim',
      'development-runtime-attestation.json',
    )
    const checkpointPath = resolve(
      projectRoot,
      'node_modules',
      '.cache',
      'prime-continuim',
      'development-runtime-checkpoint.json',
    )
    expect(plan[1]).toMatchObject({
      script: 'scripts/prepare-development-runtime.mjs',
      args: [
        '--runtime-root', runtimeRoot,
        '--attestation', attestationPath,
        '--cache', checkpointPath,
      ],
    })
    expect(plan[2]).toMatchObject({
      script: 'scripts/build-hostd.mjs',
      args: ['--attestation', attestationPath],
    })
    expect(plan[3]).toMatchObject({
      args: ['exec', 'electron-vite', 'dev'],
      environmentBoundary: DESKTOP_LAUNCH_ENVIRONMENT_BOUNDARY,
    })
    const relationToViteOutput = relative(resolve(projectRoot, 'out', 'main'), attestationPath)
    expect(relationToViteOutput === '..' || relationToViteOutput.startsWith(`..${sep}`)).toBe(true)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(plan.every(Object.isFrozen)).toBe(true)

    const hostBuildPlan = createDevelopmentHostBuildPlan(projectRoot)
    expect(hostBuildPlan).toEqual(plan.slice(0, 3))
    expect(hostBuildPlan.at(-1)).toMatchObject({
      script: 'scripts/build-hostd.mjs',
      args: ['--attestation', attestationPath],
    })
    expect(Object.isFrozen(hostBuildPlan)).toBe(true)

    const buildPlan = createDevelopmentBuildPlan(projectRoot)
    expect(buildPlan.map((step) => step.label)).toEqual([
      'Build the relay server',
      'Build the desktop application',
      'Verify the Electron desktop runtime',
      'Prepare the development Prime Agent runtime',
      'Build the development-integrity host service',
    ])
    expect(buildPlan.slice(2)).toEqual(hostBuildPlan)
    expect(buildPlan.at(-1)).toMatchObject({
      script: 'scripts/build-hostd.mjs',
      args: ['--attestation', attestationPath],
    })
    expect(Object.isFrozen(buildPlan)).toBe(true)

    const previewPlan = createPreviewWorkflowPlan()
    expect(previewPlan.map((step) => step.label)).toEqual([
      'Verify the Electron desktop runtime',
      'Start the packaged-output preview',
    ])
    expect(previewPlan[1]).toMatchObject({
      kind: 'pnpm',
      args: ['exec', 'electron-vite', 'preview'],
      environmentBoundary: DESKTOP_LAUNCH_ENVIRONMENT_BOUNDARY,
    })
  })

  it('reuses a matching development checkpoint without invoking exact preparation again', async () => {
    const state = developmentRuntimeState()
    const ensure = vi.fn()
    const attest = vi.fn()
    const writeAtomic = vi.fn()
    const messages: string[] = []

    const result = await prepareDevelopmentRuntime({
      projectRoot: resolve('C:/prime-runtime-project'),
      runtimeRoot: resolve('C:/prime-runtime-project/out/runtime'),
      attestationPath: resolve('C:/prime-runtime-project/cache/attestation.json'),
      cachePath: resolve('C:/prime-runtime-project/cache/checkpoint.json'),
      electronExecutable: process.execPath,
      log: (message) => messages.push(message),
      dependencies: {
        readCheckpoint: vi.fn().mockResolvedValue({ schemaVersion: 1, ...state }),
        inspect: vi.fn().mockResolvedValue(state),
        ensure,
        attest,
        writeAtomic,
      },
    })

    expect(result).toMatchObject({ cached: true, rebuilt: false })
    expect(ensure).not.toHaveBeenCalled()
    expect(attest).not.toHaveBeenCalled()
    expect(writeAtomic).not.toHaveBeenCalled()
    expect(messages.at(-1)).toContain('authoritative runtime hashing remains gated inside the host service')
  })

  it('uses one exact attestation pass on a checkpoint miss and publishes the checkpoint last', async () => {
    const state = developmentRuntimeState()
    const ensure = vi.fn()
    const attest = vi.fn().mockResolvedValue({ assurance: 'development-integrity' })
    const serialize = vi.fn().mockReturnValue(Buffer.from('attestation'))
    const writeAtomic = vi.fn().mockResolvedValue(undefined)
    const attestationPath = resolve('C:/prime-runtime-project/cache/attestation.json')
    const cachePath = resolve('C:/prime-runtime-project/cache/checkpoint.json')

    const result = await prepareDevelopmentRuntime({
      projectRoot: resolve('C:/prime-runtime-project'),
      runtimeRoot: resolve('C:/prime-runtime-project/out/runtime'),
      attestationPath,
      cachePath,
      electronExecutable: process.execPath,
      log: () => undefined,
      dependencies: {
        readCheckpoint: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue(state),
        ensure,
        attest,
        serialize,
        writeAtomic,
      },
    })

    expect(result).toMatchObject({ cached: false, rebuilt: false })
    expect(attest).toHaveBeenCalledTimes(1)
    expect(ensure).not.toHaveBeenCalled()
    expect(writeAtomic).toHaveBeenNthCalledWith(1, attestationPath, Buffer.from('attestation'))
    expect(writeAtomic).toHaveBeenNthCalledWith(2, cachePath, expect.any(Buffer))
    expect(JSON.parse(String(writeAtomic.mock.calls[1]?.[1]))).toEqual({ schemaVersion: 1, ...state })
  })

  it('rebuilds through the exact runtime setup only when cold attestation fails', async () => {
    const state = developmentRuntimeState()
    const ensure = vi.fn().mockResolvedValue({ rebuilt: true })
    const attest = vi.fn()
      .mockRejectedValueOnce(new Error('runtime tree mismatch'))
      .mockResolvedValueOnce({ assurance: 'development-integrity' })

    const result = await prepareDevelopmentRuntime({
      projectRoot: resolve('C:/prime-runtime-project'),
      runtimeRoot: resolve('C:/prime-runtime-project/out/runtime'),
      attestationPath: resolve('C:/prime-runtime-project/cache/attestation.json'),
      cachePath: resolve('C:/prime-runtime-project/cache/checkpoint.json'),
      electronExecutable: process.execPath,
      log: () => undefined,
      dependencies: {
        readCheckpoint: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue(state),
        ensure,
        attest,
        serialize: vi.fn().mockReturnValue(Buffer.from('attestation')),
        writeAtomic: vi.fn().mockResolvedValue(undefined),
      },
    })

    expect(result).toMatchObject({ cached: false, rebuilt: true })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(attest).toHaveBeenCalledTimes(2)
  })

  it('invalidates the namespace checkpoint on same-size content or namespace changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'prime-continuim-dev-checkpoint-'))
    try {
      await mkdir(join(directory, 'node_modules', 'prime-agent'), { recursive: true })
      const payload = join(directory, 'node_modules', 'prime-agent', 'index.js')
      await writeFile(payload, 'alpha')
      const initial = await createRuntimeNamespaceCheckpoint(directory)

      await writeFile(payload, 'bravo')
      const changedContent = await createRuntimeNamespaceCheckpoint(directory)
      expect(changedContent.entryCount).toBe(initial.entryCount)
      expect(changedContent.metadataSha256).not.toBe(initial.metadataSha256)

      await writeFile(join(directory, 'node_modules', 'prime-agent', 'extra.js'), 'extra')
      const changedNamespace = await createRuntimeNamespaceCheckpoint(directory)
      expect(changedNamespace.entryCount).toBe(initial.entryCount + 1)
      expect(changedNamespace.metadataSha256).not.toBe(changedContent.metadataSha256)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('removes inherited RunAsNode only at the desktop-launch boundary', () => {
    const projectRoot = resolve('C:/prime-continuim-workflow-fixture')
    const desktopLaunch = createDevelopmentWorkflowPlan(projectRoot).at(-1)
    expect(desktopLaunch).toBeDefined()
    const inherited = {
      Path: 'C:\\Windows\\System32',
      eLeCtRoN_rUn_As_NoDe: '1',
      PRIME_CONTINUIM_PACKAGE_SMOKE: '1',
      PRIME_AGENT_DATA_DIR: 'C:\\Prime\\hostd',
      ELECTRON_RENDERER_URL: 'http://localhost:5173/',
    }

    const sanitized = createDesktopLaunchEnvironment(inherited)
    const plannedEnvironment = createWorkflowStepEnvironment(desktopLaunch!, inherited)

    expect(sanitized).toEqual({
      Path: inherited.Path,
      PRIME_CONTINUIM_PACKAGE_SMOKE: '1',
      PRIME_AGENT_DATA_DIR: inherited.PRIME_AGENT_DATA_DIR,
      ELECTRON_RENDERER_URL: inherited.ELECTRON_RENDERER_URL,
    })
    expect(plannedEnvironment).toEqual(sanitized)
    expect(Object.keys(plannedEnvironment).some((name) => name.toUpperCase() === 'ELECTRON_RUN_AS_NODE')).toBe(false)

    const ordinaryStepEnvironment = createWorkflowStepEnvironment(
      { environment: { ELECTRON_RUN_AS_NODE: '1' } },
      { PRIME_CONTINUIM_PACKAGE_SMOKE: '1' },
    )
    expect(ordinaryStepEnvironment).toEqual({
      PRIME_CONTINUIM_PACKAGE_SMOKE: '1',
      ELECTRON_RUN_AS_NODE: '1',
    })
  })

  it('accepts an existing runtime only after the exact verifier succeeds', async () => {
    const commands: RuntimeCommand[] = []
    const messages: string[] = []

    const result = await ensurePrimeAgentRuntime({
      projectRoot: resolve('C:/prime-runtime-project'),
      runtimeRoot: resolve('C:/prime-runtime-project/out/runtime'),
      runCommand: async (command) => {
        commands.push(command)
        return success()
      },
      log: (message) => messages.push(message),
    })

    expect(result.rebuilt).toBe(false)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      args: [expect.stringMatching(/verify-prime-agent-runtime\.mjs$/), '--output', result.runtimeRoot],
      inheritOutput: false,
    })
    expect(messages.at(-1)).toBe('Pinned Prime Agent runtime verified.')
  })

  it('builds a missing or invalid runtime and requires exact post-build verification', async () => {
    const projectRoot = resolve('C:/prime-runtime-project')
    const runtimeRoot = resolve(projectRoot, 'out', 'runtime')
    const commands: RuntimeCommand[] = []
    const messages: string[] = []
    const outcomes = [failure(1), success(), success()]

    const result = await ensurePrimeAgentRuntime({
      projectRoot,
      runtimeRoot,
      runCommand: async (command) => {
        commands.push(command)
        return outcomes.shift() ?? failure(99)
      },
      log: (message) => messages.push(message),
    })

    expect(result.rebuilt).toBe(true)
    expect(commands.map((command) => command.args[0])).toEqual([
      resolve(projectRoot, 'scripts/verify-prime-agent-runtime.mjs'),
      resolve(projectRoot, 'scripts/build-prime-agent-runtime.mjs'),
      resolve(projectRoot, 'scripts/verify-prime-agent-runtime.mjs'),
    ])
    expect(commands[1]).toMatchObject({ args: [expect.any(String), '--output', runtimeRoot], inheritOutput: true })
    expect(commands[2]).toEqual(commands[0])
    expect(messages).toContain('Build finished. Re-running the exact runtime verifier...')
    expect(messages.at(-1)).toBe('Pinned Prime Agent runtime rebuilt and verified.')
  })

  it('never proceeds from a failed build or failed post-build verification', async () => {
    const projectRoot = resolve('C:/prime-runtime-project')
    const runtimeRoot = resolve(projectRoot, 'out', 'runtime')

    await expect(
      ensurePrimeAgentRuntime({
        projectRoot,
        runtimeRoot,
        runCommand: vi.fn()
          .mockResolvedValueOnce(failure(1))
          .mockResolvedValueOnce(failure(23, 'pinned input download failed')),
        log: () => undefined,
      }),
    ).rejects.toEqual(expect.objectContaining<PrimeAgentRuntimeSetupError>({
      name: 'PrimeAgentRuntimeSetupError',
      message: expect.stringContaining('build failed (exit code 23)'),
    }))

    await expect(
      ensurePrimeAgentRuntime({
        projectRoot,
        runtimeRoot,
        runCommand: vi.fn()
          .mockResolvedValueOnce(failure(1))
          .mockResolvedValueOnce(success())
          .mockResolvedValueOnce(failure(24, 'whole-tree digest mismatch')),
        log: () => undefined,
      }),
    ).rejects.toThrow('did not pass exact manifest and whole-tree verification (exit code 24)')
  })
})

function success(): RuntimeCommandResult {
  return { status: 0, signal: null, stdout: '{}', stderr: '' }
}

function failure(status: number, stderr = 'verification failed'): RuntimeCommandResult {
  return { status, signal: null, stdout: '', stderr }
}

function developmentRuntimeState(): DevelopmentRuntimeState {
  return {
    pointerSha256: '1'.repeat(64),
    manifestSha256: '2'.repeat(64),
    fileManifestSha256: '3'.repeat(64),
    attestationSha256: '4'.repeat(64),
    namespaceMetadataSha256: '5'.repeat(64),
    namespaceEntryCount: 9_627,
  }
}
