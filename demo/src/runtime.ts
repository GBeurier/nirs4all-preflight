// One Rust protocol core and one Methods instance inside the analysis worker.
import { createQualificationRuntime, type QualificationRuntime } from '@nirs4all/preflight';
export type { QualificationRuntime };
export async function loadRuntime(): Promise<QualificationRuntime> {
  return createQualificationRuntime();
}
