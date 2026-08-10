import {
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as JournalModule from '../../scripts/remote-host-install-journal.mjs'
import {
  canonicalRemoteHostInstallOperationJson,
  createRemoteHostInstallOperation,
  reduceRemoteHostInstallOperation,
} from '../../scripts/remote-host-install-operation.mjs'

const {
  REMOTE_HOST_INSTALL_JOURNAL_FAULT_POINTS,
  REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORD_BYTES,
  openRemoteHostInstallJournal,
} = JournalModule

const JournalRuntime = JournalModule as typeof JournalModule & Readonly<{
  __REMOTE_HOST_INSTALL_VITEST_ONLY_WINDOWS_REFERENCE_FENCE: object
}>

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('remote host install append-only journal', () => {
  it('publishes canonical revision-only records and returns path-free frozen state', async () => {
    const directory = await temporaryDirectory()
    const journal = await openJournal(directory)

    const empty = await journal.readState()
    expect(empty).toMatchObject({
      disposition: 'empty',
      currentRecord: null,
      effectAuthority: null,
    })
    expect(Object.values(empty.claims).every((value) => value === false)).toBe(true)

    const initialized = await journal.initialize({ evidenceSha256: null })
    expect(initialized.record.phase).toBe('planned')
    expect(initialized.effectAuthority).toBeNull()
    expect(await readdir(directory)).toEqual(['r0000.json'])
    expect(await readFile(join(directory, 'r0000.json'), 'utf8')).toBe(
      `${canonicalRemoteHostInstallOperationJson(initialized.record)}\n`,
    )

    const admitted = await journal.append({
      expectedRevision: initialized.record.revision,
      expectedRecordSha256: initialized.record.recordSha256,
      phase: 'admitted',
      evidenceSha256: digest('1'),
    })
    expect(await readdir(directory)).toEqual(['r0000.json', 'r0001.json'])
    const state = await journal.readState()
    expect(state.currentRecord).toEqual(admitted.record)
    expect(state.disposition).toBe('resume_pre_effect_reducer')
    expect(JSON.stringify(state)).not.toContain(directory)
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.records)).toBe(true)
  })

  it('makes every legal branch at one revision contend on one no-replace slot', async () => {
    const directory = await temporaryDirectory()
    const creator = await openJournal(directory)
    const planned = (await creator.initialize({ evidenceSha256: null })).record
    const admitted = (await creator.append({
      expectedRevision: planned.revision,
      expectedRecordSha256: planned.recordSha256,
      phase: 'admitted',
      evidenceSha256: digest('1'),
    })).record
    const first = await openJournal(directory)
    const second = await openJournal(directory)

    const attempts = await Promise.allSettled([
      first.append({
        expectedRevision: admitted.revision,
        expectedRecordSha256: admitted.recordSha256,
        phase: 'dispatching',
        evidenceSha256: digest('2'),
      }),
      second.append({
        expectedRevision: admitted.revision,
        expectedRecordSha256: admitted.recordSha256,
        phase: 'failed_pre_effect',
        evidenceSha256: digest('3'),
      }),
    ])

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    expect((await readdir(directory)).sort()).toEqual([
      'r0000.json',
      'r0001.json',
      'r0002.json',
    ])
    const reopened = await openJournal(directory)
    const current = (await reopened.readState()).currentRecord
    expect(current?.revision).toBe(2)
    expect(['dispatching', 'failed_pre_effect']).toContain(current?.phase)
  })

  it('never treats EEXIST or an exact matching retry as fresh publication', async () => {
    const directory = await temporaryDirectory()
    const creator = await openJournal(directory)
    const planned = (await creator.initialize({ evidenceSha256: null })).record
    const admitted = (await creator.append({
      expectedRevision: planned.revision,
      expectedRecordSha256: planned.recordSha256,
      phase: 'admitted',
      evidenceSha256: digest('1'),
    })).record
    const first = await openJournal(directory)
    const second = await openJournal(directory)
    const transition = {
      expectedRevision: admitted.revision,
      expectedRecordSha256: admitted.recordSha256,
      phase: 'dispatching' as const,
      evidenceSha256: digest('2'),
    }

    const outcomes = await Promise.allSettled([first.append(transition), second.append(transition)])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    expect(outcomes.every((outcome) => outcome.status === 'rejected' || outcome.value.effectAuthority === null)).toBe(true)

    const recovered = await openJournal(directory)
    const state = await recovered.readState()
    expect(state.currentRecord?.phase).toBe('dispatching')
    expect(state.statusOnly).toBe(true)
    expect(state.effectAuthority).toBeNull()
  })

  it.each(REMOTE_HOST_INSTALL_JOURNAL_FAULT_POINTS)(
    'returns no successful publication at fault point %s',
    async (faultPoint) => {
      const directory = await temporaryDirectory()
      const creator = await openJournal(directory)
      const planned = (await creator.initialize({ evidenceSha256: null })).record
      const admitted = (await creator.append({
        expectedRevision: planned.revision,
        expectedRecordSha256: planned.recordSha256,
        phase: 'admitted',
        evidenceSha256: digest('1'),
      })).record
      const faulty = await openJournal(directory, {
        faultInjector(point) {
          if (point === faultPoint) throw new Error('private path and secret must not escape')
        },
      })

      await expect(faulty.append({
        expectedRevision: admitted.revision,
        expectedRecordSha256: admitted.recordSha256,
        phase: 'dispatching',
        evidenceSha256: digest('2'),
      })).rejects.toMatchObject({
        name: 'RemoteHostInstallJournalError',
      })
      await expect(faulty.readState()).rejects.toMatchObject({ code: 'journal_reopen_required' })

      try {
        const recovered = await openJournal(directory)
        const state = await recovered.readState()
        expect(state.effectAuthority).toBeNull()
        expect(state.currentRecord?.phase).toBe('dispatching')
        expect(state.statusOnly).toBe(true)
      } catch (error) {
        expect(error).toMatchObject({ name: 'RemoteHostInstallJournalError' })
        expect(String(error)).not.toContain(directory)
        expect(String(error)).not.toContain('private path')
      }
    },
  )

  it('rejects noncanonical bytes, gaps, unknown entries, hard links, and oversize files', async () => {
    const corruptions: Array<(directory: string) => Promise<void>> = [
      async (directory) => {
        const path = join(directory, 'r0000.json')
        const text = await readFile(path, 'utf8')
        await writeFile(path, ` ${text}`, { mode: 0o600 })
      },
      async (directory) => {
        await rename(join(directory, 'r0000.json'), join(directory, 'r0001.json'))
      },
      async (directory) => {
        await writeFile(join(directory, 'unexpected.json'), '{}\n', { mode: 0o600 })
      },
      async (directory) => {
        await link(join(directory, 'r0000.json'), join(directory, 'alias.json'))
      },
      async (directory) => {
        await writeFile(
          join(directory, 'r0000.json'),
          Buffer.alloc(REMOTE_HOST_INSTALL_JOURNAL_MAX_RECORD_BYTES + 1, 0x61),
          { mode: 0o600 },
        )
      },
    ]

    for (const corrupt of corruptions) {
      const directory = await temporaryDirectory()
      const journal = await openJournal(directory)
      await journal.initialize({ evidenceSha256: null })
      await corrupt(directory)
      await expect(openJournal(directory)).rejects.toMatchObject({
        name: 'RemoteHostInstallJournalError',
      })
    }
  })

  it('reconstructs every adjacent record through the reducer instead of trusting valid records separately', async () => {
    const directory = await temporaryDirectory()
    const journal = await openJournal(directory)
    const planned = (await journal.initialize({ evidenceSha256: null })).record
    await journal.append({
      expectedRevision: planned.revision,
      expectedRecordSha256: planned.recordSha256,
      phase: 'admitted',
      evidenceSha256: digest('1'),
    })

    const alternatePlanned = createRemoteHostInstallOperation(identity({
      targetAuthoritySha256: digest('9'),
    }))
    const alternateAdmitted = reduceRemoteHostInstallOperation(alternatePlanned, {
      expectedRevision: 0,
      expectedRecordSha256: alternatePlanned.recordSha256,
      phase: 'admitted',
      evidenceSha256: digest('1'),
    }).record
    await writeFile(
      join(directory, 'r0001.json'),
      `${canonicalRemoteHostInstallOperationJson(alternateAdmitted)}\n`,
      { mode: 0o600 },
    )

    await expect(openJournal(directory)).rejects.toMatchObject({ code: 'journal_chain_invalid' })
  })

  it('rejects proxies, accessors, symbols, stale CAS, and leaks no input paths', async () => {
    const directory = await temporaryDirectory()
    await expect(openRemoteHostInstallJournal(new Proxy({
      journalDirectory: directory,
      identity: identity(),
    }, {}))).rejects.toMatchObject({ code: 'journal_options_invalid' })

    const accessor = {
      journalDirectory: directory,
      identity: identity(),
    }
    Object.defineProperty(accessor, 'faultInjector', { enumerable: true, get: () => undefined })
    await expect(openRemoteHostInstallJournal(accessor)).rejects.toMatchObject({ code: 'journal_options_invalid' })

    const symbolInput = {
      journalDirectory: directory,
      identity: identity(),
      [Symbol('extra')]: true,
    }
    await expect(openRemoteHostInstallJournal(symbolInput)).rejects.toMatchObject({ code: 'journal_options_invalid' })

    const journal = await openJournal(directory)
    const planned = (await journal.initialize({ evidenceSha256: null })).record
    await expect(journal.append({
      expectedRevision: planned.revision + 1,
      expectedRecordSha256: planned.recordSha256,
      phase: 'admitted',
      evidenceSha256: digest('1'),
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ name: 'RemoteHostInstallJournalError' })
      expect(String(error)).not.toContain(directory)
      return true
    })
  })

  it('bounds directory enumeration before reading unbounded entries', async () => {
    const directory = await temporaryDirectory()
    for (let revision = 0; revision < 10; revision += 1) {
      await writeFile(join(directory, `r${String(revision).padStart(4, '0')}.json`), '{}\n', { mode: 0o600 })
    }
    await expect(openJournal(directory)).rejects.toMatchObject({ code: 'journal_entry_limit_exceeded' })
  })

  it('keeps the win32 reference fence undeclared and rejects ordinary win32 construction before I/O', async () => {
    const declaration = await readFile('scripts/remote-host-install-journal.d.mts', 'utf8')
    expect(declaration).not.toContain('VITEST_ONLY_WINDOWS_REFERENCE_FENCE')
    expect(declaration).not.toContain('__vitestWindowsReferenceFence')

    if (process.platform !== 'win32') return
    const nonexistent = join(tmpdir(), `prime-journal-must-not-exist-${Date.now()}`)
    await expect(openRemoteHostInstallJournal({
      journalDirectory: nonexistent,
      identity: identity(),
    })).rejects.toMatchObject({ code: 'journal_platform_unsupported' })
    await expect(lstat(nonexistent)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'prime-remote-host-journal-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function openJournal(
  journalDirectory: string,
  extra: Readonly<{ faultInjector?: (point: typeof REMOTE_HOST_INSTALL_JOURNAL_FAULT_POINTS[number]) => void }> = {},
) {
  const options: Record<string, unknown> = {
    journalDirectory,
    identity: identity(),
    ...extra,
  }
  if (process.platform === 'win32') {
    options.__vitestWindowsReferenceFence =
      JournalRuntime.__REMOTE_HOST_INSTALL_VITEST_ONLY_WINDOWS_REFERENCE_FENCE
  }
  return openRemoteHostInstallJournal(options as unknown as Parameters<typeof openRemoteHostInstallJournal>[0])
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    operationId: '123e4567-e89b-42d3-a456-426614174000',
    packageId: 'prime-continuim-remote-host-test',
    manifestSha256: digest('a'),
    trustAnchorId: `ed25519-spki-sha256-${'b'.repeat(64)}`,
    signerKeyId: 'test-only-release-signer',
    targetAuthoritySha256: digest('c'),
    target: { platform: 'linux', arch: 'x64', libc: 'glibc' },
    installMode: 'fresh_install',
    destinationState: 'absent',
    ...overrides,
  } as const
}

function digest(character: string) {
  return character.repeat(64)
}
