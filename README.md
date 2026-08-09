# Prime Continuim

[![Cross-platform source gates](https://github.com/NobleSpartan6/prime-continuum/actions/workflows/cross-platform-source.yml/badge.svg)](https://github.com/NobleSpartan6/prime-continuum/actions/workflows/cross-platform-source.yml)

A native desktop workbench for durable [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) coding sessions.

The current Windows development build follows one local-first path: start the
verified service and bundled runtime, choose a workspace, then open its durable
thread. Provisioning, explicit End, restart recovery, exact reselection, and
fail-closed command ownership are implemented and tested.

Production resident commands that invoke a provider, remote SSH installation
and upgrades, cross-host handoff, relay connectivity, mobile control, signed
distribution, and automatic updates remain unavailable. Those controls are
omitted or disabled instead of being represented by demo data. Packaging is
verified only as an unsigned Windows x64 development artifact. Linux x64,
Windows x64, and macOS arm64 source gates run on separate GitHub-hosted VMs,
but macOS and Linux packaging require native artifact and lifecycle verification
and remain unverified.

## Windows development installer

The configured Windows development path is a one-click, per-user x64 installer.
A separate Node.js, pnpm, or Prime Agent installation is not needed to launch the
desktop and bootstrap its verified local host/runtime: the exact verified Prime
Agent runtime seed and Continuim host service are bundled and initialized on
first launch. The installer is configured to create **Prime Continuim**
shortcuts on the desktop and Start menu, then launch the app when setup
finishes.

That bootstrap boundary is narrower than a complete coding environment. Real
coding turns and tool use still require a supported Windows Bash environment
(currently Git Bash), provider sign-in or credentials, and network access when
Python workflows need `uv`, Python 3.11, or additional packages. Installer and
package smoke tests do not prove those provider-backed workflows. The optional
**Use another computer** path also relies on Windows OpenSSH plus an existing
key or agent configuration; the desktop does not provide a password prompt.

The current artifact is intentionally unsigned and is suitable only for
controlled development testing. Windows may show an unknown-publisher warning;
there is no automatic updater, signed download channel, or release-supported
upgrade/repair flow yet. Obtain the installer and its checksum from the same
trusted build output, then verify them before opening the installer:

```powershell
$installer = '.\Prime-Continuim-0.1.0-windows-x64-setup.exe'
$expected = (Get-Content "$installer.sha256" -Raw).Split()[0]
$actual = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Prime Continuim installer checksum mismatch.' }
Start-Process $installer
```

The installer is configured to appear as **Prime Continuim 0.1.0** in Windows
Installed apps. Closing the desktop does not stop its detached local host
service. App and host state are retained by design, and uninstall/upgrade
behavior with that service or a resident session active has not yet passed a
release lifecycle test; use this installer only in controlled development.

## Development requirements

- pnpm 11.9 or newer. `pnpm install` downloads the checksummed Node.js 24.14.0 runtime pinned by this repository and uses it for every repo workflow.
- If pnpm cannot start on the machine yet, install Node.js 24.14.0 first, reopen the terminal, and then run `pnpm install`.

Windows OpenSSH is optional and is needed only for **Use another computer**.

## Standalone Prime Agent

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

After `pnpm install`, you do not need to switch the terminal's global Node.js
version. If an older checkout reports a Node version mismatch, run
`pnpm install` once so pnpm can install the pinned runtime, then retry
`pnpm dev`.

To evaluate the exact current candidate through the normal isolated path, run
`pnpm self-build`. It copies allowed committed, dirty tracked, and bounded
non-ignored untracked regular files into a detached no-checkout worktree;
rejects links and reserved private/generated paths; uses an offline frozen
copy-import install with dependency scripts disabled; verifies the prebuilt
runtime immediately around `build:release`; and digests
the temporary release outputs. Ordinary completion changes no source or main
build output; explicit diagnostic retention, unconfirmed teardown, cleanup
failure, or a process crash is an exception. The no-replace receipt is
SHA-correlated, not authenticated. Because
the candidate controls its tests/build scripts, this is not an independent
evaluator, malicious-candidate filesystem isolation, security sandbox,
autonomous promotion, installer/package gate, or cross-platform release proof.
See `docs/self-build-evidence.md`.

On a verified local Windows host, the native **Evidence** panel can admit that
same canonical self-build as an explicit **Evaluate candidate** operation. Its
automatic check is passive: it reads and fingerprints a bounded launcher and
workspace review set, but it does not execute Git, Node, pnpm, or workspace
scripts. That review is advisory rather than an exact executed-byte or security
attestation. After you confirm that candidate-controlled scripts will run with
your Windows user permissions, the host records a durable operation before
launch and publishes only path-free status and verified receipt summaries. A
lost reply, restart, timeout, or unknown outcome never replays the same
operation. Another evaluation remains blocked until the trusted Windows Job
holder has retired; candidate processes admitted to that Job are kill-on-close.
A later operation requires a new review and consent. The action remains absent
on macOS, Linux, SSH, and relay
connections because this release does not provide a non-escapable evaluation
process-tree backend there.

`pnpm dev` now holds one exclusive workspace workflow lock, verifies or repairs the
Electron payload, and accepts `out/runtime` only after its pinned pointer,
manifest, file list, and complete payload tree verify. A missing or invalid
runtime is rebuilt from the reviewed digest-pinned inputs, with progress shown
in the terminal. Development then writes a `development-integrity` attestation
under the dependency cache, where electron-vite cannot delete it, embeds those
exact bytes in hostd, and only then starts Electron. This is an unsigned local
integrity chain, not publisher authentication or a production signing claim.
The first runtime build can take several minutes and may require network access
to the pinned release assets. Concurrent `dev`, build, package, and installer
workflows fail with the command that currently owns the workspace instead of
mutating shared output underneath one another.

The desktop workbench keeps one durable thread as the primary surface. Press `Ctrl+K` (or `Cmd+K`) to search the active host projection and open controls that its negotiated capabilities allow. On an integrity-attested local host, **New resident thread** uses the native folder picker, keeps the path out of renderer state, and records a recoverable lifecycle operation before Prime Agent creation or promotion. The development host can advertise `resident_lifecycle_v1` only after the exact runtime reaches ready; resident command capability appears only after at least one current durable binding publishes an exact projection. Each thread remains independently gated: a missing, changed, or failed binding stays read-only without disabling a healthy sibling. Cross-host handoff remains unavailable. The evidence inspector is contextual and closed by default; reported runtime facts stay scoped to the active thread.

For an attached resident thread, **Show desktop HUD** opens one secure always-on-top companion window. It can collapse into a draggable status buddy or expand into the same authoritative transcript and resident Prompt/Stop composer used by the workbench; it does not create a second agent, runtime, or command authority. The HUD is pinned to the exact host, thread, and execution generation supplied when it opens. Only bounded window mode and on-screen geometry persist—never its open state, target, path, transcript, or draft. The workbench remains available, and **Return to workbench** can recreate it if it was closed. This first slice floats independently over other applications; it does not inspect, dock to, or follow the window beneath it, and ongoing workbench selection or draft mirroring is intentionally not claimed.

Open **Models & accounts** to inspect the secret-free compatibility catalog reported by the verified Prime Agent runtime on the selected host. The exact Prime Agent v0.7.0 artifact currently projects 1,169 model routes across 32 providers, including current GPT-5.6, Claude 5, Gemini 3.6, DeepSeek V4, Kimi K3, GLM-5.2, Qwen3.6, MiniMax M3, Mistral, and gpt-oss families. This list is generated from the installed runtime rather than maintained as a renderer allow-list. The runtime reports OAuth compatibility metadata for ChatGPT Plus/Pro (Codex), Claude Pro/Max, and GitHub Copilot.

Host-only development foundations now exist for generation-bound resident model selection and local ChatGPT sign-in through Prime Agent's pinned `openai-codex` provider. They are not yet exposed as renderer controls, and normal host startup does not enable the OAuth path. The pinned v0.7.0 SDK exposes a custom `AuthStorageBackend` seam, but its public CLI/daemon does not accept that seam; Continuim's currently wired OAuth helper and every daemon worker therefore use the default plaintext `<agentDir>/auth.json` backend. Continuim requires an exact development opt-in and does not describe that path as secure credential storage. A production release remains blocked on OS-backed credential custody, an upstream-supported daemon storage factory, durable OAuth restart reconciliation, and the user-facing account flow. Until the renderer integration lands, authenticate by running `/login` in Prime Agent on that host. [OpenAI's authentication documentation](https://developers.openai.com/codex/auth) distinguishes ChatGPT subscription access from separately billed API-key usage and documents OS credential storage as the secure local option.

Mobile pairing and phone control are not exposed in the desktop UI. They remain unavailable until the relay, device identity, key custody, pairing, and mobile-client release gates in `docs/implementation-status.md` are implemented and verified.

## Architecture

The Electron renderer is a projection only. Explicit, validated IPC commands reach a desktop control service, which speaks one framed host protocol over either a local socket or SSH stdio. `prime-agent-hostd` owns durable thread state, command receipts, snapshots, and execution authority. Authoritative snapshots can negotiate bounded 512 KiB begin/chunk/end delivery with an exact byte count and SHA-256; the desktop applies them only after complete schema-validated reassembly.

Future mobile sessions use the same public protocol through an outbound, end-to-end encrypted relay. Host authorization is modeled as authenticated, device-bound sessions with granular scopes; no host service is exposed directly on the local network.

See `docs/architecture.md` for the detailed boundary and protocol decisions.

## Verification

```powershell
pnpm typecheck
pnpm test
pnpm build:runtime
pnpm verify:runtime:smoke
pnpm build:release
pnpm verify:hostd-runtime:smoke
pnpm verify:hostd-resident-lifecycle:smoke
pnpm verify:renderer-visual
pnpm self-build
```

`verify:hostd-resident-lifecycle:smoke` requires the current release build and runtime seed. With an isolated empty Prime Agent home, it waits for zero-binding `resident_lifecycle_v1`, submits production `resident.provision` through HostService, the gateway, the coordinator, and the isolated Worker, then verifies the exact committed projection, command capability, restart reattachment, and provision replay suppression. It registers a credential-free deterministic Prime extension, completes the baseline and target model-selection transactions, proves three exact Prompt calls and results, exercises two urgent Stops, replays the older completed Stop while a newer Prompt continues, and verifies the resulting transcript, receipts, attempt-scoped idle proofs, provider ledger, and restart durability without mutation replay. A distinct stale-cursor End is rejected before lifecycle WAL, binding revocation, adapter use, or daemon kill. The smoke then discards the confirmed End response after its first byte, recovers the exact completed result through lifecycle status, and proves the terminal projection, ended disposition, binding retirement, zero daemon sessions, and verified supervisor/worker shutdown. It also requires exact parent-process signal/function identity across Worker passes. No user credential or provider network is used; this does not prove real provider authentication, network execution, Bash, Python, or production authorization.

`verify:renderer-visual` rebuilds the complete attested release tree before explicitly injecting the internal visual-QA fixture through real Electron across 15 desktop, resident-setup, End-review, recovery, and candidate-evaluation states, plus the expanded and buddy HUD modes. It includes 1600×1000, exact 390/320-pixel widths, and 320×256 short-height stress cases. Activation requires the harness's exact user agent, an explicit state, and its ephemeral `127.0.0.1` HTTP origin; an ordinary browser without the native bridge cannot activate the fixture. The gate fails on page or surface-level horizontal overflow, unreachable compact actions, or a non-scrollable short recovery/setup/review surface, and leaves `out/` ready for packaging instead of removing the runtime attestation. Reviewable PNGs and layout metrics are written under `out/visual-qa/`. This verifies responsive presentation; it does not substitute for a native host-session execution test.

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

`pnpm dist` applies those same build and runtime gates before creating
`release/Prime-Continuim-<version>-windows-x64-setup.exe`. The NSIS behavior is
pinned to a one-click, per-user install with the reviewed product icon, desktop
and Start menu shortcuts, and launch-after-finish. A final non-executing
verifier requires the exact configured artifact, validates its regular-file PE
envelope and nonempty overlay while the file is held open, streams
SHA-256, rejects an artifact that changes during verification, and writes the
standard sibling `.exe.sha256` file. Run
`node scripts/verify-windows-installer.mjs --config-only` to check the reviewed
installer policy without building or opening an installer. The NSIS identity
comes from the reviewed Electron Builder target; the PE shape check alone does
not identify or execute NSIS. This checksum gate
detects corruption only after trusted acquisition; it does not sign the file,
authenticate its publisher, execute setup, or prove install, repair, upgrade,
or uninstall behavior.

Leave enough local disk space for Electron's executable rewrite; synced folders
can otherwise defer the out-of-space failure until after Electron Builder exits.
Windows artifacts are deliberately unsigned development artifacts. The
reviewed `afterPack` resource editor preserves the product icon, version
metadata, and Electron's ASAR-integrity resources without invoking Electron
Builder's legacy `winCodeSign` resource pass. Production signing is not
implemented: a production channel must sign after resource editing and replace
the verifier's required `NotSigned` result with an exact publisher and
timestamp policy.

Signed distribution still requires platform signing identities, release
metadata and publication, and platform-native install, upgrade, repair, and
uninstall verification. Automatic updates remain deliberately unconfigured
until that signed lifecycle exists.

The current repository is a Phase 0/Phase 1 protocol/UI foundation with verified
development components, an inert Phase 3A pairing-authority seam, and an
isolated relay package. Neither Phase 3A seam is wired to the renderer, so this
is not a production remote release. See
`docs/implementation-status.md` for the executable boundary and explicit
deferrals.
