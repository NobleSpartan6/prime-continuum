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

The Electron shell owns an explicit set of trusted renderer windows: one workbench and, when requested, one singleton desktop HUD. Both receive projections from the same `DesktopControlService`; neither renderer owns a transport or host authority. Control-service events fan out only to those exact live main frames, while HUD lifecycle IPC separately enforces main-only open/retarget and HUD-only mode, close, return, and transparent-pixel mouse-forwarding operations. The auxiliary window uses the same sandboxed preload boundary and renderer bundle. Its ephemeral target is an exact host/thread/execution-generation tuple and is never written to the geometry store.

The HUD has `expanded` and `buddy` presentation modes. Expanded mode reuses the real transcript and resident composer; buddy mode is a compact status projection that expands back into that surface. Closing destroys the auxiliary BrowserWindow, while collapsing keeps it available. Only versioned per-mode bounds and the last explicitly chosen mode persist, and live display changes rehome the complete surface inside a current work area. It is an independent always-on-top companion, not a native attachment to, observer of, or controller for the application underneath it.

The desktop control service owns transport selection, SSH invocation, reconnect, the disposable projection cache, the explicit offline outbox, and handoff orchestration. It is not authoritative for execution.

`prime-agent-hostd` owns the host/project/thread catalog, execution generation, command journal, event sequence, snapshot, approvals, artifacts, and handoff receipts. Local and SSH execution use the same service and protocol.

Every host request requires a session context and is evaluated before dispatch; there is no implicit trusted default. The user-owned local pipe explicitly supplies the trusted-user context, and SSH stdio only bridges into that pipe. A future relay caller must provide an authenticated device identity, channel identity, and explicit scopes; a relay device cannot submit, reconcile, or commit a handoff under another device's command identity.

## Prime Agent adapter boundary

The host protocol in this application is a stable gateway contract; it is not Prime Agent's local daemon wire protocol and does not export Prime Agent's internal TypeScript types. `hostd` translates the gateway's opaque thread, artifact, cursor, and command identifiers into a pinned Prime Agent adapter.

Durable execution uses a resident daemon session through the public `DaemonClient` and `DaemonAgentConnection` surface. Ordinary desktop shutdown detaches; it must never complete the resident session. On a release-attested local host, native provisioning first commits exact workspace/thread authority, creates a Prime Agent `client_owned` candidate, durably records its identity, promotes it once, requires a stable exact projection, and only then activates the binding. Lost outcomes quarantine instead of replaying an external mutation. Existing bindings reattach independently, and prompt/abort dispatch uses a store-minted generation lease. Prompt and abort acknowledgements mean the upstream daemon accepted ownership or the cancellation request, not that the turn is finished. Each acknowledged operation remains a durable non-replayable ownership barrier until the same attached connection crosses Prime Agent's public `waitForIdle` boundary, drains event work, publishes an exact-binding inactive projection, and HostStore commits the operation-specific idle proof. An uncertain prompt or Stop remains locked: Prime Agent v0.7.0 has no public cross-client admission/quiescence epoch that can prove a timed-out mutation will not take effect later. The legacy foreground RPC entry path remains diagnostic/fallback only because it owns and can complete the session it creates; native provisioning uses the separate durable escrow coordinator.

The adapter is gated against the exact Prime Agent 0.7.0 release, daemon protocol 7, schema revision 13, schema ID `protocol-7-schema-13-816309b1cd50`, and required replay/snapshot capabilities. Source constants and the daemon hello are authoritative; prose documentation and parsed CLI version strings are not. The supported CLI command `prime-agent daemon start` supplies the external launch seam because the internal daemon-launch helper is not exported. Runtime DTOs are reduced at the host boundary so renderer, mobile, and relay clients never depend on Prime Agent's local TypeScript shapes.

## Independent state machines

Connection, task, and command admission are modeled independently:

| Concern | States |
| --- | --- |
| Connection | `online`, `connecting`, `reconnecting`, `offline`, `degraded`, `authentication_required` |
| Task | `idle`, `running`, `waiting`, `needs_approval`, `complete`, `failed` |
| Command | `draft`, `waiting_for_connection`, `sent`, `queued_on_host`, `uncertain`, `running`, `completed`, `rejected`, `cancelled`, `failed` |

A dropped connection does not turn a running task into a failed task. A command becomes durable only after a host receipt. Every current command mutates an existing thread, so its immutable envelope includes the expected host, thread, execution generation, stable issue time, payload, and `(deviceId, commandId)`. An ambiguous disconnect is reconciled against that complete envelope and is never blindly replayed. A future thread-creation operation must be a separate host-authoritative transaction that mints its first generation; omission is not a creation signal.

## Host authority isolation

SSH aliases and local-socket paths are locators, never identities. A successful `health.get` supplies hostd's immutable `hostId`; the desktop binds that verified identity to the locator and carries it in connection state.

- The workbench exposes one active authority at a time while retaining separately tagged per-host cache entries. Every catalog, thread snapshot, and live snapshot event is schema-checked against its `projectionHostId` and execution generation before it can enter the active projection.
- Every new outbox entry stores both an outer `hostId` scope and the command's exact host/thread/generation authority plus one stable `issuedAt`. That timestamp is immutable identity and audit metadata, not trusted causal time or a substitute for an execution-generation fence. Legacy entries missing any immutable field, structurally invalid entries, and mismatched entries remain stored but quarantined and are never disclosed as actionable work, reconciled, or replayed.
- Before an outbox write or network send, the desktop reserves the device-global `(deviceId, commandId)` in a private durable ledger using a SHA-256 digest of the canonical host envelope. Terminal outbox removal does not remove that reservation, so a later host switch or restart cannot reuse the identity for changed authority or content. The current JSON ledger is a bounded correctness checkpoint, not the final high-throughput store.
- Submit and reconcile carry the complete command envelope through the framed protocol. Hostd never fills a missing generation from its current catalog, and both the desktop and hostd reject authority mismatch.
- This exact-envelope contract is negotiated as `prime_agent_commands_v2`. The desktop treats `prime_agent_commands_v1` as a legacy, non-actionable capability, so mixed-version connections stay read-only instead of downgrading command semantics.
- Host admission writes a private exact-envelope identity sidecar atomically with every new receipt. Exact duplicates can recover the recorded receipt; reusing `(deviceId, commandId)` with a changed host, thread, generation, issue time, kind, or payload fails closed. Reconciliation proves this same envelope before an outbox entry can be removed.
- A local acknowledged resident prompt or Stop remains in an operation-specific reconcile-only desktop outbox state until the host commits its exact idle proof. The acknowledgement is nonterminal; only `resident.prompt_idle_observed` or `resident.abort_idle_observed` carries the matching completed receipt, and a reconnect can recover that receipt without replaying the mutation. Settled uncertain attempts remain visible recovery barriers rather than being inferred complete. Completed-receipt correlation is still device-local. Separately, `resident_control_projection_v1` exposes a polling-only host read model under `projection.read`: exact host/thread/generation, path-free binding fingerprint, authoritative cursor, one current Prompt/Stop slot, and monotonic Store sequence. Stop takes precedence while both barriers coexist; detach and activity without a current operation report uncertainty rather than synthesized idle; terminal End remains observable. This read model grants no mutation authority and production has no relay connector or mobile client.
- The current safe reconciliation transport sends one full envelope per read-only request so worst-case JSON escaping remains below the one-MiB frame. A future performance optimization may use a shared canonical digest or byte-aware batching, but it must preserve the same equality proof.
- A host switch invalidates the previous renderer projection before the new authority can publish online. Stale connection, snapshot, bootstrap, composer completion, command receipt, and thread snapshot generations are ignored or rejected.
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

## Mobile capability boundary

The desktop exposes no mobile destination, pairing flow, phone projection, or mobile command while the required transport and identity stack is unavailable. Real phone control must use the same host authority rules; it cannot be represented by seeded renderer data or a same-device stand-in.

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
