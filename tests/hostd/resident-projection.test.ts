import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_RESIDENT_PROJECTION_INPUT_BYTES,
  MAX_RESIDENT_PROJECTION_MESSAGES,
  ResidentProjectionError,
  normalizeResidentProjectionSnapshot,
} from "../../src/hostd/resident-projection";
import {
  PINNED_PRIME_AGENT_RUNTIME,
  REQUIRED_RESIDENT_DAEMON_CAPABILITIES,
  type ResidentSessionBinding,
} from "../../src/hostd/resident-runtime";

interface SnapshotFixture {
  state: Record<string, unknown>;
  messages: unknown[];
  streamingMessage?: unknown;
  children?: unknown[];
  lastEventSequence?: number;
  lastEventCursor?: { generation: string; sequence: number };
  replay?: unknown;
  [key: string]: unknown;
}

const workspaceDirectory = resolve("fixtures", "resident-workspace");
const sessionFile = resolve("fixtures", "sessions", "session-1.jsonl");

function validBinding(): ResidentSessionBinding {
  return {
    bindingVersion: 1,
    lifecycle: "resident",
    threadId: "thread-1",
    executionGenerationId: "generation-1",
    workspaceDirectory,
    activeSessionId: "active-session-1",
    sessionId: "session-1",
    sessionFile,
    boundAt: "2026-08-06T17:00:00.000Z",
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

function assistantMessage(
  content: unknown[],
  timestamp = 1_754_500_001_000,
): Record<string, unknown> {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.2",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function validSnapshot(): SnapshotFixture {
  return {
    state: {
      activeSessionId: "active-session-1",
      cwd: workspaceDirectory,
      model: { provider: "openai", id: "gpt-5.2" },
      thinkingLevel: "high",
      serviceTier: "priority",
      availableThinkingLevels: ["off", "low", "medium", "high"],
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      sessionFile,
      sessionId: "session-1",
      sessionName: "Continuim build",
      sessionDir: resolve("fixtures", "sessions"),
      leafId: null,
      autoCompactionEnabled: true,
      messageCount: 3,
      sessionActions: {
        queuedCount: 2,
        steering: ["Check the tests"],
        followUps: ["Then summarize"],
        active: { kind: "turn", phase: "running", label: "Implementing" },
      },
      compactionCount: 1,
      goal: {
        active: true,
        status: "active",
        goalId: "goal-1",
        objective: "Ship resident continuity",
        tokenBudget: 100_000,
        tokensUsed: 30_000,
        timeUsedSeconds: 600,
        continuationsUsed: 2,
        createdAt: 1_754_500_000_000,
        updatedAt: 1_754_500_004_000,
        lastReason: "checkpoint",
      },
      scopedModels: [],
      activeToolNames: ["read_file", "shell"],
      contextUsage: { tokens: 30_000, contextWindow: 100_000, percent: 30 },
      recap: "Normalizing the authoritative resident snapshot.",
    },
    messages: [
      {
        role: "user",
        content: "Inspect the resident runtime.",
        timestamp: 1_754_500_000_000,
      },
      assistantMessage([
        { type: "thinking", thinking: "private chain of thought", thinkingSignature: "opaque-secret" },
        { type: "text", text: "I found the runtime boundary." },
        {
          type: "toolCall",
          id: "call-1",
          name: "read_file",
          arguments: { path: "sensitive-upstream-path" },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read_file",
        content: [
          { type: "text", text: "The runtime is pinned." },
          { type: "image", data: "private-image-payload", mimeType: "image/png" },
        ],
        details: { localPath: "private-tool-details" },
        isError: false,
        timestamp: 1_754_500_002_000,
      },
    ],
    children: [
      {
        id: "child-1",
        parentId: "parent-1",
        activeSessionId: "child-active-1",
        sessionName: "researcher",
        model: "openai/gpt-5.2",
        label: "Research compatibility",
        status: "done",
        durationMs: 2_000,
        answerPreview: "The boundary is compatible.",
        repliedSinceTask: true,
        toolUseCount: 4,
        tokenCount: 8_000,
        recap: "Finished the source audit.",
        sessionDir: resolve("private", "child-session"),
        activity: { kind: "waiting" },
      },
    ],
    lastEventSequence: 17,
    lastEventCursor: { generation: "daemon-generation-1", sequence: 17 },
  };
}

function expectProjectionError(
  operation: () => unknown,
  code: string,
): ResidentProjectionError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ResidentProjectionError);
    expect(error).toMatchObject({ code });
    return error as ResidentProjectionError;
  }
  throw new Error(`Expected ${code}`);
}

describe("resident authoritative snapshot normalization", () => {
  it("produces a frozen, bounded host-owned projection from a representative v0.7.0 snapshot", () => {
    const projection = normalizeResidentProjectionSnapshot(validSnapshot(), validBinding());

    expect(projection).toMatchObject({
      projectionVersion: 1,
      identity: {
        activeSessionId: "active-session-1",
        sessionId: "session-1",
        sessionFile,
        workspaceDirectory,
      },
      cursor: { generation: "daemon-generation-1", sequence: 17 },
      runtime: {
        runtime: "prime_agent",
        residency: "resident",
        appVersion: "0.7.0",
        activeSessionId: "active-session-1",
        sessionId: "session-1",
        sessionName: "Continuim build",
        model: "openai/gpt-5.2",
        thinkingLevel: "high",
        serviceTier: "priority",
        messageCount: 3,
        queuedActionCount: 2,
        context: { usedTokens: 30_000, maxTokens: 100_000 },
      },
      queue: {
        queuedCount: 2,
        steeringCount: 1,
        followUpCount: 1,
        active: { kind: "turn", phase: "running", label: "Implementing" },
      },
      goal: {
        goalId: "goal-1",
        objective: "Ship resident continuity",
        state: "active",
        tokensUsed: 30_000,
        updatedAt: "2025-08-06T17:06:44.000Z",
      },
    });
    expect(projection.transcript).toHaveLength(3);
    expect(projection.transcript.map(({ kind, text, createdAt, sequence }) => ({ kind, text, createdAt, sequence })))
      .toEqual([
        {
          kind: "user",
          text: "Inspect the resident runtime.",
          createdAt: "2025-08-06T17:06:40.000Z",
          sequence: 0,
        },
        {
          kind: "assistant",
          text: "I found the runtime boundary.\n\nTool call: read_file",
          createdAt: "2025-08-06T17:06:41.000Z",
          sequence: 1,
        },
        {
          kind: "tool",
          text: "read_file\nThe runtime is pinned.\n\n[Image: image/png]",
          createdAt: "2025-08-06T17:06:42.000Z",
          sequence: 2,
        },
      ]);
    expect(projection.childAgents).toEqual([
      {
        agentId: "child-1",
        parentAgentId: "parent-1",
        activeSessionId: "child-active-1",
        sessionName: "researcher",
        model: "openai/gpt-5.2",
        title: "Research compatibility",
        state: "complete",
        durationMs: 2_000,
        answerPreview: "The boundary is compatible.",
        repliedSinceTask: true,
        toolUseCount: 4,
        tokenCount: 8_000,
        recap: "Finished the source audit.",
        activity: { kind: "waiting" },
      },
    ]);

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("private chain of thought");
    expect(serialized).not.toContain("opaque-secret");
    expect(serialized).not.toContain("sensitive-upstream-path");
    expect(serialized).not.toContain("private-image-payload");
    expect(serialized).not.toContain("private-tool-details");
    expect(serialized).not.toContain("child-session");
    expect(serialized).not.toContain("sessionDir");
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.runtime)).toBe(true);
    expect(Object.isFrozen(projection.transcript)).toBe(true);
    expect(Object.isFrozen(projection.transcript[0])).toBe(true);
    expect(Object.isFrozen(projection.childAgents[0]?.activity)).toBe(true);
  });

  it("preserves tool and visible status semantics while isolating the in-progress stream", () => {
    const snapshot = validSnapshot();
    snapshot.state.messageCount = 5;
    snapshot.state.isStreaming = true;
    snapshot.messages = [
      {
        role: "bashExecution",
        command: "pnpm test",
        output: "12 tests passed",
        exitCode: 0,
        cancelled: false,
        truncated: true,
        timestamp: 1_754_500_010_000,
      },
      {
        role: "custom",
        customType: "checkpoint",
        content: "Saved the resident binding.",
        display: true,
        timestamp: 1_754_500_011_000,
      },
      {
        role: "custom",
        customType: "internal_only",
        content: "must stay hidden",
        display: false,
        details: { secret: "hidden-details" },
        timestamp: 1_754_500_012_000,
      },
      {
        role: "branchSummary",
        summary: "Returned from the implementation branch.",
        fromId: "entry-1",
        timestamp: 1_754_500_013_000,
      },
      {
        role: "compactionSummary",
        summary: "Kept the verified runtime facts.",
        tokensBefore: 90_000,
        retainedMessageCount: 4,
        customInstructions: "Keep test evidence",
        timestamp: 1_754_500_014_000,
      },
    ];
    snapshot.streamingMessage = assistantMessage(
      [
        { type: "thinking", thinking: "unpublished reasoning" },
        { type: "text", text: "Running the focused suite…" },
        { type: "toolCall", id: "stream-call-1", name: "shell", arguments: { command: "secret" } },
      ],
      1_754_500_015_000,
    );

    const projection = normalizeResidentProjectionSnapshot(snapshot, validBinding());

    expect(projection.transcript.map((block) => block.kind)).toEqual([
      "tool",
      "status",
      "status",
      "status",
    ]);
    expect(projection.transcript.map((block) => block.sequence)).toEqual([0, 1, 3, 4]);
    expect(projection.transcript[0]?.text).toBe("$ pnpm test\n12 tests passed\n[exited 0; output truncated]");
    expect(projection.transcript[1]?.text).toBe("checkpoint\nSaved the resident binding.");
    expect(projection.transcript[2]?.text).toBe(
      "Branch summary\nReturned from the implementation branch.",
    );
    expect(projection.transcript[3]?.text).toBe(
      "Conversation compacted\nKept the verified runtime facts.",
    );
    expect(projection.stream).toMatchObject({
      text: "Running the focused suite…\n\nTool call: shell",
      startedAt: "2025-08-06T17:06:55.000Z",
    });
    expect(JSON.stringify(projection)).not.toContain("must stay hidden");
    expect(JSON.stringify(projection)).not.toContain("unpublished reasoning");
    expect(JSON.stringify(projection)).not.toContain("hidden-details");
    expect(JSON.stringify(projection)).not.toContain('"command":"secret"');
  });

  it("accepts a bounded image payload but publishes only its safe display placeholder", () => {
    const snapshot = validSnapshot();
    const imagePayload = "i".repeat(1024 * 1024 + 1);
    snapshot.state.messageCount = 1;
    snapshot.messages = [
      {
        role: "user",
        content: [{ type: "image", data: imagePayload, mimeType: "image/png" }],
        timestamp: 1_754_500_000_000,
      },
    ];

    const projection = normalizeResidentProjectionSnapshot(snapshot, validBinding());

    expect(projection.transcript[0]?.text).toBe("[Image: image/png]");
    expect(JSON.stringify(projection)).not.toContain(imagePayload);
  });

  it("derives stable transcript and stream identities deterministically across newer cursors", () => {
    const snapshot = validSnapshot();
    snapshot.streamingMessage = assistantMessage(
      [{ type: "text", text: "Still working" }],
      1_754_500_020_000,
    );

    const first = normalizeResidentProjectionSnapshot(snapshot, validBinding());
    const same = normalizeResidentProjectionSnapshot(structuredClone(snapshot), validBinding());
    const newer = structuredClone(snapshot);
    newer.lastEventSequence = 18;
    newer.lastEventCursor = { generation: "daemon-generation-1", sequence: 18 };
    if (typeof newer.streamingMessage === "object" && newer.streamingMessage !== null) {
      (newer.streamingMessage as Record<string, unknown>).content = [
        { type: "text", text: "Still working, almost done" },
      ];
    }
    const advanced = normalizeResidentProjectionSnapshot(newer, validBinding());
    const compacted = structuredClone(newer);
    compacted.messages = compacted.messages.slice(1);
    compacted.state.messageCount = 2;
    compacted.lastEventSequence = 19;
    compacted.lastEventCursor = { generation: "daemon-generation-1", sequence: 19 };
    const afterPrefixCompaction = normalizeResidentProjectionSnapshot(compacted, validBinding());

    expect(same).toEqual(first);
    expect(same.transcript.map((block) => block.blockId)).toEqual(
      first.transcript.map((block) => block.blockId),
    );
    expect(advanced.transcript.map((block) => block.blockId)).toEqual(
      first.transcript.map((block) => block.blockId),
    );
    expect(advanced.stream?.blockId).toBe(first.stream?.blockId);
    expect(afterPrefixCompaction.transcript.map((block) => block.blockId)).toEqual(
      first.transcript.slice(1).map((block) => block.blockId),
    );
    expect(advanced.cursor.sequence).toBe(18);
    expect(advanced.stream?.text).toBe("Still working, almost done");
  });

  it("rejects oversized, non-serializable, cyclic, and accessor-bearing inputs", () => {
    const tooManyMessages = validSnapshot();
    tooManyMessages.messages = Array.from(
      { length: MAX_RESIDENT_PROJECTION_MESSAGES + 1 },
      (_, index) => ({ role: "user", content: `message ${index}`, timestamp: 1_754_500_000_000 + index }),
    );
    expectProjectionError(
      () => normalizeResidentProjectionSnapshot(tooManyMessages, validBinding()),
      "PRIME_PROJECTION_LIMIT_EXCEEDED",
    );

    const oversized = validSnapshot();
    oversized.replay = { payload: "x".repeat(MAX_RESIDENT_PROJECTION_INPUT_BYTES + 1) };
    expectProjectionError(
      () => normalizeResidentProjectionSnapshot(oversized, validBinding()),
      "PRIME_PROJECTION_LIMIT_EXCEEDED",
    );

    const bigint = validSnapshot();
    bigint.replay = { unsafe: 1n };
    expectProjectionError(
      () => normalizeResidentProjectionSnapshot(bigint, validBinding()),
      "PRIME_PROJECTION_NON_SERIALIZABLE",
    );

    const cyclic = validSnapshot();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    cyclic.replay = cycle;
    expectProjectionError(
      () => normalizeResidentProjectionSnapshot(cyclic, validBinding()),
      "PRIME_PROJECTION_NON_SERIALIZABLE",
    );

    const accessor = validSnapshot();
    let getterCalled = false;
    Object.defineProperty(accessor, "replay", {
      enumerable: true,
      get() {
        getterCalled = true;
        return {};
      },
    });
    expectProjectionError(
      () => normalizeResidentProjectionSnapshot(accessor, validBinding()),
      "PRIME_PROJECTION_NON_SERIALIZABLE",
    );
    expect(getterCalled).toBe(false);

    const arrayAccessor = validSnapshot();
    let arrayGetterCalled = false;
    Object.defineProperty(arrayAccessor.messages, "0", {
      enumerable: true,
      configurable: true,
      get() {
        arrayGetterCalled = true;
        return {
          role: "user",
          content: "must not be evaluated",
          timestamp: 1_754_500_000_000,
        };
      },
    });
    expectProjectionError(
      () => normalizeResidentProjectionSnapshot(arrayAccessor, validBinding()),
      "PRIME_PROJECTION_NON_SERIALIZABLE",
    );
    expect(arrayGetterCalled).toBe(false);
  });

  it.each([
    ["activeSessionId", "other-active-session"],
    ["sessionId", "other-session"],
    ["sessionFile", resolve("fixtures", "sessions", "other.jsonl")],
    ["cwd", resolve("fixtures", "other-workspace")],
  ])("rejects a snapshot whose %s disagrees with its durable binding", (field, value) => {
    const snapshot = validSnapshot();
    snapshot.state[field] = value;

    const error = expectProjectionError(
      () => normalizeResidentProjectionSnapshot(snapshot, validBinding()),
      "PRIME_PROJECTION_IDENTITY_MISMATCH",
    );
    expect(error.details).toMatchObject({ fields: field });
  });

  it("rejects missing, malformed, or internally inconsistent authoritative cursors", () => {
    const missing = validSnapshot();
    delete missing.lastEventCursor;
    expectProjectionError(
      () => normalizeResidentProjectionSnapshot(missing, validBinding()),
      "PRIME_PROJECTION_CURSOR_INVALID",
    );

    const inconsistent = validSnapshot();
    inconsistent.lastEventSequence = 18;
    expectProjectionError(
      () => normalizeResidentProjectionSnapshot(inconsistent, validBinding()),
      "PRIME_PROJECTION_CURSOR_INVALID",
    );

    const malformed = validSnapshot();
    malformed.lastEventCursor = { generation: "", sequence: -1 };
    expectProjectionError(
      () => normalizeResidentProjectionSnapshot(malformed, validBinding()),
      "PRIME_PROJECTION_INVALID",
    );
  });

  it("rejects a torn snapshot whose state count disagrees with its transcript", () => {
    const snapshot = validSnapshot();
    snapshot.state.messageCount = snapshot.messages.length + 1;

    const error = expectProjectionError(
      () => normalizeResidentProjectionSnapshot(snapshot, validBinding()),
      "PRIME_PROJECTION_INVALID",
    );
    expect(error.details).toEqual({
      messageCount: snapshot.messages.length + 1,
      transcriptCount: snapshot.messages.length,
    });
  });
});
