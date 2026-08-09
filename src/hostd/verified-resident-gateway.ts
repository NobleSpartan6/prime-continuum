import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  GatewayError,
  type GatewayAdmission,
  type GatewayDispatchContext,
  type PrimeAgentProjectionChange,
  type PrimeAgentGateway,
} from "./gateway";
import {
  PrimeAgentResidentAdapter,
  type ResidentOwnedRuntimeCandidate,
  type PrimeAgentPublicModuleLoader,
  type PrimeAgentResidentAdapterOptions,
} from "./prime-agent-resident-adapter";
import {
  createPrimeAgentResidentWorkerModuleLoader,
  type PrimeAgentResidentWorkerModuleLoader,
} from "./prime-agent-resident-worker-proxy";
import type { ResidentProjectionSnapshot } from "./resident-projection";
import {
  ResidentRuntimeContractError,
  validateResidentSessionBinding,
  type ResidentAbortIdleAuthorityEvidence,
  type ResidentPromptIdleAuthorityEvidence,
  type ResidentOwnedSessionCreateInput,
  type ResidentRuntimeConnection,
  type ResidentSessionBinding,
} from "./resident-runtime";
import type { VerifiedInstalledRuntimeHandle } from "./runtime-integrity-manager";
import type { VerifiedRuntimeHandleProvider } from "./runtime-model-catalog";
import {
  ResidentLifecycleCoordinator,
  type ResidentEndRequest,
  type ResidentProvisionRequest,
  type ResidentProvisioningAdapter,
} from "./resident-lifecycle-coordinator";
import {
  residentDispatchAuthorityFingerprint,
  validateResidentAbortReconciliationLease,
  validateResidentPromptReconciliationLease,
  type HostStore,
  type ResidentAbortIdleObservedEvent,
  type ResidentAbortReconciliationLease,
  type ResidentLifecycleStatus,
  type ResidentPromptIdleObservedEvent,
  type ResidentPromptReconciliationLease,
} from "./store";
import type { CommandEnvelope } from "../shared/protocol";
import type { PrimeAgentRuntimeSecurityGate } from "./prime-agent-auth-security";

const MAX_UNIX_SOCKET_PATH_BYTES = 100;

type ResidentGatewayAdapter = PrimeAgentGateway & {
  createOwnedCandidate?(input: Parameters<ResidentProvisioningAdapter["createOwnedCandidate"]>[0]): Promise<ResidentOwnedRuntimeCandidate>;
  readStableResidentProjection?(binding: ResidentSessionBinding): Promise<ResidentProjectionSnapshot>;
  endResidentSession?: NonNullable<ResidentProvisioningAdapter["endResidentSession"]>;
  attachResident(binding: ResidentSessionBinding): Promise<ResidentRuntimeConnection>;
  reconcileAcknowledgedPromptIdle(
    lease: ResidentPromptReconciliationLease,
  ): Promise<ResidentPromptIdleAuthorityEvidence>;
  reconcileAcknowledgedAbortIdle(
    lease: ResidentAbortReconciliationLease,
  ): Promise<ResidentAbortIdleAuthorityEvidence>;
};

interface DesiredResidentBinding {
  readonly binding: ResidentSessionBinding;
  readonly fingerprint: string;
}

interface AttachedResidentBinding extends DesiredResidentBinding {
  readonly connection: ResidentRuntimeConnection;
  readonly publicationBaseline: number;
}

interface ResidentBindingPreparationJob {
  readonly fingerprint: string;
  readonly promise: Promise<void>;
}

interface ResidentBindingProjectionJob {
  readonly attached: AttachedResidentBinding;
  readonly promise: Promise<void>;
}

export interface VerifiedResidentGatewayOptions {
  readonly store: HostStore;
  readonly runtimeHandles: VerifiedRuntimeHandleProvider;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
  /** The exact shared custody proof also used by OAuth and model discovery. */
  readonly credentialSecurity?: PrimeAgentRuntimeSecurityGate;
  /** Test seam. Production constructs the pinned resident adapter exactly once. */
  readonly adapterFactory?: (options: PrimeAgentResidentAdapterOptions) => ResidentGatewayAdapter;
  /** Test seam for the verified deep-module loader. */
  readonly moduleLoaderFactory?: (handle: VerifiedInstalledRuntimeHandle) => PrimeAgentPublicModuleLoader;
}

/**
 * Lazily attaches only durable resident bindings after a fresh runtime-tree
 * verification. It never creates or replaces a Prime Agent session as a side
 * effect of `isLive`; session creation remains a separate durable operation.
 */
export class VerifiedResidentGateway implements PrimeAgentGateway {
  readonly continuity = "resident" as const;
  private readonly store: HostStore;
  private readonly runtimeHandles: VerifiedRuntimeHandleProvider;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly platform: NodeJS.Platform;
  private readonly credentialSecurity: PrimeAgentRuntimeSecurityGate | undefined;
  private readonly adapterFactory: NonNullable<VerifiedResidentGatewayOptions["adapterFactory"]>;
  private readonly moduleLoaderFactory: NonNullable<VerifiedResidentGatewayOptions["moduleLoaderFactory"]>;
  private readonly lifecycleCoordinator: ResidentLifecycleCoordinator;
  private readonly projectionListeners = new Set<(change: PrimeAgentProjectionChange) => void>();
  private readonly promptIdleListeners = new Set<(event: ResidentPromptIdleObservedEvent) => void>();
  private readonly abortIdleListeners = new Set<(event: ResidentAbortIdleObservedEvent) => void>();
  private readonly promptReconciliationJobs = new Map<string, Promise<void>>();
  private readonly abortReconciliationJobs = new Map<string, Promise<void>>();
  private desiredBindings = new Map<string, DesiredResidentBinding>();
  private readonly attachedBindings = new Map<string, AttachedResidentBinding>();
  private readonly preparedBindings = new Map<string, AttachedResidentBinding>();
  private readonly bindingPreparationJobs = new Map<string, ResidentBindingPreparationJob>();
  private readonly bindingProjectionJobs = new Map<string, ResidentBindingProjectionJob>();
  private readonly bindingRetirementJobs = new Map<string, Promise<void>>();
  private readonly bindingPublicationRevisions = new Map<string, number>();
  private adapter: ResidentGatewayAdapter | undefined;
  private adapterPromise: Promise<ResidentGatewayAdapter> | undefined;
  private residentLifecycleCapabilityVerified = false;
  private residentLifecycleCapabilityAttempt: Promise<void> | undefined;
  private residentLifecycleCapabilityRetryAfterMs = 0;
  private runtimeModuleLoader: PrimeAgentResidentWorkerModuleLoader | undefined;
  private promptReconciliationDiscovery: Promise<void> | undefined;
  private abortReconciliationDiscovery: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: VerifiedResidentGatewayOptions) {
    this.store = options.store;
    this.runtimeHandles = options.runtimeHandles;
    this.environment = Object.freeze({ ...(options.environment ?? process.env) });
    this.platform = options.platform ?? process.platform;
    this.credentialSecurity = options.credentialSecurity;
    this.adapterFactory = options.adapterFactory ?? ((adapterOptions) => new PrimeAgentResidentAdapter(adapterOptions));
    this.moduleLoaderFactory = options.moduleLoaderFactory ?? createVerifiedResidentModuleLoader;
    this.lifecycleCoordinator = new ResidentLifecycleCoordinator({
      store: this.store,
      adapter: () => this.ensureProvisioningAdapter(),
      onCommitted: (binding) => this.acceptCommittedBinding(binding),
      onEnding: (binding) => this.acceptEndingBinding(binding),
      onEnded: (binding) => this.publishEndedBindingChange(binding),
    });
  }

  async isLive(threadId: string, executionGenerationId: string): Promise<boolean> {
    if (this.closed) return false;
    if (!(await this.credentialSecurityReady())) return false;
    const binding = await this.store.getResidentSessionBinding(threadId, executionGenerationId);
    const slot = residentBindingSlotKey(threadId, executionGenerationId);
    if (!binding) {
      this.retireAttachedBinding(slot);
      return false;
    }
    const attached = this.attachedBindings.get(slot);
    if (
      attached &&
      attached.fingerprint !== residentDispatchAuthorityFingerprint(binding)
    ) {
      this.retireAttachedBinding(slot, attached);
    }
    return this.isResidentBindingLive(binding);
  }

  async isResidentBindingLive(bindingValue: ResidentSessionBinding): Promise<boolean> {
    if (this.closed) return false;
    if (!(await this.credentialSecurityReady())) return false;
    const binding = validateResidentSessionBinding(bindingValue);
    const slot = residentBindingSlotKeyFor(binding);
    const fingerprint = residentDispatchAuthorityFingerprint(binding);
    const attached = this.attachedBindings.get(slot);
    if (!attached || attached.fingerprint !== fingerprint || !this.adapter) {
      // A stale caller must not retire a different, healthy authority that now
      // occupies this generation slot. Only this exact binding can invalidate
      // its own attachment.
      if (attached?.fingerprint === fingerprint) this.retireAttachedBinding(slot, attached);
      return false;
    }
    const prepared = this.preparedBindings.get(slot);
    if (prepared !== attached) return false;
    try {
      const live = await this.adapter.isLive(binding.threadId, binding.executionGenerationId);
      await this.assertCredentialSecurity(true);
      const stillPrepared = !this.closed &&
        live &&
        this.preparedBindings.get(slot) === attached &&
        await this.isCurrentBinding(binding);
      if (!stillPrepared) this.retireAttachedBinding(slot, attached);
      return stillPrepared;
    } catch (error) {
      this.retireAttachedBinding(slot, attached);
      if (isDefinitivelyUnavailableResident(error)) return false;
      throw error;
    }
  }

  /**
   * Nonblocking health gate. Each durable binding attaches and recovers in its
   * own authority slot. The global command capability is advertised when at
   * least one current exact binding is ready; an unrelated failed binding
   * cannot poison a healthy session.
   */
  async capabilityReady(): Promise<boolean> {
    if (this.closed) return false;
    if (!this.beginCredentialSecurityWarmup()) return false;
    if (!(await this.credentialSecurityReady())) return false;
    const bindings = await this.store.listResidentSessionBindings();
    this.synchronizeDesiredBindings(bindings);
    for (const desired of this.desiredBindings.values()) {
      this.scheduleBindingPreparation(desired);
    }
    for (const attached of this.attachedBindings.values()) {
      this.scheduleProjectionReadinessCheck(attached);
    }
    const ready = this.hasPreparedBinding();
    if (ready) {
      this.schedulePromptReconciliationDiscovery();
      this.scheduleAbortReconciliationDiscovery();
    }
    return ready;
  }

  /**
   * Proves the verified runtime/adapter composition independently of active
   * bindings. HostService separately gates advertisement on runtime integrity.
   */
  async residentLifecycleCapabilityReady(): Promise<boolean> {
    if (this.closed) return false;
    if (!this.beginCredentialSecurityWarmup()) return false;
    if (!(await this.credentialSecurityReady())) return false;
    if (this.residentLifecycleCapabilityVerified) return true;
    this.scheduleResidentLifecycleCapabilityWarmup();
    return false;
  }

  /** Durable client-owned escrow provisioning for one Store-authorized thread. */
  provisionResident(request: ResidentProvisionRequest): Promise<ResidentLifecycleStatus> {
    if (this.closed) {
      return Promise.reject(new GatewayError("GATEWAY_CLOSED", "The resident gateway is closed"));
    }
    return this.assertCredentialSecurity(true).then(() => this.lifecycleCoordinator.provision(request));
  }

  /** Durable explicit end for one exact Store-authorized resident thread. */
  endResident(request: ResidentEndRequest): Promise<ResidentLifecycleStatus> {
    if (this.closed) {
      return Promise.reject(new GatewayError("GATEWAY_CLOSED", "The resident gateway is closed"));
    }
    return this.assertCredentialSecurity(true).then(() => this.lifecycleCoordinator.end(request));
  }

  subscribeProjectionChanges(listener: (change: PrimeAgentProjectionChange) => void): () => void {
    if (this.closed) return () => undefined;
    this.projectionListeners.add(listener);
    return () => this.projectionListeners.delete(listener);
  }

  subscribeResidentPromptIdleObserved(
    listener: (event: ResidentPromptIdleObservedEvent) => void,
  ): () => void {
    if (this.closed) return () => undefined;
    this.promptIdleListeners.add(listener);
    return () => this.promptIdleListeners.delete(listener);
  }

  subscribeResidentAbortIdleObserved(
    listener: (event: ResidentAbortIdleObservedEvent) => void,
  ): () => void {
    if (this.closed) return () => undefined;
    this.abortIdleListeners.add(listener);
    return () => this.abortIdleListeners.delete(listener);
  }

  scheduleResidentPromptReconciliation(leaseValue: ResidentPromptReconciliationLease): void {
    const lease = validateResidentPromptReconciliationLease(leaseValue);
    if (this.closed || this.promptReconciliationJobs.has(lease.attemptId)) return;
    const job = this.reconcileResidentPrompt(lease);
    this.promptReconciliationJobs.set(lease.attemptId, job);
    job.then(
      () => {
        if (this.promptReconciliationJobs.get(lease.attemptId) === job) {
          this.promptReconciliationJobs.delete(lease.attemptId);
        }
      },
      () => {
        // The durable lock remains authoritative. A later readiness poll can
        // retry the read-only proof, while this rejection is fully supervised.
        if (this.promptReconciliationJobs.get(lease.attemptId) === job) {
          this.promptReconciliationJobs.delete(lease.attemptId);
        }
      },
    );
  }

  scheduleResidentAbortReconciliation(leaseValue: ResidentAbortReconciliationLease): void {
    const lease = validateResidentAbortReconciliationLease(leaseValue);
    if (this.closed || this.abortReconciliationJobs.has(lease.attemptId)) return;
    const job = this.reconcileResidentAbort(lease);
    this.abortReconciliationJobs.set(lease.attemptId, job);
    job.then(
      () => {
        if (this.abortReconciliationJobs.get(lease.attemptId) === job) {
          this.abortReconciliationJobs.delete(lease.attemptId);
        }
      },
      () => {
        // The durable running Stop receipt remains authoritative. A later
        // readiness poll retries only this read-only proof, never the abort.
        if (this.abortReconciliationJobs.get(lease.attemptId) === job) {
          this.abortReconciliationJobs.delete(lease.attemptId);
        }
      },
    );
  }

  async submit(command: CommandEnvelope, context?: GatewayDispatchContext): Promise<GatewayAdmission> {
    if (this.closed) {
      throw new GatewayError("GATEWAY_CLOSED", "The resident Prime Agent gateway is closed", false);
    }
    await this.assertCredentialSecurity();
    const adapter = this.adapter;
    const binding = dispatchBindingFor(command, context, this.preparedBindings);
    if (!adapter || !binding || !this.isPreparedBinding(binding)) {
      throw new GatewayError(
        "RESIDENT_SESSION_NOT_ATTACHED",
        "The exact durable resident Prime Agent session must be attached before dispatch",
        true,
      );
    }
    if (!(await this.isCurrentBinding(binding))) {
      this.retireAttachedBinding(residentBindingSlotKeyFor(binding));
      throw new GatewayError(
        "RESIDENT_SESSION_NOT_ATTACHED",
        "The exact durable resident Prime Agent session must be attached before dispatch",
        true,
      );
    }
    await this.assertCredentialSecurity(true);
    return adapter.submit(command, context);
  }

  close(): Promise<void> {
    this.closed = true;
    this.closePromise ??= (async () => {
      // Let every durable mutation boundary settle before the adapter starts
      // retiring escrow transports. This preserves unknown-outcome semantics
      // and fences post-close Store transitions and readiness handoffs.
      await this.lifecycleCoordinator.close();
      const pending = this.adapterPromise;
      const pendingAdapter = pending ? await pending.catch(() => undefined) : this.adapter;
      // Closing the owned adapter first rejects any blocked pinned idle barrier;
      // reconciliation jobs are drained only after that terminal fence.
      await pendingAdapter?.close().catch(() => undefined);
      await this.runtimeModuleLoader?.close().catch(() => undefined);
      this.runtimeModuleLoader = undefined;
      await Promise.allSettled([...this.bindingPreparationJobs.values()].map((job) => job.promise));
      await Promise.allSettled([...this.bindingProjectionJobs.values()].map((job) => job.promise));
      await Promise.allSettled([...this.bindingRetirementJobs.values()]);
      const discovery = this.promptReconciliationDiscovery;
      if (discovery) await discovery.catch(() => undefined);
      const abortDiscovery = this.abortReconciliationDiscovery;
      if (abortDiscovery) await abortDiscovery.catch(() => undefined);
      await Promise.allSettled([...this.promptReconciliationJobs.values()]);
      await Promise.allSettled([...this.abortReconciliationJobs.values()]);
      this.projectionListeners.clear();
      this.promptIdleListeners.clear();
      this.abortIdleListeners.clear();
      this.desiredBindings.clear();
      this.attachedBindings.clear();
      this.preparedBindings.clear();
      this.bindingPublicationRevisions.clear();
    })();
    return this.closePromise;
  }

  private async ensureAdapter(): Promise<ResidentGatewayAdapter> {
    await this.assertCredentialSecurity();
    return this.ensureSecuredAdapter();
  }

  private ensureSecuredAdapter(): Promise<ResidentGatewayAdapter> {
    if (this.closed) return Promise.reject(new GatewayError("GATEWAY_CLOSED", "The resident gateway is closed"));
    if (this.adapter) return Promise.resolve(this.adapter);
    if (this.adapterPromise) return this.adapterPromise;
    const attempt = this.createAdapter();
    this.adapterPromise = attempt;
    attempt.then(
      (adapter) => {
        if (this.adapterPromise === attempt) this.adapterPromise = undefined;
        if (!this.closed) this.adapter = adapter;
      },
      () => {
        if (this.adapterPromise === attempt) this.adapterPromise = undefined;
      },
    );
    return attempt;
  }

  private async credentialSecurityReady(): Promise<boolean> {
    try {
      await this.assertCredentialSecurity();
      return true;
    } catch {
      return false;
    }
  }

  private beginCredentialSecurityWarmup(): boolean {
    if (!this.credentialSecurity || this.credentialSecurity.capabilityAvailable?.() !== false) return true;
    void this.credentialSecurity.prepareAndVerify().catch(() => {
      this.withdrawCredentialRuntime();
    });
    return false;
  }

  private async assertCredentialSecurity(force = false): Promise<void> {
    try {
      await this.credentialSecurity?.assertStillSecure(force ? { force: true } : undefined);
    } catch {
      this.withdrawCredentialRuntime();
      throw new GatewayError(
        "PRIME_AGENT_RUNTIME_CUSTODY_UNAVAILABLE",
        "The resident Prime Agent runtime custody boundary is unavailable",
        true,
      );
    }
  }

  private withdrawCredentialRuntime(): void {
    this.residentLifecycleCapabilityVerified = false;
    this.residentLifecycleCapabilityRetryAfterMs = Number.POSITIVE_INFINITY;
    this.preparedBindings.clear();
    for (const [slot, attached] of this.attachedBindings) {
      this.retireAttachedBinding(slot, attached);
    }
  }

  private scheduleResidentLifecycleCapabilityWarmup(): void {
    if (
      this.closed ||
      this.residentLifecycleCapabilityVerified ||
      this.residentLifecycleCapabilityAttempt ||
      Date.now() < this.residentLifecycleCapabilityRetryAfterMs
    ) return;
    let attempt!: Promise<void>;
    attempt = this.ensureProvisioningAdapter()
      .then(() => {
        if (!this.closed) this.residentLifecycleCapabilityVerified = true;
      })
      .catch(() => {
        this.residentLifecycleCapabilityRetryAfterMs = Date.now() + 5_000;
      })
      .finally(() => {
        if (this.residentLifecycleCapabilityAttempt === attempt) {
          this.residentLifecycleCapabilityAttempt = undefined;
        }
      });
    this.residentLifecycleCapabilityAttempt = attempt;
  }

  private async ensureProvisioningAdapter(): Promise<ResidentProvisioningAdapter> {
    const adapter = await this.ensureAdapter();
    if (
      typeof adapter.createOwnedCandidate !== "function" ||
      typeof adapter.readStableResidentProjection !== "function" ||
      typeof adapter.endResidentSession !== "function"
    ) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_MODULE_INVALID",
        "The verified resident adapter does not expose client-owned provisioning and recovery.",
      );
    }
    return Object.freeze({
      createOwnedCandidate: async (input: ResidentOwnedSessionCreateInput) => {
        await this.assertCredentialSecurity(true);
        return adapter.createOwnedCandidate!(input);
      },
      readStableResidentProjection: async (binding: ResidentSessionBinding) => {
        await this.assertCredentialSecurity(true);
        return adapter.readStableResidentProjection!(binding);
      },
      endResidentSession: async (
        lease: Parameters<NonNullable<ResidentProvisioningAdapter["endResidentSession"]>>[0],
      ) => {
        await this.assertCredentialSecurity(true);
        return adapter.endResidentSession!(lease);
      },
    });
  }

  private acceptCommittedBinding(binding: ResidentSessionBinding): void {
    if (this.closed) return;
    const slot = residentBindingSlotKeyFor(binding);
    const desired = Object.freeze({
      binding,
      fingerprint: residentDispatchAuthorityFingerprint(binding),
    });
    this.desiredBindings.set(slot, desired);
    this.scheduleBindingPreparation(desired);
  }

  private async acceptEndingBinding(binding: ResidentSessionBinding): Promise<void> {
    const slot = residentBindingSlotKeyFor(binding);
    const desired = this.desiredBindings.get(slot);
    if (desired?.fingerprint === residentDispatchAuthorityFingerprint(binding)) {
      this.desiredBindings.delete(slot);
    }
    const attached = this.attachedBindings.get(slot);
    if (attached?.fingerprint === residentDispatchAuthorityFingerprint(binding)) {
      this.retireAttachedBinding(slot, attached);
      await this.bindingRetirementJobs.get(slot)?.catch(() => undefined);
    }
  }

  private publishEndedBindingChange(binding: ResidentSessionBinding): void {
    if (this.closed) return;
    const change = Object.freeze({
      threadId: binding.threadId,
      executionGenerationId: binding.executionGenerationId,
    });
    for (const listener of this.projectionListeners) {
      try {
        listener(change);
      } catch {
        // Terminal public state is already durable; refresh observers are advisory.
      }
    }
  }

  private synchronizeDesiredBindings(bindings: readonly ResidentSessionBinding[]): void {
    const next = new Map<string, DesiredResidentBinding>();
    for (const binding of bindings) {
      const slot = residentBindingSlotKeyFor(binding);
      next.set(slot, {
        binding,
        fingerprint: residentDispatchAuthorityFingerprint(binding),
      });
    }
    this.desiredBindings = next;
    for (const [slot, attached] of this.attachedBindings) {
      const desired = next.get(slot);
      if (!desired || desired.fingerprint !== attached.fingerprint) {
        this.retireAttachedBinding(slot, attached);
      }
    }
  }

  private scheduleBindingPreparation(desired: DesiredResidentBinding): void {
    if (this.closed) return;
    const slot = residentBindingSlotKeyFor(desired.binding);
    if (this.attachedBindings.get(slot)?.fingerprint === desired.fingerprint) return;
    if (this.bindingPreparationJobs.has(slot)) return;
    const retirement = this.bindingRetirementJobs.get(slot);
    const promise = this.prepareBinding(slot, desired, retirement);
    const job = Object.freeze({ fingerprint: desired.fingerprint, promise });
    this.bindingPreparationJobs.set(slot, job);
    promise.then(
      () => this.finishBindingPreparation(slot, job),
      () => this.finishBindingPreparation(slot, job),
    );
  }

  private finishBindingPreparation(slot: string, job: ResidentBindingPreparationJob): void {
    if (this.bindingPreparationJobs.get(slot) !== job) return;
    this.bindingPreparationJobs.delete(slot);
    const desired = this.desiredBindings.get(slot);
    // A replacement observed while an old attach was in flight proceeds only
    // after the stale connection has been detached by that old job.
    if (!this.closed && desired && desired.fingerprint !== job.fingerprint) {
      this.scheduleBindingPreparation(desired);
    }
  }

  private async prepareBinding(
    slot: string,
    desired: DesiredResidentBinding,
    retirement: Promise<void> | undefined,
  ): Promise<void> {
    let connection: ResidentRuntimeConnection | undefined;
    try {
      await retirement;
      const adapter = await this.ensureAdapter();
      if (this.closed || !this.isDesiredBinding(slot, desired.fingerprint)) return;
      // A prior durable projection proves historical authority, not that this
      // newly attached connection obtained a stable current snapshot. Capture
      // the slot revision immediately before attach so both an initial publish
      // inside attach and a later async refresh can cross this exact baseline.
      const publicationBaseline = this.bindingPublicationRevisions.get(slot) ?? 0;
      connection = await adapter.attachResident(desired.binding);
      await this.assertCredentialSecurity(true);
      if (
        this.closed ||
        !this.isDesiredBinding(slot, desired.fingerprint) ||
        !(await this.isCurrentBinding(desired.binding))
      ) {
        await connection.detach().catch(() => undefined);
        return;
      }
      const attached = {
        binding: connection.binding,
        fingerprint: desired.fingerprint,
        connection,
        publicationBaseline,
      } satisfies AttachedResidentBinding;
      this.attachedBindings.set(slot, attached);
      this.scheduleProjectionReadinessCheck(attached);
    } catch {
      // Attachment and retirement failures poison only this exact authority.
      // A later readiness poll may retry it without disturbing other slots.
      if (connection) {
        const attached = this.attachedBindings.get(slot);
        if (attached?.connection === connection) {
          this.attachedBindings.delete(slot);
          if (this.preparedBindings.get(slot) === attached) this.preparedBindings.delete(slot);
        }
        await connection.detach().catch(() => undefined);
      }
    }
  }

  private retireAttachedBinding(slot: string, expected?: AttachedResidentBinding): void {
    const attached = this.attachedBindings.get(slot);
    if (!attached || (expected && attached !== expected)) return;
    this.attachedBindings.delete(slot);
    if (this.preparedBindings.get(slot) === attached) this.preparedBindings.delete(slot);
    const previous = this.bindingRetirementJobs.get(slot);
    const retirement = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => attached.connection.detach());
    this.bindingRetirementJobs.set(slot, retirement);
    retirement.then(
      () => {
        if (this.bindingRetirementJobs.get(slot) === retirement) {
          this.bindingRetirementJobs.delete(slot);
        }
      },
      () => {
        if (this.bindingRetirementJobs.get(slot) === retirement) {
          this.bindingRetirementJobs.delete(slot);
        }
      },
    );
  }

  private scheduleProjectionReadinessCheck(attached: AttachedResidentBinding): void {
    if (this.closed) return;
    const slot = residentBindingSlotKeyFor(attached.binding);
    if (
      this.preparedBindings.get(slot) === attached ||
      this.bindingProjectionJobs.has(slot) ||
      (this.bindingPublicationRevisions.get(slot) ?? 0) <= attached.publicationBaseline
    ) {
      return;
    }
    const promise = this.store.hasExactResidentProjection(attached.binding).then((projected) => {
      if (projected) this.promoteAttachedBinding(attached.binding);
    });
    const job = Object.freeze({ attached, promise });
    this.bindingProjectionJobs.set(slot, job);
    promise.then(
      () => this.finishProjectionReadinessCheck(slot, job),
      () => this.finishProjectionReadinessCheck(slot, job),
    );
  }

  private finishProjectionReadinessCheck(slot: string, job: ResidentBindingProjectionJob): void {
    if (this.bindingProjectionJobs.get(slot) !== job) return;
    this.bindingProjectionJobs.delete(slot);
    const current = this.attachedBindings.get(slot);
    if (current && current !== job.attached) this.scheduleProjectionReadinessCheck(current);
  }

  private promoteAttachedBinding(binding: ResidentSessionBinding): void {
    if (this.closed) return;
    const slot = residentBindingSlotKeyFor(binding);
    const fingerprint = residentDispatchAuthorityFingerprint(binding);
    const attached = this.attachedBindings.get(slot);
    if (
      !attached ||
      attached.fingerprint !== fingerprint ||
      !this.isDesiredBinding(slot, fingerprint) ||
      (this.bindingPublicationRevisions.get(slot) ?? 0) <= attached.publicationBaseline
    ) {
      return;
    }
    this.preparedBindings.set(slot, attached);
    this.schedulePromptReconciliationDiscovery();
    this.scheduleAbortReconciliationDiscovery();
  }

  private isDesiredBinding(slot: string, fingerprint: string): boolean {
    return this.desiredBindings.get(slot)?.fingerprint === fingerprint;
  }

  private isPreparedBinding(binding: ResidentSessionBinding): boolean {
    const prepared = this.preparedBindings.get(residentBindingSlotKeyFor(binding));
    return prepared?.fingerprint === residentDispatchAuthorityFingerprint(binding);
  }

  private hasPreparedBinding(): boolean {
    for (const [slot, prepared] of this.preparedBindings) {
      if (this.desiredBindings.get(slot)?.fingerprint === prepared.fingerprint) return true;
    }
    return false;
  }

  private async isCurrentBinding(binding: ResidentSessionBinding): Promise<boolean> {
    const current = await this.store.getResidentSessionBinding(
      binding.threadId,
      binding.executionGenerationId,
    );
    return current !== undefined &&
      residentDispatchAuthorityFingerprint(current) === residentDispatchAuthorityFingerprint(binding);
  }

  private schedulePromptReconciliationDiscovery(): void {
    if (
      this.closed ||
      !this.adapter ||
      !this.hasPreparedBinding() ||
      this.promptReconciliationDiscovery
    ) {
      return;
    }
    const discovery = this.store.listResidentPromptReconciliationLeases().then((leases) => {
      if (this.closed) return;
      for (const lease of leases) this.scheduleResidentPromptReconciliation(lease);
    });
    this.promptReconciliationDiscovery = discovery;
    discovery.then(
      () => {
        if (this.promptReconciliationDiscovery === discovery) {
          this.promptReconciliationDiscovery = undefined;
        }
      },
      () => {
        if (this.promptReconciliationDiscovery === discovery) {
          this.promptReconciliationDiscovery = undefined;
        }
      },
    );
  }

  private scheduleAbortReconciliationDiscovery(): void {
    if (
      this.closed ||
      !this.adapter ||
      !this.hasPreparedBinding() ||
      this.abortReconciliationDiscovery
    ) {
      return;
    }
    const discovery = this.store.listResidentAbortReconciliationLeases().then((leases) => {
      if (this.closed) return;
      for (const lease of leases) this.scheduleResidentAbortReconciliation(lease);
    });
    this.abortReconciliationDiscovery = discovery;
    discovery.then(
      () => {
        if (this.abortReconciliationDiscovery === discovery) {
          this.abortReconciliationDiscovery = undefined;
        }
      },
      () => {
        if (this.abortReconciliationDiscovery === discovery) {
          this.abortReconciliationDiscovery = undefined;
        }
      },
    );
  }

  private async reconcileResidentPrompt(lease: ResidentPromptReconciliationLease): Promise<void> {
    if (!(await this.credentialSecurityReady())) return;
    const adapter = this.adapter;
    if (this.closed || !adapter || !this.isPreparedBinding(lease.binding) || !(await this.isCurrentBinding(lease.binding))) {
      return;
    }
    const evidence = await adapter.reconcileAcknowledgedPromptIdle(lease);
    await this.assertCredentialSecurity(true);
    if (this.closed || !this.isPreparedBinding(lease.binding) || !(await this.isCurrentBinding(lease.binding))) return;
    const observation = await this.store.completeResidentPromptReconciliation(lease, evidence);
    if (this.closed) return;
    for (const listener of this.promptIdleListeners) {
      try {
        listener(observation);
      } catch {
        // The proof, receipt, and dedicated audit event are already durable.
        // One advisory listener cannot roll them back or suppress another.
      }
    }
    if (this.closed) return;
    const trailingChange = Object.freeze({
      threadId: observation.command.threadId,
      executionGenerationId: observation.command.expectedExecutionGenerationId,
    });
    for (const listener of this.projectionListeners) {
      try {
        listener(trailingChange);
      } catch {
        // The trailing invalidation is advisory; the receipt, proof event, and
        // ownership removal are already durable and reconnect-safe.
      }
    }
  }

  private async reconcileResidentAbort(lease: ResidentAbortReconciliationLease): Promise<void> {
    if (!(await this.credentialSecurityReady())) return;
    const adapter = this.adapter;
    if (this.closed || !adapter || !this.isPreparedBinding(lease.binding) || !(await this.isCurrentBinding(lease.binding))) {
      return;
    }
    const evidence = await adapter.reconcileAcknowledgedAbortIdle(lease);
    await this.assertCredentialSecurity(true);
    if (this.closed || !this.isPreparedBinding(lease.binding) || !(await this.isCurrentBinding(lease.binding))) return;
    // Store alone may replace a lagging active view at the same upstream
    // cursor, and only under this exact branded acknowledged-Stop lease.
    await this.store.publishResidentProjectionSnapshot(lease.binding, evidence.projection, lease);
    if (this.closed) return;
    const observation = await this.store.completeResidentAbortReconciliation(lease, evidence);
    if (this.closed) return;
    for (const listener of this.abortIdleListeners) {
      try {
        listener(observation);
      } catch {
        // The proof, receipt, projection, and audit event are already durable.
      }
    }
    if (this.closed) return;
    const trailingChange = Object.freeze({
      threadId: observation.command.threadId,
      executionGenerationId: observation.command.expectedExecutionGenerationId,
    });
    for (const listener of this.projectionListeners) {
      try {
        listener(trailingChange);
      } catch {
        // The trailing invalidation is advisory and follows durable proof.
      }
    }
  }

  private async createAdapter(): Promise<ResidentGatewayAdapter> {
    await this.assertCredentialSecurity();
    const handle = await this.runtimeHandles.acquireVerifiedRuntimeHandle();
    const daemonWorkingDirectory = residentDaemonWorkingDirectory(this.store.paths.root);
    const socketPath = residentDaemonEndpoint(this.store.paths.root, this.platform);
    await ensurePrivateRuntimeDirectory(daemonWorkingDirectory);
    if (this.platform !== "win32") await ensurePrivateRuntimeDirectory(dirname(socketPath));
    if (this.closed) throw new GatewayError("GATEWAY_CLOSED", "The resident gateway closed during runtime verification");

    const moduleLoader = this.moduleLoaderFactory(handle);
    const closeableModuleLoader = isCloseableResidentModuleLoader(moduleLoader) ? moduleLoader : undefined;
    let adapter: ResidentGatewayAdapter;
    try {
      // A structurally valid adapter is not proof that its isolated Worker can
      // import the freshly verified runtime modules. Cross this asynchronous
      // boundary before lifecycle readiness can be advertised; the adapter
      // retains this exact loader, whose Worker promise is cached, so later
      // operations cannot observe a different module load outcome.
      await moduleLoader();
      await this.assertCredentialSecurity(true);
      if (this.closed) {
        throw new GatewayError(
          "GATEWAY_CLOSED",
          "The resident gateway closed during its runtime module preflight",
        );
      }
      adapter = this.adapterFactory({
        executable: handle.executable,
        cliEntrypoint: handle.cliEntrypoint,
        socketPath,
        daemonWorkingDirectory,
        environment: this.environment,
        loadRuntimeModule: moduleLoader,
        persistBinding: async (binding) => {
          await this.assertCredentialSecurity(true);
          await this.store.persistResidentSessionBinding(binding);
        },
        authorizeResidentKillInvocation: async (lease) => {
          await this.assertCredentialSecurity(true);
          return this.store.authorizeResidentKillInvocation(lease);
        },
        publishProjection: async (binding, projection) => {
          await this.assertCredentialSecurity();
          if (this.closed || !(await this.isCurrentBinding(binding))) return;
          await this.store.publishResidentProjectionSnapshot(binding, projection);
          if (this.closed || !(await this.isCurrentBinding(binding))) return;
          this.publishProjectionChange(binding);
        },
        publishModelSelectionProjection: async (command, binding, projection) => {
          await this.assertCredentialSecurity(true);
          if (this.closed || !(await this.isCurrentBinding(binding))) {
            throw new GatewayError(
              "MODEL_SELECTION_SESSION_AUTHORITY_CHANGED",
              "The exact resident session authority changed before its proven model projection could be published",
            );
          }
          await this.store.publishResidentModelSelectionProjection(command, binding, projection);
          if (this.closed || !(await this.isCurrentBinding(binding))) return;
          this.publishProjectionChange(binding);
        },
      });
    } catch (error) {
      await closeableModuleLoader?.close().catch(() => undefined);
      throw error;
    }
    if (this.closed) {
      await adapter.close().catch(() => undefined);
      await closeableModuleLoader?.close().catch(() => undefined);
      throw new GatewayError("GATEWAY_CLOSED", "The resident gateway closed while its adapter was starting");
    }
    this.runtimeModuleLoader = closeableModuleLoader;
    return adapter;
  }

  private publishProjectionChange(binding: ResidentSessionBinding): void {
    const slot = residentBindingSlotKeyFor(binding);
    this.bindingPublicationRevisions.set(
      slot,
      (this.bindingPublicationRevisions.get(slot) ?? 0) + 1,
    );
    const attached = this.attachedBindings.get(slot);
    if (attached) this.scheduleProjectionReadinessCheck(attached);
    const change = Object.freeze({
      threadId: binding.threadId,
      executionGenerationId: binding.executionGenerationId,
    });
    for (const listener of this.projectionListeners) {
      try {
        listener(change);
      } catch {
        // Projection publication is already durable. One observer cannot roll
        // it back or prevent another connection from refreshing.
      }
    }
  }
}

export function residentDaemonWorkingDirectory(canonicalDataDirectory: string): string {
  return join(resolve(canonicalDataDirectory), "resident-daemon");
}

export function residentDaemonEndpoint(
  canonicalDataDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const root = resolve(canonicalDataDirectory);
  const identity = createHash("sha256")
    .update(platform === "win32" ? root.toLowerCase() : root)
    .digest("hex")
    .slice(0, 16);
  if (platform === "win32") {
    return `\\\\.\\pipe\\prime-continuim-resident-${identity}`;
  }
  // Unix sockaddr paths are commonly limited to roughly 108 bytes. Keep the
  // endpoint short while namespacing it to the canonical data root; its parent
  // is separately verified as a private, process-owned directory.
  const endpoint = join(resolve(tmpdir()), `pc-${identity}`, "d.sock");
  if (Buffer.byteLength(endpoint, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("Resident daemon endpoint exceeds the Unix socket path limit");
  }
  return endpoint;
}

/**
 * Keep Prime Agent's public transport objects and their dependency-side
 * process mutations inside a bounded Worker. The host retains authority over
 * the freshly verified module URL and loads no upstream runtime code itself.
 */
export function createVerifiedResidentModuleLoader(
  handle: VerifiedInstalledRuntimeHandle,
): PrimeAgentResidentWorkerModuleLoader {
  return createPrimeAgentResidentWorkerModuleLoader(handle);
}

async function ensurePrivateRuntimeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("Resident daemon working directory is not a private directory");
  }
  if (process.platform !== "win32") {
    if ((entry.mode & 0o077) !== 0) {
      throw new Error("Resident daemon working directory permissions are too broad");
    }
    if (typeof process.getuid === "function" && entry.uid !== process.getuid()) {
      throw new Error("Resident daemon working directory is owned by another user");
    }
  }
  const physical = await realpath(path);
  if (!samePath(physical, path)) {
    throw new Error("Resident daemon working directory changed physical identity");
  }
}

function isDefinitivelyUnavailableResident(error: unknown): boolean {
  return error instanceof ResidentRuntimeContractError && (
    error.code === "PRIME_RUNTIME_SESSION_NOT_FOUND" ||
    error.code === "PRIME_RUNTIME_UNAVAILABLE" ||
    error.code === "PRIME_RUNTIME_ADAPTER_CLOSED"
  );
}

function isCloseableResidentModuleLoader(
  loader: PrimeAgentPublicModuleLoader,
): loader is PrimeAgentResidentWorkerModuleLoader {
  return typeof (loader as PrimeAgentPublicModuleLoader & { close?: unknown }).close === "function";
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function residentBindingSlotKeyFor(binding: ResidentSessionBinding): string {
  return residentBindingSlotKey(binding.threadId, binding.executionGenerationId);
}

function residentBindingSlotKey(threadId: string, executionGenerationId: string): string {
  return JSON.stringify([threadId, executionGenerationId]);
}

function dispatchBindingFor(
  command: CommandEnvelope,
  context: GatewayDispatchContext | undefined,
  preparedBindings: ReadonlyMap<string, AttachedResidentBinding>,
): ResidentSessionBinding | undefined {
  const contextual = command.command.kind === "prompt" || command.command.kind === "abort"
    ? context?.residentDispatch?.binding
    : command.command.kind === "model.select"
      ? context?.residentBinding
      : context?.residentDispatch?.binding ?? context?.residentBinding;
  const binding = contextual ?? preparedBindings.get(
    residentBindingSlotKey(command.threadId, command.expectedExecutionGenerationId),
  )?.binding;
  if (
    !binding ||
    binding.threadId !== command.threadId ||
    binding.executionGenerationId !== command.expectedExecutionGenerationId
  ) {
    return undefined;
  }
  return binding;
}
