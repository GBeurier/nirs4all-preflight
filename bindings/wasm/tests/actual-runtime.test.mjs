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
test('WASM rejects identity leakage before diagnostics',()=>{
 const bad=structuredClone(input);
 bad.samples.at(-1).physical_sample_id=bad.samples[0].physical_sample_id;
 const report=runtime.analyze(bad);
 assert.equal(report.status,'failed');
 assert.equal(report.metrics.length,0);
});
test('WASM noise proxy and declared quasi-duplicates match hand values',()=>{
 // SG window 5 / quadratic: weights (-3,12,17,12,-3)/35, white-noise gain^2 = 18/35.
 const quadratic=Array.from({length:11},(_,j)=>j*j);
 const impulse=Array.from({length:11},(_,j)=>1+2*j+(j===5?35:0));
 const linear=Array.from({length:11},(_,j)=>100+j);
 const rows=[['s0','development',quadratic],['s1','development',impulse],['s2','development',quadratic.map(v=>v+0.01)],['s3','development',linear],['t0','retained_test',linear.map(v=>v+0.02)]];
 const report=runtime.analyze({schema_version:1,data_origin:'synthetic',
  sources:[{source_id:'nir',observation_ids:rows.map(r=>`o-${r[0]}`),sample_ids:rows.map(r=>r[0]),x:rows.map(r=>r[2]),axis:Array.from({length:11},(_,j)=>1000+10*j),axis_unit:'nm',signal_unit:'absorbance'}],
  samples:rows.map(r=>({sample_id:r[0],physical_sample_id:`p-${r[0]}`,partition:r[1],instrument:'a',campaign:'c'})),
  options:{noise_proxy:{window_bands:5,polyorder:2},quasi_duplicates:{tolerance:0.05}}});
 const metrics=Object.fromEntries(report.metrics.map(m=>[m.metric_id,m]));
 const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
 // Development rows only: residual energy 630 over 4 rows x 7 interior bands.
 near(metrics['measurement.noise_proxy'].value[5],Math.sqrt(157.5));
 near(metrics['measurement.noise_proxy_pooled'].value,Math.sqrt(43.75));
 assert.equal(metrics['measurement.noise_proxy'].value[0],null);
 const within=metrics['integrity.quasi_duplicate_pairs'].value;
 assert.equal(within.suspect_pairs,1);
 assert.equal(within.candidate_pairs,6);
 near(within.listed_pairs[0].rms_difference,0.01);
 const cross=metrics['integrity.cross_partition_quasi_duplicate_pairs'].value;
 assert.equal(cross.suspect_pairs,1);
 assert.equal(cross.candidate_pairs,4);
 assert.equal(metrics['structure.snv_sensitivity'].status,'computed');
 assert.ok(report.capabilities.some(c=>c.capability_id==='quasi_duplicates'&&c.available));
});
