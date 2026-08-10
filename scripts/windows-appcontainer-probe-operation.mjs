import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, opendir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'

export const APPCONTAINER_PROBE_OPERATION_SCHEMA_VERSION = 1
export const APPCONTAINER_PROBE_OPERATION_RECORD_KIND =
  'prime_continuim_appcontainer_probe_operation_reference_phase_v1'
export const APPCONTAINER_PROBE_OPERATION_MAX_RECORD_BYTES = 8 * 1024
export const APPCONTAINER_PROBE_OPERATION_MAX_DIRECTORY_ENTRIES = 32

export const APPCONTAINER_PROBE_OPERATION_PHASES = Object.freeze([
  'prepared',
  'admitted',
  'sandbox_created',
  'invocation_committed',
  'supervisor_published',
  'tree_retired',
  'gate_evidence_observed',
  'cleanup_complete',
  'settled',
])

export const APPCONTAINER_PROBE_OPERATION_FAULT_POINTS = Object.freeze([
  'after_temporary_open',
  'after_temporary_write',
  'after_temporary_sync',
  'after_temporary_close',
  'after_publish',
  'after_directory_sync',
  'before_invocation_effect',
  'before_record_final_path_check',
  'before_existing_sync_open',
  'before_existing_final_path_check',
])

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CORRELATION_ID = /^(?!0{32}$)[0-9a-f]{32}$/u
const SHA256 = /^(?!0{64}$)[0-9a-f]{64}$/u
const CONSERVATIVE_OPERATION_PATH = /^[\x20-\x7e]+$/u
const RECORD_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'operationId',
  'correlationId',
  'provenance',
  'revision',
  'phase',
  'evidenceSha256',
  'previousRecordSha256',
  'recordSha256',
])
const PROVENANCE_KEYS = Object.freeze([
  'installedCandidate',
  'nativeSupervisor',
  'probePayload',
  'nativeBuildManifest',
])
const CORRELATION_PROVENANCE_RECORD_KEYS = Object.freeze(['role', 'sha256', 'bytes'])
const NATIVE_PROVENANCE_RECORD_KEYS = Object.freeze(['role', 'sha256', 'bytes', 'machine'])
const TEST_ONLY_WINDOWS_REFERENCE_FENCE_KEY = '__testOnlyWindowsReferencePublicationFence'
const TEST_ONLY_WINDOWS_REFERENCE_FENCE_KIND =
  'prime_continuim_appcontainer_probe_operation_test_publication_fence_v1'
const OPEN_KEYS = Object.freeze([
  'hostPrivateOperationPath',
  'identity',
  'faultInjector',
  TEST_ONLY_WINDOWS_REFERENCE_FENCE_KEY,
])
const IDENTITY_KEYS = Object.freeze(['operationId', 'correlationId', 'provenance'])
const ADVANCE_KEYS = Object.freeze(['expectedRevision', 'phase', 'evidenceSha256'])
const INVOCATION_KEYS = Object.freeze(['expectedRevision', 'evidenceSha256'])
const RECONFIRM_KEYS = Object.freeze(['expectedRevision', 'confirmationSha256'])
const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_NATIVE_SUPERVISOR_BYTES = 64 * 1024 * 1024
const MAX_PROBE_PAYLOAD_BYTES = 64 * 1024 * 1024
const MAX_NATIVE_BUILD_MANIFEST_BYTES = 64 * 1024
const MAX_TEMPORARY_FILES = 16
const RECORD_NAMES = Object.freeze(
  APPCONTAINER_PROBE_OPERATION_PHASES.map((phase, index) => recordName(index + 1, phase)),
)
const RECORD_NAME_SET = new Set(RECORD_NAMES)
const PHASE_INDEX = new Map(APPCONTAINER_PROBE_OPERATION_PHASES.map((phase, index) => [phase, index]))

export class AppContainerProbeOperationError extends Error {
  constructor(code, message = code, options = undefined) {
    super(message, options)
    this.name = 'AppContainerProbeOperationError'
    this.code = code
  }
}

/**
 * Open one caller-owned, host-private journal directory.
 *
 * hostPrivateOperationPath must be distinct from and outside the disposable,
 * sandbox-visible operation, scratch, and tool roots. The host-private journal
 * must survive deletion of those roots so the reference state machine can
 * append cleanup_complete and settled afterward. This module deliberately does
 * not create or delete the journal directory or publish the final receipt; it
 * owns only its nine bounded phase names and ephemeral same-directory creates.
 */
export async function openAppContainerProbeOperationJournal(options) {
  const optionSnapshot = snapshotOpenOptions(options)
  const operationPath = validateOperationPath(optionSnapshot.hostPrivateOperationPath)
  const identity = validateIdentity(optionSnapshot.identity)
  if (
    process.platform === 'win32' &&
    optionSnapshot.testOnlyWindowsReferencePublicationFence === undefined
  ) {
    fail(
      'WINDOWS_REFERENCE_ONLY',
      'Windows journal initialization and phase publication are disabled until reviewed native durability and owner/lease/recovery fences exist',
    )
  }
  const journal = new AppContainerProbeOperationJournal(
    operationPath,
    identity,
    optionSnapshot.faultInjector,
    optionSnapshot.testOnlyWindowsReferencePublicationFence,
  )
  await journal.initialize()
  return journal
}

class AppContainerProbeOperationJournal {
  #operationPath
  #identity
  #faultInjector
  #testOnlyWindowsReferencePublicationFence
  #requiresReopen = false
  #preInvocationAuthorized = false

  constructor(operationPath, identity, faultInjector, testOnlyWindowsReferencePublicationFence) {
    this.#operationPath = operationPath
    this.#identity = identity
    this.#faultInjector = faultInjector
    this.#testOnlyWindowsReferencePublicationFence = testOnlyWindowsReferencePublicationFence
  }

  async initialize() {
    await this.#readStateInternal()
    // No open call carries operator authority across its boundary, including
    // an empty directory that may be the residue of a pre-publication crash.
    // Fresh and recovered coordinators must explicitly confirm in memory;
    // another crash or reopen loses that authority again.
    this.#preInvocationAuthorized = false
  }

  async readState() {
    return this.#readStateInternal()
  }

  async reconfirmPreInvocation(input) {
    this.#assertMutable()
    const request = snapshotAndValidateReconfirmation(input)
    const state = await this.#readStateInternal()
    if (
      state.revision >= 4 ||
      state.revision !== request.expectedRevision
    ) {
      fail(
        'RECONFIRMATION_NOT_APPLICABLE',
        'Pre-invocation confirmation requires the exact current empty, prepared, admitted, or sandbox-created revision',
      )
    }
    this.#preInvocationAuthorized = true
    return deepFreeze({
      operationId: this.#identity.operationId,
      revision: state.revision,
      confirmationSha256: request.confirmationSha256,
    })
  }

  async advance(input) {
    const request = snapshotAndValidateAdvance(input)
    if (request.phase === 'invocation_committed') {
      fail(
        'INVOCATION_API_REQUIRED',
        'invocation_committed can be created only by commitInvocation()',
      )
    }
    return this.#commitPhase(request, false)
  }

  async commitInvocation(input, invoke) {
    const request = snapshotAndValidateInvocation(input)
    if (typeof invoke !== 'function') {
      fail('INVOCATION_CALLBACK_INVALID', 'The invocation effect must be a function')
    }
    const committed = await this.#commitPhase({
      expectedRevision: request.expectedRevision,
      phase: 'invocation_committed',
      evidenceSha256: request.evidenceSha256,
    }, true)
    if (committed.replayed) {
      return deepFreeze({
        record: committed.record,
        replayed: true,
        invocation: 'suppressed_existing_commit',
        value: undefined,
      })
    }

    try {
      await this.#injectFault('before_invocation_effect', 'invocation_committed')
    } catch (cause) {
      this.#requiresReopen = true
      throw new AppContainerProbeOperationError(
        'INTERRUPTED_AFTER_INVOCATION_COMMIT',
        'The reference commitment is visible to the test coordinator; the callback is suppressed and recovery must reopen',
        { cause },
      )
    }

    try {
      const value = await invoke()
      return Object.freeze({
        record: committed.record,
        replayed: false,
        invocation: 'performed_after_commit',
        value,
      })
    } catch (cause) {
      this.#requiresReopen = true
      throw new AppContainerProbeOperationError(
        'INVOCATION_EFFECT_FAILED',
        'The source-reference callback failed; this coordinator will suppress it after reopen, without claiming durable no-relaunch',
        { cause },
      )
    }
  }

  async #commitPhase(request, invocationApi) {
    this.#assertMutable()
    const state = await this.#readStateInternal()
    const targetRevision = request.expectedRevision + 1

    if (targetRevision <= state.revision) {
      const existing = state.records[targetRevision - 1]
      const expected = createRecord(
        this.#identity,
        targetRevision,
        request.phase,
        request.evidenceSha256,
        targetRevision === 1 ? null : state.records[targetRevision - 2].recordSha256,
      )
      if (canonicalJson(existing) !== canonicalJson(expected)) {
        fail('CAS_CONFLICT', 'The requested revision already belongs to different immutable bytes')
      }
      return deepFreeze({ record: existing, replayed: true })
    }

    if (request.expectedRevision !== state.revision) {
      fail('CAS_CONFLICT', 'The expected revision is stale or ahead of the reference journal')
    }
    const expectedPhase = APPCONTAINER_PROBE_OPERATION_PHASES[state.revision]
    if (request.phase !== expectedPhase) {
      fail('PHASE_ORDER_INVALID', `The next reference phase must be ${expectedPhase ?? 'none'}`)
    }
    if ((request.phase === 'invocation_committed') !== invocationApi) {
      fail('INVOCATION_API_REQUIRED', 'The invocation commitment requires its dedicated effect boundary')
    }
    if (
      state.revision < 4 &&
      !this.#preInvocationAuthorized
    ) {
      fail(
        'RECONFIRMATION_REQUIRED',
        'A restarted pre-invocation operation requires fresh operator confirmation',
      )
    }

    const previousRecordSha256 = state.revision === 0
      ? null
      : state.records[state.revision - 1].recordSha256
    const record = createRecord(
      this.#identity,
      targetRevision,
      request.phase,
      request.evidenceSha256,
      previousRecordSha256,
    )

    let published
    try {
      published = await this.#publishRecord(record)
    } catch (error) {
      this.#requiresReopen = true
      throw error
    }
    if (published) return deepFreeze({ record, replayed: false })

    // Another coordinator won the fixed no-replace name. Only byte-for-byte
    // identity is an idempotent retry; every other collision is a CAS failure.
    let recovered
    try {
      recovered = await this.#readStateInternal()
    } catch (cause) {
      this.#requiresReopen = true
      throw new AppContainerProbeOperationError(
        'COMMIT_UNCERTAIN',
        'The no-replace winner could not be reconfirmed',
        { cause },
      )
    }
    const existing = recovered.records[targetRevision - 1]
    if (existing === undefined || canonicalJson(existing) !== canonicalJson(record)) {
      fail('CAS_CONFLICT', 'A concurrent coordinator committed different immutable bytes')
    }
    return deepFreeze({ record: existing, replayed: true })
  }

  async #publishRecord(record) {
    // This is an ordinary-workflow fail-closed exclusion, not an adversary-proof
    // boundary: the Vitest environment flag and private option key are visible
    // in source. No production caller can construct the seam through the typed
    // API, and future live use needs reviewed native durability plus a durable
    // owner/lease/recovery fence before this branch may be replaced.
    if (process.platform === 'win32' && this.#testOnlyWindowsReferencePublicationFence === undefined) {
      fail(
        'WINDOWS_REFERENCE_ONLY',
        'Windows phase publication is disabled until reviewed native durability and owner/lease/recovery fences exist',
      )
    }
    await assertPrivateOperationDirectory(this.#operationPath)
    const bytes = serializeRecord(record)
    const finalPath = join(this.#operationPath, recordName(record.revision, record.phase))
    const operationSlug = this.#identity.operationId.replaceAll('-', '')
    const temporaryName = `.pcao-tmp-${operationSlug}-${String(record.revision).padStart(2, '0')}-${process.pid}-${randomBytes(8).toString('hex')}.tmp`
    const temporaryPath = join(this.#operationPath, temporaryName)
    let handle
    let temporaryStat
    let linkAttempted = false
    let linked = false
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await this.#injectFault('after_temporary_open', record.phase)
      await handle.writeFile(bytes)
      await this.#injectFault('after_temporary_write', record.phase)
      await handle.sync()
      await this.#injectFault('after_temporary_sync', record.phase)
      temporaryStat = await handle.stat({ bigint: true })
      validateFreshPublicationFileStat(temporaryStat, bytes.byteLength)
      await handle.close()
      handle = undefined
      await this.#injectFault('after_temporary_close', record.phase)

      linkAttempted = true
      await link(temporaryPath, finalPath)
      linked = true
      await this.#injectFault('after_publish', record.phase)
      await rm(temporaryPath)
      if (process.platform === 'win32') {
        await runTestOnlyWindowsReferencePublicationFence(
          finalPath,
          this.#operationPath,
          temporaryStat,
          bytes,
          this.#testOnlyWindowsReferencePublicationFence,
        )
      } else {
        await syncDirectory(this.#operationPath)
      }
      await this.#injectFault('after_directory_sync', record.phase)
      return true
    } catch (cause) {
      if (handle !== undefined) await handle.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      if (linked) {
        throw new AppContainerProbeOperationError(
          'COMMIT_UNCERTAIN',
          'A reference phase name became visible but its caller did not receive publication confirmation',
          { cause },
        )
      }
      if (linkAttempted && isErrorCode(cause, 'EEXIST')) {
        try {
          await confirmExistingReferenceFileSync(
            finalPath,
            this.#operationPath,
            this.#identity.operationId,
            () => this.#injectFault('before_existing_sync_open', record.phase),
            () => this.#injectFault('before_existing_final_path_check', record.phase),
          )
          return false
        } catch (confirmationCause) {
          throw new AppContainerProbeOperationError(
            'COMMIT_UNCERTAIN',
            'An existing reference phase name could not be file-sync-confirmed',
            { cause: confirmationCause },
          )
        }
      }
      throw new AppContainerProbeOperationError(
        'INTERRUPTED_BEFORE_COMMIT',
        'The phase was interrupted before no-replace publication; operator policy must be reconfirmed',
        { cause },
      )
    }
  }

  async #readStateInternal() {
    await assertPrivateOperationDirectory(this.#operationPath)
    const entries = await inspectOperationDirectory(this.#operationPath, this.#identity.operationId)
    const records = []
    let gapSeen = false
    for (let index = 0; index < RECORD_NAMES.length; index += 1) {
      const name = RECORD_NAMES[index]
      if (!entries.has(name)) {
        gapSeen = true
        continue
      }
      if (gapSeen) fail('JOURNAL_INVALID', 'The operation journal contains a non-prefix phase')
      const record = await readAndValidateRecord(
        join(this.#operationPath, name),
        this.#identity,
        index + 1,
        APPCONTAINER_PROBE_OPERATION_PHASES[index],
        index === 0 ? null : records[index - 1].recordSha256,
        entries,
        this.#operationPath,
        () => this.#injectFault('before_record_final_path_check', APPCONTAINER_PROBE_OPERATION_PHASES[index]),
      )
      records.push(record)
    }
    await assertPrivateOperationDirectory(this.#operationPath)
    const revision = records.length
    const phases = records.map((record) => record.phase)
    const restartDisposition = revision === APPCONTAINER_PROBE_OPERATION_PHASES.length
      ? 'settled'
      : revision >= 4
        ? 'observe_retire_cleanup_only'
        : 'operator_reconfirmation_required'
    return deepFreeze({
      identity: this.#identity,
      revision,
      phases,
      finalPhase: revision === 0 ? null : phases[revision - 1],
      records,
      restartDisposition,
      operationMode: 'source_reference_only',
      invocationReplayPolicy: 'reference_only_requires_native_owner_lease_recovery_fence',
      finalReceiptPublication: 'external_host_no_replace_not_implemented',
      claims: {
        liveWindowsPhasePublication: false,
        durableNoRelaunch: false,
        nativeOwnerLeaseRecoveryFence: false,
        finalReceiptPublished: false,
      },
    })
  }

  #assertMutable() {
    if (this.#requiresReopen) {
      fail('JOURNAL_REOPEN_REQUIRED', 'A failed or uncertain boundary requires a new journal instance')
    }
  }

  async #injectFault(point, phase) {
    await this.#faultInjector?.(point, phase)
  }
}

function snapshotOpenOptions(options) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    fail('OPTIONS_INVALID', 'Operation journal options must be an object')
  }
  const prototype = Object.getPrototypeOf(options)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('OPTIONS_INVALID', 'Operation journal options must use a plain-data prototype')
  }
  const keys = Reflect.ownKeys(options)
  if (keys.some((key) => typeof key !== 'string') || keys.some((key) => !OPEN_KEYS.includes(key))) {
    fail('OPTIONS_INVALID', 'Operation journal options contain unexpected fields')
  }
  const snapshot = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      fail('OPTIONS_INVALID', 'Operation journal options must contain ordinary enumerable values')
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  if (!keys.includes('hostPrivateOperationPath') || !keys.includes('identity')) {
    fail('OPTIONS_INVALID', 'Operation journal options are incomplete')
  }
  if (snapshot.faultInjector !== undefined && typeof snapshot.faultInjector !== 'function') {
    fail('OPTIONS_INVALID', 'faultInjector must be a function when supplied')
  }
  const testOnlyWindowsReferencePublicationFence = snapshot[TEST_ONLY_WINDOWS_REFERENCE_FENCE_KEY]
  if (
    testOnlyWindowsReferencePublicationFence !== undefined &&
    (
      process.platform !== 'win32' ||
      process.env.VITEST !== 'true' ||
      typeof testOnlyWindowsReferencePublicationFence !== 'function'
    )
  ) {
    fail('OPTIONS_INVALID', 'The Windows reference publication fence is available only to the Vitest source harness')
  }
  return {
    hostPrivateOperationPath: snapshot.hostPrivateOperationPath,
    identity: snapshotPlainData(snapshot.identity, 'IDENTITY_INVALID'),
    faultInjector: snapshot.faultInjector,
    testOnlyWindowsReferencePublicationFence,
  }
}

function validateOperationPath(value) {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 4096 ||
    !CONSERVATIVE_OPERATION_PATH.test(value)
  ) {
    fail('PATH_CUSTODY_INVALID', 'The host-private operation path is invalid')
  }
  if (!isAbsolute(value) || normalize(value) !== resolve(value)) {
    fail('PATH_CUSTODY_INVALID', 'The host-private operation path must be absolute and canonical')
  }
  return value
}

function validateIdentity(value) {
  exactObject(value, IDENTITY_KEYS, 'IDENTITY_INVALID')
  if (!UUID_V4.test(value.operationId ?? '')) fail('IDENTITY_INVALID', 'operationId must be a lowercase UUID v4')
  if (!CORRELATION_ID.test(value.correlationId ?? '')) {
    fail('IDENTITY_INVALID', 'correlationId must be 32 nonzero lowercase hexadecimal characters')
  }
  exactObject(value.provenance, PROVENANCE_KEYS, 'IDENTITY_INVALID')
  const installedCandidate = validateCorrelationProvenanceRecord(
    value.provenance.installedCandidate,
    'installed_candidate_correlation',
    MAX_CANDIDATE_BYTES,
  )
  const nativeSupervisor = validateNativeProvenanceRecord(
    value.provenance.nativeSupervisor,
    'native_supervisor',
    MAX_NATIVE_SUPERVISOR_BYTES,
  )
  const probePayload = validateNativeProvenanceRecord(
    value.provenance.probePayload,
    'launch_target',
    MAX_PROBE_PAYLOAD_BYTES,
  )
  const nativeBuildManifest = validateNativeProvenanceRecord(
    value.provenance.nativeBuildManifest,
    'native_build_manifest',
    MAX_NATIVE_BUILD_MANIFEST_BYTES,
  )
  const provenance = { installedCandidate, nativeSupervisor, probePayload, nativeBuildManifest }
  if (new Set(PROVENANCE_KEYS.map((key) => provenance[key].sha256)).size !== PROVENANCE_KEYS.length) {
    fail('IDENTITY_INVALID', 'Every v3 provenance artifact must have a distinct digest')
  }
  return deepFreeze({
    operationId: value.operationId,
    correlationId: value.correlationId,
    provenance,
  })
}

function validateCorrelationProvenanceRecord(value, role, maxBytes) {
  exactObject(value, CORRELATION_PROVENANCE_RECORD_KEYS, 'IDENTITY_INVALID')
  if (value.role !== role) fail('IDENTITY_INVALID', 'Correlation provenance has the wrong role')
  if (!SHA256.test(value.sha256 ?? '')) fail('IDENTITY_INVALID', 'Provenance requires a SHA-256 digest')
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > maxBytes) {
    fail('IDENTITY_INVALID', 'Provenance byte length is outside its bound')
  }
  return deepFreeze({ role, sha256: value.sha256, bytes: value.bytes })
}

function validateNativeProvenanceRecord(value, role, maxBytes) {
  exactObject(value, NATIVE_PROVENANCE_RECORD_KEYS, 'IDENTITY_INVALID')
  if (value.role !== role || value.machine !== 'x64') {
    fail('IDENTITY_INVALID', 'Native provenance has the wrong role or machine')
  }
  if (!SHA256.test(value.sha256 ?? '')) fail('IDENTITY_INVALID', 'Provenance requires a SHA-256 digest')
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > maxBytes) {
    fail('IDENTITY_INVALID', 'Provenance byte length is outside its bound')
  }
  return deepFreeze({ role, sha256: value.sha256, bytes: value.bytes, machine: 'x64' })
}

function snapshotAndValidateAdvance(value) {
  const request = snapshotPlainData(value, 'REQUEST_INVALID')
  exactObject(request, ADVANCE_KEYS, 'REQUEST_INVALID')
  validateExpectedRevision(request.expectedRevision)
  if (!PHASE_INDEX.has(request.phase)) fail('REQUEST_INVALID', 'Unknown AppContainer operation phase')
  validateEvidenceSha256(request.evidenceSha256)
  return request
}

function snapshotAndValidateInvocation(value) {
  const request = snapshotPlainData(value, 'REQUEST_INVALID')
  exactObject(request, INVOCATION_KEYS, 'REQUEST_INVALID')
  validateExpectedRevision(request.expectedRevision)
  validateEvidenceSha256(request.evidenceSha256)
  return request
}

function snapshotAndValidateReconfirmation(value) {
  const request = snapshotPlainData(value, 'REQUEST_INVALID')
  exactObject(request, RECONFIRM_KEYS, 'REQUEST_INVALID')
  validateExpectedRevision(request.expectedRevision)
  validateEvidenceSha256(request.confirmationSha256)
  return request
}

function validateExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= APPCONTAINER_PROBE_OPERATION_PHASES.length) {
    fail('REQUEST_INVALID', 'expectedRevision is outside the operation journal bound')
  }
}

function validateEvidenceSha256(value) {
  if (!SHA256.test(value ?? '')) fail('REQUEST_INVALID', 'Phase evidence must be a SHA-256 digest')
}

function createRecord(identity, revision, phase, evidenceSha256, previousRecordSha256) {
  const body = {
    schemaVersion: APPCONTAINER_PROBE_OPERATION_SCHEMA_VERSION,
    kind: APPCONTAINER_PROBE_OPERATION_RECORD_KIND,
    operationId: identity.operationId,
    correlationId: identity.correlationId,
    provenance: identity.provenance,
    revision,
    phase,
    evidenceSha256,
    previousRecordSha256,
  }
  return deepFreeze({
    ...body,
    recordSha256: sha256(canonicalJson(body)),
  })
}

function serializeRecord(record) {
  const bytes = Buffer.from(`${canonicalJson(record)}\n`, 'utf8')
  if (bytes.byteLength < 2 || bytes.byteLength > APPCONTAINER_PROBE_OPERATION_MAX_RECORD_BYTES) {
    fail('JOURNAL_INVALID', 'An operation phase record exceeded its byte bound')
  }
  return bytes
}

async function readAndValidateRecord(
  path,
  identity,
  revision,
  phase,
  previousRecordSha256,
  entries,
  operationPath,
  beforeFinalPathCheck,
) {
  const physicalPath = await requireCanonicalFilePath(path, undefined, 'PATH_CUSTODY_INVALID')
  const before = await lstat(path, { bigint: true }).catch((cause) => {
    throw new AppContainerProbeOperationError('PATH_CUSTODY_INVALID', 'A phase record disappeared before open', { cause })
  })
  validateRecordFileStat(before, entries)
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const handle = await open(physicalPath, flags).catch((cause) => {
    throw new AppContainerProbeOperationError('PATH_CUSTODY_INVALID', 'A phase record could not be opened safely', { cause })
  })
  let bytes
  let opened
  try {
    opened = await handle.stat({ bigint: true })
    validateRecordFileStat(opened, entries)
    requireSameFileIdentity(before, opened)
    await assertPrivateOperationDirectory(operationPath)
    await requireCanonicalFilePath(path, physicalPath, 'PATH_CUSTODY_INVALID')
    bytes = await readExactBoundedFile(handle, opened.size)
    const afterRead = await handle.stat({ bigint: true })
    validateRecordFileStat(afterRead, entries)
    requireSameFileIdentity(opened, afterRead)
    if (opened.size !== afterRead.size || opened.mtimeNs !== afterRead.mtimeNs) {
      fail('JOURNAL_INVALID', 'A phase record changed while it was read')
    }
  } finally {
    await handle.close()
  }
  if (bytes.byteLength !== Number(opened.size)) fail('JOURNAL_INVALID', 'A phase record changed while it was read')
  await beforeFinalPathCheck()
  await assertPrivateOperationDirectory(operationPath)
  await requireCanonicalFilePath(path, physicalPath, 'PATH_CUSTODY_INVALID')
  const afterPath = await lstat(path, { bigint: true }).catch((cause) => {
    throw new AppContainerProbeOperationError('PATH_CUSTODY_INVALID', 'A phase record was replaced after read', { cause })
  })
  validateRecordFileStat(afterPath, entries)
  requireSameFileIdentity(opened, afterPath)
  if (opened.size !== afterPath.size || opened.mtimeNs !== afterPath.mtimeNs) {
    fail('JOURNAL_INVALID', 'A phase record changed after it was read')
  }
  const reread = await readStableFileAgain(path, physicalPath, opened, entries, operationPath)
  if (!bytes.equals(reread)) fail('JOURNAL_INVALID', 'A phase record changed between exact reads')
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new AppContainerProbeOperationError('JOURNAL_INVALID', 'A phase record is not UTF-8', { cause })
  }
  if (!text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) {
    fail('JOURNAL_INVALID', 'A phase record does not have one canonical line boundary')
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new AppContainerProbeOperationError('JOURNAL_INVALID', 'A phase record is not JSON', { cause })
  }
  validateRecordShape(value, identity, revision, phase, previousRecordSha256)
  if (`${canonicalJson(value)}\n` !== text) fail('JOURNAL_INVALID', 'A phase record is not canonical JSON')
  return deepFreeze(value)
}

function validateRecordShape(value, identity, revision, phase, previousRecordSha256) {
  exactObject(value, RECORD_KEYS, 'JOURNAL_INVALID')
  if (value.schemaVersion !== APPCONTAINER_PROBE_OPERATION_SCHEMA_VERSION) fail('JOURNAL_INVALID')
  if (value.kind !== APPCONTAINER_PROBE_OPERATION_RECORD_KIND) fail('JOURNAL_INVALID')
  if (
    value.operationId !== identity.operationId ||
    value.correlationId !== identity.correlationId ||
    canonicalJson(value.provenance) !== canonicalJson(identity.provenance)
  ) {
    fail('IDENTITY_COLLISION', 'The operation directory is bound to different identity bytes')
  }
  if (value.revision !== revision || value.phase !== phase) fail('JOURNAL_INVALID', 'Phase name and record disagree')
  if (!SHA256.test(value.evidenceSha256 ?? '')) fail('JOURNAL_INVALID')
  if (value.previousRecordSha256 !== null && !SHA256.test(value.previousRecordSha256 ?? '')) {
    fail('JOURNAL_INVALID', 'The predecessor digest must be nonzero SHA-256 or null')
  }
  if (value.previousRecordSha256 !== previousRecordSha256) fail('JOURNAL_INVALID', 'The phase hash chain is discontinuous')
  if (!SHA256.test(value.recordSha256 ?? '')) fail('JOURNAL_INVALID')
  const body = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    operationId: value.operationId,
    correlationId: value.correlationId,
    provenance: value.provenance,
    revision: value.revision,
    phase: value.phase,
    evidenceSha256: value.evidenceSha256,
    previousRecordSha256: value.previousRecordSha256,
  }
  if (sha256(canonicalJson(body)) !== value.recordSha256) {
    fail('JOURNAL_INVALID', 'The phase record digest does not match its canonical bytes')
  }
}

async function assertPrivateOperationDirectory(path) {
  const stat = await lstat(path).catch((cause) => {
    throw new AppContainerProbeOperationError(
      'PATH_CUSTODY_INVALID',
      'The caller-supplied host-private operation directory is unavailable',
      { cause },
    )
  })
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('PATH_CUSTODY_INVALID', 'The host-private operation path must be an unlinked directory')
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    fail('PATH_CUSTODY_INVALID', 'The host-private operation directory permits non-owner access')
  }
  const physical = await realpath(path).catch((cause) => {
    throw new AppContainerProbeOperationError('PATH_CUSTODY_INVALID', 'The operation directory cannot be resolved', { cause })
  })
  if (!sameCustodyPath(physical, path)) {
    fail('PATH_CUSTODY_INVALID', 'The operation path traverses a link or noncanonical alias')
  }
}

async function inspectOperationDirectory(path, operationId) {
  const names = await boundedDirectoryNames(path)
  const temporaryPattern = new RegExp(
    `^\\.pcao-tmp-${operationId.replaceAll('-', '')}-(\\d{2})-(\\d+)-[0-9a-f]{16}\\.tmp$`,
    'u',
  )
  const entries = new Map()
  let temporaryCount = 0
  for (const name of names) {
    if (name.length > 128) fail('PATH_CUSTODY_INVALID', 'An operation directory entry name exceeded its bound')
    const temporary = temporaryPattern.exec(name)
    if (!RECORD_NAME_SET.has(name) && temporary === null) {
      fail('PATH_CUSTODY_INVALID', 'The operation directory contains an unowned entry')
    }
    const entryPath = join(path, name)
    const stat = await lstat(entryPath, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('PATH_CUSTODY_INVALID', 'Operation journal custody rejects directories, links, and special files')
    }
    assertPrivateFileMode(stat)
    if (stat.size > BigInt(APPCONTAINER_PROBE_OPERATION_MAX_RECORD_BYTES)) {
      fail('PATH_CUSTODY_INVALID', 'An operation journal file exceeded its bound')
    }
    if (temporary !== null) {
      const revision = Number(temporary[1])
      const pid = Number(temporary[2])
      if (
        !Number.isSafeInteger(revision) || revision < 1 || revision > RECORD_NAMES.length ||
        !Number.isSafeInteger(pid) || pid < 1
      ) {
        fail('PATH_CUSTODY_INVALID', 'An operation temporary file name is invalid')
      }
      if (!isProcessAlive(pid)) {
        await rm(entryPath)
        continue
      }
      temporaryCount += 1
    }
    entries.set(name, stat)
  }
  if (temporaryCount > MAX_TEMPORARY_FILES) {
    fail('PATH_CUSTODY_INVALID', 'The operation directory exceeded its temporary-file custody bound')
  }
  return entries
}

async function boundedDirectoryNames(path) {
  const directory = await opendir(path)
  const names = []
  try {
    for await (const entry of directory) {
      names.push(entry.name)
      if (names.length > APPCONTAINER_PROBE_OPERATION_MAX_DIRECTORY_ENTRIES) {
        fail('PATH_CUSTODY_INVALID', 'The operation directory exceeded its entry bound')
      }
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  return names
}

function assertPrivateFileMode(stat) {
  if (process.platform !== 'win32' && (Number(stat.mode) & 0o077) !== 0) {
    fail('PATH_CUSTODY_INVALID', 'An operation journal file permits non-owner access')
  }
}

function assertOwnedLinkCount(stat, entries) {
  if (stat.nlink === 1 || stat.nlink === 1n) return
  if (stat.nlink !== 2 && stat.nlink !== 2n) {
    fail('PATH_CUSTODY_INVALID', 'A phase record has an unbounded hard-link count')
  }
  const matchingTemporary = [...entries.entries()].some(([name, temporaryStat]) =>
    name.startsWith('.pcao-tmp-') && temporaryStat.dev === stat.dev && temporaryStat.ino === stat.ino,
  )
  if (!matchingTemporary) fail('PATH_CUSTODY_INVALID', 'A phase record is hard-linked outside owned publication state')
}

async function runTestOnlyWindowsReferencePublicationFence(
  finalPath,
  operationPath,
  expectedStat,
  expectedBytes,
  fence,
) {
  if (typeof fence !== 'function' || process.env.VITEST !== 'true' || process.platform !== 'win32') {
    fail('WINDOWS_REFERENCE_ONLY', 'The source reference cannot provide a live Windows durability fence')
  }
  await readExactFreshPublishedFile(finalPath, operationPath, expectedStat, expectedBytes)
  const request = deepFreeze({
    kind: TEST_ONLY_WINDOWS_REFERENCE_FENCE_KIND,
    finalPath,
    expectedIdentity: {
      device: expectedStat.dev.toString(),
      inode: expectedStat.ino.toString(),
    },
    expectedBytes: expectedBytes.byteLength,
    expectedSha256: sha256(expectedBytes),
  })
  await fence(request)
  await readExactFreshPublishedFile(finalPath, operationPath, expectedStat, expectedBytes)
}

async function readExactFreshPublishedFile(path, operationPath, expectedStat, expectedBytes) {
  await assertPrivateOperationDirectory(operationPath)
  const physicalPath = await requireCanonicalFilePath(path, undefined, 'PATH_CUSTODY_INVALID')
  const before = await lstat(path, { bigint: true }).catch((cause) => {
    throw new AppContainerProbeOperationError(
      'PATH_CUSTODY_INVALID',
      'The freshly published reference record disappeared',
      { cause },
    )
  })
  validateFreshPublicationFileStat(before, expectedBytes.byteLength)
  requireSameFileIdentity(expectedStat, before)

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const handle = await open(physicalPath, flags).catch((cause) => {
    throw new AppContainerProbeOperationError(
      'PATH_CUSTODY_INVALID',
      'The freshly published reference record could not be reopened',
      { cause },
    )
  })
  let actualBytes
  let opened
  try {
    opened = await handle.stat({ bigint: true })
    validateFreshPublicationFileStat(opened, expectedBytes.byteLength)
    requireSameFileIdentity(expectedStat, opened)
    actualBytes = await readExactBoundedFile(handle, opened.size)
    const afterRead = await handle.stat({ bigint: true })
    validateFreshPublicationFileStat(afterRead, expectedBytes.byteLength)
    requireSameFileIdentity(opened, afterRead)
    if (opened.size !== afterRead.size || opened.mtimeNs !== afterRead.mtimeNs) {
      fail('JOURNAL_INVALID', 'The freshly published reference record changed during its exact read')
    }
  } finally {
    await handle.close()
  }
  await assertPrivateOperationDirectory(operationPath)
  await requireCanonicalFilePath(path, physicalPath, 'PATH_CUSTODY_INVALID')
  const afterPath = await lstat(path, { bigint: true })
  validateFreshPublicationFileStat(afterPath, expectedBytes.byteLength)
  requireSameFileIdentity(opened, afterPath)
  if (!actualBytes.equals(expectedBytes)) {
    fail('JOURNAL_INVALID', 'The freshly published reference record bytes do not match the intended commit')
  }
}

function validateFreshPublicationFileStat(stat, expectedBytes) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('PATH_CUSTODY_INVALID', 'A fresh reference publication is not a regular unlinked file')
  }
  if (stat.dev === 0 || stat.dev === 0n || stat.ino === 0 || stat.ino === 0n) {
    fail('PATH_CUSTODY_INVALID', 'A fresh reference publication has no stable file identity')
  }
  if (stat.nlink !== 1 && stat.nlink !== 1n) {
    fail('PATH_CUSTODY_INVALID', 'A fresh reference publication has an unexpected hard-link count')
  }
  if (stat.size !== expectedBytes && stat.size !== BigInt(expectedBytes)) {
    fail('PATH_CUSTODY_INVALID', 'A fresh reference publication has the wrong byte length')
  }
  assertPrivateFileMode(stat)
}

async function confirmExistingReferenceFileSync(
  path,
  directoryPath,
  operationId,
  beforeSyncOpen,
  beforeFinalPathCheck,
) {
  await assertPrivateOperationDirectory(directoryPath)
  const entries = await inspectOperationDirectory(directoryPath, operationId)
  const physicalPath = await requireCanonicalFilePath(path, undefined, 'PATH_CUSTODY_INVALID')
  const before = await lstat(path, { bigint: true })
  validateRecordFileStat(before, entries)
  const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const readHandle = await open(physicalPath, readFlags)
  let firstBytes
  let opened
  try {
    opened = await readHandle.stat({ bigint: true })
    validateRecordFileStat(opened, entries)
    requireSameFileIdentity(before, opened)
    await requireCanonicalFilePath(path, physicalPath, 'PATH_CUSTODY_INVALID')
    firstBytes = await readExactBoundedFile(readHandle, opened.size)
    const afterRead = await readHandle.stat({ bigint: true })
    validateRecordFileStat(afterRead, entries)
    requireSameFileIdentity(opened, afterRead)
    if (opened.size !== afterRead.size || opened.mtimeNs !== afterRead.mtimeNs) {
      fail('JOURNAL_INVALID', 'An existing phase record changed during confirmation')
    }
  } finally {
    await readHandle.close()
  }

  await assertPrivateOperationDirectory(directoryPath)
  await requireCanonicalFilePath(path, physicalPath, 'PATH_CUSTODY_INVALID')
  await beforeSyncOpen()
  const writeFlags = constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)
  const syncHandle = await open(physicalPath, writeFlags)
  try {
    const syncOpened = await syncHandle.stat({ bigint: true })
    validateRecordFileStat(syncOpened, entries)
    requireSameFileIdentity(opened, syncOpened)
    if (opened.size !== syncOpened.size || opened.mtimeNs !== syncOpened.mtimeNs) {
      fail('JOURNAL_INVALID', 'An existing phase record changed before reference file sync')
    }
    // The writable handle is synced only after exact inode identity is proven;
    // opening a swapped path cannot cause an outside inode to be flushed.
    await syncHandle.sync()
    const afterSync = await syncHandle.stat({ bigint: true })
    validateRecordFileStat(afterSync, entries)
    requireSameFileIdentity(opened, afterSync)
    if (opened.size !== afterSync.size || opened.mtimeNs !== afterSync.mtimeNs) {
      fail('JOURNAL_INVALID', 'An existing phase record changed during reference file sync')
    }
  } finally {
    await syncHandle.close()
  }
  await syncDirectory(directoryPath)
  await beforeFinalPathCheck()
  await assertPrivateOperationDirectory(directoryPath)
  await requireCanonicalFilePath(path, physicalPath, 'PATH_CUSTODY_INVALID')
  const afterPath = await lstat(path, { bigint: true })
  validateRecordFileStat(afterPath, entries)
  requireSameFileIdentity(opened, afterPath)
  const secondBytes = await readStableFileAgain(path, physicalPath, opened, entries, directoryPath)
  if (!firstBytes.equals(secondBytes)) {
    fail('JOURNAL_INVALID', 'An existing phase record changed between file-sync confirmation reads')
  }
}

async function readStableFileAgain(path, physicalPath, expectedStat, entries, operationPath) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const handle = await open(physicalPath, flags)
  let bytes
  try {
    const opened = await handle.stat({ bigint: true })
    validateRecordFileStat(opened, entries)
    requireSameFileIdentity(expectedStat, opened)
    if (expectedStat.size !== opened.size || expectedStat.mtimeNs !== opened.mtimeNs) {
      fail('JOURNAL_INVALID', 'A phase record changed before its confirmation read')
    }
    bytes = await readExactBoundedFile(handle, opened.size)
    const afterRead = await handle.stat({ bigint: true })
    validateRecordFileStat(afterRead, entries)
    requireSameFileIdentity(opened, afterRead)
    if (opened.size !== afterRead.size || opened.mtimeNs !== afterRead.mtimeNs) {
      fail('JOURNAL_INVALID', 'A phase record changed during its confirmation read')
    }
  } finally {
    await handle.close()
  }
  await assertPrivateOperationDirectory(operationPath)
  await requireCanonicalFilePath(path, physicalPath, 'PATH_CUSTODY_INVALID')
  const finalPathStat = await lstat(path, { bigint: true })
  validateRecordFileStat(finalPathStat, entries)
  requireSameFileIdentity(expectedStat, finalPathStat)
  return bytes
}

async function readExactBoundedFile(handle, expectedSize) {
  const expectedBytes = Number(expectedSize)
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 2 ||
    expectedBytes > APPCONTAINER_PROBE_OPERATION_MAX_RECORD_BYTES
  ) {
    fail('PATH_CUSTODY_INVALID', 'A phase record size is outside its bound')
  }
  const bytes = Buffer.alloc(expectedBytes + 1)
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset !== expectedBytes) fail('JOURNAL_INVALID', 'A phase record changed while it was read')
  return bytes.subarray(0, offset)
}

function validateRecordFileStat(stat, entries) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('PATH_CUSTODY_INVALID', 'A phase record is not a regular unlinked file')
  }
  if (stat.dev === 0 || stat.dev === 0n || stat.ino === 0 || stat.ino === 0n) {
    fail('PATH_CUSTODY_INVALID', 'A phase record does not expose stable file identity')
  }
  if (
    stat.size < 2 || stat.size < 2n ||
    stat.size > APPCONTAINER_PROBE_OPERATION_MAX_RECORD_BYTES ||
    stat.size > BigInt(APPCONTAINER_PROBE_OPERATION_MAX_RECORD_BYTES)
  ) {
    fail('PATH_CUSTODY_INVALID', 'A phase record is outside its byte bound')
  }
  assertPrivateFileMode(stat)
  assertOwnedLinkCount(stat, entries)
}

function requireSameFileIdentity(left, right) {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    fail('PATH_CUSTODY_INVALID', 'A phase record identity changed')
  }
}

async function requireCanonicalFilePath(path, expectedPhysicalPath, code) {
  const currentPhysicalPath = await realpath(path).catch((cause) => {
    throw new AppContainerProbeOperationError(code, 'A phase record path cannot be resolved', { cause })
  })
  if (
    !sameCustodyPath(path, currentPhysicalPath) ||
    (expectedPhysicalPath !== undefined && !sameCustodyPath(expectedPhysicalPath, currentPhysicalPath))
  ) {
    fail(code, 'A phase record path traverses or became a link')
  }
  return currentPhysicalPath
}

async function syncDirectory(path) {
  // Node does not expose portable Windows directory fsync. The complete file
  // is flushed before the atomic hard-link publication; POSIX also flushes the
  // containing directory entry here.
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function snapshotPlainData(value, code, depth = 0) {
  if (depth > 8) fail(code, 'Input nesting exceeded its bound')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail(code, 'Only safe integer input is accepted')
    return value
  }
  if (typeof value !== 'object' || Array.isArray(value)) fail(code, 'Input must contain ordinary data objects')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(code, 'Input prototype is not plain data')
  const keys = Reflect.ownKeys(value)
  if (keys.length > 32 || keys.some((key) => typeof key !== 'string')) fail(code, 'Input keys exceeded their bound')
  const output = {}
  for (const key of keys) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail(code, 'Prototype-shaped input keys are forbidden')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      fail(code, 'Input must not contain accessors or hidden values')
    }
    output[key] = snapshotPlainData(descriptor.value, code, depth + 1)
  }
  return output
}

function exactObject(value, keys, code) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(code)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code)
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('JOURNAL_INVALID', 'Canonical records accept only safe integers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') fail('JOURNAL_INVALID', 'Canonical records contain unsupported data')
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function recordName(revision, phase) {
  return `${String(revision).padStart(2, '0')}-${phase}.json`
}

function sameCustodyPath(left, right) {
  const normalizedLeft = normalize(resolve(left))
  const normalizedRight = normalize(resolve(right))
  if (
    !CONSERVATIVE_OPERATION_PATH.test(normalizedLeft) ||
    !CONSERVATIVE_OPERATION_PATH.test(normalizedRight)
  ) {
    return false
  }
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isErrorCode(error, 'ESRCH')
  }
}

function isErrorCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code
}

function fail(code, message = code) {
  throw new AppContainerProbeOperationError(code, message)
}
