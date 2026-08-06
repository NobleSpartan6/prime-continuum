import type { RendererPrimeBridge } from './index'

declare global {
  interface Window {
    readonly prime: RendererPrimeBridge
  }
}

export {}
