import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalTemporaryDirectory } from '../helpers/canonical-temp'
import {
  createWorkflowChildLease,
  type WorkflowChildLeasePublicationTestHooks,
} from '../../scripts/workflow-child-lease-lib.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('workflow child lease publication', () => {
  it('retries only the bounded Windows transient sequence and publishes after N failures', async () => {
    const delays: number[] = []
    const transientCodes = ['EPERM', 'EACCES', 'EBUSY']
    let attempts = 0
    const fixture = await createFixture({
      platform: 'win32',
      rename: async (oldPath, newPath) => {
        const code = transientCodes[attempts]
        attempts += 1
        if (code) throw codedError(code)
        await rename(oldPath, newPath)
      },
      wait: async (milliseconds) => { delays.push(milliseconds) },
    })

    await fixture.lease.setChildPid(21_003)

    expect(attempts).toBe(4)
    expect(delays).toEqual([25, 50, 100])
    expect(await readOwner(fixture.childLeasePath)).toMatchObject({
      token: fixture.lease.owner.token,
      childPublication: 'published',
      childPid: 21_003,
    })
    await expectNoReplacement(fixture.root)
  })

  it('recognizes only the exact successor when a Windows rename reports an ambiguous error', async () => {
    const delays: number[] = []
    let attempts = 0
    const fixture = await createFixture({
      platform: 'win32',
      rename: async (oldPath, newPath) => {
        attempts += 1
        await rename(oldPath, newPath)
        throw codedError('EPERM')
      },
      wait: async (milliseconds) => { delays.push(milliseconds) },
    })

    await fixture.lease.setChildPid(22_003)

    expect(attempts).toBe(1)
    expect(delays).toEqual([])
    expect(await readOwner(fixture.childLeasePath)).toMatchObject({
      token: fixture.lease.owner.token,
      childPublication: 'published',
      childPid: 22_003,
    })
    await expectNoReplacement(fixture.root)
  })

  it('spends the fixed budget on transient post-error inspections before retrying rename', async () => {
    const delays: number[] = []
    let attempts = 0
    let inspections = 0
    const fixture = await createFixture({
      platform: 'win32',
      rename: async (oldPath, newPath) => {
        attempts += 1
        if (attempts === 1) throw codedError('EPERM')
        await rename(oldPath, newPath)
      },
      wait: async (milliseconds) => { delays.push(milliseconds) },
      beforeInspection: () => {
        inspections += 1
        if (inspections === 2 || inspections === 3) {
          expect(attempts).toBe(1)
          throw codedError('EACCES')
        }
      },
    })

    await fixture.lease.setChildPid(22_103)

    expect(attempts).toBe(2)
    expect(delays).toEqual([25, 50, 100])
    expect(await readOwner(fixture.childLeasePath)).toMatchObject({
      childPublication: 'published',
      childPid: 22_103,
    })
    await expectNoReplacement(fixture.root)
  })

  it('reconciles a successful rename through transient post-publication inspection errors', async () => {
    const delays: number[] = []
    let attempts = 0
    let inspections = 0
    const fixture = await createFixture({
      platform: 'win32',
      rename: async (oldPath, newPath) => {
        attempts += 1
        await rename(oldPath, newPath)
      },
      wait: async (milliseconds) => { delays.push(milliseconds) },
      beforeInspection: () => {
        inspections += 1
        if (inspections === 2 || inspections === 3) throw codedError('EBUSY')
      },
    })

    await fixture.lease.setChildPid(22_153)

    expect(attempts).toBe(1)
    expect(delays).toEqual([25, 50])
    expect(await readOwner(fixture.childLeasePath)).toMatchObject({
      childPublication: 'published',
      childPid: 22_153,
    })
    await expectNoReplacement(fixture.root)
  })

  it('preserves the original rename error when transient inspection exhausts the budget', async () => {
    const delays: number[] = []
    const originalError = codedError('EPERM')
    let attempts = 0
    let inspections = 0
    const fixture = await createFixture({
      platform: 'win32',
      rename: async () => {
        attempts += 1
        throw originalError
      },
      wait: async (milliseconds) => { delays.push(milliseconds) },
      beforeInspection: () => {
        inspections += 1
        if (inspections > 1) throw codedError('EBUSY')
      },
    })

    await expect(fixture.lease.setChildPid(22_203)).rejects.toBe(originalError)

    expect(attempts).toBe(1)
    expect(delays).toEqual([25, 50, 100, 200, 400, 800])
    expect(await readOwner(fixture.childLeasePath)).toMatchObject({ childPublication: 'pending' })
    await expectNoReplacement(fixture.root)
  })

  it('fails closed without overwriting a mismatched predecessor', async () => {
    const delays: number[] = []
    let attempts = 0
    const fixture = await createFixture({
      platform: 'win32',
      rename: async (_oldPath, newPath) => {
        attempts += 1
        const changed = await readOwner(newPath)
        changed.token = '00000000-0000-4000-8000-000000000000'
        await writeFile(newPath, `${JSON.stringify(changed)}\n`, 'utf8')
        throw codedError('EPERM')
      },
      wait: async (milliseconds) => { delays.push(milliseconds) },
    })

    await expect(fixture.lease.setChildPid(23_003))
      .rejects.toThrow('ownership changed before publication retry')

    expect(attempts).toBe(1)
    expect(delays).toEqual([])
    expect(await readOwner(fixture.childLeasePath)).toMatchObject({
      token: '00000000-0000-4000-8000-000000000000',
      childPublication: 'pending',
    })
    await expectNoReplacement(fixture.root)
  })

  it('preserves the primary publication error and retains a replacement that cleanup cannot prove owned', async () => {
    const fixture = await createFixture({
      platform: 'win32',
      rename: async (oldPath) => {
        const changed = await readOwner(oldPath)
        changed.token = '22222222-2222-4222-8222-222222222222'
        await writeFile(oldPath, `${JSON.stringify(changed)}\n`, 'utf8')
        throw codedError('EPERM')
      },
      wait: async () => undefined,
    })

    let failure: unknown
    try {
      await fixture.lease.setChildPid(23_053)
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      message: 'Workflow child lease ownership changed before publication retry.',
      cause: { code: 'EPERM' },
      publicationCleanupFailure: {
        code: 'UNKNOWN',
        message: 'Workflow child lease replacement cleanup did not complete; the diagnostic file was retained.',
      },
    })
    expect((await readdir(fixture.root)).filter((name) => name.includes('.child.update-'))).toHaveLength(1)
    expect(await readOwner(fixture.childLeasePath)).toMatchObject({
      token: fixture.lease.owner.token,
      childPublication: 'pending',
    })
  })

  it('detects a canonical path swap after the handle read and never retries rename', async () => {
    const delays: number[] = []
    let attempts = 0
    let targetPath: string | undefined
    let swapAfterRead = false
    const fixture = await createFixture({
      platform: 'win32',
      rename: async (_oldPath, newPath) => {
        attempts += 1
        targetPath = newPath
        swapAfterRead = true
        throw codedError('EPERM')
      },
      wait: async (milliseconds) => { delays.push(milliseconds) },
      afterFileRead: async (path) => {
        if (!swapAfterRead || path !== targetPath) return
        swapAfterRead = false
        const changed = await readOwner(path)
        changed.token = '11111111-1111-4111-8111-111111111111'
        await rename(path, `${path}.displaced`)
        await writeFile(path, `${JSON.stringify(changed)}\n`, 'utf8')
      },
    })

    await expect(fixture.lease.setChildPid(23_103))
      .rejects.toThrow('ownership changed before publication retry')

    expect(attempts).toBe(1)
    expect(delays).toEqual([])
    expect(await readOwner(fixture.childLeasePath)).toMatchObject({
      token: '11111111-1111-4111-8111-111111111111',
      childPublication: 'pending',
    })
    await expectNoReplacement(fixture.root)
  })

  it('does not retry a nontransient rename error', async () => {
    const delays: number[] = []
    let attempts = 0
    const fixture = await createFixture({
      platform: 'win32',
      rename: async () => {
        attempts += 1
        throw codedError('EIO')
      },
      wait: async (milliseconds) => { delays.push(milliseconds) },
    })

    await expect(fixture.lease.setChildPid(24_003)).rejects.toMatchObject({ code: 'EIO' })

    expect(attempts).toBe(1)
    expect(delays).toEqual([])
    expect(await readOwner(fixture.childLeasePath)).toMatchObject({
      token: fixture.lease.owner.token,
      childPublication: 'pending',
    })
    await expectNoReplacement(fixture.root)
  })

  it('never retries a transient Windows code on a non-Windows platform', async () => {
    const delays: number[] = []
    let attempts = 0
    const fixture = await createFixture({
      platform: 'linux',
      rename: async () => {
        attempts += 1
        throw codedError('EPERM')
      },
      wait: async (milliseconds) => { delays.push(milliseconds) },
    })

    await expect(fixture.lease.setChildPid(24_103)).rejects.toMatchObject({ code: 'EPERM' })

    expect(attempts).toBe(1)
    expect(delays).toEqual([])
    expect(await readOwner(fixture.childLeasePath)).toMatchObject({
      token: fixture.lease.owner.token,
      childPublication: 'pending',
    })
    await expectNoReplacement(fixture.root)
  })

  it('exhausts the exact fixed schedule and leaves the predecessor unpublished', async () => {
    const delays: number[] = []
    let attempts = 0
    const fixture = await createFixture({
      platform: 'win32',
      rename: async () => {
        attempts += 1
        throw codedError('EPERM')
      },
      wait: async (milliseconds) => { delays.push(milliseconds) },
    })

    await expect(fixture.lease.setChildPid(25_003)).rejects.toMatchObject({ code: 'EPERM' })

    expect(attempts).toBe(7)
    expect(delays).toEqual([25, 50, 100, 200, 400, 800])
    expect(await readOwner(fixture.childLeasePath)).toMatchObject({
      token: fixture.lease.owner.token,
      childPublication: 'pending',
    })
    await expectNoReplacement(fixture.root)
  })
})

async function createFixture(publicationTestHooks: WorkflowChildLeasePublicationTestHooks) {
  const root = await canonicalTemporaryDirectory('prime-workflow-child-publication-')
  temporaryDirectories.push(root)
  const lockPath = join(root, 'workflow.lock')
  const childLeasePath = `${lockPath}.child`
  const lease = await createWorkflowChildLease({
    lockPath,
    workflow: 'test-publication',
    lockToken: 'test-lock-token',
    parentPid: 20_001,
    supervisorPid: 20_002,
    publicationTestHooks,
  })
  return { root, childLeasePath, lease }
}

async function readOwner(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

async function expectNoReplacement(root: string): Promise<void> {
  expect((await readdir(root)).filter((name) => name.includes('.child.update-'))).toEqual([])
}

function codedError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}
