// wasm-pack writes native/.gitignore='*'; npm otherwise drops its assets.
import { statSync, writeFileSync } from 'node:fs';
for (const file of ['nirs4all_preflight_wasm.js', 'nirs4all_preflight_wasm.d.ts', 'nirs4all_preflight_wasm_bg.wasm']) {
  if (!statSync(new URL(`../native/${file}`, import.meta.url)).size) throw new Error(`Missing WASM release asset: ${file}`);
}
writeFileSync(new URL('../native/.npmignore', import.meta.url), '# Generated WASM assets are part of this distribution.\n');
