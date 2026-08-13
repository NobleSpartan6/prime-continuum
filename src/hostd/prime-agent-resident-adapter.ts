import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CommandEnvelopeSchema, type CommandEnvelope } from "../shared/protocol";
import {
  ExtensionUiDialogResponseSchema,
  ResidentExtensionUiRequestSchema,
  type ExtensionUiDialogResponse,
  type ResidentExtensionUiRequest,
} from "../shared/protocol";
import {
  GatewayError,
  residentCommandEnvelopeFingerprint,
  type GatewayAdmission,
  type GatewayDispatchContext,
  type PrimeAgentGateway,
} from "./gateway";
import {
  MAX_RESIDENT_PROJECTION_CHILDREN,
  ResidentProjectionError,
  normalizeResidentProjectionSnapshot,
  residentChildAgentSummaryFromSessionEvent,
  residentTerminalAssistantMarkerFromSessionEvent,
  type ResidentProjectionSnapshot,
  type ResidentTerminalAssistantMarker,
} from "./resident-projection";
import {
  ResidentRuntimeContractError,
  buildResidentOwnedDaemonCreateRequest,
  buildResidentDaemonCreateRequest,
  buildResidentDaemonStartInvocation,
  validateResidentAbortIdleReconciliationRequest,
  validateResidentDaemonHello,
  validateResidentDaemonRetirementHello,
  validateResidentGenerationDispatchLease,
  validateResidentPromptIdleReconciliationRequest,
  validateResidentOwnedSessionCreateInput,
  validateResidentSessionBinding,
  type ResidentDaemonStartInvocation,
  type ResidentDaemonRetirementTarget,
  type ResidentAbortIdleAuthorityEvidence,
  type ResidentAbortIdleReconciliationRequest,
  type ResidentDispatchOperation,
  type ResidentDispatchResult,
  type ResidentEndAcknowledgement,
  type ResidentGenerationDispatchLease,
  type ResidentPromptIdleAuthorityEvidence,
  type ResidentPromptIdleReconciliationRequest,
  type ResidentRuntimeAdapter,
  type ResidentRuntimeCompatibility,
  type ResidentRuntimeConnection,
  type ResidentRuntimeLifecycleListener,
  type ResidentRuntimeLifecycleSnapshot,
  type ResidentRuntimeLifecycleState,
  type ResidentRuntimeStructuredError,
  type ResidentOwnedSessionCreateInput,
  type ResidentSessionBinding,
  type ResidentSessionCreateInput,
} from "./resident-runtime";
import {
  MAX_RETIRED_RESIDENT_CURSOR_GENERATIONS,
  residentDispatchAuthorityFingerprint,
  validateResidentDispatchLease,
  validateResidentAbortReconciliationLease,
  validateResidentPromptReconciliationLease,
  validateResidentKillLeaseEnvelope,
  validateExtensionUiResponseLease,
  type ResidentAbortReconciliationLease,
  type ResidentDispatchLease,
  type ResidentKillInvocationAuthorizer,
  type ResidentKillLease,
  type ResidentPromptReconciliationLease,
  type ExtensionUiResponseLease,
} from "./store";

const DEFAULT_CONNECT_TIMEOUT_MS = 750;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RUNTIME_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const MAX_LIVE_SESSIONS = 10_000;
const MAX_AVAILABLE_MODELS = 5_000;
const MAX_MODEL_SELECTION_IDENTITIES = 10_000;
const MAX_RESIDENT_DISPATCH_IDENTITIES = 10_000;
const RETIRED_RESIDENT_DISPATCH_FENCE_BYTES = 2 * 1024 * 1024;
const RETIRED_RESIDENT_DISPATCH_FENCE_HASHES = 8;
const MAX_RESIDENT_PROMPT_CHARACTERS = 65_536;
const MAX_AUTHORITATIVE_MODEL_SNAPSHOT_READS = 40;
const MODEL_SELECTION_RECONCILIATION_POLL_MS = 50;
const MODEL_SELECTION_EPHEMERAL_DISPOSE_GRACE_MS = 100;
const MAX_AUTHORITATIVE_RESIDENT_SNAPSHOT_READS = 4;
const MAX_TERMINAL_EVENT_PROJECTION_ATTEMPTS = 8;
const TERMINAL_EVENT_PROJECTION_BACKOFF_MS = 25;
const RESIDENT_PROJECTION_COALESCE_MS = 100;
const PROMPT_ADMISSION_CANCEL_GRACE_MS = 2_000;
const DAEMON_RETIREMENT_POLL_MS = 25;
const MAX_DAEMON_RETIREMENT_PROBES = 512;
const ResidentOwnedRuntimeCandidateBrand: unique symbol = Symbol("ResidentOwnedRuntimeCandidate");
const UNVERIFIED_OWNED_CLEANUP_ATTEMPT = Object.freeze({
  disposition: "attempted_unverified" as const,
  durableCompletionAuthorized: false as const,
  reason: "prime_v0_7_dispose_suppresses_complete_response" as const,
});

export interface ResidentOwnedCleanupAttemptResult {
  readonly disposition: "attempted_unverified";
  readonly durableCompletionAuthorized: false;
  readonly reason: "prime_v0_7_dispose_suppresses_complete_response";
}

/**
 * Process-local escrow capability for one exact client-owned Prime session.
 * Its runtime brand and private-field-backed methods are lost across structured
 * clone, so durable state cannot recreate mutation authority after restart.
 */
export interface ResidentOwnedRuntimeCandidate {
  readonly [ResidentOwnedRuntimeCandidateBrand]: true;
  readonly candidateVersion: 1;
  readonly threadId: string;
  readonly executionGenerationId: string;
  readonly workspaceDirectory: string;
  readonly activeSessionId: string;
  readonly sessionId: string;
  readonly sessionFile?: string;
  /** Immutable proposed resident binding time, minted before promotion. */
  readonly boundAt: string;
  readonly runtime: ResidentRuntimeCompatibility;
  /** One upstream promotion invocation; repeated calls share its exact result. */
  promoteToResident(): Promise<void>;
  /** Read two equal authoritative snapshots after promotion; never mutates Prime. */
  readStableProjection(): Promise<ResidentProjectionSnapshot>;
  /** Read and durably publish one stable projection through caller-held Store authority. */
  publishStableProjection(
    publisher: (
      binding: ResidentSessionBinding,
      projection: ResidentProjectionSnapshot,
    ) => Promise<void>,
  ): Promise<ResidentProjectionSnapshot>;
  /**
   * Best-effort owned cleanup only. Prime v0.7 suppresses the
   * complete_owned_session response, so this result can never authorize a
   * durable Store completion transition.
   */
  attemptUnverifiedOwnedCleanup(): Promise<ResidentOwnedCleanupAttemptResult>;
  /**
   * Release local authority. Before promotion this attempts unverified owned
   * cleanup; after promotion it detaches; after unknown promotion it closes
   * only the owner transport. Resolution is never cleanup proof.
   */
  dispose(): Promise<void>;
}

const WireStringSchema = z.string().min(1).max(4_096);
const SessionActionsSchema = z
  .object({
    queuedCount: z.number().int().nonnegative().max(1_000_000),
    steering: z.array(z.unknown()).max(10_000),
    followUps: z.array(z.unknown()).max(10_000),
  })
  .passthrough();
const LiveSessionSummarySchema = z
  .object({
    id: WireStringSchema,
    lifecycle: z.enum(["draft", "live", "archived"]),
    activity: z.enum(["working", "idle"]),
    isSessionActive: z.boolean(),
    activeSessionId: WireStringSchema,
    sessionId: WireStringSchema,
    sessionFile: WireStringSchema.optional(),
    sessionName: z.string().max(255).optional(),
    cwd: WireStringSchema,
    isStreaming: z.boolean(),
    isCompacting: z.boolean(),
    attachedClients: z.number().int().nonnegative().max(1_000_000),
    messageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    unfinishedActionCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    sessionActions: SessionActionsSchema,
  })
  .passthrough();
const InitialSnapshotSchema = z
  .object({
    state: z
      .object({
        activeSessionId: WireStringSchema,
        sessionId: WireStringSchema,
        sessionFile: WireStringSchema.optional(),
        cwd: WireStringSchema,
      })
      .passthrough(),
    messages: z.array(z.unknown()).max(200_000),
    lastEventSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    lastEventCursor: z
      .object({
        generation: z.string().min(1).max(256),
        sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .optional(),
  })
  .passthrough();

const ModelSelectionIdentitySchema = z
  .object({
    provider: z.string().min(1).max(128).regex(/^[^\0\r\n]+$/),
    id: z.string().min(1).max(512).regex(/^[^\0\r\n]+$/),
  })
  .strip();

const ModelSelectionSnapshotSchema = z
  .object({
    state: z
      .object({
        activeSessionId: WireStringSchema,
        sessionId: WireStringSchema,
        sessionFile: WireStringSchema.optional(),
        cwd: WireStringSchema,
        model: ModelSelectionIdentitySchema,
        leafId: WireStringSchema.nullable(),
        messageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .passthrough(),
    lastEventSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lastEventCursor: z
      .object({
        generation: z.string().min(1).max(256),
        sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .passthrough()
  .refine(
    (snapshot) => snapshot.lastEventSequence === snapshot.lastEventCursor.sequence,
    "Model-selection snapshot cursor is inconsistent",
  );

type LiveSessionSummary = z.infer<typeof LiveSessionSummarySchema>;

interface SanitizedResidentModelIdentity {
  readonly providerId: string;
  readonly modelId: string;
}

interface ResidentDispatchAttemptRecord {
  readonly lease: ResidentGenerationDispatchLease;
  readonly payloadFingerprint: string;
  readonly result: Promise<ResidentDispatchResult>;
}

/**
 * Fixed-memory, fail-closed replay tombstones for attempts that age out of the
 * exact-result window. HostStore's opaque lease is the canonical durable
 * no-replay authority; this filter ensures a retained private runtime lease
 * cannot regain an upstream call merely because its exact Promise was evicted.
 * False positives reject a new attempt safely and are negligible at the
 * expected command volume; bits are never cleared during a connection's life.
 */
class RetiredResidentDispatchFence {
  private bits: Uint8Array | undefined;

  has(dispatchAttemptId: string): boolean {
    if (!this.bits) return false;
    return this.indices(dispatchAttemptId).every((index) =>
      (this.bits![index >>> 3]! & (1 << (index & 7))) !== 0);
  }

  add(dispatchAttemptId: string): void {
    this.bits ??= new Uint8Array(RETIRED_RESIDENT_DISPATCH_FENCE_BYTES);
    for (const index of this.indices(dispatchAttemptId)) {
      this.bits[index >>> 3] = this.bits[index >>> 3]! | (1 << (index & 7));
    }
  }

  private indices(dispatchAttemptId: string): number[] {
    const digest = createHash("sha256").update(dispatchAttemptId, "utf8").digest();
    const bitCount = RETIRED_RESIDENT_DISPATCH_FENCE_BYTES * 8;
    return Array.from(
      { length: RETIRED_RESIDENT_DISPATCH_FENCE_HASHES },
      (_, index) => digest.readUInt32BE(index * 4) % bitCount,
    );
  }
}

type PromptAdmissionOutcome = "owned" | "cancelled" | "unknown";

interface PromptAdmissionAttempt {
  readonly lease: ResidentGenerationDispatchLease;
  readonly controller: AbortController;
  readonly settlement: Promise<PromptAdmissionOutcome>;
  readonly settle: (outcome: PromptAdmissionOutcome) => void;
  baselineCursor: ResidentProjectionSnapshot["cursor"] | undefined;
}

interface PromptIdleReconciliationRecord {
  readonly request: ResidentPromptIdleReconciliationRequest;
  readonly result: Promise<ResidentPromptIdleAuthorityEvidence>;
}

interface AbortIdleReconciliationRecord {
  readonly request: ResidentAbortIdleReconciliationRequest;
  readonly result: Promise<ResidentAbortIdleAuthorityEvidence>;
}

interface ResidentIdleReconciliationCancellation {
  readonly promise: Promise<never>;
  readonly reject: (error: ResidentRuntimeContractError) => void;
}

interface PrimeDaemonResponseSuccess {
  readonly type: "response";
  readonly command: string;
  readonly success: true;
  readonly data?: unknown;
}

interface PrimeDaemonResponseFailure {
  readonly type: "response";
  readonly command: string;
  readonly success: false;
  readonly error: string;
}

type PrimeDaemonResponse = PrimeDaemonResponseSuccess | PrimeDaemonResponseFailure;

/** Narrow structural view of the pinned package's public DaemonClient export. */
export interface PrimeDaemonClientPublic {
  readonly hello?: unknown;
  readonly isConnected?: boolean;
  connect(timeoutMs?: number): Promise<void>;
  waitForHello(timeoutMs?: number): Promise<unknown>;
  request(command: Readonly<object>, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

/** Narrow structural view of the pinned package's public connection export. */
export interface PrimeDaemonAgentConnectionPublic {
  getInitialSnapshot(): Promise<unknown>;
  /** Read-only resource discovery for this exact attached resident session. */
  getResourceSnapshot(): Promise<unknown>;
  /** v0.7.2 waits for the action pump, agent, and server-side event queue to become idle. */
  waitForIdle?(): Promise<void>;
  /** Pinned public AgentConnection methods; guarded at the mutation boundary. */
  getAvailableModels?(): Promise<unknown>;
  setModel?(provider: string, modelId: string): Promise<unknown>;
  /** v0.7.2 resolves prompt when the worker accepts/owns it, not at turn completion. */
  prompt?(
    message: string,
    options?: Readonly<{ queueIfBusy?: boolean; signal?: AbortSignal }>,
  ): Promise<void>;
  /** v0.7.2 resolves abort when requestAbort() is accepted, not when stopping completes. */
  abort?(): Promise<void>;
  respondToExtensionUiRequest?(
    requestId: string,
    response: Readonly<{ cancelled: true } | { value: string } | { confirmed: boolean }>,
  ): Promise<void>;
  /** v0.7.2 promotes one client-owned worker to ordinary resident lifetime. */
  promoteToResident(): Promise<void>;
  subscribe(listener: (event: unknown) => void | Promise<void>): () => void;
  dispose(): Promise<void>;
}

export interface PrimeAgentPublicModule {
  readonly DaemonClient: new (socketPath: string) => PrimeDaemonClientPublic;
  readonly DaemonAgentConnection: Readonly<{
    attach(
      client: PrimeDaemonClientPublic,
      activeSessionId: string,
      options: Readonly<{
        closeClientOnDispose: true;
        sendClientEnv: false;
        supportsExtensionUi: true;
        ownedSession: boolean;
        telemetryDisabled: true;
        recoverDaemon: () => Promise<void>;
      }>,
    ): Promise<PrimeDaemonAgentConnectionPublic>;
  }>;
}

export type PrimeAgentPublicModuleLoader = () => Promise<unknown>;

export interface ResidentDaemonLauncher {
  readonly pid?: number;
  once(event: "error" | "exit", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
}

export type ResidentDaemonSpawn = (
  executable: string,
  argv: readonly string[],
  options: ResidentDaemonStartInvocation["spawn"],
) => ResidentDaemonLauncher;

export interface PrimeAgentResidentAdapterOptions {
  /** Immutable verified host identity used only in path-free live projections. */
  readonly hostId: string;
  readonly socketPath: string;
  /** Absolute, verified Node-compatible executable for the pinned runtime. */
  readonly executable: string;
  /** Absolute, verified v0.7.2 dist/bundle/cli.js entrypoint. */
  readonly cliEntrypoint: string;
  /** Absolute, writable host-owned directory used instead of ambient cwd. */
  readonly daemonWorkingDirectory: string;
  /** Exact verified browser skill document packaged with this runtime. */
  readonly browserSkill?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /** Must resolve only after the package archive and install tree are verified. */
  readonly loadRuntimeModule: PrimeAgentPublicModuleLoader;
  /** Durable host write performed after create succeeds and before attach begins. */
  readonly persistBinding: (binding: ResidentSessionBinding) => Promise<void>;
  /** Store-bound, one-shot authority consumed before any root-kill read or mutation. */
  readonly authorizeResidentKillInvocation?: ResidentKillInvocationAuthorizer;
  /** Durable host publication of a normalized authoritative runtime snapshot. */
  readonly publishProjection: (
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>;
  /** Attempt-scoped publication for one authoritatively proven model.select. */
  readonly publishModelSelectionProjection: (
    command: CommandEnvelope,
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>;
  /** Invalidate only the service overlay; this callback must never persist the dialogs. */
  readonly publishEphemeralProjectionChange?: (binding: ResidentSessionBinding) => void;
  readonly spawnFactory?: ResidentDaemonSpawn;
  readonly connectTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

interface ResolvedOptions {
  readonly hostId: string;
  readonly invocation: ResidentDaemonStartInvocation;
  readonly socketPath: string;
  readonly loadRuntimeModule: PrimeAgentPublicModuleLoader;
  readonly persistBinding: (binding: ResidentSessionBinding) => Promise<void>;
  readonly authorizeResidentKillInvocation: ResidentKillInvocationAuthorizer;
  readonly publishProjection: (
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>;
  readonly publishModelSelectionProjection: (
    command: CommandEnvelope,
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>;
  readonly publishEphemeralProjectionChange: (binding: ResidentSessionBinding) => void;
  readonly spawnFactory: ResidentDaemonSpawn;
  readonly connectTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly now: () => Date;
  readonly wait: (milliseconds: number) => Promise<void>;
}

interface OpenClient {
  readonly client: PrimeDaemonClientPublic;
  readonly compatibility: ResidentRuntimeCompatibility;
}

interface IncompatibleOpenClient {
  readonly client: PrimeDaemonClientPublic;
  readonly incompatibility: ResidentRuntimeContractError;
  readonly retirementTarget: ResidentDaemonRetirementTarget;
}

class DaemonUnavailableError extends Error {
  readonly definitiveAbsence: boolean;

  constructor(cause: unknown) {
    super("Prime Agent daemon is not accepting connections", { cause });
    this.name = "DaemonUnavailableError";
    this.definitiveAbsence = isDefinitiveEndpointAbsence(cause);
  }
}

class LifecycleController {
  private snapshot: ResidentRuntimeLifecycleSnapshot;
  private readonly listeners = new Set<ResidentRuntimeLifecycleListener>();

  constructor(
    private readonly now: () => Date,
    initialState: ResidentRuntimeLifecycleState,
    binding?: ResidentSessionBinding,
  ) {
    this.snapshot = freezeLifecycle({ state: initialState, changedAt: now().toISOString(), binding });
  }

  get(): ResidentRuntimeLifecycleSnapshot {
    return this.snapshot;
  }

  subscribe(listener: ResidentRuntimeLifecycleListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot);
    } catch (error) {
      this.listeners.delete(listener);
      throw error;
    }
    return () => this.listeners.delete(listener);
  }

  transition(
    state: ResidentRuntimeLifecycleState,
    options: { binding?: ResidentSessionBinding; error?: ResidentRuntimeStructuredError } = {},
  ): void {
    this.snapshot = freezeLifecycle({
      state,
      changedAt: this.now().toISOString(),
      ...(options.binding ? { binding: options.binding } : {}),
      ...(options.error ? { error: options.error } : {}),
    });
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        // Observers cannot alter daemon ownership or lifecycle transitions.
      }
    }
  }
}

/**
 * Host-only wrapper over the pinned public daemon API. It deliberately does
 * not import Prime Agent statically, expose upstream DTOs, or own the daemon's
 * lifetime. Runtime installation and checksum verification remain a separate
 * composition boundary.
 */
export class PrimeAgentResidentAdapter implements ResidentRuntimeAdapter, PrimeAgentGateway {
  readonly continuity = "resident" as const;
  private readonly options: ResolvedOptions;
  private readonly lifecycle: LifecycleController;
  private readonly connections = new Map<string, ManagedResidentRuntimeConnection>();
  private readonly ownedCandidates = new Set<ManagedResidentOwnedCandidate>();
  private readonly modelSelectionAttempts = new Map<
    string,
    Readonly<{
      command: CommandEnvelope;
      binding: ResidentSessionBinding;
      result: Promise<GatewayAdmission>;
    }>
  >();
  private modulePromise: Promise<PrimeAgentPublicModule> | undefined;
  private daemonEnsurePromise: Promise<ResidentRuntimeCompatibility> | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closeRequested = false;
  private closed = false;

  constructor(options: PrimeAgentResidentAdapterOptions) {
    const invocation = buildResidentDaemonStartInvocation({
      executable: options.executable,
      cliEntrypoint: options.cliEntrypoint,
      socketPath: options.socketPath,
      daemonWorkingDirectory: options.daemonWorkingDirectory,
      environment: options.environment,
      additionalSkillPath: options.browserSkill,
    });
    this.options = Object.freeze({
      hostId: options.hostId,
      invocation,
      socketPath: invocation.argv[4]!,
      loadRuntimeModule: options.loadRuntimeModule,
      persistBinding: options.persistBinding,
      authorizeResidentKillInvocation: options.authorizeResidentKillInvocation ?? (async () => {
        throw new ResidentRuntimeContractError(
          "PRIME_RUNTIME_LIFECYCLE_AUTHORITY_INVALID",
          "Resident end requires a Store-bound one-shot kill authorizer.",
        );
      }),
      publishProjection: options.publishProjection,
      publishModelSelectionProjection: options.publishModelSelectionProjection,
      publishEphemeralProjectionChange: options.publishEphemeralProjectionChange ?? (() => undefined),
      spawnFactory: options.spawnFactory ?? defaultResidentDaemonSpawn,
      connectTimeoutMs: boundedTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, "connectTimeoutMs"),
      startupTimeoutMs: boundedTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs"),
      requestTimeoutMs: boundedTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs"),
      now: options.now ?? (() => new Date()),
      wait: options.wait ?? (async (milliseconds) => void (await delay(milliseconds))),
    });
    this.lifecycle = new LifecycleController(this.options.now, "idle");
  }

  getLifecycle(): ResidentRuntimeLifecycleSnapshot {
    return this.lifecycle.get();
  }

  subscribeLifecycle(listener: ResidentRuntimeLifecycleListener): () => void {
    return this.lifecycle.subscribe(listener);
  }

  ensureDaemon(invocation: ResidentDaemonStartInvocation): Promise<ResidentRuntimeCompatibility> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertSameInvocation(invocation, this.options.invocation);
      try {
        return await this.ensureDaemonSingleFlight();
      } catch (error) {
        throw this.fail(error);
      }
    });
  }

  createOwnedCandidate(inputValue: ResidentOwnedSessionCreateInput): Promise<ResidentOwnedRuntimeCandidate> {
    let input: ResidentOwnedSessionCreateInput;
    let request: ReturnType<typeof buildResidentOwnedDaemonCreateRequest>;
    try {
      // Complete every caller-controlled validation before the daemon create
      // mutation can be invoked. The frozen normalized input also closes a
      // getter/mutation TOCTOU gap between request construction and identity.
      input = validateResidentOwnedSessionCreateInput(inputValue);
      request = buildResidentOwnedDaemonCreateRequest(input);
    } catch (error) {
      return Promise.reject(error);
    }

    return this.enqueue(async () => {
      this.assertOpen();
      let client: PrimeDaemonClientPublic | undefined;
      let attached: PrimeDaemonAgentConnectionPublic | undefined;
      let createDispatched = false;
      let createdActiveSessionId: string | undefined;
      let postCreatePhase = "awaiting_create_response";
      try {
        await this.ensureDaemonSingleFlight();
        this.lifecycle.transition("creating_resident");
        const runtimeModule = await this.loadModule();
        const opened = await this.openValidatedClient(runtimeModule);
        client = opened.client;
        postCreatePhase = "create_response_unverified";
        createDispatched = true;
        const response = await requestDaemon(
          client,
          request,
          this.options.requestTimeoutMs,
          "create",
          true,
        );
        postCreatePhase = "validating_create_summary";
        const summary = parseLiveSessionSummary(response.data, "create");
        createdActiveSessionId = summary.activeSessionId;
        postCreatePhase = "validating_create_identity";
        assertWorkspaceMatches(summary.cwd, input.workspaceDirectory, "owned create summary");
        const sessionFile = validateOwnedCandidateSessionFile(summary.sessionFile, input);

        postCreatePhase = "checking_adapter_authority";
        this.assertOpen();
        this.lifecycle.transition("attaching");
        postCreatePhase = "attaching_owned_connection";
        attached = await this.attachPublicConnection(
          runtimeModule,
          client,
          summary.activeSessionId,
          true,
        );
        postCreatePhase = "validating_owned_connection";
        if (typeof attached.promoteToResident !== "function") {
          throw new ResidentRuntimeContractError(
            "PRIME_RUNTIME_MODULE_INVALID",
            "The pinned Prime Agent owned connection is missing resident promotion support.",
          );
        }

        postCreatePhase = "constructing_owned_candidate";
        const candidate = new ManagedResidentOwnedCandidate({
          threadId: input.threadId,
          executionGenerationId: input.executionGenerationId,
          workspaceDirectory: input.workspaceDirectory,
          activeSessionId: summary.activeSessionId,
          sessionId: summary.sessionId,
          ...(sessionFile ? { sessionFile } : {}),
          boundAt: this.options.now().toISOString(),
          runtime: opened.compatibility,
          client,
          attached,
          requestTimeoutMs: this.options.requestTimeoutMs,
          onClosed: () => this.ownedCandidates.delete(candidate),
        });
        this.ownedCandidates.add(candidate);
        client = undefined;
        attached = undefined;
        this.lifecycle.transition("ready");
        return candidate;
      } catch (error) {
        // Public owned dispose may send complete_owned_session when attach
        // succeeded, but v0.7 suppresses its acknowledgement; it is cleanup,
        // never proof. Closing an unattached owner client activates Prime's
        // bounded owner-disconnect cleanup. Neither path can issue root kill.
        let cleanup = "not_required";
        if (attached) {
          cleanup = "public_owned_dispose_unverified";
          try {
            await attached.dispose();
          } catch {
            cleanup = "public_owned_dispose_failed";
            client?.close();
          }
        } else if (client) {
          client.close();
          cleanup = "owner_transport_closed";
        }
        if (createDispatched) {
          throw this.fail(
            unknownOwnedCreateOutcome(
              postCreatePhase,
              createdActiveSessionId,
              cleanup,
              error,
            ),
          );
        }
        throw this.fail(error);
      }
    });
  }

  /** @deprecated Legacy harness-only path; production provisioning uses client-owned escrow. */
  createResident(input: ResidentSessionCreateInput): Promise<ResidentRuntimeConnection> {
    return this.enqueue(async () => {
      this.assertOpen();
      let client: PrimeDaemonClientPublic | undefined;
      let attached: PrimeDaemonAgentConnectionPublic | undefined;
      try {
        await this.ensureDaemonSingleFlight();
        this.lifecycle.transition("creating_resident");
        const runtimeModule = await this.loadModule();
        const opened = await this.openValidatedClient(runtimeModule);
        client = opened.client;
        const request = buildResidentDaemonCreateRequest(input);
        const response = await requestDaemon(client, request, this.options.requestTimeoutMs, "create", true);
        const summary = parseLiveSessionSummary(response.data, "create");
        assertWorkspaceMatches(summary.cwd, input.workspaceDirectory, "create summary");
        const binding = freezeBinding({
          bindingVersion: 1,
          lifecycle: "resident",
          threadId: input.threadId,
          executionGenerationId: input.executionGenerationId,
          workspaceDirectory: input.workspaceDirectory,
          activeSessionId: summary.activeSessionId,
          sessionId: summary.sessionId,
          ...(summary.sessionFile ? { sessionFile: summary.sessionFile } : {}),
          boundAt: this.options.now().toISOString(),
          runtime: opened.compatibility,
        });

        try {
          await this.options.persistBinding(binding);
        } catch (error) {
          const cleanupSucceeded = await killCreatedSession(
            client,
            summary.activeSessionId,
            this.options.requestTimeoutMs,
          );
          throw new ResidentRuntimeContractError(
            "PRIME_RUNTIME_BINDING_PERSIST_FAILED",
            cleanupSucceeded
              ? "Prime Agent session creation was rolled back because its durable binding could not be saved."
              : "Prime Agent created a resident session, but its durable binding could not be saved or rolled back.",
            {
              details: { cleanupSucceeded, cause: errorMessage(error) },
              cause: error,
            },
          );
        }

        this.assertOpen();
        this.lifecycle.transition("attaching", { binding });
        attached = await this.attachPublicConnection(runtimeModule, client, binding.activeSessionId);
        const initialProjection = await publishInitialProjection(
          attached,
          binding,
          this.options.publishProjection,
        );
        this.assertOpen();
        const connection = this.registerConnection(binding, client, attached, initialProjection);
        client = undefined;
        attached = undefined;
        this.lifecycle.transition("ready", { binding });
        return connection;
      } catch (error) {
        if (attached) await attached.dispose().catch(() => undefined);
        else client?.close();
        throw this.fail(error);
      }
    });
  }

  attachResident(binding: ResidentSessionBinding): Promise<ResidentRuntimeConnection> {
    return this.enqueue(async () => {
      this.assertOpen();
      const durableBinding = validateResidentSessionBinding(binding);
      const existing = this.connections.get(durableBinding.activeSessionId);
      if (existing) {
        assertBindingIdentity(existing.binding, durableBinding);
        return existing;
      }

      let client: PrimeDaemonClientPublic | undefined;
      let attached: PrimeDaemonAgentConnectionPublic | undefined;
      try {
        await this.ensureDaemonSingleFlight();
        this.lifecycle.transition("attaching", { binding: durableBinding });
        const runtimeModule = await this.loadModule();
        const opened = await this.openValidatedClient(runtimeModule);
        client = opened.client;
        const response = await requestDaemon(client, { type: "list" }, this.options.requestTimeoutMs, "list");
        const summary = parseLiveSessionList(response.data).find(
          (candidate) => candidate.activeSessionId === durableBinding.activeSessionId,
        );
        if (!summary) {
          throw new ResidentRuntimeContractError(
            "PRIME_RUNTIME_SESSION_NOT_FOUND",
            "The resident Prime Agent session is not currently available to attach.",
            { retryable: true, details: { activeSessionId: durableBinding.activeSessionId } },
          );
        }
        assertSummaryMatchesBinding(summary, durableBinding);
        const refreshedBinding = freezeBinding({ ...durableBinding, runtime: opened.compatibility });
        await this.options.persistBinding(refreshedBinding).catch((error) => {
          throw new ResidentRuntimeContractError(
            "PRIME_RUNTIME_BINDING_PERSIST_FAILED",
            "The refreshed resident runtime binding could not be saved before attach.",
            { retryable: true, details: { cause: errorMessage(error) }, cause: error },
          );
        });
        attached = await this.attachPublicConnection(runtimeModule, client, refreshedBinding.activeSessionId);
        const initialProjection = await publishInitialProjection(
          attached,
          refreshedBinding,
          this.options.publishProjection,
        );
        this.assertOpen();
        const connection = this.registerConnection(
          refreshedBinding,
          client,
          attached,
          initialProjection,
        );
        client = undefined;
        attached = undefined;
        this.lifecycle.transition("ready", { binding: refreshedBinding });
        return connection;
      } catch (error) {
        if (attached) await attached.dispose().catch(() => undefined);
        else client?.close();
        throw this.fail(error, durableBinding);
      }
    });
  }

  readStableResidentProjection(bindingValue: ResidentSessionBinding): Promise<ResidentProjectionSnapshot> {
    let binding: ResidentSessionBinding;
    try {
      binding = validateResidentSessionBinding(bindingValue);
    } catch (error) {
      return Promise.reject(error);
    }

    return this.readThroughEphemeralResidentAttachment(
      binding,
      async (attached) => {
        const projection = await readStableResidentProjection(attached, binding);
        if (!projection) {
          throw new ResidentRuntimeContractError(
            "PRIME_RUNTIME_RESPONSE_INVALID",
            "Prime Agent state changed throughout the bounded resident recovery read.",
          );
        }
        return projection;
      },
      "Prime Agent resident recovery projection could not be read.",
    );
  }

  private readStableSelectedModelProjection(
    binding: ResidentSessionBinding,
    providerId: string,
    modelId: string,
  ): Promise<ResidentProjectionSnapshot> {
    const deadline = performance.now() + this.options.requestTimeoutMs;
    return this.readThroughEphemeralResidentAttachment(
      binding,
      (attached, client) => readStableModelSelectionProjection(
        attached,
        client,
        binding,
        providerId,
        modelId,
        deadline,
        this.options.wait,
      ),
      "Prime Agent model-selection projection could not be read.",
      "bounded_model_reconciliation",
      deadline,
    );
  }

  private readThroughEphemeralResidentAttachment<T>(
    binding: ResidentSessionBinding,
    read: (
      attached: PrimeDaemonAgentConnectionPublic,
      client: PrimeDaemonClientPublic,
    ) => Promise<T>,
    failureMessage: string,
    cleanupMode: "graceful" | "bounded_model_reconciliation" = "graceful",
    deadline?: number,
  ): Promise<T> {
    return this.enqueue(async () => {
      this.assertOpen();
      let client: PrimeDaemonClientPublic | undefined;
      let attached: PrimeDaemonAgentConnectionPublic | undefined;
      let unsubscribeAttached: (() => void) | undefined;
      try {
        if (deadline === undefined) {
          await this.ensureDaemonSingleFlight();
        } else {
          await beforeModelSelectionDeadline(
            deadline,
            () => this.ensureDaemonSingleFlight(),
            "model selection daemon validation",
          );
        }
        const runtimeModule = deadline === undefined
          ? await this.loadModule()
          : await beforeModelSelectionDeadline(
              deadline,
              () => this.loadModule(),
              "model selection runtime module load",
            );
        let openingClient: PrimeDaemonClientPublic | undefined;
        let openPromise: Promise<OpenClient> | undefined;
        let opened: OpenClient;
        if (deadline === undefined) {
          opened = await this.openValidatedClient(runtimeModule);
        } else {
          try {
            opened = await beforeModelSelectionDeadline(
              deadline,
              (remainingMs) => {
                openPromise = this.openValidatedClient(
                  runtimeModule,
                  Math.max(1, Math.min(this.options.connectTimeoutMs, remainingMs)),
                  (createdClient) => {
                    openingClient = createdClient;
                  },
                );
                return openPromise;
              },
              "model selection validated client open",
            );
          } catch (error) {
            closeDaemonClientQuietly(openingClient);
            if (openPromise) observeLateOpenClient(openPromise);
            throw error;
          }
        }
        client = opened.client;
        assertRuntimeCompatibilityMatchesBinding(opened.compatibility, binding);
        const response = deadline === undefined
          ? await requestDaemon(
              client,
              { type: "list" },
              this.options.requestTimeoutMs,
              "list",
            )
          : await beforeModelSelectionDeadline(
              deadline,
              (remainingMs) => requestDaemon(
                client!,
                { type: "list" },
                remainingMs,
                "list",
              ),
              "model selection exact session list",
            );
        const summary = findExactAvailableResidentSession(response.data, binding);
        assertSummaryMatchesBinding(summary, binding);
        this.assertOpen();
        if (deadline === undefined) {
          attached = await this.attachPublicConnection(
            runtimeModule,
            client,
            binding.activeSessionId,
            false,
          );
        } else {
          let attachPromise: Promise<PrimeDaemonAgentConnectionPublic> | undefined;
          try {
            attached = await beforeModelSelectionDeadline(
              deadline,
              () => {
                attachPromise = this.attachPublicConnection(
                  runtimeModule,
                  client!,
                  binding.activeSessionId,
                  false,
                );
                return attachPromise;
              },
              "model selection exact session attachment",
            );
          } catch (error) {
            if (attachPromise) observeLateAttachedConnection(attachPromise);
            throw error;
          }
        }
        // Worker-backed public connections retain events until a subscriber is
        // present. Drain this read-only attachment while reconciliation runs so
        // a busy session cannot exhaust the proxy's bounded event queue.
        unsubscribeAttached = attached.subscribe(() => undefined);
        const result = await read(attached, client);
        const currentHello = client.hello ?? (
          deadline === undefined
            ? await client.waitForHello(this.options.connectTimeoutMs)
            : await beforeModelSelectionDeadline(
                deadline,
                (remainingMs) => client!.waitForHello(
                  Math.max(1, Math.min(this.options.connectTimeoutMs, remainingMs)),
                ),
                "model selection daemon handshake revalidation",
              )
        );
        const currentCompatibility = validateResidentDaemonHello(
          currentHello,
          {
            expectedSocketPath: this.options.socketPath,
            expectedExecutablePath: this.options.invocation.executable,
            expectedEntrypointPath: this.options.invocation.argv[0],
          },
        );
        assertRuntimeCompatibilityMatchesBinding(currentCompatibility, binding);
        this.assertOpen();
        return result;
      } catch (error) {
        throw normalizeRuntimeError(error, failureMessage);
      } finally {
        try {
          unsubscribeAttached?.();
        } catch {
          // Continue releasing the attachment and client below.
        }
        if (cleanupMode === "bounded_model_reconciliation") {
          let disposal: Promise<unknown> = Promise.resolve();
          if (attached) {
            try {
              disposal = Promise.resolve(attached.dispose()).catch(() => undefined);
            } catch {
              disposal = Promise.resolve();
            }
          }
          // Closing the owned ephemeral transport immediately prevents the
          // pinned connection's default detach timeout from retaining the
          // adapter queue after reconciliation's outward deadline. The caught
          // disposal promise remains observed even if the grace race wins.
          closeDaemonClientQuietly(client);
          await settleWithinGrace(disposal, MODEL_SELECTION_EPHEMERAL_DISPOSE_GRACE_MS);
        } else {
          if (attached) await attached.dispose().catch(() => undefined);
          closeDaemonClientQuietly(client);
        }
      }
    });
  }

  endResidentSession(leaseValue: ResidentKillLease): Promise<ResidentEndAcknowledgement> {
    let lease: ResidentKillLease;
    try {
      // The private Store brand and frozen exact envelope are checked before
      // any asynchronous work. After read-only list fencing, the Store-bound
      // callback consumes ownership/freshness exactly once at the kill edge.
      lease = validateResidentKillLeaseEnvelope(leaseValue);
    } catch (error) {
      return Promise.reject(invalidResidentLifecycleAuthority(error));
    }
    return this.enqueue(() => this.endResidentSessionOnce(lease));
  }

  detachResidentSession(bindingValue: ResidentSessionBinding): Promise<void> {
    let binding: ResidentSessionBinding;
    try {
      binding = validateResidentSessionBinding(bindingValue);
    } catch (error) {
      return Promise.reject(error);
    }

    return this.enqueue(async () => {
      this.assertOpen();
      const connection = this.connections.get(binding.activeSessionId);
      if (!connection) return;
      assertExactBindingAuthority(connection.binding, binding);
      connection.forceClose();
    });
  }

  private async endResidentSessionOnce(
    lease: ResidentKillLease,
  ): Promise<ResidentEndAcknowledgement> {
    const binding = validateResidentSessionBinding(lease.binding);
    this.assertOpen();
    const localConnection = this.connections.get(binding.activeSessionId);
    if (localConnection) assertExactBindingAuthority(localConnection.binding, binding);

    let client: PrimeDaemonClientPublic | undefined;
    try {
      await this.ensureDaemonSingleFlight();
      const runtimeModule = await this.loadModule();
      const opened = await this.openValidatedClient(runtimeModule);
      client = opened.client;
      assertRuntimeCompatibilityMatchesBinding(opened.compatibility, binding);
      const response = await requestDaemon(
        client,
        { type: "list" },
        this.options.requestTimeoutMs,
        "list",
      );
      const sessions = parseLiveSessionList(response.data);
      const matchingSessions = sessions.filter(
        (candidate) => candidate.activeSessionId === binding.activeSessionId,
      );
      if (matchingSessions.length > 1) {
        throw new ResidentRuntimeContractError(
          "PRIME_RUNTIME_RESPONSE_INVALID",
          "Prime Agent returned an ambiguous resident active-session identity.",
          { details: { activeSessionId: binding.activeSessionId } },
        );
      }
      const summary = matchingSessions[0];
      if (!summary) {
        const replacement = sessions.find(
          (candidate) =>
            candidate.sessionId === binding.sessionId ||
            (binding.sessionFile !== undefined && candidate.sessionFile === binding.sessionFile),
        );
        if (replacement) {
          throw new ResidentRuntimeContractError(
            "PRIME_RUNTIME_SESSION_MISMATCH",
            "The saved Prime Agent session is active under a different runtime identity.",
            { details: { activeSessionId: binding.activeSessionId } },
          );
        }

        // Prime passivates idle workers while retaining their saved transcript.
        // A definitive exact-list absence proves there is no runtime left to
        // kill. Consume the user's one-use Store authority and complete the
        // durable end without inventing or replaying an upstream mutation.
        this.assertOpen();
        try {
          await this.options.authorizeResidentKillInvocation(lease);
        } catch (error) {
          throw invalidResidentLifecycleAuthority(error);
        }
        this.forceCloseResidentTransport(binding.activeSessionId);
        return Object.freeze({
          acknowledgementVersion: 1,
          operation: "end",
          activeSessionId: binding.activeSessionId,
          sessionId: binding.sessionId,
        });
      }
      if (summary.lifecycle === "archived") {
        // Archived is Prime's definitive no-live-root state. Verify the full
        // saved-session identity, consume the same one-use Store authority,
        // and settle locally without inventing a kill or inviting a retry.
        assertSummaryMatchesBinding(summary, binding);
        this.assertOpen();
        try {
          await this.options.authorizeResidentKillInvocation(lease);
        } catch (error) {
          throw invalidResidentLifecycleAuthority(error);
        }
        this.forceCloseResidentTransport(binding.activeSessionId);
        return Object.freeze({
          acknowledgementVersion: 1,
          operation: "end",
          activeSessionId: binding.activeSessionId,
          sessionId: binding.sessionId,
        });
      }
      assertSummaryMatchesBinding(summary, binding);

      // Store authorization is deliberately delayed until after every external
      // read/fence. It is the final await before the synchronous kill request,
      // so a lease settled while list was pending cannot mutate afterward.
      this.assertOpen();
      try {
        await this.options.authorizeResidentKillInvocation(lease);
      } catch (error) {
        throw invalidResidentLifecycleAuthority(error);
      }
      try {
        await requestResidentLifecycleKill(
          client,
          binding.activeSessionId,
          this.options.requestTimeoutMs,
        );
      } catch (error) {
        if (isUnknownMutationOutcome(error)) {
          this.forceCloseResidentTransport(binding.activeSessionId);
        }
        throw error;
      }

      this.forceCloseResidentTransport(binding.activeSessionId);
      return Object.freeze({
        acknowledgementVersion: 1,
        operation: "end",
        activeSessionId: binding.activeSessionId,
        sessionId: binding.sessionId,
      });
    } catch (error) {
      throw normalizeRuntimeError(error, "Prime Agent resident session end failed.");
    } finally {
      // Local cleanup must never replace a confirmed acknowledgement or an
      // outcome-unknown fence with a replayable-looking failure.
      closeDaemonClientQuietly(client);
    }
  }

  private forceCloseResidentTransport(activeSessionId: string): void {
    try {
      this.connections.get(activeSessionId)?.forceClose();
    } catch {
      // Confirmed or outcome-unknown root kill authority is never weakened by
      // best-effort local transport cleanup.
    }
  }

  async isLive(threadId: string, executionGenerationId: string): Promise<boolean> {
    if (this.closeRequested || this.closed) return false;
    const connection = [...this.connections.values()].find(
      (candidate) =>
        candidate.binding.threadId === threadId &&
        candidate.binding.executionGenerationId === executionGenerationId,
    );
    return connection?.isLive() ?? false;
  }

  listResidentExtensionUiRequests(bindingValue: ResidentSessionBinding): readonly ResidentExtensionUiRequest[] {
    const binding = validateResidentSessionBinding(bindingValue);
    const connection = this.connections.get(binding.activeSessionId);
    if (
      !connection ||
      residentDispatchAuthorityFingerprint(connection.binding) !== residentDispatchAuthorityFingerprint(binding)
    ) {
      return Object.freeze([]);
    }
    return connection.listExtensionUiRequests();
  }

  reconcileAcknowledgedPromptIdle(
    leaseValue: ResidentPromptReconciliationLease,
  ): Promise<ResidentPromptIdleAuthorityEvidence> {
    if (this.closeRequested || this.closed) {
      return Promise.reject(
        new ResidentRuntimeContractError(
          "PRIME_RUNTIME_ADAPTER_CLOSED",
          "Resident runtime adapter is closed.",
        ),
      );
    }
    let lease: ResidentPromptReconciliationLease;
    try {
      lease = validateResidentPromptReconciliationLease(leaseValue);
    } catch (error) {
      return Promise.reject(error);
    }
    const connection = this.connections.get(lease.binding.activeSessionId);
    if (!connection || !isDeepStrictEqual(connection.binding, lease.binding)) {
      return Promise.reject(
        new ResidentRuntimeContractError(
          "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED",
          "The attached Prime Agent connection does not match this acknowledged prompt lease.",
          {
            retryable: false,
            details: { dispatchAttemptId: lease.attemptId },
          },
        ),
      );
    }
    return connection.reconcileAcknowledgedPromptIdle({
      reconciliationVersion: 1,
      dispatchAttemptId: lease.attemptId,
      binding: lease.binding,
      settlementCursor: lease.settlementCursor,
    });
  }

  reconcileAcknowledgedAbortIdle(
    leaseValue: ResidentAbortReconciliationLease,
  ): Promise<ResidentAbortIdleAuthorityEvidence> {
    if (this.closeRequested || this.closed) {
      return Promise.reject(
        new ResidentRuntimeContractError(
          "PRIME_RUNTIME_ADAPTER_CLOSED",
          "Resident runtime adapter is closed.",
        ),
      );
    }
    let lease: ResidentAbortReconciliationLease;
    try {
      lease = validateResidentAbortReconciliationLease(leaseValue);
    } catch (error) {
      return Promise.reject(error);
    }
    const connection = this.connections.get(lease.binding.activeSessionId);
    if (!connection || !isDeepStrictEqual(connection.binding, lease.binding)) {
      return Promise.reject(
        new ResidentRuntimeContractError(
          "PRIME_RUNTIME_ABORT_RECONCILIATION_AUTHORITY_CHANGED",
          "The attached Prime Agent connection does not match this acknowledged Stop lease.",
          {
            retryable: false,
            details: { dispatchAttemptId: lease.attemptId },
          },
        ),
      );
    }
    return connection.reconcileAcknowledgedAbortIdle({
      reconciliationVersion: 1,
      dispatchAttemptId: lease.attemptId,
      binding: lease.binding,
    });
  }

  submit(commandValue: CommandEnvelope, context?: GatewayDispatchContext): Promise<GatewayAdmission> {
    const command = CommandEnvelopeSchema.parse(commandValue);
    if (command.command.kind === "prompt" || command.command.kind === "abort") {
      return this.submitResidentDispatch(command, context?.residentDispatch);
    }
    if (command.command.kind === "extension_ui.respond") {
      return this.submitExtensionUiResponse(command, context?.extensionUiResponse);
    }
    if (command.command.kind !== "model.select") {
      return Promise.reject(
        new GatewayError(
          "RESIDENT_COMMAND_UNSUPPORTED",
          "This resident adapter checkpoint dispatches only model selection",
        ),
      );
    }
    const binding = context?.residentBinding;
    if (!binding) {
      return Promise.reject(
        new GatewayError(
          "MODEL_SELECTION_DURABLE_AUTHORITY_REQUIRED",
          "Model selection requires a durable resident dispatch authority",
        ),
      );
    }
    const durableBinding = validateResidentSessionBinding(binding);
    if (
      command.threadId !== durableBinding.threadId ||
      command.expectedExecutionGenerationId !== durableBinding.executionGenerationId
    ) {
      return Promise.reject(
        new GatewayError(
          "MODEL_SELECTION_AUTHORITY_MISMATCH",
          "Model selection does not match its durable resident authority",
        ),
      );
    }
    const connection = this.connections.get(durableBinding.activeSessionId);
    if (!connection || !isDeepStrictEqual(connection.binding, durableBinding)) {
      return Promise.reject(
        new GatewayError(
          "MODEL_SELECTION_BINDING_MISMATCH",
          "The live Prime Agent connection does not match the admitted resident binding",
          true,
        ),
      );
    }

    const identity = JSON.stringify([command.deviceId, command.commandId]);
    const existing = this.modelSelectionAttempts.get(identity);
    if (existing) {
      if (
        !isDeepStrictEqual(existing.command, command) ||
        !isDeepStrictEqual(existing.binding, durableBinding)
      ) {
        return Promise.reject(
          new GatewayError("COMMAND_ID_REUSED", "This command identity is already bound to another model selection"),
        );
      }
      return existing.result;
    }
    if (this.modelSelectionAttempts.size >= MAX_MODEL_SELECTION_IDENTITIES) {
      return Promise.reject(
        new GatewayError(
          "MODEL_SELECTION_IDENTITY_LIMIT",
          "The resident model-selection identity ledger reached its bounded limit",
          true,
        ),
      );
    }

    const result = connection
      .selectModel(command, durableBinding)
      .then(() => ({
        disposition: "handled" as const,
        message: "Prime Agent selected and verified the requested model",
      }));
    this.modelSelectionAttempts.set(
      identity,
      Object.freeze({ command: Object.freeze(command), binding: durableBinding, result }),
    );
    return result;
  }

  private submitExtensionUiResponse(
    command: CommandEnvelope,
    leaseValue: ExtensionUiResponseLease | undefined,
  ): Promise<GatewayAdmission> {
    if (command.command.kind !== "extension_ui.respond") {
      return Promise.reject(new GatewayError(
        "EXTENSION_UI_RESPONSE_COMMAND_REQUIRED",
        "This dispatch path accepts only extension UI responses",
      ));
    }
    const responseCommand = command.command;
    let lease: ExtensionUiResponseLease;
    try {
      if (!leaseValue) throw new Error("missing lease");
      lease = validateExtensionUiResponseLease(leaseValue);
    } catch (error) {
      return Promise.reject(new GatewayError(
        "EXTENSION_UI_RESPONSE_DURABLE_AUTHORITY_REQUIRED",
        "Extension UI response requires exact durable no-replay authority",
        false,
        false,
        { cause: error },
      ));
    }
    if (!isDeepStrictEqual(lease.command, command)) {
      return Promise.reject(new GatewayError(
        "EXTENSION_UI_RESPONSE_AUTHORITY_MISMATCH",
        "Extension UI response changed after durable admission",
      ));
    }
    const connection = this.connections.get(lease.binding.activeSessionId);
    if (!connection || !isDeepStrictEqual(connection.binding, lease.binding)) {
      return Promise.reject(new GatewayError(
        "EXTENSION_UI_RESPONSE_BINDING_MISMATCH",
        "The live Prime Agent connection no longer owns this dialog",
        false,
      ));
    }
    const request = connection.listExtensionUiRequests().find(
      (candidate) =>
        candidate.requestId === responseCommand.requestId &&
        candidate.requestDigest === responseCommand.requestDigest &&
        candidate.method === responseCommand.method &&
        candidate.bindingFingerprint === lease.bindingFingerprint,
    );
    if (!request) {
      return Promise.reject(new GatewayError(
        "EXTENSION_UI_REQUEST_EXPIRED",
        "The extension UI request disappeared before its response was sent",
        false,
      ));
    }
    return connection.respondToExtensionUiRequest(request, responseCommand.response).then(() => ({
      disposition: "handled" as const,
      message: "Prime Agent acknowledged the dialog response",
    })).catch((error: unknown) => {
      if (error instanceof ResidentRuntimeContractError) {
        throw new GatewayError(error.code, error.message, error.retryable, error.code === "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN", {
          cause: error,
        });
      }
      throw new GatewayError(
        "EXTENSION_UI_RESPONSE_OUTCOME_UNKNOWN",
        "Prime Agent did not provide a definitive dialog response acknowledgement",
        false,
        true,
        { cause: error },
      );
    });
  }

  private submitResidentDispatch(
    command: CommandEnvelope,
    leaseValue: ResidentDispatchLease | undefined,
  ): Promise<GatewayAdmission> {
    if (command.command.kind !== "prompt" && command.command.kind !== "abort") {
      return Promise.reject(new GatewayError(
        "RESIDENT_COMMAND_UNSUPPORTED",
        "The durable resident dispatch lease supports only prompt and stop",
      ));
    }
    let durableLease: ResidentDispatchLease;
    try {
      if (!leaseValue) throw new Error("missing lease");
      durableLease = validateResidentDispatchLease(leaseValue);
    } catch {
      return Promise.reject(new GatewayError(
        "RESIDENT_DISPATCH_DURABLE_AUTHORITY_REQUIRED",
        "Resident prompt and stop commands require an opaque durable dispatch lease",
      ));
    }
    if (!isDeepStrictEqual(durableLease.command, command)) {
      return Promise.reject(new GatewayError(
        "RESIDENT_DISPATCH_COMMAND_MISMATCH",
        "The resident dispatch lease belongs to a different immutable command envelope",
      ));
    }
    const operation = command.command.kind;
    const connection = this.connections.get(durableLease.binding.activeSessionId);
    if (
      !connection ||
      residentDispatchAuthorityFingerprint(connection.binding) !== durableLease.bindingFingerprint ||
      residentDispatchAuthorityFingerprint(durableLease.binding) !== durableLease.bindingFingerprint
    ) {
      return Promise.reject(new GatewayError(
        "RESIDENT_DISPATCH_BINDING_MISMATCH",
        "The live Prime Agent connection no longer matches the durable resident authority",
        false,
      ));
    }
    const runtimeLease = validateResidentGenerationDispatchLease({
      leaseVersion: 1,
      dispatchAttemptId: durableLease.attemptId,
      commandFingerprint: residentCommandEnvelopeFingerprint(command),
      operation,
      // Supervisor reconnect metadata may refresh while the immutable session
      // authority remains the same. Bind the one-shot call to the connection's
      // current validated record after comparing the stable authority digest.
      binding: connection.binding,
    });
    const result = operation === "prompt"
      ? connection.prompt(command.command.kind === "prompt" ? command.command.text : "", runtimeLease)
      : connection.abort(runtimeLease);
    return result.then((admission) => {
      if (admission.operation !== operation) {
        throw new GatewayError(
          "RESIDENT_DISPATCH_ACK_INVALID",
          "Prime Agent returned an acknowledgement for a different resident operation",
          false,
          true,
        );
      }
      if (operation === "prompt" && admission.disposition === "accepted") {
        return {
          disposition: "accepted" as const,
          message: "Prime Agent owns the prompt; turn completion follows from authoritative runtime state",
        };
      }
      if (operation === "abort" && admission.disposition === "not_needed") {
        return {
          disposition: "handled" as const,
          message: "Prompt admission was cancelled before the runtime owned it",
        };
      }
      if (operation === "abort" && admission.disposition === "accepted") {
        return {
          disposition: "handled" as const,
          message: "Prime Agent accepted the stop request; authoritative runtime state will confirm idleness",
        };
      }
      throw new GatewayError(
        "RESIDENT_DISPATCH_ACK_INVALID",
        "Prime Agent returned an invalid resident command acknowledgement",
        false,
        true,
      );
    }).catch((error: unknown) => {
      if (error instanceof GatewayError) throw error;
      if (error instanceof ResidentRuntimeContractError) {
        const uncertain = error.code === "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN";
        throw new GatewayError(
          error.code,
          boundedGatewayMessage(error.message, "Prime Agent resident dispatch failed"),
          uncertain ? false : error.retryable,
          uncertain,
        );
      }
      throw new GatewayError(
        "RESIDENT_DISPATCH_OUTCOME_UNKNOWN",
        "Prime Agent may have received the resident command, but no authoritative acknowledgement is available",
        false,
        true,
      );
    });
  }

  close(): Promise<void> {
    this.closeRequested = true;
    this.closePromise ??= this.enqueue(async () => {
      if (this.closed) return;
      await this.daemonEnsurePromise?.catch(() => undefined);
      const connections = [...this.connections.values()];
      const candidates = [...this.ownedCandidates];
      const [connectionOutcomes, candidateOutcomes] = await Promise.all([
        Promise.allSettled(connections.map((connection) => connection.detach())),
        Promise.allSettled(candidates.map((candidate) => candidate.dispose())),
      ]);
      connectionOutcomes.forEach((outcome, index) => {
        if (outcome.status === "rejected") connections[index]?.forceClose();
      });
      this.connections.clear();
      this.ownedCandidates.clear();
      this.modelSelectionAttempts.clear();
      this.closed = true;
      const failure = [...connectionOutcomes, ...candidateOutcomes].find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      if (failure) {
        const error = normalizeRuntimeError(failure.reason, "Prime Agent connection detach failed during adapter close.");
        this.lifecycle.transition("failed", { error: error.toJSON() });
        throw error;
      }
      this.lifecycle.transition("closed");
    });
    return this.closePromise;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (!this.closeRequested && !this.closed) return;
    throw new ResidentRuntimeContractError("PRIME_RUNTIME_ADAPTER_CLOSED", "Resident runtime adapter is closed.");
  }

  private async loadModule(): Promise<PrimeAgentPublicModule> {
    this.modulePromise ??= Promise.resolve()
      .then(this.options.loadRuntimeModule)
      .then(validatePrimeAgentPublicModule)
      .catch((error) => {
        this.modulePromise = undefined;
        if (error instanceof ResidentRuntimeContractError) throw error;
        throw new ResidentRuntimeContractError(
          "PRIME_RUNTIME_MODULE_INVALID",
          "The verified Prime Agent runtime module could not be loaded.",
          { details: { cause: errorMessage(error) }, cause: error },
        );
      });
    return this.modulePromise;
  }

  private ensureDaemonSingleFlight(): Promise<ResidentRuntimeCompatibility> {
    this.assertOpen();
    if (this.daemonEnsurePromise) return this.daemonEnsurePromise;
    const operation = this.ensureDaemonOnce();
    this.daemonEnsurePromise = operation;
    const clear = (): void => {
      if (this.daemonEnsurePromise === operation) this.daemonEnsurePromise = undefined;
    };
    operation.then(clear, clear);
    return operation;
  }

  private async ensureDaemonOnce(): Promise<ResidentRuntimeCompatibility> {
    const runtimeModule = await this.loadModule();
    this.lifecycle.transition("validating_daemon");
    try {
      const inspected = await this.openClientForEnsure(runtimeModule);
      if ("compatibility" in inspected) {
        inspected.client.close();
        this.lifecycle.transition("ready");
        return inspected.compatibility;
      }
      await this.retireIncompatibleDaemon(runtimeModule, inspected);
    } catch (error) {
      if (!(error instanceof DaemonUnavailableError)) throw error;
      if (!error.definitiveAbsence) {
        throw new ResidentRuntimeContractError(
          "PRIME_RUNTIME_UNAVAILABLE",
          "The Prime Agent daemon endpoint did not definitively report that it was absent.",
          { details: { cause: errorMessage(error.cause) }, cause: error },
        );
      }
    }

    this.lifecycle.transition("starting_daemon");
    const launcher = launchDaemon(this.options);
    const deadline = Date.now() + this.options.startupTimeoutMs;
    let ready = false;
    try {
      while (Date.now() <= deadline) {
        this.assertOpen();
        this.lifecycle.transition("validating_daemon");
        try {
          const opened = await this.openValidatedClient(runtimeModule);
          opened.client.close();
          ready = true;
          this.lifecycle.transition("ready");
          return opened.compatibility;
        } catch (error) {
          if (!(error instanceof DaemonUnavailableError)) throw error;
        }
        await this.options.wait(Math.min(25, Math.max(1, deadline - Date.now())));
      }
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_DAEMON_START_FAILED",
        "Timed out waiting for the Prime Agent daemon to become ready.",
        { retryable: true, details: launcher.details(), cause: launcher.failure },
      );
    } finally {
      if (!launcher.exited && !ready) launcher.child.kill();
    }
  }

  private async openClientForEnsure(
    runtimeModule: PrimeAgentPublicModule,
  ): Promise<OpenClient | IncompatibleOpenClient> {
    const client = new runtimeModule.DaemonClient(this.options.socketPath);
    try {
      await client.connect(this.options.connectTimeoutMs);
    } catch (error) {
      client.close();
      throw new DaemonUnavailableError(error);
    }

    let hello: unknown;
    try {
      hello = client.hello ?? (await client.waitForHello(this.options.connectTimeoutMs));
    } catch (error) {
      client.close();
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_HELLO_INVALID",
        "Prime Agent connected without completing a structurally verified daemon handshake.",
        { details: { cause: errorMessage(error) }, cause: error },
      );
    }

    try {
      return {
        client,
        compatibility: validateResidentDaemonHello(hello, {
          expectedSocketPath: this.options.socketPath,
          expectedExecutablePath: this.options.invocation.executable,
          expectedEntrypointPath: this.options.invocation.argv[0],
        }),
      };
    } catch (error) {
      if (!(error instanceof ResidentRuntimeContractError)) {
        client.close();
        throw error;
      }
      try {
        const retirementTarget = validateResidentDaemonRetirementHello(hello, this.options.socketPath);
        return { client, incompatibility: error, retirementTarget };
      } catch {
        client.close();
        throw error;
      }
    }
  }

  private async retireIncompatibleDaemon(
    runtimeModule: PrimeAgentPublicModule,
    opened: IncompatibleOpenClient,
  ): Promise<void> {
    let shutdownAcknowledged = false;
    let ambiguousShutdownError: unknown;
    try {
      await this.requireEmptyIncompatibleDaemon(opened);
      let response: unknown;
      try {
        // Session inventory was proven empty on this exact client and owner.
        // Never force retirement; an ordinary refusal preserves the predecessor.
        response = await opened.client.request({ type: "shutdown" }, this.options.requestTimeoutMs);
      } catch (error) {
        ambiguousShutdownError = error;
      }
      if (response !== undefined) {
        try {
          assertBoundedJson(response, 64 * 1024, "shutdown response");
          if (
            isRecord(response) &&
            response.type === "response" &&
            response.command === "shutdown" &&
            response.success === false
          ) {
            throw new ResidentRuntimeContractError(
              "PRIME_RUNTIME_DAEMON_RETIREMENT_FAILED",
              "The incompatible Prime Agent daemon refused graceful retirement.",
              {
                retryable: true,
                details: {
                  reason: "shutdown_refused",
                  incompatibility: opened.incompatibility.code,
                },
              },
            );
          }
          if (
            !isRecord(response) ||
            response.type !== "response" ||
            response.command !== "shutdown" ||
            response.success !== true
          ) {
            throw invalidResponse("shutdown");
          }
          shutdownAcknowledged = true;
        } catch (error) {
          if (
            error instanceof ResidentRuntimeContractError &&
            error.code === "PRIME_RUNTIME_DAEMON_RETIREMENT_FAILED"
          ) {
            throw error;
          }
          ambiguousShutdownError = error;
        }
      }
    } finally {
      opened.client.close();
    }

    const retired = await this.waitForExactEndpointRetirement(runtimeModule);
    if (retired) return;
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_DAEMON_RETIREMENT_FAILED",
      "The incompatible Prime Agent daemon did not prove bounded endpoint retirement.",
      {
        retryable: true,
        details: {
          reason: "endpoint_retirement_unproven",
          shutdownAcknowledged,
          incompatibility: opened.incompatibility.code,
          ...(ambiguousShutdownError ? { cause: errorMessage(ambiguousShutdownError) } : {}),
        },
        cause: ambiguousShutdownError ?? opened.incompatibility,
      },
    );
  }

  private async requireEmptyIncompatibleDaemon(opened: IncompatibleOpenClient): Promise<void> {
    let response: unknown;
    try {
      response = await opened.client.request(
        { type: "list", includeClientOwned: true },
        this.options.requestTimeoutMs,
      );
    } catch (cause) {
      throw incompatibleDaemonRetirementFailure(
        opened,
        "session_inventory_unproven",
        "The incompatible Prime Agent daemon session inventory could not be proven empty.",
        cause,
      );
    }

    try {
      assertBoundedJson(response, 64 * 1024, "incompatible daemon list response");
      if (
        !isRecord(response) ||
        response.type !== "response" ||
        response.command !== "list" ||
        response.success !== true ||
        !isRecord(response.data) ||
        JSON.stringify(Object.keys(response.data).sort()) !==
          JSON.stringify(["busyClientOwnedSessionCount", "sessions"]) ||
        !Array.isArray(response.data.sessions) ||
        response.data.sessions.length > MAX_LIVE_SESSIONS ||
        !Number.isSafeInteger(response.data.busyClientOwnedSessionCount) ||
        (response.data.busyClientOwnedSessionCount as number) < 0 ||
        (response.data.busyClientOwnedSessionCount as number) > MAX_LIVE_SESSIONS
      ) {
        throw invalidResponse("list");
      }
      if (
        response.data.sessions.length !== 0 ||
        response.data.busyClientOwnedSessionCount !== 0
      ) {
        throw incompatibleDaemonRetirementFailure(
          opened,
          "sessions_present",
          "The incompatible Prime Agent daemon still owns sessions and was preserved.",
          undefined,
          {
            sessionCount: response.data.sessions.length,
            busyClientOwnedSessionCount: response.data.busyClientOwnedSessionCount as number,
          },
        );
      }
      const currentTarget = validateResidentDaemonRetirementHello(
        opened.client.hello,
        this.options.socketPath,
      );
      if (!isDeepStrictEqual(currentTarget, opened.retirementTarget)) {
        throw incompatibleDaemonRetirementFailure(
          opened,
          "owner_identity_changed",
          "The incompatible Prime Agent daemon changed ownership identity during retirement review.",
        );
      }
    } catch (cause) {
      if (
        cause instanceof ResidentRuntimeContractError &&
        cause.code === "PRIME_RUNTIME_DAEMON_RETIREMENT_FAILED"
      ) throw cause;
      throw incompatibleDaemonRetirementFailure(
        opened,
        "session_inventory_unproven",
        "The incompatible Prime Agent daemon session inventory could not be proven empty.",
        cause,
      );
    }
  }

  private async waitForExactEndpointRetirement(runtimeModule: PrimeAgentPublicModule): Promise<boolean> {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    const maximumProbes = Math.min(
      MAX_DAEMON_RETIREMENT_PROBES,
      Math.max(1, Math.ceil(this.options.startupTimeoutMs / DAEMON_RETIREMENT_POLL_MS)),
    );
    for (let probe = 0; probe < maximumProbes && Date.now() <= deadline; probe += 1) {
      this.assertOpen();
      const client = new runtimeModule.DaemonClient(this.options.socketPath);
      try {
        await client.connect(this.options.connectTimeoutMs);
      } catch (error) {
        if (isDefinitiveEndpointAbsence(error)) return true;
      } finally {
        client.close();
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.options.wait(Math.min(DAEMON_RETIREMENT_POLL_MS, remaining));
    }
    return false;
  }

  private async openValidatedClient(
    runtimeModule: PrimeAgentPublicModule,
    timeoutMs = this.options.connectTimeoutMs,
    onClientCreated?: (client: PrimeDaemonClientPublic) => void,
  ): Promise<OpenClient> {
    const client = new runtimeModule.DaemonClient(this.options.socketPath);
    onClientCreated?.(client);
    try {
      await client.connect(timeoutMs);
    } catch (error) {
      client.close();
      throw new DaemonUnavailableError(error);
    }
    try {
      const hello = client.hello ?? (await client.waitForHello(timeoutMs));
      return {
        client,
        compatibility: validateResidentDaemonHello(hello, {
          expectedSocketPath: this.options.socketPath,
          expectedExecutablePath: this.options.invocation.executable,
          expectedEntrypointPath: this.options.invocation.argv[0],
        }),
      };
    } catch (error) {
      client.close();
      if (error instanceof ResidentRuntimeContractError) throw error;
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_HELLO_INVALID",
        "Prime Agent connected without completing the pinned daemon handshake.",
        { details: { cause: errorMessage(error) }, cause: error },
      );
    }
  }

  private attachPublicConnection(
    runtimeModule: PrimeAgentPublicModule,
    client: PrimeDaemonClientPublic,
    activeSessionId: string,
    ownedSession = false,
  ): Promise<PrimeDaemonAgentConnectionPublic> {
    return runtimeModule.DaemonAgentConnection.attach(client, activeSessionId, {
      closeClientOnDispose: true,
      sendClientEnv: false,
      supportsExtensionUi: true,
      ownedSession,
      telemetryDisabled: true,
      // Do not re-enter the adapter operation queue: recovery may be invoked
      // by static attach while create/attach itself owns that queue.
      recoverDaemon: async () => void (await this.ensureDaemonSingleFlight()),
    });
  }

  private registerConnection(
    binding: ResidentSessionBinding,
    client: PrimeDaemonClientPublic,
    attached: PrimeDaemonAgentConnectionPublic,
    initialProjection: ResidentProjectionSnapshot | undefined,
  ): ManagedResidentRuntimeConnection {
    if (this.connections.has(binding.activeSessionId)) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_SESSION_MISMATCH",
        "A resident session cannot be attached more than once by the same adapter.",
        { details: { activeSessionId: binding.activeSessionId } },
      );
    }
    const connection = new ManagedResidentRuntimeConnection({
      binding,
      hostId: this.options.hostId,
      client,
      attached,
      requestTimeoutMs: this.options.requestTimeoutMs,
      now: this.options.now,
      wait: this.options.wait,
      expectedSocketPath: this.options.socketPath,
      expectedExecutablePath: this.options.invocation.executable,
      expectedEntrypointPath: this.options.invocation.argv[0]!,
      persistBinding: this.options.persistBinding,
      publishProjection: this.options.publishProjection,
      publishModelSelectionProjection: this.options.publishModelSelectionProjection,
      publishEphemeralProjectionChange: this.options.publishEphemeralProjectionChange,
      readStableSelectedModelProjection: (selectionBinding, providerId, modelId) =>
        this.readStableSelectedModelProjection(selectionBinding, providerId, modelId),
      initialProjection,
      refreshProjectionOnStart: initialProjection === undefined,
      onClosed: () => {
        if (this.connections.get(binding.activeSessionId) === connection) {
          this.connections.delete(binding.activeSessionId);
        }
      },
    });
    this.connections.set(binding.activeSessionId, connection);
    return connection;
  }

  private fail(error: unknown, binding?: ResidentSessionBinding): ResidentRuntimeContractError {
    const normalized = normalizeRuntimeError(error, "Prime Agent resident runtime operation failed.");
    this.lifecycle.transition("failed", { binding, error: normalized.toJSON() });
    return normalized;
  }
}

type ResidentOwnedCandidateState =
  | "owned"
  | "promoting"
  | "promoted"
  | "promotion_unknown"
  | "disposed";

class ManagedResidentOwnedCandidate implements ResidentOwnedRuntimeCandidate {
  readonly [ResidentOwnedRuntimeCandidateBrand] = true as const;
  readonly candidateVersion = 1 as const;
  readonly #identity: Readonly<{
    threadId: string;
    executionGenerationId: string;
    workspaceDirectory: string;
    activeSessionId: string;
    sessionId: string;
    sessionFile?: string;
    boundAt: string;
    runtime: ResidentRuntimeCompatibility;
  }>;
  readonly #client: PrimeDaemonClientPublic;
  readonly #attached: PrimeDaemonAgentConnectionPublic;
  readonly #requestTimeoutMs: number;
  readonly #onClosed: () => void;
  #state: ResidentOwnedCandidateState = "owned";
  #residentBinding: ResidentSessionBinding | undefined;
  #promotionPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #ownedCleanupAttemptPromise: Promise<ResidentOwnedCleanupAttemptResult> | undefined;

  constructor(options: Readonly<{
    threadId: string;
    executionGenerationId: string;
    workspaceDirectory: string;
    activeSessionId: string;
    sessionId: string;
    sessionFile?: string;
    boundAt: string;
    runtime: ResidentRuntimeCompatibility;
    client: PrimeDaemonClientPublic;
    attached: PrimeDaemonAgentConnectionPublic;
    requestTimeoutMs: number;
    onClosed: () => void;
  }>) {
    this.#identity = Object.freeze({
      threadId: options.threadId,
      executionGenerationId: options.executionGenerationId,
      workspaceDirectory: options.workspaceDirectory,
      activeSessionId: options.activeSessionId,
      sessionId: options.sessionId,
      ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
      boundAt: options.boundAt,
      runtime: Object.freeze({
        ...options.runtime,
        capabilities: Object.freeze([...options.runtime.capabilities]),
      }),
    });
    this.#client = options.client;
    this.#attached = options.attached;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#onClosed = options.onClosed;
    Object.freeze(this);
  }

  get threadId(): string {
    return this.#identity.threadId;
  }

  get executionGenerationId(): string {
    return this.#identity.executionGenerationId;
  }

  get workspaceDirectory(): string {
    return this.#identity.workspaceDirectory;
  }

  get activeSessionId(): string {
    return this.#identity.activeSessionId;
  }

  get sessionId(): string {
    return this.#identity.sessionId;
  }

  get sessionFile(): string | undefined {
    return this.#identity.sessionFile;
  }

  get boundAt(): string {
    return this.#identity.boundAt;
  }

  get runtime(): ResidentRuntimeCompatibility {
    return this.#identity.runtime;
  }

  promoteToResident(): Promise<void> {
    if (this.#promotionPromise) return this.#promotionPromise;
    if (this.#disposePromise || this.#state !== "owned") {
      return Promise.reject(
        new ResidentRuntimeContractError(
          "PRIME_RUNTIME_TERMINAL_ACTION_CONFLICT",
          "This client-owned Prime Agent candidate is no longer available for promotion.",
          { details: { activeSessionId: this.activeSessionId, state: this.#state } },
        ),
      );
    }
    if (typeof this.#attached.promoteToResident !== "function") {
      return Promise.reject(
        new ResidentRuntimeContractError(
          "PRIME_RUNTIME_MODULE_INVALID",
          "The pinned Prime Agent owned connection is missing resident promotion support.",
        ),
      );
    }

    this.#state = "promoting";
    this.#promotionPromise = Promise.resolve().then(async () => {
      try {
        await awaitResidentMutationInvocation(
          this.#attached.promoteToResident(),
          this.#requestTimeoutMs,
          "owned-session promotion",
        );
      } catch (error) {
        this.#state = "promotion_unknown";
        throw unknownOwnedPromotionOutcome(this.activeSessionId, error);
      }
      this.#residentBinding = freezeBinding({
        bindingVersion: 1,
        lifecycle: "resident",
        threadId: this.threadId,
        executionGenerationId: this.executionGenerationId,
        workspaceDirectory: this.workspaceDirectory,
        activeSessionId: this.activeSessionId,
        sessionId: this.sessionId,
        ...(this.sessionFile ? { sessionFile: this.sessionFile } : {}),
        boundAt: this.boundAt,
        runtime: this.runtime,
      });
      this.#state = "promoted";
    });
    return this.#promotionPromise;
  }

  async readStableProjection(): Promise<ResidentProjectionSnapshot> {
    const binding = this.#requirePromotedBinding();
    const projection = await readStableResidentProjection(this.#attached, binding).catch((error) => {
      if (error instanceof ResidentRuntimeContractError) throw error;
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_REQUEST_FAILED",
        "Prime Agent promotion did not produce a stable authoritative snapshot.",
        { retryable: true, details: { cause: errorMessage(error) }, cause: error },
      );
    });
    if (!projection) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_RESPONSE_INVALID",
        "Prime Agent state changed throughout owned-session promotion reconciliation.",
        { details: { activeSessionId: this.activeSessionId } },
      );
    }
    return projection;
  }

  async publishStableProjection(
    publisher: (
      binding: ResidentSessionBinding,
      projection: ResidentProjectionSnapshot,
    ) => Promise<void>,
  ): Promise<ResidentProjectionSnapshot> {
    if (typeof publisher !== "function") {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_ARGUMENT_INVALID",
        "Owned-session projection publication requires a durable publisher.",
        { details: { field: "publisher" } },
      );
    }
    const binding = this.#requirePromotedBinding();
    const projection = await this.readStableProjection();
    await publishProjection(publisher, binding, projection);
    return projection;
  }

  attemptUnverifiedOwnedCleanup(): Promise<ResidentOwnedCleanupAttemptResult> {
    if (this.#ownedCleanupAttemptPromise) return this.#ownedCleanupAttemptPromise;
    if (this.#state !== "owned") {
      return Promise.reject(
        new ResidentRuntimeContractError(
          "PRIME_RUNTIME_TERMINAL_ACTION_CONFLICT",
          "Unverified owned cleanup is available only before resident promotion begins.",
          { details: { activeSessionId: this.activeSessionId, state: this.#state } },
        ),
      );
    }
    this.#ownedCleanupAttemptPromise = this.#disposeConnection().then(
      () => UNVERIFIED_OWNED_CLEANUP_ATTEMPT,
    );
    return this.#ownedCleanupAttemptPromise;
  }

  dispose(): Promise<void> {
    return this.#disposeConnection();
  }

  #requirePromotedBinding(): ResidentSessionBinding {
    if (this.#state === "promoted" && this.#residentBinding && !this.#disposePromise) {
      return this.#residentBinding;
    }
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_TERMINAL_ACTION_CONFLICT",
      "A stable resident projection is available only after confirmed promotion.",
      { details: { activeSessionId: this.activeSessionId, state: this.#state } },
    );
  }

  #disposeConnection(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    const promotionSettlement = this.#promotionPromise?.catch(() => undefined) ?? Promise.resolve();
    this.#disposePromise = promotionSettlement
      .then(async () => {
        if (this.#state === "promotion_unknown") {
          // The upstream promotion may still settle after our wrapper timed
          // out. Disposing the owned connection could race that settlement and
          // emit complete_owned_session. Abandon only this client transport.
          this.#client.close();
          return;
        }
        await this.#attached.dispose();
      })
      .catch((error) => {
        if (this.#state !== "promotion_unknown") this.#client.close();
        throw error;
      })
      .finally(() => {
        if (this.#state !== "promotion_unknown") this.#state = "disposed";
        this.#onClosed();
      });
    return this.#disposePromise;
  }
}

class ManagedResidentRuntimeConnection implements ResidentRuntimeConnection {
  private readonly lifecycle: LifecycleController;
  private bindingValue: ResidentSessionBinding;
  private unsubscribeUpstream: () => void = () => undefined;
  private eventTail: Promise<void> = Promise.resolve();
  private modelMutationTail: Promise<void> = Promise.resolve();
  private promptAdmissionTail: Promise<void> = Promise.resolve();
  private abortTail: Promise<void> = Promise.resolve();
  private residentIdleReconciliationTail: Promise<void> = Promise.resolve();
  private extensionUiResponseTail: Promise<void> = Promise.resolve();
  private promptIdleReconciliationRecord: PromptIdleReconciliationRecord | undefined;
  private abortIdleReconciliationRecord: AbortIdleReconciliationRecord | undefined;
  private residentIdleReconciliationCancellation: ResidentIdleReconciliationCancellation | undefined;
  private readonly residentDispatchAttempts = new Map<string, ResidentDispatchAttemptRecord>();
  /** Event ordinal immediately before each same-process prompt invocation. */
  private readonly promptTerminalEventBaselines = new Map<string, number>();
  private readonly settledResidentDispatchAttemptIds = new Set<string>();
  private readonly retiredResidentDispatchFence = new RetiredResidentDispatchFence();
  private readonly queuedPromptAdmissions: PromptAdmissionAttempt[] = [];
  private activePromptAdmission: PromptAdmissionAttempt | undefined;
  private uncertainPromptAdmission: PromptAdmissionAttempt | undefined;
  private cancelledPromptAdmission: PromptAdmissionAttempt | undefined;
  private authoritativeProjectionValue: ResidentProjectionSnapshot | undefined;
  private readonly observedChildAgents = new Map<string, ResidentProjectionSnapshot["childAgents"][number]>();
  private readonly extensionUiRequests = new Map<string, ResidentExtensionUiRequest>();
  private readonly extensionUiExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retiredExtensionUiRequests = new Map<string, Readonly<{
    requestDigest: string;
    method: ResidentExtensionUiRequest["method"];
  }>>();
  private readonly extensionUiResponseAttempts = new Map<string, Readonly<{
    requestDigest: string;
    responseDigest: string;
    result: Promise<void>;
  }>>();
  private upstreamEventOrdinal = 0;
  private latestTerminalAssistantEvent: Readonly<{
    ordinal: number;
    marker: ResidentTerminalAssistantMarker;
  }> | undefined;
  private readonly upstreamEventWaiters = new Set<() => void>();
  private readonly retiredAuthoritativeCursorGenerations = new Set<string>();
  private projectionRefreshRequested = false;
  private projectionRefreshPromise: Promise<void> | undefined;
  private terminalAction: "detach" | undefined;
  private terminalPromise: Promise<void> | undefined;
  private readAuthorityDisposed = false;
  private locallyClosed = false;
  private resyncValidated = false;

  constructor(
    private readonly options: Readonly<{
      binding: ResidentSessionBinding;
      hostId: string;
      client: PrimeDaemonClientPublic;
      attached: PrimeDaemonAgentConnectionPublic;
      requestTimeoutMs: number;
      now: () => Date;
      wait: (milliseconds: number) => Promise<void>;
      expectedSocketPath: string;
      expectedExecutablePath: string;
      expectedEntrypointPath: string;
      persistBinding: (binding: ResidentSessionBinding) => Promise<void>;
      publishProjection: (
        binding: ResidentSessionBinding,
        projection: ResidentProjectionSnapshot,
      ) => Promise<void>;
      publishModelSelectionProjection: (
        command: CommandEnvelope,
        binding: ResidentSessionBinding,
        projection: ResidentProjectionSnapshot,
      ) => Promise<void>;
      publishEphemeralProjectionChange: (binding: ResidentSessionBinding) => void;
      readStableSelectedModelProjection: (
        binding: ResidentSessionBinding,
        providerId: string,
        modelId: string,
      ) => Promise<ResidentProjectionSnapshot>;
      initialProjection: ResidentProjectionSnapshot | undefined;
      refreshProjectionOnStart: boolean;
      onClosed: () => void;
    }>,
  ) {
    this.bindingValue = options.binding;
    this.authoritativeProjectionValue = options.initialProjection;
    for (const child of options.initialProjection?.childAgents ?? []) {
      this.rememberObservedChildAgent(child);
    }
    this.lifecycle = new LifecycleController(options.now, "ready", options.binding);
    this.unsubscribeUpstream = options.attached.subscribe((event) => {
      const operation = this.eventTail.then(() => this.handleUpstreamEvent(event));
      this.eventTail = operation.catch((error) => this.failFromUpstream(error));
      return this.eventTail;
    });
    if (options.refreshProjectionOnStart) this.requestProjectionRefresh();
  }

  get binding(): ResidentSessionBinding {
    return this.bindingValue;
  }

  getLifecycle(): ResidentRuntimeLifecycleSnapshot {
    return this.lifecycle.get();
  }

  subscribeLifecycle(listener: ResidentRuntimeLifecycleListener): () => void {
    return this.lifecycle.subscribe(listener);
  }

  isLive(): boolean {
    return (
      !this.locallyClosed &&
      !this.terminalAction &&
      this.options.client.isConnected !== false &&
      this.lifecycle.get().state === "ready"
    );
  }

  listExtensionUiRequests(): readonly ResidentExtensionUiRequest[] {
    if (!this.isLive()) return Object.freeze([]);
    const currentTime = this.options.now().getTime();
    for (const [requestId, request] of this.extensionUiRequests) {
      if (
        request.timeoutMs !== undefined &&
        currentTime >= Date.parse(request.receivedAt) + request.timeoutMs
      ) {
        this.extensionUiRequests.delete(requestId);
        this.retireExtensionUiRequest(request);
        this.clearExtensionUiExpiryTimer(requestId);
        this.options.publishEphemeralProjectionChange(this.binding);
      }
    }
    return Object.freeze([...this.extensionUiRequests.values()]);
  }

  respondToExtensionUiRequest(
    requestValue: ResidentExtensionUiRequest,
    responseValue: ExtensionUiDialogResponse,
  ): Promise<void> {
    let request: ResidentExtensionUiRequest;
    let response: ExtensionUiDialogResponse;
    try {
      request = ResidentExtensionUiRequestSchema.parse(requestValue);
      response = ExtensionUiDialogResponseSchema.parse(responseValue);
      if (
        request.method === "select" &&
        response.kind === "value" &&
        !request.options.includes(response.value)
      ) {
        throw new ResidentRuntimeContractError(
          "PRIME_RUNTIME_DISPATCH_LEASE_INVALID",
          "The selected value is not one of the exact dialog options.",
        );
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const responseDigest = normalizedJsonDigest(response);
    const existing = this.extensionUiResponseAttempts.get(request.requestId);
    if (existing) {
      if (
        existing.requestDigest !== request.requestDigest ||
        existing.responseDigest !== responseDigest
      ) {
        return Promise.reject(new ResidentRuntimeContractError(
          "PRIME_RUNTIME_DISPATCH_LEASE_INVALID",
          "This extension UI response identity is already bound to different immutable bytes.",
          { retryable: false },
        ));
      }
      return existing.result;
    }
    const current = this.extensionUiRequests.get(request.requestId);
    if (
      !this.isLive() ||
      !current ||
      !isDeepStrictEqual(current, request) ||
      current.bindingFingerprint !== residentDispatchAuthorityFingerprint(this.binding)
    ) {
      return Promise.reject(new ResidentRuntimeContractError(
        "PRIME_RUNTIME_DISPATCH_AUTHORITY_CHANGED",
        "The extension UI request is no longer owned by this exact live resident connection.",
        { retryable: false, details: { requestId: request.requestId } },
      ));
    }
    // Store already crossed its durable no-replay boundary before the adapter
    // receives this call. Remove visibility synchronously, before this response
    // queues behind any prior dialog mutation.
    this.extensionUiRequests.delete(request.requestId);
    this.retireExtensionUiRequest(request);
    this.clearExtensionUiExpiryTimer(request.requestId);
    this.options.publishEphemeralProjectionChange(this.binding);
    const result = this.extensionUiResponseTail.then(() =>
      this.respondToExtensionUiRequestOnce(request, response),
    );
    this.extensionUiResponseTail = result.then(() => undefined, () => undefined);
    const record = Object.freeze({
      requestDigest: request.requestDigest,
      responseDigest,
      result,
    });
    this.extensionUiResponseAttempts.set(request.requestId, record);
    void result.then(
      () => {
        if (this.extensionUiResponseAttempts.get(request.requestId) === record) {
          this.extensionUiResponseAttempts.delete(request.requestId);
        }
      },
      () => {
        if (this.extensionUiResponseAttempts.get(request.requestId) === record) {
          this.extensionUiResponseAttempts.delete(request.requestId);
        }
      },
    );
    return result;
  }

  selectModel(
    commandValue: CommandEnvelope,
    expectedBinding: ResidentSessionBinding,
  ): Promise<SanitizedResidentModelIdentity> {
    const command = CommandEnvelopeSchema.parse(commandValue);
    if (command.command.kind !== "model.select") {
      return Promise.reject(
        new GatewayError("MODEL_SELECTION_COMMAND_REQUIRED", "Resident model selection requires an exact model.select command"),
      );
    }
    const selection = ModelSelectionIdentitySchema.parse({
      provider: command.command.providerId,
      id: command.command.modelId,
    });
    const durableBinding = validateResidentSessionBinding(expectedBinding);
    if (
      command.threadId !== durableBinding.threadId ||
      command.expectedExecutionGenerationId !== durableBinding.executionGenerationId
    ) {
      return Promise.reject(
        new GatewayError("MODEL_SELECTION_AUTHORITY_MISMATCH", "Model selection does not match its durable resident authority"),
      );
    }
    return this.enqueueModelMutation(() => this.selectModelOnce(
      command,
      selection.provider,
      selection.id,
      durableBinding,
    ));
  }

  prompt(
    messageValue: string,
    leaseValue: ResidentGenerationDispatchLease,
  ): Promise<ResidentDispatchResult> {
    try {
      const message = boundedResidentPrompt(messageValue);
      const lease = validateResidentGenerationDispatchLease(leaseValue);
      return this.dispatchResidentMutation(
        "prompt",
        lease,
        residentPromptFingerprint(message),
        (admission) => {
          if (!admission) throw new Error("Prompt admission placeholder is missing.");
          return this.invokePromptOnce(message, lease, admission);
        },
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  abort(leaseValue: ResidentGenerationDispatchLease): Promise<ResidentDispatchResult> {
    try {
      const lease = validateResidentGenerationDispatchLease(leaseValue);
      return this.dispatchResidentMutation("abort", lease, "abort", (promptAdmission) =>
        this.abortOnce(lease, promptAdmission),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  reconcileAcknowledgedPromptIdle(
    requestValue: ResidentPromptIdleReconciliationRequest,
  ): Promise<ResidentPromptIdleAuthorityEvidence> {
    let request: ResidentPromptIdleReconciliationRequest;
    try {
      request = validateResidentPromptIdleReconciliationRequest(requestValue);
      this.assertPromptIdleReconciliationAuthority(request);
    } catch (error) {
      return Promise.reject(error);
    }

    const existing = this.promptIdleReconciliationRecord;
    if (existing?.request.dispatchAttemptId === request.dispatchAttemptId) {
      if (!isDeepStrictEqual(existing.request, request)) {
        return Promise.reject(
          new ResidentRuntimeContractError(
            "COMMAND_ID_REUSED",
            "This prompt idle-reconciliation identity is already bound to different resident authority.",
            { details: { dispatchAttemptId: request.dispatchAttemptId } },
          ),
        );
      }
      return existing.result;
    }

    const terminalEventBaseline = this.promptTerminalEventBaselines.get(request.dispatchAttemptId);
    const result = this.enqueueResidentIdleReconciliation(() =>
      this.reconcileAcknowledgedPromptIdleOnce(request, terminalEventBaseline),
    );
    const record = Object.freeze({ request, result });
    this.promptIdleReconciliationRecord = record;
    void result.catch(() => {
      if (this.promptIdleReconciliationRecord === record) {
        this.promptIdleReconciliationRecord = undefined;
      }
    });
    return result;
  }

  reconcileAcknowledgedAbortIdle(
    requestValue: ResidentAbortIdleReconciliationRequest,
  ): Promise<ResidentAbortIdleAuthorityEvidence> {
    let request: ResidentAbortIdleReconciliationRequest;
    try {
      request = validateResidentAbortIdleReconciliationRequest(requestValue);
      this.assertAbortIdleReconciliationAuthority(request);
    } catch (error) {
      return Promise.reject(error);
    }

    const existing = this.abortIdleReconciliationRecord;
    if (existing?.request.dispatchAttemptId === request.dispatchAttemptId) {
      if (!isDeepStrictEqual(existing.request, request)) {
        return Promise.reject(
          new ResidentRuntimeContractError(
            "COMMAND_ID_REUSED",
            "This Stop idle-reconciliation identity is already bound to different resident authority.",
            { details: { dispatchAttemptId: request.dispatchAttemptId } },
          ),
        );
      }
      return existing.result;
    }

    const result = this.enqueueResidentIdleReconciliation(() =>
      this.reconcileAcknowledgedAbortIdleOnce(request),
    );
    const record = Object.freeze({ request, result });
    this.abortIdleReconciliationRecord = record;
    void result.catch(() => {
      if (this.abortIdleReconciliationRecord === record) {
        this.abortIdleReconciliationRecord = undefined;
      }
    });
    return result;
  }

  detach(): Promise<void> {
    return this.runDetachTerminal(async () => {
      this.lifecycle.transition("detaching", { binding: this.binding });
      await this.disposeReadAuthorityAndDrainReconciliation();
      await this.drainProjectionRefresh();
    });
  }

  forceClose(): void {
    if (this.locallyClosed) return;
    this.locallyClosed = true;
    this.projectionRefreshRequested = false;
    this.unsubscribeUpstream();
    this.clearExtensionUiRequests();
    closeDaemonClientQuietly(this.options.client);
    this.cancelResidentIdleReconciliation();
    this.lifecycle.transition("closed", { binding: this.binding });
    this.options.onClosed();
  }

  private dispatchResidentMutation(
    operation: ResidentDispatchOperation,
    lease: ResidentGenerationDispatchLease,
    payloadFingerprint: string,
    dispatch: (promptAdmission?: PromptAdmissionAttempt) => Promise<ResidentDispatchResult>,
  ): Promise<ResidentDispatchResult> {
    if (lease.operation !== operation) {
      return Promise.reject(
        new ResidentRuntimeContractError(
          "PRIME_RUNTIME_DISPATCH_LEASE_INVALID",
          "The resident dispatch lease does not authorize this operation.",
          {
            details: {
              dispatchAttemptId: lease.dispatchAttemptId,
              expectedOperation: operation,
              receivedOperation: lease.operation,
            },
          },
        ),
      );
    }

    const existing = this.residentDispatchAttempts.get(lease.dispatchAttemptId);
    if (existing) {
      if (
        existing.payloadFingerprint !== payloadFingerprint ||
        !isDeepStrictEqual(existing.lease, lease)
      ) {
        return Promise.reject(
          new ResidentRuntimeContractError(
            "COMMAND_ID_REUSED",
            "This resident dispatch identity is already bound to a different operation, payload, or authority.",
            { details: { dispatchAttemptId: lease.dispatchAttemptId } },
          ),
        );
      }
      return existing.result;
    }
    if (this.retiredResidentDispatchFence.has(lease.dispatchAttemptId)) {
      return Promise.reject(
        new ResidentRuntimeContractError(
          "PRIME_RUNTIME_DISPATCH_RETIRED",
          "This resident dispatch identity is retired and cannot regain an upstream invocation.",
          {
            retryable: false,
            details: { dispatchAttemptId: lease.dispatchAttemptId },
          },
        ),
      );
    }
    this.retireSettledResidentDispatchAttempts();
    if (this.residentDispatchAttempts.size >= MAX_RESIDENT_DISPATCH_IDENTITIES) {
      return Promise.reject(
        new ResidentRuntimeContractError(
          "PRIME_RUNTIME_DISPATCH_IDENTITY_LIMIT",
          "Every bounded resident dispatch slot is occupied by an unresolved attempt.",
          { details: { limit: MAX_RESIDENT_DISPATCH_IDENTITIES } },
        ),
      );
    }

    let result: Promise<ResidentDispatchResult>;
    if (operation === "prompt") {
      if (this.uncertainPromptAdmission) {
        result = Promise.reject(
          unknownResidentMutationOutcome(
            "prompt",
            lease.dispatchAttemptId,
            new Error("A previous prompt admission remains uncertain."),
          ),
        );
      } else {
        this.cancelledPromptAdmission = undefined;
        const admission = createPromptAdmissionAttempt(
          lease,
          this.authoritativeProjectionValue?.cursor,
        );
        this.queuedPromptAdmissions.push(admission);
        this.activePromptAdmission ??= admission;
        result = this.enqueuePromptAdmission(() => this.promptOnce(
          lease,
          admission,
          () => dispatch(admission),
        ));
      }
    } else {
      const promptAdmission =
        this.activePromptAdmission ?? this.uncertainPromptAdmission ?? this.cancelledPromptAdmission;
      if (promptAdmission && this.activePromptAdmission === promptAdmission) {
        try {
          this.assertResidentDispatchAuthority(lease, "abort");
          // The signal belongs to the already-invoked prompt admission. Abort
          // it synchronously so Stop is never queued behind model work.
          for (const queuedAdmission of this.queuedPromptAdmissions) {
            queuedAdmission.controller.abort();
          }
        } catch (error) {
          result = Promise.reject(error);
          return this.rememberResidentDispatchAttempt(lease, payloadFingerprint, result);
        }
      }
      result = this.enqueueAbort(() => dispatch(promptAdmission));
    }
    return this.rememberResidentDispatchAttempt(lease, payloadFingerprint, result);
  }

  private rememberResidentDispatchAttempt(
    lease: ResidentGenerationDispatchLease,
    payloadFingerprint: string,
    result: Promise<ResidentDispatchResult>,
  ): Promise<ResidentDispatchResult> {
    const record = Object.freeze({ lease, payloadFingerprint, result });
    this.residentDispatchAttempts.set(lease.dispatchAttemptId, record);
    void result.then(
      () => this.markResidentDispatchAttemptSettled(lease.dispatchAttemptId, record),
      () => this.markResidentDispatchAttemptSettled(lease.dispatchAttemptId, record),
    );
    return result;
  }

  private markResidentDispatchAttemptSettled(
    dispatchAttemptId: string,
    record: ResidentDispatchAttemptRecord,
  ): void {
    if (this.residentDispatchAttempts.get(dispatchAttemptId) !== record) return;
    this.settledResidentDispatchAttemptIds.add(dispatchAttemptId);
  }

  private retireSettledResidentDispatchAttempts(): void {
    while (
      this.residentDispatchAttempts.size >= MAX_RESIDENT_DISPATCH_IDENTITIES &&
      this.settledResidentDispatchAttemptIds.size > 0
    ) {
      const dispatchAttemptId = this.settledResidentDispatchAttemptIds.values().next().value as
        | string
        | undefined;
      if (!dispatchAttemptId) return;
      this.settledResidentDispatchAttemptIds.delete(dispatchAttemptId);
      if (!this.residentDispatchAttempts.delete(dispatchAttemptId)) continue;
      this.promptTerminalEventBaselines.delete(dispatchAttemptId);
      this.retiredResidentDispatchFence.add(dispatchAttemptId);
    }
  }

  private enqueueModelMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.modelMutationTail.then(mutation);
    this.modelMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private enqueuePromptAdmission<T>(mutation: () => Promise<T>): Promise<T> {
    // Prompt admission and model selection share one normal-priority lane so
    // a turn cannot race a model mutation/reconciliation. Stop has its own
    // priority lane and never waits behind this chain.
    const result = this.modelMutationTail.then(mutation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.modelMutationTail = settled;
    this.promptAdmissionTail = settled;
    return result;
  }

  private enqueueAbort<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.abortTail.then(mutation);
    this.abortTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private enqueueResidentIdleReconciliation<T>(reconciliation: () => Promise<T>): Promise<T> {
    const result = this.residentIdleReconciliationTail.then(reconciliation);
    this.residentIdleReconciliationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async respondToExtensionUiRequestOnce(
    request: ResidentExtensionUiRequest,
    response: ExtensionUiDialogResponse,
  ): Promise<void> {
    if (
      !this.isLive() ||
      request.threadId !== this.binding.threadId ||
      request.executionGenerationId !== this.binding.executionGenerationId ||
      request.bindingFingerprint !== residentDispatchAuthorityFingerprint(this.binding)
    ) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_DISPATCH_AUTHORITY_CHANGED",
        "The extension UI request is no longer owned by this exact live resident connection.",
        { retryable: false, details: { requestId: request.requestId } },
      );
    }
    const respond = this.options.attached.respondToExtensionUiRequest;
    if (typeof respond !== "function") {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_MODULE_INVALID",
        "The verified Prime Agent connection does not expose extension UI response admission.",
      );
    }
    const upstreamResponse = extensionUiResponseForUpstream(request.method, response);
    let invocation: Promise<void>;
    try {
      invocation = respond.call(this.options.attached, request.requestId, upstreamResponse);
    } catch (error) {
      throw unknownExtensionUiResponseOutcome(request.requestId, error);
    }
    try {
      await awaitResidentMutationInvocation(
        invocation,
        this.options.requestTimeoutMs,
        "extension UI response",
      );
    } catch (error) {
      throw unknownExtensionUiResponseOutcome(request.requestId, error);
    }
  }

  private async reconcileAcknowledgedPromptIdleOnce(
    request: ResidentPromptIdleReconciliationRequest,
    terminalEventBaseline: number | undefined,
  ): Promise<ResidentPromptIdleAuthorityEvidence> {
    const expectedBinding = this.assertPromptIdleReconciliationAuthority(request);
    const waitForIdle = this.options.attached.waitForIdle;
    if (typeof waitForIdle !== "function") {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_MODULE_INVALID",
        "The verified Prime Agent connection does not expose its public idle barrier.",
      );
    }

    const cancellation = createResidentIdleReconciliationCancellation();
    this.residentIdleReconciliationCancellation = cancellation;
    try {
      if (terminalEventBaseline !== undefined) {
        return await this.reconcilePromptFromTerminalEvent(
          request,
          expectedBinding,
          terminalEventBaseline,
          cancellation,
        );
      }
      // Recovery is reserved for a process that did not observe this prompt's
      // admission. Bound the wrapper so a daemon's 24-hour public timeout can
      // never become the host reconciliation deadline.
      await Promise.race([
        awaitResidentMutationInvocation(
          waitForIdle.call(this.options.attached),
          this.options.requestTimeoutMs,
          "prompt idle recovery",
        ),
        cancellation.promise,
      ]);
    } catch (error) {
      this.assertPromptIdleReconciliationAuthority(request);
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_REQUEST_FAILED",
        "Prime Agent's public idle barrier failed during acknowledged prompt reconciliation.",
        {
          retryable: true,
          details: { dispatchAttemptId: request.dispatchAttemptId, cause: errorMessage(error) },
          cause: error,
        },
      );
    } finally {
      if (this.residentIdleReconciliationCancellation === cancellation) {
        this.residentIdleReconciliationCancellation = undefined;
      }
    }

    // Observe a terminal fence before waiting on any secondary event or
    // projection work. Shutdown must not inherit Prime's long idle timeout if
    // the idle response and terminal action race in the same turn.
    this.assertPromptIdleReconciliationAuthority(request);
    await this.drainResidentEventAndProjectionWork();
    this.assertPromptIdleReconciliationAuthority(request);

    const stableProjection = await readStableResidentProjection(this.options.attached, expectedBinding);
    const projection = stableProjection ? this.overlayObservedChildAgents(stableProjection) : undefined;
    if (!projection) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_PROMPT_IDLE_NOT_OBSERVED",
        "Prime Agent state did not stabilize after its acknowledged prompt crossed the idle barrier.",
        { retryable: true, details: { dispatchAttemptId: request.dispatchAttemptId } },
      );
    }
    this.assertPromptIdleReconciliationAuthority(request);
    if (!residentProjectionProvesIdle(projection)) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_PROMPT_IDLE_NOT_OBSERVED",
        "Prime Agent's authoritative projection remained active after its idle barrier resolved.",
        { retryable: true, details: { dispatchAttemptId: request.dispatchAttemptId } },
      );
    }

    // This publication is intentionally not cursor-deduplicated. A handled
    // prompt may cross the public idle barrier without emitting any event, so
    // the unchanged cursor is part of the attempt-scoped authority evidence.
    await publishProjection(this.options.publishProjection, expectedBinding, projection);
    this.assertPromptIdleReconciliationAuthority(request);
    this.acceptAuthoritativeProjection(projection);
    return Object.freeze({
      evidenceVersion: 1,
      dispatchAttemptId: request.dispatchAttemptId,
      binding: expectedBinding,
      projection,
    });
  }

  private async reconcilePromptFromTerminalEvent(
    request: ResidentPromptIdleReconciliationRequest,
    expectedBinding: ResidentSessionBinding,
    terminalEventBaseline: number,
    cancellation: ResidentIdleReconciliationCancellation,
  ): Promise<ResidentPromptIdleAuthorityEvidence> {
    let observedOrdinal = terminalEventBaseline;
    for (
      let attempt = 0;
      attempt < MAX_TERMINAL_EVENT_PROJECTION_ATTEMPTS;
      attempt += 1
    ) {
      this.assertPromptIdleReconciliationAuthority(request);
      const terminal = this.latestTerminalAssistantEvent;
      if (terminal && terminal.ordinal > terminalEventBaseline) {
        const stableProjection = await readStableResidentProjection(this.options.attached, expectedBinding);
        const projection = stableProjection ? this.overlayObservedChildAgents(stableProjection) : undefined;
        if (
          projection &&
          residentProjectionCursorAdvances(
            request.settlementCursor,
            projection.cursor,
            this.retiredAuthoritativeCursorGenerations,
          ) &&
          projection.terminalAssistant &&
          isDeepStrictEqual(projection.terminalAssistant, terminal.marker) &&
          residentProjectionProvesIdle(projection)
        ) {
          await publishProjection(this.options.publishProjection, expectedBinding, projection);
          this.assertPromptIdleReconciliationAuthority(request);
          this.acceptAuthoritativeProjection(projection);
          return Object.freeze({
            evidenceVersion: 1,
            dispatchAttemptId: request.dispatchAttemptId,
            binding: expectedBinding,
            projection,
            terminalAssistant: Object.freeze({
              blockId: requireTerminalAssistantBlockId(projection, request.dispatchAttemptId),
              stopReason: projection.terminalAssistant.stopReason,
            }),
          });
        }
      }
      observedOrdinal = this.upstreamEventOrdinal;
      await this.waitForUpstreamEventOrBackoffAfter(observedOrdinal, cancellation);
    }
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_PROMPT_IDLE_NOT_OBSERVED",
      "Prime Agent's terminal event did not converge to a stable authoritative idle projection.",
      { retryable: true, details: { dispatchAttemptId: request.dispatchAttemptId } },
    );
  }

  private assertPromptIdleReconciliationAuthority(
    request: ResidentPromptIdleReconciliationRequest,
  ): ResidentSessionBinding {
    if (
      this.locallyClosed ||
      this.terminalAction ||
      !this.isLive() ||
      !isDeepStrictEqual(this.binding, request.binding)
    ) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED",
        "The live Prime Agent connection no longer matches this acknowledged prompt reconciliation.",
        {
          retryable: false,
          details: { dispatchAttemptId: request.dispatchAttemptId },
        },
      );
    }
    return this.binding;
  }

  private async reconcileAcknowledgedAbortIdleOnce(
    request: ResidentAbortIdleReconciliationRequest,
  ): Promise<ResidentAbortIdleAuthorityEvidence> {
    const expectedBinding = this.assertAbortIdleReconciliationAuthority(request);
    const waitForIdle = this.options.attached.waitForIdle;
    if (typeof waitForIdle !== "function") {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_MODULE_INVALID",
        "The verified Prime Agent connection does not expose its public idle barrier.",
      );
    }

    const cancellation = createResidentIdleReconciliationCancellation();
    this.residentIdleReconciliationCancellation = cancellation;
    try {
      await Promise.race([
        awaitResidentMutationInvocation(
          waitForIdle.call(this.options.attached),
          this.options.requestTimeoutMs,
          "Stop idle recovery",
        ),
        cancellation.promise,
      ]);
    } catch (error) {
      this.assertAbortIdleReconciliationAuthority(request);
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_REQUEST_FAILED",
        "Prime Agent's public idle barrier failed during acknowledged Stop reconciliation.",
        {
          retryable: true,
          details: { dispatchAttemptId: request.dispatchAttemptId, cause: errorMessage(error) },
          cause: error,
        },
      );
    } finally {
      if (this.residentIdleReconciliationCancellation === cancellation) {
        this.residentIdleReconciliationCancellation = undefined;
      }
    }

    this.assertAbortIdleReconciliationAuthority(request);
    await this.drainResidentEventAndProjectionWork();
    this.assertAbortIdleReconciliationAuthority(request);

    const projection = await readStableResidentProjection(this.options.attached, expectedBinding);
    if (!projection) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_ABORT_IDLE_NOT_OBSERVED",
        "Prime Agent state did not stabilize after the acknowledged Stop crossed the idle barrier.",
        { retryable: true, details: { dispatchAttemptId: request.dispatchAttemptId } },
      );
    }
    this.assertAbortIdleReconciliationAuthority(request);
    if (!residentProjectionProvesIdle(projection)) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_ABORT_IDLE_NOT_OBSERVED",
        "Prime Agent's authoritative projection remained active after the Stop idle barrier resolved.",
        { retryable: true, details: { dispatchAttemptId: request.dispatchAttemptId } },
      );
    }

    // Unlike prompt reconciliation, Store owns publication here. It alone may
    // replace a lagging active projection at an unchanged upstream cursor,
    // under the exact acknowledged-Stop lease and a crash-recoverable intent.
    this.assertAbortIdleReconciliationAuthority(request);
    this.acceptAuthoritativeProjection(projection);
    return Object.freeze({
      evidenceVersion: 1,
      dispatchAttemptId: request.dispatchAttemptId,
      binding: expectedBinding,
      projection,
    });
  }

  private assertAbortIdleReconciliationAuthority(
    request: ResidentAbortIdleReconciliationRequest,
  ): ResidentSessionBinding {
    if (
      this.locallyClosed ||
      this.terminalAction ||
      !this.isLive() ||
      !isDeepStrictEqual(this.binding, request.binding)
    ) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_ABORT_RECONCILIATION_AUTHORITY_CHANGED",
        "The live Prime Agent connection no longer matches this acknowledged Stop reconciliation.",
        {
          retryable: false,
          details: { dispatchAttemptId: request.dispatchAttemptId },
        },
      );
    }
    return this.binding;
  }

  private async disposeReadAuthorityAndDrainReconciliation(): Promise<void> {
    let disposeFailure: unknown;
    if (!this.readAuthorityDisposed) {
      try {
        await this.options.attached.dispose();
      } catch (error) {
        disposeFailure = error;
        this.options.client.close();
      } finally {
        this.readAuthorityDisposed = true;
        this.unsubscribeUpstream();
        this.clearExtensionUiRequests();
      }
    }
    // A hostile or buggy public waitForIdle Promise may ignore client close.
    // The local read-only race is cancelled only after connection authority
    // has been disposed, so shutdown never waits for Prime's 24-hour timeout.
    this.cancelResidentIdleReconciliation();
    await this.residentIdleReconciliationTail;
    if (disposeFailure) throw disposeFailure;
  }

  private cancelResidentIdleReconciliation(): void {
    this.residentIdleReconciliationCancellation?.reject(
      new ResidentRuntimeContractError(
        "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED",
        "The Prime Agent connection closed before acknowledged prompt idle evidence completed.",
        { retryable: false },
      ),
    );
  }

  private requestProjectionRefresh(): void {
    if (this.locallyClosed || this.terminalAction) return;
    this.projectionRefreshRequested = true;
    if (this.projectionRefreshPromise) return;

    const operation = this.refreshProjectionOnceCoalesced().catch((error) => this.failFromUpstream(error));
    let refresh!: Promise<void>;
    refresh = operation.finally(() => {
      if (this.projectionRefreshPromise === refresh) {
        this.projectionRefreshPromise = undefined;
      }
      if (this.projectionRefreshRequested && !this.locallyClosed && !this.terminalAction) {
        this.requestProjectionRefresh();
      }
    });
    this.projectionRefreshPromise = refresh;
  }

  private async refreshProjectionOnceCoalesced(): Promise<void> {
    await this.options.wait(RESIDENT_PROJECTION_COALESCE_MS);
    if (this.locallyClosed || this.terminalAction || !this.projectionRefreshRequested) return;
    // Events observed during the coalescing window are represented by this
    // single authoritative read. Events arriving during the read/publication
    // set the bit again and schedule one later pass.
    this.projectionRefreshRequested = false;
    const expectedBinding = this.binding;
    if (!this.isLive()) return;
    const observation = await readStableOrLatestActiveResidentProjection(
      this.options.attached,
      expectedBinding,
      this.authoritativeProjectionValue,
    );
    if (!observation) {
      // A continuously advancing cursor is normal while a model streams. Do
      // not publish a torn multi-RPC projection and do not fail the resident
      // connection; retain one dirty bit and retry after the bounded backoff.
      this.projectionRefreshRequested = true;
      return;
    }
    const projection = observation.projection;
    if (
      this.locallyClosed ||
      this.terminalAction ||
      !this.isLive() ||
      !isDeepStrictEqual(this.binding, expectedBinding)
    ) {
      return;
    }
    const liveProjection = this.overlayObservedChildAgents(projection);
    const current = this.authoritativeProjectionValue;
    if (!observation.stable && current && !residentProjectionCursorAdvances(
      current.cursor,
      liveProjection.cursor,
      this.retiredAuthoritativeCursorGenerations,
    )) {
      if (!isDeepStrictEqual(current, liveProjection)) this.projectionRefreshRequested = true;
      return;
    }
    await publishProjection(this.options.publishProjection, expectedBinding, liveProjection);
    this.acceptAuthoritativeProjection(liveProjection);
  }

  private async drainProjectionRefresh(): Promise<void> {
    this.projectionRefreshRequested = false;
    await this.projectionRefreshPromise;
  }

  private async drainResidentEventAndProjectionWork(): Promise<void> {
    while (true) {
      const observedEventTail = this.eventTail;
      await observedEventTail;
      await Promise.resolve();
      await this.drainScheduledProjectionRefreshWork();
      await Promise.resolve();
      if (
        observedEventTail === this.eventTail &&
        !this.projectionRefreshRequested &&
        !this.projectionRefreshPromise
      ) {
        return;
      }
      if (this.locallyClosed || this.terminalAction) return;
    }
  }

  private async drainScheduledProjectionRefreshWork(): Promise<void> {
    while (true) {
      const refresh = this.projectionRefreshPromise;
      if (!refresh) {
        if (
          !this.projectionRefreshRequested ||
          this.locallyClosed ||
          this.terminalAction
        ) {
          return;
        }
        this.requestProjectionRefresh();
        continue;
      }
      await refresh;
      await Promise.resolve();
    }
  }

  private acceptAuthoritativeProjection(projection: ResidentProjectionSnapshot): void {
    const previousProjection = this.authoritativeProjectionValue;
    if (
      previousProjection &&
      previousProjection.cursor.generation !== projection.cursor.generation
    ) {
      if (this.retiredAuthoritativeCursorGenerations.has(projection.cursor.generation)) {
        throw new ResidentRuntimeContractError(
          "PRIME_RUNTIME_RESPONSE_INVALID",
          "Prime Agent published a cursor generation that this resident connection already retired.",
          { details: { cursorGeneration: projection.cursor.generation } },
        );
      }
      if (
        this.retiredAuthoritativeCursorGenerations.size >=
        MAX_RETIRED_RESIDENT_CURSOR_GENERATIONS
      ) {
        throw new ResidentRuntimeContractError(
          "PRIME_RUNTIME_RESPONSE_INVALID",
          "Prime Agent exhausted the bounded resident cursor-generation lineage.",
          { details: { limit: MAX_RETIRED_RESIDENT_CURSOR_GENERATIONS } },
        );
      }
      this.retiredAuthoritativeCursorGenerations.add(previousProjection.cursor.generation);
    }
    this.authoritativeProjectionValue = projection;
    if (!residentProjectionProvesActiveOwnership(projection)) return;
    for (const admission of [this.uncertainPromptAdmission, this.cancelledPromptAdmission]) {
      if (
        !admission?.baselineCursor ||
        !residentProjectionCursorAdvances(
          admission.baselineCursor,
          projection.cursor,
          this.retiredAuthoritativeCursorGenerations,
        )
      ) {
        continue;
      }
      // Durable publication of a later active state supersedes only the stale
      // prompt/Stop coupling. Exact prior dispatch results remain memoized, so
      // their identities can never regain an upstream invocation.
      if (this.uncertainPromptAdmission === admission) this.uncertainPromptAdmission = undefined;
      if (this.cancelledPromptAdmission === admission) this.cancelledPromptAdmission = undefined;
    }
  }

  private runDetachTerminal(operation: () => Promise<void>): Promise<void> {
    if (this.terminalPromise) return this.terminalPromise;
    this.terminalAction = "detach";
    // A terminal transition closes admission immediately, then drains the
    // per-session mutation tail. Queued mutations observe terminalAction and
    // fail before any upstream mutation method can be invoked.
    this.terminalPromise = Promise.all([
      this.promptAdmissionTail,
      this.abortTail,
      this.modelMutationTail,
      this.extensionUiResponseTail,
    ]).then(operation).then(
      () => {
        if (this.locallyClosed) return;
        this.locallyClosed = true;
        this.lifecycle.transition("closed", { binding: this.binding });
        this.options.onClosed();
      },
      (error) => {
        const normalized = normalizeRuntimeError(error, "Prime Agent detach failed.");
        if (this.locallyClosed) throw normalized;
        this.lifecycle.transition("failed", { binding: this.binding, error: normalized.toJSON() });
        if (normalized.code !== "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN") {
          this.terminalAction = undefined;
          this.terminalPromise = undefined;
        }
        throw normalized;
      },
    );
    return this.terminalPromise;
  }

  private async promptOnce(
    lease: ResidentGenerationDispatchLease,
    admission: PromptAdmissionAttempt,
    dispatch: () => Promise<ResidentDispatchResult>,
  ): Promise<ResidentDispatchResult> {
    if (this.activePromptAdmission !== admission) this.activePromptAdmission = admission;
    if (admission.controller.signal.aborted) {
      const cancellation = promptAdmissionStatusError("cancelled");
      admission.settle("cancelled");
      const failure = classifyPromptAdmissionFailure(lease.dispatchAttemptId, cancellation);
      this.rememberPromptAdmissionFailure(admission, failure);
      this.completePromptAdmission(admission);
      throw failure;
    }

    try {
      return await dispatch();
    } finally {
      this.completePromptAdmission(admission);
    }
  }

  private async invokePromptOnce(
    message: string,
    lease: ResidentGenerationDispatchLease,
    admission: PromptAdmissionAttempt,
  ): Promise<ResidentDispatchResult> {
    const prompt = this.options.attached.prompt;
    if (typeof prompt !== "function") {
      admission.settle("cancelled");
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_MODULE_INVALID",
        "The verified Prime Agent connection does not expose resident prompt admission.",
      );
    }

    // No await may separate this exact durable binding check from the one and
    // only public mutation invocation.
    try {
      this.assertResidentDispatchAuthority(lease, "prompt");
    } catch (error) {
      admission.settle("cancelled");
      throw error;
    }
    admission.baselineCursor = copyResidentProjectionCursor(
      this.authoritativeProjectionValue?.cursor,
    );
    // Capture before the one and only invocation so an immediately completed
    // provider turn remains eligible even if Store schedules reconciliation
    // after its terminal event has already crossed this subscription.
    this.promptTerminalEventBaselines.set(lease.dispatchAttemptId, this.upstreamEventOrdinal);
    let invocation: Promise<void>;
    try {
      invocation = prompt.call(
        this.options.attached,
        message,
        Object.freeze({ queueIfBusy: false, signal: admission.controller.signal }),
      );
    } catch (error) {
      admission.settle("unknown");
      this.uncertainPromptAdmission = admission;
      throw unknownResidentMutationOutcome("prompt", lease.dispatchAttemptId, error);
    }
    void Promise.resolve(invocation).then(
      () => admission.settle("owned"),
      (error: unknown) => admission.settle(promptAdmissionOutcomeFromError(error)),
    );
    try {
      await awaitResidentMutationInvocation(invocation, this.options.requestTimeoutMs, "prompt");
    } catch (error) {
      if (error instanceof ResidentMutationAdmissionTimeoutError) {
        // The pinned connection uses this exact signal to reconcile the same
        // admissionId as owned, cancelled, or unknown. Never invoke prompt a
        // second time: wait briefly on the original promise only.
        admission.controller.abort();
        try {
          await awaitResidentMutationInvocation(
            invocation,
            Math.min(PROMPT_ADMISSION_CANCEL_GRACE_MS, this.options.requestTimeoutMs),
            "prompt cancellation reconciliation",
          );
        } catch (reconciliationError) {
          const failure = classifyPromptAdmissionFailure(lease.dispatchAttemptId, reconciliationError);
          this.rememberPromptAdmissionFailure(admission, failure);
          throw failure;
        }
      } else {
        const failure = classifyPromptAdmissionFailure(lease.dispatchAttemptId, error);
        this.rememberPromptAdmissionFailure(admission, failure);
        throw failure;
      }
    }
    return residentDispatchAccepted("prompt");
  }

  private completePromptAdmission(admission: PromptAdmissionAttempt): void {
    const index = this.queuedPromptAdmissions.indexOf(admission);
    if (index >= 0) this.queuedPromptAdmissions.splice(index, 1);
    if (this.activePromptAdmission === admission) {
      this.activePromptAdmission = this.queuedPromptAdmissions[0];
    }
  }

  private async abortOnce(
    lease: ResidentGenerationDispatchLease,
    promptAdmission?: PromptAdmissionAttempt,
  ): Promise<ResidentDispatchResult> {
    const admission =
      promptAdmission ?? this.activePromptAdmission ?? this.uncertainPromptAdmission ?? this.cancelledPromptAdmission;
    if (admission) {
      admission.controller.abort();
      let outcome: PromptAdmissionOutcome;
      try {
        outcome = await awaitResidentMutationInvocation(
          admission.settlement,
          Math.min(PROMPT_ADMISSION_CANCEL_GRACE_MS, this.options.requestTimeoutMs),
          "prompt cancellation reconciliation",
        );
      } catch (error) {
        throw unknownResidentMutationOutcome("abort", lease.dispatchAttemptId, error);
      }
      if (outcome === "unknown") {
        throw unknownResidentMutationOutcome(
          "abort",
          lease.dispatchAttemptId,
          new Error("The preceding prompt admission outcome is unknown."),
        );
      }
      if (outcome === "cancelled") {
        return residentAbortNotNeeded();
      }
      if (this.cancelledPromptAdmission === admission) this.cancelledPromptAdmission = undefined;
      if (this.uncertainPromptAdmission === admission) this.uncertainPromptAdmission = undefined;
    }

    const abort = this.options.attached.abort;
    if (typeof abort !== "function") {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_MODULE_INVALID",
        "The verified Prime Agent connection does not expose resident abort admission.",
      );
    }

    // No await may separate this exact durable binding check from the one and
    // only public mutation invocation.
    this.assertResidentDispatchAuthority(lease, "abort");
    let invocation: Promise<void>;
    try {
      invocation = abort.call(this.options.attached);
    } catch (error) {
      throw unknownResidentMutationOutcome("abort", lease.dispatchAttemptId, error);
    }
    try {
      await awaitResidentMutationInvocation(invocation, this.options.requestTimeoutMs, "abort");
    } catch (error) {
      throw unknownResidentMutationOutcome("abort", lease.dispatchAttemptId, error);
    }
    return residentDispatchAccepted("abort");
  }

  private rememberPromptAdmissionFailure(
    admission: PromptAdmissionAttempt,
    failure: ResidentRuntimeContractError,
  ): void {
    if (failure.code === "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN") {
      this.uncertainPromptAdmission = admission;
      return;
    }
    this.cancelledPromptAdmission = admission;
  }

  private assertResidentDispatchAuthority(
    lease: ResidentGenerationDispatchLease,
    operation: ResidentDispatchOperation,
  ): void {
    if (
      lease.operation === operation &&
      this.isLive() &&
      isDeepStrictEqual(this.binding, lease.binding)
    ) {
      return;
    }
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_DISPATCH_AUTHORITY_CHANGED",
      "The admitted resident Prime Agent session is no longer live under the exact durable dispatch authority.",
      {
        retryable: false,
        details: {
          dispatchAttemptId: lease.dispatchAttemptId,
          operation,
          threadId: lease.binding.threadId,
          executionGenerationId: lease.binding.executionGenerationId,
        },
      },
    );
  }

  private async selectModelOnce(
    command: CommandEnvelope,
    providerId: string,
    modelId: string,
    expectedBinding: ResidentSessionBinding,
  ): Promise<SanitizedResidentModelIdentity> {
    this.assertModelSelectionLive(expectedBinding);
    const getAvailableModels = this.options.attached.getAvailableModels;
    const setModel = this.options.attached.setModel;
    if (typeof getAvailableModels !== "function" || typeof setModel !== "function") {
      throw new GatewayError(
        "MODEL_SELECTION_UNSUPPORTED",
        "The verified Prime Agent connection does not support resident model selection",
      );
    }

    let availableModels: readonly SanitizedResidentModelIdentity[];
    try {
      availableModels = sanitizeAvailableModels(await getAvailableModels.call(this.options.attached));
    } catch {
      throw new GatewayError(
        "MODEL_CATALOG_UNAVAILABLE",
        "Prime Agent's live model catalog could not be safely validated",
        true,
      );
    }
    if (!availableModels.some((model) => model.providerId === providerId && model.modelId === modelId)) {
      throw new GatewayError(
        "MODEL_NOT_AVAILABLE",
        "The requested model is not available on this live Prime Agent session",
      );
    }

    // This second live check is intentionally adjacent to the one and only
    // mutation call. Any failure before it is known not to have mutated state.
    this.assertModelSelectionLive(expectedBinding);
    try {
      // Ignore the upstream DTO entirely. Resolution is only permission to
      // perform the fresh authoritative read below; it is not completion
      // evidence and never crosses this private boundary.
      await setModel.call(this.options.attached, providerId, modelId);
    } catch {
      // A rejected promise can represent a lost daemon response after commit.
      // The public connection cannot force-refresh its snapshot on this path,
      // so reconciliation would be unsafe and no retry is permitted.
      throw new GatewayError(
        "MODEL_SELECTION_OUTCOME_UNKNOWN",
        "Prime Agent may have changed the model, but no authoritative result is available",
        false,
        true,
      );
    }

    try {
      // Prime v0.7's supervisor does not invalidate its attach cache for a
      // successful set_model response. Reconcile through fixed read-only state,
      // messages, and context requests on a new verified daemon client; the
      // attachment supplies only the before/after event-cursor fence. Completion
      // is never inferred from the mutation DTO or the cached attach model.
      const projection = await awaitResidentMutationInvocation(
        this.options.readStableSelectedModelProjection(
          expectedBinding,
          providerId,
          modelId,
        ),
        this.options.requestTimeoutMs,
        "model selection reconciliation",
      );
      this.assertModelSelectionLive(expectedBinding);
      await publishModelSelectionProjection(
        this.options.publishModelSelectionProjection,
        command,
        expectedBinding,
        projection,
      );
      this.assertModelSelectionLive(expectedBinding);
      this.acceptAuthoritativeProjection(projection);
    } catch {
      throw new GatewayError(
        "MODEL_SELECTION_RECONCILIATION_FAILED",
        "Prime Agent accepted the model mutation, but its authoritative state could not be reconciled",
        false,
        true,
      );
    }

    return Object.freeze({ providerId, modelId });
  }

  private assertModelSelectionLive(expectedBinding: ResidentSessionBinding): void {
    if (this.isLive() && isDeepStrictEqual(this.binding, expectedBinding)) return;
    throw new GatewayError(
      "MODEL_SELECTION_SESSION_AUTHORITY_CHANGED",
      "The admitted resident Prime Agent session is no longer live under the exact durable authority",
      true,
    );
  }

  private async handleUpstreamEvent(event: unknown): Promise<void> {
    if (this.locallyClosed || this.terminalAction) return;
    if (!isRecord(event) || typeof event.type !== "string") throw invalidResponse("connection event");
    this.upstreamEventOrdinal += 1;
    if (event.type === "extension_ui_request") {
      this.acceptExtensionUiRequest(event.request);
      return;
    }
    if (event.type === "session_event") {
      const marker = residentTerminalAssistantMarkerFromSessionEvent(event.event);
      if (marker) {
        this.latestTerminalAssistantEvent = Object.freeze({
          ordinal: this.upstreamEventOrdinal,
          marker,
        });
      }
      const child = residentChildAgentSummaryFromSessionEvent(event.event);
      if (child) this.rememberObservedChildAgent(child);
    }
    for (const resolve of this.upstreamEventWaiters) resolve();
    this.upstreamEventWaiters.clear();
    switch (event.type) {
      case "connection_status": {
        if (event.status === "reconnecting") {
          this.clearExtensionUiRequests();
          this.resyncValidated = false;
          this.lifecycle.transition("reconnecting", { binding: this.binding });
          return;
        }
        if (event.status !== "connected") throw invalidResponse("connection status");
        const compatibility = validateResidentDaemonHello(this.options.client.hello, {
          expectedSocketPath: this.options.expectedSocketPath,
          expectedExecutablePath: this.options.expectedExecutablePath,
          expectedEntrypointPath: this.options.expectedEntrypointPath,
        });
        if (!this.resyncValidated) {
          throw new ResidentRuntimeContractError(
            "PRIME_RUNTIME_RESPONSE_INVALID",
            "Prime Agent reported reconnection without a validated authoritative resync.",
          );
        }
        await this.refreshRuntimeBinding(compatibility);
        this.lifecycle.transition("ready", { binding: this.binding });
        return;
      }
      case "session_resynced": {
        const compatibility = validateResidentDaemonHello(this.options.client.hello, {
          expectedSocketPath: this.options.expectedSocketPath,
          expectedExecutablePath: this.options.expectedExecutablePath,
          expectedEntrypointPath: this.options.expectedEntrypointPath,
        });
        // Keep reconnection authority on the established event fence: the
        // resource inventory was already validated for this exact connection
        // and is refreshed by the normal authoritative projection reader.
        // Adding another upstream await here would leave the connection on its
        // old binding after a public idle barrier has already completed.
        const projection = carryForwardResourceInventory(
          normalizeProjection(event.snapshot, this.binding),
          this.authoritativeProjectionValue,
        );
        for (const child of projection.childAgents) this.rememberObservedChildAgent(child);
        const resyncedProjection = this.overlayObservedChildAgents(projection);
        await publishProjection(this.options.publishProjection, this.binding, resyncedProjection);
        await this.refreshRuntimeBinding(compatibility);
        this.resyncValidated = true;
        this.acceptAuthoritativeProjection(resyncedProjection);
        return;
      }
      case "session_replaced":
        validateInitialSnapshotValue({ state: event.state, messages: event.messages }, this.binding);
        this.requestProjectionRefresh();
        return;
      case "heartbeats_changed":
        return;
      case "closed":
        throw new ResidentRuntimeContractError(
          "PRIME_RUNTIME_UNAVAILABLE",
          typeof event.error === "string" && event.error.length > 0
            ? `Prime Agent connection closed: ${event.error.slice(0, 2_048)}`
            : "Prime Agent connection closed.",
          { retryable: true },
        );
      default:
        // Session events, recap/status changes, RLM children, bash, goals, and
        // compaction all converge through one coalesced authoritative read.
        // Unknown future non-control events follow the same safe path without
        // exposing their upstream DTOs or causing one read per token delta.
        this.requestProjectionRefresh();
        return;
    }
  }

  private acceptExtensionUiRequest(value: unknown): void {
    const request = normalizeExtensionUiRequest(
      value,
      this.binding,
      this.options.hostId,
      this.options.now(),
    );
    if (!request) return;
    const existing = this.extensionUiRequests.get(request.requestId);
    if (existing) {
      if (
        existing.requestDigest !== request.requestDigest ||
        existing.method !== request.method ||
        existing.hostId !== request.hostId ||
        existing.threadId !== request.threadId ||
        existing.executionGenerationId !== request.executionGenerationId ||
        existing.bindingFingerprint !== request.bindingFingerprint
      ) {
        throw invalidResponse("extension UI request identity");
      }
      return;
    }
    const retired = this.retiredExtensionUiRequests.get(request.requestId);
    if (retired) {
      if (retired.requestDigest === request.requestDigest && retired.method === request.method) return;
      throw invalidResponse("retired extension UI request identity");
    }
    if (this.extensionUiRequests.size >= 16) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_RESPONSE_INVALID",
        "Prime Agent exceeded the bounded extension UI request limit.",
      );
    }
    this.extensionUiRequests.set(request.requestId, request);
    this.scheduleExtensionUiExpiry(request);
    this.options.publishEphemeralProjectionChange(this.binding);
  }

  private scheduleExtensionUiExpiry(request: ResidentExtensionUiRequest): void {
    if (request.timeoutMs === undefined) return;
    const remaining = Math.max(0, Date.parse(request.receivedAt) + request.timeoutMs - this.options.now().getTime());
    const timer = setTimeout(() => {
      if (this.extensionUiExpiryTimers.get(request.requestId) !== timer) return;
      this.extensionUiExpiryTimers.delete(request.requestId);
      if (!isDeepStrictEqual(this.extensionUiRequests.get(request.requestId), request)) return;
      this.extensionUiRequests.delete(request.requestId);
      this.retireExtensionUiRequest(request);
      this.options.publishEphemeralProjectionChange(this.binding);
    }, remaining);
    timer.unref?.();
    this.extensionUiExpiryTimers.set(request.requestId, timer);
  }

  private clearExtensionUiExpiryTimer(requestId: string): void {
    const timer = this.extensionUiExpiryTimers.get(requestId);
    if (!timer) return;
    clearTimeout(timer);
    this.extensionUiExpiryTimers.delete(requestId);
  }

  private clearExtensionUiRequests(): void {
    const hadRequests = this.extensionUiRequests.size > 0;
    for (const timer of this.extensionUiExpiryTimers.values()) clearTimeout(timer);
    this.extensionUiExpiryTimers.clear();
    for (const request of this.extensionUiRequests.values()) this.retireExtensionUiRequest(request);
    this.extensionUiRequests.clear();
    if (hadRequests) this.options.publishEphemeralProjectionChange(this.binding);
  }

  private retireExtensionUiRequest(request: ResidentExtensionUiRequest): void {
    this.retiredExtensionUiRequests.set(request.requestId, Object.freeze({
      requestDigest: request.requestDigest,
      method: request.method,
    }));
    if (this.retiredExtensionUiRequests.size <= 256) return;
    const oldest = this.retiredExtensionUiRequests.keys().next().value as string | undefined;
    if (oldest) this.retiredExtensionUiRequests.delete(oldest);
  }

  private async waitForUpstreamEventOrBackoffAfter(
    ordinal: number,
    cancellation: ResidentIdleReconciliationCancellation,
  ): Promise<void> {
    if (this.upstreamEventOrdinal > ordinal) return Promise.resolve();
    let resolveEvent!: () => void;
    const event = new Promise<void>((resolve) => {
      resolveEvent = resolve;
      this.upstreamEventWaiters.add(resolve);
    });
    try {
      await Promise.race([
        event,
        cancellation.promise,
        this.options.wait(TERMINAL_EVENT_PROJECTION_BACKOFF_MS),
      ]);
    } finally {
      this.upstreamEventWaiters.delete(resolveEvent);
    }
  }

  private overlayObservedChildAgents(
    projection: ResidentProjectionSnapshot,
  ): ResidentProjectionSnapshot {
    for (const child of projection.childAgents) this.rememberObservedChildAgent(child);
    if (this.observedChildAgents.size === 0) return projection;
    const children = new Map(this.observedChildAgents);
    // A fresh exact snapshot is authoritative for duplicate identities. The
    // retained event cache fills only children omitted by that snapshot.
    for (const child of projection.childAgents) children.set(child.agentId, child);
    const boundedChildren = [...children.values()].slice(-MAX_RESIDENT_PROJECTION_CHILDREN);
    return Object.freeze({ ...projection, childAgents: Object.freeze(boundedChildren) });
  }

  private rememberObservedChildAgent(
    child: ResidentProjectionSnapshot["childAgents"][number],
  ): void {
    if (
      !this.observedChildAgents.has(child.agentId) &&
      this.observedChildAgents.size >= MAX_RESIDENT_PROJECTION_CHILDREN
    ) {
      const oldestAgentId = this.observedChildAgents.keys().next().value as string | undefined;
      if (oldestAgentId) this.observedChildAgents.delete(oldestAgentId);
    }
    this.observedChildAgents.set(child.agentId, child);
  }

  private async refreshRuntimeBinding(compatibility: ResidentRuntimeCompatibility): Promise<void> {
    if (sameRuntimeCompatibility(this.binding.runtime, compatibility)) return;
    const refreshed = freezeBinding({ ...this.binding, runtime: compatibility });
    await this.options.persistBinding(refreshed).catch((error) => {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_BINDING_PERSIST_FAILED",
        "The reconnected resident runtime binding could not be saved.",
        { retryable: true, details: { cause: errorMessage(error) }, cause: error },
      );
    });
    this.bindingValue = refreshed;
  }

  private failFromUpstream(error: unknown): void {
    if (this.locallyClosed || this.terminalAction) return;
    const normalized = normalizeRuntimeError(error, "Prime Agent resident connection failed.");
    this.locallyClosed = true;
    this.projectionRefreshRequested = false;
    this.unsubscribeUpstream();
    this.clearExtensionUiRequests();
    this.options.client.close();
    this.cancelResidentIdleReconciliation();
    this.lifecycle.transition("failed", { binding: this.binding, error: normalized.toJSON() });
    this.options.onClosed();
  }
}

function boundedResidentPrompt(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_RESIDENT_PROMPT_CHARACTERS) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_ARGUMENT_INVALID",
      "Resident runtime prompt text is invalid.",
      { details: { field: "message", maxCharacters: MAX_RESIDENT_PROMPT_CHARACTERS } },
    );
  }
  return value;
}

function boundedGatewayMessage(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 1_024);
  return sanitized || fallback;
}

function residentPromptFingerprint(message: string): string {
  return `prompt:${message.length}:${createHash("sha256").update(message, "utf8").digest("hex")}`;
}

function createPromptAdmissionAttempt(
  lease: ResidentGenerationDispatchLease,
  baselineCursor?: ResidentProjectionSnapshot["cursor"],
): PromptAdmissionAttempt {
  let settled = false;
  let resolveSettlement!: (outcome: PromptAdmissionOutcome) => void;
  const settlement = new Promise<PromptAdmissionOutcome>((resolve) => {
    resolveSettlement = resolve;
  });
  return {
    lease,
    controller: new AbortController(),
    settlement,
    baselineCursor: copyResidentProjectionCursor(baselineCursor),
    settle: (outcome) => {
      if (settled) return;
      settled = true;
      resolveSettlement(outcome);
    },
  };
}

function createResidentIdleReconciliationCancellation(): ResidentIdleReconciliationCancellation {
  let settled = false;
  let rejectPromise!: (error: ResidentRuntimeContractError) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  return Object.freeze({
    promise,
    reject: (error: ResidentRuntimeContractError) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  });
}

function copyResidentProjectionCursor(
  cursor: ResidentProjectionSnapshot["cursor"] | undefined,
): ResidentProjectionSnapshot["cursor"] | undefined {
  return cursor ? Object.freeze({ generation: cursor.generation, sequence: cursor.sequence }) : undefined;
}

function residentProjectionCursorAdvances(
  baseline: ResidentProjectionSnapshot["cursor"],
  candidate: ResidentProjectionSnapshot["cursor"],
  retiredGenerations: ReadonlySet<string>,
): boolean {
  return candidate.generation === baseline.generation
    ? candidate.sequence > baseline.sequence
    : retiredGenerations.has(baseline.generation) && !retiredGenerations.has(candidate.generation);
}

function residentProjectionProvesActiveOwnership(projection: ResidentProjectionSnapshot): boolean {
  return (
    projection.runtime.isStreaming ||
    projection.runtime.isCompacting ||
    projection.runtime.isBashRunning ||
    projection.queue.active !== undefined
  );
}

function residentProjectionProvesIdle(projection: ResidentProjectionSnapshot): boolean {
  return (
    !residentProjectionProvesActiveOwnership(projection) &&
    projection.stream === undefined &&
    projection.runtime.queuedActionCount === 0 &&
    projection.queue.queuedCount === 0 &&
    projection.queue.steeringCount === 0 &&
    projection.queue.followUpCount === 0
  );
}

function requireTerminalAssistantBlockId(
  projection: ResidentProjectionSnapshot,
  dispatchAttemptId: string,
): string {
  const blockId = projection.terminalAssistantBlockId;
  if (
    !blockId ||
    !projection.transcript.some((block) => block.blockId === blockId && block.kind === "assistant")
  ) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_PROMPT_IDLE_NOT_OBSERVED",
      "Prime Agent's terminal event did not materialize an exact assistant block.",
      { retryable: true, details: { dispatchAttemptId } },
    );
  }
  return blockId;
}

function promptAdmissionStatusError(status: "cancelled" | "unsupported"): Error {
  return Object.assign(new Error(`Prime Agent prompt admission ${status}.`), { status });
}

function residentDispatchAccepted(operation: ResidentDispatchOperation): ResidentDispatchResult {
  return Object.freeze({ operation, disposition: "accepted", completion: "not_observed" });
}

function residentAbortNotNeeded(): ResidentDispatchResult {
  return Object.freeze({
    operation: "abort",
    disposition: "not_needed",
    completion: "not_observed",
    reason: "prompt_admission_cancelled",
  });
}

function unknownResidentMutationOutcome(
  operation: ResidentDispatchOperation,
  dispatchAttemptId: string,
  cause: unknown,
): ResidentRuntimeContractError {
  return new ResidentRuntimeContractError(
    "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    `Prime Agent may have accepted the resident ${operation} request, but no definitive response was received.`,
    {
      retryable: false,
      details: { operation, dispatchAttemptId, outcome: "unknown" },
      cause,
    },
  );
}

function unknownExtensionUiResponseOutcome(
  requestId: string,
  cause: unknown,
): ResidentRuntimeContractError {
  return new ResidentRuntimeContractError(
    "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    "Prime Agent may have accepted the extension UI response, but no definitive acknowledgement was received.",
    {
      retryable: false,
      details: { operation: "extension_ui_response", requestId, outcome: "unknown" },
      cause,
    },
  );
}

function extensionUiResponseForUpstream(
  method: ResidentExtensionUiRequest["method"],
  response: ExtensionUiDialogResponse,
): Readonly<{ cancelled: true } | { value: string } | { confirmed: boolean }> {
  if (response.kind === "cancelled") return Object.freeze({ cancelled: true as const });
  if (method === "confirm" && response.kind === "confirmed") {
    return Object.freeze({ confirmed: response.confirmed });
  }
  if (method !== "confirm" && response.kind === "value") {
    return Object.freeze({ value: response.value });
  }
  throw new ResidentRuntimeContractError(
    "PRIME_RUNTIME_DISPATCH_LEASE_INVALID",
    "The extension UI response does not match its exact dialog method.",
    { retryable: false },
  );
}

function normalizeExtensionUiRequest(
  value: unknown,
  binding: ResidentSessionBinding,
  hostId: string,
  receivedAt: Date,
): ResidentExtensionUiRequest | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.method !== "string") {
    throw invalidResponse("extension UI request");
  }
  if (!['select', 'confirm', 'input', 'editor'].includes(value.method)) return undefined;
  if (!isRecord(value.payload)) throw invalidResponse("extension UI request payload");
  const title = value.payload.title;
  if (typeof title !== "string") throw invalidResponse("extension UI request title");
  const timeoutMs = value.payload.timeout;
  const common = {
    interactionVersion: 1 as const,
    hostId,
    threadId: binding.threadId,
    executionGenerationId: binding.executionGenerationId,
    bindingFingerprint: residentDispatchAuthorityFingerprint(binding),
    requestId: value.id,
    receivedAt: receivedAt.toISOString(),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  let candidate: Record<string, unknown>;
  switch (value.method) {
    case "select":
      candidate = { ...common, method: "select", title, options: value.payload.options as string[] };
      break;
    case "confirm":
      candidate = { ...common, method: "confirm", title, message: value.payload.message as string };
      break;
    case "input":
      candidate = {
        ...common,
        method: "input",
        title,
        ...(value.payload.placeholder === undefined ? {} : { placeholder: value.payload.placeholder as string }),
      };
      break;
    case "editor":
      candidate = {
        ...common,
        method: "editor",
        title,
        ...(value.payload.prefill === undefined ? {} : { prefill: value.payload.prefill as string }),
      };
      break;
    default:
      return undefined;
  }
  const requestDigest = normalizedJsonDigest({
    activeSessionId: binding.activeSessionId,
    requestId: value.id,
    method: value.method,
    payload: value.payload,
  });
  const parsed = ResidentExtensionUiRequestSchema.safeParse({ ...candidate, requestDigest });
  if (!parsed.success) throw invalidResponse("extension UI request", parsed.error.issues[0]?.message);
  return Object.freeze(parsed.data);
}

function normalizedJsonDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortExtensionUiJson(value))).digest("hex");
}

function sortExtensionUiJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortExtensionUiJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortExtensionUiJson((value as Record<string, unknown>)[key])]),
  );
}

function unknownOwnedPromotionOutcome(
  activeSessionId: string,
  cause: unknown,
): ResidentRuntimeContractError {
  return new ResidentRuntimeContractError(
    "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    "Prime Agent may have promoted the client-owned session, but no definitive response was received.",
    {
      retryable: false,
      details: {
        command: "promote_owned_session",
        activeSessionId,
        outcome: "unknown",
        cause: errorMessage(cause),
      },
      cause,
    },
  );
}

function unknownOwnedCreateOutcome(
  phase: string,
  activeSessionId: string | undefined,
  cleanup: string | undefined,
  cause: unknown,
): ResidentRuntimeContractError {
  return new ResidentRuntimeContractError(
    "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    "Prime Agent may own a client-owned session, but its final state is not proven.",
    {
      retryable: false,
      details: {
        command: "create",
        phase,
        outcome: "unknown",
        ...(activeSessionId ? { activeSessionId } : {}),
        ...(cleanup ? { cleanup } : {}),
        failureCode: cause instanceof ResidentRuntimeContractError ? cause.code : "unclassified",
        cause: errorMessage(cause),
      },
      cause,
    },
  );
}

function classifyPromptAdmissionFailure(
  dispatchAttemptId: string,
  error: unknown,
): ResidentRuntimeContractError {
  const status = isRecord(error) ? error.status : undefined;
  if (status === "cancelled" || status === "unsupported") {
    return new ResidentRuntimeContractError(
      "PRIME_RUNTIME_REQUEST_FAILED",
      status === "cancelled"
        ? "Prime Agent confirmed that prompt admission was cancelled before session ownership."
        : "The pinned Prime Agent connection does not support cancellable prompt admission.",
      {
        retryable: false,
        details: {
          operation: "prompt",
          dispatchAttemptId,
          outcome: "not_accepted",
          status,
        },
        cause: error,
      },
    );
  }
  return unknownResidentMutationOutcome("prompt", dispatchAttemptId, error);
}

function promptAdmissionOutcomeFromError(error: unknown): PromptAdmissionOutcome {
  const status = isRecord(error) ? error.status : undefined;
  return status === "cancelled" || status === "unsupported" ? "cancelled" : "unknown";
}

class ResidentMutationAdmissionTimeoutError extends Error {
  constructor(operation: string) {
    super(`Timed out waiting for Prime Agent ${operation}.`);
    this.name = "ResidentMutationAdmissionTimeoutError";
  }
}

function awaitResidentMutationInvocation<T>(
  invocation: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ResidentMutationAdmissionTimeoutError(operation));
    }, timeoutMs);
    Promise.resolve(invocation).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function settleWithinGrace(settlement: Promise<unknown>, graceMs: number): Promise<void> {
  const observed = Promise.resolve(settlement).then(
    () => undefined,
    () => undefined,
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      observed,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function observeLateOpenClient(opening: Promise<OpenClient>): void {
  void opening.then(
    (opened) => closeDaemonClientQuietly(opened.client),
    () => undefined,
  );
}

function observeLateAttachedConnection(
  attachment: Promise<PrimeDaemonAgentConnectionPublic>,
): void {
  void attachment.then(
    (attached) => {
      try {
        void Promise.resolve(attached.dispose()).catch(() => undefined);
      } catch {
        // The ephemeral transport was already closed at the deadline.
      }
    },
    () => undefined,
  );
}

function defaultResidentDaemonSpawn(
  executable: string,
  argv: readonly string[],
  options: ResidentDaemonStartInvocation["spawn"],
): ResidentDaemonLauncher {
  return spawn(executable, [...argv], {
    shell: options.shell,
    windowsHide: options.windowsHide,
    detached: options.detached,
    cwd: options.cwd,
    env: { ...options.env },
    stdio: options.stdio,
  }) as unknown as ResidentDaemonLauncher;
}

function validatePrimeAgentPublicModule(value: unknown): PrimeAgentPublicModule {
  if (!isRecord(value)) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_MODULE_INVALID",
      "The Prime Agent runtime module did not expose an ESM namespace.",
    );
  }
  const DaemonClient = value.DaemonClient;
  const DaemonAgentConnection = value.DaemonAgentConnection;
  if (
    typeof DaemonClient !== "function" ||
    (typeof DaemonAgentConnection !== "object" && typeof DaemonAgentConnection !== "function") ||
    DaemonAgentConnection === null ||
    typeof (DaemonAgentConnection as { attach?: unknown }).attach !== "function"
  ) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_MODULE_INVALID",
      "The Prime Agent runtime module is missing its supported daemon exports.",
    );
  }
  return value as unknown as PrimeAgentPublicModule;
}

async function requestDaemon(
  client: PrimeDaemonClientPublic,
  command: Readonly<object>,
  timeoutMs: number,
  expectedCommand: string,
  mutation = false,
): Promise<PrimeDaemonResponseSuccess> {
  let responseValue: unknown;
  try {
    responseValue = await client.request(command, timeoutMs);
  } catch (error) {
    if (mutation) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
        `Prime Agent ${expectedCommand} may have been accepted, but no definitive response was received.`,
        {
          details: { command: expectedCommand, outcome: "unknown", cause: errorMessage(error) },
          cause: error,
        },
      );
    }
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_REQUEST_FAILED",
      `Prime Agent ${expectedCommand} request failed before a definitive response.`,
      { retryable: true, details: { command: expectedCommand, cause: errorMessage(error) }, cause: error },
    );
  }
  assertBoundedJson(responseValue, 8 * 1024 * 1024, `${expectedCommand} response`);
  if (!isRecord(responseValue) || responseValue.type !== "response" || responseValue.command !== expectedCommand) {
    throw invalidResponse(expectedCommand);
  }
  if (responseValue.success === false) {
    const upstreamMessage = typeof responseValue.error === "string" ? responseValue.error.slice(0, 2_048) : "Unknown error";
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_REQUEST_FAILED",
      `Prime Agent rejected the ${expectedCommand} request: ${upstreamMessage}`,
      { details: { command: expectedCommand } },
    );
  }
  if (responseValue.success !== true) throw invalidResponse(expectedCommand);
  return responseValue as unknown as PrimeDaemonResponseSuccess;
}

/**
 * The caller has already crossed its durable Store kill lease and completed
 * the exact read-only fence. Only a worker-proven pre-invocation failure may
 * escape as definite; every observation after upstream invocation is unknown.
 */
async function requestResidentLifecycleKill(
  client: PrimeDaemonClientPublic,
  activeSessionId: string,
  timeoutMs: number,
): Promise<void> {
  let responseValue: unknown;
  try {
    responseValue = await client.request({ type: "kill", activeSessionId }, timeoutMs);
  } catch (error) {
    if (isDefinitiveMutationNonInvocation(error)) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_REQUEST_FAILED",
        "Prime Agent rejected the resident end request before invoking root kill.",
        {
          retryable: true,
          details: { command: "kill", outcome: "definitive", cause: safeErrorMessage(error) },
          cause: error,
        },
      );
    }
    throw unknownResidentLifecycleEndOutcome(error);
  }

  try {
    assertBoundedJson(responseValue, 8 * 1024 * 1024, "kill response");
    if (
      !isRecord(responseValue) ||
      responseValue.type !== "response" ||
      responseValue.command !== "kill" ||
      responseValue.success !== true
    ) {
      throw invalidResponse("kill");
    }
  } catch (error) {
    throw unknownResidentLifecycleEndOutcome(error);
  }
}

function unknownResidentLifecycleEndOutcome(cause: unknown): ResidentRuntimeContractError {
  return new ResidentRuntimeContractError(
    "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    "Prime Agent root kill may have been invoked, but no definitive acknowledgement was received.",
    {
      details: { command: "kill", outcome: "unknown", cause: safeErrorMessage(cause) },
      cause,
    },
  );
}

function isUnknownMutationOutcome(error: unknown): boolean {
  return error instanceof ResidentRuntimeContractError &&
    error.code === "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN";
}

function isDefinitiveMutationNonInvocation(error: unknown): boolean {
  try {
    return isRecord(error) && error.outcome === "definitive";
  } catch {
    return false;
  }
}

function parseLiveSessionSummary(value: unknown, source: string): LiveSessionSummary {
  assertBoundedJson(value, 2 * 1024 * 1024, `${source} session summary`);
  const parsed = LiveSessionSummarySchema.safeParse(value);
  if (!parsed.success) throw invalidResponse(source, parsed.error.issues[0]?.message);
  return parsed.data;
}

function parseLiveSessionList(value: unknown): LiveSessionSummary[] {
  assertBoundedJson(value, MAX_RUNTIME_SNAPSHOT_BYTES, "list response data");
  if (!isRecord(value) || !Array.isArray(value.sessions) || value.sessions.length > MAX_LIVE_SESSIONS) {
    throw invalidResponse("list");
  }
  return value.sessions.map((summary) => parseLiveSessionSummary(summary, "list"));
}

function findExactAvailableResidentSession(
  listResponseData: unknown,
  binding: ResidentSessionBinding,
): LiveSessionSummary {
  const matches = parseLiveSessionList(listResponseData).filter(
    (candidate) => candidate.activeSessionId === binding.activeSessionId,
  );
  if (matches.length > 1) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_RESPONSE_INVALID",
      "Prime Agent returned an ambiguous resident active-session identity.",
      { details: { activeSessionId: binding.activeSessionId } },
    );
  }
  const summary = matches[0];
  // Prime's session lifecycle describes persisted content, not the promoted
  // worker's lifetime. In particular, an empty client-owned session remains a
  // list-visible `draft` after promotion even though its worker is resident and
  // ready. The default list hides unpromoted client-owned workers, while the
  // exact durable binding and identity fences above prove which visible root we
  // may recover or end. Archived content is never an invocable resident root.
  if (!summary || summary.lifecycle === "archived") {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_SESSION_NOT_FOUND",
      "The exact resident Prime Agent session is not currently active.",
      { retryable: true, details: { activeSessionId: binding.activeSessionId } },
    );
  }
  return summary;
}

async function publishInitialProjection(
  connection: PrimeDaemonAgentConnectionPublic,
  binding: ResidentSessionBinding,
  publisher: (
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>,
): Promise<ResidentProjectionSnapshot | undefined> {
  const projection = await readStableResidentProjection(connection, binding).catch((error) => {
    if (error instanceof ResidentRuntimeContractError) throw error;
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_REQUEST_FAILED",
      "Prime Agent attach did not produce a stable authoritative initial snapshot.",
      { retryable: true, details: { cause: errorMessage(error) }, cause: error },
    );
  });
  if (!projection) return undefined;
  await publishProjection(publisher, binding, projection);
  return projection;
}

async function readStableResidentProjection(
  connection: PrimeDaemonAgentConnectionPublic,
  binding: ResidentSessionBinding,
): Promise<ResidentProjectionSnapshot | undefined> {
  return readResidentProjectionSeries(connection, binding, false);
}

/**
 * Ordinary supervision may conservatively publish the latest bounded active
 * observation when a streaming cursor never yields a quiet pair. It must
 * never use an unstable observation to claim idle or complete a mutation.
 */
async function readStableOrLatestActiveResidentProjection(
  connection: PrimeDaemonAgentConnectionPublic,
  binding: ResidentSessionBinding,
  previousProjection?: ResidentProjectionSnapshot,
): Promise<Readonly<{ projection: ResidentProjectionSnapshot; stable: boolean }> | undefined> {
  const observations = await readResidentProjectionSeriesWithStability(
    connection,
    binding,
    previousProjection,
  );
  if (!observations) return undefined;
  if (observations.stable || residentProjectionProvesActiveOwnership(observations.projection)) {
    return observations;
  }
  return undefined;
}

async function readResidentProjectionSeries(
  connection: PrimeDaemonAgentConnectionPublic,
  binding: ResidentSessionBinding,
  allowLatestActive: boolean,
): Promise<ResidentProjectionSnapshot | undefined> {
  const observations = await readResidentProjectionSeriesWithStability(connection, binding);
  if (!observations) return undefined;
  return observations.stable || (allowLatestActive && residentProjectionProvesActiveOwnership(observations.projection))
    ? observations.projection
    : undefined;
}

async function readResidentProjectionSeriesWithStability(
  connection: PrimeDaemonAgentConnectionPublic,
  binding: ResidentSessionBinding,
  previousProjection?: ResidentProjectionSnapshot,
): Promise<Readonly<{ projection: ResidentProjectionSnapshot; stable: boolean }> | undefined> {
  let previous: ResidentProjectionSnapshot | undefined;
  let latestSnapshot: unknown;
  let stable = false;
  for (let read = 0; read < MAX_AUTHORITATIVE_RESIDENT_SNAPSHOT_READS; read += 1) {
    latestSnapshot = await connection.getInitialSnapshot();
    const projection = carryForwardResourceInventory(
      normalizeProjection(latestSnapshot, binding),
      previousProjection,
    );
    if (previous && isDeepStrictEqual(previous, projection)) {
      previous = projection;
      stable = true;
      break;
    }
    previous = projection;
  }
  if (!previous || latestSnapshot === undefined) return undefined;

  // Skills, prompts, and extensions are attachment-scoped but can be costly to
  // enumerate. A live active observation carries the already validated
  // inventory so streaming and RLM child events are not held behind discovery.
  // Stable (quiet) observations still refresh it once, preserving eventual
  // resource accuracy without repeating the read for every cursor sample.
  if (
    previousProjection?.runtime.resourceInventory &&
    residentProjectionProvesActiveOwnership(previous)
  ) {
    return Object.freeze({ projection: previous, stable });
  }
  const resources = await connection.getResourceSnapshot();
  const projection = normalizeProjection(latestSnapshot, binding, resources);
  return Object.freeze({ projection, stable });
}

function normalizeProjection(
  snapshot: unknown,
  binding: ResidentSessionBinding,
  resources?: unknown,
): ResidentProjectionSnapshot {
  try {
    return normalizeResidentProjectionSnapshot(snapshot, binding, resources);
  } catch (error) {
    if (error instanceof ResidentProjectionError) {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_RESPONSE_INVALID",
        "Prime Agent returned an invalid authoritative projection snapshot.",
        { details: { projectionCode: error.code }, cause: error },
      );
    }
    throw error;
  }
}

function carryForwardResourceInventory(
  projection: ResidentProjectionSnapshot,
  previous: ResidentProjectionSnapshot | undefined,
): ResidentProjectionSnapshot {
  const resourceInventory = previous?.runtime.resourceInventory;
  if (!resourceInventory) return projection;
  return Object.freeze({
    ...projection,
    runtime: Object.freeze({ ...projection.runtime, resourceInventory }),
  });
}

function sanitizeAvailableModels(value: unknown): readonly SanitizedResidentModelIdentity[] {
  assertBoundedJson(value, 8 * 1024 * 1024, "available model catalog");
  if (!Array.isArray(value) || value.length > MAX_AVAILABLE_MODELS) {
    throw invalidResponse("available model catalog");
  }
  const identities: SanitizedResidentModelIdentity[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const parsed = ModelSelectionIdentitySchema.safeParse(candidate);
    if (!parsed.success) throw invalidResponse("available model catalog");
    const identity = Object.freeze({ providerId: parsed.data.provider, modelId: parsed.data.id });
    const key = JSON.stringify([identity.providerId, identity.modelId]);
    if (seen.has(key)) throw invalidResponse("available model catalog");
    seen.add(key);
    identities.push(identity);
  }
  return Object.freeze(identities);
}

async function readStableModelSelectionProjection(
  connection: PrimeDaemonAgentConnectionPublic,
  client: PrimeDaemonClientPublic,
  binding: ResidentSessionBinding,
  providerId: string,
  modelId: string,
  deadline: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<ResidentProjectionSnapshot> {
  let previous:
    | Readonly<{
        proof: Readonly<{
          cursor: Readonly<{ generation: string; sequence: number }>;
          state: Readonly<Record<string, unknown>>;
          messages: readonly unknown[];
          sessionContext: Readonly<Record<string, unknown>>;
        }>;
        projection: ResidentProjectionSnapshot;
      }>
    | undefined;
  for (let read = 0; read < MAX_AUTHORITATIVE_MODEL_SNAPSHOT_READS; read += 1) {
    // Prime v0.7's supervisor can retain an attach snapshot across set_model:
    // the worker applies the mutation, but the command response does not
    // invalidate the supervisor's attach cache. Use the attachment only to
    // fence the worker event cursor. The state, messages, and context that
    // prove completion are fixed read-only requests routed to the exact live
    // worker and are never inferred from the set_model response DTO.
    const beforeSnapshot = await beforeModelSelectionDeadline(
      deadline,
      () => connection.getInitialSnapshot(),
      "model selection attachment snapshot",
    );
    const beforeCursor = inspectBoundSnapshotCursor(beforeSnapshot, binding);
    const round = await readFixedResidentProjectionRound(
      client,
      beforeSnapshot,
      binding,
      providerId,
      modelId,
      deadline,
    );
    const afterSnapshot = await beforeModelSelectionDeadline(
      deadline,
      () => connection.getInitialSnapshot(),
      "model selection attachment snapshot",
    );
    const afterCursor = inspectBoundSnapshotCursor(afterSnapshot, binding);
    if (!isDeepStrictEqual(beforeCursor, afterCursor) || !round) {
      previous = undefined;
      if (read + 1 < MAX_AUTHORITATIVE_MODEL_SNAPSHOT_READS) {
        await beforeModelSelectionDeadline(
          deadline,
          (remainingMs) => wait(Math.min(MODEL_SELECTION_RECONCILIATION_POLL_MS, remainingMs)),
          "model selection reconciliation wait",
        );
      }
      continue;
    }
    const resources = await beforeModelSelectionDeadline(
      deadline,
      () => connection.getResourceSnapshot(),
      "model selection resource inventory",
    );
    const projection = normalizeProjection(round.snapshot, binding, resources);
    if (
      round.selected &&
      previous &&
      isDeepStrictEqual(previous.proof, round.proof) &&
      isDeepStrictEqual(previous.projection, projection)
    ) {
      return projection;
    }
    previous = round.selected
      ? Object.freeze({ proof: round.proof, projection })
      : undefined;
    if (read + 1 < MAX_AUTHORITATIVE_MODEL_SNAPSHOT_READS) {
      await beforeModelSelectionDeadline(
        deadline,
        (remainingMs) => wait(Math.min(MODEL_SELECTION_RECONCILIATION_POLL_MS, remainingMs)),
        "model selection reconciliation wait",
      );
    }
  }
  throw new ResidentRuntimeContractError(
    "PRIME_RUNTIME_RESPONSE_INVALID",
    "Prime Agent state changed throughout authoritative model-selection reconciliation.",
  );
}

async function readFixedResidentProjectionRound(
  client: PrimeDaemonClientPublic,
  attachmentSnapshot: unknown,
  binding: ResidentSessionBinding,
  providerId: string,
  modelId: string,
  deadline: number,
): Promise<Readonly<{
  snapshot: unknown;
  selected: boolean;
  proof: Readonly<{
    cursor: Readonly<{ generation: string; sequence: number }>;
    state: Readonly<Record<string, unknown>>;
    messages: readonly unknown[];
    sessionContext: Readonly<Record<string, unknown>>;
  }>;
}> | undefined> {
  if (!isRecord(attachmentSnapshot)) throw invalidResponse("model-selection attachment snapshot");
  const stateBeforeResponse = await beforeModelSelectionDeadline(
    deadline,
    (remainingMs) => requestDaemon(
      client,
      { type: "get_connection_state", activeSessionId: binding.activeSessionId },
      remainingMs,
      "get_connection_state",
    ),
    "model selection get_connection_state",
  );
  const messagesResponse = await beforeModelSelectionDeadline(
    deadline,
    (remainingMs) => requestDaemon(
      client,
      { type: "get_messages", activeSessionId: binding.activeSessionId },
      remainingMs,
      "get_messages",
    ),
    "model selection get_messages",
  );
  const contextResponse = await beforeModelSelectionDeadline(
    deadline,
    (remainingMs) => requestDaemon(
      client,
      { type: "get_session_context", activeSessionId: binding.activeSessionId },
      remainingMs,
      "get_session_context",
    ),
    "model selection get_session_context",
  );
  const stateAfterResponse = await beforeModelSelectionDeadline(
    deadline,
    (remainingMs) => requestDaemon(
      client,
      { type: "get_connection_state", activeSessionId: binding.activeSessionId },
      remainingMs,
      "get_connection_state",
    ),
    "model selection get_connection_state",
  );
  if (!isRecord(stateBeforeResponse.data) || !isRecord(stateAfterResponse.data)) {
    throw invalidResponse("get_connection_state");
  }
  if (!isRecord(messagesResponse.data) || !Array.isArray(messagesResponse.data.messages)) {
    throw invalidResponse("get_messages");
  }
  if (!isRecord(contextResponse.data) || !isRecord(contextResponse.data.context)) {
    throw invalidResponse("get_session_context");
  }
  if (
    typeof stateBeforeResponse.data.messageCount !== "number" ||
    !Number.isSafeInteger(stateBeforeResponse.data.messageCount) ||
    stateBeforeResponse.data.messageCount < 0
  ) {
    throw invalidResponse("model-selection message fence");
  }
  if (
    !isDeepStrictEqual(stateBeforeResponse.data, stateAfterResponse.data) ||
    stateBeforeResponse.data.messageCount !== messagesResponse.data.messages.length
  ) {
    return undefined;
  }
  const cursor = inspectBoundSnapshotCursor(attachmentSnapshot, binding);
  const snapshot = {
    ...attachmentSnapshot,
    state: stateBeforeResponse.data,
    messages: messagesResponse.data.messages,
    sessionContext: contextResponse.data.context,
  };
  // Validate exact durable identity, model, leaf, message count, and cursor
  // consistency before retaining any raw proof material for cross-round equality.
  const observation = inspectModelSelectionSnapshot(snapshot, binding, providerId, modelId);
  const contextModel = contextResponse.data.context.model;
  const selected =
    observation.selected &&
    stateBeforeResponse.data.leafId !== null &&
    isRecord(contextModel) &&
    contextModel.provider === providerId &&
    contextModel.modelId === modelId;
  return Object.freeze({
    snapshot,
    selected,
    proof: Object.freeze({
      cursor,
      state: stateBeforeResponse.data,
      messages: messagesResponse.data.messages,
      sessionContext: contextResponse.data.context,
    }),
  });
}

function beforeModelSelectionDeadline<T>(
  deadline: number,
  operation: (remainingMs: number) => Promise<T>,
  label: string,
): Promise<T> {
  const remainingMs = Math.floor(deadline - performance.now());
  if (remainingMs <= 0) {
    return Promise.reject(new ResidentMutationAdmissionTimeoutError(label));
  }
  return awaitResidentMutationInvocation(
    Promise.resolve().then(() => operation(remainingMs)),
    remainingMs,
    label,
  );
}

function inspectBoundSnapshotCursor(
  snapshot: unknown,
  binding: ResidentSessionBinding,
): Readonly<{ generation: string; sequence: number }> {
  validateInitialSnapshotValue(snapshot, binding);
  const parsed = InitialSnapshotSchema.safeParse(snapshot);
  if (!parsed.success || !parsed.data.lastEventCursor || parsed.data.lastEventSequence === undefined) {
    throw invalidResponse("model-selection attachment cursor");
  }
  return Object.freeze({ ...parsed.data.lastEventCursor });
}

function inspectModelSelectionSnapshot(
  snapshot: unknown,
  binding: ResidentSessionBinding,
  providerId: string,
  modelId: string,
): Readonly<{
  cursor: Readonly<{ generation: string; sequence: number }>;
  selected: boolean;
}> {
  assertBoundedJson(snapshot, MAX_RUNTIME_SNAPSHOT_BYTES, "model-selection snapshot");
  const parsed = ModelSelectionSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw invalidResponse("model-selection snapshot");
  const state = parsed.data.state;
  if (
    state.activeSessionId !== binding.activeSessionId ||
    state.sessionId !== binding.sessionId ||
    (binding.sessionFile !== undefined && state.sessionFile !== binding.sessionFile) ||
    !sameWorkspacePath(state.cwd, binding.workspaceDirectory)
  ) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_SESSION_MISMATCH",
      "The authoritative model-selection snapshot does not match its durable resident authority.",
    );
  }
  return Object.freeze({
    cursor: Object.freeze({
      generation: parsed.data.lastEventCursor.generation,
      sequence: parsed.data.lastEventCursor.sequence,
    }),
    selected: state.model.provider === providerId && state.model.id === modelId,
  });
}

async function publishProjection(
  publisher: (
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>,
  binding: ResidentSessionBinding,
  projection: ResidentProjectionSnapshot,
): Promise<void> {
  try {
    await publisher(binding, projection);
  } catch (error) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_PROJECTION_PERSIST_FAILED",
      "The authoritative Prime Agent projection could not be saved before the session became ready.",
      { retryable: true, cause: error },
    );
  }
}

async function publishModelSelectionProjection(
  publisher: (
    command: CommandEnvelope,
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>,
  command: CommandEnvelope,
  binding: ResidentSessionBinding,
  projection: ResidentProjectionSnapshot,
): Promise<void> {
  try {
    await publisher(command, binding, projection);
  } catch (error) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_PROJECTION_PERSIST_FAILED",
      "The proven Prime Agent model selection could not be saved under its exact durable attempt.",
      { retryable: false, cause: error },
    );
  }
}

function validateInitialSnapshotValue(snapshot: unknown, binding: ResidentSessionBinding): void {
  assertBoundedJson(snapshot, MAX_RUNTIME_SNAPSHOT_BYTES, "attach snapshot");
  const parsed = InitialSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw invalidResponse("attach snapshot", parsed.error.issues[0]?.message);
  const state = parsed.data.state;
  const mismatches: string[] = [];
  if (state.activeSessionId !== binding.activeSessionId) mismatches.push("activeSessionId");
  if (state.sessionId !== binding.sessionId) mismatches.push("sessionId");
  if (binding.sessionFile && state.sessionFile !== binding.sessionFile) mismatches.push("sessionFile");
  if (!sameWorkspacePath(state.cwd, binding.workspaceDirectory)) mismatches.push("cwd");
  if (
    parsed.data.lastEventSequence !== undefined &&
    parsed.data.lastEventCursor !== undefined &&
    parsed.data.lastEventSequence !== parsed.data.lastEventCursor.sequence
  ) {
    mismatches.push("eventCursor");
  }
  if (mismatches.length > 0) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_SESSION_MISMATCH",
      "The attached Prime Agent snapshot does not match the durable host binding.",
      { details: { fields: mismatches.join(","), activeSessionId: binding.activeSessionId } },
    );
  }
}

async function killCreatedSession(
  client: PrimeDaemonClientPublic,
  activeSessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await requestDaemon(client, { type: "kill", activeSessionId }, timeoutMs, "kill", true);
    return true;
  } catch {
    return false;
  }
}

function assertSummaryMatchesBinding(summary: LiveSessionSummary, binding: ResidentSessionBinding): void {
  const mismatches: string[] = [];
  if (summary.sessionId !== binding.sessionId) mismatches.push("sessionId");
  if (summary.activeSessionId !== binding.activeSessionId) mismatches.push("activeSessionId");
  if (binding.sessionFile && summary.sessionFile !== binding.sessionFile) mismatches.push("sessionFile");
  if (!sameWorkspacePath(summary.cwd, binding.workspaceDirectory)) mismatches.push("cwd");
  if (mismatches.length === 0) return;
  throw new ResidentRuntimeContractError(
    "PRIME_RUNTIME_SESSION_MISMATCH",
    "The live Prime Agent session does not match the durable host binding.",
    { details: { fields: mismatches.join(","), activeSessionId: binding.activeSessionId } },
  );
}

function assertRuntimeCompatibilityMatchesBinding(
  current: ResidentRuntimeCompatibility,
  binding: ResidentSessionBinding,
): void {
  const currentAuthority = residentDispatchAuthorityFingerprint({
    ...binding,
    runtime: current,
  });
  if (currentAuthority === residentDispatchAuthorityFingerprint(binding)) return;
  throw new ResidentRuntimeContractError(
    "PRIME_RUNTIME_IDENTITY_MISMATCH",
    "The connected Prime Agent runtime no longer matches the exact resident binding.",
    { details: { activeSessionId: binding.activeSessionId } },
  );
}

function assertExactBindingAuthority(
  current: ResidentSessionBinding,
  candidate: ResidentSessionBinding,
): void {
  if (
    residentDispatchAuthorityFingerprint(current) ===
    residentDispatchAuthorityFingerprint(candidate)
  ) {
    return;
  }
  throw new ResidentRuntimeContractError(
    "PRIME_RUNTIME_SESSION_MISMATCH",
    "The requested resident binding conflicts with the exact attached authority.",
    { details: { activeSessionId: candidate.activeSessionId } },
  );
}

function assertBindingIdentity(current: ResidentSessionBinding, candidate: ResidentSessionBinding): void {
  if (
    current.threadId === candidate.threadId &&
    current.executionGenerationId === candidate.executionGenerationId &&
    current.sessionId === candidate.sessionId &&
    current.sessionFile === candidate.sessionFile &&
    sameWorkspacePath(current.workspaceDirectory, candidate.workspaceDirectory)
  ) {
    return;
  }
  throw new ResidentRuntimeContractError(
    "PRIME_RUNTIME_SESSION_MISMATCH",
    "The requested resident binding conflicts with an existing attachment.",
    { details: { activeSessionId: candidate.activeSessionId } },
  );
}

function assertWorkspaceMatches(actual: string, expected: string, source: string): void {
  if (sameWorkspacePath(actual, expected)) return;
  throw new ResidentRuntimeContractError(
    "PRIME_RUNTIME_SESSION_MISMATCH",
    `Prime Agent ${source} belongs to a different workspace.`,
    { details: { field: "cwd" } },
  );
}

function validateOwnedCandidateSessionFile(
  sessionFile: string | undefined,
  input: ResidentOwnedSessionCreateInput,
): string | undefined {
  if (sessionFile === undefined) {
    if (input.session.kind === "new") return undefined;
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_SESSION_MISMATCH",
      "Prime Agent did not return the exact imported session identity.",
      { details: { field: "sessionFile" } },
    );
  }
  if (!isAbsolute(sessionFile) || resolvePath(sessionFile) !== sessionFile) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_RESPONSE_INVALID",
      "Prime Agent returned a non-canonical owned-session path.",
      { details: { field: "sessionFile" } },
    );
  }
  if (
    input.session.kind === "resume" &&
    !sameWorkspacePath(sessionFile, input.session.sessionPath)
  ) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_SESSION_MISMATCH",
      "Prime Agent created a different session than the exact imported target.",
      { details: { field: "sessionFile" } },
    );
  }
  return sessionFile;
}

function sameWorkspacePath(left: string, right: string): boolean {
  const normalizedLeft = resolvePath(left);
  const normalizedRight = resolvePath(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function sameRuntimeCompatibility(
  left: ResidentRuntimeCompatibility,
  right: ResidentRuntimeCompatibility,
): boolean {
  return (
    left.releaseVersion === right.releaseVersion &&
    left.appVersion === right.appVersion &&
    left.protocolName === right.protocolName &&
    left.protocolVersion === right.protocolVersion &&
    left.schemaRevision === right.schemaRevision &&
    left.schemaId === right.schemaId &&
    left.runtimeBuildId === right.runtimeBuildId &&
    left.supervisorGeneration === right.supervisorGeneration &&
    left.capabilities.length === right.capabilities.length &&
    left.capabilities.every((capability, index) => capability === right.capabilities[index])
  );
}

function launchDaemon(options: ResolvedOptions): {
  readonly child: ResidentDaemonLauncher;
  readonly exited: boolean;
  readonly failure?: Error;
  details(): Readonly<Record<string, string | number | boolean>>;
} {
  let child: ResidentDaemonLauncher;
  try {
    child = options.spawnFactory(options.invocation.executable, options.invocation.argv, options.invocation.spawn);
  } catch (error) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_DAEMON_START_FAILED",
      "The Prime Agent daemon launcher could not be started.",
      { retryable: true, details: { cause: errorMessage(error) }, cause: error },
    );
  }

  let exited = false;
  let failure: Error | undefined;
  child.once("error", (error) => {
    failure = error instanceof Error ? error : new Error(String(error));
  });
  child.once("exit", (code, signal) => {
    exited = true;
    if (typeof code === "number" && code !== 0) {
      failure = new Error(`Prime Agent daemon launcher exited with code ${code}`);
    } else if (code === null && signal) {
      failure = new Error(`Prime Agent daemon launcher exited on ${String(signal)}`);
    }
  });
  child.unref();

  return {
    child,
    get exited() {
      return exited;
    },
    get failure() {
      return failure;
    },
    details: () => Object.freeze({
      ...(child.pid ? { launcherPid: child.pid } : {}),
      ...(failure ? { launcherFailure: failure.message.slice(0, 2_048) } : {}),
    }),
  };
}

function assertSameInvocation(actual: ResidentDaemonStartInvocation, expected: ResidentDaemonStartInvocation): void {
  if (
    actual.executable === expected.executable &&
    actual.argv.length === expected.argv.length &&
    actual.argv.every((argument, index) => argument === expected.argv[index]) &&
    actual.spawn.shell === false &&
    actual.spawn.windowsHide === true &&
    actual.spawn.detached === true &&
    actual.spawn.cwd === expected.spawn.cwd &&
    actual.spawn.stdio === "ignore" &&
    sameEnvironment(actual.spawn.env, expected.spawn.env)
  ) {
    return;
  }
  throw new ResidentRuntimeContractError(
    "PRIME_RUNTIME_ARGUMENT_INVALID",
    "Resident daemon invocation does not match the adapter's fixed launch plan.",
  );
}

function sameEnvironment(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => right[key] === value)
  );
}

function invalidResponse(command: string, issue?: string): ResidentRuntimeContractError {
  return new ResidentRuntimeContractError(
    "PRIME_RUNTIME_RESPONSE_INVALID",
    `Prime Agent returned an invalid ${command} response.`,
    { details: { command, ...(issue ? { issue: issue.slice(0, 1_024) } : {}) } },
  );
}

function incompatibleDaemonRetirementFailure(
  opened: IncompatibleOpenClient,
  reason: string,
  message: string,
  cause?: unknown,
  details: Readonly<Record<string, string | number | boolean>> = {},
): ResidentRuntimeContractError {
  return new ResidentRuntimeContractError(
    "PRIME_RUNTIME_DAEMON_RETIREMENT_FAILED",
    message,
    {
      retryable: true,
      details: {
        reason,
        incompatibility: opened.incompatibility.code,
        supervisorGeneration: opened.retirementTarget.supervisorGeneration,
        ...details,
        ...(cause === undefined ? {} : { cause: errorMessage(cause) }),
      },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

function normalizeRuntimeError(error: unknown, fallbackMessage: string): ResidentRuntimeContractError {
  if (error instanceof ResidentRuntimeContractError) return error;
  return new ResidentRuntimeContractError(
    "PRIME_RUNTIME_REQUEST_FAILED",
    fallbackMessage,
    { retryable: true, details: { cause: errorMessage(error) }, cause: error },
  );
}

function invalidResidentLifecycleAuthority(error: unknown): ResidentRuntimeContractError {
  if (
    error instanceof ResidentRuntimeContractError &&
    error.code === "PRIME_RUNTIME_LIFECYCLE_AUTHORITY_INVALID"
  ) {
    return error;
  }
  return new ResidentRuntimeContractError(
    "PRIME_RUNTIME_LIFECYCLE_AUTHORITY_INVALID",
    "Resident end requires fresh exact one-shot Store authority.",
    { details: { cause: errorMessage(error) }, cause: error },
  );
}

function freezeLifecycle(value: {
  state: ResidentRuntimeLifecycleState;
  changedAt: string;
  binding?: ResidentSessionBinding;
  error?: ResidentRuntimeStructuredError;
}): ResidentRuntimeLifecycleSnapshot {
  return Object.freeze({
    state: value.state,
    changedAt: value.changedAt,
    ...(value.binding ? { binding: value.binding } : {}),
    ...(value.error ? { error: value.error } : {}),
  });
}

function freezeBinding(binding: ResidentSessionBinding): ResidentSessionBinding {
  return Object.freeze({
    ...binding,
    runtime: Object.freeze({
      ...binding.runtime,
      capabilities: Object.freeze([...binding.runtime.capabilities]),
    }),
  });
}

function assertBoundedJson(value: unknown, maxBytes: number, label: string): void {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes) {
      throw new Error(`${label} exceeds its ${maxBytes}-byte bound`);
    }
  } catch (error) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_RESPONSE_INVALID",
      `Prime Agent returned a non-serializable or oversized ${label}.`,
      { details: { label, maxBytes, cause: errorMessage(error) }, cause: error },
    );
  }
}

function boundedTimeout(value: number | undefined, fallback: number, field: string): number {
  return boundedInteger(value, fallback, 10, 120_000, field);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_ARGUMENT_INVALID",
      `Resident runtime ${field} is invalid.`,
      { details: { field } },
    );
  }
  return resolved;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_048);
}

function safeErrorMessage(error: unknown): string {
  try {
    return errorMessage(error);
  } catch {
    return "Error details unavailable";
  }
}

function closeDaemonClientQuietly(client: PrimeDaemonClientPublic | undefined): void {
  try {
    client?.close();
  } catch {
    // Closing a process-local transport is best effort and carries no durable
    // Prime or Store lifecycle authority.
  }
}

function isDefinitiveEndpointAbsence(error: unknown): boolean {
  const messages: string[] = [];
  let candidate: unknown = error;
  for (let depth = 0; depth < 4 && candidate !== undefined; depth += 1) {
    messages.push(errorMessage(candidate));
    candidate = candidate instanceof Error ? candidate.cause : undefined;
  }
  return messages.some((message) => /\b(?:ECONNREFUSED|ENOENT)\b/i.test(message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
