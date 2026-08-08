import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('renderer style contracts', () => {
  it('restores text-field focus outlines in Windows forced-colors mode', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'))

    expect(forcedColors).toContain('.composer textarea:focus-visible')
    expect(forcedColors).toContain('.command-palette__input input:focus-visible')
    expect(forcedColors).toContain('.model-search input:focus-visible')
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
    expect(narrowLayout).toMatch(/\.command-palette__input\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s)
    expect(narrowLayout).toMatch(/\.command-palette__shortcut\s*{[^}]*display:\s*none;/s)
    expect(narrowLayout).toMatch(/\.provider-rail\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*max-block-size:\s*10\.5rem;/s)
    expect(narrowLayout).toMatch(/\.provider-rail__summary\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\);[^}]*border-inline-end:\s*0;/s)
    expect(narrowLayout).toMatch(/\.model-catalog\s*{[^}]*overflow-y:\s*auto;/s)
    expect(narrowLayout).toMatch(/\.model-list\s*{[^}]*flex:\s*none;[^}]*overflow-y:\s*visible;/s)
    expect(narrowLayout).toMatch(/\.model-search input,\s*\.command-palette__input input\s*{[^}]*font-size:\s*1rem;/s)
    expect(css).toMatch(/body:has\(dialog\[open\]\) :is\(\.sidebar__scroll, \.transcript__scroller, \.inspector__panel\)\s*{[^}]*overflow-y:\s*hidden;/s)
    expect(css).toMatch(/\.task-state--stale\s*{[^}]*color:\s*var\(--color-text-muted\);/s)
    expect(css).toMatch(/\.message__receipt summary\s*{[^}]*min-block-size:\s*2rem;[^}]*cursor:\s*pointer;/s)
  })

  it('preserves a readable thread title and primary composer actions at 320 CSS pixels', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const minimumLayout = css.slice(
      css.indexOf('@media (max-width: 24rem)'),
      css.indexOf('@media (max-width: 24rem) and (max-height: 44rem)'),
    )
    const compactMinimumLayout = css.slice(
      css.indexOf('@media (max-width: 24rem) and (max-height: 44rem)'),
      css.indexOf('@media (min-width: 38.001rem)'),
    )

    expect(css).toMatch(/\.topbar__thread-copy h1\s*{[^}]*inline-size:\s*auto;[^}]*text-overflow:\s*ellipsis;/s)
    expect(css).toMatch(/\.models-sheet__surface\s*{[^}]*block-size:\s*min\(calc\(100dvh - 2rem\), 48rem\);/s)
    expect(css).toMatch(/\.transcript-jump__button\s*{[^}]*min-inline-size:\s*0;[^}]*max-inline-size:\s*100%;[^}]*white-space:\s*normal;/s)
    expect(minimumLayout).toMatch(/\.topbar__leading \.brand-mark\s*{[^}]*display:\s*none;/s)
    expect(minimumLayout).toMatch(/\.composer__hint\s*{[^}]*display:\s*none;/s)
    expect(compactMinimumLayout).toMatch(/\.composer--compact \.composer__connection\s*{[^}]*display:\s*inline-flex;/s)
    expect(compactMinimumLayout).toMatch(/\.composer__connection--validation\s*{[^}]*display:\s*inline-flex;/s)
    expect(css).toMatch(/\.composer--compact\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s)
    expect(css).toMatch(/\.composer-wrap--compact \.session-continuity\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s)
    expect(css).toMatch(/\.companion-card-list strong\s*{[^}]*-webkit-line-clamp:\s*2;[^}]*line-clamp:\s*2;/s)
  })

  it('keeps decorative motion behind the reduced-motion preference', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const motionStart = css.indexOf('@media (prefers-reduced-motion: no-preference)')
    const staticStyles = css.slice(0, motionStart)
    const motionStyles = css.slice(motionStart, css.indexOf('@media (max-width: 75rem)'))

    expect(staticStyles).not.toMatch(/\.model-chip\s*{[^}]*transition-property:/s)
    expect(staticStyles).not.toMatch(/\.provider-rail nav button\s*{[^}]*transition-property:/s)
    expect(staticStyles).not.toMatch(/\.models-loading > svg\s*{[^}]*animation:/s)
    expect(motionStyles).toMatch(/dialog\.sheet\[open\]\s*{[^}]*animation:\s*sheet-enter/s)
    expect(motionStyles).toMatch(/\.model-chip:active:not\(:disabled\)\s*{[^}]*scale:\s*0\.96;/s)
    expect(motionStyles).toMatch(/\.models-loading > svg\s*{[^}]*animation:\s*spin/s)
    expect(motionStyles).toContain('.composer__connection--uncertain svg.lucide-refresh-cw')
    expect(motionStyles).not.toMatch(/\.composer__connection--uncertain svg,/)
  })
})
