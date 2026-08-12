export type DevelopmentWorkflowPlanStep = Readonly<
  | { kind: 'node'; label: string; script: string; args: readonly string[] }
  | {
      kind: 'pnpm'
      label: string
      args: readonly string[]
      environmentBoundary?: 'desktop-launch'
    }
>

export function createDevelopmentWorkflowPlan(
  projectRoot: string,
): readonly DevelopmentWorkflowPlanStep[]

export function createDevelopmentBuildPlan(
  projectRoot: string,
): readonly DevelopmentWorkflowPlanStep[]

export function createDevelopmentHostBuildPlan(
  projectRoot: string,
): readonly DevelopmentWorkflowPlanStep[]

export function createPreviewWorkflowPlan(): readonly DevelopmentWorkflowPlanStep[]
