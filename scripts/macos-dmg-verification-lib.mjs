import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  assertMacosDmgDistributionConfiguration,
  assertMacosSystemToolCustody,
  resolveMacosPackageDirectory,
} from './macos-packaging-policy.mjs'
import { assertReviewedBuildResources } from './windows-packaging-policy.mjs'
import { compareExactDirectoryTrees } from './macos-package-verification-lib.mjs'
import { verifyMacosPackage } from './verify-macos-package.mjs'

const MAX_DMG_BYTES = 2 * 1024 * 1024 * 1024
const MAX_TOOL_OUTPUT_BYTES = 8 * 1024 * 1024
const DISK_DEVICE_PATTERN = /^\/dev\/disk\d+(?:s\d+)*$/
const WHOLE_DISK_PATTERN = /^\/dev\/disk\d+$/
export async function prepareMacosDmgArtifactDestinations({ projectRoot, projectPackage, arch = process.arch }) {
  const configuration = assertMacosDmgDistributionConfiguration(projectPackage, { projectRoot: resolve(projectRoot), arch })
  await assertReviewedBuildResources({ projectRoot })
  await assertMacosSystemToolCustody()
  await recoverMacosDmgVerification(configuration)
  for (const path of [
    configuration.artifactPath,
    configuration.checksumPath,
    configuration.blockmapPath,
    configuration.updateMetadataPath,
    ...configuration.legacyArtifactPaths,
  ]) {
    await unlinkSafeGeneratedFile(path)
  }
  return configuration
}

export async function recoverMacosDmgVerification(configuration, { allowOwnerPid } = {}) {
  const journal = await readVerificationJournal(configuration)
  if (!journal) return Object.freeze({ recovered: false, devices: Object.freeze([]) })
  if (journal.ownerPid !== allowOwnerPid && processIsPossiblyAlive(journal.ownerPid)) {
    throw new Error('A prior macOS DMG verifier still owns the durable mount journal.')
  }

  const recoveryErrors = []
  try {
    const artifact = await lstat(journal.artifactPath)
    invariant(
      artifact.isFile() && !artifact.isSymbolicLink() && artifact.nlink === 1 &&
        artifact.dev === journal.artifact.dev && artifact.ino === journal.artifact.ino &&
        artifact.size === journal.artifact.size && artifact.mtimeMs === journal.artifact.mtimeMs,
      'The journaled macOS DMG artifact identity changed before mount recovery.',
    )
  } catch (error) {
    recoveryErrors.push(error)
  }
  const info = await readHdiutilInfo()
  const attachment = resolveRecoverableJournalAttachment(info, journal)
  if (attachment) {
    try {
      await runTool('/usr/bin/hdiutil', ['detach', attachment.rootDevice], { timeout: 30_000 })
    } catch (error) {
      recoveryErrors.push(error)
      try {
        await runTool('/usr/bin/hdiutil', ['detach', '-force', attachment.rootDevice], { timeout: 30_000 })
      } catch (forceError) {
        recoveryErrors.push(forceError)
      }
    }
    try {
      await assertDetached({ devices: attachment.devices, mountPoint: journal.mountPoint })
    } catch (error) {
      recoveryErrors.push(error)
    }
  }

  const mountState = await inspectRecoveryMount(journal.mountPoint)
  if (mountState === 'nonempty') {
    const error = new Error('The prior macOS DMG private mount contains unretired files.')
    error.code = 'DMG_DEVICE_RESIDUE'
    recoveryErrors.push(error)
  }
  if (!recoveryErrors.some(isDeviceResidueError)) {
    try {
      await rm(journal.scratchRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      await unlinkSafeGeneratedFile(configuration.verificationJournalPath)
      await syncDirectory(resolve(configuration.verificationJournalPath, '..'))
    } catch (error) {
      recoveryErrors.push(error)
    }
  }
  if (recoveryErrors.length > 0) {
    throw recoveryErrors.length === 1
      ? recoveryErrors[0]
      : new AggregateError(recoveryErrors, 'The prior macOS DMG mount could not be retired cleanly.')
  }
  return Object.freeze({ recovered: true, devices: attachment?.devices ?? Object.freeze([]) })
}

export async function assertMacosDmgMountEntries(mountPoint, expectedApplicationPath) {
  const root = resolve(mountPoint)
  const rootDetails = await lstat(root)
  invariant(rootDetails.isDirectory() && !rootDetails.isSymbolicLink(), 'The DMG mount point is not a plain directory.')
  const entries = await readdir(root, { withFileTypes: true })
  const names = entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right, 'en-US'))
  invariant(
    JSON.stringify(names) === JSON.stringify(['.DS_Store', '.VolumeIcon.icns', 'Applications', 'Prime Continuim.app']),
    'The mounted DMG does not contain the exact reviewed Finder surface.',
  )

  const applicationsPath = join(root, 'Applications')
  const appPath = join(root, 'Prime Continuim.app')
  const dsStorePath = join(root, '.DS_Store')
  const volumeIconPath = join(root, '.VolumeIcon.icns')
  const [applicationsDetails, appDetails, dsStoreDetails, volumeIconDetails] = await Promise.all([
    lstat(applicationsPath),
    lstat(appPath),
    lstat(dsStorePath),
    lstat(volumeIconPath),
  ])
  invariant(applicationsDetails.isSymbolicLink(), 'The mounted DMG Applications entry is not a symbolic link.')
  invariant(await readlink(applicationsPath) === '/Applications', 'The mounted DMG Applications link has an unexpected target.')
  invariant(appDetails.isDirectory() && !appDetails.isSymbolicLink(), 'The mounted DMG application is not a plain directory.')
  invariant(
    dsStoreDetails.isFile() && !dsStoreDetails.isSymbolicLink() && dsStoreDetails.nlink === 1 && dsStoreDetails.size >= 4_096 && dsStoreDetails.size <= 1024 * 1024,
    'The mounted DMG Finder layout metadata is not a bounded regular file.',
  )
  invariant(
    volumeIconDetails.isFile() && !volumeIconDetails.isSymbolicLink() && volumeIconDetails.nlink === 1 && volumeIconDetails.size >= 8 && volumeIconDetails.size <= 5 * 1024 * 1024,
    'The mounted DMG volume icon is not a bounded regular file.',
  )
  const [volumeIcon, applicationIcon] = await Promise.all([
    readFile(volumeIconPath),
    readFile(join(resolve(expectedApplicationPath), 'Contents', 'Resources', 'icon.icns')),
  ])
  invariant(volumeIcon.subarray(0, 4).toString('ascii') === 'icns', 'The mounted DMG volume icon has no ICNS header.')
  invariant(volumeIcon.readUInt32BE(4) === volumeIcon.length, 'The mounted DMG volume icon has an invalid ICNS length.')
  invariant(volumeIcon.equals(applicationIcon), 'The mounted DMG volume icon does not match the exact packaged application icon.')
  return Object.freeze({ appPath, entries: Object.freeze(names) })
}

export function assertDmgTrailer(trailer) {
  const bytes = Buffer.from(trailer)
  invariant(bytes.length === 512, 'The macOS DMG trailer is truncated.')
  invariant(bytes.subarray(0, 4).toString('ascii') === 'koly', 'The macOS DMG has no UDIF trailer.')
  return true
}

export function collectDiskImageDeviceIds(info) {
  const images = assertArray(info?.images, 'hdiutil info images')
  const result = new Set()
  for (const image of images) {
    for (const entity of assertArray(image?.['system-entities'], 'hdiutil image system entities')) {
      const device = entity?.['dev-entry']
      invariant(typeof device === 'string' && DISK_DEVICE_PATTERN.test(device), 'hdiutil reported an invalid disk-image device.')
      result.add(device)
    }
  }
  return result
}

export function resolveAttachedDiskImage({ attach, info, artifactPath, mountPoint, baselineDeviceIds }) {
  const identity = resolveAttachDeviceIdentities({ attach, mountPoint, baselineDeviceIds })
  assertPublishedAttachment({ info, artifactPath, mountPoint, identity })
  return identity
}

function resolveAttachDeviceIdentities({ attach, mountPoint, baselineDeviceIds }) {
  const expectedMount = resolve(mountPoint)
  const baseline = baselineDeviceIds instanceof Set ? baselineDeviceIds : new Set(baselineDeviceIds)
  const attachEntities = assertArray(attach?.['system-entities'], 'hdiutil attach system entities')
  const attachedDevices = new Set()
  let mountedDevice
  for (const entity of attachEntities) {
    const device = entity?.['dev-entry']
    invariant(typeof device === 'string' && DISK_DEVICE_PATTERN.test(device), 'hdiutil attach reported an invalid device.')
    invariant(!baseline.has(device), 'hdiutil attach cross-fed a device that existed before this attachment.')
    invariant(!attachedDevices.has(device), 'hdiutil attach repeated a device identity.')
    attachedDevices.add(device)
    if (entity?.['mount-point'] !== undefined) {
      invariant(entity['mount-point'] === expectedMount, 'hdiutil attached the DMG at an unexpected mount point.')
      invariant(mountedDevice === undefined, 'hdiutil attached more than one mounted volume.')
      mountedDevice = device
    }
  }
  const rootDevices = [...attachedDevices].filter((device) => WHOLE_DISK_PATTERN.test(device))
  invariant(attachedDevices.size === 2 && rootDevices.length === 1 && mountedDevice, 'hdiutil did not return one exact whole disk and mounted volume.')
  return Object.freeze({
    rootDevice: rootDevices[0],
    mountedDevice,
    devices: Object.freeze([...attachedDevices].sort()),
  })
}

function assertPublishedAttachment({ info, artifactPath, mountPoint, identity }) {
  const expectedArtifact = resolve(artifactPath)
  const expectedMount = resolve(mountPoint)
  const matches = assertArray(info?.images, 'hdiutil info images').filter((image) =>
    image?.['image-path'] === expectedArtifact &&
    assertArray(image?.['system-entities'], 'hdiutil image system entities').some((entity) => entity?.['mount-point'] === expectedMount),
  )
  invariant(matches.length === 1, 'hdiutil did not publish one exact image record for the private mount.')
  const image = matches[0]
  invariant(image?.['image-type'] === 'UDIF read-only compressed (zlib)', 'The attached image is not the reviewed compressed read-only type.')
  invariant(image?.writeable === false && image?.['image-encrypted'] === false, 'The attached image is writable or encrypted unexpectedly.')
  const infoDevices = new Set(assertArray(image?.['system-entities'], 'hdiutil image system entities').map((entity) => entity?.['dev-entry']))
  invariant(
    infoDevices.size === identity.devices.length && identity.devices.every((device) => infoDevices.has(device)),
    'hdiutil attach and info returned different device identities.',
  )
}

export function assertReadOnlyDiskInfo(info, { device, mountPoint, wholeDisk }) {
  invariant(info && typeof info === 'object' && !Array.isArray(info), 'diskutil returned an invalid device record.')
  invariant(info.BusProtocol === 'Disk Image', 'diskutil did not identify the device as a disk image.')
  invariant(info.DeviceNode === device, 'diskutil returned a different device identity.')
  invariant(info.Writable === false && info.WritableMedia === false && info.WritableVolume === false, 'diskutil reported writable DMG media.')
  invariant(info.WholeDisk === wholeDisk, 'diskutil returned an unexpected whole-disk disposition.')
  if (wholeDisk) {
    invariant(info.MountPoint === '' || info.MountPoint === undefined, 'The whole DMG device is mounted directly.')
  } else {
    invariant(info.MountPoint === resolve(mountPoint), 'diskutil returned an unexpected mounted volume path.')
  }
  return true
}

export function assertDmgImageInfo(info, artifactPath) {
  invariant(info && typeof info === 'object' && !Array.isArray(info), 'hdiutil imageinfo returned an invalid record.')
  invariant(info.Format === 'UDZO', 'The macOS DMG format is not the reviewed UDZO format.')
  invariant(info['Format Description'] === 'UDIF read-only compressed (zlib)', 'The macOS DMG format description is unexpected.')
  invariant(Array.isArray(info.Segments) && info.Segments.length === 1 && info.Segments[0] === resolve(artifactPath), 'The macOS DMG image info is not bound to the exact artifact.')
  invariant(info?.partitions?.['partition-scheme'] === 'GUID' && info?.partitions?.burnable === false, 'The macOS DMG partition contract changed.')
  invariant(
    info?.Properties?.Encrypted === false &&
      info.Properties.Checksummed === true &&
      info.Properties.Compressed === true &&
      info.Properties['Software License Agreement'] === false,
    'The macOS DMG properties are not the reviewed compressed, checksummed, unencrypted contract.',
  )
  return true
}

async function createVerificationJournal(configuration, { scratchRoot, mountPoint, baselineDeviceIds, artifact }) {
  const journal = Object.freeze({
    schemaVersion: 1,
    operationId: randomUUID(),
    ownerPid: process.pid,
    createdAt: new Date().toISOString(),
    artifactPath: configuration.artifactPath,
    artifact: Object.freeze({
      dev: artifact.dev,
      ino: artifact.ino,
      size: artifact.size,
      mtimeMs: artifact.mtimeMs,
      sha256: artifact.sha256,
    }),
    scratchRoot,
    mountPoint,
    baselineDeviceIds: Object.freeze([...baselineDeviceIds].sort()),
  })
  validateVerificationJournal(journal, configuration)
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`, 'utf8')
  invariant(bytes.length <= 64 * 1024, 'The macOS DMG verification journal is oversized.')
  const handle = await open(configuration.verificationJournalPath, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(resolve(configuration.verificationJournalPath, '..'))
  return journal
}

async function readVerificationJournal(configuration) {
  let before
  try {
    before = await lstat(configuration.verificationJournalPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  invariant(
    before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= 64 * 1024,
    'The macOS DMG verification journal is not a bounded private regular file.',
  )
  const bytes = await readFile(configuration.verificationJournalPath)
  const after = await lstat(configuration.verificationJournalPath)
  invariant(
    after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs,
    'The macOS DMG verification journal changed while it was read.',
  )
  let journal
  try {
    journal = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('The macOS DMG verification journal is malformed.')
  }
  validateVerificationJournal(journal, configuration)
  return journal
}

function validateVerificationJournal(journal, configuration) {
  invariant(journal && typeof journal === 'object' && !Array.isArray(journal), 'The macOS DMG verification journal is invalid.')
  invariant(
    JSON.stringify(Object.keys(journal).sort()) === JSON.stringify([
      'artifact',
      'artifactPath',
      'baselineDeviceIds',
      'createdAt',
      'mountPoint',
      'operationId',
      'ownerPid',
      'schemaVersion',
      'scratchRoot',
    ]),
    'The macOS DMG verification journal has unexpected fields.',
  )
  invariant(journal.schemaVersion === 1, 'The macOS DMG verification journal version is unsupported.')
  invariant(typeof journal.operationId === 'string' && /^[a-f0-9-]{36}$/.test(journal.operationId), 'The macOS DMG verification operation identity is invalid.')
  invariant(Number.isSafeInteger(journal.ownerPid) && journal.ownerPid > 0, 'The macOS DMG verification owner PID is invalid.')
  invariant(typeof journal.createdAt === 'string' && Number.isFinite(Date.parse(journal.createdAt)), 'The macOS DMG verification time is invalid.')
  invariant(journal.artifactPath === configuration.artifactPath, 'The macOS DMG verification journal targets another artifact.')
  invariant(
    typeof journal.scratchRoot === 'string' && /^\/private\/tmp\/pc-mac-dmg-[A-Za-z0-9]+$/.test(journal.scratchRoot),
    'The macOS DMG verification scratch path is invalid.',
  )
  invariant(journal.mountPoint === join(journal.scratchRoot, 'mount'), 'The macOS DMG verification mount path is invalid.')
  invariant(Array.isArray(journal.baselineDeviceIds) && journal.baselineDeviceIds.length <= 256, 'The macOS DMG verification baseline is invalid.')
  const baseline = new Set(journal.baselineDeviceIds)
  invariant(
    baseline.size === journal.baselineDeviceIds.length && journal.baselineDeviceIds.every((device) => typeof device === 'string' && DISK_DEVICE_PATTERN.test(device)),
    'The macOS DMG verification baseline contains invalid device identities.',
  )
  invariant(journal.artifact && typeof journal.artifact === 'object' && !Array.isArray(journal.artifact), 'The macOS DMG verification artifact identity is invalid.')
  invariant(
    JSON.stringify(Object.keys(journal.artifact).sort()) === JSON.stringify(['dev', 'ino', 'mtimeMs', 'sha256', 'size']),
    'The macOS DMG verification artifact identity has unexpected fields.',
  )
  invariant(
    ['dev', 'ino', 'size'].every((key) => Number.isSafeInteger(journal.artifact[key]) && journal.artifact[key] >= 0) &&
      Number.isFinite(journal.artifact.mtimeMs) &&
      typeof journal.artifact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(journal.artifact.sha256),
    'The macOS DMG verification artifact identity is invalid.',
  )
}

function resolveRecoverableJournalAttachment(info, journal) {
  const baseline = new Set(journal.baselineDeviceIds)
  const candidates = assertArray(info?.images, 'hdiutil info images').filter((image) => {
    if (image?.['image-path'] !== journal.artifactPath) return false
    const entities = assertArray(image?.['system-entities'], 'hdiutil image system entities')
    return entities.some((entity) => entity?.['mount-point'] === journal.mountPoint) ||
      entities.some((entity) => typeof entity?.['dev-entry'] === 'string' && !baseline.has(entity['dev-entry']))
  })
  invariant(candidates.length <= 1, 'The macOS DMG verification journal matches ambiguous disk images.')
  if (candidates.length === 0) return undefined
  const entities = assertArray(candidates[0]?.['system-entities'], 'hdiutil image system entities')
  const devices = []
  for (const entity of entities) {
    const device = entity?.['dev-entry']
    invariant(typeof device === 'string' && DISK_DEVICE_PATTERN.test(device), 'The recoverable macOS DMG device identity is invalid.')
    invariant(!baseline.has(device), 'The recoverable macOS DMG image reused a baseline device.')
    invariant(!devices.includes(device), 'The recoverable macOS DMG image repeated a device.')
    if (entity?.['mount-point'] !== undefined) {
      invariant(entity['mount-point'] === journal.mountPoint, 'The recoverable macOS DMG image mounted outside its private path.')
    }
    devices.push(device)
  }
  const roots = devices.filter((device) => WHOLE_DISK_PATTERN.test(device))
  invariant(devices.length >= 1 && devices.length <= 2 && roots.length === 1, 'The recoverable macOS DMG image has ambiguous device topology.')
  return Object.freeze({ rootDevice: roots[0], devices: Object.freeze(devices.sort()) })
}

function processIsPossiblyAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

async function inspectRecoveryMount(path) {
  try {
    const metadata = await lstat(path)
    invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), 'The macOS DMG recovery mount is not a plain directory.')
    return (await readdir(path)).length === 0 ? 'empty' : 'nonempty'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent'
    throw error
  }
}

export async function verifyMacosDmg({ projectRoot, projectPackage, arch = process.arch } = {}) {
  const root = resolve(projectRoot)
  const configuration = assertMacosDmgDistributionConfiguration(projectPackage, { projectRoot: root, arch })
  invariant(process.platform === 'darwin', `Release blocked: macOS DMG verification cannot run on ${process.platform}.`)
  await assertReviewedBuildResources({ projectRoot: root })
  await assertMacosSystemToolCustody()
  await recoverMacosDmgVerification(configuration)
  await Promise.all([
    assertMissing(configuration.blockmapPath, 'The macOS DMG blockmap must remain absent.'),
    assertMissing(configuration.updateMetadataPath, 'The macOS updater metadata must remain absent.'),
    assertMissing(configuration.checksumPath, 'The macOS DMG checksum must not predate verification.'),
  ])

  const initialArtifact = await inspectArtifact(configuration.artifactPath)
  const imageInfo = await parsePlist(await runTool('/usr/bin/hdiutil', ['imageinfo', '-plist', configuration.artifactPath]), 'hdiutil imageinfo')
  assertDmgImageInfo(imageInfo, configuration.artifactPath)

  const scratch = await mkdtemp('/private/tmp/pc-mac-dmg-')
  const mountPoint = join(scratch, 'mount')
  await mkdir(mountPoint, { mode: 0o700 })
  const baselineInfo = await readHdiutilInfo()
  const baselineDeviceIds = collectDiskImageDeviceIds(baselineInfo)
  try {
    await createVerificationJournal(configuration, {
      scratchRoot: scratch,
      mountPoint,
      baselineDeviceIds,
      artifact: initialArtifact,
    })
  } catch (error) {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
    throw error
  }
  const signalCustody = installVerificationSignalCustody()
  let attachment
  let verification
  let primaryError
  const cleanupErrors = []
  try {
    const attachBytes = await runTool('/usr/bin/hdiutil', [
      'attach',
      '-readonly',
      '-verify',
      '-nobrowse',
      '-noautoopen',
      '-mountpoint',
      mountPoint,
      '-plist',
      configuration.artifactPath,
    ])
    signalCustody.check()
    const attach = await parsePlist(attachBytes, 'hdiutil attach')
    attachment = resolveAttachDeviceIdentities({ attach, mountPoint, baselineDeviceIds })
    const currentInfo = await readHdiutilInfo()
    signalCustody.check()
    assertPublishedAttachment({
      info: currentInfo,
      artifactPath: configuration.artifactPath,
      mountPoint,
      identity: attachment,
    })
    const [rootInfo, mountedInfo] = await Promise.all([
      readDiskInfo(attachment.rootDevice),
      readDiskInfo(attachment.mountedDevice),
    ])
    signalCustody.check()
    assertReadOnlyDiskInfo(rootInfo, { device: attachment.rootDevice, mountPoint, wholeDisk: true })
    assertReadOnlyDiskInfo(mountedInfo, { device: attachment.mountedDevice, mountPoint, wholeDisk: false })

    const directoryApp = join(resolveMacosPackageDirectory(root, arch), 'Prime Continuim.app')
    const mounted = await assertMacosDmgMountEntries(mountPoint, directoryApp)
    signalCustody.check()
    const tree = await compareExactDirectoryTrees(directoryApp, mounted.appPath, 'The mounted macOS application')
    signalCustody.check()
    const packageEvidence = await verifyMacosPackage({ projectRoot: root, packageDirectory: mountPoint })
    signalCustody.check()
    verification = Object.freeze({ mountedEntries: mounted.entries, devices: attachment.devices, tree, packageEvidence })
  } catch (error) {
    primaryError = error
  }

  if (attachment) {
    let normalDetachFailed = false
    try {
      await runTool('/usr/bin/hdiutil', ['detach', attachment.rootDevice], { timeout: 30_000 })
    } catch (error) {
      normalDetachFailed = true
      cleanupErrors.push(error)
      try {
        await runTool('/usr/bin/hdiutil', ['detach', '-force', attachment.rootDevice], { timeout: 30_000 })
      } catch (forceError) {
        cleanupErrors.push(forceError)
      }
    }
    try {
      await assertDetached({ devices: attachment.devices, mountPoint })
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (normalDetachFailed) cleanupErrors.push(new Error('The macOS DMG required a forced detach.'))
  }

  try {
    await recoverMacosDmgVerification(configuration, { allowOwnerPid: process.pid })
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (!primaryError && signalCustody.error) primaryError = signalCustody.error
  signalCustody.close()
  if (primaryError || cleanupErrors.length > 0) {
    const errors = [...(primaryError ? [primaryError] : []), ...cleanupErrors]
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'The macOS DMG failed verification or clean device retirement.')
  }

  const finalArtifact = await inspectArtifact(configuration.artifactPath)
  invariant(
    finalArtifact.dev === initialArtifact.dev &&
      finalArtifact.ino === initialArtifact.ino &&
      finalArtifact.size === initialArtifact.size &&
      finalArtifact.mtimeMs === initialArtifact.mtimeMs &&
      finalArtifact.sha256 === initialArtifact.sha256,
    'The macOS DMG changed while mounted or detached.',
  )
  const checksumLine = `${initialArtifact.sha256} *${configuration.artifactName}\n`
  await writeChecksum(configuration.checksumPath, checksumLine)
  return Object.freeze({
    configuration,
    artifact: Object.freeze({ bytes: initialArtifact.size, sha256: initialArtifact.sha256 }),
    image: Object.freeze({ format: imageInfo.Format, readOnly: true, checksummed: true, encrypted: false }),
    verification,
  })
}

async function inspectArtifact(path) {
  const details = await lstat(path)
  invariant(
    details.isFile() && !details.isSymbolicLink() && details.nlink === 1 && details.size > 512 && details.size <= MAX_DMG_BYTES,
    'The expected macOS DMG is missing, linked, empty, or oversized.',
  )
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    invariant(before.dev === details.dev && before.ino === details.ino, 'The macOS DMG path changed before verification.')
    const trailer = Buffer.alloc(512)
    const readResult = await handle.read(trailer, 0, trailer.length, before.size - trailer.length)
    invariant(readResult.bytesRead === trailer.length, 'The macOS DMG trailer is truncated.')
    assertDmgTrailer(trailer)
    const digest = await hashOpenHandle(handle)
    const after = await handle.stat()
    invariant(
      after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs,
      'The macOS DMG changed while it was hashed.',
    )
    return Object.freeze({ dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, sha256: digest })
  } finally {
    await handle.close()
  }
}

async function hashOpenHandle(handle) {
  const digest = createHash('sha256')
  await new Promise((resolveStream, rejectStream) => {
    const stream = handle.createReadStream({ autoClose: false, start: 0 })
    stream.on('data', (chunk) => digest.update(chunk))
    stream.once('end', resolveStream)
    stream.once('error', rejectStream)
  })
  return digest.digest('hex')
}

async function readHdiutilInfo() {
  return await parsePlist(await runTool('/usr/bin/hdiutil', ['info', '-plist']), 'hdiutil info')
}

async function readDiskInfo(device) {
  return await parsePlist(await runTool('/usr/sbin/diskutil', ['info', '-plist', device]), `diskutil info ${device}`)
}

async function parsePlist(bytes, label) {
  const json = await runTool('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: bytes })
  try {
    return JSON.parse(json.toString('utf8'))
  } catch {
    throw new Error(`${label} did not produce a valid plist object.`)
  }
}

async function assertDetached({ devices, mountPoint }) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const current = collectDiskImageDeviceIds(await readHdiutilInfo())
    const retired = devices.every((device) => !current.has(device))
    const empty = await isEmptyDirectory(mountPoint).catch(() => false)
    if (retired && empty) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  const error = new Error('The macOS DMG devices or private mount remained after detach.')
  error.code = 'DMG_DEVICE_RESIDUE'
  throw error
}

async function isEmptyDirectory(path) {
  const metadata = await lstat(path)
  return metadata.isDirectory() && !metadata.isSymbolicLink() && (await readdir(path)).length === 0
}

function isDeviceResidueError(error) {
  return error?.code === 'DMG_DEVICE_RESIDUE'
}

async function writeChecksum(path, text) {
  await assertMissing(path, 'The macOS DMG checksum destination already exists.')
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  const metadata = await lstat(path)
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1, 'The macOS DMG checksum is not a private regular file.')
  invariant(await readFile(path, 'utf8') === text, 'The macOS DMG checksum could not be read back exactly.')
  await syncDirectory(resolve(path, '..'))
}

async function syncDirectory(path) {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function installVerificationSignalCustody() {
  let error
  const handlers = new Map()
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (!error) {
        error = new Error(`The macOS DMG verification was interrupted by ${signal}; durable mount recovery is required.`)
        error.code = 'DMG_VERIFICATION_INTERRUPTED'
      }
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  return Object.freeze({
    get error() { return error },
    check() {
      if (error) throw error
    },
    close() {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler)
    },
  })
}

async function unlinkSafeGeneratedFile(path) {
  try {
    const metadata = await lstat(path)
    invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1, `${path} is not a safe generated file.`)
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function assertMissing(path, message) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(message)
}

function runTool(executable, args, { input, timeout = 60_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(executable, args, {
      encoding: 'buffer',
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      timeout,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = Buffer.from(stdout ?? [])
        error.stderr = Buffer.from(stderr ?? [])
        rejectRun(error)
        return
      }
      resolveRun(Buffer.from(stdout ?? []))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

function assertArray(value, label) {
  invariant(Array.isArray(value), `${label} is invalid.`)
  return value
}

export function projectRelative(projectRoot, path) {
  const relation = relative(resolve(projectRoot), resolve(path))
  invariant(relation && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation), 'The macOS DMG artifact escaped the project root.')
  return relation.split(sep).join('/')
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}
