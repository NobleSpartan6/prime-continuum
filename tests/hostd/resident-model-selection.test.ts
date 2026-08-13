import { bootstrapTestWorkspace } from "./test-workspace-fixture";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayDispatchContext, PrimeAgentGateway } from "../../src/hostd/gateway";
import { GatewayError } from "../../src/hostd/gateway";
import { atomicWriteJson } from "../../src/hostd/atomic-files";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import {
  HostStore,
  HostStoreError,
  type ResidentEndLifecycleOperationInput,
  type ResidentProjectionFaultPoint,
} from "../../src/hostd/store";
import type { ResidentProjectionSnapshot } from "../../src/hostd/resident-projection";
import { PROTOCOL_VERSION, type CommandEnvelope } from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

const forbiddenSameCursorDeltas: ReadonlyArray<{
  name: string;
  mutate: (projection: ResidentProjectionSnapshot) => ResidentProjectionSnapshot;
}> = [
  {
    name: "runtime identity",
    mutate: (projection) => ({
      ...projection,
      runtime: { ...projection.runtime, activeSessionId: "different-active-session" },
    }),
  },
  {
    name: "runtime activity",
    mutate: (projection) => ({
      ...projection,
      runtime: { ...projection.runtime, isStreaming: true },
    }),
  },
  {
    name: "runtime count",
    mutate: (projection) => ({
      ...projection,
      runtime: { ...projection.runtime, messageCount: projection.runtime.messageCount + 1 },
    }),
  },
  {
    name: "context used tokens",
    mutate: (projection) => ({
      ...projection,
      runtime: {
        ...projection.runtime,
        context: {
          usedTokens: (projection.runtime.context?.usedTokens ?? 0) + 1,
          maxTokens: projection.runtime.context?.maxTokens ?? 8_192,
        },
      },
    }),
  },
  {
    name: "transcript",
    mutate: (projection) => ({
      ...projection,
      transcript: [{
        blockId: "unexpected-transcript-block",
        kind: "assistant",
        text: "Unexpected same-cursor transcript content",
        createdAt: "2026-08-07T18:01:30.000Z",
        sequence: 0,
      }],
    }),
  },
  {
    name: "stream",
    mutate: (projection) => ({
      ...projection,
      stream: {
        blockId: "unexpected-stream-block",
        text: "Unexpected same-cursor stream content",
        startedAt: "2026-08-07T18:01:30.000Z",
      },
    }),
  },
  {
    name: "child agents",
    mutate: (projection) => ({
      ...projection,
      childAgents: [{
        agentId: "unexpected-child-agent",
        title: "Unexpected child",
        state: "running",
      }],
    }),
  },
  {
    name: "goal",
    mutate: (projection) => ({
      ...projection,
      goal: {
        goalId: "unexpected-goal",
        objective: "Unexpected same-cursor goal",
        state: "active",
      },
    }),
  },
];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HostStore resident model-selection journal", () => {
  it("admits against one exact binding and persists the dispatch boundary before running", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-journal-success");
    const baseline = modelProjection(fixture.binding, "legacy-provider", "legacy-model");
    const selected = modelProjection(fixture.binding, "openai", "gpt-5", {
      thinkingLevel: "high",
      availableThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
      serviceTier: "priority",
      maxTokens: 32_768,
    });
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, baseline);
    const before = await fixture.store.getThreadSnapshot(command.threadId);

    const admission = await fixture.store.admitCommand(command, true);
    expect(admission).toMatchObject({ duplicate: false, receipt: { status: "admitted" } });
    expect(admission.receipt.queuePosition).toBeUndefined();
    expect(await fixture.store.getThreadSnapshot(command.threadId)).toEqual(before);
    expect(await modelAttemptNames(fixture.store)).toHaveLength(1);

    await expect(fixture.store.beginModelSelectionDispatch(command)).resolves.toEqual(fixture.binding);
    expect((await fixture.store.reconcileCommands([command])).receipts[0]).toMatchObject({ status: "running" });
    await expectStoreError(
      fixture.store.publishResidentProjectionSnapshot(fixture.binding, selected),
      "RESIDENT_PROJECTION_CURSOR_CONFLICT",
    );
    await expect(
      fixture.store.publishResidentModelSelectionProjection(command, fixture.binding, selected),
    ).resolves.toMatchObject({
      runtime: {
        model: "openai/gpt-5",
        thinkingLevel: "high",
        availableThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
        serviceTier: "priority",
        context: { usedTokens: 0, maxTokens: 32_768 },
      },
    });
    const completed = await fixture.store.finalizeModelSelectionDispatch(command, {
      status: "completed",
      message: "Authoritative model projection saved",
    });
    expect(completed).toMatchObject({ status: "completed" });
    expect(completed.error).toBeUndefined();
    expect(await modelAttemptNames(fixture.store)).toEqual([]);

    const duplicate = await fixture.store.admitCommand(command, true);
    expect(duplicate).toEqual({ receipt: completed, duplicate: true });
    await expectStoreError(
      fixture.store.beginModelSelectionDispatch(command),
      "MODEL_SELECTION_ATTEMPT_MISSING",
    );
    expect(await commandStatuses(fixture.store, command.commandId)).toEqual([
      "received",
      "admitted",
      "running",
      "completed",
    ]);

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    const reused = {
      ...command,
      command: { kind: "model.select" as const, providerId: "anthropic", modelId: "claude-opus-4" },
    };
    await expectStoreError(restarted.admitCommand(reused, true), "COMMAND_ID_REUSED");
    expect((await restarted.reconcileCommands([command])).receipts[0]).toEqual(completed);
  });

  it("rejects a flattened model-label collision unless the private provider/model pair is exact", async () => {
    const fixture = await createFixture();
    const command: CommandEnvelope = {
      ...modelSelectionCommand(fixture.hostId, "model-structured-identity"),
      command: {
        kind: "model.select",
        providerId: "openrouter",
        modelId: "anthropic/claude",
      },
    };
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
    );
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);

    const collision = modelProjection(fixture.binding, "openrouter/anthropic", "claude");
    expect(collision.runtime.model).toBe("openrouter/anthropic/claude");
    await expectStoreError(
      fixture.store.publishResidentModelSelectionProjection(command, fixture.binding, collision),
      "MODEL_SELECTION_PROJECTION_TARGET_MISMATCH",
    );
    expect((await fixture.store.getThreadSnapshot(command.threadId)).runtime?.model).toBe(
      "legacy-provider/legacy-model",
    );

    const exact = modelProjection(fixture.binding, "openrouter", "anthropic/claude");
    expect(exact.runtime.model).toBe(collision.runtime.model);
    await expect(
      fixture.store.publishResidentModelSelectionProjection(command, fixture.binding, exact),
    ).resolves.toMatchObject({ runtime: { model: "openrouter/anthropic/claude" } });
    await expect(
      fixture.store.finalizeModelSelectionDispatch(command, {
        status: "completed",
        message: "Structured model identity matched",
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects stale model-selection authority without opening a mutation attempt", async () => {
    const fixture = await createFixture();
    const stale = modelSelectionCommand(fixture.hostId, "model-stale-generation", "stale-generation");
    const staleAdmission = await fixture.store.admitCommand(stale, true);
    expect(staleAdmission.receipt).toMatchObject({
      status: "rejected",
      error: { code: "STALE_EXECUTION_GENERATION" },
    });
    expect(await modelAttemptNames(fixture.store)).toEqual([]);
  });

  it("fences binding refresh throughout the model transition", async () => {
    const fixture = await createFixture();
    const exact = modelSelectionCommand(fixture.hostId, "model-binding-changed");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
    );
    expect((await fixture.store.admitCommand(exact, true)).receipt.status).toBe("admitted");
    const refreshed = {
      ...fixture.binding,
      runtime: { ...fixture.binding.runtime, supervisorGeneration: "supervisor-replaced" },
    } satisfies ResidentSessionBinding;
    await expectStoreError(
      fixture.store.persistResidentSessionBinding(refreshed),
      "RESIDENT_DISPATCH_ACTIVE",
    );
    await fixture.store.beginModelSelectionDispatch(exact);
    await expectStoreError(
      fixture.store.persistResidentSessionBinding(refreshed),
      "RESIDENT_DISPATCH_ACTIVE",
    );
    await fixture.store.publishResidentModelSelectionProjection(
      exact,
      fixture.binding,
      modelProjection(fixture.binding, "openai", "gpt-5"),
    );
    await expectStoreError(
      fixture.store.persistResidentSessionBinding(refreshed),
      "RESIDENT_DISPATCH_ACTIVE",
    );
    await fixture.store.finalizeModelSelectionDispatch(exact, {
      status: "completed",
      message: "Exact model selection completed before binding refresh",
    });
    await expect(fixture.store.persistResidentSessionBinding(refreshed)).resolves.toBeUndefined();
  });

  it("commits proof when the requested model already matches the same-cursor projection", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-already-selected");
    const selected = modelProjection(fixture.binding, "openai", "gpt-5");
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, selected);
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);
    await expect(
      fixture.store.publishResidentModelSelectionProjection(command, fixture.binding, selected),
    ).resolves.toMatchObject({ runtime: { model: "openai/gpt-5" } });
    await expect(
      fixture.store.finalizeModelSelectionDispatch(command, {
        status: "completed",
        message: "Authoritative selected model already matched",
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects a digest-equal fast path when the public source diverged from its lineage", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-fast-path-lineage-diverged");
    const selected = modelProjection(fixture.binding, "openai", "gpt-5");
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, selected);
    const snapshotPath = await onlyJsonPath(fixture.store.paths.snapshots, "resident snapshot");
    const source = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      runtime: { messageCount: number };
    };
    await atomicWriteJson(snapshotPath, {
      ...source,
      runtime: { ...source.runtime, messageCount: source.runtime.messageCount + 1 },
    });
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);

    await expectStoreError(
      fixture.store.publishResidentModelSelectionProjection(command, fixture.binding, selected),
      "RESIDENT_PROJECTION_LINEAGE_DIVERGED",
    );
  });

  it("rejects a noncanonical running receipt before writing any model projection", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-running-message-tampered");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
    );
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);
    const receiptPath = await onlyJsonPath(fixture.store.paths.receipts, "model-selection receipt");
    const running = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    await atomicWriteJson(receiptPath, { ...running, message: "A substituted running message" });

    await expectStoreError(
      fixture.store.publishResidentModelSelectionProjection(
        command,
        fixture.binding,
        modelProjection(fixture.binding, "openai", "gpt-5"),
      ),
      "MODEL_SELECTION_PROJECTION_AUTHORITY_INVALID",
    );
    expect((await fixture.store.getThreadSnapshot(command.threadId)).runtime?.model).toBe(
      "legacy-provider/legacy-model",
    );
    const attemptPath = await onlyJsonPath(
      join(fixture.store.paths.root, "model-selection-attempts"),
      "model-selection attempt",
    );
    expect(JSON.parse(await readFile(attemptPath, "utf8"))).toMatchObject({ state: "dispatching" });
  });

  it.each(forbiddenSameCursorDeltas)(
    "rejects a same-cursor $name change outside the model-derived whitelist",
    async ({ name, mutate }) => {
      const fixture = await createFixture();
      const command = modelSelectionCommand(
        fixture.hostId,
        `model-forbidden-delta-${name.replaceAll(" ", "-")}`,
      );
      await fixture.store.publishResidentProjectionSnapshot(
        fixture.binding,
        modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
      );
      const before = await fixture.store.getThreadSnapshot(command.threadId);
      await fixture.store.admitCommand(command, true);
      await fixture.store.beginModelSelectionDispatch(command);

      await expectStoreError(
        fixture.store.publishResidentModelSelectionProjection(
          command,
          fixture.binding,
          mutate(modelProjection(fixture.binding, "openai", "gpt-5")),
        ),
        "RESIDENT_MODEL_SELECTION_PROJECTION_CONFLICT",
      );
      expect(await fixture.store.getThreadSnapshot(command.threadId)).toEqual(before);
    },
  );

  it("refuses normal completion after the committed attempt's running receipt is swapped", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-normal-finalize-receipt-swap");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
    );
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);
    await fixture.store.publishResidentModelSelectionProjection(
      command,
      fixture.binding,
      modelProjection(fixture.binding, "openai", "gpt-5"),
    );
    const receiptName = (await readdir(fixture.store.paths.receipts)).find((name) => name.endsWith(".json"));
    if (!receiptName) throw new Error("normal model-selection receipt fixture missing");
    const receiptPath = join(fixture.store.paths.receipts, receiptName);
    const running = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    await atomicWriteJson(receiptPath, { ...running, receiptId: "receipt-swapped-before-finalize" });
    await expectStoreError(
      fixture.store.finalizeModelSelectionDispatch(command, {
        status: "completed",
        message: "This must not complete",
      }),
      "MODEL_SELECTION_COMMITTED_RECEIPT_INVALID",
    );
  });

  it("refuses normal completion when the committed projection proof is forged", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-normal-finalize-proof-forged");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
    );
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);
    await fixture.store.publishResidentModelSelectionProjection(
      command,
      fixture.binding,
      modelProjection(fixture.binding, "openai", "gpt-5"),
    );
    const attemptPath = await onlyJsonPath(
      join(fixture.store.paths.root, "model-selection-attempts"),
      "committed model-selection attempt",
    );
    const committed = JSON.parse(await readFile(attemptPath, "utf8")) as {
      projectionProof: { projectionDigest: string };
    };
    await atomicWriteJson(attemptPath, {
      ...committed,
      projectionProof: { ...committed.projectionProof, projectionDigest: "f".repeat(64) },
    });

    await expectStoreError(
      fixture.store.finalizeModelSelectionDispatch(command, {
        status: "completed",
        message: "This forged proof must not complete",
      }),
      "MODEL_SELECTION_COMMITTED_PROOF_INVALID",
    );
    expect((await fixture.store.reconcileCommands([command])).receipts[0]?.status).toBe("running");
  });

  it("rejects a lowered historical proof cursor even when its timestamp is forged too", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-historical-proof-forged");
    const baseline = {
      ...modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
      cursor: { generation: "model-selection-cursor", sequence: 5 },
    };
    const selected = {
      ...modelProjection(fixture.binding, "openai", "gpt-5"),
      cursor: { generation: "model-selection-cursor", sequence: 5 },
    };
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, baseline);
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);
    await fixture.store.publishResidentModelSelectionProjection(command, fixture.binding, selected);
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, {
      ...selected,
      cursor: { ...selected.cursor, sequence: 6 },
    });
    const attemptPath = await onlyJsonPath(
      join(fixture.store.paths.root, "model-selection-attempts"),
      "historical model-selection attempt",
    );
    const committed = JSON.parse(await readFile(attemptPath, "utf8")) as {
      projectionProof: { cursor: { sequence: number }; publishedAt: string };
    };
    await atomicWriteJson(attemptPath, {
      ...committed,
      projectionProof: {
        ...committed.projectionProof,
        cursor: { ...committed.projectionProof.cursor, sequence: 4 },
        publishedAt: "2026-08-07T18:00:30.000Z",
      },
    });

    await expectStoreError(
      fixture.store.finalizeModelSelectionDispatch(command, {
        status: "completed",
        message: "A forged lower cursor must not classify as historical ancestry",
      }),
      "MODEL_SELECTION_COMMITTED_PROOF_INVALID",
    );
  });

  it("accepts an immutable committed proof after a later legitimate resident cursor", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-finalize-after-later-cursor");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
    );
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);
    const selected = modelProjection(fixture.binding, "openai", "gpt-5");
    await fixture.store.publishResidentModelSelectionProjection(command, fixture.binding, selected);
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, {
      ...selected,
      cursor: { ...selected.cursor, sequence: selected.cursor.sequence + 1 },
    });

    await expect(
      fixture.store.finalizeModelSelectionDispatch(command, {
        status: "completed",
        message: "Historical exact publication proof remains valid",
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("defers a same-cursor Stop idle rewrite until the committed model marker retires", async () => {
    const fixture = await createFixture();
    const modelCommand = modelSelectionCommand(fixture.hostId, "model-before-stop-idle-rewrite");
    const activeBaseline = activeModelProjection(fixture.binding, "legacy-provider", "legacy-model");
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, activeBaseline);
    await fixture.store.admitCommand(modelCommand, true);
    await fixture.store.beginModelSelectionDispatch(modelCommand);
    await fixture.store.publishResidentModelSelectionProjection(
      modelCommand,
      fixture.binding,
      activeModelProjection(fixture.binding, "openai", "gpt-5"),
    );

    const stop = abortCommand(fixture.hostId, "stop-during-model-publication");
    await fixture.store.admitCommand(stop, true);
    const dispatch = await fixture.store.beginResidentDispatch(stop);
    await fixture.store.finalizeResidentDispatch(dispatch, {
      status: "running",
      message: "Prime Agent accepted Stop; waiting for idle proof",
    });
    const [abortLease] = await fixture.store.listResidentAbortReconciliationLeases();
    if (!abortLease) throw new Error("acknowledged Stop reconciliation lease missing");
    const idle = modelProjection(fixture.binding, "openai", "gpt-5");
    const blocked = await expectStoreError(
      fixture.store.publishResidentProjectionSnapshot(fixture.binding, idle, abortLease),
      "RESIDENT_MODEL_SELECTION_PROJECTION_ACTIVE",
    );
    expect(blocked.retryable).toBe(true);

    await fixture.store.finalizeModelSelectionDispatch(modelCommand, {
      status: "completed",
      message: "Model publication finalized before idle rewrite",
    });
    await expect(
      fixture.store.publishResidentProjectionSnapshot(fixture.binding, idle, abortLease),
    ).resolves.toMatchObject({
      runtime: { model: "openai/gpt-5", isStreaming: false },
      thread: { status: "idle" },
    });
  });

  it("serializes dispatching and projection-committed selections on one exact resident binding", async () => {
    const fixture = await createFixture();
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
    );
    const first = modelSelectionCommand(fixture.hostId, "model-serialized-first");
    const whileDispatching = modelSelectionCommand(fixture.hostId, "model-serialized-dispatching");
    await fixture.store.admitCommand(first, true);
    await fixture.store.admitCommand(whileDispatching, true);
    await fixture.store.beginModelSelectionDispatch(first);
    await expectStoreError(
      fixture.store.beginModelSelectionDispatch(whileDispatching),
      "MODEL_SELECTION_ALREADY_ACTIVE",
    );
    await fixture.store.finalizeModelSelectionDispatch(whileDispatching, {
      status: "failed",
      message: "Another exact binding transition owns dispatch",
    });

    await fixture.store.publishResidentModelSelectionProjection(
      first,
      fixture.binding,
      modelProjection(fixture.binding, "openai", "gpt-5"),
    );
    const whileCommitted = modelSelectionCommand(fixture.hostId, "model-serialized-committed");
    await fixture.store.admitCommand(whileCommitted, true);
    await expectStoreError(
      fixture.store.beginModelSelectionDispatch(whileCommitted),
      "MODEL_SELECTION_ALREADY_ACTIVE",
    );
    await fixture.store.finalizeModelSelectionDispatch(whileCommitted, {
      status: "failed",
      message: "Another exact binding transition has committed proof",
    });
    await fixture.store.finalizeModelSelectionDispatch(first, {
      status: "completed",
      message: "First exact binding transition completed",
    });

    const afterTerminal = modelSelectionCommand(fixture.hostId, "model-serialized-after-terminal");
    await fixture.store.admitCommand(afterTerminal, true);
    await expect(fixture.store.beginModelSelectionDispatch(afterTerminal)).resolves.toEqual(fixture.binding);
  });

  it.each(["dispatching", "projection_committed"] as const)(
    "blocks resident End while a model attempt is %s and recovers without a boot failure",
    async (state) => {
      const fixture = await createFixture();
      const command = modelSelectionCommand(fixture.hostId, `model-end-fence-${state}`);
      await fixture.store.publishResidentProjectionSnapshot(
        fixture.binding,
        modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
      );
      await fixture.store.admitCommand(command, true);
      await fixture.store.beginModelSelectionDispatch(command);
      if (state === "projection_committed") {
        await fixture.store.publishResidentModelSelectionProjection(
          command,
          fixture.binding,
          modelProjection(fixture.binding, "openai", "gpt-5"),
        );
      }

      await expectStoreError(
        fixture.store.prepareResidentEnd(
          await residentEndInput(fixture, `end-during-${state}`, fixture.store),
          fixture.binding,
        ),
        "RESIDENT_DISPATCH_ACTIVE",
      );

      const restarted = new HostStore(fixture.directory);
      await expect(restarted.initialize()).resolves.toBeUndefined();
      expect((await restarted.reconcileCommands([command])).receipts[0]?.status).toBe(
        state === "projection_committed" ? "completed" : "uncertain",
      );
      expect(await modelAttemptNames(restarted)).toEqual([]);
      await expect(
        restarted.prepareResidentEnd(
          await residentEndInput(fixture, `end-after-${state}`, restarted),
          fixture.binding,
        ),
      ).resolves.toMatchObject({ kind: "end", phase: "ending" });
    },
  );

  it.each(["after_model_selection_identity", "after_model_selection_attempt"] as const)(
    "turns a crash at %s into uncertain and never replays it",
    async (faultPoint) => {
    const base = await createFixture();
    const command = modelSelectionCommand(base.hostId, `model-crash-${faultPoint}`);
    let injected = false;
    const crashing = new HostStore(base.directory, {
      admissionFaultInjector(point) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error("simulated crash after model admission");
        }
      },
    });
    await crashing.initialize();

    await expect(crashing.admitCommand(command, true)).rejects.toThrow("simulated crash after model admission");
    expect(await modelAttemptNames(crashing)).toHaveLength(
      faultPoint === "after_model_selection_attempt" ? 1 : 0,
    );
    const recovered = new HostStore(base.directory);
    await recovered.initialize();
    const receipt = (await recovered.reconcileCommands([command])).receipts[0];
    expect(receipt).toMatchObject({
      status: "uncertain",
      error: { code: "MODEL_SELECTION_RESTART_UNCERTAIN", retryable: false },
    });
    expect(await modelAttemptNames(recovered)).toEqual([]);
    expect(await recovered.admitCommand(command, true)).toEqual({ receipt, duplicate: true });
    await expectStoreError(recovered.beginModelSelectionDispatch(command), "MODEL_SELECTION_ATTEMPT_MISSING");
    expect(await commandStatuses(recovered, command.commandId)).toEqual(["received", "admitted", "uncertain"]);
    },
  );

  it("turns an interrupted dispatch into uncertain and never crosses that boundary again", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-crash-dispatching");
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    const receipt = (await restarted.reconcileCommands([command])).receipts[0];
    expect(receipt).toMatchObject({
      status: "uncertain",
      error: { code: "MODEL_SELECTION_RESTART_UNCERTAIN", retryable: false },
    });
    expect(await restarted.admitCommand(command, true)).toEqual({ receipt, duplicate: true });
    await expectStoreError(restarted.beginModelSelectionDispatch(command), "MODEL_SELECTION_ATTEMPT_MISSING");
    expect(await commandStatuses(restarted, command.commandId)).toEqual([
      "received",
      "admitted",
      "running",
      "uncertain",
    ]);
  });

  it.each([
    "after_prepare",
    "after_lineage",
    "after_snapshot",
    "after_threads",
    "after_model_selection_attempt",
    "after_prompt_locks",
  ] satisfies ResidentProjectionFaultPoint[])(
    "recovers an exact model publication crash at %s as completed without replay",
    async (faultPoint) => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, `model-projection-crash-${faultPoint}`);
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
    );
    let injected = false;
    const crashing = new HostStore(fixture.directory, {
      residentProjectionFaultInjector(point) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated model projection crash at ${point}`);
        }
      },
    });
    await crashing.initialize();
    await crashing.admitCommand(command, true);
    await crashing.beginModelSelectionDispatch(command);
    await expect(
      crashing.publishResidentModelSelectionProjection(
        command,
        fixture.binding,
        modelProjection(fixture.binding, "openai", "gpt-5"),
      ),
    ).rejects.toThrow(`simulated model projection crash at ${faultPoint}`);

    const recovered = new HostStore(fixture.directory);
    await recovered.initialize();
    const recoveredReceipt = (await recovered.reconcileCommands([command])).receipts[0];
    expect(recoveredReceipt).toMatchObject({ status: "completed" });
    expect(recoveredReceipt?.error).toBeUndefined();
    const recoveredSnapshot = await recovered.getThreadSnapshot(command.threadId);
    expect(recoveredSnapshot.runtime?.model).toBe("openai/gpt-5");
    expect((await recovered.getCatalogSnapshot()).threads).toContainEqual(recoveredSnapshot.thread);
    const lineagePath = await onlyJsonPath(
      recovered.paths.residentProjectionLineages,
      "resident projection lineage",
    );
    expect(JSON.parse(await readFile(lineagePath, "utf8"))).toMatchObject({
      current: {
        generation: "model-selection-cursor",
        sequence: 0,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(await modelAttemptNames(recovered)).toEqual([]);
    expect(await readdir(recovered.paths.residentProjectionTransactions)).toEqual([]);
    await expectStoreError(recovered.beginModelSelectionDispatch(command), "MODEL_SELECTION_ATTEMPT_MISSING");
    expect(await recovered.admitCommand(command, true)).toEqual({ receipt: recoveredReceipt, duplicate: true });
    },
  );

  it("fails closed when precommit projection recovery sees a swapped running receipt", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-projection-receipt-swap");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
    );
    const crashing = new HostStore(fixture.directory, {
      residentProjectionFaultInjector(point) {
        if (point === "after_prepare") throw new Error("simulated precommit projection crash");
      },
    });
    await crashing.initialize();
    await crashing.admitCommand(command, true);
    await crashing.beginModelSelectionDispatch(command);
    await expect(
      crashing.publishResidentModelSelectionProjection(
        command,
        fixture.binding,
        modelProjection(fixture.binding, "openai", "gpt-5"),
      ),
    ).rejects.toThrow("simulated precommit projection crash");
    const receiptName = (await readdir(crashing.paths.receipts)).find((name) => name.endsWith(".json"));
    if (!receiptName) throw new Error("committed model-selection receipt fixture missing");
    const receiptPath = join(crashing.paths.receipts, receiptName);
    const running = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    await atomicWriteJson(receiptPath, { ...running, receiptId: "receipt-swapped-after-crash" });

    const recovered = new HostStore(fixture.directory);
    await expect(recovered.initialize()).rejects.toMatchObject({
      code: "MODEL_SELECTION_PROJECTION_PROOF_CONFLICT",
    });
  });

  it("idempotently repairs a terminal receipt whose final journal append was interrupted", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-crash-finalizing");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
    );
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);
    await fixture.store.publishResidentModelSelectionProjection(
      command,
      fixture.binding,
      modelProjection(fixture.binding, "openai", "gpt-5"),
    );
    const receiptName = (await readdir(fixture.store.paths.receipts)).find((name) => name.endsWith(".json"));
    if (!receiptName) throw new Error("model-selection receipt fixture missing");
    const receiptPath = join(fixture.store.paths.receipts, receiptName);
    const running = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    await atomicWriteJson(receiptPath, {
      ...running,
      status: "completed",
      message: "Authoritative model projection saved before the journal interruption",
      updatedAt: "2026-08-07T18:02:00.000Z",
    });

    const recovered = new HostStore(fixture.directory);
    await recovered.initialize();
    expect((await recovered.reconcileCommands([command])).receipts[0]).toMatchObject({ status: "completed" });
    expect(await modelAttemptNames(recovered)).toEqual([]);
    expect(await commandStatuses(recovered, command.commandId)).toEqual([
      "received",
      "admitted",
      "running",
      "completed",
    ]);

    const restartedAgain = new HostStore(fixture.directory);
    await restartedAgain.initialize();
    expect(await commandStatuses(restartedAgain, command.commandId)).toEqual([
      "received",
      "admitted",
      "running",
      "completed",
    ]);
  });

  it("rejects a swapped completed receipt before partial-finalize recovery can retire proof", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-completed-receipt-swap");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
    );
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);
    await fixture.store.publishResidentModelSelectionProjection(
      command,
      fixture.binding,
      modelProjection(fixture.binding, "openai", "gpt-5"),
    );
    const receiptName = (await readdir(fixture.store.paths.receipts)).find((name) => name.endsWith(".json"));
    if (!receiptName) throw new Error("completed model-selection receipt fixture missing");
    const receiptPath = join(fixture.store.paths.receipts, receiptName);
    const running = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    await atomicWriteJson(receiptPath, {
      ...running,
      receiptId: "receipt-swapped-after-completion",
      status: "completed",
      message: "Tampered completed receipt",
      updatedAt: "2026-08-07T18:04:00.000Z",
    });
    const recovered = new HostStore(fixture.directory);
    await expect(recovered.initialize()).rejects.toMatchObject({
      code: "MODEL_SELECTION_COMMITTED_RECEIPT_INVALID",
    });
  });

  it("commits a same-cursor reasoning level only from exact session-reported proof", async () => {
    const fixture = await createFixture();
    const command = thinkingSelectionCommand(fixture.hostId, "thinking-same-cursor", "high");
    const baseline = modelProjection(fixture.binding, "openai", "gpt-5", { thinkingLevel: "off" });
    const selected = modelProjection(fixture.binding, "openai", "gpt-5", { thinkingLevel: "high" });
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, baseline);

    await expect(fixture.store.admitCommand(command, true)).resolves.toMatchObject({
      duplicate: false,
      receipt: { status: "admitted", queuePosition: undefined },
    });
    await expect(fixture.store.beginModelSelectionDispatch(command)).resolves.toEqual(fixture.binding);
    await expect(
      fixture.store.publishResidentModelSelectionProjection(command, fixture.binding, selected),
    ).resolves.toMatchObject({
      runtime: {
        model: "openai/gpt-5",
        thinkingLevel: "high",
        availableThinkingLevels: ["off", "low", "medium", "high"],
      },
    });

    const attemptPath = await onlyJsonPath(
      join(fixture.store.paths.root, "model-selection-attempts"),
      "reasoning-level attempt",
    );
    expect(JSON.parse(await readFile(attemptPath, "utf8"))).toMatchObject({
      state: "projection_committed",
      projectionProof: { selectedThinkingLevel: "high" },
    });
    expect(JSON.parse(await readFile(attemptPath, "utf8")).projectionProof.selectedModel).toBeUndefined();

    await expect(
      fixture.store.finalizeModelSelectionDispatch(command, {
        status: "completed",
        message: "Authoritative reasoning level saved",
      }),
    ).resolves.toMatchObject({ status: "completed", error: undefined });
    expect(await modelAttemptNames(fixture.store)).toEqual([]);
    expect(await commandStatuses(fixture.store, command.commandId)).toEqual([
      "received",
      "admitted",
      "running",
      "completed",
    ]);
  });

  it("rejects same-cursor reasoning proof when the reported level set also changes", async () => {
    const fixture = await createFixture();
    const command = thinkingSelectionCommand(fixture.hostId, "thinking-level-set-changed", "high");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "openai", "gpt-5", { thinkingLevel: "off" }),
    );
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);

    await expectStoreError(
      fixture.store.publishResidentModelSelectionProjection(
        command,
        fixture.binding,
        modelProjection(fixture.binding, "openai", "gpt-5", {
          thinkingLevel: "high",
          availableThinkingLevels: ["off", "low", "medium"],
        }),
      ),
      "MODEL_SELECTION_PROJECTION_TARGET_MISMATCH",
    );
    await expectStoreError(
      fixture.store.publishResidentModelSelectionProjection(
        command,
        fixture.binding,
        modelProjection(fixture.binding, "openai", "gpt-5", {
          thinkingLevel: "high",
          availableThinkingLevels: ["low", "medium", "high"],
        }),
      ),
      "RESIDENT_MODEL_SELECTION_PROJECTION_CONFLICT",
    );
    expect((await fixture.store.getThreadSnapshot(command.threadId)).runtime?.thinkingLevel).toBe("off");
  });

  it("admits reasoning changes only while idle and only for a reported level", async () => {
    const fixture = await createFixture();
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      activeModelProjection(fixture.binding, "openai", "gpt-5"),
    );
    const busy = thinkingSelectionCommand(fixture.hostId, "thinking-busy", "high");
    await expect(fixture.store.admitCommand(busy, true)).resolves.toMatchObject({
      receipt: { status: "rejected", error: { code: "RESIDENT_SESSION_BUSY", retryable: true } },
    });

    const idleProjection = modelProjection(fixture.binding, "openai", "gpt-5", {
      thinkingLevel: "off",
      availableThinkingLevels: ["off", "low"],
    });
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, {
      ...idleProjection,
      cursor: { ...idleProjection.cursor, sequence: 1 },
    });
    const unavailable = thinkingSelectionCommand(fixture.hostId, "thinking-unavailable", "high");
    await expect(fixture.store.admitCommand(unavailable, true)).resolves.toMatchObject({
      receipt: {
        status: "rejected",
        error: { code: "THINKING_LEVEL_UNAVAILABLE", retryable: false },
      },
    });
    expect(await modelAttemptNames(fixture.store)).toEqual([]);
  });

  it("turns an interrupted reasoning mutation into uncertain and never replays it", async () => {
    const fixture = await createFixture();
    const command = thinkingSelectionCommand(fixture.hostId, "thinking-crash-dispatching", "high");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "openai", "gpt-5", { thinkingLevel: "off" }),
    );
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    const receipt = (await restarted.reconcileCommands([command])).receipts[0];
    expect(receipt).toMatchObject({
      status: "uncertain",
      error: { code: "MODEL_SELECTION_RESTART_UNCERTAIN", retryable: false },
    });
    expect(await restarted.admitCommand(command, true)).toEqual({ receipt, duplicate: true });
    await expectStoreError(restarted.beginModelSelectionDispatch(command), "MODEL_SELECTION_ATTEMPT_MISSING");
    expect(await commandStatuses(restarted, command.commandId)).toEqual([
      "received",
      "admitted",
      "running",
      "uncertain",
    ]);
  });

  it("recovers a reasoning dispatch marker written before its running receipt without replay", async () => {
    const fixture = await createFixture();
    const command = thinkingSelectionCommand(fixture.hostId, "thinking-dispatch-receipt-split", "high");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "openai", "gpt-5", { thinkingLevel: "off" }),
    );
    const admission = await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);
    const receiptPath = await onlyJsonPath(fixture.store.paths.receipts, "reasoning-selection receipt");
    await atomicWriteJson(receiptPath, admission.receipt);

    const restarted = new HostStore(fixture.directory);
    await expect(restarted.initialize()).resolves.toBeUndefined();
    const receipt = (await restarted.reconcileCommands([command])).receipts[0];
    expect(receipt).toMatchObject({
      status: "uncertain",
      error: { code: "MODEL_SELECTION_RESTART_UNCERTAIN", retryable: false },
    });
    expect(await modelAttemptNames(restarted)).toEqual([]);
    expect(await restarted.admitCommand(command, true)).toEqual({ receipt, duplicate: true });
    await expectStoreError(restarted.beginModelSelectionDispatch(command), "MODEL_SELECTION_ATTEMPT_MISSING");
  });

  it("keeps urgent Stop independent while a reasoning change still blocks a new prompt", async () => {
    const fixture = await createFixture();
    const thinking = thinkingSelectionCommand(fixture.hostId, "thinking-before-stop", "high");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "openai", "gpt-5", { thinkingLevel: "off" }),
    );
    await fixture.store.admitCommand(thinking, true);
    await fixture.store.beginModelSelectionDispatch(thinking);

    const prompt = promptCommand(fixture.hostId, "prompt-during-thinking");
    await expect(fixture.store.admitCommand(prompt, true)).resolves.toMatchObject({
      receipt: { status: "rejected", error: { code: "RESIDENT_DISPATCH_ACTIVE", retryable: true } },
    });

    const externallyActive = activeModelProjection(fixture.binding, "openai", "gpt-5");
    await fixture.store.publishResidentProjectionSnapshot(fixture.binding, {
      ...externallyActive,
      cursor: { ...externallyActive.cursor, sequence: 1 },
    });
    const stop = abortCommand(fixture.hostId, "stop-during-thinking");
    await expect(fixture.store.admitCommand(stop, true)).resolves.toMatchObject({
      receipt: { status: "admitted" },
    });
    await expect(fixture.store.beginResidentDispatch(stop)).resolves.toMatchObject({
      command: stop,
      binding: fixture.binding,
    });
  });
});

describe("HostService resident model-selection dispatch", () => {
  it("durably rejects a failed live precheck without creating a mutation attempt", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-live-precheck-failed");
    const submit = vi.fn<PrimeAgentGateway["submit"]>();
    const gateway: PrimeAgentGateway = {
      continuity: "resident",
      async isLive() {
        throw new Error("raw-daemon-and-credential-detail-must-not-escape");
      },
      submit,
      async close() {},
    };
    const service = new HostService(fixture.store, gateway);
    await service.initialize();

    const response = await submitThroughService(service, command, "model-live-precheck-request");
    expect(response).toMatchObject({
      ok: true,
      result: {
        status: "rejected",
        error: { code: "MODEL_SELECTION_LIVE_CHECK_FAILED", retryable: true },
      },
    });
    expect(JSON.stringify(response)).not.toContain("raw-daemon-and-credential-detail");
    expect(submit).not.toHaveBeenCalled();
    expect(await modelAttemptNames(fixture.store)).toEqual([]);
    await service.close();
  });

  it.each(["handled", "throws-after-publication"] as const)(
    "completes only after Store publication when the gateway %s",
    async (outcome) => {
      const fixture = await createFixture();
      const command = modelSelectionCommand(fixture.hostId, `model-service-published-${outcome}`);
      await fixture.store.publishResidentProjectionSnapshot(
        fixture.binding,
        modelProjection(fixture.binding, "legacy-provider", "legacy-model"),
      );
      const submit = vi.fn(async (submitted: CommandEnvelope, context?: GatewayDispatchContext) => {
        if (!context?.residentBinding) throw new Error("resident binding context missing");
        await fixture.store.publishResidentModelSelectionProjection(
          submitted,
          context.residentBinding,
          modelProjection(context.residentBinding, "openai", "gpt-5"),
        );
        if (outcome === "throws-after-publication") {
          throw new GatewayError(
            "MODEL_SELECTION_OUTCOME_UNKNOWN",
            "Post-publication liveness became unavailable",
            false,
            true,
          );
        }
        return { disposition: "handled" as const, message: "Fresh authoritative model state saved" };
      });
      const service = new HostService(fixture.store, gatewayWith(submit));
      await service.initialize();

      const response = await submitThroughService(service, command, `model-service-${outcome}-request`);
      expect(response).toMatchObject({ ok: true, result: { status: "completed" } });
      expect((await fixture.store.getThreadSnapshot(command.threadId)).runtime?.model).toBe("openai/gpt-5");
      expect(await modelAttemptNames(fixture.store)).toEqual([]);
      expect(submit).toHaveBeenCalledOnce();
      await service.close();
    },
  );

  it("completes a reasoning change only after the same durable projection proof", async () => {
    const fixture = await createFixture();
    const command = thinkingSelectionCommand(fixture.hostId, "thinking-service-published", "high");
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      modelProjection(fixture.binding, "openai", "gpt-5", { thinkingLevel: "off" }),
    );
    const submit = vi.fn(async (submitted: CommandEnvelope, context?: GatewayDispatchContext) => {
      if (!context?.residentBinding) throw new Error("resident binding context missing");
      await fixture.store.publishResidentModelSelectionProjection(
        submitted,
        context.residentBinding,
        modelProjection(context.residentBinding, "openai", "gpt-5", { thinkingLevel: "high" }),
      );
      return { disposition: "handled" as const, message: "Fresh authoritative reasoning state saved" };
    });
    const service = new HostService(fixture.store, gatewayWith(submit));
    await service.initialize();

    const response = await submitThroughService(service, command, "thinking-service-request");
    expect(response).toMatchObject({ ok: true, result: { status: "completed" } });
    expect((await fixture.store.getThreadSnapshot(command.threadId)).runtime?.thinkingLevel).toBe("high");
    expect(await modelAttemptNames(fixture.store)).toEqual([]);
    expect(submit).toHaveBeenCalledOnce();
    await service.close();
  });

  it("never completes from a handled gateway result without Store publication proof", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-service-success");
    let observedContext: GatewayDispatchContext | undefined;
    const submit = vi.fn(async (submitted: CommandEnvelope, context?: GatewayDispatchContext) => {
      observedContext = context;
      expect((await fixture.store.reconcileCommands([submitted])).receipts[0]?.status).toBe("running");
      return { disposition: "handled" as const, message: "Fresh authoritative model state saved" };
    });
    const gateway = gatewayWith(submit);
    const service = new HostService(fixture.store, gateway);
    await service.initialize();

    const response = await submitThroughService(service, command, "model-service-request-1");
    expect(response).toMatchObject({
      ok: true,
      result: {
        status: "uncertain",
        error: { code: "MODEL_SELECTION_OUTCOME_UNKNOWN", retryable: false },
      },
    });
    expect(observedContext?.residentBinding).toEqual(fixture.binding);
    expect(submit).toHaveBeenCalledTimes(1);

    const duplicate = await submitThroughService(service, command, "model-service-request-2");
    expect(duplicate).toEqual({ ...response, requestId: "model-service-request-2" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await commandStatuses(fixture.store, command.commandId)).toEqual([
      "received",
      "admitted",
      "running",
      "uncertain",
    ]);

    const reused = await submitThroughService(
      service,
      {
        ...command,
        command: { kind: "model.select", providerId: "anthropic", modelId: "claude-opus-4" },
      },
      "model-service-request-reused",
    );
    expect(reused).toMatchObject({ ok: false, error: { code: "COMMAND_ID_REUSED" } });
    expect(submit).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("persists an ambiguous gateway result as non-retryable uncertain without leaking its cause", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-service-uncertain");
    const submit = vi.fn(async () => {
      throw new GatewayError(
        "MODEL_SELECTION_OUTCOME_UNKNOWN",
        "Prime Agent may have changed the model, but no authoritative result is available",
        false,
        true,
      );
    });
    const service = new HostService(fixture.store, gatewayWith(submit));
    await service.initialize();

    const response = await submitThroughService(service, command, "model-service-uncertain-request");
    expect(response).toMatchObject({
      ok: true,
      result: {
        status: "uncertain",
        error: { code: "MODEL_SELECTION_OUTCOME_UNKNOWN", retryable: false },
      },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    const duplicate = await submitThroughService(service, command, "model-service-uncertain-duplicate");
    expect(duplicate).toEqual({ ...response, requestId: "model-service-uncertain-duplicate" });
    expect(submit).toHaveBeenCalledTimes(1);
    await service.close();
  });
});

async function createFixture(): Promise<{
  directory: string;
  store: HostStore;
  hostId: string;
  binding: ResidentSessionBinding;
}> {
  const directory = await mkdtemp(join(tmpdir(), "prime-resident-model-selection-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = new HostStore(directory);
  await store.initialize();
  const workspaceDirectory = await realpath(workspace);
  await bootstrapTestWorkspace(store, { workspaceDirectory });
  await store.registerWorkspaceAuthority({
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
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
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
    workspaceDirectory,
    activeSessionId: "active-session-model-1",
    sessionId: "session-model-1",
    sessionFile: join(workspaceDirectory, ".prime-agent", "session-model-1.jsonl"),
    boundAt: "2026-08-07T18:00:00.000Z",
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

function modelSelectionCommand(
  expectedHostId: string,
  commandId: string,
  executionGenerationId = "test-execution-1",
): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "model-device-1",
    commandId,
    expectedHostId,
    threadId: "test-thread",
    issuedAt: "2026-08-07T18:01:00.000Z",
    expectedExecutionGenerationId: executionGenerationId,
    command: { kind: "model.select", providerId: "openai", modelId: "gpt-5" },
  };
}

function thinkingSelectionCommand(
  expectedHostId: string,
  commandId: string,
  level: string,
): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "thinking-device-1",
    commandId,
    expectedHostId,
    threadId: "test-thread",
    issuedAt: "2026-08-07T18:01:00.000Z",
    expectedExecutionGenerationId: "test-execution-1",
    command: { kind: "thinking.select", level },
  };
}

function abortCommand(expectedHostId: string, commandId: string): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "model-stop-device",
    commandId,
    expectedHostId,
    threadId: "test-thread",
    issuedAt: "2026-08-07T18:01:15.000Z",
    expectedExecutionGenerationId: "test-execution-1",
    command: { kind: "abort", reason: "Fence same-cursor model publication before idle reconciliation." },
  };
}

function promptCommand(expectedHostId: string, commandId: string): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "model-prompt-device",
    commandId,
    expectedHostId,
    threadId: "test-thread",
    issuedAt: "2026-08-07T18:01:10.000Z",
    expectedExecutionGenerationId: "test-execution-1",
    command: { kind: "prompt", text: "Run after the reasoning preference settles." },
  };
}

function modelProjection(
  residentBinding: ResidentSessionBinding,
  providerId: string,
  modelId: string,
  options: {
    thinkingLevel?: string;
    availableThinkingLevels?: string[];
    serviceTier?: string;
    maxTokens?: number;
  } = {},
): ResidentProjectionSnapshot {
  return {
    projectionVersion: 1,
    identity: {
      activeSessionId: residentBinding.activeSessionId,
      sessionId: residentBinding.sessionId,
      sessionFile: residentBinding.sessionFile,
      workspaceDirectory: residentBinding.workspaceDirectory,
    },
    selectedModel: { providerId, modelId },
    cursor: { generation: "model-selection-cursor", sequence: 0 },
    runtime: {
      runtime: "prime_agent",
      residency: "resident",
      appVersion: residentBinding.runtime.appVersion,
      activeSessionId: residentBinding.activeSessionId,
      sessionId: residentBinding.sessionId,
      model: `${providerId}/${modelId}`,
      thinkingLevel: options.thinkingLevel ?? "off",
      availableThinkingLevels: options.availableThinkingLevels ?? ["off", "low", "medium", "high"],
      serviceTier: options.serviceTier ?? "default",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      messageCount: 0,
      compactionCount: 0,
      queuedActionCount: 0,
      activeToolNames: [],
      context: { usedTokens: 0, maxTokens: options.maxTokens ?? 8_192 },
    },
    transcript: [],
    childAgents: [],
    queue: { queuedCount: 0, steeringCount: 0, followUpCount: 0 },
  };
}

function activeModelProjection(
  residentBinding: ResidentSessionBinding,
  providerId: string,
  modelId: string,
): ResidentProjectionSnapshot {
  const projection = modelProjection(residentBinding, providerId, modelId);
  return {
    ...projection,
    runtime: {
      ...projection.runtime,
      isStreaming: true,
      messageCount: 1,
      queuedActionCount: 1,
    },
    queue: {
      queuedCount: 0,
      steeringCount: 0,
      followUpCount: 0,
      active: { kind: "turn", phase: "running", label: "Resident turn" },
    },
  };
}

async function residentEndInput(
  fixture: { hostId: string },
  operationId: string,
  store: HostStore,
): Promise<ResidentEndLifecycleOperationInput> {
  const snapshot = await store.getThreadSnapshot("test-thread");
  return {
    operationId,
    expectedHostId: fixture.hostId,
    projectId: "test-project",
    workspaceId: "test-workspace",
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
    requestDigest: "e".repeat(64),
    expectedSourceCursor: snapshot.latestCursor,
  };
}

async function onlyJsonPath(directory: string, label: string): Promise<string> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  if (names.length !== 1 || !names[0]) {
    throw new Error(`Expected exactly one ${label} JSON file, found ${names.length}`);
  }
  return join(directory, names[0]);
}

function gatewayWith(
  submit: PrimeAgentGateway["submit"],
): PrimeAgentGateway {
  return {
    continuity: "resident",
    async isLive() {
      return true;
    },
    submit,
    async close() {},
  };
}

function submitThroughService(service: HostService, command: CommandEnvelope, requestId: string) {
  return service.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: "command.submit",
    payload: { command },
  }, TRUSTED_USER_SESSION);
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

async function modelAttemptNames(store: HostStore): Promise<string[]> {
  return (await readdir(join(store.paths.root, "model-selection-attempts")))
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
