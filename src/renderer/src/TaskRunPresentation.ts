type TaskRunConnectionState = 'online' | 'reconnecting' | 'offline'
type TaskRunTaskState = 'idle' | 'running' | 'waiting' | 'needs_approval' | 'complete' | 'failed'
type TaskRunReceiptState =
  | 'idle'
  | 'sending'
  | 'sent'
  | 'queued'
  | 'waiting_for_connection'
  | 'uncertain'
  | 'rejected'

export type TaskRunPresentationKind =
  | 'ended'
  | 'disconnected'
  | 'ending'
  | 'needs_attention'
  | 'waiting_for_response'
  | 'stopping'
  | 'starting'
  | 'working'
  | 'complete'
  | 'ready'
  | 'model_setup'
  | 'stale'
  | 'preparing'

export type TaskRunPresentationTone =
  | 'muted'
  | 'neutral'
  | 'active'
  | 'warning'
  | 'danger'
  | 'success'

export type TaskRunIconKey =
  | 'activity'
  | 'alert-circle'
  | 'check-circle'
  | 'clock'
  | 'model'
  | 'refresh'
  | 'send'
  | 'square'
  | 'wifi-off'

export type TaskRunPrimaryAction =
  | { kind: 'finish_end'; label: 'Finish ending' }
  | { kind: 'end_session'; label: 'End session' }
  | { kind: 'review_status'; label: 'Review status' }
  | { kind: 'stop'; label: 'Stop' }
  | { kind: 'submit'; label: 'Delegate task' | 'Reply' }
  | { kind: 'setup_model'; label: 'Set up model' }

export interface TaskRunPresentation {
  kind: TaskRunPresentationKind
  headline: string
  detail: string
  tone: TaskRunPresentationTone
  iconKey: TaskRunIconKey
  primaryAction?: TaskRunPrimaryAction
}

export interface TaskRunPresentationAuthority {
  /** The connected host and selected execution generation are an exact match. */
  verified: boolean
  /** The renderer holds a fresh mutation fence for this exact authority. */
  mutation: boolean
  /** More than one source currently claims mutation authority. */
  conflictingMutation: boolean
  /** Action-specific grants. These never imply general mutation authority. */
  canStart: boolean
  canStop: boolean
  canEnd: boolean
  canFinishEnd: boolean
  canReview: boolean
  canSetUpModel: boolean
}

export interface TaskRunPresentationInput {
  hostName: string
  connection: TaskRunConnectionState
  taskState: TaskRunTaskState
  sessionEnded: boolean
  sessionNeedsRecovery: boolean
  /** Prime Agent has a live, exact extension dialog awaiting this user. */
  extensionResponsePending: boolean
  /** A retained lifecycle operation can outlive its composer receipt. */
  endOperationPresent: boolean
  /** The retained End operation is at its one safe, resumable boundary. */
  endReadyToFinish: boolean
  endPhase?: 'ending' | 'kill_dispatching' | 'kill_acknowledged' | 'quarantined' | 'completed'
  modelReady: boolean
  /** False when the selected workbench snapshot is explicitly cached. */
  snapshotFresh: boolean
  activity: {
    live: boolean
    fresh: boolean
    detail?: string
  }
  receipt: {
    state: TaskRunReceiptState
    operation?: 'prompt' | 'abort' | 'end'
    message?: string
    retryable?: boolean
  }
  authority: TaskRunPresentationAuthority
}

const FINISH_END_ACTION: TaskRunPrimaryAction = { kind: 'finish_end', label: 'Finish ending' }
const END_SESSION_ACTION: TaskRunPrimaryAction = { kind: 'end_session', label: 'End session' }
const REVIEW_STATUS_ACTION: TaskRunPrimaryAction = { kind: 'review_status', label: 'Review status' }
const STOP_ACTION: TaskRunPrimaryAction = { kind: 'stop', label: 'Stop' }
const SUBMIT_ACTION: TaskRunPrimaryAction = { kind: 'submit', label: 'Delegate task' }
const REPLY_ACTION: TaskRunPrimaryAction = { kind: 'submit', label: 'Reply' }
const SETUP_MODEL_ACTION: TaskRunPrimaryAction = { kind: 'setup_model', label: 'Set up model' }

function hostLabel(hostName: string): string {
  return hostName.trim() || 'this computer'
}

/**
 * Derives the one task-run story the renderer is allowed to show.
 *
 * The selector is intentionally fail-closed: historical activity is never
 * promoted to live work, and an action is returned only when both the general
 * authority fence and its action-specific grant are explicit in the input.
 */
export function taskRunPresentation(input: Readonly<TaskRunPresentationInput>): TaskRunPresentation {
  const host = hostLabel(input.hostName)
  const connected = input.connection === 'online'
  const authorityVerified = input.authority.verified
  const mutationReady = Boolean(
    connected &&
    authorityVerified &&
    input.snapshotFresh &&
    input.authority.mutation &&
    !input.authority.conflictingMutation,
  )
  const canReview = Boolean(connected && authorityVerified && input.authority.canReview)
  const endPresent = input.endOperationPresent || input.receipt.operation === 'end'

  if (input.sessionEnded) {
    return {
      kind: 'ended',
      headline: 'Session ended',
      detail: 'The task, transcript, and workspace files remain available.',
      tone: 'success',
      iconKey: 'check-circle',
    }
  }

  if (!connected || !authorityVerified) {
    const offline = input.connection === 'offline'
    return {
      kind: 'disconnected',
      headline: offline ? 'Offline' : 'Reconnecting',
      detail: authorityVerified
        ? `Saved activity is available while ${host} reconnects.`
        : `Saved activity is available while control of ${host} is verified.`,
      tone: 'muted',
      iconKey: offline ? 'wifi-off' : 'refresh',
    }
  }

  if (endPresent) {
    const endOutcomeNeedsReview =
      input.endPhase === 'quarantined' ||
      input.receipt.state === 'uncertain' ||
      input.receipt.state === 'rejected'

    if (input.endPhase === 'completed') {
      return {
        kind: 'ended',
        headline: 'Session ended',
        detail: 'The task, transcript, and workspace files remain available.',
        tone: 'success',
        iconKey: 'check-circle',
      }
    }

    if (input.endReadyToFinish) {
      if (mutationReady && input.authority.canFinishEnd) {
        return {
          kind: 'ending',
          headline: 'End saved',
          detail: 'Prime Agent has not received the saved End request.',
          tone: 'warning',
          iconKey: 'clock',
          primaryAction: FINISH_END_ACTION,
        }
      }
      return {
        kind: 'needs_attention',
        headline: 'End needs review',
        detail: 'This window cannot safely resume the saved End request.',
        tone: 'warning',
        iconKey: 'alert-circle',
        ...(canReview ? { primaryAction: REVIEW_STATUS_ACTION } : {}),
      }
    }

    if (endOutcomeNeedsReview) {
      return {
        kind: 'needs_attention',
        headline: 'End needs review',
        detail: input.receipt.message || 'The End outcome is unknown. Check the exact session before another action.',
        tone: input.receipt.state === 'rejected' ? 'danger' : 'warning',
        iconKey: 'alert-circle',
        ...(canReview ? { primaryAction: REVIEW_STATUS_ACTION } : {}),
      }
    }

    if (input.endPhase === 'kill_dispatching' || input.endPhase === 'kill_acknowledged') return {
      kind: 'ending',
      headline: 'Ending session',
      detail: input.receipt.message || 'Prime Agent is finishing the resident session.',
      tone: 'active',
      iconKey: 'clock',
    }

    return {
      kind: 'ending',
      headline: 'End saved',
      detail: 'Waiting for resident controls',
      tone: 'warning',
      iconKey: 'clock',
      ...(canReview ? { primaryAction: REVIEW_STATUS_ACTION } : {}),
    }
  }

  if (input.authority.conflictingMutation) {
    return {
      kind: 'needs_attention',
      headline: 'Control needs review',
      detail: 'The selected task and active control authority do not match.',
      tone: 'warning',
      iconKey: 'alert-circle',
      ...(canReview ? { primaryAction: REVIEW_STATUS_ACTION } : {}),
    }
  }

  if (input.extensionResponsePending) {
    return {
      kind: 'waiting_for_response',
      headline: 'Response needed',
      detail: 'Prime Agent is waiting for your answer.',
      tone: 'warning',
      iconKey: 'alert-circle',
    }
  }

  const controlOperation = input.receipt.operation === 'prompt' || input.receipt.operation === 'abort'
  const controlOutcomeNeedsReview = controlOperation && (
    input.receipt.state === 'uncertain' ||
    input.receipt.state === 'rejected' ||
    input.receipt.state === 'waiting_for_connection'
  )
  const taskNeedsInput =
    input.taskState === 'waiting' ||
    input.taskState === 'needs_approval'

  if (controlOutcomeNeedsReview || input.taskState === 'failed') {
    const isStop = input.receipt.operation === 'abort'
    const failed = input.receipt.state === 'rejected' || input.taskState === 'failed'
    const headline = failed
      ? 'Task needs review'
      : isStop
        ? 'Stop needs review'
        : 'Input needed'
    const fallbackDetail = failed
      ? 'Prime Agent could not continue. Review the task before another action.'
      : input.receipt.state === 'uncertain'
        ? `The ${isStop ? 'Stop' : 'prompt'} outcome is unknown. Check the exact task state before another action.`
        : 'Prime Agent is waiting for your input.'
    return {
      kind: 'needs_attention',
      headline,
      detail: input.receipt.message || fallbackDetail,
      tone: failed ? 'danger' : 'warning',
      iconKey: 'alert-circle',
      ...(canReview ? { primaryAction: REVIEW_STATUS_ACTION } : {}),
    }
  }

  const receiptPending =
    input.receipt.state === 'sending' ||
    input.receipt.state === 'sent' ||
    input.receipt.state === 'queued'
  const canStop = mutationReady && input.authority.canStop
  const freshLiveActivity = input.activity.live && input.activity.fresh

  if (input.receipt.operation === 'abort' && receiptPending) {
    return {
      kind: 'stopping',
      headline: 'Stopping',
      detail: input.receipt.state === 'sending'
        ? 'Requesting a safe boundary from Prime Agent.'
        : 'Waiting for authoritative idle proof',
      tone: 'active',
      iconKey: 'square',
    }
  }

  if (input.receipt.operation === 'prompt' && receiptPending) {
    return {
      kind: 'starting',
      headline: 'Starting',
      detail: input.receipt.state === 'sending'
        ? 'Delegating the task to Prime Agent.'
        : 'Prime Agent owns the task. Waiting for fresh activity.',
      tone: 'active',
      iconKey: 'send',
      ...(canStop ? { primaryAction: STOP_ACTION } : {}),
    }
  }

  if (!input.snapshotFresh) {
    return {
      kind: 'stale',
      headline: 'Cached status',
      detail: input.taskState === 'running'
        ? 'Last reported working. Waiting for a fresh session update.'
        : 'Waiting for a fresh session update.',
      tone: 'muted',
      iconKey: 'refresh',
    }
  }

  if (taskNeedsInput) {
    const canReply = mutationReady && input.authority.canStart
    return {
      kind: 'needs_attention',
      headline: 'Reply needed',
      detail: 'Prime Agent is waiting for more context.',
      tone: 'warning',
      iconKey: 'alert-circle',
      ...(canReply
        ? { primaryAction: REPLY_ACTION }
        : canReview
          ? { primaryAction: REVIEW_STATUS_ACTION }
          : {}),
    }
  }

  if (input.sessionNeedsRecovery) {
    const canEnd = mutationReady && input.authority.canEnd
    return {
      kind: 'needs_attention',
      headline: 'Session unavailable',
      detail: 'End this inactive session to start a new agent. Your task and files stay.',
      tone: 'warning',
      iconKey: 'alert-circle',
      ...(canEnd
        ? { primaryAction: END_SESSION_ACTION }
        : canReview
          ? { primaryAction: REVIEW_STATUS_ACTION }
          : {}),
    }
  }

  if (freshLiveActivity || canStop) {
    const canDelegate = mutationReady && input.authority.canStart
    return {
      kind: 'working',
      headline: 'Working',
      detail: input.activity.detail || 'Prime Agent is working on this task.',
      tone: 'active',
      iconKey: 'activity',
      ...(canStop
        ? { primaryAction: STOP_ACTION }
        : canDelegate
          ? { primaryAction: SUBMIT_ACTION }
          : {}),
    }
  }

  if (input.taskState === 'complete') {
    return {
      kind: 'complete',
      headline: 'Task complete',
      detail: 'The latest task is ready to review.',
      tone: 'success',
      iconKey: 'check-circle',
    }
  }

  if (!input.modelReady) {
    const canSetUpModel = mutationReady && input.authority.canSetUpModel
    return {
      kind: 'model_setup',
      headline: 'Choose a model',
      detail: 'Connect a provider and choose the model for this task.',
      tone: 'neutral',
      iconKey: 'model',
      ...(canSetUpModel ? { primaryAction: SETUP_MODEL_ACTION } : {}),
    }
  }

  const canStart = mutationReady && input.authority.canStart
  if (canStart) {
    return {
      kind: 'ready',
      headline: 'Ready',
      detail: 'Prime Agent is ready for another task.',
      tone: 'neutral',
      iconKey: 'send',
      primaryAction: SUBMIT_ACTION,
    }
  }

  return {
    kind: 'preparing',
    headline: input.taskState === 'running' ? 'Verifying activity' : 'Preparing agent',
    detail: input.taskState === 'running'
      ? 'Waiting for fresh activity from Prime Agent.'
      : 'Waiting for the resident session to become ready.',
    tone: 'muted',
    iconKey: 'clock',
  }
}
