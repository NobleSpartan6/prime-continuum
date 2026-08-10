import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_DEVICE_SCOPE_COUNT,
  REMOTE_DEVICE_SCOPES,
  type RemoteDeviceScope,
} from "../../src/shared/protocol";
import { AtomicWriteAmbiguousCommitError, atomicWriteJson } from "../../src/hostd/atomic-files";
import {
  PairingAuthority,
  PairingAuthorityError,
  CHANNEL_CLOSE_TIMEOUT_MS,
  REVOKED_DEVICE_RETENTION_MS,
  TERMINAL_TICKET_RETENTION_MS,
  deriveNoisePublicKeyFingerprint,
  derivePairingDeviceIdentity,
  type AuthenticatedDevicePrincipal,
  type ChannelCloseFailureDiagnostic,
  type ChannelClosureReason,
  type DeviceGrantRecord,
  type HostIdentityInput,
} from "../../src/hostd/pairing/authority";
import {
  createTestAuthenticatedRelaySessions,
  type TestAuthenticatedRelaySessions,
} from "../helpers/validated-relay-session";
import {
  createTestVerifiedPairingCeremonies,
  type TestVerifiedPairingCeremonies,
} from "../helpers/validated-pairing-ceremony";

const temporaryDirectories: string[] = [];
const HOST_ID = "host-pairing-test";
const RELAY_ORIGIN = "wss://relay.example.test";
const relaySessionsByAuthority = new WeakMap<PairingAuthority, TestAuthenticatedRelaySessions>();
const pairingCeremoniesByAuthority = new WeakMap<PairingAuthority, TestVerifiedPairingCeremonies>();

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PairingAuthority", () => {
  it("keeps an identity-less bootstrap inert, then installs provider metadata only into empty state", async () => {
    const fixture = await temporaryAuthority({ identity: undefined });

    await expect(
      fixture.authority.createTicket({
        expectedHostId: HOST_ID,
        ticketId: "ticket-no-identity",
        relayOrigin: RELAY_ORIGIN,
        requestedScopes: ["projection.read"],
        ttlSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "HOST_IDENTITY_REQUIRED" });

    const snapshot = await fixture.authority.initialize({ hostId: HOST_ID, identity: hostIdentity(1, 9) });

    expect(snapshot.identity).toMatchObject({
      identityEpoch: 1,
      algorithm: "Noise_25519",
      publicKeyB64u: publicKey(9),
      fingerprint: deriveNoisePublicKeyFingerprint(publicKey(9)),
      secretRef: "keyring:prime-agent-host-1",
    });
    expect(snapshot.audits.at(-1)?.event).toBe("identity.installed");

    const installed = new PairingAuthority(fixture.stateFile, { now: fixture.clock.now, allowTestTicketIds: true });
    await installed.initialize({ hostId: HOST_ID, identity: hostIdentity(1, 9) });
    await installed.createTicket({
      expectedHostId: HOST_ID,
      ticketId: "ticket-after-identity",
      relayOrigin: RELAY_ORIGIN,
      requestedScopes: ["projection.read"],
      ttlSeconds: 60,
    });
    const incompatibleIdentity = new PairingAuthority(fixture.stateFile, {
      now: fixture.clock.now,
      allowTestTicketIds: true,
    });
    await expect(
      incompatibleIdentity.initialize({ hostId: HOST_ID, identity: hostIdentity(1, 10) }),
    ).rejects.toMatchObject({ code: "HOST_IDENTITY_MISMATCH" });
  });

  it("cancels every pending or reserved ticket on restart without persisting a pairing secret", async () => {
    const fixture = await temporaryAuthority();
    await createTicket(fixture.authority, "ticket-pending");
    await createTicket(fixture.authority, "ticket-reserved");
    await fixture.authority.reserveVerifiedTicket(verifiedReservation(fixture.authority, {
      expectedHostId: HOST_ID,
      ticketId: "ticket-reserved",
      reservationId: "attempt-before-restart",
    }));

    const restarted = new PairingAuthority(fixture.stateFile, { now: fixture.clock.now, allowTestTicketIds: true });
    const snapshot = await restarted.initialize({ hostId: HOST_ID, identity: hostIdentity(1) });

    expect(snapshot.tickets).toHaveLength(2);
    expect(snapshot.tickets.every((ticket) => ticket.state === "cancelled")).toBe(true);
    expect(snapshot.tickets.every((ticket) => ticket.reason === "host_restart")).toBe(true);
    const durableBytes = await readFile(fixture.stateFile, "utf8");
    expect(durableBytes).not.toMatch(/"(?:psk|privateKey|ticketSecret)"/i);
  });

  it("serializes concurrent reservation so exactly one verified attempt wins", async () => {
    const fixture = await temporaryAuthority();
    await createTicket(fixture.authority, "ticket-race");

    const attempts = await Promise.allSettled(
      Array.from({ length: 32 }, (_, index) =>
        fixture.authority.reserveVerifiedTicket(verifiedReservation(fixture.authority, {
          expectedHostId: HOST_ID,
          ticketId: "ticket-race",
          reservationId: `attempt-${index}`,
        })),
      ),
    );

    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(31);
    expect(rejected.every((attempt) => (attempt.reason as PairingAuthorityError).code === "TICKET_NOT_PENDING")).toBe(true);
    const ticket = (await fixture.authority.getSnapshot()).tickets[0];
    expect(ticket).toMatchObject({ state: "reserved" });
  });

  it("expires tickets at the host deadline and never reopens them", async () => {
    const fixture = await temporaryAuthority();
    await createTicket(fixture.authority, "ticket-expiry", ["projection.read"], 60);
    fixture.clock.advance(60_000);

    await expect(
      fixture.authority.reserveVerifiedTicket(verifiedReservation(fixture.authority, {
        expectedHostId: HOST_ID,
        ticketId: "ticket-expiry",
        reservationId: "attempt-too-late",
      })),
    ).rejects.toMatchObject({ code: "TICKET_EXPIRED" });

    expect((await fixture.authority.getSnapshot()).tickets[0]).toMatchObject({
      state: "expired",
      reason: "ticket_expired",
    });
    await expect(
      fixture.authority.reserveVerifiedTicket(verifiedReservation(fixture.authority, {
        expectedHostId: HOST_ID,
        ticketId: "ticket-expiry",
        reservationId: "attempt-after-expiry",
      })),
    ).rejects.toMatchObject({ code: "TICKET_EXPIRED" });
  });

  it("expires elapsed tickets before enforcing the active-ticket quota", async () => {
    const fixture = await temporaryAuthority();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createTicket(fixture.authority, `ticket-abandoned-${index}`, ["projection.read"], 60),
      ),
    );
    fixture.clock.advance(60_000);

    await expect(
      createTicket(fixture.authority, "ticket-after-abandoned", ["projection.read"], 60),
    ).resolves.toMatchObject({ state: "pending" });
    const snapshot = await fixture.authority.getSnapshot();
    expect(snapshot.tickets.filter((ticket) => ticket.state === "expired")).toHaveLength(8);
    expect(snapshot.tickets.filter((ticket) => ticket.state === "pending")).toHaveLength(1);
  });

  it("generates production ticket IDs internally and forbids caller-selected IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-pairing-authority-generated-id-"));
    temporaryDirectories.push(directory);
    const authority = new PairingAuthority(join(directory, "pairing-authority.json"));
    await authority.initialize({ hostId: HOST_ID, identity: hostIdentity(1) });

    await expect(
      authority.createTicket({
        expectedHostId: HOST_ID,
        ticketId: "caller-chosen-ticket",
        relayOrigin: RELAY_ORIGIN,
        requestedScopes: ["projection.read"],
        ttlSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "CALLER_TICKET_ID_FORBIDDEN" });
    const generated = await authority.createTicket({
      expectedHostId: HOST_ID,
      relayOrigin: RELAY_ORIGIN,
      requestedScopes: ["projection.read"],
      ttlSeconds: 60,
    });
    expect(generated.ticketId).toMatch(/^ticket-[A-Za-z0-9_-]{43}$/);
  });

  it("rejects noncanonical relay origins and binds tickets to the active identity epoch", async () => {
    const fixture = await temporaryAuthority();
    await expect(
      createTicket(fixture.authority, "ticket-origin", ["projection.read"], 60, "wss://relay.example.test/path"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      createTicket(fixture.authority, "ticket-origin-query", ["projection.read"], 60, "wss://relay.example.test?x=1"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      createTicket(fixture.authority, "ticket-origin-http", ["projection.read"], 60, "https://relay.example.test"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const ticket = await createTicket(fixture.authority, "ticket-bound");
    expect(ticket).toMatchObject({ relayOrigin: RELAY_ORIGIN, hostIdentityEpoch: 1 });

    // Exercise the explicit guard independently of rotation's cancellation by
    // moving the in-memory test clock only; a stale epoch in trusted commit is
    // rejected before any durable grant is created.
    await fixture.authority.reserveVerifiedTicket(verifiedReservation(fixture.authority, {
      expectedHostId: HOST_ID,
      ticketId: ticket.ticketId,
      reservationId: "attempt-bound",
    }));
    const identity = derivePairingDeviceIdentity(publicKey(2));
    await expect(
      fixture.authority.commitVerifiedPairing(verifiedCommit(fixture.authority, {
        expectedHostId: HOST_ID,
        expectedHostIdentityEpoch: 2,
        ticketId: ticket.ticketId,
        reservationId: "attempt-bound",
        publicKeyB64u: publicKey(2),
        authenticatedFingerprint: identity.fingerprint,
        displayName: "Phone",
        kind: "mobile",
        grantedScopes: ["projection.read"],
      })),
    ).rejects.toMatchObject({ code: "STALE_IDENTITY_EPOCH" });
  });

  it("rejects duplicate scopes and any grant or later change above the ticket ceiling", async () => {
    const fixture = await temporaryAuthority();
    await expect(
      createTicket(fixture.authority, "ticket-duplicate-scopes", ["projection.read", "projection.read"]),
    ).rejects.toMatchObject({ code: "INVALID_SCOPES" });

    await createTicket(fixture.authority, "ticket-escalation", ["projection.read", "thread.follow_up"]);
    await fixture.authority.reserveVerifiedTicket(verifiedReservation(fixture.authority, {
      expectedHostId: HOST_ID,
      ticketId: "ticket-escalation",
      reservationId: "attempt-escalation",
    }));
    const deviceIdentity = derivePairingDeviceIdentity(publicKey(3));
    await expect(
      fixture.authority.commitVerifiedPairing(verifiedCommit(fixture.authority, {
        expectedHostId: HOST_ID,
        expectedHostIdentityEpoch: 1,
        ticketId: "ticket-escalation",
        reservationId: "attempt-escalation",
        publicKeyB64u: publicKey(3),
        authenticatedFingerprint: deviceIdentity.fingerprint,
        displayName: "Phone",
        kind: "mobile",
        grantedScopes: ["thread.abort"],
      })),
    ).rejects.toMatchObject({ code: "SCOPE_ESCALATION" });
    expect((await fixture.authority.getSnapshot()).devices).toEqual([]);

    const device = await pairDevice(fixture.authority, {
      ticketId: "ticket-scope-ceiling",
      reservationId: "attempt-scope-ceiling",
      keyByte: 4,
      requestedScopes: ["projection.read", "thread.follow_up"],
      grantedScopes: ["projection.read"],
    });
    await expect(
      fixture.authority.changeDeviceScopes({
        expectedHostId: HOST_ID,
        expectedHostIdentityEpoch: 1,
        fingerprint: device.fingerprint,
        expectedGrantVersion: device.grantVersion,
        scopes: ["projection.read", "thread.abort"],
      }),
    ).rejects.toMatchObject({ code: "SCOPE_ESCALATION" });
    expect(findDevice(await fixture.authority.getSnapshot(), device.fingerprint).grantVersion).toBe(1);
  });

  it("keeps the complete nine-scope durable grant aligned with the test-only transcript boundary", async () => {
    const fixture = await temporaryAuthority();
    const scopes: RemoteDeviceScope[] = [...REMOTE_DEVICE_SCOPES].sort();
    expect(scopes).toHaveLength(REMOTE_DEVICE_SCOPE_COUNT);

    const device = await pairDevice(fixture.authority, {
      ticketId: "ticket-complete-scope-contract",
      reservationId: "attempt-complete-scope-contract",
      keyByte: 33,
      requestedScopes: scopes,
      grantedScopes: [...scopes],
    });
    expect(device.scopeCeiling).toEqual(scopes);
    expect(device.scopes).toEqual(scopes);

    const registration = await registerTestChannel(
      fixture.authority,
      device,
      "00000000000000000000000000000030",
    );
    for (const scope of scopes) {
      await expect(
        fixture.authority.withAuthorizedChannel(registration.lease, scope, async () => scope),
      ).resolves.toBe(scope);
    }
  });

  it("derives stable identity from the authenticated public key, ignores a client claim, and persists one atomic grant", async () => {
    const fixture = await temporaryAuthority();
    const key = publicKey(5);
    const derived = derivePairingDeviceIdentity(key);
    expect(derivePairingDeviceIdentity(key)).toEqual(derived);
    expect(derived.fingerprint).toBe(deriveNoisePublicKeyFingerprint(key));

    const device = await pairDevice(fixture.authority, {
      ticketId: "ticket-stable-device",
      reservationId: "attempt-stable-device",
      keyByte: 5,
      claimedDeviceId: "device-client-controlled",
    });
    expect(device.deviceId).toBe(derived.deviceId);
    expect(device.deviceId).not.toBe("device-client-controlled");
    expect(device.scopeCeiling).toEqual(["projection.read"]);

    const restarted = new PairingAuthority(fixture.stateFile, { now: fixture.clock.now, allowTestTicketIds: true });
    const persisted = await restarted.initialize({ hostId: HOST_ID, identity: hostIdentity(1) });
    expect(persisted.devices).toEqual([device]);
    expect(persisted.tickets.find((ticket) => ticket.ticketId === "ticket-stable-device")).toMatchObject({
      state: "redeemed",
      deviceId: derived.deviceId,
    });
  });

  it("refuses a key that differs from the crypto provider's authenticated fingerprint", async () => {
    const fixture = await temporaryAuthority();
    await createTicket(fixture.authority, "ticket-key-mismatch");
    await fixture.authority.reserveVerifiedTicket(verifiedReservation(fixture.authority, {
      expectedHostId: HOST_ID,
      ticketId: "ticket-key-mismatch",
      reservationId: "attempt-key-mismatch",
    }));

    await expect(
      fixture.authority.commitVerifiedPairing(verifiedCommit(fixture.authority, {
        expectedHostId: HOST_ID,
        expectedHostIdentityEpoch: 1,
        ticketId: "ticket-key-mismatch",
        reservationId: "attempt-key-mismatch",
        publicKeyB64u: publicKey(6),
        authenticatedFingerprint: deriveNoisePublicKeyFingerprint(publicKey(7)),
        displayName: "Substituted phone",
        kind: "mobile",
        grantedScopes: ["projection.read"],
      })),
    ).rejects.toMatchObject({ code: "AUTHENTICATED_KEY_MISMATCH" });
    const snapshot = await fixture.authority.getSnapshot();
    expect(snapshot.devices).toEqual([]);
    expect(snapshot.tickets[0]?.state).toBe("reserved");
  });

  it("increments grants on scope change, closes stale channels, and rejects stale grants", async () => {
    const fixture = await temporaryAuthority();
    const device = await pairDevice(fixture.authority, {
      ticketId: "ticket-scope-change",
      reservationId: "attempt-scope-change",
      keyByte: 8,
      requestedScopes: ["projection.read", "thread.follow_up"],
      grantedScopes: ["projection.read"],
    });
    const closures: string[] = [];
    const registration = await registerTestChannel(
      fixture.authority,
      device,
      "00000000000000000000000000000001",
      (reason) => {
        closures.push(reason);
      },
    );
    await expect(
      fixture.authority.withAuthorizedChannel(registration.lease, "projection.read", async () => "allowed"),
    ).resolves.toBe("allowed");
    await expect(
      fixture.authority.withAuthorizedChannel(
        { ...registration.lease, channelId: "00000000000000000000000000000009" },
        "projection.read",
        async () => "mismatched channel",
      ),
    ).rejects.toMatchObject({ code: "CHANNEL_LEASE_INVALID" });

    const changed = await fixture.authority.changeDeviceScopes({
      expectedHostId: HOST_ID,
      expectedHostIdentityEpoch: 1,
      fingerprint: device.fingerprint,
      expectedGrantVersion: 1,
      scopes: ["thread.follow_up"],
    });

    expect(changed).toMatchObject({ grantVersion: 2, scopes: ["thread.follow_up"] });
    expect(closures).toEqual(["scopes_changed"]);
    await expect(
      fixture.authority.withAuthorizedChannel(registration.lease, "thread.follow_up", async () => "stale channel"),
    ).rejects.toMatchObject({ code: "CHANNEL_LEASE_INVALID" });
    await expect(
      registerTestChannel(fixture.authority, device, "00000000000000000000000000000006"),
    ).rejects.toMatchObject({ code: "STALE_GRANT_VERSION" });
    const currentRegistration = await registerTestChannel(
      fixture.authority,
      changed,
      "00000000000000000000000000000007",
    );
    await expect(
      fixture.authority.withAuthorizedChannel(currentRegistration.lease, "projection.read", async () => "denied"),
    ).rejects.toMatchObject({ code: "REMOTE_SCOPE_DENIED" });
    await expect(
      fixture.authority.withAuthorizedChannel(currentRegistration.lease, "thread.follow_up", async () => "allowed"),
    ).resolves.toBe("allowed");
  });

  it("keeps production admission disabled and accepts only one provider-owned test capability", async () => {
    const fixture = await temporaryAuthority();
    const device = await pairDevice(fixture.authority, {
      ticketId: "ticket-channel-brand",
      reservationId: "attempt-channel-brand",
      keyByte: 17,
    });
    const session = await fixture.relaySessions.issueHost({
      hostId: HOST_ID,
      hostPublicKeyB64u: publicKey(1),
      device,
      channelId: "0000000000000000000000000000000d",
    });

    const productionDefault = new PairingAuthority(fixture.stateFile);
    await productionDefault.initialize({ hostId: HOST_ID, identity: hostIdentity(1) });
    await expect(productionDefault.registerAuthenticatedChannel(session)).rejects.toMatchObject({
      code: "SECURE_CHANNEL_NOT_VALIDATED",
    });

    const unrelatedSessions = createTestAuthenticatedRelaySessions();
    const unrelatedAuthority = new PairingAuthority(fixture.stateFile, {
      authenticatedSessionAdmission: unrelatedSessions.admission,
    });
    await unrelatedAuthority.initialize({ hostId: HOST_ID, identity: hostIdentity(1) });
    await expect(unrelatedAuthority.registerAuthenticatedChannel(session)).rejects.toMatchObject({
      code: "SECURE_CHANNEL_NOT_VALIDATED",
    });

    await expect(
      fixture.authority.registerAuthenticatedChannel({ ...session } as typeof session),
    ).rejects.toMatchObject({ code: "SECURE_CHANNEL_NOT_VALIDATED" });
    const registration = await fixture.authority.registerAuthenticatedChannel(session);
    await registration.unregister();
    await expect(fixture.authority.registerAuthenticatedChannel(session)).rejects.toMatchObject({
      code: "SECURE_CHANNEL_NOT_VALIDATED",
    });
  });

  it("requires provider-owned one-shot evidence for reservation and commit", async () => {
    const fixture = await temporaryAuthority();
    await createTicket(fixture.authority, "ticket-ceremony-capability");
    const reservationInput = {
      expectedHostId: HOST_ID,
      ticketId: "ticket-ceremony-capability",
      reservationId: "attempt-ceremony-capability",
    };
    const reservationCapability = fixture.pairingCeremonies.issueReservation(reservationInput);

    const productionDefault = new PairingAuthority(join(dirname(fixture.stateFile), "disabled-pairing.json"));
    await expect(productionDefault.reserveVerifiedTicket(reservationCapability)).rejects.toMatchObject({
      code: "PAIRING_CEREMONY_NOT_VERIFIED",
    });

    const unrelatedCeremonies = createTestVerifiedPairingCeremonies();
    const unrelatedAuthority = new PairingAuthority(join(dirname(fixture.stateFile), "unrelated-pairing.json"), {
      verifiedPairingCeremonyAdmission: unrelatedCeremonies.admission,
    });
    await expect(unrelatedAuthority.reserveVerifiedTicket(reservationCapability)).rejects.toMatchObject({
      code: "PAIRING_CEREMONY_NOT_VERIFIED",
    });
    await expect(fixture.authority.reserveVerifiedTicket({ ...reservationCapability })).rejects.toMatchObject({
      code: "PAIRING_CEREMONY_NOT_VERIFIED",
    });
    await expect(
      fixture.authority.reserveVerifiedTicket({ phase: "reservation", reservation: reservationInput }),
    ).rejects.toMatchObject({ code: "PAIRING_CEREMONY_NOT_VERIFIED" });

    await expect(fixture.authority.reserveVerifiedTicket(reservationCapability)).resolves.toMatchObject({
      state: "reserved",
      reservationId: reservationInput.reservationId,
    });
    await expect(fixture.authority.reserveVerifiedTicket(reservationCapability)).rejects.toMatchObject({
      code: "PAIRING_CEREMONY_NOT_VERIFIED",
    });

    const key = publicKey(31);
    const commitInput = {
      ...reservationInput,
      expectedHostIdentityEpoch: 1,
      publicKeyB64u: key,
      authenticatedFingerprint: deriveNoisePublicKeyFingerprint(key),
      displayName: "Ceremony phone",
      kind: "mobile" as const,
      grantedScopes: ["projection.read" as const],
    };
    const wrongPhase = fixture.pairingCeremonies.issueCommit(commitInput);
    await expect(fixture.authority.reserveVerifiedTicket(wrongPhase)).rejects.toMatchObject({
      code: "PAIRING_CEREMONY_NOT_VERIFIED",
    });
    await expect(fixture.authority.commitVerifiedPairing(wrongPhase)).rejects.toMatchObject({
      code: "PAIRING_CEREMONY_NOT_VERIFIED",
    });

    const commitCapability = fixture.pairingCeremonies.issueCommit(commitInput);
    await expect(
      fixture.authority.commitVerifiedPairing({ phase: "commit", commit: commitInput }),
    ).rejects.toMatchObject({ code: "PAIRING_CEREMONY_NOT_VERIFIED" });
    await expect(fixture.authority.commitVerifiedPairing(commitCapability)).resolves.toMatchObject({
      displayName: "Ceremony phone",
      scopes: ["projection.read"],
    });
    await expect(fixture.authority.commitVerifiedPairing(commitCapability)).rejects.toMatchObject({
      code: "PAIRING_CEREMONY_NOT_VERIFIED",
    });
  });

  it("cannot retarget a validated session or replace its captured close callback before consumption", async () => {
    const fixture = await temporaryAuthority();
    const firstDevice = await pairDevice(fixture.authority, {
      ticketId: "ticket-channel-retarget-first",
      reservationId: "attempt-channel-retarget-first",
      keyByte: 19,
    });
    const secondDevice = await pairDevice(fixture.authority, {
      ticketId: "ticket-channel-retarget-second",
      reservationId: "attempt-channel-retarget-second",
      keyByte: 20,
    });
    const originalClose = vi.fn();
    const replacementClose = vi.fn();
    const session = await fixture.relaySessions.issueHost({
      hostId: HOST_ID,
      hostPublicKeyB64u: publicKey(1),
      device: firstDevice,
      channelId: "0000000000000000000000000000000e",
      onClose: originalClose,
    });

    expect(Reflect.set(session.principal, "peerPublicKeyFingerprint", secondDevice.fingerprint)).toBe(false);
    expect(Reflect.set(session.transcript, "devicePublicKeyB64u", secondDevice.publicKeyB64u)).toBe(false);
    expect(Reflect.set(session.transcript, "deviceKeyFingerprint", secondDevice.fingerprint)).toBe(false);
    expect(Reflect.set(session.transcript, "proposedDeviceId", secondDevice.deviceId)).toBe(false);
    expect(Reflect.set(session.channel.principal, "peerPublicKeyFingerprint", secondDevice.fingerprint)).toBe(true);
    expect(Reflect.set(session.channel, "close", replacementClose)).toBe(true);

    const registration = await fixture.authority.registerAuthenticatedChannel(session);
    await expect(
      fixture.authority.withAuthorizedChannel(registration.lease, "projection.read", async (device) => device.deviceId),
    ).resolves.toBe(firstDevice.deviceId);
    await fixture.authority.revokeDevice({
      expectedHostId: HOST_ID,
      expectedHostIdentityEpoch: 1,
      fingerprint: firstDevice.fingerprint,
      expectedGrantVersion: 1,
      reason: "retarget-regression-test",
    });
    expect(originalClose).toHaveBeenCalledWith("device_revoked");
    expect(replacementClose).not.toHaveBeenCalled();
  });

  it("consumes and closes provider capability evidence that fails durable authority checks", async () => {
    const fixture = await temporaryAuthority();
    const device = await pairDevice(fixture.authority, {
      ticketId: "ticket-channel-rejected",
      reservationId: "attempt-channel-rejected",
      keyByte: 21,
    });
    const close = vi.fn();
    const session = await fixture.relaySessions.issueHost({
      hostId: HOST_ID,
      hostPublicKeyB64u: publicKey(1),
      device,
      channelId: "0000000000000000000000000000000f",
      hostIdentityEpoch: 2,
      onClose: close,
    });

    await expect(fixture.authority.registerAuthenticatedChannel(session)).rejects.toMatchObject({
      code: "STALE_IDENTITY_EPOCH",
    });
    expect(close).toHaveBeenCalledWith("secure_channel_rejected");
    await expect(fixture.authority.registerAuthenticatedChannel(session)).rejects.toMatchObject({
      code: "SECURE_CHANNEL_NOT_VALIDATED",
    });
  });

  it("persists revocation before closing channels and denies the next operation", async () => {
    const fixture = await temporaryAuthority();
    const device = await pairDevice(fixture.authority, {
      ticketId: "ticket-revocation",
      reservationId: "attempt-revocation",
      keyByte: 10,
    });
    const closures: string[] = [];
    const registration = await registerTestChannel(
      fixture.authority,
      device,
      "00000000000000000000000000000002",
      async (reason) => {
        const durable = JSON.parse(await readFile(fixture.stateFile, "utf8")) as {
          devices: Array<{ fingerprint: string; revokedAt?: string }>;
        };
        expect(durable.devices.find((item) => item.fingerprint === device.fingerprint)?.revokedAt).toBeTruthy();
        closures.push(reason);
      },
    );

    const revoked = await fixture.authority.revokeDevice({
      expectedHostId: HOST_ID,
      expectedHostIdentityEpoch: 1,
      fingerprint: device.fingerprint,
      expectedGrantVersion: 1,
      reason: "phone_lost",
    });

    expect(revoked).toMatchObject({ grantVersion: 2, revocationReason: "phone_lost" });
    expect(closures).toEqual(["device_revoked"]);
    await expect(
      fixture.authority.withAuthorizedChannel(registration.lease, "projection.read", async () => "must not run"),
    ).rejects.toMatchObject({ code: "CHANNEL_LEASE_INVALID" });
    await expect(
      registerTestChannel(fixture.authority, device, "00000000000000000000000000000008"),
    ).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
  });

  it("compacts aged terminal tickets and revoked devices without resurrecting authority", async () => {
    const fixture = await temporaryAuthority();
    const device = await pairDevice(fixture.authority, {
      ticketId: "ticket-history-compaction",
      reservationId: "attempt-history-compaction",
      keyByte: 18,
    });
    await fixture.authority.revokeDevice({
      expectedHostId: HOST_ID,
      expectedHostIdentityEpoch: 1,
      fingerprint: device.fingerprint,
      expectedGrantVersion: 1,
      reason: "history-compaction-test",
    });
    await expect(fixture.authority.compactRetiredHistory({ expectedHostId: HOST_ID })).resolves.toEqual({
      tickets: 0,
      devices: 0,
    });

    fixture.clock.advance(Math.max(TERMINAL_TICKET_RETENTION_MS, REVOKED_DEVICE_RETENTION_MS) + 1);
    await expect(fixture.authority.compactRetiredHistory({ expectedHostId: HOST_ID })).resolves.toEqual({
      tickets: 1,
      devices: 1,
    });
    const snapshot = await fixture.authority.getSnapshot();
    expect(snapshot.tickets).toEqual([]);
    expect(snapshot.devices).toEqual([]);
    expect(snapshot.audits.at(-1)).toMatchObject({
      event: "history.compacted",
      reason: "terminal_tickets=1;revoked_devices=1",
    });
  });

  it("keeps revocation durable and bounds rejecting or hung channel closures", async () => {
    const diagnostics: ChannelCloseFailureDiagnostic[] = [];
    const fixture = await temporaryAuthority({ onChannelCloseFailure: (diagnostic) => diagnostics.push(diagnostic) });
    const device = await pairDevice(fixture.authority, {
      ticketId: "ticket-bounded-close",
      reservationId: "attempt-bounded-close",
      keyByte: 15,
    });
    const closeStarted = deferred<void>();
    await registerTestChannel(
      fixture.authority,
      device,
      "00000000000000000000000000000004",
      async () => {
        throw new Error("transport already failed");
      },
    );
    await registerTestChannel(
      fixture.authority,
      device,
      "00000000000000000000000000000005",
      () => {
        closeStarted.resolve();
        return new Promise<void>(() => undefined);
      },
    );

    vi.useFakeTimers();
    const revocation = fixture.authority.revokeDevice({
      expectedHostId: HOST_ID,
      expectedHostIdentityEpoch: 1,
      fingerprint: device.fingerprint,
      expectedGrantVersion: 1,
      reason: "bounded-close-test",
    });
    await closeStarted.promise;
    const durable = JSON.parse(await readFile(fixture.stateFile, "utf8")) as {
      devices: Array<{ fingerprint: string; revokedAt?: string }>;
    };
    expect(durable.devices.find((item) => item.fingerprint === device.fingerprint)?.revokedAt).toBeTruthy();

    await vi.advanceTimersByTimeAsync(CHANNEL_CLOSE_TIMEOUT_MS);
    await expect(revocation).resolves.toMatchObject({ revocationReason: "bounded-close-test" });
    expect(diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
      "CHANNEL_CLOSE_REJECTED",
      "CHANNEL_CLOSE_TIMEOUT",
    ]);
  });

  it("fails closed and invalidates every lease after an ambiguous authority commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prime-pairing-authority-ambiguous-"));
    temporaryDirectories.push(directory);
    const stateFile = join(directory, "pairing-authority.json");
    let injectAmbiguousCommit = false;
    const relaySessions = createTestAuthenticatedRelaySessions();
    const pairingCeremonies = createTestVerifiedPairingCeremonies();
    const authority = new PairingAuthority(stateFile, {
      allowTestTicketIds: true,
      authenticatedSessionAdmission: relaySessions.admission,
      verifiedPairingCeremonyAdmission: pairingCeremonies.admission,
      writeState: async (path, value, maxBytes) => {
        await atomicWriteJson(path, value, maxBytes);
        if (injectAmbiguousCommit) {
          throw new AtomicWriteAmbiguousCommitError(path, new Error("simulated parent directory fsync failure"));
        }
      },
    });
    relaySessionsByAuthority.set(authority, relaySessions);
    pairingCeremoniesByAuthority.set(authority, pairingCeremonies);
    await authority.initialize({ hostId: HOST_ID, identity: hostIdentity(1) });
    const device = await pairDevice(authority, {
      ticketId: "ticket-ambiguous-commit",
      reservationId: "attempt-ambiguous-commit",
      keyByte: 16,
    });
    const channelClosed = deferred<string>();
    const registration = await registerTestChannel(
      authority,
      device,
      "0000000000000000000000000000000c",
      (reason) => channelClosed.resolve(reason),
    );

    injectAmbiguousCommit = true;
    await expect(
      authority.revokeDevice({
        expectedHostId: HOST_ID,
        expectedHostIdentityEpoch: 1,
        fingerprint: device.fingerprint,
        expectedGrantVersion: 1,
        reason: "ambiguous-commit-test",
      }),
    ).rejects.toMatchObject({ code: "AUTHORITY_PERSISTENCE_UNCERTAIN" });
    await expect(channelClosed.promise).resolves.toBe("authority_persistence_uncertain");

    const durable = JSON.parse(await readFile(stateFile, "utf8")) as {
      devices: Array<{ fingerprint: string; revokedAt?: string }>;
    };
    expect(durable.devices.find((item) => item.fingerprint === device.fingerprint)?.revokedAt).toBeTruthy();
    await expect(
      authority.withAuthorizedChannel(registration.lease, "projection.read", async () => "must not run"),
    ).rejects.toMatchObject({ code: "AUTHORITY_PERSISTENCE_UNCERTAIN" });
  });

  it("rejects stale grant and host identity epochs", async () => {
    const fixture = await temporaryAuthority();
    const device = await pairDevice(fixture.authority, {
      ticketId: "ticket-stale-principal",
      reservationId: "attempt-stale-principal",
      keyByte: 11,
    });

    await expect(
      registerTestChannel(fixture.authority, device, "00000000000000000000000000000009", undefined, {
        grantVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "STALE_GRANT_VERSION" });
    await expect(
      registerTestChannel(fixture.authority, device, "0000000000000000000000000000000a", undefined, {
        hostIdentityEpoch: 2,
      }),
    ).rejects.toMatchObject({ code: "STALE_IDENTITY_EPOCH" });
  });

  it("lets revocation commit while already-authorized work finishes and denies every later admission", async () => {
    const fixture = await temporaryAuthority();
    const device = await pairDevice(fixture.authority, {
      ticketId: "ticket-linearization",
      reservationId: "attempt-linearization",
      keyByte: 12,
    });
    const registration = await registerTestChannel(
      fixture.authority,
      device,
      "0000000000000000000000000000000b",
    );
    const operationStarted = deferred<void>();
    const releaseOperation = deferred<void>();

    const operation = fixture.authority.withAuthorizedChannel(registration.lease, "projection.read", async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
      return "admitted-before-revoke";
    });
    await operationStarted.promise;

    let revocationFinished = false;
    const revocation = fixture.authority
      .revokeDevice({
        expectedHostId: HOST_ID,
        expectedHostIdentityEpoch: 1,
        fingerprint: device.fingerprint,
        expectedGrantVersion: 1,
        reason: "linearization-test",
      })
      .then((result) => {
        revocationFinished = true;
        return result;
      });
    await revocation;
    expect(revocationFinished).toBe(true);

    await expect(
      fixture.authority.withAuthorizedChannel(registration.lease, "projection.read", async () => "too late"),
    ).rejects.toMatchObject({ code: "CHANNEL_LEASE_INVALID" });

    releaseOperation.resolve();
    await expect(operation).resolves.toBe("admitted-before-revoke");
  });

  it("rotates host identity by one epoch, revokes grants, cancels tickets, and closes all channels", async () => {
    const fixture = await temporaryAuthority();
    const device = await pairDevice(fixture.authority, {
      ticketId: "ticket-before-rotation",
      reservationId: "attempt-before-rotation",
      keyByte: 13,
    });
    await createTicket(fixture.authority, "ticket-cancelled-by-rotation");
    const closures: string[] = [];
    await registerTestChannel(
      fixture.authority,
      device,
      "00000000000000000000000000000003",
      (reason) => {
        closures.push(reason);
      },
    );

    const identity = await fixture.authority.rotateHostIdentity({
      expectedHostId: HOST_ID,
      expectedHostIdentityEpoch: 1,
      identity: hostIdentity(2, 14),
      reason: "scheduled_rotation",
    });

    expect(identity).toMatchObject({ identityEpoch: 2, fingerprint: deriveNoisePublicKeyFingerprint(publicKey(14)) });
    expect(closures).toEqual(["host_identity_rotated"]);
    const snapshot = await fixture.authority.getSnapshot();
    expect(snapshot.hostIdentityEpoch).toBe(2);
    expect(findDevice(snapshot, device.fingerprint)).toMatchObject({
      grantVersion: 2,
      revocationReason: "host_identity_rotated",
    });
    expect(snapshot.tickets.find((ticket) => ticket.ticketId === "ticket-cancelled-by-rotation")).toMatchObject({
      state: "cancelled",
      reason: "host_identity_rotated",
    });
  });
});

interface TestClock {
  now: () => Date;
  advance(milliseconds: number): void;
}

function clock(start = "2026-08-05T12:00:00.000Z"): TestClock {
  let milliseconds = Date.parse(start);
  return {
    now: () => new Date(milliseconds),
    advance: (amount) => {
      milliseconds += amount;
    },
  };
}

async function temporaryAuthority(
  options: {
    identity?: HostIdentityInput;
    onChannelCloseFailure?: (diagnostic: ChannelCloseFailureDiagnostic) => void;
  } = {},
): Promise<{
  authority: PairingAuthority;
  stateFile: string;
  clock: TestClock;
  relaySessions: TestAuthenticatedRelaySessions;
  pairingCeremonies: TestVerifiedPairingCeremonies;
}> {
  const directory = await mkdtemp(join(tmpdir(), "prime-pairing-authority-"));
  temporaryDirectories.push(directory);
  const testClock = clock();
  const stateFile = join(directory, "pairing-authority.json");
  const relaySessions = createTestAuthenticatedRelaySessions();
  const pairingCeremonies = createTestVerifiedPairingCeremonies();
  const authority = new PairingAuthority(stateFile, {
    allowTestTicketIds: true,
    now: testClock.now,
    onChannelCloseFailure: options.onChannelCloseFailure,
    authenticatedSessionAdmission: relaySessions.admission,
    verifiedPairingCeremonyAdmission: pairingCeremonies.admission,
  });
  relaySessionsByAuthority.set(authority, relaySessions);
  pairingCeremoniesByAuthority.set(authority, pairingCeremonies);
  await authority.initialize({
    hostId: HOST_ID,
    ...(options.identity === undefined && "identity" in options ? {} : { identity: options.identity ?? hostIdentity(1) }),
  });
  return { authority, stateFile, clock: testClock, relaySessions, pairingCeremonies };
}

function hostIdentity(epoch: number, keyByte = 1): HostIdentityInput {
  return {
    identityEpoch: epoch,
    algorithm: "Noise_25519",
    publicKeyB64u: publicKey(keyByte),
    secretRef: `keyring:prime-agent-host-${epoch}`,
  };
}

function publicKey(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

async function createTicket(
  authority: PairingAuthority,
  ticketId: string,
  requestedScopes: RemoteDeviceScope[] = ["projection.read"],
  ttlSeconds = 300,
  relayOrigin = RELAY_ORIGIN,
) {
  return authority.createTicket({
    expectedHostId: HOST_ID,
    ticketId,
    relayOrigin,
    requestedScopes,
    ttlSeconds,
  });
}

function verifiedReservation(
  authority: PairingAuthority,
  input: Parameters<TestVerifiedPairingCeremonies["issueReservation"]>[0],
): object {
  const ceremonies = pairingCeremoniesByAuthority.get(authority);
  if (!ceremonies) throw new Error("Missing test pairing-ceremony provider for authority");
  return ceremonies.issueReservation(input);
}

function verifiedCommit(
  authority: PairingAuthority,
  input: Parameters<TestVerifiedPairingCeremonies["issueCommit"]>[0],
): object {
  const ceremonies = pairingCeremoniesByAuthority.get(authority);
  if (!ceremonies) throw new Error("Missing test pairing-ceremony provider for authority");
  return ceremonies.issueCommit(input);
}

async function pairDevice(
  authority: PairingAuthority,
  options: {
    ticketId: string;
    reservationId: string;
    keyByte: number;
    requestedScopes?: RemoteDeviceScope[];
    grantedScopes?: RemoteDeviceScope[];
    claimedDeviceId?: string;
  },
): Promise<DeviceGrantRecord> {
  const requestedScopes = options.requestedScopes ?? ["projection.read"];
  const grantedScopes = options.grantedScopes ?? requestedScopes;
  await createTicket(authority, options.ticketId, requestedScopes);
  await authority.reserveVerifiedTicket(verifiedReservation(authority, {
    expectedHostId: HOST_ID,
    ticketId: options.ticketId,
    reservationId: options.reservationId,
  }));
  const key = publicKey(options.keyByte);
  return authority.commitVerifiedPairing(verifiedCommit(authority, {
    expectedHostId: HOST_ID,
    expectedHostIdentityEpoch: 1,
    ticketId: options.ticketId,
    reservationId: options.reservationId,
    publicKeyB64u: key,
    authenticatedFingerprint: deriveNoisePublicKeyFingerprint(key),
    clientClaimedDeviceId: options.claimedDeviceId,
    displayName: `Phone ${options.keyByte}`,
    kind: "mobile",
    grantedScopes,
  }));
}

function principalFor(device: DeviceGrantRecord): AuthenticatedDevicePrincipal {
  return {
    hostId: HOST_ID,
    fingerprint: device.fingerprint,
    grantVersion: device.grantVersion,
    hostIdentityEpoch: device.hostIdentityEpoch,
  };
}

async function registerTestChannel(
  authority: PairingAuthority,
  device: DeviceGrantRecord,
  channelId: string,
  close: (reason: ChannelClosureReason) => void | Promise<void> = () => undefined,
  overrides: { grantVersion?: number; hostIdentityEpoch?: number; hostPublicKeyB64u?: string } = {},
) {
  const relaySessions = relaySessionsByAuthority.get(authority);
  if (!relaySessions) throw new Error("Missing test relay-session provider for authority");
  const session = await relaySessions.issueHost({
    hostId: HOST_ID,
    hostPublicKeyB64u: overrides.hostPublicKeyB64u ?? publicKey(1),
    device,
    channelId,
    grantVersion: overrides.grantVersion,
    hostIdentityEpoch: overrides.hostIdentityEpoch,
    onClose: (reason) => close(reason as ChannelClosureReason),
  });
  return authority.registerAuthenticatedChannel(session);
}

function findDevice(
  snapshot: Awaited<ReturnType<PairingAuthority["getSnapshot"]>>,
  fingerprint: string,
): DeviceGrantRecord {
  const device = snapshot.devices.find((item) => item.fingerprint === fingerprint);
  if (!device) throw new Error(`Missing device ${fingerprint}`);
  return device;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
