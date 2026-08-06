import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC, type Result } from './contracts'
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
    threadId: id.optional(),
    payload: jsonRecord.optional(),
    delivery: z.enum(['live_only', 'send_when_reconnected']).optional(),
    expectedExecutionGenerationId: id.optional()
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

export interface ControlIpcOptions {
  ipcMain: IpcMain
  service: DesktopControlService
  getWindow: () => BrowserWindow | undefined
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerControlIpc(options: ControlIpcOptions): () => void {
  const { ipcMain, service, getWindow, isTrustedSender } = options
  const channels: string[] = []

  const handle = <T>(
    channel: string,
    schema: z.ZodType,
    operation: (input: never) => Promise<T> | T
  ): void => {
    channels.push(channel)
    ipcMain.handle(channel, async (event, rawInput): Promise<Result<T>> => {
      try {
        if (!isTrustedSender(event)) {
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
    const window = getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(channel, payload)
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
