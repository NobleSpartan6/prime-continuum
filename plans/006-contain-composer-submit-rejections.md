# 006 — Contain composer submit rejections

- **Status**: DONE
- **Baseline**: f2f6ba8
- **Severity**: HIGH
- **Category**: Bugs & correctness
- **Rule**: react-doctor/no-floating-then-in-jsx-handler
- **Estimated scope**: 2 files, about 35 lines including a focused test

## Problem

The Composer starts a promise chain from its form handler but has no rejection
handler. React error boundaries cannot catch an asynchronous rejection, and the
submission guard may remain set after a rejected callback.

    // src/renderer/src/App.tsx:4721 — current
    void onSubmitText(submittedText, form).then((clearExactDraft) => {
      if (clearExactDraft && committedAuthorityKeyRef.current === submittedAuthorityKey) {
        setText((current) => current === submittedText ? '' : current)
      }
    }).finally(() => {
      …
    })

React Doctor’s canonical recipe is to add a catch handler or use an async
handler with try/catch so rejected promises do not become uncaught rejections.

## Target

Keep the current non-blocking form handler and exact-authority clearing logic,
but add a catch handler that leaves the draft intact. The root submission path
already turns expected command outcomes into explicit receipts; this catch is a
last-resort containment boundary, not a second error presentation.

    void onSubmitText(submittedText, form)
      .then((clearExactDraft) => { … })
      .catch(() => undefined)
      .finally(() => { … })

## Repo conventions to follow

- Preserve `submissionInFlightRef`, `committedAuthorityKeyRef`, and exact draft
  authority isolation.
- Follow existing path-free error presentation in the root submit callback.

## Steps

1. Add the canonical rejection handler before `finally`.
2. Add a focused test proving a rejected callback does not emit an unhandled
   rejection, does not clear the draft, and releases the exact submission guard.
3. Re-run React Doctor changed scope and the full renderer interaction suite.

## Boundaries

- Do NOT retry the prompt.
- Do NOT clear the draft on rejection.
- Do NOT weaken host/thread/generation fencing.

## Verification

- **Mechanical**: the targeted React Doctor diagnostic clears; web typecheck and
  App tests pass.
- **Behavior check**: a rejected submit leaves the exact draft editable and a
  later manual submit is admitted once.
- **Done when**: no uncaught promise escapes and no prompt replay is introduced.

## Result

- The form-local promise chain now contains unexpected rejection before its
  existing exact-authority cleanup runs.
- Draft clearing and mutation retry behavior are unchanged; only an explicit
  authoritative receipt may clear the submitted draft.
- React Doctor's targeted floating-promise diagnostic is absent from the final
  changed-scope report. Full renderer interaction suite: 173/173 passed.
