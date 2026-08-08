import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RESIDENT_WORKER_LIMITS,
  RESIDENT_WORKER_OPERATIONS,
  boundedIdentifier,
  boundedJsonClone,
  boundedString,
  boundedTimeout,
  isRecord,
  residentWorkerMessageBase,
  residentWorkerOperationResultBound,
  residentWorkerOutboundMessageBound,
  serializeResidentWorkerError,
  strictRecord,
  validateResidentWorkerBootstrap,
  validateResidentWorkerMessageBase,
  validateSerializedResidentWorkerError,
  ResidentWorkerProtocolError,
  type ResidentWorkerBootstrap,
  type ResidentWorkerInboundMessage,
  type ResidentWorkerOperation,
  type ResidentWorkerOutboundMessage,
} from "./prime-agent-resident-worker-protocol";

export interface ResidentWorkerPort {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): this;
  close(): void;
}

interface WorkerDaemonClient {
  readonly hello?: unknown;
  readonly isConnected?: boolean;
  connect(timeoutMs?: number): Promise<void>;
  waitForHello(timeoutMs?: number): Promise<unknown>;
  request(command: Readonly<object>, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

interface WorkerDaemonConnection {
  getInitialSnapshot(): Promise<unknown>;
  waitForIdle?(): Promise<void>;
  getAvailableModels?(): Promise<unknown>;
  setModel?(provider: string, modelId: string): Promise<unknown>;
  promoteToResident?(): Promise<void>;
  prompt?(
    message: string,
    options?: Readonly<{ queueIfBusy?: boolean; signal?: AbortSignal }>,
  ): Promise<void>;
  abort?(): Promise<void>;
  subscribe(listener: (event: unknown) => void | Promise<void>): () => void;
  dispose(): Promise<void>;
}

export interface ResidentWorkerRuntimeModule {
  readonly DaemonClient: new (socketPath: string) => WorkerDaemonClient;
  readonly DaemonAgentConnection: Readonly<{
    attach(
      client: WorkerDaemonClient,
      activeSessionId: string,
      options: Readonly<{
        closeClientOnDispose: true;
        sendClientEnv: false;
        supportsExtensionUi: false;
        ownedSession: boolean;
        recoverDaemon: () => Promise<void>;
      }>,
    ): Promise<WorkerDaemonConnection>;
  }>;
}

interface ClientRecord {
  readonly client: WorkerDaemonClient;
  connectionCount: number;
  locallyClosed: boolean;
}

type ConnectionOwnership = "owned" | "promoting" | "resident" | "promotion_unknown";

interface ConnectionRecord {
  readonly connection: WorkerDaemonConnection;
  readonly clientId: string;
  ownership: ConnectionOwnership;
  unsubscribe: () => void;
  disposed: boolean;
}

interface AttachingConnectionRecord {
  readonly clientId: string;
  readonly ownership: "owned" | "resident";
  abandoned: boolean;
}

interface RecoveryRecord {
  readonly connectionId: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export interface ResidentRuntimeWorkerServerOptions {
  readonly bootstrap: ResidentWorkerBootstrap;
  readonly port: ResidentWorkerPort;
  readonly loadRuntimeModule?: (moduleUrl: string) => Promise<ResidentWorkerRuntimeModule>;
}

export class ResidentRuntimeWorkerServer {
  private readonly bootstrap: ResidentWorkerBootstrap;
  private readonly port: ResidentWorkerPort;
  private readonly loadRuntimeModule: (moduleUrl: string) => Promise<ResidentWorkerRuntimeModule>;
  private readonly base: ReturnType<typeof residentWorkerMessageBase>;
  private readonly clients = new Map<string, ClientRecord>();
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly attachingConnections = new Map<string, AttachingConnectionRecord>();
  private readonly activeRequests = new Set<string>();
  private readonly promptCancellations = new Map<string, AbortController>();
  private readonly recoveries = new Map<string, RecoveryRecord>();
  private runtimeModule: ResidentWorkerRuntimeModule | undefined;
  private lastRequestOrdinal = 0;
  private lastClientOrdinal = 0;
  private lastConnectionOrdinal = 0;
  private recoveryOrdinal = 0;
  private started = false;
  private closing = false;
  private fatalSent = false;

  constructor(options: ResidentRuntimeWorkerServerOptions) {
    this.bootstrap = validateResidentWorkerBootstrap(options.bootstrap);
    this.port = options.port;
    this.loadRuntimeModule = options.loadRuntimeModule ?? loadResidentWorkerRuntimeModule;
    this.base = residentWorkerMessageBase(this.bootstrap.generation);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Resident runtime worker server has already started");
    this.started = true;
    this.port.on("message", (value) => this.receive(value));
    try {
      this.runtimeModule = await this.loadRuntimeModule(this.bootstrap.moduleUrl);
      this.post({ ...this.base, type: "ready" });
    } catch (error) {
      await this.failFatal(error);
    }
  }

  private receive(value: unknown): void {
    if (this.closing) return;
    let normalized: ResidentWorkerInboundMessage;
    try {
      normalized = boundedJsonClone(
        value,
        RESIDENT_WORKER_LIMITS.maxControlMessageBytes,
        "resident worker inbound message",
      ) as ResidentWorkerInboundMessage;
      const record = validateResidentWorkerMessageBase(normalized, this.bootstrap.generation);
      switch (record.type) {
        case "request":
          this.receiveRequest(normalized);
          return;
        case "cancel":
          this.receiveCancel(normalized);
          return;
        case "recovery_response":
          this.receiveRecoveryResponse(normalized);
          return;
        case "shutdown":
          strictRecord(record, ["protocol", "protocolVersion", "generation", "type"], "worker shutdown");
          void this.shutdown();
          return;
        default:
          throw new ResidentWorkerProtocolError("Resident worker inbound message type is invalid");
      }
    } catch (error) {
      void this.failFatal(error);
    }
  }

  private receiveRequest(value: unknown): void {
    const record = strictRecord(
      validateResidentWorkerMessageBase(value, this.bootstrap.generation),
      ["protocol", "protocolVersion", "generation", "type", "requestId", "operation", "payload"],
      "resident worker request",
    );
    if (record.type !== "request") throw new ResidentWorkerProtocolError("Resident worker request type is invalid");
    const requestId = boundedIdentifier(record.requestId, "worker request ID");
    this.lastRequestOrdinal = requireNextOrdinal(requestId, "request", this.lastRequestOrdinal);
    if (typeof record.operation !== "string" || !RESIDENT_WORKER_OPERATIONS.has(record.operation as ResidentWorkerOperation)) {
      throw new ResidentWorkerProtocolError("Resident worker operation is invalid");
    }
    const operation = record.operation as ResidentWorkerOperation;
    if (this.activeRequests.has(requestId)) throw new ResidentWorkerProtocolError("Resident worker request ID was reused");
    if (this.activeRequests.size >= RESIDENT_WORKER_LIMITS.maxPendingRequests) {
      throw new ResidentWorkerProtocolError("Resident worker request limit reached");
    }
    if (!isRecord(record.payload)) throw new ResidentWorkerProtocolError("Resident worker request payload is invalid");
    this.activeRequests.add(requestId);
    void this.executeRequest(requestId, operation, record.payload);
  }

  private receiveCancel(value: unknown): void {
    const record = strictRecord(
      validateResidentWorkerMessageBase(value, this.bootstrap.generation),
      ["protocol", "protocolVersion", "generation", "type", "requestId"],
      "resident worker cancellation",
    );
    if (record.type !== "cancel") throw new ResidentWorkerProtocolError("Resident worker cancellation type is invalid");
    const requestId = boundedIdentifier(record.requestId, "cancelled worker request ID");
    this.promptCancellations.get(requestId)?.abort(new Error("Prompt admission cancelled by host"));
  }

  private receiveRecoveryResponse(value: unknown): void {
    const record = strictRecord(
      validateResidentWorkerMessageBase(value, this.bootstrap.generation),
      ["protocol", "protocolVersion", "generation", "type", "recoveryRequestId", "ok", "error"],
      "resident worker recovery response",
    );
    if (record.type !== "recovery_response" || typeof record.ok !== "boolean") {
      throw new ResidentWorkerProtocolError("Resident worker recovery response is invalid");
    }
    const recoveryRequestId = boundedIdentifier(record.recoveryRequestId, "recovery request ID");
    const pending = this.recoveries.get(recoveryRequestId);
    if (!pending) return;
    this.recoveries.delete(recoveryRequestId);
    clearTimeout(pending.timeout);
    if (record.ok) {
      if (record.error !== undefined) {
        throw new ResidentWorkerProtocolError("Successful recovery response carried an error");
      }
      pending.resolve();
      return;
    }
    pending.reject(remoteRecoveryError(record.error));
  }

  private async executeRequest(
    requestId: string,
    operation: ResidentWorkerOperation,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    let mutationInvoked = false;
    try {
      const execution = await this.execute(operation, payload, requestId, () => {
        mutationInvoked = true;
      });
      const result = boundedJsonClone(
        execution.result ?? null,
        residentWorkerOperationResultBound(operation),
        `${operation} result`,
      );
      this.post({
        ...this.base,
        type: "response",
        requestId,
        operation,
        ok: true,
        result,
        ...(execution.clientState ? { clientState: execution.clientState } : {}),
      });
    } catch (error) {
      if (isProtocolFailure(error)) {
        await this.failFatal(error);
        return;
      }
      try {
        this.post({
          ...this.base,
          type: "response",
          requestId,
          operation,
          ok: false,
          error: serializeResidentWorkerError(
            error,
            residentWorkerFailureOutcome(error, mutationInvoked, operation),
          ),
        });
      } catch (serializationError) {
        await this.failFatal(serializationError);
        return;
      }
    } finally {
      this.activeRequests.delete(requestId);
      this.promptCancellations.delete(requestId);
    }
  }

  private async execute(
    operation: ResidentWorkerOperation,
    payload: Readonly<Record<string, unknown>>,
    requestId: string,
    markMutationInvoked: () => void,
  ): Promise<{ readonly result?: unknown; readonly clientState?: ReturnType<ResidentRuntimeWorkerServer["clientState"]> }> {
    const runtime = this.requireRuntime();
    switch (operation) {
      case "client.create": {
        const input = strictRecord(payload, ["clientId", "socketPath"], operation);
        const clientId = boundedIdentifier(input.clientId, "worker client ID");
        this.lastClientOrdinal = requireNextOrdinal(clientId, "client", this.lastClientOrdinal);
        const socketPath = boundedString(
          input.socketPath,
          RESIDENT_WORKER_LIMITS.maxSocketPathCharacters,
          "daemon socket path",
        );
        if (this.clients.has(clientId)) throw new ResidentWorkerProtocolError("Resident worker client ID was reused");
        if (this.clients.size >= RESIDENT_WORKER_LIMITS.maxClients) {
          throw new ResidentWorkerProtocolError("Resident worker client limit reached");
        }
        const client = new runtime.DaemonClient(socketPath);
        const record: ClientRecord = { client, connectionCount: 0, locallyClosed: false };
        this.clients.set(clientId, record);
        return { result: null, clientState: this.clientState(clientId, record) };
      }
      case "client.connect": {
        const input = strictRecord(payload, ["clientId", "timeoutMs"], operation);
        const [clientId, record] = this.requireClient(input.clientId);
        await record.client.connect(boundedTimeout(input.timeoutMs, "client connect timeout"));
        return { result: null, clientState: this.clientState(clientId, record) };
      }
      case "client.wait_for_hello": {
        const input = strictRecord(payload, ["clientId", "timeoutMs"], operation);
        const [clientId, record] = this.requireClient(input.clientId);
        const hello = await record.client.waitForHello(boundedTimeout(input.timeoutMs, "hello timeout"));
        return { result: hello, clientState: this.clientState(clientId, record) };
      }
      case "client.request": {
        const input = strictRecord(payload, ["clientId", "command", "timeoutMs"], operation);
        const [clientId, record] = this.requireClient(input.clientId);
        if (!isRecord(input.command)) throw new ResidentWorkerProtocolError("Daemon command must be an object");
        const command = boundedJsonClone(
          input.command,
          RESIDENT_WORKER_LIMITS.maxDaemonResponseBytes,
          "daemon command",
        );
        if (operationMayMutate(operation, input)) markMutationInvoked();
        const result = await record.client.request(
          command,
          boundedTimeout(input.timeoutMs, "daemon request timeout"),
        );
        return { result, clientState: this.clientState(clientId, record) };
      }
      case "client.close": {
        const input = strictRecord(payload, ["clientId"], operation);
        const [clientId, record] = this.requireClient(input.clientId, true);
        record.locallyClosed = true;
        this.abandonClientConnections(clientId, record);
        record.client.close();
        this.clients.delete(clientId);
        return { result: null, clientState: { clientId, isConnected: false } };
      }
      case "connection.attach": {
        const input = strictRecord(payload, [
          "connectionId",
          "clientId",
          "activeSessionId",
          "closeClientOnDispose",
          "sendClientEnv",
          "supportsExtensionUi",
          "ownedSession",
        ], operation);
        const connectionId = boundedIdentifier(input.connectionId, "worker connection ID");
        this.lastConnectionOrdinal = requireNextOrdinal(
          connectionId,
          "connection",
          this.lastConnectionOrdinal,
        );
        const [clientId, clientRecord] = this.requireClient(input.clientId);
        const activeSessionId = boundedString(
          input.activeSessionId,
          RESIDENT_WORKER_LIMITS.maxSocketPathCharacters,
          "active session ID",
        );
        if (
          input.closeClientOnDispose !== true ||
          input.sendClientEnv !== false ||
          input.supportsExtensionUi !== false ||
          typeof input.ownedSession !== "boolean"
        ) {
          throw new ResidentWorkerProtocolError("Resident worker attach options differ from the fixed public contract");
        }
        if (this.connections.has(connectionId) || this.attachingConnections.has(connectionId)) {
          throw new ResidentWorkerProtocolError("Resident worker connection ID was reused");
        }
        if (this.connections.size + this.attachingConnections.size >= RESIDENT_WORKER_LIMITS.maxConnections) {
          throw new ResidentWorkerProtocolError("Resident worker connection limit reached");
        }
        const attaching: AttachingConnectionRecord = {
          clientId,
          ownership: input.ownedSession ? "owned" : "resident",
          abandoned: false,
        };
        this.attachingConnections.set(connectionId, attaching);
        try {
          const connection = await runtime.DaemonAgentConnection.attach(clientRecord.client, activeSessionId, {
            closeClientOnDispose: true,
            sendClientEnv: false,
            supportsExtensionUi: false,
            ownedSession: input.ownedSession,
            recoverDaemon: () => this.requestHostRecovery(connectionId),
          });
          if (attaching.abandoned) {
            throw new Error("Resident worker connection authority closed during attach");
          }
          const connectionRecord: ConnectionRecord = {
            connection,
            clientId,
            ownership: attaching.ownership,
            unsubscribe: () => undefined,
            disposed: false,
          };
          connectionRecord.unsubscribe = connection.subscribe((event) => {
            this.postConnectionEvent(connectionId, connectionRecord, event);
          });
          this.connections.set(connectionId, connectionRecord);
          clientRecord.connectionCount += 1;
          return { result: null, clientState: this.clientState(clientId, clientRecord) };
        } catch (error) {
          this.rejectConnectionRecoveries(
            connectionId,
            new Error("Resident worker connection attach ended during daemon recovery"),
          );
          throw error;
        } finally {
          this.attachingConnections.delete(connectionId);
        }
      }
      case "connection.get_initial_snapshot": {
        const [, record] = this.requireConnectionPayload(payload, operation);
        return { result: await record.connection.getInitialSnapshot() };
      }
      case "connection.wait_for_idle": {
        const [, record] = this.requireConnectionPayload(payload, operation);
        if (typeof record.connection.waitForIdle !== "function") throw new Error("Public idle barrier is unavailable");
        await record.connection.waitForIdle.call(record.connection);
        return { result: null };
      }
      case "connection.get_available_models": {
        const [, record] = this.requireConnectionPayload(payload, operation);
        if (typeof record.connection.getAvailableModels !== "function") throw new Error("Model catalog is unavailable");
        return { result: await record.connection.getAvailableModels.call(record.connection) };
      }
      case "connection.set_model": {
        const input = strictRecord(payload, ["connectionId", "providerId", "modelId"], operation);
        const [, record] = this.requireConnection(input.connectionId);
        if (typeof record.connection.setModel !== "function") throw new Error("Model selection is unavailable");
        const providerId = boundedString(
          input.providerId,
          RESIDENT_WORKER_LIMITS.maxProviderCharacters,
          "model provider ID",
        );
        const modelId = boundedString(input.modelId, RESIDENT_WORKER_LIMITS.maxModelCharacters, "model ID");
        markMutationInvoked();
        return { result: await record.connection.setModel.call(record.connection, providerId, modelId) };
      }
      case "connection.promote_to_resident": {
        const [, record] = this.requireConnectionPayload(payload, operation);
        if (typeof record.connection.promoteToResident !== "function") {
          throw new Error("Owned session promotion is unavailable");
        }
        if (record.ownership !== "owned") {
          throw new Error("Owned session promotion is not available in the current ownership state");
        }
        record.ownership = "promoting";
        markMutationInvoked();
        try {
          await record.connection.promoteToResident.call(record.connection);
        } catch (error) {
          record.ownership = "promotion_unknown";
          throw error;
        }
        record.ownership = "resident";
        return { result: null };
      }
      case "connection.prompt": {
        const input = strictRecord(payload, ["connectionId", "message", "queueIfBusy", "signalAborted"], operation);
        const [, record] = this.requireConnection(input.connectionId);
        if (typeof record.connection.prompt !== "function") throw new Error("Prompt admission is unavailable");
        if (
          typeof input.message !== "string" ||
          input.message.length < 1 ||
          input.message.length > RESIDENT_WORKER_LIMITS.maxPromptCharacters ||
          typeof input.queueIfBusy !== "boolean" ||
          typeof input.signalAborted !== "boolean"
        ) {
          throw new ResidentWorkerProtocolError("Prompt admission payload is invalid");
        }
        const controller = new AbortController();
        this.promptCancellations.set(requestId, controller);
        if (input.signalAborted) controller.abort(new Error("Prompt admission was already cancelled"));
        markMutationInvoked();
        await record.connection.prompt.call(record.connection, input.message, {
          queueIfBusy: input.queueIfBusy,
          signal: controller.signal,
        });
        return { result: null };
      }
      case "connection.abort": {
        const [, record] = this.requireConnectionPayload(payload, operation);
        if (typeof record.connection.abort !== "function") throw new Error("Abort admission is unavailable");
        markMutationInvoked();
        await record.connection.abort.call(record.connection);
        return { result: null };
      }
      case "connection.dispose": {
        const [connectionId, record] = this.requireConnectionPayload(payload, operation, true);
        if (!record.disposed) {
          if (record.ownership === "promoting" || record.ownership === "promotion_unknown") {
            this.abandonConnection(connectionId, record);
            throw uncertainPromotionDisposalError(connectionId, record.ownership);
          }
          record.disposed = true;
          record.unsubscribe();
          this.rejectConnectionRecoveries(
            connectionId,
            new Error("Resident worker connection closed during daemon recovery"),
          );
          if (record.ownership === "owned") markMutationInvoked();
          await record.connection.dispose();
        }
        this.connections.delete(connectionId);
        const client = this.clients.get(record.clientId);
        if (client) {
          client.connectionCount = Math.max(0, client.connectionCount - 1);
          client.locallyClosed = true;
          if (client.connectionCount === 0) this.clients.delete(record.clientId);
        }
        return { result: null, clientState: { clientId: record.clientId, isConnected: false } };
      }
    }
  }

  private postConnectionEvent(connectionId: string, record: ConnectionRecord, event: unknown): void {
    if (this.closing || record.disposed) return;
    try {
      const normalizedEvent = boundedJsonClone(event, RESIDENT_WORKER_LIMITS.maxEventBytes, "session event");
      const client = this.clients.get(record.clientId);
      if (!client) throw new ResidentWorkerProtocolError("Connection event lost its client authority");
      this.post({
        ...this.base,
        type: "connection_event",
        connectionId,
        event: normalizedEvent,
        clientState: this.clientState(record.clientId, client),
      });
    } catch (error) {
      void this.failFatal(error);
    }
  }

  private requestHostRecovery(connectionId: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Resident worker is closing"));
    const attaching = this.attachingConnections.get(connectionId);
    let connection: ConnectionRecord | undefined;
    if (!attaching) {
      try {
        [, connection] = this.requireConnection(connectionId);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const clientId = attaching?.clientId ?? connection?.clientId;
    const client = clientId ? this.clients.get(clientId) : undefined;
    if (
      attaching?.abandoned === true ||
      connection?.ownership === "promotion_unknown" ||
      !client ||
      client.locallyClosed
    ) {
      return Promise.reject(new Error("Resident worker recovery requires a live connection authority"));
    }
    if (this.recoveries.size >= RESIDENT_WORKER_LIMITS.maxPendingRequests) {
      return Promise.reject(new Error("Resident worker recovery request limit reached"));
    }
    const recoveryOrdinal = this.recoveryOrdinal + 1;
    if (!Number.isSafeInteger(recoveryOrdinal)) {
      return Promise.reject(new Error("Resident worker recovery request ordinal is exhausted"));
    }
    this.recoveryOrdinal = recoveryOrdinal;
    const recoveryRequestId = boundedIdentifier(`recovery:${recoveryOrdinal}`, "recovery request ID");
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.recoveries.delete(recoveryRequestId);
        rejectPromise(new Error("Resident daemon recovery callback timed out"));
      }, RESIDENT_WORKER_LIMITS.recoveryTimeoutMs);
      timeout.unref?.();
      this.recoveries.set(recoveryRequestId, {
        connectionId,
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout,
      });
      try {
        this.post({
          ...this.base,
          type: "recovery_request",
          recoveryRequestId,
          connectionId,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.recoveries.delete(recoveryRequestId);
        rejectPromise(error instanceof Error ? error : new Error("Resident worker recovery request could not be posted"));
      }
    });
  }

  private post(value: ResidentWorkerOutboundMessage): void {
    if (this.closing && value.type !== "fatal" && value.type !== "closed") return;
    const normalized = boundedJsonClone(value, residentWorkerOutboundMessageBound(value), "resident worker outbound message");
    this.port.postMessage(normalized);
  }

  private requireRuntime(): ResidentWorkerRuntimeModule {
    if (!this.runtimeModule) throw new ResidentWorkerProtocolError("Resident worker runtime module is not ready");
    return this.runtimeModule;
  }

  private requireClient(value: unknown, allowClosed = false): readonly [string, ClientRecord] {
    const clientId = boundedIdentifier(value, "worker client ID");
    const record = this.clients.get(clientId);
    if (!record || (!allowClosed && record.locallyClosed)) throw new Error("Resident worker client is unavailable");
    return [clientId, record] as const;
  }

  private requireConnection(value: unknown, allowDisposed = false): readonly [string, ConnectionRecord] {
    const connectionId = boundedIdentifier(value, "worker connection ID");
    const record = this.connections.get(connectionId);
    if (!record || (!allowDisposed && record.disposed)) throw new Error("Resident worker connection is unavailable");
    return [connectionId, record] as const;
  }

  private requireConnectionPayload(
    payload: Readonly<Record<string, unknown>>,
    label: string,
    allowDisposed = false,
  ): readonly [string, ConnectionRecord] {
    const input = strictRecord(payload, ["connectionId"], label);
    return this.requireConnection(input.connectionId, allowDisposed);
  }

  private abandonConnection(connectionId: string, record: ConnectionRecord): void {
    record.disposed = true;
    record.unsubscribe();
    this.rejectConnectionRecoveries(
      connectionId,
      new Error("Resident worker connection was abandoned during daemon recovery"),
    );
    this.connections.delete(connectionId);
    const client = this.clients.get(record.clientId);
    if (client) client.connectionCount = Math.max(0, client.connectionCount - 1);
  }

  private abandonClientConnections(clientId: string, client: ClientRecord): void {
    for (const [connectionId, attaching] of this.attachingConnections) {
      if (attaching.clientId !== clientId) continue;
      attaching.abandoned = true;
      this.rejectConnectionRecoveries(
        connectionId,
        new Error("Resident worker client closed during connection attach recovery"),
      );
    }
    for (const [connectionId, connection] of this.connections) {
      if (connection.clientId !== clientId) continue;
      connection.disposed = true;
      connection.unsubscribe();
      this.rejectConnectionRecoveries(
        connectionId,
        new Error("Resident worker client closed during daemon recovery"),
      );
      this.connections.delete(connectionId);
    }
    client.connectionCount = 0;
  }

  private rejectConnectionRecoveries(connectionId: string, error: Error): void {
    for (const [recoveryRequestId, recovery] of this.recoveries) {
      if (recovery.connectionId !== connectionId) continue;
      this.recoveries.delete(recoveryRequestId);
      clearTimeout(recovery.timeout);
      recovery.reject(error);
    }
  }

  private clientState(clientId: string, record: ClientRecord): {
    readonly clientId: string;
    readonly isConnected: boolean;
    readonly hello?: unknown;
  } {
    const hello = record.client.hello === undefined
      ? undefined
      : boundedJsonClone(record.client.hello, RESIDENT_WORKER_LIMITS.maxHelloBytes, "daemon hello");
    return Object.freeze({
      clientId,
      isConnected: record.locallyClosed ? false : record.client.isConnected === true,
      ...(hello === undefined ? {} : { hello }),
    });
  }

  private async failFatal(error: unknown): Promise<void> {
    if (this.fatalSent) return;
    this.fatalSent = true;
    this.closing = true;
    try {
      this.post({
        ...this.base,
        type: "fatal",
        error: serializeResidentWorkerError(error, "unknown"),
      });
    } catch {
      // The port or violation may prevent even the bounded fatal diagnostic.
    }
    await this.closeResources();
    this.port.close();
  }

  private async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.closeResources();
    try {
      this.post({ ...this.base, type: "closed" });
    } finally {
      this.port.close();
    }
  }

  private async closeResources(): Promise<void> {
    for (const pending of this.recoveries.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Resident worker closed during daemon recovery"));
    }
    this.recoveries.clear();
    for (const controller of this.promptCancellations.values()) {
      controller.abort(new Error("Resident worker closed during prompt admission"));
    }
    this.promptCancellations.clear();
    const clientsClosedByDisposal = new Set<string>();
    const disposals: Promise<void>[] = [];
    for (const record of this.connections.values()) {
      record.unsubscribe();
      if (!record.disposed) {
        record.disposed = true;
        if (record.ownership !== "resident") {
          // Owned-session disposal completes the daemon-side candidate and is
          // therefore a mutation. Only the explicit, receipt-backed dispose
          // request may invoke it; generic Worker shutdown must not synthesize
          // that mutation.
          continue;
        }
        disposals.push(record.connection.dispose().then(
          () => {
            clientsClosedByDisposal.add(record.clientId);
            const client = this.clients.get(record.clientId);
            if (client) client.locallyClosed = true;
          },
          () => undefined,
        ));
      }
    }
    await Promise.race([
      Promise.allSettled(disposals),
      new Promise<void>((resolvePromise) => {
        const timeout = setTimeout(resolvePromise, 1_000);
        timeout.unref?.();
      }),
    ]);
    for (const [clientId, client] of this.clients) {
      if (client.locallyClosed || clientsClosedByDisposal.has(clientId)) continue;
      client.locallyClosed = true;
      try {
        client.client.close();
      } catch {
        // Closing remaining transports is best effort after authority is fenced.
      }
    }
    this.connections.clear();
    this.clients.clear();
  }
}

export async function loadResidentWorkerRuntimeModule(moduleUrlValue: string): Promise<ResidentWorkerRuntimeModule> {
  const moduleUrl = new URL(moduleUrlValue);
  if (moduleUrl.protocol !== "file:" || moduleUrl.username || moduleUrl.password || moduleUrl.search || moduleUrl.hash) {
    throw new Error("Verified Prime Agent module URL is invalid");
  }
  const rootEntrypoint = fileURLToPath(moduleUrl);
  const distDirectory = dirname(rootEntrypoint);
  const daemonClientPath = join(distDirectory, "modes", "daemon", "daemon-client.js");
  const daemonConnectionPath = join(distDirectory, "modes", "agent-connection", "daemon-agent-connection.js");
  assertContained(distDirectory, daemonClientPath);
  assertContained(distDirectory, daemonConnectionPath);
  const [clientModule, connectionModule] = await Promise.all([
    import(pathToFileURL(daemonClientPath).href),
    import(pathToFileURL(daemonConnectionPath).href),
  ]);
  if (
    typeof clientModule.DaemonClient !== "function" ||
    (typeof connectionModule.DaemonAgentConnection !== "object" &&
      typeof connectionModule.DaemonAgentConnection !== "function") ||
    connectionModule.DaemonAgentConnection === null ||
    typeof (connectionModule.DaemonAgentConnection as { attach?: unknown }).attach !== "function"
  ) {
    throw new Error("Verified Prime Agent transport modules are missing their public exports");
  }
  return Object.freeze({
    DaemonClient: clientModule.DaemonClient,
    DaemonAgentConnection: connectionModule.DaemonAgentConnection,
  }) as ResidentWorkerRuntimeModule;
}

function operationMayMutate(
  operation: ResidentWorkerOperation,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  if (
    operation === "connection.prompt" ||
    operation === "connection.abort" ||
    operation === "connection.set_model" ||
    operation === "connection.promote_to_resident"
  ) {
    return true;
  }
  if (operation !== "client.request" || !isRecord(payload.command)) return false;
  return payload.command.type !== "list";
}

function residentWorkerFailureOutcome(
  error: unknown,
  mutationInvoked: boolean,
  operation: ResidentWorkerOperation,
): "definitive" | "unknown" {
  if (!mutationInvoked) return "definitive";
  const status = isRecord(error) ? error.status : undefined;
  // These are prompt/Stop admission statuses, not generic daemon-command
  // outcomes. In particular, root kill is a `client.request`: every failure
  // after that call is unknown even if an upstream error happens to carry one
  // of the same status strings.
  return (operation === "connection.prompt" || operation === "connection.abort") &&
    (status === "cancelled" || status === "unsupported")
    ? "definitive"
    : "unknown";
}

function uncertainPromotionDisposalError(
  connectionId: string,
  ownership: "promoting" | "promotion_unknown",
): Error {
  return Object.assign(
    new Error("Owned-session promotion is uncertain; upstream disposal was not invoked"),
    {
      code: "RESIDENT_WORKER_PROMOTION_UNCERTAIN",
      status: "unknown" as const,
      retryable: false,
      details: Object.freeze({ connectionId, ownership }),
    },
  );
}

function remoteRecoveryError(value: unknown): Error {
  const serialized = validateSerializedResidentWorkerError(value);
  const error = new Error(serialized.message);
  error.name = serialized.name;
  return error;
}

function isProtocolFailure(error: unknown): boolean {
  return error instanceof ResidentWorkerProtocolError;
}

function assertContained(parent: string, child: string): void {
  const childRelative = relative(resolve(parent), resolve(child));
  if (childRelative === "" || childRelative === ".." || childRelative.startsWith(`..${sep}`)) {
    throw new Error("Resident worker module path escaped the verified runtime directory");
  }
}

function requireNextOrdinal(value: string, prefix: string, previous: number): number {
  const expected = previous + 1;
  if (!Number.isSafeInteger(expected) || value !== `${prefix}:${expected}`) {
    throw new ResidentWorkerProtocolError(`Resident worker ${prefix} ID is out of sequence`);
  }
  return expected;
}
