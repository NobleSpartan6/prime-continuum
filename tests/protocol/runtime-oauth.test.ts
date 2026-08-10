import { describe, expect, it } from "vitest";
import {
  HostIpcErrorResponseSchema,
  HostIpcRequestSchema,
  HostIpcSuccessResponseSchema,
  RUNTIME_OAUTH_ATTEMPT_CAPABILITY,
  RuntimeOAuthAttemptAcknowledgeResultSchema,
  RuntimeOAuthAttemptAcknowledgeRequestSchema,
  RuntimeOAuthAttemptCancelResultSchema,
  RuntimeOAuthAttemptEffectResultSchema,
  RuntimeOAuthAttemptRecordSchema,
  RuntimeOAuthAttemptStartResultSchema,
  RuntimeOAuthAttemptStatusResultSchema,
  RuntimeOAuthAttemptTerminalV1Schema,
  RuntimeOAuthAttemptV1Schema,
  RuntimeOAuthSessionSnapshotSchema,
} from "../../src/shared/protocol";
import {
  createRuntimeOAuthAttemptTerminalV1,
  createRuntimeOAuthAttemptV1,
  type RuntimeOAuthAttemptV1,
} from "../../src/shared/runtime-oauth-attempt";

describe("runtime OAuth wire contract", () => {
  it("accepts the sanitized host-to-main session state and rejects credential-shaped expansion", () => {
    const snapshot = {
      sessionId: "oauth-session-1",
      providerId: "openai-codex",
      phase: "awaiting_user",
      expiresAt: "2026-08-07T18:00:00.000Z",
      authorization: { url: validAuthorizationUrl() },
      challenge: {
        id: "challenge-1",
        kind: "manual_redirect",
        message: "Complete sign-in in the browser",
        allowEmpty: false,
      },
    };
    expect(RuntimeOAuthSessionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(RuntimeOAuthSessionSnapshotSchema.safeParse({
      ...snapshot,
      accessToken: "must-not-cross",
    }).success).toBe(false);
    expect(RuntimeOAuthSessionSnapshotSchema.safeParse({
      ...snapshot,
      authorization: { url: validAuthorizationUrl("https://attacker.example") },
    }).success).toBe(false);
  });

  it("has no renderer/manual-response method capable of carrying an OAuth code", () => {
    expect(HostIpcRequestSchema.safeParse({
      protocolVersion: 1,
      requestId: "request-1",
      method: "oauth.session.respond",
      payload: {
        expectedHostId: "host-1",
        authorityId: "desktop-1",
        sessionId: "session-1",
        challengeId: "challenge-1",
        value: "authorization-code",
      },
    }).success).toBe(false);
    expect(HostIpcRequestSchema.safeParse({
      protocolVersion: 1,
      requestId: "request-2",
      method: "oauth.attempt.respond",
      payload: {
        attempt: attemptFixture(),
        value: "authorization-code",
      },
    }).success).toBe(false);
  });

  it("advertises a distinct additive durable-attempt capability", () => {
    expect(RUNTIME_OAUTH_ATTEMPT_CAPABILITY).toBe("runtime_oauth_attempt_v1");
  });

  it("uses the authoritative strict attempt and terminal parsers at the wire boundary", () => {
    const attempt = attemptFixture();
    const terminal = completedTerminal(attempt);
    expect(RuntimeOAuthAttemptV1Schema.parse(attempt)).toEqual(attempt);
    expect(RuntimeOAuthAttemptTerminalV1Schema.parse(terminal)).toEqual(terminal);

    expect(RuntimeOAuthAttemptV1Schema.safeParse({ ...attempt, path: "C:\\secret" }).success).toBe(false);
    expect(RuntimeOAuthAttemptV1Schema.safeParse({
      ...attempt,
      attemptDigest: "f".repeat(64),
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptTerminalV1Schema.safeParse({
      ...terminal,
      accessToken: "must-not-cross",
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptTerminalV1Schema.safeParse({
      ...terminal,
      terminalDigest: "e".repeat(64),
    }).success).toBe(false);
  });

  it("accepts only the four exact durable-attempt request payloads", () => {
    const attempt = attemptFixture();
    const terminal = completedTerminal(attempt);
    const requests = [
      {
        protocolVersion: 1,
        requestId: "request-start",
        method: "oauth.attempt.start",
        payload: { authorityId: "desktop-oauth-1", attempt },
      },
      {
        protocolVersion: 1,
        requestId: "request-status",
        method: "oauth.attempt.status",
        payload: { attempt },
      },
      {
        protocolVersion: 1,
        requestId: "request-cancel",
        method: "oauth.attempt.cancel",
        payload: { attempt },
      },
      {
        protocolVersion: 1,
        requestId: "request-acknowledge",
        method: "oauth.attempt.acknowledge",
        payload: {
          attempt,
          expectedRevision: 0,
          terminalDigest: terminal.terminalDigest,
          acknowledgedAt: "2026-08-07T18:02:00.000Z",
        },
      },
    ] as const;

    for (const request of requests) expect(HostIpcRequestSchema.parse(request)).toEqual(request);

    expect(HostIpcRequestSchema.safeParse({
      ...requests[0],
      unexpected: true,
    }).success).toBe(false);
    expect(HostIpcRequestSchema.safeParse({
      ...requests[0],
      payload: { ...requests[0].payload, expectedHostId: "host-1" },
    }).success).toBe(false);
    expect(HostIpcRequestSchema.safeParse({
      ...requests[1],
      payload: { ...requests[1].payload, authorityId: "desktop-oauth-1" },
    }).success).toBe(false);
    expect(HostIpcRequestSchema.safeParse({
      ...requests[2],
      payload: { ...requests[2].payload, accessToken: "must-not-cross" },
    }).success).toBe(false);

    const acknowledgement = requests[3].payload;
    for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      expect(RuntimeOAuthAttemptAcknowledgeRequestSchema.safeParse({
        ...acknowledgement,
        expectedRevision,
      }).success).toBe(false);
    }
    expect(RuntimeOAuthAttemptAcknowledgeRequestSchema.safeParse({
      ...acknowledgement,
      terminalDigest: "0".repeat(64),
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptAcknowledgeRequestSchema.safeParse({
      ...acknowledgement,
      acknowledgedAt: "2026-08-07T18:02:00Z",
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptAcknowledgeRequestSchema.safeParse({
      ...acknowledgement,
      refreshToken: "must-not-cross",
    }).success).toBe(false);
  });

  it("projects only coherent secret-free durable host records", () => {
    const record = activeRecord();
    expect(RuntimeOAuthAttemptRecordSchema.parse(record)).toEqual(record);

    for (const [field, value] of [
      ["initialAuthorityId", "desktop-oauth-1"],
      ["cancelIntent", "user"],
      ["recoveryReason", "login_helper_liveness_unconfirmed"],
      ["path", "C:\\oauth-attempt.json"],
      ["accessToken", "must-not-cross"],
      ["credentials", { access: "must-not-cross" }],
    ] as const) {
      expect(RuntimeOAuthAttemptRecordSchema.safeParse({ ...record, [field]: value }).success).toBe(false);
    }

    expect(RuntimeOAuthAttemptRecordSchema.safeParse({ ...record, revision: -1 }).success).toBe(false);
    expect(RuntimeOAuthAttemptRecordSchema.safeParse({ ...record, revision: 0 }).success).toBe(false);
    expect(RuntimeOAuthAttemptRecordSchema.safeParse({
      ...record,
      phase: "prepared",
      revision: 1,
      updatedAt: record.createdAt,
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptRecordSchema.safeParse({
      ...record,
      createdAt: "2026-08-07T17:59:59.000Z",
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptRecordSchema.safeParse({
      ...record,
      phase: "completed",
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptRecordSchema.safeParse({
      ...record,
      desktopAcknowledgedAt: "2026-08-07T18:02:00.000Z",
    }).success).toBe(false);
  });

  it("binds live state and nullable reconciliation misses to the exact attempt", () => {
    const record = activeRecord();
    const live = activeLiveSession();
    const result = { attemptDigest: record.attempt.attemptDigest, record, live };
    expect(RuntimeOAuthAttemptStatusResultSchema.parse(result)).toEqual(result);
    expect(RuntimeOAuthAttemptEffectResultSchema.parse(result)).toEqual(result);
    expect(RuntimeOAuthAttemptStatusResultSchema.parse({
      attemptDigest: record.attempt.attemptDigest,
      record: null,
    })).toEqual({ attemptDigest: record.attempt.attemptDigest, record: null });

    expect(RuntimeOAuthAttemptStatusResultSchema.safeParse({
      attemptDigest: record.attempt.attemptDigest,
      record: null,
      live,
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptEffectResultSchema.safeParse({
      attemptDigest: record.attempt.attemptDigest,
      record: null,
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptStatusResultSchema.safeParse({
      ...result,
      attemptDigest: "d".repeat(64),
    }).success).toBe(false);

    for (const crossFedLive of [
      { ...live, sessionId: "oauth-session-other" },
      { ...live, providerId: "other-provider" },
      { ...live, expiresAt: "2026-08-07T18:06:00.000Z" },
      { ...live, phase: "completed", configured: true as const, authorization: undefined },
    ]) {
      expect(RuntimeOAuthAttemptStatusResultSchema.safeParse({
        ...result,
        live: crossFedLive,
      }).success).toBe(false);
    }
    expect(RuntimeOAuthAttemptStatusResultSchema.safeParse({
      ...result,
      refreshToken: "must-not-cross",
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptStatusResultSchema.safeParse({
      ...result,
      live: { ...live, configured: true },
    }).success).toBe(false);
  });

  it("binds terminal evidence and exact acknowledgement predecessor/successor revisions", () => {
    const attempt = attemptFixture();
    const terminal = completedTerminal(attempt);
    const expectedRevision = 4;
    const acknowledgedAt = "2026-08-07T18:03:00.000Z";
    const record = {
      recordVersion: 1,
      attempt,
      revision: expectedRevision + 1,
      sessionId: "oauth-session-1",
      phase: "completed",
      createdAt: attempt.identity.requestedAt,
      updatedAt: acknowledgedAt,
      expiresAt: "2026-08-07T18:05:00.000Z",
      terminal,
      desktopAcknowledgedAt: acknowledgedAt,
    } as const;
    const request = HostIpcRequestSchema.parse({
      protocolVersion: 1,
      requestId: "request-ack",
      method: "oauth.attempt.acknowledge",
      payload: { attempt, expectedRevision, terminalDigest: terminal.terminalDigest, acknowledgedAt },
    });
    const response = HostIpcSuccessResponseSchema.parse({
      protocolVersion: 1,
      requestId: "request-ack",
      method: "oauth.attempt.acknowledge",
      ok: true,
      result: { attemptDigest: attempt.attemptDigest, record },
    });
    if (request.method !== "oauth.attempt.acknowledge" || response.method !== "oauth.attempt.acknowledge") {
      throw new Error("Unexpected OAuth acknowledgement discriminant");
    }
    expect(response.result.record.revision).toBe(request.payload.expectedRevision + 1);

    expect(RuntimeOAuthAttemptRecordSchema.safeParse({
      ...record,
      updatedAt: terminal.body.terminalAt,
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptRecordSchema.safeParse({
      ...record,
      phase: "failed",
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptEffectResultSchema.safeParse({
      attemptDigest: attempt.attemptDigest,
      record,
      live: { ...activeLiveSession(), phase: "completed", configured: true, authorization: undefined },
    }).success).toBe(true);
    expect(RuntimeOAuthAttemptEffectResultSchema.safeParse({
      attemptDigest: attempt.attemptDigest,
      record,
      live: { ...activeLiveSession(), phase: "completed", authorization: undefined },
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptAcknowledgeResultSchema.safeParse({
      attemptDigest: attempt.attemptDigest,
      record,
    }).success).toBe(true);
    expect(RuntimeOAuthAttemptAcknowledgeResultSchema.safeParse({
      attemptDigest: attempt.attemptDigest,
      record: activeRecord(),
      live: activeLiveSession(),
    }).success).toBe(false);
    expect(RuntimeOAuthAttemptAcknowledgeResultSchema.safeParse({
      attemptDigest: attempt.attemptDigest,
      record: { ...record, revision: 4 },
    }).success).toBe(false);
  });

  it("registers strict success and error response arms for every attempt method", () => {
    const record = activeRecord();
    const startResult = { attemptDigest: record.attempt.attemptDigest, record, live: activeLiveSession() };
    expect(RuntimeOAuthAttemptStartResultSchema.parse(startResult)).toEqual(startResult);
    const terminal = terminalRecord(false);
    const cancelResult = { attemptDigest: terminal.attempt.attemptDigest, record: terminal };
    expect(RuntimeOAuthAttemptCancelResultSchema.parse(cancelResult)).toEqual(cancelResult);
    const acknowledged = terminalRecord(true);
    const acknowledgeResult = { attemptDigest: acknowledged.attempt.attemptDigest, record: acknowledged };
    expect(RuntimeOAuthAttemptAcknowledgeResultSchema.parse(acknowledgeResult)).toEqual(acknowledgeResult);

    for (const [method, result] of [
      ["oauth.attempt.start", startResult],
      ["oauth.attempt.cancel", cancelResult],
      ["oauth.attempt.acknowledge", acknowledgeResult],
    ] as const) {
      const response = {
        protocolVersion: 1,
        requestId: `request-${method}`,
        method,
        ok: true,
        result,
      } as const;
      expect(HostIpcSuccessResponseSchema.parse(response)).toEqual(response);
      expect(HostIpcSuccessResponseSchema.safeParse({ ...response, unexpected: true }).success).toBe(false);
    }
    expect(HostIpcSuccessResponseSchema.safeParse({
      protocolVersion: 1,
      requestId: "request-false-ack",
      method: "oauth.attempt.acknowledge",
      ok: true,
      result: startResult,
    }).success).toBe(false);
    expect(HostIpcSuccessResponseSchema.safeParse({
      protocolVersion: 1,
      requestId: "request-false-cancel",
      method: "oauth.attempt.cancel",
      ok: true,
      result: startResult,
    }).success).toBe(false);

    const statusResponse = {
      protocolVersion: 1,
      requestId: "request-status-miss",
      method: "oauth.attempt.status",
      ok: true,
      result: { attemptDigest: record.attempt.attemptDigest, record: null },
    } as const;
    expect(HostIpcSuccessResponseSchema.parse(statusResponse)).toEqual(statusResponse);

    for (const method of [
      "oauth.attempt.start",
      "oauth.attempt.status",
      "oauth.attempt.cancel",
      "oauth.attempt.acknowledge",
    ] as const) {
      expect(HostIpcErrorResponseSchema.safeParse({
        protocolVersion: 1,
        requestId: `request-error-${method}`,
        method,
        ok: false,
        error: { code: "INVALID_REQUEST", message: "Rejected", retryable: false },
      }).success).toBe(true);
    }
  });
});

function attemptFixture(): RuntimeOAuthAttemptV1 {
  return createRuntimeOAuthAttemptV1({
    version: 1,
    expectedHostId: "host-1",
    providerId: "openai-codex",
    operationId: "11111111-1111-4111-8111-111111111111",
    requestedAt: "2026-08-07T18:00:00.000Z",
  });
}

function completedTerminal(attempt: RuntimeOAuthAttemptV1) {
  return createRuntimeOAuthAttemptTerminalV1({
    version: 1,
    attemptDigest: attempt.attemptDigest,
    phase: "completed",
    resolution: "persistence_confirmed",
    configuredObserved: true,
    terminalAt: "2026-08-07T18:02:00.000Z",
  });
}

function activeRecord() {
  const attempt = attemptFixture();
  return {
    recordVersion: 1,
    attempt,
    revision: 1,
    sessionId: "oauth-session-1",
    phase: "login_dispatching",
    createdAt: attempt.identity.requestedAt,
    updatedAt: "2026-08-07T18:00:01.000Z",
    expiresAt: "2026-08-07T18:05:00.000Z",
  } as const;
}

function activeLiveSession() {
  return {
    sessionId: "oauth-session-1",
    providerId: "openai-codex",
    phase: "awaiting_user",
    expiresAt: "2026-08-07T18:05:00.000Z",
    authorization: { url: validAuthorizationUrl() },
  } as const;
}

function terminalRecord(acknowledged: boolean) {
  const attempt = attemptFixture();
  const terminal = completedTerminal(attempt);
  const acknowledgedAt = "2026-08-07T18:03:00.000Z";
  return {
    recordVersion: 1,
    attempt,
    revision: acknowledged ? 5 : 4,
    sessionId: "oauth-session-1",
    phase: "completed",
    createdAt: attempt.identity.requestedAt,
    updatedAt: acknowledged ? acknowledgedAt : terminal.body.terminalAt,
    expiresAt: "2026-08-07T18:05:00.000Z",
    terminal,
    ...(acknowledged ? { desktopAcknowledgedAt: acknowledgedAt } : {}),
  } as const;
}

function validAuthorizationUrl(origin = "https://auth.openai.com"): string {
  const url = new URL("/oauth/authorize", origin);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", "app_EMoamEEZ73f0CkXaXp7hrann");
  url.searchParams.set("redirect_uri", "http://localhost:1455/auth/callback");
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", "A".repeat(43));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "a".repeat(32));
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");
  return url.toString();
}
