// Selected factor (and optional level) shared by the design, association, joint landscape and statistical
// evidence sections. Outside a provider the selection is local to each consumer.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export interface DesignSelection {
  factor: string | null;
  setFactor: (factor: string | null) => void;
  level: string | null;
  setLevel: (level: string | null) => void;
}

const Context = createContext<DesignSelection | null>(null);

export function DesignSelectionProvider({ children }: { children: ReactNode }) {
  const [factor, setFactorState] = useState<string | null>(null);
  const [level, setLevel] = useState<string | null>(null);
  const value = useMemo<DesignSelection>(() => ({
    factor,
    setFactor: (f) => { setFactorState(f); setLevel(null); },
    level,
    setLevel,
  }), [factor, level]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The shared selection; a private one when no provider is mounted (tests, isolated rendering). */
export function useDesignSelection(): DesignSelection {
  const shared = useContext(Context);
  const [factor, setFactor] = useState<string | null>(null);
  const [level, setLevel] = useState<string | null>(null);
  const local = useMemo<DesignSelection>(() => ({ factor, setFactor: (f) => { setFactor(f); setLevel(null); }, level, setLevel }), [factor, level]);
  return shared ?? local;
}

/** The selected factor if it is one of `available`, else the first available one. */
export const effectiveFactor = (selected: string | null, available: readonly string[]): string | null =>
  selected !== null && available.includes(selected) ? selected : (available[0] ?? null);
