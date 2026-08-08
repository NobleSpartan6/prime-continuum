import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  SNAPSHOT_VERSION,
  type SavedProject,
  type ThreadProjectionSnapshot,
  type ThreadSummary,
} from "../../src/shared/protocol";
import {
  HostStore,
  workspaceDirectoryIsPlatformQualified,
  type WorkspaceThreadBootstrapFaultPoint,
  type WorkspaceThreadBootstrapInput,
} from "../../src/hostd/store";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HostStore workspace/thread bootstrap", () => {
  it("requires drive- or UNC-qualified Windows workspace authority while preserving POSIX roots", () => {
    expect(workspaceDirectoryIsPlatformQualified("/workspace", "win32")).toBe(false);
    expect(workspaceDirectoryIsPlatformQualified("\\workspace", "win32")).toBe(false);
    expect(workspaceDirectoryIsPlatformQualified("C:\\workspace", "win32")).toBe(true);
    expect(workspaceDirectoryIsPlatformQualified("C:/workspace", "win32")).toBe(true);
    expect(workspaceDirectoryIsPlatformQualified("\\\\server\\share\\workspace", "win32")).toBe(true);
    expect(workspaceDirectoryIsPlatformQualified("//server/share/workspace", "win32")).toBe(true);
    expect(workspaceDirectoryIsPlatformQualified("/workspace", "linux")).toBe(true);
    expect(workspaceDirectoryIsPlatformQualified("relative/workspace", "linux")).toBe(false);
  });

  it.runIf(process.platform === "win32")("rejects current-drive rooted workspace input at the Store boundary", async () => {
    const fixture = await createFixture();
    await expect(
      fixture.store.bootstrapWorkspaceThread({
        ...bootstrapInput(fixture, "bootstrap-current-drive-root"),
        workspaceDirectory: "\\workspace",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_INVALID" });
    expect(await readdir(fixture.store.paths.workspaceThreadBootstrapOperations)).toEqual([]);
  });

  it("commits exact path-free artifacts idempotently and enables resident lifecycle preparation", async () => {
    const fixture = await createFixture();
    const input = bootstrapInput(fixture, "bootstrap-happy");

    const committed = await fixture.store.bootstrapWorkspaceThread(input);
    expect(committed).toEqual({
      version: 1,
      operationId: input.operationId,
      phase: "committed",
      expectedHostId: fixture.hostId,
      projectId: input.project.projectId,
      workspaceId: input.project.workspaceId,
      threadId: input.thread.threadId,
      executionGenerationId: input.thread.currentLocation.executionGenerationId,
      preparedAt: expect.any(String),
      committedAt: expect.any(String),
    });
    expect(committed).not.toHaveProperty("requestDigest");
    expect(JSON.stringify(committed)).not.toContain(fixture.workspaceDirectory);

    const catalog = await fixture.store.getCatalogSnapshot();
    expect(catalog.projects).toEqual([input.project]);
    expect(catalog.threads).toEqual([input.thread]);
    expect(await fixture.store.getThreadSnapshot(input.thread.threadId)).toEqual(input.initialProjection);
    expect(
      await fixture.store.resolveWorkspaceDirectory(
        input.thread.threadId,
        input.thread.currentLocation.executionGenerationId,
      ),
    ).toBe(fixture.workspaceDirectory);

    const aliasInput = {
      ...input,
      workspaceDirectory: `${fixture.workspaceDirectory}${sep}.${sep}`,
    };
    expect(await fixture.store.bootstrapWorkspaceThread(aliasInput)).toEqual(committed);
    await expect(
      fixture.store.bootstrapWorkspaceThread({ ...input, requestDigest: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "WORKSPACE_BOOTSTRAP_OPERATION_ID_REUSED" });

    await expect(
      fixture.store.prepareResidentProvision({
        operationId: "resident-after-bootstrap",
        expectedHostId: fixture.hostId,
        projectId: input.project.projectId,
        workspaceId: input.project.workspaceId,
        threadId: input.thread.threadId,
        executionGenerationId: input.thread.currentLocation.executionGenerationId,
        requestDigest: "c".repeat(64),
      }),
    ).resolves.toMatchObject({ phase: "prepared" });
  });

  it("adopts only semantically identical pre-existing artifacts and never overwrites a divergence", async () => {
    const exactFixture = await createFixture();
    const exact = bootstrapInput(exactFixture, "bootstrap-existing");
    await exactFixture.store.upsertProject(exact.project);
    await exactFixture.store.upsertThread(exact.thread, exact.initialProjection);
    await exactFixture.store.registerWorkspaceAuthority({
      threadId: exact.thread.threadId,
      executionGenerationId: exact.thread.currentLocation.executionGenerationId,
      workspaceDirectory: exactFixture.workspaceDirectory,
    });
    await expect(exactFixture.store.bootstrapWorkspaceThread(exact)).resolves.toMatchObject({ phase: "committed" });

    const divergentFixture = await createFixture();
    const divergent = bootstrapInput(divergentFixture, "bootstrap-divergent");
    const otherProject = { ...divergent.project, displayName: "Unrelated existing project" };
    await divergentFixture.store.upsertProject(otherProject);
    await expect(divergentFixture.store.bootstrapWorkspaceThread(divergent)).rejects.toMatchObject({
      code: "WORKSPACE_BOOTSTRAP_ARTIFACT_DIVERGED",
    });
    expect((await divergentFixture.store.getCatalogSnapshot()).projects).toEqual([otherProject]);
    expect(await readdir(divergentFixture.store.paths.workspaceThreadBootstrapOperations)).toEqual([]);
  });

  it("adopts exact pre-existing authority when the wall clock rolls back before preparation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2035-08-09T12:00:00.000Z");
    const fixture = await createFixture();
    const input = bootstrapInput(fixture, "bootstrap-existing-clock-rollback");
    await fixture.store.upsertProject(input.project);
    await fixture.store.upsertThread(input.thread, input.initialProjection);
    await fixture.store.registerWorkspaceAuthority({
      threadId: input.thread.threadId,
      executionGenerationId: input.thread.currentLocation.executionGenerationId,
      workspaceDirectory: fixture.workspaceDirectory,
    });

    vi.setSystemTime("2025-08-09T12:00:00.000Z");
    const committed = await fixture.store.bootstrapWorkspaceThread(input);
    expect(committed.phase).toBe("committed");
    expect(Date.parse(committed.committedAt)).toBeGreaterThanOrEqual(Date.parse(committed.preparedAt));
    await expect(fixture.store.getCatalogSnapshot()).resolves.toBeDefined();
  });

  it.each(["project", "snapshot", "thread", "authority"] as const)(
    "rejects a divergent pre-existing %s before writing its private intent",
    async (artifact) => {
      const fixture = await createFixture();
      const input = bootstrapInput(fixture, `bootstrap-preflight-${artifact}`);
      if (artifact === "project") {
        await fixture.store.upsertProject({ ...input.project, displayName: "Divergent project" });
      } else if (artifact === "snapshot") {
        await fixture.store.upsertThread(input.thread, {
          ...input.initialProjection,
          evidence: { ...input.initialProjection.evidence, testsPassed: 1 },
        });
      } else if (artifact === "thread") {
        const otherThread = { ...input.thread, title: "Divergent thread" };
        await fixture.store.upsertThread(otherThread, { ...input.initialProjection, thread: otherThread });
      } else {
        await fixture.store.upsertProject(input.project);
        await fixture.store.upsertThread(input.thread, input.initialProjection);
        const otherWorkspace = join(fixture.directory, "preflight-other-workspace");
        await mkdir(otherWorkspace);
        await fixture.store.registerWorkspaceAuthority({
          threadId: input.thread.threadId,
          executionGenerationId: input.thread.currentLocation.executionGenerationId,
          workspaceDirectory: await realpath(otherWorkspace),
        });
      }

      await expect(fixture.store.bootstrapWorkspaceThread(input)).rejects.toMatchObject({
        code: "WORKSPACE_BOOTSTRAP_ARTIFACT_DIVERGED",
      });
      expect(await readdir(fixture.store.paths.workspaceThreadBootstrapOperations)).toEqual([]);
    },
  );

  it("binds the canonical workspace and rejects current authority drift on a terminal retry", async () => {
    const fixture = await createFixture();
    const input = bootstrapInput(fixture, "bootstrap-authority");
    const committed = await fixture.store.bootstrapWorkspaceThread(input);
    const otherWorkspace = join(fixture.directory, "other-workspace");
    await mkdir(otherWorkspace);
    const canonicalOther = await realpath(otherWorkspace);

    await expect(
      fixture.store.bootstrapWorkspaceThread({ ...input, workspaceDirectory: canonicalOther }),
    ).rejects.toMatchObject({ code: "WORKSPACE_BOOTSTRAP_OPERATION_ID_REUSED" });
    await fixture.store.registerWorkspaceAuthority({
      threadId: input.thread.threadId,
      executionGenerationId: input.thread.currentLocation.executionGenerationId,
      workspaceDirectory: canonicalOther,
    });
    await expect(fixture.store.bootstrapWorkspaceThread(input)).rejects.toMatchObject({
      code: "WORKSPACE_BOOTSTRAP_AUTHORITY_CHANGED",
    });
    expect(committed.phase).toBe("committed");
  });

  it("does not replay a completed tombstone over later legitimate thread projection updates", async () => {
    const fixture = await createFixture();
    const input = bootstrapInput(fixture, "bootstrap-terminal");
    const committed = await fixture.store.bootstrapWorkspaceThread(input);
    const updatedThread: ThreadSummary = {
      ...input.thread,
      title: "Updated after bootstrap",
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    };
    const updatedProjection: ThreadProjectionSnapshot = {
      ...input.initialProjection,
      generatedAt: updatedThread.updatedAt,
      thread: updatedThread,
    };
    await fixture.store.upsertThread(updatedThread, updatedProjection);

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect(await restarted.getThreadSnapshot(input.thread.threadId)).toEqual(updatedProjection);
    expect(await restarted.bootstrapWorkspaceThread(input)).toEqual(committed);
  });

  it("cleans incomplete private WAL temp files before validating durable capacity", async () => {
    const fixture = await createFixture();
    const temporary = join(
      fixture.store.paths.workspaceThreadBootstrapOperations,
      `${"d".repeat(64)}.json.tmp-100-deadbeef`,
    );
    await writeFile(temporary, "incomplete", "utf8");

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect(await readdir(restarted.paths.workspaceThreadBootstrapOperations)).toEqual([]);
  });

  it("checks public catalog capacity before writing a bootstrap intent", async () => {
    const fixture = await createFixture();
    const openedAt = new Date().toISOString();
    const projects: SavedProject[] = Array.from({ length: 10_000 }, (_, index) => ({
      projectId: `capacity-project-${index}`,
      hostId: fixture.hostId,
      workspaceId: `capacity-workspace-${index}`,
      displayName: `Capacity ${index}`,
      lastOpenedAt: openedAt,
    }));
    await writeFile(fixture.store.paths.projects, `${JSON.stringify({ version: 1, projects })}\n`, "utf8");

    await expect(
      fixture.store.bootstrapWorkspaceThread(bootstrapInput(fixture, "bootstrap-capacity")),
    ).rejects.toMatchObject({ code: "WORKSPACE_BOOTSTRAP_PROJECT_LIMIT_REACHED" });
    expect(await readdir(fixture.store.paths.workspaceThreadBootstrapOperations)).toEqual([]);
  });
});

describe("HostStore workspace/thread bootstrap crash recovery", () => {
  it.each([
    "after_prepared",
    "after_project",
    "after_project_committed",
    "after_snapshot",
    "after_snapshot_committed",
    "after_thread",
    "after_thread_committed",
    "after_authority",
    "after_authority_committed",
    "after_committed",
  ] satisfies WorkspaceThreadBootstrapFaultPoint[])("converges exact local state after %s", async (faultPoint) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2034-07-08T12:00:00.000Z");
    const fixture = await createFixture();
    const input = bootstrapInput(fixture, `bootstrap-${faultPoint}`);
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      workspaceThreadBootstrapFaultInjector(point) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated workspace bootstrap crash at ${point}`);
        }
      },
    });
    await crashing.initialize();
    await expect(crashing.bootstrapWorkspaceThread(input)).rejects.toThrow(
      `simulated workspace bootstrap crash at ${faultPoint}`,
    );
    await expect(crashing.getCatalogSnapshot()).rejects.toMatchObject({ code: "STORE_NOT_INITIALIZED" });

    vi.setSystemTime("2024-07-08T12:00:00.000Z");
    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect((await restarted.getCatalogSnapshot()).projects).toEqual([input.project]);
    expect((await restarted.getCatalogSnapshot()).threads).toEqual([input.thread]);
    expect(await restarted.getThreadSnapshot(input.thread.threadId)).toEqual(input.initialProjection);
    expect(
      await restarted.resolveWorkspaceDirectory(
        input.thread.threadId,
        input.thread.currentLocation.executionGenerationId,
      ),
    ).toBe(fixture.workspaceDirectory);
    const committed = await restarted.bootstrapWorkspaceThread(input);
    expect(committed).toMatchObject({ phase: "committed" });
    expect(Date.parse(committed.committedAt)).toBeGreaterThanOrEqual(Date.parse(committed.preparedAt));
  });

  it.each(
    ([
      "after_prepared",
      "after_project",
      "after_project_committed",
      "after_snapshot",
      "after_snapshot_committed",
      "after_thread",
      "after_thread_committed",
      "after_authority",
      "after_authority_committed",
    ] satisfies WorkspaceThreadBootstrapFaultPoint[]).flatMap((faultPoint) =>
      (["deleted", "moved"] as const).map((workspaceChange) => [faultPoint, workspaceChange] as const),
    ),
  )("retires exact partial state after %s when the workspace is %s", async (faultPoint, workspaceChange) => {
    const fixture = await createFixture();
    const input = bootstrapInput(fixture, `bootstrap-unavailable-${faultPoint}-${workspaceChange}`);
    const crashing = new HostStore(fixture.directory, {
      workspaceThreadBootstrapFaultInjector(point) {
        if (point === faultPoint) throw new Error(`simulated unavailable workspace crash at ${point}`);
      },
    });
    await crashing.initialize();
    await expect(crashing.bootstrapWorkspaceThread(input)).rejects.toThrow(
      `simulated unavailable workspace crash at ${faultPoint}`,
    );

    const movedWorkspace = join(fixture.directory, `workspace-moved-${faultPoint}`);
    if (workspaceChange === "moved") await rename(fixture.workspaceDirectory, movedWorkspace);
    else await rm(fixture.workspaceDirectory, { recursive: true });

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect((await restarted.getCatalogSnapshot()).projects).toEqual([]);
    expect((await restarted.getCatalogSnapshot()).threads).toEqual([]);
    expect(await readdir(restarted.paths.snapshots)).toEqual([]);
    expect(await readdir(restarted.paths.workspaceThreadBootstrapOperations)).toHaveLength(1);
    expect(
      JSON.parse(await readFile(restarted.paths.workspaceAuthorities, "utf8")),
    ).toEqual({ version: 1, authorities: [] });

    const restartedAgain = new HostStore(fixture.directory);
    await restartedAgain.initialize();
    expect(await readdir(restartedAgain.paths.workspaceThreadBootstrapOperations)).toHaveLength(1);

    const mismatchedWorkspace =
      workspaceChange === "moved"
        ? await realpath(movedWorkspace)
        : await (async () => {
            const path = join(fixture.directory, `workspace-reselected-${faultPoint}`);
            await mkdir(path);
            return realpath(path);
          })();
    await expect(
      restartedAgain.bootstrapWorkspaceThread({ ...input, workspaceDirectory: mismatchedWorkspace }),
    ).rejects.toMatchObject({ code: "WORKSPACE_BOOTSTRAP_OPERATION_ID_REUSED" });
    if (workspaceChange === "moved") await rename(movedWorkspace, fixture.workspaceDirectory);
    else await mkdir(fixture.workspaceDirectory);
    await expect(
      restartedAgain.bootstrapWorkspaceThread({ ...input, requestDigest: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "WORKSPACE_BOOTSTRAP_OPERATION_ID_REUSED" });
    await expect(
      restartedAgain.bootstrapWorkspaceThread(input),
    ).resolves.toMatchObject({ operationId: input.operationId, phase: "committed" });
  });

  it.each([
    "after_rollback_planned",
    "after_rollback_authority",
    "after_rollback_thread",
    "after_rollback_snapshot",
    "after_rollback_project",
    "after_rollback_retired",
  ] satisfies WorkspaceThreadBootstrapFaultPoint[])(
    "resumes an interrupted unavailable-workspace rollback after %s",
    async (rollbackFaultPoint) => {
      const fixture = await createFixture();
      const input = bootstrapInput(fixture, `bootstrap-rollback-${rollbackFaultPoint}`);
      const crashing = new HostStore(fixture.directory, {
        workspaceThreadBootstrapFaultInjector(point) {
          if (point === "after_authority_committed") throw new Error("simulated materialization crash");
        },
      });
      await crashing.initialize();
      await expect(crashing.bootstrapWorkspaceThread(input)).rejects.toThrow("simulated materialization crash");
      await rm(fixture.workspaceDirectory, { recursive: true });

      let injected = false;
      const rollbackCrash = new HostStore(fixture.directory, {
        workspaceThreadBootstrapFaultInjector(point) {
          if (!injected && point === rollbackFaultPoint) {
            injected = true;
            throw new Error(`simulated rollback crash at ${point}`);
          }
        },
      });
      await expect(rollbackCrash.initialize()).rejects.toMatchObject({
        code: "WORKSPACE_BOOTSTRAP_RECOVERY_FAILED",
      });

      const recovered = new HostStore(fixture.directory);
      await recovered.initialize();
      expect((await recovered.getCatalogSnapshot()).projects).toEqual([]);
      expect((await recovered.getCatalogSnapshot()).threads).toEqual([]);
      expect(await readdir(recovered.paths.snapshots)).toEqual([]);
      expect(await readdir(recovered.paths.workspaceThreadBootstrapOperations)).toHaveLength(1);
    },
  );

  it("preserves a committed bootstrap and lifecycle tombstone when its workspace disappears", async () => {
    const fixture = await createFixture();
    const input = bootstrapInput(fixture, "bootstrap-committed-workspace-missing");
    await fixture.store.bootstrapWorkspaceThread(input);
    await fixture.store.prepareResidentProvision({
      operationId: "resident-prepared-before-workspace-missing",
      expectedHostId: fixture.hostId,
      projectId: input.project.projectId,
      workspaceId: input.project.workspaceId,
      threadId: input.thread.threadId,
      executionGenerationId: input.thread.currentLocation.executionGenerationId,
      requestDigest: "c".repeat(64),
    });
    await rm(fixture.workspaceDirectory, { recursive: true });

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect((await restarted.getCatalogSnapshot()).projects).toEqual([input.project]);
    expect((await restarted.getCatalogSnapshot()).threads).toEqual([input.thread]);
    expect(await readdir(restarted.paths.workspaceThreadBootstrapOperations)).toHaveLength(1);
    await expect(
      restarted.getResidentLifecycleStatus("resident-prepared-before-workspace-missing"),
    ).resolves.toMatchObject({ phase: "quarantined", quarantineReason: "authority_changed" });
  });

  it("retires a missing-path retry without deleting exact artifacts adopted from a committed bootstrap", async () => {
    const fixture = await createFixture();
    const committedInput = bootstrapInput(fixture, "bootstrap-prior-committed");
    await fixture.store.bootstrapWorkspaceThread(committedInput);
    const retryInput = { ...committedInput, operationId: "bootstrap-adopted-retry" };
    const crashing = new HostStore(fixture.directory, {
      workspaceThreadBootstrapFaultInjector(point, operationId) {
        if (point === "after_prepared" && operationId === retryInput.operationId) {
          throw new Error("simulated adopted retry crash");
        }
      },
    });
    await crashing.initialize();
    await expect(crashing.bootstrapWorkspaceThread(retryInput)).rejects.toThrow("simulated adopted retry crash");
    await rm(fixture.workspaceDirectory, { recursive: true });

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect((await restarted.getCatalogSnapshot()).projects).toEqual([committedInput.project]);
    expect((await restarted.getCatalogSnapshot()).threads).toEqual([committedInput.thread]);
    expect(await restarted.getThreadSnapshot(committedInput.thread.threadId)).toEqual(
      committedInput.initialProjection,
    );
    expect(await readdir(restarted.paths.workspaceThreadBootstrapOperations)).toHaveLength(2);
  });

  it("fails closed on a divergent partial artifact even when the workspace is unavailable", async () => {
    const fixture = await createFixture();
    const input = bootstrapInput(fixture, "bootstrap-missing-path-divergence");
    const crashing = new HostStore(fixture.directory, {
      workspaceThreadBootstrapFaultInjector(point) {
        if (point === "after_project_committed") throw new Error("simulated project crash");
      },
    });
    await crashing.initialize();
    await expect(crashing.bootstrapWorkspaceThread(input)).rejects.toThrow("simulated project crash");
    const projectFile = JSON.parse(await readFile(crashing.paths.projects, "utf8")) as {
      version: 1;
      projects: SavedProject[];
    };
    const project = projectFile.projects[0];
    if (!project) throw new Error("bootstrap project fixture missing");
    project.displayName = "User-mutated project";
    await writeFile(crashing.paths.projects, `${JSON.stringify(projectFile)}\n`, "utf8");
    await rm(fixture.workspaceDirectory, { recursive: true });

    const restarted = new HostStore(fixture.directory);
    await expect(restarted.initialize()).rejects.toMatchObject({
      code: "WORKSPACE_BOOTSTRAP_ARTIFACT_DIVERGED",
    });
    expect(
      (JSON.parse(await readFile(crashing.paths.projects, "utf8")) as { projects: SavedProject[] }).projects,
    ).toEqual([{ ...input.project, displayName: "User-mutated project" }]);
  });

  it("fails closed without rewriting a malformed partial catalog when the workspace is unavailable", async () => {
    const fixture = await createFixture();
    const input = bootstrapInput(fixture, "bootstrap-missing-path-malformed");
    const crashing = new HostStore(fixture.directory, {
      workspaceThreadBootstrapFaultInjector(point) {
        if (point === "after_project_committed") throw new Error("simulated malformed project crash");
      },
    });
    await crashing.initialize();
    await expect(crashing.bootstrapWorkspaceThread(input)).rejects.toThrow("simulated malformed project crash");
    const malformed = "{not-json\n";
    await writeFile(crashing.paths.projects, malformed, "utf8");
    await rm(fixture.workspaceDirectory, { recursive: true });

    const restarted = new HostStore(fixture.directory);
    await expect(restarted.initialize()).rejects.toThrow("State file is not valid JSON");
    expect(await readFile(crashing.paths.projects, "utf8")).toBe(malformed);
  });

  it.each([
    ["project", "after_project_committed"],
    ["snapshot", "after_snapshot_committed"],
    ["thread", "after_thread_committed"],
    ["authority", "after_authority_committed"],
  ] satisfies Array<["project" | "snapshot" | "thread" | "authority", WorkspaceThreadBootstrapFaultPoint]>)(
    "fails closed when the already-written %s diverges before startup replay",
    async (artifact, faultPoint) => {
      const fixture = await createFixture();
      const input = bootstrapInput(fixture, `bootstrap-recovery-${artifact}`);
      const crashing = new HostStore(fixture.directory, {
        workspaceThreadBootstrapFaultInjector(point) {
          if (point === faultPoint) {
            throw new Error(`simulated ${artifact} boundary crash`);
          }
        },
      });
      await crashing.initialize();
      await expect(crashing.bootstrapWorkspaceThread(input)).rejects.toThrow(
        `simulated ${artifact} boundary crash`,
      );

      if (artifact === "project") {
        const file = JSON.parse(await readFile(crashing.paths.projects, "utf8")) as {
          version: 1;
          projects: SavedProject[];
        };
        const project = file.projects[0];
        if (!project) throw new Error("bootstrap project fixture missing");
        project.displayName = "Diverged after crash";
        await writeFile(crashing.paths.projects, `${JSON.stringify(file)}\n`, "utf8");
      } else if (artifact === "snapshot") {
        const path = join(
          crashing.paths.snapshots,
          (await readdir(crashing.paths.snapshots)).find((name) => name.endsWith(".json")) ?? "missing.json",
        );
        const snapshot = JSON.parse(await readFile(path, "utf8")) as ThreadProjectionSnapshot;
        snapshot.evidence = { ...snapshot.evidence, testsPassed: 1 };
        await writeFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");
      } else if (artifact === "thread") {
        const file = JSON.parse(await readFile(crashing.paths.threads, "utf8")) as {
          version: 1;
          threads: ThreadSummary[];
        };
        const thread = file.threads[0];
        if (!thread) throw new Error("bootstrap thread fixture missing");
        thread.title = "Diverged after crash";
        await writeFile(crashing.paths.threads, `${JSON.stringify(file)}\n`, "utf8");
      } else {
        const otherWorkspace = join(fixture.directory, "recovery-other-workspace");
        await mkdir(otherWorkspace);
        const file = JSON.parse(await readFile(crashing.paths.workspaceAuthorities, "utf8")) as {
          version: 1;
          authorities: Array<{ workspaceDirectory: string }>;
        };
        const authority = file.authorities[0];
        if (!authority) throw new Error("bootstrap authority fixture missing");
        authority.workspaceDirectory = await realpath(otherWorkspace);
        await writeFile(crashing.paths.workspaceAuthorities, `${JSON.stringify(file)}\n`, "utf8");
      }

      const restarted = new HostStore(fixture.directory);
      await expect(restarted.initialize()).rejects.toMatchObject({
        code: "WORKSPACE_BOOTSTRAP_ARTIFACT_DIVERGED",
      });
    },
  );
});

interface Fixture {
  directory: string;
  workspaceDirectory: string;
  store: HostStore;
  hostId: string;
}

async function createFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "prime-workspace-bootstrap-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const workspaceDirectory = await realpath(workspace);
  const store = new HostStore(directory);
  await store.initialize();
  return { directory, workspaceDirectory, store, hostId: (await store.getHost()).hostId };
}

function bootstrapInput(fixture: Fixture, operationId: string): WorkspaceThreadBootstrapInput {
  const timestamp = new Date().toISOString();
  const project: SavedProject = {
    projectId: "bootstrap-project",
    hostId: fixture.hostId,
    workspaceId: "bootstrap-workspace",
    displayName: "Bootstrap Project",
    lastOpenedAt: timestamp,
  };
  const cursor = {
    threadId: "bootstrap-thread",
    executionGenerationId: "bootstrap-execution-1",
    generation: "bootstrap-projection-1",
    sequence: 0,
  };
  const thread: ThreadSummary = {
    threadId: cursor.threadId,
    title: "Fresh resident thread",
    projectIdentity: project.projectId,
    currentLocation: {
      hostId: fixture.hostId,
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      executionGenerationId: cursor.executionGenerationId,
    },
    status: "idle",
    recap: "Preparing a fresh resident session.",
    unread: false,
    updatedAt: timestamp,
    lastKnownCursor: cursor,
  };
  const initialProjection: ThreadProjectionSnapshot = {
    snapshotVersion: SNAPSHOT_VERSION,
    generatedAt: timestamp,
    thread,
    transcriptBlockIndex: [],
    materializedRecentBlocks: [],
    queueState: { pendingCommandIds: [], paused: false },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    git: { stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
    pendingAttention: [],
    latestCursor: cursor,
  };
  return {
    operationId,
    requestDigest: "a".repeat(64),
    expectedHostId: fixture.hostId,
    project,
    thread,
    initialProjection,
    workspaceDirectory: fixture.workspaceDirectory,
  };
}
