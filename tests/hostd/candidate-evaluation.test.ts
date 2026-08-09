import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateEvaluationStore } from "../../src/hostd/candidate-evaluation-store";
import { AtomicWriteAmbiguousCommitError } from "../../src/hostd/atomic-files";
import {
  CandidateEvaluationCoordinator,
  type CandidateEvaluationBackend,
  type CandidateEvaluationBackendPreflight,
  type CandidateEvaluationInvocation,
  type CandidateEvaluationInvocationObservation,
} from "../../src/hostd/candidate-evaluation";
import { getHostDataPaths } from "../../src/hostd/paths";
import type { CandidateEvaluationStartRequest } from "../../src/shared/protocol";
import { createReceiptEnvelope } from "../../scripts/self-build-lib.mjs";

const roots: string[] = [];
const now = new Date("2026-08-09T12:00:00.000Z");
const runId = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("CandidateEvaluationCoordinator", () => {
  it("launches an exact operation once and converges duplicate starts", async () => {
    const fixture = await coordinatorFixture();
    const request = startRequest("operation-one");
    const first = await fixture.coordinator.start(request);
    const duplicate = await fixture.coordinator.start(request);

    expect(first.status).toBe("running");
    expect(duplicate).toEqual(first);
    expect(fixture.backend.launchCount).toBe(1);
    await fixture.coordinator.close();
  });

  it("retires a crash-durable prepared record as not invoked and requires fresh consent", async () => {
    const fixture = await coordinatorFixture(false);
    await fixture.store.prepare(startRequest("prepared"), fixture.workspace, runId, now.toISOString());
    await fixture.coordinator.initialize();

    const snapshot = await fixture.coordinator.snapshot(authority());
    expect(snapshot.evaluations).toHaveLength(1);
    expect(snapshot.evaluations[0]).toMatchObject({
      status: "failed",
      error: { code: "EVALUATION_NOT_INVOKED" },
    });
    expect(fixture.backend.launchCount).toBe(0);
    await fixture.coordinator.close();
  });

  it("recovers a prepare publication whose commit acknowledgement was ambiguous without launching it", async () => {
    const fixture = await coordinatorFixture();
    const original = fixture.store.prepare.bind(fixture.store);
    vi.spyOn(fixture.store, "prepare").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new AtomicWriteAmbiguousCommitError("<private-operation>", new Error("after-link fault"));
    });

    await expect(fixture.coordinator.start(startRequest("ambiguous-prepare"))).rejects.toMatchObject({
      code: "EVALUATOR_NOT_READY",
    });
    expect(fixture.backend.launchCount).toBe(0);
    expect((await fixture.coordinator.snapshot(authority())).evaluations[0]).toMatchObject({
      status: "failed",
      error: { code: "EVALUATION_NOT_INVOKED" },
    });
    await fixture.coordinator.close();
  });

  it("never reruns an invocation whose outer identity was not durably published", async () => {
    const fixture = await coordinatorFixture(false);
    const request = startRequest("unpublished");
    const prepared = (await fixture.store.prepare(request, fixture.workspace, runId, now.toISOString())).record;
    await fixture.store.markInvocationStarted(
      prepared,
      runId,
      now.toISOString(),
      "2026-08-09T14:15:00.000Z",
    );
    await fixture.coordinator.initialize();

    const status = (await fixture.coordinator.snapshot(authority())).evaluations[0];
    expect(status).toMatchObject({ status: "uncertain", error: { code: "EVALUATION_OUTCOME_UNKNOWN" } });
    const preflight = await fixture.coordinator.preflight(authority());
    expect(preflight).toMatchObject({ status: "unavailable", code: "EVALUATION_OUTCOME_UNKNOWN" });
    await expect(fixture.coordinator.start(request)).resolves.toMatchObject({ status: "uncertain" });
    expect(fixture.backend.launchCount).toBe(0);
    await expect(fixture.coordinator.close()).resolves.toBeUndefined();
  });

  it("settles a retirement-before-status crash window without rerunning", async () => {
    const fixture = await coordinatorFixture(false);
    const request = startRequest("retired-running");
    const prepared = (await fixture.store.prepare(request, fixture.workspace, runId, now.toISOString())).record;
    const running = await fixture.store.markInvocationStarted(
      prepared,
      runId,
      now.toISOString(),
      "2026-08-09T14:15:00.000Z",
    );
    const published = await fixture.store.markOuterProcess(
      running,
      31337,
      now.toISOString(),
      "windows_job",
    );
    await fixture.store.markInvocationRetired(published, "tree_retired", now.toISOString());
    await fixture.coordinator.initialize();

    expect((await fixture.coordinator.snapshot(authority())).evaluations[0]).toMatchObject({
      status: "uncertain",
      error: { code: "EVALUATION_OUTCOME_UNKNOWN" },
    });
    expect(fixture.backend.launchCount).toBe(0);
    await fixture.coordinator.close();
  });

  it("does not let an admitted start escape a concurrent close", async () => {
    const fixture = await coordinatorFixture();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const original = fixture.store.markInvocationStarted.bind(fixture.store);
    vi.spyOn(fixture.store, "markInvocationStarted").mockImplementation(async (...args) => {
      entered.resolve();
      await gate.promise;
      return await original(...args);
    });
    const starting = fixture.coordinator.start(startRequest("close-race"));
    await entered.promise;
    const closing = fixture.coordinator.close();
    gate.resolve();

    await expect(starting).resolves.toMatchObject({
      status: "failed",
      invocationStartedAt: now.toISOString(),
      error: { code: "EVALUATION_LAUNCH_FAILED" },
    });
    await expect(closing).resolves.toBeUndefined();
    expect(fixture.backend.launchCount).toBe(0);
  });

  it("keeps the authority repeat-effects warning even when uncertainty falls outside the 32-item page", async () => {
    const fixture = await coordinatorFixture(false);
    const uncertainRequest = startRequest("uncertain-old");
    const prepared = (await fixture.store.prepare(uncertainRequest, fixture.workspace, runId, now.toISOString())).record;
    const running = await fixture.store.markInvocationStarted(
      prepared,
      runId,
      now.toISOString(),
      "2026-08-09T14:15:00.000Z",
    );
    const outer = await fixture.store.markOuterProcess(running, 31337, now.toISOString(), "windows_job");
    const uncertain = await fixture.store.settle(outer, "uncertain", now.toISOString(), {
      error: {
        code: "EVALUATION_OUTCOME_UNKNOWN",
        message: "The exact invocation outcome remains unknown",
        retryable: false,
      },
    });
    await fixture.store.markInvocationRetired(uncertain, "tree_retired", now.toISOString());
    for (let index = 0; index < 32; index += 1) {
      const at = new Date(now.getTime() + index + 1).toISOString();
      const request = startRequest(`later-${index}`, at);
      const next = (await fixture.store.prepare(request, fixture.workspace, runId, at)).record;
      await fixture.store.settle(next, "failed", at, {
        error: { code: "EVALUATION_NOT_INVOKED", message: "Not invoked", retryable: true },
      });
    }
    await fixture.coordinator.initialize();

    const snapshot = await fixture.coordinator.snapshot(authority());
    expect(snapshot.evaluations).toHaveLength(32);
    expect(snapshot.evaluations.some((status) => status.status === "uncertain")).toBe(false);
    expect(snapshot.repeatEffectsWarningRequired).toBe(true);
    await fixture.coordinator.close();
  });

  it("adopts receipt-first passing evidence, retains the live-tree barrier, and permits a later operation after retirement and restart", async () => {
    const fixture = await coordinatorFixture();
    const firstRequest = startRequest("passing-first");
    await fixture.coordinator.start(firstRequest);
    const runningBeforeReceipt = await fixture.store.get(firstRequest);
    expect(runningBeforeReceipt).toMatchObject({ status: { status: "running" } });
    fixture.backend.receipt = createReceiptEnvelope(passingReceipt(runId));

    const evidenced = (await fixture.coordinator.snapshot(authority())).evaluations[0];
    expect(evidenced).toMatchObject({ status: "passed", receipt: { outcome: "passed" } });
    await expect(fixture.coordinator.preflight(authority())).resolves.toMatchObject({
      status: "unavailable",
      code: "EVALUATION_BUSY",
    });

    fixture.backend.observation = "retired";
    expect((await fixture.coordinator.snapshot(authority())).evaluations[0]).toMatchObject({ status: "passed" });
    await fixture.coordinator.close();

    // Model a crash after the immutable outer receipt linked successfully but
    // before the mutable operation replacement became durable. Startup must
    // adopt that exact receipt, never invoke the same operation again, and
    // reconcile private tree retirement independently of public settlement.
    const operationNames = await readdir(fixture.store.paths.candidateEvaluationOperations);
    expect(operationNames).toHaveLength(1);
    await writeFile(
      join(fixture.store.paths.candidateEvaluationOperations, operationNames[0]!),
      `${JSON.stringify(runningBeforeReceipt)}\n`,
    );

    const restartedBackend = new FakeBackend();
    restartedBackend.observation = "retired";
    const restartedStore = new CandidateEvaluationStore(fixture.store.paths);
    const restarted = new CandidateEvaluationCoordinator({
      authorityStore: {
        getHost: async () => ({ hostId: "host-local" }),
        resolveWorkspaceDirectory: async () => fixture.workspace,
      },
      persistence: restartedStore,
      backend: restartedBackend,
      now: () => now,
      createRunId: () => "22222222-2222-4222-8222-222222222222",
      pollIntervalMs: 60_000,
    });
    await restarted.initialize();
    expect((await restarted.snapshot(authority())).evaluations[0]).toMatchObject({
      operationId: "passing-first",
      status: "passed",
      receipt: { outcome: "passed" },
    });
    await expect(restarted.start(startRequest("passing-second"))).resolves.toMatchObject({ status: "running" });
    expect(restartedBackend.launchCount).toBe(1);
    await restarted.close();
  });

  it("keeps polling after a deadline uncertainty and clears the barrier only after later exact retirement", async () => {
    const fixture = await coordinatorFixture(false);
    const request = startRequest("deadline-retirement");
    const prepared = (await fixture.store.prepare(request, fixture.workspace, runId, now.toISOString())).record;
    const running = await fixture.store.markInvocationStarted(
      prepared,
      runId,
      now.toISOString(),
      "2026-08-09T12:00:01.000Z",
    );
    await fixture.store.markOuterProcess(running, 31337, now.toISOString(), "windows_job");
    fixture.setNow(new Date("2026-08-09T12:00:02.000Z"));
    await fixture.coordinator.initialize();
    expect((await fixture.coordinator.snapshot(authority())).evaluations[0]).toMatchObject({
      status: "uncertain",
      error: { code: "EVALUATION_OUTCOME_UNKNOWN" },
    });
    await expect(fixture.coordinator.preflight(authority())).resolves.toMatchObject({
      status: "unavailable",
      code: "EVALUATION_OUTCOME_UNKNOWN",
    });

    fixture.backend.observation = "retired";
    await fixture.coordinator.snapshot(authority());
    await expect(fixture.coordinator.preflight(authority())).resolves.toMatchObject({ status: "ready" });
    await fixture.coordinator.close();
  });

  it("catches a background poll rejection and conservatively withholds capability without clearing the barrier", async () => {
    const fixture = await coordinatorFixture(true, 10);
    await fixture.coordinator.start(startRequest("poll-failure"));
    fixture.backend.observeError = new Error("synthetic observation failure");
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));

    expect(fixture.coordinator.capabilityReady()).toBe(false);
    expect((await fixture.store.list()).some((record) => record.invocation && !record.invocation.retirement)).toBe(true);
    fixture.backend.observeError = undefined;
    await fixture.coordinator.close();
  });

  it("fails closed when persisted outer evidence has a valid outer digest but a corrupt embedded self-build envelope", async () => {
    const fixture = await coordinatorFixture();
    const request = startRequest("corrupt-inner");
    await fixture.coordinator.start(request);
    fixture.backend.receipt = createReceiptEnvelope(passingReceipt(runId));
    await fixture.coordinator.snapshot(authority());
    fixture.backend.observation = "retired";
    await fixture.coordinator.close();

    const [receiptName] = await readdir(fixture.store.paths.candidateEvaluationReceipts);
    const receiptPath = join(fixture.store.paths.candidateEvaluationReceipts, receiptName!);
    const outer = JSON.parse(await readFile(receiptPath, "utf8")) as {
      receipt: Record<string, unknown>;
      receiptSha256: string;
    };
    outer.receipt.selfBuildEnvelope = { corrupted: true };
    outer.receiptSha256 = createHash("sha256").update(canonicalJson(outer.receipt)).digest("hex");
    await writeFile(receiptPath, `${JSON.stringify(outer)}\n`);

    const restarted = new CandidateEvaluationCoordinator({
      authorityStore: {
        getHost: async () => ({ hostId: "host-local" }),
        resolveWorkspaceDirectory: async () => fixture.workspace,
      },
      persistence: new CandidateEvaluationStore(fixture.store.paths),
      backend: new FakeBackend(),
      now: () => now,
      createRunId: () => runId,
      pollIntervalMs: 60_000,
    });
    await expect(restarted.initialize()).resolves.toBeUndefined();
    expect(restarted.capabilityReady()).toBe(false);
    await restarted.close();
  });
});

class FakeBackend implements CandidateEvaluationBackend {
  launchCount = 0;
  preflightCount = 0;
  observation: CandidateEvaluationInvocationObservation = "exact_live";
  observeError: Error | undefined;
  receipt: unknown | undefined;

  supported(): boolean {
    return true;
  }

  async preflight(): Promise<CandidateEvaluationBackendPreflight> {
    this.preflightCount += 1;
    return ready();
  }

  async launch(): Promise<CandidateEvaluationInvocation> {
    this.launchCount += 1;
    const completion = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    return {
      pid: 31337,
      containment: "windows_job",
      completed: completion.promise,
      terminate: async () => {
        this.observation = "retired";
        completion.resolve({ code: null, signal: "SIGTERM" });
        return true;
      },
    };
  }

  async readReceipt(): Promise<unknown | undefined> {
    return this.receipt;
  }

  async observeInvocation(record: { invocation?: { outerProcess?: unknown } }): Promise<CandidateEvaluationInvocationObservation> {
    if (this.observeError) throw this.observeError;
    return record.invocation?.outerProcess ? this.observation : "outer_identity_unpublished";
  }
}

async function coordinatorFixture(initialize = true, pollIntervalMs = 60_000) {
  const root = await mkdtemp(join(tmpdir(), "prime-candidate-coordinator-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const store = new CandidateEvaluationStore(getHostDataPaths(join(root, "host")));
  await store.initialize();
  const backend = new FakeBackend();
  let currentTime = now;
  const coordinator = new CandidateEvaluationCoordinator({
    authorityStore: {
      getHost: async () => ({ hostId: "host-local" }),
      resolveWorkspaceDirectory: async () => workspace,
    },
    persistence: store,
    backend,
    now: () => currentTime,
    createRunId: () => runId,
    pollIntervalMs,
  });
  if (initialize) await coordinator.initialize();
  return { coordinator, backend, store, workspace, setNow: (value: Date) => { currentTime = value; } };
}

function authority() {
  return {
    expectedHostId: "host-local",
    threadId: "thread-one",
    expectedExecutionGenerationId: "generation-one",
  };
}

function startRequest(operationId: string, requestedAt = now.toISOString()): CandidateEvaluationStartRequest {
  return {
    ...authority(),
    operationId,
    requestedAt,
    kind: "prime_continuim_self_build_v1",
    expectedReview: review(),
  };
}

function ready(): CandidateEvaluationBackendPreflight {
  return {
    review: review(),
    executor: {
      kind: "canonical_self_build",
      gateProcessContainment: "windows_job",
      requiredNodeVersion: "24.14.0",
      requiredPnpmVersion: "11.9.0",
      verification: "passive-structure-before-consent;canonical-toolchain-inside-evaluation",
      launcherSource: "workspace-dependency-tree-candidate-controlled",
    },
    launchContext: {},
  };
}

function review() {
  return {
    headCommit: "a".repeat(40),
    gitIndexSha256: "b".repeat(64),
    gitIndexBytes: 100,
    packageManifestSha256: "c".repeat(64),
    lockfileSha256: "d".repeat(64),
    lockfileBytes: 100,
    nodeVersionPinSha256: "e".repeat(64),
    selfBuildEntrypointSha256: "f".repeat(64),
    launcherBootstrapSha256: "1".repeat(64),
    launcherBootstrapFileCount: 9 as const,
    runtimePointerSha256: "2".repeat(64),
    nodePackageManifestSha256: "3".repeat(64),
    nodeExecutableSha256: "4".repeat(64),
    pnpmCliSha256: "5".repeat(64),
    reviewAggregateSha256: "6".repeat(64),
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function passingReceipt(selfBuildRunId: string) {
  const digest = "0".repeat(64);
  const labels = [
    "Install exact dependencies from the local pnpm store",
    "Typecheck the candidate",
    "Run the candidate test suite",
    "Verify the prebuilt Prime Agent runtime input before build",
    "Build the attested release candidate",
    "Reverify the prebuilt Prime Agent runtime input",
  ];
  const roots = ["out/main", "out/preload", "out/renderer", "out/hostd"].map((path) => ({
    path,
    treeSha256: digest,
    fileCount: 1,
    totalBytes: 1,
  }));
  return {
    schemaVersion: 1,
    kind: "prime_continuim_self_build_evidence",
    runId: selfBuildRunId,
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    outcome: "passed",
    source: candidate(),
    toolchain: {
      node: { version: "v24.0.0", modulesAbi: "137", platform: "win32", arch: "x64", executableSha256: digest },
      pnpm: { version: "11.9.0", cliSha256: digest, storePathSha256: digest },
      git: { version: "git version 2.50.1.windows.1", executableSha256: digest },
      electron: {
        version: "37.0.0",
        executableSha256: digest,
        distributionSha256: digest,
        distributionFileCount: 1,
        distributionBytes: 1,
      },
      runtimeSeed: {
        releaseVersion: "0.7.0",
        platform: "win32",
        arch: "x64",
        pointerSha256: digest,
        manifestSha256: digest,
        treeSha256: digest,
        payloadSha256: digest,
        payloadFileCount: 1,
        payloadBytes: 1,
      },
      environment: {
        policy: "prime-continuim-self-build-environment-v1",
        names: ["CI"],
        valuesSha256: digest,
      },
    },
    evaluation: {
      isolation: "detached-temporary-git-worktree",
      dependencyInstall: "fixture install",
      cleanupState: "removed",
      worktreeRelativePath: null,
      toolchainFence: "per-step-metadata-and-final-content",
      toolchainUnchanged: true,
      commands: labels.map((label) => ({
        label,
        command: { executable: "node.exe", args: [] },
        timeoutMs: 1_000,
        durationMs: 1,
        code: 0,
        signal: null,
        timedOut: false,
        supervisorError: null,
        collateralState: "supervised_tree_settled",
      })),
    },
    artifacts: {
      roots,
      aggregateSha256: createHash("sha256").update(canonicalJson(roots)).digest("hex"),
      fileCount: 4,
      totalBytes: 4,
    },
    failure: null,
    boundary: {
      securitySandbox: false,
      autonomousPromotion: false,
      providerBackedEvaluation: false,
      packageOrInstallerGate: false,
      candidateControlledEvaluation: true,
      mainFilesystemIsolation: false,
    },
  };
}

function candidate() {
  return {
    headCommit: "1".repeat(40),
    dirty: true,
    statusPorcelainV2Sha256: "0".repeat(64),
    statusBytes: 1,
    binaryPatchSha256: "0".repeat(64),
    binaryPatchBytes: 1,
    untrackedManifestSha256: "0".repeat(64),
    untrackedFileCount: 1,
    untrackedBytes: 1,
    treeSha256: "0".repeat(64),
    treeFileCount: 1,
    treeBytes: 1,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
