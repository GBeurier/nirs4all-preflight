/// <reference lib="webworker" />
// Explorer worker: one Methods instance; caches the raw diagnostics of the loaded subset so each
// parameter change recomputes only the processed side. Cancellation = termination by the host.
import type { StepRecipe } from "./catalog";
import { benchmarkPoint, diagnose, evaluatePipeline, type Diagnostics, type EvaluationInput } from "./evaluate";
import { loadMethodsKernel } from "./methodsKernel";
import type { ExplorerRequest, ExplorerResponse } from "./protocol";

let state: { input: EvaluationInput; before: Diagnostics } | null = null;

self.onmessage = async (event: MessageEvent<ExplorerRequest>) => {
  const msg = event.data;
  const reply = (m: ExplorerResponse) => self.postMessage(m);
  try {
    const kernel = await loadMethodsKernel();
    if (msg.op === "init") {
      state = { input: msg.input, before: diagnose(kernel, msg.input, msg.input.matrix) };
      reply({ id: msg.id, ok: true, op: "init", before: state.before });
      return;
    }
    if (!state) throw new Error("Explorer worker not initialised.");
    if (msg.op === "evaluate") {
      reply({ id: msg.id, ok: true, op: "evaluate", evaluation: evaluatePipeline(kernel, state.input, state.before, msg.steps) });
      return;
    }
    const configs: { label: string; steps: StepRecipe[] }[] = msg.configs;
    configs.forEach((config, k) => {
      reply({ id: msg.id, ok: true, op: "progress", done: k + 1, total: configs.length, point: benchmarkPoint(kernel, state!.input, state!.before, config) });
    });
    reply({ id: msg.id, ok: true, op: "benchmark_done" });
  } catch (error) {
    reply({ id: msg.id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
