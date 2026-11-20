// Shared exploration state of the characterization page: the selected spectral interval and the
// regions a reader marked "to investigate". Local, in-memory state only: nothing here rejects a band,
// a spectrum or a sample, and nothing is stored or exported unless the reader asks for the JSON file.
import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { scrollToSettled } from "../shared/scroll";

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
  /** Measurement context (instrument × campaign × repeat type) picked for a source, by context key; null = first. */
  contextKey: (sourceId: string) => string | null;
  selectContext: (sourceId: string, key: string) => void;
}

/** Scrolls to the panel and re-aligns it while the sections above it are still growing. */
function scrollToPanel(panelId: string): void {
  scrollToSettled(panelId);
}

/** Region ids stay unique within a session even after removals. */
let nextRegion = 0;

function useSelectionState(): CharacterizationSelection {
  const [selection, select] = useState<BandInterval | null>(null);
  const [regions, setRegions] = useState<readonly InvestigationRegion[]>([]);
  const addRegion = useCallback((interval: BandInterval, note = "") => setRegions((all) => [...all, { ...interval, id: `region-${++nextRegion}`, note }]), []);
  const removeRegion = useCallback((id: string) => setRegions((all) => all.filter((r) => r.id !== id)), []);
  const clearRegions = useCallback(() => setRegions([]), []);
  const [contexts, setContexts] = useState<Readonly<Record<string, string>>>({});
  const contextKey = useCallback((sourceId: string) => contexts[sourceId] ?? null, [contexts]);
  const selectContext = useCallback((sourceId: string, key: string) => setContexts((all) => (all[sourceId] === key ? all : { ...all, [sourceId]: key })), []);
  return useMemo(() => ({ selection, select, regions, addRegion, removeRegion, clearRegions, openPanel: scrollToPanel, contextKey, selectContext }), [selection, regions, addRegion, removeRegion, clearRegions, contextKey, selectContext]);
}

/** Hover cursor shared by every band-indexed chart of a source (band index). */
export interface SharedCursor {
  sourceId: string;
  index: number;
}

/**
 * Tiny external store for the hover cursor: it changes on every pointer move, so it lives outside the
 * selection context (a context update would re-render every consumer); each chart subscribes to its
 * own source's band index only and re-renders when that index changes.
 */
export interface CursorStore {
  get: () => SharedCursor | null;
  set: (cursor: SharedCursor | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createCursorStore(): CursorStore {
  let current: SharedCursor | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      if (next === current || (next && current && next.sourceId === current.sourceId && next.index === current.index)) return;
      current = next;
      for (const l of listeners) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

const Context = createContext<CharacterizationSelection | null>(null);
const CursorContext = createContext<CursorStore | null>(null);

/** Holds the state above the diagnosis sections; panels and the quality map read it with the hook. */
export function CharacterizationProvider({ children }: { children: ReactNode }) {
  const value = useSelectionState();
  const cursor = useRef<CursorStore | null>(null);
  cursor.current ??= createCursorStore();
  return <Context.Provider value={value}><CursorContext.Provider value={cursor.current}>{children}</CursorContext.Provider></Context.Provider>;
}

/**
 * The hover cursor of `sourceId` shared by the quality map, the detailed profiles and every rubric's band
 * profiles: `[band index | null, setter]`. Outside a provider the component keeps a private cursor.
 */
export function useSharedCursor(sourceId: string | null): [number | null, (index: number | null) => void] {
  const shared = useContext(CursorContext);
  const own = useRef<CursorStore | null>(null);
  own.current ??= createCursorStore();
  const store = shared ?? own.current;
  const index = useSyncExternalStore(store.subscribe, () => {
    const c = store.get();
    return c && c.sourceId === sourceId ? c.index : null;
  }, () => null);
  const set = useCallback((i: number | null) => store.set(i === null || sourceId === null ? null : { sourceId, index: i }), [store, sourceId]);
  return [index, set];
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
