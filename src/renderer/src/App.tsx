import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowRight,
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
  Copy,
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
  Maximize2,
  Menu,
  MessageSquare,
  Minimize2,
  Monitor,
  Network,
  PanelLeftClose,
  PanelRightClose,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Square,
  Terminal,
  TestTube2,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  createRendererApi,
  isDefinitiveCandidateEvaluationStartError,
  isStaleHostAuthorityError,
  registeredWorkspaceProvisionHoldsAuthority,
  residentProvisionMayHaveDurableOperation,
  type ComposerReceiptState,
  type ConnectionState,
  type DiscoveredComputer,
  type HandoffPhase,
  type HandoffPlan,
  type HostRuntimeReadiness,
  type HostSummary,
  type LocalSetupStage,
  type LocalSetupSummary,
  type RendererApi,
  type ResidentEndPreparation,
  type ResidentLifecycleOperationSummary,
  type ResidentWorkspaceSelection,
  type ResidentWorkspaceSelectionInput,
  type RuntimeModelCatalog,
  type RuntimeOAuthProgress,
  type RuntimeOAuthRequest,
  type RuntimeOAuthResult,
  type RuntimeSummary,
  type TaskState,
  type ThreadSummary,
  type WorkbenchSnapshot,
} from './api'
import type { HudMode, HudState, HudTarget } from '../../shared/window-control'
import type {
  CandidateEvaluationPreflight,
  CandidateEvaluationPreflightRequest,
  CandidateEvaluationReviewIdentity,
  CandidateEvaluationSnapshot,
  CandidateEvaluationStartRequest,
  CandidateEvaluationStatus,
} from '../../shared/protocol'
import { installHudClickThrough } from './hud-click-through'
import { TranscriptBody } from './TranscriptBody'
import { FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, RefObject, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'

const INSPECTOR_TABS = ['Changes', 'Runtime', 'Evidence', 'Context'] as const
type InspectorTab = (typeof INSPECTOR_TABS)[number]
type ComposerReceiptView = {
  state: ComposerReceiptState
  message: string
  operation?: 'prompt' | 'abort' | 'end'
  retryable?: boolean
}
type ComposerLocalAction = {
  sequence: number
  operation: 'prompt' | 'abort'
}
type HostActivationView = {
  hostId: string
  phase: 'connecting' | 'error' | 'connected'
  message: string
}
type LocalSetupDiagnosticCopyState = 'idle' | 'copying' | 'copied' | 'failed'
type ResidentLifecycleRecoveryReference = {
  kind: 'provision'
  operationId: string
  expectedHostId: string
  suggestedName: string
  workspaceKind?: 'local_path' | 'registered_workspace'
  projectId?: string
  workspaceId?: string
  referenceThreadId?: string
  referenceExecutionGenerationId?: string
  threadId?: string
  executionGenerationId?: string
  status?: ResidentLifecycleStatusResult
}
type ResidentLifecycleStatusResult = NonNullable<Awaited<ReturnType<RendererApi['residentLifecycleStatus']>>>
type ResidentThreadFocusTarget = Pick<
  ResidentLifecycleStatusResult,
  'expectedHostId' | 'threadId' | 'executionGenerationId'
>
type ResidentEndDialogContext = {
  preparation: ResidentEndPreparation
  threadTitle: string
  hostName: string
}
const PRIME_AGENT_INSTALL_COMMAND = 'curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh'
const EMPTY_COMPOSER_ERROR = 'Describe the task before delegating to Prime Agent.'
const MAX_COMPOSER_DRAFTS = 128
const MODEL_REVEAL_INCREMENT = 80
const PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID = 'openai-codex'
const CANDIDATE_PREFLIGHT_REFRESH_MS = 25_000
const CANDIDATE_EVALUATION_POLL_MS = 1_500

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

function residentLifecycleHostIsCheckable(host: HostSummary | undefined): boolean {
  if (!host || host.connection !== 'online' || host.activationRequired) return false
  return (host.kind === 'local' && host.connectionPath === 'Local socket') ||
    (host.kind === 'ssh' && host.connectionPath === 'SSH')
}

function operationUsesRegisteredWorkspace(operation: ResidentLifecycleOperationSummary): boolean {
  return operation.kind === 'provision' && operation.provisionMode === 'registered_workspace'
}

function registeredWorkspaceRecoveryDonorIsSelected(
  source: ResidentLifecycleOperationSummary | ResidentLifecycleRecoveryReference,
  snapshot: WorkbenchSnapshot,
  selectedThread: ThreadSummary | undefined,
  selectedHost: HostSummary | undefined,
): boolean {
  const operation = 'state' in source ? source : undefined
  const recoveryReference = 'state' in source ? undefined : source
  const registeredWorkspace = operation
    ? operationUsesRegisteredWorkspace(operation)
    : recoveryReference?.workspaceKind === 'registered_workspace'
  if (!registeredWorkspace) return true

  const projectId = source.projectId
  const workspaceId = source.workspaceId
  const referenceThreadId = operation?.kind === 'provision'
    ? operation.referenceThreadId
    : recoveryReference?.referenceThreadId
  const referenceExecutionGenerationId = operation?.kind === 'provision'
    ? operation.referenceExecutionGenerationId
    : recoveryReference?.referenceExecutionGenerationId
  const project = projectId
    ? snapshot.projects.find((candidate) => candidate.id === projectId)
    : undefined
  return Boolean(
    projectId &&
    workspaceId &&
    referenceThreadId &&
    referenceExecutionGenerationId &&
    selectedHost?.kind === 'ssh' &&
    selectedHost.id === source.expectedHostId &&
    selectedThread &&
    snapshot.selectedProjectId === projectId &&
    snapshot.selectedThreadId === selectedThread.id &&
    selectedThread.hostId === source.expectedHostId &&
    selectedThread.projectId === projectId &&
    selectedThread.workspaceId === workspaceId &&
    (selectedThread.remoteId ?? selectedThread.id) === referenceThreadId &&
    selectedThread.executionGenerationId === referenceExecutionGenerationId &&
    project?.hostIds.includes(source.expectedHostId),
  )
}

function residentEndRecoveryIsSelected(
  operation: ResidentLifecycleOperationSummary,
  snapshot: WorkbenchSnapshot,
  selectedThread: ThreadSummary | undefined,
  selectedHost: HostSummary | undefined,
): boolean {
  if (operation.kind !== 'end') return false
  const project = snapshot.projects.find((candidate) => candidate.id === operation.projectId)
  return Boolean(
    selectedHost &&
    selectedHost.id === operation.expectedHostId &&
    selectedThread &&
    snapshot.selectedProjectId === operation.projectId &&
    snapshot.selectedThreadId === selectedThread.id &&
    selectedThread.hostId === operation.expectedHostId &&
    selectedThread.projectId === operation.projectId &&
    selectedThread.workspaceId === operation.workspaceId &&
    (selectedThread.remoteId ?? selectedThread.id) === operation.threadId &&
    selectedThread.executionGenerationId === operation.executionGenerationId &&
    project?.hostIds.includes(operation.expectedHostId),
  )
}

type RegisteredWorkspaceCreateBlock = 'active_resident' | 'setup_recovery'
type ResidentLifecycleMutationBlock =
  | RegisteredWorkspaceCreateBlock
  | 'capability_unavailable'
  | 'donor_not_selected'
  | 'target_not_selected'

function selectedRegisteredWorkspaceCreateBlock(
  snapshot: WorkbenchSnapshot | null,
  selectedThread: ThreadSummary | undefined,
  selectedHost: HostSummary | undefined,
  exemptOperationId?: string,
  fallbackReference?: ResidentLifecycleRecoveryReference | null,
): RegisteredWorkspaceCreateBlock | null {
  if (
    !snapshot ||
    selectedHost?.kind !== 'ssh' ||
    !selectedThread ||
    snapshot.selectedThreadId !== selectedThread.id ||
    !selectedThread.workspaceId ||
    !selectedThread.executionGenerationId
  ) return null

  if (
    snapshot.runtime.session?.residency === 'resident' &&
    selectedThread.residentLifecycle?.state !== 'ended'
  ) return 'active_resident'

  const holdingOperations = snapshot.residentLifecycleOperations.filter((operation) =>
    operation.operationId !== exemptOperationId &&
    operation.expectedHostId === selectedHost.id &&
    operation.projectId === selectedThread.projectId &&
    operation.workspaceId === selectedThread.workspaceId &&
    registeredWorkspaceProvisionHoldsAuthority(
      operation,
      snapshot.residentLifecycleOperations,
      snapshot.threads,
    ),
  )
  if (holdingOperations.some((operation) =>
    operation.lastStatus?.phase === 'promoted_observed' ||
    operation.lastStatus?.phase === 'projection_committed' ||
    operation.lastStatus?.phase === 'committed'
  )) {
    return 'active_resident'
  }
  if (holdingOperations.length > 0) return 'setup_recovery'

  const fallbackTargetsWorkspace = Boolean(
    fallbackReference &&
    fallbackReference.operationId !== exemptOperationId &&
    fallbackReference.workspaceKind === 'registered_workspace' &&
    fallbackReference.expectedHostId === selectedHost.id &&
    fallbackReference.projectId === selectedThread.projectId &&
    fallbackReference.workspaceId === selectedThread.workspaceId,
  )
  if (!fallbackTargetsWorkspace || !fallbackReference) return null
  if (fallbackReference.status?.kind === 'provision' && fallbackReference.status.phase === 'completed') {
    return null
  }
  return fallbackReference.status?.kind === 'provision' && (
    fallbackReference.status.phase === 'promoted_observed' ||
    fallbackReference.status.phase === 'projection_committed' ||
    fallbackReference.status.phase === 'committed'
  )
    ? 'active_resident'
    : 'setup_recovery'
}

function residentLifecycleMutationBlock(
  operation: ResidentLifecycleOperationSummary,
  snapshot: WorkbenchSnapshot,
  selectedThread: ThreadSummary | undefined,
  selectedHost: HostSummary | undefined,
  fallbackReference?: ResidentLifecycleRecoveryReference | null,
): ResidentLifecycleMutationBlock | null {
  if (operation.kind === 'end') {
    if (!residentEndRecoveryIsSelected(operation, snapshot, selectedThread, selectedHost)) {
      return 'target_not_selected'
    }
    return snapshot.operations.endResident === true ? null : 'capability_unavailable'
  }

  if (operationUsesRegisteredWorkspace(operation)) {
    if (!registeredWorkspaceRecoveryDonorIsSelected(operation, snapshot, selectedThread, selectedHost)) {
      return 'donor_not_selected'
    }
    const workspaceBlock = selectedRegisteredWorkspaceCreateBlock(
      snapshot,
      selectedThread,
      selectedHost,
      operation.operationId,
      fallbackReference,
    )
    if (workspaceBlock) return workspaceBlock
  }
  return snapshot.operations.provisionResident === true ? null : 'capability_unavailable'
}

function residentLifecycleFallbackMutationBlock(
  reference: ResidentLifecycleRecoveryReference,
  snapshot: WorkbenchSnapshot,
  selectedThread: ThreadSummary | undefined,
  selectedHost: HostSummary | undefined,
): ResidentLifecycleMutationBlock | null {
  if (reference.workspaceKind === 'registered_workspace') {
    if (!registeredWorkspaceRecoveryDonorIsSelected(reference, snapshot, selectedThread, selectedHost)) {
      return 'donor_not_selected'
    }
    const workspaceBlock = selectedRegisteredWorkspaceCreateBlock(
      snapshot,
      selectedThread,
      selectedHost,
      reference.operationId,
      reference,
    )
    if (workspaceBlock) return workspaceBlock
  }
  return snapshot.operations.provisionResident === true ? null : 'capability_unavailable'
}

function residentLifecycleMutationBlockedDetail(
  block: ResidentLifecycleMutationBlock,
  operationKind: 'provision' | 'end',
): string {
  if (block === 'donor_not_selected') {
    return 'Open the saved workspace and its original source thread to continue. You can still check the exact setup status here.'
  }
  if (block === 'active_resident') {
    return 'Another resident session owns this workspace. Open or select the resident thread, then choose End resident session in Runtime. You can still check this exact status here.'
  }
  if (block === 'setup_recovery') {
    return 'Another resident setup holds this workspace. Continue or inspect that setup before resuming this one. You can still check this exact status here.'
  }
  if (block === 'target_not_selected') {
    return 'Open or select the resident thread, then choose End resident session in Runtime. You can still check this exact end status here.'
  }
  return operationKind === 'end'
    ? 'Resident end control is unavailable for this verified host. You can still check the exact end status here.'
    : 'Resident lifecycle control is unavailable for this verified host. You can still check the exact setup status here.'
}

function AttentionDiagnostic({ item }: { item: WorkbenchSnapshot['attention'][number] }) {
  if (!item.diagnostic) return null
  return (
    <span className="attention-diagnostic">
      <code>{item.diagnostic.code}{item.diagnostic.diagnosticId ? ` · ${item.diagnostic.diagnosticId}` : ''}</code>
      <span>{item.diagnostic.message}</span>
      <em>
        {item.diagnostic.retryable
          ? 'Reconnect and inspect the current thread state before retrying.'
          : 'Do not retry automatically. Inspect the current thread state.'}
      </em>
    </span>
  )
}

function attentionDiagnosticText(item: WorkbenchSnapshot['attention'][number]): string {
  if (!item.diagnostic) return ''
  return [
    item.diagnostic.code,
    item.diagnostic.diagnosticId ? `Diagnostic ID: ${item.diagnostic.diagnosticId}` : undefined,
    item.diagnostic.message,
    item.diagnostic.retryable ? 'Retryable: yes' : 'Retryable: no',
  ].filter(Boolean).join('\n')
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.append(field)
  field.select()
  const copied = document.execCommand('copy')
  field.remove()
  if (!copied) throw new Error('Clipboard copy was rejected')
}

function localSetupDiagnosticText(setup: LocalSetupSummary): string {
  const stage = setup.stage === 'needs_attention' ? setup.stage : 'unknown'
  const area = setup.issue?.area === 'local_service' || setup.issue?.area === 'runtime'
    ? setup.issue.area
    : 'unknown'
  const code = setup.issue?.code && /^[A-Za-z0-9._-]{1,96}$/.test(setup.issue.code)
    ? setup.issue.code
    : 'not_reported'
  return [
    'PRIME_CONTINUIM_SETUP_DIAGNOSTIC',
    `Stage: ${stage}`,
    `Area: ${area}`,
    `Code: ${code}`,
    setup.issue?.action === 'repair_runtime'
      ? 'Next step: Use Repair runtime. If repair remains unavailable, share this diagnostic with Prime Continuim support.'
      : 'Next step: Share this diagnostic with Prime Continuim support.',
  ].join('\n')
}

function AttentionDiagnosticCopy({ item }: { item: WorkbenchSnapshot['attention'][number] }) {
  const [copied, setCopied] = useState(false)
  if (!item.diagnostic) return null
  return (
    <button
      className="attention-diagnostic__copy"
      type="button"
      aria-label={copied ? 'Diagnostic copied' : `Copy diagnostic ${item.diagnostic.code}`}
      onClick={() => {
        void writeClipboardText(attentionDiagnosticText(item)).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1_600)
        }).catch(() => setCopied(false))
      }}
    >
      <Icon icon={copied ? Check : Copy} size={13} />
      <span className="sr-only" aria-live="polite">{copied ? 'Diagnostic copied' : 'Copy diagnostic'}</span>
    </button>
  )
}

function composerActionAuthorityKey(hostId: string, thread: ThreadSummary): string {
  return `${hostId}\u0000${thread.remoteId ?? thread.id}\u0000${thread.executionGenerationId ?? ''}`
}

function rememberComposerDraft(drafts: Map<string, string>, authorityKey: string, text: string): void {
  drafts.delete(authorityKey)
  if (!text) return
  drafts.set(authorityKey, text)
  if (drafts.size <= MAX_COMPOSER_DRAFTS) return
  const oldestAuthorityKey = drafts.keys().next().value
  if (oldestAuthorityKey !== undefined) drafts.delete(oldestAuthorityKey)
}

function threadMatchesHudTarget(thread: ThreadSummary, target: HudTarget): boolean {
  return thread.hostId === target.expectedHostId &&
    (thread.id === target.threadId || thread.remoteId === target.threadId) &&
    thread.executionGenerationId === target.expectedExecutionGenerationId
}

function actionableResidentLifecycleOperations(
  operations: ResidentLifecycleOperationSummary[],
  threads: ThreadSummary[],
): ResidentLifecycleOperationSummary[] {
  return operations.filter((operation, index) => {
    if (operation.lastStatus?.phase === 'quarantined') return true
    if (operation.state !== 'terminal') return true
    if (operation.kind === 'end') {
      if (operation.lastStatus?.phase !== 'completed') return false
      return !threads.some((thread) =>
        thread.hostId === operation.expectedHostId &&
        (thread.remoteId ?? thread.id) === operation.threadId &&
        thread.executionGenerationId === operation.executionGenerationId &&
        thread.residentLifecycle?.operationId === operation.operationId,
      )
    }
    if (operation.lastStatus?.phase === 'committed') {
      return !threads.some((thread) =>
        thread.hostId === operation.expectedHostId &&
        (thread.remoteId ?? thread.id) === operation.threadId &&
        thread.executionGenerationId === operation.executionGenerationId,
      )
    }
    if (operation.lastStatus?.phase !== 'completed') return false
    // A later committed successor over the same immutable workspace identity
    // resolves a prior clean pre-effect failure. Uncertain or unresolved
    // entries are never hidden by an unrelated successful setup.
    return !operations.slice(0, index).some((newer) =>
      newer.lastStatus?.phase === 'committed' &&
      newer.projectId === operation.projectId &&
      newer.workspaceId === operation.workspaceId &&
      newer.threadId === operation.threadId &&
      newer.executionGenerationId === operation.executionGenerationId,
    )
  })
}

function residentLifecycleAnnouncement(status: ResidentLifecycleStatusResult | null): string {
  if (!status) return 'No durable setup record was returned. Prime Continuim will not retry it; check this host again before starting another resident thread.'
  if (status.kind === 'end') {
    if (status.phase === 'completed') return 'Resident session ended. The saved thread and workspace remain available.'
    if (status.phase === 'quarantined') {
      return 'Status checked. The end outcome needs manual inspection; Prime Continuim will not send another kill.'
    }
    return status.phase === 'ending'
      ? 'Status checked. Permanent ending is recorded but has not crossed the kill boundary.'
      : 'Status checked. Permanent ending is still settling; no mutation was replayed.'
  }
  if (status.phase === 'committed') {
    return 'Resident thread created. Opening its authoritative host snapshot.'
  }
  if (status.phase === 'quarantined') {
    return 'Status checked. This setup needs manual recovery; automatic retry remains blocked.'
  }
  if (status.phase === 'completed') {
    return status.completionReason === 'owned_create_cleaned'
      ? 'Status checked. The temporary session was cleaned up and no resident session remains.'
      : 'Status checked. Prime Agent did not create a resident session.'
  }
  return 'Status checked. The durable setup is still in progress and no mutation was replayed.'
}

function Icon({ icon: IconComponent, size = 16, strokeWidth = 1.75 }: { icon: LucideIcon; size?: number; strokeWidth?: number }) {
  return <IconComponent aria-hidden="true" focusable="false" size={size} strokeWidth={strokeWidth} />
}

function hostActivationFailureMessage(error: unknown): string {
  if (isStaleHostAuthorityError(error)) {
    return 'Unable to connect to this computer. This saved thread changed while the computer connected. Review the refreshed thread, then try again. No command was sent.'
  }
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : ''
  if (code === 'ssh.verified_host_binding_required' || code === 'ssh.verified_host_identity_invalid') {
    return 'Unable to connect to this computer. Its saved SSH verification is missing or changed. Add the computer again before connecting. No command was sent.'
  }
  if (code === 'ssh.host_identity_mismatch') {
    return 'Unable to connect to this computer. Its identity did not match the saved verification. Add the computer again to verify it before connecting. No command was sent.'
  }
  return 'Unable to connect to this computer. The connection could not be verified. Check this computer, then try again. No command was sent.'
}

type LocalSetupStepState = 'pending' | 'current' | 'complete' | 'error' | 'action'

function localSetupPresentation(setup: LocalSetupSummary): {
  heading: string
  description: string
  status: string
  icon: LucideIcon
} {
  if (setup.stage === 'choose_workspace') {
    return {
      heading: 'Choose a workspace',
      description: 'Choose a folder and Prime Continuim will create a durable resident thread for it.',
      status: 'The bundled Prime Agent runtime is verified.',
      icon: FolderGit2,
    }
  }
  if (setup.stage === 'needs_attention') {
    return {
      heading: 'Setup needs attention',
      description: 'Your files are unchanged. Resolve the local setup issue before choosing a workspace.',
      status: 'Local setup is paused.',
      icon: AlertCircle,
    }
  }
  if (setup.stage === 'preparing_runtime') {
    const readiness = runtimeReadinessCopy(setup.runtimeReadiness)
    return {
      heading: 'Getting Prime Continuim ready',
      description: 'Prime Continuim is verifying its bundled Prime Agent runtime. This can take a moment the first time.',
      status: setup.runtimeReadiness?.kind === 'reported' && setup.runtimeReadiness.status === 'ready'
        ? 'Finishing local setup…'
        : readiness?.summary ?? 'Checking the bundled Prime Agent runtime…',
      icon: ShieldCheck,
    }
  }
  return {
    heading: 'Getting Prime Continuim ready',
    description: 'Prime Continuim is starting its private local service. This can take a moment the first time.',
    status: 'Starting the local service…',
    icon: Server,
  }
}

function localSetupStepStates(setup: LocalSetupSummary): [LocalSetupStepState, LocalSetupStepState, LocalSetupStepState] {
  if (setup.stage === 'choose_workspace') return ['complete', 'complete', 'action']
  if (setup.stage === 'preparing_runtime') return ['complete', 'current', 'pending']
  if (setup.stage === 'needs_attention') {
    return setup.issue?.area === 'runtime'
      ? ['complete', 'error', 'pending']
      : ['error', 'pending', 'pending']
  }
  return ['current', 'pending', 'pending']
}

function LocalSetupProgress({ setup }: { setup: LocalSetupSummary }) {
  const states = localSetupStepStates(setup)
  const readiness = runtimeReadinessCopy(setup.runtimeReadiness)
  const steps: Array<{ label: string; detail: string; state: LocalSetupStepState }> = [
    {
      label: 'Start local service',
      detail: states[0] === 'complete' ? 'Connected on this computer' : states[0] === 'error' ? 'Could not start safely' : 'Starting on this computer',
      state: states[0],
    },
    {
      label: 'Verify Prime Agent runtime',
      detail: states[1] === 'complete'
        ? 'Bundled runtime verified'
        : states[1] === 'error'
          ? 'Verification paused'
          : states[1] === 'current'
            ? readiness?.summary ?? 'Checking bundled files'
            : 'Available after the local service starts',
      state: states[1],
    },
    {
      label: 'Choose a workspace',
      detail: states[2] === 'action' ? 'Ready for your folder' : 'Available after verification',
      state: states[2],
    },
  ]
  return (
    <section className="local-setup" aria-labelledby="local-setup-progress-title">
      <h2 className="sr-only" id="local-setup-progress-title">Local setup progress</h2>
      <ol className="local-setup__steps">
        {steps.map((step) => {
          const StepIcon = step.state === 'complete'
            ? Check
            : step.state === 'error'
              ? AlertCircle
              : step.state === 'current'
                ? Loader2
                : step.state === 'action'
                  ? ArrowRight
                  : Circle
          return (
            <li
              className={cx('local-setup__step', `local-setup__step--${step.state}`)}
              data-state={step.state}
              aria-current={step.state === 'current' || step.state === 'action' ? 'step' : undefined}
              key={step.label}
            >
              <span className="local-setup__step-icon"><Icon icon={StepIcon} size={16} /></span>
              <span className="local-setup__step-copy">
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path
          className="brand-mark__loop"
          d="M5.25 12c0-2.25 1.62-3.9 3.67-3.9 2.94 0 4.22 7.8 7.16 7.8 2.05 0 3.67-1.65 3.67-3.9s-1.62-3.9-3.67-3.9c-2.94 0-4.22 7.8-7.16 7.8-2.05 0-3.67-1.65-3.67-3.9Z"
        />
        <circle className="brand-mark__node" cx="12" cy="12" r="1.15" />
      </svg>
    </span>
  )
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

function taskIcon(status: TaskState): LucideIcon {
  const icons: Record<TaskState, LucideIcon> = {
    idle: Circle,
    running: Activity,
    waiting: Clock3,
    needs_approval: ShieldCheck,
    complete: CheckCircle2,
    failed: AlertCircle,
  }
  return icons[status]
}

type HudStatusTone = 'ready' | 'working' | 'needs-you' | 'offline' | 'done' | 'failed'

interface HudStatusPresentation {
  label: 'Ready' | 'Working' | 'Needs you' | 'Offline' | 'Done' | 'Failed'
  detail: string
  icon: LucideIcon
  tone: HudStatusTone
  needsWorkbench: boolean
}

function hudStatusPresentation(
  thread: ThreadSummary,
  connection: ConnectionState,
  receipt: ComposerReceiptView,
): HudStatusPresentation {
  if (connection !== 'online' || receipt.state === 'waiting_for_connection') {
    return {
      label: 'Offline',
      detail: 'The cached transcript is available. Return to the workbench to restore local authority.',
      icon: WifiOff,
      tone: 'offline',
      needsWorkbench: true,
    }
  }
  if (receipt.state === 'uncertain') {
    return {
      label: 'Needs you',
      detail: 'The last control outcome is uncertain. Review authoritative state in the workbench.',
      icon: AlertCircle,
      tone: 'needs-you',
      needsWorkbench: true,
    }
  }
  if (receipt.state === 'rejected' || thread.status === 'failed') {
    return {
      label: 'Failed',
      detail: receipt.message || 'Prime Agent reported a failure. Review the thread in the workbench.',
      icon: AlertCircle,
      tone: 'failed',
      needsWorkbench: true,
    }
  }
  if (thread.status === 'needs_approval' || thread.status === 'waiting') {
    return {
      label: 'Needs you',
      detail: thread.status === 'needs_approval'
        ? 'An approval needs review in the full workbench.'
        : 'Prime Agent is waiting for input. Open the workbench for the full review surface.',
      icon: thread.status === 'needs_approval' ? ShieldCheck : Clock3,
      tone: 'needs-you',
      needsWorkbench: true,
    }
  }
  if (
    thread.status === 'running' ||
    receipt.state === 'sending' ||
    receipt.state === 'sent' ||
    receipt.state === 'queued'
  ) {
    return {
      label: 'Working',
      detail: 'Prime Agent is working in this resident thread.',
      icon: Activity,
      tone: 'working',
      needsWorkbench: false,
    }
  }
  if (thread.status === 'complete') {
    return {
      label: 'Done',
      detail: 'Prime Agent completed the latest task.',
      icon: CheckCircle2,
      tone: 'done',
      needsWorkbench: false,
    }
  }
  return {
    label: 'Ready',
    detail: 'Prime Agent is ready for another prompt.',
    icon: Circle,
    tone: 'ready',
    needsWorkbench: false,
  }
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

function HudBoundarySurface({
  loading = false,
  detail,
  onReturnToWorkbench,
  onClose,
}: {
  loading?: boolean
  detail: string
  onReturnToWorkbench: () => void
  onClose: () => void
}) {
  return (
    <main
      className={cx('hud-shell', 'hud-shell--boundary', loading && 'hud-shell--loading')}
      data-hud-click-through="transparent"
      aria-labelledby="hud-boundary-heading"
    >
      <section className="hud-boundary" data-hud-interactive="true">
        <span className="hud-boundary__mark"><BrandMark /></span>
        <div className="hud-boundary__copy">
          <h1 id="hud-boundary-heading">{loading ? 'Opening desktop HUD…' : 'Desktop HUD unavailable'}</h1>
          <p>{detail}</p>
        </div>
        <div className="hud-boundary__actions">
          <button
            className="button button--secondary"
            type="button"
            aria-label="Return to workbench"
            onClick={onReturnToWorkbench}
          >
            <Icon icon={ArrowRight} size={14} /> <span>Return to workbench</span>
          </button>
          <button className="icon-button" type="button" aria-label="Close desktop HUD" title="Close desktop HUD" onClick={onClose}>
            <Icon icon={X} size={16} />
          </button>
        </div>
      </section>
    </main>
  )
}

export type AppSurface = 'workbench' | 'hud'

export interface AppProps {
  api?: RendererApi
  surface?: AppSurface
  initialThreadId?: string
}

export default function App({ api: suppliedApi, surface = 'workbench', initialThreadId = '' }: AppProps) {
  const api = useMemo(
    () => suppliedApi ?? createRendererApi({ allowConnectionInitiation: surface !== 'hud' }),
    [suppliedApi, surface],
  )
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null)
  const [loadError, setLoadError] = useState('')
  const [hudState, setHudState] = useState<HudState | null>(surface === 'hud' ? null : { state: 'closed' })
  const [hudBoundaryError, setHudBoundaryError] = useState('')
  const [hudActionError, setHudActionError] = useState('')
  const [threadSelectionError, setThreadSelectionError] = useState('')
  const [hostActivation, setHostActivation] = useState<HostActivationView | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selectedThreadId, setSelectedThreadId] = useState(initialThreadId)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('Changes')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [addComputerOpen, setAddComputerOpen] = useState(false)
  const [residentWorkspaceSelection, setResidentWorkspaceSelection] = useState<ResidentWorkspaceSelection | null>(null)
  const [residentProvisionOrigin, setResidentProvisionOrigin] = useState<'empty' | 'workbench' | 'recovery' | null>(null)
  const [residentWorkspacePicking, setResidentWorkspacePicking] = useState(false)
  const [residentStatusChecking, setResidentStatusChecking] = useState(false)
  const [residentWorkspaceError, setResidentWorkspaceError] = useState('')
  const [localSetupRetrying, setLocalSetupRetrying] = useState(false)
  const [localSetupRetryError, setLocalSetupRetryError] = useState('')
  const [localSetupDiagnosticCopyState, setLocalSetupDiagnosticCopyState] = useState<LocalSetupDiagnosticCopyState>('idle')
  const [localSetupDiagnosticFeedback, setLocalSetupDiagnosticFeedback] = useState('')
  const [localSetupDiagnosticFallback, setLocalSetupDiagnosticFallback] = useState('')
  const [residentLifecycleFeedback, setResidentLifecycleFeedback] = useState('')
  const [residentRecoveryReference, setResidentRecoveryReference] = useState<ResidentLifecycleRecoveryReference | null>(null)
  const [residentThreadFocusTarget, setResidentThreadFocusTarget] = useState<ResidentThreadFocusTarget | null>(null)
  const [residentEndContext, setResidentEndContext] = useState<ResidentEndDialogContext | null>(null)
  const [residentEndPreparing, setResidentEndPreparing] = useState(false)
  const [residentEndError, setResidentEndError] = useState('')
  const [moveThreadOpen, setMoveThreadOpen] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)
  const [moveDestinationId, setMoveDestinationId] = useState('')
  const [composerText, setComposerText] = useState('')
  const [composerValidationError, setComposerValidationError] = useState('')
  const [composerReceipt, setComposerReceipt] = useState<ComposerReceiptView>({
    state: 'idle',
    message: '',
  })
  const addComputerTriggerRef = useRef<HTMLButtonElement>(null)
  const addComputerReturnTargetRef = useRef<HTMLElement | null>(null)
  const residentProvisionReturnTargetRef = useRef<HTMLElement | null>(null)
  const localSetupWorkspaceButtonRef = useRef<HTMLButtonElement>(null)
  const localSetupIssueRef = useRef<HTMLDivElement>(null)
  const localSetupDiagnosticFallbackRef = useRef<HTMLTextAreaElement>(null)
  const localSetupDiagnosticRequestRef = useRef(0)
  const previousLocalSetupStageRef = useRef<LocalSetupStage | undefined>(undefined)
  const residentEndReturnTargetRef = useRef<HTMLElement | null>(null)
  const locationTriggerRef = useRef<HTMLSelectElement>(null)
  const moveThreadTriggerRef = useRef<HTMLElement>(null)
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const inspectorToggleRef = useRef<HTMLButtonElement>(null)
  const commandPaletteTriggerRef = useRef<HTMLButtonElement>(null)
  const modelsDialogTriggerRef = useRef<HTMLElement | null>(null)
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

  useEffect(() => {
    if (surface === 'hud') return
    const openPalette = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return
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
  const hostActivationRequestRef = useRef(0)
  const activeHostIdRef = useRef<string | undefined>(undefined)
  const activeThreadIdRef = useRef<string | undefined>(undefined)
  const composerAuthorityGenerationRef = useRef(0)
  const composerActionSequenceRef = useRef(0)
  const latestComposerActionsRef = useRef(new Map<string, ComposerLocalAction>())
  const composerDraftsRef = useRef(new Map<string, string>())
  const composerDraftAuthorityKeyRef = useRef('')
  const hudSelectionRequestRef = useRef('')
  const previousHudTargetKeyRef = useRef('')
  const hudFocusKeyRef = useRef('')

  const applySnapshot = useCallback((nextSnapshot: WorkbenchSnapshot) => {
    setSnapshot(nextSnapshot)
    setSelectedProjectId(nextSnapshot.selectedProjectId)
    setSelectedThreadId(nextSnapshot.selectedThreadId)
    const nextReceipt: ComposerReceiptView = {
      state: nextSnapshot.composerReceipt.state,
      message: nextSnapshot.composerReceipt.message ?? '',
      ...(nextSnapshot.composerReceipt.operation ? { operation: nextSnapshot.composerReceipt.operation } : {}),
      ...(nextSnapshot.composerReceipt.retryable !== undefined
        ? { retryable: nextSnapshot.composerReceipt.retryable }
        : {}),
    }
    const nextThread = nextSnapshot.threads.find((thread) => thread.id === nextSnapshot.selectedThreadId)
    if (nextThread && nextReceipt.state === 'idle') {
      // Native proof/reconciliation has reached an authoritative idle state
      // for this exact host/thread. Retire either local Run or Stop tail so a
      // deferred IPC resolve/reject cannot reclaim the composer afterward.
      latestComposerActionsRef.current.delete(composerActionAuthorityKey(nextThread.hostId, nextThread))
    }
    const latestAction = nextThread
      ? latestComposerActionsRef.current.get(composerActionAuthorityKey(nextThread.hostId, nextThread))
      : undefined
    setComposerReceipt((current) =>
      latestAction?.operation === 'abort' && nextReceipt.operation === 'prompt'
        ? current
        : nextReceipt,
    )
  }, [])

  useEffect(() => {
    if (surface !== 'hud') return
    let cancelled = false
    setHudBoundaryError('')
    const applyHudState = (nextState: HudState) => {
      if (!cancelled) setHudState(nextState)
    }
    void api.hudState()
      .then(applyHudState)
      .catch((error: unknown) => {
        if (!cancelled) {
          setHudBoundaryError(error instanceof Error
            ? error.message
            : 'The desktop HUD could not verify its native window state.')
        }
      })
    const unsubscribe = api.onHudState(applyHudState)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [api, surface])

  useEffect(() => {
    if (surface !== 'hud') return
    const previousTitle = document.title
    document.title = 'Prime Continuim HUD'
    return () => {
      document.title = previousTitle
    }
  }, [surface])

  useEffect(() => {
    if (surface !== 'hud') return
    return installHudClickThrough({
      document,
      window,
      setIgnoreMouseEvents: (ignore) => api.hudSetIgnoreMouseEvents(ignore),
    })
  }, [api, surface])

  useEffect(() => {
    let cancelled = false
    setLoadError('')
    void api
      .loadWorkbench()
      .then((nextSnapshot) => {
        if (cancelled) return
        applySnapshot(nextSnapshot)
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Unable to load the workbench.')
      })

    const unsubscribe = api.subscribe?.((nextSnapshot) => {
      if (!cancelled) {
        applySnapshot(nextSnapshot)
      }
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [api, applySnapshot])

  useEffect(() => {
    const stage = snapshot?.localSetup?.stage
    const previousStage = previousLocalSetupStageRef.current
    previousLocalSetupStageRef.current = stage
    if (stage !== 'needs_attention') {
      setLocalSetupRetrying(false)
      setLocalSetupRetryError('')
    }
    if (stage === 'choose_workspace' && previousStage && previousStage !== stage) {
      window.requestAnimationFrame(() => {
        const activeElement = document.activeElement
        if (!activeElement || activeElement === document.body || !activeElement.isConnected) {
          localSetupWorkspaceButtonRef.current?.focus()
        }
      })
    }
    if (stage === 'needs_attention' && previousStage !== stage) {
      window.requestAnimationFrame(() => {
        const activeElement = document.activeElement
        if (!activeElement || activeElement === document.body || !activeElement.isConnected) {
          localSetupIssueRef.current?.focus()
        }
      })
    }
  }, [snapshot?.localSetup?.stage])

  const localSetupDiagnosticIdentity = [
    snapshot?.localSetup?.stage ?? '',
    snapshot?.localSetup?.issue?.area ?? '',
    snapshot?.localSetup?.issue?.action ?? '',
    snapshot?.localSetup?.issue?.code ?? '',
  ].join('|')

  useEffect(() => {
    localSetupDiagnosticRequestRef.current += 1
    setLocalSetupDiagnosticCopyState('idle')
    setLocalSetupDiagnosticFeedback('')
    setLocalSetupDiagnosticFallback('')
  }, [localSetupDiagnosticIdentity])

  const selectedThread = snapshot?.threads.find((thread) => thread.id === selectedThreadId) ?? snapshot?.threads[0]
  const selectedProject =
    snapshot?.projects.find((project) => project.id === selectedThread?.projectId) ??
    snapshot?.projects.find((project) => project.id === selectedProjectId) ??
    snapshot?.projects[0]
  const selectedHost = snapshot?.hosts.find((host) => host.id === selectedThread?.hostId) ?? snapshot?.hosts[0]
  const selectedHostActivation = hostActivation?.hostId === selectedHost?.id ? hostActivation : null
  const hostActivationPending = selectedHostActivation?.phase === 'connecting'
  const canActivateSelectedHost = Boolean(
    surface === 'workbench' &&
    api.environment === 'native' &&
    selectedHost?.kind === 'ssh' &&
    (selectedHost.connection === 'offline' || selectedHost.activationRequired === true),
  )
  const activeResidentLifecycleHost = residentLifecycleHostIsCheckable(selectedHost)
    ? selectedHost
    : snapshot?.hosts.find((host) => host.kind === 'local' && residentLifecycleHostIsCheckable(host))
  const activeResidentLifecycleHostId = activeResidentLifecycleHost?.id
  const selectedRuntime: RuntimeSummary =
    snapshot && selectedThread && snapshot.selectedThreadId === selectedThread.id ? snapshot.runtime : {}
  const selectedThreadIsMaterialized = Boolean(snapshot && selectedThread && snapshot.selectedThreadId === selectedThread.id)
  const composerDraftAuthorityKey = selectedHost && selectedThread
    ? composerActionAuthorityKey(selectedHost.id, selectedThread)
    : ''

  useLayoutEffect(() => {
    if (composerDraftAuthorityKeyRef.current === composerDraftAuthorityKey) return
    composerDraftAuthorityKeyRef.current = composerDraftAuthorityKey
    composerAuthorityGenerationRef.current += 1
    setComposerText(composerDraftAuthorityKey ? composerDraftsRef.current.get(composerDraftAuthorityKey) ?? '' : '')
    setComposerValidationError('')
  }, [composerDraftAuthorityKey])

  const updateComposerText = (nextText: string) => {
    setComposerText(nextText)
    if (composerDraftAuthorityKey) {
      rememberComposerDraft(composerDraftsRef.current, composerDraftAuthorityKey, nextText)
    }
    if (composerValidationError) setComposerValidationError('')
  }

  const canStartResidentTurn = selectedThreadIsMaterialized && (snapshot?.operations.startResidentTurn ?? false)
  const canStopResidentTurn = selectedThreadIsMaterialized && (snapshot?.operations.stopResidentTurn ?? false)
  const canMoveThreads = snapshot?.operations.crossHostHandoff ?? false
  const canLoadModelCatalog = api.environment === 'native' && (snapshot?.operations.modelCatalog ?? false)
  const canSelectResidentModel = selectedThreadIsMaterialized && (snapshot?.operations.selectResidentModel ?? false)
  const canConnectRuntimeOAuth = Boolean(
    selectedHost &&
    selectedHost.kind === 'local' &&
    selectedHost.connection === 'online' &&
    snapshot?.operations.runtimeOAuth &&
    api.startRuntimeOAuth &&
    api.cancelRuntimeOAuth,
  )
  const canManageComputers = api.environment === 'native'
  const canProvisionResident = snapshot?.operations.provisionResident ?? false
  const registeredWorkspaceCreateBlock = selectedRegisteredWorkspaceCreateBlock(
    snapshot ?? null,
    selectedThread,
    selectedHost,
    undefined,
    residentRecoveryReference,
  )
  const residentLifecycleOperations = snapshot
    ? actionableResidentLifecycleOperations(snapshot.residentLifecycleOperations, snapshot.threads)
    : []
  const selectedResidentEnd = selectedThread?.executionGenerationId
    ? snapshot?.residentLifecycleOperations.find((operation) =>
        operation.kind === 'end' &&
        operation.expectedHostId === selectedThread.hostId &&
        operation.threadId === (selectedThread.remoteId ?? selectedThread.id) &&
        operation.executionGenerationId === selectedThread.executionGenerationId,
      )
    : undefined
  const canEndResident = Boolean(
    snapshot?.operations.endResident === true &&
    selectedThreadIsMaterialized &&
    residentLifecycleHostIsCheckable(selectedHost) &&
    selectedRuntime.session?.residency === 'resident' &&
    selectedThread?.workspaceId &&
    selectedThread.executionGenerationId &&
    !selectedResidentEnd &&
    selectedThread.residentLifecycle?.state !== 'ended',
  )
  const activeHudTarget = hudState && hudState.state !== 'closed' ? hudState.target : undefined
  const activeHudTargetKey = activeHudTarget
    ? [
        activeHudTarget.expectedHostId,
        activeHudTarget.threadId,
        activeHudTarget.expectedExecutionGenerationId,
      ].join('\u0000')
    : ''
  const exactHudThread = activeHudTarget
    ? snapshot?.threads.find((thread) => threadMatchesHudTarget(thread, activeHudTarget))
    : undefined
  const initialHudTargetMismatch = Boolean(
    surface === 'hud' &&
    initialThreadId &&
    exactHudThread &&
    exactHudThread.id !== initialThreadId &&
    exactHudThread.remoteId !== initialThreadId,
  )

  useEffect(() => {
    if (surface !== 'hud') return
    document.title = exactHudThread?.title
      ? `Prime Continuim HUD — ${exactHudThread.title}`
      : 'Prime Continuim HUD'
  }, [exactHudThread?.title, surface])
  const canOpenHud = Boolean(
    surface === 'workbench' &&
    api.environment === 'native' &&
    selectedThreadIsMaterialized &&
    selectedHost &&
    selectedThread?.executionGenerationId &&
    selectedThread.residentLifecycle?.state !== 'ended' &&
    selectedRuntime.session?.residency === 'resident' &&
    selectedRuntime.session.activeSessionId &&
    selectedRuntime.session.sessionId,
  )

  useLayoutEffect(() => {
    if (surface !== 'hud' || !activeHudTargetKey) return
    const previousTargetKey = previousHudTargetKeyRef.current
    previousHudTargetKeyRef.current = activeHudTargetKey
    if (!previousTargetKey || previousTargetKey === activeHudTargetKey) return
    composerAuthorityGenerationRef.current += 1
    latestComposerActionsRef.current.clear()
    setComposerValidationError('')
    setComposerReceipt({ state: 'idle', message: '' })
  }, [activeHudTargetKey, surface])

  useEffect(() => {
    if (
      residentRecoveryReference &&
      (
        snapshot?.residentLifecycleOperations.some((operation) =>
          operation.operationId === residentRecoveryReference.operationId &&
          operation.expectedHostId === residentRecoveryReference.expectedHostId,
        ) ||
        (
          residentRecoveryReference.threadId &&
          residentRecoveryReference.executionGenerationId &&
          snapshot?.threads.some((thread) =>
            thread.hostId === residentRecoveryReference.expectedHostId &&
            (thread.remoteId ?? thread.id) === residentRecoveryReference.threadId &&
            thread.executionGenerationId === residentRecoveryReference.executionGenerationId,
          )
        )
      )
    ) setResidentRecoveryReference(null)
  }, [residentRecoveryReference, snapshot])

  useEffect(() => {
    const registeredWorkspaceSelectionBlock = residentWorkspaceSelection
      ? selectedRegisteredWorkspaceCreateBlock(
          snapshot ?? null,
          selectedThread,
          selectedHost,
          residentWorkspaceSelection.operationId,
          residentRecoveryReference,
        )
      : registeredWorkspaceCreateBlock
    const registeredWorkspaceChanged = Boolean(
      residentWorkspaceSelection?.kind === 'registered_workspace' &&
      (
        selectedHost?.id !== residentWorkspaceSelection.expectedHostId ||
        selectedHost.kind !== 'ssh' ||
        !selectedThread ||
        snapshot?.selectedThreadId !== selectedThread.id ||
        selectedThread.projectId !== residentWorkspaceSelection.projectId ||
        selectedThread.workspaceId !== residentWorkspaceSelection.workspaceId ||
        (selectedThread.remoteId ?? selectedThread.id) !== residentWorkspaceSelection.referenceThreadId ||
        selectedThread.executionGenerationId !== residentWorkspaceSelection.referenceExecutionGenerationId ||
        registeredWorkspaceSelectionBlock
      ),
    )
    if (
      residentWorkspaceSelection &&
      (residentWorkspaceSelection.expectedHostId !== activeResidentLifecycleHostId || registeredWorkspaceChanged)
    ) {
      setResidentWorkspaceSelection(null)
      setResidentProvisionOrigin(null)
    }
    if (
      activeResidentLifecycleHostId &&
      residentThreadFocusTarget &&
      residentThreadFocusTarget.expectedHostId !== activeResidentLifecycleHostId
    ) {
      setResidentThreadFocusTarget(null)
    }
    if (
      activeResidentLifecycleHostId &&
      residentEndContext &&
      (
        residentEndContext.preparation.expectedHostId !== activeResidentLifecycleHostId ||
        !selectedThread ||
        (selectedThread.remoteId ?? selectedThread.id) !== residentEndContext.preparation.threadId ||
        selectedThread.executionGenerationId !== residentEndContext.preparation.executionGenerationId
      )
    ) {
      setResidentEndContext(null)
    }
  }, [
    activeResidentLifecycleHostId,
    residentEndContext,
    residentRecoveryReference,
    residentThreadFocusTarget,
    residentProvisionOrigin,
    residentWorkspaceSelection,
    registeredWorkspaceCreateBlock,
    selectedHost,
    selectedThread,
    snapshot,
  ])

  useEffect(() => {
    if (!snapshot || !residentThreadFocusTarget) return
    const exactThread = snapshot.threads.find((thread) =>
      thread.hostId === residentThreadFocusTarget.expectedHostId &&
      (thread.remoteId ?? thread.id) === residentThreadFocusTarget.threadId &&
      thread.executionGenerationId === residentThreadFocusTarget.executionGenerationId,
    )
    if (!exactThread || snapshot.selectedThreadId !== exactThread.id) return
    setResidentThreadFocusTarget(null)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('#thread-heading')?.focus())
    })
  }, [residentThreadFocusTarget, snapshot])

  useEffect(() => {
    if (
      surface !== 'hud' ||
      !snapshot ||
      !activeHudTarget ||
      !exactHudThread ||
      initialHudTargetMismatch
    ) return
    const selectionKey = [
      activeHudTarget.expectedHostId,
      exactHudThread.id,
      activeHudTarget.expectedExecutionGenerationId,
    ].join('\u0000')
    if (selectedThreadId !== exactHudThread.id) {
      composerAuthorityGenerationRef.current += 1
      setSelectedThreadId(exactHudThread.id)
      setSelectedProjectId(exactHudThread.projectId)
    }
    if (snapshot.selectedThreadId === exactHudThread.id || hudSelectionRequestRef.current === selectionKey) return
    hudSelectionRequestRef.current = selectionKey
    setThreadSelectionError('')
    void api.selectThread(exactHudThread.id).catch((error: unknown) => {
      setThreadSelectionError(error instanceof Error
        ? error.message
        : 'The desktop HUD could not materialize its pinned resident thread.')
    })
  }, [
    activeHudTarget,
    api,
    exactHudThread,
    initialHudTargetMismatch,
    selectedThreadId,
    snapshot,
    surface,
  ])

  useEffect(() => {
    if (surface !== 'hud' || hudState?.state !== 'expanded') return
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.key !== 'Escape') return
      if (document.querySelector('dialog[open], [role="dialog"], [role="menu"], [role="listbox"]')) return
      event.preventDefault()
      setHudActionError('')
      void api.hudSetMode('buddy')
        .then(setHudState)
        .catch((error: unknown) => {
          setHudActionError(error instanceof Error ? error.message : 'The desktop HUD could not collapse.')
        })
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [api, hudState?.state, surface])

  useEffect(() => {
    if (
      surface !== 'hud' ||
      !hudState ||
      hudState.state === 'closed' ||
      !exactHudThread ||
      snapshot?.selectedThreadId !== exactHudThread.id
    ) return
    const focusKey = [
      hudState.state,
      activeHudTarget?.expectedHostId ?? '',
      activeHudTarget?.threadId ?? '',
      activeHudTarget?.expectedExecutionGenerationId ?? '',
      snapshot.selectedThreadId,
    ].join('\u0000')
    if (hudFocusKeyRef.current === focusKey) return
    let innerFrame: number | undefined
    const frame = window.requestAnimationFrame(() => {
      innerFrame = window.requestAnimationFrame(() => {
        hudFocusKeyRef.current = focusKey
        if (hudState.state === 'buddy') {
          document.querySelector<HTMLButtonElement>('#hud-buddy-open')?.focus()
          return
        }
        const composer = document.querySelector<HTMLTextAreaElement>('#thread-composer')
        if (composer && !composer.disabled) composer.focus()
        else if (document.querySelector<HTMLButtonElement>('#resident-turn-primary:not(:disabled)')) {
          document.querySelector<HTMLButtonElement>('#resident-turn-primary:not(:disabled)')?.focus()
        } else {
          document.querySelector<HTMLElement>('#hud-thread-heading')?.focus()
        }
      })
    })
    return () => {
      window.cancelAnimationFrame(frame)
      if (innerFrame !== undefined) window.cancelAnimationFrame(innerFrame)
    }
  }, [
    activeHudTarget?.expectedExecutionGenerationId,
    activeHudTarget?.expectedHostId,
    activeHudTarget?.threadId,
    exactHudThread?.id,
    hudState?.state,
    snapshot?.selectedThreadId,
    surface,
  ])
  activeHostIdRef.current = selectedHost?.id
  activeThreadIdRef.current = selectedThread?.id

  useEffect(() => {
    if (!hostActivation || hostActivation.hostId === selectedHost?.id) return
    hostActivationRequestRef.current += 1
    setHostActivation(null)
  }, [hostActivation, selectedHost?.id])

  useEffect(() => {
    if (!selectedHost || !selectedThread) return
    if (selectedHost.connection !== 'online' || selectedHost.activationRequired) {
      setComposerReceipt((current) =>
        current.state === 'idle'
          ? {
              state: 'waiting_for_connection',
              message: selectedHost.activationRequired ? 'Waiting for connection verification' : 'Waiting for connection',
            }
          : current,
      )
    }
  }, [selectedHost, selectedThread])

  const selectThread = (thread: ThreadSummary) => {
    const requestId = ++threadSelectionRequestRef.current
    hostActivationRequestRef.current += 1
    setHostActivation(null)
    composerAuthorityGenerationRef.current += 1
    setThreadSelectionError('')
    setSelectedThreadId(thread.id)
    setSelectedProjectId(thread.projectId)
    const host = snapshot?.hosts.find((candidate) => candidate.id === thread.hostId)
    setComposerReceipt(
      host?.connection === 'online' && !host.activationRequired
        ? { state: 'idle', message: 'Ready for a new prompt' }
        : {
            state: 'waiting_for_connection',
            message: host?.activationRequired ? 'Waiting for connection verification' : 'Waiting for connection',
          },
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

  const activateSelectedComputer = async () => {
    if (!selectedHost || !canActivateSelectedHost || hostActivationPending) return
    const expectedHostId = selectedHost.id
    const requestId = ++hostActivationRequestRef.current
    setHostActivation({
      hostId: expectedHostId,
      phase: 'connecting',
      message: 'Connecting to this computer.',
    })
    try {
      const activatedSnapshot = await api.activateComputer(expectedHostId)
      if (
        hostActivationRequestRef.current !== requestId ||
        activeHostIdRef.current !== expectedHostId
      ) return
      applySnapshot(activatedSnapshot)
      setHostActivation({
        hostId: expectedHostId,
        phase: 'connected',
        message: 'Connected to this computer.',
      })
    } catch (error: unknown) {
      if (
        hostActivationRequestRef.current !== requestId ||
        activeHostIdRef.current !== expectedHostId
      ) return
      setHostActivation({
        hostId: expectedHostId,
        phase: 'error',
        message: hostActivationFailureMessage(error),
      })
    }
  }

  const selectProject = (projectId: string) => {
    setSelectedProjectId(projectId)
    const nextThread = snapshot?.threads.find((thread) => thread.projectId === projectId)
    if (nextThread) selectThread(nextThread)
  }

  const openMoveThread = (destinationHostId: string, trigger: HTMLElement | null = locationTriggerRef.current) => {
    if (!canMoveThreads) return
    if (!destinationHostId || destinationHostId === selectedHost?.id) return
    moveThreadTriggerRef.current = sidebarIsOverlay ? sidebarToggleRef.current : trigger
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
    if (!canStartResidentTurn || selectedHost.connection !== 'online') {
      setComposerReceipt({
        state: 'rejected',
        operation: 'prompt',
        message: selectedHost.connection === 'online'
          ? 'This resident session is not ready for a new prompt. Refresh the thread and try again.'
          : `Reconnect to ${selectedHost.name} before running a prompt.`,
      })
      return
    }
    const text = composerText.trim()
    if (!text) {
      const messageField = event.currentTarget.elements.namedItem('message')
      setComposerValidationError(EMPTY_COMPOSER_ERROR)
      window.requestAnimationFrame(() => {
        if (messageField instanceof HTMLTextAreaElement) messageField.focus()
      })
      return
    }
    setComposerValidationError('')
    const submissionHostId = selectedHost.id
    const submissionThreadId = selectedThread.id
    const submissionAuthorityGeneration = composerAuthorityGenerationRef.current
    const submittedDraft = composerText
    const actionKey = composerActionAuthorityKey(submissionHostId, selectedThread)
    const actionSequence = ++composerActionSequenceRef.current
    latestComposerActionsRef.current.set(actionKey, { sequence: actionSequence, operation: 'prompt' })
    setComposerReceipt({
      state: 'sending',
      message: `Starting Prime Agent on ${selectedHost.name}…`,
      operation: 'prompt',
    })

    try {
      const receipt = await api.sendComposer({
        threadId: selectedThread.id,
        text,
      })
      if (
        activeHostIdRef.current !== submissionHostId ||
        activeThreadIdRef.current !== submissionThreadId ||
        composerAuthorityGenerationRef.current !== submissionAuthorityGeneration
      ) return
      if (receipt.state !== 'rejected') {
        if (composerDraftsRef.current.get(actionKey) === submittedDraft) {
          composerDraftsRef.current.delete(actionKey)
        }
        setComposerText((current) => current === submittedDraft ? '' : current)
      }
      if (latestComposerActionsRef.current.get(actionKey)?.sequence !== actionSequence) return
      setComposerReceipt({ ...receipt, operation: 'prompt' })
    } catch (error) {
      if (
        isStaleHostAuthorityError(error) ||
        activeHostIdRef.current !== submissionHostId ||
        activeThreadIdRef.current !== submissionThreadId ||
        composerAuthorityGenerationRef.current !== submissionAuthorityGeneration ||
        latestComposerActionsRef.current.get(actionKey)?.sequence !== actionSequence
      ) return
      setComposerReceipt({
        state: 'uncertain',
        operation: 'prompt',
        message: error instanceof Error
          ? `${error.message} Prime Agent will not replay this prompt without proof.`
          : 'Prompt outcome unknown · Prime Agent will not replay it without proof.',
      })
    }
  }

  const stopResidentTurn = async () => {
    if (!snapshot || !selectedThread || !selectedHost) return
    if (!canStopResidentTurn || selectedHost.connection !== 'online') {
      setComposerReceipt({
        state: 'rejected',
        operation: 'abort',
        message: selectedHost.connection === 'online'
          ? 'Prime Agent does not report an active resident turn that can be stopped.'
          : `Reconnect to ${selectedHost.name} before stopping this turn.`,
      })
      return
    }
    const submissionHostId = selectedHost.id
    const submissionThreadId = selectedThread.id
    const submissionAuthorityGeneration = composerAuthorityGenerationRef.current
    const actionKey = composerActionAuthorityKey(submissionHostId, selectedThread)
    const actionSequence = ++composerActionSequenceRef.current
    latestComposerActionsRef.current.set(actionKey, { sequence: actionSequence, operation: 'abort' })
    setComposerReceipt({ state: 'sending', message: `Requesting a safe stop on ${selectedHost.name}…`, operation: 'abort' })
    try {
      const receipt = await api.abortThread(selectedThread.id)
      if (
        activeHostIdRef.current !== submissionHostId ||
        activeThreadIdRef.current !== submissionThreadId ||
        composerAuthorityGenerationRef.current !== submissionAuthorityGeneration ||
        latestComposerActionsRef.current.get(actionKey)?.sequence !== actionSequence
      ) return
      setComposerReceipt({ ...receipt, operation: 'abort' })
    } catch (error) {
      if (
        isStaleHostAuthorityError(error) ||
        activeHostIdRef.current !== submissionHostId ||
        activeThreadIdRef.current !== submissionThreadId ||
        composerAuthorityGenerationRef.current !== submissionAuthorityGeneration ||
        latestComposerActionsRef.current.get(actionKey)?.sequence !== actionSequence
      ) return
      setComposerReceipt({
        state: 'uncertain',
        operation: 'abort',
        retryable: false,
        message: error instanceof Error
          ? `${error.message} Prime Agent will not replay this stop request without proof.`
          : 'Stop outcome unknown · Prime Agent will not replay this request without proof.',
      })
    }
  }

  const setNativeHudMode = async (mode: HudMode) => {
    setHudActionError('')
    try {
      setHudState(await api.hudSetMode(mode))
    } catch (error) {
      setHudActionError(error instanceof Error
        ? error.message
        : mode === 'expanded' ? 'The desktop HUD could not open.' : 'The desktop HUD could not collapse.')
    }
  }

  const closeNativeHud = async () => {
    setHudActionError('')
    try {
      setHudState(await api.hudClose())
    } catch (error) {
      setHudActionError(error instanceof Error ? error.message : 'The desktop HUD could not close.')
    }
  }

  const returnToWorkbench = async () => {
    setHudActionError('')
    try {
      await api.hudReturnToWorkbench()
    } catch (error) {
      setHudActionError(error instanceof Error ? error.message : 'Prime Continuim could not focus the workbench.')
    }
  }

  const showDesktopHud = async () => {
    if (!canOpenHud || !selectedHost || !selectedThread?.executionGenerationId) return
    const target: HudTarget = {
      expectedHostId: selectedHost.id,
      threadId: selectedThread.id,
      expectedExecutionGenerationId: selectedThread.executionGenerationId,
    }
    setHudActionError('')
    try {
      await api.hudOpen(target)
    } catch (error) {
      setHudActionError(error instanceof Error ? error.message : 'The desktop HUD could not open.')
    }
  }

  const chooseResidentWorkspace = async (
    trigger: HTMLElement,
    resumeOperationId?: string,
    recoverySource?: ResidentLifecycleOperationSummary | ResidentLifecycleRecoveryReference,
  ) => {
    const recoveryOperation = recoverySource && 'state' in recoverySource
      ? recoverySource.kind === 'provision' ? recoverySource : undefined
      : undefined
    const recoveryReference = recoverySource && !('state' in recoverySource)
      ? recoverySource
      : undefined
    const workspaceKind = recoveryOperation?.provisionMode ?? recoveryReference?.workspaceKind ??
      (selectedHost?.kind === 'ssh' ? 'registered_workspace' : 'local_path')
    let selectionInput: ResidentWorkspaceSelectionInput | undefined
    if (workspaceKind === 'registered_workspace') {
      const conflictingAuthority = selectedRegisteredWorkspaceCreateBlock(
        snapshot ?? null,
        selectedThread,
        selectedHost,
        resumeOperationId,
        residentRecoveryReference,
      )
      if (conflictingAuthority) {
        setResidentWorkspaceError(conflictingAuthority === 'active_resident'
          ? 'Open or select the resident thread that owns this workspace, then choose End resident session in Runtime before creating another thread.'
          : 'Continue or inspect the earlier resident setup for this workspace before starting another thread.')
        window.requestAnimationFrame(() => trigger.focus())
        return
      }
      const projectId = recoveryOperation?.projectId ?? recoveryReference?.projectId ?? selectedProject?.id
      const workspaceId = recoveryOperation?.workspaceId ?? recoveryReference?.workspaceId ?? selectedThread?.workspaceId
      const referenceThreadId = recoveryOperation?.referenceThreadId ??
        recoveryReference?.referenceThreadId ??
        (selectedThread ? selectedThread.remoteId ?? selectedThread.id : undefined)
      const referenceExecutionGenerationId = recoveryOperation?.referenceExecutionGenerationId ??
        recoveryReference?.referenceExecutionGenerationId ??
        selectedThread?.executionGenerationId
      const exactReferenceIsMaterialized = Boolean(
        projectId &&
        workspaceId &&
        referenceThreadId &&
        referenceExecutionGenerationId &&
        selectedHost?.kind === 'ssh' &&
        residentLifecycleHostIsCheckable(selectedHost) &&
        selectedThread &&
        snapshot?.selectedThreadId === selectedThread.id &&
        selectedThread.projectId === projectId &&
        selectedThread.workspaceId === workspaceId &&
        (selectedThread.remoteId ?? selectedThread.id) === referenceThreadId &&
        selectedThread.executionGenerationId === referenceExecutionGenerationId,
      )
      if (!exactReferenceIsMaterialized) {
        setResidentWorkspaceError('Refresh this exact saved workspace before starting or recovering its resident thread.')
        window.requestAnimationFrame(() => trigger.focus())
        return
      }
      selectionInput = {
        kind: 'registered_workspace',
        projectId: projectId!,
        workspaceId: workspaceId!,
        referenceThreadId: referenceThreadId!,
        referenceExecutionGenerationId: referenceExecutionGenerationId!,
        ...(resumeOperationId ? { resumeOperationId } : {}),
      }
    } else if (resumeOperationId) {
      selectionInput = { resumeOperationId }
    }
    residentProvisionReturnTargetRef.current = trigger
    setResidentProvisionOrigin(resumeOperationId
      ? 'recovery'
      : !selectedThread || !selectedProject || !selectedHost ? 'empty' : 'workbench')
    setResidentWorkspaceError('')
    setResidentWorkspacePicking(true)
    try {
      const selection = await api.selectResidentWorkspace(selectionInput)
      setResidentWorkspaceSelection(selection)
    } catch (error) {
      setResidentProvisionOrigin(null)
      if ((error as { code?: string })?.code !== 'resident.workspace_selection_cancelled') {
        setResidentWorkspaceError(error instanceof Error
          ? error.message
          : workspaceKind === 'registered_workspace'
            ? 'The saved workspace could not be prepared.'
            : 'The workspace picker could not be opened.')
      }
      window.requestAnimationFrame(() => trigger.focus())
    } finally {
      setResidentWorkspacePicking(false)
    }
  }

  const retryLocalSetup = async () => {
    const retryingRuntime = snapshot?.localSetup?.issue?.action === 'retry_runtime'
    const repairingRuntime = snapshot?.localSetup?.issue?.action === 'repair_runtime'
    setLocalSetupRetryError('')
    setLocalSetupRetrying(true)
    try {
      if (repairingRuntime) await api.repairLocalRuntime()
      else await api.retryLocalSetup()
    } catch {
      setLocalSetupRetryError(repairingRuntime
        ? 'Runtime repair could not start. No saved project or workspace data was changed. Review the current setup status before trying again.'
        : retryingRuntime
          ? 'Runtime verification could not be retried. Review the current setup status and try again if the action remains available.'
          : 'Prime Continuim could not retry the local connection. Review the current setup status and try again if it remains available.')
    } finally {
      setLocalSetupRetrying(false)
    }
  }

  const copyLocalSetupDiagnostic = async () => {
    const setup = snapshot?.localSetup
    if (
      setup?.stage !== 'needs_attention' ||
      !setup.issue ||
      setup.issue.retryable ||
      (setup.issue.action !== 'review_diagnostics' &&
        setup.issue.action !== 'manual_recovery' &&
        setup.issue.action !== 'repair_runtime')
    ) return

    const diagnostic = localSetupDiagnosticText(setup)
    const requestId = ++localSetupDiagnosticRequestRef.current
    setLocalSetupDiagnosticCopyState('copying')
    setLocalSetupDiagnosticFeedback('Copying the path-free setup diagnostic…')
    setLocalSetupDiagnosticFallback('')
    try {
      await writeClipboardText(diagnostic)
      if (requestId !== localSetupDiagnosticRequestRef.current) return
      setLocalSetupDiagnosticCopyState('copied')
      setLocalSetupDiagnosticFeedback('Setup diagnostic copied. Share it with Prime Continuim support.')
    } catch {
      if (requestId !== localSetupDiagnosticRequestRef.current) return
      setLocalSetupDiagnosticCopyState('failed')
      setLocalSetupDiagnosticFallback(diagnostic)
      setLocalSetupDiagnosticFeedback('Unable to copy the setup diagnostic. Select the diagnostic below, copy it manually, and share it with Prime Continuim support.')
      window.requestAnimationFrame(() => {
        const field = localSetupDiagnosticFallbackRef.current
        field?.focus()
        field?.select()
      })
    }
  }

  const reviewResidentEnd = async (
    trigger: HTMLElement,
    recovery?: ResidentLifecycleOperationSummary,
  ) => {
    const recoveryEnd = recovery?.kind === 'end' ? recovery : undefined
    const thread = recoveryEnd
      ? snapshot?.threads.find((candidate) =>
          candidate.hostId === recoveryEnd.expectedHostId &&
          (candidate.remoteId ?? candidate.id) === recoveryEnd.threadId &&
          candidate.executionGenerationId === recoveryEnd.executionGenerationId,
        )
      : selectedThread
    const host = snapshot?.hosts.find((candidate) =>
      candidate.id === (recoveryEnd?.expectedHostId ?? thread?.hostId),
    )
    const expectedHostId = recoveryEnd?.expectedHostId ?? thread?.hostId
    const projectId = recoveryEnd?.projectId ?? thread?.projectId
    const workspaceId = recoveryEnd?.workspaceId ?? thread?.workspaceId
    const threadId = recoveryEnd?.threadId ?? (thread ? thread.remoteId ?? thread.id : undefined)
    const executionGenerationId = recoveryEnd?.executionGenerationId ?? thread?.executionGenerationId
    if (!expectedHostId || !projectId || !workspaceId || !threadId || !executionGenerationId) {
      setResidentEndError('Refresh this thread before reviewing permanent resident session ending.')
      window.requestAnimationFrame(() => trigger.focus())
      return
    }
    residentEndReturnTargetRef.current = trigger
    setResidentEndError('')
    setResidentEndPreparing(true)
    try {
      const preparation = await api.prepareResidentEnd({
        expectedHostId,
        projectId,
        workspaceId,
        threadId,
        executionGenerationId,
        ...(recoveryEnd ? { resumeOperationId: recoveryEnd.operationId } : {}),
      })
      setResidentEndContext({
        preparation,
        threadTitle: thread?.title ?? 'Resident thread',
        hostName: host?.name ?? 'this computer',
      })
    } catch (error) {
      setResidentEndError(error instanceof Error
        ? error.message
        : 'The resident session could not be prepared for review.')
      window.requestAnimationFrame(() => trigger.focus())
    } finally {
      setResidentEndPreparing(false)
    }
  }

  const checkResidentLifecycle = async (operation: ResidentLifecycleOperationSummary) => {
    setResidentWorkspaceError('')
    setResidentLifecycleFeedback(operation.kind === 'end'
      ? 'Checking the durable resident end status…'
      : 'Checking the durable resident setup status…')
    setResidentStatusChecking(true)
    try {
      const status = await api.residentLifecycleStatus({
        expectedHostId: operation.expectedHostId,
        operationId: operation.operationId,
      })
      setResidentLifecycleFeedback(status === null && operation.kind === 'end'
        ? 'No durable end record was returned. No permanent action was retried.'
        : residentLifecycleAnnouncement(status))
      if (status && (
        (status.kind === 'provision' && status.phase === 'committed') ||
        (status.kind === 'end' && status.phase === 'completed')
      )) {
        setResidentThreadFocusTarget({
          expectedHostId: status.expectedHostId,
          threadId: status.threadId,
          executionGenerationId: status.executionGenerationId,
        })
      }
    } catch (error) {
      setResidentWorkspaceError(error instanceof Error ? error.message : 'Recovery status is unavailable.')
      setResidentLifecycleFeedback('The durable resident setup status could not be checked.')
    } finally {
      setResidentStatusChecking(false)
    }
  }

  const checkResidentRecoveryReference = async (reference: ResidentLifecycleRecoveryReference) => {
    setResidentWorkspaceError('')
    setResidentLifecycleFeedback('Checking the durable resident setup status…')
    setResidentStatusChecking(true)
    try {
      const status = await api.residentLifecycleStatus({
        expectedHostId: reference.expectedHostId,
        operationId: reference.operationId,
      })
      setResidentLifecycleFeedback(residentLifecycleAnnouncement(status))
      if (!status) {
        setResidentRecoveryReference((current) => {
          if (
            current?.operationId !== reference.operationId ||
            current.expectedHostId !== reference.expectedHostId
          ) return current
          const { status: _staleStatus, ...preservedReference } = current
          return preservedReference
        })
      } else {
        if (status.kind !== 'provision') {
          throw new Error('The durable setup lookup returned a different resident lifecycle operation.')
        }
        setResidentRecoveryReference((current) =>
          current?.operationId === reference.operationId && current.expectedHostId === reference.expectedHostId
            ? {
                ...current,
                operationId: status.operationId,
                expectedHostId: status.expectedHostId,
                threadId: status.threadId,
                executionGenerationId: status.executionGenerationId,
                status,
              }
            : current,
        )
        if (status.phase === 'committed') {
          setResidentThreadFocusTarget({
            expectedHostId: status.expectedHostId,
            threadId: status.threadId,
            executionGenerationId: status.executionGenerationId,
          })
        }
      }
    } catch (error) {
      setResidentWorkspaceError(error instanceof Error ? error.message : 'Recovery status is unavailable.')
      setResidentLifecycleFeedback('The durable resident setup status could not be checked.')
    } finally {
      setResidentStatusChecking(false)
    }
  }

  const residentProvisionCommitted = (status: ResidentLifecycleStatusResult) => {
    setResidentLifecycleFeedback(residentLifecycleAnnouncement(status))
    setResidentThreadFocusTarget({
      expectedHostId: status.expectedHostId,
      threadId: status.threadId,
      executionGenerationId: status.executionGenerationId,
    })
  }

  if (surface === 'hud') {
    const showBoundary = (detail: string, loading = false) => (
      <HudBoundarySurface
        detail={detail}
        loading={loading}
        onReturnToWorkbench={() => void returnToWorkbench()}
        onClose={() => void closeNativeHud()}
      />
    )
    if (hudBoundaryError) return showBoundary(hudBoundaryError)
    if (loadError) return showBoundary(loadError)
    if (!hudState || !snapshot) {
      return showBoundary('Verifying the pinned resident thread without changing local runtime data.', true)
    }
    if (hudState.state === 'closed') {
      return showBoundary('This HUD session is closed. Return to the workbench to open it for a verified resident thread.')
    }
    if (initialHudTargetMismatch) {
      return showBoundary('The native HUD target changed before this renderer could verify it. No other thread was opened.')
    }
    if (!exactHudThread) {
      return showBoundary('The pinned host, thread, and execution generation are not present in the current authoritative snapshot.')
    }
    if (threadSelectionError) return showBoundary(threadSelectionError)
    if (snapshot.selectedThreadId !== exactHudThread.id || selectedThread?.id !== exactHudThread.id) {
      return showBoundary(`Opening ${exactHudThread.title} without falling back to another cached thread.`, true)
    }
    if (
      !selectedProject ||
      !selectedHost ||
      !selectedThreadIsMaterialized ||
      selectedRuntime.session?.residency !== 'resident' ||
      !selectedRuntime.session.activeSessionId ||
      !selectedRuntime.session.sessionId
    ) {
      return showBoundary('The pinned thread is not currently materialized as an attached resident Prime Agent session.')
    }

    const status = hudStatusPresentation(selectedThread, selectedHost.connection, composerReceipt)
    if (hudState.state === 'buddy') {
      return (
        <main
          className="hud-shell hud-shell--buddy"
          data-hud-click-through="transparent"
          aria-label="Prime Agent desktop buddy"
        >
          <section className="hud-buddy" data-hud-interactive="true">
            <div className="hud-buddy__drag">
              <BrandMark />
              <span className={cx('hud-status', `hud-status--${status.tone}`)} role="status" aria-live="polite">
                <Icon icon={status.icon} size={14} />
                <span>
                  <strong>{status.label}</strong>
                  <small title={selectedThread.title}>{selectedThread.title}</small>
                </span>
              </span>
            </div>
            <button
              id="hud-buddy-open"
              className="hud-buddy__open"
              type="button"
              aria-label={`${status.label}: ${selectedThread.title}. Open conversation`}
              title="Open conversation"
              onClick={() => void setNativeHudMode('expanded')}
            >
              <Icon icon={Maximize2} size={15} />
            </button>
          </section>
          {hudActionError && <p className="sr-only" role="alert">{hudActionError}</p>}
        </main>
      )
    }

    return (
      <main
        className="hud-shell hud-shell--expanded"
        data-hud-click-through="transparent"
        aria-labelledby="hud-thread-heading"
      >
        <section className="hud-expanded" data-hud-interactive="true">
          <header className="hud-expanded__header">
            <div className="hud-expanded__identity">
              <BrandMark />
              <div>
                <h1 id="hud-thread-heading" tabIndex={-1}>{selectedThread.title}</h1>
                <span className={cx('hud-status', `hud-status--${status.tone}`)} role="status" aria-live="polite">
                  <Icon icon={status.icon} size={13} />
                  <span>{status.label}</span>
                </span>
              </div>
            </div>
            <div className="hud-expanded__controls">
              <button
                className="button button--quiet hud-expanded__return"
                type="button"
                title="Return to workbench"
                onClick={() => void returnToWorkbench()}
              >
                <Icon icon={ArrowRight} size={14} /> <span>Workbench</span>
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Keep as desktop buddy"
                title="Keep as desktop buddy"
                onClick={() => void setNativeHudMode('buddy')}
              >
                <Icon icon={Minimize2} size={15} />
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Close desktop HUD"
                title="Close desktop HUD"
                onClick={() => void closeNativeHud()}
              >
                <Icon icon={X} size={16} />
              </button>
            </div>
          </header>
          <div className="hud-expanded__thread">
            {hudActionError && (
              <div className="hud-notice hud-notice--error" role="alert">
                <Icon icon={AlertCircle} size={14} /> <span>{hudActionError}</span>
              </div>
            )}
            {status.needsWorkbench && !hudActionError && (
              <div className={cx('hud-notice', `hud-notice--${status.tone}`)}>
                <Icon icon={status.icon} size={14} />
                <span>{status.detail}</span>
                <button className="button button--quiet" type="button" onClick={() => void returnToWorkbench()}>
                  Review in workbench
                </button>
              </div>
            )}
            <Transcript thread={selectedThread} />
            <Composer
              connection={selectedHost.connection}
              authorityVerified={!selectedHost.activationRequired}
              hostName={selectedHost.name}
              taskState={selectedThread.status}
              runtime={selectedRuntime}
              text={composerText}
              onTextChange={updateComposerText}
              validationError={composerValidationError}
              receipt={composerReceipt}
              canStartTurn={canStartResidentTurn}
              canStopTurn={canStopResidentTurn}
              modelCatalogAvailable={false}
              onOpenModelCatalog={() => undefined}
              onSubmit={submitComposer}
              onStop={() => void stopResidentTurn()}
            />
          </div>
        </section>
      </main>
    )
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
        <p>Opening Prime Continuim…</p>
      </div>
    )
  }

  const holdEmptyProvisionSurface = residentProvisionOrigin === 'empty' && (
    residentWorkspacePicking || residentWorkspaceSelection !== null
  )
  if (holdEmptyProvisionSurface || !selectedThread || !selectedProject || !selectedHost) {
    const actionableLifecycleOperations = actionableResidentLifecycleOperations(
      snapshot.residentLifecycleOperations,
      snapshot.threads,
    )
    const lifecycleOperations = actionableLifecycleOperations.length > 0
      ? actionableLifecycleOperations
      : snapshot.residentLifecycleOperations[0]
        ? [snapshot.residentLifecycleOperations[0]]
        : []
    const canProvisionResident = snapshot.operations.provisionResident === true
    const localSetup = snapshot.projects.length === 0 && snapshot.threads.length === 0
      ? snapshot.localSetup
      : undefined
    const setupPresentation = localSetup ? localSetupPresentation(localSetup) : undefined
    const recoveryFirst = Boolean(residentRecoveryReference || lifecycleOperations.length > 0)
    const setupIssueLabel = localSetup?.issue?.action === 'manual_recovery'
      ? 'Manual runtime recovery required'
      : localSetup?.issue?.action === 'repair_runtime'
        ? 'Runtime repair required'
      : localSetup?.issue?.action === 'retry_runtime'
        ? 'Runtime verification stopped'
      : localSetup?.issue?.area === 'runtime'
        ? 'Runtime verification paused'
        : 'Local service unavailable'
    const canCopyLocalSetupDiagnostic = localSetup?.stage === 'needs_attention' &&
      Boolean(localSetup.issue) &&
      localSetup.issue?.retryable === false &&
      (localSetup.issue?.action === 'review_diagnostics' ||
        localSetup.issue?.action === 'manual_recovery' ||
        localSetup.issue?.action === 'repair_runtime')
    return (
      <div className="empty-workbench">
        <header className="empty-workbench__topbar">
          <BrandMark />
          <strong>Prime Continuim</strong>
        </header>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {localSetupDiagnosticFeedback || residentLifecycleFeedback}
        </p>
        <main
          className={cx('empty-workbench__main', localSetup && 'empty-workbench__main--setup')}
          data-local-setup-stage={localSetup?.stage}
          id="main"
        >
          <span className={cx('empty-workbench__icon', localSetup?.stage === 'needs_attention' && 'empty-workbench__icon--danger')}>
            <Icon icon={recoveryFirst ? AlertCircle : setupPresentation?.icon ?? (canProvisionResident ? FolderGit2 : Inbox)} size={22} />
          </span>
          <h1>
            {recoveryFirst && localSetup
              ? 'Finish resident setup'
              : setupPresentation?.heading ?? (canProvisionResident ? 'Start a resident thread' : snapshot.projects.length > 0 ? 'No threads yet' : 'No projects yet')}
          </h1>
          <p>
            {recoveryFirst && localSetup
              ? 'Review the durable setup state first. Prime Continuim will not replay a resident create automatically.'
              : setupPresentation?.description ?? (canProvisionResident
              ? 'Choose a workspace folder, confirm its names, and Prime Agent will keep the thread available after this window closes.'
              : snapshot.projects.length > 0
                ? 'Reconnect the verified local host to start a resident thread, or open a durable thread that is already available.'
                : 'Connect a verified local host to start a resident thread from one of your workspace folders.')}
          </p>
          {setupPresentation && (
            <p className="local-setup__status" role="status" aria-live="polite" aria-atomic="true">
              {setupPresentation.status}
            </p>
          )}
          {residentRecoveryReference && (
            <ResidentLifecycleFallbackCard
              reference={residentRecoveryReference}
              mutationBlock={residentLifecycleFallbackMutationBlock(
                residentRecoveryReference,
                snapshot,
                selectedThread,
                selectedHost,
              )}
              checkable={residentLifecycleHostIsCheckable(snapshot.hosts.find((host) =>
                host.id === residentRecoveryReference.expectedHostId,
              ))}
              busy={residentWorkspacePicking || residentStatusChecking}
              onChoose={(event) => void chooseResidentWorkspace(
                event.currentTarget,
                residentRecoveryReference.operationId,
                residentRecoveryReference,
              )}
              onCheck={() => void checkResidentRecoveryReference(residentRecoveryReference)}
            />
          )}
          {lifecycleOperations.length > 0 && (
            <ResidentLifecycleRecoveryList
              operations={lifecycleOperations}
              mutationBlock={(operation) => residentLifecycleMutationBlock(
                operation,
                snapshot,
                selectedThread,
                selectedHost,
                residentRecoveryReference,
              )}
              isCheckable={(operation) => residentLifecycleHostIsCheckable(snapshot.hosts.find((host) =>
                host.id === operation.expectedHostId,
              ))}
              busy={residentWorkspacePicking || residentStatusChecking}
              onChoose={(operation, event) => void (operation.kind === 'end'
                ? reviewResidentEnd(event.currentTarget, operation)
                : chooseResidentWorkspace(event.currentTarget, operation.operationId, operation))}
              onCheck={(operation) => void checkResidentLifecycle(operation)}
            />
          )}
          {localSetup && <LocalSetupProgress setup={localSetup} />}
          {localSetup?.stage === 'needs_attention' && localSetup.issue && (
            <div className="local-setup__issue" role="alert" tabIndex={-1} ref={localSetupIssueRef}>
              <span><Icon icon={AlertCircle} size={16} /></span>
              <div>
                <strong>{setupIssueLabel}</strong>
                <p>{localSetup.issue.message}</p>
                {localSetup.issue.code && <code>{localSetup.issue.code}</code>}
                {canCopyLocalSetupDiagnostic && (
                  <p>Copy the path-free setup diagnostic and share it with Prime Continuim support.</p>
                )}
              </div>
            </div>
          )}
          <div className="empty-workbench__actions">
            {(!localSetup || (localSetup.stage === 'choose_workspace' && !recoveryFirst)) && canProvisionResident && (
              <button
                ref={localSetup ? localSetupWorkspaceButtonRef : undefined}
                className="button button--primary"
                type="button"
                disabled={residentWorkspacePicking}
                aria-busy={residentWorkspacePicking}
                onClick={(event) => void chooseResidentWorkspace(event.currentTarget)}
              >
                <Icon icon={residentWorkspacePicking ? Loader2 : FolderGit2} />
                {residentWorkspacePicking ? 'Opening folder picker…' : 'Choose workspace folder'}
              </button>
            )}
            {selectedHost && canLoadModelCatalog && (
              <button
                className="button button--secondary"
                type="button"
                onClick={(event) => {
                  modelsDialogTriggerRef.current = event.currentTarget
                  setModelsOpen(true)
                }}
              >
                <Icon icon={Bot} /> Models &amp; accounts
              </button>
            )}
            {localSetup?.stage === 'needs_attention' &&
              (localSetup.issue?.action === 'retry_connection' || localSetup.issue?.action === 'retry_runtime') &&
              localSetup.issue.retryable && (
              <button
                className="button button--primary"
                type="button"
                disabled={localSetupRetrying}
                aria-busy={localSetupRetrying}
                onClick={() => void retryLocalSetup()}
              >
                <Icon icon={localSetupRetrying ? Loader2 : RefreshCw} />
                {localSetup.issue.action === 'retry_runtime'
                  ? localSetupRetrying ? 'Retrying verification…' : 'Retry runtime verification'
                  : localSetupRetrying ? 'Retrying local service…' : 'Retry local service'}
              </button>
            )}
            {localSetup?.stage === 'needs_attention' &&
              localSetup.issue?.action === 'repair_runtime' && (
              <button
                className="button button--primary"
                type="button"
                disabled={localSetupRetrying}
                aria-busy={localSetupRetrying}
                onClick={() => void retryLocalSetup()}
              >
                <Icon icon={localSetupRetrying ? Loader2 : RefreshCw} />
                {localSetupRetrying ? 'Repairing runtime…' : 'Repair runtime'}
              </button>
            )}
            {canCopyLocalSetupDiagnostic && (
              <button
                className={cx(
                  'button',
                  localSetup?.issue?.action === 'repair_runtime' ? 'button--secondary' : 'button--primary',
                )}
                type="button"
                disabled={localSetupDiagnosticCopyState === 'copying'}
                aria-busy={localSetupDiagnosticCopyState === 'copying'}
                onClick={() => void copyLocalSetupDiagnostic()}
              >
                <Icon icon={localSetupDiagnosticCopyState === 'copying' ? Loader2 : localSetupDiagnosticCopyState === 'copied' ? Check : Copy} />
                {localSetupDiagnosticCopyState === 'copying'
                  ? 'Copying diagnostic…'
                  : localSetupDiagnosticCopyState === 'copied'
                    ? 'Setup diagnostic copied'
                    : 'Copy setup diagnostic'}
              </button>
            )}
            {canManageComputers && (
              <button
                ref={addComputerTriggerRef}
                className={cx('button', localSetup || canProvisionResident ? 'button--secondary' : 'button--primary')}
                type="button"
                onClick={(event) => {
                  addComputerReturnTargetRef.current = event.currentTarget
                  setAddComputerOpen(true)
                }}
              >
                <Icon icon={Computer} /> {localSetup ? 'Use another computer' : 'Add computer'}
              </button>
            )}
          </div>
          {localSetupDiagnosticFallback && (
            <div className="local-setup__diagnostic-fallback">
              <strong>Clipboard unavailable</strong>
              <p id="local-setup-diagnostic-instructions">
                The diagnostic is selected below. Copy it manually and share it with Prime Continuim support.
              </p>
              <label htmlFor="local-setup-diagnostic">Setup diagnostic</label>
              <textarea
                ref={localSetupDiagnosticFallbackRef}
                id="local-setup-diagnostic"
                readOnly
                rows={5}
                value={localSetupDiagnosticFallback}
                aria-describedby="local-setup-diagnostic-instructions"
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          )}
          {(residentWorkspaceError || localSetupRetryError) && (
            <p className="form-error empty-workbench__error" role="alert">{residentWorkspaceError || localSetupRetryError}</p>
          )}
          <small>
            {localSetup
              ? localSetup.stage === 'choose_workspace'
                ? 'The folder path stays with the verified local host. Prime Continuim does not display it or send it to another computer.'
                : 'Workspace access remains disabled until the bundled runtime and local authority are verified.'
              : 'Your verified local host uses this folder for the workspace. Prime Continuim does not display its location or send it to another computer.'}
          </small>
        </main>
        <ResidentProvisionDialog
          api={api}
          selection={residentWorkspaceSelection}
          triggerRef={residentProvisionReturnTargetRef}
          onClose={() => {
            setResidentWorkspaceSelection(null)
            setResidentProvisionOrigin(null)
          }}
          onRecoveryRequired={setResidentRecoveryReference}
          onCommitted={residentProvisionCommitted}
        />
        <AddComputerDialog
          api={api}
          open={addComputerOpen}
          onClose={() => setAddComputerOpen(false)}
          triggerRef={addComputerReturnTargetRef}
        />
        {selectedHost && (
          <ModelsDialog
            api={api}
            open={modelsOpen}
            host={selectedHost}
            threadId={selectedThread?.id}
            executionGenerationId={selectedThread?.executionGenerationId}
            currentModel={selectedRuntime.session?.model}
            canSelectResidentModel={canSelectResidentModel}
            canConnectRuntimeOAuth={canConnectRuntimeOAuth}
            triggerRef={modelsDialogTriggerRef}
            onClose={() => setModelsOpen(false)}
          />
        )}
      </div>
    )
  }

  const compatibleHosts = snapshot.hosts.filter((host) => selectedProject.hostIds.includes(host.id))
  const isDisconnected = selectedHost.connection !== 'online'
  const showConnectionNotice = Boolean(
    isDisconnected ||
    selectedHost.activationRequired === true ||
    selectedHostActivation?.phase === 'connecting' ||
    selectedHostActivation?.phase === 'error',
  )
  const connectionNoticeHeading = selectedHostActivation?.phase === 'error'
    ? 'Unable to connect to this computer'
    : selectedHostActivation?.phase === 'connecting'
      ? 'Connecting to this computer'
      : selectedHost.activationRequired
        ? 'Connection verification required'
      : connectionCopy(selectedHost.connection, selectedHost)
  const connectionNoticeDetail = selectedHostActivation?.phase === 'error'
    ? selectedHostActivation.message.replace(/^Unable to connect to this computer\.\s*/, '')
    : selectedHostActivation?.phase === 'connecting'
      ? 'Cached transcript remains available while Prime Agent verifies this computer.'
      : selectedHost.activationRequired
        ? 'Review this saved thread, then connect again before sending a command.'
      : selectedHost.connection === 'offline'
        ? 'Cached transcript remains available.'
        : 'The task may still be running.'
  const connectionStatusAnnouncement = selectedHostActivation?.message || (
    selectedHost.activationRequired
      ? 'Connection verification required. Review this saved thread, then connect again before sending a command.'
      : isDisconnected
        ? connectionCopy(selectedHost.connection, selectedHost)
        : ''
  )
  const taskStateIsStale = isDisconnected && !['complete', 'failed'].includes(selectedThread.status)
  const visibleTaskState = taskStateIsStale
    ? `Last seen ${taskLabel(selectedThread.status).toLowerCase()}`
    : taskLabel(selectedThread.status)

  return (
    <div className="app-shell" data-sidebar-open={sidebarOpen} data-inspector-open={inspectorOpen}>
      <a className="skip-link" href="#main">Skip to thread</a>
      <div id="connection-status" className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {connectionStatusAnnouncement}
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {residentLifecycleFeedback}
      </p>

      <header className="topbar" inert={sidebarIsModal || inspectorIsModal ? true : undefined}>
        <div className="topbar__leading">
          <button
            ref={sidebarToggleRef}
            className="icon-button topbar__mobile-control"
            type="button"
            aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
            title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
            aria-expanded={sidebarOpen}
            aria-controls="project-sidebar"
            onClick={() => {
              setInspectorOpen(false)
              setSidebarOpen((value) => !value)
            }}
          >
            <Icon icon={sidebarOpen ? PanelLeftClose : Menu} size={18} />
          </button>
          <BrandMark />
          <strong className="topbar__brand-name">Prime Continuim</strong>
        </div>

        <div className="topbar__thread">
          <span className="topbar__thread-icon"><Icon icon={FolderGit2} size={16} /></span>
          <div className="topbar__thread-copy">
            <h1 id="thread-heading" tabIndex={-1}>{selectedThread.title}</h1>
            <span>{selectedProject.name} <span aria-hidden="true">·</span> {selectedProject.branch}</span>
          </div>
        </div>

        <div className="topbar__controls">
          <div
            className={cx('task-state', taskStateIsStale ? 'task-state--stale' : `task-state--${selectedThread.status}`)}
            aria-hidden="true"
            title={`Task state: ${visibleTaskState}`}
          >
            <Icon icon={taskIcon(selectedThread.status)} size={14} />
            <span className="task-state__label">{visibleTaskState}</span>
          </div>
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            Task state: {visibleTaskState}
          </span>

              {canOpenHud && (
                <button
                  className="icon-button topbar__hud-control"
                  type="button"
                  aria-label="Show desktop HUD"
                  title="Show desktop HUD"
                  onClick={() => void showDesktopHud()}
                >
                  <Icon icon={MessageSquare} size={17} />
                </button>
              )}

              <button
                ref={commandPaletteTriggerRef}
                className="command-trigger"
                type="button"
                aria-label="Search projects, threads, and commands"
                aria-haspopup="dialog"
                title="Search projects, threads, and commands"
                onClick={openCommandPalette}
              >
                <Icon icon={Search} size={15} />
                <span>Search or run…</span>
                <kbd>{commandShortcutLabel()}</kbd>
              </button>

              <div className="run-location">
            <span className="run-location__label">Run location</span>
            <span className={cx('connection-dot', `connection-dot--${selectedHost.connection}`)} aria-hidden="true" />
            {canMoveThreads ? (
              <>
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
              </>
            ) : (
              <span
                className="run-location__static"
                aria-label={`Run location: ${selectedHost.name}. Moving threads between computers is unavailable`}
              >
                <bdi>{selectedHost.name}</bdi>
                <small>Move unavailable</small>
              </span>
            )}
              </div>

              <button
                ref={inspectorToggleRef}
                className="icon-button topbar__inspector-control"
                type="button"
                aria-label={inspectorOpen ? 'Close inspector' : 'Open inspector'}
                title={inspectorOpen ? 'Close inspector' : 'Open inspector'}
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
        primeControlsVisible
        onClose={closeSidebar}
        onAddComputer={(trigger) => {
          addComputerReturnTargetRef.current = sidebarIsOverlay ? sidebarToggleRef.current : trigger
          closeSidebar()
          setAddComputerOpen(true)
        }}
        onProvisionResident={(trigger) => {
          const returnTarget = sidebarIsOverlay ? sidebarToggleRef.current : trigger
          closeSidebar()
          if (returnTarget) void chooseResidentWorkspace(returnTarget)
        }}
        onRecoverResident={(operation, trigger) => {
          const returnTarget = sidebarIsOverlay ? sidebarToggleRef.current : trigger
          closeSidebar()
          if (returnTarget) void (operation.kind === 'end'
            ? reviewResidentEnd(returnTarget, operation)
            : chooseResidentWorkspace(returnTarget, operation.operationId, operation))
        }}
        onCheckResident={(operation) => void checkResidentLifecycle(operation)}
        onRecoverResidentReference={(reference, trigger) => {
          const returnTarget = sidebarIsOverlay ? sidebarToggleRef.current : trigger
          closeSidebar()
          if (returnTarget) void chooseResidentWorkspace(returnTarget, reference.operationId, reference)
        }}
        onCheckResidentReference={(reference) => void checkResidentRecoveryReference(reference)}
        onOpenModels={(trigger) => {
          modelsDialogTriggerRef.current = sidebarIsOverlay ? sidebarToggleRef.current : trigger
          if (sidebarIsOverlay) closeSidebar()
          setModelsOpen(true)
        }}
        onMoveThread={openMoveThread}
        canMoveThread={canMoveThreads}
        canLoadModelCatalog={canLoadModelCatalog}
        canManageComputers={canManageComputers}
        canProvisionResident={canProvisionResident}
        registeredWorkspaceCreateBlock={registeredWorkspaceCreateBlock}
        residentLifecycleOperations={residentLifecycleOperations}
        residentRecoveryReference={residentRecoveryReference}
        residentLifecycleBusy={residentWorkspacePicking || residentStatusChecking}
        addComputerTriggerRef={addComputerTriggerRef}
        containerRef={sidebarPanelRef}
        modal={sidebarIsModal}
        inert={inspectorIsModal}
      />

      <main className="thread-view" id="main" tabIndex={-1} inert={sidebarIsModal || inspectorIsModal ? true : undefined}>
        <div className="thread-notices">
          {showConnectionNotice && (
            <div className={cx('connection-notice', `connection-notice--${selectedHost.connection}`)}>
              <span className="connection-notice__icon">
                <Icon
                  icon={selectedHostActivation?.phase === 'error'
                    ? AlertCircle
                    : selectedHost.connection === 'offline'
                      ? WifiOff
                      : RefreshCw}
                  size={14}
                />
              </span>
              <span>{connectionNoticeHeading}</span>
              <span className="connection-notice__detail">
                {connectionNoticeDetail}
              </span>
              {(canActivateSelectedHost || hostActivationPending) && (
                <button
                  className="button button--secondary button--small connection-notice__action"
                  type="button"
                  disabled={hostActivationPending}
                  aria-busy={hostActivationPending}
                  aria-describedby="connection-status"
                  onClick={() => void activateSelectedComputer()}
                >
                  <Icon icon={Network} size={14} />
                  <span>Connect to this computer</span>
                </button>
              )}
            </div>
          )}

          {threadSelectionError && (
            <div className="connection-notice connection-notice--offline" role="alert">
              <span className="connection-notice__icon"><Icon icon={AlertCircle} size={14} /></span>
              <span>{threadSelectionError}</span>
              <span className="connection-notice__detail">The cached thread summary remains available.</span>
            </div>
          )}

          {hudActionError && (
            <div className="connection-notice connection-notice--offline" role="alert">
              <span className="connection-notice__icon"><Icon icon={AlertCircle} size={14} /></span>
              <span>Desktop HUD unavailable</span>
              <span className="connection-notice__detail">{hudActionError}</span>
            </div>
          )}

          {residentWorkspaceError && (
            <div className="connection-notice connection-notice--offline" role="alert">
              <span className="connection-notice__icon"><Icon icon={AlertCircle} size={14} /></span>
              <span>Resident setup needs attention</span>
              <span className="connection-notice__detail">{residentWorkspaceError}</span>
            </div>
          )}
        </div>

        <Transcript thread={selectedThread} />

        <Composer
              connection={selectedHost.connection}
              authorityVerified={!selectedHost.activationRequired}
              hostName={selectedHost.name}
              taskState={selectedThread.status}
              runtime={selectedRuntime}
              text={composerText}
              onTextChange={updateComposerText}
              validationError={composerValidationError}
              receipt={composerReceipt}
              canStartTurn={canStartResidentTurn}
              canStopTurn={canStopResidentTurn}
              modelCatalogAvailable={canLoadModelCatalog}
              onOpenModelCatalog={(trigger) => {
                modelsDialogTriggerRef.current = trigger
                setModelsOpen(true)
              }}
              onSubmit={submitComposer}
              onStop={() => void stopResidentTurn()}
        />
      </main>

      <Inspector
          api={api}
          snapshot={snapshot}
          selectedThread={selectedThread}
          selectedProject={selectedProject}
          selectedHost={selectedHost}
          runtime={selectedRuntime}
          activeTab={inspectorTab}
          onTabChange={setInspectorTab}
          onClose={closeInspector}
          containerRef={inspectorPanelRef}
          modal={inspectorIsModal}
          inert={sidebarIsModal}
          canEndResident={canEndResident}
          residentEndPreparing={residentEndPreparing}
          residentEndError={residentEndError}
          onEndResident={(trigger) => void reviewResidentEnd(trigger)}
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
        triggerRef={addComputerReturnTargetRef}
      />

      <ResidentProvisionDialog
        api={api}
        selection={residentWorkspaceSelection}
        triggerRef={residentProvisionReturnTargetRef}
        onClose={() => {
          setResidentWorkspaceSelection(null)
          setResidentProvisionOrigin(null)
        }}
        onRecoveryRequired={setResidentRecoveryReference}
        onCommitted={residentProvisionCommitted}
      />

      <ResidentEndDialog
        api={api}
        context={residentEndContext}
        triggerRef={residentEndReturnTargetRef}
        onClose={() => setResidentEndContext(null)}
        onSettled={(status) => {
          setResidentLifecycleFeedback(residentLifecycleAnnouncement(status))
          if (status.phase === 'completed') {
            setResidentThreadFocusTarget({
              expectedHostId: status.expectedHostId,
              threadId: status.threadId,
              executionGenerationId: status.executionGenerationId,
            })
          }
        }}
      />

      <CommandPaletteDialog
        open={commandPaletteOpen}
        snapshot={snapshot}
        selectedThreadId={selectedThread.id}
        canEndResident={canEndResident}
        canManageComputers={canManageComputers}
        triggerRef={commandPaletteTriggerRef}
        onClose={() => setCommandPaletteOpen(false)}
        onSelectThread={selectThread}
        onSelectProject={selectProject}
        onAddComputer={() => {
          addComputerReturnTargetRef.current = commandPaletteTriggerRef.current
          setCommandPaletteOpen(false)
          setAddComputerOpen(true)
        }}
        onOpenInspector={() => {
          setCommandPaletteOpen(false)
          setSidebarOpen(false)
          setInspectorOpen(true)
        }}
        onOpenModels={() => {
          modelsDialogTriggerRef.current = commandPaletteTriggerRef.current
          setCommandPaletteOpen(false)
          setModelsOpen(true)
        }}
        onFocusComposer={() => {
          setCommandPaletteOpen(false)
          window.requestAnimationFrame(() => {
            const composer = document.querySelector<HTMLTextAreaElement>('#thread-composer')
            if (composer && !composer.disabled) composer.focus()
            else document.querySelector<HTMLButtonElement>('#resident-turn-primary')?.focus()
          })
        }}
        onEndResident={() => {
          const trigger = commandPaletteTriggerRef.current
          setCommandPaletteOpen(false)
          if (trigger) void reviewResidentEnd(trigger)
        }}
      />

      <ModelsDialog
        api={api}
        open={modelsOpen}
        host={selectedHost}
        threadId={selectedThread.id}
        executionGenerationId={selectedThread.executionGenerationId}
        currentModel={selectedRuntime.session?.model}
        canSelectResidentModel={canSelectResidentModel}
        canConnectRuntimeOAuth={canConnectRuntimeOAuth}
        triggerRef={modelsDialogTriggerRef}
        onClose={() => setModelsOpen(false)}
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
  primeControlsVisible: boolean
  onClose: () => void
  onAddComputer: (trigger: HTMLElement) => void
  onProvisionResident: (trigger: HTMLElement) => void
  onRecoverResident: (operation: ResidentLifecycleOperationSummary, trigger: HTMLElement) => void
  onCheckResident: (operation: ResidentLifecycleOperationSummary) => void
  onRecoverResidentReference: (reference: ResidentLifecycleRecoveryReference, trigger: HTMLElement) => void
  onCheckResidentReference: (reference: ResidentLifecycleRecoveryReference) => void
  onOpenModels: (trigger: HTMLElement) => void
  onMoveThread: (hostId: string, trigger: HTMLElement | null) => void
  canMoveThread: boolean
  canLoadModelCatalog: boolean
  canManageComputers: boolean
  canProvisionResident: boolean
  registeredWorkspaceCreateBlock: RegisteredWorkspaceCreateBlock | null
  residentLifecycleOperations: ResidentLifecycleOperationSummary[]
  residentRecoveryReference: ResidentLifecycleRecoveryReference | null
  residentLifecycleBusy: boolean
  addComputerTriggerRef: RefObject<HTMLButtonElement | null>
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
  primeControlsVisible,
  onClose,
  onAddComputer,
  onProvisionResident,
  onRecoverResident,
  onCheckResident,
  onRecoverResidentReference,
  onCheckResidentReference,
  onOpenModels,
  onMoveThread,
  canMoveThread,
  canLoadModelCatalog,
  canManageComputers,
  canProvisionResident,
  registeredWorkspaceCreateBlock,
  residentLifecycleOperations,
  residentRecoveryReference,
  residentLifecycleBusy,
  addComputerTriggerRef,
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
        <div className="sidebar__drawer-header">
          <strong>Projects and threads</strong>
          <button className="icon-button" type="button" aria-label="Close sidebar" onClick={onClose}>
            <Icon icon={X} size={17} />
          </button>
        </div>
        {selectedHost?.kind === 'ssh' && registeredWorkspaceCreateBlock ? (
          <div className="sidebar__registered-resident">
            <small>
              {registeredWorkspaceCreateBlock === 'active_resident'
                ? 'A resident session already owns this workspace. Open or select that resident thread, then choose End resident session in Runtime before creating another.'
                : 'An earlier resident setup still holds this workspace. Continue or inspect that setup below before starting another thread.'}
            </small>
          </div>
        ) : canProvisionResident && (selectedHost?.kind === 'ssh' ? (
          <div className="sidebar__registered-resident">
            <button
              className="button button--primary button--full sidebar__create-resident"
              type="button"
              disabled={residentLifecycleBusy}
              aria-busy={residentLifecycleBusy}
              aria-describedby="registered-resident-action-description"
              onClick={(event) => onProvisionResident(event.currentTarget)}
            >
              <Icon icon={residentLifecycleBusy ? Loader2 : FolderGit2} size={16} />
              {residentLifecycleBusy ? 'Preparing…' : 'New resident thread in this workspace'}
            </button>
            <small id="registered-resident-action-description">
              Uses this saved host-owned workspace. You’ll name only the new thread.
            </small>
          </div>
        ) : (
          <button
            className="button button--primary button--full sidebar__create-resident"
            type="button"
            disabled={residentLifecycleBusy}
            aria-busy={residentLifecycleBusy}
            onClick={(event) => onProvisionResident(event.currentTarget)}
          >
            <Icon icon={residentLifecycleBusy ? Loader2 : FolderGit2} size={16} />
            {residentLifecycleBusy ? 'Working…' : 'New resident thread'}
          </button>
        ))}
        {residentRecoveryReference && (
          <ResidentLifecycleFallbackCard
            reference={residentRecoveryReference}
            mutationBlock={residentLifecycleFallbackMutationBlock(
              residentRecoveryReference,
              snapshot,
              selectedThread,
              selectedHost,
            )}
            checkable={residentLifecycleHostIsCheckable(snapshot.hosts.find((host) =>
              host.id === residentRecoveryReference.expectedHostId,
            ))}
            busy={residentLifecycleBusy}
            onChoose={(event) => onRecoverResidentReference(residentRecoveryReference, event.currentTarget)}
            onCheck={() => onCheckResidentReference(residentRecoveryReference)}
          />
        )}
        {residentLifecycleOperations.length > 0 && (
          <ResidentLifecycleRecoveryList
            operations={residentLifecycleOperations}
            mutationBlock={(operation) => residentLifecycleMutationBlock(
              operation,
              snapshot,
              selectedThread,
              selectedHost,
              residentRecoveryReference,
            )}
            isCheckable={(operation) => residentLifecycleHostIsCheckable(snapshot.hosts.find((host) =>
              host.id === operation.expectedHostId,
            ))}
            busy={residentLifecycleBusy}
            onChoose={(operation, event) => onRecoverResident(operation, event.currentTarget)}
            onCheck={onCheckResident}
          />
        )}
        {primeControlsVisible && (
          <div className="sidebar__new-row">
            <button
              className="button button--quiet button--full sidebar__search"
              type="button"
              aria-label="Search projects and threads"
              title="Search projects, threads, and commands"
              onClick={onSearch}
            >
              <Icon icon={Search} size={17} />
              <span>Search</span>
            </button>
          </div>
        )}

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
                <small>{canProvisionResident
                  ? selectedHost?.kind === 'ssh'
                    ? 'Use New resident thread in this workspace to add one.'
                    : 'Choose New resident thread to add one.'
                  : `Reconnect the verified ${selectedHost?.kind === 'ssh' ? 'SSH' : 'local'} host to add one.`}
                </small>
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
                <li key={item.id} className={cx(item.diagnostic && 'attention-list__item--diagnostic')}>
                  <button type="button" onClick={() => thread && onSelectThread(thread)}>
                    <span className="attention-list__icon">
                      <Icon icon={item.kind === 'approval' ? ShieldCheck : item.kind === 'question' ? MessageSquare : AlertCircle} size={15} />
                    </span>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.hostName}</small>
                      <AttentionDiagnostic item={item} />
                    </span>
                  </button>
                  <AttentionDiagnosticCopy item={item} />
                </li>
              )
            })}
          </ul>
        </section>
      </div>

      <div className="sidebar__footer">
        {primeControlsVisible && selectedHost && compatibleHosts.length > 0 && (
          <div className="sidebar__location">
            <span>Run location</span>
            <span className={cx('connection-dot', `connection-dot--${selectedHost.connection}`)} aria-hidden="true" />
            {canMoveThread ? (
              <>
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
              </>
            ) : (
              <span
                className="sidebar__location-static"
                aria-label={`Compact run location: ${selectedHost.name}. Moving threads between computers is unavailable`}
              >
                <bdi>{selectedHost.name}</bdi>
                <small>Move unavailable</small>
              </span>
            )}
          </div>
        )}
        {canLoadModelCatalog && (
          <button
            className="button button--quiet button--full"
            type="button"
            onClick={(event) => onOpenModels(event.currentTarget)}
          >
            <Icon icon={Bot} /> Models &amp; accounts
          </button>
        )}
        {canManageComputers && (
          <button
            ref={addComputerTriggerRef}
            className="button button--quiet button--full"
            type="button"
            onClick={(event) => onAddComputer(event.currentTarget)}
          >
            <Icon icon={Computer} /> Add computer
          </button>
        )}
      </div>
    </aside>
  )
}

const TRANSCRIPT_BLOCK_INCREMENT = 200

function Transcript({ thread }: { thread: ThreadSummary }) {
  const scrollRef = useRef<HTMLElement>(null)
  const previousThreadIdRef = useRef('')
  const shouldFollowRef = useRef(true)
  const previousActivityRef = useRef({
    threadId: thread.id,
    transcriptLength: thread.transcript.length,
    lastBlockId: thread.transcript.at(-1)?.id,
    lastBlockBody: thread.transcript.at(-1)?.body,
  })
  const pendingHistoryAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const [historyWindow, setHistoryWindow] = useState({ threadId: thread.id, count: TRANSCRIPT_BLOCK_INCREMENT })
  const [hasNewActivity, setHasNewActivity] = useState(false)
  const lastBlock = thread.transcript[thread.transcript.length - 1]
  const hasStreamingBlock = thread.transcript.some((block) => block.streaming)
  const visibleBlockCount = historyWindow.threadId === thread.id ? historyWindow.count : TRANSCRIPT_BLOCK_INCREMENT
  const firstVisibleIndex = Math.max(0, thread.transcript.length - visibleBlockCount)
  const visibleBlocks = thread.transcript.slice(firstVisibleIndex)
  const hasProgressiveHistory = thread.transcript.length > TRANSCRIPT_BLOCK_INCREMENT

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const previousActivity = previousActivityRef.current
    const currentActivity = {
      threadId: thread.id,
      transcriptLength: thread.transcript.length,
      lastBlockId: lastBlock?.id,
      lastBlockBody: lastBlock?.body,
    }
    previousActivityRef.current = currentActivity

    if (previousThreadIdRef.current !== thread.id) {
      previousThreadIdRef.current = thread.id
      shouldFollowRef.current = true
      setHasNewActivity(false)
      pendingHistoryAnchorRef.current = null
      if (historyWindow.threadId !== thread.id || historyWindow.count !== TRANSCRIPT_BLOCK_INCREMENT) {
        setHistoryWindow({ threadId: thread.id, count: TRANSCRIPT_BLOCK_INCREMENT })
      }
      scroller.scrollTop = scroller.scrollHeight
      return
    }

    const historyAnchor = pendingHistoryAnchorRef.current
    if (historyAnchor) {
      pendingHistoryAnchorRef.current = null
      shouldFollowRef.current = false
      scroller.scrollTop = historyAnchor.scrollTop + Math.max(0, scroller.scrollHeight - historyAnchor.scrollHeight)
      return
    }

    const activityChanged = previousActivity.threadId === thread.id && (
      previousActivity.transcriptLength !== currentActivity.transcriptLength ||
      previousActivity.lastBlockId !== currentActivity.lastBlockId ||
      previousActivity.lastBlockBody !== currentActivity.lastBlockBody
    )
    if (shouldFollowRef.current) {
      scroller.scrollTop = scroller.scrollHeight
      setHasNewActivity(false)
    } else if (activityChanged) {
      setHasNewActivity(true)
    }
  }, [historyWindow.count, historyWindow.threadId, lastBlock?.body, lastBlock?.id, thread.id, thread.transcript.length])

  return (
    <div className="transcript">
      <section
        ref={scrollRef}
        id="thread-transcript"
        className="transcript__scroller"
        aria-label="Thread transcript"
        tabIndex={-1}
        onScroll={(event) => {
          const scroller = event.currentTarget
          const distanceFromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
          shouldFollowRef.current = distanceFromBottom <= 96
          if (shouldFollowRef.current) setHasNewActivity(false)
        }}
      >
        <div className="transcript__inner">
          {hasProgressiveHistory && (
            <div className="history-loader">
              <button
                className="button button--secondary button--small"
                type="button"
                disabled={firstVisibleIndex === 0}
                onClick={() => {
                  const scroller = scrollRef.current
                  if (!scroller) return
                  pendingHistoryAnchorRef.current = {
                    scrollHeight: scroller.scrollHeight,
                    scrollTop: scroller.scrollTop,
                  }
                  setHistoryWindow({
                    threadId: thread.id,
                    count: Math.min(thread.transcript.length, visibleBlockCount + TRANSCRIPT_BLOCK_INCREMENT),
                  })
                }}
              >
                <Icon icon={Clock3} size={14} />
                {firstVisibleIndex > 0 ? 'Load earlier activity' : 'All activity loaded'}
              </button>
              <span aria-live="polite">
                {firstVisibleIndex > 0
                  ? `${firstVisibleIndex} earlier ${firstVisibleIndex === 1 ? 'item' : 'items'}`
                  : `${thread.transcript.length} items loaded`}
              </span>
            </div>
          )}
          {visibleBlocks.map((block) => {
            if (block.kind === 'checkpoint' || block.kind === 'notice') {
              return (
                <div
                  className={cx('timeline-marker', block.kind === 'notice' && 'timeline-marker--notice')}
                  data-transcript-block
                  key={block.id}
                >
                  <span className="timeline-marker__icon">
                    <Icon icon={block.kind === 'checkpoint' ? CheckCircle2 : Info} size={14} />
                  </span>
                  <div>
                    <TranscriptBody body={block.body} kind={block.kind} />
                    {block.detail && <span>{block.detail}</span>}
                  </div>
                  <time>{block.time}</time>
                </div>
              )
            }

            return (
              <article
                className={cx('message', `message--${block.kind}`, block.streaming && 'message--streaming')}
                data-transcript-block
                aria-busy={block.streaming ? true : undefined}
                key={block.id}
              >
                <header className="message__header">
                  <span className="message__avatar" aria-hidden="true">
                    <Icon icon={block.kind === 'user' ? Laptop : block.kind === 'tool' ? Terminal : Bot} size={15} />
                  </span>
                  <span className="message__identity">
                    <strong>{block.author}</strong>
                    {block.streaming && (
                      <span className="message__streaming-indicator" aria-hidden="true">
                        <span className="message__streaming-dot" aria-hidden="true" />
                        <span>Live</span>
                      </span>
                    )}
                  </span>
                  <time>{block.time}</time>
                </header>
                <div className="message__body">
                  <TranscriptBody body={block.body} kind={block.kind} />
                  {block.detail && <p className="message__detail">{block.detail}</p>}
                  {block.receipt && (
                    <details className="message__receipt">
                      <summary>Receipt details</summary>
                      <code><bdi>{block.receipt}</bdi></code>
                    </details>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      </section>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {hasStreamingBlock ? 'Prime Agent is responding.' : ''}
      </span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {hasNewActivity ? 'New transcript activity is available.' : ''}
      </span>
      {hasNewActivity && (
        <div className="transcript-jump">
          <button
            className="button button--secondary transcript-jump__button"
            type="button"
            aria-controls="thread-transcript"
            onClick={() => {
              const scroller = scrollRef.current
              if (!scroller) return
              shouldFollowRef.current = true
              scroller.scrollTop = scroller.scrollHeight
              setHasNewActivity(false)
              scroller.focus({ preventScroll: true })
            }}
          >
            <Icon icon={ArrowDown} size={14} />
            New activity · Jump to latest
          </button>
        </div>
      )}
    </div>
  )
}

interface ComposerProps {
  connection: ConnectionState
  authorityVerified: boolean
  hostName: string
  taskState: TaskState
  runtime: RuntimeSummary
  text: string
  onTextChange: (value: string) => void
  validationError: string
  receipt: ComposerReceiptView
  canStartTurn: boolean
  canStopTurn: boolean
  modelCatalogAvailable: boolean
  onOpenModelCatalog: (trigger: HTMLElement) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onStop: () => void
}

type SessionContinuityTone = 'ready' | 'working' | 'needs-you' | 'reconnecting'

function sessionContinuityPresentation(
  connection: ConnectionState,
  authorityVerified: boolean,
  hostName: string,
  taskState: TaskState,
  runtime: RuntimeSummary,
  receipt: ComposerReceiptView,
): { label: 'Ready' | 'Working' | 'Needs you' | 'Reconnecting'; detail: string; icon: LucideIcon; tone: SessionContinuityTone } {
  if (connection !== 'online' || !authorityVerified) {
    return {
      label: 'Reconnecting',
      detail: `Reconnecting to ${hostName}. Saved activity is available; current status is unverified.`,
      icon: RefreshCw,
      tone: 'reconnecting',
    }
  }

  const residentControlOperation = receipt.operation === 'prompt' || receipt.operation === 'abort'
  if (residentControlOperation && (receipt.state === 'uncertain' || receipt.state === 'rejected')) {
    const operation = receipt.operation === 'abort' ? 'Stop' : 'delegated task'
    return {
      label: 'Needs you',
      detail: receipt.state === 'uncertain'
        ? `The last ${operation} outcome on ${hostName} is unknown. Inspect the resident thread before another action.`
        : `The last ${operation} request was not accepted on ${hostName}. Review the composer before trying again.`,
      icon: AlertCircle,
      tone: 'needs-you',
    }
  }

  if (residentControlOperation && (receipt.state === 'sending' || receipt.state === 'sent')) {
    const detail = receipt.operation === 'abort'
      ? receipt.state === 'sending'
        ? `Requesting a safe stop on ${hostName}.`
        : `Stop was accepted on ${hostName}; waiting for authoritative idle proof.`
      : receipt.state === 'sending'
        ? `Delegating this task to Prime Agent on ${hostName}.`
        : `Prime Agent owns this task on ${hostName}; waiting for authoritative activity.`
    return {
      label: 'Working',
      detail,
      icon: Activity,
      tone: 'working',
    }
  }

  if (taskState === 'waiting' || taskState === 'needs_approval' || taskState === 'failed') {
    return {
      label: 'Needs you',
      detail: taskState === 'failed'
        ? `Prime Agent needs review on ${hostName} before work can continue.`
        : `Prime Agent needs your input on ${hostName} before it can continue.`,
      icon: taskState === 'needs_approval' ? ShieldCheck : AlertCircle,
      tone: 'needs-you',
    }
  }

  const session = runtime.session
  const verifiedResident = Boolean(
    session?.residency === 'resident' &&
    session.activeSessionId &&
    session.sessionId,
  )

  if (taskState === 'running') {
    return {
      label: 'Working',
      detail: verifiedResident
        ? `Prime Agent keeps working on ${hostName} after this window closes.`
        : session?.residency === 'client_owned'
          ? `Prime Agent is working on ${hostName} while this client remains attached.`
          : `Prime Agent is working on ${hostName}. Resident offload is not verified.`,
      icon: Activity,
      tone: 'working',
    }
  }

  return {
    label: 'Ready',
    detail: verifiedResident
      ? `${hostName} is ready for another delegated task.`
      : session?.residency === 'client_owned'
        ? `${hostName} is ready. Tasks run only while this client remains attached.`
        : `${hostName} is ready, but resident offload is not verified.`,
    icon: taskState === 'complete' ? CheckCircle2 : Circle,
    tone: 'ready',
  }
}

function SessionContinuity({
  connection,
  authorityVerified,
  hostName,
  taskState,
  runtime,
  receipt,
}: Pick<ComposerProps, 'connection' | 'authorityVerified' | 'hostName' | 'taskState' | 'runtime' | 'receipt'>) {
  const isFresh = connection === 'online' && authorityVerified
  const reportedGoals = runtime.goals
  const activeGoal = reportedGoals?.find((goal) => goal.state === 'active')
  const interruptedGoal = reportedGoals?.find((goal) => goal.state !== 'complete')
  const displayedGoal = activeGoal ?? interruptedGoal
  const goalCopy = displayedGoal?.objective ?? (reportedGoals ? 'No active goal' : 'Goal state unavailable')
  const queuedActions = runtime.session?.queuedActionCount
  const hostCommands = runtime.queue?.pendingCount
  const queueStateCopy = runtime.queue?.paused
    ? `Host queue paused · ${hostCommands ?? 0} pending`
    : hostCommands !== undefined && hostCommands > 0
      ? `${hostCommands} host ${hostCommands === 1 ? 'command' : 'commands'} queued${queuedActions ? ` · ${queuedActions} session ${queuedActions === 1 ? 'action' : 'actions'}` : ''}`
      : queuedActions !== undefined
        ? queuedActions === 0
          ? 'No actions queued'
          : `${queuedActions} ${queuedActions === 1 ? 'action' : 'actions'} queued`
        : runtime.queue
          ? 'No host commands queued'
          : 'Queue state unavailable'
  const queueCopy = isFresh || queueStateCopy === 'Queue state unavailable'
    ? queueStateCopy
    : `Cached · ${queueStateCopy}`
  const continuity = sessionContinuityPresentation(connection, authorityVerified, hostName, taskState, runtime, receipt)

  return (
    <section className="session-continuity" aria-label="Session status">
      <span
        className={cx('session-continuity__state', `session-continuity__state--${continuity.tone}`)}
        title={`${continuity.label}: ${continuity.detail}`}
      >
        <Icon icon={continuity.icon} size={14} />
      </span>
      <span className="session-continuity__body">
        <span className="session-continuity__summary">
          <span className="session-continuity__label" role="status" aria-live="polite" aria-atomic="true">
            {continuity.label}
          </span>
          <span aria-hidden="true">·</span>
          <strong title={displayedGoal?.objective}>{goalCopy}</strong>
        </span>
        <small>{continuity.detail}</small>
      </span>
      <span className={cx('session-continuity__queue', runtime.queue?.paused && 'session-continuity__queue--paused')}>
        <Icon icon={runtime.queue?.paused ? Clock3 : ListChecks} size={13} />
        <span title={queueCopy}>{queueCopy}</span>
      </span>
    </section>
  )
}

function Composer({ connection, authorityVerified, hostName, taskState, runtime, text, onTextChange, validationError, receipt, canStartTurn, canStopTurn, modelCatalogAvailable, onOpenModelCatalog, onSubmit, onStop }: ComposerProps) {
  const disconnected = connection !== 'online'
  const projectionReportsRunning = taskState === 'running'
  const promptSending = receipt.operation === 'prompt' && receipt.state === 'sending'
  const promptAwaitingProof = receipt.operation === 'prompt' && receipt.state === 'sent'
  const promptOutcomeUnknown = receipt.operation === 'prompt' && receipt.state === 'uncertain'
  const stopSending = receipt.operation === 'abort' && receipt.state === 'sending'
  const stopAwaitingProof = receipt.operation === 'abort' && receipt.state === 'sent'
  const endLifecyclePresent = receipt.operation === 'end'
  const endCompleted = endLifecyclePresent && receipt.state === 'idle'
  const endOutcomeUnknown = endLifecyclePresent && receipt.state === 'uncertain'
  const endPending = endLifecyclePresent && !endCompleted
  const abortControlPending = Boolean(
    receipt.operation === 'abort' &&
    (receipt.state === 'sending' || receipt.state === 'sent' || receipt.state === 'uncertain'),
  )
  const promptControlPending = promptAwaitingProof || promptOutcomeUnknown
  const residentControlPending = abortControlPending || promptControlPending || endPending
  const running = projectionReportsRunning || canStopTurn || residentControlPending
  const residentAttached = runtime.session?.residency === 'resident' && Boolean(runtime.session.activeSessionId && runtime.session.sessionId)
  const canStartNow = canStartTurn && !disconnected
  const canStopNow = canStopTurn && !disconnected
  const retryingStop = running && receipt.operation === 'abort' && receipt.state === 'uncertain' && receipt.retryable !== false
  const stopOutcomeUnknown = running && receipt.operation === 'abort' && receipt.state === 'uncertain' && receipt.retryable === false
  const controlMode = running || endLifecyclePresent
  const canAct = endLifecyclePresent ? false : running ? canStopNow : canStartNow
  const unavailableCopy = disconnected
    ? residentControlPending
      ? `Resident control is retained locally. Reconnect to ${hostName} for authoritative status.`
      : `Reconnect to ${hostName} to verify this resident turn.`
    : !residentAttached
      ? 'Resident control is unavailable until this host reports an existing attached Prime Agent session.'
      : running
        ? 'Prime Agent does not report a stoppable active turn.'
        : 'This resident session is not ready for a new prompt.'
  const defaultStatus = disconnected
    ? residentControlPending
      ? `Resident control retained · reconnect to ${hostName} for authoritative status`
      : projectionReportsRunning
        ? `Last reported running on ${hostName} · current status unverified`
        : unavailableCopy
    : running
    ? !projectionReportsRunning && receipt.operation === 'prompt'
      ? 'Prompt accepted · waiting for authoritative resident activity'
      : canStopNow
      ? 'Prime Agent is working · Stop requests a safe boundary'
      : 'Waiting for authoritative resident activity'
    : canStartTurn
      ? 'Ready to delegate a task'
      : unavailableCopy
  const receiptStatusCopy = receipt.operation && receipt.state !== 'idle'
    ? receipt.message || defaultStatus
    : disconnected
      ? defaultStatus
      : receipt.message || defaultStatus
  const statusCopy = validationError || receiptStatusCopy
  const statusState = validationError || receipt.state === 'rejected'
    ? 'rejected'
    : receipt.state === 'idle' && !canAct
      ? 'waiting_for_connection'
      : receipt.state
  const primaryLabel = endLifecyclePresent
    ? endCompleted
      ? 'Session ended'
      : endOutcomeUnknown
        ? 'End outcome unknown'
        : 'End pending'
    : running
    ? stopOutcomeUnknown
      ? 'Outcome unknown'
      : disconnected
      ? 'Reconnect to verify'
      : stopSending
      ? 'Requesting stop'
      : stopAwaitingProof
        ? 'Stop accepted'
      : retryingStop
        ? 'Try stop again'
        : 'Stop'
    : promptSending
      ? 'Submitting prompt'
      : disconnected
      ? 'Reconnect to delegate'
      : 'Delegate task'
  const compactComposer = controlMode
  const textareaDisabled = !canStartNow
  const intentCopy = endLifecyclePresent
    ? endCompleted
      ? 'Resident session ended'
      : endOutcomeUnknown
        ? 'End outcome unknown'
        : 'Ending resident session'
    : stopOutcomeUnknown
    ? 'Stop outcome unknown'
    : retryingStop
      ? 'Stop outcome uncertain'
      : stopSending
        ? 'Requesting safe stop'
        : stopAwaitingProof
          ? 'Stop accepted'
          : promptOutcomeUnknown
            ? 'Prompt outcome uncertain'
            : promptSending
              ? 'Admitting resident prompt'
              : promptAwaitingProof
                ? 'Prompt owned by Prime Agent'
                   : running
                  ? disconnected
                    ? 'Resident status unverified'
                    : projectionReportsRunning
                      ? 'Active resident turn'
                      : 'Resident turn owned'
                  : 'Delegate a task'

  return (
    <footer className={cx('composer-wrap', compactComposer && 'composer-wrap--compact')}>
      <SessionContinuity connection={connection} authorityVerified={authorityVerified} hostName={hostName} taskState={taskState} runtime={runtime} receipt={receipt} />
      <form
        className={cx('composer', compactComposer && 'composer--compact', controlMode && 'composer--running')}
        onSubmit={(event) => {
          if (promptSending) {
            event.preventDefault()
            return
          }
          onSubmit(event)
        }}
        aria-label="Prime Agent prompt"
        aria-disabled={!canAct || promptSending}
        aria-busy={promptSending || stopSending ? true : undefined}
      >
        <div className="composer__toolbar">
          <span className="composer__intent">
            {intentCopy}
          </span>
          <span className={cx(
            'composer__connection',
            `composer__connection--${statusState}`,
            Boolean(validationError) && 'composer__connection--validation',
          )}>
            {!validationError && receipt.state === 'sending' && <Icon icon={Loader2} size={13} />}
            {!validationError && (receipt.state === 'waiting_for_connection' || (receipt.state === 'idle' && !canAct)) && <Icon icon={Clock3} size={13} />}
            {!validationError && receipt.state === 'sent' && <Icon icon={Check} size={13} />}
            {!validationError && receipt.state === 'uncertain' && receipt.retryable !== false && <Icon icon={RefreshCw} size={13} />}
            {!validationError && receipt.state === 'uncertain' && receipt.retryable === false && <Icon icon={AlertCircle} size={13} />}
            {(Boolean(validationError) || receipt.state === 'rejected') && <Icon icon={AlertCircle} size={13} />}
            <span id={validationError ? 'composer-message-error' : undefined}>{statusCopy}</span>
          </span>
        </div>

        {!compactComposer && (
          <>
            <label className="sr-only" htmlFor="thread-composer">Task brief</label>
            <textarea
              id="thread-composer"
              name="message"
              value={text}
              rows={2}
              placeholder={disconnected
                ? 'Reconnect to verify this resident session'
                : canStartNow
                  ? 'Describe the outcome, constraints, and done criteria…'
                  : 'Resident prompt unavailable'}
              disabled={textareaDisabled}
              onChange={(event) => onTextChange(event.target.value)}
              onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                if (!promptSending && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              aria-invalid={validationError ? 'true' : undefined}
              aria-describedby={validationError ? 'composer-hint composer-message-error' : 'composer-hint composer-status'}
            />
          </>
        )}

        <div className="composer__actions">
          <div className="composer__secondary-actions">
            {modelCatalogAvailable && (
              <button
                className="model-chip"
                type="button"
                aria-label={`Open models and accounts${runtime.session?.model ? `. Current model: ${runtime.session.model}` : ''}`}
                onClick={(event) => onOpenModelCatalog(event.currentTarget)}
              >
                <Icon icon={Bot} size={14} />
                <span>{runtime.session?.model ?? 'Model catalog'}</span>
                <Icon icon={ChevronDown} size={13} />
              </button>
            )}
            <span className="composer__hint" id="composer-hint">
              {endLifecyclePresent
                ? endCompleted
                  ? 'The saved thread and workspace remain available'
                  : 'Resident mutations stay locked while the durable end outcome settles'
                : running
                ? disconnected
                  ? unavailableCopy
                  : 'Stop asks Prime Agent to end at the next safe boundary'
                : canStartNow
                  ? 'Include the outcome, constraints, and done criteria · Ctrl or ⌘ + Enter'
                  : unavailableCopy}
            </span>
          </div>
          <div className="composer__primary-actions">
            <button
              id="resident-turn-primary"
              className={cx(
                'button',
                controlMode ? 'button--stop' : 'button--primary',
                !controlMode && !text.trim() && 'button--empty',
              )}
              type={controlMode ? 'button' : 'submit'}
              disabled={endLifecyclePresent || (running ? !canStopNow || stopSending || stopAwaitingProof || stopOutcomeUnknown : !canStartNow || promptSending)}
              aria-label={endLifecyclePresent
                ? endCompleted
                  ? 'Resident session ended; the saved thread and workspace remain available'
                  : endOutcomeUnknown
                    ? 'Resident end outcome unknown; inspect the durable lifecycle status'
                    : 'Resident session end is durably pending'
                : running
                ? disconnected
                  ? 'Reconnect to verify and control this resident turn'
                  : stopOutcomeUnknown
                  ? 'Stop outcome unknown; inspect the current thread state'
                  : stopSending
                    ? 'Safe Stop request is being sent'
                    : stopAwaitingProof
                      ? 'Stop accepted; waiting for authoritative idle proof'
                  : retryingStop
                    ? 'Try stopping the active Prime Agent turn again'
                    : 'Stop the active Prime Agent turn'
                : promptSending
                  ? 'Prompt is awaiting durable host admission'
                  : undefined}
              onClick={!endLifecyclePresent && running ? onStop : undefined}
            >
              {endLifecyclePresent
                ? endCompleted
                  ? <Icon icon={Check} size={15} />
                  : endOutcomeUnknown
                    ? <Icon icon={AlertCircle} size={15} />
                    : <Icon icon={Clock3} size={15} />
                : stopSending || promptSending
                ? <Icon icon={Loader2} size={15} />
                : stopAwaitingProof
                  ? <Icon icon={Check} size={15} />
                : running
                  ? <Icon icon={Square} size={13} strokeWidth={2.25} />
                  : <Icon icon={ArrowRight} size={15} strokeWidth={2} />}
              {primaryLabel}
            </button>
          </div>
        </div>
        <span className="sr-only" id="composer-status" role="status" aria-live="polite" aria-atomic="true">
          {validationError ? '' : receiptStatusCopy}
        </span>
      </form>
    </footer>
  )
}

interface InspectorProps {
  api: RendererApi
  snapshot: WorkbenchSnapshot
  selectedThread: ThreadSummary
  selectedProject: WorkbenchSnapshot['projects'][number]
  selectedHost: HostSummary
  runtime: RuntimeSummary
  activeTab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  onClose: () => void
  containerRef: RefObject<HTMLElement | null>
  modal: boolean
  inert: boolean
  canEndResident: boolean
  residentEndPreparing: boolean
  residentEndError: string
  onEndResident: (trigger: HTMLElement) => void
}

function Inspector({ api, snapshot, selectedThread, selectedProject, selectedHost, runtime, activeTab, onTabChange, onClose, containerRef, modal, inert, canEndResident, residentEndPreparing, residentEndError, onEndResident }: InspectorProps) {
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
        {activeTab === 'Runtime' && (
          <RuntimePanel
            key={selectedThread.id}
            snapshot={snapshot}
            thread={selectedThread}
            host={selectedHost}
            runtime={runtime}
            canEndResident={canEndResident}
            endPreparing={residentEndPreparing}
            endError={residentEndError}
            onEndResident={onEndResident}
          />
        )}
        {activeTab === 'Evidence' && (
          <EvidencePanel
            key={`${selectedHost.id}\u0000${selectedThread.remoteId ?? selectedThread.id}\u0000${selectedThread.executionGenerationId ?? ''}`}
            api={api}
            snapshot={snapshot}
            thread={selectedThread}
            host={selectedHost}
          />
        )}
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

function runtimeStateLabel(state: string): string {
  return state.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase())
}

function compactDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

const SCHEDULE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

function scheduleTime(value?: string): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined
  return SCHEDULE_TIME_FORMATTER.format(new Date(value))
}

function agentHierarchy(
  agent: WorkbenchSnapshot['agents'][number],
  byId: ReadonlyMap<string, WorkbenchSnapshot['agents'][number]>,
): {
  depth: number
  parent?: WorkbenchSnapshot['agents'][number]
} {
  const parent = agent.parentId && agent.parentId !== agent.id ? byId.get(agent.parentId) : undefined
  const visited = new Set([agent.id])
  let cursor = parent
  let depth = 0
  while (cursor && !visited.has(cursor.id) && depth < 4) {
    visited.add(cursor.id)
    depth += 1
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return { depth, parent }
}

function parentFirstAgents(agents: WorkbenchSnapshot['agents']): WorkbenchSnapshot['agents'] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const children = new Map<string, WorkbenchSnapshot['agents']>()
  const roots: WorkbenchSnapshot['agents'] = []
  for (const agent of agents) {
    if (agent.parentId && agent.parentId !== agent.id && byId.has(agent.parentId)) {
      const siblings = children.get(agent.parentId) ?? []
      siblings.push(agent)
      children.set(agent.parentId, siblings)
    } else {
      roots.push(agent)
    }
  }

  const ordered: WorkbenchSnapshot['agents'] = []
  const visited = new Set<string>()
  const visit = (agent: WorkbenchSnapshot['agents'][number]): void => {
    if (visited.has(agent.id)) return
    visited.add(agent.id)
    ordered.push(agent)
    children.get(agent.id)?.forEach(visit)
  }
  roots.forEach(visit)
  // Cycles have no root. Preserve their first-seen order without duplication.
  agents.forEach(visit)
  return ordered
}

const RUNTIME_GOAL_INCREMENT = 20
const RUNTIME_AGENT_INCREMENT = 50
const RUNTIME_SCHEDULE_INCREMENT = 20

function runtimeReadinessCopy(readiness: HostRuntimeReadiness | undefined): {
  summary: string
  detail?: string
  tone?: 'danger' | 'muted'
  cached: boolean
  observedAt?: string
} | undefined {
  if (!readiness) return undefined
  const cached = readiness.freshness === 'cached'
  const observation = cached && readiness.observedAt ? { observedAt: readiness.observedAt } : {}
  if (readiness.kind === 'not_reported') {
    return readiness.freshness === 'live'
      ? { summary: 'This host service doesn’t report runtime verification.', tone: 'muted', cached }
      : { summary: 'Last reported · Runtime verification wasn’t reported by this host service.', tone: 'muted', cached, ...observation }
  }
  const prefix = cached ? 'Last reported · ' : ''
  if (readiness.status === 'initializing') {
    const phase = readiness.phase === 'validating_seed'
      ? 'Validating bundled files'
      : readiness.phase === 'copying'
        ? 'Installing verified files'
        : readiness.phase === 'verifying'
          ? 'Verifying files'
          : readiness.phase === 'publishing'
            ? 'Finishing setup'
            : 'Preparing files'
    return { summary: `${prefix}Preparing verified Prime Agent runtime · ${phase}`, cached, ...observation }
  }
  if (readiness.status === 'ready') {
    const assurance = readiness.assurance === 'production-authenticated'
      ? 'Production authenticated'
      : readiness.assurance === 'development-integrity'
        ? 'Development integrity'
        : 'Runtime files verified'
    return { summary: `${prefix}${assurance}`, cached, ...observation, ...(cached ? { tone: 'muted' as const } : {}) }
  }
  const detail = readiness.recovery === 'retry'
    ? 'Retry runtime verification to run the same checks again.'
    : readiness.recovery === 'restart'
    ? 'Record diagnostics and contact support; this app cannot restart the detached host service.'
    : readiness.recovery === 'repair'
      ? 'Record diagnostics and contact support before changing local runtime data.'
      : 'Review diagnostics for this host before retrying.'
  return {
    summary: `${prefix}${readiness.status === 'failed' ? 'Runtime verification failed' : 'Runtime verification unavailable'}`,
    detail,
    tone: 'danger',
    cached,
    ...observation,
  }
}

function RuntimePanel({
  snapshot,
  thread,
  host,
  runtime,
  canEndResident,
  endPreparing,
  endError,
  onEndResident,
}: {
  snapshot: WorkbenchSnapshot
  thread: ThreadSummary
  host: HostSummary
  runtime: RuntimeSummary
  canEndResident: boolean
  endPreparing: boolean
  endError: string
  onEndResident: (trigger: HTMLElement) => void
}) {
  const [goalLimit, setGoalLimit] = useState(RUNTIME_GOAL_INCREMENT)
  const [agentLimit, setAgentLimit] = useState(RUNTIME_AGENT_INCREMENT)
  const [scheduleLimit, setScheduleLimit] = useState(RUNTIME_SCHEDULE_INCREMENT)
  const session = runtime.session
  const readinessCopy = runtimeReadinessCopy(host.runtimeReadiness)
  const agentsReported = runtime.agentsReported === true
  const hasAnyRuntimeReport = Boolean(
    session || agentsReported || runtime.goals !== undefined || runtime.schedules !== undefined,
  )
  const reportedAgents = agentsReported ? snapshot.agents : []
  const runningAgents = reportedAgents.filter((agent) => agent.status === 'running').length
  const agentsById = new Map(reportedAgents.map((agent) => [agent.id, agent]))
  const orderedAgents = parentFirstAgents(reportedAgents)
  const visibleAgents = orderedAgents.slice(0, agentLimit)
  const visibleGoals = runtime.goals?.slice(0, goalLimit)
  const visibleSchedules = runtime.schedules?.slice(0, scheduleLimit)
  const activeGoals = runtime.goals?.filter((goal) => goal.state === 'active') ?? []
  const workSummary = [
    runtime.goals === undefined ? 'Goals not reported' : `${activeGoals.length} active`,
    agentsReported ? `${reportedAgents.length} agents` : 'Agents not reported',
  ].join(' · ')
  const isFresh = host.connection === 'online'
  const sessionId = session?.activeSessionId ?? session?.sessionId
  const hostQueueCopy = runtime.queue
    ? runtime.queue.paused
      ? `${runtime.queue.pendingCount} pending · paused`
      : runtime.queue.pendingCount === 0
        ? 'No pending commands'
        : `${runtime.queue.pendingCount} pending`
    : 'Not reported'
  const residencyCopy = session?.residency === 'resident'
    ? isFresh
      ? 'Reported resident on host'
      : 'Last reported resident · current status unverified'
    : session?.residency === 'client_owned'
      ? isFresh
        ? 'Reported client-owned'
        : 'Last reported client-owned · current status unverified'
      : session
        ? 'Not reported'
        : 'No session report'

  return (
    <div className="inspector-content">
      <PanelHeading
        icon={Bot}
        title="Reported runtime"
        meta={!hasAnyRuntimeReport
          ? 'Current thread · runtime not reported'
          : !session
            ? 'Current thread · session not reported'
            : !agentsReported
              ? isFresh ? 'Current thread · agent activity not reported' : 'Agent activity not reported · cached host state'
              : isFresh
                ? `Current thread · ${runningAgents} ${runningAgents === 1 ? 'agent' : 'agents'} running`
                : `${runningAgents} ${runningAgents === 1 ? 'agent' : 'agents'} last reported running · cached host state`}
      />

      <section className="runtime-section" aria-labelledby="runtime-session-heading">
        <div className="runtime-section__heading">
          <h3 id="runtime-session-heading">Status</h3>
          {!isFresh && session && <span className="runtime-badge runtime-badge--warning">Cached state</span>}
          {isFresh && session && (session.isStreaming || session.isBashRunning || session.isCompacting || session.retryAttempt > 0) && (
            <span className="runtime-badges" aria-label="Runtime activity">
              {session.isStreaming && <span className="runtime-badge">Streaming</span>}
              {session.isBashRunning && <span className="runtime-badge">Shell running</span>}
              {session.isCompacting && <span className="runtime-badge runtime-badge--warning">Compacting</span>}
              {session.retryAttempt > 0 && <span className="runtime-badge runtime-badge--warning">Retry {session.retryAttempt}</span>}
            </span>
          )}
        </div>
        <dl className="runtime-facts">
          <div><dt>Run location</dt><dd><bdi>{host.name}</bdi></dd></div>
          <div><dt>Connection</dt><dd>{connectionLabel(host.connection)}</dd></div>
          {readinessCopy && (
            <div>
              <dt>Runtime verification</dt>
              <dd className={cx('runtime-integrity-fact', readinessCopy.tone && `runtime-integrity-fact--${readinessCopy.tone}`)}>
                <span>{readinessCopy.summary}</span>
                {readinessCopy.detail && <small>{readinessCopy.detail}</small>}
                {readinessCopy.cached && (
                  readinessCopy.observedAt && scheduleTime(readinessCopy.observedAt)
                    ? <time dateTime={readinessCopy.observedAt}>Observed {scheduleTime(readinessCopy.observedAt)}</time>
                    : <small>Observation time unavailable</small>
                )}
              </dd>
            </div>
          )}
          <div><dt>Turn</dt><dd>{taskLabel(thread.status)}</dd></div>
          <div><dt>Residency</dt><dd>{residencyCopy}</dd></div>
          {sessionId && <div><dt>Session</dt><dd><bdi>{sessionId}</bdi></dd></div>}
          {thread.executionGenerationId && <div><dt>Execution</dt><dd><bdi>{thread.executionGenerationId}</bdi></dd></div>}
          {thread.workspaceId && <div><dt>Workspace</dt><dd><bdi>{thread.workspaceId}</bdi></dd></div>}
        </dl>
        {!session && <p className="runtime-empty">This snapshot doesn’t report live Prime Agent session activity.</p>}
      </section>

      {(thread.residentLifecycle?.state === 'ended' || session?.residency === 'resident') && (
      <section className="runtime-section runtime-section--lifecycle" aria-labelledby="runtime-lifecycle-heading">
        <div className="runtime-section__heading">
          <h3 id="runtime-lifecycle-heading">Session lifecycle</h3>
          <span>{thread.residentLifecycle?.state === 'ended' ? 'Ended' : 'Host-resident'}</span>
        </div>
        {thread.residentLifecycle?.state === 'ended' ? (
          <div className="resident-end-state resident-end-state--complete" role="status">
            <Icon icon={CheckCircle2} size={16} />
            <span>
              <strong>Resident session ended</strong>
              <small>
                The saved thread and workspace remain available
                {scheduleTime(thread.residentLifecycle.endedAt) ? ` · ${scheduleTime(thread.residentLifecycle.endedAt)}` : ''}.
              </small>
            </span>
          </div>
        ) : (
          <>
            <p className="runtime-note">
              Closing Prime Continuim only detaches this app. Prime Agent keeps running on <bdi>{`${host.name}.`}</bdi>
            </p>
            <p className="runtime-note">
              Ending is permanent for this runtime session. The saved thread and workspace remain available.
            </p>
            {(canEndResident || endPreparing) && (
              <button
                className="button button--secondary resident-end-trigger"
                type="button"
                disabled={endPreparing}
                aria-busy={endPreparing || undefined}
                onClick={(event) => onEndResident(event.currentTarget)}
              >
                <Icon icon={endPreparing ? Loader2 : Square} size={14} />
                {endPreparing ? 'Preparing end review…' : 'End resident session…'}
              </button>
            )}
            {!canEndResident && !endPreparing && (
              <small className="runtime-empty">
                {host.connection === 'online'
                  ? 'A verified attached resident session is required before permanent ending can be reviewed.'
                  : `Reconnect to ${host.name} before reviewing permanent ending.`}
              </small>
            )}
            {endError && <p className="form-error" role="alert">{endError}</p>}
          </>
        )}
      </section>
      )}

      <section className="runtime-section" aria-labelledby="runtime-work-heading">
        <div className="runtime-section__heading">
          <h3 id="runtime-work-heading">Reported work</h3>
          <span>{workSummary}</span>
        </div>
        <div className="runtime-subsection" aria-labelledby="runtime-goal-heading">
          <div className="runtime-subsection__heading">
            <h4 id="runtime-goal-heading">Goals</h4>
            {runtime.goals && <span>{isFresh ? `${activeGoals.length} active` : `Cached · ${activeGoals.length} active`}</span>}
          </div>
          {runtime.goals === undefined ? (
            <p className="runtime-empty">Goals aren’t reported in this snapshot.</p>
          ) : runtime.goals.length === 0 ? (
            <p className="runtime-empty">No goal is active for this session.</p>
          ) : (
            <>
              <ul className="runtime-list">
                {visibleGoals?.map((goal) => (
                  <li key={goal.id}>
                    <span className={cx('runtime-state', `runtime-state--${goal.state}`)} aria-hidden="true" />
                    <span className="runtime-list__body">
                      <strong>{goal.objective}</strong>
                      <small>
                        {runtimeStateLabel(goal.state)}
                        {goal.tokensUsed !== undefined ? ` · ${goal.tokensUsed.toLocaleString()}${goal.tokenBudget ? ` of ${goal.tokenBudget.toLocaleString()}` : ''} tokens` : ''}
                      </small>
                      {goal.detail && <span>{goal.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
              {runtime.goals.length > goalLimit && (
                <button className="button button--secondary button--full runtime-more" type="button" onClick={() => setGoalLimit((limit) => limit + RUNTIME_GOAL_INCREMENT)}>
                  Show {Math.min(RUNTIME_GOAL_INCREMENT, runtime.goals.length - goalLimit)} more goals
                </button>
              )}
            </>
          )}
        </div>
        <div className="runtime-subsection" aria-labelledby="runtime-agents-heading">
          <div className="runtime-subsection__heading">
            <h4 id="runtime-agents-heading">Agents</h4>
            <span>{agentsReported ? reportedAgents.length : 'Not reported'}</span>
          </div>
          {!agentsReported ? (
            <p className="runtime-empty">Agent activity isn’t reported in this snapshot.</p>
          ) : reportedAgents.length === 0 ? (
            <p className="runtime-empty">No retained agents are reported for this session.</p>
          ) : (
            <ul className="agent-list">
              {visibleAgents.map((agent) => {
                const hierarchy = agentHierarchy(agent, agentsById)
                return (
                  <li data-runtime-agent key={agent.id} style={{ marginInlineStart: `${hierarchy.depth * 0.75}rem` }}>
                    <span className={cx('agent-state', `agent-state--${agent.status}`)}>
                      <Icon icon={agent.status === 'complete' ? Check : agent.status === 'running' ? Activity : agent.status === 'failed' ? AlertCircle : Clock3} size={14} />
                    </span>
                    <span className="agent-list__body">
                      <strong>{agent.name}</strong>
                      {hierarchy.parent && <span className="agent-list__parent">Subagent of {hierarchy.parent.name}</span>}
                      <span>{agent.activity ?? agent.recap ?? agent.role}</span>
                      <small>
                        <bdi>{agent.hostName}</bdi> · {isFresh ? runtimeStateLabel(agent.status) : `Last reported ${runtimeStateLabel(agent.status).toLocaleLowerCase()}`}
                        {agent.model ? ` · ${agent.model}` : ''}
                        {agent.durationMs !== undefined ? ` · ${compactDuration(agent.durationMs)}` : ''}
                        {agent.toolUseCount !== undefined ? ` · ${agent.toolUseCount.toLocaleString()} tool ${agent.toolUseCount === 1 ? 'use' : 'uses'}` : ''}
                        {agent.tokenCount !== undefined ? ` · ${agent.tokenCount.toLocaleString()} tokens` : ''}
                      </small>
                      {agent.error && <span className="runtime-error">{agent.error}</span>}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          {agentsReported && reportedAgents.length > agentLimit && (
            <button className="button button--secondary button--full runtime-more" type="button" onClick={() => setAgentLimit((limit) => limit + RUNTIME_AGENT_INCREMENT)}>
              Show {Math.min(RUNTIME_AGENT_INCREMENT, reportedAgents.length - agentLimit)} more subagents
            </button>
          )}
        </div>
      </section>

      <section className="runtime-section" aria-labelledby="runtime-delivery-heading">
        <div className="runtime-section__heading">
          <h3 id="runtime-delivery-heading">Delivery</h3>
          <span>{runtime.queue?.paused ? 'Paused' : host.connection === 'online' ? 'Connected' : 'Cached'}</span>
        </div>
        <dl className="runtime-facts">
          <div><dt>Session actions</dt><dd className="tabular">{session ? session.queuedActionCount : 'Not reported'}</dd></div>
          <div><dt>Host commands</dt><dd>{hostQueueCopy}</dd></div>
        </dl>
        <p className="runtime-note">Prime reconciles command receipts before retrying after a disconnect.</p>
        <div className="runtime-subsection" aria-labelledby="runtime-schedules-heading">
          <div className="runtime-subsection__heading">
            <h4 id="runtime-schedules-heading">Scheduled work</h4>
            {runtime.schedules && <span>{runtime.schedules.length}</span>}
          </div>
          {runtime.schedules === undefined ? (
            <p className="runtime-empty">Schedules aren’t reported in this snapshot.</p>
          ) : runtime.schedules.length === 0 ? (
            <p className="runtime-empty">No schedules are reported for this session.</p>
          ) : (
            <>
              <ul className="runtime-list">
                {visibleSchedules?.map((schedule) => {
                  const nextRun = scheduleTime(schedule.nextRunAt)
                  return (
                    <li key={schedule.id}>
                      <span className={cx('runtime-state', `runtime-state--${schedule.state}`)} aria-hidden="true" />
                      <span className="runtime-list__body">
                        <strong>{schedule.label}</strong>
                        <small>
                          {runtimeStateLabel(schedule.state)}
                          {schedule.source ? ` · ${runtimeStateLabel(schedule.source)}` : schedule.kind ? ` · ${runtimeStateLabel(schedule.kind)}` : ''}
                          {nextRun ? ` · Next ${nextRun}` : ''}
                        </small>
                        {schedule.detail && <span>{schedule.detail}</span>}
                      </span>
                    </li>
                  )
                })}
              </ul>
              {runtime.schedules.length > scheduleLimit && (
                <button className="button button--secondary button--full runtime-more" type="button" onClick={() => setScheduleLimit((limit) => limit + RUNTIME_SCHEDULE_INCREMENT)}>
                  Show {Math.min(RUNTIME_SCHEDULE_INCREMENT, runtime.schedules.length - scheduleLimit)} more schedules
                </button>
              )}
            </>
          )}
        </div>
      </section>

      <section className="runtime-section" aria-labelledby="runtime-usage-heading">
        <div className="runtime-section__heading">
          <h3 id="runtime-usage-heading">Usage</h3>
          <span>{session ? 'Reported by the runtime' : 'Not reported'}</span>
        </div>
        {session?.model || session?.context || session?.activeToolNames.length ? (
          <dl className="runtime-facts">
            {session?.model && <div><dt>Model</dt><dd><bdi>{session.model}</bdi>{session.thinkingLevel ? ` · ${session.thinkingLevel}` : ''}{session.serviceTier ? ` · ${session.serviceTier}` : ''}</dd></div>}
            {session?.context && (
              <div>
                <dt>Context</dt>
                <dd className="tabular">
                  {session.context.usedTokens.toLocaleString()}
                  {session.context.maxTokens ? ` of ${session.context.maxTokens.toLocaleString()} tokens` : ' tokens'}
                </dd>
              </div>
            )}
            {session && session.activeToolNames.length > 0 && <div><dt>Active tools</dt><dd>{session.activeToolNames.join(', ')}</dd></div>}
          </dl>
        ) : (
          <p className="runtime-empty">Model, tool, and context usage aren’t reported for this session.</p>
        )}
        <p className="runtime-note">Token counts may be reported here. Prices and spend aren’t calculated in this build.</p>
      </section>
    </div>
  )
}

type CandidateEvaluationLoadState =
  | { kind: 'idle'; message: string }
  | { kind: 'checking'; message: string }
  | { kind: 'ready'; message: string; preflight: Extract<CandidateEvaluationPreflight, { status: 'ready' }> }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string }

function candidateEvaluationMatchesAuthority(
  authority: CandidateEvaluationPreflightRequest,
  value: CandidateEvaluationPreflightRequest,
): boolean {
  return value.expectedHostId === authority.expectedHostId &&
    value.threadId === authority.threadId &&
    value.expectedExecutionGenerationId === authority.expectedExecutionGenerationId
}

function sameCandidateEvaluationReview(
  left: CandidateEvaluationReviewIdentity,
  right: CandidateEvaluationReviewIdentity,
): boolean {
  return left.headCommit === right.headCommit &&
    left.gitIndexSha256 === right.gitIndexSha256 &&
    left.gitIndexBytes === right.gitIndexBytes &&
    left.packageManifestSha256 === right.packageManifestSha256 &&
    left.lockfileSha256 === right.lockfileSha256 &&
    left.lockfileBytes === right.lockfileBytes &&
    left.nodeVersionPinSha256 === right.nodeVersionPinSha256 &&
    left.selfBuildEntrypointSha256 === right.selfBuildEntrypointSha256 &&
    left.launcherBootstrapSha256 === right.launcherBootstrapSha256 &&
    left.launcherBootstrapFileCount === right.launcherBootstrapFileCount &&
    left.runtimePointerSha256 === right.runtimePointerSha256 &&
    left.nodePackageManifestSha256 === right.nodePackageManifestSha256 &&
    left.nodeExecutableSha256 === right.nodeExecutableSha256 &&
    left.pnpmCliSha256 === right.pnpmCliSha256 &&
    left.reviewAggregateSha256 === right.reviewAggregateSha256
}

function candidateEvaluationIsNonterminal(status: CandidateEvaluationStatus): boolean {
  return status.status === 'prepared' || status.status === 'running'
}

function candidateEvaluationStatusLabel(status: CandidateEvaluationStatus): string {
  if (status.status === 'prepared') return 'Evaluation prepared'
  if (status.status === 'running') return 'Self-build invocation started'
  if (status.status === 'passed') return 'Candidate evaluation passed'
  if (status.status === 'failed') return 'Candidate evaluation failed'
  return 'Evaluation outcome unknown'
}

function candidateEvaluationStatusDetail(status: CandidateEvaluationStatus): string {
  if (status.receipt) {
    const artifactDetail = status.receipt.artifactFileCount === undefined
      ? ''
      : ` · ${status.receipt.artifactFileCount.toLocaleString()} release ${status.receipt.artifactFileCount === 1 ? 'artifact' : 'artifacts'}`
    return `${status.receipt.settledGateCount} of ${status.receipt.gateCount} build gates settled${artifactDetail}`
  }
  if (status.error) return `${status.error.code} · ${status.error.message}`
  if (status.status === 'prepared') return 'The passive launcher/workspace review fingerprint is admitted, not a canonical candidate identity. Canonical candidate and toolchain capture occurs inside the consented evaluation.'
  if (status.status === 'running') return 'The host is observing the exact workflow or receipt. It will not replay the invocation automatically.'
  return 'The host has not published terminal receipt evidence.'
}

function candidateEvaluationTone(status: CandidateEvaluationStatus): WorkbenchSnapshot['evidence'][number]['status'] {
  if (status.status === 'passed') return 'passed'
  if (status.status === 'prepared' || status.status === 'running') return 'running'
  return 'warning'
}

function candidateOperationId(): string {
  const unique = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `candidate-evaluation:${unique}`
}

function EvidencePanel({
  api,
  snapshot,
  thread,
  host,
}: {
  api: RendererApi
  snapshot: WorkbenchSnapshot
  thread: ThreadSummary
  host: HostSummary
}) {
  const authority = useMemo<CandidateEvaluationPreflightRequest | null>(() => {
    if (
      api.environment !== 'native' ||
      snapshot.operations.candidateEvaluationProbe !== true ||
      snapshot.selectedThreadId !== thread.id ||
      host.id !== thread.hostId ||
      host.kind !== 'local' ||
      host.connection !== 'online' ||
      !thread.executionGenerationId ||
      !api.candidateEvaluationPreflight ||
      !api.startCandidateEvaluation ||
      !api.candidateEvaluationSnapshot
    ) return null
    return {
      expectedHostId: host.id,
      threadId: thread.remoteId ?? thread.id,
      expectedExecutionGenerationId: thread.executionGenerationId,
    }
  }, [api, host.connection, host.id, host.kind, snapshot.operations.candidateEvaluationProbe, snapshot.selectedThreadId, thread.executionGenerationId, thread.hostId, thread.id, thread.remoteId])
  const [loadState, setLoadState] = useState<CandidateEvaluationLoadState>({
    kind: 'idle',
    message: 'Candidate evaluation is available only for an exact online workspace on this computer.',
  })
  const [evaluations, setEvaluations] = useState<CandidateEvaluationStatus[]>([])
  const [repeatEffectsWarningRequired, setRepeatEffectsWarningRequired] = useState(false)
  const [activeOperationId, setActiveOperationId] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [starting, setStarting] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const triggerRef = useRef<HTMLElement | null>(null)
  const confirmationRef = useRef<HTMLInputElement>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const authorityEpochRef = useRef(0)
  const latestSnapshotTimeRef = useRef(0)
  const pendingStartRef = useRef<CandidateEvaluationStartRequest | null>(null)

  const publishEvaluationSnapshot = useCallback((result: CandidateEvaluationSnapshot): void => {
    if (!authority || !candidateEvaluationMatchesAuthority(authority, result)) return
    const generatedAt = Date.parse(result.generatedAt)
    if (!Number.isFinite(generatedAt) || generatedAt < latestSnapshotTimeRef.current) return
    latestSnapshotTimeRef.current = generatedAt
    setRepeatEffectsWarningRequired(result.repeatEffectsWarningRequired)
    const ordered = [...result.evaluations].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    setEvaluations(ordered)
    const nonterminal = ordered.find(candidateEvaluationIsNonterminal)
    if (nonterminal) {
      setActiveOperationId(nonterminal.operationId)
      return
    }
    const pending = pendingStartRef.current
    if (!pending) {
      setActiveOperationId('')
      return
    }
    const exactPending = ordered.find((evaluation) => evaluation.operationId === pending.operationId)
    if (exactPending) {
      pendingStartRef.current = null
      setActiveOperationId('')
    }
  }, [authority])

  useEffect(() => {
    const epoch = authorityEpochRef.current + 1
    authorityEpochRef.current = epoch
    latestSnapshotTimeRef.current = 0
    pendingStartRef.current = null
    setEvaluations([])
    setRepeatEffectsWarningRequired(false)
    setActiveOperationId('')
    setDialogOpen(false)
    setConfirmed(false)
    setStarting(false)
    setDialogError('')
    setAnnouncement('')
    if (!authority || !api.candidateEvaluationPreflight || !api.candidateEvaluationSnapshot) {
      setLoadState({
        kind: 'idle',
        message: 'Candidate evaluation is available only for an exact online workspace on this computer.',
      })
      return () => {
        authorityEpochRef.current += 1
      }
    }

    let cancelled = false
    let refreshTimer: number | undefined
    const refresh = async (): Promise<void> => {
      setLoadState({ kind: 'checking', message: 'Checking the passive workspace and launcher fingerprint with durable evaluation history…' })
      try {
        const [preflight, history] = await Promise.all([
          api.candidateEvaluationPreflight!(authority),
          api.candidateEvaluationSnapshot!(authority),
        ])
        if (cancelled || authorityEpochRef.current !== epoch) return
        if (
          !candidateEvaluationMatchesAuthority(authority, preflight) ||
          !candidateEvaluationMatchesAuthority(authority, history)
        ) {
          throw new Error('The evaluation preflight did not match the selected host and thread generation.')
        }
        publishEvaluationSnapshot(history)
        if (preflight.status === 'ready') {
          setLoadState({
            kind: 'ready',
            preflight,
            message: 'Passive launcher/workspace review fingerprint ready · this is not the canonical candidate; canonical candidate and toolchain capture occurs only inside the consented evaluation',
          })
        } else {
          setLoadState({ kind: 'unavailable', message: `${preflight.code} · ${preflight.message}` })
        }
      } catch (reason) {
        if (cancelled || authorityEpochRef.current !== epoch) return
        setLoadState({
          kind: 'error',
          message: reason instanceof Error ? reason.message : 'Candidate evaluation preflight is unavailable.',
        })
      } finally {
        if (!cancelled && authorityEpochRef.current === epoch) {
          refreshTimer = window.setTimeout(() => void refresh(), CANDIDATE_PREFLIGHT_REFRESH_MS)
        }
      }
    }
    void refresh()
    return () => {
      cancelled = true
      authorityEpochRef.current += 1
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    }
  }, [api, authority, publishEvaluationSnapshot])

  useEffect(() => {
    if (!authority || !activeOperationId || !api.candidateEvaluationSnapshot) return
    const epoch = authorityEpochRef.current
    let cancelled = false
    let pollTimer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const result = await api.candidateEvaluationSnapshot!(authority)
        if (cancelled || authorityEpochRef.current !== epoch) return
        if (!candidateEvaluationMatchesAuthority(authority, result)) return
        publishEvaluationSnapshot(result)
        const exact = result.evaluations.find((evaluation) => evaluation.operationId === activeOperationId)
        if (exact && !candidateEvaluationIsNonterminal(exact)) {
          setAnnouncement(candidateEvaluationStatusLabel(exact))
          return
        }
      } catch (reason) {
        if (cancelled || authorityEpochRef.current !== epoch) return
        setAnnouncement(reason instanceof Error
          ? `Evaluation status unavailable · ${reason.message}`
          : 'Evaluation status is temporarily unavailable. The operation will not be replayed automatically.')
      }
      if (!cancelled && authorityEpochRef.current === epoch) {
        pollTimer = window.setTimeout(() => void poll(), CANDIDATE_EVALUATION_POLL_MS)
      }
    }
    pollTimer = window.setTimeout(() => void poll(), CANDIDATE_EVALUATION_POLL_MS)
    return () => {
      cancelled = true
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
    }
  }, [activeOperationId, api, authority, publishEvaluationSnapshot])

  const reviewedPreflight = loadState.kind === 'ready' ? loadState.preflight : undefined
  const sameReviewEvaluations = reviewedPreflight
    ? evaluations.filter((evaluation) => sameCandidateEvaluationReview(evaluation.review, reviewedPreflight.review))
    : []
  const sameReviewBlocked = sameReviewEvaluations.some((evaluation) =>
    evaluation.status === 'passed' || candidateEvaluationIsNonterminal(evaluation),
  )
  const secondEffectsWarning = repeatEffectsWarningRequired
  const canStartEvaluation = Boolean(
    authority &&
    reviewedPreflight &&
    !activeOperationId &&
    !pendingStartRef.current &&
    !sameReviewBlocked &&
    !starting,
  )
  const displayedEvaluation = evaluations.find((evaluation) => evaluation.operationId === activeOperationId) ?? evaluations[0]

  const openConfirmation = (trigger: HTMLElement): void => {
    if (!canStartEvaluation) return
    triggerRef.current = trigger
    setConfirmed(false)
    setDialogError('')
    setDialogOpen(true)
  }

  const startEvaluation = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!authority || !reviewedPreflight || !api.startCandidateEvaluation || !api.candidateEvaluationPreflight || !api.candidateEvaluationSnapshot || starting) return
    if (!confirmed) {
      setDialogError('Confirm that you understand this evaluation is not a security sandbox.')
      confirmationRef.current?.focus()
      return
    }
    const epoch = authorityEpochRef.current
    const envelope = pendingStartRef.current ?? {
      ...authority,
      operationId: candidateOperationId(),
      requestedAt: new Date().toISOString(),
      kind: 'prime_continuim_self_build_v1' as const,
      expectedReview: reviewedPreflight.review,
    }
    pendingStartRef.current = envelope
    let invocationAttempted = false
    setStarting(true)
    setDialogError('')
    setAnnouncement('Rechecking the passive workspace and launcher fingerprint before admission…')
    try {
      const [freshPreflight, history] = await Promise.all([
        api.candidateEvaluationPreflight(authority),
        api.candidateEvaluationSnapshot(authority),
      ])
      if (authorityEpochRef.current !== epoch) return
      if (
        !candidateEvaluationMatchesAuthority(authority, freshPreflight) ||
        !candidateEvaluationMatchesAuthority(authority, history)
      ) throw new Error('The selected host or thread generation changed during confirmation.')
      publishEvaluationSnapshot(history)
      const nonterminal = history.evaluations.find(candidateEvaluationIsNonterminal)
      if (nonterminal) {
        pendingStartRef.current = null
        setActiveOperationId(nonterminal.operationId)
        setAnnouncement('An evaluation for this exact authority is already in progress. Its status is shown below.')
        setDialogOpen(false)
        return
      }
      if (freshPreflight.status !== 'ready') {
        pendingStartRef.current = null
        setLoadState({ kind: 'unavailable', message: `${freshPreflight.code} · ${freshPreflight.message}` })
        throw new Error('The evaluation is no longer ready. Review the refreshed passive preflight.')
      }
      if (!sameCandidateEvaluationReview(freshPreflight.review, envelope.expectedReview)) {
        pendingStartRef.current = null
        setLoadState({
          kind: 'ready',
          preflight: freshPreflight,
          message: 'The passive workspace or launcher fingerprint changed after review. Confirm the new fingerprint before running the evaluation.',
        })
        throw new Error('The passive workspace or launcher fingerprint changed after review. No evaluation was started.')
      }
      if (history.repeatEffectsWarningRequired && !secondEffectsWarning) {
        pendingStartRef.current = null
        setConfirmed(false)
        window.requestAnimationFrame(() => confirmationRef.current?.focus())
        throw new Error('Evaluation history now requires the repeated-effects warning. Review the stronger warning and confirm again. No evaluation was started.')
      }
      if (authorityEpochRef.current !== epoch) return
      setAnnouncement('Admitting the consented evaluation…')
      invocationAttempted = true
      const status = await api.startCandidateEvaluation(envelope)
      if (authorityEpochRef.current !== epoch) return
      if (
        !candidateEvaluationMatchesAuthority(authority, status) ||
        status.operationId !== envelope.operationId ||
        !sameCandidateEvaluationReview(status.review, envelope.expectedReview)
      ) throw new Error('The evaluation admission reply did not match the exact confirmed operation and passive review identity.')
      setEvaluations((current) => [status, ...current.filter((entry) => entry.operationId !== status.operationId)])
      if (candidateEvaluationIsNonterminal(status)) {
        setActiveOperationId(status.operationId)
      } else {
        pendingStartRef.current = null
        setActiveOperationId('')
      }
      setAnnouncement(candidateEvaluationStatusLabel(status))
      setDialogOpen(false)
      window.requestAnimationFrame(() => statusRef.current?.focus())
    } catch (reason) {
      if (authorityEpochRef.current !== epoch) return
      if (
        invocationAttempted &&
        pendingStartRef.current &&
        !isDefinitiveCandidateEvaluationStartError(reason)
      ) {
        setActiveOperationId(envelope.operationId)
        setAnnouncement('The start acknowledgement is unavailable. Checking the exact operation without creating or replaying another one.')
        setDialogOpen(false)
        window.requestAnimationFrame(() => statusRef.current?.focus())
      } else {
        pendingStartRef.current = null
        if (invocationAttempted) {
          setAnnouncement('The evaluation was rejected before admission. No operation was started.')
        }
        setDialogError(reason instanceof Error ? reason.message : 'The consented evaluation could not be admitted.')
      }
    } finally {
      if (authorityEpochRef.current === epoch) setStarting(false)
    }
  }

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
              <span className="sr-only">{runtimeStateLabel(evidence.status)}. </span>
              <strong>{evidence.label}</strong>
              <small>{evidence.detail}</small>
            </span>
            {evidence.duration && <time className="tabular">{evidence.duration}</time>}
          </li>
        ))}
      </ul>
      {api.environment === 'native' && (
        <section className="candidate-evaluation" aria-labelledby="candidate-evaluation-heading">
          <div className="candidate-evaluation__heading">
            <div>
              <h3 id="candidate-evaluation-heading">Candidate evaluation</h3>
              <p>Canonical self-build evidence for this exact local thread generation.</p>
            </div>
            {canStartEvaluation && (
              <button
                className="button button--secondary button--small"
                type="button"
                onClick={(event) => openConfirmation(event.currentTarget)}
              >
                <Icon icon={TestTube2} size={14} />
                Evaluate candidate
              </button>
            )}
          </div>
          <p
            ref={statusRef}
            className={cx('candidate-evaluation__status', loadState.kind === 'error' && 'candidate-evaluation__status--warning')}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            tabIndex={-1}
          >
            {announcement || loadState.message}
          </p>
          {reviewedPreflight && (
            <dl className="candidate-evaluation__identity">
              <div><dt>Reviewed HEAD</dt><dd><code>{reviewedPreflight.review.headCommit.slice(0, 12)}</code></dd></div>
              <div><dt>Passive fingerprint</dt><dd><code>{reviewedPreflight.review.reviewAggregateSha256.slice(0, 12)}</code></dd></div>
              <div><dt>Required toolchain</dt><dd className="tabular">Node {reviewedPreflight.executor.requiredNodeVersion} · pnpm {reviewedPreflight.executor.requiredPnpmVersion}</dd></div>
            </dl>
          )}
          {displayedEvaluation && (
            <article className={cx('candidate-evaluation__result', `candidate-evaluation__result--${candidateEvaluationTone(displayedEvaluation)}`)}>
              <span className={cx('evidence-state', `evidence-state--${candidateEvaluationTone(displayedEvaluation)}`)}>
                <Icon icon={displayedEvaluation.status === 'passed' ? CheckCircle2 : candidateEvaluationIsNonterminal(displayedEvaluation) ? Loader2 : AlertCircle} size={15} />
              </span>
              <div>
                <strong>{candidateEvaluationStatusLabel(displayedEvaluation)}</strong>
                <p>{candidateEvaluationStatusDetail(displayedEvaluation)}</p>
                <code>{displayedEvaluation.operationId}</code>
              </div>
            </article>
          )}
          <div className="candidate-evaluation__boundary" role="note">
            <Icon icon={AlertCircle} size={15} />
            <p><strong>Runs with your user permissions.</strong> Candidate scripts can access the same files you can. The copied worktree is not a security sandbox and does not isolate the main filesystem.</p>
          </div>

          <NativeDialog
            open={dialogOpen}
            labelledBy="candidate-evaluation-dialog-title"
            describedBy="candidate-evaluation-dialog-description"
            triggerRef={triggerRef}
            onClose={() => {
              if (starting) return
              setDialogOpen(false)
              setDialogError('')
            }}
            className="sheet--candidate-evaluation"
            dismissible={!starting}
          >
            <form className="sheet__frame" onSubmit={(event) => void startEvaluation(event)} aria-busy={starting}>
              <header className="sheet__header">
                <div className="sheet__title-group">
                  <span className="sheet__title-icon sheet__title-icon--warning"><Icon icon={AlertCircle} size={18} /></span>
                  <div>
                    <h2 id="candidate-evaluation-dialog-title">Evaluate this candidate?</h2>
                    <p id="candidate-evaluation-dialog-description">Prime Continuim will recheck this passive launcher/workspace fingerprint—not the canonical candidate—then capture the canonical candidate and toolchain inside the consented self-build evaluation.</p>
                  </div>
                </div>
                <button className="icon-button" type="button" aria-label="Close candidate evaluation review" onClick={() => setDialogOpen(false)} disabled={starting}>
                  <Icon icon={X} size={17} />
                </button>
              </header>
              <div className="sheet__scroll candidate-evaluation-dialog__body">
                <div className="candidate-evaluation__boundary candidate-evaluation__boundary--dialog" role="note">
                  <Icon icon={AlertCircle} size={16} />
                  <p>
                    <strong>{secondEffectsWarning ? 'The previous outcome is unknown.' : 'This is not a security sandbox.'}</strong>{' '}
                    {secondEffectsWarning
                      ? 'Starting a separate operation may repeat candidate-script effects. It still runs with your user permissions and the copied worktree does not isolate the main filesystem.'
                      : 'Candidate scripts run with your user permissions. The copied worktree does not isolate the main filesystem.'}
                  </p>
                </div>
                <label className="candidate-evaluation-dialog__confirmation">
                  <input
                    ref={confirmationRef}
                    data-dialog-autofocus
                    type="checkbox"
                    checked={confirmed}
                    disabled={starting}
                    aria-invalid={dialogError && !confirmed ? 'true' : undefined}
                    aria-describedby="candidate-evaluation-dialog-error"
                    onChange={(event) => {
                      setConfirmed(event.target.checked)
                      if (event.target.checked) setDialogError('')
                    }}
                  />
                  <span>{secondEffectsWarning
                    ? 'I understand that this separate operation may repeat effects from the evaluation whose outcome is unknown.'
                    : 'I understand that this evaluation runs untrusted candidate scripts with my user permissions.'}</span>
                </label>
                <p id="candidate-evaluation-dialog-error" className="form-error" role="alert">{dialogError}</p>
                <p className="form-status" role="status" aria-live="polite" aria-atomic="true">
                  {starting ? 'Rechecking the passive fingerprint and admitting the evaluation…' : ''}
                </p>
              </div>
              <footer className="sheet__footer">
                <button className="button button--secondary" type="button" onClick={() => setDialogOpen(false)} disabled={starting}>Cancel</button>
                <button className="button button--primary" type="submit" disabled={starting}>
                  <Icon icon={starting ? Loader2 : TestTube2} size={15} />
                  {starting ? 'Starting…' : 'Run evaluation'}
                </button>
              </footer>
            </form>
          </NativeDialog>
        </section>
      )}
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
  canEndResident: boolean
  canManageComputers: boolean
  triggerRef: RefObject<HTMLElement | null>
  onClose: () => void
  onSelectThread: (thread: ThreadSummary) => void
  onSelectProject: (projectId: string) => void
  onAddComputer: () => void
  onOpenInspector: () => void
  onOpenModels: () => void
  onFocusComposer: () => void
  onEndResident: () => void
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
  canEndResident,
  canManageComputers,
  triggerRef,
  onClose,
  onSelectThread,
  onSelectProject,
  onAddComputer,
  onOpenInspector,
  onOpenModels,
  onFocusComposer,
  onEndResident,
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
    ...(snapshot.operations.submitCommands ? [{
      id: 'command:composer',
      label: snapshot.operations.stopResidentTurn ? 'Focus active turn controls' : 'Focus prompt composer',
      detail: snapshot.operations.stopResidentTurn
        ? 'Review or stop the active resident Prime Agent turn'
        : 'Write a new prompt for the resident Prime Agent session',
      group: 'Commands' as const,
      icon: Command,
      keywords: 'message prompt compose run stop abort resident',
      run: onFocusComposer,
    }] : []),
    {
      id: 'command:inspector',
      label: 'Open changes and evidence',
      detail: 'Review files, agents, checks, and execution context',
      group: 'Commands' as const,
      icon: ListChecks,
      keywords: 'changes evidence tests agents context inspector',
      run: onOpenInspector,
    },
    ...(snapshot.operations.modelCatalog ? [{
      id: 'command:models',
      label: 'Open models & accounts',
      detail: 'Inspect provider status and the verified Prime Agent model catalog',
      group: 'Commands' as const,
      icon: Bot,
      keywords: 'models providers accounts oauth login inference',
      run: onOpenModels,
    }] : []),
    ...(canEndResident ? [{
      id: 'command:end-resident',
      label: 'End resident session…',
      detail: 'Permanently stop this runtime while preserving the saved thread and workspace',
      group: 'Commands' as const,
      icon: AlertCircle,
      keywords: 'end resident session permanent stop runtime preserve thread workspace',
      run: onEndResident,
    }] : []),
    ...(canManageComputers ? [{
      id: 'command:add-computer',
      label: 'Add computer',
      detail: 'Discover and verify a configured SSH host',
      group: 'Commands' as const,
      icon: Computer,
      keywords: 'add computer ssh host remote machine',
      run: onAddComputer,
    }] : []),
  ], [canEndResident, canManageComputers, onAddComputer, onEndResident, onFocusComposer, onOpenInspector, onOpenModels, onSelectProject, onSelectThread, snapshot])

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
          <kbd className="command-palette__shortcut" aria-hidden="true">Esc</kbd>
          <button
            className="icon-button command-palette__close"
            type="button"
            aria-label="Close search and commands"
            onClick={onClose}
          >
            <Icon icon={X} size={17} />
          </button>
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
        const focusTarget = dialog.querySelector<HTMLElement>('[data-dialog-autofocus], [autofocus]') ??
          dialog.querySelector<HTMLElement>('button, [href], input, select, textarea')
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

function residentLifecycleQuarantineStatusDetail(status: ResidentLifecycleStatusResult | undefined): string {
  if (status?.kind === 'end') {
    return status.quarantineReason === 'authority_changed'
      ? 'The verified host authority changed while permanent ending was being recorded. The resident session remains locked.'
      : 'Prime Agent may have received the permanent end, but its exact outcome cannot be proven. Prime Continuim will not send another kill.'
  }
  if (status?.quarantineReason === 'owned_client_lost') {
    return 'The temporary Prime Agent owner disconnected before promotion could be proven. Automatic retry is blocked.'
  }
  if (status?.quarantineReason === 'authority_changed') {
    return 'The verified host authority changed while setup was being recorded. Automatic retry is blocked.'
  }
  if (status?.quarantineReason === 'explicit_reconciliation_required') {
    return 'The durable lifecycle record needs manual reconciliation before this workspace can continue.'
  }
  return 'Prime Agent may have crossed an external mutation boundary whose outcome cannot be proven. Automatic retry is blocked.'
}

function residentLifecycleQuarantineDetail(operation: ResidentLifecycleOperationSummary): string {
  return residentLifecycleQuarantineStatusDetail(operation.lastStatus)
}

function residentLifecycleQuarantineDiagnostic(operation: ResidentLifecycleOperationSummary): string {
  const status = operation.lastStatus
  return [
    'RESIDENT_LIFECYCLE_QUARANTINED',
    `Operation ID: ${operation.operationId}`,
    `Host ID: ${operation.expectedHostId}`,
    `Thread ID: ${operation.threadId}`,
    `Execution generation: ${operation.executionGenerationId}`,
    `Reason: ${status?.quarantineReason ?? 'not_reported'}`,
    `Quarantined from: ${status?.quarantinedFrom ?? 'not_reported'}`,
    `Updated at: ${status?.updatedAt ?? operation.updatedAt}`,
  ].join('\n')
}

function residentLifecycleFallbackQuarantineDiagnostic(reference: ResidentLifecycleRecoveryReference): string {
  const status = reference.status
  return [
    'RESIDENT_LIFECYCLE_QUARANTINED',
    `Operation ID: ${reference.operationId}`,
    `Host ID: ${reference.expectedHostId}`,
    `Thread ID: ${status?.threadId ?? reference.threadId ?? 'not_reported'}`,
    `Execution generation: ${status?.executionGenerationId ?? reference.executionGenerationId ?? 'not_reported'}`,
    `Reason: ${status?.quarantineReason ?? 'not_reported'}`,
    `Quarantined from: ${status?.quarantinedFrom ?? 'not_reported'}`,
    `Updated at: ${status?.updatedAt ?? 'not_reported'}`,
  ].join('\n')
}

function residentLifecycleRecoveryCopy(operation: ResidentLifecycleOperationSummary): {
  label: string
  detail: string
  tone: 'neutral' | 'warning' | 'success'
  action?: 'choose' | 'check' | 'copy'
  actionLabel?: string
  diagnostic?: string
} {
  const status = operation.lastStatus
  if (operation.kind === 'end') {
    if (status?.phase === 'quarantined') {
      return {
        label: 'End outcome needs inspection',
        detail: residentLifecycleQuarantineDetail(operation),
        tone: 'warning',
        action: 'copy',
        actionLabel: 'Copy diagnostic',
        diagnostic: residentLifecycleQuarantineDiagnostic(operation),
      }
    }
    if (operation.state === 'terminal_refresh_pending' || status?.phase === 'completed') {
      return {
        label: 'Resident session ended',
        detail: 'Prime Agent confirmed the permanent end. The saved thread and workspace remain available.',
        tone: 'success',
        action: 'check',
        actionLabel: 'Refresh saved thread',
      }
    }
    if (status?.phase === 'ending') {
      return {
        label: 'End review required',
        detail: 'Permanent ending was recorded before the kill boundary. Review the exact session again to continue.',
        tone: 'warning',
        action: 'choose',
        actionLabel: 'Review end again',
      }
    }
    return {
      label: status?.phase === 'kill_dispatching' || status?.phase === 'kill_acknowledged'
        ? 'Permanent end is settling'
        : 'End outcome needs inspection',
      detail: 'Prime Continuim will not send another kill automatically. Check the exact durable host status.',
      tone: 'warning',
      action: 'check',
      actionLabel: 'Check status',
    }
  }
  const registeredWorkspace = operationUsesRegisteredWorkspace(operation)
  if (operation.state === 'requires_reselection') {
    return {
      label: 'Workspace confirmation needed',
      detail: registeredWorkspace
        ? 'Use the same saved host-owned workspace so Prime Continuim can safely resume this exact setup.'
        : 'Choose the same folder again so Prime Continuim can safely resume this exact setup.',
      tone: 'warning',
      action: 'choose',
      actionLabel: registeredWorkspace ? 'Use saved workspace' : 'Choose original folder',
    }
  }
  if (status?.phase === 'completed' && status.completionReason === 'owned_create_failed_before_effect') {
    return {
      label: 'Resident setup did not start',
      detail: registeredWorkspace
        ? 'Prime Agent did not create a session. Use this saved workspace to try a new setup safely.'
        : 'Prime Agent did not create a session. Choose the same folder to try a new setup safely.',
      tone: 'warning',
      action: 'choose',
      actionLabel: registeredWorkspace ? 'Use workspace and try again' : 'Choose folder and try again',
    }
  }
  if (status?.phase === 'completed' && status.completionReason === 'owned_create_cleaned') {
    return {
      label: 'Temporary session cleaned up',
      detail: 'Prime Agent removed the temporary session before resident setup completed. No resident session remains.',
      tone: 'warning',
      action: 'choose',
      actionLabel: registeredWorkspace ? 'Use workspace and try again' : 'Choose folder and try again',
    }
  }
  if (
    operation.state === 'submitted' &&
    (status?.phase === 'prepared' || status?.phase === 'promoted_observed' || status?.phase === 'projection_committed')
  ) {
    return {
      label: 'Setup paused safely',
      detail: registeredWorkspace
        ? 'Continue in the saved host-owned workspace. Prime Continuim will not repeat a completed mutation.'
        : 'Choose the original folder to continue this exact operation. Prime Continuim will not repeat a completed mutation.',
      tone: 'warning',
      action: 'choose',
      actionLabel: registeredWorkspace ? 'Continue in saved workspace' : 'Choose original folder',
    }
  }
  if (status?.phase === 'quarantined') {
    return {
      label: 'Setup needs manual recovery',
      detail: residentLifecycleQuarantineDetail(operation),
      tone: 'warning',
      action: 'copy',
      actionLabel: 'Copy diagnostic',
      diagnostic: residentLifecycleQuarantineDiagnostic(operation),
    }
  }
  if (operation.state === 'outcome_unknown') {
    return {
      label: 'Setup outcome needs inspection',
      detail: 'Prime Continuim will not retry this operation automatically because the resident session outcome is not proven.',
      tone: 'warning',
      action: 'check',
      actionLabel: 'Check status',
    }
  }
  if (operation.state === 'terminal_refresh_pending' || status?.phase === 'committed') {
    return {
      label: 'Resident thread created',
      detail: 'The durable setup is complete. Prime Continuim is refreshing the thread before opening it.',
      tone: 'success',
      action: 'check',
      actionLabel: 'Refresh status',
    }
  }
  return {
    label: 'Resident setup in progress',
    detail: 'Prime Continuim is checking the durable host record. It will not replay a mutation while the outcome is unknown.',
    tone: 'neutral',
    action: 'check',
    actionLabel: 'Check status',
  }
}

function ResidentLifecycleRecoveryList({
  operations,
  mutationBlock,
  isCheckable,
  busy,
  onChoose,
  onCheck,
}: {
  operations: ResidentLifecycleOperationSummary[]
  mutationBlock: (operation: ResidentLifecycleOperationSummary) => ResidentLifecycleMutationBlock | null
  isCheckable: (operation: ResidentLifecycleOperationSummary) => boolean
  busy: boolean
  onChoose: (operation: ResidentLifecycleOperationSummary, event: ReactMouseEvent<HTMLButtonElement>) => void
  onCheck: (operation: ResidentLifecycleOperationSummary) => void
}) {
  const [first, ...remaining] = operations
  if (!first) return null
  const card = (operation: ResidentLifecycleOperationSummary) => (
    <ResidentLifecycleRecoveryCard
      key={operation.operationId}
      operation={operation}
      mutationBlock={mutationBlock(operation)}
      checkable={isCheckable(operation)}
      busy={busy}
      onChoose={(event) => onChoose(operation, event)}
      onCheck={() => onCheck(operation)}
    />
  )
  return (
    <div className="resident-recovery-list">
      {card(first)}
      {remaining.length > 0 && (
        <details className="resident-recovery-list__more">
          <summary>{remaining.length} other {remaining.length === 1 ? 'setup needs' : 'setups need'} attention</summary>
          <div>{remaining.map(card)}</div>
        </details>
      )}
    </div>
  )
}

function ResidentLifecycleFallbackCard({
  reference,
  mutationBlock,
  checkable,
  busy,
  onChoose,
  onCheck,
}: {
  reference: ResidentLifecycleRecoveryReference
  mutationBlock: ResidentLifecycleMutationBlock | null
  checkable: boolean
  busy: boolean
  onChoose: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onCheck: () => void
}) {
  const status = reference.status
  const registeredWorkspace = reference.workspaceKind === 'registered_workspace'
  const safelyReselectable = status?.phase === 'prepared' ||
    status?.phase === 'promoted_observed' ||
    status?.phase === 'projection_committed' ||
    status?.phase === 'completed'
  const quarantined = status?.phase === 'quarantined'
  const committed = status?.phase === 'committed'
  const label = quarantined
    ? 'Setup needs manual recovery'
    : safelyReselectable
      ? status?.phase === 'completed' ? 'Resident setup ended safely' : 'Setup paused safely'
      : committed
        ? 'Resident thread created'
        : 'Setup outcome needs inspection'
  const baseDetail = quarantined
    ? residentLifecycleQuarantineStatusDetail(status)
    : safelyReselectable
      ? status?.phase === 'completed'
        ? status.completionReason === 'owned_create_cleaned'
          ? registeredWorkspace
            ? 'Prime Agent cleaned up the temporary session. Use the saved workspace to start a new setup.'
            : 'Prime Agent cleaned up the temporary session. Choose the original folder to start a new setup.'
          : registeredWorkspace
            ? 'Prime Agent did not create a session. Use the saved workspace to try again.'
            : 'Prime Agent did not create a session. Choose the original folder to try again.'
        : registeredWorkspace
          ? 'Continue in the saved host-owned workspace without replaying a completed mutation.'
          : 'Choose the original folder to continue this exact operation without replaying a completed mutation.'
      : committed
        ? 'The durable setup is complete. Prime Continuim is refreshing its authoritative thread snapshot.'
        : 'The setup request ended before its durable record could be displayed. Prime Continuim will not retry it automatically.'
  const canResume = mutationBlock === null
  const detail = safelyReselectable && mutationBlock
    ? residentLifecycleMutationBlockedDetail(mutationBlock, 'provision')
    : baseDetail
  return (
    <section
      className="resident-recovery resident-recovery--warning resident-recovery--fallback"
      aria-labelledby={`resident-recovery-fallback-${reference.operationId}`}
    >
      <span className="resident-recovery__icon"><Icon icon={AlertCircle} size={17} /></span>
      <div className="resident-recovery__body">
        <h2 id={`resident-recovery-fallback-${reference.operationId}`}>{label}</h2>
        <p>{detail}</p>
        <small><bdi>{reference.suggestedName}</bdi></small>
      </div>
      <div className="resident-recovery__actions">
        {(quarantined || !status || safelyReselectable === false || !canResume) && (
          quarantined ? (
            <ResidentLifecycleDiagnosticAction
              diagnostic={residentLifecycleFallbackQuarantineDiagnostic(reference)}
              diagnosticLabel="Resident setup diagnostic"
            />
          ) : (
            <button className="button button--secondary button--small" type="button" disabled={!checkable || busy} onClick={onCheck}>
              <Icon icon={RefreshCw} size={14} /> {busy ? 'Checking…' : committed ? 'Refresh status' : 'Check status'}
            </button>
          )
        )}
        {Boolean(status) && safelyReselectable && canResume && (
          <button className="button button--secondary button--small" type="button" disabled={busy} onClick={onChoose}>
            <Icon icon={FolderGit2} size={14} />
            {registeredWorkspace ? 'Use saved workspace' : 'Choose original folder'}
          </button>
        )}
      </div>
    </section>
  )
}

function ResidentLifecycleRecoveryCard({
  operation,
  mutationBlock,
  checkable,
  busy,
  onChoose,
  onCheck,
}: {
  operation: ResidentLifecycleOperationSummary
  mutationBlock: ResidentLifecycleMutationBlock | null
  checkable: boolean
  busy: boolean
  onChoose: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onCheck: () => void
}) {
  const presentation = residentLifecycleRecoveryCopy(operation)
  const statusOnly = presentation.action === 'choose' && mutationBlock !== null
  const detail = statusOnly
    ? residentLifecycleMutationBlockedDetail(mutationBlock, operation.kind)
    : presentation.detail
  const canAct = statusOnly || presentation.action === 'check'
    ? checkable
    : presentation.action === 'copy'
      ? true
      : mutationBlock === null
  const performAction = statusOnly
    ? onCheck
    : presentation.action === 'choose'
      ? onChoose
      : onCheck
  const actionIcon = statusOnly
    ? RefreshCw
    : presentation.action === 'choose'
      ? FolderGit2
      : RefreshCw
  const actionLabel = statusOnly
    ? busy ? 'Checking…' : 'Check status'
    : busy
      ? presentation.action === 'choose' ? 'Opening…' : 'Checking…'
      : presentation.actionLabel
  return (
    <section
      className={cx(
        'resident-recovery',
        `resident-recovery--${presentation.tone}`,
        presentation.action === 'copy' && 'resident-recovery--fallback',
      )}
      aria-labelledby={`resident-recovery-${operation.operationId}`}
    >
      <span className="resident-recovery__icon">
        <Icon icon={presentation.tone === 'success' ? CheckCircle2 : presentation.tone === 'warning' ? AlertCircle : Clock3} size={17} />
      </span>
      <div className="resident-recovery__body">
        <h2 id={`resident-recovery-${operation.operationId}`}>{presentation.label}</h2>
        <p>{detail}</p>
        <small>
          {operation.kind === 'provision'
            ? <><bdi>{operation.projectDisplayName}</bdi> · <bdi>{operation.threadTitle}</bdi></>
            : <>Resident session · <bdi>{operation.threadId}</bdi></>}
        </small>
      </div>
      {presentation.action && (
        presentation.action === 'copy' && presentation.diagnostic ? (
          <div className="resident-recovery__actions">
            <ResidentLifecycleDiagnosticAction
              diagnostic={presentation.diagnostic}
              diagnosticLabel={operation.kind === 'end' ? 'Resident end diagnostic' : 'Resident setup diagnostic'}
            />
          </div>
        ) : (
          <button
            className="button button--secondary button--small"
            type="button"
            disabled={!canAct || busy}
            onClick={performAction}
          >
            <Icon icon={actionIcon} size={14} />
            {actionLabel}
          </button>
        )
      )}
    </section>
  )
}

function ResidentLifecycleDiagnosticAction({
  diagnostic,
  diagnosticLabel,
}: {
  diagnostic: string
  diagnosticLabel: string
}) {
  const [copyState, setCopyState] = useState<LocalSetupDiagnosticCopyState>('idle')
  const [fallbackDiagnostic, setFallbackDiagnostic] = useState('')
  const fallbackRef = useRef<HTMLTextAreaElement>(null)
  const requestRef = useRef(0)
  const id = useId()
  const fieldId = `${id}-resident-diagnostic`
  const instructionsId = `${id}-resident-diagnostic-instructions`

  useEffect(() => {
    requestRef.current += 1
    setCopyState('idle')
    setFallbackDiagnostic('')
    return () => {
      requestRef.current += 1
    }
  }, [diagnostic])

  const copyDiagnostic = async () => {
    const requestId = ++requestRef.current
    setCopyState('copying')
    setFallbackDiagnostic('')
    try {
      await writeClipboardText(diagnostic)
      if (requestId !== requestRef.current) return
      setCopyState('copied')
      window.setTimeout(() => {
        if (requestId === requestRef.current) setCopyState('idle')
      }, 1_600)
    } catch {
      if (requestId !== requestRef.current) return
      setCopyState('failed')
      setFallbackDiagnostic(diagnostic)
      window.requestAnimationFrame(() => {
        const field = fallbackRef.current
        field?.focus()
        field?.select()
      })
    }
  }

  return (
    <>
      <button
        className="button button--secondary button--small"
        type="button"
        disabled={copyState === 'copying'}
        aria-busy={copyState === 'copying'}
        onClick={() => void copyDiagnostic()}
      >
        <Icon icon={copyState === 'copying' ? Loader2 : copyState === 'copied' ? Check : Copy} size={14} />
        {copyState === 'copying'
          ? 'Copying diagnostic…'
          : copyState === 'copied'
            ? 'Diagnostic copied'
            : 'Copy diagnostic'}
        <span className="sr-only" aria-live="polite">{copyState === 'copied' ? 'Diagnostic copied' : ''}</span>
      </button>
      {fallbackDiagnostic && (
        <div className="local-setup__diagnostic-fallback">
          <strong>Clipboard unavailable</strong>
          <p id={instructionsId} role="alert">
            Unable to copy the diagnostic. It is selected below; copy it manually and share it with Prime Continuim support.
          </p>
          <label htmlFor={fieldId}>{diagnosticLabel}</label>
          <textarea
            ref={fallbackRef}
            id={fieldId}
            readOnly
            rows={5}
            value={fallbackDiagnostic}
            aria-describedby={instructionsId}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
    </>
  )
}

function ResidentProvisionDialog({
  api,
  selection,
  triggerRef,
  onClose,
  onRecoveryRequired,
  onCommitted,
}: {
  api: RendererApi
  selection: ResidentWorkspaceSelection | null
  triggerRef: RefObject<HTMLElement | null>
  onClose: () => void
  onRecoveryRequired: (reference: ResidentLifecycleRecoveryReference) => void
  onCommitted: (status: ResidentLifecycleStatusResult) => void
}) {
  const registeredWorkspace = selection?.kind === 'registered_workspace'
  const [projectDisplayName, setProjectDisplayName] = useState('')
  const [threadTitle, setThreadTitle] = useState('')
  const [invalidField, setInvalidField] = useState<'project' | 'thread' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [settled, setSettled] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const projectRef = useRef<HTMLInputElement>(null)
  const threadRef = useRef<HTMLInputElement>(null)
  const resultRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    if (!selection) return
    setProjectDisplayName(selection.suggestedName)
    setThreadTitle(`${selection.suggestedName} thread`)
    setInvalidField(null)
    setSubmitting(false)
    setSettled(false)
    setMessage('')
    setError('')
  }, [selection])

  useEffect(() => {
    if (!selection || !settled) return
    window.requestAnimationFrame(() => resultRef.current?.focus())
  }, [selection, settled])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!selection || submitting || settled) return
    const project = registeredWorkspace ? selection.suggestedName : projectDisplayName.trim()
    const thread = threadTitle.trim()
    if (!registeredWorkspace && (!project || project.length > 255 || /[\0\r\n]/.test(project))) {
      setInvalidField('project')
      setError('Enter a project name between 1 and 255 characters.')
      projectRef.current?.focus()
      return
    }
    if (!thread || thread.length > 255 || /[\0\r\n]/.test(thread)) {
      setInvalidField('thread')
      setError('Enter a thread title between 1 and 255 characters.')
      threadRef.current?.focus()
      return
    }
    setInvalidField(null)
    setError('')
    setMessage('Creating the durable resident thread…')
    setSubmitting(true)
    try {
      const status = await api.provisionResident({
        selectionToken: selection.selectionToken,
        projectDisplayName: project,
        threadTitle: thread,
      })
      setSettled(true)
      onRecoveryRequired({
        kind: 'provision',
        operationId: status.operationId,
        expectedHostId: status.expectedHostId,
        suggestedName: selection.suggestedName,
        workspaceKind: selection.kind ?? 'local_path',
        ...(selection.kind === 'registered_workspace'
          ? {
              projectId: selection.projectId,
              workspaceId: selection.workspaceId,
              referenceThreadId: selection.referenceThreadId,
              referenceExecutionGenerationId: selection.referenceExecutionGenerationId,
            }
          : {}),
        threadId: status.threadId,
        executionGenerationId: status.executionGenerationId,
        status,
      })
      if (status.phase === 'committed') {
        setMessage('Resident thread created. Opening its authoritative host snapshot…')
        onClose()
        onCommitted(status)
        return
      }
      if (status.phase === 'completed') {
        setMessage(registeredWorkspace
          ? status.completionReason === 'owned_create_cleaned'
            ? 'Prime Agent cleaned up the temporary session. No resident session remains; use this saved workspace when you are ready to try again.'
            : 'Prime Agent did not create a session. Use this saved workspace when you are ready to retry.'
          : status.completionReason === 'owned_create_cleaned'
            ? 'Prime Agent cleaned up the temporary session. No resident session remains; choose the original folder when you are ready to try again.'
            : 'Prime Agent did not create a session. Choose the original folder again when you are ready to retry.')
      } else if (status.phase === 'quarantined') {
        setError('The setup outcome is not proven. Prime Continuim will not retry it automatically; inspect the durable host state first.')
        setMessage('Resident setup stopped at an uncertain mutation boundary.')
      } else {
        setMessage(registeredWorkspace
          ? 'Setup is durably recorded. Continue in this saved workspace if recovery asks for it.'
          : 'Setup is durably recorded. Choose the original folder again if recovery asks for it.')
      }
    } catch (reason) {
      setSettled(true)
      if (residentProvisionMayHaveDurableOperation(reason)) {
        onRecoveryRequired({
          kind: 'provision',
          operationId: selection.operationId,
          expectedHostId: selection.expectedHostId,
          suggestedName: selection.suggestedName,
          workspaceKind: selection.kind ?? 'local_path',
          ...(selection.kind === 'registered_workspace'
            ? {
                projectId: selection.projectId,
                workspaceId: selection.workspaceId,
                referenceThreadId: selection.referenceThreadId,
                referenceExecutionGenerationId: selection.referenceExecutionGenerationId,
              }
            : {}),
        })
      }
      setError(reason instanceof Error
        ? reason.message
        : 'Resident setup did not finish. Prime Continuim will not retry it automatically.')
      setMessage(residentProvisionMayHaveDurableOperation(reason)
        ? 'Check the durable recovery state before trying again.'
        : registeredWorkspace
          ? 'Close this dialog, refresh the saved workspace, and try again.'
          : 'Close this dialog, correct the issue, and choose the workspace folder again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <NativeDialog
      open={selection !== null}
      labelledBy="resident-provision-title"
      describedBy="resident-provision-description"
      triggerRef={triggerRef}
      onClose={onClose}
      className="sheet--resident"
      dismissible={!submitting}
    >
      <form className="sheet__frame" onSubmit={submit} aria-busy={submitting}>
        <header className="sheet__header">
          <div className="sheet__title-group">
            <span className="sheet__title-icon"><Icon icon={FolderGit2} size={18} /></span>
            <div>
              <h2 id="resident-provision-title">
                {registeredWorkspace ? 'New resident thread in this workspace' : 'Start resident thread'}
              </h2>
              <p id="resident-provision-description">
                {registeredWorkspace
                  ? 'Prime Agent will start this thread in the saved host-owned workspace. Only the new thread title can be changed here.'
                  : 'Confirm how this workspace appears in Prime Continuim. The verified local host keeps its folder location.'}
              </p>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={registeredWorkspace ? 'Close new resident thread setup' : 'Close resident setup'}
            onClick={onClose}
            disabled={submitting}
          >
            <Icon icon={X} size={17} />
          </button>
        </header>

        <div className="sheet__scroll resident-provision__fields">
          {registeredWorkspace ? (
            <div className="form-field">
              <span className="form-field__label">Saved project</span>
              <div className="form-field__fixed-value"><bdi>{selection?.suggestedName}</bdi></div>
              <small>Fixed by the selected host-owned workspace.</small>
            </div>
          ) : (
            <div className="form-field">
              <label htmlFor="resident-project-name">Project name</label>
              <input
                ref={projectRef}
                id="resident-project-name"
                type="text"
                value={projectDisplayName}
                maxLength={255}
                data-dialog-autofocus
                autoComplete="off"
                aria-invalid={invalidField === 'project'}
                aria-describedby={invalidField === 'project'
                  ? 'resident-project-help resident-provision-error'
                  : 'resident-project-help'}
                disabled={submitting || settled}
                onChange={(event) => {
                  setProjectDisplayName(event.target.value)
                  if (invalidField === 'project') {
                    setInvalidField(null)
                    setError('')
                  }
                }}
              />
              <small id="resident-project-help">Shown in the project list.</small>
            </div>
          )}
          <div className="form-field">
            <label htmlFor="resident-thread-title">Thread title</label>
            <input
              ref={threadRef}
              id="resident-thread-title"
              type="text"
              value={threadTitle}
              maxLength={255}
              data-dialog-autofocus={registeredWorkspace || undefined}
              autoComplete="off"
              aria-invalid={invalidField === 'thread'}
              aria-describedby={invalidField === 'thread'
                ? 'resident-thread-help resident-provision-error'
                : 'resident-thread-help'}
              disabled={submitting || settled}
              onChange={(event) => {
                setThreadTitle(event.target.value)
                if (invalidField === 'thread') {
                  setInvalidField(null)
                  setError('')
                }
              }}
            />
            <small id="resident-thread-help">Shown in the thread list and window title.</small>
          </div>
          <div className="resident-provision__privacy">
            <Icon icon={LockKeyhole} size={15} />
            <span>
              {registeredWorkspace
                ? 'Prime Continuim uses the saved project and workspace identity reported by this verified SSH host. No filesystem location is selected or shown.'
                : 'Prime Continuim does not display this folder location or send it to another computer. The verified local host uses it for this workspace.'}
            </span>
          </div>
          <p id="resident-provision-error" className="form-error" role="alert">{error}</p>
          <p
            ref={resultRef}
            className="form-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            tabIndex={settled ? -1 : undefined}
          >
            {message}
          </p>
        </div>

        <footer className="sheet__footer">
          <button className="button button--secondary" type="button" onClick={onClose} disabled={submitting}>
            {settled ? 'Close' : 'Cancel'}
          </button>
          {!settled && (
            <button className="button button--primary" type="submit" disabled={submitting}>
              <Icon icon={submitting ? Loader2 : FolderGit2} />
              {submitting
                ? 'Starting…'
                : registeredWorkspace ? 'Create resident thread' : 'Start resident thread'}
            </button>
          )}
        </footer>
      </form>
    </NativeDialog>
  )
}

function ResidentEndDialog({
  api,
  context,
  triggerRef,
  onClose,
  onSettled,
}: {
  api: RendererApi
  context: ResidentEndDialogContext | null
  triggerRef: RefObject<HTMLElement | null>
  onClose: () => void
  onSettled: (status: ResidentLifecycleStatusResult) => void
}) {
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [settled, setSettled] = useState(false)
  const [canCheckStatus, setCanCheckStatus] = useState(false)
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const confirmationRef = useRef<HTMLInputElement>(null)
  const resultRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    if (!context) return
    setConfirmed(false)
    setSubmitting(false)
    setSettled(false)
    setCanCheckStatus(false)
    setChecking(false)
    setMessage('')
    setError('')
  }, [context])

  useEffect(() => {
    if (!context || !settled) return
    window.requestAnimationFrame(() => resultRef.current?.focus())
  }, [context, settled])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!context || submitting || settled) return
    if (!confirmed) {
      setError('Confirm that you understand this resident session cannot be resumed.')
      confirmationRef.current?.focus()
      return
    }
    setError('')
    setMessage('Recording the permanent end before asking Prime Agent to stop…')
    setSubmitting(true)
    try {
      const status = await api.endResident({
        confirmationToken: context.preparation.confirmationToken,
        consent: true,
      })
      setSettled(true)
      onSettled(status)
      if (status.phase === 'completed') {
        setCanCheckStatus(false)
        setMessage('Resident session ended. The saved thread and workspace remain available.')
      } else if (status.phase === 'quarantined') {
        setCanCheckStatus(false)
        setMessage('Permanent ending stopped at an uncertain boundary.')
        setError('Prime Continuim will not send another kill. Copy the recovery diagnostic and inspect the durable host state.')
      } else {
        setCanCheckStatus(true)
        setMessage('Permanent ending is durably recorded. Prime Continuim will check status without replaying the kill.')
      }
    } catch (reason) {
      setSettled(true)
      if (isResidentEndSourceCursorChangedError(reason)) {
        setCanCheckStatus(false)
        setError(reason instanceof Error
          ? reason.message
          : 'Resident state changed after this end review.')
        setMessage('No end was admitted. Close this review, refresh the thread, and review the permanent action again.')
      } else {
        setCanCheckStatus(true)
        setError(reason instanceof Error
          ? reason.message
          : 'The resident end outcome could not be confirmed.')
        setMessage('Check the durable lifecycle status. Prime Continuim will not send another kill automatically.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const checkStatus = async () => {
    if (!context || checking) return
    setChecking(true)
    setError('')
    setMessage('Checking the durable resident end status…')
    try {
      const status = await api.residentLifecycleStatus({
        expectedHostId: context.preparation.expectedHostId,
        operationId: context.preparation.operationId,
      })
      if (!status) {
        setCanCheckStatus(false)
        setMessage('No durable status is available yet. The end outcome remains unknown, so Prime Continuim will not send another kill. Close this review and use Check status from recovery.')
        return
      }
      onSettled(status)
      if (status.kind !== 'end') {
        setCanCheckStatus(false)
        setError('The host returned a different lifecycle operation for this end review.')
        setMessage('No permanent action was retried.')
      } else if (status.phase === 'completed') {
        setCanCheckStatus(false)
        setMessage('Resident session ended. The saved thread and workspace remain available.')
      } else if (status.phase === 'quarantined') {
        setCanCheckStatus(false)
        setMessage('Permanent ending stopped at an uncertain boundary.')
        setError('Prime Continuim will not send another kill. Copy the recovery diagnostic and inspect the durable host state.')
      } else {
        setMessage('Status checked. Permanent ending is still settling; no mutation was replayed.')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The durable resident end status is unavailable.')
      setMessage('Status could not be checked. No permanent action was retried.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <NativeDialog
      open={context !== null}
      labelledBy="resident-end-title"
      describedBy="resident-end-description"
      triggerRef={triggerRef}
      onClose={onClose}
      className="sheet--resident-end"
      dismissible={!submitting}
    >
      <form className="sheet__frame" onSubmit={submit} aria-busy={submitting || checking}>
        <header className="sheet__header">
          <div className="sheet__title-group">
            <span className="sheet__title-icon sheet__title-icon--warning"><Icon icon={AlertCircle} size={18} /></span>
            <div>
              <h2 id="resident-end-title">End resident session?</h2>
              <p id="resident-end-description">
                This permanently stops the Prime Agent runtime for “{context?.threadTitle ?? 'this thread'}”. The saved thread and workspace remain available, but this resident session cannot be resumed.
              </p>
            </div>
          </div>
          <button className="icon-button" type="button" aria-label="Close resident end review" onClick={onClose} disabled={submitting}>
            <Icon icon={X} size={17} />
          </button>
        </header>

        <div className="sheet__scroll resident-end-dialog__body">
          <div className="resident-end-dialog__distinction" role="note">
            <Icon icon={Info} size={16} />
            <span>
              <strong>Closing is different from ending.</strong>
              Closing Prime Continuim only detaches this app; Prime Agent keeps running on <bdi>{`${context?.hostName ?? 'this computer'}.`}</bdi>
            </span>
          </div>
          <label className="resident-end-dialog__confirmation">
            <input
              ref={confirmationRef}
              type="checkbox"
              checked={confirmed}
              disabled={submitting || settled}
              aria-invalid={error && !confirmed ? 'true' : undefined}
              aria-describedby="resident-end-error"
              onChange={(event) => {
                setConfirmed(event.target.checked)
                if (event.target.checked) setError('')
              }}
            />
            <span>I understand this resident session cannot be resumed.</span>
          </label>
          <p id="resident-end-error" className="form-error" role="alert">{error}</p>
          <p
            ref={resultRef}
            className="form-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            tabIndex={settled ? -1 : undefined}
          >
            {message}
          </p>
        </div>

        <footer className="sheet__footer">
          <button
            className="button button--secondary"
            type="button"
            data-dialog-autofocus
            onClick={onClose}
            disabled={submitting || checking}
          >
            {settled ? 'Close' : 'Cancel'}
          </button>
          {settled && canCheckStatus && (
            <button className="button button--secondary" type="button" onClick={() => void checkStatus()} disabled={checking}>
              <Icon icon={checking ? Loader2 : RefreshCw} size={14} />
              {checking ? 'Checking…' : 'Check status'}
            </button>
          )}
          {!settled && (
            <button className="button button--stop" type="submit" disabled={submitting}>
              <Icon icon={submitting ? Loader2 : Square} size={14} />
              {submitting ? 'Ending resident session…' : 'End resident session'}
            </button>
          )}
        </footer>
      </form>
    </NativeDialog>
  )
}

function isResidentEndSourceCursorChangedError(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'code' in reason &&
    (reason as { code?: unknown }).code === 'host.resident_end_source_cursor_changed'
  )
}

interface ModelsDialogProps {
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

function ModelsDialog({
  api,
  open,
  host,
  threadId,
  executionGenerationId,
  currentModel,
  canSelectResidentModel,
  canConnectRuntimeOAuth,
  triggerRef,
  onClose,
}: ModelsDialogProps) {
  const [catalog, setCatalog] = useState<RuntimeModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<ModelsCatalogError | null>(null)
  const [selection, setSelection] = useState<ModelSelectionView | null>(null)
  const [oauth, setOAuth] = useState<RuntimeOAuthView | null>(null)
  const [query, setQuery] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState('all')
  const [showAllModels, setShowAllModels] = useState(false)
  const [visibleModelLimit, setVisibleModelLimit] = useState(MODEL_REVEAL_INCREMENT)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const providerNavRef = useRef<HTMLElement>(null)
  const selectionRequestRef = useRef(0)
  const oauthRequestRef = useRef(0)
  const activeOAuthRequestRef = useRef<RuntimeOAuthRequest | null>(null)
  const dialogOpenRef = useRef(open)
  const selectionAuthorityKey = JSON.stringify([host.id, threadId ?? '', executionGenerationId ?? ''])
  const oauthAuthorityKey = JSON.stringify([host.id])
  const selectionAuthorityRef = useRef(selectionAuthorityKey)
  const oauthAuthorityRef = useRef(oauthAuthorityKey)
  const providerRailHorizontal = useMediaQueryMatch('(max-width: 75rem)')
  dialogOpenRef.current = open
  selectionAuthorityRef.current = selectionAuthorityKey
  oauthAuthorityRef.current = oauthAuthorityKey

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
    setShowAllModels(false)
    setVisibleModelLimit(MODEL_REVEAL_INCREMENT)
    void api.loadRuntimeModelCatalog(host.id)
      .then((nextCatalog) => {
        if (!cancelled) setCatalog(nextCatalog)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
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

  const selectedProvider = catalog?.providers.find((provider) => provider.providerId === selectedProviderId)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredModels = useMemo(() => {
    if (!catalog) return []
    return catalog.models.filter((model) => {
      if (selectedProviderId !== 'all' && model.providerId !== selectedProviderId) return false
      if (!showAllModels && !model.available) return false
      if (!normalizedQuery) return true
      const provider = catalog.providers.find((candidate) => candidate.providerId === model.providerId)
      return `${model.name} ${model.modelId} ${model.providerId} ${provider?.displayName ?? ''}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    })
  }, [catalog, normalizedQuery, selectedProviderId, showAllModels])
  const visibleModels = filteredModels.slice(0, visibleModelLimit)
  const remainingModelCount = Math.max(0, filteredModels.length - visibleModels.length)
  const availableCount = catalog?.models.filter((model) => model.available).length ?? 0
  const scopedModelCount = selectedProvider?.modelCount ?? catalog?.models.length ?? 0
  const scopedAvailableCount = selectedProvider?.availableModelCount ?? availableCount
  const oauthProviders = catalog?.providers.filter((provider) => provider.oauthSupported) ?? []
  const configuredProviders = catalog?.providers.filter((provider) => provider.configured) ?? []
  const providerIds = catalog ? ['all', ...catalog.providers.map((provider) => provider.providerId)] : []
  const selectionMatchesCurrentModel = Boolean(
    selection && modelMatchesCurrent(selection.providerId, selection.modelId, selection.modelName, currentModel),
  )
  const selectionLocksActions = Boolean(
    selection?.state === 'selecting'
      || selection?.state === 'uncertain'
      || (selection?.state === 'completed' && !selectionMatchesCurrentModel),
  )
  const selectionStatusMessage = !selection
    ? ''
    : selection.state === 'selecting'
      ? `Selecting ${selection.modelName} for this thread's next prompt…`
      : selection.state === 'completed'
        ? selectionMatchesCurrentModel
          ? `${selection.message} ${selection.modelName} is now shown as current for this thread.`
          : selection.projected
            ? `${selection.message} Refreshing this dialog's current-model label. Continuim will not resend the selection.`
            : `${selection.message} Selected on host · refreshing current model. Continuim will not resend the selection.`
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
    setVisibleModelLimit(MODEL_REVEAL_INCREMENT)
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
    <NativeDialog
      open={open}
      labelledBy="models-title"
      describedBy="models-description"
      triggerRef={triggerRef}
      className="models-sheet"
      onClose={closeDialog}
    >
      <div className="sheet__surface models-sheet__surface">
        <header className="sheet__header models-sheet__header">
          <div className="sheet__title-group">
            <span className="sheet__title-icon"><Icon icon={Bot} size={18} /></span>
            <div>
              <h2 id="models-title">Models &amp; accounts</h2>
              <p id="models-description">
                Provider and model metadata reported by Prime Agent on <bdi>{host.name}</bdi>.
              </p>
            </div>
          </div>
          <button className="icon-button" type="button" aria-label="Close models and accounts" onClick={closeDialog}>
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
            <aside className="provider-rail" aria-label={`Accounts on ${host.name}`}>
              <div className="provider-rail__summary">
                <span className="eyebrow">Accounts on <bdi>{host.name}</bdi></span>
                <strong>{configuredProviders.length} configured</strong>
                <small>{oauthProviders.length} OAuth-capable providers · Prime Agent {catalog.releaseVersion}</small>
              </div>
              <p className="sr-only" id="provider-filter-instructions">
                {providerRailHorizontal
                  ? 'Use Left and Right Arrow keys to select a provider. Use Home and End to jump to the first or last provider.'
                  : 'Use Up and Down Arrow keys to select a provider. Use Home and End to jump to the first or last provider.'}
              </p>
              <nav
                ref={providerNavRef}
                aria-describedby="provider-filter-instructions"
                aria-label="Filter models by provider"
                aria-orientation={providerRailHorizontal ? 'horizontal' : 'vertical'}
                role="toolbar"
                onKeyDown={handleProviderKeyDown}
              >
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
                {catalog.providers.map((provider) => (
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
              </nav>
            </aside>

            <section className="model-catalog" aria-label="Prime Agent models">
              <div className="model-catalog__topline">
                <div>
                  <span className="eyebrow">Runtime catalog</span>
                  <h3>{selectedProvider?.displayName ?? 'Models reported by this host'}</h3>
                  <p>{scopedAvailableCount} available with current setup · {scopedModelCount} listed by the runtime</p>
                </div>
                <span className="catalog-freshness"><span aria-hidden="true" /> Read {formatCatalogTime(catalog.observedAt)}</span>
              </div>

              {selectedProvider && !selectedProvider.configured && (
                <div
                  className="provider-setup-note"
                  aria-busy={oauthInProgress && oauth?.providerId === selectedProvider.providerId ? 'true' : undefined}
                >
                  <span><Icon icon={LockKeyhole} size={16} /></span>
                  <div className="provider-setup-note__body">
                    <strong>{selectedProvider.oauthSupported ? 'OAuth is supported by Prime Agent' : 'Provider setup is required'}</strong>
                    {selectedProvider.providerId === PRIME_AGENT_CHATGPT_OAUTH_PROVIDER_ID && selectedProvider.oauthSupported ? (
                      <>
                        <p>
                          {selectedProviderCanConnect
                            ? <>Connect ChatGPT to this Prime Agent runtime on <bdi>{host.name}</bdi>. The verified sign-in page opens in your system browser; no authorization URL or credential is exposed to this view.</>
                            : <>Open Prime Agent on <bdi>{host.name}</bdi> and run <code>/login</code>. This desktop can connect ChatGPT only when the trusted local host advertises OAuth support.</>}
                        </p>
                        <p className="provider-setup-note__storage">
                          Prime Agent {catalog.releaseVersion} stores OAuth credentials in its host-only <code>auth.json</code>, protected by this operating-system account’s file permissions. Availability checks reload the account state before model selection.
                        </p>
                        <p className="provider-setup-note__storage">
                          auth.json is plaintext at rest; it is not a keychain or keyring.
                        </p>
                        {selectedProviderCanConnect && (
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
                        )}
                      </>
                    ) : (
                      <p>
                        Open Prime Agent on <bdi>{host.name}</bdi> and run <code>/login</code>. Credential material stays on this host; only secret-free status reaches Continuim’s host protocol and renderer.
                      </p>
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

              <div className="model-catalog__controls">
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

              <div className="model-list">
                {visibleModels.length > 0 ? visibleModels.map((model) => {
                  const provider = catalog.providers.find((candidate) => candidate.providerId === model.providerId)
                  const current = modelMatchesCurrent(model.providerId, model.modelId, model.name, currentModel)
                  const selectionTargeted = selection?.providerId === model.providerId && selection.modelId === model.modelId
                  const selectingTarget = selectionTargeted && selection?.state === 'selecting'
                  const refreshingTarget = selectionTargeted && selection?.state === 'completed' && !selectionMatchesCurrentModel
                  const rejectedWithoutRetry = selectionTargeted && selection?.state === 'rejected' && !selection.retryable
                  const selectionButtonLabel = selectingTarget ? 'Selecting…' : refreshingTarget ? 'Refreshing…' : 'Use model'
                  return (
                    <article className={cx('model-row', current && 'model-row--current')} key={`${model.providerId}:${model.modelId}`}>
                      <span className="model-row__icon"><Icon icon={Bot} size={16} /></span>
                      <div className="model-row__body">
                        <div className="model-row__title">
                          <strong>{model.name}</strong>
                          {current && <span className="model-badge model-badge--current">Current</span>}
                          {model.usingOAuth && <span className="model-badge">OAuth</span>}
                        </div>
                        <span><bdi>{provider?.displayName ?? model.providerId}</bdi> · <bdi>{model.modelId}</bdi></span>
                        <small>{formatTokenCapacity(model.contextWindow)} context · {formatTokenCapacity(model.maxOutputTokens)} max output{model.reasoning ? ' · Reasoning' : ''}{model.input.includes('image') ? ' · Images' : ''}</small>
                      </div>
                      <div className="model-row__actions">
                        <span className={cx('model-row__status', model.available && 'model-row__status--ready')}>
                          <Icon icon={model.available ? CheckCircle2 : LockKeyhole} size={14} />
                          {model.available ? 'Available' : 'Setup required'}
                        </span>
                        {model.available && !current && canSelectResidentModel && (
                          <button
                            className="button button--secondary model-row__select"
                            type="button"
                            aria-label={`${selectionButtonLabel.replace('…', '')} ${model.name}`}
                            disabled={selectionLocksActions || rejectedWithoutRetry}
                            onClick={() => void selectModel(model)}
                          >
                            {(selectingTarget || refreshingTarget) && <Icon icon={Loader2} size={14} />}
                            {selectionButtonLabel}
                          </button>
                        )}
                      </div>
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
              <div className="model-selection-feedback">
                <p
                  className={cx('model-selection-feedback__message', !selectionStatusMessage && 'sr-only')}
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {selectionStatusMessage && <Icon icon={selectionMatchesCurrentModel ? CheckCircle2 : Loader2} size={14} />}
                  {selectionStatusMessage}
                </p>
                <p
                  className={cx('model-selection-feedback__message', 'model-selection-feedback__message--error', !selectionErrorMessage && 'sr-only')}
                  role="alert"
                >
                  {selectionErrorMessage && <Icon icon={AlertCircle} size={14} />}
                  {selectionErrorMessage}
                </p>
              </div>
              <footer className="model-catalog__footer">
                <Icon icon={Info} size={14} />
                <span>
                  {canSelectResidentModel
                    ? 'Choose a model for this thread’s next prompt. This changes the resident session only; it does not send a prompt. “Available” means Prime Agent reports provider access, not that an inference smoke test passed.'
                    : 'Model selection is available only while this exact resident session is idle and ready for its next prompt. “Available” means Prime Agent reports provider access; no inference smoke test was run.'}
                </span>
              </footer>
            </section>
          </div>
        ) : null}
      </div>
    </NativeDialog>
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
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(parsed))
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
  const [selectedComputer, setSelectedComputer] = useState<DiscoveredComputer | null>(null)
  const [loading, setLoading] = useState(false)
  const [probing, setProbing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [installConsent, setInstallConsent] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [copyFeedback, setCopyFeedback] = useState<{
    id: number
    target: 'prime-agent' | 'host-service'
    message: string
    failed: boolean
  } | null>(null)
  const [invalidField, setInvalidField] = useState<'install-consent' | null>(null)
  const installConsentRef = useRef<HTMLInputElement>(null)
  const copyFeedbackSequenceRef = useRef(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    setInvalidField(null)
    setCopyFeedback(null)
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
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to read SSH aliases. Check your OpenSSH configuration and try again.')
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
    setInstallConsent(selected?.probeComplete ? !selected.requiresInstall : false)
    setError('')
    setInvalidField(null)
  }

  const copyCommand = async (
    command: string,
    label: string,
    target: 'prime-agent' | 'host-service',
  ) => {
    const id = ++copyFeedbackSequenceRef.current
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable')
      await navigator.clipboard.writeText(command)
      if (id !== copyFeedbackSequenceRef.current) return
      setCopyFeedback({ id, target, message: `${label} copied to the clipboard.`, failed: false })
    } catch {
      if (id !== copyFeedbackSequenceRef.current) return
      setCopyFeedback({
        id,
        target,
        message: `Couldn’t copy ${label.toLocaleLowerCase()}. Select the command and copy it manually.`,
        failed: true,
      })
    }
  }

  const probe = async () => {
    setError('')
    setInvalidField(null)
    if (!selectedAlias) {
      setError('Choose a discovered SSH alias before checking the connection.')
      return
    }
    setProbing(true)
    setStatus(`Checking ${selectedAlias}…`)
    try {
      const result = await api.probeComputer({ alias: selectedAlias })
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
      setError('Choose a discovered SSH alias and check its connection first.')
      return
    }
    if (selectedComputer.requiresInstall && !installConsent) {
      setError(`Allow installation of the Continuim host service on ${selectedComputer.alias} to continue.`)
      setInvalidField('install-consent')
      window.requestAnimationFrame(() => installConsentRef.current?.focus())
      return
    }
    setSubmitting(true)
    setError('')
    setInvalidField(null)
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
                {' '}This build cannot show interactive password, passphrase, or new host-key prompts; complete those in your terminal, then check again.
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
                  <label key={computer.alias} className={cx('alias-row', selectedAlias === computer.alias && 'alias-row--selected')}>
                    <input
                      type="radio"
                      name="ssh-alias"
                      value={computer.alias}
                      checked={selectedAlias === computer.alias}
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

            <details className="disclosure">
              <summary><span>Alias not listed?</span><span>SSH configuration</span></summary>
              <div className="manual-guidance">
                <p>Add a concrete <code>Host</code> alias to your SSH configuration, then close and reopen this sheet. Wildcard-only entries are not shown.</p>
                <code>Host buildbox{`\n`}  HostName build.example.com{`\n`}  User developer</code>
              </div>
            </details>
          </section>

          {resolved && (
            <section className="sheet-section" aria-labelledby="resolved-heading">
              <div className="section-heading-row">
                <div>
                  <h3 id="resolved-heading">Resolved connection</h3>
                  <p>Confirm the effective target and host identity before continuing.</p>
                </div>
                <span className="verification-mark">
                  <Icon icon={ShieldCheck} size={15} /> Verified by OpenSSH
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
              <details className="command-disclosure upstream-install">
                <summary>Install Prime Agent on macOS or Linux</summary>
                <p>
                  This is the official upstream installer. Review it, then run it in a terminal on the computer you
                  want to use. Prime Continuim never runs this command automatically.
                </p>
                <div className="command-block">
                  <code>{PRIME_AGENT_INSTALL_COMMAND}</code>
                  <button
                    className="small-icon-button"
                    type="button"
                    aria-label="Copy official Prime Agent install command"
                    onClick={() => void copyCommand(PRIME_AGENT_INSTALL_COMMAND, 'Prime Agent install command', 'prime-agent')}
                  >
                    <Icon icon={Code2} size={14} />
                  </button>
                </div>
                {copyFeedback?.target === 'prime-agent' && (
                  <p
                    key={copyFeedback.id}
                    className={cx('command-copy-feedback', copyFeedback.failed && 'command-copy-feedback--error')}
                    role="status"
                  >
                    <Icon icon={copyFeedback.failed ? AlertCircle : Check} size={13} />
                    {copyFeedback.message}
                  </p>
                )}
                <small>Prime Agent runs model-generated code with your user permissions; use an external sandbox for untrusted work.</small>
              </details>
            </section>
          )}

          {resolved?.requiresInstall && (
            <section className="sheet-section install-consent" aria-labelledby="install-heading">
              <div className="install-consent__copy">
                <span className="install-consent__icon"><Icon icon={HardDrive} size={17} /></span>
                <div>
                  <h3 id="install-heading">Install the Continuim host service</h3>
                  <p>A compatible host service is required for durable thread state on <bdi>{resolved.alias}</bdi>. Root access is not required.</p>
                </div>
              </div>
              <label className="consent-row">
                <input
                  ref={installConsentRef}
                  id="install-consent"
                  type="checkbox"
                  checked={installConsent}
                  disabled={!resolved.installAvailable}
                  aria-invalid={invalidField === 'install-consent'}
                  aria-describedby={invalidField === 'install-consent' ? 'add-computer-error' : undefined}
                  onChange={(event) => {
                    setInstallConsent(event.target.checked)
                    if (invalidField === 'install-consent') {
                      setInvalidField(null)
                      setError('')
                    }
                  }}
                />
                <span>Install the signed Continuim host service on <bdi>{resolved.alias}</bdi></span>
              </label>
              {!resolved.installAvailable && (
                <p className="install-unavailable" id="add-computer-install-unavailable"><Icon icon={AlertCircle} size={14} /> {resolved.installDeferredReason ?? 'The signed installer is unavailable in this build.'}</p>
              )}
              <details className="command-disclosure">
                <summary>Show exact install command</summary>
                <div className="command-block">
                  <code>{resolved.installCommand}</code>
                  <button
                    className="small-icon-button"
                    type="button"
                    aria-label="Copy exact install command"
                    onClick={() => void copyCommand(resolved.installCommand, 'Continuim host-service install command', 'host-service')}
                  >
                    <Icon icon={Code2} size={14} />
                  </button>
                </div>
                {copyFeedback?.target === 'host-service' && (
                  <p
                    key={copyFeedback.id}
                    className={cx('command-copy-feedback', copyFeedback.failed && 'command-copy-feedback--error')}
                    role="status"
                  >
                    <Icon icon={copyFeedback.failed ? AlertCircle : Check} size={13} />
                    {copyFeedback.message}
                  </p>
                )}
              </details>
            </section>
          )}

          {error && <p className="inline-error" id="add-computer-error" role="alert"><Icon icon={AlertCircle} size={15} /> {error}</p>}
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</div>
        </div>

        <footer className="sheet__footer">
          <p>
            {resolved
              ? hasReportedFingerprint
                ? `Review the reported host-key fingerprint for ${resolved.effectiveTarget}.`
                : `OpenSSH verified ${resolved.effectiveTarget}; this probe did not return a literal fingerprint.`
              : 'Choose a computer to continue.'}
          </p>
          <div className="sheet__footer-actions">
            <button className="button button--quiet" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
            <button
              className="button button--primary"
              type="submit"
              aria-describedby={resolved?.requiresInstall && !resolved.installAvailable ? 'add-computer-install-unavailable' : undefined}
              disabled={loading || probing || submitting || Boolean(resolved?.requiresInstall && !resolved.installAvailable)}
            >
              {loading || submitting
                ? <Icon icon={Loader2} size={15} />
                : resolved?.requiresInstall && !resolved.installAvailable
                  ? <Icon icon={AlertCircle} size={15} />
                  : <Icon icon={ArrowRight} size={15} strokeWidth={2} />}
              {submitting
                ? resolved?.requiresInstall
                  ? `Installing on ${resolved.alias}…`
                  : `Adding ${resolved?.alias ?? 'computer'}…`
                : resolved?.requiresInstall && !resolved.installAvailable
                  ? 'Host-service installer unavailable'
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
  const progressHeadingRef = useRef<HTMLHeadingElement>(null)
  const continueButtonRef = useRef<HTMLButtonElement>(null)
  const focusedProgressRef = useRef(false)

  useEffect(() => {
    if (open) return
    focusedProgressRef.current = false
  }, [open])

  useEffect(() => {
    if (!phase || phase === 'complete' || focusedProgressRef.current) return
    focusedProgressRef.current = true
    window.requestAnimationFrame(() => progressHeadingRef.current?.focus())
  }, [phase])

  useEffect(() => {
    if (phase !== 'complete') return
    window.requestAnimationFrame(() => continueButtonRef.current?.focus())
  }, [phase])

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
                      <h3 ref={progressHeadingRef} id="handoff-progress-heading" tabIndex={-1}>Move progress</h3>
                      <p>{progressMessage}</p>
                    </div>
                    <span className="tabular">{Math.max(0, currentPhaseIndex + 1)} / {HANDOFF_PHASES.length}</span>
                  </div>
                  <ol>
                    {HANDOFF_PHASES.map((item, index) => {
                      const state = index < currentPhaseIndex || isComplete ? 'complete' : index === currentPhaseIndex ? 'current' : 'pending'
                      return (
                        <li key={item.phase} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
                          <span className="handoff-progress__marker">
                            {state === 'complete' ? <Icon icon={Check} size={13} /> : state === 'current' ? <Icon icon={Loader2} size={13} /> : <span aria-hidden="true" />}
                          </span>
                          <span className="handoff-progress__label">
                            <span className="sr-only">{runtimeStateLabel(state)}: </span>
                            {item.label}
                          </span>
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
              <button ref={continueButtonRef} className="button button--primary" type="button" onClick={onClose}><Icon icon={ArrowRight} size={15} /> Continue thread</button>
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
