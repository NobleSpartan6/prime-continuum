# Prime Continuim architecture

## Product invariant

The execution location may change; the visible project, thread, history, intent, and evidence do not. “Remote” is never a separate navigation mode.

## Runtime boundaries

```text
React renderer (projection only)
  │ explicit, schema-validated IPC
  ▼
Electron shell + desktop control service
  │ one versioned, framed host protocol
  ├── local socket / named pipe ──► prime-agent-hostd
  └── system OpenSSH stdio ───────► prime-agent-hostd
                                      │
                                      └── Prime Agent adapter

Future mobile companion
  │ authenticated device session + app-layer E2EE
  ▼
Untrusted outbound WSS relay ─────────► prime-agent-hostd authorization boundary
```

The renderer owns selection, layout, ephemeral drafts, and accessibility state. It never receives private keys, raw credentials, unrestricted filesystem access, an arbitrary command runner, or the raw Electron IPC surface.

The desktop control service owns transport selection, SSH invocation, reconnect, the disposable projection cache, the explicit offline outbox, and handoff orchestration. It is not authoritative for execution.

`prime-agent-hostd` owns the host/project/thread catalog, execution generation, command journal, event sequence, snapshot, approvals, artifacts, and handoff receipts. Local and SSH execution use the same service and protocol.

Every host request requires a session context and is evaluated before dispatch; there is no implicit trusted default. The user-owned local pipe explicitly supplies the trusted-user context, and SSH stdio only bridges into that pipe. A future relay caller must provide an authenticated device identity, channel identity, and explicit scopes; a relay device cannot submit, reconcile, or commit a handoff under another device's command identity.

## Prime Agent adapter boundary

The host protocol in this application is a stable gateway contract; it is not Prime Agent's local daemon wire protocol and does not export Prime Agent's internal TypeScript types. `hostd` translates the gateway's opaque thread, artifact, cursor, and command identifiers into a pinned Prime Agent adapter.

Durable execution uses a resident daemon session through the public `DaemonClient` and `DaemonAgentConnection` surface. Ordinary desktop shutdown detaches; it must never complete the resident session. The current RPC entry path creates a client-owned session and is therefore diagnostic/fallback only: disposing it can complete the session and cannot satisfy Continuim's close-and-resume contract.

The adapter is gated against the exact Prime Agent 0.7.0 release, daemon protocol 7, schema revision 13, schema ID `protocol-7-schema-13-816309b1cd50`, and required replay/snapshot capabilities. Source constants and the daemon hello are authoritative; prose documentation and parsed CLI version strings are not. The supported CLI command `prime-agent daemon start` supplies the external launch seam because the internal daemon-launch helper is not exported. Runtime DTOs are reduced at the host boundary so renderer, mobile, and relay clients never depend on Prime Agent's local TypeScript shapes.

## Independent state machines

Connection, task, and command admission are modeled independently:

| Concern | States |
| --- | --- |
| Connection | `online`, `connecting`, `reconnecting`, `offline`, `degraded`, `authentication_required` |
| Task | `idle`, `running`, `waiting`, `needs_approval`, `complete`, `failed` |
| Command | `draft`, `waiting_for_connection`, `sent`, `queued_on_host`, `uncertain`, `running`, `completed`, `rejected`, `cancelled`, `failed` |

A dropped connection does not turn a running task into a failed task. A command becomes durable only after a host receipt. An ambiguous disconnect is reconciled by `(deviceId, commandId)` and is never blindly replayed.

## Host authority isolation

SSH aliases and local-socket paths are locators, never identities. A successful `health.get` supplies hostd's immutable `hostId`; the desktop binds that verified identity to the locator and carries it in connection state.

- The single-authority projection cache is tagged with `projectionHostId`. Catalogs, thread snapshots, and live snapshot events are schema-checked against it before use.
- Every new outbox entry stores both an outer `hostId` scope and the command's `expectedHostId`. Legacy or mismatched entries remain quarantined and are never disclosed, reconciled, or replayed.
- Submit, reconcile, and handoff requests carry `expectedHostId` through the framed protocol. Both the desktop and hostd reject an authority mismatch.
- Reconciliation keys and removal use the full `(deviceId, commandId)` identity, including when command IDs collide across devices.
- A host switch invalidates the previous renderer projection before the new authority can publish online. Stale connection, snapshot, bootstrap, and composer completions are generation-checked and ignored or rejected.
- `lastTarget` means last verified target. A failed attempt is recorded separately and cannot replace the restart target or hide the last usable offline cache.

## Projection lifecycle

1. The renderer requests a client bootstrap projection.
2. The control service returns one stable, host-scoped cache/outbox/connection snapshot without waiting for a network census.
3. It attaches to the best authorized transport with the latest generation-aware cursor and pending command IDs.
4. `hostd` provides replay when available; otherwise it provides an authoritative snapshot. A client advertising `snapshot_chunks_v1` receives large snapshots as a bounded begin/chunk/end stream rather than one oversized frame.
5. The control service validates the transfer identity, exact ordering and byte count, SHA-256, UTF-8, JSON, and projection schema before it applies the replacement atomically, persists it, then emits one projection event. No partial transfer is observable as projection state.

Cached state is useful but disposable. It can make content immediate; it cannot confer execution authority.

## Transport contract

All transports carry the same bounded, length-prefixed JSON frames. Dynamic values are sent inside frames after a fixed process command starts. Snapshot chunks are backpressure-aware and individually frame-bounded; the shipped ceiling is 8 MiB. File-backed reassembly, bulk-channel preemption, transfer cancellation, and stress evidence remain release gates before raising that ceiling to 50 MiB.

- Local: user-owned named pipe on Windows, Unix-domain socket elsewhere.
- SSH: `ssh <alias> prime-agent-hostd connect --stdio`, passed as an argument array without shell interpolation.
- Relay: future outbound, end-to-end encrypted transport implementing the same interface.

## Mobile companion boundary

The compact Companion Preview is a renderer surface, not a second client architecture. `?surface=companion` consumes the same selected thread, catalogs, connection status, snapshot, and evidence projection as the desktop. It is read-only in this milestone; disabled controls make clear that no credential, command, or network request is created.

Real phone control must preserve the desktop authority rules through this topology:

1. Desktop/hostd and phone establish an authenticated, short-lived, single-use pairing ticket through an outbound `wss://` relay.
2. Both devices require a user-confirmed matching code and bind the result to the immutable host identity.
3. Application-layer end-to-end encryption, sequence/replay protection, and bounded frames keep the relay unable to read or forge protocol data.
4. The host persists one public device identity and a default-deny scope set per phone. Scopes are granular: projection read, follow-up, steer, abort, start, approval resolution, run-location change, and host administration. A new `prompt` requires `thread.start`; follow-up permission cannot start a run.
5. Every mutation carries the paired `deviceId`, `commandId`, and `expectedHostId`; hostd checks both session identity and scope before journal admission.
6. Per-device revocation closes active channels and blocks reconnection. Rotation, expiry, rate limits, compatibility, and audit records are required before advertising relay pairing.

The shared protocol now validates public pairing/device/policy descriptors, and hostd has the authoritative session/scope gate. It deliberately has no relay listener, key store, QR/code generator, or pairing credentials yet. Hostd is never exposed through an interim LAN HTTP/WebSocket server.

## Desktop security baseline

- Sandboxed renderer, context isolation on, Node integration off.
- Local packaged renderer content only.
- Restrictive Content Security Policy.
- Navigation, new windows, and unneeded permissions denied.
- IPC sender checked against the main frame.
- One method per bounded command; the renderer never receives `ipcRenderer`.
- System OpenSSH remains responsible for keys, agents, proxy jumps, and host verification.
- SSH aliases are resolved with `ssh -G`; private-key contents are never opened.
- No unauthenticated TCP listener.
- Relay-originated operations are default deny and must pass device identity plus per-request scope authorization before dispatch.

## Handoff authority rule

A move is `quiesce → checkpoint → transfer → materialize → verify → switch authority`. It is not live process migration. The source generation stays authoritative until destination verification completes, and a failed move returns a structured receipt without changing authority.

## Delivery boundary

The first executable milestone proves one local host and the SSH transport seam, durable receipts, cached startup, reconnection, honest move planning, and the read-only mobile supervision projection. A remote developer preview additionally requires a real close → continue → relaunch → reattach proof against the pinned resident adapter. Secure pairing, relay routing, mobile mutations, managed compute, and multi-user collaboration remain additive consumers of the protocol rather than alternate architectures.
