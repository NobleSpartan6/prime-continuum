import type { KeyObject } from 'node:crypto'

export const REMOTE_HOST_KIT_SCHEMA: 'remote-host-kit/v1'
export const REMOTE_HOST_KIT_ENVELOPE_SCHEMA: 'remote-host-kit-signature-envelope/v1'
export const REMOTE_HOST_KIT_SIGNATURE_DOMAIN: 'prime-continuim.remote-host-kit.ed25519/v1'
export const REMOTE_HOST_KIT_MAX_MANIFEST_BYTES: number
export const REMOTE_HOST_KIT_MAX_ENVELOPE_BYTES: number
export const REMOTE_HOST_KIT_TARGET: Readonly<{ platform: 'linux'; arch: 'x64'; libc: 'glibc' }>
export const REMOTE_HOST_KIT_RUNTIME_IDENTITY: Readonly<{
  kind: 'electron-run-as-node'
  electronVersion: '43.3.0'
  nodeVersion: '24.18.1'
  modulesAbi: '148'
  napiVersion: '10'
  platform: 'linux'
  arch: 'x64'
  runAsNode: true
}>
export const REMOTE_HOST_KIT_ARTIFACT_ROLES: readonly ['hostd', 'runtime', 'launcher', 'service']
export const REMOTE_HOST_KIT_CLAIM_KEYS: readonly [
  'installImplemented',
  'liveInstallVerified',
  'remoteExecution',
  'authentication',
  'authorization',
  'upgradeSupported',
  'repairSupported',
  'downgradeSupported',
  'providerBackedEvaluation',
  'autonomousPromotion',
]

export class RemoteHostKitContractError extends Error {
  readonly code: string
  constructor(code?: string, message?: string)
}

export interface RemoteHostKitArtifact {
  readonly role: 'hostd' | 'runtime' | 'launcher' | 'service'
  readonly sha256: string
  readonly bytes: number
}

export interface RemoteHostKitManifest {
  readonly schema: 'remote-host-kit/v1'
  readonly packageId: string
  readonly hostdVersion: string
  readonly protocolVersion: number
  readonly target: Readonly<{ platform: 'linux'; arch: 'x64'; libc: 'glibc' }>
  readonly runtimeIdentity: Readonly<{
    kind: 'electron-run-as-node'
    electronVersion: '43.3.0'
    nodeVersion: '24.18.1'
    modulesAbi: '148'
    napiVersion: '10'
    platform: 'linux'
    arch: 'x64'
    runAsNode: true
  }>
  readonly artifacts: Readonly<{
    hostd: RemoteHostKitArtifact & Readonly<{ role: 'hostd' }>
    runtime: RemoteHostKitArtifact & Readonly<{ role: 'runtime' }>
    launcher: RemoteHostKitArtifact & Readonly<{ role: 'launcher' }>
    service: RemoteHostKitArtifact & Readonly<{ role: 'service' }>
  }>
  readonly installAction: 'fresh_install'
  readonly trustAnchorId: string
  readonly signerKeyId: string
  readonly claims: Readonly<Record<(typeof REMOTE_HOST_KIT_CLAIM_KEYS)[number], false>>
}

export interface RemoteHostKitSignatureEnvelope {
  readonly schema: 'remote-host-kit-signature-envelope/v1'
  readonly trustAnchorId: string
  readonly signerKeyId: string
  readonly manifestSha256: string
  readonly signature: Readonly<{
    algorithm: 'Ed25519'
    encoding: 'base64url'
    value: string
  }>
}

export interface RemoteHostKitIndependentTrust {
  readonly trustAnchorId: string
  readonly signerKeyId: string
  readonly publicKey: KeyObject
}

export type RemoteHostKitArtifactBytes = Readonly<Record<(typeof REMOTE_HOST_KIT_ARTIFACT_ROLES)[number], Uint8Array>>

export function validateRemoteHostKitManifest(input: RemoteHostKitManifest): Readonly<RemoteHostKitManifest>
export function canonicalRemoteHostKitJson(input: unknown): string
export function serializeRemoteHostKitManifest(input: RemoteHostKitManifest): Buffer
export function parseRemoteHostKitManifestBytes(input: Uint8Array): Readonly<RemoteHostKitManifest>
export function createRemoteHostKitSignaturePreimage(input: RemoteHostKitManifest): Buffer
export function createRemoteHostKitTrustAnchorId(publicKey: KeyObject): string
export function createRemoteHostKitSignatureEnvelope(
  input: RemoteHostKitManifest,
  signature: Uint8Array | string,
): Readonly<RemoteHostKitSignatureEnvelope>
export function serializeRemoteHostKitSignatureEnvelope(input: RemoteHostKitSignatureEnvelope): Buffer
export function verifyRemoteHostKitEnvelopeBytes(
  manifestInput: Uint8Array,
  envelopeInput: Uint8Array,
  independentTrust: RemoteHostKitIndependentTrust,
): Readonly<{
  schema: 'remote-host-kit/v1'
  packageId: string
  manifestSha256: string
  envelopeSha256: string
  trustAnchorId: string
  signerKeyId: string
  manifest: RemoteHostKitManifest
  verification: Readonly<{
    canonicalBytes: true
    strictSchema: true
    ed25519SignatureVerified: true
    independentTrustCorrelation: true
    artifactBytesCorrelated: false
  }>
}>
export function verifyRemoteHostKitArtifactBytes(
  input: RemoteHostKitManifest,
  artifactBytes: RemoteHostKitArtifactBytes,
): Readonly<{
  packageId: string
  artifacts: Readonly<Record<(typeof REMOTE_HOST_KIT_ARTIFACT_ROLES)[number], RemoteHostKitArtifact>>
  artifactBytesCorrelated: true
}>
export function verifyRemoteHostKitBytes(
  manifestBytes: Uint8Array,
  envelopeBytes: Uint8Array,
  artifactBytes: RemoteHostKitArtifactBytes,
  independentTrust: RemoteHostKitIndependentTrust,
): Readonly<{
  schema: 'remote-host-kit/v1'
  packageId: string
  manifestSha256: string
  envelopeSha256: string
  trustAnchorId: string
  signerKeyId: string
  manifest: RemoteHostKitManifest
  artifacts: Readonly<Record<(typeof REMOTE_HOST_KIT_ARTIFACT_ROLES)[number], RemoteHostKitArtifact>>
  verification: Readonly<{
    canonicalBytes: true
    strictSchema: true
    ed25519SignatureVerified: true
    independentTrustCorrelation: true
    artifactBytesCorrelated: true
  }>
}>
