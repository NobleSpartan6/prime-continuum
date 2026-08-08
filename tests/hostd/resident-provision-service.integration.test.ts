import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrimeAgentGateway } from "../../src/hostd/gateway";
import type { VerifiedInstalledRuntimeHandle } from "../../src/hostd/runtime-integrity-manager";
import {
  HostService,
  SSH_BRIDGE_SESSION,
  TRUSTED_USER_SESSION,
} from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";
import { VerifiedResidentGateway } from "../../src/hostd/verified-resident-gateway";
import {
  PRIME_AGENT_COMMAND_CAPABILITY,
  PROTOCOL_VERSION,
  RESIDENT_LIFECYCLE_CAPABILITY,
  type HostIpcRequest,
} from "../../src/shared/protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("HostService resident provisioning boundary", () => {
  it("advertises zero-binding local lifecycle capability and keeps workspace authority out of its response", async () => {
    const { service, store, gateway, workspaceDirectory, request } = await provisionFixture();

    const health = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "resident-provision-health",
      method: "health.get",
      payload: {},
    }, TRUSTED_USER_SESSION);
    expect(health).toMatchObject({ ok: true, method: "health.get" });
    if (!health.ok || health.method !== "health.get") throw new Error("health failed");
    expect(health.result.capabilities).toContain(RESIDENT_LIFECYCLE_CAPABILITY);
    expect(health.result.capabilities).not.toContain(PRIME_AGENT_COMMAND_CAPABILITY);

    const response = await service.handle(request, TRUSTED_USER_SESSION);
    expect(response).toMatchObject({
      ok: true,
      method: "resident.provision",
      result: {
        kind: "provision",
        operationId: request.payload.operationId,
        phase: "prepared",
        threadId: request.payload.threadId,
      },
    });
    expect(JSON.stringify(response)).not.toContain(workspaceDirectory);
    expect(JSON.stringify(response)).not.toMatch(/workspaceDirectory|activeSessionId|sessionFile/);
    expect(gateway.provisionResident).toHaveBeenCalledWith({
      operationId: request.payload.operationId,
      expectedHostId: request.payload.expectedHostId,
      projectId: request.payload.projectId,
      workspaceId: request.payload.workspaceId,
      threadId: request.payload.threadId,
      executionGenerationId: request.payload.executionGenerationId,
      selection: { kind: "new", sessionName: "Resident thread" },
    });

    const catalog = await store.getCatalogSnapshot();
    expect(catalog.projects).toContainEqual(expect.objectContaining({
      projectId: request.payload.projectId,
      workspaceId: request.payload.workspaceId,
      displayName: "Workspace project",
    }));
    expect(catalog.threads).toContainEqual(expect.objectContaining({
      threadId: request.payload.threadId,
      title: "First resident thread",
      status: "idle",
    }));
    expect(await store.resolveWorkspaceDirectory(
      request.payload.threadId,
      request.payload.executionGenerationId,
    )).toBe(workspaceDirectory);

    const status = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "resident-provision-status",
      method: "resident.lifecycle.status",
      payload: {
        expectedHostId: request.payload.expectedHostId,
        operationId: request.payload.operationId,
      },
    }, TRUSTED_USER_SESSION);
    expect(status).toMatchObject({
      ok: true,
      method: "resident.lifecycle.status",
      result: { status: { operationId: request.payload.operationId, phase: "prepared" } },
    });
    await service.close();
  });

  it("rejects SSH lifecycle mutation before adapter readiness or workspace persistence", async () => {
    const { service, store, gateway, request } = await provisionFixture();

    const health = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "resident-provision-ssh-health",
      method: "health.get",
      payload: {},
    }, SSH_BRIDGE_SESSION);
    expect(health).toMatchObject({ ok: true, method: "health.get" });
    if (!health.ok || health.method !== "health.get") throw new Error("SSH health failed");
    expect(health.result.capabilities).not.toContain(RESIDENT_LIFECYCLE_CAPABILITY);

    const response = await service.handle(request, SSH_BRIDGE_SESSION);

    expect(response).toMatchObject({
      ok: false,
      method: "resident.provision",
      error: { code: "REMOTE_RESIDENT_LIFECYCLE_FORBIDDEN", retryable: false },
    });
    expect(gateway.residentLifecycleCapabilityReady).not.toHaveBeenCalled();
    expect(gateway.provisionResident).not.toHaveBeenCalled();
    expect((await store.getCatalogSnapshot()).projects).toHaveLength(0);
    await service.close();
  });

  it("omits lifecycle readiness and persists nothing when the verified Worker preflight fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-resident-preflight-failure-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const workspaceDirectory = await realpath(workspacePath);
    const store = new HostStore(join(directory, "data"));
    await store.initialize({ seed: false });
    const host = await store.getHost();
    let cachedImportFailure: Promise<never> | undefined;
    const moduleLoader = Object.assign(
      vi.fn(() => {
        cachedImportFailure ??= Promise.resolve().then(() => {
          throw new Error("verified Worker import failed");
        });
        return cachedImportFailure;
      }),
      { close: vi.fn(async () => undefined) },
    );
    const adapterFactory = vi.fn(() => {
      throw new Error("adapter construction must follow a successful Worker preflight");
    });
    const gateway = new VerifiedResidentGateway({
      store,
      runtimeHandles: {
        acquireVerifiedRuntimeHandle: vi.fn(async () => ({
          identity: {},
          executable: join(directory, "node.exe"),
          moduleUrl: new URL(`file:///${join(directory, "dist", "index.js").replaceAll("\\", "/")}`).href,
          cliEntrypoint: join(directory, "dist", "bundle", "cli.js"),
        }) as unknown as VerifiedInstalledRuntimeHandle),
      },
      platform: "win32",
      environment: {},
      adapterFactory,
      moduleLoaderFactory: () => moduleLoader,
    });
    const service = new HostService(store, gateway);
    const request = residentProvisionRequest(host.hostId, workspaceDirectory);

    const health = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "resident-preflight-failure-health",
      method: "health.get",
      payload: {},
    }, TRUSTED_USER_SESSION);
    expect(health).toMatchObject({ ok: true, method: "health.get" });
    if (!health.ok || health.method !== "health.get") throw new Error("health failed");
    expect(health.result.capabilities).not.toContain(RESIDENT_LIFECYCLE_CAPABILITY);
    expect(adapterFactory).not.toHaveBeenCalled();

    const response = await service.handle(request, TRUSTED_USER_SESSION);
    expect(response).toMatchObject({
      ok: false,
      method: "resident.provision",
      error: { code: "RESIDENT_LIFECYCLE_UNAVAILABLE" },
    });
    expect(adapterFactory).not.toHaveBeenCalled();
    expect((await store.getCatalogSnapshot()).projects).toHaveLength(0);
    expect((await store.getCatalogSnapshot()).threads).toHaveLength(0);
    await expect(store.getResidentLifecycleStatus(request.payload.operationId)).resolves.toBeUndefined();
    await expect(store.resolveWorkspaceDirectory(
      request.payload.threadId,
      request.payload.executionGenerationId,
    )).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });

    await service.close();
  });

  it("reuses exact bootstrapped artifacts for a new operation after definitive clean failure", async () => {
    const { service, store, gateway, workspaceDirectory, request } = await provisionFixture();
    gateway.provisionResident.mockImplementationOnce(async (candidate: ResidentGatewayProvisionInput) => {
      const input = residentLifecycleInput(candidate);
      await store.prepareResidentProvision(input);
      const lease = await store.beginResidentOwnedCreate(input);
      return store.failResidentOwnedCreateBeforeEffect(lease);
    });

    const first = await service.handle(request, TRUSTED_USER_SESSION);
    expect(first).toMatchObject({
      ok: true,
      method: "resident.provision",
      result: {
        operationId: request.payload.operationId,
        phase: "completed",
        completionReason: "owned_create_failed_before_effect",
      },
    });

    const retry = {
      ...request,
      requestId: "resident-provision-retry-request",
      payload: {
        ...request.payload,
        operationId: "resident-provision-retry-operation",
      },
    } as const satisfies Extract<HostIpcRequest, { method: "resident.provision" }>;
    const second = await service.handle(retry, TRUSTED_USER_SESSION);
    expect(second).toMatchObject({
      ok: true,
      method: "resident.provision",
      result: {
        operationId: retry.payload.operationId,
        phase: "prepared",
      },
    });

    const catalog = await store.getCatalogSnapshot();
    expect(catalog.projects).toHaveLength(1);
    expect(catalog.threads).toHaveLength(1);
    expect(catalog.projects[0]).toMatchObject({
      projectId: request.payload.projectId,
      workspaceId: request.payload.workspaceId,
    });
    expect(catalog.threads[0]).toMatchObject({
      threadId: request.payload.threadId,
      updatedAt: request.payload.createdAt,
    });
    await expect(store.resolveWorkspaceDirectory(
      request.payload.threadId,
      request.payload.executionGenerationId,
    )).resolves.toBe(workspaceDirectory);
    await service.close();
  });
});

async function provisionFixture(): Promise<{
  service: HostService;
  store: HostStore;
  gateway: ReturnType<typeof residentLifecycleGateway>;
  workspaceDirectory: string;
  request: Extract<HostIpcRequest, { method: "resident.provision" }>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "prime-resident-provision-service-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspaceDirectory = await realpath(workspacePath);
  const store = new HostStore(join(directory, "data"));
  await store.initialize({ seed: false });
  const host = await store.getHost();
  const gateway = residentLifecycleGateway(store);
  const service = new HostService(store, gateway);
  const request = residentProvisionRequest(host.hostId, workspaceDirectory);
  return { service, store, gateway, workspaceDirectory, request };
}

function residentProvisionRequest(
  expectedHostId: string,
  workspaceDirectory: string,
): Extract<HostIpcRequest, { method: "resident.provision" }> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: "resident-provision-request",
    method: "resident.provision",
    payload: {
      expectedHostId,
      operationId: "resident-provision-operation",
      projectId: "resident-project",
      workspaceId: "resident-workspace",
      threadId: "resident-thread",
      executionGenerationId: "resident-execution",
      workspaceDirectory,
      projectDisplayName: "Workspace project",
      threadTitle: "First resident thread",
      createdAt: "2026-08-08T12:00:00.000Z",
      sessionName: "Resident thread",
    },
  } as const satisfies Extract<HostIpcRequest, { method: "resident.provision" }>;
}

interface ResidentGatewayProvisionInput {
  operationId: string;
  expectedHostId: string;
  projectId: string;
  workspaceId: string;
  threadId: string;
  executionGenerationId: string;
}

function residentLifecycleInput(request: ResidentGatewayProvisionInput) {
  return {
    operationId: request.operationId,
    expectedHostId: request.expectedHostId,
    projectId: request.projectId,
    workspaceId: request.workspaceId,
    threadId: request.threadId,
    executionGenerationId: request.executionGenerationId,
    requestDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
  };
}

function residentLifecycleGateway(store: HostStore): PrimeAgentGateway & {
  residentLifecycleCapabilityReady: ReturnType<typeof vi.fn>;
  provisionResident: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    continuity: "resident",
    isLive: vi.fn(async () => false),
    capabilityReady: vi.fn(async () => false),
    residentLifecycleCapabilityReady: vi.fn(async () => true),
    provisionResident: vi.fn(async (request: ResidentGatewayProvisionInput) =>
      store.prepareResidentProvision(residentLifecycleInput(request))),
    submit: vi.fn(async () => ({ disposition: "accepted" as const })),
    close: vi.fn(async () => undefined),
  };
}
