import { EventEmitter } from "node:events";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  PrimeDaemonAgentConnectionPublic,
  PrimeDaemonClientPublic,
} from "../../src/hostd/prime-agent-resident-adapter";
import {
  ResidentWorkerRemoteError,
  ResidentWorkerTransportError,
  createPrimeAgentResidentWorkerModuleLoader,
  type ResidentWorkerFactory,
  type ResidentWorkerLike,
} from "../../src/hostd/prime-agent-resident-worker-proxy";
import {
  RESIDENT_WORKER_PROTOCOL,
  RESIDENT_WORKER_PROTOCOL_VERSION,
  type ResidentWorkerBootstrap,
} from "../../src/hostd/prime-agent-resident-worker-protocol";
import {
  ResidentRuntimeWorkerServer,
  type ResidentWorkerPort,
  type ResidentWorkerRuntimeModule,
} from "../../src/hostd/prime-agent-resident-worker-server";
import type { VerifiedInstalledRuntimeHandle } from "../../src/hostd/runtime-integrity-manager";

interface ProxyModule {
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
        telemetryDisabled: true;
        recoverDaemon: () => Promise<void>;
      }>,
    ): Promise<PrimeDaemonAgentConnectionPublic & { promoteToResident(): Promise<void> }>;
  }>;
}

type AttachOptions = Parameters<ResidentWorkerRuntimeModule["DaemonAgentConnection"]["attach"]>[2];

interface RuntimeFixtureOptions {
  readonly recoverDuringAttach?: boolean;
  readonly waitForIdle?: (connection: FakeConnection) => Promise<void>;
  readonly setModel?: (providerId: string, modelId: string) => Promise<unknown>;
  readonly prompt?: (
    message: string,
    options: Readonly<{ queueIfBusy?: boolean; signal?: AbortSignal }>,
  ) => Promise<void>;
  readonly snapshot?: () => Promise<unknown>;
  readonly resources?: () => Promise<unknown>;
  readonly models?: () => Promise<unknown>;
  readonly dispose?: () => Promise<void>;
  readonly promote?: () => Promise<void>;
}

interface RuntimeFixtureState {
  readonly attachCalls: Array<Readonly<{ activeSessionId: string; options: AttachOptions }>>;
  readonly clients: FakeClient[];
  readonly connection: FakeConnection;
  readonly recoveries: string[];
  readonly recoverDaemon: () => Promise<void>;
}

class FakeClient {
  readonly hello = Object.freeze({ version: 1, capabilities: ["resident"] });
  isConnected = false;
  closeCalls = 0;

  constructor(readonly socketPath: string) {}

  async connect(): Promise<void> {
    this.isConnected = true;
  }

  async waitForHello(): Promise<unknown> {
    return this.hello;
  }

  async request(command: Readonly<object>): Promise<unknown> {
    return Object.freeze({ ok: true, command });
  }

  close(): void {
    this.closeCalls += 1;
    this.isConnected = false;
  }
}

class FakeConnection {
  readonly client: FakeClient;
  private readonly options: RuntimeFixtureOptions;
  private readonly listeners = new Set<(event: unknown) => void | Promise<void>>();
  disposeCalls = 0;
  abortCalls = 0;
  promotionCalls = 0;

  constructor(client: FakeClient, options: RuntimeFixtureOptions) {
    this.client = client;
    this.options = options;
  }

  async getInitialSnapshot(): Promise<unknown> {
    return this.options.snapshot?.() ?? Object.freeze({ session: { status: "idle" } });
  }

  async waitForIdle(): Promise<void> {
    await this.options.waitForIdle?.(this);
  }

  async getResourceSnapshot(): Promise<unknown> {
    return this.options.resources?.() ?? Object.freeze({
      contextFiles: [],
      skills: [],
      prompts: [],
      extensions: [],
      themes: [],
      diagnostics: { skills: [], prompts: [], extensions: [], themes: [] },
    });
  }

  async getAvailableModels(): Promise<unknown> {
    return this.options.models?.() ?? Object.freeze({ providers: [] });
  }

  async setModel(providerId: string, modelId: string): Promise<unknown> {
    return this.options.setModel?.(providerId, modelId) ?? Object.freeze({ providerId, modelId });
  }

  async promoteToResident(): Promise<void> {
    this.promotionCalls += 1;
    await this.options.promote?.();
  }

  async prompt(
    message: string,
    options: Readonly<{ queueIfBusy?: boolean; signal?: AbortSignal }> = {},
  ): Promise<void> {
    await this.options.prompt?.(message, options);
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  subscribe(listener: (event: unknown) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: unknown): void {
    for (const listener of this.listeners) void listener(event);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.listeners.clear();
    await this.options.dispose?.();
    // This is the exact public attach contract: upstream owns client close.
    this.client.close();
  }
}

function runtimeFixture(options: RuntimeFixtureOptions = {}): {
  readonly runtime: ResidentWorkerRuntimeModule;
  readonly state: RuntimeFixtureState;
} {
  const clients: FakeClient[] = [];
  const attachCalls: RuntimeFixtureState["attachCalls"] = [];
  const recoveries: string[] = [];
  let connection: FakeConnection | undefined;
  let recoverDaemon: (() => Promise<void>) | undefined;
  class RuntimeClient extends FakeClient {
    constructor(socketPath: string) {
      super(socketPath);
      clients.push(this);
    }
  }
  const runtime = Object.freeze({
    DaemonClient: RuntimeClient,
    DaemonAgentConnection: Object.freeze({
      async attach(client: FakeClient, activeSessionId: string, attachOptions: AttachOptions) {
        attachCalls.push(Object.freeze({ activeSessionId, options: attachOptions }));
        recoverDaemon = attachOptions.recoverDaemon;
        if (options.recoverDuringAttach) {
          await attachOptions.recoverDaemon();
          recoveries.push(activeSessionId);
        }
        connection = new FakeConnection(client, options);
        return connection;
      },
    }),
  }) satisfies ResidentWorkerRuntimeModule;
  const state = {
    attachCalls,
    clients,
    recoveries,
    get connection(): FakeConnection {
      if (!connection) throw new Error("Fake connection has not attached");
      return connection;
    },
    get recoverDaemon(): () => Promise<void> {
      if (!recoverDaemon) throw new Error("Fake recovery callback has not attached");
      return recoverDaemon;
    },
  } satisfies RuntimeFixtureState;
  return { runtime, state };
}

class LinkedWorker extends EventEmitter implements ResidentWorkerLike {
  readonly hostMessages: unknown[] = [];
  readonly workerMessages: unknown[] = [];
  private readonly heldWorkerMessages: unknown[] = [];
  private port: LinkedWorkerPort | undefined;
  private ended = false;
  private workerMessageDeliveryHeld = false;

  bind(port: LinkedWorkerPort): void {
    this.port = port;
  }

  postMessage(value: unknown): void {
    if (this.ended) throw new Error("Linked worker is closed");
    const cloned = structuredClone(value);
    this.hostMessages.push(cloned);
    this.port?.deliver(cloned);
  }

  on(event: "message", listener: (value: unknown) => void): this {
    return super.on(event, listener);
  }

  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number) => void): this;
  once(event: "error" | "exit", listener: ((error: Error) => void) | ((code: number) => void)): this {
    return super.once(event, listener);
  }

  unref(): void {}

  async terminate(): Promise<number> {
    this.finish(0);
    return 0;
  }

  crash(code = 1): void {
    this.finish(code);
  }

  injectLate(value: unknown): void {
    this.emit("message", structuredClone(value));
  }

  holdWorkerMessageDelivery(): void {
    this.workerMessageDeliveryHeld = true;
  }

  releaseWorkerMessageDelivery(): void {
    this.workerMessageDeliveryHeld = false;
    for (const value of this.heldWorkerMessages.splice(0)) this.queueWorkerMessage(value);
  }

  deliver(value: unknown): void {
    const cloned = structuredClone(value);
    this.workerMessages.push(cloned);
    if (this.workerMessageDeliveryHeld) {
      this.heldWorkerMessages.push(cloned);
      return;
    }
    this.queueWorkerMessage(cloned);
  }

  private queueWorkerMessage(value: unknown): void {
    queueMicrotask(() => {
      if (!this.ended) this.emit("message", value);
    });
  }

  private finish(code: number): void {
    if (this.ended) return;
    this.ended = true;
    this.port?.close();
    queueMicrotask(() => this.emit("exit", code));
  }
}

class LinkedWorkerPort extends EventEmitter implements ResidentWorkerPort {
  private closed = false;

  constructor(private readonly worker: LinkedWorker) {
    super();
  }

  postMessage(value: unknown): void {
    if (this.closed) throw new Error("Linked worker port is closed");
    this.worker.deliver(value);
  }

  on(event: "message", listener: (value: unknown) => void): this {
    return super.on(event, listener);
  }

  deliver(value: unknown): void {
    const cloned = structuredClone(value);
    queueMicrotask(() => {
      if (!this.closed) this.emit("message", cloned);
    });
  }

  close(): void {
    this.closed = true;
  }
}

function linkedWorkerHarness(
  runtime: ResidentWorkerRuntimeModule,
  loadRuntimeModule: (moduleUrl: string) => Promise<ResidentWorkerRuntimeModule> = async () => runtime,
): {
  readonly workerFactory: ResidentWorkerFactory;
  readonly worker: () => LinkedWorker;
} {
  let currentWorker: LinkedWorker | undefined;
  const workerFactory: ResidentWorkerFactory = (bootstrap: ResidentWorkerBootstrap) => {
    const worker = new LinkedWorker();
    const port = new LinkedWorkerPort(worker);
    worker.bind(port);
    currentWorker = worker;
    const server = new ResidentRuntimeWorkerServer({
      bootstrap,
      port,
      loadRuntimeModule,
    });
    queueMicrotask(() => void server.start());
    return worker;
  };
  return {
    workerFactory,
    worker: () => {
      if (!currentWorker) throw new Error("Linked worker has not been constructed");
      return currentWorker;
    },
  };
}

function verifiedHandle(): VerifiedInstalledRuntimeHandle {
  return {
    moduleUrl: pathToFileURL(join(process.cwd(), "runtime-fixture", "dist", "index.js")).href,
  } as VerifiedInstalledRuntimeHandle;
}

async function loadProxy(runtime: ResidentWorkerRuntimeModule): Promise<{
  readonly loader: ReturnType<typeof createPrimeAgentResidentWorkerModuleLoader>;
  readonly module: ProxyModule;
  readonly harness: ReturnType<typeof linkedWorkerHarness>;
}> {
  const harness = linkedWorkerHarness(runtime);
  const loader = createPrimeAgentResidentWorkerModuleLoader(verifiedHandle(), {
    workerFactory: harness.workerFactory,
    readyTimeoutMs: 1_000,
  });
  const module = await loader() as ProxyModule;
  return { loader, module, harness };
}

async function attach(
  module: ProxyModule,
  recoverDaemon: () => Promise<void> = async () => undefined,
  ownedSession = false,
): Promise<{
  readonly client: PrimeDaemonClientPublic;
  readonly connection: PrimeDaemonAgentConnectionPublic & { promoteToResident(): Promise<void> };
}> {
  const client = new module.DaemonClient("resident-test-socket");
  await client.connect(1_000);
  const connection = await module.DaemonAgentConnection.attach(client, "active-session", {
    closeClientOnDispose: true,
    sendClientEnv: false,
    supportsExtensionUi: false,
    ownedSession,
    telemetryDisabled: true,
    recoverDaemon,
  });
  return { client, connection };
}

describe("Prime Agent resident Worker proxy", () => {
  it("caches an asynchronous Worker import failure for every loader observer", async () => {
    const fixture = runtimeFixture();
    const moduleImport = deferred<ResidentWorkerRuntimeModule>();
    const loadRuntimeModule = vi.fn(() => moduleImport.promise);
    const harness = linkedWorkerHarness(fixture.runtime, loadRuntimeModule);
    const loader = createPrimeAgentResidentWorkerModuleLoader(verifiedHandle(), {
      workerFactory: harness.workerFactory,
      readyTimeoutMs: 1_000,
    });

    const firstLoad = loader();
    const concurrentLoad = loader();
    expect(concurrentLoad).toBe(firstLoad);
    await vi.waitFor(() => expect(loadRuntimeModule).toHaveBeenCalledOnce());

    moduleImport.reject(new Error("verified runtime module import failed"));
    const outcomes = await Promise.allSettled([firstLoad, concurrentLoad]);
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({
          name: "ResidentWorkerTransportError",
          code: "RESIDENT_WORKER_FATAL",
        });
      }
    }
    expect(loadRuntimeModule).toHaveBeenCalledOnce();

    await loader.close();
  });

  it("forwards exact attach options and awaits the host recoverDaemon callback", async () => {
    const fixture = runtimeFixture({ recoverDuringAttach: true });
    const { loader, module, harness } = await loadProxy(fixture.runtime);
    const recovery = vi.fn(async () => undefined);

    const { connection } = await attach(module, recovery, true);

    expect(recovery).toHaveBeenCalledOnce();
    expect(fixture.state.recoveries).toEqual(["active-session"]);
    expect(fixture.state.attachCalls).toHaveLength(1);
    expect(fixture.state.attachCalls[0]).toMatchObject({
      activeSessionId: "active-session",
      options: {
        closeClientOnDispose: true,
        sendClientEnv: false,
        supportsExtensionUi: false,
        ownedSession: true,
        telemetryDisabled: true,
      },
    });
    await connection.promoteToResident();
    expect(fixture.state.connection.promotionCalls).toBe(1);

    await connection.dispose();
    await loader.close();
  });

  it("delivers an upstream event before the waitForIdle response that follows it", async () => {
    const order: string[] = [];
    const fixture = runtimeFixture({
      waitForIdle: async (connection) => {
        connection.emit(Object.freeze({ type: "session", sequence: 7 }));
      },
    });
    const { loader, module } = await loadProxy(fixture.runtime);
    const { connection } = await attach(module);
    connection.subscribe(() => {
      order.push("event");
    });

    await connection.waitForIdle?.();
    order.push("wait-response");

    expect(order).toEqual(["event", "wait-response"]);
    await connection.dispose();
    await loader.close();
  });

  it("reads the exact attached session resource snapshot without classifying it as a mutation", async () => {
    const resourceSnapshot = Object.freeze({
      contextFiles: [],
      skills: [{ name: "playwright-cli", filePath: "/private/skill/SKILL.md" }],
      prompts: [],
      extensions: [],
      themes: [],
      diagnostics: { skills: [], prompts: [], extensions: [], themes: [] },
    });
    const resources = vi.fn(async () => resourceSnapshot);
    const fixture = runtimeFixture({ resources });
    const { loader, module, harness } = await loadProxy(fixture.runtime);
    const { connection } = await attach(module);

    await expect(connection.getResourceSnapshot()).resolves.toEqual(resourceSnapshot);
    expect(resources).toHaveBeenCalledOnce();
    expect(harness.worker().hostMessages).toContainEqual(expect.objectContaining({
      type: "request",
      operation: "connection.get_resource_snapshot",
      payload: expect.objectContaining({ connectionId: "connection:1" }),
    }));

    await connection.dispose();
    await loader.close();
  });

  it("cancels an in-flight prompt through the Worker signal and preserves exact status", async () => {
    const fixture = runtimeFixture({
      prompt: async (_message, options) => new Promise<void>((_resolve, reject) => {
        const cancel = () => reject(Object.assign(new Error("cancelled before ownership"), { status: "cancelled" }));
        if (options.signal?.aborted) cancel();
        else options.signal?.addEventListener("abort", cancel, { once: true });
      }),
    });
    const { loader, module } = await loadProxy(fixture.runtime);
    const { connection } = await attach(module);
    const controller = new AbortController();

    const admission = connection.prompt?.("bounded prompt", { queueIfBusy: false, signal: controller.signal });
    controller.abort();

    await expect(admission).rejects.toMatchObject({
      name: "Error",
      status: "cancelled",
      outcome: "definitive",
    } satisfies Partial<ResidentWorkerRemoteError>);
    await connection.dispose();
    await loader.close();
  });

  it("distinguishes pre-invocation validation from uncertain post-invocation mutation failure", async () => {
    const invoked = vi.fn();
    const fixture = runtimeFixture({
      setModel: async () => {
        invoked();
        throw new Error("upstream selection failed after invocation");
      },
    });
    const { loader, module } = await loadProxy(fixture.runtime);
    const { connection } = await attach(module);

    await expect(connection.setModel?.("provider", "model")).rejects.toMatchObject({ outcome: "unknown" });
    await expect(connection.setModel?.("", "model")).rejects.toMatchObject({
      code: "RESIDENT_WORKER_INPUT_INVALID",
      outcome: "definitive",
      operation: "connection.set_model",
    });
    expect(invoked).toHaveBeenCalledOnce();

    await connection.dispose();
    await loader.close();
  });

  it("never treats admission-like status text as definitive after generic root-kill invocation", async () => {
    const fixture = runtimeFixture();
    const { loader, module } = await loadProxy(fixture.runtime);
    const client = new module.DaemonClient("resident-test-socket");
    await client.connect(1_000);
    fixture.state.clients[0]!.request = async () => {
      throw Object.assign(new Error("kill reported unsupported after invocation"), {
        status: "unsupported",
      });
    };

    await expect(client.request({ type: "kill", activeSessionId: "active-session" }, 1_000))
      .rejects.toMatchObject({
        status: "unsupported",
        outcome: "unknown",
      } satisfies Partial<ResidentWorkerRemoteError>);

    client.close();
    await loader.close();
  });

  it("fences a crashed mutation as unknown and ignores a late response without replay", async () => {
    const invoked = vi.fn();
    const fixture = runtimeFixture({
      setModel: async () => {
        invoked();
        return new Promise<never>(() => undefined);
      },
    });
    const { loader, module, harness } = await loadProxy(fixture.runtime);
    const { connection } = await attach(module);
    const mutation = connection.setModel?.("provider", "model");
    await vi.waitFor(() => expect(invoked).toHaveBeenCalledOnce());
    const worker = harness.worker();
    const request = [...worker.hostMessages].reverse().find((value) => (
      typeof value === "object" && value !== null && (value as { type?: unknown }).type === "request" &&
      (value as { operation?: unknown }).operation === "connection.set_model"
    )) as Readonly<{ generation: string; requestId: string; operation: string }>;

    worker.crash(1);
    await expect(mutation).rejects.toMatchObject({
      name: "ResidentWorkerTransportError",
      outcome: "unknown",
      operation: "connection.set_model",
    } satisfies Partial<ResidentWorkerTransportError>);
    worker.injectLate({
      protocol: RESIDENT_WORKER_PROTOCOL,
      protocolVersion: RESIDENT_WORKER_PROTOCOL_VERSION,
      generation: request.generation,
      type: "response",
      requestId: request.requestId,
      operation: request.operation,
      ok: true,
      result: null,
    });
    await expect(connection.setModel?.("provider", "model-2")).rejects.toThrow("not live");
    expect(invoked).toHaveBeenCalledOnce();

    await loader.close();
  });

  it("preflights cyclic snapshots inside the Worker before structured-clone transport", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const fixture = runtimeFixture({ snapshot: async () => cyclic });
    const { loader, module } = await loadProxy(fixture.runtime);
    const { connection } = await attach(module);

    await expect(connection.getInitialSnapshot()).rejects.toBeInstanceOf(ResidentWorkerTransportError);

    await loader.close();
  });

  it("preflights model catalogs and session events inside the Worker", async () => {
    const cyclicCatalog: Record<string, unknown> = {};
    cyclicCatalog.self = cyclicCatalog;
    const catalogFixture = runtimeFixture({ models: async () => cyclicCatalog });
    const catalogProxy = await loadProxy(catalogFixture.runtime);
    const catalogConnection = await attach(catalogProxy.module);

    await expect(catalogConnection.connection.getAvailableModels?.()).rejects.toBeInstanceOf(
      ResidentWorkerTransportError,
    );
    await catalogProxy.loader.close();

    const cyclicEvent: Record<string, unknown> = {};
    cyclicEvent.self = cyclicEvent;
    const eventFixture = runtimeFixture({
      waitForIdle: async (connection) => connection.emit(cyclicEvent),
    });
    const eventProxy = await loadProxy(eventFixture.runtime);
    const eventConnection = await attach(eventProxy.module);
    eventConnection.connection.subscribe(() => undefined);

    await expect(eventConnection.connection.waitForIdle?.()).rejects.toBeInstanceOf(
      ResidentWorkerTransportError,
    );
    await eventProxy.loader.close();
  });

  it("preflights cyclic resource snapshots inside the Worker", async () => {
    const cyclicResources: Record<string, unknown> = {};
    cyclicResources.self = cyclicResources;
    const fixture = runtimeFixture({ resources: async () => cyclicResources });
    const { loader, module } = await loadProxy(fixture.runtime);
    const { connection } = await attach(module);

    await expect(connection.getResourceSnapshot()).rejects.toBeInstanceOf(ResidentWorkerTransportError);

    await loader.close();
  });

  it("normalizes and bounds upstream errors before posting them", async () => {
    const fixture = runtimeFixture({
      setModel: async () => {
        throw Object.assign(new Error("x".repeat(10_000)), {
          status: "owned",
          retryable: false,
          details: { phase: "y".repeat(2_000), ignored: { nested: true } },
        });
      },
    });
    const { loader, module } = await loadProxy(fixture.runtime);
    const { connection } = await attach(module);

    const error = await connection.setModel?.("provider", "model").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ResidentWorkerRemoteError);
    expect(error).toMatchObject({
      status: "owned",
      retryable: false,
      outcome: "unknown",
      details: { phase: "y".repeat(1_024) },
    });
    expect((error as Error).message).toHaveLength(4_096);
    expect((error as ResidentWorkerRemoteError).details).not.toHaveProperty("ignored");

    await connection.dispose();
    await loader.close();
  });

  it("classifies a crashed owned-session dispose as unknown and never replays it", async () => {
    const disposeInvoked = vi.fn();
    const fixture = runtimeFixture({
      dispose: async () => {
        disposeInvoked();
        return new Promise<never>(() => undefined);
      },
    });
    const { loader, module, harness } = await loadProxy(fixture.runtime);
    const { connection } = await attach(module, async () => undefined, true);

    const disposal = connection.dispose();
    await vi.waitFor(() => expect(disposeInvoked).toHaveBeenCalledOnce());
    harness.worker().crash(1);

    await expect(disposal).rejects.toMatchObject({
      name: "ResidentWorkerTransportError",
      outcome: "unknown",
      operation: "connection.dispose",
    } satisfies Partial<ResidentWorkerTransportError>);
    expect(disposeInvoked).toHaveBeenCalledOnce();
    await loader.close();
  });

  it("abandons transport without owned disposal while promotion is uncertain", async () => {
    const promotionBarrier = deferred<void>();
    const fixture = runtimeFixture({ promote: () => promotionBarrier.promise });
    const { loader, module } = await loadProxy(fixture.runtime);
    const { client, connection } = await attach(module, async () => undefined, true);
    const events: unknown[] = [];
    connection.subscribe((event) => {
      events.push(event);
    });

    const promotion = connection.promoteToResident();
    await vi.waitFor(() => expect(fixture.state.connection.promotionCalls).toBe(1));
    const disposal = connection.dispose();

    await expect(disposal).rejects.toMatchObject({
      code: "RESIDENT_WORKER_PROMOTION_UNCERTAIN",
      status: "unknown",
      outcome: "definitive",
    });
    await expect(promotion).rejects.toMatchObject({ outcome: "unknown" });
    expect(fixture.state.connection.disposeCalls).toBe(0);

    client.close();
    await vi.waitFor(() => expect(fixture.state.clients[0]?.closeCalls).toBe(1));
    fixture.state.connection.emit(Object.freeze({ type: "late-event" }));
    await Promise.resolve();
    expect(events).toEqual([]);

    promotionBarrier.resolve();
    await loader.close();
    expect(fixture.state.connection.disposeCalls).toBe(0);
  });

  it("rejects pending and late recoverDaemon calls after client abandonment", async () => {
    const recoveryBarrier = deferred<void>();
    const recovery = vi.fn(() => recoveryBarrier.promise);
    const fixture = runtimeFixture();
    const { loader, module, harness } = await loadProxy(fixture.runtime);
    const { client, connection } = await attach(module, recovery);

    const pendingRecovery = fixture.state.recoverDaemon();
    const pendingRecoveryFailure = pendingRecovery.catch((error: unknown) => error);
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce());
    client.close();
    await vi.waitFor(() => expect(fixture.state.clients[0]?.closeCalls).toBe(1));

    await expect(pendingRecoveryFailure).resolves.toMatchObject({ message: expect.stringContaining("closed") });
    await expect(fixture.state.recoverDaemon()).rejects.toThrow("connection is unavailable");
    await expect(connection.getInitialSnapshot()).rejects.toThrow("not live");
    const firstRecoveryRequest = harness.worker().workerMessages.find((value) => (
      typeof value === "object" && value !== null && (value as { type?: unknown }).type === "recovery_request"
    ));
    if (!firstRecoveryRequest || typeof firstRecoveryRequest !== "object") {
      throw new Error("Expected pending recovery request was not observed");
    }
    harness.worker().injectLate({
      ...firstRecoveryRequest,
      recoveryRequestId: "recovery:2",
    });
    expect(recovery).toHaveBeenCalledOnce();

    recoveryBarrier.resolve();
    await loader.close();
  });

  it("definitively rejects an already-posted recovery for a retired connection without harming a sibling", async () => {
    const firstRecovery = vi.fn(async () => undefined);
    const siblingRecovery = vi.fn(async () => undefined);
    const fixture = runtimeFixture();
    const { loader, module, harness } = await loadProxy(fixture.runtime);
    const first = await attach(module, firstRecovery);
    const recoverFirst = fixture.state.recoverDaemon;
    const sibling = await attach(module, siblingRecovery);
    const recoverSibling = fixture.state.recoverDaemon;
    const worker = harness.worker();

    worker.holdWorkerMessageDelivery();
    const lateRecovery = recoverFirst();
    const lateRecoveryFailure = lateRecovery.catch((error: unknown) => error);
    await vi.waitFor(() => expect(worker.workerMessages.some((value) => (
      typeof value === "object" && value !== null &&
      (value as { type?: unknown }).type === "recovery_request" &&
      (value as { recoveryRequestId?: unknown }).recoveryRequestId === "recovery:1"
    ))).toBe(true));

    first.client.close();
    await vi.waitFor(() => expect(fixture.state.clients[0]?.closeCalls).toBe(1));
    await expect(lateRecoveryFailure).resolves.toMatchObject({ message: expect.stringContaining("closed") });

    worker.releaseWorkerMessageDelivery();
    await vi.waitFor(() => expect(worker.hostMessages.some((value) => (
      typeof value === "object" && value !== null &&
      (value as { type?: unknown }).type === "recovery_response" &&
      (value as { recoveryRequestId?: unknown }).recoveryRequestId === "recovery:1" &&
      (value as { ok?: unknown }).ok === false &&
      (value as { error?: { code?: unknown } }).error?.code === "RESIDENT_WORKER_RECOVERY_AUTHORITY_RETIRED"
    ))).toBe(true));
    expect(firstRecovery).not.toHaveBeenCalled();
    expect(siblingRecovery).not.toHaveBeenCalled();

    await expect(sibling.connection.getInitialSnapshot()).resolves.toMatchObject({ session: { status: "idle" } });
    await expect(recoverSibling()).resolves.toBeUndefined();
    expect(siblingRecovery).toHaveBeenCalledOnce();

    await sibling.connection.dispose();
    await loader.close();
  });

  it("terminally rejects a replayed recovery request ID without re-invoking the host callback", async () => {
    const fixture = runtimeFixture({ recoverDuringAttach: true });
    const { loader, module, harness } = await loadProxy(fixture.runtime);
    const recovery = vi.fn(async () => undefined);
    const { connection } = await attach(module, recovery);
    const worker = harness.worker();
    const recoveryRequest = worker.workerMessages.find((value) => (
      typeof value === "object" && value !== null && (value as { type?: unknown }).type === "recovery_request"
    ));
    if (!recoveryRequest) throw new Error("Expected recovery request was not observed");

    worker.injectLate(recoveryRequest);

    await expect(connection.getInitialSnapshot()).rejects.toThrow("not live");
    expect(recovery).toHaveBeenCalledOnce();
    await loader.close();
  });

  it("performs bounded graceful shutdown and closes each live upstream resource once", async () => {
    const fixture = runtimeFixture();
    const { loader, module } = await loadProxy(fixture.runtime);
    await attach(module);

    await expect(loader.close()).resolves.toBeUndefined();
    expect(fixture.state.connection.disposeCalls).toBe(1);
    expect(fixture.state.clients[0]?.closeCalls).toBe(1);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
