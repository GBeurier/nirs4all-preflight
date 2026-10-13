//! `n4pf-dagml analyze <input.json|-> --methods-library <abs libn4m> [--html out.html]`:
//! the preflight analysis with native Methods diagnostics and the DAG-ML probe.
use nirs4all_preflight::{analyze_with_validation, native::NativeMethodsProvider, report_html};
use nirs4all_preflight_dagml::DagMlValidationProvider;
use std::io::Read;

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("analyze") {
        return Err(
            "usage: n4pf-dagml analyze <input.json|-> --methods-library <path> [--html <path>]"
                .into(),
        );
    }
    let input_path = args.next().ok_or("missing input")?;
    let mut library = std::env::var("N4M_LIBRARY_PATH").ok();
    let mut html = None;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--methods-library" => {
                library = Some(args.next().ok_or("missing Methods library path")?)
            }
            "--html" => html = Some(args.next().ok_or("missing HTML output path")?),
            _ => return Err(format!("unknown option: {flag}")),
        }
    }
    let library =
        library.ok_or("a Methods library is required (--methods-library or N4M_LIBRARY_PATH)")?;
    let mut text = String::new();
    if input_path == "-" {
        std::io::stdin()
            .take(64 * 1024 * 1024 + 1)
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
    } else {
        text = std::fs::read_to_string(&input_path).map_err(|e| e.to_string())?;
    }
    if text.len() > 64 * 1024 * 1024 {
        return Err("JSON_MEMORY_BUDGET_EXCEEDED".into());
    }
    let input = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let methods = NativeMethodsProvider::load(&library).map_err(|e| e.0)?;
    let validation = DagMlValidationProvider::load(&library).map_err(|e| e.0)?;
    let report = analyze_with_validation(&input, &methods, &validation);
    if let Some(path) = html {
        std::fs::write(path, report_html(&report)).map_err(|e| e.to_string())?;
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    if report.status == "failed" {
        Err("ANALYSIS_VALIDATION_FAILED".into())
    } else {
        Ok(())
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("n4pf-dagml: {error}");
        std::process::exit(2);
    }
}
