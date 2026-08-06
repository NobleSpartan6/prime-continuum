import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { createHash, randomUUID } from 'node:crypto'
import {
  CatalogProjectionSnapshotSchema,
  HostIpcResponseSchema,
  HostIpcSnapshotTransferEnvelopeSchema,
  MAX_SNAPSHOT_TRANSFER_BYTES,
  SNAPSHOT_TRANSFER_CHUNK_BYTES,
  SNAPSHOT_TRANSFER_VERSION,
  ThreadProjectionSnapshotSchema,
  type HostIpcSnapshotTransferEnvelope
} from '../../shared/protocol'
import {
  DEFAULT_MAX_FRAME_BYTES,
  encodeJsonFrame,
  LengthPrefixedJsonDecoder
} from '../../shared/frame-codec'
import { ControlError } from './errors'

export const PROTOCOL_VERSION = 1 as const
export const MAX_FRAME_BYTES = DEFAULT_MAX_FRAME_BYTES
const MAX_WRITE_QUEUE_BYTES = 4 * MAX_FRAME_BYTES
const ALLOWED_HOST_EVENTS = new Set([
  'catalog.updated',
  'thread.event',
  'thread.snapshot',
  'snapshot.update',
  'handoff.progress',
  'attention.created'
])

export interface ProtocolRequest {
  protocolVersion: typeof PROTOCOL_VERSION
  requestId: string
  method: string
  payload: unknown
}

export interface ProtocolResponse {
  protocolVersion: typeof PROTOCOL_VERSION
  requestId: string
  method: string
  ok: boolean
  result?: unknown
  error?: { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> }
}

interface PendingRequest {
  method: string
  expectedThreadId?: string
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
  snapshotTransfer?: PendingSnapshotTransfer
}

interface PendingSnapshotTransfer {
  transferId: string
  snapshotKind: 'catalog' | 'thread'
  chunkCount: number
  totalBytes: number
  sha256: string
  nextIndex: number
  receivedBytes: number
  chunks: Buffer[]
}

interface QueuedWrite {
  bytes: Buffer
  reject: (error: unknown) => void
}

export interface FramedConnectionOptions {
  readable: Readable
  writable: Writable
  close: () => void
  label: string
  endError?: () => ControlError
}

/** A bounded, backpressure-aware uint32be + JSON connection. */
export class FramedConnection extends EventEmitter {
  private readonly readable: Readable
  private readonly writable: Writable
  private readonly closeTransport: () => void
  private readonly label: string
  private readonly decoder = new LengthPrefixedJsonDecoder()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly urgentWrites: QueuedWrite[] = []
  private readonly normalWrites: QueuedWrite[] = []
  private queuedBytes = 0
  private writing = false
  private closed = false
  private activeSnapshotTransferRequestId: string | undefined

  constructor(options: FramedConnectionOptions) {
    super()
    this.readable = options.readable
    this.writable = options.writable
    this.closeTransport = options.close
    this.label = options.label
    this.readable.on('data', this.onData)
    this.readable.once('end', () => {
      try {
        this.decoder.finish()
      } catch (cause) {
        this.fail(new ControlError('protocol.truncated_frame', 'The host connection ended during a frame.', { cause }))
        return
      }
      this.fail(options.endError?.() ?? new ControlError('transport.ended', 'The host connection ended.', { retryable: true }))
    })
    this.readable.once('error', (cause) => this.fail(new ControlError('transport.read_failed', 'The host connection failed while reading.', { retryable: true, cause })))
    this.writable.once('error', (cause) => this.fail(new ControlError('transport.write_failed', 'The host connection failed while writing.', { retryable: true, cause })))
  }

  get isClosed(): boolean {
    return this.closed
  }

  async request<T = unknown>(
    method: string,
    payload: unknown,
    options: { timeoutMs?: number; priority?: 'urgent' | 'normal' } = {}
  ): Promise<T> {
    if (this.closed) {
      throw new ControlError('transport.offline', 'There is no active host connection.', { retryable: true })
    }
    const requestId = randomUUID()
    const expectedThreadId =
      method === 'thread.snapshot' && isRecord(payload) && typeof payload.threadId === 'string'
        ? payload.threadId
        : undefined
    const frame: ProtocolRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      method,
      payload: snapshotTransferAwarePayload(method, payload)
    }

    return await new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 30_000
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        if (this.activeSnapshotTransferRequestId === requestId) {
          this.activeSnapshotTransferRequestId = undefined
        }
        reject(
          new ControlError('transport.request_timeout', 'The host did not answer in time.', {
            retryable: true,
            details: { method, timeoutMs }
          })
        )
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(requestId, {
        method,
        ...(expectedThreadId ? { expectedThreadId } : {}),
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })

      try {
        this.enqueue(frame, options.priority === 'urgent', reject)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      }
    })
  }

  close(): void {
    this.fail(new ControlError('transport.closed', 'The host connection was closed.', { retryable: true }))
  }

  terminate(error: ControlError): void {
    this.fail(error)
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    try {
      for (const frame of this.decoder.push(bytes)) this.handleFrame(frame)
    } catch (cause) {
      this.fail(new ControlError('protocol.decode_failed', 'The host sent an invalid protocol frame.', { cause }))
    }
  }

  private handleFrame(frame: unknown): void {
    if (!isRecord(frame) || frame.protocolVersion !== PROTOCOL_VERSION) {
      this.fail(new ControlError('protocol.incompatible', 'The host protocol is not compatible.'))
      return
    }

    if (isRecord(frame) && 'transfer' in frame) {
      const parsed = HostIpcSnapshotTransferEnvelopeSchema.safeParse(frame)
      if (!parsed.success) {
        this.fail(new ControlError('protocol.invalid_snapshot_transfer', 'The host sent an invalid snapshot transfer frame.'))
        return
      }
      try {
        this.handleSnapshotTransfer(parsed.data)
      } catch (cause) {
        this.fail(
          cause instanceof ControlError
            ? cause
            : new ControlError('protocol.invalid_snapshot_transfer', 'The host sent an invalid snapshot transfer.', {
                cause
              })
        )
      }
      return
    }

    if (typeof frame.requestId === 'string' && typeof frame.ok === 'boolean') {
      const parsed = HostIpcResponseSchema.safeParse(frame)
      if (!parsed.success) {
        this.fail(new ControlError('protocol.invalid_response', 'The host sent an invalid response frame.'))
        return
      }
      const response = parsed.data
      const pending = this.pending.get(response.requestId)
      if (!pending) return
      if (pending.snapshotTransfer) {
        this.fail(
          new ControlError(
            'protocol.snapshot_transfer_interrupted',
            'The host replaced an in-progress snapshot transfer with a response.'
          )
        )
        return
      }
      this.pending.delete(response.requestId)
      clearTimeout(pending.timer)
      if (response.method !== pending.method) {
        pending.reject(new ControlError('protocol.response_method_mismatch', 'The host response did not match its request.'))
        this.fail(new ControlError('protocol.response_method_mismatch', 'The host response did not match its request.'))
        return
      }
      if (
        response.ok &&
        pending.expectedThreadId &&
        threadIdFromSnapshot(response.result) !== pending.expectedThreadId
      ) {
        const error = new ControlError(
          'protocol.snapshot_thread_mismatch',
          'The host returned a snapshot for a different thread.'
        )
        pending.reject(error)
        this.fail(error)
        return
      }
      if (response.ok) pending.resolve(response.result)
      else {
        const hostError = response.error
        pending.reject(
          new ControlError(
            `host.${hostError.code.toLowerCase()}`,
            hostError.message,
            {
              retryable: hostError.retryable,
              details: hostError.details ?? { method: pending.method }
            }
          )
        )
      }
      return
    }

    if (typeof frame.event === 'string') {
      if (!ALLOWED_HOST_EVENTS.has(frame.event)) {
        this.fail(new ControlError('protocol.unknown_event', 'The host sent an unsupported event type.'))
        return
      }
      this.emit('event', { type: frame.event, payload: frame.payload })
      return
    }
    this.fail(new ControlError('protocol.invalid_shape', 'The host sent an unknown protocol frame.'))
  }

  private handleSnapshotTransfer(envelope: HostIpcSnapshotTransferEnvelope): void {
    const pending = this.pending.get(envelope.requestId)
    // Match ordinary late responses: a transfer for a request that has already
    // timed out is ignored, but it can never create retained transfer state.
    if (!pending) return
    if (pending.method !== envelope.method) {
      throw new ControlError(
        'protocol.response_method_mismatch',
        'The host snapshot transfer did not match its request.'
      )
    }
    const expectedKind = envelope.method === 'catalog.snapshot' ? 'catalog' : 'thread'
    const frame = envelope.transfer

    if (frame.kind === 'snapshot.begin') {
      if (pending.snapshotTransfer) {
        throw new ControlError('protocol.snapshot_transfer_duplicate', 'The host started the same snapshot transfer twice.')
      }
      if (
        this.activeSnapshotTransferRequestId &&
        this.activeSnapshotTransferRequestId !== envelope.requestId
      ) {
        throw new ControlError(
          'protocol.snapshot_transfer_budget',
          'The host started more than one retained snapshot transfer on this connection.'
        )
      }
      const expectedChunks = Math.ceil(frame.totalBytes / SNAPSHOT_TRANSFER_CHUNK_BYTES)
      if (
        frame.snapshotKind !== expectedKind ||
        frame.totalBytes > MAX_SNAPSHOT_TRANSFER_BYTES ||
        frame.chunkCount !== expectedChunks
      ) {
        throw new ControlError(
          'protocol.snapshot_transfer_bounds',
          'The host declared inconsistent snapshot transfer bounds.'
        )
      }
      pending.snapshotTransfer = {
        transferId: frame.transferId,
        snapshotKind: frame.snapshotKind,
        chunkCount: frame.chunkCount,
        totalBytes: frame.totalBytes,
        sha256: frame.sha256,
        nextIndex: 0,
        receivedBytes: 0,
        chunks: []
      }
      this.activeSnapshotTransferRequestId = envelope.requestId
      return
    }

    const transfer = pending.snapshotTransfer
    if (!transfer || transfer.transferId !== frame.transferId) {
      throw new ControlError(
        'protocol.snapshot_transfer_sequence',
        'The host sent snapshot data without the matching transfer start.'
      )
    }

    if (frame.kind === 'snapshot.chunk') {
      if (frame.index !== transfer.nextIndex || frame.index >= transfer.chunkCount) {
        throw new ControlError(
          'protocol.snapshot_transfer_sequence',
          'The host sent snapshot chunks out of order.'
        )
      }
      const bytes = Buffer.from(frame.dataBase64, 'base64')
      const finalChunk = frame.index === transfer.chunkCount - 1
      const expectedBytes = finalChunk
        ? transfer.totalBytes - SNAPSHOT_TRANSFER_CHUNK_BYTES * (transfer.chunkCount - 1)
        : SNAPSHOT_TRANSFER_CHUNK_BYTES
      if (
        bytes.byteLength !== expectedBytes ||
        bytes.byteLength === 0 ||
        bytes.toString('base64') !== frame.dataBase64 ||
        transfer.receivedBytes + bytes.byteLength > transfer.totalBytes
      ) {
        throw new ControlError(
          'protocol.snapshot_transfer_chunk_invalid',
          'The host sent a malformed snapshot chunk.'
        )
      }
      transfer.chunks.push(bytes)
      transfer.receivedBytes += bytes.byteLength
      transfer.nextIndex += 1
      return
    }

    if (
      frame.sha256 !== transfer.sha256 ||
      transfer.nextIndex !== transfer.chunkCount ||
      transfer.receivedBytes !== transfer.totalBytes
    ) {
      throw new ControlError(
        'protocol.snapshot_transfer_incomplete',
        'The host ended an incomplete snapshot transfer.'
      )
    }
    const digest = createHash('sha256')
    for (const chunk of transfer.chunks) digest.update(chunk)
    if (digest.digest('hex') !== transfer.sha256) {
      throw new ControlError(
        'protocol.snapshot_transfer_checksum',
        'The host snapshot did not match its declared checksum.'
      )
    }

    let text = ''
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      for (const chunk of transfer.chunks) text += decoder.decode(chunk, { stream: true })
      text += decoder.decode()
    } catch (cause) {
      throw new ControlError('protocol.snapshot_transfer_utf8', 'The host snapshot was not valid UTF-8.', { cause })
    }

    let value: unknown
    try {
      value = JSON.parse(text) as unknown
    } catch (cause) {
      throw new ControlError('protocol.snapshot_transfer_json', 'The host snapshot was not valid JSON.', { cause })
    }
    const parsed =
      transfer.snapshotKind === 'catalog'
        ? CatalogProjectionSnapshotSchema.safeParse(value)
        : ThreadProjectionSnapshotSchema.safeParse(value)
    if (!parsed.success) {
      throw new ControlError(
        'protocol.snapshot_transfer_payload',
        'The host snapshot did not match the negotiated projection schema.'
      )
    }
    if (
      pending.expectedThreadId &&
      threadIdFromSnapshot(parsed.data) !== pending.expectedThreadId
    ) {
      throw new ControlError(
        'protocol.snapshot_thread_mismatch',
        'The host returned a snapshot for a different thread.'
      )
    }

    this.pending.delete(envelope.requestId)
    this.activeSnapshotTransferRequestId = undefined
    clearTimeout(pending.timer)
    pending.resolve(parsed.data)
  }

  private enqueue(value: unknown, urgent: boolean, reject: (error: unknown) => void): void {
    let bytes: Buffer
    try {
      bytes = encodeJsonFrame(value, MAX_FRAME_BYTES)
    } catch (cause) {
      throw new ControlError('protocol.not_serializable', 'The request could not be serialized.', { cause })
    }
    if (this.queuedBytes + bytes.length > MAX_WRITE_QUEUE_BYTES) {
      throw new ControlError('transport.backpressure', 'The host connection is not keeping up.', {
        retryable: true,
        details: { maxQueuedBytes: MAX_WRITE_QUEUE_BYTES }
      })
    }
    this.queuedBytes += bytes.length
    ;(urgent ? this.urgentWrites : this.normalWrites).push({ bytes, reject })
    this.flush()
  }

  private flush(): void {
    if (this.writing || this.closed) return
    const next = this.urgentWrites.shift() ?? this.normalWrites.shift()
    if (!next) return
    this.writing = true
    this.writable.write(next.bytes, (error?: Error | null) => {
      this.writing = false
      this.queuedBytes -= next.bytes.length
      if (error) {
        next.reject(error)
        this.fail(new ControlError('transport.write_failed', 'The host connection failed while writing.', { retryable: true, cause: error }))
        return
      }
      this.flush()
    })
  }

  private fail(error: ControlError): void {
    if (this.closed) return
    this.closed = true
    this.readable.off('data', this.onData)
    this.closeTransport()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.activeSnapshotTransferRequestId = undefined
    for (const queued of [...this.urgentWrites, ...this.normalWrites]) queued.reject(error)
    this.urgentWrites.length = 0
    this.normalWrites.length = 0
    this.queuedBytes = 0
    this.emit('close', error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function threadIdFromSnapshot(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.thread)) return undefined
  return typeof value.thread.threadId === 'string' ? value.thread.threadId : undefined
}

function snapshotTransferAwarePayload(method: string, payload: unknown): unknown {
  if ((method !== 'catalog.snapshot' && method !== 'thread.snapshot') || !isRecord(payload)) return payload
  return {
    ...payload,
    snapshotTransfer: { version: SNAPSHOT_TRANSFER_VERSION }
  }
}
