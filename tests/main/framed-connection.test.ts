import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { encodeJsonFrame, LengthPrefixedJsonDecoder } from '../../src/shared/frame-codec'
import { FramedConnection } from '../../src/main/control/framed-connection'
import { SNAPSHOT_TRANSFER_CHUNK_BYTES } from '../../src/shared/protocol'

describe('FramedConnection', () => {
  it('decodes multiple complete protocol frames delivered in one transport chunk', () => {
    const readable = new PassThrough()
    const writable = new PassThrough()
    const connection = new FramedConnection({
      readable,
      writable,
      close: () => {
        readable.destroy()
        writable.destroy()
      },
      label: 'test'
    })
    const events: unknown[] = []
    connection.on('event', (event) => events.push(event))

    readable.write(
      Buffer.concat([
        encodeJsonFrame({ protocolVersion: 1, event: 'attention.created', payload: { id: 1 } }),
        encodeJsonFrame({ protocolVersion: 1, event: 'attention.created', payload: { id: 2 } })
      ])
    )

    expect(events).toEqual([
      { type: 'attention.created', payload: { id: 1 } },
      { type: 'attention.created', payload: { id: 2 } }
    ])
    connection.close()
  })

  it('closes on an unsupported event rather than forwarding arbitrary IPC data', () => {
    const readable = new PassThrough()
    const writable = new PassThrough()
    const close = vi.fn(() => {
      readable.destroy()
      writable.destroy()
    })
    const connection = new FramedConnection({ readable, writable, close, label: 'test' })
    const forwarded = vi.fn()
    connection.on('event', forwarded)

    readable.write(encodeJsonFrame({ protocolVersion: 1, event: 'renderer.eval', payload: 'no' }))

    expect(connection.isClosed).toBe(true)
    expect(forwarded).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('fails closed without publishing a snapshot when its transfer checksum is wrong', async () => {
    const readable = new PassThrough()
    const writable = new PassThrough()
    const close = vi.fn(() => {
      readable.destroy()
      writable.destroy()
    })
    const connection = new FramedConnection({ readable, writable, close, label: 'checksum-test' })
    const requestDecoder = new LengthPrefixedJsonDecoder<Record<string, unknown>>()
    let requestId = ''
    writable.on('data', (chunk: Buffer) => {
      for (const frame of requestDecoder.push(chunk)) {
        if (typeof frame.requestId === 'string') requestId = frame.requestId
        expect(frame.payload).toMatchObject({ snapshotTransfer: { version: 1 } })
      }
    })

    const pending = connection.request('catalog.snapshot', {})
    expect(requestId).not.toBe('')
    const declared = Buffer.from(JSON.stringify(catalogSnapshot('Trusted host')), 'utf8')
    const corrupted = Buffer.from(JSON.stringify(catalogSnapshot('Changed host')), 'utf8')
    expect(corrupted.byteLength).toBe(declared.byteLength)
    const sha256 = createHash('sha256').update(declared).digest('hex')
    const transferId = 'checksum-transfer'
    readable.write(encodeJsonFrame(snapshotEnvelope(requestId, {
      kind: 'snapshot.begin',
      transferId,
      snapshotKind: 'catalog',
      chunkCount: 1,
      totalBytes: corrupted.byteLength,
      sha256
    })))
    readable.write(encodeJsonFrame(snapshotEnvelope(requestId, {
      kind: 'snapshot.chunk',
      transferId,
      index: 0,
      dataBase64: corrupted.toString('base64')
    })))
    readable.write(encodeJsonFrame(snapshotEnvelope(requestId, {
      kind: 'snapshot.end',
      transferId,
      sha256
    })))

    await expect(pending).rejects.toMatchObject({ code: 'protocol.snapshot_transfer_checksum' })
    expect(connection.isClosed).toBe(true)
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes on an out-of-order snapshot chunk before retaining its bytes', async () => {
    const readable = new PassThrough()
    const writable = new PassThrough()
    const close = vi.fn(() => {
      readable.destroy()
      writable.destroy()
    })
    const connection = new FramedConnection({ readable, writable, close, label: 'sequence-test' })
    const requestDecoder = new LengthPrefixedJsonDecoder<Record<string, unknown>>()
    let requestId = ''
    writable.on('data', (chunk: Buffer) => {
      for (const frame of requestDecoder.push(chunk)) {
        if (typeof frame.requestId === 'string') requestId = frame.requestId
      }
    })

    const pending = connection.request('catalog.snapshot', {})
    expect(requestId).not.toBe('')
    const totalBytes = SNAPSHOT_TRANSFER_CHUNK_BYTES + 1
    const transferId = 'sequence-transfer'
    readable.write(encodeJsonFrame(snapshotEnvelope(requestId, {
      kind: 'snapshot.begin',
      transferId,
      snapshotKind: 'catalog',
      chunkCount: 2,
      totalBytes,
      sha256: '0'.repeat(64)
    })))
    readable.write(encodeJsonFrame(snapshotEnvelope(requestId, {
      kind: 'snapshot.chunk',
      transferId,
      index: 1,
      dataBase64: Buffer.from('x').toString('base64')
    })))

    await expect(pending).rejects.toMatchObject({ code: 'protocol.snapshot_transfer_sequence' })
    expect(connection.isClosed).toBe(true)
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects a direct snapshot for a different requested thread', async () => {
    const readable = new PassThrough()
    const writable = new PassThrough()
    const connection = new FramedConnection({
      readable,
      writable,
      close: () => {
        readable.destroy()
        writable.destroy()
      },
      label: 'thread-correlation-test'
    })
    const decoder = new LengthPrefixedJsonDecoder<Record<string, unknown>>()
    let requestId = ''
    writable.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (typeof frame.requestId === 'string') requestId = frame.requestId
      }
    })

    const pending = connection.request('thread.snapshot', { threadId: 'thread-a' })
    readable.write(encodeJsonFrame({
      protocolVersion: 1,
      requestId,
      method: 'thread.snapshot',
      ok: true,
      result: threadSnapshot('thread-b')
    }))

    await expect(pending).rejects.toMatchObject({ code: 'protocol.snapshot_thread_mismatch' })
    expect(connection.isClosed).toBe(true)
  })

  it('fails closed when a host starts two retained snapshot transfers', async () => {
    const readable = new PassThrough()
    const writable = new PassThrough()
    const connection = new FramedConnection({
      readable,
      writable,
      close: () => {
        readable.destroy()
        writable.destroy()
      },
      label: 'snapshot-budget-test'
    })
    const decoder = new LengthPrefixedJsonDecoder<Record<string, unknown>>()
    const requestIds: string[] = []
    writable.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (typeof frame.requestId === 'string') requestIds.push(frame.requestId)
      }
    })

    const first = connection.request('catalog.snapshot', {})
    const second = connection.request('catalog.snapshot', {})
    await vi.waitFor(() => expect(requestIds).toHaveLength(2))
    for (const [index, requestId] of requestIds.entries()) {
      readable.write(encodeJsonFrame(snapshotEnvelope(requestId, {
        kind: 'snapshot.begin',
        transferId: `transfer-${index}`,
        snapshotKind: 'catalog',
        chunkCount: 1,
        totalBytes: 1,
        sha256: '0'.repeat(64)
      })))
    }

    await expect(first).rejects.toMatchObject({ code: 'protocol.snapshot_transfer_budget' })
    await expect(second).rejects.toMatchObject({ code: 'protocol.snapshot_transfer_budget' })
    expect(connection.isClosed).toBe(true)
  })
})

function snapshotEnvelope(requestId: string, transfer: Record<string, unknown>): Record<string, unknown> {
  return {
    protocolVersion: 1,
    requestId,
    method: 'catalog.snapshot',
    transfer
  }
}

function catalogSnapshot(displayName: string): Record<string, unknown> {
  return {
    snapshotVersion: 1,
    generatedAt: '2026-08-06T00:00:00.000Z',
    host: {
      hostId: 'host-checksum',
      displayName,
      kind: 'local',
      connectionPaths: [
        { kind: 'local_socket', priority: 0, state: 'available' }
      ],
      reachability: 'online',
      compatibility: 'compatible',
      platform: { os: 'windows', architecture: 'x64' },
      attentionCounts: { total: 0, unread: 0, questions: 0, approvals: 0 }
    },
    projects: [],
    threads: []
  }
}

function threadSnapshot(threadId: string): Record<string, unknown> {
  const cursor = {
    threadId,
    executionGenerationId: 'execution-1',
    generation: 'daemon-1',
    sequence: 1
  }
  return {
    snapshotVersion: 1,
    generatedAt: '2026-08-06T00:00:00.000Z',
    thread: {
      threadId,
      title: 'Thread',
      projectIdentity: 'project-1',
      currentLocation: {
        hostId: 'host-1',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        executionGenerationId: 'execution-1'
      },
      status: 'idle',
      unread: false,
      updatedAt: '2026-08-06T00:00:00.000Z',
      lastKnownCursor: cursor
    },
    transcriptBlockIndex: [],
    materializedRecentBlocks: [],
    queueState: { pendingCommandIds: [], paused: false },
    approvals: [],
    childAgents: [],
    goals: [],
    schedules: [],
    git: { stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 },
    evidence: { testsPassed: 0, testsFailed: 0, artifactCount: 0 },
    pendingAttention: [],
    latestCursor: cursor
  }
}
