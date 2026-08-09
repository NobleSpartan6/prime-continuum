import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { assertPinnedDevelopmentNodeRuntime, readPinnedDevelopmentPnpmVersion } from './development-node-runtime.mjs'
import { canonicalJson, createSelfBuildEnvironment, verifyReceiptEnvelope } from './self-build-evidence-lib.mjs'
import { rejectActiveWorkflowChild } from './workflow-child-lease-lib.mjs'
import { acquireWorkflowLock, getWorkflowLockPath } from './workflow-lock-lib.mjs'
import { runSupervisedWorkflowStep } from './workflow-supervised-step-lib.mjs'

export { canonicalJson, createSelfBuildEnvironment, verifyReceiptEnvelope } from './self-build-evidence-lib.mjs'

const RECEIPT_KIND = 'prime_continuim_self_build_evidence'
const INTEGRITY_CLAIM = 'sha256-correlation-only-not-authentication'
const MAX_RECEIPT_BYTES = 512 * 1024
const MAX_RECEIPT_COUNT = 256
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024
const MAX_STATUS_BYTES = 16 * 1024 * 1024
const MAX_SOURCE_FILES = 20_000
const MAX_SOURCE_BYTES = 512 * 1024 * 1024
const MAX_UNTRACKED_FILES = 2_000
const MAX_UNTRACKED_BYTES = 128 * 1024 * 1024
const MAX_ARTIFACT_FILES = 50_000
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024
const DEFAULT_STEP_TIMEOUT_MS = 20 * 60 * 1000
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const SHA256 = /^[a-f0-9]{64}$/
const GENERATED_ROOTS = new Set([
  '.prime-continuim-self-build',
  'node_modules',
  'out',
  'dist',
  'release',
  'coverage',
  '.vite',
  'prime-agent-data',
])
const GENERATED_PATHSPEC_EXCLUSIONS = [
  ':(exclude).git',
  ':(exclude).git/**',
  ':(exclude).prime-continuim-workflow.lock*',
  ...[...GENERATED_ROOTS].flatMap((root) => [`:(exclude)${root}`, `:(exclude)${root}/**`]),
  ':(exclude,glob)**/*.log',
  ':(exclude,glob)**/*.tsbuildinfo',
  ':(exclude,glob)**/.DS_Store',
  ':(exclude,glob)**/Thumbs.db',
  ':(exclude,glob)**/.npmrc',
  ':(exclude,glob)**/.pnpmfile.cjs',
  ':(exclude,glob)**/.pnpmfile.js',
  ':(exclude,glob)**/.env*',
  ':(exclude,glob)**/*.env',
]
const SELF_BUILD_ENVIRONMENT_POLICY = 'prime-continuim-self-build-environment-v1'

export class SelfBuildFailure extends Error {
  constructor(message, { receiptPath, receiptSha256, stage, cause } = {}) {
    super(message, { cause })
    this.name = 'SelfBuildFailure'
    this.receiptPath = receiptPath
    this.receiptSha256 = receiptSha256
    this.stage = stage
  }
}

export async function runSelfBuild({
  projectRoot = resolve(import.meta.dirname, '..'),
  retainFailedWorktree = false,
  coordinatorRunId,
  stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  now = () => new Date(),
  runStep = runSupervisedWorkflowStep,
} = {}) {
  const requestedRoot = await realpath(resolve(projectRoot))
  assertPinnedDevelopmentNodeRuntime({ projectRoot: requestedRoot })
  assertPositiveInteger(stepTimeoutMs, 'stepTimeoutMs')
  const runId = coordinatorRunId === undefined ? randomUUID() : requireCoordinatorRunId(coordinatorRunId)
  // A coordinator-supplied identity is also written into the durable main
  // workflow lock. Unlike the per-gate child lease, that lock covers capture,
  // materialization, artifact digesting, and receipt publication. Recovery can
  // therefore distinguish this exact live top-level evaluation from an
  // unrelated manual self-build. Lock absence and elapsed time are never, by
  // themselves, proof that the exact invocation tree retired.
  const workflow = selfBuildWorkflowName(coordinatorRunId === undefined ? undefined : runId)
  const lock = await acquireWorkflowLock({ workflow, projectRoot: requestedRoot })
  let toolchain
  let toolchainSentinel
  let gitExecutable
  let root
  try {
    await rejectActiveWorkflowChild({
      lockPath: getWorkflowLockPath(requestedRoot),
      lockToken: lock.owner.token,
      workflow,
    })
    toolchain = await inspectToolchain(requestedRoot)
    toolchainSentinel = await inspectToolchainMetadataSentinel(toolchain)
    gitExecutable = toolchain.git.absoluteExecutable
    root = await requireGitRoot(requestedRoot, gitExecutable)
  } catch (error) {
    await lock.release()
    throw error
  }
  let toolchainUnchanged = null
  const relativeEvaluationPath = `.prime-continuim-self-build/evaluations/${runId}`
  const evaluationRoot = resolve(root, ...relativeEvaluationPath.split('/'))
  const receiptDirectory = resolve(root, '.prime-continuim-self-build', 'receipts')
  const startedAt = now().toISOString()

  let source
  let artifactSummary
  let evaluationAttempted = false
  let evaluationCleanupState = 'not-created'
  let stage = 'capture_candidate'
  let failureStage
  let failure
  const commands = []
  try {
    source = await captureGitCandidate(root, { gitExecutable })
    stage = 'materialize_candidate'
    evaluationAttempted = true
    await materializeGitCandidate({ sourceRoot: root, evaluationRoot, candidate: source, gitExecutable })
    stage = 'fence_candidate'
    const recaptured = await captureGitCandidate(root, { gitExecutable })
    assertCandidateIdentityEqual(source, recaptured, 'The source worktree changed while the evaluation worktree was materialized.')
    const materialized = await captureCandidateTree(evaluationRoot, source.paths)
    if (materialized.treeSha256 !== source.treeSha256) {
      throw new Error('The isolated evaluation tree does not match the captured candidate tree.')
    }
    stage = 'run_gates'
    const commandPlan = createSelfBuildCommandPlan({ root, evaluationRoot, toolchain, stepTimeoutMs })
    const sequence = await runCommandSequence({
      commands: commandPlan,
      workflow,
      lock,
      runStep,
      afterStep: async (command) => {
        if (command.label === 'Install exact dependencies from the local pnpm store') {
          await materializeEvaluationNodeRuntimeDependency(evaluationRoot, toolchain)
          await assertEvaluationDependencyIsolation(root, evaluationRoot)
        }
        const current = await captureGitCandidate(evaluationRoot, { gitExecutable })
        assertMaterializedContentEqual(source, current, 'A self-build command changed the isolated candidate source tree.')
        const currentSource = await captureGitCandidate(root, { gitExecutable })
        assertCandidateIdentityEqual(source, currentSource, 'The main source worktree changed during self-build evaluation.')
        const currentToolchainSentinel = await inspectToolchainMetadataSentinel(toolchain)
        if (canonicalJson(currentToolchainSentinel) !== canonicalJson(toolchainSentinel)) {
          throw new Error('A self-build tool or external runtime input changed during a command.')
        }
      },
    })
    commands.push(...sequence.results)
    if (!sequence.passed) {
      const failed = sequence.results.at(-1)
      const reason = failed?.timedOut
        ? `${failed.label} exceeded its ${failed.timeoutMs} ms deadline.`
        : failed?.postconditionError
          ? `${failed.label} violated an evaluation postcondition: ${failed.postconditionError}`
        : `${failed?.label ?? 'Self-build command'} failed with ${formatCommandOutcome(failed)}.`
      throw new Error(reason)
    }

    stage = 'digest_artifacts'
    artifactSummary = await digestArtifactRoots(evaluationRoot, [
      'out/main',
      'out/preload',
      'out/renderer',
      'out/hostd',
    ])
  } catch (error) {
    failure = error
    failureStage = stage
  } finally {
    const collateralStateUnknown = commands.some((command) => command.collateralState === 'unknown_supervised_tree_retained_lease')
    if (collateralStateUnknown) {
      toolchainUnchanged = null
      failureStage = 'unconfirmed_supervised_tree'
      try {
        // Do not claim a stable final fence while a supervised descendant may
        // still be running and mutating its inputs.
        throw new Error('Final source and toolchain fences are inconclusive because supervised process-tree teardown was not confirmed.')
      } catch (unconfirmedError) {
        failure = failure
          ? new AggregateError([failure, unconfirmedError], 'Self-build failed with unconfirmed supervised collateral state.')
          : unconfirmedError
      }
    } else {
      try {
        const [finalToolchain, finalToolchainSentinel] = await Promise.all([
          inspectToolchain(root),
          inspectToolchainMetadataSentinel(toolchain),
        ])
        toolchainUnchanged = canonicalJson(finalToolchain) === canonicalJson(toolchain) &&
          canonicalJson(finalToolchainSentinel) === canonicalJson(toolchainSentinel)
        if (!toolchainUnchanged) throw new Error('A self-build tool or runtime input changed during evaluation.')
      } catch (toolchainFenceError) {
        toolchainUnchanged = false
        failureStage = 'verify_toolchain_fence'
        failure = failure
          ? new AggregateError([failure, toolchainFenceError], 'Self-build failed and its toolchain fence also changed.')
          : toolchainFenceError
      }
      if (source) {
        try {
          const finalSource = await captureGitCandidate(root, { gitExecutable })
          assertCandidateIdentityEqual(source, finalSource, 'The main source worktree changed during self-build evaluation.')
        } catch (sourceFenceError) {
          failureStage = 'verify_main_source_fence'
          failure = failure
            ? new AggregateError([failure, sourceFenceError], 'Self-build failed and the main source fence also changed.')
            : sourceFenceError
        }
      }
    }
    if (evaluationAttempted) {
      const initialDisposition = await inspectEvaluationWorktreeDisposition(root, relativeEvaluationPath, gitExecutable)
      if (initialDisposition === 'unknown') {
        evaluationCleanupState = 'unknown'
        const inspectionError = new Error('The evaluation worktree state could not be established safely.')
        failureStage = 'cleanup_evaluation'
        failure = failure
          ? new AggregateError([failure, inspectionError], 'Self-build failed and its evaluation worktree state is unknown.')
          : inspectionError
      } else if (initialDisposition === 'present') {
        if (collateralStateUnknown || (failure && retainFailedWorktree)) {
          evaluationCleanupState = 'retained'
        } else {
          try {
            await cleanupEvaluationWorktree({ projectRoot: root, evaluationRoot, gitExecutable })
            const cleanedDisposition = await inspectEvaluationWorktreeDisposition(root, relativeEvaluationPath, gitExecutable)
            if (cleanedDisposition !== 'absent') throw new Error('The evaluation worktree was not confirmed absent after cleanup.')
            evaluationCleanupState = 'removed'
          } catch (cleanupError) {
            const failedCleanupDisposition = await inspectEvaluationWorktreeDisposition(root, relativeEvaluationPath, gitExecutable)
            evaluationCleanupState = failedCleanupDisposition === 'present'
              ? 'retained'
              : failedCleanupDisposition === 'absent' ? 'removed' : 'unknown'
            failureStage = 'cleanup_evaluation'
            failure = failure
              ? new AggregateError([failure, cleanupError], 'Self-build failed and its evaluation worktree cleanup also failed.')
              : cleanupError
          }
        }
      } else {
        evaluationCleanupState = 'removed'
      }
    }
  }

  try {
    const completedAt = now().toISOString()
    const receipt = {
      schemaVersion: 1,
      kind: RECEIPT_KIND,
      runId,
      startedAt,
      completedAt,
      outcome: failure ? 'failed' : 'passed',
      source: source ? publicCandidateIdentity(source) : null,
      toolchain: toolchain ?? null,
      evaluation: {
        isolation: 'detached-temporary-git-worktree',
        dependencyInstall: 'pnpm install --offline --frozen-lockfile --ignore-scripts --verify-store-integrity --package-import-method copy --lockfile-dir . --modules-dir node_modules --virtual-store-dir node_modules/.pnpm --store-dir <digest-bound-local-store>; validate and copy the exact synthetic node runtime package locally',
        cleanupState: evaluationCleanupState,
        worktreeRelativePath: ['retained', 'unknown'].includes(evaluationCleanupState) ? relativeEvaluationPath : null,
        toolchainFence: 'per-step-metadata-and-final-content',
        toolchainUnchanged,
        commands,
      },
      artifacts: artifactSummary ?? null,
      failure: failure
        ? {
            stage: failureStage ?? stage,
            name: failure instanceof Error ? failure.name : 'Error',
            message: sanitizeErrorMessage(failure, { root, evaluationRoot }),
          }
        : null,
      boundary: {
        securitySandbox: false,
        autonomousPromotion: false,
        providerBackedEvaluation: false,
        packageOrInstallerGate: false,
        candidateControlledEvaluation: true,
        mainFilesystemIsolation: false,
      },
    }
    const envelope = createReceiptEnvelope(receipt)
    await ensureSafeOwnedDirectory(root, '.prime-continuim-self-build/receipts')
    const receiptPath = await writeReceiptEnvelope(receiptDirectory, envelope)
    const relativeReceiptPath = normalizeRelativePath(relative(root, receiptPath))
    if (failure) {
      throw new SelfBuildFailure(
        `Prime Continuim self-build failed during ${failureStage ?? stage}. Evidence: ${relativeReceiptPath}`,
        { receiptPath, receiptSha256: envelope.receiptSha256, stage: failureStage ?? stage, cause: failure },
      )
    }
    return { receiptPath, relativeReceiptPath, envelope }
  } finally {
    await lock.release()
  }
}

export function requireCoordinatorRunId(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  ) {
    throw new TypeError('coordinatorRunId must be one canonical UUID.')
  }
  return value.toLowerCase()
}

export function selfBuildWorkflowName(coordinatorRunId) {
  return coordinatorRunId === undefined
    ? 'self-build'
    : `self-build:${requireCoordinatorRunId(coordinatorRunId)}`
}

export async function captureGitCandidate(projectRoot, { gitExecutable = 'git' } = {}) {
  const root = await requireGitRoot(projectRoot, gitExecutable)
  const [headResult, trackedResult] = await Promise.all([
    runGit(gitExecutable, ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root, maxOutputBytes: 1024 }),
    runGit(gitExecutable, ['ls-files', '--cached', '-z'], { cwd: root, maxOutputBytes: MAX_STATUS_BYTES }),
  ])
  const headCommit = decodeUtf8(headResult.stdout, 'HEAD commit').trim()
  if (!/^[a-f0-9]{40,64}$/.test(headCommit)) throw new Error('Git returned an invalid HEAD commit identity.')
  const trackedPaths = parseNulPaths(trackedResult.stdout, 'tracked file list')
  const reservedTrackedPath = trackedPaths.find(isGeneratedOrPrivatePath)
  if (reservedTrackedPath) throw new Error(`Tracked source occupies a Prime Continuim generated/private path: ${reservedTrackedPath}`)
  // Reject linked/reparse ancestors before Git is allowed to inspect working
  // tree content for a status or binary patch.
  await captureCandidateTree(root, trackedPaths)
  const untrackedResult = await runGit(gitExecutable, [
    'ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...GENERATED_PATHSPEC_EXCLUSIONS,
  ], {
    cwd: root,
    maxOutputBytes: MAX_STATUS_BYTES,
  })
  const untrackedPaths = parseNulPaths(untrackedResult.stdout, 'untracked file list').filter((path) => !isGeneratedOrPrivatePath(path))
  if (untrackedPaths.length > MAX_UNTRACKED_FILES) {
    throw new Error(`The candidate has more than ${MAX_UNTRACKED_FILES} untracked files; refusing an unbounded capture.`)
  }
  const pathSet = new Set([...trackedPaths, ...untrackedPaths])
  const paths = [...pathSet].sort(compareUtf8)
  const tree = await captureCandidateTree(root, paths)
  const [statusResult, patchResult] = await Promise.all([
    runGit(gitExecutable, [
      'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', '.', ...GENERATED_PATHSPEC_EXCLUSIONS,
    ], { cwd: root, maxOutputBytes: MAX_STATUS_BYTES }),
    runGit(gitExecutable, [
      'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.', ...GENERATED_PATHSPEC_EXCLUSIONS,
    ], { cwd: root, maxOutputBytes: MAX_CAPTURE_BYTES }),
  ])
  const untracked = tree.entries.filter((entry) => untrackedPaths.includes(entry.path))
  const untrackedBytes = untracked.reduce((total, entry) => total + entry.size, 0)
  if (untrackedBytes > MAX_UNTRACKED_BYTES) {
    throw new Error(`Untracked candidate data exceeds the ${MAX_UNTRACKED_BYTES}-byte capture limit.`)
  }
  return Object.freeze({
    headCommit,
    dirty: patchResult.stdout.byteLength > 0 || untracked.length > 0,
    statusPorcelainV2Sha256: sha256(statusResult.stdout),
    statusBytes: statusResult.stdout.byteLength,
    binaryPatchSha256: sha256(patchResult.stdout),
    binaryPatchBytes: patchResult.stdout.byteLength,
    untrackedManifestSha256: sha256(Buffer.from(canonicalJson(untracked))),
    untrackedFileCount: untracked.length,
    untrackedBytes,
    treeSha256: tree.treeSha256,
    treeFileCount: tree.fileCount,
    treeBytes: tree.totalBytes,
    paths,
    entries: tree.entries,
    untracked,
  })
}

export async function captureCandidateTree(root, paths) {
  if (!Array.isArray(paths) || paths.length > MAX_SOURCE_FILES) {
    throw new Error(`Candidate source exceeds the ${MAX_SOURCE_FILES}-file capture limit.`)
  }
  const entries = []
  let totalBytes = 0
  await requirePlainDirectory(root, 'candidate root')
  for (const path of [...paths].sort(compareUtf8)) {
    assertSafeGitPath(path)
    const absolute = resolveContained(root, path)
    await requireSafeExistingAncestors(root, path, 'candidate path')
    let metadata
    try {
      metadata = await lstat(absolute)
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) continue
      throw error
    }
    let entry
    if (metadata.isFile()) {
      if (metadata.size > MAX_CAPTURE_BYTES) throw new Error(`Candidate file exceeds the per-file capture limit: ${path}`)
      const bytes = await readFile(absolute)
      const after = await lstat(absolute)
      if (!after.isFile() || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) {
        throw new Error(`Candidate file changed while it was captured: ${path}`)
      }
      entry = {
        path,
        type: 'file',
        executable: (metadata.mode & 0o111) !== 0,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      }
    } else {
      throw new Error(`Candidate path is not a plain regular file; links and special files are not evaluated: ${path}`)
    }
    totalBytes += entry.size
    if (totalBytes > MAX_SOURCE_BYTES) throw new Error(`Candidate source exceeds the ${MAX_SOURCE_BYTES}-byte capture limit.`)
    entries.push(entry)
  }
  return {
    treeSha256: sha256(Buffer.from(canonicalJson(entries))),
    fileCount: entries.length,
    totalBytes,
    entries,
  }
}

export async function materializeGitCandidate({ sourceRoot, evaluationRoot, candidate, gitExecutable = 'git' }) {
  const root = await requireGitRoot(sourceRoot, gitExecutable)
  const destination = resolve(evaluationRoot)
  const relativeDestination = normalizeRelativePath(relative(root, destination))
  if (!relativeDestination.startsWith('.prime-continuim-self-build/evaluations/')) {
    throw new Error('evaluation worktree must stay beneath the owned self-build evaluation directory.')
  }
  await ensureSafeOwnedDirectory(root, '.prime-continuim-self-build/evaluations')
  await requirePathMissing(destination, 'The evaluation destination already exists and will not be replaced.')
  await runGit(gitExecutable, ['worktree', 'add', '--detach', '--no-checkout', destination, candidate.headCommit], {
    cwd: root,
    maxOutputBytes: MAX_STATUS_BYTES,
  })
  // The linked worktree starts empty. Copying the complete hash-bound manifest
  // avoids checkout filters/hooks and exactly reproduces deletions and renames.
  for (const entry of candidate.entries) {
    const source = resolveContained(root, entry.path)
    const target = resolveContained(destination, entry.path)
    await requireSafeExistingAncestors(root, entry.path, 'candidate source path')
    await ensureSafeParentDirectories(destination, entry.path)
    if (entry.type === 'file') {
      const before = await hashRegularFile(source, MAX_CAPTURE_BYTES)
      assertManifestEntryMatches(entry, before, 'Candidate source changed before copy')
      try {
        const targetMetadata = await lstat(target)
        if (targetMetadata.isSymbolicLink()) await unlink(target)
        else if (!targetMetadata.isFile()) throw new Error(`Candidate target is not a regular file: ${entry.path}`)
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) throw error
      }
      await copyFile(source, target)
      if (process.platform !== 'win32') await chmod(target, entry.executable ? 0o755 : 0o644)
    } else {
      throw new Error(`Unsupported candidate entry: ${entry.path}`)
    }
  }
  const materialized = await captureCandidateTree(destination, candidate.paths)
  if (materialized.treeSha256 !== candidate.treeSha256) {
    throw new Error('Materialized candidate tree digest does not match the source capture.')
  }
}

export async function cleanupEvaluationWorktree({ projectRoot, evaluationRoot, gitExecutable = 'git' }) {
  const root = await requireGitRoot(projectRoot, gitExecutable)
  const evaluationParent = resolve(root, '.prime-continuim-self-build', 'evaluations')
  const destination = resolve(evaluationRoot)
  assertContained(evaluationParent, destination, 'evaluation cleanup')
  await requireSafeExistingAncestors(root, normalizeRelativePath(relative(root, destination)), 'evaluation cleanup')
  try {
    await requirePlainDirectory(destination, 'evaluation worktree')
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) throw error
  }
  const removed = await runGit(gitExecutable, ['worktree', 'remove', '--force', destination], {
    cwd: root,
    maxOutputBytes: MAX_STATUS_BYTES,
    allowFailure: true,
  })
  if (removed.code !== 0) {
    await rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await runGit(gitExecutable, ['worktree', 'prune'], { cwd: root, maxOutputBytes: MAX_STATUS_BYTES })
  }
  try {
    await lstat(destination)
    throw new Error('The evaluation worktree still exists after cleanup.')
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) throw error
  }
}

async function inspectEvaluationWorktreeDisposition(root, relativeEvaluationPath, gitExecutable) {
  const destination = resolveContained(root, relativeEvaluationPath)
  let filesystemState
  try {
    await requireSafeExistingAncestors(root, relativeEvaluationPath, 'evaluation worktree inspection')
    const metadata = await lstat(destination)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return 'unknown'
    const physical = await realpath(destination)
    filesystemState = samePath(destination, physical) ? 'present' : 'unknown'
  } catch (error) {
    filesystemState = isErrorCode(error, 'ENOENT') ? 'absent' : 'unknown'
  }
  if (filesystemState === 'unknown') return 'unknown'
  try {
    const listing = await runGit(gitExecutable, ['worktree', 'list', '--porcelain', '-z'], {
      cwd: root,
      maxOutputBytes: MAX_STATUS_BYTES,
    })
    const fields = decodeUtf8(listing.stdout, 'worktree registry').split('\0')
    const registered = fields
      .filter((field) => field.startsWith('worktree '))
      .some((field) => samePath(resolve(field.slice('worktree '.length)), destination))
    if ((filesystemState === 'present') !== registered) return 'unknown'
    return filesystemState
  } catch {
    return 'unknown'
  }
}

export function createSelfBuildCommandPlan({ root, evaluationRoot, toolchain, stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS }) {
  assertPositiveInteger(stepTimeoutMs, 'stepTimeoutMs')
  const pnpmCli = toolchain.pnpm.absoluteCli
  const environment = createSelfBuildEnvironment(process.env)
  const pnpm = (label, args, timeoutMs = stepTimeoutMs) => ({
    label,
    executable: toolchain.node.absoluteExecutable,
    args: [pnpmCli, ...args],
    cwd: evaluationRoot,
    environment,
    timeoutMs,
  })
  return [
    pnpm('Install exact dependencies from the local pnpm store', [
      'install',
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--verify-store-integrity',
      '--package-import-method', 'copy',
      '--lockfile-dir', '.',
      '--modules-dir', 'node_modules',
      '--virtual-store-dir', 'node_modules/.pnpm',
      '--store-dir', toolchain.pnpm.absoluteStore,
    ]),
    pnpm('Typecheck the candidate', ['run', 'typecheck']),
    pnpm('Run the candidate test suite', ['run', 'test']),
    {
      label: 'Verify the prebuilt Prime Agent runtime input before build',
      executable: toolchain.node.absoluteExecutable,
      args: [resolve(evaluationRoot, 'scripts/verify-prime-agent-runtime.mjs'), '--output', toolchain.runtimeSeed.absoluteRoot],
      cwd: evaluationRoot,
      environment,
      timeoutMs: stepTimeoutMs,
    },
    pnpm('Build the attested release candidate', [
      'run', 'build:release',
      '--runtime-root', toolchain.runtimeSeed.absoluteRoot,
      '--electron', toolchain.electron.absoluteExecutable,
    ]),
    {
      label: 'Reverify the prebuilt Prime Agent runtime input',
      executable: toolchain.node.absoluteExecutable,
      args: [resolve(evaluationRoot, 'scripts/verify-prime-agent-runtime.mjs'), '--output', toolchain.runtimeSeed.absoluteRoot],
      cwd: evaluationRoot,
      environment,
      timeoutMs: stepTimeoutMs,
    },
  ]
}

function createGitEnvironment(source = process.env) {
  return createSelfBuildEnvironment(source)
}

function describeSelfBuildEnvironment(environment) {
  const names = Object.keys(environment).sort(compareUtf8)
  return {
    policy: SELF_BUILD_ENVIRONMENT_POLICY,
    names,
    valuesSha256: sha256(Buffer.from(canonicalJson(environment))),
  }
}

export async function runCommandSequence({ commands, workflow, lock, runStep = runSupervisedWorkflowStep, afterStep }) {
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > 16) {
    throw new Error('Self-build command sequence must contain 1 to 16 bounded commands.')
  }
  const results = []
  for (const command of commands) {
    const started = Date.now()
    let record
    try {
      const result = await runStep({
        workflow,
        lock,
        step: {
          executable: command.executable,
          args: command.args,
          cwd: command.cwd,
          environment: command.environment,
        },
        stepTimeoutMs: command.timeoutMs,
      })
      record = {
        label: command.label,
        command: redactCommand(command),
        timeoutMs: command.timeoutMs,
        durationMs: Date.now() - started,
        code: result.code,
        signal: result.signal ?? null,
        timedOut: result.timedOut === true,
        supervisorError: null,
        collateralState: 'supervised_tree_settled',
      }
    } catch (error) {
      const reportedCollateralState = error && typeof error === 'object' &&
        ['unknown_supervised_tree_retained_lease', 'supervisor_failed_after_teardown_attempt'].includes(error.collateralState)
        ? error.collateralState
        : 'supervisor_failed_after_teardown_attempt'
      record = {
        label: command.label,
        command: redactCommand(command),
        timeoutMs: command.timeoutMs,
        durationMs: Date.now() - started,
        code: null,
        signal: null,
        timedOut: false,
        supervisorError: 'workflow_supervisor_failed',
        collateralState: reportedCollateralState,
      }
    }
    results.push(record)
    if (record.collateralState === 'unknown_supervised_tree_retained_lease') {
      return { passed: false, results }
    }
    if (afterStep) {
      try {
        await afterStep(command, record)
      } catch (error) {
        record.postconditionError = 'evaluation_postcondition_failed'
      }
    }
    if (record.timedOut || record.code !== 0 || record.signal || record.supervisorError || record.postconditionError) {
      return { passed: false, results }
    }
  }
  return { passed: true, results }
}

export async function inspectToolchain(root, {
  nodeExecutable = process.execPath,
  pnpmCli = resolvePnpmCli(),
} = {}) {
  const physicalNodeExecutable = await realpath(resolve(nodeExecutable))
  const nodeMetadata = await lstat(physicalNodeExecutable)
  if (!nodeMetadata.isFile() || nodeMetadata.isSymbolicLink()) throw new Error('Self-build Node must be a plain executable file.')
  const physicalPnpmCli = await realpath(resolve(pnpmCli))
  const pnpmMetadata = await lstat(physicalPnpmCli)
  if (!pnpmMetadata.isFile() || pnpmMetadata.isSymbolicLink()) throw new Error('Self-build pnpm CLI must be a plain file.')
  const requiredPnpm = readPinnedDevelopmentPnpmVersion(root)
  const inspectionEnvironment = createSelfBuildEnvironment(process.env)
  const nodeIdentityResult = await runCaptured(physicalNodeExecutable, [
    '--input-type=module',
    '--eval',
    'process.stdout.write(JSON.stringify({version:process.version,modulesAbi:process.versions.modules,platform:process.platform,arch:process.arch}))',
  ], { cwd: root, maxOutputBytes: 16 * 1024, environment: inspectionEnvironment })
  const nodeIdentity = JSON.parse(decodeUtf8(nodeIdentityResult.stdout, 'Node identity'))
  if (
    !nodeIdentity ||
    typeof nodeIdentity.version !== 'string' ||
    typeof nodeIdentity.modulesAbi !== 'string' ||
    typeof nodeIdentity.platform !== 'string' ||
    typeof nodeIdentity.arch !== 'string'
  ) throw new Error('Self-build Node returned invalid runtime identity metadata.')
  const pnpmVersionResult = await runCaptured(physicalNodeExecutable, [physicalPnpmCli, '--version'], { cwd: root, maxOutputBytes: 16 * 1024, environment: inspectionEnvironment })
  const pnpmVersion = decodeUtf8(pnpmVersionResult.stdout, 'pnpm version').trim()
  if (pnpmVersion !== requiredPnpm) throw new Error(`Self-build requires pnpm ${requiredPnpm}; found ${pnpmVersion}.`)
  const storeResult = await runCaptured(physicalNodeExecutable, [physicalPnpmCli, 'store', 'path', '--silent'], {
    cwd: root,
    maxOutputBytes: 16 * 1024,
    environment: inspectionEnvironment,
  })
  const reportedPnpmStore = decodeUtf8(storeResult.stdout, 'pnpm store path').trim()
  const pnpmStore = await requirePlainDirectory(await realpath(reportedPnpmStore), 'physical pnpm content store')
  const requireFromRoot = createRequire(join(root, 'package.json'))
  const electronPackagePath = requireFromRoot.resolve('electron/package.json')
  const electronPackage = JSON.parse(await readFile(electronPackagePath, 'utf8'))
  const electronExecutable = resolve(requireFromRoot('electron'))
  const electronDistribution = await digestFileTree(dirname(electronExecutable), {
    maxFiles: MAX_ARTIFACT_FILES,
    maxBytes: MAX_ARTIFACT_BYTES,
  })
  const runtimeRoot = resolve(root, 'out', 'runtime')
  const runtimeSeed = await inspectRuntimeSeed(runtimeRoot)
  const gitExecutable = await resolveExecutableOnPath(process.platform === 'win32' ? 'git.exe' : 'git')
  if (!gitExecutable) throw new Error('Prime Continuim self-build could not resolve the Git executable on PATH.')
  const gitVersion = decodeUtf8((await runGit(gitExecutable, ['--version'], { cwd: root, maxOutputBytes: 16 * 1024 })).stdout, 'Git version').trim()
  const pnpm = {
    version: pnpmVersion,
    cliSha256: await sha256File(physicalPnpmCli),
    storePathSha256: sha256(Buffer.from(normalizeAbsoluteForIdentity(pnpmStore))),
  }
  Object.defineProperty(pnpm, 'absoluteCli', { value: physicalPnpmCli, enumerable: false })
  Object.defineProperty(pnpm, 'absoluteStore', { value: pnpmStore, enumerable: false })
  const git = { version: gitVersion, executableSha256: await sha256File(gitExecutable) }
  Object.defineProperty(git, 'absoluteExecutable', { value: gitExecutable, enumerable: false })
  const electron = {
    version: electronPackage.version,
    executableSha256: await sha256File(electronExecutable),
    distributionSha256: electronDistribution.treeSha256,
    distributionFileCount: electronDistribution.fileCount,
    distributionBytes: electronDistribution.totalBytes,
  }
  Object.defineProperty(electron, 'absoluteExecutable', { value: electronExecutable, enumerable: false })
  const publicRuntimeSeed = { ...runtimeSeed }
  Object.defineProperty(publicRuntimeSeed, 'absoluteRoot', { value: runtimeRoot, enumerable: false })
  const result = {
    node: {
      version: nodeIdentity.version,
      modulesAbi: nodeIdentity.modulesAbi,
      platform: nodeIdentity.platform,
      arch: nodeIdentity.arch,
      executableSha256: await sha256File(physicalNodeExecutable),
    },
    pnpm,
    git,
    electron,
    runtimeSeed: publicRuntimeSeed,
    environment: describeSelfBuildEnvironment(inspectionEnvironment),
  }
  Object.defineProperty(result.node, 'absoluteExecutable', { value: physicalNodeExecutable, enumerable: false })
  return result
}

async function inspectToolchainMetadataSentinel(toolchain) {
  const runtimePointer = resolve(toolchain.runtimeSeed.absoluteRoot, 'current.json')
  const pointer = JSON.parse((await readBoundedFile(runtimePointer, 64 * 1024)).toString('utf8'))
  assertSafeGitPath(pointer.runtimeManifest)
  const runtimeManifest = resolveContained(toolchain.runtimeSeed.absoluteRoot, pointer.runtimeManifest)
  const paths = [
    toolchain.node.absoluteExecutable,
    toolchain.pnpm.absoluteCli,
    toolchain.pnpm.absoluteStore,
    toolchain.git.absoluteExecutable,
    toolchain.electron.absoluteExecutable,
    dirname(toolchain.electron.absoluteExecutable),
    runtimePointer,
    runtimeManifest,
  ]
  const entries = []
  for (const path of paths) {
    const metadata = await lstat(path)
    entries.push(describeToolchainSentinelMetadata(metadata))
  }
  return { schemaVersion: 1, entriesSha256: sha256(Buffer.from(canonicalJson(entries))), entryCount: entries.length }
}

export function describeToolchainSentinelMetadata(metadata) {
  const kind = metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'special'
  const identity = {
    kind,
    dev: String(metadata.dev),
    ino: String(metadata.ino),
  }
  if (kind === 'directory') return identity
  return {
    ...identity,
    size: metadata.size,
    // Cloud hydration and antivirus scans can advance NTFS change-time while
    // preserving the exact file. Size/mtime/inode catch replacement during a
    // step; the final toolchain inspection independently rehashes all bytes.
    mtimeMs: Math.trunc(metadata.mtimeMs),
  }
}

async function inspectRuntimeSeed(runtimeRoot) {
  await requirePlainDirectory(runtimeRoot, 'prebuilt runtime root')
  const pointerBytes = await readBoundedFile(resolve(runtimeRoot, 'current.json'), 64 * 1024)
  const pointer = JSON.parse(pointerBytes.toString('utf8'))
  if (
    pointer?.schemaVersion !== 1 ||
    typeof pointer.runtimeManifest !== 'string' ||
    !SHA256.test(pointer.manifestSha256 ?? '') ||
    !SHA256.test(pointer.treeSha256 ?? '')
  ) {
    throw new Error('The prebuilt Prime Agent runtime pointer is missing or invalid. Run `pnpm build:runtime` once, then retry.')
  }
  assertSafeGitPath(pointer.runtimeManifest)
  await requireSafeExistingAncestors(runtimeRoot, pointer.runtimeManifest, 'runtime manifest')
  const manifestPath = resolveContained(runtimeRoot, pointer.runtimeManifest)
  const manifestBytes = await readBoundedFile(manifestPath, 512 * 1024)
  if (sha256(manifestBytes) !== pointer.manifestSha256) throw new Error('The prebuilt Prime Agent runtime manifest digest is stale.')
  const payload = await digestFileTree(runtimeRoot, { maxFiles: MAX_ARTIFACT_FILES, maxBytes: MAX_ARTIFACT_BYTES })
  return {
    releaseVersion: String(pointer.releaseVersion),
    platform: String(pointer.platform),
    arch: String(pointer.arch),
    pointerSha256: sha256(pointerBytes),
    manifestSha256: pointer.manifestSha256,
    treeSha256: pointer.treeSha256,
    payloadSha256: payload.treeSha256,
    payloadFileCount: payload.fileCount,
    payloadBytes: payload.totalBytes,
  }
}

export async function digestArtifactRoots(root, roots) {
  if (!Array.isArray(roots) || roots.length === 0 || roots.length > 16) throw new Error('Artifact roots must contain 1 to 16 entries.')
  const summaries = []
  let totalFiles = 0
  let totalBytes = 0
  for (const rootPath of roots) {
    assertSafeGitPath(rootPath)
    const absolute = resolveContained(root, rootPath)
    const tree = await digestFileTree(absolute, { maxFiles: MAX_ARTIFACT_FILES - totalFiles, maxBytes: MAX_ARTIFACT_BYTES - totalBytes })
    if (tree.fileCount === 0) throw new Error(`Required self-build artifact root is empty: ${rootPath}`)
    totalFiles += tree.fileCount
    totalBytes += tree.totalBytes
    summaries.push({ path: rootPath, treeSha256: tree.treeSha256, fileCount: tree.fileCount, totalBytes: tree.totalBytes })
  }
  return {
    roots: summaries,
    aggregateSha256: sha256(Buffer.from(canonicalJson(summaries))),
    fileCount: totalFiles,
    totalBytes,
  }
}

export async function assertEvaluationDependencyIsolation(mainRoot, evaluationRoot) {
  const mainModules = await requirePlainDirectory(resolve(mainRoot, 'node_modules'), 'main node_modules')
  const evaluationModules = await requirePlainDirectory(resolve(evaluationRoot, 'node_modules'), 'evaluation node_modules')
  const evaluationVirtualStore = await requirePlainDirectory(resolve(evaluationModules, '.pnpm'), 'evaluation virtual store')
  if (samePath(mainModules, evaluationModules) || samePath(mainModules, evaluationVirtualStore)) {
    throw new Error('The evaluation dependency tree aliases the main worktree dependency tree.')
  }
  const [mainMetadata, evaluationMetadata] = await Promise.all([stat(mainModules), stat(evaluationModules)])
  if (mainMetadata.ino !== 0 && mainMetadata.dev === evaluationMetadata.dev && mainMetadata.ino === evaluationMetadata.ino) {
    throw new Error('The evaluation node_modules directory is the main dependency directory.')
  }
  await assertNoExternalEvaluationLinks(evaluationRoot)
}

export async function materializeEvaluationNodeRuntimeDependency(evaluationRoot, toolchain) {
  const root = await requirePlainDirectory(evaluationRoot, 'evaluation root')
  const modules = await requirePlainDirectory(resolve(root, 'node_modules'), 'evaluation node_modules')
  const runtimeLink = resolve(modules, 'node')
  const linkMetadata = await lstat(runtimeLink)
  if (!linkMetadata.isSymbolicLink()) {
    throw new Error('The synthetic pnpm Node runtime dependency is not an exact external link.')
  }
  const store = await requirePlainDirectory(toolchain.pnpm.absoluteStore, 'physical pnpm content store')
  const source = await realpath(runtimeLink)
  const storeRelation = relative(store, source)
  if (!storeRelation || storeRelation === '..' || storeRelation.startsWith(`..${sep}`) || isAbsolute(storeRelation)) {
    throw new Error('The synthetic pnpm Node runtime dependency resolves outside the bound content store.')
  }
  await requirePlainDirectory(source, 'synthetic pnpm Node runtime package')
  const packageValue = JSON.parse((await readBoundedFile(resolve(source, 'package.json'), 64 * 1024)).toString('utf8'))
  const expectedVersion = String(toolchain.node.version).replace(/^v/u, '')
  const executablePath = process.platform === 'win32' ? 'node.exe' : 'bin/node'
  if (
    packageValue?.name !== 'node' ||
    packageValue.version !== expectedVersion ||
    packageValue.bin?.node !== executablePath
  ) {
    throw new Error('The synthetic pnpm Node runtime package identity does not match the bound Node toolchain.')
  }
  const sourceExecutable = resolveContained(source, executablePath)
  const executableMetadata = await lstat(sourceExecutable)
  if (
    !executableMetadata.isFile() ||
    executableMetadata.isSymbolicLink() ||
    await sha256File(sourceExecutable) !== toolchain.node.executableSha256
  ) {
    throw new Error('The synthetic pnpm Node runtime executable does not match the bound Node toolchain.')
  }
  const sourceTree = await digestFileTree(source, { maxFiles: 128, maxBytes: 256 * 1024 * 1024 })
  await unlink(runtimeLink)
  await mkdir(runtimeLink, { mode: 0o700 })
  for (const entry of sourceTree.entries) {
    const sourceFile = resolveContained(source, entry.path)
    const targetFile = resolveContained(runtimeLink, entry.path)
    const metadata = await lstat(sourceFile)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('The synthetic pnpm Node runtime package contains a linked or special entry.')
    }
    await ensureSafeParentDirectories(runtimeLink, entry.path)
    await copyFile(sourceFile, targetFile)
    if (process.platform !== 'win32') await chmod(targetFile, metadata.mode & 0o777)
  }
  const [sourceAfter, materialized] = await Promise.all([
    digestFileTree(source, { maxFiles: 128, maxBytes: 256 * 1024 * 1024 }),
    digestFileTree(runtimeLink, { maxFiles: 128, maxBytes: 256 * 1024 * 1024 }),
  ])
  const expected = canonicalJson({
    treeSha256: sourceTree.treeSha256,
    fileCount: sourceTree.fileCount,
    totalBytes: sourceTree.totalBytes,
  })
  if (
    canonicalJson({ treeSha256: sourceAfter.treeSha256, fileCount: sourceAfter.fileCount, totalBytes: sourceAfter.totalBytes }) !== expected ||
    canonicalJson({ treeSha256: materialized.treeSha256, fileCount: materialized.fileCount, totalBytes: materialized.totalBytes }) !== expected
  ) {
    throw new Error('The synthetic pnpm Node runtime package changed while it was copied into the evaluation.')
  }
}

async function assertNoExternalEvaluationLinks(evaluationRoot) {
  const root = await requirePlainDirectory(evaluationRoot, 'evaluation root')
  let entries = 0
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      entries += 1
      if (entries > 200_000) throw new Error('Evaluation link inspection exceeded its bounded entry limit.')
      const absolute = resolve(directory, child.name)
      if (child.isSymbolicLink()) {
        const target = await realpath(absolute)
        const relation = relative(root, target)
        if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
          throw new Error('Evaluation dependency installation created a link outside the evaluation worktree.')
        }
      } else if (child.isDirectory()) {
        await visit(absolute)
      }
    }
  }
  await visit(root)
}

export async function digestFileTree(root, { maxFiles = MAX_ARTIFACT_FILES, maxBytes = MAX_ARTIFACT_BYTES } = {}) {
  const absoluteRoot = resolve(root)
  await requirePlainDirectory(absoluteRoot, 'artifact root')
  const entries = []
  let totalBytes = 0
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => compareUtf8(left.name, right.name))
    for (const child of children) {
      const absolute = join(directory, child.name)
      if (child.isDirectory()) {
        await requirePlainDirectory(absolute, 'artifact directory')
        await visit(absolute)
        continue
      }
      if (!child.isFile()) throw new Error(`Artifact tree contains a non-regular entry: ${normalizeRelativePath(relative(absoluteRoot, absolute))}`)
      const relativePath = normalizeRelativePath(relative(absoluteRoot, absolute))
      const metadata = await stat(absolute)
      totalBytes += metadata.size
      if (entries.length + 1 > maxFiles || totalBytes > maxBytes) throw new Error('Artifact tree exceeds its bounded evidence limit.')
      entries.push({ path: relativePath, size: metadata.size, sha256: await sha256File(absolute) })
    }
  }
  await visit(absoluteRoot)
  return { treeSha256: sha256(Buffer.from(canonicalJson(entries))), fileCount: entries.length, totalBytes, entries }
}

export function createReceiptEnvelope(receipt) {
  const canonical = canonicalJson(receipt)
  const receiptSha256 = sha256(Buffer.from(canonical))
  return { integrity: INTEGRITY_CLAIM, receipt, receiptSha256 }
}

export async function writeReceiptEnvelope(receiptDirectory, envelope) {
  verifyReceiptEnvelope(envelope)
  await requirePlainDirectory(receiptDirectory, 'self-build receipt directory')
  const existingReceipts = await readdir(receiptDirectory, { withFileTypes: true })
  if (existingReceipts.length >= MAX_RECEIPT_COUNT) {
    throw new Error(`Self-build receipt storage reached its ${MAX_RECEIPT_COUNT}-file bound. Archive the existing receipts outside the repository, then retry; evidence is never deleted automatically.`)
  }
  for (const entry of existingReceipts) {
    if (!entry.isFile() || !/^receipt-[a-f0-9-]{36}\.json$/i.test(entry.name)) {
      throw new Error('Self-build receipt storage contains an unexpected or linked entry. Inspect and archive it manually before retrying.')
    }
    const metadata = await lstat(resolve(receiptDirectory, entry.name))
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_RECEIPT_BYTES) {
      throw new Error('Self-build receipt storage contains an unsafe or unbounded entry. Inspect and archive it manually before retrying.')
    }
  }
  const target = resolve(receiptDirectory, `receipt-${envelope.receipt.runId}.json`)
  const temporary = `${target}.candidate-${process.pid}-${randomUUID()}`
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new Error('Self-build evidence receipt exceeds its bounded size.')
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporary, target)
    await unlink(temporary)
    if (process.platform !== 'win32') await chmod(target, 0o444)
    return target
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function verifyReceiptFile(path) {
  const bytes = await readBoundedFile(resolve(path), MAX_RECEIPT_BYTES)
  const envelope = JSON.parse(bytes.toString('utf8'))
  return verifyReceiptEnvelope(envelope)
}

function assertCandidateIdentityEqual(expected, actual, message) {
  const fields = [
    'headCommit',
    'statusPorcelainV2Sha256',
    'statusBytes',
    'binaryPatchSha256',
    'binaryPatchBytes',
    'untrackedManifestSha256',
    'untrackedFileCount',
    'untrackedBytes',
    'treeSha256',
    'treeFileCount',
    'treeBytes',
  ]
  if (fields.some((field) => expected[field] !== actual[field])) throw new Error(message)
}

export function assertMaterializedContentEqual(expected, actual, message) {
  const fields = [
    'headCommit',
    'treeSha256',
    'treeFileCount',
    'treeBytes',
  ]
  if (fields.some((field) => expected[field] !== actual[field])) throw new Error(message)
}

function publicCandidateIdentity(candidate) {
  return {
    headCommit: candidate.headCommit,
    dirty: candidate.dirty,
    statusPorcelainV2Sha256: candidate.statusPorcelainV2Sha256,
    statusBytes: candidate.statusBytes,
    binaryPatchSha256: candidate.binaryPatchSha256,
    binaryPatchBytes: candidate.binaryPatchBytes,
    untrackedManifestSha256: candidate.untrackedManifestSha256,
    untrackedFileCount: candidate.untrackedFileCount,
    untrackedBytes: candidate.untrackedBytes,
    treeSha256: candidate.treeSha256,
    treeFileCount: candidate.treeFileCount,
    treeBytes: candidate.treeBytes,
  }
}

function redactCommand(command) {
  const values = command.args.map((argument) => {
    const normalized = normalizeRelativePath(String(argument))
    if (isAbsolute(String(argument))) {
      if (normalized.includes('/out/runtime')) return '<verified-runtime-root>'
      if (/electron(?:\.exe)?$/i.test(normalized)) return '<verified-electron-executable>'
      if (/pnpm(?:\.c?js)?$/i.test(normalized)) return '<verified-pnpm-cli>'
      return `<absolute:${basename(normalized)}>`
    }
    return normalized
  })
  return { executable: basename(command.executable), args: values }
}

function formatCommandOutcome(record) {
  if (!record) return 'an unknown outcome'
  if (record.supervisorError) return `supervisor error ${record.supervisorError}`
  if (record.signal) return `signal ${record.signal}`
  return `exit code ${record.code}`
}

function sanitizeErrorMessage(error, { root, evaluationRoot }) {
  let message = boundedMessage(error)
  for (const [path, replacement] of [[evaluationRoot, '<evaluation-root>'], [root, '<project-root>']]) {
    if (!path) continue
    message = message.split(path).join(replacement).split(normalizeRelativePath(path)).join(replacement)
  }
  return message
}

function boundedMessage(error) {
  const value = error instanceof Error ? error.message : String(error)
  return value.replace(/[\0\r\n]+/g, ' ').slice(0, 2048)
}

async function requireGitRoot(projectRoot, gitExecutable = 'git') {
  const requested = await realpath(resolve(projectRoot))
  const result = await runGit(gitExecutable, ['rev-parse', '--show-toplevel'], { cwd: requested, maxOutputBytes: 16 * 1024 })
  const reported = await realpath(decodeUtf8(result.stdout, 'Git root').trim())
  if (!samePath(requested, reported)) throw new Error('Self-build must be invoked from the Prime Continuim Git worktree root.')
  return reported
}

async function requirePlainDirectory(path, label) {
  const absolute = resolve(path)
  const metadata = await lstat(absolute)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a plain directory, not a link or special file.`)
  const physical = await realpath(absolute)
  if (!samePath(absolute, physical)) throw new Error(`${label} resolves through a link or reparse point.`)
  return absolute
}

async function requireSafeExistingAncestors(root, relativePath, label) {
  assertSafeGitPath(relativePath)
  const absoluteRoot = await requirePlainDirectory(root, `${label} root`)
  const segments = relativePath.split('/').slice(0, -1)
  let current = absoluteRoot
  for (const segment of segments) {
    current = resolve(current, segment)
    let metadata
    try {
      metadata = await lstat(current)
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return
      throw error
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${label} has a linked or non-directory ancestor: ${normalizeRelativePath(relative(absoluteRoot, current))}`)
    }
    const physical = await realpath(current)
    if (!samePath(current, physical)) {
      throw new Error(`${label} has a reparse ancestor: ${normalizeRelativePath(relative(absoluteRoot, current))}`)
    }
  }
}

async function ensureSafeOwnedDirectory(root, relativeDirectory) {
  assertSafeGitPath(relativeDirectory)
  const absoluteRoot = await requirePlainDirectory(root, 'owned-directory root')
  let current = absoluteRoot
  for (const segment of relativeDirectory.split('/')) {
    current = resolve(current, segment)
    try {
      const metadata = await lstat(current)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('not a plain directory')
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) {
        throw new Error(`Owned self-build directory is linked or unsafe: ${normalizeRelativePath(relative(absoluteRoot, current))}`, { cause: error })
      }
      await mkdir(current)
    }
    const physical = await realpath(current)
    if (!samePath(current, physical)) throw new Error('Owned self-build directory resolves through a reparse point.')
  }
  return current
}

async function ensureSafeParentDirectories(root, relativePath) {
  assertSafeGitPath(relativePath)
  const parent = relativePath.split('/').slice(0, -1).join('/')
  if (!parent) return
  await ensureSafeOwnedDirectory(root, parent)
}

async function requirePathMissing(path, message) {
  try {
    await lstat(path)
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return
    throw error
  }
  throw new Error(message)
}

async function hashRegularFile(path, maxBytes) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.size > maxBytes) throw new Error('Expected a bounded regular file.')
  const bytes = await readFile(path)
  return { type: 'file', executable: (metadata.mode & 0o111) !== 0, size: bytes.byteLength, sha256: sha256(bytes) }
}

function assertManifestEntryMatches(expected, actual, prefix) {
  for (const key of ['type', 'executable', 'size', 'sha256']) {
    if (expected[key] !== actual[key]) throw new Error(`${prefix}: ${expected.path}`)
  }
}

async function readBoundedFile(path, maximumBytes) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`Expected a nonempty regular file no larger than ${maximumBytes} bytes.`)
  }
  return readFile(path)
}

async function sha256File(path) {
  const bytes = await readFile(path)
  return sha256(bytes)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function parseNulPaths(bytes, label) {
  if (bytes.byteLength === 0) return []
  const text = decodeUtf8(bytes, label)
  if (!text.endsWith('\0')) throw new Error(`Git ${label} is not NUL terminated.`)
  const paths = text.slice(0, -1).split('\0')
  for (const path of paths) assertSafeGitPath(path)
  return paths
}

function decodeUtf8(bytes, label) {
  try { return UTF8.decode(bytes) } catch { throw new Error(`Git ${label} is not valid UTF-8.`) }
}

function assertSafeGitPath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Git returned an unsafe candidate path: ${JSON.stringify(path)}`)
  }
}

function isGeneratedOrPrivatePath(path) {
  const original = normalizeRelativePath(path)
  const normalized = process.platform === 'win32' ? original.toLowerCase() : original
  const segments = normalized.split('/')
  const first = segments[0]
  const leaf = segments.at(-1) ?? ''
  return (
    first === '.git' ||
    first?.startsWith('.prime-continuim-workflow.lock') ||
    GENERATED_ROOTS.has(first) ||
    leaf.toLowerCase() === '.ds_store' ||
    leaf.toLowerCase() === 'thumbs.db' ||
    leaf.endsWith('.log') ||
    leaf.endsWith('.tsbuildinfo') ||
    leaf === '.npmrc' ||
    leaf === '.pnpmfile.cjs' ||
    leaf === '.pnpmfile.js' ||
    leaf === '.env' ||
    leaf.startsWith('.env.') ||
    leaf.endsWith('.env')
  )
}

function resolveContained(root, relativePath) {
  assertSafeGitPath(relativePath)
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, ...relativePath.split('/'))
  assertContained(absoluteRoot, target, 'candidate path')
  return target
}

function assertContained(parent, target, label) {
  const normalizedParent = resolve(parent)
  const normalizedTarget = resolve(target)
  const relation = relative(normalizedParent, normalizedTarget)
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} must be a strict child of its owned directory.`)
  }
}

async function resolveExecutableOnPath(name) {
  for (const directory of String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!directory) continue
    const candidate = resolve(directory, name)
    try {
      const metadata = await lstat(candidate)
      if (metadata.isFile()) return candidate
    } catch {}
  }
  return null
}

function resolvePnpmCli() {
  const pnpmCli = process.env.npm_execpath
  if (!pnpmCli || !isAbsolute(pnpmCli) || !basename(pnpmCli).toLowerCase().includes('pnpm')) {
    throw new Error('Prime Continuim self-build must be started through the repo-pinned pnpm command.')
  }
  return resolve(pnpmCli)
}

function normalizeRelativePath(path) {
  return String(path).split(sep).join('/')
}

function normalizeAbsoluteForIdentity(path) {
  const normalized = normalizeRelativePath(resolve(path))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`)
}

function isErrorCode(error, code) {
  return error !== null && typeof error === 'object' && error.code === code
}

function runGit(executable, args, options) {
  const disabledHooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return runCaptured(executable, [
    '--no-optional-locks',
    '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${disabledHooksPath}`,
    ...args,
  ], { ...options, environment: createGitEnvironment(process.env) })
}

function runCaptured(executable, args, { cwd, input, maxOutputBytes, allowFailure = false, timeoutMs = 60_000, environment = process.env }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
      settled = true
      rejectPromise(new Error(`${basename(executable)} command timed out.`))
    }, timeoutMs)
    const capture = (target) => (chunk) => {
      outputBytes += chunk.byteLength
      if (outputBytes > maxOutputBytes && !settled) {
        child.kill('SIGKILL')
        settled = true
        clearTimeout(timer)
        rejectPromise(new Error(`${basename(executable)} command output exceeded ${maxOutputBytes} bytes.`))
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', capture(stdout))
    child.stderr.on('data', capture(stderr))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
    // `exit` can precede the final stdout/stderr data events. Candidate
    // identity must therefore settle only after the stdio pipes close, or a
    // fast Git process can be recorded with a truncated (even empty) patch.
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result = { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
      if (code !== 0 && !allowFailure) {
        rejectPromise(new Error(`${basename(executable)} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}: ${boundedOutput(result.stderr)}`))
      } else {
        resolvePromise(result)
      }
    })
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

function boundedOutput(bytes) {
  return bytes.toString('utf8').replace(/[\0\r\n]+/g, ' ').slice(0, 2048)
}
