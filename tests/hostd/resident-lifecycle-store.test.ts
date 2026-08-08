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
  type ResidentLifecycleFaultPoint,
  type ResidentLifecycleOperationInput,
  type ResidentOwnedSessionCandidate,
} from "../../src/hostd/store";
import { PROTOCOL_VERSION, type CommandEnvelope, type ThreadProjectionSnapshot } from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

  it("binds operation IDs to one exact envelope and rejects candidate authority or time substitution", async () => {
    const fixture = await createFixture();
    const input = operationInput(fixture, "provision-identity");
    await fixture.store.prepareResidentProvision(input);
    await expect(
      fixture.store.prepareResidentProvision({ ...input, requestDigest: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED" });
    await expect(
      fixture.store.prepareResidentEnd({ ...input, requestDigest: "c".repeat(64) }, legacyBinding(fixture)),
    ).rejects.toMatchObject({ code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED" });

    const lease = await fixture.store.beginResidentOwnedCreate(input);
    await expect(
      fixture.store.observeResidentOwnedCandidate(lease, {
        ...ownedCandidate(fixture, "too-early"),
        boundAt: "2020-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "RESIDENT_LIFECYCLE_CANDIDATE_TIME_INVALID" });
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
      executionGenerationId: "demo-execution-2",
      workspaceDirectory: fixture.workspaceDirectory,
    });
    const input = operationInput(fixture, "provision-fences");
    await fixture.store.prepareResidentProvision(input);

    await expect(fixture.store.persistResidentSessionBinding(legacyBinding(fixture))).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_IN_PROGRESS",
    });
    await expect(
      fixture.store.createHandoffPlan({
        threadId: "demo-thread",
        sourceGenerationId: "demo-execution-1",
        destinationHostId: "other-host",
        destinationProjectId: "other-project",
        behaviorIfRunning: "wait_for_idle",
      }),
    ).rejects.toMatchObject({ code: "RESIDENT_LIFECYCLE_IN_PROGRESS" });
    const command = promptCommand(fixture.hostId, "fenced-prompt", "demo-thread", "demo-execution-1");
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
      executionGenerationId: "demo-execution-2",
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
      executionGenerationId: "demo-execution-2",
    };
    expect((await restarted.prepareResidentProvision(secondInput)).phase).toBe("prepared");
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
    const endInput = operationInput(fixture, "resident-end", "e");
    expect((await fixture.store.prepareResidentEnd(endInput, active)).phase).toBe("ending");
    expect(await fixture.store.listResidentSessionBindings()).toEqual([]);
    const command = promptCommand(fixture.hostId, "after-end-prompt", "demo-thread", "demo-execution-1");
    expect((await fixture.store.admitCommand(command, true)).receipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_LIFECYCLE_IN_PROGRESS" },
    });
    const killLease = await fixture.store.beginResidentKill(endInput);
    expect((await fixture.store.acknowledgeResidentKill(killLease)).phase).toBe("completed");

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

  it.each(["end", "detach"] as const)(
    "rejects a stale terminal %s operation retried against a newer resident binding",
    async (operation) => {
      const fixture = await createFixture();
      const original = legacyBinding(fixture, `stale-${operation}`);
      await fixture.store.persistResidentSessionBinding(original);
      const input = operationInput(fixture, `stale-${operation}-operation`, operation === "end" ? "1" : "2");
      if (operation === "end") {
        await fixture.store.prepareResidentEnd(input, original);
        const killLease = await fixture.store.beginResidentKill(input);
        await fixture.store.acknowledgeResidentKill(killLease);
      } else {
        await fixture.store.detachResidentLifecycle(input, original);
      }

      const replacement = legacyBinding(fixture, `replacement-${operation}`);
      await fixture.store.persistResidentSessionBinding(replacement);
      const staleRetry = operation === "end"
        ? fixture.store.prepareResidentEnd(input, replacement)
        : fixture.store.detachResidentLifecycle(input, replacement);
      await expect(staleRetry).rejects.toMatchObject({
        code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
      });
      expect(await fixture.store.listResidentSessionBindings()).toEqual([replacement]);
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
      const successorInput = operationInput(fixture, `linked-${successor}`, "2");
      if (successor === "end") {
        await fixture.store.prepareResidentEnd(successorInput, active);
        const killLease = await fixture.store.beginResidentKill(successorInput);
        await fixture.store.acknowledgeResidentKill(killLease);
      } else {
        await fixture.store.detachResidentLifecycle(successorInput, active);
      }

      const restarted = new HostStore(fixture.directory);
      await restarted.initialize();
      expect(await restarted.listResidentSessionBindings()).toEqual([]);
      expect(await restarted.getResidentLifecycleStatus(provisionInput.operationId)).toMatchObject({
        phase: "committed",
      });
      expect(await restarted.getResidentLifecycleStatus(successorInput.operationId)).toMatchObject({
        phase: successor === "end" ? "completed" : "detached",
      });
    },
  );

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
      const successorInput = operationInput(fixture, `refresh-${successor}`, "5");
      if (successor === "end") {
        await reattached.prepareResidentEnd(successorInput, refreshed);
        const killLease = await reattached.beginResidentKill(successorInput);
        await reattached.acknowledgeResidentKill(killLease);
      } else {
        await reattached.detachResidentLifecycle(successorInput, refreshed);
      }

      const restarted = new HostStore(fixture.directory);
      await restarted.initialize();
      expect(await restarted.listResidentSessionBindings()).toEqual([]);
      expect(await restarted.getResidentLifecycleStatus(successorInput.operationId)).toMatchObject({
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
    const killInput = operationInput(killFixture, "definite-kill-failure", "b");
    await killFixture.store.prepareResidentEnd(killInput, active);
    const firstKillLease = await killFixture.store.beginResidentKill(killInput);
    expect(await killFixture.store.failResidentKillBeforeEffect(firstKillLease)).toMatchObject({ phase: "ending" });
    const secondKillLease = await killFixture.store.beginResidentKill(killInput);
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

  it.each([
    "after_ending",
    "after_binding_revoked",
    "after_kill_dispatching",
    "after_kill_acknowledged",
    "after_completed_binding",
    "after_completed",
  ] satisfies ResidentLifecycleFaultPoint[])("never replays an end mutation after %s", async (faultPoint) => {
    const fixture = await createFixture();
    const active = legacyBinding(fixture, faultPoint);
    await fixture.store.persistResidentSessionBinding(active);
    const input = operationInput(fixture, `end-${faultPoint}`, "4");
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
      await crashing.acknowledgeResidentKill(killLease);
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
    } else if (faultPoint === "after_ending" || faultPoint === "after_binding_revoked") {
      expect(status?.phase).toBe("ending");
    } else {
      expect(status?.phase).toBe("completed");
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

describe("HostStore resident lifecycle durable validation", () => {
  it("accepts legacy v1 active/completed records and rejects cross-kind quarantine corruption", async () => {
    const fixture = await createFixture();
    const active = legacyBinding(fixture);
    await fixture.store.persistResidentSessionBinding(active);
    await fixture.store.completeResidentSessionBinding(active);
    const legacyRestart = new HostStore(fixture.directory);
    await expect(legacyRestart.initialize()).resolves.toEqual({ seeded: false });

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
        const input = operationInput(fixture, "malformed-end", "9");
        await fixture.store.prepareResidentEnd(input, active);
        const killLease = await fixture.store.beginResidentKill(input);
        await fixture.store.acknowledgeResidentKill(killLease);
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
      await expect(restarted.initialize()).resolves.toEqual({ seeded: false });
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
        const input = operationInput(fixture, "missing-completed-binding", "e");
        await fixture.store.prepareResidentEnd(input, active);
        const killLease = await fixture.store.beginResidentKill(input);
        await fixture.store.acknowledgeResidentKill(killLease);
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
      await expect(restarted.initialize()).resolves.toEqual({ seeded: false });
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

async function createFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "prime-resident-lifecycle-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const workspaceDirectory = await realpath(workspace);
  const store = new HostStore(directory);
  await store.initialize({ seed: true });
  await store.registerWorkspaceAuthority({
    threadId: "demo-thread",
    executionGenerationId: "demo-execution-1",
    workspaceDirectory,
  });
  return { directory, workspaceDirectory, store, hostId: (await store.getHost()).hostId };
}

function operationInput(fixture: Fixture, operationId: string, digest = "a"): ResidentLifecycleOperationInput {
  return {
    operationId,
    expectedHostId: fixture.hostId,
    projectId: "demo-project",
    workspaceId: "demo-workspace",
    threadId: "demo-thread",
    executionGenerationId: "demo-execution-1",
    requestDigest: digest.repeat(64),
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
    threadId: "demo-thread",
    executionGenerationId: "demo-execution-1",
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
