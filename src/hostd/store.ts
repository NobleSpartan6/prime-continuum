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
  SNAPSHOT_VERSION,
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

const ResidentSessionBindingRecordSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("active"),
      binding: ResidentSessionBindingSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("completed"),
      binding: ResidentSessionBindingSchema,
      completedAt: IsoDateTimeSchema,
    })
    .strict()
    .refine((record) => Date.parse(record.completedAt) >= Date.parse(record.binding.boundAt), {
      path: ["completedAt"],
      message: "Completion cannot precede the resident binding",
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
      if (record.state === "active") {
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
  envelope: CommandEnvelopeSchema.optional(),
});

const EventJournalRecordSchema = z.object({
  version: z.literal(1),
  eventId: IdSchema,
  recordedAt: IsoDateTimeSchema,
  type: z.string().min(1).max(64),
  threadId: IdSchema.optional(),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  detail: z.string().max(1_024).optional(),
});

const AdmissionTransactionSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("command_admission"),
    transactionId: IdSchema,
    preparedAt: IsoDateTimeSchema,
    command: CommandEnvelopeSchema,
    receipt: CommandReceiptSchema,
    snapshot: ThreadProjectionSnapshotSchema.optional(),
    threadsFile: ThreadFileSchema.optional(),
    journalRecords: z.array(CommandJournalRecordSchema).min(2).max(3),
    eventRecord: EventJournalRecordSchema.optional(),
  })
  .superRefine((transaction, context) => {
    if ((transaction.snapshot === undefined) !== (transaction.threadsFile === undefined)) {
      context.addIssue({ code: "custom", message: "Admission snapshot and thread catalog must materialize together" });
    }
    if (transaction.receipt.deviceId !== transaction.command.deviceId || transaction.receipt.commandId !== transaction.command.commandId) {
      context.addIssue({ code: "custom", message: "Admission receipt identity does not match its command" });
    }
    if (transaction.snapshot && transaction.snapshot.thread.threadId !== transaction.command.threadId) {
      context.addIssue({ code: "custom", message: "Admission snapshot thread does not match its command" });
    }
  });
type AdmissionTransaction = z.infer<typeof AdmissionTransactionSchema>;

export const MAX_PENDING_ADMISSION_TRANSACTIONS = 1_024;
export const MAX_ADMISSION_TRANSACTION_BYTES = 64 * 1024 * 1024;

const ResidentProjectionTransactionSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("resident_projection_publication"),
    transactionId: IdSchema,
    preparedAt: IsoDateTimeSchema,
    binding: ResidentSessionBindingSchema,
    snapshot: ThreadProjectionSnapshotSchema,
    threadsFile: ThreadFileSchema,
  })
  .strict()
  .superRefine((transaction, context) => {
    const { binding, snapshot, threadsFile } = transaction;
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
  | "after_receipt"
  | "after_journal"
  | "after_event";

export type ResidentProjectionFaultPoint = "after_prepare" | "after_snapshot" | "after_threads";

export type HandoffCheckpointWriter = (path: string, checkpoint: HandoffCheckpoint) => Promise<boolean>;

export interface HostStoreOptions {
  admissionFaultInjector?: (point: AdmissionFaultPoint, transactionId: string) => void | Promise<void>;
  residentProjectionFaultInjector?: (
    point: ResidentProjectionFaultPoint,
    transactionId: string,
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
        try {
          await this.validateResidentStateUnlocked();
        } catch (error) {
          this.residentSubsystemFault = residentSubsystemUnavailable(error);
        }
      }

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

  async persistResidentSessionBinding(bindingValue: ResidentSessionBinding): Promise<void> {
    await this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const binding = validateResidentSessionBinding(bindingValue);
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
      const activeRecord = ResidentSessionBindingRecordSchema.parse({ state: "active", binding });
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
  ): Promise<ThreadProjectionSnapshot> {
    return this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const binding = validateResidentSessionBinding(bindingValue);
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
      if (!active) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_BINDING_NOT_FOUND",
          "No active resident binding exists for this projection",
        );
      }
      if (!isDeepStrictEqual(active.binding, binding)) {
        throw new HostStoreError(
          "RESIDENT_PROJECTION_BINDING_MISMATCH",
          "Only the exact active resident binding may publish a projection",
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
      const generatedAt = now();
      const latestCursor = {
        threadId: binding.threadId,
        executionGenerationId: binding.executionGenerationId,
        generation: projection.cursor.generation,
        sequence: projection.cursor.sequence,
      };
      const threadValue: ThreadSummary = {
        ...source.thread,
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
        queueState: source.queueState,
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
      const transaction = ResidentProjectionTransactionSchema.parse({
        version: 1,
        kind: "resident_projection_publication",
        transactionId: deterministicId(
          "resident-projection",
          binding.threadId,
          binding.executionGenerationId,
          projection.cursor.generation,
          String(projection.cursor.sequence),
        ),
        preparedAt: generatedAt,
        binding,
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
    });
  }

  async completeResidentSessionBinding(bindingValue: ResidentSessionBinding): Promise<void> {
    await this.exclusive(async () => {
      this.assertInitialized();
      this.assertResidentSubsystemAvailable();
      const binding = validateResidentSessionBinding(bindingValue);
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
      records[existingIndex] = ResidentSessionBindingRecordSchema.parse({
        state: "completed",
        binding: existing.binding,
        completedAt: now(),
      });
      await this.writeResidentSessionBindingRecordsUnlocked(records);
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
      if (existing) return { receipt: existing, duplicate: true };
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
    identity: CommandIdentity,
    update: Pick<CommandReceipt, "status"> & Partial<Pick<CommandReceipt, "message" | "error" | "queuePosition">>,
  ): Promise<CommandReceipt> {
    return this.exclusive(async () => {
      this.assertInitialized();
      const current = await this.readReceiptUnlocked(identity);
      if (!current) throw new HostStoreError("COMMAND_NOT_FOUND", "No receipt exists for this command identity");
      const receipt = CommandReceiptSchema.parse({
        ...current,
        ...update,
        updatedAt: now(),
      });
      await atomicWriteJson(this.receiptPath(identity), receipt);
      await this.appendCommandJournalUnlocked(
        {
          ...identity,
          threadId: current.threadId,
          command: { kind: "gateway" },
        },
        receipt.status,
        receipt.message,
      );
      return receipt;
    });
  }

  async reconcileCommands(identities: CommandIdentity[]): Promise<{
    receipts: CommandReceipt[];
    unknown: CommandIdentity[];
  }> {
    if (identities.length > 256) throw new HostStoreError("RECONCILE_LIMIT", "At most 256 commands may be reconciled");
    return this.exclusive(async () => {
      this.assertInitialized();
      const receipts: CommandReceipt[] = [];
      const unknown: CommandIdentity[] = [];
      for (const identity of identities) {
        const receipt = await this.readReceiptUnlocked(identity);
        if (receipt) receipts.push(receipt);
        else unknown.push(identity);
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
    if (!active) {
      throw new HostStoreError(
        "RESIDENT_PROJECTION_BINDING_NOT_FOUND",
        "A pending resident projection has no active resident binding",
      );
    }
    if (!isDeepStrictEqual(active.binding, binding)) {
      throw new HostStoreError(
        "RESIDENT_PROJECTION_BINDING_MISMATCH",
        "A pending resident projection no longer belongs to the exact active binding",
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

    await atomicWriteJson(this.snapshotPath(binding.threadId), transaction.snapshot);
    if (injectFaults) {
      await this.injectResidentProjectionFault("after_snapshot", transaction.transactionId);
    }
    await atomicWriteJson(this.paths.threads, transaction.threadsFile);
    if (injectFaults) {
      await this.injectResidentProjectionFault("after_threads", transaction.transactionId);
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
      const expectedTransactionId = deterministicId(
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

    if (!thread) {
      rejection = structured("THREAD_NOT_FOUND", `Thread ${command.threadId} does not exist`);
    } else if (
      command.expectedExecutionGenerationId &&
      command.expectedExecutionGenerationId !== thread.currentLocation.executionGenerationId
    ) {
      rejection = structured(
        "STALE_EXECUTION_GENERATION",
        "The command targets a previous execution generation; refresh the thread before retrying",
      );
    } else {
      sourceSnapshot = await this.readSnapshotUnlocked(command.threadId);
      rejection = dispatcherUnavailable ?? validateCommandAgainstState(command, sourceSnapshot, canDispatchLive);
      if (
        !rejection &&
        command.command.kind !== "abort" &&
        sourceSnapshot.queueState.pendingCommandIds.length >= 1_000
      ) {
        rejection = structured("COMMAND_QUEUE_FULL", "The host command queue has reached its bounded limit", true);
      }
    }

    const initialStatus: CommandReceiptStatus = rejection ? "rejected" : "admitted";
    const initialMessage =
      rejection?.message ??
      (command.command.kind === "abort" ? "Abort admitted for live dispatch" : "Queued durably on host");
    let snapshot: ThreadProjectionSnapshot | undefined;
    let threadsFile: z.infer<typeof ThreadFileSchema> | undefined;
    if (!rejection && sourceSnapshot && thread && command.command.kind !== "abort") {
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
      executionGenerationId:
        thread?.currentLocation.executionGenerationId ?? command.expectedExecutionGenerationId ?? "unknown-generation",
      queuePosition:
        initialStatus === "admitted" && command.command.kind !== "abort"
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
      version: 1,
      kind: "command_admission",
      transactionId,
      preparedAt,
      command,
      receipt,
      snapshot,
      threadsFile,
      journalRecords,
      eventRecord,
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
      const transaction = await readJsonFile(path, AdmissionTransactionSchema, {
        maxBytes: MAX_ADMISSION_TRANSACTION_BYTES,
      });
      if (!transaction) throw new HostStoreError("INVALID_ADMISSION_TRANSACTION", `Missing transaction ${name}`);
      if (name !== `${storageKey(transaction.command.deviceId, transaction.command.commandId)}.json`) {
        throw new HostStoreError("INVALID_ADMISSION_TRANSACTION", `Transaction filename does not match ${transaction.transactionId}`);
      }
      await this.materializeAdmissionTransactionUnlocked(transaction, false);
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

  private async injectAdmissionFault(point: AdmissionFaultPoint, transactionId: string): Promise<void> {
    await this.options.admissionFaultInjector?.(point, transactionId);
  }

  private async injectResidentProjectionFault(
    point: ResidentProjectionFaultPoint,
    transactionId: string,
  ): Promise<void> {
    await this.options.residentProjectionFaultInjector?.(point, transactionId);
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
    const [host, projects, threads, authorities, bindings] = await Promise.all([
      this.readHostUnlocked(),
      this.readProjectsUnlocked(),
      this.readThreadsUnlocked(),
      this.readWorkspaceAuthoritiesUnlocked(),
      this.readResidentSessionBindingsUnlocked(),
    ]);
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
