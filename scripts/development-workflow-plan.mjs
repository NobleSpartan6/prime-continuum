import { resolve } from 'node:path'
import { DESKTOP_LAUNCH_ENVIRONMENT_BOUNDARY } from './workflow-step-environment.mjs'

export function createDevelopmentWorkflowPlan(projectRoot) {
  return Object.freeze([
    ...createDevelopmentHostBuildPlan(projectRoot),
    pnpmStep(
      'Start the desktop development server',
      ['exec', 'electron-vite', 'dev'],
      DESKTOP_LAUNCH_ENVIRONMENT_BOUNDARY,
    ),
  ])
}

export function createDevelopmentBuildPlan(projectRoot) {
  return Object.freeze([
    pnpmStep('Build the relay server', ['--filter', '@prime-agent/relay-server', 'build']),
    pnpmStep('Build the desktop application', ['exec', 'electron-vite', 'build']),
    ...createDevelopmentHostBuildPlan(projectRoot),
  ])
}

export function createDevelopmentHostBuildPlan(projectRoot) {
  const root = resolve(projectRoot)
  const runtimeRoot = resolve(root, 'out', 'runtime')
  // electron-vite owns and cleans out/main during development. Keep the
  // development-only attestation in the dependency cache so it survives that
  // cleanup and cannot leak into Electron Builder's out/**/* application files.
  const attestationPath = resolve(
    root,
    'node_modules',
    '.cache',
    'prime-continuim',
    'development-runtime-attestation.json',
  )
  const checkpointPath = resolve(
    root,
    'node_modules',
    '.cache',
    'prime-continuim',
    'development-runtime-checkpoint.json',
  )

  return Object.freeze([
    nodeStep('Verify the Electron desktop runtime', 'scripts/ensure-electron-runtime.mjs'),
    nodeStep(
      'Prepare the development Prime Agent runtime',
      'scripts/prepare-development-runtime.mjs',
      [
        '--runtime-root', runtimeRoot,
        '--attestation', attestationPath,
        '--cache', checkpointPath,
      ],
    ),
    nodeStep(
      'Build the development-integrity host service',
      'scripts/build-hostd.mjs',
      ['--attestation', attestationPath],
    ),
  ])
}

export function createPreviewWorkflowPlan() {
  return Object.freeze([
    nodeStep('Verify the Electron desktop runtime', 'scripts/ensure-electron-runtime.mjs'),
    pnpmStep(
      'Start the packaged-output preview',
      ['exec', 'electron-vite', 'preview'],
      DESKTOP_LAUNCH_ENVIRONMENT_BOUNDARY,
    ),
  ])
}

function nodeStep(label, script, args = []) {
  return Object.freeze({
    kind: 'node',
    label,
    script,
    args: Object.freeze([...args]),
  })
}

function pnpmStep(label, args, environmentBoundary) {
  return Object.freeze({
    kind: 'pnpm',
    label,
    args: Object.freeze([...args]),
    ...(environmentBoundary ? { environmentBoundary } : {}),
  })
}
