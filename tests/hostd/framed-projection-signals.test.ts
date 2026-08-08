import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { PrimeAgentProjectionChange } from "../../src/hostd/gateway";
import {
  MAX_FRAMED_SESSION_IN_FLIGHT_REQUESTS,
  MAX_PENDING_THREAD_CHANGE_SIGNALS,
  runFramedSession,
} from "../../src/hostd/server";
import {
  TRUSTED_USER_SESSION,
  type HostService,
  type HostSessionContext,
} from "../../src/hostd/service";
import type {
  ResidentAbortIdleObservedEvent,
  ResidentPromptIdleObservedEvent,
} from "../../src/hostd/store";
import {
  PROTOCOL_VERSION,
  SNAPSHOT_TRANSFER_CHUNK_BYTES,
  SNAPSHOT_TRANSFER_VERSION,
  type HostIpcResponse,
} from "../../src/shared/protocol";
import { encodeJsonFrame, LengthPrefixedJsonDecoder } from "../../src/shared/frame-codec";

describe("hostd framed resident projection signals", () => {
  it("coalesces duplicate changes into one tiny authority-only frame", async () => {
    const fixture = framedFixture(async () => response("unused", "health.get", {}));

    for (let index = 0; index < 100; index += 1) {
      fixture.emit({ threadId: "thread-a", executionGenerationId: "execution-a" });
    }
    await vi.waitFor(() => expect(fixture.frames).toHaveLength(1));

    expect(fixture.frames[0]).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      event: "thread.changed",
      payload: { threadId: "thread-a", executionGenerationId: "execution-a" },
    });
    expect(encodeJsonFrame(fixture.frames[0]).byteLength).toBeLessThan(256);

    await fixture.finish();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });

  it("coalesces a G1 to G2 burst for one thread into one latest-generation signal", async () => {
    const fixture = framedFixture(async () => response("unused", "health.get", {}));

    fixture.emit({ threadId: "thread-a", executionGenerationId: "generation-1" });
    fixture.emit({ threadId: "thread-a", executionGenerationId: "generation-2" });
    await vi.waitFor(() => expect(fixture.frames).toHaveLength(1));

    expect(fixture.frames[0]).toMatchObject({
      event: "thread.changed",
      payload: { threadId: "thread-a", executionGenerationId: "generation-2" },
    });
    await fixture.finish();
  });

  it("keeps a chunked snapshot response atomic and ahead of queued change signals", async () => {
    const handlerEntered = deferred<void>();
    const releaseHandler = deferred<void>();
    const fixture = framedFixture(async (request) => {
      handlerEntered.resolve(undefined);
      await releaseHandler.promise;
      const requestId = stringField(request, "requestId");
      return response(requestId, "catalog.snapshot", {
        padding: "x".repeat(SNAPSHOT_TRANSFER_CHUNK_BYTES + 200),
      });
    });
    fixture.readable.write(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "snapshot-1",
      method: "catalog.snapshot",
      payload: { snapshotTransfer: { version: SNAPSHOT_TRANSFER_VERSION } },
    }));
    await handlerEntered.promise;

    fixture.emit({ threadId: "thread-a", executionGenerationId: "execution-a" });
    fixture.emit({ threadId: "thread-a", executionGenerationId: "execution-a" });
    releaseHandler.resolve(undefined);
    await vi.waitFor(() => expect(fixture.frames).toHaveLength(5));

    expect(fixture.frames.slice(0, 4).map(transferKind)).toEqual([
      "snapshot.begin",
      "snapshot.chunk",
      "snapshot.chunk",
      "snapshot.end",
    ]);
    expect(fixture.frames.slice(0, 4).every((frame) => frame.requestId === "snapshot-1")).toBe(true);
    expect(fixture.frames[4]).toMatchObject({
      event: "thread.changed",
      payload: { threadId: "thread-a", executionGenerationId: "execution-a" },
    });

    await fixture.finish();
  });

  it("keeps a chunked normal response atomic when an urgent Stop completes during backpressure", async () => {
    const readable = new PassThrough();
    const writable = new FirstWriteGate();
    const abortHandled = deferred<void>();
    const service = framedService(async (request) => {
      const requestId = stringField(request, "requestId");
      if (requestId === "atomic-snapshot") {
        return response(requestId, "catalog.snapshot", {
          padding: "x".repeat(SNAPSHOT_TRANSFER_CHUNK_BYTES + 200),
        });
      }
      abortHandled.resolve(undefined);
      return commandResponse(requestId, "completed");
    });
    const session = runFramedSession(service, readable, writable, TRUSTED_USER_SESSION);

    readable.write(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "atomic-snapshot",
      method: "catalog.snapshot",
      payload: { snapshotTransfer: { version: SNAPSHOT_TRANSFER_VERSION } },
    }));
    await writable.firstWriteStarted.promise;
    readable.write(encodeJsonFrame(commandRequest("atomic-abort", "abort")));
    await abortHandled.promise;
    readable.end();
    writable.releaseFirstWrite.resolve(undefined);
    await session;

    const frames = writable.decodedFrames();
    expect(frames.slice(0, 4).map(transferKind)).toEqual([
      "snapshot.begin",
      "snapshot.chunk",
      "snapshot.chunk",
      "snapshot.end",
    ]);
    expect(frames.slice(0, 4).every((frame) => frame.requestId === "atomic-snapshot")).toBe(true);
    expect(frames[4]).toMatchObject({ requestId: "atomic-abort", method: "command.submit", ok: true });
  });

  it("writes a pending ordinary response before a change observed during request handling", async () => {
    const handlerEntered = deferred<void>();
    const releaseHandler = deferred<void>();
    const fixture = framedFixture(async (request) => {
      handlerEntered.resolve(undefined);
      await releaseHandler.promise;
      return response(stringField(request, "requestId"), "health.get", { healthy: true });
    });
    fixture.readable.write(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "health-priority",
      method: "health.get",
      payload: {},
    }));
    await handlerEntered.promise;
    fixture.emit({ threadId: "thread-a", executionGenerationId: "execution-a" });
    releaseHandler.resolve(undefined);

    await vi.waitFor(() => expect(fixture.frames).toHaveLength(2));
    expect(fixture.frames[0]).toMatchObject({ requestId: "health-priority", ok: true });
    expect(fixture.frames[1]).toMatchObject({ event: "thread.changed" });

    await fixture.finish();
  });

  it("coalesces private prompt proof records into one sanitized signal before the trailing invalidation", async () => {
    const handlerEntered = deferred<void>();
    const releaseHandler = deferred<void>();
    const fixture = framedFixture(async (request) => {
      handlerEntered.resolve(undefined);
      await releaseHandler.promise;
      return response(stringField(request, "requestId"), "health.get", { healthy: true });
    });
    fixture.readable.write(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "prompt-proof-priority",
      method: "health.get",
      payload: {},
    }));
    await handlerEntered.promise;

    const observation = promptIdleObservation("attempt-proof-a", "command-proof-a");
    fixture.emitPromptIdle(observation);
    fixture.emitPromptIdle(observation);
    fixture.emit({ threadId: "thread-a", executionGenerationId: "execution-a" });
    releaseHandler.resolve(undefined);

    await vi.waitFor(() => expect(fixture.frames).toHaveLength(3));
    expect(fixture.frames[0]).toMatchObject({ requestId: "prompt-proof-priority", ok: true });
    expect(fixture.frames[1]).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      event: "resident.prompt_idle_observed",
      payload: {
        eventVersion: 1,
        attemptId: "attempt-proof-a",
        receipt: observation.receipt,
      },
    });
    expect(fixture.frames[2]).toMatchObject({
      event: "thread.changed",
      payload: { threadId: "thread-a", executionGenerationId: "execution-a" },
    });
    const serializedSignal = JSON.stringify(fixture.frames[1]);
    expect(serializedSignal).not.toContain("private prompt text");
    expect(serializedSignal).not.toContain("private-session-file");
    expect(serializedSignal).not.toContain("private-workspace");
    expect(encodeJsonFrame(fixture.frames[1]).byteLength).toBeLessThan(2_048);

    await fixture.finish();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.unsubscribePromptIdle).toHaveBeenCalledOnce();
  });

  it("coalesces private Stop proof records into one sanitized signal before the trailing invalidation", async () => {
    const handlerEntered = deferred<void>();
    const releaseHandler = deferred<void>();
    const fixture = framedFixture(async (request) => {
      handlerEntered.resolve(undefined);
      await releaseHandler.promise;
      return response(stringField(request, "requestId"), "health.get", { healthy: true });
    });
    fixture.readable.write(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "abort-proof-priority",
      method: "health.get",
      payload: {},
    }));
    await handlerEntered.promise;

    const observation = abortIdleObservation("attempt-abort-proof-a", "command-abort-proof-a");
    fixture.emitAbortIdle(observation);
    fixture.emitAbortIdle(observation);
    fixture.emit({ threadId: "thread-a", executionGenerationId: "execution-a" });
    releaseHandler.resolve(undefined);

    await vi.waitFor(() => expect(fixture.frames).toHaveLength(3));
    expect(fixture.frames[0]).toMatchObject({ requestId: "abort-proof-priority", ok: true });
    expect(fixture.frames[1]).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      event: "resident.abort_idle_observed",
      payload: {
        eventVersion: 1,
        attemptId: "attempt-abort-proof-a",
        receipt: observation.receipt,
      },
    });
    expect(fixture.frames[2]).toMatchObject({
      event: "thread.changed",
      payload: { threadId: "thread-a", executionGenerationId: "execution-a" },
    });
    const serializedSignal = JSON.stringify(fixture.frames[1]);
    expect(serializedSignal).not.toContain("private Stop reason");
    expect(serializedSignal).not.toContain("private-session-file");
    expect(serializedSignal).not.toContain("private-workspace");
    expect(encodeJsonFrame(fixture.frames[1]).byteLength).toBeLessThan(2_048);

    await fixture.finish();
    expect(fixture.unsubscribeAbortIdle).toHaveBeenCalledOnce();
  });

  it("does not let sustained later requests starve an already queued Stop proof", async () => {
    const causalEntered = deferred<void>();
    const releaseCausal = deferred<void>();
    const laterEntered = deferred<void>();
    const releaseLater = deferred<void>();
    const fixture = framedFixture(async (request) => {
      const requestId = stringField(request, "requestId");
      if (requestId === "abort-proof-causal") {
        causalEntered.resolve(undefined);
        await releaseCausal.promise;
      } else {
        laterEntered.resolve(undefined);
        await releaseLater.promise;
      }
      return response(requestId, "health.get", { healthy: true });
    });
    fixture.readable.write(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "abort-proof-causal",
      method: "health.get",
      payload: {},
    }));
    await causalEntered.promise;
    fixture.emitAbortIdle(abortIdleObservation("attempt-abort-starvation", "command-abort-starvation"));
    fixture.readable.write(Buffer.concat(Array.from(
      { length: MAX_FRAMED_SESSION_IN_FLIGHT_REQUESTS - 1 },
      (_, index) => encodeJsonFrame({
        protocolVersion: PROTOCOL_VERSION,
        requestId: `abort-proof-later-${index}`,
        method: "health.get",
        payload: {},
      }),
    )));

    releaseCausal.resolve(undefined);
    await laterEntered.promise;
    await vi.waitFor(() => expect(fixture.frames).toHaveLength(2));
    expect(fixture.frames[0]).toMatchObject({ requestId: "abort-proof-causal", ok: true });
    expect(fixture.frames[1]).toMatchObject({
      event: "resident.abort_idle_observed",
      payload: { attemptId: "attempt-abort-starvation" },
    });

    releaseLater.resolve(undefined);
    await vi.waitFor(() => expect(fixture.frames).toHaveLength(MAX_FRAMED_SESSION_IN_FLIGHT_REQUESTS + 1));
    await fixture.finish();
  });

  it("charges the pending-signal budget per thread rather than per execution generation", async () => {
    const handlerEntered = deferred<void>();
    const releaseHandler = deferred<void>();
    const fixture = framedFixture(async (request) => {
      handlerEntered.resolve(undefined);
      await releaseHandler.promise;
      return response(stringField(request, "requestId"), "health.get", {});
    });
    fixture.readable.write(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "blocked-generation-burst",
      method: "health.get",
      payload: {},
    }));
    await handlerEntered.promise;

    for (let index = 0; index < MAX_PENDING_THREAD_CHANGE_SIGNALS * 2; index += 1) {
      fixture.emit({
        threadId: "thread-many-generations",
        executionGenerationId: `generation-${index}`,
      });
    }
    for (let index = 1; index < MAX_PENDING_THREAD_CHANGE_SIGNALS; index += 1) {
      fixture.emit({
        threadId: `thread-${index}`,
        executionGenerationId: "generation-current",
      });
    }
    expect(fixture.writable.destroyed).toBe(false);
    expect(fixture.writeErrors).toHaveLength(0);

    fixture.emit({
      threadId: "thread-over-budget",
      executionGenerationId: "generation-current",
    });
    await vi.waitFor(() => expect(fixture.writeErrors).toHaveLength(1));
    expect(fixture.writeErrors[0]).toMatchObject({ code: "TOO_MANY_FRAMES" });

    fixture.readable.end();
    releaseHandler.resolve(undefined);
    await fixture.session;
  });

  it("destroys a stalled connection when unique pending change signals exceed the fixed bound", async () => {
    const handlerEntered = deferred<void>();
    const releaseHandler = deferred<void>();
    const fixture = framedFixture(async (request) => {
      handlerEntered.resolve(undefined);
      await releaseHandler.promise;
      return response(stringField(request, "requestId"), "health.get", {});
    });
    fixture.readable.write(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "blocked-response",
      method: "health.get",
      payload: {},
    }));
    await handlerEntered.promise;

    for (let index = 0; index <= MAX_PENDING_THREAD_CHANGE_SIGNALS; index += 1) {
      fixture.emit({
        threadId: `thread-${index}`,
        executionGenerationId: `execution-${index}`,
      });
    }
    await vi.waitFor(() => expect(fixture.writeErrors).toHaveLength(1));
    expect(fixture.writable.destroyed).toBe(true);
    expect(fixture.writeErrors[0]).toMatchObject({ code: "TOO_MANY_FRAMES" });
    expect(fixture.frames).toHaveLength(0);

    fixture.readable.end();
    releaseHandler.resolve(undefined);
    await fixture.session;
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });

  it("destroys a stalled connection when unique pending prompt-proof signals exceed the fixed bound", async () => {
    const handlerEntered = deferred<void>();
    const releaseHandler = deferred<void>();
    const fixture = framedFixture(async (request) => {
      handlerEntered.resolve(undefined);
      await releaseHandler.promise;
      return response(stringField(request, "requestId"), "health.get", {});
    });
    fixture.readable.write(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "blocked-prompt-proof-response",
      method: "health.get",
      payload: {},
    }));
    await handlerEntered.promise;

    for (let index = 0; index <= MAX_PENDING_THREAD_CHANGE_SIGNALS; index += 1) {
      fixture.emitPromptIdle(promptIdleObservation(`attempt-proof-${index}`, `command-proof-${index}`));
    }
    await vi.waitFor(() => expect(fixture.writeErrors).toHaveLength(1));
    expect(fixture.writable.destroyed).toBe(true);
    expect(fixture.writeErrors[0]).toMatchObject({ code: "TOO_MANY_FRAMES" });
    expect(fixture.frames).toHaveLength(0);

    fixture.readable.end();
    releaseHandler.resolve(undefined);
    await fixture.session;
    expect(fixture.unsubscribePromptIdle).toHaveBeenCalledOnce();
  });

  it("terminates a slow client when its bounded in-flight request budget is exceeded", async () => {
    const readable = new PassThrough();
    const writable = new FirstWriteGate();
    const service = framedService(async (request) =>
      response(stringField(request, "requestId"), "health.get", { healthy: true }));
    const session = runFramedSession(service, readable, writable, TRUSTED_USER_SESSION);

    readable.write(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "slow-client-0",
      method: "health.get",
      payload: {},
    }));
    await writable.firstWriteStarted.promise;
    readable.write(Buffer.concat(Array.from(
      { length: MAX_FRAMED_SESSION_IN_FLIGHT_REQUESTS },
      (_, index) => encodeJsonFrame({
        protocolVersion: PROTOCOL_VERSION,
        requestId: `slow-client-${index + 1}`,
        method: "health.get",
        payload: {},
      }),
    )));

    await vi.waitFor(() => expect(writable.destroyed).toBe(true));
    // Release the test-only blocked _write callback so the already-terminated
    // session can drain its detached request task deterministically.
    writable.releaseFirstWrite.resolve(undefined);
    await session;
    expect(writable.errors[0]).toMatchObject({ code: "TOO_MANY_FRAMES" });
    expect(service.handle).toHaveBeenCalledOnce();
  });

  it("does not infer urgency from an abort-shaped request that fails the exact IPC schema", async () => {
    const releaseNormal = deferred<void>();
    const normalEntered = deferred<void>();
    const fixture = framedFixture(async (request) => {
      const requestId = stringField(request, "requestId");
      if (requestId === "schema-normal") {
        normalEntered.resolve(undefined);
        await releaseNormal.promise;
      }
      return response(requestId, "health.get", {});
    });
    fixture.readable.write(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "schema-normal",
      method: "health.get",
      payload: {},
    }));
    await normalEntered.promise;
    fixture.readable.write(encodeJsonFrame({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "schema-spoofed-abort",
      method: "command.submit",
      payload: { command: { command: { kind: "abort" } } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fixture.frames).toEqual([]);

    releaseNormal.resolve(undefined);
    await vi.waitFor(() => expect(fixture.frames).toHaveLength(2));
    expect(fixture.frames.map((frame) => frame.requestId)).toEqual([
      "schema-normal",
      "schema-spoofed-abort",
    ]);
    await fixture.finish();
  });

  it("suppresses local projection and proof signals on authenticated relay sessions", async () => {
    const relayContext = {
      transport: "relay",
      channel: {},
    } as HostSessionContext;
    const fixture = framedFixture(
      async () => response("unused", "health.get", {}),
      relayContext,
    );

    fixture.emit({ threadId: "thread-private", executionGenerationId: "execution-private" });
    fixture.emitPromptIdle(promptIdleObservation("attempt-private", "command-private"));
    fixture.emitAbortIdle(abortIdleObservation("attempt-abort-private", "command-abort-private"));
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.frames).toHaveLength(0);

    await fixture.finish();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.unsubscribePromptIdle).toHaveBeenCalledOnce();
    expect(fixture.unsubscribeAbortIdle).toHaveBeenCalledOnce();
  });
});

function framedFixture(
  handle: (request: Record<string, unknown>) => Promise<HostIpcResponse>,
  context: HostSessionContext = TRUSTED_USER_SESSION,
) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  const writeErrors: Error[] = [];
  const decoder = new LengthPrefixedJsonDecoder<Record<string, unknown>>();
  writable.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  writable.on("error", (error: Error) => writeErrors.push(error));
  let projectionListener: ((change: PrimeAgentProjectionChange) => void) | undefined;
  let promptIdleListener: ((event: ResidentPromptIdleObservedEvent) => void) | undefined;
  let abortIdleListener: ((event: ResidentAbortIdleObservedEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const unsubscribePromptIdle = vi.fn();
  const unsubscribeAbortIdle = vi.fn();
  const service = {
    subscribeProjectionChanges: vi.fn((listener: (change: PrimeAgentProjectionChange) => void) => {
      projectionListener = listener;
      return unsubscribe;
    }),
    subscribeResidentPromptIdleObserved: vi.fn((listener: (event: ResidentPromptIdleObservedEvent) => void) => {
      promptIdleListener = listener;
      return unsubscribePromptIdle;
    }),
    subscribeResidentAbortIdleObserved: vi.fn((listener: (event: ResidentAbortIdleObservedEvent) => void) => {
      abortIdleListener = listener;
      return unsubscribeAbortIdle;
    }),
    handle: vi.fn((request: unknown) => handle(request as Record<string, unknown>)),
  } as unknown as HostService;
  const session = runFramedSession(service, readable, writable, context);
  return {
    readable,
    writable,
    frames,
    writeErrors,
    unsubscribe,
    unsubscribePromptIdle,
    unsubscribeAbortIdle,
    session,
    emit(change: PrimeAgentProjectionChange) {
      if (!projectionListener) throw new Error("Projection listener was not registered");
      projectionListener(change);
    },
    emitPromptIdle(event: ResidentPromptIdleObservedEvent) {
      if (!promptIdleListener) throw new Error("Prompt idle listener was not registered");
      promptIdleListener(event);
    },
    emitAbortIdle(event: ResidentAbortIdleObservedEvent) {
      if (!abortIdleListener) throw new Error("Stop idle listener was not registered");
      abortIdleListener(event);
    },
    async finish() {
      readable.end();
      await session;
    },
  };
}

function framedService(handle: (request: Record<string, unknown>) => Promise<HostIpcResponse>) {
  return {
    subscribeProjectionChanges: vi.fn(() => vi.fn()),
    subscribeResidentPromptIdleObserved: vi.fn(() => vi.fn()),
    subscribeResidentAbortIdleObserved: vi.fn(() => vi.fn()),
    handle: vi.fn((request: unknown) => handle(request as Record<string, unknown>)),
  } as unknown as HostService;
}

function promptIdleObservation(attemptId: string, commandId: string): ResidentPromptIdleObservedEvent {
  return {
    eventVersion: 1,
    attemptId,
    observedAt: "2026-08-07T22:05:00.000Z",
    command: {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: "framed-device",
      commandId,
      expectedHostId: "host-a",
      threadId: "thread-a",
      issuedAt: "2026-08-07T22:00:00.000Z",
      expectedExecutionGenerationId: "execution-a",
      command: { kind: "prompt", text: "private prompt text" },
    },
    receipt: {
      protocolVersion: PROTOCOL_VERSION,
      receiptId: `receipt-${commandId}`,
      deviceId: "framed-device",
      commandId,
      threadId: "thread-a",
      status: "completed",
      receivedAt: "2026-08-07T22:00:00.000Z",
      updatedAt: "2026-08-07T22:05:00.000Z",
      executionGenerationId: "execution-a",
      message: "Prime Agent is authoritatively idle after the acknowledged prompt",
    },
    binding: {
      bindingVersion: 1,
      lifecycle: "resident",
      threadId: "thread-a",
      executionGenerationId: "execution-a",
      workspaceDirectory: "C:\\private-workspace",
      activeSessionId: "private-active-session",
      sessionId: "private-session",
      sessionFile: "C:\\private-session-file.jsonl",
      boundAt: "2026-08-07T22:00:00.000Z",
      runtime: {
        releaseVersion: "0.7.0",
        appVersion: "0.7.0",
        protocolName: "prime-agent-daemon",
        protocolVersion: 1,
        schemaRevision: 1,
        schemaId: "private-schema",
        capabilities: [],
        runtimeBuildId: "private-build",
      },
    },
    bindingFingerprint: "0".repeat(64),
    observedCursor: {
      threadId: "thread-a",
      executionGenerationId: "execution-a",
      generation: "events-a",
      sequence: 1,
    },
  } as unknown as ResidentPromptIdleObservedEvent;
}

function abortIdleObservation(attemptId: string, commandId: string): ResidentAbortIdleObservedEvent {
  const prompt = promptIdleObservation(attemptId, commandId);
  return {
    ...prompt,
    command: {
      ...prompt.command,
      command: { kind: "abort", reason: "private Stop reason" },
    },
    acknowledgedReceipt: {
      ...prompt.receipt,
      status: "running",
      updatedAt: "2026-08-07T22:04:00.000Z",
      message: "Prime Agent accepted Stop; waiting for idle proof",
    },
    receipt: {
      ...prompt.receipt,
      message: "Prime Agent is authoritatively idle after the acknowledged stop request",
    },
  } as ResidentAbortIdleObservedEvent;
}

function response(
  requestId: string,
  method: "health.get" | "catalog.snapshot",
  result: unknown,
): HostIpcResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method,
    ok: true,
    result,
  } as HostIpcResponse;
}

function commandResponse(requestId: string, status: "completed" | "running"): HostIpcResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: "command.submit",
    ok: true,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      receiptId: `receipt-${requestId}`,
      deviceId: "framed-device",
      commandId: requestId,
      threadId: "thread-a",
      status,
      receivedAt: "2026-08-07T22:00:00.000Z",
      updatedAt: "2026-08-07T22:00:00.000Z",
      executionGenerationId: "execution-a",
    },
  };
}

function commandRequest(requestId: string, kind: "abort" | "model.select") {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method: "command.submit",
    payload: {
      command: {
        protocolVersion: PROTOCOL_VERSION,
        deviceId: "framed-device",
        commandId: requestId,
        expectedHostId: "host-a",
        threadId: "thread-a",
        issuedAt: "2026-08-07T22:00:00.000Z",
        expectedExecutionGenerationId: "execution-a",
        command: kind === "abort"
          ? { kind: "abort", reason: "Stop the active turn." }
          : { kind: "model.select", providerId: "openai-codex", modelId: "gpt-5.3-codex" },
      },
    },
  } as const;
}

class FirstWriteGate extends Writable {
  readonly firstWriteStarted = deferred<void>();
  readonly releaseFirstWrite = deferred<void>();
  readonly errors: Error[] = [];
  private readonly chunks: Buffer[] = [];
  private writeCount = 0;

  constructor() {
    super();
    this.on("error", (error: Error) => this.errors.push(error));
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    this.writeCount += 1;
    if (this.writeCount !== 1) {
      callback();
      return;
    }
    this.firstWriteStarted.resolve(undefined);
    void this.releaseFirstWrite.promise.then(() => callback(), callback);
  }

  decodedFrames(): Record<string, unknown>[] {
    const decoder = new LengthPrefixedJsonDecoder<Record<string, unknown>>();
    return this.chunks.flatMap((chunk) => decoder.push(chunk));
  }
}

function transferKind(frame: Record<string, unknown>): unknown {
  const transfer = frame.transfer;
  return typeof transfer === "object" && transfer !== null && "kind" in transfer
    ? transfer.kind
    : undefined;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new Error(`Missing ${field}`);
  return candidate;
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
