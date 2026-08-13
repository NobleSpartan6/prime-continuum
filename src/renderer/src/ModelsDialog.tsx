import { AlertCircle, Bot, CheckCircle2, Copy, Info, Loader2, LockKeyhole, RefreshCw, Search, ShieldCheck, X, type LucideIcon } from 'lucide-react'
import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'

import {
  isStaleHostAuthorityError,
  type HostSummary,
  type RendererApi,
  type RuntimeModelCatalog,
  type RuntimeOAuthProgress,
  type RuntimeOAuthRequest,
  type RuntimeOAuthResult,
} from './api'

const MODEL_REVEAL_INCREMENT = 80
const PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID = 'openai-codex'
const CATALOG_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

function Icon({ icon: IconComponent, size = 16, strokeWidth = 1.75 }: { icon: LucideIcon; size?: number; strokeWidth?: number }) {
  return <IconComponent aria-hidden="true" focusable="false" size={size} strokeWidth={strokeWidth} />
}

function useMediaQueryMatch(mediaQuery: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(mediaQuery).matches : true,
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(mediaQuery)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [mediaQuery])

  return matches
}

export interface ModelsDialogProps {
  api: RendererApi
  open: boolean
  host: HostSummary
  threadId?: string
  executionGenerationId?: string
  currentModel?: string
  canSelectResidentModel: boolean
  canConnectRuntimeOAuth: boolean
  triggerRef: RefObject<HTMLElement | null>
  onClose: () => void
}

type ModelsCatalogError = {
  kind: 'retryable' | 'stale-authority'
  message: string
}

type ModelSelectionView = {
  providerId: string
  modelId: string
  modelName: string
  state: 'selecting' | 'completed' | 'rejected' | 'uncertain'
  message: string
  projected?: boolean
  retryable?: boolean
}

type RuntimeOAuthView = {
  providerId: string
  providerName: string
  state: RuntimeOAuthProgress['phase'] | RuntimeOAuthResult['state']
  message: string
  retryable?: boolean
}

export default function ModelsDialog({
  api,
  open,
  host,
  threadId,
  executionGenerationId,
  currentModel,
  canSelectResidentModel,
  canConnectRuntimeOAuth,
  onClose,
}: ModelsDialogProps) {
  const [catalog, setCatalog] = useState<RuntimeModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<ModelsCatalogError | null>(null)
  const [selection, setSelection] = useState<ModelSelectionView | null>(null)
  const [oauth, setOAuth] = useState<RuntimeOAuthView | null>(null)
  const [query, setQuery] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState('all')
  const [showAllProviders, setShowAllProviders] = useState(false)
  const [showAllModels, setShowAllModels] = useState(false)
  const [visibleModelLimit, setVisibleModelLimit] = useState(MODEL_REVEAL_INCREMENT)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [providerLoginCopyState, setProviderLoginCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const providerNavRef = useRef<HTMLDivElement>(null)
  const contentRootRef = useRef<HTMLDivElement>(null)
  const completedSelectionActionRef = useRef<HTMLButtonElement>(null)
  const selectionRequestRef = useRef(0)
  const oauthRequestRef = useRef(0)
  const activeOAuthRequestRef = useRef<RuntimeOAuthRequest | null>(null)
  const refreshProviderIdRef = useRef<string | undefined>(undefined)
  const dialogOpenRef = useRef(open)
  const selectionAuthorityKey = JSON.stringify([host.id, threadId ?? '', executionGenerationId ?? ''])
  const oauthAuthorityKey = JSON.stringify([host.id])
  const selectionAuthorityRef = useRef(selectionAuthorityKey)
  const oauthAuthorityRef = useRef(oauthAuthorityKey)
  const providerRailHorizontal = useMediaQueryMatch('(max-width: 50rem)')

  useLayoutEffect(() => {
    dialogOpenRef.current = open
    selectionAuthorityRef.current = selectionAuthorityKey
    oauthAuthorityRef.current = oauthAuthorityKey
  }, [oauthAuthorityKey, open, selectionAuthorityKey])

  useEffect(() => {
    if (!open) return
    window.requestAnimationFrame(() => {
      contentRootRef.current?.querySelector<HTMLElement>('[data-dialog-autofocus]')?.focus()
    })
  }, [open])

  useEffect(() => {
    selectionRequestRef.current += 1
    setSelection(null)
  }, [open, selectionAuthorityKey])

  useEffect(() => {
    oauthRequestRef.current += 1
    const oauthRequest = activeOAuthRequestRef.current
    activeOAuthRequestRef.current = null
    setOAuth(null)
    if (oauthRequest && api.cancelRuntimeOAuth) void api.cancelRuntimeOAuth(oauthRequest)
  }, [api, oauthAuthorityKey, open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setCatalog(null)
    setQuery('')
    setSelectedProviderId('all')
    setShowAllProviders(false)
    setShowAllModels(false)
    setVisibleModelLimit(MODEL_REVEAL_INCREMENT)
    setProviderLoginCopyState('idle')
    void api.loadRuntimeModelCatalog(host.id)
      .then((nextCatalog) => {
        if (!cancelled) {
          setCatalog(nextCatalog)
          const refreshProviderId = refreshProviderIdRef.current
          refreshProviderIdRef.current = undefined
          const chatGptProvider = nextCatalog.providers.find((provider) =>
            provider.providerId === PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID && provider.oauthSupported,
          )
          // Sol setup should open on the one provider this desktop can connect
          // safely even when an unrelated runtime provider is already ready.
          setSelectedProviderId(
            refreshProviderId && nextCatalog.providers.some((provider) => provider.providerId === refreshProviderId)
              ? refreshProviderId
              : chatGptProvider && !chatGptProvider.configured
                ? chatGptProvider.providerId
                : 'all',
          )
        }
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        refreshProviderIdRef.current = undefined
        setCatalog(null)
        setError(
          isStaleHostAuthorityError(reason)
            ? {
                kind: 'stale-authority',
                message: 'The active host changed. Close this dialog, confirm the active computer, then reopen Models & accounts.',
              }
            : {
                kind: 'retryable',
                message: reason instanceof Error
                  ? reason.message
                  : `Unable to read the runtime model catalog from ${host.name}. Check the host connection, then try again.`,
              },
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, host.id, host.name, loadAttempt, open])

  const deferredQuery = useDeferredValue(query)
  const providerById = useMemo(
    () => new Map(catalog?.providers.map((provider) => [provider.providerId, provider]) ?? []),
    [catalog],
  )
  const selectedProvider = providerById.get(selectedProviderId)
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase()
  const filteredModels = useMemo(() => {
    if (!catalog) return []
    return catalog.models.filter((model) => {
      if (selectedProviderId !== 'all' && model.providerId !== selectedProviderId) return false
      if (!showAllModels && !model.available) return false
      if (!normalizedQuery) return true
      const provider = providerById.get(model.providerId)
      return `${model.name} ${model.modelId} ${model.providerId} ${provider?.displayName ?? ''}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    }).sort((left, right) => {
      const leftCurrent = modelMatchesCurrent(left.providerId, left.modelId, left.name, currentModel)
      const rightCurrent = modelMatchesCurrent(right.providerId, right.modelId, right.name, currentModel)
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1
      const leftIsSol = left.providerId === PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID && left.modelId === 'gpt-5.6-sol'
      const rightIsSol = right.providerId === PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID && right.modelId === 'gpt-5.6-sol'
      if (leftIsSol !== rightIsSol) return leftIsSol ? -1 : 1
      if (left.available !== right.available) return left.available ? -1 : 1
      return left.name.localeCompare(right.name)
    })
  }, [catalog, currentModel, normalizedQuery, providerById, selectedProviderId, showAllModels])
  const visibleModels = filteredModels.slice(0, visibleModelLimit)
  const remainingModelCount = Math.max(0, filteredModels.length - visibleModels.length)
  const availableCount = catalog?.models.filter((model) => model.available).length ?? 0
  const scopedModelCount = selectedProvider?.modelCount ?? catalog?.models.length ?? 0
  const scopedAvailableCount = selectedProvider?.availableModelCount ?? availableCount
  const oauthProviders = catalog?.providers.filter((provider) => provider.oauthSupported) ?? []
  const configuredProviders = catalog?.providers.filter((provider) => provider.configured) ?? []
  const chatGptProvider = catalog?.providers.find((provider) =>
    provider.providerId === PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID && provider.oauthSupported,
  )
  const guidedFirstRun = Boolean(chatGptProvider && !chatGptProvider.configured)
  const providerCatalogExpanded = !guidedFirstRun || showAllProviders
  const visibleProviders = catalog
    ? providerCatalogExpanded
      ? catalog.providers
      : chatGptProvider ? [chatGptProvider] : []
    : []
  const providerIds = catalog
    ? [...(providerCatalogExpanded ? ['all'] : []), ...visibleProviders.map((provider) => provider.providerId)]
    : []
  const guidedSetupPending = Boolean(
    guidedFirstRun &&
    selectedProvider?.providerId === PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID &&
    !selectedProvider.configured,
  )
  const selectionMatchesCurrentModel = Boolean(
    selection && modelMatchesCurrent(selection.providerId, selection.modelId, selection.modelName, currentModel),
  )
  const selectionCompletedOnHost = Boolean(
    selection?.state === 'completed' && !selectionMatchesCurrentModel,
  )
  const selectionLocksActions = Boolean(
    selection?.state === 'selecting'
      || selection?.state === 'uncertain'
      || (selection?.state === 'completed' && !selectionMatchesCurrentModel),
  )

  useLayoutEffect(() => {
    if (!selectionCompletedOnHost) return
    const activeElement = document.activeElement
    if (activeElement && activeElement !== document.body && activeElement.isConnected) return
    completedSelectionActionRef.current?.focus()
  }, [selectionCompletedOnHost])
  const selectionStatusMessage = !selection
    ? ''
    : selection.state === 'selecting'
      ? `Selecting ${selection.modelName} for this thread's next prompt…`
      : selection.state === 'completed'
        ? selectionMatchesCurrentModel
          ? `${selection.message} ${selection.modelName} is now shown as current for this thread.`
          : `${selection.modelName} is selected on Prime Agent. The next thread refresh will update the current-model label; Continuim will not resend the selection.`
        : ''
  const selectionErrorMessage = !selection
    ? ''
    : selection.state === 'uncertain'
      ? `${selection.message} The outcome is unknown. Continuim will not send this model change again automatically. Do not retry it from this dialog; close Models & accounts and inspect the current thread first.`
      : selection.state === 'rejected'
        ? `${selection.message} No model change was applied.${selection.retryable ? ' You can choose a model again.' : ' This request cannot be retried.'}`
        : ''
  const oauthInProgress = Boolean(
    oauth && ['starting', 'awaiting_user', 'committing', 'cancelling'].includes(oauth.state),
  )
  const oauthLocksConnect = Boolean(
    oauthInProgress || oauth?.state === 'uncertain' || oauth?.state === 'completed' || (oauth?.state === 'failed' && !oauth.retryable),
  )
  const selectedProviderCanConnect = Boolean(
    selectedProvider &&
    selectedProvider.providerId === PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID &&
    selectedProvider.oauthSupported &&
    !selectedProvider.configured &&
    canConnectRuntimeOAuth &&
    api.startRuntimeOAuth &&
    api.cancelRuntimeOAuth,
  )
  const oauthStatusMessage = oauth && ['starting', 'awaiting_user', 'committing', 'cancelling', 'completed', 'cancelled'].includes(oauth.state)
    ? oauth.message
    : ''
  const oauthErrorMessage = oauth?.state === 'failed'
    ? `${oauth.message}${oauth.retryable ? ' You can start sign-in again.' : ''}`
    : oauth?.state === 'uncertain'
      ? `${oauth.message} Do not start another sign-in from this dialog. Close it and inspect the Prime Agent account on this computer first.`
      : ''

  const selectProvider = (providerId: string) => {
    setSelectedProviderId(providerId)
    setProviderLoginCopyState('idle')
    setVisibleModelLimit(MODEL_REVEAL_INCREMENT)
  }

  const copyProviderSetupSteps = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable')
      const providerName = selectedProvider?.displayName ?? 'the provider'
      await navigator.clipboard.writeText(
        `In Prime Agent on ${host.name}, run /login, choose ${providerName}, complete sign-in, then return to Prime Continuim and select Refresh accounts.`,
      )
      setProviderLoginCopyState('copied')
    } catch {
      setProviderLoginCopyState('error')
    }
  }

  const refreshProviderAccounts = () => {
    refreshProviderIdRef.current = selectedProviderId
    setProviderLoginCopyState('idle')
    setLoadAttempt((attempt) => attempt + 1)
  }

  const toggleProviderCatalog = () => {
    if (showAllProviders && chatGptProvider) selectProvider(chatGptProvider.providerId)
    setShowAllProviders((current) => !current)
  }

  const handleProviderKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const previousKey = providerRailHorizontal
      ? document.documentElement.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
      : 'ArrowUp'
    const nextKey = providerRailHorizontal
      ? document.documentElement.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
      : 'ArrowDown'
    if (![previousKey, nextKey, 'Home', 'End'].includes(event.key)) return

    const buttons = Array.from(providerNavRef.current?.querySelectorAll<HTMLButtonElement>('[data-provider-filter]') ?? [])
    if (buttons.length === 0) return
    event.preventDefault()
    const focusedIndex = buttons.indexOf(event.target as HTMLButtonElement)
    const selectedIndex = Math.max(0, providerIds.indexOf(selectedProviderId))
    const currentIndex = focusedIndex >= 0 ? focusedIndex : selectedIndex
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : event.key === nextKey
          ? (currentIndex + 1) % buttons.length
          : (currentIndex - 1 + buttons.length) % buttons.length
    const nextButton = buttons[nextIndex]
    const nextProviderId = providerIds[nextIndex]
    if (!nextButton || !nextProviderId) return
    selectProvider(nextProviderId)
    nextButton.focus()
  }

  const selectModel = async (model: RuntimeModelCatalog['models'][number]) => {
    if (
      !open
      || !threadId
      || !canSelectResidentModel
      || selectionLocksActions
      || !model.available
      || modelMatchesCurrent(model.providerId, model.modelId, model.name, currentModel)
    ) return

    const requestId = selectionRequestRef.current + 1
    selectionRequestRef.current = requestId
    const requestAuthorityKey = selectionAuthorityKey
    const target = {
      providerId: model.providerId,
      modelId: model.modelId,
      modelName: model.name,
    }
    setSelection({
      ...target,
      state: 'selecting',
      message: `Selecting ${model.name} for the next prompt.`,
    })

    try {
      const result = await api.selectResidentModel({
        threadId,
        providerId: model.providerId,
        modelId: model.modelId,
      })
      if (
        !dialogOpenRef.current
        || selectionRequestRef.current !== requestId
        || selectionAuthorityRef.current !== requestAuthorityKey
      ) return
      setSelection({ ...target, ...result })
    } catch (reason: unknown) {
      if (
        !dialogOpenRef.current
        || selectionRequestRef.current !== requestId
        || selectionAuthorityRef.current !== requestAuthorityKey
      ) return
      setSelection(
        isStaleHostAuthorityError(reason)
          ? {
              ...target,
              state: 'rejected',
              retryable: false,
              message: 'The active host or thread changed before this selection could be verified.',
            }
          : {
              ...target,
              state: 'uncertain',
              retryable: false,
              message: reason instanceof Error
                ? reason.message
                : 'The model selection response could not be verified.',
            },
      )
    }
  }

  const startProviderOAuth = async () => {
    if (
      !open ||
      !selectedProviderCanConnect ||
      oauthLocksConnect ||
      !selectedProvider ||
      !api.startRuntimeOAuth
    ) return

    const request: RuntimeOAuthRequest = {
      hostId: host.id,
      providerId: selectedProvider.providerId,
    }
    const requestId = oauthRequestRef.current + 1
    oauthRequestRef.current = requestId
    activeOAuthRequestRef.current = request
    const requestAuthorityKey = oauthAuthorityKey
    const providerName = selectedProvider.displayName
    setOAuth({
      providerId: request.providerId,
      providerName,
      state: 'starting',
      message: 'Opening the verified ChatGPT sign-in page…',
    })

    try {
      const result = await api.startRuntimeOAuth(request, (progress) => {
        if (
          !dialogOpenRef.current ||
          oauthRequestRef.current !== requestId ||
          oauthAuthorityRef.current !== requestAuthorityKey
        ) return
        setOAuth({
          providerId: request.providerId,
          providerName,
          state: progress.phase,
          message: progress.message,
        })
      })
      if (
        !dialogOpenRef.current ||
        oauthRequestRef.current !== requestId ||
        oauthAuthorityRef.current !== requestAuthorityKey
      ) return
      if (result.state === 'completed' && result.catalog) setCatalog(result.catalog)
      setOAuth({
        providerId: request.providerId,
        providerName,
        state: result.state,
        message: result.message,
        ...('retryable' in result ? { retryable: result.retryable } : {}),
      })
    } catch (reason: unknown) {
      if (
        !dialogOpenRef.current ||
        oauthRequestRef.current !== requestId ||
        oauthAuthorityRef.current !== requestAuthorityKey
      ) return
      setOAuth({
        providerId: request.providerId,
        providerName,
        state: isStaleHostAuthorityError(reason) ? 'failed' : 'uncertain',
        retryable: false,
        message: isStaleHostAuthorityError(reason)
          ? 'The active computer connection changed before sign-in could start.'
          : 'Prime Agent sign-in could not be verified. Prime Continuim will not start it again automatically.',
      })
    } finally {
      if (oauthRequestRef.current === requestId) activeOAuthRequestRef.current = null
    }
  }

  const cancelProviderOAuth = async () => {
    const request = activeOAuthRequestRef.current
    if (!request || !api.cancelRuntimeOAuth || !oauthInProgress) return
    setOAuth((current) => current ? {
      ...current,
      state: 'cancelling',
      message: 'Cancelling ChatGPT sign-in…',
    } : current)
    await api.cancelRuntimeOAuth(request)
  }

  const closeDialog = () => {
    selectionRequestRef.current += 1
    oauthRequestRef.current += 1
    const oauthRequest = activeOAuthRequestRef.current
    activeOAuthRequestRef.current = null
    if (oauthRequest && api.cancelRuntimeOAuth) void api.cancelRuntimeOAuth(oauthRequest)
    onClose()
  }

  return (
    <div ref={contentRootRef} className="sheet__surface models-sheet__surface">
        <header className="sheet__header models-sheet__header">
          <div className="sheet__title-group">
            <span className="sheet__title-icon"><Icon icon={Bot} size={18} /></span>
            <div>
              <h2 id="models-title">Models &amp; accounts</h2>
              <p id="models-description">
                Choose the model for this thread on <bdi>{host.name}</bdi>.
              </p>
            </div>
          </div>
          <button data-dialog-autofocus className="icon-button" type="button" aria-label="Close models and accounts" onClick={closeDialog}>
            <Icon icon={X} size={17} />
          </button>
        </header>

        {loading ? (
          <div className="models-loading" role="status">
            <Icon icon={Loader2} size={18} />
            <div><strong>Reading the runtime catalog</strong><span>Provider status and model metadata stay scoped to {host.name}.</span></div>
          </div>
        ) : error ? (
          <div className="models-error" role="alert">
            <span><Icon icon={AlertCircle} size={17} /></span>
            <div>
              <strong>Model catalog unavailable</strong>
              <p>{error.message}</p>
              {error.kind === 'retryable' ? (
                <button className="button button--secondary" type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                  <Icon icon={RefreshCw} size={14} />
                  Retry loading catalog
                </button>
              ) : (
                <button className="button button--secondary" type="button" onClick={closeDialog}>Close dialog</button>
              )}
            </div>
          </div>
        ) : catalog ? (
          <div className="models-workspace">
            <aside className={cx('provider-rail', guidedFirstRun && !showAllProviders && 'provider-rail--guided')} aria-label={`Accounts on ${host.name}`}>
              <div className="provider-rail__summary">
                <span className="eyebrow">Accounts</span>
                <strong>{guidedFirstRun ? 'ChatGPT setup recommended' : `${configuredProviders.length} configured`}</strong>
                <small>{guidedFirstRun
                  ? `Set up GPT-5.6 Sol for native RLM · Prime Agent ${catalog.releaseVersion}`
                  : `${oauthProviders.length} support OAuth`}</small>
                {guidedFirstRun && (
                  <button
                    className="provider-rail__disclosure"
                    type="button"
                    aria-expanded={showAllProviders}
                    aria-controls="provider-filter-list"
                    onClick={toggleProviderCatalog}
                  >
                    {showAllProviders ? 'Show recommended provider' : `Browse all ${catalog.providers.length} providers`}
                  </button>
                )}
              </div>
              <p className="sr-only" id="provider-filter-instructions">
                {providerRailHorizontal
                  ? 'Use Left and Right Arrow keys to select a provider. Use Home and End to jump to the first or last provider.'
                  : 'Use Up and Down Arrow keys to select a provider. Use Home and End to jump to the first or last provider.'}
              </p>
              <div
                className="provider-rail__toolbar"
                id="provider-filter-list"
                ref={providerNavRef}
                hidden={!providerCatalogExpanded}
                aria-describedby="provider-filter-instructions"
                aria-label="Filter models by provider"
                aria-orientation={providerRailHorizontal ? 'horizontal' : 'vertical'}
                role="toolbar"
                onKeyDown={handleProviderKeyDown}
              >
                {providerCatalogExpanded && (
                  <button
                    type="button"
                    aria-pressed={selectedProviderId === 'all'}
                    data-provider-filter
                    data-provider-id="all"
                    tabIndex={selectedProviderId === 'all' ? 0 : -1}
                    onClick={() => selectProvider('all')}
                  >
                    <span className="provider-rail__icon"><Icon icon={Bot} size={15} /></span>
                    <span><strong>All providers</strong><small>{catalog.providers.length} in catalog</small></span>
                    <span className="provider-rail__count tabular">{catalog.models.length}</span>
                  </button>
                )}
                {visibleProviders.map((provider) => (
                  <button
                    key={provider.providerId}
                    type="button"
                    aria-pressed={selectedProviderId === provider.providerId}
                    data-provider-filter
                    data-provider-id={provider.providerId}
                    tabIndex={selectedProviderId === provider.providerId ? 0 : -1}
                    onClick={() => selectProvider(provider.providerId)}
                  >
                    <span className={cx('provider-rail__icon', provider.configured && 'provider-rail__icon--ready')}>
                      <Icon icon={provider.configured ? CheckCircle2 : LockKeyhole} size={15} />
                    </span>
                    <span><strong>{provider.displayName}</strong><small>{provider.configured ? 'Configured' : provider.oauthSupported ? 'Supports OAuth' : 'Setup required'}</small></span>
                    <span className="provider-rail__count tabular">{provider.availableModelCount}/{provider.modelCount}</span>
                  </button>
                ))}
              </div>
            </aside>

            <section className="model-catalog" aria-label="Prime Agent models">
              <div className="model-catalog__topline">
                <div>
                  <span className="eyebrow">Runtime catalog</span>
                  <h3>{selectedProvider?.displayName ?? 'Models reported by this host'}</h3>
                  <p>{scopedAvailableCount} available with current setup · {scopedModelCount} listed by the runtime</p>
                </div>
                <span className="catalog-freshness"><span aria-hidden="true" /> Updated {formatCatalogTime(catalog.observedAt)}</span>
              </div>

              {selectedProvider && !selectedProvider.configured && (
                <div
                  className="provider-setup-note"
                  aria-busy={oauthInProgress && oauth?.providerId === selectedProvider.providerId ? 'true' : undefined}
                >
                  <span><Icon icon={LockKeyhole} size={16} /></span>
                  <div className="provider-setup-note__body">
                    <strong>{selectedProviderCanConnect ? 'Connect ChatGPT' : 'Sign in with Prime Agent'}</strong>
                    {selectedProviderCanConnect ? (
                      <>
                        <p>
                          Connect ChatGPT on <bdi>{host.name}</bdi>. Sign-in opens in your browser; this view never receives the authorization URL or credential.
                        </p>
                        <div className="provider-setup-note__actions">
                          <button
                            className="button button--secondary"
                            type="button"
                            disabled={oauthLocksConnect}
                            onClick={() => void startProviderOAuth()}
                          >
                            <Icon icon={oauthInProgress ? Loader2 : ShieldCheck} size={14} />
                            {oauthInProgress ? 'Signing in…' : 'Connect ChatGPT'}
                          </button>
                        </div>
                        <details className="provider-setup-note__storage">
                          <summary>Credential storage</summary>
                          <p>
                            Prime Agent {catalog.releaseVersion} stores OAuth credentials as plaintext in host-only <code>auth.json</code>, protected by this operating-system account’s file permissions. Account availability is refreshed before model selection; this is not keychain or keyring storage.
                          </p>
                        </details>
                      </>
                    ) : (
                      <>
                        <p>
                          Run <code>/login</code> in Prime Agent on <bdi>{host.name}</bdi>, then refresh accounts here. Credentials stay on that computer.
                        </p>
                        <div className="provider-setup-note__actions">
                          <button className="button button--secondary" type="button" onClick={() => void copyProviderSetupSteps()}>
                            <Icon icon={providerLoginCopyState === 'copied' ? CheckCircle2 : Copy} size={14} />
                            {providerLoginCopyState === 'copied' ? 'Copied setup steps' : 'Copy setup steps'}
                          </button>
                          <button className="button button--quiet" type="button" onClick={refreshProviderAccounts}>
                            <Icon icon={RefreshCw} size={14} />
                            Refresh accounts
                          </button>
                        </div>
                        <p
                          className={cx('provider-setup-note__feedback', providerLoginCopyState !== 'error' && 'sr-only')}
                          role="status"
                          aria-live="polite"
                          aria-atomic="true"
                        >
                          {providerLoginCopyState === 'copied'
                            ? 'Copied provider setup steps.'
                            : providerLoginCopyState === 'error'
                              ? <>Copy unavailable. Enter <code>/login</code> in Prime Agent.</>
                              : ''}
                        </p>
                      </>
                    )}
                  </div>
                </div>
              )}

              <div className={cx('runtime-oauth-feedback', !oauth && 'runtime-oauth-feedback--empty')} aria-busy={oauthInProgress ? 'true' : undefined}>
                <p
                  className={cx('runtime-oauth-feedback__message', !oauthStatusMessage && 'sr-only')}
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {oauthStatusMessage && <Icon icon={oauth?.state === 'completed' ? CheckCircle2 : Loader2} size={14} />}
                  {oauthStatusMessage}
                </p>
                <p
                  className={cx('runtime-oauth-feedback__message', 'runtime-oauth-feedback__message--error', !oauthErrorMessage && 'sr-only')}
                  role="alert"
                >
                  {oauthErrorMessage && <Icon icon={AlertCircle} size={14} />}
                  {oauthErrorMessage}
                </p>
                {oauthInProgress && api.cancelRuntimeOAuth && (
                  <button className="button button--quiet" type="button" onClick={() => void cancelProviderOAuth()} disabled={oauth?.state === 'cancelling'}>
                    {oauth?.state === 'cancelling' ? 'Cancelling…' : 'Cancel sign-in'}
                  </button>
                )}
              </div>

              {!guidedSetupPending && <><div className="model-catalog__controls">
                <label className="model-search">
                  <span className="sr-only">Search models</span>
                  <Icon icon={Search} size={15} />
                  <input
                    type="search"
                    value={query}
                    placeholder="Search models"
                    onChange={(event) => {
                      setQuery(event.target.value)
                      setVisibleModelLimit(MODEL_REVEAL_INCREMENT)
                    }}
                  />
                </label>
                <div className="catalog-scope" aria-label="Model availability filter">
                  <button
                    type="button"
                    aria-pressed={!showAllModels}
                    onClick={() => {
                      setShowAllModels(false)
                      setVisibleModelLimit(MODEL_REVEAL_INCREMENT)
                    }}
                  >Available</button>
                  <button
                    type="button"
                    aria-pressed={showAllModels}
                    onClick={() => {
                      setShowAllModels(true)
                      setVisibleModelLimit(MODEL_REVEAL_INCREMENT)
                    }}
                  >All models</button>
                </div>
              </div>

              <p className="model-results-count tabular" role="status" aria-live="polite" aria-atomic="true">
                {filteredModels.length === 0
                  ? 'No models match'
                  : `Showing ${visibleModels.length} of ${filteredModels.length} ${filteredModels.length === 1 ? 'model' : 'models'}`}
              </p>

              <div className="model-list" aria-busy={query !== deferredQuery ? 'true' : undefined}>
                {visibleModels.length > 0 ? visibleModels.map((model) => {
                  const provider = providerById.get(model.providerId)
                  const current = modelMatchesCurrent(model.providerId, model.modelId, model.name, currentModel)
                  const selectionTargeted = selection?.providerId === model.providerId && selection.modelId === model.modelId
                  const selectingTarget = selectionTargeted && selection?.state === 'selecting'
                  const completedTarget = selectionTargeted && selectionCompletedOnHost
                  const rejectedWithoutRetry = selectionTargeted && selection?.state === 'rejected' && !selection.retryable
                  const rlmRecommended = model.providerId === PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID && model.modelId === 'gpt-5.6-sol'
                  const selectionButtonLabel = selectingTarget ? 'Selecting…' : 'Use model'
                  const showSelectionAction = model.available && !current && canSelectResidentModel && !completedTarget
                  const showAvailabilityStatus = !model.available || (!canSelectResidentModel && !current)
                  return (
                    <article className={cx('model-row', current && 'model-row--current', completedTarget && 'model-row--selected')} key={`${model.providerId}:${model.modelId}`}>
                      <div className="model-row__body">
                        <div className="model-row__title">
                          <strong>{model.name}</strong>
                          {current && <span className="model-badge model-badge--current">Current</span>}
                          {completedTarget && <span className="model-badge model-badge--selected">Selected on host</span>}
                          {rlmRecommended && <span className="model-badge model-badge--recommended">RLM recommended</span>}
                          {model.usingOAuth && <span className="model-badge">OAuth</span>}
                        </div>
                        <span><bdi>{provider?.displayName ?? model.providerId}</bdi> · <bdi>{model.modelId}</bdi></span>
                        <small>{formatTokenCapacity(model.contextWindow)} context · {formatTokenCapacity(model.maxOutputTokens)} max output{model.reasoning ? ' · Reasoning' : ''}{model.input.includes('image') ? ' · Images' : ''}</small>
                      </div>
                      {(showAvailabilityStatus || showSelectionAction) && <div className="model-row__actions">
                        {showAvailabilityStatus && <span className={cx('model-row__status', model.available && 'model-row__status--ready')}>
                          <Icon icon={model.available ? CheckCircle2 : LockKeyhole} size={14} />
                          {model.available ? 'Available' : 'Setup required'}
                        </span>}
                        {showSelectionAction && (
                          <button
                            className="button button--secondary model-row__select"
                            type="button"
                            aria-label={`${selectionButtonLabel.replace('…', '')} ${model.name}`}
                            disabled={selectionLocksActions || rejectedWithoutRetry}
                            onClick={() => void selectModel(model)}
                          >
                            {selectingTarget && <Icon icon={Loader2} size={14} />}
                            {selectionButtonLabel}
                          </button>
                        )}
                      </div>}
                    </article>
                  )
                }) : (
                  <div className="model-list__empty">
                    <Icon icon={Search} size={18} />
                    <strong>{showAllModels ? 'No catalog models match' : 'No available models match'}</strong>
                    <p>{showAllModels ? 'Try another provider or search term.' : `Configure a provider on ${host.name}, or show all models.`}</p>
                  </div>
                )}
              </div>
              {remainingModelCount > 0 && (
                <div className="model-list__reveal">
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => setVisibleModelLimit((limit) => limit + MODEL_REVEAL_INCREMENT)}
                  >
                    Show {Math.min(MODEL_REVEAL_INCREMENT, remainingModelCount)} more {Math.min(MODEL_REVEAL_INCREMENT, remainingModelCount) === 1 ? 'model' : 'models'}
                  </button>
                </div>
              )}
              <div className={cx('model-selection-feedback', selectionCompletedOnHost && 'model-selection-feedback--complete')}>
                <p
                  className={cx('model-selection-feedback__message', !selectionStatusMessage && 'sr-only')}
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {selectionStatusMessage && <Icon icon={selection?.state === 'completed' ? CheckCircle2 : Loader2} size={14} />}
                  {selectionStatusMessage}
                </p>
                <p
                  className={cx('model-selection-feedback__message', 'model-selection-feedback__message--error', !selectionErrorMessage && 'sr-only')}
                  role="alert"
                >
                  {selectionErrorMessage && <Icon icon={AlertCircle} size={14} />}
                  {selectionErrorMessage}
                </p>
                {selectionCompletedOnHost && (
                  <button ref={completedSelectionActionRef} className="button button--secondary" type="button" onClick={closeDialog}>
                    Done
                  </button>
                )}
              </div>
              <footer className="model-catalog__footer">
                <Icon icon={Info} size={14} />
                <span>
                  {canSelectResidentModel
                    ? 'Choose a model for this thread’s next prompt. This changes the resident session only; it does not send a prompt. “Available” means Prime Agent reports provider access, not that an inference smoke test passed.'
                    : 'Model selection is available only while this exact resident session is idle and ready for its next prompt. “Available” means Prime Agent reports provider access; no inference smoke test was run.'}
                </span>
              </footer></>}
            </section>
          </div>
        ) : null}
    </div>
  )
}

function modelMatchesCurrent(providerId: string, modelId: string, modelName: string, currentModel: string | undefined): boolean {
  if (!currentModel) return false
  const normalizedCurrentModel = currentModel.toLocaleLowerCase()
  return normalizedCurrentModel === modelId.toLocaleLowerCase()
    || normalizedCurrentModel === modelName.toLocaleLowerCase()
    || normalizedCurrentModel === `${providerId}/${modelId}`.toLocaleLowerCase()
    || normalizedCurrentModel === `${providerId}:${modelId}`.toLocaleLowerCase()
}

function formatTokenCapacity(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1))}M`
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1))}K`
  return String(value)
}

function formatCatalogTime(value: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return 'recently'
  return CATALOG_TIME_FORMATTER.format(new Date(parsed))
}
