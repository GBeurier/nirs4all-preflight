// Per-band display statistics over the loaded spectra (mean, SD across spectra); input never mutated.

/** Mean spectrum of the source (display statistic over the finite values of each band). */
export function meanSpectrum(x: readonly (readonly (number | null)[])[], bands: number): (number | null)[] {
  const sum = new Float64Array(bands);
  const n = new Uint32Array(bands);
  for (const row of x) {
    for (let j = 0; j < bands; j++) {
      const v = row[j];
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        sum[j]! += v;
        n[j]! += 1;
      }
    }
  }
  return Array.from(sum, (s, j) => (n[j]! ? s / n[j]! : null));
}

/** Standard deviation across spectra per band (display statistic; null when fewer than 2 finite values). */
export function bandSd(x: readonly (readonly (number | null)[])[], bands: number): (number | null)[] {
  const mean = meanSpectrum(x, bands);
  const ss = new Float64Array(bands);
  const n = new Uint32Array(bands);
  for (const row of x) {
    for (let j = 0; j < bands; j++) {
      const v = row[j];
      const m = mean[j];
      if (v !== null && v !== undefined && Number.isFinite(v) && m !== null && m !== undefined) {
        ss[j]! += (v - m) ** 2;
        n[j]! += 1;
      }
    }
  }
  return Array.from(ss, (s, j) => (n[j]! > 1 ? Math.sqrt(s / (n[j]! - 1)) : null));
}

