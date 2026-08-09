const OFFICIAL_CODEX_AUTH_ORIGIN = "https://auth.openai.com";
const OFFICIAL_CODEX_AUTH_PATH = "/oauth/authorize";
const MAX_AUTHORIZATION_URL_BYTES = 8_192;
const OFFICIAL_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OFFICIAL_CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const OFFICIAL_QUERY_NAMES = Object.freeze([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "codex_cli_simplified_flow",
  "id_token_add_organizations",
  "originator",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
] as const);

/**
 * URL contract for the official Codex app-server ChatGPT login response.
 *
 * This is deliberately separate from `codex-oauth.ts`: that module pins the
 * Prime Agent `pi` OAuth client. App-server owns a different client and state
 * attempt. The caller must additionally bind the returned URL to the exact
 * JSON-RPC login response/loginId that produced it; this predicate only grants
 * the host process permission to open the official local-callback URL.
 */
export function isOfficialCodexAppServerLoginUrl(value: string): boolean {
  if (new TextEncoder().encode(value).byteLength > MAX_AUTHORIZATION_URL_BYTES) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.origin !== OFFICIAL_CODEX_AUTH_ORIGIN ||
    url.pathname !== OFFICIAL_CODEX_AUTH_PATH ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    return false;
  }

  const entries = [...url.searchParams.entries()];
  if (entries.length !== OFFICIAL_QUERY_NAMES.length) return false;
  const queryNames = entries.map(([key]) => key);
  if (new Set(queryNames).size !== queryNames.length) return false;
  if (
    [...queryNames].sort().join("\0") !== [...OFFICIAL_QUERY_NAMES].sort().join("\0") ||
    url.searchParams.get("client_id") !== OFFICIAL_CODEX_CLIENT_ID ||
    url.searchParams.get("code_challenge_method") !== "S256" ||
    url.searchParams.get("codex_cli_simplified_flow") !== "true" ||
    url.searchParams.get("id_token_add_organizations") !== "true" ||
    url.searchParams.get("originator") !== "prime_continuim" ||
    url.searchParams.get("response_type") !== "code" ||
    url.searchParams.get("scope") !== OFFICIAL_CODEX_SCOPE
  ) {
    return false;
  }

  const clientId = url.searchParams.get("client_id");
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge");
  const redirect = url.searchParams.get("redirect_uri");
  if (clientId !== OFFICIAL_CODEX_CLIENT_ID) return false;
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return false;
  if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return false;
  if (!redirect || redirect.length > 2_048) return false;

  try {
    const callback = new URL(redirect);
    const port = Number(callback.port);
    return (
      callback.protocol === "http:" &&
      callback.username === "" &&
      callback.password === "" &&
      callback.hash === "" &&
      callback.search === "" &&
      callback.pathname === "/auth/callback" &&
      /^(?:[1-9]\d{0,4})$/.test(callback.port) &&
      Number.isInteger(port) &&
      port <= 65_535 &&
      String(port) === callback.port &&
      callback.hostname === "localhost"
    );
  } catch {
    return false;
  }
}
