import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createQualificationRuntime } from '../index.js';

const bytes = await readFile(new URL('../native/nirs4all_preflight_wasm_bg.wasm',import.meta.url));
const dagMlBytes = await readFile(new URL('../node_modules/dag-ml-wasm/dag_ml_wasm_bg.wasm',import.meta.url));
const runtime = await createQualificationRuntime({wasmModule:bytes,dagMlWasmModule:dagMlBytes});
const input=JSON.parse(await readFile(new URL('../../../examples/first_run.json',import.meta.url),'utf8'));

test('actual Rust WASM + Methods WASM computes canonical report',()=>{
  assert.equal(runtime.validate(input).valid,true);
  const report=runtime.analyze(input);
  const metrics=Object.fromEntries(report.metrics.map(m=>[m.metric_id,m]));
  assert.equal(report.profile_status,'exploratory');
  assert.equal(metrics['population.development_real_samples'].value,5);
  assert.equal(metrics['structure.effective_dimension'].status,'computed');
  // Methods ABI 2.20 accuracy contract travels through the WASM provider.
  const eigen=metrics['structure.pca_eigenvalues'];
  assert.ok(eigen.parameters.eigenvalue_resolution>0);
  assert.ok(Array.isArray(eigen.parameters.unresolved_components));
  assert.equal(metrics['target.continuous_distribution'].value.count,5);
  assert.equal(metrics['local.global_contrast'].status,'computed');
  assert.ok(runtime.reportHtml(report).includes('<!doctype html>'));
});
// Goldens: NumPy 2.2.6 default_rng(derived seed).permutation(12) counts,
// SciPy 1.15.3 spearmanr and statsmodels 0.15.0 holm / fdr_bh on
// p = [0.026, 0.41, 0.911, 0.001] (instrument, campaign, site, temperature).
test('WASM metadata associations match the native engine goldens',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../examples/metadata_association.json',import.meta.url),'utf8'));
  assert.equal(runtime.validate(fixture).valid,true);
  const report=runtime.analyze(fixture);
  const find=(id,metadata)=>report.metrics.find(m=>m.metric_id===id&&m.parameters.metadata===metadata);
  const expected={instrument:[25,0.078,0.052],campaign:[409,0.82,0.5466666666666666],site:[910,0.911,0.911],temperature:[0,0.004,0.004]};
  for(const [name,[b,holm,bh]] of Object.entries(expected)){
    const t=find('association.metadata_target_test',name);
    assert.equal(t.status,'computed',name);
    assert.equal(t.value.n_at_least_observed,b,name);
    assert.ok(Math.abs(t.value.p_value_holm-holm)<1e-12,name);
    assert.ok(Math.abs(t.value.p_value_bh_exploratory-bh)<1e-12,name);
    assert.equal(t.parameters.permutation_plan.n_permutations_executed,999,name);
  }
  assert.equal(find('association.metadata_target_test','instrument').parameters.permutation_plan.seed,'12673246378241812381');
  assert.equal(find('association.metadata_target_test','temperature').parameters.permutation_plan.seed,'7991542096464906966');
  assert.ok(Math.abs(find('association.metadata_target','instrument').value.effect_size-0.5318805854300557)<1e-12);
  assert.ok(Math.abs(find('association.metadata_target','temperature').value.effect_size-0.9300699300699302)<1e-12);
  assert.equal(find('association.metadata_target','temperature').parameters.metadata_unit,'degC');
  assert.equal(find('association.metadata_target_test','site').parameters.permutation_plan.resolution_basis,'exact_enumeration');
  assert.ok(runtime.capabilities().some(c=>c.capability_id==='metadata_association_tests'&&c.available));
});
// Root seeds above 2^53 travel as decimal strings (bigint or string input);
// derived seeds are independent Python FNV-1a/SplitMix64 references.
test('WASM keeps u64 root seeds exact',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../examples/metadata_association.json',import.meta.url),'utf8'));
  const seedOf=root=>{
    const report=runtime.analyze({...fixture,options:{...fixture.options,seed:root}});
    return report.metrics.find(m=>m.metric_id==='association.metadata_target_test'&&m.parameters.metadata==='instrument').parameters.permutation_plan.seed;
  };
  assert.equal(seedOf(9007199254740993n),'11028598969094618448');
  assert.equal(seedOf('9007199254740993'),'11028598969094618448');
  assert.equal(seedOf(18446744073709551615n),'15693172765536804');
  assert.equal(seedOf('18446744073709551615'),'15693172765536804');
  assert.throws(()=>runtime.analyze({...fixture,options:{...fixture.options,seed:9007199254740993}}),/SEED_NOT_SAFE_INTEGER/);
  assert.throws(()=>runtime.analyze({...fixture,options:{...fixture.options,seed:'18446744073709551616'}}));
});
// Retained-test Y stays opaque through the JSON facade (review P0). Inputs
// are JSON text, so tokens a typed parser rejects (1e400) reach the engine.
test('WASM report is invariant to reserved Y content',async()=>{
  const text=await readFile(new URL('../../../examples/metadata_association.json',import.meta.url),'utf8');
  const fixture=JSON.parse(text);
  const t00=fixture.targets[0].values.find(v=>v.sample_id==='t00');
  t00.value='__RESERVED__'; t00.category='__RESERVED__';
  const template=JSON.stringify(fixture);
  const outputs=['9.9','1e400','-1e400','{"x":1e400}','"do-not-read"','[1,{"n":[true]}]','null','true'].map(token=>{
    const json=template.replaceAll('"__RESERVED__"',token);
    assert.equal(JSON.parse(runtime.validateJson(json)).valid,true,token);
    return runtime.analyzeJson(json);
  });
  assert.ok(outputs.every(o=>o===outputs[0]));
});
// Rule 13: inside D the covariate scaled by 2^k or shifted by 2^200 gives
// the same Spearman rho and count; outside D the pair is unsupported with
// NUMERICAL_DOMAIN_EXCEEDED (the Methods refusal reason crosses the bridge).
test('WASM association follows the supported numerical domain',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../examples/metadata_association.json',import.meta.url),'utf8'));
  const run=map=>{
    const input=structuredClone(fixture);
    for(const row of Object.values(input.metadata.values)) row.temperature=map(Math.round(row.temperature*10));
    const r=runtime.analyze(input);
    const find=id=>r.metrics.find(m=>m.metric_id===id&&m.parameters.metadata==='temperature');
    return [find('association.metadata_target'),find('association.metadata_target_test')];
  };
  const [d0,t0]=run(t=>t);
  for(const map of [t=>t*2**-240,t=>t*2**240,t=>2**200+t*2**150]){
    const [d,t]=run(map);
    assert.ok(Math.abs(d.value.effect_size-d0.value.effect_size)<=1e-12*Math.abs(d0.value.effect_size));
    assert.equal(t.value.n_at_least_observed,t0.value.n_at_least_observed);
  }
  for(const map of [t=>t*2**-300,t=>t*2**1000,t=>1e300+t*2**944,t=>t===172?1e-30:t]){
    for(const m of run(map)){
      assert.equal(m.status,'unsupported');
      assert.equal(m.reason_code,'NUMERICAL_DOMAIN_EXCEEDED');
      assert.equal(m.value,null);
      assert.equal(m.parameters.numerical_domain.supported_domain.max_over_min_nonzero_abs_per_array,'2^32');
    }
  }
});
// A development row, a prediction bridge and a retained-test row linked by
// a physical sample then a reference group form one component (review P0).
test('WASM refuses leakage through a prediction bridge',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../examples/metadata_association.json',import.meta.url),'utf8'));
  const input=structuredClone(fixture);
  input.samples.push({sample_id:'bridge',physical_sample_id:'p00',partition:'prediction'});
  input.targets[0].values.push({sample_id:'bridge',status:'censored',reference_group_id:'R'});
  input.targets[0].values.find(v=>v.sample_id==='t00').reference_group_id='R';
  const result=runtime.validate(input);
  assert.equal(result.valid,false);
  assert.ok(result.issues.some(i=>i.code==='REFERENCE_LEAKAGE'));
  assert.equal(runtime.analyze(input).status,'failed');
});
// Same NumPy 2.2.6 goldens as the native engine test on examples/confounding.json.
test('WASM confounding matches the native engine goldens',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../examples/confounding.json',import.meta.url),'utf8'));
  const report=runtime.analyze(fixture);
  const find=(id,factor)=>report.metrics.find(m=>m.metric_id===id&&(factor===undefined||m.parameters.factor===factor));
  const partition=find('confounding.variance_partition').value;
  assert.ok(Math.abs(partition.factors[1].r2_unique_given_other_factors-0.07913593861176811)<1e-10);
  assert.equal(partition.shares_are_not_additive,true);
  const conditional=find('confounding.permanova_conditional_test','campaign');
  assert.equal(conditional.value.n_at_least_observed,121);
  assert.equal(conditional.parameters.permutation_plan.restrictions,'within_blocks');
  assert.equal(conditional.parameters.permutation_plan.seed,'744331944044608949');
  assert.equal(find('confounding.permanova_marginal_test','campaign').value.n_at_least_observed,35);
  assert.equal(find('confounding.permdisp_test','campaign').value.n_at_least_observed,456);
  const fl=find('confounding.permanova_freedman_lane_test','campaign');
  assert.equal(fl.value.n_at_least_observed,101);
  assert.ok(fl.parameters.permutation_plan.reduced_model.startsWith('intercept + main effects of instrument'));
  assert.equal(find('confounding.design').value.factors[0].df_identifiable_given_other_factors,1);
  assert.equal(find('confounding.design').value.factors[0].aliased_with_other_factor_cells,false);
  assert.equal(find('confounding.design').value.factors[0].identifiable_under_additive_model,true);
  assert.equal(find('confounding.variance_partition').parameters.numerical_domain.supported_domain.max_over_min_nonzero_abs_per_array,'2^32');
  assert.equal(find('confounding.variance_partition').value.ss_binary_exponent,0);
  assert.equal(find('confounding.dispersion','campaign').value.distance_binary_exponent,0);
  // Every published F carries its numerical resolution; these are resolved.
  assert.equal(fl.value.statistic_resolution.numerically_unresolved,false);
  assert.ok(fl.value.statistic_resolution.residual_ss_resolution_ratio<1e-6);
  assert.equal(partition.factors[1].pseudo_f_marginal_resolution.numerically_unresolved,false);
  assert.equal(find('confounding.dispersion','campaign').value.anova_f_resolution.numerically_unresolved,false);
  assert.ok(runtime.capabilities().some(c=>c.capability_id==='confounding'&&c.available&&!c.qualified));
});
// Rule 13 (native test native_engine_partition_is_scale_invariant_inside_the_domain):
// spectra scaled by 2^k inside D give the same R2 and counts; at 2^-258 the
// unit coordinates fall below 2^-256 and the Methods refusal crosses the
// bridge as unsupported NUMERICAL_DOMAIN_EXCEEDED.
test('WASM confounding follows the supported numerical domain',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../examples/confounding.json',import.meta.url),'utf8'));
  const run=k=>{
    const input=structuredClone(fixture);
    input.sources[0].x=input.sources[0].x.map(row=>row.map(v=>v===null?v:v*2**k));
    const report=runtime.analyze(input);
    const find=(id,factor)=>report.metrics.find(m=>m.metric_id===id&&(factor===undefined||m.parameters.factor===factor));
    return {partition:find('confounding.variance_partition'),test:find('confounding.permanova_marginal_test','campaign')};
  };
  const base=run(0);
  // Inside the canonical PCA domain [2^-128, 2^128] (Methods ABI 2.20).
  for(const k of [-120,120]){
    const r=run(k);
    assert.equal(r.partition.status,'computed');
    r.partition.value.factors.forEach((f,i)=>assert.ok(Math.abs(f.r2_marginal-base.partition.value.factors[i].r2_marginal)<=1e-8));
    assert.equal(r.test.value.n_at_least_observed,base.test.value.n_at_least_observed);
  }
  for(const k of [-258,-262]){
    const {partition}=run(k);
    assert.equal(partition.status,'unsupported');
    assert.equal(partition.reason_code,'NUMERICAL_DOMAIN_EXCEEDED');
    assert.equal(partition.value,null);
  }
});
// A Methods PCA domain refusal keeps its kind and reason across hosts (the
// native test native_pca_domain_refusal_propagates_to_confounding).
test('WASM reports the Methods PCA domain refusal with the native reason',()=>{
  const huge=structuredClone(input);
  huge.sources[0].x=huge.sources[0].x.map((row,i)=>row.map((_,j)=>(i+j)%2?-1.7e308:1.7e308));
  const pca=runtime.analyze(huge).metrics.find(m=>m.metric_id==='structure.pca');
  assert.equal(pca.status,'unsupported');
  assert.equal(pca.reason_code,'NUMERICAL_DOMAIN_EXCEEDED');
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
 const probe=report.capabilities.find(c=>c.capability_id==='validation_probe');
 assert.equal(probe.available,true);
 assert.equal(probe.qualified,false);
 assert.equal(metrics['clustering.gaussian_null_model'].status,'computed');
 assert.equal(metrics['clustering.cluster_appearance_frequency'].status,'computed');
 assert.ok(report.findings.some(f=>f.rule_id.startsWith('structure.clustering.')&&f.confidence==='unknown'));
});
// Review 2026-10-13 P0: CPU and WASM partitions diverged (7 vs 8 groups) on
// tie-heavy data from 4.4e-16 PCA differences. The score grid makes both hosts
// match the independent NumPy/SciPy/scikit-learn golden that the native test
// also checks (crates/nirs4all-preflight/tests/clustering_golden.rs).
test('WASM clustering matches the full-chain Python golden',async()=>{
 const golden=JSON.parse(await readFile(new URL('../../../crates/nirs4all-preflight/tests/fixtures/clustering_v3_golden.json',import.meta.url),'utf8'));
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
  const nullModel=m['clustering.gaussian_null_model'].value;
  nullModel.per_replicate.forEach((g,i)=>{
   const w=e.null.per_replicate[i];
   assert.equal(g.cluster_count,w.cluster_count,`${c.name} null ${i}`);
   assert.ok(near(g.median_ari,w.median_ari),`${c.name} null ari ${i}`);
   assert.ok(near(g.coverage_weighted_stability,w.coverage_weighted_stability),`${c.name} null T ${i}`);
  });
  assert.ok(near(nullModel.observed.coverage_weighted_stability,e.null.observed_statistic),c.name);
  assert.ok(near(nullModel.fitted_null_tail.tail_fraction,e.null.tail_fraction),c.name);
  assert.equal(nullModel.fitted_null_tail.decisional,e.null.decisional,c.name);
  assessments.push(m['clustering.partition_assessment'].value.assessment);
 }
 assert.deepEqual(assessments,['uncertain_partition','uncertain_partition','stable_candidate_versus_fitted_gaussian','compatible_with_fitted_gaussian','uncertain_partition','no_density_separated_groups','stable_candidate_versus_fitted_gaussian']);
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
// Goldens: NumPy 2.2.6 / SciPy 1.15.3 (cdist energy, numpy.linalg.svd PCA,
// numpy.quantile out-of-fold limits, default_rng(derived seed) counts).
test('WASM domain shift matches the native engine goldens',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../examples/domain_shift.json',import.meta.url),'utf8'));
  const report=runtime.analyze(fixture);
  const find=(id,factor,level)=>report.metrics.find(m=>m.metric_id===id&&m.parameters.factor===factor&&(level===undefined||m.parameters.target_domain===level));
  const close=(a,b)=>assert.ok(Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b)),`${a} != ${b}`);
  const instrument=find('domain_shift.energy_test','instrument');
  assert.equal(instrument.parameters.permutation_plan.seed,'3852551409661268358');
  assert.equal(instrument.value.n_at_least_observed,1);
  close(instrument.value.p_value_holm,0.004);
  close(instrument.value.statistic,2.9563946134953585);
  assert.equal(find('domain_shift.energy_test','campaign').value.n_at_least_observed,914);
  const coverage=find('domain_shift.coverage','instrument','A');
  close(coverage.value.t2_limit,23.820918374509468);
  close(coverage.value.q_limit,0.0026974145909210608);
  assert.equal(coverage.value.n_target_beyond_either_limit,8);
  close(find('domain_shift.distribution_distance','campaign','c1').value.energy_e,0.06168426505535718);
  const audit=find('domain_shift.energy_test','partition');
  assert.equal(audit.parameters.family,'external_domain_audit');
  assert.equal(find('domain_shift.target_change','partition','retained_test').reason_code,'RETAINED_TEST_Y_NEVER_READ');
  assert.ok(report.findings.some(f=>f.rule_id==='domain_shift.detected.v1'&&f.action.includes('held out')));
  assert.ok(runtime.capabilities().some(c=>c.capability_id==='domain_shift'&&c.available));
});

test('WASM domain shift: residual-free reference, effective k and explicit refusals',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../examples/domain_shift.json',import.meta.url),'utf8'));
  const a=[-5,-4,-3,-2,-1,0,1,2,3,4,5].map(i=>[i,0]);
  const rows=[...a,[0,100],[1,100],[2,0]];
  const ids=rows.map((_,i)=>`s${String(i).padStart(2,'0')}`);
  const input={...fixture,targets:[],samples:ids.map((id,i)=>({sample_id:id,physical_sample_id:`p${i}`,partition:'development',instrument:i<11?'A':'B',campaign:'c1'})),
    sources:[{...fixture.sources[0],observation_ids:ids.map(i=>`o_${i}`),sample_ids:ids,x:rows,axis:[1000,1010]}],
    options:{...fixture.options,domain_shift:{}}};
  const report=runtime.analyze(input);
  const coverage=report.metrics.find(m=>m.metric_id==='domain_shift.coverage'&&m.parameters.target_domain==='B');
  assert.equal(coverage.status,'computed');
  assert.equal(coverage.parameters.n_components_effective,1);
  assert.equal(coverage.value.n_target_beyond_q_limit,2);
  for(const m of report.metrics.filter(m=>m.metric_id.startsWith('domain_shift.')))
    assert.equal(m.value!==null,m.status==='computed',m.metric_id);
});

test('WASM domain shift refuses inputs outside the numerical domain with the same reason',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../examples/domain_shift.json',import.meta.url),'utf8'));
  const scaled={...fixture,sources:fixture.sources.map(s=>({...s,x:s.x.map(r=>r.map(v=>v*2**300))}))};
  const report=runtime.analyze(scaled);
  const coverage=report.metrics.find(m=>m.metric_id==='domain_shift.coverage'&&m.parameters.factor==='instrument'&&m.parameters.target_domain==='A');
  assert.equal(coverage.status,'unsupported');
  assert.equal(coverage.reason_code,'NUMERICAL_DOMAIN_EXCEEDED');
  assert.equal(coverage.value,null);
  // Inside the domain the Q of a tiny real residual is counted.
  const a=[-5,-4,-3,-2,-1,0,1,2,3,4,5].map(i=>[i,0]);
  const rows=[...a,[1,2**-18],[3,0]];
  const ids=rows.map((_,i)=>`s${String(i).padStart(2,'0')}`);
  const input={...fixture,targets:[],samples:ids.map((id,i)=>({sample_id:id,physical_sample_id:`p${i}`,partition:'development',instrument:i<11?'A':'B',campaign:'c1'})),
    sources:[{...fixture.sources[0],observation_ids:ids.map(i=>`o_${i}`),sample_ids:ids,x:rows,axis:[1000,1010]}],
    options:{...fixture.options,domain_shift:{}}};
  const b=runtime.analyze(input).metrics.find(m=>m.metric_id==='domain_shift.coverage'&&m.parameters.target_domain==='B');
  assert.equal(b.value.n_target_beyond_q_limit,1);
  assert.equal(b.value.n_target_near_q_limit,1);
});
// Same input and values as the native engine (tests/repeatability.rs design()).
test('WASM repeatability uncertainty matches the native engine',async()=>{
 const fixture=JSON.parse(await readFile(new URL('../../../examples/repeatability_uncertainty.json',import.meta.url),'utf8'));
 const report=runtime.analyze(fixture);
 const find=(id,instrument)=>report.metrics.find(m=>m.metric_id===id&&m.parameters.instrument===instrument);
 const near=(a,b)=>assert.ok(Math.abs(a-b)<=1e-12*Math.max(1,Math.abs(b)),`${a} != ${b}`);
 const reml=find('measurement.icc_1_reml','a');
 assert.deepEqual(reml.parameters.band_status,[0,2]);
 near(reml.value[0],0.9995334364361543);
 assert.equal(reml.value[1],0);
 const boot=find('measurement.icc_1_reml_ci_cluster_bootstrap','a');
 assert.equal(boot.parameters.bootstrap_plan.seed,'15581561710765580329');
 assert.deepEqual(boot.parameters.bootstrap_plan.n_valid_replicates_per_band,[999,999]);
 near(boot.value.lower[0],0.9992022453402624);
 near(boot.value.upper[0],0.9996809447785994);
 // Only 18 of the 24 units carry within-group df: below the 20-unit minimum.
 assert.equal(find('measurement.repeatability_sd_ci_cluster_bootstrap','a').reason_code,'FEWER_THAN_20_UNITS_WITH_WITHIN_DF');
 assert.deepEqual(boot.parameters.bootstrap_plan.n_units_with_valid_value_per_band,[24,24]);
 // Balanced context b: REML equals the ANOVA ICC(1,1); SciPy 1.18.1 exact F bounds.
 near(find('measurement.icc_1_reml','b').value[0],0.9547872340425532);
 const exact=find('measurement.icc_1_1_ci_exact_f','b').value;
 assert.ok(Math.abs(exact.lower[0]-0.7838941809128407)<1e-10);
 assert.ok(Math.abs(exact.upper[0]-0.9968006295172774)<1e-10);
 assert.equal(find('measurement.repeat_counts','a').value.n_repeated_groups,18);
 assert.ok(runtime.capabilities().some(c=>c.capability_id==='repeatability_uncertainty'&&c.available&&!c.qualified));
});
// Rule 13 domain through the bridge: values up to 2.32 x 2^254 are inside
// (ICC unchanged), 2^255 exceeds 2^256 and the native refusal reaches the
// report as unsupported NUMERICAL_DOMAIN_EXCEEDED with the domain published.
test('WASM keeps the repeatability domain boundary explicit',async()=>{
 const base=JSON.parse(await readFile(new URL('../../../examples/repeatability_uncertainty.json',import.meta.url),'utf8'));
 const scaled=k=>{const f=structuredClone(base);for(const row of f.sources[0].x) for(let c=0;c<row.length;c++) row[c]*=2**k;return runtime.analyze(f);};
 const find=(r,id)=>r.metrics.find(m=>m.metric_id===id&&m.parameters.instrument==='a');
 const icc0=find(scaled(0),'measurement.icc_1_reml').value[0];
 const inside=find(scaled(254),'measurement.icc_1_reml');
 assert.equal(inside.status,'computed');
 assert.ok(Math.abs(inside.value[0]-icc0)<=1e-12);
 for(const id of ['measurement.icc_1_reml','measurement.repeatability_sd_ci_chi_square','measurement.icc_1_reml_ci_cluster_bootstrap']){
  const m=find(scaled(255),id);
  assert.equal(m.status,'unsupported');
  assert.equal(m.reason_code,'NUMERICAL_DOMAIN_EXCEEDED');
  assert.match(m.parameters.numerical_domain,/2\^-256/);
 }
});

// Browser probe: dag-ml-wasm nested selection with the Methods JS controller,
// against the CPU scikit-learn golden (folds, selections, OOF within 1e-7).
test('WASM validation probe matches the CPU scikit-learn golden',async()=>{
  const golden=JSON.parse(await readFile(new URL('../../../crates/nirs4all-preflight/tests/fixtures/probe_sklearn_v1.json',import.meta.url),'utf8'));
  const close=(a,e,label)=>assert.ok(Math.abs(a-e)<=1e-7*(1+Math.abs(e)),`${label}: ${a} vs ${e}`);
  for(const [name,data] of Object.entries(golden.cases)){
    const report=runtime.analyze(data.input);
    for(const estimator of ['pls','pcr']){
      const label=`${name}/${estimator}`, expected=data[estimator];
      const get=id=>report.metrics.find(m=>m.metric_id===id&&m.parameters.estimator===estimator);
      assert.equal(get('probe.plan').status,'computed',`${label} ${get('probe.plan').reason_code} ${JSON.stringify(get('probe.plan').parameters.provider_error_detail??'')}`);
      assert.deepEqual(get('probe.plan').value.component_grid,data.component_grid,label);
      const folds=get('probe.folds').value;
      folds.forEach((f,i)=>{
        const e=expected.folds[i];
        assert.deepEqual(f.eval_sample_ids,e.validation_sample_ids,label);
        assert.deepEqual(f.inner_folds.map(x=>x.eval_sample_ids),e.inner_validation_sample_ids,label);
        assert.equal(f.selected_components,e.selected_components,label);
      });
      const oof=get('probe.oof_predictions').value;
      assert.deepEqual(oof.sample_ids,data.sample_ids,label);
      oof.prediction.forEach((v,i)=>close(v,expected.prediction[i],`${label} oof ${i}`));
      close(get('probe.rmse').value,expected.rmse,`${label} rmse`);
      close(get('probe.skill_vs_train_mean').value,expected.skill_vs_train_mean,`${label} skill`);
      assert.match(get('probe.rmse').parameters.validation_backend,/dag-ml-wasm/);
    }
  }
});

test('WASM probe refuses data outside the declared numerical domain before any fit',async()=>{
  const golden=JSON.parse(await readFile(new URL('../../../crates/nirs4all-preflight/tests/fixtures/probe_sklearn_v1.json',import.meta.url),'utf8'));
  const input=structuredClone(golden.cases.base.input);
  input.sources[0].x=input.sources[0].x.map(row=>row.map(v=>v*2**300));
  const report=runtime.analyze(input);
  const rmse=report.metrics.find(m=>m.metric_id==='probe.rmse');
  assert.equal(rmse.status,'unsupported');
  assert.equal(rmse.reason_code,'NUMERICAL_DOMAIN_EXCEEDED');
  assert.match(rmse.parameters.numerical_domain,/2\^-256, 2\^256/);
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
  assert.ok(rm[id].parameters.snv_rms_band_deviation*2<rm[id].parameters.numerical_resolution_threshold);
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
test('WASM SNV rank bound rejects rounding residue on 100,000 offset bands',()=>{
 // Review b1fix #3: identical analytic SNV rows (99,999 ones then a two).
 const p=100000, shape=Array.from({length:p},(_,j)=>j+1<p?1:2);
 const rows=[[1,0],[1.1,100],[1.2,10],[2.1,-3]], rid=['a','b','c','d'];
 const report=runtime.analyze({schema_version:1,
  sources:[{source_id:'nir',observation_ids:rid.map(i=>`o-${i}`),sample_ids:rid,x:rows.map(([a,b])=>shape.map(v=>a*v+b)),axis:shape.map((_,j)=>j),axis_unit:'nm',signal_unit:'absorbance'}],
  samples:rid.map(i=>({sample_id:i,physical_sample_id:i}))});
 const m=report.metrics.find(x=>x.metric_id==='structure.snv_sensitivity');
 assert.equal(m.reason_code,'SNV_VARIANCE_NOT_NUMERICALLY_RESOLVED');
 assert.ok(m.parameters.snv_rms_band_deviation<m.parameters.numerical_resolution_threshold);
 assert.ok(m.parameters.max_snv_entry_error_bound<1e-9);
});
test('WASM exact reference comparisons and unbalanced SNV repeats',()=>{
 // Review b14fix #5: 1e16 vs 9999999999999998 differ by exactly 2e-16 relative.
 for(const [value,conflict] of [[2.1e-16,0],[1.9e-16,1]]){
  const report=runtime.analyze({schema_version:1,
   sources:[{source_id:'x',observation_ids:['oa','ob'],sample_ids:['a','b'],x:[[0,1],[1,0]],axis:[1,2],axis_unit:'nm',signal_unit:'abs'}],
   samples:[{sample_id:'a',physical_sample_id:'p'},{sample_id:'b',physical_sample_id:'p'}],
   targets:[{target_id:'y',kind:'continuous',values:[{sample_id:'a',value:1e16,status:'exact'},{sample_id:'b',value:9999999999999998,status:'exact'}]}],
   options:{reference_contradiction_tolerances:{y:{kind:'relative',value}}}});
  assert.equal(report.metrics.find(m=>m.metric_id==='reference.within_physical_sample_conflicts').value.incompatible_sample_pairs,conflict);
 }
 // Review b14fix #3: a [1,2,4], a = 1, 2, 4, 8, with 1, 10000, 1, 1 identical rescans.
 const obs=[], sid=[], x=[];
 [1,10000,1,1].forEach((n,g)=>{for(let i=0;i<n;i++){obs.push(`o${g}-${i}`);sid.push(`s${g}`);x.push([1,2,4].map(v=>v*2**g));}});
 const report=runtime.analyze({schema_version:1,
  sources:[{source_id:'x',observation_ids:obs,sample_ids:sid,x,axis:[1,2,3],axis_unit:'nm',signal_unit:'abs',repetition_types:x.map(()=>'rescan')}],
  samples:[0,1,2,3].map(g=>({sample_id:`s${g}`,physical_sample_id:`s${g}`}))});
 const m=report.metrics.find(m=>m.metric_id==='structure.snv_sensitivity');
 assert.equal(m.status,'undefined');
 assert.ok(['ZERO_SNV_TOTAL_VARIANCE','SNV_VARIANCE_NOT_NUMERICALLY_RESOLVED'].includes(m.reason_code));
 assert.ok(m.parameters.snv_rms_band_deviation<=m.parameters.numerical_resolution_threshold);
});
test('WASM noise proxy ignores a value outside every evaluable window',()=>{
 // Review b14fix2 #2: [H,0,0,0,0,1,0,0,0,0,0], index 1 masked, window 3 / order 1.
 const run=(H,mask)=>Object.fromEntries(runtime.analyze({schema_version:1,
   sources:[{source_id:'x',observation_ids:['o'],sample_ids:['s'],x:[[H,null,0,0,0,1,0,0,0,0,0]],valid_mask:[mask],axis:Array.from({length:11},(_,j)=>1000+j),axis_unit:'nm',signal_unit:'abs'}],
   samples:[{sample_id:'s',physical_sample_id:'s'}],
   options:{noise_proxy:{window_bands:3,polyorder:1},snv_sensitivity:false}}).metrics.map(x=>[x.metric_id,x]));
 const valid0=[true,false,true,true,true,true,true,true,true,true,true];
 const masked0=[false,false,true,true,true,true,true,true,true,true,true];
 for(const [H,mask] of [[0,valid0],[1e9,valid0],[2**32,valid0],[1e300,masked0],[Number.MAX_VALUE,masked0]]){
  const m=run(H,mask);
  assert.ok(Math.abs(m['measurement.noise_proxy'].value[5]-Math.sqrt(2/3))<=1e-15*Math.sqrt(2/3),`H ${H}`);
  assert.ok(Math.abs(m['measurement.noise_proxy_pooled'].value-1/Math.sqrt(7))<=1e-15/Math.sqrt(7),`H ${H}`);
 }
 // A valid 1e300 next to 1 leaves the supported domain: explicit refusal.
 assert.equal(run(1e300,valid0)['measurement.noise_proxy'].reason_code,'NUMERICAL_DOMAIN_EXCEEDED');
});
test('WASM refuses inputs outside the supported numerical domain explicitly',()=>{
 // Rules 13/15: nonzero |x| in [2^-256, 2^256], per-row spread <= 2^32; one row at 2^300.
 const analyze=(big)=>runtime.analyze({schema_version:1,
  sources:[{source_id:'x',observation_ids:['a','b','c','d'],sample_ids:['a','b','c','d'],
   x:[[1,2,3,4,5],[2,1,3,5,4],[1,3,2,big,5],[5,4,3,2,1]],axis:[1,2,3,4,5],axis_unit:'nm',signal_unit:'abs'}],
  samples:['a','b','c','d'].map(id=>({sample_id:id,physical_sample_id:id})),
  options:{noise_proxy:{window_bands:3,polyorder:1},quasi_duplicates:{tolerance:0.5,context:'source'}}});
 const outside=Object.fromEntries(analyze(2**300).metrics.map(m=>[m.metric_id,m]));
 for(const id of ['measurement.noise_proxy','integrity.quasi_duplicate_pairs']){
  assert.equal(outside[id].status,'unsupported',id);
  assert.equal(outside[id].reason_code,'NUMERICAL_DOMAIN_EXCEEDED',id);
  assert.ok(outside[id].parameters.numerical_domain.startsWith('every nonzero |x| in [2^-256, 2^256]'));
 }
 // Spread exactly 2^32 within the row (2^32 next to 1) stays inside; 2^33 is refused.
 const inside=Object.fromEntries(analyze(2**32).metrics.map(m=>[m.metric_id,m]));
 for(const id of ['measurement.noise_proxy','integrity.quasi_duplicate_pairs']) assert.equal(inside[id].status,'computed',id);
 const beyond=Object.fromEntries(analyze(2**33).metrics.map(m=>[m.metric_id,m]));
 for(const id of ['measurement.noise_proxy','integrity.quasi_duplicate_pairs']) assert.equal(beyond[id].reason_code,'NUMERICAL_DOMAIN_EXCEEDED',id);
});
test('WASM summary and contrast publish their own numerical domains',()=>{
 // Review b14fix5: Y = [1, 2, 2^33, 3, 4, 5] is summarized (magnitude bound only)
 // but the continuous contrast refuses it (global target spread above 2^32).
 const ids=['a','b','c','d','e','f'];
 const x=[[1,4,2,7],[2,1,5,3],[3,6,1,4],[5,2,4,1],[4,5,3,6],[6,3,6,2]];
 const run=(y3)=>Object.fromEntries(runtime.analyze({schema_version:1,
  sources:[{source_id:'x',observation_ids:ids,sample_ids:ids,x,axis:[1,2,3,4],axis_unit:'nm',signal_unit:'abs'}],
  samples:ids.map(id=>({sample_id:id,physical_sample_id:id})),
  targets:[{target_id:'y',kind:'continuous',values:ids.map((id,i)=>({sample_id:id,value:[1,2,y3,3,4,5][i],status:'exact'}))}],
  options:{independence_unit:'sample'}}).metrics.map(m=>[m.metric_id,m]));
 const wide=run(2**33);
 assert.equal(wide['target.continuous_distribution'].status,'computed');
 assert.ok(wide['target.continuous_distribution'].parameters.numerical_domain.startsWith('every nonzero |value| in [2^-256, 2^256]; no spread bound'));
 assert.equal(wide['local.global_contrast'].status,'unsupported');
 assert.equal(wide['local.global_contrast'].reason_code,'NUMERICAL_DOMAIN_EXCEEDED');
 assert.ok(wide['local.global_contrast'].parameters.numerical_domain.includes('over the whole target vector'));
 const plain=run(6);
 assert.equal(plain['local.global_contrast'].status,'computed');
 assert.ok(plain['local.global_contrast'].parameters.numerical_domain.startsWith('neighbours: magnitude bound only'));
 const huge=run(2**300)['target.continuous_distribution'];
 assert.equal(huge.reason_code,'NUMERICAL_DOMAIN_EXCEEDED');
 assert.equal(run(1e-20)['target.continuous_distribution'].status,'computed');
});
test('WASM local contrast is computed on rank-deficient spectra',()=>{
 // Rank 2: PCA scores carry rounding-level components next to large ones;
 // the neighbours have no spread bound, so the contrast is computed.
 const ids=['a','b','c','d','e','f'];
 const report=runtime.analyze({schema_version:1,
  sources:[{source_id:'x',observation_ids:ids,sample_ids:ids,x:ids.map((_,i)=>[i,i*i+1,2*i+3,7-i]),axis:[1,2,3,4],axis_unit:'nm',signal_unit:'abs'}],
  samples:ids.map(id=>({sample_id:id,physical_sample_id:id})),
  targets:[{target_id:'y',kind:'continuous',values:ids.map((id,i)=>({sample_id:id,value:[1,2,6,3,4,5][i],status:'exact'}))}],
  options:{independence_unit:'sample'}});
 const m=report.metrics.find(x=>x.metric_id==='local.global_contrast');
 assert.equal(m.status,'computed');
});
