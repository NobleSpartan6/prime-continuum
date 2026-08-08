import { describe, expect, it } from "vitest";
import {
  CommandEnvelopeSchema,
  CommandReconciliationSchema,
  HealthSnapshotSchema,
  HostIpcRequestSchema,
  HostIpcSnapshotTransferEnvelopeSchema,
  MAX_SNAPSHOT_TRANSFER_BYTES,
  MobilePairingPolicySchema,
  PairedDeviceSchema,
  PairingTicketDescriptorSchema,
  PROTOCOL_VERSION,
  RemoteDeviceScopesSchema,
  SNAPSHOT_TRANSFER_CHUNK_BYTES,
  SessionCursorSchema,
  ThreadProjectionSnapshotSchema,
} from "../../src/shared/protocol";

describe("host protocol schemas", () => {
  it("keeps pairing identity readiness backward compatible and secret-free", () => {
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      hostdVersion: "0.1.0",
      startedAt: "2026-08-06T00:00:00.000Z",
      checkedAt: "2026-08-06T00:00:01.000Z",
      serviceState: "ready" as const,
      host: {
        hostId: "host-1",
        displayName: "Local computer",
        kind: "local" as const,
        connectionPaths: [],
        reachability: "online" as const,
        compatibility: "compatible" as const,
        platform: { os: "windows" as const, architecture: "x64" },
        attentionCounts: { total: 0, unread: 0, questions: 0, approvals: 0 },
      },
      capabilities: [],
    };
    expect(HealthSnapshotSchema.parse(base).pairingIdentity).toBeUndefined();
    expect(
      HealthSnapshotSchema.parse({
        ...base,
        pairingIdentity: {
          state: "ready",
          algorithm: "Noise_25519",
          fingerprint: `pa1-${Buffer.alloc(32, 1).toString("base64url")}`,
          identityEpoch: 1,
        },
      }).pairingIdentity,
    ).toMatchObject({ state: "ready", identityEpoch: 1 });
    expect(
      HealthSnapshotSchema.safeParse({
        ...base,
        pairingIdentity: { state: "ready", secretRef: "must-not-cross-health" },
      }).success,
    ).toBe(false);
  });

  it("accepts generation-aware cursors", () => {
    expect(
      SessionCursorSchema.parse({
        threadId: "thread-1",
        executionGenerationId: "execution-2",
        generation: "daemon-generation-3",
        sequence: 99,
      }),
    ).toEqual({
      threadId: "thread-1",
      executionGenerationId: "execution-2",
      generation: "daemon-generation-3",
      sequence: 99,
    });
  });

  it("rejects snapshots whose cursors belong to another thread or execution generation", () => {
    const valid = threadSnapshot();
    expect(ThreadProjectionSnapshotSchema.safeParse(valid).success).toBe(true);
    expect(
      ThreadProjectionSnapshotSchema.safeParse({
        ...valid,
        latestCursor: { ...valid.latestCursor, threadId: "thread-other" },
      }).success,
    ).toBe(false);
    expect(
      ThreadProjectionSnapshotSchema.safeParse({
        ...valid,
        thread: {
          ...valid.thread,
          lastKnownCursor: {
            ...valid.thread.lastKnownCursor,
            executionGenerationId: "execution-other",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("bounds command text and requires protocol v1", () => {
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: "device-1",
      commandId: "command-1",
      expectedHostId: "host-1",
      threadId: "thread-1",
      issuedAt: new Date().toISOString(),
      expectedExecutionGenerationId: "execution-1",
    } as const;
    expect(CommandEnvelopeSchema.safeParse({ ...base, command: { kind: "prompt", text: "hello" } }).success).toBe(true);
    expect(
      CommandEnvelopeSchema.safeParse({ ...base, command: { kind: "prompt", text: "x".repeat(65_537) } }).success,
    ).toBe(false);
    expect(
      CommandEnvelopeSchema.safeParse({
        ...base,
        command: { kind: "prompt", text: "hello", hiddenMutation: true },
      }).success,
    ).toBe(false);
    expect(
      CommandEnvelopeSchema.safeParse({ ...base, hiddenMutation: true, command: { kind: "abort" } }).success,
    ).toBe(false);
    expect(CommandEnvelopeSchema.safeParse({ ...base, protocolVersion: 2, command: { kind: "abort" } }).success).toBe(false);
  });

  it.each([
    { kind: "prompt", text: "hello" },
    { kind: "steer", text: "redirect" },
    { kind: "follow_up", text: "next" },
    { kind: "abort" },
    { kind: "approval.resolve", approvalId: "approval-1", decision: "approve" },
    { kind: "model.select", providerId: "openai", modelId: "gpt-5.6-sol" },
  ] as const)("requires an execution generation for $kind", (command) => {
    expect(
      CommandEnvelopeSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        deviceId: "device-1",
        commandId: `command-${command.kind}`,
        expectedHostId: "host-1",
        threadId: "thread-1",
        issuedAt: "2026-08-07T12:00:00.000Z",
        command,
      }).success,
    ).toBe(false);
  });

  it("bounds model selection and requires an exact execution generation", () => {
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: "device-1",
      commandId: "model-command-1",
      expectedHostId: "host-1",
      threadId: "thread-1",
      issuedAt: new Date().toISOString(),
      expectedExecutionGenerationId: "execution-1",
    } as const;
    const command = { kind: "model.select", providerId: "openai", modelId: "gpt-5.6-sol" } as const;

    expect(CommandEnvelopeSchema.safeParse({ ...base, command }).success).toBe(true);
    expect(
      CommandEnvelopeSchema.safeParse({
        ...base,
        expectedExecutionGenerationId: undefined,
        command,
      }).success,
    ).toBe(false);
    expect(
      CommandEnvelopeSchema.safeParse({
        ...base,
        command: { ...command, providerId: "p".repeat(129) },
      }).success,
    ).toBe(false);
    expect(
      CommandEnvelopeSchema.safeParse({
        ...base,
        command: { ...command, modelId: "m".repeat(513) },
      }).success,
    ).toBe(false);
    expect(
      CommandEnvelopeSchema.safeParse({
        ...base,
        command: { ...command, modelId: "gpt-5\nforged-journal-line" },
      }).success,
    ).toBe(false);
    expect(
      CommandEnvelopeSchema.safeParse({
        ...base,
        command: { ...command, credential: "must-not-cross-the-command-boundary" },
      }).success,
    ).toBe(false);
  });

  it("authorizes model selection with its own least-privilege mobile scope", () => {
    expect(RemoteDeviceScopesSchema.parse(["projection.read", "model.select"])).toEqual([
      "projection.read",
      "model.select",
    ]);
  });

  it("exposes one discriminated IPC request surface", () => {
    const command = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: "device-1",
      commandId: "command-1",
      expectedHostId: "host-1",
      threadId: "thread-1",
      issuedAt: "2026-08-07T12:00:00.000Z",
      expectedExecutionGenerationId: "execution-1",
      command: { kind: "abort" as const },
    };
    const request = HostIpcRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "request-1",
      method: "command.reconcile",
      payload: { expectedHostId: "host-1", commands: [command] },
    });
    expect(request.method).toBe("command.reconcile");
    expect(
      HostIpcRequestSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "empty-reconcile",
        method: "command.reconcile",
        payload: { expectedHostId: "host-1", commands: [] },
      }).success,
    ).toBe(false);
    expect(
      HostIpcRequestSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "oversized-reconcile",
        method: "command.reconcile",
        payload: { expectedHostId: "host-1", commands: [command, { ...command, commandId: "command-2" }] },
      }).success,
    ).toBe(false);
    expect(
      HostIpcRequestSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "request-2",
        method: "command.reconcile",
        payload: {
          expectedHostId: "host-1",
          commands: Array.from({ length: 257 }, (_, index) => ({ deviceId: "device-1", commandId: `c-${index}` })),
        },
      }).success,
    ).toBe(false);
  });

  it("requires exactly one reconciliation outcome", () => {
    const receipt = {
      protocolVersion: PROTOCOL_VERSION,
      receiptId: "receipt-1",
      deviceId: "device-1",
      commandId: "command-1",
      threadId: "thread-1",
      status: "rejected" as const,
      receivedAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z",
      executionGenerationId: "execution-1",
    };
    expect(CommandReconciliationSchema.safeParse({ receipts: [receipt], unknown: [] }).success).toBe(true);
    expect(
      CommandReconciliationSchema.safeParse({
        receipts: [],
        unknown: [{ deviceId: "device-1", commandId: "command-1" }],
      }).success,
    ).toBe(true);
    expect(CommandReconciliationSchema.safeParse({ receipts: [], unknown: [] }).success).toBe(false);
    expect(
      CommandReconciliationSchema.safeParse({
        receipts: [receipt],
        unknown: [{ deviceId: "device-1", commandId: "command-1" }],
      }).success,
    ).toBe(false);
  });

  it("bounds and version-gates chunked snapshot negotiation and wire envelopes", () => {
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "snapshot-request",
      method: "thread.snapshot",
      payload: { threadId: "thread-1", snapshotTransfer: { version: 1 } },
    } as const;
    expect(HostIpcRequestSchema.safeParse(request).success).toBe(true);
    expect(
      HostIpcRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, snapshotTransfer: { version: 2 } },
      }).success,
    ).toBe(false);

    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      method: request.method,
      transfer: {
        kind: "snapshot.begin",
        transferId: "transfer-1",
        snapshotKind: "thread",
        chunkCount: 1,
        totalBytes: 1,
        sha256: "0".repeat(64),
      },
    } as const;
    expect(HostIpcSnapshotTransferEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      HostIpcSnapshotTransferEnvelopeSchema.safeParse({
        ...envelope,
        transfer: { ...envelope.transfer, totalBytes: MAX_SNAPSHOT_TRANSFER_BYTES + 1 },
      }).success,
    ).toBe(false);
    expect(
      HostIpcSnapshotTransferEnvelopeSchema.safeParse({
        ...envelope,
        transfer: {
          kind: "snapshot.chunk",
          transferId: "transfer-1",
          index: 0,
          dataBase64: Buffer.alloc(SNAPSHOT_TRANSFER_CHUNK_BYTES + 1).toString("base64"),
        },
      }).success,
    ).toBe(false);
    expect(
      HostIpcSnapshotTransferEnvelopeSchema.safeParse({
        ...envelope,
        transfer: { kind: "snapshot.chunk", transferId: "transfer-1", index: 0, dataBase64: "eA" },
      }).success,
    ).toBe(false);
    expect(
      HostIpcSnapshotTransferEnvelopeSchema.safeParse({
        ...envelope,
        transfer: { kind: "snapshot.chunk", transferId: "transfer-1", index: 0, dataBase64: "YR==" },
      }).success,
    ).toBe(false);
    expect(HostIpcSnapshotTransferEnvelopeSchema.safeParse({ ...envelope, untrusted: true }).success).toBe(false);
  });

  it("requires immutable host authority on every mutation and reconciliation request", () => {
    const command = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: "device-1",
      commandId: "command-1",
      threadId: "thread-1",
      issuedAt: new Date().toISOString(),
      command: { kind: "abort" },
    };
    expect(CommandEnvelopeSchema.safeParse(command).success).toBe(false);
    expect(
      HostIpcRequestSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "missing-authority-reconcile",
        method: "command.reconcile",
        payload: { commands: [] },
      }).success,
    ).toBe(false);
    expect(
      HostIpcRequestSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "missing-authority-plan",
        method: "handoff.plan",
        payload: {
          request: {
            threadId: "thread-1",
            sourceGenerationId: "generation-1",
            destinationHostId: "host-2",
            destinationProjectId: "project-2",
            behaviorIfRunning: "interrupt",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      HostIpcRequestSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "missing-authority-commit",
        method: "handoff.commit",
        payload: { handoffId: "handoff-1", deviceId: "device-1", commandId: "command-2" },
      }).success,
    ).toBe(false);
  });

  it("defines bounded, non-secret mobile pairing and per-device scope metadata", () => {
    expect(
      MobilePairingPolicySchema.parse({
        version: 1,
        ticketLifetimeSeconds: 300,
        singleUse: true,
        matchingCodeRequired: true,
        relayRequired: true,
        applicationE2eeRequired: true,
        individualRevocationRequired: true,
      }),
    ).toMatchObject({ ticketLifetimeSeconds: 300, singleUse: true });

    expect(
      PairingTicketDescriptorSchema.safeParse({
        version: 1,
        ticketId: "ticket-1",
        hostId: "host-1",
        relayOrigin: "http://relay.example.test",
        requestedScopes: ["projection.read"],
        createdAt: "2026-08-05T20:00:00.000Z",
        expiresAt: "2026-08-05T20:05:00.000Z",
        status: "pending",
      }).success,
    ).toBe(false);

    expect(
      PairedDeviceSchema.parse({
        version: 1,
        deviceId: "device-mobile-1",
        displayName: "Ebene's phone",
        kind: "mobile",
        keyAlgorithm: "Noise_25519",
        publicKeyFingerprint: `pa1-${"a".repeat(43)}`,
        scopes: ["projection.read", "thread.follow_up"],
        grantVersion: 1,
        hostIdentityEpoch: 1,
        pairedAt: "2026-08-05T20:00:00.000Z",
      }),
    ).toMatchObject({ kind: "mobile", scopes: ["projection.read", "thread.follow_up"] });

    const canonicalTicket = {
      version: 1 as const,
      ticketId: "ticket-canonical",
      hostId: "host-1",
      relayOrigin: "wss://relay.example.test",
      requestedScopes: ["projection.read"] as const,
      createdAt: "2026-08-05T20:00:00.000Z",
      expiresAt: "2026-08-05T20:05:00.000Z",
      status: "pending" as const,
    };
    expect(PairingTicketDescriptorSchema.safeParse(canonicalTicket).success).toBe(true);
    expect(
      PairingTicketDescriptorSchema.safeParse({ ...canonicalTicket, relayOrigin: "wss://relay.example.test/path" })
        .success,
    ).toBe(false);
    expect(
      PairingTicketDescriptorSchema.safeParse({ ...canonicalTicket, expiresAt: canonicalTicket.createdAt }).success,
    ).toBe(false);
    expect(
      PairingTicketDescriptorSchema.safeParse({
        ...canonicalTicket,
        requestedScopes: ["projection.read", "projection.read"],
      }).success,
    ).toBe(false);
  });
});

function threadSnapshot() {
  const cursor = {
    threadId: "thread-1",
    executionGenerationId: "execution-1",
    generation: "daemon-1",
    sequence: 1,
  };
  return {
    snapshotVersion: 1 as const,
    generatedAt: "2026-08-06T00:00:00.000Z",
    thread: {
      threadId: "thread-1",
      title: "Verified thread",
      projectIdentity: "project-1",
      currentLocation: {
        hostId: "host-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        executionGenerationId: "execution-1",
      },
      status: "idle" as const,
      unread: false,
      updatedAt: "2026-08-06T00:00:00.000Z",
      lastKnownCursor: cursor,
    },
    transcriptBlockIndex: [],
    materializedRecentBlocks: [],
    queueState: { pendingCommandIds: [], paused: false },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    git: { stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
    pendingAttention: [],
    latestCursor: cursor,
  };
}
