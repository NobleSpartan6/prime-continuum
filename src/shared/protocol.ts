import { z } from "zod";
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  isPinnedCodexAuthorizationUrl,
} from "./codex-oauth";

/**
 * Public host protocol version. This is intentionally distinct from Prime
 * Agent's daemon/RPC protocol; hostd translates between the two at its gateway
 * boundary.
 */
export const PROTOCOL_VERSION = 1 as const;
export const SNAPSHOT_VERSION = 1 as const;
export const SNAPSHOT_TRANSFER_VERSION = 1 as const;
export const SNAPSHOT_TRANSFER_CHUNK_BYTES = 512 * 1024;
// Phase 1 keeps the negotiated wire ceiling inside every currently shipped
// persistence and process-memory boundary. The 50 MiB release gate remains a
// later streaming/spooling milestone rather than an advertised capability.
export const MAX_SNAPSHOT_TRANSFER_BYTES = 8 * 1024 * 1024;
export const MAX_SNAPSHOT_TRANSFER_CHUNKS = Math.ceil(
  MAX_SNAPSHOT_TRANSFER_BYTES / SNAPSHOT_TRANSFER_CHUNK_BYTES,
);

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const capabilityPattern = /^[a-z][a-z0-9_]*_v[1-9][0-9]*$/;
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function hasCanonicalBase64PadBits(value: string): boolean {
  if (value.endsWith("==")) {
    return (base64Alphabet.indexOf(value[value.length - 3] ?? "") & 0b1111) === 0;
  }
  if (value.endsWith("=")) {
    return (base64Alphabet.indexOf(value[value.length - 2] ?? "") & 0b11) === 0;
  }
  return true;
}

export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(idPattern, "Must be a bounded opaque identifier");

export const CapabilitySchema = z
  .string()
  .min(4)
  .max(96)
  .regex(capabilityPattern, "Capabilities must be versioned snake_case names");

export const RUNTIME_INTEGRITY_CAPABILITY = "runtime_integrity_v1" as const;
export const RUNTIME_INTEGRITY_RETRY_CAPABILITY = "runtime_integrity_retry_v1" as const;
export const RUNTIME_MODEL_CATALOG_CAPABILITY = "runtime_model_catalog_v1" as const;
export const RUNTIME_OAUTH_CAPABILITY = "runtime_oauth_v1" as const;
export const PRIME_AGENT_COMMAND_CAPABILITY = "prime_agent_commands_v2" as const;
export const RESIDENT_LIFECYCLE_CAPABILITY = "resident_lifecycle_v1" as const;
export const THREAD_HANDOFF_CAPABILITY = "thread_handoff_v1" as const;

/** Tiny invalidation only; clients must fetch the bounded authoritative snapshot. */
export const ThreadChangedEventPayloadSchema = z
  .object({
    threadId: IdSchema,
    executionGenerationId: IdSchema,
  })
  .strict();
export type ThreadChangedEventPayload = z.infer<typeof ThreadChangedEventPayloadSchema>;

export const IsoDateTimeSchema = z
  .string()
  .min(20)
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), "Must be an ISO date-time");

/** Canonical relay origin only: WSS, no credentials, path, query, or fragment. */
export const RelayOriginSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "wss:" &&
        url.username === "" &&
        url.password === "" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === "" &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }, "Relay origin must be a canonical wss:// origin without credentials, path, query, or fragment");

export const WorkspaceRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes("\0"), "Relative paths cannot contain NUL bytes")
  .refine((value) => !/^(?:[A-Za-z]:|[\\/])/.test(value), "Path must be workspace-relative")
  .refine(
    (value) => !value.split(/[\\/]+/).some((segment) => segment === ".."),
    "Relative path cannot escape its workspace",
  );

export const StructuredErrorSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1).max(2_048),
  retryable: z.boolean().default(false),
  diagnosticId: IdSchema.optional(),
  details: z
    .record(z.string().min(1).max(64), z.union([z.string().max(2_048), z.number(), z.boolean(), z.null()]))
    .refine((value) => Object.keys(value).length <= 32, "Too many error detail fields")
    .optional(),
});
export type StructuredError = z.infer<typeof StructuredErrorSchema>;

export const ConnectionPathSummarySchema = z.object({
  kind: z.enum(["local_socket", "ssh", "relay", "proxy"]),
  priority: z.number().int().min(0).max(1_000),
  state: z.enum(["available", "unavailable", "degraded"]),
  latencyMs: z.number().finite().nonnegative().max(3_600_000).optional(),
});
export type ConnectionPathSummary = z.infer<typeof ConnectionPathSummarySchema>;

export const PlatformSummarySchema = z.object({
  os: z.enum(["windows", "macos", "linux", "unknown"]),
  architecture: z.string().min(1).max(64),
  release: z.string().max(128).optional(),
  hostname: z.string().min(1).max(255).optional(),
});
export type PlatformSummary = z.infer<typeof PlatformSummarySchema>;

export const ResourceSummarySchema = z.object({
  availableDiskBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  totalMemoryBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  availableMemoryBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type ResourceSummary = z.infer<typeof ResourceSummarySchema>;

export const AttentionCountsSchema = z.object({
  total: z.number().int().nonnegative().max(1_000_000),
  unread: z.number().int().nonnegative().max(1_000_000),
  questions: z.number().int().nonnegative().max(1_000_000),
  approvals: z.number().int().nonnegative().max(1_000_000),
});
export type AttentionCounts = z.infer<typeof AttentionCountsSchema>;

export const HostSummarySchema = z.object({
  hostId: IdSchema,
  displayName: z.string().min(1).max(128),
  kind: z.enum(["local", "ssh", "paired", "managed"]),
  connectionPaths: z.array(ConnectionPathSummarySchema).max(16),
  reachability: z.enum(["online", "offline", "connecting", "degraded"]),
  compatibility: z.enum(["compatible", "update_available", "upgrade_required"]),
  platform: PlatformSummarySchema,
  resources: ResourceSummarySchema.optional(),
  attentionCounts: AttentionCountsSchema,
  lastSeenAt: IsoDateTimeSchema.optional(),
});
export type HostSummary = z.infer<typeof HostSummarySchema>;

export const RepositoryIdentitySchema = z.object({
  version: z.literal(1),
  canonicalRemotes: z.array(z.string().min(1).max(2_048)).max(32),
  rootTreeHash: z.string().min(4).max(128).optional(),
  defaultBranch: z.string().min(1).max(255).optional(),
  subdirectory: WorkspaceRelativePathSchema.optional(),
});
export type RepositoryIdentity = z.infer<typeof RepositoryIdentitySchema>;

export const SavedProjectSchema = z.object({
  projectId: IdSchema,
  hostId: IdSchema,
  workspaceId: IdSchema,
  displayName: z.string().min(1).max(255),
  repositoryIdentity: RepositoryIdentitySchema.optional(),
  relativeSubdirectory: WorkspaceRelativePathSchema.optional(),
  lastOpenedAt: IsoDateTimeSchema,
});
export type SavedProject = z.infer<typeof SavedProjectSchema>;

export const RunLocationSchema = z.object({
  hostId: IdSchema,
  projectId: IdSchema,
  workspaceId: IdSchema,
  executionGenerationId: IdSchema,
});
export type RunLocation = z.infer<typeof RunLocationSchema>;

export const SessionCursorSchema = z.object({
  threadId: IdSchema,
  executionGenerationId: IdSchema,
  generation: IdSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type SessionCursor = z.infer<typeof SessionCursorSchema>;

export const TaskStateSchema = z.enum([
  "idle",
  "running",
  "waiting",
  "needs_approval",
  "complete",
  "failed",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const ConnectionStateSchema = z.enum([
  "offline",
  "connecting",
  "online",
  "reconnecting",
  "degraded",
  "authentication_required",
  "upgrade_required",
]);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const ComposerDeliveryStateSchema = z.enum([
  "draft",
  "sending",
  "sent",
  "queued_on_host",
  "waiting_for_connection",
  "uncertain",
  "rejected",
]);
export type ComposerDeliveryState = z.infer<typeof ComposerDeliveryStateSchema>;

export const ComposerStateSchema = z.object({
  availability: z.enum(["ready", "offline_read_only", "task_locked", "handoff_in_progress"]),
  delivery: ComposerDeliveryStateSchema,
  pendingCommandId: IdSchema.optional(),
  message: z.string().max(512).optional(),
});
export type ComposerState = z.infer<typeof ComposerStateSchema>;

export const ConnectionStateSnapshotSchema = z.object({
  state: ConnectionStateSchema,
  changedAt: IsoDateTimeSchema,
  activePath: ConnectionPathSummarySchema.optional(),
  error: StructuredErrorSchema.optional(),
});
export type ConnectionStateSnapshot = z.infer<typeof ConnectionStateSnapshotSchema>;

export const ThreadSummarySchema = z
  .object({
    threadId: IdSchema,
    title: z.string().min(1).max(255),
    projectIdentity: z.string().min(1).max(2_048),
    currentLocation: RunLocationSchema,
    status: TaskStateSchema,
    recap: z.string().max(4_096).optional(),
    unread: z.boolean(),
    updatedAt: IsoDateTimeSchema,
    lastKnownCursor: SessionCursorSchema.optional(),
  })
  .superRefine((thread, context) => {
    const cursor = thread.lastKnownCursor;
    if (!cursor) return;
    if (cursor.threadId !== thread.threadId) {
      context.addIssue({
        code: "custom",
        path: ["lastKnownCursor", "threadId"],
        message: "The cursor must belong to this thread",
      });
    }
    if (cursor.executionGenerationId !== thread.currentLocation.executionGenerationId) {
      context.addIssue({
        code: "custom",
        path: ["lastKnownCursor", "executionGenerationId"],
        message: "The cursor must belong to the current execution generation",
      });
    }
  });
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const TranscriptBlockSchema = z.object({
  blockId: IdSchema,
  kind: z.enum(["system", "user", "assistant", "tool", "status"]),
  text: z.string().max(262_144),
  createdAt: IsoDateTimeSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type TranscriptBlock = z.infer<typeof TranscriptBlockSchema>;

export const TranscriptBlockIndexEntrySchema = z.object({
  blockId: IdSchema,
  kind: TranscriptBlockSchema.shape.kind,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  byteLength: z.number().int().nonnegative().max(16 * 1024 * 1024),
  materialized: z.boolean(),
});
export type TranscriptBlockIndexEntry = z.infer<typeof TranscriptBlockIndexEntrySchema>;

export const QueueStateSchema = z.object({
  pendingCommandIds: z.array(IdSchema).max(1_000),
  paused: z.boolean(),
});
export type QueueState = z.infer<typeof QueueStateSchema>;

export const ApprovalSummarySchema = z.object({
  approvalId: IdSchema,
  title: z.string().min(1).max(255),
  state: z.enum(["open", "claimed", "approved", "rejected", "expired"]),
  claimedByDeviceId: IdSchema.optional(),
  leaseExpiresAt: IsoDateTimeSchema.optional(),
});
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;

export const ChildAgentSummarySchema = z.object({
  agentId: IdSchema,
  parentAgentId: IdSchema.optional(),
  activeSessionId: IdSchema.optional(),
  sessionName: z.string().min(1).max(255).optional(),
  model: z.string().min(1).max(255).optional(),
  title: z.string().min(1).max(255),
  state: z.enum(["pending", "queued", "running", "waiting", "complete", "failed", "cancelled"]),
  durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  answerPreview: z.string().max(4_096).optional(),
  repliedSinceTask: z.boolean().optional(),
  toolUseCount: z.number().int().nonnegative().max(1_000_000).optional(),
  tokenCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  recap: z.string().max(4_096).optional(),
  activity: z
    .object({
      kind: z.enum(["waiting", "writing", "executing"]),
      toolName: z.string().min(1).max(255).optional(),
    })
    .optional(),
  error: z.string().max(2_048).optional(),
});
export type ChildAgentSummary = z.infer<typeof ChildAgentSummarySchema>;

export const GoalSummarySchema = z.object({
  goalId: IdSchema,
  objective: z.string().min(1).max(4_096),
  state: z.enum(["active", "paused", "budget_limited", "complete", "error"]),
  tokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  tokensUsed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  timeUsedSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  continuationsUsed: z.number().int().nonnegative().max(1_000_000).optional(),
  lastReason: z.string().max(2_048).optional(),
  lastError: z.string().max(2_048).optional(),
  updatedAt: IsoDateTimeSchema.optional(),
});
export type GoalSummary = z.infer<typeof GoalSummarySchema>;

export const ScheduleSummarySchema = z.object({
  scheduleId: IdSchema,
  label: z.string().min(1).max(255),
  state: z.enum(["active", "paused", "completed", "cancelled"]),
  kind: z.enum(["once", "cron", "interval"]).optional(),
  expression: z.string().min(1).max(255).optional(),
  prompt: z.string().max(4_096).optional(),
  source: z.enum(["cron", "heartbeat", "rlm_heartbeat"]).optional(),
  deliveryMode: z.enum(["steer", "follow_up"]).optional(),
  nextRunAt: IsoDateTimeSchema.optional(),
  lastRunAt: IsoDateTimeSchema.optional(),
  runCount: z.number().int().nonnegative().max(1_000_000).optional(),
  lastError: z.string().max(2_048).optional(),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummarySchema>;

/** Stable host-owned subset of Prime Agent state. Upstream local DTOs stop here. */
export const RuntimeSessionSummarySchema = z.object({
  runtime: z.literal("prime_agent"),
  residency: z.enum(["resident", "client_owned", "unknown"]),
  appVersion: z.string().min(1).max(64).optional(),
  activeSessionId: IdSchema.optional(),
  sessionId: IdSchema.optional(),
  sessionName: z.string().min(1).max(255).optional(),
  model: z.string().min(1).max(641).optional(),
  thinkingLevel: z.string().min(1).max(64).optional(),
  serviceTier: z.string().min(1).max(64).optional(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  isBashRunning: z.boolean(),
  retryAttempt: z.number().int().nonnegative().max(1_000_000),
  steeringMode: z.enum(["all", "one-at-a-time"]),
  followUpMode: z.enum(["all", "one-at-a-time"]),
  messageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  compactionCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  queuedActionCount: z.number().int().nonnegative().max(1_000_000),
  activeToolNames: z.array(z.string().min(1).max(255)).max(128),
  context: z
    .object({
      usedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .optional(),
  recap: z.string().max(4_096).optional(),
});
export type RuntimeSessionSummary = z.infer<typeof RuntimeSessionSummarySchema>;

/** Host-owned terminal resident lifecycle fact; never inferred from runtime absence. */
export const ResidentLifecycleDispositionSchema = z
  .object({
    version: z.literal(1),
    state: z.literal("ended"),
    operationId: IdSchema,
    bindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    endedAt: IsoDateTimeSchema,
    sourceCursor: SessionCursorSchema,
    reason: z.literal("user_end"),
  })
  .strict();
export type ResidentLifecycleDisposition = z.infer<typeof ResidentLifecycleDispositionSchema>;

export const GitSummarySchema = z.object({
  branch: z.string().max(255).optional(),
  headCommit: z.string().max(128).optional(),
  upstream: z.string().max(512).optional(),
  stagedFiles: z.number().int().nonnegative().max(1_000_000),
  unstagedFiles: z.number().int().nonnegative().max(1_000_000),
  untrackedFiles: z.number().int().nonnegative().max(1_000_000),
});
export type GitSummary = z.infer<typeof GitSummarySchema>;

export const EvidenceSummarySchema = z.object({
  testsPassed: z.number().int().nonnegative().max(1_000_000),
  testsFailed: z.number().int().nonnegative().max(1_000_000),
  artifactCount: z.number().int().nonnegative().max(1_000_000),
  lastUpdatedAt: IsoDateTimeSchema.optional(),
});
export type EvidenceSummary = z.infer<typeof EvidenceSummarySchema>;

export const AttentionEventSchema = z.object({
  attentionId: IdSchema,
  kind: z.enum(["question", "approval", "complete", "failed", "schedule", "host_offline", "handoff"]),
  title: z.string().min(1).max(255),
  createdAt: IsoDateTimeSchema,
  read: z.boolean(),
  blockId: IdSchema.optional(),
});
export type AttentionEvent = z.infer<typeof AttentionEventSchema>;

export const InProgressStreamSchema = z.object({
  blockId: IdSchema,
  text: z.string().max(262_144),
  startedAt: IsoDateTimeSchema,
});
export type InProgressStream = z.infer<typeof InProgressStreamSchema>;

export const ThreadProjectionSnapshotSchema = z
  .object({
    snapshotVersion: z.literal(SNAPSHOT_VERSION),
    generatedAt: IsoDateTimeSchema,
    thread: ThreadSummarySchema,
    transcriptBlockIndex: z.array(TranscriptBlockIndexEntrySchema).max(20_000),
    materializedRecentBlocks: z.array(TranscriptBlockSchema).max(2_000),
    inProgressStream: InProgressStreamSchema.optional(),
    queueState: QueueStateSchema,
    approvals: z.array(ApprovalSummarySchema).max(1_000),
    childAgents: z.array(ChildAgentSummarySchema).max(1_000),
    goals: z.array(GoalSummarySchema).max(1_000),
    schedules: z.array(ScheduleSummarySchema).max(1_000),
    runtime: RuntimeSessionSummarySchema.optional(),
    residentLifecycle: ResidentLifecycleDispositionSchema.optional(),
    git: GitSummarySchema,
    evidence: EvidenceSummarySchema,
    pendingAttention: z.array(AttentionEventSchema).max(1_000),
    latestCursor: SessionCursorSchema,
  })
  .superRefine((snapshot, context) => {
    if (snapshot.latestCursor.threadId !== snapshot.thread.threadId) {
      context.addIssue({
        code: "custom",
        path: ["latestCursor", "threadId"],
        message: "The latest cursor must belong to the projected thread",
      });
    }
    if (
      snapshot.latestCursor.executionGenerationId !==
      snapshot.thread.currentLocation.executionGenerationId
    ) {
      context.addIssue({
        code: "custom",
        path: ["latestCursor", "executionGenerationId"],
        message: "The latest cursor must belong to the current execution generation",
      });
    }
    const residentLifecycle = snapshot.residentLifecycle;
    if (!residentLifecycle) return;
    if (
      snapshot.thread.status !== "idle" &&
      snapshot.thread.status !== "complete" &&
      snapshot.thread.status !== "failed"
    ) {
      context.addIssue({
        code: "custom",
        path: ["thread", "status"],
        message: "An ended resident lifecycle must have a non-actionable thread status",
      });
    }
    if (snapshot.thread.recap !== "Resident session ended.") {
      context.addIssue({
        code: "custom",
        path: ["thread", "recap"],
        message: "An ended resident lifecycle must carry the exact terminal resident recap",
      });
    }
    const liveStateRemains =
      snapshot.runtime !== undefined ||
      snapshot.inProgressStream !== undefined ||
      snapshot.queueState.pendingCommandIds.length !== 0 ||
      snapshot.queueState.paused ||
      snapshot.approvals.length !== 0 ||
      snapshot.childAgents.length !== 0 ||
      snapshot.goals.length !== 0 ||
      snapshot.schedules.length !== 0 ||
      snapshot.pendingAttention.length !== 0;
    if (liveStateRemains) {
      context.addIssue({
        code: "custom",
        path: ["residentLifecycle"],
        message: "An ended resident lifecycle cannot retain live resident state",
      });
    }
    const sourceCursor = residentLifecycle.sourceCursor;
    if (
      sourceCursor.threadId !== snapshot.latestCursor.threadId ||
      sourceCursor.executionGenerationId !== snapshot.latestCursor.executionGenerationId ||
      sourceCursor.generation !== snapshot.latestCursor.generation ||
      sourceCursor.sequence !== snapshot.latestCursor.sequence
    ) {
      context.addIssue({
        code: "custom",
        path: ["residentLifecycle", "sourceCursor"],
        message: "The resident end source cursor must equal the preserved latest cursor",
      });
    }
    if (Date.parse(residentLifecycle.endedAt) > Date.parse(snapshot.generatedAt)) {
      context.addIssue({
        code: "custom",
        path: ["residentLifecycle", "endedAt"],
        message: "The resident end time cannot be later than snapshot generation",
      });
    }
  });
export type ThreadProjectionSnapshot = z.infer<typeof ThreadProjectionSnapshotSchema>;

const ProjectionDeltaBase = {
  cursor: SessionCursorSchema,
};

/**
 * Bounded projection updates keep token/tool activity from rebuilding and
 * republishing unrelated workbench state. A sequence gap requires a snapshot.
 */
export const ThreadProjectionDeltaSchema = z.discriminatedUnion("kind", [
  z.object({
    ...ProjectionDeltaBase,
    kind: z.literal("transcript.append"),
    block: TranscriptBlockSchema,
  }),
  z.object({
    ...ProjectionDeltaBase,
    kind: z.literal("transcript.stream"),
    stream: InProgressStreamSchema.nullable(),
  }),
  z.object({
    ...ProjectionDeltaBase,
    kind: z.literal("runtime.replace"),
    runtime: RuntimeSessionSummarySchema,
    queueState: QueueStateSchema,
    childAgents: z.array(ChildAgentSummarySchema).max(1_000),
    goals: z.array(GoalSummarySchema).max(1_000),
    schedules: z.array(ScheduleSummarySchema).max(1_000),
    threadStatus: TaskStateSchema,
    recap: z.string().max(4_096).nullable().optional(),
  }),
  z.object({
    ...ProjectionDeltaBase,
    kind: z.literal("attention.append"),
    attention: AttentionEventSchema,
  }),
]);
export type ThreadProjectionDelta = z.infer<typeof ThreadProjectionDeltaSchema>;

export const CatalogProjectionSnapshotSchema = z
  .object({
    snapshotVersion: z.literal(SNAPSHOT_VERSION),
    generatedAt: IsoDateTimeSchema,
    host: HostSummarySchema,
    projects: z.array(SavedProjectSchema).max(10_000),
    threads: z.array(ThreadSummarySchema).max(10_000),
  })
  .superRefine((catalog, context) => {
    catalog.projects.forEach((project, index) => {
      if (project.hostId !== catalog.host.hostId) {
        context.addIssue({
          code: "custom",
          path: ["projects", index, "hostId"],
          message: "Every saved project must belong to the catalog host",
        });
      }
    });
    catalog.threads.forEach((thread, index) => {
      if (thread.currentLocation.hostId !== catalog.host.hostId) {
        context.addIssue({
          code: "custom",
          path: ["threads", index, "currentLocation", "hostId"],
          message: "Every thread must belong to the catalog host",
        });
      }
    });
  });
export type CatalogProjectionSnapshot = z.infer<typeof CatalogProjectionSnapshotSchema>;

const RuntimeAuthSourceSchema = z.enum([
  "stored",
  "runtime",
  "environment",
  "prime_cli",
  "fallback",
  "models_json_key",
  "models_json_command",
  "stale",
]);

/**
 * Secret-free provider state read from the verified Prime Agent runtime. The
 * host never serializes credentials, token material, model base URLs, headers,
 * or custom provider commands across this boundary.
 */
export const RuntimeModelProviderSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(255),
    oauthSupported: z.boolean(),
    oauthUsesCallbackServer: z.boolean().optional(),
    configured: z.boolean(),
    authSource: RuntimeAuthSourceSchema.optional(),
    modelCount: z.number().int().nonnegative().max(10_000),
    availableModelCount: z.number().int().nonnegative().max(10_000),
  })
  .strict()
  .refine(
    (provider) => provider.availableModelCount <= provider.modelCount,
    "Available model count cannot exceed the provider model count",
  );
export type RuntimeModelProvider = z.infer<typeof RuntimeModelProviderSchema>;

export const RuntimeModelOptionSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    modelId: z.string().min(1).max(512),
    name: z.string().min(1).max(255),
    api: z.string().min(1).max(128),
    reasoning: z.boolean(),
    input: z.array(z.enum(["text", "image"])).min(1).max(2),
    contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    available: z.boolean(),
    usingOAuth: z.boolean(),
  })
  .strict();
export type RuntimeModelOption = z.infer<typeof RuntimeModelOptionSchema>;

export const RuntimeModelCatalogSnapshotSchema = z
  .object({
    runtime: z.literal("prime_agent"),
    releaseVersion: z.string().min(1).max(64),
    observedAt: IsoDateTimeSchema,
    providers: z.array(RuntimeModelProviderSchema).max(128),
    models: z.array(RuntimeModelOptionSchema).max(5_000),
  })
  .strict()
  .superRefine((catalog, context) => {
    const providerIds = new Set<string>();
    catalog.providers.forEach((provider, index) => {
      if (providerIds.has(provider.providerId)) {
        context.addIssue({
          code: "custom",
          path: ["providers", index, "providerId"],
          message: "Provider identifiers must be unique",
        });
      }
      providerIds.add(provider.providerId);
    });
    const modelKeys = new Set<string>();
    catalog.models.forEach((model, index) => {
      if (!providerIds.has(model.providerId)) {
        context.addIssue({
          code: "custom",
          path: ["models", index, "providerId"],
          message: "Every model must belong to a reported provider",
        });
      }
      const key = `${model.providerId}\u0000${model.modelId}`;
      if (modelKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["models", index, "modelId"],
          message: "Provider model identifiers must be unique",
        });
      }
      modelKeys.add(key);
    });
  });
export type RuntimeModelCatalogSnapshot = z.infer<typeof RuntimeModelCatalogSnapshotSchema>;

const RuntimeOAuthAuthorizationUrlSchema = z
  .string()
  .url()
  .max(8_192)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "OAuth authorization URL must use HTTPS without embedded credentials");

export const RuntimeOAuthChallengeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: IdSchema,
      kind: z.literal("text"),
      message: z.string().min(1).max(2_048).regex(/^[^\0\r\n]+$/),
      placeholder: z.string().max(255).regex(/^[^\0\r\n]*$/).optional(),
      allowEmpty: z.boolean(),
    })
    .strict(),
  z
    .object({
      id: IdSchema,
      kind: z.literal("manual_redirect"),
      message: z.string().min(1).max(2_048).regex(/^[^\0\r\n]+$/),
      allowEmpty: z.literal(false),
    })
    .strict(),
  z
    .object({
      id: IdSchema,
      kind: z.literal("select"),
      message: z.string().min(1).max(2_048).regex(/^[^\0\r\n]+$/),
      options: z
        .array(
          z
            .object({
              id: IdSchema,
              label: z.string().min(1).max(255).regex(/^[^\0\r\n]+$/),
            })
            .strict(),
        )
        .min(1)
        .max(64),
    })
    .strict(),
]);
export type RuntimeOAuthChallenge = z.infer<typeof RuntimeOAuthChallengeSchema>;

export const RuntimeOAuthSessionSnapshotSchema = z
  .object({
    sessionId: IdSchema,
    providerId: IdSchema,
    phase: z.enum(["starting", "awaiting_user", "committing", "completed", "cancelled", "failed"]),
    expiresAt: IsoDateTimeSchema,
    authorization: z
      .object({
        url: RuntimeOAuthAuthorizationUrlSchema,
        instructions: z.string().min(1).max(2_048).regex(/^[^\0\r\n]+$/).optional(),
      })
      .strict()
      .optional(),
    challenge: RuntimeOAuthChallengeSchema.optional(),
    progress: z.string().min(1).max(1_024).regex(/^[^\0\r\n]+$/).optional(),
    configured: z.literal(true).optional(),
    error: z
      .object({
        code: z.enum([
          "OAUTH_SESSION_EXPIRED",
          "OAUTH_PROVIDER_CONTRACT_INVALID",
          "OAUTH_PROVIDER_FAILED",
          "OAUTH_PERSISTENCE_UNCONFIRMED",
        ]),
        message: z.string().min(1).max(2_048).regex(/^[^\0\r\n]+$/),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID &&
      snapshot.authorization &&
      !isPinnedCodexAuthorizationUrl(snapshot.authorization.url)
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorization", "url"],
        message: "Codex authorization URL does not match the pinned Prime Agent provider contract",
      });
    }
  });
export type RuntimeOAuthSessionSnapshot = z.infer<typeof RuntimeOAuthSessionSnapshotSchema>;

export const SnapshotTransferBeginSchema = z
  .object({
    kind: z.literal("snapshot.begin"),
    transferId: IdSchema,
    snapshotKind: z.enum(["catalog", "thread"]),
    chunkCount: z.number().int().positive().max(MAX_SNAPSHOT_TRANSFER_CHUNKS),
    totalBytes: z.number().int().positive().max(MAX_SNAPSHOT_TRANSFER_BYTES),
    sha256: z.string().length(64).regex(/^[a-f0-9]+$/),
  })
  .strict();
export const SnapshotTransferChunkSchema = z
  .object({
    kind: z.literal("snapshot.chunk"),
    transferId: IdSchema,
    index: z.number().int().nonnegative().max(MAX_SNAPSHOT_TRANSFER_CHUNKS - 1),
    dataBase64: z
      .string()
      .min(4)
      .max(Math.ceil(SNAPSHOT_TRANSFER_CHUNK_BYTES / 3) * 4)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        "Chunk data must be canonical padded base64",
      )
      .refine(hasCanonicalBase64PadBits, "Chunk data must use canonical base64 pad bits")
      .refine((value) => {
        const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
        return (value.length / 4) * 3 - padding <= SNAPSHOT_TRANSFER_CHUNK_BYTES;
      }, "Chunk data exceeds the decoded byte limit"),
  })
  .strict();
export const SnapshotTransferEndSchema = z
  .object({
    kind: z.literal("snapshot.end"),
    transferId: IdSchema,
    sha256: z.string().length(64).regex(/^[a-f0-9]+$/),
  })
  .strict();
export const SnapshotTransferFrameSchema = z.discriminatedUnion("kind", [
  SnapshotTransferBeginSchema,
  SnapshotTransferChunkSchema,
  SnapshotTransferEndSchema,
]);
export type SnapshotTransferFrame = z.infer<typeof SnapshotTransferFrameSchema>;

export const SnapshotTransferPreferenceSchema = z
  .object({
    version: z.literal(SNAPSHOT_TRANSFER_VERSION),
  })
  .strict();
export type SnapshotTransferPreference = z.infer<typeof SnapshotTransferPreferenceSchema>;

/**
 * Wire-only response envelope for a snapshot too large for one JSON frame.
 * `requestId` and `method` keep concurrent request streams unambiguous; the
 * transfer itself is ordered, bounded, and corruption-checked by its SHA-256.
 * Peer authentication belongs to the enclosing local/SSH/future E2EE path.
 */
export const HostIpcSnapshotTransferEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: IdSchema,
    method: z.enum(["catalog.snapshot", "thread.snapshot"]),
    transfer: SnapshotTransferFrameSchema,
  })
  .strict();
export type HostIpcSnapshotTransferEnvelope = z.infer<typeof HostIpcSnapshotTransferEnvelopeSchema>;

export const CommandIdentitySchema = z.object({
  deviceId: IdSchema,
  commandId: IdSchema,
});
export type CommandIdentity = z.infer<typeof CommandIdentitySchema>;

export const RemoteDeviceScopeSchema = z.enum([
  "projection.read",
  "thread.follow_up",
  "thread.steer",
  "thread.abort",
  "thread.start",
  "model.select",
  "approval.resolve",
  "run_location.change",
  "host.admin",
]);
export type RemoteDeviceScope = z.infer<typeof RemoteDeviceScopeSchema>;

export const RemoteDeviceScopesSchema = z
  .array(RemoteDeviceScopeSchema)
  .min(1)
  .max(9)
  .refine((scopes) => new Set(scopes).size === scopes.length, "Device scopes must be unique");

/** Public identity metadata only. The secretRef and private key stay inside hostd. */
export const HostIdentityDescriptorSchema = z.object({
  version: z.literal(1),
  hostId: IdSchema,
  identityEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  algorithm: z.literal("Noise_25519"),
  publicKeyFingerprint: z.string().regex(/^pa1-[A-Za-z0-9_-]{43}$/),
  createdAt: IsoDateTimeSchema,
  rotatedAt: IsoDateTimeSchema.optional(),
});
export type HostIdentityDescriptor = z.infer<typeof HostIdentityDescriptorSchema>;

/** Public pairing metadata only. Secrets and key material must never enter projection state. */
export const PairingTicketDescriptorSchema = z
  .object({
    version: z.literal(1),
    ticketId: IdSchema,
    hostId: IdSchema,
    relayOrigin: RelayOriginSchema,
    requestedScopes: RemoteDeviceScopesSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    status: z.enum(["pending", "redeemed", "expired", "cancelled"]),
  })
  .superRefine((ticket, context) => {
    const lifetimeMs = Date.parse(ticket.expiresAt) - Date.parse(ticket.createdAt);
    if (lifetimeMs < 60_000 || lifetimeMs > 300_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Pairing tickets must remain valid for 60 to 300 seconds",
      });
    }
  });
export type PairingTicketDescriptor = z.infer<typeof PairingTicketDescriptorSchema>;

export const PairedDeviceSchema = z.object({
  version: z.literal(1),
  deviceId: IdSchema,
  displayName: z.string().min(1).max(128),
  kind: z.enum(["mobile", "desktop"]),
  keyAlgorithm: z.literal("Noise_25519"),
  publicKeyFingerprint: z.string().regex(/^pa1-[A-Za-z0-9_-]{43}$/),
  scopes: RemoteDeviceScopesSchema,
  grantVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hostIdentityEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pairedAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema.optional(),
  revokedAt: IsoDateTimeSchema.optional(),
});
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;

export const MobilePairingPolicySchema = z.object({
  version: z.literal(1),
  ticketLifetimeSeconds: z.number().int().min(60).max(300),
  singleUse: z.literal(true),
  matchingCodeRequired: z.literal(true),
  relayRequired: z.literal(true),
  applicationE2eeRequired: z.literal(true),
  individualRevocationRequired: z.literal(true),
});
export type MobilePairingPolicy = z.infer<typeof MobilePairingPolicySchema>;

const TextCommandFields = {
  text: z.string().min(1).max(65_536),
};

export const CommandPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), ...TextCommandFields }).strict(),
  z.object({ kind: z.literal("steer"), ...TextCommandFields }).strict(),
  z.object({ kind: z.literal("follow_up"), ...TextCommandFields }).strict(),
  z.object({ kind: z.literal("abort"), reason: z.string().max(1_024).optional() }).strict(),
  z
    .object({
      kind: z.literal("model.select"),
      providerId: z.string().min(1).max(128).regex(/^[^\0\r\n]+$/),
      modelId: z.string().min(1).max(512).regex(/^[^\0\r\n]+$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval.resolve"),
      approvalId: IdSchema,
      decision: z.enum(["approve", "reject"]),
      comment: z.string().max(4_096).optional(),
    })
    .strict(),
]);
export type CommandPayload = z.infer<typeof CommandPayloadSchema>;

export const CommandEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    deviceId: IdSchema,
    commandId: IdSchema,
    expectedHostId: IdSchema,
    threadId: IdSchema,
    issuedAt: IsoDateTimeSchema,
    /**
     * Every v1 command mutates an existing thread execution. The composer must
     * therefore name the exact generation it observed; the host never infers or
     * substitutes the currently-authoritative generation.
     */
    expectedExecutionGenerationId: IdSchema,
    command: CommandPayloadSchema,
  })
  .strict();
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

export const CommandReceiptStatusSchema = z.enum([
  "received",
  "admitted",
  "running",
  "completed",
  "rejected",
  "cancelled",
  "failed",
  "uncertain",
]);
export type CommandReceiptStatus = z.infer<typeof CommandReceiptStatusSchema>;

export const CommandReceiptSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  receiptId: IdSchema,
  deviceId: IdSchema,
  commandId: IdSchema,
  threadId: IdSchema,
  status: CommandReceiptStatusSchema,
  receivedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  executionGenerationId: IdSchema,
  queuePosition: z.number().int().nonnegative().max(1_000_000).optional(),
  message: z.string().max(1_024).optional(),
  error: StructuredErrorSchema.optional(),
});
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

/** Public, bounded post-commit signal for one proof-completed resident prompt. */
export const ResidentPromptIdleObservedSignalSchema = z
  .object({
    eventVersion: z.literal(1),
    attemptId: IdSchema,
    receipt: CommandReceiptSchema,
  })
  .strict()
  .superRefine((signal, context) => {
    if (signal.receipt.status !== "completed") {
      context.addIssue({
        code: "custom",
        path: ["receipt", "status"],
        message: "A resident prompt idle-observed signal requires its exact completed receipt",
      });
    }
  });
export type ResidentPromptIdleObservedSignal = z.infer<typeof ResidentPromptIdleObservedSignalSchema>;

/** Public, bounded post-commit signal for one proof-completed resident stop. */
export const ResidentAbortIdleObservedSignalSchema = z
  .object({
    eventVersion: z.literal(1),
    attemptId: IdSchema,
    receipt: CommandReceiptSchema,
  })
  .strict()
  .superRefine((signal, context) => {
    if (signal.receipt.status !== "completed") {
      context.addIssue({
        code: "custom",
        path: ["receipt", "status"],
        message: "A resident abort idle-observed signal requires its exact completed receipt",
      });
    }
  });
export type ResidentAbortIdleObservedSignal = z.infer<typeof ResidentAbortIdleObservedSignalSchema>;

export const BranchPlanSchema = z.object({
  sourceBranch: z.string().max(255).optional(),
  destinationBranch: z.string().min(1).max(255),
  createWorktree: z.boolean(),
  baseCommit: z.string().max(128).optional(),
});
export type BranchPlan = z.infer<typeof BranchPlanSchema>;

export const HandoffWarningSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1).max(2_048),
  blocking: z.boolean(),
});
export type HandoffWarning = z.infer<typeof HandoffWarningSchema>;

export const HandoffPlanRequestSchema = z.object({
  threadId: IdSchema,
  sourceGenerationId: IdSchema,
  destinationHostId: IdSchema,
  destinationProjectId: IdSchema,
  behaviorIfRunning: z.enum(["interrupt", "wait_for_idle"]),
});
export type HandoffPlanRequest = z.infer<typeof HandoffPlanRequestSchema>;

export const HandoffPlanSchema = z.object({
  handoffId: IdSchema,
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  threadId: IdSchema,
  source: RunLocationSchema,
  destination: RunLocationSchema,
  repositoryMatch: z.enum(["exact", "user_confirmed", "none"]),
  branchPlan: BranchPlanSchema,
  transferBytesEstimate: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  includesUntrackedFiles: z.boolean(),
  runtimeStateLosses: z.array(z.string().min(1).max(512)).max(64),
  warnings: z.array(HandoffWarningSchema).max(64),
  executable: z.boolean(),
  behaviorIfRunning: z.enum(["interrupt", "wait_for_idle"]),
});
export type HandoffPlan = z.infer<typeof HandoffPlanSchema>;

export const HandoffReceiptSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  handoffId: IdSchema,
  command: CommandIdentitySchema,
  threadId: IdSchema,
  source: RunLocationSchema,
  destination: RunLocationSchema,
  checkpointId: IdSchema.optional(),
  status: z.enum(["complete", "failed"]),
  completedAt: IsoDateTimeSchema,
  continuitySummary: z.string().max(8_192),
  runtimeStateLosses: z.array(z.string().min(1).max(512)).max(64),
  sourceCheckpointRetained: z.boolean(),
  verificationHash: z.string().length(64).regex(/^[a-f0-9]+$/).optional(),
  error: StructuredErrorSchema.optional(),
});
export type HandoffReceipt = z.infer<typeof HandoffReceiptSchema>;

export const HandoffProgressSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("quiescing"), detail: z.string().max(1_024).optional() }),
  z.object({
    phase: z.literal("checkpointing"),
    completed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  z.object({
    phase: z.literal("transferring"),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  z.object({ phase: z.literal("materializing"), detail: z.string().max(1_024).optional() }),
  z.object({ phase: z.literal("verifying"), detail: z.string().max(1_024).optional() }),
  z.object({ phase: z.literal("switching_authority") }),
  z.object({ phase: z.literal("complete"), receipt: HandoffReceiptSchema }),
  z.object({
    phase: z.literal("failed"),
    error: StructuredErrorSchema,
    sourceRemainsAuthoritative: z.boolean(),
  }),
]);
export type HandoffProgress = z.infer<typeof HandoffProgressSchema>;

export const HostIdentityReadinessSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_configured") }).strict(),
  z
    .object({
      state: z.literal("ready"),
      algorithm: z.literal("Noise_25519"),
      fingerprint: z.string().regex(/^pa1-[A-Za-z0-9_-]{43}$/),
      identityEpoch: z.number().int().positive().max(1_000_000_000),
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      // Bounded open codes allow protocol-v1 hosts to add recovery detail
      // without making an older desktop reject the entire health frame.
      code: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
      recoveryAction: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
    })
    .strict(),
]);
export type HostIdentityReadiness = z.infer<typeof HostIdentityReadinessSchema>;

const RuntimeIntegrityIdentityPartSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/,
    "Runtime identity fields must be bounded path-free identifiers",
  );
const RuntimeIntegrityDigestSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const RuntimeIntegrityTrustAnchorIdSchema = RuntimeIntegrityDigestSchema;

export const RuntimeIntegrityTargetSchema = z
  .object({
    runtime: z.literal("prime-agent"),
    releaseVersion: RuntimeIntegrityIdentityPartSchema,
    runtimeBuildId: RuntimeIntegrityIdentityPartSchema,
    platform: RuntimeIntegrityIdentityPartSchema,
    arch: RuntimeIntegrityIdentityPartSchema,
    manifestSha256: RuntimeIntegrityDigestSchema,
    treeSha256: RuntimeIntegrityDigestSchema,
    filesSha256: RuntimeIntegrityDigestSchema,
  })
  .strict();
export type RuntimeIntegrityTarget = z.infer<typeof RuntimeIntegrityTargetSchema>;

const RuntimeIntegritySnapshotBase = {
  contractVersion: z.literal(1),
  changedAt: IsoDateTimeSchema,
  trustAnchorId: RuntimeIntegrityTrustAnchorIdSchema,
  target: RuntimeIntegrityTargetSchema,
};
const RuntimeIntegrityFailureDetail = {
  code: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
  retryable: z.boolean(),
  recoveryAction: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
};

/**
 * Public integrity readiness only. It deliberately contains no install paths,
 * raw errors, runtime handles, or claims that Prime Agent can execute work.
 */
export const RuntimeIntegritySnapshotSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...RuntimeIntegritySnapshotBase,
      status: z.literal("initializing"),
      phase: z.enum(["preparing", "validating_seed", "copying", "verifying", "publishing"]),
      attempt: z.number().int().min(1).max(32),
    })
    .strict(),
  z
    .object({
      ...RuntimeIntegritySnapshotBase,
      status: z.literal("ready"),
      assurance: z.enum(["development-integrity", "production-authenticated"]),
    })
    .strict(),
  z
    .object({
      ...RuntimeIntegritySnapshotBase,
      ...RuntimeIntegrityFailureDetail,
      status: z.literal("failed"),
    })
    .strict(),
  z
    .object({
      ...RuntimeIntegritySnapshotBase,
      ...RuntimeIntegrityFailureDetail,
      status: z.literal("unavailable"),
    })
    .strict(),
]);
export type RuntimeIntegritySnapshot = z.infer<typeof RuntimeIntegritySnapshotSchema>;

export const HealthSnapshotSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    hostdVersion: z.string().min(1).max(64),
    startedAt: IsoDateTimeSchema,
    checkedAt: IsoDateTimeSchema,
    serviceState: z.enum(["starting", "ready", "degraded"]),
    host: HostSummarySchema,
    capabilities: z.array(CapabilitySchema).max(128),
    /** Optional in protocol v1 so new desktops remain compatible with old hostd. */
    pairingIdentity: HostIdentityReadinessSchema.optional(),
    /** Optional in protocol v1 so new desktops remain compatible with old hostd. */
    runtimeIntegrity: RuntimeIntegritySnapshotSchema.optional(),
  })
  .superRefine((health, context) => {
    const advertisesRuntimeIntegrity = health.capabilities.includes(RUNTIME_INTEGRITY_CAPABILITY);
    const includesRuntimeIntegrity = health.runtimeIntegrity !== undefined;
    if (advertisesRuntimeIntegrity !== includesRuntimeIntegrity) {
      context.addIssue({
        code: "custom",
        path: advertisesRuntimeIntegrity ? ["runtimeIntegrity"] : ["capabilities"],
        message: `${RUNTIME_INTEGRITY_CAPABILITY} must be advertised if and only if runtimeIntegrity is present`,
      });
    }
    const advertisesRuntimeIntegrityRetry = health.capabilities.includes(
      RUNTIME_INTEGRITY_RETRY_CAPABILITY,
    );
    if (
      advertisesRuntimeIntegrityRetry &&
      (health.runtimeIntegrity?.status !== "failed" || !health.runtimeIntegrity.retryable)
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: `${RUNTIME_INTEGRITY_RETRY_CAPABILITY} requires a retryable failed runtime integrity snapshot`,
      });
    }
    if (!health.runtimeIntegrity) return;
    const expectedServiceState = health.runtimeIntegrity.status === "initializing"
      ? "starting"
      : health.runtimeIntegrity.status === "ready"
        ? "ready"
        : "degraded";
    if (health.serviceState !== expectedServiceState) {
      context.addIssue({
        code: "custom",
        path: ["serviceState"],
        message: `serviceState must be ${expectedServiceState} while runtime integrity is ${health.runtimeIntegrity.status}`,
      });
    }
  });
export type HealthSnapshot = z.infer<typeof HealthSnapshotSchema>;

export const ProbeToolStatusSchema = z.object({
  available: z.boolean(),
  version: z.string().max(256).optional(),
  status: z.enum(["ready", "unavailable", "error"]),
  diagnostic: z.string().max(1_024).optional(),
});
export type ProbeToolStatus = z.infer<typeof ProbeToolStatusSchema>;

export const HostProbeSchema = z.object({
  probeVersion: z.literal(1),
  protocolVersion: z.literal("1"),
  hostdVersion: z.string().min(1).max(64),
  compatible: z.boolean(),
  generatedAt: IsoDateTimeSchema,
  platform: PlatformSummarySchema,
  loginShell: z.string().max(1_024).optional(),
  homeDirectory: z.string().min(1).max(4_096),
  availableDiskBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  tools: z.object({
    git: ProbeToolStatusSchema,
    node: ProbeToolStatusSchema,
    bash: ProbeToolStatusSchema,
    python: ProbeToolStatusSchema,
    ipython: ProbeToolStatusSchema,
    primeAgent: ProbeToolStatusSchema,
  }),
  primeRuntime: z.object({
    expectedVersion: z.string().min(1).max(64),
    releaseTag: z.string().min(1).max(64),
    daemonProtocolVersion: z.number().int().nonnegative().max(1_000_000),
    schemaRevision: z.number().int().nonnegative().max(1_000_000),
    schemaId: z.string().min(1).max(256),
    compatibility: z.enum(["unavailable", "handshake_required", "compatible", "incompatible"]),
    diagnostic: z.string().max(1_024).optional(),
  }),
  hostd: z.object({
    installedVersion: z.string().min(1).max(64),
    runningVersion: z.string().min(1).max(64).optional(),
    status: z.enum(["installed", "running", "degraded"]),
  }),
  protocol: z.object({
    minimum: z.literal(PROTOCOL_VERSION),
    maximum: z.literal(PROTOCOL_VERSION),
    current: z.literal(PROTOCOL_VERSION),
    compatible: z.boolean(),
  }),
  configuredRepositoryRoots: z.array(z.string().min(1).max(4_096)).max(128),
  recentProjects: z.array(SavedProjectSchema).max(1_000),
  capabilities: z.array(CapabilitySchema).max(128),
});
export type HostProbe = z.infer<typeof HostProbeSchema>;

/**
 * Path-free public state for one durable resident lifecycle operation. The
 * host Store owns the detailed mutation journal; clients receive only bounded
 * authority, phase, and recovery metadata.
 */
export const ResidentLifecyclePhaseSchema = z.enum([
  "prepared",
  "owned_create_dispatching",
  "owned_observed",
  "promotion_dispatching",
  "promoted_observed",
  "projection_committed",
  "committed",
  "ending",
  "kill_dispatching",
  "kill_acknowledged",
  "detached",
  "quarantined",
  "completed",
]);
export type ResidentLifecyclePhase = z.infer<typeof ResidentLifecyclePhaseSchema>;

export const ResidentLifecycleStatusSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["provision", "end", "detach"]),
    operationId: IdSchema,
    phase: ResidentLifecyclePhaseSchema,
    expectedHostId: IdSchema,
    projectId: IdSchema,
    workspaceId: IdSchema,
    threadId: IdSchema,
    executionGenerationId: IdSchema,
    preparedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    quarantinedFrom: ResidentLifecyclePhaseSchema.exclude([
      "committed",
      "completed",
      "detached",
      "quarantined",
    ]).optional(),
    quarantineReason: z.enum([
      "external_outcome_unknown",
      "authority_changed",
      "explicit_reconciliation_required",
      "owned_client_lost",
    ]).optional(),
    completionReason: z.enum([
      "owned_create_failed_before_effect",
      "owned_create_cleaned",
    ]).optional(),
    terminalAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((status, context) => {
    const provisionPhases = new Set<ResidentLifecyclePhase>([
      "prepared",
      "owned_create_dispatching",
      "owned_observed",
      "promotion_dispatching",
      "promoted_observed",
      "projection_committed",
      "committed",
      "quarantined",
      "completed",
    ]);
    const endPhases = new Set<ResidentLifecyclePhase>([
      "ending",
      "kill_dispatching",
      "kill_acknowledged",
      "quarantined",
      "completed",
    ]);
    if (
      (status.kind === "provision" && !provisionPhases.has(status.phase)) ||
      (status.kind === "end" && !endPhases.has(status.phase)) ||
      (status.kind === "detach" && status.phase !== "detached")
    ) {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message: "Resident lifecycle phase does not belong to its operation",
      });
    }
    const quarantined = status.phase === "quarantined";
    if (quarantined !== Boolean(status.quarantinedFrom && status.quarantineReason)) {
      context.addIssue({
        code: "custom",
        message: "Resident lifecycle quarantine metadata must be present exactly for quarantined state",
      });
    }
    if (
      (status.quarantineReason === "owned_client_lost" && status.quarantinedFrom !== "owned_observed") ||
      (status.quarantineReason === "external_outcome_unknown" &&
        status.quarantinedFrom !== "owned_create_dispatching" &&
        status.quarantinedFrom !== "promotion_dispatching" &&
        status.quarantinedFrom !== "kill_dispatching")
    ) {
      context.addIssue({
        code: "custom",
        path: ["quarantineReason"],
        message: "Resident lifecycle quarantine reason does not match its durable boundary",
      });
    }
    const terminal = status.phase === "committed" || status.phase === "completed" || status.phase === "detached";
    if (terminal !== (status.terminalAt !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["terminalAt"],
        message: "Resident lifecycle terminal time must match terminal state",
      });
    }
    if ((status.completionReason !== undefined) !== (status.kind === "provision" && status.phase === "completed")) {
      context.addIssue({
        code: "custom",
        path: ["completionReason"],
        message: "Resident lifecycle completion reason does not match a completed provision",
      });
    }
  });
export type ResidentLifecycleStatus = z.infer<typeof ResidentLifecycleStatusSchema>;

/**
 * Host-local provisioning envelope. `workspaceDirectory` is accepted only on
 * the trusted-user transport and is never returned in a response or event.
 */
export const ResidentProvisionRequestSchema = z
  .object({
    expectedHostId: IdSchema,
    operationId: IdSchema,
    projectId: IdSchema,
    workspaceId: IdSchema,
    threadId: IdSchema,
    executionGenerationId: IdSchema,
    workspaceDirectory: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !/[\0\r\n]/.test(value), "Workspace paths cannot contain control characters")
      .refine(
        (value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value),
        "Workspace paths must be absolute",
      ),
    projectDisplayName: z.string().trim().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
    threadTitle: z.string().trim().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
    createdAt: IsoDateTimeSchema,
    sessionName: z.string().trim().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)).optional(),
  })
  .strict();
export type ResidentProvisionRequest = z.infer<typeof ResidentProvisionRequestSchema>;

/**
 * Path-free trusted-desktop request to end one exact resident binding. Upstream
 * session identities remain private to the host Store and verified adapter.
 */
export const ResidentEndRequestSchema = z
  .object({
    expectedHostId: IdSchema,
    operationId: IdSchema,
    projectId: IdSchema,
    workspaceId: IdSchema,
    threadId: IdSchema,
    executionGenerationId: IdSchema,
    expectedSourceCursor: SessionCursorSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.expectedSourceCursor.threadId !== request.threadId ||
      request.expectedSourceCursor.executionGenerationId !== request.executionGenerationId
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedSourceCursor"],
        message: "Resident end consent cursor must belong to its exact thread generation",
      });
    }
  });
export type ResidentEndRequest = z.infer<typeof ResidentEndRequestSchema>;

export const ResidentLifecycleLookupResultSchema = z
  .object({ status: ResidentLifecycleStatusSchema.nullable() })
  .strict();
export type ResidentLifecycleLookupResult = z.infer<typeof ResidentLifecycleLookupResultSchema>;

const RequestBase = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: IdSchema,
};

export const HostIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ ...RequestBase, method: z.literal("health.get"), payload: z.object({}) }),
  z.object({
    ...RequestBase,
    method: z.literal("runtime.integrity.retry"),
    payload: z.object({ expectedHostId: IdSchema }).strict(),
  }),
  z.object({
    ...RequestBase,
    method: z.literal("runtime.model_catalog"),
    payload: z.object({ expectedHostId: IdSchema }).strict(),
  }),
  z.object({
    ...RequestBase,
    method: z.literal("oauth.session.start"),
    payload: z
      .object({ expectedHostId: IdSchema, authorityId: IdSchema, providerId: IdSchema })
      .strict(),
  }),
  z.object({
    ...RequestBase,
    method: z.literal("oauth.session.status"),
    payload: z.object({ expectedHostId: IdSchema, authorityId: IdSchema, sessionId: IdSchema }).strict(),
  }),
  z.object({
    ...RequestBase,
    method: z.literal("oauth.session.cancel"),
    payload: z.object({ expectedHostId: IdSchema, authorityId: IdSchema, sessionId: IdSchema }).strict(),
  }),
  z.object({
    ...RequestBase,
    method: z.literal("catalog.snapshot"),
    payload: z.object({ snapshotTransfer: SnapshotTransferPreferenceSchema.optional() }),
  }),
  z.object({
    ...RequestBase,
    method: z.literal("thread.snapshot"),
    payload: z
      .object({
        threadId: IdSchema,
        cursor: SessionCursorSchema.optional(),
        snapshotTransfer: SnapshotTransferPreferenceSchema.optional(),
      })
      .superRefine((payload, context) => {
        if (payload.cursor && payload.cursor.threadId !== payload.threadId) {
          context.addIssue({
            code: "custom",
            path: ["cursor", "threadId"],
            message: "The cursor must belong to the requested thread",
          });
        }
      }),
  }),
  z.object({
    ...RequestBase,
    method: z.literal("command.submit"),
    payload: z.object({ command: CommandEnvelopeSchema }),
  }),
  z.object({
    ...RequestBase,
    method: z.literal("command.reconcile"),
    payload: z
      .object({
        expectedHostId: IdSchema,
        // Reconciliation proves the complete immutable envelope, not merely its
        // user-controlled identity. One envelope per request keeps worst-case
        // UTF-8 and JSON escaping safely below the one-MiB transport frame.
        commands: z.array(CommandEnvelopeSchema).length(1),
      })
      .strict(),
  }),
  z.object({
    ...RequestBase,
    method: z.literal("resident.provision"),
    payload: ResidentProvisionRequestSchema,
  }),
  z.object({
    ...RequestBase,
    method: z.literal("resident.end"),
    payload: ResidentEndRequestSchema,
  }),
  z.object({
    ...RequestBase,
    method: z.literal("resident.lifecycle.status"),
    payload: z.object({ expectedHostId: IdSchema, operationId: IdSchema }).strict(),
  }),
  z.object({
    ...RequestBase,
    method: z.literal("handoff.plan"),
    payload: z.object({ expectedHostId: IdSchema, request: HandoffPlanRequestSchema }),
  }),
  z.object({
    ...RequestBase,
    method: z.literal("handoff.commit"),
    payload: z.object({
      handoffId: IdSchema,
      deviceId: IdSchema,
      commandId: IdSchema,
      expectedHostId: IdSchema,
    }),
  }),
]);
export type HostIpcRequest = z.infer<typeof HostIpcRequestSchema>;

export const CommandReconciliationSchema = z
  .object({
    receipts: z.array(CommandReceiptSchema).max(1),
    unknown: z.array(CommandIdentitySchema).max(1),
  })
  .strict()
  .refine((result) => result.receipts.length + result.unknown.length === 1, {
    message: "Reconciliation must return exactly one receipt or one unknown identity",
  });
export type CommandReconciliation = z.infer<typeof CommandReconciliationSchema>;

export const HandoffCommitResultSchema = z.object({
  receipt: HandoffReceiptSchema,
  progress: z.array(HandoffProgressSchema).min(1).max(16),
});
export type HandoffCommitResult = z.infer<typeof HandoffCommitResultSchema>;

const SuccessBase = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: IdSchema,
  ok: z.literal(true),
};

export const HostIpcSuccessResponseSchema = z.discriminatedUnion("method", [
  z.object({ ...SuccessBase, method: z.literal("health.get"), result: HealthSnapshotSchema }),
  z.object({
    ...SuccessBase,
    method: z.literal("runtime.integrity.retry"),
    result: RuntimeIntegritySnapshotSchema,
  }),
  z.object({ ...SuccessBase, method: z.literal("runtime.model_catalog"), result: RuntimeModelCatalogSnapshotSchema }),
  z.object({ ...SuccessBase, method: z.literal("oauth.session.start"), result: RuntimeOAuthSessionSnapshotSchema }),
  z.object({ ...SuccessBase, method: z.literal("oauth.session.status"), result: RuntimeOAuthSessionSnapshotSchema }),
  z.object({ ...SuccessBase, method: z.literal("oauth.session.cancel"), result: RuntimeOAuthSessionSnapshotSchema }),
  z.object({ ...SuccessBase, method: z.literal("catalog.snapshot"), result: CatalogProjectionSnapshotSchema }),
  z.object({ ...SuccessBase, method: z.literal("thread.snapshot"), result: ThreadProjectionSnapshotSchema }),
  z.object({ ...SuccessBase, method: z.literal("command.submit"), result: CommandReceiptSchema }),
  z.object({ ...SuccessBase, method: z.literal("command.reconcile"), result: CommandReconciliationSchema }),
  z.object({ ...SuccessBase, method: z.literal("resident.provision"), result: ResidentLifecycleStatusSchema }),
  z.object({ ...SuccessBase, method: z.literal("resident.end"), result: ResidentLifecycleStatusSchema }),
  z.object({
    ...SuccessBase,
    method: z.literal("resident.lifecycle.status"),
    result: ResidentLifecycleLookupResultSchema,
  }),
  z.object({ ...SuccessBase, method: z.literal("handoff.plan"), result: HandoffPlanSchema }),
  z.object({ ...SuccessBase, method: z.literal("handoff.commit"), result: HandoffCommitResultSchema }),
]);
export type HostIpcSuccessResponse = z.infer<typeof HostIpcSuccessResponseSchema>;

export const HostIpcErrorResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: IdSchema,
  method: z.enum([
    "health.get",
    "runtime.integrity.retry",
    "runtime.model_catalog",
    "oauth.session.start",
    "oauth.session.status",
    "oauth.session.cancel",
    "catalog.snapshot",
    "thread.snapshot",
    "command.submit",
    "command.reconcile",
    "resident.provision",
    "resident.end",
    "resident.lifecycle.status",
    "handoff.plan",
    "handoff.commit",
  ]),
  ok: z.literal(false),
  error: StructuredErrorSchema,
});
export type HostIpcErrorResponse = z.infer<typeof HostIpcErrorResponseSchema>;

export const HostIpcResponseSchema = z.union([HostIpcSuccessResponseSchema, HostIpcErrorResponseSchema]);
export type HostIpcResponse = z.infer<typeof HostIpcResponseSchema>;

// Short aliases for consumers that use this surface as Electron IPC rather than
// a socket transport. The wire DTO is deliberately identical in both cases.
export const IpcRequestSchema = HostIpcRequestSchema;
export const IpcResponseSchema = HostIpcResponseSchema;
export type IpcRequest = HostIpcRequest;
export type IpcResponse = HostIpcResponse;
