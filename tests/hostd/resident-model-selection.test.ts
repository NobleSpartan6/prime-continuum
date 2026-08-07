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
import { HostStore, HostStoreError } from "../../src/hostd/store";
import { PROTOCOL_VERSION, type CommandEnvelope } from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HostStore resident model-selection journal", () => {
  it("admits against one exact binding and persists the dispatch boundary before running", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-journal-success");
    const before = await fixture.store.getThreadSnapshot(command.threadId);

    const admission = await fixture.store.admitCommand(command, true);
    expect(admission).toMatchObject({ duplicate: false, receipt: { status: "admitted" } });
    expect(admission.receipt.queuePosition).toBeUndefined();
    expect(await fixture.store.getThreadSnapshot(command.threadId)).toEqual(before);
    expect(await modelAttemptNames(fixture.store)).toHaveLength(1);

    await expect(fixture.store.beginModelSelectionDispatch(command)).resolves.toEqual(fixture.binding);
    expect((await fixture.store.reconcileCommands([command])).receipts[0]).toMatchObject({ status: "running" });
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

  it("rejects stale authority and an exact binding change before dispatch", async () => {
    const fixture = await createFixture();
    const stale = modelSelectionCommand(fixture.hostId, "model-stale-generation", "stale-generation");
    const staleAdmission = await fixture.store.admitCommand(stale, true);
    expect(staleAdmission.receipt).toMatchObject({
      status: "rejected",
      error: { code: "STALE_EXECUTION_GENERATION" },
    });
    expect(await modelAttemptNames(fixture.store)).toEqual([]);

    const exact = modelSelectionCommand(fixture.hostId, "model-binding-changed");
    expect((await fixture.store.admitCommand(exact, true)).receipt.status).toBe("admitted");
    await fixture.store.persistResidentSessionBinding({
      ...fixture.binding,
      runtime: { ...fixture.binding.runtime, supervisorGeneration: "supervisor-replaced" },
    });
    await expectStoreError(fixture.store.beginModelSelectionDispatch(exact), "RESIDENT_BINDING_CONFLICT");
    await expect(fixture.store.finalizeModelSelectionDispatch(exact, {
      status: "failed",
      error: {
        code: "RESIDENT_BINDING_CONFLICT",
        message: "Binding changed before dispatch",
        retryable: true,
      },
    })).resolves.toMatchObject({ status: "failed" });
  });

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

  it("idempotently repairs a terminal receipt whose final journal append was interrupted", async () => {
    const fixture = await createFixture();
    const command = modelSelectionCommand(fixture.hostId, "model-crash-finalizing");
    await fixture.store.admitCommand(command, true);
    await fixture.store.beginModelSelectionDispatch(command);
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

  it("dispatches only after the running receipt is durable and deduplicates terminal retries", async () => {
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
    expect(response).toMatchObject({ ok: true, result: { status: "completed" } });
    expect(observedContext?.residentBinding).toEqual(fixture.binding);
    expect(submit).toHaveBeenCalledTimes(1);

    const duplicate = await submitThroughService(service, command, "model-service-request-2");
    expect(duplicate).toMatchObject({ ok: true, result: { status: "completed" } });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await commandStatuses(fixture.store, command.commandId)).toEqual([
      "received",
      "admitted",
      "running",
      "completed",
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
  await store.initialize({ seed: true });
  const workspaceDirectory = await realpath(workspace);
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
  executionGenerationId = "demo-execution-1",
): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "model-device-1",
    commandId,
    expectedHostId,
    threadId: "demo-thread",
    issuedAt: "2026-08-07T18:01:00.000Z",
    expectedExecutionGenerationId: executionGenerationId,
    command: { kind: "model.select", providerId: "openai", modelId: "gpt-5" },
  };
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
