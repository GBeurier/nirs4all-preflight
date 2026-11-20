// Shared exploration state of the characterization page: the selected spectral interval and the
// regions a reader marked "to investigate". Local, in-memory state only: nothing here rejects a band,
// a spectrum or a sample, and nothing is stored or exported unless the reader asks for the JSON file.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** A band interval of one source, by band index (source-axis order, inclusive) and axis value. */
export interface BandInterval {
  sourceId: string;
  i0: number;
  i1: number;
  from: number;
  to: number;
}

export interface InvestigationRegion extends BandInterval {
  id: string;
  note: string;
}

export interface CharacterizationSelection {
  /** The interval selected on the quality map (or by a detailed panel that reports it). */
  selection: BandInterval | null;
  select: (interval: BandInterval | null) => void;
  /** Reader-marked regions to investigate: exploration aids, never an automatic rejection. */
  regions: readonly InvestigationRegion[];
  addRegion: (interval: BandInterval, note?: string) => void;
  removeRegion: (id: string) => void;
  clearRegions: () => void;
  /** Scrolls to a detailed panel of the diagnosis page (`s-repeat`, `s-quality`, `s-preprocessing`). */
  openPanel: (panelId: string) => void;
}

function scrollToPanel(panelId: string): void {
  document.getElementById(panelId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Region ids stay unique within a session even after removals. */
let nextRegion = 0;

function useSelectionState(): CharacterizationSelection {
  const [selection, select] = useState<BandInterval | null>(null);
  const [regions, setRegions] = useState<readonly InvestigationRegion[]>([]);
  const addRegion = useCallback((interval: BandInterval, note = "") => setRegions((all) => [...all, { ...interval, id: `region-${++nextRegion}`, note }]), []);
  const removeRegion = useCallback((id: string) => setRegions((all) => all.filter((r) => r.id !== id)), []);
  const clearRegions = useCallback(() => setRegions([]), []);
  return useMemo(() => ({ selection, select, regions, addRegion, removeRegion, clearRegions, openPanel: scrollToPanel }), [selection, regions, addRegion, removeRegion, clearRegions]);
}

const Context = createContext<CharacterizationSelection | null>(null);

/** Holds the state above the diagnosis sections; panels and the quality map read it with the hook. */
export function CharacterizationProvider({ children }: { children: ReactNode }) {
  const value = useSelectionState();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The shared state; outside a provider, the component gets its own private state (standalone use). */
export function useCharacterizationSelection(): CharacterizationSelection {
  const shared = useContext(Context);
  const own = useSelectionState();
  return shared ?? own;
}

/** Serialisable export of the marked regions (JSON file the reader downloads). */
export function regionsExport(regions: readonly InvestigationRegion[], sourceId: string, axisUnit: string) {
  return {
    kind: "nirs4all-preflight.regions-to-investigate",
    version: 1,
    note: "Manual marks to guide inspection. They are not an automatic rejection and are not used by any analysis.",
    source_id: sourceId,
    axis_unit: axisUnit,
    regions: regions.filter((r) => r.sourceId === sourceId).map((r) => ({ from: Math.min(r.from, r.to), to: Math.max(r.from, r.to), band_start: Math.min(r.i0, r.i1), band_end: Math.max(r.i0, r.i1), bands: Math.abs(r.i1 - r.i0) + 1, note: r.note })),
  };
}
