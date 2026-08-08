import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  PrimeAgentResidentAdapter,
  type PrimeDaemonAgentConnectionPublic,
  type PrimeDaemonClientPublic,
  type ResidentDaemonLauncher,
} from "../../src/hostd/prime-agent-resident-adapter";
import {
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  ResidentRuntimeContractError,
  buildResidentDaemonStartInvocation,
  validateResidentAbortIdleReconciliationRequest,
  validateResidentDaemonHello,
  validateResidentGenerationDispatchLease,
  validateResidentPromptIdleReconciliationRequest,
  type ResidentGenerationDispatchLease,
  type ResidentAbortIdleReconciliationRequest,
  type ResidentPromptIdleReconciliationRequest,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import type { ResidentProjectionSnapshot } from "../../src/hostd/resident-projection";
import { GatewayError } from "../../src/hostd/gateway";
import type { ResidentPromptReconciliationLease } from "../../src/hostd/store";
import { PROTOCOL_VERSION, type CommandEnvelope } from "../../src/shared/protocol";

const RUNTIME_NODE = resolve("test-runtime", "node.exe");
const RUNTIME_CLI = resolve("test-runtime", "prime-agent", "dist", "bundle", "cli.js");
const DAEMON_WORKING_DIRECTORY = resolve("test-runtime", "hostd-data");
const DAEMON_SOCKET = process.platform === "win32"
  ? "\\\\.\\pipe\\prime-continuim-test"
  : resolve(tmpdir(), "prime-continuim-test.sock");
const DAEMON_ENVIRONMENT = Object.freeze({
  Path: "C:\\Windows",
  ELECTRON_RUN_AS_NODE: "1",
  NODE_OPTIONS: "--import=C:\\attacker.mjs",
  PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
});

function buildHarnessInvocation() {
  return buildResidentDaemonStartInvocation({
    executable: RUNTIME_NODE,
    cliEntrypoint: RUNTIME_CLI,
    socketPath: DAEMON_SOCKET,
    daemonWorkingDirectory: DAEMON_WORKING_DIRECTORY,
    environment: DAEMON_ENVIRONMENT,
  });
}

function validHello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "daemon_hello",
    socketPath: DAEMON_SOCKET,
    protocol: { name: "prime-agent.daemon", version: 7 },
    schemaId: "protocol-7-schema-13-816309b1cd50",
    schemaRevision: 13,
    appVersion: "0.7.0",
    runtime: {
      buildId: "be9e2fa-dirty",
      executablePath: RUNTIME_NODE,
      entrypointPath: RUNTIME_CLI,
    },
    supervisorGeneration: "supervisor-1",
    clientId: "client-test",
    serverCapabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES],
    ...overrides,
  };
}

function liveSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "active-1",
    lifecycle: "live",
    activity: "idle",
    isSessionActive: true,
    activeSessionId: "active-1",
    sessionId: "session-1",
    sessionFile: "C:\\sessions\\session-1.jsonl",
    sessionName: "Prime Continuim",
    cwd: "C:\\work\\project",
    isStreaming: false,
    isCompacting: false,
    attachedClients: 0,
    messageCount: 3,
    unfinishedActionCount: 0,
    sessionActions: { queuedCount: 0, steering: [], followUps: [] },
    ...overrides,
  };
}

function validSnapshot(options: {
  state?: Record<string, unknown>;
  messages?: unknown[];
  cursorGeneration?: string;
  cursorSequence?: number;
} = {}): Record<string, unknown> {
  const messages = options.messages ?? [];
  const cursorGeneration = options.cursorGeneration ?? "events-1";
  const cursorSequence = options.cursorSequence ?? 4;
  return {
    state: {
      activeSessionId: "active-1",
      cwd: "C:\\work\\project",
      model: { provider: "openai", id: "gpt-5" },
      thinkingLevel: "medium",
      serviceTier: "standard",
      availableThinkingLevels: ["low", "medium", "high"],
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      steeringMode: "all",
      followUpMode: "all",
      sessionFile: "C:\\sessions\\session-1.jsonl",
      sessionId: "session-1",
      sessionName: "Prime Continuim",
      sessionDir: "C:\\sessions",
      leafId: null,
      autoCompactionEnabled: true,
      messageCount: messages.length,
      sessionActions: { queuedCount: 0, steering: [], followUps: [] },
      compactionCount: 0,
      goal: {
        active: false,
        status: "idle",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        continuationsUsed: 0,
      },
      scopedModels: [],
      activeToolNames: [],
      contextUsage: { tokens: 0, contextWindow: 200_000, percent: 0 },
      recap: "Resident session is ready.",
      ...options.state,
    },
    messages,
    children: [],
    lastEventSequence: cursorSequence,
    lastEventCursor: { generation: cursorGeneration, sequence: cursorSequence },
  };
}

interface HarnessState {
  connectOutcomes: Array<"ok" | "fail" | "timeout">;
  hello: unknown;
  chronology: string[];
  requests: Array<Readonly<object>>;
  closes: number;
  disposeCalls: number;
  eventListeners: Set<(event: unknown) => void | Promise<void>>;
  attachCalls: Array<{ activeSessionId: string; options: Readonly<Record<string, unknown>> }>;
  spawnCalls: Array<{ executable: string; argv: readonly string[]; options: unknown }>;
  launcherKills: number;
  launcherUnrefs: number;
  launcherExit?: readonly [number | null, string | null];
  persistCalls: ResidentSessionBinding[];
  completeCalls: ResidentSessionBinding[];
  projectionCalls: Array<{
    binding: ResidentSessionBinding;
    projection: ResidentProjectionSnapshot;
  }>;
  waitForIdleCalls: number;
  requestHandler?: (command: Readonly<object>) => Promise<unknown> | unknown;
  persistHandler?: (binding: ResidentSessionBinding) => Promise<void>;
  completeHandler?: (binding: ResidentSessionBinding) => Promise<void>;
  publishProjectionHandler?: (
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>;
  snapshotHandler?: () => Promise<unknown> | unknown;
  waitForIdleHandler?: () => Promise<void> | void;
  availableModelsCalls: number;
  setModelCalls: Array<{ providerId: string; modelId: string }>;
  promptCalls: Array<{
    message: string;
    options: Readonly<{ queueIfBusy?: boolean; signal?: AbortSignal }> | undefined;
  }>;
  abortCalls: number;
  availableModelsHandler?: () => Promise<unknown> | unknown;
  setModelHandler?: (providerId: string, modelId: string) => Promise<unknown> | unknown;
  promptHandler?: (
    message: string,
    options: Readonly<{ queueIfBusy?: boolean; signal?: AbortSignal }> | undefined,
  ) => Promise<void> | void;
  abortHandler?: () => Promise<void> | void;
  waitHandler?: (milliseconds: number) => Promise<void> | void;
  disposeHandler?: () => Promise<void>;
  recoverDuringAttach?: boolean;
}

function createHarness(overrides: Partial<HarnessState> = {}) {
  const state: HarnessState = {
    connectOutcomes: [],
    hello: validHello(),
    chronology: [],
    requests: [],
    closes: 0,
    disposeCalls: 0,
    eventListeners: new Set(),
    attachCalls: [],
    spawnCalls: [],
    launcherKills: 0,
    launcherUnrefs: 0,
    persistCalls: [],
    completeCalls: [],
    projectionCalls: [],
    waitForIdleCalls: 0,
    availableModelsCalls: 0,
    setModelCalls: [],
    promptCalls: [],
    abortCalls: 0,
    ...overrides,
  };

  class FakeDaemonClient implements PrimeDaemonClientPublic {
    constructor(readonly socketPath: string) {}

    get hello(): unknown {
      return state.hello;
    }

    async connect(): Promise<void> {
      state.chronology.push("connect");
      const outcome = state.connectOutcomes.shift() ?? "ok";
      if (outcome === "fail") throw new Error("connect ECONNREFUSED");
      if (outcome === "timeout") throw new Error("Timed out connecting to daemon endpoint");
    }

    async waitForHello(): Promise<unknown> {
      state.chronology.push("hello");
      return this.hello;
    }

    async request(command: Readonly<object>): Promise<unknown> {
      state.requests.push(command);
      const type = (command as { type?: string }).type ?? "unknown";
      state.chronology.push(`request:${type}`);
      if (state.requestHandler) return state.requestHandler(command);
      if (type === "create") return { type: "response", command: "create", success: true, data: liveSummary() };
      if (type === "list") {
        return { type: "response", command: "list", success: true, data: { sessions: [liveSummary()] } };
      }
      return { type: "response", command: type, success: true };
    }

    close(): void {
      state.closes += 1;
      state.chronology.push("client:close");
    }
  }

  class FakeDaemonAgentConnection {
    static async attach(
      _client: PrimeDaemonClientPublic,
      activeSessionId: string,
      options: Readonly<Record<string, unknown>>,
    ): Promise<PrimeDaemonAgentConnectionPublic> {
      state.attachCalls.push({ activeSessionId, options });
      state.chronology.push("attach");
      if (state.recoverDuringAttach) {
        await (options.recoverDaemon as () => Promise<void>)();
      }
      return {
        getInitialSnapshot: async () => {
          state.chronology.push("snapshot");
          return state.snapshotHandler
            ? state.snapshotHandler()
            : validSnapshot();
        },
        waitForIdle: async () => {
          state.waitForIdleCalls += 1;
          state.chronology.push("wait:idle");
          await state.waitForIdleHandler?.();
        },
        getAvailableModels: async () => {
          state.availableModelsCalls += 1;
          state.chronology.push("models:available");
          return state.availableModelsHandler
            ? state.availableModelsHandler()
            : [{ provider: "openai", id: "gpt-5", secretMetadata: "discarded" }];
        },
        setModel: async (providerId, modelId) => {
          state.setModelCalls.push({ providerId, modelId });
          state.chronology.push(`model:set:${providerId}/${modelId}`);
          return state.setModelHandler
            ? state.setModelHandler(providerId, modelId)
            : { provider: providerId, id: modelId, rawCredential: "discarded" };
        },
        prompt: async (message, options) => {
          state.promptCalls.push({ message, options });
          state.chronology.push("prompt");
          await state.promptHandler?.(message, options);
        },
        abort: async () => {
          state.abortCalls += 1;
          state.chronology.push("abort");
          await state.abortHandler?.();
        },
        subscribe: (listener) => {
          state.eventListeners.add(listener);
          return () => state.eventListeners.delete(listener);
        },
        dispose: async () => {
          state.disposeCalls += 1;
          state.chronology.push("dispose");
          await state.disposeHandler?.();
        },
      };
    }
  }

  const launcher: ResidentDaemonLauncher = {
    pid: 91,
    once: (event, listener) => {
      if (event === "exit" && state.launcherExit) {
        const [code, signal] = state.launcherExit;
        void Promise.resolve().then(() => listener(code, signal));
      }
      return undefined;
    },
    kill: () => {
      state.launcherKills += 1;
      return true;
    },
    unref: () => {
      state.launcherUnrefs += 1;
    },
  };

  const adapter = new PrimeAgentResidentAdapter({
    socketPath: DAEMON_SOCKET,
    executable: RUNTIME_NODE,
    cliEntrypoint: RUNTIME_CLI,
    daemonWorkingDirectory: DAEMON_WORKING_DIRECTORY,
    environment: DAEMON_ENVIRONMENT,
    loadRuntimeModule: async () => ({
      DaemonClient: FakeDaemonClient,
      DaemonAgentConnection: FakeDaemonAgentConnection,
    }),
    persistBinding: async (binding) => {
      state.persistCalls.push(binding);
      state.chronology.push("persist");
      await state.persistHandler?.(binding);
    },
    completeBinding: async (binding) => {
      state.completeCalls.push(binding);
      state.chronology.push("complete");
      await state.completeHandler?.(binding);
    },
    publishProjection: async (projectionBinding, projection) => {
      state.projectionCalls.push({ binding: projectionBinding, projection });
      state.chronology.push("projection:publish");
      await state.publishProjectionHandler?.(projectionBinding, projection);
    },
    spawnFactory: (executable, argv, options) => {
      state.spawnCalls.push({ executable, argv, options });
      state.chronology.push("spawn");
      return launcher;
    },
    connectTimeoutMs: 10,
    startupTimeoutMs: 100,
    requestTimeoutMs: 100,
    wait: async (milliseconds) => void (await state.waitHandler?.(milliseconds)),
    now: () => new Date("2026-08-06T17:00:00.000Z"),
  });

  const emit = async (event: unknown): Promise<void> => {
    await Promise.all([...state.eventListeners].map((listener) => listener(event)));
  };

  return { adapter, state, emit };
}

function createInput() {
  return {
    threadId: "thread-1",
    executionGenerationId: "generation-1",
    workspaceDirectory: "C:\\work\\project",
    sessionName: "Prime Continuim",
  } as const;
}

function binding(overrides: Partial<ResidentSessionBinding> = {}): ResidentSessionBinding {
  return {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId: "thread-1",
    executionGenerationId: "generation-1",
    workspaceDirectory: "C:\\work\\project",
    activeSessionId: "active-1",
    sessionId: "session-1",
    sessionFile: "C:\\sessions\\session-1.jsonl",
    boundAt: "2026-08-06T16:00:00.000Z",
    runtime: validateResidentDaemonHello(validHello()),
    ...overrides,
  };
}

function residentDispatchLease(
  operation: "prompt" | "abort",
  durableBinding: ResidentSessionBinding,
  dispatchAttemptId = `dispatch-${operation}-1`,
  commandFingerprint = "a".repeat(64),
): ResidentGenerationDispatchLease {
  return validateResidentGenerationDispatchLease({
    leaseVersion: 1,
    dispatchAttemptId,
    commandFingerprint,
    operation,
    binding: durableBinding,
  });
}

function promptIdleReconciliationRequest(
  durableBinding: ResidentSessionBinding,
  dispatchAttemptId = "dispatch-prompt-idle-1",
): ResidentPromptIdleReconciliationRequest {
  return validateResidentPromptIdleReconciliationRequest({
    reconciliationVersion: 1,
    dispatchAttemptId,
    binding: durableBinding,
  });
}

function abortIdleReconciliationRequest(
  durableBinding: ResidentSessionBinding,
  dispatchAttemptId = "dispatch-abort-idle-1",
): ResidentAbortIdleReconciliationRequest {
  return validateResidentAbortIdleReconciliationRequest({
    reconciliationVersion: 1,
    dispatchAttemptId,
    binding: durableBinding,
  });
}

function modelSelectionCommand(commandId = "select-model-1"): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "device-1",
    commandId,
    expectedHostId: "host-1",
    threadId: "thread-1",
    issuedAt: "2026-08-06T17:00:00.000Z",
    expectedExecutionGenerationId: "generation-1",
    command: { kind: "model.select", providerId: "openai", modelId: "gpt-5" },
  };
}

async function expectRuntimeError(promise: Promise<unknown>, code: string): Promise<ResidentRuntimeContractError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ResidentRuntimeContractError);
    expect(error).toMatchObject({ code });
    return error as ResidentRuntimeContractError;
  }
  throw new Error(`Expected ${code}`);
}

function promptAdmissionError(status: "cancelled" | "owned" | "unknown" | "unsupported"): Error {
  return Object.assign(new Error(`prompt admission ${status}`), { status });
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe("PrimeAgentResidentAdapter daemon ownership", () => {
  it("connects first and does not launch when the exact pinned daemon is already available", async () => {
    const { adapter, state } = createHarness();
    const invocation = buildHarnessInvocation();

    await expect(adapter.ensureDaemon(invocation)).resolves.toMatchObject({ appVersion: "0.7.0" });

    expect(state.spawnCalls).toHaveLength(0);
    expect(state.chronology).toEqual(["connect", "client:close"]);
    expect(adapter.getLifecycle().state).toBe("ready");
    await adapter.close();
  });

  it("launches the verified CLI through Node with a fixed shell-free argv and a single concurrent spawn", async () => {
    const { adapter, state } = createHarness({ connectOutcomes: ["fail", "fail", "ok", "ok"] });
    const invocation = buildHarnessInvocation();

    await Promise.all([adapter.ensureDaemon(invocation), adapter.ensureDaemon(invocation)]);

    expect(state.spawnCalls).toEqual([
      {
        executable: RUNTIME_NODE,
        argv: [
          RUNTIME_CLI,
          "--mode",
          "daemon",
          "--daemon-socket",
          DAEMON_SOCKET,
        ],
        options: {
          shell: false,
          windowsHide: true,
          detached: true,
          cwd: DAEMON_WORKING_DIRECTORY,
          env: { Path: "C:\\Windows", ELECTRON_RUN_AS_NODE: "1" },
          stdio: "ignore",
        },
      },
    ]);
    expect(state.launcherKills).toBe(0);
    expect(state.launcherUnrefs).toBe(1);
    await adapter.close();
  });

  it("fails closed on an incompatible live daemon without launching a replacement", async () => {
    const { adapter, state } = createHarness({ hello: validHello({ appVersion: "0.7.1" }) });
    const invocation = buildHarnessInvocation();

    await expectRuntimeError(adapter.ensureDaemon(invocation), "PRIME_RUNTIME_APP_VERSION_MISMATCH");

    expect(state.spawnCalls).toHaveLength(0);
    expect(adapter.getLifecycle().state).toBe("failed");
    await adapter.close();
  });

  it("does not launch over an indeterminate endpoint timeout", async () => {
    const { adapter, state } = createHarness({ connectOutcomes: ["timeout"] });
    const invocation = buildHarnessInvocation();

    await expectRuntimeError(adapter.ensureDaemon(invocation), "PRIME_RUNTIME_UNAVAILABLE");

    expect(state.spawnCalls).toHaveLength(0);
    await adapter.close();
  });

  it("accepts a valid external winner even when the local launcher exits nonzero", async () => {
    const { adapter, state } = createHarness({
      connectOutcomes: ["fail", "fail", "ok"],
      launcherExit: [1, null],
    });
    const invocation = buildHarnessInvocation();

    await expect(adapter.ensureDaemon(invocation)).resolves.toMatchObject({ appVersion: "0.7.0" });

    expect(state.spawnCalls).toHaveLength(1);
    expect(adapter.getLifecycle().state).toBe("ready");
    await adapter.close();
  });

  it("recovers during initial attach without re-entering the adapter operation queue", async () => {
    const { adapter, state } = createHarness({ recoverDuringAttach: true });

    const connection = await adapter.createResident(createInput());

    expect(connection.getLifecycle().state).toBe("ready");
    expect(state.spawnCalls).toHaveLength(0);
    expect(state.chronology.filter((entry) => entry === "connect")).toHaveLength(3);
    await connection.detach();
    await adapter.close();
  });
});

describe("PrimeAgentResidentAdapter session lifecycle", () => {
  it("persists a resident binding before attach and detach never kills or completes the worker", async () => {
    const { adapter, state } = createHarness();

    const connection = await adapter.createResident(createInput());

    expect(state.requests[0]).toEqual({
      type: "create",
      config: { cwd: "C:\\work\\project" },
      lifecycle: "resident",
      noSession: false,
      name: "Prime Continuim",
    });
    expect(state.chronology.indexOf("persist")).toBeLessThan(state.chronology.indexOf("attach"));
    expect(state.chronology.indexOf("attach")).toBeLessThan(state.chronology.indexOf("snapshot"));
    expect(state.chronology.indexOf("snapshot")).toBeLessThan(state.chronology.indexOf("projection:publish"));
    expect(state.projectionCalls).toHaveLength(1);
    expect(state.projectionCalls[0]).toMatchObject({
      binding: { activeSessionId: "active-1", sessionId: "session-1" },
      projection: {
        cursor: { generation: "events-1", sequence: 4 },
        identity: { activeSessionId: "active-1", sessionId: "session-1" },
        runtime: { runtime: "prime_agent", residency: "resident" },
      },
    });
    expect(state.attachCalls[0]).toMatchObject({
      activeSessionId: "active-1",
      options: {
        closeClientOnDispose: true,
        sendClientEnv: false,
        supportsExtensionUi: false,
        ownedSession: false,
      },
    });
    expect(state.persistCalls[0]).toMatchObject({
      lifecycle: "resident",
      threadId: "thread-1",
      executionGenerationId: "generation-1",
      activeSessionId: "active-1",
      sessionId: "session-1",
    });

    await Promise.all([connection.detach(), connection.detach()]);

    expect(state.disposeCalls).toBe(1);
    expect(state.requests.filter((request) => (request as { type?: string }).type === "kill")).toHaveLength(0);
    expect(connection.getLifecycle().state).toBe("closed");
    await adapter.close();
  });

  it("uses kill only for explicit end and rejects a racing detach", async () => {
    let releaseKill!: () => void;
    const killGate = new Promise<void>((resolve) => {
      releaseKill = resolve;
    });
    const { adapter, state } = createHarness({
      requestHandler: async (command) => {
        const type = (command as { type?: string }).type;
        if (type === "create") {
          return { type: "response", command: "create", success: true, data: liveSummary() };
        }
        if (type === "kill") {
          await killGate;
          return { type: "response", command: "kill", success: true };
        }
        return { type: "response", command: type ?? "unknown", success: true };
      },
    });
    const connection = await adapter.createResident(createInput());

    const end = connection.endSession();
    await vi.waitFor(() => expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(true));
    await expectRuntimeError(connection.detach(), "PRIME_RUNTIME_TERMINAL_ACTION_CONFLICT");
    releaseKill();
    await end;

    expect(state.requests.filter((request) => (request as { type?: string }).type === "kill")).toHaveLength(1);
    expect(state.disposeCalls).toBe(1);
    expect(state.completeCalls).toHaveLength(1);
    expect(state.chronology.indexOf("request:kill")).toBeLessThan(state.chronology.indexOf("dispose"));
    expect(state.chronology.indexOf("dispose")).toBeLessThan(state.chronology.indexOf("complete"));
    await adapter.close();
  });

  it("kills a newly created worker when durable binding persistence fails", async () => {
    const { adapter, state } = createHarness({
      persistHandler: async () => {
        throw new Error("disk unavailable");
      },
    });

    const error = await expectRuntimeError(
      adapter.createResident(createInput()),
      "PRIME_RUNTIME_BINDING_PERSIST_FAILED",
    );

    expect(error.details).toMatchObject({ cleanupSucceeded: true });
    expect(state.attachCalls).toHaveLength(0);
    expect(state.requests.map((request) => (request as { type?: string }).type)).toEqual(["create", "kill"]);
    await adapter.close();
  });

  it("fails attach readiness and disposes the client when authoritative publication fails", async () => {
    const { adapter, state } = createHarness({
      publishProjectionHandler: async () => {
        throw new Error("snapshot storage unavailable");
      },
    });

    const error = await expectRuntimeError(
      adapter.createResident(createInput()),
      "PRIME_RUNTIME_PROJECTION_PERSIST_FAILED",
    );

    expect(error.retryable).toBe(true);
    expect(state.persistCalls).toHaveLength(1);
    expect(state.projectionCalls).toHaveLength(1);
    expect(state.disposeCalls).toBe(1);
    expect(state.requests.map((request) => (request as { type?: string }).type)).toEqual(["create"]);
    expect(state.chronology.indexOf("snapshot")).toBeLessThan(state.chronology.indexOf("projection:publish"));
    expect(state.chronology.indexOf("projection:publish")).toBeLessThan(state.chronology.indexOf("dispose"));
    await adapter.close();
  });

  it("marks a lost create response as outcome-unknown and never suggests a blind retry", async () => {
    const { adapter, state } = createHarness({
      requestHandler: async (command) => {
        if ((command as { type?: string }).type === "create") throw new Error("response transport closed");
        return { type: "response", command: "unknown", success: true };
      },
    });

    const error = await expectRuntimeError(
      adapter.createResident(createInput()),
      "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    );

    expect(error.retryable).toBe(false);
    expect(error.details).toMatchObject({ command: "create", outcome: "unknown" });
    expect(state.requests).toHaveLength(1);
    expect(state.persistCalls).toHaveLength(0);
    expect(state.attachCalls).toHaveLength(0);
    await adapter.close();
  });

  it("verifies a durable binding against the live list before attach", async () => {
    const { adapter, state } = createHarness();

    const connection = await adapter.attachResident(binding());

    expect(state.requests).toEqual([{ type: "list" }]);
    expect(state.persistCalls).toHaveLength(1);
    expect(connection.binding.runtime.supervisorGeneration).toBe("supervisor-1");
    await connection.detach();
    await adapter.close();
  });

  it("rejects a reused active id whose durable session identity changed", async () => {
    const { adapter, state } = createHarness({
      requestHandler: async (command) => {
        const type = (command as { type?: string }).type ?? "unknown";
        if (type === "list") {
          return {
            type: "response",
            command: "list",
            success: true,
            data: { sessions: [liveSummary({ sessionId: "different-session" })] },
          };
        }
        return { type: "response", command: type, success: true };
      },
    });

    await expectRuntimeError(adapter.attachResident(binding()), "PRIME_RUNTIME_SESSION_MISMATCH");

    expect(state.attachCalls).toHaveLength(0);
    expect(state.persistCalls).toHaveLength(0);
    await adapter.close();
  });

  it("re-proves session identity from the attached snapshot instead of trusting the list precheck", async () => {
    const { adapter, state } = createHarness({
      snapshotHandler: async () => validSnapshot({
        state: { sessionId: "reused-session-id" },
        cursorSequence: 8,
      }),
    });

    const error = await expectRuntimeError(adapter.attachResident(binding()), "PRIME_RUNTIME_RESPONSE_INVALID");

    expect(error.details).toEqual({ projectionCode: "PRIME_PROJECTION_IDENTITY_MISMATCH" });
    expect(state.attachCalls).toHaveLength(1);
    expect(state.disposeCalls).toBe(1);
    await adapter.close();
  });

  it("rejects a matching session identity when the durable workspace does not match", async () => {
    const { adapter, state } = createHarness({
      requestHandler: async (command) => {
        const type = (command as { type?: string }).type ?? "unknown";
        if (type === "list") {
          return {
            type: "response",
            command: "list",
            success: true,
            data: { sessions: [liveSummary({ cwd: "C:\\other\\project" })] },
          };
        }
        return { type: "response", command: type, success: true };
      },
    });

    await expectRuntimeError(adapter.attachResident(binding()), "PRIME_RUNTIME_SESSION_MISMATCH");

    expect(state.attachCalls).toHaveLength(0);
    await adapter.close();
  });

  it("revalidates the exact hello and snapshot before declaring a reconnect ready", async () => {
    const { adapter, state, emit } = createHarness();
    const connection = await adapter.createResident(createInput());

    await emit({ type: "connection_status", status: "reconnecting" });
    expect(connection.getLifecycle().state).toBe("reconnecting");
    state.hello = validHello({ supervisorGeneration: "supervisor-2" });
    await emit({
      type: "session_resynced",
      snapshot: validSnapshot({ cursorGeneration: "events-2", cursorSequence: 5 }),
    });
    await emit({ type: "connection_status", status: "connected" });

    expect(connection.getLifecycle().state).toBe("ready");
    expect(connection.binding.runtime.supervisorGeneration).toBe("supervisor-2");
    expect(state.persistCalls.at(-1)?.runtime.supervisorGeneration).toBe("supervisor-2");
    expect(state.projectionCalls).toHaveLength(2);
    expect(state.projectionCalls.at(-1)?.projection.cursor).toEqual({ generation: "events-2", sequence: 5 });
    await connection.detach();
    await adapter.close();
  });

  it("fails and releases a connection whose reconnected daemon drifts from the exact pin", async () => {
    const { adapter, state, emit } = createHarness();
    const connection = await adapter.createResident(createInput());

    await emit({ type: "connection_status", status: "reconnecting" });
    state.hello = validHello({ schemaRevision: 14 });
    await emit({ type: "session_resynced", snapshot: {} });

    expect(connection.getLifecycle()).toMatchObject({
      state: "failed",
      error: { code: "PRIME_RUNTIME_SCHEMA_REVISION_MISMATCH" },
    });
    expect(state.eventListeners.size).toBe(0);
    await adapter.close();
  });

  it("rolls back a lifecycle observer that throws during initial delivery", async () => {
    const { adapter } = createHarness();
    const connection = await adapter.createResident(createInput());

    expect(() =>
      connection.subscribeLifecycle(() => {
        throw new Error("observer failed");
      }),
    ).toThrow("observer failed");
    await expect(connection.detach()).resolves.toBeUndefined();
    await adapter.close();
  });

  it("retries only durable completion after a confirmed kill", async () => {
    let failCompletion = true;
    const { adapter, state } = createHarness({
      completeHandler: async () => {
        if (failCompletion) throw new Error("binding store unavailable");
      },
    });
    const connection = await adapter.createResident(createInput());

    await expectRuntimeError(connection.endSession(), "PRIME_RUNTIME_BINDING_PERSIST_FAILED");
    failCompletion = false;
    await connection.endSession();

    expect(state.requests.filter((request) => (request as { type?: string }).type === "kill")).toHaveLength(1);
    expect(state.disposeCalls).toBe(1);
    expect(state.completeCalls).toHaveLength(2);
    await adapter.close();
  });

  it("detaches every live client on adapter close without shutting down the daemon", async () => {
    const { adapter, state } = createHarness();
    await adapter.createResident(createInput());

    await Promise.all([adapter.close(), adapter.close()]);

    expect(state.disposeCalls).toBe(1);
    expect(state.requests.map((request) => (request as { type?: string }).type)).toEqual(["create"]);
    expect(adapter.getLifecycle().state).toBe("closed");
  });
});

describe("PrimeAgentResidentAdapter generation-bound resident dispatch", () => {
  it("validates and canonicalizes the generation-bound command fingerprint", () => {
    expect(() => residentDispatchLease("prompt", binding(), "dispatch-bad-fingerprint", "not-a-digest"))
      .toThrow(expect.objectContaining({ code: "PRIME_RUNTIME_DISPATCH_LEASE_INVALID" }));
    expect(
      residentDispatchLease("prompt", binding(), "dispatch-uppercase-fingerprint", "A".repeat(64))
        .commandFingerprint,
    ).toBe("a".repeat(64));
  });

  it("rejects a structural prompt-idle lease before reaching the managed connection", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.createResident(createInput());
    const forged = {
      leaseVersion: 1,
      attemptId: "dispatch-forged-prompt-idle",
      command: {
        ...modelSelectionCommand("forged-prompt-idle"),
        command: { kind: "prompt", text: "Forged." },
      },
      binding: connection.binding,
      bindingFingerprint: "0".repeat(64),
      dispatchStartedAt: "2026-08-06T17:00:00.000Z",
      settledAt: "2026-08-06T17:00:00.000Z",
      receiptUpdatedAt: "2026-08-06T17:00:00.000Z",
      settlementCursor: {
        threadId: "thread-1",
        executionGenerationId: "generation-1",
        generation: "events-1",
        sequence: 4,
      },
    } as unknown as ResidentPromptReconciliationLease;

    await expect(adapter.reconcileAcknowledgedPromptIdle(forged)).rejects.toMatchObject({
      code: "RESIDENT_PROMPT_RECONCILIATION_LEASE_INVALID",
    });
    expect(state.waitForIdleCalls).toBe(0);
    await connection.detach();
    await adapter.close();
  });

  it("reports prompt ownership and abort request admission without claiming completion", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.createResident(createInput());

    await expect(
      connection.prompt(
        "Inspect the resident workspace.",
        residentDispatchLease("prompt", connection.binding),
      ),
    ).resolves.toEqual({ operation: "prompt", disposition: "accepted", completion: "not_observed" });
    await expect(
      connection.abort(residentDispatchLease("abort", connection.binding)),
    ).resolves.toEqual({ operation: "abort", disposition: "accepted", completion: "not_observed" });

    expect(state.promptCalls).toHaveLength(1);
    expect(state.promptCalls[0]).toMatchObject({
      message: "Inspect the resident workspace.",
      options: { queueIfBusy: false },
    });
    expect(state.promptCalls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
    expect(state.promptCalls[0]?.options?.signal?.aborted).toBe(false);
    expect(state.abortCalls).toBe(1);
    await connection.detach();
    await adapter.close();
  });

  it("never infers idle from an abort acknowledgement and deduplicates the explicit no-event barrier", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.createResident(createInput());
    const dispatch = residentDispatchLease("abort", connection.binding, "dispatch-abort-no-event");

    await expect(connection.abort(dispatch)).resolves.toEqual({
      operation: "abort",
      disposition: "accepted",
      completion: "not_observed",
    });
    expect(state.waitForIdleCalls).toBe(0);
    expect(state.projectionCalls).toHaveLength(1);

    const request = abortIdleReconciliationRequest(connection.binding, dispatch.dispatchAttemptId);
    const first = connection.reconcileAcknowledgedAbortIdle(request);
    const duplicate = connection.reconcileAcknowledgedAbortIdle(request);
    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({
      evidenceVersion: 1,
      dispatchAttemptId: dispatch.dispatchAttemptId,
      binding: connection.binding,
      projection: { cursor: { generation: "events-1", sequence: 4 } },
    });
    expect(state.waitForIdleCalls).toBe(1);
    // Abort proof publication is Store-owned because only its opaque lease may
    // authorize an active-to-idle rewrite at this unchanged upstream cursor.
    expect(state.projectionCalls).toHaveLength(1);

    await connection.detach();
    await adapter.close();
  });

  it("refuses Stop idle authority when the stable post-barrier projection remains active", async () => {
    const { adapter, state } = createHarness({
      snapshotHandler: () => validSnapshot({ state: { isStreaming: true } }),
    });
    const connection = await adapter.createResident(createInput());

    await expect(connection.reconcileAcknowledgedAbortIdle(
      abortIdleReconciliationRequest(connection.binding, "dispatch-abort-still-active"),
    )).rejects.toMatchObject({
      code: "PRIME_RUNTIME_ABORT_IDLE_NOT_OBSERVED",
      retryable: true,
    });
    expect(state.waitForIdleCalls).toBe(1);
    expect(state.projectionCalls).toHaveLength(1);

    await connection.detach();
    await adapter.close();
  });

  it("rejects Stop idle evidence when the exact binding changes during the barrier", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.createResident(createInput());
    const originalBinding = connection.binding;
    state.waitForIdleHandler = () => {
      state.hello = validHello({ supervisorGeneration: "supervisor-abort-reconciliation" });
      for (const listener of state.eventListeners) {
        void listener({ type: "connection_status", status: "reconnecting" });
        void listener({ type: "session_resynced", snapshot: validSnapshot() });
        void listener({ type: "connection_status", status: "connected" });
      }
    };

    await expect(connection.reconcileAcknowledgedAbortIdle(
      abortIdleReconciliationRequest(originalBinding, "dispatch-abort-binding-change"),
    )).rejects.toMatchObject({
      code: "PRIME_RUNTIME_ABORT_RECONCILIATION_AUTHORITY_CHANGED",
      retryable: false,
    });
    expect(state.waitForIdleCalls).toBe(1);

    await connection.detach();
    await adapter.close();
  });

  it("adapter close cancels a never-settling Stop idle barrier within the local shutdown bound", async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const { adapter, state } = createHarness({ waitForIdleHandler: () => neverSettles });
    const connection = await adapter.createResident(createInput());
    const reconciliation = connection.reconcileAcknowledgedAbortIdle(
      abortIdleReconciliationRequest(connection.binding, "dispatch-abort-adapter-close"),
    );
    await vi.waitFor(() => expect(state.waitForIdleCalls).toBe(1));

    const closed = adapter.close();
    await vi.waitFor(() => expect(state.disposeCalls).toBe(1), { timeout: 250 });
    await expect(reconciliation).rejects.toMatchObject({
      code: "PRIME_RUNTIME_ABORT_RECONCILIATION_AUTHORITY_CHANGED",
      retryable: false,
    });
    await expect(Promise.race([
      closed.then(() => "closed" as const),
      new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 250)),
    ])).resolves.toBe("closed");
    expect(state.projectionCalls).toHaveLength(1);
  });

  it("deduplicates one exact same-connection idle barrier and republishes its unchanged cursor", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.createResident(createInput());
    const request = promptIdleReconciliationRequest(connection.binding);

    const first = connection.reconcileAcknowledgedPromptIdle(request);
    const duplicate = connection.reconcileAcknowledgedPromptIdle(request);

    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({
      evidenceVersion: 1,
      dispatchAttemptId: request.dispatchAttemptId,
      binding: connection.binding,
      projection: { cursor: { generation: "events-1", sequence: 4 } },
    });
    expect(state.waitForIdleCalls).toBe(1);
    expect(state.projectionCalls).toHaveLength(2);
    expect(state.projectionCalls[0]?.projection.cursor).toEqual(
      state.projectionCalls[1]?.projection.cursor,
    );

    await connection.detach();
    await adapter.close();
  });

  it("refuses idle authority when a stable post-barrier projection still reports active work", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.createResident(createInput());
    state.snapshotHandler = () => validSnapshot({
      state: {
        isStreaming: true,
        sessionActions: {
          queuedCount: 1,
          steering: [],
          followUps: [],
          active: { kind: "turn", phase: "running" },
        },
      },
    });

    await expect(
      connection.reconcileAcknowledgedPromptIdle(
        promptIdleReconciliationRequest(connection.binding, "dispatch-prompt-still-active"),
      ),
    ).rejects.toMatchObject({
      code: "PRIME_RUNTIME_PROMPT_IDLE_NOT_OBSERVED",
      retryable: true,
    });
    expect(state.waitForIdleCalls).toBe(1);
    expect(state.projectionCalls).toHaveLength(1);

    await connection.detach();
    await adapter.close();
  });

  it("drains the upstream event tail and every scheduled projection refresh before idle evidence", async () => {
    const eventPublication = deferred();
    const refreshEntered = deferred();
    const refreshPublication = deferred();
    let gateEventPublication = false;
    const { adapter, state } = createHarness({
      publishProjectionHandler: async (_binding, projection) => {
        if (gateEventPublication && projection.runtime.recap === "Event tail publication") {
          await eventPublication.promise;
        }
      },
      waitHandler: async (milliseconds) => {
        if (milliseconds !== 100) return;
        refreshEntered.resolve();
        await refreshPublication.promise;
      },
    });
    const connection = await adapter.createResident(createInput());
    gateEventPublication = true;
    state.snapshotHandler = () => validSnapshot({ state: { recap: "Forced idle publication" } });
    state.waitForIdleHandler = () => {
      for (const listener of state.eventListeners) {
        void listener({
          type: "session_resynced",
          snapshot: validSnapshot({ state: { recap: "Event tail publication" } }),
        });
        void listener({ type: "session_event", event: { type: "agent_end" } });
      }
    };

    let reconciled = false;
    const result = connection
      .reconcileAcknowledgedPromptIdle(promptIdleReconciliationRequest(connection.binding))
      .then((evidence) => {
        reconciled = true;
        return evidence;
      });

    await vi.waitFor(() => expect(state.projectionCalls).toHaveLength(2));
    expect(reconciled).toBe(false);
    expect(state.chronology.indexOf("wait:idle")).toBeLessThan(
      state.chronology.lastIndexOf("projection:publish"),
    );

    eventPublication.resolve();
    await refreshEntered.promise;
    expect(reconciled).toBe(false);

    refreshPublication.resolve();
    await expect(result).resolves.toMatchObject({
      projection: {
        cursor: { generation: "events-1", sequence: 4 },
        runtime: { recap: "Forced idle publication" },
      },
    });
    expect(state.projectionCalls).toHaveLength(4);
    expect(state.projectionCalls.at(-1)?.projection.cursor).toEqual(
      state.projectionCalls.at(-2)?.projection.cursor,
    );

    await connection.detach();
    await adapter.close();
  });

  it("rejects idle evidence when the exact binding changes while the public barrier is pending", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.createResident(createInput());
    const originalBinding = connection.binding;
    state.waitForIdleHandler = () => {
      state.hello = validHello({ supervisorGeneration: "supervisor-idle-reconciliation" });
      for (const listener of state.eventListeners) {
        void listener({ type: "connection_status", status: "reconnecting" });
        void listener({ type: "session_resynced", snapshot: validSnapshot() });
        void listener({ type: "connection_status", status: "connected" });
      }
    };

    await expect(
      connection.reconcileAcknowledgedPromptIdle(
        promptIdleReconciliationRequest(originalBinding, "dispatch-prompt-binding-change"),
      ),
    ).rejects.toMatchObject({
      code: "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED",
      retryable: false,
    });
    expect(connection.binding.runtime.supervisorGeneration).toBe(
      "supervisor-idle-reconciliation",
    );
    expect(state.waitForIdleCalls).toBe(1);

    await connection.detach();
    await adapter.close();
  });

  it.each(["detach", "end"] as const)(
    "%s disposes a never-settling idle barrier and cannot publish terminally stale evidence",
    async (terminalAction) => {
    const neverSettles = new Promise<void>(() => undefined);
    const { adapter, state } = createHarness({ waitForIdleHandler: () => neverSettles });
    const connection = await adapter.createResident(createInput());
    const request = promptIdleReconciliationRequest(
      connection.binding,
      `dispatch-prompt-${terminalAction}-during-idle`,
    );
    const reconciliation = connection.reconcileAcknowledgedPromptIdle(request);
    await vi.waitFor(() => expect(state.waitForIdleCalls).toBe(1));

    const terminal = terminalAction === "detach"
      ? connection.detach()
      : connection.endSession();

    await expect(reconciliation).rejects.toMatchObject({
      code: "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED",
      retryable: false,
    });
    await expect(terminal).resolves.toBeUndefined();
    expect(state.disposeCalls).toBe(1);
    expect(state.projectionCalls).toHaveLength(1);
    expect(state.completeCalls).toHaveLength(terminalAction === "end" ? 1 : 0);
    await expect(connection.reconcileAcknowledgedPromptIdle(request)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED",
    });
    expect(state.waitForIdleCalls).toBe(1);
    await adapter.close();
    },
  );

  it("adapter close actively cancels a never-settling idle barrier within the local shutdown bound", async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const { adapter, state } = createHarness({ waitForIdleHandler: () => neverSettles });
    const connection = await adapter.createResident(createInput());
    const reconciliation = connection.reconcileAcknowledgedPromptIdle(
      promptIdleReconciliationRequest(connection.binding, "dispatch-prompt-adapter-close"),
    );
    await vi.waitFor(() => expect(state.waitForIdleCalls).toBe(1));

    const closed = adapter.close();
    await vi.waitFor(() => expect(state.disposeCalls).toBe(1), { timeout: 250 });
    await expect(reconciliation).rejects.toMatchObject({
      code: "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED",
    });
    const boundedClose = await Promise.race([
      closed.then(() => "closed" as const),
      new Promise<"timeout">((resolveTimeout) => {
        setTimeout(() => resolveTimeout("timeout"), 250);
      }),
    ]);
    expect(boundedClose).toBe("closed");
    expect(state.projectionCalls).toHaveLength(1);
    expect(adapter.getLifecycle().state).toBe("closed");
  });

  it("keeps one invocation for exact retries and rejects changed text, operation, or binding as COMMAND_ID_REUSED", async () => {
    const { adapter, state } = createHarness({
      promptHandler: async () => {
        throw new Error("response transport disconnected");
      },
    });
    const connection = await adapter.createResident(createInput());
    const lease = residentDispatchLease("prompt", connection.binding, "dispatch-reused-1");

    await expect(connection.prompt("same prompt", lease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
      retryable: false,
    });
    await expect(connection.prompt("same prompt", lease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    });
    await expect(connection.prompt("changed prompt", lease)).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
    await expect(
      connection.abort(residentDispatchLease("abort", connection.binding, "dispatch-reused-1")),
    ).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
    await expect(
      connection.prompt(
        "same prompt",
        residentDispatchLease(
          "prompt",
          binding({ executionGenerationId: "generation-changed" }),
          "dispatch-reused-1",
        ),
      ),
    ).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });

    expect(state.promptCalls).toHaveLength(1);
    expect(state.abortCalls).toBe(0);
    await connection.detach();
    await adapter.close();
  });

  it("continues beyond the exact-result window while retired IDs remain permanently non-invocable", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.createResident(createInput());
    const exactResultWindow = 10_000;
    const leaseFor = (index: number) => residentDispatchLease(
      "abort",
      connection.binding,
      `dispatch-retirement-${index}`,
      index.toString(16).padStart(64, "0"),
    );
    const oldestLease = leaseFor(0);

    await connection.abort(oldestLease);
    for (let index = 1; index <= exactResultWindow; index += 1) {
      await connection.abort(leaseFor(index));
    }
    expect(state.abortCalls).toBe(exactResultWindow + 1);

    await expect(connection.abort(oldestLease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_DISPATCH_RETIRED",
      retryable: false,
    });
    expect(state.abortCalls).toBe(exactResultWindow + 1);

    const finalAbort = deferred();
    state.abortHandler = () => finalAbort.promise;
    const inFlight = connection.abort(leaseFor(exactResultWindow + 1));
    await vi.waitFor(() => expect(state.abortCalls).toBe(exactResultWindow + 2));
    const detached = connection.detach();
    await Promise.resolve();
    expect(state.disposeCalls).toBe(0);

    finalAbort.resolve();
    await expect(inFlight).resolves.toMatchObject({ operation: "abort", disposition: "accepted" });
    await expect(detached).resolves.toBeUndefined();
    expect(state.disposeCalls).toBe(1);
    await adapter.close();
  }, 30_000);

  it("uses the prompt admission signal to recover an owned prompt after the local timeout", async () => {
    let signalWasLive = false;
    const { adapter, state } = createHarness({
      promptHandler: (_message, options) => new Promise<void>((resolvePrompt) => {
        const signal = options?.signal;
        signalWasLive = signal instanceof AbortSignal && !signal.aborted;
        signal?.addEventListener("abort", () => resolvePrompt(), { once: true });
      }),
    });
    const connection = await adapter.createResident(createInput());

    await expect(
      connection.prompt(
        "Own this prompt exactly once.",
        residentDispatchLease("prompt", connection.binding, "dispatch-owned-after-timeout"),
      ),
    ).resolves.toEqual({ operation: "prompt", disposition: "accepted", completion: "not_observed" });

    expect(signalWasLive).toBe(true);
    expect(state.promptCalls).toHaveLength(1);
    expect(state.promptCalls[0]?.options?.signal?.aborted).toBe(true);
    await connection.detach();
    await adapter.close();
  });

  it("cancels a same-tick prompt placeholder before either upstream mutation can run", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.createResident(createInput());

    const prompt = connection.prompt(
      "Never invoke this after Stop.",
      residentDispatchLease("prompt", connection.binding, "dispatch-same-tick-prompt"),
    );
    const abort = connection.abort(
      residentDispatchLease("abort", connection.binding, "dispatch-same-tick-abort"),
    );

    await expect(prompt).rejects.toMatchObject({
      code: "PRIME_RUNTIME_REQUEST_FAILED",
      details: { outcome: "not_accepted", status: "cancelled" },
    });
    await expect(abort).resolves.toEqual({
      operation: "abort",
      disposition: "not_needed",
      completion: "not_observed",
      reason: "prompt_admission_cancelled",
    });
    expect(state.promptCalls).toHaveLength(0);
    expect(state.abortCalls).toBe(0);
    await connection.detach();
    await adapter.close();
  });

  it("signals an invoked prompt immediately, then sends exactly one abort after ownership", async () => {
    const promptOwned = deferred();
    const { adapter, state } = createHarness({
      promptHandler: (_message, options) => {
        options?.signal?.addEventListener("abort", promptOwned.resolve, { once: true });
        return promptOwned.promise;
      },
    });
    const connection = await adapter.createResident(createInput());
    const prompt = connection.prompt(
      "Own before Stop is forwarded.",
      residentDispatchLease("prompt", connection.binding, "dispatch-signal-prompt"),
    );
    await vi.waitFor(() => expect(state.promptCalls).toHaveLength(1));

    const abort = connection.abort(
      residentDispatchLease("abort", connection.binding, "dispatch-signal-abort"),
    );
    expect(state.promptCalls[0]?.options?.signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(state.abortCalls).toBe(1), { timeout: 250 });

    await expect(prompt).resolves.toMatchObject({ operation: "prompt", disposition: "accepted" });
    await expect(abort).resolves.toMatchObject({ operation: "abort", disposition: "accepted" });
    expect(state.abortCalls).toBe(1);
    await connection.detach();
    await adapter.close();
  });

  it("does not invoke or replay abort when prompt cancellation remains unknown", async () => {
    const { adapter, state } = createHarness({
      promptHandler: (_message, options) => new Promise<void>((_resolve, rejectPrompt) => {
        options?.signal?.addEventListener(
          "abort",
          () => rejectPrompt(promptAdmissionError("unknown")),
          { once: true },
        );
      }),
    });
    const connection = await adapter.createResident(createInput());
    const prompt = connection.prompt(
      "Transport may lose ownership evidence.",
      residentDispatchLease("prompt", connection.binding, "dispatch-unknown-before-abort"),
    );
    await vi.waitFor(() => expect(state.promptCalls).toHaveLength(1));
    const abortLease = residentDispatchLease(
      "abort",
      connection.binding,
      "dispatch-abort-after-unknown",
    );
    const abort = connection.abort(abortLease);

    await expect(prompt).rejects.toMatchObject({ code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN" });
    await expect(abort).rejects.toMatchObject({ code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN" });
    await expect(connection.abort(abortLease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    });
    expect(state.abortCalls).toBe(0);
    expect(state.promptCalls).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("allows a new Stop after an advanced active projection proves an uncertain prompt is owned", async () => {
    let projectionPhase: "idle" | "active" = "idle";
    const { adapter, state, emit } = createHarness({
      promptHandler: async () => {
        throw promptAdmissionError("unknown");
      },
      snapshotHandler: () => projectionPhase === "idle"
        ? validSnapshot({ cursorSequence: 4 })
        : validSnapshot({ cursorSequence: 5, state: { isStreaming: true } }),
    });
    const connection = await adapter.createResident(createInput());
    const promptLease = residentDispatchLease(
      "prompt",
      connection.binding,
      "dispatch-unknown-before-projection-proof",
    );
    const preProofAbortLease = residentDispatchLease(
      "abort",
      connection.binding,
      "dispatch-abort-before-projection-proof",
    );

    await expect(connection.prompt("Ownership evidence may arrive later.", promptLease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    });
    await expect(connection.abort(preProofAbortLease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    });
    expect(state.abortCalls).toBe(0);

    projectionPhase = "active";
    await emit({ type: "session_event", event: { type: "message_update" } });
    await vi.waitFor(() => expect(state.projectionCalls).toHaveLength(2));
    await Promise.resolve();
    expect(state.projectionCalls.at(-1)?.projection).toMatchObject({
      cursor: { generation: "events-1", sequence: 5 },
      runtime: { isStreaming: true },
    });

    const postProofAbortLease = residentDispatchLease(
      "abort",
      connection.binding,
      "dispatch-abort-after-projection-proof",
    );
    await expect(connection.abort(postProofAbortLease)).resolves.toEqual({
      operation: "abort",
      disposition: "accepted",
      completion: "not_observed",
    });
    expect(state.abortCalls).toBe(1);

    // Store no-replay authority is preserved: the original dispatch identity
    // keeps its memoized uncertain outcome and cannot gain a later invocation.
    await expect(connection.abort(preProofAbortLease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    });
    expect(state.abortCalls).toBe(1);
    await connection.detach();
    await adapter.close();
  });

  it("accepts an active resync in a new non-retired cursor generation as prompt ownership proof", async () => {
    const { adapter, state, emit } = createHarness({
      promptHandler: async () => {
        throw promptAdmissionError("unknown");
      },
      snapshotHandler: () => validSnapshot({ cursorGeneration: "events-a", cursorSequence: 4 }),
    });
    const connection = await adapter.createResident(createInput());
    await expect(
      connection.prompt(
        "Ownership will be proven after daemon cursor rollover.",
        residentDispatchLease("prompt", connection.binding, "dispatch-unknown-before-resync-rollover"),
      ),
    ).rejects.toMatchObject({ code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN" });

    const preProofAbortLease = residentDispatchLease(
      "abort",
      connection.binding,
      "dispatch-abort-before-resync-rollover",
    );
    await expect(connection.abort(preProofAbortLease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    });
    expect(state.abortCalls).toBe(0);

    await emit({
      type: "session_resynced",
      snapshot: validSnapshot({
        cursorGeneration: "events-b",
        cursorSequence: 0,
        state: {
          sessionActions: {
            queuedCount: 0,
            steering: [],
            followUps: [],
            active: { kind: "session_command", phase: "running", label: "Stopping" },
          },
        },
      }),
    });
    expect(state.projectionCalls.at(-1)?.projection).toMatchObject({
      cursor: { generation: "events-b", sequence: 0 },
      runtime: { isStreaming: false },
      queue: { active: { kind: "session_command", phase: "running" } },
    });

    await expect(
      connection.abort(
        residentDispatchLease("abort", connection.binding, "dispatch-abort-after-resync-rollover"),
      ),
    ).resolves.toMatchObject({ operation: "abort", disposition: "accepted" });
    expect(state.abortCalls).toBe(1);

    await expect(connection.abort(preProofAbortLease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    });
    expect(state.abortCalls).toBe(1);
    await connection.detach();
    await adapter.close();
  });

  it("retires a stale cancelled admission only after a later active projection advances", async () => {
    let projectionPhase: "idle" | "active" = "idle";
    const { adapter, state, emit } = createHarness({
      promptHandler: async () => {
        throw promptAdmissionError("cancelled");
      },
      snapshotHandler: () => projectionPhase === "idle"
        ? validSnapshot({ cursorSequence: 4 })
        : validSnapshot({ cursorSequence: 5, state: { isStreaming: true } }),
    });
    const connection = await adapter.createResident(createInput());
    await expect(
      connection.prompt(
        "The admission was reported cancelled.",
        residentDispatchLease("prompt", connection.binding, "dispatch-cancelled-before-proof"),
      ),
    ).rejects.toMatchObject({
      code: "PRIME_RUNTIME_REQUEST_FAILED",
      details: { outcome: "not_accepted", status: "cancelled" },
    });

    const preProofAbortLease = residentDispatchLease(
      "abort",
      connection.binding,
      "dispatch-cancelled-abort-before-proof",
    );
    await expect(connection.abort(preProofAbortLease)).resolves.toEqual({
      operation: "abort",
      disposition: "not_needed",
      completion: "not_observed",
      reason: "prompt_admission_cancelled",
    });
    expect(state.abortCalls).toBe(0);

    projectionPhase = "active";
    await emit({ type: "session_event", event: { type: "agent_end" } });
    await vi.waitFor(() => expect(state.projectionCalls).toHaveLength(2));
    await Promise.resolve();

    await expect(
      connection.abort(
        residentDispatchLease("abort", connection.binding, "dispatch-cancelled-abort-after-proof"),
      ),
    ).resolves.toMatchObject({ operation: "abort", disposition: "accepted" });
    expect(state.abortCalls).toBe(1);

    await expect(connection.abort(preProofAbortLease)).resolves.toMatchObject({
      operation: "abort",
      disposition: "not_needed",
    });
    expect(state.abortCalls).toBe(1);
    await connection.detach();
    await adapter.close();
  });

  it("lets abort bypass a model catalog read that has not settled", async () => {
    const modelCatalog = deferred();
    const { adapter, state } = createHarness({
      availableModelsHandler: async () => {
        await modelCatalog.promise;
        return [{ provider: "openai", id: "gpt-5" }];
      },
    });
    const connection = await adapter.createResident(createInput());
    const modelSelection = adapter.submit(modelSelectionCommand("select-model-blocked-catalog"), {
      residentBinding: connection.binding,
    });
    await vi.waitFor(() => expect(state.availableModelsCalls).toBe(1));

    const abort = connection.abort(
      residentDispatchLease("abort", connection.binding, "dispatch-abort-bypasses-model"),
    );
    await vi.waitFor(() => expect(state.abortCalls).toBe(1), { timeout: 250 });
    await expect(abort).resolves.toMatchObject({ operation: "abort", disposition: "accepted" });

    modelCatalog.resolve();
    await expect(modelSelection).resolves.toMatchObject({ disposition: "handled" });
    await connection.detach();
    await adapter.close();
  });

  it("serializes prompt admission behind model selection while Stop keeps its priority lane", async () => {
    const modelCatalog = deferred();
    const { adapter, state } = createHarness({
      availableModelsHandler: async () => {
        await modelCatalog.promise;
        return [{ provider: "openai", id: "gpt-5" }];
      },
    });
    const connection = await adapter.createResident(createInput());
    const modelSelection = adapter.submit(modelSelectionCommand("select-before-prompt"), {
      residentBinding: connection.binding,
    });
    await vi.waitFor(() => expect(state.availableModelsCalls).toBe(1));

    const prompt = connection.prompt(
      "Use only the selected model.",
      residentDispatchLease("prompt", connection.binding, "dispatch-after-model"),
    );
    await Promise.resolve();
    expect(state.promptCalls).toHaveLength(0);

    modelCatalog.resolve();
    await expect(modelSelection).resolves.toMatchObject({ disposition: "handled" });
    await expect(prompt).resolves.toMatchObject({ operation: "prompt", disposition: "accepted" });
    expect(state.promptCalls).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("distinguishes confirmed prompt cancellation from an unknown admission outcome", async () => {
    const cancelledHarness = createHarness({
      promptHandler: (_message, options) => new Promise<void>((_resolve, rejectPrompt) => {
        options?.signal?.addEventListener(
          "abort",
          () => rejectPrompt(promptAdmissionError("cancelled")),
          { once: true },
        );
      }),
    });
    const cancelledConnection = await cancelledHarness.adapter.createResident(createInput());

    await expect(
      cancelledConnection.prompt(
        "Cancel before ownership.",
        residentDispatchLease("prompt", cancelledConnection.binding, "dispatch-cancelled"),
      ),
    ).rejects.toMatchObject({
      code: "PRIME_RUNTIME_REQUEST_FAILED",
      retryable: false,
      details: { outcome: "not_accepted", status: "cancelled" },
    });
    expect(cancelledHarness.state.promptCalls).toHaveLength(1);
    await cancelledConnection.detach();
    await cancelledHarness.adapter.close();

    const unknownHarness = createHarness({
      promptHandler: (_message, options) => new Promise<void>((_resolve, rejectPrompt) => {
        options?.signal?.addEventListener(
          "abort",
          () => rejectPrompt(promptAdmissionError("unknown")),
          { once: true },
        );
      }),
    });
    const unknownConnection = await unknownHarness.adapter.createResident(createInput());
    await expect(
      unknownConnection.prompt(
        "Do not replay this prompt.",
        residentDispatchLease("prompt", unknownConnection.binding, "dispatch-unknown"),
      ),
    ).rejects.toMatchObject({
      code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
      retryable: false,
      details: { outcome: "unknown" },
    });
    await expect(
      unknownConnection.prompt(
        "Do not replay this prompt.",
        residentDispatchLease("prompt", unknownConnection.binding, "dispatch-unknown"),
      ),
    ).rejects.toMatchObject({ code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN" });
    expect(unknownHarness.state.promptCalls).toHaveLength(1);
    await unknownConnection.detach();
    await unknownHarness.adapter.close();
  });

  it("marks abort rejection ambiguous and never invokes the same dispatch twice", async () => {
    const { adapter, state } = createHarness({
      abortHandler: async () => {
        throw new Error("daemon response disconnected");
      },
    });
    const connection = await adapter.createResident(createInput());
    const lease = residentDispatchLease("abort", connection.binding, "dispatch-abort-unknown");

    await expect(connection.abort(lease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
      retryable: false,
    });
    await expect(connection.abort(lease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    });
    expect(state.abortCalls).toBe(1);
    await connection.detach();
    await adapter.close();
  });

  it("rechecks the exact binding when a queued dispatch reaches its one mutation call", async () => {
    const firstPrompt = deferred();
    const { adapter, state, emit } = createHarness({
      promptHandler: () => firstPrompt.promise,
    });
    const connection = await adapter.createResident(createInput());
    const originalBinding = connection.binding;
    const first = connection.prompt(
      "Hold admission briefly.",
      residentDispatchLease("prompt", originalBinding, "dispatch-before-binding-refresh"),
    );
    await vi.waitFor(() => expect(state.promptCalls).toHaveLength(1));
    const second = connection.abort(
      residentDispatchLease("abort", originalBinding, "dispatch-after-binding-refresh"),
    );

    await emit({ type: "connection_status", status: "reconnecting" });
    state.hello = validHello({ supervisorGeneration: "supervisor-dispatch-refresh" });
    await emit({ type: "session_resynced", snapshot: validSnapshot() });
    await emit({ type: "connection_status", status: "connected" });
    firstPrompt.resolve();

    await expect(first).resolves.toMatchObject({ disposition: "accepted" });
    await expect(second).rejects.toMatchObject({
      code: "PRIME_RUNTIME_DISPATCH_AUTHORITY_CHANGED",
      retryable: false,
    });
    expect(state.abortCalls).toBe(0);
    await connection.detach();
    await adapter.close();
  });

  it("drains an invoked prompt on close and rejects queued work before an upstream call", async () => {
    const firstPrompt = deferred();
    const { adapter, state } = createHarness({ promptHandler: () => firstPrompt.promise });
    const connection = await adapter.createResident(createInput());
    const promptResult = connection.prompt(
      "Drain this admission.",
      residentDispatchLease("prompt", connection.binding, "dispatch-before-close"),
    );
    await vi.waitFor(() => expect(state.promptCalls).toHaveLength(1));
    const queuedAbort = connection
      .abort(residentDispatchLease("abort", connection.binding, "dispatch-queued-before-close"))
      .catch((error: unknown) => error);
    const closed = adapter.close();
    await Promise.resolve();
    expect(state.disposeCalls).toBe(0);

    firstPrompt.resolve();
    await expect(promptResult).resolves.toMatchObject({ disposition: "accepted" });
    await expect(queuedAbort).resolves.toMatchObject({ code: "PRIME_RUNTIME_DISPATCH_AUTHORITY_CHANGED" });
    await expect(closed).resolves.toBeUndefined();
    expect(state.abortCalls).toBe(0);
    expect(state.disposeCalls).toBe(1);
  });

  it("waits for independent model and abort lanes before terminal disposal", async () => {
    const modelCatalog = deferred();
    const abortAdmission = deferred();
    const { adapter, state } = createHarness({
      availableModelsHandler: async () => {
        await modelCatalog.promise;
        return [{ provider: "openai", id: "gpt-5" }];
      },
      abortHandler: () => abortAdmission.promise,
    });
    const connection = await adapter.createResident(createInput());
    const modelSelection = adapter.submit(modelSelectionCommand("select-model-terminal-drain"), {
      residentBinding: connection.binding,
    });
    await vi.waitFor(() => expect(state.availableModelsCalls).toBe(1));
    const abort = connection.abort(
      residentDispatchLease("abort", connection.binding, "dispatch-abort-terminal-drain"),
    );
    await vi.waitFor(() => expect(state.abortCalls).toBe(1));

    const detached = connection.detach();
    await Promise.resolve();
    expect(state.disposeCalls).toBe(0);
    abortAdmission.resolve();
    await expect(abort).resolves.toMatchObject({ disposition: "accepted" });
    expect(state.disposeCalls).toBe(0);
    modelCatalog.resolve();
    await expect(modelSelection).rejects.toMatchObject({
      code: "MODEL_SELECTION_SESSION_AUTHORITY_CHANGED",
      uncertain: false,
    });
    await expect(detached).resolves.toBeUndefined();
    expect(state.disposeCalls).toBe(1);
    await adapter.close();
  });

  it("attaches while snapshots advance and publishes only after a quiet authoritative pair", async () => {
    let reads = 0;
    const { adapter, state } = createHarness({
      snapshotHandler: () => {
        reads += 1;
        const cursorSequence = reads <= 4 ? reads : 5;
        return validSnapshot({
          cursorSequence,
          state: { recap: cursorSequence === 5 ? "Streaming settled." : `Streaming ${cursorSequence}` },
        });
      },
    });

    const connection = await adapter.createResident(createInput());
    await vi.waitFor(() => expect(state.projectionCalls).toHaveLength(1));

    expect(connection.getLifecycle().state).toBe("ready");
    expect(state.projectionCalls[0]?.projection.cursor.sequence).toBe(5);
    expect(state.projectionCalls[0]?.projection.runtime.recap).toBe("Streaming settled.");
    expect(reads).toBe(6);
    await connection.detach();
    await adapter.close();
  });

  it("keeps a continuously changing stream live, bounds each retry, and publishes after quiet", async () => {
    let phase: "initial" | "streaming" = "initial";
    let streamingReads = 0;
    const { adapter, state, emit } = createHarness({
      snapshotHandler: () => {
        if (phase === "initial") return validSnapshot();
        streamingReads += 1;
        const cursorSequence = streamingReads <= 8 ? 4 + streamingReads : 12;
        return validSnapshot({
          cursorSequence,
          state: { recap: streamingReads <= 8 ? "Still streaming." : "Stream is quiet." },
        });
      },
    });
    const connection = await adapter.createResident(createInput());
    phase = "streaming";

    await emit({ type: "session_event", event: { type: "message_delta" } });
    await vi.waitFor(() => expect(state.projectionCalls).toHaveLength(2));

    expect(connection.getLifecycle().state).toBe("ready");
    expect(state.projectionCalls[1]?.projection.cursor.sequence).toBe(12);
    expect(state.projectionCalls[1]?.projection.runtime.recap).toBe("Stream is quiet.");
    expect(streamingReads).toBe(10);
    expect(state.disposeCalls).toBe(0);
    await connection.detach();
    await adapter.close();
  });

  it("coalesces prompt and abort events into stable authoritative transcript and status publications", async () => {
    let phase = 0;
    let projectionGate = deferred();
    const { adapter, state, emit } = createHarness({
      waitHandler: (milliseconds) => milliseconds === 100 ? projectionGate.promise : undefined,
      snapshotHandler: () => phase === 0
        ? validSnapshot()
        : phase === 1
          ? validSnapshot({
              messages: [{ role: "user", content: "Run the resident task.", timestamp: 1_786_100_000_000 }],
              cursorSequence: 5,
              state: { isStreaming: true, recap: "Prime Agent owns the prompt." },
            })
          : validSnapshot({
              messages: [{ role: "user", content: "Run the resident task.", timestamp: 1_786_100_000_000 }],
              cursorSequence: 6,
              state: { isStreaming: false, recap: "Abort requested; waiting for the runtime to settle." },
            }),
    });
    const connection = await adapter.createResident(createInput());
    await connection.prompt(
      "Run the resident task.",
      residentDispatchLease("prompt", connection.binding, "dispatch-event-prompt"),
    );
    phase = 1;
    await Promise.all(
      Array.from({ length: 20 }, () => emit({ type: "session_event", event: { type: "message_update" } })),
    );
    expect(state.projectionCalls).toHaveLength(1);
    projectionGate.resolve();
    await vi.waitFor(() => expect(state.projectionCalls).toHaveLength(2));
    expect(JSON.stringify(state.projectionCalls[1]?.projection.transcript)).toContain("Run the resident task.");
    expect(state.projectionCalls[1]?.projection.runtime.recap).toBe("Prime Agent owns the prompt.");

    await Promise.resolve();
    projectionGate = deferred();
    await connection.abort(
      residentDispatchLease("abort", connection.binding, "dispatch-event-abort"),
    );
    phase = 2;
    await emit({ type: "session_status", recap: "Abort requested" });
    projectionGate.resolve();
    await vi.waitFor(() => expect(state.projectionCalls).toHaveLength(3));
    expect(state.projectionCalls[2]?.projection.runtime.recap).toBe(
      "Abort requested; waiting for the runtime to settle.",
    );
    // Initial attach and each event refresh use two matching reads; the burst
    // never creates one authoritative read per token event.
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(6);
    await connection.detach();
    await adapter.close();
  });
});

describe("PrimeAgentResidentAdapter model-selection gateway", () => {
  it("prechecks, mutates once, and publishes a fresh authoritative projection", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.createResident(createInput());
    const command = modelSelectionCommand();

    await expect(adapter.submit(command, { residentBinding: connection.binding })).resolves.toMatchObject({
      disposition: "handled",
      message: "Prime Agent selected and verified the requested model",
    });
    await expect(adapter.submit(command, { residentBinding: connection.binding })).resolves.toMatchObject({
      disposition: "handled",
    });

    expect(state.availableModelsCalls).toBe(1);
    expect(state.setModelCalls).toEqual([{ providerId: "openai", modelId: "gpt-5" }]);
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(4);
    expect(state.projectionCalls).toHaveLength(2);
    expect(state.projectionCalls.at(-1)?.projection.runtime.model).toBe("openai/gpt-5");
    await connection.detach();
    await adapter.close();
  });

  it("trusts only the fresh snapshot, never the raw setModel response DTO", async () => {
    const { adapter, state } = createHarness({
      setModelHandler: () => ({
        provider: "untrusted-response-provider",
        id: "untrusted-response-model",
        credential: "must-never-cross-the-adapter-boundary",
      }),
    });
    const connection = await adapter.createResident(createInput());

    const result = await adapter.submit(modelSelectionCommand("select-with-untrusted-result"), {
      residentBinding: connection.binding,
    });

    expect(result).toEqual({
      disposition: "handled",
      message: "Prime Agent selected and verified the requested model",
    });
    expect(JSON.stringify(result)).not.toContain("untrusted-response");
    expect(JSON.stringify(result)).not.toContain("credential");
    expect(state.projectionCalls.at(-1)?.projection.runtime.model).toBe("openai/gpt-5");
    await connection.detach();
    await adapter.close();
  });

  it("marks reconciliation uncertain when authoritative snapshot cursors never stabilize", async () => {
    let snapshotRead = 0;
    const { adapter, state } = createHarness({
      snapshotHandler: () => {
        snapshotRead += 1;
        return validSnapshot({ cursorSequence: snapshotRead <= 2 ? 4 : 2 + snapshotRead });
      },
    });
    const connection = await adapter.createResident(createInput());

    await expect(
      adapter.submit(modelSelectionCommand("select-with-unstable-snapshot"), {
        residentBinding: connection.binding,
      }),
    ).rejects.toMatchObject({
      code: "MODEL_SELECTION_RECONCILIATION_FAILED",
      uncertain: true,
      retryable: false,
    });
    expect(state.setModelCalls).toHaveLength(1);
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(6);
    expect(state.projectionCalls).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("fails before mutation when the live sanitized catalog lacks the exact model", async () => {
    const { adapter, state } = createHarness({
      availableModelsHandler: () => [{ provider: "anthropic", id: "claude-opus-4" }],
    });
    const connection = await adapter.createResident(createInput());

    await expect(adapter.submit(modelSelectionCommand(), { residentBinding: connection.binding })).rejects.toMatchObject({
      name: "GatewayError",
      code: "MODEL_NOT_AVAILABLE",
      uncertain: false,
    });
    expect(state.setModelCalls).toHaveLength(0);
    expect(state.projectionCalls).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("marks an ambiguous setModel rejection uncertain and never retries it", async () => {
    const { adapter, state } = createHarness({
      setModelHandler: async () => {
        throw new Error("credential-and-upstream-detail-must-not-escape");
      },
    });
    const connection = await adapter.createResident(createInput());
    const command = modelSelectionCommand();

    const first = adapter.submit(command, { residentBinding: connection.binding });
    await expect(first).rejects.toMatchObject({
      name: "GatewayError",
      code: "MODEL_SELECTION_OUTCOME_UNKNOWN",
      uncertain: true,
      retryable: false,
    });
    await expect(adapter.submit(command, { residentBinding: connection.binding })).rejects.toMatchObject({
      code: "MODEL_SELECTION_OUTCOME_UNKNOWN",
      message: "Prime Agent may have changed the model, but no authoritative result is available",
    });

    expect(state.availableModelsCalls).toBe(1);
    expect(state.setModelCalls).toHaveLength(1);
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(2);
    await connection.detach();
    await adapter.close();
  });

  it("serializes model mutations per resident session", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstMutation = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    const { adapter, state } = createHarness({
      setModelHandler: async (providerId, modelId) => {
        if (state.setModelCalls.length === 1) await firstMutation;
        return { provider: providerId, id: modelId };
      },
    });
    const connection = await adapter.createResident(createInput());
    const first = adapter.submit(modelSelectionCommand("select-model-serial-1"), {
      residentBinding: connection.binding,
    });
    while (state.setModelCalls.length === 0) await Promise.resolve();
    const second = adapter.submit(modelSelectionCommand("select-model-serial-2"), {
      residentBinding: connection.binding,
    });
    await Promise.resolve();

    expect(state.setModelCalls).toHaveLength(1);
    expect(state.availableModelsCalls).toBe(1);
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(state.setModelCalls).toHaveLength(2);
    expect(state.availableModelsCalls).toBe(2);
    await connection.detach();
    await adapter.close();
  });

  it("rechecks the exact binding when a queued selection reaches the mutation boundary", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstMutation = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    const { adapter, state, emit } = createHarness({
      setModelHandler: async (providerId, modelId) => {
        if (state.setModelCalls.length === 1) await firstMutation;
        return { provider: providerId, id: modelId };
      },
    });
    const connection = await adapter.createResident(createInput());
    const first = adapter.submit(modelSelectionCommand("select-before-binding-refresh"), {
      residentBinding: connection.binding,
    });
    while (state.setModelCalls.length === 0) await Promise.resolve();
    const second = adapter.submit(modelSelectionCommand("select-after-binding-refresh"), {
      residentBinding: connection.binding,
    });

    await emit({ type: "connection_status", status: "reconnecting" });
    state.hello = validHello({ supervisorGeneration: "supervisor-model-refresh" });
    await emit({ type: "session_resynced", snapshot: validSnapshot() });
    await emit({ type: "connection_status", status: "connected" });
    releaseFirst?.();

    await expect(first).resolves.toMatchObject({ disposition: "handled" });
    await expect(second).rejects.toMatchObject({
      code: "MODEL_SELECTION_SESSION_AUTHORITY_CHANGED",
      uncertain: false,
    });
    expect(state.setModelCalls).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("lets a terminal action drain one in-flight mutation but cancels queued mutations before setModel", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstMutation = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    const { adapter, state } = createHarness({
      setModelHandler: async (providerId, modelId) => {
        if (state.setModelCalls.length === 1) await firstMutation;
        return { provider: providerId, id: modelId };
      },
    });
    const connection = await adapter.createResident(createInput());
    const first = adapter.submit(modelSelectionCommand("select-before-detach"), {
      residentBinding: connection.binding,
    });
    while (state.setModelCalls.length === 0) await Promise.resolve();
    const second = adapter
      .submit(modelSelectionCommand("select-queued-before-detach"), { residentBinding: connection.binding })
      .catch((error: unknown) => error);
    const detached = connection.detach();
    releaseFirst?.();

    await expect(first).resolves.toMatchObject({ disposition: "handled" });
    await expect(second).resolves.toMatchObject({
      code: "MODEL_SELECTION_SESSION_AUTHORITY_CHANGED",
      uncertain: false,
    });
    await expect(detached).resolves.toBeUndefined();
    expect(state.setModelCalls).toHaveLength(1);
    await adapter.close();
  });

  it("requires the exact durable binding before reaching private model APIs", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.createResident(createInput());
    const wrong = binding({ executionGenerationId: "generation-forged" });

    await expect(adapter.submit(modelSelectionCommand(), { residentBinding: wrong })).rejects.toBeInstanceOf(
      GatewayError,
    );
    expect(state.availableModelsCalls).toBe(0);
    expect(state.setModelCalls).toHaveLength(0);
    await connection.detach();
    await adapter.close();
  });
});
