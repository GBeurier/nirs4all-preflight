//! Confounding protocol (`confounding.v1`). Status routing uses a scripted
//! provider; numerical end-to-end cases use the real Methods library
//! (`N4M_LIBRARY_PATH`) and compare the engine output with closed forms
//! computed here from the reported canonical PCA scores.
use nirs4all_preflight::native::NativeMethodsProvider;
use nirs4all_preflight::*;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Scripted provider: identity-like PCA and fixed PERMANOVA/PERMDISP effects.
/// df follows the aliasing rule only for the designs used here (each
/// stratum holding a single term level makes the term aliased).
struct Scripted {
    log10_distinct: f64,
}

/// Scripted provider whose PERMANOVA fails with a given provider error.
struct Failing(ProviderError);
impl MethodsProvider for Failing {
    fn capabilities(&self) -> Vec<Capability> {
        Scripted {
            log10_distinct: 5.0,
        }
        .capabilities()
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        Scripted {
            log10_distinct: 5.0,
        }
        .pca(r)
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Err(ProviderError::unsupported("NOT_SCRIPTED"))
    }
    fn permanova(&self, _: &PermanovaRequest) -> Result<PermanovaDiagnostics, ProviderError> {
        Err(self.0.clone())
    }
}
impl MethodsProvider for Scripted {
    fn capabilities(&self) -> Vec<Capability> {
        [
            "methods.pca",
            "methods.permanova",
            "methods.permdisp",
            "methods.holm_adjust",
            "methods.permanova_freedman_lane",
        ]
        .iter()
        .map(|id| Capability {
            capability_id: (*id).into(),
            available: true,
            qualified: false,
            reason: None,
        })
        .collect()
    }
    fn pca(&self, r: &PcaRequest) -> Result<PcaDiagnostics, ProviderError> {
        let k = r.n_components;
        Ok(PcaDiagnostics {
            eigenvalues: vec![1.0; k],
            scores: r.matrix.iter().map(|row| row[..k].to_vec()).collect(),
            full_moments: [k as f64, k as f64],
            backend_version: "scripted".into(),
        })
    }
    fn repeatability(
        &self,
        _: &RepeatabilityRequest,
    ) -> Result<RepeatabilityDiagnostics, ProviderError> {
        Err(ProviderError::unsupported("NOT_SCRIPTED"))
    }
    fn permanova(&self, r: &PermanovaRequest) -> Result<PermanovaDiagnostics, ProviderError> {
        let n = r.term_codes.len();
        let levels: BTreeSet<_> = r.term_codes.iter().collect();
        let strata = r.strata_codes.clone().unwrap_or(vec![0; n]);
        let n_strata = strata.iter().collect::<BTreeSet<_>>().len();
        let mut per_stratum = BTreeMap::<i64, BTreeSet<i64>>::new();
        for (s, t) in strata.iter().zip(&r.term_codes) {
            per_stratum.entry(*s).or_default().insert(*t);
        }
        let aliased = per_stratum.values().all(|t| t.len() == 1);
        // Bounded by the residual space (exact only for the designs used here).
        let df_term = if aliased {
            0
        } else {
            (levels.len() - 1).min(n - n_strata)
        };
        let b = 9;
        let executed = if df_term > 0 { r.n_permutations } else { 0 };
        Ok(PermanovaDiagnostics {
            ss_total: 10.0,
            ss_strata: 1.0,
            ss_term: if aliased { 0.0 } else { 4.0 },
            ss_residual: 5.0,
            r2: (!aliased).then_some(0.4),
            partial_r2: (!aliased).then_some(0.5),
            pseudo_f: (!aliased).then_some(3.0),
            df_term,
            df_residual: n - n_strata - df_term,
            n_levels: levels.len(),
            n_strata,
            log10_distinct_permutations: self.log10_distinct,
            p_value: (executed > 0).then(|| (1.0 + b as f64) / (1.0 + executed as f64)),
            n_at_least_observed: if executed > 0 { b } else { 0 },
            n_permutations_executed: executed,
            backend_version: "scripted".into(),
        })
    }
    fn permdisp(&self, r: &PermdispRequest) -> Result<PermdispDiagnostics, ProviderError> {
        let n = r.group_codes.len();
        let g = r.group_codes.iter().collect::<BTreeSet<_>>().len();
        let executed = r.n_permutations;
        Ok(PermdispDiagnostics {
            distances: vec![1.0; n],
            group_mean_distances: vec![1.0; g],
            f: Some(0.5),
            df1: g - 1,
            df2: n - g,
            n_groups: g,
            log10_distinct_permutations: self.log10_distinct,
            p_value: (executed > 0).then(|| 500.0 / (1.0 + executed as f64)),
            n_at_least_observed: if executed > 0 { 499 } else { 0 },
            n_permutations_executed: executed,
            backend_version: "scripted".into(),
        })
    }
    fn permanova_freedman_lane(
        &self,
        r: &FreedmanLaneRequest,
    ) -> Result<FreedmanLaneDiagnostics, ProviderError> {
        // Aliased when every level combination of the conditions holds a
        // single term level; reduced rank 1 + sum(levels - 1), additive.
        let n = r.term_codes.len();
        let levels = |codes: &[i64]| codes.iter().collect::<BTreeSet<_>>().len();
        let rank_reduced = 1 + r
            .condition_codes
            .iter()
            .map(|c| levels(c) - 1)
            .sum::<usize>();
        let mut per_cell = BTreeMap::<Vec<i64>, BTreeSet<i64>>::new();
        for i in 0..n {
            let cell = r.condition_codes.iter().map(|c| c[i]).collect();
            per_cell.entry(cell).or_default().insert(r.term_codes[i]);
        }
        let aliased = per_cell.values().all(|t| t.len() == 1);
        let df_term = if aliased {
            0
        } else {
            levels(&r.term_codes) - 1
        };
        let executed = if df_term > 0 { r.n_permutations } else { 0 };
        Ok(FreedmanLaneDiagnostics {
            ss_total: 10.0,
            ss_reduced: 1.0,
            ss_term: if aliased { 0.0 } else { 4.0 },
            ss_residual: 5.0,
            r2: (!aliased).then_some(0.4),
            partial_r2: (!aliased).then_some(0.5),
            pseudo_f: (!aliased).then_some(3.0),
            df_term,
            df_residual: n.saturating_sub(rank_reduced + df_term),
            rank_reduced,
            log10_distinct_permutations: self.log10_distinct,
            p_value: (executed > 0).then(|| 10.0 / (1.0 + executed as f64)),
            n_at_least_observed: if executed > 0 { 9 } else { 0 },
            n_permutations_executed: executed,
            backend_version: "scripted".into(),
        })
    }
    fn holm_adjust(&self, r: &HolmRequest) -> Result<HolmDiagnostics, ProviderError> {
        // Holm step-down, written out for this test (R p.adjust "holm").
        let m = r.p_values.len();
        let mut order: Vec<usize> = (0..m).collect();
        order.sort_by(|a, b| r.p_values[*a].total_cmp(&r.p_values[*b]));
        let mut adjusted = vec![0.0; m];
        let mut running: f64 = 0.0;
        for (rank, &i) in order.iter().enumerate() {
            running = running.max((m - rank) as f64 * r.p_values[i]);
            adjusted[i] = running.min(1.0);
        }
        Ok(HolmDiagnostics {
            adjusted,
            backend_version: "scripted".into(),
        })
    }
}

/// One observation per sample; rows are (instrument, campaign, spectrum).
fn dataset(rows: &[(&str, &str, Vec<f64>)]) -> QualificationInput {
    let ids: Vec<String> = (0..rows.len()).map(|i| format!("s{i:02}")).collect();
    let p = rows[0].2.len();
    QualificationInput {
        schema_version: 1,
        data_origin: DataOrigin::Synthetic,
        sources: vec![SpectralSource {
            source_id: "x".into(),
            observation_ids: ids.iter().map(|i| format!("o_{i}")).collect(),
            sample_ids: ids.clone(),
            x: rows
                .iter()
                .map(|r| r.2.iter().map(|v| Some(*v)).collect())
                .collect(),
            valid_mask: None,
            axis: (0..p).map(|j| 1000.0 + j as f64).collect(),
            axis_unit: "nm".into(),
            signal_unit: "abs".into(),
            signal_type: "absorbance".into(),
            repetition_types: None,
        }],
        samples: ids
            .iter()
            .zip(rows)
            .map(|(id, r)| Sample {
                sample_id: id.clone(),
                physical_sample_id: Some(format!("p_{id}")),
                partition: Partition::Development,
                independence_group: None,
                instrument: (!r.0.is_empty()).then(|| r.0.to_string()),
                campaign: (!r.1.is_empty()).then(|| r.1.to_string()),
                individual_id: None,
                augmentation_parent_id: None,
            })
            .collect(),
        targets: vec![],
        metadata: Default::default(),
        options: Options {
            independence_unit: IndependenceUnit::Sample,
            exchangeable_units: true,
            seed: 7,
            snv_sensitivity: false,
            ..Options::default()
        },
    }
}

/// Deterministic, tie-free perturbation.
fn wobble(i: usize, j: usize) -> f64 {
    0.05 * ((i * 7 + j * 3) as f64).sin() + 0.03 * ((i * i + 2 * j) as f64).cos()
}

/// 6 samples per cell; instrument B shifts the spectrum, campaign c2 slightly.
fn crossed(per_cell: usize, aliased: bool) -> QualificationInput {
    let mut rows = Vec::new();
    for (ci, (instrument, campaign)) in [("A", "c1"), ("B", "c1"), ("A", "c2"), ("B", "c2")]
        .into_iter()
        .enumerate()
    {
        // Aliased design: instrument A only in c1 and B only in c2.
        if aliased && ((instrument == "A") != (campaign == "c1")) {
            continue;
        }
        for k in 0..per_cell {
            let i = ci * per_cell + k;
            let shift = if instrument == "B" { 0.6 } else { 0.0 };
            let drift = if campaign == "c2" { 0.05 } else { 0.0 };
            rows.push((
                instrument,
                campaign,
                (0..3)
                    .map(|j| 1.0 + shift * [1.0, 0.5, 0.0][j] + drift + wobble(i, j))
                    .collect(),
            ));
        }
    }
    dataset(&rows)
}

fn find<'a>(report: &'a QualificationReport, id: &str, factor: Option<&str>) -> &'a Metric {
    report
        .metrics
        .iter()
        .find(|m| {
            m.metric_id == id
                && factor.is_none_or(|f| m.parameters.get("factor") == Some(&Value::from(f)))
        })
        .unwrap_or_else(|| panic!("missing {id} {factor:?}"))
}

fn reason(m: &Metric) -> Option<&str> {
    m.reason_code.as_deref()
}

#[test]
fn aliased_factors_are_not_identifiable_separately() {
    let report = analyze(
        &crossed(6, true),
        &Scripted {
            log10_distinct: 5.0,
        },
    );
    let design = find(&report, "confounding.design", None);
    let factors = design.value.as_ref().unwrap()["factors"]
        .as_array()
        .unwrap();
    for f in factors {
        assert_eq!(f["aliased_with_other_factors"], true);
        assert_eq!(f["df_identifiable_given_other_factors"], 0);
        assert_eq!(f["df_nominal"], 1);
    }
    assert_eq!(factors[0]["determined_by"], serde_json::json!(["campaign"]));
    for factor in ["instrument", "campaign"] {
        let test = find(
            &report,
            "confounding.permanova_conditional_test",
            Some(factor),
        );
        assert!(matches!(test.status, Availability::NotIdentifiable));
        assert_eq!(reason(test), Some("FACTOR_ALIASED_WITH_OTHER_FACTORS"));
        assert!(test.value.is_none());
        // Marginal effects remain testable under declared exchangeability.
        let marginal = find(&report, "confounding.permanova_marginal_test", Some(factor));
        assert!(matches!(marginal.status, Availability::Computed));
        assert_eq!(
            marginal.parameters["permutation_plan"]["restrictions"],
            "none_single_block"
        );
    }
    assert!(report
        .findings
        .iter()
        .any(|f| f.rule_id == "confounding.aliased_factors.v1" && f.confidence == "unknown"));
    let family = find(&report, "confounding.permanova_family", None);
    assert_eq!(family.value.as_ref().unwrap()["family_size"], 2);
}

#[test]
fn conditional_test_permutes_within_blocks_with_derived_seed() {
    let report = analyze(
        &crossed(6, false),
        &Scripted {
            log10_distinct: 5.0,
        },
    );
    let test = find(
        &report,
        "confounding.permanova_conditional_test",
        Some("instrument"),
    );
    assert!(matches!(test.status, Availability::Computed));
    let plan = &test.parameters["permutation_plan"];
    assert_eq!(plan["plan_version"], "permutation_plan.v1");
    assert_eq!(plan["restrictions"], "within_blocks");
    assert_eq!(plan["block_sizes"], serde_json::json!([12, 12]));
    assert_eq!(plan["executed"], true);
    assert_eq!(plan["n_permutations_executed"], 999);
    // Independent Python FNV-1a/SplitMix64 reference.
    assert_eq!(plan["seed"], "16227643824906442121");
    let marginal = find(
        &report,
        "confounding.permanova_marginal_test",
        Some("instrument"),
    );
    assert_eq!(
        marginal.parameters["permutation_plan"]["seed"],
        "16193620801551107043"
    );
    // Six PERMANOVA tests (marginal, within-cells and Freedman-Lane for both
    // factors) share one Holm family; scripted p = 10/1000, Holm 6 x 0.01.
    let value = test.value.as_ref().unwrap();
    assert_eq!(value["p_value"], 0.01);
    assert!((value["p_value_holm"].as_f64().unwrap() - 0.06).abs() < 1e-12);
    assert_eq!(value["rejects_null_at_family_alpha"], false);
    let family = find(&report, "confounding.permanova_family", None);
    assert_eq!(family.value.as_ref().unwrap()["family_size"], 6);
    assert!(test.parameters["permutation_plan"]["reduced_model"].is_null());
    let disp = find(&report, "confounding.permdisp_test", Some("instrument"));
    assert_eq!(
        disp.value.as_ref().unwrap()["rejects_null_at_family_alpha"],
        false
    );
    assert!(capabilities(&Scripted {
        log10_distinct: 5.0
    })
    .iter()
    .any(|c| c.capability_id == "confounding" && c.available && !c.qualified));
}

#[test]
fn undeclared_exchangeability_and_unknown_units_keep_descriptions_only() {
    for (unit, exchangeable, expected) in [
        (
            IndependenceUnit::Sample,
            false,
            "EXCHANGEABILITY_NOT_DECLARED",
        ),
        (IndependenceUnit::Unknown, true, "INDEPENDENCE_UNIT_UNKNOWN"),
    ] {
        let mut input = crossed(6, false);
        input.options.independence_unit = unit;
        input.options.exchangeable_units = exchangeable;
        let report = analyze(
            &input,
            &Scripted {
                log10_distinct: 5.0,
            },
        );
        assert!(matches!(
            find(&report, "confounding.variance_partition", None).status,
            Availability::Computed
        ));
        for id in [
            "confounding.permanova_marginal_test",
            "confounding.permanova_conditional_test",
            "confounding.permdisp_test",
        ] {
            let test = find(&report, id, Some("campaign"));
            assert!(matches!(test.status, Availability::NotIdentifiable));
            assert_eq!(reason(test), Some(expected));
        }
        assert_eq!(
            reason(find(&report, "confounding.permanova_family", None)),
            Some("NO_IDENTIFIABLE_TESTS")
        );
    }
}

#[test]
fn coarse_resolution_gives_no_significance_claim() {
    // 2 levels x 2 units: 4!/(2!2!) = 6 assignments, resolution 1/6.
    let report = analyze(
        &crossed(2, true),
        &Scripted {
            log10_distinct: 6f64.log10(),
        },
    );
    let test = find(
        &report,
        "confounding.permanova_marginal_test",
        Some("instrument"),
    );
    assert!(matches!(test.status, Availability::InsufficientData));
    assert_eq!(reason(test), Some("PERMUTATION_RESOLUTION_INSUFFICIENT"));
    let plan = &test.parameters["permutation_plan"];
    assert!((plan["resolution"].as_f64().unwrap() - 1.0 / 6.0).abs() < 1e-12);
    assert_eq!(plan["executed"], false);
}

#[test]
fn factor_varying_inside_a_unit_or_missing_is_counted_and_blocks_tests() {
    let mut input = crossed(6, false);
    input.options.independence_unit = IndependenceUnit::Group;
    for (i, sample) in input.samples.iter_mut().enumerate() {
        sample.independence_group = Some(format!("g{}", i / 2));
    }
    // Group g0 = {s00, s01}: s01 moves to instrument B, so instrument varies
    // inside g0; g11 = {s22, s23} loses the campaign of s22.
    input.samples[1].instrument = Some("B".into());
    input.samples[22].campaign = None;
    let report = analyze(
        &input,
        &Scripted {
            log10_distinct: 5.0,
        },
    );
    let partition = find(&report, "confounding.variance_partition", None);
    assert_eq!(partition.denominators["n_independence_units"], 12);
    assert_eq!(
        partition.denominators["n_units_factor_varies_within_unit"],
        1
    );
    assert_eq!(partition.denominators["n_units_missing_factor"], 1);
    assert_eq!(partition.denominators["n_units_analyzed"], 10);
    let test = find(
        &report,
        "confounding.permanova_marginal_test",
        Some("instrument"),
    );
    assert_eq!(
        reason(test),
        Some("METADATA_VARIES_WITHIN_INDEPENDENCE_UNIT")
    );
}

#[test]
fn no_declared_factor_or_single_level_is_not_applicable() {
    let mut input = crossed(6, false);
    for s in &mut input.samples {
        s.instrument = None;
        s.campaign = None;
    }
    let report = analyze(
        &input,
        &Scripted {
            log10_distinct: 5.0,
        },
    );
    for id in ["confounding.design", "confounding.variance_partition"] {
        let m = find(&report, id, None);
        assert!(matches!(m.status, Availability::NotApplicable));
        assert_eq!(reason(m), Some("NO_DECLARED_FACTOR"));
    }
    let mut input = crossed(6, false);
    for s in &mut input.samples {
        s.campaign = Some("c1".into());
    }
    let report = analyze(
        &input,
        &Scripted {
            log10_distinct: 5.0,
        },
    );
    let test = find(
        &report,
        "confounding.permanova_marginal_test",
        Some("campaign"),
    );
    assert_eq!(reason(test), Some("SINGLE_FACTOR_LEVEL"));
    // Campaign has a single level: instrument has no other factor to condition on.
    let conditional = find(
        &report,
        "confounding.permanova_conditional_test",
        Some("instrument"),
    );
    assert_eq!(reason(conditional), Some("NO_OTHER_VARYING_FACTOR"));
    assert!(matches!(
        find(
            &report,
            "confounding.permanova_marginal_test",
            Some("instrument")
        )
        .status,
        Availability::Computed
    ));
}

fn native() -> Option<NativeMethodsProvider> {
    let path = std::env::var("N4M_LIBRARY_PATH").ok()?;
    Some(NativeMethodsProvider::load(path).expect("Methods ABI 2.20"))
}

#[test]
fn native_kernels_match_hand_values() {
    let Some(provider) = native() else {
        return;
    };
    // One-way 1-D: SS_term 54 of 58, F 54 on (1,4); b for seed 17 equals the
    // NumPy 2.2.6 golden of the association kernel (same draw convention).
    let one_way = provider
        .permanova(&PermanovaRequest {
            matrix: [1., 2., 3., 7., 8., 9.].iter().map(|v| vec![*v]).collect(),
            term_codes: vec![4, 4, 4, -9, -9, -9],
            strata_codes: None,
            n_permutations: 999,
            seed: 17,
        })
        .unwrap();
    assert!((one_way.ss_term - 54.0).abs() < 1e-10 && (one_way.ss_total - 58.0).abs() < 1e-10);
    assert!((one_way.pseudo_f.unwrap() - 54.0).abs() < 1e-9);
    assert_eq!((one_way.df_term, one_way.df_residual), (1, 4));
    assert_eq!(one_way.n_at_least_observed, 93);
    // Balanced 2x2: SS_term 32, SS_strata 2, SS_res 8 on 5 df, F = 20.
    let crossed = PermanovaRequest {
        matrix: [1., 3., 5., 7., 2., 4., 6., 8.]
            .iter()
            .map(|v| vec![*v])
            .collect(),
        term_codes: vec![0, 0, 1, 1, 0, 0, 1, 1],
        strata_codes: Some(vec![0, 0, 0, 0, 1, 1, 1, 1]),
        n_permutations: 0,
        seed: 1,
    };
    let d = provider.permanova(&crossed).unwrap();
    assert!((d.ss_strata - 2.0).abs() < 1e-10 && (d.pseudo_f.unwrap() - 20.0).abs() < 1e-9);
    let aliased = provider
        .permanova(&PermanovaRequest {
            strata_codes: Some(crossed.term_codes.clone()),
            n_permutations: 999,
            ..crossed.clone()
        })
        .unwrap();
    assert_eq!(aliased.df_term, 0);
    assert!(aliased.p_value.is_none() && aliased.n_permutations_executed == 0);
    // Astra P1-3 boundary: comparing on F (vegan) gives b = 0 for seed 1;
    // the former comparison on B/(B+W) counted 22 (Methods permanova_v1).
    let boundary = provider
        .permdisp(&PermdispRequest {
            matrix: [
                -1001.0,
                -999.0,
                999.0,
                1001.0,
                -1000001.0001,
                -999998.9999,
                999998.9999,
                1000001.0001,
            ]
            .iter()
            .map(|v| vec![*v])
            .collect(),
            group_codes: vec![0, 0, 0, 0, 1, 1, 1, 1],
            n_permutations: 999,
            seed: 1,
        })
        .unwrap();
    assert_eq!(boundary.n_at_least_observed, 0);
    // PERMDISP: distances 1,1 | 4,0,4; F = 15/16; means in code order (3, 7).
    let disp = provider
        .permdisp(&PermdispRequest {
            matrix: [0., 2., 10., 14., 18.].iter().map(|v| vec![*v]).collect(),
            group_codes: vec![7, 7, 3, 3, 3],
            n_permutations: 0,
            seed: 1,
        })
        .unwrap();
    assert!((disp.f.unwrap() - 15.0 / 16.0).abs() < 1e-12);
    assert!((disp.group_mean_distances[0] - 8.0 / 3.0).abs() < 1e-12);
    // Centring in the scaled domain leaves rounding of order eps * max|x|.
    for (d, e) in disp.distances.iter().zip([1.0, 1.0, 4.0, 0.0, 4.0]) {
        assert!((d - e).abs() < 1e-12 * 18.0);
    }
}

/// Between-group SS of `scores` by `labels`, and total SS (closed forms).
fn between_and_total(scores: &[Vec<f64>], labels: &[String]) -> (f64, f64) {
    let k = scores[0].len();
    let n = scores.len() as f64;
    let grand: Vec<f64> = (0..k)
        .map(|j| scores.iter().map(|s| s[j]).sum::<f64>() / n)
        .collect();
    let total: f64 = scores
        .iter()
        .map(|s| (0..k).map(|j| (s[j] - grand[j]).powi(2)).sum::<f64>())
        .sum();
    let mut between = 0.0;
    for level in labels.iter().collect::<BTreeSet<_>>() {
        let rows: Vec<&Vec<f64>> = scores
            .iter()
            .zip(labels)
            .filter(|(_, l)| *l == level)
            .map(|(s, _)| s)
            .collect();
        for j in 0..k {
            let mean = rows.iter().map(|s| s[j]).sum::<f64>() / rows.len() as f64;
            between += rows.len() as f64 * (mean - grand[j]).powi(2);
        }
    }
    (between, total)
}

#[test]
fn native_engine_partitions_balanced_crossed_design_like_closed_forms() {
    let Some(provider) = native() else {
        return;
    };
    let input = crossed(6, false);
    let report = analyze(&input, &provider);
    let scores_metric = find(&report, "structure.pca_scores", None);
    let value = scores_metric.value.as_ref().unwrap();
    let scores: Vec<Vec<f64>> = serde_json::from_value(value["scores"].clone()).unwrap();
    let ids: Vec<String> = serde_json::from_value(value["sample_ids"].clone()).unwrap();
    let level = |id: &str, f: fn(&Sample) -> Option<String>| {
        f(input.samples.iter().find(|s| s.sample_id == id).unwrap()).unwrap()
    };
    let instrument: Vec<String> = ids
        .iter()
        .map(|id| level(id, |s| s.instrument.clone()))
        .collect();
    let campaign: Vec<String> = ids
        .iter()
        .map(|id| level(id, |s| s.campaign.clone()))
        .collect();
    let (ss_i, total) = between_and_total(&scores, &instrument);
    let (ss_c, _) = between_and_total(&scores, &campaign);
    let partition = find(&report, "confounding.variance_partition", None);
    let v = partition.value.as_ref().unwrap();
    assert!((v["ss_total"].as_f64().unwrap() - total).abs() < 1e-9 * total);
    assert_eq!(v["shares_are_not_additive"], true);
    let factors = v["factors"].as_array().unwrap();
    let inst = &factors[0];
    assert_eq!(inst["factor"], "instrument");
    // Balanced crossed cells are orthogonal: unique = marginal R², and the
    // additive residual is SS_T - SS_instrument - SS_campaign on n - 3 df.
    let r2 = ss_i / total;
    assert!((inst["r2_marginal"].as_f64().unwrap() - r2).abs() < 1e-9);
    assert!((inst["r2_unique_given_other_factors"].as_f64().unwrap() - r2).abs() < 1e-9);
    let residual = total - ss_i - ss_c;
    assert!(
        (inst["partial_r2_given_other_factors"].as_f64().unwrap() - ss_i / (ss_i + residual)).abs()
            < 1e-9
    );
    assert!(
        (inst["pseudo_f_given_other_factors"].as_f64().unwrap() - ss_i / (residual / 21.0)).abs()
            < 1e-6 * ss_i
    );
    assert!(
        (inst["pseudo_f_marginal"].as_f64().unwrap() - ss_i / ((total - ss_i) / 22.0)).abs()
            < 1e-6 * ss_i
    );
    let design = find(&report, "confounding.design", None);
    assert_eq!(
        design.value.as_ref().unwrap()["factors"][0]["aliased_with_other_factors"],
        false
    );
    // A 0.6 instrument shift against 0.05 noise: the conditional test is
    // executed within campaign blocks and rejects after Holm.
    let test = find(
        &report,
        "confounding.permanova_conditional_test",
        Some("instrument"),
    );
    let tv = test.value.as_ref().unwrap();
    assert_eq!(tv["n_at_least_observed"], 0);
    assert!((tv["p_value"].as_f64().unwrap() - 0.001).abs() < 1e-15);
    assert_eq!(
        test.parameters["permutation_plan"]["block_sizes"],
        serde_json::json!([12, 12])
    );
    assert!(report
        .findings
        .iter()
        .any(|f| f.rule_id == "confounding.marginal_structure.v1"
            && f.message.contains("instrument")));
    let disp = find(&report, "confounding.dispersion", Some("instrument"));
    assert!(matches!(disp.status, Availability::Computed));
    assert!(capabilities(&provider)
        .iter()
        .any(|c| c.capability_id == "confounding" && c.available && !c.qualified));
}

#[test]
fn native_engine_reports_instrument_equals_campaign_as_aliased() {
    let Some(provider) = native() else {
        return;
    };
    let report = analyze(&crossed(6, true), &provider);
    for factor in ["instrument", "campaign"] {
        let test = find(
            &report,
            "confounding.permanova_conditional_test",
            Some(factor),
        );
        assert_eq!(reason(test), Some("FACTOR_ALIASED_WITH_OTHER_FACTORS"));
        let partition = find(&report, "confounding.variance_partition", None);
        let entry = partition.value.as_ref().unwrap()["factors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["factor"] == factor)
            .unwrap()
            .clone();
        assert_eq!(entry["df_given_other_factors"], 0);
        assert!(entry["r2_unique_given_other_factors"].is_null());
    }
    // Both marginal R² equal the joint cell R²: the same split, never summed.
    let v = find(&report, "confounding.variance_partition", None)
        .value
        .clone()
        .unwrap();
    let joint = v["joint"]["r2_all_factor_cells"].as_f64().unwrap();
    for f in v["factors"].as_array().unwrap() {
        assert!((f["r2_marginal"].as_f64().unwrap() - joint).abs() < 1e-12);
    }
    assert!(report
        .findings
        .iter()
        .any(|f| f.rule_id == "confounding.aliased_factors.v1"));
}

/// examples/confounding.json: instrument × campaign partially crossed (2026
/// holds instrument b only). Goldens are an independent NumPy 2.2.6
/// reproduction on the reported canonical scores: R² from `lstsq` on full
/// one-hot designs, and b from `default_rng(plan seed)` draws (free, within
/// instrument blocks, or of the PERMDISP ANOVA residuals refitted by least
/// squares), counting F_perm >= F_obs - sqrt(eps) as vegan.
#[test]
fn native_example_matches_numpy_reference() {
    let Some(provider) = native() else {
        return;
    };
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/confounding.json"
    );
    let input: QualificationInput =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let report = analyze(&input, &provider);
    let v = find(&report, "confounding.variance_partition", None)
        .value
        .clone()
        .unwrap();
    let close = |a: &Value, b: f64| (a.as_f64().unwrap() - b).abs() <= 1e-9 * b.abs();
    assert!(close(&v["ss_total"], 0.046639992499999984));
    assert!(close(
        &v["joint"]["r2_all_factor_cells"],
        0.7455850255550537
    ));
    let f = v["factors"].as_array().unwrap();
    assert!(close(&f[0]["r2_marginal"], 0.666447291274043));
    assert!(close(
        &f[0]["r2_unique_given_other_factors"],
        0.44649452398604067
    ));
    assert!(close(&f[1]["r2_marginal"], 0.2990887058997705));
    assert!(close(
        &f[1]["r2_unique_given_other_factors"],
        0.07913593861176811
    ));
    for (id, factor, b) in [
        ("confounding.permanova_marginal_test", "instrument", 0),
        ("confounding.permanova_conditional_test", "instrument", 0),
        ("confounding.permanova_marginal_test", "campaign", 35),
        ("confounding.permanova_conditional_test", "campaign", 121),
        ("confounding.permdisp_test", "instrument", 816),
        ("confounding.permdisp_test", "campaign", 456),
    ] {
        let test = find(&report, id, Some(factor));
        assert_eq!(
            test.value.as_ref().unwrap()["n_at_least_observed"],
            b,
            "{id} {factor}"
        );
    }
    let conditional = find(
        &report,
        "confounding.permanova_conditional_test",
        Some("campaign"),
    );
    assert_eq!(
        conditional.parameters["permutation_plan"]["block_sizes"],
        serde_json::json!([8, 12])
    );
    assert_eq!(
        conditional.parameters["permutation_plan"]["seed"],
        "744331944044608949"
    );
    let disp = find(&report, "confounding.dispersion", Some("instrument"));
    assert!(close(
        &disp.value.as_ref().unwrap()["anova_f"],
        0.05310640648929236
    ));
}

/// Adds sample `bridge` linking s00 and s05 (both instrument A, campaign c1)
/// through identities while staying outside the spectral population: bridge
/// shares individual `I` with s05, and is tied to s00 by its physical sample
/// (absent: no observation), a shared reference group (masked: its only row
/// is incomplete) or as an augmentation of s00 (augmented).
fn bridged(how: &str) -> QualificationInput {
    let mut input = crossed(6, false);
    input.samples[5].individual_id = Some("I".into());
    let mut bridge = Sample {
        sample_id: "bridge".into(),
        physical_sample_id: None,
        partition: Partition::Development,
        independence_group: None,
        instrument: Some("A".into()),
        campaign: Some("c1".into()),
        individual_id: Some("I".into()),
        augmentation_parent_id: None,
    };
    let source = &mut input.sources[0];
    match how {
        "absent" => bridge.physical_sample_id = Some("p_s00".into()),
        "masked" => {
            source.observation_ids.push("o_bridge".into());
            source.sample_ids.push("bridge".into());
            source.x.push(vec![None, Some(1.0), Some(1.0)]);
            let mut mask = vec![vec![true; 3]; 24];
            mask.push(vec![false, true, true]);
            source.valid_mask = Some(mask);
            let value = |sample: &str| TargetValue {
                sample_id: sample.into(),
                value: Some(1.0),
                category: None,
                status: ReferenceStatus::Exact,
                reference_id: None,
                reference_group_id: Some("R".into()),
            };
            input.targets = vec![Target {
                target_id: "y".into(),
                kind: TargetKind::Continuous,
                values: vec![value("s00"), value("bridge")],
                unit: None,
            }];
        }
        "augmented" => {
            source.observation_ids.push("o_bridge".into());
            source.sample_ids.push("bridge".into());
            source.x.push(vec![Some(1.0); 3]);
            bridge.augmentation_parent_id = Some("s00".into());
        }
        _ => unreachable!(),
    }
    input.samples.push(bridge);
    input
}

#[test]
fn units_follow_identity_links_through_samples_outside_the_population() {
    // Astra P0-1: s00 -P1- bridge -I- s05 is one unit even when the bridge
    // has no observation, is masked out of the structure, or is augmented.
    for how in ["absent", "masked", "augmented"] {
        let input = bridged(how);
        assert!(validate_input(&input).valid, "{how}");
        let report = analyze(
            &input,
            &Scripted {
                log10_distinct: 5.0,
            },
        );
        let partition = find(&report, "confounding.variance_partition", None);
        assert_eq!(partition.denominators["n_eligible_samples"], 24, "{how}");
        assert_eq!(partition.denominators["n_independence_units"], 23, "{how}");
        assert_eq!(partition.denominators["n_units_analyzed"], 23, "{how}");
        let test = find(
            &report,
            "confounding.permanova_marginal_test",
            Some("instrument"),
        );
        assert!(matches!(test.status, Availability::Computed), "{how}");
        assert_eq!(
            test.parameters["permutation_plan"]["block_sizes"],
            serde_json::json!([23]),
            "{how}"
        );
    }
}

#[test]
fn reference_group_unit_requires_resolved_reference_groups() {
    // Astra P0-2: unit reference_group without any reference group must not
    // run a sample-level plan.
    let mut input = crossed(6, false);
    input.options.independence_unit = IndependenceUnit::ReferenceGroup;
    let report = analyze(
        &input,
        &Scripted {
            log10_distinct: 5.0,
        },
    );
    let partition = find(&report, "confounding.variance_partition", None);
    assert!(matches!(partition.status, Availability::Computed));
    assert_eq!(
        partition.denominators["n_units_without_reference_group"],
        24
    );
    for id in [
        "confounding.permanova_marginal_test",
        "confounding.permanova_conditional_test",
        "confounding.permdisp_test",
    ] {
        let test = find(&report, id, Some("instrument"));
        assert!(matches!(test.status, Availability::NotIdentifiable));
        assert_eq!(reason(test), Some("REFERENCE_GROUP_UNRESOLVED"));
        assert_eq!(
            test.parameters["permutation_plan"]["exchangeable_unit"],
            "reference_group"
        );
    }
    // One unresolved unit is enough to block; resolving all of them pairs
    // samples into 12 reference-group units and runs the tests.
    let target = |n: usize| Target {
        target_id: "y".into(),
        kind: TargetKind::Continuous,
        values: (0..n)
            .map(|i| TargetValue {
                sample_id: format!("s{i:02}"),
                value: Some(i as f64),
                category: None,
                status: ReferenceStatus::Exact,
                reference_id: None,
                reference_group_id: Some(format!("r{}", i / 2)),
            })
            .collect(),
        unit: None,
    };
    input.targets = vec![target(23)];
    let report = analyze(
        &input,
        &Scripted {
            log10_distinct: 5.0,
        },
    );
    let partition = find(&report, "confounding.variance_partition", None);
    assert_eq!(partition.denominators["n_units_without_reference_group"], 1);
    let test = find(
        &report,
        "confounding.permanova_marginal_test",
        Some("instrument"),
    );
    assert_eq!(reason(test), Some("REFERENCE_GROUP_UNRESOLVED"));
    input.targets = vec![target(24)];
    let report = analyze(
        &input,
        &Scripted {
            log10_distinct: 5.0,
        },
    );
    let partition = find(&report, "confounding.variance_partition", None);
    assert_eq!(partition.denominators["n_independence_units"], 12);
    let test = find(
        &report,
        "confounding.permanova_marginal_test",
        Some("instrument"),
    );
    assert!(matches!(test.status, Availability::Computed));
}

#[test]
fn provider_failures_are_errors_unless_a_declared_limit() {
    // Astra P1-5: numerical and internal failures are `error`; only declared
    // limits or absent capabilities are `unsupported`.
    for (error, status) in [
        (ProviderError::from_methods_status(7), Availability::Error),
        (
            ProviderError::internal("INVALID_PERMANOVA_REQUEST"),
            Availability::Error,
        ),
        (
            ProviderError::from_methods_status(10),
            Availability::Unsupported,
        ),
    ] {
        let report = analyze(&crossed(6, false), &Failing(error.clone()));
        let partition = find(&report, "confounding.variance_partition", None);
        assert_eq!(
            serde_json::to_value(&partition.status).unwrap(),
            serde_json::to_value(&status).unwrap()
        );
        assert_eq!(reason(partition), Some(error.reason.as_str()));
    }
    let numerical = ProviderError::from_methods_status(7);
    assert_eq!(numerical.kind, ProviderErrorKind::Numerical);
    assert_eq!(numerical.reason, "METHODS_NUMERICAL_FAILURE");
    assert_eq!(
        ProviderError::from_methods_status(8).reason,
        "METHODS_CONVERGENCE_FAILED"
    );
    assert_eq!(
        ProviderError::from_methods_status(10).kind,
        ProviderErrorKind::Unsupported
    );
    assert_eq!(
        ProviderError::from_methods_status(9).kind,
        ProviderErrorKind::Internal
    );
    let unknown = ProviderError::from_methods_status(99);
    assert_eq!(
        (unknown.kind, unknown.reason.as_str()),
        (ProviderErrorKind::Internal, "METHODS_STATUS_99")
    );
}

#[test]
fn native_numerical_failure_is_reported_as_error() {
    let Some(provider) = native() else {
        return;
    };
    // +-1.7e308 spectra overflow the centred PCA: Methods returns
    // N4M_ERR_NUMERICAL_FAILURE. The WASM test asserts the same status.
    let mut input = crossed(6, false);
    for (i, row) in input.sources[0].x.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = Some(if (i + j) % 2 == 0 { 1.7e308 } else { -1.7e308 });
        }
    }
    let report = analyze(&input, &provider);
    let pca = find(&report, "structure.pca", None);
    assert!(matches!(pca.status, Availability::Error));
    assert_eq!(reason(pca), Some("METHODS_NUMERICAL_FAILURE"));
    let partition = find(&report, "confounding.variance_partition", None);
    assert!(matches!(partition.status, Availability::Error));
}

#[test]
fn freedman_lane_test_permutes_reduced_model_residuals() {
    let report = analyze(
        &crossed(6, false),
        &Scripted {
            log10_distinct: 5.0,
        },
    );
    let test = find(
        &report,
        "confounding.permanova_freedman_lane_test",
        Some("instrument"),
    );
    assert!(matches!(test.status, Availability::Computed));
    let plan = &test.parameters["permutation_plan"];
    assert_eq!(plan["statistic"], "permanova_pseudo_f_given_main_effects");
    assert_eq!(plan["restrictions"], "none_single_block");
    assert_eq!(plan["block_sizes"], serde_json::json!([24]));
    assert!(plan["reduced_model"]
        .as_str()
        .unwrap()
        .starts_with("intercept + main effects of campaign (no interaction)"));
    assert!(plan["null_hypothesis"]
        .as_str()
        .unwrap()
        .contains("no main effect given the additive main effects of campaign"));
    // The within-cells test keeps its own, stricter null and no reduced model.
    let cells = find(
        &report,
        "confounding.permanova_conditional_test",
        Some("instrument"),
    );
    assert!(cells.parameters["permutation_plan"]["null_hypothesis"]
        .as_str()
        .unwrap()
        .contains("no instrument effect at any combination"));
    let partition = find(&report, "confounding.variance_partition", None);
    let entry = &partition.value.as_ref().unwrap()["factors"][0];
    assert_eq!(entry["df_given_other_main_effects"], 1);
    assert_eq!(entry["pseudo_f_given_other_main_effects"], 3.0);
    // Aliased (instrument = campaign): not identifiable, as within cells.
    let report = analyze(
        &crossed(6, true),
        &Scripted {
            log10_distinct: 5.0,
        },
    );
    for factor in ["instrument", "campaign"] {
        let fl = find(
            &report,
            "confounding.permanova_freedman_lane_test",
            Some(factor),
        );
        assert!(matches!(fl.status, Availability::NotIdentifiable));
        assert_eq!(reason(fl), Some("FACTOR_ALIASED_WITH_OTHER_FACTORS"));
    }
}

fn saturated_reasons(provider: &impl MethodsProvider) -> [Option<String>; 2] {
    // Every unit its own campaign: the reduced model (intercept + campaign)
    // reproduces the data, so instrument has no residual variation to test.
    let mut input = crossed(6, false);
    for (i, s) in input.samples.iter_mut().enumerate() {
        s.campaign = Some(format!("c{i:02}"));
    }
    let first = analyze(&input, provider);
    // Three units, one per occupied cell of a connected 2 x 2 design: the
    // additive full design has rank 3 = n, no residual df.
    let input = dataset(&[
        ("A", "c1", vec![1.0, 2.0, 3.0]),
        ("B", "c1", vec![2.0, 1.0, 3.5]),
        ("B", "c2", vec![1.5, 2.5, 2.0]),
    ]);
    let second = analyze(&input, provider);
    [first, second].map(|report| {
        let fl = find(
            &report,
            "confounding.permanova_freedman_lane_test",
            Some("instrument"),
        );
        assert!(matches!(fl.status, Availability::NotIdentifiable));
        fl.reason_code.clone()
    })
}

#[test]
fn freedman_lane_saturated_designs_are_not_identifiable() {
    let expected = [
        Some("REDUCED_MODEL_SATURATED".to_string()),
        Some("SATURATED_DESIGN".to_string()),
    ];
    assert_eq!(
        saturated_reasons(&Scripted {
            log10_distinct: 5.0
        }),
        expected
    );
    if let Some(provider) = native() {
        assert_eq!(saturated_reasons(&provider), expected);
    }
}

#[test]
fn native_freedman_lane_matches_independent_refit_oracle() {
    let Some(provider) = native() else {
        return;
    };
    // examples/confounding.json; goldens from an independent NumPy 2.2.6
    // Freedman-Lane oracle on the reported scores: lstsq refit of
    // fitted_reduced + E[default_rng(plan seed).permutation(n)] on both
    // one-hot designs, F_perm >= F_obs - sqrt(eps).
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/confounding.json"
    );
    let input: QualificationInput =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let report = analyze(&input, &provider);
    let partition = find(&report, "confounding.variance_partition", None);
    for entry in partition.value.as_ref().unwrap()["factors"]
        .as_array()
        .unwrap()
    {
        // With one other factor the main-effect and within-cells partial
        // statistics coincide.
        let a = entry["pseudo_f_given_other_main_effects"].as_f64().unwrap();
        let b = entry["pseudo_f_given_other_factors"].as_f64().unwrap();
        assert!((a - b).abs() <= 1e-10 * b);
    }
    for (factor, b) in FREEDMAN_LANE_GOLDENS {
        let test = find(
            &report,
            "confounding.permanova_freedman_lane_test",
            Some(factor),
        );
        assert_eq!(
            test.value.as_ref().unwrap()["n_at_least_observed"],
            b,
            "{factor}"
        );
    }
}

/// Freedman-Lane counts b on examples/confounding.json (NumPy 2.2.6 oracle).
const FREEDMAN_LANE_GOLDENS: [(&str, usize); 2] = [("instrument", 0), ("campaign", 101)];
