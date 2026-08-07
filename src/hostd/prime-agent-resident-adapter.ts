import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CommandEnvelopeSchema, type CommandEnvelope } from "../shared/protocol";
import {
  GatewayError,
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
  buildResidentDaemonCreateRequest,
  buildResidentDaemonStartInvocation,
  validateResidentDaemonHello,
  validateResidentSessionBinding,
  type ResidentDaemonStartInvocation,
  type ResidentRuntimeAdapter,
  type ResidentRuntimeCompatibility,
  type ResidentRuntimeConnection,
  type ResidentRuntimeLifecycleListener,
  type ResidentRuntimeLifecycleSnapshot,
  type ResidentRuntimeLifecycleState,
  type ResidentRuntimeStructuredError,
  type ResidentSessionBinding,
  type ResidentSessionCreateInput,
} from "./resident-runtime";

const DEFAULT_CONNECT_TIMEOUT_MS = 750;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RUNTIME_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const MAX_LIVE_SESSIONS = 10_000;
const MAX_AVAILABLE_MODELS = 5_000;
const MAX_MODEL_SELECTION_IDENTITIES = 10_000;
const MAX_AUTHORITATIVE_MODEL_SNAPSHOT_READS = 4;

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
  /** Pinned public AgentConnection methods; guarded at the mutation boundary. */
  getAvailableModels?(): Promise<unknown>;
  setModel?(provider: string, modelId: string): Promise<unknown>;
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
        ownedSession: false;
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
        await publishInitialProjection(attached, binding, this.options.publishProjection);
        this.assertOpen();
        const connection = this.registerConnection(binding, client, attached);
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
        await publishInitialProjection(attached, refreshedBinding, this.options.publishProjection);
        this.assertOpen();
        const connection = this.registerConnection(refreshedBinding, client, attached);
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

  submit(commandValue: CommandEnvelope, context?: GatewayDispatchContext): Promise<GatewayAdmission> {
    const command = CommandEnvelopeSchema.parse(commandValue);
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

  close(): Promise<void> {
    this.closeRequested = true;
    this.closePromise ??= this.enqueue(async () => {
      if (this.closed) return;
      await this.daemonEnsurePromise?.catch(() => undefined);
      const connections = [...this.connections.values()];
      const outcomes = await Promise.allSettled(connections.map((connection) => connection.detach()));
      outcomes.forEach((outcome, index) => {
        if (outcome.status === "rejected") connections[index]?.forceClose();
      });
      this.connections.clear();
      this.modelSelectionAttempts.clear();
      this.closed = true;
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
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
  ): Promise<PrimeDaemonAgentConnectionPublic> {
    return runtimeModule.DaemonAgentConnection.attach(client, activeSessionId, {
      closeClientOnDispose: true,
      sendClientEnv: false,
      supportsExtensionUi: false,
      ownedSession: false,
      // Do not re-enter the adapter operation queue: recovery may be invoked
      // by static attach while create/attach itself owns that queue.
      recoverDaemon: async () => void (await this.ensureDaemonSingleFlight()),
    });
  }

  private registerConnection(
    binding: ResidentSessionBinding,
    client: PrimeDaemonClientPublic,
    attached: PrimeDaemonAgentConnectionPublic,
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
      expectedSocketPath: this.options.socketPath,
      expectedExecutablePath: this.options.invocation.executable,
      expectedEntrypointPath: this.options.invocation.argv[0],
      persistBinding: this.options.persistBinding,
      completeBinding: this.options.completeBinding,
      publishProjection: this.options.publishProjection,
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

class ManagedResidentRuntimeConnection implements ResidentRuntimeConnection {
  private readonly lifecycle: LifecycleController;
  private bindingValue: ResidentSessionBinding;
  private unsubscribeUpstream: () => void = () => undefined;
  private eventTail: Promise<void> = Promise.resolve();
  private modelSelectionTail: Promise<void> = Promise.resolve();
  private terminalAction: "detach" | "end" | undefined;
  private terminalPromise: Promise<void> | undefined;
  private workerEnded = false;
  private locallyClosed = false;
  private resyncValidated = false;

  constructor(
    private readonly options: Readonly<{
      binding: ResidentSessionBinding;
      client: PrimeDaemonClientPublic;
      attached: PrimeDaemonAgentConnectionPublic;
      requestTimeoutMs: number;
      now: () => Date;
      expectedSocketPath: string;
      expectedExecutablePath: string;
      expectedEntrypointPath: string;
      persistBinding: (binding: ResidentSessionBinding) => Promise<void>;
      completeBinding: (binding: ResidentSessionBinding) => Promise<void>;
      publishProjection: (
        binding: ResidentSessionBinding,
        projection: ResidentProjectionSnapshot,
      ) => Promise<void>;
      onClosed: () => void;
    }>,
  ) {
    this.bindingValue = options.binding;
    this.lifecycle = new LifecycleController(options.now, "ready", options.binding);
    this.unsubscribeUpstream = options.attached.subscribe((event) => {
      const operation = this.eventTail.then(() => this.handleUpstreamEvent(event));
      this.eventTail = operation.catch((error) => this.failFromUpstream(error));
      return this.eventTail;
    });
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
    const operation = this.modelSelectionTail.then(() =>
      this.selectModelOnce(selection.provider, selection.id, durableBinding),
    );
    this.modelSelectionTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  detach(): Promise<void> {
    return this.runTerminal("detach", async () => {
      this.lifecycle.transition("detaching", { binding: this.binding });
      await this.options.attached.dispose();
      this.unsubscribeUpstream();
    });
  }

  endSession(): Promise<void> {
    return this.runTerminal("end", async () => {
      this.lifecycle.transition("detaching", { binding: this.binding });
      if (!this.workerEnded) {
        await requestDaemon(
          this.options.client,
          { type: "kill", activeSessionId: this.binding.activeSessionId },
          this.options.requestTimeoutMs,
          "kill",
          true,
        );
        this.workerEnded = true;
        // Public dispose performs the connection's listener/snapshot cleanup.
        // Its best-effort post-kill detach cannot stop another resident worker.
        await this.options.attached.dispose().catch(() => this.options.client.close());
        this.unsubscribeUpstream();
      }
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
    this.unsubscribeUpstream();
    this.options.client.close();
    this.lifecycle.transition("closed", { binding: this.binding });
    this.options.onClosed();
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
    // A terminal transition closes admission immediately, then waits for any
    // already-running selection. Queued selections observe terminalAction and
    // fail before setModel can be invoked.
    this.terminalPromise = this.modelSelectionTail.then(operation).then(
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
        return;
      }
      case "session_replaced":
        validateInitialSnapshotValue({ state: event.state, messages: event.messages }, this.binding);
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
    this.unsubscribeUpstream();
    this.options.client.close();
    this.lifecycle.transition("failed", { binding: this.binding, error: normalized.toJSON() });
    this.options.onClosed();
  }
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
): Promise<void> {
  const snapshot = await connection.getInitialSnapshot().catch((error) => {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_REQUEST_FAILED",
      "Prime Agent attach did not produce an authoritative initial snapshot.",
      { retryable: true, details: { cause: errorMessage(error) }, cause: error },
    );
  });
  const projection = normalizeProjection(snapshot, binding);
  await publishProjection(publisher, binding, projection);
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
