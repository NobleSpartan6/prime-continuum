import { z } from "zod";
import { IdSchema, RelayOriginSchema, RemoteDeviceScopeSchema, type RemoteDeviceScope } from "./protocol";
import type { RelayRoutingFrame } from "./relay-routing";

const BASE64URL_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const Base64Url32Schema = z
  .string()
  .length(43)
  .regex(BASE64URL_SHA256_PATTERN, "Must be canonical unpadded base64url for 32 bytes")
  .refine((value) => {
    try {
      const decoded = base64UrlToBytes(value);
      return decoded.byteLength === 32 && bytesToBase64Url(decoded) === value;
    } catch {
      return false;
    }
  }, "Must canonically encode exactly 32 bytes");
const BindingHashSchema = Base64Url32Schema;
const FingerprintSchema = z.string().regex(/^pa1-[A-Za-z0-9_-]{43}$/);
const CanonicalChannelIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
const IdentityEpochSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const GrantVersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const SortedScopeArraySchema = z
  .array(RemoteDeviceScopeSchema)
  .min(1)
  .max(8)
  .superRefine((scopes, context) => {
    if (new Set(scopes).size !== scopes.length || scopes.some((scope, index) => index > 0 && scopes[index - 1]! >= scope)) {
      context.addIssue({ code: "custom", message: "Scopes must be unique and sorted lexically" });
    }
  });
const SortedCapabilityArraySchema = z
  .array(z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*_v[1-9][0-9]*$/))
  .max(32)
  .superRefine((capabilities, context) => {
    if (
      new Set(capabilities).size !== capabilities.length ||
      capabilities.some((capability, index) => index > 0 && capabilities[index - 1]! >= capability)
    ) {
      context.addIssue({ code: "custom", message: "Capabilities must be unique and sorted lexically" });
    }
  });

export const REQUIRED_SECURE_CHANNEL_CAPABILITIES = ["relay_pairing_v1"] as const;

/**
 * Opaque reference resolved by a platform connector. Bearer credentials never
 * cross this shared contract or enter renderer/projection state.
 */
export interface RelayCredentialHandle {
  readonly kind: "platform_secret" | "test_only";
  readonly reference: string;
}

export interface RelayWireConnector {
  connect(input: {
    origin: string;
    credential: RelayCredentialHandle;
    signal: AbortSignal;
  }): Promise<RelayWireConnection>;
}

export interface RelayWireConnection {
  readonly messages: AsyncIterable<RelayRoutingFrame>;
  readonly bufferedBytes: number;
  send(frame: RelayRoutingFrame): Promise<void>;
  close(code?: number, reason?: string): void;
}

/**
 * Identity produced only by a reviewed authenticated secure-channel endpoint.
 * Relay routing metadata must never be converted into this principal.
 */
export const AuthenticatedRelayPrincipalSchema = z
  .object({
    hostId: IdSchema,
    peerPublicKeyFingerprint: FingerprintSchema,
    canonicalChannelId: CanonicalChannelIdSchema,
    grantVersion: GrantVersionSchema,
    hostIdentityEpoch: IdentityEpochSchema,
    transcriptBindingHash: BindingHashSchema,
  })
  .strict();
export type AuthenticatedRelayPrincipal = z.infer<typeof AuthenticatedRelayPrincipalSchema>;

/**
 * Values a reviewed crypto provider must authenticate in the handshake
 * transcript before it can produce an AuthenticatedRelayPrincipal. Fixed
 * initiator/responder roles keep both endpoints' canonical transcript bytes
 * identical; `localRole` belongs to the factory call, not the transcript.
 */
const SecureChannelTranscriptBindingBaseSchema = z
  .object({
    applicationProtocol: z.literal("prime-agent.remote.v1"),
    handshakeProtocolVersion: z.literal(1),
    relayProtocol: z.literal("prime-relay-routing.v1"),
    initiatorRole: z.literal("device"),
    responderRole: z.literal("host"),
    relayOrigin: RelayOriginSchema,
    relayRouteId: IdSchema,
    relayRouteBindingHash: BindingHashSchema,
    canonicalChannelId: CanonicalChannelIdSchema,
    hostId: IdSchema,
    hostPublicKeyB64u: Base64Url32Schema,
    hostIdentityFingerprint: FingerprintSchema,
    hostIdentityEpoch: IdentityEpochSchema,
    devicePublicKeyB64u: Base64Url32Schema,
    deviceKeyFingerprint: FingerprintSchema,
    proposedDeviceId: IdSchema,
    hostEphemeralPublicKeyB64u: Base64Url32Schema,
    deviceEphemeralPublicKeyB64u: Base64Url32Schema,
    attemptId: IdSchema,
    negotiatedCapabilities: SortedCapabilityArraySchema,
    requestedScopes: SortedScopeArraySchema,
    grantedScopes: SortedScopeArraySchema,
    expectedGrantVersion: GrantVersionSchema,
    hostConfirmation: z.literal("confirmed"),
    deviceConfirmation: z.literal("confirmed"),
  })
  .strict();

export const PairingTranscriptBindingSchema = SecureChannelTranscriptBindingBaseSchema.extend({
  handshakePattern: z.literal("Noise_XKpsk3_25519_ChaChaPoly_BLAKE2s"),
  ticketId: IdSchema,
  ticketContextHash: BindingHashSchema,
}).strict();

export const ReconnectTranscriptBindingSchema = SecureChannelTranscriptBindingBaseSchema.extend({
  handshakePattern: z.literal("Noise_IK_25519_ChaChaPoly_BLAKE2s"),
  expectedDeviceKeyFingerprint: FingerprintSchema,
}).strict();

export const SecureChannelTranscriptBindingSchema = z
  .discriminatedUnion("handshakePattern", [PairingTranscriptBindingSchema, ReconnectTranscriptBindingSchema])
  .superRefine((binding, context) => {
    const requested = new Set(binding.requestedScopes);
    if (binding.grantedScopes.some((scope) => !requested.has(scope))) {
      context.addIssue({ code: "custom", path: ["grantedScopes"], message: "Granted scopes must be a subset of requested scopes" });
    }
    for (const capability of REQUIRED_SECURE_CHANNEL_CAPABILITIES) {
      if (!binding.negotiatedCapabilities.includes(capability)) {
        context.addIssue({
          code: "custom",
          path: ["negotiatedCapabilities"],
          message: `Secure channel requires negotiated capability ${capability}`,
        });
      }
    }
    if (
      binding.handshakePattern === "Noise_IK_25519_ChaChaPoly_BLAKE2s" &&
      binding.expectedDeviceKeyFingerprint !== binding.deviceKeyFingerprint
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedDeviceKeyFingerprint"],
        message: "Reconnect device fingerprint must match the authenticated device key",
      });
    }
  });
export type SecureChannelTranscriptBinding = z.infer<typeof SecureChannelTranscriptBindingSchema>;

/** A digest seam lets audited native crypto supply SHA-256 without moving keys into shared code. */
export type TranscriptSha256 = (canonicalBytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;

/**
 * Produces stable, versioned transcript bytes. The array form makes field
 * order explicit and avoids relying on JavaScript object-key ordering.
 */
export function canonicalSecureChannelTranscriptBytes(input: SecureChannelTranscriptBinding): Uint8Array {
  const binding = SecureChannelTranscriptBindingSchema.parse(input);
  const common = [
    "PrimeAgent secure channel transcript binding v1",
    binding.applicationProtocol,
    binding.handshakeProtocolVersion,
    binding.relayProtocol,
    binding.handshakePattern,
    binding.initiatorRole,
    binding.responderRole,
    binding.relayOrigin,
    binding.relayRouteId,
    binding.relayRouteBindingHash,
    binding.canonicalChannelId,
    binding.hostId,
    binding.hostPublicKeyB64u,
    binding.hostIdentityFingerprint,
    binding.hostIdentityEpoch,
    binding.devicePublicKeyB64u,
    binding.deviceKeyFingerprint,
    binding.proposedDeviceId,
    binding.hostEphemeralPublicKeyB64u,
    binding.deviceEphemeralPublicKeyB64u,
    binding.attemptId,
    binding.negotiatedCapabilities,
    binding.requestedScopes,
    binding.grantedScopes,
    binding.expectedGrantVersion,
    binding.hostConfirmation,
    binding.deviceConfirmation,
  ] as const;
  const patternSpecific =
    binding.handshakePattern === "Noise_XKpsk3_25519_ChaChaPoly_BLAKE2s"
      ? [binding.ticketId, binding.ticketContextHash]
      : [binding.expectedDeviceKeyFingerprint];
  return new TextEncoder().encode(JSON.stringify([...common, ...patternSpecific]));
}

export async function deriveSecureChannelTranscriptBindingHash(
  input: SecureChannelTranscriptBinding,
  digest: TranscriptSha256 = defaultSha256,
): Promise<string> {
  const binding = await validateSecureChannelTranscriptBinding(input, digest);
  const bytes = await digest(canonicalSecureChannelTranscriptBytes(binding));
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new TypeError("Transcript SHA-256 provider must return exactly 32 bytes");
  }
  return bytesToBase64Url(bytes);
}

export async function validateSecureChannelTranscriptBinding(
  input: SecureChannelTranscriptBinding,
  digest: TranscriptSha256 = defaultSha256,
): Promise<SecureChannelTranscriptBinding> {
  const binding = SecureChannelTranscriptBindingSchema.parse(input);
  const [hostFingerprint, deviceFingerprint, deviceId, routeBindingHash] = await Promise.all([
    deriveNoisePublicKeyFingerprint(binding.hostPublicKeyB64u, digest),
    deriveNoisePublicKeyFingerprint(binding.devicePublicKeyB64u, digest),
    derivePairedDeviceId(binding.devicePublicKeyB64u, digest),
    deriveRelayRouteBindingHash(
      { relayOrigin: binding.relayOrigin, relayRouteId: binding.relayRouteId },
      digest,
    ),
  ]);
  if (
    binding.hostIdentityFingerprint !== hostFingerprint ||
    binding.deviceKeyFingerprint !== deviceFingerprint ||
    binding.proposedDeviceId !== deviceId ||
    binding.relayRouteBindingHash !== routeBindingHash
  ) {
    throw new Error("Secure-channel transcript identity or route binding is inconsistent");
  }
  if (binding.handshakePattern === "Noise_XKpsk3_25519_ChaChaPoly_BLAKE2s") {
    const expectedTicketContextHash = await derivePairingTicketContextHash(
      {
        ticketId: binding.ticketId,
        attemptId: binding.attemptId,
        relayRouteBindingHash: binding.relayRouteBindingHash,
      },
      digest,
    );
    if (binding.ticketContextHash !== expectedTicketContextHash) {
      throw new Error("Secure-channel pairing ticket context binding is inconsistent");
    }
  }
  return binding;
}

export async function deriveNoisePublicKeyFingerprint(
  publicKeyB64u: string,
  digest: TranscriptSha256 = defaultSha256,
): Promise<string> {
  const publicKey = base64UrlToBytes(Base64Url32Schema.parse(publicKeyB64u));
  return `pa1-${bytesToBase64Url(await checkedDigest(digest, concatBytes(textBytes("PrimeAgent Noise_25519 public key v1\0"), publicKey)))}`;
}

export async function derivePairedDeviceId(
  publicKeyB64u: string,
  digest: TranscriptSha256 = defaultSha256,
): Promise<string> {
  const publicKey = base64UrlToBytes(Base64Url32Schema.parse(publicKeyB64u));
  return `device-${bytesToBase64Url(await checkedDigest(digest, concatBytes(textBytes("PrimeAgent paired device id v1\0"), publicKey)))}`;
}

export async function deriveRelayRouteBindingHash(
  input: { relayOrigin: string; relayRouteId: string },
  digest: TranscriptSha256 = defaultSha256,
): Promise<string> {
  const relayOrigin = RelayOriginSchema.parse(input.relayOrigin);
  const relayRouteId = IdSchema.parse(input.relayRouteId);
  return bytesToBase64Url(
    await checkedDigest(
      digest,
      textBytes(JSON.stringify(["PrimeAgent relay route binding v1", relayOrigin, relayRouteId])),
    ),
  );
}

export async function derivePairingTicketContextHash(
  input: { ticketId: string; attemptId: string; relayRouteBindingHash: string },
  digest: TranscriptSha256 = defaultSha256,
): Promise<string> {
  const ticketId = IdSchema.parse(input.ticketId);
  const attemptId = IdSchema.parse(input.attemptId);
  const relayRouteBindingHash = BindingHashSchema.parse(input.relayRouteBindingHash);
  return bytesToBase64Url(
    await checkedDigest(
      digest,
      textBytes(
        JSON.stringify([
          "PrimeAgent pairing ticket context binding v1",
          ticketId,
          attemptId,
          relayRouteBindingHash,
        ]),
      ),
    ),
  );
}

/**
 * Independently checks that a provider result is bound to the exact expected
 * transcript and peer role before a caller registers an authenticated channel.
 */
export async function validateAuthenticatedRelayPrincipal(
  principalInput: AuthenticatedRelayPrincipal,
  input: {
    localRole: "host" | "device";
    expectedTranscript: SecureChannelTranscriptBinding;
    digest?: TranscriptSha256;
  },
): Promise<AuthenticatedRelayPrincipal> {
  const principal = AuthenticatedRelayPrincipalSchema.parse(principalInput);
  const transcript = await validateSecureChannelTranscriptBinding(input.expectedTranscript, input.digest);
  const expectedHash = await deriveSecureChannelTranscriptBindingHash(transcript, input.digest);
  const expectedPeerFingerprint =
    input.localRole === "host" ? transcript.deviceKeyFingerprint : transcript.hostIdentityFingerprint;
  if (
    principal.hostId !== transcript.hostId ||
    principal.peerPublicKeyFingerprint !== expectedPeerFingerprint ||
    principal.canonicalChannelId !== transcript.canonicalChannelId ||
    principal.grantVersion !== transcript.expectedGrantVersion ||
    principal.hostIdentityEpoch !== transcript.hostIdentityEpoch ||
    principal.transcriptBindingHash !== expectedHash
  ) {
    throw new Error("Authenticated relay principal does not match the expected secure-channel transcript");
  }
  return principal;
}

export interface AuthenticatedSecureChannel {
  readonly principal: AuthenticatedRelayPrincipal;
  readonly plaintext: AsyncIterable<Uint8Array>;
  sendPlaintext(bytes: Uint8Array): Promise<void>;
  close(reason?: string): void | Promise<void>;
}

/**
 * Complete provider-owned result produced only after the interactive
 * handshake finishes. Unlike a handshake policy, this result contains the
 * actual authenticated transcript, including both ephemeral keys and both
 * human-confirmation outcomes.
 *
 * This structural result is deliberately not admission authority. Hostd must
 * consume an opaque one-shot capability owned by the selected crypto provider
 * before it can register a relay channel.
 */
export interface EstablishedAuthenticatedRelaySession {
  readonly localRole: "host" | "device";
  readonly transcript: SecureChannelTranscriptBinding;
  readonly principal: AuthenticatedRelayPrincipal;
  readonly channel: AuthenticatedSecureChannel;
}

/**
 * Duplex encrypted-record transport supplied by the opaque relay connector.
 * A secure-channel provider cannot complete an interactive handshake without
 * an outbound record sink; relay routing frames never become principals.
 */
export interface RelayPeerWire {
  readonly encryptedRecords: AsyncIterable<Uint8Array>;
  sendEncryptedRecord(record: Uint8Array): Promise<void>;
  close(reason?: string): void | Promise<void>;
}

/**
 * Values known locally before the interactive handshake begins. Ephemeral
 * keys, negotiated output, peer confirmation, and the final transcript are
 * intentionally absent: they must come from the reviewed provider result.
 */
interface SecureChannelHandshakePolicyBase {
  readonly applicationProtocol: "prime-agent.remote.v1";
  readonly handshakeProtocolVersion: 1;
  readonly relayProtocol: "prime-relay-routing.v1";
  readonly localRole: "host" | "device";
  readonly relayOrigin: string;
  readonly relayRouteId: string;
  readonly canonicalChannelId: string;
  readonly expectedHostId: string;
  readonly expectedHostIdentityEpoch: number;
  readonly expectedHostIdentityFingerprint?: string;
  readonly attemptId: string;
  readonly requiredCapabilities: readonly string[];
  readonly requestedScopes: readonly RemoteDeviceScope[];
  readonly scopeCeiling: readonly RemoteDeviceScope[];
}

export interface PairingSecureChannelHandshakePolicy extends SecureChannelHandshakePolicyBase {
  readonly mode: "pairing";
  readonly ticketId: string;
  readonly expectedPeerPublicKeyFingerprint?: never;
  readonly expectedGrantVersion?: never;
}

export interface ReconnectSecureChannelHandshakePolicy extends SecureChannelHandshakePolicyBase {
  readonly mode: "reconnect";
  readonly ticketId?: never;
  readonly expectedPeerPublicKeyFingerprint: string;
  readonly expectedGrantVersion: number;
}

export type SecureChannelHandshakePolicy =
  | PairingSecureChannelHandshakePolicy
  | ReconnectSecureChannelHandshakePolicy;

export interface SecureRelayChannelFactory {
  accept(input: {
    policy: SecureChannelHandshakePolicy;
    wire: RelayPeerWire;
    signal: AbortSignal;
  }): Promise<EstablishedAuthenticatedRelaySession>;
}

async function defaultSha256(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return new Uint8Array(digest);
}

async function checkedDigest(digest: TranscriptSha256, bytes: Uint8Array): Promise<Uint8Array> {
  const result = await digest(bytes);
  if (!(result instanceof Uint8Array) || result.byteLength !== 32) {
    throw new TypeError("Transcript SHA-256 provider must return exactly 32 bytes");
  }
  return result;
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
