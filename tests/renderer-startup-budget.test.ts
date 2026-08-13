import { describe, expect, it } from 'vitest'
import {
  RENDERER_STARTUP_GZIP_BUDGET_BYTES,
  rendererStartupBudgetReport,
} from '../renderer-startup-budget'

function chunk(input: {
  fileName: string
  facadeModuleId?: string | null
  isEntry?: boolean
  imports?: string[]
  code?: string
}) {
  return {
    type: 'chunk' as const,
    fileName: input.fileName,
    facadeModuleId: input.facadeModuleId ?? null,
    isEntry: input.isEntry ?? false,
    imports: input.imports ?? [],
    code: input.code ?? '',
  }
}

function asset(fileName: string, source: string) {
  return {
    type: 'asset' as const,
    fileName,
    source,
  }
}

describe('renderer startup budget', () => {
  it('counts only the complete static native entry and App closure', () => {
    const report = rendererStartupBudgetReport({
      'index.js': chunk({
        fileName: 'index.js',
        facadeModuleId: '/repo/src/renderer/index.html',
        isEntry: true,
        imports: ['shared.js'],
        code: 'entry',
      }),
      'App.js': chunk({
        fileName: 'App.js',
        facadeModuleId: '/repo/src/renderer/src/App.tsx',
        imports: ['shared.js'],
        code: 'app',
      }),
      'shared.js': chunk({ fileName: 'shared.js', code: 'shared' }),
      'Deferred.js': chunk({ fileName: 'Deferred.js', code: 'deferred' }),
      'index.css': asset('index.css', '.workbench { display: grid }'),
      'index.html': asset('index.html', '<main id="root"></main>'),
      'icon.svg': asset('icon.svg', '<svg />'),
    })

    expect(report.chunks.map((candidate) => candidate.fileName)).toEqual([
      'App.js',
      'index.js',
      'shared.js',
    ])
    expect(report.assets.map((candidate) => candidate.fileName)).toEqual(['index.css', 'index.html'])
    expect(report.rawBytes).toBe(
      Buffer.byteLength('entryappshared.workbench { display: grid }<main id="root"></main>'),
    )
    expect(report.budgetBytes).toBe(RENDERER_STARTUP_GZIP_BUDGET_BYTES)
  })

  it('fails closed when the native entry, App boundary, or a static import is absent', () => {
    expect(() => rendererStartupBudgetReport({
      'App.js': chunk({ fileName: 'App.js', facadeModuleId: '/repo/src/renderer/src/App.tsx' }),
    })).toThrow(/could not identify the native entry and App chunks/)

    expect(() => rendererStartupBudgetReport({
      'index.js': chunk({
        fileName: 'index.js',
        facadeModuleId: '/repo/src/renderer/index.html',
        isEntry: true,
        imports: ['missing.js'],
      }),
      'App.js': chunk({ fileName: 'App.js', facadeModuleId: '/repo/src/renderer/src/App.tsx' }),
    })).toThrow('Renderer startup imports missing chunk missing.js.')
  })

  it('reports an over-budget closure without truncating its exact size', () => {
    let state = 0x12345678
    const noisyCode = Array.from({ length: 12_000 }, () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      return state.toString(36).padStart(7, '0')
    }).join('')
    const report = rendererStartupBudgetReport({
      'index.js': chunk({
        fileName: 'index.js',
        facadeModuleId: '/repo/src/renderer/index.html',
        isEntry: true,
        code: noisyCode,
      }),
      'App.js': chunk({
        fileName: 'App.js',
        facadeModuleId: '/repo/src/renderer/src/App.tsx',
        code: noisyCode,
      }),
      'index.css': asset('index.css', noisyCode),
    }, 32)

    expect(report.gzipBytes).toBeGreaterThan(report.budgetBytes)
    expect(report.rawBytes).toBe(Buffer.byteLength(noisyCode) * 3)
  })
})
