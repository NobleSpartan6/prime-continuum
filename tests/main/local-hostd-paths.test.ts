import { access, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultLocalEndpoint } from '../../src/hostd/paths'
import { localHostdEndpoint, localHostdTarget } from '../../src/main/control/local-hostd'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })))
})

describe('native/hostd path parity', () => {
  it('derives the same endpoint from one existing physical data root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'prime-local-host-target-'))
    temporaryDirectories.push(directory)
    const canonical = await realpath(directory)

    expect(await localHostdEndpoint(directory)).toBe(defaultLocalEndpoint(canonical))
  })

  it('does not create a missing read-only target', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'prime-local-host-missing-'))
    temporaryDirectories.push(parent)
    const missing = join(parent, 'host-data')

    const target = await localHostdTarget(missing)

    expect(target).toMatchObject({ physicalIdentityAvailable: false })
    expect(target.endpoint).toBe(defaultLocalEndpoint(missing))
    await expect(access(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates then physically canonicalizes a writable target', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'prime-local-host-create-'))
    temporaryDirectories.push(parent)
    const missing = join(parent, 'host-data')

    const target = await localHostdTarget(missing, { create: true })

    expect(target).toMatchObject({
      dataDirectory: await realpath(missing),
      physicalIdentityAvailable: true,
    })
    expect(target.endpoint).toBe(defaultLocalEndpoint(target.dataDirectory))
  })

  it('collapses filesystem aliases onto the same local endpoint', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'prime-local-host-alias-'))
    temporaryDirectories.push(parent)
    const physical = join(parent, 'physical')
    const alias = join(parent, 'alias')
    await mkdir(physical)
    await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')

    const physicalTarget = await localHostdTarget(physical)
    const aliasTarget = await localHostdTarget(alias)

    expect(aliasTarget.dataDirectory).toBe(physicalTarget.dataDirectory)
    expect(aliasTarget.endpoint).toBe(physicalTarget.endpoint)
  })
})
