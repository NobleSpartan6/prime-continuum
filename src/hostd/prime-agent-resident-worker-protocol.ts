import { Buffer } from "node:buffer";

export const RESIDENT_WORKER_PROTOCOL = "prime-continuim.resident-worker" as const;
export const RESIDENT_WORKER_PROTOCOL_VERSION = 1 as const;

export const RESIDENT_WORKER_LIMITS = Object.freeze({
  maxControlMessageBytes: 8 * 1024 * 1024,
  maxSnapshotBytes: 50 * 1024 * 1024,
  maxEventBytes: 50 * 1024 * 1024,
  maxResourceSnapshotBytes: 8 * 1024 * 1024,
  maxModelCatalogBytes: 8 * 1024 * 1024,
  maxDaemonResponseBytes: 8 * 1024 * 1024,
  maxHelloBytes: 64 * 1024,
  maxErrorBytes: 16 * 1024,
  maxPendingRequests: 1_024,
  maxClients: 1_024,
  maxConnections: 1_024,
  maxQueuedEvents: 256,
  maxQueuedEventBytes: 64 * 1024 * 1024,
  maxIdentifierCharacters: 128,
  maxSocketPathCharacters: 4_096,
  maxPromptCharacters: 65_536,
  maxProviderCharacters: 128,
  maxModelCharacters: 512,
  maxThinkingLevelCharacters: 64,
  maxExtensionUiValueCharacters: 65_536,
  maxRequestTimeoutMs: 24 * 60 * 60 * 1_000,
  workerReadyTimeoutMs: 15_000,
  recoveryTimeoutMs: 30_000,
  closeTimeoutMs: 5_000,
} as const);

export type ResidentWorkerLimits = Readonly<typeof RESIDENT_WORKER_LIMITS>;

export type ResidentWorkerOperation =
  | "client.create"
  | "client.connect"
  | "client.wait_for_hello"
  | "client.request"
  | "client.close"
  | "connection.attach"
  | "connection.get_initial_snapshot"
  | "connection.wait_for_idle"
  | "connection.get_resource_snapshot"
  | "connection.get_available_models"
  | "connection.set_model"
  | "connection.set_thinking_level"
  | "connection.promote_to_resident"
  | "connection.prompt"
  | "connection.abort"
  | "connection.respond_extension_ui"
  | "connection.dispose";

export const RESIDENT_WORKER_OPERATIONS: ReadonlySet<ResidentWorkerOperation> = new Set([
  "client.create",
  "client.connect",
  "client.wait_for_hello",
  "client.request",
  "client.close",
  "connection.attach",
  "connection.get_initial_snapshot",
  "connection.wait_for_idle",
  "connection.get_resource_snapshot",
  "connection.get_available_models",
  "connection.set_model",
  "connection.set_thinking_level",
  "connection.promote_to_resident",
  "connection.prompt",
  "connection.abort",
  "connection.respond_extension_ui",
  "connection.dispose",
]);

export interface ResidentWorkerBootstrap {
  readonly protocol: typeof RESIDENT_WORKER_PROTOCOL;
  readonly protocolVersion: typeof RESIDENT_WORKER_PROTOCOL_VERSION;
  readonly generation: string;
  readonly moduleUrl: string;
}

interface ResidentWorkerMessageBase {
  readonly protocol: typeof RESIDENT_WORKER_PROTOCOL;
  readonly protocolVersion: typeof RESIDENT_WORKER_PROTOCOL_VERSION;
  readonly generation: string;
}

export interface ResidentWorkerRequestMessage extends ResidentWorkerMessageBase {
  readonly type: "request";
  readonly requestId: string;
  readonly operation: ResidentWorkerOperation;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ResidentWorkerCancelMessage extends ResidentWorkerMessageBase {
  readonly type: "cancel";
  readonly requestId: string;
}

export interface ResidentWorkerRecoveryResponseMessage extends ResidentWorkerMessageBase {
  readonly type: "recovery_response";
  readonly recoveryRequestId: string;
  readonly ok: boolean;
  readonly error?: SerializedResidentWorkerError;
}

export interface ResidentWorkerShutdownMessage extends ResidentWorkerMessageBase {
  readonly type: "shutdown";
}

export type ResidentWorkerInboundMessage =
  | ResidentWorkerRequestMessage
  | ResidentWorkerCancelMessage
  | ResidentWorkerRecoveryResponseMessage
  | ResidentWorkerShutdownMessage;

export interface ResidentWorkerReadyMessage extends ResidentWorkerMessageBase {
  readonly type: "ready";
}

export interface ResidentWorkerClientState {
  readonly clientId: string;
  readonly isConnected: boolean;
  readonly hello?: unknown;
}

export interface ResidentWorkerSuccessMessage extends ResidentWorkerMessageBase {
  readonly type: "response";
  readonly requestId: string;
  readonly operation: ResidentWorkerOperation;
  readonly ok: true;
  readonly result: unknown;
  readonly clientState?: ResidentWorkerClientState;
}

export interface ResidentWorkerFailureMessage extends ResidentWorkerMessageBase {
  readonly type: "response";
  readonly requestId: string;
  readonly operation: ResidentWorkerOperation;
  readonly ok: false;
  readonly error: SerializedResidentWorkerError;
}

export interface ResidentWorkerConnectionEventMessage extends ResidentWorkerMessageBase {
  readonly type: "connection_event";
  readonly connectionId: string;
  readonly event: unknown;
  readonly clientState: ResidentWorkerClientState;
}

export interface ResidentWorkerRecoveryRequestMessage extends ResidentWorkerMessageBase {
  readonly type: "recovery_request";
  readonly recoveryRequestId: string;
  readonly connectionId: string;
}

export interface ResidentWorkerFatalMessage extends ResidentWorkerMessageBase {
  readonly type: "fatal";
  readonly error: SerializedResidentWorkerError;
}

export interface ResidentWorkerClosedMessage extends ResidentWorkerMessageBase {
  readonly type: "closed";
}

export type ResidentWorkerOutboundMessage =
  | ResidentWorkerReadyMessage
  | ResidentWorkerSuccessMessage
  | ResidentWorkerFailureMessage
  | ResidentWorkerConnectionEventMessage
  | ResidentWorkerRecoveryRequestMessage
  | ResidentWorkerFatalMessage
  | ResidentWorkerClosedMessage;

export type ResidentWorkerErrorOutcome = "definitive" | "unknown";

export interface SerializedResidentWorkerError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly status?: "cancelled" | "owned" | "unknown" | "unsupported";
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly outcome: ResidentWorkerErrorOutcome;
}

export class ResidentWorkerProtocolError extends Error {
  readonly code = "RESIDENT_WORKER_PROTOCOL_INVALID" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResidentWorkerProtocolError";
  }
}

export function residentWorkerMessageBase(generation: string): ResidentWorkerMessageBase {
  return Object.freeze({
    protocol: RESIDENT_WORKER_PROTOCOL,
    protocolVersion: RESIDENT_WORKER_PROTOCOL_VERSION,
    generation: boundedIdentifier(generation, "worker generation"),
  });
}

export function validateResidentWorkerBootstrap(value: unknown): ResidentWorkerBootstrap {
  const record = strictRecord(value, ["protocol", "protocolVersion", "generation", "moduleUrl"], "worker bootstrap");
  if (
    record.protocol !== RESIDENT_WORKER_PROTOCOL ||
    record.protocolVersion !== RESIDENT_WORKER_PROTOCOL_VERSION
  ) {
    throw new ResidentWorkerProtocolError("Resident worker bootstrap protocol is invalid");
  }
  return Object.freeze({
    protocol: RESIDENT_WORKER_PROTOCOL,
    protocolVersion: RESIDENT_WORKER_PROTOCOL_VERSION,
    generation: boundedIdentifier(record.generation, "worker generation"),
    moduleUrl: boundedString(record.moduleUrl, 8_192, "runtime module URL"),
  });
}

export function validateResidentWorkerMessageBase(
  value: unknown,
  generation: string,
): Readonly<Record<string, unknown>> {
  const record = recordValue(value, "resident worker message");
  if (
    record.protocol !== RESIDENT_WORKER_PROTOCOL ||
    record.protocolVersion !== RESIDENT_WORKER_PROTOCOL_VERSION ||
    record.generation !== generation
  ) {
    throw new ResidentWorkerProtocolError("Resident worker message identity is invalid");
  }
  return record;
}

export function boundedJsonClone<T>(value: T, maxBytes: number, label: string): T {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("JSON byte bound must be a positive safe integer");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new ResidentWorkerProtocolError(`${label} is not JSON serializable`, { cause: error });
  }
  if (serialized === undefined) {
    throw new ResidentWorkerProtocolError(`${label} is not a JSON value`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new ResidentWorkerProtocolError(`${label} exceeds its ${maxBytes}-byte bound`);
  }
  try {
    return JSON.parse(serialized) as T;
  } catch (error) {
    throw new ResidentWorkerProtocolError(`${label} could not be normalized`, { cause: error });
  }
}

export function jsonByteLength(value: unknown, label: string): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new ResidentWorkerProtocolError(`${label} is not JSON serializable`, { cause: error });
  }
  if (serialized === undefined) throw new ResidentWorkerProtocolError(`${label} is not a JSON value`);
  return Buffer.byteLength(serialized, "utf8");
}

export function serializeResidentWorkerError(
  error: unknown,
  outcome: ResidentWorkerErrorOutcome,
): SerializedResidentWorkerError {
  const candidate = isRecord(error) ? error : undefined;
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error ?? "Unknown resident worker failure");
  const code = typeof candidate?.code === "string" ? candidate.code : undefined;
  const status = isPromptAdmissionStatus(candidate?.status) ? candidate.status : undefined;
  const retryable = typeof candidate?.retryable === "boolean" ? candidate.retryable : undefined;
  const details = sanitizeErrorDetails(candidate?.details);
  const serialized = {
    name: boundedErrorText(name, 128, "Error"),
    message: boundedErrorText(message, 4_096, "Resident worker operation failed"),
    ...(code ? { code: boundedErrorText(code, 128, "REMOTE_ERROR") } : {}),
    ...(status ? { status } : {}),
    ...(retryable === undefined ? {} : { retryable }),
    ...(details ? { details } : {}),
    outcome,
  } satisfies SerializedResidentWorkerError;
  return Object.freeze(
    boundedJsonClone(serialized, RESIDENT_WORKER_LIMITS.maxErrorBytes, "resident worker error"),
  );
}

export function validateSerializedResidentWorkerError(value: unknown): SerializedResidentWorkerError {
  const record = strictRecord(
    value,
    ["name", "message", "code", "status", "retryable", "details", "outcome"],
    "resident worker error",
  );
  if (record.outcome !== "definitive" && record.outcome !== "unknown") {
    throw new ResidentWorkerProtocolError("Resident worker error outcome is invalid");
  }
  if (record.status !== undefined && !isPromptAdmissionStatus(record.status)) {
    throw new ResidentWorkerProtocolError("Resident worker error status is invalid");
  }
  if (record.retryable !== undefined && typeof record.retryable !== "boolean") {
    throw new ResidentWorkerProtocolError("Resident worker error retryability is invalid");
  }
  let details: Readonly<Record<string, string | number | boolean>> | undefined;
  if (record.details !== undefined) {
    if (!isRecord(record.details) || Object.keys(record.details).length > 32) {
      throw new ResidentWorkerProtocolError("Resident worker error details are invalid");
    }
    const entries: Array<readonly [string, string | number | boolean]> = [];
    for (const [key, detail] of Object.entries(record.details)) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
        throw new ResidentWorkerProtocolError("Resident worker error detail key is invalid");
      }
      if (typeof detail === "string") {
        entries.push([key, boundedString(detail, 1_024, "resident worker error detail")]);
      } else if (typeof detail === "boolean") {
        entries.push([key, detail]);
      } else if (typeof detail === "number" && Number.isFinite(detail)) {
        entries.push([key, detail]);
      } else {
        throw new ResidentWorkerProtocolError("Resident worker error detail value is invalid");
      }
    }
    details = Object.freeze(Object.fromEntries(entries));
  }
  const result = {
    name: boundedString(record.name, 128, "resident worker error name"),
    message: boundedString(record.message, 4_096, "resident worker error message"),
    ...(record.code === undefined
      ? {}
      : { code: boundedString(record.code, 128, "resident worker error code") }),
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.retryable === undefined ? {} : { retryable: record.retryable }),
    ...(details === undefined ? {} : { details }),
    outcome: record.outcome,
  } satisfies SerializedResidentWorkerError;
  return Object.freeze(boundedJsonClone(result, RESIDENT_WORKER_LIMITS.maxErrorBytes, "resident worker error"));
}

export function boundedIdentifier(value: unknown, label: string): string {
  const result = boundedString(value, RESIDENT_WORKER_LIMITS.maxIdentifierCharacters, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    throw new ResidentWorkerProtocolError(`${label} contains invalid characters`);
  }
  return result;
}

export function boundedString(value: unknown, maxCharacters: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxCharacters || /[\0\r\n]/.test(value)) {
    throw new ResidentWorkerProtocolError(`${label} is invalid`);
  }
  return value;
}

export function boundedTimeout(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > RESIDENT_WORKER_LIMITS.maxRequestTimeoutMs
  ) {
    throw new ResidentWorkerProtocolError(`${label} is invalid`);
  }
  return value;
}

export function residentWorkerOperationResultBound(operation: ResidentWorkerOperation): number {
  switch (operation) {
    case "connection.get_initial_snapshot":
      return RESIDENT_WORKER_LIMITS.maxSnapshotBytes;
    case "connection.get_resource_snapshot":
      return RESIDENT_WORKER_LIMITS.maxResourceSnapshotBytes;
    case "connection.get_available_models":
      return RESIDENT_WORKER_LIMITS.maxModelCatalogBytes;
    case "client.request":
      return RESIDENT_WORKER_LIMITS.maxDaemonResponseBytes;
    case "client.connect":
    case "client.wait_for_hello":
    case "connection.attach":
      return RESIDENT_WORKER_LIMITS.maxHelloBytes;
    default:
      return RESIDENT_WORKER_LIMITS.maxControlMessageBytes;
  }
}

export function residentWorkerOutboundMessageBound(value: unknown): number {
  const record = isRecord(value) ? value : undefined;
  if (record?.type === "connection_event") {
    return RESIDENT_WORKER_LIMITS.maxEventBytes + RESIDENT_WORKER_LIMITS.maxHelloBytes;
  }
  if (record?.type === "response" && record.ok === true && typeof record.operation === "string") {
    if (RESIDENT_WORKER_OPERATIONS.has(record.operation as ResidentWorkerOperation)) {
      return residentWorkerOperationResultBound(record.operation as ResidentWorkerOperation) +
        RESIDENT_WORKER_LIMITS.maxHelloBytes;
    }
  }
  return RESIDENT_WORKER_LIMITS.maxControlMessageBytes;
}

export function strictRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  const record = recordValue(value, label);
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ResidentWorkerProtocolError(`${label} contains an unknown field`);
  }
  return record;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new ResidentWorkerProtocolError(`${label} must be an object`);
  return value;
}

function boundedErrorText(value: string, maxCharacters: number, fallback: string): string {
  const normalized = value.replace(/[\0\r\n]+/g, " ").trim().slice(0, maxCharacters);
  return normalized || fallback;
}

function sanitizeErrorDetails(value: unknown): Readonly<Record<string, string | number | boolean>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries: Array<readonly [string, string | number | boolean]> = [];
  for (const [key, detail] of Object.entries(value).slice(0, 32)) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) continue;
    if (typeof detail === "string") entries.push([key, boundedErrorText(detail, 1_024, "unknown")]);
    else if (typeof detail === "boolean") entries.push([key, detail]);
    else if (typeof detail === "number" && Number.isFinite(detail)) entries.push([key, detail]);
  }
  return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : undefined;
}

function isPromptAdmissionStatus(
  value: unknown,
): value is NonNullable<SerializedResidentWorkerError["status"]> {
  return value === "cancelled" || value === "owned" || value === "unknown" || value === "unsupported";
}
