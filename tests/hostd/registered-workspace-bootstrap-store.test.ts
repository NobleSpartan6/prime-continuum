import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import {
  HostStore,
  type HostStoreOptions,
  type RegisteredWorkspaceThreadBootstrapInput,
} from "../../src/hostd/store";
import { bootstrapTestWorkspace, type TestWorkspaceFixture } from "./test-workspace-fixture";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("HostStore registered workspace bootstrap", () => {
  it("atomically creates an exact new thread without returning its private path", async () => {
    const fixture = await createFixture();
    const input = registeredInput(fixture);

    const first = await fixture.store.bootstrapRegisteredWorkspaceThread(input);
    const retry = await fixture.store.bootstrapRegisteredWorkspaceThread(input);

    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      phase: "committed",
      projectId: fixture.workspace.project.projectId,
      workspaceId: fixture.workspace.project.workspaceId,
      threadId: input.threadId,
      executionGenerationId: input.executionGenerationId,
    });
    expect(JSON.stringify(first)).not.toContain(fixture.workspace.workspaceDirectory);
    expect(JSON.stringify(first)).not.toMatch(/workspaceDirectory|referenceThreadId/);
    const catalog = await fixture.store.getCatalogSnapshot();
    expect(catalog.projects).toEqual([fixture.workspace.project]);
    expect(catalog.threads).toContainEqual(expect.objectContaining({
      threadId: input.threadId,
      projectIdentity: fixture.workspace.project.projectId,
      title: input.threadTitle,
    }));
    await expect(fixture.store.resolveWorkspaceDirectory(
      input.threadId,
      input.executionGenerationId,
    )).resolves.toBe(fixture.workspace.workspaceDirectory);
    await expect(fixture.store.getResidentLifecycleStatus(input.operationId)).resolves.toMatchObject({
      kind: "provision",
      operationId: input.operationId,
      phase: "prepared",
    });
  });

  it("never rebinds one lifecycle operation to a second durable reservation", async () => {
    const fixture = await createFixture();
    const input = registeredInput(fixture);
    await fixture.store.bootstrapRegisteredWorkspaceThread(input);

    await expect(fixture.store.bootstrapRegisteredWorkspaceThread({
      ...input,
      bootstrapOperationId: "registered-bootstrap-rebound",
      threadId: "registered-thread-rebound",
      executionGenerationId: "registered-execution-rebound",
    })).rejects.toMatchObject({ code: "REGISTERED_WORKSPACE_RESERVATION_REUSED" });
    expect((await fixture.store.getCatalogSnapshot()).threads).toHaveLength(2);
  });

  it("rejects stale and foreign donor authority before creating artifacts", async () => {
    const fixture = await createFixture();
    const input = registeredInput(fixture);

    await expect(fixture.store.bootstrapRegisteredWorkspaceThread({
      ...input,
      bootstrapOperationId: "registered-stale-bootstrap",
      operationId: "registered-stale-operation",
      referenceExecutionGenerationId: "stale-generation",
    })).rejects.toMatchObject({ code: "REGISTERED_WORKSPACE_REFERENCE_MISMATCH" });
    await expect(fixture.store.bootstrapRegisteredWorkspaceThread({
      ...input,
      bootstrapOperationId: "registered-foreign-bootstrap",
      operationId: "registered-foreign-operation",
      projectId: "foreign-project",
    })).rejects.toMatchObject({ code: "REGISTERED_WORKSPACE_PROJECT_MISMATCH" });
    expect((await fixture.store.getCatalogSnapshot()).threads).toHaveLength(1);
  });

  it("rejects saved-project divergence from the donor workspace", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.store.paths.projects, `${JSON.stringify({
      version: 1,
      projects: [{ ...fixture.workspace.project, workspaceId: "diverged-workspace" }],
    })}\n`, "utf8");

    await expect(fixture.store.bootstrapRegisteredWorkspaceThread(
      registeredInput(fixture),
    )).rejects.toMatchObject({ code: "REGISTERED_WORKSPACE_PROJECT_MISMATCH" });
  });

  it("rejects a registered canonical path replaced by another physical directory", async () => {
    const fixture = await createFixture();
    const replacement = join(fixture.directory, "replacement-workspace");
    await mkdir(replacement);
    await rm(fixture.workspace.workspaceDirectory, { recursive: true, force: true });
    await symlink(
      replacement,
      fixture.workspace.workspaceDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(fixture.store.bootstrapRegisteredWorkspaceThread(
      registeredInput(fixture),
    )).rejects.toMatchObject({ code: "REGISTERED_WORKSPACE_PATH_CHANGED" });
  });

  it("rejects active resident authority anywhere on the same canonical workspace", async () => {
    const fixture = await createFixture();
    await fixture.store.persistResidentSessionBinding(activeBinding(fixture));

    await expect(fixture.store.bootstrapRegisteredWorkspaceThread(
      registeredInput(fixture),
    )).rejects.toMatchObject({ code: "REGISTERED_WORKSPACE_RESIDENT_ACTIVE" });
  });

  it("rejects a nonterminal resident lifecycle anywhere on the same canonical workspace", async () => {
    const fixture = await createFixture();
    await fixture.store.prepareResidentProvision({
      operationId: "donor-lifecycle-operation",
      expectedHostId: fixture.workspace.hostId,
      projectId: fixture.workspace.project.projectId,
      workspaceId: fixture.workspace.project.workspaceId,
      threadId: fixture.workspace.thread.threadId,
      executionGenerationId: fixture.workspace.thread.currentLocation.executionGenerationId,
      requestDigest: "a".repeat(64),
    });

    await expect(fixture.store.bootstrapRegisteredWorkspaceThread(
      registeredInput(fixture),
    )).rejects.toMatchObject({ code: "REGISTERED_WORKSPACE_LIFECYCLE_IN_PROGRESS" });
  });

  it("compacts an exactly released registered bootstrap after its terminal lifecycle is fenced", async () => {
    const fixture = await createFixture();
    const input = registeredInput(fixture);
    await fixture.store.bootstrapRegisteredWorkspaceThread(input);
    const firstLifecycle = registeredLifecycleInput(input);
    const firstLease = await fixture.store.beginResidentOwnedCreate(firstLifecycle);
    await fixture.store.failResidentOwnedCreateBeforeEffect(firstLease);

    const successorLifecycle = {
      ...firstLifecycle,
      operationId: "registered-terminal-successor",
      requestDigest: "b".repeat(64),
    };
    await fixture.store.prepareResidentProvision(successorLifecycle);
    const successorLease = await fixture.store.beginResidentOwnedCreate(successorLifecycle);
    await fixture.store.failResidentOwnedCreateBeforeEffect(successorLease);

    expect(await fixture.store.getResidentLifecycleStatus(firstLifecycle.operationId)).toBeUndefined();
    expect(await registeredBootstrapRecord(fixture.store, firstLifecycle.operationId)).toBeUndefined();
    expect((await workspaceBootstrapEntries(fixture.store)).map(({ record }) => record.operationId))
      .toEqual(["donor-bootstrap"]);
    await expect(fixture.store.prepareResidentProvision(firstLifecycle)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
    });
    await expect(fixture.store.bootstrapRegisteredWorkspaceThread(input)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
    });

    const next = {
      ...input,
      bootstrapOperationId: "registered-after-retirement-bootstrap",
      operationId: "registered-after-retirement-operation",
      lifecycleRequestDigest: "c".repeat(64),
      threadId: "registered-after-retirement-thread",
      executionGenerationId: "registered-after-retirement-execution",
      threadTitle: "Resident after retirement",
    };
    await expect(fixture.store.bootstrapRegisteredWorkspaceThread(next)).resolves.toMatchObject({
      phase: "committed",
      threadId: next.threadId,
    });
    await expect(fixture.store.getResidentLifecycleStatus(next.operationId)).resolves.toMatchObject({
      phase: "prepared",
      operationId: next.operationId,
    });
  });

  it("does not release an orphaned reservation from Bloom membership without exact retirement proof", async () => {
    const fixture = await createFixture();
    const input = registeredInput(fixture);
    await fixture.store.bootstrapRegisteredWorkspaceThread(input);
    const [lifecycleName] = await readdir(fixture.store.paths.residentLifecycleOperations);
    if (!lifecycleName) throw new Error("registered lifecycle fixture is missing");
    await rm(join(fixture.store.paths.residentLifecycleOperations, lifecycleName));
    await forceRetiredBloomPositive(fixture.store, input.operationId);
    const restarted = new HostStore(fixture.store.paths.root);
    await restarted.initialize();
    expect(await restarted.getResidentLifecycleStatus(input.operationId)).toBeUndefined();
    expect(await registeredReservationRelease(restarted, input.operationId)).toBeUndefined();
    expect(await registeredBootstrapRecord(restarted, input.operationId)).toBeDefined();

    const next = {
      ...input,
      bootstrapOperationId: "registered-bloom-positive-bootstrap",
      operationId: "registered-bloom-positive-next-operation",
      lifecycleRequestDigest: "f".repeat(64),
      threadId: "registered-bloom-positive-thread",
      executionGenerationId: "registered-bloom-positive-execution",
    };
    expect(retiredFenceContains(next.operationId, retiredFenceBits(input.operationId))).toBe(false);
    await expect(restarted.bootstrapRegisteredWorkspaceThread(next)).rejects.toMatchObject({
      code: "REGISTERED_WORKSPACE_RESERVED",
    });
    expect((await restarted.getCatalogSnapshot()).threads).toHaveLength(2);
  });

  it.each([
    "after_retirement_prepare",
    "after_retirement_fence",
    "after_retirement_reservation_release",
    "before_retirement_bootstrap_compaction",
    "after_retirement_bootstrap_compaction",
  ] as const)("finishes interrupted registered retirement after %s and compacts only its bootstrap", async (faultPoint) => {
    let crashArmed = false;
    let retiringOperationId = "";
    const fixture = await createFixture({
      residentLifecycleFaultInjector(point, operationId) {
        if (crashArmed && point === faultPoint && operationId === retiringOperationId) {
          throw new Error(`simulated crash during registered lifecycle retirement at ${faultPoint}`);
        }
      },
    });
    const input = registeredInput(fixture);
    retiringOperationId = input.operationId;
    await fixture.store.bootstrapRegisteredWorkspaceThread(input);
    const lifecycle = registeredLifecycleInput(input);
    const lease = await fixture.store.beginResidentOwnedCreate(lifecycle);
    await fixture.store.failResidentOwnedCreateBeforeEffect(lease);

    crashArmed = true;
    await expect(fixture.store.prepareResidentProvision({
      ...lifecycle,
      operationId: "registered-retirement-interrupted-successor",
      requestDigest: "d".repeat(64),
    })).rejects.toThrow(`simulated crash during registered lifecycle retirement at ${faultPoint}`);
    const beforeRestart = await registeredBootstrapRecord(fixture.store, input.operationId);
    if (faultPoint === "after_retirement_reservation_release" ||
      faultPoint === "before_retirement_bootstrap_compaction") {
      expect(beforeRestart?.registeredWorkspaceReservationRelease).toEqual(
        expect.objectContaining({ retirementTransactionId: expect.any(String) }),
      );
    } else if (faultPoint === "after_retirement_bootstrap_compaction") {
      expect(beforeRestart).toBeUndefined();
    } else {
      expect(beforeRestart?.registeredWorkspaceReservationRelease).toBeUndefined();
    }

    const restarted = new HostStore(fixture.store.paths.root);
    await restarted.initialize();
    expect(await restarted.getResidentLifecycleStatus(input.operationId)).toBeUndefined();
    expect(await registeredBootstrapRecord(restarted, input.operationId)).toBeUndefined();
    expect((await workspaceBootstrapEntries(restarted)).map(({ record }) => record.operationId))
      .toEqual(["donor-bootstrap"]);
    await expect(restarted.prepareResidentProvision(lifecycle)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
    });
    await expect(restarted.bootstrapRegisteredWorkspaceThread(input)).rejects.toMatchObject({
      code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
    });

    const next = {
      ...input,
      bootstrapOperationId: "registered-after-interrupted-retirement-bootstrap",
      operationId: "registered-after-interrupted-retirement-operation",
      lifecycleRequestDigest: "e".repeat(64),
      threadId: "registered-after-interrupted-retirement-thread",
      executionGenerationId: "registered-after-interrupted-retirement-execution",
    };
    await expect(restarted.bootstrapRegisteredWorkspaceThread(next)).resolves.toMatchObject({
      phase: "committed",
      threadId: next.threadId,
    });
    await expect(restarted.getResidentLifecycleStatus(next.operationId)).resolves.toMatchObject({
      phase: "prepared",
      operationId: next.operationId,
    });
  });

  it("does not compact a registered bootstrap carrying a foreign release marker", async () => {
    let crashArmed = false;
    const fixture = await createFixture({
      residentLifecycleFaultInjector(point) {
        if (crashArmed && point === "after_retirement_prepare") {
          throw new Error("retain registered retirement for foreign marker fixture");
        }
      },
    });
    const input = registeredInput(fixture);
    await prepareRegisteredTerminal(fixture.store, input);
    crashArmed = true;
    await expect(fixture.store.prepareResidentProvision({
      ...registeredLifecycleInput(input),
      operationId: "registered-foreign-marker-successor",
      requestDigest: "9".repeat(64),
    })).rejects.toThrow("retain registered retirement for foreign marker fixture");

    const transaction = JSON.parse(await readFile(
      fixture.store.paths.residentLifecycleRetirement,
      "utf8",
    )) as { preparedAt: string };
    const entry = (await workspaceBootstrapEntries(fixture.store)).find(
      ({ record }) =>
        record.input?.registeredWorkspaceReservation?.lifecycleOperationId === input.operationId,
    );
    if (!entry) throw new Error("registered bootstrap fixture is missing");
    await writeFile(entry.path, `${JSON.stringify({
      ...entry.record,
      registeredWorkspaceReservationRelease: {
        retirementTransactionId: "resident-lifecycle-retirement-foreign",
        releasedAt: transaction.preparedAt,
      },
    })}\n`, "utf8");

    const restarted = new HostStore(fixture.store.paths.root);
    await restarted.initialize();
    await expect(restarted.listResidentSessionBindings()).rejects.toMatchObject({
      code: "RESIDENT_SUBSYSTEM_DEGRADED",
    });
    const retained = await registeredBootstrapRecord(restarted, input.operationId);
    expect(retained?.registeredWorkspaceReservationRelease).toEqual({
      retirementTransactionId: "resident-lifecycle-retirement-foreign",
      releasedAt: transaction.preparedAt,
    });
    expect((await workspaceBootstrapEntries(restarted)).map(({ record }) => record.operationId).sort())
      .toEqual(["donor-bootstrap", input.bootstrapOperationId].sort());
  });

  it("admits repeated registered bootstraps at a reduced bound by retiring the prior clean terminal", async () => {
    const bootstrapLimit = 2;
    const fixture = await createFixture({
      workspaceThreadBootstrapOperationLimit: bootstrapLimit,
    });
    const cycleCount = bootstrapLimit * 3;
    let previousInput: RegisteredWorkspaceThreadBootstrapInput | undefined;

    for (let index = 0; index < cycleCount; index += 1) {
      const digestNibble = ((index % 14) + 1).toString(16);
      const input: RegisteredWorkspaceThreadBootstrapInput = {
        ...registeredInput(fixture),
        bootstrapOperationId: `registered-bootstrap-cycle-${index}`,
        operationId: `registered-operation-cycle-${index}`,
        lifecycleRequestDigest: digestNibble.repeat(64),
        threadId: `registered-thread-cycle-${index}`,
        executionGenerationId: `registered-execution-cycle-${index}`,
        threadTitle: `Registered resident thread ${index}`,
      };
      await fixture.store.bootstrapRegisteredWorkspaceThread(input);
      if (previousInput) {
        expect(await registeredBootstrapRecord(fixture.store, previousInput.operationId)).toBeUndefined();
        await expect(fixture.store.bootstrapRegisteredWorkspaceThread(previousInput)).rejects.toMatchObject({
          code: "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
        });
      }
      expect((await workspaceBootstrapEntries(fixture.store)).map(({ record }) => record.operationId).sort())
        .toEqual(["donor-bootstrap", input.bootstrapOperationId].sort());

      const lifecycle = registeredLifecycleInput(input);
      const lease = await fixture.store.beginResidentOwnedCreate(lifecycle);
      await fixture.store.failResidentOwnedCreateBeforeEffect(lease);
      previousInput = input;
    }

    const restarted = new HostStore(fixture.store.paths.root, {
      workspaceThreadBootstrapOperationLimit: bootstrapLimit,
    });
    await restarted.initialize();
    const retainedBeforeNext = await workspaceBootstrapEntries(restarted);
    expect(retainedBeforeNext).toHaveLength(bootstrapLimit);
    expect(retainedBeforeNext.map(({ record }) => record.operationId).sort()).toEqual([
      "donor-bootstrap",
      previousInput!.bootstrapOperationId,
    ].sort());
    await expect(restarted.resolveWorkspaceDirectory(
      fixture.workspace.thread.threadId,
      fixture.workspace.thread.currentLocation.executionGenerationId,
    )).resolves.toBe(fixture.workspace.workspaceDirectory);

    const afterRestart: RegisteredWorkspaceThreadBootstrapInput = {
      ...registeredInput(fixture),
      bootstrapOperationId: "registered-bootstrap-after-bounded-restart",
      operationId: "registered-operation-after-bounded-restart",
      lifecycleRequestDigest: "f".repeat(64),
      threadId: "registered-thread-after-bounded-restart",
      executionGenerationId: "registered-execution-after-bounded-restart",
      threadTitle: "Registered resident after bounded restart",
    };
    await expect(restarted.bootstrapRegisteredWorkspaceThread(afterRestart)).resolves.toMatchObject({
      phase: "committed",
      threadId: afterRestart.threadId,
    });
    expect(await registeredBootstrapRecord(restarted, previousInput!.operationId)).toBeUndefined();
    expect((await workspaceBootstrapEntries(restarted)).map(({ record }) => record.operationId).sort())
      .toEqual(["donor-bootstrap", afterRestart.bootstrapOperationId].sort());
  });

  it("degrades resident authority for a retirement transaction with a forged deterministic identity", async () => {
    let crashArmed = false;
    const fixture = await createFixture({
      residentLifecycleFaultInjector(point) {
        if (crashArmed && point === "after_retirement_prepare") {
          throw new Error("retain malformed retirement identity fixture");
        }
      },
    });
    const input = registeredInput(fixture);
    await prepareRegisteredTerminal(fixture.store, input);
    crashArmed = true;
    await expect(fixture.store.prepareResidentProvision({
      ...registeredLifecycleInput(input),
      operationId: "registered-malformed-identity-successor",
      requestDigest: "1".repeat(64),
    })).rejects.toThrow("retain malformed retirement identity fixture");

    const transaction = JSON.parse(await readFile(
      fixture.store.paths.residentLifecycleRetirement,
      "utf8",
    )) as { transactionId: string };
    transaction.transactionId = "resident-lifecycle-retirement-forged";
    await writeFile(
      fixture.store.paths.residentLifecycleRetirement,
      `${JSON.stringify(transaction)}\n`,
      "utf8",
    );

    const restarted = new HostStore(fixture.store.paths.root);
    await restarted.initialize();
    await expect(restarted.listResidentSessionBindings()).rejects.toMatchObject({
      code: "RESIDENT_SUBSYSTEM_DEGRADED",
    });
    expect(await registeredReservationRelease(restarted, input.operationId)).toBeUndefined();
  });

  it("rejects a binding-free retirement transaction containing an unrelated completed provision", async () => {
    let crashArmed = false;
    const fixture = await createFixture({
      residentLifecycleFaultInjector(point) {
        if (crashArmed && point === "after_retirement_prepare") {
          throw new Error("retain malformed retirement members fixture");
        }
      },
    });
    const unrelated = {
      operationId: "unrelated-completed-provision",
      expectedHostId: fixture.workspace.hostId,
      projectId: fixture.workspace.project.projectId,
      workspaceId: fixture.workspace.project.workspaceId,
      threadId: fixture.workspace.thread.threadId,
      executionGenerationId: fixture.workspace.thread.currentLocation.executionGenerationId,
      requestDigest: "2".repeat(64),
    };
    await fixture.store.prepareResidentProvision(unrelated);
    const unrelatedLease = await fixture.store.beginResidentOwnedCreate(unrelated);
    await fixture.store.failResidentOwnedCreateBeforeEffect(unrelatedLease);

    const input = registeredInput(fixture);
    await prepareRegisteredTerminal(fixture.store, input);
    crashArmed = true;
    await expect(fixture.store.prepareResidentProvision({
      ...registeredLifecycleInput(input),
      operationId: "registered-malformed-members-successor",
      requestDigest: "3".repeat(64),
    })).rejects.toThrow("retain malformed retirement members fixture");

    const transaction = JSON.parse(await readFile(
      fixture.store.paths.residentLifecycleRetirement,
      "utf8",
    )) as { transactionId: string; operations: Array<{ operationId: string }> };
    const unrelatedRecord = (await residentLifecycleRecords(fixture.store)).find(
      (record) => record.operationId === unrelated.operationId,
    );
    if (!unrelatedRecord) throw new Error("unrelated terminal lifecycle record is missing");
    transaction.operations.push(unrelatedRecord);
    transaction.transactionId = testDeterministicId(
      "resident-lifecycle-retirement",
      ...transaction.operations.map((operation) => operation.operationId).sort(),
    );
    await writeFile(
      fixture.store.paths.residentLifecycleRetirement,
      `${JSON.stringify(transaction)}\n`,
      "utf8",
    );

    const restarted = new HostStore(fixture.store.paths.root);
    await restarted.initialize();
    await expect(restarted.listResidentSessionBindings()).rejects.toMatchObject({
      code: "RESIDENT_SUBSYSTEM_DEGRADED",
    });
    expect(await registeredReservationRelease(restarted, input.operationId)).toBeUndefined();
  });
});

interface Fixture {
  directory: string;
  store: HostStore;
  workspace: TestWorkspaceFixture;
}

async function createFixture(options: HostStoreOptions = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "prime-registered-workspace-store-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const workspaceDirectory = await realpath(workspacePath);
  const store = new HostStore(join(directory, "data"), options);
  await store.initialize();
  const workspace = await bootstrapTestWorkspace(store, {
    operationId: "donor-bootstrap",
    workspaceDirectory,
    projectId: "saved-project",
    workspaceId: "saved-workspace",
    threadId: "saved-thread",
    executionGenerationId: "saved-execution",
    projectDisplayName: "Saved project",
    threadTitle: "Saved reference thread",
  });
  return { directory, store, workspace };
}

function registeredInput(fixture: Fixture): RegisteredWorkspaceThreadBootstrapInput {
  return {
    bootstrapOperationId: "registered-bootstrap",
    lifecycleRequestDigest: "a".repeat(64),
    expectedHostId: fixture.workspace.hostId,
    operationId: "registered-operation",
    projectId: fixture.workspace.project.projectId,
    workspaceId: fixture.workspace.project.workspaceId,
    referenceThreadId: fixture.workspace.thread.threadId,
    referenceExecutionGenerationId: fixture.workspace.thread.currentLocation.executionGenerationId,
    threadId: "registered-thread",
    executionGenerationId: "registered-execution",
    threadTitle: "Registered resident thread",
    createdAt: "2026-08-08T13:00:00.000Z",
    sessionName: "Registered resident",
  };
}

function registeredLifecycleInput(input: RegisteredWorkspaceThreadBootstrapInput) {
  return {
    operationId: input.operationId,
    expectedHostId: input.expectedHostId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    executionGenerationId: input.executionGenerationId,
    requestDigest: input.lifecycleRequestDigest,
  };
}

async function prepareRegisteredTerminal(
  store: HostStore,
  input: RegisteredWorkspaceThreadBootstrapInput,
): Promise<void> {
  await store.bootstrapRegisteredWorkspaceThread(input);
  const lifecycle = registeredLifecycleInput(input);
  const lease = await store.beginResidentOwnedCreate(lifecycle);
  await store.failResidentOwnedCreateBeforeEffect(lease);
}

async function residentLifecycleRecords(
  store: HostStore,
): Promise<Array<Record<string, unknown> & { operationId: string }>> {
  const records: Array<Record<string, unknown> & { operationId: string }> = [];
  for (const name of await readdir(store.paths.residentLifecycleOperations)) {
    const record = JSON.parse(await readFile(
      join(store.paths.residentLifecycleOperations, name),
      "utf8",
    )) as Record<string, unknown>;
    if (typeof record.operationId !== "string") throw new Error("lifecycle operation identity is missing");
    records.push({ ...record, operationId: record.operationId });
  }
  return records;
}

function testDeterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 48)}`;
}

const TEST_RETIRED_FENCE_BIT_COUNT = 1 << 20;
const TEST_RETIRED_FENCE_HASH_COUNT = 7;

function retiredFenceBits(operationId: string): Buffer {
  const bits = Buffer.alloc(TEST_RETIRED_FENCE_BIT_COUNT / 8);
  for (const bitIndex of retiredFenceIndexes(`operation:${operationId}`)) {
    bits[Math.floor(bitIndex / 8)]! |= 1 << (bitIndex % 8);
  }
  return bits;
}

function retiredFenceContains(operationId: string, bits: Buffer): boolean {
  return retiredFenceIndexes(`operation:${operationId}`).every(
    (bitIndex) => (bits[Math.floor(bitIndex / 8)]! & (1 << (bitIndex % 8))) !== 0,
  );
}

function retiredFenceIndexes(key: string): number[] {
  const digest = createHash("sha256")
    .update("prime-resident-lifecycle-retired-v1\0")
    .update(key)
    .digest();
  return Array.from({ length: TEST_RETIRED_FENCE_HASH_COUNT }, (_, index) =>
    digest.readUInt32BE(index * 4) % TEST_RETIRED_FENCE_BIT_COUNT,
  );
}

async function forceRetiredBloomPositive(store: HostStore, operationId: string): Promise<void> {
  const bits = retiredFenceBits(operationId);
  await writeFile(store.paths.residentLifecycleRetiredFence, `${JSON.stringify({
    version: 1,
    bitCount: TEST_RETIRED_FENCE_BIT_COUNT,
    hashCount: TEST_RETIRED_FENCE_HASH_COUNT,
    retiredKeyCount: 0,
    bits: bits.toString("base64"),
  })}\n`, "utf8");
}

async function registeredReservationRelease(
  store: HostStore,
  lifecycleOperationId: string,
): Promise<{ retirementTransactionId: string; releasedAt: string } | undefined> {
  return (await registeredBootstrapRecord(store, lifecycleOperationId))
    ?.registeredWorkspaceReservationRelease;
}

interface WorkspaceBootstrapTestRecord extends Record<string, unknown> {
  operationId: string;
  input?: {
    registeredWorkspaceReservation?: { lifecycleOperationId?: string };
  };
  registeredWorkspaceReservationRelease?: {
    retirementTransactionId: string;
    releasedAt: string;
  };
}

async function workspaceBootstrapEntries(
  store: HostStore,
): Promise<Array<{ path: string; record: WorkspaceBootstrapTestRecord }>> {
  const entries: Array<{ path: string; record: WorkspaceBootstrapTestRecord }> = [];
  for (const name of await readdir(store.paths.workspaceThreadBootstrapOperations)) {
    const path = join(store.paths.workspaceThreadBootstrapOperations, name);
    const record = JSON.parse(await readFile(path, "utf8")) as WorkspaceBootstrapTestRecord;
    if (typeof record.operationId !== "string") {
      throw new Error("workspace bootstrap operation identity is missing");
    }
    entries.push({ path, record });
  }
  return entries.sort((left, right) => left.record.operationId.localeCompare(right.record.operationId));
}

async function registeredBootstrapRecord(
  store: HostStore,
  lifecycleOperationId: string,
): Promise<WorkspaceBootstrapTestRecord | undefined> {
  return (await workspaceBootstrapEntries(store)).find(
    ({ record }) =>
      record.input?.registeredWorkspaceReservation?.lifecycleOperationId === lifecycleOperationId,
  )?.record;
}

function activeBinding(fixture: Fixture): ResidentSessionBinding {
  return {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId: fixture.workspace.thread.threadId,
    executionGenerationId: fixture.workspace.thread.currentLocation.executionGenerationId,
    workspaceDirectory: fixture.workspace.workspaceDirectory,
    activeSessionId: "saved-active-session",
    sessionId: "saved-session",
    sessionFile: join(fixture.workspace.workspaceDirectory, ".prime-agent", "saved-session.jsonl"),
    boundAt: "2026-08-08T12:30:00.000Z",
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
