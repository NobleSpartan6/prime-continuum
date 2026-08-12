import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, open, readFile, readlink, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveMacosDmgArtifact, resolveMacosPackageDirectory } from './macos-packaging-policy.mjs'

const MAX_TREE_ENTRIES = 100_000
const MAX_TREE_BYTES = 4 * 1024 * 1024 * 1024
const MAX_EVIDENCE_BYTES = 128 * 1024
const MAX_TOOL_OUTPUT_BYTES = 2 * 1024 * 1024
const TEAM_ID = /^[A-Z0-9]{10}$/
const SHA256 = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const CODE_BUNDLE_SUFFIX = /\.(?:app|appex|bundle|framework|plugin|xpc)$/i
const MACH_O_MAGICS = new Set(['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe'])

export const MACOS_PRIVACY_PURPOSE_STRINGS = Object.freeze({
  NSDesktopFolderUsageDescription: 'Prime Continuim accesses a Desktop workspace only after you choose it.',
  NSDocumentsFolderUsageDescription: 'Prime Continuim accesses a Documents workspace only after you choose it.',
  NSDownloadsFolderUsageDescription: 'Prime Continuim accesses a Downloads workspace only after you choose it.',
  NSNetworkVolumesUsageDescription: 'Prime Continuim accesses a workspace on a network volume only after you choose it.',
  NSRemovableVolumesUsageDescription: 'Prime Continuim accesses a workspace on a removable volume only after you choose it.',
})

const ACTIONS = Object.freeze({
  DEVELOPMENT_LANE_ONLY: 'Keep pnpm dist local-only and create a separate Developer ID production build plan.',
  PRODUCTION_TEAM_UNCONFIGURED: 'Commit the public ten-character Apple Team ID before admitting production artifacts.',
  PRIVACY_METADATA_INVALID: 'Restore the reviewed user-selected workspace purpose strings in configuration and the packaged Info.plist.',
  ARTIFACT_MISSING: 'Build the exact current-architecture app and DMG before running production readiness.',
  INVENTORY_INVALID: 'Rebuild from reviewed regular files and bounded in-bundle links before signing.',
  UNSIGNED_NESTED_CODE: 'Sign every nested Mach-O and code bundle with the product Developer ID before sealing the outer app.',
  AD_HOC_CODE: 'Replace ad-hoc signatures with the product Developer ID in the production staging tree.',
  CROSS_TEAM_CODE: 'Re-sign nested code with the one reviewed product Team ID or remove it.',
  CODE_TIMESTAMP_MISSING: 'Apply a secure timestamp to every production code signature.',
  CODE_HARDENED_RUNTIME_MISSING: 'Enable hardened runtime for every distributed executable.',
  CODE_GET_TASK_ALLOW: 'Re-sign the affected code without com.apple.security.get-task-allow.',
  NESTED_CODESIGN_STRICT_FAILED: 'Repair the nested signature or bundle seal before outer-app verification.',
  APP_CODESIGN_STRICT_FAILED: 'Seal the complete app with a strict Developer ID signature after nested signing.',
  DMG_UNSIGNED: 'Sign the final DMG with the reviewed Developer ID.',
  DMG_CODESIGN_STRICT_FAILED: 'Recreate and sign the final DMG without later mutation.',
  APP_STAPLE_MISSING_OR_INVALID: 'Staple and validate the accepted notarization ticket on the app.',
  DMG_STAPLE_MISSING_OR_INVALID: 'Staple and validate the accepted notarization ticket on the DMG.',
  APP_SYSTEM_POLICY_FAILED: 'Resolve every syspolicy_check distribution finding before release.',
  APP_GATEKEEPER_FAILED: 'Require Gatekeeper to accept the app as Notarized Developer ID.',
  DMG_GATEKEEPER_FAILED: 'Require Gatekeeper to accept the signed disk image.',
  SIGNED_STAGE_ATTESTATION_MISSING: 'Publish the bounded post-nested-signing, pre-DMG signed-stage identity.',
  SIGNED_STAGE_ATTESTATION_INVALID: 'Regenerate the signed-stage identity from the exact sealed application tree.',
  SIGNED_STAGE_ORDER_INVALID: 'Sign nested code, seal the app, attest it, create the DMG, then submit in that order.',
  NOTARY_RECEIPT_MISSING: 'Provide the bounded accepted notary correlation receipt for this exact DMG.',
  NOTARY_RECEIPT_INVALID: 'Regenerate the notary correlation receipt from an accepted notarytool result and log digest.',
  NOTARY_RECEIPT_IDENTITY_MISMATCH: 'Bind the receipt to this exact DMG, Team ID, bundle ID, architecture, and signed-stage bytes.',
  PLATFORM_UNSUPPORTED: 'Run the production readiness gate on macOS 14 or later with Apple system-policy tools.',
})

export function parseCodeSignatureDisplay(text, { commandSucceeded = true } = {}) {
  const value = String(text ?? '')
  const line = (name) => value.split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}=`))?.slice(name.length + 1)
  const team = line('TeamIdentifier')
  const timestamp = line('Timestamp')
  return Object.freeze({
    signed: Boolean(commandSucceeded),
    identifier: line('Identifier') ?? null,
    adHoc: line('Signature') === 'adhoc' || /\((?:[^)]*,)?adhoc(?:,[^)]*)?\)/.test(value),
    teamId: team && team !== 'not set' ? team : null,
    timestamp: timestamp && !/^(?:none|not set)$/i.test(timestamp) ? timestamp : null,
    hardenedRuntime: /^CodeDirectory .*\([^)]*runtime[^)]*\)$/m.test(value) || /^Runtime Version=/m.test(value),
  })
}

export function entitlementsContainGetTaskAllow(text) {
  const output = String(text ?? '')
  return (
    /<key>\s*com\.apple\.security\.get-task-allow\s*<\/key>\s*<true\s*\/\s*>/i.test(output) ||
    /\[Key\]\s*com\.apple\.security\.get-task-allow\s*\r?\n\s*\[Value\]\s*\r?\n\s*\[Bool\]\s*true\b/i.test(output)
  )
}

export function evaluateCodeSignature(signature, {
  expectedTeamId,
  entitlementsText = '',
  requireHardenedRuntime = true,
} = {}) {
  const failures = []
  if (!signature?.signed) return Object.freeze(['UNSIGNED_NESTED_CODE'])
  if (signature.adHoc) failures.push('AD_HOC_CODE')
  if (expectedTeamId && signature.teamId !== expectedTeamId) failures.push('CROSS_TEAM_CODE')
  if (!signature.timestamp) failures.push('CODE_TIMESTAMP_MISSING')
  if (requireHardenedRuntime && !signature.hardenedRuntime) failures.push('CODE_HARDENED_RUNTIME_MISSING')
  if (entitlementsContainGetTaskAllow(entitlementsText)) failures.push('CODE_GET_TASK_ALLOW')
  return Object.freeze([...new Set(failures)])
}

export function validateMacosPrivacyPurposeStrings(value) {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(MACOS_PRIVACY_PURPOSE_STRINGS).every(([key, expected]) => value[key] === expected),
  )
}

export function validateSignedStageAttestation(value, expected) {
  if (!exactObject(value, [
    'application', 'applicationSealedAt', 'arch', 'attestedAt', 'bundleIdentifier', 'inventory', 'kind',
    'nestedCodeSignedAt', 'phase', 'schemaVersion', 'teamId',
  ])) return Object.freeze(['SIGNED_STAGE_ATTESTATION_INVALID'])
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'prime_continuim_macos_signed_stage_attestation_v1' ||
    value.phase !== 'nested_code_signed_then_application_sealed_before_dmg' ||
    !TEAM_ID.test(value.teamId ?? '') ||
    !exactObject(value.inventory, ['bundleCount', 'machOCount', 'sha256']) ||
    !exactObject(value.application, ['fileCount', 'sha256', 'totalBytes']) ||
    !SHA256.test(value.inventory.sha256 ?? '') ||
    !SHA256.test(value.application.sha256 ?? '') ||
    !nonnegativeIntegers(value.inventory, ['bundleCount', 'machOCount']) ||
    !nonnegativeIntegers(value.application, ['fileCount', 'totalBytes']) ||
    !validTime(value.nestedCodeSignedAt) || !validTime(value.applicationSealedAt) || !validTime(value.attestedAt)
  ) return Object.freeze(['SIGNED_STAGE_ATTESTATION_INVALID'])
  const failures = []
  if (
    value.teamId !== expected.teamId || value.bundleIdentifier !== expected.bundleIdentifier || value.arch !== expected.arch ||
    value.inventory.sha256 !== expected.inventory.sha256 || value.inventory.machOCount !== expected.inventory.machOCount ||
    value.inventory.bundleCount !== expected.inventory.bundleCount || value.application.sha256 !== expected.application.sha256 ||
    value.application.fileCount !== expected.application.fileCount || value.application.totalBytes !== expected.application.totalBytes
  ) failures.push('SIGNED_STAGE_ATTESTATION_INVALID')
  if (!orderedTimes(value.nestedCodeSignedAt, value.applicationSealedAt, value.attestedAt)) failures.push('SIGNED_STAGE_ORDER_INVALID')
  return Object.freeze([...new Set(failures)])
}

export function validateNotaryReceipt(value, expected) {
  if (!exactObject(value, [
    'acceptedAt', 'arch', 'artifact', 'bundleIdentifier', 'dmgCreatedAt', 'kind', 'notaryLogSha256',
    'schemaVersion', 'signedStageAttestationSha256', 'status', 'submissionId', 'submittedAt', 'teamId',
  ])) return Object.freeze(['NOTARY_RECEIPT_INVALID'])
  if (
    value.schemaVersion !== 1 || value.kind !== 'prime_continuim_macos_notary_receipt_v1' ||
    value.status !== 'Accepted' || !UUID.test(value.submissionId ?? '') || !TEAM_ID.test(value.teamId ?? '') ||
    !SHA256.test(value.notaryLogSha256 ?? '') || !SHA256.test(value.signedStageAttestationSha256 ?? '') ||
    !exactObject(value.artifact, ['bytes', 'sha256']) || !SHA256.test(value.artifact.sha256 ?? '') ||
    !nonnegativeIntegers(value.artifact, ['bytes']) || !validTime(value.dmgCreatedAt) ||
    !validTime(value.submittedAt) || !validTime(value.acceptedAt)
  ) return Object.freeze(['NOTARY_RECEIPT_INVALID'])
  const failures = []
  if (
    value.teamId !== expected.teamId || value.bundleIdentifier !== expected.bundleIdentifier || value.arch !== expected.arch ||
    value.artifact.sha256 !== expected.artifact.sha256 || value.artifact.bytes !== expected.artifact.bytes ||
    value.signedStageAttestationSha256 !== expected.signedStageAttestationSha256
  ) failures.push('NOTARY_RECEIPT_IDENTITY_MISMATCH')
  if (Date.parse(value.dmgCreatedAt) < Date.parse(expected.signedStageAttestedAt) || !orderedTimes(value.dmgCreatedAt, value.submittedAt, value.acceptedAt)) {
    failures.push('SIGNED_STAGE_ORDER_INVALID')
  }
  return Object.freeze([...new Set(failures)])
}

export async function verifyMacosDistributionReadiness({ projectRoot, projectPackage, policy, configOnly = false } = {}) {
  const root = resolve(projectRoot)
  const failures = []
  const config = validateSourceConfiguration(projectPackage, policy)
  failures.push(...config.failures)
  if (configOnly) {
    failures.push('DEVELOPMENT_LANE_ONLY')
    return report({ mode: 'config-only', arch: process.arch, failures })
  }
  if (process.platform !== 'darwin') {
    failures.push('PLATFORM_UNSUPPORTED')
    return report({ mode: 'preflight', arch: process.arch, failures })
  }
  if (!(await toolIsRootOwnedExecutable('/usr/bin/codesign')) || !(await toolIsRootOwnedExecutable('/usr/bin/syspolicy_check')) ||
      !(await toolIsRootOwnedExecutable('/usr/bin/xcrun')) || !(await toolIsRootOwnedExecutable('/usr/bin/plutil')) ||
      !(await toolIsRootOwnedExecutable('/usr/sbin/spctl'))) {
    failures.push('PLATFORM_UNSUPPORTED')
    return report({ mode: 'preflight', arch: process.arch, failures })
  }
  const staplerPath = await resolveRootOwnedXcodeTool('stapler')
  if (!staplerPath) {
    failures.push('PLATFORM_UNSUPPORTED')
    return report({ mode: 'preflight', arch: process.arch, failures })
  }

  const artifact = resolveMacosDmgArtifact(root, projectPackage, process.arch)
  const appPath = join(resolveMacosPackageDirectory(root, process.arch), 'Prime Continuim.app')
  let tree
  let dmg
  try {
    ;[tree, dmg] = await Promise.all([inspectApplicationTree(appPath), inspectRegularArtifact(artifact.artifactPath)])
  } catch {
    failures.push('ARTIFACT_MISSING')
    return report({ mode: 'preflight', arch: process.arch, failures })
  }

  const info = await readPlist(join(appPath, 'Contents', 'Info.plist'))
  if (!info || info.CFBundleIdentifier !== policy.bundleIdentifier || !validateMacosPrivacyPurposeStrings(info)) {
    failures.push('PRIVACY_METADATA_INVALID')
  }
  const expectedTeamId = TEAM_ID.test(policy.expectedTeamId ?? '') ? policy.expectedTeamId : undefined
  for (const subject of [...tree.machO, ...tree.bundles]) {
    const display = await runTool('/usr/bin/codesign', ['-d', '--verbose=4', subject.absolute])
    const entitlements = display.ok ? await runTool('/usr/bin/codesign', ['-d', '--entitlements', '-', subject.absolute]) : { ok: false, text: '' }
    failures.push(...evaluateCodeSignature(parseCodeSignatureDisplay(display.text, { commandSucceeded: display.ok }), {
      expectedTeamId,
      entitlementsText: entitlements.text,
    }))
    if (!(await runTool('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', subject.absolute])).ok) {
      failures.push('NESTED_CODESIGN_STRICT_FAILED')
    }
  }

  if (!(await runTool('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath])).ok) failures.push('APP_CODESIGN_STRICT_FAILED')
  if (!(await runTool('/usr/bin/syspolicy_check', ['distribution', appPath])).ok) failures.push('APP_SYSTEM_POLICY_FAILED')
  if (!(await runTool('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])).ok) failures.push('APP_GATEKEEPER_FAILED')
  if (!(await runTool(staplerPath, ['validate', appPath])).ok) failures.push('APP_STAPLE_MISSING_OR_INVALID')

  const dmgDisplay = await runTool('/usr/bin/codesign', ['-d', '--verbose=4', artifact.artifactPath])
  if (!dmgDisplay.ok) failures.push('DMG_UNSIGNED')
  else failures.push(...evaluateCodeSignature(parseCodeSignatureDisplay(dmgDisplay.text), { expectedTeamId, requireHardenedRuntime: false }))
  if (!(await runTool('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', artifact.artifactPath])).ok) failures.push('DMG_CODESIGN_STRICT_FAILED')
  if (!(await runTool('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', artifact.artifactPath])).ok) failures.push('DMG_GATEKEEPER_FAILED')
  if (!(await runTool(staplerPath, ['validate', artifact.artifactPath])).ok) failures.push('DMG_STAPLE_MISSING_OR_INVALID')

  const signedStagePath = `${artifact.artifactPath}.signed-stage.json`
  const notaryReceiptPath = `${artifact.artifactPath}.notary-receipt.json`
  const signedStage = await readBoundedJson(signedStagePath)
  let signedStageBytes
  if (signedStage.state === 'missing') failures.push('SIGNED_STAGE_ATTESTATION_MISSING')
  else if (signedStage.state === 'invalid') failures.push('SIGNED_STAGE_ATTESTATION_INVALID')
  else {
    signedStageBytes = signedStage.bytes
    failures.push(...validateSignedStageAttestation(signedStage.value, {
      teamId: expectedTeamId,
      bundleIdentifier: policy.bundleIdentifier,
      arch: process.arch,
      inventory: tree.inventory,
      application: tree.application,
    }))
  }
  const receipt = await readBoundedJson(notaryReceiptPath)
  if (receipt.state === 'missing') failures.push('NOTARY_RECEIPT_MISSING')
  else if (receipt.state === 'invalid') failures.push('NOTARY_RECEIPT_INVALID')
  else if (!signedStageBytes) failures.push('NOTARY_RECEIPT_INVALID')
  else {
    failures.push(...validateNotaryReceipt(receipt.value, {
      teamId: expectedTeamId,
      bundleIdentifier: policy.bundleIdentifier,
      arch: process.arch,
      artifact: dmg,
      signedStageAttestationSha256: sha256(signedStageBytes),
      signedStageAttestedAt: signedStage.value?.attestedAt,
    }))
  }
  return report({
    mode: 'preflight',
    arch: process.arch,
    failures,
    artifact: dmg,
    inventory: tree.inventory,
    application: tree.application,
  })
}

function validateSourceConfiguration(projectPackage, policy) {
  const failures = []
  if (!exactObject(policy, ['bundleIdentifier', 'expectedTeamId', 'kind', 'productName', 'schemaVersion']) ||
      policy.schemaVersion !== 1 || policy.kind !== 'prime_continuim_macos_distribution_policy_v1' ||
      policy.bundleIdentifier !== 'ai.primeintellect.continuim' || policy.productName !== 'Prime Continuim') {
    failures.push('PRODUCTION_TEAM_UNCONFIGURED')
  } else if (!TEAM_ID.test(policy.expectedTeamId ?? '')) failures.push('PRODUCTION_TEAM_UNCONFIGURED')
  const extendInfo = projectPackage?.build?.mac?.extendInfo
  if (!exactObject(extendInfo, Object.keys(MACOS_PRIVACY_PURPOSE_STRINGS)) || !validateMacosPrivacyPurposeStrings(extendInfo)) {
    failures.push('PRIVACY_METADATA_INVALID')
  }
  return { failures }
}

async function inspectApplicationTree(root) {
  const rootMetadata = await lstat(root)
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), 'invalid app root')
  const resolvedRoot = await realpath(root)
  const records = []
  const machO = []
  const bundles = []
  const pending = [{ absolute: root, relativePath: '' }]
  let totalBytes = 0
  let fileCount = 0
  while (pending.length > 0) {
    const current = pending.pop()
    const entries = await readdir(current.absolute, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
    for (const entry of entries) {
      invariant(records.length < MAX_TREE_ENTRIES && entry.name.normalize('NFC') === entry.name && !/[\0\r\n/\\]/.test(entry.name), 'invalid tree entry')
      const absolute = join(current.absolute, entry.name)
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name
      const metadata = await lstat(absolute)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        records.push(['d', relativePath, metadata.mode & 0o777])
        pending.push({ absolute, relativePath })
        if (CODE_BUNDLE_SUFFIX.test(entry.name)) bundles.push({ absolute, relativePath })
      } else if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1) {
        totalBytes += metadata.size
        fileCount += 1
        invariant(totalBytes <= MAX_TREE_BYTES, 'oversized app tree')
        const digest = await hashRegularFile(absolute)
        records.push(['f', relativePath, metadata.mode & 0o777, metadata.size, digest])
        if (await isMachO(absolute, metadata.size)) machO.push({ absolute, relativePath, sha256: digest, bytes: metadata.size })
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(absolute)
        const targetPath = resolve(dirname(absolute), target)
        const relation = relative(root, targetPath)
        const finalTarget = await realpath(absolute)
        const finalRelation = relative(resolvedRoot, finalTarget)
        invariant(
          target && !isAbsolute(target) && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation) &&
          finalRelation !== '..' && !finalRelation.startsWith(`..${sep}`) && !isAbsolute(finalRelation),
          'escaping app link',
        )
        records.push(['l', relativePath, target])
      } else throw new Error('invalid app tree type')
    }
  }
  records.sort((left, right) => left[1].localeCompare(right[1], 'en-US'))
  machO.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'))
  bundles.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'))
  return Object.freeze({
    machO: Object.freeze(machO),
    bundles: Object.freeze(bundles),
    inventory: Object.freeze({
      machOCount: machO.length,
      bundleCount: bundles.length,
      sha256: sha256(Buffer.from(JSON.stringify({
        machO: machO.map(({ relativePath, sha256: digest, bytes }) => [relativePath, bytes, digest]),
        bundles: bundles.map(({ relativePath }) => relativePath),
      }))),
    }),
    application: Object.freeze({ fileCount, totalBytes, sha256: sha256(Buffer.from(JSON.stringify(records))) }),
  })
}

async function inspectRegularArtifact(path) {
  const metadata = await lstat(path)
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.size > 0, 'invalid artifact')
  return Object.freeze({ bytes: metadata.size, sha256: await hashRegularFile(path) })
}

async function readPlist(path) {
  const outcome = await runTool('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', path])
  if (!outcome.ok) return undefined
  try { return JSON.parse(outcome.text) } catch { return undefined }
}

async function readBoundedJson(path) {
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > MAX_EVIDENCE_BYTES) return { state: 'invalid' }
    const bytes = await readFile(path)
    const after = await lstat(path)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return { state: 'invalid' }
    return { state: 'valid', bytes, value: JSON.parse(bytes.toString('utf8')) }
  } catch (error) {
    return error?.code === 'ENOENT' ? { state: 'missing' } : { state: 'invalid' }
  }
}

async function isMachO(path, bytes) {
  if (bytes < 4) return false
  const handle = await open(path, 'r')
  try {
    const magic = Buffer.alloc(4)
    const read = await handle.read(magic, 0, 4, 0)
    return read.bytesRead === 4 && MACH_O_MAGICS.has(magic.toString('hex'))
  } finally { await handle.close() }
}

async function hashRegularFile(path) {
  const before = await stat(path)
  const hash = createHash('sha256')
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('end', resolveStream)
    stream.once('error', rejectStream)
  })
  const after = await stat(path)
  invariant(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs, 'file changed')
  return hash.digest('hex')
}

async function toolIsRootOwnedExecutable(path) {
  try {
    const metadata = await lstat(path)
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === 0 && (metadata.mode & 0o111) !== 0
  } catch { return false }
}

async function resolveRootOwnedXcodeTool(name) {
  const outcome = await runTool('/usr/bin/xcrun', ['--find', name])
  const candidate = outcome.text.trim()
  if (!outcome.ok || !isAbsolute(candidate) || /[\r\n]/.test(candidate)) return undefined
  return await toolIsRootOwnedExecutable(candidate) ? candidate : undefined
}

function runTool(executable, args) {
  return new Promise((resolveRun) => {
    execFile(executable, args, { encoding: 'utf8', maxBuffer: MAX_TOOL_OUTPUT_BYTES, timeout: 60_000 }, (error, stdout, stderr) => {
      resolveRun({ ok: !error, text: `${stdout ?? ''}\n${stderr ?? ''}` })
    })
  })
}

function report({ mode, arch, failures, artifact, inventory, application }) {
  const counts = new Map()
  for (const code of failures) counts.set(code, (counts.get(code) ?? 0) + 1)
  const findings = [...counts].sort(([left], [right]) => left.localeCompare(right, 'en-US')).map(([code, count]) => Object.freeze({
    code,
    category: code.toLowerCase(),
    count,
    action: ACTIONS[code] ?? 'Resolve the production-readiness policy failure before release.',
  }))
  return Object.freeze({
    schemaVersion: 1,
    kind: 'prime_continuim_macos_distribution_readiness_v1',
    mode,
    status: findings.length === 0 ? 'ready' : 'blocked',
    platform: process.platform,
    arch,
    ...(artifact ? { artifact } : {}),
    ...(inventory ? { inventory } : {}),
    ...(application ? { application } : {}),
    findings: Object.freeze(findings),
  })
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()))
}

function nonnegativeIntegers(value, keys) {
  return keys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function orderedTimes(...values) {
  if (!values.every(validTime)) return false
  return values.every((value, index) => index === 0 || Date.parse(value) >= Date.parse(values[index - 1]))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}
