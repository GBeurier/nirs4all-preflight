import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createQualificationRuntime } from '../index.js';

const bytes = await readFile(new URL('../native/nirs4all_preflight_wasm_bg.wasm',import.meta.url));
const runtime = await createQualificationRuntime({wasmModule:bytes});
const input=JSON.parse(await readFile(new URL('../../../examples/first_run.json',import.meta.url),'utf8'));

test('actual Rust WASM + Methods WASM computes canonical report',()=>{
  assert.equal(runtime.validate(input).valid,true);
  const report=runtime.analyze(input);
  const metrics=Object.fromEntries(report.metrics.map(m=>[m.metric_id,m]));
  assert.equal(report.profile_status,'exploratory');
  assert.equal(metrics['population.development_real_samples'].value,5);
  assert.equal(metrics['structure.effective_dimension'].status,'computed');
  assert.equal(metrics['target.continuous_distribution'].value.count,5);
  assert.equal(metrics['local.global_contrast'].status,'computed');
  assert.ok(runtime.reportHtml(report).includes('<!doctype html>'));
});
// b=25 and b=409 are NumPy 2.2.6 default_rng(derived seed).permutation(12) goldens.
test('WASM metadata associations match the native engine goldens',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../examples/metadata_association.json',import.meta.url),'utf8'));
  const report=runtime.analyze(fixture);
  const find=(id,metadata)=>report.metrics.find(m=>m.metric_id===id&&m.parameters.metadata===metadata);
  const test=find('association.metadata_target_test','instrument');
  assert.equal(test.status,'computed');
  assert.equal(test.value.n_at_least_observed,25);
  assert.equal(test.value.p_value_holm,0.052);
  assert.equal(test.parameters.permutation_plan.seed,'12673246378241812381');
  assert.equal(test.parameters.permutation_plan.n_permutations_executed,999);
  assert.ok(Math.abs(find('association.metadata_target','instrument').value.effect_size-0.5318805854300557)<1e-12);
  assert.equal(find('association.metadata_target_test','campaign').value.n_at_least_observed,409);
  assert.ok(runtime.capabilities().some(c=>c.capability_id==='metadata_association_tests'&&c.available));
});
test('WASM rejects identity leakage before diagnostics',()=>{
 const bad=structuredClone(input);
 bad.samples.at(-1).physical_sample_id=bad.samples[0].physical_sample_id;
 const report=runtime.analyze(bad);
 assert.equal(report.status,'failed');
 assert.equal(report.metrics.length,0);
});
