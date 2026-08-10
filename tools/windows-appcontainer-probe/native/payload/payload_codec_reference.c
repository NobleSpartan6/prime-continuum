#include "payload_codec_reference.h"

#include <string.h>

struct pcap_sha256_context {
    uint32_t state[8];
    uint64_t total_bytes;
    uint8_t block[64];
    size_t block_bytes;
};

struct pcap_utf16_view {
    const uint8_t *data;
    size_t chars;
};

#define PCAP_RECORD_TYPE_ENTRY(number, name, encoding) (uint16_t)(number),
static const uint16_t pcap_record_types[PCAP_MANIFEST_RECORD_COUNT] = {
    PCAP_MANIFEST_RECORD_TABLE(PCAP_RECORD_TYPE_ENTRY)
};
#undef PCAP_RECORD_TYPE_ENTRY

#define PCAP_RECORD_ENCODING_ENTRY(number, name, encoding) (uint16_t)(encoding),
static const uint16_t pcap_record_encodings[PCAP_MANIFEST_RECORD_COUNT] = {
    PCAP_MANIFEST_RECORD_TABLE(PCAP_RECORD_ENCODING_ENTRY)
};
#undef PCAP_RECORD_ENCODING_ENTRY

static const uint8_t pcap_network_sentinels[3][16] = {
    { 2, 0, 0, 9, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0 },
    { 2, 0, 0, 9, 192, 168, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0 },
    { 2, 0, 0, 9, 192, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0 }
};

static const char pcap_pipe_sentinel_prefix[] =
    "\\\\.\\pipe\\LOCAL\\PrimeContinuim.AppContainerProbe.DenialSentinel.v2.";

_Static_assert(sizeof(pcap_record_types) / sizeof(pcap_record_types[0]) ==
                   PCAP_MANIFEST_RECORD_COUNT,
               "record type table drift");
_Static_assert(sizeof(pcap_record_encodings) / sizeof(pcap_record_encodings[0]) ==
                   PCAP_MANIFEST_RECORD_COUNT,
               "record encoding table drift");
_Static_assert(sizeof(pcap_network_sentinels[0]) == 16, "sockaddr size drift");

static uint16_t pcap_read_u16(const uint8_t *bytes)
{
    return (uint16_t)((uint16_t)bytes[0] | ((uint16_t)bytes[1] << 8));
}

static uint32_t pcap_read_u32(const uint8_t *bytes)
{
    return (uint32_t)bytes[0] |
           ((uint32_t)bytes[1] << 8) |
           ((uint32_t)bytes[2] << 16) |
           ((uint32_t)bytes[3] << 24);
}

static uint64_t pcap_read_u64(const uint8_t *bytes)
{
    uint64_t value = 0;
    unsigned int index;

    for (index = 0; index < 8; ++index) {
        value |= (uint64_t)bytes[index] << (index * 8U);
    }
    return value;
}

static void pcap_write_u16(uint8_t *bytes, uint16_t value)
{
    bytes[0] = (uint8_t)value;
    bytes[1] = (uint8_t)(value >> 8);
}

static void pcap_write_u32(uint8_t *bytes, uint32_t value)
{
    bytes[0] = (uint8_t)value;
    bytes[1] = (uint8_t)(value >> 8);
    bytes[2] = (uint8_t)(value >> 16);
    bytes[3] = (uint8_t)(value >> 24);
}

static void pcap_write_u64(uint8_t *bytes, uint64_t value)
{
    unsigned int index;

    for (index = 0; index < 8; ++index) {
        bytes[index] = (uint8_t)(value >> (index * 8U));
    }
}

static int pcap_all_zero(const uint8_t *bytes, size_t count)
{
    size_t index;

    for (index = 0; index < count; ++index) {
        if (bytes[index] != 0) {
            return 0;
        }
    }
    return 1;
}

static uint32_t pcap_rotate_right(uint32_t value, unsigned int bits)
{
    return (value >> bits) | (value << (32U - bits));
}

static void pcap_sha256_transform(struct pcap_sha256_context *context,
                                  const uint8_t block[64])
{
    static const uint32_t constants[64] = {
        UINT32_C(0x428a2f98), UINT32_C(0x71374491), UINT32_C(0xb5c0fbcf), UINT32_C(0xe9b5dba5),
        UINT32_C(0x3956c25b), UINT32_C(0x59f111f1), UINT32_C(0x923f82a4), UINT32_C(0xab1c5ed5),
        UINT32_C(0xd807aa98), UINT32_C(0x12835b01), UINT32_C(0x243185be), UINT32_C(0x550c7dc3),
        UINT32_C(0x72be5d74), UINT32_C(0x80deb1fe), UINT32_C(0x9bdc06a7), UINT32_C(0xc19bf174),
        UINT32_C(0xe49b69c1), UINT32_C(0xefbe4786), UINT32_C(0x0fc19dc6), UINT32_C(0x240ca1cc),
        UINT32_C(0x2de92c6f), UINT32_C(0x4a7484aa), UINT32_C(0x5cb0a9dc), UINT32_C(0x76f988da),
        UINT32_C(0x983e5152), UINT32_C(0xa831c66d), UINT32_C(0xb00327c8), UINT32_C(0xbf597fc7),
        UINT32_C(0xc6e00bf3), UINT32_C(0xd5a79147), UINT32_C(0x06ca6351), UINT32_C(0x14292967),
        UINT32_C(0x27b70a85), UINT32_C(0x2e1b2138), UINT32_C(0x4d2c6dfc), UINT32_C(0x53380d13),
        UINT32_C(0x650a7354), UINT32_C(0x766a0abb), UINT32_C(0x81c2c92e), UINT32_C(0x92722c85),
        UINT32_C(0xa2bfe8a1), UINT32_C(0xa81a664b), UINT32_C(0xc24b8b70), UINT32_C(0xc76c51a3),
        UINT32_C(0xd192e819), UINT32_C(0xd6990624), UINT32_C(0xf40e3585), UINT32_C(0x106aa070),
        UINT32_C(0x19a4c116), UINT32_C(0x1e376c08), UINT32_C(0x2748774c), UINT32_C(0x34b0bcb5),
        UINT32_C(0x391c0cb3), UINT32_C(0x4ed8aa4a), UINT32_C(0x5b9cca4f), UINT32_C(0x682e6ff3),
        UINT32_C(0x748f82ee), UINT32_C(0x78a5636f), UINT32_C(0x84c87814), UINT32_C(0x8cc70208),
        UINT32_C(0x90befffa), UINT32_C(0xa4506ceb), UINT32_C(0xbef9a3f7), UINT32_C(0xc67178f2)
    };
    uint32_t words[64];
    uint32_t a;
    uint32_t b;
    uint32_t c;
    uint32_t d;
    uint32_t e;
    uint32_t f;
    uint32_t g;
    uint32_t h;
    unsigned int index;

    for (index = 0; index < 16; ++index) {
        size_t offset = (size_t)index * 4U;
        words[index] = ((uint32_t)block[offset] << 24) |
                       ((uint32_t)block[offset + 1U] << 16) |
                       ((uint32_t)block[offset + 2U] << 8) |
                       (uint32_t)block[offset + 3U];
    }
    for (index = 16; index < 64; ++index) {
        uint32_t s0 = pcap_rotate_right(words[index - 15U], 7) ^
                      pcap_rotate_right(words[index - 15U], 18) ^
                      (words[index - 15U] >> 3);
        uint32_t s1 = pcap_rotate_right(words[index - 2U], 17) ^
                      pcap_rotate_right(words[index - 2U], 19) ^
                      (words[index - 2U] >> 10);
        words[index] = words[index - 16U] + s0 + words[index - 7U] + s1;
    }

    a = context->state[0];
    b = context->state[1];
    c = context->state[2];
    d = context->state[3];
    e = context->state[4];
    f = context->state[5];
    g = context->state[6];
    h = context->state[7];

    for (index = 0; index < 64; ++index) {
        uint32_t sum1 = pcap_rotate_right(e, 6) ^ pcap_rotate_right(e, 11) ^
                        pcap_rotate_right(e, 25);
        uint32_t choice = (e & f) ^ ((~e) & g);
        uint32_t temporary1 = h + sum1 + choice + constants[index] + words[index];
        uint32_t sum0 = pcap_rotate_right(a, 2) ^ pcap_rotate_right(a, 13) ^
                        pcap_rotate_right(a, 22);
        uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
        uint32_t temporary2 = sum0 + majority;

        h = g;
        g = f;
        f = e;
        e = d + temporary1;
        d = c;
        c = b;
        b = a;
        a = temporary1 + temporary2;
    }

    context->state[0] += a;
    context->state[1] += b;
    context->state[2] += c;
    context->state[3] += d;
    context->state[4] += e;
    context->state[5] += f;
    context->state[6] += g;
    context->state[7] += h;
}

static void pcap_sha256_init(struct pcap_sha256_context *context)
{
    static const uint32_t initial_state[8] = {
        UINT32_C(0x6a09e667), UINT32_C(0xbb67ae85), UINT32_C(0x3c6ef372), UINT32_C(0xa54ff53a),
        UINT32_C(0x510e527f), UINT32_C(0x9b05688c), UINT32_C(0x1f83d9ab), UINT32_C(0x5be0cd19)
    };

    memcpy(context->state, initial_state, sizeof(initial_state));
    context->total_bytes = 0;
    context->block_bytes = 0;
    memset(context->block, 0, sizeof(context->block));
}

static void pcap_sha256_update(struct pcap_sha256_context *context,
                               const uint8_t *bytes,
                               size_t count)
{
    size_t consumed = 0;

    context->total_bytes += (uint64_t)count;
    while (consumed < count) {
        size_t available = sizeof(context->block) - context->block_bytes;
        size_t remaining = count - consumed;
        size_t take = remaining < available ? remaining : available;

        memcpy(context->block + context->block_bytes, bytes + consumed, take);
        context->block_bytes += take;
        consumed += take;
        if (context->block_bytes == sizeof(context->block)) {
            pcap_sha256_transform(context, context->block);
            context->block_bytes = 0;
        }
    }
}

static void pcap_sha256_final(struct pcap_sha256_context *context, uint8_t digest[32])
{
    uint64_t bit_count = context->total_bytes * UINT64_C(8);
    unsigned int index;

    context->block[context->block_bytes++] = UINT8_C(0x80);
    if (context->block_bytes > 56U) {
        memset(context->block + context->block_bytes, 0,
               sizeof(context->block) - context->block_bytes);
        pcap_sha256_transform(context, context->block);
        context->block_bytes = 0;
    }
    memset(context->block + context->block_bytes, 0, 56U - context->block_bytes);
    for (index = 0; index < 8; ++index) {
        context->block[63U - index] = (uint8_t)(bit_count >> (index * 8U));
    }
    pcap_sha256_transform(context, context->block);

    for (index = 0; index < 8; ++index) {
        uint32_t value = context->state[index];
        digest[index * 4U] = (uint8_t)(value >> 24);
        digest[index * 4U + 1U] = (uint8_t)(value >> 16);
        digest[index * 4U + 2U] = (uint8_t)(value >> 8);
        digest[index * 4U + 3U] = (uint8_t)value;
    }
    memset(context, 0, sizeof(*context));
}

static void pcap_sha256(const uint8_t *bytes, size_t count, uint8_t digest[32])
{
    struct pcap_sha256_context context;

    pcap_sha256_init(&context);
    pcap_sha256_update(&context, bytes, count);
    pcap_sha256_final(&context, digest);
}

static uint16_t pcap_utf16_char(const struct pcap_utf16_view *value, size_t index)
{
    return pcap_read_u16(value->data + index * 2U);
}

static uint16_t pcap_ascii_upper(uint16_t character)
{
    if (character >= (uint16_t)'a' && character <= (uint16_t)'z') {
        return (uint16_t)(character - ((uint16_t)'a' - (uint16_t)'A'));
    }
    return character;
}

static int pcap_segment_basename_equals(const struct pcap_utf16_view *path,
                                        size_t start,
                                        size_t basename_end,
                                        const char *expected,
                                        size_t expected_chars)
{
    size_t index;

    if (basename_end - start != expected_chars) {
        return 0;
    }
    for (index = 0; index < expected_chars; ++index) {
        uint16_t actual = pcap_ascii_upper(pcap_utf16_char(path, start + index));
        if (actual != (uint16_t)(uint8_t)expected[index]) {
            return 0;
        }
    }
    return 1;
}

static int pcap_reserved_segment(const struct pcap_utf16_view *path,
                                 size_t start,
                                 size_t end)
{
    size_t basename_end = start;
    uint16_t suffix;

    while (basename_end < end && pcap_utf16_char(path, basename_end) != (uint16_t)'.') {
        ++basename_end;
    }
    while (basename_end > start &&
           (pcap_utf16_char(path, basename_end - 1U) == (uint16_t)' ' ||
            pcap_utf16_char(path, basename_end - 1U) == (uint16_t)'.')) {
        --basename_end;
    }
    if (pcap_segment_basename_equals(path, start, basename_end, "CON", 3U) ||
        pcap_segment_basename_equals(path, start, basename_end, "PRN", 3U) ||
        pcap_segment_basename_equals(path, start, basename_end, "AUX", 3U) ||
        pcap_segment_basename_equals(path, start, basename_end, "NUL", 3U)) {
        return 1;
    }
    if (basename_end - start != 4U) {
        return 0;
    }
    suffix = pcap_utf16_char(path, start + 3U);
    if (suffix < (uint16_t)'1' || suffix > (uint16_t)'9') {
        return 0;
    }
    return pcap_segment_basename_equals(path, start, start + 3U, "COM", 3U) ||
           pcap_segment_basename_equals(path, start, start + 3U, "LPT", 3U);
}

static int pcap_valid_path_character(uint16_t character)
{
    return (character >= (uint16_t)'A' && character <= (uint16_t)'Z') ||
           (character >= (uint16_t)'a' && character <= (uint16_t)'z') ||
           (character >= (uint16_t)'0' && character <= (uint16_t)'9') ||
           character == (uint16_t)' ' || character == (uint16_t)'_' ||
           character == (uint16_t)'.' || character == (uint16_t)'-';
}

static int pcap_validate_canonical_path(const struct pcap_record_view *record,
                                        struct pcap_utf16_view *out_path)
{
    struct pcap_utf16_view path;
    size_t segment_start;
    size_t index;

    if (record->bytes < 10U || (record->bytes & 1U) != 0U ||
        pcap_read_u16(record->data + record->bytes - 2U) != 0U) {
        return 0;
    }
    path.data = record->data;
    path.chars = (size_t)record->bytes / 2U - 1U;
    if (path.chars < 4U || path.chars > PCAP_CANONICAL_PATH_MAX_CHARS ||
        pcap_utf16_char(&path, 0) < (uint16_t)'A' ||
        pcap_utf16_char(&path, 0) > (uint16_t)'Z' ||
        pcap_utf16_char(&path, 1) != (uint16_t)':' ||
        pcap_utf16_char(&path, 2) != (uint16_t)'\\' ||
        pcap_utf16_char(&path, path.chars - 1U) == (uint16_t)'\\') {
        return 0;
    }

    segment_start = 3U;
    for (index = 3U; index <= path.chars; ++index) {
        uint16_t character = index == path.chars ? (uint16_t)'\\' :
                                                  pcap_utf16_char(&path, index);
        if (character == 0U) {
            return 0;
        }
        if (character == (uint16_t)'\\') {
            size_t segment_bytes = index - segment_start;
            uint16_t last;

            if (segment_bytes == 0U) {
                return 0;
            }
            last = pcap_utf16_char(&path, index - 1U);
            if (last == (uint16_t)' ' || last == (uint16_t)'.' ||
                (segment_bytes == 1U &&
                 pcap_utf16_char(&path, segment_start) == (uint16_t)'.') ||
                (segment_bytes == 2U &&
                 pcap_utf16_char(&path, segment_start) == (uint16_t)'.' &&
                 pcap_utf16_char(&path, segment_start + 1U) == (uint16_t)'.') ||
                pcap_reserved_segment(&path, segment_start, index)) {
                return 0;
            }
            segment_start = index + 1U;
        } else if (!pcap_valid_path_character(character)) {
            return 0;
        }
    }
    *out_path = path;
    return 1;
}

static int pcap_paths_overlap(const struct pcap_utf16_view *left,
                              const struct pcap_utf16_view *right)
{
    size_t common = left->chars < right->chars ? left->chars : right->chars;
    size_t index;

    for (index = 0; index < common; ++index) {
        if (pcap_ascii_upper(pcap_utf16_char(left, index)) !=
            pcap_ascii_upper(pcap_utf16_char(right, index))) {
            return 0;
        }
    }
    if (left->chars == right->chars) {
        return 1;
    }
    if (left->chars < right->chars) {
        return pcap_utf16_char(right, left->chars) == (uint16_t)'\\';
    }
    return pcap_utf16_char(left, right->chars) == (uint16_t)'\\';
}

static int pcap_validate_pipe(const struct pcap_record_view *record,
                              const uint8_t correlation_id[16])
{
    static const char hex[] = "0123456789abcdef";
    size_t prefix_chars = sizeof(pcap_pipe_sentinel_prefix) - 1U;
    size_t expected_chars = prefix_chars + 32U;
    size_t actual_chars;
    size_t index;

    if (record->bytes != (uint32_t)((expected_chars + 1U) * 2U) ||
        pcap_read_u16(record->data + record->bytes - 2U) != 0U) {
        return 0;
    }
    actual_chars = (size_t)record->bytes / 2U - 1U;
    if (actual_chars != expected_chars) {
        return 0;
    }
    for (index = 0; index < prefix_chars; ++index) {
        if (pcap_read_u16(record->data + index * 2U) !=
            (uint16_t)(uint8_t)pcap_pipe_sentinel_prefix[index]) {
            return 0;
        }
    }
    for (index = 0; index < 16U; ++index) {
        uint8_t value = correlation_id[index];
        if (pcap_read_u16(record->data + (prefix_chars + index * 2U) * 2U) !=
                (uint16_t)(uint8_t)hex[value >> 4] ||
            pcap_read_u16(record->data + (prefix_chars + index * 2U + 1U) * 2U) !=
                (uint16_t)(uint8_t)hex[value & UINT8_C(0x0f)]) {
            return 0;
        }
    }
    return 1;
}

static int pcap_validate_package_sid(const struct pcap_record_view *record)
{
    static const uint8_t identifier_authority[6] = { 0, 0, 0, 0, 0, 15 };

    return record->bytes == 40U && record->data[0] == 1U &&
           record->data[1] == 8U &&
           memcmp(record->data + 2U, identifier_authority,
                  sizeof(identifier_authority)) == 0 &&
           pcap_read_u32(record->data + 8U) == 2U;
}

static int pcap_validate_record(unsigned int index,
                                const struct pcap_record_view *record,
                                const uint8_t correlation_id[16],
                                struct pcap_utf16_view paths[10])
{
    if (index == PCAP_RECORD_PACKAGE_SID_INDEX) {
        return pcap_validate_package_sid(record);
    }
    if (index == PCAP_RECORD_ENVIRONMENT_INDEX) {
        return record->bytes == 4U && pcap_all_zero(record->data, 4U);
    }
    if (index >= PCAP_RECORD_PROFILE_PATH_INDEX &&
        index <= PCAP_RECORD_SIBLING_TEMP_SENTINEL_PATH_INDEX) {
        return pcap_validate_canonical_path(
            record, &paths[index - PCAP_RECORD_PROFILE_PATH_INDEX]);
    }
    if (index == PCAP_RECORD_PARENT_NAMED_PIPE_SENTINEL_INDEX) {
        return pcap_validate_pipe(record, correlation_id);
    }
    if (index == PCAP_RECORD_PARENT_PROCESS_SENTINEL_INDEX) {
        return record->bytes == 4U && pcap_read_u32(record->data) != 0U;
    }
    if (index == PCAP_RECORD_INHERITED_HANDLE_SENTINEL_INDEX) {
        uint64_t handle;

        if (record->bytes != 40U) {
            return 0;
        }
        handle = pcap_read_u64(record->data);
        return handle != 0U && handle <= UINT64_C(0x7fffffffffffffff) &&
               !pcap_all_zero(record->data + 8U, 32U);
    }
    if (index >= PCAP_RECORD_LOOPBACK_NETWORK_SENTINEL_INDEX &&
        index <= PCAP_RECORD_INTERNET_NETWORK_SENTINEL_INDEX) {
        unsigned int network_index = index - PCAP_RECORD_LOOPBACK_NETWORK_SENTINEL_INDEX;
        return record->bytes == 16U &&
               memcmp(record->data, pcap_network_sentinels[network_index], 16U) == 0;
    }
    return 0;
}

static int pcap_ranges_overlap(const void *left,
                               size_t left_bytes,
                               const void *right,
                               size_t right_bytes)
{
    uintptr_t left_start = (uintptr_t)left;
    uintptr_t right_start = (uintptr_t)right;

    if (left_bytes == 0U || right_bytes == 0U) {
        return 0;
    }
    if (left_start <= right_start) {
        return right_start - left_start < left_bytes;
    }
    return left_start - right_start < right_bytes;
}

static int pcap_valid_binding(const struct pcap_payload_binding *binding)
{
    return !pcap_all_zero(binding->correlation_id,
                          sizeof(binding->correlation_id)) &&
           !pcap_all_zero(binding->payload_sha256,
                          sizeof(binding->payload_sha256)) &&
           binding->payload_bytes >= 1U &&
           binding->payload_bytes <= PCAP_PAYLOAD_MAX_BYTES;
}

enum pcap_codec_status pcap_codec_parse_manifest(
    const uint8_t *manifest,
    size_t manifest_bytes,
    const struct pcap_payload_binding *expected,
    struct pcap_manifest_view *out_view)
{
    struct pcap_manifest_view parsed;
    struct pcap_utf16_view paths[10];
    uint32_t cursor = PCAP_MANIFEST_BODY_OFFSET;
    unsigned int index;

    if (manifest == NULL || expected == NULL || out_view == NULL ||
        !pcap_valid_binding(expected) ||
        manifest_bytes < PCAP_MANIFEST_BODY_OFFSET ||
        manifest_bytes > PCAP_MANIFEST_MAX_BYTES ||
        pcap_ranges_overlap(manifest, manifest_bytes, out_view, sizeof(*out_view))) {
        return PCAP_CODEC_INVALID_ARGUMENT;
    }
    memset(&parsed, 0, sizeof(parsed));
    memset(paths, 0, sizeof(paths));

    if (memcmp(manifest, PCAP_MANIFEST_MAGIC, sizeof(PCAP_MANIFEST_MAGIC)) != 0 ||
        pcap_read_u16(manifest + 0x08U) != PCAP_PAYLOAD_PROTOCOL_VERSION ||
        pcap_read_u16(manifest + 0x0aU) != PCAP_MANIFEST_HEADER_BYTES ||
        pcap_read_u32(manifest + 0x0cU) != (uint32_t)manifest_bytes ||
        pcap_read_u32(manifest + 0x10U) != 0U ||
        pcap_read_u32(manifest + 0x14U) != PCAP_MANIFEST_RECORD_COUNT ||
        pcap_all_zero(manifest + 0x18U, 16U) ||
        pcap_all_zero(manifest + 0x28U, 32U) ||
        pcap_read_u64(manifest + 0x48U) < 1U ||
        pcap_read_u64(manifest + 0x48U) > PCAP_PAYLOAD_MAX_BYTES ||
        memcmp(manifest + 0x50U, PCAP_CHILD_GATE_CONTRACT_SHA256, 32U) != 0 ||
        pcap_read_u32(manifest + 0x70U) != PCAP_MANIFEST_TABLE_OFFSET ||
        pcap_read_u32(manifest + 0x74U) != PCAP_MANIFEST_TABLE_ENTRY_BYTES ||
        pcap_read_u32(manifest + 0x78U) != PCAP_MANIFEST_BODY_OFFSET ||
        pcap_read_u32(manifest + 0x7cU) !=
            (uint32_t)manifest_bytes - PCAP_MANIFEST_BODY_OFFSET ||
        !pcap_all_zero(manifest + 0x80U,
                       PCAP_MANIFEST_HEADER_BYTES - 0x80U)) {
        return PCAP_CODEC_MANIFEST_INVALID;
    }

    parsed.manifest = manifest;
    parsed.manifest_bytes = (uint32_t)manifest_bytes;
    memcpy(parsed.binding.correlation_id, manifest + 0x18U, 16U);
    memcpy(parsed.binding.payload_sha256, manifest + 0x28U, 32U);
    parsed.binding.payload_bytes = pcap_read_u64(manifest + 0x48U);

    for (index = 0; index < PCAP_MANIFEST_RECORD_COUNT; ++index) {
        uint32_t table_offset = PCAP_MANIFEST_TABLE_OFFSET +
                                index * PCAP_MANIFEST_TABLE_ENTRY_BYTES;
        uint32_t record_offset = pcap_read_u32(manifest + table_offset + 4U);
        uint32_t record_bytes = pcap_read_u32(manifest + table_offset + 8U);
        uint32_t canonical_offset = (cursor + 7U) & ~UINT32_C(7);
        struct pcap_record_view record;

        if (pcap_read_u16(manifest + table_offset) != pcap_record_types[index] ||
            pcap_read_u16(manifest + table_offset + 2U) !=
                pcap_record_encodings[index] ||
            pcap_read_u32(manifest + table_offset + 12U) != 0U ||
            record_offset != canonical_offset || record_bytes < 1U ||
            record_offset > manifest_bytes ||
            record_bytes > manifest_bytes - record_offset ||
            !pcap_all_zero(manifest + cursor,
                           (size_t)record_offset - cursor)) {
            return PCAP_CODEC_MANIFEST_INVALID;
        }
        record.data = manifest + record_offset;
        record.bytes = record_bytes;
        if (!pcap_validate_record(index, &record,
                                  parsed.binding.correlation_id, paths)) {
            return PCAP_CODEC_MANIFEST_INVALID;
        }
        parsed.records[index] = record;
        cursor = record_offset + record_bytes;
    }

    if (cursor != manifest_bytes) {
        return PCAP_CODEC_MANIFEST_INVALID;
    }
    if (paths[PCAP_RECORD_SCRATCH_ROOT_PATH_INDEX -
              PCAP_RECORD_PROFILE_PATH_INDEX].chars >
        PCAP_SCRATCH_ROOT_MAX_CHARS) {
        return PCAP_CODEC_MANIFEST_INVALID;
    }
    for (index = 0; index < 10U; ++index) {
        unsigned int right;
        for (right = index + 1U; right < 10U; ++right) {
            if (pcap_paths_overlap(&paths[index], &paths[right])) {
                return PCAP_CODEC_MANIFEST_INVALID;
            }
        }
    }
    if (memcmp(parsed.binding.correlation_id, expected->correlation_id, 16U) != 0 ||
        memcmp(parsed.binding.payload_sha256, expected->payload_sha256, 32U) != 0 ||
        parsed.binding.payload_bytes != expected->payload_bytes) {
        return PCAP_CODEC_MANIFEST_CROSS_FEED;
    }

    pcap_sha256(manifest, manifest_bytes, parsed.manifest_sha256);
    *out_view = parsed;
    return PCAP_CODEC_OK;
}

enum pcap_codec_status pcap_codec_emit_incomplete_evidence(
    const struct pcap_manifest_view *view,
    uint8_t *evidence,
    size_t evidence_bytes)
{
    struct pcap_manifest_view reparsed;
    enum pcap_codec_status status;

    if (view == NULL || evidence == NULL ||
        evidence_bytes != PCAP_EVIDENCE_BYTES ||
        view->manifest == NULL ||
        view->manifest_bytes < PCAP_MANIFEST_BODY_OFFSET ||
        view->manifest_bytes > PCAP_MANIFEST_MAX_BYTES ||
        pcap_ranges_overlap(view->manifest, view->manifest_bytes,
                            evidence, evidence_bytes)) {
        return PCAP_CODEC_OUTPUT_INVALID;
    }
    status = pcap_codec_parse_manifest(view->manifest, view->manifest_bytes,
                                       &view->binding, &reparsed);
    if (status != PCAP_CODEC_OK ||
        memcmp(reparsed.manifest_sha256, view->manifest_sha256, 32U) != 0) {
        return PCAP_CODEC_MANIFEST_INVALID;
    }

    memset(evidence, 0, evidence_bytes);
    memcpy(evidence, PCAP_EVIDENCE_MAGIC, sizeof(PCAP_EVIDENCE_MAGIC));
    pcap_write_u16(evidence + 0x08U, PCAP_PAYLOAD_PROTOCOL_VERSION);
    pcap_write_u16(evidence + 0x0aU, PCAP_EVIDENCE_HEADER_BYTES);
    pcap_write_u32(evidence + 0x0cU, PCAP_EVIDENCE_BYTES);
    pcap_write_u32(evidence + 0x10U, 0U);
    pcap_write_u32(evidence + 0x14U, PCAP_CHILD_GATE_COUNT);
    memcpy(evidence + 0x18U, reparsed.binding.correlation_id, 16U);
    memcpy(evidence + 0x28U, reparsed.manifest_sha256, 32U);
    memcpy(evidence + 0x48U, reparsed.binding.payload_sha256, 32U);
    pcap_write_u64(evidence + 0x68U, reparsed.binding.payload_bytes);
    pcap_write_u32(evidence + 0x70U, reparsed.manifest_bytes);
    pcap_write_u32(evidence + 0x74U, PCAP_RESULT_INCOMPLETE_INTERNAL);
    pcap_write_u32(evidence + 0x78U, PCAP_EVIDENCE_GATE_OFFSET);
    pcap_write_u32(evidence + 0x7cU, PCAP_EVIDENCE_GATE_BYTES);
    /* memset above is the exact 31x not_attempted vector plus one zero pad. */
    pcap_sha256(evidence, PCAP_EVIDENCE_DIGEST_OFFSET,
                evidence + PCAP_EVIDENCE_DIGEST_OFFSET);
    return PCAP_CODEC_OK;
}
