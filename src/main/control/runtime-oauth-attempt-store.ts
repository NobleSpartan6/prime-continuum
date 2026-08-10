import { mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  parseRuntimeOAuthAttemptTerminalV1,
  parseRuntimeOAuthAttemptV1,
  type RuntimeOAuthAttemptTerminalV1,
  type RuntimeOAuthAttemptV1,
} from '../../shared/runtime-oauth-attempt'
import { ControlError } from './errors'
import { AtomicJsonStore, type AtomicJsonStoreOptions } from './storage'

export const RUNTIME_OAUTH_DESKTOP_ATTEMPT_STORE_VERSION = 1 as const
export const RUNTIME_OAUTH_DESKTOP_ATTEMPT_LIMIT = 128
export const RUNTIME_OAUTH_DESKTOP_ATTEMPT_MAX_BYTES = 512 * 1024
export const RUNTIME_OAUTH_DESKTOP_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

export const RUNTIME_OAUTH_DESKTOP_PHASES = Object.freeze([
  'prepared',
  'start_dispatching',
  'host_admitted',
  'browser_dispatching',
  'browser_opened',
  'observing',
  'cancel_dispatching',
  'recovery_required',
  'completed',
  'cancelled',
  'failed',
  'outcome_unknown',
] as const)

export const RUNTIME_OAUTH_HOST_DURABLE_PHASES = Object.freeze([
  'prepared',
  'login_dispatching',
  'credentials_ready',
  'persistence_dispatching',
  'cancelling',
  'recovery_required',
  'completed',
  'cancelled',
  'failed',
  'outcome_unknown',
] as const)

export const RUNTIME_OAUTH_DESKTOP_RECOVERY_REASONS = Object.freeze([
  'start_outcome_unconfirmed',
  'browser_dispatch_unconfirmed',
  'host_attempt_unavailable',
  'helper_liveness_unconfirmed',
  'storage_helper_liveness_unconfirmed',
  'cancellation_outcome_unconfirmed',
] as const)

export type RuntimeOAuthDesktopPhase = (typeof RUNTIME_OAUTH_DESKTOP_PHASES)[number]
export type RuntimeOAuthHostDurablePhase = (typeof RUNTIME_OAUTH_HOST_DURABLE_PHASES)[number]
export type RuntimeOAuthDesktopRecoveryReason = (typeof RUNTIME_OAUTH_DESKTOP_RECOVERY_REASONS)[number]

export interface RuntimeOAuthDesktopAttemptRecordV1 {
  readonly recordVersion: typeof RUNTIME_OAUTH_DESKTOP_ATTEMPT_STORE_VERSION
  readonly attempt: RuntimeOAuthAttemptV1
  readonly revision: number
  readonly phase: RuntimeOAuthDesktopPhase
  readonly preparedAt: string
  readonly updatedAt: string
  readonly hostSessionId?: string
  readonly hostPhase?: RuntimeOAuthHostDurablePhase
  readonly recoveryReason?: RuntimeOAuthDesktopRecoveryReason
  readonly terminal?: RuntimeOAuthAttemptTerminalV1
  readonly hostAckConfirmedAt?: string
}

export interface RuntimeOAuthDesktopAttemptLedgerV1 {
  readonly version: typeof RUNTIME_OAUTH_DESKTOP_ATTEMPT_STORE_VERSION
  readonly attempts: readonly RuntimeOAuthDesktopAttemptRecordV1[]
}

export interface RuntimeOAuthDesktopTransitionInputV1 {
  readonly attemptDigest: string
  readonly expectedRevision: number
  readonly phase: RuntimeOAuthDesktopPhase
  readonly updatedAt: string
  readonly hostSessionId?: string
  readonly hostPhase?: RuntimeOAuthHostDurablePhase
  readonly recoveryReason?: RuntimeOAuthDesktopRecoveryReason
  readonly terminal?: RuntimeOAuthAttemptTerminalV1
}

export interface RuntimeOAuthDesktopAcknowledgeInputV1 {
  readonly attemptDigest: string
  readonly expectedRevision: number
  readonly terminalDigest: string
  readonly acknowledgedAt: string
}

export interface RuntimeOAuthDesktopAttemptStoreOptions {
  readonly storage?: Pick<AtomicJsonStoreOptions<unknown>, 'syncParentDirectory'>
  readonly maxEntries?: number
  readonly retentionMs?: number
}

const TERMINAL_PHASES = new Set<RuntimeOAuthDesktopPhase>([
  'completed',
  'cancelled',
  'failed',
  'outcome_unknown',
])
const NONTERMINAL_HOST_PHASES = new Set<RuntimeOAuthHostDurablePhase>([
  'prepared',
  'login_dispatching',
  'credentials_ready',
  'persistence_dispatching',
  'cancelling',
])
const PHASE_TRANSITIONS: Readonly<Record<RuntimeOAuthDesktopPhase, ReadonlySet<RuntimeOAuthDesktopPhase>>> = {
  prepared: new Set(['start_dispatching', 'failed']),
  start_dispatching: new Set(['host_admitted', 'recovery_required', 'failed', 'outcome_unknown']),
  host_admitted: new Set([
    'browser_dispatching',
    'cancel_dispatching',
    'recovery_required',
    'completed',
    'cancelled',
    'failed',
    'outcome_unknown',
  ]),
  browser_dispatching: new Set([
    'browser_opened',
    'cancel_dispatching',
    'recovery_required',
    'completed',
    'cancelled',
    'failed',
    'outcome_unknown',
  ]),
  browser_opened: new Set([
    'observing',
    'cancel_dispatching',
    'recovery_required',
    'completed',
    'cancelled',
    'failed',
    'outcome_unknown',
  ]),
  observing: new Set([
    'cancel_dispatching',
    'recovery_required',
    'completed',
    'cancelled',
    'failed',
    'outcome_unknown',
  ]),
  cancel_dispatching: new Set(['recovery_required', 'completed', 'cancelled', 'failed', 'outcome_unknown']),
  recovery_required: new Set(['cancel_dispatching', 'completed', 'cancelled', 'failed', 'outcome_unknown']),
  completed: new Set(),
  cancelled: new Set(),
  failed: new Set(),
  outcome_unknown: new Set(),
}
const HOST_PHASE_TRANSITIONS: Readonly<Record<RuntimeOAuthHostDurablePhase, ReadonlySet<RuntimeOAuthHostDurablePhase>>> = {
  prepared: new Set([
    'prepared',
    'login_dispatching',
    'credentials_ready',
    'persistence_dispatching',
    'cancelling',
    'recovery_required',
    'completed',
    'failed',
    'cancelled',
    'outcome_unknown',
  ]),
  login_dispatching: new Set([
    'login_dispatching',
    'credentials_ready',
    'persistence_dispatching',
    'cancelling',
    'recovery_required',
    'completed',
    'failed',
    'cancelled',
    'outcome_unknown',
  ]),
  credentials_ready: new Set([
    'credentials_ready',
    'persistence_dispatching',
    'cancelling',
    'recovery_required',
    'completed',
    'failed',
    'cancelled',
    'outcome_unknown',
  ]),
  persistence_dispatching: new Set([
    'persistence_dispatching',
    'recovery_required',
    'completed',
    'failed',
    'outcome_unknown',
  ]),
  cancelling: new Set(['cancelling', 'recovery_required', 'cancelled', 'failed', 'outcome_unknown']),
  recovery_required: new Set(['recovery_required', 'cancelled', 'failed', 'outcome_unknown']),
  completed: new Set(['completed']),
  cancelled: new Set(['cancelled']),
  failed: new Set(['failed']),
  outcome_unknown: new Set(['outcome_unknown']),
}

const RECORD_REQUIRED_KEYS = ['recordVersion', 'attempt', 'revision', 'phase', 'preparedAt', 'updatedAt'] as const
const RECORD_OPTIONAL_KEYS = [
  'hostSessionId',
  'hostPhase',
  'recoveryReason',
  'terminal',
  'hostAckConfirmedAt',
] as const
const TRANSITION_REQUIRED_KEYS = ['attemptDigest', 'expectedRevision', 'phase', 'updatedAt'] as const
const TRANSITION_OPTIONAL_KEYS = ['hostSessionId', 'hostPhase', 'recoveryReason', 'terminal'] as const
const ACK_KEYS = ['attemptDigest', 'expectedRevision', 'terminalDigest', 'acknowledgedAt'] as const
const LEDGER_KEYS = ['version', 'attempts'] as const
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const SHA256 = /^[a-f0-9]{64}$/u
const ISO_UTC_MS = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u

interface RuntimeOAuthDesktopAttemptCoordinator {
  mutationTail: Promise<void>
  commitUncertain: boolean
}

const STORE_COORDINATORS = new Map<string, RuntimeOAuthDesktopAttemptCoordinator>()

/**
 * Durable, secret-free desktop OAuth attempt journal.
 *
 * Production construction is subordinate to Electron's single-instance lock.
 * Instances that address the same normalized path in one process share a
 * mutation lane; initialization rewrites and rereads the exact ledger so a
 * replacement left merely visible by an earlier directory-sync failure is not
 * accepted as durable without a new confirmed commit.
 */

export class RuntimeOAuthDesktopAttemptStore {
  private readonly store: AtomicJsonStore<unknown>
  private readonly coordinator: RuntimeOAuthDesktopAttemptCoordinator
  private readonly maxEntries: number
  private readonly retentionMs: number
  private initialized = false

  constructor(filePath: string, options: RuntimeOAuthDesktopAttemptStoreOptions = {}) {
    this.maxEntries = boundedInteger(options.maxEntries ?? RUNTIME_OAUTH_DESKTOP_ATTEMPT_LIMIT, 1, 128)
    this.retentionMs = boundedInteger(
      options.retentionMs ?? RUNTIME_OAUTH_DESKTOP_TERMINAL_RETENTION_MS,
      1,
      365 * 24 * 60 * 60 * 1_000,
    )
    const normalizedFilePath = canonicalStoreFilePath(filePath)
    const coordinatorKey = process.platform === 'win32' ? normalizedFilePath.toLowerCase() : normalizedFilePath
    this.coordinator = STORE_COORDINATORS.get(coordinatorKey) ?? {
      mutationTail: Promise.resolve(),
      commitUncertain: false,
    }
    STORE_COORDINATORS.set(coordinatorKey, this.coordinator)
    this.store = new AtomicJsonStore<unknown>(
      normalizedFilePath,
      () => ({ version: RUNTIME_OAUTH_DESKTOP_ATTEMPT_STORE_VERSION, attempts: [] }),
      RUNTIME_OAUTH_DESKTOP_ATTEMPT_MAX_BYTES,
      {
        malformedJson: 'error',
        validateRoot: isRuntimeOAuthDesktopAttemptLedgerV1,
        ...(options.storage?.syncParentDirectory
          ? { syncParentDirectory: options.storage.syncParentDirectory }
          : {}),
      },
    )
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      if (this.initialized) return
      const ledger = parseLedger(await this.store.read(), this.maxEntries)
      await this.writeLedger(ledger)
      const committed = parseLedger(await this.store.read(), this.maxEntries)
      if (!sameLedger(committed, ledger)) throw invalid('OAuth attempt initialization did not reread exactly')
      this.coordinator.commitUncertain = false
      this.initialized = true
    })
  }

  async snapshot(): Promise<RuntimeOAuthDesktopAttemptLedgerV1> {
    this.assertInitialized()
    return parseLedger(await this.store.read(), this.maxEntries)
  }

  async find(attemptDigest: string): Promise<RuntimeOAuthDesktopAttemptRecordV1 | undefined> {
    const digest = parseDigest(attemptDigest, 'attemptDigest')
    const ledger = await this.snapshot()
    return ledger.attempts.find((record) => record.attempt.attemptDigest === digest)
  }

  async prepare(attemptInput: unknown, preparedAtInput: unknown): Promise<{
    readonly record: RuntimeOAuthDesktopAttemptRecordV1
    readonly created: boolean
  }> {
    const attempt = parseRuntimeOAuthAttemptV1(attemptInput)
    const preparedAt = parseTimestamp(preparedAtInput, 'preparedAt')
    if (preparedAt !== attempt.identity.requestedAt) {
      throw invalid('preparedAt must equal the durable attempt requestedAt')
    }
    return await this.exclusive(async () => {
      this.assertWritable()
      const ledger = parseLedger(await this.store.read(), this.maxEntries)
      const existing = ledger.attempts.find((record) => record.attempt.attemptDigest === attempt.attemptDigest)
      if (existing) {
        if (!sameAttempt(existing.attempt, attempt)) throw conflict('OAuth attempt digest identity conflict')
        return { record: existing, created: false }
      }
      if (ledger.attempts.some((record) => record.attempt.identity.operationId === attempt.identity.operationId)) {
        throw conflict('OAuth operation identifier already belongs to another attempt')
      }
      if (ledger.attempts.some((record) => !TERMINAL_PHASES.has(record.phase))) {
        throw new RuntimeOAuthDesktopAttemptStoreError(
          'OAUTH_ATTEMPT_ACTIVE',
          'Another OAuth attempt remains unresolved',
        )
      }
      if (ledger.attempts.length >= this.maxEntries) throw full()
      const record = freezeRecord({
        recordVersion: RUNTIME_OAUTH_DESKTOP_ATTEMPT_STORE_VERSION,
        attempt,
        revision: 1,
        phase: 'prepared',
        preparedAt,
        updatedAt: preparedAt,
      })
      await this.writeLedger(freezeLedger([...ledger.attempts, record]))
      const committed = await this.readRequired(attempt.attemptDigest)
      if (!sameRecord(committed, record)) throw invalid('OAuth prepared record did not reread exactly')
      return { record: committed, created: true }
    })
  }

  async transition(input: RuntimeOAuthDesktopTransitionInputV1): Promise<RuntimeOAuthDesktopAttemptRecordV1> {
    const parsed = parseTransitionInput(input)
    return await this.exclusive(async () => {
      this.assertWritable()
      const ledger = parseLedger(await this.store.read(), this.maxEntries)
      const index = ledger.attempts.findIndex((record) => record.attempt.attemptDigest === parsed.attemptDigest)
      if (index < 0) throw missing()
      const current = ledger.attempts[index]!
      if (current.revision === parsed.expectedRevision + 1 && transitionMatchesRecord(current, parsed)) {
        return current
      }
      if (current.revision !== parsed.expectedRevision) throw conflict('OAuth attempt revision changed')
      if (!PHASE_TRANSITIONS[current.phase].has(parsed.phase)) {
        throw conflict(`OAuth phase cannot advance from ${current.phase} to ${parsed.phase}`)
      }
      if (current.phase === 'prepared' && parsed.hostPhase !== undefined) {
        throw invalid('A pre-dispatch terminal cannot invent host state')
      }
      if (!hostPhaseCanAdvance(current.hostPhase, parsed.hostPhase)) {
        throw invalid('OAuth host phase cannot move backwards or lose durable state')
      }
      if (current.hostSessionId !== undefined && parsed.hostSessionId !== current.hostSessionId) {
        throw invalid('OAuth host session correlation cannot change or disappear')
      }
      if (Date.parse(parsed.updatedAt) < Date.parse(current.updatedAt)) {
        throw invalid('OAuth attempt updatedAt cannot move backwards')
      }
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw invalid('OAuth attempt revision is exhausted')
      const next = freezeRecord({
        recordVersion: RUNTIME_OAUTH_DESKTOP_ATTEMPT_STORE_VERSION,
        attempt: current.attempt,
        revision: current.revision + 1,
        phase: parsed.phase,
        preparedAt: current.preparedAt,
        updatedAt: parsed.updatedAt,
        ...(parsed.hostSessionId === undefined ? {} : { hostSessionId: parsed.hostSessionId }),
        ...(parsed.hostPhase === undefined ? {} : { hostPhase: parsed.hostPhase }),
        ...(parsed.recoveryReason === undefined ? {} : { recoveryReason: parsed.recoveryReason }),
        ...(parsed.terminal === undefined ? {} : { terminal: parsed.terminal }),
      })
      assertRecordCoherence(next)
      const attempts = [...ledger.attempts]
      attempts[index] = next
      await this.writeLedger(freezeLedger(attempts))
      const committed = await this.readRequired(parsed.attemptDigest)
      if (!sameRecord(committed, next)) throw invalid('OAuth transition did not reread exactly')
      return committed
    })
  }

  async acknowledgeTerminal(input: RuntimeOAuthDesktopAcknowledgeInputV1): Promise<RuntimeOAuthDesktopAttemptRecordV1> {
    const parsed = parseAcknowledgeInput(input)
    return await this.exclusive(async () => {
      this.assertWritable()
      const ledger = parseLedger(await this.store.read(), this.maxEntries)
      const index = ledger.attempts.findIndex((record) => record.attempt.attemptDigest === parsed.attemptDigest)
      if (index < 0) throw missing()
      const current = ledger.attempts[index]!
      if (!current.terminal || current.terminal.terminalDigest !== parsed.terminalDigest) {
        throw conflict('OAuth terminal acknowledgement does not match the exact terminal')
      }
      if (current.hostPhase === undefined) {
        throw conflict('A host-free terminal result does not accept a host acknowledgement')
      }
      if (current.hostAckConfirmedAt) {
        if (current.revision !== parsed.expectedRevision + 1) {
          throw conflict('OAuth acknowledgement revision changed')
        }
        if (current.hostAckConfirmedAt !== parsed.acknowledgedAt) {
          throw conflict('OAuth terminal acknowledgement is already fixed')
        }
        return current
      }
      if (current.revision !== parsed.expectedRevision) throw conflict('OAuth attempt revision changed')
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw invalid('OAuth attempt revision is exhausted')
      if (Date.parse(parsed.acknowledgedAt) < Date.parse(current.terminal.body.terminalAt)) {
        throw invalid('OAuth acknowledgement cannot predate the terminal result')
      }
      const next = freezeRecord({
        ...current,
        revision: current.revision + 1,
        updatedAt: latestTimestamp(current.updatedAt, parsed.acknowledgedAt),
        hostAckConfirmedAt: parsed.acknowledgedAt,
      })
      assertRecordCoherence(next)
      const attempts = [...ledger.attempts]
      attempts[index] = next
      await this.writeLedger(freezeLedger(attempts))
      const committed = await this.readRequired(parsed.attemptDigest)
      if (!sameRecord(committed, next)) throw invalid('OAuth acknowledgement did not reread exactly')
      return committed
    })
  }

  async compact(nowMs: number): Promise<number> {
    const now = parseClock(nowMs)
    return await this.exclusive(async () => {
      this.assertWritable()
      const ledger = parseLedger(await this.store.read(), this.maxEntries)
      const retained = ledger.attempts.filter((record) => !isCompactable(record, now, this.retentionMs))
      const removed = ledger.attempts.length - retained.length
      if (removed === 0) return 0
      await this.writeLedger(freezeLedger(retained))
      return removed
    })
  }

  private async writeLedger(ledger: RuntimeOAuthDesktopAttemptLedgerV1): Promise<void> {
    try {
      await this.store.write(ledger)
    } catch (error) {
      if (error instanceof ControlError && error.code === 'storage.commit_uncertain') {
        this.coordinator.commitUncertain = true
      }
      throw error
    }
  }

  private async readRequired(attemptDigest: string): Promise<RuntimeOAuthDesktopAttemptRecordV1> {
    const ledger = parseLedger(await this.store.read(), this.maxEntries)
    const record = ledger.attempts.find((candidate) => candidate.attempt.attemptDigest === attemptDigest)
    if (!record) throw invalid('OAuth durable record disappeared after commit')
    return record
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.coordinator.mutationTail
    let release!: () => void
    this.coordinator.mutationTail = new Promise<void>((resolve) => { release = resolve })
    await prior
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new RuntimeOAuthDesktopAttemptStoreError(
      'OAUTH_ATTEMPT_STORE_UNINITIALIZED',
      'The OAuth attempt store is not initialized',
    )
  }

  private assertWritable(): void {
    this.assertInitialized()
    if (this.coordinator.commitUncertain) {
      throw new RuntimeOAuthDesktopAttemptStoreError(
        'OAUTH_ATTEMPT_COMMIT_UNCERTAIN',
        'OAuth attempt durability is uncertain; new mutation is blocked',
      )
    }
  }
}

export type RuntimeOAuthDesktopAttemptStoreErrorCode =
  | 'OAUTH_ATTEMPT_STORE_UNINITIALIZED'
  | 'OAUTH_ATTEMPT_STORE_INVALID'
  | 'OAUTH_ATTEMPT_ID_CONFLICT'
  | 'OAUTH_ATTEMPT_ACTIVE'
  | 'OAUTH_ATTEMPT_NOT_FOUND'
  | 'OAUTH_ATTEMPT_STORAGE_FULL'
  | 'OAUTH_ATTEMPT_COMMIT_UNCERTAIN'

export class RuntimeOAuthDesktopAttemptStoreError extends Error {
  constructor(readonly code: RuntimeOAuthDesktopAttemptStoreErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeOAuthDesktopAttemptStoreError'
  }
}

function parseLedger(value: unknown, maxEntries: number): RuntimeOAuthDesktopAttemptLedgerV1 {
  const record = readExactObject(value, LEDGER_KEYS, [], 'OAuth attempt ledger')
  if (record.version !== RUNTIME_OAUTH_DESKTOP_ATTEMPT_STORE_VERSION) throw invalid('OAuth ledger version is invalid')
  const rawAttempts = readExactArray(record.attempts, 'OAuth attempt records')
  if (rawAttempts.length > maxEntries) throw invalid('OAuth attempt ledger exceeds its record limit')
  const attempts = rawAttempts.map(parseRecord)
  const digests = new Set<string>()
  const operationIds = new Set<string>()
  for (const attempt of attempts) {
    if (digests.has(attempt.attempt.attemptDigest) || operationIds.has(attempt.attempt.identity.operationId)) {
      throw invalid('OAuth attempt ledger contains duplicate identities')
    }
    digests.add(attempt.attempt.attemptDigest)
    operationIds.add(attempt.attempt.identity.operationId)
  }
  if (attempts.filter((attempt) => !TERMINAL_PHASES.has(attempt.phase)).length > 1) {
    throw invalid('OAuth attempt ledger contains more than one unresolved operation')
  }
  for (let index = 1; index < attempts.length; index += 1) {
    if (attempts[index - 1]!.attempt.attemptDigest >= attempts[index]!.attempt.attemptDigest) {
      throw invalid('OAuth attempt ledger is not canonically ordered')
    }
  }
  return Object.freeze({
    version: RUNTIME_OAUTH_DESKTOP_ATTEMPT_STORE_VERSION,
    attempts: Object.freeze(attempts),
  })
}

function parseRecord(value: unknown): RuntimeOAuthDesktopAttemptRecordV1 {
  const record = readExactObject(value, RECORD_REQUIRED_KEYS, RECORD_OPTIONAL_KEYS, 'OAuth attempt record')
  if (record.recordVersion !== RUNTIME_OAUTH_DESKTOP_ATTEMPT_STORE_VERSION) throw invalid('OAuth record version is invalid')
  const parsed = freezeRecord({
    recordVersion: RUNTIME_OAUTH_DESKTOP_ATTEMPT_STORE_VERSION,
    attempt: parseRuntimeOAuthAttemptV1(record.attempt),
    revision: boundedInteger(record.revision, 1, Number.MAX_SAFE_INTEGER),
    phase: parseEnum(record.phase, RUNTIME_OAUTH_DESKTOP_PHASES, 'OAuth desktop phase'),
    preparedAt: parseTimestamp(record.preparedAt, 'preparedAt'),
    updatedAt: parseTimestamp(record.updatedAt, 'updatedAt'),
    ...(record.hostSessionId === undefined ? {} : { hostSessionId: parseIdentifier(record.hostSessionId, 'hostSessionId') }),
    ...(record.hostPhase === undefined ? {} : {
      hostPhase: parseEnum(record.hostPhase, RUNTIME_OAUTH_HOST_DURABLE_PHASES, 'OAuth host phase'),
    }),
    ...(record.recoveryReason === undefined ? {} : {
      recoveryReason: parseEnum(record.recoveryReason, RUNTIME_OAUTH_DESKTOP_RECOVERY_REASONS, 'OAuth recovery reason'),
    }),
    ...(record.terminal === undefined ? {} : { terminal: parseRuntimeOAuthAttemptTerminalV1(record.terminal) }),
    ...(record.hostAckConfirmedAt === undefined ? {} : {
      hostAckConfirmedAt: parseTimestamp(record.hostAckConfirmedAt, 'hostAckConfirmedAt'),
    }),
  })
  assertRecordCoherence(parsed)
  return parsed
}

function parseTransitionInput(value: unknown): RuntimeOAuthDesktopTransitionInputV1 {
  const record = readExactObject(value, TRANSITION_REQUIRED_KEYS, TRANSITION_OPTIONAL_KEYS, 'OAuth transition')
  return Object.freeze({
    attemptDigest: parseDigest(record.attemptDigest, 'attemptDigest'),
    expectedRevision: boundedInteger(record.expectedRevision, 1, Number.MAX_SAFE_INTEGER),
    phase: parseEnum(record.phase, RUNTIME_OAUTH_DESKTOP_PHASES, 'OAuth desktop phase'),
    updatedAt: parseTimestamp(record.updatedAt, 'updatedAt'),
    ...(record.hostSessionId === undefined ? {} : { hostSessionId: parseIdentifier(record.hostSessionId, 'hostSessionId') }),
    ...(record.hostPhase === undefined ? {} : {
      hostPhase: parseEnum(record.hostPhase, RUNTIME_OAUTH_HOST_DURABLE_PHASES, 'OAuth host phase'),
    }),
    ...(record.recoveryReason === undefined ? {} : {
      recoveryReason: parseEnum(record.recoveryReason, RUNTIME_OAUTH_DESKTOP_RECOVERY_REASONS, 'OAuth recovery reason'),
    }),
    ...(record.terminal === undefined ? {} : { terminal: parseRuntimeOAuthAttemptTerminalV1(record.terminal) }),
  })
}

function parseAcknowledgeInput(value: unknown): RuntimeOAuthDesktopAcknowledgeInputV1 {
  const record = readExactObject(value, ACK_KEYS, [], 'OAuth acknowledgement')
  return Object.freeze({
    attemptDigest: parseDigest(record.attemptDigest, 'attemptDigest'),
    expectedRevision: boundedInteger(record.expectedRevision, 1, Number.MAX_SAFE_INTEGER),
    terminalDigest: parseDigest(record.terminalDigest, 'terminalDigest'),
    acknowledgedAt: parseTimestamp(record.acknowledgedAt, 'acknowledgedAt'),
  })
}

function assertRecordCoherence(record: RuntimeOAuthDesktopAttemptRecordV1): void {
  const preparedAt = Date.parse(record.preparedAt)
  const updatedAt = Date.parse(record.updatedAt)
  if (record.preparedAt !== record.attempt.identity.requestedAt || updatedAt < preparedAt) {
    throw invalid('OAuth record timestamps do not match its attempt')
  }
  const terminalPhase = TERMINAL_PHASES.has(record.phase)
  if ((record.hostSessionId === undefined) !== (record.hostPhase === undefined)) {
    throw invalid('OAuth host session and host phase must remain bound together')
  }
  if (terminalPhase !== Boolean(record.terminal)) throw invalid('OAuth terminal state is incomplete')
  if (record.terminal) {
    if (
      record.terminal.body.attemptDigest !== record.attempt.attemptDigest ||
      record.terminal.body.phase !== record.phase ||
      record.recoveryReason !== undefined
    ) throw invalid('OAuth terminal state does not match its attempt and phase')
    if (record.hostPhase === undefined) {
      if (
        record.hostSessionId !== undefined ||
        record.phase !== 'failed' ||
        record.terminal.body.resolution !== 'interrupted_before_login_dispatch' ||
        record.hostAckConfirmedAt !== undefined
      ) throw invalid('OAuth host-free terminal state is not a proven pre-dispatch failure')
    } else if (record.hostPhase !== record.phase) {
      throw invalid('OAuth terminal host phase does not match its result')
    }
    const terminalLatestAt = record.hostAckConfirmedAt ?? record.terminal.body.terminalAt
    if (Date.parse(record.updatedAt) < Date.parse(terminalLatestAt)) {
      throw invalid('OAuth terminal update timestamp is invalid')
    }
  }
  if (record.hostAckConfirmedAt !== undefined) {
    if (!record.terminal || Date.parse(record.hostAckConfirmedAt) < Date.parse(record.terminal.body.terminalAt)) {
      throw invalid('OAuth host acknowledgement is not bound to a terminal result')
    }
    if (Date.parse(record.updatedAt) < Date.parse(record.hostAckConfirmedAt)) {
      throw invalid('OAuth acknowledgement must not move the local update time backwards')
    }
  }
  if (record.phase === 'prepared' || record.phase === 'start_dispatching') {
    if (record.hostSessionId !== undefined || record.hostPhase !== undefined || record.recoveryReason !== undefined) {
      throw invalid('OAuth pre-host phase contains host state')
    }
  } else if (record.phase === 'recovery_required') {
    if (record.recoveryReason === undefined || record.terminal !== undefined) {
      throw invalid('OAuth recovery state is incomplete')
    }
    if (record.hostPhase !== undefined && record.hostPhase !== 'recovery_required') {
      throw invalid('OAuth recovery state contains a non-recovery host phase')
    }
  } else if (!terminalPhase) {
    const hostPhaseIsAllowed = record.hostPhase !== undefined && (
      NONTERMINAL_HOST_PHASES.has(record.hostPhase) ||
      (record.phase === 'cancel_dispatching' && record.hostPhase === 'recovery_required')
    )
    if (
      record.hostSessionId === undefined ||
      !hostPhaseIsAllowed ||
      record.recoveryReason !== undefined
    ) throw invalid('OAuth active phase is missing its host correlation')
  }
}

function freezeRecord(record: RuntimeOAuthDesktopAttemptRecordV1): RuntimeOAuthDesktopAttemptRecordV1 {
  return Object.freeze(record)
}

function freezeLedger(attempts: readonly RuntimeOAuthDesktopAttemptRecordV1[]): RuntimeOAuthDesktopAttemptLedgerV1 {
  const sorted = [...attempts].sort((left, right) => (
    left.attempt.attemptDigest < right.attempt.attemptDigest ? -1 :
      left.attempt.attemptDigest > right.attempt.attemptDigest ? 1 : 0
  ))
  return Object.freeze({
    version: RUNTIME_OAUTH_DESKTOP_ATTEMPT_STORE_VERSION,
    attempts: Object.freeze(sorted),
  })
}

function sameAttempt(left: RuntimeOAuthAttemptV1, right: RuntimeOAuthAttemptV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameRecord(left: RuntimeOAuthDesktopAttemptRecordV1, right: RuntimeOAuthDesktopAttemptRecordV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameLedger(left: RuntimeOAuthDesktopAttemptLedgerV1, right: RuntimeOAuthDesktopAttemptLedgerV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function transitionMatchesRecord(
  record: RuntimeOAuthDesktopAttemptRecordV1,
  transition: RuntimeOAuthDesktopTransitionInputV1,
): boolean {
  return record.phase === transition.phase &&
    record.updatedAt === transition.updatedAt &&
    record.hostSessionId === transition.hostSessionId &&
    record.hostPhase === transition.hostPhase &&
    record.recoveryReason === transition.recoveryReason &&
    JSON.stringify(record.terminal) === JSON.stringify(transition.terminal)
}

function hostPhaseCanAdvance(
  current: RuntimeOAuthHostDurablePhase | undefined,
  next: RuntimeOAuthHostDurablePhase | undefined,
): boolean {
  if (current === undefined) return true
  return next !== undefined && HOST_PHASE_TRANSITIONS[current].has(next)
}

function isCompactable(record: RuntimeOAuthDesktopAttemptRecordV1, nowMs: number, retentionMs: number): boolean {
  if (!record.terminal) return false
  const retentionStart = record.hostAckConfirmedAt ?? (
    record.hostPhase === undefined && record.terminal.body.resolution === 'interrupted_before_login_dispatch'
      ? record.terminal.body.terminalAt
      : undefined
  )
  return retentionStart !== undefined && nowMs - Date.parse(retentionStart) >= retentionMs
}

function isRuntimeOAuthDesktopAttemptLedgerV1(value: unknown): value is RuntimeOAuthDesktopAttemptLedgerV1 {
  try {
    parseLedger(value, RUNTIME_OAUTH_DESKTOP_ATTEMPT_LIMIT)
    return true
  } catch {
    return false
  }
}

function readExactObject<const R extends string, const O extends string>(
  value: unknown,
  requiredKeys: readonly R[],
  optionalKeys: readonly O[],
  label: string,
): Record<R | O, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalid(`${label} must be a plain object`)
  }
  const allowed = new Set<string>([...requiredKeys, ...optionalKeys])
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw invalid(`${label} has extra fields`)
  for (const required of requiredKeys) if (!Object.prototype.hasOwnProperty.call(value, required)) {
    throw invalid(`${label} is missing ${required}`)
  }
  const result = Object.create(null) as Record<R | O, unknown>
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalid(`${label} has hidden or accessor fields`)
    result[key as R | O] = descriptor.value
  }
  return result
}

function readExactArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid(`${label} must be an array`)
  const keys = Reflect.ownKeys(value)
  const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), 'length']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw invalid(`${label} is sparse or decorated`)
  }
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalid(`${label} has accessor entries`)
    result.push(descriptor.value)
  }
  return result
}

function parseIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !IDENTIFIER.test(value)) {
    throw invalid(`${label} is invalid`)
  }
  return value
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value) || /^0+$/u.test(value)) throw invalid(`${label} is invalid`)
  return value
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ISO_UTC_MS.test(value)) throw invalid(`${label} is invalid`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw invalid(`${label} is invalid`)
  return value
}

function latestTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function parseEnum<const T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.some((candidate) => candidate === value)) throw invalid(`${label} is invalid`)
  return value as T
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid('OAuth bounded integer is invalid')
  }
  return value as number
}

function canonicalStoreFilePath(filePath: string): string {
  const absoluteFilePath = path.resolve(filePath)
  const parent = path.dirname(absoluteFilePath)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  return path.join(realpathSync.native(parent), path.basename(absoluteFilePath))
}

function parseClock(value: number): number {
  if (!Number.isSafeInteger(value) || value < -8_640_000_000_000_000 || value > 8_640_000_000_000_000) {
    throw invalid('OAuth compaction clock is invalid')
  }
  return value
}

function invalid(message: string): RuntimeOAuthDesktopAttemptStoreError {
  return new RuntimeOAuthDesktopAttemptStoreError('OAUTH_ATTEMPT_STORE_INVALID', message)
}

function conflict(message: string): RuntimeOAuthDesktopAttemptStoreError {
  return new RuntimeOAuthDesktopAttemptStoreError('OAUTH_ATTEMPT_ID_CONFLICT', message)
}

function missing(): RuntimeOAuthDesktopAttemptStoreError {
  return new RuntimeOAuthDesktopAttemptStoreError('OAUTH_ATTEMPT_NOT_FOUND', 'OAuth attempt was not found')
}

function full(): RuntimeOAuthDesktopAttemptStoreError {
  return new RuntimeOAuthDesktopAttemptStoreError('OAUTH_ATTEMPT_STORAGE_FULL', 'OAuth attempt storage is full')
}
