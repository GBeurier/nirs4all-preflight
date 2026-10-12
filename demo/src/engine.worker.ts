/// <reference lib="webworker" />
import { loadRuntime, type QualificationRuntime } from "./runtime";
import type { WorkerRequest, WorkerResponse } from "./engine";

let runtime: Promise<QualificationRuntime> | null = null;

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, op, payload } = event.data;
  const reply = (message: WorkerResponse) => self.postMessage(message);
  try {
    runtime ??= loadRuntime();
    const rt = await runtime;
    const result = op === "analyze" ? rt.analyze(payload) : op === "validate" ? rt.validate(payload) : op === "reportHtml" ? rt.reportHtml(payload) : rt.capabilities();
    reply({ id, ok: true, result });
  } catch (error) {
    runtime = null;
    const e = error as { code?: unknown; message?: unknown };
    reply({ id, ok: false, error: { code: typeof e.code === "string" ? e.code : "ENGINE_ERROR", message: typeof e.message === "string" ? e.message : String(error) } });
  }
};
