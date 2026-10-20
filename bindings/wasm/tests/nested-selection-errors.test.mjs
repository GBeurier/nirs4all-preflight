// Review final1 P0: failures of the dag-ml-wasm nested selection keep their
// structured cause. dag-ml-wasm is replaced by a stand-in whose
// `execute_nested_selection_json` fails the way the real module does (it
// rethrows callback exceptions inside its own error); Methods, the Methods
// JS controller and the Rust engine are the real ones. Expected values are
// those of the CPU provider (`dagml::nested_selection_failure`, tested in
// crates/nirs4all-preflight/tests/dag_probe.rs).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as methods from '@nirs4all/methods';

let failure;
mock.module('dag-ml-wasm', {
  exports: {
    default: async () => {},
    dag_ml_version: () => 'stand-in',
    derive_controller_manifest_json: () => '{}',
    execute_nested_selection_json: (_request, _manifests, _envelope, _invoke, metrics) => failure(metrics),
  },
});
const { createQualificationRuntime } = await import('../index.js');
const bytes = await readFile(new URL('../native/nirs4all_preflight_wasm_bg.wasm', import.meta.url));
const runtime = await createQualificationRuntime({ wasmModule: bytes });
const golden = JSON.parse(await readFile(new URL('../../../crates/nirs4all-preflight/tests/fixtures/probe_sklearn_v1.json', import.meta.url), 'utf8'));
const input = structuredClone(golden.cases.base.input);
input.options.validation_probe = { estimators: ['pls'] };

/** The real Methods refusal message of an input outside the domain. */
const refusal = (() => {
  try {
    methods.statsRegressionScores(Float64Array.from([1, 2 ** 300]), Float64Array.from([1, 2]));
  } catch (error) {
    assert.ok(error instanceof methods.N4mError);
    return error.message;
  }
  throw new Error('Methods accepted an input outside its domain');
})();

const probe = behaviour => {
  failure = behaviour;
  const rmse = runtime.analyze(input).metrics.find(m => m.metric_id === 'probe.rmse');
  return { status: rmse.status, reason: rmse.reason_code, detail: rmse.parameters.provider_error_detail, domain: rmse.parameters.numerical_domain };
};

test('a Methods domain refusal in the selection-metrics callback stays NUMERICAL_DOMAIN_EXCEEDED', () => {
  const r = probe(metrics => {
    try {
      metrics('rmse', JSON.stringify({ y_true: [1, 2 ** 300], y_pred: [1, 2] }));
    } catch (error) {
      throw new Error(`selection metric callback failed: ${error.message}`);
    }
    throw new Error('the metrics callback accepted an input outside the domain');
  });
  assert.equal(r.status, 'unsupported');
  assert.equal(r.reason, 'NUMERICAL_DOMAIN_EXCEEDED');
  assert.equal(r.detail, `selection metric callback failed: ${refusal}`);
  assert.match(r.domain, /2\^-256, 2\^256/);
});

test('a Methods domain refusal reported by a DAG controller stays NUMERICAL_DOMAIN_EXCEEDED', () => {
  const r = probe(() => { throw new Error(`controller callback failed: ${refusal}`); });
  assert.equal(r.status, 'unsupported');
  assert.equal(r.reason, 'NUMERICAL_DOMAIN_EXCEEDED');
  assert.equal(r.detail, `controller callback failed: ${refusal}`);
});

test('an ordinary DAG-ML failure is a provider error with its message', () => {
  const r = probe(() => { throw new Error('outer fold `fold0`: fold assignment failed'); });
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'DAG_ML_WASM_NESTED_SELECTION_FAILED');
  assert.equal(r.detail, 'outer fold `fold0`: fold assignment failed');
  assert.equal(r.domain, undefined);
});

test('an adapter refusal in the metrics callback keeps its reason', () => {
  const r = probe(metrics => {
    try {
      metrics('r2', JSON.stringify({ y_true: [1, 2], y_pred: [1, 2] }));
    } catch (error) {
      throw new Error(`selection metric callback failed: ${error.message}`);
    }
    throw new Error('the metrics callback accepted an unknown metric');
  });
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'UNSUPPORTED_SELECTION_METRIC');
  assert.equal(r.detail, 'selection metric callback failed: UNSUPPORTED_SELECTION_METRIC');
});
