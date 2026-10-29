use serde_json::Value;
use std::{path::PathBuf, process::Command};

#[test]
fn optional_report_export_preserves_nulls_and_original_evidence() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new(env!("CARGO_BIN_EXE_n4pf"))
        .arg("extract-assessment")
        .arg(root.join("examples/assessment/report-v1.json"))
        .arg(root.join("examples/assessment/context-v1.json"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let exported: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(exported["schema_version"], "1");
    assert!(exported["metrics"][1]["value"].is_null());
    assert_eq!(exported["metrics"][1]["availability"], "unavailable");
    assert_eq!(exported["metrics"][1]["native_status"], "insufficient_data");
    assert_eq!(
        exported["report"]["example_provenance"],
        "hand-authored synthetic migration fixture"
    );
    assert_eq!(exported["metrics"][0]["confidence_status"], "unknown");
}
