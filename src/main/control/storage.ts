import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { ControlError } from './errors'

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

export interface AtomicJsonStoreOptions<T> {
  /** Disposable caches may recover empty; durable mutation logs must fail closed. */
  malformedJson?: 'fallback' | 'error'
  validateRoot?: (value: unknown) => value is T
}

/** Small crash-safe JSON store for disposable projections and the explicit outbox. */
export class AtomicJsonStore<T> {
  private readonly filePath: string
  private readonly fallback: () => T
  private readonly maxBytes: number
  private readonly options: AtomicJsonStoreOptions<T>
  private tail: Promise<void> = Promise.resolve()

  constructor(
    filePath: string,
    fallback: () => T,
    maxBytes = DEFAULT_MAX_BYTES,
    options: AtomicJsonStoreOptions<T> = {},
  ) {
    this.filePath = filePath
    this.fallback = fallback
    this.maxBytes = maxBytes
    this.options = options
  }

  async read(): Promise<T> {
    try {
      const bytes = await readFile(this.filePath)
      if (bytes.length > this.maxBytes) {
        throw new ControlError('storage.read_limit', 'A native cache file exceeds its safe size limit.', {
          details: { file: path.basename(this.filePath), maxBytes: this.maxBytes }
        })
      }
      const parsed: unknown = JSON.parse(bytes.toString('utf8'))
      if (this.options.validateRoot && !this.options.validateRoot(parsed)) {
        throw new ControlError(
          'storage.invalid_root',
          'A durable native state file has an invalid root shape and was preserved unchanged.',
          { details: { file: path.basename(this.filePath) } },
        )
      }
      return parsed as T
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') return this.fallback()
      if (error instanceof SyntaxError) {
        if (this.options.malformedJson !== 'error') return this.fallback()
        throw new ControlError(
          'storage.malformed_json',
          'A durable native state file contains malformed JSON and was preserved unchanged.',
          { details: { file: path.basename(this.filePath) } },
        )
      }
      throw error
    }
  }

  async write(value: T): Promise<void> {
    const operation = this.tail.then(async () => {
      const bytes = Buffer.from(JSON.stringify(value), 'utf8')
      if (bytes.length > this.maxBytes) {
        throw new ControlError('storage.write_limit', 'The value is too large for the native cache.', {
          details: { file: path.basename(this.filePath), maxBytes: this.maxBytes }
        })
      }
      const directory = path.dirname(this.filePath)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`)
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }

      try {
        await rename(temporaryPath, this.filePath)
      } catch (error) {
        await rm(temporaryPath, { force: true })
        throw error
      }
    })
    this.tail = operation.catch(() => undefined)
    return await operation
  }

  async update(update: (current: T) => T | Promise<T>): Promise<T> {
    let result: T | undefined
    const operation = this.tail.then(async () => {
      result = await update(await this.read())
      await this.writeUnqueued(result)
    })
    this.tail = operation.catch(() => undefined)
    await operation
    return result as T
  }

  private async writeUnqueued(value: T): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(value), 'utf8')
    if (bytes.length > this.maxBytes) {
      throw new ControlError('storage.write_limit', 'The value is too large for the native cache.', {
        details: { file: path.basename(this.filePath), maxBytes: this.maxBytes }
      })
    }
    const directory = path.dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`)
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }
}
export interface LatencyTrace {
  operation: string
  durationMs: number
  outcome: 'ok' | 'error'
  recordedAt: string
}

/** Bounded raw observations suitable for downstream p50/p95 aggregation. */
export class LatencyRecorder {
  private readonly traces: LatencyTrace[] = []

  async measure<T>(operation: string, task: () => Promise<T>): Promise<T> {
    const startedAt = performance.now()
    try {
      const value = await task()
      this.record(operation, performance.now() - startedAt, 'ok')
      return value
    } catch (error) {
      this.record(operation, performance.now() - startedAt, 'error')
      throw error
    }
  }

  snapshot(): LatencyTrace[] {
    return this.traces.map((trace) => ({ ...trace }))
  }

  private record(operation: string, durationMs: number, outcome: LatencyTrace['outcome']): void {
    this.traces.push({
      operation,
      durationMs: Math.round(durationMs * 100) / 100,
      outcome,
      recordedAt: new Date().toISOString()
    })
    if (this.traces.length > 256) this.traces.splice(0, this.traces.length - 256)
  }
}
