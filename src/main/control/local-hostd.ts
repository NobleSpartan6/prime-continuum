import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import type { App } from 'electron'
import {
  resolveCanonicalLocalHostTarget,
  type CanonicalLocalHostTarget
} from '../../shared/local-host-target'
import { LOCAL_HOSTD_DESKTOP_START_DEADLINE_MS } from '../../shared/local-host-startup-policy.mjs'
import { ControlError } from './errors'
import { FramedConnection } from './framed-connection'
import { buildSshConnectArgs, classifySshFailure } from './ssh'

const LOCAL_CONNECT_TIMEOUT_MS = 750
const PACKAGE_SMOKE_SHUTDOWN_TIMEOUT_MS = 60_000
const PACKAGE_SMOKE_WRAPPER_IDENTITY = 'prime-continuim-package-smoke-wrapper'
const packageSmokeHostdChildren = new Set<ChildProcess>()
const localHostdStarts = new Map<string, Promise<void>>()

export interface BundledHostdPaths {
  readonly hostdScript: string
  readonly runtimeSeed: string
}

export function bundledHostdPaths(
  app: Pick<App, 'isPackaged' | 'getAppPath'>,
  resourcesPath = process.resourcesPath
): BundledHostdPaths {
  const applicationRoot = app.isPackaged ? path.resolve(resourcesPath) : path.resolve(app.getAppPath())
  return Object.freeze({
    hostdScript: app.isPackaged
      ? path.join(applicationRoot, 'hostd', 'hostd.cjs')
      : path.join(applicationRoot, 'out', 'hostd', 'hostd.cjs'),
    runtimeSeed: app.isPackaged
      ? path.join(applicationRoot, 'runtime-seed')
      : path.join(applicationRoot, 'out', 'runtime')
  })
}

export function bundledHostdServeArguments(
  paths: BundledHostdPaths,
  endpoint: string,
  dataDirectory: string
): readonly string[] {
  return Object.freeze([
    paths.hostdScript,
    'serve',
    '--socket',
    endpoint,
    '--data-dir',
    dataDirectory,
    '--runtime-seed',
    paths.runtimeSeed
  ])
}

export function bundledHostdLaunchArguments(
  paths: BundledHostdPaths,
  endpoint: string,
  dataDirectory: string,
  packageSmoke: boolean
): readonly string[] {
  const serveArguments = bundledHostdServeArguments(paths, endpoint, dataDirectory)
  return packageSmoke
    ? Object.freeze([
        '-e',
        packageSmokeHostdWrapperSource(),
        PACKAGE_SMOKE_WRAPPER_IDENTITY,
        ...serveArguments
      ])
    : serveArguments
}

export function bundledHostdEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment }
  for (const name of Object.keys(childEnvironment)) {
    const normalized = name.toUpperCase()
    if (normalized === 'NODE_OPTIONS' || normalized === 'NODE_PATH' || normalized === 'ELECTRON_RUN_AS_NODE') {
      delete childEnvironment[name]
    }
  }
  childEnvironment.ELECTRON_RUN_AS_NODE = '1'
  return childEnvironment
}

export function hostdDataDirectory(): string {
  if (process.env.PRIME_AGENT_DATA_DIR) return path.resolve(process.env.PRIME_AGENT_DATA_DIR)
  if (process.platform === 'win32') {
    return path.resolve(
      process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'),
      'PrimeAgent',
      'hostd'
    )
  }
  if (process.platform === 'darwin') {
    return path.resolve(homedir(), 'Library', 'Application Support', 'PrimeAgent', 'hostd')
  }
  return path.resolve(
    process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'),
    'prime-agent',
    'hostd'
  )
}

export async function localHostdTarget(
  dataDirectory = hostdDataDirectory(),
  options: { create?: boolean } = {}
): Promise<CanonicalLocalHostTarget> {
  return await resolveCanonicalLocalHostTarget(dataDirectory, options)
}

export async function localHostdEndpoint(
  dataDirectory = hostdDataDirectory(),
  options: { create?: boolean } = {}
): Promise<string> {
  return (await localHostdTarget(dataDirectory, options)).endpoint
}

export async function connectLocalHostd(endpoint: string): Promise<FramedConnection> {
  const socket = await openSocket(endpoint, LOCAL_CONNECT_TIMEOUT_MS)
  return connectionFromSocket(socket, endpoint)
}

export async function ensureAndConnectLocalHostd(app: App): Promise<FramedConnection> {
  // Main is authorized to start the local service, so it creates only the root
  // before deriving a pipe from its physical path. Hostd independently proves
  // the same canonical target before touching durable state.
  const target = await localHostdTarget(hostdDataDirectory(), { create: true })
  const { dataDirectory, endpoint } = target
  try {
    return await connectLocalHostd(endpoint)
  } catch {
    await startBundledHostdOnce(app, endpoint, dataDirectory)
  }
  return await connectLocalHostd(endpoint)
}

async function startBundledHostdOnce(app: App, endpoint: string, dataDirectory: string): Promise<void> {
  const existing = localHostdStarts.get(endpoint)
  if (existing) return await existing
  const started = (async () => {
    await startBundledHostd(app, endpoint, dataDirectory)
    const deadline = Date.now() + LOCAL_HOSTD_DESKTOP_START_DEADLINE_MS
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const probe = await connectLocalHostd(endpoint)
        probe.close()
        return
      } catch (error) {
        lastError = error
        await delay(125)
      }
    }
    throw new ControlError('hostd.start_timeout', 'The local host service did not become ready.', {
      retryable: true,
      details: { endpoint },
      cause: lastError
    })
  })()
  localHostdStarts.set(endpoint, started)
  try {
    await started
  } finally {
    if (localHostdStarts.get(endpoint) === started) localHostdStarts.delete(endpoint)
  }
}

export async function startBundledHostd(
  app: App,
  endpoint: string,
  dataDirectory: string
): Promise<void> {
  const target = await localHostdTarget(dataDirectory, { create: true })
  if (!sameLocalEndpoint(endpoint, target.endpoint)) {
    throw new ControlError(
      'hostd.endpoint_mismatch',
      'The local host service endpoint does not match its physical data directory.'
    )
  }
  const paths = bundledHostdPaths(app)
  try {
    await access(paths.hostdScript)
  } catch (cause) {
    throw new ControlError('hostd.bundle_missing', 'The bundled local host service is unavailable.', {
      details: { hostdScript: paths.hostdScript },
      cause
    })
  }
  const packageSmoke = process.env.PRIME_CONTINUIM_PACKAGE_SMOKE === '1'
  const launchArguments = bundledHostdLaunchArguments(
    paths,
    target.endpoint,
    target.dataDirectory,
    packageSmoke
  )
  const child = spawn(
    process.execPath,
    launchArguments,
    {
      detached: !packageSmoke,
      shell: false,
      windowsHide: true,
      stdio: packageSmoke ? ['pipe', 'ignore', 'inherit'] : 'ignore',
      env: bundledHostdEnvironment()
    }
  )
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', (cause) =>
      reject(
        new ControlError('hostd.spawn_failed', 'The bundled local host service could not be started.', {
          retryable: true,
          details: { hostdScript: paths.hostdScript },
          cause
        })
      )
    )
  })
  if (packageSmoke) {
    packageSmokeHostdChildren.add(child)
    child.once('exit', () => packageSmokeHostdChildren.delete(child))
  } else {
    child.unref()
  }
}

function sameLocalEndpoint(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export async function stopPackageSmokeHostds(): Promise<void> {
  const children = [...packageSmokeHostdChildren]
  await Promise.all(children.map(async (child) => await stopPackageSmokeHostd(child)))
}

async function stopPackageSmokeHostd(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
    throw new Error('The package-smoke host daemon has no writable shutdown control pipe.')
  }
  child.stdin.once('error', () => undefined)
  child.stdin.end('shutdown\n')
  let timer: NodeJS.Timeout | undefined
  try {
    const outcome = await Promise.race([
      exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('The package-smoke host daemon did not stop within its deadline.')),
          PACKAGE_SMOKE_SHUTDOWN_TIMEOUT_MS
        )
      })
    ])
    if (outcome.code !== 0 || outcome.signal !== null) {
      throw new Error(
        `The package-smoke host daemon exited uncleanly (code=${String(outcome.code)}, signal=${String(outcome.signal)}).`
      )
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function packageSmokeHostdWrapperSource(): string {
  return [
    '"use strict";',
    'const [wrapperIdentity, hostdPath, ...hostdArguments] = process.argv.slice(1);',
    `if (wrapperIdentity !== ${JSON.stringify(PACKAGE_SMOKE_WRAPPER_IDENTITY)}) throw new Error("invalid hostd smoke wrapper identity");`,
    'if (!hostdPath) throw new Error("missing hostd smoke path");',
    'const hostd = require(hostdPath);',
    'process.stdin.setEncoding("utf8");',
    'let terminal = false;',
    'const terminate = () => { if (terminal) return; terminal = true; process.emit("SIGTERM"); };',
    'process.stdin.once("data", terminate);',
    'process.stdin.once("end", terminate);',
    'process.stdin.once("close", terminate);',
    'process.stdin.resume();',
    'void Promise.resolve(hostd.runHostdCli(hostdArguments)).then(',
    '  (code) => { terminal = true; process.exitCode = code; process.stdin.destroy(); },',
    '  (error) => { terminal = true; process.stderr.write(`Package-smoke hostd failed: ${error instanceof Error ? error.message : String(error)}\\n`); process.exitCode = 1; process.stdin.destroy(); },',
    ');'
  ].join('\n')
}

export function connectSshHost(alias: string, sshExecutable = 'ssh'): FramedConnection {
  const child = spawn(sshExecutable, buildSshConnectArgs(alias), {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C' }
  }) as ChildProcessWithoutNullStreams

  // Always drain stderr so OpenSSH cannot block. The bounded tail is retained
  // only for a future native askpass/diagnostics adapter and never sent as an event.
  let stderrTail = Buffer.alloc(0)
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-32 * 1024)
  })

  const connection = new FramedConnection({
    readable: child.stdout,
    writable: child.stdin,
    close: () => child.kill(),
    label: `ssh:${alias}`,
    endError: () => classifySshFailure(undefined, alias, stderrTail.toString('utf8'))
  })
  child.once('error', (cause) => {
    connection.terminate(
      new ControlError('ssh.client_unavailable', 'The system OpenSSH client is unavailable.', {
        details: { alias },
        cause
      })
    )
  })
  child.once('exit', () => {
    if (!connection.isClosed) connection.close()
    stderrTail = Buffer.alloc(0)
  })
  return connection
}

function connectionFromSocket(socket: Socket, endpoint: string): FramedConnection {
  return new FramedConnection({
    readable: socket,
    writable: socket,
    close: () => socket.destroy(),
    label: `local:${endpoint}`
  })
}

async function openSocket(endpoint: string, timeoutMs: number): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new ControlError('hostd.connect_timeout', 'The local host service did not answer.', { retryable: true }))
    }, timeoutMs)
    timer.unref?.()

    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('error', onError)
      resolve(socket)
    })
    const onError = (cause: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(new ControlError('hostd.connect_failed', 'The local host service is unavailable.', { retryable: true, cause }))
    }
    socket.once('error', onError)
  })
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}
