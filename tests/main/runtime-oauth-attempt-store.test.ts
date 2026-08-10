import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_OAUTH_DESKTOP_TERMINAL_RETENTION_MS,
  RuntimeOAuthDesktopAttemptStore,
  type RuntimeOAuthDesktopAttemptRecordV1,
} from '../../src/main/control/runtime-oauth-attempt-store'
import {
  createRuntimeOAuthAttemptTerminalV1,
  createRuntimeOAuthAttemptV1,
  type RuntimeOAuthAttemptV1,
} from '../../src/shared/runtime-oauth-attempt'
import { canonicalTemporaryDirectory } from '../helpers/canonical-temp'

const temporaryDirectories: string[] = []
const BASE_TIME = Date.parse('2026-08-10T12:00:00.000Z')

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('desktop runtime OAuth attempt store', () => {
  it('prepares one canonical attempt, deduplicates it, and survives restart', async () => {
    const { file, store } = await createStore()
    const attempt = attemptFixture(1)

    const prepared = await store.prepare(attempt, attempt.identity.requestedAt)
    expect(prepared.created).toBe(true)
    expect(prepared.record).toMatchObject({ revision: 1, phase: 'prepared', attempt })
    expect(Object.isFrozen(prepared.record)).toBe(true)
    expect(Object.isFrozen(prepared.record.attempt)).toBe(true)

    const duplicate = await store.prepare(attempt, attempt.identity.requestedAt)
    expect(duplicate).toEqual({ record: prepared.record, created: false })

    const restarted = new RuntimeOAuthDesktopAttemptStore(file)
    await restarted.initialize()
    expect(await restarted.find(attempt.attemptDigest)).toEqual(prepared.record)
    expect(await restarted.snapshot()).toEqual({ version: 1, attempts: [prepared.record] })

    const bytes = await readFile(file, 'utf8')
    expect(bytes).not.toMatch(/(?:authorization|challenge|accessToken|refreshToken|credential|error|pid|path|argv|environment)/iu)
  })

  it('blocks a foreign attempt while any exact provider attempt remains unresolved', async () => {
    const { store } = await createStore()
    const first = attemptFixture(1)
    const second = attemptFixture(2)
    await store.prepare(first, first.identity.requestedAt)

    const reusedOperationId = createRuntimeOAuthAttemptV1({
      ...first.identity,
      expectedHostId: 'host-foreign',
    })
    await expect(store.prepare(reusedOperationId, reusedOperationId.identity.requestedAt)).rejects.toMatchObject({
      code: 'OAUTH_ATTEMPT_ID_CONFLICT',
    })

    await expect(store.prepare(second, second.identity.requestedAt)).rejects.toMatchObject({
      code: 'OAUTH_ATTEMPT_ACTIVE',
    })
    const recovery = await store.transition({
      attemptDigest: first.attemptDigest,
      expectedRevision: 1,
      phase: 'start_dispatching',
      updatedAt: timestamp(1),
    })
    await store.transition({
      attemptDigest: first.attemptDigest,
      expectedRevision: recovery.revision,
      phase: 'recovery_required',
      updatedAt: timestamp(2),
      recoveryReason: 'start_outcome_unconfirmed',
    })
    await expect(store.prepare(second, second.identity.requestedAt)).rejects.toMatchObject({
      code: 'OAUTH_ATTEMPT_ACTIVE',
    })
    expect(await store.compact(BASE_TIME + RUNTIME_OAUTH_DESKTOP_TERMINAL_RETENTION_MS * 2)).toBe(0)
  })

  it('persists every browser effect boundary, exact terminal result, and acknowledgement without replay', async () => {
    const { store } = await createStore()
    const attempt = attemptFixture(1)
    await store.prepare(attempt, attempt.identity.requestedAt)

    const start = await store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: 1,
      phase: 'start_dispatching',
      updatedAt: timestamp(1),
    })
    const admittedInput = {
      attemptDigest: attempt.attemptDigest,
      expectedRevision: start.revision,
      phase: 'host_admitted' as const,
      updatedAt: timestamp(2),
      hostSessionId: 'oauth-session-1',
      hostPhase: 'login_dispatching' as const,
    }
    const admitted = await store.transition(admittedInput)
    expect(await store.transition(admittedInput)).toEqual(admitted)

    const browserDispatch = await store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: admitted.revision,
      phase: 'browser_dispatching',
      updatedAt: timestamp(3),
      hostSessionId: 'oauth-session-1',
      hostPhase: 'login_dispatching',
    })
    const browserOpened = await store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: browserDispatch.revision,
      phase: 'browser_opened',
      updatedAt: timestamp(4),
      hostSessionId: 'oauth-session-1',
      hostPhase: 'login_dispatching',
    })
    const observing = await store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: browserOpened.revision,
      phase: 'observing',
      updatedAt: timestamp(5),
      hostSessionId: 'oauth-session-1',
      hostPhase: 'persistence_dispatching',
    })
    const terminal = createRuntimeOAuthAttemptTerminalV1({
      version: 1,
      attemptDigest: attempt.attemptDigest,
      phase: 'completed',
      resolution: 'persistence_confirmed',
      configuredObserved: true,
      terminalAt: timestamp(6),
    })
    const completed = await store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: observing.revision,
      phase: 'completed',
      updatedAt: timestamp(6),
      hostSessionId: 'oauth-session-1',
      hostPhase: 'completed',
      terminal,
    })
    expect(completed.terminal).toEqual(terminal)

    const acknowledgeInput = {
      attemptDigest: attempt.attemptDigest,
      expectedRevision: completed.revision,
      terminalDigest: terminal.terminalDigest,
      acknowledgedAt: timestamp(7),
    }
    const acknowledged = await store.acknowledgeTerminal(acknowledgeInput)
    expect(acknowledged).toMatchObject({
      revision: completed.revision + 1,
      phase: 'completed',
      hostAckConfirmedAt: timestamp(7),
      updatedAt: timestamp(7),
    })
    expect(await store.acknowledgeTerminal(acknowledgeInput)).toEqual(acknowledged)
    await expect(store.acknowledgeTerminal({
      ...acknowledgeInput,
      expectedRevision: acknowledged.revision,
    })).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_ID_CONFLICT' })
  })

  it('allows only exact monotonic transitions and terminal association', async () => {
    const { store } = await createStore()
    const attempt = attemptFixture(1)
    await store.prepare(attempt, attempt.identity.requestedAt)

    await expect(store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: 1,
      phase: 'browser_opened',
      updatedAt: timestamp(1),
      hostSessionId: 'oauth-session-1',
      hostPhase: 'login_dispatching',
    })).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_ID_CONFLICT' })

    const dispatching = await store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: 1,
      phase: 'start_dispatching',
      updatedAt: timestamp(1),
    })
    await expect(store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: 1,
      phase: 'recovery_required',
      updatedAt: timestamp(2),
      recoveryReason: 'start_outcome_unconfirmed',
    })).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_ID_CONFLICT' })
    await expect(store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: dispatching.revision,
      phase: 'recovery_required',
      updatedAt: timestamp(0),
      recoveryReason: 'start_outcome_unconfirmed',
    })).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_STORE_INVALID' })

    const foreign = attemptFixture(2)
    const wrongTerminal = createRuntimeOAuthAttemptTerminalV1({
      version: 1,
      attemptDigest: foreign.attemptDigest,
      phase: 'outcome_unknown',
      resolution: 'not_configured_observed_after_recovery',
      configuredObserved: false,
      terminalAt: timestamp(3),
    })
    await expect(store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: dispatching.revision,
      phase: 'outcome_unknown',
      updatedAt: timestamp(3),
      hostPhase: 'outcome_unknown',
      terminal: wrongTerminal,
    })).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_STORE_INVALID' })

    const admitted = await store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: dispatching.revision,
      phase: 'host_admitted',
      updatedAt: timestamp(3),
      hostSessionId: 'oauth-session-1',
      hostPhase: 'login_dispatching',
    })
    await expect(store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: admitted.revision,
      phase: 'browser_dispatching',
      updatedAt: timestamp(4),
      hostPhase: 'login_dispatching',
    })).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_STORE_INVALID' })
    await expect(store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: admitted.revision,
      phase: 'browser_dispatching',
      updatedAt: timestamp(4),
      hostSessionId: 'oauth-session-2',
      hostPhase: 'login_dispatching',
    })).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_STORE_INVALID' })
    await expect(store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: admitted.revision,
      phase: 'browser_dispatching',
      updatedAt: timestamp(4),
      hostSessionId: 'oauth-session-1',
      hostPhase: 'prepared',
    })).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_STORE_INVALID' })
  })

  it('represents a proven host-free pre-dispatch failure without inventing acknowledgement', async () => {
    const { store } = await createStore()
    const attempt = attemptFixture(1)
    await store.prepare(attempt, attempt.identity.requestedAt)
    const terminal = localPreDispatchTerminal(attempt, timestamp(1))
    const failed = await store.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: 1,
      phase: 'failed',
      updatedAt: timestamp(1),
      terminal,
    })

    expect(failed).not.toHaveProperty('hostPhase')
    expect(failed).not.toHaveProperty('hostSessionId')
    expect(failed).not.toHaveProperty('hostAckConfirmedAt')
    await expect(store.acknowledgeTerminal({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: failed.revision,
      terminalDigest: terminal.terminalDigest,
      acknowledgedAt: timestamp(2),
    })).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_ID_CONFLICT' })
  })

  it('fails closed for malformed, oversized, and secret-decorated ledgers without overwriting them', async () => {
    for (const [contents, code] of [
      ['{not-json', 'storage.malformed_json'],
      [JSON.stringify({ version: 1, attempts: [], authorizationUrl: 'https://auth.example' }), 'storage.invalid_root'],
      ['x'.repeat(512 * 1024 + 1), 'storage.read_limit'],
    ] as const) {
      const directory = await temporaryDirectory()
      const file = path.join(directory, 'runtime-oauth-attempts.json')
      await writeFile(file, contents)
      const store = new RuntimeOAuthDesktopAttemptStore(file)
      await expect(store.initialize()).rejects.toMatchObject({ code })
      expect(await readFile(file, 'utf8')).toBe(contents)
    }
  })

  it('rejects a poisoned ledger with multiple unresolved attempts and preserves its bytes', async () => {
    const { file, store } = await createStore()
    const first = attemptFixture(1)
    const second = attemptFixture(2)
    await store.prepare(first, first.identity.requestedAt)
    const ledger = JSON.parse(await readFile(file, 'utf8')) as { attempts: Array<Record<string, unknown>> }
    ledger.attempts.push({
      ...ledger.attempts[0],
      attempt: second,
      preparedAt: second.identity.requestedAt,
      updatedAt: second.identity.requestedAt,
    })
    ledger.attempts.sort((left, right) => {
      const leftDigest = (left.attempt as RuntimeOAuthAttemptV1).attemptDigest
      const rightDigest = (right.attempt as RuntimeOAuthAttemptV1).attemptDigest
      return leftDigest < rightDigest ? -1 : leftDigest > rightDigest ? 1 : 0
    })
    const poisoned = JSON.stringify(ledger)
    await writeFile(file, poisoned)

    const restarted = new RuntimeOAuthDesktopAttemptStore(file)
    await expect(restarted.initialize()).rejects.toMatchObject({ code: 'storage.invalid_root' })
    expect(await readFile(file, 'utf8')).toBe(poisoned)
  })

  it('rejects decorated direct inputs without invoking accessors', async () => {
    const { store } = await createStore()
    const attempt = attemptFixture(1)
    let reads = 0
    const accessor = { ...attempt } as Record<string, unknown>
    Object.defineProperty(accessor, 'attemptDigest', {
      enumerable: true,
      get() {
        reads += 1
        return attempt.attemptDigest
      },
    })
    await expect(store.prepare(accessor, attempt.identity.requestedAt)).rejects.toThrow(/accessor/u)
    expect(reads).toBe(0)

    await store.prepare(attempt, attempt.identity.requestedAt)
    const transition = {
      attemptDigest: attempt.attemptDigest,
      expectedRevision: 1,
      phase: 'start_dispatching',
      updatedAt: timestamp(1),
    } as Record<string, unknown>
    Object.defineProperty(transition, 'authorizationUrl', { enumerable: false, value: 'never-read' })
    await expect(store.transition(transition as never)).rejects.toMatchObject({
      code: 'OAUTH_ATTEMPT_STORE_INVALID',
    })
  })

  it('enforces capacity, retains unacknowledged host terminals, and compacts only proven old records', async () => {
    expect(RUNTIME_OAUTH_DESKTOP_TERMINAL_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1_000)
    const { store } = await createStore({ maxEntries: 2, retentionMs: 1_000 })
    const first = await prepareLocalTerminal(store, attemptFixture(1), timestamp(1))
    const second = await prepareLocalTerminal(store, attemptFixture(2), timestamp(3))

    await expect(store.prepare(attemptFixture(3), attemptFixture(3).identity.requestedAt)).rejects.toMatchObject({
      code: 'OAUTH_ATTEMPT_STORAGE_FULL',
    })
    expect(await store.compact(Date.parse(timestamp(3)) + 999)).toBe(1)
    expect((await store.snapshot()).attempts.map(({ attempt }) => attempt.attemptDigest)).toEqual([
      second.attempt.attemptDigest,
    ])
    const third = attemptFixture(3)
    await store.prepare(third, third.identity.requestedAt)

    expect(first.phase).toBe('failed')
    expect(await store.compact(Date.parse(timestamp(0)))).toBe(0)
  })

  it('keeps host terminal records until exact acknowledgement and full retention', async () => {
    const { store } = await createStore({ retentionMs: 1_000 })
    const attempt = attemptFixture(1)
    const completed = await prepareHostTerminal(store, attempt)

    expect(await store.compact(Date.parse(timestamp(100)))).toBe(0)
    const terminal = completed.terminal!
    const acknowledged = await store.acknowledgeTerminal({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: completed.revision,
      terminalDigest: terminal.terminalDigest,
      acknowledgedAt: timestamp(10),
    })
    expect(await store.compact(Date.parse(timestamp(10)) + 999)).toBe(0)
    expect(await store.compact(Date.parse(timestamp(10)) + 1_000)).toBe(1)
    expect(await store.find(acknowledged.attempt.attemptDigest)).toBeUndefined()
  })

  it('latches an ambiguous compaction and does not use the visible deletion for admission', async () => {
    let failSync = false
    const { store } = await createStore({
      retentionMs: 1,
      storage: {
        syncParentDirectory: async () => {
          if (failSync) throw new Error('simulated directory durability failure')
        },
      },
    })
    await prepareLocalTerminal(store, attemptFixture(1), timestamp(1))
    failSync = true

    await expect(store.compact(Date.parse(timestamp(2)))).rejects.toMatchObject({
      code: 'storage.commit_uncertain',
    })
    expect((await store.snapshot()).attempts).toEqual([])
    const next = attemptFixture(2)
    await expect(store.prepare(next, next.identity.requestedAt)).rejects.toMatchObject({
      code: 'OAUTH_ATTEMPT_COMMIT_UNCERTAIN',
    })
  })

  it('blocks exact prepare retry after an uncertain commit until initialization re-establishes durability', async () => {
    let failSync = false
    const { file, store } = await createStore({
      storage: {
        syncParentDirectory: async () => {
          if (failSync) throw new Error('simulated directory durability failure')
        },
      },
    })
    const attempt = attemptFixture(1)
    failSync = true

    await expect(store.prepare(attempt, attempt.identity.requestedAt)).rejects.toMatchObject({
      code: 'storage.commit_uncertain',
    })
    expect(await store.find(attempt.attemptDigest)).toMatchObject({ phase: 'prepared', revision: 1 })
    await expect(store.prepare(attempt, attempt.identity.requestedAt)).rejects.toMatchObject({
      code: 'OAUTH_ATTEMPT_COMMIT_UNCERTAIN',
    })

    failSync = false
    const restarted = new RuntimeOAuthDesktopAttemptStore(file, {
      storage: {
        syncParentDirectory: async () => {
          if (failSync) throw new Error('simulated directory durability failure')
        },
      },
    })
    await restarted.initialize()
    expect(await restarted.prepare(attempt, attempt.identity.requestedAt)).toMatchObject({ created: false })
  })

  it('blocks exact transition retry after an uncertain effect-boundary commit', async () => {
    let failSync = false
    const { store } = await createStore({
      storage: {
        syncParentDirectory: async () => {
          if (failSync) throw new Error('simulated directory durability failure')
        },
      },
    })
    const attempt = attemptFixture(1)
    await store.prepare(attempt, attempt.identity.requestedAt)
    const transition = {
      attemptDigest: attempt.attemptDigest,
      expectedRevision: 1,
      phase: 'start_dispatching' as const,
      updatedAt: timestamp(1),
    }
    failSync = true

    await expect(store.transition(transition)).rejects.toMatchObject({ code: 'storage.commit_uncertain' })
    expect(await store.find(attempt.attemptDigest)).toMatchObject({ phase: 'start_dispatching', revision: 2 })
    await expect(store.transition(transition)).rejects.toMatchObject({
      code: 'OAUTH_ATTEMPT_COMMIT_UNCERTAIN',
    })
  })

  it('blocks exact acknowledgement retry after an uncertain acknowledgement commit', async () => {
    let failSync = false
    const { store } = await createStore({
      storage: {
        syncParentDirectory: async () => {
          if (failSync) throw new Error('simulated directory durability failure')
        },
      },
    })
    const completed = await prepareHostTerminal(store, attemptFixture(1))
    const acknowledgement = {
      attemptDigest: completed.attempt.attemptDigest,
      expectedRevision: completed.revision,
      terminalDigest: completed.terminal!.terminalDigest,
      acknowledgedAt: timestamp(10),
    }
    failSync = true

    await expect(store.acknowledgeTerminal(acknowledgement)).rejects.toMatchObject({
      code: 'storage.commit_uncertain',
    })
    expect(await store.find(completed.attempt.attemptDigest)).toMatchObject({
      revision: completed.revision + 1,
      hostAckConfirmedAt: timestamp(10),
    })
    await expect(store.acknowledgeTerminal(acknowledgement)).rejects.toMatchObject({
      code: 'OAUTH_ATTEMPT_COMMIT_UNCERTAIN',
    })
  })

  it('serializes every instance that addresses the same ledger', async () => {
    const directory = await temporaryDirectory()
    const physicalDirectory = path.join(directory, 'physical')
    const aliasDirectory = path.join(directory, 'alias')
    await mkdir(physicalDirectory)
    await symlink(physicalDirectory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    const file = path.join(physicalDirectory, 'runtime-oauth-attempts.json')
    const store = new RuntimeOAuthDesktopAttemptStore(file)
    const second = new RuntimeOAuthDesktopAttemptStore(path.join(aliasDirectory, path.basename(file)))
    await store.initialize()
    await second.initialize()
    const attempt = attemptFixture(1)
    await store.prepare(attempt, attempt.identity.requestedAt)
    const localTerminal = localPreDispatchTerminal(attempt, timestamp(1))

    const results = await Promise.allSettled([
      store.transition({
        attemptDigest: attempt.attemptDigest,
        expectedRevision: 1,
        phase: 'start_dispatching',
        updatedAt: timestamp(1),
      }),
      second.transition({
        attemptDigest: attempt.attemptDigest,
        expectedRevision: 1,
        phase: 'failed',
        updatedAt: timestamp(1),
        terminal: localTerminal,
      }),
    ])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find(({ status }) => status === 'rejected')
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: { code: 'OAUTH_ATTEMPT_ID_CONFLICT' },
    })
    expect((await store.find(attempt.attemptDigest))?.revision).toBe(2)
  })

  it('rejects revision exhaustion before replacing a valid ledger', async () => {
    const { file, store } = await createStore()
    const attempt = attemptFixture(1)
    await store.prepare(attempt, attempt.identity.requestedAt)
    const ledger = JSON.parse(await readFile(file, 'utf8')) as { attempts: Array<{ revision: number }> }
    ledger.attempts[0]!.revision = Number.MAX_SAFE_INTEGER
    await writeFile(file, JSON.stringify(ledger))
    const before = await readFile(file, 'utf8')
    const restarted = new RuntimeOAuthDesktopAttemptStore(file)
    await restarted.initialize()
    const afterInitialization = await readFile(file, 'utf8')

    await expect(restarted.transition({
      attemptDigest: attempt.attemptDigest,
      expectedRevision: Number.MAX_SAFE_INTEGER,
      phase: 'start_dispatching',
      updatedAt: timestamp(1),
    })).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_STORE_INVALID' })
    expect(await readFile(file, 'utf8')).toBe(afterInitialization)
    expect(JSON.parse(afterInitialization)).toEqual(JSON.parse(before))

    const secondStore = await createStore()
    const completed = await prepareHostTerminal(secondStore.store, attemptFixture(2))
    const terminalLedger = JSON.parse(await readFile(secondStore.file, 'utf8')) as {
      attempts: Array<{ revision: number }>
    }
    terminalLedger.attempts[0]!.revision = Number.MAX_SAFE_INTEGER
    await writeFile(secondStore.file, JSON.stringify(terminalLedger))
    const terminalRestarted = new RuntimeOAuthDesktopAttemptStore(secondStore.file)
    await terminalRestarted.initialize()
    const terminalBefore = await readFile(secondStore.file, 'utf8')
    await expect(terminalRestarted.acknowledgeTerminal({
      attemptDigest: completed.attempt.attemptDigest,
      expectedRevision: Number.MAX_SAFE_INTEGER,
      terminalDigest: completed.terminal!.terminalDigest,
      acknowledgedAt: timestamp(10),
    })).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_STORE_INVALID' })
    expect(await readFile(secondStore.file, 'utf8')).toBe(terminalBefore)
  })

  it('rejects a persisted host-backed terminal that loses its exact host session', async () => {
    const { file, store } = await createStore()
    await prepareHostTerminal(store, attemptFixture(1))
    const ledger = JSON.parse(await readFile(file, 'utf8')) as {
      attempts: Array<Record<string, unknown>>
    }
    delete ledger.attempts[0]!.hostSessionId
    const poisoned = JSON.stringify(ledger)
    await writeFile(file, poisoned)

    const restarted = new RuntimeOAuthDesktopAttemptStore(file)
    await expect(restarted.initialize()).rejects.toMatchObject({ code: 'storage.invalid_root' })
    expect(await readFile(file, 'utf8')).toBe(poisoned)
  })

  it('keeps snapshots canonical, deeply frozen, and free of secret-bearing fields', async () => {
    const { store } = await createStore()
    const attempt = attemptFixture(1)
    await store.prepare(attempt, attempt.identity.requestedAt)
    const snapshot = await store.snapshot()

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.attempts)).toBe(true)
    expect(Object.isFrozen(snapshot.attempts[0])).toBe(true)
    expect(Reflect.ownKeys(snapshot)).toEqual(['version', 'attempts'])
    expect(Reflect.ownKeys(snapshot.attempts[0]!)).toEqual([
      'recordVersion',
      'attempt',
      'revision',
      'phase',
      'preparedAt',
      'updatedAt',
    ])
    const forbiddenKeys = new Set([
      'authorizationUrl',
      'challenge',
      'progress',
      'state',
      'code',
      'token',
      'credential',
      'credentials',
      'account',
      'error',
      'pid',
      'path',
      'argv',
      'environment',
    ])
    expect(collectKeys(snapshot).some((key) => forbiddenKeys.has(key))).toBe(false)
    for (const value of collectStrings(snapshot)) {
      expect(value).not.toMatch(/^(?:https?|file):/iu)
      expect(value).not.toContain('\\')
      expect(value).not.toContain('/')
    }
  })
})

async function createStore(options: ConstructorParameters<typeof RuntimeOAuthDesktopAttemptStore>[1] = {}) {
  const directory = await temporaryDirectory()
  const file = path.join(directory, 'runtime-oauth-attempts.json')
  const store = new RuntimeOAuthDesktopAttemptStore(file, options)
  await store.initialize()
  return { directory, file, store }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await canonicalTemporaryDirectory('prime-runtime-oauth-attempt-store-')
  temporaryDirectories.push(directory)
  return directory
}

function attemptFixture(index: number): RuntimeOAuthAttemptV1 {
  return createRuntimeOAuthAttemptV1({
    version: 1,
    expectedHostId: `host-${index}`,
    providerId: 'openai-codex',
    operationId: `123e4567-e89b-42d3-a456-${(426_614_174_000 + index).toString(16).padStart(12, '0')}`,
    requestedAt: timestamp(0),
  })
}

function timestamp(seconds: number): string {
  return new Date(BASE_TIME + seconds * 1_000).toISOString()
}

function localPreDispatchTerminal(attempt: RuntimeOAuthAttemptV1, terminalAt: string) {
  return createRuntimeOAuthAttemptTerminalV1({
    version: 1,
    attemptDigest: attempt.attemptDigest,
    phase: 'failed',
    resolution: 'interrupted_before_login_dispatch',
    configuredObserved: null,
    terminalAt,
  })
}

async function prepareLocalTerminal(
  store: RuntimeOAuthDesktopAttemptStore,
  attempt: RuntimeOAuthAttemptV1,
  terminalAt: string,
): Promise<RuntimeOAuthDesktopAttemptRecordV1> {
  await store.prepare(attempt, attempt.identity.requestedAt)
  return await store.transition({
    attemptDigest: attempt.attemptDigest,
    expectedRevision: 1,
    phase: 'failed',
    updatedAt: terminalAt,
    terminal: localPreDispatchTerminal(attempt, terminalAt),
  })
}

async function prepareHostTerminal(
  store: RuntimeOAuthDesktopAttemptStore,
  attempt: RuntimeOAuthAttemptV1,
): Promise<RuntimeOAuthDesktopAttemptRecordV1> {
  await store.prepare(attempt, attempt.identity.requestedAt)
  const dispatching = await store.transition({
    attemptDigest: attempt.attemptDigest,
    expectedRevision: 1,
    phase: 'start_dispatching',
    updatedAt: timestamp(1),
  })
  const admitted = await store.transition({
    attemptDigest: attempt.attemptDigest,
    expectedRevision: dispatching.revision,
    phase: 'host_admitted',
    updatedAt: timestamp(2),
    hostSessionId: 'oauth-session-1',
    hostPhase: 'login_dispatching',
  })
  const terminal = createRuntimeOAuthAttemptTerminalV1({
    version: 1,
    attemptDigest: attempt.attemptDigest,
    phase: 'completed',
    resolution: 'persistence_confirmed',
    configuredObserved: true,
    terminalAt: timestamp(3),
  })
  return await store.transition({
    attemptDigest: attempt.attemptDigest,
    expectedRevision: admitted.revision,
    phase: 'completed',
    updatedAt: timestamp(3),
    hostSessionId: 'oauth-session-1',
    hostPhase: 'completed',
    terminal,
  })
}

function collectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  return Reflect.ownKeys(value).flatMap((key) => [
    typeof key === 'string' ? key : key.description ?? 'symbol',
    ...collectKeys(Object.getOwnPropertyDescriptor(value, key)?.value),
  ])
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Reflect.ownKeys(value).flatMap((key) => collectStrings(Object.getOwnPropertyDescriptor(value, key)?.value))
}
