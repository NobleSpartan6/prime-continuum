# 001 — Localize composer draft rendering

- **Status**: DONE
- **Baseline**: f2f6ba8
- **Severity**: HIGH
- **Category**: Performance
- **Rule**: Beyond the scan
- **Estimated scope**: 2 files, about 180 lines including focused tests

## Problem

The highest-frequency interaction in the app is typing a task. The draft is
owned by the 8,000-line root `App`, so every keystroke schedules the entire
workbench render before memoized children can bail out.

    // src/renderer/src/App.tsx:1177 — current
    const [composerText, setComposerText] = useState('')

    // src/renderer/src/App.tsx:1554 — current
    useLayoutEffect(() => {
      if (composerDraftAuthorityKeyRef.current === composerDraftAuthorityKey) return
      composerDraftAuthorityKeyRef.current = composerDraftAuthorityKey
      composerAuthorityGenerationRef.current += 1
      setComposerText(composerDraftAuthorityKey ? composerDraftsRef.current.get(composerDraftAuthorityKey) ?? '' : '')
      setComposerValidationError('')
    }, [composerDraftAuthorityKey])

    // src/renderer/src/App.tsx:4643 — current
    onChange={(event) => onTextChange(event.target.value)}

This is user-visible as input latency when transcript/runtime projections are
large. The current memoized `Transcript` and inspector boundaries do not avoid
executing the root component body.

## Target

Keep the exact host/thread/generation draft map in `App`, but move the live text
subscription into `Composer`. Typing updates only `Composer`; external task
starters call an authority-checked composer handle; submission receives an
immutable text value and returns whether that exact draft may be cleared.

    // target shape in src/renderer/src/App.tsx
    interface ComposerHandle {
      prefill: (expectedAuthorityKey: string, text: string) => boolean
    }

    const composerDraftsRef = useRef(new Map<string, string>())
    const composerHandleRef = useRef<ComposerHandle | null>(null)

    const rememberComposerText = useCallback((authorityKey: string, text: string) => {
      rememberComposerDraft(composerDraftsRef.current, authorityKey, text)
    }, [])

    const prefillComposer = useCallback((text: string) => {
      if (!composerDraftAuthorityKey) return
      rememberComposerDraft(composerDraftsRef.current, composerDraftAuthorityKey, text)
      setComposerValidationError('')
      composerHandleRef.current?.prefill(composerDraftAuthorityKey, text)
    }, [composerDraftAuthorityKey])

    // target shape at both Composer call sites
    <Composer
      authorityKey={composerDraftAuthorityKey}
      initialText={composerDraftsRef.current.get(composerDraftAuthorityKey) ?? ''}
      handleRef={composerHandleRef}
      onDraftChange={rememberComposerText}
      onSubmitText={submitComposerText}
      {...stableControlProps}
    />

    // target shape inside Composer
    const [text, setText] = useState(initialText)
    const committedAuthorityKeyRef = useRef(authorityKey)

    useLayoutEffect(() => {
      if (committedAuthorityKeyRef.current === authorityKey) return
      committedAuthorityKeyRef.current = authorityKey
      submissionInFlightRef.current = false
      setText(initialText)
    }, [authorityKey, initialText])

    const updateText = (nextText: string) => {
      setText(nextText)
      onDraftChange(authorityKey, nextText)
      onClearValidation()
    }

    const submit = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const submittedText = text
      const clearExactDraft = await onSubmitText(submittedText, event.currentTarget)
      if (!clearExactDraft) return
      setText((current) => current === submittedText ? '' : current)
    }

The Composer DOM must remain mounted across authority changes so model-trigger
focus and dialog restoration remain stable; do not key the whole component.
`submitComposerText` must preserve the existing no-replay authority sequence,
return `true` only when the exact receipt is not rejected, and delete the map
entry only when it still equals `submittedText`. Do not use a global store or a
new state library.

## Repo conventions to follow

- Follow the existing `memo` boundary in `src/renderer/src/App.tsx:3996`.
- Preserve `composerActionAuthorityKey`, `rememberComposerDraft`, and the
  host/thread/execution-generation isolation already tested by the renderer.
- Keep external starter behavior prefill-only; it must never auto-submit.

## Steps

1. Add a focused root-render sentinel in `tests/renderer/App.test.tsx`: after
   initial stabilization, type an ordinary task and prove the root-only API
   environment read is not executed.
2. Move live text state and exact-text clearing into `Composer` using the target
   contract above. Keep the draft map and mutation authority in `App`.
3. Convert command-palette and launchpad prefills to the exact-authority handle;
   keep the Composer's own task starters local.
4. Do not add `memo` or `useMemo` unless profiling shows another parent-driven
   render problem; local state ownership already removes the keystroke fan-out.
5. Re-run draft isolation, Ctrl/Command+Enter, rejected/uncertain receipt, HUD,
   and task-starter tests.

## Boundaries

- Do NOT relax host/thread/execution-generation fencing or mutation no-replay.
- Do NOT clear a newer draft after an older submission settles.
- Do NOT introduce an external state dependency.
- Do NOT change visible composer copy or keyboard behavior.
- STOP if the code has drifted from the commit stamp; report the drift instead
  of improvising.

## Verification

- **Mechanical**:
  - Run web typecheck and `tests/renderer/App.test.tsx`.
  - Run the renderer startup budget and production build; eager gzip must not
    exceed the existing 200 KiB budget.
- **Behavior check**: In React DevTools Profiler, type ten characters in a ready
  resident task. `Composer` should update; the root workbench, transcript,
  launchpad, sidebar, and closed inspector must not flash for each character.
- **Done when**: root commits per ten typed characters drop from ten to zero,
  draft isolation and no-replay tests pass, and submission still clears only the
  exact submitted draft.

## Result

- `tests/renderer/App.test.tsx` proves ordinary typing performs zero root API
  environment reads while keeping exact draft behavior.
- Full renderer interaction result: 150/150 passed.
- Current production eager closure: 146,701 gzip bytes against a 204,800-byte
  budget after the subsequent native projection index also landed.
