import { bootstrapTestWorkspace } from "./test-workspace-fixture";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type CommandPayload,
} from "../../src/shared/protocol";
import type { PrimeAgentGateway } from "../../src/hostd/gateway";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const commandCases: ReadonlyArray<readonly [string, CommandPayload]> = [
  ["prompt", { kind: "prompt", text: "Start the task." }],
  ["steer", { kind: "steer", text: "Take the safer path." }],
  ["follow-up", { kind: "follow_up", text: "Continue with tests." }],
  ["abort", { kind: "abort", reason: "Stop this generation." }],
  [
    "approval",
    { kind: "approval.resolve", approvalId: "approval-generation-fence", decision: "reject" },
  ],
  ["model", { kind: "model.select", providerId: "openai", modelId: "gpt-5.6-sol" }],
];

describe("exact execution-generation fencing", () => {
  it.each(commandCases)("rejects stale %s commands and binds the receipt to the composed generation", async (label, payload) => {
    const { store, hostId } = await workspaceStore();
    const command = envelope(hostId, `stale-${label}`, payload, "stale-generation-g1");

    const first = await store.admitCommand(command, true);
    expect(first.receipt).toMatchObject({
      status: "rejected",
      executionGenerationId: "stale-generation-g1",
      error: { code: "STALE_EXECUTION_GENERATION" },
    });
    expect(await store.admitCommand(command, true)).toEqual({ receipt: first.receipt, duplicate: true });

    await expect(
      store.admitCommand(
        { ...command, expectedExecutionGenerationId: "test-execution-1" },
        true,
      ),
    ).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
  });

  it("proves the complete envelope for duplicate submit and reconcile before and after restart", async () => {
    const { store, directory, hostId } = await workspaceStore();
    const command = envelope(hostId, "exact-envelope", { kind: "prompt", text: "Inspect the repository." });
    const first = await store.admitCommand(command, false);
    const terminal = await store.updateCommandReceipt(command, {
      status: "completed",
      queuePosition: undefined,
      message: "Completed for exact-envelope verification",
    });

    expect(first.receipt.status).toBe("admitted");
    expect(await store.admitCommand(command, false)).toEqual({ receipt: terminal, duplicate: true });
    await expect(
      store.admitCommand({ ...command, command: { kind: "prompt", text: "Changed payload." } }, false),
    ).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
    await expect(
      store.admitCommand({ ...command, issuedAt: "2026-08-07T12:00:01.000Z" }, false),
    ).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
    await expect(
      store.admitCommand({ ...command, expectedExecutionGenerationId: "generation-g2" }, false),
    ).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });

    const restarted = new HostStore(directory);
    await restarted.initialize();
    expect((await restarted.reconcileCommands([command])).receipts).toEqual([terminal]);
    await expect(
      restarted.reconcileCommands([
        { ...command, command: { kind: "prompt", text: "Changed after restart." } },
      ]),
    ).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
    await expect(
      restarted.reconcileCommands([{ ...command, issuedAt: "2026-08-07T12:00:02.000Z" }]),
    ).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
    await expect(
      restarted.reconcileCommands([{ ...command, expectedExecutionGenerationId: "generation-g2" }]),
    ).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
  });

  it("passes only the command's explicit generation to the gateway live check", async () => {
    const { store, hostId } = await workspaceStore();
    const isLive = vi.fn(async () => false);
    const gateway: PrimeAgentGateway = {
      continuity: "resident",
      isLive,
      async submit() {
        throw new Error("stale command must not dispatch");
      },
      async close() {},
    };
    const service = new HostService(store, gateway);
    await service.initialize();
    const command = envelope(
      hostId,
      "service-generation-fence",
      { kind: "prompt", text: "Do not retarget this command." },
      "stale-generation-g1",
    );

    const response = await service.handle(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "service-generation-fence-request",
        method: "command.submit",
        payload: { command },
      },
      TRUSTED_USER_SESSION,
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        status: "rejected",
        executionGenerationId: "stale-generation-g1",
        error: { code: "STALE_EXECUTION_GENERATION" },
      },
    });
    expect(isLive).toHaveBeenCalledWith("test-thread", "stale-generation-g1");
    await service.close();
  });

  it("resolves exact known retries before changed gateway state, including after restart", async () => {
    const { store, directory, hostId } = await workspaceStore();
    const command = envelope(hostId, "known-before-gateway", {
      kind: "prompt",
      text: "Persist this exact command once.",
    });
    const first = await store.admitCommand(command, false);
    const journalBefore = await readFile(store.paths.commandJournal, "utf8");

    const isLive = vi.fn(async () => {
      throw new Error("changed gateway state must not obscure a known command");
    });
    const submit = vi.fn<PrimeAgentGateway["submit"]>();
    const gateway: PrimeAgentGateway = {
      continuity: "resident",
      isLive,
      submit,
      async close() {},
    };
    const restarted = new HostStore(directory);
    const service = new HostService(restarted, gateway);
    await service.initialize();

    const exact = await service.handle(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "known-exact-retry",
        method: "command.submit",
        payload: { command },
      },
      TRUSTED_USER_SESSION,
    );
    expect(exact).toMatchObject({
      ok: true,
      result: { receiptId: first.receipt.receiptId, status: first.receipt.status },
    });

    const changed = await service.handle(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "known-changed-retry",
        method: "command.submit",
        payload: {
          command: { ...command, command: { kind: "prompt", text: "Changed payload under the same key." } },
        },
      },
      TRUSTED_USER_SESSION,
    );
    expect(changed).toMatchObject({ ok: false, error: { code: "COMMAND_ID_REUSED" } });
    expect(isLive).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(await readFile(store.paths.commandJournal, "utf8")).toBe(journalBefore);
    await service.close();
  });

  it("does not mutate a snapshot whose authority diverges from the matching catalog generation", async () => {
    const { store, hostId } = await workspaceStore();
    const snapshotName = (await readdir(store.paths.snapshots)).find((name) => name.endsWith(".json"));
    if (!snapshotName) throw new Error("seed snapshot missing");
    const snapshotPath = join(store.paths.snapshots, snapshotName);
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<string, any>;
    snapshot.thread.currentLocation.executionGenerationId = "corrupt-snapshot-generation";
    snapshot.thread.lastKnownCursor.executionGenerationId = "corrupt-snapshot-generation";
    snapshot.latestCursor.executionGenerationId = "corrupt-snapshot-generation";
    await writeJson(snapshotPath, snapshot);

    const command = envelope(hostId, "snapshot-authority-mismatch", {
      kind: "prompt",
      text: "Do not apply this to a divergent snapshot.",
    });
    const admission = await store.admitCommand(command, false);
    expect(admission.receipt).toMatchObject({
      status: "rejected",
      executionGenerationId: "test-execution-1",
      error: { code: "SNAPSHOT_AUTHORITY_MISMATCH" },
    });
    expect((await store.getThreadSnapshot(command.threadId)).queueState.pendingCommandIds).not.toContain(
      command.commandId,
    );
  });

  it("never lets an old model-only identity be overwritten by a different command kind", async () => {
    const { store, directory, hostId } = await workspaceStore();
    const model = envelope(
      hostId,
      "legacy-model-identity",
      { kind: "model.select", providerId: "openai", modelId: "gpt-5.6-sol" },
      "stale-generation-g1",
    );
    await store.admitCommand(model, true);
    await removeOnlyJson(join(directory, "command-identities"));
    await removeOnlyJson(store.paths.receipts);

    const restarted = new HostStore(directory);
    await restarted.initialize();
    await expect(
      restarted.admitCommand(
        { ...model, command: { kind: "prompt", text: "Attempt to overwrite old model identity." } },
        false,
      ),
    ).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
    await expect(restarted.admitCommand(model, true)).rejects.toMatchObject({ code: "COMMAND_IDENTITY_ORPHANED" });
  });
});

describe("legacy admission recovery", () => {
  it("finishes a validated generation-less v1 transaction but never makes it replayable", async () => {
    const { store, directory, hostId } = await workspaceStore();
    const command = envelope(hostId, "legacy-generationless", {
      kind: "prompt",
      text: "Recover prepared host records only.",
    });
    const crashing = await crashAfterPrepare(directory, command);
    await rewritePendingTransaction(crashing, (transaction) => {
      transaction.version = 1;
      delete transaction.commandIdentity;
      delete transaction.command.expectedExecutionGenerationId;
      delete transaction.journalRecords[0].envelope.expectedExecutionGenerationId;
    });

    const recovered = new HostStore(directory);
    await recovered.initialize();
    const snapshot = await recovered.getThreadSnapshot(command.threadId);
    expect(snapshot.queueState.pendingCommandIds).toContain(command.commandId);
    expect(await readdir(recovered.paths.transactions)).toEqual([]);
    expect(await readdir(join(directory, "command-identities"))).toEqual([]);
    await expect(recovered.reconcileCommands([command])).rejects.toMatchObject({
      code: "COMMAND_IDENTITY_UNVERIFIABLE",
    });
    await expect(recovered.admitCommand(command, false)).rejects.toMatchObject({
      code: "COMMAND_IDENTITY_UNVERIFIABLE",
    });
    await expect(
      recovered.admitCommand(
        { ...command, command: { kind: "prompt", text: "Changed content must remain reserved after migration." } },
        false,
      ),
    ).rejects.toMatchObject({ code: "COMMAND_IDENTITY_UNVERIFIABLE" });

    const restarted = new HostStore(directory);
    await restarted.initialize();
    await expect(
      restarted.admitCommand(
        { ...command, command: { kind: "abort", reason: "A different command kind cannot reuse this legacy key." } },
        false,
      ),
    ).rejects.toMatchObject({ code: "COMMAND_IDENTITY_UNVERIFIABLE" });
  });

  it("recovers the old stale-rejection receipt shape without rebinding or replaying it", async () => {
    const { directory, hostId } = await workspaceStore();
    const command = envelope(
      hostId,
      "legacy-stale-rejection",
      { kind: "abort", reason: "Old generation." },
      "stale-generation-g1",
    );
    const crashing = await crashAfterPrepare(directory, command);
    await rewritePendingTransaction(crashing, (transaction) => {
      transaction.version = 1;
      delete transaction.commandIdentity;
      // The pre-fence host reported the current generation on a stale G1
      // rejection. Recovery accepts that exact historical shape only.
      transaction.receipt.executionGenerationId = "test-execution-1";
    });

    const recovered = new HostStore(directory);
    await recovered.initialize();
    await expect(recovered.reconcileCommands([command])).rejects.toMatchObject({
      code: "COMMAND_IDENTITY_UNVERIFIABLE",
    });
    await expect(recovered.admitCommand(command, true)).rejects.toMatchObject({
      code: "COMMAND_IDENTITY_UNVERIFIABLE",
    });
  });

  it("fails closed when a legacy transaction tampers with an unrelated catalog thread", async () => {
    const { store, directory, hostId } = await workspaceStore();
    const threadFile = JSON.parse(await readFile(store.paths.threads, "utf8")) as Record<string, any>;
    const unrelated = structuredClone(threadFile.threads[0]);
    unrelated.threadId = "unrelated-thread";
    unrelated.title = "Unrelated durable thread";
    unrelated.lastKnownCursor = {
      ...unrelated.lastKnownCursor,
      threadId: unrelated.threadId,
    };
    threadFile.threads.push(unrelated);
    await writeJson(store.paths.threads, threadFile);

    const command = envelope(hostId, "legacy-unrelated-tamper", {
      kind: "prompt",
      text: "Do not mutate another thread.",
    });
    const crashing = await crashAfterPrepare(directory, command);
    await rewritePendingTransaction(crashing, (transaction) => {
      transaction.version = 1;
      delete transaction.commandIdentity;
      delete transaction.command.expectedExecutionGenerationId;
      delete transaction.journalRecords[0].envelope.expectedExecutionGenerationId;
      const preparedUnrelated = transaction.threadsFile.threads.find(
        (thread: Record<string, any>) => thread.threadId === "unrelated-thread",
      );
      preparedUnrelated.recap = "Tampered unrelated state";
    });

    const recovered = new HostStore(directory);
    await expect(recovered.initialize()).rejects.toMatchObject({
      code: "INVALID_ADMISSION_TRANSACTION_CATALOG",
    });
    expect((await readdir(recovered.paths.transactions)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("fails closed when a v2 transaction tampers with an unrelated catalog thread", async () => {
    const { store, directory, hostId } = await workspaceStore();
    const threadFile = JSON.parse(await readFile(store.paths.threads, "utf8")) as Record<string, any>;
    const unrelated = structuredClone(threadFile.threads[0]);
    unrelated.threadId = "unrelated-v2-thread";
    unrelated.title = "Unrelated v2 durable thread";
    unrelated.lastKnownCursor = { ...unrelated.lastKnownCursor, threadId: unrelated.threadId };
    threadFile.threads.push(unrelated);
    await writeJson(store.paths.threads, threadFile);

    const command = envelope(hostId, "v2-unrelated-tamper", {
      kind: "prompt",
      text: "Recover only the target thread.",
    });
    const crashing = await crashAfterPrepare(directory, command);
    await rewritePendingTransaction(crashing, (transaction) => {
      const preparedUnrelated = transaction.threadsFile.threads.find(
        (thread: Record<string, any>) => thread.threadId === "unrelated-v2-thread",
      );
      preparedUnrelated.recap = "Tampered v2 unrelated state";
    });

    const recovered = new HostStore(directory);
    await expect(recovered.initialize()).rejects.toMatchObject({
      code: "INVALID_ADMISSION_TRANSACTION_CATALOG",
    });
    expect((await readdir(recovered.paths.transactions)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });
});

async function workspaceStore(): Promise<{ store: HostStore; directory: string; hostId: string }> {
  const directory = await mkdtemp(join(tmpdir(), "prime-generation-fence-"));
  temporaryDirectories.push(directory);
  const store = new HostStore(directory);
  await store.initialize();
  await bootstrapTestWorkspace(store);
  return { store, directory, hostId: (await store.getHost()).hostId };
}

function envelope(
  hostId: string,
  commandId: string,
  command: CommandPayload,
  expectedExecutionGenerationId = "test-execution-1",
): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "generation-fence-device",
    commandId,
    expectedHostId: hostId,
    threadId: "test-thread",
    issuedAt: "2026-08-07T12:00:00.000Z",
    expectedExecutionGenerationId,
    command,
  };
}

async function crashAfterPrepare(directory: string, command: CommandEnvelope): Promise<HostStore> {
  let injected = false;
  const crashing = new HostStore(directory, {
    admissionFaultInjector(point) {
      if (!injected && point === "after_prepare") {
        injected = true;
        throw new Error("simulated crash after prepare");
      }
    },
  });
  await crashing.initialize();
  await expect(crashing.admitCommand(command, false)).rejects.toThrow("simulated crash after prepare");
  return crashing;
}

async function rewritePendingTransaction(
  store: HostStore,
  mutate: (transaction: Record<string, any>) => void,
): Promise<void> {
  const names = (await readdir(store.paths.transactions)).filter((name) => name.endsWith(".json"));
  expect(names).toHaveLength(1);
  const path = join(store.paths.transactions, names[0] as string);
  const transaction = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  mutate(transaction);
  await writeJson(path, transaction);
}

async function removeOnlyJson(directory: string): Promise<void> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  expect(names).toHaveLength(1);
  await rm(join(directory, names[0] as string));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "w" });
}
