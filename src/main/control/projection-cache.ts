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

export interface IndexedProjectionCacheStoreOptions {
  /** Injectable only for deterministic cache-read scheduling tests. */
  readProjection?: (hostId: string, read: () => Promise<unknown>) => Promise<unknown>
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
  private snapshot: T | undefined
  private initialRead: Promise<T> | undefined
  private backgroundHydration: Promise<void> | undefined
  private backgroundHydrationFailure: { error: unknown } | undefined
  /**
   * Every mutation advances this epoch before touching disk. A background read
   * may finish after that point, but it can no longer publish its older view.
   */
  private hydrationEpoch = 0

  constructor(
    indexPath: string,
    private readonly projectionDirectory: string,
    private readonly normalize: (value: unknown) => T,
    private readonly fallback: () => T,
    private readonly limits: ProjectionCacheLimits = DEFAULT_LIMITS,
    private readonly options: IndexedProjectionCacheStoreOptions = {},
  ) {
    this.index = new AtomicJsonStore(indexPath, fallback, INDEX_MAX_BYTES)
  }

  async read(): Promise<T> {
    await this.tail
    if (this.backgroundHydrationFailure) throw this.backgroundHydrationFailure.error
    if (this.snapshot) return this.snapshot

    const existing = this.initialRead
    if (existing) return await existing

    const epoch = this.hydrationEpoch
    const operation = this.readCacheFirstUnlocked(epoch)
    this.initialRead = operation
    try {
      return await operation
    } finally {
      if (this.initialRead === operation) this.initialRead = undefined
    }
  }

  /** Explicit full-cache barrier for maintenance paths that need inactive hosts. */
  async readHydrated(): Promise<T> {
    await this.read()
    const hydration = this.backgroundHydration
    if (hydration) await hydration
    return await this.read()
  }

  async update(update: (current: T) => T | Promise<T>): Promise<T> {
    let result: T | undefined
    const operation = this.tail.then(async () => {
      const epoch = ++this.hydrationEpoch
      this.snapshot = undefined
      this.initialRead = undefined
      this.backgroundHydrationFailure = undefined
      const current = await this.readAllUnlocked()
      const requested = this.normalize(await update(current))
      const persisted = await this.persistUnlocked(current, requested)
      if (epoch === this.hydrationEpoch) this.snapshot = persisted
      result = persisted
    })
    this.tail = operation.catch(() => undefined)
    await operation
    return result as T
  }

  /**
   * Initial paint needs only the selected authority. Inactive projections are
   * independently stored cache material, so they can hydrate after the first result
   * without delaying renderer readiness.
   */
  private async readCacheFirstUnlocked(epoch: number): Promise<T> {
    const raw = await this.index.read()
    if (!isStoredProjectionIndex(raw)) {
      const normalized = this.normalize(raw)
      if (epoch === this.hydrationEpoch) this.snapshot = normalized
      return normalized
    }

    const descriptors = this.validDescriptors(raw)
    const preferredHostId = preferredProjectionHostId(raw, descriptors)
    const entries: Record<string, IndexedProjectionEntry> = {}
    if (preferredHostId) {
      const projection = await this.readProjection(preferredHostId)
      if (isRecord(projection)) entries[preferredHostId] = projection as IndexedProjectionEntry
    }
    const initial = this.normalize({ ...raw, entries })
    if (epoch !== this.hydrationEpoch) return initial

    this.snapshot = initial
    const inactive = descriptors.filter(([hostId]) => hostId !== preferredHostId)
    if (inactive.length > 0) this.startBackgroundHydration(raw, inactive, entries, epoch)
    return initial
  }

  private async readAllUnlocked(): Promise<T> {
    const raw = await this.index.read()
    if (!isStoredProjectionIndex(raw)) return this.normalize(raw)

    const entries: Record<string, IndexedProjectionEntry> = {}
    for (const [hostId] of this.validDescriptors(raw)) {
      const projection = await this.readProjection(hostId)
      if (isRecord(projection)) entries[hostId] = projection as IndexedProjectionEntry
    }
    return this.normalize({ ...raw, entries })
  }

  private startBackgroundHydration(
    raw: StoredProjectionIndex,
    descriptors: Array<[string, StoredProjectionDescriptor]>,
    initialEntries: Record<string, IndexedProjectionEntry>,
    epoch: number,
  ): void {
    const operation = this.hydrateInactive(raw, descriptors, initialEntries, epoch)
    this.backgroundHydration = operation
    void operation
      .catch((error: unknown) => {
        // Preserve the existing fail-closed read behavior once asynchronous
        // hydration has discovered a bounded-file or filesystem failure.
        if (epoch === this.hydrationEpoch) this.backgroundHydrationFailure = { error }
      })
      .finally(() => {
        if (this.backgroundHydration === operation) this.backgroundHydration = undefined
      })
  }

  private async hydrateInactive(
    raw: StoredProjectionIndex,
    descriptors: Array<[string, StoredProjectionDescriptor]>,
    initialEntries: Record<string, IndexedProjectionEntry>,
    epoch: number,
  ): Promise<void> {
    const entries = { ...initialEntries }
    for (const [hostId] of descriptors) {
      if (epoch !== this.hydrationEpoch) return
      const projection = await this.readProjection(hostId)
      if (epoch !== this.hydrationEpoch) return
      if (isRecord(projection)) entries[hostId] = projection as IndexedProjectionEntry
    }
    const hydrated = this.normalize({ ...raw, entries })
    if (epoch === this.hydrationEpoch) this.snapshot = hydrated
  }

  private validDescriptors(raw: StoredProjectionIndex): Array<[string, StoredProjectionDescriptor]> {
    return sortedOwnEntries(raw.entries).filter(
      (entry): entry is [string, StoredProjectionDescriptor] => {
        const [hostId, descriptor] = entry
        return (
          isStoredProjectionDescriptor(descriptor, hostId, this.limits.fileMaxBytes) &&
          descriptor.fileName === projectionFileName(hostId)
        )
      },
    )
  }

  private async readProjection(hostId: string): Promise<unknown> {
    const read = async (): Promise<unknown> => await this.projectionStore(hostId).read()
    return this.options.readProjection ? await this.options.readProjection(hostId, read) : await read()
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

function isStoredProjectionDescriptor(
  value: unknown,
  hostId: string,
  fileMaxBytes = PROJECTION_FILE_MAX_BYTES,
): value is StoredProjectionDescriptor {
  return (
    isRecord(value) &&
    value.hostId === hostId &&
    typeof value.fileName === 'string' &&
    Number.isInteger(value.byteLength) &&
    Number(value.byteLength) >= 0 &&
    Number(value.byteLength) <= fileMaxBytes &&
    (value.updatedAt === undefined || typeof value.updatedAt === 'string')
  )
}

function preferredProjectionHostId(
  index: StoredProjectionIndex,
  descriptors: Array<[string, StoredProjectionDescriptor]>,
): string | undefined {
  const available = new Set(descriptors.map(([hostId]) => hostId))
  // The last target's immutable host binding is the bootstrap authority used
  // by DesktopControlService. Prefer that exact selection over advisory cache
  // metadata if a recovered index ever contains a mismatch.
  if (index.lastTarget !== undefined && Array.isArray(index.targetHostBindings)) {
    for (let offset = index.targetHostBindings.length - 1; offset >= 0; offset -= 1) {
      const binding = index.targetHostBindings[offset]
      if (!isRecord(binding) || typeof binding.hostId !== 'string') continue
      if (available.has(binding.hostId) && sameStoredTarget(binding.target, index.lastTarget)) {
        return binding.hostId
      }
    }
  }

  for (const candidate of [index.activeHostId, index.selectedHostId, index.projectionHostId]) {
    if (typeof candidate === 'string' && available.has(candidate)) return candidate
  }
  return undefined
}

function sameStoredTarget(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right) || left.kind !== right.kind) return false
  return left.kind === 'local' || (
    left.kind === 'ssh' &&
    typeof left.alias === 'string' &&
    typeof right.alias === 'string' &&
    left.alias === right.alias
  )
}

function sortedOwnEntries<T>(value: Record<string, T>): Array<[string, T]> {
  return Object.keys(value).sort().map((key) => [key, value[key] as T])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
