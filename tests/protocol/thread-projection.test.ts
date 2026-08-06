import { describe, expect, it } from "vitest";
import {
  ThreadProjectionDeltaSchema,
  ThreadProjectionSnapshotSchema,
  type ThreadProjectionDelta,
  type ThreadProjectionSnapshot,
} from "../../src/shared/protocol";
import { applyThreadProjectionDelta, ProjectionDeltaError } from "../../src/shared/thread-projection";

describe("thread projection deltas", () => {
  it("appends a transcript block without rebuilding unrelated runtime state", () => {
    const snapshot = baseSnapshot();
    const delta = parseDelta({
      kind: "transcript.append",
      cursor: nextCursor(),
      block: {
        blockId: "block-2",
        kind: "assistant",
        text: "Finished the runtime audit.",
        createdAt: "2026-08-06T00:00:02.000Z",
        sequence: 2,
      },
    });

    const next = applyThreadProjectionDelta(snapshot, delta, "2026-08-06T00:00:02.000Z");

    expect(next.latestCursor.sequence).toBe(2);
    expect(next.materializedRecentBlocks).toHaveLength(1);
    expect(next.transcriptBlockIndex[0]).toMatchObject({ blockId: "block-2", byteLength: 27 });
    expect(next.runtime).toBe(snapshot.runtime);
    expect(next.git).toEqual(snapshot.git);
  });

  it("treats duplicate and stale sequences as idempotent", () => {
    const snapshot = baseSnapshot();
    const stale = parseDelta({
      kind: "transcript.stream",
      cursor: { ...nextCursor(), sequence: 1 },
      stream: null,
    });

    expect(applyThreadProjectionDelta(snapshot, stale, "2026-08-06T00:00:02.000Z")).toBe(snapshot);
  });

  it("fails closed on gaps and stale execution or daemon generations", () => {
    const snapshot = baseSnapshot();
    const gap = parseDelta({
      kind: "transcript.stream",
      cursor: { ...nextCursor(), sequence: 3 },
      stream: null,
    });
    expect(() => applyThreadProjectionDelta(snapshot, gap, "2026-08-06T00:00:03.000Z")).toThrowError(
      expect.objectContaining<Partial<ProjectionDeltaError>>({ code: "PROJECTION_SEQUENCE_GAP" }),
    );

    const wrongExecution = parseDelta({
      kind: "transcript.stream",
      cursor: { ...nextCursor(), executionGenerationId: "execution-other" },
      stream: null,
    });
    expect(() => applyThreadProjectionDelta(snapshot, wrongExecution, "2026-08-06T00:00:02.000Z")).toThrowError(
      expect.objectContaining<Partial<ProjectionDeltaError>>({ code: "PROJECTION_EXECUTION_GENERATION_MISMATCH" }),
    );

    const wrongGeneration = parseDelta({
      kind: "transcript.stream",
      cursor: { ...nextCursor(), generation: "daemon-other" },
      stream: null,
    });
    expect(() => applyThreadProjectionDelta(snapshot, wrongGeneration, "2026-08-06T00:00:02.000Z")).toThrowError(
      expect.objectContaining<Partial<ProjectionDeltaError>>({ code: "PROJECTION_EVENT_GENERATION_MISMATCH" }),
    );
  });

  it("replaces the bounded RLM runtime projection and can clear a stream", () => {
    const runtimeDelta = parseDelta({
      kind: "runtime.replace",
      cursor: nextCursor(),
      runtime: {
        runtime: "prime_agent",
        residency: "resident",
        appVersion: "0.7.0",
        activeSessionId: "active-1",
        sessionId: "session-1",
        model: "openai/gpt-5.6",
        thinkingLevel: "high",
        isStreaming: true,
        isCompacting: false,
        isBashRunning: false,
        retryAttempt: 0,
        steeringMode: "one-at-a-time",
        followUpMode: "all",
        messageCount: 42,
        compactionCount: 1,
        queuedActionCount: 2,
        activeToolNames: ["bash"],
        context: { usedTokens: 12_000, maxTokens: 128_000 },
        recap: "Verifying the resident session boundary.",
      },
      queueState: { pendingCommandIds: ["command-2"], paused: false },
      childAgents: [
        {
          agentId: "child-1",
          title: "Protocol audit",
          state: "running",
          model: "openai/gpt-5.6",
          toolUseCount: 3,
          tokenCount: 9_000,
          activity: { kind: "executing", toolName: "bash" },
        },
      ],
      goals: [
        {
          goalId: "goal-1",
          objective: "Prove resident continuity",
          state: "active",
          tokenBudget: 100_000,
          tokensUsed: 12_000,
          timeUsedSeconds: 90,
          continuationsUsed: 0,
        },
      ],
      schedules: [
        {
          scheduleId: "schedule-1",
          label: "Continuity check",
          state: "active",
          kind: "interval",
          expression: "every 5m",
          runCount: 2,
        },
      ],
      threadStatus: "running",
      recap: "Verifying the resident session boundary.",
    });

    const running = applyThreadProjectionDelta(baseSnapshot(), runtimeDelta, "2026-08-06T00:00:02.000Z");
    expect(running.thread).toMatchObject({ status: "running", recap: "Verifying the resident session boundary." });
    expect(running.runtime).toMatchObject({ residency: "resident", queuedActionCount: 2 });
    expect(running.childAgents[0]).toMatchObject({ activity: { kind: "executing", toolName: "bash" } });
    expect(running.goals[0]).toMatchObject({ state: "active", tokensUsed: 12_000 });
    expect(running.schedules[0]).toMatchObject({ kind: "interval", runCount: 2 });

    const withStream = ThreadProjectionSnapshotSchema.parse({
      ...running,
      inProgressStream: {
        blockId: "stream-1",
        text: "Working",
        startedAt: "2026-08-06T00:00:02.000Z",
      },
    });
    const cleared = applyThreadProjectionDelta(
      withStream,
      parseDelta({
        kind: "transcript.stream",
        cursor: { ...nextCursor(), sequence: 3 },
        stream: null,
      }),
      "2026-08-06T00:00:03.000Z",
    );
    expect(cleared.inProgressStream).toBeUndefined();
  });
});

function parseDelta(value: unknown): ThreadProjectionDelta {
  return ThreadProjectionDeltaSchema.parse(value);
}

function nextCursor() {
  return {
    threadId: "thread-1",
    executionGenerationId: "execution-1",
    generation: "daemon-1",
    sequence: 2,
  };
}

function baseSnapshot(): ThreadProjectionSnapshot {
  const cursor = { ...nextCursor(), sequence: 1 };
  return ThreadProjectionSnapshotSchema.parse({
    snapshotVersion: 1,
    generatedAt: "2026-08-06T00:00:01.000Z",
    thread: {
      threadId: "thread-1",
      title: "Resident session",
      projectIdentity: "project-1",
      currentLocation: {
        hostId: "host-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        executionGenerationId: "execution-1",
      },
      status: "idle",
      unread: false,
      updatedAt: "2026-08-06T00:00:01.000Z",
      lastKnownCursor: cursor,
    },
    transcriptBlockIndex: [],
    materializedRecentBlocks: [],
    queueState: { pendingCommandIds: [], paused: false },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    runtime: {
      runtime: "prime_agent",
      residency: "unknown",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      messageCount: 0,
      compactionCount: 0,
      queuedActionCount: 0,
      activeToolNames: [],
    },
    git: { stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
    pendingAttention: [],
    latestCursor: cursor,
  });
}
