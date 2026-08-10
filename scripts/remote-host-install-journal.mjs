import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  link,
  lstat,
  open,
  opendir,
  realpath,
  unlink,
} from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { isDeepStrictEqual, types as utilTypes } from 'node:util'
import {
  canonicalRemoteHostInstallOperationJson,
  createRemoteHostInstallOperation,
  recoverRemoteHostInstallOperation,
  reduceRemoteHostInstallOperation,
  validateRemoteHostInstallAdmission,
  validateRemoteHostInstallOperation,
} from './remote-host-install-operation.mjs'

export const REMOTE_HOST_INSTALL_JOURNAL_SCHEMA_VERSION = 1
export const REMOTE_HOST_INSTALL_JOURNAL_KIND = 'prime_continuim_remote_host_install_journal_state_v1'
export const REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORD_BYTES = 8 * 1024
export const REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORDS = 9
export const REMOTE_HOST_INSTALL_JOURNAL_FAULT_POINTS = Object.freeze([
  'after_temp_create',
  'after_temp_write',
  'after_temp_stat',
  'after_temp_file_sync',
  'after_temp_close',
  'after_no_replace_link',
  'after_publish_parent_sync',
  'after_temp_unlink',
  'after_cleanup_parent_sync',
  'after_final_open',
  'after_final_verify',
  'after_final_file_sync',
  'after_final_close',
  'after_final_parent_sync',
  'after_full_rescan',
  'before_append_resolve',
])
export const REMOTE_HOST_INSTALL_JOURNAL_CLAIM_KEYS = Object.freeze([
  'powerLossDurability',
  'windowsProductionDurability',
  'hostileSameUserProtection',
  'multiProcessCustody',
  'liveRemoteInstall',
  'productIntegration',
])

// Deliberately absent from the public declaration. This source-visible reference only
// makes the publication mechanics reachable under Vitest on win32; it is not a trust
// boundary or a production durability override.
export const __REMOTE_HOST_INSTALL_VITEST_ONLY_WINDOWS_REFERENCE_FENCE = Object.freeze(
  Object.create(null),
)

const OPEN_REQUIRED_KEYS = Object.freeze(['journalDirectory', 'identity'])
const OPEN_OPTIONAL_KEYS = Object.freeze([
  'faultInjector',
  '__vitestWindowsReferenceFence',
])
const INITIALIZE_KEYS = Object.freeze(['evidenceSha256'])
const APPEND_KEYS = Object.freeze([
  'expectedRevision',
  'expectedRecordSha256',
  'phase',
  'evidenceSha256',
])
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/u
const RECORD_NAME = /^r([0-9]{4})\.json$/u
const CLAIMS = deepFreeze(Object.fromEntries(
  REMOTE_HOST_INSTALL_JOURNAL_CLAIM_KEYS.map((key) => [key, false]),
))

export class RemoteHostInstallJournalError extends Error {
  constructor(code = 'remote_host_install_journal_invalid', message = code) {
    super(message)
    this.name = 'RemoteHostInstallJournalError'
    this.code = code
  }
}

export async function openRemoteHostInstallJournal(optionsInput) {
  const options = validateOpenOptions(optionsInput)
  assertSupportedPlatform(options.testFence)

  let journalDirectory
  let records
  try {
    journalDirectory = await validateJournalDirectory(options.journalDirectory)
    records = await scanJournal(journalDirectory, options.identity)
    if (records.length > 0) {
      records = await reconfirmExistingJournal(
        journalDirectory,
        options.identity,
        records,
        options.testFence,
      )
    }
  } catch (error) {
    throw sanitizedError(error, 'journal_open_failed')
  }

  let currentRecords = records
  let reopenRequired = false
  let tail = Promise.resolve()

  const serialized = (operation) => {
    const result = tail.then(async () => {
      if (reopenRequired) fail('journal_reopen_required')
      return operation()
    })
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  const journal = {
    readState() {
      return serialized(async () => {
        try {
          currentRecords = await scanJournal(journalDirectory, options.identity)
          return createJournalState(currentRecords)
        } catch (error) {
          reopenRequired = true
          throw sanitizedError(error, 'journal_scan_failed')
        }
      })
    },

    initialize(input) {
      return serialized(async () => {
        const request = validateInitialize(input)
        try {
          currentRecords = await scanJournal(journalDirectory, options.identity)
          if (currentRecords.length !== 0) fail('journal_not_empty')
          const planned = createRemoteHostInstallOperation(options.identity)
          if (request.evidenceSha256 !== null) fail('journal_initial_evidence_invalid')
          const result = await publishRecord({
            journalDirectory,
            identity: options.identity,
            existingRecords: currentRecords,
            record: planned,
            faultInjector: options.faultInjector,
            testFence: options.testFence,
          })
          currentRecords = result.records
          return deepFreeze({ record: result.record, effectAuthority: null })
        } catch (error) {
          reopenRequired = true
          throw sanitizedError(error, 'journal_publication_uncertain')
        }
      })
    },

    append(input) {
      return serialized(async () => {
        const request = validateAppend(input)
        try {
          currentRecords = await scanJournal(journalDirectory, options.identity)
          if (currentRecords.length === 0) fail('journal_uninitialized')
          const current = currentRecords.at(-1)
          const reduced = reduceRemoteHostInstallOperation(current, request)
          const result = await publishRecord({
            journalDirectory,
            identity: options.identity,
            existingRecords: currentRecords,
            record: reduced.record,
            faultInjector: options.faultInjector,
            testFence: options.testFence,
          })
          currentRecords = result.records
          return deepFreeze({ record: result.record, effectAuthority: null })
        } catch (error) {
          reopenRequired = true
          throw sanitizedError(error, 'journal_publication_uncertain')
        }
      })
    },
  }

  return Object.freeze(journal)
}

async function publishRecord({
  journalDirectory,
  identity,
  existingRecords,
  record,
  faultInjector,
  testFence,
}) {
  if (record.revision !== existingRecords.length || record.revision >= REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORDS) {
    fail('journal_revision_invalid')
  }
  const bytes = Buffer.from(`${canonicalRemoteHostInstallOperationJson(record)}\n`, 'utf8')
  if (bytes.byteLength < 2 || bytes.byteLength > REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORD_BYTES) {
    fail('journal_record_oversize')
  }

  const finalName = recordFileName(record.revision)
  const finalPath = join(journalDirectory, finalName)
  const stagePath = join(journalDirectory, `.stage-${randomBytes(16).toString('hex')}`)
  let stageHandle
  let stageIdentity

  try {
    stageHandle = await open(stagePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600)
    injectFault(faultInjector, 'after_temp_create')
    await writeAll(stageHandle, bytes)
    injectFault(faultInjector, 'after_temp_write')
    stageIdentity = await validateOpenFileStat(await stageHandle.stat({ bigint: true }), bytes.byteLength)
    injectFault(faultInjector, 'after_temp_stat')
    await stageHandle.sync()
    injectFault(faultInjector, 'after_temp_file_sync')
    await stageHandle.close()
    stageHandle = undefined
    injectFault(faultInjector, 'after_temp_close')

    try {
      await link(stagePath, finalPath)
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) {
        await removeDefiniteLosingStage(stagePath, journalDirectory, testFence)
        fail('journal_cas_conflict')
      }
      throw error
    }
    injectFault(faultInjector, 'after_no_replace_link')
    await syncParentDirectory(journalDirectory, testFence)
    injectFault(faultInjector, 'after_publish_parent_sync')
    await unlink(stagePath)
    injectFault(faultInjector, 'after_temp_unlink')
    await syncParentDirectory(journalDirectory, testFence)
    injectFault(faultInjector, 'after_cleanup_parent_sync')

    const verified = await openAndVerifyRecordFile(finalPath, finalName, true)
    try {
      injectFault(faultInjector, 'after_final_open')
      if (
        verified.stat.dev !== stageIdentity.dev ||
        verified.stat.ino !== stageIdentity.ino ||
        verified.record.recordSha256 !== record.recordSha256
      ) fail('journal_publication_identity_mismatch')
      injectFault(faultInjector, 'after_final_verify')
      await verified.handle.sync()
      injectFault(faultInjector, 'after_final_file_sync')
    } finally {
      try {
        await verified.handle.close()
      } catch {
        fail('journal_final_close_failed')
      }
    }
    injectFault(faultInjector, 'after_final_close')
    await syncParentDirectory(journalDirectory, testFence)
    injectFault(faultInjector, 'after_final_parent_sync')

    const rescanned = await scanJournal(journalDirectory, identity)
    if (
      rescanned.length !== record.revision + 1 ||
      rescanned.at(-1)?.recordSha256 !== record.recordSha256
    ) fail('journal_concurrent_change')
    injectFault(faultInjector, 'after_full_rescan')
    injectFault(faultInjector, 'before_append_resolve')
    return { record: rescanned.at(-1), records: rescanned }
  } finally {
    if (stageHandle !== undefined) {
      try {
        await stageHandle.close()
      } catch {
        // The enclosing publication is already uncertain and remains fail closed.
      }
    }
  }
}

async function removeDefiniteLosingStage(stagePath, journalDirectory, testFence) {
  try {
    await unlink(stagePath)
    await syncParentDirectory(journalDirectory, testFence)
  } catch {
    fail('journal_publication_uncertain')
  }
}

async function reconfirmExistingJournal(journalDirectory, identity, records, testFence) {
  const current = records.at(-1)
  const finalName = recordFileName(current.revision)
  const verified = await openAndVerifyRecordFile(join(journalDirectory, finalName), finalName, true)
  try {
    if (verified.record.recordSha256 !== current.recordSha256) fail('journal_concurrent_change')
    await verified.handle.sync()
  } finally {
    try {
      await verified.handle.close()
    } catch {
      fail('journal_reconfirmation_failed')
    }
  }
  await syncParentDirectory(journalDirectory, testFence)
  const rescanned = await scanJournal(journalDirectory, identity)
  if (
    rescanned.length !== records.length ||
    rescanned.at(-1)?.recordSha256 !== current.recordSha256
  ) fail('journal_concurrent_change')
  return rescanned
}

async function scanJournal(journalDirectory, identity) {
  await validateJournalDirectory(journalDirectory)
  const names = []
  let directory
  try {
    directory = await opendir(journalDirectory)
    for await (const entry of directory) {
      if (names.length >= REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORDS) fail('journal_entry_limit_exceeded')
      if (!entry.isFile() || !RECORD_NAME.test(entry.name)) fail('journal_unknown_entry')
      names.push(entry.name)
    }
  } catch (error) {
    throw sanitizedError(error, 'journal_enumeration_failed')
  }

  names.sort()
  const records = []
  for (let revision = 0; revision < names.length; revision += 1) {
    const expectedName = recordFileName(revision)
    if (names[revision] !== expectedName) fail('journal_revision_gap')
    const verified = await openAndVerifyRecordFile(join(journalDirectory, expectedName), expectedName, false)
    records.push(verified.record)
  }

  reconstructChain(identity, records)
  return deepFreeze(records)
}

function reconstructChain(identity, records) {
  if (records.length === 0) return
  let expected
  try {
    expected = createRemoteHostInstallOperation(identity)
  } catch {
    fail('journal_identity_invalid')
  }
  assertExactRecord(records[0], expected)
  for (let index = 1; index < records.length; index += 1) {
    const candidate = records[index]
    try {
      expected = reduceRemoteHostInstallOperation(expected, {
        expectedRevision: expected.revision,
        expectedRecordSha256: expected.recordSha256,
        phase: candidate.phase,
        evidenceSha256: candidate.evidenceSha256,
      }).record
    } catch {
      fail('journal_chain_invalid')
    }
    assertExactRecord(candidate, expected)
  }
}

function assertExactRecord(actual, expected) {
  let actualJson
  let expectedJson
  try {
    actualJson = canonicalRemoteHostInstallOperationJson(actual)
    expectedJson = canonicalRemoteHostInstallOperationJson(expected)
  } catch {
    fail('journal_record_invalid')
  }
  if (actualJson !== expectedJson) fail('journal_chain_invalid')
}

async function openAndVerifyRecordFile(filePath, expectedName, keepOpen) {
  let handle
  let closeRequired = true
  try {
    const access = keepOpen ? fsConstants.O_RDWR : fsConstants.O_RDONLY
    const flags = access | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW)
    handle = await open(filePath, flags)
    const before = await validateOpenFileStat(await handle.stat({ bigint: true }))
    if (before.size < 2n || before.size > BigInt(REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORD_BYTES)) {
      fail('journal_record_size_invalid')
    }
    const bytes = await readBoundedRecordBytes(handle)
    if (BigInt(bytes.byteLength) !== before.size) fail('journal_record_changed')
    const after = await validateOpenFileStat(await handle.stat({ bigint: true }), before.size)
    if (before.dev !== after.dev || before.ino !== after.ino) fail('journal_record_changed')
    const pathStat = await validateOpenFileStat(await lstat(filePath, { bigint: true }), before.size)
    if (pathStat.dev !== after.dev || pathStat.ino !== after.ino) fail('journal_record_changed')
    const record = parseRecordBytes(bytes)
    if (recordFileName(record.revision) !== expectedName) fail('journal_filename_mismatch')
    if (keepOpen) {
      closeRequired = false
      return { handle, stat: after, record }
    }
    await handle.close()
    closeRequired = false
    return { stat: after, record }
  } catch (error) {
    throw sanitizedError(error, 'journal_record_invalid')
  } finally {
    if (closeRequired && handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The fixed outer error remains sufficient and path-free.
      }
    }
  }
}

function parseRecordBytes(bytes) {
  if (bytes.byteLength < 2 || bytes.byteLength > REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORD_BYTES) {
    fail('journal_record_size_invalid')
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('journal_record_utf8_invalid')
  }
  if (!text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) {
    fail('journal_record_framing_invalid')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('journal_record_json_invalid')
  }
  let record
  try {
    record = validateRemoteHostInstallOperation(parsed)
    if (`${canonicalRemoteHostInstallOperationJson(record)}\n` !== text) {
      fail('journal_record_not_canonical')
    }
  } catch (error) {
    throw sanitizedError(error, 'journal_record_invalid')
  }
  return record
}

async function validateJournalDirectory(input) {
  const path = validateJournalPath(input)
  let stat
  let canonical
  try {
    stat = await lstat(path, { bigint: true })
    canonical = await realpath(path)
  } catch {
    fail('journal_directory_invalid')
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('journal_directory_invalid')
  const expected = resolve(path)
  const actual = resolve(canonical)
  if (process.platform === 'win32') {
    if (actual.toLowerCase() !== expected.toLowerCase()) fail('journal_directory_not_canonical')
  } else if (actual !== expected) {
    fail('journal_directory_not_canonical')
  }
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o777n) !== 0o700n) fail('journal_directory_permissions_invalid')
    if (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) {
      fail('journal_directory_owner_invalid')
    }
  }
  return actual
}

function validateJournalPath(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 4096 ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    normalize(value) !== value
  ) fail('journal_directory_path_invalid')
  return value
}

async function validateOpenFileStat(stat, expectedSize) {
  if (!stat.isFile() || stat.isSymbolicLink?.() || stat.nlink !== 1n) fail('journal_record_link_invalid')
  if (
    expectedSize !== undefined &&
    stat.size !== (typeof expectedSize === 'bigint' ? expectedSize : BigInt(expectedSize))
  ) fail('journal_record_size_invalid')
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o777n) !== 0o600n) fail('journal_record_permissions_invalid')
    if (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) {
      fail('journal_record_owner_invalid')
    }
  }
  return stat
}

async function syncParentDirectory(journalDirectory, testFence) {
  if (process.platform === 'win32') {
    if (
      process.env.VITEST !== 'true' ||
      testFence !== __REMOTE_HOST_INSTALL_VITEST_ONLY_WINDOWS_REFERENCE_FENCE
    ) fail('journal_platform_unsupported')
    // Reference mechanics only. Exact rescans surround these modeled barriers.
    await validateJournalDirectory(journalDirectory)
    return
  }
  let handle
  try {
    handle = await open(journalDirectory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch {
    fail('journal_parent_sync_failed')
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // The parent sync already fails closed.
      }
    }
  }
}

function validateOpenOptions(input) {
  const values = exactDescriptorObject(input, OPEN_REQUIRED_KEYS, OPEN_OPTIONAL_KEYS, 'journal_options_invalid')
  let identity
  try {
    identity = validateRemoteHostInstallAdmission(values.identity)
  } catch {
    fail('journal_identity_invalid')
  }
  const faultInjector = values.faultInjector
  if (faultInjector !== undefined && (typeof faultInjector !== 'function' || utilTypes.isProxy(faultInjector))) {
    fail('journal_fault_injector_invalid')
  }
  return {
    journalDirectory: validateJournalPath(values.journalDirectory),
    identity,
    faultInjector,
    testFence: values.__vitestWindowsReferenceFence,
  }
}

function validateInitialize(input) {
  const values = exactDescriptorObject(input, INITIALIZE_KEYS, [], 'journal_initialize_invalid')
  if (values.evidenceSha256 !== null) fail('journal_initial_evidence_invalid')
  return values
}

function validateAppend(input) {
  const values = exactDescriptorObject(input, APPEND_KEYS, [], 'journal_append_invalid')
  if (!Number.isSafeInteger(values.expectedRevision) || values.expectedRevision < 0) {
    fail('journal_expected_revision_invalid')
  }
  requireSha256(values.expectedRecordSha256, 'journal_expected_digest_invalid')
  if (typeof values.phase !== 'string') fail('journal_phase_invalid')
  requireSha256(values.evidenceSha256, 'journal_evidence_invalid')
  return values
}

function exactDescriptorObject(input, requiredKeys, optionalKeys, code) {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    utilTypes.isProxy(input)
  ) fail(code)
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) fail(code)
  const keys = Reflect.ownKeys(input)
  if (keys.some((key) => typeof key !== 'string')) fail(code)
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  if (
    requiredKeys.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) fail(code)
  const values = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) fail(code)
    values[key] = descriptor.value
  }
  return values
}

function createJournalState(records) {
  const currentRecord = records.at(-1) ?? null
  let disposition = 'empty'
  let statusOnly = false
  if (currentRecord !== null) {
    const recovery = recoverRemoteHostInstallOperation(currentRecord)
    disposition = recovery.disposition
    statusOnly = recovery.statusOnly
  }
  return deepFreeze({
    schemaVersion: REMOTE_HOST_INSTALL_JOURNAL_SCHEMA_VERSION,
    kind: REMOTE_HOST_INSTALL_JOURNAL_KIND,
    records: [...records],
    currentRecord,
    disposition,
    statusOnly,
    effectAuthority: null,
    claims: { ...CLAIMS },
  })
}

function assertSupportedPlatform(testFence) {
  if (process.platform === 'win32') {
    if (
      process.env.VITEST !== 'true' ||
      testFence !== __REMOTE_HOST_INSTALL_VITEST_ONLY_WINDOWS_REFERENCE_FENCE
    ) fail('journal_platform_unsupported')
    return
  }
  if (testFence !== undefined) fail('journal_test_fence_invalid')
  if (process.platform !== 'linux' && process.platform !== 'darwin') fail('journal_platform_unsupported')
}

function injectFault(faultInjector, point) {
  if (faultInjector === undefined) return
  try {
    const result = faultInjector(point)
    if (result !== undefined) fail('journal_fault_injector_invalid')
  } catch {
    fail('journal_fault_injected')
  }
}

async function writeAll(handle, bytes) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1) fail('journal_write_failed')
    offset += result.bytesWritten
  }
}

async function readBoundedRecordBytes(handle) {
  const buffer = Buffer.alloc(REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORD_BYTES + 1)
  let offset = 0
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
    if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0) fail('journal_read_failed')
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  if (offset > REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORD_BYTES) fail('journal_record_size_invalid')
  return buffer.subarray(0, offset)
}

function recordFileName(revision) {
  return `r${String(revision).padStart(4, '0')}.json`
}

function requireSha256(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code)
}

function isErrorCode(error, code) {
  return error !== null && typeof error === 'object' && error.code === code
}

function sanitizedError(error, fallbackCode) {
  if (error instanceof RemoteHostInstallJournalError) return error
  return new RemoteHostInstallJournalError(fallbackCode)
}

function fail(code) {
  throw new RemoteHostInstallJournalError(code)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
