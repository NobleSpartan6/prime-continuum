# Prime Continuim

[![Cross-platform source gates](https://github.com/NobleSpartan6/prime-continuum/actions/workflows/cross-platform-source.yml/badge.svg)](https://github.com/NobleSpartan6/prime-continuum/actions/workflows/cross-platform-source.yml)

A native desktop workbench for durable [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) coding sessions.

Use the upstream [Prime Agent coding-agent documentation](https://github.com/PrimeIntellect-ai/prime-agent/tree/main/packages/coding-agent/docs) for current development concepts and workflows. Prime Continuim's shipped compatibility remains defined by this repository's pinned, attested Prime Agent artifact rather than by the moving upstream `main` branch.

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

The repository also contains a source-only Windows AppContainer probe contract
and a read-only receipt verifier. Run
`pnpm verify:windows-appcontainer-probe:receipt -- --receipt <path>` only to
check one canonical, bounded, link-free correlation receipt. It does not create
an AppContainer profile, change an ACL, launch a payload, evaluate the current
candidate, or prove sandboxing. A live launcher and reviewed reproducible native
x64 probe payload remain absent; see `docs/windows-appcontainer-evaluation.md`.

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

Desktop spinup is deliberately cache-first. Electron starts loading the main
workbench without waiting for HUD-preference I/O; independent control ledgers
load in parallel; and the projection cache reads the exact last selected host
before hydrating inactive hosts in the background. Runtime lifecycle and OAuth
capabilities warm asynchronously, with a short bounded readiness poll before
the normal steady-state interval. These changes shorten the critical path while
preserving exact host/thread/generation fences and fail-closed background
hydration. No latency percentile is claimed until installed-candidate startup
benchmarks are added.

The desktop workbench keeps one durable thread as the primary surface. Press `Ctrl+K` (or `Cmd+K`) to search the active host projection and open controls that its negotiated capabilities allow. On an integrity-attested local host, **New resident thread** uses the native folder picker, keeps the path out of renderer state, and records a recoverable lifecycle operation before Prime Agent creation or promotion. On an already verified SSH host, the same action can create a new resident thread only in the exact saved workspace of the selected thread. That `resident_registered_workspace_lifecycle_v1` path sends project/workspace/thread/generation identifiers—not a folder path—and revalidates a fresh host catalog and thread snapshot before admission. It does not browse an arbitrary remote folder, install hostd, move a thread between hosts, or create mobile authority. The local host advertises `resident_lifecycle_v1` and an SSH bridge advertises the narrower registered-workspace capability only after the exact runtime reaches ready; resident command capability appears only after at least one current durable binding publishes an exact projection. Each thread remains independently gated: a missing, changed, or failed binding stays read-only without disabling a healthy sibling. Cross-host handoff remains unavailable. The evidence inspector is contextual and closed by default; reported runtime facts stay scoped to the active thread.

The composer is framed as a task brief: describe the outcome, constraints, and done criteria, then choose **Delegate task**. Unsaved text is kept only in memory and isolated by exact host, resident thread, and execution generation; switching threads restores the matching draft, successful admission clears only that draft, and a bounded 128-entry LRU prevents unbounded retention. A continuity strip distinguishes **Ready**, **Working**, **Needs you**, and **Reconnecting**. It says work continues after the window closes only when the authoritative runtime reports a resident session; client-owned and unverified sessions use narrower copy.

For an attached resident thread, **Show desktop HUD** opens one secure always-on-top companion window. It can collapse into a draggable status buddy or expand into the same authoritative transcript and resident Prompt/Stop composer used by the workbench; it does not create a second agent, runtime, or command authority. The HUD is pinned to the exact host, thread, and execution generation supplied when it opens. Only bounded window mode and on-screen geometry persist—never its open state, target, path, transcript, or draft. The workbench remains available, and **Return to workbench** can recreate it if it was closed. This first slice floats independently over other applications; it does not inspect, dock to, or follow the window beneath it, and ongoing workbench selection or draft mirroring is intentionally not claimed.

Open **Models & accounts** to inspect the secret-free compatibility catalog reported by the verified Prime Agent runtime on the selected host. The exact Prime Agent v0.7.1 artifact currently projects 1,173 model routes across 32 providers; its `openai-codex` provider still reports 13 routes. This list comes from the installed runtime rather than a renderer allow-list. While the selected resident thread is authoritatively idle, an available non-current row can select the model for its next prompt. The command is bound to that host, thread, and execution generation, is never replayed after an ambiguous outcome, and becomes **Current** only from a refreshed authoritative projection. “Available” means Prime Agent reports configured access; it is not a provider inference test.

ChatGPT Plus/Pro is configured through Prime Agent itself. **Models & accounts** is available on the verified local host before the first resident thread exists. Select **ChatGPT Plus/Pro (Codex Subscription)** and choose **Connect ChatGPT**; the main process opens Prime Agent's verified `openai-codex` OAuth page in the system browser. A completed login updates the same host-scoped Prime Agent auth store used by resident sessions, and the next availability check reloads it without creating or restarting a second backend. Authorization URLs, tokens, account identifiers, and raw provider errors never enter renderer state. SSH and relay sessions do not expose browser OAuth; use Prime Agent's own `/login` on those hosts when appropriate. See Prime Agent's [provider and OAuth documentation](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/providers.md).

The local browser flow is admitted as one digest-bound durable attempt. Desktop and hostd persist the same identity before the one provider-login effect; a lost response, disconnect, or restart reconciles through read-only attempt status and never replays login or reopens the browser. `runtime_oauth_attempt_v1` identifies the durable status/cancel/acknowledgement family, while `runtime_oauth_v1` is the dynamic signal that a new durable start is currently eligible; a new desktop start requires both. An unresolved helper, full or unreadable journal, provider withdrawal, or uncertain commit removes start eligibility while preserving read-only reconciliation whenever the journal remains healthy. The former `oauth.session.*` effect path is fixed-rejected when the durable store is installed. These are source-tested durability guarantees, not evidence that authenticated browser OAuth or a real provider turn has been run.

Prime Agent v0.7.1 stores this OAuth credential in a host-only `auth.json` under Continuim's private Prime Agent directory. One shared proof gates OAuth, catalog discovery, and resident execution. On Windows, the directory is an atomically created protected per-host leaf directly under a verified ProgramData boundary, with exact current-user/SYSTEM/Administrators access and owner checks; network/device/ADS roots are rejected. POSIX requires a current-owner, non-group/other-writable parent and an exact `0700` agent root. The file is plaintext at rest and is not described as keychain-, keyring-, or vault-backed; software running as the same OS user or an administrator remains in the trust boundary.

This stricter directory is not populated from the former LocalAppData `hostd/prime-agent` path: that weak-parent tree is neither read, repaired, copied, nor deleted. An upgrade requires reconnecting OAuth and provisioning new resident sessions once. This is an explicit security migration and does not preserve legacy resident continuity automatically.

The separate Codex app-server execution backend, tab, capability, packaged companion, and provider-E2E command have been retired. Prime Agent is the sole agent runtime. Removing the companion reduced the verified runtime image from 482,097,771 to 162,618,142 bytes (304.68 MiB, 66.27%) and from 20,772 to 20,764 files. That is a measured payload reduction, not a startup-time benchmark.

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

An additional source-only, opt-in Windows harness is available for an operator-authorized installed-candidate Prime Agent provider check. Its live provider command and execution are deliberately excluded from `pnpm test`, `pnpm dist`, `pnpm self-build`, and normal workflow dispatch; credential-free source-contract tests remain in `pnpm test`, with the bounded UI Automation compile exercised only on local Windows outside GitHub Actions. The operator must first create a dedicated non-administrator `PrimeAgentE2E` account inside a disposable Windows x64 VM/checkpoint, use the exact `en-US` UI culture, install the supported Windows Git Bash prerequisite, build and install the exact clean `pnpm dist` candidate outside the repository, ensure the harness-derived ProgramData custody leaf is absent, and arrange unconditional external VM rollback or destruction. Ambient credential-shaped environment variables are rejected; OAuth must begin from an unconfigured Prime Agent `openai-codex` provider.

```powershell
$env:PRIME_CONTINUIM_PROVIDER_E2E_INSTALLED_EXE = 'C:\Users\PrimeAgentE2E\AppData\Local\Programs\Prime Continuim\Prime Continuim.exe'
$env:PRIME_CONTINUIM_PROVIDER_E2E_MODEL_ID = '<exact available openai-codex model id>'
$env:PRIME_CONTINUIM_PROVIDER_E2E_DISPOSABLE_CHECKPOINT = 'DISPOSABLE_WINDOWS_CHECKPOINT_READY'
pnpm verify:prime-agent-provider:e2e -- --i-understand-this-uses-live-prime-agent-oauth-and-provider --disposable-windows-checkpoint
```

The harness re-verifies the installed executable, ASAR, hostd, complete runtime seed, installer, and checksum sidecar against the current `release/win-unpacked` candidate, then re-digests both complete runtime trees after execution so added directories or files also fail the candidate fence. This binds those enumerated artifacts, not every DLL or native file in the installed root. It starts the installed hostd under a harness-owned graceful-shutdown wrapper, provisions one resident only as production-host-protocol fixture setup, and then performs every product mutation through visible renderer controls: **Connect ChatGPT**, exact model selection, long no-tools Prompt, streaming **Stop**, and **End resident session**. System-browser login is manual. After an exact idle Stop it orderly-closes the exact desktop window, cleanly stops and restarts hostd, starts a new desktop process, and makes one separate `command.reconcile` request for each exact durable Prompt and abort envelope without directly submitting either command from the harness. Three interval-separated stable full-semantic projections except `generatedAt`, unchanged command-journal IDs, an empty desktop outbox, and no resident dispatch attempts prove that no durable Continuim or provider-dispatch replay was observed. They do not observe whether restarted Desktop attempted a duplicate `command.submit` that Store deduplicated before durable mutation. End must publish the terminal projection, leave exactly one completed retired binding lineage, and leave zero daemon sessions before proof-gated custody and temporary-root cleanup.

This operation consumes live provider network/quota and runs a real Prime Agent session whose tool authority is not a workspace-only security sandbox, even though the harness prompt forbids tools. Prime Agent OAuth material is plaintext at rest. The harness never emits credentials, login locators, prompt/transcript content, raw child output, or raw CDP payloads, and it does not inspect or clean the system-browser session. Its fixed production snapshot call may persist Desktop’s projection cache but does not submit provider commands. An uncertain close, hostd/daemon shutdown, End, custody proof, or cleanup is latched non-retryable, retains state, and makes VM destruction the only cleanup authority. A functional result intentionally exits with code `2` and the outcome `functional_passed_vm_disposal_required`; code `2` is not a normal workflow success. The receipt is not installer-lifecycle, signing, native picker/provision UI, provider-RPC-count, Desktop-command-submit-attempt-count, browser-session-cleanup, tool/sandbox, release-readiness, sender-trust, ordinary-user-authority, or VM-disposal-completion evidence. The harness has not yet been run or cited, so authenticated provider execution remains an unsatisfied release gate.

`verify:renderer-visual` rebuilds the complete attested release tree before explicitly injecting the internal visual-QA fixture through 23 exact Electron capture targets. They cover desktop, local and SSH saved-workspace resident setup, End review, recovery, candidate evaluation, expanded and buddy HUD modes, resident model selection, and Prime Agent ChatGPT OAuth setup at 390×844 and 320×256. The account captures select the real Prime Agent provider row, verify the `auth.json` disclosure and enabled **Connect ChatGPT** action, and never invoke sign-in. The model-selection captures likewise open through the real visible composer control without invoking a model change. The SSH captures open the mobile sidebar and exact path-free setup dialog without submitting it. The set includes 1600×1000, 1200×800, 620×380, 390×844, 320×704, 320×256, and 184×64 targets. Activation requires the harness's exact user agent, an explicit state, and its ephemeral `127.0.0.1` HTTP origin; an ordinary browser without the native bridge cannot activate the fixture. The gate fails on horizontal overflow, unreachable compact actions, or a non-scrollable short recovery/setup/review surface. Reviewable PNGs and layout metrics are written under `out/visual-qa/`. This verifies responsive presentation, not authenticated provider execution.

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
