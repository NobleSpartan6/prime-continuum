import { describe, expect, it } from "vitest";
import {
  CommandEnvelopeSchema,
  CommandReconciliationSchema,
  HealthSnapshotSchema,
  HostIpcRequestSchema,
  HostIpcResponseSchema,
  HostIpcSnapshotTransferEnvelopeSchema,
  MAX_SNAPSHOT_TRANSFER_BYTES,
  MobilePairingPolicySchema,
  PairedDeviceSchema,
  PairingTicketDescriptorSchema,
  PROTOCOL_VERSION,
  REMOTE_DEVICE_SCOPE_COUNT,
  REMOTE_DEVICE_SCOPES,
  RemoteDeviceScopesSchema,
  RUNTIME_INTEGRITY_CAPABILITY,
  RUNTIME_INTEGRITY_RETRY_CAPABILITY,
  ResidentControlProjectionSnapshotSchema,
  ResidentEndRequestSchema,
  ResidentLifecycleStatusSchema,
  RuntimeSessionSummarySchema,
  SNAPSHOT_TRANSFER_CHUNK_BYTES,
  SessionCursorSchema,
  ThreadProjectionSnapshotSchema,
} from "../../src/shared/protocol";

describe("host protocol schemas", () => {
  it("admits only the path-free resident resource inventory contract", () => {
    const runtime = {
      runtime: "prime_agent" as const,
      residency: "resident" as const,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      steeringMode: "all" as const,
      followUpMode: "one-at-a-time" as const,
      messageCount: 0,
      compactionCount: 0,
      queuedActionCount: 0,
      activeToolNames: ["ipython"],
      resourceInventory: {
        skills: [{
          name: "playwright-cli",
          description: "Automate browser interactions.",
          sourceKind: { scope: "project" as const, origin: "package" as const },
        }],
        prompts: [],
        themes: [],
        extensions: {
          count: 1,
          sourceKinds: [{ scope: "project" as const, origin: "top-level" as const }],
        },
        contextFileCount: 1,
        diagnostics: {
          warningCount: 1,
          errorCount: 0,
          collisions: [{ resourceType: "skill" as const, name: "playwright-cli" }],
        },
      },
    };

    expect(RuntimeSessionSummarySchema.parse(runtime)).toEqual(runtime);
    expect(RuntimeSessionSummarySchema.safeParse({
      ...runtime,
      resourceInventory: {
        ...runtime.resourceInventory,
        skills: [{ ...runtime.resourceInventory.skills[0], filePath: "/private/SKILL.md" }],
      },
    }).success).toBe(false);
    expect(RuntimeSessionSummarySchema.safeParse({
      ...runtime,
      resourceInventory: {
        ...runtime.resourceInventory,
        credential: "must-not-cross",
      },
    }).success).toBe(false);
    expect(RuntimeSessionSummarySchema.safeParse({
      ...runtime,
      resourceInventory: {
        ...runtime.resourceInventory,
        diagnostics: {
          ...runtime.resourceInventory.diagnostics,
          message: "Private diagnostic text",
        },
      },
    }).success).toBe(false);
  });

  it("binds runtime retry to one host and one retryable failed integrity snapshot", () => {
    const runtimeIntegrity = {
      contractVersion: 1 as const,
      changedAt: "2026-08-08T12:00:00.000Z",
      trustAnchorId: "a".repeat(64),
      target: {
        runtime: "prime-agent" as const,
        releaseVersion: "0.7.0",
        runtimeBuildId: "fixture-build-1",
        platform: "win32",
        arch: "x64",
        manifestSha256: "a".repeat(64),
        treeSha256: "b".repeat(64),
        filesSha256: "c".repeat(64),
      },
      status: "failed" as const,
      code: "RUNTIME_INTEGRITY_FAILED",
      retryable: true,
      recoveryAction: "retry_runtime_verification",
    };
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "runtime-retry-1",
      method: "runtime.integrity.retry",
      payload: { expectedHostId: "host-1" },
    } as const;
    expect(HostIpcRequestSchema.parse(request)).toEqual(request);
    expect(
      HostIpcRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, runtimePath: "C:\\private\\runtime" },
      }).success,
    ).toBe(false);
    expect(
      HostIpcResponseSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: request.method,
        ok: true,
        result: {
          contractVersion: runtimeIntegrity.contractVersion,
          changedAt: runtimeIntegrity.changedAt,
          trustAnchorId: runtimeIntegrity.trustAnchorId,
          target: runtimeIntegrity.target,
          status: "initializing",
          phase: "preparing",
          attempt: 2,
        },
      }).method,
    ).toBe("runtime.integrity.retry");

    const health = {
      protocolVersion: PROTOCOL_VERSION,
      hostdVersion: "0.1.0",
      startedAt: "2026-08-08T11:59:00.000Z",
      checkedAt: "2026-08-08T12:00:00.000Z",
      serviceState: "degraded",
      host: {
        hostId: "host-1",
        displayName: "Local computer",
        kind: "local",
        connectionPaths: [],
        reachability: "online",
        compatibility: "compatible",
        platform: { os: "windows", architecture: "x64" },
        attentionCounts: { total: 0, unread: 0, questions: 0, approvals: 0 },
      },
      capabilities: [RUNTIME_INTEGRITY_CAPABILITY, RUNTIME_INTEGRITY_RETRY_CAPABILITY],
      runtimeIntegrity,
    };
    expect(HealthSnapshotSchema.safeParse(health).success).toBe(true);
    expect(
      HealthSnapshotSchema.safeParse({
        ...health,
        serviceState: "ready",
        runtimeIntegrity: { ...runtimeIntegrity, status: "ready", assurance: "development-integrity" },
      }).success,
    ).toBe(false);
    expect(
      HealthSnapshotSchema.safeParse({
        ...health,
        runtimeIntegrity: { ...runtimeIntegrity, retryable: false },
      }).success,
    ).toBe(false);
  });

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

  it("binds resident control polling to one path-free host generation", () => {
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "resident-control-read-1",
      method: "thread.control.snapshot",
      payload: {
        expectedHostId: "host-1",
        threadId: "thread-1",
        expectedExecutionGenerationId: "execution-2",
      },
    } as const;
    expect(HostIpcRequestSchema.parse(request)).toEqual(request);
    expect(HostIpcRequestSchema.safeParse({
      ...request,
      payload: { ...request.payload, workspaceDirectory: "C:\\private\\workspace" },
    }).success).toBe(false);

    const projection = {
      projectionVersion: 1 as const,
      hostId: "host-1",
      threadId: "thread-1",
      executionGenerationId: "execution-2",
      bindingFingerprint: "a".repeat(64),
      controlSequence: 7,
      changedAt: "2026-08-08T12:01:00.000Z",
      commandReadiness: "ready" as const,
      browserExecution: {
        readiness: "ready" as const,
        protocol: "prime-continuim.browser.v1" as const,
        surface: "playwright-cli" as const,
        controller: "playwright-core/1.63.0-alpha-2026-08-05" as const,
        engine: "verified-electron-host" as const,
      },
      authorityCursor: {
        threadId: "thread-1",
        executionGenerationId: "execution-2",
        generation: "daemon-generation-3",
        sequence: 99,
      },
      operation: {
        kind: "abort" as const,
        deviceId: "mobile-b",
        commandId: "stop-1",
        phase: "acknowledged" as const,
        admittedAt: "2026-08-08T12:00:00.000Z",
        changedAt: "2026-08-08T12:00:30.000Z",
      },
      quiescence: { state: "stop_owned" as const },
    };
    expect(ResidentControlProjectionSnapshotSchema.parse(projection)).toEqual(projection);
    const { commandReadiness: _commandReadiness, browserExecution: _browserExecution, ...legacy } = projection;
    expect(ResidentControlProjectionSnapshotSchema.parse(legacy)).toEqual({
      ...legacy,
      commandReadiness: "unavailable",
      browserExecution: { readiness: "unavailable" },
    });
    expect(HostIpcResponseSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      method: request.method,
      ok: true,
      result: { ...projection, workspaceDirectory: "C:\\private\\workspace" },
    }).success).toBe(false);
    expect(ResidentControlProjectionSnapshotSchema.safeParse({
      ...projection,
      authorityCursor: { ...projection.authorityCursor, executionGenerationId: "execution-other" },
    }).success).toBe(false);
    expect(ResidentControlProjectionSnapshotSchema.safeParse({
      ...projection,
      operation: { ...projection.operation, kind: "prompt" },
    }).success).toBe(false);
  });

  it("binds resident end to one path-free reviewed source cursor", () => {
    const request = {
      expectedHostId: "host-1",
      operationId: "resident-end-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      executionGenerationId: "execution-1",
      expectedSourceCursor: {
        threadId: "thread-1",
        executionGenerationId: "execution-1",
        generation: "daemon-generation-1",
        sequence: 42,
      },
    };
    expect(ResidentEndRequestSchema.safeParse(request).success).toBe(true);
    expect(ResidentEndRequestSchema.safeParse({
      ...request,
      expectedSourceCursor: undefined,
    }).success).toBe(false);
    expect(ResidentEndRequestSchema.safeParse({
      ...request,
      expectedSourceCursor: { ...request.expectedSourceCursor, sequence: 41, threadId: "other-thread" },
    }).success).toBe(false);
    expect(ResidentEndRequestSchema.safeParse({
      ...request,
      workspaceDirectory: "C:\\private\\workspace",
    }).success).toBe(false);
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

  it("accepts only bounded generation-scoped latest turn outcomes", () => {
    const source = threadSnapshot();
    const assistantBlock = {
      blockId: "assistant-terminal",
      kind: "assistant" as const,
      text: "Complete.",
      createdAt: source.generatedAt,
      sequence: source.latestCursor.sequence,
    };
    const latestTurnOutcome = {
      outcomeVersion: 1 as const,
      commandId: "prompt-command",
      receiptId: "prompt-receipt",
      observedAt: source.generatedAt,
      observedCursor: source.latestCursor,
      terminalAssistant: { blockId: assistantBlock.blockId, stopReason: "stop" as const },
    };
    const valid = {
      ...source,
      transcriptBlockIndex: [{
        blockId: assistantBlock.blockId,
        kind: assistantBlock.kind,
        sequence: assistantBlock.sequence,
        byteLength: 9,
        materialized: true,
      }],
      materializedRecentBlocks: [assistantBlock],
      latestTurnOutcome,
    };
    expect(ThreadProjectionSnapshotSchema.safeParse(valid).success).toBe(true);
    expect(ThreadProjectionSnapshotSchema.safeParse({
      ...valid,
      latestTurnOutcome: {
        ...latestTurnOutcome,
        observedCursor: { ...latestTurnOutcome.observedCursor, executionGenerationId: "other-execution" },
      },
    }).success).toBe(false);
    expect(ThreadProjectionSnapshotSchema.safeParse({
      ...valid,
      latestTurnOutcome: { ...latestTurnOutcome, observedAt: "2026-08-06T00:00:01.000Z" },
    }).success).toBe(false);
    expect(ThreadProjectionSnapshotSchema.safeParse({
      ...valid,
      latestTurnOutcome: {
        ...latestTurnOutcome,
        terminalAssistant: { ...latestTurnOutcome.terminalAssistant, blockId: "missing-block" },
      },
    }).success).toBe(false);
    expect(ThreadProjectionSnapshotSchema.safeParse({
      ...valid,
      latestTurnOutcome: { ...latestTurnOutcome, promptText: "must never be projected" },
    }).success).toBe(false);
  });

  it("accepts only a self-consistent opaque resident end disposition", () => {
    const source = threadSnapshot();
    const ended = {
      ...source,
      generatedAt: "2026-08-06T00:00:01.000Z",
      thread: {
        ...source.thread,
        recap: "Resident session ended.",
        updatedAt: "2026-08-06T00:00:01.000Z",
      },
      residentLifecycle: {
        version: 1 as const,
        state: "ended" as const,
        operationId: "resident-end-operation",
        bindingFingerprint: "a".repeat(64),
        endedAt: "2026-08-06T00:00:01.000Z",
        sourceCursor: source.latestCursor,
        reason: "user_end" as const,
      },
    };
    expect(ThreadProjectionSnapshotSchema.safeParse(ended).success).toBe(true);
    for (const status of ["complete", "failed"] as const) {
      expect(ThreadProjectionSnapshotSchema.safeParse({
        ...ended,
        thread: { ...ended.thread, status },
      }).success).toBe(true);
    }
    for (const status of ["running", "waiting", "needs_approval"] as const) {
      expect(ThreadProjectionSnapshotSchema.safeParse({
        ...ended,
        thread: { ...ended.thread, status },
      }).success).toBe(false);
    }
    expect(ThreadProjectionSnapshotSchema.safeParse({
      ...ended,
      thread: { ...ended.thread, recap: "Stale recap" },
    }).success).toBe(false);
    expect(ThreadProjectionSnapshotSchema.safeParse({
      ...ended,
      residentLifecycle: { ...ended.residentLifecycle, activeSessionId: "private-daemon-id" },
    }).success).toBe(false);
    expect(ThreadProjectionSnapshotSchema.safeParse({
      ...ended,
      runtime: {
        runtime: "prime_agent",
        residency: "resident",
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
      },
    }).success).toBe(false);
    expect(ThreadProjectionSnapshotSchema.safeParse({
      ...ended,
      queueState: { pendingCommandIds: ["still-live"], paused: false },
    }).success).toBe(false);
    expect(ThreadProjectionSnapshotSchema.safeParse({
      ...ended,
      residentLifecycle: {
        ...ended.residentLifecycle,
        sourceCursor: { ...ended.residentLifecycle.sourceCursor, sequence: 0 },
      },
    }).success).toBe(false);
    expect(ThreadProjectionSnapshotSchema.safeParse({
      ...ended,
      residentLifecycle: { ...ended.residentLifecycle, endedAt: "2026-08-06T00:00:02.000Z" },
    }).success).toBe(false);
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

  it("publishes one immutable exact ten-scope vocabulary without accepting aliases or duplicates", () => {
    expect(Object.isFrozen(REMOTE_DEVICE_SCOPES)).toBe(true);
    expect(REMOTE_DEVICE_SCOPE_COUNT).toBe(10);
    expect(REMOTE_DEVICE_SCOPES).toEqual([
      "projection.read",
      "thread.follow_up",
      "thread.steer",
      "thread.abort",
      "thread.start",
      "model.select",
      "approval.resolve",
      "extension_ui.respond",
      "run_location.change",
      "host.admin",
    ]);
    expect(RemoteDeviceScopesSchema.parse([...REMOTE_DEVICE_SCOPES])).toEqual(REMOTE_DEVICE_SCOPES);
    expect(
      RemoteDeviceScopesSchema.safeParse([...REMOTE_DEVICE_SCOPES, "projection.read"]).success,
    ).toBe(false);
    expect(
      RemoteDeviceScopesSchema.safeParse(["projection.read", "thread.inspect"]).success,
    ).toBe(false);
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

  it("bounds trusted-local resident provisioning and returns path-free lifecycle state", () => {
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "resident-provision-1",
      method: "resident.provision",
      payload: {
        expectedHostId: "host-1",
        operationId: "resident-op-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        executionGenerationId: "execution-1",
        workspaceDirectory: "C:\\work\\project",
        projectDisplayName: "Project",
        threadTitle: "First resident thread",
        createdAt: "2026-08-08T12:00:00.000Z",
      },
    } as const;
    expect(HostIpcRequestSchema.safeParse(request).success).toBe(true);
    expect(
      HostIpcRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, workspaceDirectory: "bad\0path" },
      }).success,
    ).toBe(false);
    for (const workspaceDirectory of ["relative/project", "C:\\work\\project\r\nforged"]) {
      expect(
        HostIpcRequestSchema.safeParse({
          ...request,
          payload: { ...request.payload, workspaceDirectory },
        }).success,
      ).toBe(false);
    }
    expect(
      HostIpcRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, workspaceDirectory: "/srv/work/project" },
      }).success,
    ).toBe(true);
    expect(
      HostIpcRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, workspaceDirectory: "\\\\server\\share\\project" },
      }).success,
    ).toBe(true);
    expect(
      HostIpcRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, sessionPath: "C:\\secret\\session.jsonl" },
      }).success,
    ).toBe(false);
    expect(
      HostIpcRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, threadTitle: "   " },
      }).success,
    ).toBe(false);

    const status = ResidentLifecycleStatusSchema.parse({
      version: 1,
      kind: "provision",
      operationId: "resident-op-1",
      phase: "committed",
      expectedHostId: "host-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      executionGenerationId: "execution-1",
      preparedAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:01.000Z",
      terminalAt: "2026-08-08T12:00:01.000Z",
    });
    const response = HostIpcResponseSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      method: request.method,
      ok: true,
      result: status,
    });
    expect(JSON.stringify(response)).not.toMatch(/workspaceDirectory|sessionFile|activeSessionId/);
  });

  it("keeps registered-workspace SSH provisioning path-free and strict", () => {
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "registered-resident-provision-1",
      method: "resident.provision.registered",
      payload: {
        expectedHostId: "host-1",
        operationId: "resident-op-2",
        projectId: "project-1",
        workspaceId: "workspace-1",
        referenceThreadId: "saved-thread-1",
        referenceExecutionGenerationId: "saved-execution-1",
        threadId: "thread-2",
        executionGenerationId: "execution-2",
        threadTitle: "Remote resident thread",
        createdAt: "2026-08-08T12:00:00.000Z",
        sessionName: "Remote resident",
      },
    } as const;
    expect(HostIpcRequestSchema.safeParse(request).success).toBe(true);
    for (const forbidden of [
      { workspaceDirectory: "C:\\private\\workspace" },
      { projectDisplayName: "Forged project" },
      { repository: { root: "C:\\private\\workspace" } },
      { unexpected: true },
    ]) {
      expect(HostIpcRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, ...forbidden },
      }).success).toBe(false);
    }
    expect(HostIpcRequestSchema.safeParse({
      ...request,
      payload: { ...request.payload, referenceThreadId: undefined },
    }).success).toBe(false);
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
