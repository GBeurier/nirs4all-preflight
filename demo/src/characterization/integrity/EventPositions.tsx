// Event positions (interim local recomputation, see populationEvents.ts): spectra × wavelength map
// of the flagged positions (isolated peaks vs abrupt changes, clickable, zoomable), markers on the
// inspected spectra, merging of contiguous flags into physical events, max score per spectrum and an
// adjustable inspection threshold. The engine's reported counts stay the reference.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChartDataTable, extractIntrinsic } from "nirs4all-ui/qualification";
import type { Scope } from "../../Sections";
import type { InputSource } from "../../input";
import { ChartCard, EmptyState, Responsive, useWidth } from "../shared/charts";
import type { BandSelection } from "../repeatability/AlignedTracks";
import { computeEvents, type EventsResult } from "./inspection-client";
import { MERGE_GAP, engineMatrix, mergeEvents, perSpectrum, type EventKind, type PhysicalEvent, type SpectrumEvents } from "./populationEvents";

export const PROVENANCE = "Computed locally in the demo (interim, mirrors Methods spectral_population_events_qc; validated against the engine counts).";
const KIND_NAME: Record<EventKind, string> = { spike: "isolated peak", jump: "abrupt change" };
const MAX_ROWS = 80;
const MAX_LINES = 6;
const PAD = { left: 64, right: 12, top: 8, bottom: 26 };
const LINE_COLORS = ["var(--cz-ink)", "var(--cz-blue)", "var(--cz-copper-2)", "var(--cz-teal-2)", "var(--cz-ink-3)", "var(--cz-accent)"];

/** Stable per-report key (the worker caches one dataset's derivatives). */
const viewIds = new WeakMap<object, number>();
let viewCounter = 0;
const viewKey = (view: object) => {
  if (!viewIds.has(view)) viewIds.set(view, ++viewCounter);
  return viewIds.get(view)!;
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface LocalEvents {
  status: "unavailable" | "running" | "done" | "error";
  error?: string;
  engineThreshold: number;
  threshold: number;
  setThreshold: (t: number) => void;
  /** engine population (development real observations), in report order */
  ids: readonly string[];
  result: EventsResult | null;
  merged: PhysicalEvent[];
  spectra: SpectrumEvents[];
  /** local counts at the engine threshold equal the engine's per-spectrum counts (null until known) */
  matchesEngine: boolean | null;
}

const sameCounts = (a: readonly (number | null)[], b: readonly (number | null)[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function useLocalEvents(scope: Scope, engineThreshold: number): LocalEvents {
  const { view, input, sourceId } = scope;
  const source = input.sources.find((s) => s.source_id === sourceId);
  const intrinsic = useMemo(() => (sourceId ? extractIntrinsic(view, sourceId) : null), [view, sourceId]);
  const spikeSignal = intrinsic?.signals["events.spike_count"];
  const jumpSignal = intrinsic?.signals["events.jump_count"];
  const ready = spikeSignal?.state.status === "computed" && !!source;
  const ids = useMemo(() => (ready ? spikeSignal!.observationIds : []), [ready, spikeSignal]);
  const physical = input.options.intrinsic_qc?.axis_basis === "physical";
  const key = `${viewKey(view)}:${sourceId}:${physical ? "physical" : "index"}`;
  const [threshold, setThreshold] = useState(engineThreshold);
  useEffect(() => setThreshold(engineThreshold), [engineThreshold, key]);
  const debounced = useDebounced(threshold, 250);
  const [state, setState] = useState<{ status: LocalEvents["status"]; result: EventsResult | null; error?: string }>({ status: ready ? "running" : "unavailable", result: null });
  useEffect(() => {
    if (!ready || !source) {
      setState({ status: "unavailable", result: null });
      return;
    }
    let live = true;
    setState((s) => ({ status: "running", result: s.result?.key === key ? s.result : null }));
    computeEvents(key, () => engineMatrix(source, ids, { physical }).matrix, debounced, engineThreshold)
      .then((result) => { if (live) setState({ status: "done", result }); })
      .catch((e: unknown) => { if (live) setState({ status: "error", result: null, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [ready, source, ids, physical, key, debounced, engineThreshold]);
  const result = state.result;
  const merged = useMemo(() => (result ? mergeEvents(result.spike, result.jump) : []), [result]);
  const spectra = useMemo(() => perSpectrum(merged), [merged]);
  const matchesEngine = result && spikeSignal && jumpSignal ? sameCounts(result.atEngine.spike, spikeSignal.values) && sameCounts(result.atEngine.jump, jumpSignal.values) : null;
  return { status: state.status, ...(state.error ? { error: state.error } : {}), engineThreshold, threshold, setThreshold, ids, result, merged, spectra, matchesEngine };
}

// --- drawing helpers ------------------------------------------------------------------------------

function cssColor(el: Element | null, name: string, fallback: string): string {
  const v = el && typeof getComputedStyle === "function" ? getComputedStyle(el).getPropertyValue(name).trim() : "";
  return v || fallback;
}

/** Spike = upward triangle, jump = square: the shape carries the type, the colour only repeats it. */
function drawMark(ctx: CanvasRenderingContext2D, kind: EventKind, x: number, y: number, s: number) {
  ctx.beginPath();
  if (kind === "spike") {
    ctx.moveTo(x, y - s / 2);
    ctx.lineTo(x + s / 2, y + s / 2);
    ctx.lineTo(x - s / 2, y + s / 2);
    ctx.closePath();
  } else {
    ctx.rect(x - s / 2.6, y - s / 2.6, s / 1.3, s / 1.3);
  }
  ctx.fill();
}

export function MarkGlyph({ kind, size = 10 }: { kind: EventKind; size?: number }) {
  const h = size / 2;
  return (
    <svg width={size} height={size} viewBox={`${-h} ${-h} ${size} ${size}`} aria-hidden="true" className="ig-glyph">
      {kind === "spike" ? <path d={`M0 ${-h}L${h} ${h}L${-h} ${h}Z`} fill="var(--cz-copper)" /> : <rect x={-h * 0.77} y={-h * 0.77} width={h * 1.54} height={h * 1.54} fill="var(--cz-teal)" />}
    </svg>
  );
}

function axisTicks(axis: readonly number[], z0: number, z1: number, count = 5): number[] {
  if (z1 <= z0) return [z0];
  return Array.from({ length: count }, (_, k) => Math.round(z0 + ((z1 - z0) * k) / (count - 1)));
}

// --- spectra × wavelength event map -------------------------------------------------------------

interface MapProps {
  width: number;
  axis: readonly number[];
  axisUnit: string;
  rows: readonly SpectrumEvents[];
  labels: readonly string[];
  result: EventsResult;
  zoom: [number, number];
  selected: number | null;
  onPick: (row: number, band: number | null) => void;
  onZoom: (range: [number, number] | null) => void;
  f: (v: number, d?: number) => string;
}

function EventMap({ width, axis, axisUnit, rows, labels, result, zoom, selected, onPick, onZoom, f }: MapProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const [theme, setTheme] = useState(0);
  const rowH = Math.max(6, Math.min(16, Math.floor(400 / Math.max(1, rows.length))));
  const plotW = Math.max(60, width - PAD.left - PAD.right);
  const plotH = rows.length * rowH;
  const height = plotH + PAD.top + PAD.bottom;
  const [z0, z1] = zoom;
  const span = Math.max(1, z1 - z0);
  const xOf = (band: number) => PAD.left + ((band - z0 + 0.5) / (span + 1)) * plotW;
  const bandAt = (px: number) => Math.max(z0, Math.min(z1, Math.floor(z0 + ((px - PAD.left) / plotW) * (span + 1))));
  const rowIndex = useMemo(() => new Map(rows.map((r, k) => [r.row, k])), [rows]);
  const flags = useMemo(() => {
    const out: { k: number; band: number; kind: EventKind; score: number }[] = [];
    for (const [e, kind] of [[result.spike, "spike"], [result.jump, "jump"]] as const) {
      for (let t = 0; t < e.rows.length; t++) {
        const k = rowIndex.get(e.rows[t]!);
        if (k !== undefined) out.push({ k, band: e.bands[t]!, kind, score: e.scores[t]! });
      }
    }
    return out;
  }, [result, rowIndex]);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const o = new MutationObserver(() => setTheme((k) => k + 1));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => o.disconnect();
  }, []);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const ink3 = cssColor(c, "--cz-ink-3", "#7b8a99");
    const grid = cssColor(c, "--cz-grid", "#e8edf1");
    const sel = cssColor(c, "--cz-sel", "rgba(63,127,132,.14)");
    const copper = cssColor(c, "--cz-copper", "#b46a2e");
    const teal = cssColor(c, "--cz-teal", "#3f7f84");
    const bar = cssColor(c, "--cz-track", "#eef1f4");
    // row stripes, selected row, merged event spans
    rows.forEach((r, k) => {
      const y = PAD.top + k * rowH;
      if (r.row === selected) {
        ctx.fillStyle = sel;
        ctx.fillRect(PAD.left, y, plotW, rowH);
      } else if (k % 2) {
        ctx.fillStyle = grid;
        ctx.fillRect(PAD.left, y, plotW, rowH);
      }
      ctx.fillStyle = bar;
      for (const e of r.events) {
        if (e.end < z0 || e.start > z1) continue;
        const a = xOf(Math.max(z0, e.start)) - 3;
        const b = xOf(Math.min(z1, e.end)) + 3;
        ctx.fillRect(a, y + 1, Math.max(2, b - a), rowH - 2);
      }
    });
    const s = Math.max(4, Math.min(9, rowH - 2));
    for (const fl of flags) {
      if (fl.band < z0 || fl.band > z1) continue;
      ctx.fillStyle = fl.kind === "spike" ? copper : teal;
      drawMark(ctx, fl.kind, xOf(fl.band), PAD.top + fl.k * rowH + rowH / 2, s);
    }
    ctx.strokeStyle = ink3;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.left, PAD.top + plotH + 0.5);
    ctx.lineTo(PAD.left + plotW, PAD.top + plotH + 0.5);
    ctx.stroke();
  }, [width, height, rows, flags, rowH, plotW, plotH, selected, z0, z1, theme]);

  const local = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const hit = (x: number, y: number) => {
    const k = Math.floor((y - PAD.top) / rowH);
    if (k < 0 || k >= rows.length || x < PAD.left || x > PAD.left + plotW) return null;
    const band = bandAt(x);
    let best: (typeof flags)[number] | null = null;
    for (const fl of flags) if (fl.k === k && Math.abs(xOf(fl.band) - x) <= 6 && (!best || Math.abs(fl.band - band) < Math.abs(best.band - band))) best = fl;
    return { k, best };
  };
  const ticks = axisTicks(axis, z0, z1);
  return (
    <div className="ig-map" style={{ height }}>
      <canvas
        ref={ref}
        style={{ width, height }}
        role="img"
        aria-label={`Event map: ${rows.length} flagged spectra (rows) × bands ${f(axis[z0] ?? z0)}–${f(axis[z1] ?? z1)} ${axisUnit}; triangles = isolated peaks, squares = abrupt changes, grey bars = merged physical events. Click a mark to inspect, drag to zoom.`}
        onPointerDown={(e) => {
          const p = local(e);
          if (p.x >= PAD.left) {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag({ x0: p.x, x1: p.x });
          }
        }}
        onPointerMove={(e) => {
          const p = local(e);
          if (drag) setDrag({ ...drag, x1: p.x });
          const h = hit(p.x, p.y);
          if (h) {
            const r = rows[h.k]!;
            const text = h.best ? `${labels[h.k]} · ${KIND_NAME[h.best.kind]} at ${f(axis[h.best.band] ?? h.best.band)} ${axisUnit} · score ${f(h.best.score, 3)}` : `${labels[h.k]} · ${r.physical} physical event(s), max score ${f(r.maxScore, 3)}`;
            setHover({ x: p.x, y: p.y, text });
          } else setHover(null);
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={(e) => {
          const p = local(e);
          const d = drag;
          setDrag(null);
          if (d && Math.abs(d.x1 - d.x0) > 6) {
            const a = bandAt(Math.min(d.x0, d.x1));
            const b = bandAt(Math.max(d.x0, d.x1));
            if (b > a) onZoom([a, b]);
            return;
          }
          const h = hit(p.x, p.y);
          if (h) onPick(rows[h.k]!.row, h.best?.band ?? null);
        }}
      />
      {drag && Math.abs(drag.x1 - drag.x0) > 2 ? <span className="ig-map-brush" style={{ left: Math.min(drag.x0, drag.x1), width: Math.abs(drag.x1 - drag.x0), top: PAD.top, height: plotH }} /> : null}
      {hover ? <span className="ig-map-tip" style={{ left: Math.min(hover.x + 12, width - 220), top: hover.y + 12 }}>{hover.text}</span> : null}
      <span className="ig-map-ylabel" style={{ top: PAD.top, height: plotH, width: PAD.left - 8 }}>{rows.length} spectra</span>
      {ticks.map((t) => <span key={t} className="ig-map-tick" style={{ left: xOf(t), top: PAD.top + plotH + 4 }}>{f(axis[t] ?? t)}</span>)}
    </div>
  );
}

// --- inspected spectra with markers ---------------------------------------------------------------

function MarkedSpectra({ width, source, rowsOfIds, picks, result, merged, zoom, labels, focus, f }: {
  width: number;
  source: InputSource;
  rowsOfIds: readonly number[];
  picks: readonly number[];
  result: EventsResult;
  merged: readonly PhysicalEvent[];
  zoom: [number, number];
  labels: (row: number) => string;
  focus: number | null;
  f: (v: number, d?: number) => string;
}) {
  const [z0, z1] = zoom;
  const height = 260;
  const plotW = Math.max(60, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const series = picks.map((row) => ({ row, values: source.x[rowsOfIds[row]!] ?? [] }));
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) for (let j = z0; j <= z1; j++) {
    const v = s.values[j];
    if (v !== null && v !== undefined && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  if (!Number.isFinite(lo)) return <EmptyState>No value in the selected range.</EmptyState>;
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const span = Math.max(1, z1 - z0);
  const x = (j: number) => PAD.left + ((j - z0) / span) * plotW;
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;
  const pickSet = new Set(picks);
  const marks: { row: number; band: number; kind: EventKind; score: number }[] = [];
  for (const [e, kind] of [[result.spike, "spike"], [result.jump, "jump"]] as const) {
    for (let t = 0; t < e.rows.length; t++) {
      const band = e.bands[t]!;
      if (pickSet.has(e.rows[t]!) && band >= z0 && band <= z1) marks.push({ row: e.rows[t]!, band, kind, score: e.scores[t]! });
    }
  }
  const spans = merged.filter((e) => e.row === (focus ?? picks[0]) && e.end >= z0 && e.start <= z1);
  const ticks = axisTicks(source.axis, z0, z1);
  const unit = source.axis_unit ?? "";
  return (
    <svg className="cz-svg" width={width} height={height} role="img" aria-label={`Inspected spectra with markers at the flagged positions (${marks.length} markers).`}>
      {spans.map((e, i) => <rect key={i} x={x(Math.max(z0, e.start)) - 3} y={PAD.top} width={Math.max(2, x(Math.min(z1, e.end)) - x(Math.max(z0, e.start)) + 6)} height={plotH} className="cz-sel"><title>{`Physical event ${f(source.axis[e.start] ?? e.start)}–${f(source.axis[e.end] ?? e.end)} ${unit}: ${e.spikeFlags} peak and ${e.jumpFlags} jump flag(s), max score ${f(e.maxScore, 3)}`}</title></rect>)}
      <line className="cz-axis-line" x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} />
      {ticks.map((t) => <text key={t} className="cz-t-axis" x={x(t)} y={height - 8} textAnchor="middle">{f(source.axis[t] ?? t)}</text>)}
      <text className="cz-t-axis" x={PAD.left - 6} y={PAD.top + 10} textAnchor="end">{f(hi, 3)}</text>
      <text className="cz-t-axis" x={PAD.left - 6} y={PAD.top + plotH} textAnchor="end">{f(lo, 3)}</text>
      {series.map((s, i) => {
        let d = "";
        let open = false;
        for (let j = z0; j <= z1; j++) {
          const v = s.values[j];
          if (v === null || v === undefined || !Number.isFinite(v)) { open = false; continue; }
          d += `${open ? "L" : "M"}${x(j).toFixed(1)} ${y(v).toFixed(1)}`;
          open = true;
        }
        return <path key={s.row} d={d} fill="none" stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={s.row === focus ? 2 : 1.2} strokeDasharray={i === 0 || s.row === focus ? undefined : ["5 3", "2 2", "8 3 2 3", "1 3", "6 2"][i % 5]}><title>{labels(s.row)}</title></path>;
      })}
      {marks.map((m, i) => {
        const v = series.find((s) => s.row === m.row)?.values[m.band];
        if (v === null || v === undefined || !Number.isFinite(v)) return null;
        const cx = x(m.band);
        const cy = y(v);
        const label = `${labels(m.row)} · ${KIND_NAME[m.kind]} at ${f(source.axis[m.band] ?? m.band)} ${unit} · score ${f(m.score, 3)}`;
        return m.kind === "spike"
          ? <path key={i} d={`M${cx} ${cy - 9}l5 9h-10z`} fill="var(--cz-copper)" stroke="var(--cz-surface)" strokeWidth={0.8}><title>{label}</title></path>
          : <rect key={i} x={cx - 4} y={cy - 4} width={8} height={8} fill="var(--cz-teal)" stroke="var(--cz-surface)" strokeWidth={0.8}><title>{label}</title></rect>;
      })}
    </svg>
  );
}

// --- the card -------------------------------------------------------------------------------------

export function EventPositions({ scope, local, engineFlags, band, scanLabel, f }: {
  scope: Scope;
  local: LocalEvents;
  /** engine-reported global flag counts (the reference) */
  engineFlags: Record<EventKind, number | null>;
  /** band interval selected on the rubric's aligned tracks: zooms the map */
  band: BandSelection | null;
  scanLabel: (id: string) => string;
  f: (v: number, d?: number) => string;
}) {
  const source = scope.input.sources.find((s) => s.source_id === scope.sourceId);
  const p = source?.axis.length ?? 0;
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [focus, setFocus] = useState<{ row: number; band: number | null } | null>(null);
  useEffect(() => { if (band) setZoom([band.i0, band.i1]); }, [band]);
  const rowsOfIds = useMemo(() => {
    if (!source) return [];
    const at = new Map(source.observation_ids.map((id, i) => [id, i]));
    return local.ids.map((id) => at.get(id) ?? -1);
  }, [source, local.ids]);
  // The canvas map has no SVG to export; its data are in the table below (no per-chart export buttons).
  const [mapRef, mapWidth] = useWidth<HTMLDivElement>();
  if (!source || local.status === "unavailable") return null;
  const { result, merged, spectra, threshold, engineThreshold } = local;
  const label = (row: number) => scanLabel(local.ids[row] ?? String(row));
  const z: [number, number] = zoom ?? [0, p - 1];
  const unit = source.axis_unit ?? "";
  const shown = spectra.slice(0, MAX_ROWS);
  const focusRow = focus && spectra.some((s) => s.row === focus.row) ? focus.row : null;
  const picks = focusRow !== null ? [focusRow, ...spectra.filter((s) => s.row !== focusRow).slice(0, 2).map((s) => s.row)] : spectra.slice(0, 3).map((s) => s.row);
  const focusEvents = focusRow !== null ? spectra.find((s) => s.row === focusRow) : spectra[0];
  const view = z;
  // The inspected spectra zoom around a clicked mark (±40 bands); otherwise they follow the map.
  const spectraView: [number, number] = focus?.band !== null && focus?.band !== undefined ? [Math.max(0, focus.band - 40), Math.min(p - 1, focus.band + 40)] : z;
  const flags = result ? result.spike.globalCount + result.jump.globalCount : 0;
  const flaggedSpectra = spectra.length;
  const where = (e: PhysicalEvent) => (e.start === e.end ? `${f(source.axis[e.start] ?? e.start)}` : `${f(source.axis[e.start] ?? e.start)}–${f(source.axis[e.end] ?? e.end)}`);
  return (
    <ChartCard
      title="Event positions: spectra × wavelength"
      subtitle="Each row is a flagged spectrum (highest score first); triangles mark isolated peaks, squares abrupt changes, grey bars the merged physical events. Click a mark to inspect it below; drag across the map to zoom."
      footnote={PROVENANCE}
    >
      <div className="ig-threshold" role="group" aria-label="Inspection threshold">
        <label htmlFor="ig-ev-threshold">Inspection threshold</label>
        <input id="ig-ev-threshold" type="range" min={2} max={20} step={0.5} value={threshold} onChange={(e) => local.setThreshold(Number(e.target.value))} />
        <strong className="cz-t-num">{f(threshold, 3)} robust deviations</strong>
        <button type="button" className="btn btn-ghost btn-sm" disabled={threshold === engineThreshold} onClick={() => local.setThreshold(engineThreshold)}>Reset to the engine value ({f(engineThreshold)})</button>
        {local.status === "running" ? <span className="ig-caption" aria-live="polite">Recomputing…</span> : null}
      </div>
      <p className="ig-caption">Inspection setting only: it recomputes the positions in this page. The engine result (threshold {f(engineThreshold)}) stays the reference for the counts and comments above.</p>
      {local.status === "error" ? <EmptyState>Event positions could not be computed here: {local.error}</EmptyState> : null}
      {result ? (
        <>
          <ul className="ig-merge" aria-label="Events before and after merging">
            <li><span>Flags at {f(result.threshold, 3)}</span><strong className="cz-t-num">{f(result.spike.globalCount)} <MarkGlyph kind="spike" /> + {f(result.jump.globalCount)} <MarkGlyph kind="jump" /> = {f(flags)}</strong></li>
            <li><span>Physical events after merging</span><strong className="cz-t-num">{f(merged.length)}</strong></li>
            <li><span>Spectra with at least one flag</span><strong className="cz-t-num">{f(flaggedSpectra)} / {f(local.ids.length)}</strong></li>
            <li><span>Engine reference ({f(engineThreshold)})</span><strong className="cz-t-num">{engineFlags.spike === null ? "—" : f(engineFlags.spike)} + {engineFlags.jump === null ? "—" : f(engineFlags.jump)} flags</strong></li>
          </ul>
          <p className="ig-caption">
            Merging rule: flags of one spectrum whose bands are at most {MERGE_GAP} bands apart form one physical event (a second-difference flag at band b uses bands b−1…b+1, a first-difference flag b−1…b, so such flags share a measured band). One narrow spike usually raises up to three peak flags and two jump flags.
            {local.matchesEngine === true ? ` At the engine threshold this recomputation reproduces the engine's per-spectrum counts for all ${local.ids.length} spectra.` : ""}
          </p>
          {local.matchesEngine === false ? <p className="ig-warning" role="alert">At the engine threshold the local recomputation differs from the engine's per-spectrum counts; the positions shown here are not reliable for this dataset.</p> : null}
          {spectra.length ? (
            <>
              <div className="ig-map-head">
                <span className="ig-caption">{spectra.length > MAX_ROWS ? `Showing the ${MAX_ROWS} spectra with the highest scores of ${spectra.length}. ` : ""}Bands {f(source.axis[view[0]] ?? view[0])}–{f(source.axis[view[1]] ?? view[1])} {unit}.</span>
                <span className="ig-legend"><MarkGlyph kind="spike" /> isolated peak <MarkGlyph kind="jump" /> abrupt change <span className="ig-legend-bar" /> merged physical event</span>
                {zoom ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setZoom(null); setFocus((s) => (s ? { row: s.row, band: null } : s)); }}>Reset zoom</button> : null}
              </div>
              <div ref={mapRef} style={{ width: "100%", minWidth: 0 }}><EventMap width={Math.max(240, mapWidth || 640)} axis={source.axis} axisUnit={unit} rows={shown} labels={shown.map((s) => label(s.row))} result={result} zoom={view} selected={focusRow} onPick={(row, b) => setFocus({ row, band: b })} onZoom={(r) => setZoom(r)} f={f} /></div>
              <div className="ig-map-head">
                <h5 className="ig-sub">Inspected spectra {focusRow !== null ? `(selected: ${label(focusRow)})` : "(highest scores)"} · {f(source.axis[spectraView[0]] ?? spectraView[0])}–{f(source.axis[spectraView[1]] ?? spectraView[1])} {unit}</h5>
                {focus?.band !== null && focus?.band !== undefined ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFocus({ row: focus.row, band: null })}>Show the map range</button> : null}
              </div>
              <Responsive>{(w) => <MarkedSpectra width={w} source={source} rowsOfIds={rowsOfIds} picks={picks.filter((r) => rowsOfIds[r]! >= 0).slice(0, MAX_LINES)} result={result} merged={merged} zoom={spectraView} labels={label} focus={focusRow ?? picks[0] ?? null} f={f} />}</Responsive>
              <p className="ig-caption">Lines: {picks.map((r, i) => `${label(r)}${i === 0 ? " (solid)" : ""}`).join(" · ")}. Markers sit on the measured value at the attributed band; shaded spans are the physical events of the {focusRow !== null ? "selected" : "first"} spectrum{focusEvents ? ` (highest scores: ${focusEvents.events.slice(0, 6).map(where).join("; ")} ${unit}${focusEvents.events.length > 6 ? `; ${focusEvents.events.length - 6} more in the table` : ""})` : ""}.</p>
              <ChartDataTable
                locale={scope.locale}
                caption={`Flagged spectra at threshold ${f(result.threshold, 3)}: maximum score and wavelengths (highest score first)`}
                columns={["Scan", "Peak flags", "Jump flags", "Physical events", "Max score", "Type at max", `Wavelength at max (${unit})`, `Physical events (${unit})`]}
                rows={spectra.slice(0, 200).map((s) => [label(s.row), s.spikes, s.jumps, s.physical, s.maxScore, KIND_NAME[s.maxKind], source.axis[s.maxBand] ?? s.maxBand, s.events.slice(0, 8).map(where).join("; ") + (s.events.length > 8 ? ` (+${s.events.length - 8})` : "")])}
              />
            </>
          ) : <EmptyState>No position exceeds {f(result.threshold, 3)} robust deviations in {local.ids.length} spectra.</EmptyState>}
        </>
      ) : local.status === "running" ? <EmptyState>Computing event positions…</EmptyState> : null}
    </ChartCard>
  );
}
