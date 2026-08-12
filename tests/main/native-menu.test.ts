import { beforeEach, describe, expect, it, vi } from 'vitest'

const { setApplicationMenu, buildFromTemplate } = vi.hoisted(() => ({
  setApplicationMenu: vi.fn(),
  buildFromTemplate: vi.fn((template) => ({ template })),
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, name: 'Prime Continuim' },
  Menu: { setApplicationMenu, buildFromTemplate },
}))

import { createNativeMenuTemplate, installNativeMenu } from '../../src/main/native-menu'

beforeEach(() => {
  setApplicationMenu.mockClear()
  buildFromTemplate.mockClear()
})

describe('native application menu', () => {
  it('exposes standard macOS roles and a compact set of product commands', () => {
    const dispatch = vi.fn()
    const template = createNativeMenuTemplate({ dispatch, isMac: true, isPackaged: true })

    expect(template[0]?.label).toBe('Prime Continuim')
    const file = template.find((item) => item.label === 'File')
    const fileItems = file?.submenu as Electron.MenuItemConstructorOptions[]
    expect(fileItems.map((item) => item.label ?? item.role)).toEqual([
      'New Agent',
      'Search',
      undefined,
      'Models & Accounts',
      'Add Computer',
      undefined,
      'close',
    ])
    fileItems[0]?.click?.({} as Electron.MenuItem, undefined, {} as KeyboardEvent)
    expect(dispatch).toHaveBeenCalledWith('new-agent')

    const view = template.find((item) => item.label === 'View')
    const viewItems = view?.submenu as Electron.MenuItemConstructorOptions[]
    expect(viewItems.some((item) => item.role === 'toggleDevTools')).toBe(false)
    expect(viewItems.some((item) => item.role === 'togglefullscreen')).toBe(true)
  })

  it('keeps developer tools out of packaged menus and installs the built template', () => {
    installNativeMenu({ dispatch: vi.fn(), isMac: false, isPackaged: true })
    expect(buildFromTemplate).toHaveBeenCalledOnce()
    expect(setApplicationMenu).toHaveBeenCalledWith(expect.objectContaining({ template: expect.any(Array) }))
  })
})
