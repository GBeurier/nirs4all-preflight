import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildExportConfig } from "nirs4all-ui/datasetBuilder";
import { assembleDraft, prepareDataset, type FormatsRuntime, type IoRuntime } from "./dataset-io";
import { toEngineInput } from "./dataset";
import { parseCanonicalInput } from "./input";

const require = createRequire(import.meta.url);
// Exercise the exact distributed native IO/Formats binaries used in the browser.
const io = require("@nirs4all/io-wasm") as IoRuntime;
const formats = require("@nirs4all/formats-wasm") as FormatsRuntime;
const file = (name: string, text: string) => ({ name, bytes: new TextEncoder().encode(text) });
const assemble = (files: ReturnType<typeof file>[]) => {
  const draft = prepareDataset(files, io, formats);
  return assembleDraft(draft, buildExportConfig("test", draft.sources), draft.sources, io);
};

describe("native dataset import → shared builder → preflight", () => {
  it("loads a combined CSV with physical identities, targets and metadata", () => {
    const input = assemble([file("combined.csv", "sample_id;1000;1100;1200;protein;instrument\ns1;0.1;0.2;0.3;11;A\ns2;0.4;0.5;0.6;12;B")]);
    expect(input.samples.map((s) => [s.physical_sample_id, s.instrument])).toEqual([["s1", "A"], ["s2", "B"]]);
    expect(input.sources[0]?.axis).toEqual([1000, 1100, 1200]);
    expect(input.sources[0]?.x).toHaveLength(2);
    expect(input.targets[0]?.values.map((v) => v.value)).toEqual([11, 12]);
    expect(input.options.independence_unit).toBe("unknown");
    expect(parseCanonicalInput(JSON.stringify(input)).ok).toBe(true);
  });

  it("loads separate X/Y train and test tables without exposing test as development", () => {
    const input = assemble([
      file("Xtrain.csv", "1000,1100,1200\n0.1,0.2,0.3\n0.4,0.5,0.6"), file("Ytrain.csv", "protein\n11\n12"),
      file("Xtest.csv", "1000,1100,1200\n0.7,0.8,0.9"), file("Ytest.csv", "protein\n13"),
    ]);
    expect(input.samples.filter((s) => s.partition === "development")).toHaveLength(2);
    expect(input.samples.filter((s) => s.partition === "retained_test")).toHaveLength(1);
    expect(input.sources[0]?.x).toHaveLength(3);
    expect(input.targets[0]?.values.map((v) => v.value).sort()).toEqual([11, 12, 13]);
  });

  it("preserves missing spectral cells instead of imputing them", () => {
    const input = assemble([file("combined.csv", "sample_id;1000;1100;1200;protein\ns1;0.1;;0.3;11\ns2;0.4;0.5;0.6;12")]);
    expect(input.sources[0]?.x[0]).toEqual([expect.closeTo(.1), null, expect.closeTo(.3)]);
    expect(input.samples).toHaveLength(2);
  });

  it("applies shared builder column edits through IO", () => {
    const draft = prepareDataset([file("combined.csv", "sample_id;1000;1100;1200;protein\ns1;0.1;0.2;0.3;11\ns2;0.4;0.5;0.6;12")], io, formats);
    const sources = draft.sources.map((s) => ({ ...s, columns: s.columns.map((c) => c.name === "protein" ? { ...c, assignedRole: "metadata" as const } : c) }));
    const input = assembleDraft(draft, buildExportConfig("edited", sources), sources, io);
    expect(input.targets).toHaveLength(0);
    expect(input.sources[0]?.axis).toEqual([1000, 1100, 1200]);
  });

  it("keeps all repetitions without declaring their technical type", () => {
    const input = assemble([file("combined.csv", "sample_id;1000;1100;1200;protein\ns1;0.1;0.2;0.3;11\ns1;0.4;0.5;0.6;11")]);
    expect(input.samples).toHaveLength(1);
    expect(input.sources[0]?.sample_ids[0]).toBe(input.sources[0]?.sample_ids[1]);
    expect(new Set(input.sources[0]?.observation_ids).size).toBe(2);
    expect(input.sources[0]?.repetition_types).toEqual(["unknown", "unknown"]);
  });

  it("maps categorical targets with their native labels", () => {
    const input = assemble([file("combined.csv", "sample_id;1000;1100;1200;class\ns1;0.1;0.2;0.3;apple\ns2;0.4;0.5;0.6;pear")]);
    expect(input.targets[0]?.kind).toBe("categorical");
    expect(input.targets[0]?.values.map((v) => v.category)).toEqual(["apple", "pear"]);
  });

  it("decodes JCAMP spectra through Formats before IO assembly", () => {
    const input = assemble([file("spectrum.jdx", "##TITLE=Test\n##JCAMP-DX=5.00\n##DATA TYPE=INFRARED SPECTRUM\n##XUNITS=NANOMETERS\n##YUNITS=ABSORBANCE\n##FIRSTX=1000\n##LASTX=1200\n##NPOINTS=3\n##XYDATA=(X++(Y..Y))\n1000 0.1 0.2 0.3\n##END=\n")]);
    expect(input.sources[0]?.axis).toEqual([1000, 1100, 1200]);
    expect(input.sources[0]?.axis_unit).toBe("nm");
    expect(input.sources[0]?.x[0]).toEqual([expect.closeTo(.1), expect.closeTo(.2), expect.closeTo(.3)]);
    expect(input.targets).toEqual([]);
  });

  it("keeps physical identities across declared train/test/predict partitions", () => {
    const input = assemble([file("combined.csv", "sample_id;1000;1100;1200;protein;partition\ns1;0.1;0.2;0.3;11;train\ns1;0.1;0.2;0.3;11;test\ns2;0.4;0.5;0.6;12;predict")]);
    expect(input.samples.map((s) => s.partition).sort()).toEqual(["development", "prediction", "retained_test"]);
    expect(input.samples.filter((s) => s.physical_sample_id === "s1")).toHaveLength(2);
    expect(new Set(input.samples.map((s) => s.sample_id)).size).toBe(3);
  });

  it("joins separate target files by the declared IDs rather than row position", () => {
    const input = assemble([
      file("Xtrain.csv", "sample_id;1000;1100;1200\ns1;0.1;0.2;0.3\ns2;0.4;0.5;0.6"),
      file("Ytrain.csv", "sample_id;protein\ns2;12\ns1;11"),
    ]);
    const physical = new Map(input.samples.map((s) => [s.sample_id, s.physical_sample_id]));
    expect(input.targets[0]?.values.map((v) => [physical.get(v.sample_id), v.value])).toEqual([["s1", 11], ["s2", 12]]);
  });

  it("joins one reference per sample onto every repeated spectrum through IO", () => {
    const input = assemble([
      file("Xtrain.csv", "sample_id;1000;1100;1200\ns1;0.1;0.2;0.3\ns1;0.15;0.25;0.35\ns2;0.4;0.5;0.6"),
      file("Ytrain.csv", "sample_id;protein\ns2;12\ns1;11"),
    ]);
    expect(input.samples).toHaveLength(2);
    expect(input.sources[0]?.x).toHaveLength(3);
    expect(input.targets[0]?.values.map((value) => value.value)).toEqual([11, 11, 12]);
  });

  it("keeps keyed train and test joins inside their own partitions", () => {
    const input = assemble([
      file("Xtrain.csv", "sample_id;1000;1100;1200\ns1;0.1;0.2;0.3\ns2;0.4;0.5;0.6"),
      file("Ytrain.csv", "sample_id;protein\ns2;12\ns1;11"),
      file("Xtest.csv", "sample_id;1000;1100;1200\ns3;0.7;0.8;0.9"),
      file("Ytest.csv", "sample_id;protein\ns3;13"),
    ]);
    expect(input.samples.map((s) => s.partition).sort()).toEqual(["development", "development", "retained_test"]);
    const physical = new Map(input.samples.map((s) => [s.sample_id, s.physical_sample_id]));
    expect(input.targets[0]?.values.map((v) => [physical.get(v.sample_id), v.value]).sort()).toEqual([["s1", 11], ["s2", 12], ["s3", 13]]);
  });

  it("clears an identity when its column is reassigned in the builder", () => {
    const draft = prepareDataset([file("combined.csv", "sample_id;1000;1100;1200;protein\ns1;0.1;0.2;0.3;11\ns2;0.4;0.5;0.6;12")], io, formats);
    const sources = draft.sources.map((s) => ({ ...s, columns: s.columns.map((c) => c.name === "sample_id" ? { ...c, assignedRole: "ignored" as const } : c) }));
    const input = assembleDraft(draft, buildExportConfig("edited", sources), sources, io);
    expect(input.samples.every((sample) => sample.physical_sample_id === undefined)).toBe(true);
  });

  it("rejects incompatible schema versions", () => {
    expect(() => toEngineInput({ assembled_schema_version: 1, name: "old", blocks: {} })).toThrow(/v2/);
  });
});
