import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'

const MAXIMUM_LEASE_BYTES = 16 * 1024

export class WorkflowChildLeaseError extends Error {
  constructor(workflow, owner) {
    super(`Cannot start "${workflow}" while "${owner.workflow}" still owns a live command process (PID ${owner.supervisorPid}). Wait for it to stop, then retry.`)
    this.name = 'WorkflowChildLeaseError'
    this.owner = owner
  }
}

export function workflowChildLeasePath(lockPath) {
  return `${lockPath}.child`
}

export async function rejectActiveWorkflowChild({ lockPath, lockToken, workflow, isProcessAlive = processIsAlive }) {
  await assertHeldMainLock(lockPath, lockToken)
  const path = workflowChildLeasePath(lockPath)
  const owner = await readOwner(path)
  if (!owner) return
  if (
    owner.childPublication === 'pending' ||
    isProcessAlive(owner.supervisorPid) ||
    (owner.childPid && containedChildIsAlive(owner, isProcessAlive))
  ) {
    throw new WorkflowChildLeaseError(workflow, owner)
  }
  await quarantineAndRemove(path, owner.token, isProcessAlive)
}

async function assertHeldMainLock(lockPath, lockToken) {
  if (typeof lockToken !== 'string' || lockToken.length < 1) {
    throw new Error('Child-lease inspection requires the held main workflow lock token.')
  }
  let metadata
  try {
    metadata = await lstat(lockPath)
  } catch (error) {
    throw new Error('Child-lease inspection requires a live on-disk main workflow lock.', { cause: error })
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size <= 0 ||
    metadata.size > MAXIMUM_LEASE_BYTES
  ) throw new Error('Child-lease inspection requires a safe on-disk main workflow lock.')
  let owner
  try {
    owner = JSON.parse(await readFile(lockPath, 'utf8'))
  } catch (error) {
    throw new Error('Child-lease inspection could not validate the main workflow lock.', { cause: error })
  }
  if (owner?.schemaVersion !== 1 || owner.token !== lockToken) {
    throw new Error('Child-lease inspection main workflow lock ownership does not match.')
  }
}

export async function createWorkflowChildLease({ lockPath, workflow, lockToken, parentPid, supervisorPid }) {
  const path = workflowChildLeasePath(lockPath)
  const owner = {
    schemaVersion: 1,
    token: randomUUID(),
    lockToken,
    workflow,
    parentPid,
    supervisorPid,
    containment: process.platform === 'win32' ? 'windows-job' : 'posix-process-group',
    childPublication: 'pending',
    startedAt: new Date().toISOString(),
  }
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return {
    owner,
    setChildPid: (childPid) => updateChildPid(path, owner.token, childPid),
    confirmChildTreeExited: () => confirmChildTreeExited(path, owner.token),
    release: () => releaseOwner(path, owner.token),
  }
}

async function confirmChildTreeExited(path, token) {
  const owner = await readOwner(path)
  if (!owner || owner.token !== token || owner.childPublication !== 'published' || !owner.childPid) return false
  return !containedChildIsAlive(owner, processIsAlive)
}

async function readOwner(path) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_LEASE_BYTES) {
    throw new Error(`Workflow child lease is malformed: ${path}`)
  }
  const owner = JSON.parse(bytes.toString('utf8'))
  if (
    owner?.schemaVersion !== 1 ||
    typeof owner.token !== 'string' ||
    typeof owner.lockToken !== 'string' ||
    typeof owner.workflow !== 'string' ||
    !Number.isSafeInteger(owner.parentPid) || owner.parentPid < 1 ||
    !Number.isSafeInteger(owner.supervisorPid) || owner.supervisorPid < 1 ||
    (owner.containment !== 'windows-job' && owner.containment !== 'posix-process-group') ||
    (owner.childPublication !== 'pending' && owner.childPublication !== 'published') ||
    (owner.childPid !== undefined && (!Number.isSafeInteger(owner.childPid) || owner.childPid < 1)) ||
    (owner.childPublication === 'published' && owner.childPid === undefined) ||
    !Number.isFinite(Date.parse(owner.startedAt))
  ) throw new Error(`Workflow child lease is malformed: ${path}`)
  return owner
}

async function updateChildPid(path, token, childPid) {
  if (!Number.isSafeInteger(childPid) || childPid < 1) throw new TypeError('childPid must be a positive safe integer.')
  const owner = await readOwner(path)
  if (!owner || owner.token !== token) throw new Error('Workflow child lease ownership changed before child publication.')
  const replacement = `${path}.update-${process.pid}-${randomUUID()}`
  const handle = await open(replacement, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ ...owner, childPublication: 'published', childPid })}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(replacement, path).catch(async (error) => {
    await unlink(replacement).catch(() => undefined)
    throw error
  })
  owner.childPid = childPid
  owner.childPublication = 'published'
}

async function releaseOwner(path, token) {
  const owner = await readOwner(path)
  if (!owner || owner.token !== token) return
  await unlink(path).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
}

async function quarantineAndRemove(path, expectedToken, isProcessAlive) {
  const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`
  try {
    await rename(path, quarantine)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const claimed = await readOwner(quarantine)
  if (
    !claimed ||
    claimed.token !== expectedToken ||
    claimed.childPublication === 'pending' ||
    isProcessAlive(claimed.supervisorPid) ||
    (claimed.childPid && containedChildIsAlive(claimed, isProcessAlive))
  ) {
    // Called only while the main workspace lock is held, so no legitimate new
    // lease can occupy the canonical path during this token/liveness recheck.
    await rename(quarantine, path)
    throw new Error('Workflow child lease changed while stale recovery was claimed.')
  }
  await unlink(quarantine)
}

function containedChildIsAlive(owner, isProcessAlive) {
  if (owner.containment === 'posix-process-group') {
    try {
      process.kill(-owner.childPid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }
  return isProcessAlive(owner.childPid)
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}
