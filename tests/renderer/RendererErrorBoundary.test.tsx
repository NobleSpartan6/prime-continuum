// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RendererErrorBoundary from '../../src/renderer/src/RendererErrorBoundary'

function BrokenWorkbench(): never {
  throw new Error('sensitive workspace detail')
}

describe('RendererErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps a path-free recovery surface available without replaying work', () => {
    const reload = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(
      <RendererErrorBoundary onReload={reload}>
        <BrokenWorkbench />
      </RendererErrorBoundary>,
    )

    const recovery = screen.getByRole('alert')
    expect(recovery.textContent).toContain('The interface hit a recoverable error')
    expect(recovery.textContent).toContain('never resubmits a task')
    expect(recovery.textContent).not.toContain('sensitive workspace detail')

    fireEvent.click(screen.getByRole('button', { name: 'Reload interface' }))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('does not interfere with a healthy workbench', () => {
    render(
      <RendererErrorBoundary>
        <main>Ready</main>
      </RendererErrorBoundary>,
    )

    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
