// Explorer worker protocol and host. The host keeps only the latest evaluation (stale replies are
// dropped), and cancels a benchmark by terminating the worker; the next call re-initialises it.
import type { StepRecipe } from "./catalog";
import type { BenchmarkPoint, Diagnostics, Evaluation, EvaluationInput } from "./evaluate";

export type ExplorerRequest =
  | { id: number; op: "init"; input: EvaluationInput }
  | { id: number; op: "evaluate"; steps: StepRecipe[] }
  | { id: number; op: "benchmark"; configs: { label: string; steps: StepRecipe[] }[] };

export type ExplorerResponse =
  | { id: number; ok: true; op: "init"; before: Diagnostics }
  | { id: number; ok: true; op: "evaluate"; evaluation: Evaluation }
  | { id: number; ok: true; op: "progress"; done: number; total: number; point: BenchmarkPoint }
  | { id: number; ok: true; op: "benchmark_done" }
  | { id: number; ok: false; message: string };

/** Request without its id (distributive over the union). */
type Body = ExplorerRequest extends infer R ? (R extends ExplorerRequest ? Omit<R, "id"> : never) : never;

export interface WorkerLike {
  postMessage(message: ExplorerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<ExplorerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export class StaleError extends Error {
  constructor() {
    super("superseded");
  }
}
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

interface Pending {
  resolve: (r: ExplorerResponse) => void;
  reject: (e: Error) => void;
  onProgress?: (r: Extract<ExplorerResponse, { op: "progress" }>) => void;
}

export interface ExplorerHost {
  init(input: EvaluationInput): Promise<Diagnostics>;
  /** Resolves with the latest request only; an older pending request rejects with StaleError. */
  evaluate(steps: StepRecipe[]): Promise<Evaluation>;
  benchmark(configs: { label: string; steps: StepRecipe[] }[], onPoint: (point: BenchmarkPoint, done: number, total: number) => void): Promise<void>;
  /** Terminates the worker (stops a running benchmark); pending calls reject with CancelledError. */
  cancel(): void;
  dispose(): void;
}

export function createExplorerHost(spawn: () => WorkerLike): ExplorerHost {
  let worker: WorkerLike | null = null;
  let initInput: EvaluationInput | null = null;
  let initialised: Promise<Diagnostics> | null = null;
  let nextId = 1;
  let latestEvaluate = 0;
  const pending = new Map<number, Pending>();

  const rejectAll = (error: Error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  const ensure = (): WorkerLike => {
    if (worker) return worker;
    const w = spawn();
    w.onmessage = (event) => {
      const m = event.data;
      const p = pending.get(m.id);
      if (!p) return;
      if (m.ok && m.op === "progress") {
        p.onProgress?.(m);
        return;
      }
      pending.delete(m.id);
      if (m.ok) p.resolve(m);
      else p.reject(new Error(m.message));
    };
    w.onerror = (event) => {
      rejectAll(new Error(event.message || "explorer worker failed"));
      w.terminate();
      if (worker === w) {
        worker = null;
        initialised = null;
      }
    };
    worker = w;
    return w;
  };
  const send = (body: Body, onProgress?: Pending["onProgress"]) =>
    new Promise<ExplorerResponse>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, ...(onProgress ? { onProgress } : {}) });
      if (body.op === "evaluate") latestEvaluate = id;
      ensure().postMessage({ ...body, id } as ExplorerRequest);
    });
  const ready = (): Promise<Diagnostics> => {
    if (!initInput) return Promise.reject(new Error("Explorer host not initialised."));
    initialised ??= send({ op: "init", input: initInput }).then((r) => (r as Extract<ExplorerResponse, { op: "init" }>).before);
    return initialised;
  };
  const terminate = () => {
    worker?.terminate();
    worker = null;
    initialised = null;
    rejectAll(new CancelledError());
  };

  return {
    init(input) {
      terminate();
      initInput = input;
      return ready();
    },
    async evaluate(steps) {
      await ready();
      const call = send({ op: "evaluate", steps });
      const id = latestEvaluate;
      const r = await call;
      if (id !== latestEvaluate) throw new StaleError();
      return (r as Extract<ExplorerResponse, { op: "evaluate" }>).evaluation;
    },
    async benchmark(configs, onPoint) {
      await ready();
      await send({ op: "benchmark", configs }, (m) => onPoint(m.point, m.done, m.total));
    },
    cancel: terminate,
    dispose: terminate,
  };
}

export const spawnExplorerWorker = (): WorkerLike =>
  new Worker(new URL("./explorer.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
