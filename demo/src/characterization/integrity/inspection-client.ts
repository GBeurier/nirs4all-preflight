// Bridge to inspection.worker.ts (event positions at an inspection threshold; noise-estimator validation).
import type { EventsMatrix, KindEvents } from "./populationEvents";
import type { NoiseValidation } from "./noiseValidation";

export type InspectionRequest =
  | { type: "events"; id: number; key: string; matrix?: EventsMatrix; threshold: number; engineThreshold: number }
  | { type: "noise"; id: number; matrix: EventsMatrix; seed: number };

export interface EventsResult {
  key: string;
  threshold: number;
  spike: KindEvents;
  jump: KindEvents;
  /** per-row counts at the engine threshold, to check the local recomputation against the report */
  atEngine: { spike: (number | null)[]; jump: (number | null)[] };
}

export type InspectionResponse =
  | ({ id: number; ok: true; type: "events" } & EventsResult)
  | { id: number; ok: true; type: "noise"; result: NoiseValidation | null }
  | { id: number; ok: false; error: string };

let worker: Worker | null = null;
let next = 1;
/** Dataset key whose matrix the worker holds (it keeps one). */
let sentKey: string | null = null;

function post<T>(request: InspectionRequest, pick: (r: InspectionResponse & { ok: true }) => T): Promise<T> {
  if (typeof Worker === "undefined") return Promise.reject(new Error("Web workers are not available in this environment."));
  worker ??= new Worker(new URL("./inspection.worker.ts", import.meta.url), { type: "module" });
  const w = worker;
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<InspectionResponse>) => {
      if (event.data.id !== request.id) return;
      w.removeEventListener("message", onMessage);
      if (event.data.ok) resolve(pick(event.data));
      else reject(new Error(event.data.error));
    };
    w.addEventListener("message", onMessage);
    w.postMessage(request);
  });
}

/**
 * Event positions of the engine population at `threshold`. `matrix` is built lazily and sent only
 * when the worker does not hold this dataset yet.
 */
export async function computeEvents(key: string, matrix: () => EventsMatrix, threshold: number, engineThreshold: number): Promise<EventsResult> {
  const ask = (withMatrix: boolean) => {
    const request: InspectionRequest = { type: "events", id: next++, key, threshold, engineThreshold, ...(withMatrix ? { matrix: matrix() } : {}) };
    return post(request, (r) => {
      if (r.type !== "events") throw new Error("unexpected worker reply");
      return { key: r.key, threshold: r.threshold, spike: r.spike, jump: r.jump, atEngine: r.atEngine };
    });
  };
  const first = sentKey !== key;
  sentKey = key;
  try {
    return await ask(first);
  } catch (error) {
    if (first || !(error instanceof Error) || error.message !== "missing-matrix") throw error;
    return ask(true);
  }
}

export function validateNoise(matrix: EventsMatrix, seed: number): Promise<NoiseValidation | null> {
  return post({ type: "noise", id: next++, matrix, seed }, (r) => {
    if (r.type !== "noise") throw new Error("unexpected worker reply");
    return r.result;
  });
}
