import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HostService, TRUSTED_USER_SESSION } from "../../src/hostd/service";
import { HostStore } from "../../src/hostd/store";
import {
  RuntimeModelCatalogContractError,
  VerifiedRuntimeModelCatalog,
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
    const all = [model({ provider: "openai", id: "gpt-5", name: "GPT-5" })];
    class AuthStorageExport {
      static create() {
        return { getOAuthProviders: () => [] };
      }
    }
    class ModelRegistryExport {
      static create() {
        return registry(all, all);
      }
    }
    const runtime = {
      AuthStorage: AuthStorageExport,
      ModelRegistry: ModelRegistryExport,
    };
    const acquireVerifiedRuntimeHandle = vi.fn(async () => verifiedHandle());
    const loadRuntimeModule = vi.fn(async () => runtime);
    const times = [0, 5, 5, -1].map((milliseconds) => new Date(milliseconds));
    const provider = new VerifiedRuntimeModelCatalog({
      runtimeHandles: { acquireVerifiedRuntimeHandle },
      loadRuntimeModule,
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
    expect(loadRuntimeModule).toHaveBeenCalledTimes(2);
    expect(loadRuntimeModule).toHaveBeenCalledWith(verifiedHandle().moduleUrl);
  });

  it("fails closed when the verified runtime omits the public catalog exports", async () => {
    const provider = new VerifiedRuntimeModelCatalog({
      runtimeHandles: { acquireVerifiedRuntimeHandle: async () => verifiedHandle() },
      loadRuntimeModule: async () => ({ AuthStorage: {} }),
    });

    await expect(provider.read()).rejects.toBeInstanceOf(RuntimeModelCatalogContractError);
  });

  it("advertises and serves the catalog only for the expected host authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-runtime-model-catalog-service-"));
    try {
      const store = new HostStore(directory);
      await store.initialize({ seed: true });
      const host = await store.getHost();
      const catalog = sanitizeRuntimeCatalog(
        { getOAuthProviders: () => [] },
        registry([model({ provider: "openai", id: "gpt-5", name: "GPT-5" })], []),
        "0.7.0",
        "2026-08-07T12:00:00.000Z",
      );
      const read = vi.fn(async () => catalog);
      const service = new HostService(store, undefined, undefined, {
        runtimeModelCatalogProvider: { read },
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

function verifiedHandle(): VerifiedInstalledRuntimeHandle {
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
    executable: "C:\\Prime Continuim\\Prime Continuim.exe",
    moduleUrl: "file:///C:/Prime%20Continuim/runtime/node_modules/prime-agent/dist/index.js",
    cliEntrypoint: "C:\\Prime Continuim\\runtime\\node_modules\\prime-agent\\dist\\bundle\\cli.js",
  }) as unknown as VerifiedInstalledRuntimeHandle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
