//! Retained-test Y stays opaque through the JSON C ABI (review P0): any JSON
//! in a reserved reference gives the same validation and report.
use nirs4all_preflight_capi::*;
use serde_json::{json, Value};

fn variants() -> Vec<Vec<u8>> {
    let base: Value =
        serde_json::from_str(include_str!("../../../examples/metadata_association.json")).unwrap();
    [
        json!(9.9),
        json!("do-not-read"),
        json!({"nested": [1, 2]}),
        Value::Null,
        json!(true),
    ]
    .into_iter()
    .map(|reserved| {
        let mut input = base.clone();
        let values = input["targets"][0]["values"].as_array_mut().unwrap();
        let t00 = values.iter_mut().find(|v| v["sample_id"] == "t00").unwrap();
        t00["value"] = reserved.clone();
        t00["category"] = reserved;
        serde_json::to_vec(&input).unwrap()
    })
    .collect()
}

fn call(
    f: unsafe extern "C" fn(*const u8, usize, *mut N4pfBuffer) -> i32,
    input: &[u8],
) -> (i32, String) {
    let mut out = N4pfBuffer::default();
    // SAFETY: input is a live slice; out is a writable descriptor.
    let status = unsafe { f(input.as_ptr(), input.len(), &mut out) };
    // SAFETY: the descriptor was filled by the library and is freed once.
    let text = unsafe { String::from_utf8_lossy(std::slice::from_raw_parts(out.data, out.len)) }
        .into_owned();
    unsafe { n4pf_buffer_free(&mut out) };
    (status, text)
}

unsafe extern "C" fn analyze_without_methods(
    input: *const u8,
    len: usize,
    out: *mut N4pfBuffer,
) -> i32 {
    unsafe { n4pf_analyze_json(input, len, std::ptr::null(), out) }
}

#[test]
fn c_abi_report_is_invariant_to_reserved_y_content() {
    let inputs = variants();
    for f in [n4pf_validate_json as _, analyze_without_methods as _] {
        let outputs: Vec<(i32, String)> = inputs.iter().map(|i| call(f, i)).collect();
        assert!(outputs.iter().all(|o| o.0 == 0), "{:?}", outputs[1]);
        assert!(outputs.iter().all(|o| *o == outputs[0]));
    }
    // Development Y keeps its typed check.
    let mut input: Value = serde_json::from_slice(&inputs[0]).unwrap();
    input["targets"][0]["values"][0]["value"] = json!("not a number");
    let (status, text) = call(n4pf_validate_json, &serde_json::to_vec(&input).unwrap());
    assert_eq!(status, 1);
    assert!(text.contains("targets[0].values[0].value"));
}
