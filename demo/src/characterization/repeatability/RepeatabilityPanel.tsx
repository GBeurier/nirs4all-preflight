// Per-band technical repeatability (request §6): aligned median/envelope, SD and ICC tracks, band-share
// bar, R correspondence and interactive replicate inspection. Values come from the engine report.
import { useMemo, useState } from "react";
import { ChartDataTable, StatTile, formatEngineNumber } from "nirs4all-ui/qualification";
import type { Scope } from "../../Sections";
import { Measured } from "../../Measured";
import { finite, iccToRatio, quantile, ratioToIcc } from "../shared/derive";
import { AlignedTracks, type BandRange, type Track } from "./AlignedTracks";
import { fmt, repeatStats, repeatabilityComments } from "./comments";
import { bandEnvelope, cell, contextGroups, repeatProfiles, type RepeatProfile } from "./profiles";
import { NO_REPLICATES_MESSAGE } from "./summary";
import { DiagnosticBlock, HATCH, StackedShareBar } from "./ui";

export const REPEAT_LEAD = "Assess how closely repeated measurements of the same physical sample agree at each wavelength. Compare within-sample measurement variability with between-sample spectral diversity to identify regions where sample differences are distinguishable from technical measurement variation.";
export const REPEAT_WARNING = "High ICC indicates good repeatability relative to sample diversity. Low ICC may reflect limited between-sample variability rather than poor absolute measurement repeatability.";
export const NOISE_PROXY_STILL_AVAILABLE = "The per-band noise proxy remains available below, but it does not replace an experimental measurement of repeatability.";

/** Indicative ICC bands (Koo & Li, 2016): general ICC conventions, not NIR instrument criteria. */
export const KOO_LI_BANDS = [
  { id: "poor", label: "Poor (< 0.50)", from: -Infinity, to: 0.5, color: "#fde68a" },
  { id: "moderate", label: "Moderate (0.50–0.75)", from: 0.5, to: 0.75, color: "#bae6fd" },
  { id: "good", label: "Good (0.75–0.90)", from: 0.75, to: 0.9, color: "#7dd3fc" },
  { id: "excellent", label: "Excellent (≥ 0.90)", from: 0.9, to: Infinity, color: "#38bdf8" },
] as const;

const SD_COLOR = "#0f766e";
const SB_COLOR = "#7c3aed";
const GROUP_COLORS = ["#0f766e", "#7c3aed", "#b45309", "#2563eb", "#be185d", "#4d7c0f"];
const GROUP_DASH = [undefined, "5 3", "2 2", "8 3 2 3", "1 3", "10 4"];
const MAX_GROUP_ROWS = 60;

/** Band shares per indicative ICC category plus the non-evaluable category. */
export function iccShares(p: RepeatProfile) {
  const counts = { poor: 0, moderate: 0, good: 0, excellent: 0, none: 0 };
  p.categories.forEach((c) => (c ? counts[c]++ : counts.none++));
  return counts;
}

/** Mean of valid cells of row `r` over bands i0..i1 (null when none). */
const rangeMean = (source: Scope["input"]["sources"][number], r: number, i0: number, i1: number) => {
  let s = 0;
  let n = 0;
  for (let c = i0; c <= i1; c++) {
    const v = cell(source, r, c);
    if (v !== null) {
      s += v;
      n++;
    }
  }
  return n ? s / n : null;
};

export function RepeatabilityPanel(props: Scope & { onOpenSettings?: () => void }) {
  const { view, input, sourceId, locale, onOpenSettings } = props;
  const source = input.sources.find((s) => s.source_id === sourceId);
  const profiles = useMemo(() => (sourceId ? repeatProfiles(view, sourceId) : []), [view, sourceId]);
  const [ctxIndex, setCtxIndex] = useState(0);
  const [selection, setSelection] = useState<BandRange | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const p = profiles[Math.min(ctxIndex, profiles.length - 1)];
  const groups = useMemo(() => (source && p ? contextGroups(input, source, p.context) : []), [input, source, p]);
  const envelope = useMemo(() => (source && groups.length ? bandEnvelope(source, groups.flatMap((g) => g.rows)) : null), [source, groups]);
  const n = (v: number | null, d = 3) => (v === null || !Number.isFinite(v) ? "—" : (formatEngineNumber(v, locale, d) ?? fmt(v, d)));

  if (!source) return null;
  if (!p) {
    return (
      <div className="card rp-block" data-testid="repeat-none">
        <h3 className="card-title">Per-band technical repeatability</h3>
        <p className="rp-lead">{REPEAT_LEAD}</p>
        <div className="rp-empty" role="status">
          <p>{NO_REPLICATES_MESSAGE}</p>
          {onOpenSettings ? <button type="button" className="btn btn-outline btn-sm" onClick={onOpenSettings}>Open dataset settings</button> : null}
          <p className="hint">{NOISE_PROXY_STILL_AVAILABLE}</p>
        </div>
      </div>
    );
  }

  const unit = p.context.unit ?? source.signal_unit ?? "";
  const axisLabel = `${source.axis_unit ? "Spectral axis" : "Band"}${source.axis_unit ? ` (${source.axis_unit})` : ""}`;
  const s = repeatStats(p);
  const rc = p.uncertainty?.repeatCounts;
  const shares = iccShares(p);
  const iccName = p.iccKind === "icc_1_reml" ? "ICC(1) REML" : "ICC(1,1)";
  const exactModel = p.iccKind === "icc_1_1";
  const iccVals = finite(p.icc ?? []);
  const iccMin = iccVals.length ? Math.min(0, ...iccVals) : 0;
  const tracks: Track[] = [
    {
      id: "spectrum",
      title: "Median spectrum and P5–P95 envelope",
      unit,
      series: envelope ? [{ id: "median", label: "Median", values: envelope.median, color: "#334155" }] : [],
      envelopes: envelope ? [{ id: "env", label: "P5–P95", lower: envelope.p5, upper: envelope.p95, color: "#64748b" }] : [],
    },
    {
      id: "sd",
      title: "Repeatability SD and between-sample SD",
      unit,
      includeZero: true,
      series: [
        { id: "sw", label: "Repeatability SD (within-sample)", values: p.sd, color: SD_COLOR },
        { id: "sb", label: `Between-sample SD${exactModel ? "" : " (approx.)"}`, values: p.betweenSd, color: SB_COLOR, dash: "5 3" },
      ],
      envelopes: p.context.sdInterval ? [{ id: "sdci", label: "Repeatability SD interval", lower: p.context.sdInterval.lower, upper: p.context.sdInterval.upper, color: SD_COLOR }] : [],
      nonEvaluable: p.sd.map((v) => v === null),
    },
    {
      id: "icc",
      title: `${iccName} per band`,
      height: 130,
      yDomain: [Math.min(iccMin, quantile(p.context.iccInterval?.lower ?? [], 0) ?? 0, 0) - 0.02, 1.02],
      series: [{ id: "icc", label: iccName, values: p.icc ?? [], color: "#0369a1" }],
      envelopes: p.context.iccInterval ? [{ id: "iccci", label: "ICC interval", lower: p.context.iccInterval.lower, upper: p.context.iccInterval.upper, color: "#0369a1" }] : [],
      refBands: KOO_LI_BANDS.map((b) => ({ from: Math.max(b.from, -10), to: Math.min(b.to, 1.02), label: `${b.label} — indicative`, fill: `${b.color}55` })),
      refLines: iccMin < 0 ? [{ y: 0, label: "0" }] : [],
      nonEvaluable: p.nonEvaluable,
      format: (v) => fmt(v, 3),
    },
  ];

  // Selection inspection: per physical sample, the mean of each measurement over the selected bands.
  const sel = selection;
  const selStats = sel ? (() => {
    const r = finite(p.ratio.slice(sel.i0, sel.i1 + 1));
    const icc = finite((p.icc ?? []).slice(sel.i0, sel.i1 + 1));
    return { ratio: quantile(r, 0.5), icc: quantile(icc, 0.5), negative: icc.filter((v) => v < 0).length, bands: sel.i1 - sel.i0 + 1 };
  })() : null;
  const groupRows = sel ? groups.map((g) => {
    const vals = g.rows.map((r) => ({ r, v: rangeMean(source, r, sel.i0, sel.i1) }));
    const xs = finite(vals.map((x) => x.v));
    const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const sd = xs.length >= 2 && mean !== null ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : null;
    return { id: g.id, vals, mean, sd, n: xs.length };
  }).sort((a, b) => (a.mean ?? Infinity) - (b.mean ?? Infinity)) : [];
  const shownGroups = chosen.length ? groups.filter((g) => chosen.includes(g.id)) : [];
  const overlay: Track[] = shownGroups.length ? [{
    id: "overlay",
    title: "Spectra of the selected physical samples",
    unit,
    height: 160,
    series: shownGroups.flatMap((g, gi) => g.rows.map((r, k) => ({ id: `${g.id}-${r}`, label: `${g.id} · ${source.observation_ids[r] ?? `row ${r + 1}`}${k === 0 ? "" : ""}`, values: source.x[r]!.map((_, c) => cell(source, r, c)), color: GROUP_COLORS[gi % GROUP_COLORS.length], dash: GROUP_DASH[gi % GROUP_DASH.length] }))),
  }] : [];

  return (
    <DiagnosticBlock
      title="Per-band technical repeatability"
      lead={REPEAT_LEAD}
      metrics={<>
        <StatTile label="Median repeatability SD" value={n(s.medianSd)} suffix={unit || undefined} hint="Pooled within-sample SD, median over bands" />
        <StatTile label={`Median ${iccName}`} value={n(s.medianIcc)} hint={`Over ${s.evaluable} evaluable bands`} />
        <StatTile label="ICC P5" value={n(s.p5Icc)} hint="5% of evaluable bands fall below" />
        <StatTile label="Evaluable bands" value={`${s.evaluable} / ${s.bands}`} hint={s.bands ? `${((100 * s.evaluable) / s.bands).toFixed(1)}% of bands` : undefined} />
        <StatTile label="Physical samples" value={n(rc?.nGroups ?? p.context.physicalGroups ?? null)} hint={rc ? `${rc.nRepeatedGroups ?? "—"} with ≥ 2 repeats · r ${rc.rMin ?? "—"}–${rc.rMax ?? "—"} (median ${rc.rMedian ?? "—"})` : `${p.context.observations ?? "—"} observations`} />
        {exactModel && s.medianRatio !== null ? <StatTile label="Median R = σb/σw" value={n(s.medianRatio)} hint="Between-sample over within-sample SD" /> : null}
      </>}
      comments={repeatabilityComments([p], source.axis, source.axis_unit ?? "")}
      limitations={`${iccName}: one-way random-effects model, absolute agreement of a single measurement, for this measurement context only (${p.context.id || "default context"}).`}
      details={<>
        <p>Model: x = μ + b(sample) + e, b ~ N(0, σb²), e ~ N(0, σw²), repeats exchangeable within each physical sample and σw homogeneous across samples. Repeatability SD = √MSW (pooled within-sample SD); {exactModel ? "ICC(1,1) = (MSB − MSW)/(MSB + (r − 1)·MSW) for balanced groups of size r" : "REML ICC(1) for unbalanced groups (the balanced ICC(1,1) is undefined)"}. Physical samples come from the declared physical sample identifiers (else sample identifiers); repeats are the rows declared as {p.context.repeatType ?? "technical"} repeats in this context. Biological repeats, instruments, sessions and operators are separate contexts and are never pooled.</p>
        <p>Between-sample SD is derived from the engine values in the same model: σb = σw·√(ICC/(1 − ICC)) = √((MSB − MSW)/r), defined for 0 ≤ ICC &lt; 1 (shown as a gap otherwise){exactModel ? "" : "; with the REML ICC it combines the REML ratio with the ANOVA pooled SD and is approximate"}. Negative ICC estimates (MSB &lt; MSW) are kept unclipped.</p>
        <p>ICC bands follow general ICC interpretation conventions (Koo &amp; Li, 2016); they are indicative and not NIR instrument criteria.</p>
        {exactModel ? (
          <table className="rp-ref-table"><caption>ICC = R²/(1 + R²), R = σb/σw (one-way model)</caption><thead><tr><th>ICC</th><th>R</th></tr></thead><tbody>
            {[0.5, 0.75, 0.9, 0.99].map((k) => <tr key={k}><td>{k}</td><td>{fmt(iccToRatio(k)!, 3)}</td></tr>)}
          </tbody></table>
        ) : null}
      </>}
      investigate={[
        "Select a band or region in the tracks to inspect the individual repeats of each physical sample.",
        "Compare contexts (repeat type, instrument, campaign) before pooling them.",
        "Where ICC is low but repeatability SD is small, check whether the samples simply differ little in that region.",
      ]}
    >
      <p className="rp-warning" role="note">{REPEAT_WARNING}</p>
      {profiles.length > 1 ? (
        <div className="seg" role="group" aria-label="Measurement context">
          {profiles.map((q, i) => <button key={q.context.id} type="button" aria-pressed={i === ctxIndex} onClick={() => { setCtxIndex(i); setSelection(null); setChosen([]); }}>{q.context.id || `Context ${i + 1}`}</button>)}
        </div>
      ) : null}
      <Measured>{(w) => <AlignedTracks axis={source.axis} axisLabel={axisLabel} tracks={tracks} width={w} title={`Per-band repeatability — ${source.source_id} — ${p.context.id}`} selection={selection} onSelect={(r) => { setSelection(r); setChosen([]); }} />}</Measured>
      <StackedShareBar
        caption={`Share of bands per indicative ${iccName} category (Koo & Li, 2016)`}
        total={s.bands}
        segments={[
          ...KOO_LI_BANDS.map((b) => ({ id: b.id, label: `${b.label}${b.id === "poor" && s.negative ? `, incl. ${s.negative} negative` : ""}`, count: shares[b.id], color: b.color })),
          { id: "none", label: "Not evaluable", count: shares.none, color: "#e2e8f0", pattern: HATCH },
        ]}
      />
      {sel && selStats ? (
        <div className="rp-inspect">
          <h4>Selected region: {fmt(source.axis[sel.i0]!, 5)}{sel.i1 > sel.i0 ? `–${fmt(source.axis[sel.i1]!, 5)}` : ""}{source.axis_unit ? ` ${source.axis_unit}` : ""} ({selStats.bands} band{selStats.bands > 1 ? "s" : ""})</h4>
          <p>
            Median {iccName} {n(selStats.icc)}{selStats.negative ? ` (${selStats.negative} negative band${selStats.negative > 1 ? "s" : ""})` : ""}.
            {exactModel && selStats.ratio !== null ? ` Between-sample spectral variability is approximately ${fmt(selStats.ratio, 2)} times greater than within-sample measurement variability in the selected wavelength region (ICC = R²/(1 + R²) = ${fmt(ratioToIcc(selStats.ratio), 3)}).` : ""}
          </p>
          <p className="hint">Each row is one physical sample: its measurements averaged over the selected bands, their mean and SD. Click rows to overlay their spectra (up to {GROUP_COLORS.length}).</p>
          <table className="rp-groups">
            <caption className="visually-hidden">Replicates per physical sample over the selected bands</caption>
            <thead><tr><th>Physical sample</th><th>n</th><th>Measurements</th><th>Mean</th><th>SD</th></tr></thead>
            <tbody>
              {groupRows.slice(0, MAX_GROUP_ROWS).map((g) => (
                <tr key={g.id} aria-selected={chosen.includes(g.id)} onClick={() => setChosen((c) => (c.includes(g.id) ? c.filter((x) => x !== g.id) : [...c, g.id].slice(-GROUP_COLORS.length)))} style={{ cursor: "pointer" }}>
                  <td>{g.id}</td><td>{g.n}</td><td>{g.vals.map((x) => n(x.v, 4)).join(" · ")}</td><td>{n(g.mean, 4)}</td><td>{n(g.sd, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {groupRows.length > MAX_GROUP_ROWS ? <p className="hint">First {MAX_GROUP_ROWS} of {groupRows.length} physical samples (sorted by mean).</p> : null}
          {overlay.length ? <Measured>{(w) => <AlignedTracks axis={source.axis} axisLabel={axisLabel} tracks={overlay} width={w} title="Spectra of the selected physical samples" domain={sel.i1 > sel.i0 ? [source.axis[Math.max(0, sel.i0 - 5)]!, source.axis[Math.min(source.axis.length - 1, sel.i1 + 5)]!] : undefined} selection={sel} />}</Measured> : null}
          {overlay.length ? <ul className="n4q-legend">{shownGroups.map((g, gi) => <li key={g.id}><span className="n4q-key-line" style={{ background: GROUP_COLORS[gi % GROUP_COLORS.length] }} aria-hidden="true" />{g.id}{GROUP_DASH[gi % GROUP_DASH.length] ? " (dashed)" : ""}</li>)}</ul> : null}
        </div>
      ) : <p className="hint">Select a band (click) or a region (drag) to inspect the repeats of each physical sample.</p>}
      <ChartDataTable
        locale={locale}
        caption={`Per-band repeatability — ${p.context.id}`}
        columns={["Band", `Repeatability SD${unit ? ` (${unit})` : ""}`, `Between-sample SD${unit ? ` (${unit})` : ""}`, iccName, "R = σb/σw"]}
        rows={source.axis.map((x, i) => [x, p.sd[i] ?? null, p.betweenSd[i] ?? null, p.icc?.[i] ?? null, exactModel ? (p.ratio[i] ?? null) : null])}
      />
    </DiagnosticBlock>
  );
}
