import { createHash, randomUUID } from "node:crypto";
import { hostname, platform as nodePlatform, arch, release, totalmem, freemem } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  CatalogProjectionSnapshotSchema,
  CommandEnvelopeSchema,
  CommandReceiptSchema,
  CommandReceiptStatusSchema,
  HandoffPlanRequestSchema,
  HandoffPlanSchema,
  HandoffProgressSchema,
  HandoffReceiptSchema,
  HostSummarySchema,
  IdSchema,
  IsoDateTimeSchema,
  PROTOCOL_VERSION,
  RunLocationSchema,
  SavedProjectSchema,
  SessionCursorSchema,
  SNAPSHOT_VERSION,
  StructuredErrorSchema,
  ThreadProjectionSnapshotSchema,
  ThreadSummarySchema,
  type CatalogProjectionSnapshot,
  type CommandEnvelope,
  type CommandIdentity,
  type CommandReceipt,
  type CommandReceiptStatus,
  type HandoffPlan,
  type HandoffPlanRequest,
  type HandoffProgress,
  type HandoffReceipt,
  type HostSummary,
  type SavedProject,
  type StructuredError,
  type ThreadProjectionSnapshot,
  type ThreadSummary,
} from "../shared/protocol";
import {
  AtomicWriteAmbiguousCommitError,
  appendJsonLine,
  appendJsonLineOnce,
  atomicWriteJson,
  atomicWriteJsonIfAbsent,
  ensurePrivateDirectory,
  readJsonFile,
} from "./atomic-files";
import { getHostDataPaths, type HostDataPaths } from "./paths";
import type { ResidentProjectionSnapshot } from "./resident-projection";
import {
  ResidentSessionBindingSchema,
  validateResidentSessionBinding,
  type ResidentAbortIdleAuthorityEvidence,
  type ResidentPromptIdleAuthorityEvidence,
  type ResidentSessionBinding,
} from "./resident-runtime";

const HostFileSchema = z.object({ version: z.literal(1), host: HostSummarySchema });
const ProjectFileSchema = z.object({ version: z.literal(1), projects: z.array(SavedProjectSchema).max(10_000) });
const ThreadFileSchema = z.object({ version: z.literal(1), threads: z.array(ThreadSummarySchema).max(10_000) });

export const MAX_WORKSPACE_AUTHORITIES = 10_000;
export const MAX_RESIDENT_SESSION_BINDINGS = 10_000;
export const MAX_WORKSPACE_AUTHORITY_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_RESIDENT_SESSION_BINDING_FILE_BYTES = 64 * 1024 * 1024;

const WorkspaceDirectorySchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !/[\0\r\n]/.test(value), "Workspace path must not contain control characters")
  .refine((value) => isAbsolute(value), "Workspace path must be absolute");

export const WorkspaceAuthorityRegistrationSchema = z
  .object({
    threadId: IdSchema,
    executionGenerationId: IdSchema,
    workspaceDirectory: WorkspaceDirectorySchema,
  })
  .strict();
export type WorkspaceAuthorityRegistration = z.infer<typeof WorkspaceAuthorityRegistrationSchema>;

interface CurrentWorkspaceScope {
  readonly hostId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly executionGenerationId: string;
}

const WorkspaceAuthoritySchema = z
  .object({
    authorityVersion: z.literal(1),
    hostId: IdSchema,
    projectId: IdSchema,
    workspaceId: IdSchema,
    threadId: IdSchema,
    executionGenerationId: IdSchema,
    workspaceDirectory: WorkspaceDirectorySchema,
    registeredAt: IsoDateTimeSchema,
  })
  .strict();
type WorkspaceAuthority = z.infer<typeof WorkspaceAuthoritySchema>;

const WorkspaceAuthorityFileSchema = z
  .object({
    version: z.literal(1),
    authorities: z.array(WorkspaceAuthoritySchema).max(MAX_WORKSPACE_AUTHORITIES),
  })
  .strict()
  .superRefine((file, context) => {
    const threadIds = new Set<string>();
    for (const [index, authority] of file.authorities.entries()) {
      if (threadIds.has(authority.threadId)) {
        context.addIssue({
          code: "custom",
          path: ["authorities", index, "threadId"],
          message: "A thread may have only one workspace authority",
        });
      }
      threadIds.add(authority.threadId);
    }
  });

export const MAX_RESIDENT_LIFECYCLE_OPERATIONS = 10_000;
export const MAX_RESIDENT_LIFECYCLE_OPERATION_BYTES = 2 * 1024 * 1024;

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ResidentLifecycleOperationInputSchema = z
  .object({
    operationId: IdSchema,
    expectedHostId: IdSchema,
    projectId: IdSchema,
    workspaceId: IdSchema,
    threadId: IdSchema,
    executionGenerationId: IdSchema,
    requestDigest: Sha256DigestSchema,
  })
  .strict();
export type ResidentLifecycleOperationInput = z.infer<typeof ResidentLifecycleOperationInputSchema>;

export const ResidentOwnedSessionCandidateSchema = ResidentSessionBindingSchema.pick({
  workspaceDirectory: true,
  activeSessionId: true,
  sessionId: true,
  sessionFile: true,
  runtime: true,
})
  .extend({
    candidateVersion: z.literal(1),
    boundAt: IsoDateTimeSchema,
  })
  .strict();
export type ResidentOwnedSessionCandidate = z.infer<typeof ResidentOwnedSessionCandidateSchema>;

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

const ResidentLifecycleKindSchema = z.enum(["provision", "end", "detach"]);
export type ResidentLifecycleKind = z.infer<typeof ResidentLifecycleKindSchema>;

const ResidentLifecycleQuarantineReasonSchema = z.enum([
  "external_outcome_unknown",
  "authority_changed",
  "explicit_reconciliation_required",
  "owned_client_lost",
]);
const ResidentLifecycleCompletionReasonSchema = z.enum([
  "owned_create_failed_before_effect",
  "owned_create_cleaned",
]);

const ResidentLifecycleAuthoritySchema = WorkspaceAuthoritySchema.extend({
  authorityDigest: Sha256DigestSchema,
}).strict();
type ResidentLifecycleAuthority = z.infer<typeof ResidentLifecycleAuthoritySchema>;

const ResidentLifecycleProjectionProofSchema = z
  .object({
    bindingFingerprint: Sha256DigestSchema,
    projectionDigest: Sha256DigestSchema,
    cursorGeneration: IdSchema,
    cursorSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    publishedAt: IsoDateTimeSchema,
  })
  .strict();
type ResidentLifecycleProjectionProof = z.infer<typeof ResidentLifecycleProjectionProofSchema>;

const ResidentLifecycleOperationRecordSchema = z
  .object({
    version: z.literal(1),
    kind: ResidentLifecycleKindSchema,
    operationId: IdSchema,
    input: ResidentLifecycleOperationInputSchema,
    operationFingerprint: Sha256DigestSchema,
    authority: ResidentLifecycleAuthoritySchema,
    phase: ResidentLifecyclePhaseSchema,
    preparedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    binding: ResidentSessionBindingSchema.optional(),
    projectionProof: ResidentLifecycleProjectionProofSchema.optional(),
    quarantinedFrom: z.enum([
      "prepared",
      "owned_create_dispatching",
      "owned_observed",
      "promotion_dispatching",
      "promoted_observed",
      "projection_committed",
      "ending",
      "kill_dispatching",
      "kill_acknowledged",
    ]).optional(),
    quarantineReason: ResidentLifecycleQuarantineReasonSchema.optional(),
    completionReason: ResidentLifecycleCompletionReasonSchema.optional(),
    terminalAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.operationId !== record.input.operationId ||
      record.operationFingerprint !==
        residentLifecycleOperationFingerprint(record.kind, record.input, record.authority.authorityDigest) ||
      record.authority.authorityDigest !== residentLifecycleAuthorityDigest(record.authority) ||
      record.input.expectedHostId !== record.authority.hostId ||
      record.input.projectId !== record.authority.projectId ||
      record.input.workspaceId !== record.authority.workspaceId ||
      record.input.threadId !== record.authority.threadId ||
      record.input.executionGenerationId !== record.authority.executionGenerationId
    ) {
      context.addIssue({ code: "custom", message: "Resident lifecycle operation authority changed" });
    }
    if (Date.parse(record.updatedAt) < Date.parse(record.preparedAt)) {
      context.addIssue({ code: "custom", path: ["updatedAt"], message: "Lifecycle update cannot precede preparation" });
    }
    const provisionPhases = new Set<ResidentLifecyclePhase>([
      "prepared",
      "owned_create_dispatching",
      "owned_observed",
      "promotion_dispatching",
      "promoted_observed",
      "projection_committed",
      "committed",
      "completed",
      "quarantined",
    ]);
    const endPhases = new Set<ResidentLifecyclePhase>([
      "ending",
      "kill_dispatching",
      "kill_acknowledged",
      "completed",
      "quarantined",
    ]);
    if (
      (record.kind === "provision" && !provisionPhases.has(record.phase)) ||
      (record.kind === "end" && !endPhases.has(record.phase)) ||
      (record.kind === "detach" && record.phase !== "detached")
    ) {
      context.addIssue({ code: "custom", path: ["phase"], message: "Lifecycle phase does not belong to its operation" });
    }
    if (
      record.phase === "quarantined" &&
      ((record.kind === "provision" &&
        ![
          "prepared",
          "owned_create_dispatching",
          "owned_observed",
          "promotion_dispatching",
          "promoted_observed",
          "projection_committed",
        ].includes(record.quarantinedFrom ?? "")) ||
        (record.kind === "end" &&
          !["ending", "kill_dispatching", "kill_acknowledged"].includes(record.quarantinedFrom ?? "")) ||
        record.kind === "detach")
    ) {
      context.addIssue({
        code: "custom",
        path: ["quarantinedFrom"],
        message: "Lifecycle quarantine origin does not belong to its operation",
      });
    }
    const provisionPhaseHasNoBinding =
      record.kind === "provision" &&
      (record.phase === "prepared" ||
        record.phase === "owned_create_dispatching" ||
        record.phase === "completed" ||
        (record.phase === "quarantined" &&
          (record.quarantinedFrom === "prepared" || record.quarantinedFrom === "owned_create_dispatching")));
    const bindingRequired = record.kind !== "provision" || !provisionPhaseHasNoBinding;
    if (bindingRequired !== (record.binding !== undefined)) {
      context.addIssue({ code: "custom", path: ["binding"], message: "Lifecycle binding does not match its phase" });
    }
    if (
      record.binding &&
      (record.binding.threadId !== record.input.threadId ||
        record.binding.executionGenerationId !== record.input.executionGenerationId ||
        !sameCanonicalPath(record.binding.workspaceDirectory, record.authority.workspaceDirectory))
    ) {
      context.addIssue({ code: "custom", path: ["binding"], message: "Lifecycle binding changed its exact authority" });
    }
    const proofRequired =
      record.phase === "projection_committed" ||
      record.phase === "committed" ||
      (record.phase === "quarantined" && record.quarantinedFrom === "projection_committed");
    if (proofRequired !== (record.projectionProof !== undefined)) {
      context.addIssue({ code: "custom", path: ["projectionProof"], message: "Projection proof does not match lifecycle phase" });
    }
    if (
      record.projectionProof &&
      record.binding &&
      record.projectionProof.bindingFingerprint !== residentDispatchAuthorityFingerprint(record.binding)
    ) {
      context.addIssue({ code: "custom", path: ["projectionProof"], message: "Projection proof changed its binding" });
    }
    const quarantined = record.phase === "quarantined";
    if (quarantined !== (record.quarantinedFrom !== undefined && record.quarantineReason !== undefined)) {
      context.addIssue({ code: "custom", message: "Lifecycle quarantine metadata is incomplete" });
    }
    if (
      (record.quarantineReason === "owned_client_lost" && record.quarantinedFrom !== "owned_observed") ||
      (record.quarantineReason === "external_outcome_unknown" &&
        record.quarantinedFrom !== "owned_create_dispatching" &&
        record.quarantinedFrom !== "promotion_dispatching" &&
        record.quarantinedFrom !== "kill_dispatching")
    ) {
      context.addIssue({
        code: "custom",
        path: ["quarantineReason"],
        message: "Lifecycle quarantine reason does not match its exact origin",
      });
    }
    const terminal = record.phase === "committed" || record.phase === "completed" || record.phase === "detached";
    if (terminal !== (record.terminalAt !== undefined)) {
      context.addIssue({ code: "custom", path: ["terminalAt"], message: "Lifecycle terminal time does not match its phase" });
    }
    const completedOwnedCreate =
      record.kind === "provision" &&
      record.phase === "completed" &&
      (record.completionReason === "owned_create_failed_before_effect" ||
        record.completionReason === "owned_create_cleaned");
    if (completedOwnedCreate !== (record.completionReason !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["completionReason"],
        message: "Lifecycle completion reason does not match its terminal operation",
      });
    }
  });
type ResidentLifecycleOperationRecord = z.infer<typeof ResidentLifecycleOperationRecordSchema>;

export interface ResidentLifecycleStatus {
  readonly version: 1;
  readonly kind: ResidentLifecycleKind;
  readonly operationId: string;
  readonly phase: ResidentLifecyclePhase;
  readonly expectedHostId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly executionGenerationId: string;
  readonly preparedAt: string;
  readonly updatedAt: string;
  readonly quarantinedFrom?: Exclude<ResidentLifecyclePhase, "committed" | "completed" | "detached" | "quarantined">;
  readonly quarantineReason?: z.infer<typeof ResidentLifecycleQuarantineReasonSchema>;
  readonly completionReason?: z.infer<typeof ResidentLifecycleCompletionReasonSchema>;
  readonly terminalAt?: string;
}

const residentOwnedCreateLeaseBrand: unique symbol = Symbol("resident-owned-create-lease");
const residentPromotionLeaseBrand: unique symbol = Symbol("resident-promotion-lease");
const residentLifecycleProjectionLeaseBrand: unique symbol = Symbol("resident-lifecycle-projection-lease");
const residentKillLeaseBrand: unique symbol = Symbol("resident-kill-lease");

export interface ResidentOwnedCreateLease {
  readonly [residentOwnedCreateLeaseBrand]: true;
  readonly leaseVersion: 1;
  readonly operationId: string;
  readonly operationFingerprint: string;
  readonly dispatchStartedAt: string;
}

export interface ResidentPromotionLease {
  readonly [residentPromotionLeaseBrand]: true;
  readonly leaseVersion: 1;
  readonly operationId: string;
  readonly operationFingerprint: string;
  readonly binding: ResidentSessionBinding;
  readonly dispatchStartedAt: string;
}

/**
 * The only authority that can publish a projection for an activating binding.
 * It can be recovered after restart only from durable post-promotion state;
 * no external mutation is authorized by this lease.
 */
export interface ResidentLifecycleProjectionLease {
  readonly [residentLifecycleProjectionLeaseBrand]: true;
  readonly leaseVersion: 1;
  readonly operationId: string;
  readonly operationFingerprint: string;
  readonly binding: ResidentSessionBinding;
  readonly promotionObservedAt: string;
}

export interface ResidentKillLease {
  readonly [residentKillLeaseBrand]: true;
  readonly leaseVersion: 1;
  readonly operationId: string;
  readonly operationFingerprint: string;
  readonly binding: ResidentSessionBinding;
  readonly dispatchStartedAt: string;
}

const ResidentSessionBindingRecordSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("activating"),
      binding: ResidentSessionBindingSchema,
      operationId: IdSchema,
      observedAt: IsoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("active"),
      binding: ResidentSessionBindingSchema,
      operationId: IdSchema.optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal("completed"),
      binding: ResidentSessionBindingSchema,
      operationId: IdSchema.optional(),
      completedAt: IsoDateTimeSchema,
    })
    .strict()
    .refine((record) => Date.parse(record.completedAt) >= Date.parse(record.binding.boundAt), {
      path: ["completedAt"],
      message: "Completion cannot precede the resident binding",
    }),
  z
    .object({
      state: z.literal("detached"),
      binding: ResidentSessionBindingSchema,
      operationId: IdSchema,
      detachedAt: IsoDateTimeSchema,
      reason: z.enum(["explicit", "ending"]),
    })
    .strict()
    .refine((record) => Date.parse(record.detachedAt) >= Date.parse(record.binding.boundAt), {
      path: ["detachedAt"],
      message: "Detachment cannot precede the resident binding",
    }),
]);
type ResidentSessionBindingRecord = z.infer<typeof ResidentSessionBindingRecordSchema>;

const ResidentSessionBindingFileSchema = z
  .object({
    version: z.literal(1),
    records: z.array(ResidentSessionBindingRecordSchema).max(MAX_RESIDENT_SESSION_BINDINGS),
  })
  .strict()
  .superRefine((file, context) => {
    const activeThreadIds = new Set<string>();
    const activeSessionIds = new Set<string>();
    const sessionIds = new Set<string>();
    const sessionFiles = new Set<string>();
    for (const [index, record] of file.records.entries()) {
      const binding = record.binding;
      const uniqueValues: ReadonlyArray<readonly [string, string | undefined, Set<string>]> = [
        ["activeSessionId", binding.activeSessionId, activeSessionIds],
        ["sessionId", binding.sessionId, sessionIds],
        ["sessionFile", binding.sessionFile, sessionFiles],
      ];
      for (const [field, value, seen] of uniqueValues) {
        if (value === undefined) continue;
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            path: ["records", index, "binding", field],
            message: `Resident ${field} must not be reused by another binding`,
          });
        }
        seen.add(value);
      }
      if (record.state === "active" || record.state === "activating") {
        if (activeThreadIds.has(binding.threadId)) {
          context.addIssue({
            code: "custom",
            path: ["records", index, "binding", "threadId"],
            message: "A thread may have only one active resident binding",
          });
        }
        activeThreadIds.add(binding.threadId);
      }
    }
  });

const HandoffRecordSchema = z.object({
  version: z.literal(1),
  plan: HandoffPlanSchema,
  progress: z.array(HandoffProgressSchema).max(16),
  receipt: HandoffReceiptSchema.optional(),
});
type HandoffRecord = z.infer<typeof HandoffRecordSchema>;

const HandoffCheckpointSchema = z.object({
  version: z.literal(1),
  checkpointId: IdSchema,
  handoffId: IdSchema,
  createdAt: IsoDateTimeSchema,
  source: RunLocationSchema,
  snapshot: ThreadProjectionSnapshotSchema,
});
export type HandoffCheckpoint = z.infer<typeof HandoffCheckpointSchema>;

/**
 * Protocol v1 originally admitted generation-less existing-thread commands.
 * Keep that shape private to durable-history recovery; it must never be used
 * by a live request boundary.
 */
const LegacyCommandEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    deviceId: IdSchema,
    commandId: IdSchema,
    expectedHostId: IdSchema,
    threadId: IdSchema,
    issuedAt: IsoDateTimeSchema,
    expectedExecutionGenerationId: IdSchema.optional(),
    command: CommandEnvelopeSchema.shape.command,
  })
  .strict();
type LegacyCommandEnvelope = z.infer<typeof LegacyCommandEnvelopeSchema>;

const HistoricalCommandEnvelopeSchema = z.union([CommandEnvelopeSchema, LegacyCommandEnvelopeSchema]);

const CommandJournalRecordSchema = z.object({
  version: z.literal(1),
  journalId: IdSchema,
  recordedAt: IsoDateTimeSchema,
  deviceId: IdSchema,
  commandId: IdSchema,
  threadId: IdSchema,
  commandKind: z.string().min(1).max(64),
  status: CommandReceiptStatusSchema,
  message: z.string().max(2_048).optional(),
  // Historical audit records remain parseable after the live protocol fence
  // became mandatory. A legacy envelope is evidence only, never dispatchable.
  envelope: HistoricalCommandEnvelopeSchema.optional(),
});

const CommandIdentityRecordSchema = z
  .object({
    version: z.literal(1),
    command: CommandEnvelopeSchema,
    recordedAt: IsoDateTimeSchema,
  })
  .strict();
type CommandIdentityRecord = z.infer<typeof CommandIdentityRecordSchema>;

const ResidentDispatchCommandSchema = CommandEnvelopeSchema.refine(
  (command) => command.command.kind === "prompt" || command.command.kind === "abort",
  "Resident dispatch accepts only prompt and abort envelopes",
);

const ResidentPromptCommandSchema = CommandEnvelopeSchema.refine(
  (command) => command.command.kind === "prompt",
  "Resident prompt reconciliation accepts only prompt envelopes",
);

const ResidentAbortCommandSchema = CommandEnvelopeSchema.refine(
  (command) => command.command.kind === "abort",
  "Resident abort reconciliation accepts only abort envelopes",
);

export const ResidentPromptIdleObservedEventSchema = z
  .object({
    eventVersion: z.literal(1),
    attemptId: IdSchema,
    observedAt: IsoDateTimeSchema,
    command: ResidentPromptCommandSchema,
    acknowledgedReceipt: CommandReceiptSchema,
    receipt: CommandReceiptSchema,
    binding: ResidentSessionBindingSchema,
    bindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    observedCursor: SessionCursorSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.attemptId !== deterministicId("resident-dispatch", event.command.deviceId, event.command.commandId) ||
      event.receipt.deviceId !== event.command.deviceId ||
      event.receipt.commandId !== event.command.commandId ||
      event.receipt.threadId !== event.command.threadId ||
      event.receipt.executionGenerationId !== event.command.expectedExecutionGenerationId ||
      event.acknowledgedReceipt.deviceId !== event.command.deviceId ||
      event.acknowledgedReceipt.commandId !== event.command.commandId ||
      event.acknowledgedReceipt.threadId !== event.command.threadId ||
      event.acknowledgedReceipt.executionGenerationId !== event.command.expectedExecutionGenerationId ||
      event.acknowledgedReceipt.status !== "running" ||
      event.acknowledgedReceipt.receiptId !== event.receipt.receiptId ||
      event.acknowledgedReceipt.receivedAt !== event.receipt.receivedAt ||
      event.acknowledgedReceipt.queuePosition !== undefined ||
      event.acknowledgedReceipt.error !== undefined ||
      event.receipt.status !== "completed" ||
      event.receipt.updatedAt !== event.observedAt ||
      Date.parse(event.acknowledgedReceipt.updatedAt) > Date.parse(event.observedAt) ||
      event.bindingFingerprint !== residentDispatchAuthorityFingerprint(event.binding) ||
      event.binding.threadId !== event.command.threadId ||
      event.binding.executionGenerationId !== event.command.expectedExecutionGenerationId ||
      event.observedCursor.threadId !== event.command.threadId ||
      event.observedCursor.executionGenerationId !== event.command.expectedExecutionGenerationId
    ) {
      context.addIssue({
        code: "custom",
        message: "Resident prompt idle observation does not match one exact prompt, receipt, and binding",
      });
    }
  });
export type ResidentPromptIdleObservedEvent = z.infer<typeof ResidentPromptIdleObservedEventSchema>;

export const ResidentAbortIdleObservedEventSchema = z
  .object({
    eventVersion: z.literal(1),
    attemptId: IdSchema,
    observedAt: IsoDateTimeSchema,
    command: ResidentAbortCommandSchema,
    acknowledgedReceipt: CommandReceiptSchema,
    receipt: CommandReceiptSchema,
    binding: ResidentSessionBindingSchema,
    bindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    observedCursor: SessionCursorSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.attemptId !== deterministicId("resident-dispatch", event.command.deviceId, event.command.commandId) ||
      event.receipt.deviceId !== event.command.deviceId ||
      event.receipt.commandId !== event.command.commandId ||
      event.receipt.threadId !== event.command.threadId ||
      event.receipt.executionGenerationId !== event.command.expectedExecutionGenerationId ||
      event.acknowledgedReceipt.deviceId !== event.command.deviceId ||
      event.acknowledgedReceipt.commandId !== event.command.commandId ||
      event.acknowledgedReceipt.threadId !== event.command.threadId ||
      event.acknowledgedReceipt.executionGenerationId !== event.command.expectedExecutionGenerationId ||
      event.acknowledgedReceipt.status !== "running" ||
      event.acknowledgedReceipt.receiptId !== event.receipt.receiptId ||
      event.acknowledgedReceipt.receivedAt !== event.receipt.receivedAt ||
      event.acknowledgedReceipt.queuePosition !== undefined ||
      event.acknowledgedReceipt.error !== undefined ||
      event.receipt.status !== "completed" ||
      event.receipt.updatedAt !== event.observedAt ||
      Date.parse(event.acknowledgedReceipt.updatedAt) > Date.parse(event.observedAt) ||
      event.bindingFingerprint !== residentDispatchAuthorityFingerprint(event.binding) ||
      event.binding.threadId !== event.command.threadId ||
      event.binding.executionGenerationId !== event.command.expectedExecutionGenerationId ||
      event.observedCursor.threadId !== event.command.threadId ||
      event.observedCursor.executionGenerationId !== event.command.expectedExecutionGenerationId
    ) {
      context.addIssue({
        code: "custom",
        message: "Resident abort idle observation does not match one exact Stop, receipt, and binding",
      });
    }
  });
export type ResidentAbortIdleObservedEvent = z.infer<typeof ResidentAbortIdleObservedEventSchema>;

const ResidentDispatchAttemptSchema = z
  .object({
    version: z.literal(1),
    attemptId: IdSchema,
    command: ResidentDispatchCommandSchema,
    binding: ResidentSessionBindingSchema,
    bindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    admissionCursor: SessionCursorSchema,
    promptSettlementCursor: SessionCursorSchema.optional(),
    promptIdleObservation: ResidentPromptIdleObservedEventSchema.optional(),
    abortSettlementCursor: SessionCursorSchema.optional(),
    abortIdleObservation: ResidentAbortIdleObservedEventSchema.optional(),
    state: z.enum(["admitted", "dispatching", "settled"]),
    admittedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    dispatchStartedAt: IsoDateTimeSchema.optional(),
    settledAt: IsoDateTimeSchema.optional(),
    finalReceipt: CommandReceiptSchema.optional(),
  })
  .strict()
  .superRefine((attempt, context) => {
    const expectedAttemptId = deterministicId(
      "resident-dispatch",
      attempt.command.deviceId,
      attempt.command.commandId,
    );
    if (attempt.attemptId !== expectedAttemptId) {
      context.addIssue({ code: "custom", path: ["attemptId"], message: "Resident attempt identity changed" });
    }
    if (
      attempt.command.threadId !== attempt.binding.threadId ||
      attempt.command.expectedExecutionGenerationId !== attempt.binding.executionGenerationId
    ) {
      context.addIssue({ code: "custom", message: "Resident attempt does not match its exact session binding" });
    }
    if (
      attempt.admissionCursor.threadId !== attempt.command.threadId ||
      attempt.admissionCursor.executionGenerationId !== attempt.command.expectedExecutionGenerationId
    ) {
      context.addIssue({ code: "custom", path: ["admissionCursor"], message: "Admission cursor changed authority" });
    }
    if (
      attempt.promptSettlementCursor &&
      (attempt.promptSettlementCursor.threadId !== attempt.command.threadId ||
        attempt.promptSettlementCursor.executionGenerationId !== attempt.command.expectedExecutionGenerationId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["promptSettlementCursor"],
        message: "Prompt settlement cursor changed authority",
      });
    }
    if (
      attempt.abortSettlementCursor &&
      (attempt.abortSettlementCursor.threadId !== attempt.command.threadId ||
        attempt.abortSettlementCursor.executionGenerationId !== attempt.command.expectedExecutionGenerationId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["abortSettlementCursor"],
        message: "Abort settlement cursor changed authority",
      });
    }
    if (attempt.bindingFingerprint !== residentDispatchAuthorityFingerprint(attempt.binding)) {
      context.addIssue({ code: "custom", path: ["bindingFingerprint"], message: "Resident binding fingerprint changed" });
    }
    const dispatchStarted = attempt.dispatchStartedAt !== undefined;
    const settled = attempt.settledAt !== undefined || attempt.finalReceipt !== undefined;
    if (
      (attempt.state === "admitted" && dispatchStarted) ||
      (attempt.state === "dispatching" && !dispatchStarted)
    ) {
      context.addIssue({ code: "custom", path: ["dispatchStartedAt"], message: "Dispatch time must match attempt state" });
    }
    if ((attempt.state === "settled") !== settled || (attempt.settledAt === undefined) !== (attempt.finalReceipt === undefined)) {
      context.addIssue({ code: "custom", path: ["settledAt"], message: "Settlement evidence must match attempt state" });
    }
    if (attempt.finalReceipt) {
      if (
        attempt.finalReceipt.deviceId !== attempt.command.deviceId ||
        attempt.finalReceipt.commandId !== attempt.command.commandId ||
        attempt.finalReceipt.threadId !== attempt.command.threadId ||
        attempt.finalReceipt.executionGenerationId !== attempt.command.expectedExecutionGenerationId ||
        attempt.finalReceipt.status === "received" ||
        attempt.finalReceipt.status === "admitted" ||
        attempt.finalReceipt.status === "rejected" ||
        attempt.finalReceipt.status === "cancelled"
      ) {
        context.addIssue({ code: "custom", path: ["finalReceipt"], message: "Settled receipt is not an exact dispatch outcome" });
      }
      if (!attempt.dispatchStartedAt && attempt.finalReceipt.status !== "failed") {
        context.addIssue({
          code: "custom",
          path: ["finalReceipt", "status"],
          message: "A pre-dispatch settlement must be definitively failed",
        });
      }
    }
    const requiresPromptSettlementCursor =
      attempt.command.command.kind === "prompt" &&
      attempt.state === "settled" &&
      (attempt.finalReceipt?.status === "running" || attempt.finalReceipt?.status === "uncertain");
    if (requiresPromptSettlementCursor !== (attempt.promptSettlementCursor !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["promptSettlementCursor"],
        message: "A retained prompt lock requires its exact settlement cursor baseline",
      });
    }
    const requiresAbortSettlementCursor =
      attempt.command.command.kind === "abort" &&
      attempt.state === "settled" &&
      (attempt.finalReceipt?.status === "running" || attempt.finalReceipt?.status === "uncertain");
    if (requiresAbortSettlementCursor !== (attempt.abortSettlementCursor !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["abortSettlementCursor"],
        message: "An acknowledged Stop retained for idle proof requires its exact settlement cursor baseline",
      });
    }
    if (attempt.promptIdleObservation) {
      if (
        attempt.command.command.kind !== "prompt" ||
        attempt.state !== "settled" ||
        attempt.finalReceipt?.status !== "completed" ||
        !isDeepStrictEqual(attempt.promptIdleObservation.command, attempt.command) ||
        !isDeepStrictEqual(attempt.promptIdleObservation.receipt, attempt.finalReceipt) ||
        !isDeepStrictEqual(attempt.promptIdleObservation.binding, attempt.binding) ||
        attempt.promptIdleObservation.bindingFingerprint !== attempt.bindingFingerprint ||
        attempt.promptIdleObservation.attemptId !== attempt.attemptId ||
        attempt.promptIdleObservation.acknowledgedReceipt.updatedAt !== attempt.settledAt ||
        Date.parse(attempt.promptIdleObservation.observedAt) < Date.parse(attempt.settledAt ?? attempt.updatedAt)
      ) {
        context.addIssue({
          code: "custom",
          path: ["promptIdleObservation"],
          message: "Prompt idle observation must be the exact proof-backed completion of this settled prompt",
        });
      }
    }
    if (
      attempt.command.command.kind === "prompt" &&
      attempt.finalReceipt?.status === "completed" &&
      !attempt.promptIdleObservation
    ) {
      context.addIssue({
        code: "custom",
        path: ["promptIdleObservation"],
        message: "A completed prompt requires its dedicated durable idle-observation proof record",
      });
    }
    if (attempt.abortIdleObservation) {
      if (
        attempt.command.command.kind !== "abort" ||
        attempt.state !== "settled" ||
        attempt.finalReceipt?.status !== "completed" ||
        !isDeepStrictEqual(attempt.abortIdleObservation.command, attempt.command) ||
        !isDeepStrictEqual(attempt.abortIdleObservation.receipt, attempt.finalReceipt) ||
        !isDeepStrictEqual(attempt.abortIdleObservation.binding, attempt.binding) ||
        attempt.abortIdleObservation.bindingFingerprint !== attempt.bindingFingerprint ||
        attempt.abortIdleObservation.attemptId !== attempt.attemptId ||
        attempt.abortIdleObservation.acknowledgedReceipt.updatedAt !== attempt.settledAt ||
        Date.parse(attempt.abortIdleObservation.observedAt) < Date.parse(attempt.settledAt ?? attempt.updatedAt)
      ) {
        context.addIssue({
          code: "custom",
          path: ["abortIdleObservation"],
          message: "Abort idle observation must be the exact proof-backed completion of this acknowledged Stop",
        });
      }
    }
    if (
      attempt.command.command.kind === "abort" &&
      attempt.finalReceipt?.status === "completed" &&
      !attempt.abortIdleObservation
    ) {
      context.addIssue({
        code: "custom",
        path: ["abortIdleObservation"],
        message: "A completed Stop requires its dedicated durable idle-observation proof record",
      });
    }
  });
type ResidentDispatchAttempt = z.infer<typeof ResidentDispatchAttemptSchema>;

const residentDispatchLeaseBrand: unique symbol = Symbol("resident-dispatch-lease");

/**
 * Process-local proof that HostStore durably crossed one exact resident
 * dispatch boundary. Only HostStore can construct a valid branded instance.
 */
export interface ResidentDispatchLease {
  readonly [residentDispatchLeaseBrand]: true;
  readonly leaseVersion: 1;
  readonly attemptId: string;
  readonly command: CommandEnvelope;
  readonly binding: ResidentSessionBinding;
  readonly bindingFingerprint: string;
  readonly dispatchStartedAt: string;
}

const residentPromptReconciliationLeaseBrand: unique symbol = Symbol("resident-prompt-reconciliation-lease");

/**
 * Process-local, Store-issued authority for one already-settled acknowledged
 * prompt. It authorizes only a read-only Prime idle barrier and its exact
 * proof completion; it can never authorize another mutation or an uncertain
 * prompt outcome.
 */
export interface ResidentPromptReconciliationLease {
  readonly [residentPromptReconciliationLeaseBrand]: true;
  readonly leaseVersion: 1;
  readonly attemptId: string;
  readonly command: CommandEnvelope;
  readonly binding: ResidentSessionBinding;
  readonly bindingFingerprint: string;
  readonly dispatchStartedAt: string;
  readonly settledAt: string;
  readonly receiptUpdatedAt: string;
  readonly settlementCursor: z.infer<typeof SessionCursorSchema>;
}

const residentAbortReconciliationLeaseBrand: unique symbol = Symbol("resident-abort-reconciliation-lease");

/**
 * Process-local, Store-issued authority for the read-only idle proof that must
 * follow one definitively acknowledged Stop. The completed dispatch receipt
 * proves only request acceptance; this lease never authorizes another abort.
 */
export interface ResidentAbortReconciliationLease {
  readonly [residentAbortReconciliationLeaseBrand]: true;
  readonly leaseVersion: 1;
  readonly attemptId: string;
  readonly command: CommandEnvelope;
  readonly binding: ResidentSessionBinding;
  readonly bindingFingerprint: string;
  readonly dispatchStartedAt: string;
  readonly settledAt: string;
  readonly receiptUpdatedAt: string;
  readonly settlementCursor: z.infer<typeof SessionCursorSchema>;
}

const ModelSelectionAttemptSchema = z
  .object({
    version: z.literal(1),
    command: CommandEnvelopeSchema,
    binding: ResidentSessionBindingSchema,
    state: z.enum(["admitted", "dispatching"]),
    admittedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    dispatchStartedAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (attempt.command.command.kind !== "model.select") {
      context.addIssue({ code: "custom", path: ["command", "command"], message: "Attempt is not a model selection" });
    }
    if (
      attempt.command.threadId !== attempt.binding.threadId ||
      attempt.command.expectedExecutionGenerationId !== attempt.binding.executionGenerationId
    ) {
      context.addIssue({ code: "custom", message: "Model selection attempt does not match its resident binding" });
    }
    if ((attempt.state === "dispatching") !== (attempt.dispatchStartedAt !== undefined)) {
      context.addIssue({ code: "custom", path: ["dispatchStartedAt"], message: "Dispatch time must match attempt state" });
    }
  });
type ModelSelectionAttempt = z.infer<typeof ModelSelectionAttemptSchema>;

const ModelSelectionIdentityRecordSchema = z
  .object({
    version: z.literal(1),
    command: CommandEnvelopeSchema,
    recordedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.command.command.kind !== "model.select") {
      context.addIssue({
        code: "custom",
        path: ["command", "command"],
        message: "Identity record is not a model selection",
      });
    }
  });
type ModelSelectionIdentityRecord = z.infer<typeof ModelSelectionIdentityRecordSchema>;

const LegacyModelSelectionAttemptSchema = z
  .object({
    version: z.literal(1),
    command: LegacyCommandEnvelopeSchema,
    binding: ResidentSessionBindingSchema,
    state: z.enum(["admitted", "dispatching"]),
    admittedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    dispatchStartedAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (
      attempt.command.command.kind !== "model.select" ||
      attempt.command.threadId !== attempt.binding.threadId ||
      attempt.command.expectedExecutionGenerationId !== attempt.binding.executionGenerationId
    ) {
      context.addIssue({ code: "custom", message: "Legacy model selection attempt does not match its binding" });
    }
    if ((attempt.state === "dispatching") !== (attempt.dispatchStartedAt !== undefined)) {
      context.addIssue({ code: "custom", path: ["dispatchStartedAt"], message: "Dispatch time must match attempt state" });
    }
  });
type LegacyModelSelectionAttempt = z.infer<typeof LegacyModelSelectionAttemptSchema>;

const LegacyModelSelectionIdentityRecordSchema = z
  .object({
    version: z.literal(1),
    command: LegacyCommandEnvelopeSchema,
    recordedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.command.command.kind !== "model.select") {
      context.addIssue({ code: "custom", message: "Legacy model identity is not a model selection" });
    }
  });
type LegacyModelSelectionIdentityRecord = z.infer<typeof LegacyModelSelectionIdentityRecordSchema>;

export const MAX_PENDING_MODEL_SELECTION_ATTEMPTS = 10_000;
export const MAX_PENDING_RESIDENT_DISPATCH_ATTEMPTS = 10_000;
export const MAX_MODEL_SELECTION_ATTEMPT_BYTES = 1024 * 1024;
export const MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES = 1024 * 1024;
export const MAX_MODEL_SELECTION_IDENTITY_BYTES = 1024 * 1024;
export const MAX_COMMAND_IDENTITY_BYTES = 1024 * 1024;

const EventJournalRecordSchema = z
  .object({
    version: z.literal(1),
    eventId: IdSchema,
    recordedAt: IsoDateTimeSchema,
    type: z.string().min(1).max(64),
    threadId: IdSchema.optional(),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    detail: z.string().max(1_024).optional(),
    residentPromptIdleObserved: ResidentPromptIdleObservedEventSchema.optional(),
    residentAbortIdleObserved: ResidentAbortIdleObservedEventSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const observation = event.residentPromptIdleObserved;
    if ((event.type === "resident.prompt_idle_observed") !== (observation !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["residentPromptIdleObserved"],
        message: "Only the dedicated resident prompt idle event may carry its exact proof record",
      });
      return;
    }
    if (
      observation &&
      (event.eventId !== deterministicId("event", "resident-prompt-idle", observation.attemptId) ||
        event.recordedAt !== observation.observedAt ||
        event.threadId !== observation.command.threadId ||
        event.sequence !== observation.observedCursor.sequence ||
        event.detail !== observation.command.commandId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Resident prompt idle event metadata changed its exact proof identity",
      });
    }
    const abortObservation = event.residentAbortIdleObserved;
    if ((event.type === "resident.abort_idle_observed") !== (abortObservation !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["residentAbortIdleObserved"],
        message: "Only the dedicated resident abort idle event may carry its exact proof record",
      });
      return;
    }
    if (
      abortObservation &&
      (event.eventId !== deterministicId("event", "resident-abort-idle", abortObservation.attemptId) ||
        event.recordedAt !== abortObservation.observedAt ||
        event.threadId !== abortObservation.command.threadId ||
        event.sequence !== abortObservation.observedCursor.sequence ||
        event.detail !== abortObservation.command.commandId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Resident abort idle event metadata changed its exact proof identity",
      });
    }
  });

const AdmissionTransactionSchema = z
  .object({
    version: z.literal(2),
    kind: z.literal("command_admission"),
    transactionId: IdSchema,
    preparedAt: IsoDateTimeSchema,
    command: CommandEnvelopeSchema,
    receipt: CommandReceiptSchema,
    snapshot: ThreadProjectionSnapshotSchema.optional(),
    threadsFile: ThreadFileSchema.optional(),
    journalRecords: z.array(CommandJournalRecordSchema).min(2).max(3),
    eventRecord: EventJournalRecordSchema.optional(),
    commandIdentity: CommandIdentityRecordSchema,
    residentDispatchAttempt: ResidentDispatchAttemptSchema.optional(),
    modelSelectionIdentity: ModelSelectionIdentityRecordSchema.optional(),
    modelSelectionAttempt: ModelSelectionAttemptSchema.optional(),
  })
  .strict()
  .superRefine((transaction, context) => {
    if ((transaction.snapshot === undefined) !== (transaction.threadsFile === undefined)) {
      context.addIssue({ code: "custom", message: "Admission snapshot and thread catalog must materialize together" });
    }
    const requiresProjection =
      transaction.receipt.status === "admitted" &&
      transaction.command.command.kind !== "abort" &&
      transaction.command.command.kind !== "model.select" &&
      transaction.residentDispatchAttempt === undefined;
    if (requiresProjection !== (transaction.snapshot !== undefined)) {
      context.addIssue({ code: "custom", message: "Admission projection does not match its prepared outcome" });
    }
    if (
      transaction.receipt.deviceId !== transaction.command.deviceId ||
      transaction.receipt.commandId !== transaction.command.commandId ||
      transaction.receipt.threadId !== transaction.command.threadId ||
      transaction.receipt.executionGenerationId !== transaction.command.expectedExecutionGenerationId
    ) {
      context.addIssue({ code: "custom", message: "Admission receipt identity does not match its command" });
    }
    if (!isDeepStrictEqual(transaction.commandIdentity.command, transaction.command)) {
      context.addIssue({ code: "custom", message: "Durable command identity does not match its admission command" });
    }
    if (
      transaction.transactionId !==
        deterministicId("admission", transaction.command.deviceId, transaction.command.commandId) ||
      transaction.commandIdentity.recordedAt !== transaction.preparedAt ||
      transaction.receipt.receivedAt !== transaction.preparedAt ||
      transaction.receipt.updatedAt !== transaction.preparedAt
    ) {
      context.addIssue({ code: "custom", message: "Admission preparation boundary is internally inconsistent" });
    }
    const [received, terminal] = transaction.journalRecords;
    if (
      transaction.journalRecords.length !== 2 ||
      !received ||
      !terminal ||
      received.status !== "received" ||
      terminal.status !== transaction.receipt.status ||
      !isDeepStrictEqual(received.envelope, transaction.command) ||
      received.recordedAt !== transaction.preparedAt ||
      terminal.recordedAt !== transaction.preparedAt ||
      received.message !== undefined ||
      terminal.message !== transaction.receipt.message ||
      received.deviceId !== transaction.command.deviceId ||
      terminal.deviceId !== transaction.command.deviceId ||
      received.commandId !== transaction.command.commandId ||
      terminal.commandId !== transaction.command.commandId ||
      received.threadId !== transaction.command.threadId ||
      terminal.threadId !== transaction.command.threadId ||
      received.commandKind !== transaction.command.command.kind ||
      terminal.commandKind !== transaction.command.command.kind ||
      received.journalId !== deterministicId("journal", transaction.transactionId, "0", "received") ||
      terminal.journalId !==
        deterministicId("journal", transaction.transactionId, "1", transaction.receipt.status)
    ) {
      context.addIssue({ code: "custom", message: "Admission journal does not match its command and receipt" });
    }
    if (
      transaction.snapshot &&
      (!transaction.eventRecord ||
        transaction.eventRecord.eventId !==
          deterministicId("event", transaction.transactionId, "command-admitted") ||
        transaction.eventRecord.recordedAt !== transaction.preparedAt ||
        transaction.eventRecord.type !== "command.admitted" ||
        transaction.eventRecord.threadId !== transaction.command.threadId ||
        transaction.eventRecord.sequence !== transaction.snapshot.latestCursor.sequence ||
        transaction.eventRecord.detail !== transaction.command.command.kind)
    ) {
      context.addIssue({ code: "custom", message: "Admission event does not match its snapshot" });
    }
    if (!transaction.snapshot && transaction.eventRecord) {
      context.addIssue({ code: "custom", message: "Admission without a snapshot cannot publish an event" });
    }
    if (transaction.snapshot) {
      const matchingThreads = transaction.threadsFile?.threads.filter(
        (thread) => thread.threadId === transaction.command.threadId,
      );
      if (
        transaction.snapshot.thread.threadId !== transaction.command.threadId ||
        transaction.snapshot.thread.currentLocation.executionGenerationId !==
          transaction.command.expectedExecutionGenerationId ||
        transaction.snapshot.latestCursor.threadId !== transaction.command.threadId ||
        transaction.snapshot.latestCursor.executionGenerationId !==
          transaction.command.expectedExecutionGenerationId ||
        matchingThreads?.length !== 1 ||
        !isDeepStrictEqual(matchingThreads[0], transaction.snapshot.thread)
      ) {
        context.addIssue({ code: "custom", message: "Admission snapshot does not match its command authority" });
      }
    }
    const requiresModelAttempt =
      transaction.command.command.kind === "model.select" && transaction.receipt.status === "admitted";
    const requiresModelIdentity = transaction.command.command.kind === "model.select";
    if (requiresModelIdentity !== (transaction.modelSelectionIdentity !== undefined)) {
      context.addIssue({ code: "custom", message: "Every model selection must bind its durable command identity" });
    }
    if (requiresModelAttempt !== (transaction.modelSelectionAttempt !== undefined)) {
      context.addIssue({ code: "custom", message: "Admitted model selection must materialize one private attempt" });
    }
    if (
      transaction.modelSelectionIdentity &&
      !isDeepStrictEqual(transaction.modelSelectionIdentity.command, transaction.command)
    ) {
      context.addIssue({ code: "custom", message: "Model selection identity does not match its admission command" });
    }
    if (
      transaction.modelSelectionAttempt &&
      !isDeepStrictEqual(transaction.modelSelectionAttempt.command, transaction.command)
    ) {
      context.addIssue({ code: "custom", message: "Model selection attempt does not match its admission command" });
    }
    if (
      transaction.residentDispatchAttempt &&
      !isDeepStrictEqual(transaction.residentDispatchAttempt.command, transaction.command)
    ) {
      context.addIssue({ code: "custom", message: "Resident dispatch attempt does not match its admission command" });
    }
    if (
      transaction.residentDispatchAttempt &&
      (transaction.receipt.status !== "admitted" ||
        (transaction.command.command.kind !== "prompt" && transaction.command.command.kind !== "abort") ||
        transaction.residentDispatchAttempt.state !== "admitted" ||
        transaction.residentDispatchAttempt.admittedAt !== transaction.preparedAt ||
        transaction.residentDispatchAttempt.updatedAt !== transaction.preparedAt)
    ) {
      context.addIssue({ code: "custom", message: "Resident dispatch attempt is not an admitted prompt or abort" });
    }
  });
type AdmissionTransaction = z.infer<typeof AdmissionTransactionSchema>;

/** Version-one transactions are accepted only from durable storage recovery. */
const LegacyAdmissionTransactionSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("command_admission"),
    transactionId: IdSchema,
    preparedAt: IsoDateTimeSchema,
    command: LegacyCommandEnvelopeSchema,
    receipt: CommandReceiptSchema,
    snapshot: ThreadProjectionSnapshotSchema.optional(),
    threadsFile: ThreadFileSchema.optional(),
    journalRecords: z.array(CommandJournalRecordSchema).min(2).max(3),
    eventRecord: EventJournalRecordSchema.optional(),
    modelSelectionIdentity: LegacyModelSelectionIdentityRecordSchema.optional(),
    modelSelectionAttempt: LegacyModelSelectionAttemptSchema.optional(),
  })
  .strict()
  .superRefine((transaction, context) => {
    if ((transaction.snapshot === undefined) !== (transaction.threadsFile === undefined)) {
      context.addIssue({ code: "custom", message: "Legacy admission snapshot and catalog must materialize together" });
    }
    const requiresProjection =
      transaction.receipt.status === "admitted" &&
      transaction.command.command.kind !== "abort" &&
      transaction.command.command.kind !== "model.select";
    if (requiresProjection !== (transaction.snapshot !== undefined)) {
      context.addIssue({ code: "custom", message: "Legacy admission projection does not match its prepared outcome" });
    }
    if (
      transaction.receipt.deviceId !== transaction.command.deviceId ||
      transaction.receipt.commandId !== transaction.command.commandId ||
      transaction.receipt.threadId !== transaction.command.threadId
    ) {
      context.addIssue({ code: "custom", message: "Legacy admission receipt identity does not match its command" });
    }
    if (
      transaction.command.expectedExecutionGenerationId !== undefined &&
      transaction.receipt.executionGenerationId !== transaction.command.expectedExecutionGenerationId &&
      !(
        transaction.receipt.status === "rejected" &&
        transaction.receipt.error?.code === "STALE_EXECUTION_GENERATION"
      )
    ) {
      context.addIssue({ code: "custom", message: "Legacy admission receipt changed its explicit execution generation" });
    }
    if (transaction.snapshot && transaction.snapshot.thread.threadId !== transaction.command.threadId) {
      context.addIssue({ code: "custom", message: "Legacy admission snapshot thread does not match its command" });
    }
    const modelSelection = transaction.command.command.kind === "model.select";
    const requiresModelAttempt = modelSelection && transaction.receipt.status === "admitted";
    if (modelSelection !== (transaction.modelSelectionIdentity !== undefined)) {
      context.addIssue({ code: "custom", message: "Legacy model selection identity is incomplete" });
    }
    if (requiresModelAttempt !== (transaction.modelSelectionAttempt !== undefined)) {
      context.addIssue({ code: "custom", message: "Legacy model selection attempt is incomplete" });
    }
    if (
      transaction.modelSelectionIdentity &&
      !isDeepStrictEqual(transaction.modelSelectionIdentity.command, transaction.command)
    ) {
      context.addIssue({ code: "custom", message: "Legacy model identity changed its command envelope" });
    }
    if (
      transaction.modelSelectionAttempt &&
      !isDeepStrictEqual(transaction.modelSelectionAttempt.command, transaction.command)
    ) {
      context.addIssue({ code: "custom", message: "Legacy model attempt changed its command envelope" });
    }
  });
type LegacyAdmissionTransaction = z.infer<typeof LegacyAdmissionTransactionSchema>;

const RecoverableAdmissionTransactionSchema = z.discriminatedUnion("version", [
  LegacyAdmissionTransactionSchema,
  AdmissionTransactionSchema,
]);

export const MAX_PENDING_ADMISSION_TRANSACTIONS = 1_024;
export const MAX_ADMISSION_TRANSACTION_BYTES = 64 * 1024 * 1024;

export const MAX_RESIDENT_PROJECTION_LINEAGES = 10_000;
export const MAX_RETIRED_RESIDENT_CURSOR_GENERATIONS = 64;
export const MAX_RESIDENT_PROJECTION_LINEAGE_BYTES = 1024 * 1024;

const ResidentProjectionAuthoritySchema = z
  .object({
    threadId: IdSchema,
    executionGenerationId: IdSchema,
    workspaceDirectory: WorkspaceDirectorySchema,
    activeSessionId: z.string().min(1).max(4_096),
    sessionId: z.string().min(1).max(4_096),
    sessionFile: z.string().min(1).max(4_096).optional(),
  })
  .strict();
type ResidentProjectionAuthority = z.infer<typeof ResidentProjectionAuthoritySchema>;

const ResidentProjectionCursorLineageSchema = z
  .object({
    authorityId: IdSchema,
    authority: ResidentProjectionAuthoritySchema,
    current: z
      .object({
        generation: IdSchema,
        sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    retiredGenerations: z.array(IdSchema).max(MAX_RETIRED_RESIDENT_CURSOR_GENERATIONS),
  })
  .strict()
  .superRefine((lineage, context) => {
    if (lineage.authorityId !== residentProjectionAuthorityId(lineage.authority)) {
      context.addIssue({ code: "custom", path: ["authorityId"], message: "Projection authority ID changed" });
    }
    const retired = new Set(lineage.retiredGenerations);
    if (retired.size !== lineage.retiredGenerations.length) {
      context.addIssue({ code: "custom", path: ["retiredGenerations"], message: "Retired generations must be unique" });
    }
    if (retired.has(lineage.current.generation)) {
      context.addIssue({ code: "custom", path: ["current", "generation"], message: "Current generation is retired" });
    }
  });
type ResidentProjectionCursorLineage = z.infer<typeof ResidentProjectionCursorLineageSchema>;

const ResidentProjectionTransactionSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("resident_projection_publication"),
    transactionId: IdSchema,
    preparedAt: IsoDateTimeSchema,
    binding: ResidentSessionBindingSchema,
    lifecycleOperationId: IdSchema.optional(),
    projectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    previousLineage: ResidentProjectionCursorLineageSchema.optional(),
    nextLineage: ResidentProjectionCursorLineageSchema,
    // Prompt ownership is retired only by the dedicated waitForIdle proof
    // transaction. Generic cursor publication can never consume the lock.
    retiredPromptAttempts: z.array(ResidentDispatchAttemptSchema).max(0),
    // Only a Store-branded acknowledged Stop may authorize replacing active
    // content at one unchanged upstream cursor after waitForIdle proves the
    // previous same-cursor view stale.
    abortIdleProofAttempt: ResidentDispatchAttemptSchema.optional(),
    snapshot: ThreadProjectionSnapshotSchema,
    threadsFile: ThreadFileSchema,
  })
  .strict()
  .superRefine((transaction, context) => {
    const { binding, snapshot, threadsFile } = transaction;
    const authority = residentProjectionAuthorityFromBinding(binding);
    const authorityId = residentProjectionAuthorityId(authority);
    const nextLineage = transaction.nextLineage;
    if (
      nextLineage.authorityId !== authorityId ||
      !isDeepStrictEqual(nextLineage.authority, authority) ||
      nextLineage.current.generation !== snapshot.latestCursor.generation ||
      nextLineage.current.sequence !== snapshot.latestCursor.sequence ||
      nextLineage.current.digest !== transaction.projectionDigest ||
      transaction.projectionDigest !== residentPublishedProjectionDigest(snapshot) ||
      (transaction.previousLineage !== undefined && transaction.previousLineage.authorityId !== authorityId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Resident projection transaction lineage does not match its binding and cursor",
      });
    }
    if (!residentProjectionLineageTransitionIsValid(
      transaction.previousLineage,
      nextLineage,
      transaction.abortIdleProofAttempt !== undefined,
    )) {
      context.addIssue({
        code: "custom",
        message: "Resident projection transaction does not advance its exact prior lineage",
      });
    }
    const abortProof = transaction.abortIdleProofAttempt;
    if (transaction.lifecycleOperationId !== undefined && abortProof !== undefined) {
      context.addIssue({
        code: "custom",
        message: "An activating projection cannot consume a Stop reconciliation proof",
      });
    }
    if (
      abortProof &&
      (!residentAcknowledgedAbortAttemptRetainsLock(abortProof) ||
        abortProof.bindingFingerprint !== residentDispatchAuthorityFingerprint(binding) ||
        !isDeepStrictEqual(
          residentProjectionAuthorityFromBinding(abortProof.binding),
          residentProjectionAuthorityFromBinding(binding),
        ) ||
        snapshot.thread.status === "running" ||
        residentSnapshotReportsActivity(snapshot) ||
        !transaction.previousLineage ||
        transaction.previousLineage.current.generation !== nextLineage.current.generation ||
        transaction.previousLineage.current.sequence !== nextLineage.current.sequence ||
        transaction.transactionId !== deterministicId(
          "resident-abort-idle-projection",
          abortProof.attemptId,
          nextLineage.current.generation,
          String(nextLineage.current.sequence),
        ))
    ) {
      context.addIssue({
        code: "custom",
        message: "Resident abort idle projection does not match its exact acknowledged Stop proof",
      });
    }
    if (
      snapshot.thread.threadId !== binding.threadId ||
      snapshot.thread.currentLocation.executionGenerationId !== binding.executionGenerationId ||
      snapshot.latestCursor.threadId !== binding.threadId ||
      snapshot.latestCursor.executionGenerationId !== binding.executionGenerationId
    ) {
      context.addIssue({
        code: "custom",
        message: "Resident projection transaction does not belong to its binding authority",
      });
    }
    if (
      snapshot.generatedAt !== snapshot.thread.updatedAt ||
      !isDeepStrictEqual(snapshot.thread.lastKnownCursor, snapshot.latestCursor)
    ) {
      context.addIssue({
        code: "custom",
        message: "Resident projection thread metadata must match its authoritative snapshot cursor",
      });
    }
    if (
      !snapshot.runtime ||
      snapshot.runtime.residency !== "resident" ||
      snapshot.runtime.activeSessionId !== binding.activeSessionId ||
      snapshot.runtime.sessionId !== binding.sessionId ||
      snapshot.thread.recap !== snapshot.runtime.recap
    ) {
      context.addIssue({
        code: "custom",
        message: "Resident projection runtime identity and recap must match its binding and thread",
      });
    }
    const catalogThread = threadsFile.threads.find((thread) => thread.threadId === binding.threadId);
    if (!catalogThread || !isDeepStrictEqual(catalogThread, snapshot.thread)) {
      context.addIssue({
        code: "custom",
        message: "Resident projection snapshot and thread catalog must materialize together",
      });
    }
  });
type ResidentProjectionTransaction = z.infer<typeof ResidentProjectionTransactionSchema>;

export const MAX_PENDING_RESIDENT_PROJECTION_TRANSACTIONS = 1_024;
export const MAX_RESIDENT_PROJECTION_TRANSACTION_BYTES = 64 * 1024 * 1024;

export type AdmissionFaultPoint =
  | "after_prepare"
  | "after_snapshot"
  | "after_threads"
  | "after_command_identity"
  | "after_resident_dispatch_attempt"
  | "after_model_selection_identity"
  | "after_model_selection_attempt"
  | "after_receipt"
  | "after_journal"
  | "after_event";

export type ResidentProjectionFaultPoint =
  | "after_prepare"
  | "after_lineage"
  | "after_snapshot"
  | "after_threads"
  | "after_prompt_locks";

export type ResidentDispatchFaultPoint =
  | "after_dispatch_attempt"
  | "after_dispatch_receipt"
  | "after_dispatch_journal"
  | "after_settled_attempt"
  | "after_settled_receipt"
  | "after_settled_journal"
  | "after_prompt_idle_attempt"
  | "after_prompt_idle_receipt"
  | "after_prompt_idle_journal"
  | "after_prompt_idle_event"
  | "after_abort_idle_attempt"
  | "after_abort_idle_receipt"
  | "after_abort_idle_journal"
  | "after_abort_idle_event";

export type ResidentLifecycleFaultPoint =
  | "after_prepared"
  | "after_owned_create_dispatching"
  | "after_mutation_failed_before_effect"
  | "after_owned_create_cleanup"
  | "after_quarantined"
  | "after_owned_observed"
  | "after_promotion_dispatching"
  | "after_promoted_observed"
  | "after_activating_binding"
  | "after_projection_publication"
  | "after_projection_committed"
  | "after_active_binding"
  | "after_committed"
  | "after_ending"
  | "after_binding_revoked"
  | "after_kill_dispatching"
  | "after_kill_acknowledged"
  | "after_completed_binding"
  | "after_completed"
  | "after_detached"
  | "after_detached_binding";

export type HandoffCheckpointWriter = (path: string, checkpoint: HandoffCheckpoint) => Promise<boolean>;

export interface HostStoreOptions {
  admissionFaultInjector?: (point: AdmissionFaultPoint, transactionId: string) => void | Promise<void>;
  residentProjectionFaultInjector?: (
    point: ResidentProjectionFaultPoint,
    transactionId: string,
  ) => void | Promise<void>;
  residentDispatchFaultInjector?: (
    point: ResidentDispatchFaultPoint,
    attemptId: string,
  ) => void | Promise<void>;
  residentLifecycleFaultInjector?: (
    point: ResidentLifecycleFaultPoint,
    operationId: string,
  ) => void | Promise<void>;
  handoffCheckpointWriter?: HandoffCheckpointWriter;
}

export interface SeedResult {
  seeded: boolean;
  project?: SavedProject;
  thread?: ThreadSummary;
}

export interface CommandAdmission {
  receipt: CommandReceipt;
  duplicate: boolean;
}

export interface HandoffCommit {
  receipt: HandoffReceipt;
  progress: HandoffProgress[];
  duplicate: boolean;
}

export class HostStoreError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostStoreError";
    this.code = code;
    this.retryable = retryable;
  }

  toStructuredError(): StructuredError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/**
 * Durable authority for one execution host. All mutations are serialized so
 * duplicate `(deviceId, commandId)` checks and receipt creation are one logical
 * operation within a hostd process.
 */
export class HostStore {
  readonly paths: HostDataPaths;

  private operationTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private residentSubsystemFault: HostStoreError | undefined;
  private readonly options: HostStoreOptions;
  private readonly residentPromptReconciliationLeases = new WeakSet<object>();
  private readonly residentPromptReconciliationLeaseCache = new Map<string, ResidentPromptReconciliationLease>();
  private readonly residentAbortReconciliationLeases = new WeakSet<object>();
  private readonly residentAbortReconciliationLeaseCache = new Map<string, ResidentAbortReconciliationLease>();
  private readonly residentOwnedCreateLeases = new WeakSet<object>();
  private readonly residentPromotionLeases = new WeakSet<object>();
  private readonly residentLifecycleProjectionLeases = new WeakSet<object>();
  private readonly residentKillLeases = new WeakSet<object>();

  constructor(dataDir: string, options: HostStoreOptions = {}) {
    this.paths = getHostDataPaths(dataDir);
    this.options = options;
  }

  async initialize(options: { seed?: boolean } = {}): Promise<SeedResult> {
    return this.exclusive(async () => {
      if (this.initialized) return { seeded: false };
      await Promise.all([
        ensurePrivateDirectory(this.paths.root),
        ensurePrivateDirectory(this.paths.snapshots),
        ensurePrivateDirectory(this.paths.checkpoints),
        ensurePrivateDirectory(this.paths.staging),
        ensurePrivateDirectory(this.paths.transactions),
        ensurePrivateDirectory(this.paths.residentProjectionTransactions),
        ensurePrivateDirectory(this.paths.residentProjectionLineages),
        ensurePrivateDirectory(this.paths.residentDispatchAttempts),
        ensurePrivateDirectory(this.paths.residentLifecycleOperations),
        ensurePrivateDirectory(this.commandIdentitiesDirectory()),
        ensurePrivateDirectory(this.modelSelectionIdentitiesDirectory()),
        ensurePrivateDirectory(this.modelSelectionAttemptsDirectory()),
        ensurePrivateDirectory(this.paths.receipts),
        ensurePrivateDirectory(this.paths.handoffs),
        ensurePrivateDirectory(this.paths.security),
        ensurePrivateDirectory(this.paths.journals),
      ]);

      const hostFile = await readJsonFile(this.paths.host, HostFileSchema, { optional: true });
      if (!hostFile) await atomicWriteJson(this.paths.host, { version: 1, host: createLocalHostSummary() });
      const projectFile = await readJsonFile(this.paths.projects, ProjectFileSchema, { optional: true });
      if (!projectFile) await atomicWriteJson(this.paths.projects, { version: 1, projects: [] });
      const threadFile = await readJsonFile(this.paths.threads, ThreadFileSchema, { optional: true });
      if (!threadFile) await atomicWriteJson(this.paths.threads, { version: 1, threads: [] });
      await this.recoverAdmissionTransactionsUnlocked();

      this.residentSubsystemFault = undefined;
      try {
        const workspaceAuthorityFile = await readJsonFile(
          this.paths.workspaceAuthorities,
          WorkspaceAuthorityFileSchema,
          { optional: true, maxBytes: MAX_WORKSPACE_AUTHORITY_FILE_BYTES },
        );
        if (!workspaceAuthorityFile) {
          await atomicWriteJson(
            this.paths.workspaceAuthorities,
            { version: 1, authorities: [] },
            MAX_WORKSPACE_AUTHORITY_FILE_BYTES,
          );
        }
        const residentBindingFile = await readJsonFile(
          this.paths.residentSessionBindings,
          ResidentSessionBindingFileSchema,
          { optional: true, maxBytes: MAX_RESIDENT_SESSION_BINDING_FILE_BYTES },
        );
        if (!residentBindingFile) {
          await atomicWriteJson(
            this.paths.residentSessionBindings,
            { version: 1, records: [] },
            MAX_RESIDENT_SESSION_BINDING_FILE_BYTES,
          );
        }
        await this.validateResidentLifecycleOperationDirectoryUnlocked();
        await this.recoverResidentLifecycleOperationsUnlocked("before_projection_recovery");
        await this.validateResidentProjectionLineageDirectoryUnlocked();
      } catch (error) {
        this.residentSubsystemFault = residentSubsystemUnavailable(error);
      }
      if (this.residentSubsystemFault) {
        const pendingProjection = (await readdir(this.paths.residentProjectionTransactions, {
          withFileTypes: true,
        })).some((entry) => entry.isFile() && entry.name.endsWith(".json"));
        if (pendingProjection) {
          throw new HostStoreError(
            "RESIDENT_PROJECTION_RECOVERY_UNAVAILABLE",
            "A prepared resident projection cannot be recovered while its private authority state is unavailable",
            false,
            { cause: this.residentSubsystemFault },
          );
        }
      }
      if (!this.residentSubsystemFault) {
        // A prepared projection may have made exactly one of its two public
        // files visible. Replay must finish before this store serves readers;
        // unlike an unrelated resident-state degradation, replay failure is a
        // global public-consistency failure and therefore aborts initialize().
        await this.recoverResidentProjectionTransactionsUnlocked();
        await this.recoverResidentLifecycleOperationsUnlocked("after_projection_recovery");
        try {
          await this.validateResidentStateUnlocked();
        } catch (error) {
          this.residentSubsystemFault = residentSubsystemUnavailable(error);
        }
      }

      // An admitted or dispatching model mutation is deliberately never
      // replayed by a new hostd/Prime client identity. Startup converts the
      // incomplete receipt to `uncertain` before serving reconciliation.
      await this.recoverInterruptedModelSelectionsUnlocked();
      await this.recoverInterruptedResidentDispatchesUnlocked();

      this.initialized = true;
      if (options.seed !== true) return { seeded: false };
      return this.seedIfEmptyUnlocked();
    });
  }

  async seedIfEmpty(): Promise<SeedResult> {
    return this.exclusive(async () => {
      this.assertInitialized();
      return this.seedIfEmptyUnlocked();
    });
  }

  async getHost(): Promise<HostSummary> {
    return this.exclusive(async () => {
      this.assertInitialized();
      const file = await readJsonFile(this.paths.host, HostFileSchema);
      if (!file) throw new HostStoreError("HOST_STATE_MISSING", "The host state file is missing");
      return file.host;
    });
  }

  async getCatalogSnapshot(): Promise<CatalogProjectionSnapshot> {
    return this.exclusive(async () => {
      this.assertInitialized();
      const [host, projects, threads] = await Promise.all([
        this.readHostUnlocked(),
        this.readProjectsUnlocked(),
        this.readThreadsUnlocked(),
      ]);
      return CatalogProjectionSnapshotSchema.parse({
        snapshotVersion: SNAPSHOT_VERSION,
        generatedAt: now(),
        host,
        projects,
        threads,
      });
    });
  }

  async getThreadSnapshot(threadId: string): Promise<ThreadProjectionSnapshot> {
    return this.exclusive(async () => {
      this.assertInitialized();
      const thread = (await this.readThreadsUnlocked()).find((item) => item.threadId === threadId);
      if (!thread) throw new HostStoreError("THREAD_NOT_FOUND", `Thread ${threadId} does not exist`);
      const snapshot = await readJsonFile(this.snapshotPath(threadId), ThreadProjectionSnapshotSchema, {
        optional: true,
      });
      if (!snapshot) throw new HostStoreError("SNAPSHOT_NOT_FOUND", `Thread ${threadId} has no durable snapshot`);
      return snapshot;
    });
  }

  async upsertProject(projectValue: SavedProject): Promise<void> {
    const project = SavedProjectSchema.parse(projectValue);
    await this.exclusive(async () => {
      this.assertInitialized();
      const projects = await this.readProjectsUnlocked();
      const existing = projects.findIndex((item) => item.projectId === project.projectId);
      if (existing >= 0) {
        const current = projects[existing];
        if (!current) throw new HostStoreError("PROJECT_STATE_INVALID", "The project catalog index is invalid");
        if (current.hostId !== project.hostId || current.workspaceId !== project.workspaceId) {
          const lifecycle = (await this.readResidentLifecycleOperationsUnlocked()).find(
            (operation) =>
              operation.input.projectId === project.projectId && residentLifecycleOperationIsNonterminal(operation),
          );
          if (lifecycle) {
            throw new HostStoreError(
              "RESIDENT_LIFECYCLE_IN_PROGRESS",
              "Project execution authority cannot change during a resident lifecycle operation",
            );
          }
          const authorities = await this.readWorkspaceAuthoritiesUnlocked();
          if (authorities.some((authority) => authority.projectId === project.projectId)) {
            throw new HostStoreError(
              "WORKSPACE_AUTHORITY_CONFLICT",
              "A saved project with registered workspace authority cannot change host or workspace identity",
            );
          }
        }
        projects[existing] = project;
      }
      else {
        if (projects.length >= 10_000) throw new HostStoreError("PROJECT_LIMIT_REACHED", "Project catalog is full");
        projects.push(project);
      }
      await atomicWriteJson(this.paths.projects, { version: 1, projects });
    });
  }

  async upsertThread(threadValue: ThreadSummary, snapshotValue: ThreadProjectionSnapshot): Promise<void> {
    const thread = ThreadSummarySchema.parse(threadValue);
    const snapshot = ThreadProjectionSnapshotSchema.parse(snapshotValue);
    if (snapshot.thread.threadId !== thread.threadId) {
      throw new HostStoreError("THREAD_SNAPSHOT_MISMATCH", "Thread and snapshot identifiers differ");
    }
    await this.exclusive(async () => {
      this.assertInitialized();
      const threads = await this.readThreadsUnlocked();
      const existing = threads.findIndex((item) => item.threadId === thread.threadId);
      if (existing >= 0) {
        const current = threads[existing];
        if (!current) throw new HostStoreError("THREAD_STATE_INVALID", "The thread catalog index is invalid");
        if (!isDeepStrictEqual(current.currentLocation, thread.currentLocation)) {
          await this.assertNoResidentLifecycleOperationUnlocked(thread.threadId);
          await this.assertNoResidentDispatchTransitionUnlocked(
            thread.threadId,
            "Execution authority cannot change while a resident dispatch is unresolved",
          );
          const residentBindings = await this.readResidentSessionBindingsUnlocked();
          if (residentBindings.some((binding) => binding.threadId === thread.threadId)) {
            throw new HostStoreError(
              "RESIDENT_SESSION_ACTIVE",
              "A thread with an active resident session cannot change execution authority",
            );
          }
        }
        threads[existing] = thread;
      }
      else {
        if (threads.length >= 10_000) throw new HostStoreError("THREAD_LIMIT_REACHED", "Thread catalog is full");
        threads.push(thread);
      }
      await atomicWriteJson(this.snapshotPath(thread.threadId), snapshot);
      await atomicWriteJson(this.paths.threads, { version: 1, threads });
    });
  }

  /**
   * Registers the private physical workspace used by the current execution
   * generation. Public project projections intentionally never contain this
   * host-local path.
   */
  async registerWorkspaceAuthority(inputValue: WorkspaceAuthorityRegistration): Promise<string> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const input = parseWorkspaceRegistration(inputValue);
      const canonicalDirectory = await canonicalWorkspaceDirectory(input.workspaceDirectory);
      const scope = await this.currentWorkspaceScopeUnlocked(input.threadId, input.executionGenerationId);
      const [authorities, bindings] = await Promise.all([
        this.readWorkspaceAuthoritiesUnlocked(),
        this.readResidentSessionBindingsUnlocked(),
      ]);
      const existingIndex = authorities.findIndex((authority) => authority.threadId === input.threadId);
      const existing = existingIndex >= 0 ? authorities[existingIndex] : undefined;
      const activeBinding = bindings.find((binding) => binding.threadId === input.threadId);

      if (activeBinding && !sameCanonicalPath(activeBinding.workspaceDirectory, canonicalDirectory)) {
        throw new HostStoreError(
          "WORKSPACE_AUTHORITY_CONFLICT",
          "The workspace path cannot change while its resident session is active",
        );
      }
      const pathOwner = authorities.find(
        (authority) =>
          authority.threadId !== input.threadId &&
          sameCanonicalPath(authority.workspaceDirectory, canonicalDirectory) &&
          (authority.hostId !== scope.hostId ||
            authority.projectId !== scope.projectId ||
            authority.workspaceId !== scope.workspaceId),
      );
      if (pathOwner) {
        throw new HostStoreError(
          "WORKSPACE_PATH_REUSED",
          "The canonical workspace path is already registered to a different saved workspace",
        );
      }

      const authority = WorkspaceAuthoritySchema.parse({
        authorityVersion: 1,
        ...scope,
        workspaceDirectory: canonicalDirectory,
        registeredAt:
          existing &&
          existing.hostId === scope.hostId &&
          existing.projectId === scope.projectId &&
          existing.workspaceId === scope.workspaceId &&
          existing.executionGenerationId === scope.executionGenerationId &&
          sameCanonicalPath(existing.workspaceDirectory, canonicalDirectory)
            ? existing.registeredAt
            : now(),
      });
      if (existing && isDeepStrictEqual(existing, authority)) return canonicalDirectory;
      if (existing) {
        await this.assertNoResidentLifecycleOperationUnlocked(input.threadId);
        await this.assertNoResidentDispatchTransitionUnlocked(
          input.threadId,
          "Workspace authority cannot change while a resident dispatch is unresolved",
        );
      }
      if (existingIndex >= 0) authorities[existingIndex] = authority;
      else {
        if (authorities.length >= MAX_WORKSPACE_AUTHORITIES) {
          throw new HostStoreError("WORKSPACE_AUTHORITY_LIMIT_REACHED", "The workspace authority registry is full");
        }
        authorities.push(authority);
      }
      await this.writeWorkspaceAuthoritiesUnlocked(authorities);
      return canonicalDirectory;
    });
  }

  async resolveWorkspaceDirectory(threadId: string, executionGenerationId: string): Promise<string> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const lookup = parseWorkspaceLookup(threadId, executionGenerationId);
      const scope = await this.currentWorkspaceScopeUnlocked(lookup.threadId, lookup.executionGenerationId);
      return this.resolveWorkspaceDirectoryUnlocked(scope);
    });
  }

  async getResidentSessionBinding(
    threadId: string,
    executionGenerationId: string,
  ): Promise<ResidentSessionBinding | undefined> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const lookup = parseWorkspaceLookup(threadId, executionGenerationId);
      const scope = await this.currentWorkspaceScopeUnlocked(lookup.threadId, lookup.executionGenerationId);
      const workspaceDirectory = await this.resolveWorkspaceDirectoryUnlocked(scope);
      const binding = (await this.readResidentSessionBindingsUnlocked()).find(
        (candidate) => candidate.threadId === lookup.threadId,
      );
      if (!binding) return undefined;
      this.assertBindingMatchesScope(binding, scope, workspaceDirectory);
      return validateResidentSessionBinding(binding);
    });
  }

  async listResidentSessionBindings(): Promise<readonly ResidentSessionBinding[]> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const bindings = await this.readResidentSessionBindingsUnlocked();
      for (const binding of bindings) {
        const scope = await this.currentWorkspaceScopeUnlocked(
          binding.threadId,
          binding.executionGenerationId,
        );
        const workspaceDirectory = await this.resolveWorkspaceDirectoryUnlocked(scope);
        this.assertBindingMatchesScope(binding, scope, workspaceDirectory);
        const canonicalDirectory = await canonicalWorkspaceDirectory(binding.workspaceDirectory);
        if (!sameCanonicalPath(binding.workspaceDirectory, canonicalDirectory)) {
          throw new HostStoreError(
            "RESIDENT_BINDING_PATH_MISMATCH",
            "An active resident binding does not use its canonical workspace path",
          );
        }
      }
      return Object.freeze(bindings.map((binding) => validateResidentSessionBinding(binding)));
    });
  }

  async getResidentLifecycleStatus(operationIdValue: string): Promise<ResidentLifecycleStatus | undefined> {
    const operationId = IdSchema.parse(operationIdValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const record = await this.readResidentLifecycleOperationUnlocked(operationId);
      return record ? residentLifecycleStatus(record) : undefined;
    });
  }

  async prepareResidentProvision(inputValue: ResidentLifecycleOperationInput): Promise<ResidentLifecycleStatus> {
    const input = ResidentLifecycleOperationInputSchema.parse(inputValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const existing = await this.resolveExactResidentLifecycleOperationUnlocked("provision", input, {
        optional: true,
      });
      if (existing) return residentLifecycleStatus(existing);

      const authority = await this.resolveResidentLifecycleAuthorityUnlocked(input);
      await this.assertNoResidentLifecycleOperationUnlocked(input.threadId);
      if ((await this.readResidentSessionBindingsUnlocked()).some((binding) => binding.threadId === input.threadId)) {
        throw new HostStoreError(
          "RESIDENT_BINDING_ALREADY_ACTIVE",
          "A new resident session cannot be provisioned while this thread already has an active binding",
        );
      }
      const timestamp = now();
      const record = ResidentLifecycleOperationRecordSchema.parse({
        version: 1,
        kind: "provision",
        operationId: input.operationId,
        input,
        operationFingerprint: residentLifecycleOperationFingerprint("provision", input, authority.authorityDigest),
        authority,
        phase: "prepared",
        preparedAt: timestamp,
        updatedAt: timestamp,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(record, "after_prepared");
      return residentLifecycleStatus(record);
    });
  }

  async beginResidentOwnedCreate(inputValue: ResidentLifecycleOperationInput): Promise<ResidentOwnedCreateLease> {
    const input = ResidentLifecycleOperationInputSchema.parse(inputValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const record = await this.requireExactResidentLifecycleOperationUnlocked("provision", input);
      await this.assertResidentLifecycleAuthorityCurrentUnlocked(record);
      if (record.phase !== "prepared") {
        throw residentLifecycleMutationAlreadyCrossed(record, "owned create");
      }
      const dispatchStartedAt = now();
      const dispatching = ResidentLifecycleOperationRecordSchema.parse({
        ...record,
        phase: "owned_create_dispatching",
        updatedAt: dispatchStartedAt,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(dispatching, "after_owned_create_dispatching");
      const lease = Object.freeze({
        [residentOwnedCreateLeaseBrand]: true as const,
        leaseVersion: 1 as const,
        operationId: record.operationId,
        operationFingerprint: record.operationFingerprint,
        dispatchStartedAt,
      });
      this.residentOwnedCreateLeases.add(lease);
      return lease;
    });
  }

  async observeResidentOwnedCandidate(
    leaseValue: ResidentOwnedCreateLease,
    candidateValue: ResidentOwnedSessionCandidate,
  ): Promise<ResidentLifecycleStatus> {
    const candidate = ResidentOwnedSessionCandidateSchema.parse(candidateValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const lease = this.validateResidentOwnedCreateLease(leaseValue);
      const record = await this.readResidentLifecycleOperationUnlocked(lease.operationId);
      if (
        !record ||
        record.kind !== "provision" ||
        record.phase !== "owned_create_dispatching" ||
        record.operationFingerprint !== lease.operationFingerprint ||
        record.updatedAt !== lease.dispatchStartedAt
      ) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_LEASE_STALE",
          "The owned-create lease no longer matches its exact durable lifecycle operation",
        );
      }
      await this.assertResidentLifecycleAuthorityCurrentUnlocked(record);
      const binding = await this.residentBindingFromOwnedCandidateUnlocked(record, candidate);
      await this.assertResidentLifecycleCandidateUnusedUnlocked(record, binding);
      const observedAt = now();
      const observed = ResidentLifecycleOperationRecordSchema.parse({
        ...record,
        phase: "owned_observed",
        binding,
        updatedAt: observedAt,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(observed, "after_owned_observed");
      this.residentOwnedCreateLeases.delete(lease as object);
      return residentLifecycleStatus(observed);
    });
  }

  /**
   * Terminal only when the coordinator has proof that create was never
   * invoked. A post-create validation or attach failure must instead confirm
   * complete_owned_session and use completeResidentOwnedCreateCleanup; an
   * unknown cleanup outcome must be quarantined.
   */
  async failResidentOwnedCreateBeforeEffect(
    leaseValue: ResidentOwnedCreateLease,
  ): Promise<ResidentLifecycleStatus> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const lease = this.validateResidentOwnedCreateLease(leaseValue);
      const record = await this.requireLifecycleLeaseRecordUnlocked(
        lease,
        "provision",
        "owned_create_dispatching",
      );
      const completedAt = now();
      const completed = ResidentLifecycleOperationRecordSchema.parse({
        ...record,
        phase: "completed",
        completionReason: "owned_create_failed_before_effect",
        updatedAt: completedAt,
        terminalAt: completedAt,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(completed, "after_mutation_failed_before_effect");
      this.residentOwnedCreateLeases.delete(lease as object);
      return residentLifecycleStatus(completed);
    });
  }

  /**
   * Records definitive cleanup of a session that may have been created but
   * could not produce a valid owned candidate. The exact create lease remains
   * the authority; this transition is legal only after an independently parsed
   * successful complete_owned_session response. A resolved upstream dispose()
   * is not proof because Prime v0.7 swallows completion failures there.
   */
  async completeResidentOwnedCreateCleanup(
    leaseValue: ResidentOwnedCreateLease,
  ): Promise<ResidentLifecycleStatus> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const lease = this.validateResidentOwnedCreateLease(leaseValue);
      const record = await this.requireLifecycleLeaseRecordUnlocked(
        lease,
        "provision",
        "owned_create_dispatching",
      );
      const completedAt = now();
      const completed = ResidentLifecycleOperationRecordSchema.parse({
        ...record,
        phase: "completed",
        completionReason: "owned_create_cleaned",
        updatedAt: completedAt,
        terminalAt: completedAt,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(completed, "after_owned_create_cleanup");
      this.residentOwnedCreateLeases.delete(lease as object);
      return residentLifecycleStatus(completed);
    });
  }

  async beginResidentPromotion(inputValue: ResidentLifecycleOperationInput): Promise<ResidentPromotionLease> {
    const input = ResidentLifecycleOperationInputSchema.parse(inputValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const record = await this.requireExactResidentLifecycleOperationUnlocked("provision", input);
      await this.assertResidentLifecycleAuthorityCurrentUnlocked(record);
      if (record.phase !== "owned_observed" || !record.binding) {
        throw residentLifecycleMutationAlreadyCrossed(record, "owned-session promotion");
      }
      const dispatchStartedAt = now();
      const dispatching = ResidentLifecycleOperationRecordSchema.parse({
        ...record,
        phase: "promotion_dispatching",
        updatedAt: dispatchStartedAt,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(dispatching, "after_promotion_dispatching");
      const lease = Object.freeze({
        [residentPromotionLeaseBrand]: true as const,
        leaseVersion: 1 as const,
        operationId: record.operationId,
        operationFingerprint: record.operationFingerprint,
        binding: validateResidentSessionBinding(record.binding),
        dispatchStartedAt,
      });
      this.residentPromotionLeases.add(lease);
      return lease;
    });
  }

  async failResidentPromotionBeforeEffect(
    leaseValue: ResidentPromotionLease,
  ): Promise<ResidentLifecycleStatus> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const lease = this.validateResidentPromotionLease(leaseValue);
      const record = await this.requireLifecycleLeaseRecordUnlocked(
        lease,
        "provision",
        "promotion_dispatching",
      );
      const retryable = ResidentLifecycleOperationRecordSchema.parse({
        ...record,
        phase: "owned_observed",
        updatedAt: now(),
      });
      await this.writeResidentLifecycleBoundaryUnlocked(retryable, "after_mutation_failed_before_effect");
      this.residentPromotionLeases.delete(lease as object);
      return residentLifecycleStatus(retryable);
    });
  }

  async observeResidentPromotion(leaseValue: ResidentPromotionLease): Promise<ResidentLifecycleProjectionLease> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const lease = this.validateResidentPromotionLease(leaseValue);
      const record = await this.readResidentLifecycleOperationUnlocked(lease.operationId);
      if (
        !record ||
        record.kind !== "provision" ||
        record.phase !== "promotion_dispatching" ||
        !record.binding ||
        record.operationFingerprint !== lease.operationFingerprint ||
        record.updatedAt !== lease.dispatchStartedAt ||
        !isDeepStrictEqual(record.binding, lease.binding)
      ) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_LEASE_STALE",
          "The promotion lease no longer matches its exact durable lifecycle operation",
        );
      }
      await this.assertResidentLifecycleAuthorityCurrentUnlocked(record);
      const promotionObservedAt = now();
      const observed = ResidentLifecycleOperationRecordSchema.parse({
        ...record,
        phase: "promoted_observed",
        updatedAt: promotionObservedAt,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(observed, "after_promoted_observed");
      await this.guardResidentLifecycleMaterializationUnlocked(async () => {
        await this.materializeActivatingResidentBindingUnlocked(observed);
        await this.injectResidentLifecycleFault("after_activating_binding", observed.operationId);
      });
      this.residentPromotionLeases.delete(lease as object);
      return this.createResidentLifecycleProjectionLease(observed, promotionObservedAt);
    });
  }

  async acquireResidentProvisionRecoveryLease(
    inputValue: ResidentLifecycleOperationInput,
  ): Promise<ResidentLifecycleProjectionLease> {
    const input = ResidentLifecycleOperationInputSchema.parse(inputValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const record = await this.requireExactResidentLifecycleOperationUnlocked("provision", input);
      await this.assertResidentLifecycleAuthorityCurrentUnlocked(record);
      if ((record.phase !== "promoted_observed" && record.phase !== "projection_committed") || !record.binding) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_RECOVERY_UNAVAILABLE",
          "Only durable post-promotion state can mint a local provisioning recovery lease",
        );
      }
      await this.guardResidentLifecycleMaterializationUnlocked(() =>
        this.materializeActivatingResidentBindingUnlocked(record),
      );
      return this.createResidentLifecycleProjectionLease(record, record.updatedAt);
    });
  }

  async commitResidentProvision(leaseValue: ResidentLifecycleProjectionLease): Promise<ResidentSessionBinding> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const lease = this.validateResidentLifecycleProjectionLease(leaseValue);
      const record = await this.readResidentLifecycleOperationUnlocked(lease.operationId);
      if (
        !record ||
        record.kind !== "provision" ||
        record.phase !== "projection_committed" ||
        !record.binding ||
        !record.projectionProof ||
        record.operationFingerprint !== lease.operationFingerprint ||
        !isDeepStrictEqual(record.binding, lease.binding)
      ) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_PROJECTION_PROOF_REQUIRED",
          "Provisioning can commit only from its exact durable projection proof",
        );
      }
      await this.assertResidentLifecycleAuthorityCurrentUnlocked(record);
      await this.assertResidentLifecycleProjectionProofUnlocked(record);
      await this.guardResidentLifecycleMaterializationUnlocked(async () => {
        await this.materializeActiveResidentBindingUnlocked(record);
        await this.injectResidentLifecycleFault("after_active_binding", record.operationId);
      });
      const committedAt = now();
      const committed = ResidentLifecycleOperationRecordSchema.parse({
        ...record,
        phase: "committed",
        updatedAt: committedAt,
        terminalAt: committedAt,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(committed, "after_committed");
      this.residentLifecycleProjectionLeases.delete(lease as object);
      return validateResidentSessionBinding(record.binding);
    });
  }

  async prepareResidentEnd(
    inputValue: ResidentLifecycleOperationInput,
    bindingValue: ResidentSessionBinding,
  ): Promise<ResidentLifecycleStatus> {
    const input = ResidentLifecycleOperationInputSchema.parse(inputValue);
    const binding = validateResidentSessionBinding(bindingValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const existing = await this.resolveExactResidentLifecycleOperationUnlocked("end", input, { optional: true });
      if (existing) {
        if (!existing.binding || !isDeepStrictEqual(existing.binding, binding)) {
          throw new HostStoreError(
            "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
            "This resident end operation is already bound to a different exact resident binding",
          );
        }
        await this.guardResidentLifecycleMaterializationUnlocked(() =>
          this.materializeEndingResidentBindingRevocationUnlocked(existing),
        );
        return residentLifecycleStatus(existing);
      }
      const authority = await this.resolveResidentLifecycleAuthorityUnlocked(input);
      await this.assertNoResidentLifecycleOperationUnlocked(input.threadId);
      await this.assertNoResidentDispatchTransitionUnlocked(
        input.threadId,
        "Resident end cannot begin while a dispatch is unresolved",
      );
      this.assertBindingMatchesLifecycleAuthority(binding, authority);
      await this.assertExactActiveResidentBindingUnlocked(binding);
      const timestamp = now();
      const record = ResidentLifecycleOperationRecordSchema.parse({
        version: 1,
        kind: "end",
        operationId: input.operationId,
        input,
        operationFingerprint: residentLifecycleOperationFingerprint("end", input, authority.authorityDigest),
        authority,
        phase: "ending",
        preparedAt: timestamp,
        updatedAt: timestamp,
        binding,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(record, "after_ending");
      await this.guardResidentLifecycleMaterializationUnlocked(async () => {
        await this.materializeEndingResidentBindingRevocationUnlocked(record);
        await this.injectResidentLifecycleFault("after_binding_revoked", record.operationId);
      });
      return residentLifecycleStatus(record);
    });
  }

  async beginResidentKill(inputValue: ResidentLifecycleOperationInput): Promise<ResidentKillLease> {
    const input = ResidentLifecycleOperationInputSchema.parse(inputValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const record = await this.requireExactResidentLifecycleOperationUnlocked("end", input);
      await this.assertResidentLifecycleAuthorityCurrentUnlocked(record);
      if (record.phase !== "ending" || !record.binding) {
        throw residentLifecycleMutationAlreadyCrossed(record, "resident kill");
      }
      await this.assertResidentBindingRevokedForOperationUnlocked(record);
      const dispatchStartedAt = now();
      const dispatching = ResidentLifecycleOperationRecordSchema.parse({
        ...record,
        phase: "kill_dispatching",
        updatedAt: dispatchStartedAt,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(dispatching, "after_kill_dispatching");
      const lease = Object.freeze({
        [residentKillLeaseBrand]: true as const,
        leaseVersion: 1 as const,
        operationId: record.operationId,
        operationFingerprint: record.operationFingerprint,
        binding: validateResidentSessionBinding(record.binding),
        dispatchStartedAt,
      });
      this.residentKillLeases.add(lease);
      return lease;
    });
  }

  async failResidentKillBeforeEffect(leaseValue: ResidentKillLease): Promise<ResidentLifecycleStatus> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const lease = this.validateResidentKillLease(leaseValue);
      const record = await this.requireLifecycleLeaseRecordUnlocked(lease, "end", "kill_dispatching");
      const retryable = ResidentLifecycleOperationRecordSchema.parse({
        ...record,
        phase: "ending",
        updatedAt: now(),
      });
      await this.writeResidentLifecycleBoundaryUnlocked(retryable, "after_mutation_failed_before_effect");
      this.residentKillLeases.delete(lease as object);
      return residentLifecycleStatus(retryable);
    });
  }

  async quarantineResidentLifecycleOutcomeUnknown(
    leaseValue: ResidentOwnedCreateLease | ResidentPromotionLease | ResidentKillLease,
  ): Promise<ResidentLifecycleStatus> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      let record: ResidentLifecycleOperationRecord;
      let lease: ResidentOwnedCreateLease | ResidentPromotionLease | ResidentKillLease;
      if (this.residentOwnedCreateLeases.has(leaseValue as object)) {
        lease = this.validateResidentOwnedCreateLease(leaseValue as ResidentOwnedCreateLease);
        record = await this.requireLifecycleLeaseRecordUnlocked(
          lease,
          "provision",
          "owned_create_dispatching",
        );
        this.residentOwnedCreateLeases.delete(lease as object);
      } else if (this.residentPromotionLeases.has(leaseValue as object)) {
        lease = this.validateResidentPromotionLease(leaseValue as ResidentPromotionLease);
        record = await this.requireLifecycleLeaseRecordUnlocked(
          lease,
          "provision",
          "promotion_dispatching",
        );
        this.residentPromotionLeases.delete(lease as object);
      } else {
        lease = this.validateResidentKillLease(leaseValue as ResidentKillLease);
        record = await this.requireLifecycleLeaseRecordUnlocked(lease, "end", "kill_dispatching");
        this.residentKillLeases.delete(lease as object);
      }
      const quarantined = ResidentLifecycleOperationRecordSchema.parse({
        ...record,
        phase: "quarantined",
        quarantinedFrom: record.phase,
        quarantineReason: "external_outcome_unknown",
        updatedAt: now(),
      });
      await this.writeResidentLifecycleBoundaryUnlocked(quarantined, "after_quarantined");
      return residentLifecycleStatus(quarantined);
    });
  }

  async acknowledgeResidentKill(leaseValue: ResidentKillLease): Promise<ResidentLifecycleStatus> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const lease = this.validateResidentKillLease(leaseValue);
      const record = await this.readResidentLifecycleOperationUnlocked(lease.operationId);
      if (
        !record ||
        record.kind !== "end" ||
        record.phase !== "kill_dispatching" ||
        !record.binding ||
        record.operationFingerprint !== lease.operationFingerprint ||
        record.updatedAt !== lease.dispatchStartedAt ||
        !isDeepStrictEqual(record.binding, lease.binding)
      ) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_LEASE_STALE",
          "The kill lease no longer matches its exact durable lifecycle operation",
        );
      }
      const acknowledgedAt = now();
      const acknowledged = ResidentLifecycleOperationRecordSchema.parse({
        ...record,
        phase: "kill_acknowledged",
        updatedAt: acknowledgedAt,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(acknowledged, "after_kill_acknowledged");
      await this.guardResidentLifecycleMaterializationUnlocked(async () => {
        await this.materializeCompletedResidentBindingUnlocked(acknowledged);
        await this.injectResidentLifecycleFault("after_completed_binding", record.operationId);
      });
      const completedAt = now();
      const completed = ResidentLifecycleOperationRecordSchema.parse({
        ...acknowledged,
        phase: "completed",
        updatedAt: completedAt,
        terminalAt: completedAt,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(completed, "after_completed");
      this.residentKillLeases.delete(lease as object);
      return residentLifecycleStatus(completed);
    });
  }

  async detachResidentLifecycle(
    inputValue: ResidentLifecycleOperationInput,
    bindingValue: ResidentSessionBinding,
  ): Promise<ResidentLifecycleStatus> {
    const input = ResidentLifecycleOperationInputSchema.parse(inputValue);
    const binding = validateResidentSessionBinding(bindingValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const existing = await this.resolveExactResidentLifecycleOperationUnlocked("detach", input, { optional: true });
      if (existing) {
        if (!existing.binding || !isDeepStrictEqual(existing.binding, binding)) {
          throw new HostStoreError(
            "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
            "This resident detach operation is already bound to a different exact resident binding",
          );
        }
        await this.guardResidentLifecycleMaterializationUnlocked(() =>
          this.materializeDetachedResidentBindingUnlocked(existing),
        );
        return residentLifecycleStatus(existing);
      }
      const authority = await this.resolveResidentLifecycleAuthorityUnlocked(input);
      await this.assertNoResidentLifecycleOperationUnlocked(input.threadId);
      await this.assertNoResidentDispatchTransitionUnlocked(
        input.threadId,
        "Resident detach cannot begin while a dispatch is unresolved",
      );
      this.assertBindingMatchesLifecycleAuthority(binding, authority);
      await this.assertExactActiveResidentBindingUnlocked(binding);
      const timestamp = now();
      const record = ResidentLifecycleOperationRecordSchema.parse({
        version: 1,
        kind: "detach",
        operationId: input.operationId,
        input,
        operationFingerprint: residentLifecycleOperationFingerprint("detach", input, authority.authorityDigest),
        authority,
        phase: "detached",
        preparedAt: timestamp,
        updatedAt: timestamp,
        terminalAt: timestamp,
        binding,
      });
      await this.writeResidentLifecycleBoundaryUnlocked(record, "after_detached");
      await this.guardResidentLifecycleMaterializationUnlocked(async () => {
        await this.materializeDetachedResidentBindingUnlocked(record);
        await this.injectResidentLifecycleFault("after_detached_binding", record.operationId);
      });
      return residentLifecycleStatus(record);
    });
  }

  /**
   * Reports whether the public thread snapshot is backed by the private cursor
   * lineage for this exact active resident authority. The gateway additionally
   * requires a fresh post-attach publication epoch before granting readiness.
   */
  async hasExactResidentProjection(bindingValue: ResidentSessionBinding): Promise<boolean> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const binding = validateResidentSessionBinding(bindingValue);
      const active = (await this.readResidentSessionBindingsUnlocked()).find(
        (candidate) => candidate.threadId === binding.threadId,
      );
      if (
        !active ||
        residentDispatchAuthorityFingerprint(active) !== residentDispatchAuthorityFingerprint(binding)
      ) {
        return false;
      }

      const lineage = await this.readResidentProjectionLineageUnlocked(
        residentProjectionAuthorityFromBinding(binding),
      );
      if (!lineage) return false;
      const snapshot = await this.readSnapshotUnlocked(binding.threadId);
      // Host-owned admission may update status/queue fields after publication,
      // so readiness follows the exact private lineage and its still-current
      // cursor/identity rather than requiring the full public digest to remain
      // byte-equivalent to the last upstream projection.
      return snapshot.thread.threadId === binding.threadId &&
        snapshot.thread.currentLocation.executionGenerationId === binding.executionGenerationId &&
        snapshot.latestCursor.threadId === binding.threadId &&
        snapshot.latestCursor.executionGenerationId === binding.executionGenerationId &&
        snapshot.latestCursor.generation === lineage.current.generation &&
        snapshot.latestCursor.sequence === lineage.current.sequence &&
        snapshot.runtime?.residency === "resident" &&
        snapshot.runtime.activeSessionId === binding.activeSessionId &&
        snapshot.runtime.sessionId === binding.sessionId;
    });
  }

  async persistResidentSessionBinding(bindingValue: ResidentSessionBinding): Promise<void> {
    await this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const binding = validateResidentSessionBinding(bindingValue);
      await this.assertNoResidentLifecycleOperationUnlocked(binding.threadId);
      const scope = await this.currentWorkspaceScopeUnlocked(
        binding.threadId,
        binding.executionGenerationId,
      );
      const workspaceDirectory = await this.resolveWorkspaceDirectoryUnlocked(scope);
      this.assertBindingMatchesScope(binding, scope, workspaceDirectory);
      const canonicalBindingDirectory = await canonicalWorkspaceDirectory(binding.workspaceDirectory);
      if (
        !sameCanonicalPath(binding.workspaceDirectory, canonicalBindingDirectory) ||
        !sameCanonicalPath(canonicalBindingDirectory, workspaceDirectory)
      ) {
        throw new HostStoreError(
          "RESIDENT_BINDING_PATH_MISMATCH",
          "The resident session binding must use the registered canonical workspace path",
        );
      }

      const records = await this.readResidentSessionBindingRecordsUnlocked();
      const existingIndex = records.findIndex(
        (record) => record.state === "active" && record.binding.threadId === binding.threadId,
      );
      const existingRecord = existingIndex >= 0 ? records[existingIndex] : undefined;
      const existing = existingRecord?.state === "active" ? existingRecord.binding : undefined;
      if (
        existing &&
        residentDispatchAuthorityFingerprint(existing) !== residentDispatchAuthorityFingerprint(binding)
      ) {
        await this.assertNoResidentDispatchTransitionUnlocked(
          binding.threadId,
          "Resident binding cannot change while a dispatch is unresolved",
        );
      }
      if (existing && !sameResidentBindingIdentity(existing, binding)) {
        throw new HostStoreError(
          "RESIDENT_BINDING_CONFLICT",
          "The thread is already bound to a different resident session identity",
        );
      }
      const reused = records.find(
        (record) =>
          record !== existingRecord &&
          (record.binding.activeSessionId === binding.activeSessionId ||
            record.binding.sessionId === binding.sessionId ||
            (record.binding.sessionFile !== undefined && record.binding.sessionFile === binding.sessionFile)),
      );
      if (reused) {
        throw new HostStoreError(
          reused.state === "completed" ? "RESIDENT_BINDING_COMPLETED" : "RESIDENT_SESSION_REUSED",
          reused.state === "completed"
            ? "A completed resident session binding cannot be resurrected"
            : "A resident session identity cannot be reused across threads",
        );
      }
      if (existing && isDeepStrictEqual(existing, binding)) return;
      const activeRecord = ResidentSessionBindingRecordSchema.parse({
        state: "active",
        binding,
        ...(existingRecord?.state === "active" && existingRecord.operationId
          ? { operationId: existingRecord.operationId }
          : {}),
      });
      if (existingIndex >= 0) records[existingIndex] = activeRecord;
      else {
        if (records.length >= MAX_RESIDENT_SESSION_BINDINGS) {
          throw new HostStoreError("RESIDENT_BINDING_LIMIT_REACHED", "The resident session binding registry is full");
        }
        records.push(activeRecord);
      }
      await this.writeResidentSessionBindingRecordsUnlocked(records);
    });
  }

  /**
   * Crash-consistently replaces the public snapshot and thread catalog from
   * one exact, active resident binding. Private session paths never cross into
   * either public DTO.
   */
  async publishResidentProjectionSnapshot(
    bindingValue: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
    abortIdleLeaseValue?: ResidentAbortReconciliationLease,
  ): Promise<ThreadProjectionSnapshot> {
    return this.exclusive(() =>
      this.publishResidentProjectionSnapshotUnlocked(bindingValue, projection, abortIdleLeaseValue),
    );
  }

  async publishResidentLifecycleProjection(
    leaseValue: ResidentLifecycleProjectionLease,
    projection: ResidentProjectionSnapshot,
  ): Promise<ThreadProjectionSnapshot> {
    return this.exclusive(async () => {
      const lease = this.validateResidentLifecycleProjectionLease(leaseValue);
      const published = await this.publishResidentProjectionSnapshotUnlocked(
        lease.binding,
        projection,
        undefined,
        lease,
      );
      try {
        await this.injectResidentLifecycleFault("after_projection_publication", lease.operationId);
        const record = await this.readResidentLifecycleOperationUnlocked(lease.operationId);
        if (
          !record ||
          record.kind !== "provision" ||
          (record.phase !== "promoted_observed" && record.phase !== "projection_committed") ||
          !record.binding ||
          record.operationFingerprint !== lease.operationFingerprint ||
          !isDeepStrictEqual(record.binding, lease.binding)
        ) {
          throw new HostStoreError(
            "RESIDENT_LIFECYCLE_LEASE_STALE",
            "The lifecycle projection lease no longer matches its exact durable operation",
          );
        }
        const proof = ResidentLifecycleProjectionProofSchema.parse({
          bindingFingerprint: residentDispatchAuthorityFingerprint(record.binding),
          projectionDigest: residentProjectionDigest(projection),
          cursorGeneration: projection.cursor.generation,
          cursorSequence: projection.cursor.sequence,
          publishedAt: published.generatedAt,
        });
        const projectionCommitted = ResidentLifecycleOperationRecordSchema.parse({
          ...record,
          phase: "projection_committed",
          projectionProof: proof,
          updatedAt: published.generatedAt,
        });
        await this.writeResidentLifecycleBoundaryUnlocked(
          projectionCommitted,
          "after_projection_committed",
        );
        return published;
      } catch (error) {
        this.initialized = false;
        throw error;
      }
    });
  }

  private async publishResidentProjectionSnapshotUnlocked(
    bindingValue: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
    abortIdleLeaseValue?: ResidentAbortReconciliationLease,
    lifecycleLeaseValue?: ResidentLifecycleProjectionLease,
  ): Promise<ThreadProjectionSnapshot> {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const binding = validateResidentSessionBinding(bindingValue);
      const lifecycleRecord = lifecycleLeaseValue
        ? await this.assertResidentLifecycleProjectionLeaseAuthorityUnlocked(lifecycleLeaseValue, binding)
        : undefined;
      if (lifecycleRecord && abortIdleLeaseValue) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_AUTHORITY_CONFLICT",
          "An activating projection cannot use an active-session reconciliation lease",
        );
      }
      const scope = await this.currentWorkspaceScopeUnlocked(
        binding.threadId,
        binding.executionGenerationId,
      );
      const workspaceDirectory = await this.resolveWorkspaceDirectoryUnlocked(scope);
      this.assertBindingMatchesScope(binding, scope, workspaceDirectory);

      const records = await this.readResidentSessionBindingRecordsUnlocked();
      const active = records.find(
        (record) => record.state === "active" && record.binding.threadId === binding.threadId,
      );
      const activating = lifecycleRecord
        ? records.find(
            (record) =>
              record.state === "activating" &&
              record.operationId === lifecycleRecord.operationId &&
              record.binding.threadId === binding.threadId,
          )
        : undefined;
      const projectionBinding = active ?? activating;
      if (!projectionBinding) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_BINDING_NOT_FOUND",
          lifecycleRecord
            ? "No exact activating resident binding exists for this lifecycle projection"
            : "No active resident binding exists for this projection",
        );
      }
      if (!isDeepStrictEqual(projectionBinding.binding, binding)) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_BINDING_MISMATCH",
          lifecycleRecord
            ? "Only the exact lifecycle candidate may publish its activating projection"
            : "Only the exact active resident binding may publish a projection",
        );
      }
      if (
        projection.projectionVersion !== 1 ||
        projection.identity.activeSessionId !== binding.activeSessionId ||
        projection.identity.sessionId !== binding.sessionId ||
        projection.identity.sessionFile !== binding.sessionFile ||
        !sameCanonicalPath(projection.identity.workspaceDirectory, binding.workspaceDirectory)
      ) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_IDENTITY_MISMATCH",
          "The resident projection does not belong to its durable binding",
        );
      }
      const abortIdleProofAttempt = abortIdleLeaseValue
        ? await this.assertResidentAbortIdleProjectionAuthorityUnlocked(
            validateResidentAbortReconciliationLease(abortIdleLeaseValue),
            binding,
            projection,
          )
        : undefined;

      const source = await this.readSnapshotUnlocked(binding.threadId);
      if (
        source.thread.threadId !== binding.threadId ||
        source.thread.currentLocation.executionGenerationId !== binding.executionGenerationId
      ) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_AUTHORITY_MISMATCH",
          "The durable thread projection belongs to a different execution authority",
        );
      }
      const threads = await this.readThreadsUnlocked();
      const threadIndex = threads.findIndex((thread) => thread.threadId === binding.threadId);
      const catalogThread = threadIndex >= 0 ? threads[threadIndex] : undefined;
      if (!catalogThread || !isDeepStrictEqual(catalogThread, source.thread)) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_CATALOG_MISMATCH",
          "The durable snapshot and thread catalog must agree before publishing resident state",
        );
      }
      const projectionDigest = residentProjectionDigest(projection);
      const authority = residentProjectionAuthorityFromBinding(binding);
      const authorityId = residentProjectionAuthorityId(authority);
      const previousLineage = await this.readResidentProjectionLineageUnlocked(authority);
      let nextLineage: ResidentProjectionCursorLineage;
      if (!previousLineage) {
        await this.assertResidentProjectionLineageCapacityUnlocked();
        nextLineage = ResidentProjectionCursorLineageSchema.parse({
          authorityId,
          authority,
          current: {
            generation: projection.cursor.generation,
            sequence: projection.cursor.sequence,
            digest: projectionDigest,
          },
          retiredGenerations: [],
        });
      } else if (projection.cursor.generation === previousLineage.current.generation) {
        if (projection.cursor.sequence < previousLineage.current.sequence) {
          throw new HostStoreError(
            "RESIDENT_PROJECTION_CURSOR_REGRESSION",
            "Resident projection sequence regressed within the current daemon generation",
          );
        }
        if (projection.cursor.sequence === previousLineage.current.sequence) {
          if (projectionDigest !== previousLineage.current.digest) {
            if (!abortIdleProofAttempt) {
              throw new HostStoreError(
                "RESIDENT_PROJECTION_CURSOR_CONFLICT",
                "The same resident projection cursor was reused for different authoritative content",
              );
            }
            nextLineage = ResidentProjectionCursorLineageSchema.parse({
              ...previousLineage,
              current: {
                ...previousLineage.current,
                digest: projectionDigest,
              },
            });
          } else {
            if (
              source.latestCursor.generation !== projection.cursor.generation ||
              source.latestCursor.sequence !== projection.cursor.sequence
            ) {
              throw new HostStoreError(
                "RESIDENT_PROJECTION_LINEAGE_DIVERGED",
                "Resident projection lineage and public snapshot no longer identify the same cursor",
              );
            }
            if (abortIdleProofAttempt && residentSnapshotReportsActivity(source)) {
              throw new HostStoreError(
                "RESIDENT_ABORT_IDLE_PROJECTION_CONFLICT",
                "The durable projection remained active despite matching the acknowledged Stop idle proof digest",
              );
            }
            return source;
          }
        } else {
          nextLineage = ResidentProjectionCursorLineageSchema.parse({
            ...previousLineage,
            current: {
              generation: projection.cursor.generation,
              sequence: projection.cursor.sequence,
              digest: projectionDigest,
            },
          });
        }
      } else {
        if (previousLineage.retiredGenerations.includes(projection.cursor.generation)) {
          throw new HostStoreError(
            "RESIDENT_PROJECTION_GENERATION_RETIRED",
            "A retired resident daemon cursor generation cannot publish again",
          );
        }
        if (previousLineage.retiredGenerations.length >= MAX_RETIRED_RESIDENT_CURSOR_GENERATIONS) {
          throw new HostStoreError(
            "RESIDENT_PROJECTION_RETIREMENT_LIMIT",
            "Resident cursor retirement history is full; publication fails closed",
          );
        }
        nextLineage = ResidentProjectionCursorLineageSchema.parse({
          ...previousLineage,
          current: {
            generation: projection.cursor.generation,
            sequence: projection.cursor.sequence,
            digest: projectionDigest,
          },
          retiredGenerations: [
            ...previousLineage.retiredGenerations,
            previousLineage.current.generation,
          ],
        });
      }
      const generatedAt = now();
      const latestCursor = {
        threadId: binding.threadId,
        executionGenerationId: binding.executionGenerationId,
        generation: projection.cursor.generation,
        sequence: projection.cursor.sequence,
      };
      const runtimeActive = residentPrivateProjectionReportsActivity(projection);
      const projectedStatus = runtimeActive
        ? "running"
        : source.thread.status === "complete" || source.thread.status === "failed"
          ? source.thread.status
          : "idle";
      const threadValue: ThreadSummary = {
        ...source.thread,
        status: projectedStatus,
        updatedAt: generatedAt,
        lastKnownCursor: latestCursor,
      };
      if (projection.runtime.recap === undefined) delete threadValue.recap;
      else threadValue.recap = projection.runtime.recap;
      const thread = ThreadSummarySchema.parse(threadValue);
      const published = ThreadProjectionSnapshotSchema.parse({
        snapshotVersion: SNAPSHOT_VERSION,
        generatedAt,
        thread,
        transcriptBlockIndex: projection.transcript.map((block) => ({
          blockId: block.blockId,
          kind: block.kind,
          sequence: block.sequence,
          byteLength: Buffer.byteLength(block.text, "utf8"),
          materialized: true,
        })),
        materializedRecentBlocks: projection.transcript,
        ...(projection.stream ? { inProgressStream: projection.stream } : {}),
        // Prime v0.7 exposes bounded queue counts but no stable host command
        // identities. Once its exact snapshot is authoritative, speculative
        // host admission IDs must not survive as phantom queued work.
        queueState: { pendingCommandIds: [], paused: false },
        approvals: source.approvals,
        childAgents: projection.childAgents,
        goals: projection.goal ? [projection.goal] : [],
        schedules: source.schedules,
        runtime: projection.runtime,
        git: source.git,
        evidence: source.evidence,
        pendingAttention: source.pendingAttention,
        latestCursor,
      });
      const updatedThreads = [...threads];
      updatedThreads[threadIndex] = published.thread;
      const promptLock = await this.findResidentPromptLockUnlocked(binding.threadId);
      if (
        promptLock &&
        !isDeepStrictEqual(residentProjectionAuthorityFromBinding(promptLock.binding), authority)
      ) {
        throw new HostStoreError(
          "RESIDENT_PROMPT_LOCK_AUTHORITY_MISMATCH",
          "The resident prompt ownership lock belongs to a different stable session authority",
        );
      }
      const retiredPromptAttempts: readonly ResidentDispatchAttempt[] = [];
      const transaction = ResidentProjectionTransactionSchema.parse({
        version: 1,
        kind: "resident_projection_publication",
        transactionId: abortIdleProofAttempt && previousLineage &&
          previousLineage.current.generation === projection.cursor.generation &&
          previousLineage.current.sequence === projection.cursor.sequence
          ? deterministicId(
              "resident-abort-idle-projection",
              abortIdleProofAttempt.attemptId,
              projection.cursor.generation,
              String(projection.cursor.sequence),
            )
          : deterministicId(
              "resident-projection",
              binding.threadId,
              binding.executionGenerationId,
              projection.cursor.generation,
              String(projection.cursor.sequence),
            ),
        preparedAt: generatedAt,
        binding,
        ...(lifecycleRecord ? { lifecycleOperationId: lifecycleRecord.operationId } : {}),
        projectionDigest,
        previousLineage,
        nextLineage,
        retiredPromptAttempts,
        ...(abortIdleProofAttempt && previousLineage &&
        previousLineage.current.generation === projection.cursor.generation &&
        previousLineage.current.sequence === projection.cursor.sequence
          ? { abortIdleProofAttempt }
          : {}),
        snapshot: published,
        threadsFile: ThreadFileSchema.parse({ version: 1, threads: updatedThreads }),
      });
      try {
        await atomicWriteJson(
          this.residentProjectionTransactionPath(binding),
          transaction,
          MAX_RESIDENT_PROJECTION_TRANSACTION_BYTES,
        );
        await this.injectResidentProjectionFault("after_prepare", transaction.transactionId);
        await this.materializeResidentProjectionTransactionUnlocked(transaction, true);
      } catch (error) {
        // Readers must never observe a half-published resident projection from
        // this process. Startup replay is the only path back to a live store.
        this.initialized = false;
        throw error;
      }
      return published;
  }

  async completeResidentSessionBinding(bindingValue: ResidentSessionBinding): Promise<void> {
    await this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const binding = validateResidentSessionBinding(bindingValue);
      await this.assertNoResidentLifecycleOperationUnlocked(binding.threadId);
      const scope = await this.currentWorkspaceScopeUnlocked(
        binding.threadId,
        binding.executionGenerationId,
      );
      const workspaceDirectory = await this.resolveWorkspaceDirectoryUnlocked(scope);
      this.assertBindingMatchesScope(binding, scope, workspaceDirectory);
      const records = await this.readResidentSessionBindingRecordsUnlocked();
      const existingIndex = records.findIndex(
        (record) => record.state === "active" && record.binding.threadId === binding.threadId,
      );
      if (existingIndex < 0) {
        const completed = records.find(
          (record) => record.state === "completed" && isDeepStrictEqual(record.binding, binding),
        );
        if (completed) return;
        throw new HostStoreError(
          "RESIDENT_BINDING_NOT_FOUND",
          "No exact active or completed resident session binding exists",
        );
      }
      const existing = records[existingIndex];
      if (existing?.state !== "active" || !isDeepStrictEqual(existing.binding, binding)) {
        throw new HostStoreError(
          "RESIDENT_BINDING_CONFLICT",
          "Only the exact current resident session binding may be completed",
        );
      }
      if (existing.operationId) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_OPERATION_REQUIRED",
          "A lifecycle-managed resident binding can be completed only through its exact durable end operation",
        );
      }
      await this.assertNoResidentDispatchTransitionUnlocked(
        binding.threadId,
        "Resident binding cannot complete while a dispatch is unresolved",
      );
      records[existingIndex] = ResidentSessionBindingRecordSchema.parse({
        state: "completed",
        binding: existing.binding,
        completedAt: now(),
      });
      await this.writeResidentSessionBindingRecordsUnlocked(records);
    });
  }

  /**
   * Resolve an already-known command before callers consult mutable runtime or
   * gateway state. `undefined` means the exact identity is genuinely unknown;
   * every reserved-key mismatch or unverifiable legacy receipt fails closed.
   */
  async preflightKnownCommand(commandValue: CommandEnvelope): Promise<CommandReceipt | undefined> {
    const command = CommandEnvelopeSchema.parse(commandValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      const durableIdentity = await this.resolveCommandIdentityUnlocked(command);
      const pending = await this.readAdmissionTransactionUnlocked(command);
      if (pending) {
        if (!isDeepStrictEqual(pending.command, command)) {
          throw new HostStoreError("COMMAND_ID_REUSED", "This command identity is already bound to another envelope");
        }
        try {
          await this.materializeAdmissionTransactionUnlocked(pending, true);
        } catch (error) {
          this.initialized = false;
          throw error;
        }
        return pending.receipt;
      }

      const receipt = await this.readReceiptUnlocked(command);
      if (receipt) {
        if (!durableIdentity) {
          throw new HostStoreError(
            "COMMAND_IDENTITY_UNVERIFIABLE",
            "This legacy receipt has no durable exact command envelope and cannot authorize a retry",
          );
        }
        this.assertReceiptMatchesCommand(receipt, command);
        return receipt;
      }
      if (durableIdentity) {
        throw new HostStoreError(
          "COMMAND_IDENTITY_ORPHANED",
          "The durable command identity has no matching transaction or receipt",
        );
      }
      return undefined;
    });
  }

  async admitCommand(
    commandValue: CommandEnvelope,
    canDispatchLive = false,
    dispatcherUnavailable?: StructuredError,
  ): Promise<CommandAdmission> {
    const command = CommandEnvelopeSchema.parse(commandValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      const durableIdentity = await this.resolveCommandIdentityUnlocked(command);
      const pending = await this.readAdmissionTransactionUnlocked(command);
      if (pending) {
        if (!isDeepStrictEqual(pending.command, command)) {
          throw new HostStoreError("COMMAND_ID_REUSED", "This command identity is already bound to another payload");
        }
        try {
          await this.materializeAdmissionTransactionUnlocked(pending, true);
        } catch (error) {
          // A partially materialized transaction must not share a live store
          // with readers. Fail closed until initialize() performs recovery.
          this.initialized = false;
          throw error;
        }
        return { receipt: pending.receipt, duplicate: true };
      }
      const existing = await this.readReceiptUnlocked(command);
      if (existing) {
        if (!durableIdentity) {
          throw new HostStoreError(
            "COMMAND_IDENTITY_UNVERIFIABLE",
            "This legacy receipt has no durable exact command envelope and cannot authorize a duplicate",
          );
        }
        this.assertReceiptMatchesCommand(existing, command);
        return { receipt: existing, duplicate: true };
      }
      if (durableIdentity) {
        throw new HostStoreError(
          "COMMAND_IDENTITY_ORPHANED",
          "The durable command identity has no matching transaction or receipt",
        );
      }
      const transaction = await this.prepareAdmissionTransactionUnlocked(
        command,
        canDispatchLive,
        dispatcherUnavailable,
      );
      try {
        await atomicWriteJson(
          this.admissionTransactionPath(command),
          transaction,
          MAX_ADMISSION_TRANSACTION_BYTES,
        );
        await this.injectAdmissionFault("after_prepare", transaction.transactionId);
        await this.materializeAdmissionTransactionUnlocked(transaction, true);
      } catch (error) {
        this.initialized = false;
        throw error;
      }
      return { receipt: transaction.receipt, duplicate: false };
    });
  }

  async updateCommandReceipt(
    commandValue: CommandEnvelope,
    update: Pick<CommandReceipt, "status"> & Partial<Pick<CommandReceipt, "message" | "error" | "queuePosition">>,
  ): Promise<CommandReceipt> {
    const command = CommandEnvelopeSchema.parse(commandValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      if (!(await this.resolveCommandIdentityUnlocked(command))) {
        throw new HostStoreError(
          "COMMAND_IDENTITY_UNVERIFIABLE",
          "The command receipt cannot change without its exact durable envelope",
        );
      }
      if (await this.readModelSelectionAttemptUnlocked(command)) {
        throw new HostStoreError(
          "MODEL_SELECTION_RECEIPT_PATH_REQUIRED",
          "Resident model selection must use its non-replayable receipt state machine",
        );
      }
      if (await this.readResidentDispatchAttemptUnlocked(command)) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_RECEIPT_PATH_REQUIRED",
          "Resident prompt and abort dispatch must use their exact lease receipt state machine",
        );
      }
      const current = await this.readReceiptUnlocked(command);
      if (!current) throw new HostStoreError("COMMAND_NOT_FOUND", "No receipt exists for this command identity");
      this.assertReceiptMatchesCommand(current, command);
      const receipt = CommandReceiptSchema.parse({
        ...current,
        ...update,
        updatedAt: now(),
      });
      await atomicWriteJson(this.receiptPath(command), receipt);
      await this.appendCommandJournalUnlocked(
        {
          deviceId: command.deviceId,
          commandId: command.commandId,
          threadId: current.threadId,
          command: { kind: "gateway" },
        },
        receipt.status,
        receipt.message,
      );
      return receipt;
    });
  }

  /**
   * Definitively retires an admitted resident attempt when local authority
   * revalidation fails before a dispatch lease is issued. This path cannot act
   * after the no-replay boundary has been crossed.
   */
  async failResidentDispatchBeforeStart(
    commandValue: CommandEnvelope,
    errorValue: StructuredError,
  ): Promise<CommandReceipt> {
    const command = ResidentDispatchCommandSchema.parse(commandValue);
    const error = StructuredErrorSchema.parse(errorValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      const identity = await this.resolveCommandIdentityUnlocked(command);
      const attempt = await this.readResidentDispatchAttemptUnlocked(command);
      const current = await this.readReceiptUnlocked(command);
      if (
        !identity ||
        !attempt ||
        !current ||
        attempt.state !== "admitted" ||
        current.status !== "admitted" ||
        !isDeepStrictEqual(identity.command, command) ||
        !isDeepStrictEqual(attempt.command, command)
      ) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_NOT_ADMITTED",
          "Only an exact pre-dispatch resident admission may be failed locally",
        );
      }
      this.assertReceiptMatchesCommand(current, command);
      const settledAt = now();
      const receipt = CommandReceiptSchema.parse({
        ...current,
        status: "failed",
        queuePosition: undefined,
        message: error.message.slice(0, 1_024),
        error,
        updatedAt: settledAt,
      });
      const settled = ResidentDispatchAttemptSchema.parse({
        ...attempt,
        state: "settled",
        updatedAt: settledAt,
        settledAt,
        finalReceipt: receipt,
      });
      try {
        await atomicWriteJson(
          this.residentDispatchAttemptPath(command),
          settled,
          MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES,
        );
        await this.injectResidentDispatchFault("after_settled_attempt", attempt.attemptId);
        await atomicWriteJson(this.receiptPath(command), receipt);
        await this.injectResidentDispatchFault("after_settled_receipt", attempt.attemptId);
        await this.appendResidentDispatchJournalUnlocked(
          command,
          "failed",
          receipt.updatedAt,
          receipt.message,
          "failed-before-start",
        );
        await this.injectResidentDispatchFault("after_settled_journal", attempt.attemptId);
        await rm(this.residentDispatchAttemptPath(command), { force: true });
      } catch (cause) {
        this.initialized = false;
        throw cause;
      }
      return receipt;
    });
  }

  /**
   * Durably crosses the one-way boundary after which an exact resident prompt
   * or abort may be invoked upstream. The returned lease is process-local,
   * immutable, and bound to the complete command and resident-session record.
   */
  async beginResidentDispatch(commandValue: CommandEnvelope): Promise<ResidentDispatchLease> {
    const command = ResidentDispatchCommandSchema.parse(commandValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      const identity = await this.resolveCommandIdentityUnlocked(command);
      if (!identity) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_IDENTITY_MISSING",
          "Resident dispatch requires the exact durable command envelope",
        );
      }
      const attempt = await this.readResidentDispatchAttemptUnlocked(command);
      if (!attempt || !isDeepStrictEqual(attempt.command, command)) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_MISSING",
          "No exact durable resident prompt or abort admission exists for this command",
        );
      }
      const receipt = await this.readReceiptUnlocked(command);
      if (!receipt) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_RECEIPT_MISSING",
          "The resident dispatch attempt has no durable command receipt",
        );
      }
      this.assertReceiptMatchesCommand(receipt, command);
      if (receipt.status !== "admitted" || attempt.state !== "admitted") {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ALREADY_STARTED",
          "This resident command cannot cross its dispatch boundary again",
        );
      }

      const latestSnapshot = await this.readSnapshotUnlocked(command.threadId);
      const promptLock = await this.findResidentPromptLockUnlocked(command.threadId);
      if (command.command.kind === "prompt") {
        if (!promptLock || !isDeepStrictEqual(promptLock, attempt)) {
          throw new HostStoreError(
            "RESIDENT_PROMPT_LOCK_CONFLICT",
            "The admitted prompt no longer owns the exact resident dispatch lock",
          );
        }
        if (residentSnapshotReportsActivity(latestSnapshot)) {
          throw new HostStoreError(
            "RESIDENT_SESSION_BUSY",
            "The authoritative resident projection became active before prompt dispatch",
            true,
          );
        }
      } else if (
        !residentSnapshotReportsActivity(latestSnapshot) &&
        (!promptLock || !residentPromptAttemptRetainsLock(promptLock))
      ) {
        throw promptLock
          ? new HostStoreError(
              "RESIDENT_PROMPT_DELIVERY_PENDING",
              "The admitted prompt has not reached an acknowledged resident dispatch boundary",
              true,
            )
          : new HostStoreError(
              "RESIDENT_SESSION_IDLE",
              "The resident session became idle before the stop request crossed dispatch",
            );
      }

      const binding = await this.resolveResidentDispatchBindingUnlocked(command);
      const fingerprint = residentDispatchAuthorityFingerprint(binding);
      if (fingerprint !== attempt.bindingFingerprint) {
        throw new HostStoreError(
          "RESIDENT_BINDING_CONFLICT",
          "The resident session binding changed after command admission",
        );
      }

      const dispatchStartedAt = now();
      const dispatching = ResidentDispatchAttemptSchema.parse({
        ...attempt,
        // A verified reconnect may refresh mutable supervisor metadata while
        // preserving the stable dispatch authority fingerprint.
        binding,
        bindingFingerprint: fingerprint,
        state: "dispatching",
        updatedAt: dispatchStartedAt,
        dispatchStartedAt,
      });
      const dispatchingReceipt = CommandReceiptSchema.parse({
        ...receipt,
        // Crossing the private no-replay boundary is not an upstream
        // acknowledgement. Public callers continue to see admitted until the
        // exact Prime mutation settles.
        status: "admitted",
        queuePosition: undefined,
        message: command.command.kind === "prompt"
          ? "Delivering the prompt to the resident Prime Agent session"
          : "Delivering the stop request to the resident Prime Agent session",
        error: undefined,
        updatedAt: dispatchStartedAt,
      });
      try {
        // This marker is the one-way no-replay boundary. A restart after it is
        // necessarily uncertain even if the caller had not yet reached Prime.
        await atomicWriteJson(
          this.residentDispatchAttemptPath(command),
          dispatching,
          MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES,
        );
        await this.injectResidentDispatchFault("after_dispatch_attempt", attempt.attemptId);
        await atomicWriteJson(this.receiptPath(command), dispatchingReceipt);
        await this.injectResidentDispatchFault("after_dispatch_receipt", attempt.attemptId);
        await this.appendResidentDispatchJournalUnlocked(
          command,
          "admitted",
          dispatchingReceipt.updatedAt,
          dispatchingReceipt.message,
          "dispatching",
        );
        await this.injectResidentDispatchFault("after_dispatch_journal", attempt.attemptId);
      } catch (error) {
        this.initialized = false;
        throw error;
      }
      return createResidentDispatchLease(dispatching);
    });
  }

  /**
   * Persists an upstream acknowledgement before retiring the non-replayable
   * marker. If hostd stops during this method, startup completes only these
   * local receipt writes and never invokes Prime Agent again.
   */
  async finalizeResidentDispatch(
    leaseValue: ResidentDispatchLease,
    update: Pick<CommandReceipt, "status"> & Partial<Pick<CommandReceipt, "message" | "error">>,
  ): Promise<CommandReceipt> {
    const lease = validateResidentDispatchLease(leaseValue);
    if (
      update.status !== "running" &&
      update.status !== "completed" &&
      update.status !== "failed" &&
      update.status !== "uncertain"
    ) {
      throw new HostStoreError(
        "RESIDENT_DISPATCH_STATUS_INVALID",
        "Resident dispatch may settle only as running, completed, failed, or uncertain",
      );
    }
    if (lease.command.command.kind === "abort" && update.status === "completed") {
      throw new HostStoreError(
        "RESIDENT_DISPATCH_STATUS_INVALID",
        "A Stop may complete only after the dedicated authoritative idle-observation proof",
      );
    }
    if (lease.command.command.kind === "prompt" && update.status === "completed") {
      throw new HostStoreError(
        "RESIDENT_DISPATCH_STATUS_INVALID",
        "A prompt may complete only after the dedicated authoritative idle-observation proof",
      );
    }

    return this.exclusive(async () => {
      this.assertInitialized();
      const attempt = await this.readResidentDispatchAttemptUnlocked(lease.command);
      if (!attempt || attempt.state !== "dispatching" || !residentDispatchLeaseMatchesAttempt(lease, attempt)) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_LEASE_INVALID",
          "No exact dispatching resident attempt matches this process-local lease",
        );
      }
      const current = await this.readReceiptUnlocked(lease.command);
      if (!current || current.status !== "admitted") {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_RECEIPT_INVALID",
          "The resident dispatch receipt is not at its durable admitted dispatch boundary",
        );
      }
      this.assertReceiptMatchesCommand(current, lease.command);
      const currentBinding = await this.resolveResidentDispatchBindingUnlocked(lease.command);
      if (
        residentDispatchAuthorityFingerprint(currentBinding) !== attempt.bindingFingerprint
      ) {
        throw new HostStoreError(
          "RESIDENT_BINDING_CONFLICT",
          "The resident session binding changed before dispatch acknowledgement",
        );
      }

      const settledAt = now();
      const promptSettlementCursor =
        lease.command.command.kind === "prompt" &&
        (update.status === "running" || update.status === "uncertain")
          ? (await this.readSnapshotUnlocked(lease.command.threadId)).latestCursor
          : undefined;
      const abortSettlementCursor =
        lease.command.command.kind === "abort" &&
        (update.status === "running" || update.status === "uncertain")
          ? (await this.readSnapshotUnlocked(lease.command.threadId)).latestCursor
          : undefined;
      const receipt = CommandReceiptSchema.parse({
        ...current,
        ...update,
        queuePosition: undefined,
        updatedAt: settledAt,
      });
      const settled = ResidentDispatchAttemptSchema.parse({
        ...attempt,
        // Preserve the exact current durable record at the acknowledgement
        // boundary. Stable authority is unchanged, but mutable supervisor
        // metadata may have refreshed since beginResidentDispatch.
        binding: currentBinding,
        state: "settled",
        updatedAt: settledAt,
        settledAt,
        finalReceipt: receipt,
        ...(promptSettlementCursor ? { promptSettlementCursor } : {}),
        ...(abortSettlementCursor ? { abortSettlementCursor } : {}),
      });
      try {
        await atomicWriteJson(
          this.residentDispatchAttemptPath(lease.command),
          settled,
          MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES,
        );
        await this.injectResidentDispatchFault("after_settled_attempt", attempt.attemptId);
        await atomicWriteJson(this.receiptPath(lease.command), receipt);
        await this.injectResidentDispatchFault("after_settled_receipt", attempt.attemptId);
        await this.appendResidentDispatchJournalUnlocked(
          lease.command,
          receipt.status,
          receipt.updatedAt,
          receipt.message,
          "settled",
        );
        await this.injectResidentDispatchFault("after_settled_journal", attempt.attemptId);
        if (!residentDispatchAttemptRetainsReconciliation(settled)) {
          await rm(this.residentDispatchAttemptPath(lease.command), { force: true });
        }
      } catch (error) {
        this.initialized = false;
        throw error;
      }
      return receipt;
    });
  }

  /**
   * Issue a separate read-only reconciliation authority after one exact prompt
   * was definitively acknowledged. The dispatch lease itself cannot be reused
   * for this purpose and uncertain outcomes are deliberately ineligible.
   */
  async beginResidentPromptReconciliation(
    dispatchLeaseValue: ResidentDispatchLease,
  ): Promise<ResidentPromptReconciliationLease> {
    const dispatchLease = validateResidentDispatchLease(dispatchLeaseValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      const attempt = await this.readResidentDispatchAttemptUnlocked(dispatchLease.command);
      if (
        !attempt ||
        attempt.attemptId !== dispatchLease.attemptId ||
        attempt.dispatchStartedAt !== dispatchLease.dispatchStartedAt ||
        attempt.bindingFingerprint !== dispatchLease.bindingFingerprint ||
        !isDeepStrictEqual(attempt.command, dispatchLease.command)
      ) {
        throw new HostStoreError(
          "RESIDENT_PROMPT_RECONCILIATION_INELIGIBLE",
          "No exact settled resident prompt matches this dispatch authority",
        );
      }
      return this.createResidentPromptReconciliationLeaseUnlocked(attempt);
    });
  }

  /** Reissue process-local read-only authorities for eligible locks after restart. */
  async listResidentPromptReconciliationLeases(): Promise<readonly ResidentPromptReconciliationLease[]> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const entries = await readdir(this.paths.residentDispatchAttempts, { withFileTypes: true });
      if (entries.length > MAX_PENDING_RESIDENT_DISPATCH_ATTEMPTS) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_LIMIT",
          "Resident prompt reconciliation cannot inspect an over-capacity attempt store",
        );
      }
      const leases: ResidentPromptReconciliationLease[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          throw new HostStoreError(
            "RESIDENT_DISPATCH_ATTEMPT_INVALID",
            "Resident prompt reconciliation encountered an unexpected attempt entry",
          );
        }
        const attempt = await readJsonFile(
          join(this.paths.residentDispatchAttempts, entry.name),
          ResidentDispatchAttemptSchema,
          { maxBytes: MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES },
        );
        if (
          !attempt ||
          entry.name !== `${storageKey(attempt.command.deviceId, attempt.command.commandId)}.json`
        ) {
          throw new HostStoreError(
            "RESIDENT_DISPATCH_ATTEMPT_INVALID",
            "Resident prompt reconciliation attempt does not match its durable filename",
          );
        }
        if (!residentAcknowledgedPromptAttemptRetainsLock(attempt)) continue;
        leases.push(await this.createResidentPromptReconciliationLeaseUnlocked(attempt));
      }
      return Object.freeze(leases);
    });
  }

  /**
   * Commit one exact same-connection idle proof. This is the only path that may
   * turn an acknowledged prompt receipt from running into completed without a
   * later Prime cursor. Every authority and the current durable idle snapshot
   * are revalidated while the Store mutation lock is held.
   */
  async completeResidentPromptReconciliation(
    leaseValue: ResidentPromptReconciliationLease,
    evidence: ResidentPromptIdleAuthorityEvidence,
  ): Promise<ResidentPromptIdleObservedEvent> {
    const lease = validateResidentPromptReconciliationLease(leaseValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      if (!this.residentPromptReconciliationLeases.has(lease as object)) {
        throw new HostStoreError(
          "RESIDENT_PROMPT_RECONCILIATION_LEASE_INVALID",
          "Prompt idle completion requires a lease issued by this exact HostStore instance",
        );
      }
      const attempt = await this.readResidentDispatchAttemptUnlocked(lease.command);
      if (!attempt || !residentPromptReconciliationLeaseMatchesAttempt(lease, attempt)) {
        throw new HostStoreError(
          "RESIDENT_PROMPT_RECONCILIATION_LEASE_INVALID",
          "The settled acknowledged prompt changed before idle proof completion",
        );
      }
      const currentReceipt = await this.readReceiptUnlocked(lease.command);
      if (
        !currentReceipt ||
        currentReceipt.status !== "running" ||
        !attempt.finalReceipt ||
        !isDeepStrictEqual(currentReceipt, attempt.finalReceipt) ||
        currentReceipt.updatedAt !== lease.receiptUpdatedAt
      ) {
        throw new HostStoreError(
          "RESIDENT_PROMPT_RECONCILIATION_RECEIPT_CHANGED",
          "The prompt receipt is no longer at its exact acknowledged-running boundary",
        );
      }
      const currentBinding = await this.resolveResidentDispatchBindingUnlocked(lease.command);
      if (!isDeepStrictEqual(currentBinding, lease.binding)) {
        throw new HostStoreError(
          "RESIDENT_PROMPT_RECONCILIATION_BINDING_CHANGED",
          "The resident binding changed after the idle barrier began",
        );
      }
      if (
        !evidence ||
        evidence.evidenceVersion !== 1 ||
        evidence.dispatchAttemptId !== lease.attemptId ||
        !isDeepStrictEqual(evidence.binding, lease.binding) ||
        evidence.projection.identity.activeSessionId !== lease.binding.activeSessionId ||
        evidence.projection.identity.sessionId !== lease.binding.sessionId ||
        evidence.projection.identity.sessionFile !== lease.binding.sessionFile ||
        !sameCanonicalPath(evidence.projection.identity.workspaceDirectory, lease.binding.workspaceDirectory) ||
        residentPrivateProjectionReportsActivity(evidence.projection)
      ) {
        throw new HostStoreError(
          "RESIDENT_PROMPT_IDLE_EVIDENCE_INVALID",
          "The adapter did not return exact inactive authority evidence for this acknowledged prompt",
        );
      }
      const currentSnapshot = await this.readSnapshotUnlocked(lease.command.threadId);
      if (
        currentSnapshot.latestCursor.threadId !== lease.command.threadId ||
        currentSnapshot.latestCursor.executionGenerationId !== lease.command.expectedExecutionGenerationId ||
        currentSnapshot.runtime?.residency !== "resident" ||
        currentSnapshot.runtime.activeSessionId !== lease.binding.activeSessionId ||
        currentSnapshot.runtime.sessionId !== lease.binding.sessionId ||
        residentSnapshotReportsActivity(currentSnapshot)
      ) {
        throw new HostStoreError(
          "RESIDENT_PROMPT_IDLE_EVIDENCE_SUPERSEDED",
          "A newer authoritative active projection superseded the observed idle state",
          true,
        );
      }

      const observedAt = now();
      const completedReceipt = CommandReceiptSchema.parse({
        ...currentReceipt,
        status: "completed",
        queuePosition: undefined,
        message: "Prime Agent is authoritatively idle after the acknowledged prompt",
        error: undefined,
        updatedAt: observedAt,
      });
      const observation = ResidentPromptIdleObservedEventSchema.parse({
        eventVersion: 1,
        attemptId: attempt.attemptId,
        observedAt,
        command: attempt.command,
        acknowledgedReceipt: currentReceipt,
        receipt: completedReceipt,
        binding: currentBinding,
        bindingFingerprint: attempt.bindingFingerprint,
        observedCursor: currentSnapshot.latestCursor,
      });
      const { promptSettlementCursor: _settlementCursor, ...attemptWithoutSettlementCursor } = attempt;
      const completedAttempt = ResidentDispatchAttemptSchema.parse({
        ...attemptWithoutSettlementCursor,
        binding: currentBinding,
        updatedAt: observedAt,
        finalReceipt: completedReceipt,
        promptIdleObservation: observation,
      });
      try {
        // The completed attempt is the recovery intent. Startup can finish the
        // remaining local writes without rerunning Prime or trusting a generic
        // completed receipt as idle evidence.
        await atomicWriteJson(
          this.residentDispatchAttemptPath(lease.command),
          completedAttempt,
          MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES,
        );
        await this.injectResidentDispatchFault("after_prompt_idle_attempt", attempt.attemptId);
        await atomicWriteJson(this.receiptPath(lease.command), completedReceipt);
        await this.injectResidentDispatchFault("after_prompt_idle_receipt", attempt.attemptId);
        await this.appendResidentDispatchJournalUnlocked(
          lease.command,
          "completed",
          observedAt,
          completedReceipt.message,
          "idle-completed",
        );
        await this.injectResidentDispatchFault("after_prompt_idle_journal", attempt.attemptId);
        await this.appendResidentPromptIdleEventUnlocked(observation);
        await this.injectResidentDispatchFault("after_prompt_idle_event", attempt.attemptId);
        await rm(this.residentDispatchAttemptPath(lease.command), { force: true });
        this.residentPromptReconciliationLeaseCache.delete(attempt.attemptId);
      } catch (error) {
        this.initialized = false;
        throw error;
      }
      return observation;
    });
  }

  /** Issue read-only idle-proof authority after one exact Stop was acknowledged. */
  async beginResidentAbortReconciliation(
    dispatchLeaseValue: ResidentDispatchLease,
  ): Promise<ResidentAbortReconciliationLease> {
    const dispatchLease = validateResidentDispatchLease(dispatchLeaseValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      const attempt = await this.readResidentDispatchAttemptUnlocked(dispatchLease.command);
      if (
        !attempt ||
        attempt.attemptId !== dispatchLease.attemptId ||
        attempt.dispatchStartedAt !== dispatchLease.dispatchStartedAt ||
        attempt.bindingFingerprint !== dispatchLease.bindingFingerprint ||
        !isDeepStrictEqual(attempt.command, dispatchLease.command)
      ) {
        throw new HostStoreError(
          "RESIDENT_ABORT_RECONCILIATION_INELIGIBLE",
          "No exact acknowledged resident Stop matches this dispatch authority",
        );
      }
      return this.createResidentAbortReconciliationLeaseUnlocked(attempt);
    });
  }

  /** Reissue process-local read-only Stop authorities after a host restart. */
  async listResidentAbortReconciliationLeases(): Promise<readonly ResidentAbortReconciliationLease[]> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const entries = await readdir(this.paths.residentDispatchAttempts, { withFileTypes: true });
      if (entries.length > MAX_PENDING_RESIDENT_DISPATCH_ATTEMPTS) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_LIMIT",
          "Resident Stop reconciliation cannot inspect an over-capacity attempt store",
        );
      }
      const leases: ResidentAbortReconciliationLease[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          throw new HostStoreError(
            "RESIDENT_DISPATCH_ATTEMPT_INVALID",
            "Resident Stop reconciliation encountered an unexpected attempt entry",
          );
        }
        const attempt = await readJsonFile(
          join(this.paths.residentDispatchAttempts, entry.name),
          ResidentDispatchAttemptSchema,
          { maxBytes: MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES },
        );
        if (
          !attempt ||
          entry.name !== `${storageKey(attempt.command.deviceId, attempt.command.commandId)}.json`
        ) {
          throw new HostStoreError(
            "RESIDENT_DISPATCH_ATTEMPT_INVALID",
            "Resident Stop reconciliation attempt does not match its durable filename",
          );
        }
        if (!residentAcknowledgedAbortAttemptRetainsLock(attempt)) continue;
        leases.push(await this.createResidentAbortReconciliationLeaseUnlocked(attempt));
      }
      return Object.freeze(leases);
    });
  }

  /**
   * Commit the dedicated Stop idle observation. A running abort receipt is
   * only request-acceptance evidence until this path validates the exact
   * same-connection idle projection and its durable public materialization.
   */
  async completeResidentAbortReconciliation(
    leaseValue: ResidentAbortReconciliationLease,
    evidence: ResidentAbortIdleAuthorityEvidence,
  ): Promise<ResidentAbortIdleObservedEvent> {
    const lease = validateResidentAbortReconciliationLease(leaseValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      if (!this.residentAbortReconciliationLeases.has(lease as object)) {
        throw new HostStoreError(
          "RESIDENT_ABORT_RECONCILIATION_LEASE_INVALID",
          "Stop idle completion requires a lease issued by this exact HostStore instance",
        );
      }
      const attempt = await this.readResidentDispatchAttemptUnlocked(lease.command);
      if (!attempt || !residentAbortReconciliationLeaseMatchesAttempt(lease, attempt)) {
        throw new HostStoreError(
          "RESIDENT_ABORT_RECONCILIATION_LEASE_INVALID",
          "The acknowledged Stop changed before idle proof completion",
        );
      }
      const currentReceipt = await this.readReceiptUnlocked(lease.command);
      if (
        !currentReceipt ||
        currentReceipt.status !== "running" ||
        !attempt.finalReceipt ||
        !isDeepStrictEqual(currentReceipt, attempt.finalReceipt) ||
        currentReceipt.updatedAt !== lease.receiptUpdatedAt
      ) {
        throw new HostStoreError(
          "RESIDENT_ABORT_RECONCILIATION_RECEIPT_CHANGED",
          "The Stop receipt is no longer at its exact acknowledged-request boundary",
        );
      }
      const currentBinding = await this.resolveResidentDispatchBindingUnlocked(lease.command);
      if (!isDeepStrictEqual(currentBinding, lease.binding)) {
        throw new HostStoreError(
          "RESIDENT_ABORT_RECONCILIATION_BINDING_CHANGED",
          "The resident binding changed after the Stop idle barrier began",
        );
      }
      if (
        !evidence ||
        evidence.evidenceVersion !== 1 ||
        evidence.dispatchAttemptId !== lease.attemptId ||
        !isDeepStrictEqual(evidence.binding, lease.binding) ||
        evidence.projection.identity.activeSessionId !== lease.binding.activeSessionId ||
        evidence.projection.identity.sessionId !== lease.binding.sessionId ||
        evidence.projection.identity.sessionFile !== lease.binding.sessionFile ||
        !sameCanonicalPath(evidence.projection.identity.workspaceDirectory, lease.binding.workspaceDirectory) ||
        residentPrivateProjectionReportsActivity(evidence.projection)
      ) {
        throw new HostStoreError(
          "RESIDENT_ABORT_IDLE_EVIDENCE_INVALID",
          "The adapter did not return exact inactive authority evidence for this acknowledged Stop",
        );
      }
      const currentSnapshot = await this.readSnapshotUnlocked(lease.command.threadId);
      if (
        currentSnapshot.latestCursor.threadId !== lease.command.threadId ||
        currentSnapshot.latestCursor.executionGenerationId !== lease.command.expectedExecutionGenerationId ||
        currentSnapshot.latestCursor.generation !== evidence.projection.cursor.generation ||
        currentSnapshot.latestCursor.sequence !== evidence.projection.cursor.sequence ||
        currentSnapshot.runtime?.residency !== "resident" ||
        currentSnapshot.runtime.activeSessionId !== lease.binding.activeSessionId ||
        currentSnapshot.runtime.sessionId !== lease.binding.sessionId ||
        residentSnapshotReportsActivity(currentSnapshot) ||
        residentPublishedProjectionDigest(currentSnapshot) !== residentProjectionDigest(evidence.projection)
      ) {
        throw new HostStoreError(
          "RESIDENT_ABORT_IDLE_EVIDENCE_SUPERSEDED",
          "The proof-backed Stop idle projection was not durably materialized under the exact authority",
          true,
        );
      }

      const observedAt = now();
      const completedReceipt = CommandReceiptSchema.parse({
        ...currentReceipt,
        status: "completed",
        queuePosition: undefined,
        message: "Prime Agent is authoritatively idle after the acknowledged stop request",
        error: undefined,
        updatedAt: observedAt,
      });
      const observation = ResidentAbortIdleObservedEventSchema.parse({
        eventVersion: 1,
        attemptId: attempt.attemptId,
        observedAt,
        command: attempt.command,
        acknowledgedReceipt: currentReceipt,
        receipt: completedReceipt,
        binding: currentBinding,
        bindingFingerprint: attempt.bindingFingerprint,
        observedCursor: currentSnapshot.latestCursor,
      });
      const { abortSettlementCursor: _settlementCursor, ...attemptWithoutSettlementCursor } = attempt;
      const completedAttempt = ResidentDispatchAttemptSchema.parse({
        ...attemptWithoutSettlementCursor,
        binding: currentBinding,
        updatedAt: observedAt,
        finalReceipt: completedReceipt,
        abortIdleObservation: observation,
      });
      try {
        await atomicWriteJson(
          this.residentDispatchAttemptPath(lease.command),
          completedAttempt,
          MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES,
        );
        await this.injectResidentDispatchFault("after_abort_idle_attempt", attempt.attemptId);
        await atomicWriteJson(this.receiptPath(lease.command), completedReceipt);
        await this.injectResidentDispatchFault("after_abort_idle_receipt", attempt.attemptId);
        await this.appendResidentDispatchJournalUnlocked(
          lease.command,
          "completed",
          observedAt,
          completedReceipt.message,
          "abort-idle-completed",
        );
        await this.injectResidentDispatchFault("after_abort_idle_journal", attempt.attemptId);
        await this.appendResidentAbortIdleEventUnlocked(observation);
        await this.injectResidentDispatchFault("after_abort_idle_event", attempt.attemptId);
        await rm(this.residentDispatchAttemptPath(lease.command), { force: true });
        this.residentAbortReconciliationLeaseCache.delete(attempt.attemptId);
      } catch (error) {
        this.initialized = false;
        throw error;
      }
      return observation;
    });
  }

  /**
   * Persist the dispatch boundary before invoking Prime Agent. The returned
   * binding is the exact private authority that a resident gateway must match.
   */
  async beginModelSelectionDispatch(commandValue: CommandEnvelope): Promise<ResidentSessionBinding> {
    const command = CommandEnvelopeSchema.parse(commandValue);
    if (command.command.kind !== "model.select") {
      throw new HostStoreError("MODEL_SELECTION_COMMAND_REQUIRED", "This dispatch path accepts only model selection");
    }
    return this.exclusive(async () => {
      this.assertInitialized();
      const attempt = await this.readModelSelectionAttemptUnlocked(command);
      if (!attempt || !isDeepStrictEqual(attempt.command, command)) {
        throw new HostStoreError(
          "MODEL_SELECTION_ATTEMPT_MISSING",
          "No exact durable model-selection admission exists for this command",
        );
      }
      const receipt = await this.readReceiptUnlocked(command);
      if (!receipt || receipt.status !== "admitted" || attempt.state !== "admitted") {
        throw new HostStoreError(
          "MODEL_SELECTION_ALREADY_DISPATCHED",
          "This model-selection command cannot cross the dispatch boundary again",
        );
      }

      const binding = await this.resolveModelSelectionBindingUnlocked(command);
      if (!isDeepStrictEqual(binding, attempt.binding)) {
        throw new HostStoreError(
          "RESIDENT_BINDING_CONFLICT",
          "The resident session binding changed after model-selection admission",
        );
      }

      const dispatchStartedAt = now();
      const dispatching = ModelSelectionAttemptSchema.parse({
        ...attempt,
        state: "dispatching",
        updatedAt: dispatchStartedAt,
        dispatchStartedAt,
      });
      const running = CommandReceiptSchema.parse({
        ...receipt,
        status: "running",
        queuePosition: undefined,
        message: "Selecting the model on the resident Prime Agent session",
        error: undefined,
        updatedAt: dispatchStartedAt,
      });
      try {
        // If hostd stops after this write, startup sees an interrupted mutation
        // and resolves it to uncertain rather than invoking setModel again.
        await atomicWriteJson(
          this.modelSelectionAttemptPath(command),
          dispatching,
          MAX_MODEL_SELECTION_ATTEMPT_BYTES,
        );
        await atomicWriteJson(this.receiptPath(command), running);
        await this.appendModelSelectionJournalUnlocked(
          command,
          "running",
          running.updatedAt,
          running.message,
        );
      } catch (error) {
        this.initialized = false;
        throw error;
      }
      return validateResidentSessionBinding(binding);
    });
  }

  /** Finalize a model mutation and retire its non-replayable dispatch marker. */
  async finalizeModelSelectionDispatch(
    commandValue: CommandEnvelope,
    update: Pick<CommandReceipt, "status"> & Partial<Pick<CommandReceipt, "message" | "error">>,
  ): Promise<CommandReceipt> {
    const command = CommandEnvelopeSchema.parse(commandValue);
    if (command.command.kind !== "model.select") {
      throw new HostStoreError("MODEL_SELECTION_COMMAND_REQUIRED", "This receipt path accepts only model selection");
    }
    if (update.status !== "completed" && update.status !== "failed" && update.status !== "uncertain") {
      throw new HostStoreError(
        "MODEL_SELECTION_STATUS_INVALID",
        "Model selection may finish only as completed, failed, or uncertain",
      );
    }
    return this.exclusive(async () => {
      this.assertInitialized();
      const attempt = await this.readModelSelectionAttemptUnlocked(command);
      if (!attempt || !isDeepStrictEqual(attempt.command, command)) {
        throw new HostStoreError(
          "MODEL_SELECTION_ATTEMPT_MISSING",
          "No exact durable model-selection attempt exists for this command",
        );
      }
      const current = await this.readReceiptUnlocked(command);
      if (!current || (current.status !== "admitted" && current.status !== "running")) {
        throw new HostStoreError(
          "MODEL_SELECTION_ALREADY_FINALIZED",
          "The model-selection receipt is already terminal",
        );
      }
      if (update.status !== "failed" && attempt.state !== "dispatching") {
        throw new HostStoreError(
          "MODEL_SELECTION_NOT_DISPATCHED",
          "Only a dispatched model selection can finish as completed or uncertain",
        );
      }
      const receipt = CommandReceiptSchema.parse({
        ...current,
        ...update,
        queuePosition: undefined,
        updatedAt: now(),
      });
      try {
        await atomicWriteJson(this.receiptPath(command), receipt);
        await this.appendModelSelectionJournalUnlocked(
          command,
          receipt.status,
          receipt.updatedAt,
          receipt.message,
        );
        await rm(this.modelSelectionAttemptPath(command), { force: true });
      } catch (error) {
        this.initialized = false;
        throw error;
      }
      return receipt;
    });
  }

  async reconcileCommands(commandValues: CommandEnvelope[]): Promise<{
    receipts: CommandReceipt[];
    unknown: CommandIdentity[];
  }> {
    if (commandValues.length !== 1) {
      throw new HostStoreError("RECONCILE_LIMIT", "Reconciliation requires one exact command envelope per request");
    }
    const commands = commandValues.map((command) => CommandEnvelopeSchema.parse(command));
    return this.exclusive(async () => {
      this.assertInitialized();
      const receipts: CommandReceipt[] = [];
      const unknown: CommandIdentity[] = [];
      for (const command of commands) {
        const durableIdentity = await this.resolveCommandIdentityUnlocked(command);
        const receipt = await this.readReceiptUnlocked(command);
        if (receipt) {
          if (!durableIdentity) {
            throw new HostStoreError(
              "COMMAND_IDENTITY_UNVERIFIABLE",
              "This legacy receipt has no durable exact command envelope and cannot be reconciled",
            );
          }
          this.assertReceiptMatchesCommand(receipt, command);
          receipts.push(receipt);
        } else if (durableIdentity) {
          throw new HostStoreError(
            "COMMAND_IDENTITY_ORPHANED",
            "The durable command identity has no matching transaction or receipt",
          );
        } else {
          unknown.push({ deviceId: command.deviceId, commandId: command.commandId });
        }
      }
      return { receipts, unknown };
    });
  }

  async createHandoffPlan(requestValue: HandoffPlanRequest): Promise<HandoffPlan> {
    const request = HandoffPlanRequestSchema.parse(requestValue);
    return this.exclusive(async () => {
      this.assertInitialized();
      const [projects, threads] = await Promise.all([this.readProjectsUnlocked(), this.readThreadsUnlocked()]);
      const thread = threads.find((item) => item.threadId === request.threadId);
      if (!thread) throw new HostStoreError("THREAD_NOT_FOUND", `Thread ${request.threadId} does not exist`);
      if (thread.currentLocation.executionGenerationId !== request.sourceGenerationId) {
        throw new HostStoreError(
          "STALE_EXECUTION_GENERATION",
          "The handoff source generation is no longer authoritative",
        );
      }
      await this.assertNoResidentLifecycleOperationUnlocked(thread.threadId);
      if (thread.currentLocation.hostId === request.destinationHostId) {
        throw new HostStoreError("SAME_HOST_HANDOFF", "The destination must be a different host");
      }

      const sourceProject = projects.find((item) => item.projectId === thread.currentLocation.projectId);
      const destinationProject = projects.find(
        (item) => item.projectId === request.destinationProjectId && item.hostId === request.destinationHostId,
      );
      const repositoryMatch = repositoriesMatch(sourceProject, destinationProject) ? "exact" : "none";
      const snapshot = await this.readSnapshotUnlocked(thread.threadId);
      const dirtyFiles = snapshot.git.stagedFiles + snapshot.git.unstagedFiles + snapshot.git.untrackedFiles;
      const warnings: HandoffPlan["warnings"] = [];
      if (!destinationProject) {
        warnings.push({
          code: "DESTINATION_PROJECT_UNKNOWN",
          message: "The destination project is not present in this host's trusted catalog",
          blocking: true,
        });
      }
      if (repositoryMatch === "none") {
        warnings.push({
          code: "REPOSITORY_MATCH_REQUIRED",
          message: "Source and destination repository identities do not match",
          blocking: true,
        });
      }
      if (dirtyFiles > 0) {
        warnings.push({
          code: "DIRTY_GIT_TRANSFER_UNAVAILABLE",
          message: "This Phase 0 host can switch only a clean repository checkpoint",
          blocking: true,
        });
      }
      if (thread.status === "running" && request.behaviorIfRunning === "wait_for_idle") {
        warnings.push({
          code: "WAITING_FOR_IDLE",
          message: "Commit will remain unavailable until the current task becomes idle",
          blocking: false,
        });
      }

      const createdAt = now();
      const handoffId = randomId("handoff");
      const destinationGenerationId = randomId("exec");
      const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
      const plan = HandoffPlanSchema.parse({
        handoffId,
        createdAt,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        threadId: thread.threadId,
        source: thread.currentLocation,
        destination: {
          hostId: request.destinationHostId,
          projectId: request.destinationProjectId,
          workspaceId: destinationProject?.workspaceId ?? request.destinationProjectId,
          executionGenerationId: destinationGenerationId,
        },
        repositoryMatch,
        branchPlan: {
          sourceBranch: snapshot.git.branch,
          destinationBranch: snapshot.git.branch ?? `prime-handoff-${handoffId.slice(-8)}`,
          createWorktree: true,
          baseCommit: snapshot.git.headCommit,
        },
        transferBytesEstimate: snapshotBytes,
        includesUntrackedFiles: snapshot.git.untrackedFiles > 0,
        runtimeStateLosses: [
          "The live Python/IPython runtime and process-local variables restart on the destination host.",
          "Running subprocesses and child processes do not migrate.",
        ],
        warnings,
        executable: warnings.every((warning) => !warning.blocking),
        behaviorIfRunning: request.behaviorIfRunning,
      });
      const record: HandoffRecord = { version: 1, plan, progress: [] };
      await atomicWriteJson(this.handoffPath(handoffId), record);
      await this.appendEventUnlocked({ type: "handoff.planned", threadId: thread.threadId, detail: handoffId });
      return plan;
    });
  }

  async commitHandoff(handoffId: string, command: CommandIdentity): Promise<HandoffCommit> {
    return this.exclusive(async () => {
      this.assertInitialized();
      const record = await readJsonFile(this.handoffPath(handoffId), HandoffRecordSchema, { optional: true });
      if (!record) throw new HostStoreError("HANDOFF_NOT_FOUND", `Handoff ${handoffId} does not exist`);
      if (record.receipt) {
        await this.ensureHandoffCommandReceiptUnlocked(record.receipt, command);
        return { receipt: record.receipt, progress: record.progress, duplicate: true };
      }
      await this.assertNoResidentLifecycleOperationUnlocked(record.plan.threadId);

      const existingCommand = await this.readReceiptUnlocked(command);
      if (existingCommand) {
        throw new HostStoreError("COMMAND_ID_REUSED", "This command identity is already bound to another mutation");
      }

      const [threads, residentBindings] = await Promise.all([
        this.readThreadsUnlocked(),
        this.readResidentSessionBindingsUnlocked(),
      ]);
      const index = threads.findIndex((item) => item.threadId === record.plan.threadId);
      const thread = index >= 0 ? threads[index] : undefined;
      let preflightError: StructuredError | undefined;
      if (!record.plan.executable) {
        preflightError = structured("HANDOFF_NOT_EXECUTABLE", "The handoff plan has blocking warnings");
      } else if (Date.parse(record.plan.expiresAt) < Date.now()) {
        preflightError = structured("HANDOFF_PLAN_EXPIRED", "The handoff plan has expired");
      } else if (!thread) {
        preflightError = structured("THREAD_NOT_FOUND", `Thread ${record.plan.threadId} does not exist`);
      } else if (thread.currentLocation.executionGenerationId !== record.plan.source.executionGenerationId) {
        preflightError = structured(
          "SOURCE_AUTHORITY_CHANGED",
          "The source execution generation is no longer authoritative",
        );
      } else if (residentBindings.some((binding) => binding.threadId === thread.threadId)) {
        preflightError = structured(
          "RESIDENT_SESSION_ACTIVE",
          "The resident session binding must be completed before execution authority can move",
        );
      } else if (thread.status === "running" && record.plan.behaviorIfRunning === "wait_for_idle") {
        preflightError = structured("HANDOFF_WAITING_FOR_IDLE", "The source task is still running", true);
      }

      if (preflightError || !thread) {
        return this.recordFailedHandoffUnlocked(record, command, preflightError ?? structured("THREAD_NOT_FOUND", "Thread missing"));
      }

      const sourceSnapshot = await this.readSnapshotUnlocked(thread.threadId);
      const progress: HandoffProgress[] = [
        { phase: "quiescing", detail: record.plan.behaviorIfRunning === "interrupt" ? "Admission paused" : "Source is idle" },
      ];
      await this.appendCommandJournalUnlocked(
        { ...command, threadId: thread.threadId, command: { kind: "handoff.commit" } },
        "running",
        handoffId,
      );

      const checkpointId = `checkpoint-${handoffId}`;
      const checkpoint = HandoffCheckpointSchema.parse({
        version: 1,
        checkpointId,
        handoffId,
        // The plan timestamp makes retry bytes deterministic. A create-if-absent
        // result can therefore be accepted only when the immutable content is
        // byte-for-byte the checkpoint this plan intended to publish.
        createdAt: record.plan.createdAt,
        source: record.plan.source,
        snapshot: sourceSnapshot,
      });
      try {
        const writeCheckpoint = this.options.handoffCheckpointWriter ?? atomicWriteJsonIfAbsent;
        let created: boolean;
        try {
          created = await writeCheckpoint(this.checkpointPath(handoffId), checkpoint);
        } catch (error) {
          if (!(error instanceof AtomicWriteAmbiguousCommitError)) throw error;
          // The immutable name may be visible while its directory durability is
          // uncertain. Re-enter create-if-absent once: the primitive re-flushes
          // an existing inode, and the byte comparison below prevents a
          // different checkpoint from being accepted as recovery.
          created = await writeCheckpoint(this.checkpointPath(handoffId), checkpoint);
        }
        if (!created) await this.assertMatchingHandoffCheckpointUnlocked(handoffId, checkpoint);
      } catch (error) {
        const checkpointError =
          error instanceof HostStoreError
            ? error.toStructuredError()
            : structured(
                "HANDOFF_CHECKPOINT_FAILED",
                "The immutable source checkpoint could not be confirmed; the source remains authoritative",
                true,
              );
        return this.recordFailedHandoffUnlocked({ ...record, progress }, command, checkpointError, error);
      }
      progress.push({ phase: "checkpointing", completed: 1, total: 1 });

      const candidate = createDestinationSnapshot(sourceSnapshot, record.plan);
      const serialized = Buffer.from(JSON.stringify(candidate), "utf8");
      progress.push({ phase: "transferring", bytes: serialized.byteLength, totalBytes: serialized.byteLength });
      const verificationHash = createHash("sha256").update(serialized).digest("hex");
      const stagingPath = this.stagingPath(handoffId);
      await atomicWriteJson(stagingPath, candidate);
      progress.push({ phase: "materializing", detail: "Destination projection materialized in isolated staging" });

      const stagedBytes = await readFile(stagingPath);
      const stagedValue = ThreadProjectionSnapshotSchema.parse(JSON.parse(stagedBytes.toString("utf8")) as unknown);
      const stagedHash = createHash("sha256").update(JSON.stringify(stagedValue)).digest("hex");
      if (stagedHash !== verificationHash) {
        return this.recordFailedHandoffUnlocked(
          { ...record, progress },
          command,
          structured("HANDOFF_VERIFICATION_FAILED", "The destination checkpoint hash did not verify"),
          undefined,
          checkpoint,
        );
      }
      progress.push({ phase: "verifying", detail: "Snapshot content hash verified" });
      progress.push({ phase: "switching_authority" });

      let authoritySwitched = false;
      try {
        await atomicWriteJson(this.snapshotPath(thread.threadId), candidate);
        threads[index] = candidate.thread;
        await atomicWriteJson(this.paths.threads, { version: 1, threads });
        authoritySwitched = true;

        const completedAt = now();
        const receipt = HandoffReceiptSchema.parse({
          protocolVersion: PROTOCOL_VERSION,
          handoffId,
          command,
          threadId: thread.threadId,
          source: record.plan.source,
          destination: record.plan.destination,
          checkpointId,
          status: "complete",
          completedAt,
          continuitySummary:
            "Thread history and durable host state moved to a new execution generation. Runtime-local process state restarted.",
          runtimeStateLosses: record.plan.runtimeStateLosses,
          sourceCheckpointRetained: true,
          verificationHash,
        });
        progress.push({ phase: "complete", receipt });
        await atomicWriteJson(this.handoffPath(handoffId), { version: 1, plan: record.plan, progress, receipt });
        await this.writeHandoffCommandReceiptUnlocked(receipt, command, "completed");
        await this.appendEventUnlocked({ type: "handoff.completed", threadId: thread.threadId, detail: handoffId });
        await rm(stagingPath, { force: true });
        return { receipt, progress, duplicate: false };
      } catch (error) {
        // During a handled failure, restore the immutable source checkpoint so
        // authority never remains half-switched.
        if (authoritySwitched) {
          threads[index] = thread;
          await atomicWriteJson(this.paths.threads, { version: 1, threads }).catch(() => undefined);
        }
        await atomicWriteJson(this.snapshotPath(thread.threadId), sourceSnapshot).catch(() => undefined);
        return this.recordFailedHandoffUnlocked(
          { ...record, progress },
          command,
          structured("HANDOFF_COMMIT_FAILED", "The handoff failed; the source remains authoritative", true),
          error,
          checkpoint,
        );
      }
    });
  }

  private async materializeResidentProjectionTransactionUnlocked(
    transaction: ResidentProjectionTransaction,
    injectFaults: boolean,
  ): Promise<void> {
    const binding = validateResidentSessionBinding(transaction.binding);
    const scope = await this.currentWorkspaceScopeUnlocked(
      binding.threadId,
      binding.executionGenerationId,
    );
    const workspaceDirectory = await this.resolveWorkspaceDirectoryUnlocked(scope);
    this.assertBindingMatchesScope(binding, scope, workspaceDirectory);
    const targetLocation = transaction.snapshot.thread.currentLocation;
    if (
      targetLocation.hostId !== scope.hostId ||
      targetLocation.projectId !== scope.projectId ||
      targetLocation.workspaceId !== scope.workspaceId ||
      targetLocation.executionGenerationId !== scope.executionGenerationId
    ) {
      throw new HostStoreError(
        "RESIDENT_PROJECTION_AUTHORITY_MISMATCH",
        "A pending resident projection does not match the current host, project, workspace, and execution authority",
      );
    }

    const records = await this.readResidentSessionBindingRecordsUnlocked();
    const active = records.find(
      (record) => record.state === "active" && record.binding.threadId === binding.threadId,
    );
    let projectionBinding: ResidentSessionBindingRecord | undefined = active;
    if (transaction.lifecycleOperationId) {
      const operation = await this.readResidentLifecycleOperationUnlocked(transaction.lifecycleOperationId);
      const activating = records.find(
        (record) =>
          record.state === "activating" &&
          record.operationId === transaction.lifecycleOperationId &&
          record.binding.threadId === binding.threadId,
      );
      if (
        !operation ||
        operation.kind !== "provision" ||
        (operation.phase !== "promoted_observed" && operation.phase !== "projection_committed") ||
        !operation.binding ||
        !isDeepStrictEqual(operation.binding, binding)
      ) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_PROJECTION_AUTHORITY_MISMATCH",
          "A pending activating projection no longer belongs to its exact lifecycle operation",
        );
      }
      projectionBinding = activating ?? active;
    }
    if (!projectionBinding) {
      throw new HostStoreError(
        "RESIDENT_PROJECTION_BINDING_NOT_FOUND",
        transaction.lifecycleOperationId
          ? "A pending lifecycle projection has no exact activating binding"
          : "A pending resident projection has no active resident binding",
      );
    }
    if (!isDeepStrictEqual(projectionBinding.binding, binding)) {
      throw new HostStoreError(
        "RESIDENT_PROJECTION_BINDING_MISMATCH",
        "A pending resident projection no longer belongs to its exact binding",
      );
    }

    const currentSnapshot = await this.readSnapshotUnlocked(binding.threadId);
    if (
      currentSnapshot.thread.threadId !== binding.threadId ||
      currentSnapshot.thread.currentLocation.executionGenerationId !== binding.executionGenerationId
    ) {
      throw new HostStoreError(
        "RESIDENT_PROJECTION_AUTHORITY_MISMATCH",
        "A pending resident projection belongs to a superseded execution authority",
      );
    }

    await this.assertResidentProjectionPromptRetirementsUnlocked(transaction, currentSnapshot);
    await this.assertResidentProjectionAbortIdleProofUnlocked(transaction, currentSnapshot);
    await this.materializeResidentProjectionLineageUnlocked(transaction);
    if (injectFaults) {
      await this.injectResidentProjectionFault("after_lineage", transaction.transactionId);
    }
    await atomicWriteJson(this.snapshotPath(binding.threadId), transaction.snapshot);
    if (injectFaults) {
      await this.injectResidentProjectionFault("after_snapshot", transaction.transactionId);
    }
    await atomicWriteJson(this.paths.threads, transaction.threadsFile);
    if (injectFaults) {
      await this.injectResidentProjectionFault("after_threads", transaction.transactionId);
    }
    for (const retired of transaction.retiredPromptAttempts) {
      const path = this.residentDispatchAttemptPath(retired.command);
      const current = await this.readResidentDispatchAttemptUnlocked(retired.command);
      if (current && !isDeepStrictEqual(current, retired)) {
        throw new HostStoreError(
          "RESIDENT_PROMPT_LOCK_CONFLICT",
          "A resident projection cannot retire a different prompt ownership lock",
        );
      }
      if (current) await rm(path, { force: true });
    }
    if (injectFaults) {
      await this.injectResidentProjectionFault("after_prompt_locks", transaction.transactionId);
    }
    await rm(this.residentProjectionTransactionPath(binding), { force: true });
  }

  private async recoverResidentProjectionTransactionsUnlocked(): Promise<void> {
    const entries = await readdir(this.paths.residentProjectionTransactions, { withFileTypes: true });
    if (entries.length > MAX_PENDING_RESIDENT_PROJECTION_TRANSACTIONS) {
      throw new HostStoreError(
        "RESIDENT_PROJECTION_TRANSACTION_LIMIT",
        `Resident projection transaction directory exceeds ${MAX_PENDING_RESIDENT_PROJECTION_TRANSACTIONS} entries`,
      );
    }

    const transactionNames: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new HostStoreError(
          "INVALID_RESIDENT_PROJECTION_TRANSACTION",
          "Resident projection transaction directory contains a non-file entry",
        );
      }
      if (entry.name.endsWith(".json")) {
        transactionNames.push(entry.name);
        continue;
      }
      if (entry.name.includes(".json.tmp-")) {
        await rm(join(this.paths.residentProjectionTransactions, entry.name), { force: true });
        continue;
      }
      throw new HostStoreError(
        "INVALID_RESIDENT_PROJECTION_TRANSACTION",
        `Unexpected resident projection transaction file ${entry.name}`,
      );
    }

    transactionNames.sort();
    for (const name of transactionNames) {
      const path = join(this.paths.residentProjectionTransactions, name);
      const transaction = await readJsonFile(path, ResidentProjectionTransactionSchema, {
        maxBytes: MAX_RESIDENT_PROJECTION_TRANSACTION_BYTES,
      });
      if (!transaction) {
        throw new HostStoreError(
          "INVALID_RESIDENT_PROJECTION_TRANSACTION",
          `Missing resident projection transaction ${name}`,
        );
      }
      const expectedName = `${storageKey(
        transaction.binding.threadId,
        transaction.binding.executionGenerationId,
      )}.json`;
      if (name !== expectedName) {
        throw new HostStoreError(
          "INVALID_RESIDENT_PROJECTION_TRANSACTION",
          `Resident projection transaction filename does not match ${transaction.transactionId}`,
        );
      }
      const expectedTransactionId = transaction.abortIdleProofAttempt
        ? deterministicId(
            "resident-abort-idle-projection",
            transaction.abortIdleProofAttempt.attemptId,
            transaction.snapshot.latestCursor.generation,
            String(transaction.snapshot.latestCursor.sequence),
          )
        : deterministicId(
            "resident-projection",
            transaction.binding.threadId,
            transaction.binding.executionGenerationId,
            transaction.snapshot.latestCursor.generation,
            String(transaction.snapshot.latestCursor.sequence),
          );
      if (transaction.transactionId !== expectedTransactionId) {
        throw new HostStoreError(
          "INVALID_RESIDENT_PROJECTION_TRANSACTION",
          "Resident projection transaction identity does not match its authoritative cursor",
        );
      }
      await this.materializeResidentProjectionTransactionUnlocked(transaction, false);
    }
  }

  private async validateResidentProjectionLineageDirectoryUnlocked(): Promise<void> {
    const entries = await readdir(this.paths.residentProjectionLineages, { withFileTypes: true });
    if (entries.length > MAX_RESIDENT_PROJECTION_LINEAGES) {
      throw new HostStoreError(
        "RESIDENT_PROJECTION_LINEAGE_LIMIT",
        `Resident projection lineage directory exceeds ${MAX_RESIDENT_PROJECTION_LINEAGES} entries`,
      );
    }
    const authorityIds = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_LINEAGE_INVALID",
          "Resident projection lineage directory contains a non-file entry",
        );
      }
      if (entry.name.includes(".json.tmp-")) {
        await rm(join(this.paths.residentProjectionLineages, entry.name), { force: true });
        continue;
      }
      if (!entry.name.endsWith(".json")) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_LINEAGE_INVALID",
          `Unexpected resident projection lineage file ${entry.name}`,
        );
      }
      const lineage = await readJsonFile(
        join(this.paths.residentProjectionLineages, entry.name),
        ResidentProjectionCursorLineageSchema,
        { maxBytes: MAX_RESIDENT_PROJECTION_LINEAGE_BYTES },
      );
      if (!lineage) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_LINEAGE_INVALID",
          `Missing resident projection lineage ${entry.name}`,
        );
      }
      if (entry.name !== this.residentProjectionLineageName(lineage.authorityId)) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_LINEAGE_INVALID",
          "Resident projection lineage filename does not match its stable authority",
        );
      }
      if (authorityIds.has(lineage.authorityId)) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_LINEAGE_INVALID",
          "Resident projection authority has duplicate durable lineage files",
        );
      }
      authorityIds.add(lineage.authorityId);
    }
  }

  private async assertResidentProjectionLineageCapacityUnlocked(): Promise<void> {
    const entries = await readdir(this.paths.residentProjectionLineages, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    if (files.length >= MAX_RESIDENT_PROJECTION_LINEAGES) {
      throw new HostStoreError(
        "RESIDENT_PROJECTION_LINEAGE_LIMIT",
        "The resident projection authority lineage registry is full",
      );
    }
    if (files.length !== entries.length) {
      throw new HostStoreError(
        "RESIDENT_PROJECTION_LINEAGE_INVALID",
        "Resident projection lineage storage contains an unexpected entry",
      );
    }
  }

  private async readResidentProjectionLineageUnlocked(
    authority: ResidentProjectionAuthority,
  ): Promise<ResidentProjectionCursorLineage | undefined> {
    const authorityId = residentProjectionAuthorityId(authority);
    const lineage = await readJsonFile(
      this.residentProjectionLineagePath(authorityId),
      ResidentProjectionCursorLineageSchema,
      { optional: true, maxBytes: MAX_RESIDENT_PROJECTION_LINEAGE_BYTES },
    );
    if (
      lineage &&
      (lineage.authorityId !== authorityId || !isDeepStrictEqual(lineage.authority, authority))
    ) {
      throw new HostStoreError(
        "RESIDENT_PROJECTION_LINEAGE_INVALID",
        "Resident projection lineage does not match its stable authority",
      );
    }
    return lineage;
  }

  private async materializeResidentProjectionLineageUnlocked(
    transaction: ResidentProjectionTransaction,
  ): Promise<void> {
    const authority = residentProjectionAuthorityFromBinding(transaction.binding);
    const current = await this.readResidentProjectionLineageUnlocked(authority);
    const alreadyMaterialized = current && isDeepStrictEqual(current, transaction.nextLineage);
    const matchesPrevious =
      transaction.previousLineage === undefined
        ? current === undefined
        : current !== undefined && isDeepStrictEqual(current, transaction.previousLineage);
    if (!alreadyMaterialized && !matchesPrevious) {
      throw new HostStoreError(
        "RESIDENT_PROJECTION_LINEAGE_CONFLICT",
        "Prepared resident projection no longer follows its exact durable lineage",
      );
    }
    await atomicWriteJson(
      this.residentProjectionLineagePath(transaction.nextLineage.authorityId),
      transaction.nextLineage,
      MAX_RESIDENT_PROJECTION_LINEAGE_BYTES,
    );
  }

  private async assertResidentProjectionPromptRetirementsUnlocked(
    transaction: ResidentProjectionTransaction,
    currentSnapshot: ThreadProjectionSnapshot,
  ): Promise<void> {
    if (transaction.retiredPromptAttempts.length === 0) return;
    const authority = residentProjectionAuthorityFromBinding(transaction.binding);
    const [currentLineage, threads] = await Promise.all([
      this.readResidentProjectionLineageUnlocked(authority),
      this.readThreadsUnlocked(),
    ]);
    const catalogThread = threads.find((thread) => thread.threadId === transaction.binding.threadId);
    const publicationAlreadyMaterialized =
      isDeepStrictEqual(currentLineage, transaction.nextLineage) &&
      isDeepStrictEqual(currentSnapshot, transaction.snapshot) &&
      isDeepStrictEqual(catalogThread, transaction.snapshot.thread);
    for (const retired of transaction.retiredPromptAttempts) {
      const current = await this.readResidentDispatchAttemptUnlocked(retired.command);
      if (current && !isDeepStrictEqual(current, retired)) {
        throw new HostStoreError(
          "RESIDENT_PROMPT_LOCK_CONFLICT",
          "Prepared resident projection targets a different prompt ownership lock",
        );
      }
      if (!current && !publicationAlreadyMaterialized) {
        throw new HostStoreError(
          "RESIDENT_PROMPT_LOCK_MISSING",
          "Prepared resident projection lost its prompt lock before public materialization",
        );
      }
    }
  }

  private async assertResidentProjectionAbortIdleProofUnlocked(
    transaction: ResidentProjectionTransaction,
    currentSnapshot: ThreadProjectionSnapshot,
  ): Promise<void> {
    const expected = transaction.abortIdleProofAttempt;
    if (!expected) return;
    const current = await this.readResidentDispatchAttemptUnlocked(expected.command);
    const currentLineage = await this.readResidentProjectionLineageUnlocked(
      residentProjectionAuthorityFromBinding(transaction.binding),
    );
    const threads = await this.readThreadsUnlocked();
    const catalogThread = threads.find((thread) => thread.threadId === transaction.binding.threadId);
    const publicationAlreadyMaterialized =
      isDeepStrictEqual(currentLineage, transaction.nextLineage) &&
      isDeepStrictEqual(currentSnapshot, transaction.snapshot) &&
      isDeepStrictEqual(catalogThread, transaction.snapshot.thread);
    if (!current || !isDeepStrictEqual(current, expected)) {
      throw new HostStoreError(
        "RESIDENT_ABORT_LOCK_CONFLICT",
        publicationAlreadyMaterialized
          ? "A materialized Stop idle projection lost its exact proof lock before transaction retirement"
          : "A prepared Stop idle projection no longer matches its exact acknowledged Stop lock",
      );
    }
  }

  private async prepareAdmissionTransactionUnlocked(
    command: CommandEnvelope,
    canDispatchLive: boolean,
    dispatcherUnavailable?: StructuredError,
  ): Promise<AdmissionTransaction> {
    const preparedAt = now();
    const transactionId = deterministicId("admission", command.deviceId, command.commandId);
    const threads = await this.readThreadsUnlocked();
    const threadIndex = threads.findIndex((thread) => thread.threadId === command.threadId);
    const thread = threadIndex >= 0 ? threads[threadIndex] : undefined;
    let rejection: StructuredError | undefined;
    let sourceSnapshot: ThreadProjectionSnapshot | undefined;
    let residentDispatchBinding: ResidentSessionBinding | undefined;
    let modelSelectionBinding: ResidentSessionBinding | undefined;

    if (!thread) {
      rejection = structured("THREAD_NOT_FOUND", `Thread ${command.threadId} does not exist`);
    } else if (command.expectedExecutionGenerationId !== thread.currentLocation.executionGenerationId) {
      rejection = structured(
        "STALE_EXECUTION_GENERATION",
        "The command targets a previous execution generation; refresh the thread before retrying",
      );
    } else {
      sourceSnapshot = await this.readSnapshotUnlocked(command.threadId);
      if (
        sourceSnapshot.thread.currentLocation.executionGenerationId !== command.expectedExecutionGenerationId ||
        sourceSnapshot.latestCursor.executionGenerationId !== command.expectedExecutionGenerationId ||
        sourceSnapshot.latestCursor.threadId !== command.threadId
      ) {
        rejection = structured(
          "SNAPSHOT_AUTHORITY_MISMATCH",
          "The thread catalog and authoritative snapshot do not identify the same execution generation",
        );
      } else {
        rejection = dispatcherUnavailable ?? validateCommandAgainstState(command, sourceSnapshot, canDispatchLive);
      }
      if (!rejection && command.command.kind === "model.select") {
        try {
          await this.assertModelSelectionAttemptCapacityUnlocked();
          modelSelectionBinding = await this.resolveModelSelectionBindingUnlocked(command);
        } catch (error) {
          rejection = error instanceof HostStoreError
            ? error.toStructuredError()
            : structured("RESIDENT_BINDING_UNAVAILABLE", "Resident session authority is unavailable", true);
        }
      }
      let promptLock: ResidentDispatchAttempt | undefined;
      let abortLock: ResidentDispatchAttempt | undefined;
      if (
        !rejection &&
        canDispatchLive &&
        (command.command.kind === "prompt" || command.command.kind === "abort")
      ) {
        try {
          promptLock = await this.findResidentPromptLockUnlocked(command.threadId);
          abortLock = await this.findResidentAbortLockUnlocked(command.threadId);
          if (abortLock) {
            const abortBarrier = residentAcknowledgedAbortAttemptRetainsLock(abortLock)
              ? {
                  code: "RESIDENT_ABORT_IDLE_PROOF_PENDING",
                  message: "The acknowledged Stop is still waiting for authoritative idle proof",
                  retryable: true,
                }
              : residentAbortAttemptRetainsBarrier(abortLock)
                ? {
                    code: "RESIDENT_ABORT_OUTCOME_UNCERTAIN",
                    message: "A previous Stop may still take effect; new resident mutations require stronger quiescence proof or verified session rotation",
                    retryable: false,
                  }
                : {
                    code: "RESIDENT_ABORT_DELIVERY_PENDING",
                    message: "A Stop is already crossing its non-replayable resident dispatch boundary",
                    retryable: true,
                  };
            rejection = structured(
              abortBarrier.code,
              abortBarrier.message,
              abortBarrier.retryable,
            );
          } else if (
            command.command.kind === "prompt" &&
            (promptLock || (sourceSnapshot && residentSnapshotReportsActivity(sourceSnapshot)))
          ) {
            rejection = structured(
              promptLock ? "RESIDENT_PROMPT_ALREADY_OWNED" : "RESIDENT_SESSION_BUSY",
              promptLock
                ? "A resident prompt is already admitted or awaiting authoritative idle projection"
                : "The authoritative resident projection already reports active work",
              true,
            );
          } else if (
            command.command.kind === "abort" &&
            sourceSnapshot &&
            !residentSnapshotReportsActivity(sourceSnapshot) &&
            (!promptLock || !residentPromptAttemptRetainsLock(promptLock))
          ) {
            rejection = promptLock
              ? structured(
                  "RESIDENT_PROMPT_DELIVERY_PENDING",
                  "The admitted prompt has not reached an acknowledged resident dispatch boundary",
                  true,
                )
              : structured(
                  "RESIDENT_SESSION_IDLE",
                  "The resident session has no active turn or acknowledged prompt to stop",
                  false,
                );
          }
        } catch (error) {
          rejection = error instanceof HostStoreError
            ? error.toStructuredError()
            : structured("RESIDENT_DISPATCH_STATE_UNAVAILABLE", "Resident dispatch ownership is unavailable", true);
        }
      }
      if (
        !rejection &&
        canDispatchLive &&
        (command.command.kind === "prompt" || command.command.kind === "abort")
      ) {
        try {
          await this.assertResidentDispatchAttemptCapacityUnlocked();
          residentDispatchBinding = await this.resolveResidentDispatchBindingUnlocked(command);
        } catch (error) {
          rejection = error instanceof HostStoreError
            ? error.toStructuredError()
            : structured("RESIDENT_BINDING_UNAVAILABLE", "Resident session authority is unavailable", true);
        }
      }
      if (
        !rejection &&
        command.command.kind !== "abort" &&
        command.command.kind !== "model.select" &&
        sourceSnapshot.queueState.pendingCommandIds.length >= 1_000
      ) {
        rejection = structured("COMMAND_QUEUE_FULL", "The host command queue has reached its bounded limit", true);
      }
    }

    const initialStatus: CommandReceiptStatus = rejection ? "rejected" : "admitted";
    const initialMessage =
      rejection?.message ??
      (command.command.kind === "abort"
        ? "Abort admitted for live dispatch"
        : command.command.kind === "model.select"
          ? "Model selection admitted for live dispatch"
          : command.command.kind === "prompt" && residentDispatchBinding
            ? "Prompt admitted for resident dispatch"
          : "Queued durably on host");
    let snapshot: ThreadProjectionSnapshot | undefined;
    let threadsFile: z.infer<typeof ThreadFileSchema> | undefined;
    if (
      !rejection &&
      sourceSnapshot &&
      thread &&
      command.command.kind !== "abort" &&
      command.command.kind !== "model.select" &&
      residentDispatchBinding === undefined
    ) {
      snapshot = applyCommand(sourceSnapshot, command, canDispatchLive);
      const updatedThreads = [...threads];
      updatedThreads[threadIndex] = snapshot.thread;
      threadsFile = ThreadFileSchema.parse({ version: 1, threads: updatedThreads });
    }

    const receipt = CommandReceiptSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      receiptId: randomId("receipt"),
      deviceId: command.deviceId,
      commandId: command.commandId,
      threadId: command.threadId,
      status: initialStatus,
      receivedAt: preparedAt,
      updatedAt: preparedAt,
      // A receipt acknowledges the immutable envelope, including a stale
      // rejection. It must never be rebound to the host's newer generation.
      executionGenerationId: command.expectedExecutionGenerationId,
      queuePosition:
        initialStatus === "admitted" &&
        command.command.kind !== "abort" &&
        command.command.kind !== "model.select" &&
        residentDispatchBinding === undefined
          ? (sourceSnapshot?.queueState.pendingCommandIds.length ?? 0) + 1
          : undefined,
      message: initialMessage,
      error: rejection,
    });

    const journalRecords = [
      createCommandJournalRecord(
        transactionId,
        0,
        command,
        "received",
        undefined,
        preparedAt,
        true,
      ),
      createCommandJournalRecord(
        transactionId,
        1,
        command,
        initialStatus,
        initialMessage,
        preparedAt,
        false,
      ),
    ];

    const eventRecord = snapshot
      ? EventJournalRecordSchema.parse({
          version: 1,
          eventId: deterministicId("event", transactionId, "command-admitted"),
          recordedAt: preparedAt,
          type: "command.admitted",
          threadId: command.threadId,
          sequence: snapshot.latestCursor.sequence,
          detail: command.command.kind,
        })
      : undefined;

    return AdmissionTransactionSchema.parse({
      version: 2,
      kind: "command_admission",
      transactionId,
      preparedAt,
      command,
      receipt,
      snapshot,
      threadsFile,
      journalRecords,
      eventRecord,
      commandIdentity: CommandIdentityRecordSchema.parse({
        version: 1,
        command,
        recordedAt: preparedAt,
      }),
      ...(initialStatus === "admitted" && residentDispatchBinding
        ? {
            residentDispatchAttempt: ResidentDispatchAttemptSchema.parse({
              version: 1,
              attemptId: deterministicId("resident-dispatch", command.deviceId, command.commandId),
              command,
              binding: residentDispatchBinding,
              bindingFingerprint: residentDispatchAuthorityFingerprint(residentDispatchBinding),
              admissionCursor: sourceSnapshot?.latestCursor,
              state: "admitted",
              admittedAt: preparedAt,
              updatedAt: preparedAt,
            }),
          }
        : {}),
      ...(command.command.kind === "model.select"
        ? {
            modelSelectionIdentity: ModelSelectionIdentityRecordSchema.parse({
              version: 1,
              command,
              recordedAt: preparedAt,
            }),
          }
        : {}),
      ...(initialStatus === "admitted" &&
        command.command.kind === "model.select" &&
        modelSelectionBinding
          ? {
              modelSelectionAttempt: ModelSelectionAttemptSchema.parse({
                version: 1,
                command,
                binding: modelSelectionBinding,
                state: "admitted",
                admittedAt: preparedAt,
                updatedAt: preparedAt,
              }),
            }
          : {}),
    });
  }

  private async materializeAdmissionTransactionUnlocked(
    transaction: AdmissionTransaction,
    injectFaults: boolean,
  ): Promise<void> {
    if (transaction.snapshot && transaction.threadsFile) {
      await atomicWriteJson(this.snapshotPath(transaction.command.threadId), transaction.snapshot);
      if (injectFaults) await this.injectAdmissionFault("after_snapshot", transaction.transactionId);

      await atomicWriteJson(this.paths.threads, transaction.threadsFile);
      if (injectFaults) await this.injectAdmissionFault("after_threads", transaction.transactionId);
    }

    const commandIdentityPath = this.commandIdentityPath(transaction.command);
    const existingCommandIdentity = await readJsonFile(commandIdentityPath, CommandIdentityRecordSchema, {
      optional: true,
      maxBytes: MAX_COMMAND_IDENTITY_BYTES,
    });
    if (existingCommandIdentity && !isDeepStrictEqual(existingCommandIdentity, transaction.commandIdentity)) {
      throw new HostStoreError(
        "COMMAND_ID_REUSED",
        `Admission transaction ${transaction.transactionId} conflicts with its durable command identity`,
      );
    }
    await atomicWriteJson(commandIdentityPath, transaction.commandIdentity, MAX_COMMAND_IDENTITY_BYTES);
    if (injectFaults) await this.injectAdmissionFault("after_command_identity", transaction.transactionId);

    if (transaction.residentDispatchAttempt) {
      const attemptPath = this.residentDispatchAttemptPath(transaction.command);
      const existingAttempt = await readJsonFile(attemptPath, ResidentDispatchAttemptSchema, {
        optional: true,
        maxBytes: MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES,
      });
      if (existingAttempt && !isDeepStrictEqual(existingAttempt, transaction.residentDispatchAttempt)) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_CONFLICT",
          `Admission transaction ${transaction.transactionId} conflicts with its durable resident dispatch attempt`,
        );
      }
      await atomicWriteJson(
        attemptPath,
        transaction.residentDispatchAttempt,
        MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES,
      );
      if (injectFaults) {
        await this.injectAdmissionFault("after_resident_dispatch_attempt", transaction.transactionId);
      }
    }

    if (transaction.modelSelectionIdentity) {
      const identityPath = this.modelSelectionIdentityPath(transaction.command);
      const existingIdentity = await readJsonFile(identityPath, ModelSelectionIdentityRecordSchema, {
        optional: true,
        maxBytes: MAX_MODEL_SELECTION_IDENTITY_BYTES,
      });
      if (existingIdentity && !isDeepStrictEqual(existingIdentity, transaction.modelSelectionIdentity)) {
        throw new HostStoreError(
          "COMMAND_ID_REUSED",
          `Admission transaction ${transaction.transactionId} conflicts with its durable model-selection identity`,
        );
      }
      await atomicWriteJson(
        identityPath,
        transaction.modelSelectionIdentity,
        MAX_MODEL_SELECTION_IDENTITY_BYTES,
      );
      if (injectFaults) {
        await this.injectAdmissionFault("after_model_selection_identity", transaction.transactionId);
      }
    }

    if (transaction.modelSelectionAttempt) {
      const attemptPath = this.modelSelectionAttemptPath(transaction.command);
      const existingAttempt = await readJsonFile(attemptPath, ModelSelectionAttemptSchema, {
        optional: true,
        maxBytes: MAX_MODEL_SELECTION_ATTEMPT_BYTES,
      });
      if (existingAttempt && !isDeepStrictEqual(existingAttempt, transaction.modelSelectionAttempt)) {
        throw new HostStoreError(
          "MODEL_SELECTION_ATTEMPT_CONFLICT",
          `Admission transaction ${transaction.transactionId} conflicts with its durable model-selection attempt`,
        );
      }
      await atomicWriteJson(
        attemptPath,
        transaction.modelSelectionAttempt,
        MAX_MODEL_SELECTION_ATTEMPT_BYTES,
      );
      if (injectFaults) {
        await this.injectAdmissionFault("after_model_selection_attempt", transaction.transactionId);
      }
    }

    const existingReceipt = await this.readReceiptUnlocked(transaction.command);
    if (existingReceipt && !isDeepStrictEqual(existingReceipt, transaction.receipt)) {
      throw new HostStoreError(
        "ADMISSION_RECEIPT_CONFLICT",
        `Admission transaction ${transaction.transactionId} conflicts with its durable receipt`,
      );
    }
    await atomicWriteJson(this.receiptPath(transaction.command), transaction.receipt);
    if (injectFaults) await this.injectAdmissionFault("after_receipt", transaction.transactionId);

    for (const record of transaction.journalRecords) {
      await appendJsonLineOnce(this.paths.commandJournal, record, "journalId");
    }
    if (injectFaults) await this.injectAdmissionFault("after_journal", transaction.transactionId);

    if (transaction.eventRecord) {
      await appendJsonLineOnce(this.paths.eventJournal, transaction.eventRecord, "eventId");
    }
    if (injectFaults) await this.injectAdmissionFault("after_event", transaction.transactionId);

    await rm(this.admissionTransactionPath(transaction.command), { force: true });
  }

  /**
   * Finish only the records that a v1 host had already prepared. A legacy
   * envelope is deliberately not promoted into the live exact-identity index,
   * so neither submit nor reconcile can replay it after recovery.
   */
  private async materializeLegacyAdmissionTransactionUnlocked(
    transaction: LegacyAdmissionTransaction,
  ): Promise<void> {
    await this.validateLegacyAdmissionTransactionUnlocked(transaction);

    if (transaction.snapshot && transaction.threadsFile) {
      await atomicWriteJson(this.snapshotPath(transaction.command.threadId), transaction.snapshot);
      await atomicWriteJson(this.paths.threads, transaction.threadsFile);
    }

    if (transaction.modelSelectionIdentity) {
      const strictIdentity = ModelSelectionIdentityRecordSchema.parse(transaction.modelSelectionIdentity);
      const path = this.modelSelectionIdentityPath(transaction.command);
      const existing = await readJsonFile(path, ModelSelectionIdentityRecordSchema, {
        optional: true,
        maxBytes: MAX_MODEL_SELECTION_IDENTITY_BYTES,
      });
      if (existing && !isDeepStrictEqual(existing, strictIdentity)) {
        throw new HostStoreError(
          "COMMAND_ID_REUSED",
          `Legacy admission transaction ${transaction.transactionId} conflicts with its model identity`,
        );
      }
      await atomicWriteJson(path, strictIdentity, MAX_MODEL_SELECTION_IDENTITY_BYTES);
    }

    if (transaction.modelSelectionAttempt) {
      const strictAttempt = ModelSelectionAttemptSchema.parse(transaction.modelSelectionAttempt);
      const path = this.modelSelectionAttemptPath(transaction.command);
      const existing = await readJsonFile(path, ModelSelectionAttemptSchema, {
        optional: true,
        maxBytes: MAX_MODEL_SELECTION_ATTEMPT_BYTES,
      });
      if (existing && !isDeepStrictEqual(existing, strictAttempt)) {
        throw new HostStoreError(
          "MODEL_SELECTION_ATTEMPT_CONFLICT",
          `Legacy admission transaction ${transaction.transactionId} conflicts with its model attempt`,
        );
      }
      await atomicWriteJson(path, strictAttempt, MAX_MODEL_SELECTION_ATTEMPT_BYTES);
    }

    const existingReceipt = await this.readReceiptUnlocked(transaction.command);
    if (existingReceipt && !isDeepStrictEqual(existingReceipt, transaction.receipt)) {
      throw new HostStoreError(
        "ADMISSION_RECEIPT_CONFLICT",
        `Legacy admission transaction ${transaction.transactionId} conflicts with its durable receipt`,
      );
    }
    await atomicWriteJson(this.receiptPath(transaction.command), transaction.receipt);
    for (const record of transaction.journalRecords) {
      await appendJsonLineOnce(this.paths.commandJournal, record, "journalId");
    }
    if (transaction.eventRecord) {
      await appendJsonLineOnce(this.paths.eventJournal, transaction.eventRecord, "eventId");
    }
    await rm(this.admissionTransactionPath(transaction.command), { force: true });
  }

  private async validateLegacyAdmissionTransactionUnlocked(
    transaction: LegacyAdmissionTransaction,
  ): Promise<void> {
    const expectedTransactionId = deterministicId(
      "admission",
      transaction.command.deviceId,
      transaction.command.commandId,
    );
    if (transaction.transactionId !== expectedTransactionId) {
      throw new HostStoreError(
        "INVALID_LEGACY_ADMISSION_TRANSACTION",
        "Legacy admission transaction identity does not match its command",
      );
    }
    if (
      transaction.receipt.status !== "admitted" &&
      transaction.receipt.status !== "rejected"
    ) {
      throw new HostStoreError(
        "INVALID_LEGACY_ADMISSION_TRANSACTION",
        "Legacy admission transaction has an impossible prepared receipt status",
      );
    }
    if (
      transaction.receipt.receivedAt !== transaction.preparedAt ||
      transaction.receipt.updatedAt !== transaction.preparedAt
    ) {
      throw new HostStoreError(
        "INVALID_LEGACY_ADMISSION_TRANSACTION",
        "Legacy admission receipt timestamps do not match its preparation boundary",
      );
    }

    const host = await this.readHostUnlocked();
    if (transaction.command.expectedHostId !== host.hostId) {
      throw new HostStoreError(
        "INVALID_LEGACY_ADMISSION_TRANSACTION",
        "Legacy admission command belongs to a different host authority",
      );
    }

    const targetGeneration = transaction.receipt.executionGenerationId;
    if (
      transaction.command.expectedExecutionGenerationId !== undefined &&
      transaction.command.expectedExecutionGenerationId !== targetGeneration &&
      !(
        transaction.receipt.status === "rejected" &&
        transaction.receipt.error?.code === "STALE_EXECUTION_GENERATION"
      )
    ) {
      throw new HostStoreError(
        "INVALID_LEGACY_ADMISSION_TRANSACTION",
        "Legacy admission changed its explicit execution generation",
      );
    }

    const threads = await this.readThreadsUnlocked();
    const currentThread = threads.find((thread) => thread.threadId === transaction.command.threadId);
    if (!currentThread) {
      if (
        transaction.receipt.status !== "rejected" ||
        transaction.receipt.error?.code !== "THREAD_NOT_FOUND" ||
        transaction.snapshot ||
        transaction.threadsFile ||
        transaction.eventRecord
      ) {
        throw new HostStoreError(
          "INVALID_LEGACY_ADMISSION_TRANSACTION",
          "Legacy admission references a missing thread without a matching terminal rejection",
        );
      }
    } else {
      if (currentThread.currentLocation.executionGenerationId !== targetGeneration) {
        throw new HostStoreError(
          "INVALID_LEGACY_ADMISSION_TRANSACTION",
          "Legacy admission receipt does not match the durable thread generation",
        );
      }
      const currentSnapshot = await this.readSnapshotUnlocked(transaction.command.threadId);
      if (
        currentSnapshot.thread.currentLocation.executionGenerationId !== targetGeneration ||
        currentSnapshot.latestCursor.executionGenerationId !== targetGeneration
      ) {
        throw new HostStoreError(
          "INVALID_LEGACY_ADMISSION_TRANSACTION",
          "Legacy admission does not match the durable snapshot generation",
        );
      }
    }

    if (transaction.snapshot && transaction.threadsFile) {
      await this.validateRecoveredAdmissionCatalogUnlocked(transaction);
      const snapshot = transaction.snapshot;
      const matchingThreads = transaction.threadsFile.threads.filter(
        (thread) => thread.threadId === transaction.command.threadId,
      );
      if (
        transaction.receipt.status !== "admitted" ||
        snapshot.thread.currentLocation.executionGenerationId !== targetGeneration ||
        snapshot.latestCursor.executionGenerationId !== targetGeneration ||
        snapshot.latestCursor.threadId !== transaction.command.threadId ||
        matchingThreads.length !== 1 ||
        !isDeepStrictEqual(matchingThreads[0], snapshot.thread)
      ) {
        throw new HostStoreError(
          "INVALID_LEGACY_ADMISSION_TRANSACTION",
          "Legacy admission snapshot, catalog, and receipt do not describe one authority",
        );
      }
    }

    if (transaction.journalRecords.length !== 2) {
      throw new HostStoreError(
        "INVALID_LEGACY_ADMISSION_TRANSACTION",
        "Legacy admission must contain its exact two prepared journal records",
      );
    }
    const [received, terminal] = transaction.journalRecords;
    if (
      !received ||
      !terminal ||
      received.status !== "received" ||
      terminal.status !== transaction.receipt.status ||
      !isDeepStrictEqual(received.envelope, transaction.command) ||
      received.deviceId !== transaction.command.deviceId ||
      terminal.deviceId !== transaction.command.deviceId ||
      received.commandId !== transaction.command.commandId ||
      terminal.commandId !== transaction.command.commandId ||
      received.threadId !== transaction.command.threadId ||
      terminal.threadId !== transaction.command.threadId ||
      received.commandKind !== transaction.command.command.kind ||
      terminal.commandKind !== transaction.command.command.kind ||
      received.recordedAt !== transaction.preparedAt ||
      terminal.recordedAt !== transaction.preparedAt ||
      received.message !== undefined ||
      terminal.message !== transaction.receipt.message ||
      received.journalId !== deterministicId("journal", transaction.transactionId, "0", "received") ||
      terminal.journalId !==
        deterministicId("journal", transaction.transactionId, "1", transaction.receipt.status)
    ) {
      throw new HostStoreError(
        "INVALID_LEGACY_ADMISSION_TRANSACTION",
        "Legacy admission journal does not exactly match its prepared command and receipt",
      );
    }

    if (transaction.snapshot) {
      const event = transaction.eventRecord;
      if (
        !event ||
        event.eventId !== deterministicId("event", transaction.transactionId, "command-admitted") ||
        event.type !== "command.admitted" ||
        event.threadId !== transaction.command.threadId ||
        event.sequence !== transaction.snapshot.latestCursor.sequence ||
        event.detail !== transaction.command.command.kind ||
        event.recordedAt !== transaction.preparedAt
      ) {
        throw new HostStoreError(
          "INVALID_LEGACY_ADMISSION_TRANSACTION",
          "Legacy admission event does not match its prepared snapshot",
        );
      }
    } else if (transaction.eventRecord) {
      throw new HostStoreError(
        "INVALID_LEGACY_ADMISSION_TRANSACTION",
        "Legacy admission without a snapshot cannot publish an event",
      );
    }
  }

  private async validateRecoveredAdmissionCatalogUnlocked(
    transaction: Pick<
      AdmissionTransaction | LegacyAdmissionTransaction,
      "command" | "receipt" | "snapshot" | "threadsFile"
    >,
  ): Promise<void> {
    if (!transaction.snapshot || !transaction.threadsFile) return;
    const currentThreads = await this.readThreadsUnlocked();
    const preparedThreads = transaction.threadsFile.threads;
    const currentById = new Map(currentThreads.map((thread) => [thread.threadId, thread]));
    const preparedById = new Map(preparedThreads.map((thread) => [thread.threadId, thread]));
    if (
      currentById.size !== currentThreads.length ||
      preparedById.size !== preparedThreads.length ||
      currentThreads.length !== preparedThreads.length ||
      currentById.size !== preparedById.size
    ) {
      throw new HostStoreError(
        "INVALID_ADMISSION_TRANSACTION_CATALOG",
        "Prepared admission catalog changed its cardinality or contains duplicate thread identities",
      );
    }
    for (const [threadId, current] of currentById) {
      const prepared = preparedById.get(threadId);
      if (!prepared) {
        throw new HostStoreError(
          "INVALID_ADMISSION_TRANSACTION_CATALOG",
          "Prepared admission catalog removed a durable thread",
        );
      }
      if (threadId !== transaction.command.threadId) {
        if (!isDeepStrictEqual(prepared, current)) {
          throw new HostStoreError(
            "INVALID_ADMISSION_TRANSACTION_CATALOG",
            "Prepared admission catalog changed an unrelated thread",
          );
        }
        continue;
      }
      const currentLocation = current.currentLocation;
      const preparedLocation = prepared.currentLocation;
      if (
        currentLocation.hostId !== preparedLocation.hostId ||
        currentLocation.projectId !== preparedLocation.projectId ||
        currentLocation.workspaceId !== preparedLocation.workspaceId ||
        currentLocation.executionGenerationId !== transaction.receipt.executionGenerationId ||
        preparedLocation.executionGenerationId !== transaction.receipt.executionGenerationId
      ) {
        throw new HostStoreError(
          "INVALID_ADMISSION_TRANSACTION_CATALOG",
          "Prepared admission target changed its execution authority",
        );
      }
    }
  }

  private async recoverAdmissionTransactionsUnlocked(): Promise<void> {
    const entries = await readdir(this.paths.transactions, { withFileTypes: true });
    if (entries.length > MAX_PENDING_ADMISSION_TRANSACTIONS) {
      throw new HostStoreError(
        "ADMISSION_TRANSACTION_LIMIT",
        `Admission transaction directory exceeds ${MAX_PENDING_ADMISSION_TRANSACTIONS} entries`,
      );
    }

    const transactionNames: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new HostStoreError("INVALID_ADMISSION_TRANSACTION", "Admission transaction directory contains a non-file entry");
      }
      if (entry.name.endsWith(".json")) {
        transactionNames.push(entry.name);
        continue;
      }
      if (entry.name.includes(".json.tmp-")) {
        await rm(join(this.paths.transactions, entry.name), { force: true });
        continue;
      }
      throw new HostStoreError(
        "INVALID_ADMISSION_TRANSACTION",
        `Unexpected admission transaction file ${entry.name}`,
      );
    }

    transactionNames.sort();
    for (const name of transactionNames) {
      const path = join(this.paths.transactions, name);
      const transaction = await readJsonFile(path, RecoverableAdmissionTransactionSchema, {
        maxBytes: MAX_ADMISSION_TRANSACTION_BYTES,
      });
      if (!transaction) throw new HostStoreError("INVALID_ADMISSION_TRANSACTION", `Missing transaction ${name}`);
      if (name !== `${storageKey(transaction.command.deviceId, transaction.command.commandId)}.json`) {
        throw new HostStoreError("INVALID_ADMISSION_TRANSACTION", `Transaction filename does not match ${transaction.transactionId}`);
      }
      if (transaction.version === 1) {
        await this.materializeLegacyAdmissionTransactionUnlocked(transaction);
      } else {
        const host = await this.readHostUnlocked();
        if (transaction.command.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "INVALID_ADMISSION_TRANSACTION",
            "Admission transaction belongs to a different host authority",
          );
        }
        await this.validateRecoveredAdmissionCatalogUnlocked(transaction);
        await this.materializeAdmissionTransactionUnlocked(transaction, false);
      }
    }
  }

  private async recoverInterruptedModelSelectionsUnlocked(): Promise<void> {
    const directory = this.modelSelectionAttemptsDirectory();
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_PENDING_MODEL_SELECTION_ATTEMPTS) {
      throw new HostStoreError(
        "MODEL_SELECTION_ATTEMPT_LIMIT",
        `Model-selection attempt directory exceeds ${MAX_PENDING_MODEL_SELECTION_ATTEMPTS} entries`,
      );
    }

    const attemptNames: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new HostStoreError(
          "MODEL_SELECTION_ATTEMPT_INVALID",
          "Model-selection attempt directory contains a non-file entry",
        );
      }
      if (entry.name.endsWith(".json")) {
        attemptNames.push(entry.name);
        continue;
      }
      if (entry.name.includes(".json.tmp-")) {
        await rm(join(directory, entry.name), { force: true });
        continue;
      }
      throw new HostStoreError(
        "MODEL_SELECTION_ATTEMPT_INVALID",
        `Unexpected model-selection attempt file ${entry.name}`,
      );
    }

    attemptNames.sort();
    for (const name of attemptNames) {
      const path = join(directory, name);
      const attempt = await readJsonFile(path, ModelSelectionAttemptSchema, {
        maxBytes: MAX_MODEL_SELECTION_ATTEMPT_BYTES,
      });
      if (!attempt) {
        throw new HostStoreError("MODEL_SELECTION_ATTEMPT_INVALID", `Missing model-selection attempt ${name}`);
      }
      const expectedName = `${storageKey(attempt.command.deviceId, attempt.command.commandId)}.json`;
      if (name !== expectedName) {
        throw new HostStoreError(
          "MODEL_SELECTION_ATTEMPT_INVALID",
          "Model-selection attempt filename does not match its command identity",
        );
      }
      const current = await this.readReceiptUnlocked(attempt.command);
      if (!current) {
        throw new HostStoreError(
          "MODEL_SELECTION_ATTEMPT_INVALID",
          "Model-selection attempt has no durable command receipt",
        );
      }
      if (
        current.deviceId !== attempt.command.deviceId ||
        current.commandId !== attempt.command.commandId ||
        current.threadId !== attempt.command.threadId ||
        current.executionGenerationId !== attempt.binding.executionGenerationId
      ) {
        throw new HostStoreError(
          "MODEL_SELECTION_ATTEMPT_INVALID",
          "Model-selection attempt conflicts with its durable receipt",
        );
      }
      if (
        (current.status === "running" && attempt.state !== "dispatching") ||
        ((current.status === "completed" || current.status === "uncertain") &&
          attempt.state !== "dispatching") ||
        current.status === "received" ||
        current.status === "rejected" ||
        current.status === "cancelled"
      ) {
        throw new HostStoreError(
          "MODEL_SELECTION_ATTEMPT_INVALID",
          "Model-selection attempt state conflicts with its receipt lifecycle",
        );
      }
      if (
        current.status === "completed" ||
        current.status === "failed" ||
        current.status === "uncertain"
      ) {
        await this.appendModelSelectionJournalUnlocked(
          attempt.command,
          current.status,
          current.updatedAt,
          current.message,
        );
        await rm(path, { force: true });
        continue;
      }

      const recovered = CommandReceiptSchema.parse({
        ...current,
        status: "uncertain",
        queuePosition: undefined,
        message: "Host service restarted before model selection could be authoritatively reconciled",
        error: {
          code: "MODEL_SELECTION_RESTART_UNCERTAIN",
          message: "Model selection was not replayed after the host service or Prime client identity changed",
          retryable: false,
        },
        updatedAt: now(),
      });
      await atomicWriteJson(this.receiptPath(attempt.command), recovered);
      await this.appendModelSelectionJournalUnlocked(
        attempt.command,
        "uncertain",
        recovered.updatedAt,
        recovered.message,
      );
      await rm(path, { force: true });
    }
  }

  private async recoverInterruptedResidentDispatchesUnlocked(): Promise<void> {
    const entries = await readdir(this.paths.residentDispatchAttempts, { withFileTypes: true });
    if (entries.length > MAX_PENDING_RESIDENT_DISPATCH_ATTEMPTS) {
      throw new HostStoreError(
        "RESIDENT_DISPATCH_ATTEMPT_LIMIT",
        `Resident dispatch attempt directory exceeds ${MAX_PENDING_RESIDENT_DISPATCH_ATTEMPTS} entries`,
      );
    }

    const attemptNames: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Resident dispatch attempt directory contains a non-file entry",
        );
      }
      if (entry.name.endsWith(".json")) {
        attemptNames.push(entry.name);
        continue;
      }
      if (entry.name.includes(".json.tmp-")) {
        await rm(join(this.paths.residentDispatchAttempts, entry.name), { force: true });
        continue;
      }
      throw new HostStoreError(
        "RESIDENT_DISPATCH_ATTEMPT_INVALID",
        `Unexpected resident dispatch attempt file ${entry.name}`,
      );
    }

    attemptNames.sort();
    for (const name of attemptNames) {
      const path = join(this.paths.residentDispatchAttempts, name);
      const attempt = await readJsonFile(path, ResidentDispatchAttemptSchema, {
        maxBytes: MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES,
      });
      if (!attempt) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          `Missing resident dispatch attempt ${name}`,
        );
      }
      const expectedName = `${storageKey(attempt.command.deviceId, attempt.command.commandId)}.json`;
      if (name !== expectedName) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Resident dispatch attempt filename does not match its command identity",
        );
      }
      const identity = await this.readCommandIdentityUnlocked(attempt.command);
      if (!identity || !isDeepStrictEqual(identity.command, attempt.command)) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Resident dispatch attempt has no exact durable command identity",
        );
      }
      const host = await this.readHostUnlocked();
      if (attempt.command.expectedHostId !== host.hostId) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Resident dispatch attempt belongs to a different host authority",
        );
      }
      const currentBinding = await this.resolveResidentDispatchBindingUnlocked(attempt.command);
      if (
        residentDispatchAuthorityFingerprint(currentBinding) !== attempt.bindingFingerprint
      ) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Resident dispatch attempt no longer matches its durable session authority",
        );
      }
      const current = await this.readReceiptUnlocked(attempt.command);
      if (!current) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Resident dispatch attempt has no durable command receipt",
        );
      }
      this.assertReceiptMatchesCommand(current, attempt.command);

      if (attempt.state === "settled") {
        const finalReceipt = attempt.finalReceipt;
        if (!finalReceipt) {
          throw new HostStoreError(
            "RESIDENT_DISPATCH_ATTEMPT_INVALID",
            "Settled resident dispatch attempt has no final receipt",
          );
        }
        if (attempt.promptIdleObservation) {
          const observation = attempt.promptIdleObservation;
          if (
            !isDeepStrictEqual(current, observation.acknowledgedReceipt) &&
            !isDeepStrictEqual(current, finalReceipt)
          ) {
            throw new HostStoreError(
              "RESIDENT_DISPATCH_ATTEMPT_INVALID",
              "Proof-backed prompt completion conflicts with its durable receipt lifecycle",
            );
          }
          // The persisted observation is the recovery intent. Complete the
          // exact local ordering without invoking Prime, replaying the prompt,
          // or treating an unrelated completed receipt as idle evidence.
          await atomicWriteJson(this.receiptPath(attempt.command), finalReceipt);
          await this.appendResidentDispatchJournalUnlocked(
            attempt.command,
            "completed",
            observation.observedAt,
            finalReceipt.message,
            "idle-completed",
          );
          await this.appendResidentPromptIdleEventUnlocked(observation);
          await rm(path, { force: true });
          this.residentPromptReconciliationLeaseCache.delete(attempt.attemptId);
          continue;
        }
        if (attempt.abortIdleObservation) {
          const observation = attempt.abortIdleObservation;
          if (
            !isDeepStrictEqual(current, observation.acknowledgedReceipt) &&
            !isDeepStrictEqual(current, finalReceipt)
          ) {
            throw new HostStoreError(
              "RESIDENT_DISPATCH_ATTEMPT_INVALID",
              "Proof-backed Stop completion conflicts with its durable receipt lifecycle",
            );
          }
          await atomicWriteJson(this.receiptPath(attempt.command), finalReceipt);
          await this.appendResidentDispatchJournalUnlocked(
            attempt.command,
            "completed",
            observation.observedAt,
            finalReceipt.message,
            "abort-idle-completed",
          );
          await this.appendResidentAbortIdleEventUnlocked(observation);
          await rm(path, { force: true });
          this.residentAbortReconciliationLeaseCache.delete(attempt.attemptId);
          continue;
        }
        const preparedStatus = "admitted";
        if (current.status !== preparedStatus && !isDeepStrictEqual(current, finalReceipt)) {
          throw new HostStoreError(
            "RESIDENT_DISPATCH_ATTEMPT_INVALID",
            "Settled resident dispatch conflicts with its durable receipt",
          );
        }
        await atomicWriteJson(this.receiptPath(attempt.command), finalReceipt);
        await this.appendResidentDispatchJournalUnlocked(
          attempt.command,
          finalReceipt.status,
          finalReceipt.updatedAt,
          finalReceipt.message,
          attempt.dispatchStartedAt ? "settled" : "failed-before-start",
        );
        if (!residentDispatchAttemptRetainsReconciliation(attempt)) {
          await rm(path, { force: true });
        }
        continue;
      }

      if (attempt.state === "admitted") {
        const alreadyRecovered =
          current.status === "failed" && current.error?.code === "RESIDENT_DISPATCH_NOT_STARTED";
        if (current.status !== "admitted" && !alreadyRecovered) {
          throw new HostStoreError(
            "RESIDENT_DISPATCH_ATTEMPT_INVALID",
            "Prepared resident dispatch conflicts with its pre-dispatch receipt",
          );
        }
        const failed = alreadyRecovered
          ? current
          : CommandReceiptSchema.parse({
              ...current,
              status: "failed",
              queuePosition: undefined,
              message: "Host service restarted before resident dispatch began; nothing was sent to Prime Agent",
              error: {
                code: "RESIDENT_DISPATCH_NOT_STARTED",
                message: "The admitted resident command never crossed the upstream dispatch boundary",
                retryable: false,
              },
              updatedAt: now(),
            });
        await atomicWriteJson(this.receiptPath(attempt.command), failed);
        await this.appendResidentDispatchJournalUnlocked(
          attempt.command,
          "failed",
          failed.updatedAt,
          failed.message,
          "recovered-not-started",
        );
        await rm(path, { force: true });
        continue;
      }

      const alreadyRecovered =
        current.status === "uncertain" && current.error?.code === "RESIDENT_DISPATCH_RESTART_UNCERTAIN";
      if (current.status !== "admitted" && current.status !== "running" && !alreadyRecovered) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Dispatching resident attempt conflicts with its no-replay receipt lifecycle",
        );
      }
      const recoveryError = {
        code: "RESIDENT_DISPATCH_RESTART_UNCERTAIN" as const,
        message: "The Prime Agent outcome cannot be proven after the host process identity changed",
        retryable: false,
        diagnosticId: attempt.attemptId,
        details: {
          operation: attempt.command.command.kind,
          replayed: false,
        },
      };
      const uncertain = CommandReceiptSchema.parse({
        ...current,
        status: "uncertain",
        queuePosition: undefined,
        ...(alreadyRecovered
          ? {}
          : {
              message: "Host service restarted after resident dispatch began; the command was not replayed",
              updatedAt: now(),
            }),
        error: recoveryError,
      });
      const settledAttempt = ResidentDispatchAttemptSchema.parse({
        ...attempt,
        state: "settled",
        updatedAt: uncertain.updatedAt,
        settledAt: uncertain.updatedAt,
        finalReceipt: uncertain,
        ...(attempt.command.command.kind === "prompt"
          ? { promptSettlementCursor: (await this.readSnapshotUnlocked(attempt.command.threadId)).latestCursor }
          : attempt.command.command.kind === "abort"
            ? { abortSettlementCursor: (await this.readSnapshotUnlocked(attempt.command.threadId)).latestCursor }
            : {}),
      });
      await atomicWriteJson(path, settledAttempt, MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES);
      await atomicWriteJson(this.receiptPath(attempt.command), uncertain);
      await this.appendResidentDispatchJournalUnlocked(
        attempt.command,
        "uncertain",
        uncertain.updatedAt,
        uncertain.message,
        "recovered-uncertain",
      );
      if (!residentDispatchAttemptRetainsReconciliation(settledAttempt)) {
        await rm(path, { force: true });
      }
    }
  }

  private async assertResidentDispatchAttemptCapacityUnlocked(): Promise<void> {
    const entries = await readdir(this.paths.residentDispatchAttempts, { withFileTypes: true });
    const attempts = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    if (attempts.length >= MAX_PENDING_RESIDENT_DISPATCH_ATTEMPTS) {
      throw new HostStoreError(
        "RESIDENT_DISPATCH_ATTEMPT_LIMIT",
        "The host is already tracking the maximum number of non-replayable resident commands",
        true,
      );
    }
    if (
      entries.some(
        (entry) =>
          !entry.isFile() ||
          (!entry.name.endsWith(".json") && !entry.name.includes(".json.tmp-")),
      )
    ) {
      throw new HostStoreError(
        "RESIDENT_DISPATCH_ATTEMPT_INVALID",
        "Resident dispatch attempt storage contains an unexpected entry",
      );
    }
  }

  private async findResidentPromptLockUnlocked(threadId: string): Promise<ResidentDispatchAttempt | undefined> {
    const entries = await readdir(this.paths.residentDispatchAttempts, { withFileTypes: true });
    if (entries.length > MAX_PENDING_RESIDENT_DISPATCH_ATTEMPTS) {
      throw new HostStoreError(
        "RESIDENT_DISPATCH_ATTEMPT_LIMIT",
        "Resident prompt ownership cannot be inspected because its bounded store is full",
      );
    }
    let match: ResidentDispatchAttempt | undefined;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Resident prompt ownership storage contains an unexpected entry",
        );
      }
      const attempt = await readJsonFile(
        join(this.paths.residentDispatchAttempts, entry.name),
        ResidentDispatchAttemptSchema,
        { maxBytes: MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES },
      );
      if (
        !attempt ||
        entry.name !== `${storageKey(attempt.command.deviceId, attempt.command.commandId)}.json`
      ) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Resident prompt ownership file does not match its exact command identity",
        );
      }
      if (attempt.command.command.kind !== "prompt" || attempt.command.threadId !== threadId) continue;
      if (match) {
        throw new HostStoreError(
          "RESIDENT_PROMPT_LOCK_CONFLICT",
          "A thread has more than one durable resident prompt ownership lock",
        );
      }
      match = attempt;
    }
    return match;
  }

  private async findResidentAbortLockUnlocked(threadId: string): Promise<ResidentDispatchAttempt | undefined> {
    const entries = await readdir(this.paths.residentDispatchAttempts, { withFileTypes: true });
    if (entries.length > MAX_PENDING_RESIDENT_DISPATCH_ATTEMPTS) {
      throw new HostStoreError(
        "RESIDENT_DISPATCH_ATTEMPT_LIMIT",
        "Resident Stop ownership cannot be inspected because its bounded store is full",
      );
    }
    let match: ResidentDispatchAttempt | undefined;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Resident Stop ownership storage contains an unexpected entry",
        );
      }
      const attempt = await readJsonFile(
        join(this.paths.residentDispatchAttempts, entry.name),
        ResidentDispatchAttemptSchema,
        { maxBytes: MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES },
      );
      if (
        !attempt ||
        entry.name !== `${storageKey(attempt.command.deviceId, attempt.command.commandId)}.json`
      ) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Resident Stop ownership file does not match its exact command identity",
        );
      }
      if (
        attempt.command.command.kind !== "abort" ||
        attempt.command.threadId !== threadId
      ) continue;
      if (match) {
        throw new HostStoreError(
          "RESIDENT_ABORT_LOCK_CONFLICT",
          "A thread has more than one acknowledged resident Stop idle-proof lock",
        );
      }
      match = attempt;
    }
    return match;
  }

  private async createResidentPromptReconciliationLeaseUnlocked(
    attempt: ResidentDispatchAttempt,
  ): Promise<ResidentPromptReconciliationLease> {
    if (
      !residentAcknowledgedPromptAttemptRetainsLock(attempt) ||
      !attempt.dispatchStartedAt ||
      !attempt.settledAt ||
      !attempt.finalReceipt ||
      !attempt.promptSettlementCursor
    ) {
      throw new HostStoreError(
        "RESIDENT_PROMPT_RECONCILIATION_INELIGIBLE",
        "Only an exact settled acknowledged-running prompt may acquire an idle reconciliation lease",
      );
    }
    const currentReceipt = await this.readReceiptUnlocked(attempt.command);
    if (!currentReceipt || !isDeepStrictEqual(currentReceipt, attempt.finalReceipt)) {
      throw new HostStoreError(
        "RESIDENT_PROMPT_RECONCILIATION_RECEIPT_CHANGED",
        "The acknowledged prompt receipt changed before idle reconciliation could begin",
      );
    }
    const binding = await this.resolveResidentDispatchBindingUnlocked(attempt.command);
    if (
      !isDeepStrictEqual(
        residentProjectionAuthorityFromBinding(binding),
        residentProjectionAuthorityFromBinding(attempt.binding),
      )
    ) {
      throw new HostStoreError(
        "RESIDENT_PROMPT_RECONCILIATION_BINDING_CHANGED",
        "The resident session authority changed before idle reconciliation could begin",
      );
    }
    const cached = this.residentPromptReconciliationLeaseCache.get(attempt.attemptId);
    if (
      cached &&
      cached.dispatchStartedAt === attempt.dispatchStartedAt &&
      cached.settledAt === attempt.settledAt &&
      cached.receiptUpdatedAt === currentReceipt.updatedAt &&
      isDeepStrictEqual(cached.command, attempt.command) &&
      isDeepStrictEqual(cached.binding, binding) &&
      isDeepStrictEqual(cached.settlementCursor, attempt.promptSettlementCursor)
    ) {
      return cached;
    }
    const lease = createResidentPromptReconciliationLease(attempt, binding);
    this.residentPromptReconciliationLeases.add(lease as object);
    this.residentPromptReconciliationLeaseCache.set(attempt.attemptId, lease);
    return lease;
  }

  private async createResidentAbortReconciliationLeaseUnlocked(
    attempt: ResidentDispatchAttempt,
  ): Promise<ResidentAbortReconciliationLease> {
    if (
      !residentAcknowledgedAbortAttemptRetainsLock(attempt) ||
      !attempt.dispatchStartedAt ||
      !attempt.settledAt ||
      !attempt.finalReceipt ||
      !attempt.abortSettlementCursor
    ) {
      throw new HostStoreError(
        "RESIDENT_ABORT_RECONCILIATION_INELIGIBLE",
        "Only an exact acknowledged-running Stop may acquire an idle reconciliation lease",
      );
    }
    const currentReceipt = await this.readReceiptUnlocked(attempt.command);
    if (!currentReceipt || !isDeepStrictEqual(currentReceipt, attempt.finalReceipt)) {
      throw new HostStoreError(
        "RESIDENT_ABORT_RECONCILIATION_RECEIPT_CHANGED",
        "The acknowledged Stop receipt changed before idle reconciliation could begin",
      );
    }
    const binding = await this.resolveResidentDispatchBindingUnlocked(attempt.command);
    if (
      !isDeepStrictEqual(
        residentProjectionAuthorityFromBinding(binding),
        residentProjectionAuthorityFromBinding(attempt.binding),
      )
    ) {
      throw new HostStoreError(
        "RESIDENT_ABORT_RECONCILIATION_BINDING_CHANGED",
        "The resident session authority changed before Stop idle reconciliation could begin",
      );
    }
    const cached = this.residentAbortReconciliationLeaseCache.get(attempt.attemptId);
    if (
      cached &&
      cached.dispatchStartedAt === attempt.dispatchStartedAt &&
      cached.settledAt === attempt.settledAt &&
      cached.receiptUpdatedAt === currentReceipt.updatedAt &&
      isDeepStrictEqual(cached.command, attempt.command) &&
      isDeepStrictEqual(cached.binding, binding) &&
      isDeepStrictEqual(cached.settlementCursor, attempt.abortSettlementCursor)
    ) {
      return cached;
    }
    const lease = createResidentAbortReconciliationLease(attempt, binding);
    this.residentAbortReconciliationLeases.add(lease as object);
    this.residentAbortReconciliationLeaseCache.set(attempt.attemptId, lease);
    return lease;
  }

  private async assertResidentAbortIdleProjectionAuthorityUnlocked(
    lease: ResidentAbortReconciliationLease,
    binding: ResidentSessionBinding,
    projection: ResidentProjectionSnapshot,
  ): Promise<ResidentDispatchAttempt> {
    if (!this.residentAbortReconciliationLeases.has(lease as object)) {
      throw new HostStoreError(
        "RESIDENT_ABORT_RECONCILIATION_LEASE_INVALID",
        "A same-cursor idle projection requires a lease issued by this exact HostStore instance",
      );
    }
    const attempt = await this.readResidentDispatchAttemptUnlocked(lease.command);
    if (!attempt || !residentAbortReconciliationLeaseMatchesAttempt(lease, attempt)) {
      throw new HostStoreError(
        "RESIDENT_ABORT_RECONCILIATION_LEASE_INVALID",
        "The acknowledged Stop changed before its idle projection could be published",
      );
    }
    const currentReceipt = await this.readReceiptUnlocked(lease.command);
    if (!currentReceipt || !isDeepStrictEqual(currentReceipt, attempt.finalReceipt)) {
      throw new HostStoreError(
        "RESIDENT_ABORT_RECONCILIATION_RECEIPT_CHANGED",
        "The Stop receipt changed before its idle projection could be published",
      );
    }
    const currentBinding = await this.resolveResidentDispatchBindingUnlocked(lease.command);
    if (!isDeepStrictEqual(currentBinding, lease.binding) || !isDeepStrictEqual(binding, lease.binding)) {
      throw new HostStoreError(
        "RESIDENT_ABORT_RECONCILIATION_BINDING_CHANGED",
        "The resident binding changed before the Stop idle projection could be published",
      );
    }
    if (
      projection.identity.activeSessionId !== binding.activeSessionId ||
      projection.identity.sessionId !== binding.sessionId ||
      projection.identity.sessionFile !== binding.sessionFile ||
      !sameCanonicalPath(projection.identity.workspaceDirectory, binding.workspaceDirectory) ||
      residentPrivateProjectionReportsActivity(projection)
    ) {
      throw new HostStoreError(
        "RESIDENT_ABORT_IDLE_EVIDENCE_INVALID",
        "Only exact inactive same-connection evidence may publish the Stop idle projection",
      );
    }
    return attempt;
  }

  private async assertNoResidentDispatchTransitionUnlocked(threadId: string, message: string): Promise<void> {
    const entries = await readdir(this.paths.residentDispatchAttempts, { withFileTypes: true });
    if (entries.length > MAX_PENDING_RESIDENT_DISPATCH_ATTEMPTS) {
      throw new HostStoreError(
        "RESIDENT_DISPATCH_ATTEMPT_LIMIT",
        "Resident dispatch authority cannot be inspected because its bounded store is full",
      );
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Resident dispatch authority cannot be inspected because its storage contains an unexpected entry",
        );
      }
      const attempt = await readJsonFile(
        join(this.paths.residentDispatchAttempts, entry.name),
        ResidentDispatchAttemptSchema,
        { maxBytes: MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES },
      );
      if (!attempt) {
        throw new HostStoreError(
          "RESIDENT_DISPATCH_ATTEMPT_INVALID",
          "Resident dispatch authority cannot be inspected because an attempt is missing",
        );
      }
      if (attempt.command.threadId === threadId) {
        throw new HostStoreError("RESIDENT_DISPATCH_ACTIVE", message, true);
      }
    }
  }

  private async assertModelSelectionAttemptCapacityUnlocked(): Promise<void> {
    const entries = await readdir(this.modelSelectionAttemptsDirectory(), { withFileTypes: true });
    const attempts = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    if (attempts.length >= MAX_PENDING_MODEL_SELECTION_ATTEMPTS) {
      throw new HostStoreError(
        "MODEL_SELECTION_ATTEMPT_LIMIT",
        "The host is already tracking the maximum number of non-replayable model selections",
        true,
      );
    }
    if (
      entries.some(
        (entry) =>
          !entry.isFile() ||
          (!entry.name.endsWith(".json") && !entry.name.includes(".json.tmp-")),
      )
    ) {
      throw new HostStoreError(
        "MODEL_SELECTION_ATTEMPT_INVALID",
        "Model-selection attempt storage contains an unexpected entry",
      );
    }
  }

  private async readAdmissionTransactionUnlocked(
    command: CommandIdentity,
  ): Promise<AdmissionTransaction | undefined> {
    return readJsonFile(this.admissionTransactionPath(command), AdmissionTransactionSchema, {
      optional: true,
      maxBytes: MAX_ADMISSION_TRANSACTION_BYTES,
    });
  }

  private async readModelSelectionAttemptUnlocked(
    command: CommandIdentity,
  ): Promise<ModelSelectionAttempt | undefined> {
    return readJsonFile(this.modelSelectionAttemptPath(command), ModelSelectionAttemptSchema, {
      optional: true,
      maxBytes: MAX_MODEL_SELECTION_ATTEMPT_BYTES,
    });
  }

  private async readResidentDispatchAttemptUnlocked(
    command: CommandIdentity,
  ): Promise<ResidentDispatchAttempt | undefined> {
    return readJsonFile(this.residentDispatchAttemptPath(command), ResidentDispatchAttemptSchema, {
      optional: true,
      maxBytes: MAX_RESIDENT_DISPATCH_ATTEMPT_BYTES,
    });
  }

  private async readModelSelectionIdentityUnlocked(
    command: CommandIdentity,
  ): Promise<ModelSelectionIdentityRecord | undefined> {
    return readJsonFile(this.modelSelectionIdentityPath(command), ModelSelectionIdentityRecordSchema, {
      optional: true,
      maxBytes: MAX_MODEL_SELECTION_IDENTITY_BYTES,
    });
  }

  private async readCommandIdentityUnlocked(
    command: CommandIdentity,
  ): Promise<CommandIdentityRecord | undefined> {
    return readJsonFile(this.commandIdentityPath(command), CommandIdentityRecordSchema, {
      optional: true,
      maxBytes: MAX_COMMAND_IDENTITY_BYTES,
    });
  }

  /**
   * Resolve and prove the complete immutable command envelope. The model-only
   * sidecar shipped before the generic index, so exact old model records are
   * migrated lazily without weakening their existing evidence.
   */
  private async resolveCommandIdentityUnlocked(
    command: CommandEnvelope,
  ): Promise<CommandIdentityRecord | undefined> {
    const identity = await this.readCommandIdentityUnlocked(command);
    if (identity && !isDeepStrictEqual(identity.command, command)) {
      throw new HostStoreError("COMMAND_ID_REUSED", "This command identity is already bound to another envelope");
    }

    // Probe the pre-generic model index by device+command identity regardless
    // of the incoming kind. Otherwise a model identity could be overwritten by
    // a later prompt that reused the same key.
    const modelIdentity = await this.readModelSelectionIdentityUnlocked(command);
    if (modelIdentity && !isDeepStrictEqual(modelIdentity.command, command)) {
      throw new HostStoreError("COMMAND_ID_REUSED", "This command identity is already bound to another envelope");
    }
    if (identity) return identity;
    if (!modelIdentity) return undefined;

    const migrated = CommandIdentityRecordSchema.parse({
      version: 1,
      command: modelIdentity.command,
      recordedAt: modelIdentity.recordedAt,
    });
    await atomicWriteJson(this.commandIdentityPath(command), migrated, MAX_COMMAND_IDENTITY_BYTES);
    return migrated;
  }

  private assertReceiptMatchesCommand(receipt: CommandReceipt, command: CommandEnvelope): void {
    if (
      receipt.deviceId !== command.deviceId ||
      receipt.commandId !== command.commandId ||
      receipt.threadId !== command.threadId ||
      receipt.executionGenerationId !== command.expectedExecutionGenerationId
    ) {
      throw new HostStoreError(
        "COMMAND_RECEIPT_GENERATION_MISMATCH",
        "The durable receipt does not acknowledge this exact thread execution envelope",
      );
    }
  }

  private async injectAdmissionFault(point: AdmissionFaultPoint, transactionId: string): Promise<void> {
    await this.options.admissionFaultInjector?.(point, transactionId);
  }

  private async injectResidentProjectionFault(
    point: ResidentProjectionFaultPoint,
    transactionId: string,
  ): Promise<void> {
    await this.options.residentProjectionFaultInjector?.(point, transactionId);
  }

  private async injectResidentDispatchFault(
    point: ResidentDispatchFaultPoint,
    attemptId: string,
  ): Promise<void> {
    await this.options.residentDispatchFaultInjector?.(point, attemptId);
  }

  private async injectResidentLifecycleFault(
    point: ResidentLifecycleFaultPoint,
    operationId: string,
  ): Promise<void> {
    try {
      await this.options.residentLifecycleFaultInjector?.(point, operationId);
    } catch (error) {
      this.initialized = false;
      throw error;
    }
  }

  private async seedIfEmptyUnlocked(): Promise<SeedResult> {
    const [host, projects, threads] = await Promise.all([
      this.readHostUnlocked(),
      this.readProjectsUnlocked(),
      this.readThreadsUnlocked(),
    ]);
    if (projects.length !== 0 || threads.length !== 0) return { seeded: false };

    const createdAt = now();
    const project = SavedProjectSchema.parse({
      projectId: "demo-project",
      hostId: host.hostId,
      workspaceId: "demo-workspace",
      displayName: "Prime Agent Demo",
      lastOpenedAt: createdAt,
    });
    const location = {
      hostId: host.hostId,
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      executionGenerationId: "demo-execution-1",
    };
    const cursor = {
      threadId: "demo-thread",
      executionGenerationId: location.executionGenerationId,
      generation: "demo-generation-1",
      sequence: 1,
    };
    const thread = ThreadSummarySchema.parse({
      threadId: "demo-thread",
      title: "Welcome to Prime Agent",
      projectIdentity: project.projectId,
      currentLocation: location,
      status: "idle",
      recap: "Host service is ready. No agent run has started.",
      unread: false,
      updatedAt: createdAt,
      lastKnownCursor: cursor,
    });
    const text =
      "This is a local demonstration thread created by prime-agent-hostd. It contains no simulated agent output or repository changes.";
    const block = {
      blockId: "demo-status-1",
      kind: "system" as const,
      text,
      createdAt,
      sequence: 1,
    };
    const snapshot = ThreadProjectionSnapshotSchema.parse({
      snapshotVersion: SNAPSHOT_VERSION,
      generatedAt: createdAt,
      thread,
      transcriptBlockIndex: [
        {
          blockId: block.blockId,
          kind: block.kind,
          sequence: block.sequence,
          byteLength: Buffer.byteLength(block.text, "utf8"),
          materialized: true,
        },
      ],
      materializedRecentBlocks: [block],
      queueState: { pendingCommandIds: [], paused: false },
      approvals: [],
      childAgents: [],
      goals: [],
      schedules: [],
      git: { stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
      evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
      pendingAttention: [],
      latestCursor: cursor,
    });

    await atomicWriteJson(this.paths.projects, { version: 1, projects: [project] });
    await atomicWriteJson(this.paths.threads, { version: 1, threads: [thread] });
    await atomicWriteJson(this.snapshotPath(thread.threadId), snapshot);
    await this.appendEventUnlocked({ type: "catalog.seeded", threadId: thread.threadId });
    return { seeded: true, project, thread };
  }

  private async currentWorkspaceScopeUnlocked(
    threadId: string,
    executionGenerationId: string,
  ): Promise<CurrentWorkspaceScope> {
    const [host, projects, threads] = await Promise.all([
      this.readHostUnlocked(),
      this.readProjectsUnlocked(),
      this.readThreadsUnlocked(),
    ]);
    const thread = threads.find((candidate) => candidate.threadId === threadId);
    if (!thread) throw new HostStoreError("THREAD_NOT_FOUND", `Thread ${threadId} does not exist`);
    const location = thread.currentLocation;
    if (location.executionGenerationId !== executionGenerationId) {
      throw new HostStoreError(
        "STALE_EXECUTION_GENERATION",
        "The requested execution generation is no longer authoritative",
      );
    }
    if (location.hostId !== host.hostId) {
      throw new HostStoreError(
        "HOST_NOT_CURRENT_AUTHORITY",
        "This host is not authoritative for the requested thread execution",
      );
    }
    const project = projects.find((candidate) => candidate.projectId === location.projectId);
    if (!project) {
      throw new HostStoreError("PROJECT_NOT_FOUND", `Project ${location.projectId} does not exist`);
    }
    if (project.hostId !== host.hostId || project.workspaceId !== location.workspaceId) {
      throw new HostStoreError(
        "WORKSPACE_IDENTITY_MISMATCH",
        "The current thread location does not match its saved project workspace",
      );
    }
    return Object.freeze({
      hostId: host.hostId,
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      threadId: thread.threadId,
      executionGenerationId: location.executionGenerationId,
    });
  }

  private async resolveModelSelectionBindingUnlocked(command: CommandEnvelope): Promise<ResidentSessionBinding> {
    if (command.command.kind !== "model.select" || command.expectedExecutionGenerationId === undefined) {
      throw new HostStoreError(
        "MODEL_SELECTION_AUTHORITY_INVALID",
        "Model selection requires an exact thread execution generation",
      );
    }
    this.assertResidentSubsystemAvailable();
    await this.assertNoResidentLifecycleOperationUnlocked(command.threadId);
    const host = await this.readHostUnlocked();
    if (command.expectedHostId !== host.hostId) {
      throw new HostStoreError(
        "HOST_AUTHORITY_MISMATCH",
        "The model selection was composed for a different host authority",
      );
    }
    const scope = await this.currentWorkspaceScopeUnlocked(
      command.threadId,
      command.expectedExecutionGenerationId,
    );
    const snapshot = await this.readSnapshotUnlocked(command.threadId);
    if (
      snapshot.thread.threadId !== scope.threadId ||
      snapshot.thread.currentLocation.hostId !== scope.hostId ||
      snapshot.thread.currentLocation.projectId !== scope.projectId ||
      snapshot.thread.currentLocation.workspaceId !== scope.workspaceId ||
      snapshot.thread.currentLocation.executionGenerationId !== scope.executionGenerationId
    ) {
      throw new HostStoreError(
        "MODEL_SELECTION_AUTHORITY_INVALID",
        "The authoritative thread snapshot does not match model-selection admission",
      );
    }
    const workspaceDirectory = await this.resolveWorkspaceDirectoryUnlocked(scope);
    const binding = (await this.readResidentSessionBindingsUnlocked()).find(
      (candidate) => candidate.threadId === scope.threadId,
    );
    if (!binding) {
      throw new HostStoreError(
        "RESIDENT_BINDING_NOT_FOUND",
        "No active resident Prime Agent session is bound to this execution generation",
        true,
      );
    }
    this.assertBindingMatchesScope(binding, scope, workspaceDirectory);
    return validateResidentSessionBinding(binding);
  }

  private async resolveResidentDispatchBindingUnlocked(command: CommandEnvelope): Promise<ResidentSessionBinding> {
    if (command.command.kind !== "prompt" && command.command.kind !== "abort") {
      throw new HostStoreError(
        "RESIDENT_DISPATCH_COMMAND_REQUIRED",
        "Resident dispatch accepts only prompt and abort commands",
      );
    }
    this.assertResidentSubsystemAvailable();
    await this.assertNoResidentLifecycleOperationUnlocked(command.threadId);
    const host = await this.readHostUnlocked();
    if (command.expectedHostId !== host.hostId) {
      throw new HostStoreError(
        "HOST_AUTHORITY_MISMATCH",
        "The resident command was composed for a different host authority",
      );
    }
    const scope = await this.currentWorkspaceScopeUnlocked(
      command.threadId,
      command.expectedExecutionGenerationId,
    );
    const snapshot = await this.readSnapshotUnlocked(command.threadId);
    if (
      snapshot.thread.threadId !== scope.threadId ||
      snapshot.thread.currentLocation.hostId !== scope.hostId ||
      snapshot.thread.currentLocation.projectId !== scope.projectId ||
      snapshot.thread.currentLocation.workspaceId !== scope.workspaceId ||
      snapshot.thread.currentLocation.executionGenerationId !== scope.executionGenerationId ||
      snapshot.latestCursor.threadId !== scope.threadId ||
      snapshot.latestCursor.executionGenerationId !== scope.executionGenerationId
    ) {
      throw new HostStoreError(
        "RESIDENT_DISPATCH_AUTHORITY_INVALID",
        "The authoritative thread snapshot does not match resident dispatch admission",
      );
    }
    const workspaceDirectory = await this.resolveWorkspaceDirectoryUnlocked(scope);
    const binding = (await this.readResidentSessionBindingsUnlocked()).find(
      (candidate) => candidate.threadId === scope.threadId,
    );
    if (!binding) {
      throw new HostStoreError(
        "RESIDENT_BINDING_NOT_FOUND",
        "No active resident Prime Agent session is bound to this execution generation",
        true,
      );
    }
    this.assertBindingMatchesScope(binding, scope, workspaceDirectory);
    return validateResidentSessionBinding(binding);
  }

  private async resolveWorkspaceDirectoryUnlocked(scope: CurrentWorkspaceScope): Promise<string> {
    const authority = (await this.readWorkspaceAuthoritiesUnlocked()).find(
      (candidate) => candidate.threadId === scope.threadId,
    );
    if (!authority) {
      throw new HostStoreError(
        "WORKSPACE_AUTHORITY_NOT_FOUND",
        "No private workspace path is registered for this thread",
      );
    }
    if (!workspaceAuthorityMatchesScope(authority, scope)) {
      throw new HostStoreError(
        "WORKSPACE_AUTHORITY_MISMATCH",
        "The registered workspace does not belong to the current execution authority",
      );
    }
    const canonicalDirectory = await canonicalWorkspaceDirectory(authority.workspaceDirectory);
    if (!sameCanonicalPath(authority.workspaceDirectory, canonicalDirectory)) {
      throw new HostStoreError(
        "WORKSPACE_PATH_MISMATCH",
        "The registered workspace path is no longer its canonical physical path",
      );
    }
    return authority.workspaceDirectory;
  }

  private assertBindingMatchesScope(
    binding: ResidentSessionBinding,
    scope: CurrentWorkspaceScope,
    workspaceDirectory: string,
  ): void {
    if (
      binding.threadId !== scope.threadId ||
      binding.executionGenerationId !== scope.executionGenerationId
    ) {
      throw new HostStoreError(
        "RESIDENT_BINDING_AUTHORITY_MISMATCH",
        "The resident session binding belongs to a different thread execution generation",
      );
    }
    if (!sameCanonicalPath(binding.workspaceDirectory, workspaceDirectory)) {
      throw new HostStoreError(
        "RESIDENT_BINDING_PATH_MISMATCH",
        "The resident session binding belongs to a different workspace path",
      );
    }
  }

  private residentLifecycleOperationPath(operationId: string): string {
    return join(this.paths.residentLifecycleOperations, `${storageKey(operationId)}.json`);
  }

  private async validateResidentLifecycleOperationDirectoryUnlocked(): Promise<void> {
    const records = await this.readResidentLifecycleOperationsUnlocked(true);
    const nonterminalThreads = new Set<string>();
    for (const record of records) {
      if (!residentLifecycleOperationIsNonterminal(record)) continue;
      if (nonterminalThreads.has(record.input.threadId)) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_STATE_INVALID",
          "A thread has more than one nonterminal resident lifecycle operation",
        );
      }
      nonterminalThreads.add(record.input.threadId);
    }
  }

  private async readResidentLifecycleOperationsUnlocked(cleanTemporaryFiles = false): Promise<ResidentLifecycleOperationRecord[]> {
    const entries = await readdir(this.paths.residentLifecycleOperations, { withFileTypes: true });
    const records: ResidentLifecycleOperationRecord[] = [];
    const operationIds = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_STATE_INVALID",
          "The resident lifecycle registry contains a non-file entry",
        );
      }
      if (entry.name.includes(".json.tmp-")) {
        if (cleanTemporaryFiles) {
          await rm(join(this.paths.residentLifecycleOperations, entry.name), { force: true });
          continue;
        }
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_STATE_INVALID",
          "The resident lifecycle registry contains an incomplete temporary entry",
        );
      }
      if (!entry.name.endsWith(".json")) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_STATE_INVALID",
          "The resident lifecycle registry contains an unexpected entry",
        );
      }
      if (records.length >= MAX_RESIDENT_LIFECYCLE_OPERATIONS) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_LIMIT_REACHED",
          "The resident lifecycle operation registry exceeds its bounded entry limit",
        );
      }
      const path = join(this.paths.residentLifecycleOperations, entry.name);
      const record = await readJsonFile(path, ResidentLifecycleOperationRecordSchema, {
        maxBytes: MAX_RESIDENT_LIFECYCLE_OPERATION_BYTES,
      });
      if (!record || entry.name !== `${storageKey(record.operationId)}.json` || operationIds.has(record.operationId)) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_STATE_INVALID",
          "A resident lifecycle filename does not match one unique operation identity",
        );
      }
      operationIds.add(record.operationId);
      records.push(record);
    }
    return records.sort((left, right) => left.operationId.localeCompare(right.operationId));
  }

  private async readResidentLifecycleOperationUnlocked(
    operationId: string,
  ): Promise<ResidentLifecycleOperationRecord | undefined> {
    const record = await readJsonFile(
      this.residentLifecycleOperationPath(operationId),
      ResidentLifecycleOperationRecordSchema,
      { optional: true, maxBytes: MAX_RESIDENT_LIFECYCLE_OPERATION_BYTES },
    );
    if (record && record.operationId !== operationId) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_STATE_INVALID",
        "The resident lifecycle record changed its operation identity",
      );
    }
    return record;
  }

  private async writeResidentLifecycleOperationUnlocked(recordValue: ResidentLifecycleOperationRecord): Promise<void> {
    const record = ResidentLifecycleOperationRecordSchema.parse(recordValue);
    const existing = await this.readResidentLifecycleOperationUnlocked(record.operationId);
    if (!existing) {
      const entries = await readdir(this.paths.residentLifecycleOperations, { withFileTypes: true });
      if (entries.length >= MAX_RESIDENT_LIFECYCLE_OPERATIONS) {
        throw new HostStoreError(
          "RESIDENT_LIFECYCLE_LIMIT_REACHED",
          "The resident lifecycle operation registry is full",
        );
      }
    }
    await atomicWriteJson(
      this.residentLifecycleOperationPath(record.operationId),
      record,
      MAX_RESIDENT_LIFECYCLE_OPERATION_BYTES,
    );
  }

  private async writeResidentLifecycleBoundaryUnlocked(
    record: ResidentLifecycleOperationRecord,
    faultPoint: ResidentLifecycleFaultPoint,
  ): Promise<void> {
    try {
      await this.writeResidentLifecycleOperationUnlocked(record);
      await this.injectResidentLifecycleFault(faultPoint, record.operationId);
    } catch (error) {
      this.initialized = false;
      throw error;
    }
  }

  private async guardResidentLifecycleMaterializationUnlocked(
    materialize: () => Promise<void>,
  ): Promise<void> {
    try {
      await materialize();
    } catch (error) {
      this.initialized = false;
      throw error;
    }
  }

  private async resolveExactResidentLifecycleOperationUnlocked(
    kind: ResidentLifecycleKind,
    input: ResidentLifecycleOperationInput,
    options: { optional: boolean },
  ): Promise<ResidentLifecycleOperationRecord | undefined> {
    const record = await this.readResidentLifecycleOperationUnlocked(input.operationId);
    if (!record) {
      if (options.optional) return undefined;
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_OPERATION_NOT_FOUND",
        "No durable resident lifecycle operation exists for this identity",
      );
    }
    if (record.kind !== kind || !isDeepStrictEqual(record.input, input)) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_OPERATION_ID_REUSED",
        "This resident lifecycle operation ID is already bound to a different exact envelope",
      );
    }
    return record;
  }

  private async requireExactResidentLifecycleOperationUnlocked(
    kind: ResidentLifecycleKind,
    input: ResidentLifecycleOperationInput,
  ): Promise<ResidentLifecycleOperationRecord> {
    const record = await this.resolveExactResidentLifecycleOperationUnlocked(kind, input, { optional: false });
    if (!record) throw new HostStoreError("RESIDENT_LIFECYCLE_OPERATION_NOT_FOUND", "Lifecycle operation is missing");
    return record;
  }

  private async resolveResidentLifecycleAuthorityUnlocked(
    input: ResidentLifecycleOperationInput,
  ): Promise<ResidentLifecycleAuthority> {
    const host = await this.readHostUnlocked();
    if (host.hostId !== input.expectedHostId) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_HOST_MISMATCH",
        "The resident lifecycle operation targets a different host authority",
      );
    }
    const scope = await this.currentWorkspaceScopeUnlocked(input.threadId, input.executionGenerationId);
    if (scope.projectId !== input.projectId || scope.workspaceId !== input.workspaceId) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_AUTHORITY_MISMATCH",
        "The resident lifecycle envelope does not match the current project and workspace authority",
      );
    }
    await this.resolveWorkspaceDirectoryUnlocked(scope);
    const authority = (await this.readWorkspaceAuthoritiesUnlocked()).find(
      (candidate) => candidate.threadId === input.threadId,
    );
    if (!authority || !workspaceAuthorityMatchesScope(authority, scope)) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_AUTHORITY_MISMATCH",
        "The resident lifecycle operation has no exact canonical workspace authority",
      );
    }
    const canonicalDirectory = await canonicalWorkspaceDirectory(authority.workspaceDirectory);
    if (!sameCanonicalPath(canonicalDirectory, authority.workspaceDirectory)) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_AUTHORITY_MISMATCH",
        "The resident lifecycle workspace authority is no longer canonical",
      );
    }
    return ResidentLifecycleAuthoritySchema.parse({
      ...authority,
      authorityDigest: residentLifecycleAuthorityDigest(authority),
    });
  }

  private async assertResidentLifecycleAuthorityCurrentUnlocked(
    record: ResidentLifecycleOperationRecord,
  ): Promise<void> {
    let current: ResidentLifecycleAuthority;
    try {
      current = await this.resolveResidentLifecycleAuthorityUnlocked(record.input);
    } catch (error) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_AUTHORITY_CHANGED",
        "The durable resident lifecycle operation no longer matches current execution authority",
        false,
        { cause: error },
      );
    }
    if (!isDeepStrictEqual(current, record.authority)) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_AUTHORITY_CHANGED",
        "The canonical workspace authority changed after lifecycle preparation",
      );
    }
  }

  private async assertNoResidentLifecycleOperationUnlocked(threadId: string): Promise<void> {
    this.assertResidentSubsystemAvailable();
    const operation = (await this.readResidentLifecycleOperationsUnlocked()).find(
      (candidate) => candidate.input.threadId === threadId && residentLifecycleOperationIsNonterminal(candidate),
    );
    if (operation) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_IN_PROGRESS",
        "This thread has a nonterminal resident lifecycle operation and is read-only until it is resolved",
        operation.phase !== "quarantined",
      );
    }
  }

  private async residentBindingFromOwnedCandidateUnlocked(
    record: ResidentLifecycleOperationRecord,
    candidate: ResidentOwnedSessionCandidate,
  ): Promise<ResidentSessionBinding> {
    const candidateCanonicalDirectory = await canonicalWorkspaceDirectory(candidate.workspaceDirectory);
    if (
      !sameCanonicalPath(candidate.workspaceDirectory, candidateCanonicalDirectory) ||
      !sameCanonicalPath(candidateCanonicalDirectory, record.authority.workspaceDirectory)
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_CANDIDATE_AUTHORITY_MISMATCH",
        "The owned resident candidate does not use the exact canonical lifecycle workspace",
      );
    }
    if (
      Date.parse(candidate.boundAt) < Date.parse(record.preparedAt) ||
      Date.parse(candidate.boundAt) < Date.parse(record.authority.registeredAt)
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_CANDIDATE_TIME_INVALID",
        "The owned resident candidate identity predates its durable lifecycle authority",
      );
    }
    return validateResidentSessionBinding({
      bindingVersion: 1,
      lifecycle: "resident",
      threadId: record.input.threadId,
      executionGenerationId: record.input.executionGenerationId,
      workspaceDirectory: record.authority.workspaceDirectory,
      activeSessionId: candidate.activeSessionId,
      sessionId: candidate.sessionId,
      ...(candidate.sessionFile ? { sessionFile: candidate.sessionFile } : {}),
      boundAt: candidate.boundAt,
      runtime: candidate.runtime,
    });
  }

  private async assertResidentLifecycleCandidateUnusedUnlocked(
    operation: ResidentLifecycleOperationRecord,
    binding: ResidentSessionBinding,
  ): Promise<void> {
    const bindingRecords = await this.readResidentSessionBindingRecordsUnlocked();
    const lifecycleRecords = await this.readResidentLifecycleOperationsUnlocked();
    const reusedBinding = bindingRecords.find((record) => residentSessionIdentitiesOverlap(record.binding, binding));
    const reusedOperation = lifecycleRecords.find(
      (record) =>
        record.operationId !== operation.operationId &&
        record.binding !== undefined &&
        residentSessionIdentitiesOverlap(record.binding, binding),
    );
    if (reusedBinding || reusedOperation) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_CANDIDATE_REUSED",
        "The owned resident candidate identity is already reserved by durable state",
      );
    }
    if (
      bindingRecords.some(
        (record) =>
          (record.state === "active" || record.state === "activating") &&
          record.binding.threadId === binding.threadId,
      )
    ) {
      throw new HostStoreError(
        "RESIDENT_BINDING_ALREADY_ACTIVE",
        "The lifecycle thread already has an active or activating resident binding",
      );
    }
  }

  private assertBindingMatchesLifecycleAuthority(
    binding: ResidentSessionBinding,
    authority: ResidentLifecycleAuthority,
  ): void {
    if (
      binding.threadId !== authority.threadId ||
      binding.executionGenerationId !== authority.executionGenerationId ||
      !sameCanonicalPath(binding.workspaceDirectory, authority.workspaceDirectory)
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_BINDING_MISMATCH",
        "The resident binding does not match the exact lifecycle authority",
      );
    }
  }

  private async assertExactActiveResidentBindingUnlocked(binding: ResidentSessionBinding): Promise<void> {
    const active = (await this.readResidentSessionBindingRecordsUnlocked()).find(
      (record) => record.state === "active" && record.binding.threadId === binding.threadId,
    );
    if (!active || !isDeepStrictEqual(active.binding, binding)) {
      throw new HostStoreError(
        "RESIDENT_BINDING_CONFLICT",
        "Only the exact active resident binding may cross this lifecycle boundary",
      );
    }
  }

  private async materializeActivatingResidentBindingUnlocked(
    operation: ResidentLifecycleOperationRecord,
  ): Promise<void> {
    const activatingPhase =
      operation.phase === "promoted_observed" ||
      operation.phase === "projection_committed" ||
      (operation.phase === "quarantined" &&
        (operation.quarantinedFrom === "promoted_observed" ||
          operation.quarantinedFrom === "projection_committed"));
    if (
      operation.kind !== "provision" ||
      !activatingPhase ||
      !operation.binding
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_ACTIVATION_INVALID",
        "Only an exact post-promotion operation can materialize an activating binding",
      );
    }
    const records = await this.readResidentSessionBindingRecordsUnlocked();
    const sameIdentity = records.find((record) => isDeepStrictEqual(record.binding, operation.binding));
    if (
      sameIdentity?.state === "activating" &&
      sameIdentity.operationId === operation.operationId
    ) {
      return;
    }
    if (
      sameIdentity?.state === "active" &&
      (operation.phase === "projection_committed" ||
        (operation.phase === "quarantined" && operation.quarantinedFrom === "projection_committed"))
    ) return;
    if (sameIdentity) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_BINDING_CONFLICT",
        "The lifecycle candidate identity is already reserved by another binding state",
      );
    }
    if (
      records.some(
        (record) =>
          (record.state === "active" || record.state === "activating") &&
          record.binding.threadId === operation.input.threadId,
      )
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_BINDING_CONFLICT",
        "The lifecycle thread already has an active or activating binding",
      );
    }
    if (records.length >= MAX_RESIDENT_SESSION_BINDINGS) {
      throw new HostStoreError("RESIDENT_BINDING_LIMIT_REACHED", "The resident binding registry is full");
    }
    records.push(
      ResidentSessionBindingRecordSchema.parse({
        state: "activating",
        binding: operation.binding,
        operationId: operation.operationId,
        observedAt: operation.updatedAt,
      }),
    );
    await this.writeResidentSessionBindingRecordsUnlocked(records);
  }

  private async materializeActiveResidentBindingUnlocked(
    operation: ResidentLifecycleOperationRecord,
  ): Promise<void> {
    if (operation.kind !== "provision" || operation.phase !== "projection_committed" || !operation.binding) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_COMMIT_INVALID",
        "Only a projection-proven provisioning operation can activate a resident binding",
      );
    }
    const records = await this.readResidentSessionBindingRecordsUnlocked();
    const index = records.findIndex((record) => isDeepStrictEqual(record.binding, operation.binding));
    const current = index >= 0 ? records[index] : undefined;
    if (current?.state === "active") return;
    if (current?.state !== "activating" || current.operationId !== operation.operationId) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_BINDING_CONFLICT",
        "The exact activating binding is missing from projection-proven lifecycle state",
      );
    }
    records[index] = ResidentSessionBindingRecordSchema.parse({
      state: "active",
      binding: operation.binding,
      operationId: operation.operationId,
    });
    await this.writeResidentSessionBindingRecordsUnlocked(records);
  }

  private async assertResidentLifecycleProjectionProofUnlocked(
    operation: ResidentLifecycleOperationRecord,
  ): Promise<void> {
    if (!operation.binding || !operation.projectionProof) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_PROJECTION_PROOF_REQUIRED",
        "The lifecycle operation has no exact durable projection proof",
      );
    }
    const lineage = await this.readResidentProjectionLineageUnlocked(
      residentProjectionAuthorityFromBinding(operation.binding),
    );
    const snapshot = await this.readSnapshotUnlocked(operation.binding.threadId);
    const catalogThread = (await this.readThreadsUnlocked()).find(
      (thread) => thread.threadId === operation.binding?.threadId,
    );
    if (
      !lineage ||
      lineage.current.generation !== operation.projectionProof.cursorGeneration ||
      lineage.current.sequence !== operation.projectionProof.cursorSequence ||
      lineage.current.digest !== operation.projectionProof.projectionDigest ||
      residentPublishedProjectionDigest(snapshot) !== operation.projectionProof.projectionDigest ||
      snapshot.generatedAt !== operation.projectionProof.publishedAt ||
      snapshot.latestCursor.threadId !== operation.binding.threadId ||
      snapshot.latestCursor.executionGenerationId !== operation.binding.executionGenerationId ||
      snapshot.latestCursor.generation !== operation.projectionProof.cursorGeneration ||
      snapshot.latestCursor.sequence !== operation.projectionProof.cursorSequence ||
      snapshot.runtime?.residency !== "resident" ||
      snapshot.runtime.activeSessionId !== operation.binding.activeSessionId ||
      snapshot.runtime.sessionId !== operation.binding.sessionId ||
      !catalogThread ||
      !isDeepStrictEqual(catalogThread, snapshot.thread)
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_PROJECTION_PROOF_MISMATCH",
        "The activating binding no longer has its exact durable projection lineage",
      );
    }
  }

  private async assertResidentLifecycleProjectionLeaseAuthorityUnlocked(
    leaseValue: ResidentLifecycleProjectionLease,
    binding: ResidentSessionBinding,
  ): Promise<ResidentLifecycleOperationRecord> {
    const lease = this.validateResidentLifecycleProjectionLease(leaseValue);
    const operation = await this.readResidentLifecycleOperationUnlocked(lease.operationId);
    if (
      !operation ||
      operation.kind !== "provision" ||
      (operation.phase !== "promoted_observed" && operation.phase !== "projection_committed") ||
      !operation.binding ||
      operation.operationFingerprint !== lease.operationFingerprint ||
      !isDeepStrictEqual(operation.binding, lease.binding) ||
      !isDeepStrictEqual(binding, lease.binding)
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_LEASE_STALE",
        "The lifecycle projection lease no longer owns the exact activating candidate",
      );
    }
    await this.assertResidentLifecycleAuthorityCurrentUnlocked(operation);
    return operation;
  }

  private async materializeEndingResidentBindingRevocationUnlocked(
    operation: ResidentLifecycleOperationRecord,
  ): Promise<void> {
    if (
      operation.kind !== "end" ||
      !operation.binding ||
      !["ending", "kill_dispatching", "kill_acknowledged", "completed", "quarantined"].includes(operation.phase)
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_END_INVALID",
        "Only an exact resident end operation can revoke its binding",
      );
    }
    const records = await this.readResidentSessionBindingRecordsUnlocked();
    const index = records.findIndex((record) => isDeepStrictEqual(record.binding, operation.binding));
    const current = index >= 0 ? records[index] : undefined;
    if (
      current?.state === "detached" &&
      current.operationId === operation.operationId &&
      current.reason === "ending"
    ) {
      return;
    }
    if (current?.state === "completed" && (operation.phase === "kill_acknowledged" || operation.phase === "completed")) {
      return;
    }
    if (current?.state !== "active") {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_BINDING_CONFLICT",
        "The end operation no longer owns its exact active or revoked binding",
      );
    }
    records[index] = ResidentSessionBindingRecordSchema.parse({
      state: "detached",
      binding: operation.binding,
      operationId: operation.operationId,
      detachedAt: operation.preparedAt,
      reason: "ending",
    });
    await this.writeResidentSessionBindingRecordsUnlocked(records);
  }

  private async materializeDetachedResidentBindingUnlocked(
    operation: ResidentLifecycleOperationRecord,
  ): Promise<void> {
    if (operation.kind !== "detach" || operation.phase !== "detached" || !operation.binding) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_DETACH_INVALID",
        "Only an exact detach operation can revoke its resident binding",
      );
    }
    const records = await this.readResidentSessionBindingRecordsUnlocked();
    const index = records.findIndex((record) => isDeepStrictEqual(record.binding, operation.binding));
    const current = index >= 0 ? records[index] : undefined;
    if (
      current?.state === "detached" &&
      current.operationId === operation.operationId &&
      current.reason === "explicit"
    ) {
      return;
    }
    if (current?.state !== "active") {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_BINDING_CONFLICT",
        "The detach operation no longer owns its exact active binding",
      );
    }
    records[index] = ResidentSessionBindingRecordSchema.parse({
      state: "detached",
      binding: operation.binding,
      operationId: operation.operationId,
      detachedAt: operation.terminalAt,
      reason: "explicit",
    });
    await this.writeResidentSessionBindingRecordsUnlocked(records);
  }

  private async assertResidentBindingRevokedForOperationUnlocked(
    operation: ResidentLifecycleOperationRecord,
  ): Promise<void> {
    const record = (await this.readResidentSessionBindingRecordsUnlocked()).find(
      (candidate) => operation.binding && isDeepStrictEqual(candidate.binding, operation.binding),
    );
    if (
      record?.state !== "detached" ||
      record.operationId !== operation.operationId ||
      record.reason !== "ending"
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_BINDING_NOT_REVOKED",
        "Resident command authority must be durably revoked before kill dispatch",
      );
    }
  }

  private async materializeCompletedResidentBindingUnlocked(
    operation: ResidentLifecycleOperationRecord,
  ): Promise<void> {
    if (
      operation.kind !== "end" ||
      (operation.phase !== "kill_acknowledged" && operation.phase !== "completed") ||
      !operation.binding
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_END_INVALID",
        "Only a kill-acknowledged end operation can complete its binding",
      );
    }
    const records = await this.readResidentSessionBindingRecordsUnlocked();
    const index = records.findIndex((record) => isDeepStrictEqual(record.binding, operation.binding));
    const current = index >= 0 ? records[index] : undefined;
    if (current?.state === "completed") return;
    if (
      current?.state !== "detached" ||
      current.operationId !== operation.operationId ||
      current.reason !== "ending"
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_BINDING_CONFLICT",
        "The kill acknowledgment no longer owns its exact revoked binding",
      );
    }
    records[index] = ResidentSessionBindingRecordSchema.parse({
      state: "completed",
      binding: operation.binding,
      operationId: operation.operationId,
      completedAt: operation.updatedAt,
    });
    await this.writeResidentSessionBindingRecordsUnlocked(records);
  }

  private createResidentLifecycleProjectionLease(
    operation: ResidentLifecycleOperationRecord,
    promotionObservedAt: string,
  ): ResidentLifecycleProjectionLease {
    if (!operation.binding) {
      throw new HostStoreError("RESIDENT_LIFECYCLE_BINDING_MISSING", "Lifecycle candidate binding is missing");
    }
    const lease = Object.freeze({
      [residentLifecycleProjectionLeaseBrand]: true as const,
      leaseVersion: 1 as const,
      operationId: operation.operationId,
      operationFingerprint: operation.operationFingerprint,
      binding: validateResidentSessionBinding(operation.binding),
      promotionObservedAt,
    });
    this.residentLifecycleProjectionLeases.add(lease);
    return lease;
  }

  private validateResidentOwnedCreateLease(value: ResidentOwnedCreateLease): ResidentOwnedCreateLease {
    if (
      !value ||
      typeof value !== "object" ||
      !this.residentOwnedCreateLeases.has(value as object) ||
      value[residentOwnedCreateLeaseBrand] !== true ||
      value.leaseVersion !== 1
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_LEASE_INVALID",
        "Owned create requires an opaque lease issued by this HostStore process",
      );
    }
    return value;
  }

  private validateResidentPromotionLease(value: ResidentPromotionLease): ResidentPromotionLease {
    if (
      !value ||
      typeof value !== "object" ||
      !this.residentPromotionLeases.has(value as object) ||
      value[residentPromotionLeaseBrand] !== true ||
      value.leaseVersion !== 1
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_LEASE_INVALID",
        "Promotion requires an opaque lease issued by this HostStore process",
      );
    }
    return value;
  }

  private validateResidentLifecycleProjectionLease(
    value: ResidentLifecycleProjectionLease,
  ): ResidentLifecycleProjectionLease {
    if (
      !value ||
      typeof value !== "object" ||
      !this.residentLifecycleProjectionLeases.has(value as object) ||
      value[residentLifecycleProjectionLeaseBrand] !== true ||
      value.leaseVersion !== 1
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_LEASE_INVALID",
        "Lifecycle projection requires an opaque lease issued by this HostStore process",
      );
    }
    return value;
  }

  private validateResidentKillLease(value: ResidentKillLease): ResidentKillLease {
    if (
      !value ||
      typeof value !== "object" ||
      !this.residentKillLeases.has(value as object) ||
      value[residentKillLeaseBrand] !== true ||
      value.leaseVersion !== 1
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_LEASE_INVALID",
        "Resident kill requires an opaque lease issued by this HostStore process",
      );
    }
    return value;
  }

  private async requireLifecycleLeaseRecordUnlocked(
    lease: ResidentOwnedCreateLease | ResidentPromotionLease | ResidentKillLease,
    kind: ResidentLifecycleKind,
    phase: "owned_create_dispatching" | "promotion_dispatching" | "kill_dispatching",
  ): Promise<ResidentLifecycleOperationRecord> {
    const record = await this.readResidentLifecycleOperationUnlocked(lease.operationId);
    const leaseBinding = "binding" in lease ? lease.binding : undefined;
    if (
      !record ||
      record.kind !== kind ||
      record.phase !== phase ||
      record.operationFingerprint !== lease.operationFingerprint ||
      record.updatedAt !== lease.dispatchStartedAt ||
      (leaseBinding !== undefined && !isDeepStrictEqual(record.binding, leaseBinding))
    ) {
      throw new HostStoreError(
        "RESIDENT_LIFECYCLE_LEASE_STALE",
        "The lifecycle mutation lease no longer matches its exact durable dispatch boundary",
      );
    }
    return record;
  }

  private async quarantineResidentLifecycleOperationUnlocked(
    record: ResidentLifecycleOperationRecord,
    reason: z.infer<typeof ResidentLifecycleQuarantineReasonSchema>,
  ): Promise<ResidentLifecycleOperationRecord> {
    if (record.phase === "quarantined") return record;
    if (!residentLifecycleOperationIsNonterminal(record)) return record;
    const timestamp = now();
    const quarantined = ResidentLifecycleOperationRecordSchema.parse({
      ...record,
      phase: "quarantined",
      quarantinedFrom: record.phase,
      quarantineReason: reason,
      updatedAt: timestamp,
    });
    await this.writeResidentLifecycleOperationUnlocked(quarantined);
    return quarantined;
  }

  private async recoverResidentLifecycleOperationsUnlocked(
    stage: "before_projection_recovery" | "after_projection_recovery",
  ): Promise<void> {
    const operations = await this.readResidentLifecycleOperationsUnlocked();
    for (const original of operations) {
      let operation = original;

      if (stage === "before_projection_recovery") {
        if (
          operation.phase === "owned_create_dispatching" ||
          operation.phase === "promotion_dispatching" ||
          operation.phase === "kill_dispatching"
        ) {
          operation = await this.quarantineResidentLifecycleOperationUnlocked(
            operation,
            "external_outcome_unknown",
          );
        } else if (operation.phase === "owned_observed") {
          operation = await this.quarantineResidentLifecycleOperationUnlocked(operation, "owned_client_lost");
        }

        if (operation.kind === "end" && operation.binding) {
          if (
            operation.phase === "ending" ||
            (operation.phase === "quarantined" &&
              (operation.quarantinedFrom === "ending" || operation.quarantinedFrom === "kill_dispatching"))
          ) {
            await this.materializeEndingResidentBindingRevocationUnlocked(operation);
          } else if (operation.phase === "kill_acknowledged" || operation.phase === "completed") {
            await this.materializeCompletedResidentBindingUnlocked(operation);
            if (operation.phase === "kill_acknowledged") {
              const completedAt = now();
              operation = ResidentLifecycleOperationRecordSchema.parse({
                ...operation,
                phase: "completed",
                updatedAt: completedAt,
                terminalAt: completedAt,
              });
              await this.writeResidentLifecycleOperationUnlocked(operation);
            }
          }
        } else if (operation.kind === "detach") {
          await this.materializeDetachedResidentBindingUnlocked(operation);
        }

        if (
          operation.kind === "provision" &&
          (operation.phase === "promoted_observed" || operation.phase === "projection_committed")
        ) {
          await this.materializeActivatingResidentBindingUnlocked(operation);
        }

        if (residentLifecycleOperationIsNonterminal(operation) && operation.phase !== "quarantined") {
          try {
            await this.assertResidentLifecycleAuthorityCurrentUnlocked(operation);
          } catch {
            operation = await this.quarantineResidentLifecycleOperationUnlocked(operation, "authority_changed");
          }
        }
      }

      if (stage === "after_projection_recovery" && operation.kind === "provision") {
        if (operation.phase === "promoted_observed" || operation.phase === "projection_committed") {
          await this.materializeActivatingResidentBindingUnlocked(operation);
        }
        if (operation.phase === "projection_committed" && operation.binding) {
          const active = (await this.readResidentSessionBindingRecordsUnlocked()).find(
            (record) => record.state === "active" && isDeepStrictEqual(record.binding, operation.binding),
          );
          if (active) {
            await this.assertResidentLifecycleProjectionProofUnlocked(operation);
            const committedAt = now();
            const committed = ResidentLifecycleOperationRecordSchema.parse({
              ...operation,
              phase: "committed",
              updatedAt: committedAt,
              terminalAt: committedAt,
            });
            await this.writeResidentLifecycleOperationUnlocked(committed);
          }
        }
      }
    }
  }

  private async readWorkspaceAuthoritiesUnlocked(): Promise<WorkspaceAuthority[]> {
    const file = await readJsonFile(this.paths.workspaceAuthorities, WorkspaceAuthorityFileSchema, {
      maxBytes: MAX_WORKSPACE_AUTHORITY_FILE_BYTES,
    });
    if (!file) throw new HostStoreError("WORKSPACE_AUTHORITY_STATE_MISSING", "The workspace registry is missing");
    return file.authorities;
  }

  private async writeWorkspaceAuthoritiesUnlocked(authorities: WorkspaceAuthority[]): Promise<void> {
    const file = WorkspaceAuthorityFileSchema.parse({ version: 1, authorities });
    await atomicWriteJson(this.paths.workspaceAuthorities, file, MAX_WORKSPACE_AUTHORITY_FILE_BYTES);
  }

  private async readResidentSessionBindingsUnlocked(): Promise<ResidentSessionBinding[]> {
    const records = await this.readResidentSessionBindingRecordsUnlocked();
    return records
      .filter((record): record is Extract<ResidentSessionBindingRecord, { state: "active" }> => record.state === "active")
      .map((record) => validateResidentSessionBinding(record.binding));
  }

  private async readResidentSessionBindingRecordsUnlocked(): Promise<ResidentSessionBindingRecord[]> {
    const file = await readJsonFile(this.paths.residentSessionBindings, ResidentSessionBindingFileSchema, {
      maxBytes: MAX_RESIDENT_SESSION_BINDING_FILE_BYTES,
    });
    if (!file) {
      throw new HostStoreError("RESIDENT_BINDING_STATE_MISSING", "The resident session binding registry is missing");
    }
    return file.records.map((record) => ({
      ...record,
      binding: validateResidentSessionBinding(record.binding),
    })) as ResidentSessionBindingRecord[];
  }

  private async writeResidentSessionBindingRecordsUnlocked(records: ResidentSessionBindingRecord[]): Promise<void> {
    const file = ResidentSessionBindingFileSchema.parse({ version: 1, records });
    await atomicWriteJson(this.paths.residentSessionBindings, file, MAX_RESIDENT_SESSION_BINDING_FILE_BYTES);
  }

  private async validateResidentStateUnlocked(): Promise<void> {
    const [host, projects, threads, authorities, bindingRecords, lifecycleOperations] = await Promise.all([
      this.readHostUnlocked(),
      this.readProjectsUnlocked(),
      this.readThreadsUnlocked(),
      this.readWorkspaceAuthoritiesUnlocked(),
      this.readResidentSessionBindingRecordsUnlocked(),
      this.readResidentLifecycleOperationsUnlocked(),
    ]);
    const bindings = bindingRecords
      .filter((record): record is Extract<ResidentSessionBindingRecord, { state: "active" }> => record.state === "active")
      .map((record) => record.binding);
    const projectsById = new Map(projects.map((project) => [project.projectId, project]));
    const threadsById = new Map(threads.map((thread) => [thread.threadId, thread]));
    const authoritiesByThread = new Map(authorities.map((authority) => [authority.threadId, authority]));
    const workspaceOwners = new Map<string, WorkspaceAuthority>();

    for (const authority of authorities) {
      const thread = threadsById.get(authority.threadId);
      const project = projectsById.get(authority.projectId);
      if (!thread || !project) {
        throw new HostStoreError(
          "WORKSPACE_AUTHORITY_INVALID",
          "A workspace authority references a missing saved project or thread",
        );
      }
      if (
        authority.hostId !== host.hostId ||
        project.hostId !== authority.hostId ||
        project.workspaceId !== authority.workspaceId
      ) {
        throw new HostStoreError(
          "WORKSPACE_AUTHORITY_INVALID",
          "A workspace authority does not match its durable host and project identity",
        );
      }
      const pathKey = canonicalPathKey(authority.workspaceDirectory);
      const owner = workspaceOwners.get(pathKey);
      if (
        owner &&
        (owner.hostId !== authority.hostId ||
          owner.projectId !== authority.projectId ||
          owner.workspaceId !== authority.workspaceId)
      ) {
        throw new HostStoreError(
          "WORKSPACE_PATH_REUSED",
          "A canonical workspace path is registered to multiple saved workspaces",
        );
      }
      workspaceOwners.set(pathKey, authority);
    }

    for (const binding of bindings) {
      const thread = threadsById.get(binding.threadId);
      const authority = authoritiesByThread.get(binding.threadId);
      if (!thread || !authority) {
        throw new HostStoreError(
          "RESIDENT_BINDING_AUTHORITY_MISMATCH",
          "A resident session binding has no saved thread workspace authority",
        );
      }
      const location = thread.currentLocation;
      const scope: CurrentWorkspaceScope = {
        hostId: location.hostId,
        projectId: location.projectId,
        workspaceId: location.workspaceId,
        threadId: thread.threadId,
        executionGenerationId: location.executionGenerationId,
      };
      if (location.hostId !== host.hostId || !workspaceAuthorityMatchesScope(authority, scope)) {
        throw new HostStoreError(
          "RESIDENT_BINDING_AUTHORITY_MISMATCH",
          "A resident session binding is not owned by the current host execution authority",
        );
      }
      const canonicalDirectory = await canonicalWorkspaceDirectory(authority.workspaceDirectory);
      if (!sameCanonicalPath(authority.workspaceDirectory, canonicalDirectory)) {
        throw new HostStoreError(
          "WORKSPACE_PATH_MISMATCH",
          "An active resident session workspace is no longer at its canonical physical path",
        );
      }
      this.assertBindingMatchesScope(binding, scope, authority.workspaceDirectory);
      if (!sameCanonicalPath(binding.workspaceDirectory, canonicalDirectory)) {
        throw new HostStoreError(
          "RESIDENT_BINDING_PATH_MISMATCH",
          "An active resident binding does not match its canonical workspace path",
        );
      }
    }

    const lifecycleById = new Map(lifecycleOperations.map((operation) => [operation.operationId, operation]));
    for (const record of bindingRecords) {
      const binding = validateResidentSessionBinding(record.binding);
      if (record.state === "activating") {
        const operation = lifecycleById.get(record.operationId);
        const validPhase =
          operation?.phase === "promoted_observed" ||
          operation?.phase === "projection_committed" ||
          (operation?.phase === "quarantined" &&
            (operation.quarantinedFrom === "promoted_observed" ||
              operation.quarantinedFrom === "projection_committed"));
        if (
          !operation ||
          operation.kind !== "provision" ||
          !validPhase ||
          !operation.binding ||
          !isDeepStrictEqual(operation.binding, binding)
        ) {
          throw new HostStoreError(
            "RESIDENT_LIFECYCLE_STATE_INVALID",
            "An activating binding has no exact durable provisioning operation",
          );
        }
      } else if (record.state === "detached") {
        const operation = lifecycleById.get(record.operationId);
        const validEndingPhase =
          operation?.kind === "end" &&
          (operation.phase === "ending" ||
            operation.phase === "kill_dispatching" ||
            operation.phase === "kill_acknowledged" ||
            operation.phase === "completed" ||
            (operation.phase === "quarantined" &&
              (operation.quarantinedFrom === "ending" || operation.quarantinedFrom === "kill_dispatching")));
        const validDetachPhase = operation?.kind === "detach" && operation.phase === "detached";
        if (
          !operation ||
          !operation.binding ||
          !isDeepStrictEqual(operation.binding, binding) ||
          (record.reason === "ending" ? !validEndingPhase : !validDetachPhase)
        ) {
          throw new HostStoreError(
            "RESIDENT_LIFECYCLE_STATE_INVALID",
            "A detached binding has no exact durable revocation operation",
          );
        }
      } else if (record.operationId) {
        const operation = lifecycleById.get(record.operationId);
        const matchesProvision =
          record.state === "active" &&
          operation?.kind === "provision" &&
          (operation.phase === "committed" || operation.phase === "projection_committed") &&
          operation.binding !== undefined &&
          residentDispatchAuthorityFingerprint(operation.binding) === residentDispatchAuthorityFingerprint(binding);
        const matchesEnd =
          record.state === "completed" &&
          operation?.kind === "end" &&
          operation.phase === "completed" &&
          operation.binding !== undefined &&
          isDeepStrictEqual(operation.binding, binding);
        if (!matchesProvision && !matchesEnd) {
          throw new HostStoreError(
            "RESIDENT_LIFECYCLE_STATE_INVALID",
            "A lifecycle-linked binding record does not match its exact durable operation",
          );
        }
      }
    }

    for (const operation of lifecycleOperations) {
      const operationBinding = operation.binding;
      if (operation.kind === "provision") {
        const requiresActivating =
          operation.phase === "promoted_observed" ||
          operation.phase === "projection_committed" ||
          (operation.phase === "quarantined" &&
            (operation.quarantinedFrom === "promoted_observed" ||
              operation.quarantinedFrom === "projection_committed"));
        if (requiresActivating) {
          const activating = bindingRecords.find(
            (record) =>
              record.state === "activating" &&
              record.operationId === operation.operationId &&
              operationBinding !== undefined &&
              isDeepStrictEqual(record.binding, operationBinding),
          );
          const crashSafeActive =
            operation.phase === "quarantined" && operation.quarantinedFrom === "projection_committed"
              ? bindingRecords.find(
                  (record) =>
                    record.state === "active" &&
                    record.operationId === operation.operationId &&
                    operationBinding !== undefined &&
                    residentDispatchAuthorityFingerprint(record.binding) ===
                      residentDispatchAuthorityFingerprint(operationBinding),
                )
              : undefined;
          if (!activating && !crashSafeActive) {
            throw new HostStoreError(
              "RESIDENT_LIFECYCLE_STATE_INVALID",
              "A post-promotion lifecycle operation has no exact activating binding record",
            );
          }
        }
        if (operation.phase === "committed") {
          const active = bindingRecords.find(
            (record) =>
              record.state === "active" &&
              record.operationId === operation.operationId &&
              operationBinding !== undefined &&
              residentDispatchAuthorityFingerprint(record.binding) ===
                residentDispatchAuthorityFingerprint(operationBinding),
          );
          const legacyCompleted = bindingRecords.find(
            (record) =>
              record.state === "completed" &&
              record.operationId === undefined &&
              operationBinding !== undefined &&
              residentDispatchAuthorityFingerprint(record.binding) ===
                residentDispatchAuthorityFingerprint(operationBinding),
          );
          const successor = lifecycleOperations.find(
            (candidate) =>
              candidate.operationId !== operation.operationId &&
              (candidate.kind === "end" || candidate.kind === "detach") &&
              candidate.binding !== undefined &&
              operationBinding !== undefined &&
              Date.parse(candidate.preparedAt) >= Date.parse(operation.terminalAt ?? operation.updatedAt) &&
              residentDispatchAuthorityFingerprint(candidate.binding) ===
                residentDispatchAuthorityFingerprint(operationBinding),
          );
          if (!active && !legacyCompleted && !successor) {
            throw new HostStoreError(
              "RESIDENT_LIFECYCLE_STATE_INVALID",
              "A committed provisioning operation has no exact active binding or durable revocation successor",
            );
          }
        }
      } else if (operation.kind === "end") {
        const requiresRevoked =
          operation.phase === "ending" ||
          operation.phase === "kill_dispatching" ||
          (operation.phase === "quarantined" &&
            (operation.quarantinedFrom === "ending" || operation.quarantinedFrom === "kill_dispatching"));
        if (requiresRevoked) {
          const detached = bindingRecords.find(
            (record) =>
              record.state === "detached" &&
              record.reason === "ending" &&
              record.operationId === operation.operationId &&
              operationBinding !== undefined &&
              isDeepStrictEqual(record.binding, operationBinding),
          );
          if (!detached) {
            throw new HostStoreError(
              "RESIDENT_LIFECYCLE_STATE_INVALID",
              "A resident end operation has no exact revoked binding record",
            );
          }
        }
        if (operation.phase === "completed") {
          const completed = bindingRecords.find(
            (record) =>
              record.state === "completed" &&
              record.operationId === operation.operationId &&
              operationBinding !== undefined &&
              isDeepStrictEqual(record.binding, operationBinding),
          );
          if (!completed) {
            throw new HostStoreError(
              "RESIDENT_LIFECYCLE_STATE_INVALID",
              "A completed resident end operation has no exact completed binding record",
            );
          }
        }
      } else {
        const detached = bindingRecords.find(
          (record) =>
            record.state === "detached" &&
            record.reason === "explicit" &&
            record.operationId === operation.operationId &&
            operationBinding !== undefined &&
            isDeepStrictEqual(record.binding, operationBinding),
        );
        if (!detached) {
          throw new HostStoreError(
            "RESIDENT_LIFECYCLE_STATE_INVALID",
            "An explicit detach operation has no exact detached binding record",
          );
        }
      }
    }
  }

  private async readHostUnlocked(): Promise<HostSummary> {
    const file = await readJsonFile(this.paths.host, HostFileSchema);
    if (!file) throw new HostStoreError("HOST_STATE_MISSING", "The host state file is missing");
    return file.host;
  }

  private async readProjectsUnlocked(): Promise<SavedProject[]> {
    const file = await readJsonFile(this.paths.projects, ProjectFileSchema);
    if (!file) throw new HostStoreError("PROJECT_STATE_MISSING", "The project catalog is missing");
    return file.projects;
  }

  private async readThreadsUnlocked(): Promise<ThreadSummary[]> {
    const file = await readJsonFile(this.paths.threads, ThreadFileSchema);
    if (!file) throw new HostStoreError("THREAD_STATE_MISSING", "The thread catalog is missing");
    return file.threads;
  }

  private async readSnapshotUnlocked(threadId: string): Promise<ThreadProjectionSnapshot> {
    const snapshot = await readJsonFile(this.snapshotPath(threadId), ThreadProjectionSnapshotSchema);
    if (!snapshot) throw new HostStoreError("SNAPSHOT_NOT_FOUND", `Thread ${threadId} has no durable snapshot`);
    return snapshot;
  }

  private async readReceiptUnlocked(identity: CommandIdentity): Promise<CommandReceipt | undefined> {
    return readJsonFile(this.receiptPath(identity), CommandReceiptSchema, { optional: true });
  }

  private async appendCommandJournalUnlocked(
    command: CommandIdentity & { threadId: string; command: { kind: string } },
    status: CommandReceiptStatus,
    message?: string,
  ): Promise<void> {
    await appendJsonLine(
      this.paths.commandJournal,
      CommandJournalRecordSchema.parse({
        version: 1,
        journalId: randomId("journal"),
        recordedAt: now(),
        deviceId: command.deviceId,
        commandId: command.commandId,
        threadId: command.threadId,
        commandKind: command.command.kind,
        status,
        message,
        ...(status === "received" && CommandEnvelopeSchema.safeParse(command).success ? { envelope: command } : {}),
      }),
    );
  }

  private async appendModelSelectionJournalUnlocked(
    command: CommandEnvelope,
    status: CommandReceiptStatus,
    recordedAt: string,
    message?: string,
  ): Promise<void> {
    if (command.command.kind !== "model.select") {
      throw new HostStoreError(
        "MODEL_SELECTION_COMMAND_REQUIRED",
        "The model-selection journal accepts only exact model-selection envelopes",
      );
    }
    await appendJsonLineOnce(
      this.paths.commandJournal,
      CommandJournalRecordSchema.parse({
        version: 1,
        journalId: deterministicId(
          "journal",
          "model-selection",
          command.deviceId,
          command.commandId,
          status,
        ),
        recordedAt,
        deviceId: command.deviceId,
        commandId: command.commandId,
        threadId: command.threadId,
        commandKind: command.command.kind,
        status,
        message,
      }),
      "journalId",
    );
  }

  private async appendResidentDispatchJournalUnlocked(
    command: CommandEnvelope,
    status: CommandReceiptStatus,
    recordedAt: string,
    message: string | undefined,
    phase:
      | "dispatching"
      | "settled"
      | "idle-completed"
      | "abort-idle-completed"
      | "failed-before-start"
      | "recovered-not-started"
      | "recovered-uncertain",
  ): Promise<void> {
    if (command.command.kind !== "prompt" && command.command.kind !== "abort") {
      throw new HostStoreError(
        "RESIDENT_DISPATCH_COMMAND_REQUIRED",
        "The resident dispatch journal accepts only exact prompt and abort envelopes",
      );
    }
    await appendJsonLineOnce(
      this.paths.commandJournal,
      CommandJournalRecordSchema.parse({
        version: 1,
        journalId: deterministicId(
          "journal",
          "resident-dispatch",
          command.deviceId,
          command.commandId,
          phase,
        ),
        recordedAt,
        deviceId: command.deviceId,
        commandId: command.commandId,
        threadId: command.threadId,
        commandKind: command.command.kind,
        status,
        message,
      }),
      "journalId",
    );
  }

  private async appendResidentPromptIdleEventUnlocked(
    observationValue: ResidentPromptIdleObservedEvent,
  ): Promise<void> {
    const observation = ResidentPromptIdleObservedEventSchema.parse(observationValue);
    await appendJsonLineOnce(
      this.paths.eventJournal,
      EventJournalRecordSchema.parse({
        version: 1,
        eventId: deterministicId("event", "resident-prompt-idle", observation.attemptId),
        recordedAt: observation.observedAt,
        type: "resident.prompt_idle_observed",
        threadId: observation.command.threadId,
        sequence: observation.observedCursor.sequence,
        detail: observation.command.commandId,
        residentPromptIdleObserved: observation,
      }),
      "eventId",
    );
  }

  private async appendResidentAbortIdleEventUnlocked(
    observationValue: ResidentAbortIdleObservedEvent,
  ): Promise<void> {
    const observation = ResidentAbortIdleObservedEventSchema.parse(observationValue);
    await appendJsonLineOnce(
      this.paths.eventJournal,
      EventJournalRecordSchema.parse({
        version: 1,
        eventId: deterministicId("event", "resident-abort-idle", observation.attemptId),
        recordedAt: observation.observedAt,
        type: "resident.abort_idle_observed",
        threadId: observation.command.threadId,
        sequence: observation.observedCursor.sequence,
        detail: observation.command.commandId,
        residentAbortIdleObserved: observation,
      }),
      "eventId",
    );
  }

  private async appendEventUnlocked(event: {
    type: string;
    threadId?: string;
    sequence?: number;
    detail?: string;
  }): Promise<void> {
    await appendJsonLine(
      this.paths.eventJournal,
      EventJournalRecordSchema.parse({
        version: 1,
        eventId: randomId("event"),
        recordedAt: now(),
        ...event,
      }),
    );
  }

  private async recordFailedHandoffUnlocked(
    record: HandoffRecord,
    command: CommandIdentity,
    error: StructuredError,
    cause?: unknown,
    expectedCheckpoint?: HandoffCheckpoint,
  ): Promise<HandoffCommit> {
    const thread = (await this.readThreadsUnlocked()).find((item) => item.threadId === record.plan.threadId);
    const sourceCheckpointRetained = expectedCheckpoint
      ? await this.handoffCheckpointMatchesUnlocked(record.plan.handoffId, expectedCheckpoint)
      : false;
    const checkpointId = sourceCheckpointRetained ? `checkpoint-${record.plan.handoffId}` : undefined;
    const receipt = HandoffReceiptSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      handoffId: record.plan.handoffId,
      command,
      threadId: record.plan.threadId,
      source: record.plan.source,
      destination: record.plan.destination,
      checkpointId,
      status: "failed",
      completedAt: now(),
      continuitySummary: "Handoff did not switch authority. The source execution generation remains authoritative.",
      runtimeStateLosses: record.plan.runtimeStateLosses,
      sourceCheckpointRetained,
      error: cause instanceof Error ? { ...error, diagnosticId: randomId("diagnostic") } : error,
    });
    const progress: HandoffProgress[] = [
      ...record.progress,
      { phase: "failed", error: receipt.error ?? error, sourceRemainsAuthoritative: true },
    ];
    await atomicWriteJson(this.handoffPath(record.plan.handoffId), {
      version: 1,
      plan: record.plan,
      progress,
      receipt,
    });
    await this.writeHandoffCommandReceiptUnlocked(receipt, command, "failed", thread);
    await this.appendEventUnlocked({ type: "handoff.failed", threadId: record.plan.threadId, detail: error.code });
    return { receipt, progress, duplicate: false };
  }

  private async assertMatchingHandoffCheckpointUnlocked(
    handoffId: string,
    expected: HandoffCheckpoint,
  ): Promise<void> {
    if (await this.handoffCheckpointMatchesUnlocked(handoffId, expected)) return;
    throw new HostStoreError(
      "HANDOFF_CHECKPOINT_CONFLICT",
      "An existing source checkpoint does not exactly match this handoff plan",
    );
  }

  private async handoffCheckpointMatchesUnlocked(
    handoffId: string,
    expected: HandoffCheckpoint,
  ): Promise<boolean> {
    const canonicalExpected = Buffer.from(`${JSON.stringify(expected)}\n`, "utf8");
    try {
      const handle = await open(this.checkpointPath(handoffId), "r");
      try {
        if ((await handle.stat()).size !== canonicalExpected.byteLength) return false;
        return (await handle.readFile()).equals(canonicalExpected);
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  }

  private async ensureHandoffCommandReceiptUnlocked(
    receipt: HandoffReceipt,
    command: CommandIdentity,
  ): Promise<void> {
    const existing = await this.readReceiptUnlocked(command);
    if (existing) return;
    await this.writeHandoffCommandReceiptUnlocked(receipt, command, receipt.status === "complete" ? "completed" : "failed");
  }

  private async writeHandoffCommandReceiptUnlocked(
    handoff: HandoffReceipt,
    command: CommandIdentity,
    status: "completed" | "failed",
    thread?: ThreadSummary,
  ): Promise<void> {
    const timestamp = now();
    const receipt = CommandReceiptSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      receiptId: randomId("receipt"),
      ...command,
      threadId: handoff.threadId,
      status,
      receivedAt: timestamp,
      updatedAt: timestamp,
      executionGenerationId:
        status === "completed"
          ? handoff.destination.executionGenerationId
          : (thread?.currentLocation.executionGenerationId ?? handoff.source.executionGenerationId),
      message: status === "completed" ? `Handoff ${handoff.handoffId} completed` : handoff.error?.message,
      error: handoff.error,
    });
    await atomicWriteJson(this.receiptPath(command), receipt);
    await this.appendCommandJournalUnlocked(
      { ...command, threadId: handoff.threadId, command: { kind: "handoff.commit" } },
      status,
      receipt.message,
    );
  }

  private snapshotPath(threadId: string): string {
    return join(this.paths.snapshots, `${storageKey(threadId)}.json`);
  }

  private receiptPath(identity: CommandIdentity): string {
    return join(this.paths.receipts, `${storageKey(identity.deviceId, identity.commandId)}.json`);
  }

  private modelSelectionAttemptsDirectory(): string {
    return join(this.paths.root, "model-selection-attempts");
  }

  private modelSelectionIdentitiesDirectory(): string {
    return join(this.paths.root, "model-selection-identities");
  }

  private commandIdentitiesDirectory(): string {
    return join(this.paths.root, "command-identities");
  }

  private commandIdentityPath(identity: CommandIdentity): string {
    return join(
      this.commandIdentitiesDirectory(),
      `${storageKey(identity.deviceId, identity.commandId)}.json`,
    );
  }

  private modelSelectionIdentityPath(identity: CommandIdentity): string {
    return join(
      this.modelSelectionIdentitiesDirectory(),
      `${storageKey(identity.deviceId, identity.commandId)}.json`,
    );
  }

  private modelSelectionAttemptPath(identity: CommandIdentity): string {
    return join(
      this.modelSelectionAttemptsDirectory(),
      `${storageKey(identity.deviceId, identity.commandId)}.json`,
    );
  }

  private residentDispatchAttemptPath(identity: CommandIdentity): string {
    return join(
      this.paths.residentDispatchAttempts,
      `${storageKey(identity.deviceId, identity.commandId)}.json`,
    );
  }

  private residentProjectionLineageName(authorityId: string): string {
    return `${storageKey(authorityId)}.json`;
  }

  private residentProjectionLineagePath(authorityId: string): string {
    return join(this.paths.residentProjectionLineages, this.residentProjectionLineageName(authorityId));
  }

  private handoffPath(handoffId: string): string {
    return join(this.paths.handoffs, `${storageKey(handoffId)}.json`);
  }

  private checkpointPath(handoffId: string): string {
    return join(this.paths.checkpoints, `${storageKey(handoffId)}.json`);
  }

  private stagingPath(handoffId: string): string {
    return join(this.paths.staging, `${storageKey(handoffId)}.json`);
  }

  private admissionTransactionPath(identity: CommandIdentity): string {
    return join(this.paths.transactions, `${storageKey(identity.deviceId, identity.commandId)}.json`);
  }

  private residentProjectionTransactionPath(
    binding: Pick<ResidentSessionBinding, "threadId" | "executionGenerationId">,
  ): string {
    return join(
      this.paths.residentProjectionTransactions,
      `${storageKey(binding.threadId, binding.executionGenerationId)}.json`,
    );
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new HostStoreError("STORE_NOT_INITIALIZED", "HostStore.initialize() must run first");
  }

  private assertResidentSubsystemAvailable(): void {
    if (this.residentSubsystemFault) throw this.residentSubsystemFault;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function residentSubsystemUnavailable(cause: unknown): HostStoreError {
  return new HostStoreError(
    "RESIDENT_SUBSYSTEM_DEGRADED",
    "Resident continuity state is unavailable. Repair the retained private state and restart the host service.",
    false,
    { cause },
  );
}

function residentLifecycleOperationFingerprint(
  kind: ResidentLifecycleKind,
  inputValue: ResidentLifecycleOperationInput,
  authorityDigest: string,
): string {
  const input = ResidentLifecycleOperationInputSchema.parse(inputValue);
  const canonicalAuthorityDigest = Sha256DigestSchema.parse(authorityDigest);
  return createHash("sha256")
    .update(JSON.stringify({ kind, input, authorityDigest: canonicalAuthorityDigest }))
    .digest("hex");
}

function residentLifecycleAuthorityDigest(
  authorityValue: Omit<ResidentLifecycleAuthority, "authorityDigest"> | ResidentLifecycleAuthority,
): string {
  const authority = {
    authorityVersion: authorityValue.authorityVersion,
    hostId: authorityValue.hostId,
    projectId: authorityValue.projectId,
    workspaceId: authorityValue.workspaceId,
    threadId: authorityValue.threadId,
    executionGenerationId: authorityValue.executionGenerationId,
    workspaceDirectory: canonicalPathKey(authorityValue.workspaceDirectory),
    registeredAt: authorityValue.registeredAt,
  };
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

function residentLifecycleStatus(recordValue: ResidentLifecycleOperationRecord): ResidentLifecycleStatus {
  const record = ResidentLifecycleOperationRecordSchema.parse(recordValue);
  return Object.freeze({
    version: 1 as const,
    kind: record.kind,
    operationId: record.operationId,
    phase: record.phase,
    expectedHostId: record.input.expectedHostId,
    projectId: record.input.projectId,
    workspaceId: record.input.workspaceId,
    threadId: record.input.threadId,
    executionGenerationId: record.input.executionGenerationId,
    preparedAt: record.preparedAt,
    updatedAt: record.updatedAt,
    ...(record.quarantinedFrom ? { quarantinedFrom: record.quarantinedFrom } : {}),
    ...(record.quarantineReason ? { quarantineReason: record.quarantineReason } : {}),
    ...(record.completionReason ? { completionReason: record.completionReason } : {}),
    ...(record.terminalAt ? { terminalAt: record.terminalAt } : {}),
  });
}

function residentLifecycleOperationIsNonterminal(record: ResidentLifecycleOperationRecord): boolean {
  return record.phase !== "committed" && record.phase !== "completed" && record.phase !== "detached";
}

function residentLifecycleMutationAlreadyCrossed(
  record: ResidentLifecycleOperationRecord,
  boundary: string,
): HostStoreError {
  const reconciliationRequired =
    record.phase === "owned_create_dispatching" ||
    record.phase === "promotion_dispatching" ||
    record.phase === "kill_dispatching" ||
    record.phase === "quarantined";
  return new HostStoreError(
    reconciliationRequired
      ? "RESIDENT_LIFECYCLE_RECONCILIATION_REQUIRED"
      : "RESIDENT_LIFECYCLE_PHASE_CONFLICT",
    `The durable resident lifecycle operation cannot cross the ${boundary} boundary from its current phase`,
    !reconciliationRequired,
  );
}

function residentSessionIdentitiesOverlap(
  left: ResidentSessionBinding,
  right: ResidentSessionBinding,
): boolean {
  return left.activeSessionId === right.activeSessionId ||
    left.sessionId === right.sessionId ||
    (left.sessionFile !== undefined && right.sessionFile !== undefined && left.sessionFile === right.sessionFile);
}

function parseWorkspaceLookup(threadId: string, executionGenerationId: string): {
  threadId: string;
  executionGenerationId: string;
} {
  const parsed = WorkspaceAuthorityRegistrationSchema.pick({
    threadId: true,
    executionGenerationId: true,
  }).safeParse({ threadId, executionGenerationId });
  if (!parsed.success) {
    throw new HostStoreError(
      "WORKSPACE_AUTHORITY_INVALID",
      "Workspace authority requires bounded thread and execution generation identifiers",
    );
  }
  return parsed.data;
}

export function residentDispatchAuthorityFingerprint(bindingValue: ResidentSessionBinding): string {
  const binding = ResidentSessionBindingSchema.parse(bindingValue);
  const authority = {
    bindingVersion: binding.bindingVersion,
    lifecycle: binding.lifecycle,
    threadId: binding.threadId,
    executionGenerationId: binding.executionGenerationId,
    workspaceDirectory: canonicalPathKey(binding.workspaceDirectory),
    activeSessionId: binding.activeSessionId,
    sessionId: binding.sessionId,
    sessionFile: binding.sessionFile,
    boundAt: binding.boundAt,
    runtime: {
      releaseVersion: binding.runtime.releaseVersion,
      appVersion: binding.runtime.appVersion,
      protocolName: binding.runtime.protocolName,
      protocolVersion: binding.runtime.protocolVersion,
      schemaRevision: binding.runtime.schemaRevision,
      schemaId: binding.runtime.schemaId,
      runtimeBuildId: binding.runtime.runtimeBuildId,
      capabilities: [...binding.runtime.capabilities].sort(),
    },
  };
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

function residentProjectionAuthorityFromBinding(
  bindingValue: ResidentSessionBinding,
): ResidentProjectionAuthority {
  const binding = ResidentSessionBindingSchema.parse(bindingValue);
  return ResidentProjectionAuthoritySchema.parse({
    threadId: binding.threadId,
    executionGenerationId: binding.executionGenerationId,
    workspaceDirectory: binding.workspaceDirectory,
    activeSessionId: binding.activeSessionId,
    sessionId: binding.sessionId,
    sessionFile: binding.sessionFile,
  });
}

function residentProjectionAuthorityId(authorityValue: ResidentProjectionAuthority): string {
  const authority = ResidentProjectionAuthoritySchema.parse(authorityValue);
  return deterministicId(
    "resident-authority",
    authority.threadId,
    authority.executionGenerationId,
    canonicalPathKey(authority.workspaceDirectory),
    authority.activeSessionId,
    authority.sessionId,
    authority.sessionFile ?? "",
  );
}

function residentProjectionDigest(projection: ResidentProjectionSnapshot): string {
  const semantic = {
    cursor: projection.cursor,
    runtime: projection.runtime,
    transcript: projection.transcript,
    stream: projection.stream,
    childAgents: projection.childAgents,
    goal: projection.goal,
    activity: residentPrivateProjectionReportsActivity(projection),
  };
  return digestNormalizedJson(semantic);
}

function residentPublishedProjectionDigest(snapshot: ThreadProjectionSnapshot): string {
  return digestNormalizedJson({
    cursor: {
      generation: snapshot.latestCursor.generation,
      sequence: snapshot.latestCursor.sequence,
    },
    runtime: snapshot.runtime,
    transcript: snapshot.materializedRecentBlocks,
    stream: snapshot.inProgressStream,
    childAgents: snapshot.childAgents,
    goal: snapshot.goals[0],
    activity: snapshot.thread.status === "running",
  });
}

function digestNormalizedJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError("Projection is not JSON serializable");
    const normalized = sortJsonValue(JSON.parse(json) as unknown);
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  } catch (cause) {
    throw new HostStoreError(
      "RESIDENT_PROJECTION_DIGEST_INVALID",
      "Resident projection could not be normalized for durable lineage",
      false,
      { cause },
    );
  }
}

function residentProjectionLineageTransitionIsValid(
  previous: ResidentProjectionCursorLineage | undefined,
  next: ResidentProjectionCursorLineage,
  allowSameCursorAbortIdleRewrite = false,
): boolean {
  if (!previous) return next.retiredGenerations.length === 0;
  if (
    previous.authorityId !== next.authorityId ||
    !isDeepStrictEqual(previous.authority, next.authority)
  ) {
    return false;
  }
  if (previous.current.generation === next.current.generation) {
    return (
      (next.current.sequence > previous.current.sequence ||
        (allowSameCursorAbortIdleRewrite &&
          next.current.sequence === previous.current.sequence &&
          next.current.digest !== previous.current.digest)) &&
      isDeepStrictEqual(next.retiredGenerations, previous.retiredGenerations)
    );
  }
  return (
    !previous.retiredGenerations.includes(next.current.generation) &&
    previous.retiredGenerations.length < MAX_RETIRED_RESIDENT_CURSOR_GENERATIONS &&
    isDeepStrictEqual(next.retiredGenerations, [
      ...previous.retiredGenerations,
      previous.current.generation,
    ])
  );
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function createResidentDispatchLease(attempt: ResidentDispatchAttempt): ResidentDispatchLease {
  if (attempt.state !== "dispatching" || !attempt.dispatchStartedAt) {
    throw new HostStoreError(
      "RESIDENT_DISPATCH_LEASE_INVALID",
      "Only a durable dispatching attempt can create a resident dispatch lease",
    );
  }
  const command = CommandEnvelopeSchema.parse(attempt.command);
  const immutableCommand = Object.freeze({
    ...command,
    command: Object.freeze({ ...command.command }),
  }) as CommandEnvelope;
  const binding = validateResidentSessionBinding(attempt.binding);
  return Object.freeze({
    [residentDispatchLeaseBrand]: true as const,
    leaseVersion: 1 as const,
    attemptId: attempt.attemptId,
    command: immutableCommand,
    binding,
    bindingFingerprint: attempt.bindingFingerprint,
    dispatchStartedAt: attempt.dispatchStartedAt,
  });
}

/** Runtime proof that a lease came from this process's private HostStore brand. */
export function validateResidentDispatchLease(value: ResidentDispatchLease): ResidentDispatchLease {
  if (
    !value ||
    typeof value !== "object" ||
    value[residentDispatchLeaseBrand] !== true ||
    value.leaseVersion !== 1 ||
    !Object.isFrozen(value) ||
    !Object.isFrozen(value.command) ||
    !Object.isFrozen(value.command.command) ||
    !Object.isFrozen(value.binding) ||
    !Object.isFrozen(value.binding.runtime) ||
    !Object.isFrozen(value.binding.runtime.capabilities)
  ) {
    throw new HostStoreError(
      "RESIDENT_DISPATCH_LEASE_INVALID",
      "Resident dispatch finalization requires an opaque lease from this HostStore process",
    );
  }
  let command: CommandEnvelope;
  let binding: ResidentSessionBinding;
  try {
    command = ResidentDispatchCommandSchema.parse(value.command);
    binding = validateResidentSessionBinding(value.binding);
    IsoDateTimeSchema.parse(value.dispatchStartedAt);
    IdSchema.parse(value.attemptId);
  } catch (cause) {
    throw new HostStoreError(
      "RESIDENT_DISPATCH_LEASE_INVALID",
      "Resident dispatch lease fields are invalid",
      false,
      { cause },
    );
  }
  const fingerprint = residentDispatchAuthorityFingerprint(binding);
  if (
    value.attemptId !== deterministicId("resident-dispatch", command.deviceId, command.commandId) ||
    value.bindingFingerprint !== fingerprint ||
    command.threadId !== binding.threadId ||
    command.expectedExecutionGenerationId !== binding.executionGenerationId
  ) {
    throw new HostStoreError(
      "RESIDENT_DISPATCH_LEASE_INVALID",
      "Resident dispatch lease no longer identifies one exact command and binding",
    );
  }
  return value;
}

function residentDispatchLeaseMatchesAttempt(
  lease: ResidentDispatchLease,
  attempt: ResidentDispatchAttempt,
): boolean {
  return (
    attempt.state === "dispatching" &&
    attempt.dispatchStartedAt === lease.dispatchStartedAt &&
    attempt.attemptId === lease.attemptId &&
    attempt.bindingFingerprint === lease.bindingFingerprint &&
    isDeepStrictEqual(attempt.command, lease.command) &&
    isDeepStrictEqual(attempt.binding, lease.binding)
  );
}

function createResidentPromptReconciliationLease(
  attempt: ResidentDispatchAttempt,
  bindingValue: ResidentSessionBinding,
): ResidentPromptReconciliationLease {
  if (
    !residentAcknowledgedPromptAttemptRetainsLock(attempt) ||
    !attempt.dispatchStartedAt ||
    !attempt.settledAt ||
    !attempt.finalReceipt ||
    !attempt.promptSettlementCursor
  ) {
    throw new HostStoreError(
      "RESIDENT_PROMPT_RECONCILIATION_INELIGIBLE",
      "Only a durable acknowledged-running prompt can create a reconciliation lease",
    );
  }
  const command = ResidentPromptCommandSchema.parse(attempt.command);
  const immutableCommand = Object.freeze({
    ...command,
    command: Object.freeze({ ...command.command }),
  }) as CommandEnvelope;
  const binding = validateResidentSessionBinding(bindingValue);
  const settlementCursor = Object.freeze(SessionCursorSchema.parse(attempt.promptSettlementCursor));
  return Object.freeze({
    [residentPromptReconciliationLeaseBrand]: true as const,
    leaseVersion: 1 as const,
    attemptId: attempt.attemptId,
    command: immutableCommand,
    binding,
    bindingFingerprint: residentDispatchAuthorityFingerprint(binding),
    dispatchStartedAt: attempt.dispatchStartedAt,
    settledAt: attempt.settledAt,
    receiptUpdatedAt: attempt.finalReceipt.updatedAt,
    settlementCursor,
  });
}

/** Runtime proof that this is a privately branded, immutable prompt lease. */
export function validateResidentPromptReconciliationLease(
  value: ResidentPromptReconciliationLease,
): ResidentPromptReconciliationLease {
  if (
    !value ||
    typeof value !== "object" ||
    value[residentPromptReconciliationLeaseBrand] !== true ||
    value.leaseVersion !== 1 ||
    !Object.isFrozen(value) ||
    !Object.isFrozen(value.command) ||
    !Object.isFrozen(value.command.command) ||
    !Object.isFrozen(value.binding) ||
    !Object.isFrozen(value.binding.runtime) ||
    !Object.isFrozen(value.binding.runtime.capabilities) ||
    !Object.isFrozen(value.settlementCursor)
  ) {
    throw new HostStoreError(
      "RESIDENT_PROMPT_RECONCILIATION_LEASE_INVALID",
      "Prompt idle reconciliation requires an opaque immutable HostStore lease",
    );
  }
  let command: CommandEnvelope;
  let binding: ResidentSessionBinding;
  let settlementCursor: z.infer<typeof SessionCursorSchema>;
  try {
    command = ResidentPromptCommandSchema.parse(value.command);
    binding = validateResidentSessionBinding(value.binding);
    settlementCursor = SessionCursorSchema.parse(value.settlementCursor);
    IdSchema.parse(value.attemptId);
    IsoDateTimeSchema.parse(value.dispatchStartedAt);
    IsoDateTimeSchema.parse(value.settledAt);
    IsoDateTimeSchema.parse(value.receiptUpdatedAt);
  } catch (cause) {
    throw new HostStoreError(
      "RESIDENT_PROMPT_RECONCILIATION_LEASE_INVALID",
      "Prompt idle reconciliation lease fields are invalid",
      false,
      { cause },
    );
  }
  if (
    value.attemptId !== deterministicId("resident-dispatch", command.deviceId, command.commandId) ||
    value.bindingFingerprint !== residentDispatchAuthorityFingerprint(binding) ||
    command.threadId !== binding.threadId ||
    command.expectedExecutionGenerationId !== binding.executionGenerationId ||
    settlementCursor.threadId !== command.threadId ||
    settlementCursor.executionGenerationId !== command.expectedExecutionGenerationId ||
    Date.parse(value.dispatchStartedAt) > Date.parse(value.settledAt) ||
    Date.parse(value.settledAt) > Date.parse(value.receiptUpdatedAt)
  ) {
    throw new HostStoreError(
      "RESIDENT_PROMPT_RECONCILIATION_LEASE_INVALID",
      "Prompt idle reconciliation lease no longer identifies one exact acknowledged command and authority",
    );
  }
  return value;
}

function residentPromptReconciliationLeaseMatchesAttempt(
  lease: ResidentPromptReconciliationLease,
  attempt: ResidentDispatchAttempt,
): boolean {
  return (
    residentAcknowledgedPromptAttemptRetainsLock(attempt) &&
    attempt.dispatchStartedAt === lease.dispatchStartedAt &&
    attempt.settledAt === lease.settledAt &&
    attempt.finalReceipt?.updatedAt === lease.receiptUpdatedAt &&
    attempt.attemptId === lease.attemptId &&
    attempt.bindingFingerprint === lease.bindingFingerprint &&
    isDeepStrictEqual(attempt.command, lease.command) &&
    isDeepStrictEqual(attempt.promptSettlementCursor, lease.settlementCursor) &&
    isDeepStrictEqual(
      residentProjectionAuthorityFromBinding(attempt.binding),
      residentProjectionAuthorityFromBinding(lease.binding),
    )
  );
}

function createResidentAbortReconciliationLease(
  attempt: ResidentDispatchAttempt,
  bindingValue: ResidentSessionBinding,
): ResidentAbortReconciliationLease {
  if (
    !residentAcknowledgedAbortAttemptRetainsLock(attempt) ||
    !attempt.dispatchStartedAt ||
    !attempt.settledAt ||
    !attempt.finalReceipt ||
    !attempt.abortSettlementCursor
  ) {
    throw new HostStoreError(
      "RESIDENT_ABORT_RECONCILIATION_INELIGIBLE",
      "Only a durable acknowledged-running Stop can create a reconciliation lease",
    );
  }
  const command = ResidentAbortCommandSchema.parse(attempt.command);
  const immutableCommand = Object.freeze({
    ...command,
    command: Object.freeze({ ...command.command }),
  }) as CommandEnvelope;
  const binding = validateResidentSessionBinding(bindingValue);
  const settlementCursor = Object.freeze(SessionCursorSchema.parse(attempt.abortSettlementCursor));
  return Object.freeze({
    [residentAbortReconciliationLeaseBrand]: true as const,
    leaseVersion: 1 as const,
    attemptId: attempt.attemptId,
    command: immutableCommand,
    binding,
    bindingFingerprint: residentDispatchAuthorityFingerprint(binding),
    dispatchStartedAt: attempt.dispatchStartedAt,
    settledAt: attempt.settledAt,
    receiptUpdatedAt: attempt.finalReceipt.updatedAt,
    settlementCursor,
  });
}

/** Runtime proof that this is a privately branded, immutable Stop lease. */
export function validateResidentAbortReconciliationLease(
  value: ResidentAbortReconciliationLease,
): ResidentAbortReconciliationLease {
  if (
    !value ||
    typeof value !== "object" ||
    value[residentAbortReconciliationLeaseBrand] !== true ||
    value.leaseVersion !== 1 ||
    !Object.isFrozen(value) ||
    !Object.isFrozen(value.command) ||
    !Object.isFrozen(value.command.command) ||
    !Object.isFrozen(value.binding) ||
    !Object.isFrozen(value.binding.runtime) ||
    !Object.isFrozen(value.binding.runtime.capabilities) ||
    !Object.isFrozen(value.settlementCursor)
  ) {
    throw new HostStoreError(
      "RESIDENT_ABORT_RECONCILIATION_LEASE_INVALID",
      "Stop idle reconciliation requires an opaque immutable HostStore lease",
    );
  }
  let command: CommandEnvelope;
  let binding: ResidentSessionBinding;
  let settlementCursor: z.infer<typeof SessionCursorSchema>;
  try {
    command = ResidentAbortCommandSchema.parse(value.command);
    binding = validateResidentSessionBinding(value.binding);
    settlementCursor = SessionCursorSchema.parse(value.settlementCursor);
    IdSchema.parse(value.attemptId);
    IsoDateTimeSchema.parse(value.dispatchStartedAt);
    IsoDateTimeSchema.parse(value.settledAt);
    IsoDateTimeSchema.parse(value.receiptUpdatedAt);
  } catch (cause) {
    throw new HostStoreError(
      "RESIDENT_ABORT_RECONCILIATION_LEASE_INVALID",
      "Stop idle reconciliation lease fields are invalid",
      false,
      { cause },
    );
  }
  if (
    value.attemptId !== deterministicId("resident-dispatch", command.deviceId, command.commandId) ||
    value.bindingFingerprint !== residentDispatchAuthorityFingerprint(binding) ||
    command.threadId !== binding.threadId ||
    command.expectedExecutionGenerationId !== binding.executionGenerationId ||
    settlementCursor.threadId !== command.threadId ||
    settlementCursor.executionGenerationId !== command.expectedExecutionGenerationId ||
    Date.parse(value.dispatchStartedAt) > Date.parse(value.settledAt) ||
    Date.parse(value.settledAt) > Date.parse(value.receiptUpdatedAt)
  ) {
    throw new HostStoreError(
      "RESIDENT_ABORT_RECONCILIATION_LEASE_INVALID",
      "Stop idle reconciliation lease no longer identifies one exact acknowledged command and authority",
    );
  }
  return value;
}

function residentAbortReconciliationLeaseMatchesAttempt(
  lease: ResidentAbortReconciliationLease,
  attempt: ResidentDispatchAttempt,
): boolean {
  return (
    residentAcknowledgedAbortAttemptRetainsLock(attempt) &&
    attempt.dispatchStartedAt === lease.dispatchStartedAt &&
    attempt.settledAt === lease.settledAt &&
    attempt.finalReceipt?.updatedAt === lease.receiptUpdatedAt &&
    attempt.attemptId === lease.attemptId &&
    attempt.bindingFingerprint === lease.bindingFingerprint &&
    isDeepStrictEqual(attempt.command, lease.command) &&
    isDeepStrictEqual(attempt.abortSettlementCursor, lease.settlementCursor) &&
    isDeepStrictEqual(
      residentProjectionAuthorityFromBinding(attempt.binding),
      residentProjectionAuthorityFromBinding(lease.binding),
    )
  );
}

function residentDispatchAttemptRetainsReconciliation(attempt: ResidentDispatchAttempt): boolean {
  return residentPromptAttemptRetainsLock(attempt) || residentAbortAttemptRetainsBarrier(attempt);
}

function residentPromptAttemptRetainsLock(attempt: ResidentDispatchAttempt): boolean {
  return (
    attempt.command.command.kind === "prompt" &&
    attempt.state === "settled" &&
    (attempt.finalReceipt?.status === "running" || attempt.finalReceipt?.status === "uncertain")
  );
}

function residentAcknowledgedPromptAttemptRetainsLock(attempt: ResidentDispatchAttempt): boolean {
  return (
    attempt.command.command.kind === "prompt" &&
    attempt.state === "settled" &&
    attempt.finalReceipt?.status === "running"
  );
}

function residentAcknowledgedAbortAttemptRetainsLock(attempt: ResidentDispatchAttempt): boolean {
  return (
    attempt.command.command.kind === "abort" &&
    attempt.state === "settled" &&
    attempt.finalReceipt?.status === "running"
  );
}

function residentAbortAttemptRetainsBarrier(attempt: ResidentDispatchAttempt): boolean {
  return (
    attempt.command.command.kind === "abort" &&
    attempt.state === "settled" &&
    (attempt.finalReceipt?.status === "running" || attempt.finalReceipt?.status === "uncertain")
  );
}

function residentPrivateProjectionReportsActivity(projection: ResidentProjectionSnapshot): boolean {
  return Boolean(
    projection.runtime.isStreaming ||
      projection.runtime.isCompacting ||
      projection.runtime.isBashRunning ||
      projection.queue.active !== undefined ||
      projection.queue.queuedCount > 0
  );
}

function residentSnapshotReportsActivity(snapshot: ThreadProjectionSnapshot): boolean {
  const runtime = snapshot.runtime;
  return Boolean(
    runtime &&
      runtime.residency === "resident" &&
      (snapshot.thread.status === "running" ||
        runtime.isStreaming ||
        runtime.isCompacting ||
        runtime.isBashRunning ||
        runtime.queuedActionCount > 0),
  );
}

function parseWorkspaceRegistration(value: WorkspaceAuthorityRegistration): WorkspaceAuthorityRegistration {
  const parsed = WorkspaceAuthorityRegistrationSchema.safeParse(value);
  if (!parsed.success) {
    throw new HostStoreError(
      "WORKSPACE_AUTHORITY_INVALID",
      "Workspace authority requires bounded identifiers and an absolute workspace path",
    );
  }
  return parsed.data;
}

async function canonicalWorkspaceDirectory(value: string): Promise<string> {
  const parsed = WorkspaceDirectorySchema.safeParse(value);
  if (!parsed.success) {
    throw new HostStoreError(
      "WORKSPACE_PATH_INVALID",
      "The workspace directory must be a bounded absolute path without control characters",
    );
  }
  let canonical: string;
  try {
    canonical = await realpath(parsed.data);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) {
      throw new HostStoreError("WORKSPACE_PATH_INVALID", "The workspace path must identify a directory");
    }
  } catch (error) {
    if (error instanceof HostStoreError) throw error;
    throw new HostStoreError(
      "WORKSPACE_PATH_UNAVAILABLE",
      "The workspace directory could not be resolved to an existing physical directory",
      true,
      { cause: error },
    );
  }
  const validated = WorkspaceDirectorySchema.safeParse(canonical);
  if (!validated.success) {
    throw new HostStoreError("WORKSPACE_PATH_INVALID", "The canonical workspace directory is not a safe path");
  }
  return validated.data;
}

function canonicalPathKey(value: string): string {
  const normalized = resolvePath(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function sameCanonicalPath(left: string, right: string): boolean {
  return canonicalPathKey(left) === canonicalPathKey(right);
}

function workspaceAuthorityMatchesScope(
  authority: WorkspaceAuthority,
  scope: CurrentWorkspaceScope,
): boolean {
  return (
    authority.hostId === scope.hostId &&
    authority.projectId === scope.projectId &&
    authority.workspaceId === scope.workspaceId &&
    authority.threadId === scope.threadId &&
    authority.executionGenerationId === scope.executionGenerationId
  );
}

function sameResidentBindingIdentity(
  current: ResidentSessionBinding,
  candidate: ResidentSessionBinding,
): boolean {
  return (
    current.bindingVersion === candidate.bindingVersion &&
    current.lifecycle === candidate.lifecycle &&
    current.threadId === candidate.threadId &&
    current.executionGenerationId === candidate.executionGenerationId &&
    sameCanonicalPath(current.workspaceDirectory, candidate.workspaceDirectory) &&
    current.activeSessionId === candidate.activeSessionId &&
    current.sessionId === candidate.sessionId &&
    current.sessionFile === candidate.sessionFile &&
    current.boundAt === candidate.boundAt
  );
}

function applyCommand(
  snapshot: ThreadProjectionSnapshot,
  envelope: CommandEnvelope,
  canDispatchLive: boolean,
): ThreadProjectionSnapshot {
  const timestamp = now();
  const queue = [...snapshot.queueState.pendingCommandIds];
  let taskStatus = snapshot.thread.status;
  let recap = snapshot.thread.recap;
  let approvals = [...snapshot.approvals];

  switch (envelope.command.kind) {
    case "prompt":
    case "follow_up":
    case "steer":
      queue.push(envelope.commandId);
      taskStatus = canDispatchLive && envelope.command.kind !== "follow_up" ? "running" : "waiting";
      recap = canDispatchLive ? "Command admitted to Prime Agent." : "Command queued durably; Prime Agent is not attached.";
      break;
    case "abort":
      recap = "Waiting for Prime Agent to acknowledge the stop request.";
      break;
    case "model.select":
      // Selection becomes visible only through a fresh authoritative resident
      // projection after Prime Agent has applied and verified the mutation.
      break;
    case "approval.resolve": {
      const approvalCommand = envelope.command;
      const approvalIndex = approvals.findIndex((approval) => approval.approvalId === approvalCommand.approvalId);
      if (approvalIndex >= 0) {
        const approval = approvals[approvalIndex];
        if (approval) approvals[approvalIndex] = { ...approval, state: approvalCommand.decision === "approve" ? "approved" : "rejected" };
      }
      taskStatus = "running";
      recap = `Approval ${approvalCommand.decision === "approve" ? "granted" : "rejected"}.`;
      break;
    }
  }

  const thread: ThreadSummary = {
    ...snapshot.thread,
    status: taskStatus,
    recap,
    updatedAt: timestamp,
  };

  return ThreadProjectionSnapshotSchema.parse({
    ...snapshot,
    generatedAt: timestamp,
    thread,
    queueState: { ...snapshot.queueState, pendingCommandIds: queue },
    approvals,
  });
}

function validateCommandAgainstState(
  envelope: CommandEnvelope,
  snapshot: ThreadProjectionSnapshot,
  canDispatchLive: boolean,
): StructuredError | undefined {
  if (snapshot.queueState.paused) {
    return structured("THREAD_MUTATIONS_PAUSED", "Thread mutations are paused for a checkpoint", true);
  }
  if (envelope.command.kind === "steer" && (!canDispatchLive || snapshot.thread.status !== "running")) {
    return structured("LIVE_CONNECTION_REQUIRED", "Steering requires a live running Prime Agent session", true);
  }
  if (envelope.command.kind === "abort" && !canDispatchLive) {
    return structured("LIVE_CONNECTION_REQUIRED", "Stopping requires a live Prime Agent session", true);
  }
  if (envelope.command.kind === "model.select" && !canDispatchLive) {
    return structured("LIVE_CONNECTION_REQUIRED", "Model selection requires a live resident Prime Agent session", true);
  }
  if (envelope.command.kind === "approval.resolve") {
    const approvalCommand = envelope.command;
    if (!canDispatchLive) {
      return structured("LIVE_CONNECTION_REQUIRED", "Approval resolution requires a live Prime Agent session", true);
    }
    const approval = snapshot.approvals.find((item) => item.approvalId === approvalCommand.approvalId);
    if (!approval) return structured("APPROVAL_NOT_FOUND", "The approval request no longer exists");
    if (approval.state === "approved" || approval.state === "rejected" || approval.state === "expired") {
      return structured("APPROVAL_ALREADY_RESOLVED", "The approval request is already resolved");
    }
  }
  return undefined;
}

function createDestinationSnapshot(
  source: ThreadProjectionSnapshot,
  plan: HandoffPlan,
): ThreadProjectionSnapshot {
  const timestamp = now();
  const cursor = {
    threadId: source.thread.threadId,
    executionGenerationId: plan.destination.executionGenerationId,
    generation: randomId("generation"),
    sequence: 0,
  };
  const thread: ThreadSummary = {
    ...source.thread,
    currentLocation: plan.destination,
    status: "idle",
    recap: `Moved to host ${plan.destination.hostId}. Runtime-local process state restarted.`,
    updatedAt: timestamp,
    lastKnownCursor: cursor,
  };
  return ThreadProjectionSnapshotSchema.parse({
    ...source,
    generatedAt: timestamp,
    thread,
    inProgressStream: undefined,
    queueState: { pendingCommandIds: [], paused: false },
    latestCursor: cursor,
  });
}

function repositoriesMatch(source?: SavedProject, destination?: SavedProject): boolean {
  if (!source?.repositoryIdentity || !destination?.repositoryIdentity) return false;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\.git$/, "").replace(/\/$/, "");
  const sourceRemotes = new Set(source.repositoryIdentity.canonicalRemotes.map(normalize));
  const matchingRemote = destination.repositoryIdentity.canonicalRemotes.some((remote) => sourceRemotes.has(normalize(remote)));
  const matchingSubdirectory =
    (source.relativeSubdirectory ?? source.repositoryIdentity.subdirectory ?? "") ===
    (destination.relativeSubdirectory ?? destination.repositoryIdentity.subdirectory ?? "");
  return matchingRemote && matchingSubdirectory;
}

function createLocalHostSummary(): HostSummary {
  const timestamp = now();
  const platform = nodePlatform();
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : "unknown";
  return HostSummarySchema.parse({
    hostId: randomId("host"),
    displayName: hostname() || "This computer",
    kind: "local",
    connectionPaths: [{ kind: "local_socket", priority: 0, state: "available" }],
    reachability: "online",
    compatibility: "compatible",
    platform: { os, architecture: arch(), release: release(), hostname: hostname() || undefined },
    resources: { totalMemoryBytes: totalmem(), availableMemoryBytes: freemem() },
    attentionCounts: { total: 0, unread: 0, questions: 0, approvals: 0 },
    lastSeenAt: timestamp,
  });
}

function structured(code: string, message: string, retryable = false): StructuredError {
  return { code, message, retryable };
}

function createCommandJournalRecord(
  transactionId: string,
  ordinal: number,
  command: CommandEnvelope,
  status: CommandReceiptStatus,
  message: string | undefined,
  recordedAt: string,
  includeEnvelope: boolean,
): z.infer<typeof CommandJournalRecordSchema> {
  return CommandJournalRecordSchema.parse({
    version: 1,
    journalId: deterministicId("journal", transactionId, String(ordinal), status),
    recordedAt,
    deviceId: command.deviceId,
    commandId: command.commandId,
    threadId: command.threadId,
    commandKind: command.command.kind,
    status,
    message,
    ...(includeEnvelope ? { envelope: command } : {}),
  });
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 48)}`;
}

function storageKey(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function randomId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}
