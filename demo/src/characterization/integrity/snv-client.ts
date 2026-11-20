// On-demand bridge to snv.worker.ts (Methods WASM is loaded only when the user asks).
export interface SnvRequest { id: number; rows: number; cols: number; data: Float64Array }
export type SnvResponse = { id: number; ok: true; raw: (number | null)[]; snv: (number | null)[] } | { id: number; ok: false; error: string };

let worker: Worker | null = null;
let next = 1;

export function runSnvComparison(matrix: { rows: number; cols: number; data: Float64Array }): Promise<{ raw: (number | null)[]; snv: (number | null)[] }> {
  if (typeof Worker === "undefined") return Promise.reject(new Error("Web workers are not available in this environment."));
  worker ??= new Worker(new URL("./snv.worker.ts", import.meta.url), { type: "module" });
  const w = worker;
  const id = next++;
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<SnvResponse>) => {
      if (event.data.id !== id) return;
      w.removeEventListener("message", onMessage);
      if (event.data.ok) resolve({ raw: event.data.raw, snv: event.data.snv });
      else reject(new Error(event.data.error));
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", (e) => reject(new Error(e.message || "worker failed")), { once: true });
    const request: SnvRequest = { id, ...matrix };
    w.postMessage(request, [request.data.buffer]);
  });
}
