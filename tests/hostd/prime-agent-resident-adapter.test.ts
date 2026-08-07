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
  validateResidentDaemonHello,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import type { ResidentProjectionSnapshot } from "../../src/hostd/resident-projection";
import { GatewayError } from "../../src/hostd/gateway";
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
  requestHandler?: (command: Readonly<object>) => Promise<unknown> | unknown;
  persistHandler?: (binding: ResidentSessionBinding) => Promise<void>;
  completeHandler?: (binding: ResidentSessionBinding) => Promise<void>;
  publishProjectionHandler?: (
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>;
  snapshotHandler?: () => Promise<unknown> | unknown;
  availableModelsCalls: number;
  setModelCalls: Array<{ providerId: string; modelId: string }>;
  availableModelsHandler?: () => Promise<unknown> | unknown;
  setModelHandler?: (providerId: string, modelId: string) => Promise<unknown> | unknown;
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
    availableModelsCalls: 0,
    setModelCalls: [],
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
    wait: async () => undefined,
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
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(3);
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
      snapshotHandler: () => validSnapshot({ cursorSequence: 4 + snapshotRead++ }),
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
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(5);
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
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(1);
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
