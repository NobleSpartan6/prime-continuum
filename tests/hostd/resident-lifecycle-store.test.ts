import { bootstrapTestWorkspace } from "./test-workspace-fixture";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResidentProjectionSnapshot } from "../../src/hostd/resident-projection";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import {
  HostStore,
  type HostStoreOptions,
  type ResidentEndLifecycleOperationInput,
  type ResidentLifecycleFaultPoint,
  type ResidentLifecycleOperationInput,
  type ResidentKillLease,
  type ResidentOwnedSessionCandidate,
} from "../../src/hostd/store";
import { PROTOCOL_VERSION, type CommandEnvelope, type ThreadProjectionSnapshot } from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function acknowledgeKill(store: HostStore, lease: ResidentKillLease) {
  await store.authorizeResidentKillInvocation(lease);
  return store.acknowledgeResidentKill(lease, {
    acknowledgementVersion: 1,
    operation: "end",
    activeSessionId: lease.binding.activeSessionId,
    sessionId: lease.binding.sessionId,
  });
}

describe("HostStore resident provisioning lifecycle", () => {
  it("keeps an activating candidate out of dispatch until an exact leased projection is durable", async () => {
    const fixture = await createFixture();
    const input = operationInput(fixture, "provision-happy");
    const prepared = await fixture.store.prepareResidentProvision(input);
    expect(await fixture.store.prepareResidentProvision(input)).toEqual(prepared);
    expect(prepared).not.toHaveProperty("requestDigest");
    expect(JSON.stringify(prepared)).not.toContain(fixture.workspaceDirectory);

    const createLease = await fixture.store.beginResidentOwnedCreate(input);
    const candidate = ownedCandidate(fixture, "happy");
    expect((await fixture.store.observeResidentOwnedCandidate(createLease, candidate)).phase).toBe("owned_observed");
    const promotionLease = await fixture.store.beginResidentPromotion(input);
    const projectionLease = await fixture.store.observeResidentPromotion(promotionLease);
    expect(await fixture.store.listResidentSessionBindings()).toEqual([]);

    const residentProjection = projection(projectionLease.binding, 10);
    await expect(
      fixture.store.publishResidentProjectionSnapshot(projectionLease.binding, residentProjection),
    ).rejects.toMatchObject({ code: "RESIDENT_PROJECTION_BINDING_NOT_FOUND" });
    await expect(fixture.store.commitResidentProvision(projectionLease)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_PROJECTION_PROOF_REQUIRED",
    });

    const published = await fixture.store.publishResidentLifecycleProjection(projectionLease, residentProjection);
    expect(published.runtime).toMatchObject({
      residency: "resident",
      activeSessionId: candidate.activeSessionId,
      sessionId: candidate.sessionId,
    });
    expect(await fixture.store.listResidentSessionBindings()).toEqual([]);
    const committed = await fixture.store.commitResidentProvision(projectionLease);
    expect(committed.boundAt).toBe(candidate.boundAt);
    expect(await fixture.store.listResidentSessionBindings()).toEqual([committed]);
    expect(await fixture.store.getResidentLifecycleStatus(input.operationId)).toMatchObject({
      phase: "committed",
      terminalAt: expect.any(String),
    });

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect(await restarted.listResidentSessionBindings()).toEqual([committed]);
    expect(await restarted.hasExactResidentProjection(committed)).toBe(true);
  });

  it("binds operation IDs exactly and accepts opaque candidate time across wall-clock rollback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2030-01-02T12:00:00.000Z");
    const fixture = await createFixture();
    const input = operationInput(fixture, "provision-identity");
    await fixture.store.prepareResidentProvision(input);
    await expect(
      fixture.store.prepareResidentProvision({ ...input, requestDigest: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED" });
    const conflictingEndInput = await endOperationInput(fixture, input.operationId, "c");
    await expect(
      fixture.store.prepareResidentEnd(conflictingEndInput, legacyBinding(fixture)),
    ).rejects.toMatchObject({ code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED" });

    const lease = await fixture.store.beginResidentOwnedCreate(input);
    vi.setSystemTime("2020-01-01T00:00:00.000Z");
    await expect(fixture.store.observeResidentOwnedCandidate(lease, {
      ...ownedCandidate(fixture, "rolled-back-clock"),
      boundAt: "2020-01-01T00:00:00.000Z",
    })).resolves.toMatchObject({
      phase: "owned_observed",
      preparedAt: "2030-01-02T12:00:00.000Z",
      updatedAt: "2030-01-02T12:00:00.000Z",
    });
  });

  it("fails closed on host, generation, project, and canonical workspace authority drift", async () => {
    const fixture = await createFixture();
    const base = operationInput(fixture, "authority-drift");
    await expect(
      fixture.store.prepareResidentProvision({ ...base, operationId: "wrong-host", expectedHostId: "wrong-host" }),
    ).rejects.toMatchObject({ code: "RESIDENT_LIFECYCLE_HOST_MISMATCH" });
    await expect(
      fixture.store.prepareResidentProvision({ ...base, operationId: "wrong-project", projectId: "wrong-project" }),
    ).rejects.toMatchObject({ code: "RESIDENT_LIFECYCLE_AUTHORITY_MISMATCH" });
    await expect(
      fixture.store.prepareResidentProvision({
        ...base,
        operationId: "wrong-generation",
        executionGenerationId: "stale-generation",
      }),
    ).rejects.toMatchObject({ code: "STALE_EXECUTION_GENERATION" });

    await fixture.store.prepareResidentProvision(base);
    const otherWorkspace = join(fixture.directory, "other-workspace");
    await mkdir(otherWorkspace);
    const authorityFile = JSON.parse(await readFile(fixture.store.paths.workspaceAuthorities, "utf8")) as {
      authorities: Array<Record<string, unknown>>;
    };
    const authority = authorityFile.authorities[0];
    if (!authority) throw new Error("workspace authority fixture missing");
    authority.workspaceDirectory = await realpath(otherWorkspace);
    await writeFile(
      fixture.store.paths.workspaceAuthorities,
      `${JSON.stringify({ version: 1, authorities: authorityFile.authorities })}\n`,
      "utf8",
    );
    await expect(fixture.store.beginResidentOwnedCreate(base)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_AUTHORITY_CHANGED",
    });
  });

  it("fences dispatch, workspace, binding, location, and handoff transitions only for the affected thread", async () => {
    const fixture = await createFixture();
    await addSecondThread(fixture.store);
    await fixture.store.registerWorkspaceAuthority({
      threadId: "second-thread",
      executionGenerationId: "test-execution-2",
      workspaceDirectory: fixture.workspaceDirectory,
    });
    const input = operationInput(fixture, "provision-fences");
    await fixture.store.prepareResidentProvision(input);

    await expect(fixture.store.persistResidentSessionBinding(legacyBinding(fixture))).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_IN_PROGRESS",
    });
    await expect(
      fixture.store.createHandoffPlan({
        threadId: "test-thread",
        sourceGenerationId: "test-execution-1",
        destinationHostId: "other-host",
        destinationProjectId: "other-project",
        behaviorIfRunning: "wait_for_idle",
      }),
    ).rejects.toMatchObject({ code: "RESIDENT_LIFECYCLE_IN_PROGRESS" });
    const command = promptCommand(fixture.hostId, "fenced-prompt", "test-thread", "test-execution-1");
    expect((await fixture.store.admitCommand(command, true)).receipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_LIFECYCLE_IN_PROGRESS" },
    });

    const second = await fixture.store.getThreadSnapshot("second-thread");
    const changed = snapshotWithThread(second, "second-thread", "changed-generation");
    await expect(fixture.store.upsertThread(changed.thread, changed)).resolves.toBeUndefined();
  });

  it("quarantines interrupted upstream mutations on restart without poisoning a sibling thread", async () => {
    const fixture = await createFixture();
    await addSecondThread(fixture.store);
    await fixture.store.registerWorkspaceAuthority({
      threadId: "second-thread",
      executionGenerationId: "test-execution-2",
      workspaceDirectory: fixture.workspaceDirectory,
    });
    const input = operationInput(fixture, "provision-unknown");
    await fixture.store.prepareResidentProvision(input);
    await fixture.store.beginResidentOwnedCreate(input);

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect(await restarted.getResidentLifecycleStatus(input.operationId)).toMatchObject({
      phase: "quarantined",
      quarantinedFrom: "owned_create_dispatching",
      quarantineReason: "external_outcome_unknown",
    });
    await expect(restarted.beginResidentOwnedCreate(input)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_RECONCILIATION_REQUIRED",
    });

    const secondInput: ResidentLifecycleOperationInput = {
      ...input,
      operationId: "second-thread-provision",
      threadId: "second-thread",
      requestDigest: "d".repeat(64),
      executionGenerationId: "test-execution-2",
    };
    expect((await restarted.prepareResidentProvision(secondInput)).phase).toBe("prepared");
  });

  it("quarantines a dispatching lifecycle on restart after wall-clock rollback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2030-09-10T12:00:00.000Z");
    const fixture = await createFixture();
    const input = operationInput(fixture, "rollback-dispatch-quarantine");
    await fixture.store.prepareResidentProvision(input);
    await fixture.store.beginResidentOwnedCreate(input);

    vi.setSystemTime("2020-09-10T12:00:00.000Z");
    const restarted = new HostStore(fixture.directory);
    await expect(restarted.initialize()).resolves.toBeUndefined();
    expect(await restarted.getResidentLifecycleStatus(input.operationId)).toMatchObject({
      phase: "quarantined",
      quarantinedFrom: "owned_create_dispatching",
      quarantineReason: "external_outcome_unknown",
      preparedAt: "2030-09-10T12:00:00.000Z",
      updatedAt: "2030-09-10T12:00:00.000Z",
    });
    await expect(restarted.getCatalogSnapshot()).resolves.toBeDefined();
  });

  it("recovers only local post-promotion work and never recreates a promotion mutation lease", async () => {
    const fixture = await createFixture();
    const input = operationInput(fixture, "provision-recovery");
    await fixture.store.prepareResidentProvision(input);
    const createLease = await fixture.store.beginResidentOwnedCreate(input);
    await fixture.store.observeResidentOwnedCandidate(createLease, ownedCandidate(fixture, "recovery"));
    const promotionLease = await fixture.store.beginResidentPromotion(input);
    const projectionLease = await fixture.store.observeResidentPromotion(promotionLease);
    const residentProjection = projection(projectionLease.binding, 15);

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    await expect(restarted.beginResidentPromotion(input)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_PHASE_CONFLICT",
    });
    const recoveryLease = await restarted.acquireResidentProvisionRecoveryLease(input);
    await restarted.publishResidentLifecycleProjection(recoveryLease, residentProjection);
    const committed = await restarted.commitResidentProvision(recoveryLease);
    expect(committed.boundAt).toBe(projectionLease.binding.boundAt);
    expect(await restarted.listResidentSessionBindings()).toEqual([committed]);
  });

  it("revokes command authority before kill dispatch and preserves explicit detach as a non-reusable identity", async () => {
    const fixture = await createFixture();
    const active = legacyBinding(fixture);
    await fixture.store.persistResidentSessionBinding(active);
    const endInput = await endOperationInput(fixture, "resident-end", "e");
    expect((await fixture.store.prepareResidentEnd(endInput, active)).phase).toBe("ending");
    expect(await fixture.store.listResidentSessionBindings()).toEqual([]);
    const command = promptCommand(fixture.hostId, "after-end-prompt", "test-thread", "test-execution-1");
    expect((await fixture.store.admitCommand(command, true)).receipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_LIFECYCLE_IN_PROGRESS" },
    });
    const killLease = await fixture.store.beginResidentKill(endInput);
    expect((await acknowledgeKill(fixture.store, killLease)).phase).toBe("completed");

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    await expect(restarted.persistResidentSessionBinding(active)).rejects.toMatchObject({
      code: "RESIDENT_BINDING_COMPLETED",
    });

    const secondFixture = await createFixture();
    const detachedBinding = legacyBinding(secondFixture, "detached");
    await secondFixture.store.persistResidentSessionBinding(detachedBinding);
    const detachInput = operationInput(secondFixture, "resident-detach", "f");
    expect((await secondFixture.store.detachResidentLifecycle(detachInput, detachedBinding)).phase).toBe("detached");
    expect(await secondFixture.store.listResidentSessionBindings()).toEqual([]);
    await expect(secondFixture.store.persistResidentSessionBinding(detachedBinding)).rejects.toMatchObject({
      code: "RESIDENT_SESSION_REUSED",
    });
  });

  it("lets durable End supersede a settled prompt proof barrier without replay or restart poison", async () => {
    const fixture = await createFixture();
    const active = legacyBinding(fixture, "end-after-settled-prompt");
    await fixture.store.persistResidentSessionBinding(active);
    const command = promptCommand(
      fixture.hostId,
      "settled-prompt-before-end",
      "test-thread",
      "test-execution-1",
    );
    await fixture.store.admitCommand(command, true);
    const dispatch = await fixture.store.beginResidentDispatch(command);
    await fixture.store.finalizeResidentDispatch(dispatch, {
      status: "running",
      message: "Prime accepted the prompt before its final idle proof arrived",
    });
    expect(await readdir(fixture.store.paths.residentDispatchAttempts)).toHaveLength(1);

    const endInput = await endOperationInput(fixture, "end-supersedes-settled-prompt", "9");
    expect(await fixture.store.prepareResidentEnd(endInput, active)).toMatchObject({ phase: "ending" });
    expect(await readdir(fixture.store.paths.residentDispatchAttempts)).toEqual([]);
    const superseded = (await fixture.store.reconcileCommands([command])).receipts[0];
    expect(superseded).toMatchObject({
      status: "uncertain",
      error: {
        code: "RESIDENT_COMMAND_SUPERSEDED_BY_END",
        retryable: false,
        details: {
          endOperationId: endInput.operationId,
          replayed: false,
        },
      },
    });

    const restarted = new HostStore(fixture.directory);
    await expect(restarted.initialize()).resolves.toBeUndefined();
    expect(await restarted.getResidentLifecycleStatus(endInput.operationId)).toMatchObject({ phase: "ending" });
    expect((await restarted.reconcileCommands([command])).receipts[0]).toEqual(superseded);
    expect(await readdir(restarted.paths.residentDispatchAttempts)).toEqual([]);

    const killLease = await restarted.beginResidentKill(endInput);
    expect(await acknowledgeKill(restarted, killLease)).toMatchObject({ phase: "completed" });
  });

  it("ends valid opaque 4K daemon identities without exposing them in the public disposition", async () => {
    const fixture = await createFixture();
    const activeSessionId = `[daemon]/active?${"a".repeat(4_080)}`;
    const sessionId = `session:#/${"b".repeat(4_086)}`;
    expect(activeSessionId).toHaveLength(4_096);
    expect(sessionId).toHaveLength(4_096);
    const active = {
      ...legacyBinding(fixture, "opaque-wire-identities"),
      activeSessionId,
      sessionId,
    };
    await fixture.store.persistResidentSessionBinding(active);
    const input = await endOperationInput(fixture, "end-opaque-wire-identities", "d");
    await fixture.store.prepareResidentEnd(input, active);
    const lease = await fixture.store.beginResidentKill(input);
    await acknowledgeKill(fixture.store, lease);

    const snapshot = await fixture.store.getThreadSnapshot(active.threadId);
    expect(snapshot.residentLifecycle).toMatchObject({
      state: "ended",
      operationId: input.operationId,
      bindingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const publicJson = JSON.stringify(snapshot);
    expect(publicJson).not.toContain(activeSessionId);
    expect(publicJson).not.toContain(sessionId);
  });

  it.each(["end", "detach"] as const)(
    "rejects a stale terminal %s operation retried against a newer resident binding",
    async (operation) => {
      const fixture = await createFixture();
      const original = legacyBinding(fixture, `stale-${operation}`);
      await fixture.store.persistResidentSessionBinding(original);
      const operationId = `stale-${operation}-operation`;
      let staleRetry: Promise<unknown>;
      if (operation === "end") {
        const input = await endOperationInput(fixture, operationId, "1");
        await fixture.store.prepareResidentEnd(input, original);
        const killLease = await fixture.store.beginResidentKill(input);
        await acknowledgeKill(fixture.store, killLease);
        const replacement = legacyBinding(fixture, `replacement-${operation}`);
        await fixture.store.persistResidentSessionBinding(replacement);
        staleRetry = fixture.store.prepareResidentEnd(input, replacement);
      } else {
        const input = operationInput(fixture, operationId, "2");
        await fixture.store.detachResidentLifecycle(input, original);
        const replacement = legacyBinding(fixture, `replacement-${operation}`);
        await fixture.store.persistResidentSessionBinding(replacement);
        staleRetry = fixture.store.detachResidentLifecycle(input, replacement);
      }
      await expect(staleRetry).rejects.toMatchObject({
        code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
      });
      expect(await fixture.store.listResidentSessionBindings()).toEqual([
        expect.objectContaining({ activeSessionId: `active-replacement-${operation}` }),
      ]);
    },
  );

  it("requires the exact lifecycle end path to complete a lifecycle-managed binding", async () => {
    const fixture = await createFixture();
    const input = operationInput(fixture, "managed-completion-fence", "3");
    await fixture.store.prepareResidentProvision(input);
    const createLease = await fixture.store.beginResidentOwnedCreate(input);
    await fixture.store.observeResidentOwnedCandidate(
      createLease,
      ownedCandidate(fixture, "managed-completion-fence"),
    );
    const promotionLease = await fixture.store.beginResidentPromotion(input);
    const projectionLease = await fixture.store.observeResidentPromotion(promotionLease);
    await fixture.store.publishResidentLifecycleProjection(
      projectionLease,
      projection(projectionLease.binding, 43),
    );
    const active = await fixture.store.commitResidentProvision(projectionLease);

    await expect(fixture.store.completeResidentSessionBinding(active)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_OPERATION_REQUIRED",
    });
    expect(await fixture.store.listResidentSessionBindings()).toEqual([active]);
  });

  it.each(["end", "detach"] as const)(
    "keeps a committed provision linked through its later %s successor across restart",
    async (successor) => {
      const fixture = await createFixture();
      const provisionInput = operationInput(fixture, `linked-provision-${successor}`, "1");
      await fixture.store.prepareResidentProvision(provisionInput);
      const createLease = await fixture.store.beginResidentOwnedCreate(provisionInput);
      await fixture.store.observeResidentOwnedCandidate(
        createLease,
        ownedCandidate(fixture, `linked-${successor}`),
      );
      const promotionLease = await fixture.store.beginResidentPromotion(provisionInput);
      const projectionLease = await fixture.store.observeResidentPromotion(promotionLease);
      await fixture.store.publishResidentLifecycleProjection(
        projectionLease,
        projection(projectionLease.binding, successor === "end" ? 41 : 42),
      );
      const active = await fixture.store.commitResidentProvision(projectionLease);
      const successorOperationId = `linked-${successor}`;
      if (successor === "end") {
        const successorInput = await endOperationInput(fixture, successorOperationId, "2");
        await fixture.store.prepareResidentEnd(successorInput, active);
        const killLease = await fixture.store.beginResidentKill(successorInput);
        await acknowledgeKill(fixture.store, killLease);
      } else {
        const successorInput = operationInput(fixture, successorOperationId, "2");
        await fixture.store.detachResidentLifecycle(successorInput, active);
      }

      const restarted = new HostStore(fixture.directory);
      await restarted.initialize();
      expect(await restarted.listResidentSessionBindings()).toEqual([]);
      expect(await restarted.getResidentLifecycleStatus(provisionInput.operationId)).toMatchObject({
        phase: "committed",
      });
      expect(await restarted.getResidentLifecycleStatus(successorOperationId)).toMatchObject({
        phase: successor === "end" ? "completed" : "detached",
      });
    },
  );

  it("keeps a rolled-back detach causally linked to its committed provision across restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2031-04-05T12:00:00.000Z");
    const fixture = await createFixture();
    const provision = await provisionActiveBinding(fixture, "rollback-detach-provision", "rollback-detach", 51);
    const provisionStatus = await fixture.store.getResidentLifecycleStatus(provision.input.operationId);
    if (!provisionStatus?.terminalAt) throw new Error("committed provision status missing");

    vi.setSystemTime("2021-04-05T12:00:00.000Z");
    const detachInput = operationInput(fixture, "rollback-detach-successor", "2");
    const detached = await fixture.store.detachResidentLifecycle(detachInput, provision.binding);
    expect(detached.phase).toBe("detached");
    expect(Date.parse(detached.preparedAt)).toBeGreaterThanOrEqual(Date.parse(provisionStatus.terminalAt));
    expect(await fixture.store.listResidentSessionBindings()).toEqual([]);

    const restarted = new HostStore(fixture.directory);
    await expect(restarted.initialize()).resolves.toBeUndefined();
    expect(await restarted.getResidentLifecycleStatus(provision.input.operationId)).toMatchObject({
      phase: "committed",
    });
    expect(await restarted.getResidentLifecycleStatus(detachInput.operationId)).toMatchObject({
      phase: "detached",
    });
    expect(await restarted.listResidentSessionBindings()).toEqual([]);
  });

  it("replays only local end revocation after rollback and restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2032-05-06T12:00:00.000Z");
    const fixture = await createFixture();
    const provision = await provisionActiveBinding(fixture, "rollback-end-provision", "rollback-end", 52);

    vi.setSystemTime("2022-05-06T12:00:00.000Z");
    const endInput = await endOperationInput(fixture, "rollback-end-successor", "3");
    const ending = await fixture.store.prepareResidentEnd(endInput, provision.binding);
    expect(ending.phase).toBe("ending");
    expect(Date.parse(ending.preparedAt)).toBeGreaterThanOrEqual(Date.parse(provision.binding.boundAt));
    expect(await fixture.store.listResidentSessionBindings()).toEqual([]);

    const restarted = new HostStore(fixture.directory);
    await expect(restarted.initialize()).resolves.toBeUndefined();
    expect(await restarted.getResidentLifecycleStatus(endInput.operationId)).toMatchObject({ phase: "ending" });
    expect(await restarted.listResidentSessionBindings()).toEqual([]);
    await expect(restarted.acquireResidentProvisionRecoveryLease(provision.input)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_RECOVERY_UNAVAILABLE",
    });
  });

  it("clamps promoted projection and commit audit time through rollback without reopening mutation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2033-06-07T12:00:00.000Z");
    const fixture = await createFixture();
    const input = operationInput(fixture, "rollback-projection-commit", "4");
    await fixture.store.prepareResidentProvision(input);
    const createLease = await fixture.store.beginResidentOwnedCreate(input);
    await fixture.store.observeResidentOwnedCandidate(createLease, ownedCandidate(fixture, "rollback-projection"));
    const promotionLease = await fixture.store.beginResidentPromotion(input);
    const projectionLease = await fixture.store.observeResidentPromotion(promotionLease);
    const promoted = await fixture.store.getResidentLifecycleStatus(input.operationId);
    if (!promoted) throw new Error("promoted lifecycle status missing");

    vi.setSystemTime("2023-06-07T12:00:00.000Z");
    const published = await fixture.store.publishResidentLifecycleProjection(
      projectionLease,
      projection(projectionLease.binding, 53),
    );
    const projectionCommitted = await fixture.store.getResidentLifecycleStatus(input.operationId);
    if (!projectionCommitted) throw new Error("projection lifecycle status missing");
    expect(Date.parse(published.generatedAt)).toBeGreaterThanOrEqual(Date.parse(promoted.updatedAt));
    expect(Date.parse(projectionCommitted.updatedAt)).toBeGreaterThanOrEqual(Date.parse(promoted.updatedAt));

    const active = await fixture.store.commitResidentProvision(projectionLease);
    const committed = await fixture.store.getResidentLifecycleStatus(input.operationId);
    expect(committed).toMatchObject({ phase: "committed", terminalAt: expect.any(String) });
    if (!committed?.terminalAt) throw new Error("committed lifecycle status missing terminal time");
    expect(Date.parse(committed.terminalAt)).toBeGreaterThanOrEqual(Date.parse(projectionCommitted.updatedAt));
    await expect(fixture.store.getCatalogSnapshot()).resolves.toBeDefined();

    const restarted = new HostStore(fixture.directory);
    await expect(restarted.initialize()).resolves.toBeUndefined();
    expect(await restarted.listResidentSessionBindings()).toEqual([active]);
    await expect(restarted.acquireResidentProvisionRecoveryLease(input)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_RECOVERY_UNAVAILABLE",
    });
  });

  it.each(["end", "detach"] as const)(
    "preserves lifecycle linkage through supervisor metadata refresh and later %s",
    async (successor) => {
      const fixture = await createFixture();
      const provisionInput = operationInput(fixture, `refresh-provision-${successor}`, "4");
      await fixture.store.prepareResidentProvision(provisionInput);
      const createLease = await fixture.store.beginResidentOwnedCreate(provisionInput);
      await fixture.store.observeResidentOwnedCandidate(
        createLease,
        ownedCandidate(fixture, `refresh-${successor}`),
      );
      const promotionLease = await fixture.store.beginResidentPromotion(provisionInput);
      const projectionLease = await fixture.store.observeResidentPromotion(promotionLease);
      await fixture.store.publishResidentLifecycleProjection(
        projectionLease,
        projection(projectionLease.binding, successor === "end" ? 44 : 45),
      );
      const active = await fixture.store.commitResidentProvision(projectionLease);
      const refreshed: ResidentSessionBinding = {
        ...active,
        runtime: {
          ...active.runtime,
          supervisorGeneration: "refreshed-supervisor-generation",
          capabilities: [...active.runtime.capabilities].reverse(),
        },
      };
      await fixture.store.persistResidentSessionBinding(refreshed);

      const reattached = new HostStore(fixture.directory);
      await reattached.initialize();
      expect(await reattached.listResidentSessionBindings()).toEqual([refreshed]);
      const successorOperationId = `refresh-${successor}`;
      if (successor === "end") {
        const successorInput = await endOperationInput(fixture, successorOperationId, "5", reattached);
        await reattached.prepareResidentEnd(successorInput, refreshed);
        const killLease = await reattached.beginResidentKill(successorInput);
        await acknowledgeKill(reattached, killLease);
      } else {
        const successorInput = operationInput(fixture, successorOperationId, "5");
        await reattached.detachResidentLifecycle(successorInput, refreshed);
      }

      const restarted = new HostStore(fixture.directory);
      await restarted.initialize();
      expect(await restarted.listResidentSessionBindings()).toEqual([]);
      expect(await restarted.getResidentLifecycleStatus(successorOperationId)).toMatchObject({
        phase: successor === "end" ? "completed" : "detached",
      });
    },
  );

  it("records definitive pre-effect failures separately from unknown mutation outcomes", async () => {
    const createFixtureValue = await createFixture();
    const createInput = operationInput(createFixtureValue, "definite-create-failure");
    await createFixtureValue.store.prepareResidentProvision(createInput);
    const createLease = await createFixtureValue.store.beginResidentOwnedCreate(createInput);
    expect(await createFixtureValue.store.failResidentOwnedCreateBeforeEffect(createLease)).toMatchObject({
      phase: "completed",
      completionReason: "owned_create_failed_before_effect",
    });
    expect(
      (await createFixtureValue.store.prepareResidentProvision({
        ...createInput,
        operationId: "safe-create-retry",
        requestDigest: "1".repeat(64),
      })).phase,
    ).toBe("prepared");

    const promotionFixture = await createFixture();
    const promotionInput = operationInput(promotionFixture, "definite-promotion-failure", "2");
    await promotionFixture.store.prepareResidentProvision(promotionInput);
    const ownedLease = await promotionFixture.store.beginResidentOwnedCreate(promotionInput);
    await promotionFixture.store.observeResidentOwnedCandidate(
      ownedLease,
      ownedCandidate(promotionFixture, "promotion-failure"),
    );
    const promotionLease = await promotionFixture.store.beginResidentPromotion(promotionInput);
    expect(await promotionFixture.store.failResidentPromotionBeforeEffect(promotionLease)).toMatchObject({
      phase: "owned_observed",
    });
    expect(await promotionFixture.store.beginResidentPromotion(promotionInput)).toMatchObject({ leaseVersion: 1 });

    const unknownFixture = await createFixture();
    const unknownInput = operationInput(unknownFixture, "unknown-create", "3");
    await unknownFixture.store.prepareResidentProvision(unknownInput);
    const unknownLease = await unknownFixture.store.beginResidentOwnedCreate(unknownInput);
    expect(await unknownFixture.store.quarantineResidentLifecycleOutcomeUnknown(unknownLease)).toMatchObject({
      phase: "quarantined",
      quarantinedFrom: "owned_create_dispatching",
      quarantineReason: "external_outcome_unknown",
    });
    await expect(unknownFixture.store.beginResidentOwnedCreate(unknownInput)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_RECONCILIATION_REQUIRED",
    });

    const cleanupFixture = await createFixture();
    const cleanupInput = operationInput(cleanupFixture, "confirmed-owned-cleanup", "0");
    await cleanupFixture.store.prepareResidentProvision(cleanupInput);
    const cleanupLease = await cleanupFixture.store.beginResidentOwnedCreate(cleanupInput);
    expect(await cleanupFixture.store.completeResidentOwnedCreateCleanup(cleanupLease)).toMatchObject({
      phase: "completed",
      completionReason: "owned_create_cleaned",
    });
    await expect(cleanupFixture.store.failResidentOwnedCreateBeforeEffect(cleanupLease)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_LEASE_INVALID",
    });

    const observedFixture = await createFixture();
    const observedInput = operationInput(observedFixture, "observed-cannot-clean-via-create", "a");
    await observedFixture.store.prepareResidentProvision(observedInput);
    const observedLease = await observedFixture.store.beginResidentOwnedCreate(observedInput);
    await observedFixture.store.observeResidentOwnedCandidate(
      observedLease,
      ownedCandidate(observedFixture, "observed-cleanup-misuse"),
    );
    await expect(observedFixture.store.completeResidentOwnedCreateCleanup(observedLease)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_LEASE_INVALID",
    });

    const killFixture = await createFixture();
    const active = legacyBinding(killFixture, "definite-kill-failure");
    await killFixture.store.persistResidentSessionBinding(active);
    const killInput = await endOperationInput(killFixture, "definite-kill-failure", "b");
    await killFixture.store.prepareResidentEnd(killInput, active);
    const firstKillLease = await killFixture.store.beginResidentKill(killInput);
    expect(await killFixture.store.failResidentKillBeforeEffect(firstKillLease)).toMatchObject({ phase: "ending" });
    const secondKillLease = await killFixture.store.beginResidentKill(killInput);
    await killFixture.store.authorizeResidentKillInvocation(secondKillLease);
    expect(await killFixture.store.quarantineResidentLifecycleOutcomeUnknown(secondKillLease)).toMatchObject({
      phase: "quarantined",
      quarantinedFrom: "kill_dispatching",
      quarantineReason: "external_outcome_unknown",
    });
  });
});

describe("HostStore resident lifecycle crash boundaries", () => {
  it.each([
    "after_prepared",
    "after_owned_create_dispatching",
    "after_owned_observed",
    "after_promotion_dispatching",
    "after_promoted_observed",
    "after_activating_binding",
    "after_projection_publication",
    "after_projection_committed",
    "after_active_binding",
    "after_committed",
  ] satisfies ResidentLifecycleFaultPoint[])("recovers fail-closed after %s", async (faultPoint) => {
    const fixture = await createFixture();
    const input = operationInput(fixture, `fault-${faultPoint}`);
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentLifecycleFaultInjector(point) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated lifecycle crash at ${point}`);
        }
      },
    });
    await crashing.initialize();

    let thrown: unknown;
    try {
      await crashing.prepareResidentProvision(input);
      const createLease = await crashing.beginResidentOwnedCreate(input);
      await crashing.observeResidentOwnedCandidate(createLease, ownedCandidate(fixture, faultPoint));
      const promotionLease = await crashing.beginResidentPromotion(input);
      const projectionLease = await crashing.observeResidentPromotion(promotionLease);
      await crashing.publishResidentLifecycleProjection(projectionLease, projection(projectionLease.binding, 22));
      await crashing.commitResidentProvision(projectionLease);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(`simulated lifecycle crash at ${faultPoint}`);
    await expect(crashing.getCatalogSnapshot()).rejects.toMatchObject({ code: "STORE_NOT_INITIALIZED" });

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    const status = await restarted.getResidentLifecycleStatus(input.operationId);
    expect(status).toBeDefined();
    if (faultPoint === "after_owned_create_dispatching" || faultPoint === "after_promotion_dispatching") {
      expect(status).toMatchObject({ phase: "quarantined", quarantineReason: "external_outcome_unknown" });
      expect(await restarted.listResidentSessionBindings()).toEqual([]);
    } else if (faultPoint === "after_owned_observed") {
      expect(status).toMatchObject({ phase: "quarantined", quarantineReason: "owned_client_lost" });
    } else if (faultPoint === "after_active_binding" || faultPoint === "after_committed") {
      expect(status?.phase).toBe("committed");
      expect(await restarted.listResidentSessionBindings()).toHaveLength(1);
    } else if (faultPoint === "after_projection_committed") {
      expect(status?.phase).toBe("projection_committed");
      expect(await restarted.listResidentSessionBindings()).toEqual([]);
    }
  });

  it("recovers reconciliation evidence durably without reopening kill authority", async () => {
    const fixture = await createFixture();
    const active = legacyBinding(fixture, "reconciliation-evidence");
    await fixture.store.persistResidentSessionBinding(active);
    const input = await endOperationInput(fixture, "end-reconciliation-evidence", "e");
    let injected = false;
    const dispatchCrash = new HostStore(fixture.directory, {
      residentLifecycleFaultInjector(point) {
        if (!injected && point === "after_kill_dispatching") {
          injected = true;
          throw new Error("simulated lost kill response");
        }
      },
    });
    await dispatchCrash.initialize();
    await dispatchCrash.prepareResidentEnd(input, active);
    const lease = await dispatchCrash.beginResidentKill(input);
    await expect(dispatchCrash.authorizeResidentKillInvocation(lease)).rejects.toThrow("simulated lost kill response");

    const quarantined = new HostStore(fixture.directory);
    await quarantined.initialize();
    expect(await quarantined.getResidentLifecycleStatus(input.operationId)).toMatchObject({
      phase: "quarantined",
      quarantinedFrom: "kill_dispatching",
      quarantineReason: "external_outcome_unknown",
    });
    const evidence = {
      evidenceVersion: 1 as const,
      operation: "end_reconciliation" as const,
      binding: active,
      disposition: "absent" as const,
    };
    await expect(quarantined.completeQuarantinedResidentEnd(input, {
      ...evidence,
      binding: { ...active, sessionId: "replacement-session" },
    })).rejects.toMatchObject({ code: "RESIDENT_LIFECYCLE_RECONCILIATION_REQUIRED" });
    expect(await quarantined.getResidentLifecycleStatus(input.operationId)).toMatchObject({ phase: "quarantined" });

    let settlementInjected = false;
    const settlementCrash = new HostStore(fixture.directory, {
      residentLifecycleFaultInjector(point) {
        if (!settlementInjected && point === "after_kill_acknowledged") {
          settlementInjected = true;
          throw new Error("simulated reconciliation settlement crash");
        }
      },
    });
    await settlementCrash.initialize();
    await expect(settlementCrash.completeQuarantinedResidentEnd(input, evidence)).rejects.toThrow(
      "simulated reconciliation settlement crash",
    );

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect(await restarted.getResidentLifecycleStatus(input.operationId)).toMatchObject({ phase: "completed" });
    await expect(restarted.beginResidentKill(input)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_PHASE_CONFLICT",
    });
    expect((await restarted.getThreadSnapshot(active.threadId)).residentLifecycle).toMatchObject({
      state: "ended",
      operationId: input.operationId,
    });
  });

  it.each([
    "after_ending",
    "after_binding_revoked",
    "after_kill_dispatching",
    "after_kill_acknowledged",
    "after_end_projection_prepare",
    "after_end_projection_snapshot",
    "after_end_projection_threads",
    "after_completed_binding",
    "after_completed",
  ] satisfies ResidentLifecycleFaultPoint[])("never replays an end mutation after %s", async (faultPoint) => {
    const fixture = await createFixture();
    const active = legacyBinding(fixture, faultPoint);
    await fixture.store.persistResidentSessionBinding(active);
    const sourceSnapshot = await fixture.store.getThreadSnapshot(active.threadId);
    const input = await endOperationInput(fixture, `end-${faultPoint}`, "4");
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentLifecycleFaultInjector(point) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated end crash at ${point}`);
        }
      },
    });
    await crashing.initialize();
    let thrown: unknown;
    try {
      await crashing.prepareResidentEnd(input, active);
      const killLease = await crashing.beginResidentKill(input);
      await acknowledgeKill(crashing, killLease);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    const status = await restarted.getResidentLifecycleStatus(input.operationId);
    expect(await restarted.listResidentSessionBindings()).toEqual([]);
    if (faultPoint === "after_kill_dispatching") {
      expect(status).toMatchObject({
        phase: "quarantined",
        quarantinedFrom: "kill_dispatching",
        quarantineReason: "external_outcome_unknown",
      });
      await expect(restarted.beginResidentKill(input)).rejects.toMatchObject({
        code: "RESIDENT_LIFECYCLE_RECONCILIATION_REQUIRED",
      });
      expect(await restarted.getThreadSnapshot(active.threadId)).toEqual(sourceSnapshot);
    } else if (faultPoint === "after_ending" || faultPoint === "after_binding_revoked") {
      expect(status?.phase).toBe("ending");
      expect(await restarted.getThreadSnapshot(active.threadId)).toEqual(sourceSnapshot);
    } else {
      expect(status?.phase).toBe("completed");
      const terminalSnapshot = await restarted.getThreadSnapshot(active.threadId);
      expect(terminalSnapshot.latestCursor).toEqual(sourceSnapshot.latestCursor);
      expect(terminalSnapshot).not.toHaveProperty("runtime");
      expect(terminalSnapshot).not.toHaveProperty("inProgressStream");
      expect(terminalSnapshot).toMatchObject({
        queueState: { pendingCommandIds: [], paused: false },
        approvals: [],
        childAgents: [],
        goals: [],
        schedules: [],
        pendingAttention: [],
        residentLifecycle: {
          version: 1,
          state: "ended",
          operationId: input.operationId,
          endedAt: terminalSnapshot.generatedAt,
          sourceCursor: sourceSnapshot.latestCursor,
          reason: "user_end",
        },
      });
      expect((await restarted.getCatalogSnapshot()).threads.find(
        (thread) => thread.threadId === active.threadId,
      )).toEqual(terminalSnapshot.thread);
      await expect(restarted.beginResidentKill(input)).rejects.toMatchObject({
        code: "RESIDENT_LIFECYCLE_PHASE_CONFLICT",
      });
      const restartedAgain = new HostStore(fixture.directory);
      await restartedAgain.initialize();
      expect(await restartedAgain.getThreadSnapshot(active.threadId)).toEqual(terminalSnapshot);
    }
  });

  it.each([
    "after_detached",
    "after_detached_binding",
  ] satisfies ResidentLifecycleFaultPoint[])("finishes only local detach materialization after %s", async (faultPoint) => {
    const fixture = await createFixture();
    const active = legacyBinding(fixture, faultPoint);
    await fixture.store.persistResidentSessionBinding(active);
    const input = operationInput(fixture, `detach-${faultPoint}`, "5");
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentLifecycleFaultInjector(point) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated detach crash at ${point}`);
        }
      },
    });
    await crashing.initialize();
    await expect(crashing.detachResidentLifecycle(input, active)).rejects.toThrow(
      `simulated detach crash at ${faultPoint}`,
    );
    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect(await restarted.getResidentLifecycleStatus(input.operationId)).toMatchObject({ phase: "detached" });
    expect(await restarted.listResidentSessionBindings()).toEqual([]);
  });

  it.each([
    "after_mutation_failed_before_effect",
    "after_owned_create_cleanup",
    "after_quarantined",
  ] satisfies ResidentLifecycleFaultPoint[])("recovers exact coordinator settlement after %s", async (faultPoint) => {
    const fixture = await createFixture();
    const input = operationInput(fixture, `settlement-${faultPoint}`, "6");
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentLifecycleFaultInjector(point) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated settlement crash at ${point}`);
        }
      },
    });
    await crashing.initialize();
    await crashing.prepareResidentProvision(input);
    const lease = await crashing.beginResidentOwnedCreate(input);
    if (faultPoint === "after_mutation_failed_before_effect") {
      await expect(crashing.failResidentOwnedCreateBeforeEffect(lease)).rejects.toThrow(
        `simulated settlement crash at ${faultPoint}`,
      );
    } else if (faultPoint === "after_owned_create_cleanup") {
      await expect(crashing.completeResidentOwnedCreateCleanup(lease)).rejects.toThrow(
        `simulated settlement crash at ${faultPoint}`,
      );
    } else {
      await expect(crashing.quarantineResidentLifecycleOutcomeUnknown(lease)).rejects.toThrow(
        `simulated settlement crash at ${faultPoint}`,
      );
    }
    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect(await restarted.getResidentLifecycleStatus(input.operationId)).toMatchObject(
      faultPoint === "after_mutation_failed_before_effect" || faultPoint === "after_owned_create_cleanup"
        ? {
            phase: "completed",
            completionReason:
              faultPoint === "after_owned_create_cleanup"
                ? "owned_create_cleaned"
                : "owned_create_failed_before_effect",
          }
        : { phase: "quarantined", quarantinedFrom: "owned_create_dispatching" },
    );
  });
});

describe("HostStore resident lifecycle terminal retirement", () => {
  it("keeps admitting work beyond the bounded registry while retired operation and session identities stay fenced", async () => {
    const operationLimit = 4;
    const lineageLimit = 4;
    const fixture = await createFixture({
      residentLifecycleOperationLimit: operationLimit,
      residentProjectionLineageLimit: lineageLimit,
    });
    let firstProvision: Awaited<ReturnType<typeof provisionActiveBinding>> | undefined;
    let firstEndInput: ResidentEndLifecycleOperationInput | undefined;
    let firstLineageName: string | undefined;
    for (let index = 0; index < operationLimit + 2; index += 1) {
      const provisioned = await provisionActiveBinding(
        fixture,
        `retirement-provision-${index}`,
        `retirement-candidate-${index}`,
        100 + index,
      );
      const endInput = await endOperationInput(fixture, `retirement-end-${index}`, "b");
      await fixture.store.prepareResidentEnd(endInput, provisioned.binding);
      const lease = await fixture.store.beginResidentKill(endInput);
      await acknowledgeKill(fixture.store, lease);
      firstProvision ??= provisioned;
      firstEndInput ??= endInput;
      if (index === 0) {
        [firstLineageName] = await readdir(fixture.store.paths.residentProjectionLineages);
      }
    }
    if (!firstProvision || !firstEndInput || !firstLineageName) {
      throw new Error("retirement fixture did not run");
    }

    expect((await readdir(fixture.store.paths.residentLifecycleOperations)).length).toBeLessThanOrEqual(operationLimit);
    const remainingLineages = await readdir(fixture.store.paths.residentProjectionLineages);
    expect(remainingLineages.length).toBeLessThan(lineageLimit);
    expect(remainingLineages).not.toContain(firstLineageName);
    expect(await fixture.store.getResidentLifecycleStatus(firstProvision.input.operationId)).toBeUndefined();
    expect(await fixture.store.getResidentLifecycleStatus(firstEndInput.operationId)).toBeUndefined();
    await expect(fixture.store.prepareResidentProvision(firstProvision.input)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
    });
    await expect(fixture.store.prepareResidentEnd(firstEndInput, firstProvision.binding)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
    });
    await expect(fixture.store.persistResidentSessionBinding(firstProvision.binding)).rejects.toMatchObject({
      code: "RESIDENT_SESSION_REUSED",
    });

    const restarted = new HostStore(fixture.directory, {
      residentLifecycleOperationLimit: operationLimit,
      residentProjectionLineageLimit: lineageLimit,
    });
    await restarted.initialize();
    expect(await readdir(restarted.paths.residentProjectionLineages)).not.toContain(firstLineageName);
    await expect(restarted.prepareResidentProvision(firstProvision.input)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
    });
    await expect(restarted.persistResidentSessionBinding(firstProvision.binding)).rejects.toMatchObject({
      code: "RESIDENT_SESSION_REUSED",
    });
  });

  it.each([
    "after_retirement_prepare",
    "after_retirement_fence",
    "after_retirement_lineage",
    "after_retirement_binding",
    "after_retirement_operations",
  ] satisfies ResidentLifecycleFaultPoint[])("recovers an interrupted terminal retirement after %s", async (faultPoint) => {
    const operationLimit = 4;
    const lineageLimit = 4;
    const fixture = await createFixture({
      residentLifecycleOperationLimit: operationLimit,
      residentProjectionLineageLimit: lineageLimit,
    });
    let retiringLineageName: string | undefined;
    for (let index = 0; index < 2; index += 1) {
      const provisioned = await provisionActiveBinding(
        fixture,
        `retirement-crash-provision-${faultPoint}-${index}`,
        `${index}-retirement-crash-candidate-${faultPoint}`,
        200 + index,
      );
      const endInput = await endOperationInput(
        fixture,
        `retirement-crash-end-${faultPoint}-${index}`,
        "c",
      );
      await fixture.store.prepareResidentEnd(endInput, provisioned.binding);
      const lease = await fixture.store.beginResidentKill(endInput);
      await acknowledgeKill(fixture.store, lease);
      if (index === 1) {
        [retiringLineageName] = await readdir(fixture.store.paths.residentProjectionLineages);
      }
    }
    if (!retiringLineageName) throw new Error("retirement lineage fixture did not run");
    const retiredOperationId = `retirement-crash-provision-${faultPoint}-0`;
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentLifecycleOperationLimit: operationLimit,
      residentProjectionLineageLimit: lineageLimit,
      residentLifecycleFaultInjector(point) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated retirement crash at ${point}`);
        }
      },
    });
    await crashing.initialize();
    const nextInput = operationInput(fixture, `retirement-crash-next-${faultPoint}`, "d");
    await expect(crashing.prepareResidentProvision(nextInput)).rejects.toThrow(
      `simulated retirement crash at ${faultPoint}`,
    );

    const restarted = new HostStore(fixture.directory, {
      residentLifecycleOperationLimit: operationLimit,
      residentProjectionLineageLimit: lineageLimit,
    });
    await restarted.initialize();
    expect(await readdir(restarted.paths.residentProjectionLineages)).not.toContain(retiringLineageName);
    await expect(restarted.prepareResidentProvision(operationInput(
      fixture,
      retiredOperationId,
    ))).rejects.toMatchObject({ code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED" });
    await expect(restarted.prepareResidentProvision(nextInput)).resolves.toMatchObject({ phase: "prepared" });
    expect((await readdir(restarted.paths.residentLifecycleOperations)).length).toBeLessThanOrEqual(operationLimit);
  });
});

describe("HostStore resident lifecycle durable validation", () => {
  it("accepts legacy v1 active/completed records and rejects cross-kind quarantine corruption", async () => {
    const fixture = await createFixture();
    const active = legacyBinding(fixture);
    await fixture.store.persistResidentSessionBinding(active);
    await fixture.store.completeResidentSessionBinding(active);
    const legacyRestart = new HostStore(fixture.directory);
    await expect(legacyRestart.initialize()).resolves.toBeUndefined();

    const second = await createFixture();
    const input = operationInput(second, "corrupt-quarantine");
    await second.store.prepareResidentProvision(input);
    const names = await readdir(second.store.paths.residentLifecycleOperations);
    const name = names[0];
    if (!name) throw new Error("lifecycle operation fixture missing");
    const path = join(second.store.paths.residentLifecycleOperations, name);
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    record.phase = "quarantined";
    record.quarantinedFrom = "kill_dispatching";
    record.quarantineReason = "external_outcome_unknown";
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");
    const corruptRestart = new HostStore(second.directory);
    await corruptRestart.initialize();
    await expect(corruptRestart.listResidentSessionBindings()).rejects.toMatchObject({
      code: "RESIDENT_SUBSYSTEM_DEGRADED",
    });
  });

  it.each(["activating", "detached", "completed"] as const)(
    "rejects a malformed %s binding-to-operation link while retaining the private state",
    async (state) => {
      const fixture = await createFixture();
      if (state === "activating") {
        const input = operationInput(fixture, "malformed-activating", "7");
        await fixture.store.prepareResidentProvision(input);
        const createLease = await fixture.store.beginResidentOwnedCreate(input);
        await fixture.store.observeResidentOwnedCandidate(createLease, ownedCandidate(fixture, "malformed"));
        const promotionLease = await fixture.store.beginResidentPromotion(input);
        await fixture.store.observeResidentPromotion(promotionLease);
      } else if (state === "detached") {
        const active = legacyBinding(fixture, "malformed-detached");
        await fixture.store.persistResidentSessionBinding(active);
        await fixture.store.detachResidentLifecycle(operationInput(fixture, "malformed-detach", "8"), active);
      } else {
        const active = legacyBinding(fixture, "malformed-completed");
        await fixture.store.persistResidentSessionBinding(active);
        const input = await endOperationInput(fixture, "malformed-end", "9");
        await fixture.store.prepareResidentEnd(input, active);
        const killLease = await fixture.store.beginResidentKill(input);
        await acknowledgeKill(fixture.store, killLease);
      }
      const file = JSON.parse(await readFile(fixture.store.paths.residentSessionBindings, "utf8")) as {
        records: Array<Record<string, unknown>>;
      };
      const record = file.records[0];
      if (!record) throw new Error("binding record fixture missing");
      record.operationId = "forged-operation-link";
      await writeFile(
        fixture.store.paths.residentSessionBindings,
        `${JSON.stringify({ version: 1, records: file.records })}\n`,
        "utf8",
      );
      const restarted = new HostStore(fixture.directory);
      await expect(restarted.initialize()).resolves.toBeUndefined();
      await expect(restarted.listResidentSessionBindings()).rejects.toMatchObject({
        code: "RESIDENT_SUBSYSTEM_DEGRADED",
      });
    },
  );

  it("re-materializes a missing activating record only from durable post-promotion state", async () => {
    const fixture = await createFixture();
    const input = operationInput(fixture, "missing-activating-recovery", "c");
    await fixture.store.prepareResidentProvision(input);
    const createLease = await fixture.store.beginResidentOwnedCreate(input);
    await fixture.store.observeResidentOwnedCandidate(createLease, ownedCandidate(fixture, "missing-activating"));
    const promotionLease = await fixture.store.beginResidentPromotion(input);
    await fixture.store.observeResidentPromotion(promotionLease);
    await writeFile(
      fixture.store.paths.residentSessionBindings,
      `${JSON.stringify({ version: 1, records: [] })}\n`,
      "utf8",
    );

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect(await restarted.getResidentLifecycleStatus(input.operationId)).toMatchObject({ phase: "promoted_observed" });
    expect(await restarted.listResidentSessionBindings()).toEqual([]);
    const privateBindingFile = JSON.parse(await readFile(restarted.paths.residentSessionBindings, "utf8")) as {
      records: Array<{ state: string; operationId?: string }>;
    };
    expect(privateBindingFile.records).toEqual([
      expect.objectContaining({ state: "activating", operationId: input.operationId }),
    ]);
  });

  it.each(["committed", "completed", "detached"] as const)(
    "fails closed when a terminal %s operation loses its required binding record",
    async (state) => {
      const fixture = await createFixture();
      if (state === "committed") {
        const input = operationInput(fixture, "missing-committed-binding", "d");
        await fixture.store.prepareResidentProvision(input);
        const createLease = await fixture.store.beginResidentOwnedCreate(input);
        await fixture.store.observeResidentOwnedCandidate(createLease, ownedCandidate(fixture, "missing-committed"));
        const promotionLease = await fixture.store.beginResidentPromotion(input);
        const projectionLease = await fixture.store.observeResidentPromotion(promotionLease);
        await fixture.store.publishResidentLifecycleProjection(projectionLease, projection(projectionLease.binding, 31));
        await fixture.store.commitResidentProvision(projectionLease);
      } else if (state === "completed") {
        const active = legacyBinding(fixture, "missing-completed");
        await fixture.store.persistResidentSessionBinding(active);
        const input = await endOperationInput(fixture, "missing-completed-binding", "e");
        await fixture.store.prepareResidentEnd(input, active);
        const killLease = await fixture.store.beginResidentKill(input);
        await acknowledgeKill(fixture.store, killLease);
      } else {
        const active = legacyBinding(fixture, "missing-detached");
        await fixture.store.persistResidentSessionBinding(active);
        await fixture.store.detachResidentLifecycle(
          operationInput(fixture, "missing-detached-binding", "f"),
          active,
        );
      }
      await writeFile(
        fixture.store.paths.residentSessionBindings,
        `${JSON.stringify({ version: 1, records: [] })}\n`,
        "utf8",
      );
      const restarted = new HostStore(fixture.directory);
      await expect(restarted.initialize()).resolves.toBeUndefined();
      await expect(restarted.listResidentSessionBindings()).rejects.toMatchObject({
        code: "RESIDENT_SUBSYSTEM_DEGRADED",
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

async function createFixture(options: HostStoreOptions = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "prime-resident-lifecycle-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const workspaceDirectory = await realpath(workspace);
  const store = new HostStore(directory, options);
  await store.initialize();
  await bootstrapTestWorkspace(store, { workspaceDirectory });
  await store.registerWorkspaceAuthority({
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
    workspaceDirectory,
  });
  return { directory, workspaceDirectory, store, hostId: (await store.getHost()).hostId };
}

function operationInput(fixture: Fixture, operationId: string, digest = "a"): ResidentLifecycleOperationInput {
  return {
    operationId,
    expectedHostId: fixture.hostId,
    projectId: "test-project",
    workspaceId: "test-workspace",
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
    requestDigest: digest.repeat(64),
  };
}

async function endOperationInput(
  fixture: Fixture,
  operationId: string,
  digest = "a",
  store: HostStore = fixture.store,
): Promise<ResidentEndLifecycleOperationInput> {
  const snapshot = await store.getThreadSnapshot("test-thread");
  return {
    ...operationInput(fixture, operationId, digest),
    expectedSourceCursor: snapshot.latestCursor,
  };
}

function ownedCandidate(fixture: Fixture, suffix: string): ResidentOwnedSessionCandidate {
  const stable = suffix.replace(/[^A-Za-z0-9]/g, "-").slice(0, 48);
  return {
    candidateVersion: 1,
    workspaceDirectory: fixture.workspaceDirectory,
    activeSessionId: `active-${stable}`,
    sessionId: `session-${stable}`,
    sessionFile: join(fixture.workspaceDirectory, ".prime-agent", `session-${stable}.jsonl`),
    boundAt: new Date(Date.now() + 5).toISOString(),
    runtime: runtimeCompatibility(),
  };
}

function legacyBinding(fixture: Fixture, suffix = "legacy"): ResidentSessionBinding {
  return {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
    workspaceDirectory: fixture.workspaceDirectory,
    activeSessionId: `active-${suffix}`,
    sessionId: `session-${suffix}`,
    sessionFile: join(fixture.workspaceDirectory, ".prime-agent", `session-${suffix}.jsonl`),
    boundAt: new Date().toISOString(),
    runtime: runtimeCompatibility(),
  };
}

function runtimeCompatibility(): ResidentOwnedSessionCandidate["runtime"] {
  return {
    releaseVersion: PINNED_PRIME_AGENT_RUNTIME.releaseVersion,
    appVersion: PINNED_PRIME_AGENT_RUNTIME.expectedAppVersion,
    protocolName: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolName,
    protocolVersion: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion,
    schemaRevision: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision,
    schemaId: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId,
    capabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES],
    runtimeBuildId: PINNED_PRIME_AGENT_RUNTIME.runtimeBuildId,
  };
}

async function provisionActiveBinding(
  fixture: Fixture,
  operationId: string,
  candidateSuffix: string,
  sequence: number,
): Promise<{ input: ResidentLifecycleOperationInput; binding: ResidentSessionBinding }> {
  const input = operationInput(fixture, operationId);
  await fixture.store.prepareResidentProvision(input);
  const createLease = await fixture.store.beginResidentOwnedCreate(input);
  await fixture.store.observeResidentOwnedCandidate(createLease, ownedCandidate(fixture, candidateSuffix));
  const promotionLease = await fixture.store.beginResidentPromotion(input);
  const projectionLease = await fixture.store.observeResidentPromotion(promotionLease);
  await fixture.store.publishResidentLifecycleProjection(
    projectionLease,
    projection(projectionLease.binding, sequence),
  );
  const binding = await fixture.store.commitResidentProvision(projectionLease);
  return { input, binding };
}

function projection(binding: ResidentSessionBinding, sequence: number): ResidentProjectionSnapshot {
  return {
    projectionVersion: 1,
    identity: {
      activeSessionId: binding.activeSessionId,
      sessionId: binding.sessionId,
      sessionFile: binding.sessionFile,
      workspaceDirectory: binding.workspaceDirectory,
    },
    cursor: { generation: "resident-lifecycle-generation", sequence },
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
      recap: "Lifecycle projection is durable.",
    },
    transcript: [
      {
        blockId: `resident-lifecycle-block-${sequence}`,
        kind: "assistant",
        text: "Exact activating projection.",
        createdAt: new Date().toISOString(),
        sequence: 0,
      },
    ],
    childAgents: [],
    queue: { queuedCount: 0, steeringCount: 0, followUpCount: 0 },
  };
}

async function addSecondThread(store: HostStore): Promise<void> {
  const source = await store.getThreadSnapshot("test-thread");
  const snapshot = snapshotWithThread(source, "second-thread", "test-execution-2");
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
    title: "Second lifecycle thread",
    currentLocation: { ...source.thread.currentLocation, executionGenerationId },
    lastKnownCursor: latestCursor,
  };
  return { ...source, generatedAt: new Date().toISOString(), thread, latestCursor };
}

function promptCommand(
  expectedHostId: string,
  commandId: string,
  threadId: string,
  executionGenerationId: string,
): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "resident-lifecycle-test",
    commandId,
    expectedHostId,
    threadId,
    issuedAt: new Date().toISOString(),
    expectedExecutionGenerationId: executionGenerationId,
    command: { kind: "prompt", text: "This dispatch must remain fenced." },
  };
}
