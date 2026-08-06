import {
  Activity,
  AlertCircle,
  ArrowRight,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Command,
  Computer,
  Eye,
  FileCode2,
  FolderGit2,
  GitBranch,
  HardDrive,
  Inbox,
  Info,
  Laptop,
  ListChecks,
  Loader2,
  LockKeyhole,
  Menu,
  MessageSquare,
  Monitor,
  Network,
  PanelLeftClose,
  PanelRightClose,
  Paperclip,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Square,
  Terminal,
  TestTube2,
  Users,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  createRendererApi,
  isStaleHostAuthorityError,
  type ComposerReceiptState,
  type ConnectionState,
  type DiscoveredComputer,
  type HandoffPhase,
  type HandoffPlan,
  type HostSummary,
  type RendererApi,
  type TaskState,
  type ThreadSummary,
  type WorkbenchSnapshot,
} from './api'
import { FormEvent, KeyboardEvent, ReactNode, RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

const INSPECTOR_TABS = ['Changes', 'Agents', 'Evidence', 'Context'] as const
type InspectorTab = (typeof INSPECTOR_TABS)[number]
type WorkbenchSurface = 'desktop' | 'companion'

const HANDOFF_PHASES: Array<{ phase: HandoffPhase; label: string }> = [
  { phase: 'quiescing', label: 'Prepare source' },
  { phase: 'checkpointing', label: 'Create checkpoint' },
  { phase: 'transferring', label: 'Transfer state' },
  { phase: 'materializing', label: 'Create worktree' },
  { phase: 'verifying', label: 'Verify destination' },
  { phase: 'switching_authority', label: 'Switch authority' },
  { phase: 'complete', label: 'Complete' },
]

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

function Icon({ icon: IconComponent, size = 16, strokeWidth = 1.75 }: { icon: LucideIcon; size?: number; strokeWidth?: number }) {
  return <IconComponent aria-hidden="true" focusable="false" size={size} strokeWidth={strokeWidth} />
}

function taskLabel(status: TaskState): string {
  const labels: Record<TaskState, string> = {
    idle: 'Ready',
    running: 'Running',
    waiting: 'Waiting',
    needs_approval: 'Needs approval',
    complete: 'Complete',
    failed: 'Failed',
  }
  return labels[status]
}

function connectionCopy(connection: ConnectionState, host: HostSummary): string {
  if (connection === 'reconnecting') {
    return `Reconnecting… Last synchronized ${host.lastSynchronized ?? 'recently'}`
  }
  if (connection === 'offline') {
    return `Offline · Last synchronized ${host.lastSynchronized ?? 'recently'}`
  }
  return `Connected to ${host.name}`
}

function connectionLabel(connection: ConnectionState): string {
  const labels: Record<ConnectionState, string> = {
    online: 'Online',
    reconnecting: 'Reconnecting',
    offline: 'Offline',
  }
  return labels[connection]
}

function commandShortcutLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K'
  return /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
}

const DRAWER_FOCUSABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

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

function useResponsiveDrawerFocus({
  open,
  mediaQuery,
  panelRef,
  triggerRef,
  onClose,
}: {
  open: boolean
  mediaQuery: string
  panelRef: RefObject<HTMLElement | null>
  triggerRef: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const wasOverlayOpenRef = useRef(false)

  useEffect(() => {
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(mediaQuery) : null
    const isOverlay = media?.matches ?? true

    if (!open) {
      if (wasOverlayOpenRef.current) {
        window.requestAnimationFrame(() => triggerRef.current?.focus())
      }
      wasOverlayOpenRef.current = false
      return
    }

    if (!isOverlay) {
      wasOverlayOpenRef.current = false
      const closeIfEnteringOverlay = (event: MediaQueryListEvent) => {
        if (event.matches) onClose()
      }
      media?.addEventListener('change', closeIfEnteringOverlay)
      return () => media?.removeEventListener('change', closeIfEnteringOverlay)
    }

    wasOverlayOpenRef.current = true
    const panel = panelRef.current
    if (!panel) return

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!panel.contains(document.activeElement)) {
          panel.querySelector<HTMLElement>(DRAWER_FOCUSABLE)?.focus()
        }
      })
    })

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return
      const openNativeDialog = document.querySelector<HTMLDialogElement>('dialog[open]')
      if (openNativeDialog && !panel.contains(openNativeDialog)) return

      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE))
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault()
        first?.focus()
      }
    }
    const closeWhenLeavingOverlay = (event: MediaQueryListEvent) => {
      if (!event.matches) onClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    media?.addEventListener('change', closeWhenLeavingOverlay)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      media?.removeEventListener('change', closeWhenLeavingOverlay)
    }
  }, [mediaQuery, onClose, open, panelRef, triggerRef])
}

interface AppProps {
  api?: RendererApi
}

export default function App({ api: suppliedApi }: AppProps) {
  const api = useMemo(() => suppliedApi ?? createRendererApi(), [suppliedApi])
  const [surface, setSurface] = useState<WorkbenchSurface>(() =>
    new URLSearchParams(window.location.search).get('surface') === 'companion' ? 'companion' : 'desktop',
  )
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null)
  const [loadError, setLoadError] = useState('')
  const [threadSelectionError, setThreadSelectionError] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selectedThreadId, setSelectedThreadId] = useState('')
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('Changes')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [pairMobileOpen, setPairMobileOpen] = useState(false)
  const [addComputerOpen, setAddComputerOpen] = useState(false)
  const [moveThreadOpen, setMoveThreadOpen] = useState(false)
  const [moveDestinationId, setMoveDestinationId] = useState('')
  const [composerMode, setComposerMode] = useState<'follow_up' | 'steer'>('follow_up')
  const [composerText, setComposerText] = useState('')
  const [composerReceipt, setComposerReceipt] = useState<{ state: ComposerReceiptState; message: string }>({
    state: 'idle',
    message: '',
  })
  const addComputerTriggerRef = useRef<HTMLButtonElement>(null)
  const locationTriggerRef = useRef<HTMLSelectElement>(null)
  const moveThreadTriggerRef = useRef<HTMLElement>(null)
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const inspectorToggleRef = useRef<HTMLButtonElement>(null)
  const commandPaletteTriggerRef = useRef<HTMLButtonElement>(null)
  const pairMobileTriggerRef = useRef<HTMLButtonElement>(null)
  const companionReturnTargetRef = useRef<'mobile' | 'command' | null>(null)
  const sidebarPanelRef = useRef<HTMLElement>(null)
  const inspectorPanelRef = useRef<HTMLElement>(null)
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const closeInspector = useCallback(() => setInspectorOpen(false), [])
  const sidebarIsOverlay = useMediaQueryMatch('(max-width: 50rem)')
  const inspectorIsOverlay = useMediaQueryMatch('(max-width: 66rem)')
  const sidebarIsModal = sidebarOpen && sidebarIsOverlay
  const inspectorIsModal = inspectorOpen && inspectorIsOverlay

  const openCommandPalette = useCallback(() => {
    if (sidebarIsOverlay) setSidebarOpen(false)
    if (inspectorIsOverlay) setInspectorOpen(false)
    setCommandPaletteOpen(true)
  }, [inspectorIsOverlay, sidebarIsOverlay])

  const setWorkbenchSurface = useCallback((nextSurface: WorkbenchSurface) => {
    const url = new URL(window.location.href)
    if (nextSurface === 'companion') url.searchParams.set('surface', 'companion')
    else url.searchParams.delete('surface')
    window.history.replaceState({}, '', url)
    setSurface(nextSurface)
  }, [])

  const openCompanion = useCallback((returnTarget: 'mobile' | 'command') => {
    companionReturnTargetRef.current = returnTarget
    setWorkbenchSurface('companion')
  }, [setWorkbenchSurface])

  const exitCompanion = useCallback(() => {
    setWorkbenchSurface('desktop')
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const target = companionReturnTargetRef.current === 'command'
          ? commandPaletteTriggerRef.current
          : pairMobileTriggerRef.current
        target?.focus()
        companionReturnTargetRef.current = null
      })
    })
  }, [setWorkbenchSurface])

  useEffect(() => {
    const openPalette = (event: globalThis.KeyboardEvent) => {
      if (surface !== 'desktop' || event.defaultPrevented || event.repeat) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openCommandPalette()
      }
    }
    window.addEventListener('keydown', openPalette)
    return () => window.removeEventListener('keydown', openPalette)
  }, [openCommandPalette, surface])

  useResponsiveDrawerFocus({
    open: sidebarOpen,
    mediaQuery: '(max-width: 50rem)',
    panelRef: sidebarPanelRef,
    triggerRef: sidebarToggleRef,
    onClose: closeSidebar,
  })
  useResponsiveDrawerFocus({
    open: inspectorOpen,
    mediaQuery: '(max-width: 66rem)',
    panelRef: inspectorPanelRef,
    triggerRef: inspectorToggleRef,
    onClose: closeInspector,
  })
  const threadSelectionRequestRef = useRef(0)
  const activeHostIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setLoadError('')
    void api
      .loadWorkbench()
      .then((nextSnapshot) => {
        if (cancelled) return
        setSnapshot(nextSnapshot)
        setSelectedProjectId(nextSnapshot.selectedProjectId)
        setSelectedThreadId(nextSnapshot.selectedThreadId)
        setComposerReceipt({
          state: nextSnapshot.composerReceipt.state,
          message: nextSnapshot.composerReceipt.message ?? '',
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Unable to load the workbench.')
      })

    const unsubscribe = api.subscribe?.((nextSnapshot) => {
      if (!cancelled) {
        setSnapshot(nextSnapshot)
        setSelectedProjectId(nextSnapshot.selectedProjectId)
        setSelectedThreadId(nextSnapshot.selectedThreadId)
        setComposerReceipt({
          state: nextSnapshot.composerReceipt.state,
          message: nextSnapshot.composerReceipt.message ?? '',
        })
      }
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [api])

  const selectedThread = snapshot?.threads.find((thread) => thread.id === selectedThreadId) ?? snapshot?.threads[0]
  const selectedProject =
    snapshot?.projects.find((project) => project.id === selectedThread?.projectId) ??
    snapshot?.projects.find((project) => project.id === selectedProjectId) ??
    snapshot?.projects[0]
  const selectedHost = snapshot?.hosts.find((host) => host.id === selectedThread?.hostId) ?? snapshot?.hosts[0]
  activeHostIdRef.current = selectedHost?.id

  useEffect(() => {
    if (!selectedHost) return
    if (selectedHost.connection !== 'online') {
      setComposerReceipt((current) =>
        current.state === 'idle' ? { state: 'waiting_for_connection', message: 'Waiting for connection' } : current,
      )
      if (composerMode === 'steer') setComposerMode('follow_up')
    }
  }, [composerMode, selectedHost])

  const selectThread = (thread: ThreadSummary) => {
    const requestId = ++threadSelectionRequestRef.current
    setThreadSelectionError('')
    setSelectedThreadId(thread.id)
    setSelectedProjectId(thread.projectId)
    const host = snapshot?.hosts.find((candidate) => candidate.id === thread.hostId)
    setComposerReceipt(
      host?.connection === 'online'
        ? { state: 'idle', message: 'Ready to send' }
        : { state: 'waiting_for_connection', message: 'Waiting for connection' },
    )
    setSidebarOpen(false)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('#thread-heading')?.focus())
    })
    void api.selectThread(thread.id).catch((error: unknown) => {
      if (threadSelectionRequestRef.current !== requestId) return
      const detail = error instanceof Error ? error.message : 'The host did not return an authoritative snapshot.'
      setThreadSelectionError(`Couldn’t refresh ${thread.title}. ${detail}`)
    })
  }

  const selectProject = (projectId: string) => {
    setSelectedProjectId(projectId)
    const nextThread = snapshot?.threads.find((thread) => thread.projectId === projectId)
    if (nextThread) selectThread(nextThread)
  }

  const openMoveThread = (destinationHostId: string, trigger: HTMLElement | null = locationTriggerRef.current) => {
    if (!destinationHostId || destinationHostId === selectedHost?.id) return
    moveThreadTriggerRef.current = trigger
    if (sidebarIsOverlay) setSidebarOpen(false)
    if (inspectorIsOverlay) setInspectorOpen(false)
    setMoveDestinationId(destinationHostId)
    setMoveThreadOpen(true)
  }

  const finishMove = (destinationHostId: string, destinationName: string) => {
    if (!selectedThread) return
    setSnapshot((current) => {
      if (!current) return current
      return {
        ...current,
        threads: current.threads.map((thread) =>
          thread.id === selectedThread.id
            ? {
                ...thread,
                hostId: destinationHostId,
                transcript: [
                  ...thread.transcript,
                  {
                    id: `move-${Date.now()}`,
                    kind: 'checkpoint' as const,
                    time: 'Now',
                    body: `Moved from ${selectedHost?.name ?? 'the source'} to ${destinationName}.`,
                    detail: 'Runtime-local Python state restarted · thread history, project state, goals, and durable resources preserved',
                  },
                ],
              }
            : thread,
        ),
      }
    })
  }

  const submitComposer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!snapshot || !selectedThread || !selectedHost) return
    const text = composerText.trim()
    if (!text) {
      setComposerReceipt({ state: 'rejected', message: 'Write a message before sending.' })
      return
    }
    if (composerMode === 'steer' && selectedHost.connection !== 'online') {
      setComposerReceipt({ state: 'rejected', message: `Reconnect to ${selectedHost.name} before steering this turn.` })
      return
    }

    const sendWhenReconnected = selectedHost.connection !== 'online'
    const submissionHostId = selectedHost.id
    setComposerReceipt({
      state: sendWhenReconnected ? 'waiting_for_connection' : 'sending',
      message: sendWhenReconnected ? 'Saving to this device’s outbox…' : `Sending to ${selectedHost.name}…`,
    })

    try {
      const receipt = await api.sendComposer({
        threadId: selectedThread.id,
        text,
        intent: composerMode,
        sendWhenReconnected,
      })
      if (activeHostIdRef.current !== submissionHostId) return
      setComposerReceipt(receipt)
      setComposerText('')
      setSnapshot((current) => {
        if (!current) return current
        return {
          ...current,
          threads: current.threads.map((thread) =>
            thread.id === selectedThread.id && thread.hostId === submissionHostId
              ? {
                  ...thread,
                  transcript: [
                    ...thread.transcript,
                    {
                      id: `local-${Date.now()}`,
                      kind: 'user' as const,
                      author: 'You',
                      time: 'Now',
                      body: text,
                      detail: receipt.message,
                    },
                  ],
                }
              : thread,
          ),
        }
      })
    } catch (error) {
      if (isStaleHostAuthorityError(error) || activeHostIdRef.current !== submissionHostId) return
      setComposerReceipt({
        state: 'uncertain',
        message: error instanceof Error ? `${error.message} Reconciling by command ID.` : 'Receipt uncertain. Reconciling by command ID.',
      })
    }
  }

  if (loadError) {
    return (
      <div className="load-state" role="alert">
        <div className="load-state__icon"><Icon icon={AlertCircle} size={22} /></div>
        <h1>Unable to open the workbench</h1>
        <p>{loadError}</p>
        <button className="button button--secondary" onClick={() => window.location.reload()}>
          <Icon icon={RefreshCw} /> Retry loading
        </button>
      </div>
    )
  }

  if (!snapshot) {
    return (
      <div className="load-state" role="status" aria-live="polite">
        <Icon icon={Loader2} size={22} />
        <p>Opening your cached workbench…</p>
      </div>
    )
  }

  if (!selectedThread || !selectedProject || !selectedHost) {
    return (
      <div className="empty-workbench">
        <header className="empty-workbench__topbar">
          <div className="brand-mark" aria-hidden="true"><Icon icon={Sparkles} size={17} strokeWidth={2} /></div>
          <strong>Prime Agent</strong>
        </header>
        <main className="empty-workbench__main" id="main">
          <span className="empty-workbench__icon"><Icon icon={Inbox} size={22} /></span>
          <h1>{snapshot.projects.length > 0 ? 'No threads yet' : 'No projects yet'}</h1>
          <p>
            {snapshot.projects.length > 0
              ? 'Start a thread after the host finishes loading this project catalog.'
              : 'Add an SSH computer, or connect the local host service, to open projects and start durable threads.'}
          </p>
          <button ref={addComputerTriggerRef} className="button button--primary" type="button" onClick={() => setAddComputerOpen(true)}>
            <Icon icon={Computer} /> Add computer
          </button>
          <small>No sample projects or threads are added in the native app.</small>
        </main>
        <AddComputerDialog
          api={api}
          open={addComputerOpen}
          onClose={() => setAddComputerOpen(false)}
          triggerRef={addComputerTriggerRef}
        />
      </div>
    )
  }

  const compatibleHosts = snapshot.hosts.filter((host) => selectedProject.hostIds.includes(host.id))
  const isDisconnected = selectedHost.connection !== 'online'

  if (surface === 'companion') {
    return (
      <CompanionPreview
        environment={api.environment}
        snapshot={snapshot}
        selectedThread={selectedThread}
        selectedProject={selectedProject}
        selectedHost={selectedHost}
        selectionError={threadSelectionError}
        onSelectThread={selectThread}
        onExit={exitCompanion}
      />
    )
  }

  return (
    <div className="app-shell" data-sidebar-open={sidebarOpen} data-inspector-open={inspectorOpen}>
      <a className="skip-link" href="#main">Skip to thread</a>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {isDisconnected ? connectionCopy(selectedHost.connection, selectedHost) : ''}
      </div>

      <header className="topbar" inert={sidebarIsModal || inspectorIsModal ? true : undefined}>
        <div className="topbar__leading">
          <button
            ref={sidebarToggleRef}
            className="icon-button topbar__mobile-control"
            type="button"
            aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
            aria-expanded={sidebarOpen}
            aria-controls="project-sidebar"
            onClick={() => {
              setInspectorOpen(false)
              setSidebarOpen((value) => !value)
            }}
          >
            <Icon icon={sidebarOpen ? PanelLeftClose : Menu} size={18} />
          </button>
          <div className="brand-mark" aria-hidden="true"><Icon icon={Sparkles} size={17} strokeWidth={2} /></div>
          <div className="topbar__project">
            <span className="eyebrow">Project</span>
            <strong>{selectedProject.name}</strong>
          </div>
        </div>

        <div className="topbar__controls">
          <button
            ref={commandPaletteTriggerRef}
            className="command-trigger"
            type="button"
            aria-label="Search projects, threads, and commands"
            aria-haspopup="dialog"
            onClick={openCommandPalette}
          >
            <Icon icon={Search} size={15} />
            <span>Search or run…</span>
            <kbd>{commandShortcutLabel()}</kbd>
          </button>

          <button
            ref={pairMobileTriggerRef}
            className="button button--quiet topbar__pair-control"
            type="button"
            aria-haspopup="dialog"
            onClick={() => setPairMobileOpen(true)}
          >
            <Icon icon={Smartphone} size={16} />
            <span>Mobile</span>
          </button>

          <label className="run-location" title={`Run this thread on ${selectedHost.name}`}>
            <span className="run-location__label">Run location</span>
            <span className={cx('connection-dot', `connection-dot--${selectedHost.connection}`)} aria-hidden="true" />
            <select
              ref={locationTriggerRef}
              aria-label={`Run location: ${selectedHost.name}, ${connectionLabel(selectedHost.connection)}`}
              value={selectedHost.id}
              onChange={(event) => openMoveThread(event.target.value, event.currentTarget)}
            >
              {compatibleHosts.map((host) => (
                <option key={host.id} value={host.id}>{host.name} — {connectionLabel(host.connection)}</option>
              ))}
            </select>
            <Icon icon={ChevronDown} size={14} />
          </label>

          <button
            ref={inspectorToggleRef}
            className="icon-button topbar__inspector-control"
            type="button"
            aria-label={inspectorOpen ? 'Close inspector' : 'Open inspector'}
            aria-expanded={inspectorOpen}
            aria-controls="thread-inspector"
            onClick={() => {
              setSidebarOpen(false)
              setInspectorOpen((value) => !value)
            }}
          >
            <Icon icon={inspectorOpen ? PanelRightClose : ListChecks} size={18} />
          </button>
        </div>
      </header>

      <Sidebar
        snapshot={snapshot}
        selectedProjectId={selectedProject.id}
        selectedThreadId={selectedThread.id}
        onSelectProject={selectProject}
        onSelectThread={selectThread}
        onSearch={openCommandPalette}
        onAddComputer={() => {
          closeSidebar()
          setAddComputerOpen(true)
        }}
        onMoveThread={openMoveThread}
        addComputerTriggerRef={addComputerTriggerRef}
        environment={api.environment}
        containerRef={sidebarPanelRef}
        modal={sidebarIsModal}
        inert={inspectorIsModal}
      />

      <main className="thread-view" id="main" tabIndex={-1} inert={sidebarIsModal || inspectorIsModal ? true : undefined}>
        <header className="thread-header">
          <div className="thread-header__title">
            <div className="thread-header__breadcrumb">
              <span>{selectedProject.name}</span>
              <ChevronRight aria-hidden="true" size={13} />
              <span>{selectedProject.branch}</span>
            </div>
            <h1 id="thread-heading" tabIndex={-1}>{selectedThread.title}</h1>
          </div>
          <div className="thread-header__actions">
            <button
              className="thread-summary-button"
              type="button"
              aria-label={`Open evidence: ${snapshot.changes.length} changed files and ${snapshot.evidence.length} evidence items`}
              onClick={() => {
                setSidebarOpen(false)
                setInspectorTab('Changes')
                setInspectorOpen(true)
              }}
            >
              <Icon icon={ListChecks} size={14} />
              <span>{snapshot.changes.length} changes</span>
              <span aria-hidden="true">·</span>
              <span>{snapshot.evidence.length} checks</span>
            </button>
            <div className={cx('task-state', `task-state--${selectedThread.status}`)}>
              {selectedThread.status === 'running' ? <Icon icon={Activity} size={14} /> : <Icon icon={Circle} size={11} />}
              <span>{taskLabel(selectedThread.status)}</span>
            </div>
          </div>
        </header>

        <div className="thread-notices">
          {isDisconnected && (
            <div className={cx('connection-notice', `connection-notice--${selectedHost.connection}`)}>
              <span className="connection-notice__icon">
                <Icon icon={selectedHost.connection === 'offline' ? WifiOff : RefreshCw} size={14} />
              </span>
              <span>{connectionCopy(selectedHost.connection, selectedHost)}</span>
              <span className="connection-notice__detail">
                {selectedHost.connection === 'offline' ? 'Cached transcript remains available.' : 'The task may still be running.'}
              </span>
            </div>
          )}

          {threadSelectionError && (
            <div className="connection-notice connection-notice--offline" role="alert">
              <span className="connection-notice__icon"><Icon icon={AlertCircle} size={14} /></span>
              <span>{threadSelectionError}</span>
              <span className="connection-notice__detail">The cached thread summary remains available.</span>
            </div>
          )}
        </div>

        <Transcript thread={selectedThread} host={selectedHost} />

        <Composer
          connection={selectedHost.connection}
          hostName={selectedHost.name}
          taskState={selectedThread.status}
          mode={composerMode}
          onModeChange={setComposerMode}
          text={composerText}
          onTextChange={setComposerText}
          receipt={composerReceipt}
          onSubmit={submitComposer}
        />
      </main>

      <Inspector
        snapshot={snapshot}
        selectedThread={selectedThread}
        selectedProject={selectedProject}
        selectedHost={selectedHost}
        activeTab={inspectorTab}
        onTabChange={setInspectorTab}
        onClose={closeInspector}
        containerRef={inspectorPanelRef}
        modal={inspectorIsModal}
        inert={sidebarIsModal}
      />

      {(sidebarOpen || inspectorOpen) && (
        <button
          className="pane-scrim"
          type="button"
          aria-label="Close open panel"
          onClick={() => {
            closeSidebar()
            closeInspector()
          }}
        />
      )}

      <AddComputerDialog
        api={api}
        open={addComputerOpen}
        onClose={() => setAddComputerOpen(false)}
        triggerRef={addComputerTriggerRef}
      />

      <CommandPaletteDialog
        open={commandPaletteOpen}
        snapshot={snapshot}
        selectedThreadId={selectedThread.id}
        triggerRef={commandPaletteTriggerRef}
        onClose={() => setCommandPaletteOpen(false)}
        onSelectThread={selectThread}
        onSelectProject={selectProject}
        onAddComputer={() => {
          setCommandPaletteOpen(false)
          setAddComputerOpen(true)
        }}
        onOpenInspector={() => {
          setCommandPaletteOpen(false)
          setSidebarOpen(false)
          setInspectorOpen(true)
        }}
        onOpenCompanion={() => {
          setCommandPaletteOpen(false)
          openCompanion('command')
        }}
        onFocusComposer={() => {
          setCommandPaletteOpen(false)
          window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#thread-composer')?.focus())
        }}
      />

      <PairMobileDialog
        environment={api.environment}
        open={pairMobileOpen}
        snapshot={snapshot}
        selectedThread={selectedThread}
        selectedHost={selectedHost}
        triggerRef={pairMobileTriggerRef}
        onClose={() => setPairMobileOpen(false)}
        onOpenPreview={() => {
          setPairMobileOpen(false)
          openCompanion('mobile')
        }}
      />

      <MoveThreadDialog
        api={api}
        open={moveThreadOpen}
        thread={selectedThread}
        sourceHost={selectedHost}
        destinationHost={snapshot.hosts.find((host) => host.id === moveDestinationId)}
        triggerRef={moveThreadTriggerRef}
        onClose={() => setMoveThreadOpen(false)}
        onMoved={finishMove}
      />
    </div>
  )
}

interface SidebarProps {
  snapshot: WorkbenchSnapshot
  selectedProjectId: string
  selectedThreadId: string
  onSelectProject: (projectId: string) => void
  onSelectThread: (thread: ThreadSummary) => void
  onSearch: () => void
  onAddComputer: () => void
  onMoveThread: (hostId: string, trigger: HTMLElement | null) => void
  addComputerTriggerRef: RefObject<HTMLButtonElement | null>
  environment: RendererApi['environment']
  containerRef: RefObject<HTMLElement | null>
  modal: boolean
  inert: boolean
}

function Sidebar({
  snapshot,
  selectedProjectId,
  selectedThreadId,
  onSelectProject,
  onSelectThread,
  onSearch,
  onAddComputer,
  onMoveThread,
  addComputerTriggerRef,
  environment,
  containerRef,
  modal,
  inert,
}: SidebarProps) {
  const projectThreads = snapshot.threads.filter((thread) => thread.projectId === selectedProjectId)
  const selectedThread = snapshot.threads.find((thread) => thread.id === selectedThreadId)
  const selectedProject = snapshot.projects.find((project) => project.id === selectedProjectId)
  const selectedHost = snapshot.hosts.find((host) => host.id === selectedThread?.hostId)
  const compatibleHosts = snapshot.hosts.filter((host) => selectedProject?.hostIds.includes(host.id))

  return (
    <aside
      ref={containerRef}
      id="project-sidebar"
      className="sidebar"
      role={modal ? 'dialog' : undefined}
      aria-modal={modal ? 'true' : undefined}
      aria-label="Projects and threads"
      tabIndex={-1}
      inert={inert ? true : undefined}
    >
      <div className="sidebar__scroll">
        <div className="sidebar__new-row">
          <button
            className="button button--quiet button--full sidebar__new-thread"
            type="button"
            disabled
            aria-describedby="thread-creation-help"
            title="Thread creation is not available in this build"
          >
            <Icon icon={Plus} strokeWidth={2} /> New thread
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Search projects and threads"
            title="Search projects, threads, and commands"
            onClick={onSearch}
          >
            <Icon icon={Search} size={17} />
          </button>
          <span className="sidebar__availability" id="thread-creation-help">New threads aren’t available yet.</span>
        </div>

        <nav className="nav-section" aria-labelledby="projects-heading">
          <div className="nav-section__heading">
            <h2 id="projects-heading">Projects</h2>
            <span>{snapshot.projects.length}</span>
          </div>
          <ul className="nav-list">
            {snapshot.projects.map((project) => (
              <li key={project.id}>
                <button
                  className={cx('nav-row', project.id === selectedProjectId && 'nav-row--selected')}
                  type="button"
                  aria-current={project.id === selectedProjectId ? 'page' : undefined}
                  onClick={() => onSelectProject(project.id)}
                >
                  <span className="nav-row__icon"><Icon icon={FolderGit2} size={16} /></span>
                  <span className="nav-row__body">
                    <span className="nav-row__title">{project.name}</span>
                    <span className="nav-row__meta">{project.repository}</span>
                  </span>
                  {project.dirtyFiles > 0 && <span className="nav-row__count" aria-label={`${project.dirtyFiles} changed files`}>{project.dirtyFiles}</span>}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <nav className="nav-section nav-section--threads" aria-labelledby="threads-heading">
          <div className="nav-section__heading">
            <h2 id="threads-heading">Threads</h2>
            <span>{projectThreads.length}</span>
          </div>
          <ul className="thread-list">
            {projectThreads.length > 0 ? (
              projectThreads.map((thread) => {
                const host = snapshot.hosts.find((item) => item.id === thread.hostId)
                return (
                  <li key={thread.id}>
                    <button
                      className={cx('thread-row', thread.id === selectedThreadId && 'thread-row--selected')}
                      type="button"
                      aria-current={thread.id === selectedThreadId ? 'page' : undefined}
                      onClick={() => onSelectThread(thread)}
                    >
                      <span className={cx('thread-row__state', `thread-row__state--${thread.status}`)} aria-hidden="true" />
                      <span className="sr-only">{taskLabel(thread.status)}. </span>
                      <span className="thread-row__content">
                        <span className="thread-row__title">
                          {thread.title}
                          {thread.unread && <span className="unread-dot"><span className="sr-only">Unread</span></span>}
                        </span>
                        <span className="thread-row__recap">{thread.recap}</span>
                        <span className="thread-row__meta">
                          <bdi>{host?.name ?? 'Unknown host'}</bdi>
                          <span aria-hidden="true">·</span>
                          <span className="tabular">{thread.updatedAt}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })
            ) : (
              <li className="empty-list">
                <span>No threads in this project</span>
                <button
                  type="button"
                  disabled
                  aria-describedby="empty-thread-help"
                  title="Thread creation is not available in this build"
                >
                  Start a thread
                </button>
                <span className="sr-only" id="empty-thread-help">Thread creation is not available in this build.</span>
              </li>
            )}
          </ul>
        </nav>

        <section className="nav-section nav-section--attention" aria-labelledby="attention-heading">
          <div className="nav-section__heading">
            <h2 id="attention-heading">Attention</h2>
            <span>{snapshot.attention.length}</span>
          </div>
          <ul className="attention-list">
            {snapshot.attention.map((item) => {
              const thread = snapshot.threads.find((candidate) => candidate.id === item.threadId)
              return (
                <li key={item.id}>
                  <button type="button" onClick={() => thread && onSelectThread(thread)}>
                    <span className="attention-list__icon">
                      <Icon icon={item.kind === 'approval' ? ShieldCheck : item.kind === 'question' ? MessageSquare : AlertCircle} size={15} />
                    </span>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.hostName}</small>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      </div>

      <div className="sidebar__footer">
        {selectedHost && compatibleHosts.length > 0 && (
          <label className="sidebar__location">
            <span>Run location</span>
            <span className={cx('connection-dot', `connection-dot--${selectedHost.connection}`)} aria-hidden="true" />
            <select
              aria-label={`Compact run location: ${selectedHost.name}, ${connectionLabel(selectedHost.connection)}`}
              value={selectedHost.id}
              onChange={(event) => onMoveThread(event.target.value, event.currentTarget)}
            >
              {compatibleHosts.map((host) => (
                <option key={host.id} value={host.id}>{host.name} — {connectionLabel(host.connection)}</option>
              ))}
            </select>
            <Icon icon={ChevronDown} size={14} />
          </label>
        )}
        <button ref={addComputerTriggerRef} className="button button--quiet button--full" type="button" onClick={onAddComputer}>
          <Icon icon={Computer} /> Add computer
        </button>
        {environment === 'preview' && <span className="preview-label">Browser preview · sample data</span>}
      </div>
    </aside>
  )
}

function Transcript({ thread, host }: { thread: ThreadSummary; host: HostSummary }) {
  const scrollRef = useRef<HTMLElement>(null)
  const previousThreadIdRef = useRef('')
  const shouldFollowRef = useRef(true)
  const lastBlock = thread.transcript[thread.transcript.length - 1]

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return

    if (previousThreadIdRef.current !== thread.id) {
      previousThreadIdRef.current = thread.id
      shouldFollowRef.current = true
      scroller.scrollTop = scroller.scrollHeight
      return
    }

    if (shouldFollowRef.current) scroller.scrollTop = scroller.scrollHeight
  }, [lastBlock?.id, thread.id, thread.transcript.length])

  return (
    <section
      ref={scrollRef}
      className="transcript"
      aria-label="Thread transcript"
      aria-busy={host.connection === 'reconnecting'}
      onScroll={(event) => {
        const scroller = event.currentTarget
        const distanceFromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
        shouldFollowRef.current = distanceFromBottom <= 96
      }}
    >
      <div className="transcript__inner">
        {thread.transcript.map((block) => {
          if (block.kind === 'checkpoint' || block.kind === 'notice') {
            return (
              <div className={cx('timeline-marker', block.kind === 'notice' && 'timeline-marker--notice')} key={block.id}>
                <span className="timeline-marker__icon">
                  <Icon icon={block.kind === 'checkpoint' ? CheckCircle2 : Info} size={14} />
                </span>
                <div>
                  <p>{block.body}</p>
                  {block.detail && <span>{block.detail}</span>}
                </div>
                <time>{block.time}</time>
              </div>
            )
          }

          return (
            <article className={cx('message', `message--${block.kind}`)} key={block.id}>
              <header className="message__header">
                <span className="message__avatar" aria-hidden="true">
                  <Icon icon={block.kind === 'user' ? Laptop : block.kind === 'tool' ? Terminal : Bot} size={15} />
                </span>
                <strong>{block.author}</strong>
                <time>{block.time}</time>
              </header>
              <div className="message__body">
                {block.kind === 'tool' ? <code>{block.body}</code> : <p>{block.body}</p>}
                {block.detail && <p className="message__detail">{block.detail}</p>}
                {block.receipt && (
                  <span className="message__receipt">
                    Receipt <bdi>{block.receipt}</bdi>
                  </span>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

interface ComposerProps {
  connection: ConnectionState
  hostName: string
  taskState: TaskState
  mode: 'follow_up' | 'steer'
  onModeChange: (mode: 'follow_up' | 'steer') => void
  text: string
  onTextChange: (value: string) => void
  receipt: { state: ComposerReceiptState; message: string }
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

function Composer({ connection, hostName, taskState, mode, onModeChange, text, onTextChange, receipt, onSubmit }: ComposerProps) {
  const disconnected = connection !== 'online'
  const submitLabel = disconnected ? 'Send when reconnected' : mode === 'steer' ? 'Steer now' : 'Send follow-up'

  return (
    <footer className="composer-wrap">
      <form className="composer" onSubmit={onSubmit} aria-label="Message composer">
        <div className="composer__toolbar">
          <div className="mode-control" aria-label="Message intent">
            <button
              type="button"
              aria-pressed={mode === 'follow_up'}
              onClick={() => onModeChange('follow_up')}
            >
              Follow up
            </button>
            <button
              type="button"
              aria-pressed={mode === 'steer'}
              disabled={disconnected || taskState !== 'running'}
              title={disconnected ? `Reconnect to ${hostName} to steer the running turn` : undefined}
              onClick={() => onModeChange('steer')}
            >
              Steer now
            </button>
          </div>
          <span className={cx('composer__connection', `composer__connection--${receipt.state}`)}>
            {receipt.state === 'sending' && <Icon icon={Loader2} size={13} />}
            {receipt.state === 'waiting_for_connection' && <Icon icon={Clock3} size={13} />}
            {receipt.state === 'sent' && <Icon icon={Check} size={13} />}
            {receipt.state === 'uncertain' && <Icon icon={RefreshCw} size={13} />}
            {receipt.state === 'rejected' && <Icon icon={AlertCircle} size={13} />}
            <span>{receipt.message || (disconnected ? 'Waiting for connection' : 'Ready to send')}</span>
          </span>
        </div>

        <label className="sr-only" htmlFor="thread-composer">Message</label>
        <textarea
          id="thread-composer"
          name="message"
          value={text}
          rows={2}
          placeholder="Ask Prime Agent to continue…"
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          aria-describedby="composer-hint composer-status"
        />

        <div className="composer__actions">
          <div className="composer__attachments">
            <button
              className="icon-button"
              type="button"
              aria-label="Attach files"
              aria-describedby="attachments-help"
              title="File attachments are not available in this build"
              disabled
            >
              <Icon icon={Paperclip} size={17} />
            </button>
            <span className="sr-only" id="attachments-help">File attachments are not available in this build.</span>
            <span id="composer-hint">Ctrl or ⌘ + Enter to send</span>
          </div>
          <div className="composer__primary-actions">
            {taskState === 'running' && (
              <button
                className="button button--quiet"
                type="button"
                disabled
                aria-describedby="stop-turn-help"
                title="Stopping a running turn is not available in this build"
              >
                <Icon icon={Square} size={13} strokeWidth={2} /> Stop
              </button>
            )}
            {taskState === 'running' && (
              <span className="sr-only" id="stop-turn-help">Stopping a running turn is not available in this build.</span>
            )}
            <button
              className={cx('button', 'button--primary', !text.trim() && 'button--empty')}
              type="submit"
              disabled={receipt.state === 'sending'}
            >
              {receipt.state === 'sending' ? <Icon icon={Loader2} size={15} /> : <Icon icon={ArrowRight} size={15} strokeWidth={2} />}
              {submitLabel}
            </button>
          </div>
        </div>
        <span className="sr-only" id="composer-status" role="status" aria-live="polite" aria-atomic="true">
          {receipt.message}
        </span>
      </form>
    </footer>
  )
}

interface InspectorProps {
  snapshot: WorkbenchSnapshot
  selectedThread: ThreadSummary
  selectedProject: WorkbenchSnapshot['projects'][number]
  selectedHost: HostSummary
  activeTab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  onClose: () => void
  containerRef: RefObject<HTMLElement | null>
  modal: boolean
  inert: boolean
}

function Inspector({ snapshot, selectedThread, selectedProject, selectedHost, activeTab, onTabChange, onClose, containerRef, modal, inert }: InspectorProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const activateRelativeTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % INSPECTOR_TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = INSPECTOR_TABS.length - 1
    else return
    event.preventDefault()
    const next = INSPECTOR_TABS[nextIndex]
    if (next) onTabChange(next)
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <aside
      ref={containerRef}
      id="thread-inspector"
      className="inspector"
      role={modal ? 'dialog' : undefined}
      aria-modal={modal ? 'true' : undefined}
      aria-label="Thread inspector"
      tabIndex={-1}
      inert={inert ? true : undefined}
    >
      <div className="inspector__header">
        <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
          {INSPECTOR_TABS.map((tab, index) => (
            <button
              key={tab}
              ref={(element) => { tabRefs.current[index] = element }}
              id={`inspector-tab-${tab.toLowerCase()}`}
              role="tab"
              type="button"
              aria-selected={activeTab === tab}
              aria-controls={`inspector-panel-${tab.toLowerCase()}`}
              tabIndex={activeTab === tab ? 0 : -1}
              onClick={() => onTabChange(tab)}
              onKeyDown={(event) => activateRelativeTab(event, index)}
            >
              {tab}
            </button>
          ))}
        </div>
        <button className="icon-button inspector__close" type="button" aria-label="Close inspector" onClick={onClose}>
          <Icon icon={X} size={16} />
        </button>
      </div>

      <div
        className="inspector__panel"
        id={`inspector-panel-${activeTab.toLowerCase()}`}
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={`inspector-tab-${activeTab.toLowerCase()}`}
      >
        {activeTab === 'Changes' && <ChangesPanel snapshot={snapshot} />}
        {activeTab === 'Agents' && <AgentsPanel snapshot={snapshot} />}
        {activeTab === 'Evidence' && <EvidencePanel snapshot={snapshot} />}
        {activeTab === 'Context' && (
          <ContextPanel project={selectedProject} host={selectedHost} />
        )}
      </div>
    </aside>
  )
}

function PanelHeading({ icon, title, meta }: { icon: LucideIcon; title: string; meta: string }) {
  return (
    <header className="panel-heading">
      <span className="panel-heading__icon"><Icon icon={icon} size={16} /></span>
      <div>
        <h2>{title}</h2>
        <p>{meta}</p>
      </div>
    </header>
  )
}

function ChangesPanel({ snapshot }: { snapshot: WorkbenchSnapshot }) {
  const additions = snapshot.changes.reduce((sum, file) => sum + file.additions, 0)
  const deletions = snapshot.changes.reduce((sum, file) => sum + file.deletions, 0)
  return (
    <div className="inspector-content">
      <PanelHeading icon={FileCode2} title="Working tree" meta={`${snapshot.changes.length} files changed`} />
      <div className="change-totals" aria-label={`${additions} additions and ${deletions} deletions`}>
        <span className="change-additions">+{additions}</span>
        <span className="change-deletions">−{deletions}</span>
      </div>
      <ul className="file-list">
        {snapshot.changes.map((file) => (
          <li key={file.path}>
            <div className="file-list__row" title={file.path}>
              <span className="file-list__status">{file.status === 'added' ? 'A' : 'M'}</span>
              <span className="file-list__path">{file.path}</span>
              <span className="file-list__stat tabular"><i>+{file.additions}</i><b>−{file.deletions}</b></span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function AgentsPanel({ snapshot }: { snapshot: WorkbenchSnapshot }) {
  return (
    <div className="inspector-content">
      <PanelHeading icon={Users} title="Agent team" meta={`${snapshot.agents.filter((agent) => agent.status === 'working').length} working now`} />
      <ul className="agent-list">
        {snapshot.agents.map((agent) => (
          <li key={agent.id}>
            <span className={cx('agent-state', `agent-state--${agent.status}`)}><Icon icon={agent.status === 'complete' ? Check : agent.status === 'working' ? Activity : Clock3} size={14} /></span>
            <span className="agent-list__body">
              <strong>{agent.name}</strong>
              <span>{agent.role}</span>
              <small><bdi>{agent.hostName}</bdi> · {agent.status}</small>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function EvidencePanel({ snapshot }: { snapshot: WorkbenchSnapshot }) {
  return (
    <div className="inspector-content">
      <PanelHeading icon={TestTube2} title="Evidence" meta="Checks and durable receipts" />
      <ul className="evidence-list">
        {snapshot.evidence.map((evidence) => (
          <li key={evidence.id}>
            <span className={cx('evidence-state', `evidence-state--${evidence.status}`)}>
              <Icon icon={evidence.status === 'passed' ? CheckCircle2 : evidence.status === 'running' ? Loader2 : AlertCircle} size={15} />
            </span>
            <span>
              <strong>{evidence.label}</strong>
              <small>{evidence.detail}</small>
            </span>
            {evidence.duration && <time className="tabular">{evidence.duration}</time>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ContextPanel({
  project,
  host,
}: {
  project: WorkbenchSnapshot['projects'][number]
  host: HostSummary
}) {
  return (
    <div className="inspector-content">
      <PanelHeading icon={Network} title="Thread context" meta="Authoritative execution details" />
      <dl className="context-list">
        <div><dt>Run location</dt><dd><bdi>{host.name}</bdi></dd></div>
        <div><dt>Connection</dt><dd>{host.connection === 'online' ? `${host.connectionPath} · Online` : connectionCopy(host.connection, host)}</dd></div>
        <div><dt>Repository</dt><dd><bdi>{project.repository}</bdi></dd></div>
        <div><dt>Branch</dt><dd><bdi>{project.branch}</bdi></dd></div>
        <div><dt>Workspace</dt><dd><bdi>./</bdi></dd></div>
        <div><dt>Changed files</dt><dd className="tabular">{project.dirtyFiles}</dd></div>
      </dl>
      <div className="context-note">
        <Icon icon={HardDrive} size={15} />
        <p>Your workspace and credentials stay on <bdi>{host.name}</bdi>. Prime shows the thread updates and files this computer shares.</p>
      </div>
    </div>
  )
}

interface CommandPaletteDialogProps {
  open: boolean
  snapshot: WorkbenchSnapshot
  selectedThreadId: string
  triggerRef: RefObject<HTMLElement | null>
  onClose: () => void
  onSelectThread: (thread: ThreadSummary) => void
  onSelectProject: (projectId: string) => void
  onAddComputer: () => void
  onOpenInspector: () => void
  onOpenCompanion: () => void
  onFocusComposer: () => void
}

interface PaletteItem {
  id: string
  label: string
  detail: string
  group: 'Threads' | 'Projects' | 'Commands'
  icon: LucideIcon
  keywords: string
  run: () => void
}

function CommandPaletteDialog({
  open,
  snapshot,
  selectedThreadId,
  triggerRef,
  onClose,
  onSelectThread,
  onSelectProject,
  onAddComputer,
  onOpenInspector,
  onOpenCompanion,
  onFocusComposer,
}: CommandPaletteDialogProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())

  const items = useMemo<PaletteItem[]>(() => [
    ...snapshot.threads.map((thread) => {
      const project = snapshot.projects.find((candidate) => candidate.id === thread.projectId)
      const host = snapshot.hosts.find((candidate) => candidate.id === thread.hostId)
      return {
        id: `thread:${thread.id}`,
        label: thread.title,
        detail: `${project?.name ?? 'Project'} · ${host?.name ?? 'Unknown host'} · ${taskLabel(thread.status)}`,
        group: 'Threads' as const,
        icon: MessageSquare,
        keywords: `${thread.title} ${thread.recap} ${project?.name ?? ''} ${host?.name ?? ''}`,
        run: () => onSelectThread(thread),
      }
    }),
    ...snapshot.projects.map((project) => ({
      id: `project:${project.id}`,
      label: project.name,
      detail: `${project.repository} · ${project.branch}`,
      group: 'Projects' as const,
      icon: FolderGit2,
      keywords: `${project.name} ${project.repository} ${project.branch}`,
      run: () => onSelectProject(project.id),
    })),
    {
      id: 'command:composer',
      label: 'Focus message composer',
      detail: 'Write a follow-up or steer the running thread',
      group: 'Commands' as const,
      icon: Command,
      keywords: 'message prompt compose send steer follow up',
      run: onFocusComposer,
    },
    {
      id: 'command:inspector',
      label: 'Open changes and evidence',
      detail: 'Review files, agents, checks, and execution context',
      group: 'Commands' as const,
      icon: ListChecks,
      keywords: 'changes evidence tests agents context inspector',
      run: onOpenInspector,
    },
    {
      id: 'command:companion',
      label: 'Open companion preview',
      detail: 'Inspect the compact, read-only mobile supervision surface',
      group: 'Commands' as const,
      icon: Smartphone,
      keywords: 'mobile phone companion preview attention hosts',
      run: onOpenCompanion,
    },
    {
      id: 'command:add-computer',
      label: 'Add computer',
      detail: 'Discover and verify a configured SSH host',
      group: 'Commands' as const,
      icon: Computer,
      keywords: 'add computer ssh host remote machine',
      run: onAddComputer,
    },
  ], [onAddComputer, onFocusComposer, onOpenCompanion, onOpenInspector, onSelectProject, onSelectThread, snapshot])

  const filteredItems = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const ranked = items.filter((item) => {
      const haystack = `${item.label} ${item.detail} ${item.keywords}`.toLocaleLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
    if (terms.length === 0) {
      return ranked.sort((left, right) => {
        if (left.id === `thread:${selectedThreadId}`) return -1
        if (right.id === `thread:${selectedThreadId}`) return 1
        return 0
      }).slice(0, 12)
    }
    return ranked.slice(0, 20)
  }, [items, query, selectedThreadId])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  useEffect(() => {
    if (activeIndex >= filteredItems.length) setActiveIndex(Math.max(0, filteredItems.length - 1))
  }, [activeIndex, filteredItems.length])

  useEffect(() => {
    if (!open) return
    const activeItem = filteredItems[activeIndex]
    if (!activeItem) return
    const frame = window.requestAnimationFrame(() => {
      const option = optionRefs.current.get(activeItem.id)
      if (option && typeof option.scrollIntoView === 'function') option.scrollIntoView({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeIndex, filteredItems, open])

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <NativeDialog
      open={open}
      labelledBy="command-palette-title"
      describedBy="command-palette-description"
      triggerRef={triggerRef}
      className="command-palette-sheet"
      onClose={onClose}
    >
      <div className="command-palette">
        <h2 className="sr-only" id="command-palette-title">Search and commands</h2>
        <p className="sr-only" id="command-palette-description">Search real projects and threads, or run an available workbench command.</p>
        <div className="command-palette__input">
          <Icon icon={Search} size={17} />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Search projects, threads, and commands"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="command-palette-results"
            aria-activedescendant={filteredItems[activeIndex] ? `palette-option-${filteredItems[activeIndex].id.replace(/[^A-Za-z0-9_-]/g, '-')}` : undefined}
            autoComplete="off"
            placeholder="Search threads, projects, or commands"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((index) => filteredItems.length === 0 ? 0 : (index + 1) % filteredItems.length)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((index) => filteredItems.length === 0 ? 0 : (index - 1 + filteredItems.length) % filteredItems.length)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                choose(filteredItems[activeIndex])
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul id="command-palette-results" className="command-palette__results" role="listbox">
          {filteredItems.map((item, index) => {
            const optionId = `palette-option-${item.id.replace(/[^A-Za-z0-9_-]/g, '-')}`
            return (
              <li key={item.id} role="presentation">
                <button
                  id={optionId}
                  ref={(element) => {
                    if (element) optionRefs.current.set(item.id, element)
                    else optionRefs.current.delete(item.id)
                  }}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(item)}
                >
                  <span className="command-palette__icon"><Icon icon={item.icon} size={16} /></span>
                  <span className="command-palette__copy">
                    <strong>{item.label}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <span className="command-palette__group">{item.group}</span>
                </button>
              </li>
            )
          })}
          {filteredItems.length === 0 && (
            <li className="command-palette__empty">No matching thread, project, or available command.</li>
          )}
        </ul>
        <span className="sr-only" role="status" aria-live="polite">
          {filteredItems.length === 1 ? '1 result' : `${filteredItems.length} results`}
        </span>
        <footer className="command-palette__footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Open</span>
        </footer>
      </div>
    </NativeDialog>
  )
}

interface PairMobileDialogProps {
  environment: RendererApi['environment']
  open: boolean
  snapshot: WorkbenchSnapshot
  selectedThread: ThreadSummary
  selectedHost: HostSummary
  triggerRef: RefObject<HTMLElement | null>
  onClose: () => void
  onOpenPreview: () => void
}

function PairMobileDialog({
  environment,
  open,
  snapshot,
  selectedThread,
  selectedHost,
  triggerRef,
  onClose,
  onOpenPreview,
}: PairMobileDialogProps) {
  return (
    <NativeDialog
      open={open}
      labelledBy="pair-mobile-title"
      describedBy="pair-mobile-description"
      triggerRef={triggerRef}
      className="pair-mobile-sheet"
      onClose={onClose}
    >
      <div className="sheet__frame">
        <header className="sheet__header">
          <div className="sheet__title-group">
            <span className="sheet__title-icon"><Icon icon={Smartphone} size={18} /></span>
            <div>
              <h2 id="pair-mobile-title">Mobile companion</h2>
              <p id="pair-mobile-description">Preview this thread in a phone-sized layout.</p>
            </div>
          </div>
          <button className="icon-button" type="button" aria-label="Close mobile companion" onClick={onClose}>
            <Icon icon={X} size={18} />
          </button>
        </header>

        <div className="sheet__scroll pair-mobile-content">
          <section className="relay-gate" aria-labelledby="relay-gate-title">
            <span className="relay-gate__icon"><Icon icon={LockKeyhole} size={20} /></span>
            <div>
              <span className="eyebrow">Pairing unavailable</span>
              <h3 id="relay-gate-title">Phone control is not ready yet</h3>
              <p>
                Remote control stays off until encrypted pairing and per-device revocation are complete. You can still
                preview the mobile experience using data already on this computer.
              </p>
            </div>
          </section>

          <section className="sheet-section" aria-labelledby="companion-preview-heading">
            <div className="section-heading-row">
              <div>
                <h3 id="companion-preview-heading">Preview on this device</h3>
                <p>Uses the thread data already loaded here. It creates no credential or network connection.</p>
              </div>
              <span className="verification-mark">
                <Icon icon={Eye} size={14} />
                {environment === 'preview' ? 'Browser preview · sample data' : 'Native projection data'}
              </span>
            </div>
            <div className="preview-summary">
              <div><span>Thread</span><strong>{selectedThread.title}</strong></div>
              <div><span>Host</span><strong>{selectedHost.name}</strong></div>
              <div><span>Action queue</span><strong>{snapshot.attention.length}</strong></div>
              <div><span>Evidence</span><strong>{snapshot.evidence.length}</strong></div>
            </div>
          </section>
        </div>

        <footer className="sheet__footer">
          <p>The preview stays on this device and cannot send commands.</p>
          <div className="sheet__footer-actions">
            <button className="button button--quiet" type="button" onClick={onClose}>Close</button>
            <button className="button button--primary" type="button" onClick={onOpenPreview}>
              <Icon icon={Smartphone} size={15} /> Open companion preview
            </button>
          </div>
        </footer>
      </div>
    </NativeDialog>
  )
}

interface CompanionPreviewProps {
  environment: RendererApi['environment']
  snapshot: WorkbenchSnapshot
  selectedThread: ThreadSummary
  selectedProject: WorkbenchSnapshot['projects'][number]
  selectedHost: HostSummary
  selectionError: string
  onSelectThread: (thread: ThreadSummary) => void
  onExit: () => void
}

type CompanionView = 'attention' | 'threads' | 'thread' | 'hosts'

function CompanionPreview({
  environment,
  snapshot,
  selectedThread,
  selectedProject,
  selectedHost,
  selectionError,
  onSelectThread,
  onExit,
}: CompanionPreviewProps) {
  const actionableAttention = useMemo(() => {
    const items = [...snapshot.attention]
    if (snapshot.composerReceipt.state === 'uncertain') {
      items.push({
        id: `uncertain-${selectedThread.id}`,
        threadId: selectedThread.id,
        kind: 'failed',
        title: snapshot.composerReceipt.message || 'A command receipt is uncertain',
        hostName: selectedHost.name,
      })
    }
    return [...new Map(items.map((item) => [item.id, item])).values()]
  }, [selectedHost.name, selectedThread.id, snapshot.attention, snapshot.composerReceipt])
  const [view, setView] = useState<CompanionView>(() => actionableAttention.length > 0 ? 'attention' : 'threads')
  const mainRef = useRef<HTMLElement>(null)
  const attentionHeadingRef = useRef<HTMLHeadingElement>(null)
  const threadsHeadingRef = useRef<HTMLHeadingElement>(null)
  const threadHeadingRef = useRef<HTMLHeadingElement>(null)
  const hostsHeadingRef = useRef<HTMLHeadingElement>(null)
  const threadButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const lastOpenedThreadIdRef = useRef(selectedThread.id)
  const focusThreadHeadingRef = useRef(false)
  const restoreThreadRowRef = useRef(false)
  const navigationTargetRef = useRef<Exclude<CompanionView, 'thread'> | null>(null)
  const connectionLabel = selectedHost.connection === 'online'
    ? `Connected through ${selectedHost.connectionPath}`
    : connectionCopy(selectedHost.connection, selectedHost)

  useEffect(() => {
    const heading = view === 'attention'
      ? attentionHeadingRef.current
      : view === 'threads'
        ? threadsHeadingRef.current
        : view === 'thread'
          ? threadHeadingRef.current
          : hostsHeadingRef.current
    window.requestAnimationFrame(() => heading?.focus({ preventScroll: true }))
  }, [])

  useEffect(() => {
    const navigationTarget = navigationTargetRef.current
    if (navigationTarget && navigationTarget === view) {
      navigationTargetRef.current = null
      window.requestAnimationFrame(() => {
        if (mainRef.current) mainRef.current.scrollTop = 0
        const heading = navigationTarget === 'attention'
          ? attentionHeadingRef.current
          : navigationTarget === 'threads'
            ? threadsHeadingRef.current
            : hostsHeadingRef.current
        heading?.focus({ preventScroll: true })
      })
      return
    }

    if (view === 'thread' && focusThreadHeadingRef.current) {
      focusThreadHeadingRef.current = false
      window.requestAnimationFrame(() => {
        if (mainRef.current) mainRef.current.scrollTop = 0
        threadHeadingRef.current?.focus({ preventScroll: true })
      })
    }
    if (view === 'threads' && restoreThreadRowRef.current) {
      restoreThreadRowRef.current = false
      window.requestAnimationFrame(() => threadButtonRefs.current.get(lastOpenedThreadIdRef.current)?.focus())
    }
  }, [selectedThread.id, view])

  const openThread = (thread: ThreadSummary) => {
    lastOpenedThreadIdRef.current = thread.id
    focusThreadHeadingRef.current = true
    onSelectThread(thread)
    setView('thread')
  }

  const returnToThreads = () => {
    restoreThreadRowRef.current = true
    setView('threads')
  }

  const navigateCompanion = (destination: Exclude<CompanionView, 'thread'>) => {
    navigationTargetRef.current = destination
    if (view !== destination) {
      setView(destination)
      return
    }

    navigationTargetRef.current = null
    window.requestAnimationFrame(() => {
      if (mainRef.current) mainRef.current.scrollTop = 0
      const heading = destination === 'attention'
        ? attentionHeadingRef.current
        : destination === 'threads'
          ? threadsHeadingRef.current
          : hostsHeadingRef.current
      heading?.focus({ preventScroll: true })
    })
  }

  return (
    <div className="companion-shell">
      <a className="skip-link" href="#companion-main">Skip to companion content</a>
      <header className="companion-topbar">
        <div className="companion-brand">
          <span className="brand-mark" aria-hidden="true"><Icon icon={Sparkles} size={17} strokeWidth={2} /></span>
          <span>
            <strong>Prime Companion</strong>
            <small>{environment === 'preview' ? 'Browser preview · sample data' : 'Read-only preview on this device'}</small>
          </span>
        </div>
        <button className="button button--quiet button--small" type="button" onClick={onExit}>
          <Icon icon={Monitor} size={15} /> Desktop
        </button>
      </header>

      <div className="companion-preview-notice" role="note">
        <Icon icon={LockKeyhole} size={15} />
        <span><strong>Preview only.</strong> Secure mobile relay is not available in this build.</span>
      </div>

      <main ref={mainRef} className="companion-main" id="companion-main" tabIndex={-1}>
        {selectionError && (
          <div className="companion-error" role="alert">
            <Icon icon={AlertCircle} size={15} />
            <span>{selectionError}</span>
          </div>
        )}
        {view === 'attention' && (
          <section className="companion-screen" aria-labelledby="companion-attention-title">
            <header className="companion-screen__header">
              <span className="eyebrow">Action queue</span>
              <h1 ref={attentionHeadingRef} id="companion-attention-title" tabIndex={-1}>Needs you</h1>
              <p>Questions, approvals, uncertain commands, and failures only.</p>
            </header>
            {actionableAttention.length > 0 ? (
              <ul className="companion-card-list">
                {actionableAttention.map((item) => {
                  const thread = snapshot.threads.find((candidate) => candidate.id === item.threadId)
                  return (
                    <li key={item.id}>
                      <button type="button" onClick={() => thread && openThread(thread)}>
                        <span className={cx('companion-card-list__icon', `companion-card-list__icon--${item.kind}`)}>
                          <Icon icon={item.kind === 'approval' ? ShieldCheck : item.kind === 'question' ? MessageSquare : AlertCircle} size={17} />
                        </span>
                        <span><strong>{item.title}</strong><small>{thread?.title ?? 'Unknown thread'} · {item.hostName}</small></span>
                        <Icon icon={ChevronRight} size={16} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="companion-empty"><Icon icon={CheckCircle2} size={22} /><h2>Nothing needs you</h2><p>Active and recent work remains under Threads.</p></div>
            )}
          </section>
        )}

        {view === 'threads' && (
          <section className="companion-screen" aria-labelledby="companion-threads-title">
            <header className="companion-screen__header">
              <span className="eyebrow">All locations</span>
              <h1 ref={threadsHeadingRef} id="companion-threads-title" tabIndex={-1}>Threads</h1>
              <p>Follow active and recent work across your computers.</p>
            </header>
            <ul className="companion-thread-list">
              {snapshot.threads.map((thread) => {
                const host = snapshot.hosts.find((candidate) => candidate.id === thread.hostId)
                return (
                  <li key={thread.id}>
                    <button
                      ref={(element) => {
                        if (element) threadButtonRefs.current.set(thread.id, element)
                        else threadButtonRefs.current.delete(thread.id)
                      }}
                      type="button"
                      aria-current={thread.id === selectedThread.id ? 'page' : undefined}
                      onClick={() => openThread(thread)}
                    >
                      <span className={cx('thread-row__state', `thread-row__state--${thread.status}`)} aria-hidden="true" />
                      <span><strong>{thread.title}</strong><small>{thread.recap}</small><em>{host?.name ?? 'Unknown host'} · {taskLabel(thread.status)} · {thread.updatedAt}</em></span>
                      <Icon icon={ChevronRight} size={16} />
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {view === 'thread' && (
          <article className="companion-thread" aria-labelledby="companion-thread-title">
            <header className="companion-thread__header">
              <button className="button button--quiet button--small" type="button" onClick={returnToThreads}>
                <Icon icon={ChevronRight} size={15} /> Threads
              </button>
              <span className={cx('task-state', `task-state--${selectedThread.status}`)}>{taskLabel(selectedThread.status)}</span>
            </header>
            <section className="companion-recap">
              <span className="eyebrow">Thread recap</span>
              <h1 ref={threadHeadingRef} id="companion-thread-title" tabIndex={-1}>{selectedThread.title}</h1>
              <p>{selectedThread.recap}</p>
              <div className="companion-meta"><span>{selectedProject.name}</span><span>{selectedHost.name}</span><span>{connectionLabel}</span></div>
            </section>

            {actionableAttention.filter((item) => item.threadId === selectedThread.id).map((item) => (
              <section className="companion-decision" key={item.id} aria-label="Current decision">
                <span><Icon icon={item.kind === 'approval' ? ShieldCheck : item.kind === 'question' ? MessageSquare : AlertCircle} size={17} /></span>
                <div><strong>{item.title}</strong><p>Open the authorized desktop client to resolve this item.</p></div>
              </section>
            ))}

            <section className="companion-results" aria-labelledby="companion-results-title">
              <div className="section-heading-row">
                <div><h2 id="companion-results-title">Results</h2><p>Concise review before the full transcript.</p></div>
              </div>
              <div className="companion-result-grid">
                <div><span>Changed files</span><strong>{snapshot.changes.length}</strong></div>
                <div><span>Checks</span><strong>{snapshot.evidence.length}</strong></div>
                <div><span>Passed</span><strong>{snapshot.evidence.filter((item) => item.status === 'passed').length}</strong></div>
              </div>
              {snapshot.evidence.slice(0, 3).map((item) => (
                <div className="companion-evidence-row" key={item.id}>
                  <Icon icon={item.status === 'passed' ? CheckCircle2 : item.status === 'running' ? Loader2 : AlertCircle} size={15} />
                  <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                </div>
              ))}
            </section>

            <section className="companion-transcript" aria-labelledby="companion-transcript-title">
              <div className="section-heading-row"><div><h2 id="companion-transcript-title">Recent activity</h2><p>Most recent updates from the active computer.</p></div></div>
              {selectedThread.transcript.slice(-6).map((block) => (
                <article key={block.id} className={cx('companion-message', `companion-message--${block.kind}`)}>
                  <header><strong>{block.author ?? (block.kind === 'checkpoint' ? 'Checkpoint' : 'Prime Agent')}</strong><time>{block.time}</time></header>
                  <p>{block.body}</p>
                  {block.detail && <small>{block.detail}</small>}
                </article>
              ))}
            </section>

            <section className="companion-lock-callout" aria-labelledby="companion-control-title">
              <Icon icon={LockKeyhole} size={17} />
              <div>
                <strong id="companion-control-title">Replies are read-only in this preview</strong>
                <p>Phone controls will appear here after secure pairing is available. This preview never sends a command.</p>
              </div>
            </section>
          </article>
        )}

        {view === 'hosts' && (
          <section className="companion-screen" aria-labelledby="companion-hosts-title">
            <header className="companion-screen__header">
              <span className="eyebrow">Execution locations</span>
              <h1 ref={hostsHeadingRef} id="companion-hosts-title" tabIndex={-1}>Hosts</h1>
              <p>See which computers Prime can reach right now.</p>
            </header>
            <ul className="companion-host-list">
              {snapshot.hosts.map((host) => (
                <li key={host.id}>
                  <span className="companion-host-list__icon"><Icon icon={host.kind === 'local' ? Laptop : Server} size={17} /></span>
                  <span><strong>{host.name}</strong><small>{host.connection === 'online' ? `Connected through ${host.connectionPath}` : connectionCopy(host.connection, host)}</small></span>
                  <em>{host.compatibility.replaceAll('_', ' ')}</em>
                </li>
              ))}
            </ul>
            <div className="companion-lock-callout" role="note">
              <Icon icon={LockKeyhole} size={18} />
              <div><strong>Phone pairing isn't available yet</strong><p>This build does not create a pairing code or phone credential.</p></div>
            </div>
          </section>
        )}
      </main>

      <nav className="companion-nav" aria-label="Companion navigation">
        <button type="button" aria-current={view === 'attention' ? 'page' : undefined} onClick={() => navigateCompanion('attention')}>
          <span><Icon icon={Bell} size={19} />{actionableAttention.length > 0 && <b>{actionableAttention.length}</b>}</span>
          Attention
        </button>
        <button type="button" aria-current={view === 'threads' || view === 'thread' ? 'page' : undefined} onClick={() => navigateCompanion('threads')}>
          <Icon icon={MessageSquare} size={19} /> Threads
        </button>
        <button type="button" aria-current={view === 'hosts' ? 'page' : undefined} onClick={() => navigateCompanion('hosts')}>
          <Icon icon={Server} size={19} /> Hosts
        </button>
      </nav>
    </div>
  )
}

interface NativeDialogProps {
  open: boolean
  labelledBy: string
  describedBy?: string
  triggerRef: RefObject<HTMLElement | null>
  className?: string
  dismissible?: boolean
  onClose: () => void
  children: ReactNode
}

function NativeDialog({ open, labelledBy, describedBy, triggerRef, className, dismissible = true, onClose, children }: NativeDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const restoreTargetRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open && !dialog.open) {
      restoreTargetRef.current = triggerRef.current ?? (document.activeElement as HTMLElement | null)
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
      window.requestAnimationFrame(() => {
        const focusTarget = dialog.querySelector<HTMLElement>('[autofocus], button, [href], input, select, textarea')
        focusTarget?.focus()
      })
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
    }
  }, [open, triggerRef])

  const restoreFocus = () => {
    window.requestAnimationFrame(() => (restoreTargetRef.current ?? triggerRef.current)?.focus())
  }

  return (
    <dialog
      ref={dialogRef}
      className={cx('sheet', className)}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(event) => {
        event.preventDefault()
        if (dismissible) onClose()
      }}
      onClose={() => {
        onClose()
        restoreFocus()
      }}
      onClick={(event) => {
        if (dismissible && event.target === dialogRef.current) onClose()
      }}
    >
      {children}
    </dialog>
  )
}

interface AddComputerDialogProps {
  api: RendererApi
  open: boolean
  onClose: () => void
  triggerRef: RefObject<HTMLElement | null>
}

function AddComputerDialog({ api, open, onClose, triggerRef }: AddComputerDialogProps) {
  const [computers, setComputers] = useState<DiscoveredComputer[]>([])
  const [selectedAlias, setSelectedAlias] = useState('')
  const [manualMode, setManualMode] = useState(false)
  const [manualHost, setManualHost] = useState('')
  const [manualUser, setManualUser] = useState('')
  const [selectedComputer, setSelectedComputer] = useState<DiscoveredComputer | null>(null)
  const [loading, setLoading] = useState(false)
  const [probing, setProbing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [installConsent, setInstallConsent] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    setStatus('Discovering SSH aliases…')
    void api
      .discoverComputers()
      .then((items) => {
        if (cancelled) return
        setComputers(items)
        const first = items[0]
        if (first) {
          setSelectedAlias(first.alias)
          setSelectedComputer(first)
          setInstallConsent(first.probeComplete && !first.requiresInstall)
        }
        setStatus(items.length === 1 ? 'Found 1 SSH alias' : `Found ${items.length} SSH aliases`)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to read SSH aliases. Enter a host manually.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [api, open])

  const selectAlias = (alias: string) => {
    const selected = computers.find((computer) => computer.alias === alias) ?? null
    setSelectedAlias(alias)
    setSelectedComputer(selected)
    setManualMode(false)
    setInstallConsent(selected?.probeComplete ? !selected.requiresInstall : false)
    setError('')
  }

  const probe = async () => {
    setError('')
    if (manualMode && !manualHost.trim()) {
      setError('Enter a hostname or SSH alias to run the connection check.')
      return
    }
    setProbing(true)
    setStatus(`Checking ${manualMode ? manualHost.trim() : selectedAlias}…`)
    try {
      const result = await api.probeComputer(
        manualMode
          ? { hostname: manualHost.trim(), user: manualUser.trim() || undefined }
          : { alias: selectedAlias },
      )
      setSelectedComputer(result)
      setSelectedAlias(result.alias)
      setInstallConsent(!result.requiresInstall)
      setStatus(`Connection check passed for ${result.alias}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to connect. Verify the SSH configuration and try again.')
    } finally {
      setProbing(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedComputer?.probeComplete) {
      setError('Select a discovered alias or check a manually entered host first.')
      return
    }
    if (selectedComputer.requiresInstall && !installConsent) {
      setError(`Allow installation of the Prime Agent host service on ${selectedComputer.alias} to continue.`)
      return
    }
    setSubmitting(true)
    setError('')
    setStatus(selectedComputer.requiresInstall ? `Installing the host service on ${selectedComputer.alias}…` : `Adding ${selectedComputer.alias}…`)
    try {
      await api.addComputer({
        alias: selectedComputer.alias,
        installHostService: selectedComputer.requiresInstall,
        installCommandAcknowledged: installConsent,
      })
      setStatus(`${selectedComputer.alias} is ready`)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to add this computer. Check the connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const resolved = selectedComputer?.probeComplete ? selectedComputer : null
  const hasReportedFingerprint = Boolean(
    resolved && /^SHA256:[A-Za-z0-9+/]{32,}={0,2}$/.test(resolved.fingerprint) && resolved.fingerprint !== 'SHA256:pending-host-verification',
  )
  const isPreview = api.environment === 'preview'

  return (
    <NativeDialog open={open} labelledBy="add-computer-title" describedBy="add-computer-description" triggerRef={triggerRef} onClose={onClose} className="sheet--computer" dismissible={!submitting}>
      <form className="sheet__frame" onSubmit={submit} aria-busy={submitting}>
        <header className="sheet__header">
          <div className="sheet__title-group">
            <span className="sheet__title-icon"><Icon icon={Computer} size={18} /></span>
            <div>
              <h2 id="add-computer-title">Add computer</h2>
              <p id="add-computer-description">
                Use an existing SSH alias. OpenSSH keeps control of keys, proxy jumps, and host verification.
                {api.environment === 'native' && ' This build cannot show interactive password, passphrase, or new host-key prompts; complete those in your terminal, then check again.'}
              </p>
            </div>
          </div>
          <button className="icon-button" type="button" aria-label="Close Add computer" onClick={onClose} disabled={submitting}>
            <Icon icon={X} size={17} />
          </button>
        </header>

        <div className="sheet__scroll">
          <section className="sheet-section" aria-labelledby="discovered-heading">
            <div className="section-heading-row">
              <div>
                <h3 id="discovered-heading">Discovered aliases</h3>
                <p>From your SSH configuration, including resolved includes.</p>
              </div>
              <button className="button button--quiet button--small" type="button" onClick={() => void probe()} disabled={probing || !selectedAlias}>
                <Icon icon={probing ? Loader2 : RefreshCw} size={14} /> {probing ? 'Checking…' : resolved ? 'Check again' : 'Check connection'}
              </button>
            </div>

            {loading && computers.length === 0 ? (
              <div className="inline-loading"><Icon icon={Loader2} size={16} /> Reading SSH configuration…</div>
            ) : (
              <fieldset className="alias-list">
                <legend className="sr-only">Choose an SSH alias</legend>
                {computers.map((computer) => (
                  <label key={computer.alias} className={cx('alias-row', selectedAlias === computer.alias && !manualMode && 'alias-row--selected')}>
                    <input
                      type="radio"
                      name="ssh-alias"
                      value={computer.alias}
                      checked={selectedAlias === computer.alias && !manualMode}
                      onChange={() => selectAlias(computer.alias)}
                    />
                    <span className="alias-row__computer"><Icon icon={Server} size={16} /></span>
                    <span className="alias-row__body">
                      <strong><bdi>{computer.alias}</bdi></strong>
                      <small><bdi>{computer.effectiveTarget}</bdi></small>
                    </span>
                    <span className="alias-row__state"><Icon icon={CheckCircle2} size={15} /> Ready to check</span>
                  </label>
                ))}
              </fieldset>
            )}

            {api.environment === 'preview' ? (
              <details className="disclosure" open={manualMode} onToggle={(event) => setManualMode(event.currentTarget.open)}>
                <summary><span>Preview a manual host</span><span>Sample browser demo</span></summary>
                <div className="manual-fields">
                  <label>
                    <span>Hostname or SSH alias</span>
                    <input
                      type="text"
                      name="manual-host"
                      value={manualHost}
                      placeholder="build.example.com"
                      spellCheck={false}
                      onChange={(event) => setManualHost(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>User <em>optional</em></span>
                    <input
                      type="text"
                      name="manual-user"
                      value={manualUser}
                      placeholder="developer"
                      autoComplete="username"
                      spellCheck={false}
                      onChange={(event) => setManualUser(event.target.value)}
                    />
                  </label>
                  <button className="button button--secondary" type="button" onClick={() => void probe()} disabled={probing}>
                    <Icon icon={Network} size={15} /> Check preview host
                  </button>
                </div>
              </details>
            ) : (
              <details className="disclosure">
                <summary><span>Alias not listed?</span><span>SSH configuration</span></summary>
                <div className="manual-guidance">
                  <p>Add a concrete <code>Host</code> alias to your SSH configuration, then close and reopen this sheet. Wildcard-only entries are not shown.</p>
                  <code>Host buildbox{`\n`}  HostName build.example.com{`\n`}  User developer</code>
                </div>
              </details>
            )}
          </section>

          {resolved && (
            <section className="sheet-section" aria-labelledby="resolved-heading">
              <div className="section-heading-row">
                <div>
                  <h3 id="resolved-heading">Resolved connection</h3>
                  <p>Confirm the effective target and host identity before continuing.</p>
                </div>
                <span className="verification-mark">
                  <Icon icon={ShieldCheck} size={15} /> {isPreview ? 'Preview sample' : 'Verified by OpenSSH'}
                </span>
              </div>
              <dl className="resolved-grid">
                <div><dt>Alias</dt><dd><bdi>{resolved.alias}</bdi></dd></div>
                <div><dt>Effective target</dt><dd><bdi>{resolved.effectiveTarget}</bdi></dd></div>
                <div className="resolved-grid__wide">
                  <dt>{hasReportedFingerprint ? 'Host-key fingerprint' : 'Host verification'}</dt>
                  <dd>{hasReportedFingerprint ? <code>{resolved.fingerprint}</code> : resolved.fingerprint}</dd>
                </div>
                <div><dt>Protocol</dt><dd>{resolved.protocol}</dd></div>
                <div><dt>System</dt><dd>{resolved.platform} · <bdi>{resolved.architecture}</bdi></dd></div>
              </dl>
            </section>
          )}

          {resolved && (
            <section className="sheet-section" aria-labelledby="probe-heading">
              <div className="section-heading-row">
                <div>
                  <h3 id="probe-heading">Readiness check</h3>
                  <p>A bounded, machine-readable probe. No private keys are read or copied.</p>
                </div>
              </div>
              <ul className="probe-list">
                <ProbeRow label="Disk" value={resolved.diskFree} />
                <ProbeRow label="Git" value={resolved.gitVersion} />
                <ProbeRow label="Python" value={resolved.pythonStatus} />
                <ProbeRow label="Prime Agent" value={resolved.agentVersion} />
                <ProbeRow label="Host service" value={resolved.hostServiceVersion ?? 'Not installed'} warning={resolved.requiresInstall} />
              </ul>
            </section>
          )}

          {resolved?.requiresInstall && (
            <section className="sheet-section install-consent" aria-labelledby="install-heading">
              <div className="install-consent__copy">
                <span className="install-consent__icon"><Icon icon={HardDrive} size={17} /></span>
                <div>
                  <h3 id="install-heading">Install the host service</h3>
                  <p>It runs under your user account on <bdi>{resolved.alias}</bdi> and lets threads continue when this app disconnects. Root access is not required.</p>
                </div>
              </div>
              <label className="consent-row">
                <input type="checkbox" checked={installConsent} disabled={!resolved.installAvailable} onChange={(event) => setInstallConsent(event.target.checked)} />
                <span>Install the signed Prime Agent host service on <bdi>{resolved.alias}</bdi></span>
              </label>
              {!resolved.installAvailable && (
                <p className="install-unavailable"><Icon icon={AlertCircle} size={14} /> {resolved.installDeferredReason ?? 'The signed installer is unavailable in this build.'}</p>
              )}
              <details className="command-disclosure">
                <summary>Show exact install command</summary>
                <div className="command-block">
                  <code>{resolved.installCommand}</code>
                  <button className="small-icon-button" type="button" aria-label="Copy exact install command" onClick={() => void navigator.clipboard?.writeText(resolved.installCommand)}>
                    <Icon icon={Code2} size={14} />
                  </button>
                </div>
              </details>
            </section>
          )}

          {error && <p className="inline-error" role="alert"><Icon icon={AlertCircle} size={15} /> {error}</p>}
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</div>
        </div>

        <footer className="sheet__footer">
          <p>
            {resolved
              ? isPreview
                ? 'Sample browser preview only; no live host key was checked.'
                : hasReportedFingerprint
                ? `Review the reported host-key fingerprint for ${resolved.effectiveTarget}.`
                : `OpenSSH verified ${resolved.effectiveTarget}; this probe did not return a literal fingerprint.`
              : 'Choose a computer to continue.'}
          </p>
          <div className="sheet__footer-actions">
            <button className="button button--quiet" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={loading || probing || submitting || Boolean(resolved?.requiresInstall && !resolved.installAvailable)}>
              {loading || submitting ? <Icon icon={Loader2} size={15} /> : <Icon icon={ArrowRight} size={15} strokeWidth={2} />}
              {submitting
                ? resolved?.requiresInstall
                  ? `Installing on ${resolved.alias}…`
                  : `Adding ${resolved?.alias ?? 'computer'}…`
                : resolved?.requiresInstall
                  ? `Install and add ${resolved.alias}`
                  : resolved
                    ? `Add ${resolved.alias}`
                    : 'Add computer'}
            </button>
          </div>
        </footer>
      </form>
    </NativeDialog>
  )
}

function ProbeRow({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return (
    <li>
      <span className={cx('probe-list__icon', warning && 'probe-list__icon--warning')}>
        <Icon icon={warning ? AlertCircle : Check} size={14} />
      </span>
      <span>{label}</span>
      <strong>{value}</strong>
    </li>
  )
}

interface MoveThreadDialogProps {
  api: RendererApi
  open: boolean
  thread: ThreadSummary
  sourceHost: HostSummary
  destinationHost?: HostSummary
  triggerRef: RefObject<HTMLElement | null>
  onClose: () => void
  onMoved: (destinationHostId: string, destinationName: string) => void
}

function MoveThreadDialog({ api, open, thread, sourceHost, destinationHost, triggerRef, onClose, onMoved }: MoveThreadDialogProps) {
  const [behavior, setBehavior] = useState<'interrupt' | 'wait_for_idle'>('wait_for_idle')
  const [plan, setPlan] = useState<HandoffPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [moving, setMoving] = useState(false)
  const [phase, setPhase] = useState<HandoffPhase | null>(null)
  const [progressMessage, setProgressMessage] = useState('')
  const [error, setError] = useState('')
  const [completeReceipt, setCompleteReceipt] = useState('')

  useEffect(() => {
    if (!open || !destinationHost) return
    let cancelled = false
    setPlan(null)
    setError('')
    setPhase(null)
    setProgressMessage('Reviewing destination compatibility…')
    setCompleteReceipt('')
    setLoading(true)
    void api
      .planHandoff({ threadId: thread.id, destinationHostId: destinationHost.id, behaviorIfRunning: behavior })
      .then((nextPlan) => {
        if (!cancelled) {
          setPlan(nextPlan)
          setProgressMessage('Move review ready')
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to prepare this move. Try again.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [api, behavior, destinationHost, open, thread.id])

  const startMove = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!plan || !destinationHost) return
    setMoving(true)
    setError('')
    try {
      const receipt = await api.startHandoff(
        { handoffId: plan.handoffId, behaviorIfRunning: behavior },
        (nextPhase, message) => {
          setPhase(nextPhase)
          setProgressMessage(message)
        },
      )
      setCompleteReceipt(receipt.receiptId)
      setPhase('complete')
      setProgressMessage(`Thread moved to ${destinationHost.name}`)
      onMoved(destinationHost.id, destinationHost.name)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to move the thread. The source remains authoritative.')
    } finally {
      setMoving(false)
    }
  }

  const currentPhaseIndex = phase ? HANDOFF_PHASES.findIndex((item) => item.phase === phase) : -1
  const isComplete = phase === 'complete'
  const reviewedSourceName = plan?.sourceName ?? sourceHost.name
  const reviewedSourceKind = reviewedSourceName === 'This computer' ? 'local' : 'ssh'

  return (
    <NativeDialog open={open} labelledBy="move-thread-title" describedBy="move-thread-description" triggerRef={triggerRef} onClose={onClose} className="sheet--handoff" dismissible={!moving}>
      <form className="sheet__frame" onSubmit={startMove} aria-busy={moving}>
        <header className="sheet__header">
          <div className="sheet__title-group">
            <span className="sheet__title-icon"><Icon icon={RefreshCw} size={18} /></span>
            <div>
              <h2 id="move-thread-title">Move thread</h2>
              <p id="move-thread-description">Create a checkpoint, verify the destination, then continue in this same thread.</p>
            </div>
          </div>
          <button className="icon-button" type="button" aria-label="Close Move thread" onClick={onClose} disabled={moving}>
            <Icon icon={X} size={17} />
          </button>
        </header>

        <div className="sheet__scroll">
          <div className="handoff-route" aria-label={`Move from ${reviewedSourceName} to ${destinationHost?.name ?? 'destination'}`}>
            <LocationSummary icon={reviewedSourceKind === 'local' ? Monitor : Server} label="Source" name={reviewedSourceName} detail="Authoritative now" />
            <span className="handoff-route__arrow"><Icon icon={ArrowRight} size={18} /></span>
            <LocationSummary icon={destinationHost?.kind === 'local' ? Monitor : Server} label="Destination" name={destinationHost?.name ?? 'Choose a destination'} detail={destinationHost?.connection === 'online' ? 'Reachable and compatible' : 'Connection will be checked'} />
          </div>

          {loading && !plan ? (
            <div className="inline-loading"><Icon icon={Loader2} size={16} /> Reviewing repository and host capabilities…</div>
          ) : plan ? (
            <>
              <section className="sheet-section" aria-labelledby="move-review-heading">
                <div className="section-heading-row">
                  <div>
                    <h3 id="move-review-heading">Move review</h3>
                    <p>Only the destination becomes authoritative after every verification passes.</p>
                  </div>
                  <span className="verification-mark"><Icon icon={CheckCircle2} size={15} /> Exact repository match</span>
                </div>
                <dl className="move-review-grid">
                  <div><dt>Repository</dt><dd><bdi>{plan.repository}</bdi></dd></div>
                  <div><dt>Destination project</dt><dd>{plan.destinationProject}</dd></div>
                  <div><dt>Branch</dt><dd><bdi>{plan.branch}</bdi></dd></div>
                  <div><dt>Working tree</dt><dd>{plan.dirtyFiles} dirty · {plan.untrackedFiles} untracked</dd></div>
                  <div><dt>Estimated transfer</dt><dd className="tabular">{plan.transferSize}</dd></div>
                  <div><dt>Repository identity</dt><dd>Exact match</dd></div>
                </dl>
              </section>

              <section className="sheet-section" aria-labelledby="running-turn-heading">
                <div className="section-heading-row">
                  <div>
                    <h3 id="running-turn-heading">Current turn</h3>
                    <p>This thread is {taskLabel(thread.status).toLowerCase()} on <bdi>{reviewedSourceName}</bdi>.</p>
                  </div>
                </div>
                <fieldset className="choice-list" disabled={moving || isComplete}>
                  <legend>When should the move start?</legend>
                  <label>
                    <input type="radio" name="handoff-behavior" value="wait_for_idle" checked={behavior === 'wait_for_idle'} onChange={() => setBehavior('wait_for_idle')} />
                    <span><strong>Wait for this turn</strong><small>Finish the current turn, then stop new mutations and create the checkpoint.</small></span>
                  </label>
                  <label>
                    <input type="radio" name="handoff-behavior" value="interrupt" checked={behavior === 'interrupt'} onChange={() => setBehavior('interrupt')} />
                    <span><strong>Interrupt this turn</strong><small>Stop at the next safe boundary, then create the checkpoint.</small></span>
                  </label>
                </fieldset>
              </section>

              <section className="sheet-section runtime-losses" aria-labelledby="runtime-loss-heading">
                <div className="runtime-losses__heading">
                  <span><Icon icon={AlertCircle} size={16} /></span>
                  <div>
                    <h3 id="runtime-loss-heading">Runtime state restarts</h3>
                    <p>This is a checkpoint transfer, not a live process migration.</p>
                  </div>
                </div>
                <ul>
                  {plan.runtimeLosses.map((loss) => <li key={loss}>{loss}</li>)}
                </ul>
                <p>Thread history, project state, goals, durable resources, Git changes, and untracked files are preserved.</p>
              </section>

              <div className="authority-note">
                <Icon icon={ShieldCheck} size={17} />
                <p><strong><bdi>{reviewedSourceName}</bdi> remains authoritative</strong> until <bdi>{destinationHost?.name}</bdi> is fully materialized and verified. If anything fails, the source checkpoint remains intact.</p>
              </div>

              {phase && (
                <section className="handoff-progress" aria-labelledby="handoff-progress-heading">
                  <div className="section-heading-row">
                    <div>
                      <h3 id="handoff-progress-heading">Move progress</h3>
                      <p>{progressMessage}</p>
                    </div>
                    <span className="tabular">{Math.max(0, currentPhaseIndex + 1)} / {HANDOFF_PHASES.length}</span>
                  </div>
                  <ol>
                    {HANDOFF_PHASES.map((item, index) => {
                      const state = index < currentPhaseIndex || isComplete ? 'complete' : index === currentPhaseIndex ? 'current' : 'pending'
                      return (
                        <li key={item.phase} data-state={state}>
                          <span>{state === 'complete' ? <Icon icon={Check} size={13} /> : state === 'current' ? <Icon icon={Loader2} size={13} /> : <span aria-hidden="true" />}</span>
                          {item.label}
                        </li>
                      )
                    })}
                  </ol>
                </section>
              )}

              {isComplete && (
                <div className="handoff-complete">
                  <Icon icon={CheckCircle2} size={18} />
                  <div>
                    <strong>Moved from <bdi>{reviewedSourceName}</bdi> to <bdi>{destinationHost?.name}</bdi>.</strong>
                    <p>Runtime-local Python state restarted; thread history, project state, goals, and durable resources were preserved.</p>
                    <small>Receipt <bdi>{completeReceipt}</bdi></small>
                  </div>
                </div>
              )}
            </>
          ) : null}

          {error && <p className="inline-error" role="alert"><Icon icon={AlertCircle} size={15} /> {error}</p>}
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{progressMessage}</div>
        </div>

        <footer className="sheet__footer">
          <p>{isComplete ? 'The destination is now authoritative.' : 'The source checkpoint is kept for rollback after the move.'}</p>
          <div className="sheet__footer-actions">
            {!isComplete && <button className="button button--quiet" type="button" autoFocus onClick={onClose} disabled={moving}>Cancel</button>}
            {isComplete ? (
              <button className="button button--primary" type="button" onClick={onClose}><Icon icon={ArrowRight} size={15} /> Continue thread</button>
            ) : (
              <button className="button button--primary" type="submit" disabled={!plan || moving || loading}>
                {moving ? <Icon icon={Loader2} size={15} /> : <Icon icon={RefreshCw} size={15} />}
                {moving ? 'Moving thread…' : `Move thread to ${destinationHost?.name ?? 'destination'}`}
              </button>
            )}
          </div>
        </footer>
      </form>
    </NativeDialog>
  )
}

function LocationSummary({ icon, label, name, detail }: { icon: LucideIcon; label: string; name: string; detail: string }) {
  return (
    <div className="location-summary">
      <span className="location-summary__icon"><Icon icon={icon} size={17} /></span>
      <span>
        <small>{label}</small>
        <strong><bdi>{name}</bdi></strong>
        <em>{detail}</em>
      </span>
    </div>
  )
}
