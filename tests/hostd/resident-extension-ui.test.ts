import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWriteJson } from "../../src/hostd/atomic-files";
import { GatewayError, type GatewayDispatchContext, type PrimeAgentGateway } from "../../src/hostd/gateway";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { HostStore, HostStoreError } from "../../src/hostd/store";
import { residentDispatchAuthorityFingerprint } from "../../src/hostd/store";
import { RESIDENT_EXTENSION_UI_CAPABILITY } from "../../src/shared/capabilities";
import {
  PROTOCOL_VERSION,
  ThreadProjectionSnapshotSchema,
  type CommandEnvelope,
  type ResidentExtensionUiRequest,
} from "../../src/shared/protocol";
import { bootstrapTestWorkspace } from "./test-workspace-fixture";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HostStore resident extension UI response journal", () => {
  it("persists a one-way response boundary and completes one exact command once", async () => {
    const fixture = await createFixture();
    const command = responseCommand(fixture.hostId, "extension-response-success");
    const before = await fixture.store.getThreadSnapshot(command.threadId);

    expect(await fixture.store.admitCommand(command, true)).toMatchObject({
      duplicate: false,
      receipt: { status: "admitted", queuePosition: undefined },
    });
    expect(await fixture.store.getThreadSnapshot(command.threadId)).toEqual(before);
    expect(await responseAttemptNames(fixture.store)).toHaveLength(1);

    const lease = await fixture.store.beginExtensionUiResponseDispatch(command);
    expect((await fixture.store.reconcileCommands([command])).receipts[0]).toMatchObject({ status: "running" });
    const completed = await fixture.store.finalizeExtensionUiResponseDispatch(lease, {
      status: "completed",
      message: "Prime Agent acknowledged the dialog response",
    });
    expect(completed).toMatchObject({ status: "completed" });
    expect(await responseAttemptNames(fixture.store)).toEqual([]);

    expect(await fixture.store.admitCommand(command, true)).toEqual({ receipt: completed, duplicate: true });
    if (command.command.kind !== "extension_ui.respond") throw new Error("response command fixture invalid");
    await expectStoreError(
      fixture.store.admitCommand({
        ...command,
        command: { ...command.command, response: { kind: "value", value: "B" } },
      }, true),
      "COMMAND_ID_REUSED",
    );
    expect(await commandStatuses(fixture.store, command.commandId)).toEqual([
      "received",
      "admitted",
      "running",
      "completed",
    ]);
  });

  it("never replays admitted or dispatching response attempts after host restart", async () => {
    const admittedFixture = await createFixture();
    const admitted = responseCommand(admittedFixture.hostId, "extension-response-restart-admitted");
    await admittedFixture.store.admitCommand(admitted, true);
    const restartedAdmitted = new HostStore(admittedFixture.directory);
    await restartedAdmitted.initialize();
    expect((await restartedAdmitted.reconcileCommands([admitted])).receipts[0]).toMatchObject({
      status: "failed",
      error: { code: "EXTENSION_UI_RESPONSE_NOT_DISPATCHED", retryable: false },
    });
    expect(await responseAttemptNames(restartedAdmitted)).toEqual([]);

    const dispatchFixture = await createFixture();
    const dispatching = responseCommand(dispatchFixture.hostId, "extension-response-restart-dispatching");
    await dispatchFixture.store.admitCommand(dispatching, true);
    await dispatchFixture.store.beginExtensionUiResponseDispatch(dispatching);
    const restartedDispatching = new HostStore(dispatchFixture.directory);
    await restartedDispatching.initialize();
    expect((await restartedDispatching.reconcileCommands([dispatching])).receipts[0]).toMatchObject({
      status: "uncertain",
      error: { code: "EXTENSION_UI_RESPONSE_RESTART_UNCERTAIN", retryable: false },
    });
    expect(await responseAttemptNames(restartedDispatching)).toEqual([]);
  });

  it("converges a crash between the dispatch marker and running receipt as uncertain", async () => {
    const fixture = await createFixture();
    const command = responseCommand(fixture.hostId, "extension-response-split-boundary");
    const admitted = (await fixture.store.admitCommand(command, true)).receipt;
    await fixture.store.beginExtensionUiResponseDispatch(command);
    const [receiptName] = (await readdir(fixture.store.paths.receipts)).filter((name) => name.endsWith(".json"));
    if (!receiptName) throw new Error("extension response receipt fixture missing");
    await atomicWriteJson(join(fixture.store.paths.receipts, receiptName), admitted);

    const restarted = new HostStore(fixture.directory);
    await restarted.initialize();
    expect((await restarted.reconcileCommands([command])).receipts[0]).toMatchObject({
      status: "uncertain",
      error: { retryable: false },
    });
    expect(await commandStatuses(restarted, command.commandId)).toEqual([
      "received",
      "admitted",
      "running",
      "uncertain",
    ]);
  });

  it("reconstructs terminal journals before retiring crash-left response attempts", async () => {
    const completedFixture = await createFixture();
    const completedCommand = responseCommand(completedFixture.hostId, "extension-response-terminal-completed");
    await completedFixture.store.admitCommand(completedCommand, true);
    await completedFixture.store.beginExtensionUiResponseDispatch(completedCommand);
    const [completedReceiptName] = (await readdir(completedFixture.store.paths.receipts)).filter((name) => name.endsWith(".json"));
    if (!completedReceiptName) throw new Error("completed response receipt fixture missing");
    const running = JSON.parse(
      await readFile(join(completedFixture.store.paths.receipts, completedReceiptName), "utf8"),
    ) as Record<string, unknown>;
    await atomicWriteJson(join(completedFixture.store.paths.receipts, completedReceiptName), {
      ...running,
      status: "completed",
      message: "acknowledged before crash",
      updatedAt: "2026-08-12T14:02:00.000Z",
    });
    const completedRestart = new HostStore(completedFixture.directory);
    await completedRestart.initialize();
    expect(await responseAttemptNames(completedRestart)).toEqual([]);
    expect(await commandStatuses(completedRestart, completedCommand.commandId)).toContain("completed");

    const failedFixture = await createFixture();
    const failedCommand = responseCommand(failedFixture.hostId, "extension-response-terminal-failed");
    await failedFixture.store.admitCommand(failedCommand, true);
    const [failedReceiptName] = (await readdir(failedFixture.store.paths.receipts)).filter((name) => name.endsWith(".json"));
    if (!failedReceiptName) throw new Error("failed response receipt fixture missing");
    const admitted = JSON.parse(
      await readFile(join(failedFixture.store.paths.receipts, failedReceiptName), "utf8"),
    ) as Record<string, unknown>;
    await atomicWriteJson(join(failedFixture.store.paths.receipts, failedReceiptName), {
      ...admitted,
      status: "failed",
      queuePosition: undefined,
      error: { code: "DISPATCH_NOT_STARTED", message: "dispatch did not start", retryable: false },
      updatedAt: "2026-08-12T14:02:00.000Z",
    });
    const failedRestart = new HostStore(failedFixture.directory);
    await failedRestart.initialize();
    expect(await responseAttemptNames(failedRestart)).toEqual([]);
    expect(await commandStatuses(failedRestart, failedCommand.commandId)).toContain("failed");
  });

  it("admits only one nonterminal owner for an exact live dialog", async () => {
    const fixture = await createFixture();
    const first = responseCommand(fixture.hostId, "extension-response-owner-first");
    const second = responseCommand(fixture.hostId, "extension-response-owner-second");

    const outcomes = await Promise.all([
      fixture.store.admitCommand(first, true),
      fixture.store.admitCommand(second, true),
    ]);
    const admitted = outcomes.filter((outcome) => outcome.receipt.status === "admitted");
    const rejected = outcomes.filter((outcome) => outcome.receipt.status === "rejected");
    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.receipt).toMatchObject({
      status: "rejected",
      error: { code: "EXTENSION_UI_RESPONSE_ALREADY_OWNED", retryable: false },
    });
    expect(await responseAttemptNames(fixture.store)).toHaveLength(1);
  });

  it("fails closed when a well-formed response attempt loses its exact receipt state", async () => {
    const fixture = await createFixture();
    const first = responseCommand(fixture.hostId, "extension-response-corrupt-first");
    await fixture.store.admitCommand(first, true);
    const [receiptName] = (await readdir(fixture.store.paths.receipts)).filter((name) => name.endsWith(".json"));
    if (!receiptName) throw new Error("extension response receipt fixture missing");
    const receipt = JSON.parse(await readFile(join(fixture.store.paths.receipts, receiptName), "utf8")) as Record<string, unknown>;
    await atomicWriteJson(join(fixture.store.paths.receipts, receiptName), {
      ...receipt,
      status: "completed",
      queuePosition: undefined,
    });

    expect(await fixture.store.admitCommand(
      responseCommand(fixture.hostId, "extension-response-corrupt-second"),
      true,
    )).toMatchObject({
      receipt: {
        status: "rejected",
        error: { code: "EXTENSION_UI_RESPONSE_ATTEMPT_INVALID", retryable: false },
      },
    });
  });

  it("rejects nonempty ephemeral dialog projection on write and read", async () => {
    const fixture = await createFixture();
    const snapshot = await fixture.store.getThreadSnapshot("test-thread");
    const request = liveRequest(fixture);
    const snapshotWithControl = {
      ...snapshot,
      residentControl: {
        projectionVersion: 1 as const,
        hostId: fixture.hostId,
        threadId: fixture.binding.threadId,
        executionGenerationId: fixture.binding.executionGenerationId,
        bindingFingerprint: request.bindingFingerprint,
        controlSequence: 1,
        changedAt: snapshot.generatedAt,
        authorityCursor: snapshot.latestCursor,
        commandReadiness: "ready" as const,
        browserExecution: { readiness: "unavailable" as const },
        quiescence: { state: "idle_proven" as const },
      },
      residentExtensionUiRequests: [request],
    };
    await expectStoreError(
      fixture.store.upsertThread(snapshot.thread, snapshotWithControl),
      "EPHEMERAL_EXTENSION_UI_PERSIST_FORBIDDEN",
    );
    expect(ThreadProjectionSnapshotSchema.safeParse({
      ...snapshotWithControl,
      residentExtensionUiRequests: [{ ...request, bindingFingerprint: "b".repeat(64) }],
    }).success).toBe(false);
    const [snapshotName] = (await readdir(fixture.store.paths.snapshots)).filter((name) => name.endsWith(".json"));
    if (!snapshotName) throw new Error("thread snapshot fixture missing");
    await atomicWriteJson(join(fixture.store.paths.snapshots, snapshotName), snapshotWithControl);
    await expectStoreError(
      fixture.store.getThreadSnapshot("test-thread"),
      "EPHEMERAL_EXTENSION_UI_PERSIST_FORBIDDEN",
    );
  });
});

describe("HostService resident extension UI response dispatch", () => {
  it("requires the exact live request, acknowledges once, and returns the durable duplicate", async () => {
    const fixture = await createFixture();
    const command = responseCommand(fixture.hostId, "extension-response-service-success");
    const request = liveRequest(fixture);
    let observedContext: GatewayDispatchContext | undefined;
    const submit = vi.fn(async (_command: CommandEnvelope, context?: GatewayDispatchContext) => {
      observedContext = context;
      return { disposition: "handled" as const, message: "Dialog response accepted" };
    });
    const service = new HostService(fixture.store, gatewayWith(fixture.binding, request, submit));
    await service.initialize();

    expect(await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "extension-response-health",
      method: "health.get",
      payload: {},
    }, TRUSTED_USER_SESSION)).toMatchObject({
      ok: true,
      result: { capabilities: expect.arrayContaining([RESIDENT_EXTENSION_UI_CAPABILITY]) },
    });

    const first = await submitThroughService(service, command, "extension-response-service-request");
    expect(first).toMatchObject({ ok: true, result: { status: "completed" } });
    expect(observedContext?.extensionUiResponse).toBeDefined();
    expect(submit).toHaveBeenCalledOnce();
    const duplicate = await submitThroughService(service, command, "extension-response-service-duplicate");
    expect(duplicate).toEqual({ ...first, requestId: "extension-response-service-duplicate" });
    expect(submit).toHaveBeenCalledOnce();
    await service.close();
  });

  it("rejects a disappeared request before dispatch and records ambiguous acknowledgement as nonretryable uncertain", async () => {
    const missingFixture = await createFixture();
    const missingCommand = responseCommand(missingFixture.hostId, "extension-response-missing");
    const missingSubmit = vi.fn<PrimeAgentGateway["submit"]>();
    const missingService = new HostService(
      missingFixture.store,
      gatewayWith(missingFixture.binding, undefined, missingSubmit),
    );
    await missingService.initialize();
    expect(await submitThroughService(missingService, missingCommand, "extension-response-missing-request")).toMatchObject({
      ok: true,
      result: { status: "rejected", error: { code: "EXTENSION_UI_REQUEST_EXPIRED", retryable: false } },
    });
    expect(missingSubmit).not.toHaveBeenCalled();
    await missingService.close();

    const uncertainFixture = await createFixture();
    const uncertainCommand = responseCommand(uncertainFixture.hostId, "extension-response-uncertain");
    const uncertainSubmit = vi.fn(async () => {
      throw new GatewayError(
        "EXTENSION_UI_RESPONSE_OUTCOME_UNKNOWN",
        "Response may have reached Prime Agent",
        false,
        true,
      );
    });
    const uncertainService = new HostService(
      uncertainFixture.store,
      gatewayWith(uncertainFixture.binding, liveRequest(uncertainFixture), uncertainSubmit),
    );
    await uncertainService.initialize();
    expect(await submitThroughService(uncertainService, uncertainCommand, "extension-response-uncertain-request")).toMatchObject({
      ok: true,
      result: {
        status: "uncertain",
        error: { code: "EXTENSION_UI_RESPONSE_OUTCOME_UNKNOWN", retryable: false },
      },
    });
    expect(uncertainSubmit).toHaveBeenCalledOnce();
    await uncertainService.close();
  });
});

async function createFixture(): Promise<{
  directory: string;
  store: HostStore;
  hostId: string;
  binding: ResidentSessionBinding;
}> {
  const directory = await mkdtemp(join(tmpdir(), "prime-resident-extension-ui-"));
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
    activeSessionId: "active-session-extension-ui-1",
    sessionId: "session-extension-ui-1",
    sessionFile: join(workspaceDirectory, ".prime-agent", "session-extension-ui-1.jsonl"),
    boundAt: "2026-08-12T14:00:00.000Z",
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

function responseCommand(expectedHostId: string, commandId: string): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "extension-ui-device",
    commandId,
    expectedHostId,
    threadId: "test-thread",
    issuedAt: "2026-08-12T14:01:00.000Z",
    expectedExecutionGenerationId: "test-execution-1",
    command: {
      kind: "extension_ui.respond",
      requestId: "request-select",
      requestDigest: "a".repeat(64),
      method: "select",
      response: { kind: "value", value: "A" },
    },
  };
}

function liveRequest(fixture: { hostId: string; binding: ResidentSessionBinding }): ResidentExtensionUiRequest {
  return {
    interactionVersion: 1,
    hostId: fixture.hostId,
    threadId: fixture.binding.threadId,
    executionGenerationId: fixture.binding.executionGenerationId,
    bindingFingerprint: residentDispatchAuthorityFingerprint(fixture.binding),
    requestId: "request-select",
    requestDigest: "a".repeat(64),
    receivedAt: "2026-08-12T14:00:30.000Z",
    method: "select",
    title: "Choose",
    options: ["A", "B"],
  };
}

function gatewayWith(
  residentBinding: ResidentSessionBinding,
  request: ResidentExtensionUiRequest | undefined,
  submit: PrimeAgentGateway["submit"],
): PrimeAgentGateway {
  return {
    continuity: "resident",
    async isLive() {
      return true;
    },
    async isResidentBindingLive(candidate) {
      return residentDispatchAuthorityFingerprint(candidate) === residentDispatchAuthorityFingerprint(residentBinding);
    },
    listResidentExtensionUiRequests(candidate) {
      return request && residentDispatchAuthorityFingerprint(candidate) === residentDispatchAuthorityFingerprint(residentBinding)
        ? [request]
        : [];
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

async function responseAttemptNames(store: HostStore): Promise<string[]> {
  return (await readdir(store.paths.extensionUiResponseAttempts))
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
