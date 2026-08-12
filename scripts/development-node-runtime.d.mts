export class DevelopmentNodeRuntimeError extends Error {}

export function readPinnedDevelopmentNodeVersion(projectRoot: string): string

export function readPinnedDevelopmentPnpmVersion(projectRoot: string): string

export function resolvePinnedDevelopmentNodeExecutable(projectRoot: string, platform?: NodeJS.Platform): string

export function assertPinnedDevelopmentNodeRuntime(options: {
  projectRoot: string
  actualVersion?: string
  execPath?: string
}): string
