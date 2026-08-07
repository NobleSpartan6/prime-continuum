// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { TranscriptBody } from '../../src/renderer/src/TranscriptBody'

afterEach(cleanup)

describe('TranscriptBody', () => {
  it('preserves multiline tool output inside semantic pre and code elements', () => {
    const body = 'pnpm test\n  renderer: passed\n\t42 assertions'
    const { container } = render(<TranscriptBody body={body} kind="tool" />)

    const code = container.querySelector('pre > code')
    expect(code).not.toBeNull()
    expect(code?.textContent).toBe(body)
  })

  it('renders fenced code and diff lines without flattening their semantics', () => {
    const body = [
      'The patch is intentionally small:',
      '',
      '```diff',
      '@@ -1,2 +1,2 @@',
      '-const mode = "legacy"',
      '+const mode = "continuim"',
      '```',
    ].join('\n')
    const { container } = render(<TranscriptBody body={body} kind="assistant" />)

    const code = container.querySelector('pre > code.language-diff')
    expect(code).not.toBeNull()
    expect(code).toHaveTextContent('const mode = "legacy"')
    expect(container.querySelector('.transcript-body__diff-line--deletion')).toHaveTextContent('-const mode = "legacy"')
    expect(container.querySelector('.transcript-body__diff-line--addition')).toHaveTextContent('+const mode = "continuim"')
  })

  it('renders headings, lists, links, paragraphs, and inline code as document structure', () => {
    const body = [
      '## Verification',
      '',
      'The resident remains **authoritative**.',
      '',
      '- Keep `commandId` stable',
      '- Reconcile on reconnect',
      '',
      '[Read the protocol](https://example.com/protocol)',
    ].join('\n')
    const { container } = render(<TranscriptBody body={body} kind="assistant" />)

    expect(screen.getByRole('heading', { level: 2, name: 'Verification' })).toBeVisible()
    expect(screen.getByRole('list')).toBeVisible()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(container.querySelector('p')).toHaveTextContent('The resident remains authoritative.')
    expect(container.querySelector('code:not(pre code)')).toHaveTextContent('commandId')
    expect(screen.queryByRole('link', { name: 'Read the protocol' })).not.toBeInTheDocument()
    expect(container.querySelector('.transcript-body__link')).toHaveTextContent('Read the protocol · https://example.com/protocol')
  })

  it('keeps a projected single newline visible in otherwise plain prose', async () => {
    const { container } = render(<TranscriptBody body={'line one\nline two'} kind="assistant" />)
    const paragraph = container.querySelector('p')
    const css = await readFile(resolve('src/renderer/src/styles.css'), 'utf8')

    expect(paragraph?.textContent).toBe('line one\nline two')
    expect(css).toMatch(/\.transcript-body p\s*{[^}]*white-space:\s*pre-wrap;/s)
  })

  it('omits raw HTML and strips unsafe link protocols instead of adding them to the DOM', () => {
    const body = [
      '# Safe content',
      '',
      '<script>window.__transcriptExploit = true</script>',
      '<img src="x" onerror="window.__transcriptExploit = true">',
      '<div onclick="window.__transcriptExploit = true">Unsafe container</div>',
      '',
      '[Unsafe link](javascript:window.__transcriptExploit=true)',
    ].join('\n')
    const { container } = render(<TranscriptBody body={body} kind="user" />)

    expect(screen.getByRole('heading', { name: 'Safe content' })).toBeVisible()
    expect(container.querySelector('script, img, [onclick], [onerror]')).toBeNull()
    expect(container.innerHTML).not.toMatch(/<script|onclick=|onerror=/i)
    expect(screen.queryByRole('link', { name: 'Unsafe link' })).not.toBeInTheDocument()
    expect(within(container).getByText('Unsafe link')).toBeVisible()
    expect((window as typeof window & { __transcriptExploit?: boolean }).__transcriptExploit).toBeUndefined()
  })
})
