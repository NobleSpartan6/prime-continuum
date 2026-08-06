import { z } from "zod";

const PRIME_AGENT_RELEASE_BASE_URL = "https://github.com/PrimeIntellect-ai/prime-agent/releases/download";

/**
 * Immutable runtime identity approved for the first resident-session adapter.
 *
 * The release is deliberately exact rather than semver-ranged: daemon wire
 * types are local Prime Agent contracts, not a stable hosted API. Installation
 * code must verify the archive before extracting or installing it.
 */
export const PINNED_PRIME_AGENT_RUNTIME = Object.freeze({
  repository: "https://github.com/PrimeIntellect-ai/prime-agent",
  releaseTag: "v0.7.0",
  releaseVersion: "0.7.0",
  packageName: "prime-agent",
  assetFileName: "prime-agent-0.7.0.tgz",
  assetUrl: `${PRIME_AGENT_RELEASE_BASE_URL}/v0.7.0/prime-agent-0.7.0.tgz`,
  sha256: "88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b",
  expectedAppVersion: "0.7.0",
  daemon: Object.freeze({
    protocolName: "prime-agent.daemon",
    protocolVersion: 7,
    schemaRevision: 13,
    schemaId: "protocol-7-schema-13-816309b1cd50",
  }),
} as const);

/** Capabilities required before hostd may claim authoritative resident continuity. */
export const REQUIRED_RESIDENT_DAEMON_CAPABILITIES = Object.freeze([
  "attach_snapshot",
  "event_sequence",
  "slim_attach",
  "chunked_snapshot",
] as const);

/**
 * The published package exposes DaemonClient and DaemonAgentConnection but not
 * its daemon launcher. The adapter therefore uses the supported `daemon start`
 * CLI boundary, validates daemon_hello, and performs create/attach via
 * DaemonClient. A resident session is never created through RPC mode because
 * RPC creates a client-owned worker whose lifetime follows the client.
 */
export const RESIDENT_RUNTIME_LAUNCH_STRATEGY = Object.freeze({
  daemonStart: "pinned_cli_daemon_start",
  sessionCreate: "daemon_client",
  sessionAttach: "daemon_agent_connection",
  sessionLifecycle: "resident",
  shell: false,
} as const);

export type ResidentRuntimeContractErrorCode =
  | "PRIME_RUNTIME_HELLO_INVALID"
  | "PRIME_RUNTIME_APP_VERSION_MISMATCH"
  | "PRIME_RUNTIME_PROTOCOL_NAME_MISMATCH"
  | "PRIME_RUNTIME_PROTOCOL_VERSION_MISMATCH"
  | "PRIME_RUNTIME_SCHEMA_REVISION_MISMATCH"
  | "PRIME_RUNTIME_SCHEMA_ID_MISMATCH"
  | "PRIME_RUNTIME_CAPABILITY_MISSING"
  | "PRIME_RUNTIME_ARGUMENT_INVALID";

export type ResidentRuntimeErrorDetails = Readonly<Record<string, string | number | boolean>>;

export interface ResidentRuntimeStructuredError {
  readonly code: ResidentRuntimeContractErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: ResidentRuntimeErrorDetails;
}

export class ResidentRuntimeContractError extends Error {
  readonly code: ResidentRuntimeContractErrorCode;
  readonly retryable: boolean;
  readonly details?: ResidentRuntimeErrorDetails;

  constructor(
    code: ResidentRuntimeContractErrorCode,
    message: string,
    options: { retryable?: boolean; details?: ResidentRuntimeErrorDetails; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ResidentRuntimeContractError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ? Object.freeze({ ...options.details }) : undefined;
  }

  toJSON(): ResidentRuntimeStructuredError {
    return Object.freeze({
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    });
  }
}

const BoundedWireStringSchema = z.string().min(1).max(4_096);
const DaemonRuntimeIdentitySchema = z
  .object({
    buildId: z.string().min(1).max(256),
    executablePath: BoundedWireStringSchema,
    entrypointPath: BoundedWireStringSchema.optional(),
    launcherPath: BoundedWireStringSchema.optional(),
  })
  .strict();

/** Exact daemon_hello shape emitted by the pinned v0.7.0 runtime. */
const PinnedDaemonHelloSchema = z
  .object({
    type: z.literal("daemon_hello"),
    socketPath: BoundedWireStringSchema,
    protocol: z
      .object({
        name: z.string().min(1).max(128),
        version: z.number().int().nonnegative().max(1_000_000),
      })
      .strict(),
    schemaId: z.string().min(1).max(256),
    schemaRevision: z.number().int().nonnegative().max(1_000_000),
    appVersion: z.string().min(1).max(64),
    runtime: DaemonRuntimeIdentitySchema.optional(),
    supervisorGeneration: z.string().min(1).max(256).optional(),
    supervisorPid: z.number().int().positive().max(2_147_483_647).optional(),
    supervisorOwnerToken: z.string().min(1).max(512).optional(),
    supervisorProcessStartId: z.string().min(1).max(512).optional(),
    supervisorSocketPath: BoundedWireStringSchema.optional(),
    clientId: z.string().min(1).max(256),
    serverCapabilities: z
      .array(z.string().min(1).max(128))
      .max(128)
      .refine((capabilities) => new Set(capabilities).size === capabilities.length, {
        message: "Daemon capabilities must be unique",
      }),
  })
  .strict();

/** Sanitized host-owned compatibility result; no upstream daemon DTO escapes. */
export interface ResidentRuntimeCompatibility {
  readonly releaseVersion: typeof PINNED_PRIME_AGENT_RUNTIME.releaseVersion;
  readonly appVersion: typeof PINNED_PRIME_AGENT_RUNTIME.expectedAppVersion;
  readonly protocolName: typeof PINNED_PRIME_AGENT_RUNTIME.daemon.protocolName;
  readonly protocolVersion: typeof PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion;
  readonly schemaRevision: typeof PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision;
  readonly schemaId: typeof PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId;
  readonly capabilities: readonly string[];
  readonly runtimeBuildId?: string;
  readonly supervisorGeneration?: string;
}

/**
 * Validate before listing, creating, or attaching sessions. Every mismatch is
 * terminal for this exact adapter and becomes an explicit upgrade/reinstall
 * path instead of best-effort protocol use.
 */
export function validateResidentDaemonHello(value: unknown): ResidentRuntimeCompatibility {
  const parsed = PinnedDaemonHelloSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "hello"}: ${issue.message}`)
      .join("; ")
      .slice(0, 2_048);
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_HELLO_INVALID",
      "Prime Agent returned an invalid daemon handshake.",
      { details: { issues } },
    );
  }

  const hello = parsed.data;
  const expected = PINNED_PRIME_AGENT_RUNTIME;
  assertExact(
    hello.protocol.name,
    expected.daemon.protocolName,
    "PRIME_RUNTIME_PROTOCOL_NAME_MISMATCH",
    "Prime Agent daemon protocol name does not match the pinned runtime.",
    "protocolName",
  );
  assertExact(
    hello.protocol.version,
    expected.daemon.protocolVersion,
    "PRIME_RUNTIME_PROTOCOL_VERSION_MISMATCH",
    "Prime Agent daemon protocol version does not match the pinned runtime.",
    "protocolVersion",
  );
  assertExact(
    hello.appVersion,
    expected.expectedAppVersion,
    "PRIME_RUNTIME_APP_VERSION_MISMATCH",
    "Prime Agent app version does not match the pinned runtime.",
    "appVersion",
  );
  assertExact(
    hello.schemaRevision,
    expected.daemon.schemaRevision,
    "PRIME_RUNTIME_SCHEMA_REVISION_MISMATCH",
    "Prime Agent daemon schema revision does not match the pinned runtime.",
    "schemaRevision",
  );
  assertExact(
    hello.schemaId,
    expected.daemon.schemaId,
    "PRIME_RUNTIME_SCHEMA_ID_MISMATCH",
    "Prime Agent daemon schema identity does not match the pinned runtime.",
    "schemaId",
  );

  const availableCapabilities = new Set(hello.serverCapabilities);
  const missingCapabilities = REQUIRED_RESIDENT_DAEMON_CAPABILITIES.filter(
    (capability) => !availableCapabilities.has(capability),
  );
  if (missingCapabilities.length > 0) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_CAPABILITY_MISSING",
      "Prime Agent daemon is missing capabilities required for resident continuity.",
      { details: { missingCapabilities: missingCapabilities.join(",") } },
    );
  }

  return Object.freeze({
    releaseVersion: expected.releaseVersion,
    appVersion: expected.expectedAppVersion,
    protocolName: expected.daemon.protocolName,
    protocolVersion: expected.daemon.protocolVersion,
    schemaRevision: expected.daemon.schemaRevision,
    schemaId: expected.daemon.schemaId,
    capabilities: Object.freeze([...hello.serverCapabilities]),
    ...(hello.runtime ? { runtimeBuildId: hello.runtime.buildId } : {}),
    ...(hello.supervisorGeneration ? { supervisorGeneration: hello.supervisorGeneration } : {}),
  });
}

function assertExact<T extends string | number>(
  received: T,
  expected: T,
  code: ResidentRuntimeContractErrorCode,
  message: string,
  field: string,
): void {
  if (received === expected) return;
  throw new ResidentRuntimeContractError(code, message, {
    details: { field, expected, received },
  });
}

export interface ResidentDaemonStartInvocation {
  readonly executable: string;
  readonly argv: readonly ["daemon", "start", "--socket", string];
  readonly spawn: Readonly<{
    shell: false;
    windowsHide: true;
    stdio: readonly ["ignore", "pipe", "pipe"];
  }>;
}

/** Build a fixed argv vector; callers must pass it directly to spawn(). */
export function buildResidentDaemonStartInvocation(input: {
  executable?: string;
  socketPath: string;
}): ResidentDaemonStartInvocation {
  const executable = boundedArgument(input.executable ?? "prime-agent", "executable");
  const socketPath = boundedArgument(input.socketPath, "socketPath");
  return Object.freeze({
    executable,
    argv: Object.freeze(["daemon", "start", "--socket", socketPath] as const),
    spawn: Object.freeze({
      shell: false,
      windowsHide: true,
      stdio: Object.freeze(["ignore", "pipe", "pipe"] as const),
    } as const),
  });
}

export type ResidentSessionSelection =
  | Readonly<{ kind: "new" }>
  | Readonly<{ kind: "continue_recent" }>
  | Readonly<{ kind: "resume"; sessionPath: string }>;

export interface ResidentSessionCreateInput {
  readonly threadId: string;
  readonly executionGenerationId: string;
  readonly workspaceDirectory: string;
  readonly session?: ResidentSessionSelection;
  readonly sessionName?: string;
}

/** Narrow adapter-private command passed to the pinned package's DaemonClient. */
export interface ResidentDaemonCreateRequest {
  readonly type: "create";
  readonly config: Readonly<{ cwd: string }>;
  readonly lifecycle: "resident";
  readonly noSession: false;
  readonly sessionPath?: string;
  readonly continueRecent?: true;
  readonly name?: string;
}

/**
 * Resident creation is a DaemonClient request, not a CLI/RPC invocation. This
 * preserves the worker after the GUI or SSH transport detaches.
 */
export function buildResidentDaemonCreateRequest(input: ResidentSessionCreateInput): ResidentDaemonCreateRequest {
  boundedOpaqueId(input.threadId, "threadId");
  boundedOpaqueId(input.executionGenerationId, "executionGenerationId");
  const workspaceDirectory = boundedArgument(input.workspaceDirectory, "workspaceDirectory");
  const session = input.session ?? { kind: "new" };
  const sessionName = input.sessionName === undefined ? undefined : boundedSessionName(input.sessionName);

  return Object.freeze({
    type: "create",
    config: Object.freeze({ cwd: workspaceDirectory }),
    lifecycle: "resident",
    noSession: false,
    ...(session.kind === "resume" ? { sessionPath: boundedArgument(session.sessionPath, "sessionPath") } : {}),
    ...(session.kind === "continue_recent" ? { continueRecent: true as const } : {}),
    ...(sessionName ? { name: sessionName } : {}),
  });
}

/** Persisted only by hostd; local paths and daemon identities never enter public projections. */
export interface ResidentSessionBinding {
  readonly bindingVersion: 1;
  readonly lifecycle: "resident";
  readonly threadId: string;
  readonly executionGenerationId: string;
  readonly workspaceDirectory: string;
  readonly activeSessionId: string;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly boundAt: string;
  readonly runtime: ResidentRuntimeCompatibility;
}

export type ResidentRuntimeLifecycleState =
  | "idle"
  | "starting_daemon"
  | "validating_daemon"
  | "creating_resident"
  | "attaching"
  | "ready"
  | "reconnecting"
  | "detaching"
  | "closed"
  | "failed";

export interface ResidentRuntimeLifecycleSnapshot {
  readonly state: ResidentRuntimeLifecycleState;
  readonly changedAt: string;
  readonly binding?: ResidentSessionBinding;
  readonly error?: ResidentRuntimeStructuredError;
}

export type ResidentRuntimeLifecycleListener = (snapshot: ResidentRuntimeLifecycleSnapshot) => void;

/** Host-owned connection handle. It intentionally exposes no upstream state or event DTO. */
export interface ResidentRuntimeConnection {
  readonly binding: ResidentSessionBinding;
  getLifecycle(): ResidentRuntimeLifecycleSnapshot;
  subscribeLifecycle(listener: ResidentRuntimeLifecycleListener): () => void;
  /** Detach the client-side connection without stopping the resident worker. */
  detach(): Promise<void>;
}

/**
 * Composition seam for a later concrete wrapper around DaemonClient and
 * DaemonAgentConnection. This contract alone never starts or attaches a runtime.
 */
export interface ResidentRuntimeAdapter {
  getLifecycle(): ResidentRuntimeLifecycleSnapshot;
  subscribeLifecycle(listener: ResidentRuntimeLifecycleListener): () => void;
  ensureDaemon(invocation: ResidentDaemonStartInvocation): Promise<ResidentRuntimeCompatibility>;
  createResident(input: ResidentSessionCreateInput): Promise<ResidentRuntimeConnection>;
  attachResident(binding: ResidentSessionBinding): Promise<ResidentRuntimeConnection>;
  close(): Promise<void>;
}

function boundedArgument(value: string, field: string): string {
  if (value.length < 1 || value.length > 4_096 || /[\0\r\n]/.test(value)) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_ARGUMENT_INVALID",
      `Resident runtime ${field} is invalid.`,
      { details: { field } },
    );
  }
  return value;
}

function boundedOpaqueId(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_ARGUMENT_INVALID",
      `Resident runtime ${field} is invalid.`,
      { details: { field } },
    );
  }
  return value;
}

function boundedSessionName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 255 || /[\0\r\n]/.test(name)) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_ARGUMENT_INVALID",
      "Resident runtime sessionName is invalid.",
      { details: { field: "sessionName" } },
    );
  }
  return name;
}
