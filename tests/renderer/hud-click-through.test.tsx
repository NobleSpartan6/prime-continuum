// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installHudClickThrough,
  isHudPointTransparent,
  isHudPopupFocusPinned,
} from '../../src/renderer/src/hud-click-through'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('desktop HUD transparent-area click-through', () => {
  it('distinguishes the transparent window margin from the visible HUD surface', () => {
    document.body.innerHTML = `
      <main data-hud-click-through="transparent">
        <section data-hud-interactive="true"><button type="button">Open</button></section>
      </main>
    `
    const transparent = document.querySelector('main')!
    const button = document.querySelector('button')!
    const elementFromPoint = vi.fn<Document['elementFromPoint']>()
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: elementFromPoint })

    elementFromPoint.mockReturnValueOnce(transparent)
    expect(isHudPointTransparent(document, 2, 2)).toBe(true)
    elementFromPoint.mockReturnValueOnce(button)
    expect(isHudPointTransparent(document, 12, 12)).toBe(false)
    elementFromPoint.mockReturnValueOnce(null)
    expect(isHudPointTransparent(document, 30, 30)).toBe(true)
  })

  it('pins a focused popup interactive and resets click-through on blur and cleanup', async () => {
    document.body.innerHTML = `
      <main data-hud-click-through="transparent">
        <section data-hud-interactive="true"><button type="button">Open</button></section>
        <dialog open><input aria-label="Popup field" /></dialog>
      </main>
    `
    const transparent = document.querySelector('main')!
    const popupField = document.querySelector('input')!
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn<Document['elementFromPoint']>().mockReturnValue(transparent),
    })
    const setIgnoreMouseEvents = vi.fn()
    const cleanup = installHudClickThrough({ document, window, setIgnoreMouseEvents })

    expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 4, clientY: 4 }))
    await vi.waitFor(() => expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(true))

    popupField.focus()
    expect(isHudPopupFocusPinned(document)).toBe(true)
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 4, clientY: 4 }))
    await vi.waitFor(() => expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false))

    popupField.blur()
    window.dispatchEvent(new Event('blur'))
    expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 4, clientY: 4 }))
    await vi.waitFor(() => expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(true))

    cleanup()
    expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    const callsAfterCleanup = setIgnoreMouseEvents.mock.calls.length
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 4, clientY: 4 }))
    expect(setIgnoreMouseEvents).toHaveBeenCalledTimes(callsAfterCleanup)
  })

  it('coalesces high-frequency pointer hit tests to the latest point in one frame', () => {
    document.body.innerHTML = '<main data-hud-click-through="transparent" />'
    const transparent = document.querySelector('main')!
    const elementFromPoint = vi.fn<Document['elementFromPoint']>().mockReturnValue(transparent)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: elementFromPoint })
    let nextFrameId = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const frameId = ++nextFrameId
      frames.set(frameId, callback)
      return frameId
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frameId) => {
      frames.delete(frameId)
    })
    const setIgnoreMouseEvents = vi.fn()
    const cleanup = installHudClickThrough({ document, window, setIgnoreMouseEvents })

    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 2, clientY: 3 }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 30 }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 200, clientY: 300 }))

    expect(frames.size).toBe(1)
    expect(elementFromPoint).not.toHaveBeenCalled()
    const [[frameId, frame]] = frames
    frames.delete(frameId)
    frame(performance.now())
    expect(elementFromPoint).toHaveBeenCalledOnce()
    expect(elementFromPoint).toHaveBeenLastCalledWith(200, 300)

    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 4, clientY: 5 }))
    expect(frames.size).toBe(1)
    cleanup()
    expect(frames.size).toBe(0)
    expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
  })

  it('retries a rejected native un-ignore request and always recovers on teardown', async () => {
    document.body.innerHTML = `
      <main data-hud-click-through="transparent">
        <section data-hud-interactive="true"><button type="button">Open</button></section>
      </main>
    `
    const transparent = document.querySelector('main')!
    const button = document.querySelector('button')!
    let point: Element = transparent
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn<Document['elementFromPoint']>(() => point),
    })
    let rejectNextUnignore = false
    const setIgnoreMouseEvents = vi.fn((ignore: boolean) => {
      if (!ignore && rejectNextUnignore) {
        rejectNextUnignore = false
        return Promise.reject(new Error('Native HUD state changed before the reply.'))
      }
      return Promise.resolve()
    })
    const cleanup = installHudClickThrough({ document, window, setIgnoreMouseEvents })
    await vi.waitFor(() => expect(setIgnoreMouseEvents).toHaveBeenCalledWith(false))

    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 4, clientY: 4 }))
    await vi.waitFor(() => expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(true))

    rejectNextUnignore = true
    point = button
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 12, clientY: 12 }))
    await vi.waitFor(() => expect(setIgnoreMouseEvents.mock.calls.filter(([ignore]) => ignore === false)).toHaveLength(2))
    await Promise.resolve()
    await Promise.resolve()

    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 12, clientY: 12 }))
    await vi.waitFor(() => expect(setIgnoreMouseEvents.mock.calls.filter(([ignore]) => ignore === false)).toHaveLength(3))

    cleanup()
    await vi.waitFor(() => expect(setIgnoreMouseEvents.mock.calls.filter(([ignore]) => ignore === false)).toHaveLength(4))
    expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
  })

  it('fails safely when elementFromPoint is unavailable', () => {
    const original = document.elementFromPoint
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: undefined })
    expect(isHudPointTransparent(document, 0, 0)).toBe(false)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: original })
  })
})
