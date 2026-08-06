# Native control boundary

`DesktopControlService` is the only adapter between renderer-safe IPC values and
the host protocol. The renderer never receives a socket, child process,
filesystem primitive, or `ipcRenderer` handle.

Wire assumptions are imported from `src/shared/protocol.ts` and
`src/shared/frame-codec.ts`:

- protocol version 1;
- unsigned 32-bit big-endian payload length followed by UTF-8 JSON;
- 1 MiB maximum per frame;
- `health.get`, `catalog.snapshot`, `thread.snapshot`, `command.submit`,
  `command.reconcile`, `handoff.plan`, and `handoff.commit` methods; and
- the shared response schemas are validated before results cross IPC.

Local endpoint logic intentionally mirrors the pure exports in
`src/hostd/paths.ts` without importing the host service into Electron's main
bundle. `tests/main/local-hostd-paths.test.ts` guards parity.

Remote commands are fixed argument arrays. Dynamic values enter only protocol
frames after `prime-agent-hostd connect --stdio` starts. Remote installation is
an explicit-consent API, but this build truthfully returns a non-executable plan
until a signed package and checksum verifier are bundled; it never falls back to
a shell or download bootstrap.
