import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateEvaluationStore } from "../../src/hostd/candidate-evaluation-store";
import {
  CandidateEvaluationCoordinator,
  type CandidateEvaluationBackend,
} from "../../src/hostd/candidate-evaluation";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";
import { PROTOCOL_VERSION } from "../../src/shared/protocol";
import { bootstrapTestWorkspace } from "./test-workspace-fixture";

const roots: string[] = [];
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("HostService candidate evaluation containment", () => {
  it("serves core health while optional candidate recovery warms, then advertises it", async () => {
    const root = await mkdtemp(join(tmpdir(), "prime-candidate-service-"));
    roots.push(root);
    const store = new HostStore(root);
    const coordinator = new CandidateEvaluationCoordinator({
      authorityStore: store,
      persistence: new CandidateEvaluationStore(store.paths),
      backend: unavailableBackend(),
    });
    const started = deferred<void>();
    const release = deferred<void>();
    const finished = deferred<void>();
    let candidateReady = false;
    vi.spyOn(coordinator, "initialize").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      candidateReady = true;
      finished.resolve();
    });
    vi.spyOn(coordinator, "capabilityReady").mockImplementation(() => candidateReady);
    const service = new HostService(store, undefined, undefined, {
      candidateEvaluationCoordinator: coordinator,
      runtimeIntegrityProvider: { snapshot: readyRuntime },
    });

    const initialization = service.initialize();
    await started.promise;
    let coreReady = false;
    void initialization.then(() => { coreReady = true; });
    try {
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      expect(coreReady).toBe(true);
      const warmingHealth = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "health-during-candidate-recovery",
        method: "health.get",
        payload: {},
      }, TRUSTED_USER_SESSION);
      expect(warmingHealth).toMatchObject({ ok: true, result: { serviceState: "ready" } });
      if (!warmingHealth.ok || warmingHealth.method !== "health.get") throw new Error("health failed");
      expect(warmingHealth.result.capabilities).not.toContain("candidate_evaluation_probe_v1");

      release.resolve();
      await finished.promise;
      const readyHealth = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "health-after-candidate-recovery",
        method: "health.get",
        payload: {},
      }, TRUSTED_USER_SESSION);
      if (!readyHealth.ok || readyHealth.method !== "health.get") throw new Error("health failed");
      expect(readyHealth.result.capabilities).toContain("candidate_evaluation_probe_v1");
    } finally {
      release.resolve();
      await initialization;
      await service.close();
    }
  });

  it("joins optional candidate recovery before closing its coordinator", async () => {
    const root = await mkdtemp(join(tmpdir(), "prime-candidate-service-"));
    roots.push(root);
    const store = new HostStore(root);
    const coordinator = new CandidateEvaluationCoordinator({
      authorityStore: store,
      persistence: new CandidateEvaluationStore(store.paths),
      backend: unavailableBackend(),
    });
    const started = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(coordinator, "initialize").mockImplementation(async () => {
      started.resolve();
      await release.promise;
    });
    const coordinatorClose = vi.spyOn(coordinator, "close").mockResolvedValue();
    const service = new HostService(store, undefined, undefined, {
      candidateEvaluationCoordinator: coordinator,
      runtimeIntegrityProvider: { snapshot: readyRuntime },
    });

    await service.initialize();
    await started.promise;
    const closing = service.close();
    try {
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      expect(coordinatorClose).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await closing;
    }
    expect(coordinatorClose).toHaveBeenCalledOnce();
  });

  it("keeps health, catalog, and thread reads available when optional evaluator state is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "prime-candidate-service-"));
    roots.push(root);
    const store = new HostStore(root);
    await store.initialize();
    await bootstrapTestWorkspace(store);
    await mkdir(store.paths.candidateEvaluationOperations, { recursive: true });
    await writeFile(join(store.paths.candidateEvaluationOperations, "unexpected.txt"), "suspect-state\n");
    const coordinator = new CandidateEvaluationCoordinator({
      authorityStore: store,
      persistence: new CandidateEvaluationStore(store.paths),
      backend: unavailableBackend(),
    });
    const service = new HostService(store, undefined, undefined, {
      candidateEvaluationCoordinator: coordinator,
      runtimeIntegrityProvider: { snapshot: readyRuntime },
    });

    await expect(service.initialize()).resolves.toBeUndefined();
    const health = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "health-after-candidate-corruption",
      method: "health.get",
      payload: {},
    }, TRUSTED_USER_SESSION);
    expect(health).toMatchObject({ ok: true, result: { serviceState: "ready" } });
    if (!health.ok || health.method !== "health.get") throw new Error("health failed");
    expect(health.result.capabilities).not.toContain("candidate_evaluation_probe_v1");

    await expect(service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "catalog-after-candidate-corruption",
      method: "catalog.snapshot",
      payload: {},
    }, TRUSTED_USER_SESSION)).resolves.toMatchObject({ ok: true });
    await expect(service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "thread-after-candidate-corruption",
      method: "thread.snapshot",
      payload: { threadId: "test-thread" },
    }, TRUSTED_USER_SESSION)).resolves.toMatchObject({ ok: true });
    await expect(service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "candidate-after-corruption",
      method: "candidate.evaluation.preflight",
      payload: {
        expectedHostId: health.result.host.hostId,
        threadId: "test-thread",
        expectedExecutionGenerationId: "test-execution-1",
      },
    }, TRUSTED_USER_SESSION)).resolves.toMatchObject({
      ok: false,
      error: { code: "EVALUATOR_NOT_READY" },
    });
    await service.close();
  });
});

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

function unavailableBackend(): CandidateEvaluationBackend {
  return {
    supported: () => true,
    preflight: async () => { throw new Error("not reached"); },
    launch: async () => { throw new Error("not reached"); },
    readReceipt: async () => undefined,
    observeInvocation: async () => "unknown",
  };
}

function readyRuntime() {
  return {
    contractVersion: 1 as const,
    changedAt: "2026-08-09T12:00:00.000Z",
    trustAnchorId: digestA,
    target: {
      runtime: "prime-agent" as const,
      releaseVersion: "0.7.0",
      runtimeBuildId: "fixture-build-1",
      platform: "win32",
      arch: "x64",
      manifestSha256: digestA,
      treeSha256: digestB,
      filesSha256: digestC,
    },
    status: "ready" as const,
    assurance: "development-integrity" as const,
  };
}
