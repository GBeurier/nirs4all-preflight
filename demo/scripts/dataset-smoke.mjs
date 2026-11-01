import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ locale: 'fr-FR' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const url = process.env.SMOKE_URL || 'http://127.0.0.1:4173/nirs4all-preflight/';
try {
  for (let attempt = 0; ; attempt++) {
    try { const response = await fetch(url); if (response.ok) break; } catch {}
    if (attempt >= 50) throw new Error(`Preview did not start: ${url}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await page.goto(url);
  const rows = Array.from({ length: 12 }, (_, i) => `s${i};${.1 + i * .01};${.2 + i * .02};${.3 + i * .01};${10 + i};A`);
  // Dropping files starts the analysis: IO infers the dataset, no configuration step.
  await page.locator('input[type=file]').first().setInputFiles({ name: 'combined.csv', mimeType: 'text/csv', buffer: Buffer.from(['sample_id;1000;1100;1200;protein;instrument', ...rows].join('\n')) });
  await page.locator('.ws-title').waitFor({ timeout: 30000 });
  await page.getByText('Analyse terminée', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.ws-title').innerText(), 'combined.csv');
  assert.match(await page.locator('.ws-files').innerText(), /combined\.csv → tableau complet/);
  await page.getByRole('button', { name: 'Nouveau jeu', exact: true }).click();
  const reuse = page.locator('.recent-item', { hasText: 'combined.csv' }).getByRole('button', { name: 'Analyser', exact: true });
  await reuse.waitFor();
  await page.reload();
  await reuse.click();
  await page.getByText('Analyse terminée', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Nouveau jeu', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile overflow');
  await page.screenshot({ path: '/tmp/preflight-dataset-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Supprimer combined.csv', exact: true }).click();
  await page.locator('.recent-item', { hasText: 'combined.csv' }).waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.demo-card', { hasText: 'Beer' }).click();
  await page.getByText('Analyse terminée', { exact: true }).waitFor({ timeout: 90000 });
  assert.equal(await page.locator('.ws-title').innerText(), 'Beer — original extract');
  await page.getByRole('button', { name: 'Nouveau jeu', exact: true }).click();
  await page.locator('.demo-card', { hasText: 'Anopheles' }).click();
  // Keep the full grid: the released engine's exact diagnostics are slower on this wide matrix.
  await page.getByText('Analyse terminée', { exact: true }).waitFor({ timeout: 600000 });
  assert.equal(await page.locator('.ws-title').innerText(), 'Anopheles — oocyst presence');
  assert.deepEqual(errors, []);
  console.log('Dataset smoke passed: drop-to-analyse IO import, WASM analysis, persisted reuse, removal, mobile layout and both real demos (Beer and Anopheles).');
} finally { await browser.close(); }
