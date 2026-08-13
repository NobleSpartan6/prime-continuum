# Self-build evidence boundary

`pnpm self-build` is the minimum local candidate-evaluation vertical for Prime
Continuim. It serializes with `dev`, build, package, and distribution work by
using the same physical-worktree lock and supervised process-tree lease.

The runner records one fixed candidate identity before execution:

- exact Git `HEAD` commit;
- SHA-256 and byte length of porcelain-v2 status and the binary full-index
  `HEAD` patch;
- a bounded manifest digest for allowed non-ignored untracked regular files;
- a bounded full candidate-tree digest over path, executable bit, size, and
  content SHA-256.

Only regular files returned by `git ls-files --cached` and
`git ls-files --others --exclude-standard` can enter the candidate. Links,
junction/reparse ancestors, and special files fail closed. A code-owned policy,
independent of the candidate's mutable `.gitignore`, excludes workflow locks,
self-build state/receipts, dependency and build roots, logs, `.env*`, `*.env`,
`.npmrc`, and pnpm hook files. A tracked file at one of those reserved paths is
rejected. Other ignored files are not copied; this rule is intentionally
narrower than claiming every possible credential filename is known. Capture is
repeated after materialization, after every settled gate, and before receipt
publication; a concurrent source edit aborts the evaluation.

The exact candidate is copied from its complete hash-bound manifest into a
detached `--no-checkout` temporary Git worktree, so checkout hooks and filters
do not materialize its bytes. Per-step evaluation fences compare the exact HEAD
and complete path/content tree identity rather than Git patch encoding, because
the same copied bytes are intentionally untracked in that no-checkout worktree;
the main source fence still requires the original exact status, binary patch,
untracked manifest, and tree identity. The runner does not link or junction the source
`node_modules`. It strips executable/package-manager injection variables and
records a nonsecret digest of the allowlisted environment policy. Installation
is forced offline and frozen, with dependency scripts disabled, store integrity
enabled, an evaluation-local modules/virtual-store path, and copy import from
the digest-bound local pnpm store. Pnpm's synthetic pinned-Node package is the
one dependency it exposes as a store link; the runner requires that link to
remain inside the bound store, verifies its package identity and Node executable
digest against the already-bound Node toolchain, then copies and rehashes the
whole small package locally before rejecting every remaining external link. It
then runs, in order:

1. the offline, frozen dependency installation described above;
2. `pnpm typecheck`;
3. `pnpm test`;
4. exact prebuilt Prime Agent runtime verification immediately before build;
5. `pnpm build:release`, with the verified runtime seed and Electron executable
   supplied as explicit digest-bound inputs.
6. exact prebuilt runtime reverification immediately after build.

Node, pnpm, the pnpm store location and physical directory identity, the exact
Git executable, Electron's full distribution tree, and the complete
runtime-seed tree are bound before gates. The store's mutable package index is
allowed to update as pnpm imports packages; package bytes remain constrained by
the frozen lockfile, pnpm store-integrity verification, and copy import into the
evaluation. Exact file metadata and physical directory identities are checked
after every settled step, while executable, Electron, and runtime content
identities are repeated on both success and failure before a receipt is
written. When supervised teardown is unconfirmed, the final fence is recorded
as inconclusive instead of being presented as an unchanged-input result.
Evaluation dependency links must resolve inside the temporary
worktree. This is a normal build-isolation measure, not a hostile-filesystem
security boundary.

Each step has a finite deadline and runs under the existing durable child-tree
supervisor. A failure or timeout stops later gates. Confirmed termination
settles the whole supervised tree before its lease is released; an unconfirmed
teardown keeps the durable lease, records collateral state as unknown, does not
initiate worktree cleanup, and records the observed worktree disposition.
Default cleanup removes the evaluation worktree on either outcome only after
process-tree settlement.
Receipts distinguish `removed`, `retained`, `not-created`, and `unknown`
cleanup states; cleanup failure never reports a remaining tree as removed. A
process crash may still require the existing stale-worktree recovery path.
`--retain-failed-worktree` is an explicit diagnostic exception and records only
its repository-relative ignored location when that worktree exists.

The bounded JSON receipt records the candidate and tool identities, ordered
command token arrays and outcomes, and per-root plus aggregate release-artifact
digests. It is published once with no-replace filesystem semantics. Receipt
storage is capped at 256 entries and never auto-deletes evidence. The outer
SHA-256 covers canonical receipt bytes, so `pnpm verify:self-build-receipt`
detects modification. That digest is integrity and correlation evidence only;
it is not a signature or machine identity.

The candidate itself defines the package scripts and test/build policy being
run. A pass is candidate-controlled build-readiness correlation, not an
independent evaluator or security verdict. This vertical deliberately does not
isolate the main filesystem from a malicious candidate, run generated code in
a security sandbox, ask a model to review or improve the candidate,
authenticate a provider, promote or commit a result, package an installer,
sign an artifact, or prove a non-Windows release. Those are separate
implementation and release gates.

The separate [native launch-proof capture](native-launch-proof.md) can bind a
packaged app's main, preload, renderer, and runtime bytes back to one passing
self-build receipt while recording visible evidence from an operator-completed
real RLM run. It remains correlation evidence and does not widen this gate's
assurance boundary.

## Native evaluation coordinator

The Windows desktop can start this same runner from the **Evidence** panel for
one exact local host, thread, and execution generation. The renderer never
sends a filesystem path, executable, argument vector, or environment value.
Before showing the action, hostd performs a bounded passive review of Git
administrative bytes, the canonical launcher bootstrap, required manifests,
and the resolved Node and pnpm launcher bytes. It uses direct file reads and
hashes only. It does not run Git, Node, pnpm, hooks, filters, or candidate code.

The passive fingerprint is an advisory consent aid. It is not the canonical
candidate identity, an executed-byte attestation, or a security boundary. The
complete candidate and toolchain identities are captured by the consented
self-build itself and become public only with its verified no-replace receipt.
The confirmation therefore says that candidate scripts run with the current
Windows user's permissions and can access the same files as that user.

Before launch, the host persists an immutable operation ID, request time,
passive review, private workspace authority, and coordinator-chosen self-build
run ID. The runner writes that run ID into its main workflow lock, so recovery
can distinguish the operation from an unrelated manual self-build. A lost
start response is reconciled by the same operation ID and is never retried with
a new invocation. Receipt publication and process retirement are independent:
a valid receipt may settle the public outcome, but no new evaluation is
admitted until the trusted Windows Job holder has retired; candidate processes
admitted to that Job are kill-on-close. A timeout, invalid receipt, crash, or
unknown outcome cannot weaken that barrier. Once retirement is proven, a
separate operation still requires a fresh passive review and explicit consent;
the interface warns that an earlier unknown operation may have had external
effects.

This coordinator is intentionally unavailable on macOS, Linux, SSH, and relay
sessions. Process groups are not a non-escapable containment boundary for
candidate-controlled code, and this slice does not substitute them for the
Windows Job Object proof. The coordinator does not install, commit, promote,
or automatically modify the evaluated source.
