# Prime Continuim

Development-stage native control-plane foundation for durable [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) coding sessions.

> **Current status:** this repository is a Phase 0/Phase 1 protocol and desktop-UI foundation, not a production remote-agent release. Production resident commands, remote SSH installation and upgrades, cross-host handoff, relay connectivity, and mobile control remain deferred and fail closed. Packaging has been verified only as an unsigned Windows x64 development artifact; macOS and Linux packaging still require platform CI and release verification.

The intended product is a cross-platform workbench that preserves one project-and-conversation experience across local and SSH-backed hosts. The current build provides the security, protocol, persistence, and interface seams needed to continue that work without presenting the deferred execution paths as available.

## Requirements

- Node.js 22.12 or newer (`24.14.0` is pinned in `.node-version` for reproducible local development)
- pnpm 11 (`pnpm install` also provides the reviewed, build-only npm 10.9.8 runtime assembler)
- System OpenSSH client

For a standalone Prime Agent installation on macOS or Linux, the official stable installer is:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

Review the installer before running it. Prime Continuim never runs that command automatically, and it does not replace Continuim's separately verified host service. Prime Agent executes model-generated Python and project commands with the host user's permissions; its worker and kernel processes provide lifecycle isolation, not a security sandbox. Use an external sandbox for untrusted work. See the upstream [quickstart](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md) and [Windows guidance](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/windows.md).

## Development

```powershell
pnpm install
pnpm dev
```

Run the renderer by itself for browser-based visual checks:

```powershell
pnpm dev:web
```

The desktop workbench keeps one durable thread as the primary surface. Press `Ctrl+K` (or `Cmd+K`) to search the active host projection and open controls that its negotiated capabilities allow. The production composition does not yet advertise resident command execution or cross-host handoff. The evidence inspector is contextual and closed by default; reported runtime facts stay scoped to the active thread.

Open **Models & accounts** to inspect the secret-free compatibility catalog reported by the verified Prime Agent runtime on the selected host. The exact Prime Agent v0.7.0 artifact currently projects 1,169 model routes across 32 providers, including current GPT-5.6, Claude 5, Gemini 3.6, DeepSeek V4, Kimi K3, GLM-5.2, Qwen3.6, MiniMax M3, Mistral, and gpt-oss families. This list is generated from the installed runtime rather than maintained as a renderer allow-list. The runtime reports OAuth compatibility metadata for ChatGPT Plus/Pro (Codex), Claude Pro/Max, and GitHub Copilot.

Host-only development foundations now exist for generation-bound resident model selection and local ChatGPT sign-in through Prime Agent's pinned `openai-codex` provider. They are not yet exposed as renderer controls, and production host startup does not enable the OAuth path. Prime Agent v0.7.0 persists those OAuth credentials to plaintext `auth.json`, so Continuim requires an exact development opt-in and does not describe that path as secure credential storage. A production release remains blocked on OS-backed credential custody, durable OAuth restart reconciliation, and the resident execution gateway. Until the renderer integration lands, authenticate by running `/login` in Prime Agent on that host. [OpenAI's authentication documentation](https://developers.openai.com/codex/auth) distinguishes ChatGPT subscription access from separately billed API-key usage.

Open **Companion preview** from the sidebar to inspect the pairing requirements and launch the read-only phone projection. For a direct browser preview, visit:

```text
http://127.0.0.1:5173/?surface=companion
```

The Companion Preview consumes the same host-scoped renderer projection as the desktop. It does not create pairing material, credentials, commands, a LAN listener, or a relay connection. Actual phone control remains disabled until the security gates in `docs/implementation-status.md` are implemented.

## Architecture

The Electron renderer is a projection only. Explicit, validated IPC commands reach a desktop control service, which speaks one framed host protocol over either a local socket or SSH stdio. `prime-agent-hostd` owns durable thread state, command receipts, snapshots, and execution authority. Authoritative snapshots can negotiate bounded 512 KiB begin/chunk/end delivery with an exact byte count and SHA-256; the desktop applies them only after complete schema-validated reassembly.

Future mobile sessions use the same public protocol through an outbound, end-to-end encrypted relay. Host authorization is modeled as authenticated, device-bound sessions with granular scopes; no host service is exposed directly on the local network.

See `docs/architecture.md` for the detailed boundary and protocol decisions.

## Verification

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm build:runtime
pnpm verify:runtime:smoke
```

On the verified Windows x64 development path, `pnpm package` keeps Windows
executable resource editing and ASAR integrity enabled, then rejects a
truncated PE image, missing hardening fuses, any
main/preload/renderer ASAR byte that differs from the current build, a packaged
host daemon mismatch, or a Prime Agent runtime seed that differs from the exact
pointer, manifest, file list, and tree built in that run. The verifier also
requires one byte-identical runtime attestation in both hostd and the ASAR,
matches its exact Electron/Node/ABI tuple to the packaged executable, scans
main/preload/renderer/hostd for host-only dependency leakage, starts the
packaged Prime Agent daemon through Electron's RunAsNode mode, checks its
pinned protocol identity, and requires a clean shutdown. The current unsigned
artifact labels this assurance `development-integrity`; it does not claim
adversarial authentication. No equivalent macOS or Linux package has been
verified yet.
Leave enough local disk space for Electron's executable rewrite; synced folders
can otherwise defer the out-of-space failure until after Electron Builder exits.
If Electron Builder 26.8.1 cannot create two unused macOS symlinks in its helper
cache, provision the pinned artifact in a separate, digest-qualified user cache
and rerun packaging:

```powershell
$env:ELECTRON_BUILDER_CACHE = & .\scripts\prepare-windows-build-cache.ps1
pnpm package
```

The preparation script verifies the upstream SHA-512, excludes only the two
macOS links, validates the required Windows tools, and refuses to overwrite an
unexpected cache target. Do not work around the cache defect by disabling
`win.signAndEditExecutable`, and do not share this writable cache across trust
boundaries.

Signed distribution still requires the product icon, platform signing identities, release metadata, and platform-native packaging verification.

The current repository is a Phase 0/Phase 1 protocol/UI foundation with verified
development components, an inert Phase 3A pairing-authority seam, and an
isolated relay package. Neither Phase 3A seam is wired to the renderer, so this
is not a production remote release. See
`docs/implementation-status.md` for the executable boundary and explicit
deferrals.
