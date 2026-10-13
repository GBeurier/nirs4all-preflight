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
test('WASM clustering uses Methods HDBSCAN on canonical PCA scores',()=>{
 const n=40, ids=Array.from({length:n},(_,i)=>`s${String(i).padStart(2,'0')}`);
 const x=ids.map((_,i)=>{const j=Math.sin(i*0.37), side=i%2?10:-10; return [side+j,j,side-j];});
 const blobs={schema_version:1,data_origin:'synthetic',options:{},targets:[],
  samples:ids.map(sample_id=>({sample_id})),
  sources:[{source_id:'blobs',observation_ids:ids.map(id=>`o${id}`),sample_ids:ids,x,axis:[1,2,3]}]};
 const report=runtime.analyze(blobs);
 const metrics=Object.fromEntries(report.metrics.map(m=>[m.metric_id,m]));
 assert.equal(metrics['clustering.candidate_cluster_count'].value,2);
 assert.equal(metrics['clustering.partition'].value.labels.length,n);
 assert.equal(metrics['clustering.subsample_stability'].denominators.n_ari_evaluable_subsamples,50);
 assert.equal(metrics['clustering.subsample_stability'].value.ari_assigned_in_both.max,1);
 assert.equal(metrics['clustering.condensed_tree'].value[0].birth_distance,null);
 assert.ok(report.capabilities.some(c=>c.capability_id==='clustering'&&c.available&&!c.qualified));
 assert.equal(metrics['clustering.gaussian_null_model'].status,'computed');
 assert.equal(metrics['clustering.cluster_appearance_frequency'].status,'computed');
 assert.ok(report.findings.some(f=>f.rule_id.startsWith('structure.clustering.')&&f.confidence==='unknown'));
});
// Review 2026-10-13 P0: CPU and WASM partitions diverged (7 vs 8 groups) on
// tie-heavy data from 4.4e-16 PCA differences. The score grid makes both hosts
// match the independent NumPy/SciPy/scikit-learn golden that the native test
// also checks (crates/nirs4all-preflight/tests/clustering_golden.rs).
test('WASM clustering matches the full-chain Python golden',async()=>{
 const golden=JSON.parse(await readFile(new URL('../../../crates/nirs4all-preflight/tests/fixtures/clustering_v2_golden.json',import.meta.url),'utf8'));
 const near=(a,b)=>a===null||b===null?a===b:Math.abs(a-b)<=1e-12*Math.max(1,Math.abs(b));
 const assessments=[];
 for(const c of golden.cases){
  const report=runtime.analyze(c.input), e=c.expected;
  const m=Object.fromEntries(report.metrics.map(x=>[x.metric_id,x]));
  const labels=m['clustering.partition'].value.labels, forward=new Map(), backward=new Map();
  labels.forEach((l,i)=>{
   assert.equal(l<0,e.labels[i]<0,c.name);
   if(l<0)return;
   assert.equal(forward.get(l)??e.labels[i],e.labels[i],c.name);
   assert.equal(backward.get(e.labels[i])??l,l,c.name);
   forward.set(l,e.labels[i]); backward.set(e.labels[i],l);
  });
  assert.equal(forward.size,e.cluster_count,c.name);
  const stability=m['clustering.subsample_stability'];
  assert.equal(stability.parameters.seed,e.plan_seed);
  assert.deepEqual(stability.value.unit_plans,e.unit_plans,c.name);
  for(const [variant,id] of [['scaled','clustering.subsample_stability'],['constant','clustering.subsample_stability_constant_parameters']]){
   m[id].value.per_subsample.forEach((g,i)=>{
    const w=e.variants[variant].per_subsample[i];
    assert.equal(g.assigned_in_both_size,w.assigned_in_both_size,`${c.name} ${variant} ${i}`);
    assert.equal(g.cluster_count,w.cluster_count,`${c.name} ${variant} ${i}`);
    assert.ok(near(g.ari,w.ari),`${c.name} ${variant} ari ${i}`);
   });
  }
  m['clustering.gaussian_null_model'].value.per_replicate.forEach((g,i)=>{
   const w=e.null.per_replicate[i];
   assert.equal(g.cluster_count,w.cluster_count,`${c.name} null ${i}`);
   assert.ok(near(g.median_ari,w.median_ari),`${c.name} null ari ${i}`);
  });
  assessments.push(m['clustering.partition_assessment'].value.assessment);
 }
 assert.deepEqual(assessments,['uncertain_partition','uncertain_partition','stable_candidate_partition','compatible_with_continuous_structure']);
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
