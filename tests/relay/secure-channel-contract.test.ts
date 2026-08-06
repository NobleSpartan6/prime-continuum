import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SecureChannelTranscriptBindingSchema,
  canonicalSecureChannelTranscriptBytes,
  deriveNoisePublicKeyFingerprint,
  derivePairedDeviceId,
  derivePairingTicketContextHash,
  deriveRelayRouteBindingHash,
  deriveSecureChannelTranscriptBindingHash,
  validateAuthenticatedRelayPrincipal,
  type SecureChannelTranscriptBinding,
  type TranscriptSha256,
} from "../../src/shared/relay-transport";

const sha256: TranscriptSha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());

describe("secure relay channel contract", () => {
  it("canonically serializes and hashes every authenticated pairing binding", async () => {
    const binding = await pairingBinding();
    const baselineBytes = canonicalSecureChannelTranscriptBytes(binding);
    const baselineHash = await deriveSecureChannelTranscriptBindingHash(binding, sha256);
    const reordered = Object.fromEntries(Object.entries(binding).reverse()) as SecureChannelTranscriptBinding;

    expect(canonicalSecureChannelTranscriptBytes(reordered)).toEqual(baselineBytes);
    expect(baselineHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(deriveSecureChannelTranscriptBindingHash(binding)).resolves.toBe(baselineHash);

    const variants: Array<[string, SecureChannelTranscriptBinding]> = [
      ["relay origin", { ...binding, relayOrigin: "wss://relay-2.example.test" }],
      ["route id", { ...binding, relayRouteId: "route-2" }],
      ["route binding", { ...binding, relayRouteBindingHash: b64(20) }],
      ["channel", { ...binding, canonicalChannelId: "10000000000000000000000000000001" }],
      ["host id", { ...binding, hostId: "host-2" }],
      ["host public key", { ...binding, hostPublicKeyB64u: b64(21) }],
      ["host fingerprint", { ...binding, hostIdentityFingerprint: `pa1-${b64(21)}` }],
      ["host epoch", { ...binding, hostIdentityEpoch: 2 }],
      ["device public key", { ...binding, devicePublicKeyB64u: b64(22) }],
      ["device fingerprint", { ...binding, deviceKeyFingerprint: `pa1-${b64(22)}` }],
      ["device id", { ...binding, proposedDeviceId: "device-2" }],
      ["host ephemeral", { ...binding, hostEphemeralPublicKeyB64u: b64(23) }],
      ["device ephemeral", { ...binding, deviceEphemeralPublicKeyB64u: b64(24) }],
      ["attempt", { ...binding, attemptId: "attempt-2" }],
      ["capabilities", { ...binding, negotiatedCapabilities: ["relay_pairing_v1", "relay_v2"] }],
      ["requested scopes", { ...binding, requestedScopes: ["projection.read", "thread.steer"] }],
      ["granted scopes", { ...binding, grantedScopes: ["projection.read", "thread.follow_up"] }],
      ["grant version", { ...binding, expectedGrantVersion: 2 }],
      ["ticket", { ...binding, ticketId: "ticket-2" }],
      ["ticket context", { ...binding, ticketContextHash: b64(25) }],
    ];

    for (const [field, variant] of variants) {
      await expectRejectedOrDifferent(field, deriveSecureChannelTranscriptBindingHash(variant, sha256), baselineHash);
    }
  });

  it("rejects noncanonical identities, scopes, capabilities, confirmations, and fields", async () => {
    const binding = await pairingBinding();
    expect(
      SecureChannelTranscriptBindingSchema.safeParse({
        ...binding,
        requestedScopes: ["thread.follow_up", "projection.read"],
      }).success,
    ).toBe(false);
    expect(
      SecureChannelTranscriptBindingSchema.safeParse({ ...binding, hostConfirmation: "pending" }).success,
    ).toBe(false);
    expect(
      SecureChannelTranscriptBindingSchema.safeParse({ ...binding, localRole: "host" }).success,
    ).toBe(false);
    expect(
      SecureChannelTranscriptBindingSchema.safeParse({ ...binding, hostPublicKeyB64u: "_".repeat(43) }).success,
    ).toBe(false);
    expect(
      SecureChannelTranscriptBindingSchema.safeParse({ ...binding, negotiatedCapabilities: ["relay_v1"] }).success,
    ).toBe(false);
    expect(
      SecureChannelTranscriptBindingSchema.safeParse({
        ...binding,
        requestedScopes: ["projection.read"],
        grantedScopes: ["thread.follow_up"],
      }).success,
    ).toBe(false);
  });

  it("ties the returned principal to the exact transcript, channel, grant, and peer role", async () => {
    const transcript = await pairingBinding();
    const transcriptBindingHash = await deriveSecureChannelTranscriptBindingHash(transcript, sha256);
    const hostPrincipal = {
      hostId: transcript.hostId,
      peerPublicKeyFingerprint: transcript.deviceKeyFingerprint,
      canonicalChannelId: transcript.canonicalChannelId,
      grantVersion: transcript.expectedGrantVersion,
      hostIdentityEpoch: transcript.hostIdentityEpoch,
      transcriptBindingHash,
    };

    await expect(
      validateAuthenticatedRelayPrincipal(hostPrincipal, { localRole: "host", expectedTranscript: transcript, digest: sha256 }),
    ).resolves.toEqual(hostPrincipal);
    await expect(
      validateAuthenticatedRelayPrincipal(
        { ...hostPrincipal, canonicalChannelId: "20000000000000000000000000000002" },
        { localRole: "host", expectedTranscript: transcript, digest: sha256 },
      ),
    ).rejects.toThrow(/inconsistent|does not match/);
    await expect(
      validateAuthenticatedRelayPrincipal(hostPrincipal, {
        localRole: "host",
        expectedTranscript: { ...transcript, attemptId: "attempt-substituted" },
        digest: sha256,
      }),
    ).rejects.toThrow(/inconsistent|does not match/);

    await expect(
      validateAuthenticatedRelayPrincipal(
        { ...hostPrincipal, peerPublicKeyFingerprint: transcript.hostIdentityFingerprint },
        { localRole: "device", expectedTranscript: transcript, digest: sha256 },
      ),
    ).resolves.toMatchObject({ peerPublicKeyFingerprint: transcript.hostIdentityFingerprint });
  });

  it("rejects a reconnect transcript whose durable device fingerprint differs from its key", async () => {
    const pairing = await pairingBinding();
    const { ticketId: _ticketId, ticketContextHash: _ticketContextHash, ...common } = pairing;
    const reconnect: SecureChannelTranscriptBinding = {
      ...common,
      handshakePattern: "Noise_IK_25519_ChaChaPoly_BLAKE2s",
      expectedDeviceKeyFingerprint: pairing.deviceKeyFingerprint,
    };
    await expect(deriveSecureChannelTranscriptBindingHash(reconnect, sha256)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      SecureChannelTranscriptBindingSchema.safeParse({
        ...reconnect,
        expectedDeviceKeyFingerprint: `pa1-${b64(31)}`,
      }).success,
    ).toBe(false);
  });
});

async function pairingBinding(): Promise<Extract<
  SecureChannelTranscriptBinding,
  { handshakePattern: "Noise_XKpsk3_25519_ChaChaPoly_BLAKE2s" }
>> {
  const relayOrigin = "wss://relay.example.test";
  const relayRouteId = "route-1";
  const relayRouteBindingHash = await deriveRelayRouteBindingHash({ relayOrigin, relayRouteId }, sha256);
  const ticketId = "ticket-1";
  const attemptId = "attempt-1";
  const hostPublicKeyB64u = b64(2);
  const devicePublicKeyB64u = b64(3);
  return {
    applicationProtocol: "prime-agent.remote.v1",
    handshakeProtocolVersion: 1,
    relayProtocol: "prime-relay-routing.v1",
    handshakePattern: "Noise_XKpsk3_25519_ChaChaPoly_BLAKE2s",
    initiatorRole: "device",
    responderRole: "host",
    relayOrigin,
    relayRouteId,
    relayRouteBindingHash,
    canonicalChannelId: "00000000000000000000000000000001",
    hostId: "host-1",
    hostPublicKeyB64u,
    hostIdentityFingerprint: await deriveNoisePublicKeyFingerprint(hostPublicKeyB64u, sha256),
    hostIdentityEpoch: 1,
    devicePublicKeyB64u,
    deviceKeyFingerprint: await deriveNoisePublicKeyFingerprint(devicePublicKeyB64u, sha256),
    proposedDeviceId: await derivePairedDeviceId(devicePublicKeyB64u, sha256),
    hostEphemeralPublicKeyB64u: b64(4),
    deviceEphemeralPublicKeyB64u: b64(5),
    attemptId,
    negotiatedCapabilities: ["relay_pairing_v1"],
    requestedScopes: ["projection.read", "thread.follow_up"],
    grantedScopes: ["projection.read"],
    expectedGrantVersion: 1,
    hostConfirmation: "confirmed",
    deviceConfirmation: "confirmed",
    ticketId,
    ticketContextHash: await derivePairingTicketContextHash(
      { ticketId, attemptId, relayRouteBindingHash },
      sha256,
    ),
  };
}

function b64(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}


async function expectRejectedOrDifferent(field: string, result: Promise<string>, baseline: string): Promise<void> {
  const outcome = await result.then(
    (hash) => ({ hash } as const),
    (error: unknown) => ({ error } as const),
  );
  if ("hash" in outcome) expect(outcome.hash, field).not.toBe(baseline);
  else expect(outcome.error, field).toBeInstanceOf(Error);
}
