// Before/after per-spectrum distribution built from two kit histograms on shared bins (small
// multiples: raw on top, processed below, same x scale). Interim demo component (nirs4all-ui debt).
import { EmptyState, Histogram, type HistBin } from "../shared/charts";
import { medianOf, sharedHistogram } from "./metrics";

const BINS = 24;

/** Shared-edge bins of each series; separate edges when the scales differ. */
export function pairedBins(raw: readonly (number | null)[], processed: readonly (number | null)[] | null, separate = false): [HistBin[], HistBin[] | null] | null {
  const toBins = (edges: number[], counts: number[]): HistBin[] => counts.map((count, k) => ({ lo: edges[k]!, hi: edges[k + 1]!, count }));
  if (!processed || separate) {
    const a = sharedHistogram([raw], BINS);
    if (!a) return null;
    const b = processed ? sharedHistogram([processed], BINS) : null;
    return [toBins(a.edges, a.counts[0]!), b ? toBins(b.edges, b.counts[0]!) : null];
  }
  const h = sharedHistogram([raw, processed], BINS);
  return h ? [toBins(h.edges, h.counts[0]!), toBins(h.edges, h.counts[1]!)] : null;
}

const finiteMedian = (xs: readonly (number | null)[]) => medianOf(xs.filter((v): v is number => v !== null && Number.isFinite(v)));

export function PairedDistribution({ title, unit, raw, processed, separateScales = false, withheld }: {
  title: string;
  unit: string;
  raw: readonly (number | null)[] | null;
  processed: readonly (number | null)[] | null;
  separateScales?: boolean;
  withheld: string | null;
}) {
  const bins = raw ? pairedBins(raw, processed, separateScales) : null;
  const marker = (xs: readonly (number | null)[] | null) => {
    const m = xs ? finiteMedian(xs) : null;
    return m === null ? [] : [{ value: m, label: "Median", tone: "teal" as const }];
  };
  return (
    <figure className="pp-dist">
      <figcaption className="pp-dist-title">{title}</figcaption>
      {!raw ? (
        <EmptyState>Computing…</EmptyState>
      ) : !bins ? (
        <EmptyState>{`No evaluable value for this distribution.`}</EmptyState>
      ) : (
        <>
          <p className="pp-dist-label">Raw</p>
          <Histogram bins={bins[0]} xLabel={unit} title={`${title}, raw`} markers={marker(raw)} tone="grey" height={128} />
          <p className="pp-dist-label">{separateScales ? "Processed (own scale, different units)" : "Processed (same bins)"}</p>
          {bins[1] ? (
            <Histogram bins={bins[1]} xLabel={separateScales ? "processed units" : unit} title={`${title}, processed`} markers={marker(processed)} tone="accent" height={128} />
          ) : (
            <EmptyState>{withheld ?? "Waiting for the processed spectra…"}</EmptyState>
          )}
        </>
      )}
    </figure>
  );
}
