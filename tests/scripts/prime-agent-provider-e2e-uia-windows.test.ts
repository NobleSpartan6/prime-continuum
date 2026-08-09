import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { removeIsolatedTemporaryRoot } from '../../scripts/prime-agent-provider-e2e-lib.mjs'

const execFileAsync = promisify(execFile)

describe('Prime Agent provider E2E Windows UI Automation compiler', () => {
  it('pins the bounded exact-process titlebar Close helper in source on every platform', async () => {
    const source = await readFile(resolve('scripts/verify-prime-agent-provider-e2e.mjs'), 'utf8')
    const match = /const UIA_CLOSE_HELPER_SOURCE = String\.raw`(?<source>[\s\S]*?)`;/u.exec(source)
    const helperSource = match?.groups?.source ?? ''
    expect(helperSource).toContain('public static class PrimeContinuimExactClose')
    expect(helperSource).toContain('private const int MaxRootChildren = 64')
    expect(helperSource).toContain('private const int MaxTitleBarNodes = 64')
    expect(helperSource).toContain('private const int MaxTitleBarDepth = 8')
    expect(helperSource).toContain('root.Current.ProcessId != processId')
    expect(helperSource).toContain('current.ControlType == ControlType.TitleBar')
    expect(helperSource).toContain('current.ControlType == ControlType.Button && current.Name == "Close"')
    expect(helperSource).toContain('closeCandidates.Count != 1')
    expect(helperSource).toContain('closeCandidates[0].Invoke()')
    expect(helperSource).not.toMatch(/SendKeys|Kill\(|CloseMainWindow/u)
  })

  // Add-Type cold compilation has caused hosted Windows workers to be killed.
  // Keep that diagnostic local; ordinary source CI statically pins the exact
  // helper above and makes no Windows UIA compile/execution evidence claim.
  it.runIf(process.platform === 'win32' && !process.env.CI && !process.env.GITHUB_ACTIONS)(
    'locally compiles the exact bounded titlebar Close helper without invoking it', async () => {
    const source = await readFile(resolve('scripts/verify-prime-agent-provider-e2e.mjs'), 'utf8')
    const match = /const UIA_CLOSE_HELPER_SOURCE = String\.raw`(?<source>[\s\S]*?)`;/u.exec(source)
    const helperSource = match?.groups?.source
    expect(helperSource).toBeTruthy()
    if (!helperSource) throw new Error('UI Automation helper source was not found')
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
    expect(systemRoot).toBeTruthy()
    const powershell = resolve(systemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const command = [
      '$ErrorActionPreference="Stop"',
      'Add-Type -AssemblyName UIAutomationClient',
      'Add-Type -AssemblyName UIAutomationTypes',
      'Add-Type -AssemblyName WindowsBase',
      '$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PRIME_CONTINUIM_UIA_SOURCE_B64))',
      '$references=@([System.Windows.Automation.AutomationElement].Assembly.Location,[System.Windows.Automation.ControlType].Assembly.Location,[System.Windows.Rect].Assembly.Location,[System.Diagnostics.Process].Assembly.Location,[System.Threading.Tasks.Task].Assembly.Location)|Select-Object -Unique',
      'Add-Type -TypeDefinition $source -ReferencedAssemblies $references',
      'if ($null -eq [PrimeContinuimExactClose]) { exit 2 }',
    ].join('; ')
    const requested = await mkdtemp(join(tmpdir(), 'prime-continuim-uia-compile-'))
    const temporaryDirectory = await realpath(requested)
    try {
      await expect(execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        timeout: 90_000,
        windowsHide: true,
        env: {
          SystemRoot: resolve(systemRoot!),
          WINDIR: resolve(systemRoot!),
          TEMP: temporaryDirectory,
          TMP: temporaryDirectory,
          PRIME_CONTINUIM_UIA_SOURCE_B64: Buffer.from(helperSource, 'utf8').toString('base64'),
        },
      })).resolves.toBeDefined()
    } finally {
      await removeIsolatedTemporaryRoot({
        root: temporaryDirectory,
        expectedPrefix: 'prime-continuim-uia-compile-',
        confirmedCleanShutdown: true,
      })
    }
    }, 120_000,
  )
})
