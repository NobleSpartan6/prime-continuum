import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

const RECEIPT_KIND = 'prime_continuim_self_build_evidence'
const INTEGRITY_CLAIM = 'sha256-correlation-only-not-authentication'
const MAX_SOURCE_BYTES = 512 * 1024 * 1024
const MAX_ARTIFACT_FILES = 50_000
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const SUPPORTED_PLATFORMS = new Set(['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32'])
const SUPPORTED_ARCHITECTURES = new Set(['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64'])
const SELF_BUILD_ENVIRONMENT_POLICY = 'prime-continuim-self-build-environment-v1'
const SELF_BUILD_COMMAND_LABELS = [
  'Install exact dependencies from the local pnpm store',
  'Typecheck the candidate',
  'Run the candidate test suite',
  'Verify the prebuilt Prime Agent runtime input before build',
  'Build the attested release candidate',
  'Reverify the prebuilt Prime Agent runtime input',
]
const PASSTHROUGH_ENVIRONMENT = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'HOME',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
])

/**
 * Side-effect-free policy helper shared by the canonical self-build and the
 * bundled host evaluator. This module deliberately has no workflow/spawn
 * imports, top-level filesystem access, or import.meta path resolution.
 */
export function createSelfBuildEnvironment(source = process.env) {
  const environment = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (PASSTHROUGH_ENVIRONMENT.has(upper) || upper.startsWith('LC_')) environment[name] = value
  }
  environment.CI = '1'
  environment.PRIME_CONTINUIM_SELF_BUILD = '1'
  environment.npm_config_offline = 'true'
  environment.PNPM_CONFIG_OFFLINE = 'true'
  environment.COREPACK_ENABLE_NETWORK = '0'
  environment.GIT_TERMINAL_PROMPT = '0'
  environment.GIT_CONFIG_NOSYSTEM = '1'
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  environment.NPM_CONFIG_USERCONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null'
  environment.npm_config_userconfig = environment.NPM_CONFIG_USERCONFIG
  environment.NPM_CONFIG_GLOBALCONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null'
  environment.npm_config_globalconfig = environment.NPM_CONFIG_GLOBALCONFIG
  return environment
}

/** Verifies an already byte-bounded and parsing-safe embedded receipt. */
export function verifyReceiptEnvelope(envelope) {
  validateReceiptEnvelope(envelope)
  return envelope
}

function validateReceiptEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Self-build receipt envelope must be an object.')
  assertExactKeys(envelope, ['integrity', 'receipt', 'receiptSha256'], 'self-build receipt envelope')
  if (envelope.integrity !== INTEGRITY_CLAIM || !SHA256.test(envelope.receiptSha256 ?? '')) throw new Error('Self-build receipt integrity metadata is invalid.')
  const receipt = envelope.receipt
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Self-build receipt payload must be an object.')
  assertExactKeys(receipt, [
    'schemaVersion', 'kind', 'runId', 'startedAt', 'completedAt', 'outcome', 'source', 'toolchain',
    'evaluation', 'artifacts', 'failure', 'boundary',
  ], 'self-build receipt')
  if (receipt.schemaVersion !== 1 || receipt.kind !== RECEIPT_KIND || !/^[a-f0-9-]{36}$/i.test(receipt.runId ?? '')) {
    throw new Error('Self-build receipt identity is invalid.')
  }
  const expected = sha256(Buffer.from(canonicalJson(receipt)))
  if (expected !== envelope.receiptSha256) throw new Error('Self-build receipt digest does not match its payload; the receipt was changed or corrupted.')
  assertIsoTimestamp(receipt.startedAt, 'receipt.startedAt')
  assertIsoTimestamp(receipt.completedAt, 'receipt.completedAt')
  if (receipt.outcome !== 'passed' && receipt.outcome !== 'failed') throw new Error('Self-build receipt outcome is invalid.')
  if (receipt.source !== null) validateReceiptSource(receipt.source)
  if (receipt.toolchain !== null) validateReceiptToolchain(receipt.toolchain)
  validateReceiptEvaluation(receipt.evaluation)
  const expectedWorktreePath = `.prime-continuim-self-build/evaluations/${receipt.runId}`
  if (receipt.evaluation.worktreeRelativePath !== null && receipt.evaluation.worktreeRelativePath !== expectedWorktreePath) {
    throw new Error('Receipt evaluation worktree path does not match its run identity.')
  }
  if (receipt.artifacts !== null) validateReceiptArtifacts(receipt.artifacts)
  if (receipt.failure !== null) validateReceiptFailure(receipt.failure)
  validateReceiptBoundary(receipt.boundary)
  if (receipt.outcome === 'passed' && (!receipt.source || !receipt.toolchain || !receipt.artifacts || receipt.failure !== null)) {
    throw new Error('Passing self-build receipt is missing required evidence or contains a failure.')
  }
  if (receipt.outcome === 'passed') validatePassingReceipt(receipt)
  if (receipt.outcome === 'failed' && receipt.failure === null) throw new Error('Failed self-build receipt is missing failure evidence.')
  assertReceiptPathPrivate(receipt)
}

function validateReceiptSource(value) {
  assertRecord(value, 'receipt source')
  assertExactKeys(value, [
    'headCommit', 'dirty', 'statusPorcelainV2Sha256', 'statusBytes', 'binaryPatchSha256', 'binaryPatchBytes',
    'untrackedManifestSha256', 'untrackedFileCount', 'untrackedBytes', 'treeSha256', 'treeFileCount', 'treeBytes',
  ], 'receipt source')
  if (!/^[a-f0-9]{40,64}$/.test(value.headCommit ?? '') || typeof value.dirty !== 'boolean') throw new Error('Receipt source identity is invalid.')
  for (const key of ['statusPorcelainV2Sha256', 'binaryPatchSha256', 'untrackedManifestSha256', 'treeSha256']) assertSha256(value[key], `source.${key}`)
  for (const key of ['statusBytes', 'binaryPatchBytes', 'untrackedFileCount', 'untrackedBytes', 'treeFileCount', 'treeBytes']) assertBoundedInteger(value[key], 0, MAX_SOURCE_BYTES, `source.${key}`)
}

function validateReceiptToolchain(value) {
  assertRecord(value, 'receipt toolchain')
  assertExactKeys(value, ['node', 'pnpm', 'git', 'electron', 'runtimeSeed', 'environment'], 'receipt toolchain')

  assertRecord(value.node, 'toolchain.node')
  assertExactKeys(value.node, ['version', 'modulesAbi', 'platform', 'arch', 'executableSha256'], 'toolchain.node')
  if (!/^v\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][0-9A-Za-z.-]{1,64})?$/.test(value.node.version ?? '')) throw new Error('Receipt Node version is invalid.')
  if (!/^\d{1,5}$/.test(value.node.modulesAbi ?? '')) throw new Error('Receipt Node modules ABI is invalid.')
  assertPlatform(value.node.platform, 'toolchain.node.platform')
  assertArchitecture(value.node.arch, 'toolchain.node.arch')
  assertSha256(value.node.executableSha256, 'toolchain.node.executableSha256')

  assertRecord(value.pnpm, 'toolchain.pnpm')
  assertExactKeys(value.pnpm, ['version', 'cliSha256', 'storePathSha256'], 'toolchain.pnpm')
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][0-9A-Za-z.-]{1,64})?$/.test(value.pnpm.version ?? '')) throw new Error('Receipt pnpm version is invalid.')
  assertSha256(value.pnpm.cliSha256, 'toolchain.pnpm.cliSha256')
  assertSha256(value.pnpm.storePathSha256, 'toolchain.pnpm.storePathSha256')

  assertRecord(value.git, 'toolchain.git')
  assertExactKeys(value.git, ['version', 'executableSha256'], 'toolchain.git')
  assertBoundedString(value.git.version, 128, 'toolchain.git.version')
  if (!value.git.version.startsWith('git version ')) throw new Error('Receipt Git version is invalid.')
  assertSha256(value.git.executableSha256, 'toolchain.git.executableSha256')

  assertRecord(value.electron, 'toolchain.electron')
  assertExactKeys(value.electron, ['version', 'executableSha256', 'distributionSha256', 'distributionFileCount', 'distributionBytes'], 'toolchain.electron')
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][0-9A-Za-z.-]{1,64})?$/.test(value.electron.version ?? '')) throw new Error('Receipt Electron version is invalid.')
  assertSha256(value.electron.executableSha256, 'toolchain.electron.executableSha256')
  assertSha256(value.electron.distributionSha256, 'toolchain.electron.distributionSha256')
  assertBoundedInteger(value.electron.distributionFileCount, 1, MAX_ARTIFACT_FILES, 'toolchain.electron.distributionFileCount')
  assertBoundedInteger(value.electron.distributionBytes, 1, MAX_ARTIFACT_BYTES, 'toolchain.electron.distributionBytes')

  assertRecord(value.runtimeSeed, 'toolchain.runtimeSeed')
  assertExactKeys(value.runtimeSeed, [
    'releaseVersion', 'platform', 'arch', 'pointerSha256', 'manifestSha256', 'treeSha256',
    'payloadSha256', 'payloadFileCount', 'payloadBytes',
  ], 'toolchain.runtimeSeed')
  assertBoundedString(value.runtimeSeed.releaseVersion, 128, 'toolchain.runtimeSeed.releaseVersion')
  assertPlatform(value.runtimeSeed.platform, 'toolchain.runtimeSeed.platform')
  assertArchitecture(value.runtimeSeed.arch, 'toolchain.runtimeSeed.arch')
  for (const key of ['pointerSha256', 'manifestSha256', 'treeSha256', 'payloadSha256']) assertSha256(value.runtimeSeed[key], `toolchain.runtimeSeed.${key}`)
  assertBoundedInteger(value.runtimeSeed.payloadFileCount, 1, MAX_ARTIFACT_FILES, 'toolchain.runtimeSeed.payloadFileCount')
  assertBoundedInteger(value.runtimeSeed.payloadBytes, 1, MAX_ARTIFACT_BYTES, 'toolchain.runtimeSeed.payloadBytes')

  assertRecord(value.environment, 'toolchain.environment')
  assertExactKeys(value.environment, ['policy', 'names', 'valuesSha256'], 'toolchain.environment')
  if (value.environment.policy !== SELF_BUILD_ENVIRONMENT_POLICY || !Array.isArray(value.environment.names) || value.environment.names.length > 64) throw new Error('Receipt environment policy is invalid.')
  for (const name of value.environment.names) {
    assertBoundedString(name, 128, 'environment variable name')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Receipt environment variable name is invalid.')
  }
  const normalizedEnvironmentNames = [...new Set(value.environment.names)].sort(compareUtf8)
  if (canonicalJson(normalizedEnvironmentNames) !== canonicalJson(value.environment.names)) throw new Error('Receipt environment variable names must be unique and sorted.')
  assertSha256(value.environment.valuesSha256, 'toolchain.environment.valuesSha256')
}

function validateReceiptEvaluation(value) {
  assertRecord(value, 'receipt evaluation')
  assertExactKeys(value, ['isolation', 'dependencyInstall', 'cleanupState', 'worktreeRelativePath', 'toolchainFence', 'toolchainUnchanged', 'commands'], 'receipt evaluation')
  if (value.isolation !== 'detached-temporary-git-worktree' || typeof value.dependencyInstall !== 'string' || value.dependencyInstall.length > 1024) throw new Error('Receipt evaluation metadata is invalid.')
  if (!['not-created', 'removed', 'retained', 'unknown'].includes(value.cleanupState)) throw new Error('Receipt evaluation cleanup state is invalid.')
  if (value.worktreeRelativePath !== null) assertSafeGitPath(value.worktreeRelativePath)
  if ((value.worktreeRelativePath !== null) !== ['retained', 'unknown'].includes(value.cleanupState)) throw new Error('Receipt worktree disposition evidence is inconsistent.')
  if (value.toolchainFence !== 'per-step-metadata-and-final-content' || ![true, false, null].includes(value.toolchainUnchanged)) throw new Error('Receipt toolchain fence evidence is invalid.')
  if (!Array.isArray(value.commands) || value.commands.length > 16) throw new Error('Self-build receipt command evidence is invalid.')
  for (const command of value.commands) {
    assertRecord(command, 'receipt command')
    const exactKeys = ['label', 'command', 'timeoutMs', 'durationMs', 'code', 'signal', 'timedOut', 'supervisorError', 'collateralState']
    if (Object.hasOwn(command, 'postconditionError')) exactKeys.push('postconditionError')
    assertExactKeys(command, exactKeys, 'receipt command')
    assertBoundedString(command.label, 256, 'command label')
    assertRecord(command.command, 'receipt command token vector')
    assertExactKeys(command.command, ['executable', 'args'], 'receipt command token vector')
    assertBoundedString(command.command.executable, 256, 'command executable')
    if (!Array.isArray(command.command.args) || command.command.args.length > 64) throw new Error('Receipt command argument vector is invalid.')
    for (const argument of command.command.args) assertBoundedString(argument, 1024, 'command argument')
    assertBoundedInteger(command.timeoutMs, 1, 24 * 60 * 60 * 1000, 'command timeout')
    assertBoundedInteger(command.durationMs, 0, 24 * 60 * 60 * 1000, 'command duration')
    if (command.code !== null && (!Number.isSafeInteger(command.code) || command.code < 0 || command.code > 255)) throw new Error('Receipt command exit code is invalid.')
    if (command.signal !== null) assertBoundedString(command.signal, 64, 'command signal')
    if (typeof command.timedOut !== 'boolean') throw new Error('Receipt command timeout flag is invalid.')
    if (command.supervisorError !== null && command.supervisorError !== 'workflow_supervisor_failed') throw new Error('Receipt supervisor error is invalid.')
    if (!['supervised_tree_settled', 'unknown_supervised_tree_retained_lease', 'supervisor_failed_after_teardown_attempt'].includes(command.collateralState)) throw new Error('Receipt collateral state is invalid.')
    if (command.postconditionError !== undefined && command.postconditionError !== 'evaluation_postcondition_failed') throw new Error('Receipt command postcondition is invalid.')
  }
}

function validateReceiptArtifacts(value) {
  assertRecord(value, 'receipt artifacts')
  assertExactKeys(value, ['roots', 'aggregateSha256', 'fileCount', 'totalBytes'], 'receipt artifacts')
  assertSha256(value.aggregateSha256, 'artifacts.aggregateSha256')
  if (!Array.isArray(value.roots) || value.roots.length === 0 || value.roots.length > 16) throw new Error('Receipt artifact roots are invalid.')
  const rootPaths = new Set()
  for (const root of value.roots) {
    assertRecord(root, 'receipt artifact root')
    assertExactKeys(root, ['path', 'treeSha256', 'fileCount', 'totalBytes'], 'receipt artifact root')
    assertSafeGitPath(root.path)
    if (rootPaths.has(root.path)) throw new Error('Receipt artifact roots contain a duplicate path.')
    rootPaths.add(root.path)
    assertSha256(root.treeSha256, 'artifact root digest')
    assertBoundedInteger(root.fileCount, 1, MAX_ARTIFACT_FILES, 'artifact file count')
    assertBoundedInteger(root.totalBytes, 1, MAX_ARTIFACT_BYTES, 'artifact byte count')
  }
  assertBoundedInteger(value.fileCount, 1, MAX_ARTIFACT_FILES, 'artifact file count')
  assertBoundedInteger(value.totalBytes, 1, MAX_ARTIFACT_BYTES, 'artifact byte count')
  const expectedFileCount = value.roots.reduce((total, root) => total + root.fileCount, 0)
  const expectedTotalBytes = value.roots.reduce((total, root) => total + root.totalBytes, 0)
  const expectedAggregate = sha256(Buffer.from(canonicalJson(value.roots)))
  if (value.fileCount !== expectedFileCount || value.totalBytes !== expectedTotalBytes || value.aggregateSha256 !== expectedAggregate) {
    throw new Error('Receipt artifact aggregate evidence is inconsistent with its roots.')
  }
}

function validatePassingReceipt(receipt) {
  const evaluation = receipt.evaluation
  if (evaluation.cleanupState !== 'removed' || evaluation.worktreeRelativePath !== null || evaluation.toolchainUnchanged !== true) {
    throw new Error('Passing self-build receipt must confirm worktree cleanup and an unchanged toolchain.')
  }
  if (evaluation.commands.length !== SELF_BUILD_COMMAND_LABELS.length) throw new Error('Passing self-build receipt has an incomplete command sequence.')
  for (let index = 0; index < SELF_BUILD_COMMAND_LABELS.length; index += 1) {
    const command = evaluation.commands[index]
    if (
      command.label !== SELF_BUILD_COMMAND_LABELS[index] || command.code !== 0 || command.signal !== null ||
      command.timedOut !== false || command.supervisorError !== null || command.collateralState !== 'supervised_tree_settled' ||
      Object.hasOwn(command, 'postconditionError')
    ) {
      throw new Error('Passing self-build receipt contains a missing, reordered, or unsuccessful command record.')
    }
  }
  const artifactPaths = receipt.artifacts.roots.map((root) => root.path)
  if (canonicalJson(artifactPaths) !== canonicalJson(['out/main', 'out/preload', 'out/renderer', 'out/hostd'])) {
    throw new Error('Passing self-build receipt does not contain the exact required artifact roots.')
  }
}

function validateReceiptFailure(value) {
  assertRecord(value, 'receipt failure')
  assertExactKeys(value, ['stage', 'name', 'message'], 'receipt failure')
  for (const [key, maximum] of [['stage', 128], ['name', 128], ['message', 2048]]) assertBoundedString(value[key], maximum, `failure.${key}`)
}

function validateReceiptBoundary(value) {
  assertRecord(value, 'receipt boundary')
  assertExactKeys(value, ['securitySandbox', 'autonomousPromotion', 'providerBackedEvaluation', 'packageOrInstallerGate', 'candidateControlledEvaluation', 'mainFilesystemIsolation'], 'receipt boundary')
  if (value.securitySandbox !== false || value.autonomousPromotion !== false || value.providerBackedEvaluation !== false || value.packageOrInstallerGate !== false || value.candidateControlledEvaluation !== true || value.mainFilesystemIsolation !== false) {
    throw new Error('Receipt boundary overstates self-build assurance.')
  }
}

function assertReceiptPathPrivate(value) {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (/[A-Za-z]:[\\/]/.test(current) || /^\\\\/.test(current) || /^\/(?:Users|home|tmp|var|private|opt)\//.test(current)) {
        throw new Error('Self-build receipt contains an absolute filesystem path.')
      }
    } else if (Array.isArray(current)) pending.push(...current)
    else if (current && typeof current === 'object') pending.push(...Object.values(current))
  }
}

export function canonicalJson(value) {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort(compareUtf8)
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function assertSafeGitPath(path) {
  if (
    typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || isAbsolute(path) ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Receipt contains an unsafe relative path: ${JSON.stringify(path)}`)
  }
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`)
}

function assertPlatform(value, label) {
  if (typeof value !== 'string' || !SUPPORTED_PLATFORMS.has(value)) throw new Error(`${label} is not a supported platform identifier.`)
}

function assertArchitecture(value, label) {
  if (typeof value !== 'string' || !SUPPORTED_ARCHITECTURES.has(value)) throw new Error(`${label} is not a supported architecture identifier.`)
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is outside its bounded integer range.`)
}

function assertBoundedString(value, maximum, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be a bounded single-line string.`)
  }
}

function assertIsoTimestamp(value, label) {
  assertBoundedString(value, 64, label)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical ISO timestamp.`)
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort(compareUtf8)
  const sortedExpected = [...expected].sort(compareUtf8)
  if (canonicalJson(actual) !== canonicalJson(sortedExpected)) throw new Error(`${label} has unexpected fields.`)
}
