import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  isPinnedCodexAuthorizationUrl,
} from "../shared/codex-oauth";
import type {
  HostOAuthComposition,
  HostOAuthProvider,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "./oauth-session-broker";
import type { VerifiedInstalledRuntimeHandle } from "./runtime-integrity-manager";
import type { VerifiedRuntimeHandleProvider } from "./runtime-model-catalog";

export { CODEX_SUBSCRIPTION_PROVIDER_ID } from "../shared/codex-oauth";

const CODEX_SUBSCRIPTION_PROVIDER_NAME = "ChatGPT Plus/Pro (Codex Subscription)";
const MAX_HELPER_LINE_BYTES = 2 * 1024 * 1024 + 64 * 1024;
const MAX_HELPER_OUTPUT_BYTES = MAX_HELPER_LINE_BYTES + 256 * 1024;
const MAX_HELPER_MESSAGES = 128;
const MAX_STORAGE_ERRORS = 64;
const HELPER_START_TIMEOUT_MS = 15_000;
const HELPER_REQUEST_TIMEOUT_MS = 15_000;

export interface RuntimeOAuthStorageSession {
  set(providerId: string, auth: { readonly type: "oauth"; readonly [key: string]: unknown }): Promise<void>;
  drainErrors(): Promise<readonly unknown[]>;
  reload(): Promise<void>;
  getAuthStatus(providerId: string): Promise<{ readonly configured: unknown }>;
  close(): Promise<void>;
}

export interface VerifiedRuntimeOAuthCompositionOptions {
  readonly runtimeHandles: VerifiedRuntimeHandleProvider;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /** Test seam. Production always launches the exact verified runtime helper. */
  readonly runLogin?: (
    handle: VerifiedInstalledRuntimeHandle,
    providerId: string,
    callbacks: OAuthLoginCallbacks,
    environment: Readonly<NodeJS.ProcessEnv>,
  ) => Promise<OAuthCredentials>;
  /** Test seam. Production always launches the exact verified runtime helper. */
  readonly openStorage?: (
    handle: VerifiedInstalledRuntimeHandle,
    environment: Readonly<NodeJS.ProcessEnv>,
  ) => Promise<RuntimeOAuthStorageSession>;
}

/**
 * Prime Agent v0.7.0 registers process handlers while its public module loads.
 * This composition therefore never imports third-party code into long-lived
 * hostd. Login and AuthStorage run in identity-checked, short-lived helpers;
 * credentials cross only their private stdio pipes and this host-only object.
 */
export class VerifiedRuntimeOAuthComposition implements HostOAuthComposition {
  private readonly runtimeHandles: VerifiedRuntimeHandleProvider;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly runLogin: NonNullable<VerifiedRuntimeOAuthCompositionOptions["runLogin"]>;
  private readonly openStorage: NonNullable<VerifiedRuntimeOAuthCompositionOptions["openStorage"]>;
  private readonly provider: HostOAuthProvider;
  private activeStorage: RuntimeOAuthStorageSession | undefined;
  private terminalHelperFailure: RuntimeOAuthHelperTerminationError | undefined;
  private closed = false;

  constructor(options: VerifiedRuntimeOAuthCompositionOptions) {
    this.runtimeHandles = options.runtimeHandles;
    this.environment = sanitizeRuntimeOAuthHelperEnvironment(options.environment ?? process.env);
    this.runLogin = options.runLogin ?? runRuntimeOAuthLoginHelper;
    this.openStorage = options.openStorage ?? openRuntimeOAuthStorageHelper;
    this.provider = Object.freeze({
      id: CODEX_SUBSCRIPTION_PROVIDER_ID,
      name: CODEX_SUBSCRIPTION_PROVIDER_NAME,
      usesCallbackServer: true,
      login: (callbacks: OAuthLoginCallbacks) => this.login(callbacks),
    });
  }

  getProvider(providerId: string): HostOAuthProvider | undefined {
    if (this.closed || providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID) return undefined;
    return this.provider;
  }

  async set(
    providerId: string,
    auth: { readonly type: "oauth"; readonly [key: string]: unknown },
  ): Promise<void> {
    this.assertOpen();
    if (providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID || this.activeStorage) {
      throw new RuntimeOAuthHelperError("Prime Agent OAuth storage is unavailable");
    }
    const handle = await this.runtimeHandles.acquireVerifiedRuntimeHandle();
    let storage: RuntimeOAuthStorageSession;
    try {
      storage = await this.openStorage(handle, this.environment);
    } catch (error) {
      this.rememberTerminalHelperFailure(error);
      throw error;
    }
    this.activeStorage = storage;
    await storage.set(providerId, auth);
  }

  async drainErrors(): Promise<readonly unknown[]> {
    return this.requireStorage().drainErrors();
  }

  async reload(): Promise<void> {
    await this.requireStorage().reload();
  }

  async getAuthStatus(providerId: string): Promise<{ readonly configured: unknown }> {
    const storage = this.requireStorage();
    try {
      if (providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID) {
        throw new RuntimeOAuthHelperError("Prime Agent OAuth storage is unavailable");
      }
      return await storage.getAuthStatus(providerId);
    } finally {
      try {
        await storage.close();
        if (this.activeStorage === storage) this.activeStorage = undefined;
      } catch (error) {
        this.rememberTerminalHelperFailure(error);
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const storage = this.activeStorage;
    if (storage) {
      try {
        await storage.close();
        if (this.activeStorage === storage) this.activeStorage = undefined;
      } catch (error) {
        this.rememberTerminalHelperFailure(error);
      }
    }
    if (this.terminalHelperFailure) throw this.terminalHelperFailure;
  }

  private async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    this.assertOpen();
    const handle = await this.runtimeHandles.acquireVerifiedRuntimeHandle();
    this.assertOpen();
    try {
      return await this.runLogin(handle, CODEX_SUBSCRIPTION_PROVIDER_ID, callbacks, this.environment);
    } catch (error) {
      this.rememberTerminalHelperFailure(error);
      throw error;
    }
  }

  private requireStorage(): RuntimeOAuthStorageSession {
    this.assertOpen();
    if (!this.activeStorage) throw new RuntimeOAuthHelperError("Prime Agent OAuth storage is unavailable");
    return this.activeStorage;
  }

  private assertOpen(): void {
    if (this.closed) throw new RuntimeOAuthHelperError("Prime Agent OAuth composition is closed");
  }

  private rememberTerminalHelperFailure(error: unknown): void {
    if (error instanceof RuntimeOAuthHelperTerminationError) {
      this.terminalHelperFailure ??= error;
    }
  }
}

export class RuntimeOAuthHelperError extends Error {
  readonly code = "RUNTIME_OAUTH_HELPER_FAILED" as const;

  constructor(message = "Verified Prime Agent OAuth helper failed", options: ErrorOptions = {}) {
    super(message, options);
    this.name = "RuntimeOAuthHelperError";
  }
}

export class RuntimeOAuthHelperTerminationError extends RuntimeOAuthHelperError {
  readonly terminationObserved = false as const;

  constructor() {
    super("Verified Prime Agent OAuth helper termination was not observed");
    this.name = "RuntimeOAuthHelperTerminationError";
  }
}

export interface RuntimeOAuthHelperInvocation {
  readonly executable: string;
  readonly argv: readonly ["--input-type=module", "--eval", string, "--", string, string];
  readonly spawn: Readonly<{
    shell: false;
    windowsHide: true;
    cwd: string;
    env: Readonly<Record<string, string>>;
    stdio: readonly ["pipe", "pipe", "pipe"];
  }>;
}

export function buildRuntimeOAuthLoginHelperInvocation(
  handle: VerifiedInstalledRuntimeHandle,
  providerId: string = CODEX_SUBSCRIPTION_PROVIDER_ID,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): RuntimeOAuthHelperInvocation {
  return buildHelperInvocation(handle, providerId, RUNTIME_OAUTH_LOGIN_HELPER_SOURCE, environment);
}

export function buildRuntimeOAuthStorageHelperInvocation(
  handle: VerifiedInstalledRuntimeHandle,
  providerId: string = CODEX_SUBSCRIPTION_PROVIDER_ID,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): RuntimeOAuthHelperInvocation {
  return buildHelperInvocation(handle, providerId, RUNTIME_OAUTH_STORAGE_HELPER_SOURCE, environment);
}

function buildHelperInvocation(
  handle: VerifiedInstalledRuntimeHandle,
  providerId: string,
  source: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): RuntimeOAuthHelperInvocation {
  const executable = boundedAbsolutePath(handle.executable, "verified runtime executable");
  const moduleUrl = boundedModuleUrl(handle.moduleUrl);
  const provider = boundedIdentifier(providerId, "OAuth provider identifier");
  return Object.freeze({
    executable,
    argv: Object.freeze(["--input-type=module", "--eval", source, "--", moduleUrl, provider] as const),
    spawn: Object.freeze({
      shell: false as const,
      windowsHide: true as const,
      cwd: dirname(fileURLToPath(moduleUrl)),
      env: sanitizeRuntimeOAuthHelperEnvironment(environment),
      stdio: Object.freeze(["pipe", "pipe", "pipe"] as const),
    }),
  });
}

/**
 * OAuth helpers make a token request and own a localhost callback server, so
 * they require a narrower environment than read-only model discovery.
 */
export function sanitizeRuntimeOAuthHelperEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const allowed = new Map<string, string>([
    ["SYSTEMROOT", "SYSTEMROOT"],
    ["WINDIR", "WINDIR"],
    ["HOME", "HOME"],
    ["USERPROFILE", "USERPROFILE"],
    ["HOMEDRIVE", "HOMEDRIVE"],
    ["HOMEPATH", "HOMEPATH"],
    ["TEMP", "TEMP"],
    ["TMP", "TMP"],
    ["TMPDIR", "TMPDIR"],
    // Pinned Prime Agent v0.7.0 getAgentDir() reads this exact key before
    // falling back to os.homedir(). PI_CODING_AGENT_DIR is not consumed.
    ["PRIME_AGENT_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR"],
  ]);
  const sanitized: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    const canonical = allowed.get(normalized);
    if (!canonical) continue;
    if (seen.has(normalized) || value.length < 1 || value.length > 4_096 || /[\0\r\n]/.test(value)) {
      throw new RuntimeOAuthHelperError("Prime Agent OAuth helper environment is invalid");
    }
    if (
      canonical === "PRIME_AGENT_CODING_AGENT_DIR" &&
      !isAbsolute(value) &&
      value !== "~" &&
      !value.startsWith("~/") &&
      !value.startsWith("~\\")
    ) {
      throw new RuntimeOAuthHelperError("Prime Agent OAuth helper environment is invalid");
    }
    seen.add(normalized);
    sanitized[canonical] = value;
  }
  sanitized.ELECTRON_RUN_AS_NODE = "1";
  sanitized.PI_OAUTH_CALLBACK_HOST = "127.0.0.1";
  return Object.freeze(sanitized);
}

export async function runRuntimeOAuthLoginHelper(
  handle: VerifiedInstalledRuntimeHandle,
  providerId: string,
  callbacks: OAuthLoginCallbacks,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<OAuthCredentials> {
  const invocation = buildRuntimeOAuthLoginHelperInvocation(handle, providerId, environment);
  const child = spawnHelper(invocation);
  return new Promise<OAuthCredentials>((resolve, reject) => {
    let providerConfirmed = false;
    let settled = false;
    let buffer = Buffer.alloc(0);
    let outputBytes = 0;
    let messageCount = 0;

    const cleanup = (): void => {
      callbacks.signal?.removeEventListener("abort", onAbort);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
    };
    const fail = (message = "Verified Prime Agent OAuth login helper failed"): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void terminateRuntimeOAuthHelperProcess(child).then(
        () => reject(new RuntimeOAuthHelperError(message)),
        (error) => reject(error instanceof RuntimeOAuthHelperError ? error : new RuntimeOAuthHelperError(message)),
      );
    };
    const complete = (credentials: unknown): void => {
      if (settled || !providerConfirmed || !isRecord(credentials)) return fail();
      settled = true;
      cleanup();
      // The provider closes its callback server in `finally` before returning
      // credentials. Own termination here as well so a future/broken worker
      // cannot leave a privileged helper behind after hostd accepts the frame.
      void terminateRuntimeOAuthHelperProcess(child).then(
        () => resolve(credentials as OAuthCredentials),
        (error) => reject(error instanceof RuntimeOAuthHelperError ? error : new RuntimeOAuthHelperError()),
      );
    };
    const sendResponse = (requestId: string, value: string | undefined): void => {
      if (settled) return;
      writeChildMessage(child, { type: "response", requestId, ...(value === undefined ? {} : { value }) }).catch(() => fail());
    };
    const runRequest = (message: Record<string, unknown>): void => {
      const requestId = boundedIdentifier(message.requestId, "OAuth helper request identifier");
      const kind = message.kind;
      let response: Promise<string | undefined>;
      if (kind === "manual") {
        response = callbacks.onManualCodeInput?.() ?? Promise.resolve(undefined);
      } else if (kind === "prompt") {
        response = callbacks.onPrompt(normalizePrompt(message.prompt));
      } else if (kind === "select") {
        response = callbacks.onSelect?.(normalizeSelection(message.prompt)) ?? Promise.resolve(undefined);
      } else {
        throw new RuntimeOAuthHelperError();
      }
      void response.then((value) => sendResponse(requestId, value), () => fail());
    };
    const handleMessage = (value: unknown): void => {
      if (settled || !isRecord(value) || ++messageCount > MAX_HELPER_MESSAGES) return fail();
      try {
        switch (value.type) {
          case "provider": {
            if (providerConfirmed || value.id !== providerId || value.usesCallbackServer !== true) return fail();
            boundedText(value.name, 255, "OAuth provider name");
            providerConfirmed = true;
            return;
          }
          case "auth":
            if (!providerConfirmed) return fail();
            callbacks.onAuth(normalizeAuthorization(value.info, providerId));
            return;
          case "progress":
            if (!providerConfirmed) return fail();
            callbacks.onProgress?.(boundedText(value.message, 1_024, "OAuth progress"));
            return;
          case "request":
            if (!providerConfirmed) return fail();
            runRequest(value);
            return;
          case "result":
            complete(value.credentials);
            return;
          case "failed":
            return fail();
          default:
            return fail();
        }
      } catch {
        fail();
      }
    };
    const onAbort = (): void => fail("Verified Prime Agent OAuth login was interrupted");
    callbacks.signal?.addEventListener("abort", onAbort, { once: true });
    if (callbacks.signal?.aborted) return onAbort();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled || !Buffer.isBuffer(chunk)) return fail();
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) return fail();
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_HELPER_LINE_BYTES && !buffer.includes(0x0a)) return fail();
      while (!settled) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        if (newline === 0 || newline > MAX_HELPER_LINE_BYTES) return fail();
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        try {
          handleMessage(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
        } catch {
          fail();
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      outputBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : MAX_HELPER_OUTPUT_BYTES + 1;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) fail();
    });
    child.once("error", () => fail());
    child.once("exit", () => {
      if (!settled) fail();
    });
  });
}

export async function openRuntimeOAuthStorageHelper(
  handle: VerifiedInstalledRuntimeHandle,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<RuntimeOAuthStorageSession> {
  const invocation = buildRuntimeOAuthStorageHelperInvocation(handle, CODEX_SUBSCRIPTION_PROVIDER_ID, environment);
  const child = spawnHelper(invocation);
  return RuntimeOAuthStorageChannel.open(child);
}

class RuntimeOAuthStorageChannel implements RuntimeOAuthStorageSession {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = Buffer.alloc(0);
  private outputBytes = 0;
  private messageCount = 0;
  private sequence = 0;
  private closed = false;
  private readySeen = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready: Promise<void>;
  private readonly readyTimer: ReturnType<typeof setTimeout>;
  private teardownPromise: Promise<void> | undefined;

  private constructor(private readonly child: ChildProcess) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyTimer = setTimeout(() => this.fail(), HELPER_START_TIMEOUT_MS);
    this.readyTimer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.outputBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : MAX_HELPER_OUTPUT_BYTES + 1;
      if (this.outputBytes > MAX_HELPER_OUTPUT_BYTES) this.fail();
    });
    child.once("error", () => this.fail());
    child.once("exit", () => this.fail());
  }

  static async open(child: ChildProcess): Promise<RuntimeOAuthStorageChannel> {
    const channel = new RuntimeOAuthStorageChannel(child);
    try {
      await channel.ready;
      return channel;
    } catch (error) {
      try {
        await channel.close();
      } catch (teardownError) {
        throw teardownError;
      }
      throw error;
    }
  }

  async set(providerId: string, auth: { readonly type: "oauth"; readonly [key: string]: unknown }): Promise<void> {
    await this.request("set", { providerId, auth });
  }

  async drainErrors(): Promise<readonly unknown[]> {
    const result = await this.request("drain", {});
    if (!isRecord(result) || !Number.isSafeInteger(result.errorCount) || (result.errorCount as number) < 0 || (result.errorCount as number) > MAX_STORAGE_ERRORS) {
      throw new RuntimeOAuthHelperError();
    }
    return Object.freeze(Array.from({ length: result.errorCount as number }, () => null));
  }

  async reload(): Promise<void> {
    await this.request("reload", {});
  }

  async getAuthStatus(providerId: string): Promise<{ readonly configured: unknown }> {
    const result = await this.request("status", { providerId });
    if (!isRecord(result) || typeof result.configured !== "boolean") throw new RuntimeOAuthHelperError();
    return Object.freeze({ configured: result.configured });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      clearTimeout(this.readyTimer);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new RuntimeOAuthHelperError());
      }
      this.pending.clear();
    }
    await this.beginTeardown();
  }

  private async request(method: string, payload: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new RuntimeOAuthHelperError();
    const requestId = `storage-${++this.sequence}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), HELPER_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
    });
    void writeChildMessage(this.child, { type: "request", requestId, method, ...payload }).catch(() => this.fail());
    return result;
  }

  private onData(chunk: Buffer): void {
    if (this.closed || !Buffer.isBuffer(chunk)) return this.fail();
    this.outputBytes += chunk.byteLength;
    if (this.outputBytes > MAX_HELPER_OUTPUT_BYTES) return this.fail();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > MAX_HELPER_LINE_BYTES && !this.buffer.includes(0x0a)) return this.fail();
    while (!this.closed) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline === 0 || newline > MAX_HELPER_LINE_BYTES) return this.fail();
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        this.onMessage(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
      } catch {
        return this.fail();
      }
    }
  }

  private onMessage(value: unknown): void {
    if (!isRecord(value) || ++this.messageCount > MAX_HELPER_MESSAGES) return this.fail();
    if (value.type === "ready") {
      if (this.readySeen || value.providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID) return this.fail();
      this.readySeen = true;
      clearTimeout(this.readyTimer);
      this.readyResolve();
      return;
    }
    if (!this.readySeen || value.type !== "response" || typeof value.requestId !== "string") return this.fail();
    const pending = this.pending.get(value.requestId);
    if (!pending) return this.fail();
    this.pending.delete(value.requestId);
    clearTimeout(pending.timer);
    if (value.ok === true) pending.resolve(value.result);
    else pending.reject(new RuntimeOAuthHelperError());
  }

  private fail(): void {
    if (!this.closed) {
      this.closed = true;
      clearTimeout(this.readyTimer);
      const error = new RuntimeOAuthHelperError();
      this.readyReject(error);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    }
    void this.beginTeardown().catch(() => undefined);
  }

  private beginTeardown(): Promise<void> {
    this.teardownPromise ??= terminateRuntimeOAuthHelperProcess(this.child);
    return this.teardownPromise;
  }
}

function spawnHelper(invocation: RuntimeOAuthHelperInvocation): ChildProcess {
  try {
    return spawnChildProcess(invocation.executable, [...invocation.argv], {
      shell: invocation.spawn.shell,
      windowsHide: invocation.spawn.windowsHide,
      cwd: invocation.spawn.cwd,
      env: { ...invocation.spawn.env },
      stdio: [...invocation.spawn.stdio],
    });
  } catch (error) {
    throw new RuntimeOAuthHelperError(undefined, { cause: error });
  }
}

function writeChildMessage(child: ChildProcess, value: unknown): Promise<void> {
  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) return Promise.reject(new RuntimeOAuthHelperError());
  let serialized: string;
  try {
    serialized = `${JSON.stringify(value)}\n`;
  } catch {
    return Promise.reject(new RuntimeOAuthHelperError());
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_HELPER_LINE_BYTES) {
    return Promise.reject(new RuntimeOAuthHelperError());
  }
  return new Promise<void>((resolve, reject) => {
    stdin.write(serialized, "utf8", (error) => error ? reject(new RuntimeOAuthHelperError()) : resolve());
  });
}

function closeChild(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill();
    } catch {
      // The process already exited between the state check and kill.
    }
  }
}

export interface RuntimeOAuthHelperTerminationOptions {
  readonly forceAfterMs?: number;
  readonly boundMs?: number;
}

export function terminateRuntimeOAuthHelperProcess(
  child: ChildProcess,
  options: RuntimeOAuthHelperTerminationOptions = {},
): Promise<void> {
  const forceAfterMs = boundedTerminationDelay(options.forceAfterMs ?? 1_000, "force delay");
  const boundMs = boundedTerminationDelay(options.boundMs ?? 5_000, "termination bound");
  if (forceAfterMs >= boundMs) throw new TypeError("OAuth helper force delay must be shorter than its termination bound");
  if (child.exitCode !== null || child.signalCode !== null) {
    closeChild(child);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(boundTimer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (error) {
        // The process may still emit an error after the bound. Keep that from
        // becoming an unhandled hostd exception while the retained teardown
        // failure prevents runtime authority from being released.
        child.on("error", swallowLateChildError);
        reject(error);
      } else {
        resolve();
      }
    };
    const onExit = (): void => finish();
    // A ChildProcess error does not prove that a previously spawned process
    // exited. Keep waiting for the positive exit observation until the bound.
    const onError = (): void => undefined;
    const forceTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // A thrown kill also does not prove exit; the exit event remains the
        // only positive observation for a child that was previously live.
      }
    }, forceAfterMs);
    forceTimer.unref?.();
    const boundTimer = setTimeout(
      () => finish(new RuntimeOAuthHelperTerminationError()),
      boundMs,
    );
    boundTimer.unref?.();
    child.once("exit", onExit);
    child.on("error", onError);
    closeChild(child);
  });
}

function swallowLateChildError(): void {
  // Liveness is already latched as unconfirmed; this listener is containment,
  // not evidence of a clean process exit.
}

function boundedTerminationDelay(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError(`OAuth helper ${label} must be an integer from 1 to 60000 milliseconds`);
  }
  return value;
}

function normalizeAuthorization(
  value: unknown,
  providerId: string,
): { readonly url: string; readonly instructions?: string } {
  if (!isRecord(value)) throw new RuntimeOAuthHelperError();
  const url = boundedText(value.url, 8_192, "OAuth authorization URL");
  if (providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID || !isPinnedCodexAuthorizationUrl(url)) {
    throw new RuntimeOAuthHelperError();
  }
  return {
    url,
    ...(value.instructions === undefined
      ? {}
      : { instructions: boundedText(value.instructions, 2_048, "OAuth instructions") }),
  };
}

function normalizePrompt(value: unknown): { readonly message: string; readonly placeholder?: string; readonly allowEmpty?: boolean } {
  if (!isRecord(value) || (value.allowEmpty !== undefined && typeof value.allowEmpty !== "boolean")) {
    throw new RuntimeOAuthHelperError();
  }
  return {
    message: boundedText(value.message, 2_048, "OAuth prompt"),
    ...(value.placeholder === undefined ? {} : { placeholder: boundedText(value.placeholder, 255, "OAuth placeholder", true) }),
    ...(value.allowEmpty === undefined ? {} : { allowEmpty: value.allowEmpty }),
  };
}

function normalizeSelection(value: unknown): {
  readonly message: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
} {
  if (!isRecord(value) || !Array.isArray(value.options) || value.options.length < 1 || value.options.length > 64) {
    throw new RuntimeOAuthHelperError();
  }
  const seen = new Set<string>();
  const options = value.options.map((option) => {
    if (!isRecord(option)) throw new RuntimeOAuthHelperError();
    const id = boundedIdentifier(option.id, "OAuth selection identifier");
    if (seen.has(id)) throw new RuntimeOAuthHelperError();
    seen.add(id);
    return { id, label: boundedText(option.label, 255, "OAuth selection label") };
  });
  return { message: boundedText(value.message, 2_048, "OAuth selection"), options };
}

function boundedAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    /[\0\r\n]/.test(value) ||
    !isAbsolute(value)
  ) {
    throw new RuntimeOAuthHelperError(`${label} is invalid`);
  }
  return value;
}

function boundedModuleUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || /[\0\r\n]/.test(value)) {
    throw new RuntimeOAuthHelperError();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeOAuthHelperError();
  }
  if (url.protocol !== "file:" || url.username || url.password || url.search || url.hash) throw new RuntimeOAuthHelperError();
  boundedAbsolutePath(fileURLToPath(url), "verified runtime module path");
  return url.href;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\0-\x20\x7f]/.test(value)) {
    throw new RuntimeOAuthHelperError(`${label} is invalid`);
  }
  return value;
}

function boundedText(value: unknown, maximum: number, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length < 1) || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new RuntimeOAuthHelperError(`${label} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Prime Agent remains in the verified child. This worker intentionally emits
// credentials only as its final private stdout frame; errors are fixed tokens.
const RUNTIME_OAUTH_LOGIN_HELPER_SOURCE = String.raw`
const moduleUrl = process.argv[1];
const providerId = process.argv[2];
const write = (value, done) => process.stdout.write(JSON.stringify(value) + "\n", done);
const fail = () => write({ type: "failed" }, () => process.exit(1));
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
if (!moduleUrl || providerId !== "openai-codex") throw new Error();
const runtime = await import(moduleUrl);
if (!runtime || typeof runtime !== "object" || typeof runtime.AuthStorage?.create !== "function") throw new Error();
const authStorage = runtime.AuthStorage.create();
const providers = authStorage.getOAuthProviders();
if (!Array.isArray(providers) || providers.length > 128) throw new Error();
const provider = providers.find((candidate) => candidate?.id === providerId);
if (!provider || typeof provider.login !== "function" || provider.usesCallbackServer !== true) throw new Error();
write({ type: "provider", id: provider.id, name: provider.name, usesCallbackServer: provider.usesCallbackServer });
let sequence = 0;
const pending = new Map();
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input.length > 32768) return fail();
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    let message;
    try { message = JSON.parse(line); } catch { return fail(); }
    if (message?.type !== "response" || typeof message.requestId !== "string") return fail();
    const resolve = pending.get(message.requestId);
    if (!resolve) return fail();
    pending.delete(message.requestId);
    resolve(typeof message.value === "string" ? message.value : undefined);
  }
});
process.stdin.on("end", () => process.exit(1));
const request = (kind, prompt) => new Promise((resolve) => {
  const requestId = "oauth-" + (++sequence);
  if (sequence > 32) return fail();
  pending.set(requestId, resolve);
  write({ type: "request", requestId, kind, ...(prompt === undefined ? {} : { prompt }) });
});
try {
  const credentials = await provider.login({
    onAuth: (info) => write({ type: "auth", info }),
    onPrompt: (prompt) => request("prompt", prompt).then((value) => value ?? ""),
    onProgress: (message) => write({ type: "progress", message }),
    onManualCodeInput: () => request("manual"),
    onSelect: (prompt) => request("select", prompt),
  });
  write({ type: "result", credentials }, () => process.exit(0));
} catch {
  fail();
}
`;

// One child owns one exact AuthStorage confirmation sequence. Credential input
// arrives over private stdin and is never reflected in responses or errors.
const RUNTIME_OAUTH_STORAGE_HELPER_SOURCE = String.raw`
const moduleUrl = process.argv[1];
const expectedProviderId = process.argv[2];
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const fatal = () => process.exit(1);
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
if (!moduleUrl || expectedProviderId !== "openai-codex") throw new Error();
const runtime = await import(moduleUrl);
if (!runtime || typeof runtime !== "object" || typeof runtime.AuthStorage?.create !== "function") throw new Error();
const storage = runtime.AuthStorage.create();
write({ type: "ready", providerId: expectedProviderId });
let input = "";
let requests = 0;
const sequence = ["set", "drain", "reload", "status"];
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  input += chunk;
  if (input.length > ${MAX_HELPER_LINE_BYTES}) return fatal();
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    let request;
    try { request = JSON.parse(line); } catch { return fatal(); }
    if (
      request?.type !== "request" ||
      typeof request.requestId !== "string" ||
      request.method !== sequence[requests] ||
      ++requests > sequence.length
    ) return fatal();
    if (
      (request.method === "set" || request.method === "status") &&
      request.providerId !== expectedProviderId
    ) return fatal();
    if (request.method === "set" && request.auth?.type !== "oauth") return fatal();
    try {
      let result = {};
      if (request.method === "set") {
        await storage.set(expectedProviderId, request.auth);
      } else if (request.method === "drain") {
        const errors = await storage.drainErrors();
        if (!Array.isArray(errors) || errors.length > ${MAX_STORAGE_ERRORS}) throw new Error();
        result = { errorCount: errors.length };
      } else if (request.method === "reload") {
        await storage.reload();
      } else if (request.method === "status") {
        result = { configured: (await storage.getAuthStatus(expectedProviderId))?.configured === true };
      } else {
        return fatal();
      }
      write({ type: "response", requestId: request.requestId, ok: true, result });
    } catch {
      write({ type: "response", requestId: request.requestId, ok: false });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;
