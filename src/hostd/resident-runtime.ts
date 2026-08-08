import { z } from "zod";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ResidentProjectionSnapshot } from "./resident-projection";

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
  runtimeBuildId: "be9e2fa-dirty",
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
 * its daemon launcher. In v0.7.0 the old `daemon` command is explicitly
 * rejected; the documented `--mode daemon --daemon-socket` CLI mode is the
 * launch boundary. The adapter validates daemon_hello and performs
 * create/attach via DaemonClient. A resident session is never created through
 * RPC mode because RPC creates a client-owned worker whose lifetime follows the
 * client.
 */
export const RESIDENT_RUNTIME_LAUNCH_STRATEGY = Object.freeze({
  daemonStart: "pinned_cli_daemon_mode",
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
  | "PRIME_RUNTIME_SOCKET_MISMATCH"
  | "PRIME_RUNTIME_CAPABILITY_MISSING"
  | "PRIME_RUNTIME_IDENTITY_MISMATCH"
  | "PRIME_RUNTIME_ARGUMENT_INVALID"
  | "PRIME_RUNTIME_MODULE_INVALID"
  | "PRIME_RUNTIME_UNAVAILABLE"
  | "PRIME_RUNTIME_DAEMON_START_FAILED"
  | "PRIME_RUNTIME_RESPONSE_INVALID"
  | "PRIME_RUNTIME_REQUEST_FAILED"
  | "PRIME_RUNTIME_MUTATION_OUTCOME_UNKNOWN"
  | "PRIME_RUNTIME_SESSION_NOT_FOUND"
  | "PRIME_RUNTIME_SESSION_MISMATCH"
  | "PRIME_RUNTIME_BINDING_INVALID"
  | "PRIME_RUNTIME_BINDING_PERSIST_FAILED"
  | "PRIME_RUNTIME_PROJECTION_PERSIST_FAILED"
  | "PRIME_RUNTIME_PROMPT_RECONCILIATION_INVALID"
  | "PRIME_RUNTIME_PROMPT_RECONCILIATION_AUTHORITY_CHANGED"
  | "PRIME_RUNTIME_ABORT_RECONCILIATION_INVALID"
  | "PRIME_RUNTIME_ABORT_RECONCILIATION_AUTHORITY_CHANGED"
  | "PRIME_RUNTIME_ABORT_IDLE_NOT_OBSERVED"
  | "PRIME_RUNTIME_PROMPT_IDLE_NOT_OBSERVED"
  | "PRIME_RUNTIME_DISPATCH_LEASE_INVALID"
  | "PRIME_RUNTIME_DISPATCH_AUTHORITY_CHANGED"
  | "PRIME_RUNTIME_DISPATCH_RETIRED"
  | "COMMAND_ID_REUSED"
  | "PRIME_RUNTIME_DISPATCH_IDENTITY_LIMIT"
  | "PRIME_RUNTIME_ADAPTER_CLOSED"
  | "PRIME_RUNTIME_TERMINAL_ACTION_CONFLICT";

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
    buildId: z.literal(PINNED_PRIME_AGENT_RUNTIME.runtimeBuildId),
    executablePath: BoundedWireStringSchema,
    entrypointPath: BoundedWireStringSchema,
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
    runtime: DaemonRuntimeIdentitySchema,
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
  readonly runtimeBuildId: typeof PINNED_PRIME_AGENT_RUNTIME.runtimeBuildId;
  readonly supervisorGeneration?: string;
}

/**
 * Validate before listing, creating, or attaching sessions. Every mismatch is
 * terminal for this exact adapter and becomes an explicit upgrade/reinstall
 * path instead of best-effort protocol use.
 */
export function validateResidentDaemonHello(
  value: unknown,
  options: {
    expectedSocketPath?: string;
    expectedExecutablePath?: string;
    expectedEntrypointPath?: string;
  } = {},
): ResidentRuntimeCompatibility {
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
  if (options.expectedSocketPath !== undefined && hello.socketPath !== options.expectedSocketPath) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_SOCKET_MISMATCH",
      "Prime Agent daemon handshake belongs to a different local endpoint.",
      {
        details: {
          field: "socketPath",
          expected: options.expectedSocketPath,
          received: hello.socketPath,
        },
      },
    );
  }
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

  const runtimePathMismatches: string[] = [];
  if (
    options.expectedExecutablePath !== undefined &&
    !sameExecutionPath(hello.runtime.executablePath, options.expectedExecutablePath)
  ) {
    runtimePathMismatches.push("executablePath");
  }
  if (
    options.expectedEntrypointPath !== undefined &&
    !sameExecutionPath(hello.runtime.entrypointPath, options.expectedEntrypointPath)
  ) {
    runtimePathMismatches.push("entrypointPath");
  }
  if (runtimePathMismatches.length > 0) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_IDENTITY_MISMATCH",
      "Prime Agent daemon was not launched from the verified runtime paths.",
      { details: { fields: runtimePathMismatches.join(",") } },
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
    runtimeBuildId: hello.runtime.buildId,
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
  readonly argv: readonly [string, "--mode", "daemon", "--daemon-socket", string];
  readonly spawn: Readonly<{
    shell: false;
    windowsHide: true;
    detached: true;
    cwd: string;
    env: Readonly<Record<string, string>>;
    stdio: "ignore";
  }>;
}

/** Build a fixed argv vector; callers must pass it directly to spawn(). */
export function buildResidentDaemonStartInvocation(input: {
  executable: string;
  /** Verified package CLI entrypoint; launch it through a real Node executable. */
  cliEntrypoint: string;
  socketPath: string;
  /** Stable, writable host-owned directory; never inherit the caller's cwd. */
  daemonWorkingDirectory: string;
  /** Defaults to process.env and is stripped of inherited runtime role state. */
  environment?: Readonly<NodeJS.ProcessEnv>;
}): ResidentDaemonStartInvocation {
  const executable = boundedAbsolutePath(input.executable, "executable");
  const cliEntrypoint = boundedAbsolutePath(input.cliEntrypoint, "cliEntrypoint");
  const socketPath = boundedAbsolutePath(input.socketPath, "socketPath");
  const daemonWorkingDirectory = boundedAbsolutePath(input.daemonWorkingDirectory, "daemonWorkingDirectory");
  return Object.freeze({
    executable,
    argv: Object.freeze([cliEntrypoint, "--mode", "daemon", "--daemon-socket", socketPath] as const),
    spawn: Object.freeze({
      shell: false,
      windowsHide: true,
      detached: true,
      cwd: daemonWorkingDirectory,
      env: sanitizeResidentDaemonEnvironment(input.environment ?? process.env),
      stdio: "ignore" as const,
    } as const),
  });
}

/**
 * A supervisor must never inherit a worker/catalog role from the process that
 * happens to launch it. NODE_OPTIONS and NODE_PATH are also excluded so the
 * hash-verified entrypoint cannot be preloaded or resolution-shadowed.
 */
export function sanitizeResidentDaemonEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (
      normalized.startsWith("PRIME_AGENT_INTERNAL_") ||
      normalized === "PRIME_AGENT_BUILD_ID" ||
      normalized === "PRIME_AGENT_LAUNCHER_PATH" ||
      normalized === "NODE_OPTIONS" ||
      normalized === "NODE_PATH"
    ) {
      continue;
    }
    if (normalized === "ELECTRON_RUN_AS_NODE" && value !== "1") continue;
    sanitized[key] = value;
  }
  return Object.freeze(sanitized);
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

const ResidentRuntimeCompatibilitySchema = z
  .object({
    releaseVersion: z.literal(PINNED_PRIME_AGENT_RUNTIME.releaseVersion),
    appVersion: z.literal(PINNED_PRIME_AGENT_RUNTIME.expectedAppVersion),
    protocolName: z.literal(PINNED_PRIME_AGENT_RUNTIME.daemon.protocolName),
    protocolVersion: z.literal(PINNED_PRIME_AGENT_RUNTIME.daemon.protocolVersion),
    schemaRevision: z.literal(PINNED_PRIME_AGENT_RUNTIME.daemon.schemaRevision),
    schemaId: z.literal(PINNED_PRIME_AGENT_RUNTIME.daemon.schemaId),
    capabilities: z
      .array(z.string().min(1).max(128))
      .min(REQUIRED_RESIDENT_DAEMON_CAPABILITIES.length)
      .max(128)
      .refine((capabilities) => new Set(capabilities).size === capabilities.length, {
        message: "Runtime capabilities must be unique",
      })
      .refine(
        (capabilities) => REQUIRED_RESIDENT_DAEMON_CAPABILITIES.every((capability) => capabilities.includes(capability)),
        { message: "Runtime capabilities do not satisfy resident continuity" },
      ),
    runtimeBuildId: z.literal(PINNED_PRIME_AGENT_RUNTIME.runtimeBuildId),
    supervisorGeneration: z.string().min(1).max(256).optional(),
  })
  .strict();

export const ResidentSessionBindingSchema = z
  .object({
    bindingVersion: z.literal(1),
    lifecycle: z.literal("resident"),
    threadId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    executionGenerationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    workspaceDirectory: BoundedWireStringSchema,
    activeSessionId: BoundedWireStringSchema,
    sessionId: BoundedWireStringSchema,
    sessionFile: BoundedWireStringSchema.optional(),
    boundAt: z
      .string()
      .min(20)
      .max(40)
      .refine((value) => Number.isFinite(Date.parse(value)), "Binding time must be an ISO date-time"),
    runtime: ResidentRuntimeCompatibilitySchema,
  })
  .strict();

/** Validate durable data before it can select or attach an upstream session. */
export function validateResidentSessionBinding(value: unknown): ResidentSessionBinding {
  const parsed = ResidentSessionBindingSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "binding"}: ${issue.message}`)
      .join("; ")
      .slice(0, 2_048);
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_BINDING_INVALID",
      "The durable resident session binding is invalid.",
      { details: { issues } },
    );
  }
  return Object.freeze({
    ...parsed.data,
    runtime: Object.freeze({
      ...parsed.data.runtime,
      capabilities: Object.freeze([...parsed.data.runtime.capabilities]),
    }),
  });
}

export type ResidentDispatchOperation = "prompt" | "abort";

/**
 * Ephemeral capability minted only after hostd has durably moved a resident
 * dispatch attempt to its non-replayable dispatching state. Carrying the full
 * binding makes the capability generation- and session-specific; the adapter
 * never infers authority from its currently attached connection.
 */
export interface ResidentGenerationDispatchLease {
  readonly leaseVersion: 1;
  readonly dispatchAttemptId: string;
  /** SHA-256 of the schema-normalized full host command envelope. */
  readonly commandFingerprint: string;
  readonly operation: ResidentDispatchOperation;
  readonly binding: ResidentSessionBinding;
}

const ResidentGenerationDispatchLeaseSchema = z
  .object({
    leaseVersion: z.literal(1),
    dispatchAttemptId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    commandFingerprint: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    operation: z.enum(["prompt", "abort"]),
    binding: ResidentSessionBindingSchema,
  })
  .strict();

/** Validate and deeply freeze the private host-to-adapter dispatch capability. */
export function validateResidentGenerationDispatchLease(value: unknown): ResidentGenerationDispatchLease {
  const parsed = ResidentGenerationDispatchLeaseSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "lease"}: ${issue.message}`)
      .join("; ")
      .slice(0, 2_048);
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_DISPATCH_LEASE_INVALID",
      "The durable resident dispatch lease is invalid.",
      { details: { issues } },
    );
  }
  return Object.freeze({
    leaseVersion: 1,
    dispatchAttemptId: parsed.data.dispatchAttemptId,
    commandFingerprint: parsed.data.commandFingerprint.toLowerCase(),
    operation: parsed.data.operation,
    binding: validateResidentSessionBinding(parsed.data.binding),
  });
}

/**
 * A resolved mutation reports only upstream ownership of the request. Agent
 * turn completion and abort completion are observed later through projections.
 */
export type ResidentDispatchResult =
  | Readonly<{
      operation: ResidentDispatchOperation;
      disposition: "accepted";
      completion: "not_observed";
    }>
  | Readonly<{
      operation: "abort";
      disposition: "not_needed";
      completion: "not_observed";
      reason: "prompt_admission_cancelled";
    }>;

/**
 * Exact, read-only request passed only after HostStore validates its opaque
 * acknowledged-prompt reconciliation lease. This structural form never grants
 * durable authority by itself; the resident adapter's public entry point owns
 * that capability check.
 */
export interface ResidentPromptIdleReconciliationRequest {
  readonly reconciliationVersion: 1;
  readonly dispatchAttemptId: string;
  readonly binding: ResidentSessionBinding;
}

/**
 * Same-connection evidence that Prime Agent crossed its public idle barrier and
 * that the resulting exact-binding idle projection was durably published.
 */
export interface ResidentPromptIdleAuthorityEvidence {
  readonly evidenceVersion: 1;
  readonly dispatchAttemptId: string;
  readonly binding: ResidentSessionBinding;
  readonly projection: ResidentProjectionSnapshot;
}

/**
 * Exact, read-only request for reconciling one already-acknowledged resident
 * Stop. It never grants mutation authority and is valid only on the same
 * attached Prime connection that accepted the abort.
 */
export interface ResidentAbortIdleReconciliationRequest {
  readonly reconciliationVersion: 1;
  readonly dispatchAttemptId: string;
  readonly binding: ResidentSessionBinding;
}

/** Same-connection evidence that an acknowledged Stop reached authoritative idle. */
export interface ResidentAbortIdleAuthorityEvidence {
  readonly evidenceVersion: 1;
  readonly dispatchAttemptId: string;
  readonly binding: ResidentSessionBinding;
  readonly projection: ResidentProjectionSnapshot;
}

const ResidentPromptIdleReconciliationRequestSchema = z
  .object({
    reconciliationVersion: z.literal(1),
    dispatchAttemptId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    binding: ResidentSessionBindingSchema,
  })
  .strict();

const ResidentAbortIdleReconciliationRequestSchema = z
  .object({
    reconciliationVersion: z.literal(1),
    dispatchAttemptId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    binding: ResidentSessionBindingSchema,
  })
  .strict();

export function validateResidentPromptIdleReconciliationRequest(
  value: unknown,
): ResidentPromptIdleReconciliationRequest {
  const parsed = ResidentPromptIdleReconciliationRequestSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
      .join("; ")
      .slice(0, 2_048);
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_PROMPT_RECONCILIATION_INVALID",
      "The acknowledged resident prompt idle-reconciliation request is invalid.",
      { details: { issues } },
    );
  }
  return Object.freeze({
    reconciliationVersion: 1,
    dispatchAttemptId: parsed.data.dispatchAttemptId,
    binding: validateResidentSessionBinding(parsed.data.binding),
  });
}

export function validateResidentAbortIdleReconciliationRequest(
  value: unknown,
): ResidentAbortIdleReconciliationRequest {
  const parsed = ResidentAbortIdleReconciliationRequestSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
      .join("; ")
      .slice(0, 2_048);
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_ABORT_RECONCILIATION_INVALID",
      "The acknowledged resident Stop idle-reconciliation request is invalid.",
      { details: { issues } },
    );
  }
  return Object.freeze({
    reconciliationVersion: 1,
    dispatchAttemptId: parsed.data.dispatchAttemptId,
    binding: validateResidentSessionBinding(parsed.data.binding),
  });
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
  /** Resolve when Prime Agent owns the prompt, never when the turn completes. */
  prompt(message: string, lease: ResidentGenerationDispatchLease): Promise<ResidentDispatchResult>;
  /** Resolve when Prime Agent accepts the abort request, never when the turn has stopped. */
  abort(lease: ResidentGenerationDispatchLease): Promise<ResidentDispatchResult>;
  /**
   * Cross Prime Agent's public idle barrier and publish a fresh exact-binding
   * idle projection. The adapter admits this only from a Store-branded lease.
   */
  reconcileAcknowledgedPromptIdle(
    request: ResidentPromptIdleReconciliationRequest,
  ): Promise<ResidentPromptIdleAuthorityEvidence>;
  /** Cross the same public idle barrier after one acknowledged Stop. */
  reconcileAcknowledgedAbortIdle(
    request: ResidentAbortIdleReconciliationRequest,
  ): Promise<ResidentAbortIdleAuthorityEvidence>;
  /** Detach the client-side connection without stopping the resident worker. */
  detach(): Promise<void>;
  /** Stop the resident worker only after an explicit user-facing end action. */
  endSession(): Promise<void>;
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

function boundedAbsolutePath(value: string, field: string): string {
  const path = boundedArgument(value, field);
  if (!isAbsolute(path)) {
    throw new ResidentRuntimeContractError(
      "PRIME_RUNTIME_ARGUMENT_INVALID",
      `Resident runtime ${field} must be absolute.`,
      { details: { field } },
    );
  }
  return path;
}

function sameExecutionPath(left: string, right: string): boolean {
  const normalizedLeft = resolvePath(left);
  const normalizedRight = resolvePath(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
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
