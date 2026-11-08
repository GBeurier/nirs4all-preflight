import type { EngineReport } from 'nirs4all-ui/qualification';
import { loadRuntime } from '../src/runtime';
import { syntheticInput } from '../src/synthetic';
import { defaultConfig, buildEngineInput, ANALYSIS_FAMILIES } from '../src/input';
import { loadDatasetRuntime } from '../src/dataset-io';
import { DEMO_DATASETS, readDemoFiles, assembleDemoDataset } from '../src/demo-datasets';

// A separate build entry, enabled only by PREFLIGHT_PROFILE=1; never part of the product UI.
const profileDataset = async (dataset: string) => {
  let input;
  if (dataset === 'clean' || dataset === 'pitfalls') input = syntheticInput(dataset);
  else {
    const { io, formats } = await loadDatasetRuntime();
    const selected = DEMO_DATASETS.find((d) => d.id === dataset)!;
    input = assembleDemoDataset(selected, await readDemoFiles(selected.id), io, formats);
  }
  const runtime = await loadRuntime();
  const config = defaultConfig(input);
  const base = Object.fromEntries(ANALYSIS_FAMILIES.map((f) => [f, false])) as typeof config.families;
  // Exclude first-call initialization from the measured runs.
  runtime.analyze(buildEngineInput(input, { ...config, families: base }));
  const rows = [];
  for (const family of ['base', ...ANALYSIS_FAMILIES]) {
    const payload = buildEngineInput(input, { ...config, families: { ...base, ...(family === 'base' ? {} : { [family]: true }) } });
    const started = performance.now();
    const report = runtime.analyze(payload) as EngineReport;
    if (report.validation?.valid === false) throw new Error(JSON.stringify(report.validation));
    const milliseconds = Math.round(performance.now() - started);
    const prefixes: Record<string, string[]> = { spectral_quality: ['intrinsic.'], sensitivity: ['structure.snv_', 'structure.detrend_', 'structure.balanced_repeat'], repeatability: ['measurement.'], clustering: ['clustering.'], association: ['association.'], confounding: ['confounding.'], domain_shift: ['domain_shift.'], probe: ['probe.'] };
    const metrics = family === 'base' ? report.metrics : report.metrics.filter((m) => prefixes[family]?.some((prefix) => m.metric_id.startsWith(prefix)));
    rows.push({ dataset, family, milliseconds, computedMetrics: metrics.filter((m) => m.status === 'computed').length, unavailableMetrics: metrics.filter((m) => m.status !== 'computed').length, observations: input.sources.reduce((n, s) => n + s.x.length, 0), bands: input.sources[0]!.axis.length });
  }
  return rows;
};
Object.assign(window, { profileDataset });
document.getElementById('profile-status')!.textContent = 'Benchmark harness ready';
