# Windows AppContainer evaluation probe

`prime_continuim_appcontainer_probe_v3` is a source-only contract for a future,
explicitly operator-run Windows x64 AppContainer boundary probe. This phase
contains pure admission and receipt validators. It does **not** contain a live
runner, create or delete an AppContainer profile, change an ACL, launch a child,
evaluate a Prime Continuim candidate, or add a product capability.

The contract is deliberately narrower than “the candidate is sandboxed.” A
future dedicated native supervisor and probe payload may test controlled
sentinels in an externally disposable VM. The installed Prime Continuim
executable is digest-bound only to correlate which installation was present;
the probe must not execute it and the result is not candidate-evaluation
evidence.

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
  declaration and source-only custody/CLI tests;
- `scripts/windows-appcontainer-probe-payload-protocol.mjs` and its `.d.mts`,
  the pure `PCAPM002` manifest / `PCAPE002` evidence byte-protocol builders and
  strict parsers; and
- `tests/scripts/windows-appcontainer-probe-payload.test.ts`, which freezes the
  protocol layout, child-gate contract, canonical vectors, result coherence,
  and adversarial parser rejections without launching a process; and
- `scripts/windows-appcontainer-probe-operation.mjs`, its `.d.mts`, and
  `tests/scripts/windows-appcontainer-probe-operation.test.ts`, a non-live
  reference state machine for the nine receipt phases and their immutable
  hash-chain/CAS grammar;
- `tools/windows-appcontainer-probe/native/payload/payload_contract.h`,
  `payload_codec_reference.h`, and `payload_codec_reference.c`, a C17-only,
  memory-only reference parser/emitter with no OS or probe calls;
- `tools/windows-appcontainer-probe/native/payload/codec-reference-build-manifest.json`
  and `build-codec-reference.ps1`, an explicit, unexecuted x64 static-library
  recipe declaration rather than live native-build provenance; and
- `tests/scripts/windows-appcontainer-probe-native-codec-reference.test.ts`,
  which statically freezes its wire constants, source policy, golden bytes,
  build inputs, and ordinary-workflow exclusion without compiling or executing
  the codec or recipe.

`pnpm verify:windows-appcontainer-probe:receipt -- --receipt <path>` performs
only that static verification. It accepts no live-probe flag, creates no files,
and prints only bounded correlation facts. Receipt-path custody deliberately
accepts printable ASCII spellings only, so Windows equality never relies on a
locale or incomplete Unicode approximation. Its exit `0` retains the narrow
meaning described below.

There is no package script or ordinary-workflow command for a live probe. A
PowerShell operator harness, native supervisor, dedicated probe payload, pinned
native build manifest producer, no-replace receipt publisher, and disposable-
machine evidence run are Phase B work. Source tests cannot establish any
Windows security property.

The operation module is deliberately a reference, not a Windows launch
journal. Normal Windows construction fails closed with
`WINDOWS_REFERENCE_ONLY` before it scans, cleans, publishes, or invokes
anything. Its source-visible hidden Vitest seam exists only so ordinary tests
can exercise strict schemas, prefix ordering, injected fault points, and
recovery classification; it is an ordinary-workflow exclusion, not an
adversary-proof boundary or a Windows durability test. The returned state keeps
`liveWindowsPhasePublication` and `durableNoRelaunch` literally `false`.
Windows live use remains blocked until a reviewed native publisher provides a
write-through final-name commitment plus durable supervisor-owner, lease, and
recovery fencing.

The host-private journal directory in that reference contract is separate
from, and outside, the disposable sandbox-visible operation/scratch/tool root.
Receipt `cleanup.operationRootDeleted` refers only to that disposable root;
the distinct journal must remain available so a future trusted host can append
`cleanup_complete` and then `settled`. The reference accepts caller-supplied
evidence digests and never proves their semantic truth or the external
no-replace receipt publication.

The payload protocol is only a host/child byte contract. `PCAPM002` binds the
exact payload digest and size to the exact package SID, empty child environment,
controlled paths, parent PID, concrete handle sentinel, fixed network
sentinels, ordered child-gate contract, and one create-new evidence file in
scratch. `PCAPE002` binds the child observations back to that manifest and
payload and requires a coherent complete-match, complete-nonmatch, or
incomplete result with an internal digest. The evidence transport is the sealed
tool manifest plus that create-new scratch file; a parent-created named-pipe
server is deliberately not part of the child launch closure. Both parsers
reject extensions, noncanonical layouts, padding drift, zero identities or
digests, pseudo handles, and cross-fed bindings. Their returned summaries
contain no path, SID, PID, handle, or transport material. The C17 codec
reference can parse that manifest in caller-owned memory and emit only the
canonical all-`not_attempted`, `incomplete_internal` evidence buffer. It opens
nothing, observes no gate, and does not implement the executing payload or its
create-new evidence-file transport.

Neither pre-live JSON schema v1 nor v2 had a live producer or an accepted
disposable-machine receipt. V3 replaces v2 and rejects its receipt and envelope
kinds. It binds the exact digest and byte length of the installed-candidate
correlation, dedicated native supervisor, dedicated probe payload, and pinned
native build manifest. The three native-tool records also bind `machine: x64`,
all four digests must be distinct, and the installed candidate remains
correlation-only. V3 also accepts only the `PCAPM002` / `PCAPE002` sealed-tool-
manifest plus scratch-create-new-file transport; the pre-live `PCAPM001` /
`PCAPE001` pipe design is insufficient. None of these fields imply that a child
executed or that every kernel handle was enumerated.

The live boundary is blocked until the repository contains a separately
reviewed reproducible native x64 supervisor and executing payload, the exact
pinned live native-build manifest, a reproducible provenance path, and a
static/system-only dependency closure. The source-only byte protocol, JSON
contract, and uncompiled codec-reference recipe are not that implementation or
provenance. An arbitrary external
executable, PowerShell, Node.js, or .NET payload cannot establish reproducible
probe evidence for a zero-capability LPAC. Until those native tools exist and a
separate live harness review is complete, there is deliberately no live flag.

## Admission contract

Admission is all-or-nothing and occurs before profile creation. The future host
harness must independently establish all of these facts and then pass only the
facts—not paths or account identities—to the pure validator:

1. The host is Windows x64, the session is interactive, and CI is absent.
2. The operator explicitly confirms an external disposable-VM checkpoint and
   types `DISPOSE THIS VM AFTER PRIME APPCONTAINER PROBE` exactly.
3. The operator token belongs to a dedicated standard account, is not a member
   of Administrators, is not elevated, and has Medium integrity.
4. The installed candidate, dedicated x64 native supervisor, distinct x64 probe
   payload, and pinned x64 native build manifest are four preexisting bounded
   regular files, not links or reparse points. Their exact expected SHA-256 and
   byte lengths must match before any copy or launch, and no digest may be
   cross-fed between roles. Each native binary is capped at 64 MiB and the build
   manifest at 64 KiB; the candidate is correlation-only and must not execute.
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

The child must receive the exact empty, double-NUL-terminated UTF-16 environment
block frozen by `PCAPM002`, with `CREATE_UNICODE_ENVIRONMENT`. Passing a null
environment pointer, copying the operator environment, or adding even a
reviewed-looking variable is forbidden. The future native payload must obtain
its bounded inputs from the manifest rather than ambient environment state. The
gate matrix separately requires the exact empty allowlist and denial of any
credential-shaped child environment entry.

Microsoft documents the profile lifecycle and AppContainer dual-principal
access model in [CreateAppContainerProfile](https://learn.microsoft.com/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)
and [Launch an AppContainer](https://learn.microsoft.com/windows/win32/secauthz/implementing-an-appcontainer).
The latter also documents Low integrity, zero-capability network denial, and the
additional all-packages opt-out used for LPAC. The process-creation Job-list
attribute is documented under
[UpdateProcThreadAttribute](https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

The future host must bind and copy the exact native supervisor, probe payload,
and native build manifest into a separate sealed tool tree and grant the exact
AppContainer SID only the access required by the reviewed launch design. Only
the operation scratch and AppContainer profile may be read/write. There must be
no writable executable or tool closure. The host must create the child
suspended, publish the exact supervisor/process identity to a host-private
no-replace record, and resume only after token and Job-membership probes pass
and the fixed launch plan proves handle inheritance was disabled. A separate
controlled inherited-handle sentinel remains child-observed; neither fact
claims an exhaustive scan of every possible kernel handle.

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

At or after `invocation_committed`, the future native coordinator may observe,
retire, and clean up the same operation but must never relaunch it. The
source-reference journal does not yet prove that property on Windows. The host
must not read or trust
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
  in-Job-at-creation, disabled launch-handle inheritance, and an exact empty
  child environment with no credential-shaped entry;
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
evidence is represented only by its SHA-256 and byte count. The installed
candidate record is exactly `installed_candidate_correlation` plus its digest
and size, with no executable role or machine extension. The native supervisor,
payload, and build-manifest records are exact role/digest/size/`machine: x64`
tuples. The payload role means only that those bytes were the dedicated launch
target. These records do not claim that a supervisor or child started or
executed; only exact post-retirement evidence can establish that narrower fact.

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
