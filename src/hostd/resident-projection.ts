import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import {
  ChildAgentSummarySchema,
  GoalSummarySchema,
  IdSchema,
  InProgressStreamSchema,
  RuntimeResourceInventorySchema,
  RuntimeSessionSummarySchema,
  TranscriptBlockSchema,
  type ChildAgentSummary,
  type GoalSummary,
  type InProgressStream,
  type RuntimeResourceInventory,
  type RuntimeSessionSummary,
  type TranscriptBlock,
} from "../shared/protocol";
import {
  type ResidentSessionBinding,
  validateResidentSessionBinding,
} from "./resident-runtime";
import {
  sanitizeResidentDisplayText,
  type ResidentDisplayRedactionContext,
} from "../shared/resident-display";

export const MAX_RESIDENT_PROJECTION_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_RESIDENT_PROJECTION_MESSAGES = 2_000;
export const MAX_RESIDENT_PROJECTION_CHILDREN = 1_000;
export const MAX_RESIDENT_PROJECTION_TEXT_CHARS = 262_144;

// This must not be lower than the largest explicitly accepted string below.
// Image payloads are discarded from the projection, but they still arrive in a
// valid pinned snapshot and must reach the field-specific schema check.
const MAX_GENERIC_STRING_CHARS = 2 * 1024 * 1024;
const MAX_CONTENT_ITEMS = 256;
const MAX_QUEUE_ITEMS = 1_000;
const MAX_RESOURCE_ITEMS = 2_000;
const MAX_OBJECT_KEYS = 256;
const MAX_ARRAY_ITEMS = 20_000;
const MAX_GRAPH_NODES = 200_000;
const MAX_GRAPH_DEPTH = 32;
const MAX_IMAGE_DATA_CHARS = 2 * 1024 * 1024;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

export type ResidentProjectionErrorCode =
  | "PRIME_PROJECTION_INVALID"
  | "PRIME_PROJECTION_LIMIT_EXCEEDED"
  | "PRIME_PROJECTION_NON_SERIALIZABLE"
  | "PRIME_PROJECTION_CURSOR_INVALID"
  | "PRIME_PROJECTION_IDENTITY_MISMATCH";

/** A terminal rejection at the untrusted Prime Agent snapshot boundary. */
export class ResidentProjectionError extends Error {
  readonly code: ResidentProjectionErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: ResidentProjectionErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = "ResidentProjectionError";
    this.code = code;
    this.details = details ? Object.freeze({ ...details }) : undefined;
  }
}

export interface ResidentProjectionIdentity {
  readonly activeSessionId: string;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly workspaceDirectory: string;
}

export interface ResidentProjectionCursor {
  readonly generation: string;
  readonly sequence: number;
}

export interface ResidentProjectionQueueSummary {
  readonly queuedCount: number;
  readonly steeringCount: number;
  readonly followUpCount: number;
  readonly active?: Readonly<{
    kind: "turn" | "session_command";
    phase: "preparing" | "committing" | "running";
    label?: string;
  }>;
}

export interface ResidentProjectionSelectedModelIdentity {
  readonly providerId: string;
  readonly modelId: string;
}

/** Private request-scoped marker for one finalized non-tool-use assistant result. */
export interface ResidentTerminalAssistantMarker {
  readonly digest: string;
  readonly timestamp: number;
  readonly stopReason: "stop" | "length" | "error" | "aborted";
}

/**
 * Private host-owned projection of a pinned Prime Agent v0.7.1 snapshot.
 * It is deliberately not a public IPC DTO: session paths remain host-private.
 */
export interface ResidentProjectionSnapshot {
  readonly projectionVersion: 1;
  readonly identity: Readonly<ResidentProjectionIdentity>;
  readonly cursor: Readonly<ResidentProjectionCursor>;
  /** Exact private identity; the public runtime model remains display-only. */
  readonly selectedModel?: Readonly<ResidentProjectionSelectedModelIdentity>;
  readonly terminalAssistant?: Readonly<ResidentTerminalAssistantMarker>;
  readonly runtime: Readonly<RuntimeSessionSummary>;
  readonly transcript: readonly Readonly<TranscriptBlock>[];
  readonly stream?: Readonly<InProgressStream>;
  readonly childAgents: readonly Readonly<ChildAgentSummary>[];
  readonly goal?: Readonly<GoalSummary>;
  readonly queue: Readonly<ResidentProjectionQueueSummary>;
}

const ShortStringSchema = z.string().min(1).max(255).refine(noControlCharacters, {
  message: "Control characters are not allowed",
});
const OptionalShortStringSchema = z.string().max(255).refine(noControlCharacters, {
  message: "Control characters are not allowed",
});
const WirePathSchema = z.string().min(1).max(4_096).refine(noNullOrLineBreaks, {
  message: "Paths cannot contain control line breaks or NUL bytes",
});
const ProjectionTextSchema = z.string().max(MAX_RESIDENT_PROJECTION_TEXT_CHARS);
const StatusTextSchema = z.string().max(4_096);
const TimestampSchema = z.number().int().nonnegative().max(MAX_TIMESTAMP_MS);
const SafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const TextContentSchema = z
  .object({
    type: z.literal("text"),
    text: ProjectionTextSchema,
    textSignature: z.string().max(65_536).optional(),
  })
  .strict();

const ImageContentSchema = z
  .object({
    type: z.literal("image"),
    data: z.string().max(MAX_IMAGE_DATA_CHARS),
    mimeType: z
      .string()
      .min(1)
      .max(128)
      .regex(/^image\/[A-Za-z0-9.+-]+$/),
  })
  .strict();

const ThinkingContentSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: ProjectionTextSchema,
    thinkingSignature: z.string().max(65_536).optional(),
    redacted: z.boolean().optional(),
  })
  .strict();

const ToolCallSchema = z
  .object({
    type: z.literal("toolCall"),
    id: ShortStringSchema,
    name: ShortStringSchema,
    arguments: z.record(z.string(), z.unknown()),
    thoughtSignature: z.string().max(65_536).optional(),
  })
  .strict();

const DisplayContentSchema = z
  .array(z.union([TextContentSchema, ImageContentSchema]))
  .max(MAX_CONTENT_ITEMS);
const AssistantContentSchema = z
  .array(z.union([TextContentSchema, ThinkingContentSchema, ToolCallSchema]))
  .max(MAX_CONTENT_ITEMS);

const UserMessageSchema = z
  .object({
    role: z.literal("user"),
    content: z.union([ProjectionTextSchema, DisplayContentSchema]),
    timestamp: TimestampSchema,
  })
  .strict();

const AssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: AssistantContentSchema,
    api: ShortStringSchema,
    provider: ShortStringSchema,
    model: ShortStringSchema,
    responseModel: ShortStringSchema.optional(),
    responseId: z.string().max(4_096).optional(),
    diagnostics: z.unknown().optional(),
    usage: z.unknown(),
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
    stopReasonRaw: OptionalShortStringSchema.optional(),
    errorMessage: StatusTextSchema.optional(),
    timestamp: TimestampSchema,
  })
  .strict();

const ToolResultMessageSchema = z
  .object({
    role: z.literal("toolResult"),
    toolCallId: ShortStringSchema,
    toolName: ShortStringSchema,
    content: DisplayContentSchema,
    details: z.unknown().optional(),
    isError: z.boolean(),
    timestamp: TimestampSchema,
  })
  .strict();

const BashExecutionMessageSchema = z
  .object({
    role: z.literal("bashExecution"),
    command: ProjectionTextSchema,
    output: ProjectionTextSchema,
    exitCode: z.number().int().safe().optional(),
    cancelled: z.boolean(),
    truncated: z.boolean(),
    fullOutputPath: WirePathSchema.optional(),
    excludeFromContext: z.boolean().optional(),
    timestamp: TimestampSchema,
  })
  .strict();

const CustomMessageSchema = z
  .object({
    role: z.literal("custom"),
    customType: ShortStringSchema,
    content: z.union([ProjectionTextSchema, DisplayContentSchema]),
    display: z.boolean(),
    details: z.unknown().optional(),
    timestamp: TimestampSchema,
  })
  .strict();

const BranchSummaryMessageSchema = z
  .object({
    role: z.literal("branchSummary"),
    summary: ProjectionTextSchema,
    fromId: ShortStringSchema,
    timestamp: TimestampSchema,
  })
  .strict();

const CompactionSummaryMessageSchema = z
  .object({
    role: z.literal("compactionSummary"),
    summary: ProjectionTextSchema,
    tokensBefore: SafeIntegerSchema,
    retainedMessageCount: SafeIntegerSchema.optional(),
    customInstructions: StatusTextSchema.optional(),
    timestamp: TimestampSchema,
  })
  .strict();

const AgentMessageSchema = z.discriminatedUnion("role", [
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
  BashExecutionMessageSchema,
  CustomMessageSchema,
  BranchSummaryMessageSchema,
  CompactionSummaryMessageSchema,
]);

type PinnedAgentMessage = z.infer<typeof AgentMessageSchema>;
type PinnedAssistantMessage = z.infer<typeof AssistantMessageSchema>;

const GoalStateSchema = z
  .object({
    active: z.boolean(),
    status: z.enum(["idle", "active", "paused", "budget_limited", "complete", "error"]),
    goalId: IdSchema.optional(),
    objective: z.string().min(1).max(4_096).optional(),
    tokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    tokensUsed: SafeIntegerSchema,
    timeUsedSeconds: SafeIntegerSchema,
    continuationsUsed: z.number().int().nonnegative().max(1_000_000),
    createdAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema.optional(),
    lastReason: StatusTextSchema.optional(),
    lastError: StatusTextSchema.optional(),
  })
  .strict();

const SessionActionsSchema = z
  .object({
    queuedCount: z.number().int().nonnegative().max(1_000_000),
    steering: z.array(ProjectionTextSchema).max(MAX_QUEUE_ITEMS),
    followUps: z.array(ProjectionTextSchema).max(MAX_QUEUE_ITEMS),
    active: z
      .object({
        kind: z.enum(["turn", "session_command"]),
        phase: z.enum(["preparing", "committing", "running"]),
        label: ShortStringSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ModelSchema = z
  .object({
    provider: z.string().min(1).max(128).refine(noControlCharacters),
    id: z.string().min(1).max(512).refine(noControlCharacters),
  })
  .passthrough();

const ContextUsageSchema = z
  .object({
    tokens: SafeIntegerSchema.nullable(),
    contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    // Prime can legitimately exceed the nominal context window before its
    // compaction boundary settles. The percentage is informational and is not
    // published; retain only its finite/nonnegative wire-shape constraint.
    percent: z.number().finite().nonnegative().nullable(),
  })
  .strict();

const AgentStateSchema = z
  .object({
    activeSessionId: IdSchema.optional(),
    cwd: WirePathSchema,
    model: ModelSchema.optional(),
    thinkingLevel: z.string().min(1).max(64).refine(noControlCharacters),
    serviceTier: z.string().min(1).max(64).refine(noControlCharacters),
    availableThinkingLevels: z
      .array(z.string().min(1).max(64).refine(noControlCharacters))
      .max(128),
    isStreaming: z.boolean(),
    isCompacting: z.boolean(),
    isBashRunning: z.boolean(),
    retryAttempt: z.number().int().nonnegative().max(1_000_000),
    steeringMode: z.enum(["all", "one-at-a-time"]),
    followUpMode: z.enum(["all", "one-at-a-time"]),
    sessionFile: WirePathSchema.optional(),
    sessionId: IdSchema,
    sessionName: ShortStringSchema.optional(),
    sessionDir: WirePathSchema.optional(),
    leafId: z.string().min(1).max(4_096).nullable(),
    autoCompactionEnabled: z.boolean(),
    messageCount: SafeIntegerSchema,
    sessionActions: SessionActionsSchema,
    compactionCount: SafeIntegerSchema,
    goal: GoalStateSchema,
    heartbeat: z.unknown().nullable().optional(),
    scopedModels: z.array(z.unknown()).max(128),
    activeToolNames: z.array(ShortStringSchema).max(128),
    contextUsage: ContextUsageSchema.optional(),
    recap: z.string().max(4_096).optional(),
  })
  .strict();

const ChildAgentSchema = z
  .object({
    id: IdSchema,
    parentId: IdSchema.optional(),
    activeSessionId: IdSchema.optional(),
    sessionName: ShortStringSchema.optional(),
    model: ShortStringSchema.optional(),
    // Prime Agent uses the delegated prompt as the child label. Keep the
    // private input bounded, then compact it before it reaches the public UI.
    label: ProjectionTextSchema.refine(noNullOrLineBreaks, {
      message: "Child labels cannot contain control line breaks or NUL bytes",
    }),
    status: z.enum(["queued", "running", "done", "error", "cancelled"]),
    durationMs: SafeIntegerSchema.optional(),
    answerPreview: z.string().max(4_096).optional(),
    repliedSinceTask: z.boolean().optional(),
    toolUseCount: z.number().int().nonnegative().max(1_000_000).optional(),
    tokenCount: SafeIntegerSchema.optional(),
    recap: z.string().max(4_096).optional(),
    sessionDir: WirePathSchema,
    activity: z
      .object({
        kind: z.enum(["waiting", "writing", "executing"]),
        toolName: ShortStringSchema.optional(),
      })
      .strict()
      .optional(),
    error: z.string().max(2_048).optional(),
  })
  .strict();

const ResourceArtifactSchema = z
  .object({
    id: ShortStringSchema,
    sessionId: ShortStringSchema,
    type: z.enum(["context_file", "extension", "prompt", "skill", "theme"]),
    logicalPath: WirePathSchema,
    relativePath: WirePathSchema.optional(),
    mimeType: z.string().min(1).max(255).refine(noControlCharacters).optional(),
  })
  .strict();

const ResourceSourceInfoSchema = z
  .object({
    path: WirePathSchema,
    source: z.string().min(1).max(4_096).refine(noNullOrLineBreaks),
    scope: z.enum(["user", "project", "temporary"]),
    origin: z.enum(["package", "top-level"]),
    baseDir: WirePathSchema.optional(),
  })
  .strict();

const ResourceSkillSchema = z
  .object({
    name: ShortStringSchema,
    description: StatusTextSchema.optional(),
    filePath: WirePathSchema,
    sourceInfo: ResourceSourceInfoSchema.optional(),
    artifact: ResourceArtifactSchema.optional(),
  })
  .strict();

const ResourcePromptSchema = z
  .object({
    name: ShortStringSchema,
    description: StatusTextSchema.optional(),
    argumentHint: StatusTextSchema.optional(),
    filePath: WirePathSchema,
    sourceInfo: ResourceSourceInfoSchema.optional(),
    artifact: ResourceArtifactSchema.optional(),
  })
  .strict();

const ResourceExtensionSchema = z
  .object({
    path: WirePathSchema,
    sourceInfo: ResourceSourceInfoSchema.optional(),
    artifact: ResourceArtifactSchema.optional(),
  })
  .strict();

const ResourceThemeSchema = z
  .object({
    name: ShortStringSchema.optional(),
    sourcePath: WirePathSchema.optional(),
    sourceInfo: ResourceSourceInfoSchema.optional(),
    artifact: ResourceArtifactSchema.optional(),
  })
  .strict();

const ResourceContextFileSchema = z
  .object({
    path: WirePathSchema,
    artifact: ResourceArtifactSchema.optional(),
  })
  .strict();

const ResourceCollisionSchema = z
  .object({
    resourceType: z.enum(["extension", "skill", "prompt", "theme"]),
    name: ShortStringSchema,
    winnerPath: WirePathSchema,
    loserPath: WirePathSchema,
    winnerSource: z.string().max(4_096).refine(noNullOrLineBreaks).optional(),
    loserSource: z.string().max(4_096).refine(noNullOrLineBreaks).optional(),
  })
  .strict();

const ResourceDiagnosticSchema = z
  .object({
    type: z.enum(["warning", "error", "collision"]),
    message: StatusTextSchema,
    path: WirePathSchema.optional(),
    collision: ResourceCollisionSchema.optional(),
  })
  .strict()
  .superRefine((diagnostic, context) => {
    if ((diagnostic.type === "collision") !== (diagnostic.collision !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["collision"],
        message: "Collision details must appear only on collision diagnostics",
      });
    }
  });

const ResourceSnapshotSchema = z
  .object({
    contextFiles: z.array(ResourceContextFileSchema).max(MAX_RESOURCE_ITEMS),
    skills: z.array(ResourceSkillSchema).max(MAX_RESOURCE_ITEMS),
    prompts: z.array(ResourcePromptSchema).max(MAX_RESOURCE_ITEMS),
    extensions: z.array(ResourceExtensionSchema).max(MAX_RESOURCE_ITEMS),
    themes: z.array(ResourceThemeSchema).max(1_000),
    diagnostics: z
      .object({
        skills: z.array(ResourceDiagnosticSchema).max(MAX_RESOURCE_ITEMS),
        prompts: z.array(ResourceDiagnosticSchema).max(MAX_RESOURCE_ITEMS),
        extensions: z.array(ResourceDiagnosticSchema).max(MAX_RESOURCE_ITEMS),
        themes: z.array(ResourceDiagnosticSchema).max(MAX_RESOURCE_ITEMS),
      })
      .strict(),
  })
  .strict();
type PinnedResourceSnapshot = z.infer<typeof ResourceSnapshotSchema>;

const CursorSchema = z
  .object({
    generation: z.string().min(1).max(256).refine(noControlCharacters),
    sequence: SafeIntegerSchema,
  })
  .strict();

const PinnedAgentConnectionSnapshotSchema = z
  .object({
    state: AgentStateSchema,
    messages: z.array(AgentMessageSchema).max(MAX_RESIDENT_PROJECTION_MESSAGES),
    streamingMessage: AssistantMessageSchema.optional(),
    sessionContext: z.unknown().optional(),
    sessionTree: z.unknown().optional(),
    parent: z.unknown().optional(),
    children: z.array(ChildAgentSchema).max(MAX_RESIDENT_PROJECTION_CHILDREN).optional(),
    lastEventSequence: SafeIntegerSchema.optional(),
    lastEventCursor: CursorSchema.optional(),
    replay: z.unknown().optional(),
  })
  .strict();

type PinnedSnapshot = z.infer<typeof PinnedAgentConnectionSnapshotSchema>;

const ResidentProjectionIdentitySchema = z
  .object({
    activeSessionId: IdSchema,
    sessionId: IdSchema,
    sessionFile: WirePathSchema.optional(),
    workspaceDirectory: WirePathSchema,
  })
  .strict();

const ResidentProjectionQueueSummarySchema = z
  .object({
    queuedCount: z.number().int().nonnegative().max(1_000_000),
    steeringCount: z.number().int().nonnegative().max(MAX_QUEUE_ITEMS),
    followUpCount: z.number().int().nonnegative().max(MAX_QUEUE_ITEMS),
    active: SessionActionsSchema.shape.active,
  })
  .strict();

/**
 * Normalize an unknown authoritative snapshot from the exact pinned daemon.
 * The function has no clock or random dependency, never mutates its input, and
 * returns a deeply frozen object whose fields are all owned by hostd.
 */
export function normalizeResidentProjectionSnapshot(
  value: unknown,
  bindingValue: ResidentSessionBinding,
  resourceValue?: unknown,
): ResidentProjectionSnapshot {
  const binding = validateResidentSessionBinding(bindingValue);
  assertBoundedJsonValue(value);
  if (resourceValue !== undefined) assertBoundedJsonValue(resourceValue);

  const parsed = PinnedAgentConnectionSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    const isLimit = parsed.error.issues.some((issue) => issue.code === "too_big");
    throw new ResidentProjectionError(
      isLimit ? "PRIME_PROJECTION_LIMIT_EXCEEDED" : "PRIME_PROJECTION_INVALID",
      "Prime Agent returned an invalid authoritative snapshot.",
      { issues: formatZodIssues(parsed.error) },
    );
  }

  const snapshot = parsed.data;
  const displayContext = createResidentDisplayRedactionContext(binding, snapshot.children ?? []);
  const resources = resourceValue === undefined
    ? undefined
    : parseResourceSnapshot(resourceValue, displayContext);
  const cursor = requireAuthoritativeCursor(snapshot);
  assertBindingIdentity(snapshot, binding);
  assertSnapshotConsistency(snapshot);

  const blockIdOccurrences = new Map<string, number>();
  const transcript = snapshot.messages.flatMap((message, index) => {
    const block = normalizeTranscriptMessage(
      message,
      index,
      binding.sessionId,
      blockIdOccurrences,
      displayContext,
    );
    return block ? [block] : [];
  });
  const stream = snapshot.streamingMessage
    ? normalizeStream(snapshot.streamingMessage, binding.sessionId, displayContext)
    : undefined;
  const childAgents = (snapshot.children ?? []).map((child) => normalizeChildAgent(child, displayContext));
  const goal = normalizeGoal(snapshot.state.goal, displayContext);
  const selectedModel = snapshot.state.model
    ? {
        providerId: snapshot.state.model.provider,
        modelId: snapshot.state.model.id,
      }
    : undefined;
  const terminalAssistant = findTerminalAssistantMarker(snapshot.messages);
  const runtime = normalizeRuntime(snapshot, binding, resources, displayContext);
  const queue = ResidentProjectionQueueSummarySchema.parse({
    queuedCount: snapshot.state.sessionActions.queuedCount,
    steeringCount: snapshot.state.sessionActions.steering.length,
    followUpCount: snapshot.state.sessionActions.followUps.length,
    ...(snapshot.state.sessionActions.active
      ? {
          active: {
            ...snapshot.state.sessionActions.active,
            ...(snapshot.state.sessionActions.active.label
              ? {
                  label: sanitizeResidentDisplayText(
                    snapshot.state.sessionActions.active.label,
                    displayContext,
                  ),
                }
              : {}),
          },
        }
      : {}),
  });

  const output: ResidentProjectionSnapshot = {
    projectionVersion: 1,
    identity: ResidentProjectionIdentitySchema.parse({
      activeSessionId: binding.activeSessionId,
      sessionId: binding.sessionId,
      ...(binding.sessionFile ? { sessionFile: binding.sessionFile } : {}),
      workspaceDirectory: binding.workspaceDirectory,
    }),
    cursor,
    ...(selectedModel ? { selectedModel } : {}),
    ...(terminalAssistant ? { terminalAssistant } : {}),
    runtime,
    transcript,
    ...(stream ? { stream } : {}),
    childAgents,
    ...(goal ? { goal } : {}),
    queue,
  };

  assertNormalizedOutputSize(output);
  return deepFreeze(output);
}

/**
 * Extract the same bounded, opaque marker from a public Prime session event.
 * The marker contains no provider output or tool arguments and is useful only
 * for matching the later authoritative snapshot on this connection.
 */
export function residentTerminalAssistantMarkerFromSessionEvent(
  value: unknown,
): ResidentTerminalAssistantMarker | undefined {
  assertBoundedJsonValue(value);
  const parsed = z
    .object({ type: z.literal("message_end"), message: AssistantMessageSchema })
    .passthrough()
    .safeParse(value);
  if (!parsed.success) return undefined;
  return terminalAssistantMarker(parsed.data.message);
}

/** Normalize one live RLM child update without retaining its private session directory. */
export function residentChildAgentSummaryFromSessionEvent(
  value: unknown,
): ChildAgentSummary | undefined {
  assertBoundedJsonValue(value);
  const parsed = z
    .object({ type: z.literal("rlm_child_update"), child: ChildAgentSchema })
    .passthrough()
    .safeParse(value);
  return parsed.success ? Object.freeze(normalizeChildAgent(parsed.data.child)) : undefined;
}

function findTerminalAssistantMarker(
  messages: readonly PinnedAgentMessage[],
): ResidentTerminalAssistantMarker | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const marker = terminalAssistantMarker(message);
    if (marker) return marker;
  }
  return undefined;
}

function terminalAssistantMarker(
  message: PinnedAssistantMessage,
): ResidentTerminalAssistantMarker | undefined {
  if (message.stopReason === "toolUse") return undefined;
  const digest = createHash("sha256")
    .update(JSON.stringify({
      content: message.content,
      api: message.api,
      provider: message.provider,
      model: message.model,
      responseModel: message.responseModel ?? null,
      responseId: message.responseId ?? null,
      stopReason: message.stopReason,
      stopReasonRaw: message.stopReasonRaw ?? null,
      errorMessage: message.errorMessage ?? null,
      timestamp: message.timestamp,
    }), "utf8")
    .digest("hex");
  return Object.freeze({
    digest,
    timestamp: message.timestamp,
    stopReason: message.stopReason,
  });
}

function requireAuthoritativeCursor(snapshot: PinnedSnapshot): ResidentProjectionCursor {
  if (!snapshot.lastEventCursor) {
    throw new ResidentProjectionError(
      "PRIME_PROJECTION_CURSOR_INVALID",
      "Prime Agent snapshot is missing its authoritative event cursor.",
    );
  }
  if (
    snapshot.lastEventSequence !== undefined &&
    snapshot.lastEventSequence !== snapshot.lastEventCursor.sequence
  ) {
    throw new ResidentProjectionError(
      "PRIME_PROJECTION_CURSOR_INVALID",
      "Prime Agent snapshot event sequence disagrees with its cursor.",
      {
        cursorSequence: snapshot.lastEventCursor.sequence,
        lastEventSequence: snapshot.lastEventSequence,
      },
    );
  }
  return Object.freeze({ ...snapshot.lastEventCursor });
}

function assertBindingIdentity(snapshot: PinnedSnapshot, binding: ResidentSessionBinding): void {
  const mismatches: string[] = [];
  if (snapshot.state.activeSessionId !== binding.activeSessionId) mismatches.push("activeSessionId");
  if (snapshot.state.sessionId !== binding.sessionId) mismatches.push("sessionId");
  if (snapshot.state.sessionFile !== binding.sessionFile) mismatches.push("sessionFile");
  if (!sameWorkspacePath(snapshot.state.cwd, binding.workspaceDirectory)) mismatches.push("cwd");

  if (mismatches.length > 0) {
    throw new ResidentProjectionError(
      "PRIME_PROJECTION_IDENTITY_MISMATCH",
      "Prime Agent snapshot does not belong to the durable resident binding.",
      { fields: mismatches.join(",") },
    );
  }
}

function assertSnapshotConsistency(snapshot: PinnedSnapshot): void {
  if (snapshot.state.messageCount !== snapshot.messages.length) {
    throw new ResidentProjectionError(
      "PRIME_PROJECTION_INVALID",
      "Prime Agent returned an internally inconsistent transcript count.",
      {
        messageCount: snapshot.state.messageCount,
        transcriptCount: snapshot.messages.length,
      },
    );
  }
}

function parseResourceSnapshot(
  value: unknown,
  displayContext: ResidentDisplayRedactionContext,
): RuntimeResourceInventory {
  const parsed = ResourceSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    const isLimit = parsed.error.issues.some((issue) => issue.code === "too_big");
    throw new ResidentProjectionError(
      isLimit ? "PRIME_PROJECTION_LIMIT_EXCEEDED" : "PRIME_PROJECTION_INVALID",
      "Prime Agent returned an invalid resource inventory snapshot.",
      { issues: formatZodIssues(parsed.error) },
    );
  }
  return normalizeResourceInventory(parsed.data, displayContext);
}

function normalizeResourceInventory(
  resources: PinnedResourceSnapshot,
  displayContext: ResidentDisplayRedactionContext,
): RuntimeResourceInventory {
  const sourceKind = (
    source: z.infer<typeof ResourceSourceInfoSchema> | undefined,
  ): { scope: "user" | "project" | "temporary"; origin: "package" | "top-level" } | undefined =>
    source ? { scope: source.scope, origin: source.origin } : undefined;
  const namedResource = (
    resource: Readonly<{
      name: string;
      description?: string;
      sourceInfo?: z.infer<typeof ResourceSourceInfoSchema>;
    }>,
  ) => ({
    name: resource.name,
    ...(resource.description !== undefined
      ? { description: sanitizeResidentDisplayText(resource.description, displayContext) }
      : {}),
    ...(resource.sourceInfo ? { sourceKind: sourceKind(resource.sourceInfo) } : {}),
  });
  const extensionSourceKinds = resources.extensions.flatMap((extension) => {
    const kind = sourceKind(extension.sourceInfo);
    return kind ? [kind] : [];
  }).filter((kind, index, items) =>
    items.findIndex((candidate) => candidate.scope === kind.scope && candidate.origin === kind.origin) === index,
  );
  const diagnostics = [
    ...resources.diagnostics.skills,
    ...resources.diagnostics.prompts,
    ...resources.diagnostics.extensions,
    ...resources.diagnostics.themes,
  ];

  return RuntimeResourceInventorySchema.parse({
    skills: resources.skills.map(namedResource),
    prompts: resources.prompts.map(namedResource),
    themes: resources.themes.flatMap((theme) => theme.name
      ? [{
          name: theme.name,
          ...(theme.sourceInfo ? { sourceKind: sourceKind(theme.sourceInfo) } : {}),
        }]
      : []),
    extensions: {
      count: resources.extensions.length,
      sourceKinds: extensionSourceKinds,
    },
    contextFileCount: resources.contextFiles.length,
    diagnostics: {
      warningCount: diagnostics.filter((diagnostic) => diagnostic.type === "warning").length,
      errorCount: diagnostics.filter((diagnostic) => diagnostic.type === "error").length,
      collisions: diagnostics.flatMap((diagnostic) => diagnostic.collision
        ? [{
            resourceType: diagnostic.collision.resourceType,
            name: diagnostic.collision.name,
          }]
        : []),
    },
  });
}

function normalizeRuntime(
  snapshot: PinnedSnapshot,
  binding: ResidentSessionBinding,
  resourceInventory?: RuntimeResourceInventory,
  displayContext?: ResidentDisplayRedactionContext,
): RuntimeSessionSummary {
  const state = snapshot.state;
  const model = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
  return RuntimeSessionSummarySchema.parse({
    runtime: "prime_agent",
    residency: "resident",
    appVersion: binding.runtime.appVersion,
    activeSessionId: state.activeSessionId,
    sessionId: state.sessionId,
    ...(state.sessionName
      ? { sessionName: sanitizeResidentDisplayText(state.sessionName, displayContext) }
      : {}),
    ...(model ? { model } : {}),
    thinkingLevel: state.thinkingLevel,
    serviceTier: state.serviceTier,
    isStreaming: state.isStreaming,
    isCompacting: state.isCompacting,
    isBashRunning: state.isBashRunning,
    retryAttempt: state.retryAttempt,
    steeringMode: state.steeringMode,
    followUpMode: state.followUpMode,
    messageCount: state.messageCount,
    compactionCount: state.compactionCount,
    queuedActionCount: state.sessionActions.queuedCount,
    activeToolNames: [...state.activeToolNames],
    ...(resourceInventory ? { resourceInventory } : {}),
    ...(state.contextUsage?.tokens !== null && state.contextUsage?.tokens !== undefined
      ? {
          context: {
            usedTokens: state.contextUsage.tokens,
            maxTokens: state.contextUsage.contextWindow,
          },
        }
      : {}),
    // Prime may rehydrate a missing recap as an empty string. Both mean that no
    // recap exists; canonicalize them so an otherwise identical attachment
    // does not create a false resident semantic change.
    ...(state.recap ? { recap: sanitizeResidentDisplayText(state.recap, displayContext) } : {}),
  });
}

function normalizeTranscriptMessage(
  message: PinnedAgentMessage,
  sourceIndex: number,
  sessionId: string,
  idOccurrences: Map<string, number>,
  displayContext: ResidentDisplayRedactionContext,
): TranscriptBlock | undefined {
  if (message.role === "custom" && !message.display) return undefined;

  const normalized = normalizeMessageText(message);
  const text = boundedOutputText(
    sanitizeResidentDisplayText(normalized.text, displayContext),
    `messages.${sourceIndex}`,
  );
  const identityParts = [sessionId, message.role, message.timestamp, text] as const;
  const identityKey = JSON.stringify(identityParts);
  const occurrence = idOccurrences.get(identityKey) ?? 0;
  idOccurrences.set(identityKey, occurrence + 1);
  return TranscriptBlockSchema.parse({
    blockId: stableId("resident-block", [...identityParts, occurrence]),
    kind: normalized.kind,
    text,
    createdAt: timestampToIso(message.timestamp),
    sequence: sourceIndex,
  });
}

function normalizeMessageText(
  message: PinnedAgentMessage,
): Pick<TranscriptBlock, "kind" | "text"> {
  switch (message.role) {
    case "user":
      return { kind: "user", text: displayContentToText(message.content) };
    case "assistant":
      return { kind: "assistant", text: assistantContentToText(message) };
    case "toolResult": {
      const result = displayContentToText(message.content) || "(No display output)";
      return {
        kind: "tool",
        text: `${message.toolName}${message.isError ? " failed" : ""}\n${result}`,
      };
    }
    case "bashExecution": {
      const outcome = message.cancelled
        ? "cancelled"
        : message.exitCode === undefined
          ? "finished"
          : `exited ${message.exitCode}`;
      const suffix = message.truncated ? "; output truncated" : "";
      return {
        kind: "tool",
        text: `$ ${message.command}\n${message.output || "(No output)"}\n[${outcome}${suffix}]`,
      };
    }
    case "custom": {
      const content = displayContentToText(message.content);
      return {
        kind: "status",
        text: content ? `${message.customType}\n${content}` : message.customType,
      };
    }
    case "branchSummary":
      return { kind: "status", text: `Branch summary\n${message.summary}` };
    case "compactionSummary":
      return { kind: "status", text: `Conversation compacted\n${message.summary}` };
  }
}

function normalizeStream(
  message: PinnedAssistantMessage,
  sessionId: string,
  displayContext: ResidentDisplayRedactionContext,
): InProgressStream {
  const text = boundedOutputText(
    sanitizeResidentDisplayText(assistantContentToText(message), displayContext),
    "streamingMessage",
  );
  return InProgressStreamSchema.parse({
    blockId: stableId("resident-stream", [
      sessionId,
      message.timestamp,
      message.api,
      message.provider,
      message.model,
    ]),
    text,
    startedAt: timestampToIso(message.timestamp),
  });
}

function assistantContentToText(message: PinnedAssistantMessage): string {
  const parts: string[] = [];
  for (const item of message.content) {
    if (item.type === "text") {
      parts.push(item.text);
    } else if (item.type === "toolCall") {
      parts.push(`Tool call: ${item.name}`);
    }
  }
  if (message.errorMessage) parts.push(`Error: ${message.errorMessage}`);
  return parts.join("\n\n") || "(No display text)";
}

function displayContentToText(
  content: string | Readonly<z.infer<typeof DisplayContentSchema>>,
): string {
  if (typeof content === "string") return content;
  return content
    .map((item) => (item.type === "text" ? item.text : `[Image: ${item.mimeType}]`))
    .join("\n\n");
}

function normalizeChildAgent(
  child: z.infer<typeof ChildAgentSchema>,
  displayContext?: ResidentDisplayRedactionContext,
): ChildAgentSummary {
  const state = child.status === "done" ? "complete" : child.status === "error" ? "failed" : child.status;
  return ChildAgentSummarySchema.parse({
    agentId: child.id,
    ...(child.parentId ? { parentAgentId: child.parentId } : {}),
    ...(child.activeSessionId ? { activeSessionId: child.activeSessionId } : {}),
    ...(child.sessionName
      ? { sessionName: sanitizeResidentDisplayText(child.sessionName, displayContext) }
      : {}),
    ...(child.model ? { model: child.model } : {}),
    title: compactChildAgentTitle(sanitizeResidentDisplayText(child.label, displayContext)),
    state,
    ...(child.durationMs !== undefined ? { durationMs: child.durationMs } : {}),
    ...(child.answerPreview !== undefined
      ? { answerPreview: sanitizeResidentDisplayText(child.answerPreview, displayContext) }
      : {}),
    ...(child.repliedSinceTask !== undefined ? { repliedSinceTask: child.repliedSinceTask } : {}),
    ...(child.toolUseCount !== undefined ? { toolUseCount: child.toolUseCount } : {}),
    ...(child.tokenCount !== undefined ? { tokenCount: child.tokenCount } : {}),
    ...(child.recap !== undefined
      ? { recap: sanitizeResidentDisplayText(child.recap, displayContext) }
      : {}),
    ...(child.activity ? { activity: { ...child.activity } } : {}),
    ...(child.error !== undefined
      ? { error: sanitizeResidentDisplayText(child.error, displayContext) }
      : {}),
  });
}

function compactChildAgentTitle(label: string): string {
  const compact = label.replace(/\s+/g, " ").trim();
  if (compact.length <= 255) return compact;
  return `${compact.slice(0, 254).trimEnd()}…`;
}

function normalizeGoal(
  goal: z.infer<typeof GoalStateSchema>,
  displayContext: ResidentDisplayRedactionContext,
): GoalSummary | undefined {
  if (goal.status === "idle") {
    if (goal.active) {
      throw new ResidentProjectionError(
        "PRIME_PROJECTION_INVALID",
        "Prime Agent returned an internally inconsistent idle goal.",
      );
    }
    return undefined;
  }
  if (goal.status === "active" && !goal.active) {
    throw new ResidentProjectionError(
      "PRIME_PROJECTION_INVALID",
      "Prime Agent returned an internally inconsistent active goal.",
    );
  }
  if (!goal.goalId || !goal.objective) {
    throw new ResidentProjectionError(
      "PRIME_PROJECTION_INVALID",
      "Prime Agent returned a non-idle goal without stable identity and objective.",
    );
  }
  return GoalSummarySchema.parse({
    goalId: goal.goalId,
    objective: sanitizeResidentDisplayText(goal.objective, displayContext),
    state: goal.status,
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    continuationsUsed: goal.continuationsUsed,
    ...(goal.lastReason !== undefined
      ? { lastReason: sanitizeResidentDisplayText(goal.lastReason, displayContext) }
      : {}),
    ...(goal.lastError !== undefined
      ? { lastError: sanitizeResidentDisplayText(goal.lastError, displayContext) }
      : {}),
    ...(goal.updatedAt !== undefined || goal.createdAt !== undefined
      ? { updatedAt: timestampToIso(goal.updatedAt ?? goal.createdAt!) }
      : {}),
  });
}

function createResidentDisplayRedactionContext(
  binding: ResidentSessionBinding,
  children: readonly z.infer<typeof ChildAgentSchema>[],
): ResidentDisplayRedactionContext {
  const exactValues = [
    { value: binding.workspaceDirectory, replacement: "[workspace]" },
    ...(binding.sessionFile
      ? [{ value: binding.sessionFile, replacement: "[session file]" }]
      : []),
    { value: binding.activeSessionId, replacement: "[active session]" },
    { value: binding.sessionId, replacement: "[resident session]" },
  ]
    .filter(({ value }) => value.length > 1)
    .sort((left, right) => right.value.length - left.value.length);
  const childNamesById = new Map<string, string>();
  for (const child of children) {
    childNamesById.set(child.id, child.sessionName ?? child.label);
  }
  return Object.freeze({
    exactValues: Object.freeze(exactValues.map((entry) => Object.freeze(entry))),
    childNamesById,
  });
}

function boundedOutputText(value: string, field: string): string {
  if (value.length > MAX_RESIDENT_PROJECTION_TEXT_CHARS) {
    throw new ResidentProjectionError(
      "PRIME_PROJECTION_LIMIT_EXCEEDED",
      "Prime Agent display text exceeds the host projection limit.",
      { field, characters: value.length },
    );
  }
  return value;
}

function timestampToIso(value: number): string {
  try {
    return new Date(value).toISOString();
  } catch {
    throw new ResidentProjectionError(
      "PRIME_PROJECTION_INVALID",
      "Prime Agent snapshot contains an invalid message timestamp.",
    );
  }
}

function stableId(prefix: string, parts: readonly (string | number)[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 48);
  return `${prefix}-${digest}`;
}

function sameWorkspacePath(left: string, right: string): boolean {
  const normalizedLeft = resolvePath(left);
  const normalizedRight = resolvePath(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function noControlCharacters(value: string): boolean {
  return !/[\0\r\n]/.test(value);
}

function noNullOrLineBreaks(value: string): boolean {
  return !/[\0\r\n]/.test(value);
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "snapshot"}: ${issue.message}`)
    .join("; ")
    .slice(0, 2_048);
}

function assertNormalizedOutputSize(value: ResidentProjectionSnapshot): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_RESIDENT_PROJECTION_INPUT_BYTES) {
    throw new ResidentProjectionError(
      "PRIME_PROJECTION_LIMIT_EXCEEDED",
      "Normalized resident projection exceeds the host-owned snapshot limit.",
      { bytes, maxBytes: MAX_RESIDENT_PROJECTION_INPUT_BYTES },
    );
  }
}

/** Reject values that can behave differently from bounded JSON before Zod reads them. */
function assertBoundedJsonValue(root: unknown): void {
  const stack: Array<{ value: unknown; path: string; depth: number; inArray: boolean }> = [
    { value: root, path: "snapshot", depth: 0, inArray: false },
  ];
  const inspected = new WeakSet<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_GRAPH_NODES) {
      throwProjectionLimit("Snapshot object graph has too many values.", current.path, nodes);
    }
    if (current.depth > MAX_GRAPH_DEPTH) {
      throwProjectionLimit("Snapshot object graph is too deeply nested.", current.path, current.depth);
    }

    const value = current.value;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "string") {
      if (value.length > MAX_GENERIC_STRING_CHARS) {
        throwProjectionLimit("Snapshot contains an unbounded string.", current.path, value.length);
      }
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throwNonSerializable(current.path, "non-finite number");
      continue;
    }
    if (typeof value === "undefined" && !current.inArray) continue;
    if (typeof value !== "object") {
      throwNonSerializable(current.path, typeof value);
    }

    const object = value as object;
    if (inspected.has(object)) continue;
    inspected.add(object);

    if (Array.isArray(object)) {
      if (object.length > MAX_ARRAY_ITEMS) {
        throwProjectionLimit("Snapshot contains an unbounded array.", current.path, object.length);
      }
      const ownKeys = Reflect.ownKeys(object);
      if (
        ownKeys.length !== object.length + 1 ||
        ownKeys[ownKeys.length - 1] !== "length" ||
        ownKeys.slice(0, -1).some((key, index) => key !== String(index))
      ) {
        throwNonSerializable(current.path, "sparse or decorated array");
      }
      for (let index = object.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throwNonSerializable(`${current.path}.${index}`, "accessor or hidden array element");
        }
        stack.push({
          value: descriptor.value,
          path: `${current.path}.${index}`,
          depth: current.depth + 1,
          inArray: true,
        });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throwNonSerializable(current.path, "non-plain object");
    }
    const ownKeys = Reflect.ownKeys(object);
    if (ownKeys.length > MAX_OBJECT_KEYS) {
      throwProjectionLimit("Snapshot object has too many fields.", current.path, ownKeys.length);
    }
    for (const key of ownKeys) {
      if (typeof key !== "string") throwNonSerializable(current.path, "symbol key");
      if (key.length > 256) throwProjectionLimit("Snapshot field name is too long.", current.path, key.length);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throwNonSerializable(`${current.path}.${key}`, "accessor or hidden property");
      }
      stack.push({
        value: descriptor.value,
        path: `${current.path}.${key}`,
        depth: current.depth + 1,
        inArray: false,
      });
    }
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(root);
  } catch {
    throwNonSerializable("snapshot", "cyclic value");
  }
  if (serialized === undefined) throwNonSerializable("snapshot", "undefined root");
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_RESIDENT_PROJECTION_INPUT_BYTES) {
    throw new ResidentProjectionError(
      "PRIME_PROJECTION_LIMIT_EXCEEDED",
      "Prime Agent snapshot exceeds the host input limit.",
      { bytes, maxBytes: MAX_RESIDENT_PROJECTION_INPUT_BYTES },
    );
  }
}

function throwProjectionLimit(message: string, field: string, actual: number): never {
  throw new ResidentProjectionError("PRIME_PROJECTION_LIMIT_EXCEEDED", message, { field, actual });
}

function throwNonSerializable(field: string, valueType: string): never {
  throw new ResidentProjectionError(
    "PRIME_PROJECTION_NON_SERIALIZABLE",
    "Prime Agent snapshot must be a bounded plain JSON value.",
    { field, valueType },
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
