import { EventEmitter } from "node:events";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { VerifiedInstalledRuntimeHandle } from "../../src/hostd/runtime-integrity-manager";
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  RuntimeOAuthHelperError,
  RuntimeOAuthHelperTerminationError,
  VerifiedRuntimeOAuthComposition,
  buildRuntimeOAuthLoginHelperInvocation,
  buildRuntimeOAuthStorageHelperInvocation,
  runRuntimeOAuthLoginHelper,
  sanitizeRuntimeOAuthHelperEnvironment,
  terminateRuntimeOAuthHelperProcess,
} from "../../src/hostd/runtime-oauth";
import { isPinnedCodexAuthorizationUrl } from "../../src/shared/codex-oauth";
import { canonicalTemporaryDirectory } from "../helpers/canonical-temp";

const VERIFIED_RUNTIME_ROOT = resolve("test-runtime-oauth", "Prime Continuim");
const VERIFIED_RUNTIME_EXECUTABLE = join(
  VERIFIED_RUNTIME_ROOT,
  process.platform === "win32" ? "Prime Continuim.exe" : "prime-continuim",
);
const VERIFIED_RUNTIME_MODULE_PATH = join(
  VERIFIED_RUNTIME_ROOT,
  "runtime",
  "node_modules",
  "prime-agent",
  "dist",
  "index.js",
);
const VERIFIED_RUNTIME_MODULE_URL = pathToFileURL(VERIFIED_RUNTIME_MODULE_PATH).href;
const VERIFIED_RUNTIME_CLI = join(dirname(VERIFIED_RUNTIME_MODULE_PATH), "bundle", "cli.js");

const SECRET_CREDENTIALS = Object.freeze({
  access: "private-access-token",
  refresh: "private-refresh-token",
  expires: 2_000_000_000_000,
  accountId: "private-account-id",
});

describe("verified Prime Agent runtime OAuth composition", () => {
  it("exposes only the pinned Codex subscription provider and owns the exact storage confirmation lifecycle", async () => {
    const handle = verifiedHandle();
    const acquireVerifiedRuntimeHandle = vi.fn(async () => handle);
    const runLogin = vi.fn(async (_handle, providerId, callbacks) => {
      expect(providerId).toBe(CODEX_SUBSCRIPTION_PROVIDER_ID);
      callbacks.onAuth({ url: validAuthorizationUrl() });
      return SECRET_CREDENTIALS;
    });
    const calls: string[] = [];
    const storage = {
      set: vi.fn(async () => { calls.push("set"); }),
      drainErrors: vi.fn(async () => { calls.push("drainErrors"); return []; }),
      reload: vi.fn(async () => { calls.push("reload"); }),
      getAuthStatus: vi.fn(async () => { calls.push("getAuthStatus"); return { configured: true }; }),
      close: vi.fn(async () => { calls.push("close"); }),
    };
    const openStorage = vi.fn(async () => storage);
    const composition = new VerifiedRuntimeOAuthComposition({
      runtimeHandles: { acquireVerifiedRuntimeHandle },
      runLogin,
      openStorage,
      environment: {},
    });

    expect(composition.getProvider("anthropic")).toBeUndefined();
    const provider = composition.getProvider(CODEX_SUBSCRIPTION_PROVIDER_ID);
    expect(provider).toMatchObject({
      id: CODEX_SUBSCRIPTION_PROVIDER_ID,
      usesCallbackServer: true,
    });
    const onAuth = vi.fn();
    await expect(provider?.login({ onAuth, onPrompt: async () => "" })).resolves.toEqual(SECRET_CREDENTIALS);
    expect(onAuth).toHaveBeenCalledWith({ url: validAuthorizationUrl() });

    await composition.set(CODEX_SUBSCRIPTION_PROVIDER_ID, { ...SECRET_CREDENTIALS, type: "oauth" });
    await composition.drainErrors();
    await composition.reload();
    await expect(composition.getAuthStatus(CODEX_SUBSCRIPTION_PROVIDER_ID)).resolves.toEqual({ configured: true });

    expect(acquireVerifiedRuntimeHandle).toHaveBeenCalledTimes(2);
    const helperEnvironment = {
      ELECTRON_RUN_AS_NODE: "1",
      PI_OAUTH_CALLBACK_HOST: "127.0.0.1",
    };
    expect(runLogin).toHaveBeenCalledWith(
      handle,
      CODEX_SUBSCRIPTION_PROVIDER_ID,
      expect.any(Object),
      helperEnvironment,
    );
    expect(openStorage).toHaveBeenCalledWith(handle, helperEnvironment);
    expect(calls).toEqual(["set", "drainErrors", "reload", "getAuthStatus", "close"]);
  });

  it("builds a fixed invocation with only the minimal OAuth environment allowlist", () => {
    const environment = {
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      HOME: "C:\\Users\\prime",
      TEMP: "C:\\Temp",
      PRIME_AGENT_CODING_AGENT_DIR: "C:\\Users\\prime\\.prime\\agent",
      PI_CODING_AGENT_DIR: "C:\\attacker\\wrong-key",
      OPENAI_API_KEY: "provider-environment-value",
      ANTHROPIC_API_KEY: "anthropic-canary",
      PRIME_API_KEY: "prime-canary",
      PRIME_TEAM_ID: "team-canary",
      AWS_SECRET_ACCESS_KEY: "aws-canary",
      GITHUB_TOKEN: "github-canary",
      GH_TOKEN: "gh-canary",
      HTTPS_PROXY: "https://proxy-user:proxy-secret@proxy.example",
      ALL_PROXY: "socks5://proxy-user:proxy-secret@proxy.example",
      NO_PROXY: "metadata.internal",
      UNRELATED_SECRET: "unrelated-canary",
      NODE_OPTIONS: "--require=untrusted.cjs",
      node_path: "C:\\resolution-shadow",
      ELECTRON_RUN_AS_NODE: "0",
      PRIME_AGENT_INTERNAL_ROLE: "untrusted-role",
      PI_OAUTH_CALLBACK_HOST: "0.0.0.0",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NODE_EXTRA_CA_CERTS: "C:\\attacker-ca.pem",
      SSLKEYLOGFILE: "C:\\oauth-session-keys.log",
    };
    const login = buildRuntimeOAuthLoginHelperInvocation(verifiedHandle(), CODEX_SUBSCRIPTION_PROVIDER_ID, environment);
    const storage = buildRuntimeOAuthStorageHelperInvocation(verifiedHandle(), CODEX_SUBSCRIPTION_PROVIDER_ID, environment);

    for (const invocation of [login, storage]) {
      expect(invocation).toMatchObject({
        executable: VERIFIED_RUNTIME_EXECUTABLE,
        spawn: { shell: false, windowsHide: true, cwd: dirname(VERIFIED_RUNTIME_MODULE_PATH) },
      });
      expect(invocation.argv.slice(0, 2)).toEqual(["--input-type=module", "--eval"]);
      expect(invocation.argv.slice(-3)).toEqual([
        "--",
        VERIFIED_RUNTIME_MODULE_URL,
        CODEX_SUBSCRIPTION_PROVIDER_ID,
      ]);
      expect(invocation.spawn.env).toEqual({
        SYSTEMROOT: "C:\\Windows",
        HOME: "C:\\Users\\prime",
        TEMP: "C:\\Temp",
        PRIME_AGENT_CODING_AGENT_DIR: "C:\\Users\\prime\\.prime\\agent",
        ELECTRON_RUN_AS_NODE: "1",
        PI_OAUTH_CALLBACK_HOST: "127.0.0.1",
      });
      const serialized = JSON.stringify(invocation);
      for (const canary of [
        "provider-environment-value", "anthropic-canary", "prime-canary", "team-canary",
        "aws-canary", "github-canary", "gh-canary", "proxy-secret", "metadata.internal",
        "unrelated-canary", "wrong-key", "untrusted.cjs", "attacker-ca.pem", "oauth-session-keys.log",
      ]) {
        expect(serialized).not.toContain(canary);
      }
    }
    expect(sanitizeRuntimeOAuthHelperEnvironment(environment)).toEqual(login.spawn.env);
    expect(() => sanitizeRuntimeOAuthHelperEnvironment({ HOME: "C:\\one", home: "C:\\two" })).toThrow(
      RuntimeOAuthHelperError,
    );
    expect(() => sanitizeRuntimeOAuthHelperEnvironment({ PRIME_AGENT_CODING_AGENT_DIR: "relative" })).toThrow(
      RuntimeOAuthHelperError,
    );
  });

  it("rejects path and module ambiguity before launching a helper", () => {
    expect(() => buildRuntimeOAuthLoginHelperInvocation(
      verifiedHandle({ executable: "relative\\prime.exe" }),
    )).toThrow(RuntimeOAuthHelperError);
    expect(() => buildRuntimeOAuthLoginHelperInvocation(
      verifiedHandle({ moduleUrl: `${VERIFIED_RUNTIME_MODULE_URL}?replacement=1` }),
    )).toThrow(RuntimeOAuthHelperError);
  });

  it("accepts only the exact pinned auth.openai.com authorization contract", () => {
    expect(isPinnedCodexAuthorizationUrl(validAuthorizationUrl())).toBe(true);
    expect(isPinnedCodexAuthorizationUrl(validAuthorizationUrl("https://attacker.example"))).toBe(false);
    expect(isPinnedCodexAuthorizationUrl(`${validAuthorizationUrl()}&access_token=secret`)).toBe(false);
    expect(isPinnedCodexAuthorizationUrl(validAuthorizationUrl("https://user@auth.openai.com"))).toBe(false);
  });

  it("rejects a verified helper that attempts to publish a different HTTPS authorization host", async () => {
    const directory = await canonicalTemporaryDirectory("prime-runtime-oauth-host-");
    try {
      const modulePath = join(directory, "runtime.mjs");
      await writeFile(modulePath, runtimeModuleSource(validAuthorizationUrl("https://attacker.example")), "utf8");
      const onAuth = vi.fn();
      await expect(runRuntimeOAuthLoginHelper(
        verifiedHandle({ executable: process.execPath, moduleUrl: pathToFileURL(modulePath).href }),
        CODEX_SUBSCRIPTION_PROVIDER_ID,
        { onAuth, onPrompt: async () => "" },
        {},
      )).rejects.toBeInstanceOf(RuntimeOAuthHelperError);
      expect(onAuth).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("captures credentials through private stdio and terminates the short-lived login helper", async () => {
    const directory = await canonicalTemporaryDirectory("prime-runtime-oauth-login-");
    try {
      const modulePath = join(directory, "runtime.mjs");
      await writeFile(modulePath, runtimeModuleSource(validAuthorizationUrl()), "utf8");
      const onAuth = vi.fn();
      await expect(runRuntimeOAuthLoginHelper(
        verifiedHandle({ executable: process.execPath, moduleUrl: pathToFileURL(modulePath).href }),
        CODEX_SUBSCRIPTION_PROVIDER_ID,
        { onAuth, onPrompt: async () => "" },
        {},
      )).resolves.toEqual(SECRET_CREDENTIALS);
      expect(onAuth).toHaveBeenCalledWith({ url: validAuthorizationUrl() });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects teardown when a live helper ignores graceful and forced termination", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeLiveChild();
      const termination = terminateRuntimeOAuthHelperProcess(child, { forceAfterMs: 10, boundMs: 25 });
      const expectation = expect(termination).rejects.toBeInstanceOf(RuntimeOAuthHelperTerminationError);
      await vi.advanceTimersByTimeAsync(26);
      await expectation;
      expect(child.kill).toHaveBeenCalledWith();
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains an unconfirmed storage teardown so composition close also fails closed", async () => {
    const terminationError = new RuntimeOAuthHelperTerminationError();
    const storage = {
      set: vi.fn(async () => undefined),
      drainErrors: vi.fn(async () => []),
      reload: vi.fn(async () => undefined),
      getAuthStatus: vi.fn(async () => ({ configured: true })),
      close: vi.fn(async () => { throw terminationError; }),
    };
    const composition = new VerifiedRuntimeOAuthComposition({
      runtimeHandles: { acquireVerifiedRuntimeHandle: vi.fn(async () => verifiedHandle()) },
      openStorage: vi.fn(async () => storage),
      environment: {},
    });
    await composition.set(CODEX_SUBSCRIPTION_PROVIDER_ID, { type: "oauth", ...SECRET_CREDENTIALS });
    await expect(composition.getAuthStatus(CODEX_SUBSCRIPTION_PROVIDER_ID)).rejects.toBe(terminationError);
    await expect(composition.close()).rejects.toBe(terminationError);
    expect(storage.close).toHaveBeenCalledTimes(2);
  });
});

function fakeLiveChild(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
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

function runtimeModuleSource(url: string): string {
  return `
export class AuthStorage {
  static create() { return new AuthStorage(); }
  getOAuthProviders() {
    return [{
      id: ${JSON.stringify(CODEX_SUBSCRIPTION_PROVIDER_ID)},
      name: "ChatGPT Plus/Pro (Codex Subscription)",
      usesCallbackServer: true,
      async login(callbacks) {
        callbacks.onAuth({ url: ${JSON.stringify(url)} });
        return ${JSON.stringify(SECRET_CREDENTIALS)};
      }
    }];
  }
}
`;
}

function verifiedHandle(
  overrides: { readonly executable?: string; readonly moduleUrl?: string } = {},
): VerifiedInstalledRuntimeHandle {
  return Object.freeze({
    identity: {
      runtime: "prime-agent",
      releaseVersion: "0.7.0",
      runtimeBuildId: "oauth-test",
      platform: process.platform,
      arch: process.arch,
      manifestSha256: "1".repeat(64),
      treeSha256: "2".repeat(64),
      filesSha256: "3".repeat(64),
      hostRuntime: {
        platform: process.platform,
        arch: process.arch,
        node: "22.12.0",
        electron: "43.3.0",
        executable: "electron",
        runAsNode: true,
      },
      fileCount: 1,
      totalBytes: 1,
    },
    executable: overrides.executable ?? VERIFIED_RUNTIME_EXECUTABLE,
    moduleUrl: overrides.moduleUrl ?? VERIFIED_RUNTIME_MODULE_URL,
    cliEntrypoint: VERIFIED_RUNTIME_CLI,
  }) as unknown as VerifiedInstalledRuntimeHandle;
}
