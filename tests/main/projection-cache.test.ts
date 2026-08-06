import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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
    expect(Object.keys((await createStore(directory).read()).entries).sort()).toEqual([
      'host-active',
      'host-newer',
      'host-newest',
    ])
  })
})

function createStore(
  directory: string,
  limits?: { fileMaxBytes: number; totalMaxBytes: number; hostLimit: number },
): IndexedProjectionCacheStore<TestEnvelope> {
  return new IndexedProjectionCacheStore(
    path.join(directory, 'projection-cache.json'),
    path.join(directory, 'projections'),
    normalize,
    () => ({ version: 3, entries: {} }),
    limits,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
