import { createHash } from "node:crypto";
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from "./codex-oauth";

export const RUNTIME_OAUTH_ATTEMPT_VERSION = 1 as const;
export const RUNTIME_OAUTH_ATTEMPT_DIGEST_DOMAIN = "prime-continuim.runtime-oauth-attempt.v1\n" as const;
export const RUNTIME_OAUTH_TERMINAL_DIGEST_DOMAIN = "prime-continuim.runtime-oauth-terminal.v1\n" as const;
export const RUNTIME_OAUTH_ATTEMPT_MAX_AGE_MS = 5 * 60 * 1_000;
export const RUNTIME_OAUTH_ATTEMPT_MAX_FUTURE_SKEW_MS = 30 * 1_000;

export const RUNTIME_OAUTH_ATTEMPT_TERMINAL_PHASES = Object.freeze([
  "completed",
  "cancelled",
  "failed",
  "outcome_unknown",
] as const);

export const RUNTIME_OAUTH_ATTEMPT_TERMINAL_RESOLUTIONS = Object.freeze([
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
] as const);

export type RuntimeOAuthAttemptTerminalPhase =
  (typeof RUNTIME_OAUTH_ATTEMPT_TERMINAL_PHASES)[number];
export type RuntimeOAuthAttemptTerminalResolution =
  (typeof RUNTIME_OAUTH_ATTEMPT_TERMINAL_RESOLUTIONS)[number];

export interface RuntimeOAuthAttemptIdentityV1 {
  readonly version: typeof RUNTIME_OAUTH_ATTEMPT_VERSION;
  readonly expectedHostId: string;
  readonly providerId: typeof CODEX_SUBSCRIPTION_PROVIDER_ID;
  readonly operationId: string;
  readonly requestedAt: string;
}

export interface RuntimeOAuthAttemptV1 {
  readonly identity: RuntimeOAuthAttemptIdentityV1;
  readonly attemptDigest: string;
}

export interface RuntimeOAuthAttemptTerminalBodyV1 {
  readonly version: typeof RUNTIME_OAUTH_ATTEMPT_VERSION;
  readonly attemptDigest: string;
  readonly phase: RuntimeOAuthAttemptTerminalPhase;
  readonly resolution: RuntimeOAuthAttemptTerminalResolution;
  readonly configuredObserved: boolean | null;
  readonly terminalAt: string;
}

export interface RuntimeOAuthAttemptTerminalV1 {
  readonly body: RuntimeOAuthAttemptTerminalBodyV1;
  readonly terminalDigest: string;
}

const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const LOWERCASE_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_UTC_ISO_MS_PATTERN =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/;
const LOWERCASE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ALL_ZERO_SHA256 = "0".repeat(64);
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

const IDENTITY_KEYS = Object.freeze([
  "version",
  "expectedHostId",
  "providerId",
  "operationId",
  "requestedAt",
] as const);
const ATTEMPT_KEYS = Object.freeze(["identity", "attemptDigest"] as const);
const TERMINAL_BODY_KEYS = Object.freeze([
  "version",
  "attemptDigest",
  "phase",
  "resolution",
  "configuredObserved",
  "terminalAt",
] as const);
const TERMINAL_KEYS = Object.freeze(["body", "terminalDigest"] as const);

/**
 * Parses the stable identity only. Freshness is intentionally not checked so
 * restart reconciliation can validate an existing durable identity without
 * pretending it is a new start request.
 */
export function parseRuntimeOAuthAttemptIdentityV1(value: unknown): RuntimeOAuthAttemptIdentityV1 {
  const record = readExactPlainRecord(value, IDENTITY_KEYS, "OAuth attempt identity");
  if (record.version !== RUNTIME_OAUTH_ATTEMPT_VERSION) invalid("OAuth attempt version is invalid");
  const expectedHostId = parseExpectedHostId(record.expectedHostId);
  if (record.providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID) invalid("OAuth attempt provider is invalid");
  const operationId = parseOperationId(record.operationId);
  const requestedAt = parseCanonicalTimestamp(record.requestedAt, "OAuth attempt requestedAt");

  return Object.freeze({
    version: RUNTIME_OAUTH_ATTEMPT_VERSION,
    expectedHostId,
    providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
    operationId,
    requestedAt,
  });
}

/** New-start admission check. Boundary values are inclusive. */
export function assertRuntimeOAuthAttemptFreshV1(
  value: unknown,
  nowMs: number,
): RuntimeOAuthAttemptIdentityV1 {
  const identity = parseRuntimeOAuthAttemptIdentityV1(value);
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < -MAX_DATE_MILLISECONDS ||
    nowMs > MAX_DATE_MILLISECONDS
  ) {
    invalid("OAuth attempt freshness clock is invalid");
  }
  const requestedAtMs = Date.parse(identity.requestedAt);
  if (nowMs - requestedAtMs > RUNTIME_OAUTH_ATTEMPT_MAX_AGE_MS) {
    invalid("OAuth attempt is too old for a new start");
  }
  if (requestedAtMs - nowMs > RUNTIME_OAUTH_ATTEMPT_MAX_FUTURE_SKEW_MS) {
    invalid("OAuth attempt is too far in the future for a new start");
  }
  return identity;
}

export function computeRuntimeOAuthAttemptDigestV1(value: unknown): string {
  const identity = parseRuntimeOAuthAttemptIdentityV1(value);
  return sha256(
    RUNTIME_OAUTH_ATTEMPT_DIGEST_DOMAIN +
      JSON.stringify({
        expectedHostId: identity.expectedHostId,
        operationId: identity.operationId,
        providerId: identity.providerId,
        requestedAt: identity.requestedAt,
        version: identity.version,
      }),
  );
}

export function createRuntimeOAuthAttemptV1(value: unknown): RuntimeOAuthAttemptV1 {
  const identity = parseRuntimeOAuthAttemptIdentityV1(value);
  return Object.freeze({
    identity,
    attemptDigest: computeRuntimeOAuthAttemptDigestV1(identity),
  });
}

export function parseRuntimeOAuthAttemptV1(value: unknown): RuntimeOAuthAttemptV1 {
  const record = readExactPlainRecord(value, ATTEMPT_KEYS, "OAuth attempt");
  const identity = parseRuntimeOAuthAttemptIdentityV1(record.identity);
  const attemptDigest = parseDigest(record.attemptDigest, "OAuth attempt digest");
  if (attemptDigest !== computeRuntimeOAuthAttemptDigestV1(identity)) {
    invalid("OAuth attempt digest does not match its identity");
  }
  return Object.freeze({ identity, attemptDigest });
}

export function parseRuntimeOAuthAttemptTerminalBodyV1(
  value: unknown,
): RuntimeOAuthAttemptTerminalBodyV1 {
  const record = readExactPlainRecord(value, TERMINAL_BODY_KEYS, "OAuth attempt terminal body");
  if (record.version !== RUNTIME_OAUTH_ATTEMPT_VERSION) invalid("OAuth terminal version is invalid");
  const attemptDigest = parseDigest(record.attemptDigest, "OAuth attempt digest");
  const phase = parseTerminalPhase(record.phase);
  const resolution = parseTerminalResolution(record.resolution);
  if (record.configuredObserved !== null && typeof record.configuredObserved !== "boolean") {
    invalid("OAuth terminal configured observation is invalid");
  }
  const configuredObserved = record.configuredObserved;
  if (!isCoherentTerminal(phase, resolution, configuredObserved)) {
    invalid("OAuth terminal phase, resolution, and configured observation are incoherent");
  }
  const terminalAt = parseCanonicalTimestamp(record.terminalAt, "OAuth terminal terminalAt");

  return Object.freeze({
    version: RUNTIME_OAUTH_ATTEMPT_VERSION,
    attemptDigest,
    phase,
    resolution,
    configuredObserved,
    terminalAt,
  });
}

export function computeRuntimeOAuthAttemptTerminalDigestV1(value: unknown): string {
  const body = parseRuntimeOAuthAttemptTerminalBodyV1(value);
  return sha256(
    RUNTIME_OAUTH_TERMINAL_DIGEST_DOMAIN +
      JSON.stringify({
        attemptDigest: body.attemptDigest,
        phase: body.phase,
        resolution: body.resolution,
        configuredObserved: body.configuredObserved,
        terminalAt: body.terminalAt,
        version: body.version,
      }),
  );
}

export function createRuntimeOAuthAttemptTerminalV1(value: unknown): RuntimeOAuthAttemptTerminalV1 {
  const body = parseRuntimeOAuthAttemptTerminalBodyV1(value);
  return Object.freeze({
    body,
    terminalDigest: computeRuntimeOAuthAttemptTerminalDigestV1(body),
  });
}

export function parseRuntimeOAuthAttemptTerminalV1(value: unknown): RuntimeOAuthAttemptTerminalV1 {
  const record = readExactPlainRecord(value, TERMINAL_KEYS, "OAuth attempt terminal");
  const body = parseRuntimeOAuthAttemptTerminalBodyV1(record.body);
  const terminalDigest = parseDigest(record.terminalDigest, "OAuth terminal digest");
  if (terminalDigest !== computeRuntimeOAuthAttemptTerminalDigestV1(body)) {
    invalid("OAuth terminal digest does not match its body");
  }
  return Object.freeze({ body, terminalDigest });
}

function parseExpectedHostId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !HOST_ID_PATTERN.test(value)
  ) {
    invalid("OAuth attempt expectedHostId is invalid");
  }
  return value;
}

function parseOperationId(value: unknown): string {
  if (typeof value !== "string" || !LOWERCASE_UUID_V4_PATTERN.test(value)) {
    invalid("OAuth attempt operationId is not a canonical lowercase UUIDv4");
  }
  return value;
}

function parseCanonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length !== 24 ||
    !CANONICAL_UTC_ISO_MS_PATTERN.test(value)
  ) {
    invalid(`${label} is not a canonical UTC ISO timestamp with milliseconds`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    invalid(`${label} is not a real canonical UTC timestamp`);
  }
  return value;
}

function parseDigest(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !LOWERCASE_SHA256_PATTERN.test(value) ||
    value === ALL_ZERO_SHA256
  ) {
    invalid(`${label} is not a canonical nonzero lowercase SHA-256`);
  }
  return value;
}

function parseTerminalPhase(value: unknown): RuntimeOAuthAttemptTerminalPhase {
  if (
    typeof value !== "string" ||
    !RUNTIME_OAUTH_ATTEMPT_TERMINAL_PHASES.some((candidate) => candidate === value)
  ) {
    invalid("OAuth terminal phase is invalid");
  }
  return value as RuntimeOAuthAttemptTerminalPhase;
}

function parseTerminalResolution(value: unknown): RuntimeOAuthAttemptTerminalResolution {
  if (
    typeof value !== "string" ||
    !RUNTIME_OAUTH_ATTEMPT_TERMINAL_RESOLUTIONS.some((candidate) => candidate === value)
  ) {
    invalid("OAuth terminal resolution is invalid");
  }
  return value as RuntimeOAuthAttemptTerminalResolution;
}

function isCoherentTerminal(
  phase: RuntimeOAuthAttemptTerminalPhase,
  resolution: RuntimeOAuthAttemptTerminalResolution,
  configuredObserved: boolean | null,
): boolean {
  switch (phase) {
    case "completed":
      return resolution === "persistence_confirmed" && configuredObserved === true;
    case "cancelled":
      return resolution === "user_cancelled" && configuredObserved === null;
    case "failed":
      return configuredObserved === null && (
        resolution === "interrupted_before_login_dispatch" ||
        resolution === "interrupted_during_login" ||
        resolution === "credentials_discarded_before_persistence" ||
        resolution === "provider_login_failed" ||
        resolution === "persistence_failed" ||
        resolution === "expired" ||
        resolution === "host_shutdown"
      );
    case "outcome_unknown":
      return (
        resolution === "configured_observed_after_recovery" && configuredObserved === true
      ) || (
        resolution === "not_configured_observed_after_recovery" && configuredObserved === false
      );
  }
}

function readExactPlainRecord<const K extends string>(
  value: unknown,
  expectedKeys: readonly K[],
  label: string,
): Record<K, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(`${label} must be a plain object`);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length) invalid(`${label} has unexpected fields`);
  const expected = new Set<string>(expectedKeys);
  const result = Object.create(null) as Record<K, unknown>;
  for (const key of ownKeys) {
    if (typeof key !== "string" || !expected.has(key)) invalid(`${label} has unexpected fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      invalid(`${label} contains an accessor or hidden field`);
    }
    result[key as K] = descriptor.value;
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalid(message: string): never {
  throw new TypeError(message);
}
