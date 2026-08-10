import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdSchema } from "../../src/shared/protocol";
import {
  RUNTIME_OAUTH_ATTEMPT_DIGEST_DOMAIN,
  RUNTIME_OAUTH_ATTEMPT_MAX_AGE_MS,
  RUNTIME_OAUTH_ATTEMPT_MAX_FUTURE_SKEW_MS,
  RUNTIME_OAUTH_TERMINAL_DIGEST_DOMAIN,
  assertRuntimeOAuthAttemptFreshV1,
  computeRuntimeOAuthAttemptDigestV1,
  computeRuntimeOAuthAttemptTerminalDigestV1,
  createRuntimeOAuthAttemptTerminalV1,
  createRuntimeOAuthAttemptV1,
  parseRuntimeOAuthAttemptIdentityV1,
  parseRuntimeOAuthAttemptTerminalBodyV1,
  parseRuntimeOAuthAttemptTerminalV1,
  parseRuntimeOAuthAttemptV1,
  type RuntimeOAuthAttemptTerminalBodyV1,
  type RuntimeOAuthAttemptTerminalResolution,
} from "../../src/shared/runtime-oauth-attempt";

const IDENTITY = {
  version: 1 as const,
  expectedHostId: "host-local:alpha_1",
  providerId: "openai-codex" as const,
  operationId: "123e4567-e89b-42d3-a456-426614174000",
  requestedAt: "2026-08-10T12:34:56.789Z",
};
const ATTEMPT_DIGEST = "60178bd8ff387878ef1d67a39c4bff0305186b1db80800775f7f96f171985571";
const TERMINAL_AT = "2026-08-10T13:00:00.000Z";
const TERMINAL_DIGEST = "203f0313ed77b5d1b4a619b868eb32667c44e97d9fb06f0dce0ebe54695cf49e";

describe("runtime OAuth durable attempt contract", () => {
  it("freezes the exact v1 attempt bytes and digest independently of input key order", () => {
    const reordered = {
      requestedAt: IDENTITY.requestedAt,
      operationId: IDENTITY.operationId,
      version: IDENTITY.version,
      providerId: IDENTITY.providerId,
      expectedHostId: IDENTITY.expectedHostId,
    };
    const canonicalBytes = RUNTIME_OAUTH_ATTEMPT_DIGEST_DOMAIN + JSON.stringify({
      expectedHostId: IDENTITY.expectedHostId,
      operationId: IDENTITY.operationId,
      providerId: IDENTITY.providerId,
      requestedAt: IDENTITY.requestedAt,
      version: IDENTITY.version,
    });

    expect(canonicalBytes).toBe(
      "prime-continuim.runtime-oauth-attempt.v1\n" +
      "{\"expectedHostId\":\"host-local:alpha_1\",\"operationId\":\"123e4567-e89b-42d3-a456-426614174000\",\"providerId\":\"openai-codex\",\"requestedAt\":\"2026-08-10T12:34:56.789Z\",\"version\":1}",
    );
    expect(createHash("sha256").update(canonicalBytes, "utf8").digest("hex")).toBe(ATTEMPT_DIGEST);
    expect(computeRuntimeOAuthAttemptDigestV1(IDENTITY)).toBe(ATTEMPT_DIGEST);
    expect(computeRuntimeOAuthAttemptDigestV1(reordered)).toBe(ATTEMPT_DIGEST);
    expect(createHash("sha256").update(canonicalBytes.replace("attempt.v1", "attempt.v2")).digest("hex"))
      .not.toBe(ATTEMPT_DIGEST);
    expect(createHash("sha256").update(
      RUNTIME_OAUTH_ATTEMPT_DIGEST_DOMAIN + JSON.stringify(IDENTITY),
    ).digest("hex")).not.toBe(ATTEMPT_DIGEST);
  });

  it("returns only newly allocated, deeply frozen plain DTOs", () => {
    const attempt = createRuntimeOAuthAttemptV1(IDENTITY);

    expect(attempt).toEqual({ identity: IDENTITY, attemptDigest: ATTEMPT_DIGEST });
    expect(attempt.identity).not.toBe(IDENTITY);
    expect(Object.getPrototypeOf(attempt)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(attempt.identity)).toBe(Object.prototype);
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(Object.isFrozen(attempt.identity)).toBe(true);
    expect(Reflect.ownKeys(attempt)).toEqual(["identity", "attemptDigest"]);
    expect(Reflect.ownKeys(attempt.identity)).toEqual([
      "version",
      "expectedHostId",
      "providerId",
      "operationId",
      "requestedAt",
    ]);
    expect(parseRuntimeOAuthAttemptV1(attempt)).toEqual(attempt);
    expect(parseRuntimeOAuthAttemptV1(attempt)).not.toBe(attempt);
  });

  it("uses the existing host ID grammar exactly", () => {
    for (const expectedHostId of ["A", "host.local:1_test-value", "A".repeat(128)]) {
      expect(IdSchema.safeParse(expectedHostId).success).toBe(true);
      expect(parseRuntimeOAuthAttemptIdentityV1({ ...IDENTITY, expectedHostId }).expectedHostId)
        .toBe(expectedHostId);
    }
    for (const expectedHostId of ["", "-host", "host name", "host/path", "host\\path", "A".repeat(129)]) {
      expect(IdSchema.safeParse(expectedHostId).success).toBe(false);
      expect(() => parseRuntimeOAuthAttemptIdentityV1({ ...IDENTITY, expectedHostId })).toThrow();
    }
  });

  it("requires the exact provider and a canonical lowercase UUIDv4 operation ID", () => {
    expect(() => parseRuntimeOAuthAttemptIdentityV1({ ...IDENTITY, providerId: "openai" })).toThrow();
    for (const operationId of [
      IDENTITY.operationId.toUpperCase(),
      "123e4567-e89b-12d3-a456-426614174000",
      "123e4567-e89b-42d3-7456-426614174000",
      "{123e4567-e89b-42d3-a456-426614174000}",
      "00000000-0000-0000-0000-000000000000",
    ]) {
      expect(() => parseRuntimeOAuthAttemptIdentityV1({ ...IDENTITY, operationId })).toThrow();
    }
  });

  it("accepts only real canonical UTC ISO timestamps with milliseconds", () => {
    for (const requestedAt of [
      "2026-08-10T12:34:56Z",
      "2026-08-10T12:34:56.78Z",
      "2026-08-10T12:34:56.7890Z",
      "2026-08-10T08:34:56.789-04:00",
      "2026-08-10 12:34:56.789Z",
      "2026-08-10T12:34:56.789z",
      "2026-02-29T12:34:56.789Z",
      "+012026-08-10T12:34:56.789Z",
    ]) {
      expect(() => parseRuntimeOAuthAttemptIdentityV1({ ...IDENTITY, requestedAt })).toThrow();
    }
    expect(() => parseRuntimeOAuthAttemptTerminalBodyV1({
      ...terminalBody(),
      terminalAt: "2026-08-10T13:00:00Z",
    })).toThrow();
  });

  it("separates identity parsing from inclusive new-start freshness boundaries", () => {
    const requestedAtMs = Date.parse(IDENTITY.requestedAt);
    const stale = { ...IDENTITY, requestedAt: "2020-01-01T00:00:00.000Z" };

    expect(parseRuntimeOAuthAttemptIdentityV1(stale).requestedAt).toBe(stale.requestedAt);
    expect(assertRuntimeOAuthAttemptFreshV1(
      IDENTITY,
      requestedAtMs + RUNTIME_OAUTH_ATTEMPT_MAX_AGE_MS,
    )).toEqual(IDENTITY);
    expect(() => assertRuntimeOAuthAttemptFreshV1(
      IDENTITY,
      requestedAtMs + RUNTIME_OAUTH_ATTEMPT_MAX_AGE_MS + 1,
    )).toThrow(/too old/);
    expect(assertRuntimeOAuthAttemptFreshV1(
      IDENTITY,
      requestedAtMs - RUNTIME_OAUTH_ATTEMPT_MAX_FUTURE_SKEW_MS,
    )).toEqual(IDENTITY);
    expect(() => assertRuntimeOAuthAttemptFreshV1(
      IDENTITY,
      requestedAtMs - RUNTIME_OAUTH_ATTEMPT_MAX_FUTURE_SKEW_MS - 1,
    )).toThrow(/future/);
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, requestedAtMs + 0.5, 8_640_000_000_000_001]) {
      expect(() => assertRuntimeOAuthAttemptFreshV1(IDENTITY, nowMs)).toThrow(/clock/);
    }
  });

  it("rejects accessors without invoking them, hidden fields, symbols, extras, and altered prototypes", () => {
    let reads = 0;
    const accessor = { ...IDENTITY } as Record<string, unknown>;
    Object.defineProperty(accessor, "operationId", {
      enumerable: true,
      get() {
        reads += 1;
        return IDENTITY.operationId;
      },
    });
    expect(() => parseRuntimeOAuthAttemptIdentityV1(accessor)).toThrow(/accessor/);
    expect(reads).toBe(0);

    const hiddenExpected = { ...IDENTITY } as Record<string, unknown>;
    Object.defineProperty(hiddenExpected, "requestedAt", {
      enumerable: false,
      value: IDENTITY.requestedAt,
    });
    expect(() => parseRuntimeOAuthAttemptIdentityV1(hiddenExpected)).toThrow(/hidden/);

    const hiddenExtra = { ...IDENTITY };
    Object.defineProperty(hiddenExtra, "accessToken", { enumerable: false, value: "never-read" });
    expect(() => parseRuntimeOAuthAttemptIdentityV1(hiddenExtra)).toThrow(/unexpected/);

    const symbolExtra = { ...IDENTITY, [Symbol("state")]: "never-read" };
    expect(() => parseRuntimeOAuthAttemptIdentityV1(symbolExtra)).toThrow(/unexpected/);
    expect(() => parseRuntimeOAuthAttemptIdentityV1({ ...IDENTITY, account: "never-read" })).toThrow(/unexpected/);

    const inherited = Object.create({ credential: "never-read" }) as Record<string, unknown>;
    Object.assign(inherited, IDENTITY);
    expect(() => parseRuntimeOAuthAttemptIdentityV1(inherited)).toThrow(/plain object/);

    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, IDENTITY);
    expect(() => parseRuntimeOAuthAttemptIdentityV1(nullPrototype)).toThrow(/plain object/);
  });

  it("rejects malformed, zero, uppercase, wrong, accessor, and decorated attempt digests", () => {
    const valid = createRuntimeOAuthAttemptV1(IDENTITY);
    for (const attemptDigest of [
      "0".repeat(64),
      ATTEMPT_DIGEST.toUpperCase(),
      "f".repeat(64),
      ATTEMPT_DIGEST.slice(1),
    ]) {
      expect(() => parseRuntimeOAuthAttemptV1({ identity: IDENTITY, attemptDigest })).toThrow();
    }

    let reads = 0;
    const accessor = { identity: IDENTITY } as Record<string, unknown>;
    Object.defineProperty(accessor, "attemptDigest", {
      enumerable: true,
      get() {
        reads += 1;
        return ATTEMPT_DIGEST;
      },
    });
    expect(() => parseRuntimeOAuthAttemptV1(accessor)).toThrow(/accessor/);
    expect(reads).toBe(0);
    expect(() => parseRuntimeOAuthAttemptV1({ ...valid, url: "https://example.test" })).toThrow(/unexpected/);
    expect(() => parseRuntimeOAuthAttemptV1({ ...valid, [Symbol("hidden")]: true })).toThrow(/unexpected/);
  });

  it("freezes the exact v1 terminal bytes and digest", () => {
    const input = terminalBody();
    const terminal = createRuntimeOAuthAttemptTerminalV1(input);
    const canonicalBytes = RUNTIME_OAUTH_TERMINAL_DIGEST_DOMAIN + JSON.stringify({
      attemptDigest: ATTEMPT_DIGEST,
      phase: "outcome_unknown",
      resolution: "configured_observed_after_recovery",
      configuredObserved: true,
      terminalAt: TERMINAL_AT,
      version: 1,
    });

    expect(createHash("sha256").update(canonicalBytes, "utf8").digest("hex")).toBe(TERMINAL_DIGEST);
    expect(computeRuntimeOAuthAttemptTerminalDigestV1(terminal.body)).toBe(TERMINAL_DIGEST);
    expect(terminal).toEqual({ body: terminalBody(), terminalDigest: TERMINAL_DIGEST });
    expect(terminal.body).not.toBe(input);
    expect(Object.isFrozen(terminal)).toBe(true);
    expect(Object.isFrozen(terminal.body)).toBe(true);
    expect(Reflect.ownKeys(terminal)).toEqual(["body", "terminalDigest"]);
    expect(Reflect.ownKeys(terminal.body)).toEqual([
      "version",
      "attemptDigest",
      "phase",
      "resolution",
      "configuredObserved",
      "terminalAt",
    ]);
    const parsed = parseRuntimeOAuthAttemptTerminalV1(terminal);
    expect(parsed).toEqual(terminal);
    expect(parsed).not.toBe(terminal);
    expect(parsed.body).not.toBe(terminal.body);
  });

  it("admits only the fixed coherent terminal phase, resolution, and observation matrix", () => {
    const failedResolutions: RuntimeOAuthAttemptTerminalResolution[] = [
      "interrupted_before_login_dispatch",
      "interrupted_during_login",
      "credentials_discarded_before_persistence",
      "provider_login_failed",
      "persistence_failed",
      "expired",
      "host_shutdown",
    ];
    const coherent: Array<Pick<RuntimeOAuthAttemptTerminalBodyV1,
      "phase" | "resolution" | "configuredObserved">> = [
      { phase: "completed", resolution: "persistence_confirmed", configuredObserved: true },
      { phase: "cancelled", resolution: "user_cancelled", configuredObserved: null },
      ...failedResolutions.map((resolution) => ({
        phase: "failed" as const,
        resolution,
        configuredObserved: null,
      })),
      {
        phase: "outcome_unknown",
        resolution: "configured_observed_after_recovery",
        configuredObserved: true,
      },
      {
        phase: "outcome_unknown",
        resolution: "not_configured_observed_after_recovery",
        configuredObserved: false,
      },
    ];
    for (const combination of coherent) {
      expect(parseRuntimeOAuthAttemptTerminalBodyV1({
        ...terminalBody(),
        ...combination,
      })).toMatchObject(combination);
    }

    for (const combination of [
      { phase: "completed", resolution: "persistence_confirmed", configuredObserved: null },
      { phase: "completed", resolution: "user_cancelled", configuredObserved: true },
      { phase: "cancelled", resolution: "user_cancelled", configuredObserved: true },
      { phase: "failed", resolution: "provider_login_failed", configuredObserved: false },
      {
        phase: "outcome_unknown",
        resolution: "configured_observed_after_recovery",
        configuredObserved: false,
      },
      {
        phase: "outcome_unknown",
        resolution: "persistence_failed",
        configuredObserved: null,
      },
    ]) {
      expect(() => parseRuntimeOAuthAttemptTerminalBodyV1({
        ...terminalBody(),
        ...combination,
      })).toThrow(/incoherent/);
    }
    expect(() => parseRuntimeOAuthAttemptTerminalBodyV1({
      ...terminalBody(),
      phase: "recovery_required",
    })).toThrow(/phase/);
    expect(() => parseRuntimeOAuthAttemptTerminalBodyV1({
      ...terminalBody(),
      resolution: "helper_liveness_unconfirmed",
    })).toThrow(/resolution/);
  });

  it("rejects decorated terminal bodies and invalid terminal digests without invoking accessors", () => {
    const terminal = createRuntimeOAuthAttemptTerminalV1(terminalBody());
    let reads = 0;
    const accessor = { ...terminalBody() } as Record<string, unknown>;
    Object.defineProperty(accessor, "resolution", {
      enumerable: true,
      get() {
        reads += 1;
        return "configured_observed_after_recovery";
      },
    });
    expect(() => parseRuntimeOAuthAttemptTerminalBodyV1(accessor)).toThrow(/accessor/);
    expect(reads).toBe(0);

    const hidden = { ...terminalBody() };
    Object.defineProperty(hidden, "authorizationUrl", { enumerable: false, value: "never-read" });
    expect(() => parseRuntimeOAuthAttemptTerminalBodyV1(hidden)).toThrow(/unexpected/);
    expect(() => parseRuntimeOAuthAttemptTerminalBodyV1({
      ...terminalBody(),
      [Symbol("credential")]: "never-read",
    })).toThrow(/unexpected/);
    expect(() => parseRuntimeOAuthAttemptTerminalV1({ ...terminal, pid: 31337 })).toThrow(/unexpected/);
    expect(() => parseRuntimeOAuthAttemptTerminalV1({
      body: terminal.body,
      terminalDigest: "0".repeat(64),
    })).toThrow(/nonzero/);
    expect(() => parseRuntimeOAuthAttemptTerminalV1({
      body: terminal.body,
      terminalDigest: TERMINAL_DIGEST.toUpperCase(),
    })).toThrow(/lowercase/);
    expect(() => parseRuntimeOAuthAttemptTerminalV1({
      body: terminal.body,
      terminalDigest: "f".repeat(64),
    })).toThrow(/does not match/);
  });

  it("domain-separates attempt and terminal digests and rejects cross-feed", () => {
    const attempt = createRuntimeOAuthAttemptV1(IDENTITY);
    const terminal = createRuntimeOAuthAttemptTerminalV1(terminalBody());

    expect(attempt.attemptDigest).not.toBe(terminal.terminalDigest);
    expect(() => parseRuntimeOAuthAttemptV1({
      identity: attempt.identity,
      attemptDigest: terminal.terminalDigest,
    })).toThrow(/does not match/);
    expect(() => parseRuntimeOAuthAttemptTerminalV1({
      body: terminal.body,
      terminalDigest: attempt.attemptDigest,
    })).toThrow(/does not match/);
    expect(createHash("sha256").update(
      RUNTIME_OAUTH_ATTEMPT_DIGEST_DOMAIN + JSON.stringify({
        attemptDigest: ATTEMPT_DIGEST,
        phase: terminal.body.phase,
        resolution: terminal.body.resolution,
        configuredObserved: terminal.body.configuredObserved,
        terminalAt: terminal.body.terminalAt,
        version: terminal.body.version,
      }),
    ).digest("hex")).not.toBe(terminal.terminalDigest);
  });

  it("keeps every returned DTO free of secret-bearing and process-custody fields", () => {
    const attempt = createRuntimeOAuthAttemptV1(IDENTITY);
    const terminal = createRuntimeOAuthAttemptTerminalV1(terminalBody());
    const forbiddenKeys = new Set([
      "path",
      "url",
      "authorization",
      "challenge",
      "progress",
      "state",
      "code",
      "credential",
      "credentials",
      "accessToken",
      "refreshToken",
      "account",
      "error",
      "pid",
    ]);

    expect(collectKeys(attempt).some((key) => forbiddenKeys.has(key))).toBe(false);
    expect(collectKeys(terminal).some((key) => forbiddenKeys.has(key))).toBe(false);
    for (const value of collectStrings({ attempt, terminal })) {
      expect(value).not.toMatch(/^(?:https?|file):/i);
      expect(value).not.toContain("\\");
      expect(value).not.toContain("/");
    }
  });
});

function terminalBody(): RuntimeOAuthAttemptTerminalBodyV1 {
  return {
    version: 1,
    attemptDigest: ATTEMPT_DIGEST,
    phase: "outcome_unknown",
    resolution: "configured_observed_after_recovery",
    configuredObserved: true,
    terminalAt: TERMINAL_AT,
  };
}

function collectKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Reflect.ownKeys(value).flatMap((key) => [
    typeof key === "string" ? key : key.description ?? "symbol",
    ...collectKeys(Object.getOwnPropertyDescriptor(value, key)?.value),
  ]);
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Reflect.ownKeys(value).flatMap((key) =>
    collectStrings(Object.getOwnPropertyDescriptor(value, key)?.value));
}
