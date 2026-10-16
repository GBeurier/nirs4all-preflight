//! Retained-test Y stays opaque through the CLI (review P0).
use serde_json::{json, Value};
use std::process::Command;

#[test]
fn cli_report_is_invariant_to_reserved_y_content() {
    let mut base: Value =
        serde_json::from_str(include_str!("../../../examples/metadata_association.json")).unwrap();
    let values = base["targets"][0]["values"].as_array_mut().unwrap();
    let t00 = values.iter_mut().find(|v| v["sample_id"] == "t00").unwrap();
    t00["value"] = json!("__RESERVED__");
    let text = serde_json::to_string(&base).unwrap();
    let dir = std::env::temp_dir().join(format!("n4pf-reserved-y-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut outputs = Vec::new();
    // Textual tokens, including ones a typed parser rejects (1e400).
    for (i, token) in [
        "9.9",
        "1e400",
        r#"{"x":1e400}"#,
        r#""do-not-read""#,
        "[1]",
        "null",
    ]
    .into_iter()
    .enumerate()
    {
        let path = dir.join(format!("input{i}.json"));
        std::fs::write(&path, text.replace(r#""__RESERVED__""#, token)).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_n4pf"))
            .arg("analyze")
            .arg(&path)
            .env_remove("N4M_LIBRARY_PATH")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        outputs.push(output.stdout);
    }
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(outputs.iter().all(|o| *o == outputs[0]));
}
