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

  it('keeps transcript metadata and the composer action inside narrow viewports', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const narrowLayout = css.slice(
      css.indexOf('@media (max-width: 38rem)'),
      css.indexOf('@media (max-width: 24rem)'),
    )

    expect(narrowLayout).toMatch(/\.message__header\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s)
    expect(narrowLayout).toMatch(/\.session-continuity__body small\s*{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/s)
    expect(narrowLayout).toMatch(/\.composer__primary-actions \.button\s*{[^}]*max-inline-size:\s*100%;[^}]*min-inline-size:\s*0;[^}]*white-space:\s*normal;/s)
  })
})
