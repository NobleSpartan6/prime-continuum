import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  IdSchema,
  IsoDateTimeSchema,
  RelayOriginSchema,
  RemoteDeviceScopeSchema,
  type RemoteDeviceScope,
} from "../../shared/protocol";
import {
  AuthenticatedRelayPrincipalSchema,
  SecureChannelTranscriptBindingSchema,
  validateAuthenticatedRelayPrincipal,
  type AuthenticatedRelayPrincipal,
  type SecureChannelTranscriptBinding,
} from "../../shared/relay-transport";
import {
  AtomicWriteAmbiguousCommitError,
  atomicWriteJson,
  ensurePrivateDirectory,
  readJsonFile,
} from "../atomic-files";

export const PAIRING_AUTHORITY_STATE_VERSION = 1 as const;
export const PAIRING_AUTHORITY_FILE_NAME = "pairing-authority.json";
export const MAX_PAIRING_TICKETS = 256;
export const MAX_ACTIVE_PAIRING_TICKETS = 8;
export const MAX_PAIRED_DEVICES = 1_000;
export const MAX_PAIRING_AUDIT_EVENTS = 4_096;
export const MAX_CHANNELS_PER_DEVICE = 8;
export const MAX_ACTIVE_CHANNELS = 256;
export const CHANNEL_CLOSE_TIMEOUT_MS = 2_000;
export const TERMINAL_TICKET_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const REVOKED_DEVICE_RETENTION_MS = 180 * 24 * 60 * 60_000;

const MAX_IDENTITY_EPOCH = 1_000_000_000;
const MAX_GRANT_VERSION = 1_000_000_000;
const BASE64URL_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_PATTERN = /^pa1-[A-Za-z0-9_-]{43}$/;

const Base64Url32Schema = z
  .string()
  .length(43)
  .regex(BASE64URL_SHA256_PATTERN, "Must be canonical unpadded base64url")
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === 32 && decoded.toString("base64url") === value;
  }, "Must encode exactly 32 bytes");

const FingerprintSchema = z
  .string()
  .length(47)
  .regex(FINGERPRINT_PATTERN, "Must be a Prime Agent Noise key fingerprint");

const DigestSchema = z
  .string()
  .length(43)
  .regex(BASE64URL_SHA256_PATTERN, "Must be a canonical SHA-256 digest");

const IdentityEpochSchema = z.number().int().positive().max(MAX_IDENTITY_EPOCH);
const GrantVersionSchema = z.number().int().positive().max(MAX_GRANT_VERSION);

const InputScopeArraySchema = z.array(RemoteDeviceScopeSchema).min(1).max(8);
const SortedScopeArraySchema = InputScopeArraySchema.superRefine((scopes, context) => {
  if (new Set(scopes).size !== scopes.length) {
    context.addIssue({ code: "custom", message: "Device scopes must be unique" });
  }
  const sorted = [...scopes].sort();
  if (scopes.some((scope, index) => scope !== sorted[index])) {
    context.addIssue({ code: "custom", message: "Persisted device scopes must be sorted" });
  }
});

export const HostIdentityInputSchema = z
  .object({
    identityEpoch: IdentityEpochSchema,
    algorithm: z.literal("Noise_25519"),
    publicKeyB64u: Base64Url32Schema,
    secretRef: z.string().min(1).max(512),
  })
  .strict();

export const HostIdentityMetadataSchema = HostIdentityInputSchema.extend({
  fingerprint: FingerprintSchema,
}).strict();
export type HostIdentityMetadata = z.infer<typeof HostIdentityMetadataSchema>;
export type HostIdentityInput = z.input<typeof HostIdentityInputSchema>;

export const PairingTicketStateSchema = z.enum([
  "pending",
  "reserved",
  "redeemed",
  "cancelled",
  "expired",
]);
export type PairingTicketState = z.infer<typeof PairingTicketStateSchema>;

export const DurablePairingTicketSchema = z
  .object({
    version: z.literal(1),
    ticketId: IdSchema,
    hostId: IdSchema,
    relayOrigin: RelayOriginSchema,
    hostIdentityEpoch: IdentityEpochSchema,
    requestedScopes: SortedScopeArraySchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    state: PairingTicketStateSchema,
    reservationId: IdSchema.optional(),
    reservedAt: IsoDateTimeSchema.optional(),
    terminalAt: IsoDateTimeSchema.optional(),
    deviceId: IdSchema.optional(),
    reason: z.string().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((ticket, context) => {
    const lifetime = Date.parse(ticket.expiresAt) - Date.parse(ticket.createdAt);
    if (lifetime < 60_000 || lifetime > 300_000) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "Ticket lifetime must be 60 to 300 seconds" });
    }

    if (ticket.state === "pending") {
      if (ticket.reservationId || ticket.reservedAt || ticket.terminalAt || ticket.deviceId || ticket.reason) {
        context.addIssue({ code: "custom", message: "A pending ticket cannot contain reservation or terminal fields" });
      }
      return;
    }

    if (ticket.state === "reserved") {
      if (!ticket.reservationId || !ticket.reservedAt) {
        context.addIssue({ code: "custom", message: "A reserved ticket requires one reservation" });
      }
      if (ticket.terminalAt || ticket.deviceId || ticket.reason) {
        context.addIssue({ code: "custom", message: "A reserved ticket cannot contain terminal fields" });
      }
      return;
    }

    if (!ticket.terminalAt) {
      context.addIssue({ code: "custom", message: "A terminal ticket requires terminalAt" });
    }
    if (ticket.state === "redeemed") {
      if (!ticket.reservationId || !ticket.reservedAt || !ticket.deviceId) {
        context.addIssue({ code: "custom", message: "A redeemed ticket requires its reservation and device identity" });
      }
      if (ticket.reason) {
        context.addIssue({ code: "custom", message: "A redeemed ticket cannot contain a failure reason" });
      }
    } else if (!ticket.reason) {
      context.addIssue({ code: "custom", message: "A cancelled or expired ticket requires a reason" });
    }
  });
export type DurablePairingTicket = z.infer<typeof DurablePairingTicketSchema>;

export const DeviceGrantRecordSchema = z
  .object({
    version: z.literal(1),
    deviceId: IdSchema,
    publicKeyB64u: Base64Url32Schema,
    fingerprint: FingerprintSchema,
    displayName: z.string().trim().min(1).max(128),
    kind: z.enum(["mobile", "desktop"]),
    scopeCeiling: SortedScopeArraySchema,
    scopes: SortedScopeArraySchema,
    grantVersion: GrantVersionSchema,
    hostIdentityEpoch: IdentityEpochSchema,
    pairedAt: IsoDateTimeSchema,
    lastSeenAt: IsoDateTimeSchema.optional(),
    revokedAt: IsoDateTimeSchema.optional(),
    revocationReason: z.string().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((device, context) => {
    const derived = derivePairingDeviceIdentityUnchecked(device.publicKeyB64u);
    if (device.deviceId !== derived.deviceId) {
      context.addIssue({ code: "custom", path: ["deviceId"], message: "Device ID does not match its public key" });
    }
    if (device.fingerprint !== derived.fingerprint) {
      context.addIssue({ code: "custom", path: ["fingerprint"], message: "Fingerprint does not match its public key" });
    }
    const ceiling = new Set<RemoteDeviceScope>(device.scopeCeiling);
    if (device.scopes.some((scope) => !ceiling.has(scope))) {
      context.addIssue({ code: "custom", path: ["scopes"], message: "Granted scopes exceed the pairing ceiling" });
    }
    if ((device.revokedAt === undefined) !== (device.revocationReason === undefined)) {
      context.addIssue({ code: "custom", message: "Revocation time and reason must be persisted together" });
    }
  });
export type DeviceGrantRecord = z.infer<typeof DeviceGrantRecordSchema>;

const PairingAuditEventNameSchema = z.enum([
  "ticket.created",
  "ticket.reserved",
  "ticket.cancelled",
  "ticket.expired",
  "ticket.redeemed",
  "device.revoked",
  "device.scopes_changed",
  "identity.installed",
  "identity.rotated",
  "history.compacted",
]);

const PairingAuditEventSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    eventId: IdSchema,
    previousHash: z.union([z.literal("GENESIS"), DigestSchema]),
    recordHash: DigestSchema,
    recordedAt: IsoDateTimeSchema,
    event: PairingAuditEventNameSchema,
    actor: z.enum(["trusted_user", "crypto_provider", "system"]),
    ticketId: IdSchema.optional(),
    deviceId: IdSchema.optional(),
    fingerprint: FingerprintSchema.optional(),
    grantVersion: GrantVersionSchema.optional(),
    hostIdentityEpoch: IdentityEpochSchema,
    scopes: SortedScopeArraySchema.optional(),
    reason: z.string().min(1).max(512).optional(),
  })
  .strict();
export type PairingAuditEvent = z.infer<typeof PairingAuditEventSchema>;

const PairingAuthorityStateSchema = z
  .object({
    version: z.literal(PAIRING_AUTHORITY_STATE_VERSION),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    hostId: IdSchema,
    hostIdentityEpoch: IdentityEpochSchema,
    identity: HostIdentityMetadataSchema.optional(),
    tickets: z.array(DurablePairingTicketSchema).max(MAX_PAIRING_TICKETS),
    devices: z.array(DeviceGrantRecordSchema).max(MAX_PAIRED_DEVICES),
    auditAnchorHash: z.union([z.literal("GENESIS"), DigestSchema]),
    nextAuditSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    audits: z.array(PairingAuditEventSchema).max(MAX_PAIRING_AUDIT_EVENTS),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.identity && state.identity.identityEpoch !== state.hostIdentityEpoch) {
      context.addIssue({ code: "custom", path: ["identity"], message: "Host identity epoch does not match authority epoch" });
    }
    if (state.identity && state.identity.fingerprint !== deriveNoisePublicKeyFingerprintUnchecked(state.identity.publicKeyB64u)) {
      context.addIssue({ code: "custom", path: ["identity", "fingerprint"], message: "Host fingerprint does not match its public key" });
    }

    validateUnique(state.tickets.map((ticket) => ticket.ticketId), "ticket ID", context);
    validateUnique(state.devices.map((device) => device.deviceId), "device ID", context);
    validateUnique(state.devices.map((device) => device.fingerprint), "device fingerprint", context);
    for (const ticket of state.tickets) {
      if (ticket.hostId !== state.hostId) {
        context.addIssue({ code: "custom", path: ["tickets"], message: "Ticket belongs to another host" });
      }
      if (ticket.hostIdentityEpoch > state.hostIdentityEpoch) {
        context.addIssue({ code: "custom", path: ["tickets"], message: "Ticket belongs to a future identity epoch" });
      }
      if (
        ticket.hostIdentityEpoch < state.hostIdentityEpoch &&
        (ticket.state === "pending" || ticket.state === "reserved")
      ) {
        context.addIssue({ code: "custom", path: ["tickets"], message: "A ticket from an older identity must be terminal" });
      }
    }
    for (const device of state.devices) {
      if (device.hostIdentityEpoch > state.hostIdentityEpoch) {
        context.addIssue({ code: "custom", path: ["devices"], message: "Device grant belongs to a future identity epoch" });
      }
      if (device.hostIdentityEpoch < state.hostIdentityEpoch && !device.revokedAt) {
        context.addIssue({ code: "custom", path: ["devices"], message: "A device from an older host identity must be revoked" });
      }
    }

    let previousHash = state.auditAnchorHash;
    let previousSequence = 0;
    for (const audit of state.audits) {
      if (audit.previousHash !== previousHash) {
        context.addIssue({ code: "custom", path: ["audits"], message: "Audit hash chain is discontinuous" });
        break;
      }
      if (audit.sequence <= previousSequence || audit.eventId !== `audit-${audit.sequence}`) {
        context.addIssue({ code: "custom", path: ["audits"], message: "Audit sequence is not strictly monotonic" });
        break;
      }
      if (audit.recordHash !== hashAuditEvent(audit)) {
        context.addIssue({ code: "custom", path: ["audits"], message: "Audit record hash is invalid" });
        break;
      }
      previousHash = audit.recordHash;
      previousSequence = audit.sequence;
    }
    const lastSequence = state.audits.at(-1)?.sequence ?? state.nextAuditSequence - 1;
    if (state.nextAuditSequence <= lastSequence) {
      context.addIssue({ code: "custom", path: ["nextAuditSequence"], message: "Next audit sequence must exceed durable events" });
    }
  });
export type PairingAuthoritySnapshot = z.infer<typeof PairingAuthorityStateSchema>;

const InitializeInputSchema = z
  .object({
    hostId: IdSchema,
    identity: HostIdentityInputSchema.optional(),
  })
  .strict();

const CreateTicketInputSchema = z
  .object({
    expectedHostId: IdSchema,
    ticketId: IdSchema.optional(),
    relayOrigin: RelayOriginSchema,
    requestedScopes: InputScopeArraySchema,
    ttlSeconds: z.number().int().min(60).max(300),
  })
  .strict();

const CompactHistoryInputSchema = z.object({ expectedHostId: IdSchema }).strict();

const VerifiedReservationInputSchema = z
  .object({
    expectedHostId: IdSchema,
    ticketId: IdSchema,
    reservationId: IdSchema,
  })
  .strict();

const VerifiedPairingCommitInputSchema = z
  .object({
    expectedHostId: IdSchema,
    expectedHostIdentityEpoch: IdentityEpochSchema,
    ticketId: IdSchema,
    reservationId: IdSchema,
    publicKeyB64u: Base64Url32Schema,
    authenticatedFingerprint: FingerprintSchema,
    clientClaimedDeviceId: IdSchema.optional(),
    displayName: z.string().trim().min(1).max(128),
    kind: z.enum(["mobile", "desktop"]),
    grantedScopes: InputScopeArraySchema,
  })
  .strict();

const DeviceMutationInputBase = {
  expectedHostId: IdSchema,
  expectedHostIdentityEpoch: IdentityEpochSchema,
  fingerprint: FingerprintSchema,
  expectedGrantVersion: GrantVersionSchema,
};

const RevokeDeviceInputSchema = z
  .object({
    ...DeviceMutationInputBase,
    reason: z.string().trim().min(1).max(512),
  })
  .strict();

const ChangeScopesInputSchema = z
  .object({
    ...DeviceMutationInputBase,
    scopes: InputScopeArraySchema,
  })
  .strict();

const AuthenticatedPrincipalSchema = z
  .object({
    hostId: IdSchema,
    fingerprint: FingerprintSchema,
    grantVersion: GrantVersionSchema,
    hostIdentityEpoch: IdentityEpochSchema,
  })
  .strict();
export type AuthenticatedDevicePrincipal = z.infer<typeof AuthenticatedPrincipalSchema>;

const AuthenticatedChannelLeaseSchema = z
  .object({
    leaseId: z.string().length(43).regex(BASE64URL_SHA256_PATTERN, "Lease ID must be canonical base64url"),
    channelId: z.string().length(32).regex(/^[0-9a-f]{32}$/, "Channel ID must be canonical lowercase hex"),
  })
  .strict();
export type AuthenticatedChannelLease = z.infer<typeof AuthenticatedChannelLeaseSchema>;

export interface RegisteredAuthenticatedChannel {
  readonly lease: AuthenticatedChannelLease;
  unregister(): Promise<void>;
}

/**
 * Provider-owned, one-shot evidence consumed at the host authorization
 * boundary. Production hostd installs no admission provider yet, so structural
 * relay data and caller-created objects always fail closed.
 */
export interface AuthenticatedRelaySessionEvidence {
  readonly localRole: "host" | "device";
  readonly transcript: SecureChannelTranscriptBinding;
  readonly principal: AuthenticatedRelayPrincipal;
  readonly close: (reason?: string) => void | Promise<void>;
}

export interface AuthenticatedRelaySessionAdmission {
  consume(session: unknown): AuthenticatedRelaySessionEvidence | undefined;
}

const DISABLED_RELAY_SESSION_ADMISSION: AuthenticatedRelaySessionAdmission = Object.freeze({
  consume: () => undefined,
});

/**
 * Provider-owned, one-shot proof that an interactive pairing ceremony reached
 * a specific trust-boundary transition. The public token carries no trusted
 * fields; only the provider instance that issued it can reveal this captured
 * evidence to its paired authority instance.
 */
export type VerifiedPairingCeremonyEvidence =
  | {
      readonly phase: "reservation";
      readonly reservation: VerifiedPairingReservation;
    }
  | {
      readonly phase: "commit";
      readonly commit: VerifiedPairingCommit;
    };

export interface VerifiedPairingCeremonyAdmission {
  consume(capability: unknown): VerifiedPairingCeremonyEvidence | undefined;
}

const DISABLED_PAIRING_CEREMONY_ADMISSION: VerifiedPairingCeremonyAdmission = Object.freeze({
  consume: () => undefined,
});

const RotateIdentityInputSchema = z
  .object({
    expectedHostId: IdSchema,
    expectedHostIdentityEpoch: IdentityEpochSchema,
    identity: HostIdentityInputSchema,
    reason: z.string().trim().min(1).max(512),
  })
  .strict();

export interface PairingAuthorityOptions {
  pathKind?: "state_file" | "data_directory";
  now?: () => Date;
  /** Fault-injection seam; production uses the crash-safe atomic writer. */
  writeState?: typeof atomicWriteJson;
  onChannelCloseFailure?: (diagnostic: ChannelCloseFailureDiagnostic) => void;
  /** Deterministic IDs are permitted only in tests; production IDs are 256-bit random values. */
  allowTestTicketIds?: boolean;
  /**
   * One-shot capability consumer owned by the reviewed crypto provider.
   * Omit it to keep relay-channel registration unconditionally disabled.
   */
  authenticatedSessionAdmission?: AuthenticatedRelaySessionAdmission;
  /**
   * One-shot capability consumer owned by the future reviewed pairing
   * provider. Omit it to keep ticket reservation and grant commit disabled.
   */
  verifiedPairingCeremonyAdmission?: VerifiedPairingCeremonyAdmission;
}

export interface VerifiedPairingReservation {
  expectedHostId: string;
  ticketId: string;
  reservationId: string;
}

export interface VerifiedPairingCommit {
  expectedHostId: string;
  expectedHostIdentityEpoch: number;
  ticketId: string;
  reservationId: string;
  publicKeyB64u: string;
  authenticatedFingerprint: string;
  clientClaimedDeviceId?: string;
  displayName: string;
  kind: "mobile" | "desktop";
  grantedScopes: RemoteDeviceScope[];
}

export type ChannelClosureReason =
  | "device_revoked"
  | "scopes_changed"
  | "host_identity_rotated"
  | "authority_persistence_uncertain"
  | "host_service_stopped"
  | "secure_channel_rejected";
export type ChannelCloseCallback = (reason: ChannelClosureReason) => void | Promise<void>;
export interface ChannelCloseFailureDiagnostic {
  readonly reason: ChannelClosureReason;
  readonly callbackIndex: number;
  readonly code: "CHANNEL_CLOSE_REJECTED" | "CHANNEL_CLOSE_TIMEOUT";
  readonly message: string;
}

export class PairingAuthorityError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PairingAuthorityError";
    this.code = code;
  }
}

interface RegisteredChannel {
  channelId: string;
  leaseId: string;
  principal: AuthenticatedDevicePrincipal;
  close: ChannelCloseCallback;
}

/**
 * Durable Phase 3A authority for pairing tickets and per-device grants.
 *
 * This class deliberately performs no cryptographic handshake and never creates,
 * accepts, or persists a ticket PSK or private key. `reserveVerifiedTicket()` and
 * `commitVerifiedPairing()` consume opaque one-shot capabilities owned by the
 * future authenticated pairing provider after it validates ticket possession,
 * transcript binding, both human confirmations, and the device's static public
 * key. Caller-created structures are not evidence and these methods are not
 * relay- or renderer-facing APIs.
 *
 * One hostd process must own a state file. All mutations and authorized
 * operations are serialized inside that process, and every durable mutation is
 * one atomic replacement of the bounded state document.
 */
export class PairingAuthority {
  readonly stateFile: string;

  private readonly now: () => Date;
  private readonly writeState: typeof atomicWriteJson;
  private readonly onChannelCloseFailure: ((diagnostic: ChannelCloseFailureDiagnostic) => void) | undefined;
  private readonly allowTestTicketIds: boolean;
  private readonly consumeAuthenticatedSession: AuthenticatedRelaySessionAdmission["consume"];
  private readonly consumeVerifiedPairingCeremony: VerifiedPairingCeremonyAdmission["consume"];
  private operationTail: Promise<void> = Promise.resolve();
  private state: PairingAuthoritySnapshot | undefined;
  private initialized = false;
  private fatalError: PairingAuthorityError | undefined;
  private readonly channels = new Map<string, Map<string, RegisteredChannel>>();
  private readonly channelLeases = new Map<string, RegisteredChannel>();

  constructor(path: string, options: PairingAuthorityOptions = {}) {
    if (!path || path.length > 4_096 || path.includes("\0")) {
      throw new PairingAuthorityError("INVALID_STATE_PATH", "Pairing authority path must be bounded and contain no NUL bytes");
    }
    const resolved = resolve(path);
    this.stateFile = options.pathKind === "data_directory" ? join(resolved, PAIRING_AUTHORITY_FILE_NAME) : resolved;
    this.now = options.now ?? (() => new Date());
    this.writeState = options.writeState ?? atomicWriteJson;
    this.onChannelCloseFailure = options.onChannelCloseFailure;
    this.allowTestTicketIds = options.allowTestTicketIds ?? false;
    const authenticatedSessionAdmission = options.authenticatedSessionAdmission ?? DISABLED_RELAY_SESSION_ADMISSION;
    if (!authenticatedSessionAdmission || typeof authenticatedSessionAdmission.consume !== "function") {
      throw new PairingAuthorityError(
        "INVALID_SECURE_SESSION_ADMISSION",
        "Authenticated session admission must provide a capability consumer",
      );
    }
    this.consumeAuthenticatedSession = authenticatedSessionAdmission.consume.bind(authenticatedSessionAdmission);
    const pairingCeremonyAdmission =
      options.verifiedPairingCeremonyAdmission ?? DISABLED_PAIRING_CEREMONY_ADMISSION;
    if (!pairingCeremonyAdmission || typeof pairingCeremonyAdmission.consume !== "function") {
      throw new PairingAuthorityError(
        "INVALID_PAIRING_CEREMONY_ADMISSION",
        "Verified pairing ceremony admission must provide a capability consumer",
      );
    }
    this.consumeVerifiedPairingCeremony = pairingCeremonyAdmission.consume.bind(pairingCeremonyAdmission);
  }

  async initialize(input: { hostId: string; identity?: HostIdentityInput }): Promise<PairingAuthoritySnapshot> {
    const parsedInput = parseInput(InitializeInputSchema, input);
    return this.exclusive(async () => {
      if (this.fatalError) throw this.fatalError;
      if (this.initialized) {
        const current = this.requireState();
        if (current.hostId !== parsedInput.hostId) {
          throw new PairingAuthorityError("HOST_IDENTITY_MISMATCH", "Pairing authority state belongs to another host");
        }
        if (!parsedInput.identity) return this.copyState();

        const expectedIdentity = materializeHostIdentity(parsedInput.identity);
        if (current.identity) {
          if (!sameHostIdentity(current.identity, expectedIdentity)) {
            throw new PairingAuthorityError(
              "HOST_IDENTITY_MISMATCH",
              "Configured host identity does not match the durable pairing authority",
            );
          }
          return this.copyState();
        }
        if (current.tickets.length > 0 || current.devices.length > 0) {
          throw new PairingAuthorityError(
            "IDENTITY_INSTALL_REQUIRES_EMPTY_STATE",
            "A host identity can be installed only before any ticket or device state exists",
          );
        }
        if (expectedIdentity.identityEpoch !== current.hostIdentityEpoch) {
          throw new PairingAuthorityError(
            "INVALID_IDENTITY_EPOCH",
            "Installed host identity must match the authority's current identity epoch",
          );
        }

        const draft = cloneState(current);
        draft.identity = expectedIdentity;
        appendAudit(draft, {
          recordedAt: this.nowIso(),
          event: "identity.installed",
          actor: "trusted_user",
          fingerprint: expectedIdentity.fingerprint,
          hostIdentityEpoch: draft.hostIdentityEpoch,
        });
        await this.persistDraft(draft);
        return this.copyState();
      }
      await ensurePrivateDirectory(dirname(this.stateFile));
      const stored = await readJsonFile(this.stateFile, PairingAuthorityStateSchema, { optional: true });

      if (!stored) {
        const identity = parsedInput.identity ? materializeHostIdentity(parsedInput.identity) : undefined;
        const initial = PairingAuthorityStateSchema.parse({
          version: PAIRING_AUTHORITY_STATE_VERSION,
          revision: 0,
          hostId: parsedInput.hostId,
          hostIdentityEpoch: identity?.identityEpoch ?? 1,
          identity,
          tickets: [],
          devices: [],
          auditAnchorHash: "GENESIS",
          nextAuditSequence: 1,
          audits: [],
        });
        await this.writeState(this.stateFile, initial);
        this.state = initial;
        this.initialized = true;
        return this.copyState();
      }

      if (stored.hostId !== parsedInput.hostId) {
        throw new PairingAuthorityError("HOST_IDENTITY_MISMATCH", "Pairing authority state belongs to another host");
      }
      let identityToInstall: HostIdentityMetadata | undefined;
      if (parsedInput.identity) {
        const expectedIdentity = materializeHostIdentity(parsedInput.identity);
        if (stored.identity && !sameHostIdentity(stored.identity, expectedIdentity)) {
          throw new PairingAuthorityError(
            "HOST_IDENTITY_MISMATCH",
            "Configured host identity does not match the durable pairing authority",
          );
        }
        if (!stored.identity) {
          if (stored.tickets.length > 0 || stored.devices.length > 0) {
            throw new PairingAuthorityError(
              "IDENTITY_INSTALL_REQUIRES_EMPTY_STATE",
              "A host identity can be installed only before any ticket or device state exists",
            );
          }
          if (expectedIdentity.identityEpoch !== stored.hostIdentityEpoch) {
            throw new PairingAuthorityError(
              "INVALID_IDENTITY_EPOCH",
              "Installed host identity must match the authority's current identity epoch",
            );
          }
          identityToInstall = expectedIdentity;
        }
      }

      this.state = stored;
      this.initialized = true;
      try {
        const draft = cloneState(stored);
        const timestamp = this.nowIso();
        let changed = false;
        if (identityToInstall) {
          draft.identity = identityToInstall;
          appendAudit(draft, {
            recordedAt: timestamp,
            event: "identity.installed",
            actor: "trusted_user",
            fingerprint: identityToInstall.fingerprint,
            hostIdentityEpoch: draft.hostIdentityEpoch,
          });
          changed = true;
        }
        for (let index = 0; index < draft.tickets.length; index += 1) {
          const ticket = draft.tickets[index];
          if (!ticket || (ticket.state !== "pending" && ticket.state !== "reserved")) continue;
          draft.tickets[index] = {
            ...ticket,
            state: "cancelled",
            terminalAt: timestamp,
            reason: "host_restart",
          };
          appendAudit(draft, {
            recordedAt: timestamp,
            event: "ticket.cancelled",
            actor: "system",
            ticketId: ticket.ticketId,
            hostIdentityEpoch: draft.hostIdentityEpoch,
            reason: "host_restart",
          });
          changed = true;
        }
        if (changed) await this.persistDraft(draft);
        return this.copyState();
      } catch (error) {
        this.state = undefined;
        this.initialized = false;
        throw error;
      }
    });
  }

  async getSnapshot(): Promise<PairingAuthoritySnapshot> {
    return this.exclusive(async () => this.copyState());
  }

  async close(): Promise<void> {
    const callbacks = await this.exclusive(async () => {
      this.initialized = false;
      this.state = undefined;
      return this.takeAllChannelCallbacks();
    });
    await this.closeChannels(callbacks, "host_service_stopped");
  }

  async createTicket(input: {
    expectedHostId: string;
    ticketId?: string;
    relayOrigin: string;
    requestedScopes: RemoteDeviceScope[];
    ttlSeconds: number;
  }): Promise<DurablePairingTicket> {
    const parsed = parseInput(CreateTicketInputSchema, input);
    const requestedScopes = normalizeScopes(parsed.requestedScopes);
    return this.exclusive(async () => {
      const current = this.requireState();
      this.assertHost(current, parsed.expectedHostId);
      this.requireInstalledIdentity(current);
      if (parsed.ticketId && !this.allowTestTicketIds) {
        throw new PairingAuthorityError(
          "CALLER_TICKET_ID_FORBIDDEN",
          "Production pairing ticket IDs are generated by the host authority",
        );
      }
      if (parsed.ticketId && current.tickets.some((ticket) => ticket.ticketId === parsed.ticketId)) {
        throw new PairingAuthorityError("TICKET_ID_REUSED", "Pairing ticket ID already exists");
      }

      const createdAtDate = this.nowDate();
      const createdAt = createdAtDate.toISOString();
      const draft = cloneState(current);
      expireDueTickets(draft, createdAtDate.getTime(), createdAt);
      const compacted = compactRetiredHistoryRecords(draft, createdAtDate.getTime());
      if (compacted.tickets > 0 || compacted.devices > 0) {
        appendHistoryCompactionAudit(draft, createdAt, compacted);
      }
      if (draft.tickets.length >= MAX_PAIRING_TICKETS) {
        throw new PairingAuthorityError("TICKET_QUOTA_REACHED", "Pairing ticket history is full");
      }
      const activeCount = draft.tickets.filter((ticket) => ticket.state === "pending" || ticket.state === "reserved").length;
      if (activeCount >= MAX_ACTIVE_PAIRING_TICKETS) {
        throw new PairingAuthorityError("ACTIVE_TICKET_QUOTA_REACHED", "Too many pairing tickets are active");
      }

      const ticket = DurablePairingTicketSchema.parse({
        version: 1,
        ticketId: parsed.ticketId ?? this.newTicketId(draft),
        hostId: current.hostId,
        relayOrigin: parsed.relayOrigin,
        hostIdentityEpoch: current.hostIdentityEpoch,
        requestedScopes,
        createdAt,
        expiresAt: new Date(createdAtDate.getTime() + parsed.ttlSeconds * 1_000).toISOString(),
        state: "pending",
      });
      draft.tickets.push(ticket);
      appendAudit(draft, {
        recordedAt: createdAt,
        event: "ticket.created",
        actor: "trusted_user",
        ticketId: ticket.ticketId,
        hostIdentityEpoch: draft.hostIdentityEpoch,
        scopes: requestedScopes,
      });
      await this.persistDraft(draft);
      return copyTicket(ticket);
    });
  }

  async compactRetiredHistory(input: { expectedHostId: string }): Promise<{ tickets: number; devices: number }> {
    const parsed = parseInput(CompactHistoryInputSchema, input);
    return this.exclusive(async () => {
      const current = this.requireState();
      this.assertHost(current, parsed.expectedHostId);
      const now = this.nowDate();
      const timestamp = now.toISOString();
      const draft = cloneState(current);
      const expired = expireDueTickets(draft, now.getTime(), timestamp);
      const compacted = compactRetiredHistoryRecords(draft, now.getTime());
      if (compacted.tickets > 0 || compacted.devices > 0) {
        appendHistoryCompactionAudit(draft, timestamp, compacted);
      }
      if (expired > 0 || compacted.tickets > 0 || compacted.devices > 0) {
        await this.persistDraft(draft);
      }
      return compacted;
    });
  }

  /**
   * Reserves a ticket exactly once after the selected provider has authenticated
   * the pairing attempt and issued a one-shot capability. Caller-created objects
   * and untrusted relay frames fail before ticket lookup.
   */
  async reserveVerifiedTicket(capability: unknown): Promise<DurablePairingTicket> {
    const evidence = this.requireVerifiedPairingCeremony(capability, "reservation");
    const parsed = parseInput(VerifiedReservationInputSchema, evidence.reservation);
    const result = await this.exclusive(async () => {
      const current = this.requireState();
      this.assertHost(current, parsed.expectedHostId);
      this.requireInstalledIdentity(current);
      const draft = cloneState(current);
      const index = draft.tickets.findIndex((ticket) => ticket.ticketId === parsed.ticketId);
      if (index < 0) throw new PairingAuthorityError("TICKET_NOT_FOUND", "Pairing ticket does not exist");
      const ticket = draft.tickets[index];
      if (!ticket) throw new PairingAuthorityError("TICKET_NOT_FOUND", "Pairing ticket does not exist");
      this.assertTicketEpoch(current, ticket);
      const timestamp = this.nowIso();
      if (this.isExpired(ticket)) {
        if (ticket.state === "pending" || ticket.state === "reserved") {
          const expired = DurablePairingTicketSchema.parse({
            ...ticket,
            state: "expired",
            terminalAt: timestamp,
            reason: "ticket_expired",
          });
          draft.tickets[index] = expired;
          appendAudit(draft, {
            recordedAt: timestamp,
            event: "ticket.expired",
            actor: "system",
            ticketId: ticket.ticketId,
            hostIdentityEpoch: draft.hostIdentityEpoch,
            reason: "ticket_expired",
          });
          await this.persistDraft(draft);
        }
        return { error: new PairingAuthorityError("TICKET_EXPIRED", "Pairing ticket has expired") } as const;
      }
      if (ticket.state !== "pending") {
        throw new PairingAuthorityError("TICKET_NOT_PENDING", "Pairing ticket has already been reserved or finalized");
      }
      if (draft.tickets.some((item) => item.reservationId === parsed.reservationId)) {
        throw new PairingAuthorityError("RESERVATION_ID_REUSED", "Pairing reservation ID already exists");
      }
      const reserved = DurablePairingTicketSchema.parse({
        ...ticket,
        state: "reserved",
        reservationId: parsed.reservationId,
        reservedAt: timestamp,
      });
      draft.tickets[index] = reserved;
      appendAudit(draft, {
        recordedAt: timestamp,
        event: "ticket.reserved",
        actor: "crypto_provider",
        ticketId: ticket.ticketId,
        hostIdentityEpoch: draft.hostIdentityEpoch,
      });
      await this.persistDraft(draft);
      return { ticket: copyTicket(reserved) } as const;
    });
    if ("error" in result) throw result.error;
    return result.ticket;
  }

  /**
   * Atomically redeems a reserved ticket and creates its device grant. The
   * future provider can issue this one-shot capability only after its reviewed
   * authenticated transcript and both local human confirmations have succeeded.
   * The supplied fingerprint is the provider-authenticated key fingerprint; any
   * claimed client device ID is intentionally ignored.
   */
  async commitVerifiedPairing(capability: unknown): Promise<DeviceGrantRecord> {
    const evidence = this.requireVerifiedPairingCeremony(capability, "commit");
    const parsed = parseInput(VerifiedPairingCommitInputSchema, evidence.commit);
    const grantedScopes = normalizeScopes(parsed.grantedScopes);
    const derivedIdentity = derivePairingDeviceIdentity(parsed.publicKeyB64u);
    if (parsed.authenticatedFingerprint !== derivedIdentity.fingerprint) {
      throw new PairingAuthorityError(
        "AUTHENTICATED_KEY_MISMATCH",
        "Committed public key does not match the crypto provider's authenticated fingerprint",
      );
    }

    const result = await this.exclusive(async () => {
      const current = this.requireState();
      this.assertHost(current, parsed.expectedHostId);
      this.requireInstalledIdentity(current);
      this.assertHostEpoch(current, parsed.expectedHostIdentityEpoch);
      const draft = cloneState(current);
      const index = draft.tickets.findIndex((ticket) => ticket.ticketId === parsed.ticketId);
      if (index < 0) throw new PairingAuthorityError("TICKET_NOT_FOUND", "Pairing ticket does not exist");
      const ticket = draft.tickets[index];
      if (!ticket) throw new PairingAuthorityError("TICKET_NOT_FOUND", "Pairing ticket does not exist");
      this.assertTicketEpoch(current, ticket);
      const timestamp = this.nowIso();
      if (this.isExpired(ticket)) {
        if (ticket.state === "pending" || ticket.state === "reserved") {
          draft.tickets[index] = DurablePairingTicketSchema.parse({
            ...ticket,
            state: "expired",
            terminalAt: timestamp,
            reason: "ticket_expired",
          });
          appendAudit(draft, {
            recordedAt: timestamp,
            event: "ticket.expired",
            actor: "system",
            ticketId: ticket.ticketId,
            hostIdentityEpoch: draft.hostIdentityEpoch,
            reason: "ticket_expired",
          });
          await this.persistDraft(draft);
        }
        return { error: new PairingAuthorityError("TICKET_EXPIRED", "Pairing ticket has expired") } as const;
      }
      if (ticket.state !== "reserved" || ticket.reservationId !== parsed.reservationId) {
        throw new PairingAuthorityError("RESERVATION_MISMATCH", "Pairing commit does not match the ticket reservation");
      }
      const requested = new Set<RemoteDeviceScope>(ticket.requestedScopes);
      if (grantedScopes.some((scope) => !requested.has(scope))) {
        throw new PairingAuthorityError("SCOPE_ESCALATION", "Granted scopes exceed the ticket request");
      }
      if (draft.devices.length >= MAX_PAIRED_DEVICES) {
        throw new PairingAuthorityError("DEVICE_QUOTA_REACHED", "Paired device registry is full");
      }
      const existingById = draft.devices.find((device) => device.deviceId === derivedIdentity.deviceId);
      const existingByFingerprint = draft.devices.find((device) => device.fingerprint === derivedIdentity.fingerprint);
      if (existingById || existingByFingerprint) {
        const existing = existingById ?? existingByFingerprint;
        if (existing?.publicKeyB64u !== parsed.publicKeyB64u) {
          throw new PairingAuthorityError("DEVICE_KEY_MISMATCH", "A durable device identity is bound to another public key");
        }
        throw new PairingAuthorityError("DEVICE_ALREADY_PAIRED", "This device key has already been paired");
      }

      const device = DeviceGrantRecordSchema.parse({
        version: 1,
        deviceId: derivedIdentity.deviceId,
        publicKeyB64u: parsed.publicKeyB64u,
        fingerprint: derivedIdentity.fingerprint,
        displayName: parsed.displayName,
        kind: parsed.kind,
        scopeCeiling: ticket.requestedScopes,
        scopes: grantedScopes,
        grantVersion: 1,
        hostIdentityEpoch: current.hostIdentityEpoch,
        pairedAt: timestamp,
      });
      const redeemed = DurablePairingTicketSchema.parse({
        ...ticket,
        state: "redeemed",
        terminalAt: timestamp,
        deviceId: device.deviceId,
      });
      draft.tickets[index] = redeemed;
      draft.devices.push(device);
      appendAudit(draft, {
        recordedAt: timestamp,
        event: "ticket.redeemed",
        actor: "crypto_provider",
        ticketId: ticket.ticketId,
        deviceId: device.deviceId,
        fingerprint: device.fingerprint,
        grantVersion: device.grantVersion,
        hostIdentityEpoch: draft.hostIdentityEpoch,
        scopes: device.scopes,
      });
      await this.persistDraft(draft);
      return { device: copyDevice(device) } as const;
    });
    if ("error" in result) throw result.error;
    return result.device;
  }

  async cancelTicket(input: {
    expectedHostId: string;
    ticketId: string;
    reason: string;
  }): Promise<DurablePairingTicket> {
    const parsed = parseInput(
      z.object({ expectedHostId: IdSchema, ticketId: IdSchema, reason: z.string().trim().min(1).max(512) }).strict(),
      input,
    );
    return this.exclusive(async () => {
      const current = this.requireState();
      this.assertHost(current, parsed.expectedHostId);
      const draft = cloneState(current);
      const index = draft.tickets.findIndex((ticket) => ticket.ticketId === parsed.ticketId);
      const ticket = draft.tickets[index];
      if (!ticket) throw new PairingAuthorityError("TICKET_NOT_FOUND", "Pairing ticket does not exist");
      if (ticket.state !== "pending" && ticket.state !== "reserved") {
        throw new PairingAuthorityError("TICKET_FINALIZED", "Pairing ticket is already final");
      }
      const timestamp = this.nowIso();
      const cancelled = DurablePairingTicketSchema.parse({
        ...ticket,
        state: "cancelled",
        terminalAt: timestamp,
        reason: parsed.reason,
      });
      draft.tickets[index] = cancelled;
      appendAudit(draft, {
        recordedAt: timestamp,
        event: "ticket.cancelled",
        actor: "trusted_user",
        ticketId: ticket.ticketId,
        hostIdentityEpoch: draft.hostIdentityEpoch,
        reason: parsed.reason,
      });
      await this.persistDraft(draft);
      return copyTicket(cancelled);
    });
  }

  async revokeDevice(input: {
    expectedHostId: string;
    expectedHostIdentityEpoch: number;
    fingerprint: string;
    expectedGrantVersion: number;
    reason: string;
  }): Promise<DeviceGrantRecord> {
    const parsed = parseInput(RevokeDeviceInputSchema, input);
    const result = await this.exclusive(async () => {
      const current = this.requireState();
      this.assertHost(current, parsed.expectedHostId);
      this.requireInstalledIdentity(current);
      this.assertHostEpoch(current, parsed.expectedHostIdentityEpoch);
      const draft = cloneState(current);
      const index = this.requireActiveDeviceIndex(draft, parsed.fingerprint);
      const device = draft.devices[index];
      if (!device) throw new PairingAuthorityError("DEVICE_NOT_FOUND", "Paired device does not exist");
      this.assertGrantVersion(device, parsed.expectedGrantVersion);
      const revokedAt = this.nowIso();
      const revoked = DeviceGrantRecordSchema.parse({
        ...device,
        grantVersion: nextGrantVersion(device.grantVersion),
        revokedAt,
        revocationReason: parsed.reason,
      });
      draft.devices[index] = revoked;
      appendAudit(draft, {
        recordedAt: revokedAt,
        event: "device.revoked",
        actor: "trusted_user",
        deviceId: revoked.deviceId,
        fingerprint: revoked.fingerprint,
        grantVersion: revoked.grantVersion,
        hostIdentityEpoch: draft.hostIdentityEpoch,
        scopes: revoked.scopes,
        reason: parsed.reason,
      });
      await this.persistDraft(draft);
      return {
        device: copyDevice(revoked),
        callbacks: this.takeChannelCallbacks(revoked.fingerprint),
      };
    });
    await this.closeChannels(result.callbacks, "device_revoked");
    return result.device;
  }

  async changeDeviceScopes(input: {
    expectedHostId: string;
    expectedHostIdentityEpoch: number;
    fingerprint: string;
    expectedGrantVersion: number;
    scopes: RemoteDeviceScope[];
  }): Promise<DeviceGrantRecord> {
    const parsed = parseInput(ChangeScopesInputSchema, input);
    const scopes = normalizeScopes(parsed.scopes);
    const result = await this.exclusive(async () => {
      const current = this.requireState();
      this.assertHost(current, parsed.expectedHostId);
      this.requireInstalledIdentity(current);
      this.assertHostEpoch(current, parsed.expectedHostIdentityEpoch);
      const draft = cloneState(current);
      const index = this.requireActiveDeviceIndex(draft, parsed.fingerprint);
      const device = draft.devices[index];
      if (!device) throw new PairingAuthorityError("DEVICE_NOT_FOUND", "Paired device does not exist");
      this.assertGrantVersion(device, parsed.expectedGrantVersion);
      const ceiling = new Set<RemoteDeviceScope>(device.scopeCeiling);
      if (scopes.some((scope) => !ceiling.has(scope))) {
        throw new PairingAuthorityError("SCOPE_ESCALATION", "Updated scopes exceed the device's pairing ceiling");
      }
      if (sameScopes(device.scopes, scopes)) {
        return { device: copyDevice(device), callbacks: [] as ChannelCloseCallback[] };
      }
      const changed = DeviceGrantRecordSchema.parse({
        ...device,
        scopes,
        grantVersion: nextGrantVersion(device.grantVersion),
      });
      draft.devices[index] = changed;
      const timestamp = this.nowIso();
      appendAudit(draft, {
        recordedAt: timestamp,
        event: "device.scopes_changed",
        actor: "trusted_user",
        deviceId: changed.deviceId,
        fingerprint: changed.fingerprint,
        grantVersion: changed.grantVersion,
        hostIdentityEpoch: draft.hostIdentityEpoch,
        scopes: changed.scopes,
      });
      await this.persistDraft(draft);
      return {
        device: copyDevice(changed),
        callbacks: this.takeChannelCallbacks(changed.fingerprint),
      };
    });
    await this.closeChannels(result.callbacks, "scopes_changed");
    return result.device;
  }

  async rotateHostIdentity(input: {
    expectedHostId: string;
    expectedHostIdentityEpoch: number;
    identity: HostIdentityInput;
    reason: string;
  }): Promise<HostIdentityMetadata> {
    const parsed = parseInput(RotateIdentityInputSchema, input);
    const nextIdentity = materializeHostIdentity(parsed.identity);
    const result = await this.exclusive(async () => {
      const current = this.requireState();
      this.assertHost(current, parsed.expectedHostId);
      this.requireInstalledIdentity(current);
      this.assertHostEpoch(current, parsed.expectedHostIdentityEpoch);
      if (nextIdentity.identityEpoch !== current.hostIdentityEpoch + 1) {
        throw new PairingAuthorityError("INVALID_IDENTITY_EPOCH", "Host identity rotation must increment the epoch by exactly one");
      }
      if (current.identity?.publicKeyB64u === nextIdentity.publicKeyB64u) {
        throw new PairingAuthorityError("IDENTITY_KEY_REUSED", "Host identity rotation requires a new public key");
      }

      const draft = cloneState(current);
      const timestamp = this.nowIso();
      draft.hostIdentityEpoch = nextIdentity.identityEpoch;
      draft.identity = nextIdentity;
      for (let index = 0; index < draft.tickets.length; index += 1) {
        const ticket = draft.tickets[index];
        if (!ticket || (ticket.state !== "pending" && ticket.state !== "reserved")) continue;
        draft.tickets[index] = DurablePairingTicketSchema.parse({
          ...ticket,
          state: "cancelled",
          terminalAt: timestamp,
          reason: "host_identity_rotated",
        });
        appendAudit(draft, {
          recordedAt: timestamp,
          event: "ticket.cancelled",
          actor: "system",
          ticketId: ticket.ticketId,
          hostIdentityEpoch: draft.hostIdentityEpoch,
          reason: "host_identity_rotated",
        });
      }
      for (let index = 0; index < draft.devices.length; index += 1) {
        const device = draft.devices[index];
        if (!device || device.revokedAt) continue;
        const revoked = DeviceGrantRecordSchema.parse({
          ...device,
          grantVersion: nextGrantVersion(device.grantVersion),
          revokedAt: timestamp,
          revocationReason: "host_identity_rotated",
        });
        draft.devices[index] = revoked;
        appendAudit(draft, {
          recordedAt: timestamp,
          event: "device.revoked",
          actor: "system",
          deviceId: revoked.deviceId,
          fingerprint: revoked.fingerprint,
          grantVersion: revoked.grantVersion,
          hostIdentityEpoch: draft.hostIdentityEpoch,
          scopes: revoked.scopes,
          reason: "host_identity_rotated",
        });
      }
      appendAudit(draft, {
        recordedAt: timestamp,
        event: "identity.rotated",
        actor: "trusted_user",
        fingerprint: nextIdentity.fingerprint,
        hostIdentityEpoch: draft.hostIdentityEpoch,
        reason: parsed.reason,
      });
      await this.persistDraft(draft);
      const callbacks = this.takeAllChannelCallbacks();
      return { identity: { ...nextIdentity }, callbacks };
    });
    await this.closeChannels(result.callbacks, "host_identity_rotated");
    return result.identity;
  }

  /**
   * Authorizes one request through an opaque in-memory lease created only by
   * `registerAuthenticatedChannel()`. The lease is bound to both the canonical
   * routing channel ID and the provider-authenticated device principal.
   */
  async withAuthorizedChannel<T>(
    lease: AuthenticatedChannelLease,
    requiredScope: RemoteDeviceScope,
    operation: (device: Readonly<DeviceGrantRecord>) => Promise<T> | T,
  ): Promise<T> {
    const parsedLease = parseInput(AuthenticatedChannelLeaseSchema, lease);
    const parsedScope = parseInput(RemoteDeviceScopeSchema, requiredScope);
    if (typeof operation !== "function") {
      throw new PairingAuthorityError("INVALID_OPERATION", "Authorized operation callback is required");
    }
    const admittedDevice = await this.exclusive(async () => {
      const state = this.requireState();
      const channel = this.channelLeases.get(parsedLease.leaseId);
      if (!channel || channel.channelId !== parsedLease.channelId) {
        throw new PairingAuthorityError("CHANNEL_LEASE_INVALID", "Authenticated channel lease is missing or no longer active");
      }
      const device = this.authorizePrincipal(state, channel.principal, parsedScope);
      return Object.freeze(copyDevice(device));
    });
    return operation(admittedDevice);
  }

  async registerAuthenticatedChannel(
    session: unknown,
  ): Promise<RegisteredAuthenticatedChannel> {
    const providerEvidence = this.consumeAuthenticatedSession(session);
    if (!providerEvidence || providerEvidence.localRole !== "host") {
      throw new PairingAuthorityError(
        "SECURE_CHANNEL_NOT_VALIDATED",
        "Channel registration requires one unconsumed host-side provider-owned secure-channel capability",
      );
    }

    const close = providerEvidence.close;
    if (typeof close !== "function") {
      throw new PairingAuthorityError(
        "SECURE_CHANNEL_NOT_VALIDATED",
        "Secure-channel evidence is missing its provider-owned close callback",
      );
    }

    let parsed!: AuthenticatedDevicePrincipal;
    let channelId!: string;
    let registration: RegisteredChannel;
    try {
      // Parse into fresh snapshots before the first await. Caller-visible
      // nested objects cannot retarget a consumed provider capability during
      // validation. Every post-consumption failure closes the real channel.
      const transcript = parseInput(SecureChannelTranscriptBindingSchema, providerEvidence.transcript);
      const principalSnapshot = parseInput(AuthenticatedRelayPrincipalSchema, providerEvidence.principal);
      const principal = await validateAuthenticatedRelayPrincipal(principalSnapshot, {
        localRole: "host",
        expectedTranscript: transcript,
      });
      parsed = parseInput(AuthenticatedPrincipalSchema, {
        hostId: principal.hostId,
        fingerprint: principal.peerPublicKeyFingerprint,
        grantVersion: principal.grantVersion,
        hostIdentityEpoch: principal.hostIdentityEpoch,
      });
      channelId = transcript.canonicalChannelId;
      registration = await this.exclusive(async () => {
        const state = this.requireState();
        const identity = this.requireInstalledIdentity(state);
        const device = this.authorizePrincipal(state, parsed);
        if (
          transcript.hostPublicKeyB64u !== identity.publicKeyB64u ||
          transcript.hostIdentityFingerprint !== identity.fingerprint ||
          transcript.devicePublicKeyB64u !== device.publicKeyB64u ||
          transcript.deviceKeyFingerprint !== device.fingerprint ||
          transcript.proposedDeviceId !== device.deviceId ||
          !sameStringArray(transcript.requestedScopes, device.scopeCeiling) ||
          !sameStringArray(transcript.grantedScopes, device.scopes)
        ) {
          throw new PairingAuthorityError(
            "SECURE_CHANNEL_AUTHORITY_MISMATCH",
            "Validated secure-channel transcript does not match the current durable host and device grant",
          );
        }
        const existing = this.channels.get(parsed.fingerprint);
        if (existing?.has(channelId)) {
          throw new PairingAuthorityError("CHANNEL_ID_REUSED", "Channel ID is already registered for this device");
        }
        if ((existing?.size ?? 0) >= MAX_CHANNELS_PER_DEVICE || this.activeChannelCount() >= MAX_ACTIVE_CHANNELS) {
          throw new PairingAuthorityError("CHANNEL_QUOTA_REACHED", "Authenticated channel quota has been reached");
        }
        const leaseId = this.newChannelLeaseId();
        const deviceChannels = existing ?? new Map<string, RegisteredChannel>();
        const channel: RegisteredChannel = {
          channelId,
          leaseId,
          principal: {
            hostId: parsed.hostId,
            fingerprint: parsed.fingerprint,
            grantVersion: parsed.grantVersion,
            hostIdentityEpoch: parsed.hostIdentityEpoch,
          },
          close,
        };
        deviceChannels.set(channelId, channel);
        this.channels.set(parsed.fingerprint, deviceChannels);
        this.channelLeases.set(leaseId, channel);
        return channel;
      });
    } catch (error) {
      await this.closeChannels([close], "secure_channel_rejected");
      throw error;
    }

    const lease = Object.freeze({ leaseId: registration.leaseId, channelId: registration.channelId });
    return {
      lease,
      unregister: async () => {
        await this.exclusive(async () => {
          const deviceChannels = this.channels.get(parsed.fingerprint);
          const registered = deviceChannels?.get(channelId);
          if (registered !== registration) return;
          deviceChannels?.delete(channelId);
          this.channelLeases.delete(registration.leaseId);
          if (deviceChannels?.size === 0) this.channels.delete(parsed.fingerprint);
        });
      },
    };
  }

  private requireVerifiedPairingCeremony<TPhase extends VerifiedPairingCeremonyEvidence["phase"]>(
    capability: unknown,
    phase: TPhase,
  ): Extract<VerifiedPairingCeremonyEvidence, { phase: TPhase }> {
    let evidence: VerifiedPairingCeremonyEvidence | undefined;
    try {
      evidence = this.consumeVerifiedPairingCeremony(capability);
    } catch (cause) {
      throw new PairingAuthorityError(
        "PAIRING_CEREMONY_ADMISSION_FAILED",
        "The verified pairing provider could not validate this one-shot ceremony capability",
        { cause },
      );
    }
    if (!evidence || evidence.phase !== phase) {
      throw new PairingAuthorityError(
        "PAIRING_CEREMONY_NOT_VERIFIED",
        "Pairing cannot cross this authority boundary without provider-owned one-shot ceremony evidence",
      );
    }
    return evidence as Extract<VerifiedPairingCeremonyEvidence, { phase: TPhase }>;
  }

  private authorizePrincipal(
    state: PairingAuthoritySnapshot,
    principal: AuthenticatedDevicePrincipal,
    requiredScope?: RemoteDeviceScope,
  ): DeviceGrantRecord {
    this.assertHost(state, principal.hostId);
    this.requireInstalledIdentity(state);
    this.assertHostEpoch(state, principal.hostIdentityEpoch);
    const device = state.devices.find((item) => item.fingerprint === principal.fingerprint);
    if (!device) throw new PairingAuthorityError("DEVICE_NOT_FOUND", "Authenticated device is not paired with this host");
    if (device.revokedAt) throw new PairingAuthorityError("DEVICE_REVOKED", "Authenticated device has been revoked");
    if (device.hostIdentityEpoch !== state.hostIdentityEpoch) {
      throw new PairingAuthorityError("STALE_IDENTITY_EPOCH", "Device was paired under another host identity epoch");
    }
    this.assertGrantVersion(device, principal.grantVersion);
    if (requiredScope && !device.scopes.includes(requiredScope)) {
      throw new PairingAuthorityError("REMOTE_SCOPE_DENIED", `Device is not authorized for ${requiredScope}`);
    }
    return device;
  }

  private requireActiveDeviceIndex(state: PairingAuthoritySnapshot, fingerprint: string): number {
    const index = state.devices.findIndex((device) => device.fingerprint === fingerprint);
    if (index < 0) throw new PairingAuthorityError("DEVICE_NOT_FOUND", "Paired device does not exist");
    const device = state.devices[index];
    if (!device) throw new PairingAuthorityError("DEVICE_NOT_FOUND", "Paired device does not exist");
    if (device.revokedAt) throw new PairingAuthorityError("DEVICE_REVOKED", "Paired device is already revoked");
    return index;
  }

  private assertHost(state: PairingAuthoritySnapshot, expectedHostId: string): void {
    if (state.hostId !== expectedHostId) {
      throw new PairingAuthorityError("HOST_AUTHORITY_MISMATCH", "Pairing operation belongs to another host authority");
    }
  }

  private assertHostEpoch(state: PairingAuthoritySnapshot, expectedEpoch: number): void {
    if (state.hostIdentityEpoch !== expectedEpoch) {
      throw new PairingAuthorityError("STALE_IDENTITY_EPOCH", "Host identity epoch changed; authenticate a new channel");
    }
  }

  private requireInstalledIdentity(state: PairingAuthoritySnapshot): HostIdentityMetadata {
    if (!state.identity) {
      throw new PairingAuthorityError(
        "HOST_IDENTITY_REQUIRED",
        "Pairing remains disabled until the host identity provider installs public identity metadata",
      );
    }
    return state.identity;
  }

  private assertTicketEpoch(state: PairingAuthoritySnapshot, ticket: DurablePairingTicket): void {
    if (ticket.hostIdentityEpoch !== state.hostIdentityEpoch) {
      throw new PairingAuthorityError(
        "STALE_TICKET_IDENTITY_EPOCH",
        "Pairing ticket was created under another host identity epoch",
      );
    }
  }

  private assertGrantVersion(device: DeviceGrantRecord, expectedVersion: number): void {
    if (device.grantVersion !== expectedVersion) {
      throw new PairingAuthorityError("STALE_GRANT_VERSION", "Device grant changed; authenticate a new channel");
    }
  }

  private isExpired(ticket: DurablePairingTicket): boolean {
    return this.nowDate().getTime() >= Date.parse(ticket.expiresAt);
  }

  private nowDate(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new PairingAuthorityError("INVALID_CLOCK", "Pairing authority clock returned an invalid date");
    }
    return value;
  }

  private nowIso(): string {
    return this.nowDate().toISOString();
  }

  private requireState(): PairingAuthoritySnapshot {
    if (this.fatalError) throw this.fatalError;
    if (!this.initialized || !this.state) {
      throw new PairingAuthorityError("AUTHORITY_NOT_INITIALIZED", "PairingAuthority.initialize() must run first");
    }
    return this.state;
  }

  private copyState(): PairingAuthoritySnapshot {
    return PairingAuthorityStateSchema.parse(cloneState(this.requireState()));
  }

  private async persistDraft(draft: PairingAuthoritySnapshot): Promise<void> {
    const current = this.requireState();
    draft.revision = current.revision + 1;
    const validated = PairingAuthorityStateSchema.parse(draft);
    try {
      await this.writeState(this.stateFile, validated);
    } catch (error) {
      if (error instanceof AtomicWriteAmbiguousCommitError) {
        const fatal = new PairingAuthorityError(
          "AUTHORITY_PERSISTENCE_UNCERTAIN",
          "Pairing authority durability is uncertain; this process is fail-closed until restart",
          { cause: error },
        );
        this.fatalError = fatal;
        this.initialized = false;
        this.state = undefined;
        const callbacks = this.takeAllChannelCallbacks();
        void this.closeChannels(callbacks, "authority_persistence_uncertain");
        throw fatal;
      }
      throw error;
    }
    this.state = validated;
  }

  private takeChannelCallbacks(fingerprint: string): ChannelCloseCallback[] {
    const registered = [...(this.channels.get(fingerprint)?.values() ?? [])];
    const callbacks = registered.map((channel) => channel.close);
    for (const channel of registered) this.channelLeases.delete(channel.leaseId);
    this.channels.delete(fingerprint);
    return callbacks;
  }

  private takeAllChannelCallbacks(): ChannelCloseCallback[] {
    const registered = [...this.channels.values()].flatMap((channels) => [...channels.values()]);
    const callbacks = registered.map((channel) => channel.close);
    this.channelLeases.clear();
    this.channels.clear();
    return callbacks;
  }

  private newChannelLeaseId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = randomBytes(32).toString("base64url");
      if (!this.channelLeases.has(candidate)) return candidate;
    }
    throw new PairingAuthorityError("CHANNEL_LEASE_COLLISION", "Could not allocate a unique authenticated channel lease");
  }

  private newTicketId(state: PairingAuthoritySnapshot): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `ticket-${randomBytes(32).toString("base64url")}`;
      if (!state.tickets.some((ticket) => ticket.ticketId === candidate)) return candidate;
    }
    throw new PairingAuthorityError("TICKET_ID_COLLISION", "Could not allocate a unique pairing ticket ID");
  }

  private async closeChannels(
    callbacks: readonly ChannelCloseCallback[],
    reason: ChannelClosureReason,
  ): Promise<void> {
    const diagnostics = await invokeChannelCallbacks(callbacks, reason);
    for (const diagnostic of diagnostics) {
      try {
        this.onChannelCloseFailure?.(diagnostic);
      } catch {
        // Diagnostics must never change durable authorization or shutdown.
      }
    }
  }

  private activeChannelCount(): number {
    let count = 0;
    for (const channels of this.channels.values()) count += channels.size;
    return count;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function deriveNoisePublicKeyFingerprint(publicKeyB64u: string): string {
  const parsed = Base64Url32Schema.safeParse(publicKeyB64u);
  if (!parsed.success) {
    throw new PairingAuthorityError("INVALID_PUBLIC_KEY", "Noise public key must be canonical base64url encoding of 32 bytes");
  }
  return deriveNoisePublicKeyFingerprintUnchecked(parsed.data);
}

export function derivePairingDeviceIdentity(publicKeyB64u: string): {
  deviceId: string;
  fingerprint: string;
} {
  const parsed = Base64Url32Schema.safeParse(publicKeyB64u);
  if (!parsed.success) {
    throw new PairingAuthorityError("INVALID_PUBLIC_KEY", "Noise public key must be canonical base64url encoding of 32 bytes");
  }
  return derivePairingDeviceIdentityUnchecked(parsed.data);
}

function derivePairingDeviceIdentityUnchecked(publicKeyB64u: string): {
  deviceId: string;
  fingerprint: string;
} {
  const publicKey = Buffer.from(publicKeyB64u, "base64url");
  const deviceDigest = createHash("sha256")
    .update("PrimeAgent paired device id v1\0", "utf8")
    .update(publicKey)
    .digest("base64url");
  return {
    deviceId: `device-${deviceDigest}`,
    fingerprint: deriveNoisePublicKeyFingerprintUnchecked(publicKeyB64u),
  };
}

function deriveNoisePublicKeyFingerprintUnchecked(publicKeyB64u: string): string {
  const publicKey = Buffer.from(publicKeyB64u, "base64url");
  const digest = createHash("sha256")
    .update("PrimeAgent Noise_25519 public key v1\0", "utf8")
    .update(publicKey)
    .digest("base64url");
  return `pa1-${digest}`;
}

function materializeHostIdentity(input: HostIdentityInput): HostIdentityMetadata {
  const parsed = HostIdentityInputSchema.parse(input);
  return HostIdentityMetadataSchema.parse({
    ...parsed,
    fingerprint: deriveNoisePublicKeyFingerprintUnchecked(parsed.publicKeyB64u),
  });
}

function sameHostIdentity(left: HostIdentityMetadata, right: HostIdentityMetadata): boolean {
  return (
    left.identityEpoch === right.identityEpoch &&
    left.algorithm === right.algorithm &&
    left.publicKeyB64u === right.publicKeyB64u &&
    left.fingerprint === right.fingerprint &&
    left.secretRef === right.secretRef
  );
}

function normalizeScopes(scopes: readonly RemoteDeviceScope[]): RemoteDeviceScope[] {
  const parsed = InputScopeArraySchema.safeParse(scopes);
  if (!parsed.success || new Set(parsed.success ? parsed.data : []).size !== scopes.length) {
    throw new PairingAuthorityError("INVALID_SCOPES", "Device scopes must be a bounded, non-empty, unique set");
  }
  return [...parsed.data].sort();
}

function sameScopes(left: readonly RemoteDeviceScope[], right: readonly RemoteDeviceScope[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function expireDueTickets(state: PairingAuthoritySnapshot, nowMilliseconds: number, timestamp: string): number {
  let expired = 0;
  for (let index = 0; index < state.tickets.length; index += 1) {
    const ticket = state.tickets[index];
    if (
      !ticket ||
      (ticket.state !== "pending" && ticket.state !== "reserved") ||
      nowMilliseconds < Date.parse(ticket.expiresAt)
    ) {
      continue;
    }
    state.tickets[index] = DurablePairingTicketSchema.parse({
      ...ticket,
      state: "expired",
      terminalAt: timestamp,
      reason: "ticket_expired",
    });
    appendAudit(state, {
      recordedAt: timestamp,
      event: "ticket.expired",
      actor: "system",
      ticketId: ticket.ticketId,
      hostIdentityEpoch: state.hostIdentityEpoch,
      reason: "ticket_expired",
    });
    expired += 1;
  }
  return expired;
}

function compactRetiredHistoryRecords(
  state: PairingAuthoritySnapshot,
  nowMilliseconds: number,
): { tickets: number; devices: number } {
  const ticketCount = state.tickets.length;
  state.tickets = state.tickets.filter((ticket) => {
    if (!ticket.terminalAt) return true;
    return nowMilliseconds - Date.parse(ticket.terminalAt) < TERMINAL_TICKET_RETENTION_MS;
  });
  const deviceCount = state.devices.length;
  state.devices = state.devices.filter((device) => {
    if (!device.revokedAt) return true;
    return nowMilliseconds - Date.parse(device.revokedAt) < REVOKED_DEVICE_RETENTION_MS;
  });
  return { tickets: ticketCount - state.tickets.length, devices: deviceCount - state.devices.length };
}

function appendHistoryCompactionAudit(
  state: PairingAuthoritySnapshot,
  timestamp: string,
  compacted: { tickets: number; devices: number },
): void {
  appendAudit(state, {
    recordedAt: timestamp,
    event: "history.compacted",
    actor: "system",
    hostIdentityEpoch: state.hostIdentityEpoch,
    reason: `terminal_tickets=${compacted.tickets};revoked_devices=${compacted.devices}`,
  });
}

function nextGrantVersion(current: number): number {
  if (current >= MAX_GRANT_VERSION) {
    throw new PairingAuthorityError("GRANT_VERSION_EXHAUSTED", "Device grant version cannot be incremented safely");
  }
  return current + 1;
}

function appendAudit(
  state: PairingAuthoritySnapshot,
  input: Omit<PairingAuditEvent, "version" | "sequence" | "eventId" | "previousHash" | "recordHash">,
): void {
  const sequence = state.nextAuditSequence;
  if (sequence >= Number.MAX_SAFE_INTEGER) {
    throw new PairingAuthorityError("AUDIT_SEQUENCE_EXHAUSTED", "Pairing audit sequence cannot be incremented safely");
  }
  const previousHash = state.audits.at(-1)?.recordHash ?? state.auditAnchorHash;
  const base = {
    version: 1 as const,
    sequence,
    eventId: `audit-${sequence}`,
    previousHash,
    ...input,
  };
  const record = PairingAuditEventSchema.parse({
    ...base,
    recordHash: hashAuditEvent(base),
  });
  state.audits.push(record);
  state.nextAuditSequence += 1;
  while (state.audits.length > MAX_PAIRING_AUDIT_EVENTS) {
    const removed = state.audits.shift();
    if (removed) state.auditAnchorHash = removed.recordHash;
  }
}

function hashAuditEvent(
  event: Omit<PairingAuditEvent, "recordHash"> | PairingAuditEvent,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        event.version,
        event.sequence,
        event.eventId,
        event.previousHash,
        event.recordedAt,
        event.event,
        event.actor,
        event.ticketId ?? null,
        event.deviceId ?? null,
        event.fingerprint ?? null,
        event.grantVersion ?? null,
        event.hostIdentityEpoch,
        event.scopes ?? null,
        event.reason ?? null,
      ]),
      "utf8",
    )
    .digest("base64url");
}

function validateUnique(values: readonly string[], label: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `Pairing state contains a duplicate ${label}` });
  }
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.join(".") || "root";
    throw new PairingAuthorityError(
      "INVALID_INPUT",
      `Invalid pairing authority input at ${location}: ${issue?.message ?? "validation failed"}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function cloneState(state: PairingAuthoritySnapshot): PairingAuthoritySnapshot {
  return structuredClone(state);
}

function copyTicket(ticket: DurablePairingTicket): DurablePairingTicket {
  return DurablePairingTicketSchema.parse(structuredClone(ticket));
}

function copyDevice(device: DeviceGrantRecord): DeviceGrantRecord {
  return DeviceGrantRecordSchema.parse(structuredClone(device));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function invokeChannelCallbacks(
  callbacks: readonly ChannelCloseCallback[],
  reason: ChannelClosureReason,
): Promise<ChannelCloseFailureDiagnostic[]> {
  const results = await Promise.allSettled(
    callbacks.map(async (callback) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => callback(reason)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new PairingAuthorityError("CHANNEL_CLOSE_TIMEOUT", "Authenticated channel did not close in time")),
              CHANNEL_CLOSE_TIMEOUT_MS,
            );
            timer.unref();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
  return results.flatMap((result, callbackIndex) => {
    if (result.status === "fulfilled") return [];
    const error = result.reason;
    const timeout = error instanceof PairingAuthorityError && error.code === "CHANNEL_CLOSE_TIMEOUT";
    return [
      {
        reason,
        callbackIndex,
        code: timeout ? "CHANNEL_CLOSE_TIMEOUT" : "CHANNEL_CLOSE_REJECTED",
        message: error instanceof Error ? error.message.slice(0, 512) : "Authenticated channel close failed",
      } satisfies ChannelCloseFailureDiagnostic,
    ];
  });
}
