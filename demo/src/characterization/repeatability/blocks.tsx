// Building blocks of the "Spectral noise and repeatability" rubric, in agent K's rubric contract v2
// (shared/blocks.ts). Plain functions (no hooks): `useNoiseProxyBlocks` / `useRepeatabilityBlocks`
// (hooks.tsx) memoize them. Every per-band estimate comes from the engine report; this module only
// arranges it (KPIs, comments, distributions, per-band tracks, inspection, collapsed details).
import type { ReactNode } from "react";
import { ChartDataTable } from "nirs4all-ui/qualification";
import { translate } from "../../i18n";
import type { Scope } from "../../Sections";
import { Histogram, ValueBars, type KpiItem } from "../shared/charts";
import type { RubricBlock, RubricBlocks, RubricComment } from "../shared/blocks";
import { dbToRelativeNoisePercent, finite, iccToRatio, quantile } from "../shared/derive";
import type { BandSelection, Track } from "./AlignedTracks";
import { NO_REPLICATES_COMMENT, bandRuns, fmt, noiseComments, noiseStats, repeatStats, repeatabilityComments } from "./comments";
import { GroupInspection } from "./GroupInspection";
import { NoReplicatesCard } from "./NoReplicatesCard";
import { ContextComparison } from "./ContextComparison";
import { bandEnvelope, contextGroups, developmentRows, sourceProfiles, topRegions, typicalSignalLevel } from "./profiles";
import { RatioVisual } from "./RatioVisual";
import { ResidualInspection } from "./ResidualInspection";
import { medianSnrDb } from "./summary";
import { ShareSummary } from "./ui";

/** B's blocks: K's `RubricBlocks` with every slot in one fixed shape, plus the measurement contexts. */
export interface BBlocks extends RubricBlocks {
  id: "repeatability" | "noise_proxy";
  status: "computed" | "unavailable";
  title: string;
  lead: string;
  kpis: KpiItem[];
  comments: RubricComment[];
  distributions: RubricBlock[];
  bandTracks: Track[];
  markRegions: { i0: number; i1: number; label: string }[];
  inspection: (ctx: { selection: BandSelection | null }) => ReactNode;
  details: { limitations: string; methodology: ReactNode; tables: ReactNode; investigate: string[] };
  /** Measurement contexts; `options.contextIndex` selects one. */
  contexts: string[];
}

const note = (text: string, i: number, tone: RubricComment["tone"] = "info"): RubricComment => ({ id: `c${i}`, text, tone });
/** Attention tone for comments that point at a region or a limitation, info otherwise (text carries the meaning). */
const toComments = (lines: readonly string[], prefix: string): RubricComment[] => lines.map((t, i) => note(t, i, /below|exceeds|elevated|Several|One contiguous|imprecise|unbalanced|negative|higher|lower|not available/i.test(t) ? "attention" : "info")).map((c) => ({ ...c, id: `${prefix}-${c.id}` }));

export const REPEAT_LEAD = translate("czRpRepeatLead", "en");
export const REPEAT_WARNING = translate("czRpRepeatWarning", "en");
export const NOISE_LEAD = translate("czRpNoiseLead", "en");

/** Indicative ICC bands (Koo & Li, 2016): general ICC conventions, not NIR instrument criteria. Ordinal tones, no green/red. */
export const KOO_LI_BANDS = [
  { id: "poor", label: "Poor", range: "< 0.50", from: -Infinity, to: 0.5, tone: "copper" },
  { id: "moderate", label: "Moderate", range: "0.50–0.75", from: 0.5, to: 0.75, tone: "copper-2" },
  { id: "good", label: "Good", range: "0.75–0.90", from: 0.75, to: 0.9, tone: "teal-2" },
  { id: "excellent", label: "Excellent", range: "≥ 0.90", from: 0.9, to: Infinity, tone: "teal" },
] as const;

/** Exploratory noise-to-diversity bands (not metrologically validated). */
export const RATIO_BANDS = [
  { id: "low", label: "Low", range: "< 0.10", from: 0, to: 0.1, tone: "teal" },
  { id: "moderate", label: "Moderate", range: "0.10–0.30", from: 0.1, to: 0.3, tone: "teal-2" },
  { id: "substantial", label: "Substantial", range: "0.30–1.00", from: 0.3, to: 1, tone: "copper-2" },
  { id: "exceeds", label: "Exceeds diversity", range: "≥ 1.00", from: 1, to: Infinity, tone: "copper" },
] as const;

const pctOf = (k: number, n: number) => (n > 0 ? (100 * k) / n : null);
const sourceOf = (scope: Scope) => (scope.sourceId ? scope.input.sources.find((s) => s.source_id === scope.sourceId) : undefined);

/** Shared spectral axis of the rubric stack and its label (unit-aware, no fixed NIR range). */
export function rubricAxis(scope: Scope): { axis: number[]; axisLabel: string } | null {
  const s = sourceOf(scope);
  if (!s) return null;
  return { axis: [...s.axis], axisLabel: s.axis_unit ? `Spectral axis (${s.axis_unit})` : "Band index" };
}

/** Median spectrum and P5–P95 envelope of the development spectra — include ONCE at the top of the stack. */
export function spectrumTrack(scope: Scope): Track | null {
  const s = sourceOf(scope);
  if (!s) return null;
  const env = bandEnvelope(s, developmentRows(scope.input, s));
  if (!finite(env.median).length) return null;
  return {
    id: "spectrum",
    title: "Median spectrum and P5–P95 envelope",
    unit: s.signal_unit || undefined,
    height: 100,
    series: [{ id: "median", label: "Median spectrum", values: env.median, color: "var(--cz-blue)" }],
    envelopes: [{ id: "env", label: "P5–P95 envelope", lower: env.p5, upper: env.p95, color: "var(--cz-blue)" }],
  };
}

const empty = (id: BBlocks["id"], title: string, lead: string, unavailable: string | null, distributions: RubricBlock[] = [], comments: RubricComment[] = []): BBlocks => ({
  id, status: "unavailable", title, lead, kpis: [], comments, distributions, bandTracks: [], markRegions: [], inspection: () => null,
  details: { limitations: "", methodology: null, tables: null, investigate: [] }, unavailable, contexts: [],
});

/** `contextIndex`: index of the repeatability context (default 0); null = the selected measurement context has none. */
export function repeatabilityBlocks(scope: Scope, options: { onOpenSettings?: (() => void) | undefined; contextIndex?: number | null | undefined; contextLabel?: string | undefined } = {}): BBlocks {
  const title = "Technical repeatability";
  const source = sourceOf(scope);
  const profiles = source && scope.sourceId ? sourceProfiles(scope.view, scope.input, scope.sourceId).repeats : [];
  if (!source) return empty("repeatability", title, REPEAT_LEAD, null);
  // No replicate groups: an explicit card (no zero, no ICC), never an empty chart.
  if (!profiles.length) return empty("repeatability", title, REPEAT_LEAD, null, [{ id: "rp-none", node: <NoReplicatesCard onOpenSettings={options.onOpenSettings} />, span: "full" }], [note(NO_REPLICATES_COMMENT, 0, "neutral")]);
  // The shared context has no technical repeats (noise-only context): say so, never borrow another context.
  if (options.contextIndex === null) {
    const text = `No technical replicate groups in the selected measurement context${options.contextLabel ? ` (${options.contextLabel})` : ""}: technical repeatability is computed in ${profiles.length} other context${profiles.length > 1 ? "s" : ""}. Select one of them to read it.`;
    return { ...empty("repeatability", title, REPEAT_LEAD, null, [{ id: "rp-other-context", node: <p className="cz-empty">{text}</p>, span: "full" }], [note(text, 0, "neutral")]), contexts: profiles.map((q, i) => q.context.id || `Context ${i + 1}`) };
  }
  const p = profiles[Math.min(options.contextIndex ?? 0, profiles.length - 1)]!;
  const groups = contextGroups(scope.input, source, p.context);
  const unit = p.context.unit ?? source.signal_unit ?? "";
  const axisLabel = rubricAxis(scope)!.axisLabel;
  const s = repeatStats(p);
  const rc = p.uncertainty?.repeatCounts;
  const exact = p.iccKind === "icc_1_1";
  // R = σb/σw is model-exact for the balanced ANOVA and for the engine's REML components alike.
  const rExact = p.betweenKind !== "approximate";
  const iccName = exact ? "ICC(1,1)" : "ICC(1) REML";
  const ctxTag = profiles.length > 1 ? ` · ${p.context.id}` : "";
  const counts = { poor: 0, moderate: 0, good: 0, excellent: 0, none: 0 };
  p.categories.forEach((c) => (c ? counts[c]++ : counts.none++));
  const goodShare = pctOf(counts.good + counts.excellent, s.bands);
  const iccVals = finite(p.icc ?? []);
  const iccLow = Math.min(0, ...iccVals, ...finite(p.context.iccInterval?.lower ?? []));

  const kpis: KpiItem[] = [
    { label: `Median repeatability SD${ctxTag}`, value: s.medianSd === null ? "—" : fmt(s.medianSd), unit: unit || undefined, sub: "Pooled within-sample SD, median over bands", tone: "copper" },
    { label: `Median ${iccName}`, value: s.medianIcc === null ? "—" : fmt(s.medianIcc), sub: `ICC P5 ${s.p5Icc === null ? "—" : fmt(s.p5Icc)} · ${s.evaluable} bands`, tone: "teal" },
    { label: "Evaluable ICC bands", value: s.bands ? fmt((100 * s.evaluable) / s.bands) : "—", unit: "%", bar: pctOf(s.evaluable, s.bands), sub: `${s.evaluable} of ${s.bands} bands`, tone: "teal" },
    { label: "Physical samples", value: rc?.nGroups ?? p.context.physicalGroups ?? "—", sub: rc ? `${rc.nRepeatedGroups ?? "—"} with ≥ 2 repeats · ${rc.rMin ?? "—"}–${rc.rMax ?? "—"} repeats (median ${rc.rMedian ?? "—"})` : `${p.context.observations ?? "—"} observations`, tone: "grey" },
    ...(rExact && s.medianRatio !== null ? [{ label: "Median R = σb / σw", value: fmt(s.medianRatio), unit: "×", sub: "Between- over within-sample SD", tone: "teal" as const }] : []),
  ];

  const distributions: RubricBlock[] = [
    {
      id: "rp-coverage",
      title: `Spectral repeatability coverage${ctxTag}`,
      node: (
        <>
          <ShareSummary
            headline={goodShare === null ? null : `${fmt(goodShare)} %`}
            headlineLabel="Good to excellent relative repeatability"
            headlineSub={`${iccName} ≥ 0.75 · indicative (Koo & Li, 2016)`}
            total={s.bands}
            label={`Share of ${s.bands} bands per indicative ${iccName} category`}
            segments={[
              ...[...KOO_LI_BANDS].reverse().map((b) => ({ label: `${b.label} ${b.range}${b.id === "poor" && s.negative ? ` (incl. ${s.negative} negative)` : ""}`, value: counts[b.id], tone: b.tone })),
              { label: "Not evaluable", value: counts.none, hatch: true },
            ]}
          />
          <table className="rp-ref-table rp-icc-table">
            <caption>Indicative ICC reading{rExact ? " and the equivalent R = σb/σw" : ""}</caption>
            <thead><tr><th>ICC</th><th>Indicative</th>{rExact ? <th>R</th> : null}</tr></thead>
            <tbody>{KOO_LI_BANDS.map((b) => <tr key={b.id}><td>{b.range}</td><td><span className={`cz-swatch cz-tone-${b.tone}`} aria-hidden="true" /> {b.label}</td>{exact ? <td>{b.from === -Infinity ? "< 1×" : `${fmt(iccToRatio(b.from)!, 3)}×`}</td> : null}</tr>)}</tbody>
          </table>
        </>
      ),
    },
    {
      id: "rp-ratio",
      title: "Sample diversity vs. measurement variability",
      node: <RatioVisual datasetRatio={rExact ? s.medianRatio : null} />,
    },
    ...(profiles.length > 1 ? [{
      id: "rp-contexts",
      title: `ICC and repeatability SD across ${profiles.length} measurement contexts`,
      subtitle: "Each context is estimated separately (never pooled); compare before pooling repeats from different instruments, campaigns or repeat types.",
      span: "full" as const,
      node: <ContextComparison source={source} profiles={profiles} selectedId={p.context.id} axisLabel={axisLabel} unit={unit} sourceId={scope.sourceId!} />,
    }] : []),
    ...(rc?.histogram.length ? [{
      id: "rp-counts",
      title: `Repeats per physical sample${ctxTag}`,
      node: <ValueBars rows={rc.histogram.map((h) => ({ label: `${h.r} repeat${h.r > 1 ? "s" : ""}`, value: h.nGroups, tone: "muted" as const }))} unit="samples" digits={4} axisLabel="Physical samples" />,
    }] : []),
  ];

  const bandTracks: Track[] = [
    {
      id: "rp-sd",
      title: `Repeatability SD vs between-sample SD${ctxTag}`,
      unit: unit || undefined,
      includeZero: true,
      series: [
        { id: "sw", label: "Repeatability SD (within-sample)", values: p.sd, color: "var(--cz-copper)" },
        { id: "sb", label: `Between-sample SD${p.betweenKind === "approximate" ? " (approx.)" : p.betweenKind === "reml" ? " (REML σb)" : ""}`, values: p.betweenSd, color: "var(--cz-teal-2)", dash: "5 3" },
      ],
      envelopes: p.context.sdInterval ? [{ id: "sdci", label: "Repeatability SD interval", lower: p.context.sdInterval.lower, upper: p.context.sdInterval.upper, color: "var(--cz-copper)" }] : [],
      nonEvaluable: p.sd.map((v) => v === null),
    },
    {
      id: "rp-icc",
      title: `${iccName} per band${ctxTag}`,
      height: 120,
      yDomain: [iccLow - 0.03, 1.02],
      series: [{ id: "icc", label: iccName, values: p.icc ?? [], color: "var(--cz-teal)" }],
      envelopes: p.context.iccInterval ? [{ id: "iccci", label: "ICC 95 % interval", lower: p.context.iccInterval.lower, upper: p.context.iccInterval.upper, color: "var(--cz-teal)" }] : [],
      refBands: [{ from: 0.9, to: 1.02, label: "Excellent ≥ 0.90 (indicative)", fill: "var(--cz-zone)" }],
      refLines: [{ y: 0.75, label: "0.75 good" }, { y: 0.5, label: "0.50 moderate" }, ...(iccLow < 0 ? [{ y: 0, label: "0" }] : [])],
      nonEvaluable: p.nonEvaluable,
      format: (v) => fmt(v, 3),
    },
  ];
  const markRegions = bandRuns(p.icc ?? [], (v) => v < 0.5).map((r) => ({ ...r, label: "Indicative poor ICC (< 0.50): region to inspect" }));

  return {
    id: "repeatability",
    status: "computed",
    title,
    lead: REPEAT_LEAD,
    kpis,
    comments: [...toComments(repeatabilityComments([p], source.axis, source.axis_unit ?? ""), "rp"), note(REPEAT_WARNING, 99, "neutral")],
    distributions,
    bandTracks,
    markRegions,
    inspection: ({ selection }) => <GroupInspection source={source} profile={p} groups={groups} selection={selection} axisLabel={axisLabel} unit={unit} />,
    details: {
      limitations: `${iccName}: one-way random-effects model, absolute agreement of a single measurement, for this measurement context only (${p.context.id || "default context"}).`,
      methodology: (
        <>
          <p>Model: x = μ + b(sample) + e, b ~ N(0, σb²), e ~ N(0, σw²), repeats exchangeable within each physical sample and σw homogeneous across samples. Repeatability SD = √MSW (pooled within-sample SD); {exact ? "ICC(1,1) = (MSB − MSW)/(MSB + (r − 1)·MSW) for balanced groups of size r" : "REML ICC(1) for unbalanced groups (the balanced ICC(1,1) is undefined)"}. Physical samples come from the declared physical sample identifiers (else sample identifiers); repeats are the rows declared as {p.context.repeatType ?? "technical"} repeats in this context. Biological repeats, instruments, sessions and operators are separate contexts and are never pooled.</p>
          <p>{exact
            ? "Between-sample SD in the same model: σb = σw·√(ICC/(1 − ICC)) = √((MSB − MSW)/r), defined for 0 ≤ ICC < 1 (a gap otherwise)."
            : p.betweenKind === "reml"
              ? "Between-sample SD: σb = √σb² from the engine's per-band REML variance components (σb², σw² published with measurement.icc_1_reml); REML ICC(1) = σb²/(σb² + σw²) exactly. A boundary estimate σb² = 0 gives σb = 0. The repeatability SD track stays the ANOVA pooled SD √MSW (engine measurement.repeatability_sd), which can differ slightly from the REML σw in unbalanced designs."
              : "Between-sample SD: σb = σw·√(ICC/(1 − ICC)) with the REML ICC and the ANOVA pooled SD (approximate: the engine did not publish the REML variance components)."}{" "}ICC = R²/(1 + R²) with R = σb/σw{rExact ? "" : " (shown only when exact)"}. Negative ICC estimates (MSB &lt; MSW) are kept unclipped.</p>
          <p>ICC bands follow general ICC interpretation conventions (Koo &amp; Li, 2016); they are indicative and not NIR instrument criteria. Shaded regions mark ≥ 3 contiguous bands with ICC &lt; 0.50.</p>
        </>
      ),
      tables: (
        <ChartDataTable
          locale={scope.locale}
          caption={`Per-band repeatability — ${p.context.id}`}
          columns={["Band", `Repeatability SD${unit ? ` (${unit})` : ""}`, `Between-sample SD${unit ? ` (${unit})` : ""}`, iccName, "R = σb/σw"]}
          rows={source.axis.map((x, i) => [x, p.sd[i] ?? null, p.betweenSd[i] ?? null, p.icc?.[i] ?? null, rExact ? (p.ratio[i] ?? null) : null])}
        />
      ),
      investigate: [
        "Select a band or region in the tracks to inspect the individual repeats of each physical sample.",
        "Compare contexts (repeat type, instrument, campaign) before pooling them.",
        "Where ICC is low but the repeatability SD is small, check whether the samples simply differ little in that region.",
      ],
    },
    unavailable: null,
    contexts: profiles.map((q, i) => q.context.id || `Context ${i + 1}`),
  };
}

/** `contextIndex`: index of the noise-proxy context (default 0); null = the selected measurement context has none. */
export function noiseBlocks(scope: Scope, options: { contextIndex?: number | null | undefined; relative?: boolean | undefined; contextLabel?: string | undefined } = {}): BBlocks {
  const title = "Per-band noise proxy";
  const source = sourceOf(scope);
  const profiles = source && scope.sourceId ? sourceProfiles(scope.view, scope.input, scope.sourceId).noise : [];
  if (!source || !profiles.length) return empty("noise_proxy", title, NOISE_LEAD, source ? "The per-band noise proxy was not computed for this source." : null);
  if (options.contextIndex === null) return empty("noise_proxy", title, NOISE_LEAD, `The per-band noise proxy was not computed for the selected measurement context${options.contextLabel ? ` (${options.contextLabel})` : ""}.`);
  const p = profiles[Math.min(options.contextIndex ?? 0, profiles.length - 1)]!;
  const level = typicalSignalLevel(scope.view, scope.sourceId!);
  const snrDb = medianSnrDb(scope);
  const unit = p.unit ?? source.signal_unit ?? "";
  const axisUnit = source.axis_unit ?? "";
  const axisLabel = rubricAxis(scope)!.axisLabel;
  const s = noiseStats(p, level);
  const rel = (options.relative ?? true) && level !== null && level > 0;
  const denom = p.diversityKind === "between-sample" ? "between-sample SD" : "between-spectrum SD";
  const ctxTag = profiles.length > 1 ? ` · ${p.id}` : "";
  const snrPct = snrDb === null ? null : dbToRelativeNoisePercent(snrDb);
  const ratioCounts = RATIO_BANDS.map((b) => ({ ...b, count: p.ratioBands.filter((x) => x === b.id).length }));
  const ratioNone = p.ratio.filter((v) => v === null).length;
  const ratioVals = finite(p.ratio);
  const ratioMax = ratioVals.length ? Math.max(...ratioVals) : 1;
  const ratioCap = Math.max(1.2, (quantile(ratioVals, 0.98) ?? 1) * 1.1);
  const capped = ratioMax > ratioCap;
  const toRel = (v: number | null) => (v === null ? null : rel ? (100 * v) / level! : v);
  const noiseUnit = rel ? "% of typical signal" : unit;
  const window = `SG residual · window ${p.windowBands ?? "—"} · polynomial order ${p.polyorder ?? "—"}`;

  const kpis: KpiItem[] = [
    { label: `Pooled noise proxy${ctxTag}`, value: p.pooled === null ? "—" : fmt(p.pooled), unit: unit || undefined, sub: window, tone: "copper" },
    { label: "Relative pooled noise proxy", value: s.relativePooledPercent === null ? "—" : fmt(s.relativePooledPercent), unit: "%", sub: level === null ? "Typical signal level not computed" : "Of the typical absolute signal level", tone: "copper" },
    { label: "Typical signal level", value: level === null ? "—" : fmt(level), unit: unit || undefined, sub: "Median over spectra of mean |x|", tone: "grey" },
    { label: "Evaluable bands", value: p.nEvaluableBands ?? s.evaluable, sub: `of ${s.bands} bands (window edges excluded)`, bar: pctOf(p.nEvaluableBands ?? s.evaluable, s.bands), tone: "grey" },
  ];

  const markers = [{ label: "Median", value: toRel(s.median) }, { label: "P95", value: toRel(s.p95), tone: "copper" as const }].filter((m): m is { label: string; value: number; tone?: "copper" } => m.value !== null);
  const distributions: RubricBlock[] = [
    {
      id: "np-hist",
      title: `Per-band noise proxy distribution${ctxTag}`,
      subtitle: `${s.evaluable} evaluable bands · ${noiseUnit}`,
      node: <Histogram values={p.values.map(toRel)} binCount={24} markers={markers} xLabel={`Per-band noise proxy (${noiseUnit})`} yLabel="bands" title="Distribution of per-band noise proxy estimates" emptyMessage={`No evaluable band among ${s.bands}.`} f={(v, d) => fmt(v, d ?? 3)} height={170} />,
    },
    {
      id: "np-ratio",
      title: "Local noise-to-diversity ratio",
      node: (
        <>
          <ShareSummary
            headline={s.ratioEvaluable ? `${fmt((100 * s.substantialOrMore) / s.ratioEvaluable)} %` : null}
            headlineLabel="of evaluable bands at ≥ 0.30 × diversity"
            headlineSub={`Noise proxy / ${denom} · exploratory bands, not metrologically validated`}
            total={p.values.length}
            label={`Share of ${p.values.length} bands per exploratory noise-to-diversity category`}
            segments={[...ratioCounts.map((b) => ({ label: `${b.label} ${b.range}`, value: b.count, tone: b.tone })), { label: "Not evaluable", value: ratioNone, hatch: true }]}
          />
          <p className="rp-scale-ends"><span>Diversity dominates</span><span>Residual dominates</span></p>
        </>
      ),
    },
    ...(s.relativePooledPercent !== null ? [{
      id: "np-estimators",
      title: "Relative noise: two estimators",
      node: (
        <>
          <ValueBars unit="%" digits={3} axisLabel="% of the typical absolute signal level" rows={[
            { label: "Pooled SG noise proxy", value: s.relativePooledPercent, tone: "copper" as const, note: "per band, pooled over spectra" },
            { label: "SNR-derived (median)", value: snrPct, tone: "muted" as const, note: "second differences per spectrum" },
          ]} />
          <p className="cz-card-foot">The two can differ: pooling vs median, residual curvature and anomalies weigh on the SG proxy, not on the robust per-spectrum SNR.</p>
        </>
      ),
    }] : []),
  ];

  const regions = topRegions(source.axis, p.values);
  const bandTracks: Track[] = [
    {
      id: "np-noise",
      title: rel ? `Local noise proxy / typical signal${ctxTag}` : `Local noise proxy${ctxTag}`,
      unit: rel ? "%" : unit || undefined,
      includeZero: true,
      series: [{ id: "noise", label: "Noise proxy", values: p.values.map(toRel), color: "var(--cz-copper)" }],
      refLines: s.median !== null ? [{ y: toRel(s.median)!, label: "Median level" }] : [],
      nonEvaluable: p.nonEvaluable,
    },
    {
      id: "np-ratio",
      title: `Noise-to-diversity ratio (noise proxy / ${denom})${capped ? ` · axis to ${fmt(ratioCap, 2)}, max ${fmt(ratioMax, 3)}` : ""}`,
      height: 100,
      yDomain: [0, ratioCap],
      series: [{ id: "ratio", label: "Noise-to-diversity ratio", values: p.ratio, color: "var(--cz-blue)" }],
      refBands: [{ from: 1, to: ratioCap, label: "Exceeds diversity (exploratory)", fill: "rgba(180, 106, 46, .08)" }],
      refLines: [{ y: 1, label: "Ratio = 1" }, { y: 0.3, label: "0.30" }],
      nonEvaluable: p.ratio.map((v) => v === null),
      format: (v) => fmt(v, 3),
    },
  ];

  return {
    id: "noise_proxy",
    status: "computed",
    title,
    lead: NOISE_LEAD,
    kpis,
    comments: toComments(noiseComments([p], level, snrDb, source.axis, axisUnit, unit), "np"),
    distributions,
    bandTracks,
    markRegions: regions.map((r) => ({ i0: r.i0, i1: r.i1, label: `Highest noise-proxy region (top 10 % of bands): ${fmt(r.from, 5)}–${fmt(r.to, 5)}${axisUnit ? ` ${axisUnit}` : ""}` })),
    inspection: ({ selection }) => <ResidualInspection source={source} rows={p.rows} window={p.windowBands} polyorder={p.polyorder} unit={unit} axisLabel={axisLabel} selection={selection} />,
    details: {
      limitations: "An exploratory roughness proxy, not an instrumental noise measurement: real narrow features, curvature and systematic artifacts also enter the residuals.",
      methodology: (
        <>
          <p>Engine definition: per band, the RMS over spectra of the Savitzky–Golay smoothing residual (window {p.windowBands ?? "—"}, polynomial order {p.polyorder ?? "—"}), divided by the white-noise residual gain so that pure white noise of SD σ gives σ. Only interior bands whose whole window is valid are evaluated (no padding at the edges); a uniform axis is required.</p>
          <p>Relative pooled noise proxy = 100 × pooled proxy / typical absolute signal level, where the typical level is the median over spectra of the intrinsic mean absolute value (noise.signal_mean_abs). It is a ratio of two aggregated statistics, not the median of the individual relative noise.</p>
          <p>Why it can differ from the SNR-derived relative noise (100 × 10^(−SNR/20)): the SNR uses a robust second-difference estimate per spectrum and takes the median across spectra, while this proxy pools squared residuals over spectra and bands (outlying spectra and anomalies weigh more) and keeps any residual curvature the polynomial cannot follow.</p>
          <p>Noise-to-diversity ratio = per-band noise proxy / {denom}{p.diversityKind === "between-sample" ? ` (from the repeatability context ${p.diversityContext})` : " (SD across the spectra of this context; no replicate groups are declared for it)"}. Null where the denominator is zero or negligible (≤ 10⁻⁹ × the typical signal level), never infinite. The bands (&lt; 0.10, 0.10–0.30, 0.30–1.00, ≥ 1.00) are exploratory and non-linear; the ratio is neither an ICC nor a share of variance due to instrumental noise.</p>
        </>
      ),
      tables: (
        <ChartDataTable
          locale={scope.locale}
          caption={`Per-band noise proxy — ${p.id}`}
          columns={["Band", `Noise proxy${unit ? ` (${unit})` : ""}`, `${denom[0]!.toUpperCase()}${denom.slice(1)}${unit ? ` (${unit})` : ""}`, "Noise-to-diversity ratio"]}
          rows={source.axis.map((x, i) => [x, p.values[i] ?? null, p.diversity[i] ?? null, p.ratio[i] ?? null])}
        />
      ),
      investigate: [
        "Read the residual map: random speckle, vertical stripes shared by all spectra and isolated dots point to different causes.",
        "Check whether high-proxy regions match known narrow absorption features before treating them as noise.",
        "Declare technical replicates to measure repeatability directly.",
      ],
    },
    unavailable: null,
    contexts: profiles.map((q) => q.id),
  };
}
