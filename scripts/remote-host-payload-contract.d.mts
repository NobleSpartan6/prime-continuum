import type { RemoteHostKitArtifact, RemoteHostKitManifest } from './remote-host-kit-lib.mjs'

export const REMOTE_HOST_PAYLOAD_INPUTS_SCHEMA: 'remote-host-payload-inputs/v1'
export const REMOTE_HOST_PAYLOAD_LAYOUT_SCHEMA: 'remote-host-payload-layout/v1'
export const REMOTE_HOST_ELECTRON_PROVENANCE_SCHEMA: 'electron-release-archive-provenance/v1'
export const REMOTE_HOST_PAYLOAD_TREE_DEFINITION: 'sha256-size-mode-path-lf/v1'
export const REMOTE_HOST_PAYLOAD_PACKAGE_ID: 'prime-continuim.remote-host'
export const REMOTE_HOST_PAYLOAD_HOSTD_VERSION: '0.1.0'
export const REMOTE_HOST_PAYLOAD_PROTOCOL_VERSION: 1
export const REMOTE_HOST_PAYLOAD_MAX_INPUT_BYTES: number
export const REMOTE_HOST_PAYLOAD_MAX_LAYOUT_BYTES: number

export const REMOTE_HOST_PAYLOAD_PRIME_AGENT: Readonly<{
  releaseVersion: '0.7.1'
  runtimePolicySchemaVersion: 1
  daemonProtocolVersion: 7
  daemonSchemaRevision: 13
  daemonSchemaId: 'protocol-7-schema-13-816309b1cd50'
  runtimeBuildId: '95afd31-dirty'
  releaseCommit: '95afd319a78ae017a41241d50b013d656a0685ce'
  runtimePolicySha256: '5e08665a0510ee2c785a910a5d665e8391fb9d2e85277f65bac43cdb6748f97c'
  sourcesSha256: '070af8b8f591240b27d33e8f9606ddc11ec6712906cfed2766c89244beebf7ea'
  packageLockSha256: '0cba345a1ebb89c6d5a3c890801200c905abe8c3ba6f5ce1c246d98557a5579a'
}>

export interface RemoteHostElectronProvenance {
  readonly schema: 'electron-release-archive-provenance/v1'
  readonly version: '43.3.0'
  readonly tag: 'v43.3.0'
  readonly releaseUrl: 'https://github.com/electron/electron/releases/tag/v43.3.0'
  readonly target: Readonly<{ platform: 'linux'; arch: 'x64' }>
  readonly archive: Readonly<{
    name: 'electron-v43.3.0-linux-x64.zip'
    url: 'https://github.com/electron/electron/releases/download/v43.3.0/electron-v43.3.0-linux-x64.zip'
    bytes: 125603646
    sha256: 'f4987e9f045e46b117f0805d6ba4dc524e2abb2c2e33660f175bb39564bd3dae'
  }>
  readonly shasums: Readonly<{
    name: 'SHASUMS256.txt'
    url: 'https://github.com/electron/electron/releases/download/v43.3.0/SHASUMS256.txt'
    bytes: 7610
    sha256: '43f854bd8a201a9abdf4bace97681144ec7230893462c6db7681a0f6db8cb7f9'
    archiveLine: 'f4987e9f045e46b117f0805d6ba4dc524e2abb2c2e33660f175bb39564bd3dae *electron-v43.3.0-linux-x64.zip'
  }>
}

export const REMOTE_HOST_ELECTRON_PROVENANCE: Readonly<RemoteHostElectronProvenance>

export type RemoteHostPayloadRole = 'hostd' | 'runtime' | 'launcher' | 'service'
export interface RemoteHostPayloadDestination {
  readonly role: RemoteHostPayloadRole
  readonly path: string
  readonly mode: '0644' | '0755'
}
export const REMOTE_HOST_PAYLOAD_DESTINATIONS: Readonly<{
  hostd: Readonly<{ role: 'hostd'; path: 'hostd/hostd.cjs'; mode: '0644' }>
  runtime: Readonly<{ role: 'runtime'; path: 'runtime/runtime.zip'; mode: '0644' }>
  launcher: Readonly<{ role: 'launcher'; path: 'launcher/prime-continuim-hostd-service'; mode: '0755' }>
  service: Readonly<{ role: 'service'; path: 'service/prime-continuim-hostd.service'; mode: '0644' }>
}>

export const REMOTE_HOST_PAYLOAD_CLAIM_KEYS: readonly [
  'assemblyImplemented',
  'artifactBytesCorrelated',
  'electronArchiveVerified',
  'runtimeSeedVerified',
  'hostdAttestationCorrelated',
  'linuxExecutionVerified',
  'glibcCompatibilityVerified',
  'nativeAddonSmokeVerified',
  'systemdLifecycleVerified',
  'licensesComplete',
  'signingImplemented',
  'installationImplemented',
]

export type RemoteHostPayloadClaims = Readonly<Record<(typeof REMOTE_HOST_PAYLOAD_CLAIM_KEYS)[number], false>>

export interface RemoteHostPayloadInputs {
  readonly schema: 'remote-host-payload-inputs/v1'
  readonly packageId: 'prime-continuim.remote-host'
  readonly hostdVersion: '0.1.0'
  readonly protocolVersion: 1
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
  readonly primeAgent: typeof REMOTE_HOST_PAYLOAD_PRIME_AGENT
  readonly electron: Readonly<RemoteHostElectronProvenance>
  readonly destinations: typeof REMOTE_HOST_PAYLOAD_DESTINATIONS
  readonly claims: RemoteHostPayloadClaims
  readonly assemblyAuthority: null
}

export interface RemoteHostPayloadTree {
  readonly definition: 'sha256-size-mode-path-lf/v1'
  readonly order: 'utf8-bytewise'
  readonly excludes: readonly ['payload-layout.json']
  readonly sha256: string
  readonly fileCount: number
  readonly totalBytes: number
}

export interface RemoteHostPayloadExternalArtifact extends RemoteHostKitArtifact {
  readonly role: 'hostd' | 'launcher' | 'service'
  readonly destination: string
  readonly mode: '0644' | '0755'
}

export interface RemoteHostPayloadLayout {
  readonly schema: 'remote-host-payload-layout/v1'
  readonly packageId: 'prime-continuim.remote-host'
  readonly hostdVersion: '0.1.0'
  readonly protocolVersion: 1
  readonly target: RemoteHostPayloadInputs['target']
  readonly runtimeIdentity: RemoteHostPayloadInputs['runtimeIdentity']
  readonly primeAgent: typeof REMOTE_HOST_PAYLOAD_PRIME_AGENT
  readonly electron: Readonly<RemoteHostElectronProvenance>
  readonly destinations: typeof REMOTE_HOST_PAYLOAD_DESTINATIONS
  readonly payloadTree: Readonly<RemoteHostPayloadTree>
  readonly externalArtifacts: Readonly<{
    hostd: RemoteHostPayloadExternalArtifact & Readonly<{ role: 'hostd' }>
    launcher: RemoteHostPayloadExternalArtifact & Readonly<{ role: 'launcher' }>
    service: RemoteHostPayloadExternalArtifact & Readonly<{ role: 'service' }>
  }>
  readonly claims: RemoteHostPayloadClaims
  readonly assemblyAuthority: null
}

export class RemoteHostPayloadContractError extends Error {
  readonly code: string
  constructor(code?: string, message?: string)
}

export function createRemoteHostPayloadInputs(): Readonly<RemoteHostPayloadInputs>
export function validateRemoteHostPayloadInputs(input: RemoteHostPayloadInputs): Readonly<RemoteHostPayloadInputs>
export function serializeRemoteHostPayloadInputs(input: RemoteHostPayloadInputs): Buffer
export function parseRemoteHostPayloadInputsBytes(input: Uint8Array): Readonly<RemoteHostPayloadInputs>
export function getRemoteHostPayloadTemplateBytes(): Readonly<{ launcher: Buffer; service: Buffer }>
export function createRemoteHostPayloadLayout(input: Readonly<{
  payloadTree: Readonly<{ sha256: string; fileCount: number; totalBytes: number }>
  externalArtifacts: Readonly<{
    hostd: RemoteHostKitArtifact & Readonly<{ role: 'hostd' }>
    launcher: RemoteHostKitArtifact & Readonly<{ role: 'launcher' }>
    service: RemoteHostKitArtifact & Readonly<{ role: 'service' }>
  }>
}>): Readonly<RemoteHostPayloadLayout>
export function validateRemoteHostPayloadLayout(input: RemoteHostPayloadLayout): Readonly<RemoteHostPayloadLayout>
export function serializeRemoteHostPayloadLayout(input: RemoteHostPayloadLayout): Buffer
export function parseRemoteHostPayloadLayoutBytes(input: Uint8Array): Readonly<RemoteHostPayloadLayout>
export function createRemoteHostPayloadKitReference(input: Readonly<{
  inputs: RemoteHostPayloadInputs
  layout: RemoteHostPayloadLayout
  artifacts: Readonly<{
    hostd: RemoteHostKitArtifact & Readonly<{ role: 'hostd' }>
    runtime: RemoteHostKitArtifact & Readonly<{ role: 'runtime' }>
    launcher: RemoteHostKitArtifact & Readonly<{ role: 'launcher' }>
    service: RemoteHostKitArtifact & Readonly<{ role: 'service' }>
  }>
  trustAnchorId: string
  signerKeyId: string
}>): Readonly<{
  manifest: Readonly<RemoteHostKitManifest>
  manifestBytes: Buffer
  manifestSha256: string
  signaturePreimage: Buffer
  artifactBytesCorrelated: false
  assemblyAuthority: null
  signingAuthority: null
}>
