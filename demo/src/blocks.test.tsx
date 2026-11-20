import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Locale } from "nirs4all-ui/lab";
import { buildQualificationReportView, type EngineReport } from "nirs4all-ui/qualification";
// Synthetic reports following the preflight 0.1.0 Rust contract (one block per capability,
// merged; plus the probe case whose R² and skill exceed the double range). Shared with the
// nirs4all-ui tests, they fix every layout case; engine.integration.test.tsx runs the real engine.
import reportJson from "./fixtures/preflight-0.1.0-report.json";
import extendedJson from "./fixtures/preflight-0.1.0-probe-extended.json";
import { AssociationSection, ClusteringSection, ConfoundingSection, DomainShiftSection, DuplicatesSection, ProbeSection, SensitivitySection, SpectralQualitySection, presentSections } from "./Blocks";
import { buildChecks } from "./checks";
import { translate, type TextKey } from "./i18n";
import type { EngineInput } from "./input";
import { RepeatSection, StructureSection, type Scope } from "./Sections";
import { DataView } from "./DataView";
import { MetadataRoles } from "./Workspace";

const view = buildQualificationReportView(reportJson as unknown as EngineReport);
const extended = buildQualificationReportView(extendedJson as unknown as EngineReport);
const axis = Array.from({ length: 12 }, (_, i) => 1100 + (i * 1400) / 11);
const input: EngineInput = {
  schema_version: 1,
  data_origin: "synthetic",
  sources: [{ source_id: "nir", observation_ids: [], sample_ids: [], x: [], axis, axis_unit: "nm" }],
  samples: [],
  targets: [],
  options: { independence_unit: "sample" },
};
const scope = (locale: Locale = "fr", over: Partial<Scope> = {}): Scope => ({
  t: (k: TextKey) => translate(k, locale),
  locale,
  view,
  input,
  sourceId: "nir",
  targetId: "protein",
  ...over,
});
const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("0.1.0 capability sections", () => {
  it("navigation lists only the blocks present in the report", () => {
    expect(presentSections(scope()).map((s) => s.id)).toEqual(["s-sensitivity", "s-duplicates", "s-clustering", "s-confounding", "s-shift", "s-association", "s-probe"]);
    const old = buildQualificationReportView({ ...(reportJson as unknown as EngineReport), metrics: [] });
    expect(presentSections(scope("fr", { view: old }))).toEqual([]);
    expect(html(<ClusteringSection {...scope("fr", { view: old })} />)).toBe("");
    expect(html(<ProbeSection {...scope("fr", { view: old })} />)).toBe("");
  });

  it("SNV and balanced-repeat sensitivity", () => {
    const out = html(<SensitivitySection {...scope("en")} />);
    expect(out).toContain("Structure sensitivity to SNV");
    expect(out).toContain("SNV effective dimension");
    expect(out).toContain("Repeats kept r*");
    expect(html(<SensitivitySection {...scope("en", { sourceId: "vis" })} />)).toContain("SNV_VARIANCE_NOT_NUMERICALLY_RESOLVED");
  });

  it("near duplicates, cross-partition leakage and reference conflicts", () => {
    const out = html(<DuplicatesSection {...scope("fr")} />);
    expect(out).toContain("Quasi-doublons développement ↔ test");
    expect(out).toContain('data-tone="critical"');
    expect(out).toContain("REFERENCE_CONTRADICTION_TOLERANCE_NOT_DECLARED");
    expect(out).toContain("s07");
  });

  it("clustering: verdict, criteria checklist and partition table", () => {
    const out = html(<ClusteringSection {...scope("fr")} />);
    expect(out).toContain("Partition incertaine");
    expect(out).toContain("Stabilité (paramètres constants)");
    expect(out).toContain('data-status="attention"');
    expect(out).toContain("Bruit");
    expect(html(<ClusteringSection {...scope("fr", { sourceId: "vis" })} />)).toContain("FEWER_THAN_TWO_MIN_CLUSTER_SIZES");
  });

  it("confounding: Holm decisions in text, aliased factors explained", () => {
    const out = html(<ConfoundingSection {...scope("en")} />);
    expect(out).toContain("H0 rejected");
    expect(out).toContain("Partial (Freedman–Lane)");
    expect(out).toContain("Units per crossing instrument × campaign");
    const mir = html(<ConfoundingSection {...scope("en", { sourceId: "mir" })} />);
    expect(mir).toContain("aliased with campaign");
    expect(mir).toContain("FACTOR_ALIASED_WITH_OTHER_FACTORS");
  });

  it("domain shift: one matrix per factor, the X-only audit apart", () => {
    const out = html(<DomainShiftSection {...scope("fr")} />);
    expect(out).toContain("Facteur instrument");
    expect(out).toContain("Audit développement ↔ test réservé (X seulement)");
    expect(out).toContain("79 %");
    expect(out).toContain("RETAINED_TEST_Y_NEVER_READ");
    expect(out).toContain("SINGLE_DOMAIN_LEVEL");
  });

  it("metadata associations filtered on the selected target", () => {
    const out = html(<AssociationSection {...scope("en")} />);
    expect(out).toContain("temperature (degC)");
    expect(out).toContain("0.007");
    expect(out).not.toContain("grade ·");
    expect(html(<AssociationSection {...scope("en", { targetId: "grade" })} />)).toContain("PERMUTATION_RESOLUTION_INSUFFICIENT");
  });

  it("validation probe: RMSE against the training mean, scaled R²/skill printed exactly", () => {
    const out = html(<ProbeSection {...scope("en")} />);
    expect(out).toContain("Out-of-fold RMSE");
    expect(out).toContain("0.409");
    expect(out).toContain("training mean 2.28 %");
    expect(out).toContain("the model beats the mean");
    const big = html(<ProbeSection {...scope("en", { view: extended })} />);
    expect(big).toContain("−6.683 × 10³⁰⁶");
    expect(big).toContain("−5.112 × 10³⁰⁶");
    expect(big).toContain("no gain over the mean");
    expect(big).not.toMatch(/NaN|Infinity/);
    expect(html(<ProbeSection {...scope("en", { view: extended, targetId: "moisture" })} />)).toContain("FEWER_THAN_THREE_INDEPENDENT_GROUPS");
  });

  it("repeatability shows repeat counts and the noise proxy next to the profile", () => {
    const out = html(<RepeatSection {...scope("en")} />);
    expect(out).toContain("Technical repeats per physical sample");
    expect(out).toContain("Pooled noise proxy · A · 2026-03");
    expect(out).toContain("NO_BALANCED_BAND");
  });

  it("labels the actual table subsets exported from capped DOM tables", () => {
    const metric = view.metrics.find((m) => m.id === "structure.pca_scores" && m.sourceId === "nir")!;
    const ids = Array.from({ length: 501 }, (_, i) => `unit-${i}`);
    const pcaView = { ...view, metrics: [{ ...metric, value: { sample_ids: ids, scores: ids.map((_, i) => [i, i + 1]) } }] };
    expect(html(<StructureSection {...scope("en", { view: pcaView })} />)).toContain("first 500 of 501 units</caption>");

    const scans = ids.slice(0, 21);
    const qualityView = { ...view, metrics: ["pca_t2", "pca_q"].flatMap((name) => [
      { ...metric, id: `intrinsic.pca.${name}`, value: { sample_ids: scans, observation_ids: scans, values: scans.map(() => 2) } },
      { ...metric, id: `intrinsic.pca.${name}_p95`, value: 1 },
    ]) };
    expect(html(<SpectralQualitySection {...scope("en", { view: qualityView })} />)).toContain("first 20 of 21 atypical spectra</caption>");

    const sampleIds = ids.slice(0, 41);
    const tableInput: EngineInput = { ...input,
      samples: sampleIds.map((sample_id) => ({ sample_id, partition: "development" })),
      sources: [{ ...input.sources[0]!, observation_ids: sampleIds, sample_ids: sampleIds, x: sampleIds.map(() => axis.map(() => 1)) }],
    };
    const out = html(<DataView t={scope("en").t} locale="en" input={tableInput} sourceId="nir" targetId={null} report={null} />);
    expect(out).toContain("first 40 of 41 filtered samples (41 total), sorted by sampleId ascending</caption>");
  });

  it("summarises population-relative events by band", () => {
    const band = (id: string, counts: number[]) => ({ metric_id: `intrinsic.events.${id}`, protocol_version: "spectral-population-events.v1", status: "computed", reason_code: null, scope: "source", view_id: "native:observations", population_id: "development_real", source_id: "nir", value: { axis, counts, evaluated: axis.map(() => 30) } });
    const events = buildQualificationReportView({ ...(reportJson as unknown as EngineReport), metrics: [band("global_spike_band_counts", axis.map((_, i) => (i === 5 ? 1 : 0))), band("global_jump_band_counts", axis.map(() => 0))] } as unknown as EngineReport);
    const out = html(<SpectralQualitySection {...scope("en", { view: events })} />);
    expect(out).toContain("Spike and jump counts by band");
    expect(out).toContain("atypical relative to the other spectra at the same band");
  });

  it("caps metadata with many levels and says where repeats come from", () => {
    const sampleIds = Array.from({ length: 24 }, (_, i) => `s${i}`);
    const many: EngineInput = { ...input,
      samples: sampleIds.map((sample_id) => ({ sample_id, partition: "development" })),
      sources: [{ ...input.sources[0]!, observation_ids: sampleIds, sample_ids: sampleIds, x: sampleIds.map(() => axis.map(() => 1)) }],
      metadata: { columns: [{ name: "field", kind: "categorical" }], values: Object.fromEntries(sampleIds.map((id, i) => [id, { field: `plot ${i % 20}` }])) },
    };
    const out = html(<DataView t={scope("en").t} locale="en" input={many} sourceId="nir" targetId={null} report={null} />);
    expect(out).toContain("Show all 20 levels");
    expect(out).toContain("each spectrum is its own sample.");
    // Two scans of one sample, grouped by the detected identifier without a declaration.
    const grouped: EngineInput = { ...many, sources: [{ ...many.sources[0]!, observation_ids: [...sampleIds, "extra"], sample_ids: [...sampleIds, "s0"], x: [...sampleIds, "s0"].map(() => axis.map(() => 1)) }] };
    expect(html(<DataView t={scope("en").t} locale="en" input={grouped} sourceId="nir" targetId={null} report={null} />)).toContain("grouped as repeated acquisitions of undeclared type");
    const declared = html(<DataView t={scope("en").t} locale="en" input={many} sourceId="nir" targetId={null} report={null} repetition={{ column: "Sample_ID", type: "rescan" }} />);
    expect(declared).toContain("grouped by the declared column Sample_ID");
    expect(declared).not.toContain("undeclared type");
  });

  it.each([3, 12])("renders checkable metadata roles for %i columns", (count) => {
    const columns = Array.from({ length: count }, (_, i) => ({ name: `m${i}`, kind: "categorical" }));
    const out = html(<MetadataRoles columns={columns} roles={{ m0: "identifier", m1: "excluded" }} onRoles={() => undefined} />);
    expect(out).not.toContain("<select");
    expect(out.match(/type="checkbox"/g)).toHaveLength(count * 3);
    expect(out.match(/checked=""/g)).toHaveLength(count);
    expect(out).toContain('aria-label="Group / covariate"');
    expect(out).toContain('aria-label="Identifier"');
    expect(out).toContain('aria-label="Excluded"');
    expect(out).toContain("Select shown");
    expect(out).toContain("Clear shown");
  });

  it("control points cover the new blocks", () => {
    const s = scope("en");
    const checks = buildChecks(view, input, "nir", "protein", s.t, "en");
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(byId["quasi-leak"]).toBe("critical");
    expect(byId.conflicts).toBe("attention");
    expect(byId.aliased).toBe("ok");
    expect(byId.shift).toBe("attention");
    expect(byId["probe-protein-pls"]).toBe("ok");
    const big = buildChecks(extended, input, "nir", "protein", s.t, "en");
    expect(big.find((c) => c.id === "probe-protein-pls")).toMatchObject({ status: "attention" });
    expect(String(big.find((c) => c.id === "probe-protein-pls")?.detail)).toContain("× 10³⁰⁶");
  });
});
