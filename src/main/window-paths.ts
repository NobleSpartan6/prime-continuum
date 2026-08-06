import path from 'node:path'

export const PRELOAD_ENTRY = '../preload/index.cjs'

export function resolvePreloadEntry(mainDirectory: string): string {
  return path.join(mainDirectory, PRELOAD_ENTRY)
}
