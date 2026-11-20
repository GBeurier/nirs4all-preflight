// Rubric block contract of the characterization page. Each contributor (integrity, SNR, diversity,
// noise proxy, repeatability) exposes a hook returning its content split by visualization type; the
// page (overview/RubricSection) groups same-type blocks of a rubric together:
// one KPI strip → headline visuals → interpretation bullets → per-spectrum distributions grid →
// ONE synchronized AlignedTracks of all per-band profiles → spectra inspection → collapsed details.
import type { ReactNode } from "react";
import type { BandSelection, Track } from "../repeatability/AlignedTracks";
import type { KpiItem } from "./charts/frame";

export interface RubricComment {
  /** Stable key. */
  id: string;
  text: ReactNode;
  /** "attention" draws a copper bullet, "info" a teal one, "neutral" grey (text always carries the meaning). */
  tone?: "attention" | "info" | "neutral" | undefined;
}

export interface RubricBlock {
  /** Stable key, e.g. "snr-histogram". */
  id: string;
  /** Rendered as given; wrapped in a ChartCard titled `title` when a title is given. */
  node: ReactNode;
  title?: string | undefined;
  subtitle?: string | undefined;
  /** Grid span hint for distributions: "half" (default, side by side) or "full". */
  span?: "half" | "full" | undefined;
}

/** Context passed to inspection / detail render functions: the band interval selected on the rubric's tracks. */
export interface BandContext {
  selection: BandSelection | null;
}

/** A slot is a list of blocks, a ready node, or a render function of the band selection. */
export type BlockSlot = readonly RubricBlock[] | ReactNode | ((ctx: BandContext) => ReactNode);

export interface DetailParts {
  tables?: ReactNode;
  methodology?: ReactNode;
  limitations?: ReactNode;
  investigate?: readonly string[];
}

export interface RubricBlocks {
  /** Contributor id, e.g. "snr" (used for keys and anchors). */
  id: string;
  /** Contributor title / one-line lead (used as sub-headings when several contributors share a rubric). */
  title?: string | undefined;
  lead?: string | undefined;
  kpis: readonly KpiItem[];
  /** Headline visual right under the KPI strip (e.g. the SNR gauge or the proportion bars). */
  headline?: ReactNode;
  comments: readonly (RubricComment | string)[];
  /** Per-spectrum distributions (histograms, proportion bars, gauges, value bars, dot plots). */
  distributions: readonly RubricBlock[];
  /** Per-band profiles over `source.axis` (values indexed like the axis; null = not evaluable). */
  bandTracks: readonly Track[];
  markRegions?: readonly { i0: number; i1: number; label: string }[] | undefined;
  /** Called with the band interval selected on the rubric's tracks (also shared with the quality map). */
  onBandSelect?: ((selection: BandSelection | null) => void) | undefined;
  /** Spectra inspection (overlays, lists of flagged spectra). */
  inspection: BlockSlot;
  /** Tables, methodology and limitations: rendered collapsed at the bottom of the rubric. */
  details: BlockSlot | DetailParts;
  /** Controls placed under the interpretation (e.g. "Open settings"); optional. */
  actions?: ReactNode;
  /** One-line message when the contributor has nothing to show (rubric still renders the others). */
  unavailable?: string | null | undefined;
}

export const emptyBlocks = (id: string, unavailable: string | null = null): RubricBlocks => ({ id, kpis: [], comments: [], distributions: [], bandTracks: [], inspection: [], details: [], unavailable });

const isBlockList = (v: unknown): v is readonly RubricBlock[] => Array.isArray(v) && v.every((b) => b && typeof b === "object" && "node" in b && "id" in b);
const isDetailParts = (v: unknown): v is DetailParts => !!v && typeof v === "object" && !Array.isArray(v) && !("$$typeof" in v) && ("tables" in v || "methodology" in v || "limitations" in v || "investigate" in v);

/** Normalizes a slot to renderable nodes for the current band selection. */
export function renderSlot(slot: BlockSlot | DetailParts, ctx: BandContext): { lists: readonly RubricBlock[]; node: ReactNode; parts: DetailParts | null } {
  if (typeof slot === "function") return { lists: [], node: (slot as (c: BandContext) => ReactNode)(ctx), parts: null };
  if (isBlockList(slot)) return { lists: slot, node: null, parts: null };
  if (isDetailParts(slot)) return { lists: [], node: null, parts: slot };
  return { lists: [], node: slot as ReactNode, parts: null };
}

export const commentOf = (c: RubricComment | string, i: number): RubricComment => (typeof c === "string" ? { id: `c${i}`, text: c } : c);
