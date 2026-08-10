import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  assertRuntimeOAuthAttemptFreshV1,
  createRuntimeOAuthAttemptTerminalV1,
  parseRuntimeOAuthAttemptTerminalV1,
  parseRuntimeOAuthAttemptV1,
  type RuntimeOAuthAttemptTerminalV1,
  type RuntimeOAuthAttemptV1,
} from "../shared/runtime-oauth-attempt";
import {
  atomicWriteJson,
  atomicWriteJsonIfAbsent,
  ensurePrivateDirectory,
  type AtomicCreateFaultPoint,
} from "./atomic-files";
import type { HostDataPaths } from "./paths";

export const OAUTH_ATTEMPT_MAX_FILES = 128;
export const OAUTH_ATTEMPT_MAX_FILE_BYTES = 32 * 1024;
export const OAUTH_ATTEMPT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export const OAUTH_ATTEMPT_PHASES = Object.freeze([
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
] as const);

export const OAUTH_ATTEMPT_CANCEL_INTENTS = Object.freeze([
  "user",
  "expired",
  "shutdown",
] as const);

export const OAUTH_ATTEMPT_RECOVERY_REASONS = Object.freeze([
  "login_helper_liveness_unconfirmed",
  "storage_helper_liveness_unconfirmed",
  "cancelling_helper_liveness_unconfirmed",
] as const);

export type OAuthAttemptPhase = (typeof OAUTH_ATTEMPT_PHASES)[number];
export type OAuthAttemptCancelIntent = (typeof OAUTH_ATTEMPT_CANCEL_INTENTS)[number];
export type OAuthAttemptRecoveryReason = (typeof OAUTH_ATTEMPT_RECOVERY_REASONS)[number];

export interface OAuthAttemptRecord {
  readonly recordVersion: 1;
  readonly attempt: RuntimeOAuthAttemptV1;
  readonly revision: number;
  readonly sessionId: string;
  readonly initialAuthorityId: string;
  readonly phase: OAuthAttemptPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly cancelIntent?: OAuthAttemptCancelIntent;
  readonly recoveryReason?: OAuthAttemptRecoveryReason;
  readonly terminal?: RuntimeOAuthAttemptTerminalV1;
  readonly desktopAcknowledgedAt?: string;
}

export interface OAuthAttemptPrepareInput {
  readonly attempt: RuntimeOAuthAttemptV1;
  readonly sessionId: string;
  readonly initialAuthorityId: string;
  /** Host observation used only for new-record freshness admission. */
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface OAuthAttemptCompactionResult {
  readonly deletedAttemptDigests: readonly string[];
  readonly remainingCount: number;
}

export type OAuthAttemptStoreFaultPoint =
  | "after_prepare_publish"
  | "after_transition_publish"
  | "after_record_file_sync"
  | "after_compaction_rename"
  | "after_compaction_record_removal_sync"
  | "after_compaction_unlink"
  | "after_compaction_cleanup_sync";

export interface OAuthAttemptStoreOptions {
  /** Test/fault boundary only; production callers leave this undefined. */
  readonly faultInjector?: (point: OAuthAttemptStoreFaultPoint) => void | Promise<void>;
  /** Test/fault boundary for the no-replace atomic creator. */
  readonly atomicCreateFaultInjector?: (point: AtomicCreateFaultPoint) => void | Promise<void>;
}

export class OAuthAttemptStoreError extends Error {
  readonly code:
    | "OAUTH_ATTEMPT_ID_CONFLICT"
    | "OAUTH_ATTEMPT_STORAGE_FULL"
    | "OAUTH_ATTEMPT_STORE_INVALID"
    | "OAUTH_ATTEMPT_CAS_CONFLICT";

  constructor(code: OAuthAttemptStoreError["code"], message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "OAuthAttemptStoreError";
    this.code = code;
  }
}

const SAFE_FILE_NAME = /^[a-f0-9]{64}\.json$/;
const SAFE_ATOMIC_TEMP_FILE_NAME = /^([a-f0-9]{64}\.json)\.tmp-[1-9][0-9]*-[a-f0-9]{16}$/;
const SAFE_DELETE_TEMP_FILE_NAME = /^([a-f0-9]{64}\.json)\.delete-[a-f0-9]{16}$/;
const BOUNDED_CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CANONICAL_UTC_ISO_MS_PATTERN =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/;
const MAX_RECOVERY_ENTRIES = OAUTH_ATTEMPT_MAX_FILES * 2;
const TERMINAL_PHASES = new Set<OAuthAttemptPhase>([
  "completed",
  "cancelled",
  "failed",
  "outcome_unknown",
]);

const CanonicalTimestampSchema = z
  .string()
  .length(24)
  .regex(CANONICAL_UTC_ISO_MS_PATTERN)
  .refine(isCanonicalTimestamp, "Timestamp must be a real canonical UTC ISO timestamp with milliseconds");
const CorrelationSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(BOUNDED_CORRELATION_PATTERN);
const AttemptStructuralSchema = z
  .object({
    identity: z
      .object({
        version: z.literal(1),
        expectedHostId: z.string(),
        providerId: z.literal("openai-codex"),
        operationId: z.string(),
        requestedAt: z.string(),
      })
      .strict(),
    attemptDigest: z.string(),
  })
  .strict();
const TerminalStructuralSchema = z
  .object({
    body: z
      .object({
        version: z.literal(1),
        attemptDigest: z.string(),
        phase: z.enum(["completed", "cancelled", "failed", "outcome_unknown"]),
        resolution: z.enum([
          "persistence_confirmed",
          "user_cancelled",
          "interrupted_before_login_dispatch",
          "interrupted_during_login",
          "credentials_discarded_before_persistence",
          "provider_login_failed",
          "persistence_failed",
          "expired",
          "host_shutdown",
          "configured_observed_after_recovery",
          "not_configured_observed_after_recovery",
        ]),
        configuredObserved: z.boolean().nullable(),
        terminalAt: CanonicalTimestampSchema,
      })
      .strict(),
    terminalDigest: z.string(),
  })
  .strict();
const RecordStructuralSchema = z
  .object({
    recordVersion: z.literal(1),
    attempt: AttemptStructuralSchema,
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sessionId: CorrelationSchema,
    initialAuthorityId: CorrelationSchema,
    phase: z.enum(OAUTH_ATTEMPT_PHASES),
    createdAt: CanonicalTimestampSchema,
    updatedAt: CanonicalTimestampSchema,
    expiresAt: CanonicalTimestampSchema,
    cancelIntent: z.enum(OAUTH_ATTEMPT_CANCEL_INTENTS).optional(),
    recoveryReason: z.enum(OAUTH_ATTEMPT_RECOVERY_REASONS).optional(),
    terminal: TerminalStructuralSchema.optional(),
    desktopAcknowledgedAt: CanonicalTimestampSchema.optional(),
  })
  .strict();

/**
 * Durable, secret-free OAuth attempt journal.
 *
 * The caller must initialize this store only after winning exclusive authority
 * for the canonical host data directory. The store serializes mutations inside
 * one process; it intentionally does not acquire host authority or a process
 * lock itself.
 */
export class OAuthAttemptStore {
  readonly paths: Pick<HostDataPaths, "oauthAttempts">;
  private readonly options: OAuthAttemptStoreOptions;
  private initialized = false;
  private compactionUncertain = false;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(paths: Pick<HostDataPaths, "oauthAttempts">, options: OAuthAttemptStoreOptions = {}) {
    this.paths = paths;
    this.options = options;
  }

  /** Classifies every pre-restart nonterminal before admitting public use. */
  async initialize(recoveredAt: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.initialized) return;
      const canonicalRecoveredAt = parseTimestamp(recoveredAt, "OAuth recovery timestamp");
      await ensurePrivateDirectory(this.paths.oauthAttempts);
      await assertPrivateDirectory(this.paths.oauthAttempts);
      await recoverTemporaryFiles(this.paths.oauthAttempts);
      const records = await listRecordsFromDisk(this.paths.oauthAttempts);
      if (records.filter(isOAuthAttemptBarrier).length > 1) {
        throw invalidStore("OAuth attempt storage contains more than one unresolved attempt");
      }
      for (const record of records) {
        await this.confirmExactRecordDurability(record);
        const classified = classifyRestart(record, canonicalRecoveredAt);
        if (classified !== record) {
          await this.writeVerified(record, classified);
        }
      }
      const classifiedRecords = await listRecordsFromDisk(this.paths.oauthAttempts);
      if (classifiedRecords.filter(isOAuthAttemptBarrier).length > 1) {
        throw invalidStore("OAuth attempt restart classification retained conflicting barriers");
      }
      this.initialized = true;
    });
  }

  async prepare(value: unknown): Promise<{ readonly record: OAuthAttemptRecord; readonly created: boolean }> {
    return await this.exclusive(async () => {
      this.assertAdmissionWritable();
      const input = parsePrepareInput(value);
      const path = this.recordPath(input.attempt.attemptDigest);
      const existing = await readSafeRecordFile(path, true);
      if (existing) {
        assertSamePrepareInput(existing, input);
        // Reusing the no-replace publisher confirms both the existing inode and
        // its directory entry before an ambiguous prior creator can be trusted.
        await atomicWriteJsonIfAbsent(path, existing, OAUTH_ATTEMPT_MAX_FILE_BYTES);
        const confirmed = await readSafeRecordFile(path);
        if (!isDeepStrictEqual(confirmed, existing)) {
          throw invalidStore("OAuth attempt changed while confirming an exact duplicate");
        }
        return Object.freeze({ record: confirmed!, created: false });
      }

      const records = await listRecordsFromDisk(this.paths.oauthAttempts);
      if (records.some((record) =>
        record.attempt.identity.operationId === input.attempt.identity.operationId ||
        record.sessionId === input.sessionId)) {
        throw new OAuthAttemptStoreError(
          "OAUTH_ATTEMPT_ID_CONFLICT",
          "OAuth operation or session correlation is already retained",
        );
      }
      if (records.some(isOAuthAttemptBarrier)) {
        throw new OAuthAttemptStoreError(
          "OAUTH_ATTEMPT_ID_CONFLICT",
          "Another OAuth attempt is unresolved",
        );
      }
      if (records.length >= OAUTH_ATTEMPT_MAX_FILES) {
        throw new OAuthAttemptStoreError(
          "OAUTH_ATTEMPT_STORAGE_FULL",
          "OAuth attempt storage reached its bounded record limit",
        );
      }
      try {
        assertRuntimeOAuthAttemptFreshV1(input.attempt.identity, Date.parse(input.observedAt));
      } catch (cause) {
        throw invalidStore("OAuth attempt is not fresh enough for initial creation", cause);
      }

      const record = parseRecord({
        recordVersion: 1,
        attempt: input.attempt,
        revision: 0,
        sessionId: input.sessionId,
        initialAuthorityId: input.initialAuthorityId,
        phase: "prepared",
        createdAt: input.attempt.identity.requestedAt,
        updatedAt: input.attempt.identity.requestedAt,
        expiresAt: input.expiresAt,
      });
      const created = await atomicWriteJsonIfAbsent(
        path,
        record,
        OAUTH_ATTEMPT_MAX_FILE_BYTES,
        { faultInjector: this.options.atomicCreateFaultInjector },
      );
      if (!created) {
        const winner = await readSafeRecordFile(path);
        assertSamePrepareInput(winner!, input);
        return Object.freeze({ record: winner!, created: false });
      }
      await this.options.faultInjector?.("after_prepare_publish");
      const reread = await readSafeRecordFile(path);
      if (!isDeepStrictEqual(reread, record)) {
        throw invalidStore("OAuth attempt creation was not reread exactly");
      }
      return Object.freeze({ record: reread!, created: true });
    });
  }

  /** Durable/reread login effect boundary; callers may spawn only after this returns. */
  async markLoginDispatching(record: unknown, updatedAt: string): Promise<OAuthAttemptRecord> {
    return await this.transitionPhase(record, "login_dispatching", updatedAt);
  }

  async markCredentialsReady(record: unknown, updatedAt: string): Promise<OAuthAttemptRecord> {
    return await this.transitionPhase(record, "credentials_ready", updatedAt);
  }

  /** Durable/reread storage effect boundary; callers may dispatch credentials only after this returns. */
  async markPersistenceDispatching(record: unknown, updatedAt: string): Promise<OAuthAttemptRecord> {
    return await this.transitionPhase(record, "persistence_dispatching", updatedAt);
  }

  async markCancelling(
    record: unknown,
    cancelIntent: OAuthAttemptCancelIntent,
    updatedAt: string,
  ): Promise<OAuthAttemptRecord> {
    return await this.exclusive(async () => {
      this.assertMutationWritable();
      const previous = parseRecord(record);
      const intent = parseCancelIntent(cancelIntent);
      const timestamp = parseTransitionTimestamp(previous, updatedAt);
      if (previous.phase !== "login_dispatching") {
        throw invalidStore("Only a login-dispatching OAuth attempt can enter cancelling");
      }
      return await this.replaceUnlocked(previous, parseRecord({
        ...previous,
        revision: nextRevision(previous),
        phase: "cancelling",
        updatedAt: timestamp,
        cancelIntent: intent,
      }));
    });
  }

  async markRecoveryRequired(
    record: unknown,
    recoveryReason: OAuthAttemptRecoveryReason,
    updatedAt: string,
  ): Promise<OAuthAttemptRecord> {
    return await this.exclusive(async () => {
      this.assertMutationWritable();
      const previous = parseRecord(record);
      const reason = parseRecoveryReason(recoveryReason);
      const timestamp = parseTransitionTimestamp(previous, updatedAt);
      assertRecoverySource(previous, reason);
      return await this.replaceUnlocked(previous, parseRecord({
        ...previous,
        revision: nextRevision(previous),
        phase: "recovery_required",
        updatedAt: timestamp,
        recoveryReason: reason,
      }));
    });
  }

  async settle(record: unknown, terminalValue: unknown): Promise<OAuthAttemptRecord> {
    return await this.exclusive(async () => {
      this.assertMutationWritable();
      const previous = parseRecord(record);
      const terminal = parseTerminal(terminalValue);
      if (terminal.body.attemptDigest !== previous.attempt.attemptDigest) {
        throw invalidStore("OAuth terminal evidence belongs to a different attempt");
      }
      if (Date.parse(terminal.body.terminalAt) < Date.parse(previous.updatedAt)) {
        throw invalidStore("OAuth terminal time moved backwards");
      }
      assertTerminalTransition(previous, terminal);
      const cancelIntent = cancelIntentForTerminal(previous, terminal);
      return await this.replaceUnlocked(previous, parseRecord({
        ...previous,
        revision: nextRevision(previous),
        phase: terminal.body.phase,
        updatedAt: terminal.body.terminalAt,
        ...(cancelIntent ? { cancelIntent } : {}),
        terminal,
      }));
    });
  }

  async acknowledge(
    record: unknown,
    terminalDigest: string,
    acknowledgedAt: string,
  ): Promise<OAuthAttemptRecord> {
    return await this.exclusive(async () => {
      this.assertMutationWritable();
      const supplied = parseRecord(record);
      const timestamp = parseTransitionTimestamp(supplied, acknowledgedAt);
      const current = await this.readExpectedCurrent(supplied);
      if (!current.terminal || current.terminal.terminalDigest !== terminalDigest) {
        throw invalidStore("OAuth terminal acknowledgement digest does not match");
      }
      if (current.desktopAcknowledgedAt) {
        try {
          assertLegalTransition(supplied, current);
        } catch (cause) {
          throw new OAuthAttemptStoreError(
            "OAUTH_ATTEMPT_CAS_CONFLICT",
            "OAuth terminal acknowledgement predecessor changed",
            { cause },
          );
        }
        if (current.desktopAcknowledgedAt !== timestamp) {
          throw new OAuthAttemptStoreError(
            "OAUTH_ATTEMPT_CAS_CONFLICT",
            "OAuth terminal acknowledgement timestamp changed",
          );
        }
        await this.confirmExactRecordDurability(current);
        return current;
      }
      if (!isDeepStrictEqual(current, supplied)) {
        throw new OAuthAttemptStoreError(
          "OAUTH_ATTEMPT_CAS_CONFLICT",
          "OAuth terminal acknowledgement predecessor changed",
        );
      }
      if (Date.parse(timestamp) < Date.parse(current.terminal.body.terminalAt)) {
        throw invalidStore("OAuth desktop acknowledgement predates terminal evidence");
      }
      return await this.replaceUnlocked(current, parseRecord({
        ...current,
        revision: nextRevision(current),
        updatedAt: timestamp,
        desktopAcknowledgedAt: timestamp,
      }));
    });
  }

  async get(attemptValue: unknown): Promise<OAuthAttemptRecord | undefined> {
    return await this.exclusive(async () => {
      this.assertInitialized();
      const attempt = parseAttempt(attemptValue);
      const record = await readSafeRecordFile(this.recordPath(attempt.attemptDigest), true);
      if (record && !isDeepStrictEqual(record.attempt, attempt)) {
        throw new OAuthAttemptStoreError(
          "OAUTH_ATTEMPT_ID_CONFLICT",
          "OAuth attempt digest is correlated with a different identity",
        );
      }
      return record;
    });
  }

  async list(): Promise<OAuthAttemptRecord[]> {
    return await this.exclusive(async () => {
      this.assertInitialized();
      return await listRecordsFromDisk(this.paths.oauthAttempts);
    });
  }

  async compact(now: string): Promise<OAuthAttemptCompactionResult> {
    return await this.exclusive(async () => {
      this.assertMutationWritable();
      const nowTimestamp = parseTimestamp(now, "OAuth compaction timestamp");
      const nowMs = Date.parse(nowTimestamp);
      const records = await listRecordsFromDisk(this.paths.oauthAttempts);
      const deleted: string[] = [];
      for (const record of records) {
        if (!isEligibleForCompaction(record, nowMs)) continue;
        try {
          await this.deleteDurably(record);
          deleted.push(record.attempt.attemptDigest);
        } catch (cause) {
          this.compactionUncertain = true;
          throw invalidStore("OAuth attempt compaction became uncertain", cause);
        }
      }
      const remaining = await listRecordsFromDisk(this.paths.oauthAttempts);
      return deepFreeze({
        deletedAttemptDigests: Object.freeze(deleted),
        remainingCount: remaining.length,
      });
    });
  }

  private async transitionPhase(
    record: unknown,
    phase: "login_dispatching" | "credentials_ready" | "persistence_dispatching",
    updatedAt: string,
  ): Promise<OAuthAttemptRecord> {
    return await this.exclusive(async () => {
      this.assertMutationWritable();
      const previous = parseRecord(record);
      const timestamp = parseTransitionTimestamp(previous, updatedAt);
      const expectedPrevious = phase === "login_dispatching"
        ? "prepared"
        : phase === "credentials_ready"
          ? "login_dispatching"
          : "credentials_ready";
      if (previous.phase !== expectedPrevious) {
        throw invalidStore(`OAuth attempt cannot enter ${phase} from its current phase`);
      }
      return await this.replaceUnlocked(previous, parseRecord({
        ...previous,
        revision: nextRevision(previous),
        phase,
        updatedAt: timestamp,
      }));
    });
  }

  private async replaceUnlocked(
    previous: OAuthAttemptRecord,
    next: OAuthAttemptRecord,
  ): Promise<OAuthAttemptRecord> {
    assertLegalTransition(previous, next);
    const current = await this.readExpectedCurrent(previous);
    if (!isDeepStrictEqual(current, previous)) {
      if (isDeepStrictEqual(current, next)) {
        await this.confirmExactRecordDurability(current);
        return current;
      }
      throw new OAuthAttemptStoreError(
        "OAUTH_ATTEMPT_CAS_CONFLICT",
        "OAuth attempt revision changed concurrently",
      );
    }
    await this.writeVerified(previous, next);
    return next;
  }

  private async writeVerified(previous: OAuthAttemptRecord, next: OAuthAttemptRecord): Promise<void> {
    const path = this.recordPath(previous.attempt.attemptDigest);
    await atomicWriteJson(path, next, OAUTH_ATTEMPT_MAX_FILE_BYTES);
    await this.options.faultInjector?.("after_transition_publish");
    const reread = await readSafeRecordFile(path);
    if (!isDeepStrictEqual(reread, next)) {
      throw invalidStore("OAuth attempt transition was not reread exactly");
    }
  }

  private async readExpectedCurrent(record: OAuthAttemptRecord): Promise<OAuthAttemptRecord> {
    const current = await readSafeRecordFile(this.recordPath(record.attempt.attemptDigest));
    if (!current || !isDeepStrictEqual(current.attempt, record.attempt)) {
      throw new OAuthAttemptStoreError(
        "OAUTH_ATTEMPT_ID_CONFLICT",
        "OAuth attempt identity no longer matches durable state",
      );
    }
    return current;
  }

  private async confirmExactRecordDurability(record: OAuthAttemptRecord): Promise<void> {
    const path = this.recordPath(record.attempt.attemptDigest);
    const pathMetadata = await lstat(path);
    assertSafeRecordMetadata(pathMetadata);
    const handle = await open(path, "r+");
    try {
      const opened = await handle.stat();
      if (
        opened.dev !== pathMetadata.dev ||
        opened.ino !== pathMetadata.ino ||
        opened.size !== pathMetadata.size ||
        opened.nlink !== 1
      ) {
        throw invalidStore("OAuth attempt changed before durability confirmation");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.options.faultInjector?.("after_record_file_sync");
    await syncDirectory(this.paths.oauthAttempts);
    const confirmed = await readSafeRecordFile(path);
    if (!confirmed || !isDeepStrictEqual(confirmed, record)) {
      throw invalidStore("OAuth attempt changed while confirming exact durability");
    }
  }

  private async deleteDurably(record: OAuthAttemptRecord): Promise<void> {
    const path = this.recordPath(record.attempt.attemptDigest);
    const current = await readSafeRecordFile(path);
    if (!current || !isDeepStrictEqual(current, record) || !isTerminalRecord(current)) {
      throw invalidStore("OAuth compaction target changed before deletion");
    }
    const temporary = `${path}.delete-${randomBytes(8).toString("hex")}`;
    if (await optionalLstat(temporary)) throw invalidStore("OAuth compaction temporary name already exists");
    await rename(path, temporary);
    await this.options.faultInjector?.("after_compaction_rename");
    // Only a successful directory sync authorizes the original record name as
    // durably removed. Before tombstone unlink, restart restores it. After
    // unlink, restart confirms the directory namespace and may finish the
    // already-authorized deletion without inventing an admission boundary.
    await syncDirectory(this.paths.oauthAttempts);
    await this.options.faultInjector?.("after_compaction_record_removal_sync");
    await unlink(temporary);
    await this.options.faultInjector?.("after_compaction_unlink");
    await syncDirectory(this.paths.oauthAttempts);
    await this.options.faultInjector?.("after_compaction_cleanup_sync");
    if (await optionalLstat(path) || await optionalLstat(temporary)) {
      throw invalidStore("OAuth compaction did not remove the exact record names");
    }
  }

  private recordPath(attemptDigest: string): string {
    if (!/^[a-f0-9]{64}$/.test(attemptDigest) || attemptDigest === "0".repeat(64)) {
      throw invalidStore("OAuth attempt digest cannot form a record filename");
    }
    return join(this.paths.oauthAttempts, `${attemptDigest}.json`);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("OAuth attempt store is not initialized");
  }

  private assertMutationWritable(): void {
    this.assertInitialized();
    if (this.compactionUncertain) {
      throw invalidStore("OAuth attempt store requires restart after uncertain compaction");
    }
  }

  private assertAdmissionWritable(): void {
    this.assertMutationWritable();
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

export function isOAuthAttemptBarrier(record: OAuthAttemptRecord): boolean {
  return !TERMINAL_PHASES.has(record.phase);
}

function parsePrepareInput(value: unknown): OAuthAttemptPrepareInput {
  const record = readExactPlainRecord(
    value,
    ["attempt", "sessionId", "initialAuthorityId", "observedAt", "expiresAt"],
    "OAuth prepare input",
  );
  const attempt = parseAttempt(record.attempt);
  const sessionId = parseCorrelation(record.sessionId, "OAuth session correlation");
  const initialAuthorityId = parseCorrelation(record.initialAuthorityId, "OAuth authority correlation");
  const observedAt = parseTimestamp(record.observedAt, "OAuth attempt observation time");
  const expiresAt = parseTimestamp(record.expiresAt, "OAuth attempt expiry");
  if (
    Date.parse(expiresAt) <= Date.parse(attempt.identity.requestedAt) ||
    Date.parse(expiresAt) <= Date.parse(observedAt)
  ) {
    throw invalidStore("OAuth attempt expiry must follow its requested time");
  }
  return deepFreeze({ attempt, sessionId, initialAuthorityId, observedAt, expiresAt });
}

function parseAttempt(value: unknown): RuntimeOAuthAttemptV1 {
  try {
    return parseRuntimeOAuthAttemptV1(value);
  } catch (cause) {
    throw invalidStore("OAuth attempt identity or digest is invalid", cause);
  }
}

function parseTerminal(value: unknown): RuntimeOAuthAttemptTerminalV1 {
  try {
    return parseRuntimeOAuthAttemptTerminalV1(value);
  } catch (cause) {
    throw invalidStore("OAuth terminal evidence is invalid", cause);
  }
}

function parseRecord(value: unknown): OAuthAttemptRecord {
  try {
    assertStrictPlainData(value);
    const structural = RecordStructuralSchema.parse(value);
    const attempt = parseRuntimeOAuthAttemptV1(structural.attempt);
    const terminal = structural.terminal
      ? parseRuntimeOAuthAttemptTerminalV1(structural.terminal)
      : undefined;
    const record = deepFreeze({
      ...structural,
      attempt,
      ...(terminal ? { terminal } : {}),
    }) as OAuthAttemptRecord;
    assertRecordCoherence(record);
    return record;
  } catch (cause) {
    if (cause instanceof OAuthAttemptStoreError) throw cause;
    throw invalidStore("OAuth attempt record is invalid", cause);
  }
}

function assertRecordCoherence(record: OAuthAttemptRecord): void {
  if (record.createdAt !== record.attempt.identity.requestedAt) {
    throw invalidStore("OAuth attempt creation time must equal its stable requested time");
  }
  if (
    Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
    Date.parse(record.expiresAt) <= Date.parse(record.createdAt)
  ) {
    throw invalidStore("OAuth attempt record timestamps are incoherent");
  }

  const terminalPhase = TERMINAL_PHASES.has(record.phase);
  if (terminalPhase !== Boolean(record.terminal)) {
    throw invalidStore("OAuth attempt terminal phase and evidence disagree");
  }
  if (!terminalPhase && record.desktopAcknowledgedAt) {
    throw invalidStore("A nonterminal OAuth attempt cannot be acknowledged");
  }

  if (record.phase === "cancelling") {
    if (!record.cancelIntent || record.recoveryReason) {
      throw invalidStore("Cancelling OAuth state requires only its fixed intent");
    }
  } else if (record.phase === "recovery_required") {
    if (!record.recoveryReason) throw invalidStore("OAuth recovery state requires a fixed reason");
    const cancellingRecovery = record.recoveryReason === "cancelling_helper_liveness_unconfirmed";
    if (cancellingRecovery !== Boolean(record.cancelIntent)) {
      throw invalidStore("OAuth cancelling recovery must retain its cancellation intent");
    }
  } else if (!terminalPhase && (record.cancelIntent || record.recoveryReason)) {
    throw invalidStore("OAuth running state contains terminal or recovery-only fields");
  }

  if (!record.terminal) return;
  if (
    record.terminal.body.attemptDigest !== record.attempt.attemptDigest ||
    record.terminal.body.phase !== record.phase ||
    Date.parse(record.terminal.body.terminalAt) < Date.parse(record.createdAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.terminal.body.terminalAt)
  ) {
    throw invalidStore("OAuth terminal evidence is not time- and identity-bound to its record");
  }
  if (record.desktopAcknowledgedAt) {
    if (
      record.updatedAt !== record.desktopAcknowledgedAt ||
      Date.parse(record.desktopAcknowledgedAt) < Date.parse(record.terminal.body.terminalAt)
    ) {
      throw invalidStore("OAuth desktop acknowledgement time is incoherent");
    }
  } else if (record.updatedAt !== record.terminal.body.terminalAt) {
    throw invalidStore("Unacknowledged OAuth terminal time must equal its record update time");
  }
  assertTerminalProvenance(record);
}

function assertTerminalProvenance(record: OAuthAttemptRecord): void {
  const resolution = record.terminal!.body.resolution;
  if (resolution === "user_cancelled") {
    assertCancelTerminal(record, "user");
    return;
  }
  if (resolution === "expired") {
    assertCancelTerminal(record, "expired");
    return;
  }
  if (resolution === "host_shutdown") {
    assertCancelTerminal(record, "shutdown");
    return;
  }
  if (resolution === "interrupted_during_login") {
    if (
      record.cancelIntent ||
      (record.recoveryReason !== undefined &&
        record.recoveryReason !== "login_helper_liveness_unconfirmed")
    ) {
      throw invalidStore("Interrupted login terminal evidence has invalid provenance");
    }
    return;
  }
  if (
    resolution === "configured_observed_after_recovery" ||
    resolution === "not_configured_observed_after_recovery"
  ) {
    if (record.cancelIntent || record.recoveryReason !== "storage_helper_liveness_unconfirmed") {
      throw invalidStore("Recovered configured observation requires the storage recovery reason");
    }
    return;
  }
  if (record.cancelIntent || record.recoveryReason) {
    throw invalidStore("OAuth terminal evidence retained unrelated cancellation or recovery state");
  }
}

function assertCancelTerminal(record: OAuthAttemptRecord, expected: OAuthAttemptCancelIntent): void {
  if (
    record.cancelIntent !== expected ||
    (record.recoveryReason !== undefined &&
      record.recoveryReason !== "cancelling_helper_liveness_unconfirmed")
  ) {
    throw invalidStore("OAuth cancellation terminal evidence has invalid provenance");
  }
}

function assertLegalTransition(previous: OAuthAttemptRecord, next: OAuthAttemptRecord): void {
  if (
    !isDeepStrictEqual(previous.attempt, next.attempt) ||
    previous.sessionId !== next.sessionId ||
    previous.initialAuthorityId !== next.initialAuthorityId ||
    previous.createdAt !== next.createdAt ||
    previous.expiresAt !== next.expiresAt ||
    next.revision !== previous.revision + 1 ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)
  ) {
    throw invalidStore("OAuth attempt mutation changed immutable identity or revision order");
  }
  if (isTerminalRecord(previous)) {
    const acknowledgementOnly =
      next.phase === previous.phase &&
      isDeepStrictEqual(next.terminal, previous.terminal) &&
      next.cancelIntent === previous.cancelIntent &&
      next.recoveryReason === previous.recoveryReason &&
      previous.desktopAcknowledgedAt === undefined &&
      next.desktopAcknowledgedAt !== undefined;
    if (!acknowledgementOnly) throw invalidStore("OAuth terminal attempts are immutable");
    return;
  }

  const phaseAllowed =
    (previous.phase === "prepared" && (
      next.phase === "login_dispatching" || isTerminalRecord(next)
    )) ||
    (previous.phase === "login_dispatching" && (
      next.phase === "credentials_ready" ||
      next.phase === "cancelling" ||
      next.phase === "recovery_required" ||
      isTerminalRecord(next)
    )) ||
    (previous.phase === "credentials_ready" && (
      next.phase === "persistence_dispatching" || isTerminalRecord(next)
    )) ||
    (previous.phase === "persistence_dispatching" && (
      next.phase === "recovery_required" || isTerminalRecord(next)
    )) ||
    (previous.phase === "cancelling" && (
      next.phase === "recovery_required" || isTerminalRecord(next)
    )) ||
    (previous.phase === "recovery_required" && isTerminalRecord(next));
  if (!phaseAllowed) throw invalidStore("OAuth attempt phase transition is invalid");
}

function assertTerminalTransition(
  previous: OAuthAttemptRecord,
  terminal: RuntimeOAuthAttemptTerminalV1,
): void {
  const resolution = terminal.body.resolution;
  const allowed =
    (previous.phase === "prepared" && (
      resolution === "interrupted_before_login_dispatch" ||
      resolution === "user_cancelled" ||
      resolution === "expired" ||
      resolution === "host_shutdown"
    )) ||
    (previous.phase === "login_dispatching" && (
      resolution === "provider_login_failed" || resolution === "interrupted_during_login"
    )) ||
    (previous.phase === "credentials_ready" &&
      resolution === "credentials_discarded_before_persistence") ||
    (previous.phase === "persistence_dispatching" && (
      resolution === "persistence_confirmed" || resolution === "persistence_failed"
    )) ||
    (previous.phase === "cancelling" && terminalMatchesCancellation(previous, terminal)) ||
    (previous.phase === "recovery_required" && terminalMatchesRecovery(previous, terminal));
  if (!allowed) throw invalidStore("OAuth terminal evidence is illegal from the current phase");
}

function terminalMatchesCancellation(
  record: OAuthAttemptRecord,
  terminal: RuntimeOAuthAttemptTerminalV1,
): boolean {
  return (record.cancelIntent === "user" && terminal.body.resolution === "user_cancelled") ||
    (record.cancelIntent === "expired" && terminal.body.resolution === "expired") ||
    (record.cancelIntent === "shutdown" && terminal.body.resolution === "host_shutdown");
}

function terminalMatchesRecovery(
  record: OAuthAttemptRecord,
  terminal: RuntimeOAuthAttemptTerminalV1,
): boolean {
  switch (record.recoveryReason) {
    case "login_helper_liveness_unconfirmed":
      return terminal.body.resolution === "interrupted_during_login";
    case "storage_helper_liveness_unconfirmed":
      return terminal.body.resolution === "configured_observed_after_recovery" ||
        terminal.body.resolution === "not_configured_observed_after_recovery";
    case "cancelling_helper_liveness_unconfirmed":
      return terminalMatchesCancellation(record, terminal);
    default:
      return false;
  }
}

function cancelIntentForTerminal(
  previous: OAuthAttemptRecord,
  terminal: RuntimeOAuthAttemptTerminalV1,
): OAuthAttemptCancelIntent | undefined {
  if (previous.cancelIntent) return previous.cancelIntent;
  switch (terminal.body.resolution) {
    case "user_cancelled":
      return "user";
    case "expired":
      return "expired";
    case "host_shutdown":
      return "shutdown";
    default:
      return undefined;
  }
}

function classifyRestart(record: OAuthAttemptRecord, recoveredAt: string): OAuthAttemptRecord {
  if (isTerminalRecord(record) || record.phase === "recovery_required") return record;
  const timestamp = Date.parse(recoveredAt) < Date.parse(record.updatedAt)
    ? record.updatedAt
    : recoveredAt;
  switch (record.phase) {
    case "prepared":
      return restartTerminal(record, timestamp, "failed", "interrupted_before_login_dispatch", null);
    case "login_dispatching":
      return recoveryRecord(record, timestamp, "login_helper_liveness_unconfirmed");
    case "credentials_ready":
      return restartTerminal(record, timestamp, "failed", "credentials_discarded_before_persistence", null);
    case "persistence_dispatching":
      return recoveryRecord(record, timestamp, "storage_helper_liveness_unconfirmed");
    case "cancelling":
      return recoveryRecord(record, timestamp, "cancelling_helper_liveness_unconfirmed");
  }
  throw invalidStore("OAuth restart classification encountered an invalid phase");
}

function recoveryRecord(
  record: OAuthAttemptRecord,
  updatedAt: string,
  recoveryReason: OAuthAttemptRecoveryReason,
): OAuthAttemptRecord {
  return parseRecord({
    ...record,
    revision: nextRevision(record),
    phase: "recovery_required",
    updatedAt,
    recoveryReason,
  });
}

function restartTerminal(
  record: OAuthAttemptRecord,
  terminalAt: string,
  phase: "failed",
  resolution: "interrupted_before_login_dispatch" | "credentials_discarded_before_persistence",
  configuredObserved: null,
): OAuthAttemptRecord {
  const terminal = createRuntimeOAuthAttemptTerminalV1({
    version: 1,
    attemptDigest: record.attempt.attemptDigest,
    phase,
    resolution,
    configuredObserved,
    terminalAt,
  });
  return parseRecord({
    ...record,
    revision: nextRevision(record),
    phase,
    updatedAt: terminalAt,
    terminal,
  });
}

function assertRecoverySource(record: OAuthAttemptRecord, reason: OAuthAttemptRecoveryReason): void {
  const valid =
    (record.phase === "login_dispatching" && reason === "login_helper_liveness_unconfirmed") ||
    (record.phase === "persistence_dispatching" && reason === "storage_helper_liveness_unconfirmed") ||
    (record.phase === "cancelling" && reason === "cancelling_helper_liveness_unconfirmed");
  if (!valid) throw invalidStore("OAuth recovery reason does not match its effect boundary");
}

function parseTransitionTimestamp(record: OAuthAttemptRecord, value: unknown): string {
  const timestamp = parseTimestamp(value, "OAuth transition timestamp");
  if (Date.parse(timestamp) < Date.parse(record.updatedAt)) {
    throw invalidStore("OAuth attempt time moved backwards");
  }
  return timestamp;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !isCanonicalTimestamp(value)) {
    throw invalidStore(`${label} is not a canonical UTC ISO timestamp with milliseconds`);
  }
  return value;
}

function isCanonicalTimestamp(value: string): boolean {
  if (value.length !== 24 || !CANONICAL_UTC_ISO_MS_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parseCorrelation(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !BOUNDED_CORRELATION_PATTERN.test(value)
  ) {
    throw invalidStore(`${label} is invalid`);
  }
  return value;
}

function parseCancelIntent(value: unknown): OAuthAttemptCancelIntent {
  if (
    typeof value !== "string" ||
    !OAUTH_ATTEMPT_CANCEL_INTENTS.some((candidate) => candidate === value)
  ) {
    throw invalidStore("OAuth cancellation intent is invalid");
  }
  return value as OAuthAttemptCancelIntent;
}

function parseRecoveryReason(value: unknown): OAuthAttemptRecoveryReason {
  if (
    typeof value !== "string" ||
    !OAUTH_ATTEMPT_RECOVERY_REASONS.some((candidate) => candidate === value)
  ) {
    throw invalidStore("OAuth recovery reason is invalid");
  }
  return value as OAuthAttemptRecoveryReason;
}

function nextRevision(record: OAuthAttemptRecord): number {
  if (record.revision >= Number.MAX_SAFE_INTEGER) {
    throw invalidStore("OAuth attempt revision is exhausted");
  }
  return record.revision + 1;
}

function assertSamePrepareInput(record: OAuthAttemptRecord, input: OAuthAttemptPrepareInput): void {
  if (
    !isDeepStrictEqual(record.attempt, input.attempt) ||
    record.sessionId !== input.sessionId ||
    record.initialAuthorityId !== input.initialAuthorityId ||
    record.expiresAt !== input.expiresAt
  ) {
    throw new OAuthAttemptStoreError(
      "OAUTH_ATTEMPT_ID_CONFLICT",
      "OAuth attempt identity was reused with different correlations",
    );
  }
}

function isTerminalRecord(record: OAuthAttemptRecord): boolean {
  return TERMINAL_PHASES.has(record.phase) && record.terminal !== undefined;
}

function isEligibleForCompaction(record: OAuthAttemptRecord, nowMs: number): boolean {
  if (!record.terminal || !record.desktopAcknowledgedAt) return false;
  const terminalMs = Date.parse(record.terminal.body.terminalAt);
  const acknowledgedMs = Date.parse(record.desktopAcknowledgedAt);
  return nowMs >= acknowledgedMs &&
    nowMs >= terminalMs &&
    nowMs - terminalMs >= OAUTH_ATTEMPT_TERMINAL_RETENTION_MS;
}

async function listRecordsFromDisk(directory: string): Promise<OAuthAttemptRecord[]> {
  const names = await validateBoundedDirectory(directory);
  return await Promise.all(names.map(async (name) => {
    const record = await readSafeRecordFile(join(directory, name));
    if (`${record!.attempt.attemptDigest}.json` !== name) {
      throw invalidStore("OAuth attempt filename is not correlated with its record digest");
    }
    return record!;
  }));
}

async function validateBoundedDirectory(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > OAUTH_ATTEMPT_MAX_FILES) {
    throw invalidStore("OAuth attempt storage exceeds its bounded record limit");
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !SAFE_FILE_NAME.test(entry.name)) {
      throw invalidStore("OAuth attempt storage contains an unexpected entry");
    }
    const metadata = await lstat(join(directory, entry.name));
    assertSafeRecordMetadata(metadata);
    names.push(entry.name);
  }
  return names.sort();
}

async function recoverTemporaryFiles(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > MAX_RECOVERY_ENTRIES) {
    throw invalidStore("OAuth attempt storage exceeds its bounded recovery entry limit");
  }
  let changed = false;

  // Any deletion tombstone still present at restart is restored. Once unlink
  // has removed the tombstone, the unconditional namespace sync below
  // confirms the already-authorized deletion before admission.
  for (const entry of entries) {
    const match = SAFE_DELETE_TEMP_FILE_NAME.exec(entry.name);
    if (!match) continue;
    const temporary = join(directory, entry.name);
    const metadata = await lstat(temporary);
    assertSafeTemporaryMetadata(entry, metadata, false);
    const target = join(directory, match[1]!);
    if (await optionalLstat(target)) {
      throw invalidStore("OAuth deletion recovery found both temporary and target records");
    }
    await rename(temporary, target);
    changed = true;
  }
  if (changed) await syncDirectory(directory);

  for (const entry of entries) {
    const match = SAFE_ATOMIC_TEMP_FILE_NAME.exec(entry.name);
    if (!match) continue;
    const temporary = join(directory, entry.name);
    const metadata = await lstat(temporary);
    assertSafeTemporaryMetadata(entry, metadata, true);
    const target = join(directory, match[1]!);
    const targetMetadata = await optionalLstat(target);
    if (metadata.nlink === 2) {
      if (
        !targetMetadata ||
        !targetMetadata.isFile() ||
        targetMetadata.isSymbolicLink() ||
        targetMetadata.dev !== metadata.dev ||
        targetMetadata.ino !== metadata.ino
      ) {
        throw invalidStore("OAuth atomic recovery found an uncorrelated hard link");
      }
    } else if (
      targetMetadata &&
      targetMetadata.dev === metadata.dev &&
      targetMetadata.ino === metadata.ino
    ) {
      throw invalidStore("OAuth atomic recovery found inconsistent link metadata");
    }
    await unlink(temporary);
    changed = true;
  }
  if (changed) await syncDirectory(directory);

  // This unconditional sync closes the crash window after an authorized
  // tombstone unlink but before its original cleanup sync. If the tombstone is
  // still present it was restored above; if absent, the deletion is now
  // durably confirmed before public admission.
  await syncDirectory(directory);
}

function assertSafeTemporaryMetadata(
  entry: { isFile(): boolean; isSymbolicLink(): boolean },
  metadata: Stats,
  allowPublishedHardLink: boolean,
): void {
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > OAUTH_ATTEMPT_MAX_FILE_BYTES ||
    (allowPublishedHardLink ? metadata.nlink !== 1 && metadata.nlink !== 2 : metadata.nlink !== 1)
  ) {
    throw invalidStore("OAuth atomic recovery found an unsafe temporary file");
  }
  assertPrivateMetadata(metadata);
}

async function readSafeRecordFile(
  path: string,
  optional = false,
): Promise<OAuthAttemptRecord | undefined> {
  let pathMetadata;
  try {
    pathMetadata = await lstat(path);
  } catch (cause) {
    if (optional && isErrorCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
  assertSafeRecordMetadata(pathMetadata);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size !== pathMetadata.size ||
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino ||
      before.size <= 0 ||
      before.size > OAUTH_ATTEMPT_MAX_FILE_BYTES
    ) {
      throw invalidStore("OAuth attempt state changed during safe open");
    }
    assertPrivateMetadata(before);
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(bytes, position, before.size - position, position);
      if (bytesRead <= 0) throw invalidStore("OAuth attempt state ended before its recorded size");
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
      after.ino !== before.ino ||
      after.nlink !== 1 ||
      after.mode !== before.mode ||
      after.uid !== before.uid
    ) {
      throw invalidStore("OAuth attempt state changed during bounded read");
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (cause) {
      throw invalidStore("OAuth attempt state is not valid JSON", cause);
    }
    return parseRecord(value);
  } finally {
    await handle.close();
  }
}

function assertSafeRecordMetadata(metadata: Stats): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size <= 0 ||
    metadata.size > OAUTH_ATTEMPT_MAX_FILE_BYTES
  ) {
    throw invalidStore("OAuth attempt state is not a bounded single-link regular file");
  }
  assertPrivateMetadata(metadata);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw invalidStore("OAuth attempt storage is not a private directory");
  }
  assertPrivateMetadata(metadata);
}

function assertPrivateMetadata(metadata: Stats): void {
  if (process.platform === "win32") return;
  const getuid = process.getuid;
  if ((metadata.mode & 0o077) !== 0 || (getuid && metadata.uid !== getuid())) {
    throw invalidStore("OAuth attempt storage permissions are not private to the host account");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (cause) {
    if (process.platform !== "win32") throw cause;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function optionalLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (cause) {
    if (isErrorCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
}

function assertStrictPlainData(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const inspected = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 128 || current.depth > 8) throw invalidStore("OAuth attempt value is too complex");
    const value = current.value;
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw invalidStore("OAuth attempt value contains a non-finite number");
      continue;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      throw invalidStore("OAuth attempt value is not strict plain data");
    }
    if (Object.getPrototypeOf(value) !== Object.prototype || inspected.has(value)) {
      throw invalidStore("OAuth attempt value has a non-plain prototype or cycle");
    }
    inspected.add(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > 32) throw invalidStore("OAuth attempt value has too many fields");
    for (const key of ownKeys) {
      if (typeof key !== "string") throw invalidStore("OAuth attempt value contains a symbol field");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw invalidStore("OAuth attempt value contains an accessor or hidden field");
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

function readExactPlainRecord<const K extends string>(
  value: unknown,
  expectedKeys: readonly K[],
  label: string,
): Record<K, unknown> {
  assertStrictPlainData(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidStore(`${label} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length) throw invalidStore(`${label} has unexpected fields`);
  const expected = new Set<string>(expectedKeys);
  const result = Object.create(null) as Record<K, unknown>;
  for (const key of ownKeys) {
    if (typeof key !== "string" || !expected.has(key)) {
      throw invalidStore(`${label} has unexpected fields`);
    }
    result[key as K] = Object.getOwnPropertyDescriptor(value, key)!.value;
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function invalidStore(message: string, cause?: unknown): OAuthAttemptStoreError {
  return new OAuthAttemptStoreError("OAUTH_ATTEMPT_STORE_INVALID", message, { cause });
}

function isErrorCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
