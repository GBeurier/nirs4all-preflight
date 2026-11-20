import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildQualificationReportView, type EngineReport } from "nirs4all-ui/qualification";
import reportJson from "../../fixtures/preflight-0.1.0-report.json";
import { translate, type TextKey } from "../../i18n";
import type { EngineInput } from "../../input";
import type { Scope } from "../../Sections";
import { CharacterizationOverview } from "./CharacterizationOverview";
import { SpectralQualityMap, hasQualityMap } from "./SpectralQualityMap";
import { PhaseHeading } from "./PhaseHeading";
import { CharacterizationProvider } from "./selection";
import { overviewModel, withPreprocessing } from "./model";
import { qualityMapInputs } from "./mapInputs";
import { buildTracks } from "./tracks";

const N = 20;
const ids = Array.from({ length: N }, (_, i) => `o${i}`);
// The fixture's repeatability and noise-proxy metrics are defined on 12 bands of source "nir".
const axis = Array.from({ length: 12 }, (_, i) => 1100 + (i * 1400) / 11);
const metric = (id: string, value: unknown, status = "computed") => ({ metric_id: `intrinsic.${id}`, protocol_version: "test.v1", status, reason_code: status === "computed" ? null : "TEST_REASON", scope: "source", view_id: "native:observations", population_id: "development_real", source_id: "nir", value });
const signal = (id: string, values: (number | null)[], summary?: { median: number; p95: number }) => [
  metric(id, { sample_ids: ids, observation_ids: ids, values }),
  ...(summary ? [metric(`${id}_median`, summary.median), metric(`${id}_p95`, summary.p95)] : []),
];
const spikeCounts = ids.map((_, i) => (i === 0 ? 12 : i < 4 ? 1 : 0));
const jumpCounts = ids.map((_, i) => (i === 0 || i === 5 || i === 6 ? 2 : 0));
const spikeBand = axis.map((_, i) => (i >= 4 && i <= 6 ? 4 : i === 10 ? 1 : 0));
const intrinsic = [
  ...signal("events.spike_count", spikeCounts),
  ...signal("events.jump_count", jumpCounts),
  metric("events.global_spike_count", 15),
  metric("events.global_jump_count", 6),
  metric("events.global_spike_band_counts", { axis, counts: spikeBand, evaluated: axis.map(() => N) }),
  metric("events.global_jump_band_counts", { axis, counts: axis.map(() => 0), evaluated: axis.map(() => N) }),
  ...signal("noise.signal_noise_db", ids.map((_, i) => (i === 19 ? 15 : 45 + (i % 5))), { median: 47, p95: 49 }),
  ...signal("noise.noise_sigma", ids.map(() => 0.01)),
  ...signal("noise.signal_mean_abs", ids.map((_, i) => 16 + (i % 3)), { median: 16.1, p95: 18 }),
  ...signal("reference.rms", ids.map((_, i) => (i === 0 ? 120 : 10 + i)), { median: 20, p95: 44 }),
];
const measurement = (reportJson as unknown as EngineReport).metrics.filter((m) => m.metric_id.startsWith("measurement.") && m.source_id === "nir");
const viewOf = (metrics: unknown[]) => buildQualificationReportView({ ...(reportJson as unknown as EngineReport), metrics } as unknown as EngineReport);
const input: EngineInput = {
  schema_version: 1,
  data_origin: "synthetic",
  sources: [{ source_id: "nir", observation_ids: ids, sample_ids: ids, x: ids.map((_, r) => axis.map((_, j) => 10 + r * 0.5 + Math.sin(j / 2))), axis, axis_unit: "nm", signal_unit: "AU" }],
  samples: ids.map((sample_id) => ({ sample_id, partition: "development" })),
  targets: [],
  options: { independence_unit: "sample" },
};
const scope = (metrics: unknown[], over: Partial<Scope> = {}): Scope => ({ t: (k: TextKey) => translate(k, "en"), locale: "en", view: viewOf(metrics), input, sourceId: "nir", targetId: null, ...over });
const html = (node: React.ReactElement) => renderToStaticMarkup(<CharacterizationProvider>{node}</CharacterizationProvider>);

describe("CharacterizationOverview", () => {
  const withEverything = scope([...intrinsic, ...measurement]);

  it("shows the three dimensions as separate cards with their denominators and no global score", () => {
    const out = html(<CharacterizationOverview {...withEverything} />);
    // Compact cards of the page mockup: Spikes % (with its bar), SNR dB with % noise, Diversity relative P95 ×.
    expect(out).toContain(">Spikes<");
    expect(out).toContain(">SNR<");
    expect(out).toContain(">Diversity<");
    expect(out).toContain('class="ov-kpi-bar"');
    expect(out).toContain("Relative P95");
    expect(out).toContain("20%"); // 4 of 20 spectra with flagged isolated peaks
    expect(out).toContain("4 of 20 spectra");
    expect(out).toContain("47"); // median SNR (dB)
    expect(out).toContain("2.73"); // relative P95 distance (44 / 16.1)
    expect(out).not.toMatch(/overall (quality )?score/i);
  });

  it("lists interpretive statements ordered by dimension and links each card to its detailed panel", () => {
    const model = overviewModel(withEverything);
    const order = model.comments.map((c) => c.dimension);
    const rank = (d: string) => ["integrity", "noise", "diversity", "repeatability", "cross"].indexOf(d);
    expect(order).toEqual([...order].sort((a, b) => rank(a) - rank(b)));
    expect(model.comments.some((c) => c.dimension === "integrity")).toBe(true);
    expect(new Set(model.comments.map((c) => c.text)).size).toBe(model.comments.length);
    const out = html(<CharacterizationOverview {...withEverything} />);
    expect(out).toContain('href="#s-quality"');
    expect(out).toContain('href="#s-repeat"');
  });

  it("states that repeatability is unavailable, with a settings shortcut, instead of showing a zero", () => {
    const out = html(<CharacterizationOverview {...scope(intrinsic)} onOpenSettings={() => undefined} />);
    expect(out).toContain("no technical replicate groups have been declared");
    expect(out).toContain("Open the dataset settings");
    const model = overviewModel(scope(intrinsic));
    expect(model.repeatability?.status).toBe("unavailable");
  });

  it("explains each card that has no computed signal, without inventing numbers", () => {
    const out = html(<CharacterizationOverview {...scope([])} />);
    expect(out).toContain("Not computed: intrinsic spectral signatures were not requested");
    expect(out).toContain("Not computed: the distance to the mean spectrum was not requested");
    // the only statement left is the repeatability one, from the owner module's own rule
    expect(out).toContain("Technical repeatability cannot be assessed because no replicate groups have been declared.");
    expect(overviewModel(scope([])).comments).toHaveLength(1);
  });

  it("renders nothing without a selected source", () => {
    expect(html(<CharacterizationOverview {...withEverything} sourceId={null} />)).toBe("");
  });
});

describe("preprocessing state from the explorer", () => {
  const model = overviewModel(scope([...intrinsic, ...measurement]));
  const profile = (over: Partial<NonNullable<Parameters<typeof withPreprocessing>[1]>> = {}) => ({ label: "SG(11,2)", fineScaleReductionPercent: 60, distortion: axis.map(() => 0.1), interval: null, ...over });
  it("adds the distortion statement once a pipeline reduces fine-scale variation and distorts the spectra", () => {
    expect(withPreprocessing(model, null)).toBe(model.comments);
    const comments = withPreprocessing(model, profile());
    expect(comments.some((c) => c.id === "cross.preprocessing-distortion")).toBe(true);
    expect(comments.length).toBe(model.comments.length + 1);
  });
  it("adds nothing when the explorer withholds the reduction", () => {
    expect(withPreprocessing(model, profile({ fineScaleReductionPercent: null })).some((c) => c.id === "cross.preprocessing-distortion")).toBe(false);
  });
});

describe("SpectralQualityMap", () => {
  const withEverything = scope([...intrinsic, ...measurement]);

  it("reads every drawable track from the engine report, aligned with the source axis", () => {
    const inputs = qualityMapInputs(withEverything)!;
    expect(inputs.axis).toEqual(axis);
    expect(inputs.observations).toBe(N);
    expect(inputs.spikes!.counts).toEqual(spikeBand);
    const tracks = buildTracks(inputs);
    const spikes = tracks.find((t) => t.id === "spike_frequency")!;
    expect(spikes.values.map((v) => (v === null ? null : Number(v.toFixed(3))))).toEqual(spikeBand.map((c) => c / N));
    expect(tracks.find((t) => t.id === "noise_proxy")!.unavailable).toBeNull();
    expect(tracks.find((t) => t.id === "distortion")!.unavailable).toMatch(/preprocessing explorer/);
  });

  it("draws no track when the report has no local diagnostic", () => {
    const tracks = buildTracks(qualityMapInputs(scope([]))!);
    expect(tracks.filter((t) => !t.unavailable)).toEqual([]);
    expect(hasQualityMap(scope([]))).toBe(false);
    expect(html(<SpectralQualityMap {...scope([])} />)).toBe("");
  });

  it("is present when a local diagnostic exists and absent when the source has no spectra or axis", () => {
    expect(hasQualityMap(withEverything)).toBe(true);
    const empty: EngineInput = { ...input, sources: [{ ...input.sources[0]!, x: [], observation_ids: [], sample_ids: [] }] };
    expect(hasQualityMap(scope([], { input: empty }))).toBe(false);
    expect(html(<SpectralQualityMap {...scope([], { input: empty })} />)).toBe("");
    const noAxis: EngineInput = { ...input, sources: [{ ...input.sources[0]!, axis: [], x: [] }] };
    expect(qualityMapInputs(scope([], { input: noAxis }))).toBeNull();
    expect(hasQualityMap(scope([], { sourceId: "other" }))).toBe(false);
  });

  it("gives every track its own legend, states denominators, provenance and the not-drawn reasons", () => {
    const out = html(<SpectralQualityMap {...scope(intrinsic)} />);
    expect(out).toContain("Spectral quality map");
    expect(out).toContain("Track legends and scales");
    expect(out).toContain("Isolated peak frequency");
    expect(out).toContain("divided by 20 spectra");
    expect(out).toContain("Tracks not drawn");
    expect(out).toContain("no technical replicate groups have been declared");
    expect(out).toContain("Not computed: open the preprocessing explorer");
    expect(out).toContain("not a mechanism for rejecting wavelengths");
    expect(out).toContain("Regions to investigate (manual)");
  });

  it("offers the data table alternative of the tracks with class labels next to categorical values", () => {
    const out = html(<SpectralQualityMap {...withEverything} />);
    expect(out).toContain("<table");
    expect(out).toMatch(/Repeatability ICC — class|Noise-to-diversity ratio/);
  });

  it("does not modify the input", () => {
    const before = JSON.stringify(input);
    html(<SpectralQualityMap {...withEverything} />);
    html(<CharacterizationOverview {...withEverything} />);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("PhaseHeading", () => {
  it("renders an anchor group with its step index", () => {
    const out = renderToStaticMarkup(<PhaseHeading id="s-detailed" index="2 / 4" title="Detailed spectral diagnostics" lead="Profiles." />);
    expect(out).toContain('id="s-detailed"');
    expect(out).toContain("2 / 4");
  });
});
