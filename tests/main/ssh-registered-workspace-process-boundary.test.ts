import { spawn, type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { HostService } from '../../src/hostd/service'
import { HostStore } from '../../src/hostd/store'
import { connectLocalHostd } from '../../src/main/control/local-hostd'
import { FramedConnection } from '../../src/main/control/framed-connection'
import {
  RESIDENT_LIFECYCLE_CAPABILITY,
  RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY,
  type CatalogProjectionSnapshot,
  type HealthSnapshot,
  type HostIpcRequest,
  type ResidentEndRequest,
  type ResidentLifecycleLookupResult,
  type ResidentRegisteredWorkspaceProvisionRequest,
} from '../../src/shared/protocol'
import { resolveCanonicalLocalHostTarget } from '../../src/shared/local-host-target'
import { canonicalTemporaryDirectory } from '../helpers/canonical-temp'
import { bootstrapTestWorkspace } from '../hostd/test-workspace-fixture'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('registered-workspace lifecycle across the production stdio bridge', () => {
  it('classifies SSH, denies path-bearing provision, and keeps registered lifecycle responses path-free', async () => {
    const root = await canonicalTemporaryDirectory('prime-ssh-registered-process-')
    temporaryDirectories.push(root)
    const target = await resolveCanonicalLocalHostTarget(path.join(root, 'data'), { create: true })
    const store = new HostStore(target.dataDirectory)
    const relayAuthorityService = new HostService(store)
    await relayAuthorityService.initialize()
    const workspace = await bootstrapTestWorkspace(store, {
      operationId: 'ssh-process-reference-bootstrap',
      projectId: 'ssh-process-project',
      workspaceId: 'ssh-process-workspace',
      threadId: 'ssh-process-reference-thread',
      executionGenerationId: 'ssh-process-reference-generation',
    })
    const registeredPayload: ResidentRegisteredWorkspaceProvisionRequest = {
      expectedHostId: workspace.hostId,
      operationId: 'ssh-process-registered-provision',
      projectId: workspace.project.projectId,
      workspaceId: workspace.project.workspaceId,
      referenceThreadId: workspace.thread.threadId,
      referenceExecutionGenerationId: workspace.thread.currentLocation.executionGenerationId,
      threadId: 'ssh-process-new-thread',
      executionGenerationId: 'ssh-process-new-generation',
      threadTitle: 'SSH process resident',
      createdAt: '2026-08-09T12:00:00.000Z',
      sessionName: 'SSH process resident',
    }

    // There is no production relay connector yet, so relay denial is asserted
    // at the real HostService authorization seam rather than represented as a
    // process/network test. It must reject before inspecting a channel lease.
    const relayRequest: Extract<HostIpcRequest, { method: 'resident.provision.registered' }> = {
      protocolVersion: 1,
      requestId: 'ssh-process-relay-denial',
      method: 'resident.provision.registered',
      payload: registeredPayload,
    }
    await expect(relayAuthorityService.handle(relayRequest, {
      transport: 'relay',
      channel: {} as never,
    })).resolves.toMatchObject({
      ok: false,
      method: 'resident.provision.registered',
      error: { code: 'REMOTE_RESIDENT_LIFECYCLE_FORBIDDEN', retryable: false },
    })
    await relayAuthorityService.close()

    const bundle = path.join(root, 'hostd.cjs')
    await build({
      entryPoints: [path.resolve('src/hostd/index.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
    })

    const server = spawn(
      process.execPath,
      [bundle, 'serve', '--socket', target.endpoint, '--data-dir', target.dataDirectory],
      { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let serverDiagnostic = ''
    server.stderr?.on('data', (chunk: Buffer) => {
      serverDiagnostic = `${serverDiagnostic}${chunk.toString('utf8')}`.slice(-4_096)
    })

    let bridge: ReturnType<typeof spawn> | undefined
    let connection: FramedConnection | undefined
    const responseWire: Buffer[] = []
    try {
      await waitForHostd(target.endpoint, () => serverDiagnostic)
      bridge = spawn(
        process.execPath,
        [bundle, 'connect', '--stdio', '--data-dir', target.dataDirectory],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      const { stdin: bridgeStdin, stdout: bridgeStdout, stderr: bridgeStderr } = bridge
      if (!bridgeStdin || !bridgeStdout || !bridgeStderr) {
        throw new Error('Production stdio bridge did not expose its three required pipes')
      }
      let bridgeDiagnostic = ''
      bridgeStderr.on('data', (chunk: Buffer) => {
        bridgeDiagnostic = `${bridgeDiagnostic}${chunk.toString('utf8')}`.slice(-4_096)
      })
      bridgeStdout.on('data', (chunk: Buffer) => {
        if (responseWire.reduce((bytes, part) => bytes + part.length, 0) < 1_000_000) {
          responseWire.push(Buffer.from(chunk))
        }
      })
      connection = new FramedConnection({
        readable: bridgeStdout,
        writable: bridgeStdin,
        close: () => bridgeStdin.end(),
        label: 'production-ssh-stdio-process-boundary',
      })

      const health = await connection.request<HealthSnapshot>('health.get', {})
      expect(health).toMatchObject({
        protocolVersion: 1,
        serviceState: 'ready',
        host: { hostId: workspace.hostId },
      })
      // A source bundle has no attested installed Prime runtime, so it must not
      // advertise either lifecycle capability. The denial below, rather than a
      // manufactured gateway, proves that connect --stdio selected SSH policy.
      expect(health.capabilities).not.toContain(RESIDENT_LIFECYCLE_CAPABILITY)
      expect(health.capabilities).not.toContain(RESIDENT_REGISTERED_WORKSPACE_LIFECYCLE_CAPABILITY)

      await expect(connection.request('resident.provision', {
        expectedHostId: workspace.hostId,
        operationId: 'ssh-process-private-path-provision',
        projectId: workspace.project.projectId,
        workspaceId: workspace.project.workspaceId,
        threadId: 'ssh-process-private-path-thread',
        executionGenerationId: 'ssh-process-private-path-generation',
        workspaceDirectory: workspace.workspaceDirectory,
        projectDisplayName: 'Must remain local',
        threadTitle: 'Must remain local',
        createdAt: '2026-08-09T12:01:00.000Z',
      })).rejects.toMatchObject({
        code: 'host.remote_resident_lifecycle_forbidden',
        retryable: false,
      })

      // Registered provision passes SSH authorization but fails at the honest
      // installed-runtime boundary. This test intentionally makes no provider
      // execution, resident creation, or real-network/sshd claim.
      await expect(
        connection.request('resident.provision.registered', registeredPayload),
      ).rejects.toMatchObject({
        code: 'host.resident_lifecycle_unavailable',
        retryable: true,
      })

      await expect(connection.request<ResidentLifecycleLookupResult>('resident.lifecycle.status', {
        expectedHostId: workspace.hostId,
        operationId: registeredPayload.operationId,
      })).resolves.toEqual({ status: null })

      const endPayload: ResidentEndRequest = {
        expectedHostId: workspace.hostId,
        operationId: 'ssh-process-end',
        projectId: workspace.project.projectId,
        workspaceId: workspace.project.workspaceId,
        threadId: workspace.thread.threadId,
        executionGenerationId: workspace.thread.currentLocation.executionGenerationId,
        expectedSourceCursor: workspace.projection.latestCursor,
      }
      await expect(connection.request('resident.end', endPayload)).rejects.toMatchObject({
        code: 'host.resident_lifecycle_unavailable',
        retryable: true,
      })

      const catalog = await connection.request<CatalogProjectionSnapshot>('catalog.snapshot', {})
      expect(catalog.projects).toHaveLength(1)
      expect(catalog.threads).toHaveLength(1)
      expect(catalog.threads[0]?.threadId).toBe(workspace.thread.threadId)
      expect(JSON.stringify(catalog)).not.toContain(workspace.workspaceDirectory)

      const wireText = Buffer.concat(responseWire).toString('utf8')
      const jsonEscapedWorkspacePath = JSON.stringify(workspace.workspaceDirectory).slice(1, -1)
      expect(wireText).not.toContain(workspace.workspaceDirectory)
      expect(wireText).not.toContain(jsonEscapedWorkspacePath)
      expect(wireText).not.toContain('workspaceDirectory')
      expect(JSON.stringify(registeredPayload)).not.toContain(workspace.workspaceDirectory)

      if (bridge.exitCode !== null && bridge.exitCode !== 0) {
        throw new Error(`Production stdio bridge exited early: ${bridgeDiagnostic}`)
      }
    } finally {
      connection?.close()
      if (bridge) await stopOwnedChild(bridge)
      await stopOwnedChild(server)
    }
  }, 20_000)
})

async function waitForHostd(endpoint: string, diagnostic: () => string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    let connection: FramedConnection | undefined
    try {
      connection = await connectLocalHostd(endpoint)
      await connection.request('health.get', {}, { timeoutMs: 1_000 })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40))
    } finally {
      connection?.close()
    }
  }
  throw new Error(`Bundled hostd did not become ready: ${diagnostic()}`)
}

async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  if (await waitForExit(child, 2_000)) return
  child.kill('SIGKILL')
  if (await waitForExit(child, 2_000)) return
  throw new Error(`Owned test child ${child.pid ?? '(unknown)'} did not terminate`)
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise<boolean>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', finish)
      resolve(false)
    }, timeoutMs)
    child.once('exit', finish)
  })
}
