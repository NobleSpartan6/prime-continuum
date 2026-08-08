# prime-agent-hostd boundary

`hostd` is the durable, per-user authority for host, project, thread, snapshot,
command-receipt, and handoff state. The Electron window is a projection client.

## Transport

Local clients connect to a Windows named pipe or Unix domain socket. Remote SSH
clients run the fixed command `prime-agent-hostd connect --stdio`; that process
bridges framed bytes to the already-running local service, so an SSH process
never becomes a second authority. There is no TCP listener.

Both paths carry protocol v1 frames: a 4-byte unsigned big-endian payload length
followed by one UTF-8 JSON document. The default maximum frame payload is 1 MiB.

## Protocol versus Prime Agent runtime transports

The DTOs in `../shared/protocol.ts` are Prime Continuim's public host protocol.
They are not the local Prime Agent daemon or RPC wire format. The production
translation boundary must attach to a resident session through the pinned public
`DaemonClient` and `DaemonAgentConnection` API. The upstream RPC entry path owns
its session and can complete it on disposal, so `gateway.ts` retains RPC only as
a foreground diagnostic/fallback implementation. It spawns the fixed argument
vector `prime-agent --mode rpc` with `shell: false`, then maps host commands to
strict LF-delimited JSON requests:

- `prompt` -> `{ id, type: "prompt", message }`
- `steer` -> `{ id, type: "steer", message }`
- `follow_up` -> `{ id, type: "follow_up", message }`
- `abort` -> `{ id, type: "abort" }`

An RPC success acknowledges admission only. Later execution failure is an event,
not a second response to the command ID. Host-level `(deviceId, commandId)`
receipts remain durable and authoritative across adapter or client restarts.

The release-attested composition now constructs this resident adapter and
reattaches only bindings that were already durably recorded by `HostStore`.
It advertises `prime_agent_commands_v2` only after every current binding has
attached exactly; a fresh store with no binding remains unavailable because
session creation is not part of this checkpoint.

The detached daemon is a user-trusted coding runtime, not a credential sandbox.
Its environment inherits the launching hostd's provider and project-tool
variables after Continuim removes Node preload/module-resolution injection and
Prime Agent internal role markers. Those remaining variables are available to
Prime Agent and commands it runs. Launch Continuim from a deliberately minimized
environment when project code or model-driven commands are not fully trusted.

The resident adapter must fail closed unless the daemon hello reports Prime
Agent 0.7.0, protocol 7, schema revision 13, schema ID
`protocol-7-schema-13-816309b1cd50`, and every required snapshot/replay
capability. Normal disposal detaches. Only an explicit end-session operation may
complete or kill the session.

Resident `prompt` and `abort` use a store-minted opaque dispatch lease. The
exact command and binding are journaled before the lease becomes dispatchable,
`dispatching` is durable before the one upstream call, and a host restart never
replays an ambiguous call. Prompt success means runtime ownership; abort
success means the cancellation request was accepted. Neither response is
treated as authoritative idle. An acknowledged prompt or Stop retains its exact
lock and nonterminal `running` receipt until the same attached connection crosses
Prime Agent's public `waitForIdle` barrier, drains its event work, and proves a
stable exact-binding inactive projection. HostStore then commits the operation's
dedicated completed receipt and idle-observed event before emitting the trailing
`thread.changed` invalidation. The Stop proof alone may replace a lagging active
projection at the same upstream cursor, under the exact store-branded Stop lease;
a generic publication still rejects different content at one cursor. Startup
discovers acknowledged locks and retries only this read-only proof, never the
prompt or abort mutation.

Uncertain prompt and Stop attempts remain durable mutation barriers. An
uncertain prompt's original concurrent preflight may still gain ownership after
an unrelated snapshot read. An uncertain abort may still take effect after its
transport result is lost and cancel later work, so it is not eligible for the
acknowledged-Stop idle proof and returns nonretryable recovery-required admission
errors. Safe retirement requires a future daemon-level atomic
`abort_and_quiesce` epoch or verified session rotation; an ordinary
`abort` followed by `waitForIdle` is not an ordering fence in Prime Agent 0.7.0.

## Admission durability

Command admission is a write-ahead transaction. Before changing a projection,
hostd atomically persists the final receipt, exact candidate snapshot/catalog,
and deterministic journal/event records in `transactions/`. It then writes the
snapshot and thread catalog before making the receipt visible. Startup replays
unfinished transactions byte-for-byte; JSONL audit records use deterministic
IDs and atomic append-with-deduplication, so replay cannot create extra blocks,
queue entries, command states, or events.

Resident runtime snapshots use the same write-ahead discipline in
`resident-projection-transactions/`. A prepared publication contains the exact
public snapshot and thread catalog, is fenced to the still-active resident
binding and execution generation, and is replayed before startup serves any
reader. The catalog summary's recap, timestamp, and cursor therefore advance
with the authoritative runtime projection instead of lagging behind it.

Approval objects require a daemon adapter that supports claims and leases; the
minimal RPC adapter rejects that mapping instead of inventing semantics.
