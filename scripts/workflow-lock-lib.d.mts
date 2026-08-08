export interface WorkflowLockOwner {
  schemaVersion: 1
  token: string
  pid: number
  workflow: string
  startedAt: string
  projectRoot: string
}

export class WorkflowLockError extends Error {
  requestedWorkflow: string
  owner: WorkflowLockOwner | undefined
}

export function getWorkflowLockPath(projectRoot?: string): string

export function acquireWorkflowLock(options: {
  workflow: string
  projectRoot?: string
  lockPath?: string
  pid?: number
  now?: () => number
  isProcessAlive?: (pid: number) => boolean
}): Promise<{
  path: string
  owner: WorkflowLockOwner
  release(): Promise<void>
  releaseSync(): void
}>
