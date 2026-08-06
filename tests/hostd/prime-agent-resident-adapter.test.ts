import { describe, expect, it, vi } from "vitest";
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

function validHello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "daemon_hello",
    socketPath: "\\\\.\\pipe\\prime-continuim-test",
    protocol: { name: "prime-agent.daemon", version: 7 },
    schemaId: "protocol-7-schema-13-816309b1cd50",
    schemaRevision: 13,
    appVersion: "0.7.0",
    runtime: {
      buildId: "prime-agent-v0.7.0",
      executablePath: "C:\\runtime\\node.exe",
      entrypointPath: "C:\\runtime\\prime-agent\\dist\\bundle\\cli.js",
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
  launcherExit?: readonly [number | null, string | null];
  persistCalls: ResidentSessionBinding[];
  completeCalls: ResidentSessionBinding[];
  requestHandler?: (command: Readonly<object>) => Promise<unknown> | unknown;
  persistHandler?: (binding: ResidentSessionBinding) => Promise<void>;
  completeHandler?: (binding: ResidentSessionBinding) => Promise<void>;
  snapshotHandler?: () => Promise<unknown> | unknown;
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
    persistCalls: [],
    completeCalls: [],
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
            : {
                state: {
                  activeSessionId: "active-1",
                  sessionId: "session-1",
                  sessionFile: "C:\\sessions\\session-1.jsonl",
                  cwd: "C:\\work\\project",
                  isStreaming: false,
                },
                messages: [],
                lastEventSequence: 4,
                lastEventCursor: { generation: "events-1", sequence: 4 },
              };
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
    stdout: { on: () => undefined },
    stderr: { on: () => undefined },
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
  };

  const adapter = new PrimeAgentResidentAdapter({
    socketPath: "\\\\.\\pipe\\prime-continuim-test",
    executable: "C:\\runtime\\node.exe",
    cliEntrypoint: "C:\\runtime\\prime-agent\\dist\\bundle\\cli.js",
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
    const invocation = buildResidentDaemonStartInvocation({
      executable: "C:\\runtime\\node.exe",
      cliEntrypoint: "C:\\runtime\\prime-agent\\dist\\bundle\\cli.js",
      socketPath: "\\\\.\\pipe\\prime-continuim-test",
    });

    await expect(adapter.ensureDaemon(invocation)).resolves.toMatchObject({ appVersion: "0.7.0" });

    expect(state.spawnCalls).toHaveLength(0);
    expect(state.chronology).toEqual(["connect", "client:close"]);
    expect(adapter.getLifecycle().state).toBe("ready");
    await adapter.close();
  });

  it("launches the verified CLI through Node with a fixed shell-free argv and a single concurrent spawn", async () => {
    const { adapter, state } = createHarness({ connectOutcomes: ["fail", "fail", "ok", "ok"] });
    const invocation = buildResidentDaemonStartInvocation({
      executable: "C:\\runtime\\node.exe",
      cliEntrypoint: "C:\\runtime\\prime-agent\\dist\\bundle\\cli.js",
      socketPath: "\\\\.\\pipe\\prime-continuim-test",
    });

    await Promise.all([adapter.ensureDaemon(invocation), adapter.ensureDaemon(invocation)]);

    expect(state.spawnCalls).toEqual([
      {
        executable: "C:\\runtime\\node.exe",
        argv: [
          "C:\\runtime\\prime-agent\\dist\\bundle\\cli.js",
          "daemon",
          "start",
          "--socket",
          "\\\\.\\pipe\\prime-continuim-test",
        ],
        options: { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      },
    ]);
    expect(state.launcherKills).toBe(0);
    await adapter.close();
  });

  it("fails closed on an incompatible live daemon without launching a replacement", async () => {
    const { adapter, state } = createHarness({ hello: validHello({ appVersion: "0.7.1" }) });
    const invocation = buildResidentDaemonStartInvocation({
      executable: "C:\\runtime\\node.exe",
      cliEntrypoint: "C:\\runtime\\prime-agent\\dist\\bundle\\cli.js",
      socketPath: "\\\\.\\pipe\\prime-continuim-test",
    });

    await expectRuntimeError(adapter.ensureDaemon(invocation), "PRIME_RUNTIME_APP_VERSION_MISMATCH");

    expect(state.spawnCalls).toHaveLength(0);
    expect(adapter.getLifecycle().state).toBe("failed");
    await adapter.close();
  });

  it("does not launch over an indeterminate endpoint timeout", async () => {
    const { adapter, state } = createHarness({ connectOutcomes: ["timeout"] });
    const invocation = buildResidentDaemonStartInvocation({
      executable: "C:\\runtime\\node.exe",
      cliEntrypoint: "C:\\runtime\\prime-agent\\dist\\bundle\\cli.js",
      socketPath: "\\\\.\\pipe\\prime-continuim-test",
    });

    await expectRuntimeError(adapter.ensureDaemon(invocation), "PRIME_RUNTIME_UNAVAILABLE");

    expect(state.spawnCalls).toHaveLength(0);
    await adapter.close();
  });

  it("accepts a valid external winner even when the local launcher exits nonzero", async () => {
    const { adapter, state } = createHarness({
      connectOutcomes: ["fail", "fail", "ok"],
      launcherExit: [1, null],
    });
    const invocation = buildResidentDaemonStartInvocation({
      executable: "C:\\runtime\\node.exe",
      cliEntrypoint: "C:\\runtime\\prime-agent\\dist\\bundle\\cli.js",
      socketPath: "\\\\.\\pipe\\prime-continuim-test",
    });

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
      snapshotHandler: async () => ({
        state: {
          activeSessionId: "active-1",
          sessionId: "reused-session-id",
          sessionFile: "C:\\sessions\\session-1.jsonl",
          cwd: "C:\\work\\project",
        },
        messages: [],
        lastEventSequence: 8,
        lastEventCursor: { generation: "events-1", sequence: 8 },
      }),
    });

    await expectRuntimeError(adapter.attachResident(binding()), "PRIME_RUNTIME_SESSION_MISMATCH");

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
      snapshot: {
        state: {
          activeSessionId: "active-1",
          sessionId: "session-1",
          sessionFile: "C:\\sessions\\session-1.jsonl",
          cwd: "C:\\work\\project",
        },
        messages: [],
        lastEventCursor: { generation: "events-2", sequence: 5 },
        lastEventSequence: 5,
      },
    });
    await emit({ type: "connection_status", status: "connected" });

    expect(connection.getLifecycle().state).toBe("ready");
    expect(connection.binding.runtime.supervisorGeneration).toBe("supervisor-2");
    expect(state.persistCalls.at(-1)?.runtime.supervisorGeneration).toBe("supervisor-2");
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
