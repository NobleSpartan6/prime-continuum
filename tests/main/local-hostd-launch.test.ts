import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bundledHostdEnvironment,
  bundledHostdLaunchArguments,
  bundledHostdPaths,
  bundledHostdServeArguments
} from '../../src/main/control/local-hostd'

describe('bundled hostd launch contract', () => {
  it('binds a packaged hostd to the exact packaged runtime seed', () => {
    const resources = path.resolve('C:/PrimeContinuim/resources')
    const paths = bundledHostdPaths(
      { isPackaged: true, getAppPath: () => path.resolve('C:/ignored') },
      resources
    )

    expect(paths).toEqual({
      hostdScript: path.join(resources, 'hostd', 'hostd.cjs'),
      runtimeSeed: path.join(resources, 'runtime-seed')
    })
    expect(
      bundledHostdServeArguments(paths, '\\\\.\\pipe\\prime-test', path.resolve('C:/PrimeContinuim/data'))
    ).toEqual([
      paths.hostdScript,
      'serve',
      '--socket',
      '\\\\.\\pipe\\prime-test',
      '--data-dir',
      path.resolve('C:/PrimeContinuim/data'),
      '--runtime-seed',
      paths.runtimeSeed
    ])
  })

  it('uses the build output as the development seed without probing it', () => {
    const applicationRoot = path.resolve('C:/PrimeContinuim/source')
    expect(
      bundledHostdPaths(
        { isPackaged: false, getAppPath: () => applicationRoot },
        path.resolve('C:/ignored/resources')
      )
    ).toEqual({
      hostdScript: path.join(applicationRoot, 'out', 'hostd', 'hostd.cjs'),
      runtimeSeed: path.join(applicationRoot, 'out', 'runtime')
    })
  })

  it('keeps the imported hostd path out of argv[1] during the package smoke', () => {
    const resources = path.resolve('C:/PrimeContinuim/resources')
    const paths = bundledHostdPaths(
      { isPackaged: true, getAppPath: () => path.resolve('C:/ignored') },
      resources
    )
    const endpoint = '\\\\.\\pipe\\prime-test'
    const dataDirectory = path.resolve('C:/PrimeContinuim/data')
    const serveArguments = bundledHostdServeArguments(paths, endpoint, dataDirectory)
    const launchArguments = bundledHostdLaunchArguments(paths, endpoint, dataDirectory, true)

    expect(launchArguments[0]).toBe('-e')
    expect(launchArguments[1]).toContain(
      'const [wrapperIdentity, hostdPath, ...hostdArguments] = process.argv.slice(1);'
    )
    expect(launchArguments[1]).toContain('invalid hostd smoke wrapper identity')
    expect(launchArguments[2]).toBe('prime-continuim-package-smoke-wrapper')
    expect(path.basename(launchArguments[2] ?? '')).not.toBe('hostd.cjs')
    expect(launchArguments.slice(3)).toEqual(serveArguments)
    expect(bundledHostdLaunchArguments(paths, endpoint, dataDirectory, false)).toEqual(serveArguments)
  })

  it('removes parent-process Node injection while preserving ordinary environment values', () => {
    expect(
      bundledHostdEnvironment({
        Path: 'C:\\Windows',
        PRIME_API_KEY: 'provider-key',
        NODE_OPTIONS: '--require attacker.js',
        node_path: 'C:\\untrusted',
        electron_run_as_node: '0'
      })
    ).toEqual({
      Path: 'C:\\Windows',
      PRIME_API_KEY: 'provider-key',
      ELECTRON_RUN_AS_NODE: '1'
    })
  })
})
