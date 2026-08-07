import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { App } from 'electron'
import {
  CapabilitySchema,
  CatalogProjectionSnapshotSchema,
  CommandEnvelopeSchema,
  PROTOCOL_VERSION as HOST_PROTOCOL_VERSION,
  ThreadProjectionSnapshotSchema,
  type CommandEnvelope
} from '../../shared/protocol'
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
  HostInstallPlan,
  OutboxEntry,
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

type ScopedOutboxEntry = OutboxEntry & { hostId: string }

interface OutboxIdentity {
  hostId: string
  commandId: string
  deviceId?: string
}

interface CapturedProjectionAuthority {
  hostId: string
  connection: FramedConnection
  target: ConnectionTarget
  generation: number
}

interface ServiceOptions {
  app: App
  sshExecutable?: string
}

const RECONNECT_DELAYS_MS = [500, 1_500, 3_500, 8_000, 15_000, 30_000] as const
const OUTBOX_LIMIT = 1_000
const TARGET_BINDING_LIMIT = 128
const TERMINAL_OR_DURABLE = new Set([
  'received',
  'admitted',
  'running',
  'completed',
  'rejected',
  'cancelled',
  'failed'
])

export class DesktopControlService extends EventEmitter {
  private readonly app: App
  private readonly sshExecutable: string
  private readonly cache: IndexedProjectionCacheStore<CacheEnvelope>
  private readonly outbox: AtomicJsonStore<OutboxEntry[]>
  private readonly latency = new LatencyRecorder()
  private readonly discoveredAliases = new Set<string>()
  private readonly installPlans = new Map<string, HostInstallPlan>()
  private connection?: FramedConnection
  private target?: ConnectionTarget
  private authorityHostId?: string
  private authorityCapabilities: string[] = []
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
    const stateDirectory = path.join(this.app.getPath('userData'), 'control')
    const emptyCache = (): CacheEnvelope => ({ version: 3, entries: {}, targetHostBindings: [] })
    this.cache = new IndexedProjectionCacheStore(
      path.join(stateDirectory, 'projection-cache.json'),
      path.join(stateDirectory, 'projections'),
      normalizeCache,
      emptyCache,
    )
    this.outbox = new AtomicJsonStore(path.join(stateDirectory, 'command-outbox.json'), () => [], 4 * 1024 * 1024)
  }

  async bootstrap(): Promise<BootstrapPayload> {
    return await this.latency.measure('cache.bootstrap', async () => {
      const initialCache = await this.readCache()
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

      // Cache, outbox, and connection must describe one authority. A concurrent
      // connect can otherwise splice A's cache onto B's connection state.
      for (let retry = 0; retry < 16; retry += 1) {
        const generation = this.reconnectGeneration
        const activeHostId = this.authorityHostId
        const activeTarget = this.target
        const cache = retry === 0 ? initialCache : await this.readCache()
        const outbox = await this.readOutbox()
        const connection = this.getConnectionState()
        if (
          generation === this.reconnectGeneration &&
          activeHostId === this.authorityHostId &&
          sameOptionalTarget(activeTarget, this.target) &&
          sameOptionalTarget(activeTarget, connection.target) &&
          (!connection.hostId || connection.hostId === activeHostId)
        ) {
          return {
            cache: visibleCacheForAuthority(cache, activeHostId),
            outbox: outbox.filter((entry) =>
              Boolean(activeHostId && isOutboxEntryForAuthority(entry, activeHostId))
            ),
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
    if (target.kind === 'ssh') await this.requireDiscoveredAlias(target.alias)
    this.intentionallyOffline = false
    this.target = target
    // A locator is not capability authority. Preserve capabilities only across
    // automatic/manual reconnects to the already verified target.
    this.authorityCapabilities = []
    const generation = ++this.reconnectGeneration
    const cache = await this.cache.update((current) => ({
      ...normalizeCache(current),
      lastAttemptedTarget: target,
      lastAttemptedAt: now()
    }))
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
    this.authorityHostId = findBoundHostId(cache, target)
    return await this.establish(target, 'connecting', generation)
  }

  async reconnect(): Promise<ConnectionState> {
    if (!this.target) {
      throw new ControlError('connection.no_target', 'There is no previous host to reconnect to.')
    }
    this.intentionallyOffline = false
    this.reconnectGeneration += 1
    return await this.establish(this.target, 'reconnecting', this.reconnectGeneration)
  }

  async disconnect(): Promise<void> {
    this.intentionallyOffline = true
    this.reconnectGeneration += 1
    const connection = this.connection
    this.connection = undefined
    connection?.close()
    this.setState({
      phase: 'offline',
      target: this.target,
      ...(this.authorityHostId ? { hostId: this.authorityHostId } : {}),
      ...this.capabilityState(),
      since: now(),
      attempt: this.attempt
    })
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
      await this.cache.update((current) => {
        this.assertProjectionAuthority(authority, 'thread snapshot')
        const cache = normalizeCache(current)
        const previous = cache.entries[authority.hostId]
        return replaceProjectionEntry(cache, authority.hostId, {
          ...previous,
          hostId: authority.hostId,
          lastSnapshot: parsedSnapshot,
          updatedAt: now(),
        })
      })
      this.assertProjectionAuthority(authority, 'thread snapshot')
      return parsedSnapshot
    })
  }

  async submitCommand(command: ClientCommand): Promise<CommandReceipt> {
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
    const connection = this.connection
    if (!connection || connection.isClosed) {
      if (!isExplicitOfflineFollowUp(command)) {
        throw new ControlError(
          'connection.required',
          'This command needs a live host connection. Follow-ups can be queued only when explicitly requested.',
          { retryable: true }
        )
      }
      await this.putOutbox({ hostId, command, state: 'waiting_for_connection', updatedAt: now() })
      return { hostId, deviceId: command.deviceId, commandId: command.commandId, status: 'waiting_for_connection', durable: false }
    }

    await this.putOutbox({ hostId, command, state: 'uncertain', updatedAt: now() })
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
      if (receipt.durable || TERMINAL_OR_DURABLE.has(receipt.status)) {
        await this.removeOutbox([{ hostId, deviceId: command.deviceId, commandId: command.commandId }])
      }
      return receipt
    } catch (error) {
      await this.putOutbox({ hostId, command, state: 'uncertain', updatedAt: now() })
      throw error
    }
  }

  async approve(input: ApprovalResolution): Promise<CommandReceipt> {
    return await this.submitCommand({
      deviceId: input.deviceId,
      commandId: input.commandId,
      expectedHostId: input.expectedHostId,
      threadId: input.threadId,
      kind: 'approval.resolve',
      delivery: 'live_only',
      payload: { approvalId: input.approvalId, decision: input.decision }
    })
  }

  async cancel(input: CancelRequest): Promise<CommandReceipt> {
    return await this.submitCommand({
      deviceId: input.deviceId,
      commandId: input.commandId,
      expectedHostId: input.expectedHostId,
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
      const hostId = this.requireAuthorityHostId()
      const connection = this.requireConnection()
      const pending = (await this.readOutbox()).filter((entry) => isOutboxEntryForAuthority(entry, hostId))
      const identities = commandIds.map((commandId) => {
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
        const entry = matches[0] as ScopedOutboxEntry
        return { deviceId: entry.command.deviceId, commandId }
      })
      const receipts: CommandReceipt[] = []
      for (let offset = 0; offset < identities.length; offset += 256) {
        if (this.authorityHostId !== hostId || this.connection !== connection || connection.isClosed) {
          throw new ControlError('connection.superseded', 'The host connection changed during command reconciliation.', {
            retryable: true
          })
        }
        const batch = identities.slice(offset, offset + 256)
        const result = await connection.request(
          'command.reconcile',
          { expectedHostId: hostId, commands: batch },
          { priority: 'urgent' }
        )
        receipts.push(...normalizeReconciliation(result, batch).map((receipt) => ({ ...receipt, hostId })))
      }
      await this.removeOutbox(
        receipts
          .filter((receipt) => TERMINAL_OR_DURABLE.has(receipt.status) && receipt.deviceId)
          .map((receipt) => ({ hostId, deviceId: receipt.deviceId, commandId: receipt.commandId }))
      )
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
    return {
      platform: process.platform,
      arch: process.arch,
      appVersion: this.app.getVersion(),
      localEndpoint: await localHostdEndpoint(),
      connection: this.getConnectionState(),
      sshExecutable: this.sshExecutable,
      outboxCount: (await this.readOutbox()).length,
      latencyTraces: this.latency.snapshot()
    }
  }

  getConnectionState(): ConnectionState {
    return structuredClone(this.state)
  }

  private async establish(
    target: ConnectionTarget,
    phase: 'connecting' | 'reconnecting',
    generation: number
  ): Promise<ConnectionState> {
    const previous = this.connection
    this.connection = undefined
    previous?.close()
    this.attempt += 1
    this.setState({
      phase,
      target,
      ...(this.authorityHostId ? { hostId: this.authorityHostId } : {}),
      ...this.capabilityState(),
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
      const hostId = authorityHostIdFromHealth(health)
      const capabilities = capabilitiesFromHealth(health)
      const projectionInvalidated = await this.bindAuthority(target, hostId, generation)
      this.authorityCapabilities = capabilities
      // Publish verified authority before reconciliation or an online state so
      // a same-alias host replacement invalidates stale renderer projections.
      if (projectionInvalidated) {
        this.setState({
          phase,
          target,
          hostId,
          path: target.kind === 'local' ? 'local_socket' : 'ssh',
          ...this.capabilityState(),
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
        await this.reconcileOutboxAfterConnect(hostId, candidate)
      } catch (error) {
        if (!this.isActiveConnection(candidate, target, hostId, generation)) throw error
        this.setState({
          phase: 'degraded',
          target,
          hostId,
          path: target.kind === 'local' ? 'local_socket' : 'ssh',
          ...this.capabilityState(),
          since: now(),
          attempt: this.attempt,
          error: toStructuredError(error)
        })
        return this.getConnectionState()
      }
      this.assertActiveConnection(candidate, target, hostId, generation)
      // Publish online only after pending command identities have reconciled.
      // Renderer refreshes triggered by this transition therefore cannot race
      // ahead of a safely delivered send-when-reconnected follow-up.
      this.setState({
        phase: 'online',
        target,
        hostId,
        path: target.kind === 'local' ? 'local_socket' : 'ssh',
        ...this.capabilityState(),
        since: now(),
        attempt: this.attempt
      })
      return this.getConnectionState()
    } catch (error) {
      if (this.connection === candidate) this.connection = undefined
      candidate?.close()
      if (generation === this.reconnectGeneration) {
        this.setState({
          phase: 'offline',
          target,
          ...(this.authorityHostId ? { hostId: this.authorityHostId } : {}),
          ...this.capabilityState(),
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
      else if (event.type.startsWith('snapshot.') || event.type === 'thread.snapshot') {
        try {
          this.emit('snapshot', snapshotEventForAuthority(event.payload, hostId))
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
      if (this.connection !== connection) return
      this.connection = undefined
      if (this.intentionallyOffline || generation !== this.reconnectGeneration) return
      this.beginAutomaticReconnect(target, error)
    })
  }

  private beginAutomaticReconnect(target: ConnectionTarget, cause: unknown): void {
    const generation = ++this.reconnectGeneration
    this.setState({
      phase: 'reconnecting',
      target,
      ...(this.authorityHostId ? { hostId: this.authorityHostId } : {}),
      ...this.capabilityState(),
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
          await this.establish(target, 'reconnecting', generation)
          return
        } catch (error) {
          lastError = error
          retryIndex += 1
          if (!this.intentionallyOffline && generation === this.reconnectGeneration) {
            this.setState({
              phase: 'reconnecting',
              target,
              ...(this.authorityHostId ? { hostId: this.authorityHostId } : {}),
              ...this.capabilityState(),
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

  private capabilityState(): Pick<ConnectionState, 'capabilities'> | Record<string, never> {
    return this.authorityCapabilities.length > 0
      ? { capabilities: [...this.authorityCapabilities] }
      : {}
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
      const targetHostBindings = cache.targetHostBindings
        .filter((binding) => !sameTarget(binding.target, target))
        .slice(-(TARGET_BINDING_LIMIT - 1))
      targetHostBindings.push({ target, hostId, verifiedAt })
      const remainsCurrent =
        generation === this.reconnectGeneration &&
        !this.intentionallyOffline &&
        Boolean(this.target && sameTarget(this.target, target))
      if (!remainsCurrent) return { ...cache, targetHostBindings }
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

  private async persistCatalog(catalog: unknown, authority: CapturedProjectionAuthority): Promise<void> {
    const parsedCatalog = CatalogProjectionSnapshotSchema.parse(catalog)
    this.assertProjectionAuthority(authority, 'catalog refresh')
    if (parsedCatalog.host.hostId !== authority.hostId) {
      throw new ControlError('protocol.authority_mismatch', 'The catalog belongs to a different host authority.', {
        details: { expectedHostId: authority.hostId, receivedHostId: parsedCatalog.host.hostId }
      })
    }
    await this.cache.update((current) => {
      this.assertProjectionAuthority(authority, 'catalog refresh')
      const cache = normalizeCache(current)
      const previous = cache.entries[authority.hostId]
      return replaceProjectionEntry(cache, authority.hostId, {
        ...previous,
        hostId: authority.hostId,
        catalog: parsedCatalog,
        updatedAt: now(),
      })
    })
    this.assertProjectionAuthority(authority, 'catalog refresh')
  }

  private async readCache(): Promise<CacheEnvelope> {
    return normalizeCache(await this.cache.read())
  }

  private async readOutbox(): Promise<OutboxEntry[]> {
    const entries = await this.outbox.read()
    if (!Array.isArray(entries)) return []
    return entries.filter(isOutboxEntry).slice(-OUTBOX_LIMIT)
  }

  private async putOutbox(entry: ScopedOutboxEntry): Promise<void> {
    await this.outbox.update(async () => {
      const entries = await this.readOutbox()
      const withoutCurrent = entries.filter((candidate) => !sameOutboxIdentity(candidate, entry))
      withoutCurrent.push(entry)
      if (withoutCurrent.length > OUTBOX_LIMIT) {
        throw new ControlError('outbox.full', 'The local command outbox is full.', {
          details: { maxEntries: OUTBOX_LIMIT }
        })
      }
      return withoutCurrent
    })
  }

  private async removeOutbox(identities: OutboxIdentity[]): Promise<void> {
    if (identities.length === 0) return
    await this.outbox.update(async () =>
      (await this.readOutbox()).filter(
        (entry) => !identities.some((identity) => matchesOutboxIdentity(entry, identity))
      )
    )
  }

  private async reconcileOutboxAfterConnect(hostId: string, connection: FramedConnection): Promise<void> {
    if (this.authorityHostId !== hostId || this.connection !== connection || connection.isClosed) {
      throw new ControlError('connection.superseded', 'The host authority changed during command reconciliation.')
    }
    // Entries for another host—or legacy entries with no immutable authority—
    // remain quarantined locally and are never disclosed to this connection.
    const pending = (await this.readOutbox()).filter((entry) => isOutboxEntryForAuthority(entry, hostId))
    if (pending.length === 0) return

    const entriesByIdentity = new Map(
      pending.map((entry) => [commandIdentityKey(entry.command.deviceId, entry.command.commandId), entry])
    )
    const durableIdentities = new Set<string>()
    const explicitlyUnknownWaitingIdentities = new Set<string>()

    for (let offset = 0; offset < pending.length; offset += 256) {
      if (this.authorityHostId !== hostId || this.connection !== connection || connection.isClosed) {
        throw new ControlError('connection.superseded', 'The host authority changed during command reconciliation.')
      }
      const batch = pending.slice(offset, offset + 256)
      const identities = batch.map((entry) => ({
        deviceId: entry.command.deviceId,
        commandId: entry.command.commandId
      }))
      const result = await connection.request(
        'command.reconcile',
        { expectedHostId: hostId, commands: identities },
        { priority: 'urgent' }
      )

      for (const receipt of normalizeReceipts(result)) {
        if (TERMINAL_OR_DURABLE.has(receipt.status) || receipt.durable) {
          const matches = receipt.deviceId
            ? [entriesByIdentity.get(commandIdentityKey(receipt.deviceId, receipt.commandId))].filter(
                (entry): entry is ScopedOutboxEntry => Boolean(entry)
              )
            : batch.filter((entry) => entry.command.commandId === receipt.commandId)
          if (matches.length === 1) {
            const entry = matches[0] as ScopedOutboxEntry
            durableIdentities.add(commandIdentityKey(entry.command.deviceId, entry.command.commandId))
          }
        }
      }

      // Auto-delivery is limited to commands the user explicitly chose to send
      // after reconnect, and only after this host authoritatively says it has no
      // receipt for the same device/command identity. Commands that may have
      // crossed the connection boundary remain uncertain and are never replayed.
      if (isRecord(result) && Array.isArray(result.unknown)) {
        for (const identity of result.unknown) {
          if (!isRecord(identity)) continue
          const commandId = typeof identity.commandId === 'string' ? identity.commandId : undefined
          const deviceId = typeof identity.deviceId === 'string' ? identity.deviceId : undefined
          if (!commandId || !deviceId) continue
          const key = commandIdentityKey(deviceId, commandId)
          const entry = entriesByIdentity.get(key)
          if (
            entry?.state === 'waiting_for_connection' &&
            isExplicitOfflineFollowUp(entry.command)
          ) {
            explicitlyUnknownWaitingIdentities.add(key)
          }
        }
      }
    }

    await this.removeOutbox(
      [...durableIdentities]
        .map((key) => entriesByIdentity.get(key))
        .filter((entry): entry is ScopedOutboxEntry => Boolean(entry))
        .map((entry) => ({
          hostId,
          deviceId: entry.command.deviceId,
          commandId: entry.command.commandId
        }))
    )

    let firstDeliveryError: unknown
    for (const key of explicitlyUnknownWaitingIdentities) {
      const entry = entriesByIdentity.get(key)
      if (!entry) continue
      try {
        if (this.authorityHostId !== hostId || this.connection !== connection || connection.isClosed) {
          throw new ControlError('connection.superseded', 'The host authority changed before queued delivery.')
        }
        const receipt = await this.submitCommand(entry.command)
        this.emit('host-event', { type: 'command.receipt', payload: receipt })
      } catch (error) {
        firstDeliveryError ??= error
      }
    }
    if (firstDeliveryError) throw firstDeliveryError
  }
}

function normalizeReceipt(commandId: string, value: unknown): CommandReceipt {
  if (!isRecord(value)) return { commandId, status: 'received', durable: true }
  const status = typeof value.status === 'string' && isReceiptStatus(value.status) ? value.status : 'received'
  return {
    commandId: typeof value.commandId === 'string' ? value.commandId : commandId,
    ...(typeof value.deviceId === 'string' ? { deviceId: value.deviceId } : {}),
    status,
    durable: typeof value.durable === 'boolean' ? value.durable : status !== 'uncertain',
    ...(typeof value.detail === 'string'
      ? { detail: value.detail.slice(0, 2_048) }
      : typeof value.message === 'string'
        ? { detail: value.message.slice(0, 2_048) }
        : {})
  }
}

function normalizeReceipts(value: unknown): CommandReceipt[] {
  const candidates = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.receipts) ? value.receipts : []
  return candidates
    .filter(isRecord)
    .filter((candidate) => typeof candidate.commandId === 'string')
    .slice(0, OUTBOX_LIMIT)
    .map((candidate) => normalizeReceipt(candidate.commandId as string, candidate))
}

function normalizeReconciliation(
  value: unknown,
  requestedIdentities: Array<{ deviceId: string; commandId: string }>
): CommandReceipt[] {
  const receipts = normalizeReceipts(value)
  const seen = new Set(
    receipts
      .filter((receipt) => receipt.deviceId)
      .map((receipt) => commandIdentityKey(receipt.deviceId as string, receipt.commandId))
  )
  const unknown = isRecord(value) && Array.isArray(value.unknown)
    ? value.unknown
        .filter(isRecord)
        .map((identity) => ({ deviceId: identity.deviceId, commandId: identity.commandId }))
        .filter(
          (identity): identity is { deviceId: string; commandId: string } =>
            typeof identity.deviceId === 'string' && typeof identity.commandId === 'string'
        )
    : requestedIdentities.filter(
        (identity) => !seen.has(commandIdentityKey(identity.deviceId, identity.commandId))
      )
  for (const identity of unknown) {
    const key = commandIdentityKey(identity.deviceId, identity.commandId)
    if (!seen.has(key)) {
      receipts.push({
        deviceId: identity.deviceId,
        commandId: identity.commandId,
        status: 'uncertain',
        durable: false
      })
    }
  }
  return receipts
}

function commandIdentityKey(deviceId: string, commandId: string): string {
  return `${deviceId}\u0000${commandId}`
}

function adaptCommand(input: ClientCommand): CommandEnvelope {
  if (!input.threadId) {
    throw new ControlError('command.thread_required', 'A thread ID is required for host commands.')
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
    command = {
      kind: 'approval.resolve',
      approvalId: payload.approvalId,
      decision: payload.decision === 'approve' ? 'approve' : 'reject',
      ...(typeof payload.comment === 'string' ? { comment: payload.comment } : {})
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
    issuedAt: now(),
    ...(input.expectedExecutionGenerationId
      ? { expectedExecutionGenerationId: input.expectedExecutionGenerationId }
      : {}),
    command
  })
}

function isReceiptStatus(value: string): value is CommandReceipt['status'] {
  return value === 'waiting_for_connection' || value === 'uncertain' || TERMINAL_OR_DURABLE.has(value)
}

function isUrgentCommand(kind: string): boolean {
  return kind === 'approval.resolve' || kind === 'thread.cancel' || kind === 'thread.abort'
}

function isExplicitOfflineFollowUp(command: ClientCommand): boolean {
  return (
    command.delivery === 'send_when_reconnected' &&
    (command.kind === 'thread.follow_up' || command.kind === 'follow_up')
  )
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!isRecord(value) || (value.state !== 'waiting_for_connection' && value.state !== 'uncertain')) return false
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

function isOutboxEntryForAuthority(entry: OutboxEntry, hostId: string): entry is ScopedOutboxEntry {
  return entry.hostId === hostId && entry.command.expectedHostId === hostId
}

function sameOutboxIdentity(left: OutboxEntry, right: ScopedOutboxEntry): boolean {
  return (
    left.hostId === right.hostId &&
    left.command.deviceId === right.command.deviceId &&
    left.command.commandId === right.command.commandId
  )
}

function matchesOutboxIdentity(entry: OutboxEntry, identity: OutboxIdentity): boolean {
  return (
    entry.hostId === identity.hostId &&
    entry.command.commandId === identity.commandId &&
    (identity.deviceId === undefined || entry.command.deviceId === identity.deviceId)
  )
}

function authorityHostIdFromHealth(value: unknown): string {
  const hostId = isRecord(value) ? asHostId(isRecord(value.host) ? value.host.hostId : undefined) : undefined
  if (!hostId) {
    throw new ControlError('protocol.host_identity_missing', 'The host health response did not include an immutable host identity.')
  }
  return hostId
}

function capabilitiesFromHealth(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.capabilities)) return []
  const capabilities = value.capabilities.flatMap((candidate) => {
    const parsed = CapabilitySchema.safeParse(candidate)
    return parsed.success ? [parsed.data] : []
  })
  return [...new Set(capabilities)].sort()
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
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  }
}

function findBoundHostId(cache: CacheEnvelope, target: ConnectionTarget): string | undefined {
  return [...cache.targetHostBindings].reverse().find((binding) => sameTarget(binding.target, target))?.hostId
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

function isConnectionTarget(value: unknown): value is ConnectionTarget {
  if (!isRecord(value)) return false
  return value.kind === 'local' || (value.kind === 'ssh' && typeof value.alias === 'string' && value.alias.length > 0)
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

function withJitter(milliseconds: number): number {
  const spread = milliseconds * 0.2
  return Math.max(100, Math.round(milliseconds - spread + Math.random() * spread * 2))
}
