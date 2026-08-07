import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PrimeAgentResidentAdapter,
  type PrimeAgentPublicModule,
  type PrimeDaemonAgentConnectionPublic,
  type PrimeDaemonClientPublic,
  type ResidentDaemonLauncher,
} from "../../src/hostd/prime-agent-resident-adapter";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import { HostStore } from "../../src/hostd/store";

const THREAD_ID = "demo-thread";
const EXECUTION_GENERATION_ID = "demo-execution-1";
const ACTIVE_SESSION_ID = "resident-active-session-continuity-1";
const SESSION_ID = "resident-session-continuity-1";
const SUPERVISOR_GENERATION = "resident-supervisor-generation-1";
const EVENT_GENERATION = "resident-event-generation-1";
const SNAPSHOT_MARKER = "resident snapshot survived hostd relaunch";
const SESSION_NAME = "Resident continuity proof";
const FIXED_TIME = new Date("2026-08-07T16:00:00.000Z");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface RuntimePaths {
  readonly executable: string;
  readonly cliEntrypoint: string;
  readonly daemonWorkingDirectory: string;
  readonly socketPath: string;
}

interface FakeResidentSession {
  readonly summary: Readonly<Record<string, unknown>>;
  readonly snapshot: Readonly<Record<string, unknown>>;
}

class SharedFakePrimeDaemon {
  readonly requests: Readonly<object>[] = [];
  readonly attachActiveSessionIds: string[] = [];
  readonly attachOptions: Readonly<Record<string, unknown>>[] = [];
  readonly initialSnapshots: unknown[] = [];
  readonly chronology: string[] = [];
  readonly connectedSocketPaths: string[] = [];
  createCount = 0;
  listCount = 0;
  killCount = 0;
  clientCloseCount = 0;
  connectionDisposeCount = 0;
  launcherSpawnCount = 0;
  launcherKillCount = 0;
  helloReadCount = 0;
  waitForHelloCount = 0;
  private session: FakeResidentSession | undefined;

  readonly hello: Readonly<Record<string, unknown>>;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly workspaceDirectory: string,
  ) {
    this.hello = Object.freeze({
      type: "daemon_hello",
      socketPath: paths.socketPath,
      protocol: Object.freeze({
        name: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolName,
        version: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion,
      }),
      schemaId: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId,
      schemaRevision: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision,
      appVersion: PINNED_PRIME_AGENT_RUNTIME.expectedAppVersion,
      runtime: Object.freeze({
        buildId: PINNED_PRIME_AGENT_RUNTIME.runtimeBuildId,
        executablePath: paths.executable,
        entrypointPath: paths.cliEntrypoint,
      }),
      supervisorGeneration: SUPERVISOR_GENERATION,
      clientId: "continuity-test-client",
      serverCapabilities: Object.freeze([...REQUIRED_RESIDENT_DAEMON_CAPABILITIES]),
    });
  }

  runtimeModule(): PrimeAgentPublicModule {
    const daemon = this;

    class FakeDaemonClient implements PrimeDaemonClientPublic {
      constructor(readonly socketPath: string) {
        daemon.connectedSocketPaths.push(socketPath);
      }

      get hello(): unknown {
        daemon.helloReadCount += 1;
        return daemon.hello;
      }

      async connect(): Promise<void> {
        if (this.socketPath !== daemon.paths.socketPath) throw new Error("connected to an unexpected daemon socket");
        daemon.chronology.push("daemon:connect");
      }

      async waitForHello(): Promise<unknown> {
        daemon.waitForHelloCount += 1;
        return daemon.hello;
      }

      async request(command: Readonly<object>): Promise<unknown> {
        return daemon.request(command);
      }

      close(): void {
        daemon.clientCloseCount += 1;
        daemon.chronology.push("client:close");
      }
    }

    const DaemonAgentConnection = Object.freeze({
      attach: async (
        client: PrimeDaemonClientPublic,
        activeSessionId: string,
        options: Readonly<{
          closeClientOnDispose: true;
          sendClientEnv: false;
          supportsExtensionUi: false;
          ownedSession: false;
          recoverDaemon: () => Promise<void>;
        }>,
      ): Promise<PrimeDaemonAgentConnectionPublic> => {
        const session = daemon.requireSession(activeSessionId);
        if (!daemon.chronology.includes(`store:persist:${activeSessionId}`)) {
          throw new Error("attach raced ahead of durable HostStore persistence");
        }
        daemon.attachActiveSessionIds.push(activeSessionId);
        daemon.attachOptions.push(options);
        daemon.chronology.push(`daemon:attach:${activeSessionId}`);
        let disposed = false;
        return {
          getInitialSnapshot: async () => {
            daemon.initialSnapshots.push(session.snapshot);
            daemon.chronology.push(`daemon:snapshot:${activeSessionId}`);
            return session.snapshot;
          },
          subscribe: () => () => undefined,
          dispose: async () => {
            if (disposed) return;
            disposed = true;
            daemon.connectionDisposeCount += 1;
            daemon.chronology.push(`daemon:dispose:${activeSessionId}`);
            client.close();
          },
        };
      },
    });

    return { DaemonClient: FakeDaemonClient, DaemonAgentConnection };
  }

  async persistThrough(store: HostStore, binding: ResidentSessionBinding): Promise<void> {
    await store.persistResidentSessionBinding(binding);
    this.chronology.push(`store:persist:${binding.activeSessionId}`);
  }

  async completeThrough(store: HostStore, binding: ResidentSessionBinding): Promise<void> {
    await store.completeResidentSessionBinding(binding);
    this.chronology.push(`store:complete:${binding.activeSessionId}`);
  }

  spawnLauncher(): ResidentDaemonLauncher {
    this.launcherSpawnCount += 1;
    return {
      pid: 4242,
      once: () => undefined,
      kill: () => {
        this.launcherKillCount += 1;
        return true;
      },
      unref: () => undefined,
    };
  }

  private request(command: Readonly<object>): unknown {
    this.requests.push(command);
    const request = command as Readonly<Record<string, unknown>>;
    const type = request.type;
    if (typeof type !== "string") throw new Error("fake daemon received a command without a type");
    this.chronology.push(`daemon:request:${type}`);

    if (type === "create") {
      if (this.session) throw new Error("a second resident create attempted to replace the shared session");
      if (request.continueRecent !== undefined || request.sessionPath !== undefined) {
        throw new Error("resident continuity must not fall back to recent or named session selection");
      }
      this.createCount += 1;
      const sessionFile = join(this.workspaceDirectory, ".prime-agent", `${SESSION_ID}.jsonl`);
      this.session = Object.freeze({
        summary: Object.freeze({
          id: ACTIVE_SESSION_ID,
          lifecycle: "live",
          activity: "idle",
          isSessionActive: true,
          activeSessionId: ACTIVE_SESSION_ID,
          sessionId: SESSION_ID,
          sessionFile,
          cwd: this.workspaceDirectory,
          isStreaming: false,
          isCompacting: false,
          attachedClients: 0,
          messageCount: 1,
          unfinishedActionCount: 0,
          sessionActions: Object.freeze({ queuedCount: 0, steering: [], followUps: [] }),
        }),
        snapshot: Object.freeze({
          state: Object.freeze({
            activeSessionId: ACTIVE_SESSION_ID,
            sessionId: SESSION_ID,
            sessionFile,
            cwd: this.workspaceDirectory,
            isStreaming: false,
          }),
          messages: Object.freeze([
            Object.freeze({ id: "continuity-message-1", role: "assistant", text: SNAPSHOT_MARKER }),
          ]),
          lastEventSequence: 19,
          lastEventCursor: Object.freeze({ generation: EVENT_GENERATION, sequence: 19 }),
          continuityMarker: SNAPSHOT_MARKER,
        }),
      });
      return { type: "response", command: "create", success: true, data: this.session.summary };
    }

    if (type === "list") {
      if (Object.keys(request).length !== 1) {
        throw new Error("session reattach list must not include name or recent-selection fields");
      }
      this.listCount += 1;
      return {
        type: "response",
        command: "list",
        success: true,
        data: { sessions: this.session ? [this.session.summary] : [] },
      };
    }

    if (type === "kill") {
      this.requireSession(String(request.activeSessionId));
      if (request.activeSessionId !== ACTIVE_SESSION_ID) throw new Error("kill targeted the wrong resident session");
      this.killCount += 1;
      this.session = undefined;
      return { type: "response", command: "kill", success: true };
    }

    throw new Error(`continuity test forbids daemon command ${type}`);
  }

  private requireSession(activeSessionId: string): FakeResidentSession {
    if (!this.session || activeSessionId !== ACTIVE_SESSION_ID) {
      throw new Error(`no exact live fake session ${activeSessionId}`);
    }
    return this.session;
  }
}

function createAdapter(
  store: HostStore,
  daemon: SharedFakePrimeDaemon,
  runtimeModule: PrimeAgentPublicModule,
  paths: RuntimePaths,
): PrimeAgentResidentAdapter {
  return new PrimeAgentResidentAdapter({
    ...paths,
    environment: {},
    loadRuntimeModule: async () => runtimeModule,
    persistBinding: (binding) => daemon.persistThrough(store, binding),
    completeBinding: (binding) => daemon.completeThrough(store, binding),
    spawnFactory: () => daemon.spawnLauncher(),
    connectTimeoutMs: 100,
    startupTimeoutMs: 100,
    requestTimeoutMs: 100,
    wait: async () => undefined,
    now: () => FIXED_TIME,
  });
}

describe("resident continuity across hostd/store relaunch", () => {
  it("reattaches only the exact durable activeSessionId and tombstones it only after explicit end", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "prime-resident-relaunch-proof-"));
    temporaryDirectories.push(dataDirectory);
    const workspace = join(dataDirectory, "actual-workspace");
    await mkdir(workspace, { recursive: true });
    const workspaceDirectory = await realpath(workspace);
    const paths: RuntimePaths = Object.freeze({
      executable: join(dataDirectory, "verified-runtime", "node.exe"),
      cliEntrypoint: join(dataDirectory, "verified-runtime", "prime-agent", "dist", "bundle", "cli.js"),
      daemonWorkingDirectory: join(dataDirectory, "daemon-state"),
      socketPath: join(dataDirectory, "prime-agent-daemon.sock"),
    });

    const firstStore = new HostStore(dataDirectory);
    await firstStore.initialize({ seed: true });
    await expect(firstStore.registerWorkspaceAuthority({
      threadId: THREAD_ID,
      executionGenerationId: EXECUTION_GENERATION_ID,
      workspaceDirectory,
    })).resolves.toBe(workspaceDirectory);

    const daemon = new SharedFakePrimeDaemon(paths, workspaceDirectory);
    const runtimeModule = daemon.runtimeModule();
    expect(daemon.hello).toEqual({
      type: "daemon_hello",
      socketPath: paths.socketPath,
      protocol: {
        name: "prime-agent.daemon",
        version: 7,
      },
      schemaId: "protocol-7-schema-13-816309b1cd50",
      schemaRevision: 13,
      appVersion: "0.7.0",
      runtime: {
        buildId: "be9e2fa-dirty",
        executablePath: paths.executable,
        entrypointPath: paths.cliEntrypoint,
      },
      supervisorGeneration: SUPERVISOR_GENERATION,
      clientId: "continuity-test-client",
      serverCapabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES],
    });

    const adapterA = createAdapter(firstStore, daemon, runtimeModule, paths);
    const connectionA = await adapterA.createResident({
      threadId: THREAD_ID,
      executionGenerationId: EXECUTION_GENERATION_ID,
      workspaceDirectory,
      session: { kind: "new" },
      sessionName: SESSION_NAME,
    });
    const exactBinding = connectionA.binding;
    const firstSnapshot = daemon.initialSnapshots[0] as Readonly<Record<string, unknown>>;

    expect(exactBinding).toMatchObject({
      threadId: THREAD_ID,
      executionGenerationId: EXECUTION_GENERATION_ID,
      workspaceDirectory,
      activeSessionId: ACTIVE_SESSION_ID,
      sessionId: SESSION_ID,
      runtime: {
        protocolName: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolName,
        protocolVersion: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion,
        schemaRevision: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision,
        schemaId: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId,
        supervisorGeneration: SUPERVISOR_GENERATION,
      },
    });
    expect(firstSnapshot).toMatchObject({
      state: { sessionId: SESSION_ID, cwd: workspaceDirectory },
      lastEventCursor: { generation: EVENT_GENERATION, sequence: 19 },
      continuityMarker: SNAPSHOT_MARKER,
    });
    expect(await firstStore.getResidentSessionBinding(THREAD_ID, EXECUTION_GENERATION_ID)).toEqual(exactBinding);
    expect(daemon.chronology.indexOf(`store:persist:${ACTIVE_SESSION_ID}`)).toBeLessThan(
      daemon.chronology.indexOf(`daemon:attach:${ACTIVE_SESSION_ID}`),
    );

    await connectionA.detach();
    await adapterA.close();
    expect(daemon.createCount).toBe(1);
    expect(daemon.killCount).toBe(0);
    expect(daemon.connectionDisposeCount).toBe(1);
    expect(daemon.requests.map((request) => (request as { type?: string }).type)).toEqual(["create"]);

    const relaunchedStore = new HostStore(dataDirectory);
    await relaunchedStore.initialize();
    const reloadedBinding = await relaunchedStore.getResidentSessionBinding(THREAD_ID, EXECUTION_GENERATION_ID);
    expect(reloadedBinding).toEqual(exactBinding);
    if (!reloadedBinding) throw new Error("hostd relaunch did not restore the exact active resident binding");
    expect(await relaunchedStore.listResidentSessionBindings()).toEqual([exactBinding]);

    const adapterB = createAdapter(relaunchedStore, daemon, runtimeModule, paths);
    const connectionB = await adapterB.attachResident(reloadedBinding);
    const secondSnapshot = daemon.initialSnapshots[1] as Readonly<Record<string, unknown>>;

    expect(connectionB.binding).toEqual(exactBinding);
    expect(connectionB.binding.sessionId).toBe(SESSION_ID);
    expect(connectionB.binding.executionGenerationId).toBe(EXECUTION_GENERATION_ID);
    expect(connectionB.binding.workspaceDirectory).toBe(workspaceDirectory);
    expect(connectionB.binding.runtime.supervisorGeneration).toBe(SUPERVISOR_GENERATION);
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(secondSnapshot).toMatchObject({
      state: { sessionId: SESSION_ID, cwd: workspaceDirectory },
      lastEventCursor: { generation: EVENT_GENERATION, sequence: 19 },
      continuityMarker: SNAPSHOT_MARKER,
    });
    expect(daemon.attachActiveSessionIds).toEqual([ACTIVE_SESSION_ID, exactBinding.activeSessionId]);
    expect(daemon.attachOptions).toEqual([
      expect.objectContaining({ ownedSession: false, closeClientOnDispose: true }),
      expect.objectContaining({ ownedSession: false, closeClientOnDispose: true }),
    ]);
    expect(daemon.createCount).toBe(1);
    expect(daemon.listCount).toBe(1);

    await connectionB.detach();
    await adapterB.close();
    expect(daemon.createCount).toBe(1);
    expect(daemon.killCount).toBe(0);
    expect(daemon.connectionDisposeCount).toBe(2);
    expect(daemon.requests.map((request) => (request as { type?: string }).type)).toEqual(["create", "list"]);

    const endAdapter = createAdapter(relaunchedStore, daemon, runtimeModule, paths);
    const endConnection = await endAdapter.attachResident(reloadedBinding);
    await endConnection.endSession();
    await endAdapter.close();

    expect(daemon.createCount).toBe(1);
    expect(daemon.killCount).toBe(1);
    expect(daemon.connectionDisposeCount).toBe(3);
    expect(daemon.launcherSpawnCount).toBe(0);
    expect(daemon.launcherKillCount).toBe(0);
    expect(daemon.requests.map((request) => (request as { type?: string }).type)).toEqual([
      "create",
      "list",
      "list",
      "kill",
    ]);
    expect(daemon.requests.some((request) => {
      const type = (request as { type?: string }).type;
      return type === "prompt" || type === "steer" || type === "followUp" || type === "abort" || type === "end";
    })).toBe(false);

    const bindingFile = JSON.parse(await readFile(relaunchedStore.paths.residentSessionBindings, "utf8")) as {
      records: Array<{ state: string; binding: ResidentSessionBinding; completedAt?: string }>;
    };
    expect(bindingFile.records).toEqual([
      {
        state: "completed",
        binding: exactBinding,
        completedAt: expect.any(String),
      },
    ]);

    const afterEndRestart = new HostStore(dataDirectory);
    await afterEndRestart.initialize();
    await expect(afterEndRestart.listResidentSessionBindings()).resolves.toEqual([]);
    await expect(afterEndRestart.getResidentSessionBinding(THREAD_ID, EXECUTION_GENERATION_ID)).resolves.toBeUndefined();
  });
});
