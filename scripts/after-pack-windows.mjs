import { randomUUID } from 'node:crypto'
import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'

export async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const { appInfo } = context.packager
  const executablePath = resolve(context.appOutDir, `${appInfo.productFilename}.exe`)
  assertPathInside(context.appOutDir, executablePath, 'The packaged Windows executable')
  const iconPath = await context.packager.getIconPath()
  invariant(typeof iconPath === 'string' && isAbsolute(iconPath), 'The packaged Windows icon path is missing or not absolute.')

  await editWindowsExecutableResources({
    executablePath,
    iconPath,
    metadata: {
      companyName: appInfo.companyName,
      copyright: appInfo.copyright,
      fileDescription: appInfo.productName,
      fileVersion: appInfo.shortVersion || appInfo.buildVersion,
      internalName: appInfo.productFilename,
      productName: appInfo.productName,
      productVersion: appInfo.shortVersionWindows || appInfo.getVersionInWeirdWindowsForm(),
    },
  })

  process.stdout.write('[Prime Continuim] Applied Windows product icon and version resources without invoking the legacy signing bundle.\n')
}

export async function editWindowsExecutableResources({ executablePath, iconPath, metadata }) {
  validateMetadata(metadata)
  const [executableMetadata, executableBytes, iconBytes] = await Promise.all([
    lstat(executablePath),
    readFile(executablePath),
    readFile(iconPath),
  ])
  invariant(executableMetadata.isFile() && !executableMetadata.isSymbolicLink(), 'The packaged Windows executable is not a regular file.')
  invariant(executableBytes.byteLength > 0, 'The packaged Windows executable is empty.')
  invariant(iconBytes.byteLength > 0, 'The Windows product icon is empty.')

  const executable = NtExecutable.from(executableBytes, { ignoreCert: true })
  const resources = NtExecutableResource.from(executable)
  const versionEntries = Resource.VersionInfo.fromEntries(resources.entries)
  invariant(versionEntries.length === 1, `Expected exactly one Windows version resource, found ${versionEntries.length}.`)
  const versionInfo = versionEntries[0]
  const languages = versionInfo.getAllLanguagesForStringValues()
  invariant(languages.length === 1, `Expected exactly one Windows version language, found ${languages.length}.`)
  const language = languages[0]

  versionInfo.setFileVersion(toFourPartVersion(metadata.fileVersion), language.lang)
  versionInfo.setProductVersion(toFourPartVersion(metadata.productVersion), language.lang)
  versionInfo.setStringValues(language, {
    CompanyName: metadata.companyName,
    FileDescription: metadata.fileDescription,
    FileVersion: metadata.fileVersion,
    InternalName: metadata.internalName,
    LegalCopyright: metadata.copyright,
    OriginalFilename: `${metadata.internalName}.exe`,
    ProductName: metadata.productName,
    ProductVersion: toFourPartVersion(metadata.productVersion),
  })
  versionInfo.outputToResourceEntries(resources.entries)

  const iconFile = Data.IconFile.from(iconBytes)
  invariant(iconFile.icons.length > 0, 'The Windows product icon contains no images.')
  const iconGroups = Resource.IconGroupEntry.fromEntries(resources.entries)
  invariant(iconGroups.length > 0, 'The packaged Windows executable contains no icon group to replace.')
  for (const iconGroup of iconGroups) {
    Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      iconGroup.id,
      iconGroup.lang,
      iconFile.icons.map((item) => item.data),
    )
  }

  resources.outputResource(executable)
  const editedBytes = Buffer.from(executable.generate())
  invariant(editedBytes.byteLength > 0, 'Windows resource editing produced an empty executable.')
  await replaceFileSafely(executablePath, editedBytes, executableMetadata.mode)
}

async function replaceFileSafely(path, bytes, mode) {
  const nonce = `${process.pid}-${randomUUID()}`
  const temporaryPath = `${path}.resource-edit-${nonce}`
  const backupPath = `${path}.resource-backup-${nonce}`
  await writeFile(temporaryPath, bytes, { flag: 'wx', mode })
  let originalMoved = false
  try {
    await rename(path, backupPath)
    originalMoved = true
    await rename(temporaryPath, path)
    await chmod(path, mode)
    await rm(backupPath, { force: true })
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    if (originalMoved) {
      await rm(path, { force: true }).catch(() => undefined)
      await rename(backupPath, path).catch(() => undefined)
    }
    throw error
  }
}

function validateMetadata(metadata) {
  invariant(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'Windows executable metadata is missing.')
  for (const field of ['companyName', 'copyright', 'fileDescription', 'fileVersion', 'internalName', 'productName', 'productVersion']) {
    const value = metadata[field]
    invariant(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value), `Windows executable metadata ${field} is invalid.`)
  }
  toFourPartVersion(metadata.fileVersion)
  toFourPartVersion(metadata.productVersion)
}

function toFourPartVersion(version) {
  invariant(typeof version === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version), `Windows version is invalid: ${version}.`)
  const parts = version.split('.').map(Number)
  while (parts.length < 4) parts.push(0)
  invariant(parts.every((part) => Number.isSafeInteger(part) && part >= 0 && part <= 65_535), `Windows version is outside the PE version range: ${version}.`)
  return parts.join('.')
}

function assertPathInside(root, path, label) {
  const child = relative(resolve(root), resolve(path))
  invariant(child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child), `${label} must stay inside the application output directory.`)
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

export default afterPack
