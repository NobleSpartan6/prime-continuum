import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentAbortIdleAuthorityEvidence,
  type ResidentPromptIdleAuthorityEvidence,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import type { ResidentProjectionSnapshot } from "../../src/hostd/resident-projection";
import {
  HostStore,
  HostStoreError,
  type AdmissionFaultPoint,
  type ResidentDispatchFaultPoint,
  type ResidentDispatchLease,
  type ResidentAbortReconciliationLease,
  type ResidentProjectionFaultPoint,
  type ResidentPromptReconciliationLease,
} from "../../src/hostd/store";
import { PROTOCOL_VERSION, type CommandEnvelope, type ThreadProjectionSnapshot } from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];
const dispatchBoundaryFaultPoints = [
  "after_dispatch_attempt",
  "after_dispatch_receipt",
  "after_dispatch_journal",
] as const;
const residentProjectionFaultPoints: ResidentProjectionFaultPoint[] = [
  "after_prepare",
  "after_lineage",
  "after_snapshot",
  "after_threads",
  "after_prompt_locks",
];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HostStore resident prompt and abort dispatch journal", () => {
  it("admits a live prompt without speculative projection state and settles only through its exact immutable lease", async () => {
    const fixture = await createFixture();
    const command = residentCommand(fixture.hostId, "resident-prompt-success", "prompt");
    const before = await fixture.store.getThreadSnapshot(command.threadId);

    const admission = await fixture.store.admitCommand(command, true);
    expect(admission).toMatchObject({ duplicate: false, receipt: { status: "admitted" } });
    expect(admission.receipt.queuePosition).toBeUndefined();
    expect(await fixture.store.getThreadSnapshot(command.threadId)).toEqual(before);
    expect(await residentAttemptNames(fixture.store)).toHaveLength(1);

    const lease = await fixture.store.beginResidentDispatch(command);
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.isFrozen(lease.command)).toBe(true);
    expect(Object.isFrozen(lease.command.command)).toBe(true);
    expect(lease.binding).toEqual(fixture.binding);
    expect(lease.bindingFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await fixture.store.reconcileCommands([command])).receipts[0]).toMatchObject({ status: "admitted" });

    const settled = await fixture.store.finalizeResidentDispatch(lease, {
      status: "running",
      message: "Prime Agent accepted the prompt for this resident turn",
    });
    expect(settled).toMatchObject({ status: "running", queuePosition: undefined });
    expect(await residentAttemptNames(fixture.store)).toHaveLength(1);
    expect(await fixture.store.admitCommand(command, true)).toEqual({ receipt: settled, duplicate: true });
    await expectStoreError(fixture.store.beginResidentDispatch(command), "RESIDENT_DISPATCH_ALREADY_STARTED");
    expect(await commandStatuses(fixture.store, command.commandId)).toEqual([
      "received",
      "admitted",
      "admitted",
      "running",
    ]);
  });

  it("completes a handled no-event prompt from a same-cursor idle barrier and emits one dedicated event", async () => {
    const fixture = await createFixture();
    const stableIdle = projection(fixture.binding, "resident-handled-same-cursor", 1, false);
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, stableIdle);
    const command = residentCommand(fixture.hostId, "resident-handled-no-event", "prompt");
    await fixture.store.admitCommand(command, true);
    const dispatch = await fixture.store.beginResidentDispatch(command);
    await expect(
      fixture.store.finalizeResidentDispatch(dispatch, {
        status: "running",
        message: "Prime accepted the input extension handled acknowledgement",
      }),
    ).resolves.toMatchObject({ status: "running" });
    const reconciliation = await fixture.store.beginResidentPromptReconciliation(dispatch);

    const observation = await fixture.store.completeResidentPromptReconciliation(
      reconciliation,
      idleEvidence(reconciliation, stableIdle),
    );

    expect(observation).toMatchObject({
      attemptId: reconciliation.attemptId,
      command: { commandId: command.commandId },
      receipt: { commandId: command.commandId, status: "completed" },
      observedCursor: { generation: "resident-handled-same-cursor", sequence: 1 },
    });
    expect((await fixture.store.reconcileCommands([command])).receipts[0]).toEqual(observation.receipt);
    expect(await residentAttemptNames(fixture.store)).toEqual([]);
    expect(await residentIdleEvents(fixture.store)).toHaveLength(1);
    expect(await commandStatuses(fixture.store, command.commandId)).toEqual([
      "received",
      "admitted",
      "admitted",
      "running",
      "completed",
    ]);
  });

  it("excludes uncertain prompts from every idle reconciliation and cursor retirement path", async () => {
    const fixture = await createFixture();
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, "resident-timeout-before-late-idle", 1, false),
    );
    const command = residentCommand(fixture.hostId, "resident-timeout-owned-prompt", "prompt");
    await fixture.store.admitCommand(command, true);
    const dispatch = await fixture.store.beginResidentDispatch(command);
    await fixture.store.finalizeResidentDispatch(dispatch, {
      status: "uncertain",
      message: "Host acknowledgement timed out while the pinned prompt may still resolve owned",
      error: {
        code: "RESIDENT_PROMPT_ACK_TIMEOUT",
        message: "The upstream prompt outcome remains unknown",
        retryable: false,
      },
    });

    expect(await fixture.store.listResidentPromptReconciliationLeases()).toEqual([]);
    await expectStoreError(
      fixture.store.beginResidentPromptReconciliation(dispatch),
      "RESIDENT_PROMPT_RECONCILIATION_INELIGIBLE",
    );
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, "resident-timeout-before-late-idle", 2, false),
    );
    expect(await residentAttemptNames(fixture.store)).toHaveLength(1);
    const second = residentCommand(fixture.hostId, "resident-after-late-timeout-idle", "prompt");
    expect((await fixture.store.admitCommand(second, true)).receipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_PROMPT_ALREADY_OWNED" },
    });
  });

  it("refuses idle completion after either the exact binding or durable projection becomes active", async () => {
    const bindingFixture = await createFixture();
    const stableIdle = projection(bindingFixture.binding, "resident-binding-proof", 1, false);
    await bindingFixture.store.publishResidentProjectionSnapshot(bindingFixture.binding, stableIdle);
    const bindingCommand = residentCommand(bindingFixture.hostId, "resident-binding-proof", "prompt");
    await bindingFixture.store.admitCommand(bindingCommand, true);
    const bindingDispatch = await bindingFixture.store.beginResidentDispatch(bindingCommand);
    await bindingFixture.store.finalizeResidentDispatch(bindingDispatch, { status: "running" });
    const staleBindingLease = await bindingFixture.store.beginResidentPromptReconciliation(bindingDispatch);
    await bindingFixture.store.persistResidentSessionBinding({
      ...bindingFixture.binding,
      runtime: { ...bindingFixture.binding.runtime, supervisorGeneration: "post-proof-reconnect" },
    });
    await expectStoreError(
      bindingFixture.store.completeResidentPromptReconciliation(
        staleBindingLease,
        idleEvidence(staleBindingLease, stableIdle),
      ),
      "RESIDENT_PROMPT_RECONCILIATION_BINDING_CHANGED",
    );
    expect(await residentAttemptNames(bindingFixture.store)).toHaveLength(1);

    const activeFixture = await createFixture();
    const observedIdle = projection(activeFixture.binding, "resident-active-race", 1, false);
    await activeFixture.store.publishResidentProjectionSnapshot(activeFixture.binding, observedIdle);
    const activeCommand = residentCommand(activeFixture.hostId, "resident-active-race", "prompt");
    await activeFixture.store.admitCommand(activeCommand, true);
    const activeDispatch = await activeFixture.store.beginResidentDispatch(activeCommand);
    await activeFixture.store.finalizeResidentDispatch(activeDispatch, { status: "running" });
    const activeLease = await activeFixture.store.beginResidentPromptReconciliation(activeDispatch);
    await activeFixture.store.publishResidentProjectionSnapshot(
      activeFixture.binding,
      projection(activeFixture.binding, "resident-active-race", 2, true),
    );
    await expectStoreError(
      activeFixture.store.completeResidentPromptReconciliation(
        activeLease,
        idleEvidence(activeLease, observedIdle),
      ),
      "RESIDENT_PROMPT_IDLE_EVIDENCE_SUPERSEDED",
    );
    expect(await residentAttemptNames(activeFixture.store)).toHaveLength(1);
  });

  it("blocks binding and execution-authority transitions while an admitted or dispatching attempt is active", async () => {
    const fixture = await createFixture();
    const command = residentCommand(fixture.hostId, "resident-transition-fence", "prompt");
    await fixture.store.admitCommand(command, true);

    const refreshed = {
      ...fixture.binding,
      runtime: { ...fixture.binding.runtime, supervisorGeneration: "replacement-supervisor" },
    };
    await expect(fixture.store.persistResidentSessionBinding(refreshed)).resolves.toBeUndefined();
    await expectStoreError(
      fixture.store.completeResidentSessionBinding(refreshed),
      "RESIDENT_DISPATCH_ACTIVE",
    );
    const source = await fixture.store.getThreadSnapshot(command.threadId);
    const moved = snapshotWithGeneration(source, "replacement-generation");
    await expectStoreError(fixture.store.upsertThread(moved.thread, moved), "RESIDENT_DISPATCH_ACTIVE");

    const lease = await fixture.store.beginResidentDispatch(command);
    expect(lease.binding).toEqual(refreshed);
    await expectStoreError(
      fixture.store.completeResidentSessionBinding(refreshed),
      "RESIDENT_DISPATCH_ACTIVE",
    );
    await fixture.store.finalizeResidentDispatch(lease, { status: "running", message: "Prompt delivery acknowledged" });
    await expectStoreError(
      fixture.store.completeResidentSessionBinding(refreshed),
      "RESIDENT_DISPATCH_ACTIVE",
    );
    await fixture.store.publishResidentProjectionSnapshot(
      refreshed,
      projection(refreshed, "resident-generation-transition", 1, false),
    );
    expect(await residentAttemptNames(fixture.store)).toHaveLength(1);
    const reconciliation = await fixture.store.beginResidentPromptReconciliation(lease);
    await fixture.store.completeResidentPromptReconciliation(
      reconciliation,
      idleEvidence(
        reconciliation,
        projection(refreshed, "resident-generation-transition", 1, false),
      ),
    );
    expect(await residentAttemptNames(fixture.store)).toEqual([]);
    await expect(fixture.store.completeResidentSessionBinding(refreshed)).resolves.toBeUndefined();
  });

  it("rejects a second prompt during projection lag and does not let abort overtake prompt delivery", async () => {
    const fixture = await createFixture();
    const idleAbort = residentCommand(fixture.hostId, "resident-idle-abort", "abort");
    expect((await fixture.store.admitCommand(idleAbort, true)).receipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_SESSION_IDLE" },
    });

    const first = residentCommand(fixture.hostId, "resident-owned-prompt", "prompt");
    await fixture.store.admitCommand(first, true);
    const second = residentCommand(fixture.hostId, "resident-second-prompt", "prompt");
    expect((await fixture.store.admitCommand(second, true)).receipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_PROMPT_ALREADY_OWNED", retryable: true },
    });
    const ownedAbort = residentCommand(fixture.hostId, "resident-owned-abort", "abort");
    expect((await fixture.store.admitCommand(ownedAbort, true)).receipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_PROMPT_DELIVERY_PENDING", retryable: true },
    });

    const firstLease = await fixture.store.beginResidentDispatch(first);
    await fixture.store.finalizeResidentDispatch(firstLease, {
      status: "running",
      message: "The exact prompt crossed the resident dispatch boundary",
    });
    const acknowledgedAbort = residentCommand(fixture.hostId, "resident-acknowledged-abort", "abort");
    expect((await fixture.store.admitCommand(acknowledgedAbort, true)).receipt.status).toBe("admitted");
  });

  it("rejects prompt admission or begin when authoritative resident activity is already visible", async () => {
    const fixture = await createFixture();
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, "resident-busy-before-admission", 1, true),
    );
    const busy = residentCommand(fixture.hostId, "resident-busy-prompt", "prompt");
    expect((await fixture.store.admitCommand(busy, true)).receipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_SESSION_BUSY" },
    });

    const secondFixture = await createFixture();
    const admitted = residentCommand(secondFixture.hostId, "resident-became-busy", "prompt");
    expect((await secondFixture.store.admitCommand(admitted, true)).receipt.status).toBe("admitted");
    await secondFixture.store.publishResidentProjectionSnapshot(
      secondFixture.binding,
      projection(secondFixture.binding, "resident-busy-before-begin", 1, true),
    );
    await expectStoreError(secondFixture.store.beginResidentDispatch(admitted), "RESIDENT_SESSION_BUSY");
    await expect(
      secondFixture.store.failResidentDispatchBeforeStart(admitted, {
        code: "RESIDENT_SESSION_BUSY",
        message: "Resident activity became authoritative before dispatch",
        retryable: true,
      }),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("treats a queue-only authoritative turn as active for abort admission and prompt begin", async () => {
    const abortFixture = await createFixture();
    const queueActive = queueOnlyProjection(
      abortFixture.binding,
      "resident-queue-only-abort",
      1,
    );
    const published = await abortFixture.store.publishResidentProjectionSnapshot(
      abortFixture.binding,
      queueActive,
    );
    expect(published.thread.status).toBe("running");
    expect(published.runtime).toMatchObject({
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      queuedActionCount: 0,
    });
    const abort = residentCommand(abortFixture.hostId, "resident-queue-only-stop", "abort");
    expect((await abortFixture.store.admitCommand(abort, true)).receipt.status).toBe("admitted");
    const abortLease = await abortFixture.store.beginResidentDispatch(abort);
    await expect(
      abortFixture.store.finalizeResidentDispatch(abortLease, {
        status: "running",
        message: "Queue-only resident turn accepted the stop request",
      }),
    ).resolves.toMatchObject({ status: "running" });

    const promptFixture = await createFixture();
    const prompt = residentCommand(promptFixture.hostId, "resident-queue-only-race", "prompt");
    expect((await promptFixture.store.admitCommand(prompt, true)).receipt.status).toBe("admitted");
    await promptFixture.store.publishResidentProjectionSnapshot(
      promptFixture.binding,
      queueOnlyProjection(promptFixture.binding, "resident-queue-only-before-begin", 1),
    );
    await expectStoreError(promptFixture.store.beginResidentDispatch(prompt), "RESIDENT_SESSION_BUSY");
    await expect(
      promptFixture.store.failResidentDispatchBeforeStart(prompt, {
        code: "RESIDENT_SESSION_BUSY",
        message: "A queue-only authoritative turn became active before prompt dispatch",
        retryable: true,
      }),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("preserves abort dispatch authority across a verified supervisor refresh", async () => {
    const fixture = await createFixture();
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, "resident-active-before-abort", 1, true),
    );
    const command = residentCommand(fixture.hostId, "resident-abort-reconnect", "abort");
    expect((await fixture.store.admitCommand(command, true)).receipt.status).toBe("admitted");
    const refreshed: ResidentSessionBinding = {
      ...fixture.binding,
      runtime: {
        ...fixture.binding.runtime,
        capabilities: [...fixture.binding.runtime.capabilities].reverse(),
        supervisorGeneration: "abort-refresh-supervisor",
      },
    };
    await fixture.store.persistResidentSessionBinding(refreshed);
    const lease = await fixture.store.beginResidentDispatch(command);
    expect(lease.binding).toEqual(refreshed);
    await expect(
      fixture.store.finalizeResidentDispatch(lease, {
        status: "running",
        message: "Refreshed resident connection accepted the stop request",
      }),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("rewrites a lagging active same-cursor view only under the exact Stop idle proof", async () => {
    const fixture = await createFixture();
    const active = projection(fixture.binding, "resident-abort-same-cursor", 1, true);
    const idle = projection(fixture.binding, "resident-abort-same-cursor", 1, false);
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, active);
    const command = residentCommand(fixture.hostId, "resident-abort-same-cursor", "abort");
    await fixture.store.admitCommand(command, true);
    const dispatch = await fixture.store.beginResidentDispatch(command);
    const acknowledged = await fixture.store.finalizeResidentDispatch(dispatch, {
      status: "running",
      message: "Prime Agent accepted Stop; waiting for idle proof",
    });
    expect(acknowledged.status).toBe("running");
    expect((await fixture.store.getThreadSnapshot(command.threadId)).thread.status).toBe("running");
    expect(await fixture.store.listResidentAbortReconciliationLeases()).toHaveLength(1);

    await expectStoreError(
      fixture.store.publishResidentProjectionSnapshot(fixture.binding, idle),
      "RESIDENT_PROJECTION_CURSOR_CONFLICT",
    );
    const reconciliation = await fixture.store.beginResidentAbortReconciliation(dispatch);
    const published = await fixture.store.publishResidentProjectionSnapshot(
      reconciliation.binding,
      idle,
      reconciliation,
    );
    expect(published.thread.status).toBe("idle");
    expect(published.latestCursor).toMatchObject({
      generation: "resident-abort-same-cursor",
      sequence: 1,
    });

    // Projection publication alone never retires the Stop barrier. A newer
    // prompt cannot race between idle materialization and proof receipt/event.
    const interleavedPrompt = residentCommand(fixture.hostId, "resident-abort-proof-race", "prompt");
    expect((await fixture.store.admitCommand(interleavedPrompt, true)).receipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_ABORT_IDLE_PROOF_PENDING", retryable: true },
    });

    const observation = await fixture.store.completeResidentAbortReconciliation(
      reconciliation,
      abortIdleEvidence(reconciliation, idle),
    );
    expect(observation).toMatchObject({
      attemptId: reconciliation.attemptId,
      acknowledgedReceipt: { status: "running" },
      receipt: { commandId: command.commandId, status: "completed" },
    });
    expect((await fixture.store.reconcileCommands([command])).receipts[0]).toEqual(observation.receipt);
    expect(await residentAttemptNames(fixture.store)).toEqual([]);
    expect(await residentAbortIdleEvents(fixture.store)).toHaveLength(1);
    const next = residentCommand(fixture.hostId, "resident-after-abort-proof", "prompt");
    expect((await fixture.store.admitCommand(next, true)).receipt.status).toBe("admitted");
  });

  it("reissues a running Stop proof after restart and never treats acknowledgement as idle", async () => {
    const fixture = await createFixture();
    const active = projection(fixture.binding, "resident-abort-restart", 1, true);
    const idle = projection(fixture.binding, "resident-abort-restart", 1, false);
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, active);
    const command = residentCommand(fixture.hostId, "resident-abort-restart", "abort");
    await fixture.store.admitCommand(command, true);
    const dispatch = await fixture.store.beginResidentDispatch(command);
    await fixture.store.finalizeResidentDispatch(dispatch, { status: "running" });

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect((await restarted.reconcileCommands([command])).receipts[0]?.status).toBe("running");
    expect((await restarted.getThreadSnapshot(command.threadId)).thread.status).toBe("running");
    const [reconciliation] = await restarted.listResidentAbortReconciliationLeases();
    expect(reconciliation).toBeDefined();
    await expectStoreError(
      restarted.completeResidentSessionBinding(reconciliation!.binding),
      "RESIDENT_DISPATCH_ACTIVE",
    );
    await expectStoreError(
      restarted.persistResidentSessionBinding({
        ...reconciliation!.binding,
        activeSessionId: "blocked-replacement-active",
        sessionId: "blocked-replacement-session",
      }),
      "RESIDENT_DISPATCH_ACTIVE",
    );
    await restarted.publishResidentProjectionSnapshot(
      reconciliation!.binding,
      idle,
      reconciliation,
    );
    await restarted.completeResidentAbortReconciliation(
      reconciliation!,
      abortIdleEvidence(reconciliation!, idle),
    );
    expect((await restarted.reconcileCommands([command])).receipts[0]?.status).toBe("completed");
    expect(await restarted.listResidentAbortReconciliationLeases()).toEqual([]);
    expect(await residentAttemptNames(restarted)).toEqual([]);

    const replacement: ResidentSessionBinding = {
      ...fixture.binding,
      activeSessionId: "unsafe-replacement-active",
      sessionId: "unsafe-replacement-session",
    };
    // Once proof removes the exact lock, the normal binding identity fence—not
    // a stale process-local lease—governs replacement attempts.
    await expectStoreError(
      restarted.persistResidentSessionBinding(replacement),
      "RESIDENT_BINDING_CONFLICT",
    );
  });

  it("keeps a prompt lock across projections and retires it only through dedicated idle proof completion", async () => {
    const fixture = await createFixture();
    const command = residentCommand(fixture.hostId, "resident-idle-before-ack", "prompt");
    await fixture.store.admitCommand(command, true);
    const lease = await fixture.store.beginResidentDispatch(command);
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, "resident-idle-before-ack-generation", 1, false),
    );
    expect(await residentAttemptNames(fixture.store)).toHaveLength(1);
    await fixture.store.finalizeResidentDispatch(lease, {
      status: "running",
      message: "Prompt delivery was acknowledged after idle projection",
    });
    expect(await residentAttemptNames(fixture.store)).toHaveLength(1);
    const premature = residentCommand(fixture.hostId, "resident-before-post-ack-idle", "prompt");
    expect((await fixture.store.admitCommand(premature, true)).receipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_PROMPT_ALREADY_OWNED" },
    });

    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, "resident-idle-before-ack-generation", 2, false),
    );
    // Generic cursor publication cannot consume prompt ownership before the
    // dedicated same-connection barrier commits its receipt and audit event.
    expect(await residentAttemptNames(fixture.store)).toHaveLength(1);
    const reconciliation = await fixture.store.beginResidentPromptReconciliation(lease);
    await expect(
      fixture.store.completeResidentPromptReconciliation(
        reconciliation,
        idleEvidence(
          reconciliation,
          projection(fixture.binding, "resident-idle-before-ack-generation", 2, false),
        ),
      ),
    ).resolves.toMatchObject({ attemptId: reconciliation.attemptId, receipt: { status: "completed" } });
    expect(await residentAttemptNames(fixture.store)).toEqual([]);
    const next = residentCommand(fixture.hostId, "resident-after-post-ack-idle", "prompt");
    expect((await fixture.store.admitCommand(next, true)).receipt.status).toBe("admitted");
  });

  it("reschedules the exact acknowledged prompt proof after restart without generic cursor retirement", async () => {
    const fixture = await createFixture();
    const command = residentCommand(fixture.hostId, "resident-settlement-cursor-restart", "prompt");
    await fixture.store.admitCommand(command, true);
    const lease = await fixture.store.beginResidentDispatch(command);
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, "resident-settlement-restart-generation", 1, false),
    );
    await fixture.store.finalizeResidentDispatch(lease, {
      status: "running",
      message: "Prompt delivery acknowledged at the durable settlement cursor",
    });

    const recovered = new HostStore(fixture.directory);
    await recovered.initialize();
    expect(await residentAttemptNames(recovered)).toHaveLength(1);
    const premature = residentCommand(fixture.hostId, "resident-restart-before-later-idle", "prompt");
    expect((await recovered.admitCommand(premature, true)).receipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_PROMPT_ALREADY_OWNED" },
    });

    await recovered.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, "resident-settlement-restart-generation", 2, false),
    );
    expect(await residentAttemptNames(recovered)).toHaveLength(1);
    const [reconciliation] = await recovered.listResidentPromptReconciliationLeases();
    expect(reconciliation).toBeDefined();
    await recovered.completeResidentPromptReconciliation(
      reconciliation!,
      idleEvidence(
        reconciliation!,
        projection(fixture.binding, "resident-settlement-restart-generation", 2, false),
      ),
    );
    expect(await residentAttemptNames(recovered)).toEqual([]);
    const next = residentCommand(fixture.hostId, "resident-restart-after-later-idle", "prompt");
    expect((await recovered.admitCommand(next, true)).receipt.status).toBe("admitted");
  });

  it("rejects a replacement binding fingerprint at finalization", async () => {
    const fixture = await createFixture();
    const command = residentCommand(fixture.hostId, "resident-lease-fingerprint", "prompt");
    await fixture.store.admitCommand(command, true);
    const lease = await fixture.store.beginResidentDispatch(command);
    const reconstructed = JSON.parse(JSON.stringify(lease)) as ResidentDispatchLease;
    await expectStoreError(
      fixture.store.finalizeResidentDispatch(reconstructed, { status: "running" }),
      "RESIDENT_DISPATCH_LEASE_INVALID",
    );
    const forged = {
      ...lease,
      binding: {
        ...lease.binding,
        runtime: { ...lease.binding.runtime, supervisorGeneration: "forged-supervisor" },
      },
    } as ResidentDispatchLease;

    await expectStoreError(
      fixture.store.finalizeResidentDispatch(forged, { status: "running" }),
      "RESIDENT_DISPATCH_LEASE_INVALID",
    );
    await expect(
      fixture.store.finalizeResidentDispatch(lease, { status: "running", message: "Exact lease accepted" }),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("creates no resident attempt for steer, follow-up, approval, or model-selection admission", async () => {
    const fixture = await createFixture();
    const commands: CommandEnvelope[] = [
      {
        ...residentCommand(fixture.hostId, "resident-no-steer", "prompt"),
        command: { kind: "steer", text: "Do not generalize the resident lease." },
      },
      {
        ...residentCommand(fixture.hostId, "resident-no-follow-up", "prompt"),
        command: { kind: "follow_up", text: "Do not generalize the resident lease." },
      },
      {
        ...residentCommand(fixture.hostId, "resident-no-approval", "prompt"),
        command: { kind: "approval.resolve", approvalId: "approval-missing", decision: "reject" },
      },
    ];
    for (const command of commands) await fixture.store.admitCommand(command, false);
    expect(await residentAttemptNames(fixture.store)).toEqual([]);
    await expect(fixture.store.beginResidentDispatch(commands[1]!)).rejects.toThrow();
  });
});

describe("HostStore resident dispatch crash recovery", () => {
  it.each([
    "after_prompt_idle_attempt",
    "after_prompt_idle_receipt",
    "after_prompt_idle_journal",
    "after_prompt_idle_event",
  ] as const)("recovers one proof-completed prompt and event after a crash at %s", async (faultPoint) => {
    const fixture = await createFixture();
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentDispatchFaultInjector(point: ResidentDispatchFaultPoint) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated prompt idle crash at ${faultPoint}`);
        }
      },
    });
    await crashing.initialize();
    const stableIdle = projection(fixture.binding, `resident-proof-crash-${faultPoint}`, 1, false);
    await crashing.publishResidentProjectionSnapshot(fixture.binding, stableIdle);
    const command = residentCommand(fixture.hostId, `resident-proof-crash-${faultPoint}`, "prompt");
    await crashing.admitCommand(command, true);
    const dispatch = await crashing.beginResidentDispatch(command);
    await crashing.finalizeResidentDispatch(dispatch, { status: "running" });
    const reconciliation = await crashing.beginResidentPromptReconciliation(dispatch);

    await expect(
      crashing.completeResidentPromptReconciliation(
        reconciliation,
        idleEvidence(reconciliation, stableIdle),
      ),
    ).rejects.toThrow(`simulated prompt idle crash at ${faultPoint}`);

    const recovered = new HostStore(fixture.directory);
    await recovered.initialize();
    expect((await recovered.reconcileCommands([command])).receipts[0]).toMatchObject({
      commandId: command.commandId,
      status: "completed",
    });
    expect(await residentAttemptNames(recovered)).toEqual([]);
    expect(await recovered.listResidentPromptReconciliationLeases()).toEqual([]);
    expect(await residentIdleEvents(recovered)).toHaveLength(1);
    expect((await commandStatuses(recovered, command.commandId)).filter((status) => status === "completed"))
      .toHaveLength(1);
  });

  it.each([
    ...residentProjectionFaultPoints,
  ])("recovers a same-cursor Stop idle projection crash at %s without completing the Stop", async (faultPoint) => {
    const fixture = await createFixture();
    const generation = `resident-abort-projection-crash-${faultPoint}`;
    const active = projection(fixture.binding, generation, 1, true);
    const idle = projection(fixture.binding, generation, 1, false);
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, active);
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentProjectionFaultInjector(point: ResidentProjectionFaultPoint) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated Stop projection crash at ${point}`);
        }
      },
    });
    await crashing.initialize();
    const command = residentCommand(fixture.hostId, `resident-abort-projection-crash-${faultPoint}`, "abort");
    await crashing.admitCommand(command, true);
    const dispatch = await crashing.beginResidentDispatch(command);
    await crashing.finalizeResidentDispatch(dispatch, { status: "running" });
    const reconciliation = await crashing.beginResidentAbortReconciliation(dispatch);

    await expect(
      crashing.publishResidentProjectionSnapshot(reconciliation.binding, idle, reconciliation),
    ).rejects.toThrow(`simulated Stop projection crash at ${faultPoint}`);

    const recovered = new HostStore(fixture.directory);
    await recovered.initialize();
    expect(await recovered.getThreadSnapshot(command.threadId)).toMatchObject({
      thread: { status: "idle" },
      latestCursor: { generation, sequence: 1 },
    });
    expect((await recovered.reconcileCommands([command])).receipts[0]).toMatchObject({ status: "running" });
    expect(await residentAbortIdleEvents(recovered)).toEqual([]);
    const [recoveredLease] = await recovered.listResidentAbortReconciliationLeases();
    expect(recoveredLease).toMatchObject({ attemptId: reconciliation.attemptId });
    if (!recoveredLease) throw new Error("Recovered Stop proof lease missing");

    await expect(recovered.completeResidentAbortReconciliation(
      recoveredLease,
      abortIdleEvidence(recoveredLease, idle),
    )).resolves.toMatchObject({ receipt: { status: "completed" } });
    expect(await residentAbortIdleEvents(recovered)).toHaveLength(1);
    expect(await readdir(recovered.paths.residentProjectionTransactions)).toEqual([]);

    const secondRestart = new HostStore(fixture.directory);
    await secondRestart.initialize();
    expect((await secondRestart.reconcileCommands([command])).receipts[0]?.status).toBe("completed");
    expect(await residentAbortIdleEvents(secondRestart)).toHaveLength(1);
  });

  it("fails closed when a pending same-cursor Stop projection transaction loses its proof identity", async () => {
    const fixture = await createFixture();
    const generation = "resident-abort-projection-corrupt-proof-id";
    const active = projection(fixture.binding, generation, 1, true);
    const idle = projection(fixture.binding, generation, 1, false);
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, active);
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentProjectionFaultInjector(point) {
        if (!injected && point === "after_prepare") {
          injected = true;
          throw new Error("simulated Stop projection intent crash");
        }
      },
    });
    await crashing.initialize();
    const command = residentCommand(fixture.hostId, "resident-abort-projection-corrupt-proof-id", "abort");
    await crashing.admitCommand(command, true);
    const dispatch = await crashing.beginResidentDispatch(command);
    await crashing.finalizeResidentDispatch(dispatch, { status: "running" });
    const reconciliation = await crashing.beginResidentAbortReconciliation(dispatch);
    await expect(
      crashing.publishResidentProjectionSnapshot(reconciliation.binding, idle, reconciliation),
    ).rejects.toThrow("simulated Stop projection intent crash");
    const [transactionName] = await readdir(crashing.paths.residentProjectionTransactions);
    if (!transactionName) throw new Error("Pending Stop projection transaction missing");
    const transactionPath = join(crashing.paths.residentProjectionTransactions, transactionName);
    const transaction = JSON.parse(await readFile(transactionPath, "utf8")) as Record<string, unknown>;
    const transactionId = String(transaction.transactionId);
    transaction.transactionId = `${transactionId.slice(0, -1)}${transactionId.endsWith("0") ? "1" : "0"}`;
    await writeFile(transactionPath, `${JSON.stringify(transaction)}\n`, "utf8");

    await expect(new HostStore(fixture.directory).initialize()).rejects.toBeDefined();
    expect(await readdir(crashing.paths.residentProjectionTransactions)).toEqual([transactionName]);
  });

  it.each([
    "after_abort_idle_attempt",
    "after_abort_idle_receipt",
    "after_abort_idle_journal",
    "after_abort_idle_event",
  ] as const)("recovers one proof-completed Stop and event after a crash at %s", async (faultPoint) => {
    const fixture = await createFixture();
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentDispatchFaultInjector(point: ResidentDispatchFaultPoint) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated Stop idle crash at ${faultPoint}`);
        }
      },
    });
    await crashing.initialize();
    const active = projection(fixture.binding, `resident-abort-proof-crash-${faultPoint}`, 1, true);
    const idle = projection(fixture.binding, `resident-abort-proof-crash-${faultPoint}`, 1, false);
    await crashing.publishResidentProjectionSnapshot(fixture.binding, active);
    const command = residentCommand(fixture.hostId, `resident-abort-proof-crash-${faultPoint}`, "abort");
    await crashing.admitCommand(command, true);
    const dispatch = await crashing.beginResidentDispatch(command);
    await crashing.finalizeResidentDispatch(dispatch, { status: "running" });
    const reconciliation = await crashing.beginResidentAbortReconciliation(dispatch);
    await crashing.publishResidentProjectionSnapshot(reconciliation.binding, idle, reconciliation);

    await expect(crashing.completeResidentAbortReconciliation(
      reconciliation,
      abortIdleEvidence(reconciliation, idle),
    )).rejects.toThrow(`simulated Stop idle crash at ${faultPoint}`);

    const recovered = new HostStore(fixture.directory);
    await recovered.initialize();
    expect((await recovered.reconcileCommands([command])).receipts[0]).toMatchObject({
      commandId: command.commandId,
      status: "completed",
    });
    expect(await residentAttemptNames(recovered)).toEqual([]);
    expect(await recovered.listResidentAbortReconciliationLeases()).toEqual([]);
    expect(await residentAbortIdleEvents(recovered)).toHaveLength(1);
    expect((await commandStatuses(recovered, command.commandId)).filter((status) => status === "completed"))
      .toHaveLength(1);
  });

  it("fails closed on a mutated running prompt receipt before proof recovery", async () => {
    const fixture = await createFixture();
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentDispatchFaultInjector(point: ResidentDispatchFaultPoint) {
        if (!injected && point === "after_prompt_idle_attempt") {
          injected = true;
          throw new Error("simulated prompt proof intent crash");
        }
      },
    });
    await crashing.initialize();
    const idle = projection(fixture.binding, "resident-corrupt-prompt-predecessor", 1, false);
    await crashing.publishResidentProjectionSnapshot(fixture.binding, idle);
    const command = residentCommand(fixture.hostId, "resident-corrupt-prompt-predecessor", "prompt");
    await crashing.admitCommand(command, true);
    const dispatch = await crashing.beginResidentDispatch(command);
    await crashing.finalizeResidentDispatch(dispatch, { status: "running", message: "Exact prompt ack" });
    const reconciliation = await crashing.beginResidentPromptReconciliation(dispatch);
    await expect(crashing.completeResidentPromptReconciliation(
      reconciliation,
      idleEvidence(reconciliation, idle),
    )).rejects.toThrow("simulated prompt proof intent crash");
    await mutateReceipt(crashing, command.commandId, (receipt) => ({
      ...receipt,
      message: "tampered predecessor",
    }));

    await expect(new HostStore(fixture.directory).initialize()).rejects.toMatchObject({
      code: "RESIDENT_DISPATCH_ATTEMPT_INVALID",
    });
  });

  it("fails closed on a mutated running Stop receipt before proof recovery", async () => {
    const fixture = await createFixture();
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentDispatchFaultInjector(point: ResidentDispatchFaultPoint) {
        if (!injected && point === "after_abort_idle_attempt") {
          injected = true;
          throw new Error("simulated Stop proof intent crash");
        }
      },
    });
    await crashing.initialize();
    const active = projection(fixture.binding, "resident-corrupt-abort-predecessor", 1, true);
    const idle = projection(fixture.binding, "resident-corrupt-abort-predecessor", 1, false);
    await crashing.publishResidentProjectionSnapshot(fixture.binding, active);
    const command = residentCommand(fixture.hostId, "resident-corrupt-abort-predecessor", "abort");
    await crashing.admitCommand(command, true);
    const dispatch = await crashing.beginResidentDispatch(command);
    await crashing.finalizeResidentDispatch(dispatch, { status: "running", message: "Exact Stop ack" });
    const reconciliation = await crashing.beginResidentAbortReconciliation(dispatch);
    await crashing.publishResidentProjectionSnapshot(reconciliation.binding, idle, reconciliation);
    await expect(crashing.completeResidentAbortReconciliation(
      reconciliation,
      abortIdleEvidence(reconciliation, idle),
    )).rejects.toThrow("simulated Stop proof intent crash");
    await mutateReceipt(crashing, command.commandId, (receipt) => ({
      ...receipt,
      message: "tampered predecessor",
    }));

    await expect(new HostStore(fixture.directory).initialize()).rejects.toMatchObject({
      code: "RESIDENT_DISPATCH_ATTEMPT_INVALID",
    });
  });

  it("proves an admission crash before dispatch as terminal not-started and never replays it", async () => {
    const fixture = await createFixture();
    const command = residentCommand(fixture.hostId, "resident-admission-crash", "prompt");
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      admissionFaultInjector(point: AdmissionFaultPoint) {
        if (!injected && point === "after_resident_dispatch_attempt") {
          injected = true;
          throw new Error("simulated crash after resident attempt admission");
        }
      },
    });
    await crashing.initialize();

    await expect(crashing.admitCommand(command, true)).rejects.toThrow(
      "simulated crash after resident attempt admission",
    );
    expect(await residentAttemptNames(crashing)).toHaveLength(1);

    const recovered = new HostStore(fixture.directory);
    await recovered.initialize();
    const receipt = (await recovered.reconcileCommands([command])).receipts[0];
    expect(receipt).toMatchObject({
      status: "failed",
      error: { code: "RESIDENT_DISPATCH_NOT_STARTED", retryable: false },
    });
    expect(await residentAttemptNames(recovered)).toEqual([]);
    expect(await recovered.admitCommand(command, true)).toEqual({ receipt, duplicate: true });
    await expectStoreError(recovered.beginResidentDispatch(command), "RESIDENT_DISPATCH_ATTEMPT_MISSING");
    expect(await commandStatuses(recovered, command.commandId)).toEqual(["received", "admitted", "failed"]);
  });

  it.each([
    "after_settled_attempt",
    "after_settled_receipt",
    "after_settled_journal",
  ] as const)("repairs a definitive pre-dispatch failure after a crash at %s", async (faultPoint) => {
    const fixture = await createFixture();
    const command = residentCommand(fixture.hostId, `resident-prestart-${faultPoint}`, "prompt");
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentDispatchFaultInjector(point: ResidentDispatchFaultPoint) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated prestart crash at ${faultPoint}`);
        }
      },
    });
    await crashing.initialize();
    await crashing.admitCommand(command, true);
    await expect(
      crashing.failResidentDispatchBeforeStart(command, {
        code: "RESIDENT_BINDING_CONFLICT",
        message: "Resident authority changed before dispatch",
        retryable: true,
      }),
    ).rejects.toThrow(`simulated prestart crash at ${faultPoint}`);

    const recovered = new HostStore(fixture.directory);
    await recovered.initialize();
    expect((await recovered.reconcileCommands([command])).receipts[0]).toMatchObject({
      status: "failed",
      error: { code: "RESIDENT_BINDING_CONFLICT" },
    });
    expect(await residentAttemptNames(recovered)).toEqual([]);
    expect(await commandStatuses(recovered, command.commandId)).toEqual(["received", "admitted", "failed"]);
  });

  it.each(dispatchBoundaryFaultPoints)("turns a crash at %s into terminal uncertain without replay", async (faultPoint) => {
    const fixture = await createFixture();
    const command = residentCommand(fixture.hostId, `resident-${faultPoint}`, "prompt");
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentDispatchFaultInjector(point: ResidentDispatchFaultPoint) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated crash at ${faultPoint}`);
        }
      },
    });
    await crashing.initialize();
    await crashing.admitCommand(command, true);

    await expect(crashing.beginResidentDispatch(command)).rejects.toThrow(`simulated crash at ${faultPoint}`);
    const recovered = new HostStore(fixture.directory);
    await recovered.initialize();
    const receipt = (await recovered.reconcileCommands([command])).receipts[0];
    expect(receipt).toMatchObject({
      status: "uncertain",
      error: {
        code: "RESIDENT_DISPATCH_RESTART_UNCERTAIN",
        retryable: false,
        diagnosticId: expect.any(String),
        details: { operation: "prompt", replayed: false },
      },
    });
    expect(await residentAttemptNames(recovered)).toHaveLength(1);
    expect(await recovered.admitCommand(command, true)).toEqual({ receipt, duplicate: true });
    await expectStoreError(recovered.beginResidentDispatch(command), "RESIDENT_DISPATCH_ALREADY_STARTED");
    const blocked = residentCommand(fixture.hostId, `resident-blocked-${faultPoint}`, "prompt");
    expect((await recovered.admitCommand(blocked, true)).receipt).toMatchObject({
      status: "rejected",
      error: { code: "RESIDENT_PROMPT_ALREADY_OWNED" },
    });
  });

  it.each(dispatchBoundaryFaultPoints)(
    "retains an abort boundary crash at %s as a durable uncertain no-replay barrier",
    async (faultPoint) => {
      const fixture = await createFixture();
      const activeGeneration = `resident-active-abort-${faultPoint}`;
      const command = residentCommand(fixture.hostId, `resident-abort-${faultPoint}`, "abort");
      let injected = false;
      const crashing = new HostStore(fixture.directory, {
        residentDispatchFaultInjector(point: ResidentDispatchFaultPoint) {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`simulated abort crash at ${faultPoint}`);
          }
        },
      });
      await crashing.initialize();
      await crashing.publishResidentProjectionSnapshot(
        fixture.binding,
        projection(fixture.binding, activeGeneration, 1, true),
      );
      expect((await crashing.admitCommand(command, true)).receipt.status).toBe("admitted");

      await expect(crashing.beginResidentDispatch(command)).rejects.toThrow(
        `simulated abort crash at ${faultPoint}`,
      );

      const recovered = new HostStore(fixture.directory);
      await recovered.initialize();
      const receipt = (await recovered.reconcileCommands([command])).receipts[0];
      expect(receipt).toMatchObject({
        status: "uncertain",
        error: {
          code: "RESIDENT_DISPATCH_RESTART_UNCERTAIN",
          retryable: false,
          diagnosticId: expect.any(String),
          details: { operation: "abort", replayed: false },
        },
      });
      expect(await residentAttemptNames(recovered)).toHaveLength(1);
      expect(await recovered.listResidentAbortReconciliationLeases()).toEqual([]);

      // The exact retry is a durable duplicate and cannot mint another
      // process-local lease, which keeps the gateway replay count at zero.
      expect(await recovered.admitCommand(command, true)).toEqual({ receipt, duplicate: true });
      await expectStoreError(recovered.beginResidentDispatch(command), "RESIDENT_DISPATCH_ALREADY_STARTED");
      expect(await residentAttemptNames(recovered)).toHaveLength(1);

      // The upstream abort may still take effect after its transport timeout.
      // No later prompt, Stop, or binding transition can race that side effect.
      const freshStop = residentCommand(
        fixture.hostId,
        `resident-fresh-abort-${faultPoint}`,
        "abort",
      );
      expect((await recovered.admitCommand(freshStop, true)).receipt).toMatchObject({
        status: "rejected",
        error: { code: "RESIDENT_ABORT_OUTCOME_UNCERTAIN", retryable: false },
      });
      const blockedPrompt = residentCommand(
        fixture.hostId,
        `resident-prompt-blocked-after-abort-${faultPoint}`,
        "prompt",
      );
      expect((await recovered.admitCommand(blockedPrompt, true)).receipt).toMatchObject({
        status: "rejected",
        error: { code: "RESIDENT_ABORT_OUTCOME_UNCERTAIN", retryable: false },
      });
      await expectStoreError(
        recovered.completeResidentSessionBinding(fixture.binding),
        "RESIDENT_DISPATCH_ACTIVE",
      );
    },
  );

  it.each([
    "after_settled_attempt",
    "after_settled_receipt",
    "after_settled_journal",
  ] as const)("repairs the running Stop acknowledgement after a crash at %s without inferring idle", async (faultPoint) => {
    const fixture = await createFixture();
    const command = residentCommand(fixture.hostId, `resident-${faultPoint}`, "abort");
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentDispatchFaultInjector(point: ResidentDispatchFaultPoint) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated crash at ${faultPoint}`);
        }
      },
    });
    await crashing.initialize();
    await crashing.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, `active-generation-${faultPoint}`, 1, true),
    );
    await crashing.admitCommand(command, true);
    const lease = await crashing.beginResidentDispatch(command);

    await expect(
      crashing.finalizeResidentDispatch(lease, {
        status: "running",
        message: "Prime Agent accepted the stop request",
      }),
    ).rejects.toThrow(`simulated crash at ${faultPoint}`);

    const recovered = new HostStore(fixture.directory);
    await recovered.initialize();
    const receipt = (await recovered.reconcileCommands([command])).receipts[0];
    expect(receipt).toMatchObject({
      status: "running",
      message: "Prime Agent accepted the stop request",
    });
    expect(await residentAttemptNames(recovered)).toHaveLength(1);
    expect(await recovered.listResidentAbortReconciliationLeases()).toHaveLength(1);
    expect(await commandStatuses(recovered, command.commandId)).toEqual([
      "received",
      "admitted",
      "admitted",
      "running",
    ]);
  });
});

async function createFixture(): Promise<{
  directory: string;
  store: HostStore;
  hostId: string;
  binding: ResidentSessionBinding;
}> {
  const directory = await mkdtemp(join(tmpdir(), "prime-resident-dispatch-"));
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
  const residentBinding = binding(workspaceDirectory);
  await store.persistResidentSessionBinding(residentBinding);
  return { directory, store, hostId: (await store.getHost()).hostId, binding: residentBinding };
}

function binding(workspaceDirectory: string): ResidentSessionBinding {
  return {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId: "demo-thread",
    executionGenerationId: "demo-execution-1",
    workspaceDirectory,
    activeSessionId: "active-session-dispatch-1",
    sessionId: "session-dispatch-1",
    sessionFile: join(workspaceDirectory, ".prime-agent", "session-dispatch-1.jsonl"),
    boundAt: "2026-08-07T20:00:00.000Z",
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
}

function residentCommand(
  expectedHostId: string,
  commandId: string,
  kind: "prompt" | "abort",
): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "resident-device-1",
    commandId,
    expectedHostId,
    threadId: "demo-thread",
    issuedAt: "2026-08-07T20:01:00.000Z",
    expectedExecutionGenerationId: "demo-execution-1",
    command: kind === "prompt"
      ? { kind, text: "Inspect the current workspace through the resident session." }
      : { kind, reason: "Stop the current resident turn." },
  };
}

function snapshotWithGeneration(
  source: ThreadProjectionSnapshot,
  executionGenerationId: string,
): ThreadProjectionSnapshot {
  const currentLocation = { ...source.thread.currentLocation, executionGenerationId };
  const latestCursor = { ...source.latestCursor, executionGenerationId };
  return {
    ...source,
    thread: { ...source.thread, currentLocation, lastKnownCursor: latestCursor },
    latestCursor,
  };
}

function projection(
  residentBinding: ResidentSessionBinding,
  generation: string,
  sequence: number,
  active: boolean,
): ResidentProjectionSnapshot {
  return {
    projectionVersion: 1,
    identity: {
      activeSessionId: residentBinding.activeSessionId,
      sessionId: residentBinding.sessionId,
      sessionFile: residentBinding.sessionFile,
      workspaceDirectory: residentBinding.workspaceDirectory,
    },
    cursor: { generation, sequence },
    runtime: {
      runtime: "prime_agent",
      residency: "resident",
      appVersion: residentBinding.runtime.appVersion,
      activeSessionId: residentBinding.activeSessionId,
      sessionId: residentBinding.sessionId,
      isStreaming: active,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      steeringMode: "all",
      followUpMode: "all",
      messageCount: 1,
      compactionCount: 0,
      queuedActionCount: active ? 1 : 0,
      activeToolNames: [],
      recap: active ? "Resident turn is active." : "Resident session is idle.",
    },
    transcript: [],
    childAgents: [],
    queue: active
      ? {
          queuedCount: 0,
          steeringCount: 0,
          followUpCount: 0,
          active: { kind: "turn", phase: "running", label: "Resident turn" },
        }
      : { queuedCount: 0, steeringCount: 0, followUpCount: 0 },
  };
}

function queueOnlyProjection(
  residentBinding: ResidentSessionBinding,
  generation: string,
  sequence: number,
): ResidentProjectionSnapshot {
  const idle = projection(residentBinding, generation, sequence, false);
  return {
    ...idle,
    queue: {
      ...idle.queue,
      active: { kind: "turn", phase: "running", label: "Resident turn" },
    },
  };
}

function idleEvidence(
  lease: ResidentPromptReconciliationLease,
  residentProjection: ResidentProjectionSnapshot,
): ResidentPromptIdleAuthorityEvidence {
  return Object.freeze({
    evidenceVersion: 1 as const,
    dispatchAttemptId: lease.attemptId,
    binding: lease.binding,
    projection: residentProjection,
  });
}

function abortIdleEvidence(
  lease: ResidentAbortReconciliationLease,
  residentProjection: ResidentProjectionSnapshot,
): ResidentAbortIdleAuthorityEvidence {
  return Object.freeze({
    evidenceVersion: 1 as const,
    dispatchAttemptId: lease.attemptId,
    binding: lease.binding,
    projection: residentProjection,
  });
}

async function expectStoreError(operation: Promise<unknown>, code: string): Promise<HostStoreError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(HostStoreError);
    expect(error).toMatchObject({ code });
    return error as HostStoreError;
  }
  throw new Error(`Expected HostStoreError ${code}`);
}

async function residentAttemptNames(store: HostStore): Promise<string[]> {
  return (await readdir(store.paths.residentDispatchAttempts))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

async function commandStatuses(store: HostStore, commandId: string): Promise<string[]> {
  const body = await readFile(store.paths.commandJournal, "utf8");
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { commandId: string; status: string })
    .filter((record) => record.commandId === commandId)
    .map((record) => record.status);
}

async function residentIdleEvents(store: HostStore): Promise<unknown[]> {
  const body = await readFile(store.paths.eventJournal, "utf8");
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string })
    .filter((record) => record.type === "resident.prompt_idle_observed");
}

async function residentAbortIdleEvents(store: HostStore): Promise<unknown[]> {
  const body = await readFile(store.paths.eventJournal, "utf8");
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string })
    .filter((record) => record.type === "resident.abort_idle_observed");
}

async function mutateReceipt(
  store: HostStore,
  commandId: string,
  mutate: (receipt: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  for (const name of await readdir(store.paths.receipts)) {
    if (!name.endsWith(".json")) continue;
    const path = join(store.paths.receipts, name);
    const receipt = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (receipt.commandId !== commandId) continue;
    await writeFile(path, `${JSON.stringify(mutate(receipt))}\n`, "utf8");
    return;
  }
  throw new Error(`Missing receipt ${commandId}`);
}
