import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createSelfBuildEnvironment, verifyReceiptEnvelope } from "../../scripts/self-build-evidence-lib.mjs";
import {
  CANDIDATE_EVALUATION_PROBE_CAPABILITY,
  CandidateEvaluationPreflightSchema,
  CandidateEvaluationReviewIdentitySchema,
  CandidateEvaluationReceiptSummarySchema,
  CandidateEvaluationSnapshotSchema,
  CandidateEvaluationStatusSchema,
  CandidateSourceIdentitySchema,
  PRIME_CONTINUIM_SELF_BUILD_EVALUATION_CAPABILITY,
  type CandidateEvaluationError,
  type CandidateEvaluationPreflight,
  type CandidateEvaluationPreflightRequest,
  type CandidateEvaluationReceiptSummary,
  type CandidateEvaluationReviewIdentity,
  type CandidateEvaluationSnapshot,
  type CandidateEvaluationStartRequest,
  type CandidateEvaluationStatus,
  type CandidateSourceIdentity,
} from "../shared/protocol";
import {
  CandidateEvaluationStore,
  CandidateEvaluationStoreError,
  isEvaluationBarrier,
  type CandidateEvaluationOperation,
  type CandidateEvaluationReceiptRecord,
} from "./candidate-evaluation-store";

const DEFAULT_INVOCATION_DEADLINE_MS = 135 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_REQUEST_AGE_MS = 5 * 60 * 1_000;
const MAX_REQUEST_FUTURE_SKEW_MS = 30_000;

declare const __PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__: string | undefined;

export interface CandidateEvaluationAuthorityStore {
  getHost(): Promise<{ hostId: string }>;
  resolveWorkspaceDirectory(threadId: string, executionGenerationId: string): Promise<string>;
}

export interface CandidateEvaluationBackendPreflight {
  review: CandidateEvaluationReviewIdentity;
  executor: {
    kind: "canonical_self_build";
    gateProcessContainment: "windows_job" | "posix_process_group";
    requiredNodeVersion: string;
    requiredPnpmVersion: string;
    verification: "passive-structure-before-consent;canonical-toolchain-inside-evaluation";
    launcherSource: "workspace-dependency-tree-candidate-controlled";
  };
  launchContext: unknown;
}

export interface CandidateEvaluationInvocation {
  pid: number;
  containment: "windows_job" | "posix_process_group";
  completed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminate(): Promise<boolean>;
}

export type CandidateEvaluationInvocationObservation =
  | "exact_live"
  | "retired"
  | "unknown"
  | "deadline_elapsed"
  | "outer_identity_unpublished";

export interface CandidateEvaluationBackend {
  /** Passive structural support only; it must never execute workspace bytes. */
  supported?(): boolean;
  preflight(workspaceDirectory: string): Promise<CandidateEvaluationBackendPreflight>;
  /** Rejection is exact proof that no process was created; successful return owns the whole contained tree. */
  launch(input: {
    workspaceDirectory: string;
    selfBuildRunId: string;
    launchContext: unknown;
  }): Promise<CandidateEvaluationInvocation>;
  readReceipt(workspaceDirectory: string, selfBuildRunId: string): Promise<unknown | undefined>;
  observeInvocation(record: CandidateEvaluationOperation, now: Date): Promise<CandidateEvaluationInvocationObservation>;
}

export interface CandidateEvaluationCoordinatorOptions {
  authorityStore: CandidateEvaluationAuthorityStore;
  persistence: CandidateEvaluationStore;
  backend?: CandidateEvaluationBackend;
  now?: () => Date;
  createRunId?: () => string;
  invocationDeadlineMs?: number;
  pollIntervalMs?: number;
}

export class CandidateEvaluationCoordinatorError extends Error {
  readonly code:
    | "EVALUATOR_NOT_READY"
    | "HOST_ID_MISMATCH"
    | "REQUEST_EXPIRED"
    | "CANDIDATE_CHANGED"
    | "EVALUATION_BUSY"
    | "EVALUATION_OUTCOME_UNKNOWN"
    | "EVALUATION_INVOCATION_UNCERTAIN"
    | "EVALUATION_STORAGE_FULL"
    | "EVALUATION_ID_CONFLICT"
    | "EVALUATION_CLOSED";

  constructor(code: CandidateEvaluationCoordinatorError["code"], message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "CandidateEvaluationCoordinatorError";
    this.code = code;
  }
}

class CandidateEvaluationBackendError extends Error {
  readonly code: Extract<
    CandidateEvaluationPreflight,
    { status: "unavailable" }
  >["code"];
  readonly retryable: boolean;

  constructor(
    code: CandidateEvaluationBackendError["code"],
    message: string,
    retryable: boolean,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "CandidateEvaluationBackendError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class CandidateEvaluationCoordinator {
  readonly capability = CANDIDATE_EVALUATION_PROBE_CAPABILITY;
  private readonly authorityStore: CandidateEvaluationAuthorityStore;
  private readonly persistence: CandidateEvaluationStore;
  private readonly backend: CandidateEvaluationBackend;
  private readonly now: () => Date;
  private readonly createRunId: () => string;
  private readonly invocationDeadlineMs: number;
  private readonly pollIntervalMs: number;
  private readonly liveInvocations = new Map<string, {
    invocation: CandidateEvaluationInvocation;
    request: CandidateEvaluationStartRequest;
  }>();
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();
  private operationTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private degraded = false;
  private closed = false;
  private initializePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: CandidateEvaluationCoordinatorOptions) {
    this.authorityStore = options.authorityStore;
    this.persistence = options.persistence;
    this.backend = options.backend ?? new LocalSelfBuildEvaluationBackend();
    this.now = options.now ?? (() => new Date());
    this.createRunId = options.createRunId ?? randomUUID;
    this.invocationDeadlineMs = options.invocationDeadlineMs ?? DEFAULT_INVOCATION_DEADLINE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.invocationDeadlineMs) || this.invocationDeadlineMs < 60_000) {
      throw new TypeError("Candidate evaluation invocation deadline must be at least one minute");
    }
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 10 || this.pollIntervalMs > 60_000) {
      throw new TypeError("Candidate evaluation poll interval must be from 10 to 60000 milliseconds");
    }
  }

  async initialize(): Promise<void> {
    this.initializePromise ??= (async () => {
      try {
        await this.persistence.initialize();
        await this.exclusive(async () => {
          for (const record of await this.persistence.list()) {
            const reconciled = await this.reconcileUnlocked(record, true);
            if (isEvaluationBarrier(reconciled)) this.schedulePoll(reconciled);
          }
        });
        this.initialized = true;
      } catch {
        this.degraded = true;
        this.initialized = false;
        for (const timer of this.pollTimers.values()) clearTimeout(timer);
        this.pollTimers.clear();
      }
    })();
    await this.initializePromise;
  }

  capabilityReady(): boolean {
    return this.initialized && !this.degraded && !this.closed && (this.backend.supported?.() ?? true);
  }

  async preflight(request: CandidateEvaluationPreflightRequest): Promise<CandidateEvaluationPreflight> {
    return await this.exclusive(async () => await this.preflightUnlocked(request));
  }

  async start(request: CandidateEvaluationStartRequest): Promise<CandidateEvaluationStatus> {
    return await this.exclusive(async () => {
      this.assertAvailable();
      await this.assertHost(request.expectedHostId);
      const workspaceDirectory = await this.authorityStore.resolveWorkspaceDirectory(
        request.threadId,
        request.expectedExecutionGenerationId,
      );
      const existing = await this.persistence.get(request);
      if (existing) {
        if (!isDeepStrictEqual(existing.request, request) || existing.workspaceDirectory !== workspaceDirectory) {
          throw new CandidateEvaluationCoordinatorError(
            "EVALUATION_ID_CONFLICT",
            "Candidate evaluation operation identity was reused with different inputs",
          );
        }
        const reconciled = await this.reconcileUnlocked(existing, true);
        if (reconciled.status.status !== "prepared") return reconciled.status;
        return await this.invokePreparedUnlocked(reconciled, workspaceDirectory);
      }

      const records = await this.persistence.list();
      for (let index = 0; index < records.length; index += 1) {
        if (isEvaluationBarrier(records[index]!)) {
          records[index] = await this.reconcileUnlocked(records[index]!, true);
        }
      }
      const barrier = records.find(isEvaluationBarrier);
      if (barrier) {
        throw new CandidateEvaluationCoordinatorError(
          barrier.status.status === "uncertain" ? "EVALUATION_OUTCOME_UNKNOWN" : "EVALUATION_BUSY",
          barrier.status.status === "uncertain"
            ? "A prior candidate invocation has unresolved process retirement"
            : "Another candidate evaluation is already prepared or running",
        );
      }

      this.assertFreshRequest(request.requestedAt);
      const ready = await this.inspectReadyWorkspace(workspaceDirectory);
      if (!isDeepStrictEqual(ready.review, request.expectedReview)) {
        throw new CandidateEvaluationCoordinatorError(
          "CANDIDATE_CHANGED",
          "The candidate changed after preflight; run preflight again before evaluating",
        );
      }
      const selfBuildRunId = this.createRunId().toLowerCase();
      await this.assertWorkspaceStillAuthoritative(request, workspaceDirectory);
      let prepared;
      try {
        prepared = await this.persistence.prepare(
          request,
          workspaceDirectory,
          selfBuildRunId,
          this.now().toISOString(),
        );
      } catch (error) {
        throw mapStoreError(error);
      }
      return await this.invokePreparedUnlocked(prepared.record, workspaceDirectory);
    });
  }

  async snapshot(request: CandidateEvaluationPreflightRequest): Promise<CandidateEvaluationSnapshot> {
    return await this.exclusive(async () => {
      this.assertAvailable();
      await this.assertHost(request.expectedHostId);
      await this.authorityStore.resolveWorkspaceDirectory(
        request.threadId,
        request.expectedExecutionGenerationId,
      );
      const matched: CandidateEvaluationStatus[] = [];
      for (const record of await this.persistence.list()) {
        if (
          record.request.expectedHostId !== request.expectedHostId ||
          record.request.threadId !== request.threadId ||
          record.request.expectedExecutionGenerationId !== request.expectedExecutionGenerationId
        ) {
          continue;
        }
        const reconciled = await this.reconcileUnlocked(record, true);
        matched.push(reconciled.status);
      }
      matched.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return CandidateEvaluationSnapshotSchema.parse({
        snapshotVersion: 1,
        ...request,
        generatedAt: this.now().toISOString(),
        repeatEffectsWarningRequired: matched.some((status) => status.status === "uncertain"),
        evaluations: matched.slice(0, 32),
      });
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closed = true;
    this.closePromise = this.exclusive(async () => {
      for (const timer of this.pollTimers.values()) clearTimeout(timer);
      this.pollTimers.clear();
      const failures: unknown[] = [];
      for (const [key, live] of [...this.liveInvocations.entries()]) {
        try {
          await live.invocation.terminate();
          const current = await this.persistence.get(live.request);
          const reconciled = current ? await this.reconcileUnlocked(current, true) : undefined;
          if (reconciled && isEvaluationBarrier(reconciled)) {
            failures.push(new Error("Candidate evaluation process-tree retirement was not confirmed"));
          }
        } catch (error) {
          failures.push(error);
        } finally {
          this.liveInvocations.delete(key);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Candidate evaluation shutdown was not fully confirmed");
      }
    });
    return await this.closePromise;
  }

  private async preflightUnlocked(
    request: CandidateEvaluationPreflightRequest,
  ): Promise<CandidateEvaluationPreflight> {
    this.assertAvailable();
    await this.assertHost(request.expectedHostId);
    const observedAt = this.now().toISOString();
    const base = { preflightVersion: 1 as const, ...request, observedAt, boundary: candidateEvaluationBoundary() };
    let workspaceDirectory: string;
    try {
      workspaceDirectory = await this.authorityStore.resolveWorkspaceDirectory(
        request.threadId,
        request.expectedExecutionGenerationId,
      );
    } catch (error) {
      return CandidateEvaluationPreflightSchema.parse({
        ...base,
        status: "unavailable",
        code: "WORKSPACE_AUTHORITY_CHANGED",
        message: "The registered workspace authority is unavailable for this execution generation",
        retryable: true,
      });
    }
    const records = await this.persistence.list();
    for (let index = 0; index < records.length; index += 1) {
      if (isEvaluationBarrier(records[index]!)) {
        records[index] = await this.reconcileUnlocked(records[index]!, true);
      }
    }
    const active = records.find(isEvaluationBarrier);
    if (active) {
      return CandidateEvaluationPreflightSchema.parse({
        ...base,
        status: "unavailable",
        code: active.status.status === "uncertain" ? "EVALUATION_OUTCOME_UNKNOWN" : "EVALUATION_BUSY",
        message: active.status.status === "uncertain"
          ? "A prior candidate invocation has unresolved process retirement and blocks another evaluation"
          : "Another candidate evaluation is already prepared or running",
        retryable: active.status.status !== "uncertain",
      });
    }
    try {
      const ready = await this.backend.preflight(workspaceDirectory);
      return CandidateEvaluationPreflightSchema.parse({
        ...base,
        status: "ready",
        capability: PRIME_CONTINUIM_SELF_BUILD_EVALUATION_CAPABILITY,
        review: ready.review,
        executor: ready.executor,
      });
    } catch (error) {
      const failure = error instanceof CandidateEvaluationBackendError
        ? error
        : new CandidateEvaluationBackendError(
            "CANDIDATE_INVALID",
            "The registered workspace did not pass bounded candidate evaluation preflight",
            true,
            { cause: error },
          );
      return CandidateEvaluationPreflightSchema.parse({
        ...base,
        status: "unavailable",
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      });
    }
  }

  private async inspectReadyWorkspace(
    workspaceDirectory: string,
  ): Promise<CandidateEvaluationBackendPreflight> {
    try {
      return await this.backend.preflight(workspaceDirectory);
    } catch (error) {
      if (error instanceof CandidateEvaluationBackendError) {
        throw new CandidateEvaluationCoordinatorError("EVALUATOR_NOT_READY", error.message, { cause: error });
      }
      throw error;
    }
  }

  private async invokePreparedUnlocked(
    prepared: CandidateEvaluationOperation,
    workspaceDirectory: string,
  ): Promise<CandidateEvaluationStatus> {
    let ready: CandidateEvaluationBackendPreflight;
    try {
      await this.assertWorkspaceStillAuthoritative(prepared.request, workspaceDirectory);
      ready = await this.backend.preflight(workspaceDirectory);
      if (!isDeepStrictEqual(ready.review, prepared.request.expectedReview)) throw new Error("review_changed");
    } catch (error) {
      const failed = await this.persistence.settle(prepared, "failed", this.now().toISOString(), {
        error: evaluationError(
          error instanceof Error && error.message === "review_changed" ? "CANDIDATE_CHANGED" : "EVALUATION_NOT_INVOKED",
          error instanceof Error && error.message === "review_changed"
            ? "The passive workspace review changed before invocation"
            : "The prepared evaluation was not invoked because its authority or launcher context changed",
          true,
        ),
      });
      return failed.status;
    }
    if (this.closed) {
      const failed = await this.persistence.settle(prepared, "failed", this.now().toISOString(), {
        error: evaluationError(
          "EVALUATION_NOT_INVOKED",
          "The prepared evaluation was not invoked because the evaluator is closing",
          true,
        ),
      });
      return failed.status;
    }
    const startedAt = this.now();
    const invocationRecord = await this.persistence.markInvocationStarted(
      prepared,
      prepared.selfBuildRunId,
      startedAt.toISOString(),
      new Date(startedAt.getTime() + this.invocationDeadlineMs).toISOString(),
    );
    if (this.closed) {
      // No launch call has occurred, so this is exact negative spawn evidence,
      // even though the conservative no-rerun boundary is already durable.
      const retired = await this.persistence.markInvocationRetired(
        invocationRecord,
        "spawn_failed",
        this.now().toISOString(),
      );
      const failed = await this.persistence.settle(retired, "failed", this.now().toISOString(), {
        error: evaluationError(
          "EVALUATION_LAUNCH_FAILED",
          "The invocation was not launched because the evaluator began closing",
          true,
        ),
      });
      return failed.status;
    }
    let invocation: CandidateEvaluationInvocation;
    try {
      invocation = await this.backend.launch({
        workspaceDirectory,
        selfBuildRunId: prepared.selfBuildRunId,
        launchContext: ready.launchContext,
      });
    } catch (error) {
      const retired = await this.persistence.markInvocationRetired(
        invocationRecord,
        "spawn_failed",
        this.now().toISOString(),
      );
      const failed = await this.persistence.settle(
        retired,
        "failed",
        this.now().toISOString(),
        {
          error: evaluationError(
            "EVALUATION_LAUNCH_FAILED",
            "The canonical self-build process could not be started",
            true,
          ),
        },
      );
      return failed.status;
    }

    const key = liveInvocationKey(invocationRecord);
    this.liveInvocations.set(key, { invocation, request: prepared.request });
    let running: CandidateEvaluationOperation;
    try {
      running = await this.persistence.markOuterProcess(
        invocationRecord,
        invocation.pid,
        this.now().toISOString(),
        invocation.containment,
      );
    } catch (error) {
      this.monitorInvocation(invocationRecord, invocation);
      throw new CandidateEvaluationCoordinatorError(
        "EVALUATION_INVOCATION_UNCERTAIN",
        "The invocation started but its outer process identity was not durably confirmed",
        { cause: error },
      );
    }
    this.monitorInvocation(running, invocation);
    this.schedulePoll(running);
    return running.status;
  }

  private monitorInvocation(record: CandidateEvaluationOperation, invocation: CandidateEvaluationInvocation): void {
    const key = liveInvocationKey(record);
    const settled = invocation.completed.then(
      async () => {
        this.liveInvocations.delete(key);
        await this.exclusive(async () => {
          const current = await this.persistence.get(record.request);
          if (!current) return;
          const reconciled = await this.reconcileUnlocked(current, true);
          if (isEvaluationBarrier(reconciled)) this.schedulePoll(reconciled);
        });
      },
      async () => {
        this.liveInvocations.delete(key);
        await this.exclusive(async () => {
          const current = await this.persistence.get(record.request);
          if (!current) return;
          const uncertain = current.status.status === "running" ? await this.settleUncertain(current) : current;
          if (isEvaluationBarrier(uncertain)) this.schedulePoll(uncertain);
        });
      },
    );
    void settled.catch(() => {
      this.degraded = true;
      this.schedulePoll(record);
    });
  }

  private async reconcileUnlocked(
    record: CandidateEvaluationOperation,
    recovery: boolean,
  ): Promise<CandidateEvaluationOperation> {
    let current = record;
    const outerReceipt = await this.persistence.getReceipt(record);
    if (outerReceipt) {
      current = await this.adoptOuterReceipt(current, outerReceipt);
    } else if (!current.status.receipt && current.status.status !== "prepared") {
      try {
        const selfBuildEnvelope = await this.backend.readReceipt(current.workspaceDirectory, current.selfBuildRunId);
        if (selfBuildEnvelope !== undefined) {
          current = await this.settleFromSelfBuildReceipt(current, selfBuildEnvelope);
        }
      } catch {
        if (current.status.status === "running") {
          current = await this.persistence.settle(current, "uncertain", this.now().toISOString(), {
            error: evaluationError(
              "EVALUATION_RECEIPT_INVALID",
              "The expected self-build receipt could not be validated",
              false,
            ),
          });
        }
      }
    }
    if (current.status.status === "prepared" && recovery) {
      return await this.persistence.settle(current, "failed", this.now().toISOString(), {
        error: evaluationError(
          "EVALUATION_NOT_INVOKED",
          "The durable preparation record was recovered before invocation and requires fresh consent",
          true,
        ),
      });
    }
    if (!current.invocation) return current;
    if (current.invocation.retirement) {
      return current.status.status === "running" ? await this.settleUncertain(current) : current;
    }
    const observation = await this.backend.observeInvocation(current, this.now());
    if (observation === "retired") {
      const retired = await this.persistence.markInvocationRetired(
        current,
        "tree_retired",
        this.now().toISOString(),
      );
      return retired.status.status === "running" ? await this.settleUncertain(retired) : retired;
    }
    if (observation === "outer_identity_unpublished" && recovery && current.status.status === "running") {
      current = await this.settleUncertain(current);
    }
    if (
      current.status.status === "running" &&
      current.invocation &&
      this.now().getTime() >= Date.parse(current.invocation.deadlineAt)
    ) {
      current = await this.settleUncertain(current);
    }
    this.schedulePoll(current);
    return current;
  }

  private async adoptOuterReceipt(
    record: CandidateEvaluationOperation,
    outer: CandidateEvaluationReceiptRecord,
  ): Promise<CandidateEvaluationOperation> {
    const verified = verifyReceiptEnvelope(outer.receipt.selfBuildEnvelope);
    const derived = receiptEvidence(verified, record);
    const status = outer.receipt.status;
    if (
      !isDeepStrictEqual(status.receipt, derived.summary) ||
      !isDeepStrictEqual(status.candidate, derived.candidate) ||
      status.completedAt !== derived.summary.completedAt ||
      (status.status !== "passed" && status.status !== "failed")
    ) {
      throw new CandidateEvaluationCoordinatorError(
        "EVALUATOR_NOT_READY",
        "Immutable candidate evidence failed exact receipt correlation",
      );
    }
    if (record.status.status === status.status && isDeepStrictEqual(record.status, status)) return record;
    return await this.persistence.settle(record, status.status, status.completedAt, {
      receipt: derived.summary,
      candidate: derived.candidate,
      ...(status.error ? { error: status.error } : {}),
      selfBuildEnvelope: verified,
    });
  }

  private async settleFromSelfBuildReceipt(
    record: CandidateEvaluationOperation,
    envelopeValue: unknown,
  ): Promise<CandidateEvaluationOperation> {
    const envelope = verifyReceiptEnvelope(envelopeValue);
    const evidence = receiptEvidence(envelope, record);
    const outcome = evidence.summary.outcome;
    return await this.persistence.settle(record, outcome, evidence.summary.completedAt, {
      receipt: evidence.summary,
      candidate: evidence.candidate,
      ...(outcome === "failed"
        ? { error: evaluationError("EVALUATION_FAILED", "The canonical self-build reported a failed gate", true) }
        : {}),
      selfBuildEnvelope: envelope,
    });
  }

  private async settleUncertain(record: CandidateEvaluationOperation): Promise<CandidateEvaluationOperation> {
    return await this.persistence.settle(record, "uncertain", this.now().toISOString(), {
      error: evaluationError(
        "EVALUATION_OUTCOME_UNKNOWN",
        "The exact self-build invocation cannot be safely replayed and its outcome is not yet evidenced",
        false,
      ),
    });
  }

  private schedulePoll(record: CandidateEvaluationOperation): void {
    if (this.closed) return;
    const key = liveInvocationKey(record);
    if (this.pollTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.pollTimers.delete(key);
      void this.exclusive(async () => {
        const current = await this.persistence.get(record.request);
        if (current && isEvaluationBarrier(current)) await this.reconcileUnlocked(current, true);
      }).catch(() => {
        this.degraded = true;
        this.schedulePoll(record);
      });
    }, this.pollIntervalMs);
    timer.unref();
    this.pollTimers.set(key, timer);
  }

  private assertFreshRequest(requestedAt: string): void {
    const age = this.now().getTime() - Date.parse(requestedAt);
    if (age > MAX_REQUEST_AGE_MS || age < -MAX_REQUEST_FUTURE_SKEW_MS) {
      throw new CandidateEvaluationCoordinatorError(
        "REQUEST_EXPIRED",
        "Candidate evaluation requests must be recent and cannot be future-dated",
      );
    }
  }

  private async assertHost(expectedHostId: string): Promise<void> {
    const host = await this.authorityStore.getHost();
    if (host.hostId !== expectedHostId) {
      throw new CandidateEvaluationCoordinatorError("HOST_ID_MISMATCH", "Candidate evaluation host authority changed");
    }
  }

  private async assertWorkspaceStillAuthoritative(
    request: Pick<CandidateEvaluationStartRequest, "threadId" | "expectedExecutionGenerationId">,
    expectedDirectory: string,
  ): Promise<void> {
    const current = await this.authorityStore.resolveWorkspaceDirectory(
      request.threadId,
      request.expectedExecutionGenerationId,
    );
    if (!samePath(current, expectedDirectory)) {
      throw new CandidateEvaluationCoordinatorError(
        "EVALUATOR_NOT_READY",
        "Workspace authority changed before candidate evaluation invocation",
      );
    }
  }

  private assertAvailable(): void {
    if (!this.initialized || this.degraded) {
      throw new CandidateEvaluationCoordinatorError("EVALUATOR_NOT_READY", "Candidate evaluator is unavailable");
    }
    if (this.closed) throw new CandidateEvaluationCoordinatorError("EVALUATION_CLOSED", "Candidate evaluator is closed");
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const prior = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

interface LocalLaunchContext {
  nodeExecutable: string;
  pnpmCli: string;
  windowsPowerShell?: string;
}

export class LocalSelfBuildEvaluationBackend implements CandidateEvaluationBackend {
  supported(): boolean {
    return candidateEvaluationPlatformSupported() &&
      typeof __PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__ === "string" &&
      __PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__.length >= 1_000;
  }

  async preflight(workspaceDirectory: string): Promise<CandidateEvaluationBackendPreflight> {
    if (process.platform !== "win32") {
      throw new CandidateEvaluationBackendError(
        "EVALUATOR_NOT_CONFIGURED",
        "This evaluator is withheld until a non-escapable local process-tree backend is installed",
        false,
      );
    }
    let root: string;
    try {
      root = await realpath(resolve(workspaceDirectory));
      if (!samePath(root, resolve(workspaceDirectory))) {
        throw new Error("Registered workspace is not physically canonical");
      }
    } catch (error) {
      throw new CandidateEvaluationBackendError(
        "GIT_CONTEXT_INVALID",
        "The registered workspace is not an exact physical Git root",
        false,
        { cause: error },
      );
    }

    try {
      if ((await workspaceBuildActivity(root)) !== "idle") {
        throw new CandidateEvaluationBackendError(
          "EVALUATION_BUSY",
          "A workspace build lock or command lease still requires retirement or recovery",
          true,
        );
      }
      const manifest = await readBoundedJson(join(root, "package.json"), 256 * 1024);
      if (
        manifest.name !== "prime-continuim" ||
        manifest.scripts?.selfBuild !== undefined ||
        manifest.scripts?.["self-build"] !== "node scripts/self-build.mjs" ||
        typeof manifest.packageManager !== "string"
      ) {
        throw new Error("Prime Continuim package identity or canonical self-build script is missing");
      }
      const pnpmMatch = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager);
      if (!pnpmMatch) throw new Error("The package-manager pin is invalid");
      await Promise.all([
        requireBoundedRegularFile(join(root, ".node-version"), 64),
        requireBoundedRegularFile(join(root, "pnpm-lock.yaml"), 16 * 1024 * 1024),
        requireBoundedRegularFile(join(root, "scripts", "self-build.mjs"), 2 * 1024 * 1024),
      ]);
      const requiredNode = (await readBoundedBytes(join(root, ".node-version"), 64)).toString("utf8").trim();
      if (!/^\d+\.\d+\.\d+$/.test(requiredNode)) throw new Error("The Node version pin is invalid");
      const nodePackage = await readBoundedJson(
        join(root, "node_modules", "node", "package.json"),
        256 * 1024,
        false,
      );
      if (nodePackage.version !== requiredNode) throw new Error("The dependency-local Node runtime does not match .node-version");
      const nodeExecutable = await resolveLocalNodeExecutable(root);
      const pnpmCli = await resolvePnpmCli();
      const windowsPowerShell = process.platform === "win32" ? await resolveWindowsPowerShell() : undefined;
      if (
        process.platform === "win32" &&
        (typeof __PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__ !== "string" ||
          __PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__.length < 1_000 ||
          !windowsPowerShell)
      ) {
        throw new Error("The attested Windows outer-job supervisor is unavailable");
      }
      const review = await capturePassiveReview(root, nodeExecutable, pnpmCli);
      return {
        review,
        executor: {
          kind: "canonical_self_build",
          gateProcessContainment: process.platform === "win32" ? "windows_job" : "posix_process_group",
          requiredNodeVersion: requiredNode,
          requiredPnpmVersion: pnpmMatch[1]!,
          verification: "passive-structure-before-consent;canonical-toolchain-inside-evaluation",
          launcherSource: "workspace-dependency-tree-candidate-controlled",
        },
        launchContext: Object.freeze({
          nodeExecutable,
          pnpmCli,
          ...(windowsPowerShell ? { windowsPowerShell } : {}),
        } satisfies LocalLaunchContext),
      };
    } catch (error) {
      if (error instanceof CandidateEvaluationBackendError) throw error;
      throw new CandidateEvaluationBackendError(
        "TOOLCHAIN_UNAVAILABLE",
        "Prime Continuim's exact Git, dependency, runtime, Node, and pnpm context is not available",
        true,
        { cause: error },
      );
    }
  }

  async launch(input: {
    workspaceDirectory: string;
    selfBuildRunId: string;
    launchContext: unknown;
  }): Promise<CandidateEvaluationInvocation> {
    const context = assertLocalLaunchContext(input.launchContext);
    const environment = createSelfBuildEnvironment(process.env);
    environment.npm_execpath = context.pnpmCli;
    const selfBuildArgs = [
      join(input.workspaceDirectory, "scripts", "self-build.mjs"),
      "--coordinator-run-id",
      input.selfBuildRunId,
    ];
    const child = process.platform === "win32"
      ? spawnWindowsJob(context, selfBuildArgs, input.workspaceDirectory, environment)
      : spawn(context.nodeExecutable, selfBuildArgs, {
          cwd: input.workspaceDirectory,
          env: environment,
          stdio: "ignore",
          windowsHide: true,
          detached: true,
        });
    await waitForSpawn(child);
    if (!child.pid) throw new Error("Candidate evaluation process did not publish a PID");
    const completed = childCompletion(child);
    return {
      pid: child.pid,
      containment: process.platform === "win32" ? "windows_job" : "posix_process_group",
      completed,
      terminate: async () => await terminateChild(child, completed),
    };
  }

  async readReceipt(workspaceDirectory: string, selfBuildRunId: string): Promise<unknown | undefined> {
    const receiptPath = join(
      workspaceDirectory,
      ".prime-continuim-self-build",
      "receipts",
      `receipt-${selfBuildRunId}.json`,
    );
    try {
      const bytes = await readBoundedBytes(receiptPath, 512 * 1024);
      return verifyReceiptEnvelope(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async observeInvocation(
    record: CandidateEvaluationOperation,
    _now: Date,
  ): Promise<CandidateEvaluationInvocationObservation> {
    const invocation = record.invocation;
    if (!invocation?.outerProcess) return "outer_identity_unpublished";
    if (invocation.outerProcess.containment !== "windows_job") return "unknown";
    // The persisted PID is the trusted PowerShell job holder, not the inner
    // candidate Node PID. KILL_ON_JOB_CLOSE plus the supervisor's zero-active
    // accounting fence makes holder retirement a whole-tree proof on Windows.
    // Microsoft Job Objects specify that closing the last job handle terminates
    // all associated processes before the job is destroyed. PID reuse can only
    // keep this barrier closed; it cannot authorize a second invocation.
    return isProcessAlive(invocation.outerProcess.pid) ? "exact_live" : "retired";
  }
}

export function candidateEvaluationPlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

function receiptEvidence(
  envelope: { receipt: Record<string, unknown>; receiptSha256: string },
  operation: CandidateEvaluationOperation,
): { summary: CandidateEvaluationReceiptSummary; candidate: CandidateSourceIdentity } {
  const receipt = envelope.receipt;
  if (receipt.runId !== operation.selfBuildRunId) throw new Error("Self-build run identity does not match operation");
  const source = CandidateSourceIdentitySchema.parse(receipt.source);
  const outcome = receipt.outcome;
  if (outcome !== "passed" && outcome !== "failed") throw new Error("Self-build outcome is invalid");
  const evaluation = asRecord(receipt.evaluation);
  const commands = Array.isArray(evaluation.commands) ? evaluation.commands : [];
  const artifacts = receipt.artifacts === null ? undefined : asRecord(receipt.artifacts);
  const summary = CandidateEvaluationReceiptSummarySchema.parse({
    receiptVersion: 1,
    kind: "prime_continuim_candidate_evaluation_evidence",
    selfBuildRunId: operation.selfBuildRunId,
    selfBuildReceiptSha256: envelope.receiptSha256,
    outcome,
    settledGateCount: Math.min(commands.length, 6),
    gateCount: 6,
    ...(artifacts
      ? {
          artifactAggregateSha256: artifacts.aggregateSha256,
          artifactFileCount: artifacts.fileCount,
        }
      : {}),
    completedAt: receipt.completedAt,
    boundary: candidateEvaluationBoundary(),
  });
  return { summary, candidate: source };
}

export async function capturePassiveReview(
  root: string,
  nodeExecutable: string,
  pnpmCli: string,
): Promise<CandidateEvaluationReviewIdentity> {
  const gitDirectory = join(root, ".git");
  const gitMetadata = await lstat(gitDirectory);
  if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink() || !samePath(await realpath(gitDirectory), gitDirectory)) {
    throw new Error("Passive review requires a plain repository Git directory");
  }
  const launcherPaths = [
    "self-build.mjs",
    "self-build-lib.mjs",
    "self-build-evidence-lib.mjs",
    "development-node-runtime.mjs",
    "workflow-lock-lib.mjs",
    "workflow-child-lease-lib.mjs",
    "workflow-supervised-step-lib.mjs",
    "workflow-child-supervisor.mjs",
    "windows-job-supervisor.ps1",
  ] as const;
  // Large executable/index inputs are streamed through one 64 KiB buffer each;
  // automatic review never materializes the roughly 185 MiB aggregate bound.
  const [headCommit, gitIndex, packageManifest, lockfile, nodeVersionPin, launcherBootstrap,
    runtimePointer, nodePackageManifest, nodeExecutableFile, pnpmCliFile] = await Promise.all([
    readPassiveHeadCommit(gitDirectory),
    hashBoundedFile(join(gitDirectory, "index"), 32 * 1024 * 1024),
    readBoundedBytes(join(root, "package.json"), 256 * 1024),
    hashBoundedFile(join(root, "pnpm-lock.yaml"), 16 * 1024 * 1024),
    readBoundedBytes(join(root, ".node-version"), 64),
    Promise.all(launcherPaths.map(async (name) =>
      await readBoundedBytes(join(root, "scripts", name), 1024 * 1024))),
    readBoundedBytes(join(root, "out", "runtime", "current.json"), 64 * 1024),
    readBoundedBytes(join(root, "node_modules", "node", "package.json"), 256 * 1024, false),
    hashBoundedFile(nodeExecutable, 128 * 1024 * 1024),
    hashPnpmLauncherClosure(pnpmCli),
  ]);
  const identity = {
    headCommit,
    gitIndexSha256: gitIndex.sha256,
    gitIndexBytes: gitIndex.bytes,
    packageManifestSha256: sha256Bytes(packageManifest),
    lockfileSha256: lockfile.sha256,
    lockfileBytes: lockfile.bytes,
    nodeVersionPinSha256: sha256Bytes(nodeVersionPin),
    selfBuildEntrypointSha256: sha256Bytes(launcherBootstrap[0]!),
    launcherBootstrapSha256: sha256Bytes(Buffer.from(JSON.stringify(
      launcherBootstrap.map((bytes, index) => ({
        name: launcherPaths[index],
        size: bytes.byteLength,
        sha256: sha256Bytes(bytes),
      })),
    ), "utf8")),
    launcherBootstrapFileCount: 9 as const,
    runtimePointerSha256: sha256Bytes(runtimePointer),
    nodePackageManifestSha256: sha256Bytes(nodePackageManifest),
    nodeExecutableSha256: nodeExecutableFile.sha256,
    pnpmCliSha256: pnpmCliFile.sha256,
  };
  return CandidateEvaluationReviewIdentitySchema.parse({
    ...identity,
    reviewAggregateSha256: sha256Bytes(Buffer.from(JSON.stringify(identity), "utf8")),
  });
}

async function hashPnpmLauncherClosure(pnpmCli: string): Promise<{ sha256: string; bytes: number }> {
  const cli = await hashBoundedFile(pnpmCli, 8 * 1024 * 1024);
  if (basename(pnpmCli).toLowerCase() !== "pnpm.js") return cli;
  const corepackBundlePath = join(dirname(pnpmCli), "lib", "corepack.cjs");
  const bundle = await hashBoundedFile(corepackBundlePath, 8 * 1024 * 1024);
  const closure = [
    { name: "pnpm.js", bytes: cli.bytes, sha256: cli.sha256 },
    { name: "lib/corepack.cjs", bytes: bundle.bytes, sha256: bundle.sha256 },
  ];
  return {
    sha256: sha256Bytes(Buffer.from(JSON.stringify(closure), "utf8")),
    bytes: cli.bytes + bundle.bytes,
  };
}

async function readPassiveHeadCommit(gitDirectory: string): Promise<string> {
  const head = (await readBoundedBytes(join(gitDirectory, "HEAD"), 4_096)).toString("utf8").trim();
  if (/^[a-f0-9]{40,64}$/.test(head)) return head;
  const match = /^ref: (refs\/[A-Za-z0-9._\/-]{1,512})$/.exec(head);
  if (!match || match[1]!.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Git HEAD is not a safe direct or symbolic commit reference");
  }
  try {
    const value = (await readBoundedBytes(join(gitDirectory, ...match[1]!.split("/")), 4_096)).toString("utf8").trim();
    if (/^[a-f0-9]{40,64}$/.test(value)) return value;
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
  const packed = (await readBoundedBytes(join(gitDirectory, "packed-refs"), 8 * 1024 * 1024)).toString("utf8");
  for (const line of packed.split(/\r?\n/)) {
    if (line.startsWith("#") || line.startsWith("^") || !line) continue;
    const separator = line.indexOf(" ");
    if (separator > 0 && line.slice(separator + 1) === match[1] && /^[a-f0-9]{40,64}$/.test(line.slice(0, separator))) {
      return line.slice(0, separator);
    }
  }
  throw new Error("Git HEAD commit could not be resolved passively");
}

async function resolveLocalNodeExecutable(root: string): Promise<string> {
  const candidate = process.platform === "win32"
    ? join(root, "node_modules", "node", "node.exe")
    : join(root, "node_modules", "node", "bin", "node");
  const physical = await realpath(candidate);
  await requireBoundedRegularFile(physical, 256 * 1024 * 1024);
  return physical;
}

export async function resolvePnpmCli(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const candidates = new Set<string>();
  if (
    environment.npm_execpath &&
    isAbsolute(environment.npm_execpath) &&
    isPnpmJavascriptLauncher(environment.npm_execpath)
  ) {
    candidates.add(environment.npm_execpath);
  }
  for (const directory of String(environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    candidates.add(join(directory, "node_modules", "corepack", "dist", "pnpm.js"));
    candidates.add(join(directory, "pnpm.cjs"));
  }
  for (const candidate of candidates) {
    try {
      const physical = await realpath(candidate);
      await requireBoundedRegularFile(physical, 16 * 1024 * 1024);
      if (isPnpmJavascriptLauncher(physical)) return physical;
    } catch {
      // Probe every bounded fixed candidate; no shell or candidate-controlled argument is used.
    }
  }
  throw new Error("The repo-pinned pnpm CLI could not be resolved");
}

function isPnpmJavascriptLauncher(path: string): boolean {
  return ["pnpm.js", "pnpm.cjs", "pnpm.mjs"].includes(basename(path).toLowerCase());
}

async function resolveWindowsPowerShell(): Promise<string | undefined> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) return undefined;
  const candidate = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const physical = await realpath(candidate);
    await requireBoundedRegularFile(physical, 8 * 1024 * 1024);
    return physical;
  } catch {
    return undefined;
  }
}

function spawnWindowsJob(
  context: LocalLaunchContext,
  selfBuildArgs: string[],
  workspaceDirectory: string,
  environment: NodeJS.ProcessEnv,
): ChildProcess {
  if (!context.windowsPowerShell || typeof __PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__ !== "string") {
    throw new Error("The attested Windows outer-job supervisor is unavailable");
  }
  const payload = Buffer.from(JSON.stringify({
    executable: context.nodeExecutable,
    commandLine: [context.nodeExecutable, ...selfBuildArgs].map(quoteWindowsArgument).join(" "),
    cwd: workspaceDirectory,
  }), "utf8").toString("base64");
  const command = `& { ${__PRIME_CONTINUIM_WINDOWS_JOB_SUPERVISOR__} } -Payload '${payload}'`;
  if (command.length > 24_000) throw new Error("The fixed Windows outer-job command exceeds its bound");
  return spawn(context.windowsPowerShell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ], {
    cwd: workspaceDirectory,
    env: environment,
    stdio: "ignore",
    windowsHide: true,
  });
}

function quoteWindowsArgument(value: string): string {
  if (value.length > 4_096 || /[\0\r\n]/.test(value)) throw new Error("Windows invocation argument is invalid");
  if (value && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}

async function readBoundedJson(
  path: string,
  maximumBytes: number,
  requireSingleLink = true,
): Promise<Record<string, any>> {
  const bytes = await readBoundedBytes(path, maximumBytes, requireSingleLink);
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  return asRecord(value);
}

async function readBoundedBytes(path: string, maximumBytes: number, requireSingleLink = true): Promise<Buffer> {
  const pathMetadata = await lstat(path);
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    (requireSingleLink && pathMetadata.nlink !== 1) ||
    pathMetadata.size <= 0 ||
    pathMetadata.size > maximumBytes
  ) {
    throw new Error("Expected a bounded passive-review file");
  }
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino ||
      before.size !== pathMetadata.size
    ) {
      throw new Error("Passive-review file changed during safe open");
    }
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(bytes, position, before.size - position, position);
      if (bytesRead <= 0) throw new Error("Passive-review file ended before its recorded size");
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
      throw new Error("Passive-review file changed during bounded read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function hashBoundedFile(path: string, maximumBytes: number): Promise<{ sha256: string; bytes: number }> {
  const pathMetadata = await lstat(path);
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.size <= 0 ||
    pathMetadata.size > maximumBytes
  ) {
    throw new Error("Expected a bounded passive-review file");
  }
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino ||
      before.size !== pathMetadata.size ||
      before.mtimeMs !== pathMetadata.mtimeMs
    ) {
      throw new Error("Passive-review file changed during safe open");
    }
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const length = Math.min(chunk.byteLength, before.size - position);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead <= 0) throw new Error("Passive-review file ended before its recorded size");
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      position !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error("Passive-review file changed during streamed hashing");
    }
    return { sha256: digest.digest("hex"), bytes: position };
  } finally {
    await handle.close();
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function requireBoundedRegularFile(path: string, maximumBytes: number): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error("Expected a bounded regular toolchain file");
  }
}

type PassiveFileState<T> = { state: "missing" } | { state: "unsafe" } | { state: "value"; value: T };

interface WorkflowLockOwner {
  token: string;
  pid: number;
  workflow: string;
  startedAt: string;
  projectRoot: string;
}

interface WorkflowChildOwner {
  token: string;
  lockToken: string;
  workflow: string;
  parentPid: number;
  supervisorPid: number;
  containment: "windows-job" | "posix-process-group";
  childPublication: "pending" | "published";
  childPid?: number;
}

export async function workspaceBuildActivity(root: string): Promise<"idle" | "busy"> {
  const lockPath = join(root, ".prime-continuim-workflow.lock");
  for (const suffix of [".recovery", ".stale-quarantine"] as const) {
    if ((await passivePathState(`${lockPath}${suffix}`)) !== "missing") return "busy";
  }
  const [main, child] = await Promise.all([
    readWorkflowLockState(lockPath),
    readWorkflowChildState(`${lockPath}.child`),
  ]);
  if (main.state === "missing" && child.state === "missing") return "idle";
  if (main.state !== "value") return "busy";
  if (!samePath(main.value.projectRoot, root) || isProcessAlive(main.value.pid)) return "busy";
  if (child.state === "missing") return "idle";
  if (
    child.state !== "value" ||
    child.value.lockToken !== main.value.token ||
    child.value.workflow !== main.value.workflow ||
    child.value.parentPid !== main.value.pid ||
    child.value.childPublication !== "published" ||
    isProcessAlive(child.value.supervisorPid) ||
    (child.value.childPid !== undefined && isContainedChildAlive(child.value))
  ) {
    return "busy";
  }
  return "idle";
}

async function passivePathState(path: string): Promise<"missing" | "present"> {
  try {
    await lstat(path);
    return "present";
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return "missing";
    return "present";
  }
}

async function readWorkflowLockState(path: string): Promise<PassiveFileState<WorkflowLockOwner>> {
  const value = await readPassiveJsonState(path, 16 * 1024);
  if (value.state !== "value") return value;
  const record = asRecord(value.value);
  if (
    record.schemaVersion !== 1 ||
    typeof record.token !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(record.token) ||
    !positivePid(record.pid) ||
    typeof record.workflow !== "string" ||
    record.workflow.length < 1 ||
    record.workflow.length > 128 ||
    typeof record.startedAt !== "string" ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    typeof record.projectRoot !== "string" ||
    record.projectRoot.length < 1
  ) return { state: "unsafe" };
  return {
    state: "value",
    value: {
      token: record.token,
      pid: record.pid,
      workflow: record.workflow,
      startedAt: record.startedAt,
      projectRoot: record.projectRoot,
    },
  };
}

async function readWorkflowChildState(path: string): Promise<PassiveFileState<WorkflowChildOwner>> {
  const value = await readPassiveJsonState(path, 16 * 1024);
  if (value.state !== "value") return value;
  const record = asRecord(value.value);
  if (
    record.schemaVersion !== 1 ||
    typeof record.token !== "string" ||
    typeof record.lockToken !== "string" ||
    typeof record.workflow !== "string" ||
    !positivePid(record.parentPid) ||
    !positivePid(record.supervisorPid) ||
    (record.containment !== "windows-job" && record.containment !== "posix-process-group") ||
    (record.childPublication !== "pending" && record.childPublication !== "published") ||
    (record.childPid !== undefined && !positivePid(record.childPid)) ||
    (record.childPublication === "published" && record.childPid === undefined)
  ) return { state: "unsafe" };
  return {
    state: "value",
    value: {
      token: record.token,
      lockToken: record.lockToken,
      workflow: record.workflow,
      parentPid: record.parentPid,
      supervisorPid: record.supervisorPid,
      containment: record.containment,
      childPublication: record.childPublication,
      ...(record.childPid === undefined ? {} : { childPid: record.childPid }),
    },
  };
}

async function readPassiveJsonState(path: string, maximumBytes: number): Promise<PassiveFileState<unknown>> {
  try {
    return { state: "value", value: JSON.parse((await readBoundedBytes(path, maximumBytes)).toString("utf8")) as unknown };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { state: "missing" };
    return { state: "unsafe" };
  }
}

function isContainedChildAlive(owner: WorkflowChildOwner): boolean {
  if (!owner.childPid) return false;
  if (owner.containment === "windows-job") return isProcessAlive(owner.childPid);
  try {
    process.kill(-owner.childPid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
}

function positivePid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function assertLocalLaunchContext(value: unknown): LocalLaunchContext {
  const record = asRecord(value);
  const expectedKeys = process.platform === "win32"
    ? ["nodeExecutable", "pnpmCli", "windowsPowerShell"]
    : ["nodeExecutable", "pnpmCli"];
  if (!isDeepStrictEqual(Object.keys(record).sort(), expectedKeys.sort())) {
    throw new TypeError("Candidate evaluation launch context has unexpected fields");
  }
  if (
    typeof record.nodeExecutable !== "string" ||
    !isAbsolute(record.nodeExecutable) ||
    typeof record.pnpmCli !== "string" ||
    !isAbsolute(record.pnpmCli) ||
    (process.platform === "win32" &&
      (typeof record.windowsPowerShell !== "string" || !isAbsolute(record.windowsPowerShell)))
  ) {
    throw new TypeError("Candidate evaluation launch context is invalid");
  }
  return {
    nodeExecutable: record.nodeExecutable,
    pnpmCli: record.pnpmCli,
    ...(process.platform === "win32" ? { windowsPowerShell: record.windowsPowerShell as string } : {}),
  };
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("spawn", resolvePromise);
    child.once("error", rejectPromise);
  });
}

function childCompletion(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function terminateChild(
  child: ChildProcess,
  completed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-(child.pid ?? 0), "SIGTERM");
  } catch (error) {
    if (!isErrorCode(error, "ESRCH")) return false;
  }
  const first = await Promise.race([completed.then(() => true), delay(5_000).then(() => false)]);
  if (first) return true;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-(child.pid ?? 0), "SIGKILL");
  } catch (error) {
    if (!isErrorCode(error, "ESRCH")) return false;
  }
  return await Promise.race([completed.then(() => true), delay(5_000).then(() => false)]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
}

function evaluationError(
  code: CandidateEvaluationError["code"],
  message: string,
  retryable: boolean,
): CandidateEvaluationError {
  return { code, message, retryable };
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
    integrity: "sha256-correlation-only-not-authentication" as const,
  };
}

function mapStoreError(error: unknown): CandidateEvaluationCoordinatorError {
  if (error instanceof CandidateEvaluationStoreError) {
    const code = error.code === "EVALUATION_STORAGE_FULL"
      ? "EVALUATION_STORAGE_FULL"
      : error.code === "EVALUATION_ID_CONFLICT" ? "EVALUATION_ID_CONFLICT" : "EVALUATOR_NOT_READY";
    return new CandidateEvaluationCoordinatorError(code, error.message, { cause: error });
  }
  return new CandidateEvaluationCoordinatorError(
    "EVALUATOR_NOT_READY",
    "Candidate evaluation state could not be committed",
    { cause: error },
  );
}

function liveInvocationKey(record: CandidateEvaluationOperation): string {
  return `${record.request.expectedHostId}\0${record.request.threadId}\0${record.request.expectedExecutionGenerationId}\0${record.request.operationId}`;
}

function asRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object");
  return value as Record<string, any>;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
