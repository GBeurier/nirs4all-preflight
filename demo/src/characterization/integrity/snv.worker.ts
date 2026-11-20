/// <reference lib="webworker" />
// Raw vs SNV distance from the mean spectrum, entirely by Methods kernels (SNV:
// `preflightSnv`; distance: `diagnostics.spectral_reference_qc`, the kernel behind the engine's
// `reference.rms`). Runs off the main thread, only on demand.
import { SpectralReferenceQc, loadModule, preflightSnv, type Matrix } from "@nirs4all/methods";
import type { SnvRequest, SnvResponse } from "./snv-client";

let ready: Promise<unknown> | null = null;

const rms = (x: Matrix): (number | null)[] => {
  const out = new SpectralReferenceQc().run(x);
  const values = out.rms_values as Matrix;
  const status = out.rms_status as number[];
  return Array.from(values.data, (v, i) => (status[i] === 0 && Number.isFinite(v) ? v : null));
};

self.onmessage = async (event: MessageEvent<SnvRequest>) => {
  const { id, rows, cols, data } = event.data;
  const reply = (m: SnvResponse) => self.postMessage(m);
  try {
    ready ??= loadModule();
    await ready;
    const x: Matrix = { rows, cols, data };
    reply({ id, ok: true, raw: rms(x), snv: rms(preflightSnv(x).matrix) });
  } catch (error) {
    ready = null;
    reply({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
