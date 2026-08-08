import path from 'node:path'

export const PRELOAD_ENTRY = '../preload/index.cjs'

export function resolvePreloadEntry(mainDirectory: string): string {
  if (path.posix.isAbsolute(mainDirectory)) return path.posix.join(mainDirectory, PRELOAD_ENTRY)
  if (path.win32.isAbsolute(mainDirectory)) return path.win32.join(mainDirectory, PRELOAD_ENTRY)
  return path.join(mainDirectory, PRELOAD_ENTRY)
}
