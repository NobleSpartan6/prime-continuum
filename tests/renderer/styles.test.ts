import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('renderer style contracts', () => {
  it('restores text-field focus outlines in Windows forced-colors mode', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'))

    expect(forcedColors).toContain('.composer textarea:focus-visible')
    expect(forcedColors).toContain('.command-palette__input input:focus-visible')
    expect(forcedColors).toContain('outline: 2px solid Highlight')
  })
})
