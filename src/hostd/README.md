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

The resident adapter must fail closed unless the daemon hello reports Prime
Agent 0.7.0, protocol 7, schema revision 13, schema ID
`protocol-7-schema-13-816309b1cd50`, and every required snapshot/replay
capability. Normal disposal detaches. Only an explicit end-session operation may
complete or kill the session.

## Admission durability

Command admission is a write-ahead transaction. Before changing a projection,
hostd atomically persists the final receipt, exact candidate snapshot/catalog,
and deterministic journal/event records in `transactions/`. It then writes the
snapshot and thread catalog before making the receipt visible. Startup replays
unfinished transactions byte-for-byte; JSONL audit records use deterministic
IDs and atomic append-with-deduplication, so replay cannot create extra blocks,
queue entries, command states, or events.

Approval objects require a daemon adapter that supports claims and leases; the
minimal RPC adapter rejects that mapping instead of inventing semantics.
