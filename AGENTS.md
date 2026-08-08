# Prime Continuim agent instructions

## Canonical self-build

When asked to verify or build the current Prime Continuim candidate, run this
single command from the repository root:

```text
pnpm self-build
```

Do not replace it with ad hoc commands when making a build-readiness claim. The
command captures the exact committed `HEAD` plus allowed tracked and bounded
untracked regular-file bytes, rejects links and reserved private/generated
paths, then copies that manifest into a detached no-checkout Git worktree. It
uses a sanitized environment and a copy-imported, evaluation-local dependency
tree before running typechecking, the full test suite, exact runtime
verification immediately around `build:release`, and artifact digesting. Under
ordinary operation it leaves the source worktree and its build outputs alone;
its persistent output is a no-replace ignored evidence receipt under
`.prime-continuim-self-build/receipts/`. An explicitly retained diagnostic,
unconfirmed process-tree teardown, cleanup failure, or process crash is an
exception; consult the receipt's cleanup state before touching that path.

If the local pnpm store is incomplete, run the user-authorized root
`pnpm install` first. If `out/runtime` is absent or invalid, run
`pnpm build:runtime` first; that step may need the network. Never copy ignored
credentials, caches, or arbitrary private files into the evaluation worktree.

Verify a receipt before citing it:

```text
pnpm verify:self-build-receipt -- .prime-continuim-self-build/receipts/<receipt>.json
```

The receipt SHA-256 detects later receipt corruption and correlates evidence; it
does not authenticate an author or machine. The candidate controls the package
scripts, tests, and build policy, so a pass is not an independent evaluator or
security verdict. It also does not provide malicious-candidate isolation from
the main filesystem, a security sandbox, recursive/provider-backed evaluation,
autonomous promotion, package/installer verification, signing, or macOS/Linux
release proof. Run the separate reviewed workflow for those narrower claims.

Use `pnpm self-build --retain-failed-worktree` only for local diagnosis. It may
retain the failed evaluation at the path-private relative location recorded in
the receipt. Never commit `.prime-continuim-self-build/`.
