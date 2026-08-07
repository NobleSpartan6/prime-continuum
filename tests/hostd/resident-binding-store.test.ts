import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteJson } from "../../src/hostd/atomic-files";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import { HostStore, HostStoreError } from "../../src/hostd/store";
import { PROTOCOL_VERSION, type CommandEnvelope, type ThreadProjectionSnapshot } from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ store: HostStore; directory: string; workspaceDirectory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "prime-resident-store-test-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = new HostStore(directory);
  await store.initialize({ seed: true });
  return { store, directory, workspaceDirectory: await realpath(workspace) };
}

function binding(
  workspaceDirectory: string,
  overrides: Partial<ResidentSessionBinding> = {},
): ResidentSessionBinding {
  return {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId: "demo-thread",
    executionGenerationId: "demo-execution-1",
    workspaceDirectory,
    activeSessionId: "active-session-1",
    sessionId: "session-1",
    sessionFile: join(workspaceDirectory, ".prime-agent", "session-1.jsonl"),
    boundAt: "2026-08-07T12:00:00.000Z",
    runtime: {
      releaseVersion: PINNED_PRIME_AGENT_RUNTIME.releaseVersion,
      appVersion: PINNED_PRIME_AGENT_RUNTIME.expectedAppVersion,
      protocolName: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolName,
      protocolVersion: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion,
      schemaRevision: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision,
      schemaId: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId,
      capabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES],
      runtimeBuildId: PINNED_PRIME_AGENT_RUNTIME.runtimeBuildId,
    },
    ...overrides,
  };
}

async function expectStoreError(operation: Promise<unknown>, code: string): Promise<HostStoreError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(HostStoreError);
    expect(error).toMatchObject({ code });
    return error as HostStoreError;
  }
  throw new Error(`Expected HostStoreError ${code}`);
}

async function captureStoreError(operation: Promise<unknown>, code: string): Promise<HostStoreError> {
  return expectStoreError(operation, code);
}

async function registerDemoWorkspace(store: HostStore, workspaceDirectory: string): Promise<string> {
  return store.registerWorkspaceAuthority({
    threadId: "demo-thread",
    executionGenerationId: "demo-execution-1",
    workspaceDirectory,
  });
}

describe("HostStore resident workspace authority", () => {
  it("persists a canonical private binding, refreshes it, and never resurrects it after completion", async () => {
    const { store, directory, workspaceDirectory } = await fixture();
    const canonical = await registerDemoWorkspace(store, workspaceDirectory);
    expect(canonical).toBe(workspaceDirectory);
    await expect(store.resolveWorkspaceDirectory("demo-thread", "demo-execution-1")).resolves.toBe(canonical);
    await expect(store.getResidentSessionBinding("demo-thread", "demo-execution-1")).resolves.toBeUndefined();

    const initial = binding(canonical);
    await store.persistResidentSessionBinding(initial);
    expect(await store.listResidentSessionBindings()).toEqual([initial]);

    const restarted = new HostStore(directory);
    await restarted.initialize();
    const restored = await restarted.getResidentSessionBinding("demo-thread", "demo-execution-1");
    expect(restored).toEqual(initial);
    expect(Object.isFrozen(restored)).toBe(true);

    const refreshed = binding(canonical, {
      runtime: { ...initial.runtime, supervisorGeneration: "supervisor-generation-2" },
    });
    await restarted.persistResidentSessionBinding(refreshed);
    expect(await restarted.listResidentSessionBindings()).toEqual([refreshed]);
    await restarted.completeResidentSessionBinding(refreshed);
    await restarted.completeResidentSessionBinding(refreshed);
    expect(await restarted.listResidentSessionBindings()).toEqual([]);

    const afterEndRestart = new HostStore(directory);
    await afterEndRestart.initialize();
    expect(await afterEndRestart.getResidentSessionBinding("demo-thread", "demo-execution-1")).toBeUndefined();
    expect(await afterEndRestart.listResidentSessionBindings()).toEqual([]);
    await expectStoreError(afterEndRestart.persistResidentSessionBinding(refreshed), "RESIDENT_BINDING_COMPLETED");

    const persisted = JSON.parse(await readFile(store.paths.residentSessionBindings, "utf8")) as {
      records: Array<{ state: string; binding: ResidentSessionBinding; completedAt?: string }>;
    };
    expect(persisted.records).toEqual([
      expect.objectContaining({ state: "completed", binding: refreshed, completedAt: expect.any(String) }),
    ]);
    expect(await readFile(store.paths.projects, "utf8")).not.toContain(canonical);
    if (process.platform !== "win32") {
      expect((await stat(store.paths.workspaceAuthorities)).mode & 0o077).toBe(0);
      expect((await stat(store.paths.residentSessionBindings)).mode & 0o077).toBe(0);
    }
  });

  it("rejects stale generations, unavailable paths, and workspace-path substitution", async () => {
    const { store, directory, workspaceDirectory } = await fixture();
    await expectStoreError(
      store.resolveWorkspaceDirectory("demo-thread", "demo-execution-1"),
      "WORKSPACE_AUTHORITY_NOT_FOUND",
    );
    await expectStoreError(
      store.registerWorkspaceAuthority({
        threadId: "demo-thread",
        executionGenerationId: "stale-generation",
        workspaceDirectory,
      }),
      "STALE_EXECUTION_GENERATION",
    );
    await expectStoreError(
      store.registerWorkspaceAuthority({
        threadId: "missing-thread",
        executionGenerationId: "demo-execution-1",
        workspaceDirectory,
      }),
      "THREAD_NOT_FOUND",
    );
    await expectStoreError(
      store.registerWorkspaceAuthority({
        threadId: "demo-thread",
        executionGenerationId: "demo-execution-1",
        workspaceDirectory: join(directory, "missing-workspace"),
      }),
      "WORKSPACE_PATH_UNAVAILABLE",
    );

    await registerDemoWorkspace(store, workspaceDirectory);
    const otherWorkspace = join(directory, "other-workspace");
    await mkdir(otherWorkspace);
    await expectStoreError(
      store.persistResidentSessionBinding(binding(await realpath(otherWorkspace))),
      "RESIDENT_BINDING_PATH_MISMATCH",
    );
    await expectStoreError(
      store.persistResidentSessionBinding(binding(workspaceDirectory, { executionGenerationId: "stale-generation" })),
      "STALE_EXECUTION_GENERATION",
    );
  });

  it("rejects cross-thread session reuse and completes only the exact active binding", async () => {
    const { store, workspaceDirectory } = await fixture();
    await registerDemoWorkspace(store, workspaceDirectory);
    await addSecondThread(store);
    await store.registerWorkspaceAuthority({
      threadId: "second-thread",
      executionGenerationId: "demo-execution-2",
      workspaceDirectory,
    });

    const first = binding(workspaceDirectory);
    await store.persistResidentSessionBinding(first);
    const reused = binding(workspaceDirectory, {
      threadId: "second-thread",
      executionGenerationId: "demo-execution-2",
      sessionId: "different-session",
      sessionFile: join(workspaceDirectory, ".prime-agent", "different-session.jsonl"),
    });
    await expectStoreError(store.persistResidentSessionBinding(reused), "RESIDENT_SESSION_REUSED");

    const second = binding(workspaceDirectory, {
      threadId: "second-thread",
      executionGenerationId: "demo-execution-2",
      activeSessionId: "active-session-2",
      sessionId: "session-2",
      sessionFile: join(workspaceDirectory, ".prime-agent", "session-2.jsonl"),
    });
    await store.persistResidentSessionBinding(second);
    await expectStoreError(
      store.completeResidentSessionBinding({ ...first, activeSessionId: "forged-active-session" }),
      "RESIDENT_BINDING_CONFLICT",
    );
    expect(await store.listResidentSessionBindings()).toEqual([first, second]);

    await store.completeResidentSessionBinding(first);
    expect(await store.listResidentSessionBindings()).toEqual([second]);
    await expectStoreError(store.persistResidentSessionBinding(first), "RESIDENT_BINDING_COMPLETED");
  });

  it("degrades only resident continuity when an active binding is stale against durable thread authority", async () => {
    const { store, directory, workspaceDirectory } = await fixture();
    await registerDemoWorkspace(store, workspaceDirectory);
    await store.persistResidentSessionBinding(binding(workspaceDirectory));
    const catalog = await store.getCatalogSnapshot();
    const thread = catalog.threads[0];
    if (!thread) throw new Error("seed thread missing");
    const changedGeneration = "unexpected-execution-generation";
    await atomicWriteJson(store.paths.threads, {
      version: 1,
      threads: [
        {
          ...thread,
          currentLocation: { ...thread.currentLocation, executionGenerationId: changedGeneration },
          lastKnownCursor: thread.lastKnownCursor
            ? { ...thread.lastKnownCursor, executionGenerationId: changedGeneration }
            : undefined,
        },
      ],
    });

    const restarted = new HostStore(directory);
    await expect(restarted.initialize()).resolves.toEqual({ seeded: false });
    expect((await restarted.getCatalogSnapshot()).threads[0]?.currentLocation.executionGenerationId).toBe(
      changedGeneration,
    );
    await expect(restarted.getThreadSnapshot("demo-thread")).resolves.toBeDefined();
    await expectStoreError(restarted.listResidentSessionBindings(), "RESIDENT_SUBSYSTEM_DEGRADED");
  });

  it("retains a malformed resident file while base catalog and snapshots remain healthy", async () => {
    const { store, directory, workspaceDirectory } = await fixture();
    const malformed = Buffer.from("{malformed-resident-state", "utf8");
    await writeFile(store.paths.residentSessionBindings, malformed);

    const restarted = new HostStore(directory);
    await expect(restarted.initialize()).resolves.toEqual({ seeded: false });
    await expect(restarted.getCatalogSnapshot()).resolves.toMatchObject({
      projects: [expect.objectContaining({ projectId: "demo-project" })],
      threads: [expect.objectContaining({ threadId: "demo-thread" })],
    });
    await expect(restarted.getThreadSnapshot("demo-thread")).resolves.toMatchObject({
      thread: { threadId: "demo-thread" },
    });
    expect(await readFile(store.paths.residentSessionBindings)).toEqual(malformed);

    const retained = await captureStoreError(
      restarted.listResidentSessionBindings(),
      "RESIDENT_SUBSYSTEM_DEGRADED",
    );
    const candidate = binding(workspaceDirectory);
    const operations: Array<() => Promise<unknown>> = [
      () => registerDemoWorkspace(restarted, workspaceDirectory),
      () => restarted.resolveWorkspaceDirectory("demo-thread", "demo-execution-1"),
      () => restarted.getResidentSessionBinding("demo-thread", "demo-execution-1"),
      () => restarted.persistResidentSessionBinding(candidate),
      () => restarted.completeResidentSessionBinding(candidate),
    ];
    for (const operation of operations) {
      try {
        await operation();
        throw new Error("Expected retained resident subsystem fault");
      } catch (error) {
        expect(error).toBe(retained);
      }
    }
  });

  it("retains an unavailable active workspace fault until repair and restart without taking down base state", async () => {
    const { store, directory, workspaceDirectory } = await fixture();
    await registerDemoWorkspace(store, workspaceDirectory);
    const active = binding(workspaceDirectory);
    await store.persistResidentSessionBinding(active);
    await rm(workspaceDirectory, { recursive: true, force: true });

    const restarted = new HostStore(directory);
    await expect(restarted.initialize()).resolves.toEqual({ seeded: false });
    await expect(restarted.getCatalogSnapshot()).resolves.toMatchObject({
      projects: [expect.objectContaining({ projectId: "demo-project" })],
      threads: [expect.objectContaining({ threadId: "demo-thread" })],
    });
    await expect(restarted.getThreadSnapshot("demo-thread")).resolves.toBeDefined();
    const retained = await captureStoreError(
      restarted.listResidentSessionBindings(),
      "RESIDENT_SUBSYSTEM_DEGRADED",
    );

    await mkdir(workspaceDirectory, { recursive: true });
    try {
      await restarted.listResidentSessionBindings();
      throw new Error("Expected retained resident subsystem fault");
    } catch (error) {
      expect(error).toBe(retained);
    }

    const repairedRestart = new HostStore(directory);
    await repairedRestart.initialize();
    expect(await repairedRestart.listResidentSessionBindings()).toEqual([active]);
  });

  it("prevents an active resident thread from changing execution generation", async () => {
    const { store, workspaceDirectory } = await fixture();
    await registerDemoWorkspace(store, workspaceDirectory);
    await store.persistResidentSessionBinding(binding(workspaceDirectory));
    const snapshot = await store.getThreadSnapshot("demo-thread");
    const changed = snapshotWithThread(snapshot, "demo-thread", "changed-execution-generation");
    await expectStoreError(store.upsertThread(changed.thread, changed), "RESIDENT_SESSION_ACTIVE");
    expect((await store.getThreadSnapshot("demo-thread")).thread.currentLocation.executionGenerationId).toBe(
      "demo-execution-1",
    );
  });
});

describe("HostStore abort admission", () => {
  it("rejects offline aborts and keeps a live abort admitted until gateway acknowledgement", async () => {
    const { store } = await fixture();
    const host = await store.getHost();
    const before = await store.getThreadSnapshot("demo-thread");
    const offline = abortCommand(host.hostId, "offline-abort");
    const offlineAdmission = await store.admitCommand(offline, false);
    expect(offlineAdmission.receipt).toMatchObject({
      status: "rejected",
      error: { code: "LIVE_CONNECTION_REQUIRED", retryable: true },
    });
    expect(await store.getThreadSnapshot("demo-thread")).toEqual(before);

    const live = abortCommand(host.hostId, "live-abort");
    const liveAdmission = await store.admitCommand(live, true);
    expect(liveAdmission.receipt).toMatchObject({
      status: "admitted",
      queuePosition: undefined,
      message: "Abort admitted for live dispatch",
    });
    expect(await store.getThreadSnapshot("demo-thread")).toEqual(before);
    expect((await store.reconcileCommands([live])).receipts[0]?.status).toBe("admitted");

    const journalStatuses = (await readFile(store.paths.commandJournal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { status: string }).status);
    expect(journalStatuses).toEqual(["received", "rejected", "received", "admitted"]);

    const acknowledged = await store.updateCommandReceipt(live, {
      status: "completed",
      queuePosition: undefined,
      message: "Prime Agent handled the command",
    });
    expect(acknowledged.status).toBe("completed");
  });
});

async function addSecondThread(store: HostStore): Promise<void> {
  const source = await store.getThreadSnapshot("demo-thread");
  const snapshot = snapshotWithThread(source, "second-thread", "demo-execution-2");
  await store.upsertThread(snapshot.thread, snapshot);
}

function snapshotWithThread(
  source: ThreadProjectionSnapshot,
  threadId: string,
  executionGenerationId: string,
): ThreadProjectionSnapshot {
  const latestCursor = {
    ...source.latestCursor,
    threadId,
    executionGenerationId,
    generation: `${threadId}-cursor-generation`,
  };
  const thread = {
    ...source.thread,
    threadId,
    title: threadId === source.thread.threadId ? source.thread.title : "Second durable thread",
    currentLocation: { ...source.thread.currentLocation, executionGenerationId },
    lastKnownCursor: latestCursor,
  };
  return {
    ...source,
    generatedAt: new Date().toISOString(),
    thread,
    latestCursor,
  };
}

function abortCommand(hostId: string, commandId: string): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "device-test",
    commandId,
    expectedHostId: hostId,
    threadId: "demo-thread",
    issuedAt: new Date().toISOString(),
    expectedExecutionGenerationId: "demo-execution-1",
    command: { kind: "abort", reason: "Stop the active task" },
  };
}
