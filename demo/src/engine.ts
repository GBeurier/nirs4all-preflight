// Narrow host bridge to the engine worker. Main thread only relays JSON; cancel() terminates the worker
// (the only reliable way to stop synchronous WASM), and the next call starts a fresh worker.
import type { EngineReport } from "nirs4all-ui/qualification";
import type { EngineInput } from "./input";

export type EngineOp = "analyze" | "validate" | "reportHtml" | "capabilities";
export interface WorkerRequest { id: number; op: EngineOp; payload?: unknown }
export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } };

export class EngineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface EngineValidation {
  valid: boolean;
  issues: { code: string; path: string; message: string; blocking: boolean }[];
}

export interface EngineHost {
  analyze(input: EngineInput): Promise<EngineReport>;
  validate(input: EngineInput): Promise<EngineValidation>;
  reportHtml(report: EngineReport): Promise<string>;
  /** Terminates the worker; pending calls reject with code CANCELLED. */
  cancel(): void;
  dispose(): void;
}

export function createEngineHost(): EngineHost {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const ensure = (): Worker => {
    if (worker) return worker;
    const w = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new EngineError(message.error.code, message.error.message));
    };
    w.onerror = (event) => {
      const error = new EngineError("WORKER_ERROR", event.message || "worker failed");
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      w.terminate();
      if (worker === w) worker = null;
    };
    worker = w;
    return w;
  };

  const call = <T>(op: EngineOp, payload?: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const request: WorkerRequest = { id, op, payload };
      ensure().postMessage(request);
    });

  const terminate = () => {
    worker?.terminate();
    worker = null;
    const error = new EngineError("CANCELLED", "cancelled");
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  return {
    analyze: (input) => call<EngineReport>("analyze", input),
    validate: (input) => call<EngineValidation>("validate", input),
    reportHtml: (report) => call<string>("reportHtml", report),
    cancel: terminate,
    dispose: terminate,
  };
}
