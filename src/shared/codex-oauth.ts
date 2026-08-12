export const CODEX_SUBSCRIPTION_PROVIDER_ID = "openai-codex" as const;

const CODEX_AUTHORIZATION_ORIGIN = "https://auth.openai.com";
const CODEX_AUTHORIZATION_PATH = "/oauth/authorize";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_SCOPE = "openid profile email offline_access";

/**
 * Prime Agent v0.7.2 has one fixed Codex authorization construction. Keeping
 * this allow-list exact prevents a compromised or incompatible helper from
 * turning the desktop's system-browser privilege into an arbitrary URL opener.
 */
export function isPinnedCodexAuthorizationUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.origin !== CODEX_AUTHORIZATION_ORIGIN ||
    url.pathname !== CODEX_AUTHORIZATION_PATH ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    return false;
  }

  const expected = new Map<string, string>([
    ["response_type", "code"],
    ["client_id", CODEX_CLIENT_ID],
    ["redirect_uri", CODEX_REDIRECT_URI],
    ["scope", CODEX_SCOPE],
    ["code_challenge_method", "S256"],
    ["id_token_add_organizations", "true"],
    ["codex_cli_simplified_flow", "true"],
    ["originator", "pi"],
  ]);
  const entries = [...url.searchParams.entries()];
  if (entries.length !== expected.size + 2) return false;
  const keys = new Set(entries.map(([key]) => key));
  if (keys.size !== entries.length) return false;
  for (const [key, expectedValue] of expected) {
    if (url.searchParams.get(key) !== expectedValue) return false;
  }
  const state = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge");
  return state !== null && /^[0-9a-f]{32}$/.test(state) &&
    challenge !== null && /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

