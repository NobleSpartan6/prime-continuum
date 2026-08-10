#ifndef PRIME_CONTINUIM_APPCONTAINER_PAYLOAD_CONTRACT_H_
#define PRIME_CONTINUIM_APPCONTAINER_PAYLOAD_CONTRACT_H_

#include <stddef.h>
#include <stdint.h>

#define PCAP_PAYLOAD_PROTOCOL_VERSION UINT16_C(2)
#define PCAP_MANIFEST_HEADER_BYTES UINT16_C(160)
#define PCAP_MANIFEST_TABLE_OFFSET UINT32_C(160)
#define PCAP_MANIFEST_TABLE_ENTRY_BYTES UINT32_C(16)
#define PCAP_MANIFEST_RECORD_COUNT UINT32_C(18)
#define PCAP_MANIFEST_BODY_OFFSET UINT32_C(448)
#define PCAP_MANIFEST_MAX_BYTES UINT32_C(32768)
#define PCAP_PAYLOAD_MAX_BYTES UINT64_C(67108864)
#define PCAP_CANONICAL_PATH_MAX_CHARS UINT32_C(4096)

#define PCAP_EVIDENCE_BYTES UINT32_C(192)
#define PCAP_EVIDENCE_HEADER_BYTES UINT16_C(128)
#define PCAP_EVIDENCE_GATE_OFFSET UINT32_C(128)
#define PCAP_EVIDENCE_GATE_BYTES UINT32_C(32)
#define PCAP_EVIDENCE_DIGEST_OFFSET UINT32_C(160)
#define PCAP_CHILD_GATE_COUNT UINT32_C(31)

#define PCAP_MANIFEST_FILENAME L"PrimeContinuim.AppContainerProbe.PCAPM002.bin"
#define PCAP_EVIDENCE_FILENAME_PREFIX L"PrimeContinuim.AppContainerProbe.PCAPE002."
#define PCAP_EVIDENCE_FILENAME_EXTENSION L".bin"
#define PCAP_PIPE_SENTINEL_PREFIX L"\\\\.\\pipe\\LOCAL\\PrimeContinuim.AppContainerProbe.DenialSentinel.v2."

#define PCAP_CORRELATION_ID_BYTES UINT32_C(16)
#define PCAP_HEX_CHARS_PER_BYTE UINT32_C(2)

enum {
    PCAP_EVIDENCE_FILENAME_PREFIX_CHARS =
        sizeof(PCAP_EVIDENCE_FILENAME_PREFIX) / sizeof(wchar_t) - 1U,
    PCAP_EVIDENCE_FILENAME_EXTENSION_CHARS =
        sizeof(PCAP_EVIDENCE_FILENAME_EXTENSION) / sizeof(wchar_t) - 1U,
    PCAP_CORRELATION_HEX_CHARS =
        PCAP_CORRELATION_ID_BYTES * PCAP_HEX_CHARS_PER_BYTE,
    PCAP_EVIDENCE_FILENAME_CHARS =
        PCAP_EVIDENCE_FILENAME_PREFIX_CHARS + PCAP_CORRELATION_HEX_CHARS +
        PCAP_EVIDENCE_FILENAME_EXTENSION_CHARS,
    PCAP_SCRATCH_ROOT_MAX_CHARS =
        PCAP_CANONICAL_PATH_MAX_CHARS - 1U - PCAP_EVIDENCE_FILENAME_CHARS
};

_Static_assert(PCAP_CORRELATION_HEX_CHARS == 32,
               "correlation width drift");
_Static_assert(PCAP_EVIDENCE_FILENAME_EXTENSION_CHARS == 4,
               "evidence extension width drift");
_Static_assert(PCAP_EVIDENCE_FILENAME_CHARS == 78,
               "evidence filename width drift");
_Static_assert(PCAP_SCRATCH_ROOT_MAX_CHARS == 4017,
               "scratch/evidence path boundary drift");

static const uint8_t PCAP_MANIFEST_MAGIC[8] = {
    'P', 'C', 'A', 'P', 'M', '0', '0', '2'
};

static const uint8_t PCAP_EVIDENCE_MAGIC[8] = {
    'P', 'C', 'A', 'P', 'E', '0', '0', '2'
};

static const uint8_t PCAP_CHILD_GATE_CONTRACT_SHA256[32] = {
    0xb5, 0x6f, 0xcf, 0xfe, 0x35, 0xcb, 0x6a, 0x9f,
    0x7a, 0x4f, 0x5c, 0x8f, 0xb6, 0xed, 0xf5, 0x23,
    0xf4, 0xe0, 0x75, 0xf3, 0x83, 0x36, 0x5d, 0xde,
    0x84, 0x60, 0x69, 0x68, 0xa9, 0x8a, 0x76, 0x6f
};

enum pcap_record_encoding {
    PCAP_RECORD_BINARY_SID = 1,
    PCAP_RECORD_EMPTY_UTF16LE_ENVIRONMENT = 2,
    PCAP_RECORD_UTF16LE_NULL_TERMINATED = 3,
    PCAP_RECORD_UINT32_LE = 4,
    PCAP_RECORD_HANDLE_AND_RANDOM = 5,
    PCAP_RECORD_SOCKADDR_IN = 6
};

#define PCAP_MANIFEST_RECORD_TABLE(X) \
    X(1,  PACKAGE_SID,                       PCAP_RECORD_BINARY_SID) \
    X(2,  ENVIRONMENT,                       PCAP_RECORD_EMPTY_UTF16LE_ENVIRONMENT) \
    X(3,  PROFILE_PATH,                      PCAP_RECORD_UTF16LE_NULL_TERMINATED) \
    X(4,  SCRATCH_ROOT_PATH,                 PCAP_RECORD_UTF16LE_NULL_TERMINATED) \
    X(5,  MAIN_WORKSPACE_SENTINEL_PATH,      PCAP_RECORD_UTF16LE_NULL_TERMINATED) \
    X(6,  USER_PROFILE_SENTINEL_PATH,        PCAP_RECORD_UTF16LE_NULL_TERMINATED) \
    X(7,  CREDENTIAL_STORE_SENTINEL_PATH,    PCAP_RECORD_UTF16LE_NULL_TERMINATED) \
    X(8,  RUNTIME_SENTINEL_PATH,             PCAP_RECORD_UTF16LE_NULL_TERMINATED) \
    X(9,  OUT_SENTINEL_PATH,                 PCAP_RECORD_UTF16LE_NULL_TERMINATED) \
    X(10, RELEASE_SENTINEL_PATH,             PCAP_RECORD_UTF16LE_NULL_TERMINATED) \
    X(11, PROGRAMDATA_SENTINEL_PATH,         PCAP_RECORD_UTF16LE_NULL_TERMINATED) \
    X(12, SIBLING_TEMP_SENTINEL_PATH,        PCAP_RECORD_UTF16LE_NULL_TERMINATED) \
    X(13, PARENT_NAMED_PIPE_SENTINEL,        PCAP_RECORD_UTF16LE_NULL_TERMINATED) \
    X(14, PARENT_PROCESS_SENTINEL,           PCAP_RECORD_UINT32_LE) \
    X(15, INHERITED_HANDLE_SENTINEL,         PCAP_RECORD_HANDLE_AND_RANDOM) \
    X(16, LOOPBACK_NETWORK_SENTINEL,         PCAP_RECORD_SOCKADDR_IN) \
    X(17, LAN_NETWORK_SENTINEL,              PCAP_RECORD_SOCKADDR_IN) \
    X(18, INTERNET_NETWORK_SENTINEL,         PCAP_RECORD_SOCKADDR_IN)

enum pcap_record_index {
#define PCAP_DECLARE_RECORD_INDEX(number, name, encoding) PCAP_RECORD_##name##_INDEX = (number) - 1,
    PCAP_MANIFEST_RECORD_TABLE(PCAP_DECLARE_RECORD_INDEX)
#undef PCAP_DECLARE_RECORD_INDEX
};

#define PCAP_COUNT_RECORD(number, name, encoding) + 1
enum { PCAP_MANIFEST_RECORD_TABLE_COUNT = 0 PCAP_MANIFEST_RECORD_TABLE(PCAP_COUNT_RECORD) };
#undef PCAP_COUNT_RECORD

#define PCAP_ASSERT_RECORD_INDEX(number, name, encoding) \
    _Static_assert(PCAP_RECORD_##name##_INDEX == (number) - 1, "manifest record order drift");
PCAP_MANIFEST_RECORD_TABLE(PCAP_ASSERT_RECORD_INDEX)
#undef PCAP_ASSERT_RECORD_INDEX

_Static_assert(PCAP_MANIFEST_RECORD_TABLE_COUNT == PCAP_MANIFEST_RECORD_COUNT,
               "manifest record count drift");

enum pcap_observation {
    PCAP_OBSERVATION_NOT_ATTEMPTED = 0,
    PCAP_OBSERVATION_PRESENT = 1,
    PCAP_OBSERVATION_ALLOWED = 2,
    PCAP_OBSERVATION_DENIED = 3,
    PCAP_OBSERVATION_MISMATCHED = 4,
    PCAP_OBSERVATION_UNKNOWN = 5
};

enum pcap_result {
    PCAP_RESULT_COMPLETE_MATCH = 0,
    PCAP_RESULT_COMPLETE_NONMATCH = 1,
    PCAP_RESULT_INCOMPLETE_INTERNAL = 2
};

/*
 * This order is the frozen 31-gate child contract. The three supervisor-only
 * gates are intentionally absent. Tests compare every id and expectation with
 * scripts/windows-appcontainer-probe-payload-protocol.mjs.
 */
#define PCAP_CHILD_GATE_TABLE(X) \
    X(0,  CHILD_EXACT_APPCONTAINER_SID,        "child_exact_appcontainer_sid",        PCAP_OBSERVATION_PRESENT) \
    X(1,  CHILD_LOW_INTEGRITY,                 "child_low_integrity",                 PCAP_OBSERVATION_PRESENT) \
    X(2,  CHILD_ZERO_CAPABILITY_SIDS,          "child_zero_capability_sids",          PCAP_OBSERVATION_PRESENT) \
    X(3,  CHILD_LPAC_POLICY,                   "child_lpac_policy",                   PCAP_OBSERVATION_PRESENT) \
    X(4,  CHILD_EXACT_ENVIRONMENT_ALLOWLIST,   "child_exact_environment_allowlist",   PCAP_OBSERVATION_PRESENT) \
    X(5,  CHILD_CREDENTIAL_SHAPED_ENVIRONMENT, "child_credential_shaped_environment", PCAP_OBSERVATION_DENIED) \
    X(6,  SEALED_TOOL_TREE_READ_EXECUTE,       "sealed_tool_tree_read_execute",       PCAP_OBSERVATION_ALLOWED) \
    X(7,  SCRATCH_READ_WRITE,                  "scratch_read_write",                  PCAP_OBSERVATION_ALLOWED) \
    X(8,  PROFILE_READ_WRITE,                  "profile_read_write",                  PCAP_OBSERVATION_ALLOWED) \
    X(9,  MAIN_WORKSPACE_SENTINEL_READ,        "main_workspace_sentinel_read",        PCAP_OBSERVATION_DENIED) \
    X(10, MAIN_WORKSPACE_SENTINEL_WRITE,       "main_workspace_sentinel_write",       PCAP_OBSERVATION_DENIED) \
    X(11, USER_PROFILE_SENTINEL_READ,          "user_profile_sentinel_read",          PCAP_OBSERVATION_DENIED) \
    X(12, USER_PROFILE_SENTINEL_WRITE,         "user_profile_sentinel_write",         PCAP_OBSERVATION_DENIED) \
    X(13, CREDENTIAL_STORE_SENTINEL_READ,      "credential_store_sentinel_read",      PCAP_OBSERVATION_DENIED) \
    X(14, CREDENTIAL_STORE_SENTINEL_WRITE,     "credential_store_sentinel_write",     PCAP_OBSERVATION_DENIED) \
    X(15, RUNTIME_SENTINEL_READ,               "runtime_sentinel_read",               PCAP_OBSERVATION_DENIED) \
    X(16, RUNTIME_SENTINEL_WRITE,              "runtime_sentinel_write",              PCAP_OBSERVATION_DENIED) \
    X(17, OUT_SENTINEL_READ,                   "out_sentinel_read",                   PCAP_OBSERVATION_DENIED) \
    X(18, OUT_SENTINEL_WRITE,                  "out_sentinel_write",                  PCAP_OBSERVATION_DENIED) \
    X(19, RELEASE_SENTINEL_READ,               "release_sentinel_read",               PCAP_OBSERVATION_DENIED) \
    X(20, RELEASE_SENTINEL_WRITE,              "release_sentinel_write",              PCAP_OBSERVATION_DENIED) \
    X(21, PROGRAMDATA_SENTINEL_READ,           "programdata_sentinel_read",           PCAP_OBSERVATION_DENIED) \
    X(22, PROGRAMDATA_SENTINEL_WRITE,          "programdata_sentinel_write",          PCAP_OBSERVATION_DENIED) \
    X(23, SIBLING_TEMP_SENTINEL_READ,          "sibling_temp_sentinel_read",          PCAP_OBSERVATION_DENIED) \
    X(24, SIBLING_TEMP_SENTINEL_WRITE,         "sibling_temp_sentinel_write",         PCAP_OBSERVATION_DENIED) \
    X(25, INHERITED_HANDLE_SENTINEL,           "inherited_handle_sentinel",           PCAP_OBSERVATION_DENIED) \
    X(26, PARENT_PROCESS_SENTINEL,             "parent_process_sentinel",             PCAP_OBSERVATION_DENIED) \
    X(27, PARENT_NAMED_PIPE_SENTINEL,          "parent_named_pipe_sentinel",          PCAP_OBSERVATION_DENIED) \
    X(28, LOOPBACK_NETWORK_SENTINEL,           "loopback_network_sentinel",           PCAP_OBSERVATION_DENIED) \
    X(29, LAN_NETWORK_SENTINEL,                "lan_network_sentinel",                PCAP_OBSERVATION_DENIED) \
    X(30, INTERNET_NETWORK_SENTINEL,           "internet_network_sentinel",           PCAP_OBSERVATION_DENIED)

enum pcap_gate_index {
#define PCAP_DECLARE_GATE_INDEX(index, name, id, expected) PCAP_GATE_##name = (index),
    PCAP_CHILD_GATE_TABLE(PCAP_DECLARE_GATE_INDEX)
#undef PCAP_DECLARE_GATE_INDEX
};

#define PCAP_COUNT_GATE(index, name, id, expected) + 1
enum { PCAP_CHILD_GATE_TABLE_COUNT = 0 PCAP_CHILD_GATE_TABLE(PCAP_COUNT_GATE) };
#undef PCAP_COUNT_GATE

#define PCAP_ASSERT_GATE_INDEX(index, name, id, expected) \
    _Static_assert(PCAP_GATE_##name == (index), "child gate order drift");
PCAP_CHILD_GATE_TABLE(PCAP_ASSERT_GATE_INDEX)
#undef PCAP_ASSERT_GATE_INDEX

_Static_assert(PCAP_CHILD_GATE_TABLE_COUNT == PCAP_CHILD_GATE_COUNT,
               "child gate count drift");

static const uint8_t PCAP_EXPECTED_OBSERVATIONS[PCAP_CHILD_GATE_COUNT] = {
#define PCAP_DECLARE_EXPECTED(index, name, id, expected) (uint8_t)(expected),
    PCAP_CHILD_GATE_TABLE(PCAP_DECLARE_EXPECTED)
#undef PCAP_DECLARE_EXPECTED
};

_Static_assert(sizeof(PCAP_EXPECTED_OBSERVATIONS) / sizeof(PCAP_EXPECTED_OBSERVATIONS[0]) ==
                   PCAP_CHILD_GATE_COUNT,
               "child expectation count drift");

#endif /* PRIME_CONTINUIM_APPCONTAINER_PAYLOAD_CONTRACT_H_ */
