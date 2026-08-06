# Relay and pairing threat model

**Status:** Phase 3A durable authority and an isolated opaque relay boundary are implemented and locally tested; Gate A acceptance, application cryptography, and end-to-end integration remain incomplete.
**Scope:** Host identity, device pairing, relay transport, per-device authorization, revocation, and encrypted notifications.
**Specification basis:** Prime Agent Native seamless-remote specification sections 7, 10, 14, 15 Phase 3, and 16 Cross-device.

This document defines the security properties that must be demonstrated before Prime Agent advertises `relay_pairing_v1`, accepts a mutation from a paired device, or represents phone control as available. The current Phase 3A authority is a local, crypto-agnostic persistence and authorization boundary; it does not provide a pairing handshake, E2EE channel, relay connector, or secure mobile control path.

The governing product rule is:

> The execution host remains the authority. The relay is an untrusted router. A paired device receives only the projection and actions explicitly granted to that device.

## Security decision

The target architecture, not the current Phase 3A feature set, follows these decisions:

- Hostd never opens an unauthenticated LAN or public application-protocol listener.
- Both hostd and a remote client initiate outbound connections to a configured `wss://` relay.
- TLS protects each connection to the relay, but TLS is not treated as end-to-end protection.
- Application payloads are mutually authenticated and end-to-end encrypted between the paired device and hostd.
- The relay must not receive thread plaintext, command plaintext, credentials, artifact plaintext, application keys, or stable authorization credentials.
- Pairing creates one durable grant for one named device on one immutable host identity. A ticket is not a device grant.
- Hostd derives authorization from its durable paired-device registry. A relay message cannot supply or widen its own scopes.
- Every remote mutation preserves `deviceId`, `commandId`, `expectedHostId`, and, when applicable, the expected execution generation.
- Revocation is committed on the host before success is reported, closes live channels, and blocks new channels.
- Unsupported capabilities remain absent. A scope such as `run_location.change` does not make handoff available when `thread_handoff_v1` is absent.

## Delivery boundaries

### Phase 3A: pairing authority without network exposure

Phase 3A implements and locally verifies:

- durable provider-supplied host public identity metadata: identity epoch, `Noise_25519` algorithm tag, canonical public key, derived fingerprint, and opaque `secretRef`;
- bounded, expiring ticket records with pending, reserved, redeemed, cancelled, and expired states;
- a durable paired-device public-key and scope registry;
- revocation state and audit records;
- serialized fingerprint, grant-version, and host-epoch authorization at the host admission boundary;
- ticket reservation and device-grant commit accept only provider-instance-owned, one-shot ceremony capabilities; production installs no ceremony admission provider, and raw/spread/reused/cross-provider evidence fails before ticket lookup;
- opaque in-memory channel leases created only after a provider-instance-owned, one-shot capability is consumed; production installs no admission provider yet, so structural relay data always fails closed, while durable authorization is rechecked at every admission;
- authorization/revocation linearization that lets already-admitted work finish without delaying durable revocation or admitting later work;
- a duplex encrypted-record provider contract that separates locally known pre-handshake policy from the provider's actual post-handshake transcript, plus runtime-strict canonical transcript checks binding roles, protocols, suite, relay/routing data, host/device static and ephemeral keys, scopes, capabilities, grant, ticket context, and both confirmations; this is a provider boundary, not an E2EE implementation;
- a fail-closed host-identity custody boundary that is not called for identity-less state, bounds provider startup, validates runtime results and host binding, never returns private key bytes, and exposes only optional secret-free readiness in health; the production provider remains deliberately unavailable;
- cancellation of every pending or reserved ticket on startup; and
- restart, reservation-race, expiry, quota/retention compaction, persistence uncertainty, key-mismatch, nested session-retarget attempts, provider-instance isolation, one-shot ceremony and channel-capability consumption, rejected-channel closure, transcript identity/mutation, custody missing/mismatch/timeout/malformed-result handling, CLI-isolation, bounded observable channel-close, populated-directory ownership publication, delayed-publisher rejection, concurrent stale-owner recovery, endpoint-shutdown ownership, and revocation-linearization tests. The ownership algorithm is exercised directly on the Windows development filesystem; real Unix socket/process runs in Linux and macOS CI remain required. Corruption and broader fault-injection evidence remain Gate A work.

Phase 3A never generates, accepts, or persists a host private key, ticket PSK, or ticket verifier. The opaque `secretRef` locates provider-owned key material; it is not the key. Hostd does not silently generate or replace an identity when custody is missing, corrupt, locked, inaccessible, mismatched, malformed, or slow. Phase 3A must not advertise relay pairing. The pairing and mobile-command controls remain unavailable because no crypto provider, real credential-store adapter, or E2EE relay channel exists yet.

The Unix sidecar fence assumes every contender runs the lock-aware implementation. A future upgrader must stop legacy hostd before replacement; an empty/incomplete ownership directory fails closed for manual recovery instead of being guessed stale.

### Phase 3B: private self-hosted relay

An isolated self-hosted relay package now enforces TLS-first native WebSocket upgrades, one-shot digest-only grants, exact bounded routing frames, opaque forwarding, route/connection/rate/backpressure limits, and no offline queue. A separate `ReliableRelayByteTunnel` contract turns one already-open routing channel into a bounded, monotonic byte stream: every gap, duplicate, rejection, missing receipt, wrong channel, backpressure overflow, or disconnect is terminal, and uncertain bytes are never retried in the same session. Its relay-visible routing ID is explicitly not a secure-channel ID or principal. The adapter is conformance-tested but not yet connected to WebSocket, hostd, TLS, or a client.

This remains a reversible transport seam, not a crypto choice. A reconnect creates a new routing channel and must create a new future TLS session. The relay's accepted status means only bounded peer-socket acceptance; it is not an end-to-end application receipt.

Phase 3B adds the reviewed crypto provider, authenticated key agreement, encrypted channel, replay protection, durable relay grant issuance, outbound host/client connectors, reconnect, and live-channel revocation integration. The provider, not the Phase 3A authority, generates and holds the ticket PSK in memory, clears it on terminal outcome or restart, and passes only authenticated reservation and commit results into the authority. Only after all Phase 3B gates pass may hostd advertise `relay_pairing_v1` for controlled deployments.

### Later gates

- Encrypted notifications require their own metadata and deep-link tests.
- A public managed relay requires a published threat model, privacy disclosure, abuse controls, operational review, and incident response.
- A packaged mobile client requires secure platform key storage and the same protocol conformance suite as a desktop paired client.
- Existing-thread host switching remains unavailable until the Phase 2 handoff coordinator passes `thread_handoff_v1` acceptance.

## System and trust boundaries

```text
trusted local user
  │ user-owned local socket / reviewed SSH bootstrap
  ▼
prime-agent-hostd ── protected durable state ── OS credential store or protected service directory
  │
  │ outbound WSS carrying opaque routing records and E2EE envelopes
  ▼
untrusted relay
  ▲
  │ outbound WSS carrying opaque routing records and E2EE envelopes
  │
paired desktop or mobile client ── platform secure key storage
```

### Trusted components

- The execution host operating system, user account, hostd process, and correctly installed hostd binary.
- The paired-client operating system, secure key storage, and correctly installed client binary.
- The system cryptographic random-number generator and the selected reviewed cryptographic implementation.
- The local user-owned socket and system OpenSSH path under their existing platform security assumptions.

### Untrusted or less-trusted components

- The relay operator, relay database, relay logs, and every process on the relay host.
- Networks between clients, hostd, and the relay.
- QR transport, screenshots, clipboard history, camera input, and any observer who can capture a pairing ticket.
- Device display names and other remote-supplied presentation strings.
- A paired device outside its granted scopes.
- A revoked device, even if it retains old keys, routing identifiers, ciphertext, and tickets.
- Cached client projections. Cache content accelerates rendering but never confers authority.

### Out-of-scope compromise

This design cannot preserve thread confidentiality or command integrity after the execution host or its user account is compromised. It also cannot protect data already displayed or exported on a compromised paired device. Those incidents require host or device recovery and key rotation; they are not repaired by the relay protocol.

## Assets

| Asset | Required protection | Authoritative owner |
| --- | --- | --- |
| Host identity private key (future Phase 3B) | Confidentiality, integrity, non-export by default; never authority state | Crypto provider backed by execution-host secure storage |
| Host public key, fingerprint, identity epoch, and `secretRef` | Integrity and stable user confirmation; safe separation from private material | Phase 3A authority |
| Device private key | Confidentiality, integrity, non-export by default | Paired device |
| Device public key, name, and grant | Integrity, durable attribution, bounded presentation | Execution host |
| Pairing ticket PSK (future Phase 3B) | Memory-only confidentiality until use, short lifetime, single use | Crypto provider and candidate device memory |
| Ticket state | Atomic pending/reserved/redeemed/expired/cancelled transition | Execution host |
| Session traffic keys and nonces | Confidentiality, uniqueness, forward-session separation | Host and paired device memory |
| Thread projections and commands | End-to-end confidentiality and integrity | Execution host; authorized device projection |
| Command receipts and journals | Integrity, idempotency, durable attribution | Execution host |
| Per-device scopes and revocation epoch | Integrity, immediate enforcement | Execution host |
| Attention and notification data | End-to-end confidentiality with minimal outer metadata | Execution host |
| Relay routing identifiers | Unpredictability, bounded lifetime, no authorization meaning | Relay routing plane |
| Security audit records | Integrity, bounded retention, no ticket or key secrets | Execution host |

## Adversaries and abuse cases

### Malicious or compromised relay

The relay may read, drop, delay, reorder, replay, duplicate, truncate, or modify any routed record. It may correlate source IP addresses, destination routing identifiers, connection times, message sizes, and delivery status. It may attempt to route one device to the wrong host or force a protocol downgrade.

Controls must make tampering, misrouting, replay, and downgrade detectable at the endpoints. Availability against a relay that drops all traffic is not promised.

### Active network attacker

An attacker may intercept DNS, TLS, and WebSocket traffic; present an invalid relay certificate; redirect an endpoint; replay a prior rendezvous; or terminate connections repeatedly. Normal platform TLS validation remains mandatory, and the application-layer transcript binds the configured relay origin and endpoint identities.

### Stolen or photographed ticket

In future Phase 3B, an attacker may obtain the entire QR payload before the intended device. Its provider-held PSK is therefore a short-lived bootstrap secret, not durable authorization. The protocol requires mutual key agreement plus human confirmation of the host identity and a transcript-derived matching value. Ticket attempts are bounded and audited.

### Malicious paired device

A valid device may try to widen its scopes, act as another `deviceId`, reconcile another device's commands, target another host or generation, resolve an approval without a claim, enumerate files, or submit an oversized stream. Hostd rejects these operations before journal admission.

### Revoked device racing the user

A device may submit commands while its revocation is being committed, reuse a live channel afterward, or reconnect using old credentials. The host defines a precise admission boundary: a mutation durably admitted before revocation retains its receipt; a mutation not admitted before revocation is rejected. Revocation does not pretend to undo already admitted work.

### Local unprivileged process

Another local account or sandboxed process may try to read host keys, ticket records, or paired-device grants, or connect to the user-owned hostd endpoint. Protected storage, endpoint ownership, and restrictive permissions are required. A malicious process already running as the same fully trusted OS user is equivalent to user-account compromise.

### Resource-exhaustion attacker

An unauthenticated candidate, paired device, or malicious relay may open many channels, create tickets, send oversized frames, send invalid ciphertext, force expensive handshakes, or retain unread output. Limits must apply before expensive parsing, key agreement, decryption, durable writes, and projection materialization where possible.

## Security invariants

1. **Stable host identity.** A host fingerprint is derived from a canonical public identity key, survives ordinary restart and upgrade, and changes only through an explicit recovery or rotation operation.
2. **Ticket is not authority.** Possession of a ticket alone cannot read a catalog, submit a command, or create a durable device grant without the complete confirmed pairing exchange.
3. **Atomic single use.** Exactly one successful exchange can transition a ticket from pending to redeemed. Concurrent losers receive a non-oracular terminal error.
4. **Mutual transcript binding.** Both endpoints authenticate the same host identity, device key, relay origin, ticket, protocol version, cryptographic suite, ephemeral keys, requested scopes, and granted scopes.
5. **No downgrade.** Protocol version, capability set, and cryptographic suite are authenticated. Unknown, removed, or weaker alternatives fail closed.
6. **Fresh channel keys.** Each connection or resumed channel uses fresh key material and direction-separated keys. A reconnect never reuses an AEAD nonce/key pair.
7. **Replay-safe application traffic.** Every encrypted envelope binds a channel/session ID, direction, monotonic sequence, message class, and protocol version as authenticated data. Duplicate or stale sequences are rejected before dispatch.
8. **Host-derived authorization.** The relay and device do not submit effective scopes. Hostd resolves the authenticated device against durable, unrevoked grants and current host capabilities.
9. **Identity-bound mutations.** The authenticated device must match the command or handoff `deviceId`; `expectedHostId` and execution generation are checked before admission.
10. **Durable idempotency.** Reconnect reconciles `(deviceId, commandId)` before any resend. A relay retry cannot produce a second mutation.
11. **Immediate revocation boundary.** Successful revocation is durable before acknowledgment, increments the device grant epoch, closes its live channels, and blocks subsequent authorization.
12. **Crash-safe authority.** Restart cannot resurrect a redeemed ticket, revoked device, superseded grant, or old channel. Phase 3A cancels every pending or reserved ticket on startup; ephemeral PSKs and channel keys are not restored from disk.
13. **Opaque relay payloads.** Relay-visible records contain only the routing and delivery fields required for bounded forwarding; all application content and authorization claims are encrypted and authenticated.
14. **Outbound-only reachability.** Direct relay operation requires no public inbound hostd listener and no interim LAN HTTP/WebSocket server.
15. **Capability honesty.** Pairing, approval, handoff, artifact, notification, and mobile controls are individually gated by negotiated capabilities as well as device scopes.

## Pairing design requirements

### Host identity

- Phase 3A accepts only provider-supplied public metadata: identity epoch, `Noise_25519` algorithm tag, canonical 32-byte public key, derived `pa1-` fingerprint, and opaque `secretRef`. It does not generate or accept private key bytes.
- A future Phase 3B crypto provider generates the host identity with the platform CSPRNG through a reviewed cryptographic library.
- The future provider stores private material in the OS credential store when practical. A service-directory fallback must be user-owned, non-shared, and permission-verified; silently continuing with permissive storage is not allowed.
- The authority stores public identity metadata and the provider's opaque `secretRef` separately from private material.
- Derive the displayed fingerprint from a canonical public-key encoding. Equivalent encodings must not produce ambiguous identities.
- Never place private key bytes in authority state, renderer state, logs, diagnostics, QR payloads, crash reports, or relay messages.
- The current custody checkpoint verifies only an already-configured identity through an injected provider. It passes the immutable host ID and expected public metadata/opaque reference, requires the provider to bind its result to that host, bounds startup, runtime-validates the adapter result, and reports only secret-free readiness. Provisioning and private-key operations remain blocked.
- In Phase 3B, corrupt, missing, or unreadable provider key material fails closed with a structured recovery action. It must not silently create a new identity and orphan or impersonate existing pairings.

### Ticket creation and storage

A trusted local/SSH user action creates a Phase 3A authority ticket. Its durable record includes:

- an opaque ticket ID distinct from the host ID and relay route;
- the immutable host ID and current host identity epoch;
- the canonical configured `wss://` relay origin;
- requested scopes;
- creation and expiry times with a maximum lifetime of five minutes;
- state: pending, reserved, redeemed, expired, or cancelled;
- at most one opaque reservation ID and its timestamp; and
- bounded terminal attribution such as device ID or cancellation/expiry reason.

Phase 3A does not generate, accept, persist, or log a ticket PSK or one-way verifier. In Phase 3B, the crypto provider generates a CSPRNG ticket PSK, holds it only in memory while the offer is live, and supplies it to the candidate through the future pairing offer. The provider clears the PSK when the offer closes, the ticket reaches a terminal state, or hostd restarts. Because startup cancels every pending or reserved authority ticket, a pre-restart offer cannot resume with reconstructed credentials.

Phase 3A generates production ticket IDs from 256 bits of CSPRNG output; caller-selected IDs exist only behind an explicit test seam. Creation enforces bounded host-wide active and history quotas. Terminal tickets and revoked devices are compacted only after fixed retention windows; an old channel still fails because no live grant exists, and any later pairing requires a fresh random ticket and complete confirmed exchange. The future network provider must additionally enforce per-initiator and failed-attempt limits. Redemption validates the server-side lifetime and rejects anomalous records whose lifetime exceeds policy. Expiry is checked again during the atomic final transition, not only when the handshake starts.

### Pairing offer and human confirmation

The future QR offer contains only the fields required to rendezvous and authenticate pairing: version, ticket ID and provider-held ticket PSK, relay rendezvous data, host public identity/fingerprint, and requested scopes. It contains no host private material, execution credential, filesystem path, SSH credential, durable relay authorization token, or reconstructable authority-state verifier.

The receiving client displays a human-readable host name, host fingerprint, requested permissions, and a matching value derived from the authenticated handshake transcript. The host and candidate device require explicit confirmation before the device grant is committed. Display names are presentation data and never replace cryptographic identity.

Repeated matching failures cancel or exhaust the ticket. The UI never encourages bypassing a mismatch.

### Authenticated key agreement

The handshake must use a reviewed authenticated key-agreement protocol and maintained implementation. Prime Agent must not introduce a custom cryptographic construction. The security review records the selected protocol, library/version, parameter set, test vectors, and upgrade policy.

The repository retains provisional Noise `XKpsk3`/`IK` transcript schemas so security invariants and authority integration can be tested, but those names are not an architecture selection. Review now requires a cross-platform lock spike comparing TLS 1.3 over a reliable byte tunnel (native stacks or a shared `rustls` core) with a reviewed Noise implementation. `snow` is suitable only for evaluation until its lack of a formal audit is resolved by the dependency review; `@napi-rs/keyring` is not accepted for this boundary because the inspected release collapses important backend failures and silently changes Linux backends. Neither is installed. The spike must prove identical host identity, transcript/exporter binding, reconnect, rekey, replay, corrupt-frame, and version behavior across Electron, iOS, and Android before a production provider is chosen. Electron `safeStorage` is not an acceptable hostd key-store substitute because hostd is a standalone process and its Linux fallback policy is not strict enough for this boundary.

The authenticated transcript includes at least:

- protocol and handshake versions;
- cryptographic suite identifier;
- ticket ID and PSK-bound handshake context;
- canonical relay origin and rendezvous audience;
- host ID, host public key, and fingerprint;
- device public key and proposed device ID;
- both ephemeral contributions;
- requested and host-granted scopes; and
- the result of both human confirmations.

The durable device record is written only after mutual authentication, key confirmation, human confirmation, and atomic ticket redemption succeed. A crash cannot commit the device without consuming the ticket or consume the ticket while leaving an ambiguous, unaudited grant.

## Relay and encrypted-channel requirements

### Relay routing plane

- The first supported deployment is self-hosted.
- Route identifiers are random, bounded, independently revocable, and distinct from stable host IDs and device IDs.
- A routing token permits bounded delivery to a route; it does not authenticate a Prime Agent device or grant host scopes.
- Host and client connections are outbound WSS with normal certificate and hostname validation.
- The relay enforces frame, connection, route, queue, message-rate, idle-time, and retention limits before accepting payloads.
- Undelivered ciphertext expires. The relay does not become a durable source of thread truth.
- Error responses are bounded and avoid revealing whether an arbitrary host ID, device ID, or ticket exists.

### End-to-end channel

- Application messages are protected with an authenticated-encryption construction selected by the cryptographic review.
- Derivation separates host-to-device, device-to-host, handshake, notification, and rekey contexts.
- Authenticated data covers the channel ID, direction, sequence, protocol version, message class, and any relay routing fields whose substitution would matter.
- Sequence and replay state are bounded. Duplicate, too-old, impossible-future, wrong-direction, or wrong-channel envelopes fail before protocol decoding or host dispatch.
- Authentication failure closes or rate-limits the channel without returning a detailed cryptographic oracle.
- Rekey occurs before algorithm-specific message/byte limits and after configured session age. A reconnect performs a fresh authenticated channel establishment.
- Application continuity resumes from generation-aware cursors, authoritative snapshots, and durable command reconciliation, not by restoring old channel keys or nonces.
- Plaintext buffers and traffic keys have bounded lifetimes and are not written to projection caches, relay logs, or crash diagnostics.

### Relay metadata and explicit privacy limits

Even with correct E2EE, a relay can observe:

- source IP addresses and TLS connection metadata;
- route identifiers;
- connection, pairing, reconnect, and delivery timing;
- ciphertext sizes and message frequency;
- queued-versus-delivered status; and
- operational abuse signals.

The product must not claim anonymity, traffic-analysis resistance, or that the relay sees “nothing.” Public-relay documentation must state these limits. Outer notification envelopes contain only an opaque destination, bounded ciphertext, expiry, and delivery identifiers; thread title, prompt text, approval text, repository name, host name, paths, and artifact names remain encrypted.

## Authorization and capability enforcement

An authenticated relay channel yields an internal principal containing the device ID, channel ID, authenticated host ID, grant epoch, and handshake/capability version. It does not accept a scope array from relay input.

For every request, hostd either reads the durable device grant or validates a cached grant against the current monotonic grant epoch. Authorization rejects before journal admission when:

- the device is unknown or revoked;
- the principal host ID does not match this host;
- the session or grant epoch is stale;
- the required scope is absent;
- the request's device identity differs from the principal;
- the expected host or execution generation differs from authority;
- the protocol capability is absent; or
- the request exceeds resource or semantic bounds.

Scopes remain granular and default deny:

| Scope | Maximum meaning | Additional capability/state gate |
| --- | --- | --- |
| `projection.read` | Read bounded catalogs and thread projections | Compatible snapshot/replay protocol |
| `thread.follow_up` | Add a follow-up to an existing authorized thread | Does not start a new run |
| `thread.steer` | Steer a live running thread | Live authoritative execution generation |
| `thread.abort` | Request cancellation | Live/cancellable execution state |
| `thread.start` | Start work in an authorized saved project | Production session manager |
| `approval.resolve` | Resolve a claimed approval | `approval_claims_v1` and active lease |
| `run_location.change` | Request a reviewed move | `thread_handoff_v1`; does not imply live migration |
| `host.admin` | Pair/revoke/configure within explicitly defined methods | Never grants arbitrary command or filesystem access |

No scope grants arbitrary filesystem browsing. Artifact access uses explicit handles and range-read capability, not remote paths supplied by the client.

## Revocation and live-channel races

Revocation is a host-authoritative transaction:

1. Validate a trusted local/authorized administrative request and target device.
2. Persist `revokedAt`, reason, new grant epoch, and audit record atomically.
3. Publish the committed revocation to the in-memory channel registry.
4. Stop new request admission for the old epoch.
5. Close every live channel for the device and discard its session keys.
6. Return a revocation receipt only after durable state and in-memory invalidation succeed.

Crash recovery loads revocation state before accepting relay channels. A channel authenticated before a restart is never implicitly restored.

A command with a durable `received`/`admitted` receipt before the revocation commit remains attributable and reconciliable. A command that has not crossed durable admission is rejected. The UI may disclose admitted in-flight commands; it must not state that revocation reverses already admitted work.

Renaming a device does not rotate identity. Reducing scopes increments the grant epoch and closes or reauthenticates live channels just like revocation. Increasing scopes requires an explicit trusted-user review and new audit receipt.

## Key lifecycle, recovery, and rotation

### Host key

- Normal restart and compatible upgrade preserve the host identity.
- Planned rotation uses an authenticated, user-reviewed transition. The old and new fingerprints are shown, and paired devices either verify a cross-signed transition supported by the reviewed protocol or re-pair.
- Suspected compromise uses emergency rotation: cancel all tickets, revoke all device grants and routes, generate a new identity, and require re-pairing. No cross-signature from a compromised old key is trusted as sufficient confirmation.
- Restoring application data without protected private material creates a new host identity through an explicit recovery flow. It never silently adopts the old fingerprint.
- Host private-key export or backup is disabled by default. If introduced later, it requires a separate encrypted backup threat model.

### Device key

- The device generates and stores its own private key in platform secure storage.
- Hostd stores only the device public key, algorithm, fingerprint, grant, timestamps, and revocation history.
- Device-key rotation requires a reviewed authenticated rotation flow or a new pairing. A display-name change is never treated as rotation.
- Losing a device key requires revoking the old device record and pairing a new identity.

### Cryptographic agility

Protocol and suite identifiers are explicit and authenticated. New suites are additive only after review; deprecated suites become unavailable through policy and capability negotiation. Version fallback must never occur merely because a relay or peer removed a preferred offer.

## Restart, crash, and durable-state behavior

- Phase 3A installation of provider-supplied public identity metadata is atomic and is allowed only into an empty identity-less authority state. Host private-key creation remains the future provider's responsibility.
- Ticket creation, reservation updates, redemption, cancellation, and expiry are serialized with bounded durable transactions.
- Startup cancels every pending or reserved ticket before the authority can reserve or redeem another attempt.
- Device grant creation and ticket redemption are one recoverable logical transaction.
- Revocation and grant-epoch changes are durable before acknowledgment.
- A post-rename durability uncertainty poisons the live authority, invalidates its leases, and forces restart/reconciliation instead of authorizing from stale memory.
- The owned local endpoint is retained until admitted sessions and the service authority are inert; a successor cannot initialize against the same state during normal teardown.
- Startup validates schemas, ownership, permissions, file sizes, duplicate identifiers, impossible timestamps, and key/fingerprint consistency before enabling pairing or relay.
- Corrupt security state is quarantined and fails closed. It is not reset automatically.
- Incomplete transactions recover deterministically and cannot create a second grant, revive a ticket, or remove a revocation.
- Channel keys, nonces, replay windows, and live-channel registrations are memory-only. Restart requires fresh mutual authentication.
- Existing command receipts remain authoritative through restart; the device reconciles before resend.
- Security journals are bounded, exclude secrets/plaintext, and retain enough evidence to explain ticket creation, redemption, scope change, revocation, rotation, and authentication failures.

## Denial-of-service and abuse controls

Limits are configuration values with safe defaults and hard maxima. Tests must cover the maxima rather than relying on UI behavior.

- Bound outstanding tickets per host and per initiating principal.
- Bound ticket creation, lookup, failed redemption, and matching-code attempts. Exhaustion cancels the ticket.
- Bound concurrent unauthenticated handshakes separately from authenticated channels.
- Bound channels per device, devices per host, total channels, idle duration, and session age.
- Bound relay frame bytes, decrypted message bytes, frames per transport chunk, queued bytes, messages per interval, and snapshot/artifact concurrency.
- Reject declared oversize data before allocation and expensive cryptographic work where possible.
- Apply backoff to repeated authentication, decryption, replay, and unknown-route failures without exposing existence oracles.
- Prioritize revocation, approval receipts, command reconciliation, and cancellation over transcript or artifact traffic.
- Disconnect slow consumers before relay or host memory grows without bound.
- Keep relay delivery receipts and error bodies small to prevent amplification.
- A malicious relay can deny service. Clients surface the relay path as unavailable while preserving cached context and trying other authorized paths; they do not weaken authentication to recover connectivity.

## Control and verification catalog

Each control needs executable evidence. Unit tests alone do not prove transport or platform-storage behavior; integration and adversarial tests are named separately.

| Control | Requirement | Required evidence before gate passes |
| --- | --- | --- |
| `PA-ID-01` | Stable host identity | Restart/upgrade integration test returns the same canonical public key and fingerprint. |
| `PA-ID-02` | Authority/private-key separation | Durable-state, renderer, log, and crash scans contain only public identity metadata and opaque `secretRef`; Phase 3B platform tests separately verify credential-store ACLs. |
| `PA-ID-03` | Corruption fails closed | Truncated, mismatched, duplicate, and permissive identity state cannot enable pairing or silently rotate. |
| `PA-TKT-01` | Bounded ticket lifetime | Boundary tests for 60–300 seconds, clock anomaly, expiry during handshake, cancellation, and exhausted attempts. |
| `PA-TKT-02` | Atomic single use | Concurrent redemption test proves exactly one durable grant and one terminal outcome for every loser. |
| `PA-TKT-03` | Ticket secrecy | Phase 3A durable-state, log, cache, and crash scans contain neither ticket PSK nor verifier; Phase 3B tests prove provider-held PSKs remain memory-only and are cleared on terminal outcome and restart. |
| `PA-TKT-04` | Ticket is not authority | Requests carrying a ticket but no completed authenticated channel are denied before catalog access. |
| `PA-DEV-01` | Durable per-device grant | Restart test preserves public key, scopes, grant epoch, name, and audit attribution. |
| `PA-DEV-02` | Host-derived scopes | Forged context, altered scope list, device-ID spoof, cross-host target, and stale epoch fail before journal admission. |
| `PA-DEV-03` | Immediate revocation | Race test defines admitted-before/rejected-after boundary, closes all channels, blocks reconnect, and survives restart. |
| `PA-DEV-04` | Scope change semantics | Reduction closes/stales sessions; elevation requires trusted review and produces a durable audit receipt. |
| `PA-HS-01` | Mutual authentication | Known-answer/interoperability tests plus active MITM tests for wrong host key, device key, and rendezvous. |
| `PA-HS-02` | Transcript binding | Mutating version, suite, relay origin, host/device ID, ephemeral key, or scope makes confirmation fail. |
| `PA-HS-03` | Human confirmation | Mismatch, dismissal, timeout, duplicate confirmation, and attempt exhaustion create no device grant. |
| `REL-CRYPTO-01` | E2EE confidentiality/integrity | Reviewed-library vectors and packet tests show relay/network observers cannot decrypt or forge application frames. |
| `REL-CRYPTO-02` | Replay and nonce safety | Duplicate, reordered, stale, future, cross-direction, cross-channel, reconnect, and forced-rekey tests fail safely. |
| `REL-CRYPTO-03` | Downgrade resistance | Stripping capabilities/suites or rewriting protocol versions never selects an unauthenticated/weaker fallback. |
| `REL-META-01` | Minimal relay metadata | Relay capture test and schema audit show only documented routing, size, timing, expiry, and delivery fields. |
| `REL-ROUTE-01` | No unauthenticated discovery | Random probing cannot distinguish existing host/device IDs or obtain stable route identifiers. |
| `REL-NET-01` | Outbound-only self-hosted relay | Network integration test works with no inbound host port and fails if a connector attempts LAN/public hostd exposure. |
| `REL-RST-01` | Crash-safe security state | Fault injection at every ticket/grant/revoke persistence boundary recovers without double grant or resurrection. |
| `REL-DOS-01` | Bounded resource use | Stress/fuzz tests enforce connection, handshake, frame, queue, journal, snapshot, and artifact limits. |
| `REL-CMD-01` | Mutation idempotency | Disconnect at every send/admission/receipt boundary cannot duplicate `(deviceId, commandId)`. |
| `REL-NOTIFY-01` | Encrypted minimal notification | Relay capture contains no title, prompt, repo, host, path, approval text, or artifact name; duplicate delivery deep-links once. |
| `REL-COMPAT-01` | Capability honesty | Unsupported feature requests are denied and corresponding UI/control/capability remains absent. |

## Security acceptance gates

### Gate A — Phase 3A pairing authority

All of the following must pass before work proceeds to a network-accessible pairing path:

- `PA-ID-01` through `PA-ID-03`;
- `PA-TKT-01` through `PA-TKT-04`;
- `PA-DEV-01` through `PA-DEV-04`;
- bounded audit, quota, restart, and corruption tests;
- review confirming authority state contains only public identity metadata and `secretRef`, and no private key, ticket PSK, or ticket verifier enters durable state, renderer projection, or logs; and
- `relay_pairing_v1` remains unadvertised.

### Gate B — Private self-hosted pairing and relay

All of the following must pass before a controlled deployment advertises `relay_pairing_v1`:

- Gate A;
- reviewed authenticated-key-agreement design and dependency review;
- verified memory-only ticket-PSK lifecycle in the Phase 3B crypto provider;
- platform credential-store and protected-directory fallback tests for provider-owned host private keys;
- `PA-HS-01` through `PA-HS-03`;
- `REL-CRYPTO-01` through `REL-CRYPTO-03`;
- `REL-META-01`, `REL-ROUTE-01`, `REL-NET-01`, `REL-RST-01`, `REL-DOS-01`, and `REL-CMD-01`;
- immediate live-channel revocation demonstrated against the real relay;
- reconnect from cursors/snapshots and command reconciliation demonstrated without nonce or command reuse;
- no inbound hostd TCP/LAN listener; and
- independent security review of the implementation and test evidence.

### Gate C — Cross-device mutation features

Each mutation remains separately unavailable until its execution dependency passes:

- start/follow-up/steer/abort require the production session manager and event materializer;
- approvals require `approval_claims_v1` and durable lease/race semantics;
- existing-thread host switching requires `thread_handoff_v1` and the Phase 2 coordinator;
- artifact inspection requires authorized handle/range reads; and
- every mutation must pass relay identity, scope, host/generation authority, and idempotency tests.

### Gate D — Encrypted notifications

`host_notifications_v1` remains absent until `REL-NOTIFY-01`, durable attention-event creation, platform notification permission behavior, deduplication, expiry, and exact-thread/block deep linking pass.

### Gate E — Public managed relay

A public relay additionally requires:

- publication of the reviewed threat model and relay metadata disclosure;
- abuse prevention, tenant/routing isolation, retention/deletion policy, and operational key separation;
- security monitoring that does not log application plaintext or secrets;
- incident response, emergency route/key revocation, and disclosure process;
- capacity and availability testing without weakening authentication; and
- external security assessment.

## Explicit non-claims

Until the relevant gates pass, Prime Agent must not claim that:

- a phone or another desktop can control a host;
- the Companion Preview is a paired client;
- a displayed pairing policy is a working pairing protocol;
- Phase 3A generated, accepted, or stored a host private key, ticket PSK, or ticket verifier;
- the recommended Noise patterns or candidate dependencies are selected, installed, audited, interoperable, or shipped;
- `HostSessionContext` alone authenticates a relay device;
- a caller-provided device ID or scope list is trustworthy;
- TLS to a relay makes payloads end-to-end encrypted;
- the relay sees no metadata;
- revocation undoes commands admitted before its durable commit;
- granting `run_location.change` implements cross-host handoff;
- granting `approval.resolve` implements approval claims or leases;
- a relay path survives hostd restart without fresh authentication;
- the reliable byte-tunnel contract authenticates a peer, provides E2EE, or makes its routing channel ID an authenticated channel ID;
- public relay availability, anonymity, traffic-analysis resistance, or malicious-relay availability has been proven; or
- endpoint compromise can be repaired by transport cryptography.

The current product-honest state remains a read-only same-device Companion Preview with pairing and mobile mutations disabled.

## Open security decisions

These decisions block Gate B and require recorded review rather than implementation by implication:

- architecture lock between TLS 1.3 and a reviewed Noise path, including first-pairing identity binding and the shared/native implementation boundary; the provisional Noise schemas are quarantined and may require a versioned migration;
- Phase 3B host-key generation, secure storage, and canonical encoding interoperability;
- platform credential-store integrations and protected-directory fallback policy;
- device secure-storage requirements for each mobile/desktop platform;
- relay route-token lifecycle, queue retention, and optional padding policy;
- matching-value format and maximum failed confirmations;
- planned and emergency host-key rotation UX;
- relay configuration trust, enterprise proxy topology, and certificate policy;
- security journal retention and privacy policy; and
- public-relay operational ownership and incident response.
