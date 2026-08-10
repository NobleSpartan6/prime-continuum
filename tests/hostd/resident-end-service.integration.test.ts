import { bootstrapTestWorkspace } from "./test-workspace-fixture";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrimeAgentGateway } from "../../src/hostd/gateway";
import type { ResidentProjectionSnapshot } from "../../src/hostd/resident-projection";
import {
  ResidentLifecycleCoordinator,
  type ResidentEndRequest,
} from "../../src/hostd/resident-lifecycle-coordinator";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  ResidentRuntimeContractError,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import { HostService, SSH_BRIDGE_SESSION, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { HostStore, type ResidentKillLease } from "../../src/hostd/store";
import { PROTOCOL_VERSION, type CommandEnvelope, type HostIpcRequest } from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("HostService resident end causal recovery", () => {
  it("allows exact End and status recovery over SSH while denying relay lifecycle access", async () => {
    const fixture = await serviceFixture();
    const coordinator = new ResidentLifecycleCoordinator({
      store: fixture.store,
      adapter: async () => ({
        createOwnedCandidate: undefined as never,
        readStableResidentProjection: undefined as never,
        endResidentSession: async (lease: ResidentKillLease) => {
          await fixture.store.authorizeResidentKillInvocation(lease);
          return {
            acknowledgementVersion: 1 as const,
            operation: "end" as const,
            activeSessionId: lease.binding.activeSessionId,
            sessionId: lease.binding.sessionId,
          };
        },
      }),
    });
    const service = new HostService(fixture.store, lifecycleGateway(coordinator, fixture.binding));

    await expect(service.handle(endProtocolRequest(fixture), {
      transport: "relay",
      channel: {} as never,
    })).resolves.toMatchObject({
      ok: false,
      method: "resident.end",
      error: { code: "REMOTE_RESIDENT_LIFECYCLE_FORBIDDEN" },
    });
    await expect(service.handle(endProtocolRequest(fixture), SSH_BRIDGE_SESSION)).resolves.toMatchObject({
      ok: true,
      method: "resident.end",
      result: { kind: "end", phase: "completed" },
    });
    await expect(service.handle(statusProtocolRequest(fixture), SSH_BRIDGE_SESSION)).resolves.toMatchObject({
      ok: true,
      method: "resident.lifecycle.status",
      result: { status: { kind: "end", phase: "completed" } },
    });
    await service.close();
  });

  it("retains a terminal ended control projection across restart", async () => {
    const fixture = await serviceFixture();
    const coordinator = new ResidentLifecycleCoordinator({
      store: fixture.store,
      adapter: async () => ({
        createOwnedCandidate: undefined as never,
        readStableResidentProjection: undefined as never,
        endResidentSession: async (lease: ResidentKillLease) => {
          await fixture.store.authorizeResidentKillInvocation(lease);
          return {
            acknowledgementVersion: 1 as const,
            operation: "end" as const,
            activeSessionId: lease.binding.activeSessionId,
            sessionId: lease.binding.sessionId,
          };
        },
      }),
    });
    const service = new HostService(fixture.store, lifecycleGateway(coordinator, fixture.binding));
    const before = await service.handle(controlProtocolRequest(fixture, "resident-control-before-end"), TRUSTED_USER_SESSION);
    expect(before).toMatchObject({
      ok: true,
      result: { controlSequence: 0, quiescence: { state: "idle_proven" } },
    });

    await expect(service.handle(endProtocolRequest(fixture), TRUSTED_USER_SESSION)).resolves.toMatchObject({
      ok: true,
      method: "resident.end",
      result: { kind: "end", phase: "completed" },
    });
    const ended = await service.handle(controlProtocolRequest(fixture, "resident-control-after-end"), TRUSTED_USER_SESSION);
    expect(ended).toMatchObject({
      ok: true,
      method: "thread.control.snapshot",
      result: {
        controlSequence: 1,
        quiescence: { state: "ended", endedAt: expect.any(String) },
      },
    });
    if (!ended.ok || ended.method !== "thread.control.snapshot") {
      throw new Error("terminal resident control projection was unavailable");
    }
    expect(ended.result.operation).toBeUndefined();
    await service.close();

    const restartedStore = new HostStore(fixture.dataDirectory);
    const restartedService = new HostService(restartedStore);
    await restartedService.initialize();
    const afterRestart = await restartedService.handle(
      controlProtocolRequest(fixture, "resident-control-ended-after-restart"),
      TRUSTED_USER_SESSION,
    );
    expect(afterRestart).toEqual({
      ...ended,
      requestId: "resident-control-ended-after-restart",
    });
    await restartedService.close();
  });

  it("rejects end consent after a second client advances Prompt or Stop state and requires a fresh cursor", async () => {
    const fixture = await serviceFixture();
    const reviewedRequest = fixture.endRequest;
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      advancedResidentProjection(fixture.binding, reviewedRequest.expectedSourceCursor),
    );
    const endResidentSession = vi.fn(async () => {
      throw new ResidentRuntimeContractError(
        "PRIME_RUNTIME_SESSION_NOT_FOUND",
        "Fresh review reached read-only preflight.",
      );
    });
    const coordinator = new ResidentLifecycleCoordinator({
      store: fixture.store,
      adapter: async () => ({
        createOwnedCandidate: undefined as never,
        readStableResidentProjection: undefined as never,
        endResidentSession,
      }),
    });
    const service = new HostService(fixture.store, lifecycleGateway(coordinator, fixture.binding));

    await expect(service.handle(endProtocolRequest(fixture), TRUSTED_USER_SESSION)).resolves.toMatchObject({
      ok: false,
      method: "resident.end",
      error: {
        code: "RESIDENT_END_SOURCE_CURSOR_CHANGED",
        message: "Resident state changed after end consent was reviewed; refresh the thread and confirm again",
        retryable: false,
      },
    });
    expect(await fixture.store.getResidentLifecycleStatus(reviewedRequest.operationId)).toBeUndefined();
    expect(await fixture.store.listResidentSessionBindings()).toEqual([fixture.binding]);
    expect(endResidentSession).not.toHaveBeenCalled();

    const refreshed = await fixture.store.getThreadSnapshot(fixture.binding.threadId);
    const freshRequest: ResidentEndRequest = {
      ...reviewedRequest,
      operationId: "resident-end-service-operation-after-fresh-review",
      expectedSourceCursor: refreshed.latestCursor,
    };
    await expect(service.handle({
      ...endProtocolRequest(fixture),
      requestId: "resident-end-after-fresh-review",
      payload: freshRequest,
    }, TRUSTED_USER_SESSION)).resolves.toMatchObject({
      ok: true,
      result: { kind: "end", phase: "ending" },
    });
    expect(endResidentSession).toHaveBeenCalledOnce();
    await service.close();
  });

  it("makes ending discoverable before deferred preflight and revokes concurrent Prompt and Stop", async () => {
    const fixture = await serviceFixture();
    const preflightStarted = deferred<void>();
    const finishPreflight = deferred<void>();
    const adapter = {
      createOwnedCandidate: undefined as never,
      readStableResidentProjection: undefined as never,
      endResidentSession: vi.fn(async (lease: ResidentKillLease) => {
        preflightStarted.resolve(undefined);
        await finishPreflight.promise;
        // A definitive read-only preflight failure never crosses Store's
        // dispatch marker and remains explicitly retryable as `ending`.
        throw new ResidentRuntimeContractError(
          "PRIME_RUNTIME_SESSION_NOT_FOUND",
          "The exact resident was absent during list preflight.",
        );
      }),
    };
    const coordinator = new ResidentLifecycleCoordinator({
      store: fixture.store,
      adapter: async () => adapter,
    });
    const submit = vi.fn(async () => ({ disposition: "accepted" as const }));
    const gateway = lifecycleGateway(coordinator, fixture.binding, submit);
    const service = new HostService(fixture.store, gateway);

    // The first framed session's response is intentionally left unread while
    // another session queries status, matching a lost transport response.
    const lostResponse = service.handle(endProtocolRequest(fixture), TRUSTED_USER_SESSION);
    await preflightStarted.promise;
    const observed = await service.handle(statusProtocolRequest(fixture), TRUSTED_USER_SESSION);
    expect(observed).toMatchObject({
      ok: true,
      method: "resident.lifecycle.status",
      result: { status: { kind: "end", phase: "ending" } },
    });
    expect(await fixture.store.getResidentLifecycleStatus(fixture.endRequest.operationId)).toMatchObject({
      phase: "ending",
    });

    const restarted = new HostStore(fixture.dataDirectory);
    await restarted.initialize();
    expect(await restarted.getResidentLifecycleStatus(fixture.endRequest.operationId)).toMatchObject({
      phase: "ending",
    });
    expect(adapter.endResidentSession).toHaveBeenCalledOnce();

    const [prompt, stop] = await Promise.all([
      service.handle(commandRequest(fixture, "prompt", "end-race-prompt"), TRUSTED_USER_SESSION),
      service.handle(commandRequest(fixture, "abort", "end-race-stop"), TRUSTED_USER_SESSION),
    ]);
    expect(prompt).toMatchObject({
      ok: true,
      result: { status: "rejected", error: { code: "RESIDENT_LIFECYCLE_IN_PROGRESS" } },
    });
    expect(stop).toMatchObject({
      ok: true,
      result: { status: "rejected", error: { code: "RESIDENT_SESSION_IDLE" } },
    });
    expect(submit).not.toHaveBeenCalled();

    finishPreflight.resolve(undefined);
    await expect(lostResponse).resolves.toMatchObject({
      ok: true,
      method: "resident.end",
      result: { phase: "ending" },
    });
    expect(adapter.endResidentSession).toHaveBeenCalledOnce();
    await service.close();
  });

  it("quarantines a dispatching restart and an exact retry never invokes kill again", async () => {
    const fixture = await serviceFixture();
    const dispatchMarked = deferred<void>();
    const acknowledge = deferred<void>();
    let killCalls = 0;
    const adapter = {
      createOwnedCandidate: undefined as never,
      readStableResidentProjection: undefined as never,
      endResidentSession: vi.fn(async (lease: ResidentKillLease) => {
        await fixture.store.authorizeResidentKillInvocation(lease);
        killCalls += 1;
        dispatchMarked.resolve(undefined);
        await acknowledge.promise;
        return {
          acknowledgementVersion: 1 as const,
          operation: "end" as const,
          activeSessionId: lease.binding.activeSessionId,
          sessionId: lease.binding.sessionId,
        };
      }),
    };
    const coordinator = new ResidentLifecycleCoordinator({
      store: fixture.store,
      adapter: async () => adapter,
    });
    const service = new HostService(fixture.store, lifecycleGateway(coordinator, fixture.binding));
    const lostResponse = service.handle(endProtocolRequest(fixture), TRUSTED_USER_SESSION);
    await dispatchMarked.promise;
    expect(await fixture.store.getResidentLifecycleStatus(fixture.endRequest.operationId)).toMatchObject({
      phase: "kill_dispatching",
    });

    const restarted = new HostStore(fixture.dataDirectory);
    await restarted.initialize();
    expect(await restarted.getResidentLifecycleStatus(fixture.endRequest.operationId)).toMatchObject({
      phase: "quarantined",
      quarantinedFrom: "kill_dispatching",
      quarantineReason: "external_outcome_unknown",
    });
    expect((await restarted.getThreadSnapshot(fixture.binding.threadId)).residentLifecycle).toBeUndefined();

    acknowledge.resolve(undefined);
    await expect(lostResponse).resolves.toMatchObject({
      ok: true,
      method: "resident.end",
      result: { phase: "quarantined" },
    });
    expect(killCalls).toBe(1);

    const retryAdapter = vi.fn();
    const retryCoordinator = new ResidentLifecycleCoordinator({
      store: restarted,
      adapter: async () => ({
        createOwnedCandidate: undefined as never,
        readStableResidentProjection: undefined as never,
        endResidentSession: retryAdapter,
      }),
    });
    const retryService = new HostService(restarted, lifecycleGateway(retryCoordinator, fixture.binding));
    await expect(retryService.handle({
      ...endProtocolRequest(fixture),
      requestId: "resident-end-retry-after-restart",
    }, TRUSTED_USER_SESSION)).resolves.toMatchObject({
      ok: true,
      method: "resident.end",
      result: { phase: "quarantined" },
    });
    expect(retryAdapter).not.toHaveBeenCalled();
    expect(killCalls).toBe(1);
    await Promise.all([service.close(), retryService.close()]);
  });
});

interface ServiceFixture {
  readonly dataDirectory: string;
  readonly store: HostStore;
  readonly binding: ResidentSessionBinding;
  readonly endRequest: ResidentEndRequest;
}

async function serviceFixture(): Promise<ServiceFixture> {
  const directory = await mkdtemp(join(tmpdir(), "prime-resident-end-service-"));
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
    activeSessionId: "resident-end-service-active",
    sessionId: "resident-end-service-session",
    sessionFile: join(workspaceDirectory, ".prime-agent", "resident-end-service.jsonl"),
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
      supervisorGeneration: "resident-end-service-supervisor",
    },
  };
  await store.persistResidentSessionBinding(binding);
  const initialSnapshot = await store.getThreadSnapshot(binding.threadId);
  await store.publishResidentProjectionSnapshot(
    binding,
    advancedResidentProjection(binding, initialSnapshot.latestCursor),
  );
  const sourceSnapshot = await store.getThreadSnapshot(binding.threadId);
  const endRequest: ResidentEndRequest = {
    operationId: "resident-end-service-operation",
    expectedHostId: (await store.getHost()).hostId,
    projectId: "test-project",
    workspaceId: "test-workspace",
    threadId: binding.threadId,
    executionGenerationId: binding.executionGenerationId,
    expectedSourceCursor: sourceSnapshot.latestCursor,
  };
  return { dataDirectory, store, binding, endRequest };
}

function advancedResidentProjection(
  binding: ResidentSessionBinding,
  sourceCursor: ResidentEndRequest["expectedSourceCursor"],
): ResidentProjectionSnapshot {
  return {
    projectionVersion: 1,
    identity: {
      activeSessionId: binding.activeSessionId,
      sessionId: binding.sessionId,
      sessionFile: binding.sessionFile,
      workspaceDirectory: binding.workspaceDirectory,
    },
    cursor: {
      generation: sourceCursor.generation,
      sequence: sourceCursor.sequence + 1,
    },
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
      recap: "Second client settled Prompt or Stop.",
    },
    transcript: [],
    childAgents: [],
    queue: { queuedCount: 0, steeringCount: 0, followUpCount: 0 },
  };
}

function lifecycleGateway(
  coordinator: ResidentLifecycleCoordinator,
  expectedBinding: ResidentSessionBinding,
  submit = vi.fn(async () => ({ disposition: "accepted" as const })),
): PrimeAgentGateway {
  return {
    continuity: "resident",
    residentLifecycleCapabilityReady: async () => true,
    provisionResident: async () => { throw new Error("provision is outside this fixture"); },
    endResident: (request: ResidentEndRequest) => coordinator.end(request),
    isLive: async () => true,
    isResidentBindingLive: async (binding) => isDeepStrictEqual(binding, expectedBinding),
    submit,
    close: () => coordinator.close(),
  } as PrimeAgentGateway;
}

function endProtocolRequest(fixture: ServiceFixture): HostIpcRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: "resident-end-lost-response",
    method: "resident.end",
    payload: fixture.endRequest,
  };
}

function statusProtocolRequest(fixture: ServiceFixture): HostIpcRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: "resident-end-status-second-session",
    method: "resident.lifecycle.status",
    payload: {
      expectedHostId: fixture.endRequest.expectedHostId,
      operationId: fixture.endRequest.operationId,
    },
  };
}

function controlProtocolRequest(fixture: ServiceFixture, requestId: string): HostIpcRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: "thread.control.snapshot",
    payload: {
      expectedHostId: fixture.endRequest.expectedHostId,
      threadId: fixture.endRequest.threadId,
      expectedExecutionGenerationId: fixture.endRequest.executionGenerationId,
    },
  };
}

function commandRequest(
  fixture: ServiceFixture,
  kind: "prompt" | "abort",
  commandId: string,
): HostIpcRequest {
  const command: CommandEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "resident-end-second-session",
    commandId,
    expectedHostId: fixture.endRequest.expectedHostId,
    threadId: fixture.binding.threadId,
    issuedAt: new Date().toISOString(),
    expectedExecutionGenerationId: fixture.binding.executionGenerationId,
    command: kind === "prompt"
      ? { kind: "prompt", text: "Must be fenced by resident end." }
      : { kind: "abort" },
  };
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: `request-${commandId}`,
    method: "command.submit",
    payload: { command },
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
