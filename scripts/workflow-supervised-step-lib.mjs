import { fork } from 'node:child_process'
import { resolve } from 'node:path'
import { createWorkflowChildLease } from './workflow-child-lease-lib.mjs'

const SUPERVISOR = resolve(import.meta.dirname, 'workflow-child-supervisor.mjs')

export async function runSupervisedWorkflowStep({
  step,
  workflow,
  lock,
  createLease = createWorkflowChildLease,
  awaitSupervisorExit = waitForSupervisorExit,
  teardownTimeoutMs = 10_000,
}) {
  const supervisor = fork(SUPERVISOR, [], {
    cwd: step.cwd,
    env: process.env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  })
  const ready = await waitForMessage(supervisor, 'ready')
  if (!ready) throw new Error('Workflow command supervisor did not become ready.')
  let lease
  try {
    lease = await createLease({
      lockPath: lock.path,
      workflow,
      lockToken: lock.owner.token,
      parentPid: process.pid,
      supervisorPid: supervisor.pid,
    })
  } catch (error) {
    if (supervisor.connected) supervisor.disconnect()
    supervisor.kill()
    throw error
  }
  let startedChildPid
  let childPublished = false
  let releaseLease = false
  const signalHandlers = new Map()
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => supervisor.send?.({ type: 'terminate', signal })
    signalHandlers.set(signal, handler)
    process.on(signal, handler)
  }
  try {
    const completion = waitForCompletion(supervisor)
    const started = waitForMessage(supervisor, 'started')
    supervisor.send({
      type: 'start',
      step: {
        executable: step.executable,
        args: step.args,
        cwd: step.cwd,
        environment: step.environment,
      },
    })
    const startedMessage = await started
    startedChildPid = startedMessage.childPid
    await lease.setChildPid(startedMessage.childPid)
    childPublished = true
    const result = await completion
    if (result.supervisorExitedWithoutChildConfirmation) {
      throw new Error('Workflow supervisor exited without confirming child-tree completion.')
    }
    if (!(await awaitSupervisorExit(supervisor, teardownTimeoutMs))) {
      throw new Error('Workflow supervisor did not confirm process-tree exit before the teardown deadline.')
    }
    releaseLease = await lease.confirmChildTreeExited()
    if (!releaseLease) {
      throw new Error('Workflow child process is still alive after supervisor exit; retaining its lease.')
    }
    return result
  } catch (error) {
    if (startedChildPid && !childPublished) {
      try {
        await lease.setChildPid(startedChildPid)
        childPublished = true
      } catch {}
    }
    if (supervisor.connected) {
      try { supervisor.send({ type: 'terminate', signal: 'SIGTERM' }) } catch {}
      supervisor.disconnect()
    }
    if (await awaitSupervisorExit(supervisor, teardownTimeoutMs)) {
      releaseLease = await lease.confirmChildTreeExited()
    }
    throw error
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
    if (releaseLease) await lease.release()
  }
}

function waitForSupervisorExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolveExit(true)
    }
    child.once('exit', onExit)
  })
}

function waitForMessage(child, type) {
  return new Promise((resolveMessage, rejectMessage) => {
    child.on('message', function listener(message) {
      if (message?.type !== type) return
      child.off('message', listener)
      resolveMessage(message)
    })
    child.once('error', rejectMessage)
    child.once('exit', (code) => rejectMessage(new Error(`Workflow supervisor exited before ${type} (${code}).`)))
  })
}

function waitForCompletion(child) {
  return new Promise((resolveCompletion, rejectCompletion) => {
    child.on('message', (message) => {
      if (message?.type === 'exit') resolveCompletion({
        code: message.code,
        signal: message.signal,
        supervisorExitedWithoutChildConfirmation: false,
      })
      if (message?.type === 'error') rejectCompletion(new Error(message.message))
    })
    child.once('error', rejectCompletion)
    child.once('exit', (code, signal) => {
      resolveCompletion({ code, signal, supervisorExitedWithoutChildConfirmation: true })
    })
  })
}
