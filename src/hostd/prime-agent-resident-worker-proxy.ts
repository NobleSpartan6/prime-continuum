import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { VerifiedInstalledRuntimeHandle } from "./runtime-integrity-manager";
import type {
  PrimeAgentPublicModule,
  PrimeAgentPublicModuleLoader,
  PrimeDaemonAgentConnectionPublic,
  PrimeDaemonClientPublic,
} from "./prime-agent-resident-adapter";
import {
  RESIDENT_WORKER_LIMITS,
  RESIDENT_WORKER_OPERATIONS,
  boundedIdentifier,
  boundedJsonClone,
  boundedString,
  boundedTimeout,
  isRecord,
  jsonByteLength,
  residentWorkerMessageBase,
  residentWorkerOutboundMessageBound,
  serializeResidentWorkerError,
  strictRecord,
  validateResidentWorkerMessageBase,
  validateSerializedResidentWorkerError,
  type ResidentWorkerBootstrap,
  type ResidentWorkerClientState,
  type ResidentWorkerOperation,
  type SerializedResidentWorkerError,
} from "./prime-agent-resident-worker-protocol";

const DEFAULT_OPERATION_TIMEOUT_MS = 35_000;
const ATTACH_OPERATION_TIMEOUT_MS = 65_000;
const WAIT_FOR_IDLE_TIMEOUT_MS = RESIDENT_WORKER_LIMITS.maxRequestTimeoutMs;
const MAX_RETIRED_REQUEST_IDS = 4_096;
const MAX_RETIRED_CONNECTION_IDS = 1_024;
const FIXED_WORKER_BOOTSTRAP = `"use strict";
const { workerData } = require("node:worker_threads");
const hostd = require(workerData.hostdBundlePath);
if (typeof hostd.runPrimeAgentResidentWorker !== "function") {
  throw new Error("Packaged hostd bundle does not export the resident worker entrypoint");
}
hostd.runPrimeAgentResidentWorker(workerData.bootstrap);`;

export interface ResidentWorkerLike {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

export type ResidentWorkerFactory = (bootstrap: ResidentWorkerBootstrap) => ResidentWorkerLike;

export interface PrimeAgentResidentWorkerModuleLoaderOptions {
  readonly hostdBundlePath?: string;
  readonly workerFactory?: ResidentWorkerFactory;
  readonly readyTimeoutMs?: number;
}

export interface PrimeAgentResidentWorkerModuleLoader extends PrimeAgentPublicModuleLoader {
  close(): Promise<void>;
}

export class ResidentWorkerTransportError extends Error {
  readonly code: string;
  readonly outcome: "definitive" | "unknown";
  readonly operation?: ResidentWorkerOperation;

  constructor(
    code: string,
    message: string,
    options: {
      readonly outcome: "definitive" | "unknown";
      readonly operation?: ResidentWorkerOperation;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ResidentWorkerTransportError";
    this.code = code;
    this.outcome = options.outcome;
    this.operation = options.operation;
  }
}

export class ResidentWorkerRemoteError extends Error {
  readonly code?: string;
  readonly status?: "cancelled" | "owned" | "unknown" | "unsupported";
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly outcome: "definitive" | "unknown";

  constructor(value: SerializedResidentWorkerError) {
    super(value.message);
    this.name = value.name;
    this.code = value.code;
    this.status = value.status;
    this.retryable = value.retryable;
    this.details = value.details;
    this.outcome = value.outcome;
  }
}

interface PendingRequest {
  readonly operation: ResidentWorkerOperation;
  readonly mutation: boolean;
  posted: boolean;
  readonly resourceKey: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly removeAbortListener?: () => void;
}

interface QueuedConnectionEvent {
  readonly event: unknown;
  readonly bytes: number;
}

interface RecoveryCallbackRecord {
  readonly callback: () => Promise<void>;
}

export function createPrimeAgentResidentWorkerModuleLoader(
  handle: VerifiedInstalledRuntimeHandle,
  options: PrimeAgentResidentWorkerModuleLoaderOptions = {},
): PrimeAgentResidentWorkerModuleLoader {
  const moduleUrl = validateVerifiedModuleUrl(handle.moduleUrl);
  const readyTimeoutMs = boundedLoaderTimeout(options.readyTimeoutMs ?? RESIDENT_WORKER_LIMITS.workerReadyTimeoutMs);
  const workerFactory = options.workerFactory ?? ((bootstrap) => {
    const hostdBundlePath = validateHostdBundlePath(options.hostdBundlePath ?? __filename);
    const worker = new Worker(FIXED_WORKER_BOOTSTRAP, {
      eval: true,
      workerData: Object.freeze({ hostdBundlePath, bootstrap }),
    });
    return worker;
  });
  const bridge = new ResidentWorkerBridge({ moduleUrl, workerFactory, readyTimeoutMs });
  let modulePromise: Promise<PrimeAgentPublicModule> | undefined;
  const loader = (() => {
    modulePromise ??= bridge.module();
    return modulePromise;
  }) as PrimeAgentResidentWorkerModuleLoader;
  loader.close = () => bridge.close();
  return loader;
}

class ResidentWorkerBridge {
  private readonly generation = boundedIdentifier(`worker:${randomUUID()}`, "worker generation");
  private readonly base = residentWorkerMessageBase(this.generation);
  private readonly worker: ResidentWorkerLike;
  private readonly readyTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly clients = new Map<string, WorkerDaemonClientProxy>();
  private readonly connections = new Map<string, WorkerDaemonConnectionProxy>();
  private readonly recoveries = new Map<string, RecoveryCallbackRecord>();
  private readonly activeRecoveryRequestIds = new Set<string>();
  private readonly retiredRequestIds = new Set<string>();
  private readonly retiredConnectionIds = new Set<string>();
  private requestOrdinal = 0;
  private clientOrdinal = 0;
  private connectionOrdinal = 0;
  private lastRecoveryOrdinal = 0;
  private ready = false;
  private closing = false;
  private terminalError: ResidentWorkerTransportError | undefined;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly closedAckPromise: Promise<void>;
  private resolveClosedAck!: () => void;
  private readonly exitedPromise: Promise<void>;
  private resolveExited!: () => void;
  private exited = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: {
    readonly moduleUrl: string;
    readonly workerFactory: ResidentWorkerFactory;
    readonly readyTimeoutMs: number;
  }) {
    const bootstrap = Object.freeze({
      ...this.base,
      moduleUrl: options.moduleUrl,
    }) satisfies ResidentWorkerBootstrap;
    this.worker = options.workerFactory(bootstrap);
    this.readyTimeoutMs = options.readyTimeoutMs;
    this.readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
      this.resolveReady = resolvePromise;
      this.rejectReady = rejectPromise;
    });
    this.closedAckPromise = new Promise<void>((resolvePromise) => {
      this.resolveClosedAck = resolvePromise;
    });
    this.exitedPromise = new Promise<void>((resolvePromise) => {
      this.resolveExited = resolvePromise;
    });
    const readyTimeout = setTimeout(() => {
      this.failTransport(new ResidentWorkerTransportError(
        "RESIDENT_WORKER_READY_TIMEOUT",
        "Prime Agent resident worker did not become ready within its deadline",
        { outcome: "definitive" },
      ));
    }, this.readyTimeoutMs);
    readyTimeout.unref?.();
    void this.readyPromise.finally(() => clearTimeout(readyTimeout)).catch(() => undefined);
    this.worker.on("message", (value) => this.receive(value));
    this.worker.once("error", (error) => {
      this.failTransport(new ResidentWorkerTransportError(
        "RESIDENT_WORKER_CRASHED",
        "Prime Agent resident worker crashed",
        { outcome: "unknown", cause: error },
      ));
    });
    this.worker.once("exit", (code) => {
      this.exited = true;
      this.resolveExited();
      if (this.closing && code === 0) return;
      this.failTransport(new ResidentWorkerTransportError(
        "RESIDENT_WORKER_EXITED",
        `Prime Agent resident worker exited unexpectedly (${code})`,
        { outcome: "unknown" },
      ));
    });
  }

  async module(): Promise<PrimeAgentPublicModule> {
    await this.readyPromise;
    const bridge = this;
    class DaemonClientProxy extends WorkerDaemonClientProxy {
      constructor(socketPath: string) {
        super(bridge, socketPath);
      }
    }
    return Object.freeze({
      DaemonClient: DaemonClientProxy,
      DaemonAgentConnection: Object.freeze({
        attach(
          client: PrimeDaemonClientPublic,
          activeSessionId: string,
          options: Readonly<{
            closeClientOnDispose: true;
            sendClientEnv: false;
            supportsExtensionUi: true;
            ownedSession: boolean;
            telemetryDisabled: true;
            recoverDaemon: () => Promise<void>;
          }>,
        ): Promise<PrimeDaemonAgentConnectionPublic> {
          if (!(client instanceof WorkerDaemonClientProxy) || client.bridge !== bridge) {
            return Promise.reject(new TypeError("Resident worker attach requires a client from the same worker module"));
          }
          return bridge.attach(client, activeSessionId, options);
        },
      }),
    });
  }

  createClient(proxy: WorkerDaemonClientProxy, socketPathValue: string): { readonly clientId: string; readonly ready: Promise<void> } {
    const socketPath = boundedString(
      socketPathValue,
      RESIDENT_WORKER_LIMITS.maxSocketPathCharacters,
      "daemon socket path",
    );
    const clientId = boundedIdentifier(`client:${++this.clientOrdinal}`, "worker client ID");
    this.clients.set(clientId, proxy);
    const ready = this.invoke(
      "client.create",
      { clientId, socketPath },
      { timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS, mutation: false, resourceKey: clientResource(clientId) },
    ).then(() => undefined, (error) => {
      this.clients.delete(clientId);
      throw error;
    });
    return { clientId, ready };
  }

  async attach(
    client: WorkerDaemonClientProxy,
    activeSessionIdValue: string,
    options: Readonly<{
      closeClientOnDispose: true;
      sendClientEnv: false;
      supportsExtensionUi: true;
      ownedSession: boolean;
      telemetryDisabled: true;
      recoverDaemon: () => Promise<void>;
    }>,
  ): Promise<WorkerDaemonConnectionProxy> {
    if (
      options.closeClientOnDispose !== true ||
      options.sendClientEnv !== false ||
      options.supportsExtensionUi !== true ||
      typeof options.ownedSession !== "boolean" ||
      options.telemetryDisabled !== true ||
      typeof options.recoverDaemon !== "function"
    ) {
      throw new TypeError("Resident worker attach options differ from the fixed public contract");
    }
    await client.readyForUse();
    const activeSessionId = boundedString(
      activeSessionIdValue,
      RESIDENT_WORKER_LIMITS.maxSocketPathCharacters,
      "active session ID",
    );
    const connectionId = boundedIdentifier(`connection:${++this.connectionOrdinal}`, "worker connection ID");
    const connection = new WorkerDaemonConnectionProxy(this, connectionId, client, options.ownedSession);
    this.connections.set(connectionId, connection);
    this.recoveries.set(connectionId, { callback: options.recoverDaemon });
    try {
      await this.invoke(
        "connection.attach",
        {
          connectionId,
          clientId: client.clientId,
          activeSessionId,
          closeClientOnDispose: true,
          sendClientEnv: false,
          supportsExtensionUi: true,
          ownedSession: options.ownedSession,
          telemetryDisabled: true,
        },
        {
          timeoutMs: ATTACH_OPERATION_TIMEOUT_MS,
          mutation: false,
          resourceKey: connectionResource(connectionId),
        },
      );
      connection.markAttached();
      return connection;
    } catch (error) {
      this.connections.delete(connectionId);
      this.recoveries.delete(connectionId);
      this.retireConnectionId(connectionId);
      throw error;
    }
  }

  invoke(
    operation: ResidentWorkerOperation,
    payload: Readonly<Record<string, unknown>>,
    options: {
      readonly timeoutMs: number;
      readonly mutation: boolean;
      readonly resourceKey: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<unknown> {
    if (this.terminalError) return Promise.reject(this.operationTransportError(this.terminalError, operation, false));
    if (this.closing) {
      return Promise.reject(new ResidentWorkerTransportError(
        "RESIDENT_WORKER_CLOSED",
        "Prime Agent resident worker is closed",
        { outcome: "definitive", operation },
      ));
    }
    if (this.pending.size >= RESIDENT_WORKER_LIMITS.maxPendingRequests) {
      return Promise.reject(new ResidentWorkerTransportError(
        "RESIDENT_WORKER_REQUEST_LIMIT",
        "Prime Agent resident worker request limit reached",
        { outcome: "definitive", operation },
      ));
    }
    const requestId = boundedIdentifier(`request:${++this.requestOrdinal}`, "worker request ID");
    const timeoutMs = boundedTimeout(options.timeoutMs, `${operation} proxy timeout`);
    const outboundPayload = operation === "connection.prompt" && options.signal?.aborted
      ? Object.freeze({ ...payload, signalAborted: true })
      : payload;
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      let abortListener: (() => void) | undefined;
      const timeout = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        this.retireRequestId(requestId);
        pending.removeAbortListener?.();
        pending.reject(new ResidentWorkerTransportError(
          "RESIDENT_WORKER_REQUEST_TIMEOUT",
          `Prime Agent resident worker ${operation} request timed out`,
          { outcome: pending.mutation && pending.posted ? "unknown" : "definitive", operation },
        ));
      }, timeoutMs);
      timeout.unref?.();
      if (options.signal) {
        abortListener = () => {
          try {
            this.post({ ...this.base, type: "cancel", requestId });
          } catch {
            // The original mutation remains authoritative and will settle or
            // time out as unknown. Cancellation is never translated to replay.
          }
        };
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
      this.pending.set(requestId, {
        operation,
        mutation: options.mutation,
        posted: false,
        resourceKey: options.resourceKey,
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout,
        ...(abortListener && options.signal
          ? { removeAbortListener: () => options.signal?.removeEventListener("abort", abortListener!) }
          : {}),
      });
      void this.readyPromise.then(() => {
        if (!this.pending.has(requestId)) return;
        try {
          this.post({
            ...this.base,
            type: "request",
            requestId,
            operation,
            payload: outboundPayload,
          });
          const posted = this.pending.get(requestId);
          if (posted) posted.posted = true;
          if (options.signal?.aborted && operation === "connection.prompt") abortListener?.();
        } catch (error) {
          const pending = this.pending.get(requestId);
          if (!pending) return;
          this.pending.delete(requestId);
          clearTimeout(pending.timeout);
          pending.removeAbortListener?.();
          this.retireRequestId(requestId);
          pending.reject(new ResidentWorkerTransportError(
            "RESIDENT_WORKER_POST_FAILED",
            `Prime Agent resident worker ${operation} request could not be posted`,
            { outcome: "definitive", operation, cause: error },
          ));
        }
      }, (error) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.removeAbortListener?.();
        this.retireRequestId(requestId);
        pending.reject(this.operationTransportError(error, operation, pending.mutation && pending.posted));
      });
    });
  }

  closeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    client?.applyState({ clientId, isConnected: false });
    for (const [connectionId, connection] of this.connections) {
      if (!connection.usesClient(clientId)) continue;
      connection.markTransportClosed();
      this.connections.delete(connectionId);
      this.recoveries.delete(connectionId);
      this.retireConnectionId(connectionId);
      this.rejectResource(connectionResource(connectionId), true);
    }
    void this.invoke(
      "client.close",
      { clientId },
      { timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS, mutation: false, resourceKey: clientResource(clientId) },
    ).catch(() => undefined).finally(() => {
      this.clients.delete(clientId);
      this.rejectResource(clientResource(clientId), true);
    });
  }

  retireConnection(connectionId: string, clientId: string, clientClosedByDispose: boolean): void {
    this.connections.delete(connectionId);
    this.recoveries.delete(connectionId);
    this.retireConnectionId(connectionId);
    this.rejectResource(connectionResource(connectionId), true);
    const client = this.clients.get(clientId);
    client?.applyState({ clientId, isConnected: false });
    if (clientClosedByDispose) {
      client?.markClosedByConnection();
      this.clients.delete(clientId);
      this.rejectResource(clientResource(clientId), true);
    }
  }

  private receive(value: unknown): void {
    if (this.terminalError) return;
    let record: Readonly<Record<string, unknown>>;
    try {
      const normalized = boundedJsonClone(
        value,
        residentWorkerOutboundMessageBound(value),
        "resident worker outbound message",
      );
      record = validateResidentWorkerMessageBase(normalized, this.generation);
      switch (record.type) {
        case "ready":
          strictRecord(record, ["protocol", "protocolVersion", "generation", "type"], "worker ready");
          if (this.ready) throw new Error("Resident worker sent duplicate readiness");
          this.ready = true;
          this.resolveReady();
          return;
        case "response":
          this.receiveResponse(record);
          return;
        case "connection_event":
          this.receiveConnectionEvent(record);
          return;
        case "recovery_request":
          this.receiveRecoveryRequest(record);
          return;
        case "fatal":
          this.receiveFatal(record);
          return;
        case "closed":
          strictRecord(record, ["protocol", "protocolVersion", "generation", "type"], "worker closed");
          if (!this.closing) throw new Error("Resident worker closed without a host shutdown");
          this.resolveClosedAck();
          return;
        default:
          throw new Error("Resident worker outbound message type is invalid");
      }
    } catch (error) {
      this.failTransport(new ResidentWorkerTransportError(
        "RESIDENT_WORKER_PROTOCOL_INVALID",
        "Prime Agent resident worker violated its bounded protocol",
        { outcome: "unknown", cause: error },
      ));
    }
  }

  private receiveResponse(recordValue: Readonly<Record<string, unknown>>): void {
    const record = strictRecord(
      recordValue,
      ["protocol", "protocolVersion", "generation", "type", "requestId", "operation", "ok", "result", "clientState", "error"],
      "worker response",
    );
    const requestId = boundedIdentifier(record.requestId, "worker response request ID");
    if (typeof record.operation !== "string" || !RESIDENT_WORKER_OPERATIONS.has(record.operation as ResidentWorkerOperation)) {
      throw new Error("Worker response operation is invalid");
    }
    if (typeof record.ok !== "boolean") throw new Error("Worker response status is invalid");
    const pending = this.pending.get(requestId);
    if (!pending) {
      if (this.retiredRequestIds.has(requestId)) return;
      throw new Error("Worker response does not identify a pending request");
    }
    if (record.operation !== pending.operation) throw new Error("Worker response changed request operation");
    if (record.ok && record.error !== undefined) throw new Error("Successful worker response carried an error");
    if (!record.ok && (record.result !== undefined || record.clientState !== undefined)) {
      throw new Error("Failed worker response carried success data");
    }
    if (record.ok) {
      if (!("result" in record)) throw new Error("Successful worker response omitted its result");
      if (record.clientState !== undefined) this.applyClientState(record.clientState);
      this.pending.delete(requestId);
      this.retireRequestId(requestId);
      clearTimeout(pending.timeout);
      pending.removeAbortListener?.();
      pending.resolve(record.result);
      return;
    }
    const error = remoteError(record.error);
    this.pending.delete(requestId);
    this.retireRequestId(requestId);
    clearTimeout(pending.timeout);
    pending.removeAbortListener?.();
    pending.reject(error);
  }

  private receiveConnectionEvent(recordValue: Readonly<Record<string, unknown>>): void {
    const record = strictRecord(
      recordValue,
      ["protocol", "protocolVersion", "generation", "type", "connectionId", "event", "clientState"],
      "worker connection event",
    );
    const connectionId = boundedIdentifier(record.connectionId, "worker event connection ID");
    const connection = this.connections.get(connectionId);
    if (!connection) {
      if (this.retiredConnectionIds.has(connectionId)) return;
      throw new Error("Worker event does not identify a live connection");
    }
    if (!("event" in record)) throw new Error("Worker connection event omitted its event payload");
    this.applyClientState(record.clientState);
    connection.receiveEvent(record.event);
  }

  private receiveRecoveryRequest(recordValue: Readonly<Record<string, unknown>>): void {
    const record = strictRecord(
      recordValue,
      ["protocol", "protocolVersion", "generation", "type", "recoveryRequestId", "connectionId"],
      "worker recovery request",
    );
    const recoveryRequestId = boundedIdentifier(record.recoveryRequestId, "worker recovery request ID");
    this.lastRecoveryOrdinal = requireNextBridgeOrdinal(
      recoveryRequestId,
      "recovery",
      this.lastRecoveryOrdinal,
    );
    const connectionId = boundedIdentifier(record.connectionId, "worker recovery connection ID");
    if (this.activeRecoveryRequestIds.has(recoveryRequestId)) {
      throw new Error("Worker recovery request ID was reused");
    }
    if (this.activeRecoveryRequestIds.size >= RESIDENT_WORKER_LIMITS.maxPendingRequests) {
      throw new Error("Worker recovery callback limit reached");
    }
    const recovery = this.recoveries.get(connectionId);
    if (!recovery) {
      if (this.retiredConnectionIds.has(connectionId)) {
        this.postRecoveryResponse(
          recoveryRequestId,
          false,
          Object.assign(new Error("Resident daemon recovery authority was retired"), {
            code: "RESIDENT_WORKER_RECOVERY_AUTHORITY_RETIRED",
          }),
        );
        return;
      }
      throw new Error("Worker recovery request has no exact host callback");
    }
    this.activeRecoveryRequestIds.add(recoveryRequestId);
    void invokeRecoveryWithinDeadline(recovery.callback).then(
      () => this.postRecoveryResponse(recoveryRequestId, true),
      (error) => this.postRecoveryResponse(recoveryRequestId, false, error),
    ).finally(() => this.activeRecoveryRequestIds.delete(recoveryRequestId));
  }

  private receiveFatal(recordValue: Readonly<Record<string, unknown>>): void {
    const record = strictRecord(
      recordValue,
      ["protocol", "protocolVersion", "generation", "type", "error"],
      "worker fatal message",
    );
    const error = remoteError(record.error);
    this.failTransport(new ResidentWorkerTransportError(
      "RESIDENT_WORKER_FATAL",
      `Prime Agent resident worker failed: ${error.message}`,
      { outcome: "unknown", cause: error },
    ));
  }

  private postRecoveryResponse(recoveryRequestId: string, ok: boolean, error?: unknown): void {
    if (this.terminalError || this.closing) return;
    try {
      this.post({
        ...this.base,
        type: "recovery_response",
        recoveryRequestId,
        ok,
        ...(ok ? {} : { error: serializeResidentWorkerError(error, "definitive") }),
      });
    } catch (postError) {
      this.failTransport(new ResidentWorkerTransportError(
        "RESIDENT_WORKER_RECOVERY_RESPONSE_FAILED",
        "Resident daemon recovery response could not be returned to the worker",
        { outcome: "unknown", cause: postError },
      ));
    }
  }

  private applyClientState(value: unknown): void {
    const record = strictRecord(value, ["clientId", "isConnected", "hello"], "worker client state");
    const clientId = boundedIdentifier(record.clientId, "worker state client ID");
    if (typeof record.isConnected !== "boolean") throw new Error("Worker client connection state is invalid");
    const state: ResidentWorkerClientState = {
      clientId,
      isConnected: record.isConnected,
      ...(record.hello === undefined
        ? {}
        : { hello: boundedJsonClone(record.hello, RESIDENT_WORKER_LIMITS.maxHelloBytes, "daemon hello") }),
    };
    const client = this.clients.get(clientId);
    if (!client) throw new Error("Worker client state does not identify a live client");
    client.applyState(state);
  }

  private post(value: unknown): void {
    const normalized = boundedJsonClone(
      value,
      RESIDENT_WORKER_LIMITS.maxControlMessageBytes,
      "resident worker host message",
    );
    this.worker.postMessage(normalized);
  }

  private failTransport(error: ResidentWorkerTransportError): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.rejectReady(error);
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.removeAbortListener?.();
      pending.reject(this.operationTransportError(
        error,
        pending.operation,
        pending.mutation && pending.posted,
      ));
      this.retireRequestId(requestId);
    }
    this.pending.clear();
    for (const client of this.clients.values()) client.markTransportClosed();
    for (const connection of this.connections.values()) connection.markTransportClosed();
    this.recoveries.clear();
    this.activeRecoveryRequestIds.clear();
    void this.worker.terminate().catch(() => undefined);
  }

  private operationTransportError(
    error: unknown,
    operation: ResidentWorkerOperation,
    mutation: boolean,
  ): ResidentWorkerTransportError {
    const errorCode = isRecord(error) && typeof error.code === "string"
      ? error.code
      : "RESIDENT_WORKER_UNAVAILABLE";
    return new ResidentWorkerTransportError(
      errorCode,
      error instanceof Error ? error.message : "Prime Agent resident worker is unavailable",
      { outcome: mutation ? "unknown" : "definitive", operation, cause: error },
    );
  }

  private rejectResource(resourceKey: string, mutationsUnknown: boolean): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.resourceKey !== resourceKey) continue;
      this.pending.delete(requestId);
      this.retireRequestId(requestId);
      clearTimeout(pending.timeout);
      pending.removeAbortListener?.();
      pending.reject(new ResidentWorkerTransportError(
        "RESIDENT_WORKER_RESOURCE_CLOSED",
        "Prime Agent resident worker resource closed before the request completed",
        {
          outcome: pending.mutation && pending.posted && mutationsUnknown ? "unknown" : "definitive",
          operation: pending.operation,
        },
      ));
    }
  }

  private retireRequestId(requestId: string): void {
    this.retiredRequestIds.add(requestId);
    if (this.retiredRequestIds.size > MAX_RETIRED_REQUEST_IDS) {
      const oldest = this.retiredRequestIds.values().next().value;
      if (oldest) this.retiredRequestIds.delete(oldest);
    }
  }

  private retireConnectionId(connectionId: string): void {
    this.retiredConnectionIds.add(connectionId);
    if (this.retiredConnectionIds.size > MAX_RETIRED_CONNECTION_IDS) {
      const oldest = this.retiredConnectionIds.values().next().value;
      if (oldest) this.retiredConnectionIds.delete(oldest);
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= (async () => {
      if (this.closing) return;
      this.closing = true;
      const closeError = new ResidentWorkerTransportError(
        "RESIDENT_WORKER_CLOSED",
        "Prime Agent resident worker is closed",
        { outcome: "definitive" },
      );
      if (!this.ready) this.rejectReady(closeError);
      this.rejectPendingForClose();
      if (!this.terminalError) {
        try {
          this.post({ ...this.base, type: "shutdown" });
        } catch {
          // Termination below is the final authority fence.
        }
      }
      if (this.terminalError) {
        await settleWithin(this.exitedPromise, RESIDENT_WORKER_LIMITS.closeTimeoutMs);
        return;
      }
      await settleWithin(
        Promise.race([this.closedAckPromise, this.exitedPromise]),
        RESIDENT_WORKER_LIMITS.closeTimeoutMs,
      );
      if (!this.exited) {
        // A closed acknowledgement is emitted only after upstream disposal.
        // Termination after that acknowledgement reaps the isolated thread;
        // on timeout it is the hard authority fence.
        await settleWithin(this.worker.terminate().then(() => undefined), RESIDENT_WORKER_LIMITS.closeTimeoutMs);
      }
    })();
    return this.closePromise;
  }

  private rejectPendingForClose(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.removeAbortListener?.();
      pending.reject(new ResidentWorkerTransportError(
        "RESIDENT_WORKER_CLOSED",
        "Prime Agent resident worker closed before the request completed",
        {
          outcome: pending.mutation && pending.posted ? "unknown" : "definitive",
          operation: pending.operation,
        },
      ));
      this.retireRequestId(requestId);
    }
    this.pending.clear();
  }
}

class WorkerDaemonClientProxy implements PrimeDaemonClientPublic {
  readonly bridge: ResidentWorkerBridge;
  readonly clientId: string;
  private readonly creation: Promise<void>;
  private helloValue: unknown;
  private connectedValue = false;
  private locallyClosed = false;

  constructor(bridge: ResidentWorkerBridge, socketPath: string) {
    this.bridge = bridge;
    const created = bridge.createClient(this, socketPath);
    this.clientId = created.clientId;
    this.creation = created.ready;
  }

  get hello(): unknown {
    return this.helloValue;
  }

  get isConnected(): boolean {
    return this.connectedValue && !this.locallyClosed;
  }

  async readyForUse(): Promise<void> {
    await this.creation;
    if (this.locallyClosed) throw new Error("Resident worker daemon client is closed");
  }

  async connect(timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS): Promise<void> {
    await this.readyForUse();
    await this.bridge.invoke(
      "client.connect",
      { clientId: this.clientId, timeoutMs: boundedTimeout(timeoutMs, "daemon connect timeout") },
      {
        timeoutMs: proxyRoundTripTimeout(timeoutMs),
        mutation: false,
        resourceKey: clientResource(this.clientId),
      },
    );
  }

  async waitForHello(timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS): Promise<unknown> {
    await this.readyForUse();
    const hello = await this.bridge.invoke(
      "client.wait_for_hello",
      { clientId: this.clientId, timeoutMs: boundedTimeout(timeoutMs, "daemon hello timeout") },
      {
        timeoutMs: proxyRoundTripTimeout(timeoutMs),
        mutation: false,
        resourceKey: clientResource(this.clientId),
      },
    );
    this.helloValue = hello;
    return hello;
  }

  async request(command: Readonly<object>, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS): Promise<unknown> {
    await this.readyForUse();
    const normalizedCommand = boundedJsonClone(
      command,
      RESIDENT_WORKER_LIMITS.maxDaemonResponseBytes,
      "daemon command",
    );
    return this.bridge.invoke(
      "client.request",
      { clientId: this.clientId, command: normalizedCommand, timeoutMs: boundedTimeout(timeoutMs, "daemon request timeout") },
      {
        timeoutMs: proxyRoundTripTimeout(timeoutMs),
        mutation: daemonCommandMayMutate(normalizedCommand),
        resourceKey: clientResource(this.clientId),
      },
    );
  }

  close(): void {
    if (this.locallyClosed) return;
    this.locallyClosed = true;
    this.connectedValue = false;
    void this.creation.then(() => this.bridge.closeClient(this.clientId), () => undefined);
  }

  applyState(state: ResidentWorkerClientState): void {
    if (state.clientId !== this.clientId) throw new Error("Resident worker client state identity changed");
    this.connectedValue = state.isConnected;
    if (state.hello !== undefined) this.helloValue = state.hello;
  }

  markTransportClosed(): void {
    this.connectedValue = false;
  }

  markClosedByConnection(): void {
    this.locallyClosed = true;
    this.connectedValue = false;
  }
}

class WorkerDaemonConnectionProxy implements PrimeDaemonAgentConnectionPublic {
  private readonly listeners = new Set<(event: unknown) => void | Promise<void>>();
  private readonly queuedEvents: QueuedConnectionEvent[] = [];
  private queuedEventBytes = 0;
  private attached = false;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly bridge: ResidentWorkerBridge,
    readonly connectionId: string,
    private readonly client: WorkerDaemonClientProxy,
    private ownedSession: boolean,
  ) {}

  markAttached(): void {
    this.attached = true;
  }

  subscribe(listener: (event: unknown) => void | Promise<void>): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    this.flushQueuedEvents();
    return () => this.listeners.delete(listener);
  }

  async getInitialSnapshot(): Promise<unknown> {
    this.assertLive();
    return this.bridge.invoke(
      "connection.get_initial_snapshot",
      { connectionId: this.connectionId },
      {
        timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
        mutation: false,
        resourceKey: connectionResource(this.connectionId),
      },
    );
  }

  async waitForIdle(): Promise<void> {
    this.assertLive();
    await this.bridge.invoke(
      "connection.wait_for_idle",
      { connectionId: this.connectionId },
      {
        timeoutMs: WAIT_FOR_IDLE_TIMEOUT_MS,
        mutation: false,
        resourceKey: connectionResource(this.connectionId),
      },
    );
  }

  async getResourceSnapshot(): Promise<unknown> {
    this.assertLive();
    return this.bridge.invoke(
      "connection.get_resource_snapshot",
      { connectionId: this.connectionId },
      {
        timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
        mutation: false,
        resourceKey: connectionResource(this.connectionId),
      },
    );
  }

  async getAvailableModels(): Promise<unknown> {
    this.assertLive();
    return this.bridge.invoke(
      "connection.get_available_models",
      { connectionId: this.connectionId },
      {
        timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
        mutation: false,
        resourceKey: connectionResource(this.connectionId),
      },
    );
  }

  async setModel(providerId: string, modelId: string): Promise<unknown> {
    this.assertLive();
    let normalizedProviderId: string;
    let normalizedModelId: string;
    try {
      normalizedProviderId = boundedString(
        providerId,
        RESIDENT_WORKER_LIMITS.maxProviderCharacters,
        "model provider ID",
      );
      normalizedModelId = boundedString(modelId, RESIDENT_WORKER_LIMITS.maxModelCharacters, "model ID");
    } catch (error) {
      throw new ResidentWorkerTransportError(
        "RESIDENT_WORKER_INPUT_INVALID",
        "Resident worker model selection input is invalid",
        { outcome: "definitive", operation: "connection.set_model", cause: error },
      );
    }
    return this.bridge.invoke(
      "connection.set_model",
      {
        connectionId: this.connectionId,
        providerId: normalizedProviderId,
        modelId: normalizedModelId,
      },
      {
        timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
        mutation: true,
        resourceKey: connectionResource(this.connectionId),
      },
    );
  }

  async promoteToResident(): Promise<void> {
    this.assertLive();
    await this.bridge.invoke(
      "connection.promote_to_resident",
      { connectionId: this.connectionId },
      {
        timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
        mutation: true,
        resourceKey: connectionResource(this.connectionId),
      },
    );
    this.ownedSession = false;
  }

  async prompt(
    message: string,
    options: Readonly<{ queueIfBusy?: boolean; signal?: AbortSignal }> = {},
  ): Promise<void> {
    this.assertLive();
    if (typeof message !== "string" || message.length < 1 || message.length > RESIDENT_WORKER_LIMITS.maxPromptCharacters) {
      throw new TypeError("Resident worker prompt message is invalid");
    }
    await this.bridge.invoke(
      "connection.prompt",
      {
        connectionId: this.connectionId,
        message,
        queueIfBusy: options.queueIfBusy ?? false,
        signalAborted: options.signal?.aborted ?? false,
      },
      {
        timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
        mutation: true,
        resourceKey: connectionResource(this.connectionId),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  }

  async abort(): Promise<void> {
    this.assertLive();
    await this.bridge.invoke(
      "connection.abort",
      { connectionId: this.connectionId },
      {
        timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
        mutation: true,
        resourceKey: connectionResource(this.connectionId),
      },
    );
  }

  async respondToExtensionUiRequest(
    requestIdValue: string,
    responseValue: Readonly<{ cancelled: true } | { value: string } | { confirmed: boolean }>,
  ): Promise<void> {
    this.assertLive();
    const requestId = boundedIdentifier(requestIdValue, "extension UI request ID");
    const response = normalizeExtensionUiResponse(responseValue);
    await this.bridge.invoke(
      "connection.respond_extension_ui",
      { connectionId: this.connectionId, requestId, response },
      {
        timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
        mutation: true,
        resourceKey: connectionResource(this.connectionId),
      },
    );
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      if (this.disposed) return;
      this.disposed = true;
      let clientClosedByDispose = false;
      try {
        await this.bridge.invoke(
          "connection.dispose",
          { connectionId: this.connectionId },
          {
            timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
            mutation: this.ownedSession,
            resourceKey: connectionResource(this.connectionId),
          },
        );
        clientClosedByDispose = true;
      } finally {
        this.listeners.clear();
        this.queuedEvents.length = 0;
        this.queuedEventBytes = 0;
        this.bridge.retireConnection(this.connectionId, this.client.clientId, clientClosedByDispose);
      }
    })();
    return this.disposePromise;
  }

  receiveEvent(event: unknown): void {
    if (this.disposed) return;
    if (this.listeners.size === 0) {
      const bytes = jsonByteLength(event, "queued resident session event");
      if (
        this.queuedEvents.length >= RESIDENT_WORKER_LIMITS.maxQueuedEvents ||
        this.queuedEventBytes + bytes > RESIDENT_WORKER_LIMITS.maxQueuedEventBytes
      ) {
        this.markTransportClosed();
        throw new Error("Resident worker pre-subscription event queue exceeded its bound");
      }
      this.queuedEvents.push({ event, bytes });
      this.queuedEventBytes += bytes;
      return;
    }
    this.emitEvent(event);
  }

  markTransportClosed(): void {
    this.disposed = true;
    this.listeners.clear();
    this.queuedEvents.length = 0;
    this.queuedEventBytes = 0;
  }

  usesClient(clientId: string): boolean {
    return this.client.clientId === clientId;
  }

  private flushQueuedEvents(): void {
    if (this.listeners.size === 0 || this.disposed) return;
    const queued = this.queuedEvents.splice(0);
    this.queuedEventBytes = 0;
    for (const entry of queued) this.emitEvent(entry.event);
  }

  private emitEvent(event: unknown): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(event)).catch(() => undefined);
      } catch {
        // The adapter listener owns its own failure transition. One observer
        // cannot disrupt MessagePort ordering for the remaining observers.
      }
    }
  }

  private assertLive(): void {
    if (!this.attached || this.disposed) throw new Error("Resident worker connection is not live");
  }
}

function remoteError(value: unknown): ResidentWorkerRemoteError {
  return new ResidentWorkerRemoteError(validateSerializedResidentWorkerError(value));
}

function validateVerifiedModuleUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "file:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("Verified Prime Agent module URL is invalid");
  }
  return url.href;
}

function validateHostdBundlePath(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || /[\0\r\n]/.test(value)) {
    throw new TypeError("Packaged hostd bundle path is invalid");
  }
  const path = resolve(value);
  if (basename(path).toLowerCase() !== "hostd.cjs") {
    throw new TypeError("Resident worker must load the packaged hostd.cjs authority bundle");
  }
  return path;
}

function daemonCommandMayMutate(command: Readonly<object>): boolean {
  return !isRecord(command) || command.type !== "list";
}

function normalizeExtensionUiResponse(
  value: Readonly<{ cancelled: true } | { value: string } | { confirmed: boolean }>,
): Readonly<{ cancelled: true } | { value: string } | { confirmed: boolean }> {
  if ("cancelled" in value && value.cancelled === true && Object.keys(value).length === 1) {
    return Object.freeze({ cancelled: true as const });
  }
  if (
    "value" in value &&
    typeof value.value === "string" &&
    value.value.length <= RESIDENT_WORKER_LIMITS.maxExtensionUiValueCharacters &&
    Object.keys(value).length === 1
  ) {
    return Object.freeze({ value: value.value });
  }
  if ("confirmed" in value && typeof value.confirmed === "boolean" && Object.keys(value).length === 1) {
    return Object.freeze({ confirmed: value.confirmed });
  }
  throw new TypeError("Extension UI response is invalid");
}

function proxyRoundTripTimeout(upstreamTimeoutMs: number): number {
  return Math.min(
    RESIDENT_WORKER_LIMITS.maxRequestTimeoutMs,
    boundedTimeout(upstreamTimeoutMs, "upstream timeout") + 2_000,
  );
}

function boundedLoaderTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 60_000) {
    throw new TypeError("Resident worker ready timeout must be an integer from 10 to 60000 milliseconds");
  }
  return value;
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise(false), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function invokeRecoveryWithinDeadline(callback: () => Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(callback),
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timeout = setTimeout(() => {
          rejectPromise(new ResidentWorkerTransportError(
            "RESIDENT_WORKER_RECOVERY_TIMEOUT",
            "Resident daemon recovery callback exceeded its deadline",
            { outcome: "unknown" },
          ));
        }, RESIDENT_WORKER_LIMITS.recoveryTimeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function clientResource(clientId: string): string {
  return `client:${clientId}`;
}

function connectionResource(connectionId: string): string {
  return `connection:${connectionId}`;
}

function requireNextBridgeOrdinal(value: string, prefix: string, previous: number): number {
  const expected = previous + 1;
  if (!Number.isSafeInteger(expected) || value !== `${prefix}:${expected}`) {
    throw new Error(`Resident worker ${prefix} ID is out of sequence`);
  }
  return expected;
}
