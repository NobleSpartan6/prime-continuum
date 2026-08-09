import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  RuntimeModelCatalogSnapshotSchema,
  type RuntimeModelCatalogSnapshot,
  type RuntimeModelOption,
  type RuntimeModelProvider,
} from "../shared/protocol";
import type { VerifiedInstalledRuntimeHandle } from "./runtime-integrity-manager";
import type { PrimeAgentRuntimeSecurityGate } from "./prime-agent-auth-security";

const MAX_RUNTIME_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_HELPER_STDERR_BYTES = 64 * 1024;
const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_HELPER_TIMEOUT_MS = 180_000;
const MAX_HELPER_TIMEOUT_MS = 300_000;
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

const HelperTextSchema = z.string().min(1).max(4_096).refine((value) => !/[\0\r\n]/.test(value));
const HelperModelSchema = z.object({
  provider: HelperTextSchema.max(128),
  id: HelperTextSchema.max(512),
  name: HelperTextSchema.max(255),
  api: HelperTextSchema.max(128),
  reasoning: z.boolean(),
  input: z.array(z.enum(["text", "image"])).min(1).max(2)
    .refine((value) => new Set(value).size === value.length),
  contextWindow: z.number().int().positive().safe(),
  maxTokens: z.number().int().positive().safe(),
  available: z.boolean(),
  usingOAuth: z.boolean(),
}).strict();
const HelperOAuthProviderSchema = z.object({
  id: HelperTextSchema.max(128),
  name: HelperTextSchema.max(255),
  usesCallbackServer: z.boolean().optional(),
}).strict();
const HelperProviderStateSchema = z.object({
  providerId: HelperTextSchema.max(128),
  displayName: HelperTextSchema.max(255),
  configured: z.boolean(),
  source: HelperTextSchema.max(64).optional(),
}).strict();
const RuntimeCatalogHelperPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  models: z.array(HelperModelSchema).max(5_000),
  oauthProviders: z.array(HelperOAuthProviderSchema).max(128),
  providerStates: z.array(HelperProviderStateSchema).max(5_000),
}).strict();

type RuntimeCatalogHelperPayload = z.infer<typeof RuntimeCatalogHelperPayloadSchema>;
type RuntimeCatalogHelperModel = Omit<z.infer<typeof HelperModelSchema>, "available" | "usingOAuth">;
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

export interface VerifiedRuntimeHandleProvider {
  acquireVerifiedRuntimeHandle(): Promise<VerifiedInstalledRuntimeHandle>;
}

export interface RuntimeModelCatalogProvider {
  read(): Promise<RuntimeModelCatalogSnapshot>;
  capabilityReady?(): Promise<boolean>;
  invalidate?(): void;
}

export interface RuntimeModelCatalogHelperRunOptions {
  readonly timeoutMs?: number;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

export interface VerifiedRuntimeModelCatalogOptions {
  readonly runtimeHandles: VerifiedRuntimeHandleProvider;
  /** Test seam; production always uses the bounded, isolated helper below. */
  readonly runHelper?: (
    handle: VerifiedInstalledRuntimeHandle,
    options: RuntimeModelCatalogHelperRunOptions,
  ) => Promise<unknown>;
  readonly helperEnvironment?: Readonly<NodeJS.ProcessEnv>;
  readonly helperTimeoutMs?: number;
  readonly now?: () => Date;
  readonly cacheTtlMs?: number;
  /** Shared production custody proof; tests that exercise pure catalog logic may omit it. */
  readonly credentialSecurity?: PrimeAgentRuntimeSecurityGate;
}

export interface RuntimeModelCatalogHelperInvocation {
  readonly executable: string;
  readonly argv: readonly ["--input-type=module", "--eval", string, "--", string];
  readonly spawn: Readonly<{
    shell: false;
    windowsHide: true;
    cwd: string;
    env: Readonly<Record<string, string>>;
    stdio: readonly ["ignore", "pipe", "pipe"];
  }>;
}

export class RuntimeModelCatalogContractError extends Error {
  readonly code = "RUNTIME_MODEL_CATALOG_INVALID" as const;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "RuntimeModelCatalogContractError";
  }
}

/**
 * Reads model compatibility from an identity-checked Prime Agent tree without
 * ever importing third-party runtime code into long-lived hostd. Prime Agent
 * v0.7.0 registers process signal handlers during module evaluation, so the
 * exact verified Electron RunAsNode executable performs discovery in a
 * short-lived child and returns one bounded, secret-free JSON projection.
 */
export class VerifiedRuntimeModelCatalog implements RuntimeModelCatalogProvider {
  private readonly runtimeHandles: VerifiedRuntimeHandleProvider;
  private readonly runHelper: NonNullable<VerifiedRuntimeModelCatalogOptions["runHelper"]>;
  private readonly helperEnvironment: Readonly<NodeJS.ProcessEnv>;
  private readonly helperTimeoutMs: number;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private readonly credentialSecurity: PrimeAgentRuntimeSecurityGate | undefined;
  private cached: { readonly value: RuntimeModelCatalogSnapshot; readonly loadedAtMs: number } | undefined;
  private activeRead: Promise<RuntimeModelCatalogSnapshot> | undefined;

  constructor(options: VerifiedRuntimeModelCatalogOptions) {
    this.runtimeHandles = options.runtimeHandles;
    this.runHelper = options.runHelper ?? runRuntimeModelCatalogHelper;
    this.helperEnvironment = options.helperEnvironment ?? process.env;
    this.helperTimeoutMs = options.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.credentialSecurity = options.credentialSecurity;
    if (!Number.isSafeInteger(this.cacheTtlMs) || this.cacheTtlMs < 0 || this.cacheTtlMs > 60_000) {
      throw new TypeError("Runtime model catalog cache TTL must be an integer from 0 to 60000 milliseconds");
    }
    assertHelperTimeout(this.helperTimeoutMs);
  }

  invalidate(): void {
    this.cached = undefined;
  }

  async capabilityReady(): Promise<boolean> {
    if (this.credentialSecurity?.capabilityAvailable?.() === false) {
      void this.credentialSecurity.prepareAndVerify().catch(() => undefined);
      return false;
    }
    try {
      await this.credentialSecurity?.assertStillSecure();
      return true;
    } catch {
      this.cached = undefined;
      return false;
    }
  }

  async read(): Promise<RuntimeModelCatalogSnapshot> {
    await this.credentialSecurity?.assertStillSecure();
    return this.readSecured();
  }

  private readSecured(): Promise<RuntimeModelCatalogSnapshot> {
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
    const discovered = await this.runHelper(handle, {
      timeoutMs: this.helperTimeoutMs,
      environment: this.helperEnvironment,
    });
    const snapshot = sanitizeRuntimeCatalogDiscovery(
      discovered,
      handle.identity.releaseVersion,
      observedAt.toISOString(),
    );
    // A helper can race a path/permission change. Never publish or cache its
    // result unless the same shared custody proof still holds afterwards.
    await this.credentialSecurity?.assertStillSecure({ force: true });
    this.cached = { value: snapshot, loadedAtMs };
    return snapshot;
  }
}

/** Build the fixed argv vector used for packaged and development runtimes. */
export function buildRuntimeModelCatalogHelperInvocation(
  handle: VerifiedInstalledRuntimeHandle,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): RuntimeModelCatalogHelperInvocation {
  const executable = boundedAbsolutePath(handle.executable, "verified runtime executable");
  const moduleUrl = boundedModuleUrl(handle.moduleUrl);
  const modulePath = fileURLToPath(moduleUrl);
  return Object.freeze({
    executable,
    argv: Object.freeze([
      "--input-type=module",
      "--eval",
      RUNTIME_MODEL_CATALOG_HELPER_SOURCE,
      "--",
      moduleUrl,
    ] as const),
    spawn: Object.freeze({
      shell: false as const,
      windowsHide: true as const,
      cwd: dirname(modulePath),
      env: sanitizeRuntimeCatalogHelperEnvironment(environment),
      stdio: Object.freeze(["ignore", "pipe", "pipe"] as const),
    }),
  });
}

/**
 * Launches only the executable and file URL carried by the freshly verified
 * runtime handle. Output and stderr are bounded before they are buffered;
 * stderr, signals, non-zero exits, timeouts, extra properties, and malformed
 * UTF-8/JSON all fail closed without echoing child output into error messages.
 */
export async function runRuntimeModelCatalogHelper(
  handle: VerifiedInstalledRuntimeHandle,
  options: RuntimeModelCatalogHelperRunOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
  assertHelperTimeout(timeoutMs);
  const invocation = buildRuntimeModelCatalogHelperInvocation(handle, options.environment ?? process.env);
  let child: ChildProcess;
  try {
    child = spawnChildProcess(invocation.executable, [...invocation.argv], {
      shell: invocation.spawn.shell,
      windowsHide: invocation.spawn.windowsHide,
      cwd: invocation.spawn.cwd,
      env: { ...invocation.spawn.env },
      stdio: [...invocation.spawn.stdio],
    });
  } catch (error) {
    throw new RuntimeModelCatalogContractError("Prime Agent model catalog helper could not be started", { cause: error });
  }

  return await collectRuntimeModelCatalogHelper(child, timeoutMs);
}

/**
 * Preserves provider credentials/config discovery while stripping every Node,
 * Electron, and Prime internal variable that can preload code or inherit a
 * conflicting process role. The verified executable is always forced into
 * Electron RunAsNode mode.
 */
export function sanitizeRuntimeCatalogHelperEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (
      normalized === "NODE_OPTIONS" ||
      normalized === "NODE_PATH" ||
      normalized === "NODE_DEBUG" ||
      normalized === "NODE_DEBUG_NATIVE" ||
      normalized === "NODE_INSPECT_RESUME_ON_START" ||
      normalized === "ELECTRON_RUN_AS_NODE" ||
      normalized === "ELECTRON_RENDERER_URL" ||
      normalized === "ELECTRON_ENABLE_LOGGING" ||
      normalized === "ELECTRON_ENABLE_STACK_DUMPING" ||
      normalized.startsWith("PRIME_AGENT_INTERNAL_") ||
      normalized === "PRIME_AGENT_BUILD_ID" ||
      normalized === "PRIME_AGENT_LAUNCHER_PATH"
    ) {
      continue;
    }
    if (/[\0=]/.test(key) || /\0/.test(value)) {
      throw new RuntimeModelCatalogContractError("Runtime model catalog helper environment is malformed");
    }
    sanitized[key] = value;
  }
  sanitized.ELECTRON_RUN_AS_NODE = "1";
  return Object.freeze(sanitized);
}

/** Pure projection helper retained for contract tests; production uses the child process above. */
export function sanitizeRuntimeCatalog(
  authStorage: PrimeAuthStoragePublic,
  registry: PrimeModelRegistryPublic,
  releaseVersion: string,
  observedAt: string,
): RuntimeModelCatalogSnapshot {
  return sanitizeRuntimeCatalogDiscovery(
    collectRuntimeCatalogDiscovery(authStorage, registry),
    releaseVersion,
    observedAt,
  );
}

function sanitizeRuntimeCatalogDiscovery(
  value: unknown,
  releaseVersion: string,
  observedAt: string,
): RuntimeModelCatalogSnapshot {
  const parsed = RuntimeCatalogHelperPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeModelCatalogContractError("Prime Agent returned a malformed model or OAuth catalog");
  }
  const discovery = parsed.data;
  const oauthProviders = new Map<string, z.infer<typeof HelperOAuthProviderSchema>>();
  for (const provider of discovery.oauthProviders) {
    if (oauthProviders.has(provider.id)) {
      throw new RuntimeModelCatalogContractError(`Prime Agent returned duplicate OAuth provider ${provider.id}`);
    }
    oauthProviders.set(provider.id, provider);
  }
  const providerStates = new Map<string, z.infer<typeof HelperProviderStateSchema>>();
  for (const provider of discovery.providerStates) {
    if (providerStates.has(provider.providerId)) {
      throw new RuntimeModelCatalogContractError(`Prime Agent returned duplicate provider state ${provider.providerId}`);
    }
    providerStates.set(provider.providerId, provider);
  }

  const modelKeys = new Set<string>();
  const models: RuntimeModelOption[] = discovery.models.map((model) => {
    const key = modelKey({ providerId: model.provider, modelId: model.id });
    if (modelKeys.has(key)) {
      throw new RuntimeModelCatalogContractError(`Prime Agent returned duplicate model ${model.provider}/${model.id}`);
    }
    modelKeys.add(key);
    return {
      providerId: model.provider,
      modelId: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      available: model.available,
      usingOAuth: model.usingOAuth,
    };
  });
  models.sort(compareModels);

  const providerIds = new Set(models.map((model) => model.providerId));
  for (const providerId of oauthProviders.keys()) providerIds.add(providerId);
  if (
    providerStates.size !== providerIds.size ||
    [...providerIds].some((providerId) => !providerStates.has(providerId))
  ) {
    throw new RuntimeModelCatalogContractError("Prime Agent returned an incomplete or extra provider state catalog");
  }

  const providers: RuntimeModelProvider[] = [...providerIds].map((providerId) => {
    const state = providerStates.get(providerId) as z.infer<typeof HelperProviderStateSchema>;
    const oauth = oauthProviders.get(providerId);
    const providerModels = models.filter((model) => model.providerId === providerId);
    const authSource = normalizeAuthSource(state.source, providerId);
    return {
      providerId,
      displayName: oauth?.name ?? state.displayName,
      oauthSupported: oauth !== undefined,
      ...(oauth?.usesCallbackServer === undefined
        ? {}
        : { oauthUsesCallbackServer: oauth.usesCallbackServer }),
      configured: state.configured,
      ...(authSource ? { authSource } : {}),
      modelCount: providerModels.length,
      availableModelCount: providerModels.filter((model) => model.available).length,
    };
  });
  providers.sort((left, right) => compareText(left.displayName, right.displayName) || compareText(left.providerId, right.providerId));

  const snapshot = RuntimeModelCatalogSnapshotSchema.parse({
    runtime: "prime_agent",
    releaseVersion,
    observedAt,
    providers,
    models,
  });
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_RUNTIME_CATALOG_BYTES) {
    throw new RuntimeModelCatalogContractError("Prime Agent model catalog exceeded the bounded host response size");
  }
  return deepFreeze(snapshot);
}

function collectRuntimeCatalogDiscovery(
  authStorage: PrimeAuthStoragePublic,
  registry: PrimeModelRegistryPublic,
): RuntimeCatalogHelperPayload {
  const rawModels = registry.getAll();
  const rawAvailable = registry.getAvailable();
  const rawOAuthProviders = authStorage.getOAuthProviders();
  if (!Array.isArray(rawModels) || !Array.isArray(rawAvailable) || !Array.isArray(rawOAuthProviders)) {
    throw new RuntimeModelCatalogContractError("Prime Agent returned a malformed model or OAuth catalog");
  }
  if (rawModels.length > 5_000 || rawAvailable.length > 5_000 || rawOAuthProviders.length > 128) {
    throw new RuntimeModelCatalogContractError("Prime Agent model or OAuth catalog exceeded host bounds");
  }
  const availableKeys = new Set(rawAvailable.map((model, index) => {
    const normalized = normalizeModel(model, index);
    return modelKey({ providerId: normalized.provider, modelId: normalized.id });
  }));
  const models = rawModels.map((model, index) => {
    const normalized = normalizeModel(model, index);
    return {
      ...normalized,
      available: availableKeys.has(modelKey({ providerId: normalized.provider, modelId: normalized.id })),
      usingOAuth: strictBoolean(registry.isUsingOAuth(model), `OAuth state for ${normalized.provider}/${normalized.id}`),
    };
  });
  const oauthProviders = rawOAuthProviders.map((provider, index) => normalizeOAuthProvider(provider, index));
  const providerIds = new Set(models.map((model) => model.provider));
  for (const provider of oauthProviders) providerIds.add(provider.id);
  const providerStates = [...providerIds].map((providerId) => {
    const authStatus = registry.getProviderAuthStatus(providerId);
    const source = authStatus?.source;
    return {
      providerId,
      displayName: boundedString(registry.getProviderDisplayName(providerId), 255, `Display name for ${providerId}`),
      configured: strictBoolean(authStatus?.configured, `Auth status for ${providerId}`),
      ...(source === undefined ? {} : { source: boundedString(source, 64, `Auth source for ${providerId}`) }),
    };
  });
  return RuntimeCatalogHelperPayloadSchema.parse({ schemaVersion: 1, models, oauthProviders, providerStates });
}

function collectRuntimeModelCatalogHelper(
  child: ChildProcess,
  timeoutMs: number,
): Promise<RuntimeCatalogHelperPayload> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      child.kill("SIGKILL");
      reject(new RuntimeModelCatalogContractError("Prime Agent model catalog helper streams were unavailable"));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: RuntimeModelCatalogContractError | undefined;
    let settled = false;
    let forcedSettlement: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forcedSettlement) clearTimeout(forcedSettlement);
    };
    const settleFailure = (error: RuntimeModelCatalogContractError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const terminate = (error: RuntimeModelCatalogContractError): void => {
      if (failure) return;
      failure = error;
      try {
        child.kill("SIGKILL");
      } catch {
        // The close/error event or bounded fallback below settles the request.
      }
      forcedSettlement = setTimeout(() => {
        child.unref();
        settleFailure(error);
      }, 2_000);
      forcedSettlement.unref();
    };
    const timeout = setTimeout(() => {
      terminate(new RuntimeModelCatalogContractError("Prime Agent model catalog helper timed out"));
    }, timeoutMs);
    timeout.unref();

    stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > MAX_RUNTIME_CATALOG_BYTES) {
        terminate(new RuntimeModelCatalogContractError("Prime Agent model catalog helper output exceeded its bound"));
        return;
      }
      stdoutChunks.push(Buffer.from(bytes));
    });
    stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      terminate(new RuntimeModelCatalogContractError(
        stderrBytes > MAX_HELPER_STDERR_BYTES
          ? "Prime Agent model catalog helper stderr exceeded its bound"
          : "Prime Agent model catalog helper wrote to stderr",
      ));
    });
    child.once("error", (error) => {
      settleFailure(failure ?? new RuntimeModelCatalogContractError(
        "Prime Agent model catalog helper could not be started",
        { cause: error },
      ));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (failure) {
        settleFailure(failure);
        return;
      }
      if (signal !== null || code !== 0) {
        settleFailure(new RuntimeModelCatalogContractError("Prime Agent model catalog helper exited unsuccessfully"));
        return;
      }
      try {
        const parsed = parseRuntimeModelCatalogHelperOutput(Buffer.concat(stdoutChunks, stdoutBytes));
        settled = true;
        cleanup();
        resolve(parsed);
      } catch (error) {
        settleFailure(error instanceof RuntimeModelCatalogContractError
          ? error
          : new RuntimeModelCatalogContractError("Prime Agent model catalog helper output was invalid", { cause: error }));
      }
    });
  });
}

function parseRuntimeModelCatalogHelperOutput(bytes: Uint8Array): RuntimeCatalogHelperPayload {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_RUNTIME_CATALOG_BYTES) {
    throw new RuntimeModelCatalogContractError("Prime Agent model catalog helper output had an invalid size");
  }
  let value: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new RuntimeModelCatalogContractError("Prime Agent model catalog helper output was not valid JSON", { cause: error });
  }
  const parsed = RuntimeCatalogHelperPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeModelCatalogContractError("Prime Agent model catalog helper output violated its contract");
  }
  return parsed.data;
}

function normalizeModel(value: unknown, index: number): RuntimeCatalogHelperModel {
  if (!isRecord(value)) throw new RuntimeModelCatalogContractError(`Prime Agent model ${index} is malformed`);
  const provider = boundedString(value.provider, 128, `Provider for model ${index}`);
  const id = boundedString(value.id, 512, `Identifier for model ${index}`);
  const input = value.input;
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 2 ||
    new Set(input).size !== input.length ||
    input.some((kind) => kind !== "text" && kind !== "image")
  ) {
    throw new RuntimeModelCatalogContractError(`Input capabilities for ${provider}/${id} are malformed`);
  }
  return {
    provider,
    id,
    name: boundedString(value.name, 255, `Name for ${provider}/${id}`),
    api: boundedString(value.api, 128, `API for ${provider}/${id}`),
    reasoning: strictBoolean(value.reasoning, `Reasoning state for ${provider}/${id}`),
    input: [...input] as Array<"text" | "image">,
    contextWindow: positiveSafeInteger(value.contextWindow, `Context window for ${provider}/${id}`),
    maxTokens: positiveSafeInteger(value.maxTokens, `Output limit for ${provider}/${id}`),
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
  return JSON.stringify([model.providerId, model.modelId]);
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

function boundedAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    /[\0\r\n]/.test(value) ||
    !isAbsolute(value)
  ) {
    throw new RuntimeModelCatalogContractError(`Prime Agent ${label} is malformed`);
  }
  return value;
}

function boundedModuleUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || /[\0\r\n]/.test(value)) {
    throw new RuntimeModelCatalogContractError("Prime Agent verified runtime module URL is malformed");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new RuntimeModelCatalogContractError("Prime Agent verified runtime module URL is malformed", { cause: error });
  }
  if (parsed.protocol !== "file:" || parsed.search || parsed.hash) {
    throw new RuntimeModelCatalogContractError("Prime Agent verified runtime module URL is malformed");
  }
  const path = fileURLToPath(parsed);
  boundedAbsolutePath(path, "verified runtime module path");
  return parsed.href;
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

function assertHelperTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 10 || value > MAX_HELPER_TIMEOUT_MS) {
    throw new TypeError(`Runtime model catalog helper timeout must be an integer from 10 to ${MAX_HELPER_TIMEOUT_MS} milliseconds`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// Keep this source below Windows' process command-line limit. It intentionally
// selects only public catalog fields before serialization; runtime objects,
// headers, base URLs, token values, and credential material stay in the child.
const RUNTIME_MODEL_CATALOG_HELPER_SOURCE = String.raw`
const moduleUrl = process.argv[1];
if (!moduleUrl) throw new Error("missing verified runtime module URL");
const runtime = await import(moduleUrl);
if (!runtime || typeof runtime !== "object" || typeof runtime.AuthStorage?.create !== "function" || typeof runtime.ModelRegistry?.create !== "function") throw new Error("missing runtime catalog exports");
const authStorage = runtime.AuthStorage.create();
const registry = runtime.ModelRegistry.create(authStorage);
const rawModels = registry.getAll();
const rawAvailable = registry.getAvailable();
const rawOAuthProviders = authStorage.getOAuthProviders();
if (!Array.isArray(rawModels) || !Array.isArray(rawAvailable) || !Array.isArray(rawOAuthProviders)) throw new Error("malformed runtime catalog");
if (rawModels.length > 5000 || rawAvailable.length > 5000 || rawOAuthProviders.length > 128) throw new Error("runtime catalog exceeded bounds");
const key = (model) => JSON.stringify([model?.provider, model?.id]);
const available = new Set(rawAvailable.map(key));
const models = rawModels.map((model) => ({
  provider: model?.provider,
  id: model?.id,
  name: model?.name,
  api: model?.api,
  reasoning: model?.reasoning,
  input: model?.input,
  contextWindow: model?.contextWindow,
  maxTokens: model?.maxTokens,
  available: available.has(key(model)),
  usingOAuth: registry.isUsingOAuth(model),
}));
const oauthProviders = rawOAuthProviders.map((provider) => ({
  id: provider?.id,
  name: provider?.name,
  ...(provider?.usesCallbackServer === undefined ? {} : { usesCallbackServer: provider.usesCallbackServer }),
}));
const providerIds = new Set(models.map((model) => model.provider));
for (const provider of oauthProviders) providerIds.add(provider.id);
const providerStates = [...providerIds].map((providerId) => {
  const status = registry.getProviderAuthStatus(providerId);
  return {
    providerId,
    displayName: registry.getProviderDisplayName(providerId),
    configured: status?.configured,
    ...(status?.source === undefined ? {} : { source: status.source }),
  };
});
process.stdout.write(JSON.stringify({ schemaVersion: 1, models, oauthProviders, providerStates }));
`;
