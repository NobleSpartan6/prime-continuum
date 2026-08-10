import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrimeAgentGateway } from "../../src/hostd/gateway";
import type { VerifiedInstalledRuntimeHandle } from "../../src/hostd/runtime-integrity-manager";
import {
  HostService,
  SSH_BRIDGE_SESSION,
  TRUSTED_USER_SESSION,
} from "../../src/hostd/service";
import { HostStore, type HostStoreOptions } from "../../src/hostd/store";
import { VerifiedResidentGateway } from "../../src/hostd/verified-resident-gateway";
import { residentProvisionRequestDigest } from "../../src/hostd/resident-lifecycle-coordinator";
import { bootstrapTestWorkspace, type TestWorkspaceFixture } from "./test-workspace-fixture";
import {
  PRIME_AGENT_COMMAND_CAPABILITY,
  PROTOCOL_VERSION,
  RESIDENT_LIFECYCLE_CAPABILITY,
  RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY,
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
    expect(health.result.capabilities).toContain(RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY);

    const response = await service.handle(request, SSH_BRIDGE_SESSION);

    expect(response).toMatchObject({
      ok: false,
      method: "resident.provision",
      error: { code: "REMOTE_RESIDENT_LIFECYCLE_FORBIDDEN", retryable: false },
    });
    expect(gateway.residentLifecycleCapabilityReady).toHaveBeenCalledOnce();
    expect(gateway.provisionResident).not.toHaveBeenCalled();
    expect((await store.getCatalogSnapshot()).projects).toHaveLength(0);
    await service.close();
  });

  it("provisions an exact saved workspace over SSH while keeping relay and private paths denied", async () => {
    const fixture = await registeredProvisionFixture();
    const { service, store, gateway, workspace, request } = fixture;

    const health = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "registered-provision-health",
      method: "health.get",
      payload: {},
    }, SSH_BRIDGE_SESSION);
    expect(health).toMatchObject({ ok: true, method: "health.get" });
    if (!health.ok || health.method !== "health.get") throw new Error("SSH health failed");
    expect(health.result.capabilities).toContain(RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY);
    expect(health.result.capabilities).not.toContain(RESIDENT_LIFECYCLE_CAPABILITY);

    const response = await service.handle(request, SSH_BRIDGE_SESSION);
    expect(response).toMatchObject({
      ok: true,
      method: "resident.provision.registered",
      result: {
        operationId: request.payload.operationId,
        phase: "prepared",
        projectId: workspace.project.projectId,
        workspaceId: workspace.project.workspaceId,
        threadId: request.payload.threadId,
      },
    });
    expect(JSON.stringify(response)).not.toContain(workspace.workspaceDirectory);
    expect(JSON.stringify(response)).not.toMatch(/workspaceDirectory|projectDisplayName|repository/);
    expect(gateway.provisionResident).toHaveBeenCalledWith({
      operationId: request.payload.operationId,
      expectedHostId: request.payload.expectedHostId,
      projectId: request.payload.projectId,
      workspaceId: request.payload.workspaceId,
      threadId: request.payload.threadId,
      executionGenerationId: request.payload.executionGenerationId,
      selection: { kind: "new", sessionName: "Remote resident" },
    });
    await expect(store.resolveWorkspaceDirectory(
      request.payload.threadId,
      request.payload.executionGenerationId,
    )).resolves.toBe(workspace.workspaceDirectory);

    const relay = await service.handle({ ...request, requestId: "registered-provision-relay" }, {
      transport: "relay",
      channel: {} as never,
    });
    expect(relay).toMatchObject({
      ok: false,
      method: "resident.provision.registered",
      error: { code: "REMOTE_RESIDENT_LIFECYCLE_FORBIDDEN", retryable: false },
    });
    expect(gateway.provisionResident).toHaveBeenCalledOnce();

    gateway.residentLifecycleCapabilityReady.mockResolvedValue(false);
    const withdrawn = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "registered-provision-withdrawn-health",
      method: "health.get",
      payload: {},
    }, SSH_BRIDGE_SESSION);
    expect(withdrawn).toMatchObject({ ok: true, method: "health.get" });
    if (!withdrawn.ok || withdrawn.method !== "health.get") throw new Error("SSH health failed");
    expect(withdrawn.result.capabilities).not.toContain(RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY);
    const status = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "registered-provision-recovery-status",
      method: "resident.lifecycle.status",
      payload: {
        expectedHostId: request.payload.expectedHostId,
        operationId: request.payload.operationId,
      },
    }, SSH_BRIDGE_SESSION);
    expect(status).toMatchObject({
      ok: true,
      method: "resident.lifecycle.status",
      result: { status: { operationId: request.payload.operationId, phase: "prepared" } },
    });
    await service.close();
  });

  it("rejects a registered donor path swapped between reservation and bootstrap without admitting work", async () => {
    let swapRegisteredWorkspace: (() => Promise<void>) | undefined;
    const fixture = await registeredProvisionFixture({
      async registeredWorkspaceBootstrapBeforeCanonicalRecheck() {
        await swapRegisteredWorkspace?.();
      },
    });
    const replacement = join(dirname(fixture.workspace.workspaceDirectory), "replacement-workspace");
    await mkdir(replacement);
    swapRegisteredWorkspace = async () => {
      swapRegisteredWorkspace = undefined;
      await rm(fixture.workspace.workspaceDirectory, { recursive: true, force: true });
      await symlink(
        replacement,
        fixture.workspace.workspaceDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    };
    const catalogBefore = await fixture.store.getCatalogSnapshot();
    const bootstrapOperationsBefore = await readdir(
      fixture.store.paths.workspaceThreadBootstrapOperations,
    );

    const response = await fixture.service.handle(fixture.request, SSH_BRIDGE_SESSION);

    expect(response).toMatchObject({
      ok: false,
      method: "resident.provision.registered",
      error: { code: "REGISTERED_WORKSPACE_PATH_CHANGED", retryable: false },
    });
    expect(JSON.stringify(response)).not.toContain(fixture.workspace.workspaceDirectory);
    expect(fixture.gateway.provisionResident).not.toHaveBeenCalled();
    const catalogAfter = await fixture.store.getCatalogSnapshot();
    expect(catalogAfter.projects).toEqual(catalogBefore.projects);
    expect(catalogAfter.threads).toEqual(catalogBefore.threads);
    expect(await readdir(fixture.store.paths.workspaceThreadBootstrapOperations))
      .toEqual(bootstrapOperationsBefore);
    expect(await fixture.store.getResidentLifecycleStatus(
      fixture.request.payload.operationId,
    )).toBeUndefined();
    await expect(fixture.store.resolveWorkspaceDirectory(
      fixture.request.payload.threadId,
      fixture.request.payload.executionGenerationId,
    )).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    await fixture.service.close();
  });

  it("rejects the same registered donor swap on an exact retry without new admission", async () => {
    let swapRegisteredWorkspace: (() => Promise<void>) | undefined;
    const fixture = await registeredProvisionFixture({
      async registeredWorkspaceBootstrapBeforeCanonicalRecheck() {
        await swapRegisteredWorkspace?.();
      },
    });
    await expect(fixture.service.handle(
      fixture.request,
      SSH_BRIDGE_SESSION,
    )).resolves.toMatchObject({
      ok: true,
      method: "resident.provision.registered",
      result: { operationId: fixture.request.payload.operationId, phase: "prepared" },
    });
    expect(fixture.gateway.provisionResident).toHaveBeenCalledOnce();
    const catalogBefore = await fixture.store.getCatalogSnapshot();
    const lifecycleBefore = await fixture.store.getResidentLifecycleStatus(
      fixture.request.payload.operationId,
    );
    const bootstrapOperationsBefore = await readdir(
      fixture.store.paths.workspaceThreadBootstrapOperations,
    );
    const replacement = join(dirname(fixture.workspace.workspaceDirectory), "retry-replacement-workspace");
    await mkdir(replacement);
    swapRegisteredWorkspace = async () => {
      swapRegisteredWorkspace = undefined;
      await rm(fixture.workspace.workspaceDirectory, { recursive: true, force: true });
      await symlink(
        replacement,
        fixture.workspace.workspaceDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    };

    const response = await fixture.service.handle({
      ...fixture.request,
      requestId: "registered-provision-path-swap-retry",
    }, SSH_BRIDGE_SESSION);

    expect(response).toMatchObject({
      ok: false,
      method: "resident.provision.registered",
      error: { code: "REGISTERED_WORKSPACE_PATH_CHANGED", retryable: false },
    });
    expect(fixture.gateway.provisionResident).toHaveBeenCalledOnce();
    const catalogAfter = await fixture.store.getCatalogSnapshot();
    expect(catalogAfter.projects).toEqual(catalogBefore.projects);
    expect(catalogAfter.threads).toEqual(catalogBefore.threads);
    expect(await fixture.store.getResidentLifecycleStatus(
      fixture.request.payload.operationId,
    )).toEqual(lifecycleBefore);
    expect(await readdir(fixture.store.paths.workspaceThreadBootstrapOperations))
      .toEqual(bootstrapOperationsBefore);
    await fixture.service.close();
  });

  it("admits only one lifecycle/provider call for concurrent SSH starts on one saved workspace", async () => {
    const fixture = await registeredProvisionFixture();
    const enteredProvider = deferred<void>();
    const releaseProvider = deferred<void>();
    fixture.gateway.provisionResident.mockImplementationOnce(async (request: ResidentGatewayProvisionInput) => {
      enteredProvider.resolve(undefined);
      await releaseProvider.promise;
      return fixture.store.prepareResidentProvision(residentLifecycleInput(request));
    });
    const competing = {
      ...fixture.request,
      requestId: "registered-provision-competing-request",
      payload: {
        ...fixture.request.payload,
        operationId: "registered-provision-competing-operation",
        threadId: "registered-competing-thread",
        executionGenerationId: "registered-competing-execution",
        threadTitle: "Competing remote resident",
      },
    } as const satisfies Extract<HostIpcRequest, { method: "resident.provision.registered" }>;

    const firstResponse = fixture.service.handle(fixture.request, SSH_BRIDGE_SESSION);
    await enteredProvider.promise;
    const secondResponse = await fixture.service.handle(competing, SSH_BRIDGE_SESSION);
    expect(secondResponse).toMatchObject({
      ok: false,
      method: "resident.provision.registered",
      error: { code: "REGISTERED_WORKSPACE_LIFECYCLE_IN_PROGRESS" },
    });
    expect(fixture.gateway.provisionResident).toHaveBeenCalledOnce();

    releaseProvider.resolve(undefined);
    await expect(firstResponse).resolves.toMatchObject({
      ok: true,
      method: "resident.provision.registered",
      result: { operationId: fixture.request.payload.operationId, phase: "prepared" },
    });
    expect(fixture.gateway.provisionResident).toHaveBeenCalledOnce();
    await fixture.service.close();
  });

  it("recovers a committed registered bootstrap as prepared without replaying provider work", async () => {
    let crashArmed = false;
    const fixture = await registeredProvisionFixture({
      workspaceThreadBootstrapFaultInjector(point) {
        if (crashArmed && point === "after_committed") {
          throw new Error("simulated crash after committed registered bootstrap");
        }
      },
    });
    crashArmed = true;

    const interrupted = await fixture.service.handle(fixture.request, SSH_BRIDGE_SESSION);
    expect(interrupted).toMatchObject({
      ok: false,
      method: "resident.provision.registered",
    });
    expect(fixture.gateway.provisionResident).not.toHaveBeenCalled();
    await fixture.service.close();

    const restarted = new HostStore(fixture.store.paths.root);
    await restarted.initialize();
    await expect(restarted.getResidentLifecycleStatus(
      fixture.request.payload.operationId,
    )).resolves.toMatchObject({
      operationId: fixture.request.payload.operationId,
      kind: "provision",
      phase: "prepared",
    });

    const continuationGateway = residentLifecycleGateway(restarted);
    const continuationService = new HostService(restarted, continuationGateway);
    expect(continuationGateway.provisionResident).not.toHaveBeenCalled();
    const continued = await continuationService.handle({
      ...fixture.request,
      requestId: "registered-provision-after-bootstrap-crash",
    }, SSH_BRIDGE_SESSION);
    expect(continued).toMatchObject({
      ok: true,
      method: "resident.provision.registered",
      result: {
        operationId: fixture.request.payload.operationId,
        phase: "prepared",
      },
    });
    expect(continuationGateway.provisionResident).toHaveBeenCalledOnce();
    await continuationService.close();
  });

  it("omits lifecycle readiness and persists nothing when the verified Worker preflight fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-resident-preflight-failure-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const workspaceDirectory = await realpath(workspacePath);
    const store = new HostStore(join(directory, "data"));
    await store.initialize();
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
  await store.initialize();
  const host = await store.getHost();
  const gateway = residentLifecycleGateway(store);
  const service = new HostService(store, gateway);
  const request = residentProvisionRequest(host.hostId, workspaceDirectory);
  return { service, store, gateway, workspaceDirectory, request };
}

async function registeredProvisionFixture(options: HostStoreOptions = {}): Promise<{
  service: HostService;
  store: HostStore;
  gateway: ReturnType<typeof residentLifecycleGateway>;
  workspace: TestWorkspaceFixture;
  request: Extract<HostIpcRequest, { method: "resident.provision.registered" }>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "prime-registered-provision-service-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspaceDirectory = await realpath(workspacePath);
  const store = new HostStore(join(directory, "data"), options);
  await store.initialize();
  const workspace = await bootstrapTestWorkspace(store, {
    operationId: "registered-reference-bootstrap",
    workspaceDirectory,
    projectId: "registered-project",
    workspaceId: "registered-workspace",
    threadId: "registered-reference-thread",
    executionGenerationId: "registered-reference-execution",
  });
  const gateway = residentLifecycleGateway(store);
  const service = new HostService(store, gateway);
  const request = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: "registered-provision-request",
    method: "resident.provision.registered",
    payload: {
      expectedHostId: workspace.hostId,
      operationId: "registered-provision-operation",
      projectId: workspace.project.projectId,
      workspaceId: workspace.project.workspaceId,
      referenceThreadId: workspace.thread.threadId,
      referenceExecutionGenerationId: workspace.thread.currentLocation.executionGenerationId,
      threadId: "registered-new-thread",
      executionGenerationId: "registered-new-execution",
      threadTitle: "Remote resident thread",
      createdAt: "2026-08-08T13:00:00.000Z",
      sessionName: "Remote resident",
    },
  } as const satisfies Extract<HostIpcRequest, { method: "resident.provision.registered" }>;
  return { service, store, gateway, workspace, request };
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
  selection: { kind: "new"; sessionName?: string };
}

function residentLifecycleInput(request: ResidentGatewayProvisionInput) {
  return {
    operationId: request.operationId,
    expectedHostId: request.expectedHostId,
    projectId: request.projectId,
    workspaceId: request.workspaceId,
    threadId: request.threadId,
    executionGenerationId: request.executionGenerationId,
    requestDigest: residentProvisionRequestDigest(request, request.selection),
  };
}

function residentLifecycleGateway(store: HostStore): PrimeAgentGateway & {
  residentLifecycleCapabilityReady: ReturnType<typeof vi.fn>;
  provisionResident: ReturnType<typeof vi.fn>;
  endResident: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    continuity: "resident",
    isLive: vi.fn(async () => false),
    capabilityReady: vi.fn(async () => false),
    residentLifecycleCapabilityReady: vi.fn(async () => true),
    provisionResident: vi.fn(async (request: ResidentGatewayProvisionInput) =>
      store.prepareResidentProvision(residentLifecycleInput(request))),
    endResident: vi.fn(async () => {
      throw new Error("resident end is outside this provisioning fixture");
    }),
    submit: vi.fn(async () => ({ disposition: "accepted" as const })),
    close: vi.fn(async () => undefined),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
