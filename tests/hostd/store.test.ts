import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type CommandEnvelope, type SavedProject } from "../../src/shared/protocol";
import { atomicWriteJsonIfAbsent, type AtomicCreateFaultPoint } from "../../src/hostd/atomic-files";
import { HostStore, type HostStoreOptions } from "../../src/hostd/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryStore(
  options: { seed?: boolean; storeOptions?: HostStoreOptions } = {},
): Promise<{ store: HostStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "prime-hostd-test-"));
  temporaryDirectories.push(directory);
  const store = new HostStore(directory, options.storeOptions);
  await store.initialize({ seed: options.seed });
  return { store, directory };
}

function promptCommand(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "device-test",
    commandId: "command-test",
    expectedHostId: "host-test",
    threadId: "demo-thread",
    issuedAt: new Date().toISOString(),
    expectedExecutionGenerationId: "demo-execution-1",
    command: { kind: "prompt", text: "Please inspect the project." },
    ...overrides,
  };
}

describe("HostStore", () => {
  it("does not invent catalog data until the explicit honest seed", async () => {
    const { store } = await temporaryStore();
    expect((await store.getCatalogSnapshot()).projects).toEqual([]);

    const seeded = await store.seedIfEmpty();
    expect(seeded.seeded).toBe(true);
    const catalog = await store.getCatalogSnapshot();
    expect(catalog.projects).toHaveLength(1);
    expect(catalog.threads[0]?.recap).toContain("No agent run has started");
    const snapshot = await store.getThreadSnapshot("demo-thread");
    expect(snapshot.materializedRecentBlocks[0]?.text).toContain("no simulated agent output");
    expect((await store.seedIfEmpty()).seeded).toBe(false);
  });

  it("durably deduplicates commands by deviceId and commandId and reconciles after restart", async () => {
    const { store, directory } = await temporaryStore({ seed: true });
    const command = promptCommand();
    const first = await store.admitCommand(command, false);
    const duplicate = await store.admitCommand(command, false);
    expect(first.duplicate).toBe(false);
    expect(first.receipt.status).toBe("admitted");
    expect(duplicate).toEqual({ receipt: first.receipt, duplicate: true });

    const restarted = new HostStore(directory);
    await restarted.initialize();
    const reconciliation = await restarted.reconcileCommands([
      { deviceId: command.deviceId, commandId: command.commandId },
      { deviceId: command.deviceId, commandId: "unknown-command" },
    ]);
    expect(reconciliation.receipts).toEqual([first.receipt]);
    expect(reconciliation.unknown).toEqual([{ deviceId: command.deviceId, commandId: "unknown-command" }]);

    const journal = await readFile(store.paths.commandJournal, "utf8");
    expect(journal.trim().split("\n")).toHaveLength(2);
    expect(journal).toContain('"status":"received"');
    expect(journal).toContain('"status":"admitted"');
  });

  it("rejects a command for a stale execution generation and records the rejection", async () => {
    const { store } = await temporaryStore({ seed: true });
    const result = await store.admitCommand(
      promptCommand({ commandId: "stale-command", expectedExecutionGenerationId: "older-generation" }),
    );
    expect(result.receipt.status).toBe("rejected");
    expect(result.receipt.error?.code).toBe("STALE_EXECUTION_GENERATION");
  });

  it("checkpoints and verifies an executable clean handoff before switching authority", async () => {
    const { store } = await temporaryStore({ seed: true });
    const catalog = await store.getCatalogSnapshot();
    const source = catalog.projects[0];
    if (!source) throw new Error("seed project missing");
    const repositoryIdentity = {
      version: 1 as const,
      canonicalRemotes: ["ssh://git.example/prime/demo.git"],
      defaultBranch: "main",
    };
    await store.upsertProject({ ...source, repositoryIdentity });
    const destination: SavedProject = {
      projectId: "destination-project",
      hostId: "destination-host",
      workspaceId: "destination-workspace",
      displayName: "Destination demo",
      repositoryIdentity,
      lastOpenedAt: new Date().toISOString(),
    };
    await store.upsertProject(destination);

    const plan = await store.createHandoffPlan({
      threadId: "demo-thread",
      sourceGenerationId: "demo-execution-1",
      destinationHostId: destination.hostId,
      destinationProjectId: destination.projectId,
      behaviorIfRunning: "interrupt",
    });
    expect(plan.repositoryMatch).toBe("exact");
    expect(plan.executable).toBe(true);

    const command = { deviceId: "device-test", commandId: "handoff-command" };
    const committed = await store.commitHandoff(plan.handoffId, command);
    expect(committed.receipt.status).toBe("complete");
    expect(committed.progress.map((item) => item.phase)).toEqual([
      "quiescing",
      "checkpointing",
      "transferring",
      "materializing",
      "verifying",
      "switching_authority",
      "complete",
    ]);
    expect((await store.getThreadSnapshot("demo-thread")).thread.currentLocation.hostId).toBe("destination-host");
    expect(await store.commitHandoff(plan.handoffId, command)).toEqual({ ...committed, duplicate: true });
    expect((await store.reconcileCommands([command])).receipts[0]?.status).toBe("completed");
  });

  it.each(["after_open", "after_write", "after_sync", "after_close"] satisfies AtomicCreateFaultPoint[])(
    "fails an executable handoff closed when checkpoint creation faults at %s",
    async (faultPoint) => {
      let injected = false;
      const { store } = await temporaryStore({
        seed: true,
        storeOptions: {
          handoffCheckpointWriter: (path, checkpoint) =>
            atomicWriteJsonIfAbsent(path, checkpoint, undefined, {
              faultInjector(point) {
                if (!injected && point === faultPoint) {
                  injected = true;
                  throw new Error(`simulated checkpoint ${point} failure`);
                }
              },
            }),
        },
      });
      const plan = await createExecutableHandoffPlan(store);
      const sourceLocation = (await store.getThreadSnapshot("demo-thread")).thread.currentLocation;

      const result = await store.commitHandoff(plan.handoffId, {
        deviceId: "device-test",
        commandId: `handoff-${faultPoint}`,
      });

      expect(result.receipt).toMatchObject({
        status: "failed",
        sourceCheckpointRetained: false,
        error: { code: "HANDOFF_CHECKPOINT_FAILED", retryable: true },
      });
      expect(result.progress.map((item) => item.phase)).toEqual(["quiescing", "failed"]);
      expect(await readdir(store.paths.checkpoints)).toEqual([]);
      expect((await store.getThreadSnapshot("demo-thread")).thread.currentLocation).toEqual(sourceLocation);
    },
  );

  it("reconfirms an ambiguous publication before continuing the handoff", async () => {
    let writes = 0;
    let injected = false;
    const { store } = await temporaryStore({
      seed: true,
      storeOptions: {
        handoffCheckpointWriter: async (path, checkpoint) => {
          writes += 1;
          return atomicWriteJsonIfAbsent(path, checkpoint, undefined, {
            faultInjector(point) {
              if (!injected && point === "after_link") {
                injected = true;
                throw new Error("simulated checkpoint publication uncertainty");
              }
            },
          });
        },
      },
    });
    const plan = await createExecutableHandoffPlan(store);

    const result = await store.commitHandoff(plan.handoffId, {
      deviceId: "device-test",
      commandId: "handoff-ambiguous-publication",
    });

    expect(writes).toBe(2);
    expect(result.receipt.status).toBe("complete");
    expect(result.progress.map((item) => item.phase)).toContain("checkpointing");
    expect((await store.getThreadSnapshot("demo-thread")).thread.currentLocation.hostId).toBe("destination-host");
  });

  it("rejects an existing checkpoint unless its canonical persisted bytes match", async () => {
    const { store } = await temporaryStore({
      seed: true,
      storeOptions: {
        async handoffCheckpointWriter(path) {
          await atomicWriteJsonIfAbsent(path, { version: 1, checkpointId: "conflicting-checkpoint" });
          return false;
        },
      },
    });
    const plan = await createExecutableHandoffPlan(store);

    const result = await store.commitHandoff(plan.handoffId, {
      deviceId: "device-test",
      commandId: "handoff-conflicting-checkpoint",
    });

    expect(result.receipt).toMatchObject({
      status: "failed",
      sourceCheckpointRetained: false,
      error: { code: "HANDOFF_CHECKPOINT_CONFLICT", retryable: false },
    });
    expect(result.progress.map((item) => item.phase)).toEqual(["quiescing", "failed"]);
    expect((await store.getThreadSnapshot("demo-thread")).thread.currentLocation.executionGenerationId).toBe(
      "demo-execution-1",
    );
  });

  it("continues an executable handoff when an existing checkpoint exactly matches", async () => {
    const { store } = await temporaryStore({
      seed: true,
      storeOptions: {
        async handoffCheckpointWriter(path, checkpoint) {
          await atomicWriteJsonIfAbsent(path, checkpoint);
          return false;
        },
      },
    });
    const plan = await createExecutableHandoffPlan(store);

    const result = await store.commitHandoff(plan.handoffId, {
      deviceId: "device-test",
      commandId: "handoff-matching-checkpoint",
    });

    expect(result.receipt.status).toBe("complete");
    expect(result.progress.map((item) => item.phase)).toContain("checkpointing");
    expect((await store.getThreadSnapshot("demo-thread")).thread.currentLocation.hostId).toBe("destination-host");
  });

  it("keeps the source authoritative when handoff preflight is not executable", async () => {
    const { store } = await temporaryStore({ seed: true });
    const plan = await store.createHandoffPlan({
      threadId: "demo-thread",
      sourceGenerationId: "demo-execution-1",
      destinationHostId: "unknown-host",
      destinationProjectId: "unknown-project",
      behaviorIfRunning: "interrupt",
    });
    expect(plan.executable).toBe(false);

    const result = await store.commitHandoff(plan.handoffId, {
      deviceId: "device-test",
      commandId: "failed-handoff-command",
    });
    expect(result.receipt).toMatchObject({
      status: "failed",
      sourceCheckpointRetained: false,
      error: { code: "HANDOFF_NOT_EXECUTABLE" },
    });
    expect(result.receipt.checkpointId).toBeUndefined();
    expect((await store.getThreadSnapshot("demo-thread")).thread.currentLocation.executionGenerationId).toBe(
      "demo-execution-1",
    );
  });
});

async function createExecutableHandoffPlan(store: HostStore) {
  const catalog = await store.getCatalogSnapshot();
  const source = catalog.projects[0];
  if (!source) throw new Error("seed project missing");
  const repositoryIdentity = {
    version: 1 as const,
    canonicalRemotes: ["ssh://git.example/prime/demo.git"],
    defaultBranch: "main",
  };
  await store.upsertProject({ ...source, repositoryIdentity });
  const destination: SavedProject = {
    projectId: "destination-project",
    hostId: "destination-host",
    workspaceId: "destination-workspace",
    displayName: "Destination demo",
    repositoryIdentity,
    lastOpenedAt: new Date().toISOString(),
  };
  await store.upsertProject(destination);
  return store.createHandoffPlan({
    threadId: "demo-thread",
    sourceGenerationId: "demo-execution-1",
    destinationHostId: destination.hostId,
    destinationProjectId: destination.projectId,
    behaviorIfRunning: "interrupt",
  });
}
