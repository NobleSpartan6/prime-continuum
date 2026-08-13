import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertNativeTargetDescriptor,
  assertPathFreeManifest,
  createNativeLaunchProofEnvelope,
  digestArtifactEntries,
  NativeLaunchProofFailure,
  sha256,
  validateNativeObservation,
} from '../../scripts/native-launch-proof-lib.mjs'

const digest = 'a'.repeat(64)
const capturedAt = '2026-08-13T12:00:00.000Z'

function nativeObservation() {
  return {
    renderer: {
      protocol: 'file:',
      hasVisualState: false,
      nativeBridge: true,
      previewUserAgent: false,
      previewCopyVisible: false,
    },
    bootstrap: {
      appVersion: '0.1.0',
      connectionPhase: 'online',
      hostId: 'host-one',
    },
    selection: {
      heading: 'Prime RLM proof',
      sidebarTitle: 'Prime RLM proof',
    },
    snapshot: {
      liveReadback: true,
      threadId: 'thread-one',
      hostId: 'host-one',
      executionGenerationId: 'generation-one',
      cursor: '{"threadId":"thread-one","sequence":42}',
      generatedAt: capturedAt,
      title: 'Prime RLM proof',
    },
    outcome: {
      exactCursor: true,
      exactGeneration: true,
      materializedAssistant: true,
      stopReason: 'completed',
      observedAt: capturedAt,
      textSha256: digest,
    },
    children: [
      { agentId: 'child-one', state: 'complete', hasResult: true },
      { agentId: 'child-two', state: 'running', hasResult: false },
    ],
    visible: {
      snapshotAuthority: 'live',
      rlmChildCount: 2,
      rlmResultVisible: true,
      outcomeVisible: true,
    },
  }
}

describe('native launch-proof evidence', () => {
  it('accepts only one packaged, non-preview renderer target on loopback', () => {
    const target = {
      type: 'page',
      url: 'file:///Applications/Prime%20Continuim.app/Contents/Resources/app.asar/out/renderer/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/prime',
    }
    expect(assertNativeTargetDescriptor(target).normalizedPath).toContain('/app.asar/out/renderer/index.html')
    expect(() => assertNativeTargetDescriptor({ ...target, url: 'http://127.0.0.1:5173/?visualState=rlm' }))
      .toThrowError(expect.objectContaining({ code: 'target_not_native' }))
    expect(() => assertNativeTargetDescriptor({ ...target, url: `${target.url}?visualState=rlm` }))
      .toThrowError(expect.objectContaining({ code: 'target_not_native' }))
    expect(() => assertNativeTargetDescriptor({ ...target, webSocketDebuggerUrl: 'ws://192.168.1.4:9222/devtools/page/prime' }))
      .toThrowError(expect.objectContaining({ code: 'target_debugger_untrusted' }))
  })

  it('requires exact live authority plus visible RLM child and outcome evidence', () => {
    const observation = nativeObservation()
    expect(validateNativeObservation(observation)).toMatchObject({
      appVersion: '0.1.0',
      childCount: 2,
      completedChildCount: 1,
      visibleChildCount: 2,
    })

    expect(() => validateNativeObservation({
      ...observation,
      snapshot: { ...observation.snapshot, liveReadback: false },
    })).toThrowError(expect.objectContaining({ code: 'snapshot_not_live' }))
    expect(() => validateNativeObservation({
      ...observation,
      outcome: { ...observation.outcome, exactCursor: false },
    })).toThrowError(expect.objectContaining({ code: 'outcome_not_exact' }))
    expect(() => validateNativeObservation({
      ...observation,
      children: [{ agentId: 'child-one', state: 'complete', hasResult: false }],
      visible: { ...observation.visible, rlmChildCount: 1 },
    })).toThrowError(expect.objectContaining({ code: 'rlm_result_missing' }))
    expect(() => validateNativeObservation({
      ...observation,
      visible: { ...observation.visible, snapshotAuthority: 'cached' },
    })).toThrowError(expect.objectContaining({ code: 'visible_evidence_missing' }))
  })

  it('writes a path-free correlation manifest bound to source, app, runtime, and image bytes', () => {
    const envelope = createNativeLaunchProofEnvelope({
      runId: '12345678-1234-4123-8123-123456789abc',
      capturedAt,
      selfBuildReceipt: {
        receiptSha256: 'b'.repeat(64),
        headCommit: 'c'.repeat(40),
        dirty: false,
        sourceTreeSha256: 'd'.repeat(64),
      },
      app: {
        productName: 'Prime Continuim',
        version: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        appAsarSha256: 'e'.repeat(64),
        mainTreeSha256: 'f'.repeat(64),
        preloadTreeSha256: '1'.repeat(64),
        rendererTreeSha256: '2'.repeat(64),
      },
      runtime: {
        releaseVersion: '0.7.2',
        platform: 'darwin',
        arch: 'arm64',
        pointerSha256: '3'.repeat(64),
        treeSha256: '4'.repeat(64),
        manifestSha256: '5'.repeat(64),
      },
      observation: nativeObservation(),
      captures: [
        { kind: 'rlm', file: 'rlm.png', sha256: '6'.repeat(64), bytes: 100, width: 1440, height: 900 },
        { kind: 'outcome', file: 'outcome.png', sha256: '7'.repeat(64), bytes: 101, width: 1440, height: 900 },
      ],
    })

    expect(envelope.manifest).toMatchObject({
      kind: 'prime_continuim_native_launch_proof',
      authority: { source: 'live' },
      boundary: {
        processLaunched: false,
        rendererFixture: false,
        providerInvoked: false,
        oauthInvoked: false,
        uiPresentationChanged: true,
        sourceCommitAuthenticated: false,
        packageSignedOrNotarized: false,
      },
    })
    expect(envelope.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(envelope)).not.toContain('/Users/')
    expect(() => assertPathFreeManifest({ leaked: '/Users/operator/private/project' }))
      .toThrowError(expect.objectContaining({ code: 'manifest_path_leak' }))
    expect(() => assertPathFreeManifest({ leaked: '/etc/private-project' }))
      .toThrowError(expect.objectContaining({ code: 'manifest_path_leak' }))
  })

  it('digests artifact entries with the canonical self-build ordering', () => {
    expect(digestArtifactEntries([
      { path: 'z.js', size: 2, sha256: sha256('zz') },
      { path: 'a.js', size: 1, sha256: sha256('a') },
    ])).toEqual({
      treeSha256: sha256('[{"path":"a.js","sha256":"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb","size":1},{"path":"z.js","sha256":"4a60bf7d4bc1e485744cf7e8d0860524752fca1ce42331be7c439fd23043f151","size":2}]'),
      fileCount: 2,
      totalBytes: 3,
    })
  })

  it('keeps the capture lane attach-only and separate from preview fixtures', async () => {
    const source = await readFile(resolve('scripts/capture-native-launch-proof.mjs'), 'utf8')
    expect(source).not.toContain("node:child_process")
    expect(source).not.toMatch(/\bspawn(?:Sync)?\s*\(/)
    expect(source).not.toContain('capture-renderer-preview')
    expect(source).not.toContain('visualState=')
    expect(source).not.toMatch(/(?:signIn|beginOAuth|submitPrompt|startResident|createThread)\s*\(/)
    expect(source).toContain("bridge.requestSnapshot")
    expect(source).toContain("Page.captureScreenshot")
  })

  it('exposes stable error codes for operator-facing fail-closed output', () => {
    try {
      validateNativeObservation({})
      throw new Error('expected validation failure')
    } catch (error) {
      expect(error).toBeInstanceOf(NativeLaunchProofFailure)
      expect((error as NativeLaunchProofFailure).code).toBe('renderer_invalid')
    }
  })
})
