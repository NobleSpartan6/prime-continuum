import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_RESIDENT_PROJECTION_INPUT_BYTES,
  MAX_RESIDENT_PROJECTION_MESSAGES,
  ResidentProjectionError,
  normalizeResidentProjectionSnapshot,
  residentChildAgentSummaryFromSessionEvent,
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

function validResourceSnapshot(): Record<string, unknown> {
  return {
    contextFiles: [
      {
        path: resolve("private", "context", "AGENTS.md"),
        artifact: {
          id: "artifact-context-1",
          sessionId: "session-1",
          type: "context_file",
          logicalPath: "private/context/AGENTS.md",
          relativePath: "AGENTS.md",
          mimeType: "text/markdown",
        },
      },
    ],
    skills: [
      {
        name: "playwright-cli",
        description: "Automate browser interactions.",
        filePath: resolve("private", "skills", "playwright-cli", "SKILL.md"),
        sourceInfo: {
          path: resolve("private", "skills", "playwright-cli", "SKILL.md"),
          source: "private-package-source",
          scope: "project",
          origin: "package",
          baseDir: resolve("private", "skills"),
        },
        artifact: {
          id: "artifact-skill-1",
          sessionId: "session-1",
          type: "skill",
          logicalPath: "private/skills/playwright-cli/SKILL.md",
        },
      },
    ],
    prompts: [
      {
        name: "harness-review",
        description: "Review the continual harness.",
        argumentHint: "[focus]",
        filePath: resolve("private", "prompts", "harness-review.md"),
        sourceInfo: {
          path: resolve("private", "prompts", "harness-review.md"),
          source: "private-top-level-source",
          scope: "user",
          origin: "top-level",
        },
      },
    ],
    extensions: [
      {
        path: resolve("private", "extensions", "permission-gate.ts"),
        sourceInfo: {
          path: resolve("private", "extensions", "permission-gate.ts"),
          source: "private-extension-source",
          scope: "project",
          origin: "top-level",
        },
      },
    ],
    themes: [
      {
        name: "Continuim dark",
        sourcePath: resolve("private", "themes", "continuim.json"),
        sourceInfo: {
          path: resolve("private", "themes", "continuim.json"),
          source: "private-theme-source",
          scope: "temporary",
          origin: "package",
        },
      },
      { sourcePath: resolve("private", "themes", "unnamed.json") },
    ],
    diagnostics: {
      skills: [
        {
          type: "warning",
          message: "Private skill warning at /Users/private/skills",
          path: resolve("private", "skills", "broken", "SKILL.md"),
        },
      ],
      prompts: [
        {
          type: "error",
          message: "credential=must-not-cross",
          path: resolve("private", "prompts", "broken.md"),
        },
      ],
      extensions: [
        {
          type: "collision",
          message: "Private collision paths must not cross",
          collision: {
            resourceType: "extension",
            name: "permission-gate",
            winnerPath: resolve("private", "extensions", "winner.ts"),
            loserPath: resolve("private", "extensions", "loser.ts"),
            winnerSource: "private-winner-source",
            loserSource: "private-loser-source",
          },
        },
      ],
      themes: [],
    },
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
  it("canonicalizes an empty rehydrated recap to the same absent value", () => {
    const absentSnapshot = validSnapshot();
    const emptySnapshot = validSnapshot();
    delete absentSnapshot.state.recap;
    emptySnapshot.state.recap = "";

    const absentProjection = normalizeResidentProjectionSnapshot(absentSnapshot, validBinding());
    const emptyProjection = normalizeResidentProjectionSnapshot(emptySnapshot, validBinding());

    expect(absentProjection.runtime.recap).toBeUndefined();
    expect(emptyProjection.runtime.recap).toBeUndefined();
    expect(emptyProjection).toEqual(absentProjection);
  });

  it("accepts context usage above the nominal window while preserving exact token counts", () => {
    const snapshot = validSnapshot();
    snapshot.state.contextUsage = {
      tokens: 10_031,
      contextWindow: 8_192,
      percent: 122.44873046875,
    };

    const projection = normalizeResidentProjectionSnapshot(snapshot, validBinding());

    expect(projection.runtime.context).toEqual({
      usedTokens: 10_031,
      maxTokens: 8_192,
    });
  });

  it("produces a frozen, bounded host-owned projection from a representative v0.7.2 snapshot", () => {
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
      selectedModel: { providerId: "openai", modelId: "gpt-5.2" },
      runtime: {
        runtime: "prime_agent",
        residency: "resident",
        appVersion: "0.7.2",
        activeSessionId: "active-session-1",
        sessionId: "session-1",
        sessionName: "Continuim build",
        model: "openai/gpt-5.2",
        thinkingLevel: "high",
        availableThinkingLevels: ["off", "low", "medium", "high"],
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
    expect(Object.isFrozen(projection.selectedModel)).toBe(true);
    expect(Object.isFrozen(projection.runtime)).toBe(true);
    expect(Object.isFrozen(projection.runtime.availableThinkingLevels)).toBe(true);
    expect(Object.isFrozen(projection.transcript)).toBe(true);
    expect(Object.isFrozen(projection.transcript[0])).toBe(true);
    expect(Object.isFrozen(projection.childAgents[0]?.activity)).toBe(true);
  });

  it("rejects duplicate session-reported thinking levels at the upstream boundary", () => {
    const snapshot = validSnapshot();
    snapshot.state.availableThinkingLevels = ["low", "high", "high"];

    expectProjectionError(
      () => normalizeResidentProjectionSnapshot(snapshot, validBinding()),
      "PRIME_PROJECTION_INVALID",
    );
  });

  it("reduces native RLM protocol output to path-free, human-readable delegation events", () => {
    const privateRoot = "/Users/operator/Library/Application Support/PrimeAgent/hostd";
    const childId = "child-opaque-95e";
    const childActiveSessionId = "active-opaque-019f";
    const childSessionId = "session-opaque-019f";
    const messageId = "agentmsg_opaque_019f";
    const snapshot = validSnapshot();
    snapshot.state.messageCount = 2;
    snapshot.state.recap = `Working from ${privateRoot}/sessions/root`;
    snapshot.state.goal = {
      ...(snapshot.state.goal as Record<string, unknown>),
      objective: `Audit ${privateRoot}/workspace`,
    };
    snapshot.messages = [
      {
        role: "toolResult",
        toolCallId: "call-rlm",
        toolName: "rlm",
        content: [{
          type: "text",
          text: `RLMSpawnHandle(agent_id='${childId}', session_dir=PosixPath('${privateRoot}/children/${childId}'), model='openai-codex/gpt-5.6-sol')`,
        }],
        isError: false,
        timestamp: 1_754_500_020_000,
      },
      {
        role: "custom",
        customType: "agent_message",
        content: [
          `[from child:arithmetic-smoke-test]`,
          "Agent-to-agent message received.",
          "Source: native RLM",
          `From: arithmetic-smoke-test, active ${childActiveSessionId}, session ${childSessionId}`,
          `To: Continuim, active active-session-1, session session-1`,
          `Message id: ${messageId}`,
          "",
          "Result: 4",
        ].join("\n"),
        display: true,
        timestamp: 1_754_500_021_000,
      },
    ];
    snapshot.children = [{
      id: childId,
      activeSessionId: childActiveSessionId,
      sessionName: "arithmetic-smoke-test",
      model: "openai-codex/gpt-5.6-sol",
      label: `Inspect ${privateRoot}/workspace`,
      status: "done",
      answerPreview: `Result: 4 from ${privateRoot}/result.txt`,
      repliedSinceTask: true,
      recap: `Read ${privateRoot}/result.txt`,
      sessionDir: `${privateRoot}/children/${childId}`,
    }];

    const projection = normalizeResidentProjectionSnapshot(snapshot, validBinding());

    expect(projection.transcript.map((block) => block.text)).toEqual([
      "rlm\nDelegated to arithmetic-smoke-test · openai-codex/gpt-5.6-sol",
      "Agent message\nFrom arithmetic-smoke-test\nResult: 4",
    ]);
    expect(projection.childAgents[0]).toMatchObject({
      title: "Inspect [local path]",
      answerPreview: "Result: 4 from [local path]",
      recap: "Read [local path]",
    });
    expect(projection.runtime.recap).toBe("Working from [local path]");
    expect(projection.goal?.objective).toBe("Audit [local path]");

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(privateRoot);
    expect(serialized).not.toContain("Application Support");
    expect(serialized).not.toContain(childSessionId);
    expect(serialized).not.toContain(messageId);
    expect(serialized).not.toContain("session_dir");
    expect(serialized).not.toContain("RLMSpawnHandle");
  });

  it("publishes a strict path-free resource inventory for the exact resident session", () => {
    const resources = validResourceSnapshot();
    const projection = normalizeResidentProjectionSnapshot(validSnapshot(), validBinding(), resources);

    expect(projection.runtime.resourceInventory).toEqual({
      skills: [
        {
          name: "playwright-cli",
          description: "Automate browser interactions.",
          sourceKind: { scope: "project", origin: "package" },
        },
      ],
      prompts: [
        {
          name: "harness-review",
          description: "Review the continual harness.",
          sourceKind: { scope: "user", origin: "top-level" },
        },
      ],
      themes: [
        {
          name: "Continuim dark",
          sourceKind: { scope: "temporary", origin: "package" },
        },
      ],
      extensions: {
        count: 1,
        sourceKinds: [{ scope: "project", origin: "top-level" }],
      },
      contextFileCount: 1,
      diagnostics: {
        warningCount: 1,
        errorCount: 1,
        collisions: [{ resourceType: "extension", name: "permission-gate" }],
      },
    });

    const serialized = JSON.stringify(projection.runtime.resourceInventory);
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain("\\private\\");
    expect(serialized).not.toContain("must-not-cross");
    expect(serialized).not.toContain("private-package-source");
    expect(serialized).not.toContain("artifact-skill-1");
    expect(serialized).not.toContain("filePath");
    expect(serialized).not.toContain("sourcePath");
    expect(serialized).not.toContain("artifact");
    expect(Object.isFrozen(projection.runtime.resourceInventory)).toBe(true);
  });

  it("compacts Prime Agent prompt-sized RLM labels without dropping the child", () => {
    const label = `Inspect the workspace read-only and report the package name. ${"evidence ".repeat(40)}`;
    const child = {
      id: "child-long-label",
      sessionName: "smoke-checker",
      model: "openai-codex/gpt-5.6-sol",
      label,
      status: "done",
      sessionDir: resolve("private", "child-long-label"),
    };
    const snapshot = validSnapshot();
    snapshot.children = [child];

    const projection = normalizeResidentProjectionSnapshot(snapshot, validBinding());
    const eventChild = residentChildAgentSummaryFromSessionEvent({
      type: "rlm_child_update",
      child,
    });

    expect(projection.childAgents).toEqual([
      expect.objectContaining({
        agentId: "child-long-label",
        sessionName: "smoke-checker",
        state: "complete",
      }),
    ]);
    expect(projection.childAgents[0]?.title).toHaveLength(255);
    expect(projection.childAgents[0]?.title.endsWith("…")).toBe(true);
    expect(eventChild).toEqual(projection.childAgents[0]);
  });

  it("rejects malformed or oversized resource snapshots before publication", () => {
    const malformed = validResourceSnapshot();
    (malformed.skills as unknown[])[0] = {
      ...(malformed.skills as Array<Record<string, unknown>>)[0],
      credential: "must-not-cross",
    };
    expectProjectionError(
      () => normalizeResidentProjectionSnapshot(validSnapshot(), validBinding(), malformed),
      "PRIME_PROJECTION_INVALID",
    );

    const oversized = validResourceSnapshot();
    oversized.skills = Array.from({ length: 2_001 }, (_, index) => ({
      name: `skill-${index}`,
      filePath: resolve("private", "skills", `skill-${index}`, "SKILL.md"),
    }));
    expectProjectionError(
      () => normalizeResidentProjectionSnapshot(validSnapshot(), validBinding(), oversized),
      "PRIME_PROJECTION_LIMIT_EXCEEDED",
    );
  });

  it("preserves the exact private model pair when public display strings collide", () => {
    const firstSnapshot = validSnapshot();
    const secondSnapshot = validSnapshot();
    firstSnapshot.state.model = { provider: "openrouter", id: "anthropic/claude" };
    secondSnapshot.state.model = { provider: "openrouter/anthropic", id: "claude" };

    const first = normalizeResidentProjectionSnapshot(firstSnapshot, validBinding());
    const second = normalizeResidentProjectionSnapshot(secondSnapshot, validBinding());

    expect(first.runtime.model).toBe("openrouter/anthropic/claude");
    expect(second.runtime.model).toBe(first.runtime.model);
    expect(first.selectedModel).toEqual({ providerId: "openrouter", modelId: "anthropic/claude" });
    expect(second.selectedModel).toEqual({ providerId: "openrouter/anthropic", modelId: "claude" });
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
