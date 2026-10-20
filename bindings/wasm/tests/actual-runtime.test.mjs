import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createQualificationRuntime } from '../index.js';
import * as methods from '@nirs4all/methods';

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
// Robustness rule: the covariate scaled by 2^k (subnormal to 2^1000) or
// shifted by 1e300 gives the same Spearman rho, count and plan.
test('WASM association is invariant over the double range',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../examples/metadata_association.json',import.meta.url),'utf8'));
  const run=map=>{
    const input=structuredClone(fixture);
    for(const row of Object.values(input.metadata.values)) row.temperature=map(Math.round(row.temperature*10));
    const r=runtime.analyze(input);
    const find=id=>r.metrics.find(m=>m.metric_id===id&&m.parameters.metadata==='temperature');
    return [find('association.metadata_target').value.effect_size,find('association.metadata_target_test').value.n_at_least_observed];
  };
  const reference=run(t=>t);
  for(const map of [t=>t*2**-1060,t=>t*2**-1022,t=>t*2**1000,t=>1e300+t*2**944]){
    const [rho,b]=run(map);
    assert.ok(Math.abs(rho-reference[0])<=1e-12*Math.abs(reference[0]));
    assert.equal(b,reference[1]);
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
  assert.match(find('confounding.variance_partition').parameters.numerical_domain,/METHODS_NUMERICAL_FAILURE/);
  assert.ok(runtime.capabilities().some(c=>c.capability_id==='confounding'&&c.available&&!c.qualified));
});
// A Methods numerical failure keeps its kind and reason across hosts (the
// native test native_numerical_failure_is_reported_as_error).
test('WASM reports Methods numerical failures as errors with the native reason',()=>{
  const huge=structuredClone(input);
  huge.sources[0].x=huge.sources[0].x.map((row,i)=>row.map((_,j)=>(i+j)%2?-1.7e308:1.7e308));
  const pca=runtime.analyze(huge).metrics.find(m=>m.metric_id==='structure.pca');
  assert.equal(pca.status,'error');
  assert.equal(pca.reason_code,'METHODS_NUMERICAL_FAILURE');
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

// Browser probe: dag-ml-wasm nested selection with the Methods JS controller,
// against the CPU scikit-learn golden (folds, selections, OOF within 1e-7).
test('WASM validation probe matches the CPU scikit-learn golden',async()=>{
  const golden=JSON.parse(await readFile(new URL('../../../crates/nirs4all-preflight/tests/fixtures/probe_sklearn_v1.json',import.meta.url),'utf8'));
  // Strictly relative tolerance (no reference value is zero here).
  const close=(a,e,label)=>{assert.notEqual(e,0,label);assert.ok(Math.abs(a-e)<=1e-7*Math.abs(e),`${label}: ${a} vs ${e}`);};
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
      close(get('probe.mae').value,expected.mae,`${label} mae`);
      close(get('probe.r2_oof').value,expected.r2_oof,`${label} r2`);
      close(get('probe.skill_vs_train_mean').value,expected.skill_vs_train_mean,`${label} skill`);
      close(get('probe.train_mean_rmse').value,expected.train_mean_rmse,`${label} baseline rmse`);
      oof.train_mean_prediction.forEach((v,i)=>close(v,expected.train_mean_prediction[i],`${label} baseline ${i}`));
      const domains=get('probe.domain_scores').value;
      assert.equal(domains.length,expected.domains.length,label);
      domains.forEach((d,i)=>{
        const e=expected.domains[i];
        assert.equal(d.instrument,e.instrument,label);
        assert.equal(d.campaign,e.campaign,label);
        assert.equal(d.n_samples,e.n_samples,label);
        close(d.rmse,e.rmse,`${label} domain rmse`);
        close(d.train_mean_rmse,e.train_mean_rmse,`${label} domain baseline`);
      });
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


// Analytic case (rational oracle): y_true = (2^-255, 2^-254), y_pred = (2^256, 2^256)
// gives SST = 2^-511 and SSE/SST = 2^1024 (1 - ~2^-510): R² = -0.5 * 2^1025 is
// published scaled by the Methods WASM kernel the probe consumes, never -Infinity,
// and stays distinct from the undefined R² of a constant target.
test('WASM Methods regression scores publish an out-of-range R² scaled',()=>{
  const huge=methods.statsRegressionScores(new Float64Array([2**-255,2**-254]),new Float64Array([2**256,2**256]));
  assert.equal(huge.rmse,2**256);
  assert.equal(huge.r2,-0.5);
  assert.equal(huge.r2Exponent,1025);
  const constant=methods.statsRegressionScores(new Float64Array([2,2]),new Float64Array([1,3]));
  assert.ok(Number.isNaN(constant.r2));
  assert.equal(constant.r2Exponent,0);
});
