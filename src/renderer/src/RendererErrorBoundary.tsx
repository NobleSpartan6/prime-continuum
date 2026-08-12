import { Component, type ErrorInfo, type ReactNode } from 'react'

type RendererErrorBoundaryProps = {
  children: ReactNode
  onReload?: () => void
}

type RendererErrorBoundaryState = {
  failed: boolean
}

export default class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the renderer usable without forwarding workspace or transcript data.
    console.error('Prime Continuim renderer recovery boundary', {
      name: error.name,
      componentStackPresent: Boolean(info.componentStack?.length),
    })
  }

  private reload = (): void => {
    if (this.props.onReload) {
      this.props.onReload()
      return
    }
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children

    return (
      <main className="startup-failure">
        <section className="startup-failure__panel" role="alert" aria-labelledby="renderer-recovery-title">
          <span className="startup-failure__status" aria-hidden="true" />
          <p className="startup-failure__eyebrow">Prime Continuim</p>
          <h1 id="renderer-recovery-title">The interface hit a recoverable error</h1>
          <p>
            Agent state remains with the local service. Reloading restarts only this interface and never resubmits a task.
          </p>
          <button className="button button--primary startup-failure__action" type="button" onClick={this.reload}>
            Reload interface
          </button>
          <code>RENDERER_RECOVERY_REQUIRED</code>
        </section>
      </main>
    )
  }
}
