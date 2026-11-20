// Heavy domain-shift computations dispatched to a worker (domains.worker.ts) or, where no Worker exists
// (tests, server rendering), run inline. Every task is a plain-data request; Methods is loaded once per thread.
import { loadMethodsKernel } from "../preprocessing/methodsKernel";
import { computeDiagnostics, loadMethods, type DomainDiagnostics, type SpaceOptions } from "./kernels";
import { pairwiseMatrix, type PairwiseRequest, type PairwiseResult } from "./pairwise";
import { permutationNull, type PermutationRequest, type PermutationResult } from "./permutation";
import type { DomainPopulations } from "./populations";
import { exploreShift, type ExploreRequest, type ExploreResult } from "./shiftExplorer";

export type DomainTask =
  | { op: "diagnostics"; pop: DomainPopulations; opts: SpaceOptions; engineEnergy: number | null }
  | { op: "permutation"; req: PermutationRequest }
  | { op: "pairwise"; req: PairwiseRequest }
  | { op: "explore"; req: ExploreRequest };

export interface TaskResults {
  diagnostics: DomainDiagnostics;
  permutation: PermutationResult;
  pairwise: PairwiseResult;
  explore: ExploreResult;
}

export async function runTask(task: DomainTask): Promise<TaskResults[DomainTask["op"]]> {
  const m = await loadMethods();
  switch (task.op) {
    case "diagnostics":
      return computeDiagnostics(task.pop, task.opts, task.engineEnergy);
    case "permutation":
      return permutationNull(m, task.req);
    case "pairwise":
      return pairwiseMatrix(m, task.req);
    case "explore":
      return exploreShift(m, await loadMethodsKernel(), task.req);
  }
}
