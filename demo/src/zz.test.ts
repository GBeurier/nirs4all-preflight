import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { importFiles, type FormatsRuntime, type IoRuntime } from "./dataset-io";
const require = createRequire(import.meta.url);
const io = require("@nirs4all/io-wasm") as IoRuntime;
const formats = require("@nirs4all/formats-wasm") as FormatsRuntime;
it("paths", () => {
  const d = "../../nirs4all-data/regression/PLUMS/Brix_spxy70";
  const files = readdirSync(d).filter((n) => n.endsWith(".csv")).map((name) => ({ name: `Brix_spxy70/${name}`, bytes: new Uint8Array(readFileSync(`${d}/${name}`)) }));
  try { const { input, tables } = importFiles(files, "x", io, formats); console.log("PATH-OK", input.samples.length, JSON.stringify(tables.map((t) => [t.file, t.role, t.partition]))); } catch (e) { console.log("PATH-ERR", (e as Error).message); }
  const withPdf = [...files, { name: "Brix_spxy70/paper.pdf", bytes: new TextEncoder().encode("%PDF-1.4 fake") }, { name: "Brix_spxy70/get_data.R", bytes: new TextEncoder().encode("x <- 1") }];
  try { const { input } = importFiles(withPdf, "x", io, formats); console.log("EXTRA-OK", input.samples.length); } catch (e) { console.log("EXTRA-ERR", (e as Error).message); }
}, 60000);
