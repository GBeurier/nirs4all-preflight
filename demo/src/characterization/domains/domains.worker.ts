/// <reference lib="webworker" />
// Domain-shift worker: per-unit diagnostics, the local permutation null, the pairwise level matrix and the
// preprocessing explorer run off the main thread (Methods WASM loaded once in this worker).
import { runTask, type DomainTask } from "./tasks";

self.onmessage = async (event: MessageEvent<{ id: number; task: DomainTask }>) => {
  const { id, task } = event.data;
  try {
    self.postMessage({ id, ok: true, result: await runTask(task) });
  } catch (error) {
    self.postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
