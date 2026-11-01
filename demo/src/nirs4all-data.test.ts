import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { importFiles, type FormatsRuntime, type IoRuntime } from "./dataset-io";

// Real datasets from the sibling nirs4all-data checkout; skipped where it is absent (CI).
const root = new URL("../../../nirs4all-data/", import.meta.url);
const require = createRequire(import.meta.url);
const io = require("@nirs4all/io-wasm") as IoRuntime;
const formats = require("@nirs4all/formats-wasm") as FormatsRuntime;
const load = (dir: string) => {
  const path = new URL(`${dir}/`, root);
  const files = readdirSync(path).filter((name) => name.endsWith(".csv")).map((name) => ({ name, bytes: new Uint8Array(readFileSync(new URL(name, path))) }));
  return importFiles(files, dir, io, formats);
};

describe.skipIf(!existsSync(root))("nirs4all-data folders dropped as they are", { timeout: 60000 }, () => {
  it("reads Xcal/Xval/Ycal/Yval and IO's binary task", () => {
    const { input } = load("classification/COFFEE_sp/Species_56_Bagnall");
    expect(input.samples.filter((s) => s.partition === "retained_test")).toHaveLength(28);
    expect(input.targets[0]?.kind).toBe("categorical");
  });

  it("skips empty metadata files instead of refusing the dataset", () => {
    const { input, skipped } = load("classification/COFFEE_orig/CoffeeType_kenstone70_strat");
    expect(skipped.sort()).toEqual(["Mtest.csv", "Mtrain.csv"]);
    expect(input.samples).toHaveLength(70);
  });

  it("keeps a metadata column that IO prefixed because it collides with y", () => {
    const { input } = load("classification/MALARIA/Sporozoite2C_229_Maia_Acc94.5");
    expect(input.metadata?.columns.map((c) => c.name)).toEqual(["ID1", "ID2", "y"]);
  });

  it("types numeric metadata as continuous and keeps per-sample columns only", () => {
    const { input } = load("regression/PLUMS/Brix_spxy70");
    expect(input.metadata?.columns).toEqual([{ name: "N", kind: "continuous" }]);
    expect(input.targets[0]?.kind).toBe("continuous");
  });
});
