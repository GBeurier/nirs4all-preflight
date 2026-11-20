// Savitzky–Golay residual inspection (request §7 "Heatmap des résidus", chat §5): spectra × bands
// heatmap of signed residuals on a diverging scale centred on 0, median signed residual and robust
// spread per band, and raw / smoothed / residual spectra of picked rows. Smoothing = Methods kernel.
import { useEffect, useMemo, useRef, useState } from "react";
import type { InputSource } from "../../input";
import { Measured } from "../../Measured";
import { finite } from "../shared/derive";
import { AlignedTracks, TRACK_PAD, type BandRange, type Track } from "./AlignedTracks";
import { fmt } from "./comments";
import { capRows, computeResiduals, type ResidualResult } from "./residuals";

export const MAX_HEATMAP_SPECTRA = 300;
const PICK_COLORS = ["var(--cz-copper)", "var(--cz-teal)", "var(--cz-blue)", "var(--cz-ink-2)", "var(--cz-copper-2)"];
const PICK_DASH = [undefined, "5 3", "2 2", "8 3 2 3", "1 3"];

/** Diverging stops (negative → neutral → positive) read from the kit tokens, with fallbacks. */
const FALLBACK = { neg: "#3769a5", mid: "#eef1f4", pos: "#b54747" };

function parseColor(css: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (m) return [0, 2, 4].map((k) => parseInt(m[1]!.slice(k, k + 2), 16)) as [number, number, number];
  const r = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  return r ? [Number(r[1]), Number(r[2]), Number(r[3])] : null;
}

function divergingStops(el: Element | null) {
  const cs = el && typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  const pick = (name: string, fb: string) => parseColor(cs?.getPropertyValue(name) ?? "") ?? parseColor(fb)!;
  return { neg: pick("--cz-div-neg", FALLBACK.neg), mid: pick("--cz-div-mid", FALLBACK.mid), pos: pick("--cz-div-pos", FALLBACK.pos) };
}

/** Diverging colour for a residual, symmetric around 0 at ±`lim` (clipped beyond, stated in the legend). */
export function divergingColor(v: number, lim: number, stops = { neg: parseColor(FALLBACK.neg)!, mid: parseColor(FALLBACK.mid)!, pos: parseColor(FALLBACK.pos)! }): [number, number, number] {
  const t = lim > 0 ? Math.max(-1, Math.min(1, v / lim)) : 0;
  const end = t < 0 ? stops.neg : stops.pos;
  const a = Math.abs(t);
  return [0, 1, 2].map((k) => Math.round(stops.mid[k]! + (end[k]! - stops.mid[k]!) * a)) as [number, number, number];
}

function Heatmap({ result, height, selection, onPick }: { result: ResidualResult; height: number; selection: BandRange | null; onPick: (rowIndex: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const lim = useMemo(() => {
    const abs = finite(result.residual.flat()).map(Math.abs).sort((a, b) => a - b);
    return abs.length ? abs[Math.floor(0.98 * (abs.length - 1))]! : 0;
  }, [result]);
  const [theme, setTheme] = useState(0);
  const [stops, setStops] = useState(() => divergingStops(null));
  useEffect(() => {
    // Redraw when the app toggles light/dark.
    if (typeof MutationObserver === "undefined") return;
    const o = new MutationObserver(() => setTheme((k) => k + 1));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => o.disconnect();
  }, []);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const live = divergingStops(c);
    setStops(live);
    const na = parseColor(getComputedStyle(c).getPropertyValue("--cz-na")) ?? [195, 201, 207];
    const img = ctx.createImageData(result.axisLength, result.rows.length);
    result.residual.forEach((row, k) => row.forEach((v, j) => {
      const o = (k * result.axisLength + j) * 4;
      const [r, g, b] = v === null ? na : divergingColor(v, lim, live);
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }));
    ctx.putImageData(img, 0, 0);
  }, [result, lim, theme]);
  const p = result.axisLength;
  return (
    <figure className="rp-heat" style={{ marginLeft: TRACK_PAD.left, marginRight: TRACK_PAD.right }}>
      <span className="rp-heat-ylabel" aria-hidden="true">Spectra ({result.rows.length})</span>
      <div className="rp-heat-canvas">
        <canvas
          ref={ref}
          width={result.axisLength}
          height={result.rows.length}
          style={{ height }}
          role="img"
          aria-label={`Signed smoothing residuals, ${result.rows.length} spectra × ${result.axisLength} bands; diverging scale centred on 0, clipped at ±${fmt(lim)}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onPick(Math.min(result.rows.length - 1, Math.floor(((e.clientY - rect.top) / rect.height) * result.rows.length)));
          }}
        />
        {selection ? <span className="rp-heat-sel" style={{ left: `${(100 * selection.i0) / p}%`, width: `${Math.max(0.4, (100 * (selection.i1 - selection.i0 + 1)) / p)}%` }} aria-hidden="true" /> : null}
      </div>
      <figcaption className="rp-scale">
        <span>Negative (raw below smoothed)</span>
        {[-1, -0.66, -0.33, 0, 0.33, 0.66, 1].map((t) => <span key={t} className="rp-scale-step" style={{ background: `rgb(${divergingColor(t * lim, lim, stops).join(",")})` }} title={fmt(t * lim)} />)}
        <span>Positive</span>
        <span className="hint">±{fmt(lim)} (P98 of |residual|; beyond is saturated) · grey = not evaluable</span>
      </figcaption>
    </figure>
  );
}

/** Interpretation aid (chat §5): what a residual pattern may indicate. Never an automatic conclusion. */
export const RESIDUAL_PATTERNS = [
  ["Random fine-grained fluctuations", "High-frequency noise"],
  ["Vertical stripes shared by most spectra", "Real narrow spectral structure or a systematic artifact"],
  ["Isolated dots", "Spikes"],
  ["Horizontal streaks", "Individually noisy spectra"],
  ["Strong residuals at both ends", "Low instrumental sensitivity or filter edge effects"],
] as const;

export function ResidualInspection({ source, rows, window, polyorder, unit, axisLabel, selection }: {
  source: InputSource;
  rows: readonly number[];
  window: number | null;
  polyorder: number | null;
  unit: string;
  axisLabel: string;
  selection: BandRange | null;
}) {
  const [state, setState] = useState<{ status: "idle" | "running" | "error"; result: ResidualResult | null; error?: string }>({ status: "idle", result: null });
  const [picked, setPicked] = useState<number[]>([]);
  const [sortByRms, setSortByRms] = useState(false);
  // Computed automatically (capped rows, Methods WASM loaded lazily); a stale result is dropped.
  useEffect(() => {
    if (window === null || polyorder === null || !rows.length) return;
    let live = true;
    setState({ status: "running", result: null });
    setPicked([]);
    const timer = setTimeout(() => {
      computeResiduals(source, capRows(rows, MAX_HEATMAP_SPECTRA), window, polyorder)
        .then((result) => live && setState({ status: "idle", result }))
        .catch((e: unknown) => live && setState({ status: "error", result: null, error: e instanceof Error ? e.message : String(e) }));
    }, 50);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, rows, window, polyorder]);

  const res = state.result;
  const order = useMemo(() => (res ? (sortByRms ? res.rows.map((_, k) => k).sort((a, b) => (res.rowRms[b] ?? -1) - (res.rowRms[a] ?? -1)) : res.rows.map((_, k) => k)) : []), [res, sortByRms]);
  const ordered = useMemo<ResidualResult | null>(() => (res ? { ...res, residual: order.map((k) => res.residual[k]!), rows: order.map((k) => res.rows[k]!) } : null), [res, order]);
  const name = (k: number) => (res ? (source.observation_ids[res.rows[k]!] ?? `row ${res.rows[k]! + 1}`) : "");
  const pickedTracks: Track[] = res && picked.length ? [
    {
      id: "raw",
      title: "Raw (solid) and smoothed (dotted) spectra",
      unit,
      height: 140,
      series: picked.flatMap((k, i) => [
        { id: `raw${k}`, label: `${name(k)} raw`, values: res.raw[k]!, color: PICK_COLORS[i % PICK_COLORS.length] },
        { id: `sm${k}`, label: `${name(k)} smoothed`, values: res.smoothed[k]!, color: PICK_COLORS[i % PICK_COLORS.length], dash: "2 2" },
      ]),
    },
    {
      id: "res",
      title: "Signed residual (raw − smoothed)",
      unit,
      height: 110,
      refLines: [{ y: 0, label: "0" }],
      series: picked.map((k, i) => ({ id: `r${k}`, label: name(k), values: res.residual[k]!, color: PICK_COLORS[i % PICK_COLORS.length], dash: PICK_DASH[i % PICK_DASH.length] })),
    },
  ] : [];

  return (
    <section className="cz-card rp-residuals" aria-label="Smoothing residual heatmap">
      <header className="rp-sub-head">
        <h4>Smoothing residuals: noise or spectral information?</h4>
        <p className="hint">Residual = raw − Savitzky–Golay smoothed spectrum (Methods kernel, window {window ?? "—"}, order {polyorder ?? "—"}, as the engine proxy), signal units{rows.length > MAX_HEATMAP_SPECTRA ? `, ${MAX_HEATMAP_SPECTRA} of ${rows.length} spectra evenly sampled` : ""}. Structured residuals are not automatically noise.</p>
      </header>
      {window === null || polyorder === null ? <p className="cz-empty">Residuals unavailable: the engine did not report the smoothing window.</p> : null}
      {state.status === "running" ? <p className="cz-empty" role="status">Computing residuals for {Math.min(rows.length, MAX_HEATMAP_SPECTRA)} spectra…</p> : null}
      {state.status === "error" ? <p className="alert alert-warning" role="alert">Residuals unavailable: the Methods Savitzky–Golay kernel could not run ({state.error}).</p> : null}
      {res && ordered ? (
        <>
          <div className="rp-row">
            <label><input type="checkbox" checked={sortByRms} onChange={(e) => setSortByRms(e.target.checked)} /> Sort spectra by residual RMS (largest first)</label>
            <span className="hint">Click a row to compare its raw, smoothed and residual spectra (up to {PICK_COLORS.length}).</span>
          </div>
          <Heatmap result={ordered} height={Math.min(360, Math.max(150, res.rows.length * 2))} selection={selection} onPick={(k) => {
            const original = order[k]!;
            setPicked((cur) => (cur.includes(original) ? cur.filter((x) => x !== original) : [...cur, original].slice(-PICK_COLORS.length)));
          }} />
          <Measured>{(w) => <AlignedTracks axis={source.axis} axisLabel={axisLabel} width={w} title="Median signed residual and robust spread per band" selection={selection} markRegions={res.edge.map((r) => ({ ...r, label: "Edge effect: smoothing window truncated" }))} tracks={[
            { id: "med", title: "Median signed residual", unit, height: 90, refLines: [{ y: 0, label: "0" }], series: [{ id: "m", label: "Median signed residual", values: res.medianResidual, color: "var(--cz-teal)" }] },
            { id: "spread", title: "Robust residual spread (1.4826 × MAD)", unit, height: 90, includeZero: true, series: [{ id: "s", label: "Robust spread", values: res.spreadResidual, color: "var(--cz-copper)" }] },
          ]} />}</Measured>
          {pickedTracks.length ? <Measured>{(w) => <AlignedTracks axis={source.axis} axisLabel={axisLabel} tracks={pickedTracks} width={w} title="Raw, smoothed and residual spectra of the picked rows" markRegions={res.edge.map((r) => ({ ...r, label: "Edge effect" }))} />}</Measured> : null}
          <details className="rp-limits">
            <summary><strong>Reading the residual map</strong></summary>
            <table className="rp-ref-table">
              <thead><tr><th>Residual pattern</th><th>Possible interpretation</th></tr></thead>
              <tbody>{RESIDUAL_PATTERNS.map(([a, b]) => <tr key={a}><td>{a}</td><td>{b}</td></tr>)}</tbody>
            </table>
            <p>A marked structure in the median signed residual suggests a systematic contribution: inspect it before treating it as instrumental noise. Shaded ends: within half a window of the edge (window truncated; not evaluated by the engine). Backend: {res.backend}.</p>
          </details>
        </>
      ) : null}
    </section>
  );
}
