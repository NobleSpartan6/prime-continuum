# 002 — Commit authority refs after render

- **Status**: DONE
- **Baseline**: f2f6ba8
- **Severity**: HIGH
- **Category**: Bugs & correctness
- **Rule**: react-doctor/no-ref-current-in-render
- **Estimated scope**: 3 files, about 70 lines including tests

## Problem

React Doctor reports five render-phase ref mutations. These refs fence async
host/thread/model/OAuth replies. React may replay or discard a render, so a
speculative selection can leak into an async authority check before it commits.

    // src/renderer/src/App.tsx:1948 — current
    activeHostIdRef.current = selectedHost?.id
    activeThreadIdRef.current = selectedThread?.id

    // src/renderer/src/ModelsDialog.tsx:110 — current
    dialogOpenRef.current = open
    selectionAuthorityRef.current = selectionAuthorityKey
    oauthAuthorityRef.current = oauthAuthorityKey

The canonical rule recipe is: move ref writes into an event handler or effect;
render must remain pure because React can replay or discard it.

## Target

Use layout effects so the ref represents the latest committed UI authority
before browser paint. Initial `useRef` values remain correct for the first
commit.

    // src/renderer/src/App.tsx — target
    useLayoutEffect(() => {
      activeHostIdRef.current = selectedHost?.id
      activeThreadIdRef.current = selectedThread?.id
    }, [selectedHost?.id, selectedThread?.id])

    // src/renderer/src/ModelsDialog.tsx — target
    useLayoutEffect(() => {
      dialogOpenRef.current = open
      selectionAuthorityRef.current = selectionAuthorityKey
      oauthAuthorityRef.current = oauthAuthorityKey
    }, [oauthAuthorityKey, open, selectionAuthorityKey])

Do not move these writes into passive promise callbacks: every async reply must
compare against the same latest committed authority.

## Repo conventions to follow

- Follow the committed HUD authority reset in
  `src/renderer/src/App.tsx:1666`, which already uses `useLayoutEffect`.
- Preserve request sequence refs and `StaleHostAuthorityError` handling.
- Keep model/OAuth authority keys path-free and exact.

## Steps

1. Move the two App ref writes into the target layout effect.
2. Import `useLayoutEffect` in `ModelsDialog.tsx` and move its three ref writes
   into the target layout effect.
3. Add a focused concurrent-render regression using a Suspense interruption or
   discarded render: a reply for the last committed host/model authority must
   remain admissible; a reply for an uncommitted authority must not mutate UI.
4. Re-run exact model selection, OAuth cancellation, host activation, prompt,
   and Stop authority tests.

## Boundaries

- Do NOT weaken any authority comparison to a render-time prop closure.
- Do NOT switch to `useEffect`; the authority must be current at commit before
  user interaction.
- Do NOT change public APIs or user-visible behavior.
- STOP if the code has drifted from the commit stamp; report the drift instead
  of improvising.

## Verification

- **Mechanical**:
  - `corepack pnpm dlx react-doctor@latest --scope changed` clears all five
    `react-doctor/no-ref-current-in-render` diagnostics.
  - Run web typecheck plus App, ModelsDialog, and native API renderer suites.
- **Behavior check**: Rapidly switch threads while a prompt settles and close
  Models & accounts while a model/OAuth request settles. No stale receipt,
  selection, or OAuth state may appear in the newly committed UI.
- **Done when**: the diagnostics are clear and interrupted-render tests prove
  only committed authority can accept async results.

## Result

All five diagnostics are clear. Focused host activation, prompt, model
selection, dialog close/reopen, and OAuth authority tests pass, along with web
typecheck.
