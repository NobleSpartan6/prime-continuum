import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResidentProjectionSnapshot } from "../../src/hostd/resident-projection";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import {
  HostStore,
  type HostStoreOptions,
  type ResidentProjectionFaultPoint,
} from "../../src/hostd/store";

const temporaryDirectories: string[] = [];
const faultPoints: ResidentProjectionFaultPoint[] = ["after_prepare", "after_snapshot", "after_threads"];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("resident projection publication recovery", () => {
  it.each(faultPoints)("repairs snapshot/catalog consistency after a crash at %s", async (faultPoint) => {
    const fixture = await createFixture();
    const baselineSnapshot = await fixture.bootstrap.getThreadSnapshot("demo-thread");
    const baselineCatalogThread = (await fixture.bootstrap.getCatalogSnapshot()).threads.find(
      (thread) => thread.threadId === "demo-thread",
    );
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentProjectionFaultInjector(point) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated resident projection crash at ${point}`);
        }
      },
    });
    await crashing.initialize();

    await expect(
      crashing.publishResidentProjectionSnapshot(
        fixture.binding,
        projection(fixture.binding, 77, "The resident runtime is authoritative."),
      ),
    ).rejects.toThrow(`simulated resident projection crash at ${faultPoint}`);
    await expect(crashing.getCatalogSnapshot()).rejects.toMatchObject({ code: "STORE_NOT_INITIALIZED" });

    const transaction = await readPendingProjectionTransaction(crashing);
    const onDiskSnapshot = await readSnapshot(crashing, "demo-thread");
    const onDiskCatalogThread = await readCatalogThread(crashing, "demo-thread");
    if (faultPoint === "after_prepare") {
      expect(onDiskSnapshot).toEqual(baselineSnapshot);
      expect(onDiskCatalogThread).toEqual(baselineCatalogThread);
    } else if (faultPoint === "after_snapshot") {
      expect(onDiskSnapshot).toEqual(transaction.snapshot);
      expect(onDiskCatalogThread).toEqual(baselineCatalogThread);
    } else {
      expect(onDiskSnapshot).toEqual(transaction.snapshot);
      expect(onDiskCatalogThread).toEqual(transaction.snapshot.thread);
    }

    const recovered = new HostStore(fixture.directory);
    await recovered.initialize();
    const recoveredSnapshot = await recovered.getThreadSnapshot("demo-thread");
    const recoveredCatalogThread = (await recovered.getCatalogSnapshot()).threads.find(
      (thread) => thread.threadId === "demo-thread",
    );
    expect(recoveredSnapshot).toEqual(transaction.snapshot);
    expect(recoveredCatalogThread).toEqual(recoveredSnapshot.thread);
    expect(recoveredSnapshot.thread).toMatchObject({
      recap: "The resident runtime is authoritative.",
      updatedAt: recoveredSnapshot.generatedAt,
      lastKnownCursor: recoveredSnapshot.latestCursor,
    });
    expect(await readdir(recovered.paths.residentProjectionTransactions)).toEqual([]);
  });

  it("clears a stale recap while advancing snapshot and catalog to the same authoritative cursor", async () => {
    const fixture = await createFixture();
    const first = await fixture.bootstrap.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, 78, "A recap that must not survive the next snapshot."),
    );
    expect(first.thread.recap).toBe("A recap that must not survive the next snapshot.");

    const second = await fixture.bootstrap.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, 79),
    );
    const catalogThread = (await fixture.bootstrap.getCatalogSnapshot()).threads.find(
      (thread) => thread.threadId === "demo-thread",
    );
    expect(second.thread).not.toHaveProperty("recap");
    expect(second.thread.updatedAt).toBe(second.generatedAt);
    expect(second.thread.lastKnownCursor).toEqual(second.latestCursor);
    expect(catalogThread).toEqual(second.thread);
    expect(JSON.parse(await readFile(fixture.bootstrap.paths.threads, "utf8"))).not.toHaveProperty(
      "threads.0.recap",
    );
  });

  it("refuses to replay a prepared projection after the exact active binding changes", async () => {
    const fixture = await createFixture();
    const baselineSnapshot = await fixture.bootstrap.getThreadSnapshot("demo-thread");
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentProjectionFaultInjector(point) {
        if (!injected && point === "after_prepare") {
          injected = true;
          throw new Error("simulated pre-materialization crash");
        }
      },
    });
    await crashing.initialize();
    await expect(
      crashing.publishResidentProjectionSnapshot(
        fixture.binding,
        projection(fixture.binding, 80, "This stale binding must never publish."),
      ),
    ).rejects.toThrow("simulated pre-materialization crash");

    const bindingFile = JSON.parse(await readFile(crashing.paths.residentSessionBindings, "utf8")) as {
      version: 1;
      records: Array<{ state: "active"; binding: ResidentSessionBinding }>;
    };
    const record = bindingFile.records[0];
    if (!record) throw new Error("active resident binding fixture missing");
    record.binding = { ...record.binding, boundAt: "2026-08-07T12:00:01.000Z" };
    await writeFile(crashing.paths.residentSessionBindings, `${JSON.stringify(bindingFile)}\n`, "utf8");

    const restarted = new HostStore(fixture.directory);
    await expect(restarted.initialize()).rejects.toMatchObject({
      code: "RESIDENT_PROJECTION_BINDING_MISMATCH",
    });
    expect(await readSnapshot(restarted, "demo-thread")).toEqual(baselineSnapshot);
    expect(await readdir(restarted.paths.residentProjectionTransactions)).toHaveLength(1);
  });
});

async function createFixture(options: HostStoreOptions = {}): Promise<{
  directory: string;
  bootstrap: HostStore;
  binding: ResidentSessionBinding;
}> {
  const directory = await mkdtemp(join(tmpdir(), "prime-resident-projection-publication-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const workspaceDirectory = await realpath(workspace);
  const bootstrap = new HostStore(directory, options);
  await bootstrap.initialize({ seed: true });
  await bootstrap.registerWorkspaceAuthority({
    threadId: "demo-thread",
    executionGenerationId: "demo-execution-1",
    workspaceDirectory,
  });
  const binding: ResidentSessionBinding = {
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
  };
  await bootstrap.persistResidentSessionBinding(binding);
  return { directory, bootstrap, binding };
}

function projection(
  binding: ResidentSessionBinding,
  sequence: number,
  recap?: string,
): ResidentProjectionSnapshot {
  return {
    projectionVersion: 1,
    identity: {
      activeSessionId: binding.activeSessionId,
      sessionId: binding.sessionId,
      sessionFile: binding.sessionFile,
      workspaceDirectory: binding.workspaceDirectory,
    },
    cursor: { generation: "resident-event-generation-1", sequence },
    runtime: {
      runtime: "prime_agent",
      residency: "resident",
      appVersion: binding.runtime.appVersion,
      activeSessionId: binding.activeSessionId,
      sessionId: binding.sessionId,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      steeringMode: "all",
      followUpMode: "all",
      messageCount: 1,
      compactionCount: 0,
      queuedActionCount: 0,
      activeToolNames: [],
      ...(recap === undefined ? {} : { recap }),
    },
    transcript: [
      {
        blockId: `resident-block-${sequence}`,
        kind: "assistant",
        text: `Authoritative resident block ${sequence}`,
        createdAt: "2026-08-07T12:00:02.000Z",
        sequence: 0,
      },
    ],
    childAgents: [],
    queue: { queuedCount: 0, steeringCount: 0, followUpCount: 0 },
  };
}

async function readPendingProjectionTransaction(store: HostStore): Promise<Record<string, any>> {
  const names = (await readdir(store.paths.residentProjectionTransactions)).filter((name) =>
    name.endsWith(".json"),
  );
  expect(names).toHaveLength(1);
  const name = names[0];
  if (!name) throw new Error("pending resident projection transaction missing");
  return JSON.parse(
    await readFile(join(store.paths.residentProjectionTransactions, name), "utf8"),
  ) as Record<string, any>;
}

async function readSnapshot(store: HostStore, threadId: string): Promise<Record<string, any>> {
  for (const name of await readdir(store.paths.snapshots)) {
    if (!name.endsWith(".json")) continue;
    const snapshot = JSON.parse(await readFile(join(store.paths.snapshots, name), "utf8")) as Record<string, any>;
    if ((snapshot.thread as { threadId?: string } | undefined)?.threadId === threadId) return snapshot;
  }
  throw new Error(`snapshot ${threadId} missing`);
}

async function readCatalogThread(store: HostStore, threadId: string): Promise<Record<string, any> | undefined> {
  const file = JSON.parse(await readFile(store.paths.threads, "utf8")) as {
    threads: Array<Record<string, any>>;
  };
  return file.threads.find((thread) => thread.threadId === threadId);
}
