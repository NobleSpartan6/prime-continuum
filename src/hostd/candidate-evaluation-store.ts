import { createHash } from "node:crypto";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z, type ZodType } from "zod";
import {
  CandidateEvaluationStartRequestSchema,
  CandidateEvaluationStatusSchema,
  type CandidateEvaluationError,
  type CandidateEvaluationReceiptSummary,
  type CandidateEvaluationStartRequest,
  type CandidateEvaluationStatus,
  type CandidateSourceIdentity,
} from "../shared/protocol";
import {
  atomicWriteJson,
  atomicWriteJsonIfAbsent,
  ensurePrivateDirectory,
} from "./atomic-files";
import type { HostDataPaths } from "./paths";

const MAX_OPERATION_FILES = 128;
const MAX_OPERATION_BYTES = 128 * 1024;
const MAX_RECEIPT_BYTES = 768 * 1024;
const SAFE_FILE_NAME = /^[a-f0-9]{64}\.json$/;
const SAFE_TEMP_FILE_NAME = /^([a-f0-9]{64}\.json)\.tmp-[1-9]\d*-[a-f0-9]{16}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COORDINATOR_INTEGRITY = "sha256-correlation-only-not-authentication" as const;

const InvocationSchema = z
  .object({
    selfBuildRunId: z.string().uuid(),
    startedAt: z.iso.datetime({ offset: false }),
    deadlineAt: z.iso.datetime({ offset: false }),
    outerProcess: z
      .object({
        pid: z.number().int().positive(),
        observedAt: z.iso.datetime({ offset: false }),
        containment: z.enum(["windows_job", "posix_process_group"]),
      })
      .strict()
      .optional(),
    retirement: z
      .object({
        observedAt: z.iso.datetime({ offset: false }),
        proof: z.enum(["spawn_failed", "tree_retired"]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((invocation, context) => {
    if (Date.parse(invocation.deadlineAt) <= Date.parse(invocation.startedAt)) {
      context.addIssue({ code: "custom", path: ["deadlineAt"], message: "Invocation deadline must follow its start" });
    }
    if (invocation.outerProcess && Date.parse(invocation.outerProcess.observedAt) < Date.parse(invocation.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["outerProcess", "observedAt"],
        message: "Outer process observation cannot predate invocation",
      });
    }
    if (invocation.retirement && Date.parse(invocation.retirement.observedAt) < Date.parse(invocation.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["retirement", "observedAt"],
        message: "Retirement observation cannot predate invocation",
      });
    }
    if (
      invocation.retirement &&
      invocation.retirement.proof !== "spawn_failed" &&
      invocation.outerProcess === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["retirement", "proof"],
        message: "Process retirement proof requires the published outer process",
      });
    }
  });

export const CandidateEvaluationOperationSchema = z
  .object({
    recordVersion: z.literal(1),
    request: CandidateEvaluationStartRequestSchema,
    workspaceDirectory: z.string().min(1).max(4_096).regex(/^[^\0\r\n]+$/),
    selfBuildRunId: z.string().uuid(),
    status: CandidateEvaluationStatusSchema,
    invocation: InvocationSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.request.expectedHostId !== record.status.expectedHostId ||
      record.request.threadId !== record.status.threadId ||
      record.request.expectedExecutionGenerationId !== record.status.expectedExecutionGenerationId ||
      record.request.operationId !== record.status.operationId ||
      record.request.kind !== record.status.kind ||
      record.request.requestedAt !== record.status.requestedAt ||
      !isDeepStrictEqual(record.request.expectedReview, record.status.review)
    ) {
      context.addIssue({ code: "custom", path: ["status"], message: "Operation status must match its request" });
    }
    if (record.invocation === undefined && record.status.invocationStartedAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["invocation"],
        message: "Invocation state must match the public invocation boundary",
      });
    }
    if (record.invocation !== undefined && record.status.invocationStartedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["invocation"],
        message: "A committed invocation must remain visible in public status",
      });
    }
    if (
      record.invocation &&
      (record.invocation.startedAt !== record.status.invocationStartedAt ||
        record.invocation.selfBuildRunId !== record.selfBuildRunId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["invocation"],
        message: "Invocation identity must match the prepared operation",
      });
    }
    if (record.status.receipt?.selfBuildRunId !== undefined && record.status.receipt.selfBuildRunId !== record.selfBuildRunId) {
      context.addIssue({
        code: "custom",
        path: ["status", "receipt", "selfBuildRunId"],
        message: "Receipt run identity must match the prepared operation",
      });
    }
  });
export type CandidateEvaluationOperation = z.infer<typeof CandidateEvaluationOperationSchema>;

const CandidateEvaluationReceiptPayloadSchema = z
  .object({
    receiptVersion: z.literal(1),
    operationKey: z.string().length(64).regex(SHA256),
    status: CandidateEvaluationStatusSchema,
    selfBuildEnvelope: z.unknown(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      (receipt.status.status !== "passed" && receipt.status.status !== "failed") ||
      receipt.status.receipt === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Immutable candidate evidence requires a receipt-backed terminal status",
      });
    }
  });

const CandidateEvaluationReceiptRecordSchema = z
  .object({
    integrity: z.literal(COORDINATOR_INTEGRITY),
    receipt: CandidateEvaluationReceiptPayloadSchema,
    receiptSha256: z.string().length(64).regex(SHA256),
  })
  .strict()
  .superRefine((envelope, context) => {
    const expected = sha256(canonicalJson(envelope.receipt));
    if (envelope.receiptSha256 !== expected) {
      context.addIssue({
        code: "custom",
        path: ["receiptSha256"],
        message: "Coordinator receipt digest does not match its payload",
      });
    }
  });
export type CandidateEvaluationReceiptRecord = z.infer<typeof CandidateEvaluationReceiptRecordSchema>;

export class CandidateEvaluationStoreError extends Error {
  readonly code: "EVALUATION_ID_CONFLICT" | "EVALUATION_STORAGE_FULL" | "EVALUATION_STORE_INVALID";

  constructor(code: CandidateEvaluationStoreError["code"], message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "CandidateEvaluationStoreError";
    this.code = code;
  }
}

export class CandidateEvaluationStore {
  readonly paths: Pick<HostDataPaths, "candidateEvaluationOperations" | "candidateEvaluationReceipts">;
  private initialized = false;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(paths: Pick<HostDataPaths, "candidateEvaluationOperations" | "candidateEvaluationReceipts">) {
    this.paths = paths;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await Promise.all([
      ensurePrivateDirectory(this.paths.candidateEvaluationOperations),
      ensurePrivateDirectory(this.paths.candidateEvaluationReceipts),
    ]);
    await Promise.all([
      recoverAtomicTemporaryFiles(this.paths.candidateEvaluationOperations, MAX_OPERATION_BYTES),
      recoverAtomicTemporaryFiles(this.paths.candidateEvaluationReceipts, MAX_RECEIPT_BYTES),
    ]);
    const operationNames = await validateBoundedDirectory(
      this.paths.candidateEvaluationOperations,
      MAX_OPERATION_FILES,
    );
    const receiptNames = await validateBoundedDirectory(
      this.paths.candidateEvaluationReceipts,
      MAX_OPERATION_FILES,
    );
    const operations = await Promise.all(
      operationNames.map(async (name) => {
        const record = await readSafeJsonFile(
          join(this.paths.candidateEvaluationOperations, name),
          CandidateEvaluationOperationSchema,
          MAX_OPERATION_BYTES,
        );
        if (`${operationKey(record!.request)}.json` !== name) throw invalidStore("Operation filename is not correlated");
        return record!;
      }),
    );
    const byKey = new Map(operations.map((record) => [operationKey(record.request), record]));
    const active = operations.filter(isEvaluationBarrier);
    if (active.length > 1) throw invalidStore("More than one candidate evaluation is active");

    const receipts = new Map<string, CandidateEvaluationReceiptRecord>();
    for (const name of receiptNames) {
      const envelope = (await readSafeJsonFile(
        join(this.paths.candidateEvaluationReceipts, name),
        CandidateEvaluationReceiptRecordSchema,
        MAX_RECEIPT_BYTES,
      ))!;
      const key = envelope.receipt.operationKey;
      if (`${key}.json` !== name || receipts.has(key)) throw invalidStore("Receipt filename is not correlated");
      const operation = byKey.get(key);
      if (
        !operation ||
        !operation.invocation ||
        envelope.receipt.status.invocationStartedAt !== operation.invocation.startedAt ||
        !receiptBelongsToOperation(envelope, operation)
      ) {
        throw invalidStore("Immutable candidate receipt does not match its operation");
      }
      receipts.set(key, envelope);
    }
    for (const operation of operations) {
      if (operation.status.receipt) {
        if (!operation.invocation || operation.status.invocationStartedAt === undefined) {
          throw invalidStore("Immutable candidate evidence cannot predate the durable invocation boundary");
        }
        const receipt = receipts.get(operationKey(operation.request));
        if (!receipt || !isDeepStrictEqual(receipt.receipt.status, operation.status)) {
          throw invalidStore("Receipt-backed terminal operation is missing exact immutable evidence");
        }
      }
    }
    this.initialized = true;
  }

  async prepare(
    request: CandidateEvaluationStartRequest,
    workspaceDirectory: string,
    selfBuildRunId: string,
    now: string,
  ): Promise<{ record: CandidateEvaluationOperation; created: boolean }> {
    return await this.exclusive(async () => {
      this.assertInitialized();
      const key = operationKey(request);
      const path = this.operationPath(key);
      const existing = await readSafeJsonFile(path, CandidateEvaluationOperationSchema, MAX_OPERATION_BYTES, true);
      if (existing) {
        return {
          record: assertSameOperation(existing, request, workspaceDirectory, selfBuildRunId),
          created: false,
        };
      }
      const records = await this.listUnlocked();
      if (records.some(isEvaluationBarrier)) {
        throw new CandidateEvaluationStoreError(
          "EVALUATION_ID_CONFLICT",
          "Another candidate evaluation is already prepared or running",
        );
      }
      if (records.length >= MAX_OPERATION_FILES) {
        throw new CandidateEvaluationStoreError(
          "EVALUATION_STORAGE_FULL",
          "Candidate evaluation storage reached its bounded operation limit",
        );
      }
      const record = CandidateEvaluationOperationSchema.parse({
        recordVersion: 1,
        request,
        workspaceDirectory,
        selfBuildRunId,
        status: {
          statusVersion: 1,
          expectedHostId: request.expectedHostId,
          threadId: request.threadId,
          expectedExecutionGenerationId: request.expectedExecutionGenerationId,
          operationId: request.operationId,
          kind: request.kind,
          requestedAt: request.requestedAt,
          updatedAt: now,
          status: "prepared",
          review: request.expectedReview,
          boundary: candidateEvaluationBoundary(),
        },
      });
      const created = await atomicWriteJsonIfAbsent(path, record, MAX_OPERATION_BYTES);
      if (!created) {
        const winner = await readSafeJsonFile(path, CandidateEvaluationOperationSchema, MAX_OPERATION_BYTES);
        return {
          record: assertSameOperation(winner!, request, workspaceDirectory, selfBuildRunId),
          created: false,
        };
      }
      return { record, created: true };
    });
  }

  async markInvocationStarted(
    record: CandidateEvaluationOperation,
    selfBuildRunId: string,
    startedAt: string,
    deadlineAt: string,
  ): Promise<CandidateEvaluationOperation> {
    return await this.exclusive(async () => {
      if (record.invocation) {
        if (
          record.invocation.selfBuildRunId !== selfBuildRunId ||
          record.invocation.startedAt !== startedAt ||
          record.invocation.deadlineAt !== deadlineAt
        ) {
          throw invalidStore("Invocation identity changed after it was committed");
        }
        return record;
      }
      if (record.selfBuildRunId !== selfBuildRunId || record.status.status !== "prepared") {
        throw invalidStore("Only the exact prepared run can cross the invocation boundary");
      }
      return await this.replaceUnlocked(record, {
        ...record,
        invocation: { selfBuildRunId, startedAt, deadlineAt },
        status: {
          ...record.status,
          status: "running",
          updatedAt: startedAt,
          invocationStartedAt: startedAt,
        },
      });
    });
  }

  async markOuterProcess(
    record: CandidateEvaluationOperation,
    pid: number,
    observedAt: string,
    containment: "windows_job" | "posix_process_group",
  ): Promise<CandidateEvaluationOperation> {
    return await this.exclusive(async () => {
      if (!record.invocation || record.status.status !== "running") {
        throw invalidStore("Outer process publication requires a running invocation");
      }
      if (record.invocation.outerProcess) {
        if (
          record.invocation.outerProcess.pid !== pid ||
          record.invocation.outerProcess.observedAt !== observedAt ||
          record.invocation.outerProcess.containment !== containment
        ) {
          throw invalidStore("Candidate evaluation outer process identity changed");
        }
        return record;
      }
      return await this.replaceUnlocked(record, {
        ...record,
        invocation: { ...record.invocation, outerProcess: { pid, observedAt, containment } },
        status: { ...record.status, updatedAt: observedAt },
      });
    });
  }

  async markInvocationRetired(
    record: CandidateEvaluationOperation,
    proof: "spawn_failed" | "tree_retired",
    observedAt: string,
  ): Promise<CandidateEvaluationOperation> {
    return await this.exclusive(async () => {
      if (!record.invocation) throw invalidStore("Invocation retirement requires a committed invocation");
      if (record.invocation.retirement) {
        if (
          record.invocation.retirement.proof !== proof ||
          record.invocation.retirement.observedAt !== observedAt
        ) {
          throw invalidStore("Invocation retirement proof changed after publication");
        }
        return record;
      }
      if (proof !== "spawn_failed" && !record.invocation.outerProcess) {
        throw invalidStore("Outer process identity is required for retirement proof");
      }
      return await this.replaceUnlocked(record, {
        ...record,
        invocation: { ...record.invocation, retirement: { proof, observedAt } },
      });
    });
  }

  /** Publishes immutable evidence before making its terminal status visible. */
  async settle(
    record: CandidateEvaluationOperation,
    status: "passed" | "failed" | "uncertain",
    completedAt: string,
    options: {
      receipt?: CandidateEvaluationReceiptSummary;
      candidate?: CandidateSourceIdentity;
      error?: CandidateEvaluationError;
      selfBuildEnvelope?: unknown;
    } = {},
  ): Promise<CandidateEvaluationOperation> {
    return await this.exclusive(async () => {
      const { receipt, candidate, error, selfBuildEnvelope } = options;
      const nextStatus = CandidateEvaluationStatusSchema.parse({
        ...stripTerminalFields(record.status),
        status,
        updatedAt: completedAt,
        completedAt,
        ...(receipt ? { receipt } : {}),
        ...(candidate ? { candidate } : {}),
        ...(error ? { error } : {}),
      });
      assertTransition(record.status, nextStatus);
      const next = CandidateEvaluationOperationSchema.parse({ ...record, status: nextStatus });

      if (receipt) {
        if (!candidate || selfBuildEnvelope === undefined || (status !== "passed" && status !== "failed")) {
          throw invalidStore("Receipt-backed settlement requires its exact self-build envelope");
        }
        await this.publishReceiptUnlocked(next, selfBuildEnvelope);
      } else if (candidate !== undefined || selfBuildEnvelope !== undefined || status === "passed") {
        throw invalidStore("Passing settlement cannot omit immutable evidence");
      }
      return await this.replaceUnlocked(record, next);
    });
  }

  async get(request: CandidateEvaluationStartRequest): Promise<CandidateEvaluationOperation | undefined> {
    return await this.exclusive(async () => {
      this.assertInitialized();
      return await readSafeJsonFile(
        this.operationPath(operationKey(request)),
        CandidateEvaluationOperationSchema,
        MAX_OPERATION_BYTES,
        true,
      );
    });
  }

  async getReceipt(record: CandidateEvaluationOperation): Promise<CandidateEvaluationReceiptRecord | undefined> {
    return await this.exclusive(async () => {
      this.assertInitialized();
      const envelope = await readSafeJsonFile(
        this.receiptPath(operationKey(record.request)),
        CandidateEvaluationReceiptRecordSchema,
        MAX_RECEIPT_BYTES,
        true,
      );
      if (envelope && !receiptBelongsToOperation(envelope, record)) {
        throw invalidStore("Immutable candidate receipt does not match its operation");
      }
      return envelope;
    });
  }

  async list(): Promise<CandidateEvaluationOperation[]> {
    return await this.exclusive(async () => {
      this.assertInitialized();
      return await this.listUnlocked();
    });
  }

  private async publishReceiptUnlocked(
    record: CandidateEvaluationOperation,
    selfBuildEnvelope: unknown,
  ): Promise<void> {
    if (!record.status.receipt) throw invalidStore("Cannot publish candidate evidence without a receipt summary");
    const key = operationKey(record.request);
    const payload = CandidateEvaluationReceiptPayloadSchema.parse({
      receiptVersion: 1,
      operationKey: key,
      status: record.status,
      selfBuildEnvelope,
    });
    const envelope = CandidateEvaluationReceiptRecordSchema.parse({
      integrity: COORDINATOR_INTEGRITY,
      receipt: payload,
      receiptSha256: sha256(canonicalJson(payload)),
    });
    const path = this.receiptPath(key);
    const created = await atomicWriteJsonIfAbsent(path, envelope, MAX_RECEIPT_BYTES);
    if (created) return;
    const existing = await readSafeJsonFile(path, CandidateEvaluationReceiptRecordSchema, MAX_RECEIPT_BYTES);
    if (!isDeepStrictEqual(existing, envelope)) {
      throw new CandidateEvaluationStoreError(
        "EVALUATION_ID_CONFLICT",
        "Immutable candidate evaluation evidence conflicts with an existing receipt",
      );
    }
  }

  private async replaceUnlocked(
    previous: CandidateEvaluationOperation,
    nextValue: CandidateEvaluationOperation,
  ): Promise<CandidateEvaluationOperation> {
    this.assertInitialized();
    const next = CandidateEvaluationOperationSchema.parse(nextValue);
    const path = this.operationPath(operationKey(previous.request));
    const current = await readSafeJsonFile(path, CandidateEvaluationOperationSchema, MAX_OPERATION_BYTES);
    if (!isDeepStrictEqual(current, previous)) {
      if (isDeepStrictEqual(current, next)) return current!;
      throw new CandidateEvaluationStoreError(
        "EVALUATION_ID_CONFLICT",
        "Candidate evaluation state changed concurrently",
      );
    }
    await atomicWriteJson(path, next, MAX_OPERATION_BYTES);
    return next;
  }

  private async listUnlocked(): Promise<CandidateEvaluationOperation[]> {
    const names = await validateBoundedDirectory(
      this.paths.candidateEvaluationOperations,
      MAX_OPERATION_FILES,
    );
    return await Promise.all(
      names.map(async (name) => {
        const record = await readSafeJsonFile(
          join(this.paths.candidateEvaluationOperations, name),
          CandidateEvaluationOperationSchema,
          MAX_OPERATION_BYTES,
        );
        if (`${operationKey(record!.request)}.json` !== name) throw invalidStore("Operation filename is not correlated");
        return record!;
      }),
    );
  }

  private operationPath(key: string): string {
    return join(this.paths.candidateEvaluationOperations, `${key}.json`);
  }

  private receiptPath(key: string): string {
    return join(this.paths.candidateEvaluationReceipts, `${key}.json`);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Candidate evaluation store is not initialized");
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const prior = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

function assertSameOperation(
  record: CandidateEvaluationOperation,
  request: CandidateEvaluationStartRequest,
  workspaceDirectory: string,
  selfBuildRunId: string,
): CandidateEvaluationOperation {
  if (
    !isDeepStrictEqual(record.request, request) ||
    record.workspaceDirectory !== workspaceDirectory ||
    record.selfBuildRunId !== selfBuildRunId
  ) {
    throw new CandidateEvaluationStoreError(
      "EVALUATION_ID_CONFLICT",
      "Candidate evaluation operation identity was reused with different inputs",
    );
  }
  return record;
}

function receiptBelongsToOperation(
  envelope: CandidateEvaluationReceiptRecord,
  operation: CandidateEvaluationOperation,
): boolean {
  const receiptStatus = envelope.receipt.status;
  return (
    envelope.receipt.operationKey === operationKey(operation.request) &&
    receiptStatus.expectedHostId === operation.status.expectedHostId &&
    receiptStatus.threadId === operation.status.threadId &&
    receiptStatus.expectedExecutionGenerationId === operation.status.expectedExecutionGenerationId &&
    receiptStatus.operationId === operation.status.operationId &&
    receiptStatus.kind === operation.status.kind &&
    receiptStatus.requestedAt === operation.status.requestedAt &&
    isDeepStrictEqual(receiptStatus.review, operation.status.review) &&
    receiptStatus.receipt?.selfBuildRunId === operation.selfBuildRunId
  );
}

export function isEvaluationBarrier(record: CandidateEvaluationOperation): boolean {
  return record.status.status === "prepared" ||
    (record.invocation !== undefined && record.invocation.retirement === undefined);
}

function assertTransition(previous: CandidateEvaluationStatus, next: CandidateEvaluationStatus): void {
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) throw invalidStore("Evaluation time moved backwards");
  const exactSame = isDeepStrictEqual(previous, next);
  const allowed =
    exactSame ||
    (previous.status === "prepared" && next.status === "failed" && next.invocationStartedAt === undefined) ||
    (previous.status === "running" &&
      (next.status === "uncertain" || next.status === "failed" || next.status === "passed")) ||
    (previous.status === "uncertain" &&
      next.receipt !== undefined &&
      (next.status === "failed" || next.status === "passed"));
  if (!allowed) throw invalidStore("Candidate evaluation attempted an invalid state transition");
}

function stripTerminalFields(status: CandidateEvaluationStatus): Omit<
  CandidateEvaluationStatus,
  "status" | "updatedAt" | "completedAt" | "receipt" | "candidate" | "error"
> {
  const {
    status: _status,
    updatedAt: _updatedAt,
    completedAt: _completedAt,
    receipt: _receipt,
    candidate: _candidate,
    error: _error,
    ...base
  } = status;
  return base;
}

function operationKey(request: CandidateEvaluationStartRequest): string {
  return sha256(
    canonicalJson({
      expectedHostId: request.expectedHostId,
      threadId: request.threadId,
      expectedExecutionGenerationId: request.expectedExecutionGenerationId,
      operationId: request.operationId,
    }),
  );
}

function candidateEvaluationBoundary() {
  return {
    securitySandbox: false,
    mainFilesystemIsolation: false,
    providerBackedEvaluation: false,
    autonomousPromotion: false,
    candidateControlledEvaluation: true,
    packageOrInstallerGate: false,
    authenticated: false,
    integrity: COORDINATOR_INTEGRITY,
  };
}

/**
 * Atomic writers can leave only one narrowly named private sibling if the
 * process crashes. Remove an unpublished inode, or the extra name of the exact
 * already-published inode, before applying the strict authoritative scan.
 */
async function recoverAtomicTemporaryFiles(directory: string, maximumBytes: number): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > MAX_OPERATION_FILES * 2) {
    throw invalidStore("Candidate evaluation storage exceeds its bounded recovery entry limit");
  }
  let cleaned = false;
  for (const entry of entries) {
    const match = SAFE_TEMP_FILE_NAME.exec(entry.name);
    if (!match) continue;
    const temporaryPath = join(directory, entry.name);
    const metadata = await lstat(temporaryPath);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size <= 0 ||
      metadata.size > maximumBytes ||
      (metadata.nlink !== 1 && metadata.nlink !== 2)
    ) {
      throw invalidStore("Candidate evaluation atomic recovery found an unsafe temporary file");
    }
    const targetPath = join(directory, match[1]!);
    let targetMetadata;
    try {
      targetMetadata = await lstat(targetPath);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    if (metadata.nlink === 2) {
      if (
        !targetMetadata ||
        !targetMetadata.isFile() ||
        targetMetadata.isSymbolicLink() ||
        targetMetadata.dev !== metadata.dev ||
        targetMetadata.ino !== metadata.ino
      ) {
        throw invalidStore("Candidate evaluation atomic recovery found an uncorrelated hard link");
      }
    } else if (
      targetMetadata &&
      targetMetadata.dev === metadata.dev &&
      targetMetadata.ino === metadata.ino
    ) {
      throw invalidStore("Candidate evaluation atomic recovery found inconsistent link metadata");
    }
    await unlink(temporaryPath);
    cleaned = true;
  }
  if (cleaned) await syncDirectory(directory);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Windows does not support fsync on directory handles. The individual
    // files were already flushed; POSIX must additionally persist name cleanup.
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function validateBoundedDirectory(directory: string, maximum: number): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > maximum) throw invalidStore("Candidate evaluation storage exceeds its bounded file limit");
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !SAFE_FILE_NAME.test(entry.name)) {
      throw invalidStore("Candidate evaluation storage contains an unexpected entry");
    }
    const metadata = await lstat(join(directory, entry.name));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw invalidStore("Candidate evaluation storage contains an unsafe file");
    }
    names.push(entry.name);
  }
  return names.sort();
}

async function readSafeJsonFile<T>(
  path: string,
  schema: ZodType<T>,
  maximumBytes: number,
  optional = false,
): Promise<T | undefined> {
  let pathMetadata;
  try {
    pathMetadata = await lstat(path);
  } catch (error) {
    if (optional && isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.nlink !== 1 ||
    pathMetadata.size <= 0 ||
    pathMetadata.size > maximumBytes
  ) {
    throw invalidStore("Candidate evaluation state is not a bounded plain file");
  }
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== pathMetadata.size ||
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino ||
      before.size > maximumBytes
    ) {
      throw invalidStore("Candidate evaluation state changed during safe open");
    }
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(bytes, position, before.size - position, position);
      if (bytesRead <= 0) throw invalidStore("Candidate evaluation state ended before its recorded size");
      position += bytesRead;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    const { bytesRead: growthBytes } = await handle.read(growthProbe, 0, 1, before.size);
    const after = await handle.stat();
    if (
      position !== before.size ||
      growthBytes !== 0 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw invalidStore("Candidate evaluation state changed during bounded read");
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw invalidStore("Candidate evaluation state is not valid JSON", error);
    }
    return schema.parse(value);
  } finally {
    await handle.close();
  }
}

function invalidStore(message: string, cause?: unknown): CandidateEvaluationStoreError {
  return new CandidateEvaluationStoreError("EVALUATION_STORE_INVALID", message, { cause });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON rejects undefined and non-JSON values");
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
