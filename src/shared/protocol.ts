import { z } from "zod";
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  isPinnedCodexAuthorizationUrl,
} from "./codex-oauth";
import {
  parseRuntimeOAuthAttemptTerminalV1,
  parseRuntimeOAuthAttemptV1,
  type RuntimeOAuthAttemptTerminalV1,
  type RuntimeOAuthAttemptV1,
} from "./runtime-oauth-attempt";
export {
  CANDIDATE_EVALUATION_PROBE_CAPABILITY,
  PRIME_AGENT_COMMAND_CAPABILITY,
  PRIME_CONTINUIM_SELF_BUILD_EVALUATION_CAPABILITY,
  RESIDENT_CONTROL_PROJECTION_CAPABILITY,
  RESIDENT_LIFECYCLE_CAPABILITY,
  RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY,
  RUNTIME_INTEGRITY_CAPABILITY,
  RUNTIME_INTEGRITY_REPAIR_CAPABILITY,
  RUNTIME_INTEGRITY_RETRY_CAPABILITY,
  RUNTIME_MODEL_CATALOG_CAPABILITY,
  RUNTIME_OAUTH_ATTEMPT_CAPABILITY,
  RUNTIME_OAUTH_CAPABILITY,
  THREAD_HANDOFF_CAPABILITY,
} from "./capabilities";
import {
  CANDIDATE_EVALUATION_PROBE_CAPABILITY,
  PRIME_AGENT_COMMAND_CAPABILITY,
  PRIME_CONTINUIM_SELF_BUILD_EVALUATION_CAPABILITY,
  RESIDENT_CONTROL_PROJECTION_CAPABILITY,
  RESIDENT_LIFECYCLE_CAPABILITY,
  RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY,
  RUNTIME_INTEGRITY_CAPABILITY,
  RUNTIME_INTEGRITY_REPAIR_CAPABILITY,
  RUNTIME_INTEGRITY_RETRY_CAPABILITY,
  RUNTIME_MODEL_CATALOG_CAPABILITY,
  RUNTIME_OAUTH_ATTEMPT_CAPABILITY,
  RUNTIME_OAUTH_CAPABILITY,
  THREAD_HANDOFF_CAPABILITY,
} from "./capabilities";

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

/**
 * Path-free host-owned view of the one resident control operation that
 * currently fences a thread generation. It is deliberately a projection, not
 * mutation authority: clients still submit a complete generation-fenced
 * command envelope through `command.submit`.
 */
export const ResidentControlOperationSchema = z
  .object({
    kind: z.enum(["prompt", "abort"]),
    deviceId: IdSchema,
    commandId: IdSchema,
    phase: z.enum(["admitted", "dispatching", "acknowledged", "uncertain"]),
    admittedAt: IsoDateTimeSchema,
    changedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((operation, context) => {
    if (Date.parse(operation.changedAt) < Date.parse(operation.admittedAt)) {
      context.addIssue({
        code: "custom",
        path: ["changedAt"],
        message: "Resident control operation time cannot precede admission",
      });
    }
  });
export type ResidentControlOperation = z.infer<typeof ResidentControlOperationSchema>;

export const ResidentControlQuiescenceSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle_proven") }).strict(),
  z.object({ state: z.literal("prompt_owned") }).strict(),
  z.object({ state: z.literal("stop_owned") }).strict(),
  z
    .object({
      state: z.literal("uncertain"),
      reason: z.enum(["active_without_operation", "mutation_outcome_unknown", "lifecycle_transition"]),
    })
    .strict(),
  z.object({ state: z.literal("ended"), endedAt: IsoDateTimeSchema }).strict(),
]);
export type ResidentControlQuiescence = z.infer<typeof ResidentControlQuiescenceSchema>;

export const ResidentBrowserExecutionSchema = z.discriminatedUnion("readiness", [
  z.object({ readiness: z.literal("unavailable") }).strict(),
  z
    .object({
      readiness: z.literal("ready"),
      protocol: z.literal("prime-continuim.browser.v1"),
      surface: z.literal("playwright-cli"),
      controller: z.literal("playwright-core/1.63.0-alpha-2026-08-05"),
      engine: z.literal("verified-electron-host"),
    })
    .strict(),
]);
export type ResidentBrowserExecution = z.infer<typeof ResidentBrowserExecutionSchema>;

/**
 * Bounded generation-scoped read model for cross-device control discovery.
 * `controlSequence` is Store-owned and monotonic for this exact thread
 * generation; duplicate reads of unchanged semantic state return the same
 * sequence and timestamp.
 */
export const ResidentControlProjectionSnapshotSchema = z
  .object({
    projectionVersion: z.literal(1),
    hostId: IdSchema,
    threadId: IdSchema,
    executionGenerationId: IdSchema,
    bindingFingerprint: z.string().length(64).regex(/^[a-f0-9]{64}$/),
    controlSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    changedAt: IsoDateTimeSchema,
    authorityCursor: SessionCursorSchema,
    /** Exact-thread command readiness; host-global capabilities never imply this state. */
    // Pre-readiness v1 projections omitted this field. They remain readable
    // only as explicitly unavailable evidence; a current HostStore must prove
    // the exact live binding again before publishing `ready`.
    commandReadiness: z.enum(["ready", "unavailable"]).default("unavailable"),
    /** Exact-binding execution proof; catalog skill discovery alone never makes this ready. */
    browserExecution: ResidentBrowserExecutionSchema.default({ readiness: "unavailable" }),
    operation: ResidentControlOperationSchema.optional(),
    quiescence: ResidentControlQuiescenceSchema,
  })
  .strict()
  .superRefine((projection, context) => {
    if (
      projection.authorityCursor.threadId !== projection.threadId ||
      projection.authorityCursor.executionGenerationId !== projection.executionGenerationId
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorityCursor"],
        message: "Resident control cursor must belong to the exact projected generation",
      });
    }
    if (
      projection.operation &&
      Date.parse(projection.changedAt) < Date.parse(projection.operation.changedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["changedAt"],
        message: "Resident control projection time cannot precede its current operation",
      });
    }

    const operation = projection.operation;
    switch (projection.quiescence.state) {
      case "prompt_owned":
        if (operation?.kind !== "prompt" || operation.phase === "uncertain") {
          context.addIssue({ code: "custom", message: "Prompt ownership requires one certain prompt operation" });
        }
        break;
      case "stop_owned":
        if (operation?.kind !== "abort" || operation.phase === "uncertain") {
          context.addIssue({ code: "custom", message: "Stop ownership requires one certain abort operation" });
        }
        break;
      case "uncertain":
        if (
          projection.quiescence.reason === "mutation_outcome_unknown"
            ? operation?.phase !== "uncertain"
            : operation !== undefined
        ) {
          context.addIssue({ code: "custom", message: "Uncertain control state has inconsistent operation evidence" });
        }
        break;
      case "idle_proven":
      case "ended":
        if (operation !== undefined) {
          context.addIssue({ code: "custom", message: "Quiescent resident control state cannot retain an operation" });
        }
        break;
    }
  });
export type ResidentControlProjectionSnapshot = z.infer<typeof ResidentControlProjectionSnapshotSchema>;

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

export const RuntimeResourceSourceKindSchema = z
  .object({
    scope: z.enum(["user", "project", "temporary"]),
    origin: z.enum(["package", "top-level"]),
  })
  .strict();
export type RuntimeResourceSourceKind = z.infer<typeof RuntimeResourceSourceKindSchema>;

export const RuntimeNamedResourceSchema = z
  .object({
    name: z.string().min(1).max(255).regex(/^[^\0\r\n]+$/),
    description: z.string().max(4_096).optional(),
    sourceKind: RuntimeResourceSourceKindSchema.optional(),
  })
  .strict();
export type RuntimeNamedResource = z.infer<typeof RuntimeNamedResourceSchema>;

export const RuntimeResourceCollisionSchema = z
  .object({
    resourceType: z.enum(["extension", "skill", "prompt", "theme"]),
    name: z.string().min(1).max(255).regex(/^[^\0\r\n]+$/),
  })
  .strict();
export type RuntimeResourceCollision = z.infer<typeof RuntimeResourceCollisionSchema>;

/**
 * Secret- and path-free inventory of resources loaded by the exact resident
 * Prime Agent session. Raw diagnostics are reduced to counts and collision
 * identities because their free-form text and source records may contain local
 * filesystem paths.
 */
export const RuntimeResourceInventorySchema = z
  .object({
    skills: z.array(RuntimeNamedResourceSchema).max(2_000),
    prompts: z.array(RuntimeNamedResourceSchema).max(2_000),
    themes: z.array(RuntimeNamedResourceSchema).max(1_000),
    extensions: z
      .object({
        count: z.number().int().nonnegative().max(2_000),
        sourceKinds: z
          .array(RuntimeResourceSourceKindSchema)
          .max(6)
          .refine(
            (items) => new Set(items.map((item) => `${item.scope}:${item.origin}`)).size === items.length,
            "Extension source kinds must be unique",
          ),
      })
      .strict(),
    contextFileCount: z.number().int().nonnegative().max(2_000),
    diagnostics: z
      .object({
        warningCount: z.number().int().nonnegative().max(2_000),
        errorCount: z.number().int().nonnegative().max(2_000),
        collisions: z.array(RuntimeResourceCollisionSchema).max(2_000),
      })
      .strict(),
  })
  .strict();
export type RuntimeResourceInventory = z.infer<typeof RuntimeResourceInventorySchema>;

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
  resourceInventory: RuntimeResourceInventorySchema.optional(),
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

const Sha256Schema = z.string().length(64).regex(/^[a-f0-9]{64}$/);

/**
 * Exact path-free identity emitted by the canonical self-build candidate
 * capture. It correlates evidence to bytes; it is not an authenticated source
 * identity.
 */
export const CandidateSourceIdentitySchema = z
  .object({
    headCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    dirty: z.boolean(),
    statusPorcelainV2Sha256: Sha256Schema,
    statusBytes: z.number().int().nonnegative().max(16 * 1024 * 1024),
    binaryPatchSha256: Sha256Schema,
    binaryPatchBytes: z.number().int().nonnegative().max(64 * 1024 * 1024),
    untrackedManifestSha256: Sha256Schema,
    untrackedFileCount: z.number().int().nonnegative().max(2_000),
    untrackedBytes: z.number().int().nonnegative().max(128 * 1024 * 1024),
    treeSha256: Sha256Schema,
    treeFileCount: z.number().int().positive().max(20_000),
    treeBytes: z.number().int().nonnegative().max(512 * 1024 * 1024),
  })
  .strict();
export type CandidateSourceIdentity = z.infer<typeof CandidateSourceIdentitySchema>;

/** Passive, non-executing identity for the bytes reviewed before consent. */
/**
 * Passive, path-free change-detection fingerprint shown before consent. It is
 * rechecked immediately before admission but is not an authenticated or
 * handle-pinned execution identity; canonical candidate/toolchain evidence is
 * produced only by the consented self-build receipt.
 */
export const CandidateEvaluationReviewIdentitySchema = z
  .object({
    headCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    gitIndexSha256: Sha256Schema,
    gitIndexBytes: z.number().int().positive().max(128 * 1024 * 1024),
    packageManifestSha256: Sha256Schema,
    lockfileSha256: Sha256Schema,
    lockfileBytes: z.number().int().positive().max(64 * 1024 * 1024),
    nodeVersionPinSha256: Sha256Schema,
    selfBuildEntrypointSha256: Sha256Schema,
    launcherBootstrapSha256: Sha256Schema,
    launcherBootstrapFileCount: z.literal(9),
    runtimePointerSha256: Sha256Schema,
    nodePackageManifestSha256: Sha256Schema,
    nodeExecutableSha256: Sha256Schema,
    pnpmCliSha256: Sha256Schema,
    reviewAggregateSha256: Sha256Schema,
  })
  .strict();
export type CandidateEvaluationReviewIdentity = z.infer<
  typeof CandidateEvaluationReviewIdentitySchema
>;

/** Explicitly negative assurance claims for the first self-evaluation slice. */
export const CandidateEvaluationBoundarySchema = z
  .object({
    securitySandbox: z.literal(false),
    mainFilesystemIsolation: z.literal(false),
    providerBackedEvaluation: z.literal(false),
    autonomousPromotion: z.literal(false),
    candidateControlledEvaluation: z.literal(true),
    packageOrInstallerGate: z.literal(false),
    authenticated: z.literal(false),
    integrity: z.literal("sha256-correlation-only-not-authentication"),
  })
  .strict();
export type CandidateEvaluationBoundary = z.infer<typeof CandidateEvaluationBoundarySchema>;

const CandidateEvaluationAuthorityFields = {
  expectedHostId: IdSchema,
  threadId: IdSchema,
  expectedExecutionGenerationId: IdSchema,
};

export const CandidateEvaluationPreflightRequestSchema = z
  .object(CandidateEvaluationAuthorityFields)
  .strict();
export type CandidateEvaluationPreflightRequest = z.infer<
  typeof CandidateEvaluationPreflightRequestSchema
>;

const CandidateEvaluationUnavailableCodeSchema = z.enum([
  "EVALUATOR_NOT_CONFIGURED",
  "RUNTIME_NOT_READY",
  "WORKSPACE_NOT_PRIME_CONTINUIM",
  "WORKSPACE_AUTHORITY_CHANGED",
  "GIT_CONTEXT_INVALID",
  "TOOLCHAIN_UNAVAILABLE",
  "CANDIDATE_INVALID",
  "EVALUATION_BUSY",
  "EVALUATION_OUTCOME_UNKNOWN",
]);

const CandidateEvaluationPreflightBase = {
  preflightVersion: z.literal(1),
  ...CandidateEvaluationAuthorityFields,
  observedAt: IsoDateTimeSchema,
  boundary: CandidateEvaluationBoundarySchema,
};

export const CandidateEvaluationPreflightSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...CandidateEvaluationPreflightBase,
      status: z.literal("ready"),
      capability: z.literal(PRIME_CONTINUIM_SELF_BUILD_EVALUATION_CAPABILITY),
      review: CandidateEvaluationReviewIdentitySchema,
      executor: z
        .object({
          kind: z.literal("canonical_self_build"),
          gateProcessContainment: z.enum(["windows_job", "posix_process_group"]),
          requiredNodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
          requiredPnpmVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
          verification: z.literal("passive-structure-before-consent;canonical-toolchain-inside-evaluation"),
          launcherSource: z.literal("workspace-dependency-tree-candidate-controlled"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...CandidateEvaluationPreflightBase,
      status: z.literal("unavailable"),
      code: CandidateEvaluationUnavailableCodeSchema,
      message: z.string().min(1).max(1_024).regex(/^[^\0\r\n]+$/),
      retryable: z.boolean(),
    })
    .strict(),
]);
export type CandidateEvaluationPreflight = z.infer<typeof CandidateEvaluationPreflightSchema>;

export const CandidateEvaluationStartRequestSchema = z
  .object({
    ...CandidateEvaluationAuthorityFields,
    operationId: IdSchema,
    requestedAt: IsoDateTimeSchema,
    kind: z.literal("prime_continuim_self_build_v1"),
    expectedReview: CandidateEvaluationReviewIdentitySchema,
  })
  .strict();
export type CandidateEvaluationStartRequest = z.infer<typeof CandidateEvaluationStartRequestSchema>;

export const CandidateEvaluationReceiptSummarySchema = z
  .object({
    receiptVersion: z.literal(1),
    kind: z.literal("prime_continuim_candidate_evaluation_evidence"),
    selfBuildRunId: z.string().uuid(),
    selfBuildReceiptSha256: Sha256Schema,
    outcome: z.enum(["passed", "failed"]),
    settledGateCount: z.number().int().nonnegative().max(6),
    gateCount: z.literal(6),
    artifactAggregateSha256: Sha256Schema.optional(),
    artifactFileCount: z.number().int().positive().max(50_000).optional(),
    completedAt: IsoDateTimeSchema,
    boundary: CandidateEvaluationBoundarySchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if ((receipt.artifactAggregateSha256 === undefined) !== (receipt.artifactFileCount === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["artifactAggregateSha256"],
        message: "Artifact digest and file count must be present together",
      });
    }
    if (
      receipt.outcome === "passed" &&
      (receipt.settledGateCount !== receipt.gateCount ||
        receipt.artifactAggregateSha256 === undefined ||
        receipt.artifactFileCount === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Passing evidence requires all gates and the artifact aggregate",
      });
    }
  });
export type CandidateEvaluationReceiptSummary = z.infer<
  typeof CandidateEvaluationReceiptSummarySchema
>;

export const CandidateEvaluationErrorSchema = z
  .object({
    code: z.enum([
      "CANDIDATE_CHANGED",
      "EVALUATION_LAUNCH_FAILED",
      "EVALUATION_FAILED",
      "EVALUATION_RECEIPT_INVALID",
      "EVALUATION_OUTCOME_UNKNOWN",
      "EVALUATION_STORAGE_FULL",
      "EVALUATION_CLOSED",
      "EVALUATION_NOT_INVOKED",
    ]),
    message: z.string().min(1).max(1_024).regex(/^[^\0\r\n]+$/),
    retryable: z.boolean(),
  })
  .strict();
export type CandidateEvaluationError = z.infer<typeof CandidateEvaluationErrorSchema>;

export const CandidateEvaluationStatusSchema = z
  .object({
    statusVersion: z.literal(1),
    ...CandidateEvaluationAuthorityFields,
    operationId: IdSchema,
    kind: z.literal("prime_continuim_self_build_v1"),
    requestedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    status: z.enum(["prepared", "running", "passed", "failed", "uncertain"]),
    review: CandidateEvaluationReviewIdentitySchema,
    candidate: CandidateSourceIdentitySchema.optional(),
    invocationStartedAt: IsoDateTimeSchema.optional(),
    completedAt: IsoDateTimeSchema.optional(),
    receipt: CandidateEvaluationReceiptSummarySchema.optional(),
    error: CandidateEvaluationErrorSchema.optional(),
    boundary: CandidateEvaluationBoundarySchema,
  })
  .strict()
  .superRefine((status, context) => {
    const terminal = status.status === "passed" || status.status === "failed" || status.status === "uncertain";
    if (terminal !== (status.completedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Only terminal candidate evaluations have a completion time",
      });
    }
    if (status.status === "prepared" && status.invocationStartedAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["invocationStartedAt"],
        message: "A prepared candidate evaluation cannot record an invocation boundary",
      });
    }
    if (
      (status.status === "running" || status.status === "passed" || status.status === "uncertain") &&
      status.invocationStartedAt === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["invocationStartedAt"],
        message: "Every invoked candidate evaluation records its invocation boundary",
      });
    }
    if (status.status === "passed" && status.receipt?.outcome !== "passed") {
      context.addIssue({
        code: "custom",
        path: ["receipt"],
        message: "A passing evaluation requires an exact passing self-build receipt",
      });
    }
    if ((status.receipt !== undefined) !== (status.candidate !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "Canonical candidate identity is exposed only with exact receipt evidence",
      });
    }
    if (status.receipt !== undefined && status.invocationStartedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["invocationStartedAt"],
        message: "Immutable self-build evidence requires the durable invocation boundary",
      });
    }
    if (status.status === "failed" && !status.receipt && !status.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "A failed evaluation requires receipt or error evidence",
      });
    }
    if (status.status === "failed" && status.receipt?.outcome !== undefined && status.receipt.outcome !== "failed") {
      context.addIssue({
        code: "custom",
        path: ["receipt", "outcome"],
        message: "A failed evaluation cannot expose a passing self-build receipt",
      });
    }
    if ((status.status === "prepared" || status.status === "running" || status.status === "uncertain") && status.receipt) {
      context.addIssue({
        code: "custom",
        path: ["receipt"],
        message: "This candidate evaluation state cannot expose a settled receipt",
      });
    }
    if (status.status === "uncertain" && !status.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "An uncertain evaluation requires explicit outcome-unknown evidence",
      });
    }
    if (
      (status.status === "prepared" || status.status === "running" || status.status === "passed") &&
      status.error
    ) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Prepared, running, and passing evaluations cannot expose an error",
      });
    }
  });
export type CandidateEvaluationStatus = z.infer<typeof CandidateEvaluationStatusSchema>;

export const CandidateEvaluationSnapshotSchema = z
  .object({
    snapshotVersion: z.literal(1),
    ...CandidateEvaluationAuthorityFields,
    generatedAt: IsoDateTimeSchema,
    repeatEffectsWarningRequired: z.boolean(),
    evaluations: z.array(CandidateEvaluationStatusSchema).max(32),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const operationIds = new Set<string>();
    snapshot.evaluations.forEach((evaluation, index) => {
      if (
        evaluation.expectedHostId !== snapshot.expectedHostId ||
        evaluation.threadId !== snapshot.threadId ||
        evaluation.expectedExecutionGenerationId !== snapshot.expectedExecutionGenerationId
      ) {
        context.addIssue({
          code: "custom",
          path: ["evaluations", index],
          message: "Every evaluation must belong to the snapshot authority",
        });
      }
      if (operationIds.has(evaluation.operationId)) {
        context.addIssue({
          code: "custom",
          path: ["evaluations", index, "operationId"],
          message: "Candidate evaluation operation identities must be unique",
        });
      }
      operationIds.add(evaluation.operationId);
    });
  });
export type CandidateEvaluationSnapshot = z.infer<typeof CandidateEvaluationSnapshotSchema>;

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
    residentControl: ResidentControlProjectionSnapshotSchema.optional(),
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
    const residentControl = snapshot.residentControl;
    if (
      residentControl &&
      (residentControl.hostId !== snapshot.thread.currentLocation.hostId ||
        residentControl.threadId !== snapshot.thread.threadId ||
        residentControl.executionGenerationId !== snapshot.thread.currentLocation.executionGenerationId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["residentControl"],
        message: "Resident control readiness must belong to the exact projected host thread generation",
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

const RuntimeOAuthCanonicalTimestampSchema = z
  .string()
  .length(24)
  .regex(
    /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/,
  )
  .refine(
    (value) => {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
    },
    "Must be a real canonical UTC ISO timestamp with milliseconds",
  );
const RuntimeOAuthDigestSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/)
  .refine((value) => value !== "0".repeat(64), "Must be a canonical nonzero lowercase SHA-256");

/** Strict wire adapter around the shared, digest-checking OAuth attempt parser. */
export const RuntimeOAuthAttemptV1Schema = z.unknown().transform(
  (value, context): RuntimeOAuthAttemptV1 => {
    try {
      return parseRuntimeOAuthAttemptV1(value);
    } catch {
      context.addIssue({ code: "custom", message: "Runtime OAuth attempt is invalid" });
      return z.NEVER;
    }
  },
);

/** Strict wire adapter around the shared terminal-evidence parser. */
export const RuntimeOAuthAttemptTerminalV1Schema = z.unknown().transform(
  (value, context): RuntimeOAuthAttemptTerminalV1 => {
    try {
      return parseRuntimeOAuthAttemptTerminalV1(value);
    } catch {
      context.addIssue({ code: "custom", message: "Runtime OAuth terminal evidence is invalid" });
      return z.NEVER;
    }
  },
);

export const RuntimeOAuthAttemptRecordPhaseSchema = z.enum([
  "prepared",
  "login_dispatching",
  "credentials_ready",
  "persistence_dispatching",
  "cancelling",
  "recovery_required",
  "completed",
  "cancelled",
  "failed",
  "outcome_unknown",
]);
export type RuntimeOAuthAttemptRecordPhase = z.infer<typeof RuntimeOAuthAttemptRecordPhaseSchema>;

const RuntimeOAuthAttemptTerminalPhases = new Set<RuntimeOAuthAttemptRecordPhase>([
  "completed",
  "cancelled",
  "failed",
  "outcome_unknown",
]);

/**
 * Secret-free public projection of the host's durable OAuth attempt record.
 * Initial authority, cancellation/recovery internals, paths, and credentials
 * deliberately have no wire fields.
 */
export const RuntimeOAuthAttemptRecordSchema = z
  .object({
    recordVersion: z.literal(1),
    attempt: RuntimeOAuthAttemptV1Schema,
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sessionId: IdSchema,
    phase: RuntimeOAuthAttemptRecordPhaseSchema,
    createdAt: RuntimeOAuthCanonicalTimestampSchema,
    updatedAt: RuntimeOAuthCanonicalTimestampSchema,
    expiresAt: RuntimeOAuthCanonicalTimestampSchema,
    terminal: RuntimeOAuthAttemptTerminalV1Schema.optional(),
    desktopAcknowledgedAt: RuntimeOAuthCanonicalTimestampSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const terminalPhase = RuntimeOAuthAttemptTerminalPhases.has(record.phase);
    if (!runtimeOAuthAttemptRevisionIsReachable(record)) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "OAuth record revision cannot reach its projected phase",
      });
    }
    if (record.createdAt !== record.attempt.identity.requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["createdAt"],
        message: "OAuth record creation must equal the attempt request time",
      });
    }
    if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
      context.addIssue({ code: "custom", path: ["updatedAt"], message: "OAuth record time moved backwards" });
    }
    if (Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "OAuth record expiry is invalid" });
    }
    if (terminalPhase !== (record.terminal !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["terminal"],
        message: "OAuth record phase and terminal evidence disagree",
      });
    }
    if (!record.terminal) {
      if (record.desktopAcknowledgedAt !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["desktopAcknowledgedAt"],
          message: "A nonterminal OAuth record cannot be acknowledged",
        });
      }
      return;
    }
    if (
      record.terminal.body.attemptDigest !== record.attempt.attemptDigest ||
      record.terminal.body.phase !== record.phase
    ) {
      context.addIssue({
        code: "custom",
        path: ["terminal"],
        message: "OAuth terminal evidence is cross-fed or phase-incoherent",
      });
    }
    if (Date.parse(record.terminal.body.terminalAt) < Date.parse(record.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["terminal", "body", "terminalAt"],
        message: "OAuth terminal evidence predates its attempt",
      });
    }
    if (record.desktopAcknowledgedAt !== undefined) {
      if (
        Date.parse(record.desktopAcknowledgedAt) < Date.parse(record.terminal.body.terminalAt) ||
        record.updatedAt !== record.desktopAcknowledgedAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["desktopAcknowledgedAt"],
          message: "OAuth acknowledgement is not bound to the terminal record",
        });
      }
    } else if (record.updatedAt !== record.terminal.body.terminalAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Unacknowledged OAuth terminal time must be the latest record time",
      });
    }
  });
export type RuntimeOAuthAttemptRecord = z.infer<typeof RuntimeOAuthAttemptRecordSchema>;

function runtimeOAuthAttemptRevisionIsReachable(record: {
  phase: RuntimeOAuthAttemptRecordPhase;
  revision: number;
  terminal?: RuntimeOAuthAttemptTerminalV1;
  desktopAcknowledgedAt?: string;
}): boolean {
  let baseRevisions: readonly number[];
  if (!record.terminal) {
    switch (record.phase) {
      case "prepared": baseRevisions = [0]; break;
      case "login_dispatching": baseRevisions = [1]; break;
      case "credentials_ready":
      case "cancelling": baseRevisions = [2]; break;
      case "persistence_dispatching": baseRevisions = [3]; break;
      case "recovery_required": baseRevisions = [2, 3, 4]; break;
      case "completed":
      case "cancelled":
      case "failed":
      case "outcome_unknown": return false;
    }
  } else {
    switch (record.terminal.body.resolution) {
      case "interrupted_before_login_dispatch": baseRevisions = [1]; break;
      case "provider_login_failed": baseRevisions = [2]; break;
      case "interrupted_during_login": baseRevisions = [2, 3]; break;
      case "credentials_discarded_before_persistence": baseRevisions = [3]; break;
      case "persistence_confirmed":
      case "persistence_failed": baseRevisions = [4]; break;
      case "configured_observed_after_recovery":
      case "not_configured_observed_after_recovery": baseRevisions = [5]; break;
      case "user_cancelled":
      case "expired":
      case "host_shutdown": baseRevisions = [1, 3, 4]; break;
    }
  }
  const acknowledgementIncrement = record.desktopAcknowledgedAt === undefined ? 0 : 1;
  return baseRevisions.some((revision) => record.revision === revision + acknowledgementIncrement);
}

const RuntimeOAuthAttemptResultFields = {
  attemptDigest: RuntimeOAuthDigestSchema,
  live: RuntimeOAuthSessionSnapshotSchema.optional(),
};

/** Read-only reconciliation result; a digest-bound null proves the attempt is absent. */
export const RuntimeOAuthAttemptStatusResultSchema = z
  .object({
    ...RuntimeOAuthAttemptResultFields,
    record: RuntimeOAuthAttemptRecordSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    for (const issue of runtimeOAuthAttemptResultIssues(result)) {
      context.addIssue({ code: "custom", ...issue });
    }
  });
export type RuntimeOAuthAttemptStatusResult = z.infer<typeof RuntimeOAuthAttemptStatusResultSchema>;

/** Effect result; start, cancel, and acknowledge must return a durable record. */
export const RuntimeOAuthAttemptEffectResultSchema = z
  .object({
    ...RuntimeOAuthAttemptResultFields,
    record: RuntimeOAuthAttemptRecordSchema,
  })
  .strict()
  .superRefine((result, context) => {
    for (const issue of runtimeOAuthAttemptResultIssues(result)) {
      context.addIssue({ code: "custom", ...issue });
    }
  });
export type RuntimeOAuthAttemptEffectResult = z.infer<typeof RuntimeOAuthAttemptEffectResultSchema>;

/** A successful new start has crossed exactly the durable login-dispatch boundary. */
export const RuntimeOAuthAttemptStartResultSchema = RuntimeOAuthAttemptEffectResultSchema
  .superRefine((result, context) => {
    if (result.record.phase !== "login_dispatching") {
      context.addIssue({
        code: "custom",
        path: ["record", "phase"],
        message: "OAuth start must return the exact login-dispatching record",
      });
    }
  });
export type RuntimeOAuthAttemptStartResult = z.infer<typeof RuntimeOAuthAttemptStartResultSchema>;

/** Cancellation returns only after one terminal outcome is durably known. */
export const RuntimeOAuthAttemptCancelResultSchema = RuntimeOAuthAttemptEffectResultSchema
  .superRefine((result, context) => {
    if (!RuntimeOAuthAttemptTerminalPhases.has(result.record.phase)) {
      context.addIssue({
        code: "custom",
        path: ["record", "phase"],
        message: "OAuth cancellation must return a terminal durable record",
      });
    }
  });
export type RuntimeOAuthAttemptCancelResult = z.infer<typeof RuntimeOAuthAttemptCancelResultSchema>;

/** Acknowledgement returns only the exact terminal successor carrying its receipt time. */
export const RuntimeOAuthAttemptAcknowledgeResultSchema = RuntimeOAuthAttemptEffectResultSchema
  .superRefine((result, context) => {
    if (!RuntimeOAuthAttemptTerminalPhases.has(result.record.phase) || !result.record.desktopAcknowledgedAt) {
      context.addIssue({
        code: "custom",
        path: ["record", "desktopAcknowledgedAt"],
        message: "OAuth acknowledgement must return an acknowledged terminal record",
      });
    }
  });
export type RuntimeOAuthAttemptAcknowledgeResult = z.infer<
  typeof RuntimeOAuthAttemptAcknowledgeResultSchema
>;

function runtimeOAuthAttemptResultIssues(result: {
  attemptDigest: string;
  record: RuntimeOAuthAttemptRecord | null;
  live?: RuntimeOAuthSessionSnapshot;
}): Array<{ path: Array<string | number>; message: string }> {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  if (!result.record) {
    if (result.live !== undefined) {
      issues.push({ path: ["live"], message: "An absent OAuth attempt cannot expose a live session" });
    }
    return issues;
  }
  if (result.attemptDigest !== result.record.attempt.attemptDigest) {
    issues.push({ path: ["attemptDigest"], message: "OAuth result digest does not bind its record" });
  }
  if (!result.live) return issues;
  if (
    result.live.sessionId !== result.record.sessionId ||
    result.live.providerId !== result.record.attempt.identity.providerId ||
    result.live.expiresAt !== result.record.expiresAt
  ) {
    issues.push({ path: ["live"], message: "Live OAuth session is cross-fed from another durable record" });
  }
  if (!runtimeOAuthLivePhaseMatchesRecord(result.record.phase, result.live.phase)) {
    issues.push({ path: ["live", "phase"], message: "Live OAuth phase contradicts the durable record" });
  }
  if (!runtimeOAuthLiveShapeMatchesPhase(result.live)) {
    issues.push({ path: ["live"], message: "Live OAuth fields contradict its session phase" });
  }
  return issues;
}

function runtimeOAuthLivePhaseMatchesRecord(
  recordPhase: RuntimeOAuthAttemptRecordPhase,
  livePhase: RuntimeOAuthSessionSnapshot["phase"],
): boolean {
  switch (recordPhase) {
    case "login_dispatching":
      return livePhase === "starting" || livePhase === "awaiting_user";
    case "credentials_ready":
    case "persistence_dispatching":
      return livePhase === "committing";
    case "cancelling":
      return livePhase === "starting" || livePhase === "awaiting_user";
    case "completed":
    case "cancelled":
    case "failed":
      return livePhase === recordPhase;
    case "prepared":
    case "recovery_required":
    case "outcome_unknown":
      return false;
  }
}

function runtimeOAuthLiveShapeMatchesPhase(live: RuntimeOAuthSessionSnapshot): boolean {
  const hasInteractiveState =
    live.authorization !== undefined || live.challenge !== undefined || live.progress !== undefined;
  switch (live.phase) {
    case "starting":
    case "awaiting_user":
      return live.configured === undefined && live.error === undefined;
    case "committing":
      return live.configured === undefined && live.error === undefined && live.challenge === undefined;
    case "completed":
      return live.configured === true && live.error === undefined && !hasInteractiveState;
    case "cancelled":
      return live.configured === undefined && live.error === undefined && !hasInteractiveState;
    case "failed":
      return live.configured === undefined && live.error !== undefined && !hasInteractiveState;
  }
}

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

export const REMOTE_DEVICE_SCOPES = Object.freeze([
  "projection.read",
  "thread.follow_up",
  "thread.steer",
  "thread.abort",
  "thread.start",
  "model.select",
  "approval.resolve",
  "run_location.change",
  "host.admin",
] as const);
export type RemoteDeviceScope = (typeof REMOTE_DEVICE_SCOPES)[number];
export const REMOTE_DEVICE_SCOPE_COUNT = REMOTE_DEVICE_SCOPES.length;
export const RemoteDeviceScopeSchema = z.enum(REMOTE_DEVICE_SCOPES);

export const RemoteDeviceScopesSchema = z
  .array(RemoteDeviceScopeSchema)
  .min(1)
  .max(REMOTE_DEVICE_SCOPE_COUNT)
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
    const advertisesRuntimeIntegrityRepair = health.capabilities.includes(
      RUNTIME_INTEGRITY_REPAIR_CAPABILITY,
    );
    if (
      advertisesRuntimeIntegrityRepair &&
      (
        health.runtimeIntegrity?.status !== "failed" ||
        health.runtimeIntegrity.retryable ||
        health.runtimeIntegrity.recoveryAction !== "repair_application" ||
        (health.runtimeIntegrity.code !== "RUNTIME_REPAIR_REQUIRED" &&
          health.runtimeIntegrity.code !== "RUNTIME_INSTALLED_CORRUPTION")
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: `${RUNTIME_INTEGRITY_REPAIR_CAPABILITY} requires an eligible nonretryable installed-runtime failure`,
      });
    }
    if (advertisesRuntimeIntegrityRetry && advertisesRuntimeIntegrityRepair) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Runtime integrity retry and repair capabilities are mutually exclusive",
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
 * Path-free provisioning envelope for an exact saved workspace already owned
 * by this host. The private path is resolved only from the reference thread's
 * durable workspace authority and never crosses the SSH bridge.
 */
export const ResidentRegisteredWorkspaceProvisionRequestSchema = z
  .object({
    expectedHostId: IdSchema,
    operationId: IdSchema,
    projectId: IdSchema,
    workspaceId: IdSchema,
    referenceThreadId: IdSchema,
    referenceExecutionGenerationId: IdSchema,
    threadId: IdSchema,
    executionGenerationId: IdSchema,
    threadTitle: z.string().trim().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
    createdAt: IsoDateTimeSchema,
    sessionName: z.string().trim().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)).optional(),
  })
  .strict();
export type ResidentRegisteredWorkspaceProvisionRequest = z.infer<
  typeof ResidentRegisteredWorkspaceProvisionRequestSchema
>;

/**
 * Path-free trusted-desktop or verified-SSH request to end one exact resident
 * binding. Upstream session identities remain private to the host Store and
 * verified adapter.
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

export const RuntimeOAuthAttemptStartRequestSchema = z
  .object({
    authorityId: IdSchema,
    attempt: RuntimeOAuthAttemptV1Schema,
  })
  .strict();
export type RuntimeOAuthAttemptStartRequest = z.infer<typeof RuntimeOAuthAttemptStartRequestSchema>;

export const RuntimeOAuthAttemptReadRequestSchema = z
  .object({ attempt: RuntimeOAuthAttemptV1Schema })
  .strict();
export type RuntimeOAuthAttemptReadRequest = z.infer<typeof RuntimeOAuthAttemptReadRequestSchema>;

export const RuntimeOAuthAttemptAcknowledgeRequestSchema = z
  .object({
    attempt: RuntimeOAuthAttemptV1Schema,
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
    terminalDigest: RuntimeOAuthDigestSchema,
    acknowledgedAt: RuntimeOAuthCanonicalTimestampSchema,
  })
  .strict();
export type RuntimeOAuthAttemptAcknowledgeRequest = z.infer<
  typeof RuntimeOAuthAttemptAcknowledgeRequestSchema
>;

const RequestBase = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: IdSchema,
};

export const HostIpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ ...RequestBase, method: z.literal("health.get"), payload: z.object({}) }),
  z.object({
    ...RequestBase,
    method: z.literal("candidate.evaluation.preflight"),
    payload: CandidateEvaluationPreflightRequestSchema,
  }),
  z.object({
    ...RequestBase,
    method: z.literal("candidate.evaluation.start"),
    payload: CandidateEvaluationStartRequestSchema,
  }),
  z.object({
    ...RequestBase,
    method: z.literal("candidate.evaluation.snapshot"),
    payload: CandidateEvaluationPreflightRequestSchema,
  }),
  z.object({
    ...RequestBase,
    method: z.literal("runtime.integrity.retry"),
    payload: z.object({ expectedHostId: IdSchema }).strict(),
  }),
  z.object({
    ...RequestBase,
    method: z.literal("runtime.integrity.repair"),
    payload: z.object({
      expectedHostId: IdSchema,
      expectedTrustAnchorId: RuntimeIntegrityTrustAnchorIdSchema,
      expectedTarget: RuntimeIntegrityTargetSchema,
      expectedChangedAt: IsoDateTimeSchema,
    }).strict(),
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
      .object({ expectedHostId: IdSchema, authorityId: IdSchema, providerId: IdSchema, operationId: IdSchema })
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
  z
    .object({
      ...RequestBase,
      method: z.literal("oauth.attempt.start"),
      payload: RuntimeOAuthAttemptStartRequestSchema,
    })
    .strict(),
  z
    .object({
      ...RequestBase,
      method: z.literal("oauth.attempt.status"),
      payload: RuntimeOAuthAttemptReadRequestSchema,
    })
    .strict(),
  z
    .object({
      ...RequestBase,
      method: z.literal("oauth.attempt.cancel"),
      payload: RuntimeOAuthAttemptReadRequestSchema,
    })
    .strict(),
  z
    .object({
      ...RequestBase,
      method: z.literal("oauth.attempt.acknowledge"),
      payload: RuntimeOAuthAttemptAcknowledgeRequestSchema,
    })
    .strict(),
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
    method: z.literal("thread.control.snapshot"),
    payload: z
      .object({
        expectedHostId: IdSchema,
        threadId: IdSchema,
        expectedExecutionGenerationId: IdSchema,
      })
      .strict(),
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
    method: z.literal("resident.provision.registered"),
    payload: ResidentRegisteredWorkspaceProvisionRequestSchema,
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
    method: z.literal("candidate.evaluation.preflight"),
    result: CandidateEvaluationPreflightSchema,
  }),
  z.object({
    ...SuccessBase,
    method: z.literal("candidate.evaluation.start"),
    result: CandidateEvaluationStatusSchema,
  }),
  z.object({
    ...SuccessBase,
    method: z.literal("candidate.evaluation.snapshot"),
    result: CandidateEvaluationSnapshotSchema,
  }),
  z.object({
    ...SuccessBase,
    method: z.literal("runtime.integrity.retry"),
    result: RuntimeIntegritySnapshotSchema,
  }),
  z.object({
    ...SuccessBase,
    method: z.literal("runtime.integrity.repair"),
    result: RuntimeIntegritySnapshotSchema,
  }),
  z.object({ ...SuccessBase, method: z.literal("runtime.model_catalog"), result: RuntimeModelCatalogSnapshotSchema }),
  z.object({ ...SuccessBase, method: z.literal("oauth.session.start"), result: RuntimeOAuthSessionSnapshotSchema }),
  z.object({ ...SuccessBase, method: z.literal("oauth.session.status"), result: RuntimeOAuthSessionSnapshotSchema }),
  z.object({ ...SuccessBase, method: z.literal("oauth.session.cancel"), result: RuntimeOAuthSessionSnapshotSchema }),
  z
    .object({
      ...SuccessBase,
      method: z.literal("oauth.attempt.start"),
      result: RuntimeOAuthAttemptStartResultSchema,
    })
    .strict(),
  z
    .object({
      ...SuccessBase,
      method: z.literal("oauth.attempt.status"),
      result: RuntimeOAuthAttemptStatusResultSchema,
    })
    .strict(),
  z
    .object({
      ...SuccessBase,
      method: z.literal("oauth.attempt.cancel"),
      result: RuntimeOAuthAttemptCancelResultSchema,
    })
    .strict(),
  z
    .object({
      ...SuccessBase,
      method: z.literal("oauth.attempt.acknowledge"),
      result: RuntimeOAuthAttemptAcknowledgeResultSchema,
    })
    .strict(),
  z.object({ ...SuccessBase, method: z.literal("catalog.snapshot"), result: CatalogProjectionSnapshotSchema }),
  z.object({ ...SuccessBase, method: z.literal("thread.snapshot"), result: ThreadProjectionSnapshotSchema }),
  z.object({
    ...SuccessBase,
    method: z.literal("thread.control.snapshot"),
    result: ResidentControlProjectionSnapshotSchema,
  }),
  z.object({ ...SuccessBase, method: z.literal("command.submit"), result: CommandReceiptSchema }),
  z.object({ ...SuccessBase, method: z.literal("command.reconcile"), result: CommandReconciliationSchema }),
  z.object({ ...SuccessBase, method: z.literal("resident.provision"), result: ResidentLifecycleStatusSchema }),
  z.object({
    ...SuccessBase,
    method: z.literal("resident.provision.registered"),
    result: ResidentLifecycleStatusSchema,
  }),
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
    "candidate.evaluation.preflight",
    "candidate.evaluation.start",
    "candidate.evaluation.snapshot",
    "runtime.integrity.retry",
    "runtime.integrity.repair",
    "runtime.model_catalog",
    "oauth.session.start",
    "oauth.session.status",
    "oauth.session.cancel",
    "oauth.attempt.start",
    "oauth.attempt.status",
    "oauth.attempt.cancel",
    "oauth.attempt.acknowledge",
    "catalog.snapshot",
    "thread.snapshot",
    "thread.control.snapshot",
    "command.submit",
    "command.reconcile",
    "resident.provision",
    "resident.provision.registered",
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
