export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAGIC: 'PCAPM001'
export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_MAGIC: 'PCAPE001'
export const APPCONTAINER_PROBE_PAYLOAD_PROTOCOL_VERSION: 1

export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_MAX_BYTES: number
export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_HEADER_BYTES: 160
export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_OFFSET: 160
export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_TABLE_ENTRY_BYTES: 16
export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_COUNT: 17
export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_BODY_OFFSET: 432

export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_BYTES: 192
export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_HEADER_BYTES: 128
export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_OFFSET: 128
export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_GATE_BYTES: 32
export const APPCONTAINER_PROBE_PAYLOAD_EVIDENCE_DIGEST_OFFSET: 160

export const APPCONTAINER_PROBE_PAYLOAD_RECORD_ENCODINGS: Readonly<{
  binarySid: 1
  emptyUtf16leEnvironment: 2
  utf16leNullTerminated: 3
  uint32LittleEndian: 4
  handleAndRandom: 5
  sockaddrIn: 6
}>

export type AppContainerProbePayloadObservation =
  | 'not_attempted'
  | 'present'
  | 'allowed'
  | 'denied'
  | 'mismatched'
  | 'unknown'

export const APPCONTAINER_PROBE_PAYLOAD_OBSERVATION_CODES: Readonly<{
  not_attempted: 0
  present: 1
  allowed: 2
  denied: 3
  mismatched: 4
  unknown: 5
}>

export type AppContainerProbePayloadResult =
  | 'complete_match'
  | 'complete_nonmatch'
  | 'incomplete_internal'

export const APPCONTAINER_PROBE_PAYLOAD_RESULT_CODES: Readonly<{
  complete_match: 0
  complete_nonmatch: 1
  incomplete_internal: 2
}>

export const APPCONTAINER_PROBE_PAYLOAD_PIPE_PREFIX: string

export const APPCONTAINER_PROBE_PAYLOAD_NETWORK_SENTINELS: readonly Readonly<{
  id: 'loopback_network_sentinel' | 'lan_network_sentinel' | 'internet_network_sentinel'
  address: string
  port: number
}>[]

export type AppContainerProbeGateExpectation = 'present' | 'allowed' | 'denied'

export const APPCONTAINER_PROBE_CHILD_GATE_SPECS: readonly Readonly<{
  id: string
  expected: AppContainerProbeGateExpectation
}>[]

export const APPCONTAINER_PROBE_CHILD_GATE_CONTRACT_SHA256: string

export type AppContainerProbePayloadRecordEncoding = 1 | 2 | 3 | 4 | 5 | 6

export const APPCONTAINER_PROBE_PAYLOAD_MANIFEST_RECORD_SPECS: readonly Readonly<{
  type: number
  name: string
  encoding: AppContainerProbePayloadRecordEncoding
}>[]

export class AppContainerProbePayloadProtocolError extends Error {
  readonly code: string
  constructor(code?: string)
}

export interface AppContainerProbePayloadManifestExpectation {
  readonly correlationId: string
  readonly payloadSha256: string
  readonly payloadBytes: number
}

export interface AppContainerProbeControlledFileSentinelPaths {
  readonly mainWorkspace: string
  readonly userProfile: string
  readonly credentialStore: string
  readonly runtime: string
  readonly out: string
  readonly release: string
  readonly programData: string
  readonly siblingTemp: string
}

export interface AppContainerProbeInheritedHandleSentinel {
  readonly handle: bigint
  readonly random: Uint8Array
}

export interface AppContainerProbePayloadManifestInput
  extends AppContainerProbePayloadManifestExpectation {
  readonly packageSid: string
  readonly profilePath: string
  readonly controlledFileSentinelPaths: AppContainerProbeControlledFileSentinelPaths
  readonly parentProcessId: number
  readonly inheritedHandleSentinel: AppContainerProbeInheritedHandleSentinel
}

export interface AppContainerProbePayloadManifestSummary
  extends AppContainerProbePayloadManifestExpectation {
  readonly schemaVersion: 1
  readonly kind: 'prime_continuim_appcontainer_probe_payload_manifest_v1'
  readonly sha256: string
  readonly bytes: number
  readonly childGateContractSha256: string
  readonly recordCount: 17
}

export function createAppContainerProbePayloadManifest(
  input: AppContainerProbePayloadManifestInput,
): Buffer

export function validateAppContainerProbePayloadManifest(
  input: Uint8Array,
  expected?: AppContainerProbePayloadManifestExpectation,
): Readonly<AppContainerProbePayloadManifestSummary>

export interface AppContainerProbePayloadEvidenceExpectation {
  readonly correlationId: string
  readonly manifestSha256: string
  readonly manifestBytes: number
  readonly payloadSha256: string
  readonly payloadBytes: number
}

export interface AppContainerProbePayloadEvidenceInput
  extends AppContainerProbePayloadEvidenceExpectation {
  readonly result: AppContainerProbePayloadResult
  readonly observations: readonly AppContainerProbePayloadObservation[]
}

export interface AppContainerProbePayloadEvidenceGateSummary {
  readonly id: string
  readonly expected: AppContainerProbeGateExpectation
  readonly observed: AppContainerProbePayloadObservation
}

export interface AppContainerProbePayloadEvidenceSummary
  extends AppContainerProbePayloadEvidenceExpectation {
  readonly schemaVersion: 1
  readonly kind: 'prime_continuim_appcontainer_probe_payload_evidence_v1'
  readonly sha256: string
  readonly bytes: 192
  readonly result: AppContainerProbePayloadResult
  readonly gates: readonly Readonly<AppContainerProbePayloadEvidenceGateSummary>[]
}

export function createAppContainerProbePayloadEvidence(
  input: AppContainerProbePayloadEvidenceInput,
): Buffer

export function validateAppContainerProbePayloadEvidence(
  input: Uint8Array,
  expected: AppContainerProbePayloadEvidenceExpectation,
): Readonly<AppContainerProbePayloadEvidenceSummary>
