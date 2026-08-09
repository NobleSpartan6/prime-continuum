const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
export const CODEX_APP_SERVER_RELEASE_VERSION = "0.147.0" as const;
const CLIENT_INFO = Object.freeze({
  name: "prime_continuim",
  title: "Prime Continuim",
});
const ALLOWED_CLIENT_METHODS = new Set<string>([
  "initialize",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "config/read",
  "mcpServerStatus/list",
  "hooks/list",
  "plugin/list",
  "app/list",
  "windowsSandbox/readiness",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/delete",
  "turn/start",
  "turn/interrupt",
]);
const ALLOWED_SERVER_NOTIFICATIONS = new Set([
  "account/login/completed",
  "account/rateLimits/updated",
  "account/updated",
  "configWarning",
  "deprecationNotice",
  "error",
  "guardianWarning",
  "hook/completed",
  "hook/started",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/completed",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/started",
  "mcpServer/startupStatus/updated",
  "model/rerouted",
  "model/safetyBuffering/updated",
  "model/verification",
  "remoteControl/status/changed",
  "serverRequest/resolved",
  "thread/closed",
  "thread/deleted",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/completed",
  "turn/diff/updated",
  "turn/moderationMetadata",
  "turn/plan/updated",
  "turn/started",
  "warning",
  "windows/worldWritableWarning",
]);

type JsonRecord = Record<string, unknown>;

export type CodexAppServerClientErrorCode =
  | "APP_SERVER_CLOSED"
  | "APP_SERVER_PROTOCOL_INVALID"
  | "APP_SERVER_RESOURCE_LIMIT"
  | "APP_SERVER_REQUEST_TIMEOUT"
  | "APP_SERVER_REQUEST_REJECTED"
  | "APP_SERVER_TRANSPORT_FAILED";

/** Fixed-message error boundary; app-server payloads and stderr never escape it. */
export class CodexAppServerClientError extends Error {
  constructor(
    readonly code: CodexAppServerClientErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CodexAppServerClientError";
  }
}

/**
 * Process transport seam. Production owns a verified executable launcher;
 * tests can use an in-memory fixture without gaining a production PATH seam.
 */
export interface CodexAppServerTransport {
  send(frame: Uint8Array): Promise<void>;
  onStdout(listener: (chunk: Uint8Array) => void): () => void;
  onStderr(listener: (chunk: Uint8Array) => void): () => void;
  onClosed(listener: () => void): () => void;
  terminate(): Promise<void>;
}

export interface CodexAppServerClientOptions {
  readonly transport: CodexAppServerTransport;
  readonly expectedCodexHome: string;
  readonly expectedReleaseVersion: typeof CODEX_APP_SERVER_RELEASE_VERSION;
  readonly clientVersion: string;
  readonly initializeIdentity: Readonly<Record<string, unknown>>;
  readonly initializeCapabilities: Readonly<Record<string, unknown>>;
  readonly threadConfig: Readonly<Record<string, boolean | string>>;
  readonly maxFrameBytes?: number;
  readonly maxPendingRequests?: number;
  readonly requestTimeoutMs?: number;
  readonly maxStderrBytes?: number;
}

export interface CodexThreadSecurityContext {
  readonly cwd: string;
}

export interface CodexStartTurnInput extends CodexThreadSecurityContext {
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly prompt: string;
}

export interface CodexAppServerNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface CodexAppServerDeniedRequest {
  readonly id: string | number;
  readonly method: string;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: CodexAppServerClientError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Bounded JSONL client for the official Codex app-server stdio protocol.
 * Any framing ambiguity invalidates the whole connection so an outcome is
 * never guessed or replayed.
 */
export class CodexAppServerClient {
  private readonly transport: CodexAppServerTransport;
  private readonly expectedCodexHome: string;
  private readonly expectedReleaseVersion: typeof CODEX_APP_SERVER_RELEASE_VERSION;
  private readonly clientVersion: string;
  private readonly initializeIdentity: Readonly<{
    clientInfoName: "prime_continuim";
    clientInfoTitle: "Prime Continuim";
    capabilities: Readonly<{ experimentalApi: true }>;
    platformFamily: "windows";
    platformOs: "windows";
  }>;
  private readonly initializeCapabilities: Readonly<{ experimentalApi: true }>;
  private readonly threadConfig: Readonly<Record<string, boolean | string>>;
  private readonly maxFrameBytes: number;
  private readonly maxPendingRequests: number;
  private readonly requestTimeoutMs: number;
  private readonly maxStderrBytes: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: CodexAppServerNotification) => void>();
  private readonly deniedRequestListeners = new Set<(request: CodexAppServerDeniedRequest) => void>();
  private readonly failureListeners = new Set<(error: CodexAppServerClientError) => void>();
  private readonly unsubscribers: Array<() => void>;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrBytes = 0;
  private nextRequestId = 0;
  private initialized = false;
  private initializePromise: Promise<void> | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private terminationPromise: Promise<void> | undefined;
  private terminationFailure: CodexAppServerClientError | undefined;

  constructor(options: CodexAppServerClientOptions) {
    this.transport = options.transport;
    this.expectedCodexHome = options.expectedCodexHome;
    if (options.expectedReleaseVersion !== CODEX_APP_SERVER_RELEASE_VERSION) {
      throw new TypeError("Expected app-server release is not supported");
    }
    this.expectedReleaseVersion = options.expectedReleaseVersion;
    this.clientVersion = boundedText(options.clientVersion, 128, "Client version");
    this.initializeIdentity = validateInitializeIdentity(options.initializeIdentity);
    this.initializeCapabilities = validateInitializeCapabilities(options.initializeCapabilities);
    this.threadConfig = validateThreadConfig(options.threadConfig);
    this.maxFrameBytes = boundedInteger(
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      1_024,
      8 * 1024 * 1024,
      "App-server frame limit",
    );
    this.maxPendingRequests = boundedInteger(
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      1,
      256,
      "App-server pending request limit",
    );
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      10,
      5 * 60 * 1_000,
      "App-server request timeout",
    );
    this.maxStderrBytes = boundedInteger(
      options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
      0,
      1024 * 1024,
      "App-server stderr limit",
    );
    if (!isAbsolutePath(this.expectedCodexHome)) {
      throw new TypeError("Expected CODEX_HOME must be an absolute path");
    }

    this.unsubscribers = [
      this.transport.onStdout((chunk) => this.consumeStdout(chunk)),
      this.transport.onStderr((chunk) => this.consumeStderr(chunk)),
      this.transport.onClosed(() => this.failConnection(new CodexAppServerClientError(
        "APP_SERVER_TRANSPORT_FAILED",
        "Codex app-server transport closed before host shutdown",
        true,
      ))),
    ];
  }

  initialize(): Promise<void> {
    this.initializePromise ??= this.performInitialize();
    return this.initializePromise;
  }

  private async performInitialize(): Promise<void> {
    const result = requireRecord(await this.rawRequest("initialize", {
      clientInfo: {
        name: this.initializeIdentity.clientInfoName,
        title: this.initializeIdentity.clientInfoTitle,
        version: this.clientVersion,
      },
      capabilities: { ...this.initializeCapabilities },
    }));
    if (
      !isExpectedUserAgent(
        result.userAgent,
        this.expectedReleaseVersion,
        CLIENT_INFO.name,
        this.clientVersion,
      ) ||
      result.codexHome !== this.expectedCodexHome ||
      result.platformFamily !== this.initializeIdentity.platformFamily ||
      result.platformOs !== this.initializeIdentity.platformOs
    ) {
      await this.failConnection(new CodexAppServerClientError(
        "APP_SERVER_PROTOCOL_INVALID",
        "Codex app-server initialization did not match the verified host contract",
        false,
      ));
      throw new CodexAppServerClientError(
        "APP_SERVER_PROTOCOL_INVALID",
        "Codex app-server initialization did not match the verified host contract",
        false,
      );
    }
    try {
      await this.sendFrame({ method: "initialized" });
    } catch {
      const failure = new CodexAppServerClientError(
        "APP_SERVER_TRANSPORT_FAILED",
        "Codex app-server initialization acknowledgement could not be written",
        true,
      );
      await this.failConnection(failure);
      throw failure;
    }
    this.initialized = true;
  }

  readAccount(): Promise<unknown> {
    return this.request("account/read", { refreshToken: false });
  }

  startChatGptLogin(): Promise<unknown> {
    return this.request("account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "chatgpt",
    });
  }

  cancelLogin(loginId: string): Promise<unknown> {
    return this.request("account/login/cancel", { loginId: boundedIdentifier(loginId, "Login identifier") });
  }

  logout(): Promise<unknown> {
    return this.request("account/logout", undefined);
  }

  readEffectiveConfig(cwd: string): Promise<unknown> {
    return this.request("config/read", { includeLayers: true, cwd: absolutePath(cwd, "Workspace directory") });
  }

  listMcpServers(threadId?: string): Promise<unknown> {
    return this.request("mcpServerStatus/list", {
      limit: 100,
      detail: "full",
      ...(threadId === undefined ? {} : { threadId: boundedIdentifier(threadId, "Codex thread identifier") }),
    });
  }

  listHooks(cwd: string): Promise<unknown> {
    return this.request("hooks/list", { cwds: [absolutePath(cwd, "Workspace directory")] });
  }

  listPlugins(cwd: string): Promise<unknown> {
    return this.request("plugin/list", {
      cwds: [absolutePath(cwd, "Workspace directory")],
      marketplaceKinds: ["local"],
      forceRefetch: false,
    });
  }

  listApps(threadId?: string): Promise<unknown> {
    return this.request("app/list", {
      limit: 100,
      forceRefetch: false,
      ...(threadId === undefined ? {} : { threadId: boundedIdentifier(threadId, "Codex thread identifier") }),
    });
  }

  readWindowsSandboxReadiness(): Promise<unknown> {
    return this.request("windowsSandbox/readiness", undefined);
  }

  startThread(context: CodexThreadSecurityContext): Promise<unknown> {
    return this.request("thread/start", secureThreadParams(context, this.threadConfig));
  }

  resumeThread(threadId: string, context: CodexThreadSecurityContext): Promise<unknown> {
    return this.request("thread/resume", {
      threadId: boundedIdentifier(threadId, "Codex thread identifier"),
      ...secureThreadParams(context, this.threadConfig),
      excludeTurns: false,
    });
  }

  readThread(threadId: string): Promise<unknown> {
    return this.request("thread/read", {
      threadId: boundedIdentifier(threadId, "Codex thread identifier"),
      includeTurns: true,
    });
  }

  deleteThread(threadId: string): Promise<unknown> {
    return this.request("thread/delete", {
      threadId: boundedIdentifier(threadId, "Codex thread identifier"),
    });
  }

  startTurn(input: CodexStartTurnInput): Promise<unknown> {
    const cwd = absolutePath(input.cwd, "Workspace directory");
    return this.request("turn/start", {
      threadId: boundedIdentifier(input.threadId, "Codex thread identifier"),
      clientUserMessageId: boundedIdentifier(input.clientUserMessageId, "Client user message identifier"),
      input: [{
        type: "text",
        text: boundedPrompt(input.prompt),
        text_elements: [],
      }],
      additionalContext: {},
      environments: [],
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  }

  interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    return this.request("turn/interrupt", {
      threadId: boundedIdentifier(threadId, "Codex thread identifier"),
      turnId: boundedIdentifier(turnId, "Codex turn identifier"),
    });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.initialized) {
      throw new CodexAppServerClientError(
        "APP_SERVER_CLOSED",
        "Codex app-server has not completed initialization",
        true,
      );
    }
    return this.rawRequest(method, params);
  }

  subscribe(listener: (notification: CodexAppServerNotification) => void): () => void {
    if (this.closed) return () => undefined;
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  subscribeDeniedServerRequests(listener: (request: CodexAppServerDeniedRequest) => void): () => void {
    if (this.closed) return () => undefined;
    this.deniedRequestListeners.add(listener);
    return () => this.deniedRequestListeners.delete(listener);
  }

  subscribeFailures(listener: (error: CodexAppServerClientError) => void): () => void {
    if (this.closed) return () => undefined;
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  assertHealthy(): void {
    if (this.terminationFailure) throw this.terminationFailure;
    if (this.closed) {
      throw new CodexAppServerClientError("APP_SERVER_CLOSED", "Codex app-server is unavailable", true);
    }
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      if (!this.closed) {
        this.closed = true;
        this.rejectPending(new CodexAppServerClientError(
          "APP_SERVER_CLOSED",
          "Codex app-server client was closed",
          true,
        ));
      }
      this.unsubscribe();
      await this.beginTermination();
      if (this.terminationFailure) throw this.terminationFailure;
    })();
    return this.closePromise;
  }

  private async rawRequest(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      throw new CodexAppServerClientError("APP_SERVER_CLOSED", "Codex app-server is unavailable", true);
    }
    boundedMethod(method);
    if (!ALLOWED_CLIENT_METHODS.has(method)) {
      throw new CodexAppServerClientError(
        "APP_SERVER_PROTOCOL_INVALID",
        "Codex app-server method is outside the frozen host contract",
        false,
      );
    }
    if (this.pending.size >= this.maxPendingRequests) {
      throw new CodexAppServerClientError(
        "APP_SERVER_RESOURCE_LIMIT",
        "Codex app-server has too many pending requests",
        true,
      );
    }
    const id = this.nextId();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        const timeout = new CodexAppServerClientError(
          "APP_SERVER_REQUEST_TIMEOUT",
          "Codex app-server request outcome is unknown after timeout",
          true,
        );
        void this.failConnection(timeout);
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
    });
    try {
      await this.sendFrame({ method, id, params });
    } catch {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      const failure = new CodexAppServerClientError(
        "APP_SERVER_TRANSPORT_FAILED",
        "Codex app-server request could not be written",
        true,
      );
      await this.failConnection(failure);
      throw failure;
    }
    return response;
  }

  private async sendFrame(value: JsonRecord): Promise<void> {
    const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (body.byteLength > this.maxFrameBytes) {
      throw new CodexAppServerClientError(
        "APP_SERVER_RESOURCE_LIMIT",
        "Codex app-server request exceeds the frame limit",
        false,
      );
    }
    await this.transport.send(body);
  }

  private consumeStdout(chunk: Uint8Array): void {
    if (this.closed || chunk.byteLength === 0) return;
    const bytes = Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const newline = bytes.indexOf(0x0a, offset);
      const segmentEnd = newline < 0 ? bytes.byteLength : newline;
      const segment = bytes.subarray(offset, segmentEnd);
      if (this.stdoutBuffer.byteLength + segment.byteLength > this.maxFrameBytes) {
        void this.failConnection(new CodexAppServerClientError(
          "APP_SERVER_RESOURCE_LIMIT",
          "Codex app-server emitted an oversized frame",
          false,
        ));
        return;
      }
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, segment]);
      if (newline < 0) return;
      const line = this.stdoutBuffer;
      this.stdoutBuffer = Buffer.alloc(0);
      offset = newline + 1;
      if (line.byteLength === 0 || line.byteLength > this.maxFrameBytes) {
        void this.failConnection(new CodexAppServerClientError(
          "APP_SERVER_PROTOCOL_INVALID",
          "Codex app-server emitted an invalid frame boundary",
          false,
        ));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as unknown;
      } catch {
        void this.failConnection(new CodexAppServerClientError(
          "APP_SERVER_PROTOCOL_INVALID",
          "Codex app-server emitted invalid JSON",
          false,
        ));
        return;
      }
      if (!this.consumeMessage(value)) return;
    }
  }

  private consumeMessage(value: unknown): boolean {
    if (!isRecord(value)) return this.protocolFailure();
    if ("id" in value && "method" in value) {
      const id = value.id;
      if ((typeof id !== "number" || !Number.isSafeInteger(id)) && typeof id !== "string") {
        return this.protocolFailure();
      }
      if (typeof value.method !== "string" || value.method.length === 0 || value.method.length > 256) {
        return this.protocolFailure();
      }
      const denied = Object.freeze({ id, method: value.method });
      void this.sendFrame({
        id,
        error: {
          code: -32_601,
          message: "Prime Continuim denies app-server initiated requests",
        },
      }).then(() => {
        for (const listener of this.deniedRequestListeners) {
          try {
            listener(denied);
          } catch {
            // Denial is already queued. Continue notifying other host-owned
            // observers so each can retire active authority.
          }
        }
      }, () => this.failConnection(new CodexAppServerClientError(
          "APP_SERVER_TRANSPORT_FAILED",
          "Codex app-server denial response could not be written",
          true,
        )));
      return true;
    }
    if ("id" in value) {
      if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) return this.protocolFailure();
      const pending = this.pending.get(value.id);
      if (!pending || (("result" in value) === ("error" in value))) return this.protocolFailure();
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if ("error" in value) {
        pending.reject(new CodexAppServerClientError(
          "APP_SERVER_REQUEST_REJECTED",
          `Codex app-server rejected ${pending.method}`,
          true,
        ));
      } else {
        pending.resolve(value.result);
      }
      return true;
    }
    if (typeof value.method !== "string" || value.method.length === 0 || value.method.length > 256) {
      return this.protocolFailure();
    }
    if (!ALLOWED_SERVER_NOTIFICATIONS.has(value.method)) return this.protocolFailure();
    const notification = Object.freeze({ method: value.method, params: value.params });
    for (const listener of this.notificationListeners) {
      try {
        listener(notification);
      } catch {
        // Notifications are advisory. Backend state remains the authority and
        // one observer must not prevent the other observers from advancing.
      }
    }
    return true;
  }

  private consumeStderr(chunk: Uint8Array): void {
    if (this.closed || chunk.byteLength === 0) return;
    this.stderrBytes += chunk.byteLength;
    if (this.stderrBytes > this.maxStderrBytes) {
      void this.failConnection(new CodexAppServerClientError(
        "APP_SERVER_RESOURCE_LIMIT",
        "Codex app-server exceeded its private diagnostic byte limit",
        false,
      ));
    }
    // Diagnostics can contain paths or provider details. Deliberately discard.
  }

  private protocolFailure(): false {
    void this.failConnection(new CodexAppServerClientError(
      "APP_SERVER_PROTOCOL_INVALID",
      "Codex app-server violated the bounded protocol contract",
      false,
    ));
    return false;
  }

  private async failConnection(error: CodexAppServerClientError): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.notificationListeners.clear();
    this.deniedRequestListeners.clear();
    this.unsubscribe();
    await this.beginTermination();
    const failure = this.terminationFailure ?? error;
    this.rejectPending(failure);
    for (const listener of this.failureListeners) {
      try {
        listener(failure);
      } catch {
        // Failure retirement is already latched; observers cannot reverse it.
      }
    }
    this.failureListeners.clear();
  }

  private rejectPending(error: CodexAppServerClientError): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private unsubscribe(): void {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
  }

  private beginTermination(): Promise<void> {
    this.terminationPromise ??= this.transport.terminate().catch(() => {
      this.terminationFailure = new CodexAppServerClientError(
        "APP_SERVER_TRANSPORT_FAILED",
        "Codex app-server process termination could not be confirmed",
        false,
      );
    });
    return this.terminationPromise;
  }

  private nextId(): number {
    if (this.nextRequestId >= Number.MAX_SAFE_INTEGER) {
      throw new CodexAppServerClientError(
        "APP_SERVER_RESOURCE_LIMIT",
        "Codex app-server request sequence is exhausted",
        false,
      );
    }
    this.nextRequestId += 1;
    return this.nextRequestId;
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function boundedText(value: string, maximum: number, label: string): string {
  if (value.length === 0 || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function boundedMethod(value: string): string {
  return boundedText(value, 256, "App-server method");
}

function boundedPrompt(value: string): string {
  if (
    value.trim().length === 0 ||
    value.includes("\0") ||
    hasUnpairedSurrogate(value) ||
    new TextEncoder().encode(value).byteLength > 64 * 1024
  ) {
    throw new TypeError("Turn prompt is invalid");
  }
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function boundedIdentifier(value: string, label: string): string {
  const bounded = boundedText(value, 256, label);
  if (!/^[A-Za-z0-9._:-]+$/.test(bounded)) throw new TypeError(`${label} is invalid`);
  return bounded;
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolutePath(value) || value.length > 2_048 || /[\0\r\n]/.test(value)) {
    throw new TypeError(`${label} must be an absolute Windows path`);
  }
  return value;
}

function secureThreadParams(
  context: CodexThreadSecurityContext,
  threadConfig: Readonly<Record<string, boolean | string>>,
): JsonRecord {
  const cwd = absolutePath(context.cwd, "Workspace directory");
  return {
    modelProvider: "openai",
    cwd,
    runtimeWorkspaceRoots: [cwd],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "read-only",
    config: { ...threadConfig },
    ephemeral: false,
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: [],
    experimentalRawEvents: false,
  };
}

function validateInitializeIdentity(
  value: Readonly<Record<string, unknown>>,
): Readonly<{
  clientInfoName: "prime_continuim";
  clientInfoTitle: "Prime Continuim";
  capabilities: Readonly<{ experimentalApi: true }>;
  platformFamily: "windows";
  platformOs: "windows";
}> {
  const keys = Object.keys(value).sort();
  if (
    JSON.stringify(keys) !== JSON.stringify([
      "capabilities",
      "clientInfoName",
      "clientInfoTitle",
      "platformFamily",
      "platformOs",
      "userAgentTemplate",
    ]) ||
    value.clientInfoName !== CLIENT_INFO.name ||
    value.clientInfoTitle !== CLIENT_INFO.title ||
    value.platformFamily !== "windows" ||
    value.platformOs !== "windows" ||
    value.userAgentTemplate !==
      "prime_continuim/0.147.0 (Windows <major>.<minor>.<build>; x86_64) unknown (prime_continuim; <clientVersion>)" ||
    !isRecord(value.capabilities) ||
    Object.keys(value.capabilities).length !== 1 ||
    value.capabilities.experimentalApi !== true
  ) {
    throw new TypeError("App-server initialize identity is invalid");
  }
  return Object.freeze({
    clientInfoName: "prime_continuim",
    clientInfoTitle: "Prime Continuim",
    capabilities: Object.freeze({ experimentalApi: true as const }),
    platformFamily: "windows",
    platformOs: "windows",
  });
}

function validateInitializeCapabilities(
  value: Readonly<Record<string, unknown>>,
): Readonly<{ experimentalApi: true }> {
  if (Object.keys(value).length !== 1 || value.experimentalApi !== true) {
    throw new TypeError("App-server initialize capabilities are invalid");
  }
  return Object.freeze({ experimentalApi: true });
}

function validateThreadConfig(
  value: Readonly<Record<string, boolean | string>>,
): Readonly<Record<string, boolean | string>> {
  const config: Record<string, boolean | string> = Object.create(null) as Record<string, boolean | string>;
  const entries = Object.entries(value);
  if (entries.length < 32 || entries.length > 64) throw new TypeError("App-server security config is invalid");
  for (const [key, entry] of entries) {
    if (
      key.length === 0 ||
      key.length > 128 ||
      !/^[a-z][a-z0-9_.]*$/.test(key) ||
      key === "__proto__" ||
      key === "constructor" ||
      (typeof entry === "string" && (entry.length === 0 || entry.length > 128 || /[\0\r\n]/.test(entry)))
    ) throw new TypeError("App-server security config is invalid");
    config[key] = entry;
  }
  const exact: Readonly<Record<string, boolean | string>> = {
    cli_auth_credentials_store: "keyring",
    mcp_oauth_credentials_store: "keyring",
    forced_login_method: "chatgpt",
    web_search: "disabled",
    "shell_environment_policy.inherit": "none",
    "shell_environment_policy.experimental_use_profile": false,
    allow_login_shell: false,
    "windows.sandbox": "unelevated",
    "windows.sandbox_private_desktop": true,
    include_apps_instructions: false,
    "skills.include_instructions": false,
    "orchestrator.skills.enabled": false,
    "orchestrator.mcp.enabled": false,
    "features.plugins": false,
    "features.apps": false,
    "features.remote_plugin": false,
    "features.plugin_hooks": false,
    "features.hooks": false,
    "features.browser_use": false,
    "features.computer_use": false,
    "features.image_generation": false,
    "features.tool_suggest": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
    "features.code_mode": false,
    "features.enable_mcp_apps": false,
    "features.tool_call_mcp_elicitation": false,
    "features.auth_elicitation": false,
    "features.standalone_web_search": false,
    "features.executor_capability_discovery": false,
    "features.elevated_windows_sandbox": false,
  };
  for (const [key, expected] of Object.entries(exact)) {
    if (config[key] !== expected) throw new TypeError("App-server security config is invalid");
  }
  for (const [key, entry] of Object.entries(config)) {
    if (key.startsWith("features.") && entry !== false) {
      throw new TypeError("App-server security config is invalid");
    }
  }
  return Object.freeze(config);
}

function isExpectedUserAgent(
  value: unknown,
  releaseVersion: string,
  clientName: string,
  clientVersion: string,
): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\0\r\n]/.test(value)) {
    return false;
  }
  const expected = new RegExp(
    `^${escapeRegExp(clientName)}/${escapeRegExp(releaseVersion)} ` +
      `\\(Windows \\d+(?:\\.\\d+){1,3}; x86_64\\) unknown ` +
      `\\(${escapeRegExp(clientName)}; ${escapeRegExp(clientVersion)}\\)$`,
  );
  return expected.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    throw new CodexAppServerClientError(
      "APP_SERVER_PROTOCOL_INVALID",
      "Codex app-server returned an invalid result",
      false,
    );
  }
  return value;
}
