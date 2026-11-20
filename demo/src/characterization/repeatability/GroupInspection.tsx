// Interactive replicate inspection for a selected band or region (request §6 "Inspection interactive"):
// per physical sample, its measurements averaged over the selection, their mean and SD, and an
// overlay of the spectra of the chosen samples. Display-only statistics over the input cells.
import { useState } from "react";
import type { InputSource } from "../../input";
import { Measured } from "../../Measured";
import { finite, quantile, ratioToIcc } from "../shared/derive";
import { AlignedTracks, type BandRange, type Track } from "./AlignedTracks";
import { fmt } from "./comments";
import { cell, type RepeatGroup, type RepeatProfile } from "./profiles";

const GROUP_COLORS = ["var(--cz-copper)", "var(--cz-teal)", "var(--cz-blue)", "var(--cz-ink-2)", "var(--cz-copper-2)", "var(--cz-teal-2)"];
const GROUP_DASH = [undefined, "5 3", "2 2", "8 3 2 3", "1 3", "10 4"];
const MAX_GROUP_ROWS = 60;

/** ICC text: 4 decimals near ±1 so that 0.9996 is never shown as "1" (an ICC of exactly 1 means zero within-sample variance). */
export const iccText = (v: number) => (Math.abs(v) >= 0.99 && Math.abs(v) < 1 ? v.toFixed(4) : fmt(v, 3));

/** Mean of valid cells of row `r` over bands i0..i1 (null when none). */
export const rangeMean = (source: InputSource, r: number, i0: number, i1: number) => {
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

/** Per-group summary over a band range (sorted by mean). */
export function groupSummaries(source: InputSource, groups: readonly RepeatGroup[], sel: BandRange) {
  return groups.map((g) => {
    const vals = g.rows.map((r) => ({ r, v: rangeMean(source, r, sel.i0, sel.i1) }));
    const xs = finite(vals.map((x) => x.v));
    const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const sd = xs.length >= 2 && mean !== null ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : null;
    return { id: g.id, vals, mean, sd, n: xs.length };
  }).sort((a, b) => (a.mean ?? Infinity) - (b.mean ?? Infinity));
}

/** Strip plot: one row per physical sample, its repeats as dots and its mean as a tick. */
function RepeatStrip({ rows, unit }: { rows: ReturnType<typeof groupSummaries>; unit: string }) {
  const all = finite(rows.flatMap((g) => g.vals.map((x) => x.v)));
  if (!all.length) return null;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const shown = rows.slice(0, 24);
  return (
    <Measured>{(width) => {
      const L = 90;
      const R = 12;
      const rowH = 14;
      const iw = Math.max(60, width - L - R);
      const x = (v: number) => L + ((v - lo) / (hi - lo || 1)) * iw;
      const h = shown.length * rowH + 30;
      return (
        <svg className="cz-svg" width={width} height={h} role="img" aria-label={`Repeats of ${shown.length} physical samples over the selection`}>
          {shown.map((g, i) => {
            const y = 8 + i * rowH;
            return (
              <g key={g.id} className="cz-tone-teal">
                <text x={L - 6} y={y + 4} textAnchor="end" className="cz-t-axis">{g.id.length > 12 ? `${g.id.slice(0, 11)}…` : g.id}</text>
                <line x1={L} x2={L + iw} y1={y} y2={y} className="cz-grid" />
                {g.vals.map((v) => (v.v === null ? null : <circle key={v.r} cx={x(v.v)} cy={y} r={3.2} className="cz-fill" opacity={0.75} />))}
                {g.mean !== null ? <line x1={x(g.mean)} x2={x(g.mean)} y1={y - 5} y2={y + 5} className="cz-stroke cz-tone-copper" strokeWidth={2} /> : null}
              </g>
            );
          })}
          <text x={L} y={h - 4} className="cz-t-axis">{fmt(lo, 4)}</text>
          <text x={L + iw} y={h - 4} textAnchor="end" className="cz-t-axis">{fmt(hi, 4)}{unit ? ` ${unit}` : ""}</text>
          <text x={L + iw / 2} y={h - 4} textAnchor="middle" className="cz-t-axis">dots = repeats · bar = sample mean</text>
        </svg>
      );
    }}</Measured>
  );
}

export function GroupInspection({ source, profile, groups, selection, axisLabel, unit }: {
  source: InputSource;
  profile: RepeatProfile;
  groups: readonly RepeatGroup[];
  selection: BandRange | null;
  axisLabel: string;
  unit: string;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  if (!selection) return <p className="hint rp-hint">Click a band or drag over a region in the tracks to inspect the repeats of each physical sample.</p>;
  const sel = selection;
  const exact = profile.betweenKind !== "approximate";
  const iccs = finite((profile.icc ?? []).slice(sel.i0, sel.i1 + 1));
  const medIcc = quantile(iccs, 0.5);
  // Same convention as the rubric KPI: ANOVA R from the median ICC (negative ICC → no R), REML median of exact R.
  const ratio = profile.betweenKind === "anova" ? (medIcc === null || medIcc < 0 || medIcc >= 1 ? null : Math.sqrt(medIcc / (1 - medIcc))) : quantile(profile.ratio.slice(sel.i0, sel.i1 + 1), 0.5);
  const negative = iccs.filter((v) => v < 0).length;
  const bands = sel.i1 - sel.i0 + 1;
  const rows = groupSummaries(source, groups, sel);
  const shown = chosen.length ? groups.filter((g) => chosen.includes(g.id)) : [];
  const overlay: Track[] = shown.length ? [{
    id: "overlay",
    title: "Spectra of the chosen physical samples",
    unit,
    height: 150,
    series: shown.flatMap((g, gi) => g.rows.map((r) => ({ id: `${g.id}-${r}`, label: g.id, values: source.x[r]!.map((_, c) => cell(source, r, c)), color: GROUP_COLORS[gi % GROUP_COLORS.length], dash: GROUP_DASH[gi % GROUP_DASH.length] }))),
  }] : [];
  const span = `${fmt(source.axis[sel.i0]!, 5)}${sel.i1 > sel.i0 ? `–${fmt(source.axis[sel.i1]!, 5)}` : ""}${source.axis_unit ? ` ${source.axis_unit}` : ""}`;
  return (
    <section className="cz-card rp-inspect" aria-label="Replicate inspection">
      <h4>Repeats in {span} <span className="hint">({bands} band{bands > 1 ? "s" : ""})</span></h4>
      <p>
        Median ICC {medIcc === null ? "—" : iccText(medIcc)}{negative ? ` (${negative} negative band${negative > 1 ? "s" : ""}, unclipped)` : ""}.
        {exact && ratio !== null ? ` Between-sample spectral variability is approximately ${fmt(ratio, 2)} times greater than within-sample measurement variability in the selected wavelength region (ICC = R²/(1 + R²) = ${iccText(ratioToIcc(ratio))}).` : ""}
      </p>
      <RepeatStrip rows={rows} unit={unit} />
      <table className="rp-groups">
        <caption className="visually-hidden">Repeats per physical sample over the selected bands</caption>
        <thead><tr><th>Physical sample</th><th>n</th><th>Measurements</th><th>Mean</th><th>SD</th></tr></thead>
        <tbody>
          {rows.slice(0, MAX_GROUP_ROWS).map((g) => (
            <tr key={g.id} aria-selected={chosen.includes(g.id)} onClick={() => setChosen((c) => (c.includes(g.id) ? c.filter((x) => x !== g.id) : [...c, g.id].slice(-GROUP_COLORS.length)))}>
              <td>{g.id}</td><td>{g.n}</td><td>{g.vals.map((x) => (x.v === null ? "—" : fmt(x.v, 4))).join(" · ")}</td><td>{g.mean === null ? "—" : fmt(g.mean, 4)}</td><td>{g.sd === null ? "—" : fmt(g.sd, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{rows.length > MAX_GROUP_ROWS ? `First ${MAX_GROUP_ROWS} of ${rows.length} physical samples (sorted by mean). ` : ""}Click rows to overlay their spectra (up to {GROUP_COLORS.length}).</p>
      {overlay.length ? <Measured>{(w) => <AlignedTracks axis={source.axis} axisLabel={axisLabel} tracks={overlay} width={w} title="Spectra of the chosen physical samples" domain={sel.i1 > sel.i0 ? [source.axis[Math.max(0, sel.i0 - 5)]!, source.axis[Math.min(source.axis.length - 1, sel.i1 + 5)]!] : undefined} selection={sel} />}</Measured> : null}
    </section>
  );
}
