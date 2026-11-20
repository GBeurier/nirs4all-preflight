/// <reference lib="webworker" />
// Scenario-audit worker: Methods T²/Q monitors of the selected scenario's folds run off the main thread.
import { scenarioSpectral, type SpectralRequest } from "./spectralShift";

self.onmessage = async (event: MessageEvent<{ id: number; req: SpectralRequest }>) => {
  const { id, req } = event.data;
  try {
    self.postMessage({ id, ok: true, result: await scenarioSpectral(req) });
  } catch (error) {
    self.postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
