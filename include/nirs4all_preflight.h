/* SPDX-License-Identifier: CECILL-2.1 OR AGPL-3.0-or-later */
#ifndef NIRS4ALL_PREFLIGHT_H
#define NIRS4ALL_PREFLIGHT_H
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
#define N4PF_ABI_VERSION 1
/* Buffers own UTF-8 bytes, not necessarily NUL-terminated. Free through this
 * library exactly once. Never edit pointer/length or share the allocation.
 * Inputs are borrowed for the duration of the call only. Callers guarantee
 * readable input ranges, writable out descriptor, and no overlap.
 * JSON is limited to 64 MiB. Status 0 success, 1 invalid input/provider failure,
 * 2 contained panic. On failure an error JSON may be returned in out. */
typedef struct { uint8_t* data; size_t len; } n4pf_buffer_t;
uint32_t n4pf_abi_version(void);
const char* n4pf_version(void);
int32_t n4pf_validate_json(const uint8_t* input,size_t len,n4pf_buffer_t* out);
/* methods_library is optional NUL-terminated UTF-8 path to public libn4m ABI
 * >=2.18. With NULL only diagnostics not requiring Methods are computed. */
int32_t n4pf_analyze_json(const uint8_t* input,size_t len,const char* methods_library,n4pf_buffer_t* out);
int32_t n4pf_report_html_json(const uint8_t* input,size_t len,n4pf_buffer_t* out);
void n4pf_buffer_free(n4pf_buffer_t* buffer);
#ifdef __cplusplus
}
#endif
#endif
