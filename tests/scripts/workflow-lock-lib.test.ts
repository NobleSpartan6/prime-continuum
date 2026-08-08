import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireWorkflowLock,
  getWorkflowLockPath,
  WorkflowLockError,
} from '../../scripts/workflow-lock-lib.mjs'

const temporaryDirectories: string[] = []
const childProcesses: ChildProcess[] = []

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('workspace build workflow lock', () => {
  it('rejects a second workflow while the recorded owner process is alive', async () => {
    const fixture = await createFixture()
    const first = await acquireWorkflowLock({
      workflow: 'dev',
      projectRoot: fixture.root,
      lockPath: fixture.lockPath,
      pid: 41_001,
      isProcessAlive: (pid) => pid === 41_001,
    })

    await expect(
      acquireWorkflowLock({
        workflow: 'dist',
        projectRoot: fixture.root,
        lockPath: fixture.lockPath,
        pid: 41_002,
        isProcessAlive: (pid) => pid === 41_001,
      }),
    ).rejects.toEqual(
      expect.objectContaining<WorkflowLockError>({
        name: 'WorkflowLockError',
        message: expect.stringContaining('while "dev" is running'),
        requestedWorkflow: 'dist',
        owner: expect.objectContaining({ workflow: 'dev', pid: 41_001 }),
      }),
    )

    await first.release()
  })

  it('atomically recovers a valid lock whose owner process is gone', async () => {
    const fixture = await createFixture()
    await acquireWorkflowLock({
      workflow: 'dev',
      projectRoot: fixture.root,
      lockPath: fixture.lockPath,
      pid: 51_001,
      isProcessAlive: () => false,
    })

    const replacement = await acquireWorkflowLock({
      workflow: 'package',
      projectRoot: fixture.root,
      lockPath: fixture.lockPath,
      pid: 51_002,
      isProcessAlive: () => false,
    })

    expect(JSON.parse(await readFile(fixture.lockPath, 'utf8'))).toMatchObject({
      workflow: 'package',
      pid: 51_002,
      token: replacement.owner.token,
    })
    await replacement.release()
  })

  it('allows exactly one winner when workflows acquire simultaneously', async () => {
    const fixture = await createFixture()
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        acquireWorkflowLock({
          workflow: `build-${index}`,
          projectRoot: fixture.root,
          lockPath: fixture.lockPath,
          pid: 71_000 + index,
          isProcessAlive: () => true,
        }),
      ),
    )
    const winners = attempts.filter((attempt) => attempt.status === 'fulfilled')
    const conflicts = attempts.filter((attempt) => attempt.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(conflicts).toHaveLength(11)
    for (const conflict of conflicts) {
      if (conflict.status === 'rejected') expect(conflict.reason).toBeInstanceOf(WorkflowLockError)
    }
    if (winners[0]?.status === 'fulfilled') await winners[0].value.release()
  })

  it('allows exactly one winner when concurrent workflows recover the same stale owner', async () => {
    const fixture = await createFixture()
    const stalePid = 72_000
    await acquireWorkflowLock({
      workflow: 'stale-build',
      projectRoot: fixture.root,
      lockPath: fixture.lockPath,
      pid: stalePid,
      isProcessAlive: () => false,
    })

    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        acquireWorkflowLock({
          workflow: `replacement-${index}`,
          projectRoot: fixture.root,
          lockPath: fixture.lockPath,
          pid: 72_100 + index,
          isProcessAlive: (pid) => pid !== stalePid,
        }),
      ),
    )
    const winners = attempts.filter((attempt) => attempt.status === 'fulfilled')
    expect(winners).toHaveLength(1)
    if (winners[0]?.status === 'fulfilled') {
      expect(JSON.parse(await readFile(fixture.lockPath, 'utf8'))).toMatchObject({
        token: winners[0].value.owner.token,
        workflow: winners[0].value.owner.workflow,
      })
      await winners[0].value.release()
    }
  })

  it('fails closed when a previous stale-recovery claim was orphaned', async () => {
    const fixture = await createFixture()
    const staleOwner = {
      schemaVersion: 1,
      token: '11111111-1111-4111-8111-111111111111',
      pid: 73_001,
      workflow: 'dev',
      startedAt: '2026-08-08T12:00:00.000Z',
      projectRoot: fixture.root,
    }
    const recoveryOwner = {
      ...staleOwner,
      token: '22222222-2222-4222-8222-222222222222',
      pid: 73_002,
    }
    const originalBytes = `${JSON.stringify(staleOwner)}\n`
    await writeFile(fixture.lockPath, originalBytes, 'utf8')
    await writeFile(`${fixture.lockPath}.recovery`, `${JSON.stringify(recoveryOwner)}\n`, 'utf8')

    await expect(acquireWorkflowLock({
      workflow: 'dist',
      projectRoot: fixture.root,
      lockPath: fixture.lockPath,
      pid: 73_003,
      isProcessAlive: () => false,
    })).rejects.toThrow(/recovery is incomplete/)
    expect(await readFile(fixture.lockPath, 'utf8')).toBe(originalBytes)
    expect(JSON.parse(await readFile(`${fixture.lockPath}.recovery`, 'utf8'))).toMatchObject(recoveryOwner)
  })

  it('does not remove a lock that was replaced by a different token', async () => {
    const fixture = await createFixture()
    const first = await acquireWorkflowLock({
      workflow: 'build',
      projectRoot: fixture.root,
      lockPath: fixture.lockPath,
      pid: 61_001,
      isProcessAlive: () => true,
    })
    const replacement = {
      ...first.owner,
      token: '11111111-1111-4111-8111-111111111111',
      pid: 61_002,
      workflow: 'dist',
    }
    await writeFile(fixture.lockPath, `${JSON.stringify(replacement)}\n`, 'utf8')

    await first.release()
    expect(JSON.parse(await readFile(fixture.lockPath, 'utf8'))).toMatchObject(replacement)
  })

  it('derives one stable lock path per physical workspace', async () => {
    const fixture = await createFixture()
    const other = join(fixture.root, 'other')
    await mkdir(other)
    expect(getWorkflowLockPath(fixture.root)).toBe(getWorkflowLockPath(join(fixture.root, '.')))
    expect(getWorkflowLockPath(fixture.root)).not.toBe(getWorkflowLockPath(other))
  })

  it.runIf(process.platform === 'win32')('uses one lock through a Windows junction to the same workspace', async () => {
    const fixture = await createFixture()
    const parent = await mkdtemp(join(tmpdir(), 'prime-workflow-junction-test-'))
    temporaryDirectories.push(parent)
    const junction = join(parent, 'workspace-link')
    await symlink(fixture.root, junction, 'junction')
    expect(getWorkflowLockPath(junction)).toBe(getWorkflowLockPath(fixture.root))
  })

  it('does not derive lock authority from process-specific temporary directories', async () => {
    const fixture = await createFixture()
    const originalTemp = process.env.TEMP
    const originalTmp = process.env.TMP
    const first = getWorkflowLockPath(fixture.root)
    try {
      process.env.TEMP = join(fixture.root, 'alternate-temp')
      process.env.TMP = join(fixture.root, 'alternate-tmp')
      expect(getWorkflowLockPath(fixture.root)).toBe(first)
    } finally {
      if (originalTemp === undefined) delete process.env.TEMP
      else process.env.TEMP = originalTemp
      if (originalTmp === undefined) delete process.env.TMP
      else process.env.TMP = originalTmp
    }
  })

  it('recovers automatically after a lock-owning process is terminated', async () => {
    const fixture = await createFixture()
    const libraryUrl = pathToFileURL(resolve('scripts/workflow-lock-lib.mjs')).href
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { acquireWorkflowLock } from ${JSON.stringify(libraryUrl)};
         await acquireWorkflowLock({ workflow: 'dev', projectRoot: ${JSON.stringify(fixture.root)}, lockPath: ${JSON.stringify(fixture.lockPath)} });
         process.stdout.write('READY\\n');
         setInterval(() => undefined, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    childProcesses.push(child)
    await waitForReady(child)
    child.kill()
    await waitForExit(child)

    const replacement = await acquireWorkflowLock({
      workflow: 'dist',
      projectRoot: fixture.root,
      lockPath: fixture.lockPath,
    })
    expect(replacement.owner.workflow).toBe('dist')
    await replacement.release()
  })
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'prime-workflow-lock-test-'))
  temporaryDirectories.push(root)
  return { root, lockPath: join(root, 'workflow.lock') }
}

function waitForReady(child: ChildProcess) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error('Timed out waiting for the lock-holder fixture.')), 10_000)
    child.once('error', rejectPromise)
    child.once('exit', (code) => rejectPromise(new Error(`Lock-holder fixture exited before ready with code ${code}.`)))
    child.stdout?.on('data', (chunk) => {
      if (!String(chunk).includes('READY')) return
      clearTimeout(timeout)
      resolvePromise()
    })
  })
}

function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()))
}
