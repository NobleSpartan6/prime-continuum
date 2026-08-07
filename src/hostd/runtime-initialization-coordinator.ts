import { AtomicWriteAmbiguousCommitError } from "./atomic-files";
import {
  HostOwnershipLeaseError,
  HostOwnershipPublicationAmbiguousError,
  type HostOwnershipLease,
} from "./ownership-lease";
import type { HostDataPaths } from "./paths";
import type { EmbeddedRuntimeAttestationEnvelope } from "./runtime-attestation";
import {
  RuntimeIntegrityCancelledError,
  RuntimeIntegrityInstalledCorruptionError,
  RuntimeIntegrityManager,
  RuntimeIntegrityPublicationPoisonedError,
  RuntimeIntegrityRepairRequiredError,
  RuntimeIntegrityTransientVerificationError,
  type InstalledRuntimeIntegrityIdentity,
  type RuntimeIntegrityManagerOptions,
  type RuntimeIntegrityProgressPhase,
} from "./runtime-integrity-manager";
import {
  RuntimeIntegritySnapshotSchema,
  type RuntimeIntegritySnapshot,
  type RuntimeIntegrityTarget,
} from "../shared/protocol";

const MAX_RUNTIME_INITIALIZATION_ATTEMPTS = 32;
const MAX_AUTOMATIC_RUNTIME_INITIALIZATION_ATTEMPTS = 2;

export interface RuntimeIntegrityInstaller {
  ensureInstalled(seedRoot?: string): Promise<InstalledRuntimeIntegrityIdentity>;
}

export type RuntimeIntegrityManagerFactory = (
  options: RuntimeIntegrityManagerOptions,
) => RuntimeIntegrityInstaller;

export interface RuntimeInitializationCoordinatorOptions {
  readonly paths: HostDataPaths;
  readonly envelope: EmbeddedRuntimeAttestationEnvelope;
  readonly managerFactory?: RuntimeIntegrityManagerFactory;
  readonly schedule?: (work: () => void) => void;
  readonly now?: () => Date;
  /** Private process-local diagnostics; never included in the public readiness snapshot. */
  readonly onFailure?: (error: unknown) => void;
}

/**
 * Owns one endpoint-generation's nonblocking integrity preparation.
 *
 * Construction and `start()` perform no filesystem work. Heavy verification
 * begins on the next event-loop turn after core host initialization has made a
 * bounded health snapshot available. Every state update is fenced by both the
 * endpoint generation and the monotonically increasing attempt identity.
 */
export class RuntimeInitializationCoordinator {
  private readonly paths: HostDataPaths;
  private readonly envelope: EmbeddedRuntimeAttestationEnvelope;
  private readonly target: RuntimeIntegrityTarget;
  private readonly managerFactory: RuntimeIntegrityManagerFactory;
  private readonly schedule: (work: () => void) => void;
  private readonly now: () => Date;
  private readonly onFailure?: (error: unknown) => void;
  private currentSnapshot: RuntimeIntegritySnapshot;
  private lease: HostOwnershipLease | undefined;
  private seedRoot: string | undefined;
  private manager: RuntimeIntegrityInstaller | undefined;
  private activeAttempt: Promise<void> | undefined;
  private attempt = 0;
  private started = false;
  private closed = false;

  constructor(options: RuntimeInitializationCoordinatorOptions) {
    this.paths = options.paths;
    this.envelope = options.envelope;
    this.managerFactory = options.managerFactory ?? ((managerOptions) => new RuntimeIntegrityManager(managerOptions));
    this.schedule = options.schedule ?? ((work) => setImmediate(work));
    this.now = options.now ?? (() => new Date());
    this.onFailure = options.onFailure;
    this.target = Object.freeze({
      runtime: "prime-agent",
      releaseVersion: options.envelope.attestation.runtime.releaseVersion,
      runtimeBuildId: options.envelope.attestation.runtime.runtimeBuildId,
      platform: options.envelope.attestation.runtime.platform,
      arch: options.envelope.attestation.runtime.arch,
      manifestSha256: options.envelope.attestation.manifest.sha256,
      treeSha256: options.envelope.attestation.tree.sha256,
      filesSha256: options.envelope.attestation.tree.filesSha256,
    });
    this.currentSnapshot = this.parseSnapshot({
      ...this.baseSnapshot(),
      status: "unavailable",
      code: "RUNTIME_INITIALIZATION_NOT_STARTED",
      retryable: true,
      recoveryAction: "restart_host_service",
    });
  }

  snapshot(): RuntimeIntegritySnapshot {
    return this.currentSnapshot;
  }

  /** Starts exactly one immutable seed/ownership generation without awaiting it. */
  start(lease: HostOwnershipLease, seedRoot?: string): boolean {
    if (this.closed) throw new Error("Runtime initialization coordinator is closed");
    if (this.started) return false;
    this.started = true;
    this.lease = lease;
    this.seedRoot = seedRoot;
    this.beginAttempt();
    return true;
  }

  /** Retries only a retryable, settled failure within the same ownership generation. */
  retry(): boolean {
    if (
      this.closed ||
      !this.started ||
      this.activeAttempt !== undefined ||
      this.currentSnapshot.status !== "failed" ||
      !this.currentSnapshot.retryable ||
      !this.lease ||
      this.lease.signal.aborted ||
      this.attempt >= MAX_RUNTIME_INITIALIZATION_ATTEMPTS
    ) {
      return false;
    }
    this.beginAttempt();
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.activeAttempt;
  }

  private beginAttempt(): void {
    const lease = this.lease;
    if (!lease) throw new Error("Runtime initialization requires an endpoint ownership lease");
    const attempt = ++this.attempt;
    const generation = lease.generation;
    this.currentSnapshot = this.parseSnapshot({
      ...this.baseSnapshot(),
      status: "initializing",
      phase: "preparing",
      attempt,
    });

    const scheduled = new Promise<void>((resolvePromise) => this.schedule(resolvePromise));
    const work = scheduled.then(() => this.runAttempt(lease, generation, attempt));
    this.activeAttempt = work;
    const clearAttempt = (): void => {
      if (this.activeAttempt === work) this.activeAttempt = undefined;
    };
    void work.then(clearAttempt, clearAttempt);
  }

  private async runAttempt(
    lease: HostOwnershipLease,
    generation: string,
    attempt: number,
  ): Promise<void> {
    if (!this.isCurrent(lease, generation, attempt)) return;
    try {
      this.manager ??= this.managerFactory({
        paths: this.paths,
        attestation: this.envelope.attestation,
        ownershipLease: lease,
        onProgress: (phase) => {
          const currentLease = this.lease;
          if (!currentLease) return;
          this.recordProgress(currentLease, currentLease.generation, this.attempt, phase);
        },
      });
      const identity = await this.manager.ensureInstalled(this.seedRoot);
      // The manager verifies again before returning, but this final assertion
      // closes the coordinator's own success window and lets a physical
      // endpoint/sidecar loss trigger the server-fatal ownership path before
      // health can transition to ready.
      await lease.assertActive();
      if (!this.isCurrent(lease, generation, attempt)) return;
      assertIdentityMatchesTarget(identity, this.target);
      this.currentSnapshot = this.parseSnapshot({
        ...this.baseSnapshot(),
        status: "ready",
        assurance: this.envelope.attestation.assurance,
      });
    } catch (error) {
      if (!this.isCurrent(lease, generation, attempt)) return;
      try {
        this.onFailure?.(error);
      } catch {
        // Diagnostics must never alter readiness or retry classification.
      }
      const failure = classifyInitializationFailure(error);
      if (
        error instanceof RuntimeIntegrityTransientVerificationError &&
        attempt < MAX_AUTOMATIC_RUNTIME_INITIALIZATION_ATTEMPTS &&
        !this.closed &&
        !lease.signal.aborted
      ) {
        // Only the manager's closed, typed transient class gets one automatic
        // retry. Unknown errors and semantic corruption fail the first attempt.
        // The retry still executes every digest, namespace, and ownership check.
        this.beginAttempt();
        return;
      }
      this.currentSnapshot = this.parseSnapshot({
        ...this.baseSnapshot(),
        status: "failed",
        ...failure,
      });
    }
  }

  private recordProgress(
    lease: HostOwnershipLease,
    generation: string,
    attempt: number,
    phase: RuntimeIntegrityProgressPhase,
  ): void {
    if (!this.isCurrent(lease, generation, attempt)) return;
    if (
      this.currentSnapshot.status === "initializing" &&
      this.currentSnapshot.phase === phase
    ) {
      return;
    }
    this.currentSnapshot = this.parseSnapshot({
      ...this.baseSnapshot(),
      status: "initializing",
      phase,
      attempt,
    });
  }

  private isCurrent(lease: HostOwnershipLease, generation: string, attempt: number): boolean {
    return (
      !this.closed &&
      this.lease === lease &&
      lease.generation === generation &&
      this.attempt === attempt
    );
  }

  private baseSnapshot(): Pick<RuntimeIntegritySnapshot, "contractVersion" | "changedAt" | "trustAnchorId" | "target"> {
    return {
      contractVersion: 1,
      changedAt: this.now().toISOString(),
      trustAnchorId: this.envelope.trustAnchorId,
      target: this.target,
    };
  }

  private parseSnapshot(value: unknown): RuntimeIntegritySnapshot {
    return deepFreeze(RuntimeIntegritySnapshotSchema.parse(value));
  }
}

function assertIdentityMatchesTarget(
  identity: InstalledRuntimeIntegrityIdentity,
  target: RuntimeIntegrityTarget,
): void {
  if (
    identity.runtime !== target.runtime ||
    identity.releaseVersion !== target.releaseVersion ||
    identity.runtimeBuildId !== target.runtimeBuildId ||
    identity.platform !== target.platform ||
    identity.arch !== target.arch ||
    identity.manifestSha256 !== target.manifestSha256 ||
    identity.treeSha256 !== target.treeSha256 ||
    identity.filesSha256 !== target.filesSha256
  ) {
    throw new Error("Verified runtime identity did not match the embedded target");
  }
}

function classifyInitializationFailure(error: unknown): {
  code: string;
  retryable: boolean;
  recoveryAction: string;
} {
  if (error instanceof RuntimeIntegrityInstalledCorruptionError) {
    return {
      code: "RUNTIME_INSTALLED_CORRUPTION",
      retryable: false,
      recoveryAction: "repair_application",
    };
  }
  if (error instanceof RuntimeIntegrityTransientVerificationError) {
    return {
      code: "RUNTIME_TRANSIENT_VERIFICATION",
      retryable: true,
      recoveryAction: "restart_host_service",
    };
  }
  if (error instanceof RuntimeIntegrityRepairRequiredError) {
    return {
      code: "RUNTIME_REPAIR_REQUIRED",
      retryable: false,
      recoveryAction: "repair_application",
    };
  }
  if (
    error instanceof RuntimeIntegrityPublicationPoisonedError ||
    error instanceof HostOwnershipPublicationAmbiguousError ||
    error instanceof AtomicWriteAmbiguousCommitError ||
    (error instanceof HostOwnershipLeaseError && error.code === "HOST_OWNERSHIP_PUBLICATION_POISONED")
  ) {
    return {
      code: "RUNTIME_PUBLICATION_UNCERTAIN",
      retryable: false,
      recoveryAction: "restart_host_service",
    };
  }
  if (error instanceof RuntimeIntegrityCancelledError || error instanceof HostOwnershipLeaseError) {
    return {
      code: "RUNTIME_OWNERSHIP_INTERRUPTED",
      retryable: false,
      recoveryAction: "restart_host_service",
    };
  }
  if (
    error instanceof Error &&
    !errorChainHasCode(error) &&
    /host runtime|different runtime image|identity did not match/i.test(error.message)
  ) {
    return {
      code: "RUNTIME_IDENTITY_MISMATCH",
      retryable: false,
      recoveryAction: "repair_application",
    };
  }
  return {
    code: "RUNTIME_INTEGRITY_FAILED",
    retryable: true,
    // No production IPC/UI surface invokes retry() yet. Keep the public action
    // honest until that control exists; a fresh host-service generation is the
    // currently available retry boundary.
    recoveryAction: "restart_host_service",
  };
}

function errorChainHasCode(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && typeof current.code === "string" && current.code.length > 0) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
