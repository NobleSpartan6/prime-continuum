import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { HostService, TRUSTED_USER_SESSION } from '../../src/hostd/service'
import { runFramedSession } from '../../src/hostd/server'
import { HostStore } from '../../src/hostd/store'
import { FramedConnection } from '../../src/main/control/framed-connection'
import { defaultLocalEndpoint } from '../../src/hostd/paths'
import { connectLocalHostd } from '../../src/main/control/local-hostd'
import { LengthPrefixedJsonDecoder, writeJsonFrame } from '../../src/shared/frame-codec'
import type { ThreadProjectionSnapshot } from '../../src/shared/protocol'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('native ↔ hostd framed protocol', () => {
  it('performs health and empty catalog requests over the production framing seam', async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'prime-hostd-integration-'))
    temporaryDirectories.push(dataDirectory)
    const service = new HostService(new HostStore(dataDirectory))
    await service.initialize()

    const clientToHost = new PassThrough()
    const hostToClient = new PassThrough()
    const session = runFramedSession(service, clientToHost, hostToClient, TRUSTED_USER_SESSION)
    const connection = new FramedConnection({
      readable: hostToClient,
      writable: clientToHost,
      close: () => {
        clientToHost.destroy()
        hostToClient.destroy()
      },
      label: 'integration'
    })

    const health = await connection.request<Record<string, unknown>>('health.get', {})
    expect(health).toMatchObject({ protocolVersion: 1, serviceState: 'ready' })

    const catalog = await connection.request<{ projects: unknown[]; threads: unknown[] }>(
      'catalog.snapshot',
      {}
    )
    expect(catalog.projects).toEqual([])
    expect(catalog.threads).toEqual([])

    connection.close()
    await session
    await service.close()
  })

  it('streams and atomically reassembles a checksummed snapshot larger than one protocol frame', async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'prime-hostd-large-snapshot-'))
    temporaryDirectories.push(dataDirectory)
    const store = new HostStore(dataDirectory)
    const service = new HostService(store)
    await service.initialize({ seed: true })
    const catalog = await store.getCatalogSnapshot()
    const thread = catalog.threads[0]
    if (!thread) throw new Error('seed thread missing')
    const original = await store.getThreadSnapshot(thread.threadId)
    const materializedRecentBlocks = Array.from({ length: 5 }, (_, index) => ({
      blockId: `large-block-${index}`,
      kind: 'assistant' as const,
      text: `${index}:${'x'.repeat(220_000)}`,
      createdAt: new Date(Date.now() + index).toISOString(),
      sequence: index + 1
    }))
    const largeSnapshot: ThreadProjectionSnapshot = {
      ...original,
      transcriptBlockIndex: materializedRecentBlocks.map((block) => ({
        blockId: block.blockId,
        kind: block.kind,
        sequence: block.sequence,
        byteLength: Buffer.byteLength(block.text, 'utf8'),
        materialized: true
      })),
      materializedRecentBlocks
    }
    await store.upsertThread(thread, largeSnapshot)

    const clientToHost = new PassThrough()
    const hostToClient = new PassThrough()
    const wireDecoder = new LengthPrefixedJsonDecoder()
    const transferKinds: string[] = []
    hostToClient.on('data', (chunk: Buffer) => {
      for (const frame of wireDecoder.push(chunk)) {
        if (
          typeof frame === 'object' &&
          frame !== null &&
          'transfer' in frame &&
          typeof frame.transfer === 'object' &&
          frame.transfer !== null &&
          'kind' in frame.transfer &&
          typeof frame.transfer.kind === 'string'
        ) {
          transferKinds.push(frame.transfer.kind)
        }
      }
    })
    const session = runFramedSession(service, clientToHost, hostToClient, TRUSTED_USER_SESSION)
    const connection = new FramedConnection({
      readable: hostToClient,
      writable: clientToHost,
      close: () => {
        clientToHost.destroy()
        hostToClient.destroy()
      },
      label: 'large-snapshot-integration'
    })

    try {
      const received = await connection.request<ThreadProjectionSnapshot>('thread.snapshot', {
        threadId: thread.threadId
      })
      expect(received).toEqual(largeSnapshot)
      expect(transferKinds[0]).toBe('snapshot.begin')
      expect(transferKinds.at(-1)).toBe('snapshot.end')
      expect(transferKinds.filter((kind) => kind === 'snapshot.chunk')).toHaveLength(3)
    } finally {
      connection.close()
      await session
      await service.close()
    }
  })

  it('keeps a direct single-frame response for clients that do not opt into snapshot transfers', async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'prime-hostd-direct-snapshot-'))
    temporaryDirectories.push(dataDirectory)
    const service = new HostService(new HostStore(dataDirectory))
    await service.initialize()
    const clientToHost = new PassThrough()
    const hostToClient = new PassThrough()
    const session = runFramedSession(service, clientToHost, hostToClient, TRUSTED_USER_SESSION)
    const decoder = new LengthPrefixedJsonDecoder<Record<string, unknown>>()
    const response = new Promise<Record<string, unknown>>((resolve) => {
      hostToClient.on('data', (chunk: Buffer) => {
        const frames = decoder.push(chunk)
        if (frames[0]) resolve(frames[0])
      })
    })

    try {
      await writeJsonFrame(clientToHost, {
        protocolVersion: 1,
        requestId: 'legacy-catalog-request',
        method: 'catalog.snapshot',
        payload: {}
      })
      await expect(response).resolves.toMatchObject({
        requestId: 'legacy-catalog-request',
        method: 'catalog.snapshot',
        ok: true,
        result: { projects: [], threads: [] }
      })
    } finally {
      clientToHost.destroy()
      hostToClient.destroy()
      await session
      await service.close()
    }
  })

  it('starts the bundled CLI on a real named pipe or Unix socket', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prime-hostd-cli-integration-'))
    temporaryDirectories.push(root)
    const dataDirectory = path.join(root, 'data')
    const bundle = path.join(root, 'hostd.cjs')
    await build({
      entryPoints: [path.resolve('src/hostd/index.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent'
    })
    const endpoint = defaultLocalEndpoint(dataDirectory)
    const child = spawn(
      process.execPath,
      [bundle, 'serve', '--socket', endpoint, '--data-dir', dataDirectory],
      { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let diagnostic = ''
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostic = `${diagnostic}${chunk.toString('utf8')}`.slice(-4_096)
    })

    let connection: FramedConnection | undefined
    try {
      const deadline = Date.now() + 5_000
      while (!connection && Date.now() < deadline) {
        try {
          connection = await connectLocalHostd(endpoint)
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      if (!connection) throw new Error(`Bundled hostd did not listen: ${diagnostic}`)
      await expect(connection.request<Record<string, unknown>>('health.get', {})).resolves.toMatchObject({
        protocolVersion: 1,
        serviceState: 'ready'
      })
    } finally {
      connection?.close()
      child.kill()
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve()
        const timer = setTimeout(resolve, 2_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }, 15_000)
})
