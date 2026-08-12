import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { vitestWorkerLimit } from '../../vitest.config'

const workflowPath = resolve('.github/workflows/cross-platform-source.yml')
const workflow = readFileSync(workflowPath, 'utf8').replace(/\r\n?/g, '\n')
const vitestConfig = readFileSync(resolve('vitest.config.ts'), 'utf8').replace(/\r\n?/g, '\n')
const rootPackage = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const selfBuildSource = readFileSync(resolve('scripts/self-build-lib.mjs'), 'utf8').replace(/\r\n?/g, '\n')
const workflowRunnerSource = readFileSync(resolve('scripts/run-workflow.mjs'), 'utf8').replace(/\r\n?/g, '\n')
const developmentWorkflowPlanSource = readFileSync(resolve('scripts/development-workflow-plan.mjs'), 'utf8').replace(/\r\n?/g, '\n')

describe('cross-platform source CI policy', () => {
  it('runs the exact source gates on stable Linux, Windows, and macOS hosts', () => {
    expect(workflow).toContain('ubuntu-24.04')
    expect(workflow).toContain('windows-2025')
    expect(workflow).toContain('macos-15')
    expect(workflow).toContain('timeout-minutes: ${{ matrix.timeout_minutes }}')
    expect(workflow).toMatch(/label: Windows x64\n\s+os: windows-2025\n\s+timeout_minutes: 30/)
    expect(workflow.match(/timeout_minutes: 20/g)).toHaveLength(2)
    expect(workflow).toContain('node-version-file: .node-version')
    expect(workflow).toContain('version: 11.9.0')
    expect(workflow).toContain('pnpm install --frozen-lockfile --ignore-scripts')
    expect(workflow).toContain('run: pnpm typecheck')
    expect(workflow).toContain('run: pnpm test')
    expect(workflow).toContain('run: pnpm build')
    expect(workflow).toContain('Typecheck Node, renderer, and relay boundaries')
    expect(workflow).toContain('Run the complete root and relay source test suite')
    expect(workflow).toContain('Build the desktop, host-service, and relay source')
  })

  it('composes the relay package exactly once into each canonical root source gate', () => {
    expect(rootPackage.scripts.typecheck).toBe(
      'tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.web.json --noEmit && pnpm --filter @prime-agent/relay-server typecheck',
    )
    expect(rootPackage.scripts.test).toBe('vitest run && pnpm --filter @prime-agent/relay-server test')
    expect(rootPackage.scripts.build).toBe('node scripts/run-workflow.mjs build')
    expect(rootPackage.scripts['build:release']).toBe('node scripts/run-workflow.mjs build:release')

    for (const scriptName of ['typecheck', 'test']) {
      expect(rootPackage.scripts[scriptName]!.match(/@prime-agent\/relay-server/g)).toHaveLength(1)
    }
    expect(workflow).not.toContain('@prime-agent/relay-server')

    const relayBuildStep = "pnpmStep('Build the relay server', ['--filter', '@prime-agent/relay-server', 'build'])"
    const rootBuildSources = `${workflowRunnerSource}\n${developmentWorkflowPlanSource}`
    expect(rootBuildSources.match(new RegExp(relayBuildStep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2)
    expect(workflowRunnerSource).toMatch(/const releaseBuildSteps = \[\n\s+pnpmStep\('Build the relay server'/)
    expect(workflowRunnerSource).toContain('build: createDevelopmentBuildPlan(PROJECT_ROOT).map(materializePlannedStep)')
    expect(workflowRunnerSource).toContain("'build:hostd': createDevelopmentHostBuildPlan(PROJECT_ROOT).map(materializePlannedStep)")
    expect(workflowRunnerSource).toMatch(
      /'build:hostd:release': \[\n\s+nodeStep\('Build the attested host service', 'scripts\/build-hostd\.mjs', \['--attestation', 'out\/main\/runtime-attestation\.json'\]\),\n\s+\]/,
    )
    expect(developmentWorkflowPlanSource).toMatch(/createDevelopmentBuildPlan[\s\S]+pnpmStep\('Build the relay server'/)
  })

  it('keeps self-build on the same relay-inclusive canonical root gates', () => {
    expect(selfBuildSource).toContain("pnpm('Typecheck the candidate', ['run', 'typecheck'])")
    expect(selfBuildSource).toContain("pnpm('Run the candidate test suite', ['run', 'test'])")
    expect(selfBuildSource).toContain("'run', 'build:release',")
  })

  it('keeps the live AppContainer probe absent from unattended source workflows', () => {
    expect(rootPackage.scripts['verify:windows-appcontainer-probe:receipt']).toBe(
      'node scripts/verify-windows-appcontainer-probe.mjs',
    )
    expect(workflow).not.toContain('windows-appcontainer-probe')
    expect(selfBuildSource).not.toContain('windows-appcontainer-probe')
    expect(workflowRunnerSource).not.toContain('windows-appcontainer-probe')
    const rootScripts = Object.values(rootPackage.scripts).join('\n')
    expect(rootScripts).not.toContain('windows-appcontainer-probe.ps1')
    expect(rootScripts).not.toContain('windows-appcontainer-probe-payload-protocol')
    expect(rootScripts).not.toContain('--live')
    expect(rootScripts).not.toContain('CreateAppContainerProfile')
  })

  it('pins every external action and grants no mutation or secret-bearing authority', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).toContain('timeout-minutes: ${{ matrix.timeout_minutes }}')
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

  it('runs every portable test with deterministic local and hosted concurrency and watchdog bounds', () => {
    expect(workflow).toContain('run: pnpm test')
    expect(vitestConfig).toContain("include: ['tests/**/*.test.{ts,tsx}']")
    expect(vitestConfig).toContain("const hostedWindows = Boolean(process.env.CI) && process.platform === 'win32'")
    expect(vitestConfig).toContain("const githubActions = process.env.GITHUB_ACTIONS === 'true'")
    expect(vitestConfig).toContain('maxWorkers: vitestWorkerLimit()')
    expect(vitestConfig).toContain('testTimeout: hostedWindows ? 60_000 : 5_000')
    expect(vitestConfig).toContain("reporters: githubActions ? ['default', 'github-actions'] : ['default']")
    expect([...vitestConfig.matchAll(/\btestTimeout\s*:/g)]).toHaveLength(1)
    expect(vitestConfig).not.toMatch(/\b(?:shard|passWithNoTests)\s*:/)

    expect(vitestWorkerLimit({}, 'win32')).toBe(2)
    expect(vitestWorkerLimit({}, 'darwin')).toBe(2)
    expect(vitestWorkerLimit({ CI: '1' }, 'win32')).toBe(1)
    expect(vitestWorkerLimit({ CI: '1' }, 'darwin')).toBe(2)
    expect(vitestWorkerLimit({ CI: '1' }, 'linux')).toBe(2)
  })

})
