import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { assertPinnedDevelopmentNodeRuntime } from './development-node-runtime.mjs'
import { acquireWorkflowLock, WorkflowLockError } from './workflow-lock-lib.mjs'
import { getWorkflowLockPath } from './workflow-lock-lib.mjs'
import {
  createDevelopmentBuildPlan,
  createDevelopmentHostBuildPlan,
  createDevelopmentWorkflowPlan,
  createPreviewWorkflowPlan,
} from './development-workflow-plan.mjs'
import {
  createMacosDmgBuilderPlan,
  createMacosPackagingBuilderPlan,
  createMacosPackagingEnvironment,
} from './macos-packaging-policy.mjs'
import { rejectActiveWorkflowChild, WorkflowChildLeaseError } from './workflow-child-lease-lib.mjs'
import { runSupervisedWorkflowStep } from './workflow-supervised-step-lib.mjs'
import { createWorkflowStepEnvironment } from './workflow-step-environment.mjs'
import {
  createWindowsPackagingBuilderPlan,
  createWindowsPackagingEnvironment,
} from './windows-packaging-policy.mjs'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const UNSIGNED_WINDOWS_ENV = createWindowsPackagingEnvironment(process.env)
const AD_HOC_MACOS_ENV = createMacosPackagingEnvironment(process.env)

function createWorkflows(releaseOptions = {}) {
  const releaseBuildSteps = [
    pnpmStep('Build the relay server', ['--filter', '@prime-agent/relay-server', 'build']),
    pnpmStep('Build the desktop application', ['exec', 'electron-vite', 'build']),
    nodeStep('Generate the runtime attestation', 'scripts/generate-runtime-attestation.mjs', [
      '--output', 'out/main/runtime-attestation.json',
      ...(releaseOptions.runtimeRoot ? ['--runtime-root', releaseOptions.runtimeRoot] : []),
      ...(releaseOptions.electron ? ['--electron', releaseOptions.electron] : []),
    ]),
    nodeStep('Build the attested host service', 'scripts/build-hostd.mjs', ['--attestation', 'out/main/runtime-attestation.json']),
  ]

  const directoryPackagingSteps = process.platform === 'darwin'
    ? [
        ...createMacosPackagingBuilderPlan({ arch: process.arch }).map(materializeMacosPackagingStep),
        nodeStep('Verify the macOS application directory', 'scripts/verify-macos-package.mjs'),
      ]
    : [
        ...createWindowsPackagingBuilderPlan({ directoryOnly: true }).map(materializeWindowsPackagingStep),
        nodeStep('Verify the Windows application package', 'scripts/verify-windows-package.mjs'),
      ]

  return {
  dev: createDevelopmentWorkflowPlan(PROJECT_ROOT).map(materializePlannedStep),
  preview: createPreviewWorkflowPlan().map(materializePlannedStep),
  build: createDevelopmentBuildPlan(PROJECT_ROOT).map(materializePlannedStep),
  'build:hostd': createDevelopmentHostBuildPlan(PROJECT_ROOT).map(materializePlannedStep),
  'build:hostd:release': [
    nodeStep('Build the attested host service', 'scripts/build-hostd.mjs', ['--attestation', 'out/main/runtime-attestation.json']),
  ],
  'build:attestation': [
    nodeStep('Generate the runtime attestation', 'scripts/generate-runtime-attestation.mjs', ['--output', 'out/main/runtime-attestation.json']),
  ],
  'build:release': releaseBuildSteps,
  'build:runtime': [nodeStep('Build the Prime Agent runtime', 'scripts/build-prime-agent-runtime.mjs')],
  'verify:renderer-visual': [
    ...releaseBuildSteps,
    nodeStep('Capture renderer visual verification', 'scripts/run-renderer-visual-capture.mjs'),
  ],
  package: [
    nodeStep('Build the Prime Agent runtime', 'scripts/build-prime-agent-runtime.mjs'),
    ...releaseBuildSteps,
    nodeStep('Verify host runtime initialization', 'scripts/verify-hostd-runtime-initialization.mjs'),
    nodeStep('Verify resident host lifecycle', 'scripts/verify-hostd-resident-lifecycle.mjs'),
    ...directoryPackagingSteps,
  ],
  dist: process.platform === 'darwin' ? [
    nodeStep('Build the Prime Agent runtime', 'scripts/build-prime-agent-runtime.mjs'),
    ...releaseBuildSteps,
    nodeStep('Verify host runtime initialization', 'scripts/verify-hostd-runtime-initialization.mjs'),
    nodeStep('Verify resident host lifecycle', 'scripts/verify-hostd-resident-lifecycle.mjs'),
    ...createMacosDmgBuilderPlan({ arch: process.arch }).map(materializeMacosPackagingStep),
    nodeStep('Verify the macOS application directory', 'scripts/verify-macos-package.mjs'),
    nodeStep('Verify and checksum the macOS DMG', 'scripts/verify-macos-dmg.mjs'),
  ] : [
    nodeStep('Build the Prime Agent runtime', 'scripts/build-prime-agent-runtime.mjs'),
    ...releaseBuildSteps,
    nodeStep('Verify host runtime initialization', 'scripts/verify-hostd-runtime-initialization.mjs'),
    nodeStep('Verify resident host lifecycle', 'scripts/verify-hostd-resident-lifecycle.mjs'),
    ...createWindowsPackagingBuilderPlan().map(materializeWindowsPackagingStep),
    nodeStep('Verify the Windows application package', 'scripts/verify-windows-package.mjs'),
    nodeStep('Verify and checksum the Windows installer', 'scripts/verify-windows-installer.mjs'),
  ],
  }
}

async function main() {
  const args = process.argv.slice(2)
  const workflow = args[0]
  const releaseOptions = parseReleaseOptions(workflow, args.slice(1))
  const workflows = createWorkflows(releaseOptions)
  if (!workflow || !Object.hasOwn(workflows, workflow)) {
    throw new Error(`Usage: node scripts/run-workflow.mjs <${Object.keys(workflows).join('|')}>`)
  }
  if (workflow === 'package' && process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error(`Prime Continuim directory packaging is not reviewed for ${process.platform}.`)
  }
  if (workflow === 'dist' && process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error(`Prime Continuim installer packaging is not reviewed for ${process.platform}.`)
  }
  assertPinnedDevelopmentNodeRuntime({ projectRoot: PROJECT_ROOT })
  const lock = await acquireWorkflowLock({ workflow, projectRoot: PROJECT_ROOT })
  try {
    // The main lock must be held before inspecting or recovering a child lease;
    // otherwise a stale reaper could rename a newly published live lease.
    await rejectActiveWorkflowChild({
      lockPath: getWorkflowLockPath(PROJECT_ROOT),
      lockToken: lock.owner.token,
      workflow,
    })
  } catch (error) {
    await lock.release()
    throw error
  }
  let released = false
  const releaseSync = () => {
    if (released) return
    released = true
    lock.releaseSync()
  }
  process.once('exit', releaseSync)

  try {
    for (const step of workflows[workflow]) await runStep(step, workflow, lock)
  } finally {
    process.removeListener('exit', releaseSync)
    if (!released) {
      released = true
      await lock.release()
    }
  }
}

function parseReleaseOptions(workflow, args) {
  if (args.length === 0) return {}
  if (workflow !== 'build:release') {
    throw new Error(`Workflow ${workflow ?? '(missing)'} does not accept additional arguments.`)
  }
  const result = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if ((name !== '--runtime-root' && name !== '--electron') || !value || /[\0\r\n]/.test(value)) {
      throw new Error('build:release accepts only --runtime-root <path> and --electron <path>.')
    }
    if (Object.hasOwn(result, name === '--runtime-root' ? 'runtimeRoot' : 'electron')) {
      throw new Error(`Duplicate build:release option: ${name}.`)
    }
    result[name === '--runtime-root' ? 'runtimeRoot' : 'electron'] = resolve(PROJECT_ROOT, value)
  }
  return result
}

function nodeStep(label, script, args = []) {
  return { label, executable: process.execPath, args: [resolve(PROJECT_ROOT, script), ...args] }
}

function materializePlannedStep(step) {
  return step.kind === 'node'
    ? nodeStep(step.label, step.script, step.args)
    : pnpmStep(step.label, step.args, {}, false, step.environmentBoundary)
}

function materializeWindowsPackagingStep(step) {
  return step.kind === 'node'
    ? nodeStep(step.label, step.script, step.args)
    : pnpmStep(step.label, step.args, UNSIGNED_WINDOWS_ENV, true)
}

function materializeMacosPackagingStep(step) {
  return step.kind === 'node'
    ? nodeStep(step.label, step.script, step.args)
    : pnpmStep(step.label, step.args, AD_HOC_MACOS_ENV, true)
}

function pnpmStep(label, args, environment = {}, replaceEnvironment = false, environmentBoundary) {
  return { label, pnpmArgs: args, environment, replaceEnvironment, environmentBoundary }
}

async function runStep(step, workflow, lock) {
  process.stdout.write(`\n[Prime Continuim] ${step.label}...\n`)
  const executable = step.executable ?? process.execPath
  const args = step.pnpmArgs ? [resolvePnpmCli(), ...step.pnpmArgs] : step.args
  const result = await runSupervisedWorkflowStep({
    workflow,
    lock,
    step: {
      executable,
      args,
      cwd: PROJECT_ROOT,
      environment: createWorkflowStepEnvironment(step),
    },
  })
  if (result.code !== 0) {
    const outcome = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`
    throw new Error(`${step.label} failed with ${outcome}.`)
  }
}

function resolvePnpmCli() {
  const pnpmCli = process.env.npm_execpath
  if (!pnpmCli || !existsSync(pnpmCli) || !basename(pnpmCli).toLowerCase().includes('pnpm')) {
    throw new Error('Prime Continuim workflows must be started through pnpm (for example, `pnpm dev` or `pnpm dist`).')
  }
  return pnpmCli
}

main().catch((error) => {
  if (error instanceof WorkflowLockError || error instanceof WorkflowChildLeaseError) console.error(error.message)
  else console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
