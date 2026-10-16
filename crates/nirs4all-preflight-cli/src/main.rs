use nirs4all_preflight::{
    analyze, analyze_with_validation, capabilities, capabilities_with_validation,
    dagml::DagMlValidationProvider, report_html, validate_input, QualificationInput,
    UnavailableMethodsProvider,
};
use std::{
    env, fs,
    io::{self, Read},
};

fn main() {
    if let Err(error) = run() {
        eprintln!("n4pf: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let command = args
        .next()
        .ok_or("usage: n4pf <capabilities|validate|analyze> [input.json|-] [--html output.html]")?;
    let provider = UnavailableMethodsProvider;
    let mut native_path = env::var("N4M_LIBRARY_PATH").ok();
    if command == "capabilities" {
        if let Some(flag) = args.next() {
            if flag != "--methods-library" {
                return Err(format!("unknown option: {flag}"));
            }
            native_path = Some(args.next().ok_or("missing Methods library path")?);
            if args.next().is_some() {
                return Err("too many arguments".into());
            }
        }
        let value = if let Some(path) = native_path {
            capabilities_with_validation(
                &nirs4all_preflight::native::NativeMethodsProvider::load(&path)
                    .map_err(|e| e.reason)?,
                &DagMlValidationProvider::load(&path).map_err(|e| e.reason)?,
            )
        } else {
            capabilities(&provider)
        };
        println!(
            "{}",
            serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    if command != "validate" && command != "analyze" {
        return Err(format!("unknown command: {command}"));
    }
    let input_path = args.next().unwrap_or_else(|| "-".into());
    let input_json = if input_path == "-" {
        let mut s = String::new();
        io::stdin()
            .take(64 * 1024 * 1024 + 1)
            .read_to_string(&mut s)
            .map_err(|e| e.to_string())?;
        s
    } else {
        if fs::metadata(&input_path).map_err(|e| e.to_string())?.len() > 64 * 1024 * 1024 {
            return Err("JSON_MEMORY_BUDGET_EXCEEDED".into());
        }
        fs::read_to_string(&input_path).map_err(|e| e.to_string())?
    };
    if input_json.len() > 64 * 1024 * 1024 {
        return Err("JSON_MEMORY_BUDGET_EXCEEDED".into());
    }
    let input: QualificationInput = serde_json::from_str(&input_json).map_err(|e| e.to_string())?;
    if command == "validate" {
        let validation = validate_input(&input);
        println!(
            "{}",
            serde_json::to_string_pretty(&validation).map_err(|e| e.to_string())?
        );
        return if validation.valid {
            Ok(())
        } else {
            Err("VALIDATION_FAILED".into())
        };
    }
    let mut html_path = None;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--methods-library" => {
                native_path = Some(args.next().ok_or("missing Methods library path")?)
            }
            "--html" => html_path = Some(args.next().ok_or("missing HTML output path")?),
            _ => return Err(format!("unknown option: {flag}")),
        }
    }
    let report = if let Some(path) = native_path {
        analyze_with_validation(
            &input,
            &nirs4all_preflight::native::NativeMethodsProvider::load(&path)
                .map_err(|e| e.reason)?,
            &DagMlValidationProvider::load(&path).map_err(|e| e.reason)?,
        )
    } else {
        analyze(&input, &provider)
    };
    if let Some(path) = html_path {
        fs::write(path, report_html(&report)).map_err(|e| e.to_string())?;
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
