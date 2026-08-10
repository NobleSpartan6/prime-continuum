import { createHash, randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  CANDIDATE_EVALUATION_PROBE_CAPABILITY,
  HostIpcRequestSchema,
  HostIpcResponseSchema,
  PRIME_AGENT_COMMAND_CAPABILITY,
  PROTOCOL_VERSION,
  RESIDENT_CONTROL_PROJECTION_CAPABILITY,
  RESIDENT_LIFECYCLE_CAPABILITY,
  RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY,
  ResidentLifecycleStatusSchema,
  SavedProjectSchema,
  RUNTIME_INTEGRITY_CAPABILITY,
  RUNTIME_INTEGRITY_REPAIR_CAPABILITY,
  RUNTIME_INTEGRITY_RETRY_CAPABILITY,
  RuntimeIntegritySnapshotSchema,
  RUNTIME_MODEL_CATALOG_CAPABILITY,
  RUNTIME_OAUTH_CAPABILITY,
  ThreadProjectionSnapshotSchema,
  ThreadSummarySchema,
  type HostIpcRequest,
  type HostIpcResponse,
  type HostIdentityReadiness,
  type RemoteDeviceScope,
  type RuntimeIntegritySnapshot,
  type StructuredError,
} from "../shared/protocol";
import {
  CandidateEvaluationCoordinatorError,
  type CandidateEvaluationCoordinator,
} from "./candidate-evaluation";
import {
  GatewayError,
  type PrimeAgentGateway,
  type PrimeAgentProjectionChange,
  UnavailablePrimeAgentGateway,
} from "./gateway";
import {
  PairingAuthority,
  PairingAuthorityError,
  HostIdentityInputSchema,
  type AuthenticatedChannelLease,
} from "./pairing/authority";
import {
  UnavailableHostIdentityKeyProvider,
  type HostIdentityKeyProvider,
  type HostIdentityProviderLoadResult,
} from "./pairing/host-identity-provider";
import { HOSTD_VERSION } from "./paths";
import {
  HostOAuthSessionBroker,
  OAuthBrokerError,
  type HostOAuthComposition,
} from "./oauth-session-broker";
import {
  HostStore,
  HostStoreError,
  type ResidentAbortIdleObservedEvent,
  type ResidentPromptIdleObservedEvent,
} from "./store";
import type { RuntimeModelCatalogProvider } from "./runtime-model-catalog";
import {
  ResidentProvisionCoordinatorError,
  residentProvisionRequestDigest,
  type ResidentEndRequest as CoordinatorResidentEndRequest,
  type ResidentProvisionRequest as CoordinatorResidentProvisionRequest,
} from "./resident-lifecycle-coordinator";

// The durable store contains a single-process handoff harness for protocol and
// rollback testing. Production hostd must not advertise executable handoff
// until a destination transport/coordinator can materialize and verify state on
// the destination host itself.
export const HOST_CAPABILITIES = ["snapshot_chunks_v1", RESIDENT_CONTROL_PROJECTION_CAPABILITY] as const;

const HANDOFF_COORDINATOR_WARNING = {
  code: "DESTINATION_TRANSFER_UNAVAILABLE",
  message: "Cross-host checkpoint transfer is deferred until the Phase 2 destination coordinator is installed.",
  blocking: true,
} as const;

const KNOWN_METHODS = new Set([
  "health.get",
  "runtime.integrity.retry",
  "runtime.integrity.repair",
  "runtime.model_catalog",
  "oauth.session.start",
  "oauth.session.status",
  "oauth.session.cancel",
  "catalog.snapshot",
  "thread.snapshot",
  "thread.control.snapshot",
  "command.submit",
  "command.reconcile",
  "resident.provision",
  "resident.provision.registered",
  "resident.end",
  "resident.lifecycle.status",
  "candidate.evaluation.preflight",
  "candidate.evaluation.start",
  "candidate.evaluation.snapshot",
  "handoff.plan",
  "handoff.commit",
]);

export type HostSessionContext =
  | { transport: "trusted_user"; scopes: "*" }
  | { transport: "ssh_bridge"; scopes: "*" }
  | {
      transport: "relay";
      channel: AuthenticatedChannelLease;
    };

export const TRUSTED_USER_SESSION: HostSessionContext = Object.freeze({
  transport: "trusted_user",
  scopes: "*",
});
export const SSH_BRIDGE_SESSION: HostSessionContext = Object.freeze({
  transport: "ssh_bridge",
  scopes: "*",
});

const DEFAULT_IDENTITY_LOAD_TIMEOUT_MS = 5_000;
const PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID = "openai-codex";

export interface HostServiceOptions {
  hostIdentityProvider?: HostIdentityKeyProvider;
  identityLoadTimeoutMs?: number;
  runtimeIntegrityProvider?: RuntimeIntegrityReadinessProvider;
  runtimeModelCatalogProvider?: RuntimeModelCatalogProvider;
  runtimeOAuthComposition?: HostOAuthComposition;
  candidateEvaluationCoordinator?: CandidateEvaluationCoordinator;
}

export interface RuntimeIntegrityReadinessProvider {
  /** Returns the latest bounded snapshot synchronously without performing integrity work. */
  snapshot(): RuntimeIntegritySnapshot;
  /** Begins one bounded retry only when the current ownership generation permits it. */
  retry?(): boolean;
  /** Reports whether this exact failed generation can enter scoped repair. */
  repairAvailable?(): boolean;
  /** Begins one scoped repair after HostService proves resident quiescence. */
  repair?(): boolean;
  /** Settles any background integrity work before endpoint ownership is released. */
  close?(): Promise<void>;
}

type ResidentLifecycleGateway = PrimeAgentGateway & {
  residentLifecycleCapabilityReady(): Promise<boolean>;
  provisionResident(request: CoordinatorResidentProvisionRequest): Promise<unknown>;
  endResident(request: CoordinatorResidentEndRequest): Promise<unknown>;
};

type ResidentProvisionProtocolPayload = Extract<
  HostIpcRequest,
  { method: "resident.provision" }
>["payload"];

export class HostService {
  readonly store: HostStore;
  readonly gateway: PrimeAgentGateway;
  readonly pairingAuthority: PairingAuthority;
  readonly hostIdentityProvider: HostIdentityKeyProvider;
  private closePromise: Promise<void> | undefined;
  private readonly identityLoadTimeoutMs: number;
  private readonly runtimeIntegrityProvider: RuntimeIntegrityReadinessProvider | undefined;
  private readonly runtimeModelCatalogProvider: RuntimeModelCatalogProvider | undefined;
  private readonly runtimeOAuthComposition: HostOAuthComposition | undefined;
  private readonly candidateEvaluationCoordinator: CandidateEvaluationCoordinator | undefined;
  private candidateEvaluationInitializationPromise: Promise<void> | undefined;
  private readonly projectionChangeListeners = new Set<(change: PrimeAgentProjectionChange) => void>();
  private readonly promptIdleListeners = new Set<(event: ResidentPromptIdleObservedEvent) => void>();
  private readonly abortIdleListeners = new Set<(event: ResidentAbortIdleObservedEvent) => void>();
  private readonly unsubscribeGatewayProjection: () => void;
  private readonly unsubscribeGatewayPromptIdle: () => void;
  private readonly unsubscribeGatewayAbortIdle: () => void;
  private oauthSessionBroker: HostOAuthSessionBroker | undefined;
  private oauthInitializationPromise: Promise<void> | undefined;
  private closing = false;
  private hostIdentityProviderUsed = false;
  private pairingIdentity: HostIdentityReadiness = Object.freeze({ state: "not_configured" });
  readonly startedAt = new Date().toISOString();

  constructor(
    store: HostStore,
    gateway: PrimeAgentGateway = new UnavailablePrimeAgentGateway(),
    pairingAuthority: PairingAuthority = new PairingAuthority(store.paths.pairingAuthority),
    options: HostServiceOptions = {},
  ) {
    this.store = store;
    this.gateway = gateway;
    this.pairingAuthority = pairingAuthority;
    this.hostIdentityProvider = options.hostIdentityProvider ?? new UnavailableHostIdentityKeyProvider();
    this.identityLoadTimeoutMs = options.identityLoadTimeoutMs ?? DEFAULT_IDENTITY_LOAD_TIMEOUT_MS;
    this.runtimeIntegrityProvider = options.runtimeIntegrityProvider;
    this.runtimeModelCatalogProvider = options.runtimeModelCatalogProvider;
    this.runtimeOAuthComposition = options.runtimeOAuthComposition;
    this.candidateEvaluationCoordinator = options.candidateEvaluationCoordinator;
    this.unsubscribeGatewayProjection = this.gateway.subscribeProjectionChanges?.((change) => {
      for (const listener of this.projectionChangeListeners) {
        try {
          listener(change);
        } catch {
          // Notifications are advisory; the durable projection remains the
          // source of truth and other sessions must still be notified.
        }
      }
    }) ?? (() => undefined);
    this.unsubscribeGatewayPromptIdle = this.gateway.subscribeResidentPromptIdleObserved?.((event) => {
      for (const listener of this.promptIdleListeners) {
        try {
          listener(event);
        } catch {
          // The proof-backed completion is already durable. Continue notifying
          // the other local framed sessions.
        }
      }
    }) ?? (() => undefined);
    this.unsubscribeGatewayAbortIdle = this.gateway.subscribeResidentAbortIdleObserved?.((event) => {
      for (const listener of this.abortIdleListeners) {
        try {
          listener(event);
        } catch {
          // The proof-backed completion is already durable. Continue notifying
          // the other local framed sessions.
        }
      }
    }) ?? (() => undefined);
    if (!Number.isSafeInteger(this.identityLoadTimeoutMs) || this.identityLoadTimeoutMs < 10 || this.identityLoadTimeoutMs > 30_000) {
      throw new TypeError("Identity load timeout must be an integer from 10 to 30000 milliseconds");
    }
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    const host = await this.store.getHost();
    this.startRuntimeOAuthInitialization(host.hostId);
    const authority = await this.pairingAuthority.initialize({ hostId: host.hostId });
    this.pairingIdentity = authority.identity
      ? await this.loadConfiguredHostIdentity(host.hostId, authority.identity)
      : Object.freeze({ state: "not_configured" });
    this.startCandidateEvaluationInitialization();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      // Optional OAuth custody verification warms in parallel with core host
      // startup. Join that bounded work before closing its composition so a
      // late completion can never publish a broker after shutdown begins.
      await this.oauthInitializationPromise;
      // OAuth helpers can hold freshly verified runtime handles. Revoke and
      // drain them before the integrity coordinator releases that authority.
      // If helper exit cannot be positively observed, fail closed here and do
      // not release any of the verified runtime ownership below.
      await this.oauthSessionBroker?.close();
      // Broker close waits for each abort-triggered login run. Only afterwards
      // can the composition surface a helper termination failure latched by
      // that run; starting these two closes concurrently would race the latch.
      await this.runtimeOAuthComposition?.close?.();
      // Candidate recovery is optional for serving core health and resident
      // work, but its bounded reconciliation can still own poll timers and
      // process observations. Join it before closing the coordinator.
      await this.candidateEvaluationInitializationPromise;
      await this.candidateEvaluationCoordinator?.close();
      this.unsubscribeGatewayProjection();
      this.unsubscribeGatewayPromptIdle();
      this.unsubscribeGatewayAbortIdle();
      this.projectionChangeListeners.clear();
      this.promptIdleListeners.clear();
      this.abortIdleListeners.clear();
      // Resident adapters can still hold verified runtime objects and daemon
      // requests. Drain them before releasing the integrity authority that
      // proved those exact files.
      await this.gateway.close();
      const closeResults = await Promise.allSettled([
        Promise.resolve().then(() => this.runtimeIntegrityProvider?.close?.()),
        Promise.resolve().then(() => this.pairingAuthority.close()),
        Promise.resolve().then(() => (this.hostIdentityProviderUsed ? this.hostIdentityProvider.close() : undefined)),
      ]);
      const failures = closeResults
        .flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (failures.length > 0) {
        throw new AggregateError(failures, "One or more host service resources failed to close");
      }
    })();
    return this.closePromise;
  }

  private startRuntimeOAuthInitialization(hostId: string): void {
    if (
      !this.runtimeOAuthComposition ||
      this.oauthSessionBroker ||
      this.oauthInitializationPromise ||
      this.closing
    ) return;
    const composition = this.runtimeOAuthComposition;
    this.oauthInitializationPromise = (async () => {
      try {
        await composition.initialize?.();
        if (this.closing) return;
        this.oauthSessionBroker = new HostOAuthSessionBroker({
          hostId,
          providers: composition,
          storage: composition,
        });
      } catch {
        // Cached host/thread projections remain readable, but the same sticky
        // custody guard also withholds OAuth, catalog, and resident execution.
        this.oauthSessionBroker = undefined;
      }
    })();
  }

  private startCandidateEvaluationInitialization(): void {
    if (
      !this.candidateEvaluationCoordinator ||
      this.candidateEvaluationInitializationPromise ||
      this.closing
    ) return;
    const coordinator = this.candidateEvaluationCoordinator;
    this.candidateEvaluationInitializationPromise = (async () => {
      try {
        await coordinator.initialize();
      } catch {
        // Candidate evaluation is an optional capability. Its coordinator
        // remains fail-closed while core host and resident surfaces stay live.
      }
    })();
  }

  subscribeProjectionChanges(listener: (change: PrimeAgentProjectionChange) => void): () => void {
    this.projectionChangeListeners.add(listener);
    return () => this.projectionChangeListeners.delete(listener);
  }

  subscribeResidentPromptIdleObserved(
    listener: (event: ResidentPromptIdleObservedEvent) => void,
  ): () => void {
    this.promptIdleListeners.add(listener);
    return () => this.promptIdleListeners.delete(listener);
  }

  subscribeResidentAbortIdleObserved(
    listener: (event: ResidentAbortIdleObservedEvent) => void,
  ): () => void {
    this.abortIdleListeners.add(listener);
    return () => this.abortIdleListeners.delete(listener);
  }

  async handle(value: unknown, context: HostSessionContext): Promise<HostIpcResponse> {
    const parsed = HostIpcRequestSchema.safeParse(value);
    if (!parsed.success) return invalidRequestResponse(value, parsed.error);
    const request = parsed.data;

    try {
      if (!context) {
        throw new HostStoreError(
          "SESSION_CONTEXT_REQUIRED",
          "Every host protocol request must identify its authenticated transport context.",
        );
      }
      const result = await this.authorizeAndDispatch(request, context);
      return HostIpcResponseSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: request.method,
        ok: true,
        result,
      });
    } catch (error) {
      return HostIpcResponseSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: request.method,
        ok: false,
        error: toStructuredError(error),
      });
    }
  }

  private async authorizeAndDispatch(request: HostIpcRequest, context: HostSessionContext): Promise<unknown> {
    if (
      (request.method === "runtime.integrity.retry" || request.method === "runtime.integrity.repair") &&
      context.transport !== "trusted_user"
    ) {
      throw new PairingAuthorityError(
        request.method === "runtime.integrity.repair"
          ? "REMOTE_RUNTIME_INTEGRITY_REPAIR_FORBIDDEN"
          : "REMOTE_RUNTIME_INTEGRITY_RETRY_FORBIDDEN",
        request.method === "runtime.integrity.repair"
          ? "Runtime repair can be started only by the trusted local desktop"
          : "Runtime verification can be retried only by the trusted local desktop",
      );
    }
    if (request.method === "resident.provision" && context.transport !== "trusted_user") {
      throw new PairingAuthorityError(
        "REMOTE_RESIDENT_LIFECYCLE_FORBIDDEN",
        "Resident session lifecycle operations are available only to the trusted local desktop",
      );
    }
    if (isRegisteredWorkspaceLifecycleRequest(request) && context.transport === "relay") {
      throw new PairingAuthorityError(
        "REMOTE_RESIDENT_LIFECYCLE_FORBIDDEN",
        "Registered workspace lifecycle operations are available only to the trusted desktop or SSH bridge",
      );
    }
    if (isCandidateEvaluationRequest(request) && context.transport !== "trusted_user") {
      throw new PairingAuthorityError(
        "REMOTE_CANDIDATE_EVALUATION_FORBIDDEN",
        "Candidate evaluation is available only to the trusted local desktop",
      );
    }
    if (context.transport === "trusted_user") return this.dispatch(request, context);
    if (isOAuthRequest(request)) {
      throw new PairingAuthorityError(
        "REMOTE_OAUTH_FORBIDDEN",
        "Provider sign-in is available only to the trusted desktop on the provider host",
      );
    }
    if (context.transport === "ssh_bridge") return this.dispatch(request, context);
    if (this.pairingIdentity.state !== "ready") {
      throw new PairingAuthorityError(
        "REMOTE_IDENTITY_UNAVAILABLE",
        "Relay requests remain disabled until the configured host identity is verified by its custody provider",
      );
    }

    const requiredScope = scopeForRequest(request);
    return this.pairingAuthority.withAuthorizedChannel(context.channel, requiredScope, async (device) => {
      this.assertRelayRequestIdentity(request, device.deviceId);
      // Admission is linearized under the authority lock; dispatch runs after
      // the lock is released so revocation can commit while admitted work ends.
      return this.dispatch(request, context);
    });
  }

  private assertRelayRequestIdentity(request: HostIpcRequest, authenticatedDeviceId: string): void {
    if (request.method === "command.submit" && request.payload.command.deviceId !== authenticatedDeviceId) {
      throw new HostStoreError(
        "REMOTE_DEVICE_IDENTITY_MISMATCH",
        "The authenticated device cannot submit a command under another device identity.",
      );
    }
    if (
      request.method === "command.reconcile" &&
      request.payload.commands.some((command) => command.deviceId !== authenticatedDeviceId)
    ) {
      throw new HostStoreError(
        "REMOTE_DEVICE_IDENTITY_MISMATCH",
        "The authenticated device cannot reconcile another device's command identities.",
      );
    }
    if (request.method === "handoff.commit" && request.payload.deviceId !== authenticatedDeviceId) {
      throw new HostStoreError(
        "REMOTE_DEVICE_IDENTITY_MISMATCH",
        "The authenticated device cannot commit a handoff under another device identity.",
      );
    }
  }

  private async dispatch(request: HostIpcRequest, context: HostSessionContext): Promise<unknown> {
    switch (request.method) {
      case "health.get": {
        const host = await this.store.getHost();
        const runtimeIntegrity = this.runtimeIntegrityProvider?.snapshot();
        let residentGatewayReady = this.gateway.continuity === "resident";
        if (
          residentGatewayReady &&
          (runtimeIntegrity === undefined || runtimeIntegrity.status === "ready") &&
          this.gateway.capabilityReady
        ) {
          try {
            residentGatewayReady = await this.gateway.capabilityReady();
          } catch {
            residentGatewayReady = false;
          }
        }
        const executionCapabilities = this.gateway.continuity === "resident" &&
          residentGatewayReady &&
          (runtimeIntegrity === undefined || runtimeIntegrity.status === "ready")
          ? [PRIME_AGENT_COMMAND_CAPABILITY]
          : [];
        let residentLifecycleReady = false;
        if (
          (context.transport === "trusted_user" || context.transport === "ssh_bridge") &&
          this.gateway.continuity === "resident" &&
          (runtimeIntegrity === undefined || runtimeIntegrity.status === "ready") &&
          isResidentLifecycleGateway(this.gateway)
        ) {
          try {
            residentLifecycleReady = await this.gateway.residentLifecycleCapabilityReady();
          } catch {
            residentLifecycleReady = false;
          }
        }
        const residentLifecycleCapabilities = residentLifecycleReady
          ? context.transport === "ssh_bridge"
            ? [RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY]
            : [RESIDENT_LIFECYCLE_CAPABILITY]
          : [];
        let modelCatalogReady = Boolean(this.runtimeModelCatalogProvider) &&
          (runtimeIntegrity === undefined || runtimeIntegrity.status === "ready");
        if (modelCatalogReady && this.runtimeModelCatalogProvider?.capabilityReady) {
          try {
            modelCatalogReady = await this.runtimeModelCatalogProvider.capabilityReady();
          } catch {
            modelCatalogReady = false;
          }
        }
        const modelCatalogCapabilities = modelCatalogReady
          ? [RUNTIME_MODEL_CATALOG_CAPABILITY]
          : [];
        const oauthCapabilities = context.transport === "trusted_user" && this.oauthSessionBroker &&
          this.runtimeOAuthComposition?.getProvider(PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID) &&
          (runtimeIntegrity === undefined || runtimeIntegrity.status === "ready")
          ? [RUNTIME_OAUTH_CAPABILITY]
          : [];
        const runtimeIntegrityRetryCapabilities = context.transport === "trusted_user" &&
          runtimeIntegrity?.status === "failed" &&
          runtimeIntegrity.retryable &&
          typeof this.runtimeIntegrityProvider?.retry === "function"
          ? [RUNTIME_INTEGRITY_RETRY_CAPABILITY]
          : [];
        let runtimeIntegrityRepairReady = context.transport === "trusted_user" &&
          runtimeIntegrity?.status === "failed" &&
          !runtimeIntegrity.retryable &&
          typeof this.runtimeIntegrityProvider?.repairAvailable === "function" &&
          typeof this.runtimeIntegrityProvider?.repair === "function" &&
          this.runtimeIntegrityProvider.repairAvailable();
        if (runtimeIntegrityRepairReady) {
          try {
            await this.store.assertRuntimeRepairQuiescent();
          } catch {
            runtimeIntegrityRepairReady = false;
          }
        }
        const runtimeIntegrityRepairCapabilities = runtimeIntegrityRepairReady
          ? [RUNTIME_INTEGRITY_REPAIR_CAPABILITY]
          : [];
        const candidateEvaluationCapabilities = context.transport === "trusted_user" &&
          runtimeIntegrity?.status === "ready" &&
          this.candidateEvaluationCoordinator?.capabilityReady()
          ? [CANDIDATE_EVALUATION_PROBE_CAPABILITY]
          : [];
        return {
          protocolVersion: PROTOCOL_VERSION,
          hostdVersion: HOSTD_VERSION,
          startedAt: this.startedAt,
          checkedAt: new Date().toISOString(),
          serviceState: runtimeIntegrity === undefined ? "ready" : serviceStateForRuntimeIntegrity(runtimeIntegrity),
          host,
          capabilities: runtimeIntegrity === undefined
            ? [
                ...HOST_CAPABILITIES,
                ...executionCapabilities,
                ...residentLifecycleCapabilities,
                ...modelCatalogCapabilities,
                ...oauthCapabilities,
                ...runtimeIntegrityRetryCapabilities,
                ...runtimeIntegrityRepairCapabilities,
                ...candidateEvaluationCapabilities,
              ]
            : [
                ...HOST_CAPABILITIES,
                ...executionCapabilities,
                ...residentLifecycleCapabilities,
                ...modelCatalogCapabilities,
                ...oauthCapabilities,
                RUNTIME_INTEGRITY_CAPABILITY,
                ...runtimeIntegrityRetryCapabilities,
                ...runtimeIntegrityRepairCapabilities,
                ...candidateEvaluationCapabilities,
              ],
          pairingIdentity: this.pairingIdentity,
          ...(runtimeIntegrity === undefined ? {} : { runtimeIntegrity }),
        };
      }
      case "runtime.integrity.retry": {
        const host = await this.store.getHost();
        if (request.payload.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "Runtime verification was requested from a different host authority.",
          );
        }
        const provider = this.runtimeIntegrityProvider;
        const current = provider?.snapshot();
        if (
          !provider ||
          typeof provider.retry !== "function" ||
          current?.status !== "failed" ||
          !current.retryable
        ) {
          throw new HostStoreError(
            "RUNTIME_INTEGRITY_RETRY_UNAVAILABLE",
            "Runtime verification is not currently eligible for retry.",
          );
        }
        if (!provider.retry()) {
          throw new HostStoreError(
            "RUNTIME_INTEGRITY_RETRY_REJECTED",
            "Runtime verification could not start another attempt in this host generation.",
            true,
          );
        }
        const next = RuntimeIntegritySnapshotSchema.parse(provider.snapshot());
        if (next.status !== "initializing" || !sameRuntimeIntegrityLineage(current, next)) {
          throw new HostStoreError(
            "RUNTIME_INTEGRITY_RETRY_INVALID_STATE",
            "Runtime verification did not enter a valid retry attempt.",
          );
        }
        return next;
      }
      case "runtime.integrity.repair": {
        const host = await this.store.getHost();
        if (request.payload.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "Runtime repair was requested from a different host authority.",
          );
        }
        const provider = this.runtimeIntegrityProvider;
        const current = provider?.snapshot();
        if (
          !provider ||
          typeof provider.repairAvailable !== "function" ||
          typeof provider.repair !== "function" ||
          current?.status !== "failed" ||
          current.retryable ||
          !provider.repairAvailable()
        ) {
          throw new HostStoreError(
            "RUNTIME_INTEGRITY_REPAIR_UNAVAILABLE",
            "Runtime repair is not available for the current host generation.",
          );
        }
        if (
          request.payload.expectedTrustAnchorId !== current.trustAnchorId ||
          request.payload.expectedChangedAt !== current.changedAt ||
          !sameRuntimeIntegrityTarget(request.payload.expectedTarget, current.target)
        ) {
          throw new HostStoreError(
            "RUNTIME_INTEGRITY_REPAIR_AUTHORITY_CHANGED",
            "Runtime repair authority changed before the operation could start.",
            true,
          );
        }
        await this.store.assertRuntimeRepairQuiescent();
        if (!provider.repair()) {
          throw new HostStoreError(
            "RUNTIME_INTEGRITY_REPAIR_REJECTED",
            "Runtime repair could not start in this host generation.",
            true,
          );
        }
        const next = RuntimeIntegritySnapshotSchema.parse(provider.snapshot());
        if (next.status !== "initializing" || !sameRuntimeIntegrityLineage(current, next)) {
          throw new HostStoreError(
            "RUNTIME_INTEGRITY_REPAIR_INVALID_STATE",
            "Runtime repair did not enter a valid initialization attempt.",
          );
        }
        return next;
      }
      case "runtime.model_catalog": {
        const host = await this.store.getHost();
        if (request.payload.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "The model catalog was requested from a different host authority.",
          );
        }
        const runtimeIntegrity = this.runtimeIntegrityProvider?.snapshot();
        if (!this.runtimeModelCatalogProvider || (runtimeIntegrity && runtimeIntegrity.status !== "ready")) {
          throw new HostStoreError(
            "RUNTIME_MODEL_CATALOG_UNAVAILABLE",
            "The verified Prime Agent model catalog is not available on this host.",
          );
        }
        return this.runtimeModelCatalogProvider.read();
      }
      case "oauth.session.start": {
        const broker = await this.requireRuntimeOAuthBroker(request.payload.expectedHostId);
        const snapshot = await broker.start(request.payload);
        if (snapshot.phase === "completed") this.runtimeModelCatalogProvider?.invalidate?.();
        return snapshot;
      }
      case "oauth.session.status": {
        const broker = await this.requireRuntimeOAuthBroker(request.payload.expectedHostId);
        const snapshot = await broker.status(request.payload);
        if (snapshot.phase === "completed") this.runtimeModelCatalogProvider?.invalidate?.();
        return snapshot;
      }
      case "oauth.session.cancel": {
        const broker = await this.requireRuntimeOAuthBroker(request.payload.expectedHostId);
        return broker.cancel(request.payload);
      }
      case "candidate.evaluation.preflight": {
        return (await this.requireCandidateEvaluationCoordinator()).preflight(request.payload);
      }
      case "candidate.evaluation.start": {
        return (await this.requireCandidateEvaluationCoordinator()).start(request.payload);
      }
      case "candidate.evaluation.snapshot": {
        return (await this.requireCandidateEvaluationCoordinator()).snapshot(request.payload);
      }
      case "catalog.snapshot":
        return this.store.getCatalogSnapshot();
      case "thread.snapshot":
        // A Phase 0 attach always returns an authoritative atomic snapshot. A
        // later replay adapter may use the supplied generation-aware cursor.
        return this.store.getThreadSnapshot(request.payload.threadId);
      case "thread.control.snapshot":
        {
          const binding = await this.store.getResidentSessionBinding(
            request.payload.threadId,
            request.payload.expectedExecutionGenerationId,
          );
          let livePreparedBinding: typeof binding;
          if (
            binding &&
            this.gateway.continuity === "resident" &&
            this.gateway.isResidentBindingLive
          ) {
            try {
              if (await this.gateway.isResidentBindingLive(binding)) livePreparedBinding = binding;
            } catch {
              // Liveness is optional runtime evidence. A failed or unavailable
              // probe must degrade this read to lifecycle_transition, never
              // turn a read-only projection into a runtime failure or retry.
            }
          }
          return this.store.getResidentControlProjection(
            request.payload.expectedHostId,
            request.payload.threadId,
            request.payload.expectedExecutionGenerationId,
            livePreparedBinding,
          );
        }
      case "command.submit": {
        const command = request.payload.command;
        // Idempotency and command-key ownership precede every mutable
        // environmental observation. A known exact retry returns its original
        // receipt even if runtime/gateway state has since changed; a reused key
        // fails before `isLive` can obscure the durable identity conflict.
        const knownReceipt = await this.store.preflightKnownCommand(command);
        if (knownReceipt) return knownReceipt;
        const host = await this.store.getHost();
        if (command.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "The command was composed for a different host authority.",
          );
        }
        const runtimeIntegrity = this.gateway.continuity === "resident"
          ? this.runtimeIntegrityProvider?.snapshot()
          : undefined;
        const runtimeIntegrityRejection = runtimeIntegrity === undefined
          ? undefined
          : runtimeIntegrityAdmissionRejection(runtimeIntegrity);
        if (runtimeIntegrityRejection) {
          // Runtime readiness is host authority, not a client-side hint. Fail
          // closed before consulting or invoking a resident gateway so a stale
          // desktop capability observation cannot dispatch into a revoked
          // verified-runtime boundary.
          const admission = await this.store.admitCommand(command, false, runtimeIntegrityRejection);
          return admission.receipt;
        }
        let live = false;
        let liveCheckFailure: StructuredError | undefined;
        try {
          live = await this.gateway.isLive(command.threadId, command.expectedExecutionGenerationId);
        } catch (error) {
          liveCheckFailure = {
            code: command.command.kind === "model.select"
              ? "MODEL_SELECTION_LIVE_CHECK_FAILED"
              : "RESIDENT_SESSION_LIVE_CHECK_FAILED",
            message: "The resident Prime Agent session could not be verified as live",
            retryable: true,
          };
        }
        const residentCommandUnsupported = this.gateway.continuity === "resident" &&
          command.command.kind !== "prompt" &&
          command.command.kind !== "abort" &&
          command.command.kind !== "model.select"
          ? {
              code: "RESIDENT_COMMAND_UNSUPPORTED",
              message: "This continuity checkpoint supports only a new prompt, Stop, and model selection.",
              retryable: false,
            }
          : undefined;
        const gatewayUnavailable = this.gateway instanceof UnavailablePrimeAgentGateway
          ? {
              code: "GATEWAY_UNAVAILABLE",
              message: "Prime Agent execution is not attached in this build; the command was not queued.",
              retryable: true,
            }
          : residentCommandUnsupported ?? liveCheckFailure ?? (!live
            ? {
                code: "RESIDENT_SESSION_NOT_ATTACHED",
                message: "The exact resident Prime Agent session is not attached; the command was not sent.",
                retryable: true,
              }
            : undefined);
        const admission = await this.store.admitCommand(
          command,
          live,
          gatewayUnavailable,
        );
        if (admission.duplicate || admission.receipt.status !== "admitted" || !live) return admission.receipt;

        if (command.command.kind === "model.select") {
          let binding: Awaited<ReturnType<HostStore["beginModelSelectionDispatch"]>>;
          try {
            binding = await this.store.beginModelSelectionDispatch(command);
          } catch (error) {
            const storeError = error instanceof HostStoreError ? error : undefined;
            return this.store.finalizeModelSelectionDispatch(command, {
              status: "failed",
              message: storeError?.message.slice(0, 1_024) ?? "Model selection lost resident authority before dispatch",
              error: {
                code: storeError?.code ?? "MODEL_SELECTION_DISPATCH_REJECTED",
                message: storeError?.message.slice(0, 2_048) ?? "Model selection lost resident authority before dispatch",
                retryable: storeError?.retryable ?? true,
              },
            });
          }

          try {
            const gatewayAdmission = await this.gateway.submit(command, { residentBinding: binding });
            if (gatewayAdmission.disposition !== "handled") {
              return await this.store.finalizeModelSelectionDispatch(command, {
                status: "uncertain",
                message: "Prime Agent returned an invalid model-selection acknowledgement",
                error: {
                  code: "MODEL_SELECTION_ACK_INVALID",
                  message: "The model mutation may have run, but no authoritative completed acknowledgement was received",
                  retryable: false,
                },
              });
            }
            return await this.store.finalizeModelSelectionDispatch(command, {
              status: "completed",
              message: gatewayAdmission.message?.slice(0, 1_024) ?? "Prime Agent selected and verified the model",
            });
          } catch (error) {
            const gatewayError = error instanceof GatewayError ? error : undefined;
            const uncertain = gatewayError?.uncertain ?? true;
            const message = gatewayError?.message.slice(0, 1_024) ?? "Prime Agent model selection could not be reconciled";
            return this.store.finalizeModelSelectionDispatch(command, {
              status: uncertain ? "uncertain" : "failed",
              message,
              error: {
                code: gatewayError?.code ?? "MODEL_SELECTION_OUTCOME_UNKNOWN",
                message,
                retryable: uncertain ? false : (gatewayError?.retryable ?? true),
              },
            });
          }
        }

        if (command.command.kind === "prompt" || command.command.kind === "abort") {
          let lease: Awaited<ReturnType<HostStore["beginResidentDispatch"]>>;
          try {
            lease = await this.store.beginResidentDispatch(command);
          } catch (error) {
            const storeError = error instanceof HostStoreError ? error : undefined;
            return this.store.failResidentDispatchBeforeStart(command, {
              code: storeError?.code ?? "RESIDENT_DISPATCH_REJECTED",
              message: (storeError?.message ?? "Resident authority changed before dispatch").slice(0, 2_048),
              retryable: storeError?.retryable ?? true,
            });
          }

          try {
            const gatewayAdmission = await this.gateway.submit(command, { residentDispatch: lease });
            if (command.command.kind === "prompt" && gatewayAdmission.disposition === "accepted") {
              const receipt = await this.store.finalizeResidentDispatch(lease, {
                status: "running",
                message: gatewayAdmission.message?.slice(0, 1_024) ??
                  "Prime Agent owns the prompt; turn completion follows from authoritative runtime state",
              });
              try {
                const reconciliation = await this.store.beginResidentPromptReconciliation(lease);
                this.gateway.scheduleResidentPromptReconciliation?.(reconciliation);
              } catch {
                // The acknowledged-running receipt and prompt lock are already
                // durable. Readiness discovery can safely reissue the exact
                // reconciliation lease without replaying this prompt.
              }
              return receipt;
            }
            if (command.command.kind === "abort" && gatewayAdmission.disposition === "handled") {
              const receipt = await this.store.finalizeResidentDispatch(lease, {
                status: "running",
                message: gatewayAdmission.message?.slice(0, 1_024) ??
                  "Prime Agent accepted the stop request; waiting for authoritative idle proof",
              });
              try {
                const reconciliation = await this.store.beginResidentAbortReconciliation(lease);
                this.gateway.scheduleResidentAbortReconciliation?.(reconciliation);
              } catch {
                // The acknowledged-running receipt and Stop lock are already
                // durable. Readiness discovery can safely reissue the exact
                // read-only lease without replaying this abort.
              }
              return receipt;
            }
            return this.store.finalizeResidentDispatch(lease, {
              status: "uncertain",
              message: "Prime Agent returned an invalid resident command acknowledgement",
              error: {
                code: "RESIDENT_DISPATCH_ACK_INVALID",
                message: "The resident command may have run, but its acknowledgement was invalid",
                retryable: false,
              },
            });
          } catch (error) {
            const gatewayError = error instanceof GatewayError ? error : undefined;
            const uncertain = gatewayError?.uncertain ?? true;
            const message = (gatewayError?.message ??
              "Prime Agent may have received the resident command, but its outcome is unknown").slice(0, 1_024);
            return this.store.finalizeResidentDispatch(lease, {
              status: uncertain ? "uncertain" : "failed",
              message,
              error: {
                code: gatewayError?.code ?? "RESIDENT_DISPATCH_OUTCOME_UNKNOWN",
                message,
                retryable: uncertain ? false : (gatewayError?.retryable ?? true),
              },
            });
          }
        }

        try {
          const gatewayAdmission = await this.gateway.submit(command);
          if (gatewayAdmission.disposition === "accepted") {
            return this.store.updateCommandReceipt(command, {
              status: "running",
              queuePosition: undefined,
              message: gatewayAdmission.message ?? "Prime Agent accepted the command",
            });
          }
          if (gatewayAdmission.disposition === "handled") {
            return this.store.updateCommandReceipt(command, {
              status: "completed",
              queuePosition: undefined,
              message: gatewayAdmission.message ?? "Prime Agent handled the command",
            });
          }
          return this.store.updateCommandReceipt(command, {
            status: "admitted",
            message: gatewayAdmission.message ?? "Queued by Prime Agent",
          });
        } catch (error) {
          const gatewayError = error instanceof GatewayError ? error : undefined;
          return this.store.updateCommandReceipt(command, {
            status: gatewayError?.uncertain ? "uncertain" : "failed",
            queuePosition: undefined,
            message: gatewayError?.message ?? "Prime Agent gateway failed",
            error: {
              code: gatewayError?.code ?? "GATEWAY_FAILED",
              message: gatewayError?.message ?? "Prime Agent gateway failed",
              retryable: gatewayError?.retryable ?? true,
            },
          });
        }
      }
      case "command.reconcile": {
        const host = await this.store.getHost();
        if (request.payload.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "The reconciliation identities belong to a different host authority.",
          );
        }
        if (request.payload.commands.some((command) => command.expectedHostId !== host.hostId)) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "The exact reconciliation envelope belongs to a different host authority.",
          );
        }
        return this.store.reconcileCommands(request.payload.commands);
      }
      case "resident.provision":
      case "resident.provision.registered": {
        const host = await this.store.getHost();
        if (request.payload.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "The resident provisioning operation targets a different host authority.",
          );
        }
        const runtimeIntegrity = this.runtimeIntegrityProvider?.snapshot();
        if (runtimeIntegrity && runtimeIntegrity.status !== "ready") {
          throw new HostStoreError(
            "RESIDENT_LIFECYCLE_RUNTIME_UNAVAILABLE",
            "The verified Prime Agent runtime is not ready for resident provisioning.",
            runtimeIntegrity.status !== "unavailable",
          );
        }
        if (!isResidentLifecycleGateway(this.gateway) || !(await this.gateway.residentLifecycleCapabilityReady())) {
          throw new HostStoreError(
            "RESIDENT_LIFECYCLE_UNAVAILABLE",
            "Resident session provisioning is not available on this host.",
            true,
          );
        }

        const selection = {
          kind: "new" as const,
          ...(request.payload.sessionName === undefined
            ? {}
            : { sessionName: request.payload.sessionName }),
        };
        if (request.method === "resident.provision") {
          const artifacts = initialResidentWorkspaceArtifacts(request.payload);
          await this.store.bootstrapWorkspaceThread({
            operationId: residentWorkspaceBootstrapOperationId(request.payload.operationId),
            requestDigest: residentWorkspaceBootstrapDigest(request.payload),
            expectedHostId: request.payload.expectedHostId,
            project: artifacts.project,
            thread: artifacts.thread,
            initialProjection: artifacts.projection,
            workspaceDirectory: request.payload.workspaceDirectory,
          });
        } else {
          await this.store.bootstrapRegisteredWorkspaceThread({
            ...request.payload,
            bootstrapOperationId: residentWorkspaceBootstrapOperationId(request.payload.operationId),
            lifecycleRequestDigest: residentProvisionRequestDigest({
              operationId: request.payload.operationId,
              expectedHostId: request.payload.expectedHostId,
              projectId: request.payload.projectId,
              workspaceId: request.payload.workspaceId,
              threadId: request.payload.threadId,
              executionGenerationId: request.payload.executionGenerationId,
            }, selection),
          });
        }
        const status = await this.gateway.provisionResident({
          operationId: request.payload.operationId,
          expectedHostId: request.payload.expectedHostId,
          projectId: request.payload.projectId,
          workspaceId: request.payload.workspaceId,
          threadId: request.payload.threadId,
          executionGenerationId: request.payload.executionGenerationId,
          selection,
        });
        return ResidentLifecycleStatusSchema.parse(status);
      }
      case "resident.end": {
        const runtimeIntegrity = this.runtimeIntegrityProvider?.snapshot();
        if (runtimeIntegrity && runtimeIntegrity.status !== "ready") {
          throw new HostStoreError(
            "RESIDENT_LIFECYCLE_RUNTIME_UNAVAILABLE",
            "The verified Prime Agent runtime is not ready to end this resident session.",
            runtimeIntegrity.status !== "unavailable",
          );
        }
        if (!isResidentLifecycleGateway(this.gateway)) {
          throw new HostStoreError(
            "RESIDENT_LIFECYCLE_UNAVAILABLE",
            "Resident session lifecycle control is not available on this host.",
            true,
          );
        }
        // The coordinator's first async boundary is durable Store preparation;
        // runtime/adapter readiness is acquired only after `ending` exists.
        const status = await this.gateway.endResident(request.payload);
        return ResidentLifecycleStatusSchema.parse(status);
      }
      case "resident.lifecycle.status": {
        const host = await this.store.getHost();
        if (request.payload.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "The resident lifecycle status belongs to a different host authority.",
          );
        }
        const status = await this.store.getResidentLifecycleStatus(request.payload.operationId);
        return {
          status: status === undefined ? null : ResidentLifecycleStatusSchema.parse(status),
        };
      }
      case "handoff.plan": {
        const host = await this.store.getHost();
        if (request.payload.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "The handoff plan was requested from a different source host authority.",
          );
        }
        const plan = await this.store.createHandoffPlan(request.payload.request);
        return {
          ...plan,
          executable: false,
          warnings: [
            ...plan.warnings.filter((warning) => warning.code !== HANDOFF_COORDINATOR_WARNING.code),
            HANDOFF_COORDINATOR_WARNING,
          ],
        };
      }
      case "handoff.commit": {
        const host = await this.store.getHost();
        if (request.payload.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "The handoff commit belongs to a different source host authority.",
          );
        }
        throw new HostStoreError(
          "HANDOFF_COORDINATOR_UNAVAILABLE",
          "Cross-host handoff cannot commit until the Phase 2 destination coordinator is installed.",
        );
      }
    }
  }

  private async requireRuntimeOAuthBroker(expectedHostId: string): Promise<HostOAuthSessionBroker> {
    const host = await this.store.getHost();
    if (expectedHostId !== host.hostId) {
      throw new HostStoreError(
        "HOST_AUTHORITY_MISMATCH",
        "The OAuth session targets a different host authority.",
      );
    }
    const runtimeIntegrity = this.runtimeIntegrityProvider?.snapshot();
    if (!this.oauthSessionBroker || (runtimeIntegrity && runtimeIntegrity.status !== "ready")) {
      throw new HostStoreError(
        "RUNTIME_OAUTH_UNAVAILABLE",
        "The verified Prime Agent OAuth runtime is not available on this host.",
      );
    }
    return this.oauthSessionBroker;
  }

  private async requireCandidateEvaluationCoordinator(): Promise<CandidateEvaluationCoordinator> {
    const runtimeIntegrity = this.runtimeIntegrityProvider?.snapshot();
    if (
      !this.candidateEvaluationCoordinator ||
      !this.candidateEvaluationCoordinator.capabilityReady() ||
      runtimeIntegrity?.status !== "ready"
    ) {
      throw new CandidateEvaluationCoordinatorError(
        "EVALUATOR_NOT_READY",
        "Candidate evaluation requires the verified local runtime and evaluator authority",
      );
    }
    return this.candidateEvaluationCoordinator;
  }

  private async loadConfiguredHostIdentity(
    hostId: string,
    expected: Readonly<NonNullable<Awaited<ReturnType<PairingAuthority["getSnapshot"]>>["identity"]>>,
  ): Promise<HostIdentityReadiness> {
    const controller = new AbortController();
    this.hostIdentityProviderUsed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: "timeout" }>((resolvePromise) => {
      timer = setTimeout(() => {
        controller.abort(new Error("Host identity provider timed out"));
        resolvePromise({ kind: "timeout" });
      }, this.identityLoadTimeoutMs);
      timer.unref?.();
    });
    const provider = Promise.resolve()
      .then(() => this.hostIdentityProvider.loadExisting({ hostId, expected, signal: controller.signal }))
      .then(
        (result): { kind: "result"; result: unknown } => ({ kind: "result", result }),
        (): { kind: "error" } => ({ kind: "error" }),
      );
    const outcome = await Promise.race([provider, timeout]);
    if (timer) clearTimeout(timer);

    if (outcome.kind === "timeout") {
      return Object.freeze({
        state: "unavailable",
        code: "provider_timeout",
        recoveryAction: "restart_host_service",
      });
    }
    if (outcome.kind === "error") {
      return Object.freeze({
        state: "unavailable",
        code: "provider_error",
        recoveryAction: "restart_host_service",
      });
    }
    const result = parseHostIdentityProviderResult(outcome.result);
    if (!result) {
      return Object.freeze({
        state: "unavailable",
        code: "provider_error",
        recoveryAction: "restart_host_service",
      });
    }
    if (result.status === "unavailable") {
      return Object.freeze({
        state: "unavailable",
        code: result.code,
        recoveryAction: result.recoveryAction,
      });
    }
    if (result.hostId !== hostId) {
      return Object.freeze({
        state: "unavailable",
        code: "metadata_mismatch",
        recoveryAction: "review_identity",
      });
    }

    try {
      const verified = await this.pairingAuthority.initialize({ hostId, identity: result.identity });
      const identity = verified.identity;
      if (!identity || identity.secretRef !== expected.secretRef || identity.fingerprint !== expected.fingerprint) {
        throw new Error("Provider identity does not match durable authority metadata");
      }
      return Object.freeze({
        state: "ready",
        algorithm: identity.algorithm,
        fingerprint: identity.fingerprint,
        identityEpoch: identity.identityEpoch,
      });
    } catch {
      return Object.freeze({
        state: "unavailable",
        code: "metadata_mismatch",
        recoveryAction: "review_identity",
      });
    }
  }
}

const PROVIDER_UNAVAILABLE_CODES = new Set([
  "provider_not_installed",
  "credential_missing",
  "credential_locked",
  "credential_inaccessible",
  "credential_corrupt",
]);
const PROVIDER_RECOVERY_ACTIONS = new Set([
  "install_provider",
  "restore_identity",
  "unlock_credentials",
  "repair_permissions",
  "review_identity",
]);

function parseHostIdentityProviderResult(value: unknown): HostIdentityProviderLoadResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value.status === "ready") {
    if (typeof value.hostId !== "string") return undefined;
    const identity = HostIdentityInputSchema.safeParse(value.identity);
    return identity.success ? { status: "ready", hostId: value.hostId, identity: identity.data } : undefined;
  }
  if (
    value.status === "unavailable" &&
    typeof value.code === "string" &&
    PROVIDER_UNAVAILABLE_CODES.has(value.code) &&
    typeof value.recoveryAction === "string" &&
    PROVIDER_RECOVERY_ACTIONS.has(value.recoveryAction)
  ) {
    return value as HostIdentityProviderLoadResult;
  }
  return undefined;
}

function scopeForRequest(request: HostIpcRequest): RemoteDeviceScope {
  switch (request.method) {
    case "health.get":
    case "runtime.model_catalog":
    case "catalog.snapshot":
    case "thread.snapshot":
    case "thread.control.snapshot":
    case "command.reconcile":
      return "projection.read";
    case "oauth.session.start":
    case "oauth.session.status":
    case "oauth.session.cancel":
      // Relay requests are rejected before scope evaluation. This branch keeps
      // the protocol switch exhaustive without granting remote account access.
      return "host.admin";
    case "runtime.integrity.retry":
    case "runtime.integrity.repair":
    case "candidate.evaluation.preflight":
    case "candidate.evaluation.start":
    case "candidate.evaluation.snapshot":
      // SSH and relay requests are rejected before scope evaluation. Keep the
      // protocol switch exhaustive without granting remote repair authority.
      return "host.admin";
    case "resident.provision":
    case "resident.provision.registered":
    case "resident.end":
    case "resident.lifecycle.status":
      // Relay lifecycle requests are rejected before this scope is evaluated.
      // SSH bridges are host-authenticated rather than paired-device scoped.
      return "host.admin";
    case "handoff.plan":
    case "handoff.commit":
      return "run_location.change";
    case "command.submit":
      switch (request.payload.command.command.kind) {
        case "prompt":
          return "thread.start";
        case "follow_up":
          return "thread.follow_up";
        case "steer":
          return "thread.steer";
        case "abort":
          return "thread.abort";
        case "model.select":
          return "model.select";
        case "approval.resolve":
          return "approval.resolve";
      }
  }
}

function isRegisteredWorkspaceLifecycleRequest(request: HostIpcRequest): boolean {
  return request.method === "resident.provision.registered" ||
    request.method === "resident.end" ||
    request.method === "resident.lifecycle.status";
}

function isCandidateEvaluationRequest(request: HostIpcRequest): boolean {
  return request.method === "candidate.evaluation.preflight" ||
    request.method === "candidate.evaluation.start" ||
    request.method === "candidate.evaluation.snapshot";
}

function isResidentLifecycleGateway(gateway: PrimeAgentGateway): gateway is ResidentLifecycleGateway {
  const candidate = gateway as Partial<ResidentLifecycleGateway>;
  return typeof candidate.residentLifecycleCapabilityReady === "function" &&
    typeof candidate.provisionResident === "function" &&
    typeof candidate.endResident === "function";
}

function residentWorkspaceBootstrapOperationId(operationId: string): string {
  return `workspace-bootstrap-${createHash("sha256").update(operationId, "utf8").digest("hex").slice(0, 48)}`;
}

function residentWorkspaceBootstrapDigest(request: ResidentProvisionProtocolPayload): string {
  // The canonical workspace path is bound separately by the private Store
  // envelope. Keeping it out of this semantic digest lets physical aliases
  // converge after Store canonicalization without weakening exact equality.
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      operation: "resident.workspace.bootstrap",
      expectedHostId: request.expectedHostId,
      operationId: request.operationId,
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      executionGenerationId: request.executionGenerationId,
      projectDisplayName: request.projectDisplayName,
      threadTitle: request.threadTitle,
      createdAt: request.createdAt,
      sessionName: request.sessionName ?? null,
    }))
    .digest("hex");
}

function initialResidentWorkspaceArtifacts(request: ResidentProvisionProtocolPayload): Readonly<{
  project: ReturnType<typeof SavedProjectSchema.parse>;
  thread: ReturnType<typeof ThreadSummarySchema.parse>;
  projection: ReturnType<typeof ThreadProjectionSnapshotSchema.parse>;
}> {
  // The bootstrap lineage belongs to the immutable thread execution, not to
  // one lifecycle attempt. A definitively clean create failure may start a new
  // lifecycle operation over these exact artifacts; deriving the cursor from
  // operationId would make that safe retry diverge from its durable snapshot.
  const bootstrapLineage = createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      hostId: request.expectedHostId,
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      executionGenerationId: request.executionGenerationId,
    }))
    .digest("hex")
    .slice(0, 40);
  const cursor = Object.freeze({
    threadId: request.threadId,
    executionGenerationId: request.executionGenerationId,
    generation: `resident-bootstrap-${bootstrapLineage}`,
    sequence: 0,
  });
  const project = SavedProjectSchema.parse({
    projectId: request.projectId,
    hostId: request.expectedHostId,
    workspaceId: request.workspaceId,
    displayName: request.projectDisplayName,
    lastOpenedAt: request.createdAt,
  });
  const thread = ThreadSummarySchema.parse({
    threadId: request.threadId,
    title: request.threadTitle,
    projectIdentity: request.projectId,
    currentLocation: {
      hostId: request.expectedHostId,
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      executionGenerationId: request.executionGenerationId,
    },
    status: "idle",
    unread: false,
    updatedAt: request.createdAt,
    lastKnownCursor: cursor,
  });
  const projection = ThreadProjectionSnapshotSchema.parse({
    snapshotVersion: 1,
    generatedAt: request.createdAt,
    thread,
    transcriptBlockIndex: [],
    materializedRecentBlocks: [],
    queueState: { pendingCommandIds: [], paused: false },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    git: { stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
    pendingAttention: [],
    latestCursor: cursor,
  });
  return Object.freeze({ project, thread, projection });
}

function serviceStateForRuntimeIntegrity(
  runtimeIntegrity: RuntimeIntegritySnapshot,
): "starting" | "ready" | "degraded" {
  switch (runtimeIntegrity.status) {
    case "initializing":
      return "starting";
    case "ready":
      return "ready";
    case "failed":
    case "unavailable":
      return "degraded";
  }
}

function sameRuntimeIntegrityLineage(
  current: RuntimeIntegritySnapshot,
  next: RuntimeIntegritySnapshot,
): boolean {
  return (
    current.contractVersion === next.contractVersion &&
    current.trustAnchorId === next.trustAnchorId &&
    current.target.runtime === next.target.runtime &&
    current.target.releaseVersion === next.target.releaseVersion &&
    current.target.runtimeBuildId === next.target.runtimeBuildId &&
    current.target.platform === next.target.platform &&
    current.target.arch === next.target.arch &&
    current.target.manifestSha256 === next.target.manifestSha256 &&
    current.target.treeSha256 === next.target.treeSha256 &&
    current.target.filesSha256 === next.target.filesSha256
  );
}

function sameRuntimeIntegrityTarget(
  current: RuntimeIntegritySnapshot["target"],
  next: RuntimeIntegritySnapshot["target"],
): boolean {
  return (
    current.runtime === next.runtime &&
    current.releaseVersion === next.releaseVersion &&
    current.runtimeBuildId === next.runtimeBuildId &&
    current.platform === next.platform &&
    current.arch === next.arch &&
    current.manifestSha256 === next.manifestSha256 &&
    current.treeSha256 === next.treeSha256 &&
    current.filesSha256 === next.filesSha256
  );
}

function runtimeIntegrityAdmissionRejection(
  runtimeIntegrity: RuntimeIntegritySnapshot,
): StructuredError | undefined {
  switch (runtimeIntegrity.status) {
    case "ready":
      return undefined;
    case "initializing":
      return {
        code: "RUNTIME_INTEGRITY_INITIALIZING",
        message: "Prime Agent runtime integrity verification is still initializing; the command was not queued.",
        retryable: true,
      };
    case "failed":
      return {
        code: runtimeIntegrity.code,
        message: "Prime Agent runtime integrity verification failed; the command was not queued.",
        retryable: runtimeIntegrity.retryable,
      };
    case "unavailable":
      return {
        code: runtimeIntegrity.code,
        message: "Prime Agent runtime integrity verification is unavailable; the command was not queued.",
        retryable: runtimeIntegrity.retryable,
      };
  }
}

function invalidRequestResponse(value: unknown, error: ZodError): HostIpcResponse {
  const record = isRecord(value) ? value : undefined;
  const requestId =
    typeof record?.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.requestId)
      ? record.requestId
      : `invalid-${randomUUID()}`;
  const method = typeof record?.method === "string" && KNOWN_METHODS.has(record.method) ? record.method : "health.get";
  const firstIssue = error.issues[0];
  return HostIpcResponseSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method,
    ok: false,
    error: {
      code: record?.protocolVersion === PROTOCOL_VERSION ? "INVALID_REQUEST" : "INCOMPATIBLE_PROTOCOL",
      message: firstIssue ? `Invalid request at ${firstIssue.path.join(".") || "root"}: ${firstIssue.message}` : "Invalid request",
      retryable: false,
    },
  });
}

function toStructuredError(error: unknown): StructuredError {
  if (error instanceof HostStoreError) return error.toStructuredError();
  if (error instanceof PairingAuthorityError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof GatewayError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof OAuthBrokerError) {
    return { code: error.code, message: error.message, retryable: error.code === "OAUTH_PROVIDER_BUSY" };
  }
  if (error instanceof ResidentProvisionCoordinatorError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof CandidateEvaluationCoordinatorError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === "EVALUATION_BUSY" ||
        error.code === "EVALUATOR_NOT_READY" ||
        error.code === "CANDIDATE_CHANGED",
    };
  }
  if (error instanceof ZodError) {
    return { code: "INVALID_STATE", message: "Durable host state failed schema validation", retryable: false };
  }
  const diagnosticId = `diagnostic-${randomUUID()}`;
  return {
    code: "INTERNAL_ERROR",
    message: "The host service could not complete the request",
    retryable: true,
    diagnosticId,
  };
}

function isOAuthRequest(request: HostIpcRequest): boolean {
  return request.method === "oauth.session.start" ||
    request.method === "oauth.session.status" ||
    request.method === "oauth.session.cancel";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
