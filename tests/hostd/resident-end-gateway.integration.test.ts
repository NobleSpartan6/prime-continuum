import { bootstrapTestWorkspace } from "./test-workspace-fixture";
import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalTemporaryDirectory } from "../helpers/canonical-temp";
import type { PrimeAgentResidentAdapterOptions } from "../../src/hostd/prime-agent-resident-adapter";
import type { ResidentEndRequest } from "../../src/hostd/resident-lifecycle-coordinator";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  ResidentRuntimeContractError,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import type { VerifiedInstalledRuntimeHandle } from "../../src/hostd/runtime-integrity-manager";
import { HostStore, type ResidentKillLease } from "../../src/hostd/store";
import { VerifiedResidentGateway } from "../../src/hostd/verified-resident-gateway";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("VerifiedResidentGateway resident end materialization", () => {
  it("coalesces the exact end and emits one refresh only after terminal snapshot and catalog are readable", async () => {
    const fixture = await gatewayFixture("success");
    const durableReads: Array<Promise<unknown>> = [];
    const changes: Array<{ threadId: string; executionGenerationId: string }> = [];
    fixture.gateway.subscribeProjectionChanges((change) => {
      changes.push(change);
      durableReads.push(Promise.all([
        fixture.store.getThreadSnapshot(change.threadId),
        fixture.store.getCatalogSnapshot(),
      ]));
    });

    const first = fixture.gateway.endResident(fixture.request);
    const duplicate = fixture.gateway.endResident(fixture.request);
    await fixture.dispatchMarked.promise;
    expect(changes).toEqual([]);
    expect((await fixture.store.getThreadSnapshot(fixture.binding.threadId)).residentLifecycle).toBeUndefined();
    expect(await fixture.store.getResidentLifecycleStatus(fixture.request.operationId)).toMatchObject({
      phase: "kill_dispatching",
    });

    fixture.finishKill.resolve(undefined);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ kind: "end", phase: "completed" }),
      expect.objectContaining({ kind: "end", phase: "completed" }),
    ]);
    expect(fixture.endResidentSession).toHaveBeenCalledOnce();
    expect(changes).toEqual([{
      threadId: fixture.binding.threadId,
      executionGenerationId: fixture.binding.executionGenerationId,
    }]);
    const [[snapshot, catalog]] = await Promise.all(durableReads) as [[
      Awaited<ReturnType<HostStore["getThreadSnapshot"]>>,
      Awaited<ReturnType<HostStore["getCatalogSnapshot"]>>,
    ]];
    expect(snapshot.latestCursor).toEqual(fixture.sourceSnapshot.latestCursor);
    expect(snapshot).not.toHaveProperty("runtime");
    expect(snapshot).not.toHaveProperty("inProgressStream");
    expect(snapshot.residentLifecycle).toEqual({
      version: 1,
      state: "ended",
      operationId: fixture.request.operationId,
      bindingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      endedAt: snapshot.generatedAt,
      sourceCursor: fixture.sourceSnapshot.latestCursor,
      reason: "user_end",
    });
    expect(catalog.threads.find((thread) => thread.threadId === fixture.binding.threadId)).toEqual(snapshot.thread);
    expect(JSON.stringify(snapshot.residentLifecycle)).not.toContain(fixture.binding.activeSessionId);
    expect(JSON.stringify(snapshot.residentLifecycle)).not.toContain(fixture.binding.sessionId);
    await fixture.gateway.close();
  });

  it("never emits an ended refresh or projection when the dispatched outcome is quarantined", async () => {
    const fixture = await gatewayFixture("unknown");
    const changes = vi.fn();
    fixture.gateway.subscribeProjectionChanges(changes);

    await expect(fixture.gateway.endResident(fixture.request)).resolves.toMatchObject({
      kind: "end",
      phase: "quarantined",
      quarantinedFrom: "kill_dispatching",
    });
    expect(changes).not.toHaveBeenCalled();
    expect(await fixture.store.getThreadSnapshot(fixture.binding.threadId)).toEqual(fixture.sourceSnapshot);
    await fixture.gateway.close();
  });

  it("drains an already-dispatched acknowledgement before closing the adapter", async () => {
    const fixture = await gatewayFixture("success");
    const ending = fixture.gateway.endResident(fixture.request);
    await fixture.dispatchMarked.promise;
    let closeSettled = false;
    const closing = fixture.gateway.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(fixture.adapterClose).not.toHaveBeenCalled();

    fixture.finishKill.resolve(undefined);
    await expect(ending).resolves.toMatchObject({ phase: "completed" });
    await closing;
    expect(fixture.adapterClose).toHaveBeenCalledOnce();
    expect(await fixture.store.getResidentLifecycleStatus(fixture.request.operationId)).toMatchObject({
      phase: "completed",
    });
  });

  it("retires the exact attached read transport before issuing kill authority", async () => {
    const fixture = await gatewayFixture("success");
    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(() => expect(fixture.attachResident).toHaveBeenCalledOnce());

    const ending = fixture.gateway.endResident(fixture.request);
    await fixture.dispatchMarked.promise;
    expect(fixture.detachAttached).toHaveBeenCalledOnce();
    expect(fixture.order.indexOf("connection.detach")).toBeLessThan(
      fixture.order.indexOf("adapter.end"),
    );
    fixture.finishKill.resolve(undefined);
    await expect(ending).resolves.toMatchObject({ phase: "completed" });
    await fixture.gateway.close();
  });
});

async function gatewayFixture(outcome: "success" | "unknown") {
  const directory = await canonicalTemporaryDirectory("prime-resident-end-gateway-");
  temporaryDirectories.push(directory);
  const dataDirectory = join(directory, "data");
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspaceDirectory = await realpath(workspacePath);
  const store = new HostStore(dataDirectory);
  await store.initialize();
  await bootstrapTestWorkspace(store, { workspaceDirectory });
  await store.registerWorkspaceAuthority({
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
    workspaceDirectory,
  });
  const binding: ResidentSessionBinding = {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
    workspaceDirectory,
    activeSessionId: `resident-end-gateway-active-${outcome}`,
    sessionId: `resident-end-gateway-session-${outcome}`,
    sessionFile: join(workspaceDirectory, ".prime-agent", `resident-end-gateway-${outcome}.jsonl`),
    boundAt: new Date().toISOString(),
    runtime: {
      releaseVersion: PINNED_PRIME_AGENT_RUNTIME.releaseVersion,
      appVersion: PINNED_PRIME_AGENT_RUNTIME.expectedAppVersion,
      protocolName: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolName,
      protocolVersion: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion,
      schemaRevision: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision,
      schemaId: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId,
      capabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES],
      runtimeBuildId: PINNED_PRIME_AGENT_RUNTIME.runtimeBuildId,
      supervisorGeneration: `resident-end-gateway-supervisor-${outcome}`,
    },
  };
  await store.persistResidentSessionBinding(binding);
  const sourceSnapshot = await store.getThreadSnapshot(binding.threadId);
  const request: ResidentEndRequest = {
    operationId: `resident-end-gateway-operation-${outcome}`,
    expectedHostId: (await store.getHost()).hostId,
    projectId: "test-project",
    workspaceId: "test-workspace",
    threadId: binding.threadId,
    executionGenerationId: binding.executionGenerationId,
    expectedSourceCursor: sourceSnapshot.latestCursor,
  };
  const dispatchMarked = deferred<void>();
  const finishKill = deferred<void>();
  const adapterClose = vi.fn(async () => undefined);
  const order: string[] = [];
  const detachAttached = vi.fn(async () => { order.push("connection.detach"); });
  const attachResident = vi.fn(async (candidate: ResidentSessionBinding) => {
    order.push("connection.attach");
    return { binding: candidate, detach: detachAttached } as never;
  });
  let adapterOptions!: PrimeAgentResidentAdapterOptions;
  const endResidentSession = vi.fn(async (lease: ResidentKillLease) => {
    order.push("adapter.end");
    await adapterOptions.authorizeResidentKillInvocation!(lease);
    dispatchMarked.resolve(undefined);
    if (outcome === "unknown") {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
        "The kill response was lost after invocation.",
      );
    }
    await finishKill.promise;
    return {
      acknowledgementVersion: 1 as const,
      operation: "end" as const,
      activeSessionId: lease.binding.activeSessionId,
      sessionId: lease.binding.sessionId,
    };
  });
  const adapterFactory = vi.fn((options: PrimeAgentResidentAdapterOptions) => {
    adapterOptions = options;
    return {
      continuity: "resident" as const,
      isLive: async () => true,
      submit: async () => ({ disposition: "accepted" as const }),
      close: adapterClose,
      createOwnedCandidate: vi.fn(),
      readStableResidentProjection: vi.fn(),
      endResidentSession,
      attachResident,
      reconcileAcknowledgedPromptIdle: vi.fn(),
      reconcileAcknowledgedAbortIdle: vi.fn(),
    } as never;
  });
  const gateway = new VerifiedResidentGateway({
    store,
    runtimeHandles: {
      acquireVerifiedRuntimeHandle: vi.fn(async () => ({
        identity: {},
        executable: join(directory, "node.exe"),
        moduleUrl: new URL(`file:///${join(directory, "dist", "index.js").replaceAll("\\", "/")}`).href,
        cliEntrypoint: join(directory, "dist", "bundle", "cli.js"),
      }) as unknown as VerifiedInstalledRuntimeHandle),
    },
    platform: "win32",
    environment: {},
    adapterFactory,
    moduleLoaderFactory: () => async () => ({}),
  });
  return {
    gateway,
    store,
    binding,
    sourceSnapshot,
    request,
    dispatchMarked,
    finishKill,
    endResidentSession,
    adapterClose,
    attachResident,
    detachAttached,
    order,
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
