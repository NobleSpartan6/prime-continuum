/** Small, path-free command surface from the native application menu. */
export const NATIVE_SHELL_IPC = {
  command: 'prime:event:native-shell-command',
} as const

export type NativeShellCommand =
  | 'new-agent'
  | 'search'
  | 'toggle-sidebar'
  | 'toggle-inspector'
  | 'models'
  | 'add-computer'

export type NativePlatform = 'darwin' | 'win32' | 'linux'

export interface NativeShellBridge {
  readonly nativePlatform: NativePlatform
  onNativeShellCommand(listener: (command: NativeShellCommand) => void): () => void
}
