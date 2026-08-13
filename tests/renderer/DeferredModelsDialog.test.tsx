// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, useState, type ComponentType } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createDeferredModelsDialog } from '../../src/renderer/src/DeferredModelsDialog'
import { createPreviewRendererApi, previewSnapshot } from '../../src/renderer/src/api.preview'
import type { ModelsDialogProps } from '../../src/renderer/src/ModelsDialog'

beforeAll(() => {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute('open', '') },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    },
  })
})

afterEach(cleanup)

describe('DeferredModelsDialog', () => {
  it('keeps one visible modal node while the statically imported sheet resolves', async () => {
    const user = userEvent.setup()
    let resolveModule!: (module: { default: ComponentType<ModelsDialogProps> }) => void
    const pendingModule = new Promise<{ default: ComponentType<ModelsDialogProps> }>((resolve) => {
      resolveModule = resolve
    })
    const loader = vi.fn(() => pendingModule)
    const DeferredModelsDialog = createDeferredModelsDialog(loader)
    const api = createPreviewRendererApi()
    const host = previewSnapshot.hosts[0]!
    const triggerRef = createRef<HTMLButtonElement>()

    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>Open models</button>
          <DeferredModelsDialog api={api} open={open} host={host} canSelectResidentModel={false} canConnectRuntimeOAuth={false} canOpenRuntimeProviderSetup={false} triggerRef={triggerRef} onClose={() => setOpen(false)} />
        </>
      )
    }

    render(<Harness />)
    expect(loader).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Open models' }))

    const loadingDialog = await screen.findByRole('dialog', { name: 'Models & accounts' })
    expect(within(loadingDialog).getByRole('status')).toHaveTextContent('No account or model action has been sent.')
    expect(within(loadingDialog).getByRole('button', { name: 'Close models and accounts' })).toHaveFocus()

    resolveModule({
      default: () => (
        <div>
          <h2 id="models-title">Models &amp; accounts</h2>
          <p id="models-description">Loaded catalog</p>
        </div>
      ),
    })
    await screen.findByText('Loaded catalog')
    expect(screen.getByRole('dialog', { name: 'Models & accounts' })).toBe(loadingDialog)
  })

  it('does not load while closed and restores trigger focus after a caught chunk rejection', async () => {
    const user = userEvent.setup()
    const loader = vi.fn(async () => { throw new Error('chunk unavailable') })
    const DeferredModelsDialog = createDeferredModelsDialog(loader)
    const api = createPreviewRendererApi()
    const host = previewSnapshot.hosts[0]!
    const triggerRef = createRef<HTMLButtonElement>()

    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>Open models</button>
          <DeferredModelsDialog
            api={api}
            open={open}
            host={host}
            canSelectResidentModel={false}
            canConnectRuntimeOAuth={false}
            canOpenRuntimeProviderSetup={false}
            triggerRef={triggerRef}
            onClose={() => setOpen(false)}
          />
        </>
      )
    }

    render(<Harness />)
    expect(loader).not.toHaveBeenCalled()

    const trigger = screen.getByRole('button', { name: 'Open models' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Models & accounts unavailable' })

    expect(loader).toHaveBeenCalledOnce()
    expect(dialog).toHaveTextContent('Your current thread and resident authority were not changed.')
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})
