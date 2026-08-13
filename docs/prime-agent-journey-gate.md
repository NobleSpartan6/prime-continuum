# Prime Agent packaged journey gate

`verify:prime-agent-tool-dogfood` is the explicit public-readiness correlation lane for the complete packaged macOS Prime Agent v0.7.2 journey. It is deliberately excluded from `pnpm test`, normal workflows, release builds, and `self-build`. Its credential-free source-contract tests run normally; provider execution never does.

The operator—not the harness—uses the visible product controls to choose the workspace, complete any ChatGPT OAuth flow, select exact `openai-codex/gpt-5.6-sol`, submit the immutable task, End the resident, and quit the app at the two requested boundaries. The harness never reads credential files, starts OAuth, submits a resident command, or controls the system login browser.

## Run

Build the current development package first. Then create a fresh private disposable root whose only children are an empty host-data directory and a clean detached worktree:

```bash
corepack pnpm package
case "$(uname -m)" in
  arm64) DOGFOOD_APP_DIR=mac-arm64 ;;
  x86_64) DOGFOOD_APP_DIR=mac ;;
  *) echo "Unsupported macOS architecture" >&2; exit 1 ;;
esac
DOGFOOD_ROOT="$(mktemp -d /private/tmp/prime-continuim-tool-dogfood-XXXXXX)"
git worktree add --detach "$DOGFOOD_ROOT/workspace" HEAD
mkdir -m 700 "$DOGFOOD_ROOT/host-data"
export PRIME_CONTINUIM_TOOL_DOGFOOD_ROOT="$DOGFOOD_ROOT"
export PRIME_CONTINUIM_TOOL_DOGFOOD_WORKSPACE="$DOGFOOD_ROOT/workspace"
export PRIME_AGENT_DATA_DIR="$DOGFOOD_ROOT/host-data"
export PRIME_CONTINUIM_TOOL_DOGFOOD_CANDIDATE_APP="$PWD/release/$DOGFOOD_APP_DIR/Prime Continuim.app"
export PRIME_CONTINUIM_TOOL_DOGFOOD_DISPOSABLE_CHECKPOINT=DISPOSABLE_SOL_RLM_BROWSER_DOGFOOD_READY
corepack pnpm verify:prime-agent-tool-dogfood \
  --i-understand-this-uses-live-sol-rlm-and-browser-tools \
  --disposable-workspace-checkpoint
```

The native package directory is `release/mac-arm64` on Apple silicon and `release/mac` on Intel. The gate rejects a candidate whose embedded platform, architecture, or Prime Agent v0.7.2 identity does not match the running host. Do not reuse a prior root. Ambient provider- or credential-shaped environment variables are rejected before provider use.

## Exact proof sequence

1. Verify the complete packaged app, external host, standalone Node, browser Electron, runtime tree, and embedded attestation before authorization.
2. Prove the selected resident is idle, OAuth-backed Sol is exact, and verified browser execution is ready.
3. Before accepting completion, observe one authoritative snapshot with an observable in-flight root turn, exactly one active native child named `browser-auditor`, one active exact goal, and the exact Sol model on the unchanged resident authority. The gate fails if the child or goal completes before this observation; it never submits or replays a mutation to manufacture activity.
4. Observe that same child and goal complete, require the child's explicit `agent_message`, exact root/child model identity, final marker, and deterministic browser proof.
5. Prove the named browser session and its private lifecycle state are retired.
6. Ask the operator to quit the app. Stop the owned host cleanly, restart the same packaged host and desktop, and collect three interval-separated production snapshots.
7. Require the complete durable projection and cursor to remain unchanged, the same resident authority to reattach, host journal IDs to remain unchanged, the desktop outbox to remain empty, and resident dispatch-attempt storage to remain empty.
8. Ask the operator to End through the reopened app. Require the terminal projection, completed End lifecycle, zero daemon sessions, clean desktop/host exits, and exact resident-daemon retirement.

The no-replay result means no durable Continuim mutation or provider dispatch replay was observed. It does not count every attempted desktop `command.submit` that host storage may deduplicate before mutation, and it is not a provider-RPC-count claim.

## Evidence and cleanup

A functional outcome writes a no-replace, bounded, path-free `receipt.json` and intentionally exits with code `2`. Every outcome retains the disposable root; external review and disposal remain required. A failure after authority may have been used publishes only bounded stage/code and cleanup facts when safe, never paths, prompts, transcript text, browser payloads, or credentials.

Do not delete the retained root if desktop, host, resident daemon, browser state, or loopback retirement is uncertain. Resolve exact owned processes first. This is development correlation evidence, not signing, notarization, sandbox, hostile-same-user custody, or release-readiness evidence.
