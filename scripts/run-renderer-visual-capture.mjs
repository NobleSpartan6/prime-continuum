import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const captureScript = join(scriptDirectory, 'capture-renderer-preview.cjs')
const outputDirectory = join(scriptDirectory, '..', 'out', 'visual-qa')
const resultPath = join(outputDirectory, 'capture-result.json')
const errorPath = join(outputDirectory, 'capture-error.txt')
const environment = { ...process.env }
const expectedTargets = [
  ['desktop-agent-launchpad', 1600, 1000, 'launchpad', undefined],
  ['mobile-agent-launchpad-390', 390, 844, 'launchpad', undefined],
  ['desktop-idle', 1600, 1000, 'idle', undefined],
  ['desktop-investigation', 1600, 1000, 'idle', undefined],
  ['desktop-rlm-activity', 1200, 800, 'rlm-activity', undefined],
  ['mobile-idle-390', 390, 844, 'idle', undefined],
  ['compact-idle-320', 320, 704, 'idle', undefined],
  ['mobile-inspector-390', 390, 844, 'idle', undefined],
  ['model-selection-dialog-390', 390, 844, 'model-selection', undefined],
  ['model-selection-dialog-short-320', 320, 256, 'model-selection', undefined],
  ['prime-oauth-dialog-390', 390, 844, 'prime-oauth', undefined],
  ['prime-oauth-dialog-short-320', 320, 256, 'prime-oauth', undefined],
  ['desktop-prompt-admission', 1200, 800, 'prompt-admission', undefined],
  ['desktop-prompt-proof-390', 390, 844, 'prompt-awaiting-idle-proof', undefined],
  ['desktop-stop-proof-390', 390, 844, 'stop-awaiting-idle-proof', undefined],
  ['desktop-uncertain-320', 320, 704, 'nonretryable-uncertainty', undefined],
  ['desktop-end-pending-390', 390, 844, 'resident-end-pending', undefined],
  ['resident-start-1600', 1600, 1000, 'resident-start', undefined],
  ['ssh-registered-workspace-dialog-390', 390, 844, 'ssh-registered-workspace', undefined],
  ['ssh-registered-workspace-dialog-short-320', 320, 256, 'ssh-registered-workspace', undefined],
  ['resident-dialog-390', 390, 844, 'resident-start', undefined],
  ['resident-dialog-short-320', 320, 256, 'resident-start', undefined],
  ['resident-recovery-320', 320, 704, 'resident-recovery', undefined],
  ['resident-recovery-short-320', 320, 256, 'resident-recovery', undefined],
  ['candidate-evaluation-dialog-390', 390, 844, 'candidate-evaluation-review', undefined],
  ['candidate-evaluation-dialog-short-320', 320, 256, 'candidate-evaluation-review', undefined],
  ['hud-expanded', 620, 380, 'hud-expanded', 'hud'],
  ['hud-expanded-320', 320, 240, 'hud-expanded', 'hud'],
  ['hud-buddy', 184, 64, 'hud-buddy', 'hud'],
]
const obsoleteCaptures = [
  'desktop.png',
  'desktop-390.png',
  'desktop-320.png',
  'companion-390.png',
  'companion-320.png',
  'companion-attention-390.png',
  'companion-attention-320.png',
  'codex-signed-out-390.png',
  'codex-signed-out-short-320.png',
  'codex-ready-390.png',
  'codex-ready-short-320.png',
  'resident-end-dialog-390.png',
  'resident-end-dialog-short-320.png',
]

// Hostd owns a separate pinned Node executable, but a developer shell can
// still retain RunAsNode after a browser smoke. Visual capture must use the
// real Electron main process regardless of that ambient state.
delete environment.ELECTRON_RUN_AS_NODE

await Promise.all([
  rm(resultPath, { force: true }),
  rm(errorPath, { force: true }),
  ...expectedTargets.map(([name]) => rm(join(outputDirectory, `${name}.png`), { force: true })),
  ...obsoleteCaptures.map((name) => rm(join(outputDirectory, name), { force: true })),
])

const child = spawn(electronPath, [captureScript], {
  env: environment,
  stdio: 'inherit',
  windowsHide: true,
})

const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (signal) reject(new Error(`Renderer visual capture exited from signal ${signal}`))
    else resolve(code ?? 1)
  })
})

let captureError
try {
  captureError = await readFile(errorPath, 'utf8')
} catch {}
if (captureError) throw new Error(`Renderer visual capture failed:\n${captureError.trim()}`)

let results
try {
  results = JSON.parse(await readFile(resultPath, 'utf8'))
} catch (error) {
  throw new Error(`Renderer visual capture did not produce a result manifest (Electron exit ${exitCode}): ${error instanceof Error ? error.message : String(error)}`)
}
if (!Array.isArray(results) || results.length !== expectedTargets.length) {
  throw new Error('Renderer visual capture returned an incomplete target set')
}
for (const [name, width, height, visualState, surface] of expectedTargets) {
  const result = results.find((candidate) => candidate?.name === name)
  if (
    !result ||
    result.width !== width ||
    result.height !== height ||
    result.visualState !== visualState ||
    result.surface !== surface ||
    result.stateEvidence?.expectedTextPresent !== true ||
    (name.startsWith('desktop-') && name !== 'desktop-idle' && name !== 'desktop-end-pending-390' && result.stateEvidence?.composerStatusVisible !== true) ||
    (name === 'desktop-end-pending-390' && result.stateEvidence?.composerStatusVisible !== false) ||
    ((name === 'resident-dialog-390' || name === 'resident-dialog-short-320') && result.stateEvidence?.residentDialogOpen !== true) ||
    (name === 'resident-dialog-short-320' && result.stateEvidence?.residentDialogContentReachable !== true) ||
    (name.startsWith('ssh-registered-workspace-dialog-') && (
      result.stateEvidence?.residentDialogOpen !== true ||
      result.stateEvidence?.residentDialogModal !== true ||
      result.stateEvidence?.registeredResidentDialogExactCopy !== true ||
      result.stateEvidence?.registeredResidentForbiddenCopyPresent !== false ||
      result.stateEvidence?.residentFixedProjectText !== 'Prime Continuim' ||
      result.stateEvidence?.residentFixedProjectVisible !== true ||
      result.stateEvidence?.residentThreadInputCount !== 1 ||
      result.stateEvidence?.residentThreadTitleOnlyInput !== true ||
      result.stateEvidence?.residentThreadTitleVisible !== true ||
      result.stateEvidence?.residentProvisionActionText !== 'Start agent' ||
      result.stateEvidence?.residentProvisionActionEnabled !== true ||
      result.stateEvidence?.residentProvisionActionVisible !== true ||
      result.stateEvidence?.residentProvisionUnsubmitted !== true ||
      result.stateEvidence?.residentDialogContentReachable !== true ||
      result.stateEvidence?.residentDialogScrollBounded !== true ||
      result.stateEvidence?.residentDialogOuterScrollTop !== 0 ||
      result.stateEvidence?.residentDialogFormScrollTop !== 0 ||
      result.stateEvidence?.residentBackgroundCatalogLocked !== true ||
      result.stateEvidence?.residentBackgroundWorkbenchLocked !== true ||
      result.stateEvidence?.registeredWorkspaceTriggerEvidence?.actionVisible !== true ||
      result.stateEvidence?.registeredWorkspaceTriggerEvidence?.actionEnabled !== true ||
      result.stateEvidence?.registeredWorkspaceTriggerEvidence?.actionText !== 'New agent' ||
      result.stateEvidence?.registeredWorkspaceTriggerEvidence?.helperText !== 'Uses this saved workspace.' ||
      result.stateEvidence?.registeredWorkspaceTriggerEvidence?.forbiddenActionCopyPresent !== false ||
      result.stateEvidence?.registeredWorkspaceTriggerEvidence?.sidebarBounded !== true ||
      result.stateEvidence?.registeredWorkspaceTriggerEvidence?.catalogBounded !== true ||
      result.stateEvidence?.registeredWorkspaceTriggerEvidence?.workbenchBounded !== true
    )) ||
    (name === 'ssh-registered-workspace-dialog-short-320' && (
      !(result.stateEvidence?.residentDialogScrollHeight > result.stateEvidence?.residentDialogScrollClientHeight) ||
      !(result.stateEvidence?.registeredWorkspaceTriggerEvidence?.catalogScrollHeight >
        result.stateEvidence?.registeredWorkspaceTriggerEvidence?.catalogClientHeight)
    )) ||
    ((name === 'candidate-evaluation-dialog-390' || name === 'candidate-evaluation-dialog-short-320') && result.stateEvidence?.candidateEvaluationDialogOpen !== true) ||
    (name === 'candidate-evaluation-dialog-short-320' && result.stateEvidence?.candidateEvaluationDialogContentReachable !== true) ||
    ((name.startsWith('model-selection-dialog-') || name.startsWith('prime-oauth-dialog-')) && (
      result.stateEvidence?.modelsDialogOpen !== true ||
      result.stateEvidence?.modelSelectionActionEnabled !== true ||
      result.stateEvidence?.modelSelectionActionVisible !== true ||
      result.stateEvidence?.modelSelectionUnchanged !== true
    )) ||
    ((name === 'model-selection-dialog-short-320' || name === 'prime-oauth-dialog-short-320') && (
      result.stateEvidence?.modelCatalogScrollable !== true ||
      result.stateEvidence?.modelsDialogScrollTop !== 0 ||
      result.stateEvidence?.modelsSurfaceScrollTop !== 0
    )) ||
    (name === 'resident-recovery-short-320' && result.stateEvidence?.emptyMainScrollable !== true)
    || ((name === 'mobile-agent-launchpad-390' || name === 'mobile-idle-390' || name === 'compact-idle-320' || name === 'mobile-inspector-390') &&
      result.stateEvidence?.responsiveTopbarBounded !== true)
    || ((name === 'mobile-idle-390' || name === 'compact-idle-320') &&
      result.stateEvidence?.horizontalTaskStarters !== true)
    || (name === 'mobile-inspector-390' && result.stateEvidence?.responsiveDrawerBounded !== true)
    || (name.startsWith('hud-') && (
      result.stateEvidence?.hudSurfaceVisible !== true ||
      result.stateEvidence?.hudStatusVisible !== true ||
      result.stateEvidence?.hudHostTransparent !== true ||
      result.stateEvidence?.hudMode !== (visualState === 'hud-buddy' ? 'buddy' : 'expanded')
    ))
  ) {
    throw new Error(`Renderer visual capture returned invalid evidence for ${name}`)
  }
  process.stdout.write(
    `${result.name}: ${result.width}x${result.height} · no horizontal overflow · ${result.outputPath}\n`,
  )
}
if (exitCode !== 0) process.exitCode = exitCode
