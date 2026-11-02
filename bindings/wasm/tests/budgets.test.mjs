// Large inputs: the transport no longer refuses an input the engine accepts,
// and an input above the spectral cell budget is refused with the engine's
// own validation code before it is serialized.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { createQualificationRuntime } = await import('../index.js');
const runtime = await createQualificationRuntime({
  wasmModule: await readFile(new URL('../native/nirs4all_preflight_wasm_bg.wasm', import.meta.url)),
});

function input(n, p, options = {}) {
  const ids = Array.from({ length: n }, (_, i) => `s${i}`);
  return {
    schema_version: 1,
    sources: [{
      source_id: 'nir',
      observation_ids: ids.map((id) => `o-${id}`),
      sample_ids: ids,
      x: ids.map((_, i) => Array.from({ length: p }, (_, j) => 0.5 + 0.37 * Math.sin(i * 31 + j))),
      axis: Array.from({ length: p }, (_, j) => 1000 + j),
    }],
    samples: ids.map((sample_id) => ({ sample_id })),
    targets: [],
    options,
  };
}

test('an input above the cell budget is refused with CELL_BUDGET_EXCEEDED before serialization', () => {
  const big = input(3, 4, { max_cells: 10 });
  const validation = runtime.validate(big);
  assert.equal(validation.valid, false);
  assert.equal(validation.issues[0].code, 'CELL_BUDGET_EXCEEDED');
  assert.throws(() => runtime.analyze(big), (error) => error.code === 'CELL_BUDGET_EXCEEDED' && /12 spectral cells/.test(error.message));
});

test('a JSON input above the former 64 MiB transport limit reaches the engine', () => {
  // 3.6 million cells, about 80 MB of JSON: below max_cells, so it must validate.
  const large = input(1200, 3000);
  assert.ok(JSON.stringify(large).length > 64 * 1024 * 1024);
  assert.equal(runtime.validate(large).valid, true);
});
