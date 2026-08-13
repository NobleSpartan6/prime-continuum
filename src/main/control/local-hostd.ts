import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, lstat, open, readFile, realpath } from 'node:fs/promises'
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
  readonly attestation: string
  readonly browserExecutable: string
  readonly hostExecutable: string
  readonly hostdScript: string
  readonly runtimeSeed: string
}

export function bundledHostdPaths(
  app: Pick<App, 'isPackaged' | 'getAppPath'>,
  resourcesPath = process.resourcesPath,
  platform: NodeJS.Platform = process.platform,
): BundledHostdPaths {
  const applicationRoot = app.isPackaged ? path.resolve(resourcesPath) : path.resolve(app.getAppPath())
  const appRoot = path.resolve(app.getAppPath())
  const hostExecutableSegments = platform === 'win32' ? ['node.exe'] : ['bin', 'node']
  const browserExecutableSegments = platform === 'win32'
    ? ['electron.exe']
    : platform === 'darwin'
      ? ['Electron.app', 'Contents', 'MacOS', 'Electron']
      : ['electron']
  return Object.freeze({
    attestation: app.isPackaged
      ? path.join(appRoot, 'out', 'main', 'runtime-attestation.json')
      : path.join(appRoot, 'node_modules', '.cache', 'prime-continuim', 'development-runtime-attestation.json'),
    browserExecutable: app.isPackaged
      ? path.join(applicationRoot, 'browser-runtime', ...browserExecutableSegments)
      : process.execPath,
    hostExecutable: app.isPackaged
      ? path.join(applicationRoot, 'host-runtime', ...hostExecutableSegments)
      : path.join(applicationRoot, 'node_modules', 'node', ...hostExecutableSegments),
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
    paths.runtimeSeed,
    '--browser-executable',
    paths.browserExecutable
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

export function bundledHostdInvocation(
  paths: BundledHostdPaths,
  endpoint: string,
  dataDirectory: string,
  packageSmoke: boolean,
): Readonly<{ executable: string; args: readonly string[] }> {
  return Object.freeze({
    executable: paths.hostExecutable,
    args: bundledHostdLaunchArguments(paths, endpoint, dataDirectory, packageSmoke),
  })
}

export function bundledHostdEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment }
  for (const name of Object.keys(childEnvironment)) {
    const normalized = name.toUpperCase()
    if (normalized === 'NODE_OPTIONS' || normalized === 'NODE_PATH' || normalized === 'ELECTRON_RUN_AS_NODE') {
      delete childEnvironment[name]
    }
  }
  return childEnvironment
}

export async function verifyBundledHostExecutables(paths: BundledHostdPaths): Promise<void> {
  const [hostMetadata, browserMetadata, attestationMetadata, hostRealPath, browserRealPath] = await Promise.all([
    lstat(paths.hostExecutable),
    lstat(paths.browserExecutable),
    lstat(paths.attestation),
    realpath(paths.hostExecutable),
    realpath(paths.browserExecutable),
  ])
  for (const [label, metadata] of [['host Node', hostMetadata], ['browser Electron', browserMetadata]] as const) {
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 512 * 1024 * 1024) {
      throw new Error(`The bundled ${label} executable is not a bounded regular file.`)
    }
  }
  if (!attestationMetadata.isFile() || attestationMetadata.isSymbolicLink() || attestationMetadata.size < 1 || attestationMetadata.size > 256 * 1024) {
    throw new Error('The bundled runtime attestation is not a bounded regular file.')
  }
  if (hostRealPath === browserRealPath) throw new Error('The browser Electron and host Node executable paths must be distinct.')
  const bytes = await readFile(paths.attestation)
  if (bytes.byteLength !== attestationMetadata.size) throw new Error('The bundled runtime attestation changed while it was read.')
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown
  } catch (cause) {
    throw new Error('The bundled runtime attestation is not valid JSON.', { cause })
  }
  if (!isRecord(value) || !isRecord(value.guiRuntime) || !isRecord(value.hostRuntime)) {
    throw new Error('The bundled runtime attestation has no executable identities.')
  }
  if (
    JSON.stringify(Object.keys(value.guiRuntime).sort()) !== JSON.stringify(['arch', 'electronVersion', 'executableSha256', 'kind', 'modulesAbi', 'napiVersion', 'nodeVersion', 'platform']) ||
    JSON.stringify(Object.keys(value.hostRuntime).sort()) !== JSON.stringify(['arch', 'executableSha256', 'kind', 'modulesAbi', 'napiVersion', 'nodeVersion', 'platform']) ||
    value.guiRuntime.kind !== 'electron' ||
    value.hostRuntime.kind !== 'node' ||
    typeof value.guiRuntime.executableSha256 !== 'string' ||
    typeof value.hostRuntime.executableSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.guiRuntime.executableSha256) ||
    !/^[a-f0-9]{64}$/.test(value.hostRuntime.executableSha256) ||
    value.guiRuntime.executableSha256 === value.hostRuntime.executableSha256 ||
    value.guiRuntime.platform !== value.hostRuntime.platform ||
    value.guiRuntime.arch !== value.hostRuntime.arch
  ) {
    throw new Error('The bundled runtime attestation executable identities are invalid.')
  }
  const [actualBrowserDigest, actualHostDigest] = await Promise.all([
    hashExecutable(paths.browserExecutable),
    hashExecutable(paths.hostExecutable),
  ])
  if (actualBrowserDigest !== value.guiRuntime.executableSha256) {
    throw new Error('The bundled browser Electron executable does not match its runtime attestation.')
  }
  if (actualHostDigest !== value.hostRuntime.executableSha256) {
    throw new Error('The bundled host Node executable does not match its runtime attestation.')
  }
}

export async function verifyBundledHostExecutable(
  paths: BundledHostdPaths,
  guiExecutable = process.execPath,
): Promise<void> {
  const [hostMetadata, attestationMetadata, hostRealPath, guiRealPath] = await Promise.all([
    lstat(paths.hostExecutable),
    lstat(paths.attestation),
    realpath(paths.hostExecutable),
    realpath(guiExecutable),
  ])
  if (!hostMetadata.isFile() || hostMetadata.isSymbolicLink() || hostMetadata.size < 1 || hostMetadata.size > 512 * 1024 * 1024) {
    throw new Error('The bundled host Node executable is not a bounded regular file.')
  }
  if (!attestationMetadata.isFile() || attestationMetadata.isSymbolicLink() || attestationMetadata.size < 1 || attestationMetadata.size > 256 * 1024) {
    throw new Error('The bundled runtime attestation is not a bounded regular file.')
  }
  if (hostRealPath === guiRealPath) throw new Error('The GUI Electron and host Node executable paths must be distinct.')
  const bytes = await readFile(paths.attestation)
  if (bytes.byteLength !== attestationMetadata.size) throw new Error('The bundled runtime attestation changed while it was read.')
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown
  } catch (cause) {
    throw new Error('The bundled runtime attestation is not valid JSON.', { cause })
  }
  if (!isRecord(value) || !isRecord(value.guiRuntime) || !isRecord(value.hostRuntime)) {
    throw new Error('The bundled runtime attestation has no executable identities.')
  }
  if (
    JSON.stringify(Object.keys(value.guiRuntime).sort()) !== JSON.stringify(['arch', 'electronVersion', 'executableSha256', 'kind', 'modulesAbi', 'napiVersion', 'nodeVersion', 'platform']) ||
    JSON.stringify(Object.keys(value.hostRuntime).sort()) !== JSON.stringify(['arch', 'executableSha256', 'kind', 'modulesAbi', 'napiVersion', 'nodeVersion', 'platform']) ||
    value.guiRuntime.kind !== 'electron' ||
    value.hostRuntime.kind !== 'node' ||
    typeof value.guiRuntime.executableSha256 !== 'string' ||
    typeof value.hostRuntime.executableSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.guiRuntime.executableSha256) ||
    !/^[a-f0-9]{64}$/.test(value.hostRuntime.executableSha256) ||
    value.guiRuntime.executableSha256 === value.hostRuntime.executableSha256
  ) {
    throw new Error('The bundled runtime attestation executable identities are invalid.')
  }
  const actualHostDigest = await hashExecutable(paths.hostExecutable)
  if (actualHostDigest !== value.hostRuntime.executableSha256) {
    throw new Error('The bundled host Node executable does not match its runtime attestation.')
  }
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
    await Promise.all([access(paths.attestation), access(paths.browserExecutable), access(paths.hostExecutable), access(paths.hostdScript)])
  } catch (cause) {
    throw new ControlError('hostd.bundle_missing', 'The bundled local host service or its pinned Node runtime is unavailable.', {
      details: { hostExecutable: paths.hostExecutable, hostdScript: paths.hostdScript },
      cause
    })
  }
  try {
    await verifyBundledHostExecutables(paths)
  } catch (cause) {
    throw new ControlError('hostd.runtime_identity_invalid', 'The bundled host runtimes failed exact identity verification.', {
      details: { hostExecutable: paths.hostExecutable, browserExecutable: paths.browserExecutable },
      cause
    })
  }
  const packageSmoke = process.env.PRIME_CONTINUIM_PACKAGE_SMOKE === '1'
  const invocation = bundledHostdInvocation(
    paths,
    target.endpoint,
    target.dataDirectory,
    packageSmoke
  )
  const child = spawn(
    invocation.executable,
    invocation.args,
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

async function hashExecutable(executable: string): Promise<string> {
  const handle = await open(executable, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || before.size > 512 * 1024 * 1024) {
      throw new Error('The bundled executable is outside its size bound.')
    }
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let position = 0
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, before.size - position), position)
      if (bytesRead <= 0) throw new Error('The bundled executable ended before its recorded size.')
      digest.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('The bundled executable changed while it was hashed.')
    }
    return digest.digest('hex')
  } finally {
    await handle.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
