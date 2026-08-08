import { createHash } from 'node:crypto'
import { lstat, open, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  assertReviewedBuildResources,
  assertWindowsInstallerConfiguration,
} from './windows-packaging-policy.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_PATH = resolve(PROJECT_ROOT, 'package.json')
const WINDOWS_I386_MACHINE = 0x14c
const WINDOWS_X64_MACHINE = 0x8664
const PE32_MAGIC = 0x10b
const PE32_PLUS_MAGIC = 0x20b
const MAXIMUM_PE_HEADER_OFFSET = 16 * 1024 * 1024
const execFileAsync = promisify(execFile)

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function parseJsonObject(contents, label) {
  let value
  try {
    value = JSON.parse(contents)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be a JSON object.`)
  return value
}

async function readExactly(handle, length, position, label) {
  const buffer = Buffer.alloc(length)
  let totalBytesRead = 0
  while (totalBytesRead < length) {
    const { bytesRead } = await handle.read(buffer, totalBytesRead, length - totalBytesRead, position + totalBytesRead)
    if (bytesRead === 0) break
    totalBytesRead += bytesRead
  }
  invariant(totalBytesRead === length, `${label} is truncated.`)
  return buffer
}

async function verifyWindowsInstallerEnvelope(handle, size) {
  const dosHeader = await readExactly(handle, 64, 0, 'The installer DOS header')
  invariant(dosHeader.subarray(0, 2).toString('ascii') === 'MZ', 'The installer has no DOS header.')

  const peOffset = dosHeader.readUInt32LE(0x3c)
  invariant(peOffset >= 64 && peOffset <= MAXIMUM_PE_HEADER_OFFSET, `The installer has an invalid PE header offset: ${peOffset}.`)
  invariant(peOffset + 24 <= size, 'The installer PE header is outside the artifact.')

  const peHeader = await readExactly(handle, 24, peOffset, 'The installer PE header')
  invariant(peHeader.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0, 0])), 'The installer has no PE signature.')
  const machine = peHeader.readUInt16LE(4)
  invariant(
    machine === WINDOWS_I386_MACHINE || machine === WINDOWS_X64_MACHINE,
    `The installer bootstrap uses an unsupported Windows PE machine type: 0x${machine.toString(16)}.`,
  )

  const sectionCount = peHeader.readUInt16LE(6)
  const optionalHeaderSize = peHeader.readUInt16LE(20)
  invariant(sectionCount > 0, 'The installer PE image has no sections.')
  invariant(optionalHeaderSize >= 2, 'The installer PE optional header is missing.')
  invariant(peOffset + 24 + optionalHeaderSize + sectionCount * 40 <= size, 'The installer PE section table is outside the artifact.')

  const optionalHeader = await readExactly(handle, optionalHeaderSize, peOffset + 24, 'The installer PE optional header')
  const optionalHeaderMagic = optionalHeader.readUInt16LE(0)
  invariant(
    (machine === WINDOWS_I386_MACHINE && optionalHeaderMagic === PE32_MAGIC) ||
      (machine === WINDOWS_X64_MACHINE && optionalHeaderMagic === PE32_PLUS_MAGIC),
    'The installer bootstrap PE machine type and optional-header format do not agree.',
  )

  const sectionTable = await readExactly(handle, sectionCount * 40, peOffset + 24 + optionalHeaderSize, 'The installer PE section table')
  let maximumRawEnd = 0
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionOffset = index * 40
    const rawSize = sectionTable.readUInt32LE(sectionOffset + 16)
    const rawPointer = sectionTable.readUInt32LE(sectionOffset + 20)
    maximumRawEnd = Math.max(maximumRawEnd, rawPointer + rawSize)
  }

  invariant(maximumRawEnd > 0 && maximumRawEnd <= size, 'The installer has an invalid or truncated PE section payload.')
  invariant(size > maximumRawEnd, 'The configured installer artifact has no nonempty overlay after its PE image.')

  return {
    bootstrapMachine: machine === WINDOWS_I386_MACHINE ? 'i386' : 'x64',
    peOffset,
    sectionCount,
    peOverlayBytes: size - maximumRawEnd,
  }
}

async function hashOpenFile(handle) {
  const hash = createHash('sha256')
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function projectRelative(path) {
  return relative(PROJECT_ROOT, path).split(sep).join('/')
}

async function assertSafeChecksumDestination(path) {
  try {
    const metadata = await lstat(path)
    invariant(metadata.isFile() && !metadata.isSymbolicLink(), 'The Windows installer checksum destination is not a regular file.')
    invariant(metadata.nlink === 1, 'The Windows installer checksum destination must not be a hard link.')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return
    throw error
  }
}

async function readWindowsAuthenticodeStatus(path) {
  const systemRoot = process.env.SystemRoot
  invariant(typeof systemRoot === 'string' && isAbsolute(systemRoot), 'SystemRoot is required to inspect Windows Authenticode status.')
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const securityModule = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'Import-Module -Name $env:PRIME_CONTINUIM_SECURITY_MODULE -Force',
    '$value = Get-AuthenticodeSignature -LiteralPath $env:PRIME_CONTINUIM_VERIFY_INSTALLER -ErrorAction Stop',
    '[ordered]@{ Status = [string]$value.Status; SignerSubject = if ($null -eq $value.SignerCertificate) { "" } else { [string]$value.SignerCertificate.Subject } } | ConvertTo-Json -Compress',
  ].join('; ')
  const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, PRIME_CONTINUIM_SECURITY_MODULE: securityModule, PRIME_CONTINUIM_VERIFY_INSTALLER: path },
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  })
  const value = parseJsonObject(stdout, 'The Windows installer Authenticode result')
  invariant(typeof value.Status === 'string' && value.Status.length > 0 && value.Status.length <= 128, 'The Windows installer Authenticode status is invalid.')
  invariant(typeof value.SignerSubject === 'string' && value.SignerSubject.length <= 4096, 'The Windows installer Authenticode signer subject is invalid.')
  return value
}

async function main() {
  const projectPackage = parseJsonObject(await readFile(PACKAGE_PATH, 'utf8'), 'package.json')
  const configuration = assertWindowsInstallerConfiguration(projectPackage, { projectRoot: PROJECT_ROOT })
  await assertReviewedBuildResources({ projectRoot: PROJECT_ROOT })
  const args = process.argv.slice(2)
  invariant(args.length <= 1 && (args.length === 0 || args[0] === '--config-only'), 'Usage: node scripts/verify-windows-installer.mjs [--config-only]')

  if (args[0] === '--config-only') {
    console.log(JSON.stringify({
      artifact: projectRelative(configuration.artifactPath),
      checksum: projectRelative(configuration.checksumPath),
      target: 'nsis',
      arch: 'x64',
      oneClick: true,
      installScope: 'per-user',
    }, null, 2))
    return
  }

  const pathMetadata = await lstat(configuration.artifactPath)
  invariant(pathMetadata.isFile() && !pathMetadata.isSymbolicLink(), 'The expected Windows installer is missing or is not a regular file.')

  const handle = await open(configuration.artifactPath, 'r')
  let before
  let pe
  let sha256
  try {
    before = await handle.stat()
    invariant(before.dev === pathMetadata.dev && before.ino === pathMetadata.ino, 'The Windows installer path changed before it could be opened safely.')
    invariant(before.size > 0, 'The Windows installer is empty.')
    pe = await verifyWindowsInstallerEnvelope(handle, before.size)
    sha256 = await hashOpenFile(handle)
    const after = await handle.stat()
    invariant(after.size === before.size && after.mtimeMs === before.mtimeMs, 'The Windows installer changed while it was being verified.')
  } finally {
    await handle.close()
  }

  const authenticode = await readWindowsAuthenticodeStatus(configuration.artifactPath)
  invariant(authenticode.Status === 'NotSigned', `The development installer must be unsigned, but Authenticode reported ${authenticode.Status}.`)
  const afterAuthenticode = await lstat(configuration.artifactPath)
  invariant(
    afterAuthenticode.isFile() &&
      !afterAuthenticode.isSymbolicLink() &&
      afterAuthenticode.dev === before.dev &&
      afterAuthenticode.ino === before.ino &&
      afterAuthenticode.size === before.size &&
      afterAuthenticode.mtimeMs === before.mtimeMs,
    'The Windows installer changed while Authenticode status was being verified.',
  )

  const checksumLine = `${sha256} *${configuration.artifactName}\n`
  await assertSafeChecksumDestination(configuration.checksumPath)
  await writeFile(configuration.checksumPath, checksumLine, 'utf8')
  invariant(await readFile(configuration.checksumPath, 'utf8') === checksumLine, 'The Windows installer checksum could not be read back exactly.')

  console.log(JSON.stringify({
    artifact: projectRelative(configuration.artifactPath),
    bytes: before.size,
    checksum: projectRelative(configuration.checksumPath),
    authenticode,
    pe,
    sha256,
    targetArch: 'x64',
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
