import { bootstrapTestWorkspace } from "./test-workspace-fixture";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type CommandEnvelope, type SavedProject } from "../../src/shared/protocol";
import {
  PairingAuthority,
  deriveNoisePublicKeyFingerprint,
  type DeviceGrantRecord,
} from "../../src/hostd/pairing/authority";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";
import {
  createTestAuthenticatedRelaySessions,
  type TestAuthenticatedRelaySessions,
} from "../helpers/validated-relay-session";
import {
  createTestVerifiedPairingCeremonies,
  type TestVerifiedPairingCeremonies,
} from "../helpers/validated-pairing-ceremony";

const temporaryDirectories: string[] = [];
const relaySessionsByAuthority = new WeakMap<PairingAuthority, TestAuthenticatedRelaySessions>();
const pairingCeremoniesByAuthority = new WeakMap<PairingAuthority, TestVerifiedPairingCeremonies>();

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HostService handoff availability", () => {
  it("does not advertise the unavailable thread handoff capability", async () => {
    const { service } = await temporaryService();

    const response = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "health-capabilities",
      method: "health.get",
      payload: {},
    }, TRUSTED_USER_SESSION);

    expect(response.ok).toBe(true);
    if (!response.ok || response.method !== "health.get") throw new Error("health request failed");
    expect(response.result.capabilities).not.toContain("thread_handoff_v1");
  });

  it("returns review data but marks even an otherwise clean handoff plan unavailable", async () => {
    const { service, store } = await temporaryService();
    const response = await requestReviewablePlan(service, store);

    expect(response.ok).toBe(true);
    if (!response.ok || response.method !== "handoff.plan") throw new Error("handoff plan request failed");
    expect(response.result).toMatchObject({
      threadId: "test-thread",
      repositoryMatch: "exact",
      executable: false,
      source: {
        projectId: "test-project",
        executionGenerationId: "test-execution-1",
      },
      destination: {
        hostId: "destination-host",
        projectId: "destination-project",
        workspaceId: "destination-workspace",
      },
    });
    expect(response.result.transferBytesEstimate).toBeGreaterThan(0);
    expect(response.result.runtimeStateLosses.length).toBeGreaterThan(0);
    expect(response.result.warnings).toContainEqual({
      code: "DESTINATION_TRANSFER_UNAVAILABLE",
      message: "Cross-host checkpoint transfer is deferred until the Phase 2 destination coordinator is installed.",
      blocking: true,
    });
  });

  it("rejects handoff commit without switching source authority or journaling the command", async () => {
    const { service, store } = await temporaryService();
    const planResponse = await requestReviewablePlan(service, store);
    if (!planResponse.ok || planResponse.method !== "handoff.plan") throw new Error("handoff plan request failed");
    const host = await store.getHost();
    const before = await store.getThreadSnapshot("test-thread");
    const identity = { deviceId: "device-test", commandId: "service-handoff-command" };

    const response = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "handoff-commit-unavailable",
      method: "handoff.commit",
      payload: { handoffId: planResponse.result.handoffId, expectedHostId: host.hostId, ...identity },
    }, TRUSTED_USER_SESSION);

    expect(response).toMatchObject({
      requestId: "handoff-commit-unavailable",
      method: "handoff.commit",
      ok: false,
      error: {
        code: "HANDOFF_COORDINATOR_UNAVAILABLE",
        retryable: false,
      },
    });
    const after = await store.getThreadSnapshot("test-thread");
    expect(after.thread.currentLocation).toEqual(before.thread.currentLocation);
  });

  it("durably rejects commands when the default gateway is unavailable without queueing them", async () => {
    const { service, store } = await temporaryService();
    const host = await store.getHost();
    const command: CommandEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: "device-test",
      commandId: "gateway-unavailable-command",
      expectedHostId: host.hostId,
      threadId: "test-thread",
      issuedAt: new Date().toISOString(),
      expectedExecutionGenerationId: "test-execution-1",
      command: { kind: "prompt", text: "Do not queue this without an execution gateway." },
    };

    const response = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "gateway-unavailable-submit",
      method: "command.submit",
      payload: { command },
    }, TRUSTED_USER_SESSION);

    expect(response.ok).toBe(true);
    if (!response.ok || response.method !== "command.submit") throw new Error("command submit request failed");
    expect(response.result).toMatchObject({
      deviceId: command.deviceId,
      commandId: command.commandId,
      status: "rejected",
      error: { code: "GATEWAY_UNAVAILABLE", retryable: true },
    });
    expect(response.result.queuePosition).toBeUndefined();
    expect((await store.getThreadSnapshot(command.threadId)).queueState.pendingCommandIds).not.toContain(
      command.commandId,
    );
    expect((await store.reconcileCommands([command])).receipts).toEqual([response.result]);

    const journalStatuses = (await readFile(store.paths.commandJournal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { status: string }).status);
    expect(journalStatuses).toEqual(["received", "rejected"]);
  });

  it("rejects commands and reconciliation identities composed for another host authority", async () => {
    const { service, store } = await temporaryService();
    const host = await store.getHost();
    const command: CommandEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: "device-test",
      commandId: "wrong-host-command",
      expectedHostId: "different-host",
      threadId: "test-thread",
      issuedAt: new Date().toISOString(),
      expectedExecutionGenerationId: "test-execution-1",
      command: { kind: "prompt", text: "This must never reach the wrong host journal." },
    };

    const submit = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "wrong-host-submit",
      method: "command.submit",
      payload: { command },
    }, TRUSTED_USER_SESSION);
    expect(submit).toMatchObject({
      ok: false,
      error: { code: "HOST_AUTHORITY_MISMATCH", retryable: false },
    });
    expect((await store.reconcileCommands([command])).unknown).toEqual([
      { deviceId: command.deviceId, commandId: command.commandId },
    ]);

    const reconcile = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "wrong-host-reconcile",
      method: "command.reconcile",
      payload: {
        expectedHostId: "different-host",
        commands: [command],
      },
    }, TRUSTED_USER_SESSION);
    expect(reconcile).toMatchObject({
      ok: false,
      error: { code: "HOST_AUTHORITY_MISMATCH", retryable: false },
    });
    const envelopeMismatch = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "wrong-envelope-host-reconcile",
      method: "command.reconcile",
      payload: {
        expectedHostId: host.hostId,
        commands: [command],
      },
    }, TRUSTED_USER_SESSION);
    expect(envelopeMismatch).toMatchObject({
      ok: false,
      error: { code: "HOST_AUTHORITY_MISMATCH", retryable: false },
    });
    expect(host.hostId).not.toBe("different-host");
  });

  it("rejects a command that omits host authority before it reaches the journal", async () => {
    const { service, store } = await temporaryService();
    const command = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: "device-test",
      commandId: "missing-host-command",
      threadId: "test-thread",
      issuedAt: new Date().toISOString(),
      command: { kind: "prompt", text: "This request must fail schema validation." },
    };

    const response = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "missing-host-submit",
      method: "command.submit",
      payload: { command },
    }, TRUSTED_USER_SESSION);

    expect(response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", retryable: false },
    });
  });

  it("fails closed when a transport caller omits its session context", async () => {
    const { service } = await temporaryService();
    const response = await Reflect.apply(service.handle, service, [{
      protocolVersion: PROTOCOL_VERSION,
      requestId: "missing-session-context",
      method: "health.get",
      payload: {},
    }]);

    expect(response).toMatchObject({
      ok: false,
      error: { code: "SESSION_CONTEXT_REQUIRED", retryable: false },
    });
  });

  it("enforces authenticated relay identity and granular scopes before dispatch", async () => {
    const { service, store, pairingAuthority, relayDevice } = await temporaryService();
    const host = await store.getHost();
    const projectionChannel = await registerTestChannel(pairingAuthority, host.hostId, relayDevice, 1);
    const projection = await service.handle(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "relay-catalog",
        method: "catalog.snapshot",
        payload: {},
      },
      { transport: "relay", channel: projectionChannel.lease },
    );
    expect(projection.ok).toBe(true);

    const forgedChannel = await service.handle(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "relay-forged-channel",
        method: "catalog.snapshot",
        payload: {},
      },
      { transport: "relay", channel: { leaseId: "A".repeat(43), channelId: "0".repeat(32) } },
    );
    expect(forgedChannel).toMatchObject({ ok: false, error: { code: "CHANNEL_LEASE_INVALID" } });

    const command: CommandEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: relayDevice.deviceId,
      commandId: "relay-follow-up",
      expectedHostId: host.hostId,
      threadId: "test-thread",
      issuedAt: new Date().toISOString(),
      expectedExecutionGenerationId: "test-execution-1",
      command: { kind: "follow_up", text: "Continue from the phone." },
    };
    const denied = await service.handle(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "relay-scope-denied",
        method: "command.submit",
        payload: { command },
      },
      { transport: "relay", channel: projectionChannel.lease },
    );
    expect(denied).toMatchObject({ ok: false, error: { code: "REMOTE_SCOPE_DENIED" } });
    expect((await store.reconcileCommands([command])).unknown).toEqual([
      expect.objectContaining({ deviceId: command.deviceId, commandId: command.commandId }),
    ]);

    const followUpGrant = await pairingAuthority.changeDeviceScopes({
      expectedHostId: host.hostId,
      expectedHostIdentityEpoch: relayDevice.hostIdentityEpoch,
      fingerprint: relayDevice.fingerprint,
      expectedGrantVersion: relayDevice.grantVersion,
      scopes: ["thread.follow_up"],
    });
    const followUpChannel = await registerTestChannel(pairingAuthority, host.hostId, followUpGrant, 2);
    const spoofed = await service.handle(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "relay-device-spoof",
        method: "command.submit",
        payload: { command: { ...command, deviceId: "mobile-b", commandId: "spoofed-command" } },
      },
      { transport: "relay", channel: followUpChannel.lease },
    );
    expect(spoofed).toMatchObject({ ok: false, error: { code: "REMOTE_DEVICE_IDENTITY_MISMATCH" } });
    expect(
      (await store.reconcileCommands([{ ...command, deviceId: "mobile-b", commandId: "spoofed-command" }])).unknown,
    ).toEqual([{ deviceId: "mobile-b", commandId: "spoofed-command" }]);

    const startCommand: CommandEnvelope = {
      ...command,
      commandId: "relay-start-command",
      command: { kind: "prompt", text: "Start a new run from the phone." },
    };
    const startDenied = await service.handle(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "relay-start-denied",
        method: "command.submit",
        payload: { command: startCommand },
      },
      { transport: "relay", channel: followUpChannel.lease },
    );
    expect(startDenied).toMatchObject({ ok: false, error: { code: "REMOTE_SCOPE_DENIED" } });
    expect((await store.reconcileCommands([startCommand])).unknown).toEqual([
      expect.objectContaining({ deviceId: startCommand.deviceId, commandId: startCommand.commandId }),
    ]);

    const startGrant = await pairingAuthority.changeDeviceScopes({
      expectedHostId: host.hostId,
      expectedHostIdentityEpoch: followUpGrant.hostIdentityEpoch,
      fingerprint: followUpGrant.fingerprint,
      expectedGrantVersion: followUpGrant.grantVersion,
      scopes: ["thread.start"],
    });
    const startChannel = await registerTestChannel(pairingAuthority, host.hostId, startGrant, 3);
    const startAuthorized = await service.handle(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "relay-start-authorized",
        method: "command.submit",
        payload: { command: startCommand },
      },
      { transport: "relay", channel: startChannel.lease },
    );
    expect(startAuthorized).toMatchObject({
      ok: true,
      result: { status: "rejected", error: { code: "GATEWAY_UNAVAILABLE" } },
    });

    const handoffGrant = await pairingAuthority.changeDeviceScopes({
      expectedHostId: host.hostId,
      expectedHostIdentityEpoch: startGrant.hostIdentityEpoch,
      fingerprint: startGrant.fingerprint,
      expectedGrantVersion: startGrant.grantVersion,
      scopes: ["run_location.change"],
    });
    const handoffChannel = await registerTestChannel(pairingAuthority, host.hostId, handoffGrant, 4);
    const handoffSpoof = await service.handle(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "relay-handoff-device-spoof",
        method: "handoff.commit",
        payload: {
          handoffId: "handoff-relay-spoof",
          expectedHostId: host.hostId,
          deviceId: "mobile-b",
          commandId: "handoff-spoofed-command",
        },
      },
      { transport: "relay", channel: handoffChannel.lease },
    );
    expect(handoffSpoof).toMatchObject({
      ok: false,
      error: { code: "REMOTE_DEVICE_IDENTITY_MISMATCH" },
    });
  });

  it("denies relay model selection without its exact scope before durable mutation admission", async () => {
    const { service, store, pairingAuthority, relayDevice } = await temporaryService();
    const host = await store.getHost();
    const projectionChannel = await registerTestChannel(pairingAuthority, host.hostId, relayDevice, 19);
    const command: CommandEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: relayDevice.deviceId,
      commandId: "relay-model-selection-scope-canary",
      expectedHostId: host.hostId,
      threadId: "test-thread",
      issuedAt: "2026-08-10T12:00:00.000Z",
      expectedExecutionGenerationId: "test-execution-1",
      command: {
        kind: "model.select",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
      },
    };

    const response = await service.handle(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: "relay-model-selection-scope-denied",
        method: "command.submit",
        payload: { command },
      },
      { transport: "relay", channel: projectionChannel.lease },
    );

    expect(response).toMatchObject({ ok: false, error: { code: "REMOTE_SCOPE_DENIED" } });
    expect((await store.reconcileCommands([command])).unknown).toEqual([
      { deviceId: command.deviceId, commandId: command.commandId },
    ]);
    await service.close();
  });

  it("does not repurpose approval scope for native dialog responses", async () => {
    const { service, store, pairingAuthority, relayDevice } = await temporaryService();
    const host = await store.getHost();
    const approvalGrant = await pairingAuthority.changeDeviceScopes({
      expectedHostId: host.hostId,
      expectedHostIdentityEpoch: relayDevice.hostIdentityEpoch,
      fingerprint: relayDevice.fingerprint,
      expectedGrantVersion: relayDevice.grantVersion,
      scopes: ["approval.resolve"],
    });
    const approvalChannel = await registerTestChannel(pairingAuthority, host.hostId, approvalGrant, 21);
    const command: CommandEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: relayDevice.deviceId,
      commandId: "relay-extension-ui-scope-canary",
      expectedHostId: host.hostId,
      threadId: "test-thread",
      issuedAt: "2026-08-12T12:00:00.000Z",
      expectedExecutionGenerationId: "test-execution-1",
      command: {
        kind: "extension_ui.respond",
        requestId: "dialog-one",
        requestDigest: "a".repeat(64),
        method: "confirm",
        response: { kind: "confirmed", confirmed: true },
      },
    };

    const response = await service.handle({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "relay-extension-ui-scope-denied",
      method: "command.submit",
      payload: { command },
    }, { transport: "relay", channel: approvalChannel.lease });

    expect(response).toMatchObject({ ok: false, error: { code: "REMOTE_SCOPE_DENIED" } });
    expect((await store.reconcileCommands([command])).unknown).toEqual([
      { deviceId: command.deviceId, commandId: command.commandId },
    ]);
    await service.close();
  });

  it("reveals resident control state only through a current authenticated projection-read channel", async () => {
    const { service, store, pairingAuthority, relayDevice, workspaceDirectory } = await temporaryService();
    const host = await store.getHost();
    await store.persistResidentSessionBinding(serviceResidentBinding(workspaceDirectory));
    const projectionChannel = await registerTestChannel(pairingAuthority, host.hostId, relayDevice, 20);
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "relay-resident-control",
      method: "thread.control.snapshot",
      payload: {
        expectedHostId: host.hostId,
        threadId: "test-thread",
        expectedExecutionGenerationId: "test-execution-1",
      },
    } as const;

    const allowed = await service.handle(request, { transport: "relay", channel: projectionChannel.lease });
    expect(allowed).toMatchObject({
      ok: true,
      method: "thread.control.snapshot",
      result: {
        quiescence: { state: "uncertain", reason: "lifecycle_transition" },
        controlSequence: 0,
      },
    });

    const forged = await service.handle(
      { ...request, requestId: "relay-resident-control-forged" },
      {
        transport: "relay",
        channel: { ...projectionChannel.lease, channelId: "f".repeat(32) },
      },
    );
    expect(forged).toMatchObject({ ok: false, error: { code: "CHANNEL_LEASE_INVALID" } });

    const reducedGrant = await pairingAuthority.changeDeviceScopes({
      expectedHostId: host.hostId,
      expectedHostIdentityEpoch: relayDevice.hostIdentityEpoch,
      fingerprint: relayDevice.fingerprint,
      expectedGrantVersion: relayDevice.grantVersion,
      scopes: ["thread.follow_up"],
    });
    const stale = await service.handle(
      { ...request, requestId: "relay-resident-control-stale" },
      { transport: "relay", channel: projectionChannel.lease },
    );
    expect(stale).toMatchObject({ ok: false, error: { code: "CHANNEL_LEASE_INVALID" } });

    const reducedChannel = await registerTestChannel(pairingAuthority, host.hostId, reducedGrant, 21);
    const denied = await service.handle(
      { ...request, requestId: "relay-resident-control-scope-denied" },
      { transport: "relay", channel: reducedChannel.lease },
    );
    expect(denied).toMatchObject({ ok: false, error: { code: "REMOTE_SCOPE_DENIED" } });
    await service.close();
  });
});

async function temporaryService(): Promise<{
  service: HostService;
  store: HostStore;
  pairingAuthority: PairingAuthority;
  relayDevice: DeviceGrantRecord;
  workspaceDirectory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "prime-hostd-service-test-"));
  temporaryDirectories.push(directory);
  const store = new HostStore(directory);
  await store.initialize();
  const workspace = await bootstrapTestWorkspace(store);
  const host = await store.getHost();
  const relaySessions = createTestAuthenticatedRelaySessions();
  const pairingCeremonies = createTestVerifiedPairingCeremonies();
  const pairingAuthority = new PairingAuthority(store.paths.pairingAuthority, {
    allowTestTicketIds: true,
    authenticatedSessionAdmission: relaySessions.admission,
    verifiedPairingCeremonyAdmission: pairingCeremonies.admission,
  });
  relaySessionsByAuthority.set(pairingAuthority, relaySessions);
  pairingCeremoniesByAuthority.set(pairingAuthority, pairingCeremonies);
  const hostPublicKey = Buffer.alloc(32, 0x41).toString("base64url");
  await pairingAuthority.initialize({
    hostId: host.hostId,
    identity: {
      identityEpoch: 1,
      algorithm: "Noise_25519",
      publicKeyB64u: hostPublicKey,
      secretRef: "test-only://host-noise-key",
    },
  });
  const serviceWithVerifiedIdentity = new HostService(store, undefined, pairingAuthority, {
    hostIdentityProvider: {
      backend: "test-secure-store",
      async loadExisting({ hostId }) {
        return {
          status: "ready",
          hostId,
          identity: {
            identityEpoch: 1,
            algorithm: "Noise_25519",
            publicKeyB64u: hostPublicKey,
            secretRef: "test-only://host-noise-key",
          },
        };
      },
      close() {},
    },
  });
  await serviceWithVerifiedIdentity.initialize();
  const relayDevice = await pairTestDevice(pairingAuthority, host.hostId);
  return {
    service: serviceWithVerifiedIdentity,
    store,
    pairingAuthority,
    relayDevice,
    workspaceDirectory: workspace.workspaceDirectory,
  };
}

function serviceResidentBinding(workspaceDirectory: string): ResidentSessionBinding {
  return {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId: "test-thread",
    executionGenerationId: "test-execution-1",
    workspaceDirectory,
    activeSessionId: "service-resident-control-active",
    sessionId: "service-resident-control-session",
    sessionFile: join(workspaceDirectory, ".prime-agent", "service-resident-control.jsonl"),
    boundAt: "2026-08-08T12:05:00.000Z",
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

async function pairTestDevice(authority: PairingAuthority, hostId: string): Promise<DeviceGrantRecord> {
  const ceremonies = pairingCeremoniesByAuthority.get(authority);
  if (!ceremonies) throw new Error("Missing test pairing-ceremony provider for authority");
  const publicKeyB64u = Buffer.alloc(32, 0x52).toString("base64url");
  await authority.createTicket({
    expectedHostId: hostId,
    ticketId: "service-test-ticket",
    relayOrigin: "wss://relay.service.test",
    requestedScopes: [
      "projection.read",
      "thread.follow_up",
      "thread.start",
      "model.select",
      "approval.resolve",
      "extension_ui.respond",
      "run_location.change",
    ],
    ttlSeconds: 300,
  });
  await authority.reserveVerifiedTicket(ceremonies.issueReservation({
    expectedHostId: hostId,
    ticketId: "service-test-ticket",
    reservationId: "service-test-reservation",
  }));
  return authority.commitVerifiedPairing(ceremonies.issueCommit({
    expectedHostId: hostId,
    expectedHostIdentityEpoch: 1,
    ticketId: "service-test-ticket",
    reservationId: "service-test-reservation",
    publicKeyB64u,
    authenticatedFingerprint: deriveNoisePublicKeyFingerprint(publicKeyB64u),
    displayName: "Service test phone",
    kind: "mobile",
    grantedScopes: ["projection.read"],
  }));
}

async function registerTestChannel(
  authority: PairingAuthority,
  hostId: string,
  device: DeviceGrantRecord,
  channelNumber: number,
) {
  const relaySessions = relaySessionsByAuthority.get(authority);
  if (!relaySessions) throw new Error("Missing test relay-session provider for authority");
  const session = await relaySessions.issueHost({
    hostId,
    hostPublicKeyB64u: Buffer.alloc(32, 0x41).toString("base64url"),
    device,
    channelId: channelNumber.toString(16).padStart(32, "0"),
  });
  return authority.registerAuthenticatedChannel(session);
}

async function requestReviewablePlan(service: HostService, store: HostStore) {
  const catalog = await store.getCatalogSnapshot();
  const host = await store.getHost();
  const source = catalog.projects[0];
  if (!source) throw new Error("test project missing");
  const repositoryIdentity = {
    version: 1 as const,
    canonicalRemotes: ["ssh://git.example/prime/test.git"],
    defaultBranch: "main",
  };
  await store.upsertProject({ ...source, repositoryIdentity });
  const destination: SavedProject = {
    projectId: "destination-project",
    hostId: "destination-host",
    workspaceId: "destination-workspace",
    displayName: "Destination project",
    repositoryIdentity,
    lastOpenedAt: new Date().toISOString(),
  };
  await store.upsertProject(destination);

  return service.handle({
    protocolVersion: PROTOCOL_VERSION,
    requestId: "review-handoff-plan",
    method: "handoff.plan",
    payload: {
      expectedHostId: host.hostId,
      request: {
        threadId: "test-thread",
        sourceGenerationId: "test-execution-1",
        destinationHostId: destination.hostId,
        destinationProjectId: destination.projectId,
        behaviorIfRunning: "interrupt",
      },
    },
  }, TRUSTED_USER_SESSION);
}
