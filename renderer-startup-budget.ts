import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Plugin } from 'vite'

interface OutputChunkLike {
  type: 'chunk'
  fileName: string
  facadeModuleId: string | null
  isEntry: boolean
  imports: string[]
  code: string
}

interface OutputAssetLike {
  type: 'asset'
  fileName: string
  source: string | Uint8Array
}

type OutputBundleLike = Record<string, OutputChunkLike | OutputAssetLike>

export const RENDERER_STARTUP_GZIP_BUDGET_BYTES = 200 * 1024

export interface RendererStartupBudgetReport {
  budgetBytes: number
  gzipBytes: number
  rawBytes: number
  chunks: Array<{ fileName: string; gzipBytes: number; rawBytes: number }>
  assets: Array<{ fileName: string; gzipBytes: number; rawBytes: number }>
}

interface RendererStartupClosure {
  budgetBytes: number
  chunks: OutputChunkLike[]
  assets: OutputAssetLike[]
}

function sourceEndsWith(chunk: OutputChunkLike, suffix: string): boolean {
  return chunk.facadeModuleId?.replaceAll('\\', '/').endsWith(suffix) === true
}

/**
 * Counts the code a normal native workbench fetches before it is interactive:
 * the renderer entry, the immediately mounted App boundary, and every static
 * import reachable from either. User-opened dialogs, preview fixtures, and
 * transcript markdown remain outside this startup closure.
 */
export function rendererStartupClosure(
  bundle: OutputBundleLike,
  budgetBytes = RENDERER_STARTUP_GZIP_BUDGET_BYTES,
): RendererStartupClosure {
  const chunks = Object.values(bundle).filter((item): item is OutputChunkLike => item.type === 'chunk')
  const entry = chunks.find((chunk) => chunk.isEntry && sourceEndsWith(chunk, '/src/renderer/index.html'))
  const app = chunks.find((chunk) => sourceEndsWith(chunk, '/src/renderer/src/App.tsx'))
  if (!entry || !app) {
    throw new Error(
      'Renderer startup budget could not identify the native entry and App chunks. ' +
      chunks.map((chunk) => `${chunk.fileName}:${chunk.facadeModuleId ?? 'none'}`).join(', '),
    )
  }

  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const pending = [entry.fileName, app.fileName]
  const included = new Set<string>()
  while (pending.length > 0) {
    const fileName = pending.pop()
    if (!fileName || included.has(fileName)) continue
    const chunk = byFile.get(fileName)
    if (!chunk) throw new Error(`Renderer startup imports missing chunk ${fileName}.`)
    included.add(fileName)
    pending.push(...chunk.imports)
  }

  return {
    budgetBytes,
    chunks: [...included].sort().map((fileName) => {
      const chunk = byFile.get(fileName)
      if (!chunk) throw new Error(`Renderer startup chunk ${fileName} was not emitted.`)
      return chunk
    }),
    // The document and Vite's shared renderer stylesheet are both fetched
    // before first paint. Count CSS even when some rules belong to a deferred
    // component; CSS code-splitting cannot make those bytes lazy here.
    assets: Object.values(bundle)
      .filter((item): item is OutputAssetLike => item.type === 'asset' && (
        item.fileName.endsWith('.css') || item.fileName === 'index.html'
      ))
      .sort((left, right) => left.fileName.localeCompare(right.fileName)),
  }
}

function assetBytes(asset: OutputAssetLike): Buffer {
  return typeof asset.source === 'string' ? Buffer.from(asset.source) : Buffer.from(asset.source)
}

export function rendererStartupBudgetReport(
  bundle: OutputBundleLike,
  budgetBytes = RENDERER_STARTUP_GZIP_BUDGET_BYTES,
): RendererStartupBudgetReport {
  const closure = rendererStartupClosure(bundle, budgetBytes)
  const measured = closure.chunks.map((chunk) => ({
    fileName: chunk.fileName,
    rawBytes: Buffer.byteLength(chunk.code),
    gzipBytes: gzipSync(chunk.code).byteLength,
  }))
  const measuredAssets = closure.assets.map((asset) => {
    const bytes = assetBytes(asset)
    return {
      fileName: asset.fileName,
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes).byteLength,
    }
  })
  return {
    budgetBytes: closure.budgetBytes,
    gzipBytes: [...measured, ...measuredAssets].reduce((total, output) => total + output.gzipBytes, 0),
    rawBytes: [...measured, ...measuredAssets].reduce((total, output) => total + output.rawBytes, 0),
    chunks: measured,
    assets: measuredAssets,
  }
}

export function rendererStartupBudgetPlugin(): Plugin {
  return {
    name: 'prime-continuim-renderer-startup-budget',
    apply: 'build',
    async writeBundle(options, bundle) {
      if (!options.dir) throw new Error('Renderer startup budget requires a directory output.')
      const closure = rendererStartupClosure(bundle as unknown as OutputBundleLike)
      const measured = await Promise.all(closure.chunks.map(async (chunk) => {
        const bytes = await readFile(join(options.dir as string, chunk.fileName))
        return {
          fileName: chunk.fileName,
          rawBytes: bytes.byteLength,
          gzipBytes: gzipSync(bytes).byteLength,
        }
      }))
      const measuredAssets = await Promise.all(closure.assets.map(async (asset) => {
        const bytes = await readFile(join(options.dir as string, asset.fileName))
        return {
          fileName: asset.fileName,
          rawBytes: bytes.byteLength,
          gzipBytes: gzipSync(bytes).byteLength,
        }
      }))
      const report: RendererStartupBudgetReport = {
        budgetBytes: closure.budgetBytes,
        gzipBytes: [...measured, ...measuredAssets].reduce((total, output) => total + output.gzipBytes, 0),
        rawBytes: [...measured, ...measuredAssets].reduce((total, output) => total + output.rawBytes, 0),
        chunks: measured,
        assets: measuredAssets,
      }
      if (report.gzipBytes > report.budgetBytes) {
        throw new Error(
          `Native renderer startup is ${report.gzipBytes} gzip bytes; budget is ${report.budgetBytes}. ` +
          `Measured outputs: ${[...report.chunks, ...report.assets]
            .map((output) => `${output.fileName}=${output.gzipBytes}`).join(', ')}.`,
        )
      }
      await writeFile(
        join(options.dir, 'renderer-startup-budget.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        { encoding: 'utf8', flag: 'w' },
      )
    },
  }
}
