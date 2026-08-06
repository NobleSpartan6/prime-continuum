import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { ControlError } from './errors'
import { AtomicJsonStore } from './storage'

const INDEX_MAX_BYTES = 1024 * 1024

export const PROJECTION_FILE_MAX_BYTES = 24 * 1024 * 1024
export const PROJECTION_CACHE_TOTAL_MAX_BYTES = 256 * 1024 * 1024
export const PROJECTION_CACHE_HOST_LIMIT = 128

export interface ProjectionCacheLimits {
  fileMaxBytes: number
  totalMaxBytes: number
  hostLimit: number
}

const DEFAULT_LIMITS: ProjectionCacheLimits = {
  fileMaxBytes: PROJECTION_FILE_MAX_BYTES,
  totalMaxBytes: PROJECTION_CACHE_TOTAL_MAX_BYTES,
  hostLimit: PROJECTION_CACHE_HOST_LIMIT,
}

export interface IndexedProjectionEntry {
  hostId: string
  updatedAt?: string
  [key: string]: unknown
}

export interface IndexedProjectionEnvelope {
  version: 3
  entries: Record<string, IndexedProjectionEntry>
  activeHostId?: string
  [key: string]: unknown
}

interface StoredProjectionDescriptor {
  hostId: string
  fileName: string
  byteLength: number
  updatedAt?: string
}

interface StoredProjectionIndex {
  version: 3
  entries: Record<string, StoredProjectionDescriptor>
  [key: string]: unknown
}

/**
 * A small atomic index plus one bounded atomic file per immutable host.
 *
 * The index never embeds projection payloads. This keeps a second cached host
 * from consuming the first host's file allowance and makes a host refresh an
 * atomic replacement of only that host's projection file.
 */
export class IndexedProjectionCacheStore<T extends IndexedProjectionEnvelope> {
  private readonly index: AtomicJsonStore<unknown>
  private tail: Promise<void> = Promise.resolve()

  constructor(
    indexPath: string,
    private readonly projectionDirectory: string,
    private readonly normalize: (value: unknown) => T,
    private readonly fallback: () => T,
    private readonly limits: ProjectionCacheLimits = DEFAULT_LIMITS,
  ) {
    this.index = new AtomicJsonStore(indexPath, fallback, INDEX_MAX_BYTES)
  }

  async read(): Promise<T> {
    await this.tail
    return await this.readUnlocked()
  }

  async update(update: (current: T) => T | Promise<T>): Promise<T> {
    let result: T | undefined
    const operation = this.tail.then(async () => {
      const current = await this.readUnlocked()
      const requested = this.normalize(await update(current))
      result = await this.persistUnlocked(current, requested)
    })
    this.tail = operation.catch(() => undefined)
    await operation
    return result as T
  }

  private async readUnlocked(): Promise<T> {
    const raw = await this.index.read()
    if (!isStoredProjectionIndex(raw)) return this.normalize(raw)

    const entries: Record<string, IndexedProjectionEntry> = {}
    for (const [hostId, descriptor] of sortedOwnEntries(raw.entries)) {
      if (!isStoredProjectionDescriptor(descriptor, hostId)) continue
      if (descriptor.fileName !== projectionFileName(hostId)) continue
      const projection = await this.projectionStore(hostId).read()
      if (isRecord(projection)) entries[hostId] = projection as IndexedProjectionEntry
    }
    return this.normalize({ ...raw, entries })
  }

  private async persistUnlocked(current: T, requested: T): Promise<T> {
    const next = pruneToBudget(requested, this.limits)
    const currentBytes = serializedEntries(current.entries)
    const nextBytes = serializedEntries(next.entries)

    for (const [hostId, serialized] of nextBytes) {
      if (serialized.byteLength > this.limits.fileMaxBytes) {
        throw new ControlError('storage.write_limit', 'A host projection exceeds its safe cache limit.', {
          details: {
            hostId,
            maxBytes: this.limits.fileMaxBytes,
            actualBytes: serialized.byteLength,
          },
        })
      }
    }

    // Projection files are committed before the index. A crash can therefore
    // leave an unreferenced file, but never an index that points at a partial
    // payload. AtomicJsonStore itself fsyncs and renames each replacement.
    for (const [hostId, serialized] of nextBytes) {
      const store = this.projectionStore(hostId)
      if (currentBytes.get(hostId)?.json === serialized.json) {
        // A legacy inline entry compares equal after normalization but has no
        // per-host file yet. Confirm physical evidence before skipping it.
        const existing = await store.read()
        if (isRecord(existing)) continue
      }
      await store.write(next.entries[hostId] as IndexedProjectionEntry)
    }

    const { entries: _entries, ...metadata } = next
    const descriptors: Record<string, StoredProjectionDescriptor> = {}
    for (const [hostId, serialized] of nextBytes) {
      const entry = next.entries[hostId] as IndexedProjectionEntry
      descriptors[hostId] = {
        hostId,
        fileName: projectionFileName(hostId),
        byteLength: serialized.byteLength,
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
      }
    }
    await this.index.write({ ...metadata, version: 3, entries: descriptors } satisfies StoredProjectionIndex)

    for (const hostId of currentBytes.keys()) {
      if (nextBytes.has(hostId)) continue
      await this.removeProjectionFile(hostId)
    }
    return next
  }

  private projectionStore(hostId: string): AtomicJsonStore<unknown> {
    return new AtomicJsonStore(
      path.join(this.projectionDirectory, projectionFileName(hostId)),
      () => undefined,
      this.limits.fileMaxBytes,
    )
  }

  private async removeProjectionFile(hostId: string): Promise<void> {
    const directory = path.resolve(this.projectionDirectory)
    const filePath = path.resolve(directory, projectionFileName(hostId))
    if (path.dirname(filePath) !== directory) {
      throw new ControlError('storage.invalid_projection_path', 'A projection cache path escaped its private directory.')
    }
    await rm(filePath, { force: true })
  }
}

function pruneToBudget<T extends IndexedProjectionEnvelope>(value: T, limits: ProjectionCacheLimits): T {
  const entries = { ...value.entries }
  const inactiveByLru = () => Object.keys(entries)
    .filter((hostId) => hostId !== value.activeHostId)
    .sort((left, right) => {
      const timeDifference = entryTime(entries[left]) - entryTime(entries[right])
      return timeDifference || left.localeCompare(right)
    })

  while (Object.keys(entries).length > limits.hostLimit) {
    const oldest = inactiveByLru()[0]
    if (!oldest) {
      throw new ControlError('storage.projection_host_limit', 'The active projection cannot fit within the host cache limit.')
    }
    delete entries[oldest]
  }

  let serialized = serializedEntries(entries)
  let totalBytes = totalSerializedBytes(serialized)
  for (const hostId of inactiveByLru()) {
    if (totalBytes <= limits.totalMaxBytes) break
    delete entries[hostId]
    const removed = serialized.get(hostId)
    if (removed) totalBytes -= removed.byteLength
  }
  if (totalBytes > limits.totalMaxBytes) {
    throw new ControlError('storage.projection_total_limit', 'The active projection exceeds the total cache budget.', {
      details: { maxBytes: limits.totalMaxBytes, actualBytes: totalBytes },
    })
  }
  return { ...value, entries } as T
}

function serializedEntries(
  entries: Record<string, IndexedProjectionEntry>,
): Map<string, { json: string; byteLength: number }> {
  const serialized = new Map<string, { json: string; byteLength: number }>()
  for (const [hostId, entry] of sortedOwnEntries(entries)) {
    const json = JSON.stringify(entry)
    serialized.set(hostId, { json, byteLength: Buffer.byteLength(json, 'utf8') })
  }
  return serialized
}

function totalSerializedBytes(entries: Map<string, { byteLength: number }>): number {
  let total = 0
  for (const entry of entries.values()) total += entry.byteLength
  return total
}

function entryTime(entry: IndexedProjectionEntry | undefined): number {
  const parsed = entry?.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function projectionFileName(hostId: string): string {
  return `${createHash('sha256').update(hostId, 'utf8').digest('hex')}.json`
}

function isStoredProjectionIndex(value: unknown): value is StoredProjectionIndex {
  if (!isRecord(value) || value.version !== 3 || !isRecord(value.entries)) return false
  return Object.values(value.entries).every((entry) => isRecord(entry) && typeof entry.fileName === 'string')
}

function isStoredProjectionDescriptor(value: unknown, hostId: string): value is StoredProjectionDescriptor {
  return (
    isRecord(value) &&
    value.hostId === hostId &&
    typeof value.fileName === 'string' &&
    Number.isInteger(value.byteLength) &&
    Number(value.byteLength) >= 0 &&
    Number(value.byteLength) <= PROJECTION_FILE_MAX_BYTES &&
    (value.updatedAt === undefined || typeof value.updatedAt === 'string')
  )
}

function sortedOwnEntries<T>(value: Record<string, T>): Array<[string, T]> {
  return Object.keys(value).sort().map((key) => [key, value[key] as T])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
