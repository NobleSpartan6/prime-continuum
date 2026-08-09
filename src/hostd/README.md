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

`runtime.integrity.repair` is a trusted-local, path-free recovery boundary, not
an installer repair. Hostd advertises it only for an eligible nonretryable
installed-runtime failure in a generation that has issued no verified handle
and has no active, prepared, or quarantined resident lifecycle state. The
request repeats the exact host, trust anchor, runtime target, and failed-state
timestamp. Repair fully validates the app-bundled attested seed before moving
anything, quarantines only that target's content-addressed installed image and
current pointer, then re-promotes and re-verifies the bundle. Projects, threads,
workspaces, credentials, and resident state are outside its addressable paths.
Two validated quarantine generations are retained; older evidence is pruned
only after a replacement is pointer-current and fully verified, with restart
recovery for an interrupted prune. Unknown quarantine entries fail closed.

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

The release-attested composition constructs this resident adapter inside an
isolated Worker. With no binding, it advertises lifecycle setup only after the
Worker and pinned public modules preflight successfully. Native provisioning
then bootstraps exact workspace/thread authority, creates a `client_owned`
session, persists its candidate before promotion, publishes a stable initial
projection, and commits the binding. `prime_agent_commands_v2` is advertised
only while at least one current exact binding is projection-ready; each command
and proof still checks its selected binding independently.

The detached daemon is a user-trusted coding runtime, not a credential sandbox.
Its environment inherits the launching hostd's provider and project-tool
variables after Continuim removes Node preload/module-resolution injection and
Prime Agent internal role markers. Those remaining variables are available to
Prime Agent and commands it runs. Launch Continuim from a deliberately minimized
environment when project code or model-driven commands are not fully trusted.

The resident adapter must fail closed unless the daemon hello reports Prime
Agent 0.7.1, protocol 7, schema revision 13, schema ID
`protocol-7-schema-13-816309b1cd50`, and every required snapshot/replay
capability. Normal disposal detaches. Only an explicit end-session operation may
complete or kill the session.

An explicit `resident.end` is a path-free trusted-local lifecycle request bound
to the exact host, thread, execution generation, and reviewed
`expectedSourceCursor`. Cursor drift rejects the request before the ending WAL,
binding revocation, adapter acquisition, or daemon kill. Once admitted,
HostStore durably records `ending`, revokes resident command authority, and
issues the one-shot end lease. The adapter then requires the unchanged active
binding and an exact list-visible `draft` or `live` daemon session, including its
session file, workspace, and verified runtime identity, before that lease can
cross the single upstream kill call. A definitive acknowledgement commits the
completed tombstone and terminal projection; an uncertain post-invocation
result is quarantined and never replayed.

A confirmed End preserves an existing `complete` or `failed` task outcome
(otherwise it becomes `idle`), plus transcript, Git, evidence, and unrelated
catalog history. It clears live runtime, stream, queue, approval, child-agent,
goal, schedule, and attention state; sets the exact recap `Resident session
ended.`; and publishes only
`{ version: 1, state: "ended", operationId, bindingFingerprint, endedAt, sourceCursor, reason: "user_end" }`
as the public resident disposition. No raw daemon identity is exposed. Restart
and exact request replay return the same completed result without restoring a
binding or session or invoking kill again.

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
`abort` followed by `waitForIdle` is not an ordering fence in Prime Agent 0.7.1.

`resident_control_projection_v1` is the polling-only multi-device prerequisite,
not a mobile-control claim. `thread.control.snapshot` requires the exact expected
host, thread, and execution generation and returns only a path-free binding
fingerprint, authoritative cursor, one current Prompt/Stop slot, and a
Store-owned monotonic sequence. Stop is projected while it coexists with the
prompt it is quiescing. Detach, lifecycle transition, active state without a
current command identity, and uncertain mutation outcomes never become inferred
idle. Duplicate polls are byte-stable and terminal End survives restart. The
bounded generation registry validates all compaction candidates before it
retires only generations no longer current in the catalog; it fails closed when
all retained generations remain current and never pressure-prunes terminal End.
Relay callers additionally need a current authenticated channel with
`projection.read`; this endpoint neither submits nor reconciles a mutation.

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
