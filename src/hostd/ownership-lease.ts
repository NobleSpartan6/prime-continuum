import { randomBytes } from "node:crypto";
import { AtomicWriteAmbiguousCommitError } from "./atomic-files";

const OWNERSHIP_GENERATION_PATTERN = /^[a-f0-9]{64}$/;

export interface HostOwnershipLease {
  readonly signal: AbortSignal;
  readonly generation: string;
  assertActive(): Promise<void>;
  withPublicationPermit<T>(publish: () => Promise<T>): Promise<T>;
  poisonPublication(reason: Error): void;
}

export class HostOwnershipLeaseError extends Error {
  readonly code: string;
  readonly generation: string;

  constructor(code: string, generation: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostOwnershipLeaseError";
    this.code = code;
    this.generation = generation;
  }
}

export class HostOwnershipPublicationAmbiguousError extends HostOwnershipLeaseError {
  constructor(generation: string, cause: unknown) {
    super(
      "HOST_OWNERSHIP_PUBLICATION_UNCERTAIN",
      generation,
      "A publication became visible but endpoint ownership could not be confirmed afterward",
      { cause },
    );
    this.name = "HostOwnershipPublicationAmbiguousError";
  }
}

export interface HostOwnershipLeaseController {
  readonly lease: HostOwnershipLease;
  /** Checks physical endpoint ownership without consulting runtime publication poison. */
  assertOwned(): Promise<void>;
  closeAdmission(reason?: Error): void;
  drain(): Promise<void>;
  markReleased(): void;
}

export function createHostOwnershipLease(
  assertUnderlyingOwned: () => Promise<void>,
  options: {
    generation?: string;
    onFatalLoss?: (error: HostOwnershipLeaseError) => void;
  } = {},
): HostOwnershipLeaseController {
  const generation = options.generation ?? randomBytes(32).toString("hex");
  if (!OWNERSHIP_GENERATION_PATTERN.test(generation)) {
    throw new TypeError("Host ownership generation must be one canonical 256-bit hexadecimal identity");
  }

  const abortController = new AbortController();
  let lifecycle: "active" | "closing" | "lost" | "released" = "active";
  let lifecycleError: HostOwnershipLeaseError | undefined;
  let publicationError: HostOwnershipLeaseError | undefined;
  let fatalLossNotified = false;
  let publicationActive = false;
  const drainWaiters = new Set<() => void>();

  const rejectForLifecycle = (): never => {
    if (lifecycleError) throw lifecycleError;
    throw new HostOwnershipLeaseError(
      "HOST_OWNERSHIP_INACTIVE",
      generation,
      "Endpoint ownership is not active",
    );
  };

  const requireLifecycleActive = (): void => {
    if (lifecycle !== "active") rejectForLifecycle();
  };

  const requirePublicationActive = (): void => {
    if (publicationError) throw publicationError;
    requireLifecycleActive();
  };

  const abortWith = (error: Error): void => {
    if (!abortController.signal.aborted) abortController.abort(error);
  };

  const poisonPublication = (reason: Error): void => {
    if (!(reason instanceof Error)) throw new TypeError("Publication poison requires an Error reason");
    if (lifecycle === "released") return;
    if (!publicationError) {
      publicationError = new HostOwnershipLeaseError(
        "HOST_OWNERSHIP_PUBLICATION_POISONED",
        generation,
        "Endpoint-owned publication is poisoned until a new ownership generation is acquired",
        { cause: reason },
      );
      abortWith(publicationError);
    }
  };

  const markFatalLoss = (error: HostOwnershipLeaseError): HostOwnershipLeaseError => {
    if (lifecycle !== "released" && lifecycle !== "lost") {
      lifecycle = "lost";
      lifecycleError = error;
      abortWith(error);
      if (!fatalLossNotified) {
        fatalLossNotified = true;
        try {
          options.onFatalLoss?.(error);
        } catch {
          // Fatal notification is advisory plumbing; ownership revocation has
          // already happened synchronously and cannot be rolled back.
        }
      }
    }
    return error;
  };

  const markOwnershipLost = (cause: unknown): HostOwnershipLeaseError => markFatalLoss(
    new HostOwnershipLeaseError(
      "HOST_OWNERSHIP_LOST",
      generation,
      "Endpoint ownership could not be confirmed",
      { cause },
    ),
  );

  const assertOwned = async (): Promise<void> => {
    requireLifecycleActive();
    try {
      await assertUnderlyingOwned();
    } catch (error) {
      throw markOwnershipLost(error);
    }
    requireLifecycleActive();
  };

  const assertActive = async (): Promise<void> => {
    requirePublicationActive();
    try {
      await assertUnderlyingOwned();
    } catch (error) {
      throw markOwnershipLost(error);
    }
    requirePublicationActive();
  };

  const finishPublication = (): void => {
    publicationActive = false;
    for (const resolvePromise of drainWaiters) resolvePromise();
    drainWaiters.clear();
  };

  const runPublication = async <T>(publish: () => Promise<T>): Promise<T> => {
    try {
      try {
        await assertUnderlyingOwned();
      } catch (error) {
        throw markOwnershipLost(error);
      }
      // Shutdown may have started while the underlying ownership assertion was
      // in flight. This is the final admission check before invoking the
      // callback, with no intervening await that could admit shutdown first.
      requirePublicationActive();

      let value: T | undefined;
      let callbackError: unknown;
      try {
        value = await publish();
      } catch (error) {
        callbackError = error;
      }

      let ownershipError: unknown;
      try {
        // An admitted publication is never cancelled mid-commit. The server
        // retains its listener and sidecar until this assertion and permit both
        // settle, even if shutdown has already closed new admission.
        await assertUnderlyingOwned();
      } catch (error) {
        ownershipError = error;
      }

      if (ownershipError !== undefined) {
        const cause = callbackError === undefined
          ? ownershipError
          : new AggregateError([callbackError, ownershipError], "Publication and ownership confirmation both failed");
        const ambiguous = new HostOwnershipPublicationAmbiguousError(generation, cause);
        markFatalLoss(ambiguous);
        throw ambiguous;
      }
      if (callbackError !== undefined) {
        if (callbackError instanceof AtomicWriteAmbiguousCommitError) poisonPublication(callbackError);
        throw callbackError;
      }
      if (lifecycle === "lost" || lifecycle === "released") rejectForLifecycle();
      if (publicationError) throw publicationError;
      return value as T;
    } finally {
      finishPublication();
    }
  };

  const lease: HostOwnershipLease = Object.freeze({
    signal: abortController.signal,
    generation,
    assertActive,
    withPublicationPermit<T>(publish: () => Promise<T>): Promise<T> {
      if (typeof publish !== "function") throw new TypeError("Publication permit requires one callback");
      requirePublicationActive();
      if (publicationActive) {
        throw new HostOwnershipLeaseError(
          "HOST_OWNERSHIP_PUBLICATION_BUSY",
          generation,
          "Another endpoint-owned publication is already active",
        );
      }
      // Reserving the single permit is synchronous, linearizing admission with
      // closeAdmission(), which also changes state synchronously.
      publicationActive = true;
      return runPublication(publish);
    },
    poisonPublication,
  });

  return {
    lease,
    assertOwned,
    closeAdmission(reason?: Error): void {
      if (lifecycle !== "active") return;
      lifecycle = "closing";
      lifecycleError = new HostOwnershipLeaseError(
        "HOST_OWNERSHIP_CLOSING",
        generation,
        "Endpoint ownership is closing and no longer admits publications",
        reason ? { cause: reason } : undefined,
      );
      abortWith(lifecycleError);
    },
    async drain(): Promise<void> {
      if (!publicationActive) return;
      await new Promise<void>((resolvePromise) => drainWaiters.add(resolvePromise));
    },
    markReleased(): void {
      if (publicationActive) {
        throw new HostOwnershipLeaseError(
          "HOST_OWNERSHIP_RELEASE_WITH_ACTIVE_PUBLICATION",
          generation,
          "Endpoint ownership cannot be released while a publication is active",
        );
      }
      lifecycle = "released";
      lifecycleError = new HostOwnershipLeaseError(
        "HOST_OWNERSHIP_RELEASED",
        generation,
        "Endpoint ownership has been released",
      );
      abortWith(lifecycleError);
    },
  };
}
