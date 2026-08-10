#ifndef PRIME_CONTINUIM_APPCONTAINER_PAYLOAD_CODEC_REFERENCE_H_
#define PRIME_CONTINUIM_APPCONTAINER_PAYLOAD_CODEC_REFERENCE_H_

#include <stddef.h>
#include <stdint.h>

#include "payload_contract.h"

/*
 * C17-only, source-only, in-memory codec reference. This API launches
 * nothing, opens nothing, and performs no sandbox observation. The caller
 * owns every input byte for the entire lifetime of a parsed view.
 */

enum pcap_codec_status {
    PCAP_CODEC_OK = 0,
    PCAP_CODEC_INVALID_ARGUMENT = 1,
    PCAP_CODEC_MANIFEST_INVALID = 2,
    PCAP_CODEC_MANIFEST_CROSS_FEED = 3,
    PCAP_CODEC_OUTPUT_INVALID = 4
};

struct pcap_payload_binding {
    uint8_t correlation_id[16];
    uint8_t payload_sha256[32];
    uint64_t payload_bytes;
};

struct pcap_record_view {
    const uint8_t *data;
    uint32_t bytes;
};

struct pcap_manifest_view {
    const uint8_t *manifest;
    uint32_t manifest_bytes;
    uint8_t manifest_sha256[32];
    struct pcap_payload_binding binding;
    struct pcap_record_view records[PCAP_MANIFEST_RECORD_COUNT];
};

enum pcap_codec_status pcap_codec_parse_manifest(
    const uint8_t *manifest,
    size_t manifest_bytes,
    const struct pcap_payload_binding *expected,
    struct pcap_manifest_view *out_view);

/*
 * Emits exactly PCAP_EVIDENCE_BYTES. Every child observation is
 * PCAP_OBSERVATION_NOT_ATTEMPTED and the result is
 * PCAP_RESULT_INCOMPLETE_INTERNAL. The function revalidates the retained
 * manifest before writing output, then SHA-256 binds bytes [0, 160).
 */
enum pcap_codec_status pcap_codec_emit_incomplete_evidence(
    const struct pcap_manifest_view *view,
    uint8_t *evidence,
    size_t evidence_bytes);

#endif /* PRIME_CONTINUIM_APPCONTAINER_PAYLOAD_CODEC_REFERENCE_H_ */
