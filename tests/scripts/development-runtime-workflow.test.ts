import { resolve, relative, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
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

describe('development runtime workflow', () => {
  it('locks in the verified development-integrity startup order outside Vite output', () => {
    const projectRoot = resolve('C:/prime-continuim-workflow-fixture')
    const plan = createDevelopmentWorkflowPlan(projectRoot)

    expect(plan.map((step) => step.label)).toEqual([
      'Verify the Electron desktop runtime',
      'Verify or build the pinned Prime Agent runtime',
      'Generate the development-integrity runtime attestation',
      'Build the development-integrity host service',
      'Start the desktop development server',
    ])
    expect(plan.map((step) => step.kind)).toEqual(['node', 'node', 'node', 'node', 'pnpm'])

    const runtimeRoot = resolve(projectRoot, 'out', 'runtime')
    const attestationPath = resolve(
      projectRoot,
      'node_modules',
      '.cache',
      'prime-continuim',
      'development-runtime-attestation.json',
    )
    expect(plan[1]).toMatchObject({
      script: 'scripts/ensure-prime-agent-runtime.mjs',
      args: ['--runtime-root', runtimeRoot],
    })
    expect(plan[2]).toMatchObject({
      script: 'scripts/generate-runtime-attestation.mjs',
      args: ['--runtime-root', runtimeRoot, '--output', attestationPath],
    })
    expect(plan[3]).toMatchObject({
      script: 'scripts/build-hostd.mjs',
      args: ['--attestation', attestationPath],
    })
    expect(plan[4]).toMatchObject({
      args: ['exec', 'electron-vite', 'dev'],
      environmentBoundary: DESKTOP_LAUNCH_ENVIRONMENT_BOUNDARY,
    })
    const relationToViteOutput = relative(resolve(projectRoot, 'out', 'main'), attestationPath)
    expect(relationToViteOutput === '..' || relationToViteOutput.startsWith(`..${sep}`)).toBe(true)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(plan.every(Object.isFrozen)).toBe(true)

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
