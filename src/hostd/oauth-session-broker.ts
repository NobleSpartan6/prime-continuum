import { randomUUID } from "node:crypto";
import {
  createRuntimeOAuthAttemptTerminalV1,
  parseRuntimeOAuthAttemptV1,
  type RuntimeOAuthAttemptTerminalPhase,
  type RuntimeOAuthAttemptTerminalResolution,
  type RuntimeOAuthAttemptTerminalV1,
  type RuntimeOAuthAttemptV1,
} from "../shared/runtime-oauth-attempt";
import {
  OAUTH_ATTEMPT_MAX_FILES,
  OAuthAttemptStore,
  OAuthAttemptStoreError,
  isOAuthAttemptBarrier,
  type OAuthAttemptCancelIntent,
  type OAuthAttemptRecord,
  type OAuthAttemptRecoveryReason,
} from "./oauth-attempt-store";

/**
 * Prime Agent v0.7.2 integration boundary:
 *
 * - Public OAuth providers expose one in-process `login(callbacks)` promise,
 *   not a durable or resumable flow.
 * - OpenAI Codex and Anthropic ignore AbortSignal, so the host must retain that
 *   promise and fence credential persistence after cancellation.
 * - Prime Inference browser/team login is not in the public OAuth registry and
 *   cannot be represented by this adapter contract.
 *
 * A verified-runtime adapter can implement the two ports below without
 * widening them. Renderer and remote protocol wiring is intentionally absent.
 */
const DEFAULT_ACTIVE_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_TOMBSTONE_TTL_MS = 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 64;
const MAX_CHALLENGES_PER_SESSION = 32;
const MAX_AUTHORIZATION_URL_LENGTH = 8_192;
const MAX_RESPONSE_LENGTH = 8_192;
const MAX_MESSAGE_LENGTH = 2_048;
const MAX_PROGRESS_LENGTH = 1_024;
const MAX_OPTIONS = 64;
const MAX_CREDENTIAL_FIELDS = 32;
const MAX_CREDENTIAL_SECRET_LENGTH = 1024 * 1024;
const MAX_CREDENTIAL_METADATA_LENGTH = 8_192;

type Awaitable<T> = T | Promise<T>;

export interface OAuthCredentials {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly [key: string]: unknown;
}

export interface OAuthLoginCallbacks {
  readonly onAuth: (info: { readonly url: string; readonly instructions?: string }) => void;
  readonly onPrompt: (prompt: {
    readonly message: string;
    readonly placeholder?: string;
    readonly allowEmpty?: boolean;
  }) => Promise<string>;
  readonly onProgress?: (message: string) => void;
  readonly onManualCodeInput?: () => Promise<string>;
  readonly onSelect?: (prompt: {
    readonly message: string;
    readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  }) => Promise<string | undefined>;
  readonly signal?: AbortSignal;
}

/** The exact public shape consumed from a verified Prime Agent OAuth provider. */
export interface HostOAuthProvider {
  readonly id: string;
  readonly name: string;
  readonly usesCallbackServer?: boolean;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
}

export interface HostOAuthProviderPort {
  getProvider(providerId: string): HostOAuthProvider | undefined;
}

export interface HostOAuthStorage {
  set(providerId: string, auth: { readonly type: "oauth"; readonly [key: string]: unknown }): Awaitable<void>;
  drainErrors(): Awaitable<readonly unknown[]>;
  reload(): Awaitable<void>;
  getAuthStatus(providerId: string): Awaitable<{ readonly configured: unknown }>;
}

/** Concrete host compositions may own helper processes in addition to both ports. */
export interface HostOAuthComposition extends HostOAuthProviderPort, HostOAuthStorage {
  initialize?(): Promise<void>;
  close?(): Promise<void>;
}

export type OAuthSessionPhase =
  | "starting"
  | "awaiting_user"
  | "committing"
  | "completed"
  | "cancelled"
  | "failed";

export type OAuthChallenge =
  | {
      readonly id: string;
      readonly kind: "text";
      readonly message: string;
      readonly placeholder?: string;
      readonly allowEmpty: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "manual_redirect";
      readonly message: string;
      readonly allowEmpty: false;
    }
  | {
      readonly id: string;
      readonly kind: "select";
      readonly message: string;
      readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    };

export interface OAuthSessionSnapshot {
  readonly sessionId: string;
  readonly providerId: string;
  readonly phase: OAuthSessionPhase;
  readonly expiresAt: string;
  readonly authorization?: {
    readonly url: string;
    readonly instructions?: string;
  };
  readonly challenge?: OAuthChallenge;
  readonly progress?: string;
  readonly configured?: true;
  readonly error?: {
    readonly code:
      | "OAUTH_SESSION_EXPIRED"
      | "OAUTH_PROVIDER_CONTRACT_INVALID"
      | "OAUTH_PROVIDER_FAILED"
      | "OAUTH_PERSISTENCE_UNCONFIRMED";
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type OAuthBrokerErrorCode =
  | "HOST_AUTHORITY_MISMATCH"
  | "OAUTH_SESSION_NOT_FOUND"
  | "OAUTH_SESSION_FORBIDDEN"
  | "OAUTH_PROVIDER_NOT_FOUND"
  | "OAUTH_PROVIDER_BUSY"
  | "OAUTH_SESSION_LIMIT"
  | "OAUTH_CHALLENGE_STALE"
  | "OAUTH_RESPONSE_INVALID"
  | "OAUTH_ATTEMPT_NOT_FOUND"
  | "OAUTH_ATTEMPT_RECONCILE_REQUIRED"
  | "OAUTH_ATTEMPT_CONNECTION_SUPERSEDED"
  | "OAUTH_ATTEMPT_UNAVAILABLE"
  | "OAUTH_REQUEST_INVALID";

/** Contains only fixed, IPC-safe messages; never attach provider or storage causes. */
export class OAuthBrokerError extends Error {
  constructor(
    readonly code: OAuthBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OAuthBrokerError";
  }
}

export interface HostOAuthSessionBrokerOptions {
  readonly hostId: string;
  readonly providers: HostOAuthProviderPort;
  readonly storage: HostOAuthStorage;
  /** Initialized durable journal. Required only for the oauth.attempt.* API. */
  readonly attemptStore?: OAuthAttemptStore;
  readonly activeTtlMs?: number;
  readonly tombstoneTtlMs?: number;
  readonly maxSessions?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

interface AuthorityBinding {
  readonly expectedHostId: string;
  readonly authorityId: string;
}

export interface StartOAuthSessionRequest extends AuthorityBinding {
  readonly providerId: string;
  /** Stable across transport retries of one admitted start. */
  readonly operationId: string;
}

export interface ReadOAuthSessionRequest extends AuthorityBinding {
  readonly sessionId: string;
}

export interface RespondOAuthSessionRequest extends ReadOAuthSessionRequest {
  readonly challengeId: string;
  readonly value?: string;
}

export interface StartOAuthAttemptRequest {
  readonly authorityId: string;
  readonly attempt: RuntimeOAuthAttemptV1;
}

export interface ReadOAuthAttemptRequest {
  readonly attempt: RuntimeOAuthAttemptV1;
}

/** Host-internal framed-connection authority; never accepted from protocol bytes. */
export interface OAuthAttemptSessionAdmission {
  readonly generation: bigint;
  isInputOpen(): boolean;
}

export interface AcknowledgeOAuthAttemptRequest extends ReadOAuthAttemptRequest {
  readonly expectedRevision: number;
  readonly terminalDigest: string;
  readonly acknowledgedAt: string;
}

export interface OAuthAttemptStatusResult {
  readonly attemptDigest: string;
  readonly record: OAuthAttemptRecordProjection | null;
  readonly live?: OAuthSessionSnapshot;
}

export interface OAuthAttemptEffectResult extends OAuthAttemptStatusResult {
  readonly record: OAuthAttemptRecordProjection;
}

/** Exact public allowlist; host-only authority and recovery provenance stay private. */
export interface OAuthAttemptRecordProjection {
  readonly recordVersion: 1;
  readonly attempt: RuntimeOAuthAttemptV1;
  readonly revision: number;
  readonly sessionId: string;
  readonly phase: OAuthAttemptRecord["phase"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly terminal?: RuntimeOAuthAttemptTerminalV1;
  readonly desktopAcknowledgedAt?: string;
}

interface PendingChallenge {
  readonly projected: OAuthChallenge;
  readonly resolve: (value: string | undefined) => void;
}

interface OAuthSession {
  readonly sessionId: string;
  readonly providerId: string;
  readonly authorityId: string;
  readonly startOperationKey: string;
  readonly expiresAtMs: number;
  readonly abortController: AbortController;
  readonly issuedChallengeIds: Set<string>;
  readonly attempt?: RuntimeOAuthAttemptV1;
  phase: OAuthSessionPhase;
  authorization?: { readonly url: string; readonly instructions?: string };
  challenge?: PendingChallenge;
  progress?: string;
  configured?: true;
  error?: OAuthSessionSnapshot["error"];
  contractViolated?: true;
  tombstoneExpiresAtMs?: number;
  expirationTimer?: ReturnType<typeof setTimeout>;
  runPromise?: Promise<void>;
  attemptRecord?: OAuthAttemptRecord;
  attemptTransitionTail?: Promise<void>;
  interactionClosed?: true;
  retainProviderBarrier?: true;
}

class ProviderContractError extends Error {}
class PersistenceUnconfirmedError extends Error {}
class SessionInterruptedError extends Error {}

/**
 * Host-only OAuth coordinator. Credentials enter only the injected storage port
 * and are deliberately absent from every public snapshot and broker error.
 *
 * The concrete Prime Agent adapter is intentionally separate: v0.7.2 exports
 * provider objects and AuthStorage, but no resumable start/respond/cancel broker.
 */
export class HostOAuthSessionBroker {
  private readonly hostId: string;
  private readonly providers: HostOAuthProviderPort;
  private readonly storage: HostOAuthStorage;
  private readonly attemptStore: OAuthAttemptStore | undefined;
  private readonly activeTtlMs: number;
  private readonly tombstoneTtlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly sessions = new Map<string, OAuthSession>();
  private readonly providerRuns = new Map<string, string>();
  private readonly startOperations = new Map<string, string>();
  private persistenceTail: Promise<void> = Promise.resolve();
  private attemptAdmissionTail: Promise<void> = Promise.resolve();
  private attemptAdmissionActive = false;
  private latestAbsentAttemptObservationGeneration: bigint | undefined;
  private attemptStoreFailure: unknown;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: HostOAuthSessionBrokerOptions) {
    this.hostId = boundedIdentifier(options.hostId, "Host identifier");
    this.providers = options.providers;
    this.storage = options.storage;
    this.attemptStore = options.attemptStore;
    this.activeTtlMs = boundedInteger(
      options.activeTtlMs ?? DEFAULT_ACTIVE_TTL_MS,
      1,
      60 * 60 * 1_000,
      "OAuth active TTL",
    );
    this.tombstoneTtlMs = boundedInteger(
      options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS,
      1,
      15 * 60 * 1_000,
      "OAuth tombstone TTL",
    );
    this.maxSessions = boundedInteger(options.maxSessions ?? DEFAULT_MAX_SESSIONS, 1, 256, "OAuth session limit");
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /**
   * Admits one new digest-bound effect. A retained digest is never replayed;
   * callers must reconcile it through status instead.
   */
  async startAttempt(
    request: StartOAuthAttemptRequest,
    admission?: OAuthAttemptSessionAdmission,
  ): Promise<OAuthAttemptEffectResult> {
    return await this.withAttemptAdmission(async () => {
      this.requireOpen();
      const store = this.requireAttemptStore();
      const attempt = this.ownedAttempt(request.attempt);
      this.assertAttemptStartAdmission(admission);
      const authorityId = boundedIdentifier(request.authorityId, "OAuth authority identifier");
      const nowMs = this.readNow();
      this.collectGarbage(nowMs);

      const retained = await this.attemptStoreCall(() => store.get(attempt));
      this.requireOpen();
      this.assertAttemptStartAdmission(admission);
      if (retained) {
        throw new OAuthBrokerError(
          "OAUTH_ATTEMPT_RECONCILE_REQUIRED",
          "The OAuth attempt is already retained; reconcile it with status",
        );
      }
      if (this.providerRuns.has(attempt.identity.providerId)) {
        throw new OAuthBrokerError("OAUTH_PROVIDER_BUSY", "An OAuth session for this provider is already active");
      }
      if (this.providerRuns.size >= this.maxSessions) {
        throw new OAuthBrokerError("OAUTH_SESSION_LIMIT", "Too many OAuth sessions are retained");
      }

      let provider: HostOAuthProvider | undefined;
      try {
        provider = this.providers.getProvider(attempt.identity.providerId);
        if (provider) assertProvider(provider, attempt.identity.providerId);
      } catch {
        throw new OAuthBrokerError("OAUTH_PROVIDER_NOT_FOUND", "OAuth provider is unavailable");
      }
      this.requireOpen();
      this.assertAttemptStartAdmission(admission);
      if (!provider) throw new OAuthBrokerError("OAUTH_PROVIDER_NOT_FOUND", "OAuth provider is unavailable");

      const sessionId = this.nextSessionId();
      this.requireOpen();
      const requestedAtMs = Date.parse(attempt.identity.requestedAt);
      const expiresAtMs = safeTimestamp(Math.max(nowMs, requestedAtMs), this.activeTtlMs);
      const prepared = await this.attemptStoreCall(() => store.prepare({
        attempt,
        sessionId,
        initialAuthorityId: authorityId,
        observedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
      }));
      this.requireOpen();
      this.assertAttemptStartAdmission(admission);
      if (!prepared.created) {
        throw new OAuthBrokerError(
          "OAUTH_ATTEMPT_RECONCILE_REQUIRED",
          "The OAuth attempt is already retained; reconcile it with status",
        );
      }
      const loginDispatchingAt = this.transitionTimestamp(prepared.record);
      this.requireOpen();
      const dispatching = await this.attemptStoreCall(() => store.markLoginDispatching(
        prepared.record,
        loginDispatchingAt,
      ));
      // Once login_dispatching is durable, shutdown must leave that evidence
      // fail-closed for reconciliation; it cannot authorize a provider helper
      // that had not started before close took authority.
      this.requireOpen();
      this.assertAttemptStartAdmission(admission);

      const session: OAuthSession = {
        sessionId,
        providerId: attempt.identity.providerId,
        authorityId,
        startOperationKey: `attempt:${attempt.attemptDigest}`,
        expiresAtMs,
        abortController: new AbortController(),
        issuedChallengeIds: new Set(),
        attempt,
        attemptRecord: dispatching,
        attemptTransitionTail: Promise.resolve(),
        phase: "starting",
      };
      this.sessions.set(sessionId, session);
      this.providerRuns.set(session.providerId, sessionId);
      const expiresInMs = Math.max(1, expiresAtMs - nowMs);
      session.expirationTimer = setTimeout(() => {
        void this.cancelAttemptSession(session, "expired").catch(() => {
          session.retainProviderBarrier = true;
        });
      }, expiresInMs);
      session.expirationTimer.unref?.();
      session.runPromise = this.runAttemptSession(session, provider);
      return this.effectResult(dispatching);
    });
  }

  /** Read-only health/admission projection; start still rechecks every boundary. */
  async attemptEffectAdmissionReady(): Promise<boolean> {
    if (
      this.closed ||
      !this.attemptStore ||
      this.attemptAdmissionActive ||
      this.providerRuns.has("openai-codex")
    ) return false;
    if (this.attemptStoreFailure) throw this.attemptStoreFailure;
    const records = await this.attemptStoreCall(() => this.attemptStore!.list());
    if (records.length >= OAUTH_ATTEMPT_MAX_FILES || records.some(isOAuthAttemptBarrier)) return false;
    try {
      const provider = this.providers.getProvider("openai-codex");
      if (!provider) return false;
      assertProvider(provider, "openai-codex");
      return true;
    } catch {
      return false;
    }
  }

  /** Pure reconciliation: no clock read, provider lookup, cleanup, or write. */
  async statusAttempt(
    request: ReadOAuthAttemptRequest,
    admission?: OAuthAttemptSessionAdmission,
  ): Promise<OAuthAttemptStatusResult> {
    return await this.withAttemptAdmission(async () => {
      this.requireOpen();
      const store = this.requireAttemptStore();
      const attempt = this.ownedAttempt(request.attempt);
      const record = await this.attemptStoreCall(() => store.get(attempt));
      if (!record && admission?.isInputOpen()) {
        const observed = this.latestAbsentAttemptObservationGeneration;
        if (observed === undefined || admission.generation > observed) {
          this.latestAbsentAttemptObservationGeneration = admission.generation;
        }
      }
      return record ? this.effectResult(record) : deepFreeze({
        attemptDigest: attempt.attemptDigest,
        record: null,
      });
    }, false);
  }

  async cancelAttempt(request: ReadOAuthAttemptRequest): Promise<OAuthAttemptEffectResult> {
    this.requireOpen();
    const store = this.requireAttemptStore();
    const attempt = this.ownedAttempt(request.attempt);
    const record = await this.attemptStoreCall(() => store.get(attempt));
    if (!record) {
      throw new OAuthBrokerError("OAUTH_ATTEMPT_NOT_FOUND", "The OAuth attempt was not found");
    }
    const session = this.exactAttemptSession(record);
    let current = record;
    if (session) {
      await this.cancelAttemptSession(session, "user");
      current = await this.attemptStoreCall(() => store.get(attempt)) ?? record;
    } else if (record.phase === "prepared") {
      current = await this.attemptStoreCall(() => store.settle(record, createRuntimeOAuthAttemptTerminalV1({
        version: 1,
        attemptDigest: record.attempt.attemptDigest,
        phase: "cancelled",
        resolution: "user_cancelled",
        configuredObserved: null,
        terminalAt: this.transitionTimestamp(record),
      })));
    }
    if (!isAttemptTerminal(current.phase)) {
      throw new OAuthBrokerError(
        "OAUTH_ATTEMPT_RECONCILE_REQUIRED",
        "The OAuth attempt cannot be cancelled until helper retirement is reconciled",
      );
    }
    return this.effectResult(current);
  }

  async acknowledgeAttempt(request: AcknowledgeOAuthAttemptRequest): Promise<OAuthAttemptEffectResult> {
    this.requireOpen();
    const store = this.requireAttemptStore();
    const attempt = this.ownedAttempt(request.attempt);
    const record = await this.attemptStoreCall(() => store.acknowledgeAttempt(
      attempt,
      request.expectedRevision,
      request.terminalDigest,
      request.acknowledgedAt,
    ));
    return this.effectResult(record);
  }

  start(request: StartOAuthSessionRequest): OAuthSessionSnapshot {
    this.requireOpen();
    this.requireLegacyApi();
    const nowMs = this.prepare(request);
    const providerId = boundedIdentifier(request.providerId, "OAuth provider identifier");
    const authorityId = boundedIdentifier(request.authorityId, "OAuth authority identifier");
    const operationId = boundedIdentifier(request.operationId, "OAuth start operation identifier");
    const startOperationKey = `${authorityId}\u0000${providerId}\u0000${operationId}`;
    const retainedSessionId = this.startOperations.get(startOperationKey);
    if (retainedSessionId) {
      const retained = this.sessions.get(retainedSessionId);
      if (retained) return snapshotOf(retained);
      this.startOperations.delete(startOperationKey);
    }
    const activeSessionId = this.providerRuns.get(providerId);
    if (activeSessionId) {
      throw new OAuthBrokerError("OAUTH_PROVIDER_BUSY", "An OAuth session for this provider is already active");
    }
    if (this.sessions.size >= this.maxSessions || this.providerRuns.size >= this.maxSessions) {
      throw new OAuthBrokerError("OAUTH_SESSION_LIMIT", "Too many OAuth sessions are retained");
    }
    let provider: HostOAuthProvider | undefined;
    try {
      provider = this.providers.getProvider(providerId);
      if (provider) assertProvider(provider, providerId);
    } catch {
      throw new OAuthBrokerError("OAUTH_PROVIDER_NOT_FOUND", "OAuth provider is unavailable");
    }
    if (!provider) throw new OAuthBrokerError("OAUTH_PROVIDER_NOT_FOUND", "OAuth provider is unavailable");

    const sessionId = this.nextSessionId();
    const session: OAuthSession = {
      sessionId,
      providerId,
      authorityId,
      startOperationKey,
      expiresAtMs: safeTimestamp(nowMs, this.activeTtlMs),
      abortController: new AbortController(),
      issuedChallengeIds: new Set(),
      phase: "starting",
    };
    this.sessions.set(sessionId, session);
    this.startOperations.set(startOperationKey, sessionId);
    this.providerRuns.set(providerId, sessionId);
    session.expirationTimer = setTimeout(() => this.expireSession(sessionId), this.activeTtlMs);
    session.expirationTimer.unref?.();
    session.runPromise = this.runSession(session, provider);
    return snapshotOf(session);
  }

  status(request: ReadOAuthSessionRequest): OAuthSessionSnapshot {
    this.requireLegacyApi();
    this.prepare(request);
    return snapshotOf(this.ownedSession(request));
  }

  respond(request: RespondOAuthSessionRequest): OAuthSessionSnapshot {
    this.requireLegacyApi();
    this.prepare(request);
    const session = this.ownedSession(request);
    const challengeId = boundedIdentifier(request.challengeId, "OAuth challenge identifier");
    const pending = session.challenge;
    if (
      (session.phase !== "starting" && session.phase !== "awaiting_user") ||
      !pending ||
      pending.projected.id !== challengeId
    ) {
      throw new OAuthBrokerError("OAUTH_CHALLENGE_STALE", "OAuth challenge is no longer active");
    }

    const value = validateChallengeResponse(pending.projected, request.value);
    session.challenge = undefined;
    session.phase = session.authorization ? "awaiting_user" : "starting";
    pending.resolve(value);
    return snapshotOf(session);
  }

  async cancel(request: ReadOAuthSessionRequest): Promise<OAuthSessionSnapshot> {
    this.requireLegacyApi();
    this.prepare(request);
    const session = this.ownedSession(request);
    if (session.phase === "committing") {
      await session.runPromise;
      return snapshotOf(session);
    }
    if (session.phase === "starting" || session.phase === "awaiting_user") {
      this.finish(session, "cancelled", this.readNow());
    }
    return snapshotOf(session);
  }

  /** Opportunistic cleanup for hosts that want to run maintenance explicitly. */
  sweepExpired(): void {
    this.collectGarbage(this.readNow());
  }

  /**
   * Revokes every in-flight provider helper and waits for the concrete adapter
   * to acknowledge the abort before host runtime ownership can be released.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const admitted = this.attemptAdmissionTail;
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    this.closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    void this.closeAfterAdmissions(admitted).then(resolveClose, rejectClose);
    return this.closePromise;
  }

  private async closeAfterAdmissions(admitted: Promise<void>): Promise<void> {
    const nowMs = this.readNow();
    const cancelled = new Set<string>();
    const runs = new Set<Promise<void>>();
    const collectRuns = (): void => {
      for (const session of this.sessions.values()) {
        if (!cancelled.has(session.sessionId)) {
          cancelled.add(session.sessionId);
          if (session.attemptRecord) {
            runs.add(this.cancelAttemptSession(session, "shutdown"));
          } else if (session.phase === "starting" || session.phase === "awaiting_user") {
            this.finish(session, "cancelled", nowMs);
          }
        }
        // A re-entrant close from provider.login can observe the session before
        // startAttempt assigns runPromise. Re-collect after admission retires.
        if (session.runPromise) runs.add(session.runPromise);
      }
    };
    collectRuns();
    await admitted;
    collectRuns();
    await Promise.allSettled([...runs]);
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new OAuthBrokerError("OAUTH_REQUEST_INVALID", "OAuth session broker is unavailable");
    }
  }

  private requireAttemptStore(): OAuthAttemptStore {
    if (!this.attemptStore) {
      throw new OAuthBrokerError(
        "OAUTH_ATTEMPT_UNAVAILABLE",
        "The durable OAuth attempt journal is unavailable",
      );
    }
    return this.attemptStore;
  }

  /** Synchronous host-side preflight; startAttempt repeats it at every commit boundary. */
  assertAttemptStartAdmission(admission: OAuthAttemptSessionAdmission | undefined): void {
    if (!admission) return;
    const absentObservation = this.latestAbsentAttemptObservationGeneration;
    if (
      !admission.isInputOpen() ||
      (absentObservation !== undefined && admission.generation < absentObservation)
    ) {
      throw new OAuthBrokerError(
        "OAUTH_ATTEMPT_CONNECTION_SUPERSEDED",
        "The framed connection lost OAuth start authority before the attempt was admitted",
      );
    }
  }

  private requireLegacyApi(): void {
    if (this.attemptStore) {
      throw new OAuthBrokerError(
        "OAUTH_ATTEMPT_RECONCILE_REQUIRED",
        "Legacy OAuth sessions are disabled when durable attempts are configured",
      );
    }
  }

  private async attemptStoreCall<T>(action: () => Promise<T>): Promise<T> {
    if (this.attemptStoreFailure) throw this.attemptStoreFailure;
    try {
      return await action();
    } catch (error) {
      if (isAttemptStoreHealthFailure(error)) this.attemptStoreFailure ??= error;
      throw error;
    }
  }

  private ownedAttempt(value: unknown): RuntimeOAuthAttemptV1 {
    let attempt: RuntimeOAuthAttemptV1;
    try {
      attempt = parseRuntimeOAuthAttemptV1(value);
    } catch {
      throw new OAuthBrokerError("OAUTH_REQUEST_INVALID", "OAuth attempt identity is malformed");
    }
    if (attempt.identity.expectedHostId !== this.hostId) {
      throw new OAuthBrokerError("HOST_AUTHORITY_MISMATCH", "OAuth request targets a different host authority");
    }
    return attempt;
  }

  private prepare(request: AuthorityBinding): number {
    const expectedHostId = boundedIdentifier(request.expectedHostId, "Expected host identifier");
    if (expectedHostId !== this.hostId) {
      throw new OAuthBrokerError("HOST_AUTHORITY_MISMATCH", "OAuth request targets a different host authority");
    }
    boundedIdentifier(request.authorityId, "OAuth authority identifier");
    const nowMs = this.readNow();
    this.collectGarbage(nowMs);
    return nowMs;
  }

  private ownedSession(request: ReadOAuthSessionRequest): OAuthSession {
    const sessionId = boundedIdentifier(request.sessionId, "OAuth session identifier");
    const session = this.sessions.get(sessionId);
    if (!session) throw new OAuthBrokerError("OAUTH_SESSION_NOT_FOUND", "OAuth session was not found");
    if (session.authorityId !== request.authorityId) {
      throw new OAuthBrokerError("OAUTH_SESSION_FORBIDDEN", "OAuth session belongs to a different authority");
    }
    return session;
  }

  private async runAttemptSession(session: OAuthSession, provider: HostOAuthProvider): Promise<void> {
    try {
      const credentials = await provider.login(this.callbacksFor(session));
      if (session.contractViolated) throw new ProviderContractError();
      assertCredentials(credentials);

      const credentialsRetained = await this.withAttemptTransition(session, async () => {
        const record = await this.currentAttemptRecord(session);
        if (record.phase === "cancelling") {
          await this.settleCancellationAfterRetirement(session, record);
          return false;
        }
        if (isAttemptTerminal(record.phase)) {
          this.reflectAttemptTerminal(session, record);
          return false;
        }
        if (record.phase === "login_dispatching" && this.readNow() >= session.expiresAtMs) {
          const cancelling = await this.attemptStoreCall(() => this.requireAttemptStore().markCancelling(
            record,
            "expired",
            this.transitionTimestamp(record),
          ));
          session.attemptRecord = cancelling;
          this.interruptAttemptSession(session);
          await this.settleCancellationAfterRetirement(session, cancelling);
          return false;
        }
        if (record.phase !== "login_dispatching") {
          session.retainProviderBarrier = true;
          this.retireInteraction(session);
          return false;
        }
        session.attemptRecord = await this.attemptStoreCall(() => this.requireAttemptStore().markCredentialsReady(
          record,
          this.transitionTimestamp(record),
        ));
        session.phase = "committing";
        this.retireChallenge(session);
        return true;
      });
      if (!credentialsRetained) return;

      const dispatched = await this.confirmPersistence(session.providerId, credentials, async () => {
        return await this.withAttemptTransition(session, async () => {
          const record = await this.currentAttemptRecord(session);
          if (isAttemptTerminal(record.phase)) {
            this.reflectAttemptTerminal(session, record);
            return false;
          }
          if (record.phase !== "credentials_ready") {
            session.retainProviderBarrier = true;
            this.retireInteraction(session);
            return false;
          }
          session.attemptRecord = await this.attemptStoreCall(() => this.requireAttemptStore().markPersistenceDispatching(
            record,
            this.transitionTimestamp(record),
          ));
          return true;
        });
      });
      if (!dispatched) return;

      await this.withAttemptTransition(session, async () => {
        const record = await this.currentAttemptRecord(session);
        if (record.phase !== "persistence_dispatching") {
          session.retainProviderBarrier = true;
          this.retireInteraction(session);
          return;
        }
        await this.settleAttempt(
          session,
          record,
          "completed",
          "persistence_confirmed",
          true,
        );
      });
    } catch (error) {
      try {
        await this.handleAttemptRunError(session, error);
      } catch {
        // A journal mutation/read failure cannot authorize a terminal claim or
        // release the provider. Restart owns the next durable classification.
        session.retainProviderBarrier = true;
        this.retireInteraction(session);
      }
    } finally {
      const record = session.attemptRecord;
      if (!session.retainProviderBarrier && record && isAttemptTerminal(record.phase)) {
        this.releaseProviderRun(session);
      }
    }
  }

  private async handleAttemptRunError(session: OAuthSession, error: unknown): Promise<void> {
    if (error instanceof OAuthAttemptStoreError) {
      session.retainProviderBarrier = true;
      this.retireInteraction(session);
      return;
    }
    await this.withAttemptTransition(session, async () => {
      const record = await this.currentAttemptRecord(session);
      if (isAttemptTerminal(record.phase)) {
        this.reflectAttemptTerminal(session, record);
        return;
      }
      if (isHelperLivenessUnconfirmed(error)) {
        const reason = recoveryReasonFor(record);
        if (!reason) {
          session.retainProviderBarrier = true;
          this.retireInteraction(session);
          return;
        }
        session.attemptRecord = await this.attemptStoreCall(() => this.requireAttemptStore().markRecoveryRequired(
          record,
          reason,
          this.transitionTimestamp(record),
        ));
        session.retainProviderBarrier = true;
        this.retireInteraction(session);
        return;
      }
      if (record.phase === "cancelling") {
        await this.settleCancellationAfterRetirement(session, record);
        return;
      }
      switch (record.phase) {
        case "prepared":
          await this.settleAttempt(
            session,
            record,
            "failed",
            "interrupted_before_login_dispatch",
            null,
            providerFailureSnapshot(error),
          );
          return;
        case "login_dispatching":
          await this.settleAttempt(
            session,
            record,
            "failed",
            "provider_login_failed",
            null,
            providerFailureSnapshot(error),
          );
          return;
        case "credentials_ready":
          await this.settleAttempt(
            session,
            record,
            "failed",
            "credentials_discarded_before_persistence",
            null,
            discardedCredentialsSnapshot(),
          );
          return;
        case "persistence_dispatching":
          await this.settleAttempt(
            session,
            record,
            "failed",
            "persistence_failed",
            null,
            persistenceFailureSnapshot(),
          );
          return;
        case "recovery_required":
          session.retainProviderBarrier = true;
          this.retireInteraction(session);
          return;
      }
    });
  }

  private async cancelAttemptSession(
    session: OAuthSession,
    intent: OAuthAttemptCancelIntent,
  ): Promise<void> {
    let awaitRun = false;
    await this.withAttemptTransition(session, async () => {
      const record = await this.currentAttemptRecord(session);
      if (isAttemptTerminal(record.phase)) {
        this.reflectAttemptTerminal(session, record);
        awaitRun = session.runPromise !== undefined;
        return;
      }
      switch (record.phase) {
        case "login_dispatching":
          session.attemptRecord = await this.attemptStoreCall(() => this.requireAttemptStore().markCancelling(
            record,
            intent,
            this.transitionTimestamp(record),
          ));
          this.interruptAttemptSession(session);
          awaitRun = true;
          return;
        case "cancelling":
          this.interruptAttemptSession(session);
          awaitRun = true;
          return;
        case "credentials_ready":
          await this.settleAttempt(
            session,
            record,
            "failed",
            "credentials_discarded_before_persistence",
            null,
            discardedCredentialsSnapshot(),
          );
          awaitRun = session.runPromise !== undefined;
          return;
        case "persistence_dispatching":
          awaitRun = true;
          return;
        case "prepared":
        case "recovery_required":
          session.retainProviderBarrier = true;
          this.retireInteraction(session);
          return;
      }
    });
    if (awaitRun && session.runPromise) await session.runPromise;
  }

  private async settleCancellationAfterRetirement(
    session: OAuthSession,
    record: OAuthAttemptRecord,
  ): Promise<void> {
    switch (record.cancelIntent) {
      case "user":
        await this.settleAttempt(session, record, "cancelled", "user_cancelled", null);
        return;
      case "expired":
        await this.settleAttempt(
          session,
          record,
          "failed",
          "expired",
          null,
          expiredSnapshot(),
        );
        return;
      case "shutdown":
        await this.settleAttempt(
          session,
          record,
          "failed",
          "host_shutdown",
          null,
          interruptedSnapshot(),
        );
        return;
      default:
        session.retainProviderBarrier = true;
        this.retireInteraction(session);
    }
  }

  private async settleAttempt(
    session: OAuthSession,
    record: OAuthAttemptRecord,
    phase: RuntimeOAuthAttemptTerminalPhase,
    resolution: RuntimeOAuthAttemptTerminalResolution,
    configuredObserved: boolean | null,
    error?: OAuthSessionSnapshot["error"],
  ): Promise<void> {
    const terminal = createRuntimeOAuthAttemptTerminalV1({
      version: 1,
      attemptDigest: record.attempt.attemptDigest,
      phase,
      resolution,
      configuredObserved,
      terminalAt: this.transitionTimestamp(record),
    });
    session.attemptRecord = await this.attemptStoreCall(() => this.requireAttemptStore().settle(record, terminal));
    this.finish(session, phase === "outcome_unknown" ? "failed" : phase, this.readNow(), error);
  }

  private async currentAttemptRecord(session: OAuthSession): Promise<OAuthAttemptRecord> {
    if (!session.attempt) {
      throw new OAuthBrokerError("OAUTH_ATTEMPT_NOT_FOUND", "The OAuth attempt was not found");
    }
    const record = await this.attemptStoreCall(() => this.requireAttemptStore().get(session.attempt!));
    if (!record || record.sessionId !== session.sessionId) {
      throw new OAuthBrokerError("OAUTH_ATTEMPT_NOT_FOUND", "The OAuth attempt was not found");
    }
    session.attemptRecord = record;
    return record;
  }

  private async withAttemptTransition<T>(session: OAuthSession, action: () => Promise<T>): Promise<T> {
    const prior = session.attemptTransitionTail ?? Promise.resolve();
    let release!: () => void;
    session.attemptTransitionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async withAttemptAdmission<T>(
    action: () => Promise<T>,
    effectBearing = true,
  ): Promise<T> {
    const prior = this.attemptAdmissionTail;
    let release!: () => void;
    this.attemptAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    if (effectBearing) this.attemptAdmissionActive = true;
    try {
      return await action();
    } finally {
      if (effectBearing) this.attemptAdmissionActive = false;
      release();
    }
  }

  private exactAttemptSession(record: OAuthAttemptRecord): OAuthSession | undefined {
    const session = this.sessions.get(record.sessionId);
    return session?.attempt?.attemptDigest === record.attempt.attemptDigest &&
      session.providerId === record.attempt.identity.providerId &&
      session.authorityId === record.initialAuthorityId
      ? session
      : undefined;
  }

  private effectResult(record: OAuthAttemptRecord): OAuthAttemptEffectResult {
    const session = this.exactAttemptSession(record);
    const live = session && liveMatchesAttemptPhase(record.phase, session.phase)
      ? snapshotOf(session)
      : undefined;
    return deepFreeze({
      attemptDigest: record.attempt.attemptDigest,
      record: projectAttemptRecord(record),
      ...(live ? { live } : {}),
    });
  }

  private transitionTimestamp(record: OAuthAttemptRecord): string {
    return new Date(Math.max(this.readNow(), Date.parse(record.updatedAt))).toISOString();
  }

  private interruptAttemptSession(session: OAuthSession): void {
    this.retireInteraction(session);
    session.abortController.abort();
  }

  private retireInteraction(session: OAuthSession): void {
    session.interactionClosed = true;
    session.authorization = undefined;
    session.progress = undefined;
    this.retireChallenge(session);
    if (session.expirationTimer) {
      clearTimeout(session.expirationTimer);
      session.expirationTimer = undefined;
    }
  }

  private retireChallenge(session: OAuthSession): void {
    const pending = session.challenge;
    session.challenge = undefined;
    pending?.resolve(undefined);
  }

  private reflectAttemptTerminal(session: OAuthSession, record: OAuthAttemptRecord): void {
    session.attemptRecord = record;
    if (!record.terminal || !isAttemptTerminal(record.phase)) return;
    const error = record.phase === "failed"
      ? terminalFailureSnapshot(record.terminal.body.resolution)
      : undefined;
    this.finish(session, record.phase === "outcome_unknown" ? "failed" : record.phase, this.readNow(), error);
  }

  private releaseProviderRun(session: OAuthSession): void {
    if (this.providerRuns.get(session.providerId) === session.sessionId) {
      this.providerRuns.delete(session.providerId);
    }
  }

  private async runSession(session: OAuthSession, provider: HostOAuthProvider): Promise<void> {
    try {
      const credentials = await provider.login(this.callbacksFor(session));
      if (session.phase !== "starting" && session.phase !== "awaiting_user") return;
      if (session.contractViolated) throw new ProviderContractError();
      assertCredentials(credentials);

      // This transition is the cancellation/commit linearization point. Once a
      // session enters committing, cancel waits and cannot claim cancellation.
      session.phase = "committing";
      // Callback-server providers race the browser callback against a manual
      // input promise. The callback may win while that challenge is still
      // pending, so retire it without treating normal provider behavior as a
      // contract failure or creating an unhandled rejection.
      session.challenge?.resolve(undefined);
      session.challenge = undefined;
      await this.confirmPersistence(session.providerId, credentials);
      this.finish(session, "completed", this.readNow());
    } catch (error) {
      if (isTerminal(session.phase)) return;
      const nowMs = this.readNow();
      if (error instanceof ProviderContractError) {
        this.finish(session, "failed", nowMs, {
          code: "OAUTH_PROVIDER_CONTRACT_INVALID",
          message: "OAuth provider returned an invalid authorization contract",
          retryable: false,
        });
      } else if (error instanceof PersistenceUnconfirmedError) {
        this.finish(session, "failed", nowMs, {
          code: "OAUTH_PERSISTENCE_UNCONFIRMED",
          message: "OAuth credentials could not be confirmed in durable host storage",
          retryable: true,
        });
      } else if (error instanceof SessionInterruptedError) {
        this.finish(session, "cancelled", nowMs);
      } else {
        this.finish(session, "failed", nowMs, {
          code: "OAUTH_PROVIDER_FAILED",
          message: "OAuth provider login failed",
          retryable: true,
        });
      }
    } finally {
      if (this.providerRuns.get(session.providerId) === session.sessionId) {
        this.providerRuns.delete(session.providerId);
      }
    }
  }

  private callbacksFor(session: OAuthSession): OAuthLoginCallbacks {
    return {
      signal: session.abortController.signal,
      onAuth: (info) => {
        this.guardProviderCallback(session, () => {
          this.requireInteractive(session);
          session.authorization = normalizeAuthorization(info);
          session.phase = "awaiting_user";
        });
      },
      onPrompt: (prompt) => this.guardProviderCallback(session, () => {
        const normalized = normalizePrompt(prompt);
        return this.createChallenge(session, {
          id: this.nextChallengeId(session),
          kind: "text",
          message: normalized.message,
          ...(normalized.placeholder === undefined ? {} : { placeholder: normalized.placeholder }),
          allowEmpty: normalized.allowEmpty,
        }).then((value) => value ?? "");
      }),
      onProgress: (message) => {
        this.guardProviderCallback(session, () => {
          this.requireInteractive(session);
          session.progress = boundedText(message, MAX_PROGRESS_LENGTH, "OAuth progress");
        });
      },
      onManualCodeInput: () => this.guardProviderCallback(session, () => this.createChallenge(session, {
        id: this.nextChallengeId(session),
        kind: "manual_redirect",
        message: "Paste the redirect URL or authorization code",
        allowEmpty: false,
      }).then((value) => value ?? "")),
      onSelect: (prompt) => this.guardProviderCallback(session, () => {
        const normalized = normalizeSelection(prompt);
        return this.createChallenge(session, {
          id: this.nextChallengeId(session),
          kind: "select",
          message: normalized.message,
          options: normalized.options,
        });
      }),
    };
  }

  private createChallenge(session: OAuthSession, challenge: OAuthChallenge): Promise<string | undefined> {
    this.requireInteractive(session);
    if (session.challenge) throw new ProviderContractError();
    session.phase = "awaiting_user";
    return new Promise<string | undefined>((resolve) => {
      session.challenge = { projected: challenge, resolve };
    });
  }

  private requireInteractive(session: OAuthSession): void {
    if (
      session.interactionClosed ||
      (session.phase !== "starting" && session.phase !== "awaiting_user")
    ) {
      throw new SessionInterruptedError();
    }
  }

  private guardProviderCallback<T>(session: OAuthSession, callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      if (!(error instanceof SessionInterruptedError)) session.contractViolated = true;
      throw error;
    }
  }

  private async confirmPersistence(
    providerId: string,
    credentials: OAuthCredentials,
    beforeDispatch: () => Awaitable<boolean> = () => true,
  ): Promise<boolean> {
    const previous = this.persistenceTail;
    let release!: () => void;
    this.persistenceTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      if (!await beforeDispatch()) return false;
      await this.confirmPersistenceExclusive(providerId, credentials);
      return true;
    } finally {
      release();
    }
  }

  /** AuthStorage has one shared error queue, so the full confirmation chain is globally serialized. */
  private async confirmPersistenceExclusive(providerId: string, credentials: OAuthCredentials): Promise<void> {
    let unconfirmed = false;
    try {
      await this.storage.set(providerId, { ...credentials, type: "oauth" });
    } catch (error) {
      if (isHelperLivenessUnconfirmed(error)) throw error;
      unconfirmed = true;
    }

    try {
      const errors = await this.storage.drainErrors();
      if (!Array.isArray(errors) || errors.length > 0) unconfirmed = true;
    } catch (error) {
      if (isHelperLivenessUnconfirmed(error)) throw error;
      unconfirmed = true;
    }

    try {
      await this.storage.reload();
    } catch (error) {
      if (isHelperLivenessUnconfirmed(error)) throw error;
      unconfirmed = true;
    }

    try {
      const status = await this.storage.getAuthStatus(providerId);
      if (!isRecord(status) || status.configured !== true) unconfirmed = true;
    } catch (error) {
      if (isHelperLivenessUnconfirmed(error)) throw error;
      unconfirmed = true;
    }

    if (unconfirmed) throw new PersistenceUnconfirmedError();
  }

  private finish(
    session: OAuthSession,
    phase: "completed" | "cancelled" | "failed",
    nowMs: number,
    error?: OAuthSessionSnapshot["error"],
  ): void {
    const pending = session.challenge;
    session.challenge = undefined;
    session.authorization = undefined;
    session.progress = undefined;
    session.phase = phase;
    session.error = error;
    session.configured = phase === "completed" ? true : undefined;
    session.tombstoneExpiresAtMs = safeTimestamp(nowMs, this.tombstoneTtlMs);
    if (session.expirationTimer) {
      clearTimeout(session.expirationTimer);
      session.expirationTimer = undefined;
    }
    if (phase !== "completed") session.abortController.abort();
    // A provider may start a manual-input race and intentionally ignore that
    // promise when a browser callback wins. Settle it successfully so expiry or
    // cancellation cannot create an unhandled rejection in the host process;
    // the terminal session phase still prevents returned credentials from
    // being committed.
    pending?.resolve(undefined);
  }

  private collectGarbage(nowMs: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (
        !session.attempt &&
        (session.phase === "starting" || session.phase === "awaiting_user") &&
        nowMs >= session.expiresAtMs
      ) {
        this.finish(session, "failed", nowMs, {
          code: "OAUTH_SESSION_EXPIRED",
          message: "OAuth session expired before completion",
          retryable: true,
        });
      }
      if (
        isTerminal(session.phase) &&
        session.tombstoneExpiresAtMs !== undefined &&
        nowMs >= session.tombstoneExpiresAtMs
      ) {
        this.sessions.delete(sessionId);
        if (this.startOperations.get(session.startOperationKey) === sessionId) {
          this.startOperations.delete(session.startOperationKey);
        }
      }
    }
  }

  private expireSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || (session.phase !== "starting" && session.phase !== "awaiting_user")) return;
    let nowMs: number;
    try {
      nowMs = this.readNow();
    } catch {
      nowMs = session.expiresAtMs;
    }
    if (nowMs < session.expiresAtMs) {
      const remainingMs = session.expiresAtMs - nowMs;
      session.expirationTimer = setTimeout(() => this.expireSession(sessionId), remainingMs);
      session.expirationTimer.unref?.();
      return;
    }
    this.finish(session, "failed", nowMs, {
      code: "OAUTH_SESSION_EXPIRED",
      message: "OAuth session expired before completion",
      retryable: true,
    });
  }

  private nextSessionId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let rawCandidate: unknown;
      try {
        rawCandidate = this.idFactory();
      } catch {
        throw new OAuthBrokerError("OAUTH_REQUEST_INVALID", "Could not allocate an OAuth session identifier");
      }
      const candidate = boundedIdentifier(rawCandidate, "Generated OAuth session identifier");
      if (!this.sessions.has(candidate)) return candidate;
    }
    throw new OAuthBrokerError("OAUTH_REQUEST_INVALID", "Could not allocate a unique OAuth session identifier");
  }

  private nextChallengeId(session: OAuthSession): string {
    if (session.issuedChallengeIds.size >= MAX_CHALLENGES_PER_SESSION) throw new ProviderContractError();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let rawCandidate: unknown;
      try {
        rawCandidate = this.idFactory();
      } catch {
        throw new ProviderContractError();
      }
      let candidate: string;
      try {
        candidate = boundedIdentifier(rawCandidate, "Generated OAuth challenge identifier");
      } catch {
        throw new ProviderContractError();
      }
      if (!session.issuedChallengeIds.has(candidate)) {
        session.issuedChallengeIds.add(candidate);
        return candidate;
      }
    }
    throw new ProviderContractError();
  }

  private readNow(): number {
    let nowMs: number;
    try {
      nowMs = this.now();
    } catch {
      throw new OAuthBrokerError("OAUTH_REQUEST_INVALID", "OAuth broker clock is invalid");
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new OAuthBrokerError("OAUTH_REQUEST_INVALID", "OAuth broker clock is invalid");
    }
    return nowMs;
  }
}

function isAttemptTerminal(
  phase: OAuthAttemptRecord["phase"],
): phase is Extract<OAuthAttemptRecord["phase"], "completed" | "cancelled" | "failed" | "outcome_unknown"> {
  return phase === "completed" || phase === "cancelled" || phase === "failed" || phase === "outcome_unknown";
}

function liveMatchesAttemptPhase(
  recordPhase: OAuthAttemptRecord["phase"],
  livePhase: OAuthSessionPhase,
): boolean {
  switch (recordPhase) {
    case "login_dispatching":
    case "cancelling":
      return livePhase === "starting" || livePhase === "awaiting_user";
    case "credentials_ready":
    case "persistence_dispatching":
      return livePhase === "committing";
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

function isHelperLivenessUnconfirmed(error: unknown): boolean {
  return isRecord(error) &&
    error.name === "RuntimeOAuthHelperTerminationError" &&
    error.code === "RUNTIME_OAUTH_HELPER_FAILED" &&
    error.terminationObserved === false;
}

function isAttemptStoreHealthFailure(error: unknown): boolean {
  return !(error instanceof OAuthAttemptStoreError) ||
    error.code === "OAUTH_ATTEMPT_STORE_INVALID" ||
    error.code === "OAUTH_ATTEMPT_COMMIT_UNCERTAIN";
}

function recoveryReasonFor(record: OAuthAttemptRecord): OAuthAttemptRecoveryReason | undefined {
  switch (record.phase) {
    case "login_dispatching":
      return "login_helper_liveness_unconfirmed";
    case "persistence_dispatching":
      return "storage_helper_liveness_unconfirmed";
    case "cancelling":
      return "cancelling_helper_liveness_unconfirmed";
    default:
      return undefined;
  }
}

function providerFailureSnapshot(error: unknown): OAuthSessionSnapshot["error"] {
  return error instanceof ProviderContractError
    ? {
        code: "OAUTH_PROVIDER_CONTRACT_INVALID",
        message: "OAuth provider returned an invalid authorization contract",
        retryable: false,
      }
    : {
        code: "OAUTH_PROVIDER_FAILED",
        message: "OAuth provider login failed",
        retryable: true,
      };
}

function persistenceFailureSnapshot(): OAuthSessionSnapshot["error"] {
  return {
    code: "OAUTH_PERSISTENCE_UNCONFIRMED",
    message: "OAuth credentials could not be confirmed in durable host storage",
    retryable: true,
  };
}

function discardedCredentialsSnapshot(): OAuthSessionSnapshot["error"] {
  return {
    code: "OAUTH_PROVIDER_FAILED",
    message: "OAuth credentials were discarded before persistence",
    retryable: true,
  };
}

function expiredSnapshot(): OAuthSessionSnapshot["error"] {
  return {
    code: "OAUTH_SESSION_EXPIRED",
    message: "OAuth session expired before completion",
    retryable: true,
  };
}

function interruptedSnapshot(): OAuthSessionSnapshot["error"] {
  return {
    code: "OAUTH_PROVIDER_FAILED",
    message: "OAuth session was interrupted before completion",
    retryable: true,
  };
}

function terminalFailureSnapshot(
  resolution: RuntimeOAuthAttemptTerminalResolution,
): OAuthSessionSnapshot["error"] {
  switch (resolution) {
    case "expired":
      return expiredSnapshot();
    case "persistence_failed":
      return persistenceFailureSnapshot();
    case "credentials_discarded_before_persistence":
      return discardedCredentialsSnapshot();
    default:
      return interruptedSnapshot();
  }
}

function projectAttemptRecord(record: OAuthAttemptRecord): OAuthAttemptRecordProjection {
  return deepFreeze({
    recordVersion: record.recordVersion,
    attempt: record.attempt,
    revision: record.revision,
    sessionId: record.sessionId,
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    ...(record.terminal ? { terminal: record.terminal } : {}),
    ...(record.desktopAcknowledgedAt
      ? { desktopAcknowledgedAt: record.desktopAcknowledgedAt }
      : {}),
  });
}

function snapshotOf(session: OAuthSession): OAuthSessionSnapshot {
  const snapshot: OAuthSessionSnapshot = {
    sessionId: session.sessionId,
    providerId: session.providerId,
    phase: session.phase,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    ...(session.authorization ? { authorization: { ...session.authorization } } : {}),
    ...(session.challenge ? { challenge: cloneChallenge(session.challenge.projected) } : {}),
    ...(session.progress === undefined ? {} : { progress: session.progress }),
    ...(session.configured ? { configured: true as const } : {}),
    ...(session.error ? { error: { ...session.error } } : {}),
  };
  return deepFreeze(snapshot);
}

function cloneChallenge(challenge: OAuthChallenge): OAuthChallenge {
  if (challenge.kind !== "select") return { ...challenge };
  return { ...challenge, options: challenge.options.map((option) => ({ ...option })) };
}

function assertProvider(provider: HostOAuthProvider, expectedId: string): void {
  if (!isRecord(provider) || provider.id !== expectedId || typeof provider.login !== "function") {
    throw new OAuthBrokerError("OAUTH_PROVIDER_NOT_FOUND", "OAuth provider is unavailable");
  }
  boundedIdentifier(provider.id, "OAuth provider identifier");
  boundedText(provider.name, 255, "OAuth provider name");
  if (provider.usesCallbackServer !== undefined && typeof provider.usesCallbackServer !== "boolean") {
    throw new OAuthBrokerError("OAUTH_PROVIDER_NOT_FOUND", "OAuth provider is unavailable");
  }
}

function assertCredentials(credentials: unknown): asserts credentials is OAuthCredentials {
  if (
    !isRecord(credentials) ||
    typeof credentials.access !== "string" ||
    credentials.access.length < 1 ||
    credentials.access.length > MAX_CREDENTIAL_SECRET_LENGTH ||
    typeof credentials.refresh !== "string" ||
    credentials.refresh.length < 1 ||
    credentials.refresh.length > MAX_CREDENTIAL_SECRET_LENGTH ||
    typeof credentials.expires !== "number" ||
    !Number.isFinite(credentials.expires) ||
    credentials.expires <= 0
  ) {
    throw new ProviderContractError();
  }
  const entries = Object.entries(credentials);
  if (entries.length > MAX_CREDENTIAL_FIELDS) throw new ProviderContractError();
  for (const [key, value] of entries) {
    if (key === "access" || key === "refresh" || key === "expires") continue;
    if (value === null || value === undefined || typeof value === "boolean") continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (typeof value === "string" && value.length <= MAX_CREDENTIAL_METADATA_LENGTH) continue;
    throw new ProviderContractError();
  }
}

function normalizeAuthorization(value: unknown): { readonly url: string; readonly instructions?: string } {
  if (!isRecord(value)) throw new ProviderContractError();
  const rawUrl = boundedText(value.url, MAX_AUTHORIZATION_URL_LENGTH, "OAuth authorization URL");
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ProviderContractError();
  }
  const canonicalUrl = parsed.toString();
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    canonicalUrl.length > MAX_AUTHORIZATION_URL_LENGTH
  ) {
    throw new ProviderContractError();
  }
  const instructions = value.instructions === undefined
    ? undefined
    : boundedText(value.instructions, MAX_MESSAGE_LENGTH, "OAuth instructions");
  return {
    url: canonicalUrl,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

function normalizePrompt(value: unknown): {
  readonly message: string;
  readonly placeholder?: string;
  readonly allowEmpty: boolean;
} {
  if (!isRecord(value)) throw new ProviderContractError();
  if (value.allowEmpty !== undefined && typeof value.allowEmpty !== "boolean") throw new ProviderContractError();
  const placeholder = value.placeholder === undefined
    ? undefined
    : boundedText(value.placeholder, 255, "OAuth prompt placeholder", true);
  return {
    message: boundedText(value.message, MAX_MESSAGE_LENGTH, "OAuth prompt message"),
    ...(placeholder === undefined ? {} : { placeholder }),
    allowEmpty: value.allowEmpty === true,
  };
}

function normalizeSelection(value: unknown): {
  readonly message: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
} {
  if (!isRecord(value) || !Array.isArray(value.options) || value.options.length < 1 || value.options.length > MAX_OPTIONS) {
    throw new ProviderContractError();
  }
  const seen = new Set<string>();
  const options = value.options.map((option) => {
    if (!isRecord(option)) throw new ProviderContractError();
    const id = boundedIdentifier(option.id, "OAuth selection identifier");
    if (seen.has(id)) throw new ProviderContractError();
    seen.add(id);
    return { id, label: boundedText(option.label, 255, "OAuth selection label") };
  });
  return {
    message: boundedText(value.message, MAX_MESSAGE_LENGTH, "OAuth selection message"),
    options,
  };
}

function validateChallengeResponse(challenge: OAuthChallenge, value: unknown): string | undefined {
  if (challenge.kind === "select") {
    if (value === undefined) return undefined;
    const selected = boundedResponse(value);
    if (!challenge.options.some((option) => option.id === selected)) {
      throw new OAuthBrokerError("OAUTH_RESPONSE_INVALID", "OAuth selection is not one of the offered options");
    }
    return selected;
  }
  if (typeof value !== "string") {
    throw new OAuthBrokerError("OAUTH_RESPONSE_INVALID", "OAuth challenge requires a text response");
  }
  if (value.length === 0 && !challenge.allowEmpty) {
    throw new OAuthBrokerError("OAUTH_RESPONSE_INVALID", "OAuth challenge response cannot be empty");
  }
  return boundedResponse(value, challenge.allowEmpty);
}

function boundedResponse(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length < 1) ||
    value.length > MAX_RESPONSE_LENGTH ||
    /[\0\r\n]/.test(value)
  ) {
    throw new OAuthBrokerError("OAUTH_RESPONSE_INVALID", "OAuth challenge response is malformed");
  }
  return value;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    /[\0-\x20\x7f]/.test(value)
  ) {
    throw new OAuthBrokerError("OAUTH_REQUEST_INVALID", `${label} is malformed`);
  }
  return value;
}

function boundedText(value: unknown, maxLength: number, label: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length < 1) ||
    value.length > maxLength ||
    /[\0\r\n]/.test(value)
  ) {
    throw new ProviderContractError(`${label} is malformed`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function safeTimestamp(nowMs: number, deltaMs: number): number {
  const timestamp = nowMs + deltaMs;
  if (!Number.isSafeInteger(timestamp) || timestamp > 8_640_000_000_000_000) {
    throw new OAuthBrokerError("OAUTH_REQUEST_INVALID", "OAuth broker clock exceeded the supported range");
  }
  return timestamp;
}

function isTerminal(phase: OAuthSessionPhase): phase is "completed" | "cancelled" | "failed" {
  return phase === "completed" || phase === "cancelled" || phase === "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
