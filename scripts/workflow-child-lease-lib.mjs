import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const MAXIMUM_LEASE_BYTES = 16 * 1024
const WINDOWS_PUBLICATION_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 200, 400, 800])
const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])
const PENDING_OWNER_KEYS = Object.freeze([
  'schemaVersion',
  'token',
  'lockToken',
  'workflow',
  'parentPid',
  'supervisorPid',
  'containment',
  'childPublication',
  'startedAt',
])
const PUBLISHED_OWNER_KEYS = Object.freeze([...PENDING_OWNER_KEYS, 'childPid'])

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

export async function createWorkflowChildLease({
  lockPath,
  workflow,
  lockToken,
  parentPid,
  supervisorPid,
  publicationTestHooks,
}) {
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
    setChildPid: (childPid) => updateChildPid(path, owner.token, childPid, publicationTestHooks),
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
  const expectedKeys = owner?.childPublication === 'published' ? PUBLISHED_OWNER_KEYS : PENDING_OWNER_KEYS
  if (
    owner?.schemaVersion !== 1 ||
    !exactKeys(owner, expectedKeys) ||
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

async function updateChildPid(path, token, childPid, testHooks) {
  if (!Number.isSafeInteger(childPid) || childPid < 1) throw new TypeError('childPid must be a positive safe integer.')
  const owner = await readOwner(path)
  if (!owner || owner.token !== token) throw new Error('Workflow child lease ownership changed before child publication.')
  if (owner.childPublication === 'published') {
    if (owner.childPid !== childPid || await inspectExactLeaseFile(path, ownerBytes(owner)) !== 'exact') {
      throw new Error('Workflow child lease publication identity changed.')
    }
    return
  }
  const predecessorBytes = ownerBytes(owner)
  if (await inspectExactLeaseFile(path, predecessorBytes) !== 'exact') {
    throw new Error('Workflow child lease predecessor is not an exact safe single-link file.')
  }
  const successor = { ...owner, childPublication: 'published', childPid }
  const successorBytes = ownerBytes(successor)
  const replacement = `${path}.update-${process.pid}-${randomUUID()}`
  const handle = await open(replacement, 'wx', 0o600)
  try {
    await handle.writeFile(successorBytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (await inspectExactLeaseFile(replacement, successorBytes) !== 'exact') {
      throw new Error('Workflow child lease replacement is not an exact safe single-link file.')
    }
    await replacePublishedOwner({
      path,
      replacement,
      predecessorBytes,
      successorBytes,
      testHooks,
    })
  } catch (error) {
    try {
      await cleanupOwnedReplacement(replacement, successorBytes)
    } catch (cleanupError) {
      attachPublicationCleanupFailure(error, cleanupError)
    }
    throw error
  }
  owner.childPid = childPid
  owner.childPublication = 'published'
}

async function replacePublishedOwner({ path, replacement, predecessorBytes, successorBytes, testHooks }) {
  const platform = testHooks?.platform ?? process.platform
  const renameFile = testHooks?.rename ?? rename
  const wait = testHooks?.wait ?? delay
  if (typeof renameFile !== 'function' || typeof wait !== 'function') {
    throw new TypeError('Workflow child lease publication hooks are invalid.')
  }

  const retryBudget = { index: 0 }
  let renameAttempted = false
  let lastRenameError
  while (true) {
    const before = renameAttempted
      ? await inspectPublicationWithRetry({
          path,
          replacement,
          predecessorBytes,
          successorBytes,
          testHooks,
          platform,
          wait,
          retryBudget,
          fallbackError: lastRenameError,
        })
      : await inspectPublicationFiles(path, replacement, predecessorBytes, successorBytes, testHooks)
    if (before.target === 'successor') {
      if (before.replacement !== 'absent' && before.replacement !== 'successor') {
        throw new Error('Workflow child lease replacement changed after publication.')
      }
      if (before.replacement === 'successor') await cleanupOwnedReplacement(replacement, successorBytes)
      return
    }
    if (before.target !== 'predecessor' || before.replacement !== 'successor') {
      throw new Error('Workflow child lease ownership changed before publication retry.')
    }

    try {
      renameAttempted = true
      await renameFile(replacement, path)
    } catch (error) {
      lastRenameError = error
      const after = await inspectPublicationWithRetry({
        path,
        replacement,
        predecessorBytes,
        successorBytes,
        testHooks,
        platform,
        wait,
        retryBudget,
        fallbackError: error,
      })
      if (after.target === 'successor') {
        if (after.replacement !== 'absent' && after.replacement !== 'successor') {
          throw new Error('Workflow child lease replacement changed after ambiguous publication.', { cause: error })
        }
        if (after.replacement === 'successor') await cleanupOwnedReplacement(replacement, successorBytes)
        return
      }
      if (after.target !== 'predecessor' || after.replacement !== 'successor') {
        throw new Error('Workflow child lease ownership changed before publication retry.', { cause: error })
      }
      if (
        platform !== 'win32' ||
        !WINDOWS_TRANSIENT_RENAME_ERRORS.has(error?.code) ||
        retryBudget.index >= WINDOWS_PUBLICATION_RETRY_DELAYS_MS.length
      ) throw error
      await wait(WINDOWS_PUBLICATION_RETRY_DELAYS_MS[retryBudget.index])
      retryBudget.index += 1
      continue
    }

    const after = await inspectPublicationWithRetry({
      path,
      replacement,
      predecessorBytes,
      successorBytes,
      testHooks,
      platform,
      wait,
      retryBudget,
    })
    if (
      after.target !== 'successor' ||
      (after.replacement !== 'absent' && after.replacement !== 'successor')
    ) {
      throw new Error('Workflow child lease rename did not publish the exact successor.')
    }
    if (after.replacement === 'successor') await cleanupOwnedReplacement(replacement, successorBytes)
    return
  }
}

async function inspectPublicationWithRetry({
  path,
  replacement,
  predecessorBytes,
  successorBytes,
  testHooks,
  platform,
  wait,
  retryBudget,
  fallbackError,
}) {
  while (true) {
    try {
      return await inspectPublicationFiles(path, replacement, predecessorBytes, successorBytes, testHooks)
    } catch (inspectionError) {
      if (
        platform !== 'win32' ||
        !WINDOWS_TRANSIENT_RENAME_ERRORS.has(inspectionError?.code) ||
        retryBudget.index >= WINDOWS_PUBLICATION_RETRY_DELAYS_MS.length
      ) throw fallbackError ?? inspectionError
      await wait(WINDOWS_PUBLICATION_RETRY_DELAYS_MS[retryBudget.index])
      retryBudget.index += 1
    }
  }
}

async function inspectPublicationFiles(path, replacement, predecessorBytes, successorBytes, testHooks) {
  await testHooks?.beforeInspection?.()
  const [targetState, replacementState] = await Promise.all([
    inspectLeaseFile(path, predecessorBytes, successorBytes, testHooks),
    inspectLeaseFile(replacement, undefined, successorBytes, testHooks),
  ])
  return { target: targetState, replacement: replacementState }
}

async function inspectLeaseFile(path, predecessorBytes, successorBytes, testHooks) {
  const predecessor = predecessorBytes && await inspectExactLeaseFile(path, predecessorBytes, testHooks)
  if (predecessor === 'exact') return 'predecessor'
  if (predecessor === 'absent') return 'absent'
  const successor = await inspectExactLeaseFile(path, successorBytes, testHooks)
  if (successor === 'exact') return 'successor'
  return successor
}

async function inspectExactLeaseFile(path, expectedBytes, testHooks) {
  let pathMetadata
  try {
    pathMetadata = await lstat(path, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent'
    throw error
  }
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.nlink !== 1n ||
    pathMetadata.size !== BigInt(expectedBytes.byteLength) ||
    pathMetadata.size <= 0n ||
    pathMetadata.size > BigInt(MAXIMUM_LEASE_BYTES)
  ) return 'unsafe'

  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent'
    throw error
  }
  try {
    const handleMetadata = await handle.stat({ bigint: true })
    if (
      !handleMetadata.isFile() ||
      handleMetadata.nlink !== 1n ||
      handleMetadata.dev !== pathMetadata.dev ||
      handleMetadata.ino !== pathMetadata.ino ||
      handleMetadata.size !== BigInt(expectedBytes.byteLength)
    ) return 'unsafe'
    const bytes = await handle.readFile()
    await testHooks?.afterFileRead?.(path)
    let finalPathMetadata
    try {
      finalPathMetadata = await lstat(path, { bigint: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return 'unsafe'
      throw error
    }
    if (
      !finalPathMetadata.isFile() ||
      finalPathMetadata.isSymbolicLink() ||
      finalPathMetadata.nlink !== 1n ||
      finalPathMetadata.dev !== handleMetadata.dev ||
      finalPathMetadata.ino !== handleMetadata.ino ||
      finalPathMetadata.size !== handleMetadata.size
    ) return 'unsafe'
    return bytes.equals(expectedBytes) ? 'exact' : 'mismatch'
  } finally {
    await handle.close()
  }
}

async function cleanupOwnedReplacement(path, successorBytes) {
  const state = await inspectExactLeaseFile(path, successorBytes)
  if (state === 'absent') return
  if (state !== 'exact') {
    throw new Error('Workflow child lease replacement cleanup refused an unowned or unsafe file.')
  }
  await unlink(path).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
}

function ownerBytes(owner) {
  return Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8')
}

function attachPublicationCleanupFailure(publicationError, cleanupError) {
  if (!(publicationError instanceof Error) || !Object.isExtensible(publicationError)) return
  const code = typeof cleanupError?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(cleanupError.code)
    ? cleanupError.code
    : 'UNKNOWN'
  Object.defineProperty(publicationError, 'publicationCleanupFailure', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      code,
      message: 'Workflow child lease replacement cleanup did not complete; the diagnostic file was retained.',
    }),
  })
}

function exactKeys(value, expected) {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
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
