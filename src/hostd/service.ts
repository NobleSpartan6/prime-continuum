import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  HostIpcRequestSchema,
  HostIpcResponseSchema,
  PROTOCOL_VERSION,
  RUNTIME_INTEGRITY_CAPABILITY,
  type HostIpcRequest,
  type HostIpcResponse,
  type HostIdentityReadiness,
  type RemoteDeviceScope,
  type RuntimeIntegritySnapshot,
  type StructuredError,
} from "../shared/protocol";
import { GatewayError, type PrimeAgentGateway, UnavailablePrimeAgentGateway } from "./gateway";
import {
  PairingAuthority,
  PairingAuthorityError,
  HostIdentityInputSchema,
  type AuthenticatedChannelLease,
} from "./pairing/authority";
import {
  UnavailableHostIdentityKeyProvider,
  type HostIdentityKeyProvider,
  type HostIdentityProviderLoadResult,
} from "./pairing/host-identity-provider";
import { HOSTD_VERSION } from "./paths";
import { HostStore, HostStoreError } from "./store";

// The durable store contains a single-process handoff harness for protocol and
// rollback testing. Production hostd must not advertise executable handoff
// until a destination transport/coordinator can materialize and verify state on
// the destination host itself.
export const HOST_CAPABILITIES = ["snapshot_chunks_v1"] as const;

const HANDOFF_COORDINATOR_WARNING = {
  code: "DESTINATION_TRANSFER_UNAVAILABLE",
  message: "Cross-host checkpoint transfer is deferred until the Phase 2 destination coordinator is installed.",
  blocking: true,
} as const;

const KNOWN_METHODS = new Set([
  "health.get",
  "catalog.snapshot",
  "thread.snapshot",
  "command.submit",
  "command.reconcile",
  "handoff.plan",
  "handoff.commit",
]);

export type HostSessionContext =
  | { transport: "trusted_user"; scopes: "*" }
  | {
      transport: "relay";
      channel: AuthenticatedChannelLease;
    };

export const TRUSTED_USER_SESSION: HostSessionContext = Object.freeze({
  transport: "trusted_user",
  scopes: "*",
});

const DEFAULT_IDENTITY_LOAD_TIMEOUT_MS = 5_000;

export interface HostServiceOptions {
  hostIdentityProvider?: HostIdentityKeyProvider;
  identityLoadTimeoutMs?: number;
  runtimeIntegrityProvider?: RuntimeIntegrityReadinessProvider;
}

export interface RuntimeIntegrityReadinessProvider {
  /** Returns the latest bounded snapshot synchronously without performing integrity work. */
  snapshot(): RuntimeIntegritySnapshot;
  /** Settles any background integrity work before endpoint ownership is released. */
  close?(): Promise<void>;
}

export class HostService {
  readonly store: HostStore;
  readonly gateway: PrimeAgentGateway;
  readonly pairingAuthority: PairingAuthority;
  readonly hostIdentityProvider: HostIdentityKeyProvider;
  private closePromise: Promise<void> | undefined;
  private readonly identityLoadTimeoutMs: number;
  private readonly runtimeIntegrityProvider: RuntimeIntegrityReadinessProvider | undefined;
  private hostIdentityProviderUsed = false;
  private pairingIdentity: HostIdentityReadiness = Object.freeze({ state: "not_configured" });
  readonly startedAt = new Date().toISOString();

  constructor(
    store: HostStore,
    gateway: PrimeAgentGateway = new UnavailablePrimeAgentGateway(),
    pairingAuthority: PairingAuthority = new PairingAuthority(store.paths.pairingAuthority),
    options: HostServiceOptions = {},
  ) {
    this.store = store;
    this.gateway = gateway;
    this.pairingAuthority = pairingAuthority;
    this.hostIdentityProvider = options.hostIdentityProvider ?? new UnavailableHostIdentityKeyProvider();
    this.identityLoadTimeoutMs = options.identityLoadTimeoutMs ?? DEFAULT_IDENTITY_LOAD_TIMEOUT_MS;
    this.runtimeIntegrityProvider = options.runtimeIntegrityProvider;
    if (!Number.isSafeInteger(this.identityLoadTimeoutMs) || this.identityLoadTimeoutMs < 10 || this.identityLoadTimeoutMs > 30_000) {
      throw new TypeError("Identity load timeout must be an integer from 10 to 30000 milliseconds");
    }
  }

  async initialize(options: { seed?: boolean } = {}): Promise<void> {
    await this.store.initialize(options);
    const host = await this.store.getHost();
    const authority = await this.pairingAuthority.initialize({ hostId: host.hostId });
    this.pairingIdentity = authority.identity
      ? await this.loadConfiguredHostIdentity(host.hostId, authority.identity)
      : Object.freeze({ state: "not_configured" });
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      const closeResults = await Promise.allSettled([
        Promise.resolve().then(() => this.runtimeIntegrityProvider?.close?.()),
        Promise.resolve().then(() => this.pairingAuthority.close()),
        Promise.resolve().then(() => (this.hostIdentityProviderUsed ? this.hostIdentityProvider.close() : undefined)),
        Promise.resolve().then(() => this.gateway.close()),
      ]);
      const failures = closeResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (failures.length > 0) {
        throw new AggregateError(failures, "One or more host service resources failed to close");
      }
    })();
    return this.closePromise;
  }

  async handle(value: unknown, context: HostSessionContext): Promise<HostIpcResponse> {
    const parsed = HostIpcRequestSchema.safeParse(value);
    if (!parsed.success) return invalidRequestResponse(value, parsed.error);
    const request = parsed.data;

    try {
      if (!context) {
        throw new HostStoreError(
          "SESSION_CONTEXT_REQUIRED",
          "Every host protocol request must identify its authenticated transport context.",
        );
      }
      const result = await this.authorizeAndDispatch(request, context);
      return HostIpcResponseSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: request.method,
        ok: true,
        result,
      });
    } catch (error) {
      return HostIpcResponseSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        method: request.method,
        ok: false,
        error: toStructuredError(error),
      });
    }
  }

  private async authorizeAndDispatch(request: HostIpcRequest, context: HostSessionContext): Promise<unknown> {
    if (context.transport === "trusted_user") return this.dispatch(request);
    if (this.pairingIdentity.state !== "ready") {
      throw new PairingAuthorityError(
        "REMOTE_IDENTITY_UNAVAILABLE",
        "Relay requests remain disabled until the configured host identity is verified by its custody provider",
      );
    }

    const requiredScope = scopeForRequest(request);
    return this.pairingAuthority.withAuthorizedChannel(context.channel, requiredScope, async (device) => {
      this.assertRelayRequestIdentity(request, device.deviceId);
      // Admission is linearized under the authority lock; dispatch runs after
      // the lock is released so revocation can commit while admitted work ends.
      return this.dispatch(request);
    });
  }

  private assertRelayRequestIdentity(request: HostIpcRequest, authenticatedDeviceId: string): void {
    if (request.method === "command.submit" && request.payload.command.deviceId !== authenticatedDeviceId) {
      throw new HostStoreError(
        "REMOTE_DEVICE_IDENTITY_MISMATCH",
        "The authenticated device cannot submit a command under another device identity.",
      );
    }
    if (
      request.method === "command.reconcile" &&
      request.payload.commands.some((command) => command.deviceId !== authenticatedDeviceId)
    ) {
      throw new HostStoreError(
        "REMOTE_DEVICE_IDENTITY_MISMATCH",
        "The authenticated device cannot reconcile another device's command identities.",
      );
    }
    if (request.method === "handoff.commit" && request.payload.deviceId !== authenticatedDeviceId) {
      throw new HostStoreError(
        "REMOTE_DEVICE_IDENTITY_MISMATCH",
        "The authenticated device cannot commit a handoff under another device identity.",
      );
    }
  }

  private async dispatch(request: HostIpcRequest): Promise<unknown> {
    switch (request.method) {
      case "health.get": {
        const host = await this.store.getHost();
        const runtimeIntegrity = this.runtimeIntegrityProvider?.snapshot();
        return {
          protocolVersion: PROTOCOL_VERSION,
          hostdVersion: HOSTD_VERSION,
          startedAt: this.startedAt,
          checkedAt: new Date().toISOString(),
          serviceState: runtimeIntegrity === undefined ? "ready" : serviceStateForRuntimeIntegrity(runtimeIntegrity),
          host,
          capabilities: runtimeIntegrity === undefined
            ? [...HOST_CAPABILITIES]
            : [...HOST_CAPABILITIES, RUNTIME_INTEGRITY_CAPABILITY],
          pairingIdentity: this.pairingIdentity,
          ...(runtimeIntegrity === undefined ? {} : { runtimeIntegrity }),
        };
      }
      case "catalog.snapshot":
        return this.store.getCatalogSnapshot();
      case "thread.snapshot":
        // A Phase 0 attach always returns an authoritative atomic snapshot. A
        // later replay adapter may use the supplied generation-aware cursor.
        return this.store.getThreadSnapshot(request.payload.threadId);
      case "command.submit": {
        const command = request.payload.command;
        const host = await this.store.getHost();
        if (command.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "The command was composed for a different host authority.",
          );
        }
        const catalog = await this.store.getCatalogSnapshot();
        const thread = catalog.threads.find((item) => item.threadId === command.threadId);
        const generationId =
          command.expectedExecutionGenerationId ?? thread?.currentLocation.executionGenerationId ?? "unknown-generation";
        const live = await this.gateway.isLive(command.threadId, generationId);
        const admission = await this.store.admitCommand(
          command,
          live,
          this.gateway instanceof UnavailablePrimeAgentGateway
            ? {
                code: "GATEWAY_UNAVAILABLE",
                message: "Prime Agent execution is not attached in this build; the command was not queued.",
                retryable: true,
              }
            : undefined,
        );
        if (admission.duplicate || admission.receipt.status !== "admitted" || !live) return admission.receipt;

        try {
          const gatewayAdmission = await this.gateway.submit(command);
          if (gatewayAdmission.disposition === "accepted") {
            return this.store.updateCommandReceipt(command, {
              status: "running",
              queuePosition: undefined,
              message: gatewayAdmission.message ?? "Prime Agent accepted the command",
            });
          }
          if (gatewayAdmission.disposition === "handled") {
            return this.store.updateCommandReceipt(command, {
              status: "completed",
              queuePosition: undefined,
              message: gatewayAdmission.message ?? "Prime Agent handled the command",
            });
          }
          return this.store.updateCommandReceipt(command, {
            status: "admitted",
            message: gatewayAdmission.message ?? "Queued by Prime Agent",
          });
        } catch (error) {
          const gatewayError = error instanceof GatewayError ? error : undefined;
          return this.store.updateCommandReceipt(command, {
            status: gatewayError?.uncertain ? "uncertain" : "failed",
            queuePosition: undefined,
            message: gatewayError?.message ?? "Prime Agent gateway failed",
            error: {
              code: gatewayError?.code ?? "GATEWAY_FAILED",
              message: gatewayError?.message ?? "Prime Agent gateway failed",
              retryable: gatewayError?.retryable ?? true,
            },
          });
        }
      }
      case "command.reconcile": {
        const host = await this.store.getHost();
        if (request.payload.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "The reconciliation identities belong to a different host authority.",
          );
        }
        return this.store.reconcileCommands(request.payload.commands);
      }
      case "handoff.plan": {
        const host = await this.store.getHost();
        if (request.payload.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "The handoff plan was requested from a different source host authority.",
          );
        }
        const plan = await this.store.createHandoffPlan(request.payload.request);
        return {
          ...plan,
          executable: false,
          warnings: [
            ...plan.warnings.filter((warning) => warning.code !== HANDOFF_COORDINATOR_WARNING.code),
            HANDOFF_COORDINATOR_WARNING,
          ],
        };
      }
      case "handoff.commit": {
        const host = await this.store.getHost();
        if (request.payload.expectedHostId !== host.hostId) {
          throw new HostStoreError(
            "HOST_AUTHORITY_MISMATCH",
            "The handoff commit belongs to a different source host authority.",
          );
        }
        throw new HostStoreError(
          "HANDOFF_COORDINATOR_UNAVAILABLE",
          "Cross-host handoff cannot commit until the Phase 2 destination coordinator is installed.",
        );
      }
    }
  }

  private async loadConfiguredHostIdentity(
    hostId: string,
    expected: Readonly<NonNullable<Awaited<ReturnType<PairingAuthority["getSnapshot"]>>["identity"]>>,
  ): Promise<HostIdentityReadiness> {
    const controller = new AbortController();
    this.hostIdentityProviderUsed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: "timeout" }>((resolvePromise) => {
      timer = setTimeout(() => {
        controller.abort(new Error("Host identity provider timed out"));
        resolvePromise({ kind: "timeout" });
      }, this.identityLoadTimeoutMs);
      timer.unref?.();
    });
    const provider = Promise.resolve()
      .then(() => this.hostIdentityProvider.loadExisting({ hostId, expected, signal: controller.signal }))
      .then(
        (result): { kind: "result"; result: unknown } => ({ kind: "result", result }),
        (): { kind: "error" } => ({ kind: "error" }),
      );
    const outcome = await Promise.race([provider, timeout]);
    if (timer) clearTimeout(timer);

    if (outcome.kind === "timeout") {
      return Object.freeze({
        state: "unavailable",
        code: "provider_timeout",
        recoveryAction: "restart_host_service",
      });
    }
    if (outcome.kind === "error") {
      return Object.freeze({
        state: "unavailable",
        code: "provider_error",
        recoveryAction: "restart_host_service",
      });
    }
    const result = parseHostIdentityProviderResult(outcome.result);
    if (!result) {
      return Object.freeze({
        state: "unavailable",
        code: "provider_error",
        recoveryAction: "restart_host_service",
      });
    }
    if (result.status === "unavailable") {
      return Object.freeze({
        state: "unavailable",
        code: result.code,
        recoveryAction: result.recoveryAction,
      });
    }
    if (result.hostId !== hostId) {
      return Object.freeze({
        state: "unavailable",
        code: "metadata_mismatch",
        recoveryAction: "review_identity",
      });
    }

    try {
      const verified = await this.pairingAuthority.initialize({ hostId, identity: result.identity });
      const identity = verified.identity;
      if (!identity || identity.secretRef !== expected.secretRef || identity.fingerprint !== expected.fingerprint) {
        throw new Error("Provider identity does not match durable authority metadata");
      }
      return Object.freeze({
        state: "ready",
        algorithm: identity.algorithm,
        fingerprint: identity.fingerprint,
        identityEpoch: identity.identityEpoch,
      });
    } catch {
      return Object.freeze({
        state: "unavailable",
        code: "metadata_mismatch",
        recoveryAction: "review_identity",
      });
    }
  }
}

const PROVIDER_UNAVAILABLE_CODES = new Set([
  "provider_not_installed",
  "credential_missing",
  "credential_locked",
  "credential_inaccessible",
  "credential_corrupt",
]);
const PROVIDER_RECOVERY_ACTIONS = new Set([
  "install_provider",
  "restore_identity",
  "unlock_credentials",
  "repair_permissions",
  "review_identity",
]);

function parseHostIdentityProviderResult(value: unknown): HostIdentityProviderLoadResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value.status === "ready") {
    if (typeof value.hostId !== "string") return undefined;
    const identity = HostIdentityInputSchema.safeParse(value.identity);
    return identity.success ? { status: "ready", hostId: value.hostId, identity: identity.data } : undefined;
  }
  if (
    value.status === "unavailable" &&
    typeof value.code === "string" &&
    PROVIDER_UNAVAILABLE_CODES.has(value.code) &&
    typeof value.recoveryAction === "string" &&
    PROVIDER_RECOVERY_ACTIONS.has(value.recoveryAction)
  ) {
    return value as HostIdentityProviderLoadResult;
  }
  return undefined;
}

function scopeForRequest(request: HostIpcRequest): RemoteDeviceScope {
  switch (request.method) {
    case "health.get":
    case "catalog.snapshot":
    case "thread.snapshot":
    case "command.reconcile":
      return "projection.read";
    case "handoff.plan":
    case "handoff.commit":
      return "run_location.change";
    case "command.submit":
      switch (request.payload.command.command.kind) {
        case "prompt":
          return "thread.start";
        case "follow_up":
          return "thread.follow_up";
        case "steer":
          return "thread.steer";
        case "abort":
          return "thread.abort";
        case "approval.resolve":
          return "approval.resolve";
      }
  }
}

function serviceStateForRuntimeIntegrity(
  runtimeIntegrity: RuntimeIntegritySnapshot,
): "starting" | "ready" | "degraded" {
  switch (runtimeIntegrity.status) {
    case "initializing":
      return "starting";
    case "ready":
      return "ready";
    case "failed":
    case "unavailable":
      return "degraded";
  }
}

function invalidRequestResponse(value: unknown, error: ZodError): HostIpcResponse {
  const record = isRecord(value) ? value : undefined;
  const requestId =
    typeof record?.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.requestId)
      ? record.requestId
      : `invalid-${randomUUID()}`;
  const method = typeof record?.method === "string" && KNOWN_METHODS.has(record.method) ? record.method : "health.get";
  const firstIssue = error.issues[0];
  return HostIpcResponseSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    method,
    ok: false,
    error: {
      code: record?.protocolVersion === PROTOCOL_VERSION ? "INVALID_REQUEST" : "INCOMPATIBLE_PROTOCOL",
      message: firstIssue ? `Invalid request at ${firstIssue.path.join(".") || "root"}: ${firstIssue.message}` : "Invalid request",
      retryable: false,
    },
  });
}

function toStructuredError(error: unknown): StructuredError {
  if (error instanceof HostStoreError) return error.toStructuredError();
  if (error instanceof PairingAuthorityError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof GatewayError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof ZodError) {
    return { code: "INVALID_STATE", message: "Durable host state failed schema validation", retryable: false };
  }
  const diagnosticId = `diagnostic-${randomUUID()}`;
  return {
    code: "INTERNAL_ERROR",
    message: "The host service could not complete the request",
    retryable: true,
    diagnosticId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
