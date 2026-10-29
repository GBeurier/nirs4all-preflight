import { createStore, del, get, set, values } from "idb-keyval";
import type { SavedDataset } from "./dataset";

// Separate records avoid rewriting every large dataset on each import/removal.
let store: ReturnType<typeof createStore> | undefined;
const storage = () => store ??= createStore("nirs4all-preflight-datasets", "datasets");
export const listDatasets = () => values<SavedDataset>(storage()).then((items) => items.sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
export const saveDataset = (dataset: SavedDataset) => set(dataset.id, dataset, storage());
export const readDataset = (id: string) => get<SavedDataset>(id, storage());
export const removeDataset = (id: string) => del(id, storage());
