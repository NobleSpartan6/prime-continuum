// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PrimeInteractionPrompt } from '../../src/renderer/src/PrimeInteractionPrompt'
import type { ResidentExtensionUiRequest } from '../../src/shared/protocol'

afterEach(cleanup)

const authority = {
  interactionVersion: 1 as const,
  hostId: 'host-local',
  threadId: 'thread-main',
  executionGenerationId: 'generation-main',
  bindingFingerprint: 'a'.repeat(64),
  requestDigest: 'b'.repeat(64),
  receivedAt: '2026-08-12T12:00:00.000Z',
}

function request(
  value: Omit<ResidentExtensionUiRequest, keyof typeof authority>,
): ResidentExtensionUiRequest {
  return { ...authority, ...value } as ResidentExtensionUiRequest
}

describe('PrimeInteractionPrompt', () => {
  it('shows only the oldest request, announces it, and preserves the user’s current focus', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn(async () => ({ state: 'completed' as const, message: 'Delivered.' }))
    const older = request({ requestId: 'older', method: 'input', title: 'Name the branch', placeholder: 'feature/name' })
    const newer = request({ requestId: 'newer', method: 'confirm', title: 'Run verification?', message: 'This may take several minutes.' })
    newer.receivedAt = '2026-08-12T12:00:01.000Z'
    const outside = document.createElement('button')
    outside.textContent = 'Outside trigger'
    document.body.append(outside)
    outside.focus()

    const { rerender, unmount } = render(<PrimeInteractionPrompt requests={[newer, older]} onRespond={onRespond} />)

    expect(screen.getByRole('heading', { name: 'Name the branch' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Run verification?' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('2 questions waiting')).toHaveTextContent('2 waiting')
    expect(screen.getByText('Prime Agent needs your response: Name the branch')).toHaveAttribute('role', 'status')
    expect(outside).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('textbox', { name: 'Response' })).toHaveFocus()
    await user.type(screen.getByRole('textbox', { name: 'Response' }), 'feature/native-ui')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onRespond).toHaveBeenCalledWith(older, { kind: 'value', value: 'feature/native-ui' })

    rerender(<PrimeInteractionPrompt requests={[newer]} onRespond={onRespond} />)
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeVisible()
    outside.focus()
    rerender(<PrimeInteractionPrompt requests={[]} onRespond={onRespond} />)
    expect(outside).toHaveFocus()

    unmount()
    outside.remove()
  })

  it('uses native radios for a short selection, validates on submit, and cancels explicitly', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn(async () => ({ state: 'completed' as const, message: 'Delivered.' }))
    const select = request({
      requestId: 'select-one',
      method: 'select',
      title: 'Choose a verification level',
      options: ['Focused', 'Full', 'Release'],
    })

    render(<PrimeInteractionPrompt requests={[select]} onRespond={onRespond} />)
    const region = screen.getByRole('region', { name: 'Choose a verification level' })
    expect(within(region).getAllByRole('radio')).toHaveLength(3)

    await user.click(within(region).getByRole('button', { name: 'Choose' }))
    expect(within(region).getByText('Choose an option to continue.')).toBeVisible()
    expect(onRespond).not.toHaveBeenCalled()

    await user.click(within(region).getByRole('radio', { name: 'Full' }))
    await user.click(within(region).getByRole('button', { name: 'Choose' }))
    expect(onRespond).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledWith(select, { kind: 'value', value: 'Full' })

    cleanup()
    const cancelResponse = vi.fn(async () => ({ state: 'completed' as const, message: 'Cancelled.' }))
    render(<PrimeInteractionPrompt requests={[select]} onRespond={cancelResponse} />)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancelResponse).toHaveBeenCalledWith(select, { kind: 'cancelled' })
  })

  it('uses a native select for a long option list', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn(async () => ({ state: 'completed' as const, message: 'Delivered.' }))
    const select = request({
      requestId: 'select-many',
      method: 'select',
      title: 'Choose a target',
      options: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'],
    })

    render(<PrimeInteractionPrompt requests={[select]} onRespond={onRespond} />)
    const control = screen.getByRole('combobox', { name: 'Choose one' })
    await user.selectOptions(control, 'Six')
    await user.click(screen.getByRole('button', { name: 'Choose' }))
    expect(onRespond).toHaveBeenCalledWith(select, { kind: 'value', value: 'Six' })
  })

  it('keeps editor newlines native and sends with Command-Enter', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn(async () => ({ state: 'completed' as const, message: 'Delivered.' }))
    const editor = request({
      requestId: 'editor',
      method: 'editor',
      title: 'Adjust the migration plan',
      prefill: 'First step',
    })

    render(<PrimeInteractionPrompt requests={[editor]} onRespond={onRespond} />)
    const control = screen.getByRole('textbox', { name: 'Response' })
    await user.type(control, '{enter}Second step')
    expect(control).toHaveValue('First step\nSecond step')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(onRespond).toHaveBeenCalledWith(editor, { kind: 'value', value: 'First step\nSecond step' })
  })

  it('locks after an uncertain result and never submits the response twice', async () => {
    const user = userEvent.setup()
    let resolve!: (result: { state: 'uncertain'; message: string; retryable: false }) => void
    const onRespond = vi.fn(() => new Promise<{ state: 'uncertain'; message: string; retryable: false }>((done) => { resolve = done }))
    const confirm = request({
      requestId: 'confirm',
      method: 'confirm',
      title: 'Publish the report?',
      message: 'Prime Agent will publish the current result.',
    })

    render(<PrimeInteractionPrompt requests={[confirm]} onRespond={onRespond} />)
    const confirmButton = await screen.findByRole('button', { name: 'Confirm' })
    await user.dblClick(confirmButton)
    expect(onRespond).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledWith(confirm, { kind: 'confirmed', confirmed: true })

    resolve({ state: 'uncertain', message: 'The host stopped responding.', retryable: false })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Prime Continuim will not send it again.')
    expect(screen.getByRole('button', { name: 'Outcome unknown' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled()
    expect(onRespond).toHaveBeenCalledOnce()
  })

  it('unlocks only when the backend explicitly reports a retryable rejection', async () => {
    const user = userEvent.setup()
    const onRespond = vi
      .fn()
      .mockResolvedValueOnce({ state: 'rejected', message: 'The request is still active. Try again.', retryable: true })
      .mockResolvedValueOnce({ state: 'completed', message: 'Delivered.' })
    const input = request({ requestId: 'input', method: 'input', title: 'Add a label' })

    render(<PrimeInteractionPrompt requests={[input]} onRespond={onRespond} />)
    await user.type(screen.getByRole('textbox', { name: 'Response' }), 'release')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again.')
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onRespond).toHaveBeenCalledTimes(2)
  })
})
