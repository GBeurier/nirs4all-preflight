export interface QualificationRuntime {
  analyze(input: unknown): unknown;
  validate(input: unknown): unknown;
  /** JSON text in, report JSON text out; nothing is decoded by JavaScript. */
  analyzeJson(input: string): string;
  validateJson(input: string): string;
  reportHtml(report: unknown): string;
  capabilities(): unknown;
}
/** Creates one Rust + Methods instance. Run inside a worker to support cancellation. */
/** `dagMlWasmModule` supplies the dag-ml-wasm module bytes (validation probe) where it cannot be fetched. */
export function createQualificationRuntime(options?: { wasmModule?: BufferSource | WebAssembly.Module; dagMlWasmModule?: BufferSource | WebAssembly.Module }): Promise<QualificationRuntime>;
