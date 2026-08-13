import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'

import type { ModelsDialogProps } from './ModelsDialog'

type ModelsDialogModule = { default: ComponentType<ModelsDialogProps> }
type ModelsDialogLoader = () => Promise<ModelsDialogModule>

function DialogFrame({
  open,
  triggerRef,
  onClose,
  children,
}: Pick<ModelsDialogProps, 'open' | 'triggerRef' | 'onClose'> & { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const restoreTargetRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      restoreTargetRef.current = triggerRef.current ?? (document.activeElement as HTMLElement | null)
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
      window.requestAnimationFrame(() => {
        const focusTarget = dialog.querySelector<HTMLElement>('[data-dialog-autofocus]') ??
          dialog.querySelector<HTMLElement>('button')
        focusTarget?.focus()
      })
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
    }
  }, [open, triggerRef])

  return (
    <dialog
      ref={dialogRef}
      className="sheet models-sheet"
      aria-labelledby="models-title"
      aria-describedby="models-description"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={() => {
        onClose()
        window.requestAnimationFrame(() => (restoreTargetRef.current ?? triggerRef.current)?.focus())
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      {children}
    </dialog>
  )
}

function ModelsDialogUnavailable(props: ModelsDialogProps) {
  return (
    <div className="sheet__surface models-sheet__surface">
        <header className="sheet__header models-sheet__header">
          <div className="sheet__title-group">
            <div>
              <h2 id="models-title">Models &amp; accounts unavailable</h2>
              <p id="models-description">The packaged model-catalog view could not be loaded.</p>
            </div>
          </div>
        </header>
        <div className="models-error" role="alert">
          <div>
            <strong>Restart Prime Continuim</strong>
            <p>Your current thread and resident authority were not changed.</p>
            <button data-dialog-autofocus className="button button--secondary" type="button" onClick={props.onClose}>Close dialog</button>
          </div>
        </div>
    </div>
  )
}

function ModelsDialogLoading({ onClose }: Pick<ModelsDialogProps, 'onClose'>) {
  return (
    <div className="sheet__surface models-sheet__surface">
      <header className="sheet__header models-sheet__header">
        <div className="sheet__title-group">
          <div>
            <h2 id="models-title">Models &amp; accounts</h2>
            <p id="models-description">Loading the model-catalog controls for this computer.</p>
          </div>
        </div>
        <button data-dialog-autofocus className="icon-button" type="button" aria-label="Close models and accounts" onClick={onClose}>×</button>
      </header>
      <div className="models-loading" role="status" aria-live="polite">
        <div><strong>Opening model catalog</strong><span>No account or model action has been sent.</span></div>
      </div>
    </div>
  )
}

export async function loadModelsDialog(loader: ModelsDialogLoader): Promise<ModelsDialogModule> {
  try {
    return await loader()
  } catch {
    return { default: ModelsDialogUnavailable }
  }
}

export function createDeferredModelsDialog(
  loader: ModelsDialogLoader = () => import('./ModelsDialog'),
): ComponentType<ModelsDialogProps> {
  const LazyModelsDialog = lazy(() => loadModelsDialog(loader))

  return function DeferredModelsDialogComponent(props: ModelsDialogProps) {
    const [activated, setActivated] = useState(props.open)

    useEffect(() => {
      if (props.open) setActivated(true)
    }, [props.open])

    if (!activated && !props.open) return null

    return (
      <DialogFrame {...props}>
        {!activated ? (
          <ModelsDialogLoading onClose={props.onClose} />
        ) : (
          <Suspense fallback={<ModelsDialogLoading onClose={props.onClose} />}>
            <LazyModelsDialog {...props} />
          </Suspense>
        )}
      </DialogFrame>
    )
  }
}

export const DeferredModelsDialog = createDeferredModelsDialog()
