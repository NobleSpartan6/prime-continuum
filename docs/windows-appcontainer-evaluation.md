# Windows AppContainer evaluation probe

`prime_continuim_appcontainer_probe_v1` is a source-only contract for a future,
explicitly operator-run Windows x64 AppContainer boundary probe. This phase
contains pure admission and receipt validators. It does **not** contain a live
runner, create or delete an AppContainer profile, change an ACL, launch a child,
evaluate a Prime Continuim candidate, or add a product capability.

The contract is deliberately narrower than “the candidate is sandboxed.” A
future dedicated probe payload may test controlled sentinels in an externally
disposable VM. The installed Prime Continuim executable is digest-bound only to
correlate which installation was present; the probe must not execute it and the
result is not candidate-evaluation evidence.

## Phase A boundary

The implemented Phase A files are:

- `scripts/windows-appcontainer-probe-lib.mjs`, the pure schema, admission,
  canonicalization, and receipt verifier;
- `scripts/windows-appcontainer-probe-lib.d.mts`, its TypeScript declarations;
- `tests/scripts/windows-appcontainer-probe.test.ts`, parser/static/temp-file
  tests only;
- `scripts/verify-windows-appcontainer-probe.mjs`, a read-only verifier for one
  canonical, link-free, bounded receipt file under a stable physical identity;
- `scripts/verify-windows-appcontainer-probe.d.mts` and
  `tests/scripts/windows-appcontainer-probe-verifier.test.ts`, the verifier's
  declaration and source-only custody/CLI tests.

`pnpm verify:windows-appcontainer-probe:receipt -- --receipt <path>` performs
only that static verification. It accepts no live-probe flag, creates no files,
and prints only bounded correlation facts. Its exit `0` retains the narrow
meaning described below.

There is no package script or ordinary-workflow command for a live probe. A
PowerShell operator harness, native supervisor, dedicated probe payload,
no-replace receipt publisher, and disposable-machine evidence run are Phase B
work. Source tests cannot establish any Windows security property.

The live boundary is blocked until the repository contains a separately
reviewed reproducible native x64 payload with a pinned build/provenance path and
a static/system-only dependency closure. An arbitrary external executable,
PowerShell, Node.js, or .NET payload cannot establish reproducible probe
evidence for a zero-capability LPAC. Until that payload and the native
supervisor exist, there is deliberately no live flag.

## Admission contract

Admission is all-or-nothing and occurs before profile creation. The future host
harness must independently establish all of these facts and then pass only the
facts—not paths or account identities—to the pure validator:

1. The host is Windows x64, the session is interactive, and CI is absent.
2. The operator explicitly confirms an external disposable-VM checkpoint and
   types `DISPOSE THIS VM AFTER PRIME APPCONTAINER PROBE` exactly.
3. The operator token belongs to a dedicated standard account, is not a member
   of Administrators, is not elevated, and has Medium integrity.
4. The installed candidate and the distinct dedicated x64 probe payload are
   preexisting bounded regular files, not links or reparse points, and their
   exact expected SHA-256 and byte lengths match before any copy or launch.
5. A fresh bounded private operation root and absent receipt target are proven.
   Controlled sentinels are complete and bounded, and a sealed probe-tool copy
   is planned before profile creation.

This operator-token check is separate from the child-token requirement. The
future child must be an AppContainer with the exact newly created package SID,
Low integrity, zero capability SIDs, and Less Privileged AppContainer policy.

A denied admission can retain only the `prepared` phase. An admitted receipt
must include `admitted`; the schema cannot represent a denied attempt that later
claims profile creation or invocation.

## Intended Phase B launch contract

Phase B must use only the stable Windows APIs documented for legacy
AppContainers:

- `CreateAppContainerProfile` and `DeleteAppContainerProfile`;
- `STARTUPINFOEX` with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`;
- `PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY` with
  `PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT` for LPAC;
- `PROC_THREAD_ATTRIBUTE_JOB_LIST` so the process belongs to the bounded,
  non-breakaway, kill-on-close Job at `CreateProcess` time;
- `bInheritHandles=FALSE`, zero capabilities, and no fallback or experimental
  sandbox API.

The child must receive an explicitly constructed, alphabetically sorted,
double-NUL-terminated UTF-16 environment block with
`CREATE_UNICODE_ENVIRONMENT`. It may contain only the reviewed probe variables
needed for its sealed tool, scratch, profile, and Windows loader. Passing a null
environment pointer or copying the operator environment is forbidden. The gate
matrix separately requires the exact allowlist and denial of any
credential-shaped child environment entry.

Microsoft documents the profile lifecycle and AppContainer dual-principal
access model in [CreateAppContainerProfile](https://learn.microsoft.com/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)
and [Launch an AppContainer](https://learn.microsoft.com/windows/win32/secauthz/implementing-an-appcontainer).
The latter also documents Low integrity, zero-capability network denial, and the
additional all-packages opt-out used for LPAC. The process-creation Job-list
attribute is documented under
[UpdateProcThreadAttribute](https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

The future host must copy the exact probe payload into a separate sealed tool
tree and grant the exact AppContainer SID read/execute only. Only the operation
scratch and AppContainer profile may be read/write. There must be no writable
executable or tool closure. The host must create the child suspended, publish
the exact supervisor/process identity to a host-private no-replace record, and
resume only after token, Job-membership, and no-handle-inheritance probes pass.

## Monotonic state and evidence admission

The only legal phase sequence is this prefix-closed order:

1. `prepared`
2. `admitted`
3. `sandbox_created`
4. `invocation_committed`
5. `supervisor_published`
6. `tree_retired`
7. `gate_evidence_observed`
8. `cleanup_complete`
9. `settled`

At or after `invocation_committed`, a retry may observe, retire, and clean up the
same operation but must never relaunch it. The host must not read or trust
probe-written gate evidence until the exact Job/process tree is retired. This is
why `gate_evidence_observed` cannot appear before `tree_retired`, and why any
gate records are invalid without that phase.

A functional result requires the complete phase sequence, exact complete gate
matrix, confirmed tree retirement, profile deletion, and operation-root
deletion. Missing or ambiguous evidence, a tree-retirement timeout, malformed
supervisor data, profile deletion failure, scratch/tool cleanup failure, or
receipt publication failure is fail-closed. VM rollback or destruction remains
mandatory for both functional and failed outcomes.

## Controlled gate matrix

The fixed receipt matrix verifies intended facts without accepting arbitrary
gate names. It covers:

- exact AppContainer SID, Low integrity, zero capability SIDs, LPAC policy,
  in-Job-at-creation, no inherited handles, and an exact sanitized child
  environment with no credential-shaped entry;
- read/execute access to the sealed tool tree, read/write access to scratch and
  profile, and absence of a writable executable closure;
- read and write denial for bounded main-workspace, user-profile,
  credential-store, runtime, `out`, `release`, ProgramData, and sibling-temp
  sentinels;
- denial of a controlled inherited-handle, parent-process, and parent-named-pipe
  sentinel;
- denial of controlled loopback, LAN, and Internet connection sentinels.

These are controlled sentinels, not a claim that every file, registry key, COM
object, or other Windows/system resource is unreadable. Windows/system reads
outside the sentinels may remain. A future probe must report `unknown` or
`mismatched` rather than silently skip a gate; only the exact expected value for
every gate is a functional result.

## Receipt and verifier semantics

The receipt is canonical compact JSON plus one trailing newline, wrapped in an
exact envelope whose SHA-256 covers the canonical receipt bytes. The entire
file is capped at 64 KiB. Unknown keys, noncanonical JSON, digest mismatch,
invalid UTF-8, invalid phase ordering, incomplete functional cleanup, and
oversize input are rejected. Direct library callers are snapshotted into plain
enumerable data; accessors, hidden fields, symbols, sparse arrays, and custom
prototypes are rejected before validation or hashing.

Specific failure codes are bound to the phase and evidence where they can
occur. For example, `admission_denied` cannot accompany an admitted operation,
`gate_mismatch` requires an observed mismatching gate, and
`cleanup_unconfirmed` cannot accompany complete cleanup. The generic
`internal_failure` remains available for an otherwise unclassified failure at
an already-recorded phase.

The allowlisted receipt contains only bounded enums, booleans, counts, digests,
and an opaque 128-bit correlation value. It has no free-form or designated
secret/credential field and cannot contain paths, usernames, account names,
package/user SIDs, process/thread IDs, command lines, argv, environment, URLs,
stdout/stderr, or raw child output. The trusted host producer remains
responsible for ensuring that digest/correlation fields contain only their
declared provenance rather than credential-shaped bytes. Private supervisor
evidence is represented only by its SHA-256 and byte count.

Every valid receipt keeps these seven fields literally `false`:

- `productCapability`
- `candidateEvaluation`
- `securitySandboxClaim`
- `mainFilesystemIsolationClaim`
- `authenticated`
- `providerBackedEvaluation`
- `autonomousPromotion`

Exit codes have intentionally separate meanings:

- `0`: a static verifier accepted the bounded receipt correlation bytes;
- `1`: the live probe failed or remained uncertain;
- `2`: the live functional matrix passed, but external VM disposal is still
  required.

Exit `0` never means that a live probe ran. Exit `2` is not a product sandbox,
candidate evaluation, authentication, provider-backed evaluation, autonomous
promotion, or VM-disposal receipt.
