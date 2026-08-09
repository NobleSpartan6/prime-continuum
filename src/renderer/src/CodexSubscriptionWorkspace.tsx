import {
  AlertCircle,
  Bot,
  ExternalLink,
  Loader2,
  LogOut,
  RefreshCw,
  Send,
  ShieldCheck,
  Square,
} from 'lucide-react'
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  CodexSubscriptionAccountSnapshot,
  CodexSubscriptionConversationSnapshot,
  CodexSubscriptionRequestBinding,
  CodexSubscriptionTurnReadiness,
  CodexSubscriptionTurnStartRequest,
} from '../../shared/protocol'
import type { CodexSubscriptionRendererApi } from './api'

interface CodexSubscriptionWorkspaceProps {
  api: CodexSubscriptionRendererApi
  binding: CodexSubscriptionRequestBinding
}

type AccountLoadState = 'loading' | 'ready' | 'error'
type ActionState =
  | 'idle'
  | 'opening_browser'
  | 'cancelling_login'
  | 'signing_out'
  | 'starting'
  | 'reconciling'
  | 'running'
  | 'interrupting'
  | 'stop_uncertain'

interface ExecutionPolicyView {
  disclosure?: string
}

const ACCOUNT_POLL_MS = 4_000
const ACTIVE_POLL_MS = 700
const LOGIN_POLL_MS = 1_000
const RECONCILE_RETRY_MS = 1_500

export function CodexSubscriptionWorkspace({ api, binding }: CodexSubscriptionWorkspaceProps) {
  const authority = useMemo<CodexSubscriptionRequestBinding>(() => ({ ...binding }), [
    binding.expectedExecutionGenerationId,
    binding.expectedHostId,
    binding.threadId,
  ])
  const [account, setAccount] = useState<CodexSubscriptionAccountSnapshot | null>(null)
  const [conversation, setConversation] = useState<CodexSubscriptionConversationSnapshot | null>(null)
  const [accountLoadState, setAccountLoadState] = useState<AccountLoadState>('loading')
  const [draft, setDraft] = useState('')
  const [actionState, setActionState] = useState<ActionState>('idle')
  const [statusMessage, setStatusMessage] = useState('Checking the local Codex backend…')
  const [errorMessage, setErrorMessage] = useState('')
  const [pendingStartOperationId, setPendingStartOperationId] = useState('')
  const accountRef = useRef<CodexSubscriptionAccountSnapshot | null>(null)
  const conversationRef = useRef<CodexSubscriptionConversationSnapshot | null>(null)
  const actionSequenceRef = useRef(0)
  const pendingStartRef = useRef<CodexSubscriptionTurnStartRequest | null>(null)
  const pendingStartErrorRef = useRef('')

  const acceptAccount = useCallback((next: CodexSubscriptionAccountSnapshot) => {
    const previous = accountRef.current
    if (previous && previous.backendIncarnationId === next.backendIncarnationId) {
      const previousTime = Date.parse(previous.updatedAt)
      const nextTime = Date.parse(next.updatedAt)
      if (nextTime < previousTime) return previous
      if (nextTime === previousTime && JSON.stringify(next) !== JSON.stringify(previous)) {
        setErrorMessage('The Codex account changed without a newer timestamp. Refresh this workspace before continuing.')
        return previous
      }
    }
    if (previous && previous.backendIncarnationId !== next.backendIncarnationId) {
      actionSequenceRef.current += 1
      pendingStartRef.current = null
      pendingStartErrorRef.current = ''
      conversationRef.current = null
      setConversation(null)
      setDraft('')
      setActionState('idle')
      setPendingStartOperationId('')
    }
    accountRef.current = next
    setAccount(next)
    setAccountLoadState('ready')
    return next
  }, [])

  const acceptConversation = useCallback((next: CodexSubscriptionConversationSnapshot | null) => {
    const current = conversationRef.current
    if (!next) {
      conversationRef.current = null
      setConversation(null)
      return null
    }
    if (current && current.backendIncarnationId === next.backendIncarnationId) {
      if (next.revision < current.revision) return current
      if (next.revision === current.revision && JSON.stringify(next) !== JSON.stringify(current)) {
        setErrorMessage('The Codex conversation changed without a new revision. Refresh this workspace before continuing.')
        return current
      }
    }
    conversationRef.current = next
    setConversation(next)

    const pendingStart = pendingStartRef.current
    if (pendingStart && conversationContainsOperation(next, pendingStart.operationId)) {
      pendingStartRef.current = null
      pendingStartErrorRef.current = ''
      setPendingStartOperationId('')
      setDraft('')
    }
    if (next.state === 'active') {
      setActionState((currentAction) =>
        currentAction === 'interrupting' || currentAction === 'stop_uncertain'
          ? currentAction
          : 'running',
      )
      setStatusMessage(turnStatusCopy(next))
    } else {
      setActionState('idle')
      setStatusMessage(turnStatusCopy(next))
    }
    return next
  }, [])

  const refresh = useCallback(async () => {
    const [accountResult, conversationResult] = await Promise.allSettled([
      api.accountRead({ expectedHostId: authority.expectedHostId }),
      api.conversationSnapshot(authority),
    ])
    let observedAccount = accountRef.current
    if (accountResult.status === 'fulfilled') {
      observedAccount = acceptAccount(accountResult.value)
    } else if (!accountRef.current) {
      setAccountLoadState('error')
      setErrorMessage(errorCopy(accountResult.reason, 'The local Codex account state is unavailable.'))
    }
    if (conversationResult.status === 'fulfilled') {
      const refreshedConversation = conversationResult.value.conversation
      if (
        !refreshedConversation ||
        !observedAccount ||
        refreshedConversation.backendIncarnationId === observedAccount.backendIncarnationId
      ) {
        acceptConversation(refreshedConversation)
      }
    } else if (!conversationRef.current) {
      setErrorMessage((current) => current || errorCopy(
        conversationResult.reason,
        'The Codex conversation could not be recovered.',
      ))
    }
  }, [acceptAccount, acceptConversation, api, authority])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      await refresh()
      if (cancelled) return
      const currentAccount = accountRef.current
      const currentConversation = conversationRef.current
      const delay = currentConversation?.state === 'active' || pendingStartRef.current
        ? ACTIVE_POLL_MS
        : currentAccount?.phase === 'opening_browser' || currentAccount?.phase === 'waiting_for_login'
          ? LOGIN_POLL_MS
          : ACCOUNT_POLL_MS
      timer = window.setTimeout(() => void poll(), delay)
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [refresh])

  useEffect(() => {
    if (!pendingStartOperationId) return
    let cancelled = false
    let timer: number | undefined

    const reconcile = async () => {
      const envelope = pendingStartRef.current
      if (!envelope || envelope.operationId !== pendingStartOperationId || cancelled) return
      try {
        const result = await api.turnReconcile(envelope)
        if (cancelled || pendingStartRef.current?.operationId !== envelope.operationId) return
        if (result.known) {
          const accepted = acceptConversation(result.conversation)
          if (accepted && conversationContainsOperation(accepted, envelope.operationId)) {
            pendingStartRef.current = null
            pendingStartErrorRef.current = ''
            setPendingStartOperationId('')
            setDraft('')
            setErrorMessage('')
            return
          }
        } else {
          pendingStartRef.current = null
          setPendingStartOperationId('')
          setActionState('idle')
          setStatusMessage('The prompt was not admitted and was not sent again.')
          setErrorMessage(pendingStartErrorRef.current || 'The prompt could not be started.')
          pendingStartErrorRef.current = ''
          return
        }
      } catch {
        // The exact immutable envelope is retried only against reconcile; turn.start is never replayed.
      }
      if (!cancelled) timer = window.setTimeout(() => void reconcile(), RECONCILE_RETRY_MS)
    }

    setActionState('reconciling')
    setStatusMessage('Prompt outcome unknown · checking the existing Codex conversation. It will not be sent again automatically.')
    void reconcile()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [acceptConversation, api, pendingStartOperationId])

  const startLogin = async () => {
    const current = accountRef.current
    if (!current || actionState !== 'idle') return
    const sequence = ++actionSequenceRef.current
    setErrorMessage('')
    setActionState('opening_browser')
    setStatusMessage('Opening ChatGPT sign-in in your browser…')
    try {
      const next = await api.loginStart({
        expectedHostId: authority.expectedHostId,
        expectedBackendIncarnationId: current.backendIncarnationId,
        operationId: createOperationId('codex-login'),
      })
      if (sequence !== actionSequenceRef.current) return
      const accepted = acceptAccount(next)
      setActionState('idle')
      setStatusMessage(accepted.phase === 'signed_in'
        ? 'ChatGPT account connected.'
        : 'Finish signing in in your browser.')
    } catch (error) {
      if (sequence !== actionSequenceRef.current) return
      setActionState('idle')
      setErrorMessage(errorCopy(error, 'ChatGPT sign-in could not be started.'))
      setStatusMessage('Sign-in needs attention.')
    }
  }

  const cancelLogin = async () => {
    const current = accountRef.current
    if (
      !current ||
      (current.phase !== 'opening_browser' && current.phase !== 'waiting_for_login') ||
      !current.pendingLoginId ||
      !current.pendingLoginOperationId
    ) return
    const sequence = ++actionSequenceRef.current
    setErrorMessage('')
    setActionState('cancelling_login')
    setStatusMessage('Cancelling sign-in…')
    try {
      const next = await api.loginCancel({
        expectedHostId: authority.expectedHostId,
        expectedBackendIncarnationId: current.backendIncarnationId,
        loginOperationId: current.pendingLoginOperationId,
        loginId: current.pendingLoginId,
      })
      if (sequence !== actionSequenceRef.current) return
      acceptAccount(next)
      setActionState('idle')
      setStatusMessage('Sign-in cancelled.')
    } catch (error) {
      if (sequence !== actionSequenceRef.current) return
      setActionState('idle')
      setErrorMessage(errorCopy(error, 'Sign-in could not be cancelled.'))
    }
  }

  const logout = async () => {
    const current = accountRef.current
    if (!current || current.phase !== 'signed_in' || actionState !== 'idle') return
    const sequence = ++actionSequenceRef.current
    setErrorMessage('')
    setActionState('signing_out')
    setStatusMessage('Signing out…')
    try {
      const next = await api.logout({
        expectedHostId: authority.expectedHostId,
        expectedBackendIncarnationId: current.backendIncarnationId,
        operationId: createOperationId('codex-logout'),
      })
      if (sequence !== actionSequenceRef.current) return
      acceptAccount(next)
      acceptConversation(null)
      setActionState('idle')
      setStatusMessage('Signed out of the separate Codex backend.')
    } catch (error) {
      if (sequence !== actionSequenceRef.current) return
      setActionState('idle')
      setErrorMessage(errorCopy(error, 'The Codex backend could not sign out.'))
    }
  }

  const submitTurn = async (event?: FormEvent) => {
    event?.preventDefault()
    const currentAccount = accountRef.current
    const currentConversation = conversationRef.current
    const prompt = draft.trim()
    if (
      !currentAccount ||
      currentAccount.phase !== 'signed_in' ||
      turnReadiness(currentAccount).state !== 'ready' ||
      actionState !== 'idle' ||
      !prompt
    ) return

    const envelope: CodexSubscriptionTurnStartRequest = {
      ...authority,
      expectedBackendIncarnationId: currentAccount.backendIncarnationId,
      expectedConversation: currentConversation
        ? {
            state: 'present',
            sessionId: currentConversation.sessionId,
            revision: currentConversation.revision,
            ...(currentConversation.threadId ? { threadId: currentConversation.threadId } : {}),
          }
        : { state: 'absent' },
      operationId: createOperationId('codex-turn'),
      prompt,
    }
    const sequence = ++actionSequenceRef.current
    pendingStartRef.current = envelope
    pendingStartErrorRef.current = ''
    setErrorMessage('')
    setActionState('starting')
    setStatusMessage('Starting this Codex turn…')
    try {
      const next = await api.turnStart(envelope)
      if (sequence !== actionSequenceRef.current) return
      if (!conversationContainsOperation(next, envelope.operationId)) {
        throw new Error('The local Codex backend returned a different turn operation.')
      }
      acceptConversation(next)
      pendingStartRef.current = null
      setDraft('')
      setPendingStartOperationId('')
      setActionState(next.state === 'active' ? 'running' : 'idle')
      setStatusMessage(turnStatusCopy(next))
    } catch (error) {
      if (sequence !== actionSequenceRef.current) return
      pendingStartErrorRef.current = errorCopy(error, 'The prompt could not be started.')
      setPendingStartOperationId(envelope.operationId)
    }
  }

  const stopTurn = async () => {
    const currentAccount = accountRef.current
    const currentConversation = conversationRef.current
    const activeTurn = currentConversation?.activeTurn
    if (
      !currentAccount ||
      !currentConversation ||
      !currentConversation.threadId ||
      !activeTurn?.turnId ||
      (actionState !== 'running' && actionState !== 'idle')
    ) return
    const sequence = ++actionSequenceRef.current
    setErrorMessage('')
    setActionState('interrupting')
    setStatusMessage('Stop requested · waiting for the existing turn to end.')
    try {
      const next = await api.turnInterrupt({
        ...authority,
        expectedBackendIncarnationId: currentAccount.backendIncarnationId,
        sessionId: currentConversation.sessionId,
        codexThreadId: currentConversation.threadId,
        operationId: createOperationId('codex-interrupt'),
        expectedTurnOperationId: activeTurn.operationId,
        turnId: activeTurn.turnId,
      })
      if (sequence !== actionSequenceRef.current) return
      acceptConversation(next)
      setActionState(next.state === 'active' ? 'interrupting' : 'idle')
      setStatusMessage(next.state === 'active'
        ? 'Stop requested · waiting for the existing turn to end.'
        : turnStatusCopy(next))
    } catch (error) {
      if (sequence !== actionSequenceRef.current) return
      setActionState('stop_uncertain')
      setErrorMessage(errorCopy(error, 'Stop outcome unknown.'))
      setStatusMessage('Stop outcome unknown · checking the existing turn. It will not be sent again automatically.')
    }
  }

  const readiness = turnReadiness(account)
  const execution = executionPolicy(account, conversation)
  const pendingLogin = account?.phase === 'opening_browser' || account?.phase === 'waiting_for_login'
  const signedIn = account?.phase === 'signed_in'
  const turnActive = conversation?.state === 'active'
  const stopReady = Boolean(turnActive && conversation?.threadId && conversation.activeTurn?.turnId)
  const composerBusy = actionState !== 'idle' && actionState !== 'running'
  const canRun = Boolean(signedIn && readiness.state === 'ready' && !turnActive && actionState === 'idle' && draft.trim())

  return (
    <section className="codex-workspace" aria-labelledby="codex-workspace-heading">
      <header className="codex-workspace__header">
        <div className="codex-workspace__identity">
          <span className="codex-workspace__icon" aria-hidden="true"><Bot size={19} strokeWidth={1.75} /></span>
          <div>
            <span className="codex-workspace__eyebrow">Separate local backend</span>
            <h2 id="codex-workspace-heading" tabIndex={-1}>Codex via ChatGPT subscription</h2>
            <p>Uses Codex for this workspace. It does not configure Prime Agent.</p>
          </div>
        </div>
        <div className="codex-workspace__header-actions">
          <span className="codex-workspace__preview-badge">Windows preview</span>
          {signedIn && (
            <button
              className="button button--quiet button--small"
              type="button"
              disabled={actionState !== 'idle'}
              onClick={() => void logout()}
            >
              <LogOut size={14} aria-hidden="true" />
              <span>Sign out</span>
            </button>
          )}
        </div>
      </header>

      {accountLoadState === 'loading' && !account ? (
        <div className="codex-workspace__center" role="status">
          <Loader2 className="spin" size={20} aria-hidden="true" />
          <span>Checking the local Codex backend…</span>
        </div>
      ) : !signedIn ? (
        <div className="codex-account-card">
          <span className="codex-account-card__mark" aria-hidden="true"><ShieldCheck size={20} /></span>
          <div className="codex-account-card__copy">
            <h3>{pendingLogin ? 'Finish signing in in your browser' : 'Connect your ChatGPT account'}</h3>
            <p>Uses your ChatGPT plan; API-key billing is separate. This does not sign Prime Agent in.</p>
            <p>
              An encryption key is protected by the Windows system credential store. Encrypted sign-in data may
              also live in Prime Continuim’s private app data. Prime Agent does not receive your token, and this
              separate backend does not use your normal Codex home.
            </p>
            {account?.error && <p className="codex-account-card__detail">{account.error.message}</p>}
          </div>
          <div className="codex-account-card__actions">
            {pendingLogin ? (
              <button
                className="button button--secondary"
                type="button"
                disabled={actionState === 'cancelling_login'}
                onClick={() => void cancelLogin()}
              >
                {actionState === 'cancelling_login' && <Loader2 className="spin" size={15} aria-hidden="true" />}
                <span>Cancel sign-in</span>
              </button>
            ) : (
              <button
                className="button button--primary"
                type="button"
                disabled={!account || actionState !== 'idle' || account.phase === 'unavailable'}
                onClick={() => void startLogin()}
              >
                {actionState === 'opening_browser'
                  ? <Loader2 className="spin" size={15} aria-hidden="true" />
                  : <ExternalLink size={15} aria-hidden="true" />}
                <span>Continue with ChatGPT</span>
              </button>
            )}
            {accountLoadState === 'error' && (
              <button className="button button--quiet" type="button" onClick={() => void refresh()}>
                <RefreshCw size={14} aria-hidden="true" />
                <span>Try again</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="codex-policy" data-ready={readiness.state === 'ready'}>
            <ShieldCheck size={16} aria-hidden="true" />
            <div>
              <strong>
                {readiness.state === 'ready'
                  ? 'Read-only execution · approval requests are denied'
                  : 'Execution unavailable'}
              </strong>
              <span>{readiness.state === 'ready'
                ? execution?.disclosure
                : turnReadinessCopy(readiness)}</span>
            </div>
          </div>

          <div className="codex-transcript" aria-label="Codex conversation">
            {conversation?.transcript.length ? (
              <ol className="codex-transcript__list">
                {conversation.transcript.map((item) => (
                  <li
                    key={item.itemId}
                    className="codex-message"
                    data-role={item.role}
                    data-streaming={item.state === 'streaming'}
                  >
                    <div className="codex-message__meta">
                      <strong>{item.role === 'user' ? 'You' : 'Codex'}</strong>
                      <time dateTime={item.updatedAt}>{formatTime(item.updatedAt)}</time>
                    </div>
                    <p>{item.text || (item.state === 'streaming' ? 'Working…' : '')}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="codex-transcript__empty">
                <Bot size={24} aria-hidden="true" />
                <h3>Start a separate Codex conversation</h3>
                <p>This transcript is local to this backend and stays separate from Prime Agent.</p>
              </div>
            )}
            {conversation?.transcriptTruncated && (
              <p className="codex-transcript__truncated">Earlier Codex items are not included in this bounded view.</p>
            )}
          </div>

          <form className="codex-composer" onSubmit={(event) => void submitTurn(event)}>
            <label className="sr-only" htmlFor="codex-composer-input">Ask Codex about this workspace</label>
            <textarea
              id="codex-composer-input"
              value={draft}
              disabled={turnActive || actionState === 'reconciling' || actionState === 'stop_uncertain'}
              placeholder="Ask Codex about this workspace…"
              rows={3}
              maxLength={64 * 1_024}
              aria-describedby="codex-composer-status codex-policy-copy"
              onChange={(event) => {
                setDraft(event.target.value)
                if (errorMessage) setErrorMessage('')
              }}
              onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void submitTurn()
                }
              }}
            />
            <div className="codex-composer__footer">
              <div className="codex-composer__status">
                <span id="codex-composer-status" role="status" aria-live="polite" aria-atomic="true">
                  {statusMessage}
                </span>
                {errorMessage && (
                  <span className="codex-composer__error" role="alert">
                    <AlertCircle size={14} aria-hidden="true" /> {errorMessage}
                  </span>
                )}
              </div>
              {turnActive ? (
                <button
                  className="button button--stop codex-composer__submit"
                  type="button"
                  disabled={!stopReady || actionState === 'interrupting' || actionState === 'stop_uncertain'}
                  onClick={() => void stopTurn()}
                >
                  {actionState === 'interrupting'
                    ? <Loader2 className="spin" size={15} aria-hidden="true" />
                    : <Square size={14} fill="currentColor" aria-hidden="true" />}
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  className="button button--primary codex-composer__submit"
                  type="submit"
                  disabled={!canRun || composerBusy}
                >
                  {actionState === 'starting' || actionState === 'reconciling'
                    ? <Loader2 className="spin" size={15} aria-hidden="true" />
                    : <Send size={15} aria-hidden="true" />}
                  <span>Run with Codex</span>
                </button>
              )}
            </div>
            <p id="codex-policy-copy" className="codex-composer__policy">
              Workbench only · This conversation is separate from Prime Agent and is not available in the desktop HUD.
            </p>
          </form>
        </>
      )}
    </section>
  )
}

function turnReadiness(account: CodexSubscriptionAccountSnapshot | null): CodexSubscriptionTurnReadiness {
  return account?.turnReadiness ?? { state: 'unavailable', reason: 'backend_unavailable' }
}

function executionPolicy(
  account: CodexSubscriptionAccountSnapshot | null,
  conversation: CodexSubscriptionConversationSnapshot | null,
): ExecutionPolicyView | undefined {
  const accountPolicy = account?.executionPolicy
  return accountPolicy || conversation?.executionPolicy
}

function turnReadinessCopy(readiness: CodexSubscriptionTurnReadiness): string {
  if (readiness.state === 'error') return readiness.error.message
  if (readiness.state === 'ready') return 'The local execution policy check passed.'
  if (readiness.reason === 'account_required') return 'Connect a ChatGPT account before running a turn.'
  if (readiness.reason === 'login_in_progress') return 'Finish signing in before running a turn.'
  return 'The local Codex execution checks have not passed.'
}

function conversationContainsOperation(
  conversation: CodexSubscriptionConversationSnapshot,
  operationId: string,
): boolean {
  return (
    conversation.latestTurn?.operationId === operationId ||
    conversation.transcript.some((item) => item.turnOperationId === operationId)
  )
}

function turnStatusCopy(conversation: CodexSubscriptionConversationSnapshot): string {
  const turn = conversation.latestTurn
  if (!turn) return 'Ready for a Codex prompt.'
  if (!turn.terminal) {
    if (turn.state === 'interrupting') return 'Stop requested · waiting for the existing turn to end.'
    return turn.state === 'running' ? 'Codex is working…' : 'Starting this Codex turn…'
  }
  if (turn.state === 'uncertain') {
    return 'Prompt outcome unknown · checking the existing Codex conversation. It will not be sent again automatically.'
  }
  if (turn.state === 'interrupted') return 'Codex stopped.'
  if (turn.state === 'failed') return turn.error?.message ?? 'This Codex turn failed.'
  return 'Codex finished this turn.'
}

function createOperationId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `${prefix}-${uuid}`
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
}

function errorCopy(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function formatTime(value: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(parsed)
}
