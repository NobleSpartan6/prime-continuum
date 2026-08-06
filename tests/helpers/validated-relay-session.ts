import type {
  AuthenticatedRelaySessionAdmission,
  AuthenticatedRelaySessionEvidence,
  DeviceGrantRecord,
} from "../../src/hostd/pairing/authority";
import {
  deriveNoisePublicKeyFingerprint,
  deriveRelayRouteBindingHash,
  deriveSecureChannelTranscriptBindingHash,
  type AuthenticatedSecureChannel,
  type AuthenticatedRelayPrincipal,
  type SecureChannelTranscriptBinding,
} from "../../src/shared/relay-transport";

export interface TestValidatedRelaySession {
  readonly localRole: "host";
  readonly transcript: SecureChannelTranscriptBinding;
  readonly principal: AuthenticatedRelayPrincipal;
  readonly channel: AuthenticatedSecureChannel;
}

export interface TestValidatedRelaySessionInput {
  hostId: string;
  hostPublicKeyB64u: string;
  device: DeviceGrantRecord;
  channelId: string;
  grantVersion?: number;
  hostIdentityEpoch?: number;
  onClose?: (reason?: string) => void | Promise<void>;
}

export interface TestAuthenticatedRelaySessions {
  readonly admission: AuthenticatedRelaySessionAdmission;
  issueHost(input: TestValidatedRelaySessionInput): Promise<TestValidatedRelaySession>;
}

/** Each test authority receives its own provider-like one-shot capability map. */
export function createTestAuthenticatedRelaySessions(): TestAuthenticatedRelaySessions {
  const issuedSessions = new WeakMap<object, AuthenticatedRelaySessionEvidence>();
  const admission: AuthenticatedRelaySessionAdmission = Object.freeze({
    consume(session: unknown): AuthenticatedRelaySessionEvidence | undefined {
      if (!session || typeof session !== "object") return undefined;
      const evidence = issuedSessions.get(session);
      if (!evidence) return undefined;
      issuedSessions.delete(session);
      return evidence;
    },
  });
  return Object.freeze({
    admission,
    issueHost: (input: TestValidatedRelaySessionInput) => issueValidatedHostRelaySession(issuedSessions, input),
  });
}

async function issueValidatedHostRelaySession(
  issuedSessions: WeakMap<object, AuthenticatedRelaySessionEvidence>,
  input: TestValidatedRelaySessionInput,
): Promise<TestValidatedRelaySession> {
  const relayOrigin = "wss://relay.test.example";
  const relayRouteId = `route-${input.channelId}`;
  const relayRouteBindingHash = await deriveRelayRouteBindingHash({ relayOrigin, relayRouteId });
  const expectedGrantVersion = input.grantVersion ?? input.device.grantVersion;
  const hostIdentityEpoch = input.hostIdentityEpoch ?? input.device.hostIdentityEpoch;
  const transcript = {
    applicationProtocol: "prime-agent.remote.v1" as const,
    handshakeProtocolVersion: 1 as const,
    relayProtocol: "prime-relay-routing.v1" as const,
    handshakePattern: "Noise_IK_25519_ChaChaPoly_BLAKE2s" as const,
    initiatorRole: "device" as const,
    responderRole: "host" as const,
    relayOrigin,
    relayRouteId,
    relayRouteBindingHash,
    canonicalChannelId: input.channelId,
    hostId: input.hostId,
    hostPublicKeyB64u: input.hostPublicKeyB64u,
    hostIdentityFingerprint: await deriveNoisePublicKeyFingerprint(input.hostPublicKeyB64u),
    hostIdentityEpoch,
    devicePublicKeyB64u: input.device.publicKeyB64u,
    deviceKeyFingerprint: input.device.fingerprint,
    proposedDeviceId: input.device.deviceId,
    hostEphemeralPublicKeyB64u: Buffer.alloc(32, 0xa1).toString("base64url"),
    deviceEphemeralPublicKeyB64u: Buffer.alloc(32, 0xa2).toString("base64url"),
    attemptId: `attempt-${input.channelId}`,
    negotiatedCapabilities: ["relay_pairing_v1"],
    requestedScopes: [...input.device.scopeCeiling],
    grantedScopes: [...input.device.scopes],
    expectedGrantVersion,
    hostConfirmation: "confirmed" as const,
    deviceConfirmation: "confirmed" as const,
    expectedDeviceKeyFingerprint: input.device.fingerprint,
  };
  const transcriptBindingHash = await deriveSecureChannelTranscriptBindingHash(transcript);
  const channel: AuthenticatedSecureChannel = {
    principal: {
      hostId: input.hostId,
      peerPublicKeyFingerprint: input.device.fingerprint,
      canonicalChannelId: input.channelId,
      grantVersion: expectedGrantVersion,
      hostIdentityEpoch,
      transcriptBindingHash,
    },
    plaintext: emptyMessages(),
    async sendPlaintext() {},
    close(reason) {
      return input.onClose?.(reason);
    },
  };
  const capturedTranscript = structuredClone(transcript) as SecureChannelTranscriptBinding;
  Object.freeze(capturedTranscript.negotiatedCapabilities);
  Object.freeze(capturedTranscript.requestedScopes);
  Object.freeze(capturedTranscript.grantedScopes);
  Object.freeze(capturedTranscript);
  const capturedPrincipal = Object.freeze({ ...channel.principal });
  const capturedClose = channel.close.bind(channel);
  const session = Object.freeze({
    localRole: "host" as const,
    transcript: capturedTranscript,
    principal: capturedPrincipal,
    channel,
  });
  issuedSessions.set(
    session,
    Object.freeze({
      localRole: "host" as const,
      transcript: capturedTranscript,
      principal: capturedPrincipal,
      close: capturedClose,
    }),
  );
  return session;
}

async function* emptyMessages(): AsyncIterable<Uint8Array> {
  return;
}
