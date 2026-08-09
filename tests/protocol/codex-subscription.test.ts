import { describe, expect, it } from "vitest";
import {
  CODEX_SUBSCRIPTION_BACKEND_ID,
  CODEX_SUBSCRIPTION_BACKEND_LABEL,
  CodexSubscriptionAccountSnapshotSchema,
  CodexSubscriptionConversationSnapshotSchema,
  CodexSubscriptionLoginStartResultSchema,
  HostIpcRequestSchema,
  HostIpcResponseSchema,
} from "../../src/shared/protocol";

const backend = {
  id: CODEX_SUBSCRIPTION_BACKEND_ID,
  kind: "codex_subscription",
  label: CODEX_SUBSCRIPTION_BACKEND_LABEL,
} as const;
const executionPolicy = {
  filesystem: "read_only_user_scope",
  workspaceReadConfinement: false,
  toolNetworkAccess: false,
  approvalPolicy: "never",
  disclosure:
    "Codex tools cannot write files or open network connections. They may read other files available to your Windows account; this is not a workspace-only sandbox. Prompts and content Codex reads—including workspace instructions and tool-read files—are sent to OpenAI for the turn.",
} as const;

describe("Codex subscription wire contract", () => {
  it("keeps renderer-safe account state free of URLs and account identifiers", () => {
    const snapshot = {
      backend,
      backendIncarnationId: "codex-process-1",
      phase: "signed_in",
      accountType: "chatgpt",
      requiresOpenaiAuth: true,
      planType: "plus",
      executionPolicy,
      turnReadiness: { state: "ready", verifiedAt: "2026-08-09T12:00:00.000Z" },
      updatedAt: "2026-08-09T12:00:00.000Z",
    } as const;
    expect(CodexSubscriptionAccountSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(CodexSubscriptionAccountSnapshotSchema.safeParse({
      ...snapshot,
      email: "private@example.test",
    }).success).toBe(false);
    expect(CodexSubscriptionAccountSnapshotSchema.safeParse({
      ...snapshot,
      authUrl: officialAuthorizationUrl(),
    }).success).toBe(false);
  });

  it("accepts only an exact attempt-bound official app-server browser handoff", () => {
    const account = {
      backend,
      backendIncarnationId: "codex-process-1",
      phase: "opening_browser",
      pendingLoginId: "login-1",
      pendingLoginOperationId: "login-operation-1",
      executionPolicy,
      turnReadiness: { state: "unavailable", reason: "login_in_progress" },
      updatedAt: "2026-08-09T12:00:00.000Z",
    } as const;
    const result = {
      account,
      authorization: {
        loginId: "login-1",
        operationId: "login-operation-1",
        authUrl: officialAuthorizationUrl(),
      },
    };
    expect(CodexSubscriptionLoginStartResultSchema.parse(result)).toEqual(result);
    expect(CodexSubscriptionLoginStartResultSchema.safeParse({
      ...result,
      authorization: { ...result.authorization, loginId: "different-login" },
    }).success).toBe(false);
    for (const invalidUrl of authorizationUrlMutations()) {
      expect(CodexSubscriptionLoginStartResultSchema.safeParse({
        ...result,
        authorization: { ...result.authorization, authUrl: invalidUrl },
      }).success).toBe(false);
    }
    expect(CodexSubscriptionLoginStartResultSchema.safeParse({
      ...result,
      authorization: {
        ...result.authorization,
        authUrl: officialAuthorizationUrl("https://attacker.example"),
      },
    }).success).toBe(false);
    expect(CodexSubscriptionLoginStartResultSchema.safeParse({
      ...result,
      authorization: {
        ...result.authorization,
        authUrl: officialAuthorizationUrl(undefined, "https://example.test/callback"),
      },
    }).success).toBe(false);
  });

  it("carries a bounded path-free conversation with honest read scope", () => {
    const snapshot = {
      backend,
      backendIncarnationId: "codex-process-1",
      binding: {
        hostId: "host-1",
        sourceThreadId: "prime-thread-1",
        executionGenerationId: "prime-generation-1",
      },
      sessionId: "codex-session-1",
      threadId: "codex-thread-1",
      revision: 4,
      state: "active",
      executionPolicy,
      activeTurn: {
        operationId: "turn-operation-1",
        turnId: "codex-turn-1",
        state: "running",
        terminal: false,
        startedAt: "2026-08-09T12:00:00.000Z",
      },
      latestTurn: {
        operationId: "turn-operation-1",
        turnId: "codex-turn-1",
        state: "running",
        terminal: false,
        startedAt: "2026-08-09T12:00:00.000Z",
      },
      transcript: [
        {
          itemId: "user-item-1",
          turnOperationId: "turn-operation-1",
          turnId: "codex-turn-1",
          sequence: 1,
          role: "user",
          state: "completed",
          text: "Inspect this workspace without modifying it.",
          createdAt: "2026-08-09T12:00:00.000Z",
          updatedAt: "2026-08-09T12:00:00.000Z",
        },
      ],
      transcriptTruncated: false,
      updatedAt: "2026-08-09T12:00:01.000Z",
    } as const;
    expect(CodexSubscriptionConversationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toMatch(/[A-Z]:\\|access[_-]?token|email/i);
    expect(CodexSubscriptionConversationSnapshotSchema.safeParse({
      ...snapshot,
      cwd: "C:\\private\\workspace",
    }).success).toBe(false);
    expect(CodexSubscriptionConversationSnapshotSchema.safeParse({
      ...snapshot,
      executionPolicy: { ...snapshot.executionPolicy, workspaceReadConfinement: true },
    }).success).toBe(false);
  });

  it("requires exact bounded turn envelopes for start and reconciliation", () => {
    const payload = {
      expectedHostId: "host-1",
      threadId: "prime-thread-1",
      expectedExecutionGenerationId: "prime-generation-1",
      expectedBackendIncarnationId: "codex-process-1",
      expectedConversation: { state: "absent" },
      operationId: "turn-operation-1",
      prompt: "Read and explain the current implementation.",
    };
    for (const method of ["codex.subscription.turn.start", "codex.subscription.turn.reconcile"] as const) {
      expect(HostIpcRequestSchema.safeParse({
        protocolVersion: 1,
        requestId: `request-${method}`,
        method,
        payload,
      }).success).toBe(true);
    }
    expect(HostIpcRequestSchema.safeParse({
      protocolVersion: 1,
      requestId: "request-turn-oversize",
      method: "codex.subscription.turn.start",
      payload: { ...payload, prompt: "x".repeat(64 * 1_024 + 1) },
    }).success).toBe(false);
    expect(HostIpcResponseSchema.safeParse({
      protocolVersion: 1,
      requestId: "request-secret-expansion",
      method: "codex.subscription.account.read",
      ok: true,
      result: {
        backend,
        backendIncarnationId: "codex-process-1",
        phase: "signed_out",
        executionPolicy,
        turnReadiness: { state: "unavailable", reason: "account_required" },
        updatedAt: "2026-08-09T12:00:00.000Z",
        accessToken: "must-not-cross",
      },
    }).success).toBe(false);
  });
});

function officialAuthorizationUrl(
  origin = "https://auth.openai.com",
  redirectUri = "http://localhost:1455/auth/callback",
): string {
  const url = new URL("/oauth/authorize", origin);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", "app_EMoamEEZ73f0CkXaXp7hrann");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid profile email offline_access api.connectors.read api.connectors.invoke");
  url.searchParams.set("state", "S".repeat(43));
  url.searchParams.set("code_challenge", "A".repeat(43));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("originator", "prime_continuim");
  return url.toString();
}

function authorizationUrlMutations(): string[] {
  const missing = new URL(officialAuthorizationUrl());
  missing.searchParams.delete("scope");
  const extra = new URL(officialAuthorizationUrl());
  extra.searchParams.set("unexpected", "true");
  const duplicate = new URL(officialAuthorizationUrl());
  duplicate.searchParams.append("state", "T".repeat(43));
  const wrongOriginator = new URL(officialAuthorizationUrl());
  wrongOriginator.searchParams.set("originator", "other_client");
  return [missing, extra, duplicate, wrongOriginator].map((url) => url.toString());
}
