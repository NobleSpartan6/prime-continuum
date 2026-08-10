import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  CandidateEvaluationPreflightRequestSchema,
  CandidateEvaluationStartRequestSchema,
  RuntimeIntegrityTargetSchema,
} from '../../shared/protocol'
import { IPC, type Result, type RuntimeIntegrityRepairInput } from './contracts'
import { ControlError, toStructuredError } from './errors'
import type { DesktopControlService } from './service'

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const alias = z.string().min(1).max(255)
const jsonRecord = z.record(z.string(), z.unknown())
const cursor = z
  .object({
    threadId: id,
    executionGenerationId: id,
    generation: id,
    sequence: z.number().int().nonnegative()
  })
  .strict()
const connectionTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('ssh'), alias }).strict()
])
const clientCommand = z
  .object({
    deviceId: id,
    commandId: id,
    expectedHostId: id,
    kind: z.string().min(1).max(128),
    threadId: id,
    payload: jsonRecord.optional(),
    delivery: z.enum(['live_only', 'send_when_reconnected']).optional(),
    expectedExecutionGenerationId: id,
    issuedAt: z.string().datetime({ offset: true })
  })
  .strict()
const handoffPlan = z
  .object({
    threadId: id,
    expectedHostId: id,
    sourceGenerationId: id,
    destinationHostId: id,
    destinationProjectId: id,
    behaviorIfRunning: z.enum(['interrupt', 'wait_for_idle'])
  })
  .strict()
const residentProvision = z
  .object({
    selectionToken: id,
    projectDisplayName: z.string().trim().min(1).max(255).regex(/^[^\0\r\n]+$/),
    threadTitle: z.string().trim().min(1).max(255).regex(/^[^\0\r\n]+$/),
    sessionName: z.string().trim().min(1).max(255).regex(/^[^\0\r\n]+$/).optional()
  })
  .strict()
const residentWorkspaceSelection = z
  .union([
    z
      .object({
        kind: z.literal('registered_workspace'),
        projectId: id,
        workspaceId: id,
        referenceThreadId: id,
        referenceExecutionGenerationId: id,
        resumeOperationId: id.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('local_path').optional(),
        resumeOperationId: id.optional(),
      })
      .strict(),
  ])
  .optional()
const residentEndPreparation = z
  .object({
    expectedHostId: id,
    projectId: id,
    workspaceId: id,
    threadId: id,
    executionGenerationId: id,
    resumeOperationId: id.optional(),
  })
  .strict()
const residentEnd = z
  .object({
    confirmationToken: id,
    consent: z.literal(true),
  })
  .strict()
export interface ControlIpcOptions {
  ipcMain: IpcMain
  service: DesktopControlService
  getWindows: () => readonly BrowserWindow[]
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  isTrustedWorkbenchSender: (event: IpcMainInvokeEvent) => boolean
}

export function isTrustedRendererSender(
  event: IpcMainInvokeEvent,
  windows: readonly BrowserWindow[],
  rendererUrlIsTrusted: (candidate: string) => boolean,
): boolean {
  return windows.some((window) =>
    !window.isDestroyed() &&
    !window.webContents.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    rendererUrlIsTrusted(event.senderFrame.url)
  )
}

export function registerControlIpc(options: ControlIpcOptions): () => void {
  const { ipcMain, service, getWindows, isTrustedSender, isTrustedWorkbenchSender } = options
  const channels: string[] = []

  const handle = <T>(
    channel: string,
    schema: z.ZodType,
    operation: (input: never) => Promise<T> | T,
    trustSender: (event: IpcMainInvokeEvent) => boolean = isTrustedSender,
  ): void => {
    channels.push(channel)
    ipcMain.handle(channel, async (event, rawInput): Promise<Result<T>> => {
      try {
        if (!trustSender(event)) {
          throw new ControlError('ipc.untrusted_sender', 'The native request did not come from the app UI.')
        }
        assertBoundedIpcInput(rawInput)
        const input = schema.parse(rawInput)
        return { ok: true, value: await operation(input as never) }
      } catch (error) {
        return { ok: false, error: toStructuredError(error) }
      }
    })
  }

  handle(IPC.bootstrap, z.undefined(), () => service.bootstrap())
  handle(IPC.discoverSshHosts, z.undefined(), () => service.discoverSshHosts())
  handle(IPC.probeSshHost, z.object({ alias }).strict(), (input: { alias: string }) =>
    service.probeSshHost(input.alias)
  )
  handle(IPC.planHostInstall, z.object({ alias }).strict(), (input: { alias: string }) =>
    service.planHostInstall(input.alias)
  )
  handle(
    IPC.installHost,
    z.object({ planId: id, consent: z.literal(true) }).strict(),
    (input: { planId: string; consent: true }) => service.installHost(input.planId, input.consent)
  )
  handle(IPC.connect, connectionTarget, (input: z.infer<typeof connectionTarget>) => service.connect(input))
  handle(
    IPC.activateVerifiedSshHost,
    z.object({ expectedHostId: id }).strict(),
    (input: { expectedHostId: string }) => service.activateVerifiedSshHost(input.expectedHostId)
  )
  handle(IPC.reconnect, z.undefined(), () => service.reconnect())
  handle(IPC.disconnect, z.undefined(), () => service.disconnect())
  handle(IPC.hostCatalog, z.undefined(), () => service.hostCatalog())
  handle(IPC.projectCatalog, z.object({ hostId: id }).strict(), (input: { hostId: string }) =>
    service.projectCatalog(input.hostId)
  )
  handle(
    IPC.threadProjection,
    z.object({ threadId: id, cursor: cursor.optional() }).strict(),
    (input: { threadId: string; cursor?: z.infer<typeof cursor> }) =>
      service.threadProjection(input.threadId, input.cursor)
  )
  handle(
    IPC.retryRuntimeIntegrity,
    z.object({ expectedHostId: id }).strict(),
    (input: { expectedHostId: string }) => service.retryRuntimeIntegrity(input.expectedHostId)
  )
  handle(
    IPC.repairRuntimeIntegrity,
    z.object({
      expectedHostId: id,
      expectedTrustAnchorId: z.string().length(64).regex(/^[a-f0-9]{64}$/),
      expectedTarget: RuntimeIntegrityTargetSchema,
      expectedChangedAt: z.string().datetime({ offset: true }),
    }).strict(),
    (input: RuntimeIntegrityRepairInput) => service.repairRuntimeIntegrity(input)
  )
  handle(
    IPC.runtimeModelCatalog,
    z.object({ expectedHostId: id }).strict(),
    (input: { expectedHostId: string }) => service.runtimeModelCatalog(input.expectedHostId)
  )
  handle(
    IPC.startRuntimeOAuth,
    z.object({ expectedHostId: id, providerId: id }).strict(),
    (input: { expectedHostId: string; providerId: string }) =>
      service.startRuntimeOAuth(input.expectedHostId, input.providerId),
    isTrustedWorkbenchSender,
  )
  handle(
    IPC.runtimeOAuthStatus,
    z.object({ expectedHostId: id, sessionId: id }).strict(),
    (input: { expectedHostId: string; sessionId: string }) =>
      service.runtimeOAuthStatus(input.expectedHostId, input.sessionId),
    isTrustedWorkbenchSender,
  )
  handle(
    IPC.cancelRuntimeOAuth,
    z.object({ expectedHostId: id, sessionId: id }).strict(),
    (input: { expectedHostId: string; sessionId: string }) =>
      service.cancelRuntimeOAuth(input.expectedHostId, input.sessionId),
    isTrustedWorkbenchSender,
  )
  handle(
    IPC.candidateEvaluationPreflight,
    CandidateEvaluationPreflightRequestSchema,
    (input: Parameters<DesktopControlService['candidateEvaluationPreflight']>[0]) =>
      service.candidateEvaluationPreflight(input)
  )
  handle(
    IPC.startCandidateEvaluation,
    CandidateEvaluationStartRequestSchema,
    (input: Parameters<DesktopControlService['startCandidateEvaluation']>[0]) =>
      service.startCandidateEvaluation(input)
  )
  handle(
    IPC.candidateEvaluationSnapshot,
    CandidateEvaluationPreflightRequestSchema,
    (input: Parameters<DesktopControlService['candidateEvaluationSnapshot']>[0]) =>
      service.candidateEvaluationSnapshot(input)
  )
  handle(
    IPC.selectResidentWorkspace,
    residentWorkspaceSelection,
    (input: z.infer<typeof residentWorkspaceSelection>) => service.selectResidentWorkspace(input)
  )
  channels.push(IPC.provisionResident)
  ipcMain.handle(IPC.provisionResident, async (event, rawInput): Promise<Result<Awaited<ReturnType<DesktopControlService['provisionResident']>>>> => {
    let serviceInvoked = false
    try {
      if (!isTrustedSender(event)) {
        throw new ControlError('ipc.untrusted_sender', 'The native request did not come from the app UI.')
      }
      assertBoundedIpcInput(rawInput)
      const input = residentProvision.parse(rawInput)
      serviceInvoked = true
      return { ok: true, value: await service.provisionResident(input) }
    } catch (error) {
      return { ok: false, error: structuredResidentProvisionError(error, serviceInvoked) }
    }
  })
  handle(
    IPC.prepareResidentEnd,
    residentEndPreparation,
    (input: z.infer<typeof residentEndPreparation>) => service.prepareResidentEnd(input)
  )
  handle(
    IPC.endResident,
    residentEnd,
    (input: z.infer<typeof residentEnd>) => service.endResident(input)
  )
  handle(
    IPC.residentLifecycleStatus,
    z.object({ expectedHostId: id, operationId: id }).strict(),
    (input: { expectedHostId: string; operationId: string }) => service.residentLifecycleStatus(input)
  )
  handle(
    IPC.requestSnapshot,
    z.object({ threadId: id.optional(), cursor: cursor.optional() }).strict(),
    (input: { threadId?: string; cursor?: z.infer<typeof cursor> }) => service.requestSnapshot(input)
  )
  handle(IPC.submitCommand, clientCommand, (input: z.infer<typeof clientCommand>) =>
    service.submitCommand(input)
  )
  handle(
    IPC.approve,
    z
      .object({
        deviceId: id,
        commandId: id,
        expectedHostId: id,
        expectedExecutionGenerationId: id,
        issuedAt: z.string().datetime({ offset: true }),
        threadId: id,
        approvalId: id,
        decision: z.enum(['approve', 'deny'])
      })
      .strict(),
    (input: Parameters<DesktopControlService['approve']>[0]) => service.approve(input)
  )
  handle(
    IPC.cancel,
    z
      .object({
        deviceId: id,
        commandId: id,
        expectedHostId: id,
        expectedExecutionGenerationId: id,
        issuedAt: z.string().datetime({ offset: true }),
        threadId: id,
        targetCommandId: id.optional()
      })
      .strict(),
    (input: Parameters<DesktopControlService['cancel']>[0]) => service.cancel(input)
  )
  handle(
    IPC.reconcileCommands,
    z.object({ commandIds: z.array(id).max(1_000) }).strict(),
    (input: { commandIds: string[] }) => service.reconcileCommands(input.commandIds)
  )
  handle(IPC.planHandoff, handoffPlan, (input: z.infer<typeof handoffPlan>) => service.planHandoff(input))
  handle(
    IPC.commitHandoff,
    z.object({ handoffId: id, deviceId: id, commandId: id, expectedHostId: id }).strict(),
    (input: Parameters<DesktopControlService['commitHandoff']>[0]) => service.commitHandoff(input)
  )
  handle(IPC.diagnostics, z.undefined(), () => service.diagnostics())

  const forward = (channel: string) => (payload: unknown): void => {
    const delivered = new Set<number>()
    for (const window of getWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      const webContentsId = window.webContents.id
      if (delivered.has(webContentsId)) continue
      delivered.add(webContentsId)
      window.webContents.send(channel, payload)
    }
  }
  const onConnectionState = forward(IPC.connectionState)
  const onHostEvent = forward(IPC.hostEvent)
  const onSnapshot = forward(IPC.snapshot)
  const onHandoffProgress = forward(IPC.handoffProgress)
  service.on('connection-state', onConnectionState)
  service.on('host-event', onHostEvent)
  service.on('snapshot', onSnapshot)
  service.on('handoff-progress', onHandoffProgress)

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
    service.off('connection-state', onConnectionState)
    service.off('host-event', onHostEvent)
    service.off('snapshot', onSnapshot)
    service.off('handoff-progress', onHandoffProgress)
  }
}

function assertBoundedIpcInput(value: unknown): void {
  if (value === undefined) return
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (cause) {
    throw new ControlError('ipc.invalid_payload', 'The native request payload is not serializable.', { cause })
  }
  if (Buffer.byteLength(serialized, 'utf8') > 512 * 1024) {
    throw new ControlError('ipc.payload_limit', 'The native request payload is too large.')
  }
}

function structuredResidentProvisionError(error: unknown, serviceInvoked: boolean) {
  const normalizedError = !serviceInvoked && !(error instanceof ControlError)
    ? new ControlError('ipc.invalid_payload', 'The native request payload is invalid.', { cause: error })
    : error
  const structured = toStructuredError(normalizedError)
  const explicitDurability = normalizedError instanceof ControlError &&
    typeof normalizedError.details?.durableOperationPossible === 'boolean'
    ? normalizedError.details.durableOperationPossible
    : undefined
  const durableOperationPossible = serviceInvoked
    ? explicitDurability ?? true
    : false
  const details = Object.fromEntries(
    Object.entries(structured.details ?? {})
      .filter(([key]) => key !== 'durableOperationPossible')
      .slice(0, 31),
  )
  return {
    ...structured,
    details: {
      durableOperationPossible,
      ...details,
    },
  }
}
