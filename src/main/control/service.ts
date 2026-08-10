import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { App } from 'electron'
import {
  CapabilitySchema,
  CANDIDATE_EVALUATION_PROBE_CAPABILITY,
  CandidateEvaluationPreflightSchema,
  CandidateEvaluationSnapshotSchema,
  CandidateEvaluationStatusSchema,
  CatalogProjectionSnapshotSchema,
  CommandEnvelopeSchema,
  CommandReceiptSchema as HostCommandReceiptSchema,
  PRIME_AGENT_COMMAND_CAPABILITY,
  PROTOCOL_VERSION as HOST_PROTOCOL_VERSION,
  RESIDENT_LIFECYCLE_CAPABILITY,
  RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY,
  RUNTIME_INTEGRITY_CAPABILITY,
  RUNTIME_INTEGRITY_REPAIR_CAPABILITY,
  RUNTIME_INTEGRITY_RETRY_CAPABILITY,
  RUNTIME_MODEL_CATALOG_CAPABILITY,
  RUNTIME_OAUTH_CAPABILITY,
  ResidentLifecycleLookupResultSchema,
  ResidentLifecycleStatusSchema,
  ResidentAbortIdleObservedSignalSchema,
  ResidentPromptIdleObservedSignalSchema,
  RuntimeIntegritySnapshotSchema,
  RuntimeModelCatalogSnapshotSchema,
  RuntimeOAuthSessionSnapshotSchema,
  StructuredErrorSchema,
  ThreadProjectionSnapshotSchema,
  ThreadChangedEventPayloadSchema,
  type CatalogProjectionSnapshot,
  type CandidateEvaluationPreflight,
  type CandidateEvaluationPreflightRequest,
  type CandidateEvaluationSnapshot,
  type CandidateEvaluationStartRequest,
  type CandidateEvaluationStatus,
  type CommandEnvelope,
  type RuntimeIntegritySnapshot,
  type RuntimeModelCatalogSnapshot,
  type RuntimeOAuthSessionSnapshot,
  type ResidentLifecycleLookupResult,
  type ResidentLifecycleStatus,
  type TaskState,
  type ThreadProjectionSnapshot,
} from '../../shared/protocol'
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  isPinnedCodexAuthorizationUrl
} from '../../shared/codex-oauth'
import type {
  ApprovalResolution,
  BootstrapPayload,
  CancelRequest,
  ClientCommand,
  CommandReceipt,
  ConnectionState,
  ConnectionTarget,
  Diagnostics,
  HandoffCommitRequest,
  HandoffPlanRequest,
  HostRuntimeReadiness,
  HostInstallPlan,
  OutboxEntry,
  ResidentEndInput,
  ResidentEndOperationView,
  ResidentEndPreparation,
  ResidentEndPreparationInput,
  ResidentLifecycleOperationView,
  ResidentProvisionOperationView,
  ResidentProvisionInput,
  ResidentWorkspaceSelection,
  ResidentWorkspaceSelectionInput,
  RuntimeOAuthSessionView,
  RuntimeIntegrityRepairInput,
  SessionCursor,
  SshHostAlias,
  SshProbe,
} from './contracts'
import { ControlError, toStructuredError } from './errors'
import { type FramedConnection } from './framed-connection'
import { connectSshHost, ensureAndConnectLocalHostd, localHostdEndpoint } from './local-hostd'
import {
  IndexedProjectionCacheStore,
  type IndexedProjectionEntry,
  type IndexedProjectionEnvelope,
} from './projection-cache'
import { discoverSshHosts, parseSshConfigAliases, probeSshHost, resolveSshHost } from './ssh'
import { AtomicJsonStore, LatencyRecorder } from './storage'

interface TargetHostBinding {
  target: ConnectionTarget
  hostId: string
  verifiedAt: string
}

interface CachedHostProjection extends IndexedProjectionEntry {
  hostId: string
  catalog?: unknown
  lastSnapshot?: unknown
  retiredExecutionGenerations?: Record<string, string[]>
  retiredCursorGenerations?: Record<string, string[]>
  updatedAt?: string
}

interface CacheEnvelope extends IndexedProjectionEnvelope {
  version: 3
  entries: Record<string, CachedHostProjection>
  /** Most recently verified authority; never trusted without a target binding. */
  activeHostId?: string
  projectionHostId?: string
  catalog?: unknown
  lastSnapshot?: unknown
  updatedAt?: string
  lastAttemptedTarget?: ConnectionTarget
  lastAttemptedAt?: string
  lastTarget?: ConnectionTarget
  lastTargetUpdatedAt?: string
  targetHostBindings: TargetHostBinding[]
}

type ScopedOutboxEntry = OutboxEntry & { hostId: string; command: ClientCommand }

interface OutboxIdentity {
  hostId: string
  deviceId: string
  commandId: string
  threadId: string
  expectedExecutionGenerationId: string
  commandFingerprint: string
}

interface CommandIdentityLedgerEntry {
  deviceId: string
  commandId: string
  hostId: string
  envelopeSha256: string
  reservedAt: string
}

interface CommandIdentityLedger {
  version: 1
  entries: CommandIdentityLedgerEntry[]
}

interface DurableUncertainReceiptHistory {
  version: 1
  entries: Array<CommandReceipt & { recordedAt: string }>
}

interface OutboxClassification {
  actionable: ScopedOutboxEntry[]
  quarantinedCount: number
}

interface CapturedProjectionAuthority {
  hostId: string
  connection: FramedConnection
  target: ConnectionTarget
  generation: number
}

interface ActiveRuntimeOAuthSession {
  readonly authority: CapturedProjectionAuthority
  readonly sessionId: string
  readonly providerId: string
  closing: boolean
  cancellationPromise?: Promise<RuntimeOAuthSessionSnapshot>
}

interface OpeningRuntimeOAuthSession {
  readonly url: string
  readonly promise: Promise<void>
}

interface AmbiguousRuntimeOAuthStart {
  readonly authority: CapturedProjectionAuthority
  readonly providerId: string
}

interface HealthLineage {
  hostId: string
  hostdVersion: string
  startedAt: string
  reportsRuntimeIntegrity: boolean
  runtimeContractVersion?: number
  runtimeTrustAnchorId?: string
  runtimeTargetKey?: string
}

interface HealthObservation {
  hostId: string
  capabilities: string[]
  runtimeReadiness: HostRuntimeReadiness
  lineage: HealthLineage
}

interface ThreadChangeRefresh {
  readonly authority: CapturedProjectionAuthority
  readonly threadId: string
  revision: number
  committedRevision: number
  cancelled: boolean
}

interface ResidentProvisionMetadata {
  readonly projectDisplayName: string
  readonly threadTitle: string
  readonly sessionName?: string
}

interface ResidentWorkspaceSelectionRecordBase {
  readonly selectionToken: string
  readonly authority: CapturedProjectionAuthority
  readonly selection: ResidentWorkspaceSelection
  readonly projectId: string
  readonly workspaceId: string
  readonly threadId: string
  readonly executionGenerationId: string
  readonly createdAt: string
  provisionMetadata?: ResidentProvisionMetadata
  inFlight?: Promise<ResidentLifecycleStatus>
  durableOperationPossible: boolean
  pendingRetirement?: RetiredResidentSelectionReason
}

interface LocalResidentWorkspaceSelectionRecord extends ResidentWorkspaceSelectionRecordBase {
  readonly provisionMode: 'local_path'
  readonly workspaceDirectory: string
}

interface RegisteredResidentWorkspaceSelectionRecord extends ResidentWorkspaceSelectionRecordBase {
  readonly provisionMode: 'registered_workspace'
  readonly referenceThreadId: string
  readonly referenceExecutionGenerationId: string
}

type ResidentWorkspaceSelectionRecord =
  | LocalResidentWorkspaceSelectionRecord
  | RegisteredResidentWorkspaceSelectionRecord

interface ResidentLifecycleLedger {
  version: 1
  entries: ResidentLifecycleOperationView[]
}

type LegacyResidentProvisionOperationView = Omit<
  Extract<ResidentProvisionOperationView, { provisionMode: 'local_path' }>,
  'kind' | 'provisionMode'
> & {
  kind?: 'provision'
  provisionMode?: undefined
}

interface PersistedResidentLifecycleLedger {
  version: 1
  entries: Array<ResidentLifecycleOperationView | LegacyResidentProvisionOperationView>
}

interface ResidentEndConfirmationRecord {
  readonly confirmation: ResidentEndPreparation
  readonly authority: CapturedProjectionAuthority
  readonly identity: Omit<ResidentEndPreparationInput, 'resumeOperationId'>
  readonly sourceCursor: SessionCursor
  readonly createdAt: string
}

interface ResidentLifecycleStatusMerge {
  readonly status: ResidentLifecycleStatus
  readonly state?: ResidentLifecycleOperationView['state']
}

type RetiredResidentSelectionReason = 'expired' | 'superseded' | 'authority_changed' | 'terminal'
type RetiredResidentEndConfirmationReason = 'expired' | 'superseded' | 'authority_changed' | 'consumed'

interface ServiceOptions {
  app: App
  sshExecutable?: string
  openExternal?: (url: string) => Promise<void>
  /** Electron's native directory picker, injected so paths never enter preload IPC. */
  selectDirectory?: () => Promise<string | undefined>
  /** Injectable only for deterministic cross-platform service tests. */
  platform?: NodeJS.Platform
}

const RECONNECT_DELAYS_MS = [500, 1_500, 3_500, 8_000, 15_000, 30_000] as const
const OAUTH_START_REGISTRATION_TIMEOUT_MS = 35_000
const OAUTH_DRAIN_TIMEOUT_MS = 15_000
const HEALTH_POLL_INITIALIZING_MS = 500
const HEALTH_POLL_STEADY_MS = 15_000
const HEALTH_CAPABILITY_WARMUP_POLLS = 60
const HEALTH_POLL_TIMEOUT_MS = 10_000
const NONTERMINAL_RECONCILIATION_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const
const NONTERMINAL_RECONCILIATION_BATCH_LIMIT = 32
const THREAD_CHANGE_DEBOUNCE_MS = 80
const OUTBOX_LIMIT = 1_000
const COMPLETED_PROMPT_PROOF_FENCE_LIMIT = OUTBOX_LIMIT
const COMMAND_IDENTITY_LEDGER_LIMIT = 10_000
const DURABLE_UNCERTAIN_RECEIPT_LIMIT = 1_000
const RETIRED_GENERATIONS_PER_THREAD_LIMIT = 16
const RETIRED_CURSOR_GENERATIONS_PER_LINEAGE_LIMIT = 16
const MAX_THREAD_CHANGE_REFRESHES = 1_024
const TARGET_BINDING_LIMIT = 128
const RESIDENT_SELECTION_TTL_MS = 5 * 60_000
const RESIDENT_SELECTION_LIMIT = 32
const RETIRED_RESIDENT_SELECTION_LIMIT = 64
const RESIDENT_LIFECYCLE_LEDGER_LIMIT = 128
const RESIDENT_END_CONFIRMATION_TTL_MS = 2 * 60_000
const RESIDENT_END_CONFIRMATION_LIMIT = 32
const RETIRED_RESIDENT_END_CONFIRMATION_LIMIT = 64
const RESIDENT_PROVISION_TIMEOUT_MS = 120_000
const RESIDENT_RECONNECT_RECONCILE_LIMIT = 8
const RESIDENT_RECONNECT_STATUS_TIMEOUT_MS = 15_000
const RESIDENT_BACKGROUND_REFRESH_LIMIT = 8
const RESIDENT_BACKGROUND_REFRESH_BUDGET_MS = 120_000
const RESIDENT_BACKGROUND_REFRESH_REQUEST_TIMEOUT_MS = 30_000
const RESIDENT_ENDED_RECAP = 'Resident session ended.'
const HOST_RESIDENT_END_SOURCE_CURSOR_CHANGED = 'host.resident_end_source_cursor_changed'
const TERMINAL_COMMAND_RECEIPTS = new Set([
  'completed',
  'rejected',
  'cancelled',
  'failed'
])

export class DesktopControlService extends EventEmitter {
  private readonly app: App
  private readonly sshExecutable: string
  private readonly openExternal: ((url: string) => Promise<void>) | undefined
  private readonly selectDirectory: (() => Promise<string | undefined>) | undefined
  private readonly platform: NodeJS.Platform
  private readonly oauthAuthorityId = `desktop-oauth-${randomUUID()}`
  private readonly openedOAuthSessions = new Set<string>()
  private readonly activeOAuthSessions = new Map<string, ActiveRuntimeOAuthSession>()
  private readonly openingOAuthSessions = new Map<string, OpeningRuntimeOAuthSession>()
  private readonly oauthStartRegistrations = new Set<Promise<void>>()
  private readonly ambiguousOAuthStarts = new Map<string, AmbiguousRuntimeOAuthStart>()
  private oauthTransitionBlockCount = 0
  private oauthTransitionGeneration = 0
  private oauthDrainPromise: Promise<void> | undefined
  private readonly cache: IndexedProjectionCacheStore<CacheEnvelope>
  private readonly outbox: AtomicJsonStore<unknown[]>
  private readonly commandIdentities: AtomicJsonStore<CommandIdentityLedger>
  private readonly durableUncertainReceipts: AtomicJsonStore<DurableUncertainReceiptHistory>
  private readonly residentLifecycleLedger: AtomicJsonStore<PersistedResidentLifecycleLedger>
  private readonly latency = new LatencyRecorder()
  private readonly discoveredAliases = new Set<string>()
  private readonly installPlans = new Map<string, HostInstallPlan>()
  private readonly threadChangeRefreshes = new Map<string, ThreadChangeRefresh>()
  private readonly residentWorkspaceSelections = new Map<string, ResidentWorkspaceSelectionRecord>()
  private readonly retiredResidentSelections = new Map<string, RetiredResidentSelectionReason>()
  private readonly residentEndConfirmations = new Map<string, ResidentEndConfirmationRecord>()
  private readonly retiredResidentEndConfirmations = new Map<string, RetiredResidentEndConfirmationReason>()
  private readonly residentEndMutationTails = new Map<string, Promise<void>>()
  private residentProjectionRefreshPromise?: Promise<void>
  private residentProjectionRefreshTail: Promise<void> = Promise.resolve()
  /**
   * Per-identity receipt/proof commits are serialized independently from the
   * transport request. This lets an idle proof delivered in the same read as a
   * submit response win without the later submit continuation recreating its
   * durable outbox entry.
   */
  private readonly commandLifecycleTails = new Map<string, Promise<void>>()
  private readonly completedResidentProofs = new Map<string, CommandReceipt>()
  private readonly activeCommandSubmissions = new Map<string, number>()
  private nonterminalReconciliationTimer?: NodeJS.Timeout
  private nonterminalReconciliationInFlight?: Promise<boolean>
  private nonterminalReconciliationAttempt = 0
  private connection?: FramedConnection
  private target?: ConnectionTarget
  private authorityHostId?: string
  private authorityCapabilities: string[] = []
  private authorityRuntimeReadiness?: HostRuntimeReadiness
  private authorityHealthLineage?: HealthLineage
  private healthPollTimer?: NodeJS.Timeout
  private healthCapabilityWarmupPollsRemaining = 0
  private controlIntentGeneration = 0
  private reconnectGeneration = 0
  private attempt = 0
  private intentionallyOffline = true
  private state: ConnectionState = {
    phase: 'offline',
    since: new Date().toISOString(),
    attempt: 0
  }

  constructor(options: ServiceOptions) {
    super()
    this.app = options.app
    this.sshExecutable = options.sshExecutable ?? 'ssh'
    this.openExternal = options.openExternal
    this.selectDirectory = options.selectDirectory
    this.platform = options.platform ?? process.platform
    const stateDirectory = path.join(this.app.getPath('userData'), 'control')
    const emptyCache = (): CacheEnvelope => ({ version: 3, entries: {}, targetHostBindings: [] })
    this.cache = new IndexedProjectionCacheStore(
      path.join(stateDirectory, 'projection-cache.json'),
      path.join(stateDirectory, 'projections'),
      normalizeCache,
      emptyCache,
    )
    this.outbox = new AtomicJsonStore<unknown[]>(
      path.join(stateDirectory, 'command-outbox.json'),
      () => [],
      4 * 1024 * 1024,
      { malformedJson: 'error', validateRoot: (value): value is unknown[] => Array.isArray(value) },
    )
    this.commandIdentities = new AtomicJsonStore<CommandIdentityLedger>(
      path.join(stateDirectory, 'command-identities.json'),
      () => ({ version: 1, entries: [] }),
      8 * 1024 * 1024,
      { malformedJson: 'error', validateRoot: isCommandIdentityLedger },
    )
    this.durableUncertainReceipts = new AtomicJsonStore<DurableUncertainReceiptHistory>(
      path.join(stateDirectory, 'durable-uncertain-receipts.json'),
      () => ({ version: 1, entries: [] }),
      4 * 1024 * 1024,
      { malformedJson: 'error', validateRoot: isDurableUncertainReceiptHistory },
    )
    this.residentLifecycleLedger = new AtomicJsonStore<PersistedResidentLifecycleLedger>(
      path.join(stateDirectory, 'resident-lifecycle.json'),
      () => ({ version: 1, entries: [] }),
      2 * 1024 * 1024,
      { malformedJson: 'error', validateRoot: isPersistedResidentLifecycleLedger },
    )
  }

  async bootstrap(): Promise<BootstrapPayload> {
    return await this.latency.measure('cache.bootstrap', async () => {
      // These reads touch distinct stores and do not depend on one another;
      // target authority is not derived until the complete initial view has
      // settled. The already-validated command ledger is reused to classify
      // the initial outbox instead of adding a second disk-read waterfall.
      const [
        initialCommandIdentitiesResult,
        durableUncertainReceiptsResult,
        initialCacheResult,
        initialRawOutboxResult,
        initialResidentLifecycleLedgerResult,
      ] = await Promise.allSettled([
        this.commandIdentities.read(),
        this.durableUncertainReceipts.read(),
        this.readCache(),
        this.readRawOutbox(),
        this.residentLifecycleLedger.read(),
      ])
      // Keep the former deterministic failure order while performing the disk
      // reads concurrently. A valid target cache is restored before a later
      // outbox fault surfaces, so subsequent mutations still reach and retain
      // that exact durable storage poison instead of failing for missing host
      // identity first.
      if (initialCommandIdentitiesResult.status === 'rejected') throw initialCommandIdentitiesResult.reason
      if (durableUncertainReceiptsResult.status === 'rejected') throw durableUncertainReceiptsResult.reason
      if (initialCacheResult.status === 'rejected') throw initialCacheResult.reason
      const initialCommandIdentities = initialCommandIdentitiesResult.value
      const durableUncertainReceipts = durableUncertainReceiptsResult.value
      const initialCache = initialCacheResult.value
      if (!this.target && initialCache.lastTarget) {
        this.target = initialCache.lastTarget
        this.authorityHostId = findBoundHostId(initialCache, initialCache.lastTarget)
        this.state = {
          phase: 'offline',
          target: initialCache.lastTarget,
          ...(this.authorityHostId ? { hostId: this.authorityHostId } : {}),
          since: initialCache.lastTargetUpdatedAt ?? now(),
          attempt: this.attempt
        }
      }
      if (initialRawOutboxResult.status === 'rejected') throw initialRawOutboxResult.reason
      if (initialResidentLifecycleLedgerResult.status === 'rejected') throw initialResidentLifecycleLedgerResult.reason
      const initialRawOutbox = initialRawOutboxResult.value
      const initialResidentLifecycleLedger = initialResidentLifecycleLedgerResult.value

      // Cache, outbox, and connection must describe one authority. A concurrent
      // connect can otherwise splice A's cache onto B's connection state.
      for (let retry = 0; retry < 16; retry += 1) {
        const generation = this.reconnectGeneration
        const activeHostId = this.authorityHostId
        const activeTarget = this.target
        // Outbox classification and resident lifecycle recovery use independent
        // stores; the authority fence below rejects any concurrent target change.
        const [cache, outbox, residentLifecycleLedger] = await Promise.all([
          retry === 0 ? Promise.resolve(initialCache) : this.readCache(),
          retry === 0
            ? this.readOutboxClassification(true, {
                raw: initialRawOutbox,
                ledger: initialCommandIdentities,
              })
            : this.readOutboxClassification(true),
          retry === 0 ? Promise.resolve(initialResidentLifecycleLedger) : this.residentLifecycleLedger.read(),
        ])
        const residentLifecycle = normalizeResidentLifecycleLedger(residentLifecycleLedger)
        const connection = this.getConnectionState()
        if (
          generation === this.reconnectGeneration &&
          activeHostId === this.authorityHostId &&
          sameOptionalTarget(activeTarget, this.target) &&
          sameOptionalTarget(activeTarget, connection.target) &&
          (!connection.hostId || connection.hostId === activeHostId)
        ) {
          const actionableOutbox = outbox.actionable.filter((entry) =>
            Boolean(activeHostId && entry.hostId === activeHostId)
          )
          return {
            cache: visibleCacheForAuthority(cache, activeHostId),
            outbox: actionableOutbox,
            quarantinedOutboxCount: outbox.quarantinedCount,
            durableUncertainReceipts: durableUncertainReceipts.entries
              .filter((receipt) => !activeHostId || receipt.hostId === activeHostId)
              .map(({ recordedAt: _recordedAt, ...receipt }) => receipt),
            residentLifecycleOperations: residentLifecycle.entries
              .filter((entry) => !activeHostId || entry.expectedHostId === activeHostId)
              .map((entry) => structuredClone(entry)),
            connection,
            appVersion: this.app.getVersion()
          }
        }
      }
      throw new ControlError('cache.bootstrap_raced', 'The active host changed while the workbench cache was loading.', {
        retryable: true
      })
    })
  }

  async discoverSshHosts(): Promise<SshHostAlias[]> {
    return await this.latency.measure('ssh.discovery', async () => {
      const hosts = await discoverSshHosts({ sshExecutable: this.sshExecutable })
      this.discoveredAliases.clear()
      for (const host of hosts) this.discoveredAliases.add(host.alias)
      return hosts
    })
  }

  async probeSshHost(alias: string): Promise<SshProbe> {
    await this.requireDiscoveredAlias(alias)
    return await this.latency.measure('ssh.probe', async () =>
      await probeSshHost(alias, { sshExecutable: this.sshExecutable })
    )
  }

  async planHostInstall(alias: string): Promise<HostInstallPlan> {
    await this.requireDiscoveredAlias(alias)
    const effective = await resolveSshHost(alias, { sshExecutable: this.sshExecutable })
    const target = `${effective.user ? `${effective.user}@` : ''}${effective.hostname}${effective.port && effective.port !== 22 ? `:${effective.port}` : ''}`
    const plan: HostInstallPlan = {
      planId: randomUUID(),
      alias,
      effectiveTarget: target,
      executable: false,
      argv: [],
      deferredReason: 'This build does not include a signed remote host-service installer.',
      requiresExplicitConsent: true,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
    }
    for (const [planId, candidate] of this.installPlans) {
      if (Date.parse(candidate.expiresAt) <= Date.now()) this.installPlans.delete(planId)
    }
    if (this.installPlans.size >= 64) {
      const oldest = this.installPlans.keys().next().value as string | undefined
      if (oldest) this.installPlans.delete(oldest)
    }
    this.installPlans.set(plan.planId, plan)
    return plan
  }

  async installHost(planId: string, consent: true): Promise<never> {
    const plan = this.installPlans.get(planId)
    if (!plan || Date.parse(plan.expiresAt) <= Date.now()) {
      throw new ControlError('ssh.install_plan_expired', 'The host installation plan has expired.')
    }
    if (consent !== true) {
      throw new ControlError('ssh.install_consent_required', 'Host installation requires explicit consent.')
    }
    // Deliberately no fallback curl/shell bootstrap. A signed package and
    // checksum verifier must be bundled before this boundary can execute it.
    throw new ControlError('ssh.install_deferred', plan.deferredReason ?? 'Host installation is unavailable.', {
      details: { planId, alias: plan.alias }
    })
  }

  async connect(target: ConnectionTarget): Promise<ConnectionState> {
    return await this.connectTarget(target)
  }

  async activateVerifiedSshHost(expectedHostId: string): Promise<ConnectionState> {
    if (!isHostId(expectedHostId)) {
      throw new ControlError(
        'ssh.verified_host_identity_invalid',
        'Choose a previously verified computer before connecting.'
      )
    }
    const cache = await this.readCache()
    const target = findBoundSshTarget(cache, expectedHostId)
    if (!target) {
      throw new ControlError(
        'ssh.verified_host_binding_required',
        'This computer has no previously verified configured SSH binding. Add it again before connecting.',
        { details: { expectedHostId } }
      )
    }
    return await this.connectTarget(target, expectedHostId)
  }

  private async connectTarget(target: ConnectionTarget, expectedHostId?: string): Promise<ConnectionState> {
    this.beginOAuthConnectionTransition()
    this.revokeResidentWorkspaceSelections('authority_changed')
    this.revokeResidentEndConfirmations('authority_changed')
    try {
      const effectiveExpectedHostId = expectedHostId
      if (target.kind === 'ssh') await this.requireDiscoveredAlias(target.alias)
      const intentGeneration = ++this.controlIntentGeneration
      const cache = await this.cache.update((current) => {
        const normalized = normalizeCache(current)
        if (effectiveExpectedHostId !== undefined && findBoundHostId(normalized, target) !== effectiveExpectedHostId) {
          throw new ControlError(
            'ssh.verified_host_binding_required',
            'The previously verified SSH binding changed before this computer could be connected.',
            { retryable: true, details: { expectedHostId: effectiveExpectedHostId } }
          )
        }
        return {
          ...normalized,
          lastAttemptedTarget: target,
          lastAttemptedAt: now()
        }
      })
      if (intentGeneration !== this.controlIntentGeneration) {
        throw new ControlError('connection.superseded', 'The connection attempt was superseded.', { retryable: true })
      }

      // The exact old authority must acknowledge cancellation before its
      // transport is replaced. New OAuth admission remains blocked throughout.
      await this.drainActiveRuntimeOAuthSessions()
      if (intentGeneration !== this.controlIntentGeneration) {
        throw new ControlError('connection.superseded', 'The connection attempt was superseded.', { retryable: true })
      }

      // Persist the locator attempt before changing any live connection state.
      // A failed cache write or OAuth drain must leave the existing connection,
      // poll lineage, and renderer authority internally consistent.
      this.intentionallyOffline = false
      const targetChanged = !this.target || !sameTarget(this.target, target)
      const expectedAuthorityChanged = effectiveExpectedHostId !== undefined &&
        this.authorityHostId !== effectiveExpectedHostId
      if (targetChanged || expectedAuthorityChanged) {
        this.authorityHostId = undefined
        this.authorityCapabilities = []
        this.authorityRuntimeReadiness = undefined
        this.authorityHealthLineage = undefined
      }
      this.target = target
      const generation = ++this.reconnectGeneration
      if (
        generation !== this.reconnectGeneration ||
        this.intentionallyOffline ||
        !this.target ||
        !sameTarget(this.target, target)
      ) {
        throw new ControlError('connection.superseded', 'The connection attempt was superseded.', { retryable: true })
      }
      // A locator is never itself authority. It may restore only a binding that
      // was learned from this target's prior health handshake.
      this.authorityHostId = effectiveExpectedHostId ?? findBoundHostId(cache, target)
      return await this.establish(target, 'connecting', generation, effectiveExpectedHostId)
    } finally {
      this.endOAuthConnectionTransition()
    }
  }

  async reconnect(): Promise<ConnectionState> {
    this.beginOAuthConnectionTransition()
    this.revokeResidentWorkspaceSelections('authority_changed')
    this.revokeResidentEndConfirmations('authority_changed')
    try {
      const target = this.target
      if (!target) {
        throw new ControlError('connection.no_target', 'There is no previous host to reconnect to.')
      }
      const expectedHostId = target.kind === 'ssh' ? this.authorityHostId : undefined
      this.controlIntentGeneration += 1
      this.intentionallyOffline = false
      const generation = ++this.reconnectGeneration
      await this.drainActiveRuntimeOAuthSessions()
      if (
        generation !== this.reconnectGeneration ||
        this.intentionallyOffline ||
        !this.target ||
        !sameTarget(this.target, target)
      ) {
        throw new ControlError('connection.superseded', 'The reconnection attempt was superseded.', { retryable: true })
      }
      return await this.establish(target, 'reconnecting', generation, expectedHostId)
    } finally {
      this.endOAuthConnectionTransition()
    }
  }

  async disconnect(): Promise<void> {
    this.beginOAuthConnectionTransition()
    this.revokeResidentWorkspaceSelections('authority_changed')
    this.revokeResidentEndConfirmations('authority_changed')
    try {
      this.intentionallyOffline = true
      this.controlIntentGeneration += 1
      this.reconnectGeneration += 1
      this.stopHealthPolling()
      this.stopNonterminalReconciliation()
      await this.drainActiveRuntimeOAuthSessions()
      const connection = this.connection
      if (connection) this.cancelThreadChangeRefreshesForConnection(connection)
      this.connection = undefined
      connection?.close()
      await this.drainNonterminalReconciliation()
      this.setState({
        phase: 'offline',
        target: this.target,
        ...(this.authorityHostId ? { hostId: this.authorityHostId } : {}),
        ...this.authorityObservationState(),
        since: now(),
        attempt: this.attempt
      })
    } finally {
      this.endOAuthConnectionTransition()
    }
  }

  /** Orderly application shutdown uses the same host-confirmed drain as disconnect. */
  async shutdown(): Promise<void> {
    await this.disconnect()
  }

  async hostCatalog(): Promise<unknown> {
    const authority = this.captureProjectionAuthority()
    const catalog = await authority.connection.request('catalog.snapshot', {})
    this.assertProjectionAuthority(authority, 'catalog refresh')
    await this.persistCatalog(catalog, authority)
    this.assertProjectionAuthority(authority, 'catalog refresh')
    return catalog
  }

  async projectCatalog(hostId: string): Promise<unknown> {
    const authority = this.captureProjectionAuthority()
    const catalog = await authority.connection.request('catalog.snapshot', {})
    this.assertProjectionAuthority(authority, 'project catalog refresh')
    await this.persistCatalog(catalog, authority)
    this.assertProjectionAuthority(authority, 'project catalog refresh')
    if (!isRecord(catalog) || !Array.isArray(catalog.projects)) return catalog
    return catalog.projects.filter(
      (project) => isRecord(project) && (project.hostId === hostId || !('hostId' in project))
    )
  }

  async runtimeModelCatalog(expectedHostId: string): Promise<RuntimeModelCatalogSnapshot> {
    const authority = this.captureProjectionAuthority()
    if (expectedHostId !== authority.hostId) {
      throw new ControlError(
        'runtime.model_catalog_authority_changed',
        'The selected host changed before its model catalog could be loaded.',
        { retryable: true, details: { expectedHostId, connectedHostId: authority.hostId } }
      )
    }
    const result = await authority.connection.request(
      'runtime.model_catalog',
      { expectedHostId },
      { timeoutMs: 45_000 }
    )
    this.assertProjectionAuthority(authority, 'runtime model catalog')
    return RuntimeModelCatalogSnapshotSchema.parse(result)
  }

  async candidateEvaluationPreflight(
    input: CandidateEvaluationPreflightRequest,
  ): Promise<CandidateEvaluationPreflight> {
    return await this.latency.measure('candidate.evaluation.preflight', async () => {
      const authority = this.captureCandidateEvaluationAuthority(input.expectedHostId)
      const result = await authority.connection.request(
        'candidate.evaluation.preflight',
        input,
        { timeoutMs: 60_000 },
      )
      this.assertProjectionAuthority(authority, 'candidate evaluation preflight')
      const preflight = CandidateEvaluationPreflightSchema.parse(result)
      assertCandidateEvaluationAuthority(input, preflight, 'preflight')
      return preflight
    })
  }

  async startCandidateEvaluation(
    input: CandidateEvaluationStartRequest,
  ): Promise<CandidateEvaluationStatus> {
    return await this.latency.measure('candidate.evaluation.start', async () => {
      const authority = this.captureCandidateEvaluationAuthority(input.expectedHostId)
      const result = await authority.connection.request(
        'candidate.evaluation.start',
        input,
        { timeoutMs: 60_000 },
      )
      this.assertProjectionAuthority(authority, 'candidate evaluation start')
      const status = CandidateEvaluationStatusSchema.parse(result)
      assertCandidateEvaluationAuthority(input, status, 'start')
      if (status.operationId !== input.operationId || !isDeepStrictEqual(status.review, input.expectedReview)) {
        throw new ControlError(
          'protocol.candidate_evaluation_identity_mismatch',
          'The candidate evaluation reply did not match the exact operation and passive review identity.',
        )
      }
      return status
    })
  }

  async candidateEvaluationSnapshot(
    input: CandidateEvaluationPreflightRequest,
  ): Promise<CandidateEvaluationSnapshot> {
    return await this.latency.measure('candidate.evaluation.snapshot', async () => {
      const authority = this.captureCandidateEvaluationAuthority(input.expectedHostId)
      const result = await authority.connection.request(
        'candidate.evaluation.snapshot',
        input,
        { timeoutMs: 30_000 },
      )
      this.assertProjectionAuthority(authority, 'candidate evaluation snapshot')
      const snapshot = CandidateEvaluationSnapshotSchema.parse(result)
      assertCandidateEvaluationAuthority(input, snapshot, 'snapshot')
      return snapshot
    })
  }

  async retryRuntimeIntegrity(expectedHostId: string): Promise<RuntimeIntegritySnapshot> {
    const authority = this.captureProjectionAuthority()
    if (expectedHostId !== authority.hostId) {
      throw new ControlError(
        'runtime.integrity_retry_authority_changed',
        'The selected host changed before runtime verification could be retried.',
        { retryable: true, details: { expectedHostId, connectedHostId: authority.hostId } }
      )
    }
    if (authority.target.kind !== 'local' || this.state.path !== 'local_socket') {
      throw new ControlError(
        'runtime.integrity_retry_local_required',
        'Runtime verification can be retried only on this computer.'
      )
    }
    if (!this.authorityCapabilities.includes(RUNTIME_INTEGRITY_RETRY_CAPABILITY)) {
      throw new ControlError(
        'runtime.integrity_retry_unavailable',
        'The current host state does not allow runtime verification to be retried.'
      )
    }
    const currentReadiness = this.authorityRuntimeReadiness
    if (
      currentReadiness?.kind !== 'reported' ||
      currentReadiness.hostId !== expectedHostId ||
      currentReadiness.snapshot.status !== 'failed' ||
      !currentReadiness.snapshot.retryable
    ) {
      throw new ControlError(
        'runtime.integrity_retry_state_changed',
        'Runtime verification is no longer in a retryable failed state.',
        { retryable: true }
      )
    }
    const previousSnapshot = currentReadiness.snapshot
    const raw = await authority.connection.request(
      'runtime.integrity.retry',
      { expectedHostId },
      { timeoutMs: 10_000, priority: 'urgent' }
    )
    this.assertProjectionAuthority(authority, 'runtime integrity retry')
    const parsed = RuntimeIntegritySnapshotSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.status !== 'initializing' ||
      !sameRuntimeIntegrityLineage(previousSnapshot, parsed.data)
    ) {
      const error = new ControlError(
        'protocol.runtime_integrity_retry_invalid',
        'The host returned an invalid runtime verification retry state.'
      )
      authority.connection.terminate(error)
      throw error
    }
    const snapshot = parsed.data
    this.authorityCapabilities = this.authorityCapabilities.filter(
      (capability) => capability !== RUNTIME_INTEGRITY_RETRY_CAPABILITY
    )
    this.authorityRuntimeReadiness = {
      ...currentReadiness,
      observedAt: now(),
      snapshot,
    }
    const { capabilities: _capabilities, runtimeReadiness: _runtimeReadiness, ...base } = this.state
    this.setState({ ...base, ...this.authorityObservationState() })
    this.scheduleHealthPoll(
      authority.connection,
      authority.target,
      authority.hostId,
      authority.generation,
    )
    return snapshot
  }

  async repairRuntimeIntegrity(input: RuntimeIntegrityRepairInput): Promise<RuntimeIntegritySnapshot> {
    const authority = this.captureProjectionAuthority()
    if (input.expectedHostId !== authority.hostId) {
      throw new ControlError(
        'runtime.integrity_repair_authority_changed',
        'The selected host changed before runtime repair could start.',
        { retryable: true }
      )
    }
    if (authority.target.kind !== 'local' || this.state.path !== 'local_socket') {
      throw new ControlError(
        'runtime.integrity_repair_local_required',
        'Runtime repair can be started only on this computer.'
      )
    }
    if (!this.authorityCapabilities.includes(RUNTIME_INTEGRITY_REPAIR_CAPABILITY)) {
      throw new ControlError(
        'runtime.integrity_repair_unavailable',
        'The current host state does not allow runtime repair.'
      )
    }
    const currentReadiness = this.authorityRuntimeReadiness
    if (
      currentReadiness?.kind !== 'reported' ||
      currentReadiness.hostId !== input.expectedHostId ||
      currentReadiness.snapshot.status !== 'failed' ||
      currentReadiness.snapshot.retryable ||
      currentReadiness.snapshot.trustAnchorId !== input.expectedTrustAnchorId ||
      currentReadiness.snapshot.changedAt !== input.expectedChangedAt ||
      !isDeepStrictEqual(currentReadiness.snapshot.target, input.expectedTarget)
    ) {
      throw new ControlError(
        'runtime.integrity_repair_state_changed',
        'Runtime repair authority changed before the operation could start.',
        { retryable: true }
      )
    }
    const previousSnapshot = currentReadiness.snapshot
    const raw = await authority.connection.request(
      'runtime.integrity.repair',
      input,
      { timeoutMs: 10_000, priority: 'urgent' }
    )
    this.assertProjectionAuthority(authority, 'runtime integrity repair')
    const parsed = RuntimeIntegritySnapshotSchema.safeParse(raw)
    if (
      !parsed.success ||
      parsed.data.status !== 'initializing' ||
      !sameRuntimeIntegrityLineage(previousSnapshot, parsed.data)
    ) {
      const error = new ControlError(
        'protocol.runtime_integrity_repair_invalid',
        'The host returned an invalid runtime repair state.'
      )
      authority.connection.terminate(error)
      throw error
    }
    const snapshot = parsed.data
    this.authorityCapabilities = this.authorityCapabilities.filter(
      (capability) => capability !== RUNTIME_INTEGRITY_REPAIR_CAPABILITY
    )
    this.authorityRuntimeReadiness = {
      ...currentReadiness,
      observedAt: now(),
      snapshot,
    }
    const { capabilities: _capabilities, runtimeReadiness: _runtimeReadiness, ...base } = this.state
    this.setState({ ...base, ...this.authorityObservationState() })
    this.scheduleHealthPoll(
      authority.connection,
      authority.target,
      authority.hostId,
      authority.generation,
    )
    return snapshot
  }

  async startRuntimeOAuth(expectedHostId: string, providerId: string): Promise<RuntimeOAuthSessionView> {
    this.assertRuntimeOAuthAdmissionOpen()
    if (providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID) {
      throw new ControlError('runtime.oauth_provider_unavailable', 'This desktop checkpoint supports ChatGPT sign-in only.')
    }
    let releaseRegistration!: () => void
    let registrationReleased = false
    const registration = new Promise<void>((resolve) => {
      releaseRegistration = () => {
        if (registrationReleased) return
        registrationReleased = true
        resolve()
      }
    })
    this.oauthStartRegistrations.add(registration)
    let active: ActiveRuntimeOAuthSession | undefined
    const operationId = randomUUID()
    try {
      const authority = this.captureLocalOAuthAuthority(expectedHostId)
      const transitionGeneration = this.oauthTransitionGeneration
      const ambiguityKey = this.runtimeOAuthAmbiguityKey(authority, providerId)
      let raw: unknown
      try {
        raw = await authority.connection.request(
          'oauth.session.start',
          { expectedHostId, authorityId: this.oauthAuthorityId, providerId, operationId },
          { timeoutMs: 30_000 }
        )
      } catch (cause) {
        // A lost response may follow provider-login admission. Never replay the
        // effect-bearing start request; only the durable read-only attempt
        // reconciliation vertical may clear this ambiguity.
        this.ambiguousOAuthStarts.set(ambiguityKey, { authority, providerId })
        throw new ControlError(
          'runtime.oauth_start_ambiguous',
          'The host may have started sign-in, but its session identity could not be recovered. Keep this host connected while Prime Continuim checks the original attempt.',
          { retryable: true, cause }
        )
      }
      // Until the returned identity is parsed and bound, treat the admitted
      // start as ambiguous so a protocol violation cannot permit disconnect.
      this.ambiguousOAuthStarts.set(ambiguityKey, { authority, providerId })
      const recoveredIdentity = recoverRuntimeOAuthIdentity(raw)
      if (recoveredIdentity) {
        active = this.registerActiveRuntimeOAuthSession(authority, recoveredIdentity)
        this.ambiguousOAuthStarts.delete(ambiguityKey)
      }
      let snapshot = parseRuntimeOAuthSnapshot(raw)
      const sessionId = snapshot.sessionId
      this.assertRuntimeOAuthSnapshotBinding(snapshot, sessionId, providerId)
      active ??= this.registerActiveRuntimeOAuthSession(authority, snapshot)
      this.ambiguousOAuthStarts.delete(ambiguityKey)
      releaseRegistration()
      this.assertProjectionAuthority(authority, 'OAuth session start')
      if (
        transitionGeneration !== this.oauthTransitionGeneration ||
        this.oauthTransitionBlockCount > 0 ||
        active.closing
      ) {
        throw new ControlError(
          'runtime.oauth_transition_in_progress',
          'Sign-in was cancelled because the host connection is changing.',
          { retryable: true }
        )
      }

      // Provider login starts asynchronously. Give the verified helper a
      // bounded window to publish its browser URL. Every poll remains bound to
      // the original session/provider before its result may affect main.
      const deadline = Date.now() + 5_000
      while (
        !snapshot.authorization &&
        !snapshot.challenge &&
        (snapshot.phase === 'starting' || snapshot.phase === 'awaiting_user') &&
        Date.now() < deadline
      ) {
        await delay(50)
        if (active.closing) {
          throw new ControlError('runtime.oauth_session_closing', 'The sign-in session is closing.', { retryable: true })
        }
        this.assertProjectionAuthority(authority, 'OAuth session start')
        let polledRaw: unknown
        try {
          polledRaw = await authority.connection.request(
            'oauth.session.status',
            { expectedHostId, authorityId: this.oauthAuthorityId, sessionId },
            { timeoutMs: 10_000 }
          )
        } catch {
          throw new ControlError(
            'runtime.oauth_status_failed',
            'Prime Agent sign-in status could not be read from this host.',
            { retryable: true }
          )
        }
        const polledSnapshot = parseRuntimeOAuthSnapshot(polledRaw)
        this.assertRuntimeOAuthSnapshotBinding(polledSnapshot, sessionId, providerId)
        snapshot = polledSnapshot
      }
      return await this.presentRuntimeOAuthSnapshot(active, snapshot)
    } catch (error) {
      if (active && !active.closing) {
        // Protocol/authority failures after the host created a session must not
        // leave that exact helper eligible to commit credentials unnoticed.
        await this.cancelAndRetireActiveRuntimeOAuthSession(active).catch(() => undefined)
      }
      throw error
    } finally {
      releaseRegistration()
      this.oauthStartRegistrations.delete(registration)
    }
  }

  async runtimeOAuthStatus(expectedHostId: string, sessionId: string): Promise<RuntimeOAuthSessionView> {
    this.assertRuntimeOAuthAdmissionOpen()
    const active = this.requireActiveRuntimeOAuthSession(expectedHostId, sessionId)
    if (active.closing) {
      throw new ControlError('runtime.oauth_session_closing', 'The sign-in session is closing.', { retryable: true })
    }
    let raw: unknown
    try {
      raw = await active.authority.connection.request(
        'oauth.session.status',
        { expectedHostId, authorityId: this.oauthAuthorityId, sessionId },
        { timeoutMs: 10_000 }
      )
    } catch {
      throw new ControlError(
        'runtime.oauth_status_failed',
        'Prime Agent sign-in status could not be read from this host.',
        { retryable: true }
      )
    }
    this.assertProjectionAuthority(active.authority, 'OAuth session status')
    const snapshot = parseRuntimeOAuthSnapshot(raw)
    this.assertRuntimeOAuthSnapshotBinding(snapshot, sessionId, active.providerId)
    return await this.presentRuntimeOAuthSnapshot(active, snapshot)
  }

  async cancelRuntimeOAuth(expectedHostId: string, sessionId: string): Promise<RuntimeOAuthSessionView> {
    const active = this.requireActiveRuntimeOAuthSession(expectedHostId, sessionId)
    active.closing = true
    try {
      const snapshot = await this.requestActiveRuntimeOAuthCancellation(active, 15_000)
      this.assertProjectionAuthority(active.authority, 'OAuth session cancellation')
      return await this.presentRuntimeOAuthSnapshot(active, snapshot)
    } catch (error) {
      if (this.activeOAuthSessions.get(this.runtimeOAuthSessionKey(active.authority.hostId, sessionId)) === active) {
        active.closing = false
      }
      throw error
    }
  }

  async selectResidentWorkspace(
    input: ResidentWorkspaceSelectionInput = {},
  ): Promise<ResidentWorkspaceSelection> {
    return await this.latency.measure('resident.workspace.select', async () => {
      const normalized = normalizeResidentWorkspaceSelectionInput(input)
      if (normalized.kind === 'registered_workspace') {
        return await this.selectRegisteredResidentWorkspace(normalized)
      }
      return await this.selectLocalResidentWorkspace(normalized.resumeOperationId)
    })
  }

  private async selectLocalResidentWorkspace(
    resumeOperationId?: string,
  ): Promise<ResidentWorkspaceSelection> {
      const authority = this.captureLocalResidentProvisionAuthority()
      const initialRecovery = resumeOperationId === undefined
        ? undefined
        : await this.requireLocalResidentWorkspaceRecoveryEntry(resumeOperationId, authority)
      if (!this.selectDirectory) {
        throw new ControlError(
          'resident.workspace_picker_unavailable',
          'The native workspace picker is unavailable.'
        )
      }

      let selectedDirectory: string | undefined
      try {
        selectedDirectory = await this.selectDirectory()
      } catch {
        // Native dialog errors can contain the selected filesystem path. Keep
        // the renderer-facing failure deliberately generic.
        throw new ControlError(
          'resident.workspace_picker_failed',
          'The native workspace picker could not be opened.',
          { retryable: true }
        )
      }
      this.captureLocalResidentProvisionAuthority(authority.hostId)
      this.assertProjectionAuthority(authority, 'resident workspace selection')
      if (selectedDirectory === undefined) {
        throw new ControlError(
          'resident.workspace_selection_cancelled',
          'No workspace folder was selected.'
        )
      }

      const workspaceDirectory = normalizeSelectedWorkspaceDirectory(selectedDirectory)
      const recovery = resumeOperationId === undefined
        ? undefined
        : await this.requireLocalResidentWorkspaceRecoveryEntry(resumeOperationId, authority)
      this.captureLocalResidentProvisionAuthority(authority.hostId)
      this.assertProjectionAuthority(authority, 'resident workspace selection')
      if (
        initialRecovery &&
        recovery &&
        !sameResidentWorkspaceRecoverySource(initialRecovery, recovery)
      ) {
        throw new ControlError(
          'resident.workspace_resume_changed',
          'The durable resident operation changed while its workspace was being selected.',
          { retryable: true }
        )
      }
      this.expireResidentWorkspaceSelections()
      this.revokeResidentWorkspaceSelections('superseded')

      const selectionToken = randomUUID()
      const operationId = recovery && shouldReuseResidentLifecycleOperation(recovery)
        ? recovery.operationId
        : `resident-${randomUUID()}`
      const createdAt = recovery?.createdAt ?? now()
      const selection = Object.freeze({
        selectionToken,
        operationId,
        expectedHostId: authority.hostId,
        suggestedName: suggestedWorkspaceName(workspaceDirectory),
        expiresAt: new Date(Date.now() + RESIDENT_SELECTION_TTL_MS).toISOString(),
      })
      const record: ResidentWorkspaceSelectionRecord = {
        provisionMode: 'local_path',
        selectionToken,
        authority,
        workspaceDirectory,
        selection,
        projectId: recovery?.projectId ?? `project-${randomUUID()}`,
        workspaceId: recovery?.workspaceId ?? `workspace-${randomUUID()}`,
        threadId: recovery?.threadId ?? `thread-${randomUUID()}`,
        executionGenerationId: recovery?.executionGenerationId ?? `execution-${randomUUID()}`,
        createdAt,
        durableOperationPossible: false,
        ...(recovery
          ? {
              provisionMetadata: Object.freeze({
                projectDisplayName: recovery.projectDisplayName,
                threadTitle: recovery.threadTitle,
                ...(recovery.sessionName === undefined ? {} : { sessionName: recovery.sessionName }),
              }),
            }
          : {}),
      }
      this.residentWorkspaceSelections.set(selectionToken, record)
      this.enforceResidentSelectionLimit()
      return { ...selection }
  }

  private async selectRegisteredResidentWorkspace(
    input: Extract<ResidentWorkspaceSelectionInput, { kind: 'registered_workspace' }>,
  ): Promise<ResidentWorkspaceSelection> {
    const authority = this.captureRegisteredResidentWorkspaceAuthority()
    const recovery = input.resumeOperationId === undefined
      ? undefined
      : await this.requireRegisteredResidentWorkspaceRecoveryEntry(
          input,
          input.resumeOperationId,
          authority,
        )
    const projectDisplayName = await this.revalidateRegisteredWorkspaceReference(input, authority)
    this.captureRegisteredResidentWorkspaceAuthority(authority.hostId)
    this.assertProjectionAuthority(authority, 'registered resident workspace selection')

    this.expireResidentWorkspaceSelections()
    this.revokeResidentWorkspaceSelections('superseded')

    const selectionToken = randomUUID()
    const selection = Object.freeze({
      selectionToken,
      operationId: recovery && shouldReuseResidentLifecycleOperation(recovery)
        ? recovery.operationId
        : `resident-${randomUUID()}`,
      expectedHostId: authority.hostId,
      suggestedName: projectDisplayName,
      expiresAt: new Date(Date.now() + RESIDENT_SELECTION_TTL_MS).toISOString(),
    })
    const record: RegisteredResidentWorkspaceSelectionRecord = {
      provisionMode: 'registered_workspace',
      selectionToken,
      authority,
      selection,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      referenceThreadId: input.referenceThreadId,
      referenceExecutionGenerationId: input.referenceExecutionGenerationId,
      threadId: recovery?.threadId ?? `thread-${randomUUID()}`,
      executionGenerationId: recovery?.executionGenerationId ?? `execution-${randomUUID()}`,
      createdAt: recovery?.createdAt ?? now(),
      durableOperationPossible: false,
      ...(recovery
        ? {
            provisionMetadata: Object.freeze({
              projectDisplayName,
              threadTitle: recovery.threadTitle,
              ...(recovery.sessionName === undefined ? {} : { sessionName: recovery.sessionName }),
            }),
          }
        : {}),
    }
    this.residentWorkspaceSelections.set(selectionToken, record)
    this.enforceResidentSelectionLimit()
    return { ...selection }
  }

  async provisionResident(input: ResidentProvisionInput): Promise<ResidentLifecycleStatus> {
    let record: ResidentWorkspaceSelectionRecord | undefined
    try {
      record = this.requireResidentWorkspaceSelection(input.selectionToken)
      const normalizedMetadata = normalizeResidentProvisionMetadata(input)
      const metadata = record.provisionMode === 'registered_workspace'
        ? Object.freeze({
            ...normalizedMetadata,
            projectDisplayName: record.selection.suggestedName,
          })
        : normalizedMetadata
      if (record.provisionMetadata && !sameResidentProvisionMetadata(record.provisionMetadata, metadata)) {
        throw new ControlError(
          'resident.provision_identity_conflict',
          'This workspace selection was already bound to different provisioning details.'
        )
      }
      record.provisionMetadata ??= metadata
      if (record.inFlight) {
        return await record.inFlight
      }
      this.assertResidentSelectionAuthority(record, 'resident provisioning')

      let operation!: Promise<ResidentLifecycleStatus>
      const activeRecord = record
      operation = this.runResidentProvision(activeRecord).finally(() => {
        if (activeRecord.inFlight !== operation) return
        activeRecord.inFlight = undefined
        if (activeRecord.pendingRetirement) {
          this.retireResidentWorkspaceSelection(
            activeRecord.selectionToken,
            activeRecord.pendingRetirement,
          )
        }
      })
      activeRecord.inFlight = operation
      return await operation
    } catch (error) {
      throw residentProvisionErrorWithDurability(error, record?.durableOperationPossible === true)
    }
  }

  async prepareResidentEnd(input: ResidentEndPreparationInput): Promise<ResidentEndPreparation> {
    return await this.latency.measure('resident.end.prepare', async () => {
      const normalized = normalizeResidentEndPreparationInput(input)
      const authority = this.captureResidentEndAuthority(normalized.expectedHostId)
      const ledger = await this.readResidentLifecycleLedger()
      this.assertProjectionAuthority(authority, 'resident end confirmation')

      let operationId = `resident-end-${randomUUID()}`
      let createdAt = now()
      let expectedSourceCursor: SessionCursor | undefined
      if (normalized.resumeOperationId) {
        const entry = ledger.entries.find(
          (candidate) =>
            candidate.expectedHostId === normalized.expectedHostId &&
            candidate.operationId === normalized.resumeOperationId
        )
        if (!entry || entry.kind !== 'end') {
          throw new ControlError(
            'resident.end_resume_unknown',
            'The resident end operation selected for recovery is not available.'
          )
        }
        if (!residentEndIdentityMatches(entry, normalized)) {
          throw new ControlError(
            'resident.end_resume_identity_changed',
            'The resident end operation belongs to a different thread lineage.'
          )
        }
        if (
          entry.state !== 'submitted' ||
          entry.lastStatus?.kind !== 'end' ||
          entry.lastStatus.phase !== 'ending'
        ) {
          throw new ControlError(
            'resident.end_resume_not_allowed',
            'This end operation may only be checked for durable status; it cannot send another end request.'
          )
        }
        operationId = entry.operationId
        createdAt = entry.createdAt
        expectedSourceCursor = entry.sourceCursor
      } else {
        const existing = ledger.entries.find(
          (candidate) => candidate.kind === 'end' && residentEndIdentityMatches(candidate, normalized)
        )
        if (existing) {
          throw new ControlError(
            'resident.end_recovery_required',
            'A durable end operation already owns this resident session. Check its status before continuing.',
            {
              retryable: false,
              details: { expectedHostId: existing.expectedHostId, operationId: existing.operationId },
            }
          )
        }
      }

      const sourceCursor = await this.captureResidentEndSourceCursor(normalized, authority)
      if (expectedSourceCursor && !sameSessionCursor(expectedSourceCursor, sourceCursor)) {
        throw new ControlError(
          'resident.end_source_projection_changed',
          'The thread projection changed after this end operation was recorded. Check its durable status.'
        )
      }
      this.assertProjectionAuthority(authority, 'resident end confirmation')
      this.expireResidentEndConfirmations()
      this.revokeResidentEndConfirmations('superseded')

      const confirmationToken = randomUUID()
      const confirmation = Object.freeze({
        confirmationToken,
        operationId,
        expectedHostId: normalized.expectedHostId,
        threadId: normalized.threadId,
        executionGenerationId: normalized.executionGenerationId,
        expiresAt: new Date(Date.now() + RESIDENT_END_CONFIRMATION_TTL_MS).toISOString(),
      })
      this.residentEndConfirmations.set(confirmationToken, {
        confirmation,
        authority,
        identity: {
          expectedHostId: normalized.expectedHostId,
          projectId: normalized.projectId,
          workspaceId: normalized.workspaceId,
          threadId: normalized.threadId,
          executionGenerationId: normalized.executionGenerationId,
        },
        sourceCursor,
        createdAt,
      })
      this.enforceResidentEndConfirmationLimit()
      return { ...confirmation }
    })
  }

  async endResident(input: ResidentEndInput): Promise<ResidentLifecycleStatus> {
    if (input.consent !== true) {
      throw new ControlError(
        'resident.end_consent_required',
        'Ending a resident session requires explicit confirmation.'
      )
    }
    const record = this.requireResidentEndConfirmation(input.confirmationToken)
    // Confirmation authorization is consumed before any durable or host work.
    // A raced renderer call therefore cannot produce a second kill request.
    this.retireResidentEndConfirmation(input.confirmationToken, 'consumed')
    this.assertResidentEndConfirmationAuthority(record)
    return await this.runResidentEnd(record)
  }

  async residentLifecycleStatus(
    input: { expectedHostId: string; operationId: string }
  ): Promise<ResidentLifecycleLookupResult> {
    // Durable lookup remains available when the runtime/Worker is temporarily
    // unavailable and health therefore withdraws the provisioning capability.
    const authority = this.captureResidentStatusAuthority(input.expectedHostId)
    const raw = await authority.connection.request(
      'resident.lifecycle.status',
      input,
      { timeoutMs: 30_000 }
    )
    this.assertProjectionAuthority(authority, 'resident lifecycle status')
    const lookup = ResidentLifecycleLookupResultSchema.parse(raw)
    if (lookup.status) {
      const status = await this.acceptResidentLifecycleStatus(
        lookup.status,
        authority,
        input.operationId,
      )
      this.assertProjectionAuthority(authority, 'resident lifecycle status')
      return { status }
    } else {
      await this.markResidentLifecycleStatusMissing(authority, input.operationId)
    }
    this.assertProjectionAuthority(authority, 'resident lifecycle status')
    return { status: null }
  }

  private captureLocalOAuthAuthority(expectedHostId: string): CapturedProjectionAuthority {
    const authority = this.captureProjectionAuthority()
    if (authority.hostId !== expectedHostId) {
      throw new ControlError(
        'runtime.oauth_authority_changed',
        'The selected host changed before sign-in could start.',
        { retryable: true, details: { expectedHostId, connectedHostId: authority.hostId } }
      )
    }
    if (authority.target.kind !== 'local' || this.state.path !== 'local_socket') {
      throw new ControlError(
        'runtime.oauth_local_required',
        'ChatGPT sign-in currently requires Prime Continuim and Prime Agent to run on the same computer.'
      )
    }
    if (!this.authorityCapabilities.includes(RUNTIME_OAUTH_CAPABILITY)) {
      throw new ControlError(
        'runtime.oauth_unavailable',
        'The connected host does not expose the verified Prime Agent sign-in capability.',
        { retryable: true }
      )
    }
    return authority
  }

  private async presentRuntimeOAuthSnapshot(
    active: ActiveRuntimeOAuthSession,
    snapshot: RuntimeOAuthSessionSnapshot
  ): Promise<RuntimeOAuthSessionView> {
    const authority = active.authority
    const sessionKey = this.runtimeOAuthSessionKey(authority.hostId, snapshot.sessionId)
    if (snapshot.authorization && !this.openedOAuthSessions.has(sessionKey)) {
      if (
        snapshot.providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID ||
        !isPinnedCodexAuthorizationUrl(snapshot.authorization.url)
      ) {
        await this.cancelAndRetireActiveRuntimeOAuthSession(active).catch(() => undefined)
        throw new ControlError(
          'protocol.oauth_authorization_invalid',
          'The host returned an authorization destination outside the verified Codex provider contract.'
        )
      }
      const existingOpening = this.openingOAuthSessions.get(sessionKey)
      if (existingOpening && existingOpening.url !== snapshot.authorization.url) {
        await this.cancelAndRetireActiveRuntimeOAuthSession(active).catch(() => undefined)
        throw new ControlError(
          'protocol.oauth_authorization_changed',
          'The host changed the authorization destination for an active sign-in session.'
        )
      }
      let opening = existingOpening
      if (!opening) {
        const url = snapshot.authorization.url
        let promise!: Promise<void>
        promise = (async () => {
          try {
            await this.openRuntimeOAuthAuthorization(active, url)
          } finally {
            const retained = this.openingOAuthSessions.get(sessionKey)
            if (retained?.promise === promise) this.openingOAuthSessions.delete(sessionKey)
          }
        })()
        opening = { url, promise }
        this.openingOAuthSessions.set(sessionKey, opening)
      }
      // All concurrent callers await the one opening promise. No renderer sees
      // "opened" until the shell succeeds and the original authority remains.
      await opening.promise
    }

    if (isTerminalRuntimeOAuthPhase(snapshot.phase)) {
      this.openedOAuthSessions.delete(sessionKey)
      if (this.activeOAuthSessions.get(sessionKey) === active) this.activeOAuthSessions.delete(sessionKey)
    }
    const interaction: RuntimeOAuthSessionView['interaction'] = snapshot.authorization && this.openedOAuthSessions.has(sessionKey)
      ? { kind: 'browser', state: 'opened' }
      : snapshot.challenge?.kind === 'select'
        ? { kind: 'selection', state: 'unavailable' }
        : snapshot.challenge
          ? { kind: 'manual', state: 'unavailable' }
          : undefined
    return Object.freeze({
      sessionId: snapshot.sessionId,
      providerId: snapshot.providerId,
      phase: snapshot.phase,
      expiresAt: snapshot.expiresAt,
      ...(interaction ? { interaction } : {}),
      ...(snapshot.configured ? { configured: true as const } : {}),
      ...(snapshot.error
        ? {
            // Provider messages may contain redirect details or other
            // credential-adjacent text. Only the fixed classification crosses
            // the context-isolated preload boundary.
            error: Object.freeze({
              code: snapshot.error.code,
              retryable: snapshot.error.retryable,
            }),
          }
        : {})
    })
  }

  private assertRuntimeOAuthSnapshotBinding(
    snapshot: RuntimeOAuthSessionSnapshot,
    expectedSessionId: string,
    expectedProviderId: string
  ): void {
    if (snapshot.sessionId !== expectedSessionId) {
      throw new ControlError('protocol.oauth_session_mismatch', 'The host returned a different OAuth session.')
    }
    if (snapshot.providerId !== expectedProviderId) {
      throw new ControlError('protocol.oauth_provider_mismatch', 'The host returned an OAuth session for another provider.')
    }
  }

  private async openRuntimeOAuthAuthorization(
    active: ActiveRuntimeOAuthSession,
    url: string
  ): Promise<void> {
    const sessionKey = this.runtimeOAuthSessionKey(active.authority.hostId, active.sessionId)
    this.assertProjectionAuthority(active.authority, 'OAuth browser launch')
    if (active.closing || this.activeOAuthSessions.get(sessionKey) !== active) {
      throw new ControlError('runtime.oauth_session_closing', 'The sign-in session is closing.', { retryable: true })
    }
    if (!this.openExternal) {
      throw new ControlError('runtime.oauth_browser_unavailable', 'The system browser is unavailable for sign-in.')
    }
    try {
      await this.openExternal(url)
    } catch {
      await this.cancelAndRetireActiveRuntimeOAuthSession(active).catch(() => undefined)
      throw new ControlError('runtime.oauth_browser_failed', 'The system browser could not open the sign-in page.', {
        retryable: true
      })
    }
    if (active.closing || this.activeOAuthSessions.get(sessionKey) !== active) {
      throw new ControlError('runtime.oauth_session_closing', 'The sign-in session closed while its browser opened.', {
        retryable: true
      })
    }
    try {
      this.assertProjectionAuthority(active.authority, 'OAuth browser launch')
    } catch (error) {
      await this.cancelAndRetireActiveRuntimeOAuthSession(active).catch(() => undefined)
      throw error
    }
    this.openedOAuthSessions.add(sessionKey)
  }

  private registerActiveRuntimeOAuthSession(
    authority: CapturedProjectionAuthority,
    snapshot: Pick<RuntimeOAuthSessionSnapshot, 'sessionId' | 'providerId'>
  ): ActiveRuntimeOAuthSession {
    const sessionKey = this.runtimeOAuthSessionKey(authority.hostId, snapshot.sessionId)
    const existing = this.activeOAuthSessions.get(sessionKey)
    if (existing) {
      if (
        existing.providerId !== snapshot.providerId ||
        existing.authority.connection !== authority.connection ||
        existing.authority.generation !== authority.generation ||
        !sameTarget(existing.authority.target, authority.target)
      ) {
        throw new ControlError('protocol.oauth_session_ambiguous', 'The host reused an OAuth session outside its authority.')
      }
      return existing
    }
    const active: ActiveRuntimeOAuthSession = {
      authority,
      sessionId: snapshot.sessionId,
      providerId: snapshot.providerId,
      closing: false
    }
    this.activeOAuthSessions.set(sessionKey, active)
    return active
  }

  private async cancelAndRetireActiveRuntimeOAuthSession(
    active: ActiveRuntimeOAuthSession
  ): Promise<void> {
    active.closing = true
    await this.requestActiveRuntimeOAuthCancellation(active, 5_000)
    const sessionKey = this.runtimeOAuthSessionKey(active.authority.hostId, active.sessionId)
    if (this.activeOAuthSessions.get(sessionKey) === active) this.activeOAuthSessions.delete(sessionKey)
    this.openedOAuthSessions.delete(sessionKey)
  }

  private async requestActiveRuntimeOAuthCancellation(
    active: ActiveRuntimeOAuthSession,
    timeoutMs: number
  ): Promise<RuntimeOAuthSessionSnapshot> {
    if (!active.cancellationPromise) {
      const cancellation = (async () => {
        let raw: unknown
        try {
          raw = await active.authority.connection.request(
            'oauth.session.cancel',
            {
              expectedHostId: active.authority.hostId,
              authorityId: this.oauthAuthorityId,
              sessionId: active.sessionId
            },
            { timeoutMs, priority: 'urgent' }
          )
        } catch {
          throw new ControlError(
            'runtime.oauth_cancel_failed',
            'Prime Agent sign-in cancellation could not be confirmed by this host.',
            { retryable: true }
          )
        }
        const snapshot = parseRuntimeOAuthSnapshot(raw)
        this.assertRuntimeOAuthSnapshotBinding(snapshot, active.sessionId, active.providerId)
        if (!isTerminalRuntimeOAuthPhase(snapshot.phase)) {
          throw new ControlError('protocol.oauth_cancel_not_terminal', 'The host did not confirm sign-in cancellation.')
        }
        return snapshot
      })()
      active.cancellationPromise = cancellation
      void cancellation.catch(() => {
        if (active.cancellationPromise === cancellation) active.cancellationPromise = undefined
      })
    }
    return active.cancellationPromise
  }

  private requireActiveRuntimeOAuthSession(
    expectedHostId: string,
    sessionId: string
  ): ActiveRuntimeOAuthSession {
    const sessionKey = this.runtimeOAuthSessionKey(expectedHostId, sessionId)
    const active = this.activeOAuthSessions.get(sessionKey)
    if (!active) {
      throw new ControlError(
        'runtime.oauth_session_untracked',
        'This app process does not own the requested sign-in session. Start sign-in again.',
        { retryable: true }
      )
    }
    const authority = this.captureLocalOAuthAuthority(expectedHostId)
    if (
      authority.connection !== active.authority.connection ||
      authority.generation !== active.authority.generation ||
      !sameTarget(authority.target, active.authority.target)
    ) {
      throw new ControlError('runtime.oauth_authority_changed', 'The sign-in session belongs to an older host authority.', {
        retryable: true
      })
    }
    return active
  }

  private runtimeOAuthSessionKey(hostId: string, sessionId: string): string {
    return `${hostId}\u0000${sessionId}`
  }

  private runtimeOAuthAmbiguityKey(authority: CapturedProjectionAuthority, providerId: string): string {
    return `${authority.hostId}\u0000${providerId}`
  }

  private assertRuntimeOAuthAdmissionOpen(): void {
    if (this.oauthTransitionBlockCount > 0) {
      throw new ControlError(
        'runtime.oauth_transition_in_progress',
        'Sign-in is unavailable while the host connection is changing.',
        { retryable: true }
      )
    }
  }

  private beginOAuthConnectionTransition(): void {
    this.oauthTransitionBlockCount += 1
    this.oauthTransitionGeneration += 1
  }

  private endOAuthConnectionTransition(): void {
    this.oauthTransitionBlockCount = Math.max(0, this.oauthTransitionBlockCount - 1)
  }

  private drainActiveRuntimeOAuthSessions(): Promise<void> {
    this.oauthDrainPromise ??= this.performRuntimeOAuthDrain().finally(() => {
      this.oauthDrainPromise = undefined
    })
    return this.oauthDrainPromise
  }

  private async performRuntimeOAuthDrain(): Promise<void> {
    const registrations = [...this.oauthStartRegistrations]
    if (registrations.length > 0) {
      await withOperationBound(
        Promise.all(registrations).then(() => undefined),
        OAUTH_START_REGISTRATION_TIMEOUT_MS,
        () => new ControlError(
          'runtime.oauth_drain_unconfirmed',
          'An in-flight sign-in could not be bound before the host transition.',
          { retryable: true }
        )
      )
    }

    if (this.ambiguousOAuthStarts.size > 0) {
      throw new ControlError(
        'runtime.oauth_drain_unconfirmed',
        'A sign-in start has no confirmed session identity. Retry sign-in on the same host before changing connections.',
        { retryable: true }
      )
    }

    const sessions = [...this.activeOAuthSessions.values()]
    if (sessions.length === 0) return
    for (const session of sessions) session.closing = true

    const cancellations = await Promise.allSettled(sessions.map(async (session) => {
      await this.requestActiveRuntimeOAuthCancellation(session, 10_000)
    }))
    const cancellationFailures = cancellations.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (cancellationFailures.length > 0) {
      throw new ControlError(
        'runtime.oauth_drain_unconfirmed',
        'The host did not confirm every active sign-in session as closed.',
        { retryable: true, cause: new AggregateError(cancellationFailures) }
      )
    }

    const openings = sessions.flatMap((session) => {
      const opening = this.openingOAuthSessions.get(
        this.runtimeOAuthSessionKey(session.authority.hostId, session.sessionId)
      )
      return opening ? [opening.promise] : []
    })
    if (openings.length > 0) {
      await withOperationBound(
        Promise.allSettled(openings).then(() => undefined),
        OAUTH_DRAIN_TIMEOUT_MS,
        () => new ControlError(
          'runtime.oauth_drain_unconfirmed',
          'The system browser launch did not settle before the host transition.',
          { retryable: true }
        )
      )
    }

    for (const session of sessions) {
      const sessionKey = this.runtimeOAuthSessionKey(session.authority.hostId, session.sessionId)
      if (this.activeOAuthSessions.get(sessionKey) === session) this.activeOAuthSessions.delete(sessionKey)
      this.openedOAuthSessions.delete(sessionKey)
    }
  }

  private abandonRuntimeOAuthSessionsForConnection(connection: FramedConnection): void {
    // An unexpected transport loss cannot be acknowledged by the host. Forget
    // only main's local handles; hostd retains authority and expires helpers by
    // its bounded TTL. Explicit disconnect/switch never takes this path.
    for (const [sessionKey, session] of this.activeOAuthSessions) {
      if (session.authority.connection !== connection) continue
      session.closing = true
      this.activeOAuthSessions.delete(sessionKey)
      this.openedOAuthSessions.delete(sessionKey)
    }
    for (const [ambiguityKey, start] of this.ambiguousOAuthStarts) {
      if (start.authority.connection === connection) this.ambiguousOAuthStarts.delete(ambiguityKey)
    }
  }

  async threadProjection(threadId: string, cursor?: SessionCursor): Promise<unknown> {
    return await this.requestSnapshot({ threadId, ...(cursor ? { cursor } : {}) })
  }

  async requestSnapshot(input: { threadId?: string; cursor?: SessionCursor }): Promise<unknown> {
    return await this.latency.measure('thread.attach_snapshot', async () => {
      const authority = this.captureProjectionAuthority()
      const threadId = input.threadId ?? input.cursor?.threadId
      if (input.threadId && input.cursor && input.cursor.threadId !== input.threadId) {
        throw new ControlError(
          'protocol.snapshot_cursor_mismatch',
          'The requested cursor belongs to a different thread.'
        )
      }
      if (!threadId) {
        const catalog = await authority.connection.request('catalog.snapshot', {}, { timeoutMs: 45_000 })
        this.assertProjectionAuthority(authority, 'catalog snapshot')
        await this.persistCatalog(catalog, authority)
        this.assertProjectionAuthority(authority, 'catalog snapshot')
        return catalog
      }
      const snapshot = await authority.connection.request(
        'thread.snapshot',
        { threadId, ...(input.cursor ? { cursor: input.cursor } : {}) },
        { timeoutMs: 45_000 }
      )
      this.assertProjectionAuthority(authority, 'thread snapshot')
      const parsedSnapshot = ThreadProjectionSnapshotSchema.parse(snapshot)
      if (parsedSnapshot.thread.threadId !== threadId) {
        throw new ControlError(
          'protocol.snapshot_thread_mismatch',
          'The host returned a snapshot for a different thread.',
          {
            details: { expectedThreadId: threadId, receivedThreadId: parsedSnapshot.thread.threadId }
          }
        )
      }
      if (parsedSnapshot.thread.currentLocation.hostId !== authority.hostId) {
        throw new ControlError('protocol.authority_mismatch', 'The thread snapshot belongs to a different host authority.', {
          details: {
            expectedHostId: authority.hostId,
            receivedHostId: parsedSnapshot.thread.currentLocation.hostId,
            threadId
          }
        })
      }
      await this.persistThreadSnapshot(parsedSnapshot, authority)
      this.assertProjectionAuthority(authority, 'thread snapshot')
      return parsedSnapshot
    })
  }

  async submitCommand(command: ClientCommand): Promise<CommandReceipt> {
    return await this.withResidentEndMutationFence(
      residentEndMutationKey({
        expectedHostId: command.expectedHostId,
        threadId: command.threadId,
        executionGenerationId: command.expectedExecutionGenerationId,
      }),
      () => this.submitCommandUnlocked(command),
    )
  }

  private async submitCommandUnlocked(command: ClientCommand): Promise<CommandReceipt> {
    const envelope = adaptCommand(command)
    const hostId = this.requireAuthorityHostId(
      'This command cannot be queued until the app has verified the destination host identity at least once.'
    )
    if (command.expectedHostId !== hostId) {
      throw new ControlError(
        'command.host_authority_changed',
        'The visible thread belongs to a different host than the current connection. Refresh before sending.',
        {
          retryable: true,
          details: { expectedHostId: command.expectedHostId, activeHostId: hostId }
        }
      )
    }
    await this.assertResidentEndDoesNotBlockCommand(command)
    const pendingEntry: ScopedOutboxEntry = { hostId, command, state: 'uncertain', updatedAt: now() }
    // A pre-ledger outbox from an older build owns this global identity first.
    // Prove it is the exact same scoped envelope before reserving a new ledger
    // record, otherwise a rejected cross-host attempt could poison recovery of
    // the original command.
    await this.assertOutboxIdentityAvailable(pendingEntry)
    await this.reserveCommandIdentity(command, envelope)
    const identity = outboxIdentity(hostId, command)
    const connection = this.connection
    if (!connection || connection.isClosed) {
      if (!isExplicitOfflineFollowUp(command)) {
        throw new ControlError(
          'connection.required',
          'This command needs a live host connection. Follow-ups can be queued only when explicitly requested.',
          { retryable: true }
        )
      }
      await this.putOutbox({ ...pendingEntry, state: 'waiting_for_connection' })
      return {
        hostId,
        deviceId: command.deviceId,
        commandId: command.commandId,
        threadId: command.threadId,
        executionGenerationId: command.expectedExecutionGenerationId,
        status: 'waiting_for_connection',
        durable: false,
      }
    }

    if (!this.authorityCapabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY)) {
      throw new ControlError(
        'command.capability_unavailable',
        'Prime Agent commands are unavailable until this host reports a verified resident runtime.',
        { retryable: true, details: { hostId, capability: PRIME_AGENT_COMMAND_CAPABILITY } }
      )
    }

    await this.putOutbox(pendingEntry)
    this.beginCommandSubmission(identity)
    try {
      if (
        this.authorityHostId !== hostId ||
        this.connection !== connection ||
        connection.isClosed
      ) {
        throw new ControlError(
          'connection.superseded',
          'The host connection changed before this command could be sent. Its original-host receipt remains uncertain.',
          { retryable: true, details: { hostId, commandId: command.commandId } }
        )
      }
      const result = await connection.request('command.submit', { command: envelope }, {
        priority: isUrgentCommand(command.kind) ? 'urgent' : 'normal'
      })
      const receipt = { ...normalizeReceipt(command.commandId, result), hostId }
      assertReceiptMatchesCommand(receipt, command)
      const directResidentOperation = residentCommandOperation(command)
      if (directResidentOperation && receipt.status === 'completed') {
        await this.commitCompletedResidentProof(
          pendingEntry,
          receipt,
          this.captureProjectionAuthority(),
          directResidentOperation,
        )
        return receipt
      }
      return await this.withCommandLifecycle(identity, async () => {
        const completedResidentProof = this.completedResidentProofs.get(commandLifecycleKey(identity))
        if (completedResidentProof) return { ...completedResidentProof }
        await this.recordDurableUncertainReceipt(receipt, command)
        const retainedState = commandOutboxStateAfterReceipt(command, receipt.status)
        if (retainedState) {
          await this.putOutbox({ ...pendingEntry, state: retainedState, updatedAt: now() })
          if (retainedState === 'awaiting_reconciliation' || retainedState === 'uncertain') {
            this.scheduleNonterminalReconciliation()
          }
        } else if (shouldRemoveOutboxAfterReceipt(command, receipt)) {
          await this.removeOutbox([identity])
        }
        return receipt
      })
    } catch (error) {
      const completedResidentProof = await this.withCommandLifecycle(identity, async () => {
        const proof = this.completedResidentProofs.get(commandLifecycleKey(identity))
        if (proof) return { ...proof }
        const entry = { hostId, command, state: 'uncertain' as const, updatedAt: now() }
        if (isDefinitiveCommandIdentityError(error)) {
          await this.holdOutboxAfterReconciliationFailure(entry, error)
        } else {
          await this.putOutbox(entry)
          this.scheduleNonterminalReconciliation()
        }
        return undefined
      })
      if (completedResidentProof) {
        // The proof event may already have won while its local diagnostic or
        // outbox cleanup failed. Keep the response proof-dominant, but also
        // supervise an exact read-only reconcile before the transient fence is
        // released so retained ownership cannot wait for an unrelated reconnect.
        this.scheduleNonterminalReconciliation()
        return completedResidentProof
      }
      throw error
    } finally {
      this.endCommandSubmission(identity)
    }
  }

  async approve(input: ApprovalResolution): Promise<CommandReceipt> {
    if (input.decision !== 'approve' && input.decision !== 'deny') {
      throw new ControlError(
        'command.approval_decision_invalid',
        'An approval resolution must preserve an explicit approve or deny decision.',
      )
    }
    return await this.submitCommand({
      deviceId: input.deviceId,
      commandId: input.commandId,
      expectedHostId: input.expectedHostId,
      expectedExecutionGenerationId: input.expectedExecutionGenerationId,
      issuedAt: input.issuedAt,
      threadId: input.threadId,
      kind: 'approval.resolve',
      delivery: 'live_only',
      payload: { approvalId: input.approvalId, decision: input.decision === 'approve' ? 'approve' : 'reject' }
    })
  }

  async cancel(input: CancelRequest): Promise<CommandReceipt> {
    return await this.submitCommand({
      deviceId: input.deviceId,
      commandId: input.commandId,
      expectedHostId: input.expectedHostId,
      expectedExecutionGenerationId: input.expectedExecutionGenerationId,
      issuedAt: input.issuedAt,
      threadId: input.threadId,
      kind: 'thread.cancel',
      delivery: 'live_only',
      ...(input.targetCommandId
        ? { payload: { reason: `Cancelled command ${input.targetCommandId}` } }
        : {})
    })
  }

  async reconcileCommands(commandIds: string[]): Promise<CommandReceipt[]> {
    if (commandIds.length === 0) return []
    return await this.latency.measure('command.reconcile', async () => {
      const authority = this.captureProjectionAuthority()
      const { hostId, connection } = authority
      const pending = (await this.readOutboxClassification(true)).actionable.filter((entry) => entry.hostId === hostId)
      const entries = commandIds.map((commandId) => {
        const matches = pending.filter((candidate) => candidate.command.commandId === commandId)
        if (matches.length === 0) {
          throw new ControlError('command.identity_missing', 'A command cannot be reconciled without its device identity.', {
            details: { commandId }
          })
        }
        if (matches.length > 1) {
          throw new ControlError('command.identity_ambiguous', 'More than one device owns this command ID.', {
            details: { commandId }
          })
        }
        return matches[0] as ScopedOutboxEntry
      })
      const receipts: CommandReceipt[] = []
      // One exact envelope per request keeps even a maximum-size multibyte
      // prompt comfortably below the transport's one-megabyte frame ceiling.
      for (const entry of entries) {
        if (!this.isActiveConnection(connection, authority.target, hostId, authority.generation)) {
          throw new ControlError('connection.superseded', 'The host connection changed during command reconciliation.', {
            retryable: true
          })
        }
        const envelope = adaptCommand(entry.command)
        await this.reserveCommandIdentity(entry.command, envelope)
        const result = await connection.request(
          'command.reconcile',
          { expectedHostId: hostId, commands: [envelope] },
          { priority: 'urgent' }
        )
        const directReceipts = normalizeReceipts(result)
        for (const receipt of directReceipts) assertReceiptMatchesCommand(receipt, entry.command)
        receipts.push(
          ...normalizeReconciliation(result, [entry.command]).map((receipt) => ({ ...receipt, hostId }))
        )
      }
      const removable: OutboxIdentity[] = []
      for (const receipt of receipts) {
        const entry = entries.find((candidate) =>
          candidate.command.deviceId === receipt.deviceId &&
          candidate.command.commandId === receipt.commandId &&
          candidate.command.threadId === receipt.threadId &&
          candidate.command.expectedExecutionGenerationId === receipt.executionGenerationId
        )
        if (!entry) continue
        const retainedState = commandOutboxStateAfterReceipt(entry.command, receipt.status)
        if (retainedState) {
          await this.putOutbox({ ...entry, state: retainedState, updatedAt: now() })
        } else if (residentCommandOperation(entry.command) && receipt.status === 'completed') {
          await this.commitCompletedResidentProof(
            entry,
            receipt,
            authority,
            residentCommandOperation(entry.command)!,
          )
        } else if (shouldRemoveOutboxAfterReceipt(entry.command, receipt)) {
          removable.push(outboxIdentity(hostId, entry.command))
        }
      }
      await this.removeOutbox(removable)
      for (const receipt of receipts) {
        const entry = entries.find((candidate) =>
          candidate.command.deviceId === receipt.deviceId && candidate.command.commandId === receipt.commandId
        )
        await this.recordDurableUncertainReceipt(receipt, entry?.command)
      }
      this.scheduleNonterminalReconciliation()
      return receipts
    })
  }

  async planHandoff(input: HandoffPlanRequest): Promise<unknown> {
    return await this.latency.measure('handoff.plan', async () => {
      const { hostId, connection } = this.requireExpectedAuthority(input.expectedHostId, 'move plan')
      const { expectedHostId, ...request } = input
      const result = await connection.request('handoff.plan', { expectedHostId, request }, { timeoutMs: 45_000 })
      this.assertCapturedAuthority(hostId, connection, 'move plan')
      return result
    })
  }

  async commitHandoff(input: HandoffCommitRequest): Promise<unknown> {
    return await this.latency.measure('handoff.commit', async () => {
      const { hostId, connection } = this.requireExpectedAuthority(input.expectedHostId, 'move commit')
      const result = await connection.request('handoff.commit', input, {
        timeoutMs: 5 * 60_000,
        priority: 'urgent'
      })
      this.assertCapturedAuthority(hostId, connection, 'move commit')
      if (isRecord(result) && Array.isArray(result.progress)) {
        for (const progress of result.progress.slice(0, 16)) this.emit('handoff-progress', progress)
      }
      return result
    })
  }

  async diagnostics(): Promise<Diagnostics> {
    const outbox = await this.readOutboxClassification(false)
    const activeHostId = this.authorityHostId
    const outboxCount = activeHostId
      ? outbox.actionable.filter((entry) => entry.hostId === activeHostId).length
      : 0
    return {
      platform: process.platform,
      arch: process.arch,
      appVersion: this.app.getVersion(),
      localEndpoint: await localHostdEndpoint(),
      connection: this.getConnectionState(),
      sshExecutable: this.sshExecutable,
      outboxCount,
      quarantinedOutboxCount: outbox.quarantinedCount,
      latencyTraces: this.latency.snapshot()
    }
  }

  getConnectionState(): ConnectionState {
    return structuredClone(this.state)
  }

  private async establish(
    target: ConnectionTarget,
    phase: 'connecting' | 'reconnecting',
    generation: number,
    expectedHostId?: string
  ): Promise<ConnectionState> {
    this.revokeResidentWorkspaceSelections('authority_changed')
    this.revokeResidentEndConfirmations('authority_changed')
    this.stopHealthPolling()
    const previous = this.connection
    if (previous) this.cancelThreadChangeRefreshesForConnection(previous)
    this.connection = undefined
    previous?.close()
    this.attempt += 1
    this.setState({
      phase,
      target,
      ...(this.authorityHostId ? { hostId: this.authorityHostId } : {}),
      ...this.authorityObservationState(),
      since: now(),
      attempt: this.attempt
    })

    let candidate: FramedConnection | undefined
    try {
      candidate = await this.latency.measure(
        target.kind === 'local' ? 'connect.local_socket' : 'connect.ssh',
        async () =>
          target.kind === 'local'
            ? await ensureAndConnectLocalHostd(this.app)
            : connectSshHost(target.alias, this.sshExecutable)
      )
      if (generation !== this.reconnectGeneration || this.intentionallyOffline) {
        candidate.close()
        throw new ControlError('connection.superseded', 'The connection attempt was superseded.')
      }
      const health = await this.latency.measure('connect.health', async () =>
        await candidate?.request('health.get', {}, { timeoutMs: 10_000, priority: 'urgent' })
      )
      if (generation !== this.reconnectGeneration || this.intentionallyOffline) {
        candidate.close()
        throw new ControlError('connection.superseded', 'The connection attempt was superseded.')
      }
      const observation = observationFromHealth(health)
      const hostId = observation.hostId
      if (expectedHostId !== undefined && hostId !== expectedHostId) {
        throw new ControlError(
          'ssh.host_identity_mismatch',
          target.kind === 'ssh'
            ? 'The configured SSH host returned a different immutable host identity.'
            : 'The local host returned a different immutable host identity during recovery.',
          { details: { expectedHostId, receivedHostId: hostId } }
        )
      }
      const projectionInvalidated = await this.bindAuthority(target, hostId, generation)
      this.authorityCapabilities = observation.capabilities
      this.authorityRuntimeReadiness = observation.runtimeReadiness
      this.authorityHealthLineage = observation.lineage
      this.healthCapabilityWarmupPollsRemaining = target.kind === 'local'
        ? HEALTH_CAPABILITY_WARMUP_POLLS
        : 0
      // Publish verified authority before reconciliation or an online state so
      // a same-alias host replacement invalidates stale renderer projections.
      if (projectionInvalidated) {
        this.setState({
          phase,
          target,
          hostId,
          path: target.kind === 'local' ? 'local_socket' : 'ssh',
          ...this.authorityObservationState(),
          since: now(),
          attempt: this.attempt
        })
      }
      if (candidate.isClosed) {
        throw new ControlError('connection.closed_during_handshake', 'The host connection closed during setup.', {
          retryable: true
        })
      }
      this.connection = candidate
      this.attachConnection(candidate, target, hostId, generation)
      try {
        await this.reconcileOutboxAfterConnect({ hostId, connection: candidate, target, generation })
      } catch (error) {
        if (!this.isActiveConnection(candidate, target, hostId, generation)) throw error
        this.setState({
          phase: 'degraded',
          target,
          hostId,
          path: target.kind === 'local' ? 'local_socket' : 'ssh',
          ...this.authorityObservationState(),
          since: now(),
          attempt: this.attempt,
          error: toStructuredError(error)
        })
        this.scheduleHealthPoll(candidate, target, hostId, generation)
        return this.getConnectionState()
      }
      this.assertActiveConnection(candidate, target, hostId, generation)
      const residentAuthority: CapturedProjectionAuthority = {
        hostId,
        connection: candidate,
        target,
        generation,
      }
      await this.reconcileResidentLifecycleLedgerAfterConnect(residentAuthority)
      this.assertActiveConnection(candidate, target, hostId, generation)
      // Publish online only after pending command identities have reconciled.
      // Renderer refreshes triggered by this transition therefore cannot race
      // ahead of a safely delivered send-when-reconnected follow-up.
      this.setState({
        phase: 'online',
        target,
        hostId,
        path: target.kind === 'local' ? 'local_socket' : 'ssh',
        ...this.authorityObservationState(),
        since: now(),
        attempt: this.attempt
      })
      this.scheduleResidentProjectionRefreshAfterConnect(residentAuthority)
      this.scheduleHealthPoll(candidate, target, hostId, generation)
      return this.getConnectionState()
    } catch (error) {
      if (candidate) this.cancelThreadChangeRefreshesForConnection(candidate)
      if (this.connection === candidate) this.connection = undefined
      candidate?.close()
      if (generation === this.reconnectGeneration) {
        this.setState({
          phase: 'offline',
          target,
          ...(this.authorityHostId ? { hostId: this.authorityHostId } : {}),
          ...this.authorityObservationState(),
          since: now(),
          attempt: this.attempt,
          error: toStructuredError(error)
        })
      }
      throw error
    }
  }

  private attachConnection(
    connection: FramedConnection,
    target: ConnectionTarget,
    hostId: string,
    generation: number
  ): void {
    connection.on('event', (event: { type: string; payload: unknown }) => {
      if (
        this.connection !== connection ||
        generation !== this.reconnectGeneration ||
        this.authorityHostId !== hostId
      ) return
      if (event.type.startsWith('handoff.')) this.emit('handoff-progress', event.payload)
      else if (event.type === 'resident.prompt_idle_observed') {
        const parsed = ResidentPromptIdleObservedSignalSchema.safeParse(event.payload)
        if (!parsed.success) {
          connection.terminate(
            new ControlError('protocol.invalid_prompt_idle_signal', 'The host sent an invalid prompt idle-observed signal.')
          )
          return
        }
        void this.acceptResidentPromptIdleSignal(
          parsed.data,
          { hostId, connection, target, generation },
        ).catch((error) => {
          if (!this.isActiveConnection(connection, target, hostId, generation)) return
          connection.terminate(
            error instanceof ControlError
              ? error
              : new ControlError('protocol.prompt_idle_signal_failed', 'The prompt idle signal could not be reconciled safely.', {
                  cause: error,
                }),
          )
        })
      }
      else if (event.type === 'resident.abort_idle_observed') {
        const parsed = ResidentAbortIdleObservedSignalSchema.safeParse(event.payload)
        if (!parsed.success) {
          connection.terminate(
            new ControlError('protocol.invalid_abort_idle_signal', 'The host sent an invalid abort idle-observed signal.')
          )
          return
        }
        void this.acceptResidentAbortIdleSignal(
          parsed.data,
          { hostId, connection, target, generation },
        ).catch((error) => {
          if (!this.isActiveConnection(connection, target, hostId, generation)) return
          connection.terminate(
            error instanceof ControlError
              ? error
              : new ControlError('protocol.abort_idle_signal_failed', 'The abort idle signal could not be reconciled safely.', {
                  cause: error,
                }),
          )
        })
      }
      else if (event.type === 'thread.changed') {
        const parsed = ThreadChangedEventPayloadSchema.safeParse(event.payload)
        if (!parsed.success) {
          connection.terminate(
            new ControlError('protocol.invalid_thread_change', 'The host sent an invalid thread-change signal.')
          )
          return
        }
        this.scheduleThreadChangeRefresh(
          { hostId, connection, target, generation },
          parsed.data.threadId,
          parsed.data.executionGenerationId,
        )
      }
      else if (event.type.startsWith('snapshot.') || event.type === 'thread.snapshot') {
        try {
          const snapshot = snapshotEventForAuthority(event.payload, hostId)
          const authority: CapturedProjectionAuthority = { hostId, connection, target, generation }
          void (async () => {
            const catalog = CatalogProjectionSnapshotSchema.safeParse(snapshot)
            const accepted = catalog.success
              ? await this.persistCatalog(catalog.data, authority)
              : await this.persistThreadSnapshot(ThreadProjectionSnapshotSchema.parse(snapshot), authority)
            if (accepted && this.isActiveConnection(connection, target, hostId, generation)) {
              this.emit('snapshot', snapshot)
            }
          })().catch((error) => {
            if (!this.isActiveConnection(connection, target, hostId, generation)) return
            connection.terminate(
              error instanceof ControlError
                ? error
                : new ControlError('protocol.snapshot_persistence_failed', 'The host snapshot could not be persisted safely.', {
                    cause: error,
                  }),
            )
          })
        } catch (error) {
          connection.terminate(
            error instanceof ControlError
              ? error
              : new ControlError('protocol.invalid_snapshot_event', 'The host sent an invalid snapshot event.', {
                  cause: error
                })
          )
        }
      }
      else this.emit('host-event', event)
    })
    connection.once('close', (error: unknown) => {
      this.cancelThreadChangeRefreshesForConnection(connection)
      if (this.connection !== connection) return
      this.stopHealthPolling()
      this.stopNonterminalReconciliation()
      this.connection = undefined
      this.abandonRuntimeOAuthSessionsForConnection(connection)
      if (this.intentionallyOffline || generation !== this.reconnectGeneration) return
      this.beginAutomaticReconnect(target, hostId, error)
    })
  }

  private scheduleThreadChangeRefresh(
    authority: CapturedProjectionAuthority,
    threadId: string,
    signaledExecutionGenerationId: string,
  ): void {
    if (!this.isActiveConnection(authority.connection, authority.target, authority.hostId, authority.generation)) return
    const key = `${authority.hostId}\u0000${threadId}`
    const existing = this.threadChangeRefreshes.get(key)
    if (existing) {
      if (
        existing.authority.connection === authority.connection &&
        existing.authority.generation === authority.generation
      ) {
        existing.revision += 1
        return
      }
      existing.cancelled = true
      this.threadChangeRefreshes.delete(key)
    }
    if (this.threadChangeRefreshes.size >= MAX_THREAD_CHANGE_REFRESHES) {
      authority.connection.terminate(
        new ControlError(
          'protocol.thread_change_budget',
          'The host invalidated more threads than this connection can refresh safely.',
          { retryable: true, details: { maxThreads: MAX_THREAD_CHANGE_REFRESHES } },
        )
      )
      return
    }
    const refresh: ThreadChangeRefresh = {
      authority,
      threadId,
      revision: 1,
      committedRevision: 0,
      cancelled: false,
    }
    this.threadChangeRefreshes.set(key, refresh)
    void (async () => {
      let retryDelayMs = THREAD_CHANGE_DEBOUNCE_MS
      try {
        // Collapse token/tool bursts before each bounded authoritative read.
        while (!refresh.cancelled && refresh.committedRevision < refresh.revision && this.isActiveConnection(
          authority.connection,
          authority.target,
          authority.hostId,
          authority.generation,
        )) {
          const targetRevision = refresh.revision
          await delay(retryDelayMs)
          if (refresh.cancelled) return
          if (!this.isActiveConnection(authority.connection, authority.target, authority.hostId, authority.generation)) return
          try {
            const snapshot = ThreadProjectionSnapshotSchema.parse(await authority.connection.request(
              'thread.snapshot',
              { threadId },
              { timeoutMs: 45_000 },
            ))
            this.assertProjectionAuthority(authority, 'thread change refresh')
            if (snapshot.thread.threadId !== threadId || snapshot.thread.currentLocation.hostId !== authority.hostId) {
              throw new ControlError('protocol.authority_mismatch', 'The refreshed thread snapshot belongs to another authority.')
            }
            // The signal generation is advisory. A stale G1 signal may fetch
            // current G2, but persistence accepts only its monotonic authority.
            void signaledExecutionGenerationId
            const accepted = await this.persistThreadSnapshot(snapshot, authority)
            this.assertProjectionAuthority(authority, 'thread change refresh')
            if (accepted) this.emit('snapshot', snapshot)
            refresh.committedRevision = targetRevision
            retryDelayMs = THREAD_CHANGE_DEBOUNCE_MS
          } catch (error) {
            if (!this.isActiveConnection(authority.connection, authority.target, authority.hostId, authority.generation)) return
            if (!(error instanceof ControlError) || !error.retryable) throw error
            retryDelayMs = Math.min(Math.max(250, retryDelayMs * 2), 2_000)
          }
        }
      } catch (error) {
        if (!this.isActiveConnection(authority.connection, authority.target, authority.hostId, authority.generation)) return
        authority.connection.terminate(
          error instanceof ControlError
            ? error
            : new ControlError('protocol.thread_change_refresh_failed', 'The authoritative thread refresh failed.', {
                retryable: true,
                cause: error,
              })
        )
      } finally {
        if (this.threadChangeRefreshes.get(key) === refresh) this.threadChangeRefreshes.delete(key)
      }
    })()
  }

  private cancelThreadChangeRefreshesForConnection(connection: FramedConnection): void {
    for (const [key, refresh] of this.threadChangeRefreshes) {
      if (refresh.authority.connection !== connection) continue
      refresh.cancelled = true
      if (this.threadChangeRefreshes.get(key) === refresh) this.threadChangeRefreshes.delete(key)
    }
  }

  private beginAutomaticReconnect(target: ConnectionTarget, connectedHostId: string, cause: unknown): void {
    const generation = ++this.reconnectGeneration
    // Unexpected loss must never reconnect an orphaned browser callback to a
    // different local authority. The immutable health identity fences both
    // local and SSH automatic recovery.
    const expectedHostId = connectedHostId
    this.setState({
      phase: 'reconnecting',
      target,
      ...(this.authorityHostId ? { hostId: this.authorityHostId } : {}),
      ...this.authorityObservationState(),
      since: now(),
      attempt: this.attempt,
      error: toStructuredError(cause)
    })
    void (async () => {
      let lastError = cause
      let retryIndex = 0
      while (!this.intentionallyOffline && generation === this.reconnectGeneration) {
        const baseDelay = RECONNECT_DELAYS_MS[Math.min(retryIndex, RECONNECT_DELAYS_MS.length - 1)] ?? 30_000
        await delay(withJitter(baseDelay))
        if (this.intentionallyOffline || generation !== this.reconnectGeneration) return
        try {
          await this.establish(target, 'reconnecting', generation, expectedHostId)
          return
        } catch (error) {
          lastError = error
          if (error instanceof ControlError && error.code === 'ssh.host_identity_mismatch') {
            if (!this.intentionallyOffline && generation === this.reconnectGeneration) {
              this.setState({
                phase: 'offline',
                target,
                ...(expectedHostId ? { hostId: expectedHostId } : {}),
                ...this.authorityObservationState(),
                since: now(),
                attempt: this.attempt,
                error: toStructuredError(error),
              })
            }
            return
          }
          retryIndex += 1
          if (!this.intentionallyOffline && generation === this.reconnectGeneration) {
            this.setState({
              phase: 'reconnecting',
              target,
              ...(this.authorityHostId ? { hostId: this.authorityHostId } : {}),
              ...this.authorityObservationState(),
              since: now(),
              attempt: this.attempt,
              error: toStructuredError(lastError)
            })
          }
        }
      }
    })()
  }

  private setState(state: ConnectionState): void {
    this.state = state
    this.emit('connection-state', this.getConnectionState())
  }

  private authorityObservationState(): Pick<ConnectionState, 'capabilities' | 'runtimeReadiness'> | Record<string, never> {
    return {
      ...(this.authorityCapabilities.length > 0 ? { capabilities: [...this.authorityCapabilities] } : {}),
      ...(this.authorityRuntimeReadiness && this.authorityRuntimeReadiness.hostId === this.authorityHostId
        ? { runtimeReadiness: structuredClone(this.authorityRuntimeReadiness) }
        : {}),
    }
  }

  private scheduleHealthPoll(
    connection: FramedConnection,
    target: ConnectionTarget,
    hostId: string,
    generation: number,
  ): void {
    this.stopHealthPolling()
    if (!this.isActiveConnection(connection, target, hostId, generation)) return
    const initializing =
      this.authorityRuntimeReadiness?.kind === 'reported' &&
      this.authorityRuntimeReadiness.snapshot.status === 'initializing'
    const runtimeReady =
      this.authorityRuntimeReadiness?.kind === 'reported' &&
      this.authorityRuntimeReadiness.snapshot.status === 'ready'
    const expectedWarmedCapabilities = [
      RUNTIME_MODEL_CATALOG_CAPABILITY,
      RESIDENT_LIFECYCLE_CAPABILITY,
      RUNTIME_OAUTH_CAPABILITY,
      ...(this.platform === 'win32' ? [CANDIDATE_EVALUATION_PROBE_CAPABILITY] : []),
    ]
    const warmingOptionalRuntimeCapabilities = Boolean(
      target.kind === 'local' &&
      runtimeReady &&
      this.healthCapabilityWarmupPollsRemaining > 0 &&
      expectedWarmedCapabilities.some((capability) => !this.authorityCapabilities.includes(capability))
    )
    if (warmingOptionalRuntimeCapabilities) this.healthCapabilityWarmupPollsRemaining -= 1
    const delayMs = initializing || warmingOptionalRuntimeCapabilities
      ? HEALTH_POLL_INITIALIZING_MS
      : HEALTH_POLL_STEADY_MS
    this.healthPollTimer = setTimeout(() => {
      this.healthPollTimer = undefined
      void this.pollHealth(connection, target, hostId, generation)
    }, delayMs)
    this.healthPollTimer.unref?.()
  }

  private stopHealthPolling(): void {
    if (!this.healthPollTimer) return
    clearTimeout(this.healthPollTimer)
    this.healthPollTimer = undefined
  }

  private scheduleNonterminalReconciliation(): void {
    if (
      this.nonterminalReconciliationTimer ||
      this.nonterminalReconciliationInFlight ||
      this.intentionallyOffline ||
      !this.connection ||
      this.connection.isClosed ||
      !this.target ||
      !this.authorityHostId ||
      !this.authorityCapabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY)
    ) return
    const delayMs = NONTERMINAL_RECONCILIATION_DELAYS_MS[
      Math.min(this.nonterminalReconciliationAttempt, NONTERMINAL_RECONCILIATION_DELAYS_MS.length - 1)
    ] ?? 30_000
    this.nonterminalReconciliationTimer = setTimeout(() => {
      this.nonterminalReconciliationTimer = undefined
      const connection = this.connection
      const target = this.target
      const hostId = this.authorityHostId
      if (!connection || !target || !hostId) return
      const authority: CapturedProjectionAuthority = {
        connection,
        target,
        hostId,
        generation: this.reconnectGeneration,
      }
      if (!this.isActiveConnection(connection, target, hostId, authority.generation)) return
      const task = this.pollNonterminalReconciliation(authority)
      this.nonterminalReconciliationInFlight = task
      void task.then((madeProgress) => {
        this.nonterminalReconciliationAttempt = madeProgress
          ? 0
          : Math.min(
              this.nonterminalReconciliationAttempt + 1,
              NONTERMINAL_RECONCILIATION_DELAYS_MS.length - 1,
            )
      }).catch((error) => {
        if (!this.isActiveConnection(connection, target, hostId, authority.generation)) return
        connection.terminate(
          error instanceof ControlError
            ? error
            : new ControlError(
                'protocol.command_reconciliation_failed',
                'A pending command could not be reconciled safely.',
                { cause: error, retryable: true },
              ),
        )
      }).finally(() => {
        if (this.nonterminalReconciliationInFlight === task) {
          this.nonterminalReconciliationInFlight = undefined
        }
        this.scheduleNonterminalReconciliation()
      })
    }, delayMs)
    this.nonterminalReconciliationTimer.unref?.()
  }

  private stopNonterminalReconciliation(): void {
    if (this.nonterminalReconciliationTimer) {
      clearTimeout(this.nonterminalReconciliationTimer)
      this.nonterminalReconciliationTimer = undefined
    }
    this.nonterminalReconciliationAttempt = 0
  }

  private async drainNonterminalReconciliation(): Promise<void> {
    const inFlight = this.nonterminalReconciliationInFlight
    if (!inFlight) return
    await inFlight.catch(() => undefined)
  }

  private async pollNonterminalReconciliation(
    authority: CapturedProjectionAuthority,
  ): Promise<boolean> {
    this.assertProjectionAuthority(authority, 'pending command reconciliation')
    const entries = (await this.readOutboxClassification(true)).actionable
      .filter((entry) =>
        entry.hostId === authority.hostId &&
        (entry.state === 'awaiting_reconciliation' || entry.state === 'uncertain')
      )
      .slice(0, NONTERMINAL_RECONCILIATION_BATCH_LIMIT)
    if (entries.length === 0) {
      this.nonterminalReconciliationAttempt = 0
      return false
    }
    let madeProgress = false
    for (const entry of entries) {
      this.assertProjectionAuthority(authority, 'pending command reconciliation')
      try {
        const envelope = adaptCommand(entry.command)
        await this.reserveCommandIdentity(entry.command, envelope)
        const result = await authority.connection.request(
        'command.reconcile',
        { expectedHostId: authority.hostId, commands: [envelope] },
        { priority: 'urgent' },
        )
        this.assertProjectionAuthority(authority, 'pending command reconciliation')
        const receipts = normalizeReceipts(result)
        if (receipts.length > 1) {
          throw new ControlError(
            'protocol.command_reconciliation_identity_mismatch',
            'The host returned more than one receipt for one pending command.',
          )
        }
        const unknown = normalizeUnknownCommandIdentities(result)
        if (
          unknown.length > 1 ||
          unknown.some((identity) =>
            identity.deviceId !== entry.command.deviceId || identity.commandId !== entry.command.commandId
          ) ||
          (receipts.length > 0 && unknown.length > 0)
        ) {
          throw new ControlError(
            'protocol.command_reconciliation_identity_mismatch',
            'The host reconciliation result did not match the exact pending command identity.',
          )
        }
        const rawReceipt = receipts[0]
        if (!rawReceipt) continue
        assertReceiptMatchesCommand(rawReceipt, entry.command)
        const receipt: CommandReceipt = { ...rawReceipt, hostId: authority.hostId }
        await this.recordDurableUncertainReceipt(receipt, entry.command)
        const retainedState = commandOutboxStateAfterReceipt(entry.command, receipt.status)
        const residentOperation = residentCommandOperation(entry.command)
        if (residentOperation && receipt.status === 'completed') {
          await this.commitCompletedResidentProof(entry, receipt, authority, residentOperation)
          madeProgress = true
          continue
        }
        if (retainedState) {
          await this.putOutbox({ ...entry, state: retainedState, updatedAt: now() })
          if (retainedState !== entry.state) {
            this.emit('host-event', { type: 'command.receipt', payload: receipt })
            madeProgress = true
          }
          continue
        }
        if (shouldRemoveOutboxAfterReceipt(entry.command, receipt)) {
          await this.recordDurableUncertainReceipt(receipt, entry.command)
          // The exact receipt is delivered before removal for the same crash
          // ordering as prompt proof. A restart can reconcile a harmless repeat.
          this.emit('host-event', { type: 'command.receipt', payload: receipt })
          await this.removeOutbox([outboxIdentity(authority.hostId, entry.command)])
          madeProgress = true
        }
      } catch (error) {
        if (!this.isActiveConnection(
          authority.connection,
          authority.target,
          authority.hostId,
          authority.generation,
        )) throw error
        if (
          error instanceof ControlError &&
          error.code.startsWith('protocol.') &&
          !isDefinitiveCommandIdentityError(error)
        ) throw error
        await this.holdOutboxAfterReconciliationFailure(entry, error)
        if (isDefinitiveCommandIdentityError(error)) madeProgress = true
      }
    }
    return madeProgress
  }

  private async pollHealth(
    connection: FramedConnection,
    target: ConnectionTarget,
    hostId: string,
    generation: number,
  ): Promise<void> {
    if (!this.isActiveConnection(connection, target, hostId, generation)) return
    try {
      const health = await connection.request('health.get', {}, {
        timeoutMs: HEALTH_POLL_TIMEOUT_MS,
        priority: 'urgent',
      })
      if (!this.isActiveConnection(connection, target, hostId, generation)) return
      const observation = observationFromHealth(health)
      const expectedLineage = this.authorityHealthLineage
      if (!expectedLineage) {
        throw new ControlError('protocol.health_lineage_missing', 'The verified host health lineage is unavailable.')
      }
      assertSameHealthLineage(expectedLineage, observation.lineage)
      const commandsWereAvailable = this.authorityCapabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY)
      this.applyHealthObservation(observation)
      if (!commandsWereAvailable && observation.capabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY)) {
        await this.reconcileOutboxAfterConnect({ hostId, connection, target, generation })
      }
      this.scheduleHealthPoll(connection, target, hostId, generation)
    } catch (error) {
      if (!this.isActiveConnection(connection, target, hostId, generation)) return
      connection.terminate(
        error instanceof ControlError
          ? error
          : new ControlError('connection.health_poll_failed', 'The host health check failed.', {
              retryable: true,
              cause: error,
            }),
      )
    }
  }

  private applyHealthObservation(observation: HealthObservation): void {
    const semanticChange =
      !sameStringArray(this.authorityCapabilities, observation.capabilities) ||
      runtimeReadinessSemanticKey(this.authorityRuntimeReadiness) !==
        runtimeReadinessSemanticKey(observation.runtimeReadiness)
    this.authorityCapabilities = observation.capabilities
    this.authorityRuntimeReadiness = observation.runtimeReadiness
    this.authorityHealthLineage = observation.lineage
    const { capabilities: _capabilities, runtimeReadiness: _runtimeReadiness, ...base } = this.state
    const next = { ...base, ...this.authorityObservationState() }
    if (semanticChange) this.setState(next)
    else this.state = next
  }

  private requireConnection(): FramedConnection {
    if (!this.connection || this.connection.isClosed) {
      throw new ControlError('connection.required', 'A live host connection is required.', { retryable: true })
    }
    return this.connection
  }

  private isActiveConnection(
    connection: FramedConnection,
    target: ConnectionTarget,
    hostId: string,
    generation: number
  ): boolean {
    return (
      generation === this.reconnectGeneration &&
      !this.intentionallyOffline &&
      this.connection === connection &&
      !connection.isClosed &&
      this.authorityHostId === hostId &&
      Boolean(this.target && sameTarget(this.target, target))
    )
  }

  private assertActiveConnection(
    connection: FramedConnection,
    target: ConnectionTarget,
    hostId: string,
    generation: number
  ): void {
    if (!this.isActiveConnection(connection, target, hostId, generation)) {
      throw new ControlError('connection.superseded', 'The connection attempt was superseded.', { retryable: true })
    }
  }

  private requireAuthorityHostId(
    message = 'The active host identity has not been verified.'
  ): string {
    if (!this.authorityHostId) {
      throw new ControlError('command.host_identity_required', message, { retryable: true })
    }
    return this.authorityHostId
  }

  private requireExpectedAuthority(
    expectedHostId: string,
    operation: string
  ): { hostId: string; connection: FramedConnection } {
    const hostId = this.requireAuthorityHostId(`The source host identity for this ${operation} is not verified.`)
    if (expectedHostId !== hostId) {
      throw new ControlError(
        'command.host_authority_changed',
        `The reviewed ${operation} belongs to a different host. Refresh before continuing.`,
        { retryable: true, details: { expectedHostId, activeHostId: hostId } }
      )
    }
    return { hostId, connection: this.requireConnection() }
  }

  private assertCapturedAuthority(hostId: string, connection: FramedConnection, operation: string): void {
    if (this.authorityHostId !== hostId || this.connection !== connection || connection.isClosed) {
      throw new ControlError(
        'connection.superseded',
        `The host connection changed during the ${operation}. Reconcile its receipt before retrying.`,
        { retryable: true }
      )
    }
  }

  private captureProjectionAuthority(): CapturedProjectionAuthority {
    const hostId = this.requireAuthorityHostId('Refresh after the destination host identity has been verified.')
    const connection = this.requireConnection()
    const target = this.target
    if (!target) {
      throw new ControlError('connection.no_target', 'There is no verified host target for this projection refresh.', {
        retryable: true
      })
    }
    return { hostId, connection, target, generation: this.reconnectGeneration }
  }

  private captureResidentLifecycleBaseAuthority(
    expectedHostId?: string,
  ): CapturedProjectionAuthority {
    const authority = this.captureProjectionAuthority()
    if (this.state.phase !== 'online') {
      throw new ControlError(
        'resident.lifecycle_live_connection_required',
        'Resident lifecycle control requires a live, fully reconciled host connection.',
        { retryable: true }
      )
    }
    if (expectedHostId !== undefined && authority.hostId !== expectedHostId) {
      throw new ControlError(
        'resident.lifecycle_authority_changed',
        'The resident lifecycle operation belongs to a different host authority.',
        {
          retryable: true,
          details: { expectedHostId, connectedHostId: authority.hostId },
        }
      )
    }
    if (
      (authority.target.kind === 'local' && this.state.path !== 'local_socket') ||
      (authority.target.kind === 'ssh' && this.state.path !== 'ssh')
    ) {
      throw new ControlError(
        'resident.lifecycle_path_changed',
        'The resident lifecycle connection path changed. Refresh before continuing.',
        { retryable: true }
      )
    }
    return authority
  }

  private captureLocalResidentProvisionAuthority(expectedHostId?: string): CapturedProjectionAuthority {
    const authority = this.captureResidentLifecycleBaseAuthority(expectedHostId)
    if (authority.target.kind !== 'local') {
      throw new ControlError(
        'resident.lifecycle_local_required',
        'Choose a saved workspace to start a resident thread over SSH.'
      )
    }
    if (!this.authorityCapabilities.includes(RESIDENT_LIFECYCLE_CAPABILITY)) {
      throw new ControlError(
        'resident.lifecycle_unavailable',
        'The connected host does not expose resident lifecycle control.',
        { retryable: true }
      )
    }
    return authority
  }

  private captureRegisteredResidentWorkspaceAuthority(
    expectedHostId?: string,
  ): CapturedProjectionAuthority {
    const authority = this.captureResidentLifecycleBaseAuthority(expectedHostId)
    if (authority.target.kind !== 'ssh') {
      throw new ControlError(
        'resident.registered_workspace_ssh_required',
        'Saved-workspace resident provisioning is available only on a verified SSH host.'
      )
    }
    if (!this.authorityCapabilities.includes(RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY)) {
      throw new ControlError(
        'resident.registered_workspace_unavailable',
        'The connected SSH host does not expose saved-workspace resident lifecycle control.',
        { retryable: true }
      )
    }
    return authority
  }

  private captureResidentEndAuthority(expectedHostId: string): CapturedProjectionAuthority {
    const authority = this.captureResidentLifecycleBaseAuthority(expectedHostId)
    const capability = authority.target.kind === 'local'
      ? RESIDENT_LIFECYCLE_CAPABILITY
      : RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY
    if (!this.authorityCapabilities.includes(capability)) {
      throw new ControlError(
        'resident.lifecycle_unavailable',
        'The connected host does not expose resident lifecycle control.',
        { retryable: true }
      )
    }
    return authority
  }

  private captureResidentStatusAuthority(expectedHostId: string): CapturedProjectionAuthority {
    // Status is read-only and remains available on an already authenticated,
    // exact-generation connection when runtime readiness withdraws mutation
    // capabilities. This is the recovery path for that failure mode.
    return this.captureResidentLifecycleBaseAuthority(expectedHostId)
  }

  private captureCandidateEvaluationAuthority(expectedHostId: string): CapturedProjectionAuthority {
    const authority = this.captureProjectionAuthority()
    if (this.state.phase !== 'online') {
      throw new ControlError(
        'candidate.evaluation_live_connection_required',
        'Candidate evaluation requires a live, fully reconciled host connection.',
        { retryable: true },
      )
    }
    if (authority.hostId !== expectedHostId) {
      throw new ControlError(
        'candidate.evaluation_authority_changed',
        'The candidate evaluation belongs to a different host authority.',
        {
          retryable: true,
          details: { expectedHostId, connectedHostId: authority.hostId },
        },
      )
    }
    if (authority.target.kind !== 'local' || this.state.path !== 'local_socket') {
      throw new ControlError(
        'candidate.evaluation_local_required',
        'Candidate evaluation is available only for a workspace on this computer.',
      )
    }
    if (!this.authorityCapabilities.includes(CANDIDATE_EVALUATION_PROBE_CAPABILITY)) {
      throw new ControlError(
        'candidate.evaluation_unavailable',
        'The connected host does not expose candidate evaluation preflight.',
        { retryable: true },
      )
    }
    return authority
  }

  private async readResidentLifecycleLedger(): Promise<ResidentLifecycleLedger> {
    return normalizeResidentLifecycleLedger(await this.residentLifecycleLedger.read())
  }

  private async assertResidentEndDoesNotBlockCommand(command: ClientCommand): Promise<void> {
    const ledger = await this.readResidentLifecycleLedger()
    const end = ledger.entries.find(
      (entry) =>
        entry.kind === 'end' &&
        entry.expectedHostId === command.expectedHostId &&
        entry.threadId === command.threadId &&
        entry.executionGenerationId === command.expectedExecutionGenerationId
    )
    if (!end) return
    throw new ControlError(
      'command.resident_end_in_progress',
      end.state === 'terminal'
        ? 'This resident session has ended. Its saved thread is read-only.'
        : 'This resident session is ending. Commands are blocked while its durable outcome is reconciled.',
      {
        retryable: false,
        details: {
          expectedHostId: end.expectedHostId,
          operationId: end.operationId,
          threadId: end.threadId,
          executionGenerationId: end.executionGenerationId,
          state: end.state,
        },
      }
    )
  }

  private async captureResidentEndSourceCursor(
    input: Omit<ResidentEndPreparationInput, 'resumeOperationId'>,
    authority: CapturedProjectionAuthority,
  ): Promise<SessionCursor> {
    if (authority.target.kind === 'ssh') {
      let snapshot: ThreadProjectionSnapshot
      try {
        const raw = await authority.connection.request(
          'thread.snapshot',
          { threadId: input.threadId },
          { timeoutMs: 45_000 },
        )
        this.assertProjectionAuthority(authority, 'remote resident end projection review')
        snapshot = ThreadProjectionSnapshotSchema.parse(raw)
      } catch (error) {
        this.assertProjectionAuthority(authority, 'remote resident end projection review')
        if (error instanceof ControlError && error.code.startsWith('protocol.')) throw error
        throw new ControlError(
          'resident.end_projection_required',
          'Refresh this resident thread before reviewing its permanent end.',
          { retryable: true }
        )
      }
      if (
        snapshot.thread.threadId !== input.threadId ||
        snapshot.thread.currentLocation.hostId !== input.expectedHostId ||
        snapshot.thread.currentLocation.projectId !== input.projectId ||
        snapshot.thread.currentLocation.workspaceId !== input.workspaceId ||
        snapshot.thread.currentLocation.executionGenerationId !== input.executionGenerationId
      ) {
        throw new ControlError(
          'resident.end_lineage_changed',
          'The reviewed resident thread lineage no longer matches the native projection.'
        )
      }
      try {
        await this.persistThreadSnapshot(snapshot, authority)
      } catch {
        this.assertProjectionAuthority(authority, 'remote resident end projection review')
        throw new ControlError(
          'resident.end_projection_required',
          'Refresh this resident thread before reviewing its permanent end.',
          { retryable: true }
        )
      }
      this.assertProjectionAuthority(authority, 'remote resident end projection review')
    }
    let cache: CacheEnvelope
    try {
      cache = await this.readCache()
    } catch {
      throw new ControlError(
        'resident.end_projection_required',
        'Refresh this resident thread before reviewing its permanent end.',
        { retryable: true }
      )
    }
    this.assertProjectionAuthority(authority, 'resident end projection review')
    const rawSnapshot = cache.entries[authority.hostId]?.lastSnapshot
    const parsed = ThreadProjectionSnapshotSchema.safeParse(rawSnapshot)
    if (!parsed.success) {
      throw new ControlError(
        'resident.end_projection_required',
        'Refresh this resident thread before reviewing its permanent end.'
      )
    }
    const snapshot = parsed.data
    if (
      snapshot.thread.threadId !== input.threadId ||
      snapshot.thread.currentLocation.hostId !== input.expectedHostId ||
      snapshot.thread.currentLocation.projectId !== input.projectId ||
      snapshot.thread.currentLocation.workspaceId !== input.workspaceId ||
      snapshot.thread.currentLocation.executionGenerationId !== input.executionGenerationId
    ) {
      throw new ControlError(
        'resident.end_lineage_changed',
        'The reviewed resident thread lineage no longer matches the native projection.'
      )
    }
    if (snapshot.residentLifecycle) {
      throw new ControlError(
        'resident.end_already_completed',
        'This resident session has already ended.'
      )
    }
    if (snapshot.runtime?.residency !== 'resident') {
      throw new ControlError(
        'resident.end_runtime_not_proven',
        'The selected thread does not have a verified resident runtime to end.'
      )
    }
    return structuredClone(snapshot.latestCursor)
  }

  private requireResidentEndConfirmation(confirmationToken: string): ResidentEndConfirmationRecord {
    this.expireResidentEndConfirmations()
    const record = this.residentEndConfirmations.get(confirmationToken)
    if (record) return record
    const reason = this.retiredResidentEndConfirmations.get(confirmationToken)
    if (reason === 'expired') {
      throw new ControlError(
        'resident.end_confirmation_expired',
        'The end confirmation expired. Review the resident session again.'
      )
    }
    if (reason === 'superseded') {
      throw new ControlError(
        'resident.end_confirmation_superseded',
        'A newer resident end review replaced this confirmation.'
      )
    }
    if (reason === 'authority_changed') {
      throw new ControlError(
        'resident.end_confirmation_authority_changed',
        'The host connection changed after this resident end was reviewed.',
        { retryable: true }
      )
    }
    if (reason === 'consumed') {
      throw new ControlError(
        'resident.end_confirmation_consumed',
        'This end confirmation has already been used. Check the durable operation status.'
      )
    }
    throw new ControlError(
      'resident.end_confirmation_unknown',
      'The end confirmation is unavailable. Review the resident session again.'
    )
  }

  private assertResidentEndConfirmationAuthority(record: ResidentEndConfirmationRecord): void {
    const authority = this.captureResidentEndAuthority(record.identity.expectedHostId)
    if (
      authority.connection !== record.authority.connection ||
      authority.generation !== record.authority.generation ||
      !sameTarget(authority.target, record.authority.target)
    ) {
      throw new ControlError(
        'resident.end_confirmation_authority_changed',
        'The host connection changed after this resident end was reviewed.',
        { retryable: true }
      )
    }
    this.assertProjectionAuthority(record.authority, 'resident end confirmation')
  }

  private expireResidentEndConfirmations(): void {
    const timestamp = Date.now()
    for (const record of [...this.residentEndConfirmations.values()]) {
      if (Date.parse(record.confirmation.expiresAt) <= timestamp) {
        this.retireResidentEndConfirmation(record.confirmation.confirmationToken, 'expired')
      }
    }
  }

  private revokeResidentEndConfirmations(reason: RetiredResidentEndConfirmationReason): void {
    for (const confirmationToken of [...this.residentEndConfirmations.keys()]) {
      this.retireResidentEndConfirmation(confirmationToken, reason)
    }
  }

  private retireResidentEndConfirmation(
    confirmationToken: string,
    reason: RetiredResidentEndConfirmationReason,
  ): void {
    this.residentEndConfirmations.delete(confirmationToken)
    this.retiredResidentEndConfirmations.delete(confirmationToken)
    this.retiredResidentEndConfirmations.set(confirmationToken, reason)
    while (this.retiredResidentEndConfirmations.size > RETIRED_RESIDENT_END_CONFIRMATION_LIMIT) {
      const oldest = this.retiredResidentEndConfirmations.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.retiredResidentEndConfirmations.delete(oldest)
    }
  }

  private enforceResidentEndConfirmationLimit(): void {
    while (this.residentEndConfirmations.size > RESIDENT_END_CONFIRMATION_LIMIT) {
      const oldest = this.residentEndConfirmations.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.retireResidentEndConfirmation(oldest, 'superseded')
    }
  }

  private async withResidentEndMutationFence<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.residentEndMutationTails.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.residentEndMutationTails.set(key, tail)
    try {
      return await result
    } finally {
      if (this.residentEndMutationTails.get(key) === tail) {
        this.residentEndMutationTails.delete(key)
      }
    }
  }

  private requireResidentWorkspaceSelection(selectionToken: string): ResidentWorkspaceSelectionRecord {
    this.expireResidentWorkspaceSelections()
    const record = this.residentWorkspaceSelections.get(selectionToken)
    if (record) return record
    const reason = this.retiredResidentSelections.get(selectionToken)
    if (reason === 'expired') {
      throw new ControlError(
        'resident.workspace_selection_expired',
        'The workspace selection expired. Choose the folder again.'
      )
    }
    if (reason === 'superseded') {
      throw new ControlError(
        'resident.workspace_selection_superseded',
        'A newer workspace selection replaced this one.'
      )
    }
    if (reason === 'authority_changed') {
      throw new ControlError(
        'resident.workspace_selection_authority_changed',
        'The host connection changed after this workspace was selected.',
        { retryable: true }
      )
    }
    if (reason === 'terminal') {
      throw new ControlError(
        'resident.workspace_selection_completed',
        'This workspace selection already reached a terminal lifecycle state.'
      )
    }
    throw new ControlError(
      'resident.workspace_selection_unknown',
      'The workspace selection is not available. Choose the folder again.'
    )
  }

  private async requireLocalResidentWorkspaceRecoveryEntry(
    operationId: string,
    authority: CapturedProjectionAuthority,
  ): Promise<ResidentProvisionOperationView> {
    if (!isHostId(operationId)) {
      throw new ControlError(
        'resident.workspace_resume_invalid',
        'The resident operation selected for recovery is invalid.'
      )
    }
    const ledger = await this.readResidentLifecycleLedger()
    const entry = ledger.entries.find((candidate) => candidate.operationId === operationId)
    if (!entry) {
      throw new ControlError(
        'resident.workspace_resume_unknown',
        'The resident operation selected for recovery is not available.'
      )
    }
    if (entry.expectedHostId !== authority.hostId) {
      throw new ControlError(
        'resident.workspace_resume_authority_changed',
        'The resident operation selected for recovery belongs to a different host.'
      )
    }
    if (
      entry.kind !== 'provision' ||
      entry.provisionMode !== 'local_path' ||
      !isRecoverableResidentWorkspaceEntry(entry)
    ) {
      throw new ControlError(
        'resident.workspace_resume_not_allowed',
        'This resident operation cannot be resumed by selecting a workspace.'
      )
    }
    this.assertProjectionAuthority(authority, 'resident workspace recovery')
    return structuredClone(entry)
  }

  private async requireRegisteredResidentWorkspaceRecoveryEntry(
    input: Extract<ResidentWorkspaceSelectionInput, { kind: 'registered_workspace' }>,
    operationId: string,
    authority: CapturedProjectionAuthority,
  ): Promise<ResidentProvisionOperationView> {
    if (!isHostId(operationId)) {
      throw new ControlError(
        'resident.workspace_resume_invalid',
        'The resident operation selected for recovery is invalid.'
      )
    }
    const ledger = await this.readResidentLifecycleLedger()
    const entry = ledger.entries.find((candidate) => candidate.operationId === operationId)
    if (!entry) {
      throw new ControlError(
        'resident.workspace_resume_unknown',
        'The resident operation selected for recovery is not available.'
      )
    }
    if (entry.expectedHostId !== authority.hostId) {
      throw new ControlError(
        'resident.workspace_resume_authority_changed',
        'The resident operation selected for recovery belongs to a different host.'
      )
    }
    if (
      entry.kind !== 'provision' ||
      entry.provisionMode !== 'registered_workspace' ||
      entry.projectId !== input.projectId ||
      entry.workspaceId !== input.workspaceId ||
      entry.referenceThreadId !== input.referenceThreadId ||
      entry.referenceExecutionGenerationId !== input.referenceExecutionGenerationId
    ) {
      throw new ControlError(
        'resident.workspace_resume_identity_changed',
        'The resident operation selected for recovery belongs to a different saved workspace reference.'
      )
    }

    let lookup: ResidentLifecycleLookupResult
    try {
      const raw = await authority.connection.request(
        'resident.lifecycle.status',
        { expectedHostId: authority.hostId, operationId },
        { timeoutMs: 30_000 }
      )
      this.assertProjectionAuthority(authority, 'registered resident workspace recovery status')
      lookup = ResidentLifecycleLookupResultSchema.parse(raw)
    } catch (error) {
      this.assertProjectionAuthority(authority, 'registered resident workspace recovery status')
      if (error instanceof ControlError && error.code.startsWith('protocol.')) throw error
      throw new ControlError(
        'resident.registered_workspace_recovery_unconfirmed',
        'The saved-workspace operation status could not be confirmed. Check status; no provision request was sent.',
        { retryable: true }
      )
    }
    if (!lookup.status) {
      await this.markResidentLifecycleStatusMissing(authority, operationId)
      throw new ControlError(
        'resident.registered_workspace_recovery_unconfirmed',
        'The host has not confirmed this saved-workspace operation. Check status; no provision request was sent.',
        { retryable: true }
      )
    }

    await this.acceptResidentLifecycleStatus(
      lookup.status,
      authority,
      operationId,
      undefined,
      { refreshCommittedProjection: false },
    )
    const refreshed = (await this.readResidentLifecycleLedger()).entries.find(
      (candidate) => candidate.operationId === operationId,
    )
    if (
      !refreshed ||
      refreshed.kind !== 'provision' ||
      refreshed.provisionMode !== 'registered_workspace' ||
      !canContinueRegisteredWorkspaceProvision(refreshed)
    ) {
      throw new ControlError(
        'resident.registered_workspace_recovery_status_only',
        'This saved-workspace operation can only be reconciled by status. It will not be replayed.',
        { retryable: false }
      )
    }
    this.assertProjectionAuthority(authority, 'registered resident workspace recovery')
    return structuredClone(refreshed)
  }

  private async revalidateRegisteredWorkspaceReference(
    input: Extract<ResidentWorkspaceSelectionInput, { kind: 'registered_workspace' }>,
    authority: CapturedProjectionAuthority,
  ): Promise<string> {
    let catalog: CatalogProjectionSnapshot
    try {
      const raw = await authority.connection.request('catalog.snapshot', {}, { timeoutMs: 45_000 })
      this.assertProjectionAuthority(authority, 'registered workspace catalog review')
      catalog = CatalogProjectionSnapshotSchema.parse(raw)
    } catch (error) {
      this.assertProjectionAuthority(authority, 'registered workspace catalog review')
      if (error instanceof ControlError && error.code.startsWith('protocol.')) throw error
      throw new ControlError(
        'resident.registered_workspace_projection_failed',
        'The saved workspace could not be refreshed from this SSH host.',
        { retryable: true }
      )
    }
    const project = catalog.projects.find(
      (candidate) =>
        candidate.projectId === input.projectId &&
        candidate.workspaceId === input.workspaceId &&
        candidate.hostId === authority.hostId,
    )
    const referenceThread = catalog.threads.find(
      (candidate) => candidate.threadId === input.referenceThreadId,
    )
    if (
      catalog.host.hostId !== authority.hostId ||
      !project ||
      !referenceThread ||
      referenceThread.currentLocation.hostId !== authority.hostId ||
      referenceThread.currentLocation.projectId !== input.projectId ||
      referenceThread.currentLocation.workspaceId !== input.workspaceId ||
      referenceThread.currentLocation.executionGenerationId !== input.referenceExecutionGenerationId
    ) {
      throw new ControlError(
        'resident.registered_workspace_reference_changed',
        'The saved workspace reference changed. Refresh the host catalog before continuing.',
        { retryable: true }
      )
    }
    try {
      await this.persistCatalog(catalog, authority)
    } catch {
      this.assertProjectionAuthority(authority, 'registered workspace catalog review')
      throw new ControlError(
        'resident.registered_workspace_projection_failed',
        'The saved workspace catalog could not be retained safely.',
        { retryable: true }
      )
    }
    this.assertProjectionAuthority(authority, 'registered workspace catalog review')

    let snapshot: ThreadProjectionSnapshot
    try {
      const raw = await authority.connection.request(
        'thread.snapshot',
        { threadId: input.referenceThreadId },
        { timeoutMs: 45_000 },
      )
      this.assertProjectionAuthority(authority, 'registered workspace thread review')
      snapshot = ThreadProjectionSnapshotSchema.parse(raw)
    } catch (error) {
      this.assertProjectionAuthority(authority, 'registered workspace thread review')
      if (error instanceof ControlError && error.code.startsWith('protocol.')) throw error
      throw new ControlError(
        'resident.registered_workspace_projection_failed',
        'The saved workspace thread could not be refreshed from this SSH host.',
        { retryable: true }
      )
    }
    if (
      snapshot.thread.threadId !== input.referenceThreadId ||
      snapshot.thread.currentLocation.hostId !== authority.hostId ||
      snapshot.thread.currentLocation.projectId !== input.projectId ||
      snapshot.thread.currentLocation.workspaceId !== input.workspaceId ||
      snapshot.thread.currentLocation.executionGenerationId !== input.referenceExecutionGenerationId ||
      snapshot.latestCursor.threadId !== input.referenceThreadId ||
      snapshot.latestCursor.executionGenerationId !== input.referenceExecutionGenerationId ||
      !isDeepStrictEqual(snapshot.thread, referenceThread)
    ) {
      throw new ControlError(
        'resident.registered_workspace_reference_changed',
        'The saved workspace thread changed. Refresh the host catalog before continuing.',
        { retryable: true }
      )
    }
    try {
      await this.persistThreadSnapshot(snapshot, authority)
    } catch {
      this.assertProjectionAuthority(authority, 'registered workspace thread review')
      throw new ControlError(
        'resident.registered_workspace_projection_failed',
        'The saved workspace thread could not be retained safely.',
        { retryable: true }
      )
    }
    this.assertProjectionAuthority(authority, 'registered workspace thread review')
    return project.displayName
  }

  private assertResidentSelectionAuthority(record: ResidentWorkspaceSelectionRecord, operation: string): void {
    const authority = record.provisionMode === 'local_path'
      ? this.captureLocalResidentProvisionAuthority(record.selection.expectedHostId)
      : this.captureRegisteredResidentWorkspaceAuthority(record.selection.expectedHostId)
    if (
      authority.connection !== record.authority.connection ||
      authority.generation !== record.authority.generation ||
      !sameTarget(authority.target, record.authority.target)
    ) {
      this.retireResidentWorkspaceSelection(record.selectionToken, 'authority_changed')
      throw new ControlError(
        'resident.workspace_selection_authority_changed',
        `The host connection changed during the ${operation}. Choose the workspace again.`,
        { retryable: true }
      )
    }
    this.assertProjectionAuthority(record.authority, operation)
  }

  private expireResidentWorkspaceSelections(): void {
    const timestamp = Date.now()
    for (const record of [...this.residentWorkspaceSelections.values()]) {
      if (Date.parse(record.selection.expiresAt) <= timestamp) {
        this.retireResidentWorkspaceSelection(record.selectionToken, 'expired')
      }
    }
  }

  private revokeResidentWorkspaceSelections(reason: RetiredResidentSelectionReason): void {
    for (const selectionToken of [...this.residentWorkspaceSelections.keys()]) {
      this.retireResidentWorkspaceSelection(selectionToken, reason)
    }
  }

  private retireResidentWorkspaceSelection(
    selectionToken: string,
    reason: RetiredResidentSelectionReason,
  ): void {
    const activeRecord = this.residentWorkspaceSelections.get(selectionToken)
    if (activeRecord?.inFlight) {
      // Keep the exact immutable selection reachable until every caller that
      // joined its one shared provision promise observes the same result and
      // durability classification. Terminal is the strongest retirement fact
      // and cannot be displaced by a later expiry or authority transition.
      if (activeRecord.pendingRetirement !== 'terminal' || reason === 'terminal') {
        activeRecord.pendingRetirement = reason
      }
      return
    }
    this.residentWorkspaceSelections.delete(selectionToken)
    this.retiredResidentSelections.delete(selectionToken)
    this.retiredResidentSelections.set(selectionToken, reason)
    while (this.retiredResidentSelections.size > RETIRED_RESIDENT_SELECTION_LIMIT) {
      const oldest = this.retiredResidentSelections.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.retiredResidentSelections.delete(oldest)
    }
  }

  private enforceResidentSelectionLimit(): void {
    // An in-flight selection is only marked for retirement and remains
    // addressable until its shared promise settles. Visit each candidate at
    // most once so an all-in-flight map cannot turn this bound into a loop.
    for (const selectionToken of [...this.residentWorkspaceSelections.keys()]) {
      if (this.residentWorkspaceSelections.size <= RESIDENT_SELECTION_LIMIT) break
      this.retireResidentWorkspaceSelection(selectionToken, 'superseded')
    }
  }

  private async runResidentEnd(record: ResidentEndConfirmationRecord): Promise<ResidentLifecycleStatus> {
    const mutationKey = residentEndMutationKey(record.identity)
    await this.withResidentEndMutationFence(mutationKey, async () => {
      this.assertResidentEndConfirmationAuthority(record)
      await this.recordResidentEndSubmission(record)
      this.assertResidentEndConfirmationAuthority(record)
    })

    let raw: unknown
    try {
      // No await may separate this exact-generation fence from the mutation
      // invocation. A reconnect after durable admission therefore cannot send
      // the reviewed operation over a replacement authority.
      this.assertResidentEndConfirmationAuthority(record)
      raw = await record.authority.connection.request(
        'resident.end',
        {
          operationId: record.confirmation.operationId,
          expectedHostId: record.identity.expectedHostId,
          projectId: record.identity.projectId,
          workspaceId: record.identity.workspaceId,
          threadId: record.identity.threadId,
          executionGenerationId: record.identity.executionGenerationId,
          expectedSourceCursor: record.sourceCursor,
        },
        { timeoutMs: RESIDENT_PROVISION_TIMEOUT_MS, priority: 'urgent' }
      )
    } catch (error) {
      if (isResidentEndSourceCursorChanged(error)) {
        await this.retireDefinitivelyRejectedResidentEnd(record)
        throw error
      }
      await this.updateResidentLifecycleLedgerState(
        record.authority,
        record.confirmation.operationId,
        'outcome_unknown'
      ).catch(() => undefined)
      const reconciled = await this.tryReconcileResidentEnd(record)
      if (reconciled) return reconciled
      throw new ControlError(
        'resident.end_outcome_unknown',
        'The host did not confirm the resident end. Check its durable status; do not send another end request.',
        {
          retryable: false,
          details: {
            expectedHostId: record.identity.expectedHostId,
            operationId: record.confirmation.operationId,
          },
        }
      )
    }

    this.assertProjectionAuthority(record.authority, 'resident end')
    let status: ResidentLifecycleStatus
    try {
      status = ResidentLifecycleStatusSchema.parse(raw)
    } catch {
      await this.updateResidentLifecycleLedgerState(
        record.authority,
        record.confirmation.operationId,
        'outcome_unknown'
      ).catch(() => undefined)
      const reconciled = await this.tryReconcileResidentEnd(record)
      if (reconciled) return reconciled
      throw new ControlError(
        'protocol.resident_lifecycle_invalid',
        'The host returned an invalid resident end lifecycle response.',
        {
          retryable: false,
          details: {
            expectedHostId: record.identity.expectedHostId,
            operationId: record.confirmation.operationId,
          },
        }
      )
    }
    return await this.acceptResidentLifecycleStatus(
      status,
      record.authority,
      record.confirmation.operationId,
    )
  }

  private async retireDefinitivelyRejectedResidentEnd(
    record: ResidentEndConfirmationRecord,
  ): Promise<void> {
    this.assertProjectionAuthority(record.authority, 'resident end pre-effect rejection')
    let retired = false
    await this.residentLifecycleLedger.update((persisted) => {
      this.assertProjectionAuthority(record.authority, 'resident end pre-effect rejection')
      const current = normalizeResidentLifecycleLedger(persisted)
      const index = current.entries.findIndex(
        (entry) =>
          entry.expectedHostId === record.identity.expectedHostId &&
          entry.operationId === record.confirmation.operationId
      )
      const existing = index < 0 ? undefined : current.entries[index]
      if (
        !existing ||
        existing.kind !== 'end' ||
        !residentEndIdentityMatches(existing, record.identity) ||
        !sameSessionCursor(existing.sourceCursor, record.sourceCursor) ||
        existing.lastStatus !== undefined ||
        existing.state !== 'submitted'
      ) {
        throw new ControlError(
          'protocol.resident_end_rejection_conflict',
          'The local resident end record changed after the host rejected it before effect.'
        )
      }
      const entries = [...current.entries]
      entries.splice(index, 1)
      retired = true
      return { version: 1, entries }
    })
    this.assertProjectionAuthority(record.authority, 'resident end pre-effect rejection')
    if (!retired) {
      throw new ControlError(
        'protocol.resident_end_rejection_conflict',
        'The rejected resident end record could not be retired safely.'
      )
    }
  }

  private async tryReconcileResidentEnd(
    record: ResidentEndConfirmationRecord,
  ): Promise<ResidentLifecycleStatus | undefined> {
    if (!this.isActiveConnection(
      record.authority.connection,
      record.authority.target,
      record.authority.hostId,
      record.authority.generation,
    )) return undefined
    try {
      const raw = await record.authority.connection.request(
        'resident.lifecycle.status',
        {
          expectedHostId: record.identity.expectedHostId,
          operationId: record.confirmation.operationId,
        },
        { timeoutMs: 30_000 }
      )
      this.assertProjectionAuthority(record.authority, 'resident end reconciliation')
      const lookup = ResidentLifecycleLookupResultSchema.parse(raw)
      if (!lookup.status) {
        await this.markResidentLifecycleStatusMissing(
          record.authority,
          record.confirmation.operationId,
        )
        return undefined
      }
      return await this.acceptResidentLifecycleStatus(
        lookup.status,
        record.authority,
        record.confirmation.operationId,
      )
    } catch (error) {
      if (error instanceof ControlError && error.code === 'resident.projection_refresh_failed') throw error
      return undefined
    }
  }

  private async recordResidentEndSubmission(record: ResidentEndConfirmationRecord): Promise<void> {
    const entry: ResidentEndOperationView = {
      kind: 'end',
      operationId: record.confirmation.operationId,
      expectedHostId: record.identity.expectedHostId,
      projectId: record.identity.projectId,
      workspaceId: record.identity.workspaceId,
      threadId: record.identity.threadId,
      executionGenerationId: record.identity.executionGenerationId,
      sourceCursor: structuredClone(record.sourceCursor),
      createdAt: record.createdAt,
      updatedAt: now(),
      state: 'submitted',
    }
    this.assertProjectionAuthority(record.authority, 'resident end admission')
    await this.residentLifecycleLedger.update((persisted) => {
      this.assertProjectionAuthority(record.authority, 'resident end admission')
      const current = normalizeResidentLifecycleLedger(persisted)
      const existingIndex = current.entries.findIndex(
        (candidate) => candidate.operationId === entry.operationId
      )
      if (existingIndex >= 0) {
        const existing = current.entries[existingIndex]
        if (!existing || !sameResidentLifecycleIdentity(existing, entry)) {
          throw new ControlError(
            'resident.end_ledger_conflict',
            'The resident end operation is already bound to different immutable details.'
          )
        }
        if (
          existing.kind !== 'end' ||
          existing.state !== 'submitted' ||
          existing.lastStatus?.kind !== 'end' ||
          existing.lastStatus.phase !== 'ending'
        ) {
          throw new ControlError(
            'resident.end_replay_blocked',
            'This durable end operation cannot send another end request. Check its status.'
          )
        }
        return current
      }

      const entries = [...current.entries]
      makeRoomForResidentLifecycleEntry(entries)
      entries.push(entry)
      return { version: 1, entries }
    })
    this.assertProjectionAuthority(record.authority, 'resident end admission')
  }

  private async runResidentProvision(
    record: ResidentWorkspaceSelectionRecord,
  ): Promise<ResidentLifecycleStatus> {
    const metadata = record.provisionMetadata
    if (!metadata) {
      throw new ControlError('resident.provision_metadata_missing', 'Resident provisioning details are missing.')
    }
    this.assertResidentSelectionAuthority(record, 'resident provisioning')
    await this.recordResidentLifecycleSubmission(record, metadata)
    this.assertResidentSelectionAuthority(record, 'resident provisioning')

    let raw: unknown
    try {
      const request = record.provisionMode === 'local_path'
        ? {
            expectedHostId: record.selection.expectedHostId,
            operationId: record.selection.operationId,
            projectId: record.projectId,
            workspaceId: record.workspaceId,
            threadId: record.threadId,
            executionGenerationId: record.executionGenerationId,
            workspaceDirectory: record.workspaceDirectory,
            projectDisplayName: metadata.projectDisplayName,
            threadTitle: metadata.threadTitle,
            createdAt: record.createdAt,
            ...(metadata.sessionName === undefined ? {} : { sessionName: metadata.sessionName }),
          }
        : {
            expectedHostId: record.selection.expectedHostId,
            operationId: record.selection.operationId,
            projectId: record.projectId,
            workspaceId: record.workspaceId,
            referenceThreadId: record.referenceThreadId,
            referenceExecutionGenerationId: record.referenceExecutionGenerationId,
            threadId: record.threadId,
            executionGenerationId: record.executionGenerationId,
            threadTitle: metadata.threadTitle,
            createdAt: record.createdAt,
            ...(metadata.sessionName === undefined ? {} : { sessionName: metadata.sessionName }),
          }
      raw = await record.authority.connection.request(
        record.provisionMode === 'local_path'
          ? 'resident.provision'
          : 'resident.provision.registered',
        request,
        { timeoutMs: RESIDENT_PROVISION_TIMEOUT_MS }
      )
    } catch {
      await this.updateResidentLifecycleLedgerState(
        record.authority,
        record.selection.operationId,
        'outcome_unknown'
      )
      const reconciled = await this.tryReconcileResidentProvision(record)
      if (reconciled) return reconciled
      throw new ControlError(
        'resident.provision_outcome_unknown',
        'The host did not confirm resident provisioning. Check its durable status before retrying the exact operation.',
        {
          retryable: true,
          details: {
            expectedHostId: record.selection.expectedHostId,
            operationId: record.selection.operationId,
          },
        }
      )
    }

    this.assertProjectionAuthority(record.authority, 'resident provisioning')
    let status: ResidentLifecycleStatus
    try {
      status = ResidentLifecycleStatusSchema.parse(raw)
    } catch {
      await this.updateResidentLifecycleLedgerState(
        record.authority,
        record.selection.operationId,
        'outcome_unknown'
      )
      throw new ControlError(
        'protocol.resident_lifecycle_invalid',
        'The host returned an invalid resident lifecycle response.',
        {
          retryable: true,
          details: {
            expectedHostId: record.selection.expectedHostId,
            operationId: record.selection.operationId,
          },
        }
      )
    }
    return await this.acceptResidentLifecycleStatus(
      status,
      record.authority,
      record.selection.operationId,
      record,
    )
  }

  private async tryReconcileResidentProvision(
    record: ResidentWorkspaceSelectionRecord,
  ): Promise<ResidentLifecycleStatus | undefined> {
    if (!this.isActiveConnection(
      record.authority.connection,
      record.authority.target,
      record.authority.hostId,
      record.authority.generation,
    )) return undefined
    try {
      const raw = await record.authority.connection.request(
        'resident.lifecycle.status',
        {
          expectedHostId: record.selection.expectedHostId,
          operationId: record.selection.operationId,
        },
        { timeoutMs: 30_000 }
      )
      this.assertProjectionAuthority(record.authority, 'resident provisioning reconciliation')
      const lookup = ResidentLifecycleLookupResultSchema.parse(raw)
      if (!lookup.status) {
        await this.markResidentLifecycleStatusMissing(record.authority, record.selection.operationId)
        return undefined
      }
      return await this.acceptResidentLifecycleStatus(
        lookup.status,
        record.authority,
        record.selection.operationId,
        record,
      )
    } catch (error) {
      if (error instanceof ControlError && error.code === 'resident.projection_refresh_failed') throw error
      return undefined
    }
  }

  private async recordResidentLifecycleSubmission(
    record: ResidentWorkspaceSelectionRecord,
    metadata: ResidentProvisionMetadata,
  ): Promise<void> {
    const baseEntry = {
      kind: 'provision',
      operationId: record.selection.operationId,
      expectedHostId: record.selection.expectedHostId,
      projectId: record.projectId,
      workspaceId: record.workspaceId,
      threadId: record.threadId,
      executionGenerationId: record.executionGenerationId,
      projectDisplayName: metadata.projectDisplayName,
      threadTitle: metadata.threadTitle,
      ...(metadata.sessionName === undefined ? {} : { sessionName: metadata.sessionName }),
      createdAt: record.createdAt,
      updatedAt: now(),
      state: 'submitted',
    } as const
    const entry: ResidentProvisionOperationView = record.provisionMode === 'local_path'
      ? {
          ...baseEntry,
          provisionMode: 'local_path',
        }
      : {
          ...baseEntry,
          provisionMode: 'registered_workspace',
          referenceThreadId: record.referenceThreadId,
          referenceExecutionGenerationId: record.referenceExecutionGenerationId,
        }
    this.assertProjectionAuthority(record.authority, 'resident lifecycle submission')
    try {
      await this.residentLifecycleLedger.update((persisted) => {
        this.assertProjectionAuthority(record.authority, 'resident lifecycle submission')
        const current = normalizeResidentLifecycleLedger(persisted)
        const existingIndex = current.entries.findIndex(
          (candidate) => candidate.operationId === entry.operationId
        )
        if (existingIndex >= 0) {
          const existing = current.entries[existingIndex]
          if (!existing || !sameResidentLifecycleIdentity(existing, entry)) {
            throw new ControlError(
              'resident.provision_ledger_conflict',
              'The resident lifecycle operation is already bound to different immutable details.'
            )
          }
          // This exact immutable identity is already durable, including when
          // its state blocks replay. Every caller sharing this selection must
          // reconcile by operation ID if a later step fails.
          record.durableOperationPossible = true
          const exactSafeContinuation = Boolean(
            entry.provisionMode === 'registered_workspace' &&
            existing.kind === 'provision' &&
            existing.provisionMode === 'registered_workspace' &&
            canContinueRegisteredWorkspaceProvision(existing)
          )
          if (
            entry.provisionMode === 'registered_workspace' &&
            existing.kind === 'provision' &&
            existing.provisionMode === 'registered_workspace' &&
            (existing.state === 'submitted' || existing.state === 'outcome_unknown') &&
            !exactSafeContinuation
          ) {
            throw new ControlError(
              'resident.registered_workspace_replay_blocked',
              'This saved-workspace operation may have reached the host. Check status; it will not be replayed.'
            )
          }
          // A delayed retry admission can finish after a status lookup has
          // already established a newer durable fact. Local intent is never
          // allowed to move any host-confirmed status backwards.
          if (
            existing.state === 'terminal' ||
            existing.state === 'terminal_refresh_pending' ||
            existing.lastStatus !== undefined
          ) return current
          const entries = [...current.entries]
          entries[existingIndex] = {
            ...existing,
            updatedAt: entry.updatedAt,
            state: 'submitted',
          }
          return { version: 1, entries }
        }

        const entries = [...current.entries]
        makeRoomForResidentLifecycleEntry(entries)
        entries.push(entry)
        return { version: 1, entries }
      })
      record.durableOperationPossible = true
    } catch (error) {
      if (error instanceof ControlError && error.code === 'storage.commit_uncertain') {
        record.durableOperationPossible = true
      }
      throw error
    }
    this.assertProjectionAuthority(record.authority, 'resident lifecycle submission')
  }

  private async updateResidentLifecycleLedgerState(
    authority: CapturedProjectionAuthority,
    operationId: string,
    state: ResidentLifecycleOperationView['state'],
  ): Promise<void> {
    this.assertProjectionAuthority(authority, 'resident lifecycle state update')
    await this.residentLifecycleLedger.update((persisted) => {
      // This fence deliberately runs inside the store's serialized callback.
      // An old connection waiting behind another ledger write cannot mutate
      // durable state after its generation has been replaced.
      this.assertProjectionAuthority(authority, 'resident lifecycle state update')
      const current = normalizeResidentLifecycleLedger(persisted)
      const index = current.entries.findIndex(
        (entry) => entry.expectedHostId === authority.hostId && entry.operationId === operationId
      )
      if (index < 0) return current
      const existing = current.entries[index]
      if (!existing) return current
      if (
        existing.state === 'terminal' ||
        existing.state === 'terminal_refresh_pending' ||
        existing.lastStatus !== undefined
      ) {
        return current
      }
      const entries = [...current.entries]
      entries[index] = {
        ...existing,
        updatedAt: now(),
        state,
      }
      return { version: 1, entries }
    })
    this.assertProjectionAuthority(authority, 'resident lifecycle state update')
  }

  private async markResidentLifecycleStatusMissing(
    authority: CapturedProjectionAuthority,
    operationId: string,
  ): Promise<void> {
    this.expireResidentWorkspaceSelections()
    this.assertProjectionAuthority(authority, 'resident lifecycle missing status')
    await this.residentLifecycleLedger.update((persisted) => {
      this.assertProjectionAuthority(authority, 'resident lifecycle missing status')
      const current = normalizeResidentLifecycleLedger(persisted)
      const index = current.entries.findIndex(
        (entry) => entry.expectedHostId === authority.hostId && entry.operationId === operationId
      )
      if (index < 0) return current
      const existing = current.entries[index]
      if (!existing) return current
      // HostStore lifecycle records are immutable once observed. A later null
      // can only be a stale or contradictory response; never erase the fact
      // already persisted by a newer response.
      if (existing.lastStatus !== undefined) {
        throw new ControlError(
          'protocol.resident_lifecycle_status_missing',
          'The host omitted a resident lifecycle record that was observed previously.'
        )
      }
      const hasLiveSelection = existing.kind === 'provision' && [...this.residentWorkspaceSelections.values()].some(
        (record) =>
          record.selection.expectedHostId === authority.hostId &&
          record.selection.operationId === operationId
      )
      const entries = [...current.entries]
      entries[index] = {
        ...existing,
        updatedAt: now(),
        state: existing.kind === 'end'
          ? 'outcome_unknown'
          : existing.provisionMode === 'registered_workspace'
            ? 'outcome_unknown'
          : hasLiveSelection ? 'outcome_unknown' : 'requires_reselection',
      }
      return { version: 1, entries }
    })
    this.assertProjectionAuthority(authority, 'resident lifecycle missing status')
  }

  private async reconcileResidentLifecycleLedgerAfterConnect(
    authority: CapturedProjectionAuthority,
  ): Promise<void> {
    let ledger: ResidentLifecycleLedger
    try {
      ledger = await this.readResidentLifecycleLedger()
    } catch {
      // A malformed durable ledger is surfaced by bootstrap. It must not make
      // an otherwise verified host connection unavailable or trigger replay.
      return
    }
    const entries = ledger.entries
      .filter(
        (entry) =>
          entry.expectedHostId === authority.hostId &&
          entry.state !== 'terminal'
      )
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, RESIDENT_RECONNECT_RECONCILE_LIMIT)
    if (entries.length === 0) return

    const observations = await Promise.all(entries.map(async (entry) => {
      try {
        const raw = await authority.connection.request(
          'resident.lifecycle.status',
          { expectedHostId: authority.hostId, operationId: entry.operationId },
          { timeoutMs: RESIDENT_RECONNECT_STATUS_TIMEOUT_MS }
        )
        return {
          entry,
          lookup: ResidentLifecycleLookupResultSchema.parse(raw),
        }
      } catch {
        return { entry, lookup: undefined }
      }
    }))

    for (const observation of observations) {
      if (!this.isActiveConnection(
        authority.connection,
        authority.target,
        authority.hostId,
        authority.generation,
      )) return
      if (!observation.lookup) continue
      try {
        if (observation.lookup.status) {
          await this.acceptResidentLifecycleStatus(
            observation.lookup.status,
            authority,
            observation.entry.operationId,
            undefined,
            { refreshCommittedProjection: false },
          )
        } else {
          await this.markResidentLifecycleStatusMissing(authority, observation.entry.operationId)
        }
      } catch {
        // Each durable identity is isolated. One stale/malformed result cannot
        // prevent the remaining exact status-only reconciliations.
      }
    }
  }

  private scheduleResidentProjectionRefreshAfterConnect(
    authority: CapturedProjectionAuthority,
  ): void {
    let operation!: Promise<void>
    operation = this.enqueueResidentProjectionRefresh(
      () => this.refreshPendingResidentProjections(authority)
    )
      .catch(() => undefined)
      .finally(() => {
        if (this.residentProjectionRefreshPromise === operation) {
          this.residentProjectionRefreshPromise = undefined
        }
      })
    this.residentProjectionRefreshPromise = operation
  }

  private async enqueueResidentProjectionRefresh<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.residentProjectionRefreshTail.then(operation)
    this.residentProjectionRefreshTail = result.then(() => undefined, () => undefined)
    return await result
  }

  private async refreshPendingResidentProjections(
    authority: CapturedProjectionAuthority,
  ): Promise<void> {
    const ledger = await this.readResidentLifecycleLedger()
    const pending = ledger.entries
      .flatMap((entry) =>
        entry.expectedHostId === authority.hostId &&
        entry.state === 'terminal_refresh_pending' &&
        entry.lastStatus !== undefined && residentLifecycleStatusNeedsProjectionRefresh(entry.lastStatus)
          ? [{ entry, status: entry.lastStatus }]
          : []
      )
      .sort((left, right) => Date.parse(right.entry.updatedAt) - Date.parse(left.entry.updatedAt))
      .slice(0, RESIDENT_BACKGROUND_REFRESH_LIMIT)
    if (pending.length === 0) return
    if (!this.isActiveConnection(
      authority.connection,
      authority.target,
      authority.hostId,
      authority.generation,
    )) return

    const deadline = Date.now() + RESIDENT_BACKGROUND_REFRESH_BUDGET_MS
    let catalog: CatalogProjectionSnapshot
    try {
      const rawCatalog = await authority.connection.request(
        'catalog.snapshot',
        {},
        {
          timeoutMs: Math.min(
            RESIDENT_BACKGROUND_REFRESH_REQUEST_TIMEOUT_MS,
            Math.max(1, deadline - Date.now()),
          ),
        }
      )
      this.assertProjectionAuthority(authority, 'resident background catalog refresh')
      catalog = CatalogProjectionSnapshotSchema.parse(rawCatalog)
      const accepted = await this.persistCatalog(catalog, authority)
      if (accepted && this.isActiveConnection(
        authority.connection,
        authority.target,
        authority.hostId,
        authority.generation,
      )) this.emit('snapshot', catalog)
    } catch {
      return
    }

    const groups = new Map<string, typeof pending>()
    for (const item of pending) {
      const key = residentProjectionIdentityKey(item.status)
      const group = groups.get(key) ?? []
      group.push(item)
      groups.set(key, group)
    }
    for (const group of groups.values()) {
      if (Date.now() >= deadline) return
      if (!this.isActiveConnection(
        authority.connection,
        authority.target,
        authority.hostId,
        authority.generation,
      )) return
      const representative = group[0]
      if (!representative) continue
      try {
        const expectedThreadStatus = this.assertCommittedResidentCatalogIdentity(
          representative.status,
          catalog,
          representative.entry,
        )
        await this.assertResidentCatalogProjectionPersisted(
          representative.status,
          representative.entry,
          authority,
          expectedThreadStatus,
        )
        await this.refreshCommittedResidentThread(
          representative.status,
          authority,
          Math.min(
            RESIDENT_BACKGROUND_REFRESH_REQUEST_TIMEOUT_MS,
            Math.max(1, deadline - Date.now()),
          ),
          representative.entry,
          expectedThreadStatus,
        )
        for (const item of group) {
          await this.markResidentProjectionRefreshed(
            authority,
            item.entry.operationId,
            item.status,
          )
        }
      } catch {
        // Leave this exact status refresh-pending. A later reconnect or an
        // explicit status lookup retries it without replaying a lifecycle mutation.
      }
    }
  }

  private async acceptResidentLifecycleStatus(
    status: ResidentLifecycleStatus,
    authority: CapturedProjectionAuthority,
    operationId: string,
    record?: ResidentWorkspaceSelectionRecord,
    options: { refreshCommittedProjection?: boolean } = {},
  ): Promise<ResidentLifecycleStatus> {
    this.assertProjectionAuthority(authority, 'resident lifecycle confirmation')
    if (
      status.operationId !== operationId ||
      status.expectedHostId !== authority.hostId ||
      (record && !residentStatusMatchesSelection(status, record))
    ) {
      throw new ControlError(
        'protocol.resident_lifecycle_identity_mismatch',
        'The host returned resident lifecycle state for a different immutable operation.'
      )
    }

    const merged = await this.mergeResidentLifecycleStatus(status, authority, operationId)
    let acceptedStatus = merged.status
    const terminal = isTerminalResidentLifecycleStatus(acceptedStatus)
    if (terminal) {
      for (const candidate of [...this.residentWorkspaceSelections.values()]) {
        if (
          candidate.selection.expectedHostId === authority.hostId &&
          candidate.selection.operationId === operationId
        ) {
          this.retireResidentWorkspaceSelection(candidate.selectionToken, 'terminal')
        }
      }
    }
    if (
      residentLifecycleStatusNeedsProjectionRefresh(acceptedStatus) &&
      merged.state !== 'terminal' &&
      options.refreshCommittedProjection !== false
    ) {
      await this.refreshCommittedResidentProjection(acceptedStatus, authority)
      acceptedStatus = await this.markResidentProjectionRefreshed(
        authority,
        operationId,
        acceptedStatus,
      )
    }
    this.assertProjectionAuthority(authority, 'resident lifecycle confirmation')
    return acceptedStatus
  }

  private async mergeResidentLifecycleStatus(
    status: ResidentLifecycleStatus,
    authority: CapturedProjectionAuthority,
    operationId: string,
  ): Promise<ResidentLifecycleStatusMerge> {
    let merged: ResidentLifecycleStatusMerge = { status }
    this.assertProjectionAuthority(authority, 'resident lifecycle status merge')
    await this.residentLifecycleLedger.update((persisted) => {
      // Reads followed by a separate update admit a classic stale-response
      // race. Compare and replace under the store's one serialized callback so
      // the status with the newest host timestamp is the only possible winner.
      this.assertProjectionAuthority(authority, 'resident lifecycle status merge')
      const current = normalizeResidentLifecycleLedger(persisted)
      const index = current.entries.findIndex(
        (entry) => entry.expectedHostId === authority.hostId && entry.operationId === operationId
      )
      if (index < 0) return current
      const existing = current.entries[index]
      if (!existing) return current
      if (!residentStatusMatchesLedger(status, existing)) {
        throw new ControlError(
          'protocol.resident_lifecycle_identity_mismatch',
          'The host returned resident lifecycle state for different generated identifiers.'
        )
      }

      const persistedStatus = existing.lastStatus
      if (persistedStatus) {
        if (!sameResidentLifecycleStatusIdentity(persistedStatus, status)) {
          throw new ControlError(
            'protocol.resident_lifecycle_identity_mismatch',
            'The host changed immutable resident lifecycle status identity.'
          )
        }
        const persistedUpdatedAt = Date.parse(persistedStatus.updatedAt)
        const incomingUpdatedAt = Date.parse(status.updatedAt)
        if (incomingUpdatedAt < persistedUpdatedAt) {
          merged = { status: persistedStatus, state: existing.state }
          return current
        }
        if (incomingUpdatedAt === persistedUpdatedAt) {
          if (!isDeepStrictEqual(persistedStatus, status)) {
            throw new ControlError(
              'protocol.resident_lifecycle_status_conflict',
              'The host returned conflicting resident lifecycle states at the same timestamp.'
            )
          }
          const state = convergedResidentLifecycleState(existing.state, persistedStatus)
          merged = { status: persistedStatus, state }
          if (state === existing.state) return current
          const entries = [...current.entries]
          entries[index] = { ...existing, updatedAt: now(), state }
          return { version: 1, entries }
        }
        if (isTerminalResidentLifecycleStatus(persistedStatus)) {
          throw new ControlError(
            'protocol.resident_lifecycle_terminal_changed',
            'The host changed a terminal resident lifecycle state after it was persisted.'
          )
        }
      }

      const state = residentLifecycleStateForStatus(status)
      const entries = [...current.entries]
      entries[index] = {
        ...existing,
        updatedAt: now(),
        state,
        lastStatus: status,
      }
      merged = { status, state }
      return { version: 1, entries }
    })
    this.assertProjectionAuthority(authority, 'resident lifecycle status merge')
    return merged
  }

  private async markResidentProjectionRefreshed(
    authority: CapturedProjectionAuthority,
    operationId: string,
    refreshedStatus: ResidentLifecycleStatus,
  ): Promise<ResidentLifecycleStatus> {
    let currentStatus = refreshedStatus
    this.assertProjectionAuthority(authority, 'resident projection refresh commit')
    await this.residentLifecycleLedger.update((persisted) => {
      this.assertProjectionAuthority(authority, 'resident projection refresh commit')
      const current = normalizeResidentLifecycleLedger(persisted)
      const index = current.entries.findIndex(
        (entry) => entry.expectedHostId === authority.hostId && entry.operationId === operationId
      )
      if (index < 0) return current
      const existing = current.entries[index]
      if (!existing?.lastStatus) return current
      const persistedStatus = existing.lastStatus
      if (
        !residentStatusMatchesLedger(refreshedStatus, existing) ||
        !sameResidentLifecycleStatusIdentity(persistedStatus, refreshedStatus)
      ) {
        throw new ControlError(
          'protocol.resident_lifecycle_identity_mismatch',
          'The resident lifecycle identity changed during its projection refresh.'
        )
      }
      const persistedUpdatedAt = Date.parse(persistedStatus.updatedAt)
      const refreshedUpdatedAt = Date.parse(refreshedStatus.updatedAt)
      if (persistedUpdatedAt > refreshedUpdatedAt) {
        currentStatus = persistedStatus
        return current
      }
      if (
        persistedUpdatedAt !== refreshedUpdatedAt ||
        !isDeepStrictEqual(persistedStatus, refreshedStatus)
      ) {
        throw new ControlError(
          'protocol.resident_lifecycle_status_conflict',
          'The resident lifecycle state changed inconsistently during its projection refresh.'
        )
      }
      currentStatus = persistedStatus
      if (existing.state === 'terminal') return current
      if (
        existing.state !== 'terminal_refresh_pending' ||
        !residentLifecycleStatusNeedsProjectionRefresh(persistedStatus)
      ) {
        return current
      }
      const entries = [...current.entries]
      entries[index] = { ...existing, updatedAt: now(), state: 'terminal' }
      return { version: 1, entries }
    })
    this.assertProjectionAuthority(authority, 'resident projection refresh commit')
    return currentStatus
  }

  private async refreshCommittedResidentProjection(
    status: ResidentLifecycleStatus,
    authority: CapturedProjectionAuthority,
  ): Promise<void> {
    await this.enqueueResidentProjectionRefresh(
      () => this.refreshCommittedResidentProjectionUnlocked(status, authority)
    )
  }

  private async refreshCommittedResidentProjectionUnlocked(
    status: ResidentLifecycleStatus,
    authority: CapturedProjectionAuthority,
  ): Promise<void> {
    try {
      const ledger = await this.readResidentLifecycleLedger()
      const entry = ledger.entries.find(
        (candidate) =>
          candidate.expectedHostId === status.expectedHostId &&
          candidate.operationId === status.operationId
      )
      if (!entry || !residentStatusMatchesLedger(status, entry)) {
        throw new ControlError(
          'protocol.resident_lifecycle_identity_mismatch',
          'The durable lifecycle entry changed before its projection refresh.'
        )
      }
      const rawCatalog = await authority.connection.request(
        'catalog.snapshot',
        {},
        { timeoutMs: 45_000 }
      )
      this.assertProjectionAuthority(authority, 'resident catalog refresh')
      const catalog = CatalogProjectionSnapshotSchema.parse(rawCatalog)
      const expectedThreadStatus = this.assertCommittedResidentCatalogIdentity(status, catalog, entry)
      const accepted = await this.persistCatalog(catalog, authority)
      if (accepted && this.isActiveConnection(
        authority.connection,
        authority.target,
        authority.hostId,
        authority.generation,
      )) this.emit('snapshot', catalog)
      await this.assertResidentCatalogProjectionPersisted(
        status,
        entry,
        authority,
        expectedThreadStatus,
      )
      await this.refreshCommittedResidentThread(
        status,
        authority,
        45_000,
        entry,
        expectedThreadStatus,
      )
    } catch (error) {
      if (error instanceof ControlError && error.code.startsWith('protocol.resident_')) throw error
      throw new ControlError(
        'resident.projection_refresh_failed',
        'The resident lifecycle completed, but its terminal projection could not be refreshed.',
        {
          retryable: true,
          details: { expectedHostId: status.expectedHostId, operationId: status.operationId },
        }
      )
    }
  }

  private assertCommittedResidentCatalogIdentity(
    status: ResidentLifecycleStatus,
    catalog: CatalogProjectionSnapshot,
    entry: ResidentLifecycleOperationView,
  ): TaskState {
    const project = catalog.projects.find((candidate) => candidate.projectId === status.projectId)
    const thread = catalog.threads.find((candidate) => candidate.threadId === status.threadId)
    if (
      !project ||
      project.workspaceId !== status.workspaceId ||
      project.hostId !== status.expectedHostId ||
      !thread ||
      thread.currentLocation.projectId !== status.projectId ||
      thread.currentLocation.workspaceId !== status.workspaceId ||
      thread.currentLocation.executionGenerationId !== status.executionGenerationId ||
      (status.kind === 'end' && (
        entry.kind !== 'end' ||
        !isResidentEndedTaskState(thread.status) ||
        thread.recap !== RESIDENT_ENDED_RECAP ||
        !thread.lastKnownCursor ||
        !sameSessionCursor(thread.lastKnownCursor, entry.sourceCursor)
      ))
    ) {
      throw new ControlError(
        'protocol.resident_catalog_identity_mismatch',
        'The refreshed catalog did not contain the committed resident operation.'
      )
    }
    return thread.status
  }

  private async assertResidentCatalogProjectionPersisted(
    status: ResidentLifecycleStatus,
    entry: ResidentLifecycleOperationView,
    authority: CapturedProjectionAuthority,
    expectedThreadStatus: TaskState,
  ): Promise<void> {
    const cache = await this.readCache()
    this.assertProjectionAuthority(authority, 'resident catalog persistence proof')
    const parsed = CatalogProjectionSnapshotSchema.safeParse(cache.entries[authority.hostId]?.catalog)
    if (!parsed.success) {
      throw new ControlError(
        'protocol.resident_catalog_persistence_mismatch',
        'The terminal resident catalog was not persisted.'
      )
    }
    const persistedThreadStatus = this.assertCommittedResidentCatalogIdentity(status, parsed.data, entry)
    if (persistedThreadStatus !== expectedThreadStatus) {
      throw new ControlError(
        'protocol.resident_catalog_persistence_mismatch',
        'The persisted terminal resident catalog changed its authoritative thread status.'
      )
    }
  }

  private async refreshCommittedResidentThread(
    status: ResidentLifecycleStatus,
    authority: CapturedProjectionAuthority,
    timeoutMs: number,
    entry: ResidentLifecycleOperationView,
    expectedThreadStatus: TaskState,
  ): Promise<void> {
    const rawSnapshot = await authority.connection.request(
      'thread.snapshot',
      { threadId: status.threadId },
      { timeoutMs }
    )
    this.assertProjectionAuthority(authority, 'resident thread refresh')
    const snapshot = ThreadProjectionSnapshotSchema.parse(rawSnapshot)
    if (
      snapshot.thread.threadId !== status.threadId ||
      snapshot.thread.currentLocation.hostId !== status.expectedHostId ||
      snapshot.thread.currentLocation.projectId !== status.projectId ||
      snapshot.thread.currentLocation.workspaceId !== status.workspaceId ||
      snapshot.thread.currentLocation.executionGenerationId !== status.executionGenerationId ||
      (status.kind === 'end' && !residentEndProjectionMatchesOperation(
        snapshot,
        status,
        entry,
        expectedThreadStatus,
      ))
    ) {
      throw new ControlError(
        'protocol.resident_snapshot_identity_mismatch',
        'The refreshed thread did not match the committed resident operation.'
      )
    }
    const accepted = await this.persistThreadSnapshot(snapshot, authority)
    if (accepted && this.isActiveConnection(
      authority.connection,
      authority.target,
      authority.hostId,
      authority.generation,
    )) this.emit('snapshot', snapshot)
    const cache = await this.readCache()
    this.assertProjectionAuthority(authority, 'resident thread persistence proof')
    const persisted = ThreadProjectionSnapshotSchema.safeParse(cache.entries[authority.hostId]?.lastSnapshot)
    if (
      !persisted.success ||
      persisted.data.thread.threadId !== status.threadId ||
      persisted.data.thread.currentLocation.hostId !== status.expectedHostId ||
      persisted.data.thread.currentLocation.projectId !== status.projectId ||
      persisted.data.thread.currentLocation.workspaceId !== status.workspaceId ||
      persisted.data.thread.currentLocation.executionGenerationId !== status.executionGenerationId ||
      (status.kind === 'end' && !residentEndProjectionMatchesOperation(
        persisted.data,
        status,
        entry,
        expectedThreadStatus,
      ))
    ) {
      throw new ControlError(
        'protocol.resident_snapshot_persistence_mismatch',
        'The terminal resident thread projection was not persisted.'
      )
    }
  }

  private assertProjectionAuthority(authority: CapturedProjectionAuthority, operation: string): void {
    if (!this.isActiveConnection(
      authority.connection,
      authority.target,
      authority.hostId,
      authority.generation
    )) {
      throw new ControlError(
        'connection.superseded',
        `The host connection changed during the ${operation}. Refresh from the current host before continuing.`,
        { retryable: true }
      )
    }
  }

  private async bindAuthority(target: ConnectionTarget, hostId: string, generation: number): Promise<boolean> {
    const verifiedAt = now()
    let projectionInvalidated = false
    await this.cache.update((current) => {
      const cache = normalizeCache(current)
      const remainsCurrent =
        generation === this.reconnectGeneration &&
        !this.intentionallyOffline &&
        Boolean(this.target && sameTarget(this.target, target))
      if (!remainsCurrent) return cache
      const targetHostBindings = cache.targetHostBindings
        .filter((binding) => !sameTarget(binding.target, target))
        .slice(-(TARGET_BINDING_LIMIT - 1))
      targetHostBindings.push({ target, hostId, verifiedAt })
      projectionInvalidated = Boolean(cache.activeHostId && cache.activeHostId !== hostId)
      return {
        ...cache,
        version: 3,
        targetHostBindings,
        lastTarget: target,
        lastTargetUpdatedAt: verifiedAt,
        lastAttemptedTarget: target,
        lastAttemptedAt: verifiedAt,
        activeHostId: hostId,
      }
    })
    if (
      generation !== this.reconnectGeneration ||
      this.intentionallyOffline ||
      !this.target ||
      !sameTarget(this.target, target)
    ) {
      throw new ControlError('connection.superseded', 'The connection attempt was superseded.')
    }
    this.authorityHostId = hostId
    return projectionInvalidated
  }

  private async requireDiscoveredAlias(alias: string): Promise<void> {
    if (!this.discoveredAliases.has(alias)) {
      const parsed = await parseSshConfigAliases()
      for (const host of parsed) this.discoveredAliases.add(host.alias)
    }
    if (!this.discoveredAliases.has(alias)) {
      throw new ControlError('ssh.alias_not_discovered', 'Choose a concrete host from your SSH configuration.', {
        details: { alias }
      })
    }
  }

  private async persistCatalog(catalog: unknown, authority: CapturedProjectionAuthority): Promise<boolean> {
    const parsedCatalog = CatalogProjectionSnapshotSchema.parse(catalog)
    this.assertProjectionAuthority(authority, 'catalog refresh')
    if (parsedCatalog.host.hostId !== authority.hostId) {
      throw new ControlError('protocol.authority_mismatch', 'The catalog belongs to a different host authority.', {
        details: { expectedHostId: authority.hostId, receivedHostId: parsedCatalog.host.hostId }
      })
    }
    let accepted = false
    await this.cache.update((current) => {
      this.assertProjectionAuthority(authority, 'catalog refresh')
      const cache = normalizeCache(current)
      const previous = cache.entries[authority.hostId]
      const decision = catalogProjectionDecision(previous, parsedCatalog)
      if (!decision.accept) return cache
      accepted = true
      return replaceProjectionEntry(cache, authority.hostId, {
        ...previous,
        hostId: authority.hostId,
        catalog: parsedCatalog,
        retiredExecutionGenerations: decision.retiredExecutionGenerations,
        updatedAt: now(),
      })
    })
    this.assertProjectionAuthority(authority, 'catalog refresh')
    return accepted
  }

  private async persistThreadSnapshot(
    snapshot: ThreadProjectionSnapshot,
    authority: CapturedProjectionAuthority,
  ): Promise<boolean> {
    this.assertProjectionAuthority(authority, 'thread snapshot')
    if (snapshot.thread.currentLocation.hostId !== authority.hostId) {
      throw new ControlError('protocol.authority_mismatch', 'The thread snapshot belongs to a different host authority.', {
        details: { expectedHostId: authority.hostId, receivedHostId: snapshot.thread.currentLocation.hostId },
      })
    }
    let accepted = false
    await this.cache.update((current) => {
      this.assertProjectionAuthority(authority, 'thread snapshot')
      const cache = normalizeCache(current)
      const previous = cache.entries[authority.hostId]
      const decision = threadSnapshotProjectionDecision(previous, snapshot)
      if (!decision.accept) return cache
      accepted = true
      return replaceProjectionEntry(cache, authority.hostId, {
        ...previous,
        hostId: authority.hostId,
        lastSnapshot: snapshot,
        retiredExecutionGenerations: decision.retiredExecutionGenerations,
        retiredCursorGenerations: decision.retiredCursorGenerations,
        updatedAt: now(),
      })
    })
    this.assertProjectionAuthority(authority, 'thread snapshot')
    return accepted
  }

  private async readCache(): Promise<CacheEnvelope> {
    return normalizeCache(await this.cache.read())
  }

  private async readRawOutbox(): Promise<unknown[]> {
    const entries = await this.outbox.read()
    if (!Array.isArray(entries)) return []
    return entries
  }

  private async readOutboxClassification(
    reserveMissingIdentities: boolean,
    initial?: Readonly<{ raw: unknown[]; ledger: CommandIdentityLedger }>,
  ): Promise<OutboxClassification> {
    const raw = initial?.raw ?? await this.readRawOutbox()
    if (raw.length === 0) return { actionable: [], quarantinedCount: 0 }
    let ledger = initial?.ledger ?? await this.commandIdentities.read()
    let classification = classifyRawOutbox(raw, ledger)
    if (!reserveMissingIdentities) return classification

    const missing = classification.actionable.filter((entry) => !findCommandIdentity(ledger, entry.command))
    if (missing.length > 0) {
      ledger = await this.commandIdentities.update((current) => {
        const entries = [...current.entries]
        for (const pending of missing) {
          const existing = entries.find(
            (entry) =>
              entry.deviceId === pending.command.deviceId &&
              entry.commandId === pending.command.commandId,
          )
          if (existing) continue
          if (entries.length >= COMMAND_IDENTITY_LEDGER_LIMIT) break
          entries.push({
            deviceId: pending.command.deviceId,
            commandId: pending.command.commandId,
            hostId: pending.command.expectedHostId,
            envelopeSha256: commandEnvelopeSha256(adaptCommand(pending.command)),
            reservedAt: now(),
          })
        }
        return entries.length === current.entries.length ? current : { version: 1, entries }
      })
    }
    classification = classifyRawOutbox(raw, ledger)
    return classification
  }

  private async assertOutboxIdentityAvailable(entry: ScopedOutboxEntry): Promise<void> {
    const matches = (await this.readRawOutbox()).filter((candidate) =>
      rawOutboxIdentityMatches(candidate, entry.command.deviceId, entry.command.commandId)
    )
    if (matches.length === 0) return
    if (matches.length === 1 && isExactReplaceableOutboxEntry(matches[0], entry)) {
      if (matches[0].state === 'waiting_for_connection') return
      throw new ControlError(
        'command.awaiting_reconciliation',
        'This exact command already crossed a non-replayable boundary and may only be reconciled.',
        {
          retryable: false,
          details: {
            deviceId: entry.command.deviceId,
            commandId: entry.command.commandId,
            state: matches[0].state,
          },
        },
      )
    }
    throw new ControlError(
      'command.identity_conflict',
      'This device command ID is already held by another or unverifiable local command.',
      { details: { deviceId: entry.command.deviceId, commandId: entry.command.commandId } },
    )
  }

  private async reserveCommandIdentity(
    command: ClientCommand,
    envelope: CommandEnvelope = adaptCommand(command),
  ): Promise<void> {
    const envelopeSha256 = commandEnvelopeSha256(envelope)
    await this.commandIdentities.update((current) => {
      const existing = current.entries.find(
        (entry) => entry.deviceId === command.deviceId && entry.commandId === command.commandId,
      )
      if (existing) {
        if (existing.hostId === command.expectedHostId && existing.envelopeSha256 === envelopeSha256) {
          return current
        }
        throw new ControlError(
          'command.identity_conflict',
          'This device command ID is permanently reserved for a different immutable envelope.',
          { details: { deviceId: command.deviceId, commandId: command.commandId } },
        )
      }
      if (current.entries.length >= COMMAND_IDENTITY_LEDGER_LIMIT) {
        throw new ControlError(
          'command.identity_ledger_full',
          'The durable command identity ledger is full. New commands are blocked to prevent identity reuse.',
          { details: { maxEntries: COMMAND_IDENTITY_LEDGER_LIMIT } },
        )
      }
      return {
        version: 1,
        entries: [...current.entries, {
          deviceId: command.deviceId,
          commandId: command.commandId,
          hostId: command.expectedHostId,
          envelopeSha256,
          reservedAt: now(),
        }],
      }
    })
  }

  private async withCommandLifecycle<T>(
    identity: OutboxIdentity,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = commandLifecycleKey(identity)
    const previous = this.commandLifecycleTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.catch(() => undefined).then(async () => await gate)
    this.commandLifecycleTails.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.commandLifecycleTails.get(key) === tail) {
        this.commandLifecycleTails.delete(key)
        if (!this.activeCommandSubmissions.has(key)) this.completedResidentProofs.delete(key)
      }
    }
  }

  private beginCommandSubmission(identity: OutboxIdentity): void {
    const key = commandLifecycleKey(identity)
    this.activeCommandSubmissions.set(key, (this.activeCommandSubmissions.get(key) ?? 0) + 1)
  }

  private endCommandSubmission(identity: OutboxIdentity): void {
    const key = commandLifecycleKey(identity)
    const remaining = (this.activeCommandSubmissions.get(key) ?? 1) - 1
    if (remaining > 0) this.activeCommandSubmissions.set(key, remaining)
    else {
      this.activeCommandSubmissions.delete(key)
      this.completedResidentProofs.delete(key)
    }
  }

  private rememberCompletedResidentProof(identity: OutboxIdentity, receipt: CommandReceipt): void {
    const key = commandLifecycleKey(identity)
    if (!this.completedResidentProofs.has(key) && this.completedResidentProofs.size >= COMPLETED_PROMPT_PROOF_FENCE_LIMIT) {
      const evictable = [...this.completedResidentProofs.keys()].find(
        (candidate) => !this.activeCommandSubmissions.has(candidate),
      )
      if (!evictable) {
        throw new ControlError(
          'command.proof_fence_capacity',
          'Every resident proof fence is still protecting an in-flight command continuation.',
          { retryable: true, details: { maxEntries: COMPLETED_PROMPT_PROOF_FENCE_LIMIT } },
        )
      }
      this.completedResidentProofs.delete(evictable)
    }
    this.completedResidentProofs.set(key, { ...receipt })
    while (this.completedResidentProofs.size > COMPLETED_PROMPT_PROOF_FENCE_LIMIT) {
      const evictable = [...this.completedResidentProofs.keys()].find(
        (candidate) => candidate !== key && !this.activeCommandSubmissions.has(candidate),
      )
      if (!evictable) break
      this.completedResidentProofs.delete(evictable)
    }
  }

  private async putOutbox(entry: ScopedOutboxEntry): Promise<void> {
    const identity = outboxIdentity(entry.hostId, entry.command)
    const lifecycleKey = commandLifecycleKey(identity)
    await this.outbox.update((current) => {
      const entries = Array.isArray(current) ? current : []
      // A proof may have been parsed after this write was queued but before its
      // updater ran. Never let a stale submit/reconcile continuation recreate
      // prompt ownership after that exact proof has won.
      if (this.completedResidentProofs.has(lifecycleKey)) {
        return entries.filter((candidate) => !(
          isOutboxEntry(candidate) && matchesOutboxIdentity(candidate, identity)
        ))
      }
      const sameIdentity = entries.filter((candidate) =>
        rawOutboxIdentityMatches(candidate, entry.command.deviceId, entry.command.commandId)
      )
      if (
        sameIdentity.length > 1 ||
        (sameIdentity.length === 1 && !isExactReplaceableOutboxEntry(sameIdentity[0], entry))
      ) {
        throw new ControlError(
          'command.identity_conflict',
          'This command ID is already held by another or unverifiable local command. The stored command remains quarantined.',
          {
            details: {
              hostId: entry.hostId,
              deviceId: entry.command.deviceId,
              commandId: entry.command.commandId,
            },
          },
        )
      }
      const withoutCurrent = entries.filter((candidate) =>
        !isExactReplaceableOutboxEntry(candidate, entry)
      )
      if (withoutCurrent.length >= OUTBOX_LIMIT) {
        throw new ControlError('outbox.full', 'The local command outbox is full.', {
          details: { maxEntries: OUTBOX_LIMIT }
        })
      }
      return [...withoutCurrent, entry]
    })
  }

  private async removeOutbox(identities: OutboxIdentity[]): Promise<void> {
    if (identities.length === 0) return
    await this.outbox.update((current) =>
      (Array.isArray(current) ? current : []).filter(
        (entry) => !(
          isOutboxEntry(entry) &&
          identities.some((identity) => matchesOutboxIdentity(entry, identity))
        )
      )
    )
  }

  private async holdOutboxAfterReconciliationFailure(
    entry: ScopedOutboxEntry,
    error: unknown,
  ): Promise<void> {
    const identity = outboxIdentity(entry.hostId, entry.command)
    const quarantineReason =
      isDefinitiveCommandIdentityError(error)
        ? 'command_identity_conflict' as const
        : undefined
    await this.outbox.update((current) =>
      (Array.isArray(current) ? current : []).map((candidate) =>
        isOutboxEntry(candidate) && matchesOutboxIdentity(candidate, identity)
          ? {
              ...candidate,
              state:
                candidate.state === 'awaiting_idle_proof' ||
                candidate.state === 'awaiting_abort_idle_proof' ||
                candidate.state === 'awaiting_reconciliation'
                  ? candidate.state
                  : 'uncertain' as const,
              updatedAt: now(),
              ...(quarantineReason ? { quarantineReason } : {}),
            }
          : candidate
      )
    )
    this.emit('host-event', {
      type: 'command.receipt',
      payload: {
        hostId: entry.hostId,
        deviceId: entry.command.deviceId,
        commandId: entry.command.commandId,
        threadId: entry.command.threadId,
        executionGenerationId: entry.command.expectedExecutionGenerationId,
        status: 'uncertain',
        durable: false,
        detail: quarantineReason
          ? 'This command identity conflicts with a different durable envelope and is held locally.'
          : 'The host could not prove this command receipt. It remains uncertain and was not sent.',
      } satisfies CommandReceipt,
    })
  }

  private async reconcileOutboxAfterConnect(authority: CapturedProjectionAuthority): Promise<void> {
    const { hostId, connection } = authority
    if (!this.isActiveConnection(connection, authority.target, hostId, authority.generation)) {
      throw new ControlError('connection.superseded', 'The host authority changed during command reconciliation.')
    }
    // Reconciliation carries the complete v2 envelope. A legacy v1 host may
    // implement the same method name with weaker ID-only semantics, so absence
    // of the exact v2 capability makes the entire command surface read-only.
    if (!this.authorityCapabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY)) return
    // Entries for another host—or legacy entries with no immutable authority—
    // remain quarantined locally and are never disclosed to this connection.
    const pending = (await this.readOutboxClassification(true)).actionable.filter((entry) => entry.hostId === hostId)
    if (pending.length === 0) return

    const durableEntries: ScopedOutboxEntry[] = []
    const durableReceipts: CommandReceipt[] = []
    const explicitlyUnknownWaitingEntries: ScopedOutboxEntry[] = []

    for (const entry of pending) {
      if (!this.isActiveConnection(connection, authority.target, hostId, authority.generation)) {
        throw new ControlError('connection.superseded', 'The host authority changed during command reconciliation.')
      }
      try {
        const envelope = adaptCommand(entry.command)
        await this.reserveCommandIdentity(entry.command, envelope)
        const result = await connection.request(
          'command.reconcile',
          { expectedHostId: hostId, commands: [envelope] },
          { priority: 'urgent' }
        )

        const receivedReceipts = normalizeReceipts(result)
        for (const receipt of receivedReceipts) {
          assertReceiptMatchesCommand(receipt, entry.command)
          const retainedState = commandOutboxStateAfterReceipt(entry.command, receipt.status)
          if (retainedState) {
            await this.putOutbox({ ...entry, state: retainedState, updatedAt: now() })
            durableReceipts.push({ ...receipt, hostId })
          } else if (residentCommandOperation(entry.command) && receipt.status === 'completed') {
            await this.commitCompletedResidentProof(
              entry,
              { ...receipt, hostId },
              authority,
              residentCommandOperation(entry.command)!,
            )
          } else if (shouldRemoveOutboxAfterReceipt(entry.command, { ...receipt, hostId })) {
            durableEntries.push(entry)
            durableReceipts.push({ ...receipt, hostId })
          }
        }

        // Auto-delivery is limited to commands the user explicitly chose to send
        // after reconnect, and only after this host authoritatively says it has no
        // receipt for the complete envelope. Ambiguous entries remain uncertain.
        const unknown = normalizeUnknownCommandIdentities(result)
        if (unknown.length > 1) {
          throw new ControlError(
            'protocol.command_reconciliation_identity_mismatch',
            'The host returned more unknown command identities than were requested.',
          )
        }
        for (const identity of unknown) {
          if (
            identity.deviceId !== entry.command.deviceId ||
            identity.commandId !== entry.command.commandId ||
            receivedReceipts.length > 0
          ) {
            throw new ControlError(
              'protocol.command_reconciliation_identity_mismatch',
              'The host reconciliation result did not match the exact stored command identity.',
            )
          }
          if (entry.state === 'waiting_for_connection' && isExplicitOfflineFollowUp(entry.command)) {
            explicitlyUnknownWaitingEntries.push(entry)
          }
        }
      } catch (error) {
        if (!this.isActiveConnection(connection, authority.target, hostId, authority.generation)) throw error
        await this.holdOutboxAfterReconciliationFailure(entry, error)
      }
    }

    for (const receipt of durableReceipts) {
      const entry = pending.find((candidate) =>
        candidate.command.deviceId === receipt.deviceId && candidate.command.commandId === receipt.commandId
      )
      await this.recordDurableUncertainReceipt(receipt, entry?.command)
      this.emit('host-event', { type: 'command.receipt', payload: receipt })
    }
    await this.removeOutbox(durableEntries.map((entry) => outboxIdentity(hostId, entry.command)))

    for (const entry of explicitlyUnknownWaitingEntries) {
      try {
        if (!this.isActiveConnection(connection, authority.target, hostId, authority.generation)) {
          throw new ControlError('connection.superseded', 'The host authority changed before queued delivery.')
        }
        const receipt = await this.submitCommand(entry.command)
        this.emit('host-event', { type: 'command.receipt', payload: receipt })
      } catch (error) {
        if (!this.isActiveConnection(connection, authority.target, hostId, authority.generation)) throw error
        // submitCommand has already retained or quarantined this exact envelope.
        // A per-command admission failure must not take down a verified host.
      }
    }
    this.scheduleNonterminalReconciliation()
  }

  private async recordDurableUncertainReceipt(
    receipt: CommandReceipt,
    _command?: ClientCommand,
  ): Promise<void> {
    if (!receipt.durable || receipt.status !== 'uncertain') return
    // Resident uncertainty remains a live, exact mutation barrier in the
    // outbox, but its structured host diagnostic must survive restart too.
    // History is informational only and never makes the command replayable.
    const recorded = { ...receipt, recordedAt: now() }
    await this.durableUncertainReceipts.update((current) => {
      const withoutIdentity = current.entries.filter(
        (entry) => !sameDurableReceiptIdentity(entry, receipt)
      )
      return {
        version: 1,
        entries: [...withoutIdentity, recorded].slice(-DURABLE_UNCERTAIN_RECEIPT_LIMIT),
      }
    })
  }

  private async retireDurableUncertainReceipt(receipt: CommandReceipt): Promise<void> {
    await this.durableUncertainReceipts.update((current) => {
      const entries = current.entries.filter((entry) => !sameDurableReceiptIdentity(entry, receipt))
      return entries.length === current.entries.length ? current : { version: 1, entries }
    })
  }

  private async acceptResidentPromptIdleSignal(
    signal: ReturnType<typeof ResidentPromptIdleObservedSignalSchema.parse>,
    authority: CapturedProjectionAuthority,
  ): Promise<void> {
    this.assertProjectionAuthority(authority, 'resident prompt idle signal')
    const outbox = await this.readOutboxClassification(true)
    const baseMatches = outbox.actionable.filter((entry) =>
      entry.hostId === authority.hostId &&
      entry.command.deviceId === signal.receipt.deviceId &&
      entry.command.commandId === signal.receipt.commandId
    )
    // A repeated signal after its exact entry was already consumed is harmless.
    if (baseMatches.length === 0) return
    if (baseMatches.length !== 1) {
      throw new ControlError(
        'protocol.prompt_idle_identity_ambiguous',
        'The prompt idle signal matched more than one local command identity.',
      )
    }
    const entry = baseMatches[0]!
    if (
      entry.command.threadId !== signal.receipt.threadId ||
      entry.command.expectedExecutionGenerationId !== signal.receipt.executionGenerationId
    ) {
      throw new ControlError(
        'protocol.prompt_idle_receipt_identity_mismatch',
        'The prompt idle signal changed the immutable thread or execution generation for a local command ID.',
      )
    }
    const envelope = adaptCommand(entry.command)
    if (
      envelope.command.kind !== 'prompt' ||
      signal.attemptId !== residentDispatchAttemptId(entry.command.deviceId, entry.command.commandId)
    ) {
      throw new ControlError(
        'protocol.prompt_idle_state_mismatch',
        'The prompt idle signal did not match the exact local prompt attempt.',
      )
    }
    const receipt = { ...normalizeReceipt(signal.receipt.commandId, signal.receipt), hostId: authority.hostId }
    assertReceiptMatchesCommand(receipt, entry.command)
    if (receipt.status !== 'completed') {
      throw new ControlError(
        'protocol.prompt_idle_receipt_invalid',
        'The prompt idle signal did not carry a completed prompt receipt.',
      )
    }
    await this.commitCompletedResidentProof(entry, receipt, authority, 'prompt')
  }

  private async acceptResidentAbortIdleSignal(
    signal: ReturnType<typeof ResidentAbortIdleObservedSignalSchema.parse>,
    authority: CapturedProjectionAuthority,
  ): Promise<void> {
    this.assertProjectionAuthority(authority, 'resident abort idle signal')
    const outbox = await this.readOutboxClassification(true)
    const baseMatches = outbox.actionable.filter((entry) =>
      entry.hostId === authority.hostId &&
      entry.command.deviceId === signal.receipt.deviceId &&
      entry.command.commandId === signal.receipt.commandId
    )
    if (baseMatches.length === 0) return
    if (baseMatches.length !== 1) {
      throw new ControlError(
        'protocol.abort_idle_identity_ambiguous',
        'The abort idle signal matched more than one local command identity.',
      )
    }
    const entry = baseMatches[0]!
    if (
      entry.command.threadId !== signal.receipt.threadId ||
      entry.command.expectedExecutionGenerationId !== signal.receipt.executionGenerationId
    ) {
      throw new ControlError(
        'protocol.abort_idle_receipt_identity_mismatch',
        'The abort idle signal changed the immutable thread or execution generation for a local command ID.',
      )
    }
    const envelope = adaptCommand(entry.command)
    if (
      envelope.command.kind !== 'abort' ||
      signal.attemptId !== residentDispatchAttemptId(entry.command.deviceId, entry.command.commandId)
    ) {
      throw new ControlError(
        'protocol.abort_idle_state_mismatch',
        'The abort idle signal did not match the exact local Stop attempt.',
      )
    }
    const receipt = { ...normalizeReceipt(signal.receipt.commandId, signal.receipt), hostId: authority.hostId }
    assertReceiptMatchesCommand(receipt, entry.command)
    if (receipt.status !== 'completed') {
      throw new ControlError(
        'protocol.abort_idle_receipt_invalid',
        'The abort idle signal did not carry a completed Stop receipt.',
      )
    }
    await this.commitCompletedResidentProof(entry, receipt, authority, 'abort')
  }

  private async commitCompletedResidentProof(
    expectedEntry: ScopedOutboxEntry,
    receipt: CommandReceipt,
    authority: CapturedProjectionAuthority,
    operation: 'prompt' | 'abort',
  ): Promise<void> {
    const identity = outboxIdentity(authority.hostId, expectedEntry.command)
    await this.withCommandLifecycle(identity, async () => {
      this.assertProjectionAuthority(authority, 'resident prompt completion')
      const outbox = await this.readOutboxClassification(true)
      const matches = outbox.actionable.filter((entry) => matchesOutboxIdentity(entry, identity))
      const lifecycleKey = commandLifecycleKey(identity)
      if (matches.length === 0 && this.completedResidentProofs.has(lifecycleKey)) return
      if (matches.length !== 1) {
        throw new ControlError(
          'protocol.prompt_idle_identity_ambiguous',
          'The completed prompt receipt did not match exactly one durable local command.',
        )
      }
      const entry = matches[0]!
      const envelope = adaptCommand(entry.command)
      const expectedEnvelopeKind = operation === 'prompt' ? 'prompt' : 'abort'
      const expectedProofState = operation === 'prompt' ? 'awaiting_idle_proof' : 'awaiting_abort_idle_proof'
      if (
        envelope.command.kind !== expectedEnvelopeKind ||
        (entry.state !== 'uncertain' &&
          entry.state !== 'awaiting_reconciliation' &&
          entry.state !== expectedProofState)
      ) {
        throw new ControlError(
          'protocol.prompt_idle_state_mismatch',
          'The completed resident receipt did not match its non-replayable local proof state.',
        )
      }
      assertReceiptMatchesCommand(receipt, entry.command)
      if (receipt.status !== 'completed' || receipt.hostId !== authority.hostId) {
        throw new ControlError(
          'protocol.prompt_idle_receipt_invalid',
          'The prompt completion receipt was not an exact completed host receipt.',
        )
      }
      this.assertProjectionAuthority(authority, 'resident prompt completion')
      this.rememberCompletedResidentProof(identity, receipt)
      // Emit synchronously before the durable removal. A crash or write failure
      // after this point leaves the immutable envelope to reconcile again and
      // yields only a harmless duplicate; remove-before-emit could lose the
      // one-shot ownership release forever.
      this.emit('host-event', {
        type: operation === 'prompt' ? 'resident.prompt_idle_observed' : 'resident.abort_idle_observed',
        payload: receipt,
      })
      // Keep the immutable outbox barrier until the exact structured
      // diagnostic has also been retired. A crash before outbox removal then
      // reconciles the proof again instead of leaving stale Attention forever.
      await this.retireDurableUncertainReceipt(receipt)
      await this.removeOutbox([identity])
    })
  }
}

function assertCandidateEvaluationAuthority(
  expected: CandidateEvaluationPreflightRequest,
  received: CandidateEvaluationPreflightRequest,
  operation: string,
): void {
  if (
    received.expectedHostId !== expected.expectedHostId ||
    received.threadId !== expected.threadId ||
    received.expectedExecutionGenerationId !== expected.expectedExecutionGenerationId
  ) {
    throw new ControlError(
      'protocol.candidate_evaluation_authority_mismatch',
      `The candidate evaluation ${operation} reply did not match the exact reviewed host and thread generation.`,
    )
  }
}

function sameDurableReceiptIdentity(
  left: Pick<CommandReceipt, 'hostId' | 'deviceId' | 'commandId' | 'threadId' | 'executionGenerationId'>,
  right: Pick<CommandReceipt, 'hostId' | 'deviceId' | 'commandId' | 'threadId' | 'executionGenerationId'>,
): boolean {
  return left.hostId === right.hostId &&
    left.deviceId === right.deviceId &&
    left.commandId === right.commandId &&
    left.threadId === right.threadId &&
    left.executionGenerationId === right.executionGenerationId
}

type HostCommandReceipt = Omit<CommandReceipt, 'hostId'>

function normalizeReceipt(commandId: string, value: unknown): HostCommandReceipt {
  const parsed = HostCommandReceiptSchema.safeParse(value)
  if (!parsed.success) {
    throw new ControlError(
      'protocol.command_receipt_invalid',
      'The host returned a command receipt without its complete immutable identity.',
      { details: { commandId, issues: parsed.error.issues.slice(0, 8).map((issue) => issue.path.join('.')) } },
    )
  }
  const receipt = parsed.data
  const status = receipt.status
  return {
    commandId: receipt.commandId,
    deviceId: receipt.deviceId,
    threadId: receipt.threadId,
    executionGenerationId: receipt.executionGenerationId,
    status,
    // A schema-valid receipt came from hostd's durable receipt journal. An
    // uncertain *outcome* is terminal and non-replayable; it is not an
    // uncertain receipt identity. Locally synthesized ambiguity never enters
    // this normalizer and remains `durable: false` in the outbox.
    durable: true,
    ...(receipt.message
      ? { detail: receipt.message.slice(0, 2_048) }
      : receipt.error
        ? { detail: receipt.error.message }
        : {}),
    ...(receipt.error
      ? {
          error: {
            code: receipt.error.code,
            message: receipt.error.message,
            retryable: receipt.error.retryable,
            ...(receipt.error.diagnosticId ? { diagnosticId: receipt.error.diagnosticId } : {}),
            ...(receipt.error.details ? { details: { ...receipt.error.details } } : {}),
          },
        }
      : {}),
  }
}

function normalizeReceipts(value: unknown): HostCommandReceipt[] {
  const candidates = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.receipts) ? value.receipts : []
  return candidates
    .slice(0, OUTBOX_LIMIT)
    .map((candidate) => normalizeReceipt(isRecord(candidate) && typeof candidate.commandId === 'string' ? candidate.commandId : 'unknown', candidate))
}

function normalizeReconciliation(
  value: unknown,
  requestedCommands: ClientCommand[]
): HostCommandReceipt[] {
  const receipts = normalizeReceipts(value)
  const seen = new Set(
    receipts
      .filter((receipt) => receipt.deviceId)
      .map((receipt) => commandIdentityKey(receipt.deviceId as string, receipt.commandId))
  )
  const unknown = normalizeUnknownCommandIdentities(value)
  for (const identity of unknown) {
    const key = commandIdentityKey(identity.deviceId, identity.commandId)
    if (!seen.has(key)) {
      const command = requestedCommands.find(
        (candidate) => candidate.deviceId === identity.deviceId && candidate.commandId === identity.commandId,
      )
      if (!command) {
        throw new ControlError(
          'protocol.command_reconciliation_identity_mismatch',
          'The host returned an unknown identity that was not requested.',
        )
      }
      receipts.push({
        deviceId: identity.deviceId,
        commandId: identity.commandId,
        threadId: command.threadId,
        executionGenerationId: command.expectedExecutionGenerationId,
        status: 'uncertain',
        durable: false
      })
      seen.add(key)
    }
  }
  for (const command of requestedCommands) {
    const key = commandIdentityKey(command.deviceId, command.commandId)
    if (seen.has(key)) continue
    receipts.push({
      deviceId: command.deviceId,
      commandId: command.commandId,
      threadId: command.threadId,
      executionGenerationId: command.expectedExecutionGenerationId,
      status: 'uncertain',
      durable: false,
      detail: 'The host did not confirm a receipt or exact absence for this command.',
    })
  }
  return receipts
}

function normalizeUnknownCommandIdentities(value: unknown): Array<{ deviceId: string; commandId: string }> {
  if (!isRecord(value) || !Array.isArray(value.unknown)) return []
  return value.unknown.map((identity) => {
    if (!isRecord(identity) || typeof identity.deviceId !== 'string' || typeof identity.commandId !== 'string') {
      throw new ControlError(
        'protocol.command_reconciliation_invalid',
        'The host returned a malformed unknown command identity.',
      )
    }
    return { deviceId: identity.deviceId, commandId: identity.commandId }
  })
}

function commandIdentityKey(deviceId: string, commandId: string): string {
  return `${deviceId}\u0000${commandId}`
}

function residentDispatchAttemptId(deviceId: string, commandId: string): string {
  return `resident-dispatch-${createHash('sha256')
    .update(JSON.stringify([deviceId, commandId]))
    .digest('hex')
    .slice(0, 48)}`
}

function assertReceiptMatchesCommand(
  receipt: HostCommandReceipt | CommandReceipt,
  command: ClientCommand,
): void {
  if (
    receipt.deviceId !== command.deviceId ||
    receipt.commandId !== command.commandId ||
    receipt.threadId !== command.threadId ||
    receipt.executionGenerationId !== command.expectedExecutionGenerationId
  ) {
    throw new ControlError(
      'protocol.command_receipt_identity_mismatch',
      'The host receipt does not match the exact stored command generation and identity.',
      {
        details: {
          expected: {
            deviceId: command.deviceId,
            commandId: command.commandId,
            threadId: command.threadId,
            executionGenerationId: command.expectedExecutionGenerationId,
          },
          received: {
            deviceId: receipt.deviceId,
            commandId: receipt.commandId,
            threadId: receipt.threadId,
            executionGenerationId: receipt.executionGenerationId,
          },
        },
      },
    )
  }
}

function adaptCommand(input: ClientCommand): CommandEnvelope {
  if (typeof input.threadId !== 'string' || input.threadId.length === 0) {
    throw new ControlError('command.thread_required', 'A thread ID is required for host commands.')
  }
  if (typeof input.expectedExecutionGenerationId !== 'string' || input.expectedExecutionGenerationId.length === 0) {
    throw new ControlError(
      'command.execution_generation_required',
      'Refresh this thread before sending so its exact execution generation can be verified.',
    )
  }
  if (typeof input.issuedAt !== 'string' || !Number.isFinite(Date.parse(input.issuedAt))) {
    throw new ControlError(
      'command.issued_at_required',
      'This command is missing its stable issue time and cannot be sent or replayed.',
    )
  }
  const payload = input.payload ?? {}
  const normalizedKind = input.kind.startsWith('thread.') ? input.kind.slice('thread.'.length) : input.kind
  let command: CommandEnvelope['command']
  if (normalizedKind === 'prompt' || normalizedKind === 'steer' || normalizedKind === 'follow_up') {
    if (typeof payload.text !== 'string') {
      throw new ControlError('command.text_required', 'This command requires text.')
    }
    command = { kind: normalizedKind, text: payload.text }
  } else if (normalizedKind === 'abort' || normalizedKind === 'cancel') {
    command = {
      kind: 'abort',
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {})
    }
  } else if (normalizedKind === 'approval.resolve') {
    if (typeof payload.approvalId !== 'string') {
      throw new ControlError('command.approval_required', 'An approval ID is required.')
    }
    if (payload.decision !== 'approve' && payload.decision !== 'reject') {
      throw new ControlError(
        'command.approval_decision_invalid',
        'An approval command must preserve an explicit approve or reject decision.',
      )
    }
    command = {
      kind: 'approval.resolve',
      approvalId: payload.approvalId,
      decision: payload.decision,
      ...(typeof payload.comment === 'string' ? { comment: payload.comment } : {})
    }
  } else if (normalizedKind === 'model.select') {
    if (typeof payload.providerId !== 'string' || typeof payload.modelId !== 'string') {
      throw new ControlError(
        'command.model_selection_required',
        'A provider and model are required to change this thread model.',
      )
    }
    command = {
      kind: 'model.select',
      providerId: payload.providerId,
      modelId: payload.modelId,
    }
  } else {
    throw new ControlError('command.unsupported_kind', 'This command kind is not supported by the host protocol.', {
      details: { kind: input.kind }
    })
  }

  return CommandEnvelopeSchema.parse({
    protocolVersion: HOST_PROTOCOL_VERSION,
    deviceId: input.deviceId,
    commandId: input.commandId,
    expectedHostId: input.expectedHostId,
    threadId: input.threadId,
    issuedAt: input.issuedAt,
    expectedExecutionGenerationId: input.expectedExecutionGenerationId,
    command
  })
}

function isUrgentCommand(kind: string): boolean {
  return kind === 'approval.resolve' || kind === 'thread.cancel' || kind === 'thread.abort'
}

function isDefinitiveCommandIdentityError(error: unknown): boolean {
  return error instanceof ControlError && (
    error.code === 'command.identity_conflict' ||
    error.code === 'host.command_id_reused' ||
    error.code === 'host.command_identity_unverifiable' ||
    error.code === 'host.command_identity_orphaned' ||
    error.code === 'host.command_receipt_generation_mismatch'
  )
}

function isExplicitOfflineFollowUp(command: ClientCommand): boolean {
  return (
    command.delivery === 'send_when_reconnected' &&
    (command.kind === 'thread.follow_up' || command.kind === 'follow_up')
  )
}

function commandOutboxStateAfterReceipt(
  command: ClientCommand,
  status: CommandReceipt['status'],
): 'awaiting_idle_proof' | 'awaiting_abort_idle_proof' | 'awaiting_reconciliation' | 'uncertain' | undefined {
  if (status === 'uncertain') return residentCommandOperation(command) ? 'uncertain' : undefined
  if (status === 'received' || status === 'admitted') return 'awaiting_reconciliation'
  if (status === 'running') {
    if (isPromptClientCommand(command)) return 'awaiting_idle_proof'
    if (isAbortClientCommand(command)) return 'awaiting_abort_idle_proof'
    return 'awaiting_reconciliation'
  }
  return undefined
}

function isPromptClientCommand(command: ClientCommand): boolean {
  return command.kind === 'prompt' || command.kind === 'thread.prompt'
}

function isAbortClientCommand(command: ClientCommand): boolean {
  return command.kind === 'abort' || command.kind === 'thread.abort' || command.kind === 'thread.cancel'
}

function residentCommandOperation(command: ClientCommand): 'prompt' | 'abort' | undefined {
  if (isPromptClientCommand(command)) return 'prompt'
  if (isAbortClientCommand(command)) return 'abort'
  return undefined
}

function shouldRemoveOutboxAfterReceipt(command: ClientCommand, receipt: CommandReceipt): boolean {
  return TERMINAL_COMMAND_RECEIPTS.has(receipt.status) || (
    receipt.status === 'uncertain' && receipt.durable && !residentCommandOperation(command)
  )
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (
    !isRecord(value) ||
    (value.state !== 'waiting_for_connection' &&
      value.state !== 'uncertain' &&
      value.state !== 'awaiting_reconciliation' &&
      value.state !== 'awaiting_idle_proof' &&
      value.state !== 'awaiting_abort_idle_proof')
  ) return false
  if (!isRecord(value.command)) return false
  return (
    (value.hostId === undefined || isHostId(value.hostId)) &&
    (value.command.expectedHostId === undefined || isHostId(value.command.expectedHostId)) &&
    typeof value.updatedAt === 'string' &&
    typeof value.command.deviceId === 'string' &&
    typeof value.command.commandId === 'string' &&
    typeof value.command.kind === 'string'
  )
}

function isActionableOutboxEntry(entry: OutboxEntry): entry is ScopedOutboxEntry {
  if (
    entry.quarantineReason !== undefined ||
    !entry.hostId ||
    entry.command.expectedHostId !== entry.hostId ||
    typeof entry.command.threadId !== 'string' ||
    typeof entry.command.expectedExecutionGenerationId !== 'string' ||
    typeof entry.command.issuedAt !== 'string'
  ) return false
  try {
    const envelope = adaptCommand(entry.command as ClientCommand)
    return (
      (entry.state !== 'awaiting_idle_proof' || envelope.command.kind === 'prompt') &&
      (entry.state !== 'awaiting_abort_idle_proof' || envelope.command.kind === 'abort')
    )
  } catch {
    return false
  }
}

function isActionableOutboxEntryForAuthority(
  entry: OutboxEntry,
  hostId: string,
): entry is ScopedOutboxEntry {
  return isActionableOutboxEntry(entry) && entry.hostId === hostId
}

function samePersistedCommand(left: OutboxEntry['command'], right: ClientCommand): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function rawOutboxIdentity(value: unknown): { deviceId: string; commandId: string } | undefined {
  if (!isRecord(value) || !isRecord(value.command)) return undefined
  if (typeof value.command.deviceId !== 'string' || typeof value.command.commandId !== 'string') return undefined
  return { deviceId: value.command.deviceId, commandId: value.command.commandId }
}

function rawOutboxIdentityMatches(value: unknown, deviceId: string, commandId: string): boolean {
  const identity = rawOutboxIdentity(value)
  return identity?.deviceId === deviceId && identity.commandId === commandId
}

function isExactReplaceableOutboxEntry(value: unknown, entry: ScopedOutboxEntry): value is ScopedOutboxEntry {
  return (
    isOutboxEntry(value) &&
    isActionableOutboxEntry(value) &&
    value.hostId === entry.hostId &&
    samePersistedCommand(value.command, entry.command)
  )
}

function commandEnvelopeSha256(envelope: CommandEnvelope): string {
  return createHash('sha256').update(canonicalJson(envelope), 'utf8').digest('hex')
}

function findCommandIdentity(
  ledger: CommandIdentityLedger,
  command: ClientCommand,
): CommandIdentityLedgerEntry | undefined {
  return ledger.entries.find(
    (entry) => entry.deviceId === command.deviceId && entry.commandId === command.commandId,
  )
}

function classifyRawOutbox(raw: unknown[], ledger: CommandIdentityLedger): OutboxClassification {
  if (raw.length > OUTBOX_LIMIT) return { actionable: [], quarantinedCount: raw.length }

  const identityCounts = new Map<string, number>()
  for (const candidate of raw) {
    const identity = rawOutboxIdentity(candidate)
    if (!identity) continue
    const key = commandIdentityKey(identity.deviceId, identity.commandId)
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1)
  }

  const actionable: ScopedOutboxEntry[] = []
  for (const candidate of raw) {
    if (!isOutboxEntry(candidate) || !isActionableOutboxEntry(candidate)) continue
    const key = commandIdentityKey(candidate.command.deviceId, candidate.command.commandId)
    if (identityCounts.get(key) !== 1) continue
    const existing = findCommandIdentity(ledger, candidate.command)
    if (existing) {
      const envelopeSha256 = commandEnvelopeSha256(adaptCommand(candidate.command))
      if (existing.hostId !== candidate.hostId || existing.envelopeSha256 !== envelopeSha256) continue
    } else if (ledger.entries.length >= COMMAND_IDENTITY_LEDGER_LIMIT) {
      continue
    }
    actionable.push(candidate)
  }
  return { actionable, quarantinedCount: raw.length - actionable.length }
}

function matchesOutboxIdentity(entry: OutboxEntry, identity: OutboxIdentity): boolean {
  return (
    isActionableOutboxEntry(entry) &&
    entry.hostId === identity.hostId &&
    entry.command.deviceId === identity.deviceId &&
    entry.command.commandId === identity.commandId &&
    entry.command.threadId === identity.threadId &&
    entry.command.expectedExecutionGenerationId === identity.expectedExecutionGenerationId &&
    canonicalJson(entry.command) === identity.commandFingerprint
  )
}

function outboxIdentity(hostId: string, command: ClientCommand): OutboxIdentity {
  return {
    hostId,
    deviceId: command.deviceId,
    commandId: command.commandId,
    threadId: command.threadId,
    expectedExecutionGenerationId: command.expectedExecutionGenerationId,
    commandFingerprint: canonicalJson(command),
  }
}

function commandLifecycleKey(identity: OutboxIdentity): string {
  return canonicalJson(identity)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value))
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalJsonValue(value[key])]),
  )
}

function isCommandIdentityLedger(value: unknown): value is CommandIdentityLedger {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return false
  if (value.entries.length > COMMAND_IDENTITY_LEDGER_LIMIT) return false
  const identities = new Set<string>()
  for (const candidate of value.entries) {
    if (
      !isRecord(candidate) ||
      typeof candidate.deviceId !== 'string' ||
      typeof candidate.commandId !== 'string' ||
      !isHostId(candidate.hostId) ||
      typeof candidate.envelopeSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(candidate.envelopeSha256) ||
      typeof candidate.reservedAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.reservedAt))
    ) return false
    const key = commandIdentityKey(candidate.deviceId, candidate.commandId)
    if (identities.has(key)) return false
    identities.add(key)
  }
  return true
}

function isDurableUncertainReceiptHistory(value: unknown): value is DurableUncertainReceiptHistory {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return false
  if (value.entries.length > DURABLE_UNCERTAIN_RECEIPT_LIMIT) return false
  const identities = new Set<string>()
  for (const candidate of value.entries) {
    if (
      !isRecord(candidate) ||
      !isHostId(candidate.hostId) ||
      typeof candidate.deviceId !== 'string' || candidate.deviceId.length < 1 || candidate.deviceId.length > 128 ||
      typeof candidate.commandId !== 'string' || candidate.commandId.length < 1 || candidate.commandId.length > 128 ||
      typeof candidate.threadId !== 'string' || candidate.threadId.length < 1 || candidate.threadId.length > 128 ||
      typeof candidate.executionGenerationId !== 'string' || candidate.executionGenerationId.length < 1 || candidate.executionGenerationId.length > 128 ||
      candidate.status !== 'uncertain' ||
      candidate.durable !== true ||
      (candidate.detail !== undefined && (typeof candidate.detail !== 'string' || candidate.detail.length > 2_048)) ||
      (candidate.error !== undefined && (
        !isRecord(candidate.error) ||
        typeof candidate.error.retryable !== 'boolean' ||
        !StructuredErrorSchema.safeParse(candidate.error).success
      )) ||
      typeof candidate.recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.recordedAt))
    ) return false
    const key = commandIdentityKey(candidate.deviceId, candidate.commandId)
    if (identities.has(key)) return false
    identities.add(key)
  }
  return true
}

function observationFromHealth(value: unknown): HealthObservation {
  const health = isRecord(value) ? value : undefined
  const hostId = health ? asHostId(isRecord(health.host) ? health.host.hostId : undefined) : undefined
  if (!hostId) {
    throw new ControlError('protocol.host_identity_missing', 'The host health response did not include an immutable host identity.')
  }
  const hostdVersion = boundedHealthString(health?.hostdVersion, 64)
  const startedAt = healthTimestamp(health?.startedAt)
  const observedAt = healthTimestamp(health?.checkedAt)
  if (!hostdVersion || !startedAt || !observedAt) {
    throw new ControlError('protocol.health_lineage_missing', 'The host health response did not include a stable service lineage.')
  }
  const capabilities = capabilitiesFromHealth(health)
  const rawRuntimeIntegrity = health?.runtimeIntegrity
  const reportsRuntimeIntegrity = rawRuntimeIntegrity !== undefined
  if (reportsRuntimeIntegrity !== capabilities.includes(RUNTIME_INTEGRITY_CAPABILITY)) {
    throw new ControlError(
      'protocol.runtime_integrity_contract_mismatch',
      'The host runtime-integrity report did not match its advertised capabilities.',
    )
  }
  const parsedRuntimeIntegrity = reportsRuntimeIntegrity
    ? RuntimeIntegritySnapshotSchema.safeParse(rawRuntimeIntegrity)
    : undefined
  if (parsedRuntimeIntegrity && !parsedRuntimeIntegrity.success) {
    throw new ControlError('protocol.runtime_integrity_invalid', 'The host runtime-integrity report was invalid.')
  }
  const runtimeIntegrity: RuntimeIntegritySnapshot | undefined = parsedRuntimeIntegrity?.success
    ? parsedRuntimeIntegrity.data
    : undefined
  const advertisesRuntimeIntegrityRetry = capabilities.includes(RUNTIME_INTEGRITY_RETRY_CAPABILITY)
  if (
    advertisesRuntimeIntegrityRetry &&
    (runtimeIntegrity?.status !== 'failed' || !runtimeIntegrity.retryable)
  ) {
    throw new ControlError(
      'protocol.runtime_integrity_retry_contract_mismatch',
      'The host runtime retry capability did not match its failed integrity state.',
    )
  }
  const advertisesRuntimeIntegrityRepair = capabilities.includes(RUNTIME_INTEGRITY_REPAIR_CAPABILITY)
  if (
    advertisesRuntimeIntegrityRepair &&
    (
      runtimeIntegrity?.status !== 'failed' ||
      runtimeIntegrity.retryable ||
      runtimeIntegrity.recoveryAction !== 'repair_application' ||
      (runtimeIntegrity.code !== 'RUNTIME_REPAIR_REQUIRED' &&
        runtimeIntegrity.code !== 'RUNTIME_INSTALLED_CORRUPTION')
    )
  ) {
    throw new ControlError(
      'protocol.runtime_integrity_repair_contract_mismatch',
      'The host runtime repair capability did not match an eligible installed-runtime failure.',
    )
  }
  if (advertisesRuntimeIntegrityRetry && advertisesRuntimeIntegrityRepair) {
    throw new ControlError(
      'protocol.runtime_integrity_recovery_contract_mismatch',
      'The host advertised conflicting runtime recovery capabilities.',
    )
  }
  if (
    runtimeIntegrity &&
    runtimeIntegrity.status !== 'ready' &&
    capabilities.includes(PRIME_AGENT_COMMAND_CAPABILITY)
  ) {
    throw new ControlError(
      'protocol.runtime_command_capability_mismatch',
      'The host advertised command execution before its reported runtime was ready.',
    )
  }
  const runtimeReadiness: HostRuntimeReadiness = runtimeIntegrity
    ? { kind: 'reported', hostId, hostdVersion, startedAt, observedAt, snapshot: runtimeIntegrity }
    : { kind: 'not_reported', hostId, hostdVersion, startedAt, observedAt }
  return {
    hostId,
    capabilities,
    runtimeReadiness,
    lineage: {
      hostId,
      hostdVersion,
      startedAt,
      reportsRuntimeIntegrity,
      ...(runtimeIntegrity
        ? {
            runtimeContractVersion: runtimeIntegrity.contractVersion,
            runtimeTrustAnchorId: runtimeIntegrity.trustAnchorId,
            runtimeTargetKey: JSON.stringify(runtimeIntegrity.target),
          }
        : {}),
    },
  }
}

function capabilitiesFromHealth(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.capabilities)) return []
  const capabilities = value.capabilities.flatMap((candidate) => {
    const parsed = CapabilitySchema.safeParse(candidate)
    return parsed.success ? [parsed.data] : []
  })
  return [...new Set(capabilities)].sort()
}

function assertSameHealthLineage(expected: HealthLineage, received: HealthLineage): void {
  const changedField = (
    [
      'hostId',
      'hostdVersion',
      'startedAt',
      'reportsRuntimeIntegrity',
      'runtimeContractVersion',
      'runtimeTrustAnchorId',
      'runtimeTargetKey',
    ] as const
  ).find((field) => expected[field] !== received[field])
  if (!changedField) return
  throw new ControlError(
    'protocol.health_lineage_changed',
    'The host health lineage changed on an established connection.',
    { retryable: true, details: { field: changedField } },
  )
}

function runtimeReadinessSemanticKey(readiness: HostRuntimeReadiness | undefined): string {
  if (!readiness) return ''
  const { observedAt: _observedAt, ...semantic } = readiness
  if (semantic.kind === 'reported') {
    const { changedAt: _changedAt, ...snapshot } = semantic.snapshot
    return JSON.stringify({ ...semantic, snapshot })
  }
  return JSON.stringify(semantic)
}

function sameRuntimeIntegrityLineage(
  current: RuntimeIntegritySnapshot,
  next: RuntimeIntegritySnapshot,
): boolean {
  return (
    current.contractVersion === next.contractVersion &&
    current.trustAnchorId === next.trustAnchorId &&
    isDeepStrictEqual(current.target, next.target)
  )
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function boundedHealthString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined
}

function healthTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) return undefined
  return value
}

function snapshotEventForAuthority(value: unknown, hostId: string): unknown {
  const catalog = CatalogProjectionSnapshotSchema.safeParse(value)
  if (catalog.success) {
    if (catalog.data.host.hostId !== hostId) {
      throw new ControlError('protocol.authority_mismatch', 'A catalog event belongs to a different host authority.', {
        details: { expectedHostId: hostId, receivedHostId: catalog.data.host.hostId }
      })
    }
    return catalog.data
  }

  const snapshot = ThreadProjectionSnapshotSchema.safeParse(value)
  if (snapshot.success) {
    const receivedHostId = snapshot.data.thread.currentLocation.hostId
    if (receivedHostId !== hostId) {
      throw new ControlError('protocol.authority_mismatch', 'A thread event belongs to a different host authority.', {
        details: { expectedHostId: hostId, receivedHostId }
      })
    }
    return snapshot.data
  }

  throw new ControlError('protocol.invalid_snapshot_event', 'The host sent an invalid snapshot event.')
}

function normalizeCache(value: unknown): CacheEnvelope {
  const raw = isRecord(value) ? value : {}
  const lastTarget = isConnectionTarget(raw.lastTarget) ? raw.lastTarget : undefined
  const lastAttemptedTarget = isConnectionTarget(raw.lastAttemptedTarget) ? raw.lastAttemptedTarget : undefined
  const entries: Record<string, CachedHostProjection> = {}
  if (raw.version === 3 && isRecord(raw.entries)) {
    for (const hostId of Object.keys(raw.entries).sort().slice(0, 128)) {
      if (!isHostId(hostId)) continue
      const candidate = asCachedHostProjection(raw.entries[hostId], hostId)
      if (candidate) entries[hostId] = candidate
    }
  }

  // v1/v2 stored the active projection inline. Validate both payloads against
  // one immutable host before exposing them as a v3 entry.
  const legacyCatalog = CatalogProjectionSnapshotSchema.safeParse(raw.catalog)
  const legacySnapshot = ThreadProjectionSnapshotSchema.safeParse(raw.lastSnapshot)
  const declaredLegacyHostId = asHostId(raw.projectionHostId)
  const legacyCatalogHostId = legacyCatalog.success ? legacyCatalog.data.host.hostId : undefined
  const legacySnapshotHostId = legacySnapshot.success
    ? legacySnapshot.data.thread.currentLocation.hostId
    : undefined
  const legacyHostId = declaredLegacyHostId ?? legacyCatalogHostId ?? legacySnapshotHostId
  if (legacyHostId && !entries[legacyHostId]) {
    const catalogMatches = legacyCatalog.success && legacyCatalogHostId === legacyHostId
    const snapshotMatches = legacySnapshot.success && legacySnapshotHostId === legacyHostId
    if (catalogMatches || snapshotMatches) {
      entries[legacyHostId] = {
        hostId: legacyHostId,
        ...(catalogMatches ? { catalog: legacyCatalog.data } : {}),
        ...(snapshotMatches ? { lastSnapshot: legacySnapshot.data } : {}),
        ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
      }
    }
  }
  const activeHostId = asHostId(raw.activeHostId) ?? legacyHostId

  const targetHostBindings: TargetHostBinding[] = []
  if ((raw.version === 2 || raw.version === 3) && Array.isArray(raw.targetHostBindings)) {
    for (const candidate of raw.targetHostBindings.slice(-TARGET_BINDING_LIMIT)) {
      if (!isRecord(candidate) || !isConnectionTarget(candidate.target)) continue
      const target = candidate.target
      const hostId = asHostId(candidate.hostId)
      if (!hostId || typeof candidate.verifiedAt !== 'string') continue
      const duplicate = targetHostBindings.findIndex((binding) => sameTarget(binding.target, target))
      if (duplicate >= 0) targetHostBindings.splice(duplicate, 1)
      targetHostBindings.push({ target, hostId, verifiedAt: candidate.verifiedAt })
    }
  }

  return {
    version: 3,
    entries,
    targetHostBindings,
    ...(lastTarget ? { lastTarget } : {}),
    ...(lastAttemptedTarget ? { lastAttemptedTarget } : {}),
    ...(typeof raw.lastAttemptedAt === 'string' ? { lastAttemptedAt: raw.lastAttemptedAt } : {}),
    ...(typeof raw.lastTargetUpdatedAt === 'string' ? { lastTargetUpdatedAt: raw.lastTargetUpdatedAt } : {}),
    ...(activeHostId ? { activeHostId } : {})
  }
}

function visibleCacheForAuthority(cache: CacheEnvelope, hostId: string | undefined): CacheEnvelope {
  const activeEntry = hostId ? cache.entries[hostId] : undefined
  return {
    version: 3,
    entries: cache.entries,
    targetHostBindings: cache.targetHostBindings,
    ...(cache.lastTarget ? { lastTarget: cache.lastTarget } : {}),
    ...(cache.lastAttemptedTarget ? { lastAttemptedTarget: cache.lastAttemptedTarget } : {}),
    ...(cache.lastAttemptedAt ? { lastAttemptedAt: cache.lastAttemptedAt } : {}),
    ...(cache.lastTargetUpdatedAt ? { lastTargetUpdatedAt: cache.lastTargetUpdatedAt } : {}),
    ...(hostId ? { activeHostId: hostId, projectionHostId: hostId } : {}),
    ...(activeEntry?.catalog ? { catalog: activeEntry.catalog } : {}),
    ...(activeEntry?.lastSnapshot ? { lastSnapshot: activeEntry.lastSnapshot } : {}),
    ...(activeEntry?.updatedAt ? { updatedAt: activeEntry.updatedAt } : {})
  }
}

interface ProjectionWriteDecision {
  accept: boolean
  retiredExecutionGenerations: Record<string, string[]>
  retiredCursorGenerations?: Record<string, string[]>
}

function catalogProjectionDecision(
  previous: CachedHostProjection | undefined,
  incoming: CatalogProjectionSnapshot,
): ProjectionWriteDecision {
  const retired = cloneRetiredExecutionGenerations(previous?.retiredExecutionGenerations)
  for (const thread of incoming.threads) {
    if (retired[thread.threadId]?.includes(thread.currentLocation.executionGenerationId)) {
      return { accept: false, retiredExecutionGenerations: retired }
    }
  }
  const parsedPrevious = CatalogProjectionSnapshotSchema.safeParse(previous?.catalog)
  if (!parsedPrevious.success) return { accept: true, retiredExecutionGenerations: retired }
  const current = parsedPrevious.data
  if (Date.parse(incoming.generatedAt) < Date.parse(current.generatedAt)) {
    return { accept: false, retiredExecutionGenerations: retired }
  }

  const currentThreads = new Map(current.threads.map((thread) => [thread.threadId, thread]))
  const incomingThreadIds = new Set(incoming.threads.map((thread) => thread.threadId))
  for (const currentThread of current.threads) {
    if (!incomingThreadIds.has(currentThread.threadId)) {
      if (!retireExecutionGeneration(
        retired,
        currentThread.threadId,
        currentThread.currentLocation.executionGenerationId,
      )) return { accept: false, retiredExecutionGenerations: retired }
    }
  }
  for (const thread of incoming.threads) {
    const incomingGeneration = thread.currentLocation.executionGenerationId
    const currentThread = currentThreads.get(thread.threadId)
    if (!currentThread) continue
    const currentUpdatedAt = Date.parse(currentThread.updatedAt)
    const incomingUpdatedAt = Date.parse(thread.updatedAt)
    if (incomingUpdatedAt < currentUpdatedAt) {
      return { accept: false, retiredExecutionGenerations: retired }
    }
    const currentGeneration = currentThread.currentLocation.executionGenerationId
    if (incomingGeneration !== currentGeneration) {
      if (incomingUpdatedAt <= currentUpdatedAt) {
        return { accept: false, retiredExecutionGenerations: retired }
      }
      if (!retireExecutionGeneration(retired, thread.threadId, currentGeneration)) {
        return { accept: false, retiredExecutionGenerations: retired }
      }
    }
  }
  return { accept: true, retiredExecutionGenerations: retired }
}

function threadSnapshotProjectionDecision(
  previous: CachedHostProjection | undefined,
  incoming: ThreadProjectionSnapshot,
): ProjectionWriteDecision {
  const retired = cloneRetiredExecutionGenerations(previous?.retiredExecutionGenerations)
  const retiredCursors = cloneRetiredCursorGenerations(previous?.retiredCursorGenerations)
  const threadId = incoming.thread.threadId
  const incomingGeneration = incoming.thread.currentLocation.executionGenerationId
  const cursorRetirementKey = cursorLineageRetirementKey(threadId, incomingGeneration)
  if (retiredCursors[cursorRetirementKey]?.includes(incoming.latestCursor.generation)) {
    return {
      accept: false,
      retiredExecutionGenerations: retired,
      retiredCursorGenerations: retiredCursors,
    }
  }
  if (retired[threadId]?.includes(incomingGeneration)) {
    return { accept: false, retiredExecutionGenerations: retired, retiredCursorGenerations: retiredCursors }
  }

  const parsedCatalog = CatalogProjectionSnapshotSchema.safeParse(previous?.catalog)
  if (parsedCatalog.success) {
    const catalogThread = parsedCatalog.data.threads.find((thread) => thread.threadId === threadId)
    if (
      catalogThread &&
      catalogThread.currentLocation.executionGenerationId !== incomingGeneration
    ) {
      return { accept: false, retiredExecutionGenerations: retired, retiredCursorGenerations: retiredCursors }
    }
  }

  const parsedPrevious = ThreadProjectionSnapshotSchema.safeParse(previous?.lastSnapshot)
  if (!parsedPrevious.success || parsedPrevious.data.thread.threadId !== threadId) {
    return { accept: true, retiredExecutionGenerations: retired, retiredCursorGenerations: retiredCursors }
  }
  const current = parsedPrevious.data
  const currentGeneration = current.thread.currentLocation.executionGenerationId
  if (incomingGeneration === currentGeneration) {
    const currentCursorGeneration = current.latestCursor.generation
    if (incoming.latestCursor.generation !== currentCursorGeneration) {
      if (Date.parse(incoming.thread.updatedAt) <= Date.parse(current.thread.updatedAt)) {
        return { accept: false, retiredExecutionGenerations: retired, retiredCursorGenerations: retiredCursors }
      }
      if (!retireCursorGeneration(retiredCursors, cursorRetirementKey, currentCursorGeneration)) {
        return { accept: false, retiredExecutionGenerations: retired, retiredCursorGenerations: retiredCursors }
      }
      return { accept: true, retiredExecutionGenerations: retired, retiredCursorGenerations: retiredCursors }
    }
    const regresses =
      incoming.latestCursor.sequence < current.latestCursor.sequence ||
      Date.parse(incoming.thread.updatedAt) < Date.parse(current.thread.updatedAt)
    return { accept: !regresses, retiredExecutionGenerations: retired, retiredCursorGenerations: retiredCursors }
  }
  if (Date.parse(incoming.thread.updatedAt) <= Date.parse(current.thread.updatedAt)) {
    return { accept: false, retiredExecutionGenerations: retired, retiredCursorGenerations: retiredCursors }
  }
  if (!retireExecutionGeneration(retired, threadId, currentGeneration)) {
    return { accept: false, retiredExecutionGenerations: retired, retiredCursorGenerations: retiredCursors }
  }
  return { accept: true, retiredExecutionGenerations: retired, retiredCursorGenerations: retiredCursors }
}

function cloneRetiredCursorGenerations(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {}
  const result: Record<string, string[]> = {}
  for (const [lineageKey, generations] of Object.entries(value).slice(0, 10_000)) {
    if (!/^[a-f0-9]{64}$/.test(lineageKey) || !Array.isArray(generations)) continue
    const normalized = [...new Set(generations.filter(isBoundedProjectionId))]
      .slice(-RETIRED_CURSOR_GENERATIONS_PER_LINEAGE_LIMIT)
    if (normalized.length > 0) result[lineageKey] = normalized
  }
  return result
}

function cursorLineageRetirementKey(threadId: string, executionGenerationId: string): string {
  return createHash('sha256').update(JSON.stringify([threadId, executionGenerationId])).digest('hex')
}

function retireCursorGeneration(
  retired: Record<string, string[]>,
  lineageKey: string,
  cursorGeneration: string,
): boolean {
  const generations = retired[lineageKey] ?? []
  if (generations.includes(cursorGeneration)) return true
  if (generations.length >= RETIRED_CURSOR_GENERATIONS_PER_LINEAGE_LIMIT) return false
  generations.push(cursorGeneration)
  retired[lineageKey] = generations
  return true
}

function cloneRetiredExecutionGenerations(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {}
  const result: Record<string, string[]> = {}
  for (const [threadId, generations] of Object.entries(value).slice(0, 10_000)) {
    if (!isBoundedProjectionId(threadId) || !Array.isArray(generations)) continue
    const normalized = [...new Set(generations.filter(isBoundedProjectionId))]
      .slice(-RETIRED_GENERATIONS_PER_THREAD_LIMIT)
    if (normalized.length > 0) result[threadId] = normalized
  }
  return result
}

function retireExecutionGeneration(
  retired: Record<string, string[]>,
  threadId: string,
  executionGenerationId: string,
): boolean {
  const generations = retired[threadId] ?? []
  if (generations.includes(executionGenerationId)) return true
  if (generations.length >= RETIRED_GENERATIONS_PER_THREAD_LIMIT) return false
  generations.push(executionGenerationId)
  retired[threadId] = generations
  return true
}

function isBoundedProjectionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function replaceProjectionEntry(
  cache: CacheEnvelope,
  hostId: string,
  entry: CachedHostProjection,
): CacheEnvelope {
  return {
    ...cache,
    version: 3,
    activeHostId: hostId,
    entries: { ...cache.entries, [hostId]: entry },
  }
}

function asCachedHostProjection(value: unknown, hostId: string): CachedHostProjection | undefined {
  if (!isRecord(value) || value.hostId !== hostId) return undefined
  const catalog = CatalogProjectionSnapshotSchema.safeParse(value.catalog)
  const snapshot = ThreadProjectionSnapshotSchema.safeParse(value.lastSnapshot)
  const catalogMatches = catalog.success && catalog.data.host.hostId === hostId
  const snapshotMatches = snapshot.success && snapshot.data.thread.currentLocation.hostId === hostId
  if (!catalogMatches && !snapshotMatches) return undefined
  return {
    hostId,
    ...(catalogMatches ? { catalog: catalog.data } : {}),
    ...(snapshotMatches ? { lastSnapshot: snapshot.data } : {}),
    ...(
      isRecord(value.retiredExecutionGenerations)
        ? { retiredExecutionGenerations: cloneRetiredExecutionGenerations(value.retiredExecutionGenerations) }
        : {}
    ),
    ...(
      isRecord(value.retiredCursorGenerations)
        ? { retiredCursorGenerations: cloneRetiredCursorGenerations(value.retiredCursorGenerations) }
        : {}
    ),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  }
}

function findBoundHostId(cache: CacheEnvelope, target: ConnectionTarget): string | undefined {
  return [...cache.targetHostBindings].reverse().find((binding) => sameTarget(binding.target, target))?.hostId
}

function findBoundSshTarget(
  cache: CacheEnvelope,
  hostId: string,
): Extract<ConnectionTarget, { kind: 'ssh' }> | undefined {
  const binding = [...cache.targetHostBindings]
    .reverse()
    .find((candidate) => candidate.hostId === hostId && candidate.target.kind === 'ssh')
  return binding?.target.kind === 'ssh' ? { kind: 'ssh', alias: binding.target.alias } : undefined
}

function sameTarget(left: ConnectionTarget, right: ConnectionTarget): boolean {
  return left.kind === right.kind && (left.kind === 'local' || (right.kind === 'ssh' && left.alias === right.alias))
}

function sameOptionalTarget(
  left: ConnectionTarget | undefined,
  right: ConnectionTarget | undefined
): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameTarget(left, right)
}

function asHostId(value: unknown): string | undefined {
  return isHostId(value) ? value : undefined
}

function isHostId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  )
}

function recoverRuntimeOAuthIdentity(
  value: unknown
): Pick<RuntimeOAuthSessionSnapshot, 'sessionId' | 'providerId'> | undefined {
  if (!isRecord(value) || !isHostId(value.sessionId) || !isHostId(value.providerId)) return undefined
  return { sessionId: value.sessionId, providerId: value.providerId }
}

function parseRuntimeOAuthSnapshot(value: unknown): RuntimeOAuthSessionSnapshot {
  const parsed = RuntimeOAuthSessionSnapshotSchema.safeParse(value)
  if (!parsed.success) {
    // Schema diagnostics can echo provider-controlled URLs or credential-like
    // values. Keep malformed host responses behind one fixed renderer-facing
    // classification and never serialize the raw payload or Zod issue text.
    throw new ControlError(
      'protocol.oauth_snapshot_invalid',
      'The host returned an invalid Prime Agent sign-in status.'
    )
  }
  return parsed.data
}

function isConnectionTarget(value: unknown): value is ConnectionTarget {
  if (!isRecord(value)) return false
  return value.kind === 'local' || (value.kind === 'ssh' && typeof value.alias === 'string' && value.alias.length > 0)
}

function normalizeResidentWorkspaceSelectionInput(
  input: ResidentWorkspaceSelectionInput,
): ResidentWorkspaceSelectionInput & { kind: 'local_path' | 'registered_workspace' } {
  if (!isRecord(input)) {
    throw new ControlError(
      'resident.workspace_selection_input_invalid',
      'The resident workspace selection did not contain one exact path-free reference.'
    )
  }
  const kind = input.kind ?? 'local_path'
  if (kind === 'local_path') {
    if (
      Object.keys(input).some((key) => !['kind', 'resumeOperationId'].includes(key)) ||
      (input.resumeOperationId !== undefined && !isHostId(input.resumeOperationId))
    ) {
      throw new ControlError(
        'resident.workspace_selection_input_invalid',
        'The local resident workspace selection is invalid.'
      )
    }
    return {
      kind: 'local_path',
      ...(input.resumeOperationId === undefined ? {} : { resumeOperationId: input.resumeOperationId }),
    }
  }
  const registered = input as Extract<ResidentWorkspaceSelectionInput, { kind: 'registered_workspace' }>
  if (
    kind !== 'registered_workspace' ||
    Object.keys(input).some((key) => ![
      'kind',
      'projectId',
      'workspaceId',
      'referenceThreadId',
      'referenceExecutionGenerationId',
      'resumeOperationId',
    ].includes(key)) ||
    !isHostId(registered.projectId) ||
    !isHostId(registered.workspaceId) ||
    !isHostId(registered.referenceThreadId) ||
    !isHostId(registered.referenceExecutionGenerationId) ||
    (registered.resumeOperationId !== undefined && !isHostId(registered.resumeOperationId))
  ) {
    throw new ControlError(
      'resident.workspace_selection_input_invalid',
      'The saved resident workspace selection is invalid.'
    )
  }
  return {
    kind: 'registered_workspace',
    projectId: registered.projectId,
    workspaceId: registered.workspaceId,
    referenceThreadId: registered.referenceThreadId,
    referenceExecutionGenerationId: registered.referenceExecutionGenerationId,
    ...(registered.resumeOperationId === undefined ? {} : { resumeOperationId: registered.resumeOperationId }),
  }
}

function normalizeSelectedWorkspaceDirectory(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 4_096 ||
    /[\0\r\n]/.test(value) ||
    !path.isAbsolute(value)
  ) {
    throw new ControlError(
      'resident.workspace_selection_invalid',
      'The native workspace picker returned an invalid folder.'
    )
  }
  const normalized = path.resolve(value)
  if (normalized.length < 1 || normalized.length > 4_096 || /[\0\r\n]/.test(normalized)) {
    throw new ControlError(
      'resident.workspace_selection_invalid',
      'The native workspace picker returned an invalid folder.'
    )
  }
  return normalized
}

function suggestedWorkspaceName(workspaceDirectory: string): string {
  const basename = path.basename(workspaceDirectory)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, 255)
  return basename.length > 0 ? basename : 'Workspace'
}

function sameResidentProvisionMetadata(
  left: ResidentProvisionMetadata,
  right: ResidentProvisionMetadata,
): boolean {
  return (
    left.projectDisplayName === right.projectDisplayName &&
    left.threadTitle === right.threadTitle &&
    left.sessionName === right.sessionName
  )
}

function normalizeResidentProvisionMetadata(input: ResidentProvisionInput): ResidentProvisionMetadata {
  const projectDisplayName = normalizeResidentLabel(input.projectDisplayName, 'project display name')
  const threadTitle = normalizeResidentLabel(input.threadTitle, 'thread title')
  const sessionName = input.sessionName === undefined
    ? undefined
    : normalizeResidentLabel(input.sessionName, 'session name')
  return Object.freeze({
    projectDisplayName,
    threadTitle,
    ...(sessionName === undefined ? {} : { sessionName }),
  })
}

function normalizeResidentLabel(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ControlError('resident.provision_label_invalid', `The ${label} is invalid.`)
  }
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 255 || /[\0\r\n]/.test(normalized)) {
    throw new ControlError('resident.provision_label_invalid', `The ${label} is invalid.`)
  }
  return normalized
}

function isRecoverableResidentWorkspaceEntry(entry: ResidentProvisionOperationView): boolean {
  if (entry.state === 'requires_reselection') return true
  const status = entry.lastStatus
  if (
    status === undefined &&
    (entry.state === 'submitted' || entry.state === 'outcome_unknown')
  ) return true
  if (
    entry.state === 'submitted' &&
    status?.kind === 'provision' &&
    (
      status.phase === 'prepared' ||
      status.phase === 'promoted_observed' ||
      status.phase === 'projection_committed'
    )
  ) return true
  return (
    entry.state === 'terminal' &&
    status?.kind === 'provision' &&
    status.phase === 'completed' &&
    (
      status.completionReason === 'owned_create_failed_before_effect' ||
      status.completionReason === 'owned_create_cleaned'
    )
  )
}

function shouldReuseResidentLifecycleOperation(entry: ResidentProvisionOperationView): boolean {
  return !(
    entry.state === 'terminal' &&
    entry.lastStatus?.kind === 'provision' &&
    entry.lastStatus.phase === 'completed'
  )
}

function canContinueRegisteredWorkspaceProvision(entry: ResidentProvisionOperationView): boolean {
  if (entry.provisionMode !== 'registered_workspace') return false
  if (
    entry.state === 'submitted' &&
    entry.lastStatus?.kind === 'provision' &&
    (
      entry.lastStatus.phase === 'prepared' ||
      entry.lastStatus.phase === 'promoted_observed' ||
      entry.lastStatus.phase === 'projection_committed'
    )
  ) return true
  return entry.state === 'terminal' &&
    entry.lastStatus?.kind === 'provision' &&
    entry.lastStatus.phase === 'completed' &&
    (
      entry.lastStatus.completionReason === 'owned_create_failed_before_effect' ||
      entry.lastStatus.completionReason === 'owned_create_cleaned'
    )
}

function sameResidentWorkspaceRecoverySource(
  left: ResidentProvisionOperationView,
  right: ResidentProvisionOperationView,
): boolean {
  return (
    sameResidentLifecycleIdentity(left, right) &&
    left.state === right.state &&
    left.lastStatus?.phase === right.lastStatus?.phase &&
    left.lastStatus?.completionReason === right.lastStatus?.completionReason
  )
}

function sameResidentLifecycleIdentity(
  left: ResidentLifecycleOperationView,
  right: ResidentLifecycleOperationView,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.expectedHostId === right.expectedHostId &&
    left.projectId === right.projectId &&
    left.workspaceId === right.workspaceId &&
    left.threadId === right.threadId &&
    left.executionGenerationId === right.executionGenerationId &&
    left.kind === right.kind &&
    left.createdAt === right.createdAt &&
    (left.kind === 'provision'
      ? right.kind === 'provision' &&
        left.provisionMode === right.provisionMode &&
        (left.provisionMode === 'local_path'
          ? right.provisionMode === 'local_path'
          : right.provisionMode === 'registered_workspace' &&
            left.referenceThreadId === right.referenceThreadId &&
            left.referenceExecutionGenerationId === right.referenceExecutionGenerationId) &&
        left.projectDisplayName === right.projectDisplayName &&
        left.threadTitle === right.threadTitle &&
        left.sessionName === right.sessionName
      : right.kind === 'end' && sameSessionCursor(left.sourceCursor, right.sourceCursor))
  )
}

function residentEndIdentityMatches(
  entry: ResidentEndOperationView,
  input: Omit<ResidentEndPreparationInput, 'resumeOperationId'>,
): boolean {
  return (
    entry.expectedHostId === input.expectedHostId &&
    entry.projectId === input.projectId &&
    entry.workspaceId === input.workspaceId &&
    entry.threadId === input.threadId &&
    entry.executionGenerationId === input.executionGenerationId
  )
}

function residentStatusMatchesSelection(
  status: ResidentLifecycleStatus,
  record: ResidentWorkspaceSelectionRecord,
): boolean {
  return (
    status.kind === 'provision' &&
    status.operationId === record.selection.operationId &&
    status.expectedHostId === record.selection.expectedHostId &&
    status.projectId === record.projectId &&
    status.workspaceId === record.workspaceId &&
    status.threadId === record.threadId &&
    status.executionGenerationId === record.executionGenerationId
  )
}

function residentStatusMatchesLedger(
  status: ResidentLifecycleStatus,
  entry: ResidentLifecycleOperationView,
): boolean {
  return (
    status.kind === entry.kind &&
    status.operationId === entry.operationId &&
    status.expectedHostId === entry.expectedHostId &&
    status.projectId === entry.projectId &&
    status.workspaceId === entry.workspaceId &&
    status.threadId === entry.threadId &&
    status.executionGenerationId === entry.executionGenerationId
  )
}

function sameResidentLifecycleStatusIdentity(
  left: ResidentLifecycleStatus,
  right: ResidentLifecycleStatus,
): boolean {
  return (
    left.version === right.version &&
    left.kind === right.kind &&
    left.operationId === right.operationId &&
    left.expectedHostId === right.expectedHostId &&
    left.projectId === right.projectId &&
    left.workspaceId === right.workspaceId &&
    left.threadId === right.threadId &&
    left.executionGenerationId === right.executionGenerationId &&
    left.preparedAt === right.preparedAt
  )
}

function residentLifecycleStateForStatus(
  status: ResidentLifecycleStatus,
): ResidentLifecycleOperationView['state'] {
  if (residentLifecycleStatusNeedsProjectionRefresh(status)) return 'terminal_refresh_pending'
  return isTerminalResidentLifecycleStatus(status) ? 'terminal' : 'submitted'
}

function convergedResidentLifecycleState(
  existingState: ResidentLifecycleOperationView['state'],
  status: ResidentLifecycleStatus,
): ResidentLifecycleOperationView['state'] {
  const statusState = residentLifecycleStateForStatus(status)
  if (existingState === 'terminal' && isTerminalResidentLifecycleStatus(status)) return 'terminal'
  if (existingState === 'terminal_refresh_pending' && residentLifecycleStatusNeedsProjectionRefresh(status)) {
    return 'terminal_refresh_pending'
  }
  return statusState
}

function residentProjectionIdentityKey(status: ResidentLifecycleStatus): string {
  return createHash('sha256')
    .update(JSON.stringify([
      status.expectedHostId,
      status.kind,
      ...(status.kind === 'end' ? [status.operationId] : []),
      status.projectId,
      status.workspaceId,
      status.threadId,
      status.executionGenerationId,
    ]))
    .digest('hex')
}

function residentLifecycleStatusNeedsProjectionRefresh(status: ResidentLifecycleStatus): boolean {
  return (
    (status.kind === 'provision' && status.phase === 'committed') ||
    (status.kind === 'end' && status.phase === 'completed')
  )
}

function isTerminalResidentLifecycleStatus(status: ResidentLifecycleStatus): boolean {
  return (
    status.phase === 'committed' ||
    status.phase === 'completed' ||
    status.phase === 'detached' ||
    status.phase === 'quarantined'
  )
}

const RESIDENT_LEDGER_ENTRY_KEYS = new Set([
  'kind',
  'provisionMode',
  'operationId',
  'expectedHostId',
  'projectId',
  'workspaceId',
  'threadId',
  'executionGenerationId',
  'projectDisplayName',
  'threadTitle',
  'sessionName',
  'referenceThreadId',
  'referenceExecutionGenerationId',
  'sourceCursor',
  'createdAt',
  'updatedAt',
  'state',
  'lastStatus',
])

function isPersistedResidentLifecycleLedger(value: unknown): value is PersistedResidentLifecycleLedger {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return false
  if (Object.keys(value).some((key) => key !== 'version' && key !== 'entries')) return false
  if (value.entries.length > RESIDENT_LIFECYCLE_LEDGER_LIMIT) return false
  return value.entries.every(isPersistedResidentLifecycleLedgerEntry)
}

function isPersistedResidentLifecycleLedgerEntry(
  value: unknown,
): value is ResidentLifecycleOperationView | LegacyResidentProvisionOperationView {
  if (!isRecord(value) || Object.keys(value).some((key) => !RESIDENT_LEDGER_ENTRY_KEYS.has(key))) return false
  if (value.kind === undefined && value.provisionMode !== undefined) return false
  const kind = value.kind === undefined ? 'provision' : value.kind
  const provisionMode = kind === 'provision'
    ? value.provisionMode ?? 'local_path'
    : undefined
  if (
    (kind !== 'provision' && kind !== 'end') ||
    !isHostId(value.operationId) ||
    !isHostId(value.expectedHostId) ||
    !isHostId(value.projectId) ||
    !isHostId(value.workspaceId) ||
    !isHostId(value.threadId) ||
    !isHostId(value.executionGenerationId) ||
    !isBoundedIsoDate(value.createdAt) ||
    !isBoundedIsoDate(value.updatedAt) ||
    ![
      'submitted',
      'outcome_unknown',
      'requires_reselection',
      'terminal_refresh_pending',
      'terminal',
    ].includes(String(value.state))
  ) return false

  if (
    kind === 'provision'
      ? (
          (provisionMode !== 'local_path' && provisionMode !== 'registered_workspace') ||
          !isBoundedResidentLabel(value.projectDisplayName) ||
          !isBoundedResidentLabel(value.threadTitle) ||
          (value.sessionName !== undefined && !isBoundedResidentLabel(value.sessionName)) ||
          value.sourceCursor !== undefined ||
          (provisionMode === 'local_path'
            ? value.referenceThreadId !== undefined || value.referenceExecutionGenerationId !== undefined
            : !isHostId(value.referenceThreadId) || !isHostId(value.referenceExecutionGenerationId))
        )
      : (
          value.provisionMode !== undefined ||
          value.projectDisplayName !== undefined ||
          value.threadTitle !== undefined ||
          value.sessionName !== undefined ||
          value.referenceThreadId !== undefined ||
          value.referenceExecutionGenerationId !== undefined ||
          !isResidentEndSourceCursor(value.sourceCursor, value.threadId, value.executionGenerationId)
        )
  ) return false

  const parsedStatus = value.lastStatus === undefined
    ? undefined
    : ResidentLifecycleStatusSchema.safeParse(value.lastStatus)
  if (parsedStatus && !parsedStatus.success) return false
  const status = parsedStatus?.success ? parsedStatus.data : undefined
  const entry = (
    kind === 'provision'
      ? { ...value, kind: 'provision', provisionMode }
      : value
  ) as unknown as ResidentLifecycleOperationView
  if (status && !residentStatusMatchesLedger(status, entry)) return false
  if (value.state === 'terminal' && !(status && isTerminalResidentLifecycleStatus(status))) return false
  if (value.state === 'terminal_refresh_pending' && !(status && residentLifecycleStatusNeedsProjectionRefresh(status))) {
    return false
  }
  if (
    status &&
    isTerminalResidentLifecycleStatus(status) &&
    value.state !== 'terminal' &&
    value.state !== 'terminal_refresh_pending'
  ) return false
  if (
    value.state === 'requires_reselection' &&
    (kind !== 'provision' || provisionMode !== 'local_path' || status !== undefined)
  ) return false
  return true
}

function normalizeResidentLifecycleLedger(
  value: PersistedResidentLifecycleLedger,
): ResidentLifecycleLedger {
  return {
    version: 1,
    entries: value.entries.map((entry): ResidentLifecycleOperationView => {
      if (entry.kind === 'end') return structuredClone(entry)
      if (entry.provisionMode === 'registered_workspace') {
        return {
          ...structuredClone(entry),
          kind: 'provision',
          provisionMode: 'registered_workspace',
        }
      }
      return {
        ...structuredClone(entry),
        kind: 'provision',
        provisionMode: 'local_path',
      }
    }),
  }
}

function isResidentEndSourceCursor(
  value: unknown,
  threadId: unknown,
  executionGenerationId: unknown,
): value is SessionCursor {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => [
      'threadId',
      'executionGenerationId',
      'generation',
      'sequence',
    ].includes(key)) &&
    value.threadId === threadId &&
    value.executionGenerationId === executionGenerationId &&
    isHostId(value.generation) &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0
  )
}

function normalizeResidentEndPreparationInput(
  input: ResidentEndPreparationInput,
): ResidentEndPreparationInput {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => ![
      'expectedHostId',
      'projectId',
      'workspaceId',
      'threadId',
      'executionGenerationId',
      'resumeOperationId',
    ].includes(key)) ||
    !isHostId(input.expectedHostId) ||
    !isHostId(input.projectId) ||
    !isHostId(input.workspaceId) ||
    !isHostId(input.threadId) ||
    !isHostId(input.executionGenerationId) ||
    (input.resumeOperationId !== undefined && !isHostId(input.resumeOperationId))
  ) {
    throw new ControlError(
      'resident.end_lineage_invalid',
      'The resident end review did not contain one exact path-free thread lineage.'
    )
  }
  return {
    expectedHostId: input.expectedHostId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    executionGenerationId: input.executionGenerationId,
    ...(input.resumeOperationId === undefined ? {} : { resumeOperationId: input.resumeOperationId }),
  }
}

function residentEndMutationKey(input: {
  expectedHostId: string
  threadId: string
  executionGenerationId: string
}): string {
  return createHash('sha256')
    .update(JSON.stringify([
      input.expectedHostId,
      input.threadId,
      input.executionGenerationId,
    ]))
    .digest('hex')
}

function sameSessionCursor(left: SessionCursor, right: SessionCursor): boolean {
  return (
    left.threadId === right.threadId &&
    left.executionGenerationId === right.executionGenerationId &&
    left.generation === right.generation &&
    left.sequence === right.sequence
  )
}

function residentEndProjectionMatchesOperation(
  snapshot: ThreadProjectionSnapshot,
  status: ResidentLifecycleStatus,
  entry: ResidentLifecycleOperationView,
  expectedThreadStatus: TaskState,
): boolean {
  if (status.kind !== 'end' || status.phase !== 'completed' || entry.kind !== 'end') return false
  const disposition = snapshot.residentLifecycle
  return (
    isResidentEndedTaskState(snapshot.thread.status) &&
    snapshot.thread.status === expectedThreadStatus &&
    snapshot.thread.recap === RESIDENT_ENDED_RECAP &&
    sameSessionCursor(snapshot.latestCursor, entry.sourceCursor) &&
    disposition?.state === 'ended' &&
    disposition.operationId === status.operationId &&
    disposition.reason === 'user_end' &&
    sameSessionCursor(disposition.sourceCursor, entry.sourceCursor)
  )
}

function isResidentEndedTaskState(status: TaskState): status is 'idle' | 'complete' | 'failed' {
  return status === 'idle' || status === 'complete' || status === 'failed'
}

function isResidentEndSourceCursorChanged(error: unknown): error is ControlError {
  return error instanceof ControlError && error.code === HOST_RESIDENT_END_SOURCE_CURSOR_CHANGED
}

function makeRoomForResidentLifecycleEntry(entries: ResidentLifecycleOperationView[]): void {
  while (entries.length >= RESIDENT_LIFECYCLE_LEDGER_LIMIT) {
    const evictableIndex = entries.findIndex((entry) => canEvictResidentLifecycleEntry(entry, entries))
    if (evictableIndex < 0) {
      throw new ControlError(
        'resident.lifecycle_ledger_full',
        'Too many resident lifecycle operations still require reconciliation.'
      )
    }
    entries.splice(evictableIndex, 1)
  }
}

function canEvictResidentLifecycleEntry(
  entry: ResidentLifecycleOperationView,
  entries: ResidentLifecycleOperationView[],
): boolean {
  if (!entry.lastStatus || entry.lastStatus.phase === 'quarantined') return false
  if (entry.kind === 'provision') {
    if (entry.lastStatus.phase === 'completed') return entry.state === 'terminal'
    if (entry.lastStatus.phase !== 'committed') return false
    if (entry.state !== 'terminal' && entry.state !== 'terminal_refresh_pending') return false
    return entries.some((candidate) =>
      candidate.kind === 'end' &&
      (candidate.state === 'terminal' || candidate.state === 'terminal_refresh_pending') &&
      candidate.lastStatus?.kind === 'end' &&
      candidate.lastStatus.phase === 'completed' &&
      sameResidentLifecycleLineage(candidate, entry)
    )
  }
  if (entry.state !== 'terminal' || entry.lastStatus.phase !== 'completed') return false
  // Keep the release proof until its older committed provision has been
  // removed. The next bounded insertion can then evict this End record.
  return !entries.some((candidate) =>
    candidate.kind === 'provision' &&
    (candidate.state === 'terminal' || candidate.state === 'terminal_refresh_pending') &&
    candidate.lastStatus?.kind === 'provision' &&
    candidate.lastStatus.phase === 'committed' &&
    sameResidentLifecycleLineage(candidate, entry)
  )
}

function sameResidentLifecycleLineage(
  left: ResidentLifecycleOperationView,
  right: ResidentLifecycleOperationView,
): boolean {
  return left.expectedHostId === right.expectedHostId &&
    left.projectId === right.projectId &&
    left.workspaceId === right.workspaceId &&
    left.threadId === right.threadId &&
    left.executionGenerationId === right.executionGenerationId
}

function isBoundedResidentLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 255 &&
    !/[\0\r\n]/.test(value)
  )
}

function isBoundedIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 20 &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  )
}

function residentProvisionErrorWithDurability(
  error: unknown,
  durableOperationPossible: boolean,
): ControlError {
  if (error instanceof ControlError) {
    const previouslyPossible = error.details?.durableOperationPossible === true
    const { durableOperationPossible: _ignoredDurability, ...details } = error.details ?? {}
    return new ControlError(error.code, error.message, {
      retryable: error.retryable,
      details: {
        durableOperationPossible: durableOperationPossible || previouslyPossible,
        ...details,
      },
      cause: error,
    })
  }

  const nodeError = error as NodeJS.ErrnoException | undefined
  return new ControlError(
    nodeError?.code ? `native.${nodeError.code.toLowerCase()}` : 'native.unexpected',
    error instanceof Error ? error.message : 'An unexpected native error occurred.',
    {
      retryable: false,
      details: { durableOperationPossible },
      cause: error,
    },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function now(): string {
  return new Date().toISOString()
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

function isTerminalRuntimeOAuthPhase(phase: RuntimeOAuthSessionSnapshot['phase']): boolean {
  return phase === 'completed' || phase === 'cancelled' || phase === 'failed'
}

async function withOperationBound<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function withJitter(milliseconds: number): number {
  const spread = milliseconds * 0.2
  return Math.max(100, Math.round(milliseconds - spread + Math.random() * spread * 2))
}
