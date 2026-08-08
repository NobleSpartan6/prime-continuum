import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readRepositoryFile = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('documented release boundary', () => {
  it('does not present deferred remote capabilities or unverified platforms as shipped', () => {
    const readme = readRepositoryFile('README.md')
    const status = readRepositoryFile('docs/implementation-status.md')

    for (const document of [readme, status]) {
      expect(document).toMatch(/Phase 0\/Phase 1 protocol(?: and desktop-UI|\/UI) foundation/i)
      expect(document).toMatch(/production resident commands?/i)
      expect(document).toMatch(/remote SSH install/i)
      expect(document).toMatch(/cross-host handoff/i)
      expect(document).toMatch(/relay connectivity/i)
      expect(document).toMatch(/mobile control/i)
      expect(document).toMatch(/Windows x64 development artifact/i)
      expect(document).toMatch(/macOS and Linux packag(?:e|ing).*(?:not been verified|require.*verification)/i)
    }

    expect(readme).not.toMatch(/^Cross-platform desktop control plane.*can run locally or over SSH/m)
    expect(status).not.toContain('## Executable now')
  })

  it('documents command-authority limits without turning time or IDs into hidden authority', () => {
    const architecture = readRepositoryFile('docs/architecture.md')
    const status = readRepositoryFile('docs/implementation-status.md')
    const threatModel = readRepositoryFile('docs/relay-threat-model.md')

    expect(architecture).toMatch(/issuedAt.*not trusted causal time/i)
    expect(architecture).toMatch(/device-global.*deviceId, commandId/i)
    expect(status).toMatch(/10,000 entries/i)
    expect(status).toMatch(/durable generation-bound dispatch lease/i)
    expect(status).toMatch(/command and handoff receipts must share one reserved/i)
    expect(threatModel).toMatch(/clocks never grant authority/i)
  })
})
