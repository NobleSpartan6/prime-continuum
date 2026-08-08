export const DESKTOP_LAUNCH_ENVIRONMENT_BOUNDARY = 'desktop-launch'

export function createDesktopLaunchEnvironment(source = process.env) {
  const environment = {}
  for (const [name, value] of Object.entries(source)) {
    if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue
    environment[name] = value
  }
  return environment
}

export function createWorkflowStepEnvironment(step, inheritedEnvironment = process.env) {
  const environment = step.replaceEnvironment
    ? { ...(step.environment ?? {}) }
    : { ...inheritedEnvironment, ...(step.environment ?? {}) }
  return step.environmentBoundary === DESKTOP_LAUNCH_ENVIRONMENT_BOUNDARY
    ? createDesktopLaunchEnvironment(environment)
    : environment
}
