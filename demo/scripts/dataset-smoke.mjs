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
  await page.locator('.ws-status').filter({ hasText: 'Analysis complete' }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.ws-title').innerText(), 'combined.csv');
  assert.match(await page.locator('.ws-files').innerText(), /combined\.csv → full table/);
  await page.getByRole('button', { name: 'New dataset', exact: true }).click();
  const reuse = page.locator('.recent-item', { hasText: 'combined.csv' }).getByRole('button', { name: 'Analyse', exact: true });
  await reuse.waitFor();
  await page.reload();
  await reuse.click();
  await page.locator('.ws-status').filter({ hasText: 'Analysis complete' }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'New dataset', exact: true }).click();
  // A drop anywhere on the page (here on the title, outside the zone) imports the files too.
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['1000;1100;1200\n0.1;0.2;0.3\n0.4;0.5;0.6\n0.45;0.52;0.61'], 'X_train.csv', { type: 'text/csv' }));
    transfer.items.add(new File(['protein\n11\n12\n13'], 'y_train.csv', { type: 'text/csv' }));
    const target = document.querySelector('.hero-title');
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.locator('.ws-status').filter({ hasText: 'Analysis complete' }).waitFor({ timeout: 30000 });
  assert.match(await page.locator('.ws-files').innerText(), /X_train\.csv → spectra X/);
  assert.equal(await page.locator('.drop-overlay').count(), 0);
  await page.getByRole('button', { name: 'New dataset', exact: true }).click();
  // Declaring a repetition column re-imports the dropped files through IO and groups the scans.
  const scans = Array.from({ length: 12 }, (_, r) => Array.from({ length: 8 }, (_, b) => (.5 + .2 * Math.sin(b / 3 + Math.floor(r / 3) / 2) + .004 * ((r % 3 * 5 + b * 3) % 7)).toFixed(4)).join(';'));
  await page.locator('input[type=file]').first().setInputFiles([
    { name: 'X_train.csv', mimeType: 'text/csv', buffer: Buffer.from([Array.from({ length: 8 }, (_, b) => 1000 + 20 * b).join(';'), ...scans].join('\n')) },
    { name: 'y_train.csv', mimeType: 'text/csv', buffer: Buffer.from(['protein', ...scans.map((_, r) => (10 + Math.floor(r / 3) * .7).toFixed(2))].join('\n')) },
    { name: 'metadata_train.csv', mimeType: 'text/csv', buffer: Buffer.from(['Sample_ID;site', ...scans.map((_, r) => `p${Math.floor(r / 3)};${Math.floor(r / 3) % 2 ? 'north' : 'south'}`)].join('\n')) },
  ]);
  await page.locator('.ws-status').filter({ hasText: 'Analysis complete' }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Repetition column').selectOption('Sample_ID');
  await page.getByRole('button', { name: 'Apply and rerun', exact: true }).click();
  await page.locator('.ws-status').filter({ hasText: 'Analysis complete' }).waitFor({ timeout: 30000 });
  // Applying closes the settings; reopened, they show the declaration the rerun used.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.getByLabel('Repetition column').inputValue(), 'Sample_ID');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /Diagnosis/ }).first().click();
  await page.locator('#s-repeat .n4q-repeatability, #s-repeat svg').first().waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#s-repeat .empty').count(), 0, 'Repeatability not measured after declaring the repetition column');
  await page.getByRole('button', { name: 'New dataset', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile overflow');
  await page.screenshot({ path: '/tmp/preflight-dataset-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Remove combined.csv', exact: true }).click();
  await page.locator('.recent-item', { hasText: 'combined.csv' }).waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.demo-card', { hasText: 'Beer' }).click();
  await page.locator('.ws-status').filter({ hasText: 'Analysis complete' }).waitFor({ timeout: 90000 });
  assert.equal(await page.locator('.ws-title').innerText(), 'Beer — original extract');
  await page.getByRole('button', { name: 'New dataset', exact: true }).click();
  await page.locator('.demo-card', { hasText: 'Anopheles' }).click();
  // Keep the full grid: the released engine's exact diagnostics are slower on this wide matrix.
  await page.locator('.ws-status').filter({ hasText: 'Analysis complete' }).waitFor({ timeout: 600000 });
  assert.equal(await page.locator('.ws-title').innerText(), 'Anopheles — oocyst presence');
  assert.deepEqual(errors, []);
  console.log('Dataset smoke passed: drop-to-analyse IO import (zone and page-wide drop), declared repetition column, WASM analysis, persisted reuse, removal, mobile layout and both real demos (Beer and Anopheles).');
} finally { await browser.close(); }
