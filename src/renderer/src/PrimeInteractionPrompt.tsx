import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import type {
  ExtensionUiDialogResponse,
  ResidentExtensionUiRequest,
} from '../../shared/protocol'

import './PrimeInteractionPrompt.css'

export type PrimeInteractionResponseResult =
  | { state: 'completed'; message: string }
  | { state: 'rejected'; message: string; retryable: boolean }
  | { state: 'uncertain'; message: string; retryable: false }

export interface PrimeInteractionPromptProps {
  requests: readonly ResidentExtensionUiRequest[]
  onRespond: (
    request: ResidentExtensionUiRequest,
    response: ExtensionUiDialogResponse,
  ) => Promise<PrimeInteractionResponseResult>
  onDismissResult?: (request: ResidentExtensionUiRequest) => void
}

type ResponseState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'completed'; message: string }
  | { kind: 'rejected'; message: string; retryable: boolean }
  | { kind: 'uncertain'; message: string }

const RADIO_OPTION_LIMIT = 5

function oldestRequest(
  requests: readonly ResidentExtensionUiRequest[],
): ResidentExtensionUiRequest | undefined {
  let oldest: ResidentExtensionUiRequest | undefined
  for (const request of requests) {
    if (
      !oldest ||
      request.receivedAt < oldest.receivedAt ||
      (request.receivedAt === oldest.receivedAt && request.requestId < oldest.requestId)
    ) {
      oldest = request
    }
  }
  return oldest
}

function primaryLabel(method: ResidentExtensionUiRequest['method']): string {
  if (method === 'confirm') return 'Confirm'
  if (method === 'select') return 'Choose'
  return 'Send'
}

function PrimeInteractionForm({
  request,
  waitingCount,
  onRespond,
  onDismissResult,
}: {
  request: ResidentExtensionUiRequest
  waitingCount: number
  onRespond: PrimeInteractionPromptProps['onRespond']
  onDismissResult?: PrimeInteractionPromptProps['onDismissResult']
}) {
  const id = useId()
  const titleId = `${id}-title`
  const detailId = `${id}-detail`
  const errorId = `${id}-error`
  const firstControlRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(null)
  const submitLockRef = useRef(false)
  const [value, setValue] = useState(request.method === 'editor' ? request.prefill ?? '' : '')
  const [responseState, setResponseState] = useState<ResponseState>({ kind: 'idle' })
  const [validationError, setValidationError] = useState('')

  const locked =
    responseState.kind === 'sending' ||
    responseState.kind === 'completed' ||
    responseState.kind === 'uncertain' ||
    (responseState.kind === 'rejected' && !responseState.retryable)
  const dismissibleResult = responseState.kind === 'uncertain' ||
    (responseState.kind === 'rejected' && !responseState.retryable)

  useEffect(() => {
    firstControlRef.current?.focus({ preventScroll: true })
  }, [])

  const deliver = async (response: ExtensionUiDialogResponse) => {
    if (submitLockRef.current) return
    submitLockRef.current = true
    setValidationError('')
    setResponseState({ kind: 'sending' })

    try {
      const result = await onRespond(request, response)
      if (result.state === 'completed') {
        setResponseState({ kind: 'completed', message: result.message })
        return
      }
      if (result.state === 'uncertain') {
        setResponseState({ kind: 'uncertain', message: result.message })
        return
      }

      setResponseState({ kind: 'rejected', message: result.message, retryable: result.retryable })
      if (result.retryable) submitLockRef.current = false
    } catch {
      setResponseState({
        kind: 'uncertain',
        message: 'Response delivery could not be verified.',
      })
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (locked || submitLockRef.current) return

    if (request.method === 'confirm') {
      void deliver({ kind: 'confirmed', confirmed: true })
      return
    }

    if (request.method === 'select' && value === '') {
      setValidationError('Choose an option to continue.')
      firstControlRef.current?.focus()
      return
    }

    void deliver({ kind: 'value', value })
  }

  const cancel = () => {
    if (locked || submitLockRef.current) return
    void deliver({ kind: 'cancelled' })
  }

  const submitEditorShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  const describedBy = [
    request.method === 'confirm' && request.message ? detailId : undefined,
    validationError ? errorId : undefined,
  ].filter(Boolean).join(' ') || undefined

  const statusMessage = responseState.kind === 'idle'
    ? ''
    : responseState.kind === 'sending'
      ? 'Sending response…'
      : responseState.kind === 'completed'
        ? responseState.message || 'Response delivered.'
        : responseState.kind === 'uncertain'
          ? `${responseState.message} Prime Continuim will not send it again. Check the session before acting again.`
          : responseState.message

  return (
    <section
      className="prime-interaction"
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      aria-busy={responseState.kind === 'sending' ? 'true' : undefined}
    >
      <header className="prime-interaction__header">
        <div className="prime-interaction__context">
          <span>Prime Agent asks</span>
          {waitingCount > 1 && <span aria-label={`${waitingCount} questions waiting`}>{waitingCount} waiting</span>}
        </div>
        <h2 id={titleId}>{request.title}</h2>
        {request.method === 'confirm' && request.message && <p id={detailId}>{request.message}</p>}
      </header>

      <form className="prime-interaction__form" onSubmit={submit} noValidate>
        {request.method === 'select' && request.options.length <= RADIO_OPTION_LIMIT && (
          <fieldset className="prime-interaction__options" aria-describedby={validationError ? errorId : undefined}>
            <legend>Choose one</legend>
            {request.options.map((option, index) => (
              <label className="prime-interaction__option" key={option}>
                <input
                  ref={index === 0 ? firstControlRef as React.RefObject<HTMLInputElement> : undefined}
                  type="radio"
                  name={`${id}-option`}
                  value={option}
                  checked={value === option}
                  disabled={locked}
                  aria-invalid={validationError ? 'true' : undefined}
                  onChange={(event) => {
                    setValue(event.currentTarget.value)
                    setValidationError('')
                  }}
                />
                <span>{option}</span>
              </label>
            ))}
          </fieldset>
        )}

        {request.method === 'select' && request.options.length > RADIO_OPTION_LIMIT && (
          <label className="prime-interaction__field" htmlFor={`${id}-select`}>
            <span>Choose one</span>
            <select
              ref={firstControlRef as React.RefObject<HTMLSelectElement>}
              id={`${id}-select`}
              value={value}
              disabled={locked}
              required
              aria-invalid={validationError ? 'true' : undefined}
              aria-describedby={validationError ? errorId : undefined}
              onChange={(event) => {
                setValue(event.currentTarget.value)
                setValidationError('')
              }}
            >
              <option value="" disabled>Choose an option</option>
              {request.options.map((option) => <option value={option} key={option}>{option}</option>)}
            </select>
          </label>
        )}

        {request.method === 'input' && (
          <label className="prime-interaction__field" htmlFor={`${id}-input`}>
            <span>Response</span>
            <input
              ref={firstControlRef as React.RefObject<HTMLInputElement>}
              id={`${id}-input`}
              name="prime-agent-response"
              value={value}
              placeholder={request.placeholder}
              disabled={locked}
              autoComplete="off"
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </label>
        )}

        {request.method === 'editor' && (
          <div className="prime-interaction__editor">
            <label className="prime-interaction__field" htmlFor={`${id}-editor`}>
              <span>Response</span>
              <textarea
                ref={firstControlRef as React.RefObject<HTMLTextAreaElement>}
                id={`${id}-editor`}
                name="prime-agent-response"
                value={value}
                disabled={locked}
                rows={5}
                aria-describedby={`${id}-editor-hint`}
                onChange={(event) => setValue(event.currentTarget.value)}
                onKeyDown={submitEditorShortcut}
              />
            </label>
            <small id={`${id}-editor-hint`}>Press ⌘Enter to send</small>
          </div>
        )}

        <div className="prime-interaction__feedback">
          {validationError && <p id={errorId}>{validationError}</p>}
          <p className={responseState.kind === 'sending' || responseState.kind === 'completed' ? '' : 'sr-only'} role="status" aria-live="polite" aria-atomic="true">
            {responseState.kind === 'sending' || responseState.kind === 'completed' ? statusMessage : ''}
          </p>
          <p className={responseState.kind === 'uncertain' || responseState.kind === 'rejected' ? '' : 'sr-only'} role="alert" aria-atomic="true">
            {responseState.kind === 'uncertain' || responseState.kind === 'rejected' ? statusMessage : ''}
          </p>
        </div>

        <div className="prime-interaction__actions">
          {dismissibleResult ? (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => onDismissResult?.(request)}
            >
              Dismiss
            </button>
          ) : (
            <button className="button button--secondary" type="button" disabled={locked} onClick={cancel}>
              Cancel
            </button>
          )}
          <button
            ref={request.method === 'confirm' ? firstControlRef as React.RefObject<HTMLButtonElement> : undefined}
            className="button button--primary"
            type="submit"
            disabled={locked}
          >
            {responseState.kind === 'sending'
              ? 'Sending…'
              : responseState.kind === 'uncertain'
                ? 'Outcome unknown'
                : responseState.kind === 'completed'
                  ? 'Sent'
                  : primaryLabel(request.method)}
          </button>
        </div>
      </form>
    </section>
  )
}

export function PrimeInteractionPrompt({ requests, onRespond, onDismissResult }: PrimeInteractionPromptProps) {
  const request = useMemo(() => oldestRequest(requests), [requests])
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const visibleRef = useRef(false)

  useLayoutEffect(() => {
    if (request && !visibleRef.current) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      visibleRef.current = true
      return
    }

    if (!request && visibleRef.current) {
      const previousFocus = previousFocusRef.current
      previousFocusRef.current = null
      visibleRef.current = false
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [request])

  useEffect(() => () => {
    const previousFocus = previousFocusRef.current
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  }, [])

  if (!request) return null

  return (
    <PrimeInteractionForm
      key={`${request.executionGenerationId}:${request.requestId}:${request.requestDigest}`}
      request={request}
      waitingCount={requests.length}
      onRespond={onRespond}
      onDismissResult={onDismissResult}
    />
  )
}
