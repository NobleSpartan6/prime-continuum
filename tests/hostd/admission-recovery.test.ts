import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type CommandEnvelope } from "../../src/shared/protocol";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { type AdmissionFaultPoint, HostStore } from "../../src/hostd/store";

const temporaryDirectories: string[] = [];
const faultPoints: AdmissionFaultPoint[] = [
  "after_prepare",
  "after_snapshot",
  "after_threads",
  "after_command_identity",
  "after_receipt",
  "after_journal",
  "after_event",
];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("command admission crash recovery", () => {
  it.each(faultPoints)("recovers exact materialization after a crash at %s", async (faultPoint) => {
    const directory = await createSeededDirectory();
    const before = await baselineSnapshot(directory);
    const command = promptCommand(`recovery-${faultPoint}`);
    let injected = false;
    const crashing = new HostStore(directory, {
      admissionFaultInjector(point) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated crash at ${point}`);
        }
      },
    });
    await crashing.initialize();
    command.expectedHostId = (await crashing.getHost()).hostId;

    await expect(crashing.admitCommand(command, false)).rejects.toThrow(`simulated crash at ${faultPoint}`);
    const transaction = await readOnlyPendingTransaction(crashing);
    expect(transaction.command).toEqual(command);
    expect(transaction.snapshot).toBeDefined();
    const receiptShouldBeVisible = ["after_receipt", "after_journal", "after_event"].includes(faultPoint);
    expect((await readdir(crashing.paths.receipts)).filter((name) => name.endsWith(".json"))).toHaveLength(
      receiptShouldBeVisible ? 1 : 0,
    );
    if (receiptShouldBeVisible) {
      const snapshotOnDisk = await readJson(crashing.paths.snapshots, transaction.snapshot.thread.threadId);
      expect(snapshotOnDisk).toEqual(transaction.snapshot);
      const threadFile = JSON.parse(await readFile(crashing.paths.threads, "utf8")) as {
        threads: Array<{ threadId: string }>;
      };
      expect(threadFile.threads.find((thread) => thread.threadId === command.threadId)).toEqual(
        transaction.snapshot.thread,
      );
    }

    const recovered = new HostStore(directory);
    await recovered.initialize();
    const reconciliation = await recovered.reconcileCommands([command]);
    expect(reconciliation.unknown).toEqual([]);
    expect(reconciliation.receipts).toEqual([transaction.receipt]);

    const snapshot = await recovered.getThreadSnapshot(command.threadId);
    expect(snapshot.materializedRecentBlocks.some((block) => block.text === command.command.text)).toBe(false);
    expect(snapshot.materializedRecentBlocks).toEqual(before.materializedRecentBlocks);
    expect(snapshot.transcriptBlockIndex).toEqual(before.transcriptBlockIndex);
    expect(snapshot.latestCursor).toEqual(before.latestCursor);
    expect(snapshot.queueState.pendingCommandIds.filter((id) => id === command.commandId)).toHaveLength(1);
    expect(snapshot).toEqual(transaction.snapshot);
    const catalog = await recovered.getCatalogSnapshot();
    expect(catalog.threads.find((thread) => thread.threadId === command.threadId)).toEqual(snapshot.thread);

    const duplicate = await recovered.admitCommand(command, false);
    expect(duplicate).toEqual({ receipt: transaction.receipt, duplicate: true });

    const commandRecords = (await jsonLines(recovered.paths.commandJournal)).filter(
      (record) => record.commandId === command.commandId,
    );
    expect(commandRecords.map((record) => record.status)).toEqual(["received", "admitted"]);
    expect(commandRecords).toEqual(transaction.journalRecords);
    expect(new Set(commandRecords.map((record) => record.journalId)).size).toBe(2);
    const events = (await jsonLines(recovered.paths.eventJournal)).filter(
      (record) => record.type === "command.admitted" && record.threadId === command.threadId,
    );
    expect(events).toHaveLength(1);
    expect(events).toEqual([transaction.eventRecord]);
    expect(new Set(events.map((record) => record.eventId)).size).toBe(1);
    expect(await readdir(recovered.paths.transactions)).toEqual([]);
  });

  it("recovers a default-gateway rejection without changing the thread projection", async () => {
    const directory = await createSeededDirectory();
    const baselineStore = new HostStore(directory);
    await baselineStore.initialize();
    const before = await baselineStore.getThreadSnapshot("demo-thread");
    const command = promptCommand("default-gateway-rejection");
    let injected = false;
    const crashingStore = new HostStore(directory, {
      admissionFaultInjector(point) {
        if (!injected && point === "after_receipt") {
          injected = true;
          throw new Error("simulated rejected-receipt crash");
        }
      },
    });
    const service = new HostService(crashingStore);
    await service.initialize();
    command.expectedHostId = (await crashingStore.getHost()).hostId;

    const failedTransportAttempt = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "rejected-crash-request",
      method: "command.submit",
      payload: { command },
    }, TRUSTED_USER_SESSION);
    expect(failedTransportAttempt).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    const prepared = await readOnlyPendingTransaction(crashingStore);
    expect(prepared.receipt).toMatchObject({
      status: "rejected",
      error: { code: "GATEWAY_UNAVAILABLE", retryable: true },
    });
    expect(prepared.snapshot).toBeUndefined();

    const recoveredStore = new HostStore(directory);
    const recoveredService = new HostService(recoveredStore);
    await recoveredService.initialize();
    expect(await recoveredStore.getThreadSnapshot(command.threadId)).toEqual(before);
    expect((await recoveredStore.reconcileCommands([command])).receipts).toEqual([prepared.receipt]);

    const duplicateResponse = await recoveredService.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "rejected-duplicate-request",
      method: "command.submit",
      payload: { command },
    }, TRUSTED_USER_SESSION);
    expect(duplicateResponse).toMatchObject({ ok: true, result: prepared.receipt });
    const commandRecords = (await jsonLines(recoveredStore.paths.commandJournal)).filter(
      (record) => record.commandId === command.commandId,
    );
    expect(commandRecords.map((record) => record.status)).toEqual(["received", "rejected"]);
    const commandEvents = (await jsonLines(recoveredStore.paths.eventJournal)).filter(
      (record) => record.type === "command.admitted" && record.threadId === command.threadId,
    );
    expect(commandEvents).toEqual([]);
    expect(await readdir(recoveredStore.paths.transactions)).toEqual([]);
  });

  it("rejects a prepared v2 transaction copied from another host authority", async () => {
    const directory = await createSeededDirectory();
    const command: CommandEnvelope = {
      ...promptCommand("foreign-host-v2"),
      command: { kind: "abort", reason: "exercise host-bound recovery" },
    };
    let injected = false;
    const crashing = new HostStore(directory, {
      admissionFaultInjector(point) {
        if (!injected && point === "after_prepare") {
          injected = true;
          throw new Error("simulated crash after foreign-host preparation");
        }
      },
    });
    await crashing.initialize();
    command.expectedHostId = (await crashing.getHost()).hostId;
    await expect(crashing.admitCommand(command, true)).rejects.toThrow(
      "simulated crash after foreign-host preparation",
    );

    const names = (await readdir(crashing.paths.transactions)).filter((name) => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    const name = names[0];
    if (!name) throw new Error("pending admission transaction missing");
    const transactionPath = join(crashing.paths.transactions, name);
    const transaction = JSON.parse(await readFile(transactionPath, "utf8")) as Record<string, any>;
    transaction.command.expectedHostId = "foreign-host";
    transaction.commandIdentity.command.expectedHostId = "foreign-host";
    transaction.journalRecords[0].envelope.expectedHostId = "foreign-host";
    await writeFile(transactionPath, JSON.stringify(transaction), "utf8");

    const recovered = new HostStore(directory);
    await expect(recovered.initialize()).rejects.toMatchObject({
      code: "INVALID_ADMISSION_TRANSACTION",
    });
    expect(await readdir(recovered.paths.receipts)).toEqual([]);
    expect(await readdir(join(directory, "command-identities"))).toEqual([]);
    expect(await readdir(recovered.paths.transactions)).toEqual([name]);
  });
});

async function baselineSnapshot(directory: string) {
  const baseline = new HostStore(directory);
  await baseline.initialize();
  return baseline.getThreadSnapshot("demo-thread");
}

async function createSeededDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "prime-hostd-admission-recovery-"));
  temporaryDirectories.push(directory);
  const store = new HostStore(directory);
  await store.initialize({ seed: true });
  return directory;
}

function promptCommand(commandId: string): CommandEnvelope & { command: { kind: "prompt"; text: string } } {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "fault-device",
    commandId,
    expectedHostId: "host-test",
    threadId: "demo-thread",
    issuedAt: "2026-08-06T01:00:00.000Z",
    expectedExecutionGenerationId: "demo-execution-1",
    command: { kind: "prompt", text: `Materialize exactly once for ${commandId}.` },
  };
}

async function readOnlyPendingTransaction(store: HostStore): Promise<Record<string, any>> {
  const names = (await readdir(store.paths.transactions)).filter((name) => name.endsWith(".json"));
  expect(names).toHaveLength(1);
  const name = names[0];
  if (!name) throw new Error("pending admission transaction missing");
  return JSON.parse(await readFile(join(store.paths.transactions, name), "utf8")) as Record<string, any>;
}

async function jsonLines(path: string): Promise<Array<Record<string, any>>> {
  const body = await readFile(path, "utf8");
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

async function readJson(snapshotDirectory: string, threadId: string): Promise<Record<string, any>> {
  const names = (await readdir(snapshotDirectory)).filter((name) => name.endsWith(".json"));
  for (const name of names) {
    const value = JSON.parse(await readFile(join(snapshotDirectory, name), "utf8")) as Record<string, any>;
    const thread = value.thread as { threadId?: string } | undefined;
    if (thread?.threadId === threadId) return value;
  }
  throw new Error(`snapshot ${threadId} not found`);
}
