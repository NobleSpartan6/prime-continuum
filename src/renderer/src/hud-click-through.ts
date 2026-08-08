const HUD_INTERACTIVE_SELECTOR = '[data-hud-interactive="true"]'
const HUD_TRANSPARENT_SELECTOR = '[data-hud-click-through="transparent"]'
const HUD_POPUP_PIN_SELECTOR = [
  'dialog[open]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-hud-click-through-pin="true"]',
].join(',')

export interface HudClickThroughOptions {
  document: Document
  window: Window
  setIgnoreMouseEvents: (ignore: boolean) => void | Promise<unknown>
}

function invokeWithoutLeakingRejections(
  callback: (ignore: boolean) => void | Promise<unknown>,
  ignore: boolean,
  onSettled?: (succeeded: boolean) => void,
) {
  try {
    const result = callback(ignore)
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void Promise.resolve(result).then(
        () => onSettled?.(true),
        () => onSettled?.(false),
      )
    } else {
      onSettled?.(true)
    }
  } catch {
    // Click-through is a window affordance, never a reason to crash the HUD.
    onSettled?.(false)
  }
}

export function isHudPopupFocusPinned(document: Document): boolean {
  const activeElement = document.activeElement
  return activeElement instanceof Element && Boolean(activeElement.closest(HUD_POPUP_PIN_SELECTOR))
}

export function isHudPointTransparent(document: Document, clientX: number, clientY: number): boolean {
  const elementFromPoint = document.elementFromPoint?.bind(document)
  if (!elementFromPoint) return false
  const element = elementFromPoint(clientX, clientY)
  if (!element) return true
  if (element.closest(HUD_INTERACTIVE_SELECTOR)) return false
  return element === document.documentElement ||
    element === document.body ||
    Boolean(element.closest(HUD_TRANSPARENT_SELECTOR))
}

/**
 * Lets clicks pass through only the transparent pixels around a HUD surface.
 * A focused popup pins the window interactive so a pointer crossing its visual
 * bounds cannot dismiss native/select UI underneath another application.
 */
export function installHudClickThrough(options: HudClickThroughOptions): () => void {
  const { document, window, setIgnoreMouseEvents } = options
  let active = true
  let confirmedIgnored: boolean | undefined
  let pendingIgnored: boolean | undefined
  let requestSequence = 0
  let lastPoint: { clientX: number; clientY: number } | undefined

  const setIgnored = (next: boolean, force = false) => {
    if (!force && (confirmedIgnored === next || pendingIgnored === next)) return
    const sequence = ++requestSequence
    pendingIgnored = next
    invokeWithoutLeakingRejections(setIgnoreMouseEvents, next, (succeeded) => {
      if (sequence !== requestSequence) return
      pendingIgnored = undefined
      confirmedIgnored = succeeded ? next : undefined
    })
  }

  const updateFromLastPoint = () => {
    if (!active) return
    if (isHudPopupFocusPinned(document)) {
      setIgnored(false)
      return
    }
    if (lastPoint) {
      setIgnored(isHudPointTransparent(document, lastPoint.clientX, lastPoint.clientY))
    }
  }

  const handlePointerMove = (event: Event) => {
    const pointerEvent = event as PointerEvent
    lastPoint = { clientX: pointerEvent.clientX, clientY: pointerEvent.clientY }
    updateFromLastPoint()
  }
  const handleFocusIn = () => updateFromLastPoint()
  const handleFocusOut = () => {
    window.setTimeout(updateFromLastPoint, 0)
  }
  const handleBlur = () => {
    lastPoint = undefined
    // Blur is a recovery boundary. Send an explicit interactive request even
    // if a prior un-ignore reply was lost or rejected.
    setIgnored(false, true)
  }

  window.addEventListener('pointermove', handlePointerMove, { passive: true })
  window.addEventListener('blur', handleBlur)
  document.addEventListener('focusin', handleFocusIn)
  document.addEventListener('focusout', handleFocusOut)
  setIgnored(false, true)

  return () => {
    active = false
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('blur', handleBlur)
    document.removeEventListener('focusin', handleFocusIn)
    document.removeEventListener('focusout', handleFocusOut)
    // Teardown is the final recovery boundary. Never trust local bookkeeping
    // to prove that the native skip-taskbar window is still interactive.
    requestSequence += 1
    invokeWithoutLeakingRejections(setIgnoreMouseEvents, false)
    pendingIgnored = undefined
    confirmedIgnored = undefined
  }
}
