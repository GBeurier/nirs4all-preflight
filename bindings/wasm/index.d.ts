export interface QualificationRuntime {
  analyze(input: unknown): unknown;
  validate(input: unknown): unknown;
  reportHtml(report: unknown): string;
  capabilities(): unknown;
}
/** Creates one Rust + Methods instance. Run inside a worker to support cancellation. */
export function createQualificationRuntime(options?: { wasmModule?: BufferSource | WebAssembly.Module }): Promise<QualificationRuntime>;
