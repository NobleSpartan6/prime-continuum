import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import type { App } from 'electron'
import { ControlError } from './errors'
import { FramedConnection } from './framed-connection'
import { buildSshConnectArgs, classifySshFailure } from './ssh'

const LOCAL_CONNECT_TIMEOUT_MS = 750
const LOCAL_START_TIMEOUT_MS = 8_000

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

/**
 * Must remain byte-for-byte compatible with src/hostd/paths.ts. It is kept
 * here so the Electron main bundle never imports the service entrypoint.
 */
export function localHostdEndpoint(dataDirectory = hostdDataDirectory()): string {
  if (process.platform === 'win32') {
    const identity = createHash('sha256').update(path.resolve(dataDirectory).toLowerCase()).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\prime-agent-hostd-${identity}`
  }
  return path.join(dataDirectory, 'hostd.sock')
}

export async function connectLocalHostd(endpoint: string): Promise<FramedConnection> {
  const socket = await openSocket(endpoint, LOCAL_CONNECT_TIMEOUT_MS)
  return connectionFromSocket(socket, endpoint)
}

export async function ensureAndConnectLocalHostd(app: App): Promise<FramedConnection> {
  const dataDirectory = hostdDataDirectory()
  const endpoint = localHostdEndpoint(dataDirectory)
  try {
    return await connectLocalHostd(endpoint)
  } catch {
    await startBundledHostd(app, endpoint, dataDirectory)
  }

  const deadline = Date.now() + LOCAL_START_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await connectLocalHostd(endpoint)
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
}

export async function startBundledHostd(
  app: App,
  endpoint: string,
  dataDirectory: string
): Promise<void> {
  const hostdScript = app.isPackaged
    ? path.join(process.resourcesPath, 'hostd', 'hostd.cjs')
    : path.join(app.getAppPath(), 'out', 'hostd', 'hostd.cjs')
  try {
    await access(hostdScript)
  } catch (cause) {
    throw new ControlError('hostd.bundle_missing', 'The bundled local host service is unavailable.', {
      details: { hostdScript },
      cause
    })
  }
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })

  const child = spawn(
    process.execPath,
    [hostdScript, 'serve', '--socket', endpoint, '--data-dir', dataDirectory],
    {
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }
  )
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', (cause) =>
      reject(
        new ControlError('hostd.spawn_failed', 'The bundled local host service could not be started.', {
          retryable: true,
          details: { hostdScript },
          cause
        })
      )
    )
  })
  child.unref()
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
