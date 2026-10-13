//! Technical-repeat measurement protocols: pooled repeatability and the
//! one-way ICC per technical context (repeat type x instrument x campaign).
//! The engine builds contexts, groups and statuses; Methods computes.
use crate::*;
use serde_json::json;
use std::collections::{BTreeMap, HashMap};

pub(crate) fn analyze_repeats(
    source: &SpectralSource,
    samples: &HashMap<&str, &Sample>,
    dev_rows: &[usize],
    provider: &impl MethodsProvider,
    report: &mut QualificationReport,
) {
    let Some(types) = &source.repetition_types else {
        report.metrics.push(Metric::unavailable(
            "measurement.repeatability_sd",
            Availability::NotApplicable,
            "REPETITION_TYPE_NOT_DECLARED",
            Some(&source.source_id),
            None,
        ));
        return;
    };
    let mut contexts: BTreeMap<(String, String, String), Vec<usize>> = BTreeMap::new();
    for &r in dev_rows {
        let kind = match types[r] {
            RepetitionType::Rescan => "rescan",
            RepetitionType::Repositioning => "repositioning",
            RepetitionType::Repreparation => "repreparation",
            _ => continue,
        };
        let s = samples[source.sample_ids[r].as_str()];
        contexts
            .entry((
                kind.into(),
                s.instrument.clone().unwrap_or_default(),
                s.campaign.clone().unwrap_or_default(),
            ))
            .or_default()
            .push(r);
    }
    if contexts.is_empty() {
        report.metrics.push(Metric::unavailable(
            "measurement.repeatability_sd",
            Availability::NotApplicable,
            "NO_DECLARED_TECHNICAL_REPEATS",
            Some(&source.source_id),
            None,
        ));
        return;
    }
    let mut attempted = false;
    for ((kind, instrument, campaign), rows) in contexts {
        let mut group_map = BTreeMap::<String, i64>::new();
        let group_ids: Vec<i64> = rows
            .iter()
            .map(|&r| {
                let s = samples[source.sample_ids[r].as_str()];
                let physical = s
                    .physical_sample_id
                    .clone()
                    .unwrap_or_else(|| s.sample_id.clone());
                if let Some(id) = group_map.get(&physical) {
                    *id
                } else {
                    let id = group_map.len() as i64;
                    group_map.insert(physical, id);
                    id
                }
            })
            .collect();
        let counts: BTreeMap<i64, usize> = group_ids.iter().fold(BTreeMap::new(), |mut m, id| {
            *m.entry(*id).or_default() += 1;
            m
        });
        if counts.values().filter(|&&n| n >= 2).count() < 2 {
            continue;
        }
        attempted = true;
        let request = RepeatabilityRequest {
            source_id: source.source_id.clone(),
            matrix: rows
                .iter()
                .map(|&r| source.x[r].iter().map(|v| v.unwrap_or(0.0)).collect())
                .collect(),
            group_ids,
            valid_mask: rows
                .iter()
                .map(|&r| {
                    (0..source.axis.len())
                        .map(|c| valid_cell(source, r, c).is_some())
                        .collect()
                })
                .collect(),
        };
        match provider.repeatability(&request) {
            Ok(d)
                if d.pooled_sd.len() == source.axis.len()
                    && d.icc.len() == source.axis.len()
                    && d.band_status.len() == source.axis.len()
                    && d.n_complete_groups.len() == source.axis.len()
                    && d.pooled_sd
                        .iter()
                        .flatten()
                        .all(|v| v.is_finite() && *v >= 0.0)
                    && d.icc.iter().flatten().all(|v| v.is_finite())
                    && d.band_status.iter().all(|&s| (0..=3).contains(&s))
                    && d.band_status
                        .iter()
                        .zip(&d.icc)
                        .all(|(&s, v)| (s == 0) == v.is_some()) =>
            {
                let mut m = if d.pooled_sd.iter().any(Option::is_some) {
                    Metric::computed(
                        "measurement.repeatability_sd",
                        json!(d.pooled_sd),
                        Some(&source.source_id),
                        None,
                    )
                } else {
                    Metric::unavailable(
                        "measurement.repeatability_sd",
                        Availability::InsufficientData,
                        "NO_BAND_WITH_REPEATS",
                        Some(&source.source_id),
                        None,
                    )
                };
                m.unit =
                    (!source.signal_unit.trim().is_empty()).then(|| source.signal_unit.clone());
                m.denominators.insert("n_observations".into(), rows.len());
                m.denominators
                    .insert("n_physical_groups".into(), counts.len());
                m.parameters.insert("repeat_type".into(), json!(kind));
                m.parameters.insert("instrument".into(), json!(instrument));
                m.parameters.insert("campaign".into(), json!(campaign));
                m.parameters
                    .insert("backend_version".into(), json!(d.backend_version));
                m.parameters.insert(
                    "band_status_0_icc_1_insufficient_2_unbalanced_3_zero_total".into(),
                    json!(d.band_status),
                );
                m.parameters.insert(
                    "n_groups_with_valid_observations_per_band".into(),
                    json!(d.n_complete_groups),
                );
                report.metrics.push(m);
                let mut icc = if d.band_status.contains(&0) {
                    Metric::computed(
                        "measurement.icc_1_1",
                        json!(d.icc),
                        Some(&source.source_id),
                        None,
                    )
                } else {
                    Metric::unavailable(
                        "measurement.icc_1_1",
                        Availability::Unsupported,
                        "UNBALANCED_OR_UNDEFINED_ALL_BANDS",
                        Some(&source.source_id),
                        None,
                    )
                };
                icc.parameters.insert(
                    "band_status_0_computed_1_insufficient_2_unbalanced_3_zero_total".into(),
                    json!(d.band_status),
                );
                icc.parameters.insert(
                    "n_groups_with_valid_observations_per_band".into(),
                    json!(d.n_complete_groups),
                );
                report.metrics.push(icc);
            }
            Ok(_) => report.metrics.push(Metric::unavailable(
                "measurement.repeatability_sd",
                Availability::Error,
                "INVALID_PROVIDER_RESULT",
                Some(&source.source_id),
                None,
            )),
            Err(e) => report.metrics.push(Metric::unavailable(
                "measurement.repeatability_sd",
                e.availability(),
                &e.reason,
                Some(&source.source_id),
                None,
            )),
        }
    }
    if !attempted {
        report.metrics.push(Metric::unavailable(
            "measurement.repeatability_sd",
            Availability::InsufficientData,
            "FEWER_THAN_TWO_REPEATED_PHYSICAL_GROUPS",
            Some(&source.source_id),
            None,
        ));
    }
}
