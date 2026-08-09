import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteJson } from "../../src/hostd/atomic-files";
import {
  CodexSubscriptionStore,
  type CodexSubscriptionStoreOptions,
} from "../../src/hostd/codex-subscription-store";
import type {
  CodexSubscriptionConversationSnapshot,
  CodexSubscriptionTurnInterruptRequest,
  CodexSubscriptionTurnStartRequest,
} from "../../src/shared/protocol";
import { canonicalTemporaryDirectory } from "../helpers/canonical-temp";

const HOST_ID = "host-local";
const BACKEND_ONE = "codex-process-one";
const BACKEND_TWO = "codex-process-two";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Codex subscription durable store", () => {
  it("admits exact turn retries once and enforces conversation CAS plus the host-wide barrier", async () => {
    const fixture = await storeFixture();
    const first = absentTurn("turn-op-1", "Read this implementation.");
    const admitted = await fixture.store.admitTurn(first, BACKEND_ONE);
    expect(admitted).toMatchObject({
      duplicate: false,
      snapshot: { state: "active", activeTurn: { state: "admitted" }, revision: 1 },
    });
    await expect(fixture.store.admitTurn(first, BACKEND_ONE)).resolves.toMatchObject({ duplicate: true });
    await expect(fixture.store.admitTurn({ ...first, prompt: "Different request." }, BACKEND_ONE)).rejects.toMatchObject({
      code: "CODEX_OPERATION_COLLISION",
    });
    await expect(fixture.store.admitTurn(absentTurn("turn-op-2", "Parallel request."), BACKEND_ONE)).rejects.toMatchObject({
      code: "CODEX_HOST_BUSY",
      retryable: true,
    });

    await fixture.store.markTurnStartingThread(first.operationId, BACKEND_ONE);
    await fixture.store.bindThread(first.operationId, "codex-thread-1", BACKEND_ONE);
    await fixture.store.markTurnPromptDispatching(first.operationId, BACKEND_ONE);
    await fixture.store.bindTurn(first.operationId, "codex-turn-1", BACKEND_ONE);
    await fixture.store.appendAssistantDelta(first.operationId, "assistant-item-1", "The implementation is bounded.", BACKEND_ONE);
    const completed = await fixture.store.completeTurn(first.operationId, { state: "completed" }, BACKEND_ONE);
    expect(completed).toMatchObject({
      state: "terminal",
      threadId: "codex-thread-1",
      latestTurn: { state: "completed", terminal: true, turnId: "codex-turn-1" },
    });
    await expect(fixture.store.assertQuiescent()).resolves.toBeUndefined();

    const stale = presentTurn("turn-op-2", completed, "Use a stale revision.");
    const current = await fixture.store.getConversation(completed.binding, BACKEND_ONE);
    expect(current).toEqual(completed);
    await expect(fixture.store.admitTurn({
      ...stale,
      expectedConversation: {
        state: "present",
        sessionId: completed.sessionId,
        revision: completed.revision - 1,
        ...(completed.threadId ? { threadId: completed.threadId } : {}),
      },
    }, BACKEND_ONE)).rejects.toMatchObject({ code: "CODEX_TURN_AUTHORITY_CHANGED" });
    await expect(fixture.store.admitTurn({
      ...stale,
      expectedBackendIncarnationId: "stale-process",
    }, BACKEND_ONE)).rejects.toMatchObject({ code: "CODEX_TURN_AUTHORITY_CHANGED" });
  });

  it("binds Stop to the exact incarnation, session, provider thread, turn, and operation", async () => {
    const fixture = await storeFixture();
    const running = await startRunning(fixture.store, absentTurn("turn-op-1", "Keep reading."), BACKEND_ONE);
    const interrupt = interruptFor("stop-op-1", running);
    await expect(fixture.store.admitInterrupt({ ...interrupt, sessionId: "stale-session" }, BACKEND_ONE)).rejects.toMatchObject({
      code: "CODEX_TURN_AUTHORITY_CHANGED",
    });
    await fixture.store.admitInterrupt(interrupt, BACKEND_ONE);
    await fixture.store.markInterruptDispatching(interrupt.operationId, BACKEND_ONE);
    const restored = await fixture.store.completeInterrupt(interrupt.operationId, "failed", BACKEND_ONE);
    expect(restored).toMatchObject({ state: "active", activeTurn: { state: "running" } });

    const second = interruptFor("stop-op-2", restored);
    await fixture.store.admitInterrupt(second, BACKEND_ONE);
    await fixture.store.markInterruptDispatching(second.operationId, BACKEND_ONE);
    const stopped = await fixture.store.completeInterrupt(second.operationId, "interrupted", BACKEND_ONE);
    expect(stopped).toMatchObject({
      state: "terminal",
      latestTurn: { state: "interrupted", terminal: true, turnId: "codex-turn-op-1" },
    });
    await expect(fixture.store.assertQuiescent()).resolves.toBeUndefined();
  });

  it("retains ordered deltas after Stop and atomically settles the turn plus matching interrupt", async () => {
    const fixture = await storeFixture();
    const running = await startRunning(
      fixture.store,
      absentTurn("turn-op-stop-race", "Keep streaming until Stop is proven."),
      BACKEND_ONE,
    );
    await fixture.store.appendAssistantDelta(
      running.activeTurn!.operationId,
      "assistant-stop-race",
      "before Stop; ",
      BACKEND_ONE,
    );
    const interrupt = interruptFor("stop-op-race", running);
    await fixture.store.admitInterrupt(interrupt, BACKEND_ONE);
    await fixture.store.markInterruptDispatching(interrupt.operationId, BACKEND_ONE);
    await fixture.store.appendAssistantDelta(
      running.activeTurn!.operationId,
      "assistant-stop-race",
      "after Stop",
      BACKEND_ONE,
    );

    const settled = await fixture.store.settleProviderTurn(running.activeTurn!.operationId, {
      threadId: running.threadId!,
      turnId: running.activeTurn!.turnId!,
      state: "interrupted",
    }, BACKEND_ONE);
    expect(settled).toMatchObject({
      state: "terminal",
      latestTurn: { state: "interrupted", terminal: true },
      transcript: expect.arrayContaining([
        expect.objectContaining({
          itemId: "assistant-stop-race",
          state: "completed",
          text: "before Stop; after Stop",
        }),
      ]),
    });
    await expect(fixture.store.getOperation(running.activeTurn!.operationId)).resolves.toMatchObject({
      phase: "completed",
    });
    await expect(fixture.store.getOperation(interrupt.operationId)).resolves.toMatchObject({
      phase: "completed",
    });
    await expect(fixture.store.settleProviderTurn(running.activeTurn!.operationId, {
      threadId: running.threadId!,
      turnId: running.activeTurn!.turnId!,
      state: "interrupted",
    }, BACKEND_ONE)).resolves.toEqual(settled);
    await expect(fixture.store.assertQuiescent()).resolves.toBeUndefined();
  });

  it("retires a racing Stop as redundant when the provider completes naturally", async () => {
    const fixture = await storeFixture();
    const running = await startRunning(
      fixture.store,
      absentTurn("turn-op-natural-race", "Finish naturally while Stop races."),
      BACKEND_ONE,
    );
    const interrupt = interruptFor("stop-op-natural-race", running);
    await fixture.store.admitInterrupt(interrupt, BACKEND_ONE);
    await fixture.store.markInterruptDispatching(interrupt.operationId, BACKEND_ONE);

    const settled = await fixture.store.settleProviderTurn(running.activeTurn!.operationId, {
      threadId: running.threadId!,
      turnId: running.activeTurn!.turnId!,
      state: "completed",
    }, BACKEND_ONE);
    expect(settled).toMatchObject({ state: "terminal", latestTurn: { state: "completed" } });
    await expect(fixture.store.getOperation(interrupt.operationId)).resolves.toMatchObject({ phase: "failed" });
    await expect(fixture.store.assertQuiescent()).resolves.toBeUndefined();
  });

  it("serializes login/logout mutations and rejects stale backend incarnations", async () => {
    const fixture = await storeFixture();
    await expect(fixture.store.admitAccountMutation(
      "login",
      HOST_ID,
      "login-op-1",
      "stale-process",
      BACKEND_ONE,
    )).rejects.toMatchObject({ code: "CODEX_TURN_AUTHORITY_CHANGED" });
    const login = await fixture.store.admitAccountMutation(
      "login",
      HOST_ID,
      "login-op-1",
      BACKEND_ONE,
      BACKEND_ONE,
    );
    expect(login.duplicate).toBe(false);
    await fixture.store.markAccountMutationDispatching("login-op-1");
    await fixture.store.markLoginActive("login-op-1", "login-attempt-1");
    await expect(fixture.store.admitTurn(absentTurn("turn-op-1", "Must remain blocked."), BACKEND_ONE)).rejects.toMatchObject({
      code: "CODEX_HOST_BUSY",
    });
    await fixture.store.beginLoginCancel("login-op-1", "login-attempt-1");
    await fixture.store.completeAccountMutation("login-op-1", "completed");
    await expect(fixture.store.assertQuiescent()).resolves.toBeUndefined();

    await fixture.store.admitAccountMutation("logout", HOST_ID, "logout-op-1", BACKEND_ONE, BACKEND_ONE);
    await fixture.store.markAccountMutationDispatching("logout-op-1");
    await fixture.store.completeAccountMutation("logout-op-1", "completed");
    await expect(fixture.store.assertQuiescent()).resolves.toBeUndefined();
  });

  it("never replays restart-uncertain work and adopts only exact authoritative provider proof", async () => {
    const fixture = await storeFixture();
    const request = absentTurn("turn-op-1", "Continue until interrupted.");
    const running = await startRunning(fixture.store, request, BACKEND_ONE);
    const clientUserMessageId = running.transcript[0]!.itemId;
    const providerThreadId = running.threadId!;
    const providerTurnId = running.activeTurn!.turnId!;

    const restarted = new CodexSubscriptionStore({
      statePath: fixture.statePath,
      now: () => fixture.clock.now(),
      idFactory: sequentialIds("restart"),
    });
    await expect(restarted.initialize()).resolves.toEqual([
      expect.objectContaining({
        operationId: request.operationId,
        priorPhase: "active",
        recoveredPhase: "uncertain",
      }),
    ]);
    const reconciled = await restarted.reconcileTurn(request, BACKEND_TWO);
    expect(reconciled).toMatchObject({ known: true, snapshot: { state: "uncertain" } });
    await expect(restarted.admitTurn({
      ...absentTurn("turn-op-2", "Never parallel replay."),
      expectedBackendIncarnationId: BACKEND_TWO,
    }, BACKEND_TWO)).rejects.toMatchObject({
      code: "CODEX_HOST_BUSY",
    });
    await expect(restarted.adoptAuthoritativeTurn(request.operationId, {
      clientUserMessageId: "different-message",
      threadId: providerThreadId,
      turnId: providerTurnId,
      state: "completed",
    }, BACKEND_TWO)).rejects.toMatchObject({ code: "CODEX_TURN_AUTHORITY_CHANGED" });

    const adopted = await restarted.adoptAuthoritativeTurn(request.operationId, {
      clientUserMessageId,
      threadId: providerThreadId,
      turnId: providerTurnId,
      state: "completed",
      assistantItems: [{ itemId: "assistant-item-1", text: "Recovered from provider history." }],
    }, BACKEND_TWO);
    expect(adopted).toMatchObject({
      backendIncarnationId: BACKEND_TWO,
      state: "terminal",
      latestTurn: { state: "completed" },
      transcript: expect.arrayContaining([
        expect.objectContaining({ itemId: "assistant-item-1", text: "Recovered from provider history." }),
      ]),
    });
    await expect(restarted.assertQuiescent()).resolves.toBeUndefined();
  });

  it("reconciles a restart-uncertain Stop and target from one exact provider proof", async () => {
    const fixture = await storeFixture();
    const request = absentTurn("turn-op-restart-stop", "Stop across a host restart.");
    const running = await startRunning(fixture.store, request, BACKEND_ONE);
    const interrupt = interruptFor("stop-op-restart", running);
    await fixture.store.admitInterrupt(interrupt, BACKEND_ONE);
    await fixture.store.markInterruptDispatching(interrupt.operationId, BACKEND_ONE);

    const restarted = new CodexSubscriptionStore({
      statePath: fixture.statePath,
      now: () => fixture.clock.now(),
      idFactory: sequentialIds("restart-stop"),
    });
    const recoveries = await restarted.initialize();
    expect(recoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: request.operationId, recoveredPhase: "uncertain" }),
      expect.objectContaining({ operationId: interrupt.operationId, recoveredPhase: "uncertain" }),
    ]));
    const clientUserMessageId = running.transcript[0]!.itemId;
    const adopted = await restarted.adoptAuthoritativeTurn(request.operationId, {
      clientUserMessageId,
      threadId: running.threadId!,
      turnId: running.activeTurn!.turnId!,
      state: "interrupted",
      assistantItems: [{ itemId: "assistant-restart-stop", text: "Stopped." }],
    }, BACKEND_TWO);
    expect(adopted).toMatchObject({ state: "terminal", latestTurn: { state: "interrupted" } });
    await expect(restarted.getOperation(request.operationId)).resolves.toMatchObject({ phase: "completed" });
    await expect(restarted.getOperation(interrupt.operationId)).resolves.toMatchObject({
      phase: "completed",
      reconciledByIncarnationId: BACKEND_TWO,
    });
    await expect(restarted.assertQuiescent()).resolves.toBeUndefined();
  });

  it("fences the process after any unconfirmed state write and recovers only from disk", async () => {
    const before = await storeFixture({
      writeState: async () => {
        throw new Error("private pre-commit failure");
      },
    });
    await expect(before.store.admitTurn(absentTurn("before-op", "Never dispatch."), BACKEND_ONE)).rejects.toMatchObject({
      code: "CODEX_STATE_INVALID",
    });
    await expect(before.store.getOperation("before-op")).rejects.toMatchObject({ code: "CODEX_STATE_INVALID" });
    const beforeRestart = new CodexSubscriptionStore({ statePath: before.statePath });
    await expect(beforeRestart.initialize()).resolves.toEqual([]);
    await expect(beforeRestart.getOperation("before-op")).resolves.toBeUndefined();

    const after = await storeFixture({
      writeState: async (path, value, maxBytes) => {
        await atomicWriteJson(path, value, maxBytes);
        throw new Error("private post-rename ambiguity");
      },
    });
    await expect(after.store.admitTurn(absentTurn("after-op", "Do not dispatch."), BACKEND_ONE)).rejects.toMatchObject({
      code: "CODEX_STATE_INVALID",
    });
    await expect(after.store.getOperation("after-op")).rejects.toMatchObject({ code: "CODEX_STATE_INVALID" });
    const afterRestart = new CodexSubscriptionStore({ statePath: after.statePath });
    await expect(afterRestart.initialize()).resolves.toEqual([
      expect.objectContaining({ operationId: "after-op", priorPhase: "admitted", recoveredPhase: "failed" }),
    ]);
    const afterRecovered = await afterRestart.getConversation({
      hostId: HOST_ID,
      sourceThreadId: "source-thread-1",
      executionGenerationId: "generation-source-thread-1",
    }, BACKEND_TWO);
    expect(afterRecovered).toMatchObject({
      state: "terminal",
      latestTurn: { state: "failed", terminal: true },
    });
    expect(afterRecovered).not.toHaveProperty("threadId");
    expect(afterRecovered?.latestTurn).not.toHaveProperty("turnId");
    await expect(afterRestart.assertQuiescent()).resolves.toBeUndefined();
  });

  it("fails pre-prompt crashes but preserves the post-barrier no-replay uncertainty", async () => {
    const fixture = await storeFixture();
    const request = absentTurn("starting-thread-op", "Crash before thread/start returns.");
    await fixture.store.admitTurn(request, BACKEND_ONE);
    await fixture.store.markTurnStartingThread(request.operationId, BACKEND_ONE);

    const restarted = new CodexSubscriptionStore({ statePath: fixture.statePath });
    await expect(restarted.initialize()).resolves.toEqual([
      expect.objectContaining({
        operationId: request.operationId,
        priorPhase: "dispatching",
        recoveredPhase: "failed",
      }),
    ]);
    const recovered = await restarted.getConversation({
      hostId: HOST_ID,
      sourceThreadId: request.threadId,
      executionGenerationId: request.expectedExecutionGenerationId,
    }, BACKEND_TWO);
    expect(recovered).toMatchObject({
      state: "terminal",
      latestTurn: { state: "failed", terminal: true },
    });
    expect(recovered).not.toHaveProperty("threadId");
    expect(recovered?.latestTurn).not.toHaveProperty("turnId");
    await expect(restarted.assertQuiescent()).resolves.toBeUndefined();

    const afterBarrier = await storeFixture();
    const dispatched = absentTurn("prompt-barrier-op", "Crash after the durable prompt barrier.");
    await afterBarrier.store.admitTurn(dispatched, BACKEND_ONE);
    await afterBarrier.store.markTurnStartingThread(dispatched.operationId, BACKEND_ONE);
    await afterBarrier.store.bindThread(dispatched.operationId, "codex-prompt-barrier", BACKEND_ONE);
    await afterBarrier.store.markTurnPromptDispatching(dispatched.operationId, BACKEND_ONE);
    const afterBarrierRestart = new CodexSubscriptionStore({ statePath: afterBarrier.statePath });
    await expect(afterBarrierRestart.initialize()).resolves.toEqual([
      expect.objectContaining({
        operationId: dispatched.operationId,
        priorPhase: "dispatching",
        recoveredPhase: "uncertain",
      }),
    ]);
    const uncertain = await afterBarrierRestart.getConversation({
      hostId: HOST_ID,
      sourceThreadId: dispatched.threadId,
      executionGenerationId: dispatched.expectedExecutionGenerationId,
    }, BACKEND_TWO);
    expect(uncertain).toMatchObject({
      state: "uncertain",
      threadId: "codex-prompt-barrier",
      latestTurn: { state: "uncertain", terminal: true },
    });
    expect(uncertain?.latestTurn).not.toHaveProperty("turnId");
    await expect(afterBarrierRestart.assertQuiescent()).rejects.toMatchObject({ code: "CODEX_NOT_QUIESCENT" });
  });

  it("rejects an oversized state file before allocating or parsing its contents", async () => {
    const directory = await canonicalTemporaryDirectory("prime-codex-store-oversize-");
    temporaryDirectories.push(directory);
    const stateDirectory = join(directory, "codex");
    const statePath = join(stateDirectory, "state.json");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(statePath, Buffer.alloc(4_097, 0x20));
    const store = new CodexSubscriptionStore({ statePath, maxStateBytes: 4_096 });
    await expect(store.initialize()).rejects.toMatchObject({
      code: "CODEX_STATE_INVALID",
      message: "Codex subscription state could not be validated",
    });
  });

  it("never moves causal timestamps backward and revisions unrelated conversations when compaction changes them", async () => {
    const fixture = await storeFixture({ maxStateBytes: 9_000 });
    const firstB = await runCompleted(fixture.store, absentTurn("b-op-1", "b".repeat(2_000), "source-b"), BACKEND_ONE);
    const firstA = await runCompleted(fixture.store, absentTurn("a-op-1", "a".repeat(2_000), "source-a"), BACKEND_ONE);
    const bBefore = (await fixture.store.getConversation(firstB.binding, BACKEND_ONE))!;
    fixture.clock.value = Date.parse("2026-08-08T00:00:00.000Z");
    const secondARequest = presentTurn("a-op-2", firstA, "c".repeat(4_000));
    const admittedA = await fixture.store.admitTurn(secondARequest, BACKEND_ONE);
    expect(Date.parse(admittedA.snapshot.updatedAt)).toBeGreaterThanOrEqual(Date.parse(firstA.updatedAt));

    const bAfter = (await fixture.store.getConversation(firstB.binding, BACKEND_ONE))!;
    expect(bAfter.transcriptTruncated).toBe(true);
    expect(bAfter.revision).toBeGreaterThan(bBefore.revision);
    expect(Date.parse(bAfter.updatedAt)).toBeGreaterThanOrEqual(Date.parse(bBefore.updatedAt));
  });
});

async function storeFixture(overrides: Partial<CodexSubscriptionStoreOptions> = {}) {
  const directory = await canonicalTemporaryDirectory("prime-codex-store-");
  temporaryDirectories.push(directory);
  const statePath = join(directory, "codex", "state.json");
  const clock = {
    value: Date.parse("2026-08-09T12:00:00.000Z"),
    now() {
      const value = this.value;
      this.value += 1_000;
      return value;
    },
  };
  const store = new CodexSubscriptionStore({
    statePath,
    now: () => clock.now(),
    idFactory: sequentialIds("initial"),
    ...overrides,
  });
  await store.initialize();
  return { directory, statePath, store, clock };
}

function absentTurn(
  operationId: string,
  prompt: string,
  threadId = "source-thread-1",
): CodexSubscriptionTurnStartRequest {
  return {
    expectedHostId: HOST_ID,
    threadId,
    expectedExecutionGenerationId: `generation-${threadId}`,
    expectedBackendIncarnationId: BACKEND_ONE,
    expectedConversation: { state: "absent" },
    operationId,
    prompt,
  };
}

function presentTurn(
  operationId: string,
  snapshot: CodexSubscriptionConversationSnapshot,
  prompt: string,
): CodexSubscriptionTurnStartRequest {
  return {
    expectedHostId: snapshot.binding.hostId,
    threadId: snapshot.binding.sourceThreadId,
    expectedExecutionGenerationId: snapshot.binding.executionGenerationId,
    expectedBackendIncarnationId: snapshot.backendIncarnationId,
    expectedConversation: {
      state: "present",
      sessionId: snapshot.sessionId,
      revision: snapshot.revision,
      ...(snapshot.threadId ? { threadId: snapshot.threadId } : {}),
    },
    operationId,
    prompt,
  };
}

function interruptFor(
  operationId: string,
  snapshot: CodexSubscriptionConversationSnapshot,
): CodexSubscriptionTurnInterruptRequest {
  if (!snapshot.threadId || !snapshot.activeTurn?.turnId) throw new Error("Expected a running Codex turn");
  return {
    expectedHostId: snapshot.binding.hostId,
    threadId: snapshot.binding.sourceThreadId,
    expectedExecutionGenerationId: snapshot.binding.executionGenerationId,
    expectedBackendIncarnationId: snapshot.backendIncarnationId,
    sessionId: snapshot.sessionId,
    codexThreadId: snapshot.threadId,
    operationId,
    expectedTurnOperationId: snapshot.activeTurn.operationId,
    turnId: snapshot.activeTurn.turnId,
  };
}

async function startRunning(
  store: CodexSubscriptionStore,
  request: CodexSubscriptionTurnStartRequest,
  incarnation: string,
): Promise<CodexSubscriptionConversationSnapshot> {
  await store.admitTurn(request, incarnation);
  await store.markTurnStartingThread(request.operationId, incarnation);
  await store.bindThread(request.operationId, `codex-${request.threadId}`, incarnation);
  await store.markTurnPromptDispatching(request.operationId, incarnation);
  return store.bindTurn(request.operationId, `codex-${request.operationId}`, incarnation);
}

async function runCompleted(
  store: CodexSubscriptionStore,
  request: CodexSubscriptionTurnStartRequest,
  incarnation: string,
): Promise<CodexSubscriptionConversationSnapshot> {
  await startRunning(store, request, incarnation);
  return store.completeTurn(request.operationId, { state: "completed" }, incarnation);
}

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
