import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

// The published IO/Formats packages currently ship wasm-bindgen's Node loader.
// Keep their generated glue and binaries; replace only the filesystem bootstrap.
export function browserWasm(): Plugin {
  const require = createRequire(import.meta.url);
  const packages: Record<string, string> = {
    "virtual:nirs4all-io": "@nirs4all/io-wasm",
    "virtual:nirs4all-formats": "@nirs4all/formats-wasm",
  };
  return {
    name: "nirs4all-browser-wasm",
    resolveId(id) { if (packages[id]) return `\0${id}`; },
    load(id) {
      const pkg = packages[id.slice(1)];
      if (!pkg) return;
      const path = require.resolve(pkg);
      const source = readFileSync(path, "utf8");
      const marker = source.indexOf("const wasmPath =");
      if (marker < 0) throw new Error(`Unexpected wasm-bindgen loader in ${pkg}`);
      const names = [...source.matchAll(/^exports\.(\w+) = /gm)].map((m) => m[1]);
      const binary = join(dirname(path), path.endsWith("nirs4all_io_wasm.js") ? "nirs4all_io_wasm_bg.wasm" : "nirs4all_formats_wasm_bg.wasm");
      return `import wasmUrl from ${JSON.stringify(`${binary}?url`)};
const exports = {};
${source.slice(0, marker)}
let wasm;
let pending;
export function init() {
  return pending ??= fetch(wasmUrl).then(response => {
    if (!response.ok) throw new Error('WASM download failed: ' + response.status);
    return response.arrayBuffer();
  }).then(bytes => WebAssembly.instantiate(bytes, __wbg_get_imports())).then(result => {
    wasm = result.instance.exports;
    wasm.__wbindgen_start();
  }).catch(error => { pending = undefined; throw error; });
}
export { ${names.join(", ")} };`;
    },
  };
}
