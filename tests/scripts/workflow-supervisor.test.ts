import { fork, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWorkflowChildLease,
  rejectActiveWorkflowChild,
  WorkflowChildLeaseError,
} from '../../scripts/workflow-child-lease-lib.mjs'
import { acquireWorkflowLock } from '../../scripts/workflow-lock-lib.mjs'
import { runSupervisedWorkflowStep } from '../../scripts/workflow-supervised-step-lib.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('workflow child supervision', () => {
  it('blocks takeover while the durable supervisor lease is alive and recovers it when dead', async () => {
    const root = await temporaryDirectory()
    const lockPath = join(root, 'workflow.lock')
    const main = await acquireWorkflowLock({ workflow: 'test-owner', projectRoot: root, lockPath })
    const lease = await createWorkflowChildLease({
      lockPath,
      workflow: 'dev',
      lockToken: 'lock-token',
      parentPid: 12_001,
      supervisorPid: 12_002,
    })
    await lease.setChildPid(12_003)

    await expect(
      rejectActiveWorkflowChild({
        lockPath,
        lockToken: main.owner.token,
        workflow: 'dist',
        isProcessAlive: (pid) => pid === 12_002,
      }),
    ).rejects.toBeInstanceOf(WorkflowChildLeaseError)

    await rejectActiveWorkflowChild({
      lockPath,
      lockToken: main.owner.token,
      workflow: 'dist',
      isProcessAlive: () => false,
    })
    await expect(readFile(`${lockPath}.child`, 'utf8')).rejects.toThrow()
    await lease.release()
    await main.release()
  })

  it('kills a command and its descendant when the workflow parent connection disappears', async () => {
    const root = await temporaryDirectory()
    const pidFile = join(root, 'pids.json')
    const grandchildScript = join(root, 'grandchild.cjs')
    const childScript = join(root, 'child.cjs')
    await writeFile(grandchildScript, 'setInterval(() => undefined, 1000)\n', 'utf8')
    await writeFile(
      childScript,
      `const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }))
setInterval(() => undefined, 1000)
`,
      'utf8',
    )

    const supervisor = fork(resolve('scripts/workflow-child-supervisor.mjs'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    await waitForMessage(supervisor, 'ready')
    supervisor.send({
      type: 'start',
      step: { executable: process.execPath, args: [childScript], cwd: root, environment: process.env },
    })
    await waitForMessage(supervisor, 'started')
    const pids = JSON.parse(await waitForFile(pidFile)) as { child: number; grandchild: number }
    supervisor.disconnect()
    await waitForExit(supervisor)
    await waitForProcessesToExit([pids.child, pids.grandchild])
    expect(isProcessAlive(pids.child)).toBe(false)
    expect(isProcessAlive(pids.grandchild)).toBe(false)
  }, 15_000)

  it('blocks takeover when the supervisor died but its published child is still alive', async () => {
    const root = await temporaryDirectory()
    const lockPath = join(root, 'workflow.lock')
    const main = await acquireWorkflowLock({ workflow: 'test-owner', projectRoot: root, lockPath })
    const child = spawn(process.execPath, ['--eval', 'setInterval(() => undefined, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    const lease = await createWorkflowChildLease({
      lockPath,
      lockToken: main.owner.token,
      workflow: 'dev',
      parentPid: 13_001,
      supervisorPid: 13_002,
    })
    await lease.setChildPid(child.pid!)

    await expect(rejectActiveWorkflowChild({
      lockPath,
      lockToken: main.owner.token,
      workflow: 'dist',
      isProcessAlive: (pid) => pid === child.pid,
    })).rejects.toBeInstanceOf(WorkflowChildLeaseError)

    child.kill()
    await waitForExit(child)
    await rejectActiveWorkflowChild({
      lockPath,
      lockToken: main.owner.token,
      workflow: 'dist',
      isProcessAlive: () => false,
    })
    await main.release()
  })

  it('serializes concurrent stale-child recovery behind the main workflow lock', async () => {
    const root = await temporaryDirectory()
    const lockPath = join(root, 'workflow.lock')
    const staleLease = await createWorkflowChildLease({
      lockPath,
      workflow: 'dev',
      lockToken: 'lock-token',
      parentPid: 14_001,
      supervisorPid: 14_002,
    })
    await staleLease.setChildPid(14_003)
    const results = await Promise.allSettled(Array.from({ length: 8 }, async (_, index) => {
      const main = await acquireWorkflowLock({
        workflow: `build-${index}`,
        projectRoot: root,
        lockPath,
        pid: 15_000 + index,
        isProcessAlive: () => true,
      })
      try {
        await rejectActiveWorkflowChild({
          lockPath,
          lockToken: main.owner.token,
          workflow: `build-${index}`,
          isProcessAlive: () => false,
        })
      } finally {
        await main.release()
      }
    }))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(7)
    await expect(readFile(`${lockPath}.child`, 'utf8')).rejects.toThrow()
  })

  it('retains a published live-child lease when publication reports failure and teardown is unconfirmed', async () => {
    const root = await temporaryDirectory()
    const lockPath = join(root, 'workflow.lock')
    const main = await acquireWorkflowLock({ workflow: 'dev', projectRoot: root, lockPath })
    let publishedChildPid: number | undefined
    let firstPublication = true

    await expect(runSupervisedWorkflowStep({
      workflow: 'dev',
      lock: main,
      step: {
        executable: process.execPath,
        args: ['--eval', 'setInterval(() => undefined, 1000)'],
        cwd: root,
        environment: process.env,
      },
      createLease: async (options) => {
        const real = await createWorkflowChildLease(options)
        return {
          ...real,
          setChildPid: async (pid) => {
            publishedChildPid = pid
            if (firstPublication) {
              firstPublication = false
              throw new Error('injected child publication failure')
            }
            await real.setChildPid(pid)
          },
        }
      },
      awaitSupervisorExit: async () => false,
      teardownTimeoutMs: 1,
    })).rejects.toThrow('injected child publication failure')

    expect(publishedChildPid).toEqual(expect.any(Number))
    await expect(rejectActiveWorkflowChild({
      lockPath,
      lockToken: main.owner.token,
      workflow: 'dist',
    }))
      .rejects.toBeInstanceOf(WorkflowChildLeaseError)
    const retainedOwner = JSON.parse(await readFile(`${lockPath}.child`, 'utf8')) as {
      supervisorPid: number
      childPid: number
    }
    await waitForProcessesToExit([publishedChildPid!, retainedOwner.supervisorPid])
    await rejectActiveWorkflowChild({
      lockPath,
      lockToken: main.owner.token,
      workflow: 'dist',
    })
    await expect(readFile(`${lockPath}.child`, 'utf8')).rejects.toThrow()
    await main.release()
  }, 15_000)

  it('fails closed when child-lease inspection does not prove the held main lock', async () => {
    const root = await temporaryDirectory()
    const lockPath = join(root, 'workflow.lock')
    const main = await acquireWorkflowLock({ workflow: 'dev', projectRoot: root, lockPath })
    const lease = await createWorkflowChildLease({
      lockPath,
      workflow: 'dev',
      lockToken: main.owner.token,
      parentPid: 16_001,
      supervisorPid: 16_002,
    })
    await lease.setChildPid(16_003)

    await expect(rejectActiveWorkflowChild({
      lockPath,
      lockToken: 'wrong-token',
      workflow: 'dist',
      isProcessAlive: () => false,
    })).rejects.toThrow('main workflow lock ownership does not match')
    expect(JSON.parse(await readFile(`${lockPath}.child`, 'utf8'))).toMatchObject({ token: lease.owner.token })
    await lease.release()
    await main.release()
  })

  it('retains the lease when a killed supervisor leaves its published child alive', async () => {
    const root = await temporaryDirectory()
    const lockPath = join(root, 'workflow.lock')
    const main = await acquireWorkflowLock({ workflow: 'dev', projectRoot: root, lockPath })
    const orphan = spawn(process.execPath, ['--eval', 'setInterval(() => undefined, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    })
    let supervisorPid: number | undefined
    const childPid = orphan.pid!

    await expect(runSupervisedWorkflowStep({
      workflow: 'dev',
      lock: main,
      step: {
        executable: process.execPath,
        args: ['--eval', 'setInterval(() => undefined, 1000)'],
        cwd: root,
        environment: process.env,
      },
      createLease: async (options) => {
        supervisorPid = options.supervisorPid
        const real = await createWorkflowChildLease(options)
        return {
          ...real,
          setChildPid: async () => {
            await real.setChildPid(childPid)
            process.kill(options.supervisorPid, 'SIGKILL')
          },
        }
      },
      teardownTimeoutMs: 2_000,
    })).rejects.toThrow('supervisor exited without confirming child-tree completion')

    expect(supervisorPid).toEqual(expect.any(Number))
    expect(childPid).toEqual(expect.any(Number))
    expect(isProcessAlive(supervisorPid!)).toBe(false)
    expect(isProcessAlive(childPid!)).toBe(true)
    await expect(rejectActiveWorkflowChild({
      lockPath,
      lockToken: main.owner.token,
      workflow: 'dist',
    })).rejects.toBeInstanceOf(WorkflowChildLeaseError)

    process.kill(childPid, 'SIGKILL')
    await waitForProcessesToExit([childPid])
    await rejectActiveWorkflowChild({
      lockPath,
      lockToken: main.owner.token,
      workflow: 'dist',
    })
    await expect(readFile(`${lockPath}.child`, 'utf8')).rejects.toThrow()
    await main.release()
  }, 15_000)

  it('terminates a detached unref descendant before releasing the workflow lease', async () => {
    const root = await temporaryDirectory()
    const lockPath = join(root, 'workflow.lock')
    const pidFile = join(root, 'detached-grandchild.pid')
    const grandchildScript = join(root, 'detached-grandchild.cjs')
    const directScript = join(root, 'spawn-detached.cjs')
    await writeFile(grandchildScript, 'setInterval(() => undefined, 1000)\n', 'utf8')
    await writeFile(directScript, `const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const child = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { detached: true, stdio: 'ignore' })
child.unref()
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
`, 'utf8')
    const main = await acquireWorkflowLock({ workflow: 'dev', projectRoot: root, lockPath })

    const result = await runSupervisedWorkflowStep({
      workflow: 'dev',
      lock: main,
      step: {
        executable: process.execPath,
        args: [directScript],
        cwd: root,
        environment: process.env,
      },
      teardownTimeoutMs: 10_000,
    })

    expect(result).toMatchObject({ code: 0, supervisorExitedWithoutChildConfirmation: false })
    const grandchildPid = Number(await waitForFile(pidFile))
    await waitForProcessesToExit([grandchildPid])
    await expect(readFile(`${lockPath}.child`, 'utf8')).rejects.toThrow()
    await main.release()
    const replacement = await acquireWorkflowLock({ workflow: 'dist', projectRoot: root, lockPath })
    expect(replacement.owner.workflow).toBe('dist')
    await replacement.release()
  }, 20_000)
})

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'prime-workflow-supervisor-'))
  temporaryDirectories.push(path)
  return path
}

function waitForMessage(child: ReturnType<typeof fork>, type: string) {
  return new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error(`Timed out waiting for ${type}.`)), 5_000)
    child.on('message', function listener(message) {
      if ((message as { type?: string })?.type !== type) return
      clearTimeout(timeout)
      child.off('message', listener)
      resolvePromise(message as Record<string, unknown>)
    })
    child.once('error', rejectPromise)
  })
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8') } catch { await delay(25) }
  }
  throw new Error('Timed out waiting for supervised process PIDs.')
}

function waitForExit(child: ReturnType<typeof fork> | ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()))
}

async function waitForProcessesToExit(pids: number[]) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline && pids.some(isProcessAlive)) await delay(50)
  const live = pids.filter(isProcessAlive)
  if (live.length > 0) throw new Error(`Timed out waiting for supervised PIDs to exit: ${live.join(', ')}`)
}

function isProcessAlive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function delay(milliseconds: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}
