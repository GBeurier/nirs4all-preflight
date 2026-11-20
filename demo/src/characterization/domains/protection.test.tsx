// Retained-test protection: the domain module never reads target values (of retained-test rows or any row).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EngineInput } from "../../input";
import { DomainShiftView } from "./DomainShiftView";
import { domainModel, interpret } from "./model";
import { domainPopulations } from "./populations";
import { auditInput, auditView } from "./testkit";
import { computeDiagnostics } from "./kernels";

/** Input whose targets throw on any access (retained-test rows included). */
function guardedInput(): EngineInput {
  const input = auditInput();
  return Object.defineProperty({ ...input }, "targets", { get() { throw new Error("target values accessed"); }, enumerable: true }) as EngineInput;
}

describe("retained-test Y protection", () => {
  it("model, populations, kernels and view never access target values", async () => {
    const input = guardedInput();
    const view = auditView();
    const [f] = domainModel(view, input, "nir");
    interpret(f!.comparisons[0]!, f!.inference);
    const pop = domainPopulations(input, "nir", f!.comparisons[0]!)!;
    await computeDiagnostics(pop, { audit: true, energyOnSpectra: false, monitorOnSpectra: false }, null);
    const html = renderToStaticMarkup(<DomainShiftView t={((k: string) => k) as never} locale="en" view={view} input={input} sourceId="nir" targetId="y" />);
    expect(html).toContain("Target shift is intentionally not evaluated. Retained-test target values remain protected.");
    expect(html).toContain("Statistical inference unavailable");
  });

  it("no source file of the module references input targets", () => {
    const dir = __dirname;
    for (const file of readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && n !== "testkit.ts")) {
      const text = readFileSync(join(dir, file), "utf8").replace(/\/\/.*$/gm, "");
      expect(text, file).not.toMatch(/\.targets\b/);
    }
  });
});
