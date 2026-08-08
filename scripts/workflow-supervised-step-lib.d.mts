import type { WorkflowChildLeaseOwner } from './workflow-child-lease-lib.mjs'

export function runSupervisedWorkflowStep(options: {
  step: { executable: string; args: readonly string[]; cwd: string; environment: NodeJS.ProcessEnv }
  workflow: string
  lock: { path: string; owner: { token: string } }
  createLease?: (options: {
    lockPath: string
    workflow: string
    lockToken: string
    parentPid: number
    supervisorPid: number
  }) => Promise<{
    owner: WorkflowChildLeaseOwner
    setChildPid(pid: number): Promise<void>
    confirmChildTreeExited(): Promise<boolean>
    release(): Promise<void>
  }>
  awaitSupervisorExit?: (child: import('node:child_process').ChildProcess, timeoutMs: number) => Promise<boolean>
  teardownTimeoutMs?: number
}): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  supervisorExitedWithoutChildConfirmation: boolean
}>
