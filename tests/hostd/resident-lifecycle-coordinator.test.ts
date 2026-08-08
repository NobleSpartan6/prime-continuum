import { describe, expect, it, vi } from "vitest";
import {
  ResidentLifecycleCoordinator,
  type ResidentEndRequest,
  type ResidentProvisionRequest,
} from "../../src/hostd/resident-lifecycle-coordinator";
import type { ResidentOwnedRuntimeCandidate } from "../../src/hostd/prime-agent-resident-adapter";
import type { ResidentProjectionSnapshot } from "../../src/hostd/resident-projection";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  ResidentRuntimeContractError,
  type ResidentOwnedSessionCreateInput,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import type {
  ResidentLifecyclePhase,
  ResidentLifecycleStatus,
  ResidentKillLease,
} from "../../src/hostd/store";

describe("ResidentLifecycleCoordinator", () => {
  it("composes escrow, durable projection proof, commit, detach, and gateway handoff in order", async () => {
    const order: string[] = [];
    const store = fakeStore("prepared", order);
    const candidate = fakeCandidate(order);
    const adapter = {
      createOwnedCandidate: vi.fn(async (input: ResidentOwnedSessionCreateInput) => {
        order.push("runtime.create-owned");
        expect(input).toEqual({
          threadId: "thread-a",
          executionGenerationId: "execution-a",
          workspaceDirectory: WORKSPACE_DIRECTORY,
          session: { kind: "new" },
          sessionName: "Prime work",
        });
        return candidate.value;
      }),
      readStableResidentProjection: vi.fn(),
    };
    const onCommitted = vi.fn(async (committed: ResidentSessionBinding) => {
      order.push("gateway.handoff");
      expect(committed).toEqual(candidate.binding);
    });
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => adapter,
      onCommitted,
    });

    const status = await coordinator.provision(request({
      selection: { kind: "new", sessionName: " Prime work " },
    }));

    expect(status).toMatchObject({ phase: "committed", operationId: "operation-a" });
    expect(status).not.toHaveProperty("workspaceDirectory");
    expect(status).not.toHaveProperty("activeSessionId");
    expect(status).not.toHaveProperty("sessionId");
    expect(status).not.toHaveProperty("sessionFile");
    expect(adapter.createOwnedCandidate).toHaveBeenCalledOnce();
    expect(candidate.promoteToResident).toHaveBeenCalledOnce();
    expect(candidate.publishStableProjection).toHaveBeenCalledOnce();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "store.resolve-workspace",
      "store.prepare",
      "store.resolve-workspace",
      "store.begin-create",
      "runtime.create-owned",
      "store.observe-owned",
      "store.begin-promotion",
      "runtime.promote",
      "store.observe-promotion",
      "store.get-status",
      "store.acquire-projection",
      "runtime.publish-projection",
      "store.publish-projection",
      "store.commit",
      "runtime.dispose",
      "gateway.handoff",
      "store.get-status",
    ]);
  });

  it("coalesces concurrent exact duplicates before any second external mutation", async () => {
    const store = fakeStore("prepared");
    const candidate = fakeCandidate();
    const creation = deferred<ResidentOwnedRuntimeCandidate>();
    const adapter = {
      createOwnedCandidate: vi.fn(() => creation.promise),
      readStableResidentProjection: vi.fn(),
    };
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => adapter,
    });

    const first = coordinator.provision(request());
    const second = coordinator.provision(request());
    await vi.waitFor(() => expect(adapter.createOwnedCandidate).toHaveBeenCalledOnce());
    creation.resolve(candidate.value);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ phase: "committed" }),
      expect.objectContaining({ phase: "committed" }),
    ]);
    expect(store.beginResidentOwnedCreate).toHaveBeenCalledOnce();
    expect(candidate.promoteToResident).toHaveBeenCalledOnce();
  });

  it("quarantines an unknown owned-create outcome and never retries it", async () => {
    const store = fakeStore("prepared");
    const adapter = {
      createOwnedCandidate: vi.fn(async () => {
        throw unknownMutation("create");
      }),
      readStableResidentProjection: vi.fn(),
    };
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => adapter,
    });

    await expect(coordinator.provision(request())).resolves.toMatchObject({
      phase: "quarantined",
      quarantinedFrom: "owned_create_dispatching",
      quarantineReason: "external_outcome_unknown",
    });
    await expect(coordinator.provision(request())).resolves.toMatchObject({ phase: "quarantined" });
    expect(adapter.createOwnedCandidate).toHaveBeenCalledOnce();
    expect(store.failResidentOwnedCreateBeforeEffect).not.toHaveBeenCalled();
  });

  it("records a definitive pre-create failure without quarantining", async () => {
    const store = fakeStore("prepared");
    const adapter = {
      createOwnedCandidate: vi.fn(async () => {
        throw new ResidentRuntimeContractError(
          "PRIME_RUNTIME_UNAVAILABLE",
          "No create request was invoked.",
        );
      }),
      readStableResidentProjection: vi.fn(),
    };
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => adapter,
    });

    await expect(coordinator.provision(request())).resolves.toMatchObject({
      phase: "completed",
      completionReason: "owned_create_failed_before_effect",
    });
    expect(store.failResidentOwnedCreateBeforeEffect).toHaveBeenCalledOnce();
    expect(store.quarantineResidentLifecycleOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("quarantines an unclassified create exception instead of claiming it was pre-effect", async () => {
    const store = fakeStore("prepared");
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => ({
        createOwnedCandidate: vi.fn(async () => {
          throw new Error("adapter contract violation");
        }),
        readStableResidentProjection: vi.fn(),
      }),
    });

    await expect(coordinator.provision(request())).resolves.toMatchObject({
      phase: "quarantined",
      quarantinedFrom: "owned_create_dispatching",
    });
    expect(store.failResidentOwnedCreateBeforeEffect).not.toHaveBeenCalled();
  });

  it("attempts only unverified cleanup and quarantines when candidate observation fails", async () => {
    const store = fakeStore("prepared");
    store.observeResidentOwnedCandidate.mockRejectedValueOnce(new Error("durable observation failed"));
    const candidate = fakeCandidate();
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => ({
        createOwnedCandidate: async () => candidate.value,
        readStableResidentProjection: vi.fn(),
      }),
    });

    await expect(coordinator.provision(request())).resolves.toMatchObject({
      phase: "quarantined",
      quarantinedFrom: "owned_create_dispatching",
    });
    expect(candidate.attemptUnverifiedOwnedCleanup).toHaveBeenCalledOnce();
    expect(candidate.dispose).not.toHaveBeenCalled();
    expect(store.quarantineResidentLifecycleOutcomeUnknown).toHaveBeenCalledOnce();
    expect(store.commitResidentProvision).not.toHaveBeenCalled();
  });

  it("never replays an unknown promotion and abandons only the local candidate", async () => {
    const store = fakeStore("prepared");
    const candidate = fakeCandidate();
    candidate.promoteToResident.mockRejectedValueOnce(unknownMutation("promote_owned_session"));
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => ({
        createOwnedCandidate: async () => candidate.value,
        readStableResidentProjection: vi.fn(),
      }),
    });

    await expect(coordinator.provision(request())).resolves.toMatchObject({
      phase: "quarantined",
      quarantinedFrom: "promotion_dispatching",
      quarantineReason: "external_outcome_unknown",
    });
    await expect(coordinator.provision(request())).resolves.toMatchObject({ phase: "quarantined" });
    expect(candidate.promoteToResident).toHaveBeenCalledOnce();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(store.failResidentPromotionBeforeEffect).not.toHaveBeenCalled();
  });

  it("quarantines an unclassified promotion exception instead of reopening promotion", async () => {
    const store = fakeStore("prepared");
    const candidate = fakeCandidate();
    candidate.promoteToResident.mockRejectedValueOnce(new Error("candidate contract violation"));
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => ({
        createOwnedCandidate: async () => candidate.value,
        readStableResidentProjection: vi.fn(),
      }),
    });

    await expect(coordinator.provision(request())).resolves.toMatchObject({
      phase: "quarantined",
      quarantinedFrom: "promotion_dispatching",
    });
    expect(store.failResidentPromotionBeforeEffect).not.toHaveBeenCalled();
  });

  it("retries only local projection work while retaining process-local promoted authority", async () => {
    const store = fakeStore("prepared");
    const candidate = fakeCandidate();
    candidate.publishStableProjection
      .mockRejectedValueOnce(new Error("stable read unavailable"))
      .mockImplementationOnce(async (publisher) => {
        await publisher(candidate.binding, {} as ResidentProjectionSnapshot);
        return {} as ResidentProjectionSnapshot;
      });
    const adapter = {
      createOwnedCandidate: vi.fn(async () => candidate.value),
      readStableResidentProjection: vi.fn(),
    };
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => adapter,
    });

    await expect(coordinator.provision(request())).resolves.toMatchObject({ phase: "promoted_observed" });
    await expect(coordinator.provision(request())).resolves.toMatchObject({ phase: "committed" });
    expect(adapter.createOwnedCandidate).toHaveBeenCalledOnce();
    expect(candidate.promoteToResident).toHaveBeenCalledOnce();
    expect(candidate.publishStableProjection).toHaveBeenCalledTimes(2);
    expect(store.publishResidentLifecycleProjection).toHaveBeenCalledOnce();
    expect(store.commitResidentProvision).toHaveBeenCalledOnce();
  });

  it("commits durable projection proof after coordinator restart without create or promotion authority", async () => {
    const store = fakeStore("projection_committed");
    const adapter = { createOwnedCandidate: vi.fn(), readStableResidentProjection: vi.fn() };
    const onCommitted = vi.fn();
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => adapter,
      onCommitted,
    });

    await expect(coordinator.provision(request())).resolves.toMatchObject({ phase: "committed" });
    expect(adapter.createOwnedCandidate).not.toHaveBeenCalled();
    expect(store.beginResidentPromotion).not.toHaveBeenCalled();
    expect(store.publishResidentLifecycleProjection).not.toHaveBeenCalled();
    expect(store.commitResidentProvision).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledWith(expect.objectContaining({ activeSessionId: "active-a" }));
  });

  it("recovers promoted durable state after restart with only an exact read-only projection", async () => {
    const store = fakeStore("promoted_observed");
    const adapter = {
      createOwnedCandidate: vi.fn(),
      readStableResidentProjection: vi.fn(async (binding: ResidentSessionBinding) => {
        expect(binding).toEqual(residentBinding());
        return {} as ResidentProjectionSnapshot;
      }),
    };
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => adapter,
    });

    await expect(coordinator.provision(request())).resolves.toMatchObject({ phase: "committed" });
    expect(adapter.createOwnedCandidate).not.toHaveBeenCalled();
    expect(adapter.readStableResidentProjection).toHaveBeenCalledOnce();
    expect(store.beginResidentOwnedCreate).not.toHaveBeenCalled();
    expect(store.beginResidentPromotion).not.toHaveBeenCalled();
    expect(store.publishResidentLifecycleProjection).toHaveBeenCalledOnce();
    expect(store.commitResidentProvision).toHaveBeenCalledOnce();
  });

  it.each(["owned_create_dispatching", "promotion_dispatching"] as const)(
    "returns durable %s status without replaying an external mutation",
    async (phase) => {
      const store = fakeStore(phase);
      const adapter = { createOwnedCandidate: vi.fn(), readStableResidentProjection: vi.fn() };
      const coordinator = new ResidentLifecycleCoordinator({
        store: store.value,
        adapter: async () => adapter,
      });

      await expect(coordinator.provision(request())).resolves.toMatchObject({ phase });
      expect(adapter.createOwnedCandidate).not.toHaveBeenCalled();
      expect(store.beginResidentOwnedCreate).not.toHaveBeenCalled();
      expect(store.beginResidentPromotion).not.toHaveBeenCalled();
    },
  );

  it("drains a deferred create before close returns and fences the committed handoff", async () => {
    const store = fakeStore("prepared");
    const candidate = fakeCandidate();
    const creation = deferred<ResidentOwnedRuntimeCandidate>();
    const onCommitted = vi.fn();
    const createOwnedCandidate = vi.fn(() => creation.promise);
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => ({
        createOwnedCandidate,
        readStableResidentProjection: vi.fn(),
      }),
      onCommitted,
    });
    const provisioning = coordinator.provision(request());
    await vi.waitFor(() => expect(createOwnedCandidate).toHaveBeenCalledOnce());

    let closeSettled = false;
    const closing = coordinator.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    creation.resolve(candidate.value);

    await expect(provisioning).resolves.toMatchObject({ phase: "owned_observed" });
    await closing;
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(candidate.promoteToResident).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
    await expect(coordinator.provision(request())).rejects.toMatchObject({
      code: "RESIDENT_PROVISION_COORDINATOR_CLOSED",
    });
  });

  it("preserves unknown create classification when close crosses its invocation", async () => {
    const store = fakeStore("prepared");
    const creation = deferred<ResidentOwnedRuntimeCandidate>();
    const createOwnedCandidate = vi.fn(() => creation.promise);
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => ({ createOwnedCandidate, readStableResidentProjection: vi.fn() }),
    });
    const provisioning = coordinator.provision(request());
    await vi.waitFor(() => expect(createOwnedCandidate).toHaveBeenCalledOnce());
    const closing = coordinator.close();

    creation.reject(unknownMutation("create"));

    await expect(provisioning).resolves.toMatchObject({
      phase: "quarantined",
      quarantinedFrom: "owned_create_dispatching",
    });
    await closing;
    expect(store.failResidentOwnedCreateBeforeEffect).not.toHaveBeenCalled();
    expect(store.quarantineResidentLifecycleOutcomeUnknown).toHaveBeenCalledOnce();
  });

  it("drains a deferred promotion without downgrading its eventual outcome during close", async () => {
    const store = fakeStore("prepared");
    const candidate = fakeCandidate();
    const promotion = deferred<void>();
    candidate.promoteToResident.mockImplementationOnce(() => promotion.promise);
    const onCommitted = vi.fn();
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => ({
        createOwnedCandidate: async () => candidate.value,
        readStableResidentProjection: vi.fn(),
      }),
      onCommitted,
    });
    const provisioning = coordinator.provision(request());
    await vi.waitFor(() => expect(candidate.promoteToResident).toHaveBeenCalledOnce());

    let closeSettled = false;
    const closing = coordinator.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    promotion.resolve(undefined);

    await expect(provisioning).resolves.toMatchObject({ phase: "promoted_observed" });
    await closing;
    expect(store.failResidentPromotionBeforeEffect).not.toHaveBeenCalled();
    expect(store.quarantineResidentLifecycleOutcomeUnknown).not.toHaveBeenCalled();
    expect(store.publishResidentLifecycleProjection).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it("drains deferred projection publication but fences the later commit", async () => {
    const store = fakeStore("prepared");
    const candidate = fakeCandidate();
    const projection = deferred<void>();
    candidate.publishStableProjection.mockImplementationOnce(async (publisher) => {
      const snapshot = {} as ResidentProjectionSnapshot;
      await publisher(candidate.binding, snapshot);
      await projection.promise;
      return snapshot;
    });
    const onCommitted = vi.fn();
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => ({
        createOwnedCandidate: async () => candidate.value,
        readStableResidentProjection: vi.fn(),
      }),
      onCommitted,
    });
    const provisioning = coordinator.provision(request());
    await vi.waitFor(() => expect(store.publishResidentLifecycleProjection).toHaveBeenCalledOnce());

    let closeSettled = false;
    const closing = coordinator.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    projection.resolve(undefined);

    await expect(provisioning).resolves.toMatchObject({ phase: "projection_committed" });
    await closing;
    expect(store.commitResidentProvision).not.toHaveBeenCalled();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it("does not admit a caller-supplied workspace path", async () => {
    const store = fakeStore("prepared");
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => ({
        createOwnedCandidate: vi.fn(),
        readStableResidentProjection: vi.fn(),
      }),
    });

    await expect(coordinator.provision({
      ...request(),
      workspaceDirectory: "C:\\attacker-controlled",
    } as ResidentProvisionRequest)).rejects.toThrow();
    expect(store.resolveWorkspaceDirectory).not.toHaveBeenCalled();
  });

  it("persists end intent before deferred adapter readiness and coalesces the exact envelope", async () => {
    const order: string[] = [];
    const store = fakeEndStore(order);
    const adapterGate = deferred<{
      createOwnedCandidate: never;
      readStableResidentProjection: never;
      endResidentSession(lease: ResidentKillLease): Promise<{
        acknowledgementVersion: 1;
        operation: "end";
        activeSessionId: string;
        sessionId: string;
      }>;
    }>();
    const adapterFactory = vi.fn(() => adapterGate.promise);
    const endResidentSession = vi.fn(async (lease: ResidentKillLease) => {
      order.push("runtime.end");
      return {
        acknowledgementVersion: 1 as const,
        operation: "end" as const,
        activeSessionId: lease.binding.activeSessionId,
        sessionId: lease.binding.sessionId,
      };
    });
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: adapterFactory as never,
      onEnding: () => { order.push("gateway.ending"); },
      onEnded: () => { order.push("gateway.ended"); },
    });

    const first = coordinator.end(endRequest());
    const duplicate = coordinator.end(endRequest());
    await vi.waitFor(() => expect(adapterFactory).toHaveBeenCalledOnce());
    expect(await store.getResidentLifecycleStatus()).toMatchObject({ kind: "end", phase: "ending" });
    expect(store.beginResidentKill).not.toHaveBeenCalled();
    await expect(coordinator.end(endRequest({
      expectedSourceCursor: {
        ...endRequest().expectedSourceCursor,
        sequence: endRequest().expectedSourceCursor.sequence + 1,
      },
    }))).rejects.toMatchObject({ code: "RESIDENT_END_OPERATION_ID_REUSED" });

    adapterGate.resolve({
      createOwnedCandidate: undefined as never,
      readStableResidentProjection: undefined as never,
      endResidentSession,
    });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ kind: "end", phase: "completed" }),
      expect.objectContaining({ kind: "end", phase: "completed" }),
    ]);
    expect(endResidentSession).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "store.prepare-end",
      "store.get-end-binding",
      "gateway.ending",
      "store.get-status",
      "store.begin-kill",
      "runtime.end",
      "store.ack-kill",
      "gateway.ended",
    ]);
  });

  it("drains an already-dispatched end acknowledgement before close retires the coordinator", async () => {
    const store = fakeEndStore();
    const acknowledgement = deferred<{
      acknowledgementVersion: 1;
      operation: "end";
      activeSessionId: string;
      sessionId: string;
    }>();
    const endResidentSession = vi.fn(() => acknowledgement.promise);
    const onEnded = vi.fn();
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => ({
        createOwnedCandidate: undefined as never,
        readStableResidentProjection: undefined as never,
        endResidentSession,
      }),
      onEnded,
    });
    const ending = coordinator.end(endRequest());
    await vi.waitFor(() => expect(endResidentSession).toHaveBeenCalledOnce());
    let closeSettled = false;
    const closing = coordinator.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    acknowledgement.resolve({
      acknowledgementVersion: 1,
      operation: "end",
      activeSessionId: residentBinding().activeSessionId,
      sessionId: residentBinding().sessionId,
    });
    await expect(ending).resolves.toMatchObject({ phase: "completed" });
    await closing;
    expect(store.acknowledgeResidentKill).toHaveBeenCalledOnce();
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it.each([
    ["unknown rejection", () => Promise.reject(unknownMutation("kill"))],
    ["malformed acknowledgement", () => Promise.resolve({ acknowledgementVersion: 1, operation: "end" })],
  ] as const)("quarantines a %s after the adapter boundary and never emits terminal refresh", async (_label, result) => {
    const store = fakeEndStore();
    const onEnded = vi.fn();
    const coordinator = new ResidentLifecycleCoordinator({
      store: store.value,
      adapter: async () => ({
        createOwnedCandidate: undefined as never,
        readStableResidentProjection: undefined as never,
        endResidentSession: result as never,
      }),
      onEnded,
    });

    await expect(coordinator.end(endRequest())).resolves.toMatchObject({
      kind: "end",
      phase: "quarantined",
      quarantinedFrom: "kill_dispatching",
    });
    expect(store.acknowledgeResidentKill).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
  });
});

function request(overrides: Partial<ResidentProvisionRequest> = {}): ResidentProvisionRequest {
  return {
    operationId: "operation-a",
    expectedHostId: "host-a",
    projectId: "project-a",
    workspaceId: "workspace-a",
    threadId: "thread-a",
    executionGenerationId: "execution-a",
    selection: { kind: "new" },
    ...overrides,
  };
}

function endRequest(overrides: Partial<ResidentEndRequest> = {}): ResidentEndRequest {
  return {
    operationId: "end-operation-a",
    expectedHostId: "host-a",
    projectId: "project-a",
    workspaceId: "workspace-a",
    threadId: "thread-a",
    executionGenerationId: "execution-a",
    expectedSourceCursor: {
      threadId: "thread-a",
      executionGenerationId: "execution-a",
      generation: "generation-a",
      sequence: 1,
    },
    ...overrides,
  };
}

function fakeEndStore(order: string[] = []) {
  const binding = residentBinding();
  let status = lifecycleStatus("ending", {
    kind: "end",
    operationId: "end-operation-a",
  });
  const lease = {
    leaseVersion: 1,
    operationId: status.operationId,
    operationFingerprint: "a".repeat(64),
    binding,
    dispatchStartedAt: NOW,
  } as unknown as ResidentKillLease;
  const getResidentLifecycleStatus = vi.fn(async () => {
    order.push("store.get-status");
    return status;
  });
  const prepareResidentEnd = vi.fn(async () => {
    order.push("store.prepare-end");
    status = lifecycleStatus("ending", { kind: "end", operationId: "end-operation-a" });
    return status;
  });
  const getResidentEndBinding = vi.fn(async () => {
    order.push("store.get-end-binding");
    return binding;
  });
  const beginResidentKill = vi.fn(async () => {
    order.push("store.begin-kill");
    return lease;
  });
  const failResidentKillBeforeEffect = vi.fn(async () => {
    order.push("store.fail-kill");
    status = lifecycleStatus("ending", { kind: "end", operationId: "end-operation-a" });
    return status;
  });
  const quarantineResidentLifecycleOutcomeUnknown = vi.fn(async () => {
    order.push("store.quarantine-kill");
    status = lifecycleStatus("quarantined", {
      kind: "end",
      operationId: "end-operation-a",
      quarantinedFrom: "kill_dispatching",
      quarantineReason: "external_outcome_unknown",
    });
    return status;
  });
  const acknowledgeResidentKill = vi.fn(async () => {
    order.push("store.ack-kill");
    status = lifecycleStatus("completed", {
      kind: "end",
      operationId: "end-operation-a",
      terminalAt: NOW,
    });
    return status;
  });
  const completeAcknowledgedResidentEnd = vi.fn(async () => status);
  const value = {
    getResidentLifecycleStatus,
    prepareResidentEnd,
    getResidentEndBinding,
    beginResidentKill,
    failResidentKillBeforeEffect,
    quarantineResidentLifecycleOutcomeUnknown,
    acknowledgeResidentKill,
    completeAcknowledgedResidentEnd,
  };
  return { value: value as never, ...value };
}

function fakeStore(initialPhase: ResidentLifecyclePhase, order: string[] = []) {
  let status = lifecycleStatus(initialPhase);
  const binding = residentBinding();
  const resolveWorkspaceDirectory = vi.fn(async () => {
    order.push("store.resolve-workspace");
    return WORKSPACE_DIRECTORY;
  });
  const getResidentLifecycleStatus = vi.fn(async () => {
    order.push("store.get-status");
    return status;
  });
  const prepareResidentProvision = vi.fn(async () => {
    order.push("store.prepare");
    return status;
  });
  const beginResidentOwnedCreate = vi.fn(async () => {
    order.push("store.begin-create");
    status = lifecycleStatus("owned_create_dispatching");
    return { leaseVersion: 1, kind: "create" } as never;
  });
  const observeResidentOwnedCandidate = vi.fn(async () => {
    order.push("store.observe-owned");
    status = lifecycleStatus("owned_observed");
    return status;
  });
  const failResidentOwnedCreateBeforeEffect = vi.fn(async () => {
    status = lifecycleStatus("completed", {
      completionReason: "owned_create_failed_before_effect",
      terminalAt: NOW,
    });
    return status;
  });
  const beginResidentPromotion = vi.fn(async () => {
    order.push("store.begin-promotion");
    status = lifecycleStatus("promotion_dispatching");
    return { leaseVersion: 1, kind: "promotion" } as never;
  });
  const failResidentPromotionBeforeEffect = vi.fn(async () => {
    status = lifecycleStatus("owned_observed");
    return status;
  });
  const observeResidentPromotion = vi.fn(async () => {
    order.push("store.observe-promotion");
    status = lifecycleStatus("promoted_observed");
    return { leaseVersion: 1, binding } as never;
  });
  const acquireResidentProvisionRecoveryLease = vi.fn(async () => {
    order.push("store.acquire-projection");
    return { leaseVersion: 1, binding } as never;
  });
  const publishResidentLifecycleProjection = vi.fn(async () => {
    order.push("store.publish-projection");
    status = lifecycleStatus("projection_committed");
    return {} as never;
  });
  const commitResidentProvision = vi.fn(async () => {
    order.push("store.commit");
    status = lifecycleStatus("committed", { terminalAt: NOW });
    return binding;
  });
  const quarantineResidentLifecycleOutcomeUnknown = vi.fn(async () => {
    const quarantinedFrom = status.phase as ResidentLifecycleStatus["quarantinedFrom"];
    status = lifecycleStatus("quarantined", {
      quarantinedFrom,
      quarantineReason: "external_outcome_unknown",
    });
    return status;
  });
  const value = {
    resolveWorkspaceDirectory,
    getResidentLifecycleStatus,
    prepareResidentProvision,
    beginResidentOwnedCreate,
    observeResidentOwnedCandidate,
    failResidentOwnedCreateBeforeEffect,
    beginResidentPromotion,
    failResidentPromotionBeforeEffect,
    observeResidentPromotion,
    acquireResidentProvisionRecoveryLease,
    publishResidentLifecycleProjection,
    commitResidentProvision,
    quarantineResidentLifecycleOutcomeUnknown,
  };
  return { value: value as never, ...value };
}

function fakeCandidate(order: string[] = []) {
  const binding = residentBinding();
  const promoteToResident = vi.fn(async () => {
    order.push("runtime.promote");
  });
  const publishStableProjection = vi.fn(async (
    publisher: (
      binding: ResidentSessionBinding,
      projection: ResidentProjectionSnapshot,
    ) => Promise<void>,
  ) => {
    order.push("runtime.publish-projection");
    const projection = {} as ResidentProjectionSnapshot;
    await publisher(binding, projection);
    return projection;
  });
  const attemptUnverifiedOwnedCleanup = vi.fn(async () => ({
    disposition: "attempted_unverified" as const,
    durableCompletionAuthorized: false as const,
    reason: "prime_v0_7_dispose_suppresses_complete_response" as const,
  }));
  const dispose = vi.fn(async () => {
    order.push("runtime.dispose");
  });
  const value = {
    candidateVersion: 1,
    threadId: binding.threadId,
    executionGenerationId: binding.executionGenerationId,
    workspaceDirectory: binding.workspaceDirectory,
    activeSessionId: binding.activeSessionId,
    sessionId: binding.sessionId,
    sessionFile: binding.sessionFile,
    boundAt: binding.boundAt,
    runtime: binding.runtime,
    promoteToResident,
    readStableProjection: vi.fn(),
    publishStableProjection,
    attemptUnverifiedOwnedCleanup,
    dispose,
  } as unknown as ResidentOwnedRuntimeCandidate;
  return {
    value,
    binding,
    promoteToResident,
    publishStableProjection,
    attemptUnverifiedOwnedCleanup,
    dispose,
  };
}

function residentBinding(): ResidentSessionBinding {
  return {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId: "thread-a",
    executionGenerationId: "execution-a",
    workspaceDirectory: WORKSPACE_DIRECTORY,
    activeSessionId: "active-a",
    sessionId: "session-a",
    sessionFile: "C:\\sessions\\session-a.jsonl",
    boundAt: "2026-08-08T12:00:01.000Z",
    runtime: {
      releaseVersion: PINNED_PRIME_AGENT_RUNTIME.releaseVersion,
      appVersion: PINNED_PRIME_AGENT_RUNTIME.expectedAppVersion,
      protocolName: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolName,
      protocolVersion: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion,
      schemaRevision: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision,
      schemaId: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId,
      capabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES],
      runtimeBuildId: PINNED_PRIME_AGENT_RUNTIME.runtimeBuildId,
      supervisorGeneration: "supervisor-a",
    },
  };
}

function lifecycleStatus(
  phase: ResidentLifecyclePhase,
  extras: Partial<ResidentLifecycleStatus> = {},
): ResidentLifecycleStatus {
  return {
    version: 1,
    kind: "provision",
    operationId: "operation-a",
    phase,
    expectedHostId: "host-a",
    projectId: "project-a",
    workspaceId: "workspace-a",
    threadId: "thread-a",
    executionGenerationId: "execution-a",
    preparedAt: NOW,
    updatedAt: NOW,
    ...extras,
  };
}

function unknownMutation(command: string): ResidentRuntimeContractError {
  return new ResidentRuntimeContractError(
    "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN",
    "External mutation outcome is unknown.",
    { details: { command, outcome: "unknown" } },
  );
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

const NOW = "2026-08-08T12:00:00.000Z";
const WORKSPACE_DIRECTORY = "C:\\workspaces\\thread-a";
