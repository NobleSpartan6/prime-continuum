import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IndexedProjectionCacheStore,
  PROJECTION_CACHE_HOST_LIMIT,
  PROJECTION_CACHE_TOTAL_MAX_BYTES,
  PROJECTION_FILE_MAX_BYTES,
  type IndexedProjectionEntry,
  type IndexedProjectionEnvelope,
  type IndexedProjectionCacheStoreOptions,
} from '../../src/main/control/projection-cache'

interface TestEnvelope extends IndexedProjectionEnvelope {
  version: 3
  entries: Record<string, IndexedProjectionEntry>
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('IndexedProjectionCacheStore', () => {
  it('persists a projection larger than the old 8 MiB ceiling in a hashed per-host file', async () => {
    const directory = await temporaryDirectory()
    const store = createStore(directory)
    const hostId = 'host:private-name'
    const payload = 'x'.repeat(8 * 1024 * 1024 + 1024)

    await store.update((cache) => ({
      ...cache,
      activeHostId: hostId,
      entries: {
        [hostId]: { hostId, updatedAt: '2026-08-06T04:00:00.000Z', payload },
      },
    }))

    const index = JSON.parse(await readFile(path.join(directory, 'projection-cache.json'), 'utf8')) as {
      entries: Record<string, { fileName: string; byteLength: number }>
    }
    const expectedFileName = `${createHash('sha256').update(hostId).digest('hex')}.json`
    expect(index.entries[hostId]).toMatchObject({ fileName: expectedFileName })
    expect(JSON.stringify(index)).not.toContain(payload.slice(0, 1024))
    expect(await readdir(path.join(directory, 'projections'))).toEqual([expectedFileName])

    const restarted = createStore(directory)
    expect((await restarted.read()).entries[hostId]?.payload).toHaveLength(payload.length)
  })

  it('rejects one host file above 24 MiB without weakening the production bounds', async () => {
    expect(PROJECTION_FILE_MAX_BYTES).toBe(24 * 1024 * 1024)
    expect(PROJECTION_CACHE_TOTAL_MAX_BYTES).toBe(256 * 1024 * 1024)
    expect(PROJECTION_CACHE_HOST_LIMIT).toBe(128)
    const directory = await temporaryDirectory()
    const store = createStore(directory)

    await expect(store.update((cache) => ({
      ...cache,
      activeHostId: 'host-large',
      entries: {
        'host-large': { hostId: 'host-large', payload: 'x'.repeat(PROJECTION_FILE_MAX_BYTES) },
      },
    }))).rejects.toMatchObject({ code: 'storage.write_limit' })

    await expect(readdir(path.join(directory, 'projections'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('prunes the deterministic oldest inactive host and never the active authority', async () => {
    const directory = await temporaryDirectory()
    const store = createStore(directory, { fileMaxBytes: 1024, totalMaxBytes: 4096, hostLimit: 3 })

    const persisted = await store.update((cache) => ({
      ...cache,
      activeHostId: 'host-active',
      entries: {
        'host-active': { hostId: 'host-active', updatedAt: '2026-08-01T00:00:00.000Z', payload: 'active' },
        'host-oldest': { hostId: 'host-oldest', updatedAt: '2026-08-02T00:00:00.000Z', payload: 'oldest' },
        'host-newer': { hostId: 'host-newer', updatedAt: '2026-08-03T00:00:00.000Z', payload: 'newer' },
        'host-newest': { hostId: 'host-newest', updatedAt: '2026-08-04T00:00:00.000Z', payload: 'newest' },
      },
    }))

    expect(Object.keys(persisted.entries).sort()).toEqual(['host-active', 'host-newer', 'host-newest'])
    expect(Object.keys((await createStore(directory).readHydrated()).entries).sort()).toEqual([
      'host-active',
      'host-newer',
      'host-newest',
    ])
  })

  it('returns the active projection before a slow inactive projection finishes hydrating', async () => {
    const directory = await temporaryDirectory()
    const seeded = createStore(directory)
    await seeded.update((cache) => ({
      ...cache,
      activeHostId: 'host-active',
      entries: {
        'host-active': { hostId: 'host-active', payload: 'ready' },
        'host-inactive': { hostId: 'host-inactive', payload: 'later' },
      },
    }))

    const inactiveReadStarted = deferred<void>()
    const releaseInactiveRead = deferred<void>()
    let inactiveReadFinished = false
    const restarted = createStore(directory, undefined, {
      readProjection: async (hostId, read) => {
        if (hostId === 'host-inactive') {
          inactiveReadStarted.resolve()
          await releaseInactiveRead.promise
          inactiveReadFinished = true
        }
        return await read()
      },
    })

    const initial = await restarted.read()
    expect(initial.entries['host-active']).toMatchObject({ payload: 'ready' })
    expect(initial.entries['host-inactive']).toBeUndefined()
    await inactiveReadStarted.promise
    expect(inactiveReadFinished).toBe(false)

    releaseInactiveRead.resolve()
    expect((await restarted.readHydrated()).entries['host-inactive']).toMatchObject({ payload: 'later' })
  })

  it('loads the host selected by the last verified target before other projections', async () => {
    const directory = await temporaryDirectory()
    const seeded = createStore(directory)
    const selectedTarget = { kind: 'local', recoveredMetadata: true }
    await seeded.update((cache) => ({
      ...cache,
      activeHostId: 'host-other',
      lastTarget: selectedTarget,
      targetHostBindings: [{ target: { kind: 'local' }, hostId: 'host-selected' }],
      entries: {
        'host-other': { hostId: 'host-other', payload: 'later' },
        'host-selected': { hostId: 'host-selected', payload: 'ready' },
      },
    }))

    const releaseOtherRead = deferred<void>()
    const otherReadStarted = deferred<void>()
    const restarted = createStore(directory, undefined, {
      readProjection: async (hostId, read) => {
        if (hostId === 'host-other') {
          otherReadStarted.resolve()
          await releaseOtherRead.promise
        }
        return await read()
      },
    })

    const initial = await restarted.read()
    expect(initial.entries['host-selected']).toMatchObject({ payload: 'ready' })
    expect(initial.entries['host-other']).toBeUndefined()
    await otherReadStarted.promise
    releaseOtherRead.resolve()
  })

  it('surfaces a bounded-file failure after allowing the valid active projection to paint', async () => {
    const directory = await temporaryDirectory()
    const limits = { fileMaxBytes: 256, totalMaxBytes: 1024, hostLimit: 3 }
    const seeded = createStore(directory, limits)
    await seeded.update((cache) => ({
      ...cache,
      activeHostId: 'host-active',
      entries: {
        'host-active': { hostId: 'host-active', payload: 'ready' },
        'host-inactive': { hostId: 'host-inactive', payload: 'initially-valid' },
      },
    }))
    const inactiveFile = `${createHash('sha256').update('host-inactive').digest('hex')}.json`
    await writeFile(
      path.join(directory, 'projections', inactiveFile),
      JSON.stringify({ hostId: 'host-inactive', payload: 'x'.repeat(512) }),
    )

    const inactiveReadStarted = deferred<void>()
    const releaseInactiveRead = deferred<void>()
    const restarted = createStore(directory, limits, {
      readProjection: async (hostId, read) => {
        if (hostId === 'host-inactive') {
          inactiveReadStarted.resolve()
          await releaseInactiveRead.promise
        }
        return await read()
      },
    })

    expect((await restarted.read()).entries['host-active']).toMatchObject({ payload: 'ready' })
    await inactiveReadStarted.promise
    releaseInactiveRead.resolve()
    await expect(restarted.readHydrated()).rejects.toMatchObject({ code: 'storage.read_limit' })
  })

  it('does not let stale background hydration overwrite a newer mutation', async () => {
    const directory = await temporaryDirectory()
    const seeded = createStore(directory)
    await seeded.update((cache) => ({
      ...cache,
      activeHostId: 'host-active',
      entries: {
        'host-active': { hostId: 'host-active', payload: 'old' },
        'host-inactive': { hostId: 'host-inactive', payload: 'preserved' },
      },
    }))

    const backgroundReadStarted = deferred<void>()
    const releaseBackgroundRead = deferred<void>()
    const backgroundReadReturned = deferred<void>()
    let inactiveReadCount = 0
    const restarted = createStore(directory, undefined, {
      readProjection: async (hostId, read) => {
        if (hostId === 'host-inactive' && ++inactiveReadCount === 1) {
          backgroundReadStarted.resolve()
          await releaseBackgroundRead.promise
          const value = await read()
          backgroundReadReturned.resolve()
          return value
        }
        return await read()
      },
    })

    expect((await restarted.read()).entries['host-active']).toMatchObject({ payload: 'old' })
    await backgroundReadStarted.promise

    const updated = await restarted.update((cache) => ({
      ...cache,
      entries: {
        ...cache.entries,
        'host-active': { hostId: 'host-active', payload: 'new' },
      },
    }))
    expect(updated.entries['host-active']).toMatchObject({ payload: 'new' })
    expect(updated.entries['host-inactive']).toMatchObject({ payload: 'preserved' })

    releaseBackgroundRead.resolve()
    await backgroundReadReturned.promise

    const afterBackgroundHydration = await restarted.readHydrated()
    expect(afterBackgroundHydration.entries['host-active']).toMatchObject({ payload: 'new' })
    expect(afterBackgroundHydration.entries['host-inactive']).toMatchObject({ payload: 'preserved' })
    expect((await createStore(directory).read()).entries['host-active']).toMatchObject({ payload: 'new' })
  })
})

function createStore(
  directory: string,
  limits?: { fileMaxBytes: number; totalMaxBytes: number; hostLimit: number },
  options?: IndexedProjectionCacheStoreOptions,
): IndexedProjectionCacheStore<TestEnvelope> {
  return new IndexedProjectionCacheStore(
    path.join(directory, 'projection-cache.json'),
    path.join(directory, 'projections'),
    normalize,
    () => ({ version: 3, entries: {} }),
    limits,
    options,
  )
}

function normalize(value: unknown): TestEnvelope {
  const raw = isRecord(value) ? value : {}
  const entries: Record<string, IndexedProjectionEntry> = {}
  if (isRecord(raw.entries)) {
    for (const [hostId, candidate] of Object.entries(raw.entries)) {
      if (isRecord(candidate) && candidate.hostId === hostId) {
        entries[hostId] = candidate as IndexedProjectionEntry
      }
    }
  }
  return {
    ...raw,
    version: 3,
    entries,
    ...(typeof raw.activeHostId === 'string' ? { activeHostId: raw.activeHostId } : {}),
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'prime-projection-cache-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
