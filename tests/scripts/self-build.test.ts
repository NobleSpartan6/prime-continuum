import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalTemporaryDirectory } from '../helpers/canonical-temp'
import {
  assertMaterializedContentEqual,
  captureGitCandidate,
  canonicalJson,
  cleanupEvaluationWorktree,
  createReceiptEnvelope,
  createSelfBuildCommandPlan,
  createSelfBuildEnvironment,
  describeToolchainSentinelMetadata,
  materializeEvaluationNodeRuntimeDependency,
  materializeGitCandidate,
  requireCoordinatorRunId,
  runCommandSequence,
  selfBuildWorkflowName,
  verifyReceiptFile,
  writeReceiptEnvelope,
} from '../../scripts/self-build-lib.mjs'
import { createWorkflowChildLease } from '../../scripts/workflow-child-lease-lib.mjs'
import { acquireWorkflowLock, WorkflowLockError } from '../../scripts/workflow-lock-lib.mjs'
import { runSupervisedWorkflowStep } from '../../scripts/workflow-supervised-step-lib.mjs'

const temporaryDirectories: string[] = []
const WINDOWS_TIMEOUT_FIXTURE_TEARDOWN_MS = 30_000

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })))
})

describe('Prime Continuim self-build evidence', () => {
  it('correlates coordinator runs through one exact top-level workflow identity', () => {
    const runId = '12345678-1234-4123-8123-123456789abc'
    expect(requireCoordinatorRunId(runId.toUpperCase())).toBe(runId)
    expect(selfBuildWorkflowName(runId)).toBe(`self-build:${runId}`)
    expect(selfBuildWorkflowName()).toBe('self-build')
    expect(() => requireCoordinatorRunId('../receipt-private')).toThrow(/canonical UUID/)
    expect(() => selfBuildWorkflowName('12345678-1234-0123-8123-123456789abc')).toThrow(/canonical UUID/)
  })

  it('fences physical directory identity without treating pnpm index churn as tool replacement', () => {
    const directory = {
      isDirectory: () => true,
      isFile: () => false,
      size: 0,
      mtimeMs: 1,
      ctimeMs: 2,
      dev: 3,
      ino: 4,
    }
    expect(describeToolchainSentinelMetadata({
      ...directory,
      size: 8192,
      mtimeMs: 500,
      ctimeMs: 600,
    })).toEqual(describeToolchainSentinelMetadata(directory))
    expect(describeToolchainSentinelMetadata({ ...directory, ino: 5 }))
      .not.toEqual(describeToolchainSentinelMetadata(directory))

    const file = { ...directory, isDirectory: () => false, isFile: () => true }
    expect(describeToolchainSentinelMetadata({ ...file, ctimeMs: 600 }))
      .toEqual(describeToolchainSentinelMetadata(file))
    expect(describeToolchainSentinelMetadata({ ...file, mtimeMs: 500 }))
      .not.toEqual(describeToolchainSentinelMetadata(file))
    expect(describeToolchainSentinelMetadata({ ...file, ino: 5 }))
      .not.toEqual(describeToolchainSentinelMetadata(file))
  })

  it('validates and copies pnpm synthetic Node runtime bytes into the evaluation', async () => {
    const root = await temporaryDirectory('prime-self-build-node-runtime-')
    const evaluationRoot = join(root, 'evaluation')
    const store = join(root, 'store')
    const source = join(store, 'v11', 'links', 'node-runtime')
    const runtimeLink = join(evaluationRoot, 'node_modules', 'node')
    const executable = Buffer.from('exact pinned node executable')
    const executablePath = process.platform === 'win32' ? 'node.exe' : 'bin/node'
    await mkdir(source, { recursive: true })
    await mkdir(join(evaluationRoot, 'node_modules'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'node',
      version: '24.14.0',
      bin: { node: executablePath },
    }))
    await mkdir(join(source, 'bin'), { recursive: true })
    await writeFile(join(source, executablePath), executable)
    await writeFile(join(source, 'README.md'), 'runtime package\n')
    await symlink(source, runtimeLink, process.platform === 'win32' ? 'junction' : 'dir')

    await materializeEvaluationNodeRuntimeDependency(evaluationRoot, {
      node: {
        version: 'v24.14.0',
        executableSha256: createHash('sha256').update(executable).digest('hex'),
      },
      pnpm: { absoluteStore: store },
    })

    expect(await readFile(join(runtimeLink, executablePath))).toEqual(executable)
    await writeFile(join(source, executablePath), 'changed after copy')
    expect(await readFile(join(runtimeLink, executablePath))).toEqual(executable)
  })

  it('rejects a synthetic Node runtime link outside the bound store', async () => {
    const root = await temporaryDirectory('prime-self-build-node-runtime-reject-')
    const evaluationRoot = join(root, 'evaluation')
    const store = join(root, 'store')
    const outside = join(root, 'outside')
    const runtimeLink = join(evaluationRoot, 'node_modules', 'node')
    await mkdir(store, { recursive: true })
    await mkdir(outside, { recursive: true })
    await mkdir(join(evaluationRoot, 'node_modules'), { recursive: true })
    await symlink(outside, runtimeLink, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(materializeEvaluationNodeRuntimeDependency(evaluationRoot, {
      node: { version: 'v24.14.0', executableSha256: '0'.repeat(64) },
      pnpm: { absoluteStore: store },
    })).rejects.toThrow(/outside the bound content store/)
  })

  it('binds HEAD, a dirty binary patch, untracked bytes, and the materialized candidate tree', async () => {
    const root = await createGitFixture()
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    await writeFile(join(root, 'deleted.txt'), 'delete me\n', 'utf8')
    await writeFile(join(root, 'renamed-before.txt'), 'rename me\n', 'utf8')
    git(root, ['add', 'binary.bin', 'deleted.txt', 'renamed-before.txt'])
    git(root, ['commit', '-m', 'binary fixture'])
    const clean = await captureGitCandidate(root)
    await writeFile(join(root, 'tracked.txt'), 'changed\n', 'utf8')
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 255, 4, 0, 5]))
    await rm(join(root, 'deleted.txt'))
    git(root, ['mv', 'renamed-before.txt', 'renamed-after.txt'])
    await writeFile(join(root, 'untracked.txt'), 'new candidate bytes\n', 'utf8')
    await writeFile(join(root, 'ignored.secret'), 'must not enter candidate\n', 'utf8')
    await writeFile(join(root, '.gitignore'), '.prime-continuim-self-build/\nignored.secret\n', 'utf8')

    const dirty = await captureGitCandidate(root)
    expect(dirty.headCommit).toBe(clean.headCommit)
    expect(dirty.dirty).toBe(true)
    expect(dirty.binaryPatchSha256).not.toBe(clean.binaryPatchSha256)
    expect(dirty.untrackedManifestSha256).not.toBe(clean.untrackedManifestSha256)
    expect(dirty.treeSha256).not.toBe(clean.treeSha256)
    expect(dirty.untrackedFileCount).toBe(1)
    expect(dirty.paths).not.toContain('ignored.secret')

    const evaluationRoot = join(root, '.prime-continuim-self-build', 'evaluations', 'identity-test')
    await materializeGitCandidate({ sourceRoot: root, evaluationRoot, candidate: dirty })
    const materializedCandidate = await captureGitCandidate(evaluationRoot)
    expect(materializedCandidate.binaryPatchSha256).not.toBe(dirty.binaryPatchSha256)
    expect(() => assertMaterializedContentEqual(
      dirty,
      materializedCandidate,
      'materialized bytes changed',
    )).not.toThrow()
    expect(await readFile(join(evaluationRoot, 'tracked.txt'), 'utf8')).toBe('changed\n')
    expect(await readFile(join(evaluationRoot, 'untracked.txt'), 'utf8')).toBe('new candidate bytes\n')
    expect(await readFile(join(evaluationRoot, 'binary.bin'))).toEqual(Buffer.from([0, 255, 4, 0, 5]))
    expect(await readFile(join(evaluationRoot, 'renamed-after.txt'), 'utf8')).toBe('rename me\n')
    await expect(readFile(join(evaluationRoot, 'deleted.txt'))).rejects.toThrow()
    await expect(readFile(join(evaluationRoot, 'ignored.secret'))).rejects.toThrow()
    await writeFile(join(evaluationRoot, 'tracked.txt'), 'changed after materialization\n')
    const changedCandidate = await captureGitCandidate(evaluationRoot)
    expect(() => assertMaterializedContentEqual(
      dirty,
      changedCandidate,
      'materialized bytes changed',
    )).toThrow('materialized bytes changed')
    await cleanupEvaluationWorktree({ projectRoot: root, evaluationRoot })
    await expect(readFile(join(evaluationRoot, 'tracked.txt'), 'utf8')).rejects.toThrow()
  })

  it('rejects a tracked path beneath a junction before outside bytes can enter the candidate', async () => {
    const root = await createGitFixture()
    const outside = await temporaryDirectory('prime-self-build-outside-')
    await mkdir(join(root, 'a'))
    await writeFile(join(root, 'a', 'file.txt'), 'inside bytes\n', 'utf8')
    git(root, ['add', 'a/file.txt'])
    git(root, ['commit', '-m', 'nested fixture'])
    await writeFile(join(outside, 'file.txt'), 'PRIVATE OUTSIDE BYTES\n', 'utf8')
    await rm(join(root, 'a'), { recursive: true, force: true })
    await symlink(outside, join(root, 'a'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(captureGitCandidate(root)).rejects.toThrow(/linked|reparse/i)
    expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('PRIVATE OUTSIDE BYTES\n')
  })

  it('rechecks source ancestors during materialization and never writes through a new junction', async () => {
    const root = await createGitFixture()
    const outside = await temporaryDirectory('prime-self-build-materialize-outside-')
    await mkdir(join(root, 'a'))
    await writeFile(join(root, 'a', 'file.txt'), 'captured bytes\n', 'utf8')
    git(root, ['add', 'a/file.txt'])
    git(root, ['commit', '-m', 'nested fixture'])
    const candidate = await captureGitCandidate(root)
    await writeFile(join(outside, 'file.txt'), 'OUTSIDE SENTINEL\n', 'utf8')
    await rm(join(root, 'a'), { recursive: true, force: true })
    await symlink(outside, join(root, 'a'), process.platform === 'win32' ? 'junction' : 'dir')
    const evaluationRoot = join(root, '.prime-continuim-self-build', 'evaluations', 'junction-test')
    try {
      await expect(materializeGitCandidate({ sourceRoot: root, evaluationRoot, candidate })).rejects.toThrow(/linked|reparse/i)
      expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('OUTSIDE SENTINEL\n')
    } finally {
      await cleanupEvaluationWorktree({ projectRoot: root, evaluationRoot })
    }
  })

  it('materializes with no checkout and cannot run a repository post-checkout hook', async () => {
    const root = await createGitFixture()
    const sentinel = join(await temporaryDirectory('prime-self-build-hook-outside-'), 'hook-ran.txt')
    const hook = join(root, '.git', 'hooks', 'post-checkout')
    const shellSentinel = sentinel.replace(/\\/g, '/').replace(/'/g, `'"'"'`)
    await writeFile(hook, `#!/bin/sh\nprintf hook-ran > '${shellSentinel}'\n`, 'utf8')
    await chmod(hook, 0o755)
    const candidate = await captureGitCandidate(root)
    const evaluationRoot = join(root, '.prime-continuim-self-build', 'evaluations', 'hook-test')
    try {
      await materializeGitCandidate({ sourceRoot: root, evaluationRoot, candidate })
      await expect(readFile(sentinel, 'utf8')).rejects.toThrow()
    } finally {
      await cleanupEvaluationWorktree({ projectRoot: root, evaluationRoot })
    }
  })

  it('removes a stale linked-worktree registration even when its directory is already absent', async () => {
    const root = await createGitFixture()
    const candidate = await captureGitCandidate(root)
    const evaluationRoot = join(root, '.prime-continuim-self-build', 'evaluations', 'registry-only')
    await materializeGitCandidate({ sourceRoot: root, evaluationRoot, candidate })
    await rm(evaluationRoot, { recursive: true, force: true })
    expect(gitOutput(root, ['worktree', 'list', '--porcelain'])).toContain(evaluationRoot.replaceAll('\\', '/'))
    await cleanupEvaluationWorktree({ projectRoot: root, evaluationRoot })
    expect(gitOutput(root, ['worktree', 'list', '--porcelain'])).not.toContain(evaluationRoot.replaceAll('\\', '/'))
  })

  it.runIf(process.platform !== 'win32')('rejects a leaf symlink as an unbound external input', async () => {
    const root = await createGitFixture()
    const outside = await temporaryDirectory('prime-self-build-leaf-outside-')
    await writeFile(join(outside, 'private.txt'), 'private\n', 'utf8')
    await symlink(join(outside, 'private.txt'), join(root, 'leaf-link'))
    await expect(captureGitCandidate(root)).rejects.toThrow(/links and special files/i)
  })

  it('excludes self-build, workflow, dependency, output, and log data independently of .gitignore', async () => {
    const root = await createGitFixture()
    await writeFile(join(root, '.gitignore'), '', 'utf8')
    const beforePrivateState = await captureGitCandidate(root)
    await writeFile(join(root, '.prime-continuim-workflow.lock-private'), 'PRIVATE LOCK TOKEN AND PATH\n', 'utf8')
    await mkdir(join(root, '.prime-continuim-self-build', 'receipts'), { recursive: true })
    await writeFile(join(root, '.prime-continuim-self-build', 'receipts', 'private.json'), 'PRIVATE RECEIPT\n', 'utf8')
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'private.js'), 'PRIVATE DEPENDENCY\n', 'utf8')
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(join(root, 'out', 'private.bin'), 'PRIVATE OUTPUT\n', 'utf8')
    await writeFile(join(root, 'diagnostic.log'), 'PRIVATE LOG\n', 'utf8')
    await writeFile(join(root, '.env.local'), 'PRIVATE_ENV_TOKEN=secret\n', 'utf8')
    await writeFile(join(root, '.npmrc'), '//registry.example.invalid/:_authToken=secret\n', 'utf8')
    if (process.platform === 'win32') {
      await mkdir(join(root, 'Out'), { recursive: true })
      await writeFile(join(root, 'Out', 'private-case.bin'), 'PRIVATE CASE OUTPUT\n', 'utf8')
    }

    const candidate = await captureGitCandidate(root)
    expect(candidate.paths).toEqual(['.gitignore', 'tracked.txt'])
    expect(candidate.untracked).toEqual([])
    expect(candidate.untrackedFileCount).toBe(0)
    expect(candidate.statusPorcelainV2Sha256).toBe(beforePrivateState.statusPorcelainV2Sha256)
    expect(candidate.binaryPatchSha256).toBe(beforePrivateState.binaryPatchSha256)
    expect(candidate.untrackedManifestSha256).toBe(beforePrivateState.untrackedManifestSha256)
    expect(candidate.treeSha256).toBe(beforePrivateState.treeSha256)
  })

  it('stops at the first failed command and records the exact exit result', async () => {
    const calls: string[] = []
    const commands = [fixtureCommand('typecheck'), fixtureCommand('test')]
    const result = await runCommandSequence({
      commands,
      workflow: 'self-build',
      lock: { path: 'lock', owner: { token: 'token' } },
      runStep: async ({ step }: { step: { args: string[] } }) => {
        calls.push(step.args[0]!)
        return { code: 7, signal: null, timedOut: false, supervisorExitedWithoutChildConfirmation: false }
      },
    }) as { passed: boolean; results: Array<{ code: number | null; command: { args: string[] } }> }

    expect(result.passed).toBe(false)
    expect(calls).toEqual(['typecheck'])
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({ code: 7, command: { args: ['typecheck'] } })
  })

  it('uses a bounded injection-resistant gate environment and forces an eval-local copied dependency tree', () => {
    const environment = createSelfBuildEnvironment({
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      NODE_OPTIONS: '--require C:\\private\\inject.cjs',
      NODE_PATH: 'C:\\private\\modules',
      ELECTRON_RUN_AS_NODE: '1',
      npm_config_modules_dir: '..\\node_modules',
      VITE_PRIVATE_TOKEN: 'secret',
    })
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
    expect(environment).not.toHaveProperty('NODE_PATH')
    expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(environment).not.toHaveProperty('npm_config_modules_dir')
    expect(environment).not.toHaveProperty('VITE_PRIVATE_TOKEN')
    expect(environment).toMatchObject({
      CI: '1',
      npm_config_offline: 'true',
      COREPACK_ENABLE_NETWORK: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    })

    const plan = createSelfBuildCommandPlan({
      root: process.cwd(),
      evaluationRoot: process.cwd(),
      toolchain: {
        node: { absoluteExecutable: process.execPath },
        pnpm: { absoluteCli: process.execPath, absoluteStore: 'C:\\bounded-store' },
        electron: { absoluteExecutable: 'C:\\electron\\electron.exe' },
        runtimeSeed: { absoluteRoot: 'C:\\runtime-seed' },
      },
      stepTimeoutMs: 1_000,
    }) as Array<{ label: string; args: string[] }>
    expect(plan).toHaveLength(6)
    expect(plan[0]!.args).toEqual(expect.arrayContaining([
      '--offline', '--frozen-lockfile', '--ignore-scripts', '--verify-store-integrity', '--package-import-method', 'copy',
      '--modules-dir', 'node_modules', '--virtual-store-dir', 'node_modules/.pnpm',
    ]))
    expect(plan[4]!.args.slice(1)).toEqual([
      'run', 'build:release',
      '--runtime-root', 'C:\\runtime-seed',
      '--electron', 'C:\\electron\\electron.exe',
    ])
    expect(plan[4]!.args).not.toContain('--')
    expect(plan.map((step) => step.label)).toEqual([
      'Install exact dependencies from the local pnpm store',
      'Typecheck the candidate',
      'Run the candidate test suite',
      'Verify the prebuilt Prime Agent runtime input before build',
      'Build the attested release candidate',
      'Reverify the prebuilt Prime Agent runtime input',
    ])
  })

  it('never writes an injected absolute supervisor path into command evidence', async () => {
    const result = await runCommandSequence({
      commands: [fixtureCommand('failure')],
      workflow: 'self-build',
      lock: { path: 'lock', owner: { token: 'token' } },
      runStep: async () => { throw new Error('spawn C:\\Users\\private-owner\\secret-tool.exe ENOENT') },
    }) as unknown as { results: Array<{ supervisorError: string }> }
    expect(result.results[0]!.supervisorError).toBe('workflow_supervisor_failed')
    expect(JSON.stringify(result)).not.toContain('private-owner')
  })

  it('times out a command, kills its descendant tree, and releases the durable child lease', async () => {
    const root = await temporaryDirectory('prime-self-build-timeout-')
    const pidFile = join(root, 'pids.json')
    const grandchild = join(root, 'grandchild.cjs')
    const child = join(root, 'child.cjs')
    await writeFile(grandchild, 'setInterval(() => undefined, 1000)\n', 'utf8')
    await writeFile(child, `const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const grandchild = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }))
setInterval(() => undefined, 1000)
`, 'utf8')
    const lockPath = join(root, 'workflow.lock')
    const lock = await acquireWorkflowLock({ workflow: 'self-build', projectRoot: root, lockPath })
    try {
      const result = await runCommandSequence({
        commands: [{
          label: 'timeout fixture',
          executable: process.execPath,
          args: [child],
          cwd: root,
          environment: process.env,
          timeoutMs: 500,
        }],
        workflow: 'self-build',
        lock,
        // The supervisor starts the command deadline after setChildPid()
        // resolves. Retain the real durable lease, but hold that boundary until
        // the fixture has published both descendant identities. This proves a
        // 500ms execution timeout instead of racing Windows process startup.
        runStep: (options: Parameters<typeof runSupervisedWorkflowStep>[0]) => runSupervisedWorkflowStep({
          ...options,
          // A saturated hosted Windows runner can deliver the Job completion
          // message before its Node supervisor receives enough CPU to exit.
          // Keep the real 500ms command deadline above; only give this fixture
          // longer to observe the already-requested process-tree teardown.
          teardownTimeoutMs: process.platform === 'win32'
            ? WINDOWS_TIMEOUT_FIXTURE_TEARDOWN_MS
            : undefined,
          createLease: async (leaseOptions: Parameters<typeof createWorkflowChildLease>[0]) => {
            const lease = await createWorkflowChildLease(leaseOptions)
            return {
              ...lease,
              async setChildPid(childPid: number) {
                await lease.setChildPid(childPid)
                await waitForReadableFile(pidFile)
              },
            }
          },
        }),
      }) as { passed: boolean; results: Array<{ timedOut: boolean }> }
      expect(result).toMatchObject({ passed: false, results: [{ timedOut: true }] })
      const pids = JSON.parse(await readFile(pidFile, 'utf8')) as { child: number; grandchild: number }
      await waitForProcessesToExit([pids.child, pids.grandchild])
      await expect(readFile(`${lockPath}.child`, 'utf8')).rejects.toThrow()
    } finally {
      await lock.release()
    }
  }, 45_000)

  it('detects receipt tampering and never overwrites an existing no-replace receipt', async () => {
    const root = await temporaryDirectory('prime-self-build-receipt-')
    const envelope = createReceiptEnvelope(fixtureReceipt())
    const path = await writeReceiptEnvelope(root, envelope)
    const verified = await verifyReceiptFile(path)
    expect(verified.receiptSha256).toBe(envelope.receiptSha256)
    await expect(writeReceiptEnvelope(root, envelope)).rejects.toMatchObject({ code: 'EEXIST' })

    if (process.platform !== 'win32') await chmod(path, 0o600)
    const changed = JSON.parse(await readFile(path, 'utf8')) as { receipt: { failure: { message: string } } }
    changed.receipt.failure.message = 'changed failure evidence'
    await writeFile(path, `${JSON.stringify(changed)}\n`, 'utf8')
    await expect(verifyReceiptFile(path)).rejects.toThrow(/changed or corrupted/)
  })

  it('rejects recomputed receipts with unbounded toolchain subrecords', async () => {
    const root = await temporaryDirectory('prime-self-build-schema-')
    const receipt = fixtureReceipt()
    const toolchain = fixtureToolchain()
    receipt.toolchain = {
      ...toolchain,
      node: { ...toolchain.node, unexpected: 'candidate-controlled' },
    } as never
    await expect(writeReceiptEnvelope(root, createReceiptEnvelope(receipt)))
      .rejects.toThrow(/toolchain.node has unexpected fields/)
  })

  it('requires exact successful gates, cleanup, and final toolchain fencing for a passing receipt', async () => {
    const validRoot = await temporaryDirectory('prime-self-build-pass-valid-')
    const validReceipt = fixturePassingReceipt()
    await expect(writeReceiptEnvelope(validRoot, createReceiptEnvelope(validReceipt))).resolves.toEqual(expect.any(String))

    const unchangedRoot = await temporaryDirectory('prime-self-build-pass-toolchain-')
    const changedToolchain = fixturePassingReceipt()
    changedToolchain.evaluation.toolchainUnchanged = false
    await expect(writeReceiptEnvelope(unchangedRoot, createReceiptEnvelope(changedToolchain)))
      .rejects.toThrow(/unchanged toolchain/)

    const retainedRoot = await temporaryDirectory('prime-self-build-pass-retained-')
    const retainedFixture = fixturePassingReceipt()
    const retained = {
      ...retainedFixture,
      evaluation: {
        ...retainedFixture.evaluation,
        cleanupState: 'retained',
        worktreeRelativePath: '.prime-continuim-self-build/evaluations/11111111-1111-4111-8111-111111111111',
      },
    }
    await expect(writeReceiptEnvelope(retainedRoot, createReceiptEnvelope(retained)))
      .rejects.toThrow(/confirm worktree cleanup/)

    const failedGateRoot = await temporaryDirectory('prime-self-build-pass-gate-')
    const failedGate = fixturePassingReceipt()
    failedGate.evaluation.commands[2]!.code = 1
    await expect(writeReceiptEnvelope(failedGateRoot, createReceiptEnvelope(failedGate)))
      .rejects.toThrow(/unsuccessful command record/)
  })

  it('rejects a concurrent self-build through the shared workspace workflow lock', async () => {
    const root = await temporaryDirectory('prime-self-build-lock-')
    const lockPath = join(root, 'workflow.lock')
    const first = await acquireWorkflowLock({ workflow: 'self-build', projectRoot: root, lockPath })
    try {
      await expect(acquireWorkflowLock({ workflow: 'self-build', projectRoot: root, lockPath }))
        .rejects.toBeInstanceOf(WorkflowLockError)
    } finally {
      await first.release()
    }
  })
})

async function createGitFixture() {
  const root = await temporaryDirectory('prime-self-build-git-')
  await writeFile(join(root, '.gitignore'), '.prime-continuim-self-build/\n', 'utf8')
  await writeFile(join(root, 'tracked.txt'), 'original\n', 'utf8')
  git(root, ['init'])
  git(root, ['config', 'user.email', 'self-build-test@example.invalid'])
  git(root, ['config', 'user.name', 'Self Build Test'])
  git(root, ['add', '.gitignore', 'tracked.txt'])
  git(root, ['commit', '-m', 'fixture'])
  return root
}

async function temporaryDirectory(prefix: string) {
  const path = await canonicalTemporaryDirectory(prefix)
  temporaryDirectories.push(path)
  return path
}

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
}

function gitOutput(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.replaceAll('\\', '/')
}

function fixtureCommand(label: string) {
  return {
    label,
    executable: process.execPath,
    args: [label],
    cwd: process.cwd(),
    environment: process.env,
    timeoutMs: 1_000,
  }
}

function fixtureReceipt() {
  return {
    schemaVersion: 1,
    kind: 'prime_continuim_self_build_evidence',
    runId: '11111111-1111-4111-8111-111111111111',
    startedAt: '2026-08-08T12:00:00.000Z',
    completedAt: '2026-08-08T12:01:00.000Z',
    outcome: 'failed',
    source: null,
    toolchain: null,
    evaluation: {
      isolation: 'detached-temporary-git-worktree',
      dependencyInstall: 'fixture install',
      cleanupState: 'not-created',
      worktreeRelativePath: null,
      toolchainFence: 'per-step-metadata-and-final-content',
      toolchainUnchanged: true,
      commands: [],
    },
    artifacts: null,
    failure: { stage: 'fixture', name: 'Error', message: 'fixture failure' },
    boundary: {
      securitySandbox: false,
      autonomousPromotion: false,
      providerBackedEvaluation: false,
      packageOrInstallerGate: false,
      candidateControlledEvaluation: true,
      mainFilesystemIsolation: false,
    },
  }
}

function fixtureToolchain() {
  const digest = '0'.repeat(64)
  return {
    node: { version: 'v24.0.0', modulesAbi: '137', platform: 'win32', arch: 'x64', executableSha256: digest },
    pnpm: { version: '11.9.0', cliSha256: digest, storePathSha256: digest },
    git: { version: 'git version 2.50.1.windows.1', executableSha256: digest },
    electron: {
      version: '37.0.0',
      executableSha256: digest,
      distributionSha256: digest,
      distributionFileCount: 1,
      distributionBytes: 1,
    },
    runtimeSeed: {
      releaseVersion: '0.7.0',
      platform: 'win32',
      arch: 'x64',
      pointerSha256: digest,
      manifestSha256: digest,
      treeSha256: digest,
      payloadSha256: digest,
      payloadFileCount: 1,
      payloadBytes: 1,
    },
    environment: {
      policy: 'prime-continuim-self-build-environment-v1',
      names: ['CI'],
      valuesSha256: digest,
    },
  }
}

function fixturePassingReceipt() {
  const digest = '0'.repeat(64)
  const labels = [
    'Install exact dependencies from the local pnpm store',
    'Typecheck the candidate',
    'Run the candidate test suite',
    'Verify the prebuilt Prime Agent runtime input before build',
    'Build the attested release candidate',
    'Reverify the prebuilt Prime Agent runtime input',
  ]
  const roots = ['out/main', 'out/preload', 'out/renderer', 'out/hostd'].map((path) => ({
    path,
    treeSha256: digest,
    fileCount: 1,
    totalBytes: 1,
  }))
  return {
    ...fixtureReceipt(),
    outcome: 'passed',
    source: {
      headCommit: '1'.repeat(40),
      dirty: true,
      statusPorcelainV2Sha256: digest,
      statusBytes: 1,
      binaryPatchSha256: digest,
      binaryPatchBytes: 1,
      untrackedManifestSha256: digest,
      untrackedFileCount: 1,
      untrackedBytes: 1,
      treeSha256: digest,
      treeFileCount: 1,
      treeBytes: 1,
    },
    toolchain: fixtureToolchain(),
    evaluation: {
      isolation: 'detached-temporary-git-worktree',
      dependencyInstall: 'fixture install',
      cleanupState: 'removed',
      worktreeRelativePath: null,
      toolchainFence: 'per-step-metadata-and-final-content',
      toolchainUnchanged: true,
      commands: labels.map((label) => ({
        label,
        command: { executable: 'node.exe', args: [] },
        timeoutMs: 1_000,
        durationMs: 1,
        code: 0,
        signal: null,
        timedOut: false,
        supervisorError: null,
        collateralState: 'supervised_tree_settled',
      })),
    },
    artifacts: {
      roots,
      aggregateSha256: createHash('sha256').update(canonicalJson(roots)).digest('hex'),
      fileCount: 4,
      totalBytes: 4,
    },
    failure: null,
  }
}

async function waitForProcessesToExit(pids: number[]) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline && pids.some(isProcessAlive)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  expect(pids.filter(isProcessAlive)).toEqual([])
}

async function waitForReadableFile(path: string) {
  const deadline = Date.now() + 5_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await readFile(path)
      return
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('The timeout fixture did not publish its descendant identities.', { cause: lastError })
}

function isProcessAlive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}
