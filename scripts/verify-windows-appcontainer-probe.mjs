import { lstat, open, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APPCONTAINER_PROBE_MAX_RECEIPT_BYTES,
  AppContainerProbeContractError,
  verifyAppContainerProbeReceiptBytes,
} from './windows-appcontainer-probe-lib.mjs'

const RECEIPT_VERIFIER_KIND = 'prime_continuim_appcontainer_probe_static_verifier_v2'

export async function verifyWindowsAppContainerProbeReceiptFile(receiptPath, testHooks) {
  if (typeof receiptPath !== 'string' || receiptPath.length < 1 || receiptPath.includes('\0')) {
    fail('receipt_path_invalid')
  }
  validateTestHooks(testHooks)

  const lexicalPath = resolve(receiptPath)
  const physicalPath = await realpath(lexicalPath).catch(() => fail('receipt_path_invalid'))
  if (!samePath(lexicalPath, physicalPath)) fail('receipt_path_alias')

  const before = await lstat(lexicalPath, { bigint: true }).catch(() => fail('receipt_path_invalid'))
  validateReceiptFileStat(before)

  const handle = await open(physicalPath, 'r').catch(() => fail('receipt_open_failed'))
  let bytes
  let opened
  let afterRead
  try {
    opened = await handle.stat({ bigint: true })
    validateReceiptFileStat(opened)
    requireSameIdentity(before, opened)
    await requireCanonicalPath(lexicalPath, physicalPath, 'receipt_path_changed')
    bytes = await readBoundedReceipt(handle, opened.size)
    afterRead = await handle.stat({ bigint: true })
    validateReceiptFileStat(afterRead)
    requireSameIdentity(opened, afterRead)
    if (opened.size !== afterRead.size || opened.mtimeNs !== afterRead.mtimeNs) fail('receipt_changed_during_read')
  } finally {
    await handle.close()
  }

  if (bytes.byteLength !== Number(opened.size)) fail('receipt_changed_during_read')
  if (testHooks !== undefined) await testHooks.beforeFinalPathCheck()
  await requireCanonicalPath(lexicalPath, physicalPath, 'receipt_path_replaced')
  const afterPath = await lstat(lexicalPath, { bigint: true }).catch(() => fail('receipt_path_replaced'))
  validateReceiptFileStat(afterPath)
  requireSameIdentity(opened, afterPath, 'receipt_path_replaced')
  if (opened.size !== afterPath.size || opened.mtimeNs !== afterPath.mtimeNs) {
    fail('receipt_path_changed')
  }

  const verified = verifyAppContainerProbeReceiptBytes(bytes)
  return Object.freeze({
    ...verified,
    verifierKind: RECEIPT_VERIFIER_KIND,
    receiptBytes: bytes.byteLength,
  })
}

async function requireCanonicalPath(lexicalPath, expectedPhysicalPath, code) {
  const currentPhysicalPath = await realpath(lexicalPath).catch(() => fail(code))
  if (!samePath(lexicalPath, currentPhysicalPath) || !samePath(expectedPhysicalPath, currentPhysicalPath)) {
    fail(code)
  }
}

function validateTestHooks(value) {
  if (value === undefined) return
  if (
    process.env.VITEST !== 'true' ||
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1 ||
    typeof value.beforeFinalPathCheck !== 'function'
  ) {
    fail('test_hooks_forbidden')
  }
}

async function readBoundedReceipt(handle, expectedSize) {
  const expectedBytes = Number(expectedSize)
  const buffer = Buffer.alloc(expectedBytes + 1)
  let offset = 0
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset !== expectedBytes) fail('receipt_changed_during_read')
  return buffer.subarray(0, offset)
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--receipt' || argv[1].length < 1) {
    fail('usage_invalid')
  }
  return Object.freeze({ receiptPath: argv[1] })
}

function validateReceiptFileStat(value) {
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n) fail('receipt_file_invalid')
  if (value.dev === 0n || value.ino === 0n) fail('receipt_identity_unavailable')
  if (value.size < 2n || value.size > BigInt(APPCONTAINER_PROBE_MAX_RECEIPT_BYTES)) {
    fail(value.size > BigInt(APPCONTAINER_PROBE_MAX_RECEIPT_BYTES) ? 'receipt_oversize' : 'receipt_invalid')
  }
}

function requireSameIdentity(left, right, code = 'receipt_identity_changed') {
  if (left.dev !== right.dev || left.ino !== right.ino) fail(code)
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right
}

function fail(code) {
  throw new AppContainerProbeContractError(code)
}

async function main() {
  try {
    const { receiptPath } = parseArguments(process.argv.slice(2))
    const verified = await verifyWindowsAppContainerProbeReceiptFile(receiptPath)
    process.stdout.write(`${JSON.stringify({
      kind: verified.verifierKind,
      receiptSha256: verified.receiptSha256,
      receiptBytes: verified.receiptBytes,
      outcome: verified.receipt.outcome,
      staticVerifierExitCode: verified.staticVerifierExitCode,
      liveProbeExitCode: verified.liveProbeExitCode,
    })}\n`)
  } catch {
    process.stderr.write('Prime Continuim AppContainer receipt verification failed.\n')
    process.exitCode = 1
  }
}

async function isMainModule() {
  if (process.argv[1] === undefined) return false
  const [entryPhysicalPath, modulePhysicalPath] = await Promise.all([
    realpath(resolve(process.argv[1])).catch(() => resolve(process.argv[1])),
    realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url)),
  ])
  return samePath(entryPhysicalPath, modulePhysicalPath)
}

if (await isMainModule()) await main()
