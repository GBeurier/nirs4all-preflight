// Main-thread host of the scenario-audit worker; inline where no Worker exists (tests, server rendering).
import type { FoldSpectral, SpectralRequest } from "./spectralShift";

type Result = (FoldSpectral | { error: string })[];
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: Result) => void; reject: (e: Error) => void }>();

function ensure(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./joint.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result?: Result; message?: string }>) => {
    const p = pending.get(event.data.id);
    if (!p) return;
    pending.delete(event.data.id);
    if (event.data.ok) p.resolve(event.data.result!);
    else p.reject(new Error(event.data.message ?? "scenario worker failed"));
  };
  w.onerror = (event) => {
    for (const p of pending.values()) p.reject(new Error(event.message || "scenario worker failed"));
    pending.clear();
    w.terminate();
    if (worker === w) worker = null;
  };
  worker = w;
  return w;
}

export function spectralTask(req: SpectralRequest): Promise<Result> {
  if (typeof Worker === "undefined") return import("./spectralShift").then((m) => m.scenarioSpectral(req));
  return new Promise<Result>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ensure().postMessage({ id, req });
  });
}
