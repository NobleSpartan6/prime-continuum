# 004 — Index native snapshot lookups

- **Status**: DONE
- **Baseline**: f2f6ba8
- **Severity**: MEDIUM
- **Category**: Performance
- **Rule**: react-doctor/js-index-maps
- **Estimated scope**: 2 files, about 90 lines including tests

## Problem

Native projection normalization repeatedly scans `threads` and `hosts` inside
receipt and outbox loops. This runs for every authoritative publication and
scales as records multiply during long-lived RLM sessions.

    // src/renderer/src/api.ts:2117 — current
    const matchingThread = threads.find((thread) =>
      thread.hostId === receiptHostId &&
      protocolThreadId(thread) === receiptThreadId &&
      thread.executionGenerationId === receiptExecutionGenerationId,
    )

    // src/renderer/src/api.ts:2171 — current
    const matchingThread = threads.find((thread) =>
      thread.hostId === entryHostId &&
      protocolThreadId(thread) === commandThreadId &&
      thread.executionGenerationId === commandGenerationId
    )

Each match also scans hosts for a display name. The canonical rule recipe is to
build a `Map` once before the loop instead of calling `array.find(...)` inside
it.

## Target

Build immutable indexes once per projection normalization and preserve the full
authority tuple in the key.

    // src/renderer/src/api.ts — target
    function residentThreadBindingKey(hostId: string, threadId: string, executionGenerationId: string): string {
      return JSON.stringify([hostId, threadId, executionGenerationId])
    }

    const threadByResidentBinding = new Map(
      threads.flatMap((thread) => {
        const threadId = protocolThreadId(thread)
        return thread.executionGenerationId && threadId
          ? [[residentThreadBindingKey(thread.hostId, threadId, thread.executionGenerationId), thread] as const]
          : []
      }),
    )
    const hostNameById = new Map(hosts.map((host) => [host.id, host.name] as const))

    const matchingThread = threadByResidentBinding.get(
      residentThreadBindingKey(receiptHostId, receiptThreadId, receiptExecutionGenerationId),
    )

Use the same index for durable receipt and outbox correlation. Never key by
thread ID alone.

## Repo conventions to follow

- Follow the exact tuple-key pattern already used for command identity in
  `src/renderer/src/api.ts`.
- Preserve path-free diagnostics and current attention-item ordering.
- Keep normalization deterministic and dependency-free.

## Steps

1. Add `residentThreadBindingKey` beside the existing authority helpers.
2. Construct the two indexes immediately after hosts/threads are parsed and
   reuse them across receipt/outbox normalization.
3. Replace only `.find` calls whose semantics exactly match the index; leave
   unrelated first-match UI selection logic alone.
4. Add API fixtures with the same remote thread ID on two hosts and two
   generations to prove exact correlation and no cross-authority attention.
5. Add a bounded synthetic projection benchmark to the focused API test and
   record before/after normalization time outside CI; do not make wall time a
   flaky test assertion.

## Boundaries

- Do NOT collapse host/thread/generation identity.
- Do NOT change ordering, deduplication, or uncertainty copy.
- Do NOT memoize untrusted raw protocol objects across publications.
- Do NOT add a cache with lifecycle invalidation.
- STOP if the code has drifted from the commit stamp; report the drift instead
  of improvising.

## Verification

- **Mechanical**:
  - `corepack pnpm dlx react-doctor@latest --scope changed` clears the targeted
    `react-doctor/js-index-maps` diagnostics.
  - Run web typecheck and native/preview API suites.
- **Behavior check**: Load a fixture with hundreds of durable receipts and
  outbox records across multiple generations. Attention items must remain
  byte-for-byte equivalent while projection normalization shows fewer repeated
  scans in the profiler.
- **Done when**: exact-authority fixtures pass, output ordering is unchanged,
  and the two nested linear lookups are gone.

## Result

- Native API suite: 118/118 passed.
- New collision coverage proves the same remote thread ID and generation on two
  hosts resolves to the exact host, while a retired generation is ignored.
- A non-gating synthetic comparison over 2,000 threads × 2,000 receipts × 20
  iterations measured 155.12 ms for repeated linear scans and 12.89 ms for the
  rebuilt-per-publication index (12.03× in that synthetic workload).
- Full typecheck and production renderer build pass; eager startup remains
  146,701 gzip bytes against the 204,800-byte budget.
