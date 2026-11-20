// Synthetic engine reports for the repeatability / noise-proxy tests (controlled data only).
import { buildQualificationReportView, type EngineReport } from "nirs4all-ui/qualification";
import type { EngineInput } from "../../input";

export const metric = (metric_id: string, value: unknown, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  metric_id,
  protocol_version: "0.2.0",
  status: "computed",
  reason_code: null,
  scope: "source_target",
  source_id: "nir",
  target_id: null,
  view_id: "native",
  population_id: "development_real",
  value,
  unit: "abs",
  denominators: {},
  parameters,
  ...extra,
});

export const view = (metrics: unknown[]) => buildQualificationReportView({
  schema_version: 1,
  data_origin: "synthetic",
  engine_version: "0.2.0",
  protocol_bundle_version: "0.2.0",
  profile_status: "exploratory",
  status: "complete",
  validation: { valid: true, issues: [] },
  capabilities: [],
  metrics,
  findings: [],
  limitations: [],
} as unknown as EngineReport);

/** 4 physical samples × 3 rescans on instrument A (+ one retained-test row), 8 bands on an irregular axis. */
export function replicateInput(): EngineInput {
  const axis = [1000, 1004, 1010, 1012, 1020, 1021, 1030, 1050];
  const x: (number | null)[][] = [];
  const sample_ids: string[] = [];
  const types: ("rescan" | "unknown")[] = [];
  for (let g = 0; g < 4; g++) for (let k = 0; k < 3; k++) {
    sample_ids.push(`s${g}-${k}`);
    types.push("rescan");
    x.push(axis.map((_, c) => g * 1 + c * 0.1 + (k - 1) * 0.01));
  }
  sample_ids.push("t0");
  types.push("unknown");
  x.push(axis.map(() => 99));
  x[1]![2] = null;
  return {
    schema_version: 1,
    sources: [{ source_id: "nir", observation_ids: sample_ids.map((s) => `o-${s}`), sample_ids, x, axis, axis_unit: "nm", signal_unit: "abs", repetition_types: types }],
    samples: [
      ...sample_ids.filter((s) => s !== "t0").map((s) => ({ sample_id: s, physical_sample_id: s.split("-")[0]!, instrument: "A" })),
      { sample_id: "t0", partition: "retained_test" as const, instrument: "A" },
    ],
    targets: [],
    options: {},
  };
}
