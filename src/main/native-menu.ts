import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { NativeShellCommand } from '../shared/native-shell'

export interface NativeMenuOptions {
  dispatch(command: NativeShellCommand): void
  isMac?: boolean
  isPackaged?: boolean
}

export function createNativeMenuTemplate({
  dispatch,
  isMac = process.platform === 'darwin',
  isPackaged = app.isPackaged,
}: NativeMenuOptions): MenuItemConstructorOptions[] {
  const productItems: MenuItemConstructorOptions[] = [
    { label: 'New Agent', accelerator: 'CommandOrControl+N', click: () => dispatch('new-agent') },
    { label: 'Search', accelerator: 'CommandOrControl+K', click: () => dispatch('search') },
    { type: 'separator' },
    { label: 'Models & Accounts', accelerator: 'CommandOrControl+,', click: () => dispatch('models') },
    { label: 'Add Computer', click: () => dispatch('add-computer') },
    { type: 'separator' },
    { role: 'close' },
  ]

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    { label: 'File', submenu: productItems },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' as const }] : []),
        { role: 'delete' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Show or Hide Sidebar',
          accelerator: isMac ? 'Control+Command+S' : 'Control+Shift+S',
          click: () => dispatch('toggle-sidebar'),
        },
        {
          label: 'Show or Hide Inspector',
          accelerator: isMac ? 'Control+Command+I' : 'Control+Shift+I',
          click: () => dispatch('toggle-inspector'),
        },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        ...(!isPackaged ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [{ role: 'close' as const }]),
      ],
    },
  ]
  return template
}

export function installNativeMenu(options: NativeMenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(createNativeMenuTemplate(options)))
}
