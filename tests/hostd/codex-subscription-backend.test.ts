import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG,
  CODEX_APP_SERVER_INITIALIZE_IDENTITY,
  CODEX_APP_SERVER_THREAD_CONFIG,
  CODEX_APP_SERVER_THREAD_START_POLICY,
} from "../../scripts/prime-agent-runtime-lib.mjs";
import {
  CodexAppServerClientError,
  type CodexAppServerDeniedRequest,
  type CodexAppServerNotification,
} from "../../src/hostd/codex-app-server-client";
import {
  CodexSubscriptionBackend,
  type CodexSubscriptionAppServerClient,
  type CodexSubscriptionRuntimeProvider,
} from "../../src/hostd/codex-subscription-backend";
import {
  CODEX_HOME_CONTENT_POLICY,
  type CodexHomeSecurityProof,
  type CodexHomeSecurityProvider,
} from "../../src/hostd/codex-home-security";
import { getHostDataPaths } from "../../src/hostd/paths";
import { CodexSubscriptionStore } from "../../src/hostd/codex-subscription-store";
import type {
  VerifiedCodexAppServerLaunchDescriptor,
  VerifiedInstalledRuntimeHandle,
} from "../../src/hostd/runtime-integrity-manager";
import type {
  CodexSubscriptionConversationSnapshot,
  CodexSubscriptionTurnStartRequest,
} from "../../src/shared/protocol";
import { canonicalTemporaryDirectory } from "../helpers/canonical-temp";

const HOST_ID = "host-local";
const SOURCE_THREAD = "source-thread";
const GENERATION = "execution-generation";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Codex subscription backend", () => {
  it("verifies the private root before the durable store can read or write state", async () => {
    const root = await temporaryRoot();
    const paths = getHostDataPaths(root);
    const initializeStore = vi.fn(async () => []);
    const backend = new CodexSubscriptionBackend({
      paths,
      authorityStore: { resolveWorkspaceDirectory: async () => root },
      runtimeHandles: readyRuntime(),
      clientVersion: "0.1.0",
      platform: "win32",
      store: { initialize: initializeStore } as unknown as CodexSubscriptionStore,
      homeSecurity: {
        prepareAndVerify: async () => {
          throw new Error("weak existing private root");
        },
        assertStillSecure: async () => undefined,
      },
    });

    await backend.initialize(HOST_ID);
    expect(initializeStore).not.toHaveBeenCalled();
    await expect(backend.capabilityReady()).resolves.toBe(false);
  });

  it("correlates same-chunk and delayed canary lifecycle notifications before becoming ready", async () => {
    const fixture = await backendFixture({ signedIn: true, delayedCanaryDelete: true });
    await waitFor(() => fixture.backend.capabilityReady());
    await expect(fixture.backend.capabilityReady()).resolves.toBe(true);
    expect(fixture.client.canaryStarted).toBe(1);
    expect(fixture.client.canaryDeleted).toBe(1);
    const account = await fixture.backend.accountRead({ expectedHostId: HOST_ID });
    expect(account).toMatchObject({
      phase: "signed_in",
      accountType: "chatgpt",
      requiresOpenaiAuth: true,
      turnReadiness: { state: "ready" },
    });
  });

  it("keeps readiness polling nonblocking and single-flights background composition", async () => {
    const fixture = await backendFixture({ signedIn: true });
    let releaseInitialization!: () => void;
    let initializationReleased = false;
    fixture.client.initializeGate = new Promise<void>((resolvePromise) => {
      releaseInitialization = resolvePromise;
    });

    const observationsPromise = Promise.all(Array.from(
      { length: 32 },
      () => fixture.backend.capabilityReady(),
    ));
    let observations: boolean[] | undefined;
    void observationsPromise.then((result) => {
      observations = result;
    });

    try {
      await nextEventLoopTurn();
      expect(observations).toEqual(Array.from({ length: 32 }, () => false));
      await waitFor(() => fixture.clientFactory.mock.calls.length === 1);
      expect(fixture.client.initializeCalls).toBe(1);
      await expect(fixture.backend.capabilityReady()).resolves.toBe(false);
      expect(fixture.clientFactory).toHaveBeenCalledTimes(1);

      initializationReleased = true;
      releaseInitialization();
      await waitFor(() => fixture.backend.capabilityReady());
      await expect(fixture.backend.capabilityReady()).resolves.toBe(true);
      expect(fixture.clientFactory).toHaveBeenCalledTimes(1);
      expect(fixture.client.initializeCalls).toBe(1);
    } finally {
      if (!initializationReleased) releaseInitialization();
      await observationsPromise.catch(() => undefined);
    }
  });

  it("backs off failed background composition without leaking a rejection", async () => {
    const acquireVerifiedRuntimeHandle = vi.fn(async (): Promise<VerifiedInstalledRuntimeHandle> => {
      throw new Error("simulated runtime composition failure");
    });
    const runtimeHandles: CodexSubscriptionRuntimeProvider = {
      snapshot: () => ({ status: "ready" }),
      acquireVerifiedRuntimeHandle,
    };
    const fixture = await backendFixture({ signedIn: true, runtimeHandles });
    const unhandledRejections: unknown[] = [];
    const captureUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", captureUnhandledRejection);
    vi.useFakeTimers();

    try {
      await expect(fixture.backend.capabilityReady()).resolves.toBe(false);
      await flushMicrotasks();
      expect(acquireVerifiedRuntimeHandle).toHaveBeenCalledTimes(1);

      await expect(Promise.all(Array.from(
        { length: 32 },
        () => fixture.backend.capabilityReady(),
      ))).resolves.toEqual(Array.from({ length: 32 }, () => false));
      await flushMicrotasks();
      expect(acquireVerifiedRuntimeHandle).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(29_999);
      await expect(fixture.backend.capabilityReady()).resolves.toBe(false);
      await flushMicrotasks();
      expect(acquireVerifiedRuntimeHandle).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(fixture.backend.capabilityReady()).resolves.toBe(false);
      await flushMicrotasks();
      expect(acquireVerifiedRuntimeHandle).toHaveBeenCalledTimes(2);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", captureUnhandledRejection);
    }
  });

  it("reconciles cancel notFound against authoritative signed-in account state", async () => {
    const fixture = await backendFixture({ signedIn: false });
    await fixture.backend.capabilityReady();
    const started = await fixture.backend.loginStart({
      expectedHostId: HOST_ID,
      expectedBackendIncarnationId: fixture.backend.backendIncarnationId,
      operationId: "login-operation",
    });
    fixture.client.signInOnCancel = true;
    fixture.client.cancelStatus = "notFound";
    const settled = await fixture.backend.loginCancel({
      expectedHostId: HOST_ID,
      expectedBackendIncarnationId: fixture.backend.backendIncarnationId,
      loginOperationId: started.authorization.operationId,
      loginId: started.authorization.loginId,
    });
    expect(settled).toMatchObject({ phase: "signed_in", accountType: "chatgpt" });
    await expect(fixture.store.getOperation("login-operation")).resolves.toMatchObject({ phase: "completed" });

    fixture.client.emit({
      method: "account/login/completed",
      params: { loginId: started.authorization.loginId, success: true, error: null, onboardingEntrypoint: null },
    });
    await waitFor(async () => (await fixture.backend.accountRead({ expectedHostId: HOST_ID })).phase === "signed_in");
    await expect(fixture.store.getOperation("login-operation")).resolves.toMatchObject({ phase: "completed" });
  });

  it("bounds orphaned login custody with TTL cancel plus authoritative account reconciliation", async () => {
    const fixture = await backendFixture({ signedIn: false });
    await fixture.backend.capabilityReady();
    vi.useFakeTimers();
    await fixture.backend.loginStart({
      expectedHostId: HOST_ID,
      expectedBackendIncarnationId: fixture.backend.backendIncarnationId,
      operationId: "ttl-login-operation",
    });
    fixture.client.cancelStatus = "notFound";
    fixture.client.signInOnCancel = true;
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    const account = await fixture.backend.accountRead({ expectedHostId: HOST_ID });
    expect(fixture.client.cancelCalls).toBe(1);
    expect(account).toMatchObject({ phase: "signed_in", accountType: "chatgpt" });
    await expect(fixture.store.getOperation("ttl-login-operation")).resolves.toMatchObject({ phase: "completed" });
  });

  it("accepts a bounded read-command stream, retains only assistant text, and settles terminal proof", async () => {
    const fixture = await backendFixture({ signedIn: true, workspaceAgents: true });
    await fixture.backend.capabilityReady();
    const request = absentTurn(fixture.backend.backendIncarnationId, "Inspect the repository with rg.\nThen summarize it.");
    const running = await fixture.backend.turnStart(request);
    expect(running).toMatchObject({ state: "active", activeTurn: { state: "running" } });
    expect(fixture.client.lastThreadInstructionSources).toEqual([join(fixture.workspace, "AGENTS.md")]);

    const turnId = running.activeTurn!.turnId!;
    const threadId = running.threadId!;
    const commandStarted = commandItem(fixture.workspace, "inProgress");
    fixture.client.emit({ method: "turn/started", params: { threadId, turn: turn(turnId, "inProgress") } });
    fixture.client.emit({
      method: "item/started",
      params: { item: commandStarted, threadId, turnId, startedAtMs: 1_786_240_000_000 },
    });
    fixture.client.emit({
      method: "item/commandExecution/outputDelta",
      params: { threadId, turnId, itemId: commandStarted.id, delta: "AGENTS.md:1:# instructions\n" },
    });
    fixture.client.emit({
      method: "item/completed",
      params: {
        item: commandItem(fixture.workspace, "completed"),
        threadId,
        turnId,
        completedAtMs: 1_786_240_000_010,
      },
    });
    fixture.client.emit({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: "agent-item", delta: "The repository is bounded." },
    });
    fixture.client.emit({
      method: "item/completed",
      params: {
        item: { type: "agentMessage", id: "agent-item", text: "The repository is bounded." },
        threadId,
        turnId,
        completedAtMs: 1_786_240_000_020,
      },
    });
    fixture.client.emit({ method: "turn/completed", params: { threadId, turn: turn(turnId, "completed") } });

    const terminal = await waitForConversation(fixture.backend, "terminal");
    expect(terminal).toMatchObject({ latestTurn: { state: "completed", terminal: true } });
    expect(terminal.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", text: "The repository is bounded.", state: "completed" }),
    ]));
    expect(terminal.transcript.some((item) => item.text.includes("AGENTS.md:1"))).toBe(false);
    await expect(fixture.store.assertQuiescent()).resolves.toBeUndefined();
  });

  it("treats a correlated mid-turn provider error as advisory until failed terminal proof", async () => {
    const fixture = await backendFixture({ signedIn: true });
    await fixture.backend.capabilityReady();
    const running = await fixture.backend.turnStart(
      absentTurn(fixture.backend.backendIncarnationId, "Observe the terminal provider outcome."),
    );
    fixture.client.emit({
      method: "error",
      params: {
        error: {
          message: "Usage limit reached",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: null,
        },
        willRetry: false,
        threadId: running.threadId!,
        turnId: running.activeTurn!.turnId!,
      },
    });
    fixture.client.emit({
      method: "turn/completed",
      params: { threadId: running.threadId!, turn: turn(running.activeTurn!.turnId!, "failed") },
    });
    const failed = await waitForConversation(fixture.backend, "terminal");
    expect(failed).toMatchObject({ latestTurn: { state: "failed", terminal: true } });
    await expect(fixture.store.assertQuiescent()).resolves.toBeUndefined();
  });

  it("retires a lost pre-prompt thread response and never invokes turn/start", async () => {
    const fixture = await backendFixture({ signedIn: true, failRealThreadStart: true });
    await fixture.backend.capabilityReady();
    const request = absentTurn(fixture.backend.backendIncarnationId, "Never send this prompt.");
    await expect(fixture.backend.turnStart(request)).rejects.toBeDefined();
    expect(fixture.client.startTurnCalls).toBe(0);
    expect(fixture.client.closeCalls).toBe(1);
    const lookup = await fixture.backend.conversationSnapshot(binding());
    expect(lookup.conversation).toMatchObject({ state: "terminal", latestTurn: { state: "failed" } });
    await expect(fixture.store.assertQuiescent()).resolves.toBeUndefined();
  });

  it("rejects provider model or instruction-source drift before prompt dispatch", async () => {
    const fixture = await backendFixture({ signedIn: true });
    await fixture.backend.capabilityReady();
    fixture.client.wrongModel = true;
    await expect(fixture.backend.turnStart(
      absentTurn(fixture.backend.backendIncarnationId, "Do not dispatch under model drift."),
    )).rejects.toBeDefined();
    expect(fixture.client.startTurnCalls).toBe(0);
    expect(fixture.client.closeCalls).toBe(1);
    await expect(fixture.store.assertQuiescent()).resolves.toBeUndefined();
  });

  it("synchronously bounds a provider notification flood while turn/start is blocked", async () => {
    const fixture = await backendFixture({ signedIn: true });
    await fixture.backend.capabilityReady();
    let releaseTurn!: () => void;
    fixture.client.startTurnGate = new Promise<void>((resolvePromise) => {
      releaseTurn = resolvePromise;
    });
    const pending = fixture.backend.turnStart(
      absentTurn(fixture.backend.backendIncarnationId, "Hold the provider response."),
    );
    await waitFor(() => fixture.client.startTurnCalls === 1);
    for (let index = 0; index < 2_000; index += 1) {
      fixture.client.emit({ method: "account/updated", params: { index } });
    }
    const internals = fixture.backend as unknown as {
      notificationBuffer: unknown[];
      notificationBytes: number;
    };
    expect(internals.notificationBuffer.length).toBeLessThanOrEqual(256);
    expect(internals.notificationBytes).toBeLessThanOrEqual(512 * 1_024);
    releaseTurn();
    await expect(pending).rejects.toMatchObject({ code: "CODEX_PROTOCOL_VIOLATION" });
    await waitFor(() => fixture.client.closeCalls === 1);
    await expect(fixture.store.getConversation({
      hostId: HOST_ID,
      sourceThreadId: SOURCE_THREAD,
      executionGenerationId: GENERATION,
    }, fixture.backend.backendIncarnationId)).resolves.toMatchObject({ state: "uncertain" });
  });

  it("self-reconciles a restart-uncertain turn by secure resume without replay, then Stop waits for terminal proof", async () => {
    const first = await backendFixture({ signedIn: true });
    await first.backend.capabilityReady();
    const request = absentTurn(first.backend.backendIncarnationId, "One durable prompt only.");
    const running = await first.backend.turnStart(request);
    await first.backend.close().catch(() => undefined);

    const restartedStore = new CodexSubscriptionStore({ statePath: first.paths.codexSubscriptionState });
    const secondClient = new FakeClient(first.paths.codexHome, first.workspace, true);
    secondClient.threadReadResult = {
      thread: {
        id: running.threadId,
        turns: [{
          ...turn(running.activeTurn!.turnId!, "inProgress"),
          items: [{
            type: "userMessage",
            id: running.transcript[0]!.itemId,
            clientId: running.transcript[0]!.itemId,
          }],
        }],
      },
    };
    const second = await backendFixture({
      signedIn: true,
      root: first.root,
      store: restartedStore,
      client: secondClient,
      preserveFilesystem: true,
    });
    const lookup = await second.backend.conversationSnapshot(binding());
    expect(lookup.conversation).toMatchObject({ state: "active", activeTurn: { state: "running" } });
    expect(secondClient.resumeThreadCalls).toBe(1);
    expect(secondClient.startTurnCalls).toBe(0);

    const active = lookup.conversation!;
    const stopPromise = second.backend.turnInterrupt({
      ...binding(),
      expectedBackendIncarnationId: second.backend.backendIncarnationId,
      sessionId: active.sessionId,
      codexThreadId: active.threadId!,
      operationId: "stop-recovered-turn",
      expectedTurnOperationId: active.activeTurn!.operationId,
      turnId: active.activeTurn!.turnId!,
    });
    await waitFor(() => secondClient.interruptCalls === 1);
    secondClient.emit({
      method: "turn/completed",
      params: { threadId: active.threadId!, turn: turn(active.activeTurn!.turnId!, "interrupted") },
    });
    await expect(stopPromise).resolves.toMatchObject({ latestTurn: { state: "interrupted", terminal: true } });
    expect(secondClient.startTurnCalls).toBe(0);
    await expect(second.store.assertQuiescent()).resolves.toBeUndefined();
  });
});

interface FixtureOptions {
  signedIn: boolean;
  delayedCanaryDelete?: boolean;
  workspaceAgents?: boolean;
  failRealThreadStart?: boolean;
  root?: string;
  store?: CodexSubscriptionStore;
  client?: FakeClient;
  preserveFilesystem?: boolean;
  runtimeHandles?: CodexSubscriptionRuntimeProvider;
}

async function backendFixture(options: FixtureOptions) {
  const root = options.root ?? await temporaryRoot();
  if (options.root && !options.preserveFilesystem) temporaryDirectories.push(root);
  const paths = getHostDataPaths(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  if (options.workspaceAgents) await writeFile(join(workspace, "AGENTS.md"), "# bounded instructions\n");
  const store = options.store ?? new CodexSubscriptionStore({ statePath: paths.codexSubscriptionState });
  const client = options.client ?? new FakeClient(paths.codexHome, workspace, options.signedIn);
  client.delayedCanaryDelete = options.delayedCanaryDelete ?? false;
  client.failRealThreadStart = options.failRealThreadStart ?? false;
  const security = new FakeHomeSecurity(paths.root, paths.codexHome, paths.codexTemporary);
  const clientFactory = vi.fn(() => client);
  const backend = new CodexSubscriptionBackend({
    paths,
    authorityStore: { resolveWorkspaceDirectory: async () => workspace },
    runtimeHandles: options.runtimeHandles ?? readyRuntime(),
    clientVersion: "0.1.0",
    platform: "win32",
    store,
    homeSecurity: security,
    clientFactory,
    idFactory: sequentialIds("backend"),
  });
  await backend.initialize(HOST_ID);
  return { root, paths, workspace, store, client, clientFactory, backend };
}

class FakeHomeSecurity implements CodexHomeSecurityProvider {
  constructor(
    private readonly root: string,
    private readonly home: string,
    private readonly temporary: string,
  ) {}

  async prepareAndVerify(): Promise<CodexHomeSecurityProof> {
    await mkdir(this.home, { recursive: true });
    await mkdir(this.temporary, { recursive: true });
    return {
      canonicalHostDataRoot: this.root,
      canonicalHome: this.home,
      canonicalTemporaryDirectory: this.temporary,
      currentUserSid: "S-1-5-21-1-2-3-1001",
      homeState: "first_provisioning",
    };
  }

  async assertStillSecure(): Promise<void> {}
}

class FakeClient implements CodexSubscriptionAppServerClient {
  private readonly notificationListeners = new Set<(value: CodexAppServerNotification) => void>();
  private readonly deniedListeners = new Set<(value: CodexAppServerDeniedRequest) => void>();
  private readonly failureListeners = new Set<(value: CodexAppServerClientError) => void>();
  signedIn: boolean;
  signInOnCancel = false;
  cancelStatus: "canceled" | "notFound" = "canceled";
  cancelCalls = 0;
  delayedCanaryDelete = false;
  failRealThreadStart = false;
  wrongModel = false;
  threadReadResult: unknown = { thread: { id: "unused", turns: [] } };
  canaryStarted = 0;
  canaryDeleted = 0;
  startTurnCalls = 0;
  startTurnGate: Promise<void> | undefined;
  resumeThreadCalls = 0;
  interruptCalls = 0;
  closeCalls = 0;
  initializeCalls = 0;
  initializeGate: Promise<void> | undefined;
  lastThreadInstructionSources: string[] = [];
  private nextThread = 0;

  constructor(
    private readonly codexHome: string,
    private readonly workspace: string,
    signedIn: boolean,
  ) {
    this.signedIn = signedIn;
  }

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
    if (this.initializeGate) await this.initializeGate;
  }
  async readAccount(): Promise<unknown> {
    return this.signedIn
      ? { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true }
      : { account: null, requiresOpenaiAuth: true };
  }
  async startChatGptLogin(): Promise<unknown> {
    return { type: "chatgpt", loginId: "login-123", authUrl: loginUrl() };
  }
  async cancelLogin(): Promise<unknown> {
    this.cancelCalls += 1;
    if (this.signInOnCancel) this.signedIn = true;
    return { status: this.cancelStatus };
  }
  async logout(): Promise<unknown> { this.signedIn = false; return {}; }
  async readEffectiveConfig(): Promise<unknown> { return configReadFixture(this.codexHome); }
  async listMcpServers(): Promise<unknown> { return { data: [], nextCursor: null }; }
  async listHooks(cwd: string): Promise<unknown> {
    return { data: [{ cwd, hooks: [], warnings: [], errors: [] }] };
  }
  async listPlugins(): Promise<unknown> {
    return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] };
  }
  async listApps(): Promise<unknown> { return { data: [], nextCursor: null }; }
  async readWindowsSandboxReadiness(): Promise<unknown> { return { status: "ready" }; }
  async startThread(context: { cwd: string }): Promise<unknown> {
    const canary = context.cwd === this.codexHome;
    if (!canary && this.failRealThreadStart) {
      throw new CodexAppServerClientError("APP_SERVER_REQUEST_TIMEOUT", "lost thread response", true);
    }
    const threadId = canary ? "canary-thread" : `workspace-thread-${++this.nextThread}`;
    const sources = canary ? [] : await instructionSources(this.workspace);
    if (!canary) this.lastThreadInstructionSources = [...sources];
    this.emit({ method: "thread/started", params: { thread: { id: threadId } } });
    if (canary) this.canaryStarted += 1;
    const response = securityThread(threadId, context.cwd, sources);
    if (this.wrongModel && !canary) response.model = "unexpected-fallback";
    return response;
  }
  async resumeThread(threadId: string, context: { cwd: string }): Promise<unknown> {
    this.resumeThreadCalls += 1;
    const sources = await instructionSources(context.cwd);
    this.emit({ method: "thread/started", params: { thread: { id: threadId } } });
    return securityThread(threadId, context.cwd, sources);
  }
  async readThread(): Promise<unknown> { return this.threadReadResult; }
  async deleteThread(threadId: string): Promise<unknown> {
    const notify = () => {
      this.emit({ method: "thread/status/changed", params: { threadId, status: { type: "notLoaded" } } });
      this.emit({ method: "thread/deleted", params: { threadId } });
      this.canaryDeleted += 1;
    };
    if (this.delayedCanaryDelete) setTimeout(notify, 1);
    else notify();
    return {};
  }
  async startTurn(): Promise<unknown> {
    this.startTurnCalls += 1;
    if (this.startTurnGate) await this.startTurnGate;
    return { turn: turn(`provider-turn-${this.startTurnCalls}`, "inProgress") };
  }
  async interruptTurn(): Promise<unknown> { this.interruptCalls += 1; return {}; }
  subscribe(listener: (value: CodexAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }
  subscribeDeniedServerRequests(listener: (value: CodexAppServerDeniedRequest) => void): () => void {
    this.deniedListeners.add(listener);
    return () => this.deniedListeners.delete(listener);
  }
  subscribeFailures(listener: (value: CodexAppServerClientError) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }
  assertHealthy(): void {}
  async close(): Promise<void> { this.closeCalls += 1; }
  emit(value: CodexAppServerNotification): void {
    for (const listener of this.notificationListeners) listener(value);
  }
}

function readyRuntime() {
  const descriptor = {
    executable: "C:\\runtime\\codex-app-server.exe",
    companionDirectory: "C:\\runtime",
    fixedArguments: [],
    sessionConfig: CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG,
    threadConfig: CODEX_APP_SERVER_THREAD_CONFIG,
    initializeCapabilities: { experimentalApi: true },
    initializeIdentity: CODEX_APP_SERVER_INITIALIZE_IDENTITY,
    threadStartPolicy: CODEX_APP_SERVER_THREAD_START_POLICY,
    environmentPolicy: {},
    codexHomePolicy: CODEX_HOME_CONTENT_POLICY,
    releaseVersion: "0.147.0",
    target: "x86_64-pc-windows-msvc",
    assetSha256: "a".repeat(64),
  } as unknown as VerifiedCodexAppServerLaunchDescriptor;
  return {
    snapshot: () => ({ status: "ready" }),
    acquireVerifiedRuntimeHandle: async () => ({ codexAppServer: descriptor }) as VerifiedInstalledRuntimeHandle,
  };
}

function securityThread(threadId: string, cwd: string, sources: readonly string[]) {
  return {
    thread: {
      id: threadId,
      modelProvider: "openai",
      cwd,
      ephemeral: false,
      cliVersion: "0.147.0",
      canAcceptDirectInput: true,
      turns: [],
    },
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    serviceTier: null,
    cwd,
    runtimeWorkspaceRoots: [],
    instructionSources: [...sources],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    reasoningEffort: null,
    multiAgentMode: "explicitRequestOnly",
  };
}

function turn(id: string, status: "inProgress" | "completed" | "interrupted" | "failed") {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error: status === "failed" ? { message: "failed" } : null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1,
  };
}

function commandItem(cwd: string, status: "inProgress" | "completed") {
  return {
    type: "commandExecution",
    id: "read-command",
    pluginId: null,
    scriptPath: null,
    command: "rg -n AGENTS.md .",
    cwd,
    processId: "process-1",
    source: "agent",
    status,
    commandActions: [{ type: "unknown", command: "rg -n AGENTS.md ." }],
    aggregatedOutput: status === "inProgress" ? null : "AGENTS.md:1:# instructions\n",
    exitCode: status === "inProgress" ? null : 0,
    durationMs: status === "inProgress" ? null : 10,
  };
}

function configReadFixture(codexHome: string) {
  const sessionConfig = structuredClone(CODEX_APP_SERVER_EXPECTED_SESSION_CONFIG);
  const config = structuredClone(sessionConfig) as Record<string, unknown>;
  Object.assign(config, {
    mcp_servers: {}, plugins: {}, marketplaces: {}, hooks: null, apps: null, tools: null, agents: null,
  });
  (config.features as Record<string, unknown>).network_proxy = null;
  (config.features as Record<string, unknown>).remote_control = false;
  const version = `sha256:${"1".repeat(64)}`;
  const paths = flattenConfigPaths(sessionConfig);
  const origins = Object.fromEntries(paths.map((path) => [
    path === "features.multi_agent_v2" ? "features.multi_agent_v2.enabled" : path,
    { name: { type: "sessionFlags" }, version },
  ]));
  return {
    config,
    origins,
    layers: [
      { name: { type: "sessionFlags" }, version, config: sessionConfig },
      {
        name: { type: "user", file: join(codexHome, "config.toml"), profile: null },
        version: `sha256:${"2".repeat(64)}`,
        config: {},
      },
      {
        name: { type: "system", file: "C:\\ProgramData\\OpenAI\\Codex\\config.toml" },
        version: `sha256:${"3".repeat(64)}`,
        config: {},
      },
    ],
  };
}

function flattenConfigPaths(value: Record<string, unknown>, prefix = "", result: string[] = []): string[] {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "object" && child !== null && !Array.isArray(child)) {
      flattenConfigPaths(child as Record<string, unknown>, path, result);
    } else result.push(path);
  }
  return result;
}

async function instructionSources(cwd: string): Promise<string[]> {
  try {
    await stat(join(cwd, "AGENTS.override.md"));
    return [join(cwd, "AGENTS.override.md")];
  } catch {}
  try {
    await stat(join(cwd, "AGENTS.md"));
    return [join(cwd, "AGENTS.md")];
  } catch {
    return [];
  }
}

function absentTurn(backendIncarnationId: string, prompt: string): CodexSubscriptionTurnStartRequest {
  return {
    ...binding(),
    expectedBackendIncarnationId: backendIncarnationId,
    expectedConversation: { state: "absent" },
    operationId: "turn-operation",
    prompt,
  };
}

function binding() {
  return {
    expectedHostId: HOST_ID,
    threadId: SOURCE_THREAD,
    expectedExecutionGenerationId: GENERATION,
  };
}

function loginUrl(): string {
  const query = new URLSearchParams({
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    codex_cli_simplified_flow: "true",
    id_token_add_organizations: "true",
    originator: "prime_continuim",
    redirect_uri: "http://localhost:43123/auth/callback",
    response_type: "code",
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    state: "B".repeat(43),
  });
  return `https://auth.openai.com/oauth/authorize?${query.toString()}`;
}

async function waitForConversation(
  backend: CodexSubscriptionBackend,
  state: CodexSubscriptionConversationSnapshot["state"],
): Promise<CodexSubscriptionConversationSnapshot> {
  let latest: CodexSubscriptionConversationSnapshot | null = null;
  await waitFor(async () => {
    latest = (await backend.conversationSnapshot(binding())).conversation;
    return latest?.state === state;
  });
  return latest!;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Codex backend state");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

async function temporaryRoot(): Promise<string> {
  const root = await canonicalTemporaryDirectory("prime-codex-backend-");
  temporaryDirectories.push(root);
  return root;
}
