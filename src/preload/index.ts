import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type ClientCommand,
  type ConnectionTarget,
  type HandoffCommitRequest,
  type HandoffPlanRequest,
  type PrimeBridge,
  type Result,
  type SshProbe
} from '../main/control/contracts'

function invoke<T>(channel: string, input?: unknown): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, input) as Promise<Result<T>>
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const bridge: PrimeBridge = {
  bootstrap: () => invoke(IPC.bootstrap),
  discoverSshHosts: () => invoke(IPC.discoverSshHosts),
  probeSshHost: (input) => invoke(IPC.probeSshHost, input),
  planHostInstall: (input) => invoke(IPC.planHostInstall, input),
  installHost: (input) => invoke(IPC.installHost, input),
  connect: (input) => invoke(IPC.connect, input),
  reconnect: () => invoke(IPC.reconnect),
  disconnect: () => invoke(IPC.disconnect),
  hostCatalog: () => invoke(IPC.hostCatalog),
  projectCatalog: (input) => invoke(IPC.projectCatalog, input),
  threadProjection: (input) => invoke(IPC.threadProjection, input),
  runtimeModelCatalog: (input) => invoke(IPC.runtimeModelCatalog, input),
  requestSnapshot: (input) => invoke(IPC.requestSnapshot, input),
  submitCommand: (input) => invoke(IPC.submitCommand, input),
  approve: (input) => invoke(IPC.approve, input),
  cancel: (input) => invoke(IPC.cancel, input),
  reconcileCommands: (input) => invoke(IPC.reconcileCommands, input),
  planHandoff: (input) => invoke(IPC.planHandoff, input),
  commitHandoff: (input) => invoke(IPC.commitHandoff, input),
  diagnostics: () => invoke(IPC.diagnostics),
  onConnectionState: (listener) => subscribe(IPC.connectionState, listener),
  onHostEvent: (listener) => subscribe(IPC.hostEvent, listener),
  onSnapshot: (listener) => subscribe(IPC.snapshot, listener),
  onHandoffProgress: (listener) => subscribe(IPC.handoffProgress, listener)
}

type CompatibilityBridge = {
  loadWorkbench: PrimeBridge['bootstrap']
  getWorkbenchSnapshot(input?: Parameters<PrimeBridge['requestSnapshot']>[0]): ReturnType<PrimeBridge['requestSnapshot']>
  discoverComputers: PrimeBridge['discoverSshHosts']
  probeComputer(input: { alias?: string } | string): Promise<Result<SshProbe>>
  addComputer(input: { alias: string; [key: string]: unknown } | string): ReturnType<PrimeBridge['planHostInstall']>
  installRemoteHost: PrimeBridge['installHost']
  sendComposer: PrimeBridge['submitCommand']
  sendThreadCommand: PrimeBridge['submitCommand']
  planThreadMove: PrimeBridge['planHandoff']
  startHandoff: PrimeBridge['commitHandoff']
  moveThread: PrimeBridge['commitHandoff']
  subscribeWorkbench(listener: (snapshot: unknown) => void): () => void
}

const compatibility: CompatibilityBridge = {
  loadWorkbench: bridge.bootstrap,
  getWorkbenchSnapshot: (input = {}) => bridge.requestSnapshot(input),
  discoverComputers: bridge.discoverSshHosts,
  probeComputer: (input) =>
    bridge.probeSshHost({ alias: typeof input === 'string' ? input : (input.alias ?? '') }),
  addComputer: (input) =>
    bridge.planHostInstall({ alias: typeof input === 'string' ? input : input.alias }),
  installRemoteHost: bridge.installHost,
  sendComposer: bridge.submitCommand,
  sendThreadCommand: bridge.submitCommand,
  planThreadMove: bridge.planHandoff,
  startHandoff: bridge.commitHandoff,
  moveThread: bridge.commitHandoff,
  subscribeWorkbench: (listener) => bridge.onSnapshot(listener)
}

contextBridge.exposeInMainWorld('prime', Object.freeze({ ...bridge, ...compatibility }))

export type RendererPrimeBridge = PrimeBridge & CompatibilityBridge
export type { ClientCommand, ConnectionTarget, HandoffCommitRequest, HandoffPlanRequest }
