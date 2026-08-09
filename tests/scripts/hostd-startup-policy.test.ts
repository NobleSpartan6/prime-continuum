import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LOCAL_HOSTD_DESKTOP_START_DEADLINE_MS,
  LOCAL_HOSTD_MINIMUM_ASSURANCE_MARGIN_MS,
  LOCAL_HOSTD_SMOKE_FIRST_HEALTH_DEADLINE_MS
} from '../../src/shared/local-host-startup-policy.mjs'

const runtimeInitializationSmokePath = resolve('scripts/verify-hostd-runtime-initialization.mjs')
const runtimeInitializationSmokeSource = readFileSync(runtimeInitializationSmokePath, 'utf8')

function materializeRuntimeInitializationCapabilitySets(): { base: string[]; warmed: string[] } {
  const declarationStart = runtimeInitializationSmokeSource.indexOf('const BASE_HEALTH_CAPABILITIES')
  const declarationEnd = runtimeInitializationSmokeSource.indexOf('const EXPECTED_MODEL_CATALOG', declarationStart)
  expect(declarationStart).toBeGreaterThanOrEqual(0)
  expect(declarationEnd).toBeGreaterThan(declarationStart)
  const declaration = runtimeInitializationSmokeSource.slice(declarationStart, declarationEnd)
  return new Function(
    `${declaration}; return { base: [...BASE_HEALTH_CAPABILITIES], warmed: [...WARMED_CAPABILITIES] };`,
  )() as { base: string[]; warmed: string[] }
}

describe('bundled hostd startup deadline policy', () => {
  it('keeps the measured smoke deadline safely inside the desktop launch budget', () => {
    const assuranceMargin =
      LOCAL_HOSTD_DESKTOP_START_DEADLINE_MS - LOCAL_HOSTD_SMOKE_FIRST_HEALTH_DEADLINE_MS

    expect(LOCAL_HOSTD_DESKTOP_START_DEADLINE_MS).toBe(8_000)
    expect(LOCAL_HOSTD_SMOKE_FIRST_HEALTH_DEADLINE_MS).toBe(7_000)
    expect(assuranceMargin).toBeGreaterThanOrEqual(LOCAL_HOSTD_MINIMUM_ASSURANCE_MARGIN_MS)
  })

  it('makes the desktop and release smoke consume the same shared policy', () => {
    const desktopSource = readFileSync(resolve('src/main/control/local-hostd.ts'), 'utf8')

    expect(desktopSource).toContain(
      "import { LOCAL_HOSTD_DESKTOP_START_DEADLINE_MS } from '../../shared/local-host-startup-policy.mjs'"
    )
    expect(desktopSource).not.toMatch(/LOCAL_START_TIMEOUT_MS\s*=/)
    expect(runtimeInitializationSmokeSource).toContain(
      'import { LOCAL_HOSTD_SMOKE_FIRST_HEALTH_DEADLINE_MS } from "../src/shared/local-host-startup-policy.mjs";'
    )
    expect(runtimeInitializationSmokeSource).not.toMatch(/FIRST_HEALTH_DEADLINE_MS\s*=/)
  })

  it('keeps custody-backed model discovery in the bounded warmed-capability contract', () => {
    expect(materializeRuntimeInitializationCapabilitySets()).toEqual({
      base: [
        'resident_control_projection_v1',
        'runtime_integrity_v1',
        'snapshot_chunks_v1',
      ],
      warmed: [
        'candidate_evaluation_probe_v1',
        'resident_lifecycle_v1',
        'runtime_model_catalog_v1',
        'runtime_oauth_v1',
      ],
    })

    const assertionStart = runtimeInitializationSmokeSource.indexOf('function assertRuntimeHealth')
    const assertionEnd = runtimeInitializationSmokeSource.indexOf('function hasEveryCapability', assertionStart)
    expect(assertionStart).toBeGreaterThanOrEqual(0)
    expect(assertionEnd).toBeGreaterThan(assertionStart)
    const assertionSource = runtimeInitializationSmokeSource.slice(assertionStart, assertionEnd)
    expect(assertionSource).toContain('...(requireWarmedCapabilities ? WARMED_CAPABILITIES : [])')
    expect(assertionSource).not.toMatch(/\.\.\.BASE_HEALTH_CAPABILITIES,\s*MODEL_CATALOG_CAPABILITY/)
  })
})
