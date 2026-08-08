import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnavailablePrimeAgentGateway } from "../../src/hostd/gateway";
import type { PrimeAgentResidentAdapterOptions } from "../../src/hostd/prime-agent-resident-adapter";
import type { ResidentProjectionSnapshot } from "../../src/hostd/resident-projection";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentPromptIdleAuthorityEvidence,
  type ResidentRuntimeConnection,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import type { VerifiedInstalledRuntimeHandle } from "../../src/hostd/runtime-integrity-manager";
import type { VerifiedRuntimeHandleProvider } from "../../src/hostd/runtime-model-catalog";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import {
  HostStore,
  type ResidentPromptReconciliationLease,
} from "../../src/hostd/store";
import { VerifiedResidentGateway } from "../../src/hostd/verified-resident-gateway";
import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type CommandReceipt,
} from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("verified resident prompt idle reconciliation", () => {
  it("commits one real Store proof before notifying prompt-idle and trailing projection listeners", async () => {
    const order: string[] = [];
    const fixture = await serviceFixture(async (lease, options) => {
      const idle = projection(lease.binding, "proof-idle", 1);
      await options.publishProjection(lease.binding, idle);
      return evidence(lease, idle);
    });
    fixture.gateway.subscribeProjectionChanges(() => order.push("projection"));
    fixture.gateway.subscribeResidentPromptIdleObserved(() => {
      order.push("prompt-idle-throwing-listener");
      throw new Error("one advisory listener failed");
    });
    fixture.gateway.subscribeResidentPromptIdleObserved(() => order.push("prompt-idle"));

    const command = promptCommand(fixture.hostId, "proof-order-prompt");
    const immediate = await submitCommand(fixture.service, command, "proof-order-submit");

    expect(immediate.status).toBe("running");
    await vi.waitFor(() => expect(order).toContain("prompt-idle"));
    expect(order.slice(-2)).toEqual(["prompt-idle", "projection"]);
    expect(fixture.adapter.submit).toHaveBeenCalledOnce();
    expect(fixture.adapter.reconcileAcknowledgedPromptIdle).toHaveBeenCalledOnce();
    expect((await fixture.store.reconcileCommands([command])).receipts[0]).toMatchObject({
      status: "completed",
      message: "Prime Agent is authoritatively idle after the acknowledged prompt",
    });
    expect(await fixture.store.listResidentPromptReconciliationLeases()).toEqual([]);

    await fixture.service.close();
  });

  it("retains a running lock after transient proof failure and retries it from a later readiness edge without replay", async () => {
    let attempt = 0;
    const fixture = await serviceFixture(async (lease, options) => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient idle observation failure");
      const idle = projection(lease.binding, "proof-retry-idle", 1);
      await options.publishProjection(lease.binding, idle);
      return evidence(lease, idle);
    });
    const command = promptCommand(fixture.hostId, "proof-retry-prompt");

    await expect(submitCommand(fixture.service, command, "proof-retry-submit")).resolves.toMatchObject({
      status: "running",
    });
    await vi.waitFor(() => expect(fixture.adapter.reconcileAcknowledgedPromptIdle).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect((await fixture.store.listResidentPromptReconciliationLeases()).length).toBe(1));

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(true);
    await vi.waitFor(() => expect(fixture.adapter.reconcileAcknowledgedPromptIdle).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await fixture.store.reconcileCommands([command])).receipts[0]?.status).toBe("completed"));
    expect(fixture.adapter.submit).toHaveBeenCalledOnce();

    await fixture.service.close();
  });

  it("discovers an acknowledged running lock after host restart and performs only the read-only proof", async () => {
    const base = await initializedStore();
    const command = promptCommand(base.hostId, "proof-restart-prompt");
    const admission = await base.store.admitCommand(command, true);
    expect(admission.receipt.status).toBe("admitted");
    const dispatch = await base.store.beginResidentDispatch(command);
    await base.store.finalizeResidentDispatch(dispatch, {
      status: "running",
      message: "Prime Agent owns the exact prompt",
    });

    const restartedStore = new HostStore(base.directory);
    await restartedStore.initialize();
    const fixture = gatewayFixture(restartedStore, async (lease, options) => {
      const idle = projection(lease.binding, "proof-restart-idle", 1);
      await options.publishProjection(lease.binding, idle);
      return evidence(lease, idle);
    });

    await expect(fixture.gateway.capabilityReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await fixture.gateway.capabilityReady()).toBe(true));
    await vi.waitFor(() => expect(fixture.adapter.reconcileAcknowledgedPromptIdle).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect((await restartedStore.reconcileCommands([command])).receipts[0]?.status).toBe("completed"));
    expect(fixture.adapter.submit).not.toHaveBeenCalled();
    expect(await restartedStore.listResidentPromptReconciliationLeases()).toEqual([]);

    await fixture.gateway.close();
  });
});

type ReconcileHandler = (
  lease: ResidentPromptReconciliationLease,
  options: PrimeAgentResidentAdapterOptions,
) => Promise<ResidentPromptIdleAuthorityEvidence>;

async function serviceFixture(reconcile: ReconcileHandler) {
  const base = await initializedStore();
  const gateway = gatewayFixture(base.store, reconcile);
  const service = new HostService(base.store, gateway.gateway);
  await expect(gateway.gateway.capabilityReady()).resolves.toBe(false);
  await vi.waitFor(async () => expect(await gateway.gateway.capabilityReady()).toBe(true));
  return { ...base, ...gateway, service };
}

async function initializedStore() {
  const directory = await mkdtemp(join(tmpdir(), "prime-resident-proof-integration-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspaceDirectory = await realpath(workspacePath);
  const store = new HostStore(directory);
  const service = new HostService(store, new UnavailablePrimeAgentGateway());
  await service.initialize({ seed: true });
  await store.registerWorkspaceAuthority({
    threadId: "demo-thread",
    executionGenerationId: "demo-execution-1",
    workspaceDirectory,
  });
  await store.persistResidentSessionBinding(binding(workspaceDirectory));
  const hostId = (await store.getHost()).hostId;
  await service.close();
  return { directory, workspaceDirectory, store, hostId };
}

function gatewayFixture(store: HostStore, reconcile: ReconcileHandler) {
  let adapterOptions!: PrimeAgentResidentAdapterOptions;
  const adapter = {
    continuity: "resident" as const,
    isLive: vi.fn(async () => true),
    submit: vi.fn(async () => ({ disposition: "accepted" as const, message: "Prime Agent owns the prompt" })),
    close: vi.fn(async () => undefined),
    attachResident: vi.fn(async (candidate: ResidentSessionBinding) => ({ binding: candidate }) as ResidentRuntimeConnection),
    reconcileAcknowledgedPromptIdle: vi.fn(async (lease: ResidentPromptReconciliationLease) =>
      reconcile(lease, adapterOptions)),
    reconcileAcknowledgedAbortIdle: vi.fn(async () => {
      throw new Error("No Stop reconciliation lease was configured for this prompt fixture");
    }),
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
    threadId: "demo-thread",
    executionGenerationId: "demo-execution-1",
    workspaceDirectory,
    activeSessionId: "active-proof-session",
    sessionId: "proof-session",
    sessionFile: join(workspaceDirectory, ".prime-agent", "proof-session.jsonl"),
    boundAt: "2026-08-07T22:00:00.000Z",
    runtime: {
      releaseVersion: PINNED_PRIME_AGENT_RUNTIME.releaseVersion,
      appVersion: PINNED_PRIME_AGENT_RUNTIME.expectedAppVersion,
      protocolName: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolName,
      protocolVersion: PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion,
      schemaRevision: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision,
      schemaId: PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId,
      capabilities: [...REQUIRED_RESIDENT_DAEMON_CAPABILITIES],
      runtimeBuildId: PINNED_PRIME_AGENT_RUNTIME.runtimeBuildId,
      supervisorGeneration: "proof-supervisor-1",
    },
  };
}

function promptCommand(expectedHostId: string, commandId: string): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "proof-device",
    commandId,
    expectedHostId,
    threadId: "demo-thread",
    issuedAt: "2026-08-07T22:01:00.000Z",
    expectedExecutionGenerationId: "demo-execution-1",
    command: { kind: "prompt", text: "Verify the acknowledged resident prompt idle boundary." },
  };
}

function projection(
  residentBinding: ResidentSessionBinding,
  generation: string,
  sequence: number,
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
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      steeringMode: "all",
      followUpMode: "all",
      messageCount: 0,
      compactionCount: 0,
      queuedActionCount: 0,
      activeToolNames: [],
      recap: "Resident session is authoritatively idle.",
    },
    transcript: [],
    childAgents: [],
    queue: { queuedCount: 0, steeringCount: 0, followUpCount: 0 },
  };
}

function evidence(
  lease: ResidentPromptReconciliationLease,
  idleProjection: ResidentProjectionSnapshot,
): ResidentPromptIdleAuthorityEvidence {
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
  if (!response.ok || response.method !== "command.submit") throw new Error("Prompt submission failed");
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
