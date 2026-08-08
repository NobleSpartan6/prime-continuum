import { bootstrapTestWorkspace } from "./test-workspace-fixture";
import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalTemporaryDirectory } from "../helpers/canonical-temp";
import { UnavailablePrimeAgentGateway } from "../../src/hostd/gateway";
import type { PrimeAgentResidentAdapterOptions } from "../../src/hostd/prime-agent-resident-adapter";
import type { ResidentProjectionSnapshot } from "../../src/hostd/resident-projection";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentAbortIdleAuthorityEvidence,
  type ResidentRuntimeConnection,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import type { VerifiedInstalledRuntimeHandle } from "../../src/hostd/runtime-integrity-manager";
import type { VerifiedRuntimeHandleProvider } from "../../src/hostd/runtime-model-catalog";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import {
  HostStore,
  type ResidentAbortReconciliationLease,
} from "../../src/hostd/store";
import { VerifiedResidentGateway } from "../../src/hostd/verified-resident-gateway";
import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type CommandReceipt,
  type ResidentAbortIdleObservedSignal,
} from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("verified resident Stop idle reconciliation", () => {
  it("keeps Stop nonterminal until one exact same-cursor idle proof commits before public notification", async () => {
    const order: string[] = [];
    const observations: ResidentAbortIdleObservedSignal[] = [];
    const fixture = await serviceFixture(async (lease) =>
      evidence(lease, projection(lease.binding, "abort-proof-same-cursor", 1, false)));
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, "abort-proof-same-cursor", 1, true),
    );
    fixture.gateway.subscribeProjectionChanges(() => order.push("projection"));
    fixture.gateway.subscribeResidentAbortIdleObserved((observation) => {
      observations.push(observation);
      order.push("abort-idle");
    });

    const command = abortCommand(fixture.hostId, "abort-proof-order");
    const immediate = await submitCommand(fixture.service, command, "abort-proof-order-submit");

    expect(immediate).toMatchObject({
      status: "running",
      message: "Prime Agent accepted Stop; waiting for idle proof",
    });
    await vi.waitFor(() => expect(observations).toHaveLength(1));
    expect(order.slice(-2)).toEqual(["abort-idle", "projection"]);
    expect(observations[0]).toMatchObject({
      eventVersion: 1,
      attemptId: expect.any(String),
      receipt: expect.objectContaining({ commandId: command.commandId, status: "completed" }),
    });
    expect(fixture.adapter.submit).toHaveBeenCalledOnce();
    expect(fixture.adapter.reconcileAcknowledgedAbortIdle).toHaveBeenCalledOnce();
    expect((await fixture.store.reconcileCommands([command])).receipts[0]).toEqual(observations[0]?.receipt);
    expect(await fixture.store.listResidentAbortReconciliationLeases()).toEqual([]);
    expect((await fixture.store.getThreadSnapshot(command.threadId)).thread.status).toBe("idle");

    await fixture.service.close();
  });

  it("retains a running Stop after proof failure and retries only the read-only proof", async () => {
    let proofAttempt = 0;
    const fixture = await serviceFixture(async (lease) => {
      proofAttempt += 1;
      if (proofAttempt === 1) throw new Error("transient Stop idle observation failure");
      return evidence(lease, projection(lease.binding, "abort-proof-retry", 2, false));
    });
    await fixture.store.publishResidentProjectionSnapshot(
      fixture.binding,
      projection(fixture.binding, "abort-proof-retry", 1, true),
    );
    const command = abortCommand(fixture.hostId, "abort-proof-retry-command");

    await expect(submitCommand(fixture.service, command, "abort-proof-retry-submit")).resolves.toMatchObject({
      status: "running",
    });
    await vi.waitFor(() => expect(fixture.adapter.reconcileAcknowledgedAbortIdle).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect((await fixture.store.listResidentAbortReconciliationLeases()).length).toBe(1));
    expect((await fixture.store.reconcileCommands([command])).receipts[0]?.status).toBe("running");

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(true);
    await vi.waitFor(() => expect(fixture.adapter.reconcileAcknowledgedAbortIdle).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await fixture.store.reconcileCommands([command])).receipts[0]?.status)
      .toBe("completed"));
    expect(fixture.adapter.submit).toHaveBeenCalledOnce();

    await fixture.service.close();
  });

  it("discovers an acknowledged Stop after restart and never replays the mutation", async () => {
    const base = await initializedStore();
    const active = projection(base.binding, "abort-proof-restart", 1, true);
    await base.store.publishResidentProjectionSnapshot(base.binding, active);
    const command = abortCommand(base.hostId, "abort-proof-restart-command");
    expect((await base.store.admitCommand(command, true)).receipt.status).toBe("admitted");
    const dispatch = await base.store.beginResidentDispatch(command);
    await base.store.finalizeResidentDispatch(dispatch, {
      status: "running",
      message: "Prime Agent accepted Stop; waiting for idle proof",
    });

    const restartedStore = new HostStore(base.directory);
    await restartedStore.initialize();
    const fixture = gatewayFixture(
      restartedStore,
      async (lease) => evidence(lease, projection(lease.binding, "abort-proof-restart", 1, false)),
      active,
    );

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    await vi.waitFor(() => expect(fixture.adapter.reconcileAcknowledgedAbortIdle).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect((await restartedStore.reconcileCommands([command])).receipts[0]?.status)
      .toBe("completed"));
    expect(fixture.adapter.submit).not.toHaveBeenCalled();
    expect(await restartedStore.listResidentAbortReconciliationLeases()).toEqual([]);

    await fixture.gateway.close();
  });
});

type ReconcileHandler = (
  lease: ResidentAbortReconciliationLease,
) => Promise<ResidentAbortIdleAuthorityEvidence>;

async function serviceFixture(reconcile: ReconcileHandler) {
  const base = await initializedStore();
  const gateway = gatewayFixture(base.store, reconcile);
  const service = new HostService(base.store, gateway.gateway);
  await expect(gateway.gateway.capabilityReady()).resolves.toBe(false);
  await vi.waitFor(async () => expect(await gateway.gateway.capabilityReady()).toBe(true));
  return { ...base, ...gateway, service };
}

async function initializedStore() {
  const directory = await canonicalTemporaryDirectory("prime-resident-abort-proof-integration-");
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspaceDirectory = await realpath(workspacePath);
  const store = new HostStore(directory);
  const service = new HostService(store, new UnavailablePrimeAgentGateway());
  await service.initialize();
  await bootstrapTestWorkspace(store, { workspaceDirectory });
  await store.registerWorkspaceAuthority({
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
    workspaceDirectory,
  });
  const residentBinding = binding(workspaceDirectory);
  await store.persistResidentSessionBinding(residentBinding);
  const hostId = (await store.getHost()).hostId;
  await service.close();
  return { directory, workspaceDirectory, store, hostId, binding: residentBinding };
}

function gatewayFixture(
  store: HostStore,
  reconcile: ReconcileHandler,
  attachProjection?: ResidentProjectionSnapshot,
) {
  let adapterOptions!: PrimeAgentResidentAdapterOptions;
  const adapter = {
    continuity: "resident" as const,
    isLive: vi.fn(async () => true),
    submit: vi.fn(async () => ({
      disposition: "handled" as const,
      message: "Prime Agent accepted Stop; waiting for idle proof",
    })),
    close: vi.fn(async () => undefined),
    attachResident: vi.fn(async (candidate: ResidentSessionBinding) => {
      await adapterOptions.publishProjection(
        candidate,
        attachProjection ?? projection(candidate, `attach-${candidate.threadId}`, 0, false),
      );
      return { binding: candidate } as ResidentRuntimeConnection;
    }),
    reconcileAcknowledgedPromptIdle: vi.fn(async () => {
      throw new Error("No prompt reconciliation lease was configured for this Stop fixture");
    }),
    reconcileAcknowledgedAbortIdle: vi.fn(async (lease: ResidentAbortReconciliationLease) => reconcile(lease)),
  };
  const runtimeHandles = {
    acquireVerifiedRuntimeHandle: vi.fn(async () => verifiedHandle(store.paths.root)),
  } satisfies VerifiedRuntimeHandleProvider;
  const gateway = new VerifiedResidentGateway({
    store,
    runtimeHandles,
    platform: "win32",
    environment: {},
    adapterFactory: (options) => {
      adapterOptions = options;
      return adapter;
    },
    moduleLoaderFactory: () => async () => ({}),
  });
  return { gateway, adapter, runtimeHandles };
}

function binding(workspaceDirectory: string): ResidentSessionBinding {
  return {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
    workspaceDirectory,
    activeSessionId: "active-abort-proof-session",
    sessionId: "abort-proof-session",
    sessionFile: join(workspaceDirectory, ".prime-agent", "abort-proof-session.jsonl"),
    boundAt: "2026-08-08T01:00:00.000Z",
    runtime: {
      releaseVersion: PINNED_PRIME_AGENT_RUNTIME.releaseVersion,
      appVersion: PINNED_PRIME_AGENT_RUNTIME.expectedAppVersion,
      protocolName: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolName,
      protocolVersion: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion,
      schemaRevision: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision,
      schemaId: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId,
      capabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES],
      runtimeBuildId: PINNED_PRIME_AGENT_RUNTIME.runtimeBuildId,
      supervisorGeneration: "abort-proof-supervisor-1",
    },
  };
}

function abortCommand(expectedHostId: string, commandId: string): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "abort-proof-device",
    commandId,
    expectedHostId,
    threadId: "test-thread",
    issuedAt: "2026-08-08T01:01:00.000Z",
    expectedExecutionGenerationId: "test-execution-1",
    command: { kind: "abort", reason: "Verify the exact acknowledged Stop idle boundary." },
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
      messageCount: active ? 1 : 0,
      compactionCount: 0,
      queuedActionCount: active ? 1 : 0,
      activeToolNames: [],
      recap: active ? "Resident turn remains active." : "Resident session is authoritatively idle.",
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

function evidence(
  lease: ResidentAbortReconciliationLease,
  idleProjection: ResidentProjectionSnapshot,
): ResidentAbortIdleAuthorityEvidence {
  return Object.freeze({
    evidenceVersion: 1,
    dispatchAttemptId: lease.attemptId,
    binding: lease.binding,
    projection: idleProjection,
  });
}

async function submitCommand(
  service: HostService,
  command: CommandEnvelope,
  requestId: string,
): Promise<CommandReceipt> {
  const response = await service.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: "command.submit",
    payload: { command },
  }, TRUSTED_USER_SESSION);
  if (!response.ok || response.method !== "command.submit") throw new Error("Stop submission failed");
  return response.result;
}

function verifiedHandle(root: string): VerifiedInstalledRuntimeHandle {
  return {
    identity: {},
    executable: join(root, "node.exe"),
    moduleUrl: new URL(`file:///${join(root, "dist", "index.js").replaceAll("\\", "/")}`).href,
    cliEntrypoint: join(root, "dist", "bundle", "cli.js"),
  } as unknown as VerifiedInstalledRuntimeHandle;
}
