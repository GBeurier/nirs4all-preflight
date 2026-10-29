//! Versioned intrinsic protocols. Methods owns every numerical operation;
//! this module selects the population, validates results, and binds identities.
use crate::*;

const REFERENCE: &[&str] = &[
    "rms",
    "sam",
    "affine_offset",
    "affine_gain",
    "affine_abs_offset",
    "affine_abs_gain_delta",
    "affine_residual_rms",
];
const EVENTS: &[&str] = &[
    "jump_count",
    "jump_fraction",
    "spike_count",
    "spike_fraction",
    "declared_clip_count",
    "declared_clip_fraction",
];
const NOISE: &[&str] = &[
    "noise_sigma",
    "signal_mean_abs",
    "signal_noise_ratio",
    "signal_noise_db",
];

struct Protocol<'a> {
    family: &'a str,
    method: &'a str,
    version: &'a str,
    signals: &'a [&'a str],
}

struct Context<'a, 's> {
    source: &'a SpectralSource,
    rows: &'a [usize],
    samples: &'a HashMap<&'s str, &'s Sample>,
    options: &'a IntrinsicQcOptions,
}

fn error() -> ProviderError {
    ProviderError::internal("INTRINSIC_PROCEDURE_INVALID_RESPONSE")
}
fn scalar(output: &ProcedureDiagnostics, key: &str) -> Result<f64, ProviderError> {
    match output.outputs.get(key) {
        Some(ProcedureOutput::Scalar { value }) if value.is_finite() => Ok(*value),
        _ => Err(error()),
    }
}
fn count(output: &ProcedureDiagnostics, key: &str) -> Result<usize, ProviderError> {
    let value = scalar(output, key)?;
    if (0. ..=10_000_000.).contains(&value) && value.fract() == 0. {
        Ok(value as usize)
    } else {
        Err(error())
    }
}
fn integers<'a>(output: &'a ProcedureDiagnostics, key: &str) -> Result<&'a [i64], ProviderError> {
    match output.outputs.get(key) {
        Some(ProcedureOutput::IntegerVector { data }) => Ok(data),
        _ => Err(error()),
    }
}
fn status(code: i64) -> Result<(Availability, Option<&'static str>), ProviderError> {
    Ok(match code {
        0 => (Availability::Computed, None),
        1 => (
            Availability::InsufficientData,
            Some("INSUFFICIENT_VALID_SPECTRAL_VALUES"),
        ),
        2 => (Availability::Undefined, Some("ZERO_SPECTRAL_NORM")),
        3 => (
            Availability::Undefined,
            Some("DEGENERATE_SPECTRAL_REFERENCE"),
        ),
        4 => (Availability::Undefined, Some("UNDEFINED_NUMERICAL_DOMAIN")),
        5 => (
            Availability::NotApplicable,
            Some("PHYSICAL_SENSOR_BOUNDS_NOT_DECLARED"),
        ),
        _ => return Err(error()),
    })
}

fn global_names(family: &str) -> &'static [&'static str] {
    match family {
        "events" => &[
            "observed_extrema_occupancy_fraction",
            "global_jump_count",
            "global_jump_eligible",
            "global_jump_fraction",
            "global_spike_count",
            "global_spike_eligible",
            "global_spike_fraction",
            "global_declared_clip_count",
            "global_declared_clip_eligible",
            "global_declared_clip_fraction",
        ],
        "noise" => &[
            "global_noise_sigma",
            "global_signal_mean_abs",
            "global_signal_noise_ratio",
            "global_signal_noise_db",
        ],
        _ => &[],
    }
}
fn global_status(output: &ProcedureDiagnostics, name: &str) -> Result<i64, ProviderError> {
    let key = if name == "observed_extrema_occupancy_fraction" {
        "observed_extrema_occupancy_status".to_owned()
    } else {
        format!("{name}_status")
    };
    let codes = integers(output, &key)?;
    if codes.len() != 1 {
        return Err(error());
    }
    status(codes[0])?;
    if codes[0] == 0 {
        scalar(output, name)?;
    } else if output.outputs.contains_key(name) {
        return Err(error());
    }
    Ok(codes[0])
}
fn decorate(
    metric: &mut Metric,
    protocol: &Protocol<'_>,
    source: &SpectralSource,
    options: &IntrinsicQcOptions,
) {
    metric.protocol_version = protocol.version.into();
    metric.scope = "source".into();
    metric.view_id = "native:observations".into();
    metric
        .parameters
        .insert("methods_procedure".into(), json!(protocol.method));
    metric.parameters.insert(
        "reference_definition".into(),
        json!(if protocol.family == "reference" {
            "development_real_dataset_mean_per_valid_feature"
        } else {
            "none"
        }),
    );
    metric
        .parameters
        .insert("axis_basis".into(), json!(options.axis_basis));
    metric
        .parameters
        .insert("axis_unit".into(), json!(source.axis_unit));
    metric
        .parameters
        .insert("signal_unit".into(), json!(source.signal_unit));
    metric.parameters.insert("options".into(), json!(options));
    metric.parameters.insert(
        "interpretation".into(),
        json!("descriptive_signature_only_not_causal_confidence_or_calibrated_probability"),
    );
    metric.parameters.insert(
        "population_weighting".into(),
        json!("one_per_real_development_observation_no_independence_claim"),
    );
}
fn unit(signal: &str, source: &SpectralSource) -> String {
    match signal {
        "sam" => "rad".into(),
        "rms"
        | "affine_offset"
        | "affine_abs_offset"
        | "affine_residual_rms"
        | "noise_sigma"
        | "signal_mean_abs" => source.signal_unit.clone(),
        s if s.ends_with("_count") || s.ends_with("_eligible") => "count".into(),
        "signal_noise_db" => "dB_descriptive_ratio".into(),
        _ => "1".into(),
    }
}

struct NormalizedSignal {
    values: Vec<Option<f64>>,
    codes: Vec<i64>,
    eligible: usize,
    aggregate_code: i64,
}

fn normalize_signal(
    output: &ProcedureDiagnostics,
    signal: &str,
    n: usize,
) -> Result<NormalizedSignal, ProviderError> {
    let statuses = integers(output, &format!("{signal}_status"))?.to_vec();
    if statuses.len() != n {
        return Err(error());
    }
    for code in &statuses {
        status(*code)?;
    }
    let eligible = count(output, &format!("{signal}_n"))?;
    let aggregate = integers(output, &format!("{signal}_aggregate_status"))?;
    if aggregate.len() != 1 {
        return Err(error());
    }
    status(aggregate[0])?;
    if eligible > n || (eligible > 0) != (aggregate[0] == 0) {
        return Err(error());
    }
    let mut values = vec![None; n];
    if eligible > 0 {
        let rows = integers(output, &format!("{signal}_rows"))?;
        let data = match output.outputs.get(&format!("{signal}_values")) {
            Some(ProcedureOutput::Matrix { rows, cols, data })
                if *rows == eligible && *cols == 1 && data.len() == eligible =>
            {
                data
            }
            _ => return Err(error()),
        };
        if rows.len() != eligible {
            return Err(error());
        }
        for (row, value) in rows.iter().zip(data) {
            let row = usize::try_from(*row).map_err(|_| error())?;
            if row >= n || statuses[row] != 0 || values[row].is_some() || !value.is_finite() {
                return Err(error());
            }
            values[row] = Some(*value);
        }
        scalar(output, &format!("{signal}_median"))?;
        scalar(output, &format!("{signal}_p95"))?;
    } else if output.outputs.contains_key(&format!("{signal}_median"))
        || output.outputs.contains_key(&format!("{signal}_p95"))
    {
        return Err(error());
    }
    if values
        .iter()
        .zip(&statuses)
        .any(|(v, s)| v.is_some() != (*s == 0))
    {
        return Err(error());
    }
    Ok(NormalizedSignal {
        values,
        codes: statuses,
        eligible,
        aggregate_code: aggregate[0],
    })
}

fn publish(
    protocol: &Protocol<'_>,
    request: &ProcedureRequest,
    context: &Context<'_, '_>,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let Context {
        source,
        rows,
        samples,
        options,
    } = context;
    let result = if rows.is_empty() {
        Err(ProviderError::unsupported(
            "NO_REAL_DEVELOPMENT_OBSERVATIONS",
        ))
    } else if protocol.family == "local_density"
        && request
            .parameters
            .get("valid_mask")
            .is_some_and(|p| matches!(p, ProcedureParameter::IntArray(mask) if mask.contains(&0)))
    {
        Err(ProviderError::unsupported("LOF_REQUIRES_COMPLETE_SPECTRA"))
    } else if protocol.family == "local_density"
        && (rows.len() as u128) * (rows.len() as u128) * (source.axis.len() as u128) > 2_500_000_000
    {
        Err(ProviderError::unsupported(
            "LOF_SHAPE_OR_WORK_BUDGET_EXCEEDED",
        ))
    } else {
        provider.procedure(request)
    }
    .and_then(|output| {
        if scalar(&output, "protocol_version")? != 1. || count(&output, "n_rows")? != rows.len() {
            return Err(error());
        }
        let normalized = protocol
            .signals
            .iter()
            .map(|signal| normalize_signal(&output, signal, rows.len()))
            .collect::<Result<Vec<_>, _>>()?;
        for name in global_names(protocol.family) {
            global_status(&output, name)?;
        }
        Ok((output, normalized))
    });
    let (output, normalized) = match result {
        Ok(value) => value,
        Err(error) => {
            for signal in protocol.signals {
                for suffix in ["", "_median", "_p95"] {
                    let mut metric = Metric::unavailable(
                        &format!("intrinsic.{}.{signal}{suffix}", protocol.family),
                        if rows.is_empty() {
                            Availability::InsufficientData
                        } else {
                            error.availability()
                        },
                        &error.reason,
                        Some(&source.source_id),
                        None,
                    );
                    decorate(&mut metric, protocol, source, options);
                    metric
                        .denominators
                        .insert("n_observations".into(), rows.len());
                    report.metrics.push(metric);
                }
            }
            for name in global_names(protocol.family) {
                let mut metric = Metric::unavailable(
                    &format!("intrinsic.{}.{name}", protocol.family),
                    if rows.is_empty() {
                        Availability::InsufficientData
                    } else {
                        error.availability()
                    },
                    &error.reason,
                    Some(&source.source_id),
                    None,
                );
                decorate(&mut metric, protocol, source, options);
                report.metrics.push(metric);
            }
            return;
        }
    };
    let observation_ids: Vec<_> = rows.iter().map(|r| &source.observation_ids[*r]).collect();
    let sample_ids: Vec<_> = rows.iter().map(|r| &source.sample_ids[*r]).collect();
    let physical_ids: Vec<_> = sample_ids
        .iter()
        .map(|id| {
            samples
                .get(id.as_str())
                .and_then(|s| s.physical_sample_id.as_deref())
        })
        .collect();
    // Retain every named native output (including counts/masks and sparse
    // indices) as transport evidence, independently of signal availability.
    let mut evidence = Metric::computed(
        &format!("intrinsic.{}.protocol_evidence", protocol.family),
        json!(output),
        Some(&source.source_id),
        None,
    );
    decorate(&mut evidence, protocol, source, options);
    evidence
        .parameters
        .insert("observation_ids".into(), json!(observation_ids));
    evidence
        .parameters
        .insert("sample_ids".into(), json!(sample_ids));
    evidence
        .parameters
        .insert("physical_sample_ids".into(), json!(physical_ids));
    evidence.parameters.insert(
        "meaning".into(),
        json!("lossless_methods_transport_evidence_not_a_quality_verdict"),
    );
    report.metrics.push(evidence);
    for name in global_names(protocol.family) {
        let code = global_status(&output, name).expect("validated global status");
        let (availability, reason) = status(code).expect("validated global status");
        let id = format!("intrinsic.{}.{name}", protocol.family);
        let mut metric = if code == 0 {
            Metric::computed(
                &id,
                json!(scalar(&output, name).expect("validated global scalar")),
                Some(&source.source_id),
                None,
            )
        } else {
            Metric::unavailable(
                &id,
                availability,
                reason.unwrap_or("INTRINSIC_UNAVAILABLE"),
                Some(&source.source_id),
                None,
            )
        };
        decorate(&mut metric, protocol, source, options);
        metric.unit = Some(unit(name.strip_prefix("global_").unwrap_or(name), source));
        metric
            .parameters
            .insert("backend_version".into(), json!(output.backend_version));
        report.metrics.push(metric);
    }
    for (
        signal,
        NormalizedSignal {
            values,
            codes,
            eligible,
            aggregate_code,
        },
    ) in protocol.signals.iter().zip(normalized)
    {
        let (availability, reason) = status(aggregate_code).expect("validated status");
        let reasons: Vec<_> = codes
            .iter()
            .map(|c| status(*c).expect("validated status").1)
            .collect();
        let mut metric = if eligible > 0 {
            Metric::computed(
                &format!("intrinsic.{}.{signal}", protocol.family),
                json!({ "observation_ids": observation_ids, "sample_ids": sample_ids, "physical_sample_ids": physical_ids, "values": values, "status_codes": codes, "reason_codes": reasons }),
                Some(&source.source_id),
                None,
            )
        } else {
            Metric::unavailable(
                &format!("intrinsic.{}.{signal}", protocol.family),
                availability.clone(),
                reason.unwrap_or("INTRINSIC_UNAVAILABLE"),
                Some(&source.source_id),
                None,
            )
        };
        decorate(&mut metric, protocol, source, options);
        metric.unit = Some(unit(signal, source));
        metric
            .denominators
            .insert("n_observations".into(), rows.len());
        metric
            .denominators
            .insert("n_available_observations".into(), eligible);
        metric
            .parameters
            .insert("backend_version".into(), json!(output.backend_version));
        // Statuses also survive when the entire metric is unavailable.
        metric
            .parameters
            .insert("row_status_codes".into(), json!(codes));
        metric
            .parameters
            .insert("observation_ids".into(), json!(observation_ids));
        report.metrics.push(metric);
        for suffix in ["median", "p95"] {
            let id = format!("intrinsic.{}.{signal}_{suffix}", protocol.family);
            let mut metric = if eligible > 0 {
                Metric::computed(
                    &id,
                    json!(
                        scalar(&output, &format!("{signal}_{suffix}")).expect("validated summary")
                    ),
                    Some(&source.source_id),
                    None,
                )
            } else {
                Metric::unavailable(
                    &id,
                    availability.clone(),
                    reason.unwrap_or("INTRINSIC_UNAVAILABLE"),
                    Some(&source.source_id),
                    None,
                )
            };
            decorate(&mut metric, protocol, source, options);
            metric.unit = Some(unit(signal, source));
            metric
                .denominators
                .insert("n_available_observations".into(), eligible);
            metric
                .parameters
                .insert("quantile".into(), json!("Methods_Hyndman_Fan_type7"));
            metric
                .parameters
                .insert("backend_version".into(), json!(output.backend_version));
            report.metrics.push(metric);
        }
    }
}

pub(super) fn analyze(
    source: &SpectralSource,
    samples: &HashMap<&str, &Sample>,
    rows: &[usize],
    input: &QualificationInput,
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let Some(options) = &input.options.intrinsic_qc else {
        return;
    };
    let context = Context {
        source,
        rows,
        samples,
        options,
    };
    let mut matrix = Vec::with_capacity(rows.len());
    let mut mask = Vec::with_capacity(rows.len() * source.axis.len());
    for row in rows {
        let mut values = Vec::with_capacity(source.axis.len());
        for col in 0..source.axis.len() {
            let value = valid_cell(source, *row, col);
            mask.push(i64::from(value.is_some()));
            // Explicit masked payload required by Methods. Mask accompanies
            // every call; no absent cell becomes an observed zero.
            values.push(value.unwrap_or(0.));
        }
        matrix.push(values);
    }
    let base = ProcedureRequest {
        method_id: String::new(),
        matrix,
        reference: None,
        parameters: BTreeMap::from([("valid_mask".into(), ProcedureParameter::IntArray(mask))]),
    };
    let run = |protocol: Protocol<'_>,
               mut request: ProcedureRequest,
               report: &mut QualificationReport| {
        request.method_id = protocol.method.into();
        publish(&protocol, &request, &context, provider, report);
    };
    if options.reference {
        let mut request = base.clone();
        request.parameters.insert(
            "reference_mode".into(),
            ProcedureParameter::Enum("dataset_mean".into()),
        );
        run(
            Protocol {
                family: "reference",
                method: "diagnostics.spectral_reference_qc",
                version: "spectral-reference-pairwise-valid.v1",
                signals: REFERENCE,
            },
            request,
            report,
        );
    }
    if options.events {
        let mut request = base.clone();
        request.parameters.insert(
            "axis_basis".into(),
            ProcedureParameter::Enum(
                match options.axis_basis {
                    IntrinsicAxisBasis::Index => "index",
                    IntrinsicAxisBasis::Physical => "physical",
                }
                .into(),
            ),
        );
        if options.axis_basis == IntrinsicAxisBasis::Physical {
            request.parameters.insert(
                "axis_values".into(),
                ProcedureParameter::DoubleArray(source.axis.clone()),
            );
        }
        request.parameters.insert(
            "outlier_threshold".into(),
            ProcedureParameter::Double(options.outlier_threshold),
        );
        request.parameters.insert(
            "clip_tolerance".into(),
            ProcedureParameter::Double(options.clip_tolerance),
        );
        for (name, value) in [
            ("clip_lower", options.clip_lower),
            ("clip_upper", options.clip_upper),
        ] {
            if let Some(value) = value {
                request
                    .parameters
                    .insert(name.into(), ProcedureParameter::Double(value));
            }
        }
        run(
            Protocol {
                family: "events",
                method: "diagnostics.spectral_events_qc",
                version: "spectral-events-declared-axis.v1",
                signals: EVENTS,
            },
            request,
            report,
        );
    }
    if options.noise {
        run(
            Protocol {
                family: "noise",
                method: "diagnostics.spectral_noise_proxy",
                version: "spectral-second-difference-mad-index.v1",
                signals: NOISE,
            },
            base.clone(),
            report,
        );
    }
    if options.local_density {
        let mut request = base;
        request
            .parameters
            .insert("mode".into(), ProcedureParameter::Enum("training".into()));
        request.parameters.insert(
            "n_neighbors".into(),
            ProcedureParameter::Int(options.n_neighbors as i64),
        );
        run(
            Protocol {
                family: "local_density",
                method: "diagnostics.local_density",
                version: "euclidean-fixed-k-lof.v1",
                signals: &["lof"],
            },
            request,
            report,
        );
    }
}
