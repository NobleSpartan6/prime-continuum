import { randomUUID } from "node:crypto";

/**
 * Prime Agent v0.7.0 integration boundary:
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
}

export interface ReadOAuthSessionRequest extends AuthorityBinding {
  readonly sessionId: string;
}

export interface RespondOAuthSessionRequest extends ReadOAuthSessionRequest {
  readonly challengeId: string;
  readonly value?: string;
}

interface PendingChallenge {
  readonly projected: OAuthChallenge;
  readonly resolve: (value: string | undefined) => void;
}

interface OAuthSession {
  readonly sessionId: string;
  readonly providerId: string;
  readonly authorityId: string;
  readonly expiresAtMs: number;
  readonly abortController: AbortController;
  readonly issuedChallengeIds: Set<string>;
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
}

class ProviderContractError extends Error {}
class PersistenceUnconfirmedError extends Error {}
class SessionInterruptedError extends Error {}

/**
 * Host-only OAuth coordinator. Credentials enter only the injected storage port
 * and are deliberately absent from every public snapshot and broker error.
 *
 * The concrete Prime Agent adapter is intentionally separate: v0.7.0 exports
 * provider objects and AuthStorage, but no resumable start/respond/cancel broker.
 */
export class HostOAuthSessionBroker {
  private readonly hostId: string;
  private readonly providers: HostOAuthProviderPort;
  private readonly storage: HostOAuthStorage;
  private readonly activeTtlMs: number;
  private readonly tombstoneTtlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly sessions = new Map<string, OAuthSession>();
  private readonly providerRuns = new Map<string, string>();
  private persistenceTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: HostOAuthSessionBrokerOptions) {
    this.hostId = boundedIdentifier(options.hostId, "Host identifier");
    this.providers = options.providers;
    this.storage = options.storage;
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

  start(request: StartOAuthSessionRequest): OAuthSessionSnapshot {
    this.requireOpen();
    const nowMs = this.prepare(request);
    const providerId = boundedIdentifier(request.providerId, "OAuth provider identifier");
    const authorityId = boundedIdentifier(request.authorityId, "OAuth authority identifier");
    const activeSessionId = this.providerRuns.get(providerId);
    if (activeSessionId) {
      const activeSession = this.sessions.get(activeSessionId);
      if (
        activeSession &&
        activeSession.authorityId === authorityId &&
        (activeSession.phase === "starting" ||
          activeSession.phase === "awaiting_user" ||
          activeSession.phase === "committing")
      ) {
        return snapshotOf(activeSession);
      }
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
      expiresAtMs: safeTimestamp(nowMs, this.activeTtlMs),
      abortController: new AbortController(),
      issuedChallengeIds: new Set(),
      phase: "starting",
    };
    this.sessions.set(sessionId, session);
    this.providerRuns.set(providerId, sessionId);
    session.expirationTimer = setTimeout(() => this.expireSession(sessionId), this.activeTtlMs);
    session.expirationTimer.unref?.();
    session.runPromise = this.runSession(session, provider);
    return snapshotOf(session);
  }

  status(request: ReadOAuthSessionRequest): OAuthSessionSnapshot {
    this.prepare(request);
    return snapshotOf(this.ownedSession(request));
  }

  respond(request: RespondOAuthSessionRequest): OAuthSessionSnapshot {
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
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const nowMs = this.readNow();
    const runs: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.phase === "starting" || session.phase === "awaiting_user") {
        this.finish(session, "cancelled", nowMs);
      }
      if (session.runPromise) runs.push(session.runPromise);
    }
    await Promise.allSettled(runs);
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new OAuthBrokerError("OAUTH_REQUEST_INVALID", "OAuth session broker is unavailable");
    }
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
    if (session.phase !== "starting" && session.phase !== "awaiting_user") {
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

  private async confirmPersistence(providerId: string, credentials: OAuthCredentials): Promise<void> {
    const previous = this.persistenceTail;
    let release!: () => void;
    this.persistenceTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      await this.confirmPersistenceExclusive(providerId, credentials);
    } finally {
      release();
    }
  }

  /** AuthStorage has one shared error queue, so the full confirmation chain is globally serialized. */
  private async confirmPersistenceExclusive(providerId: string, credentials: OAuthCredentials): Promise<void> {
    let unconfirmed = false;
    try {
      await this.storage.set(providerId, { ...credentials, type: "oauth" });
    } catch {
      unconfirmed = true;
    }

    try {
      const errors = await this.storage.drainErrors();
      if (!Array.isArray(errors) || errors.length > 0) unconfirmed = true;
    } catch {
      unconfirmed = true;
    }

    try {
      await this.storage.reload();
    } catch {
      unconfirmed = true;
    }

    try {
      const status = await this.storage.getAuthStatus(providerId);
      if (!isRecord(status) || status.configured !== true) unconfirmed = true;
    } catch {
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
