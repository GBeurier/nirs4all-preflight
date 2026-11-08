import { describe, expect, it } from "vitest";
import { buildEngineInput, defaultConfig, defaultMetadataRole } from "./input";
import { syntheticInput } from "./synthetic";
import { sameConfig } from "./Workspace";
import { pcaPoints, targetColorValues, varyingMetadata } from "./views";
import { metricKey, selectedReport } from "./export";
import { buildQualificationReportView, type EngineReport, type PcaStructure } from "nirs4all-ui/qualification";

const pca: PcaStructure = { sourceId: "synthetic_nir", viewId: "canonical", sampleIds: ["s01", "s02"], aggregationKeys: ["a", "b"], scores: [[1, 2], [3, 4]], eigenvalues: [2, 1], totalVariance: 3, retainedFraction: 1, effectiveDimension: 1.8 };

describe("analysis controls", () => {
  it("preserves metadata and identity fields while recording roles for the engine", () => {
    const input = syntheticInput("pitfalls");
    const config = defaultConfig(input);
    expect(config.metadataRoles.id_sample).toBe("identifier");
    const built = buildEngineInput(input, { ...config, metadataRoles: { ...config.metadataRoles, campaign: "excluded" } });
    expect(built.metadata).toBe(input.metadata);
    expect(built.samples).toBe(input.samples);
    expect(built.options.metadata_roles?.campaign).toBe("excluded");
    expect(varyingMetadata(built).map((c) => c.name)).toEqual(["instrument", "batch"]);
  });

  it("keeps repeated ID-like factors analytical and respects explicit roles", () => {
    const input = syntheticInput("clean");
    input.metadata = { columns: [{ name: "batch_id", kind: "categorical" }], values: Object.fromEntries(input.samples.map((sample, i) => [sample.sample_id, { batch_id: `batch-${i % 3}` }])) };
    expect(defaultConfig(input).metadataRoles.batch_id).toBe("analysis");
    for (const [i, sample] of input.samples.entries()) input.metadata.values[sample.sample_id]!.batch_id = i < 2 ? null : `unique-${i}`;
    expect(defaultConfig(input).metadataRoles.batch_id).toBe("identifier");
    expect(defaultMetadataRole(input, "unobserved_id")).toBe("analysis");
    input.options.metadata_roles = { batch_id: "excluded" };
    expect(defaultConfig(input).metadataRoles.batch_id).toBe("excluded");
  });

  it("sends either inferred or declared tolerance and preserves declared view and context", () => {
    const input = syntheticInput("clean");
    input.options.quasi_duplicates = { tolerance: 0.02, view: "snv", context: "source" };
    const config = defaultConfig(input);
    expect(config.quasiToleranceFromRepeats).toBe(false);
    const inferred = buildEngineInput(input, { ...config, quasiToleranceFromRepeats: true });
    expect(inferred.options.quasi_tolerance_from_repeats).toBe(true);
    expect(inferred.options).not.toHaveProperty("quasi_duplicates");
    const declared = buildEngineInput(input, config);
    expect(declared.options.quasi_duplicates).toEqual(input.options.quasi_duplicates);
    expect(declared.options.quasi_tolerance_from_repeats).toBe(false);
    expect(buildEngineInput(input, { ...config, quasiTolerance: null }).options).not.toHaveProperty("quasi_duplicates");
    expect(input.options.quasi_duplicates).toEqual({ tolerance: 0.02, view: "snv", context: "source" });
  });

  it("ignores remembered tolerance in inferred settings without losing the declared value", () => {
    const input = syntheticInput("clean");
    const config = { ...defaultConfig(input), quasiTolerance: 0.02, quasiToleranceFromRepeats: true };
    const analyzed = buildEngineInput(input, config);
    const completed = defaultConfig(analyzed);
    expect(analyzed.options).not.toHaveProperty("quasi_duplicates");
    expect(completed.quasiTolerance).toBeNull();
    expect(sameConfig(config, completed)).toBe(true);
    expect(sameConfig(completed, config)).toBe(true);
    expect(config.quasiTolerance).toBe(0.02);
    expect(buildEngineInput(input, { ...config, quasiToleranceFromRepeats: false }).options.quasi_duplicates?.tolerance).toBe(0.02);
  });

  it("compares declared tolerance when it is active", () => {
    const config = { ...defaultConfig(syntheticInput("clean")), quasiTolerance: 0.02, quasiToleranceFromRepeats: false };
    expect(sameConfig(config, { ...config })).toBe(true);
    expect(sameConfig(config, { ...config, quasiTolerance: 0.03 })).toBe(false);
    expect(sameConfig({ ...config, quasiTolerance: 0.03 }, config)).toBe(false);
    expect(sameConfig(config, { ...config, quasiTolerance: null })).toBe(false);
  });

  it("still compares tolerance mode and other settings during inference", () => {
    const config = { ...defaultConfig(syntheticInput("clean")), quasiTolerance: 0.02, quasiToleranceFromRepeats: true };
    expect(sameConfig(config, { ...config, quasiToleranceFromRepeats: false })).toBe(false);
    expect(sameConfig({ ...config, quasiToleranceFromRepeats: false }, config)).toBe(false);
    expect(sameConfig(config, { ...config, seed: "42" })).toBe(false);
    expect(sameConfig(config, { ...config, families: { ...config.families, clustering: false } })).toBe(false);
    expect(sameConfig(config, { ...config, metadataRoles: { ...config.metadataRoles, campaign: "excluded" } })).toBe(false);
  });

  it("colours categorical targets as groups, excludes contradictory labels and never reads test Y", () => {
    const input = syntheticInput("clean");
    input.targets = [{ target_id: "class", kind: "categorical", values: [
      { sample_id: "s01", category: "present", status: "exact" },
      { sample_id: "s02", category: "absent", status: "exact" },
      { sample_id: "s25", category: "test-secret", status: "exact" },
    ] }];
    const points = pcaPoints(input, pca, 0, 1, "target", "class");
    expect(points.map((p) => p.group)).toEqual(["present", "absent"]);
    expect(points.every((p) => p.value === undefined)).toBe(true);
    expect([...targetColorValues(input, "class").values()]).not.toContain("test-secret");
    input.targets[0]!.values.push({ sample_id: "s01", category: "absent", status: "exact" });
    expect(pcaPoints(input, pca, 0, 1, "target", "class")[0]!.group).toBeNull();
  });

  it("colours repeated PCA units only when their member references agree", () => {
    const input = syntheticInput("clean");
    const first = input.samples[0]!;
    input.samples.push({ ...first, sample_id: "extra" });
    input.targets[0]!.values.push({ sample_id: "extra", value: input.targets[0]!.values[0]!.value ?? null, status: "exact" });
    expect(pcaPoints(input, pca, 0, 1, "target", "concentration")[0]!.value).toBe(input.targets[0]!.values[0]!.value);
    input.targets[0]!.values.at(-1)!.value = 999;
    expect(pcaPoints(input, pca, 0, 1, "target", "concentration")[0]!.value).toBeNull();
  });

  it("applies export selection to metrics and evidence-backed findings without mutating the report", () => {
    const metric = { metric_id: "measurement.repeatability_sd", protocol_version: "v1", status: "computed", scope: "source", source_id: "nir", view_id: "native", population_id: "calibration", value: 1 };
    const report: EngineReport = { schema_version: 1, engine_version: "v", protocol_bundle_version: "v", profile_status: "exploratory", capabilities: [], metrics: [metric, { ...metric, parameters: { instrument: "second" } }, { ...metric, metric_id: "analysis.selection", value: { metadata_roles: { batch_id: "analysis" } } }], findings: [{ rule_id: "repeat", severity: "warning", confidence: "unknown", evidence: [metric.metric_id], message: "Review repeats", action: "Inspect" }] };
    const keys = buildQualificationReportView(report).metrics.map(metricKey);
    const selected = selectedReport(report, new Set([keys[0]!]));
    expect(selected.metrics).toHaveLength(2);
    expect(selected.metrics[1]).toBe(report.metrics[2]);
    expect(selectedReport(report, new Set()).metrics).toEqual([report.metrics[2]]);
    expect(selected.limitations?.join(" ")).toContain("2 of 3");
    expect(selected.findings).toHaveLength(0);
    expect(selected.status).toBe("partial");
    expect(report.metrics).toHaveLength(3);
  });
});
