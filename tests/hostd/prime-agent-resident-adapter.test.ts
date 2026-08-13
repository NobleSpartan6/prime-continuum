import { bootstrapTestWorkspace } from "./test-workspace-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import {
  HostStore,
  type ResidentKillInvocationAuthorizer,
  type ResidentKillLease,
  type ResidentPromptReconciliationLease,
} from "../../src/hostd/store";
import { PROTOCOL_VERSION, type CommandEnvelope } from "../../src/shared/protocol";
import { canonicalTemporaryDirectory } from "../helpers/canonical-temp";

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
const WORKSPACE_DIRECTORY = resolve("test-workspaces", "resident-adapter");
const OTHER_WORKSPACE_DIRECTORY = resolve("test-workspaces", "resident-adapter-other");
const SESSION_DIRECTORY = resolve("test-sessions", "resident-adapter");
const SESSION_FILE = join(SESSION_DIRECTORY, "session-1.jsonl");
const OTHER_SESSION_FILE = join(SESSION_DIRECTORY, "other.jsonl");
const DURABLE_RESIDENT_AUTHORITY_TEST_TIMEOUT_MS = 15_000;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
    schemaId: "protocol-7-schema-16-1bcb9e7f1a49",
    schemaRevision: 16,
    appVersion: "0.7.2",
    runtime: {
      buildId: "83a0f9f-dirty",
      executablePath: RUNTIME_NODE,
      entrypointPath: RUNTIME_CLI,
    },
    supervisorGeneration: "supervisor-1",
    supervisorPid: 42,
    supervisorOwnerToken: "owner-token-1",
    supervisorProcessStartId: "process-start-1",
    supervisorSocketPath: DAEMON_SOCKET,
    clientId: "client-test",
    serverCapabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES],
    ...overrides,
  };
}

function incompatibleUpgradeHello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validHello({
    appVersion: "0.7.0",
    schemaId: "protocol-7-schema-12-prior",
    schemaRevision: 12,
    runtime: {
      buildId: "verified-prior-build",
      executablePath: resolve("test-runtime-prior", "node.exe"),
      entrypointPath: resolve("test-runtime-prior", "prime-agent", "dist", "bundle", "cli.js"),
    },
    supervisorGeneration: "supervisor-prior",
    ...overrides,
  });
}

function liveSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "active-1",
    lifecycle: "live",
    activity: "idle",
    isSessionActive: false,
    activeSessionId: "active-1",
    sessionId: "session-1",
    sessionFile: SESSION_FILE,
    sessionName: "Prime Continuim",
    cwd: WORKSPACE_DIRECTORY,
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
  children?: unknown[];
  cursorGeneration?: string;
  cursorSequence?: number;
} = {}): Record<string, unknown> {
  const messages = options.messages ?? [];
  const cursorGeneration = options.cursorGeneration ?? "events-1";
  const cursorSequence = options.cursorSequence ?? 4;
  return {
    state: {
      activeSessionId: "active-1",
      cwd: WORKSPACE_DIRECTORY,
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
      sessionFile: SESSION_FILE,
      sessionId: "session-1",
      sessionName: "Prime Continuim",
      sessionDir: SESSION_DIRECTORY,
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
    children: options.children ?? [],
    lastEventSequence: cursorSequence,
    lastEventCursor: { generation: cursorGeneration, sequence: cursorSequence },
  };
}

function terminalAssistantMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "The resident turn is complete." }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1_786_100_000_000,
    ...overrides,
  };
}

function rlmChild(
  status: "queued" | "running" | "done" | "error" | "cancelled" = "running",
): Record<string, unknown> {
  return {
    id: "sub-settlement-1",
    parentId: "parent-settlement-1",
    sessionName: "settlement-reviewer",
    model: "openai/gpt-5",
    label: "Review settlement authority",
    status,
    sessionDir: SESSION_DIRECTORY,
    activity: status === "running" ? { kind: "executing", toolName: "exec" } : undefined,
  };
}

function validResourceSnapshot(): Record<string, unknown> {
  return {
    contextFiles: [],
    skills: [],
    prompts: [],
    extensions: [],
    themes: [],
    diagnostics: { skills: [], prompts: [], extensions: [], themes: [] },
  };
}

function validAuthoritativeSnapshot(options: {
  state?: Record<string, unknown>;
  messages?: unknown[];
  sessionContext?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const messages = options.messages ?? [];
  return {
    ...validSnapshot({
      messages,
      state: {
        leafId: "model-change-1",
        ...options.state,
      },
    }),
    sessionContext: options.sessionContext ?? {
      messages: [],
      thinkingLevel: "medium",
      serviceTier: "standard",
      model: { provider: "openai", modelId: "gpt-5" },
    },
  };
}

interface HarnessState {
  connectOutcomes: Array<"ok" | "fail" | "timeout">;
  hello: unknown;
  chronology: string[];
  requests: Array<Readonly<object>>;
  closes: number;
  disposeCalls: number;
  subscribeCalls: number;
  unsubscribeCalls: number;
  ownedCleanupDisposeCalls: number;
  residentDetachDisposeCalls: number;
  eventListeners: Set<(event: unknown) => void | Promise<void>>;
  attachCalls: Array<{ activeSessionId: string; options: Readonly<Record<string, unknown>> }>;
  spawnCalls: Array<{ executable: string; argv: readonly string[]; options: unknown }>;
  launcherKills: number;
  launcherUnrefs: number;
  launcherExit?: readonly [number | null, string | null];
  persistCalls: ResidentSessionBinding[];
  projectionCalls: Array<{
    binding: ResidentSessionBinding;
    projection: ResidentProjectionSnapshot;
  }>;
  resourceSnapshotCalls: number;
  modelProjectionCalls: Array<{
    command: CommandEnvelope;
    binding: ResidentSessionBinding;
    projection: ResidentProjectionSnapshot;
  }>;
  waitForIdleCalls: number;
  requestHandler?: (command: Readonly<object>) => Promise<unknown> | unknown;
  waitForHelloHandler?: () => Promise<unknown> | unknown;
  closeHandler?: () => void;
  persistHandler?: (binding: ResidentSessionBinding) => Promise<void>;
  publishProjectionHandler?: (
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>;
  publishModelSelectionProjectionHandler?: (
    command: CommandEnvelope,
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ) => Promise<void>;
  snapshotHandler?: (attachmentOrdinal: number) => Promise<unknown> | unknown;
  authoritativeRoundCalls: number;
  authoritativeSnapshotHandler?: (roundOrdinal: number) => Promise<unknown> | unknown;
  authoritativeStateAfterHandler?: (
    roundOrdinal: number,
    snapshot: Readonly<Record<string, unknown>>,
  ) => Promise<unknown> | unknown;
  waitForIdleHandler?: () => Promise<void> | void;
  availableModelsCalls: number;
  setModelCalls: Array<{ providerId: string; modelId: string }>;
  promptCalls: Array<{
    message: string;
    options: Readonly<{ queueIfBusy?: boolean; signal?: AbortSignal }> | undefined;
  }>;
  abortCalls: number;
  extensionUiResponseCalls: Array<{ requestId: string; response: Readonly<Record<string, unknown>> }>;
  ephemeralProjectionChanges: ResidentSessionBinding[];
  promoteCalls: number;
  availableModelsHandler?: () => Promise<unknown> | unknown;
  setModelHandler?: (providerId: string, modelId: string) => Promise<unknown> | unknown;
  promptHandler?: (
    message: string,
    options: Readonly<{ queueIfBusy?: boolean; signal?: AbortSignal }> | undefined,
  ) => Promise<void> | void;
  abortHandler?: () => Promise<void> | void;
  extensionUiResponseHandler?: (
    requestId: string,
    response: Readonly<Record<string, unknown>>,
  ) => Promise<void> | void;
  promoteHandler?: () => Promise<void> | void;
  promoteAvailable: boolean;
  attachHandler?: (attachmentOrdinal: number) => Promise<void> | void;
  waitHandler?: (milliseconds: number) => Promise<void> | void;
  disposeHandler?: () => Promise<void>;
  recoverDuringAttach?: boolean;
  authorizeResidentKillInvocation?: ResidentKillInvocationAuthorizer;
  now?: () => Date;
}

function createHarness(overrides: Partial<HarnessState> = {}) {
  const state: HarnessState = {
    connectOutcomes: [],
    hello: validHello(),
    chronology: [],
    requests: [],
    closes: 0,
    disposeCalls: 0,
    subscribeCalls: 0,
    unsubscribeCalls: 0,
    ownedCleanupDisposeCalls: 0,
    residentDetachDisposeCalls: 0,
    eventListeners: new Set(),
    attachCalls: [],
    spawnCalls: [],
    launcherKills: 0,
    launcherUnrefs: 0,
    persistCalls: [],
    projectionCalls: [],
    resourceSnapshotCalls: 0,
    modelProjectionCalls: [],
    waitForIdleCalls: 0,
    authoritativeRoundCalls: 0,
    availableModelsCalls: 0,
    setModelCalls: [],
    promptCalls: [],
    abortCalls: 0,
    extensionUiResponseCalls: [],
    ephemeralProjectionChanges: [],
    promoteCalls: 0,
    promoteAvailable: true,
    ...overrides,
  };

  class FakeDaemonClient implements PrimeDaemonClientPublic {
    private authoritativeSnapshot: Readonly<Record<string, unknown>> | undefined;

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
      if (state.waitForHelloHandler) return state.waitForHelloHandler();
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
      if (type === "get_connection_state") {
        if (!this.authoritativeSnapshot) {
          state.authoritativeRoundCalls += 1;
          const snapshot = state.authoritativeSnapshotHandler
            ? await state.authoritativeSnapshotHandler(state.authoritativeRoundCalls)
            : validAuthoritativeSnapshot();
          if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
            return { type: "response", command: type, success: true, data: snapshot };
          }
          this.authoritativeSnapshot = snapshot as Readonly<Record<string, unknown>>;
          return { type: "response", command: type, success: true, data: this.authoritativeSnapshot.state };
        }
        const snapshot = this.authoritativeSnapshot;
        const data = state.authoritativeStateAfterHandler
          ? await state.authoritativeStateAfterHandler(state.authoritativeRoundCalls, snapshot)
          : snapshot.state;
        this.authoritativeSnapshot = undefined;
        return { type: "response", command: type, success: true, data };
      }
      if (type === "get_messages") {
        return {
          type: "response",
          command: type,
          success: true,
          data: { messages: this.authoritativeSnapshot?.messages },
        };
      }
      if (type === "get_session_context") {
        return {
          type: "response",
          command: type,
          success: true,
          data: { context: this.authoritativeSnapshot?.sessionContext },
        };
      }
      return { type: "response", command: type, success: true };
    }

    close(): void {
      state.closes += 1;
      state.chronology.push("client:close");
      state.closeHandler?.();
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
      const attachmentOrdinal = state.attachCalls.length;
      if (state.recoverDuringAttach) {
        await (options.recoverDaemon as () => Promise<void>)();
      }
      await state.attachHandler?.(attachmentOrdinal);
      let ownedSession = options.ownedSession === true;
      return {
        getInitialSnapshot: async () => {
          state.chronology.push("snapshot");
          return state.snapshotHandler
            ? state.snapshotHandler(attachmentOrdinal)
            : validSnapshot();
        },
        getResourceSnapshot: async () => {
          state.resourceSnapshotCalls += 1;
          return validResourceSnapshot();
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
        setModel: async (providerId: string, modelId: string) => {
          state.setModelCalls.push({ providerId, modelId });
          state.chronology.push(`model:set:${providerId}/${modelId}`);
          return state.setModelHandler
            ? state.setModelHandler(providerId, modelId)
            : { provider: providerId, id: modelId, rawCredential: "discarded" };
        },
        prompt: async (
          message: string,
          options: Readonly<{ queueIfBusy?: boolean; signal?: AbortSignal }> | undefined,
        ) => {
          state.promptCalls.push({ message, options });
          state.chronology.push("prompt");
          await state.promptHandler?.(message, options);
        },
        abort: async () => {
          state.abortCalls += 1;
          state.chronology.push("abort");
          await state.abortHandler?.();
        },
        respondToExtensionUiRequest: async (
          requestId: string,
          response: Readonly<Record<string, unknown>>,
        ) => {
          state.extensionUiResponseCalls.push({ requestId, response });
          await state.extensionUiResponseHandler?.(requestId, response);
        },
        promoteToResident: state.promoteAvailable
          ? async () => {
              state.promoteCalls += 1;
              state.chronology.push("promote");
              await state.promoteHandler?.();
              ownedSession = false;
            }
          : undefined,
        subscribe: (listener: (event: unknown) => void | Promise<void>) => {
          state.subscribeCalls += 1;
          state.eventListeners.add(listener);
          return () => {
            state.unsubscribeCalls += 1;
            state.eventListeners.delete(listener);
          };
        },
        dispose: async () => {
          state.disposeCalls += 1;
          if (ownedSession) state.ownedCleanupDisposeCalls += 1;
          else state.residentDetachDisposeCalls += 1;
          state.chronology.push("dispose");
          await state.disposeHandler?.();
        },
      } as unknown as PrimeDaemonAgentConnectionPublic;
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
    hostId: "host-local",
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
    publishProjection: async (projectionBinding, projection) => {
      state.projectionCalls.push({ binding: projectionBinding, projection });
      state.chronology.push("projection:publish");
      await state.publishProjectionHandler?.(projectionBinding, projection);
    },
    publishModelSelectionProjection: async (command, projectionBinding, projection) => {
      state.projectionCalls.push({ binding: projectionBinding, projection });
      state.modelProjectionCalls.push({ command, binding: projectionBinding, projection });
      state.chronology.push("projection:model-selection:publish");
      if (state.publishModelSelectionProjectionHandler) {
        await state.publishModelSelectionProjectionHandler(command, projectionBinding, projection);
      }
    },
    publishEphemeralProjectionChange: (projectionBinding) => {
      state.ephemeralProjectionChanges.push(projectionBinding);
    },
    authorizeResidentKillInvocation: state.authorizeResidentKillInvocation,
    spawnFactory: (executable, argv, options) => {
      state.spawnCalls.push({ executable, argv, options });
      state.chronology.push("spawn");
      return launcher;
    },
    connectTimeoutMs: 10,
    startupTimeoutMs: 100,
    requestTimeoutMs: 100,
    wait: async (milliseconds) => void (await state.waitHandler?.(milliseconds)),
    now: state.now ?? (() => new Date("2026-08-06T17:00:00.000Z")),
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
    workspaceDirectory: WORKSPACE_DIRECTORY,
    sessionName: "Prime Continuim",
  } as const;
}

function ownedInput() {
  return {
    threadId: "thread-owned-1",
    executionGenerationId: "generation-owned-1",
    workspaceDirectory: WORKSPACE_DIRECTORY,
    session: { kind: "new" },
    sessionName: "Prime Continuim",
  } as const;
}

function ownedResumeInput() {
  return {
    threadId: "thread-owned-1",
    executionGenerationId: "generation-owned-1",
    workspaceDirectory: WORKSPACE_DIRECTORY,
    session: { kind: "resume", sessionPath: SESSION_FILE },
  } as const;
}

function binding(overrides: Partial<ResidentSessionBinding> = {}): ResidentSessionBinding {
  return {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId: "thread-1",
    executionGenerationId: "generation-1",
    workspaceDirectory: WORKSPACE_DIRECTORY,
    activeSessionId: "active-1",
    sessionId: "session-1",
    sessionFile: SESSION_FILE,
    boundAt: "2026-08-06T16:00:00.000Z",
    runtime: validateResidentDaemonHello(validHello()),
    ...overrides,
  };
}

async function issueResidentKillLease(
  operationId = "resident-end-adapter",
  bindingOverrides: Partial<ResidentSessionBinding> = {},
): Promise<{ store: HostStore; lease: ResidentKillLease; binding: ResidentSessionBinding }> {
  const directory = await canonicalTemporaryDirectory("prime-adapter-end-");
  temporaryDirectories.push(directory);
  const workspaceDirectory = join(directory, "workspace");
  await mkdir(workspaceDirectory);
  const store = new HostStore(directory);
  await store.initialize();
  await bootstrapTestWorkspace(store, { workspaceDirectory });
  const host = await store.getHost();
  const snapshot = await store.getThreadSnapshot("test-thread");
  const canonicalWorkspace = await store.registerWorkspaceAuthority({
    threadId: snapshot.thread.threadId,
    executionGenerationId: snapshot.thread.currentLocation.executionGenerationId,
    workspaceDirectory,
  });
  const durableBinding = binding({
    threadId: snapshot.thread.threadId,
    executionGenerationId: snapshot.thread.currentLocation.executionGenerationId,
    workspaceDirectory: canonicalWorkspace,
    ...bindingOverrides,
  });
  await store.persistResidentSessionBinding(durableBinding);
  const input = {
    operationId,
    expectedHostId: host.hostId,
    projectId: snapshot.thread.currentLocation.projectId,
    workspaceId: snapshot.thread.currentLocation.workspaceId,
    threadId: durableBinding.threadId,
    executionGenerationId: durableBinding.executionGenerationId,
    requestDigest: "e".repeat(64),
    expectedSourceCursor: snapshot.latestCursor,
  } as const;
  await store.prepareResidentEnd(input, durableBinding);
  const lease = await store.beginResidentKill(input);
  return { store, lease, binding: durableBinding };
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
  settlementCursor: Readonly<{ generation?: string; sequence?: number }> = {},
): ResidentPromptIdleReconciliationRequest {
  return validateResidentPromptIdleReconciliationRequest({
    reconciliationVersion: 1,
    dispatchAttemptId,
    binding: durableBinding,
    settlementCursor: {
      threadId: durableBinding.threadId,
      executionGenerationId: durableBinding.executionGenerationId,
      generation: settlementCursor.generation ?? "events-1",
      sequence: settlementCursor.sequence ?? 4,
    },
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

    await expect(adapter.ensureDaemon(invocation)).resolves.toMatchObject({ appVersion: "0.7.2" });

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
          env: {
            Path: "C:\\Windows",
            ELECTRON_RUN_AS_NODE: "1",
            PYTHONDONTWRITEBYTECODE: "1",
            PRIME_AGENT_TELEMETRY: "0",
            DO_NOT_TRACK: "1",
          },
          stdio: "ignore",
        },
      },
    ]);
    expect(state.launcherKills).toBe(0);
    expect(state.launcherUnrefs).toBe(1);
    await adapter.close();
  });

  it("gracefully retires a structurally verified incompatible daemon before launching its replacement", async () => {
    let state!: HarnessState;
    const harness = createHarness({
      hello: incompatibleUpgradeHello(),
      connectOutcomes: ["ok", "fail", "ok", "ok"],
      requestHandler: (command) => {
        if ((command as { type?: string }).type === "list") {
          return {
            type: "response",
            command: "list",
            success: true,
            data: { sessions: [], busyClientOwnedSessionCount: 0 },
          };
        }
        if ((command as { type?: string }).type !== "shutdown") throw new Error("unexpected request");
        state.hello = validHello();
        return { type: "response", command: "shutdown", success: true };
      },
    });
    state = harness.state;
    const invocation = buildHarnessInvocation();

    const results = await Promise.all([
      harness.adapter.ensureDaemon(invocation),
      harness.adapter.ensureDaemon(invocation),
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ appVersion: "0.7.2" });
    expect(results[1]).toMatchObject({ appVersion: "0.7.2" });
    expect(state.requests).toEqual([
      { type: "list", includeClientOwned: true },
      { type: "shutdown" },
    ]);
    expect(state.requests[1]).not.toHaveProperty("force");
    expect(state.spawnCalls).toHaveLength(1);
    expect(harness.adapter.getLifecycle().state).toBe("ready");
    await harness.adapter.close();
  });

  it("preserves an incompatible daemon when its exact list still contains an active session", async () => {
    const { adapter, state } = createHarness({
      hello: incompatibleUpgradeHello(),
      requestHandler: (command) => {
        if ((command as { type?: string }).type !== "list") throw new Error("shutdown must not be requested");
        return {
          type: "response",
          command: "list",
          success: true,
          data: { sessions: [liveSummary()], busyClientOwnedSessionCount: 0 },
        };
      },
    });
    const invocation = buildHarnessInvocation();

    const error = await expectRuntimeError(
      adapter.ensureDaemon(invocation),
      "PRIME_RUNTIME_DAEMON_RETIREMENT_FAILED",
    );

    expect(error.details).toMatchObject({
      reason: "sessions_present",
      sessionCount: 1,
      busyClientOwnedSessionCount: 0,
    });
    expect(state.requests).toEqual([{ type: "list", includeClientOwned: true }]);
    expect(state.spawnCalls).toHaveLength(0);
    await adapter.close();
  });

  it("preserves an incompatible daemon when hidden client-owned work is reported busy", async () => {
    const { adapter, state } = createHarness({
      hello: incompatibleUpgradeHello(),
      requestHandler: (command) => {
        if ((command as { type?: string }).type !== "list") throw new Error("shutdown must not be requested");
        return {
          type: "response",
          command: "list",
          success: true,
          data: { sessions: [], busyClientOwnedSessionCount: 1 },
        };
      },
    });

    const error = await expectRuntimeError(
      adapter.ensureDaemon(buildHarnessInvocation()),
      "PRIME_RUNTIME_DAEMON_RETIREMENT_FAILED",
    );

    expect(error.details).toMatchObject({
      reason: "sessions_present",
      sessionCount: 0,
      busyClientOwnedSessionCount: 1,
    });
    expect(state.requests).toEqual([{ type: "list", includeClientOwned: true }]);
    expect(state.spawnCalls).toHaveLength(0);
    await adapter.close();
  });

  it.each([
    ["invalid", () => ({ type: "response", command: "list", success: true, data: { sessions: "unknown" } })],
    ["timeout", () => { throw new Error("Timed out waiting for list response"); }],
  ])("preserves an incompatible daemon when its session inventory is %s", async (_label, listResponse) => {
    const { adapter, state } = createHarness({
      hello: incompatibleUpgradeHello(),
      requestHandler: (command) => {
        if ((command as { type?: string }).type !== "list") throw new Error("shutdown must not be requested");
        return listResponse();
      },
    });

    const error = await expectRuntimeError(
      adapter.ensureDaemon(buildHarnessInvocation()),
      "PRIME_RUNTIME_DAEMON_RETIREMENT_FAILED",
    );

    expect(error.details).toMatchObject({ reason: "session_inventory_unproven" });
    expect(state.requests).toEqual([{ type: "list", includeClientOwned: true }]);
    expect(state.spawnCalls).toHaveLength(0);
    await adapter.close();
  });

  it("preserves an incompatible daemon when exact owner identity changes after the empty list proof", async () => {
    let state!: HarnessState;
    const harness = createHarness({
      hello: incompatibleUpgradeHello(),
      requestHandler: (command) => {
        if ((command as { type?: string }).type !== "list") throw new Error("shutdown must not be requested");
        state.hello = incompatibleUpgradeHello({ supervisorGeneration: "supervisor-replaced" });
        return {
          type: "response",
          command: "list",
          success: true,
          data: { sessions: [], busyClientOwnedSessionCount: 0 },
        };
      },
    });
    state = harness.state;

    const error = await expectRuntimeError(
      harness.adapter.ensureDaemon(buildHarnessInvocation()),
      "PRIME_RUNTIME_DAEMON_RETIREMENT_FAILED",
    );

    expect(error.details).toMatchObject({ reason: "owner_identity_changed" });
    expect(state.requests).toEqual([{ type: "list", includeClientOwned: true }]);
    expect(state.spawnCalls).toHaveLength(0);
    await harness.adapter.close();
  });

  it("preserves an empty incompatible daemon that refuses graceful shutdown", async () => {
    const { adapter, state } = createHarness({
      hello: incompatibleUpgradeHello(),
      requestHandler: (command) => (command as { type?: string }).type === "list"
        ? {
            type: "response",
            command: "list",
            success: true,
            data: { sessions: [], busyClientOwnedSessionCount: 0 },
          }
        : {
            type: "response",
            command: "shutdown",
            success: false,
            error: "shutdown refused",
          },
    });

    const error = await expectRuntimeError(
      adapter.ensureDaemon(buildHarnessInvocation()),
      "PRIME_RUNTIME_DAEMON_RETIREMENT_FAILED",
    );

    expect(error.details).toMatchObject({ reason: "shutdown_refused" });
    expect(state.requests).toEqual([
      { type: "list", includeClientOwned: true },
      { type: "shutdown" },
    ]);
    expect(state.spawnCalls).toHaveLength(0);
    await adapter.close();
  });

  it("accepts observed endpoint retirement when the graceful shutdown acknowledgement is dropped", async () => {
    let state!: HarnessState;
    const harness = createHarness({
      hello: incompatibleUpgradeHello(),
      connectOutcomes: ["ok", "fail", "ok"],
      requestHandler: (command) => {
        if ((command as { type?: string }).type === "list") {
          return {
            type: "response",
            command: "list",
            success: true,
            data: { sessions: [], busyClientOwnedSessionCount: 0 },
          };
        }
        state.hello = validHello();
        throw new Error("connection closed before shutdown acknowledgement");
      },
    });
    state = harness.state;
    const invocation = buildHarnessInvocation();

    await expect(harness.adapter.ensureDaemon(invocation)).resolves.toMatchObject({ appVersion: "0.7.2" });

    expect(state.requests).toEqual([
      { type: "list", includeClientOwned: true },
      { type: "shutdown" },
    ]);
    expect(state.spawnCalls).toHaveLength(1);
    await harness.adapter.close();
  });

  it("does not launch when an incompatible daemon keeps accepting connections after shutdown", async () => {
    const { adapter, state } = createHarness({
      hello: incompatibleUpgradeHello(),
      requestHandler: (command) => (command as { type?: string }).type === "list"
        ? {
            type: "response",
            command: "list",
            success: true,
            data: { sessions: [], busyClientOwnedSessionCount: 0 },
          }
        : { type: "response", command: "shutdown", success: true },
    });
    const invocation = buildHarnessInvocation();

    const error = await expectRuntimeError(
      adapter.ensureDaemon(invocation),
      "PRIME_RUNTIME_DAEMON_RETIREMENT_FAILED",
    );

    expect(error.details).toMatchObject({
      reason: "endpoint_retirement_unproven",
      shutdownAcknowledged: true,
    });
    expect(state.requests).toEqual([
      { type: "list", includeClientOwned: true },
      { type: "shutdown" },
    ]);
    expect(state.spawnCalls).toHaveLength(0);
    await adapter.close();
  });

  it.each([
    ["missing client identity", { clientId: undefined }],
    ["different endpoint", { socketPath: resolve(tmpdir(), "other-prime-continuim.sock") }],
    ["missing supervisor owner", { supervisorOwnerToken: undefined }],
  ])("never targets an incompatible handshake with %s", async (_label, helloOverride) => {
    const { adapter, state } = createHarness({
      hello: incompatibleUpgradeHello(helloOverride),
    });
    const invocation = buildHarnessInvocation();

    await expectRuntimeError(adapter.ensureDaemon(invocation), "PRIME_RUNTIME_HELLO_INVALID");

    expect(state.requests).toHaveLength(0);
    expect(state.spawnCalls).toHaveLength(0);
    await adapter.close();
  });

  it("does not launch over an indeterminate endpoint timeout", async () => {
    const { adapter, state } = createHarness({ connectOutcomes: ["timeout"] });
    const invocation = buildHarnessInvocation();

    await expectRuntimeError(adapter.ensureDaemon(invocation), "PRIME_RUNTIME_UNAVAILABLE");

    expect(state.spawnCalls).toHaveLength(0);
    await adapter.close();
  });

  it("never requests retirement when a connected endpoint times out before a verified hello", async () => {
    const { adapter, state } = createHarness({
      hello: undefined,
      waitForHelloHandler: () => {
        throw new Error("Timed out waiting for daemon hello");
      },
    });
    const invocation = buildHarnessInvocation();

    await expectRuntimeError(adapter.ensureDaemon(invocation), "PRIME_RUNTIME_HELLO_INVALID");

    expect(state.requests).toHaveLength(0);
    expect(state.spawnCalls).toHaveLength(0);
    await adapter.close();
  });

  it("accepts a valid external winner even when the local launcher exits nonzero", async () => {
    const { adapter, state } = createHarness({
      connectOutcomes: ["fail", "fail", "ok"],
      launcherExit: [1, null],
    });
    const invocation = buildHarnessInvocation();

    await expect(adapter.ensureDaemon(invocation)).resolves.toMatchObject({ appVersion: "0.7.2" });

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

describe("PrimeAgentResidentAdapter client-owned escrow", () => {
  it("creates and attaches one exact client-owned candidate without durable resident side effects", async () => {
    const { adapter, state } = createHarness();

    const candidate = await adapter.createOwnedCandidate(ownedInput());

    expect(state.requests).toEqual([{
      type: "create",
      config: { cwd: WORKSPACE_DIRECTORY, telemetryDisabled: true },
      lifecycle: "client_owned",
      noSession: false,
      name: "Prime Continuim",
    }]);
    expect(state.attachCalls).toHaveLength(1);
    expect(state.attachCalls[0]).toMatchObject({
      activeSessionId: "active-1",
      options: {
        closeClientOnDispose: true,
        sendClientEnv: false,
        supportsExtensionUi: true,
        ownedSession: true,
        telemetryDisabled: true,
      },
    });
    expect(candidate).toMatchObject({
      candidateVersion: 1,
      threadId: "thread-owned-1",
      executionGenerationId: "generation-owned-1",
      workspaceDirectory: WORKSPACE_DIRECTORY,
      activeSessionId: "active-1",
      sessionId: "session-1",
      sessionFile: SESSION_FILE,
      boundAt: "2026-08-06T17:00:00.000Z",
      runtime: { runtimeBuildId: "83a0f9f-dirty" },
    });
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.runtime)).toBe(true);
    expect(Object.isFrozen(candidate.runtime.capabilities)).toBe(true);
    expect(Reflect.ownKeys(candidate).some((key) => typeof key === "symbol")).toBe(true);
    expect(structuredClone(candidate)).toEqual({ candidateVersion: 1 });
    expect(structuredClone(candidate)).not.toHaveProperty("promoteToResident");
    expect(state.persistCalls).toHaveLength(0);
    expect(state.projectionCalls).toHaveLength(0);

    const cleanupAttempt = candidate.attemptUnverifiedOwnedCleanup();
    expect(candidate.attemptUnverifiedOwnedCleanup()).toBe(cleanupAttempt);
    const disposal = candidate.dispose();
    const cleanupResult = await cleanupAttempt;
    expect(cleanupResult).toEqual({
      disposition: "attempted_unverified",
      durableCompletionAuthorized: false,
      reason: "prime_v0_7_dispose_suppresses_complete_response",
    });
    expect(Object.isFrozen(cleanupResult)).toBe(true);
    expect(cleanupResult).not.toHaveProperty("proof");
    await disposal;
    expect(candidate.attemptUnverifiedOwnedCleanup()).toBe(cleanupAttempt);
    expect(state.disposeCalls).toBe(1);
    expect(state.ownedCleanupDisposeCalls).toBe(1);
    expect(state.residentDetachDisposeCalls).toBe(0);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await adapter.close();
    expect(state.disposeCalls).toBe(1);
  });

  it("quarantines success:false create because Prime may have already registered a worker", async () => {
    const { adapter, state } = createHarness({
      requestHandler: (command) => ({
        type: "response",
        command: (command as { type?: string }).type ?? "unknown",
        success: false,
        error: "Session is already active under another daemon client",
      }),
    });

    const error = await expectRuntimeError(
      adapter.createOwnedCandidate(ownedResumeInput()),
      "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    );

    expect(error).toMatchObject({ retryable: false });
    expect(error.details).toMatchObject({
      command: "create",
      phase: "create_response_unverified",
      outcome: "unknown",
      cleanup: "owner_transport_closed",
      failureCode: "PRIME_RUNTIME_REQUEST_FAILED",
    });
    expect(state.requests).toHaveLength(1);
    expect(state.attachCalls).toHaveLength(0);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await adapter.close();
  });

  it("quarantines post-create local validation even after best-effort owned disposal", async () => {
    const { adapter, state } = createHarness({ promoteAvailable: false });

    const error = await expectRuntimeError(
      adapter.createOwnedCandidate(ownedInput()),
      "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    );

    expect(error).toMatchObject({ retryable: false });
    expect(error.details).toMatchObject({
      command: "create",
      phase: "validating_owned_connection",
      outcome: "unknown",
      activeSessionId: "active-1",
      cleanup: "public_owned_dispose_unverified",
      failureCode: "PRIME_RUNTIME_MODULE_INVALID",
    });
    expect(state.requests.map((request) => (request as { type?: string }).type)).toEqual(["create"]);
    expect(state.attachCalls).toHaveLength(1);
    expect(state.disposeCalls).toBe(1);
    expect(state.ownedCleanupDisposeCalls).toBe(1);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await adapter.close();
  });

  it("quarantines an owned attach failure after the daemon accepted create", async () => {
    const { adapter, state } = createHarness({
      attachHandler: () => {
        throw new Error("attach transport failed");
      },
    });

    const error = await expectRuntimeError(
      adapter.createOwnedCandidate(ownedInput()),
      "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    );

    expect(error).toMatchObject({ retryable: false });
    expect(error.details).toMatchObject({
      command: "create",
      phase: "attaching_owned_connection",
      outcome: "unknown",
      activeSessionId: "active-1",
      cleanup: "owner_transport_closed",
    });
    expect(state.attachCalls).toHaveLength(1);
    expect(state.disposeCalls).toBe(0);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await adapter.close();
  });

  it("rejects a daemon summary that drifts from the exact imported session path", async () => {
    const { adapter, state } = createHarness({
      requestHandler: (command) => ({
        type: "response",
        command: (command as { type?: string }).type ?? "unknown",
        success: true,
        data: liveSummary({ sessionFile: OTHER_SESSION_FILE }),
      }),
    });

    const error = await expectRuntimeError(
      adapter.createOwnedCandidate(ownedResumeInput()),
      "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    );

    expect(error).toMatchObject({ retryable: false });
    expect(error.details).toMatchObject({
      command: "create",
      phase: "validating_create_identity",
      outcome: "unknown",
      activeSessionId: "active-1",
      cleanup: "owner_transport_closed",
      failureCode: "PRIME_RUNTIME_SESSION_MISMATCH",
    });
    expect(state.attachCalls).toHaveLength(0);
    expect(state.requests).toHaveLength(1);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await adapter.close();
  });

  it("rejects ambiguous owned input definitively before connecting or mutating", async () => {
    const { adapter, state } = createHarness();

    await expectRuntimeError(
      adapter.createOwnedCandidate({
        ...ownedInput(),
        session: { kind: "continue_recent" },
      } as never),
      "PRIME_RUNTIME_ARGUMENT_INVALID",
    );
    await expectRuntimeError(
      adapter.createOwnedCandidate({
        ...ownedResumeInput(),
        sessionName: "Renamed before promotion",
      } as never),
      "PRIME_RUNTIME_ARGUMENT_INVALID",
    );

    expect(state.chronology).toEqual([]);
    expect(state.requests).toHaveLength(0);
    expect(state.attachCalls).toHaveLength(0);
    await adapter.close();
  });

  it("classifies a lost owned create response as unknown and never replays or root-kills it", async () => {
    const { adapter, state } = createHarness({
      requestHandler: (command) => {
        if ((command as { type?: string }).type === "create") throw new Error("create response lost");
        return { type: "response", command: "unknown", success: true };
      },
    });

    const error = await expectRuntimeError(
      adapter.createOwnedCandidate(ownedInput()),
      "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    );

    expect(error).toMatchObject({ retryable: false });
    expect(error.details).toMatchObject({ command: "create", outcome: "unknown" });
    expect(state.requests).toHaveLength(1);
    expect(state.attachCalls).toHaveLength(0);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await adapter.close();
  });

  it("treats a malformed create response as unknown rather than a definitive rejection", async () => {
    const { adapter, state } = createHarness({
      requestHandler: () => ({
        type: "response",
        command: "list",
        success: true,
        data: { sessions: [] },
      }),
    });

    const error = await expectRuntimeError(
      adapter.createOwnedCandidate(ownedInput()),
      "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    );

    expect(error).toMatchObject({ retryable: false });
    expect(error.details).toMatchObject({
      command: "create",
      phase: "create_response_unverified",
      outcome: "unknown",
      cleanup: "owner_transport_closed",
    });
    expect(state.requests).toHaveLength(1);
    expect(state.attachCalls).toHaveLength(0);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await adapter.close();
  });

  it("promotes exactly once, preserves boundAt, publishes stable state, then detaches as resident", async () => {
    const { adapter, state } = createHarness();
    const candidate = await adapter.createOwnedCandidate(ownedInput());
    const proposedBoundAt = candidate.boundAt;

    const first = candidate.promoteToResident();
    const duplicate = candidate.promoteToResident();
    expect(duplicate).toBe(first);
    await first;

    let publishedBinding: ResidentSessionBinding | undefined;
    let publishedProjection: ResidentProjectionSnapshot | undefined;
    const projection = await candidate.publishStableProjection(async (durableBinding, stableProjection) => {
      publishedBinding = durableBinding;
      publishedProjection = stableProjection;
    });

    expect(state.promoteCalls).toBe(1);
    expect(publishedBinding).toMatchObject({
      lifecycle: "resident",
      threadId: "thread-owned-1",
      executionGenerationId: "generation-owned-1",
      activeSessionId: "active-1",
      sessionId: "session-1",
      boundAt: proposedBoundAt,
    });
    expect(publishedProjection).toBe(projection);
    expect(projection).toMatchObject({
      identity: {
        activeSessionId: "active-1",
        sessionId: "session-1",
        workspaceDirectory: WORKSPACE_DIRECTORY,
      },
      cursor: { generation: "events-1", sequence: 4 },
    });
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(2);
    await expectRuntimeError(
      candidate.attemptUnverifiedOwnedCleanup(),
      "PRIME_RUNTIME_TERMINAL_ACTION_CONFLICT",
    );

    await candidate.dispose();
    expect(state.disposeCalls).toBe(1);
    expect(state.ownedCleanupDisposeCalls).toBe(0);
    expect(state.residentDetachDisposeCalls).toBe(1);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await adapter.close();
  });

  it("does not publish or claim readiness after four changing post-promotion reads", async () => {
    let sequence = 0;
    const { adapter, state } = createHarness({
      snapshotHandler: () => validSnapshot({ cursorSequence: ++sequence }),
    });
    const candidate = await adapter.createOwnedCandidate(ownedInput());
    await candidate.promoteToResident();
    const publisher = vi.fn(async () => undefined);

    await expectRuntimeError(
      candidate.publishStableProjection(publisher),
      "PRIME_RUNTIME_RESPONSE_INVALID",
    );

    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(4);
    expect(publisher).not.toHaveBeenCalled();
    expect(state.projectionCalls).toHaveLength(0);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await candidate.dispose();
    await adapter.close();
  });

  it("keeps a promoted resident alive when durable projection publication fails locally", async () => {
    const { adapter, state } = createHarness();
    const candidate = await adapter.createOwnedCandidate(ownedInput());
    await candidate.promoteToResident();

    const error = await expectRuntimeError(
      candidate.publishStableProjection(async () => {
        throw new Error("lifecycle WAL unavailable");
      }),
      "PRIME_RUNTIME_PROJECTION_PERSIST_FAILED",
    );

    expect(error.retryable).toBe(true);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await candidate.dispose();
    expect(state.residentDetachDisposeCalls).toBe(1);
    expect(state.ownedCleanupDisposeCalls).toBe(0);
    await adapter.close();
  });

  it("retains unknown promotion truth across late settlement and best-effort dispose", async () => {
    const promotionGate = deferred();
    const { adapter, state } = createHarness({
      promoteHandler: () => promotionGate.promise,
    });
    const candidate = await adapter.createOwnedCandidate(ownedInput());
    const proposedBoundAt = candidate.boundAt;

    const first = candidate.promoteToResident();
    const duplicate = candidate.promoteToResident();
    expect(duplicate).toBe(first);
    const error = await expectRuntimeError(first, "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN");
    expect(error).toMatchObject({ retryable: false });
    expect(error.details).toMatchObject({
      command: "promote_owned_session",
      activeSessionId: "active-1",
      outcome: "unknown",
    });
    expect(state.promoteCalls).toBe(1);
    expect(candidate.boundAt).toBe(proposedBoundAt);
    const cleanupError = await expectRuntimeError(
      candidate.attemptUnverifiedOwnedCleanup(),
      "PRIME_RUNTIME_TERMINAL_ACTION_CONFLICT",
    );
    expect(cleanupError.details).toMatchObject({ state: "promotion_unknown" });

    const closesBeforeAbandon = state.closes;
    await candidate.dispose();
    expect(state.disposeCalls).toBe(0);
    expect(state.ownedCleanupDisposeCalls).toBe(0);
    expect(state.residentDetachDisposeCalls).toBe(0);
    expect(state.closes).toBe(closesBeforeAbandon + 1);
    promotionGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await expectRuntimeError(candidate.promoteToResident(), "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN");
    const postDisposeCleanup = await expectRuntimeError(
      candidate.attemptUnverifiedOwnedCleanup(),
      "PRIME_RUNTIME_TERMINAL_ACTION_CONFLICT",
    );
    expect(postDisposeCleanup.details).toMatchObject({ state: "promotion_unknown" });
    expect(state.promoteCalls).toBe(1);
    expect(state.disposeCalls).toBe(0);
    expect(state.ownedCleanupDisposeCalls).toBe(0);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await adapter.close();
    expect(state.disposeCalls).toBe(0);
  });

  it("adapter close abandons promotion-unknown transport without owned cleanup", async () => {
    const promotionGate = deferred();
    const { adapter, state } = createHarness({
      promoteHandler: () => promotionGate.promise,
    });
    const candidate = await adapter.createOwnedCandidate(ownedInput());
    await expectRuntimeError(
      candidate.promoteToResident(),
      "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    );

    const closesBeforeAbandon = state.closes;
    await adapter.close();
    expect(state.disposeCalls).toBe(0);
    expect(state.ownedCleanupDisposeCalls).toBe(0);
    expect(state.residentDetachDisposeCalls).toBe(0);
    expect(state.closes).toBe(closesBeforeAbandon + 1);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);

    promotionGate.resolve();
    await Promise.resolve();
    const cleanupError = await expectRuntimeError(
      candidate.attemptUnverifiedOwnedCleanup(),
      "PRIME_RUNTIME_TERMINAL_ACTION_CONFLICT",
    );
    expect(cleanupError.details).toMatchObject({ state: "promotion_unknown" });
    expect(state.disposeCalls).toBe(0);
  });
});

describe("PrimeAgentResidentAdapter extension UI", () => {
  it("normalizes only the four bounded dialog methods on their exact live attachment", async () => {
    const { adapter, emit } = createHarness();
    await adapter.attachResident(binding());
    const dialogs = [
      { id: "request-select", method: "select", payload: { title: "Choose", options: ["A", "B"] } },
      { id: "request-confirm", method: "confirm", payload: { title: "Continue?", message: "Run it", timeout: 5_000 } },
      { id: "request-input", method: "input", payload: { title: "Name", placeholder: "value" } },
      { id: "request-editor", method: "editor", payload: { title: "Edit", prefill: "line one" } },
    ] as const;
    for (const request of dialogs) await emit({ type: "extension_ui_request", request });
    await emit({
      type: "extension_ui_request",
      request: { id: "request-notify", method: "notify", payload: { message: "ignored" } },
    });

    const requests = adapter.listResidentExtensionUiRequests(binding());
    expect(requests.map((request) => request.method)).toEqual(["select", "confirm", "input", "editor"]);
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hostId: "host-local",
        threadId: "thread-1",
        executionGenerationId: "generation-1",
        requestId: "request-select",
        method: "select",
        options: ["A", "B"],
      }),
      expect.objectContaining({ requestId: "request-confirm", method: "confirm", timeoutMs: 5_000 }),
    ]));
    expect(requests.every((request) => /^[a-f0-9]{64}$/.test(request.requestDigest))).toBe(true);
    expect(requests.every((request) => /^[a-f0-9]{64}$/.test(request.bindingFingerprint))).toBe(true);
  });

  it("keeps the first timestamp for duplicate events and retires timed-out dialog truthfully", async () => {
    let current = new Date("2026-08-06T17:00:00.000Z");
    const { adapter, emit, state } = createHarness({ now: () => current });
    const connection = await adapter.attachResident(binding());
    const request = {
      id: "request-timeout",
      method: "input",
      payload: { title: "Value", timeout: 1_000 },
    } as const;
    await emit({ type: "extension_ui_request", request });
    current = new Date("2026-08-06T17:00:00.500Z");
    await emit({ type: "extension_ui_request", request });
    expect(adapter.listResidentExtensionUiRequests(binding())).toHaveLength(1);
    const liveRequest = adapter.listResidentExtensionUiRequests(binding())[0];
    expect(liveRequest?.receivedAt).toBe("2026-08-06T17:00:00.000Z");

    current = new Date("2026-08-06T17:00:01.000Z");
    expect(adapter.listResidentExtensionUiRequests(binding())).toEqual([]);
    if (!liveRequest) throw new Error("timed dialog fixture missing");
    await expect(connection.respondToExtensionUiRequest(liveRequest, { kind: "value", value: "late" }))
      .rejects.toMatchObject({ code: "PRIME_RUNTIME_DISPATCH_AUTHORITY_CHANGED" });
    expect(state.extensionUiResponseCalls).toEqual([]);
    await emit({ type: "extension_ui_request", request });
    expect(await adapter.isLive("thread-1", "generation-1")).toBe(true);
    expect(adapter.listResidentExtensionUiRequests(binding())).toEqual([]);
    await emit({
      type: "extension_ui_request",
      request: { ...request, payload: { ...request.payload, title: "Changed" } },
    });
    expect(await adapter.isLive("thread-1", "generation-1")).toBe(false);
  });

  it("publishes dialog expiry even when no projection read occurs", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, emit, state } = createHarness();
      await adapter.attachResident(binding());
      await emit({
        type: "extension_ui_request",
        request: { id: "request-timer", method: "input", payload: { title: "Value", timeout: 1_000 } },
      });
      expect(adapter.listResidentExtensionUiRequests(binding())).toHaveLength(1);
      expect(state.ephemeralProjectionChanges).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(adapter.listResidentExtensionUiRequests(binding())).toEqual([]);
      expect(state.ephemeralProjectionChanges).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires queued dialogs synchronously before invoking either upstream response", async () => {
    const firstResponse = deferred();
    const { adapter, emit, state } = createHarness({
      extensionUiResponseHandler: async (requestId) => {
        if (requestId === "request-a") await firstResponse.promise;
      },
    });
    const connection = await adapter.attachResident(binding());
    await emit({
      type: "extension_ui_request",
      request: { id: "request-a", method: "input", payload: { title: "First" } },
    });
    await emit({
      type: "extension_ui_request",
      request: { id: "request-b", method: "input", payload: { title: "Second" } },
    });
    const [requestA, requestB] = connection.listExtensionUiRequests();
    if (!requestA || !requestB) throw new Error("extension UI queue fixture missing");

    const responseA = connection.respondToExtensionUiRequest(requestA, { kind: "value", value: "A" });
    expect(connection.listExtensionUiRequests().map((request) => request.requestId)).toEqual(["request-b"]);
    await vi.waitFor(() => expect(state.extensionUiResponseCalls.map((call) => call.requestId)).toEqual(["request-a"]));

    const responseB = connection.respondToExtensionUiRequest(requestB, { kind: "value", value: "B" });
    expect(connection.listExtensionUiRequests()).toEqual([]);
    expect(state.extensionUiResponseCalls.map((call) => call.requestId)).toEqual(["request-a"]);

    firstResponse.resolve();
    await expect(Promise.all([responseA, responseB])).resolves.toEqual([undefined, undefined]);
    expect(state.extensionUiResponseCalls.map((call) => call.requestId)).toEqual(["request-a", "request-b"]);
  });
});

describe("PrimeAgentResidentAdapter session lifecycle", () => {
  it("accepts only one exact Store lease and invokes one independent list-fenced root kill", async () => {
    const authority = await issueResidentKillLease();
    const { adapter, state } = createHarness({
      authorizeResidentKillInvocation: (lease) => authority.store.authorizeResidentKillInvocation(lease),
      requestHandler: async (command) => {
        const type = (command as { type?: string }).type ?? "unknown";
        if (type === "list") {
          return {
            type: "response",
            command: "list",
            success: true,
            data: { sessions: [liveSummary({ cwd: authority.binding.workspaceDirectory })] },
          };
        }
        return { type: "response", command: type, success: true };
      },
    });

    await expect(adapter.endResidentSession(authority.lease)).resolves.toEqual({
      acknowledgementVersion: 1,
      operation: "end",
      activeSessionId: authority.binding.activeSessionId,
      sessionId: authority.binding.sessionId,
    });
    await expect(adapter.endResidentSession(authority.lease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_LIFECYCLE_AUTHORITY_INVALID",
    });
    expect(state.requests.map((request) => (request as { type?: string }).type)).toEqual([
      "list",
      "kill",
      "list",
    ]);
    expect(state.attachCalls).toHaveLength(0);
    await adapter.close();
  });

  it("ends an exact promoted empty draft that Prime keeps list-visible as a ready resident worker", async () => {
    const authority = await issueResidentKillLease("resident-end-promoted-draft");
    const authorize = vi.fn((lease: ResidentKillLease) =>
      authority.store.authorizeResidentKillInvocation(lease));
    const { adapter, state } = createHarness({
      authorizeResidentKillInvocation: authorize,
      requestHandler: async (command) => {
        const type = (command as { type?: string }).type ?? "unknown";
        if (type === "list") {
          return {
            type: "response",
            command: "list",
            success: true,
            data: {
              sessions: [liveSummary({
                lifecycle: "draft",
                workerState: "ready",
                attachedClients: 0,
                messageCount: 0,
                cwd: authority.binding.workspaceDirectory,
              })],
            },
          };
        }
        return { type: "response", command: type, success: true };
      },
    });

    await expect(adapter.endResidentSession(authority.lease)).resolves.toMatchObject({
      operation: "end",
      activeSessionId: authority.binding.activeSessionId,
      sessionId: authority.binding.sessionId,
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(state.requests.map((request) => (request as { type?: string }).type)).toEqual(["list", "kill"]);
    await adapter.close();
  });

  it("completes an explicitly authorized end when Prime already passivated the exact runtime", async () => {
    const authority = await issueResidentKillLease("resident-end-already-passivated");
    const authorize = vi.fn((lease: ResidentKillLease) =>
      authority.store.authorizeResidentKillInvocation(lease));
    const { adapter, state } = createHarness({
      authorizeResidentKillInvocation: authorize,
      requestHandler: async (command) => {
        const type = (command as { type?: string }).type ?? "unknown";
        if (type === "list") {
          return {
            type: "response",
            command: "list",
            success: true,
            data: { sessions: [] },
          };
        }
        return { type: "response", command: type, success: true };
      },
    });

    await expect(adapter.endResidentSession(authority.lease)).resolves.toEqual({
      acknowledgementVersion: 1,
      operation: "end",
      activeSessionId: authority.binding.activeSessionId,
      sessionId: authority.binding.sessionId,
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(state.requests.map((request) => (request as { type?: string }).type)).toEqual(["list"]);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await adapter.close();
  });

  it("does not retire a saved session that is active under a different runtime identity", async () => {
    const authority = await issueResidentKillLease("resident-end-rehydrated-elsewhere");
    const authorize = vi.fn((lease: ResidentKillLease) =>
      authority.store.authorizeResidentKillInvocation(lease));
    const { adapter, state } = createHarness({
      authorizeResidentKillInvocation: authorize,
      requestHandler: async (command) => {
        const type = (command as { type?: string }).type ?? "unknown";
        if (type === "list") {
          return {
            type: "response",
            command: "list",
            success: true,
            data: {
              sessions: [liveSummary({
                activeSessionId: "replacement-active-session",
                sessionId: authority.binding.sessionId,
                sessionFile: authority.binding.sessionFile,
                cwd: authority.binding.workspaceDirectory,
              })],
            },
          };
        }
        return { type: "response", command: type, success: true };
      },
    });

    await expect(adapter.endResidentSession(authority.lease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_SESSION_MISMATCH",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(state.requests.map((request) => (request as { type?: string }).type)).toEqual(["list"]);
    await authority.store.failResidentKillBeforeEffect(authority.lease);
    await adapter.close();
  });

  it("settles an exact archived session under one-use Store authority without invoking kill", async () => {
    const authority = await issueResidentKillLease("resident-end-archived");
    const authorize = vi.fn((lease: ResidentKillLease) =>
      authority.store.authorizeResidentKillInvocation(lease));
    const { adapter, state } = createHarness({
      authorizeResidentKillInvocation: authorize,
      requestHandler: async (command) => {
        const type = (command as { type?: string }).type ?? "unknown";
        if (type === "list") {
          return {
            type: "response",
            command: "list",
            success: true,
            data: {
              sessions: [liveSummary({
                lifecycle: "archived",
                cwd: authority.binding.workspaceDirectory,
              })],
            },
          };
        }
        return { type: "response", command: type, success: true };
      },
    });

    await expect(adapter.endResidentSession(authority.lease)).resolves.toEqual({
      acknowledgementVersion: 1,
      operation: "end",
      activeSessionId: authority.binding.activeSessionId,
      sessionId: authority.binding.sessionId,
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(state.requests.map((request) => (request as { type?: string }).type)).toEqual(["list"]);
    await expect(adapter.endResidentSession(authority.lease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_LIFECYCLE_AUTHORITY_INVALID",
    });
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await adapter.close();
  });

  it("does not let draft eligibility relax the exact durable session identity fence", async () => {
    const authority = await issueResidentKillLease("resident-end-wrong-draft-session");
    const authorize = vi.fn((lease: ResidentKillLease) =>
      authority.store.authorizeResidentKillInvocation(lease));
    const { adapter, state } = createHarness({
      authorizeResidentKillInvocation: authorize,
      requestHandler: async (command) => {
        const type = (command as { type?: string }).type ?? "unknown";
        if (type === "list") {
          return {
            type: "response",
            command: "list",
            success: true,
            data: {
              sessions: [liveSummary({
                lifecycle: "draft",
                sessionId: "different-session",
                cwd: authority.binding.workspaceDirectory,
              })],
            },
          };
        }
        return { type: "response", command: type, success: true };
      },
    });

    await expect(adapter.endResidentSession(authority.lease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_SESSION_MISMATCH",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(state.requests.map((request) => (request as { type?: string }).type)).toEqual(["list"]);
    await authority.store.failResidentKillBeforeEffect(authority.lease);
    await adapter.close();
  });

  it("rejects a bare binding before Store authorization or daemon reads", async () => {
    const authorize = vi.fn(async (_lease: ResidentKillLease) => {
      throw new Error("A bare binding must not reach Store authorization");
    });
    const { adapter, state } = createHarness({
      authorizeResidentKillInvocation: authorize,
    });

    await expect(adapter.endResidentSession(binding() as unknown as ResidentKillLease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_LIFECYCLE_AUTHORITY_INVALID",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(state.requests).toEqual([]);
    await adapter.close();
  });

  it("rejects a cross-Store lease after the read fence without invoking kill", async () => {
    const [owner, other] = await Promise.all([
      issueResidentKillLease("resident-end-owner"),
      issueResidentKillLease("resident-end-other"),
    ]);
    const authorize = vi.fn((lease: ResidentKillLease) =>
      owner.store.authorizeResidentKillInvocation(lease));
    const { adapter, state } = createHarness({
      authorizeResidentKillInvocation: authorize,
      requestHandler: async (command) => {
        const type = (command as { type?: string }).type ?? "unknown";
        if (type === "list") {
          return {
            type: "response",
            command: "list",
            success: true,
            data: { sessions: [liveSummary({ cwd: other.binding.workspaceDirectory })] },
          };
        }
        return { type: "response", command: type, success: true };
      },
    });

    await expect(adapter.endResidentSession(other.lease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_LIFECYCLE_AUTHORITY_INVALID",
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith(other.lease);
    expect(state.requests.map((request) => (request as { type?: string }).type)).toEqual(["list"]);
    expect(state.requests.filter((request) => (request as { type?: string }).type === "kill")).toHaveLength(0);
    await adapter.close();
  }, DURABLE_RESIDENT_AUTHORITY_TEST_TIMEOUT_MS);

  it("rechecks Store authority after a deferred list and never kills a lease settled meanwhile", async () => {
    const authority = await issueResidentKillLease("resident-end-stale-after-list");
    const listGate = deferred();
    const { adapter, state } = createHarness({
      authorizeResidentKillInvocation: (lease) => authority.store.authorizeResidentKillInvocation(lease),
      requestHandler: async (command) => {
        const type = (command as { type?: string }).type ?? "unknown";
        if (type === "list") {
          await listGate.promise;
          return {
            type: "response",
            command: "list",
            success: true,
            data: { sessions: [liveSummary({ cwd: authority.binding.workspaceDirectory })] },
          };
        }
        return { type: "response", command: type, success: true };
      },
    });

    const ending = adapter.endResidentSession(authority.lease);
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await authority.store.failResidentKillBeforeEffect(authority.lease);
    listGate.resolve();
    await expect(ending).rejects.toMatchObject({ code: "PRIME_RUNTIME_LIFECYCLE_AUTHORITY_INVALID" });
    expect(state.requests.filter((request) => (request as { type?: string }).type === "kill")).toHaveLength(0);
    await adapter.close();
  }, DURABLE_RESIDENT_AUTHORITY_TEST_TIMEOUT_MS);

  it.each([
    ["transport rejection", async () => { throw new Error("kill response transport closed"); }],
    ["negative response", async () => ({ type: "response", command: "kill", success: false, error: "not found" })],
    ["malformed response", async () => ({ type: "response", command: "kill", success: "maybe" })],
  ] as const)("classifies a post-invocation %s as unknown and the consumed lease cannot replay", async (_label, killResult) => {
    const authority = await issueResidentKillLease(`resident-end-unknown-${_label.replace(/\s/g, "-")}`);
    const { adapter, state } = createHarness({
      authorizeResidentKillInvocation: (lease) => authority.store.authorizeResidentKillInvocation(lease),
      requestHandler: async (command) => {
        const type = (command as { type?: string }).type ?? "unknown";
        if (type === "list") {
          return {
            type: "response",
            command: "list",
            success: true,
            data: { sessions: [liveSummary({ cwd: authority.binding.workspaceDirectory })] },
          };
        }
        if (type === "kill") return killResult();
        return { type: "response", command: type, success: true };
      },
    });

    await expectRuntimeError(
      adapter.endResidentSession(authority.lease),
      "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    );
    await expect(adapter.endResidentSession(authority.lease)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_LIFECYCLE_AUTHORITY_INVALID",
    });
    expect(state.requests.filter((request) => (request as { type?: string }).type === "kill")).toHaveLength(1);
    await adapter.close();
  });

  it("detaches only the exact local transport and is idempotent without stopping the worker", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.attachResident(binding());

    await expectRuntimeError(
      adapter.detachResidentSession({ ...connection.binding, sessionId: "different-session" }),
      "PRIME_RUNTIME_SESSION_MISMATCH",
    );
    expect(connection.getLifecycle().state).toBe("ready");

    await Promise.all([
      adapter.detachResidentSession(connection.binding),
      adapter.detachResidentSession(connection.binding),
    ]);
    expect(connection.getLifecycle().state).toBe("closed");
    expect(state.eventListeners.size).toBe(0);
    expect(state.disposeCalls).toBe(0);
    expect(state.requests.some((request) => (request as { type?: string }).type === "kill")).toBe(false);
    await adapter.close();
  });

  it("reads a stable exact projection through an ephemeral non-owned attachment without publishing", async () => {
    const { adapter, state } = createHarness();

    const projection = await adapter.readStableResidentProjection(binding());

    expect(projection).toMatchObject({
      cursor: { generation: "events-1", sequence: 4 },
      identity: { activeSessionId: "active-1", sessionId: "session-1" },
    });
    expect(state.requests).toEqual([{ type: "list" }]);
    expect(state.attachCalls).toEqual([{
      activeSessionId: "active-1",
      options: expect.objectContaining({ ownedSession: false, closeClientOnDispose: true, telemetryDisabled: true }),
    }]);
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(2);
    expect(state.disposeCalls).toBe(1);
    expect(state.persistCalls).toHaveLength(0);
    expect(state.projectionCalls).toHaveLength(0);
    await adapter.close();
  });

  it("rejects recovery reads when the connected capability set drifts from the binding", async () => {
    const durableBinding = binding();
    const { adapter, state } = createHarness({
      hello: validHello({
        serverCapabilities: [...durableBinding.runtime.capabilities, "unexpected-new-capability"],
      }),
    });

    await expectRuntimeError(
      adapter.readStableResidentProjection(durableBinding),
      "PRIME_RUNTIME_IDENTITY_MISMATCH",
    );
    expect(state.requests).toHaveLength(0);
    expect(state.attachCalls).toHaveLength(0);
    expect(state.projectionCalls).toHaveLength(0);
    await adapter.close();
  });

  it("persists a resident binding before attach and detach never kills or completes the worker", async () => {
    const { adapter, state } = createHarness();

    const connection = await adapter.createResident(createInput());

    expect(state.requests[0]).toEqual({
      type: "create",
      config: { cwd: WORKSPACE_DIRECTORY, telemetryDisabled: true },
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
        supportsExtensionUi: true,
        ownedSession: false,
        telemetryDisabled: true,
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
            data: { sessions: [liveSummary({ cwd: OTHER_WORKSPACE_DIRECTORY })] },
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

  it("proves same-process prompt idle from a terminal event observed before reconciliation", async () => {
    const terminal = terminalAssistantMessage();
    let phase: "initial" | "terminal" = "initial";
    const { adapter, state, emit } = createHarness({
      snapshotHandler: () => phase === "initial"
        ? validSnapshot({ cursorSequence: 4 })
        : validSnapshot({ messages: [terminal], cursorSequence: 5 }),
    });
    const connection = await adapter.createResident(createInput());
    const dispatch = residentDispatchLease(
      "prompt",
      connection.binding,
      "dispatch-fast-terminal-before-reconciliation",
    );
    await connection.prompt("Complete immediately.", dispatch);

    phase = "terminal";
    await emit({ type: "session_event", event: { type: "message_end", message: terminal } });
    const evidence = await connection.reconcileAcknowledgedPromptIdle(
      promptIdleReconciliationRequest(connection.binding, dispatch.dispatchAttemptId),
    );
    expect(evidence).toMatchObject({
      dispatchAttemptId: dispatch.dispatchAttemptId,
      projection: {
        cursor: { generation: "events-1", sequence: 5 },
        terminalAssistant: { stopReason: "stop" },
      },
      terminalAssistant: {
        blockId: expect.any(String),
        stopReason: "stop",
      },
    });

    expect(state.waitForIdleCalls).toBe(0);
    await connection.detach();
    await adapter.close();
  });

  it("retries a lagging post-terminal snapshot without falling back to the public idle barrier", async () => {
    const terminal = terminalAssistantMessage();
    let phase: "initial" | "terminal" = "initial";
    let terminalReads = 0;
    const { adapter, state, emit } = createHarness({
      snapshotHandler: () => {
        if (phase === "initial") return validSnapshot({ cursorSequence: 4 });
        terminalReads += 1;
        const cursorSequence = terminalReads <= 4 ? 4 + terminalReads : 9;
        return validSnapshot({ messages: [terminal], cursorSequence });
      },
    });
    const connection = await adapter.createResident(createInput());
    const dispatch = residentDispatchLease(
      "prompt",
      connection.binding,
      "dispatch-terminal-snapshot-lag",
    );
    await connection.prompt("Complete before the snapshot cache catches up.", dispatch);

    phase = "terminal";
    await emit({ type: "session_event", event: { type: "message_end", message: terminal } });
    await expect(connection.reconcileAcknowledgedPromptIdle(
      promptIdleReconciliationRequest(connection.binding, dispatch.dispatchAttemptId),
    )).resolves.toMatchObject({
      projection: { cursor: { generation: "events-1", sequence: 9 } },
    });

    expect(terminalReads).toBeGreaterThanOrEqual(6);
    expect(state.waitForIdleCalls).toBe(0);
    expect(state.promptCalls).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("cancels reconciliation during reconnect, then settles the same prompt once after validated resync", async () => {
    const terminal = terminalAssistantMessage();
    const reconciliationBackoff = deferred();
    let phase: "initial" | "terminal" = "initial";
    const { adapter, state, emit } = createHarness({
      waitHandler: (milliseconds) => milliseconds === 25
        ? reconciliationBackoff.promise
        : undefined,
      snapshotHandler: () => phase === "initial"
        ? validSnapshot({ cursorSequence: 4 })
        : validSnapshot({ messages: [terminal], cursorSequence: 5 }),
    });
    const connection = await adapter.createResident(createInput());
    const dispatch = residentDispatchLease(
      "prompt",
      connection.binding,
      "dispatch-reconcile-through-resync",
    );
    await connection.prompt("Reconnect while this result is pending.", dispatch);
    const request = promptIdleReconciliationRequest(
      connection.binding,
      dispatch.dispatchAttemptId,
    );
    const interrupted = connection.reconcileAcknowledgedPromptIdle(request);
    await Promise.resolve();

    await emit({ type: "connection_status", status: "reconnecting" });
    await expect(interrupted).rejects.toMatchObject({
      code: "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED",
      retryable: false,
    });
    await emit({ type: "session_resynced", snapshot: validSnapshot({ cursorSequence: 4 }) });
    await emit({ type: "connection_status", status: "connected" });

    phase = "terminal";
    await emit({ type: "session_event", event: { type: "message_end", message: terminal } });
    await expect(connection.reconcileAcknowledgedPromptIdle(request)).resolves.toMatchObject({
      dispatchAttemptId: dispatch.dispatchAttemptId,
      projection: { cursor: { generation: "events-1", sequence: 5 } },
    });
    expect(state.promptCalls).toHaveLength(1);
    expect(state.waitForIdleCalls).toBe(0);
    await connection.detach();
    await adapter.close();
  });

  it("retains one observed RLM child and terminal proof across a validated cursor-generation rollover", async () => {
    const terminal = terminalAssistantMessage();
    let phase: "initial" | "terminal" = "initial";
    const { adapter, state, emit } = createHarness({
      snapshotHandler: () => phase === "initial"
        ? validSnapshot({ cursorGeneration: "events-1", cursorSequence: 4 })
        : validSnapshot({
            messages: [terminal],
            cursorGeneration: "events-2",
            cursorSequence: 1,
          }),
    });
    const connection = await adapter.createResident(createInput());
    const dispatch = residentDispatchLease(
      "prompt",
      connection.binding,
      "dispatch-terminal-before-generation-rollover",
    );
    await connection.prompt("Delegate one bounded review, then finish.", dispatch);
    await emit({
      type: "session_event",
      event: { type: "rlm_child_update", child: rlmChild("done") },
    });
    phase = "terminal";
    await emit({ type: "session_event", event: { type: "message_end", message: terminal } });

    await emit({ type: "connection_status", status: "reconnecting" });
    await emit({
      type: "session_resynced",
      snapshot: validSnapshot({
        messages: [terminal],
        cursorGeneration: "events-2",
        cursorSequence: 0,
      }),
    });
    await emit({ type: "connection_status", status: "connected" });

    await expect(connection.reconcileAcknowledgedPromptIdle(
      promptIdleReconciliationRequest(connection.binding, dispatch.dispatchAttemptId),
    )).resolves.toMatchObject({
      projection: {
        cursor: { generation: "events-2", sequence: 1 },
        childAgents: [{ agentId: "sub-settlement-1", state: "complete" }],
      },
    });
    expect(state.promptCalls).toHaveLength(1);
    expect(state.waitForIdleCalls).toBe(0);
    expect(state.projectionCalls.at(-1)?.projection.childAgents).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("settles repeated prompts independently while exact retries and child updates remain non-replayed", async () => {
    const firstTerminal = terminalAssistantMessage({ timestamp: 1_786_100_000_001 });
    const secondTerminal = terminalAssistantMessage({ timestamp: 1_786_100_000_002 });
    let phase: "initial" | "first" | "second" = "initial";
    const { adapter, state, emit } = createHarness({
      snapshotHandler: () => phase === "initial"
        ? validSnapshot({ cursorSequence: 4 })
        : phase === "first"
          ? validSnapshot({ messages: [firstTerminal], cursorSequence: 5 })
          : validSnapshot({ messages: [firstTerminal, secondTerminal], cursorSequence: 6 }),
    });
    const connection = await adapter.createResident(createInput());
    const firstDispatch = residentDispatchLease(
      "prompt",
      connection.binding,
      "dispatch-repeated-prompt-1",
    );
    await connection.prompt("Run one child review.", firstDispatch);
    await emit({
      type: "session_event",
      event: { type: "rlm_child_update", child: rlmChild("running") },
    });
    phase = "first";
    await emit({ type: "session_event", event: { type: "message_end", message: firstTerminal } });
    await connection.reconcileAcknowledgedPromptIdle(
      promptIdleReconciliationRequest(connection.binding, firstDispatch.dispatchAttemptId),
    );

    await expect(connection.prompt("Run one child review.", firstDispatch)).resolves.toMatchObject({
      operation: "prompt",
      disposition: "accepted",
    });
    const secondDispatch = residentDispatchLease(
      "prompt",
      connection.binding,
      "dispatch-repeated-prompt-2",
    );
    await connection.prompt("Use the retained review and finish.", secondDispatch);
    await emit({
      type: "session_event",
      event: { type: "rlm_child_update", child: rlmChild("done") },
    });
    phase = "second";
    await emit({ type: "session_event", event: { type: "message_end", message: secondTerminal } });
    const secondEvidence = await connection.reconcileAcknowledgedPromptIdle(
      promptIdleReconciliationRequest(
        connection.binding,
        secondDispatch.dispatchAttemptId,
        { sequence: 5 },
      ),
    );

    expect(state.promptCalls.map(({ message }) => message)).toEqual([
      "Run one child review.",
      "Use the retained review and finish.",
    ]);
    expect(secondEvidence.projection.childAgents).toEqual([
      expect.objectContaining({ agentId: "sub-settlement-1", state: "complete" }),
    ]);
    expect(state.waitForIdleCalls).toBe(0);
    await connection.detach();
    await adapter.close();
  });

  it("fails closed on execution-generation replacement without replaying prompt or reconciliation", async () => {
    const { adapter, state } = createHarness();
    const connection = await adapter.createResident(createInput());
    const originalDispatch = residentDispatchLease(
      "prompt",
      connection.binding,
      "dispatch-before-execution-generation-replacement",
    );
    await connection.prompt("Admit only on the original execution generation.", originalDispatch);
    const replacementBinding = binding({ executionGenerationId: "generation-2" });

    await expect(connection.prompt(
      "Never replay on the replacement generation.",
      residentDispatchLease(
        "prompt",
        replacementBinding,
        "dispatch-after-execution-generation-replacement",
      ),
    )).rejects.toMatchObject({
      code: "PRIME_RUNTIME_DISPATCH_AUTHORITY_CHANGED",
      retryable: false,
    });
    await expect(connection.reconcileAcknowledgedPromptIdle(
      promptIdleReconciliationRequest(
        replacementBinding,
        originalDispatch.dispatchAttemptId,
      ),
    )).rejects.toMatchObject({
      code: "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED",
      retryable: false,
    });

    expect(state.promptCalls).toHaveLength(1);
    expect(state.waitForIdleCalls).toBe(0);
    await connection.detach();
    await adapter.close();
  });

  it("cancels a terminal-event waiter when the exact connection begins reconnecting", async () => {
    const { adapter, state, emit } = createHarness();
    const connection = await adapter.createResident(createInput());
    const dispatch = residentDispatchLease(
      "prompt",
      connection.binding,
      "dispatch-terminal-waiter-reconnect",
    );
    await connection.prompt("Wait for a terminal result.", dispatch);
    const reconciliation = connection.reconcileAcknowledgedPromptIdle(
      promptIdleReconciliationRequest(connection.binding, dispatch.dispatchAttemptId),
    );
    await Promise.resolve();

    await emit({ type: "connection_status", status: "reconnecting" });
    await expect(reconciliation).rejects.toMatchObject({
      code: "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED",
      retryable: false,
    });
    expect(state.waitForIdleCalls).toBe(0);

    // A later event must not revive or publish from the cancelled waiter.
    await emit({ type: "session_event", event: { type: "agent_end" } });
    expect(state.projectionCalls).toHaveLength(1);
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

  it("bounds a never-resolving Stop idle barrier without replaying abort or mutating authority", async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const { adapter, state } = createHarness({ waitForIdleHandler: () => neverSettles });
    const connection = await adapter.createResident(createInput());
    const originalBinding = connection.binding;
    const persistCount = state.persistCalls.length;
    const projectionCount = state.projectionCalls.length;
    const dispatch = residentDispatchLease(
      "abort",
      originalBinding,
      "dispatch-abort-bounded-idle-recovery",
    );
    await expect(connection.abort(dispatch)).resolves.toMatchObject({
      operation: "abort",
      disposition: "accepted",
    });
    const request = abortIdleReconciliationRequest(
      originalBinding,
      dispatch.dispatchAttemptId,
    );

    await expect(connection.reconcileAcknowledgedAbortIdle(request)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_REQUEST_FAILED",
      retryable: true,
      details: { dispatchAttemptId: dispatch.dispatchAttemptId },
    });
    await expect(connection.reconcileAcknowledgedAbortIdle(request)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_REQUEST_FAILED",
      retryable: true,
    });

    expect(state.abortCalls).toBe(1);
    expect(state.waitForIdleCalls).toBe(2);
    expect(state.projectionCalls).toHaveLength(projectionCount);
    expect(state.persistCalls).toHaveLength(persistCount);
    expect(connection.binding).toEqual(originalBinding);
    expect(connection.getLifecycle().state).toBe("ready");
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

  it("detach disposes a never-settling idle barrier and cannot publish terminally stale evidence", async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const { adapter, state } = createHarness({ waitForIdleHandler: () => neverSettles });
    const connection = await adapter.createResident(createInput());
    const request = promptIdleReconciliationRequest(
      connection.binding,
      "dispatch-prompt-detach-during-idle",
    );
    const reconciliation = connection.reconcileAcknowledgedPromptIdle(request);
    await vi.waitFor(() => expect(state.waitForIdleCalls).toBe(1));

    const terminal = connection.detach();

    await expect(reconciliation).rejects.toMatchObject({
      code: "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED",
      retryable: false,
    });
    await expect(terminal).resolves.toBeUndefined();
    expect(state.disposeCalls).toBe(1);
    expect(state.projectionCalls).toHaveLength(1);
    await expect(connection.reconcileAcknowledgedPromptIdle(request)).rejects.toMatchObject({
      code: "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED",
    });
    expect(state.waitForIdleCalls).toBe(1);
    await adapter.close();
  });

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
    await new Promise<void>((resolve) => setImmediate(resolve));
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
    await new Promise<void>((resolve) => setImmediate(resolve));

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

  it("publishes live RLM child state without rediscovering attachment resources", async () => {
    let phase: "initial" | "active" = "initial";
    let activeReads = 0;
    const { adapter, state, emit } = createHarness({
      snapshotHandler: () => {
        if (phase === "initial") return validSnapshot({ cursorSequence: 4 });
        activeReads += 1;
        return validSnapshot({
          cursorSequence: 4 + activeReads,
          state: {
            isStreaming: true,
            sessionActions: {
              queuedCount: 0,
              steering: [],
              followUps: [],
              active: { kind: "turn", phase: "running" },
            },
            goal: {
              active: true,
              status: "active",
              goalId: "goal-live-1",
              objective: "Improve the harness",
              tokensUsed: 120,
              timeUsedSeconds: 4,
              continuationsUsed: 0,
              updatedAt: 1_786_100_001_000,
            },
          },
        });
      },
    });
    const connection = await adapter.createResident(createInput());
    expect(state.resourceSnapshotCalls).toBe(1);
    phase = "active";
    await emit({
      type: "session_event",
      event: {
        type: "rlm_child_update",
        child: {
          id: "sub-live-1",
          parentId: "parent-live-1",
          sessionName: "harness-reviewer",
          model: "openai/gpt-5",
          label: "Review the harness",
          status: "running",
          sessionDir: SESSION_DIRECTORY,
          activity: { kind: "executing", toolName: "exec" },
        },
      },
    });
    await vi.waitFor(() => expect(state.projectionCalls).toHaveLength(2));

    expect(activeReads).toBe(4);
    expect(state.resourceSnapshotCalls).toBe(1);
    expect(state.projectionCalls.at(-1)?.projection).toMatchObject({
      cursor: { generation: "events-1", sequence: 8 },
      runtime: { isStreaming: true },
      goal: { goalId: "goal-live-1", objective: "Improve the harness", state: "active" },
      childAgents: [{ agentId: "sub-live-1", title: "Review the harness", state: "running" }],
    });
    await connection.detach();
    await adapter.close();
  });

  it("lets a fresh child snapshot supersede an older event and retains that newer state through omission", async () => {
    let phase: "initial" | "fresh" | "omitted" = "initial";
    const { adapter, state, emit } = createHarness({
      snapshotHandler: () => phase === "initial"
        ? validSnapshot({ cursorSequence: 4 })
        : phase === "fresh"
          ? validSnapshot({ children: [rlmChild("done")], cursorSequence: 5 })
          : validSnapshot({ children: [], cursorSequence: 6 }),
    });
    const connection = await adapter.createResident(createInput());

    phase = "fresh";
    await emit({
      type: "session_event",
      event: { type: "rlm_child_update", child: rlmChild("running") },
    });
    await vi.waitFor(() => expect(state.projectionCalls).toHaveLength(2));
    expect(state.projectionCalls.at(-1)?.projection.childAgents).toEqual([
      expect.objectContaining({ agentId: "sub-settlement-1", state: "complete" }),
    ]);

    phase = "omitted";
    await emit({ type: "session_event", event: { type: "agent_end" } });
    await vi.waitFor(() => expect(state.projectionCalls).toHaveLength(3));
    expect(state.projectionCalls.at(-1)?.projection.childAgents).toEqual([
      expect.objectContaining({ agentId: "sub-settlement-1", state: "complete" }),
    ]);

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
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(6);
    expect(state.projectionCalls).toHaveLength(2);
    expect(state.modelProjectionCalls).toHaveLength(1);
    expect(state.modelProjectionCalls[0]).toMatchObject({
      command,
      binding: connection.binding,
      projection: {
        selectedModel: { providerId: "openai", modelId: "gpt-5" },
        runtime: { model: "openai/gpt-5" },
      },
    });
    expect(state.chronology.filter((entry) => entry === "projection:model-selection:publish")).toHaveLength(1);
    expect(state.projectionCalls.at(-1)?.projection.runtime.model).toBe("openai/gpt-5");
    await connection.detach();
    await adapter.close();
  });

  it("uses only the exact model-attempt publisher and fails uncertain when it rejects", async () => {
    const command = modelSelectionCommand("select-through-dedicated-publication");
    const { adapter, state } = createHarness({
      publishModelSelectionProjectionHandler: async () => {
        throw new Error("same-cursor Store authority rejected");
      },
    });
    const connection = await adapter.createResident(createInput());

    await expect(adapter.submit(command, { residentBinding: connection.binding })).rejects.toMatchObject({
      code: "MODEL_SELECTION_RECONCILIATION_FAILED",
      uncertain: true,
      retryable: false,
    });

    expect(state.setModelCalls).toEqual([{ providerId: "openai", modelId: "gpt-5" }]);
    expect(state.modelProjectionCalls).toHaveLength(1);
    expect(state.modelProjectionCalls[0]).toMatchObject({ command, binding: connection.binding });
    expect(state.chronology.filter((entry) => entry === "projection:publish")).toHaveLength(1);
    expect(state.chronology.filter((entry) => entry === "projection:model-selection:publish")).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("reconciles independently when the primary connection's projection remains stale", async () => {
    let mutationCommitted = false;
    const { adapter, state } = createHarness({
      snapshotHandler: () => validSnapshot({
        state: {
          model: { provider: "openai", id: "gpt-4" },
        },
      }),
      authoritativeSnapshotHandler: () => validAuthoritativeSnapshot({
        state: {
          model: mutationCommitted
            ? { provider: "openai", id: "gpt-5" }
            : { provider: "openai", id: "gpt-4" },
          leafId: mutationCommitted ? "model-change-target" : "model-change-baseline",
        },
        sessionContext: {
          messages: [],
          thinkingLevel: "medium",
          serviceTier: "standard",
          model: mutationCommitted
            ? { provider: "openai", modelId: "gpt-5" }
            : { provider: "openai", modelId: "gpt-4" },
        },
      }),
      setModelHandler: () => {
        mutationCommitted = true;
        return { provider: "untrusted-response", id: "must-not-prove-completion" };
      },
    });
    const connection = await adapter.createResident(createInput());
    const closesBeforeSelection = state.closes;
    expect(state.projectionCalls.at(-1)?.projection.runtime.model).toBe("openai/gpt-4");

    await expect(adapter.submit(modelSelectionCommand("select-after-stale-cache"), {
      residentBinding: connection.binding,
    })).resolves.toEqual({
      disposition: "handled",
      message: "Prime Agent selected and verified the requested model",
    });

    expect(state.setModelCalls).toEqual([{ providerId: "openai", modelId: "gpt-5" }]);
    expect(state.attachCalls).toHaveLength(2);
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(6);
    expect(
      state.requests
        .map((request) => (request as { type?: string }).type)
        .filter((type) => type?.startsWith("get_")),
    ).toEqual([
      "get_connection_state",
      "get_messages",
      "get_session_context",
      "get_connection_state",
      "get_connection_state",
      "get_messages",
      "get_session_context",
      "get_connection_state",
    ]);
    expect(
      state.requests
        .filter((request) => (request as { type?: string }).type?.startsWith("get_"))
        .every((request) => (request as { activeSessionId?: string }).activeSessionId === "active-1"),
    ).toBe(true);
    expect(state.disposeCalls).toBe(1);
    expect(state.closes - closesBeforeSelection).toBe(2);
    expect(state.subscribeCalls).toBe(2);
    expect(state.unsubscribeCalls).toBe(1);
    expect(state.eventListeners.size).toBe(1);
    expect(state.projectionCalls.at(-1)?.projection.runtime.model).toBe("openai/gpt-5");
    await connection.detach();
    await adapter.close();
  });

  it("waits for the accepted model mutation to become authoritative without dispatching twice", async () => {
    let mutationStarted = false;
    let readsAfterMutation = 0;
    const waits: number[] = [];
    const { adapter, state } = createHarness({
      snapshotHandler: () => validSnapshot({
        state: { model: { provider: "openai", id: "gpt-4" } },
      }),
      authoritativeSnapshotHandler: () => {
        if (mutationStarted) readsAfterMutation += 1;
        const selected = mutationStarted && readsAfterMutation >= 3;
        return validAuthoritativeSnapshot({
          state: {
            model: selected
              ? { provider: "openai", id: "gpt-5" }
              : { provider: "openai", id: "gpt-4" },
            leafId: selected ? "model-change-target" : "model-change-baseline",
          },
          sessionContext: {
            messages: [],
            thinkingLevel: "medium",
            serviceTier: "standard",
            model: selected
              ? { provider: "openai", modelId: "gpt-5" }
              : { provider: "openai", modelId: "gpt-4" },
          },
        });
      },
      setModelHandler: (providerId, modelId) => {
        mutationStarted = true;
        return { provider: providerId, id: modelId };
      },
      waitHandler: (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    const connection = await adapter.createResident(createInput());

    await expect(adapter.submit(modelSelectionCommand(), {
      residentBinding: connection.binding,
    })).resolves.toMatchObject({
      disposition: "handled",
      message: "Prime Agent selected and verified the requested model",
    });

    expect(state.setModelCalls).toEqual([{ providerId: "openai", modelId: "gpt-5" }]);
    expect(readsAfterMutation).toBe(4);
    expect(waits).toEqual([50, 50, 50]);
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
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(82);
    expect(state.projectionCalls).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("rejects an attachment whose cursor sequence fields disagree", async () => {
    const { adapter, state } = createHarness({
      snapshotHandler: (attachmentOrdinal) => attachmentOrdinal === 1
        ? validSnapshot()
        : {
            ...validSnapshot(),
            lastEventSequence: 5,
            lastEventCursor: { generation: "events-1", sequence: 4 },
          },
    });
    const connection = await adapter.createResident(createInput());

    await expect(adapter.submit(modelSelectionCommand("select-with-inconsistent-cursor"), {
      residentBinding: connection.binding,
    })).rejects.toMatchObject({
      code: "MODEL_SELECTION_RECONCILIATION_FAILED",
      uncertain: true,
    });

    expect(state.setModelCalls).toHaveLength(1);
    expect(state.authoritativeRoundCalls).toBe(0);
    expect(state.projectionCalls).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("does not accept a target-other-target state race behind an unchanged attachment cursor", async () => {
    const { adapter, state } = createHarness({
      snapshotHandler: () => validSnapshot({
        state: { model: { provider: "openai", id: "gpt-4" } },
      }),
      authoritativeSnapshotHandler: () => validAuthoritativeSnapshot({
        state: {
          model: { provider: "openai", id: "gpt-5" },
          leafId: "model-change-target",
        },
      }),
      authoritativeStateAfterHandler: (roundOrdinal, snapshot) => {
        if (roundOrdinal % 2 === 0) return snapshot.state;
        return {
          ...(snapshot.state as Readonly<Record<string, unknown>>),
          model: { provider: "openai", id: "gpt-4" },
          leafId: `model-change-other-${roundOrdinal}`,
        };
      },
    });
    const connection = await adapter.createResident(createInput());

    await expect(adapter.submit(modelSelectionCommand("select-through-state-race"), {
      residentBinding: connection.binding,
    })).rejects.toMatchObject({
      code: "MODEL_SELECTION_RECONCILIATION_FAILED",
      uncertain: true,
    });

    expect(state.setModelCalls).toHaveLength(1);
    expect(state.authoritativeRoundCalls).toBe(40);
    expect(state.projectionCalls).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("requires raw state messageCount to match the exact raw message list", async () => {
    const { adapter, state } = createHarness({
      authoritativeSnapshotHandler: () => validAuthoritativeSnapshot({
        messages: [],
        state: { messageCount: 1 },
      }),
    });
    const connection = await adapter.createResident(createInput());

    await expect(adapter.submit(modelSelectionCommand("select-through-message-race"), {
      residentBinding: connection.binding,
    })).rejects.toMatchObject({
      code: "MODEL_SELECTION_RECONCILIATION_FAILED",
      uncertain: true,
    });

    expect(state.setModelCalls).toHaveLength(1);
    expect(state.authoritativeRoundCalls).toBe(40);
    expect(state.projectionCalls).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("requires two equal whole proof rounds when session context changes", async () => {
    const { adapter, state } = createHarness({
      authoritativeSnapshotHandler: (roundOrdinal) => validAuthoritativeSnapshot({
        state: { leafId: "model-change-target" },
        sessionContext: {
          messages: [],
          thinkingLevel: "medium",
          serviceTier: "standard",
          model: { provider: "openai", modelId: "gpt-5" },
          proofMarker: roundOrdinal % 2,
        },
      }),
    });
    const connection = await adapter.createResident(createInput());

    await expect(adapter.submit(modelSelectionCommand("select-through-context-race"), {
      residentBinding: connection.binding,
    })).rejects.toMatchObject({
      code: "MODEL_SELECTION_RECONCILIATION_FAILED",
      uncertain: true,
    });

    expect(state.setModelCalls).toHaveLength(1);
    expect(state.authoritativeRoundCalls).toBe(40);
    expect(state.projectionCalls).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("fails outward and releases the adapter queue when attachment read and disposal hang", async () => {
    const neverSnapshot = new Promise<unknown>(() => undefined);
    const neverDispose = new Promise<void>(() => undefined);
    let disposeInvocations = 0;
    const { adapter, state } = createHarness({
      snapshotHandler: (attachmentOrdinal) => attachmentOrdinal === 2
        ? neverSnapshot
        : validSnapshot(),
      disposeHandler: () => {
        disposeInvocations += 1;
        return disposeInvocations === 1 ? neverDispose : Promise.resolve();
      },
    });
    const connection = await adapter.createResident(createInput());
    const startedAt = performance.now();

    await expect(adapter.submit(modelSelectionCommand("select-before-hanging-read"), {
      residentBinding: connection.binding,
    })).rejects.toMatchObject({
      code: "MODEL_SELECTION_RECONCILIATION_FAILED",
      uncertain: true,
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
    await vi.waitFor(() => expect(state.disposeCalls).toBe(1), { timeout: 250 });

    await expect(adapter.readStableResidentProjection(connection.binding)).resolves.toMatchObject({
      runtime: { model: "openai/gpt-5" },
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);

    expect(state.setModelCalls).toHaveLength(1);
    expect(state.authoritativeRoundCalls).toBe(0);
    expect(state.disposeCalls).toBe(2);
    expect(
      state.requests.some((request) =>
        (request as { type?: string }).type?.startsWith("get_")),
    ).toBe(false);
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(5);
    await connection.detach();
    await adapter.close();
  }, 2_000);

  it("releases the adapter queue when the exact model-only attachment never settles", async () => {
    const neverAttach = new Promise<void>(() => undefined);
    const { adapter, state } = createHarness({
      attachHandler: (attachmentOrdinal) => attachmentOrdinal === 2
        ? neverAttach
        : Promise.resolve(),
    });
    const connection = await adapter.createResident(createInput());
    const startedAt = performance.now();

    await expect(adapter.submit(modelSelectionCommand("select-before-hanging-attach"), {
      residentBinding: connection.binding,
    })).rejects.toMatchObject({
      code: "MODEL_SELECTION_RECONCILIATION_FAILED",
      uncertain: true,
    });
    expect(performance.now() - startedAt).toBeLessThan(500);

    await expect(adapter.readStableResidentProjection(connection.binding)).resolves.toMatchObject({
      runtime: { model: "openai/gpt-5" },
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);

    expect(state.setModelCalls).toHaveLength(1);
    expect(state.attachCalls).toHaveLength(3);
    expect(state.authoritativeRoundCalls).toBe(0);
    expect(state.disposeCalls).toBe(1);
    expect(state.chronology.filter((entry) => entry === "snapshot")).toHaveLength(4);
    await connection.detach();
    await adapter.close();
  }, 2_000);

  it("fails uncertain after a bounded wait when the requested model never becomes authoritative", async () => {
    const waits: number[] = [];
    const { adapter, state } = createHarness({
      snapshotHandler: () => validSnapshot({
        state: { model: { provider: "openai", id: "gpt-4" } },
      }),
      authoritativeSnapshotHandler: () => validAuthoritativeSnapshot({
        state: {
          model: { provider: "openai", id: "gpt-4" },
          leafId: "model-change-baseline",
        },
        sessionContext: {
          messages: [],
          thinkingLevel: "medium",
          serviceTier: "standard",
          model: { provider: "openai", modelId: "gpt-4" },
        },
      }),
      waitHandler: (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    const connection = await adapter.createResident(createInput());
    const closesBeforeSelection = state.closes;

    await expect(adapter.submit(modelSelectionCommand("select-model-never-visible"), {
      residentBinding: connection.binding,
    })).rejects.toMatchObject({
      code: "MODEL_SELECTION_RECONCILIATION_FAILED",
      retryable: false,
      uncertain: true,
    });

    expect(state.setModelCalls).toHaveLength(1);
    expect(waits).toHaveLength(39);
    expect(waits.every((milliseconds) => milliseconds === 50)).toBe(true);
    expect(state.attachCalls).toHaveLength(2);
    expect(state.disposeCalls).toBe(1);
    expect(state.closes - closesBeforeSelection).toBe(2);
    expect(state.subscribeCalls).toBe(2);
    expect(state.unsubscribeCalls).toBe(1);
    expect(state.eventListeners.size).toBe(1);
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

  it("refuses publication and rechecks queued work when the exact binding changes", async () => {
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
    const first = adapter
      .submit(modelSelectionCommand("select-before-binding-refresh"), {
        residentBinding: connection.binding,
      })
      .catch((error: unknown) => error);
    while (state.setModelCalls.length === 0) await Promise.resolve();
    const second = adapter
      .submit(modelSelectionCommand("select-after-binding-refresh"), {
        residentBinding: connection.binding,
      })
      .catch((error: unknown) => error);

    await emit({ type: "connection_status", status: "reconnecting" });
    state.hello = validHello({ supervisorGeneration: "supervisor-model-refresh" });
    await emit({ type: "session_resynced", snapshot: validSnapshot() });
    await emit({ type: "connection_status", status: "connected" });
    releaseFirst?.();

    await expect(first).resolves.toMatchObject({
      code: "MODEL_SELECTION_RECONCILIATION_FAILED",
      uncertain: true,
    });
    await expect(second).resolves.toMatchObject({
      code: "MODEL_SELECTION_SESSION_AUTHORITY_CHANGED",
      uncertain: false,
    });
    expect(state.setModelCalls).toHaveLength(1);
    await connection.detach();
    await adapter.close();
  });

  it("refuses post-proof publication and cancels queued mutations after a terminal action", async () => {
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
    const first = adapter
      .submit(modelSelectionCommand("select-before-detach"), {
        residentBinding: connection.binding,
      })
      .catch((error: unknown) => error);
    while (state.setModelCalls.length === 0) await Promise.resolve();
    const second = adapter
      .submit(modelSelectionCommand("select-queued-before-detach"), { residentBinding: connection.binding })
      .catch((error: unknown) => error);
    const detached = connection.detach();
    releaseFirst?.();

    await expect(first).resolves.toMatchObject({
      code: "MODEL_SELECTION_RECONCILIATION_FAILED",
      uncertain: true,
    });
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
