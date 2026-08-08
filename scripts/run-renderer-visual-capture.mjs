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
  ['desktop-idle', 1600, 1000, 'idle', undefined],
  ['desktop-prompt-admission', 1200, 800, 'prompt-admission', undefined],
  ['desktop-prompt-proof-390', 390, 844, 'prompt-awaiting-idle-proof', undefined],
  ['desktop-stop-proof-390', 390, 844, 'stop-awaiting-idle-proof', undefined],
  ['desktop-uncertain-320', 320, 704, 'nonretryable-uncertainty', undefined],
  ['desktop-end-pending-390', 390, 844, 'resident-end-pending', undefined],
  ['resident-start-1600', 1600, 1000, 'resident-start', undefined],
  ['resident-dialog-390', 390, 844, 'resident-start', undefined],
  ['resident-dialog-short-320', 320, 256, 'resident-start', undefined],
  ['resident-end-dialog-390', 390, 844, 'resident-end-review', undefined],
  ['resident-end-dialog-short-320', 320, 256, 'resident-end-review', undefined],
  ['resident-recovery-320', 320, 704, 'resident-recovery', undefined],
  ['resident-recovery-short-320', 320, 256, 'resident-recovery', undefined],
  ['hud-expanded', 620, 380, 'hud-expanded', 'hud'],
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
]

// Electron's RunAsNode mode is required by the packaged hostd launcher, but a
// developer shell can retain it after a runtime smoke. Visual capture must use
// the real Electron main process regardless of that ambient state.
delete environment.ELECTRON_RUN_AS_NODE

await Promise.all([
  rm(resultPath, { force: true }),
  rm(errorPath, { force: true }),
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
    (name.startsWith('desktop-') && name !== 'desktop-idle' && result.stateEvidence?.composerStatusVisible !== true) ||
    ((name === 'resident-dialog-390' || name === 'resident-dialog-short-320') && result.stateEvidence?.residentDialogOpen !== true) ||
    (name === 'resident-dialog-short-320' && result.stateEvidence?.residentDialogContentReachable !== true) ||
    ((name === 'resident-end-dialog-390' || name === 'resident-end-dialog-short-320') && result.stateEvidence?.residentEndDialogOpen !== true) ||
    (name === 'resident-end-dialog-short-320' && result.stateEvidence?.residentEndDialogContentReachable !== true) ||
    (name === 'resident-recovery-short-320' && result.stateEvidence?.emptyMainScrollable !== true)
    || (name.startsWith('hud-') && (
      result.stateEvidence?.hudSurfaceVisible !== true ||
      result.stateEvidence?.hudStatusVisible !== true ||
      result.stateEvidence?.hudHostTransparent !== true ||
      result.stateEvidence?.hudMode !== name.slice('hud-'.length)
    ))
  ) {
    throw new Error(`Renderer visual capture returned invalid evidence for ${name}`)
  }
  process.stdout.write(
    `${result.name}: ${result.width}x${result.height} · no horizontal overflow · ${result.outputPath}\n`,
  )
}
if (exitCode !== 0) process.exitCode = exitCode
