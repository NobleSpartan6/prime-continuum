import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii')
const FUSE_ENABLED = '1'.charCodeAt(0)

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function readPeMaximumRawEnd(executable) {
  invariant(executable.length >= 64, 'The packaged executable is too small to contain a PE header.')
  invariant(executable.subarray(0, 2).toString('ascii') === 'MZ', 'The packaged executable has no DOS header.')

  const peOffset = executable.readUInt32LE(0x3c)
  invariant(peOffset + 24 <= executable.length, 'The packaged executable has a truncated PE header.')
  invariant(executable.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0])), 'The packaged executable has no PE signature.')

  const sectionCount = executable.readUInt16LE(peOffset + 6)
  const optionalHeaderSize = executable.readUInt16LE(peOffset + 20)
  const sectionTableOffset = peOffset + 24 + optionalHeaderSize
  const sectionTableEnd = sectionTableOffset + sectionCount * 40
  invariant(sectionCount > 0 && sectionTableEnd <= executable.length, 'The packaged executable has a truncated section table.')

  let maximumRawEnd = 0
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionOffset = sectionTableOffset + index * 40
    const rawSize = executable.readUInt32LE(sectionOffset + 16)
    const rawPointer = executable.readUInt32LE(sectionOffset + 20)
    maximumRawEnd = Math.max(maximumRawEnd, rawPointer + rawSize)
  }

  return maximumRawEnd
}

function readRequiredFuses(executable) {
  const sentinelOffset = executable.indexOf(FUSE_SENTINEL)
  invariant(sentinelOffset >= 0, 'The Electron fuse sentinel is missing from the packaged executable.')
  invariant(executable.indexOf(FUSE_SENTINEL, sentinelOffset + 1) < 0, 'The packaged executable contains more than one Electron fuse sentinel.')

  const wireOffset = sentinelOffset + FUSE_SENTINEL.length
  invariant(wireOffset + 2 <= executable.length, 'The Electron fuse header is truncated.')
  const version = executable[wireOffset]
  const wireLength = executable[wireOffset + 1]
  invariant(version === 1, `Unsupported Electron fuse wire version: ${version}.`)
  invariant(wireLength >= 6 && wireOffset + 2 + wireLength <= executable.length, 'The Electron fuse wire is truncated.')

  const wire = executable.subarray(wireOffset + 2, wireOffset + 2 + wireLength)
  invariant(wire[0] === FUSE_ENABLED, 'RunAsNode must remain enabled for the external packaged host daemon launcher.')
  invariant(wire[4] === FUSE_ENABLED, 'EnableEmbeddedAsarIntegrityValidation is not enabled in the packaged executable.')
  invariant(wire[5] === FUSE_ENABLED, 'OnlyLoadAppFromAsar is not enabled in the packaged executable.')

  return { version, wireLength }
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex').toUpperCase()
}

async function main() {
  if (process.platform !== 'win32') {
    console.log(`Windows package verification skipped on ${process.platform}.`)
    return
  }

  const packageDirectory = resolve(process.argv[2] ?? 'release/win-unpacked')
  const executablePath = resolve(packageDirectory, 'Prime Continuim.exe')
  const packagedHostdPath = resolve(packageDirectory, 'resources/hostd/hostd.cjs')
  const asarPath = resolve(packageDirectory, 'resources/app.asar')
  const builtHostdPath = resolve('out/hostd/hostd.cjs')
  const builtMainPath = resolve('out/main/index.js')
  const builtPreloadPath = resolve('out/preload/index.cjs')

  const [executable, packagedHostd, builtHostd, builtMain, builtPreload, asarMetadata] = await Promise.all([
    readFile(executablePath),
    readFile(packagedHostdPath),
    readFile(builtHostdPath),
    readFile(builtMainPath, 'utf8'),
    readFile(builtPreloadPath, 'utf8'),
    stat(asarPath),
  ])

  const maximumRawEnd = readPeMaximumRawEnd(executable)
  invariant(executable.length >= maximumRawEnd, `The packaged executable is truncated: ${executable.length} bytes for PE sections ending at ${maximumRawEnd}.`)
  invariant(asarMetadata.isFile() && asarMetadata.size > 0, 'The packaged ASAR is missing or empty.')
  invariant(builtPreload.length > 0, 'The built native preload entry is missing or empty.')
  invariant(builtMain.includes('../preload/index.cjs'), 'The built main process does not request the emitted native preload entry.')
  invariant(!/^\s*import\s/m.test(builtPreload), 'The sandboxed native preload contains unsupported ESM imports.')
  invariant(/require\(["']electron["']\)/.test(builtPreload), 'The sandboxed native preload does not load Electron through its runtime CommonJS API.')
  invariant(!builtPreload.includes('Downloading Electron binary'), 'The sandboxed native preload incorrectly bundles the Electron npm launcher.')

  const fuses = readRequiredFuses(executable)
  const builtHostdHash = sha256(builtHostd)
  const packagedHostdHash = sha256(packagedHostd)
  invariant(packagedHostdHash === builtHostdHash, 'The packaged host daemon does not match the host daemon built in this run.')

  console.log(JSON.stringify({
    packageDirectory,
    executableBytes: executable.length,
    maximumPeRawEnd: maximumRawEnd,
    fuses: {
      version: fuses.version,
      wireLength: fuses.wireLength,
      runAsNode: true,
      embeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    },
    asarBytes: asarMetadata.size,
    preloadEntry: 'out/preload/index.cjs',
    hostdSha256: packagedHostdHash,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
