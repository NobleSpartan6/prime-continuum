import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type ResidentOwnedRuntimeCandidate,
} from "./prime-agent-resident-adapter";
import type { ResidentProjectionSnapshot } from "./resident-projection";
import {
  ResidentEndAcknowledgementSchema,
  ResidentRuntimeContractError,
  validateResidentOwnedSessionCreateInput,
  type ResidentOwnedSessionCreateInput,
  type ResidentEndAcknowledgement,
  type ResidentSessionBinding,
} from "./resident-runtime";
import {
  ResidentEndLifecycleOperationInputSchema,
  ResidentLifecycleOperationInputSchema,
  type HostStore,
  type ResidentEndLifecycleOperationInput,
  type ResidentLifecycleOperationInput,
  type ResidentLifecycleProjectionLease,
  type ResidentLifecycleStatus,
  type ResidentKillLease,
  type ResidentOwnedSessionCandidate,
} from "./store";

const ResidentProvisionSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("new"),
      sessionName: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resume"),
      sessionPath: z.string(),
    })
    .strict(),
]);

const ResidentProvisionRequestSchema = ResidentLifecycleOperationInputSchema.omit({
  requestDigest: true,
  expectedSourceCursor: true,
})
  .extend({ selection: ResidentProvisionSelectionSchema })
  .strict();

export type ResidentProvisionSelection = z.infer<typeof ResidentProvisionSelectionSchema>;
export type ResidentProvisionRequest = z.infer<typeof ResidentProvisionRequestSchema>;

const ResidentEndRequestSchema = ResidentLifecycleOperationInputSchema.omit({
  requestDigest: true,
})
  .extend({ expectedSourceCursor: ResidentEndLifecycleOperationInputSchema.shape.expectedSourceCursor })
  .strict();

export type ResidentEndRequest = z.infer<typeof ResidentEndRequestSchema>;

export interface ResidentProvisioningAdapter {
  createOwnedCandidate(input: ResidentOwnedSessionCreateInput): Promise<ResidentOwnedRuntimeCandidate>;
  /** Exact-binding, read-only recovery. It must not persist or publish by itself. */
  readStableResidentProjection(binding: ResidentSessionBinding): Promise<ResidentProjectionSnapshot>;
  /** Root kill accepts no binding or upstream identity outside this opaque Store authority. */
  endResidentSession?(lease: ResidentKillLease): Promise<ResidentEndAcknowledgement>;
}

type ResidentProvisioningStore = Pick<
  HostStore,
  | "resolveWorkspaceDirectory"
  | "getResidentLifecycleStatus"
  | "prepareResidentProvision"
  | "beginResidentOwnedCreate"
  | "observeResidentOwnedCandidate"
  | "failResidentOwnedCreateBeforeEffect"
  | "beginResidentPromotion"
  | "failResidentPromotionBeforeEffect"
  | "observeResidentPromotion"
  | "acquireResidentProvisionRecoveryLease"
  | "publishResidentLifecycleProjection"
  | "commitResidentProvision"
  | "prepareResidentEnd"
  | "getResidentEndBinding"
  | "beginResidentKill"
  | "failResidentKillBeforeEffect"
  | "acknowledgeResidentKill"
  | "completeAcknowledgedResidentEnd"
  | "quarantineResidentLifecycleOutcomeUnknown"
>;

export interface ResidentLifecycleCoordinatorOptions {
  readonly store: ResidentProvisioningStore;
  readonly adapter: () => Promise<ResidentProvisioningAdapter>;
  /** Called only after the exact binding and projection are durably committed. */
  readonly onCommitted?: (binding: ResidentSessionBinding) => void | Promise<void>;
  /** Called immediately after durable command-authority revocation. */
  readonly onEnding?: (binding: ResidentSessionBinding) => void | Promise<void>;
  /** Advisory refresh emitted only after exact terminal public materialization. */
  readonly onEnded?: (binding: ResidentSessionBinding) => void | Promise<void>;
}

interface NormalizedResidentProvisionRequest {
  readonly input: ResidentLifecycleOperationInput;
  readonly createInput: ResidentOwnedSessionCreateInput;
  readonly requestFingerprint: string;
}

interface ResidentProvisionJob {
  readonly requestFingerprint: string;
  readonly promise: Promise<ResidentLifecycleStatus>;
}

interface HeldResidentCandidate {
  readonly requestFingerprint: string;
  readonly candidate: ResidentOwnedRuntimeCandidate;
}

/**
 * Host-only composition of the durable lifecycle WAL and Prime's client-owned
 * escrow capability. External mutation authority never lives in the Store,
 * while private workspace/session paths never enter the returned status DTO.
 */
export class ResidentLifecycleCoordinator {
  private readonly store: ResidentProvisioningStore;
  private readonly adapter: () => Promise<ResidentProvisioningAdapter>;
  private readonly onCommitted: (binding: ResidentSessionBinding) => void | Promise<void>;
  private readonly onEnding: (binding: ResidentSessionBinding) => void | Promise<void>;
  private readonly onEnded: (binding: ResidentSessionBinding) => void | Promise<void>;
  private readonly jobs = new Map<string, ResidentProvisionJob>();
  private readonly endJobs = new Map<string, ResidentProvisionJob>();
  private readonly candidates = new Map<string, HeldResidentCandidate>();
  private closeRequested = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: ResidentLifecycleCoordinatorOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.onCommitted = options.onCommitted ?? (() => undefined);
    this.onEnding = options.onEnding ?? (() => undefined);
    this.onEnded = options.onEnded ?? (() => undefined);
  }

  async provision(requestValue: ResidentProvisionRequest): Promise<ResidentLifecycleStatus> {
    if (this.closeRequested) return Promise.reject(coordinatorClosed());
    const request = ResidentProvisionRequestSchema.parse(requestValue);
    const normalized = await this.normalizeRequest(request);
    // Close may cross the private workspace lookup, but no durable or external
    // mutation is admitted after its terminal fence.
    if (this.closeRequested) return Promise.reject(coordinatorClosed());
    const existing = this.jobs.get(normalized.input.operationId);
    if (existing) {
      if (existing.requestFingerprint !== normalized.requestFingerprint) {
        throw new ResidentProvisionCoordinatorError(
          "RESIDENT_PROVISION_OPERATION_ID_REUSED",
          "This resident provisioning operation is already bound to a different exact request.",
        );
      }
      return existing.promise;
    }

    const promise = this.run(normalized);
    const job = Object.freeze({
      requestFingerprint: normalized.requestFingerprint,
      promise,
    });
    this.jobs.set(normalized.input.operationId, job);
    promise.then(
      () => this.finishJob(normalized.input.operationId, job),
      () => this.finishJob(normalized.input.operationId, job),
    );
    return promise;
  }

  async end(requestValue: ResidentEndRequest): Promise<ResidentLifecycleStatus> {
    if (this.closeRequested) return Promise.reject(coordinatorClosed());
    const request = ResidentEndRequestSchema.parse(requestValue);
    const input = ResidentEndLifecycleOperationInputSchema.parse({
      ...request,
      requestDigest: residentEndRequestDigest(request),
    });
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify({ operation: "resident.end", input }))
      .digest("hex");
    const existing = this.endJobs.get(input.operationId);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new ResidentProvisionCoordinatorError(
          "RESIDENT_END_OPERATION_ID_REUSED",
          "This resident end operation is already bound to a different exact request.",
        );
      }
      return existing.promise;
    }

    const promise = this.runEnd(input);
    const job = Object.freeze({ requestFingerprint, promise });
    this.endJobs.set(input.operationId, job);
    promise.then(
      () => this.finishEndJob(input.operationId, job),
      () => this.finishEndJob(input.operationId, job),
    );
    return promise;
  }

  close(): Promise<void> {
    this.closeRequested = true;
    this.closePromise ??= (async () => {
      await Promise.allSettled([
        ...[...this.jobs.values()].map((job) => job.promise),
        ...[...this.endJobs.values()].map((job) => job.promise),
      ]);
      await Promise.allSettled(
        [...this.candidates.keys()].map((operationId) => this.releaseHeldCandidate(operationId)),
      );
    })();
    return this.closePromise;
  }

  private finishJob(operationId: string, job: ResidentProvisionJob): void {
    if (this.jobs.get(operationId) === job) this.jobs.delete(operationId);
  }

  private finishEndJob(operationId: string, job: ResidentProvisionJob): void {
    if (this.endJobs.get(operationId) === job) this.endJobs.delete(operationId);
  }

  private async runEnd(input: ResidentEndLifecycleOperationInput): Promise<ResidentLifecycleStatus> {
    // This is intentionally the first await: Store resolves the exact active
    // binding and persists `ending` atomically. A reconnecting status request
    // queued afterward can therefore never observe null while this call later
    // gains mutation authority.
    let status = await this.store.prepareResidentEnd(input);
    const binding = await this.store.getResidentEndBinding(input);
    await Promise.resolve(this.onEnding(binding)).catch(() => undefined);
    if (status.phase === "kill_acknowledged") {
      const completed = await this.store.completeAcknowledgedResidentEnd(input);
      await Promise.resolve(this.onEnded(binding)).catch(() => undefined);
      return completed;
    }
    if (status.phase === "completed") {
      await Promise.resolve(this.onEnded(binding)).catch(() => undefined);
      return status;
    }
    if (isTerminalEndStatus(status) || status.phase === "kill_dispatching") return status;
    if (status.phase !== "ending" || this.closeRequested) return status;

    let adapter: ResidentProvisioningAdapter;
    try {
      adapter = await this.adapter();
    } catch {
      return status;
    }
    if (this.closeRequested || typeof adapter.endResidentSession !== "function") return status;

    // Issuance is process-local only; durable state remains `ending` throughout
    // daemon/list preflight. The adapter's final Store authorizer creates
    // `kill_dispatching` immediately before invoking root kill.
    const lease = await this.store.beginResidentKill(input);
    if (this.closeRequested) return this.store.failResidentKillBeforeEffect(lease);
    if (typeof adapter.endResidentSession !== "function") {
      return this.store.failResidentKillBeforeEffect(lease);
    }

    let acknowledgement: ResidentEndAcknowledgement;
    try {
      const acknowledgementValue = await adapter.endResidentSession(lease);
      const parsed = ResidentEndAcknowledgementSchema.safeParse(acknowledgementValue);
      if (
        !parsed.success ||
        parsed.data.activeSessionId !== lease.binding.activeSessionId ||
        parsed.data.sessionId !== lease.binding.sessionId
      ) {
        return this.store.quarantineResidentLifecycleOutcomeUnknown(lease);
      }
      acknowledgement = parsed.data;
    } catch (error) {
      return isDefinitiveRuntimeFailureBeforeEffect(error)
        ? this.store.failResidentKillBeforeEffect(lease)
        : this.store.quarantineResidentLifecycleOutcomeUnknown(lease);
    }

    // Once the adapter resolves, close must still drain this acknowledgement.
    // If Store settlement itself is interrupted, quarantine only if the exact
    // dispatch boundary remains; otherwise return the already-durable state.
    try {
      const completed = await this.store.acknowledgeResidentKill(lease, acknowledgement);
      await Promise.resolve(this.onEnded(binding)).catch(() => undefined);
      return completed;
    } catch (error) {
      try {
        return await this.store.quarantineResidentLifecycleOutcomeUnknown(lease);
      } catch {
        return this.currentStatusOrThrow(input.operationId, error);
      }
    }
  }

  private async normalizeRequest(
    request: ResidentProvisionRequest,
  ): Promise<NormalizedResidentProvisionRequest> {
    // This is the only source of the create cwd. It re-resolves the exact,
    // current Store authority for every call and accepts no caller path.
    const workspaceDirectory = await this.store.resolveWorkspaceDirectory(
      request.threadId,
      request.executionGenerationId,
    );
    const createInput = validateResidentOwnedSessionCreateInput(
      request.selection.kind === "new"
        ? {
            threadId: request.threadId,
            executionGenerationId: request.executionGenerationId,
            workspaceDirectory,
            session: { kind: "new" },
            ...(request.selection.sessionName === undefined
              ? {}
              : { sessionName: request.selection.sessionName }),
          }
        : {
            threadId: request.threadId,
            executionGenerationId: request.executionGenerationId,
            workspaceDirectory,
            session: { kind: "resume", sessionPath: request.selection.sessionPath },
          },
    );
    const normalizedSelection = provisionSelectionFromCreateInput(createInput);
    const requestDigest = residentProvisionRequestDigest(request, normalizedSelection);
    const input = ResidentLifecycleOperationInputSchema.parse({
      operationId: request.operationId,
      expectedHostId: request.expectedHostId,
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      executionGenerationId: request.executionGenerationId,
      requestDigest,
    });
    return Object.freeze({
      input,
      createInput,
      requestFingerprint: createHash("sha256")
        .update(JSON.stringify({ input, selection: normalizedSelection }))
        .digest("hex"),
    });
  }

  private async run(request: NormalizedResidentProvisionRequest): Promise<ResidentLifecycleStatus> {
    let status = await this.store.prepareResidentProvision(request.input);
    if (isTerminalProvisionStatus(status)) {
      await this.releaseHeldCandidate(request.input.operationId);
      return status;
    }
    if (this.closeRequested) return status;

    if (status.phase === "prepared") {
      // Preparation freezes the Store authority against later workspace
      // changes. Re-resolve beneath that durable fence so a pre-prepare TOCTOU
      // cannot send create to a formerly authorized directory.
      const createInput = await this.refreshAuthorizedCreateInput(request.createInput);
      if (this.closeRequested) return status;
      status = await this.createOwnedCandidate(Object.freeze({ ...request, createInput }));
    }
    if (isTerminalProvisionStatus(status) || status.phase === "owned_create_dispatching") {
      return status;
    }

    let held = this.candidates.get(request.input.operationId);
    if (held && held.requestFingerprint !== request.requestFingerprint) {
      throw new ResidentProvisionCoordinatorError(
        "RESIDENT_PROVISION_OPERATION_ID_REUSED",
        "This resident provisioning operation is already bound to a different exact request.",
      );
    }

    if (status.phase === "owned_observed") {
      if (!held) return status;
      if (this.closeRequested) {
        await this.releaseHeldCandidate(request.input.operationId);
        return status;
      }
      status = await this.promoteOwnedCandidate(request.input, held.candidate);
    }
    if (isTerminalProvisionStatus(status) || status.phase === "promotion_dispatching") {
      return status;
    }

    held = this.candidates.get(request.input.operationId);
    if (!held && status.phase !== "promoted_observed" && status.phase !== "projection_committed") {
      // After restart no process-local escrow authority can be reconstructed.
      // Durable post-promotion state remains explicitly visible for a later
      // read-only recovery path; no create or promotion is replayed here.
      return status;
    }
    if (status.phase !== "promoted_observed" && status.phase !== "projection_committed") {
      return status;
    }
    if (this.closeRequested) {
      await this.releaseHeldCandidate(request.input.operationId);
      return status;
    }
    return this.publishCommitAndHandoff(request.input, held?.candidate, status);
  }

  private async refreshAuthorizedCreateInput(
    createInput: ResidentOwnedSessionCreateInput,
  ): Promise<ResidentOwnedSessionCreateInput> {
    const workspaceDirectory = await this.store.resolveWorkspaceDirectory(
      createInput.threadId,
      createInput.executionGenerationId,
    );
    return validateResidentOwnedSessionCreateInput(
      createInput.session.kind === "resume"
        ? { ...createInput, workspaceDirectory }
        : {
            threadId: createInput.threadId,
            executionGenerationId: createInput.executionGenerationId,
            workspaceDirectory,
            session: { kind: "new" },
            ...(createInput.sessionName === undefined ? {} : { sessionName: createInput.sessionName }),
          },
    );
  }

  private async createOwnedCandidate(
    request: NormalizedResidentProvisionRequest,
  ): Promise<ResidentLifecycleStatus> {
    const lease = await this.store.beginResidentOwnedCreate(request.input);
    if (this.closeRequested) {
      return this.store.failResidentOwnedCreateBeforeEffect(lease);
    }
    let candidate: ResidentOwnedRuntimeCandidate;
    let adapter: ResidentProvisioningAdapter;
    try {
      adapter = await this.adapter();
    } catch (error) {
      // Adapter acquisition cannot invoke Prime's create mutation.
      return this.store.failResidentOwnedCreateBeforeEffect(lease);
    }
    if (this.closeRequested) {
      return this.store.failResidentOwnedCreateBeforeEffect(lease);
    }
    try {
      candidate = await adapter.createOwnedCandidate(request.createInput);
    } catch (error) {
      // The concrete adapter normalizes every post-invocation failure to the
      // explicit unknown code. An unclassified exception violates that seam,
      // so conservatively quarantine instead of asserting no effect.
      return isDefinitiveRuntimeFailureBeforeEffect(error)
        ? this.store.failResidentOwnedCreateBeforeEffect(lease)
        : this.store.quarantineResidentLifecycleOutcomeUnknown(lease);
    }

    try {
      const status = await this.store.observeResidentOwnedCandidate(
        lease,
        residentOwnedCandidateForStore(candidate),
      );
      this.candidates.set(request.input.operationId, Object.freeze({
        requestFingerprint: request.requestFingerprint,
        candidate,
      }));
      return status;
    } catch (error) {
      // Prime v0.7's public owned dispose suppresses complete_owned_session's
      // response. Attempting it is useful cleanup but can never settle Store
      // completion. The create boundary is therefore always quarantined.
      await candidate.attemptUnverifiedOwnedCleanup().catch(() => undefined);
      return this.store.quarantineResidentLifecycleOutcomeUnknown(lease);
    }
  }

  private async promoteOwnedCandidate(
    input: ResidentLifecycleOperationInput,
    candidate: ResidentOwnedRuntimeCandidate,
  ): Promise<ResidentLifecycleStatus> {
    const lease = await this.store.beginResidentPromotion(input);
    if (this.closeRequested) {
      const status = await this.store.failResidentPromotionBeforeEffect(lease);
      await this.releaseHeldCandidate(input.operationId);
      return status;
    }
    try {
      await candidate.promoteToResident();
    } catch (error) {
      if (isDefinitiveRuntimeFailureBeforeEffect(error)) {
        return this.store.failResidentPromotionBeforeEffect(lease);
      }
      const status = await this.store.quarantineResidentLifecycleOutcomeUnknown(lease);
      await this.releaseHeldCandidate(input.operationId);
      return status;
    }

    try {
      await this.store.observeResidentPromotion(lease);
    } catch (error) {
      const status = await this.store.quarantineResidentLifecycleOutcomeUnknown(lease);
      await this.releaseHeldCandidate(input.operationId);
      return status;
    }
    const status = await this.store.getResidentLifecycleStatus(input.operationId);
    if (!status) {
      throw new ResidentProvisionCoordinatorError(
        "RESIDENT_PROVISION_STATUS_MISSING",
        "The promoted resident provisioning status is unavailable.",
        true,
      );
    }
    return status;
  }

  private async publishCommitAndHandoff(
    input: ResidentLifecycleOperationInput,
    candidate: ResidentOwnedRuntimeCandidate | undefined,
    status: ResidentLifecycleStatus,
  ): Promise<ResidentLifecycleStatus> {
    let lease: ResidentLifecycleProjectionLease;
    try {
      lease = await this.store.acquireResidentProvisionRecoveryLease(input);
      if (this.closeRequested) return status;
      if (status.phase === "promoted_observed") {
        if (candidate) {
          await candidate.publishStableProjection(async (_binding, projection) => {
            if (this.closeRequested) throw coordinatorClosed();
            await this.store.publishResidentLifecycleProjection(lease, projection);
          });
        } else {
          const adapter = await this.adapter();
          if (this.closeRequested) return status;
          const projection = await adapter.readStableResidentProjection(lease.binding);
          if (this.closeRequested) return status;
          await this.store.publishResidentLifecycleProjection(lease, projection);
        }
      }
    } catch (error) {
      return this.currentStatusOrThrow(input.operationId, error);
    }
    if (this.closeRequested) {
      return this.currentStatusOrThrow(input.operationId, coordinatorClosed());
    }

    let binding: ResidentSessionBinding;
    try {
      binding = await this.store.commitResidentProvision(lease);
    } catch (error) {
      return this.currentStatusOrThrow(input.operationId, error);
    }

    await this.releaseHeldCandidate(input.operationId);
    // A readiness handoff is advisory after durable commit. A later health
    // poll discovers the same exact active binding if this callback fails.
    if (!this.closeRequested) {
      await Promise.resolve(this.onCommitted(binding)).catch(() => undefined);
    }
    const committed = await this.store.getResidentLifecycleStatus(input.operationId);
    if (!committed) {
      throw new ResidentProvisionCoordinatorError(
        "RESIDENT_PROVISION_STATUS_MISSING",
        "The committed resident provisioning status is unavailable.",
        true,
      );
    }
    return committed;
  }

  private async currentStatusOrThrow(
    operationId: string,
    cause: unknown,
  ): Promise<ResidentLifecycleStatus> {
    const status = await this.store.getResidentLifecycleStatus(operationId).catch(() => undefined);
    if (status) return status;
    throw cause;
  }

  private async releaseHeldCandidate(operationId: string): Promise<void> {
    const held = this.candidates.get(operationId);
    if (!held) return;
    this.candidates.delete(operationId);
    await held.candidate.dispose().catch(() => undefined);
  }
}

export class ResidentProvisionCoordinatorError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResidentProvisionCoordinatorError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Stable digest of caller-visible provisioning semantics; private cwd is Store-bound separately. */
export function residentProvisionRequestDigest(
  request: Omit<ResidentProvisionRequest, "selection">,
  selection: ResidentProvisionSelection,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      requestVersion: 1,
      operation: "resident.provision",
      expectedHostId: request.expectedHostId,
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      executionGenerationId: request.executionGenerationId,
      selection,
    }))
    .digest("hex");
}

/** Stable path-free digest of the exact public resident-end authority. */
export function residentEndRequestDigest(request: ResidentEndRequest): string {
  return createHash("sha256")
    .update(JSON.stringify({
      requestVersion: 1,
      operation: "resident.end",
      expectedHostId: request.expectedHostId,
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      executionGenerationId: request.executionGenerationId,
      expectedSourceCursor: request.expectedSourceCursor,
    }))
    .digest("hex");
}

function provisionSelectionFromCreateInput(
  input: ResidentOwnedSessionCreateInput,
): ResidentProvisionSelection {
  return input.session.kind === "resume"
    ? Object.freeze({ kind: "resume" as const, sessionPath: input.session.sessionPath })
    : Object.freeze({
        kind: "new" as const,
        ...(input.sessionName === undefined ? {} : { sessionName: input.sessionName }),
      });
}

function residentOwnedCandidateForStore(
  candidate: ResidentOwnedRuntimeCandidate,
): ResidentOwnedSessionCandidate {
  return Object.freeze({
    candidateVersion: candidate.candidateVersion,
    workspaceDirectory: candidate.workspaceDirectory,
    activeSessionId: candidate.activeSessionId,
    sessionId: candidate.sessionId,
    ...(candidate.sessionFile === undefined ? {} : { sessionFile: candidate.sessionFile }),
    boundAt: candidate.boundAt,
    runtime: {
      ...candidate.runtime,
      capabilities: [...candidate.runtime.capabilities],
    },
  });
}

function isDefinitiveRuntimeFailureBeforeEffect(error: unknown): boolean {
  return error instanceof ResidentRuntimeContractError &&
    error.code !== "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN";
}

function isTerminalProvisionStatus(status: ResidentLifecycleStatus): boolean {
  return status.phase === "committed" || status.phase === "completed" || status.phase === "quarantined";
}

function isTerminalEndStatus(status: ResidentLifecycleStatus): boolean {
  return status.phase === "completed" || status.phase === "quarantined";
}

function coordinatorClosed(): ResidentProvisionCoordinatorError {
  return new ResidentProvisionCoordinatorError(
    "RESIDENT_PROVISION_COORDINATOR_CLOSED",
    "The resident provisioning coordinator is closed.",
  );
}
