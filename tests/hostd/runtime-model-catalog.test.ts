import { copyFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { canonicalTemporaryDirectory } from "../helpers/canonical-temp";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";
import {
  RuntimeModelCatalogContractError,
  VerifiedRuntimeModelCatalog,
  buildRuntimeModelCatalogHelperInvocation,
  runRuntimeModelCatalogHelper,
  sanitizeRuntimeCatalogHelperEnvironment,
  sanitizeRuntimeCatalog,
} from "../../src/hostd/runtime-model-catalog";
import type { VerifiedInstalledRuntimeHandle } from "../../src/hostd/runtime-integrity-manager";
import { PROTOCOL_VERSION, RUNTIME_MODEL_CATALOG_CAPABILITY } from "../../src/shared/protocol";

describe("runtime model catalog", () => {
  it("projects deterministic provider and model compatibility without secret-bearing runtime fields", () => {
    const codex = model({
      provider: "openai-codex",
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
      baseUrl: "https://secret-provider.invalid",
      headers: { authorization: "Bearer should-never-cross-ipc" },
    });
    const claude = model({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
    });
    const snapshot = sanitizeRuntimeCatalog(
      {
        getOAuthProviders: () => [
          { id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)", usesCallbackServer: true, token: "hidden" },
          { id: "anthropic", name: "Anthropic (Claude Pro/Max)", usesCallbackServer: true },
          { id: "github-copilot", name: "GitHub Copilot" },
        ],
      },
      registry([codex, claude], [codex]),
      "0.7.0",
      "2026-08-07T12:00:00.000Z",
    );

    expect(snapshot.providers.map((provider) => provider.providerId)).toEqual([
      "anthropic",
      "openai-codex",
      "github-copilot",
    ]);
    expect(snapshot.providers.find((provider) => provider.providerId === "openai-codex")).toMatchObject({
      configured: true,
      authSource: "stored",
      oauthSupported: true,
      oauthUsesCallbackServer: true,
      modelCount: 1,
      availableModelCount: 1,
    });
    expect(snapshot.models).toEqual([
      expect.objectContaining({ providerId: "anthropic", modelId: "claude-sonnet-4-6", available: false, usingOAuth: false }),
      expect.objectContaining({ providerId: "openai-codex", modelId: "gpt-5.3-codex", available: true, usingOAuth: true }),
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-provider|authorization|Bearer should-never|hidden|baseUrl|headers/i);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.models[0])).toBe(true);
  });

  it("rejects malformed auth metadata instead of widening the host contract", () => {
    const codex = model({ provider: "openai-codex", id: "codex", name: "Codex" });
    expect(() => sanitizeRuntimeCatalog(
      { getOAuthProviders: () => [{ id: "openai-codex", name: "Codex" }] },
      {
        ...registry([codex], [codex]),
        getProviderAuthStatus: () => ({ configured: true, source: "credential_value_from_future_runtime" }),
      },
      "0.7.0",
      "2026-08-07T12:00:00.000Z",
    )).toThrow(RuntimeModelCatalogContractError);
  });

  it("acquires a verified handle, deduplicates a refresh, and bounds the cache generation", async () => {
    const acquireVerifiedRuntimeHandle = vi.fn(async () => verifiedHandle());
    const runHelper = vi.fn(async () => helperPayload());
    const times = [0, 5, 5, -1].map((milliseconds) => new Date(milliseconds));
    const provider = new VerifiedRuntimeModelCatalog({
      runtimeHandles: { acquireVerifiedRuntimeHandle },
      runHelper,
      cacheTtlMs: 10,
      now: () => times.shift() ?? new Date(20),
    });

    const [first, concurrent] = await Promise.all([provider.read(), provider.read()]);
    const cached = await provider.read();
    const afterClockRollback = await provider.read();

    expect(first).toBe(concurrent);
    expect(cached).toBe(first);
    expect(afterClockRollback).not.toBe(first);
    expect(acquireVerifiedRuntimeHandle).toHaveBeenCalledTimes(2);
    expect(runHelper).toHaveBeenCalledTimes(2);
    expect(runHelper).toHaveBeenCalledWith(verifiedHandle(), {
      timeoutMs: 180_000,
      environment: process.env,
    });
  });

  it("invalidates cached provider status after Prime Agent OAuth completes", async () => {
    const runHelper = vi.fn(async () => helperPayload());
    const provider = new VerifiedRuntimeModelCatalog({
      runtimeHandles: { acquireVerifiedRuntimeHandle: async () => verifiedHandle() },
      runHelper,
      cacheTtlMs: 60_000,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    const first = await provider.read();
    expect(await provider.read()).toBe(first);
    provider.invalidate();
    expect(await provider.read()).not.toBe(first);
    expect(runHelper).toHaveBeenCalledTimes(2);
  });

  it("rechecks shared custody before serving a cached catalog and withdraws readiness on drift", async () => {
    let secure = true;
    const credentialSecurity = {
      prepareAndVerify: vi.fn(async () => undefined),
      assertStillSecure: vi.fn(async () => {
        if (!secure) throw new Error("simulated custody drift");
      }),
    };
    const runHelper = vi.fn(async () => helperPayload());
    const provider = new VerifiedRuntimeModelCatalog({
      runtimeHandles: { acquireVerifiedRuntimeHandle: async () => verifiedHandle() },
      runHelper,
      credentialSecurity,
      cacheTtlMs: 60_000,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    await expect(provider.read()).resolves.toMatchObject({ runtime: "prime_agent" });
    expect(runHelper).toHaveBeenCalledOnce();
    secure = false;
    await expect(provider.read()).rejects.toThrow("simulated custody drift");
    await expect(provider.capabilityReady()).resolves.toBe(false);
    expect(runHelper).toHaveBeenCalledOnce();
  });

  it("fails closed when the isolated helper violates the private discovery contract", async () => {
    const provider = new VerifiedRuntimeModelCatalog({
      runtimeHandles: { acquireVerifiedRuntimeHandle: async () => verifiedHandle() },
      runHelper: async () => ({ ...helperPayload(), unexpected: "field" }),
    });

    await expect(provider.read()).rejects.toBeInstanceOf(RuntimeModelCatalogContractError);
  });

  it("uses the exact verified executable and module URL with a sanitized fixed invocation", async () => {
    const directory = await canonicalTemporaryDirectory("prime-runtime-model-catalog-invocation-");
    try {
      const modulePath = join(directory, "runtime catalog fixture.mjs");
      await writeFile(modulePath, validRuntimeSource(), "utf8");
      const handle = verifiedHandle({ executable: process.execPath, moduleUrl: pathToFileURL(modulePath).href });
      const invocation = buildRuntimeModelCatalogHelperInvocation(handle, {
        Path: "C:\\Windows\\System32",
        OPENAI_API_KEY: "provider-discovery-value",
        NODE_OPTIONS: "--require=untrusted.cjs",
        node_path: "C:\\resolution-shadow",
        electron_run_as_node: "0",
        PRIME_AGENT_INTERNAL_ROLE: "inherited-worker",
      });

      expect(invocation.executable).toBe(process.execPath);
      expect(invocation.argv.slice(0, 2)).toEqual(["--input-type=module", "--eval"]);
      expect(invocation.argv.slice(-2)).toEqual(["--", pathToFileURL(modulePath).href]);
      expect(invocation.spawn).toMatchObject({ shell: false, windowsHide: true, cwd: directory });
      expect(invocation.spawn.env).toMatchObject({
        Path: "C:\\Windows\\System32",
        OPENAI_API_KEY: "provider-discovery-value",
        ELECTRON_RUN_AS_NODE: "1",
      });
      expect(Object.keys(invocation.spawn.env).map((key) => key.toUpperCase())).not.toEqual(
        expect.arrayContaining(["NODE_OPTIONS", "NODE_PATH", "PRIME_AGENT_INTERNAL_ROLE"]),
      );
      expect(Object.isFrozen(invocation.argv)).toBe(true);
      expect(Object.isFrozen(invocation.spawn.env)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("discovers through a child without changing the host process signal handlers", async () => {
    const directory = await canonicalTemporaryDirectory("prime-runtime-model-catalog-isolation-");
    const beforeSigterm = process.listeners("SIGTERM");
    const beforeSigint = process.listeners("SIGINT");
    try {
      const modulePath = join(directory, "runtime.mjs");
      const executable = await executableWithSpacedWindowsPath(directory);
      await writeFile(modulePath, validRuntimeSource('process.on("SIGTERM", () => {}); process.on("SIGINT", () => {});'), "utf8");
      const snapshot = await new VerifiedRuntimeModelCatalog({
        runtimeHandles: {
          acquireVerifiedRuntimeHandle: async () => verifiedHandle({
            executable,
            moduleUrl: pathToFileURL(modulePath).href,
          }),
        },
        helperEnvironment: {},
        helperTimeoutMs: 10_000,
        now: () => new Date("2026-08-07T12:00:00.000Z"),
      }).read();

      expect(snapshot).toMatchObject({
        runtime: "prime_agent",
        releaseVersion: "0.7.0",
        providers: [{ providerId: "openai-codex", configured: true, oauthSupported: true }],
        models: [{ providerId: "openai-codex", modelId: "gpt-isolated", available: true, usingOAuth: true }],
      });
      expect(JSON.stringify(snapshot)).not.toMatch(/Bearer|secret-provider|baseUrl|headers/i);
      expect(process.listeners("SIGTERM")).toEqual(beforeSigterm);
      expect(process.listeners("SIGINT")).toEqual(beforeSigint);
    } finally {
      expect(process.listeners("SIGTERM")).toEqual(beforeSigterm);
      expect(process.listeners("SIGINT")).toEqual(beforeSigint);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("terminates a helper that exceeds its deadline", async () => {
    const directory = await canonicalTemporaryDirectory("prime-runtime-model-catalog-timeout-");
    try {
      const modulePath = join(directory, "runtime.mjs");
      await writeFile(
        modulePath,
        `${validRuntimeSource()}\nsetInterval(() => {}, 1_000); await new Promise(() => {});`,
        "utf8",
      );
      await expect(runRuntimeModelCatalogHelper(
        verifiedHandle({ executable: process.execPath, moduleUrl: pathToFileURL(modulePath).href }),
        { timeoutMs: 50, environment: {} },
      )).rejects.toThrow(/timed out/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects stderr without reflecting potentially secret child output", async () => {
    const directory = await canonicalTemporaryDirectory("prime-runtime-model-catalog-stderr-");
    try {
      const modulePath = join(directory, "runtime.mjs");
      await writeFile(modulePath, validRuntimeSource('process.stderr.write("Bearer must-not-escape\\n");'), "utf8");
      const result = runRuntimeModelCatalogHelper(
        verifiedHandle({ executable: process.execPath, moduleUrl: pathToFileURL(modulePath).href }),
        { timeoutMs: 10_000, environment: {} },
      );
      await expect(result).rejects.toThrow(/wrote to stderr/);
      await expect(result).rejects.not.toThrow(/Bearer|must-not-escape/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed and oversized helper stdout", async () => {
    const directory = await canonicalTemporaryDirectory("prime-runtime-model-catalog-output-");
    try {
      const malformedPath = join(directory, "malformed.mjs");
      await writeFile(
        malformedPath,
        validRuntimeSource('const write = process.stdout.write.bind(process.stdout); process.stdout.write = () => write("{");'),
        "utf8",
      );
      await expect(runRuntimeModelCatalogHelper(
        verifiedHandle({ executable: process.execPath, moduleUrl: pathToFileURL(malformedPath).href }),
        { timeoutMs: 10_000, environment: {} },
      )).rejects.toThrow(/not valid JSON/);

      const oversizedPath = join(directory, "oversized.mjs");
      await writeFile(
        oversizedPath,
        validRuntimeSource('const write = process.stdout.write.bind(process.stdout); process.stdout.write = () => write("x".repeat(2 * 1024 * 1024 + 1));'),
        "utf8",
      );
      await expect(runRuntimeModelCatalogHelper(
        verifiedHandle({ executable: process.execPath, moduleUrl: pathToFileURL(oversizedPath).href }),
        { timeoutMs: 10_000, environment: {} },
      )).rejects.toThrow(/output exceeded its bound/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects a non-zero helper exit", async () => {
    const directory = await canonicalTemporaryDirectory("prime-runtime-model-catalog-exit-");
    try {
      const modulePath = join(directory, "runtime.mjs");
      await writeFile(modulePath, `process.exit(7);\n${validRuntimeSource()}`, "utf8");
      await expect(runRuntimeModelCatalogHelper(
        verifiedHandle({ executable: process.execPath, moduleUrl: pathToFileURL(modulePath).href }),
        { timeoutMs: 10_000, environment: {} },
      )).rejects.toThrow(/exited unsuccessfully/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed helper environment entries", () => {
    expect(() => sanitizeRuntimeCatalogHelperEnvironment({ "BAD=NAME": "value" })).toThrow(
      RuntimeModelCatalogContractError,
    );
  });

  it("advertises and serves the catalog only for the expected host authority", async () => {
    const directory = await canonicalTemporaryDirectory("prime-runtime-model-catalog-service-");
    try {
      const store = new HostStore(directory);
      await store.initialize();
      const host = await store.getHost();
      const catalog = sanitizeRuntimeCatalog(
        { getOAuthProviders: () => [] },
        registry([model({ provider: "openai", id: "gpt-5", name: "GPT-5" })], []),
        "0.7.0",
        "2026-08-07T12:00:00.000Z",
      );
      const read = vi.fn(async () => catalog);
      let capabilityReady = true;
      const service = new HostService(store, undefined, undefined, {
        runtimeModelCatalogProvider: {
          read,
          capabilityReady: vi.fn(async () => capabilityReady),
        },
      });

      const health = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "model-catalog-health",
        method: "health.get",
        payload: {},
      }, TRUSTED_USER_SESSION);
      expect(health).toMatchObject({ ok: true, result: { capabilities: expect.arrayContaining([RUNTIME_MODEL_CATALOG_CAPABILITY]) } });

      const response = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "model-catalog-read",
        method: "runtime.model_catalog",
        payload: { expectedHostId: host.hostId },
      }, TRUSTED_USER_SESSION);
      expect(response).toMatchObject({ ok: true, method: "runtime.model_catalog", result: catalog });
      expect(read).toHaveBeenCalledOnce();

      const staleAuthority = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "model-catalog-stale-host",
        method: "runtime.model_catalog",
        payload: { expectedHostId: "different-host" },
      }, TRUSTED_USER_SESSION);
      expect(staleAuthority).toMatchObject({ ok: false, error: { code: "HOST_AUTHORITY_MISMATCH" } });
      expect(read).toHaveBeenCalledOnce();

      capabilityReady = false;
      const driftedHealth = await service.handle({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "model-catalog-health-drifted",
        method: "health.get",
        payload: {},
      }, TRUSTED_USER_SESSION);
      expect(driftedHealth).toMatchObject({ ok: true });
      if (!driftedHealth.ok || driftedHealth.method !== "health.get") {
        throw new Error("Expected a health response after simulated catalog custody drift");
      }
      expect(driftedHealth.result.capabilities).not.toContain(RUNTIME_MODEL_CATALOG_CAPABILITY);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function registry(all: unknown[], available: unknown[]) {
  return {
    getAll: () => all,
    getAvailable: () => available,
    getProviderAuthStatus: (provider: string) => provider === "openai-codex"
      ? { configured: true, source: "stored" }
      : { configured: false },
    getProviderDisplayName: (provider: string) => provider === "openai" ? "OpenAI" : provider,
    isUsingOAuth: (value: unknown) => isRecord(value) && value.provider === "openai-codex",
  };
}

function model(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: "openai",
    id: "gpt-5",
    name: "GPT-5",
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 32_000,
    ...overrides,
  };
}

function verifiedHandle(overrides: { readonly executable?: string; readonly moduleUrl?: string } = {}): VerifiedInstalledRuntimeHandle {
  return Object.freeze({
    identity: {
      runtime: "prime-agent",
      releaseVersion: "0.7.0",
      runtimeBuildId: "catalog-test",
      platform: "win32",
      arch: "x64",
      manifestSha256: "1".repeat(64),
      treeSha256: "2".repeat(64),
      filesSha256: "3".repeat(64),
      hostRuntime: {
        platform: "win32",
        arch: "x64",
        node: "22.12.0",
        electron: "43.3.0",
        executable: "electron",
        runAsNode: true,
      },
      fileCount: 1,
      totalBytes: 1,
    },
    executable: overrides.executable ?? "C:\\Prime Continuim\\Prime Continuim.exe",
    moduleUrl: overrides.moduleUrl ?? "file:///C:/Prime%20Continuim/runtime/node_modules/prime-agent/dist/index.js",
    cliEntrypoint: "C:\\Prime Continuim\\runtime\\node_modules\\prime-agent\\dist\\bundle\\cli.js",
  }) as unknown as VerifiedInstalledRuntimeHandle;
}

function helperPayload() {
  return {
    schemaVersion: 1,
    models: [{
      provider: "openai",
      id: "gpt-5",
      name: "GPT-5",
      api: "openai-responses",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 32_000,
      available: true,
      usingOAuth: false,
    }],
    oauthProviders: [],
    providerStates: [{ providerId: "openai", displayName: "OpenAI", configured: false }],
  };
}

function validRuntimeSource(preamble = ""): string {
  return `${preamble}
const model = {
  provider: "openai-codex",
  id: "gpt-isolated",
  name: "GPT Isolated",
  api: "openai-responses",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 400000,
  maxTokens: 128000,
  baseUrl: "https://secret-provider.invalid",
  headers: { authorization: "Bearer must-not-cross" },
};
export class AuthStorage {
  static create() {
    return {
      getOAuthProviders: () => [{ id: "openai-codex", name: "Codex Subscription", usesCallbackServer: true }],
    };
  }
}
export class ModelRegistry {
  static create() {
    return {
      getAll: () => [model],
      getAvailable: () => [model],
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getProviderDisplayName: () => "OpenAI Codex",
      isUsingOAuth: () => true,
    };
  }
}
`;
}

async function executableWithSpacedWindowsPath(directory: string): Promise<string> {
  if (process.platform !== "win32") return process.execPath;
  const target = join(directory, "verified runtime host with spaces.exe");
  // GitHub can place the checkout and TEMP on different Windows volumes, where
  // a hard link is invalid. A byte-for-byte copy preserves the spaced-path
  // executable behavior this fixture exercises without a same-volume premise.
  await copyFile(process.execPath, target);
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
