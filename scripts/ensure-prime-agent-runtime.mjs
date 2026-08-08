import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const MAXIMUM_CAPTURED_OUTPUT_BYTES = 256 * 1024

export class PrimeAgentRuntimeSetupError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'PrimeAgentRuntimeSetupError'
  }
}

export async function ensurePrimeAgentRuntime({
  projectRoot = PROJECT_ROOT,
  runtimeRoot = resolve(projectRoot, 'out', 'runtime'),
  runCommand = runRuntimeCommand,
  log = (message) => console.log(message),
} = {}) {
  const absoluteProjectRoot = resolve(projectRoot)
  const absoluteRuntimeRoot = resolve(runtimeRoot)
  if (!isAbsolute(absoluteProjectRoot) || !isAbsolute(absoluteRuntimeRoot)) {
    throw new PrimeAgentRuntimeSetupError('Development runtime paths must be absolute.')
  }

  const verifyCommand = command(
    absoluteProjectRoot,
    'scripts/verify-prime-agent-runtime.mjs',
    ['--output', absoluteRuntimeRoot],
    false,
  )
  log('Checking the pinned Prime Agent runtime with the exact manifest and whole-tree verifier...')
  const initialVerification = await runCommand(verifyCommand)
  if (commandSucceeded(initialVerification)) {
    log('Pinned Prime Agent runtime verified.')
    return Object.freeze({ rebuilt: false, runtimeRoot: absoluteRuntimeRoot })
  }

  const runtimeExists = await lstat(absoluteRuntimeRoot).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false
    throw error
  })
  log(
    runtimeExists
      ? 'The existing runtime failed exact verification. Rebuilding it from pinned, digest-checked inputs...'
      : 'The pinned runtime is not built yet. Building it from digest-checked inputs; the first run can take a few minutes...',
  )

  const buildResult = await runCommand(
    command(
      absoluteProjectRoot,
      'scripts/build-prime-agent-runtime.mjs',
      ['--output', absoluteRuntimeRoot],
      true,
    ),
  )
  if (!commandSucceeded(buildResult)) {
    throw commandFailure('The pinned Prime Agent runtime build failed', buildResult)
  }

  log('Build finished. Re-running the exact runtime verifier...')
  const finalVerification = await runCommand(verifyCommand)
  if (!commandSucceeded(finalVerification)) {
    throw commandFailure(
      'The rebuilt Prime Agent runtime did not pass exact manifest and whole-tree verification',
      finalVerification,
    )
  }

  log('Pinned Prime Agent runtime rebuilt and verified.')
  return Object.freeze({ rebuilt: true, runtimeRoot: absoluteRuntimeRoot })
}

export function runRuntimeCommand({ executable, args, cwd, inheritOutput }) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: inheritOutput ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let capturedBytes = 0
    const capture = (target, chunk) => {
      const text = Buffer.from(chunk).toString('utf8')
      capturedBytes += Buffer.byteLength(text)
      if (capturedBytes > MAXIMUM_CAPTURED_OUTPUT_BYTES) {
        child.kill()
        return target
      }
      return target + text
    }
    child.stdout?.on('data', (chunk) => {
      stdout = capture(stdout, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = capture(stderr, chunk)
    })
    child.once('error', (cause) => {
      rejectCommand(
        new PrimeAgentRuntimeSetupError(`Could not start the runtime setup command: ${cause.message}`, { cause }),
      )
    })
    child.once('exit', (status, signal) => {
      resolveCommand({
        status,
        signal,
        stdout,
        stderr,
        outputLimitExceeded: capturedBytes > MAXIMUM_CAPTURED_OUTPUT_BYTES,
      })
    })
  })
}

function command(projectRoot, relativeScript, args, inheritOutput) {
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([resolve(projectRoot, relativeScript), ...args]),
    cwd: projectRoot,
    inheritOutput,
  })
}

function commandSucceeded(result) {
  return result?.status === 0 && result.outputLimitExceeded !== true
}

function commandFailure(label, result) {
  const outcome = result?.outputLimitExceeded
    ? 'captured output exceeded its safety limit'
    : result?.signal
      ? `signal ${result.signal}`
      : `exit code ${result?.status ?? 'unknown'}`
  const diagnostic = boundedLastLine(result?.stderr)
  return new PrimeAgentRuntimeSetupError(`${label} (${outcome})${diagnostic ? `: ${diagnostic}` : '.'}`)
}

function boundedLastLine(value) {
  if (typeof value !== 'string') return ''
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 500) ?? ''
}

async function runCli() {
  const runtimeRoot = parseArguments(process.argv.slice(2))
  try {
    await ensurePrimeAgentRuntime({ runtimeRoot })
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

function parseArguments(args) {
  if (args.length === 0) return resolve(PROJECT_ROOT, 'out', 'runtime')
  if (args.length !== 2 || args[0] !== '--runtime-root' || !args[1] || args[1].startsWith('--')) {
    throw new PrimeAgentRuntimeSetupError(
      'Usage: node scripts/ensure-prime-agent-runtime.mjs [--runtime-root <absolute-or-repository-relative-path>]',
    )
  }
  return resolve(args[1])
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli()
}
