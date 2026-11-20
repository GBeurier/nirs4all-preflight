// Repeatability across measurement contexts: each context's engine profiles (repeatability SD, ICC)
// overlaid on the shared spectral axis, plus a small summary table. Contexts are estimated separately by
// the engine and are never pooled here; the overlay only puts them side by side.
import type { InputSource } from "../../input";
import { Measured } from "../../Measured";
import { useSharedCursor } from "../overview/selection";
import { finite, quantile } from "../shared/derive";
import { AlignedTracks, type Track } from "./AlignedTracks";
import { fmt } from "./comments";
import { contextLabel } from "./contexts";
import type { RepeatProfile } from "./profiles";

const COLORS = ["var(--cz-copper)", "var(--cz-teal)", "var(--cz-blue)", "var(--cz-ink-2)", "var(--cz-copper-2)", "var(--cz-teal-2)"];
const DASH = [undefined, "6 3", "2 2", "8 3 2 3", "1 3", "10 4"];

export interface ContextRow {
  id: string;
  label: string;
  iccName: string;
  physicalSamples: number | null;
  observations: number | null;
  medianSd: number | null;
  medianIcc: number | null;
  p5Icc: number | null;
  evaluable: number;
  bands: number;
  /** Share (%) of evaluable ICC bands at ≥ 0.75 (indicative good to excellent); null without evaluable band. */
  goodShare: number | null;
}

/** Per-context summary: medians over bands of the engine series, with their denominators. */
export function contextRows(profiles: readonly RepeatProfile[]): ContextRow[] {
  return profiles.map((p) => {
    const icc = finite(p.icc ?? []);
    const c = p.context;
    return {
      id: c.id,
      label: contextLabel(c.repeatType, c.instrument ?? "", c.campaign ?? ""),
      iccName: p.iccKind === "icc_1_reml" ? "REML ICC(1)" : "ICC(1,1)",
      physicalSamples: p.uncertainty?.repeatCounts?.nGroups ?? c.physicalGroups,
      observations: c.observations,
      medianSd: quantile(p.sd, 0.5),
      medianIcc: quantile(icc, 0.5),
      p5Icc: quantile(icc, 0.05),
      evaluable: icc.length,
      bands: p.sd.length,
      goodShare: icc.length ? (100 * icc.filter((v) => v >= 0.75).length) / icc.length : null,
    };
  });
}

export function ContextComparison({ source, profiles, selectedId, axisLabel, unit, sourceId }: {
  source: InputSource;
  profiles: readonly RepeatProfile[];
  selectedId: string;
  axisLabel: string;
  unit: string;
  sourceId: string;
}) {
  const [cursor, setCursor] = useSharedCursor(sourceId);
  const rows = contextRows(profiles);
  const style = (i: number) => ({ color: COLORS[i % COLORS.length], dash: DASH[i % DASH.length] });
  const iccLow = Math.min(0, ...profiles.flatMap((p) => finite(p.icc ?? [])));
  const tracks: Track[] = [
    {
      id: "ctx-sd",
      title: "Repeatability SD per context",
      unit: unit || undefined,
      height: 110,
      includeZero: true,
      series: profiles.map((p, i) => ({ id: `sd${i}`, label: rows[i]!.label, values: p.sd, ...style(i) })),
    },
    {
      id: "ctx-icc",
      title: "ICC per context",
      height: 110,
      yDomain: [iccLow - 0.03, 1.02],
      refLines: [{ y: 0.75, label: "0.75 good" }, { y: 0.5, label: "0.50 moderate" }, ...(iccLow < 0 ? [{ y: 0, label: "0" }] : [])],
      series: profiles.map((p, i) => ({ id: `icc${i}`, label: rows[i]!.label, values: p.icc ?? [], ...style(i) })),
      format: (v) => fmt(v, 3),
    },
  ];
  const n = (v: number | null, d = 3) => (v === null ? "—" : fmt(v, d));
  return (
    <div className="rp-contexts">
      <Measured>{(w) => <AlignedTracks axis={source.axis} axisLabel={axisLabel} tracks={tracks} width={w} title="Repeatability SD and ICC per measurement context" cursor={cursor} onCursor={setCursor} />}</Measured>
      <div className="rp-table-scroll">
      <table className="rp-ref-table rp-context-table">
        <caption>Per-context summary (engine series; medians over bands)</caption>
        <thead>
          <tr><th>Context</th><th>Physical samples</th><th>Observations</th><th>Median repeatability SD{unit ? ` (${unit})` : ""}</th><th>Median ICC</th><th>ICC P5</th><th>Bands ICC ≥ 0.75</th><th>Evaluable ICC bands</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} aria-current={r.id === selectedId ? "true" : undefined}>
              <td>
                <svg width="22" height="10" aria-hidden="true"><line x1="0" x2="22" y1="5" y2="5" style={{ stroke: COLORS[i % COLORS.length] }} strokeWidth="2" strokeDasharray={DASH[i % DASH.length]} /></svg>{" "}
                {r.label}{r.id === selectedId ? <strong> (selected)</strong> : null}
              </td>
              <td>{r.physicalSamples ?? "—"}</td>
              <td>{r.observations ?? "—"}</td>
              <td>{n(r.medianSd)}</td>
              <td>{n(r.medianIcc)} <span className="hint">{r.iccName}</span></td>
              <td>{n(r.p5Icc)}</td>
              <td>{r.goodShare === null ? "—" : `${fmt(r.goodShare, 3)} %`}</td>
              <td>{r.evaluable} / {r.bands}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <p className="hint">ICC depends on the between-sample diversity of each context: a lower ICC with a similar repeatability SD can mean less diverse samples, not a worse instrument. Indicative ICC bands (Koo &amp; Li, 2016), not NIR criteria.</p>
    </div>
  );
}
