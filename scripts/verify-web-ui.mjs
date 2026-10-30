// Optional browser regression: npm install --prefix test-results/browser-tools --no-save --package-lock=false playwright
// Build first, then: node scripts/verify-web-ui.mjs
// All /api calls are fixtures. This never contacts Google, Blob or Kaggle.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const browserRequire = createRequire(new URL('../test-results/browser-tools/package.json', import.meta.url));
const { chromium } = browserRequire('playwright');

const root = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const output = fileURLToPath(new URL('../test-results/web-ui/', import.meta.url));
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${root}${path.sep}`) && file !== path.join(root, 'index.html')) {
    response.writeHead(403).end(); return;
  }
  try {
    const body = await readFile(file);
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)];
    response.writeHead(200, { 'Content-Type': type || 'application/octet-stream' }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.UI_BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let queueState = 'IDLE';
  let failDownload = false;
  let failStatus = false;
  let forbiddenCalls = 0;
  const base = { progress: null, fileSizeBytes: 12000000, durationSec: null, processedAudioSec: null,
    errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), uploadCompletedAt: new Date().toISOString(),
    completedAt: null, expiresAt: null };
  let jobs = [
    { ...base, id: 'waiting', filename: 'French lecture.mp3', status: 'QUEUED' },
    { ...base, id: 'done', filename: 'Completed lecture.mp3', status: 'COMPLETED', progress: 1,
      completedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() },
    { ...base, id: 'expired', filename: 'Older recording.mp3', status: 'EXPIRED' },
  ];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const json = (data, status = 200) => route.fulfill({ status, json: data });
    if (pathname === '/api/auth/session') return json({ user: { email: 'preview@example.test', name: 'Workspace preview', image: null }, expires: '2099-01-01' });
    if (pathname === '/api/kaggle/status') return failStatus ? json({}, 503) : json({ available: false, message: 'Online GPU setup is not available yet. You can still upload files and manage your queue.' });
    if (pathname === '/api/jobs') return json({ jobs, queueState, queuedCount: jobs.filter((job) => job.status === 'QUEUED').length });
    if (pathname.endsWith('/cancel')) {
      const job = jobs.find((item) => pathname.includes(`/${item.id}/`));
      if (job.status === 'QUEUED') job.status = 'CANCELLED';
      else { job.status = 'CANCEL_REQUESTED'; queueState = 'PAUSING'; }
      return json({ job });
    }
    if (pathname.endsWith('/download')) {
      if (failDownload) return route.abort('failed');
      return route.fulfill({ body: 'Fixture transcript only.', headers: { 'Content-Type': 'text/plain' } });
    }
    if (pathname === '/api/uploads/init') return json({ error: { message: 'Fixture upload rejected.' } }, 400);
    forbiddenCalls++;
    return json({ error: { message: 'Unexpected API call in browser fixture.' } }, 500);
  });
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Your recordings, ready to transcribe.' }).waitFor();
  await page.getByRole('status').filter({ hasText: 'Online GPU setup' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect Kaggle GPU', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Check GPU condition', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled(), true);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'transcribe-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'User Guide', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'User Guide', exact: true }).evaluate((el) => el === document.activeElement), true);

  await page.getByRole('button', { name: 'History', exact: false }).first().click();
  await page.getByRole('heading', { name: 'History', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Download TXT', exact: true }).count(), 1);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download TXT', exact: true }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'Completed lecture.txt');
  await page.screenshot({ path: path.join(output, 'history-desktop.png'), fullPage: true });
  failDownload = true;
  await page.getByRole('button', { name: 'Download TXT', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'download was interrupted' }).waitFor();

  await page.getByRole('button', { name: 'Transcribe', exact: false }).first().click();
  await page.locator('input[type=file]').setInputFiles({ name: 'fixture.wav', mimeType: 'audio/wav', buffer: Buffer.from('fixture') });
  await page.getByText('Fixture upload rejected.').waitFor();
  await page.getByRole('button', { name: 'Dismiss failed upload fixture.wav' }).click();
  await page.getByRole('button', { name: 'Remove French lecture.mp3' }).click();
  await page.getByText('No files in the queue. Add a recording to get started.').waitFor();

  jobs = [{ ...base, id: 'active', filename: 'Active lecture.mp3', status: 'TRANSCRIBING', progress: 0.4 },
    { ...base, id: 'next', filename: 'Next recording.mp3', status: 'QUEUED' }];
  queueState = 'RUNNING';
  await page.reload();
  await page.getByRole('button', { name: 'Cancel processing Active lecture.mp3' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Cancel and pause queue' }).click();
  await page.getByText('Stopping current worker...').waitFor();
  assert.equal(await page.getByText('Next recording.mp3', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Stopping…', exact: true }).isDisabled(), true);

  jobs[0].status = 'CANCELLED';
  queueState = 'PAUSED';
  await page.reload();
  await page.getByText('Queue paused', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Resume queue', exact: true }).isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'transcribe-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole('button', { name: 'User Guide', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'guide-mobile.png'), fullPage: true });
  await page.keyboard.press('Escape');

  failStatus = true;
  await page.getByRole('button', { name: 'Kaggle connection Show setup' }).click();
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.getByText('Could not check online GPU availability. Please try again.').waitFor();
  failStatus = false;
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Online GPU setup' }).waitFor();
  assert.equal(forbiddenCalls, 0, 'Disabled GPU controls must not launch work.');
  assert.deepEqual(errors, []);
  console.log('UI_SMOKE_OK: navigation, unavailable GPU, guide focus/Escape, download/error, upload error, remove, cancel, pause, mobile, status retry; fixtures only.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
