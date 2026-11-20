/// <reference lib="webworker" />
// Off-main-thread inspection kernels of the integrity rubric (interim, see populationEvents.ts and
// noiseValidation.ts): population event positions at an inspection threshold (derivatives and
// population statistics cached per dataset key, so a threshold change only re-applies the
// comparison), and the noise-injection validation of the Methods noise estimator.
import { SpectralNoiseProxy, loadModule, type Matrix } from "@nirs4all/methods";
import type { InspectionRequest, InspectionResponse } from "./inspection-client";
import { applyThreshold, preparePopulationEvents, type EventsMatrix, type PreparedEvents } from "./populationEvents";
import { validateNoiseEstimator, type NoiseEstimate } from "./noiseValidation";

let cached: { key: string; prepared: PreparedEvents } | null = null;
let methods: Promise<unknown> | null = null;

/** The engine's noise estimator: Methods `diagnostics.spectral_noise_proxy`, per row. */
function methodsNoise(m: EventsMatrix): NoiseEstimate {
  const params = m.mask ? { valid_mask: Array.from(m.mask) } : {};
  const out = new SpectralNoiseProxy(params).run({ rows: m.n, cols: m.p, data: m.x } satisfies Matrix);
  const read = (name: string) => {
    const values: (number | null)[] = new Array(m.n).fill(null);
    const v = out[`${name}_values`] as Matrix | undefined;
    const rows = out[`${name}_rows`] as number[] | undefined;
    if (v && rows) rows.forEach((r, k) => { values[r] = v.data[k]!; });
    return values;
  };
  return { sigma: read("noise_sigma"), meanAbs: read("signal_mean_abs") };
}

self.onmessage = async (event: MessageEvent<InspectionRequest>) => {
  const req = event.data;
  const reply = (m: InspectionResponse, transfer: Transferable[] = []) => self.postMessage(m, transfer);
  try {
    if (req.type === "events") {
      if (req.matrix) cached = { key: req.key, prepared: preparePopulationEvents(req.matrix) };
      if (!cached || cached.key !== req.key) {
        reply({ id: req.id, ok: false, error: "missing-matrix" });
        return;
      }
      const { prepared } = cached;
      const spike = applyThreshold(prepared.spike, prepared.n, prepared.p, req.threshold);
      const jump = applyThreshold(prepared.jump, prepared.n, prepared.p, req.threshold);
      const atEngine = req.engineThreshold === req.threshold
        ? { spike: spike.counts, jump: jump.counts }
        : { spike: applyThreshold(prepared.spike, prepared.n, prepared.p, req.engineThreshold).counts, jump: applyThreshold(prepared.jump, prepared.n, prepared.p, req.engineThreshold).counts };
      reply({ id: req.id, ok: true, type: "events", key: req.key, threshold: req.threshold, spike, jump, atEngine });
    } else {
      methods ??= loadModule();
      await methods;
      const result = validateNoiseEstimator(req.matrix, methodsNoise, { seed: req.seed });
      reply({ id: req.id, ok: true, type: "noise", result });
    }
  } catch (error) {
    if (req.type === "noise") methods = null;
    reply({ id: req.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
