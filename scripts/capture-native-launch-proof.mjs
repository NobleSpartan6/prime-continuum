#!/usr/bin/env node

import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  assertNativeTargetDescriptor,
  createNativeLaunchProofEnvelope,
  digestArtifactEntries,
  NativeLaunchProofFailure,
  sha256,
} from './native-launch-proof-lib.mjs'
import { canonicalJson, verifyReceiptEnvelope } from './self-build-evidence-lib.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const MAX_DEBUG_TARGET_BYTES = 1024 * 1024
const MAX_RECEIPT_BYTES = 512 * 1024
const MAX_POINTER_BYTES = 64 * 1024
const CDP_TIMEOUT_MS = 10_000

let pendingDirectory
let published = false

try {
  const args = parseArgs(process.argv.slice(2))
  const runId = randomUUID()
  const outputRoot = resolve(args.output)
  pendingDirectory = join(outputRoot, `.pending-${runId}`)
  const publishedDirectory = join(outputRoot, `run-${runId}`)
  const receiptEnvelope = await readVerifiedReceipt(args.selfBuildReceipt)
  const targets = await readDebugTargets(args.debugPort)
  const candidates = targets.filter((target) => {
    try {
      assertNativeTargetDescriptor(target)
      return true
    } catch {
      return false
    }
  })
  if (candidates.length !== 1) {
    throw new NativeLaunchProofFailure(
      'native_target_ambiguous',
      `Expected exactly one packaged Prime Continuim renderer; found ${candidates.length}.`,
    )
  }
  const target = candidates[0]
  const { url } = assertNativeTargetDescriptor(target)
  if (new URL(target.webSocketDebuggerUrl).port !== String(args.debugPort)) {
    throw new NativeLaunchProofFailure('debugger_port_mismatch', 'The renderer debugger target moved to a different port.')
  }

  const appAsarPath = deriveAppAsarPath(url)
  const packageIdentity = await inspectPackageIdentity(appAsarPath, receiptEnvelope)
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
  try {
    await cdp.command('Runtime.enable')
    await cdp.command('Page.enable')
    const firstRead = normalizeObservation(await cdp.evaluate(nativeStateExpression()))
    const rlmVisibility = await stageRlmEvidence(cdp)

    await mkdir(outputRoot, { recursive: true })
    await mkdir(pendingDirectory, { mode: 0o700 })
    const rlmCapture = await capturePng(cdp, pendingDirectory, 'rlm')

    const outcomeVisibility = await stageOutcomeEvidence(cdp)
    const outcomeCapture = await capturePng(cdp, pendingDirectory, 'outcome')
    const finalRead = normalizeObservation(await cdp.evaluate(nativeStateExpression(firstRead.snapshot.cursorObject)))
    assertStableAuthority(firstRead, finalRead)
    finalRead.visible = {
      snapshotAuthority: outcomeVisibility.snapshotAuthority,
      rlmChildCount: rlmVisibility.rlmChildCount,
      rlmResultVisible: rlmVisibility.rlmResultVisible,
      outcomeVisible: outcomeVisibility.outcomeVisible,
    }

    const envelope = createNativeLaunchProofEnvelope({
      runId,
      capturedAt: new Date().toISOString(),
      selfBuildReceipt: {
        receiptSha256: receiptEnvelope.receiptSha256,
        headCommit: receiptEnvelope.receipt.source.headCommit,
        dirty: receiptEnvelope.receipt.source.dirty,
        sourceTreeSha256: receiptEnvelope.receipt.source.treeSha256,
      },
      app: packageIdentity.app,
      runtime: packageIdentity.runtime,
      observation: finalRead,
      captures: [rlmCapture, outcomeCapture],
    })
    await writeFile(join(pendingDirectory, 'manifest.json'), `${canonicalJson(envelope)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(pendingDirectory, publishedDirectory)
    published = true
    process.stdout.write(`${publishedDirectory}\n${envelope.manifestSha256}\n`)
  } finally {
    cdp.close()
  }
} catch (error) {
  const code = error instanceof NativeLaunchProofFailure ? error.code : 'native_launch_proof_failed'
  process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  if (!published && pendingDirectory) await rm(pendingDirectory, { recursive: true, force: true }).catch(() => undefined)
}

function parseArgs(argv) {
  let debugPort
  let selfBuildReceipt
  let output = 'out/native-launch-proof'
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--debug-port') debugPort = Number(argv[++index])
    else if (argument === '--self-build-receipt') selfBuildReceipt = argv[++index]
    else if (argument === '--output') output = argv[++index]
    else if (argument === '--help') {
      process.stdout.write('Usage: node scripts/capture-native-launch-proof.mjs --debug-port <port> --self-build-receipt <receipt.json> [--output <directory>]\n')
      process.exit(0)
    } else throw new NativeLaunchProofFailure('argument_unknown', `Unknown argument: ${argument}`)
  }
  if (!Number.isInteger(debugPort) || debugPort < 1_024 || debugPort > 65_535) {
    throw new NativeLaunchProofFailure('debug_port_invalid', '--debug-port must be an unprivileged TCP port.')
  }
  if (typeof selfBuildReceipt !== 'string' || !selfBuildReceipt) {
    throw new NativeLaunchProofFailure('receipt_required', '--self-build-receipt is required.')
  }
  if (typeof output !== 'string' || !output) throw new NativeLaunchProofFailure('output_invalid', '--output is invalid.')
  return { debugPort, selfBuildReceipt: resolve(selfBuildReceipt), output }
}

async function readVerifiedReceipt(path) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_RECEIPT_BYTES) {
    throw new NativeLaunchProofFailure('receipt_file_invalid', 'The self-build receipt must be a bounded regular file.')
  }
  const envelope = verifyReceiptEnvelope(JSON.parse(await readFile(path, 'utf8')))
  if (envelope.receipt.outcome !== 'passed') {
    throw new NativeLaunchProofFailure('receipt_not_passing', 'A passing canonical self-build receipt is required.')
  }
  return envelope
}

async function readDebugTargets(port) {
  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })
  } catch (error) {
    throw new NativeLaunchProofFailure('debugger_unavailable', `No already-running renderer debugger answered on 127.0.0.1:${port}.`)
  }
  if (!response.ok) throw new NativeLaunchProofFailure('debugger_rejected', `Renderer debugger returned HTTP ${response.status}.`)
  const text = await readBoundedResponseText(response, MAX_DEBUG_TARGET_BYTES)
  const targets = JSON.parse(text)
  if (!Array.isArray(targets) || targets.length > 128) throw new NativeLaunchProofFailure('debugger_response_invalid', 'Renderer debugger target list is invalid.')
  return targets
}

async function readBoundedResponseText(response, maximumBytes) {
  if (!response.body) throw new NativeLaunchProofFailure('debugger_response_invalid', 'Renderer debugger returned no target-list body.')
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => undefined)
      throw new NativeLaunchProofFailure('debugger_response_oversized', 'Renderer debugger target list exceeded its byte limit.')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, bytes).toString('utf8')
}

function deriveAppAsarPath(rendererUrl) {
  const rendererPath = fileURLToPath(rendererUrl)
  const marker = `${sep}app.asar${sep}`
  const markerIndex = rendererPath.lastIndexOf(marker)
  if (markerIndex < 0) throw new NativeLaunchProofFailure('app_archive_missing', 'The native renderer did not originate inside app.asar.')
  return rendererPath.slice(0, markerIndex + `${sep}app.asar`.length)
}

async function inspectPackageIdentity(appAsarPath, receiptEnvelope) {
  const metadata = await lstat(appAsarPath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new NativeLaunchProofFailure('app_archive_invalid', 'The attached app archive is not a regular file.')
  }
  const packageJson = parseArchiveJson(appAsarPath, 'package.json', 256 * 1024)
  if (packageJson.name !== 'prime-continuim' || typeof packageJson.version !== 'string') {
    throw new NativeLaunchProofFailure('app_package_invalid', 'The attached archive is not a Prime Continuim package.')
  }
  const expectedRoots = new Map(receiptEnvelope.receipt.artifacts.roots.map((root) => [root.path, root]))
  const treeResults = {}
  for (const root of ['out/main', 'out/preload', 'out/renderer']) {
    const observed = digestAsarTree(appAsarPath, root)
    const expected = expectedRoots.get(root)
    if (
      !expected ||
      observed.treeSha256 !== expected.treeSha256 ||
      observed.fileCount !== expected.fileCount ||
      observed.totalBytes !== expected.totalBytes
    ) {
      throw new NativeLaunchProofFailure('app_source_mismatch', `Packaged ${root} bytes do not match the supplied self-build receipt.`)
    }
    treeResults[root] = observed
  }

  const resourcesDirectory = dirname(appAsarPath)
  const hostdBundlePath = join(resourcesDirectory, 'hostd', 'hostd.cjs')
  const hostdBundleSha256 = await sha256BoundedRegularFile(
    hostdBundlePath,
    256 * 1024 * 1024,
    'packaged hostd bundle',
  )
  const runtimeAttestationBytes = asar.extractFile(appAsarPath, 'out/main/runtime-attestation.json')
  if (!Buffer.isBuffer(runtimeAttestationBytes) || runtimeAttestationBytes.length < 1 || runtimeAttestationBytes.length > 256 * 1024) {
    throw new NativeLaunchProofFailure('runtime_attestation_invalid', 'The packaged runtime attestation is not a bounded file.')
  }
  const runtimeAttestation = parseRuntimeAttestationIdentity(runtimeAttestationBytes)
  const pointerPath = join(resourcesDirectory, 'runtime-seed', 'current.json')
  const pointerMetadata = await lstat(pointerPath)
  if (!pointerMetadata.isFile() || pointerMetadata.isSymbolicLink() || pointerMetadata.size < 1 || pointerMetadata.size > MAX_POINTER_BYTES) {
    throw new NativeLaunchProofFailure('runtime_pointer_invalid', 'The packaged runtime pointer is not a bounded regular file.')
  }
  const pointerBytes = await readFile(pointerPath)
  const pointer = JSON.parse(pointerBytes.toString('utf8'))
  const expectedRuntime = receiptEnvelope.receipt.toolchain.runtimeSeed
  if (
    sha256(pointerBytes) !== expectedRuntime.pointerSha256 ||
    pointer.releaseVersion !== expectedRuntime.releaseVersion ||
    pointer.platform !== expectedRuntime.platform ||
    pointer.arch !== expectedRuntime.arch ||
    pointer.treeSha256 !== expectedRuntime.treeSha256 ||
    pointer.manifestSha256 !== expectedRuntime.manifestSha256
  ) {
    throw new NativeLaunchProofFailure('runtime_source_mismatch', 'The packaged runtime does not match the supplied self-build receipt.')
  }

  return {
    app: {
      productName: typeof packageJson.productName === 'string' ? packageJson.productName : 'Prime Continuim',
      version: packageJson.version,
      platform: pointer.platform,
      arch: pointer.arch,
      appAsarSha256: await sha256File(appAsarPath),
      hostdBundleSha256,
      mainTreeSha256: treeResults['out/main'].treeSha256,
      preloadTreeSha256: treeResults['out/preload'].treeSha256,
      rendererTreeSha256: treeResults['out/renderer'].treeSha256,
    },
    runtime: {
      releaseVersion: pointer.releaseVersion,
      runtimeBuildId: runtimeAttestation.runtimeBuildId,
      platform: pointer.platform,
      arch: pointer.arch,
      pointerSha256: sha256(pointerBytes),
      treeSha256: pointer.treeSha256,
      manifestSha256: pointer.manifestSha256,
      filesSha256: runtimeAttestation.filesSha256,
      trustAnchorId: sha256(runtimeAttestationBytes),
    },
  }
}

function parseRuntimeAttestationIdentity(bytes) {
  let attestation
  try {
    attestation = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new NativeLaunchProofFailure('runtime_attestation_invalid', 'The packaged runtime attestation is not valid JSON.')
  }
  const runtime = attestation?.runtime
  const manifest = attestation?.manifest
  const tree = attestation?.tree
  if (
    runtime?.name !== 'prime-agent' ||
    typeof runtime.releaseVersion !== 'string' ||
    typeof runtime.runtimeBuildId !== 'string' ||
    typeof runtime.platform !== 'string' ||
    typeof runtime.arch !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest?.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(tree?.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(tree?.filesSha256 ?? '')
  ) {
    throw new NativeLaunchProofFailure('runtime_attestation_invalid', 'The packaged runtime attestation has no exact runtime identity.')
  }
  return {
    releaseVersion: runtime.releaseVersion,
    runtimeBuildId: runtime.runtimeBuildId,
    platform: runtime.platform,
    arch: runtime.arch,
    manifestSha256: manifest.sha256,
    treeSha256: tree.sha256,
    filesSha256: tree.filesSha256,
  }
}

function parseArchiveJson(archivePath, path, maximumBytes) {
  const bytes = asar.extractFile(archivePath, path)
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximumBytes) {
    throw new NativeLaunchProofFailure('archive_entry_invalid', `Packaged ${path} is not a bounded file.`)
  }
  return JSON.parse(bytes.toString('utf8'))
}

function digestAsarTree(archivePath, root) {
  const prefix = `/${root}/`
  const entries = []
  let totalBytes = 0
  for (const packagePath of asar.listPackage(archivePath).filter((path) => path.startsWith(prefix)).sort(compareUtf8)) {
    const relativePath = packagePath.slice(prefix.length)
    const metadata = asar.statFile(archivePath, packagePath.slice(1), false)
    if (!Number.isSafeInteger(metadata?.size)) continue
    const bytes = asar.extractFile(archivePath, packagePath.slice(1))
    totalBytes += bytes.length
    if (entries.length >= 50_000 || totalBytes > 512 * 1024 * 1024) {
      throw new NativeLaunchProofFailure('app_tree_oversized', `Packaged ${root} exceeds the capture evidence limit.`)
    }
    entries.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) })
  }
  return digestArtifactEntries(entries)
}

function nativeStateExpression(expectedCursor) {
  const expected = expectedCursor === undefined ? 'undefined' : JSON.stringify(expectedCursor)
  return `(async () => {
    const fail = (message) => { throw new Error(message) }
    const unwrap = (value, label) => {
      if (!value || value.ok !== true) fail(label + ' failed')
      return value.value
    }
    const bridge = window.prime
    if (!bridge || typeof bridge.bootstrap !== 'function' || typeof bridge.requestSnapshot !== 'function') fail('native bridge unavailable')
    const bootstrap = unwrap(await bridge.bootstrap(), 'bootstrap')
    const hostId = bootstrap?.connection?.hostId
    const cache = bootstrap?.cache
    const entry = cache?.version === 3 ? cache?.entries?.[hostId] : cache
    const cached = entry?.lastSnapshot ?? cache?.lastSnapshot
    if (!hostId || !cached?.thread?.threadId || !cached?.latestCursor) fail('selected cache snapshot unavailable')
    const expectedCursor = ${expected}
    const requestCursor = expectedCursor ?? cached.latestCursor
    const live = unwrap(await bridge.requestSnapshot({ threadId: cached.thread.threadId, cursor: requestCursor }), 'snapshot readback')
    const cursorEqual = (left, right) => Boolean(left && right &&
      left.threadId === right.threadId &&
      left.executionGenerationId === right.executionGenerationId &&
      left.generation === right.generation &&
      left.sequence === right.sequence)
    if (!cursorEqual(live.latestCursor, requestCursor)) fail('snapshot cursor drifted')
    const outcome = live.latestTurnOutcome
    const terminal = outcome?.terminalAssistant
    const block = live.materializedRecentBlocks?.find((candidate) => candidate.blockId === terminal?.blockId && candidate.kind === 'assistant')
    const selected = document.querySelector('.thread-row[aria-current="page"] .thread-row__title')
    const heading = document.querySelector('#thread-heading')
    return {
      renderer: {
        protocol: location.protocol,
        hasVisualState: new URL(location.href).searchParams.has('visualState'),
        nativeBridge: true,
        previewUserAgent: navigator.userAgent.includes('PrimeContinuimVisualQA'),
        previewCopyVisible: document.body.innerText.includes('Preview simulation'),
      },
      bootstrap: {
        appVersion: bootstrap.appVersion,
        connectionPhase: bootstrap?.connection?.phase,
        hostId,
      },
      liveRuntime: {
        connectionPath: bootstrap?.connection?.path,
        hostdBuildIdentity: bootstrap?.connection?.hostdBuildIdentity,
        readinessKind: bootstrap?.connection?.runtimeReadiness?.kind,
        readinessStatus: bootstrap?.connection?.runtimeReadiness?.snapshot?.status,
        trustAnchorId: bootstrap?.connection?.runtimeReadiness?.snapshot?.trustAnchorId,
        target: bootstrap?.connection?.runtimeReadiness?.snapshot?.target,
      },
      selection: {
        heading: heading?.textContent?.trim(),
        sidebarTitle: selected?.textContent?.trim(),
      },
      snapshot: {
        liveReadback: true,
        threadId: live.thread.threadId,
        hostId: live.thread.currentLocation.hostId,
        executionGenerationId: live.thread.currentLocation.executionGenerationId,
        cursor: JSON.stringify(live.latestCursor),
        cursorObject: live.latestCursor,
        generatedAt: live.generatedAt,
        title: live.thread.title,
      },
      outcome: {
        exactCursor: cursorEqual(outcome?.observedCursor, live.latestCursor),
        exactGeneration: outcome?.observedCursor?.executionGenerationId === live.thread.currentLocation.executionGenerationId,
        materializedAssistant: Boolean(block?.text?.trim()),
        stopReason: outcome?.stopReason,
        observedAt: outcome?.observedAt,
        text: block?.text?.trim(),
      },
      children: (live.childAgents ?? []).map((child) => ({
        agentId: child.agentId,
        state: child.state,
        hasResult: child.state === 'complete' && Boolean(child.answerPreview?.trim() || child.recap?.trim() || child.repliedSinceTask),
      })),
    }
  })()`
}

function normalizeObservation(value) {
  if (!value?.outcome || typeof value.outcome.text !== 'string' || !value.outcome.text.trim()) {
    throw new NativeLaunchProofFailure('outcome_text_missing', 'The exact terminal assistant outcome has no materialized text.')
  }
  value.outcome.textSha256 = sha256(Buffer.from(value.outcome.text))
  delete value.outcome.text
  return value
}

async function stageRlmEvidence(cdp) {
  await openInspector(cdp)
  await cdp.evaluate(`document.querySelector('#inspector-tab-session')?.click()`)
  const visible = await waitFor(cdp, `(() => {
    const panel = document.querySelector('#inspector-panel-session .runtime-subsection--rlm')
    const agents = panel?.querySelectorAll('[data-runtime-agent]') ?? []
    const result = panel?.querySelector('.rlm-map__result')
    if (result) result.open = true
    const resultText = result?.querySelector('p')?.textContent?.trim()
    if (resultText) result.scrollIntoView({ block: 'center' })
    const bounds = result?.getBoundingClientRect()
    const visible = bounds && bounds.bottom > 0 && bounds.top < window.innerHeight
    return panel && agents.length > 0 && resultText && visible ? { rlmChildCount: agents.length, rlmResultVisible: true } : null
  })()`)
  return visible
}

async function stageOutcomeEvidence(cdp) {
  await openInspector(cdp)
  await cdp.evaluate(`document.querySelector('#inspector-tab-review')?.click()`)
  return await waitFor(cdp, `(() => {
    const panel = document.querySelector('#inspector-panel-review .outcome-review')
    const state = panel?.querySelector('.outcome-review__state')?.textContent?.trim() ?? ''
    const result = panel?.querySelector('.outcome-review__result')?.textContent?.trim() ?? ''
    const current = panel?.querySelector('.outcome-review__proof-scope')?.textContent?.trim() === 'Current snapshot proof'
    if (!panel || !current || state.startsWith('Last reported') || !result || result === 'No written result yet.') return null
    panel.querySelector('.outcome-review__result')?.scrollIntoView({ block: 'center' })
    const bounds = panel.querySelector('.outcome-review__result')?.getBoundingClientRect()
    return bounds && bounds.bottom > 0 && bounds.top < window.innerHeight
      ? { snapshotAuthority: 'live', outcomeVisible: true }
      : null
  })()`)
}

async function openInspector(cdp) {
  await cdp.evaluate(`(() => {
    if (!document.querySelector('#thread-inspector')) document.querySelector('button[aria-label="Open inspector"]')?.click()
    return true
  })()`)
  await waitFor(cdp, `Boolean(document.querySelector('#thread-inspector'))`)
}

async function waitFor(cdp, expression) {
  const deadline = Date.now() + CDP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const value = await cdp.evaluate(expression)
    if (value) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new NativeLaunchProofFailure('visible_evidence_timeout', 'The required native RLM evidence did not become visible.')
}

async function capturePng(cdp, directory, kind) {
  const result = await cdp.command('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  })
  const bytes = Buffer.from(result?.data ?? '', 'base64')
  const dimensions = pngDimensions(bytes)
  if (bytes.length < 1_024 || dimensions.width < 720 || dimensions.height < 520) {
    throw new NativeLaunchProofFailure('capture_invalid', `The ${kind} capture is missing or below the native minimum window size.`)
  }
  const file = `${kind}.png`
  await writeFile(join(directory, file), bytes, { flag: 'wx', mode: 0o600 })
  return { kind, file, sha256: sha256(bytes), bytes: bytes.length, ...dimensions }
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
    throw new NativeLaunchProofFailure('capture_not_png', 'DevTools did not return a PNG capture.')
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function assertStableAuthority(first, final) {
  for (const key of ['threadId', 'hostId', 'executionGenerationId', 'cursor']) {
    if (first.snapshot[key] !== final.snapshot[key]) {
      throw new NativeLaunchProofFailure('authority_drifted', `Native ${key} authority changed during capture.`)
    }
  }
}

async function sha256File(path) {
  const hash = (await import('node:crypto')).createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function sha256BoundedRegularFile(path, maximumBytes, label) {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximumBytes) {
    throw new NativeLaunchProofFailure('package_file_invalid', `The ${label} is not a bounded regular file.`)
  }
  const digest = await sha256File(path)
  const after = await lstat(path)
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) {
    throw new NativeLaunchProofFailure('package_file_changed', `The ${label} changed while it was read.`)
  }
  return digest
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => this.onMessage(event.data))
    socket.addEventListener('close', () => this.rejectPending(new Error('Renderer debugger closed.')))
    socket.addEventListener('error', () => this.rejectPending(new Error('Renderer debugger failed.')))
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error('Renderer debugger connection timed out.')), 3_000)
      socket.addEventListener('open', () => { clearTimeout(timeout); resolveOpen() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timeout); rejectOpen(new Error('Renderer debugger connection failed.')) }, { once: true })
    })
    return new CdpClient(socket)
  }

  async command(method, params = {}) {
    const id = this.nextId++
    const promise = new Promise((resolveCommand, rejectCommand) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        rejectCommand(new Error(`DevTools ${method} timed out.`))
      }, CDP_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timeout })
    })
    this.socket.send(JSON.stringify({ id, method, params }))
    return await promise
  }

  async evaluate(expression) {
    const response = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response?.exceptionDetails) throw new NativeLaunchProofFailure('renderer_evaluation_failed', response.exceptionDetails.text ?? 'Native renderer evaluation failed.')
    return response?.result?.value
  }

  onMessage(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8 * 1024 * 1024) return
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (!Number.isSafeInteger(message.id)) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timeout)
    if (message.error) pending.reject(new Error(message.error.message ?? 'DevTools command failed.'))
    else pending.resolve(message.result)
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  close() {
    this.socket.close()
  }
}
