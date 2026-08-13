import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('renderer style contracts', () => {
  it('keeps the Prime-inspired visual language local, restrained, and semantic', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const darkTheme = css.slice(
      css.indexOf('@media (prefers-color-scheme: dark)'),
      css.indexOf('@media (prefers-contrast: more)'),
    )
    const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'))

    expect(css).toContain('"IBM Plex Sans", "Segoe UI Variable Text"')
    expect(css).toContain('"IBM Plex Mono", "SFMono-Regular"')
    expect(css).not.toMatch(/@import\s+url|@font-face\s*{[^}]*https?:/s)
    expect(css).toContain('--color-text-faint: oklch(0.52 0.006 258)')
    expect(css).not.toMatch(/--color-(?:accent|focus):\s*oklch\([^)]*\s258\)/)
    expect(css).toContain('--color-surface-selected: oklch(0.865 0.045 145)')
    expect(css).toContain('--color-surface-selected: oklch(0.3 0.07 145)')
    expect(darkTheme).toContain('--color-canvas: oklch(0.08 0 0)')
    expect(darkTheme).toContain('--color-surface: oklch(0.158 0 0)')
    expect(darkTheme).toContain('--color-border: oklch(0.301 0 0)')
    expect(darkTheme).toContain('--color-accent: oklch(0.64 0.15 145)')
    expect(css).toMatch(/\.app-shell\s*{[^}]*grid-template-columns:\s*16rem minmax\(25rem, 1fr\);/s)
    expect(css).toMatch(/\.nav-row,\s*\.thread-row\s*{[^}]*border-radius:\s*0\.1875rem;/s)
    expect(css).toMatch(/\.empty-workbench::before\s*{[^}]*display:\s*none;/s)
    expect(forcedColors).toMatch(/\.empty-workbench::before\s*{[^}]*display:\s*none;/s)
    expect(css).not.toContain('.empty-workbench__eyebrow')
    expect(css).toMatch(/\.empty-workbench__icon\s*{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*border-radius:\s*0;/s)
    expect(css).toMatch(/\.local-setup__steps\s*{[^}]*border:\s*1px solid var\(--color-border\);[^}]*box-shadow:\s*none;/s)
    expect(css).toMatch(/\.agent-launchpad__tasks\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*border:\s*0;/s)
    expect(css).toMatch(/\.agent-launchpad__task\s*{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*border-radius:\s*var\(--radius-md\);/s)
  })

  it('restores text-field focus outlines in Windows forced-colors mode', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'))

    expect(forcedColors).toContain('.composer textarea:focus-visible')
    expect(forcedColors).toContain('.command-palette__input input:focus-visible')
    expect(forcedColors).toContain('.model-search input:focus-visible')
    expect(forcedColors).toContain('outline: 2px solid Highlight')
  })

  it('keeps the authoritative assistant stream indicator compact, motion-aware, and legible in forced colors', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'))
    const motion = css.slice(
      css.indexOf('@media (prefers-reduced-motion: no-preference)'),
      css.indexOf('@keyframes sheet-enter'),
    )

    expect(css).toMatch(/\.message__identity\s*{[^}]*display:\s*inline-flex;[^}]*min-inline-size:\s*0;/s)
    expect(css).toMatch(/\.message__streaming-indicator\s*{[^}]*display:\s*inline-flex;[^}]*flex:\s*0 0 auto;[^}]*min-block-size:\s*1\.25rem;[^}]*border-radius:\s*999px;/s)
    expect(css).toMatch(/\.message__streaming-dot\s*{[^}]*background:\s*currentColor;[^}]*border-radius:\s*50%;/s)
    expect(motion).toMatch(/\.message__streaming-dot::after\s*{[^}]*animation: prime-stream-pulse/s)
    expect(motion).toMatch(/\.message__thinking-track::after\s*{[^}]*animation: prime-stream-sweep/s)
    expect(motion).toMatch(/\.message__streaming-caret\s*{[^}]*animation: prime-stream-caret/s)
    expect(css).toMatch(/@keyframes prime-stream-sweep\s*{[^}]*(?:opacity|transform):/s)
    expect(css).not.toMatch(/@keyframes prime-stream-(?:pulse|sweep|caret)\s*{[^}]*(?:width|left|margin|padding):/s)
    expect(forcedColors).toMatch(/\.message__streaming-indicator\s*{[^}]*border-color:\s*ButtonText;/s)
    expect(forcedColors).toContain('.message__streaming-dot')
  })

  it('renders recursive sessions as a clear coordinator and child-session hierarchy', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')

    expect(css).toMatch(/\.rlm-map\s*{[^}]*border:\s*0;/s)
    expect(css).toMatch(/\.rlm-map__root\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\);/s)
    expect(css).toMatch(/\.rlm-map__row\s*{[^}]*padding-inline:\s*calc\(0\.25rem \+ var\(--rlm-depth, 0\) \* 0\.75rem\) 0\.25rem;[^}]*border:\s*0;[^}]*content-visibility:\s*auto;[^}]*contain-intrinsic-block-size:\s*auto 4\.1rem;/s)
    expect(css).not.toContain('.rlm-map__connector')
    expect(css).not.toContain('.session-lifecycle-path')
  })

  it('keeps transcript metadata and the composer action inside narrow viewports', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const compactComposerStart = css.indexOf('@container composer (max-width: 44rem)')
    const compactComposer = css.slice(
      compactComposerStart,
      css.indexOf('@media (max-width: 38rem)', compactComposerStart),
    )
    const narrowLayout = css.slice(
      css.indexOf('@media (max-width: 38rem)'),
      css.indexOf('@media (max-width: 24rem)'),
    )

    expect(narrowLayout).toMatch(/\.message__header\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s)
    expect(narrowLayout).toMatch(/\.session-continuity\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s)
    expect(narrowLayout).toMatch(/\.session-continuity__body small\s*{[^}]*display:\s*none;/s)
    expect(narrowLayout).toMatch(/\.session-continuity__queue\s*{[^}]*display:\s*none;/s)
    expect(narrowLayout).toMatch(/\.session-continuity__manage\s*{[^}]*display:\s*grid;[^}]*min-inline-size:\s*2\.75rem;/s)
    expect(narrowLayout).toMatch(/\.session-continuity__manage-label\s*{[^}]*position:\s*absolute;[^}]*clip-path:\s*inset\(50%\);/s)
    expect(narrowLayout).toMatch(/\.composer__primary-actions \.button\s*{[^}]*max-inline-size:\s*100%;[^}]*min-inline-size:\s*0;[^}]*white-space:\s*normal;/s)
    expect(narrowLayout).toMatch(/\.command-palette__input\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s)
    expect(narrowLayout).toMatch(/\.command-palette__shortcut\s*{[^}]*display:\s*none;/s)
    expect(narrowLayout).toMatch(/\.provider-rail\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*max-block-size:\s*10\.5rem;/s)
    expect(narrowLayout).toMatch(/\.provider-rail__summary\s*{[^}]*grid-template-columns:\s*auto auto minmax\(0, 1fr\);[^}]*border-inline-end:\s*0;/s)
    expect(narrowLayout).toMatch(/\.model-catalog\s*{[^}]*overflow-y:\s*auto;/s)
    expect(narrowLayout).toMatch(/\.runtime-oauth-feedback\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s)
    expect(narrowLayout).toMatch(/\.runtime-oauth-feedback > \.button\s*{[^}]*grid-column:\s*1;[^}]*grid-row:\s*auto;/s)
    expect(narrowLayout).toMatch(/\.model-list\s*{[^}]*flex:\s*none;[^}]*overflow-y:\s*visible;/s)
    expect(narrowLayout).toMatch(/\.resident-recovery\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\);/s)
    expect(narrowLayout).toMatch(/\.resident-recovery > \.button\s*{[^}]*grid-column:\s*1 \/ -1;[^}]*inline-size:\s*100%;/s)
    expect(narrowLayout).toMatch(/\.empty-workbench__actions\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*inline-size:\s*100%;/s)
    expect(narrowLayout).toMatch(/\.empty-workbench__actions \.button,\s*\.sheet--resident \.sheet__footer \.button,\s*\.sheet--candidate-evaluation \.sheet__footer \.button\s*{[^}]*inline-size:\s*100%;/s)
    expect(narrowLayout).toMatch(/\.model-search input,\s*\.command-palette__input input\s*{[^}]*font-size:\s*1rem;/s)
    expect(css).toMatch(/body:has\(dialog\[open\]\) :is\(\.sidebar__scroll, \.transcript__scroller, \.inspector__panel\)\s*{[^}]*overflow-y:\s*hidden;/s)
    expect(css).toMatch(/\.task-state--stale\s*{[^}]*color:\s*var\(--color-text-muted\);/s)
    expect(css).toMatch(/\.runtime-oauth-feedback\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*align-items:\s*center;/s)
    expect(css).toMatch(/\.message__receipt summary\s*{[^}]*min-block-size:\s*2rem;[^}]*cursor:\s*pointer;/s)
    expect(css).toMatch(/\.composer-wrap\s*{[^}]*container-name:\s*composer;[^}]*container-type:\s*inline-size;/s)
    expect(compactComposer).toMatch(/\.task-starters\s*{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;[^}]*scroll-snap-type:\s*inline proximity;/s)
    expect(compactComposer).toMatch(/\.task-starters__item\s*{[^}]*flex:\s*0 0 10\.75rem;[^}]*scroll-snap-align:\s*start;/s)
    expect(css).toMatch(/\.task-starters__item > span\s*{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s)
  })

  it('collapses the short HUD to one status and one control surface', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const compactHudStart = css.indexOf('@media (max-height: 18rem)')
    const compactHud = css.slice(compactHudStart, css.indexOf('@media (max-height: 6rem)', compactHudStart))

    expect(compactHud).toMatch(/\.hud-session-strip__facts,\s*\.hud-expanded__thread > \.transcript\s*{[^}]*display:\s*none;/s)
    expect(compactHud).toMatch(/\.hud-expanded \.composer-wrap\s*{[^}]*margin-block-start:\s*auto;/s)
    expect(css).toMatch(/\.hud-expanded \.composer:focus-within\s*{[^}]*inset 0 0 0 1px[^}]*;/s)
    expect(css).not.toMatch(/\.hud-expanded \.composer:focus-within\s*{[^}]*inset 2px 0/s)
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
    expect(compactMinimumLayout).toMatch(/\.composer--compact\.composer--ending \.composer__connection:not\(\.composer__connection--validation\)\s*{[^}]*display:\s*none;/s)
    expect(compactMinimumLayout).toMatch(/\.composer__connection--validation\s*{[^}]*display:\s*inline-flex;/s)
    expect(css).toMatch(/\.composer--compact\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s)
    expect(css).toMatch(/\.composer-wrap--compact \.session-continuity\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s)
    expect(css).toMatch(/\.session-continuity__summary\s*{[^}]*display:\s*flex;[^}]*min-inline-size:\s*0;/s)
    expect(css).not.toMatch(/\.companion-|\.pair-mobile-/)
  })

  it('uses selection fill instead of decorative rails and gives the 390px inspector the full canvas', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const phoneDrawer = css.slice(
      css.indexOf('@media (max-width: 25rem)'),
      css.indexOf('@media (forced-colors: active)', css.indexOf('@media (max-width: 25rem)')),
    )

    expect(css).not.toMatch(/\.thread-row--selected::before/)
    expect(css).not.toMatch(/\.model-row(?:--current|--selected)?\s*{[^}]*border-inline-start/s)
    expect(css).toMatch(/\.model-row--selected\s*{[^}]*background:\s*var\(--color-success-soft\);/s)
    expect(phoneDrawer).toMatch(/\.sidebar,\s*\.inspector\s*{[^}]*inline-size:\s*100%;/s)
  })

  it('collapses only nonessential composer context when a 320px workbench is extremely short', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const shortMinimumStart = css.indexOf('@media (max-width: 24rem) and (max-height: 28rem)')
    const shortMinimumLayout = css.slice(
      shortMinimumStart,
      css.indexOf('@media (max-height: 28rem)', shortMinimumStart),
    )

    expect(shortMinimumStart).toBeGreaterThan(-1)
    expect(css).toMatch(/\.thread-view\s*{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/s)
    expect(shortMinimumLayout).toMatch(/\.session-continuity,\s*\.composer__intent\s*{[^}]*display:\s*none;/s)
    expect(shortMinimumLayout).not.toMatch(/\.composer__toolbar\s*{[^}]*display:\s*none;/s)
    expect(shortMinimumLayout).not.toMatch(/\.composer__connection(?:--[\w-]+)?\s*{[^}]*display:\s*none;/s)
    expect(shortMinimumLayout).not.toMatch(/\.composer__actions|\.model-chip|\.composer__primary-actions/)
    expect(css).toMatch(/\.model-chip\s*{[^}]*min-block-size:\s*2\.5rem;/s)
    expect(shortMinimumLayout).toMatch(/dialog\.sheet\.models-sheet,\s*\.models-sheet__surface\s*{[^}]*block-size:\s*calc\(100dvh - 0\.5rem\);[^}]*max-block-size:\s*calc\(100dvh - 0\.5rem\);/s)
    expect(shortMinimumLayout).toMatch(/\.models-sheet__header\s*{[^}]*min-block-size:\s*3\.25rem;[^}]*padding:\s*0\.5rem 0\.75rem;/s)
    expect(shortMinimumLayout).toMatch(/\.provider-rail\s*{[^}]*display:\s*block;[^}]*max-block-size:\s*3\.25rem;[^}]*overflow-y:\s*hidden;/s)
    expect(shortMinimumLayout).toMatch(/\.provider-rail__summary\s*{[^}]*display:\s*none;/s)
    expect(shortMinimumLayout).toMatch(/\.provider-rail__toolbar button\s*{[^}]*min-block-size:\s*2\.75rem;/s)
    expect(shortMinimumLayout).toMatch(/\.model-catalog\s*{[^}]*min-block-size:\s*2\.75rem;[^}]*overflow-y:\s*auto;/s)
  })

  it('keeps the explicit cached-computer action visible without adding motion at narrow widths', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const adaptiveLayout = css.slice(
      css.indexOf('@media (max-width: 50rem)'),
      css.indexOf('@media (max-width: 38rem)'),
    )
    const compactLayout = css.slice(
      css.indexOf('@media (max-width: 24rem) and (max-height: 44rem)'),
      css.indexOf('@media (min-width: 38.001rem)'),
    )

    expect(css).toMatch(/\.connection-notice__action\s*{[^}]*flex:\s*0 0 auto;[^}]*margin-inline-start:\s*0\.25rem;/s)
    expect(adaptiveLayout).toMatch(/\.connection-notice__action\s*{[^}]*order:\s*2;[^}]*margin-inline-start:\s*auto;/s)
    expect(compactLayout).toMatch(/\.connection-notice__detail\s*{[^}]*display:\s*none;/s)
    expect(css).not.toMatch(/\.connection-notice__action\s*{[^}]*animation:/s)
  })

  it('keeps resident setup controls reachable in a short zoomed viewport', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const shortLayout = css.slice(
      css.indexOf('@media (max-height: 28rem)'),
      css.indexOf('@media (min-width: 38.001rem)'),
    )
    const narrowShortLayout = css.slice(
      css.indexOf('@media (max-width: 38rem) and (max-height: 28rem)'),
      css.indexOf('@media (pointer: coarse)'),
    )

    expect(shortLayout).toMatch(/dialog\.sheet--resident,\s*dialog\.sheet--candidate-evaluation\s*{[^}]*max-block-size:\s*calc\(100dvh - 0\.5rem\);/s)
    expect(shortLayout).toMatch(/\.sheet--resident \.sheet__scroll,\s*\.sheet--candidate-evaluation \.sheet__scroll\s*{[^}]*max-block-size:\s*none;[^}]*padding:\s*0\.65rem 0\.75rem;/s)
    expect(shortLayout).toMatch(/\.sheet--resident \.sheet__footer,\s*\.sheet--candidate-evaluation \.sheet__footer\s*{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s)
    expect(shortLayout).toMatch(/\.sheet--resident \.sheet__footer\s*{[^}]*grid-template-columns:\s*minmax\(5\.5rem, 2fr\) minmax\(10rem, 3fr\);/s)
    expect(shortLayout).toMatch(/\.sheet--resident \.sheet__footer \.button,\s*\.sheet--candidate-evaluation \.sheet__footer \.button\s*{[^}]*inline-size:\s*100%;[^}]*min-block-size:\s*2\.25rem;/s)
    expect(narrowShortLayout).toMatch(/\.sheet--resident \.sheet__footer,\s*\.sheet--candidate-evaluation \.sheet__footer\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s)
    expect(narrowShortLayout).toMatch(/\.sheet--resident \.sheet__footer \.button,\s*\.sheet--candidate-evaluation \.sheet__footer \.button\s*{[^}]*min-inline-size:\s*0;[^}]*white-space:\s*normal;/s)
    expect(narrowShortLayout).toMatch(/\.sheet--resident \.sheet__footer\s*{[^}]*grid-template-columns:\s*minmax\(4\.5rem, 1fr\) minmax\(0, 1\.75fr\);/s)
    const visuallyHiddenResidentCopy = shortLayout.match(
      /\.sheet--resident \.sheet__title-group p,\s*\.sheet--resident \.form-field small\s*{[^}]*}/s,
    )?.[0]
    expect(visuallyHiddenResidentCopy).toMatch(/position:\s*absolute;[^}]*inline-size:\s*1px;[^}]*block-size:\s*1px;/s)
    expect(visuallyHiddenResidentCopy).toMatch(/clip:\s*rect\(0 0 0 0\);[^}]*clip-path:\s*inset\(50%\);/s)
    expect(visuallyHiddenResidentCopy).not.toMatch(/display:\s*none/)
    expect(css).toMatch(/\.resident-end-state\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\);/s)
    expect(css).toMatch(/\.sidebar__registered-resident \.sidebar__create-resident\s*{[^}]*min-block-size:\s*2\.75rem;[^}]*white-space:\s*normal;/s)
    expect(css).toMatch(/\.sidebar__registered-resident > small\s*{[^}]*line-height:\s*1\.4;[^}]*text-wrap:\s*pretty;/s)
    expect(css).toMatch(/\.form-field__fixed-value\s*{[^}]*min-inline-size:\s*0;[^}]*overflow-wrap:\s*anywhere;/s)
    expect(css).not.toMatch(/\.sidebar__registered-resident(?:\s+[^,{]+)?\s*{[^}]*animation:/s)
  })

  it('keeps the model provider toolbar semantics aligned with its visual breakpoint', async () => {
    const source = await readFile(resolve('src/renderer/src/ModelsDialog.tsx'), 'utf8')

    expect(source).toContain("useMediaQueryMatch('(max-width: 50rem)')")
    expect(source).not.toContain("useMediaQueryMatch('(max-width: 75rem)')")
  })

  it('keeps decorative motion behind the reduced-motion preference', async () => {
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')
    const motionStart = css.indexOf('@media (prefers-reduced-motion: no-preference)')
    const staticStyles = css.slice(0, motionStart)
    const motionStyles = css.slice(motionStart, css.indexOf('@media (max-width: 75rem)'))

    expect(staticStyles).not.toMatch(/\.model-chip\s*{[^}]*transition-property:/s)
    expect(staticStyles).not.toMatch(/\.provider-rail__toolbar button\s*{[^}]*transition-property:/s)
    expect(staticStyles).not.toMatch(/\.models-loading > svg\s*{[^}]*animation:/s)
    expect(motionStyles).toMatch(/dialog\.sheet\[open\]\s*{[^}]*animation:\s*sheet-enter/s)
    expect(motionStyles).toMatch(/\.model-chip:active:not\(:disabled\)\s*{[^}]*scale:\s*0\.96;/s)
    expect(motionStyles).toMatch(/\.models-loading > svg\s*{[^}]*animation:\s*spin/s)
    expect(motionStyles).toContain('.composer__connection--uncertain svg.lucide-refresh-cw')
    expect(motionStyles).not.toMatch(/\.composer__connection--uncertain svg,/)
  })

})
