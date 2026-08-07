import { describe, expect, it } from "vitest";
import {
  HostIpcRequestSchema,
  RuntimeOAuthSessionSnapshotSchema,
} from "../../src/shared/protocol";

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
  });
});

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

