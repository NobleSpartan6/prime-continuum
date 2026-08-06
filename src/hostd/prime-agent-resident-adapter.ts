import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
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
const DEFAULT_MAX_LAUNCH_OUTPUT_BYTES = 32 * 1024;
const MAX_RUNTIME_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const MAX_LIVE_SESSIONS = 10_000;

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

type LiveSessionSummary = z.infer<typeof LiveSessionSummarySchema>;

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

interface ResidentDaemonOutput {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
}

export interface ResidentDaemonLauncher {
  readonly pid?: number;
  readonly stdout?: ResidentDaemonOutput | null;
  readonly stderr?: ResidentDaemonOutput | null;
  once(event: "error" | "exit", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type ResidentDaemonSpawn = (
  executable: string,
  argv: readonly string[],
  options: ResidentDaemonStartInvocation["spawn"],
) => ResidentDaemonLauncher;

export interface PrimeAgentResidentAdapterOptions {
  readonly socketPath: string;
  readonly executable?: string;
  readonly cliEntrypoint?: string;
  /** Must resolve only after the package archive and install tree are verified. */
  readonly loadRuntimeModule: PrimeAgentPublicModuleLoader;
  /** Durable host write performed after create succeeds and before attach begins. */
  readonly persistBinding: (binding: ResidentSessionBinding) => Promise<void>;
  /** Durable host transition performed only after an explicit kill is confirmed. */
  readonly completeBinding: (binding: ResidentSessionBinding) => Promise<void>;
  readonly spawnFactory?: ResidentDaemonSpawn;
  readonly connectTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxLaunchOutputBytes?: number;
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

interface ResolvedOptions {
  readonly invocation: ResidentDaemonStartInvocation;
  readonly socketPath: string;
  readonly loadRuntimeModule: PrimeAgentPublicModuleLoader;
  readonly persistBinding: (binding: ResidentSessionBinding) => Promise<void>;
  readonly completeBinding: (binding: ResidentSessionBinding) => Promise<void>;
  readonly spawnFactory: ResidentDaemonSpawn;
  readonly connectTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxLaunchOutputBytes: number;
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
export class PrimeAgentResidentAdapter implements ResidentRuntimeAdapter {
  private readonly options: ResolvedOptions;
  private readonly lifecycle: LifecycleController;
  private readonly connections = new Map<string, ManagedResidentRuntimeConnection>();
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
    });
    this.options = Object.freeze({
      invocation,
      socketPath: invocation.argv.at(-1)!,
      loadRuntimeModule: options.loadRuntimeModule,
      persistBinding: options.persistBinding,
      completeBinding: options.completeBinding,
      spawnFactory: options.spawnFactory ?? defaultResidentDaemonSpawn,
      connectTimeoutMs: boundedTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, "connectTimeoutMs"),
      startupTimeoutMs: boundedTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs"),
      requestTimeoutMs: boundedTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs"),
      maxLaunchOutputBytes: boundedInteger(
        options.maxLaunchOutputBytes,
        DEFAULT_MAX_LAUNCH_OUTPUT_BYTES,
        1_024,
        1024 * 1024,
        "maxLaunchOutputBytes",
      ),
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
        await validateInitialSnapshot(attached, binding);
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
        await validateInitialSnapshot(attached, refreshedBinding);
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
        compatibility: validateResidentDaemonHello(hello, { expectedSocketPath: this.options.socketPath }),
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
      persistBinding: this.options.persistBinding,
      completeBinding: this.options.completeBinding,
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
      persistBinding: (binding: ResidentSessionBinding) => Promise<void>;
      completeBinding: (binding: ResidentSessionBinding) => Promise<void>;
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
    this.terminalPromise = operation().then(
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
        });
        validateInitialSnapshotValue(event.snapshot, this.binding);
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
    stdio: [...options.stdio],
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

async function validateInitialSnapshot(
  connection: PrimeDaemonAgentConnectionPublic,
  binding: ResidentSessionBinding,
): Promise<void> {
  const snapshot = await connection.getInitialSnapshot().catch((error) => {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_REQUEST_FAILED",
      "Prime Agent attach did not produce an authoritative initial snapshot.",
      { retryable: true, details: { cause: errorMessage(error) }, cause: error },
    );
  });
  validateInitialSnapshotValue(snapshot, binding);
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
  const stdout = new BoundedOutput(options.maxLaunchOutputBytes);
  const stderr = new BoundedOutput(options.maxLaunchOutputBytes);
  child.stdout?.on("data", (chunk) => stdout.append(chunk));
  child.stderr?.on("data", (chunk) => stderr.append(chunk));
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
      ...(stdout.text ? { stdout: stdout.text } : {}),
      ...(stderr.text ? { stderr: stderr.text } : {}),
      ...(stdout.truncated || stderr.truncated ? { outputTruncated: true } : {}),
    }),
  };
}

class BoundedOutput {
  private bytes = 0;
  private value = "";
  truncated = false;

  constructor(private readonly limit: number) {}

  append(chunk: unknown): void {
    if (this.bytes >= this.limit) {
      this.truncated = true;
      return;
    }
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const available = this.limit - this.bytes;
    const buffer = Buffer.from(text, "utf8");
    const accepted = buffer.subarray(0, available);
    this.value += accepted.toString("utf8");
    this.bytes += accepted.byteLength;
    if (accepted.byteLength < buffer.byteLength) this.truncated = true;
  }

  get text(): string {
    return this.value.trim().slice(0, 2_048);
  }
}

function assertSameInvocation(actual: ResidentDaemonStartInvocation, expected: ResidentDaemonStartInvocation): void {
  if (
    actual.executable === expected.executable &&
    actual.argv.length === expected.argv.length &&
    actual.argv.every((argument, index) => argument === expected.argv[index]) &&
    actual.spawn.shell === false &&
    actual.spawn.windowsHide === true &&
    actual.spawn.stdio.join(",") === "ignore,pipe,pipe"
  ) {
    return;
  }
  throw new ResidentRuntimeContractError(
    "PRIME_RUNTIME_ARGUMENT_INVALID",
    "Resident daemon invocation does not match the adapter's fixed launch plan.",
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
