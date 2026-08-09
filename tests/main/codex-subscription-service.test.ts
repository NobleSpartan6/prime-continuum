import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { App } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { connectLocalHostd } = vi.hoisted(() => ({ connectLocalHostd: vi.fn() }))

vi.mock('../../src/main/control/local-hostd', () => ({
  ensureAndConnectLocalHostd: connectLocalHostd,
  localHostdEndpoint: () => 'test-endpoint',
}))

import { DesktopControlService } from '../../src/main/control/service'

const temporaryDirectories: string[] = []

class TestConnection extends EventEmitter {
  isClosed = false
  readonly requests: Array<{ method: string; payload: unknown }> = []

  async request(method: string, payload: unknown): Promise<unknown> {
    this.requests.push({ method, payload })
    if (method === 'health.get') return health()
    throw new Error(`Retired Codex transport must not receive ${method}`)
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.emit('close')
  }

  terminate(): void {
    this.close()
  }
}

beforeEach(() => connectLocalHostd.mockReset())

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

describe('DesktopControlService retired Codex subscription boundary', () => {
  it('has no legacy public methods or fence store and leaves the old ledger untouched', async () => {
    const { directory, fencePath, fenceBytes } = await legacyFenceFixture()
    const service = new DesktopControlService({ app: testApp(directory) })

    await expect(service.bootstrap()).resolves.toMatchObject({
      connection: { phase: 'offline' },
    })

    const legacyNames = [
      'codexSubscriptionAccountRead',
      'codexSubscriptionLoginStart',
      'codexSubscriptionLoginCancel',
      'codexSubscriptionLogout',
      'codexSubscriptionConversationSnapshot',
      'codexSubscriptionTurnStart',
      'codexSubscriptionTurnInterrupt',
      'codexSubscriptionTurnReconcile',
      'codexSubscriptionLoginFences',
    ]
    for (const name of legacyNames) {
      expect(name in (service as unknown as Record<string, unknown>)).toBe(false)
    }
    expect(await readFile(fencePath, 'utf8')).toBe(fenceBytes)
  })

  it('does not let a stale legacy fence obstruct connect, disconnect, or reconnect', async () => {
    const { directory, fencePath, fenceBytes } = await legacyFenceFixture()
    const first = new TestConnection()
    const second = new TestConnection()
    connectLocalHostd.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const service = new DesktopControlService({ app: testApp(directory) })

    await expect(service.connect({ kind: 'local' })).resolves.toMatchObject({
      phase: 'online',
      hostId: 'host-a',
    })
    await expect(service.disconnect()).resolves.toBeUndefined()
    await expect(service.reconnect()).resolves.toMatchObject({
      phase: 'online',
      hostId: 'host-a',
    })
    await expect(service.disconnect()).resolves.toBeUndefined()

    expect(first.requests.map(({ method }) => method)).toEqual(['health.get'])
    expect(second.requests.map(({ method }) => method)).toEqual(['health.get'])
    expect(await readFile(fencePath, 'utf8')).toBe(fenceBytes)
  })
})

async function legacyFenceFixture(): Promise<{
  directory: string
  fencePath: string
  fenceBytes: string
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'prime-codex-retirement-test-'))
  temporaryDirectories.push(directory)
  const controlDirectory = path.join(directory, 'control')
  await mkdir(controlDirectory, { recursive: true })
  const fencePath = path.join(controlDirectory, 'codex-subscription-login-fences.json')
  const fenceBytes = '{"retired":"leave untouched", this is deliberately malformed}'
  await writeFile(fencePath, fenceBytes, 'utf8')
  return { directory, fencePath, fenceBytes }
}

function health() {
  return {
    protocolVersion: 1,
    hostdVersion: '0.1.0',
    startedAt: '2026-08-09T11:00:00.000Z',
    checkedAt: '2026-08-09T11:00:01.000Z',
    serviceState: 'ready',
    host: { hostId: 'host-a' },
    capabilities: [],
  }
}

function testApp(directory: string): App {
  return { getPath: () => directory, getVersion: () => '0.1.0' } as unknown as App
}
