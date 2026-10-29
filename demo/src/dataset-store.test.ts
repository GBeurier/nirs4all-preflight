import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { listDatasets, readDataset, removeDataset, saveDataset } from "./dataset-store";
import { syntheticInput } from "./synthetic";

it("keeps complete datasets for reopening and deletes only the selected entry", async () => {
  const first = { id: "first", name: "Dataset A", savedAt: "2026-01-01", input: syntheticInput("pitfalls") };
  const second = { ...first, id: "second", name: "Dataset B", savedAt: "2026-02-01" };
  await saveDataset(first);
  await saveDataset(second);
  expect((await listDatasets()).map((item) => item.id)).toEqual(["second", "first"]);
  expect(await readDataset("first")).toEqual(first);
  await removeDataset("first");
  expect(await readDataset("first")).toBeUndefined();
  expect(await readDataset("second")).toEqual(second);
});
