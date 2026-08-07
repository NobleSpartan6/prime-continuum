import {
  RuntimeModelCatalogSnapshotSchema,
  type RuntimeModelCatalogSnapshot,
  type RuntimeModelOption,
  type RuntimeModelProvider,
} from "../shared/protocol";
import type { VerifiedInstalledRuntimeHandle } from "./runtime-integrity-manager";

const MAX_RUNTIME_CATALOG_BYTES = 2 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 15_000;
const AUTH_SOURCES = new Set([
  "stored",
  "runtime",
  "environment",
  "prime_cli",
  "fallback",
  "models_json_key",
  "models_json_command",
  "stale",
]);

type RuntimeAuthSource = NonNullable<RuntimeModelProvider["authSource"]>;

interface PrimeOAuthProviderPublic {
  readonly id: unknown;
  readonly name: unknown;
  readonly usesCallbackServer?: unknown;
}

interface PrimeAuthStoragePublic {
  getOAuthProviders(): unknown;
}

interface PrimeAuthStatusPublic {
  readonly configured?: unknown;
  readonly source?: unknown;
}

interface PrimeModelPublic {
  readonly provider?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly api?: unknown;
  readonly reasoning?: unknown;
  readonly input?: unknown;
  readonly contextWindow?: unknown;
  readonly maxTokens?: unknown;
}

interface PrimeModelRegistryPublic {
  getAll(): unknown;
  getAvailable(): unknown;
  getProviderAuthStatus(provider: string): PrimeAuthStatusPublic;
  getProviderDisplayName(provider: string): unknown;
  isUsingOAuth(model: PrimeModelPublic): unknown;
}

interface PrimeAgentCatalogModulePublic {
  readonly AuthStorage: Readonly<{
    create(): PrimeAuthStoragePublic;
  }>;
  readonly ModelRegistry: Readonly<{
    create(authStorage: PrimeAuthStoragePublic): PrimeModelRegistryPublic;
  }>;
}

export interface VerifiedRuntimeHandleProvider {
  acquireVerifiedRuntimeHandle(): Promise<VerifiedInstalledRuntimeHandle>;
}

export interface RuntimeModelCatalogProvider {
  read(): Promise<RuntimeModelCatalogSnapshot>;
}

export interface VerifiedRuntimeModelCatalogOptions {
  readonly runtimeHandles: VerifiedRuntimeHandleProvider;
  readonly loadRuntimeModule?: (moduleUrl: string) => Promise<unknown>;
  readonly now?: () => Date;
  readonly cacheTtlMs?: number;
}

export class RuntimeModelCatalogContractError extends Error {
  readonly code = "RUNTIME_MODEL_CATALOG_INVALID" as const;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "RuntimeModelCatalogContractError";
  }
}

/**
 * Reads model compatibility from the freshly verified Prime Agent module and
 * projects a bounded, secret-free host contract. Credential values, provider
 * headers, base URLs, custom key commands, and OAuth token material never
 * leave the runtime process boundary.
 */
export class VerifiedRuntimeModelCatalog implements RuntimeModelCatalogProvider {
  private readonly runtimeHandles: VerifiedRuntimeHandleProvider;
  private readonly loadRuntimeModule: (moduleUrl: string) => Promise<unknown>;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private cached: { readonly value: RuntimeModelCatalogSnapshot; readonly loadedAtMs: number } | undefined;
  private activeRead: Promise<RuntimeModelCatalogSnapshot> | undefined;

  constructor(options: VerifiedRuntimeModelCatalogOptions) {
    this.runtimeHandles = options.runtimeHandles;
    this.loadRuntimeModule = options.loadRuntimeModule ?? ((moduleUrl) => import(moduleUrl));
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (!Number.isSafeInteger(this.cacheTtlMs) || this.cacheTtlMs < 0 || this.cacheTtlMs > 60_000) {
      throw new TypeError("Runtime model catalog cache TTL must be an integer from 0 to 60000 milliseconds");
    }
  }

  read(): Promise<RuntimeModelCatalogSnapshot> {
    const now = this.now();
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) {
      return Promise.reject(new RuntimeModelCatalogContractError("Runtime model catalog clock is invalid"));
    }
    const cachedAgeMs = this.cached ? nowMs - this.cached.loadedAtMs : undefined;
    if (this.cached && cachedAgeMs !== undefined && cachedAgeMs >= 0 && cachedAgeMs <= this.cacheTtlMs) {
      return Promise.resolve(this.cached.value);
    }
    if (this.activeRead) return this.activeRead;

    const read = this.refresh(now, nowMs);
    this.activeRead = read;
    const clear = (): void => {
      if (this.activeRead === read) this.activeRead = undefined;
    };
    void read.then(clear, clear);
    return read;
  }

  private async refresh(observedAt: Date, loadedAtMs: number): Promise<RuntimeModelCatalogSnapshot> {
    const handle = await this.runtimeHandles.acquireVerifiedRuntimeHandle();
    const runtime = assertRuntimeModule(await this.loadRuntimeModule(handle.moduleUrl));
    const authStorage = runtime.AuthStorage.create();
    const registry = runtime.ModelRegistry.create(authStorage);
    const snapshot = sanitizeRuntimeCatalog(
      authStorage,
      registry,
      handle.identity.releaseVersion,
      observedAt.toISOString(),
    );
    this.cached = { value: snapshot, loadedAtMs };
    return snapshot;
  }
}

export function sanitizeRuntimeCatalog(
  authStorage: PrimeAuthStoragePublic,
  registry: PrimeModelRegistryPublic,
  releaseVersion: string,
  observedAt: string,
): RuntimeModelCatalogSnapshot {
  const rawModels = registry.getAll();
  const rawAvailable = registry.getAvailable();
  const rawOAuthProviders = authStorage.getOAuthProviders();
  if (!Array.isArray(rawModels) || !Array.isArray(rawAvailable) || !Array.isArray(rawOAuthProviders)) {
    throw new RuntimeModelCatalogContractError("Prime Agent returned a malformed model or OAuth catalog");
  }
  if (rawModels.length > 5_000 || rawAvailable.length > 5_000 || rawOAuthProviders.length > 128) {
    throw new RuntimeModelCatalogContractError("Prime Agent model or OAuth catalog exceeded host bounds");
  }

  const models = rawModels.map((model, index) => normalizeModel(model, index));
  const availableKeys = new Set(rawAvailable.map((model, index) => modelKey(normalizeModel(model, index))));
  const oauthProviders = new Map<string, { readonly name: string; readonly usesCallbackServer?: boolean }>();
  rawOAuthProviders.forEach((provider, index) => {
    const normalized = normalizeOAuthProvider(provider, index);
    if (oauthProviders.has(normalized.id)) {
      throw new RuntimeModelCatalogContractError(`Prime Agent returned duplicate OAuth provider ${normalized.id}`);
    }
    oauthProviders.set(normalized.id, {
      name: normalized.name,
      ...(normalized.usesCallbackServer === undefined
        ? {}
        : { usesCallbackServer: normalized.usesCallbackServer }),
    });
  });

  const providerIds = new Set(models.map((model) => model.providerId));
  for (const providerId of oauthProviders.keys()) providerIds.add(providerId);

  const modelOptions: RuntimeModelOption[] = models.map(({ raw, ...model }) => ({
    ...model,
    available: availableKeys.has(modelKey(model)),
    usingOAuth: strictBoolean(registry.isUsingOAuth(raw), `OAuth state for ${model.providerId}/${model.modelId}`),
  }));
  modelOptions.sort(compareModels);

  const providers: RuntimeModelProvider[] = [...providerIds].map((providerId) => {
    const providerModels = modelOptions.filter((model) => model.providerId === providerId);
    const oauth = oauthProviders.get(providerId);
    const authStatus = registry.getProviderAuthStatus(providerId);
    const configured = strictBoolean(authStatus?.configured, `Auth status for ${providerId}`);
    const authSource = normalizeAuthSource(authStatus?.source, providerId);
    const displayName = oauth?.name ?? boundedString(
      registry.getProviderDisplayName(providerId),
      255,
      `Display name for ${providerId}`,
    );
    return {
      providerId,
      displayName,
      oauthSupported: oauth !== undefined,
      ...(oauth?.usesCallbackServer === undefined
        ? {}
        : { oauthUsesCallbackServer: oauth.usesCallbackServer }),
      configured,
      ...(authSource ? { authSource } : {}),
      modelCount: providerModels.length,
      availableModelCount: providerModels.filter((model) => model.available).length,
    };
  });
  providers.sort((left, right) => compareText(left.displayName, right.displayName) || compareText(left.providerId, right.providerId));

  const parsed = RuntimeModelCatalogSnapshotSchema.parse({
    runtime: "prime_agent",
    releaseVersion,
    observedAt,
    providers,
    models: modelOptions,
  });
  const bytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
  if (bytes > MAX_RUNTIME_CATALOG_BYTES) {
    throw new RuntimeModelCatalogContractError("Prime Agent model catalog exceeded the bounded host response size");
  }
  return deepFreeze(parsed);
}

function assertRuntimeModule(value: unknown): PrimeAgentCatalogModulePublic {
  if (!isRecord(value)) throw new RuntimeModelCatalogContractError("Prime Agent module export is not an object");
  const authStorage = value.AuthStorage;
  const modelRegistry = value.ModelRegistry;
  if (
    !hasCallableProperty(authStorage, "create") ||
    typeof authStorage.create !== "function" ||
    !hasCallableProperty(modelRegistry, "create") ||
    typeof modelRegistry.create !== "function"
  ) {
    throw new RuntimeModelCatalogContractError("Prime Agent module is missing model catalog exports");
  }
  return value as unknown as PrimeAgentCatalogModulePublic;
}

function hasCallableProperty(value: unknown, property: string): value is Record<string, (...args: never[]) => unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function")
    && typeof (value as Record<string, unknown>)[property] === "function";
}

function normalizeModel(value: unknown, index: number): RuntimeModelOption & { readonly raw: PrimeModelPublic } {
  if (!isRecord(value)) throw new RuntimeModelCatalogContractError(`Prime Agent model ${index} is malformed`);
  const providerId = boundedString(value.provider, 128, `Provider for model ${index}`);
  const modelId = boundedString(value.id, 512, `Identifier for model ${index}`);
  const input = value.input;
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 2 ||
    input.some((kind) => kind !== "text" && kind !== "image")
  ) {
    throw new RuntimeModelCatalogContractError(`Input capabilities for ${providerId}/${modelId} are malformed`);
  }
  return {
    providerId,
    modelId,
    name: boundedString(value.name, 255, `Name for ${providerId}/${modelId}`),
    api: boundedString(value.api, 128, `API for ${providerId}/${modelId}`),
    reasoning: strictBoolean(value.reasoning, `Reasoning state for ${providerId}/${modelId}`),
    input: [...input] as Array<"text" | "image">,
    contextWindow: positiveSafeInteger(value.contextWindow, `Context window for ${providerId}/${modelId}`),
    maxOutputTokens: positiveSafeInteger(value.maxTokens, `Output limit for ${providerId}/${modelId}`),
    available: false,
    usingOAuth: false,
    raw: value as PrimeModelPublic,
  };
}

function normalizeOAuthProvider(value: unknown, index: number): {
  readonly id: string;
  readonly name: string;
  readonly usesCallbackServer?: boolean;
} {
  if (!isRecord(value)) throw new RuntimeModelCatalogContractError(`Prime Agent OAuth provider ${index} is malformed`);
  const usesCallbackServer = value.usesCallbackServer;
  if (usesCallbackServer !== undefined && typeof usesCallbackServer !== "boolean") {
    throw new RuntimeModelCatalogContractError(`Prime Agent OAuth provider ${index} has malformed callback metadata`);
  }
  return {
    id: boundedString(value.id, 128, `Identifier for OAuth provider ${index}`),
    name: boundedString(value.name, 255, `Name for OAuth provider ${index}`),
    ...(usesCallbackServer === undefined ? {} : { usesCallbackServer }),
  };
}

function normalizeAuthSource(value: unknown, providerId: string): RuntimeAuthSource | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !AUTH_SOURCES.has(value)) {
    throw new RuntimeModelCatalogContractError(`Prime Agent returned an unknown auth source for ${providerId}`);
  }
  return value as RuntimeAuthSource;
}

function modelKey(model: Pick<RuntimeModelOption, "providerId" | "modelId">): string {
  return `${model.providerId}\u0000${model.modelId}`;
}

function compareModels(left: RuntimeModelOption, right: RuntimeModelOption): number {
  return (
    compareText(left.providerId, right.providerId) ||
    compareText(left.name, right.name) ||
    compareText(left.modelId, right.modelId)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedString(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new RuntimeModelCatalogContractError(`${label} is malformed`);
  }
  return value;
}

function strictBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new RuntimeModelCatalogContractError(`${label} is malformed`);
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeModelCatalogContractError(`${label} is malformed`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
