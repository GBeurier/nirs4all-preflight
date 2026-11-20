import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildQualificationReportView, extractIntrinsic, type EngineReport } from "nirs4all-ui/qualification";
import reportJson from "../../fixtures/preflight-0.1.0-report.json";
import { translate, type TextKey } from "../../i18n";
import type { EngineInput } from "../../input";
import type { Scope } from "../../Sections";
import { diversityComments, eventComments, snrComments } from "./comments";
import { INSTRUMENT_REFERENCES, NON_CONVERTIBLE_REFERENCES, referenceDb } from "./instruments";
import { NoiseBenchmarkCard, benchmarkPosition, flaggedBins } from "./blocks";
import { NOISE_BENCHMARK } from "./noiseBenchmark";
import { BoxPlotRows, DualScaleGauge } from "../shared/charts";
import { SNR_BANDS } from "../shared/derive";
import { addIllustrativeNoise, gaussianSequence, medianSnrSpectrum, bandEnvelope, completeMatrix, contrastSnr, countHistogram, diversityStats, eventOverlap, eventPattern, eventRegions, eventStats, eventThreshold, snrStats, topKOverlap, valueHistogram } from "./model";
import { DiversityPanel, IntegrityPanel, SnrPanel, diversitySummary, integritySummary, snrSummary } from "./index";
import { makeFmt } from "./format";

const f = makeFmt("en");
const N = 20;
const ids = Array.from({ length: N }, (_, i) => `o${i}`);
const axis = Array.from({ length: 40 }, (_, i) => 1000 + 10 * i);

const metric = (id: string, value: unknown, status = "computed") => ({ metric_id: `intrinsic.${id}`, protocol_version: "test.v1", status, reason_code: status === "computed" ? null : "TEST_REASON", scope: "source", view_id: "native:observations", population_id: "development_real", source_id: "nir", value });
const signal = (id: string, values: (number | null)[], summary?: { median: number; p95: number }) => [
  metric(id, { sample_ids: ids, observation_ids: ids, values }),
  ...(summary ? [metric(`${id}_median`, summary.median), metric(`${id}_p95`, summary.p95)] : []),
];
const viewOf = (metrics: unknown[]) => buildQualificationReportView({ ...(reportJson as unknown as EngineReport), metrics } as unknown as EngineReport);

// 4 spectra with peaks (one with 12, three with 1); 3 with jumps; two carry both.
const spikeCounts = ids.map((_, i) => (i === 0 ? 12 : i < 4 ? 1 : 0));
const jumpCounts = ids.map((_, i) => (i === 0 || i === 5 || i === 6 ? 2 : 0));
const spikeBand = axis.map((_, i) => (i >= 10 && i <= 12 ? 4 : i === 30 ? 1 : 0));
const snrDb = ids.map((_, i) => (i === 19 ? 15 : 45 + (i % 5)));
const rows = ids.map((_, r) => axis.map((_, j) => 10 + r * 0.5 + Math.sin(j / 5)));
const metrics = [
  ...signal("events.spike_count", spikeCounts),
  ...signal("events.jump_count", jumpCounts),
  metric("events.global_spike_count", 15),
  metric("events.global_jump_count", 6),
  metric("events.global_spike_band_counts", { axis, counts: spikeBand, evaluated: axis.map(() => N) }),
  metric("events.global_jump_band_counts", { axis, counts: axis.map(() => 0), evaluated: axis.map(() => N) }),
  ...signal("noise.signal_noise_db", snrDb, { median: 47, p95: 49 }),
  ...signal("noise.noise_sigma", ids.map(() => 0.01)),
  ...signal("noise.signal_mean_abs", ids.map((_, i) => 16 + (i % 3)), { median: 16.1, p95: 18 }),
  ...signal("reference.rms", ids.map((_, i) => (i === 0 ? 120 : 10 + i)), { median: 20, p95: 44 }),
];
const view = viewOf(metrics);
const input: EngineInput = {
  schema_version: 1,
  data_origin: "synthetic",
  sources: [{ source_id: "nir", observation_ids: ids, sample_ids: ids, x: rows, axis, axis_unit: "nm", signal_unit: "AU" }],
  samples: ids.map((sample_id) => ({ sample_id, partition: "development" })),
  targets: [],
  options: { independence_unit: "sample", intrinsic_qc: { outlier_threshold: 6 } },
};
const scope = (over: Partial<Scope> = {}): Scope => ({ t: (k: TextKey) => translate(k, "en"), locale: "en", view, input, sourceId: "nir", targetId: null, ...over });
const intrinsic = extractIntrinsic(view, "nir")!;

describe("event aggregation", () => {
  it("derives shares, denominators, events per affected spectrum and the histogram", () => {
    const s = eventStats(intrinsic, "spike")!;
    expect(s).toMatchObject({ evaluated: 20, affected: 4, unaffected: 16, events: 15, maxPerSpectrum: 12 });
    expect(s.affectedRatio).toBeCloseTo(0.2);
    expect(s.unaffectedRatio).toBeCloseTo(0.8);
    expect(s.perAffected).toBeCloseTo(15 / 4);
    expect(s.histogram.map((b) => b.count)).toEqual([16, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(s.top80).toEqual({ spectra: 1, ofAffected: 0.25 });
  });

  it("matches spikes and jumps by observation id instead of adding rates", () => {
    const o = eventOverlap(eventStats(intrinsic, "spike"), eventStats(intrinsic, "jump"))!;
    expect(o).toMatchObject({ both: 1, either: 6, total: 20 });
  });

  it("treats missing per-spectrum values as not evaluated and handles an empty population", () => {
    const v = viewOf(signal("events.spike_count", ids.map((_, i) => (i < 5 ? null : i === 6 ? 2 : 0))));
    const s = eventStats(extractIntrinsic(v, "nir")!, "spike")!;
    expect(s.evaluated).toBe(15);
    expect(s.affected).toBe(1);
    expect(countHistogram([])).toEqual([]);
    const none = eventStats(extractIntrinsic(viewOf(signal("events.spike_count", ids.map(() => null))), "nir")!, "spike")!;
    expect(none.affectedRatio).toBeNull();
    expect(none.perAffected).toBeNull();
  });

  it("reads unavailable signals as absent", () => {
    const v = viewOf([metric("events.spike_count", null, "unavailable")]);
    expect(eventStats(extractIntrinsic(v, "nir")!, "spike")).toBeNull();
  });

  it("locates regional recurrence only when it is demonstrated", () => {
    const bands = { axis, counts: spikeBand, evaluated: axis.map(() => N) };
    const top = eventRegions(bands)[0]!;
    expect(top.startIndex).toBe(10);
    expect(top.endIndex).toBe(12);
    expect(top.share).toBeCloseTo(12 / 13);
    expect(eventPattern(bands).kind).toBe("regional");
    // A single isolated spike (3 band-level flags) is not a region.
    expect(eventPattern({ axis, counts: axis.map((_, i) => (i >= 5 && i <= 7 ? 1 : 0)), evaluated: [] }).kind).toBe("mixed");
    expect(eventPattern({ axis, counts: axis.map(() => 1), evaluated: [] }).kind).toBe("spread");
    expect(eventPattern({ axis, counts: axis.map(() => 0), evaluated: [] }).kind).toBe("none");
  });

  it("reads the engine threshold with the documented default", () => {
    expect(eventThreshold({ intrinsic_qc: { outlier_threshold: 6 } })).toBe(6);
    expect(eventThreshold({ intrinsic_qc: {} })).toBe(8);
    expect(eventThreshold(undefined)).toBe(8);
  });
});

describe("SNR derivations", () => {
  it("converts the median dB and reports quantiles and the noisiest spectra", () => {
    const s = snrStats(intrinsic)!;
    expect(s.medianDb).toBe(47);
    expect(s.linear).toBeCloseTo(10 ** (47 / 20));
    expect(s.relativeNoisePercent).toBeCloseTo(100 * 10 ** (-47 / 20));
    expect(s.band).toBe("Low");
    expect(s.noisiest[0]).toMatchObject({ observationId: "o19", db: 15 });
    expect(s.p.p5).toBeLessThanOrEqual(s.p.p25);
  });

  it("computes the interim contrast SNR from input quantiles and engine sigma, guarding zero sigma and constant rows", () => {
    const c = contrastSnr(intrinsic, input.sources[0]!)!;
    expect(c).toHaveLength(N);
    const row = rows[0]!;
    const sorted = [...row].sort((a, b) => a - b);
    const q = (p: number) => { const h = (sorted.length - 1) * p; const lo = Math.floor(h); return sorted[lo]! + (h - lo) * (sorted[Math.ceil(h)]! - sorted[lo]!); };
    expect(c[0]!.value).toBeCloseTo(20 * Math.log10((q(0.95) - q(0.05)) / 0.01));
    const constant = { ...input.sources[0]!, x: rows.map((r) => r.map(() => 3)) };
    expect(contrastSnr(intrinsic, constant)).toEqual([]);
    const zeroSigma = extractIntrinsic(viewOf(signal("noise.noise_sigma", ids.map(() => 0))), "nir")!;
    expect(contrastSnr(zeroSigma, input.sources[0]!)).toEqual([]);
  });

  it("bins values and keeps ids per bin", () => {
    const bins = valueHistogram([{ id: "a", value: 1 }, { id: "b", value: 2 }, { id: "c", value: 3 }], 2);
    expect(bins.map((b) => b.ids)).toEqual([["a"], ["b", "c"]]);
    expect(valueHistogram([{ id: "a", value: 5 }, { id: "b", value: 5 }])).toHaveLength(1);
  });
});

describe("diversity derivations", () => {
  it("uses the engine quantiles and the median mean |x| as typical level", () => {
    const d = diversityStats(intrinsic)!;
    expect(d).toMatchObject({ median: 20, p95: 44, max: 120, maxId: "o0", typicalLevel: 16.1 });
    expect(d.relativeP95).toBeCloseTo(44 / 16.1);
  });

  it("returns N/A for a zero typical level", () => {
    const v = viewOf([...signal("reference.rms", ids.map(() => 1), { median: 1, p95: 1 }), ...signal("noise.signal_mean_abs", ids.map(() => 0), { median: 0, p95: 0 })]);
    const d = diversityStats(extractIntrinsic(v, "nir")!)!;
    expect(d.relativeP95).toBeNull();
    expect(diversityComments(d, "AU", null, f)[0]).toContain("not available");
  });

  it("builds envelopes over valid cells without touching the input, and packs only complete rows", () => {
    const x = [[1, null, 3], [3, 4, 5], [5, 6, Number.NaN]];
    const source = { source_id: "s", observation_ids: ["a", "b", "c"], sample_ids: ["a", "b", "c"], x, axis: [1, 2.5, 7], valid_mask: [[true, true, true], [true, false, true], [true, true, true]] };
    const before = JSON.stringify(source);
    const env = bandEnvelope(source, [0, 1, 2]);
    expect(env.mean[0]).toBe(3);
    expect(env.mean[1]).toBe(6); // null cell and masked cell skipped
    expect(env.mean[2]).toBe(4); // NaN skipped
    const m = completeMatrix(source, [{ id: "a", row: 0 }, { id: "b", row: 1 }, { id: "c", row: 2 }]);
    expect(m.ids).toEqual([]);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("compares raw and SNV distances by rank only", () => {
    const ids10 = Array.from({ length: 20 }, (_, i) => `r${i}`);
    const a = ids10.map((_, i) => i);
    expect(topKOverlap(ids10, a, a, 5)).toEqual({ kept: 5, k: 5 });
    expect(topKOverlap(ids10, a, a.map((v) => -v), 5)).toEqual({ kept: 0, k: 5 });
    expect(topKOverlap(["x"], [1], [null], 5)).toBeNull();
  });
});

describe("interpretive comments", () => {
  it("states prevalence, concentration and regional recurrence when demonstrated", () => {
    const spikes = eventStats(intrinsic, "spike");
    const jumps = eventStats(intrinsic, "jump");
    const out = eventComments(spikes, jumps, eventOverlap(spikes, jumps), { spike: eventPattern({ axis, counts: spikeBand, evaluated: [] }), jump: { kind: "none" } }, "nm", f);
    expect(out[0]).toBe("20% of spectra (4/20) contain at least one flagged isolated peak.");
    expect(out.some((c) => c.startsWith("Flagged isolated peaks are concentrated in a small number of spectra"))).toBe(true);
    expect(out.some((c) => c.includes("recur in one spectral region (1,100–1,120 nm)"))).toBe(true);
    // Jumps: 3 affected spectra with 2 events each -> neither concentrated (1 of 3 holds < 80%) nor dispersed (< 10 affected).
    expect(out.some((c) => c.startsWith("Flagged abrupt changes"))).toBe(false);
    expect(out.at(-1)).toContain("carry both isolated peaks and abrupt changes");
  });

  it("reports absence explicitly and never invents concentration", () => {
    const zero = eventStats(extractIntrinsic(viewOf(signal("events.spike_count", ids.map(() => 0))), "nir")!, "spike");
    expect(eventComments(zero, null, null, { spike: { kind: "none" }, jump: { kind: "none" } }, "", f)).toEqual(["No isolated peak was flagged in any of the 20 evaluated spectra."]);
    const dispersed = eventStats(extractIntrinsic(viewOf(signal("events.spike_count", ids.map((_, i) => (i < 12 ? 1 : 0)))), "nir")!, "spike");
    const out = eventComments(dispersed, null, null, { spike: { kind: "none" }, jump: { kind: "none" } }, "", f);
    expect(out[1]).toBe("Flagged isolated peaks are dispersed: no spectrum carries more than 1 event.");
  });

  it("SNR comments follow the stated dB rules", () => {
    const s = snrStats(intrinsic)!;
    const out = snrComments(s, null, f);
    expect(out[0]).toContain("approximately 0.45% of the typical absolute signal amplitude");
    expect(out.some((c) => c.startsWith("1 spectrum has an estimated SNR at least 20 dB"))).toBe(true);
    expect(snrComments(null, null, f)).toEqual([]);
    expect(snrComments(s, s.medianDb + 1, f).some((c) => c.includes("contrast-based"))).toBe(false);
    expect(snrComments(s, s.medianDb - 10, f).some((c) => c.includes("consistent with a constant offset"))).toBe(true);
  });

  it("diversity comments reproduce the request example", () => {
    const d = diversityStats(intrinsic)!;
    const out = diversityComments(d, "AU", null, f);
    expect(out[0]).toBe("The 95th percentile spectral distance is 2.73 times the typical absolute signal level, indicating substantial spectral heterogeneity.");
    expect(out[1]).toContain("The most distant spectrum lies 2.73 times further");
    expect(diversityComments(d, "AU", { kept: 2, k: 10 }, f).at(-1)).toContain("mainly reflects overall level or scale differences");
  });
});

describe("instrument references", () => {
  it("only plots verified ratios and never converts photometric noise", () => {
    for (const r of INSTRUMENT_REFERENCES) {
      if (!r.verified) expect(r.snr).toBeNull();
      if (r.snr !== null) expect(r.source.url).toMatch(/^https:\/\//);
    }
    expect(referenceDb(INSTRUMENT_REFERENCES.find((r) => r.id === "asd-labspec4-2100")!)).toBeCloseTo(72.04, 2);
    expect(NON_CONVERTIBLE_REFERENCES[0]).not.toHaveProperty("snr");
  });
});

describe("panels and summaries", () => {
  it("render the homogeneous structure with denominators", () => {
    const html = renderToStaticMarkup(<><IntegrityPanel {...scope()} /><SnrPanel {...scope()} /><DiversityPanel {...scope()} /></>);
    expect(html).toContain("Spectra with isolated peaks and abrupt changes");
    expect(html).toContain("4/20 spectra · 15 events · 3.75 per flagged spectrum");
    expect(html).toContain("Flagged spectra / 20");
    expect(html).toContain("Methodological limitations");
    expect(html).toContain("Suggested investigation");
    expect(html).toContain("These are inspection flags, not automatic rejection criteria.");
    expect(html).toContain("Spectra × wavelength map unavailable");
    expect(html).toContain("6 robust deviations");
    expect(html).toContain("Estimated SNR");
    expect(html).toContain("47 dB | 0.447 %");
    expect(html).toContain("Manufacturer specifications and dataset-derived SNR estimates are obtained using different measurement and estimation protocols.");
    expect(html).toContain("Large spectral distances indicate heterogeneity, not necessarily poor data quality.");
    expect(html).toContain("2.73×");
    expect(html).toContain("273 % of the typical signal level");
    expect(html).toContain("P95 RMS distance");
    expect(html).toContain("Tables, method and limitations");
  });

  it("show compact zero states instead of empty charts", () => {
    const zero = viewOf([
      ...signal("events.spike_count", ids.map(() => 0)),
      ...signal("events.jump_count", ids.map(() => 0)),
      metric("events.global_spike_band_counts", { axis, counts: axis.map(() => 0), evaluated: axis.map(() => N) }),
    ]);
    const html = renderToStaticMarkup(<IntegrityPanel {...scope({ view: zero })} />);
    expect(html).toContain("No isolated peak was flagged in any of the 20 evaluated spectra.");
    expect(html).not.toContain("Flagged spectra /");
    expect(html).not.toContain("events per flagged spectrum");
    expect(html).not.toContain("spectra flagged per band");
  });

  it("never show raw JSON observation ids", () => {
    const jsonIds = ids.map((_, i) => JSON.stringify([0, "train", i, null]));
    const v = viewOf(metrics.map((m) => (m.value && typeof m.value === "object" && "observation_ids" in (m.value as object) ? { ...m, value: { ...(m.value as object), observation_ids: jsonIds } } : m)));
    const inp = { ...input, sources: [{ ...input.sources[0]!, observation_ids: jsonIds }] };
    const html = renderToStaticMarkup(<><IntegrityPanel {...scope({ view: v, input: inp })} /><SnrPanel {...scope({ view: v, input: inp })} /><DiversityPanel {...scope({ view: v, input: inp })} /></>);
    expect(html).toContain("train #1");
    expect(html).not.toContain("[0,&quot;train&quot;");
    expect(html).not.toContain('[0,"train"');
  });

  it("render nothing without intrinsic results", () => {
    const empty = scope({ view: viewOf([]) });
    expect(renderToStaticMarkup(<><IntegrityPanel {...empty} /><SnrPanel {...empty} /><DiversityPanel {...empty} /></>)).toBe("");
    expect(integritySummary(empty)).toBeNull();
    expect(snrSummary(empty)).toBeNull();
    expect(diversitySummary(empty)).toBeNull();
  });

  it("expose overview summaries", () => {
    expect(integritySummary(scope())).toMatchObject({ spikes: { affected: 4, evaluated: 20, affectedPercent: 20, events: 15 }, either: { count: 6, total: 20 }, threshold: 6 });
    expect(snrSummary(scope())).toMatchObject({ medianDb: 47, indicativeBand: "Low" });
    expect(diversitySummary(scope())!.relativeP95).toBeCloseTo(44 / 16.1);
  });

});

describe("wave 2 helpers", () => {
  it("histogram of flagged spectra drops the zero bin and keeps ids", () => {
    const bins = flaggedBins(eventStats(intrinsic, "spike")!);
    expect(bins[0]!.lo).toBe(1);
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(4);
    expect(bins.find((b) => b.lo === 1)!.ids.sort()).toEqual(["o1", "o2", "o3"]);
    expect(bins.find((b) => b.lo === 12)!.ids).toEqual(["o0"]);
  });

  it("illustrative noise has the sigma implied by the SNR definition and keeps missing values", () => {
    const draws = gaussianSequence(20000);
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    const sd = Math.sqrt(draws.reduce((a, b) => a + (b - mean) ** 2, 0) / draws.length);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(sd).toBeCloseTo(1, 1);
    expect(gaussianSequence(5)).toEqual(gaussianSequence(5));
    const base = [2, -2, null, 2];
    const out = addIllustrativeNoise(base, 40, draws)!;
    expect(out.sigma).toBeCloseTo(2 * 0.01, 12);
    expect(out.values[2]).toBeNull();
    expect(base).toEqual([2, -2, null, 2]);
    expect(addIllustrativeNoise([0, 0, null], 40, draws)).toBeNull();
  });

  it("picks the spectrum with the median SNR for the illustration", () => {
    const s = snrStats(intrinsic)!;
    const id = medianSnrSpectrum(s)!;
    expect(Math.abs(s.entries.find((e) => e.id === id)!.value - s.medianDb)).toBeLessThanOrEqual(Math.min(...s.entries.map((e) => Math.abs(e.value - s.medianDb))));
  });

  it("numerically constant values give one histogram bin", () => {
    const bins = valueHistogram([{ id: "a", value: 3.02 }, { id: "b", value: 3.02 + 1e-15 }, { id: "c", value: 3.02 }], 24);
    expect(bins).toHaveLength(1);
    expect(bins[0]!.count).toBe(3);
  });
});

describe("noise scales read left = less noise", () => {
  const bandX = (html: string, label: string) => {
    const m = new RegExp(`<title>${label} [^<]*</title><rect x="([0-9.]+)"`).exec(html);
    return m ? Number(m[1]) : NaN;
  };
  const bands = SNR_BANDS.map((b, i) => ({ from: i === 0 ? 0 : SNR_BANDS[i - 1]!.maxDb, to: Number.isFinite(b.maxDb) ? b.maxDb : 100, label: b.label }));
  const ticks = [0, 50, 100].map((v) => ({ value: v, top: String(v), bottom: `${v} %` }));

  it("the reversed gauge puts high dB (least noise) on the left, with the direction caption", () => {
    const html = renderToStaticMarkup(<DualScaleGauge reversed ends={{ left: "Less noise", right: "More noise" }} value={70} min={0} max={100} bands={bands} ticks={ticks} ariaLabel="g" />);
    expect(bandX(html, "Extremely low")).toBeLessThan(bandX(html, "Moderate"));
    expect(bandX(html, "Moderate")).toBeLessThan(bandX(html, "Very high"));
    expect(html).toContain("← Less noise");
    expect(html).toContain("More noise →");
    const plain = renderToStaticMarkup(<DualScaleGauge value={70} min={0} max={100} bands={bands} ticks={ticks} ariaLabel="g" />);
    expect(bandX(plain, "Very high")).toBeLessThan(bandX(plain, "Extremely low"));
  });

  it("the SNR panel gauge is reversed and coloured from the noise scale", () => {
    const html = renderToStaticMarkup(<SnrPanel {...scope()} />);
    expect(bandX(html, "Extremely low")).toBeLessThan(bandX(html, "Very high"));
    expect(html).toContain("var(--ig-noise-6)");
    expect(html).toContain("← Less noise");
  });
});

describe("empirical noise benchmark", () => {
  it("holds only engine-computed rows of bundled public datasets, with provenance", () => {
    expect(NOISE_BENCHMARK.rows.map((r) => r.id).sort()).toEqual(["anopheles", "beer"]);
    expect(NOISE_BENCHMARK.generated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const r of NOISE_BENCHMARK.rows) {
      expect(r.min <= r.p5 && r.p5 <= r.p25 && r.p25 <= r.p50 && r.p50 <= r.p75 && r.p75 <= r.p95 && r.p95 <= r.max).toBe(true);
      expect(r.n).toBeGreaterThan(0);
      expect(r.source).toMatch(/https:\/\//);
    }
  });

  const p = { p5: 46, p25: 47, p50: 48.9, p75: 50, p95: 51 };
  it("draws this dataset plus the references and states the coverage plainly", () => {
    const html = renderToStaticMarkup(<NoiseBenchmarkCard medianDb={48.9} p={p} n={20} f={f} locale="en" />);
    expect(html).toContain("Empirical noise benchmark");
    expect(html).toContain("2 public reference datasets");
    expect(html).toContain("Not a representative instrument benchmark");
    expect(html).toContain("instrument not documented");
    expect(html).toContain("This dataset");
    expect(html).toContain("48.9 dB");
    for (const brand of ["FOSS", "Büchi", "Bruker", "PerkinElmer", "VIAVI", "Texas"]) expect(html).not.toContain(brand);
  });

  it("marks a bundled reference as this dataset instead of duplicating it", () => {
    const beer = NOISE_BENCHMARK.rows.find((r) => r.id === "beer")!;
    const html = renderToStaticMarkup(<NoiseBenchmarkCard medianDb={beer.p50} p={{ p5: beer.p5, p25: beer.p25, p50: beer.p50, p75: beer.p75, p95: beer.p95 }} n={beer.n} f={f} locale="en" />);
    expect(html).toContain("this dataset · instrument not documented");
    expect(html).not.toContain("analysed now");
  });

  it("words the position against a reference interval", () => {
    expect(benchmarkPosition(90, { p5: 80, p95: 85 })).toBe("above its P95 (less noise)");
    expect(benchmarkPosition(50, { p5: 80, p95: 85 })).toBe("below its P5 (more noise)");
    expect(benchmarkPosition(82, { p5: 80, p95: 85 })).toBe("within its P5–P95");
  });

  it("BoxPlotRows shows a compact message for invalid stats and reverses the axis", () => {
    expect(renderToStaticMarkup(<BoxPlotRows title="t" rows={[{ label: "a", stats: { lo: 3, q1: 2, median: 1, q3: 4, hi: 5 } }]} emptyMessage="Nothing" />)).toContain("Nothing");
    const rows = [{ label: "a", stats: { lo: 10, q1: 20, median: 30, q3: 40, hi: 50 } }];
    const median = (html: string) => Number(/class="cz-box-median" x1="([0-9.]+)"/.exec(html.replace(/<line x1="([0-9.]+)" x2="[0-9.]+" y1="[0-9.]+" y2="[0-9.]+" class="cz-box-median"/, '<line class="cz-box-median" x1="$1"'))?.[1]);
    const lo = (html: string) => Number(/<line x1="([0-9.]+)" x2="[0-9.]+" y1="[0-9.]+" y2="[0-9.]+" class="cz-box-whisker"/.exec(html)?.[1]);
    const plain = renderToStaticMarkup(<BoxPlotRows title="t" rows={rows} domain={[0, 60]} />);
    const rev = renderToStaticMarkup(<BoxPlotRows title="t" rows={rows} domain={[0, 60]} reversed />);
    expect(median(plain)).toBeCloseTo(median(rev), 6); // 30 is the centre of [0, 60]
    expect(lo(plain)).toBeLessThan(median(plain));
    expect(lo(rev)).toBeLessThan(median(rev)); // whisker line drawn left to right in both orientations
    expect(rev).toContain("Whiskers: P5–P95");
  });
});
