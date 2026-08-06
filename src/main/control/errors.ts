import { randomUUID } from 'node:crypto'
import type { StructuredError } from './contracts'

export class ControlError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'ControlError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details
  }
}

export function toStructuredError(error: unknown): StructuredError {
  if (error instanceof ControlError) {
    return {
      code: error.code,
      message: boundedMessage(error.message),
      retryable: error.retryable,
      receiptId: randomUUID(),
      ...(error.details ? { details: boundedDetails(error.details) } : {})
    }
  }

  const nodeError = error as NodeJS.ErrnoException | undefined
  return {
    code: nodeError?.code ? `native.${nodeError.code.toLowerCase()}` : 'native.unexpected',
    message: boundedMessage(error instanceof Error ? error.message : 'An unexpected native error occurred.'),
    retryable: false,
    receiptId: randomUUID()
  }
}

function boundedMessage(message: string): string {
  return message.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 2_048)
}

function boundedDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).slice(0, 32).map(([key, value]) => [key.slice(0, 64), boundedDetail(value)]))
}

function boundedDetail(value: unknown): unknown {
  if (typeof value === 'string') return boundedMessage(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 32).map(boundedDetail)
  if (typeof value === 'object' && value !== null) return boundedDetails(value as Record<string, unknown>)
  return String(value).slice(0, 2_048)
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code = 'native.timeout',
  message = 'The operation timed out.'
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ControlError(code, message, { retryable: true })), timeoutMs)
    timer.unref?.()
  })

  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
