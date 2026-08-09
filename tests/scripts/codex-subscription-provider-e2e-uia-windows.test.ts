import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('authenticated Codex provider Windows UI Automation compiler', () => {
  it.runIf(process.platform === 'win32')('compiles the exact bounded UI Automation close helper without invoking it', async () => {
    const source = await readFile(resolve('scripts/verify-codex-subscription-provider-e2e.mjs'), 'utf8')
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
    const requestedTemporaryDirectory = await mkdtemp(join(tmpdir(), 'prime-continuim-uia-compile-'))
    const temporaryDirectory = await realpath(requestedTemporaryDirectory)
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
      await rm(temporaryDirectory, { recursive: true, maxRetries: 5, retryDelay: 200 })
    }
  }, 120_000)
})
