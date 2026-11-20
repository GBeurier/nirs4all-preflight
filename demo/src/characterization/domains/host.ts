// Main-thread host of the domain-shift worker: one lazily created worker, replies matched by id. Without a
// Worker (tests, server rendering) the task runs inline.
import type { DomainTask, TaskResults } from "./tasks";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function ensure(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./domains.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result?: unknown; message?: string }>) => {
    const p = pending.get(event.data.id);
    if (!p) return;
    pending.delete(event.data.id);
    if (event.data.ok) p.resolve(event.data.result);
    else p.reject(new Error(event.data.message ?? "domain-shift worker failed"));
  };
  w.onerror = (event) => {
    for (const p of pending.values()) p.reject(new Error(event.message || "domain-shift worker failed"));
    pending.clear();
    w.terminate();
    if (worker === w) worker = null;
  };
  worker = w;
  return w;
}

export function domainTask<K extends DomainTask["op"]>(task: Extract<DomainTask, { op: K }>): Promise<TaskResults[K]> {
  if (typeof Worker === "undefined") return import("./tasks").then((t) => t.runTask(task) as Promise<TaskResults[K]>);
  return new Promise<TaskResults[K]>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    ensure().postMessage({ id, task });
  });
}
