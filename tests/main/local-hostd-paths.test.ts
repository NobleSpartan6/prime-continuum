import { describe, expect, it } from 'vitest'
import { defaultLocalEndpoint, resolveHostDataDir } from '../../src/hostd/paths'
import { hostdDataDirectory, localHostdEndpoint } from '../../src/main/control/local-hostd'

describe('native/hostd path parity', () => {
  it('uses the same data directory and endpoint as the bundled host service', () => {
    expect(hostdDataDirectory()).toBe(resolveHostDataDir())
    expect(localHostdEndpoint()).toBe(defaultLocalEndpoint(resolveHostDataDir()))
  })
})
