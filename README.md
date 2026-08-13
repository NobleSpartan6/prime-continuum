# Prime Continuim

[![Cross-platform source gates](https://github.com/NobleSpartan6/prime-continuum/actions/workflows/cross-platform-source.yml/badge.svg)](https://github.com/NobleSpartan6/prime-continuum/actions/workflows/cross-platform-source.yml)

A local-first desktop workbench for durable [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) coding sessions.

Prime Continuim gives Prime Agent a focused desktop surface: choose a workspace, connect a model, delegate a task, follow native RLM children, and end the resident session without losing the transcript or workspace state.

> **Development preview.** Prime Continuim is an independent community project, not an official Prime Intellect product. It runs model-generated code with your operating-system permissions and is not a security sandbox.

## What works today

- Real provider-backed Prime Agent turns through the pinned Prime Agent v0.7.2 runtime.
- ChatGPT Plus/Pro sign-in for the `openai-codex` provider, including GPT-5.6 Sol when the account reports it as available.
- Model discovery and switching across providers configured in Prime Agent. The pinned runtime currently reports 1,177 routes across 32 providers; availability depends on your credentials and account.
- Native RLM child visibility with parent/child status, model, tool-use, token, and result projections.
- An Outcome Review that correlates the exact settled turn, written response,
  checks, Git aggregate, RLM returns, and live-versus-cached snapshot authority
  without treating idle as semantic success.
- A verified, isolated browser-tool path for resident agents.
- Durable local sessions with Stop, End, restart recovery, and saved-workspace reconnection.
- A compact desktop HUD backed by the same authoritative session as the main workbench.

A local macOS development dogfood run completed a real GPT-5.6 Sol task, created a native RLM child, received its result, and returned the session to Ready. That is development evidence, not a signed-release or sandbox claim; see [implementation status](docs/implementation-status.md).

## Run from source

Requirements: Git, Node.js 24, and Corepack. A global pnpm installation is not required.

```bash
git clone https://github.com/NobleSpartan6/prime-continuum.git
cd prime-continuum
corepack pnpm install
corepack pnpm dev
```

The first run may download and verify the repository's pinned Node and Prime Agent runtime assets. Later runs reuse verified local material. If `pnpm dev` reports that another workflow owns the repository, close the other dev/build/package process and retry.

### Run your first agent

1. Select **New agent** and choose a workspace folder.
2. Open **Models & accounts**.
3. Connect ChatGPT, or configure another provider through Prime Agent.
4. Select an available model, write the task, and choose **Delegate task**.
5. Open **Session** to follow RLM branches, browser readiness, and runtime state.

Closing the window detaches the UI; it does not end a resident session. Use **End session** when you want Prime Agent to stop while preserving the task, transcript, and workspace files.

## Development

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

For the repository's canonical, isolated build-readiness check:

```bash
corepack pnpm self-build
```

`self-build` evaluates the exact committed and allowed dirty source bytes in a detached worktree and writes a correlated receipt under the ignored `.prime-continuim-self-build/` directory. It is not an independent security evaluation. Read the full [evidence boundary](docs/self-build-evidence.md) before citing a receipt.

### macOS development package

```bash
corepack pnpm package
open "release/mac-arm64/Prime Continuim.app"
```

Intel macOS uses `release/mac/Prime Continuim.app`. To create the development DMG, run `corepack pnpm dist`. The current app is ad-hoc signed; the DMG is unsigned and not notarized. See [macOS development packaging](docs/macos-development-package.md).

The explicit packaged Prime Agent journey gate is `corepack pnpm verify:prime-agent-tool-dogfood`. It is interactive, opt-in, excluded from normal tests and workflows, and consumes real provider quota only after an exact typed authorization. It proves exact Sol selection, an observable in-flight root turn and active native RLM child before that same child returns its `agent_message`, verified browser work, idle completion, host/desktop restart with stable no-replay observations, visible End, and owned process/browser retirement. See the [operator runbook](docs/prime-agent-journey-gate.md); the lane has not been run or cited for this candidate.

### Windows development package

Run `corepack pnpm dist` on Windows x64 to create the configured per-user NSIS installer and checksum sidecar under `release/`. The artifact is intentionally unsigned and intended only for controlled development testing.

## Architecture

```text
Electron renderer
      │ validated IPC
Desktop control service
      │ framed local socket or SSH stdio
prime-agent-hostd
      │ durable authority and projections
Pinned Prime Agent runtime
```

The renderer is a projection, not the execution authority. The host service owns resident lifecycle, command receipts, exact execution generations, runtime credentials, and recovery state. Prime Agent is the sole coding-agent runtime.

Start with:

- [Architecture](docs/architecture.md)
- [Implementation status](docs/implementation-status.md)
- [Interface review](docs/interface-review.md)
- [Prime Agent upstream review](docs/prime-agent-upstream-review.md)
- [Stack and performance budgets](docs/stack-decision.md)
- [Relay threat model](docs/relay-threat-model.md)

## Release boundary

This repository remains a Phase 0/Phase 1 protocol/UI foundation suitable for controlled development testing. Production resident commands are not release-authorized even though real provider execution now works in the local development path.

Remote SSH installation and upgrades, cross-host handoff, relay connectivity, mobile control, automatic updates, and signed distribution remain unavailable. Existing verified SSH connections have a narrower saved-workspace lifecycle path; the app does not install or upgrade a remote host.

Packaging has been verified as a Windows x64 development artifact and an ad-hoc macOS arm64 development app/DMG. Linux packaging is unverified, and a notarized macOS DMG is unverified. No stable binary release is published yet.

## Security

- Treat every agent-selected command as code you authorized to run on the selected host.
- Use an external sandbox for untrusted repositories or tasks.
- Prime Agent v0.7.2 stores OAuth material as plaintext in a private host-only directory; it is not keychain-backed.
- Never paste credentials into an issue, transcript, diagnostic, or build receipt.

Report vulnerabilities through the process in [SECURITY.md](SECURITY.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Prime Continuim is available under the [MIT License](LICENSE). Bundled development skills retain their upstream licenses and attribution; see [third-party notices](THIRD_PARTY_NOTICES.md).
