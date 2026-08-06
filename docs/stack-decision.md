# Prime Continuim stack decision

**Decision:** keep Electron 43, React 19, Vite, TypeScript, Zod, and the plain CSS token system for the desktop application. Revisit the shell only after measured renderer/dataflow work fails a release budget.

## Why

- Prime Agent is a Node/TypeScript runtime with a persistent Python/IPython execution layer. Tauri, Flutter, Qt, and platform-native shells still need that runtime or a Node sidecar.
- Electron embeds Node 24.18.1, above Prime Agent's Node 22.8 minimum, and gives the renderer one deterministic Chromium target across desktop platforms.
- At commit `20f4058`, the measured renderer is 831,898 bytes raw and 154,595 bytes gzip. That is a 5.0% gzip increase from the pre-workbench baseline and remains below the 200 KiB release budget, so bundle size is not the current bottleneck.
- The renderer now bounds transcript and runtime-list mounting, but the current host-event hot path still replaces the whole workbench snapshot and root React state. Delta publication and consumption remain the next dataflow optimization; that is not an Electron limitation.
- A rewrite would replace thousands of lines of working renderer, main-process, hostd, and protocol code while preserving the difficult daemon/Python boundary.

The strongest contrary case is Electron's idle memory and security surface. That is a real cost. A thin Tauri remote-only client becomes worth testing if, after projection normalization and bounded rendering, Electron itself is the measured cause of missed startup, memory, or security budgets.

## Upstream runtime pin

The first supported integration target is the official Prime Agent v0.7.0 release asset:

- release target: `be9e2fa0714e7cd1c6bd9bdb1b554d2cc6550387`
- asset: `prime-agent-0.7.0.tgz`
- SHA-256: `88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b`
- app version: `0.7.0`
- daemon protocol: `prime-agent.daemon` version `7`
- schema revision: `13`
- schema ID: `protocol-7-schema-13-816309b1cd50`

The npm registry does not contain this version. Install and upgrade work must consume the official release asset, verify the published checksum before extraction, and never depend on a mutable source checkout. The runtime package remains host-only and must not enter renderer bundles.

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

Keeping the stack does not make the current build production-ready. A Continuim developer preview needs a public-surface resident adapter plus these proofs:

1. close the app while a session runs and verify the daemon session continues;
2. relaunch and reattach to the same active session;
3. restart hostd without completing the resident session;
4. fail fast on app/protocol/schema/capability mismatch; and
5. complete a session only through an explicit end-session action.

Until those pass, RPC is a foreground diagnostic path and the UI must not promise background continuity, phone control, pairing, relay, handoff, or local Windows execution.
