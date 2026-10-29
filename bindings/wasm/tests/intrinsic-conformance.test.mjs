import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createQualificationRuntime } from '../index.js';

const fixture = JSON.parse(await readFile(new URL('../../../crates/nirs4all-preflight/tests/fixtures/intrinsic_legacy_v1.json', import.meta.url), 'utf8'));
const native = JSON.parse(await readFile(new URL('../../../crates/nirs4all-preflight/tests/fixtures/intrinsic_native_v1.json', import.meta.url), 'utf8'));
const runtime = await createQualificationRuntime({
  wasmModule: await readFile(new URL('../native/nirs4all_preflight_wasm_bg.wasm', import.meta.url)),
  dagMlWasmModule: await readFile(new URL('../node_modules/dag-ml-wasm/dag_ml_wasm_bg.wasm', import.meta.url)),
});

function close(actual, expected, path = '') {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', path);
    assert.ok(Number.isFinite(actual), path);
    const tolerance = path.includes('.sam_') ? 2e-10 : 2e-12 + 2e-11 * Math.abs(expected);
    assert.ok(Math.abs(actual - expected) <= tolerance, `${path}: ${actual} versus ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, path);
    expected.forEach((value, i) => close(actual[i], value, `${path}[${i}]`));
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path);
    for (const [key, value] of Object.entries(expected)) close(actual[key], value, `${path}.${key}`);
  } else assert.equal(actual, expected, path);
}

for (const inputCase of fixture.cases) {
  test(`real Rust/Methods WASM preserves native intrinsic ${inputCase.id} results and refusals`, () => {
    const report = runtime.analyze(inputCase.input);
    assert.equal(report.validation.valid, true);
    const actual = report.metrics.filter(metric => metric.metric_id.startsWith('intrinsic.'));
    const expected = native.cases.find(item => item.id === inputCase.id).metrics;
    assert.equal(actual.length, expected.length);
    for (const metric of expected) {
      const match = actual.find(item => item.metric_id === metric.metric_id);
      assert.ok(match, metric.metric_id);
      // Counts, integer statuses, identities and reason codes remain exact;
      // tolerances apply only to finite numerical kernel results.
      assert.equal(match.status, metric.status, metric.metric_id);
      assert.equal(match.reason_code, metric.reason_code, metric.metric_id);
      assert.deepEqual(match.denominators, metric.denominators, metric.metric_id);
      if (metric.parameters.row_status_codes) assert.deepEqual(match.parameters.row_status_codes, metric.parameters.row_status_codes);
      close(match, metric, metric.metric_id);
    }
    if (inputCase.id === 'masked') {
      const rms = actual.find(metric => metric.metric_id === 'intrinsic.reference.rms');
      assert.equal(rms.value.values[2], null);
      assert.equal(rms.value.observation_ids[2], 'obs-2');
      const lof = actual.find(metric => metric.metric_id === 'intrinsic.local_density.lof');
      assert.equal(lof.status, 'unsupported');
      assert.equal(lof.value, null);
      assert.equal(lof.reason_code, 'LOF_REQUIRES_COMPLETE_SPECTRA');
    }
  });
}
