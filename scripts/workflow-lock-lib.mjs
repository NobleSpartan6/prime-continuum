import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const MAXIMUM_OWNER_BYTES = 16 * 1024
const INITIALIZATION_GRACE_MS = 10_000
const MAXIMUM_ACQUIRE_ATTEMPTS = 8

export class WorkflowLockError extends Error {
  constructor(requestedWorkflow, owner) {
    const message = owner
      ? `Cannot start "${requestedWorkflow}" while "${owner.workflow}" is running for this workspace (PID ${owner.pid}, started ${owner.startedAt}). Stop that command with Ctrl+C, then retry.`
      : `Cannot start "${requestedWorkflow}" because another workspace command is acquiring the build lock. Wait a moment, then retry.`
    super(message)
    this.name = 'WorkflowLockError'
    this.requestedWorkflow = requestedWorkflow
    this.owner = owner
  }
}

export function getWorkflowLockPath(projectRoot = process.cwd()) {
  const physicalRoot = canonicalProjectRoot(projectRoot)
  return join(physicalRoot, '.prime-continuim-workflow.lock')
}

export async function acquireWorkflowLock({
  workflow,
  projectRoot = process.cwd(),
  lockPath = getWorkflowLockPath(projectRoot),
  pid = process.pid,
  now = () => Date.now(),
  isProcessAlive = defaultIsProcessAlive,
} = {}) {
  assertWorkflowName(workflow)
  assertPid(pid)
  const physicalProjectRoot = canonicalProjectRoot(projectRoot)
  const absoluteLockPath = resolve(lockPath)
  const recoveryClaimPath = `${absoluteLockPath}.recovery`
  const quarantinePath = `${absoluteLockPath}.stale-quarantine`
  await mkdir(dirname(absoluteLockPath), { recursive: true })

  const owner = {
    schemaVersion: 1,
    token: randomUUID(),
    pid,
    workflow,
    startedAt: new Date(now()).toISOString(),
    projectRoot: physicalProjectRoot,
  }
  const candidatePath = `${absoluteLockPath}.candidate-${process.pid}-${owner.token}`
  try {
    writeCandidate(candidatePath, owner)
  } catch (error) {
    try {
      unlinkSync(candidatePath)
    } catch (cleanupError) {
      if (!isErrorCode(cleanupError, 'ENOENT')) throw cleanupError
    }
    throw error
  }

  try {
    for (let attempt = 0; attempt < MAXIMUM_ACQUIRE_ATTEMPTS; attempt += 1) {
      await assertNoRecoveryClaim({ recoveryClaimPath, workflow, now })
      try {
        linkSync(candidatePath, absoluteLockPath)
        unlinkSync(candidatePath)
        return {
          path: absoluteLockPath,
          owner,
          release: () => releaseWorkflowLock(absoluteLockPath, owner.token),
          releaseSync: () => releaseWorkflowLockSync(absoluteLockPath, owner.token),
        }
      } catch (error) {
        if (!isErrorCode(error, 'EEXIST')) throw error
      }

      const existing = await inspectExistingLock(absoluteLockPath, now())
      if (existing.state === 'missing') continue
      if (existing.state === 'active' || existing.state === 'initializing') {
        throw new WorkflowLockError(workflow, existing.owner)
      }
      if (existing.state === 'unsafe') {
        throw new Error(`The workspace build lock is not a safe regular file: ${absoluteLockPath}. Remove it manually after confirming no Prime Continuim command is running.`)
      }
      if (existing.state === 'stale' && existing.owner && isProcessAlive(existing.owner.pid)) {
        throw new WorkflowLockError(workflow, existing.owner)
      }
      await recoverStaleLock({
        lockPath: absoluteLockPath,
        recoveryClaimPath,
        quarantinePath,
        workflow,
        owner,
        now,
        isProcessAlive,
      })
    }
  } finally {
    await unlink(candidatePath).catch((error) => {
      if (!isErrorCode(error, 'ENOENT')) throw error
    })
  }

  throw new Error(`Could not acquire the workspace build lock after ${MAXIMUM_ACQUIRE_ATTEMPTS} attempts.`)
}

async function recoverStaleLock({
  lockPath,
  recoveryClaimPath,
  quarantinePath,
  workflow,
  owner,
  now,
  isProcessAlive,
}) {
  const recoveryOwner = { ...owner, token: randomUUID() }
  const recoveryCandidatePath = `${recoveryClaimPath}.candidate-${process.pid}-${recoveryOwner.token}`
  writeCandidate(recoveryCandidatePath, recoveryOwner)
  try {
    try {
      linkSync(recoveryCandidatePath, recoveryClaimPath)
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error
      await throwRecoveryClaimConflict({ recoveryClaimPath, quarantinePath, workflow, now })
    } finally {
      try {
        unlinkSync(recoveryCandidatePath)
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) throw error
      }
    }

    const existing = await inspectExistingLock(lockPath, now())
    if (existing.state === 'missing') return
    if (existing.state === 'active' || existing.state === 'initializing') {
      throw new WorkflowLockError(workflow, existing.owner)
    }
    if (existing.state === 'unsafe') {
      throw new Error(`The workspace build lock is not a safe regular file: ${lockPath}. Remove it manually after confirming no Prime Continuim command is running.`)
    }
    if (existing.owner && isProcessAlive(existing.owner.pid)) {
      throw new WorkflowLockError(workflow, existing.owner)
    }

    await assertPathMissing(
      quarantinePath,
      `Stale workspace-lock recovery is incomplete. After confirming no Prime Continuim workflow is running, inspect and remove exactly "${quarantinePath}" and "${recoveryClaimPath}", then retry.`,
    )

    try {
      linkSync(lockPath, quarantinePath)
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return
      if (isErrorCode(error, 'EEXIST')) {
        throw new Error(`Stale workspace-lock recovery is incomplete. After confirming no Prime Continuim workflow is running, inspect and remove exactly "${quarantinePath}" and "${recoveryClaimPath}", then retry.`)
      }
      throw error
    }

    try {
      unlinkSync(lockPath)
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error
    }
    try {
      unlinkSync(quarantinePath)
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) {
        throw new Error(`The stale workspace lock was quarantined but cleanup did not finish at "${quarantinePath}". After confirming no Prime Continuim workflow is running, remove exactly "${quarantinePath}" and retry.`, { cause: error })
      }
    }
  } finally {
    await releaseWorkflowLock(recoveryClaimPath, recoveryOwner.token)
  }
}

async function assertNoRecoveryClaim({ recoveryClaimPath, workflow, now }) {
  const claim = await inspectExistingLock(recoveryClaimPath, now())
  if (claim.state === 'missing') return
  if (claim.state === 'active' || claim.state === 'initializing') {
    throw new WorkflowLockError(workflow, claim.owner)
  }
  await throwRecoveryClaimConflict({
    recoveryClaimPath,
    quarantinePath: `${recoveryClaimPath.slice(0, -'.recovery'.length)}.stale-quarantine`,
    workflow,
    now,
    claim,
  })
}

async function throwRecoveryClaimConflict({ recoveryClaimPath, quarantinePath, workflow, now, claim }) {
  const existing = claim ?? await inspectExistingLock(recoveryClaimPath, now())
  if (existing.state === 'missing') {
    throw new WorkflowLockError(workflow)
  }
  const ownerText = existing.owner ? ` The recorded recovery process is PID ${existing.owner.pid}.` : ''
  throw new Error(`Cannot start "${workflow}" because stale workspace-lock recovery is incomplete at "${recoveryClaimPath}".${ownerText} After confirming that process and every Prime Continuim workflow for this workspace have stopped, inspect "${quarantinePath}", remove exactly "${recoveryClaimPath}", and retry.`)
}

async function assertPathMissing(path, message) {
  try {
    await lstat(path)
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return
    throw error
  }
  throw new Error(message)
}

function writeCandidate(path, owner) {
  let descriptor
  try {
    descriptor = openSync(path, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8')
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

async function inspectExistingLock(lockPath, currentTime) {
  let metadata
  try {
    metadata = await lstat(lockPath)
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return { state: 'missing' }
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return { state: 'unsafe' }
  }
  if (metadata.nlink === 2 && currentTime - metadata.mtimeMs <= INITIALIZATION_GRACE_MS) return { state: 'initializing' }
  if (metadata.nlink !== 1) return { state: 'unsafe' }
  if (metadata.size <= 0 || metadata.size > MAXIMUM_OWNER_BYTES) {
    return currentTime - metadata.mtimeMs <= INITIALIZATION_GRACE_MS
      ? { state: 'initializing' }
      : { state: 'stale' }
  }

  let owner
  try {
    owner = parseOwner(await readFile(lockPath, 'utf8'))
  } catch {
    return currentTime - metadata.mtimeMs <= INITIALIZATION_GRACE_MS
      ? { state: 'initializing' }
      : { state: 'stale' }
  }
  return { state: 'stale', owner }
}

function parseOwner(contents) {
  const value = JSON.parse(contents)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    typeof value.token !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(value.token) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.workflow !== 'string' ||
    !value.workflow ||
    value.workflow.length > 128 ||
    /[\0\r\n]/.test(value.workflow) ||
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    typeof value.projectRoot !== 'string' ||
    !value.projectRoot ||
    /[\0\r\n]/.test(value.projectRoot)
  ) {
    throw new Error('Invalid workspace build lock owner.')
  }
  return value
}

async function releaseWorkflowLock(lockPath, token) {
  let metadata
  try {
    metadata = await lstat(lockPath)
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAXIMUM_OWNER_BYTES) return
  let owner
  try {
    owner = parseOwner(await readFile(lockPath, 'utf8'))
  } catch {
    return
  }
  if (owner.token !== token) return
  await unlink(lockPath).catch((error) => {
    if (!isErrorCode(error, 'ENOENT')) throw error
  })
}

function releaseWorkflowLockSync(lockPath, token) {
  try {
    const metadata = lstatSync(lockPath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAXIMUM_OWNER_BYTES) return
    const owner = parseOwner(readFileSync(lockPath, 'utf8'))
    if (owner.token === token) unlinkSync(lockPath)
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) return
  }
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isErrorCode(error, 'EPERM')
  }
}

function canonicalProjectRoot(projectRoot) {
  const absoluteRoot = resolve(projectRoot)
  try {
    return realpathSync.native(absoluteRoot)
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      throw new Error(`The Prime Continuim workspace does not exist: ${absoluteRoot}`)
    }
    throw error
  }
}

function assertWorkflowName(workflow) {
  if (typeof workflow !== 'string' || !workflow || workflow.length > 128 || /[\0\r\n]/.test(workflow)) {
    throw new TypeError('workflow must be a non-empty single-line name no longer than 128 characters.')
  }
}

function assertPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('pid must be a positive safe integer.')
}

function isErrorCode(error, code) {
  return error !== null && typeof error === 'object' && error.code === code
}
