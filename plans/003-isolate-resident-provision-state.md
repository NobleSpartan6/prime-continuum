# 003 — Isolate each resident provision attempt

- **Status**: DONE
- **Baseline**: f2f6ba8
- **Severity**: HIGH
- **Category**: Bugs & correctness
- **Rule**: react-doctor/prefer-useReducer
- **Estimated scope**: 2 files, about 220 lines including focused tests

## Problem

The setup dialog has eight independent state cells and resets all of them in an
effect when selection details change. That makes the first frame after a new
folder selection capable of displaying stale labels/errors from the previous
attempt and makes invalid state combinations representable.

    // src/renderer/src/App.tsx:6867 — current
    const [projectDisplayName, setProjectDisplayName] = useState('')
    const [threadTitle, setThreadTitle] = useState('')
    const [invalidField, setInvalidField] = useState<'project' | 'thread' | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const [settled, setSettled] = useState(false)
    const [message, setMessage] = useState('')
    const [error, setError] = useState('')
    const [lockedDetails, setLockedDetails] = useState<ResidentProvisioningDetails | undefined>(undefined)

    useEffect(() => {
      if (!selection) return
      // eight setters reset the prior attempt after it has rendered
    }, [initialProjectName, recoveryDetails, selection])

This is the exact flow where users encounter durable identity conflicts. The
backend must remain fail-closed; the UI should make one selected folder token
equal one explicit dialog state machine.

The canonical rule recipe is to group state that always changes together into
`useReducer` so one dispatched action describes the whole transition.

## Target

Key an inner attempt component by the one-use selection token, initialize state
synchronously, and express valid transitions with a discriminated reducer.

    // target shape in src/renderer/src/App.tsx
    type ProvisionAttemptState =
      | { phase: 'editing'; projectDisplayName: string; threadTitle: string; lockedDetails?: ResidentProvisioningDetails; invalidField: 'project' | 'thread' | null; error: string }
      | { phase: 'submitting'; projectDisplayName: string; threadTitle: string; lockedDetails?: ResidentProvisioningDetails; message: string }
      | { phase: 'settled'; projectDisplayName: string; threadTitle: string; lockedDetails?: ResidentProvisioningDetails; message: string; error: string }

    type ProvisionAttemptAction =
      | { type: 'edit-project'; value: string }
      | { type: 'edit-thread'; value: string }
      | { type: 'validation-failed'; field: 'project' | 'thread'; message: string }
      | { type: 'submitting' }
      | { type: 'settled'; message: string; error?: string }
      | { type: 'retryable-failure'; message: string }

    function ResidentProvisionDialog(props: ResidentProvisionDialogProps) {
      if (!props.selection) return null
      return (
        <ResidentProvisionAttempt
          key={props.selection.selectionToken}
          {...props}
          selection={props.selection}
        />
      )
    }

    function ResidentProvisionAttempt({ selection, initialProjectName, recoveryDetails, ...rest }: ResidentProvisionAttemptProps) {
      const [state, dispatch] = useReducer(
        provisionAttemptReducer,
        { selection, initialProjectName, recoveryDetails },
        createProvisionAttemptState,
      )
      // render and submit from the discriminated phase
    }

`createProvisionAttemptState` must apply the current recovery identity exactly:
locked details remain immutable, and editable defaults use the selected folder's
suggested name. The reducer must never transition from `submitting` or
`settled` back to submission for the same one-use token.

## Repo conventions to follow

- Preserve `residentProvisionIdentityConflictDetails` and the durable operation
  reference currently created after `api.provisionResident`.
- Follow the discriminated `ComposerReceiptView` style in
  `src/renderer/src/App.tsx` rather than boolean combinations.
- Keep the existing focus refs and live-region copy.

## Steps

1. Extract `ResidentProvisionDialogProps`, the synchronous initializer, reducer,
   and `ResidentProvisionAttempt` at module scope.
2. Make `ResidentProvisionDialog` a null-or-keyed wrapper so a new selection
   cannot render the prior attempt's state.
3. Replace setter sequences with one reducer action per transition while
   preserving exact backend calls and recovery references.
4. Add state-machine unit cases and App interactions for: new folder after an
   identity conflict, immutable recovery labels, double-submit prevention,
   uncertain outcome, close/reopen focus, and a superseded selection token.

## Boundaries

- Do NOT auto-retry provisioning or change the one-use token contract.
- Do NOT hide identity conflicts or synthesize new provisioning details.
- Do NOT change path privacy, authority checks, or durable recovery semantics.
- Do NOT add a form/state dependency.
- STOP if the code has drifted from the commit stamp; report the drift instead
  of improvising.

## Verification

- **Mechanical**:
  - The targeted `react-doctor/prefer-useReducer` and reset-on-prop diagnostics
    for `ResidentProvisionDialog` are clear.
  - Run web typecheck and resident provisioning main/API/App suites.
- **Behavior check**: Reproduce an identity conflict, close, choose the same
  folder again, and verify the recovered immutable names appear on the first
  frame with one clear primary action and no prior transient error.
- **Done when**: one selection token maps to one reducer lifetime, no impossible
  submitting/settled combination exists, and no provisioning mutation replays.

## Result

- `ResidentProvisionAttempt` is keyed by the one-use selection token and is
  initialized synchronously through a discriminated reducer.
- Identity conflicts restore immutable receipt names inline; a later token gets
  a clean first frame. A synchronous admission ref blocks duplicate form events.
- Native dialog focus restoration remains intact when host authority retires an
  open attempt, and short 320×256 action rows now stack without overflow.
- Verification: web typecheck passed; App + styles passed 163/163; production
  build passed; eager renderer closure is 147,218 bytes gzip against 204,800.
