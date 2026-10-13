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
 assert.ok(report.findings.some(f=>f.rule_id==='structure.clustering.uncertain_partition.v1'));
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
test('WASM duplicate reference conflicts match the hand-counted fixture',async()=>{
 const fixture=JSON.parse(await readFile(new URL('../../../examples/quasi_duplicates.json',import.meta.url),'utf8'));
 assert.equal(runtime.validate(fixture).valid,true);
 const report=runtime.analyze(fixture);
 const find=(id,target)=>report.metrics.find(m=>m.metric_id===id&&(target===undefined||m.target_id===target));
 const within=find('integrity.quasi_duplicate_pairs').value;
 assert.equal(within.suspect_pairs,5);
 assert.equal(within.candidate_pairs,8);
 assert.ok(Math.abs(within.listed_pairs[1].rms_difference-0.05/Math.SQRT2)<1e-9);
 assert.equal(within.listed_pairs[0].concordant_indices.campaign,false);
 assert.equal(find('integrity.quasi_duplicate_pairs').parameters.context,'same_instrument_any_campaign');
 const quasi=find('reference.quasi_duplicate_conflicts','moisture').value;
 assert.equal(quasi.compared_sample_pairs,3);
 assert.equal(quasi.incompatible_sample_pairs,2);
 assert.equal(find('reference.quasi_duplicate_conflicts','grade').value.incompatible_sample_pairs,2);
 assert.equal(find('reference.exact_duplicate_conflicts','moisture').value.incompatible_sample_pairs,1);
 assert.equal(find('reference.quasi_duplicate_conflicts','protein').reason_code,'REFERENCE_CONTRADICTION_TOLERANCE_NOT_DECLARED');
 assert.equal(report.findings.filter(f=>f.rule_id==='reference.verify_reference_or_pairing.v1'&&f.confidence==='unknown').length,3);
 const json=JSON.stringify(report);
 assert.ok(!json.includes('987.654')&&!json.includes('zz-test-only'));
});
test('WASM validation rejects wrapping SG orders like the CPU engine',()=>{
 // Review b1 #4: 4294967295 + 2 wrapped to a valid order on 32-bit WASM.
 for(const [window_bands,polyorder] of [[11,4294967295],[11,4294967294],[11,Number.MAX_SAFE_INTEGER],[41,38],[21,11],[1003,2]]){
  const v=runtime.validate({...input,options:{...input.options,noise_proxy:{window_bands,polyorder}}});
  assert.equal(v.valid,false,`${window_bands}/${polyorder}`);
  assert.ok(v.issues.some(i=>i.code==='INVALID_NOISE_PROXY_PARAMETERS'));
 }
 assert.equal(runtime.validate({...input,options:{...input.options,noise_proxy:{window_bands:13,polyorder:10}}}).valid,true);
});
test('WASM SNV keeps constant spectra flat and rounding residue unresolved',()=>{
 const axis=Array.from({length:11},(_,j)=>1000+10*j);
 const ids=['a','b','c'];
 // Review b1 #1: constant spectra 0.1, 0.5, 0.7 are identical (zero) in the SNV view.
 const flat=runtime.analyze({schema_version:1,data_origin:'synthetic',
  sources:[{source_id:'nir',observation_ids:ids.map(i=>`o-${i}`),sample_ids:ids,x:[0.1,0.5,0.7].map(v=>Array(11).fill(v)),axis,axis_unit:'nm',signal_unit:'absorbance'}],
  samples:ids.map(i=>({sample_id:i,physical_sample_id:i})),
  options:{quasi_duplicates:{tolerance:0.01,view:'snv',context:'source'}}});
 const fm=Object.fromEntries(flat.metrics.map(m=>[m.metric_id,m]));
 assert.equal(fm['integrity.quasi_duplicate_pairs'].value.suspect_pairs,3);
 assert.equal(fm['structure.snv_sensitivity'].reason_code,'ZERO_SNV_TOTAL_VARIANCE');
 // Review b1 #6: x_i = a_i [1..5] + b_i have identical SNV rows analytically.
 const rows=[[1,0],[1.1,100],[1.2,10],[2.1,-3]], rid=['a','b','c','d'];
 const residue=runtime.analyze({schema_version:1,data_origin:'synthetic',
  sources:[{source_id:'nir',observation_ids:rid.map(i=>`o-${i}`),sample_ids:rid,x:rows.map(([a,b])=>[1,2,3,4,5].map(j=>a*j+b)),axis:[1,2,3,4,5],axis_unit:'nm',signal_unit:'absorbance'}],
  samples:rid.map(i=>({sample_id:i,physical_sample_id:i}))});
 const rm=Object.fromEntries(residue.metrics.map(m=>[m.metric_id,m]));
 for(const id of ['structure.snv_sensitivity','structure.snv_effective_dimension']){
  assert.equal(rm[id].status,'undefined');
  assert.equal(rm[id].reason_code,'SNV_VARIANCE_NOT_NUMERICALLY_RESOLVED');
  assert.ok(rm[id].parameters.snv_rms_band_deviation*10<rm[id].parameters.numerical_resolution_threshold);
 }
});
test('WASM relative contradiction tolerance cannot overflow and aliases are compared',async()=>{
 // Review b4 #2: same cases as the Rust protocol test (one physical sample per case).
 const cases=[[1.7e308,-1.7e308],[4,3],[4,2.9999999999999996],[0,0],[0,-0],[0,1e-300],[-1e-310,1e-310]];
 const tolerances={rel_quarter:{kind:'relative',value:0.25},rel_one_half:{kind:'relative',value:1.5},rel_two:{kind:'relative',value:2},abs_huge:{kind:'absolute',value:1e308}};
 const ids=cases.flatMap((_,i)=>[`c${i}a`,`c${i}b`]);
 const report=runtime.analyze({schema_version:1,
  sources:[{source_id:'x',observation_ids:ids.map(i=>`o-${i}`),sample_ids:ids,x:ids.map((_,k)=>[Math.floor(k/2),1]),axis:[1,2],axis_unit:'nm',signal_unit:'abs'}],
  samples:ids.map((id,k)=>({sample_id:id,physical_sample_id:`case${Math.floor(k/2)}`,instrument:'A'})),
  targets:Object.keys(tolerances).map(t=>({target_id:t,kind:'continuous',values:ids.map((id,k)=>({sample_id:id,value:cases[Math.floor(k/2)][k%2],status:'exact'}))})),
  options:{reference_contradiction_tolerances:tolerances}});
 const flagged=t=>report.metrics.find(m=>m.metric_id==='reference.within_physical_sample_conflicts'&&m.target_id===t).value.listed_pairs.map(p=>p.physical_sample);
 assert.deepEqual(flagged('rel_quarter'),['case0','case2','case5','case6']);
 assert.deepEqual(flagged('rel_one_half'),['case0','case6']);
 assert.deepEqual(flagged('rel_two'),[]);
 assert.deepEqual(flagged('abs_huge'),['case0']);
 // Review b4 #1: an alias of s0 (same physical p0) with reference 20.
 const fixture=JSON.parse(await readFile(new URL('../../../examples/quasi_duplicates.json',import.meta.url),'utf8'));
 fixture.sources[0].observation_ids.push('o-s7');fixture.sources[0].sample_ids.push('s7');fixture.sources[0].x.push([1,1]);
 fixture.samples.push({sample_id:'s7',physical_sample_id:'p0',instrument:'A',campaign:'c1'});
 fixture.targets[0].values.push({sample_id:'s7',value:20,status:'exact'});
 const alias=runtime.analyze(fixture).metrics.find(m=>m.metric_id==='reference.within_physical_sample_conflicts'&&m.target_id==='moisture').value;
 assert.equal(alias.incompatible_sample_pairs,1);
 assert.equal(alias.listed_pairs[0].physical_sample,'p0');
});
