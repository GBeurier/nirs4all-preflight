//! Versioned, caller-buffer C ABI; every call contains panics.
use nirs4all_preflight::*;
use std::ffi::{c_char, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};

const MAX_JSON_BYTES: usize = 64 * 1024 * 1024;
#[repr(C)]
#[derive(Default)]
pub struct N4pfBuffer {
    pub data: *mut u8,
    pub len: usize,
}

#[no_mangle]
pub extern "C" fn n4pf_abi_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn n4pf_version() -> *const c_char {
    concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr().cast()
}

/// # Safety
/// `input` must reference `len` readable bytes, and `out` a writable buffer
/// descriptor. The ranges must not overlap. Null input is allowed only for len=0.
/// `methods_library`, if nonnull, must reference a NUL-terminated UTF-8 path.
#[no_mangle]
pub unsafe extern "C" fn n4pf_analyze_json(
    input: *const u8,
    len: usize,
    methods_library: *const c_char,
    out: *mut N4pfBuffer,
) -> i32 {
    unsafe {
        run(input, len, out, |input| {
            let parsed: QualificationInput =
                serde_json::from_slice(input).map_err(|e| e.to_string())?;
            let report = if methods_library.is_null() {
                analyze(&parsed, &UnavailableMethodsProvider)
            } else {
                let path = CStr::from_ptr(methods_library)
                    .to_str()
                    .map_err(|e| e.to_string())?;
                let provider = native::NativeMethodsProvider::load(path).map_err(|e| e.0)?;
                analyze(&parsed, &provider)
            };
            serde_json::to_vec(&report).map_err(|e| e.to_string())
        })
    }
}

/// # Safety
/// Same byte-buffer preconditions as `n4pf_analyze_json`.
#[no_mangle]
pub unsafe extern "C" fn n4pf_validate_json(
    input: *const u8,
    len: usize,
    out: *mut N4pfBuffer,
) -> i32 {
    unsafe {
        run(input, len, out, |input| {
            let parsed: QualificationInput =
                serde_json::from_slice(input).map_err(|e| e.to_string())?;
            serde_json::to_vec(&validate_input(&parsed)).map_err(|e| e.to_string())
        })
    }
}

/// # Safety
/// `input` must contain a serialized QualificationReport. Same byte-buffer
/// preconditions as `n4pf_analyze_json`. Output contains UTF-8 HTML.
#[no_mangle]
pub unsafe extern "C" fn n4pf_report_html_json(
    input: *const u8,
    len: usize,
    out: *mut N4pfBuffer,
) -> i32 {
    unsafe {
        run(input, len, out, |input| {
            let report: QualificationReport =
                serde_json::from_slice(input).map_err(|e| e.to_string())?;
            Ok(report_html(&report).into_bytes())
        })
    }
}
unsafe fn run(
    input: *const u8,
    len: usize,
    out: *mut N4pfBuffer,
    op: impl FnOnce(&[u8]) -> Result<Vec<u8>, String>,
) -> i32 {
    if out.is_null() {
        return 1;
    }
    unsafe {
        *out = N4pfBuffer::default();
    }
    if len > MAX_JSON_BYTES || (input.is_null() && len != 0) {
        return 1;
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        let bytes = if len == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(input, len) }
        };
        op(bytes)
    }));
    let (status, bytes) = match result {
        Ok(Ok(bytes)) => (0, bytes),
        Ok(Err(message)) => (
            1,
            serde_json::to_vec(&serde_json::json!({"error":message})).unwrap_or_default(),
        ),
        Err(_) => (2, b"{\"error\":\"N4PF_INTERNAL_PANIC\"}".to_vec()),
    };
    let mut boxed = bytes.into_boxed_slice();
    unsafe {
        *out = N4pfBuffer {
            data: boxed.as_mut_ptr(),
            len: boxed.len(),
        };
    }
    std::mem::forget(boxed);
    status
}

/// # Safety
/// `buffer` must be a live descriptor returned by this library, unmodified.
/// Free it exactly once; do not share or mutate its allocation. This function
/// clears the descriptor. Null descriptor and an already cleared descriptor are safe.
#[no_mangle]
pub unsafe extern "C" fn n4pf_buffer_free(buffer: *mut N4pfBuffer) {
    if buffer.is_null() {
        return;
    }
    let b = unsafe { &mut *buffer };
    if !b.data.is_null() {
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                b.data, b.len,
            )));
        }
    }
    *b = N4pfBuffer::default();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_input_is_owned_error_and_free_is_idempotent() {
        let input = b"{";
        let mut out = N4pfBuffer::default();
        let status = unsafe { n4pf_validate_json(input.as_ptr(), input.len(), &mut out) };
        assert_eq!(status, 1);
        assert!(!out.data.is_null());
        let bytes = unsafe { std::slice::from_raw_parts(out.data, out.len) };
        assert!(serde_json::from_slice::<serde_json::Value>(bytes)
            .unwrap()
            .get("error")
            .is_some());
        unsafe {
            n4pf_buffer_free(&mut out);
            n4pf_buffer_free(&mut out);
        }
        assert!(out.data.is_null());
        assert_eq!(out.len, 0);
    }
    #[test]
    fn invalid_buffer_preconditions_fail_without_allocation() {
        let mut out = N4pfBuffer::default();
        assert_eq!(
            unsafe { n4pf_validate_json(std::ptr::null(), 1, &mut out) },
            1
        );
        assert!(out.data.is_null());
    }
}
