import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { canonicalJson } from './self-build-evidence-lib.mjs'

export const NATIVE_LAUNCH_PROOF_KIND = 'prime_continuim_native_launch_proof'
export const NATIVE_LAUNCH_PROOF_INTEGRITY = 'sha256-correlation-only-not-authentication'

const SHA256 = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40,64}$/
const UUID = /^[a-f0-9-]{36}$/i
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export class NativeLaunchProofFailure extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'NativeLaunchProofFailure'
    this.code = code
  }
}

export function assertNativeTargetDescriptor(target) {
  if (!target || target.type !== 'page' || typeof target.url !== 'string') {
    fail('target_not_page', 'The selected DevTools target is not a renderer page.')
  }
  let url
  try {
    url = new URL(target.url)
  } catch {
    fail('target_url_invalid', 'The selected DevTools target URL is invalid.')
  }
  const normalizedPath = decodeURIComponent(url.pathname).replaceAll('\\', '/')
  if (
    url.protocol !== 'file:' ||
    !normalizedPath.includes('/app.asar/out/renderer/index.html') ||
    url.searchParams.has('visualState') ||
    url.searchParams.has('surface')
  ) {
    fail('target_not_native', 'The target is not the packaged native Prime Continuim renderer.')
  }
  if (typeof target.webSocketDebuggerUrl !== 'string' || !/^ws:\/\/127\.0\.0\.1:\d+\//.test(target.webSocketDebuggerUrl)) {
    fail('target_debugger_untrusted', 'The target debugger endpoint must be loopback-only.')
  }
  return { url, normalizedPath }
}

export function validateNativeObservation(value) {
  assertRecord(value, 'observation_invalid', 'Native observation')
  const { renderer, bootstrap, selection, snapshot, outcome, children, visible } = value
  assertRecord(renderer, 'renderer_invalid', 'Renderer evidence')
  if (
    renderer.protocol !== 'file:' ||
    renderer.hasVisualState !== false ||
    renderer.nativeBridge !== true ||
    renderer.previewUserAgent !== false ||
    renderer.previewCopyVisible !== false
  ) {
    fail('renderer_not_native', 'The attached renderer did not prove native, non-preview execution.')
  }
  assertRecord(bootstrap, 'bootstrap_invalid', 'Bootstrap evidence')
  if (bootstrap.connectionPhase !== 'online') {
    fail('host_not_live', 'The verified host is not online.')
  }
  requireText(bootstrap.appVersion, 128, 'bootstrap_app_version_invalid', 'Bootstrap app version')
  requireText(bootstrap.hostId, 512, 'bootstrap_host_invalid', 'Bootstrap host identity')

  assertRecord(selection, 'selection_invalid', 'Selected thread evidence')
  const heading = requireText(selection.heading, 255, 'selection_heading_missing', 'Selected thread heading')
  const sidebarTitle = requireText(selection.sidebarTitle, 255, 'selection_sidebar_missing', 'Selected sidebar thread')
  if (heading !== sidebarTitle) fail('selection_mismatch', 'The workbench heading and selected sidebar thread do not match.')

  assertRecord(snapshot, 'snapshot_invalid', 'Live snapshot evidence')
  if (snapshot.liveReadback !== true) fail('snapshot_not_live', 'The exact snapshot was not read back from the live host.')
  for (const [key, label] of [
    ['threadId', 'thread'],
    ['hostId', 'snapshot host'],
    ['executionGenerationId', 'execution generation'],
    ['cursor', 'snapshot cursor'],
    ['title', 'snapshot title'],
  ]) requireText(snapshot[key], 2_048, `snapshot_${key}_invalid`, label)
  requireIso(snapshot.generatedAt, 'snapshot_generated_at_invalid', 'Snapshot generation time')
  if (snapshot.hostId !== bootstrap.hostId) fail('snapshot_host_mismatch', 'The live snapshot belongs to a different host.')
  if (snapshot.title !== heading) fail('snapshot_selection_mismatch', 'The live snapshot is not the thread selected in the workbench.')

  assertRecord(outcome, 'outcome_invalid', 'Outcome evidence')
  if (outcome.exactCursor !== true || outcome.exactGeneration !== true || outcome.materializedAssistant !== true) {
    fail('outcome_not_exact', 'The visible outcome is not bound to the selected thread generation and latest cursor.')
  }
  requireText(outcome.stopReason, 128, 'outcome_stop_reason_missing', 'Outcome stop reason')
  requireIso(outcome.observedAt, 'outcome_observed_at_invalid', 'Outcome observation time')
  requireSha(outcome.textSha256, 'outcome_text_digest_invalid', 'Outcome text digest')

  if (!Array.isArray(children) || children.length === 0) {
    fail('rlm_children_missing', 'The live snapshot has no RLM child agents.')
  }
  const completedChildren = children.filter((child) => {
    assertRecord(child, 'rlm_child_invalid', 'RLM child evidence')
    requireText(child.agentId, 2_048, 'rlm_child_id_invalid', 'RLM child identity')
    requireText(child.state, 64, 'rlm_child_state_invalid', 'RLM child state')
    return child.state === 'complete' && child.hasResult === true
  })
  if (completedChildren.length === 0) fail('rlm_result_missing', 'No completed RLM child has visible result evidence.')

  assertRecord(visible, 'visible_evidence_invalid', 'Visible UI evidence')
  if (
    visible.snapshotAuthority !== 'live' ||
    !Number.isSafeInteger(visible.rlmChildCount) ||
    visible.rlmChildCount < 1 ||
    visible.rlmResultVisible !== true ||
    visible.outcomeVisible !== true
  ) {
    fail('visible_evidence_missing', 'The native UI does not visibly show live RLM child and outcome evidence.')
  }
  if (visible.rlmChildCount < Math.min(children.length, 50)) {
    fail('visible_children_incomplete', 'The native UI does not show the expected RLM child hierarchy.')
  }

  return {
    appVersion: bootstrap.appVersion,
    threadId: snapshot.threadId,
    hostId: snapshot.hostId,
    executionGenerationId: snapshot.executionGenerationId,
    cursor: snapshot.cursor,
    snapshotGeneratedAt: snapshot.generatedAt,
    outcomeObservedAt: outcome.observedAt,
    outcomeStopReason: outcome.stopReason,
    outcomeTextSha256: outcome.textSha256,
    childCount: children.length,
    completedChildCount: completedChildren.length,
    visibleChildCount: visible.rlmChildCount,
    childEvidenceSha256: sha256(Buffer.from(canonicalJson(children.map((child) => ({
      agentIdSha256: sha256(Buffer.from(child.agentId)),
      state: child.state,
      hasResult: child.hasResult === true,
    }))))),
  }
}

export function createNativeLaunchProofEnvelope({
  runId,
  capturedAt,
  selfBuildReceipt,
  app,
  runtime,
  observation,
  captures,
}) {
  if (!UUID.test(runId ?? '')) fail('run_id_invalid', 'Launch-proof run identity is invalid.')
  requireIso(capturedAt, 'captured_at_invalid', 'Capture time')
  assertRecord(selfBuildReceipt, 'receipt_binding_invalid', 'Self-build receipt binding')
  requireSha(selfBuildReceipt.receiptSha256, 'receipt_digest_invalid', 'Self-build receipt digest')
  if (!COMMIT.test(selfBuildReceipt.headCommit ?? '')) fail('source_commit_invalid', 'Source commit identity is invalid.')
  requireSha(selfBuildReceipt.sourceTreeSha256, 'source_tree_invalid', 'Source tree digest')
  if (typeof selfBuildReceipt.dirty !== 'boolean') fail('source_dirty_invalid', 'Source dirty state is invalid.')

  assertRecord(app, 'app_identity_invalid', 'App identity')
  for (const key of ['appAsarSha256', 'mainTreeSha256', 'preloadTreeSha256', 'rendererTreeSha256']) {
    requireSha(app[key], `app_${key}_invalid`, `App ${key}`)
  }
  requireText(app.productName, 128, 'app_product_invalid', 'App product name')
  requireText(app.version, 128, 'app_version_invalid', 'App version')
  requireText(app.platform, 32, 'app_platform_invalid', 'App platform')
  requireText(app.arch, 32, 'app_arch_invalid', 'App architecture')

  assertRecord(runtime, 'runtime_identity_invalid', 'Runtime identity')
  requireText(runtime.releaseVersion, 128, 'runtime_version_invalid', 'Runtime release version')
  requireText(runtime.platform, 32, 'runtime_platform_invalid', 'Runtime platform')
  requireText(runtime.arch, 32, 'runtime_arch_invalid', 'Runtime architecture')
  for (const key of ['pointerSha256', 'treeSha256', 'manifestSha256']) {
    requireSha(runtime[key], `runtime_${key}_invalid`, `Runtime ${key}`)
  }

  const verified = validateNativeObservation(observation)
  if (verified.appVersion !== app.version) fail('app_version_mismatch', 'The native renderer app version does not match the packaged app.')
  if (runtime.platform !== app.platform || runtime.arch !== app.arch) {
    fail('runtime_app_target_mismatch', 'The packaged runtime target does not match the app target.')
  }
  if (!Array.isArray(captures) || captures.length !== 2) fail('captures_invalid', 'Exactly two native captures are required.')
  const expectedKinds = ['rlm', 'outcome']
  captures.forEach((capture, index) => {
    assertRecord(capture, 'capture_invalid', 'Capture evidence')
    if (capture.kind !== expectedKinds[index] || capture.file !== `${expectedKinds[index]}.png`) {
      fail('capture_identity_invalid', 'Native captures must be the ordered RLM and outcome images.')
    }
    requireSha(capture.sha256, 'capture_digest_invalid', 'Capture digest')
    for (const key of ['bytes', 'width', 'height']) {
      if (!Number.isSafeInteger(capture[key]) || capture[key] < 1) fail('capture_measurement_invalid', 'Capture measurements are invalid.')
    }
  })

  const manifest = {
    schemaVersion: 1,
    kind: NATIVE_LAUNCH_PROOF_KIND,
    runId,
    capturedAt,
    source: {
      headCommit: selfBuildReceipt.headCommit,
      dirty: selfBuildReceipt.dirty,
      treeSha256: selfBuildReceipt.sourceTreeSha256,
      selfBuildReceiptSha256: selfBuildReceipt.receiptSha256,
    },
    app: {
      productName: app.productName,
      version: app.version,
      platform: app.platform,
      arch: app.arch,
      appAsarSha256: app.appAsarSha256,
      mainTreeSha256: app.mainTreeSha256,
      preloadTreeSha256: app.preloadTreeSha256,
      rendererTreeSha256: app.rendererTreeSha256,
    },
    runtime: {
      releaseVersion: runtime.releaseVersion,
      platform: runtime.platform,
      arch: runtime.arch,
      pointerSha256: runtime.pointerSha256,
      treeSha256: runtime.treeSha256,
      manifestSha256: runtime.manifestSha256,
    },
    authority: {
      source: 'live',
      threadIdSha256: sha256(Buffer.from(verified.threadId)),
      hostIdSha256: sha256(Buffer.from(verified.hostId)),
      executionGenerationIdSha256: sha256(Buffer.from(verified.executionGenerationId)),
      cursorSha256: sha256(Buffer.from(verified.cursor)),
      snapshotGeneratedAt: verified.snapshotGeneratedAt,
    },
    evidence: {
      outcomeObservedAt: verified.outcomeObservedAt,
      outcomeStopReason: verified.outcomeStopReason,
      outcomeTextSha256: verified.outcomeTextSha256,
      childCount: verified.childCount,
      completedChildCount: verified.completedChildCount,
      visibleChildCount: verified.visibleChildCount,
      childEvidenceSha256: verified.childEvidenceSha256,
    },
    captures,
    boundary: {
      processLaunched: false,
      rendererFixture: false,
      providerInvoked: false,
      oauthInvoked: false,
      hostSnapshotReadOnly: true,
      uiPresentationChanged: true,
      sourceCommitAuthenticated: false,
      packageSignedOrNotarized: false,
    },
  }
  assertPathFreeManifest(manifest)
  return {
    integrity: NATIVE_LAUNCH_PROOF_INTEGRITY,
    manifest,
    manifestSha256: sha256(Buffer.from(canonicalJson(manifest))),
  }
}

export function assertPathFreeManifest(value) {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (
        current.startsWith('file:') ||
        isAbsolute(current) ||
        /^[A-Za-z]:[\\/]/.test(current) ||
        /^\\\\/.test(current) ||
        /^\/(?:Users|home|tmp|var|private|opt)\//.test(current)
      ) fail('manifest_path_leak', 'The launch-proof manifest contains an absolute filesystem path.')
    } else if (Array.isArray(current)) pending.push(...current)
    else if (current && typeof current === 'object') pending.push(...Object.values(current))
  }
  return value
}

export function digestArtifactEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) fail('artifact_entries_missing', 'Artifact tree has no files.')
  const sorted = [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  let totalBytes = 0
  for (const entry of sorted) {
    if (!entry || typeof entry.path !== 'string' || !entry.path || entry.path.startsWith('/') || entry.path.includes('..') || entry.path.includes('\\')) {
      fail('artifact_path_invalid', 'Artifact tree contains an unsafe relative path.')
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail('artifact_size_invalid', 'Artifact tree contains an invalid file size.')
    requireSha(entry.sha256, 'artifact_digest_invalid', 'Artifact file digest')
    totalBytes += entry.size
  }
  return {
    treeSha256: sha256(Buffer.from(canonicalJson(sorted))),
    fileCount: sorted.length,
    totalBytes,
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertRecord(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, `${label} must be an object.`)
}

function requireText(value, maximum, code, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\0\r\n]/.test(value)) {
    fail(code, `${label} must be a bounded single-line string.`)
  }
  return value
}

function requireSha(value, code, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code, `${label} must be a lowercase SHA-256 digest.`)
}

function requireIso(value, code, label) {
  requireText(value, 64, code, label)
  if (!ISO.test(value) || !Number.isFinite(Date.parse(value))) fail(code, `${label} must be a canonical ISO timestamp.`)
}

function fail(code, message) {
  throw new NativeLaunchProofFailure(code, message)
}
