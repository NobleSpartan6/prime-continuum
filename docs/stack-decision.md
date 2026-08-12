# Prime Continuim stack decision

**Decision:** keep Electron 43, React 19, Vite, TypeScript, Zod, and the plain CSS token system for the desktop application. Revisit the shell only after measured renderer/dataflow work fails a release budget.

## Why

- Prime Agent is a Node/TypeScript runtime with a persistent Python/IPython execution layer. Tauri, Flutter, Qt, and platform-native shells still need that runtime or a Node sidecar.
- Electron embeds Node 24.18.1, above Prime Agent's Node 22.8 minimum, and gives the renderer one deterministic Chromium target across desktop platforms.
- Hermes Desktop independently validates the same Electron + React boundary for a polished, cross-platform agent client. Its strongest reusable ideas are architectural—chat as home, contextual panes, direct manipulation, persistent expensive views, and strict focus ownership—not its dependency breadth or pane editor.
- The exact production eager JavaScript closure is 542,947 bytes raw / 150,474 bytes gzip. Markdown rendering, Models & accounts, internal visual-QA fixtures, protocol validators, and inspector features load behind caught static boundaries. The build measures final emitted bytes, enforces the 200 KiB gzip release budget, and currently retains 54,326 bytes of headroom.
- The renderer now bounds transcript and runtime-list mounting, but the current host-event hot path still replaces the whole workbench snapshot and root React state. Delta publication and consumption remain the next dataflow optimization; that is not an Electron limitation.
- A rewrite would replace thousands of lines of working renderer, main-process, hostd, and protocol code while preserving the difficult daemon/Python boundary.

The strongest contrary case is Electron's idle memory and security surface. That is a real cost. A thin Tauri remote-only client becomes worth testing if, after projection normalization and bounded rendering, Electron itself is the measured cause of missed startup, memory, or security budgets.

## Client and runtime boundary

The current Prime Agent architecture reinforces the chosen split: the UI owns rendering, input, and local preferences; `AgentConnection` fronts a local daemon supervisor; workers own root session trees, schedulers, kernels, and descendants. Continuim should adapt that client intent model into stable host-owned DTOs rather than import upstream runtime objects into the renderer.

Prime Agent's local daemon protocol is not a hosted or mobile gateway. Remote control therefore continues through Continuim's authenticated host transport and eventual end-to-end encrypted relay. The interface must not expose a daemon socket, imply that Prime Agent ships remote access, or label worker/kernel process separation as a security sandbox.

## Upstream runtime pin

The current supported integration target is the official Prime Agent v0.7.1 release asset:

- release target: `95afd319a78ae017a41241d50b013d656a0685ce`
- asset: `prime-agent-0.7.1.tgz`
- SHA-256: `d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb`
- app version: `0.7.1`
- runtime build ID: `95afd31-dirty`
- daemon protocol: `prime-agent.daemon` version `7`
- schema revision: `13`
- schema ID: `protocol-7-schema-13-816309b1cd50`

The npm registry does not contain this version. Install and upgrade work must consume the official release asset, verify the published checksum before extraction, and never depend on a mutable source checkout. The runtime package remains host-only and must not enter renderer bundles.

The public stable installer is a separate distribution path for macOS and Linux:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

It downloads a versioned release and verifies SHA-256. Continuim may show this as reviewed terminal guidance, but must not silently execute it or present it as the signed Continuim host-service installer. Windows setup currently requires Bash upstream; no native PowerShell or MSI claim is allowed.

## Performance budgets

These are engineering gates, not published product claims:

- renderer bundle: at most 200 KiB gzip, with review for unexplained growth above 10%;
- cached shell usable within 2.5 seconds and cold first paint within 1.5 seconds p95 on a declared reference machine;
- input-to-paint under 100 ms p95 with no main-thread task above 50 ms during streaming;
- at most one streaming publication per display frame;
- no full workbench reconstruction for a transcript-only delta;
- no more than 240 transcript blocks mounted by default (200 plus bounded overscan); and
- 10,000-message, reconnect, 100 MiB-session, and simultaneous subagent stress fixtures before a remote release.

Screen readers receive summarized lifecycle/attention announcements, never token-by-token live output.

## Release boundary

Keeping the stack does not make the current build production-ready. The local development checkpoint now uses the pinned public resident surface for crash-safe client-owned creation/promotion, exact projection-gated activation, detach/relaunch, hostd restart, and operation-specific Prompt/Stop idle proof. Lost external mutation outcomes quarantine instead of replaying. The legacy RPC path remains a foreground diagnostic path because it owns the session it creates.

Production still requires a packaged desktop-to-coordinator escrow E2E, an authorized provider-backed Prompt/Stop/end/restart E2E, recovery through verified session rotation for genuinely uncertain or quarantined mutations, an explicit end-session UI/coordinator whose runtime call consumes Store authority, ledger compaction, and signed release integrity. Until those pass, the UI must not promise production background continuity, phone control, pairing, relay, handoff, or production-authorized local Windows execution.
