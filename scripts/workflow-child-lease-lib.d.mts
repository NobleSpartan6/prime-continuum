export interface WorkflowChildLeaseOwner {
  schemaVersion: 1
  token: string
  lockToken: string
  workflow: string
  parentPid: number
  supervisorPid: number
  containment: 'windows-job' | 'posix-process-group'
  childPublication: 'pending' | 'published'
  childPid?: number
  startedAt: string
}

export class WorkflowChildLeaseError extends Error {
  owner: WorkflowChildLeaseOwner
}

export interface WorkflowChildLeasePublicationTestHooks {
  /** Deterministic test seam. Production callers must omit this override. */
  platform?: NodeJS.Platform
  /** Deterministic test seam. Production callers must omit this override. */
  rename?: (oldPath: string, newPath: string) => Promise<void>
  /** Deterministic test seam. Production callers must omit this override. */
  wait?: (milliseconds: number) => Promise<void>
  /** Deterministic test seam. Production callers must omit this callback. */
  beforeInspection?: () => void | Promise<void>
  /** Deterministic test seam. Production callers must omit this callback. */
  afterFileRead?: (path: string) => void | Promise<void>
}

export function workflowChildLeasePath(lockPath: string): string
export function rejectActiveWorkflowChild(options: {
  lockPath: string
  lockToken: string
  workflow: string
  isProcessAlive?: (pid: number) => boolean
}): Promise<void>
export function createWorkflowChildLease(options: {
  lockPath: string
  workflow: string
  lockToken: string
  parentPid: number
  supervisorPid: number
  /** Deterministic test seam. Production callers must omit these hooks. */
  publicationTestHooks?: WorkflowChildLeasePublicationTestHooks
}): Promise<{
  owner: WorkflowChildLeaseOwner
  setChildPid(childPid: number): Promise<void>
  confirmChildTreeExited(): Promise<boolean>
  release(): Promise<void>
}>
