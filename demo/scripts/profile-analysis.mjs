import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.setDefaultTimeout(0);
try {
  await page.goto(process.env.PROFILE_URL ?? 'http://127.0.0.1:4173/nirs4all-preflight/profile.html');
  await page.getByText('Benchmark harness ready', { exact: true }).waitFor();
  const measurements = [];
  for (const dataset of ['clean', 'pitfalls', 'beer', 'anopheles']) {
    console.log(`Profiling ${dataset}`);
    const rows = await page.evaluate((dataset) => window.profileDataset(dataset), dataset);
    measurements.push(...rows);
    console.log(JSON.stringify(rows));
    await writeFile(new URL('../src/data/analysis-timings.json', import.meta.url), JSON.stringify({ measuredAt: new Date().toISOString(), browser: browser.version(), cpu: os.cpus()[0]?.model, method: 'One warm-runtime browser run per configuration. Each family timing includes mandatory integrity, populations, PCA and target checks. Standard reduced-space options; no clustering PCA refit. Timings are examples, not predictions for another device or dataset.', measurements }, null, 2) + '\n');
  }
} finally { await browser.close(); }
