import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CommandEnvelopeSchema, type CommandEnvelope } from "../shared/protocol";
import {
  GatewayError,
  residentCommandEnvelopeFingerprint,
  type GatewayAdmission,
  type GatewayDispatchContext,
  type PrimeAgentGateway,
} from "./gateway";
import {
  ResidentProjectionError,
  normalizeResidentProjectionSnapshot,
  type ResidentProjectionSnapshot,
} from "./resident-projection";
import {
  ResidentRuntimeContractError,
  buildResidentOwnedDaemonCreateRequest,
  buildResidentDaemonCreateRequest,
  buildResidentDaemonStartInvocation,
  validateResidentAbortIdleReconciliationRequest,
  validateResidentDaemonHello,
  validateResidentGenerationDispatchLease,
  validateResidentPromptIdleReconciliationRequest,
  validateResidentOwnedSessionCreateInput,
  validateResidentSessionBinding,
  type ResidentDaemonStartInvocation,
  type ResidentAbortIdleAuthorityEvidence,
  type ResidentAbortIdleReconciliationRequest,
  type ResidentDispatchOperation,
  type ResidentDispatchResult,
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
  type ResidentAbortReconciliationLease,
  type ResidentDispatchLease,
  type ResidentPromptReconciliationLease,
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
const MAX_AUTHORITATIVE_MODEL_SNAPSHOT_READS = 4;
const MAX_AUTHORITATIVE_RESIDENT_SNAPSHOT_READS = 4;
const RESIDENT_PROJECTION_COALESCE_MS = 100;
const PROMPT_ADMISSION_CANCEL_GRACE_MS = 2_000;
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
  /** v0.7.0 waits for the action pump, agent, and server-side event queue to become idle. */
  waitForIdle?(): Promise<void>;
  /** Pinned public AgentConnection methods; guarded at the mutation boundary. */
  getAvailableModels?(): Promise<unknown>;
  setModel?(provider: string, modelId: string): Promise<unknown>;
  /** v0.7.0 resolves prompt when the worker accepts/owns it, not at turn completion. */
  prompt?(
    message: string,
    options?: Readonly<{ queueIfBusy?: boolean; signal?: AbortSignal }>,
  ): Promise<void>;
  /** v0.7.0 resolves abort when requestAbort() is accepted, not when stopping completes. */
  abort?(): Promise<void>;
  /** v0.7.0 promotes one client-owned worker to ordinary resident lifetime. */
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
        supportsExtensionUi: false;
        ownedSession: boolean;
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
  readonly socketPath: string;
  /** Absolute, verified Node-compatible executable for the pinned runtime. */
  readonly executable: string;
  /** Absolute, verified v0.7.0 dist/bundle/cli.js entrypoint. */
  readonly cliEntrypoint: string;
  /** Absolute, writable host-owned directory used instead of ambient cwd. */
  readonly daemonWorkingDirectory: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /** Must resolve only after the package archive and install tree are verified. */
  readonly loadRuntimeModule: PrimeAgentPublicModuleLoader;
  /** Durable host write performed after create succeeds and before attach begins. */
  readonly persistBinding: (binding: ResidentSessionBinding) => Promise<void>;
  /** Durable host transition performed only after an explicit kill is confirmed. */
  readonly completeBinding: (binding: ResidentSessionBinding) => Promise<void>;
  /** Durable host publication of a normalized authoritative runtime snapshot. */
  readonly publishProjection: (
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>;
  readonly spawnFactory?: ResidentDaemonSpawn;
  readonly connectTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

interface ResolvedOptions {
  readonly invocation: ResidentDaemonStartInvocation;
  readonly socketPath: string;
  readonly loadRuntimeModule: PrimeAgentPublicModuleLoader;
  readonly persistBinding: (binding: ResidentSessionBinding) => Promise<void>;
  readonly completeBinding: (binding: ResidentSessionBinding) => Promise<void>;
  readonly publishProjection: (
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>;
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
    });
    this.options = Object.freeze({
      invocation,
      socketPath: invocation.argv.at(-1)!,
      loadRuntimeModule: options.loadRuntimeModule,
      persistBinding: options.persistBinding,
      completeBinding: options.completeBinding,
      publishProjection: options.publishProjection,
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

  async isLive(threadId: string, executionGenerationId: string): Promise<boolean> {
    if (this.closeRequested || this.closed) return false;
    const connection = [...this.connections.values()].find(
      (candidate) =>
        candidate.binding.threadId === threadId &&
        candidate.binding.executionGenerationId === executionGenerationId,
    );
    return connection?.isLive() ?? false;
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
      .selectModel(command.command.providerId, command.command.modelId, durableBinding)
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
      const opened = await this.openValidatedClient(runtimeModule);
      opened.client.close();
      this.lifecycle.transition("ready");
      return opened.compatibility;
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

  private async openValidatedClient(runtimeModule: PrimeAgentPublicModule): Promise<OpenClient> {
    const client = new runtimeModule.DaemonClient(this.options.socketPath);
    try {
      await client.connect(this.options.connectTimeoutMs);
    } catch (error) {
      client.close();
      throw new DaemonUnavailableError(error);
    }
    try {
      const hello = client.hello ?? (await client.waitForHello(this.options.connectTimeoutMs));
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
      supportsExtensionUi: false,
      ownedSession,
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
      client,
      attached,
      requestTimeoutMs: this.options.requestTimeoutMs,
      now: this.options.now,
      wait: this.options.wait,
      expectedSocketPath: this.options.socketPath,
      expectedExecutablePath: this.options.invocation.executable,
      expectedEntrypointPath: this.options.invocation.argv[0],
      persistBinding: this.options.persistBinding,
      completeBinding: this.options.completeBinding,
      publishProjection: this.options.publishProjection,
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
  private promptIdleReconciliationRecord: PromptIdleReconciliationRecord | undefined;
  private abortIdleReconciliationRecord: AbortIdleReconciliationRecord | undefined;
  private residentIdleReconciliationCancellation: ResidentIdleReconciliationCancellation | undefined;
  private readonly residentDispatchAttempts = new Map<string, ResidentDispatchAttemptRecord>();
  private readonly settledResidentDispatchAttemptIds = new Set<string>();
  private readonly retiredResidentDispatchFence = new RetiredResidentDispatchFence();
  private readonly queuedPromptAdmissions: PromptAdmissionAttempt[] = [];
  private activePromptAdmission: PromptAdmissionAttempt | undefined;
  private uncertainPromptAdmission: PromptAdmissionAttempt | undefined;
  private cancelledPromptAdmission: PromptAdmissionAttempt | undefined;
  private authoritativeProjectionValue: ResidentProjectionSnapshot | undefined;
  private readonly retiredAuthoritativeCursorGenerations = new Set<string>();
  private projectionRefreshRequested = false;
  private projectionRefreshPromise: Promise<void> | undefined;
  private terminalAction: "detach" | "end" | undefined;
  private terminalPromise: Promise<void> | undefined;
  private workerEnded = false;
  private readAuthorityDisposed = false;
  private locallyClosed = false;
  private resyncValidated = false;

  constructor(
    private readonly options: Readonly<{
      binding: ResidentSessionBinding;
      client: PrimeDaemonClientPublic;
      attached: PrimeDaemonAgentConnectionPublic;
      requestTimeoutMs: number;
      now: () => Date;
      wait: (milliseconds: number) => Promise<void>;
      expectedSocketPath: string;
      expectedExecutablePath: string;
      expectedEntrypointPath: string;
      persistBinding: (binding: ResidentSessionBinding) => Promise<void>;
      completeBinding: (binding: ResidentSessionBinding) => Promise<void>;
      publishProjection: (
        binding: ResidentSessionBinding,
        projection: ResidentProjectionSnapshot,
      ) => Promise<void>;
      initialProjection: ResidentProjectionSnapshot | undefined;
      refreshProjectionOnStart: boolean;
      onClosed: () => void;
    }>,
  ) {
    this.bindingValue = options.binding;
    this.authoritativeProjectionValue = options.initialProjection;
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

  selectModel(
    providerId: string,
    modelId: string,
    expectedBinding: ResidentSessionBinding,
  ): Promise<SanitizedResidentModelIdentity> {
    const selection = ModelSelectionIdentitySchema.parse({ provider: providerId, id: modelId });
    const durableBinding = validateResidentSessionBinding(expectedBinding);
    return this.enqueueModelMutation(() => this.selectModelOnce(selection.provider, selection.id, durableBinding));
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

    const result = this.enqueueResidentIdleReconciliation(() =>
      this.reconcileAcknowledgedPromptIdleOnce(request),
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
    return this.runTerminal("detach", async () => {
      this.lifecycle.transition("detaching", { binding: this.binding });
      await this.disposeReadAuthorityAndDrainReconciliation();
      await this.drainProjectionRefresh();
    });
  }

  endSession(): Promise<void> {
    return this.runTerminal("end", async () => {
      this.lifecycle.transition("detaching", { binding: this.binding });
      let terminalFailure: unknown;
      if (!this.workerEnded) {
        try {
          await requestDaemon(
            this.options.client,
            { type: "kill", activeSessionId: this.binding.activeSessionId },
            this.options.requestTimeoutMs,
            "kill",
            true,
          );
          this.workerEnded = true;
        } catch (error) {
          terminalFailure = error;
        }
      }
      // Public dispose performs listener/snapshot cleanup and closes this
      // client. It cannot stop another resident worker; only the explicit kill
      // above owns that authority.
      await this.disposeReadAuthorityAndDrainReconciliation().catch((error) => {
        terminalFailure ??= error;
      });
      await this.drainProjectionRefresh();
      if (terminalFailure) throw terminalFailure;
      await this.options.completeBinding(this.binding).catch((error) => {
        throw new ResidentRuntimeContractError(
          "PRIME_RUNTIME_BINDING_PERSIST_FAILED",
          "Prime Agent ended, but its durable resident binding could not be completed.",
          { retryable: true, details: { cause: errorMessage(error) }, cause: error },
        );
      });
    });
  }

  forceClose(): void {
    if (this.locallyClosed) return;
    this.locallyClosed = true;
    this.projectionRefreshRequested = false;
    this.unsubscribeUpstream();
    this.options.client.close();
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

  private async reconcileAcknowledgedPromptIdleOnce(
    request: ResidentPromptIdleReconciliationRequest,
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
      await Promise.race([
        waitForIdle.call(this.options.attached),
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

    const projection = await readStableResidentProjection(this.options.attached, expectedBinding);
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
        waitForIdle.call(this.options.attached),
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
    const projection = await readStableResidentProjection(this.options.attached, expectedBinding);
    if (!projection) {
      // A continuously advancing cursor is normal while a model streams. Do
      // not publish a torn multi-RPC projection and do not fail the resident
      // connection; retain one dirty bit and retry after the bounded backoff.
      this.projectionRefreshRequested = true;
      return;
    }
    if (
      this.locallyClosed ||
      this.terminalAction ||
      !this.isLive() ||
      !isDeepStrictEqual(this.binding, expectedBinding)
    ) {
      return;
    }
    await publishProjection(this.options.publishProjection, expectedBinding, projection);
    this.acceptAuthoritativeProjection(projection);
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

  private runTerminal(action: "detach" | "end", operation: () => Promise<void>): Promise<void> {
    if (this.terminalPromise) {
      if (this.terminalAction === action) return this.terminalPromise;
      return Promise.reject(
        new ResidentRuntimeContractError(
          "PRIME_RUNTIME_TERMINAL_ACTION_CONFLICT",
          `Cannot ${action === "end" ? "end" : "detach"} a resident session while ${this.terminalAction} is in progress.`,
          { details: { requested: action, active: this.terminalAction ?? "unknown" } },
        ),
      );
    }
    this.terminalAction = action;
    // A terminal transition closes admission immediately, then drains the
    // per-session mutation tail. Queued mutations observe terminalAction and
    // fail before any upstream mutation method can be invoked.
    this.terminalPromise = Promise.all([
      this.promptAdmissionTail,
      this.abortTail,
      this.modelMutationTail,
    ]).then(operation).then(
      () => {
        if (this.locallyClosed) return;
        this.locallyClosed = true;
        this.lifecycle.transition("closed", { binding: this.binding });
        this.options.onClosed();
      },
      (error) => {
        const normalized = normalizeRuntimeError(error, `Prime Agent ${action} failed.`);
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
      // A resolved setModel invalidates the pinned connection's snapshot cache;
      // consecutive equal cursor/projection reads additionally prove that the
      // pinned multi-RPC snapshot did not race a concurrent daemon event.
      const projection = await readStableModelSelectionProjection(
        this.options.attached,
        expectedBinding,
        providerId,
        modelId,
      );
      await publishProjection(this.options.publishProjection, expectedBinding, projection);
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
    switch (event.type) {
      case "connection_status": {
        if (event.status === "reconnecting") {
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
        const projection = normalizeProjection(event.snapshot, this.binding);
        await publishProjection(this.options.publishProjection, this.binding, projection);
        await this.refreshRuntimeBinding(compatibility);
        this.resyncValidated = true;
        this.acceptAuthoritativeProjection(projection);
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
  let previous: ResidentProjectionSnapshot | undefined;
  for (let read = 0; read < MAX_AUTHORITATIVE_RESIDENT_SNAPSHOT_READS; read += 1) {
    const snapshot = await connection.getInitialSnapshot();
    const projection = normalizeProjection(snapshot, binding);
    if (previous && isDeepStrictEqual(previous, projection)) return projection;
    previous = projection;
  }
  return undefined;
}

function normalizeProjection(
  snapshot: unknown,
  binding: ResidentSessionBinding,
): ResidentProjectionSnapshot {
  try {
    return normalizeResidentProjectionSnapshot(snapshot, binding);
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
  binding: ResidentSessionBinding,
  providerId: string,
  modelId: string,
): Promise<ResidentProjectionSnapshot> {
  let previous:
    | Readonly<{
        cursor: Readonly<{ generation: string; sequence: number }>;
        projection: ResidentProjectionSnapshot;
      }>
    | undefined;
  for (let read = 0; read < MAX_AUTHORITATIVE_MODEL_SNAPSHOT_READS; read += 1) {
    const snapshot = await connection.getInitialSnapshot();
    const cursor = assertSelectedModelSnapshot(snapshot, binding, providerId, modelId);
    const projection = normalizeProjection(snapshot, binding);
    if (
      previous &&
      isDeepStrictEqual(previous.cursor, cursor) &&
      isDeepStrictEqual(previous.projection, projection)
    ) {
      return projection;
    }
    previous = Object.freeze({ cursor, projection });
  }
  throw new ResidentRuntimeContractError(
    "PRIME_RUNTIME_RESPONSE_INVALID",
    "Prime Agent state changed throughout authoritative model-selection reconciliation.",
  );
}

function assertSelectedModelSnapshot(
  snapshot: unknown,
  binding: ResidentSessionBinding,
  providerId: string,
  modelId: string,
): Readonly<{ generation: string; sequence: number }> {
  assertBoundedJson(snapshot, MAX_RUNTIME_SNAPSHOT_BYTES, "model-selection snapshot");
  const parsed = ModelSelectionSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw invalidResponse("model-selection snapshot");
  const state = parsed.data.state;
  if (
    state.activeSessionId !== binding.activeSessionId ||
    state.sessionId !== binding.sessionId ||
    (binding.sessionFile !== undefined && state.sessionFile !== binding.sessionFile) ||
    !sameWorkspacePath(state.cwd, binding.workspaceDirectory) ||
    state.model.provider !== providerId ||
    state.model.id !== modelId
  ) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_SESSION_MISMATCH",
      "The authoritative model-selection snapshot does not match its durable resident authority.",
    );
  }
  return Object.freeze({
    generation: parsed.data.lastEventCursor.generation,
    sequence: parsed.data.lastEventCursor.sequence,
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

function normalizeRuntimeError(error: unknown, fallbackMessage: string): ResidentRuntimeContractError {
  if (error instanceof ResidentRuntimeContractError) return error;
  return new ResidentRuntimeContractError(
    "PRIME_RUNTIME_REQUEST_FAILED",
    fallbackMessage,
    { retryable: true, details: { cause: errorMessage(error) }, cause: error },
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
