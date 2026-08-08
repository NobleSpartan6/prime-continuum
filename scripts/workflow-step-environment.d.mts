export const DESKTOP_LAUNCH_ENVIRONMENT_BOUNDARY: 'desktop-launch'

export function createDesktopLaunchEnvironment(
  source?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv

export function createWorkflowStepEnvironment(
  step: {
    readonly kind?: string
    readonly label?: string
    environment?: NodeJS.ProcessEnv
    environmentBoundary?: string
    replaceEnvironment?: boolean
  },
  inheritedEnvironment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv
