import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

let child
let forceTimer
let stopping = false

process.on('message', (message) => {
  if (message?.type === 'start' && !child) start(message.step)
  else if (message?.type === 'terminate') terminate(message.signal ?? 'SIGTERM', false)
})
process.once('disconnect', () => terminate('SIGTERM', true))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => terminate(signal, false))
}
process.send?.({ type: 'ready' })

function start(step) {
  if (!step || typeof step.executable !== 'string' || !Array.isArray(step.args) || typeof step.cwd !== 'string') {
    process.send?.({ type: 'error', message: 'Invalid supervised workflow step.' })
    process.exit(1)
  }
  const launch = process.platform === 'win32'
    ? windowsJobLaunch(step)
    : { executable: resolve(step.executable), args: step.args }
  child = spawn(launch.executable, launch.args, {
    cwd: resolve(step.cwd),
    env: step.environment,
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  child.once('error', (error) => {
    sendAndExit({ type: 'error', message: error.message }, 1)
  })
  child.once('spawn', () => process.send?.({ type: 'started', childPid: child.pid }))
  child.once('exit', async (code, signal) => {
    if (forceTimer) clearTimeout(forceTimer)
    if (process.platform !== 'win32' && !(await terminateRemainingPosixGroup(child.pid))) {
      sendAndExit({ type: 'error', message: 'POSIX workflow process group did not terminate.' }, 1)
      return
    }
    sendAndExit({ type: 'exit', code, signal }, code ?? (signal ? 1 : 0))
  })
}

function windowsJobLaunch(step) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const executable = resolve(step.executable)
  const payload = Buffer.from(JSON.stringify({
    executable,
    commandLine: [executable, ...step.args].map(quoteWindowsArgument).join(' '),
    cwd: resolve(step.cwd),
  }), 'utf8').toString('base64')
  return {
    executable: resolve(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', resolve(import.meta.dirname, 'windows-job-supervisor.ps1'),
      '-Payload', payload,
    ],
  }
}

function quoteWindowsArgument(value) {
  const text = String(value)
  if (text && !/[\s"]/u.test(text)) return text
  return `"${text.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}

async function terminateRemainingPosixGroup(pid) {
  try { process.kill(-pid, 'SIGTERM') } catch {}
  if (await waitForPosixGroupExit(pid, 2_000)) return true
  try { process.kill(-pid, 'SIGKILL') } catch {}
  return await waitForPosixGroupExit(pid, 3_000)
}

async function waitForPosixGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0) } catch (error) {
      if (error?.code === 'ESRCH') return true
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  return false
}

function sendAndExit(message, code) {
  if (process.connected && process.send) {
    process.send(message, () => process.exit(code))
  } else {
    process.exit(code)
  }
}

function terminate(signal, parentGone) {
  if (stopping) return
  stopping = true
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    process.exit(1)
    return
  }
  if (process.platform === 'win32') {
    // Console Ctrl+C reaches the shared tree naturally. If the wrapper vanished,
    // there is no process left to provide that grace period, so close the tree now.
    forceTimer = setTimeout(() => forceWindowsTree(child.pid), parentGone ? 0 : 2_000)
  } else {
    try {
      process.kill(-child.pid, signal)
    } catch {}
    forceTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }, 5_000)
  }
  forceTimer.unref?.()
}

function forceWindowsTree(pid) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const taskkill = resolve(systemRoot, 'System32', 'taskkill.exe')
  const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  killer.once('error', () => {
    try { child.kill('SIGKILL') } catch {}
  })
}
