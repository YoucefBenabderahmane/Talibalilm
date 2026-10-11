import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';

/**
 * The class recorder, in a real Chromium with a fake camera and microphone.
 *
 * Every test here is a failure a teacher lived through or would have: a slide
 * that froze the file, « Reprendre » that resumed nothing, a crash that took
 * the lesson with it, a double click that started two recorders. Unit tests
 * cannot see any of it — MediaRecorder, canvas tainting and IndexedDB only
 * exist in a browser — so the real `RecordingSession` is bundled and driven
 * here.
 *
 * Two servers: the page on 127.0.0.1, and "the bucket" on localhost — a
 * different origin, exactly like R2 — serving the slide with or without CORS.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

// A 64×64 red PNG: the slide.
const SLIDE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQ0lEQVR42u3PMQ0AAAgDoC251a3gHFQgmnSSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSdLoBX38AQZMpQi4AAAAASUVORK5CYII=',
  'base64',
);

let pageServer: http.Server;
let bucketServer: http.Server;
let pageUrl = '';
let bucketUrl = '';

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [path.join(here, 'harness.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    alias: { '@': path.join(root, 'src') },
  });
  const script = bundle.outputFiles[0]!.text;
  const html = `<!doctype html><html><body style="margin:0;background:#111">
<div data-record-container style="position:relative;width:960px;height:540px">
  <video data-record autoplay muted playsinline style="width:100%;height:100%"></video>
</div><script>${script}</script></body></html>`;

  pageServer = http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  bucketServer = http.createServer((req, res) => {
    const cors = req.url?.startsWith('/cors/');
    res.writeHead(200, {
      'content-type': 'image/png',
      // What R2 answers once GET is in its CORS policy, and what it answers today.
      ...(cors ? { 'access-control-allow-origin': '*' } : {}),
    });
    res.end(SLIDE);
  });
  await new Promise<void>((r) => pageServer.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => bucketServer.listen(0, 'localhost', r));
  pageUrl = `http://127.0.0.1:${(pageServer.address() as { port: number }).port}/`;
  bucketUrl = `http://localhost:${(bucketServer.address() as { port: number }).port}`;
});

test.afterAll(async () => {
  pageServer?.close();
  bucketServer?.close();
});

async function open(page: Page) {
  await page.goto(pageUrl);
  await page.waitForFunction(() => window.harness?.ready === true);
}

/** Chunks the recorder handed over after `since` (ms epoch). */
async function chunksSince(page: Page, since: number) {
  return page.evaluate((t) => window.harness.chunks.filter((c) => c.at > t), since);
}

test('a slide the page cannot read never freezes the recording', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.harness.start());
  await page.waitForTimeout(6_000);

  // The October class: a slide from the bucket, no CORS. It used to taint the
  // canvas and the file stopped gaining picture for the rest of the lesson.
  await page.evaluate((src) => window.harness.addSlide(src, false), `${bucketUrl}/plain/s.png`);
  const shownAt = await page.evaluate(() => Date.now());
  await page.waitForTimeout(12_000);

  expect(await page.evaluate(() => window.harness.videoMuted())).toBe(false);
  // A frozen recorder hands over NOTHING until it is stopped — that is how the
  // bug looked from inside. A healthy one keeps its five-second rhythm. (The
  // card standing in for the slide is static, so the chunks are small; their
  // arriving at all is the signal.)
  const after = await chunksSince(page, shownAt);
  expect(after.length).toBeGreaterThanOrEqual(2);
  expect(Math.min(...after.map((c) => c.bytes))).toBeGreaterThan(10_000);

  const issues = await page.evaluate(() => window.harness.issues);
  expect(issues.map((i) => i.code)).toContain('slidesNotRecorded');
  expect(issues.find((i) => i.code === 'slidesNotRecorded')?.fatal).toBe(false);

  await page.evaluate(() => window.harness.stop());
  const saved = await page.evaluate(() => window.harness.saved);
  expect(saved).toHaveLength(1);
  const seconds = await page.evaluate((url) => window.harness.duration(url), saved[0]!.url);
  expect(seconds).toBeGreaterThan(16);
});

test('a slide served with CORS is recorded, and nothing is reported', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.harness.start());
  await page.waitForTimeout(3_000);
  await page.evaluate((src) => window.harness.addSlide(src, true), `${bucketUrl}/cors/s.png`);
  await page.waitForTimeout(6_000);

  expect(await page.evaluate(() => window.harness.videoMuted())).toBe(false);
  const codes = await page.evaluate(() => window.harness.issues.map((i) => i.code));
  expect(codes).not.toContain('slidesNotRecorded');
  expect(codes).not.toContain('pictureBlocked');
  await page.evaluate(() => window.harness.stop());
});

test('pause then « Reprendre » records again, and the pause is not in the file', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.harness.start());
  await page.waitForTimeout(6_000);

  expect(await page.evaluate(() => window.harness.pause())).toBe(true);
  // Showing a slide DURING the pause is the exact sequence that broke the class.
  await page.evaluate((src) => window.harness.addSlide(src, false), `${bucketUrl}/plain/p.png`);
  await page.waitForTimeout(8_000);

  expect(await page.evaluate(() => window.harness.resume())).toBe(true);
  const resumedAt = await page.evaluate(() => Date.now());
  await page.waitForTimeout(8_000);

  const after = await chunksSince(page, resumedAt);
  expect(after.length).toBeGreaterThanOrEqual(1);
  expect(Math.max(...after.map((c) => c.bytes))).toBeGreaterThan(100_000);

  await page.evaluate(() => window.harness.stop());
  const states = await page.evaluate(() => window.harness.states);
  expect(states).toEqual(['starting', 'recording', 'paused', 'recording', 'saving', 'idle']);

  const [file] = await page.evaluate(() => window.harness.saved);
  const seconds = await page.evaluate((url) => window.harness.duration(url), file!.url);
  // 6 s + 8 s recorded; the 8 s pause is not in the file.
  expect(seconds).toBeGreaterThan(11);
  expect(seconds).toBeLessThan(18);
});

test('a recorder that fails mid-lesson saves what it had and says why', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.harness.start());
  await page.waitForTimeout(6_000);
  await page.evaluate(() => window.harness.failRecorder('encoder lost'));
  await page.waitForFunction(() => window.harness.states.at(-1) === 'idle');

  const issue = await page.evaluate(() => window.harness.issues.find((i) => i.fatal));
  expect(issue?.code).toBe('recorderFailed');
  expect(issue?.detail).toContain('encoder lost');
  const saved = await page.evaluate(() => window.harness.saved);
  expect(saved).toHaveLength(1);
  expect(saved[0]!.bytes).toBeGreaterThan(100_000);
});

test('a crash leaves the recording on disk to recover', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.harness.start());
  await page.waitForTimeout(11_500);
  // No « Arrêter »: the tab reloads, as after a crash or a closed laptop.
  await page.reload();
  await page.waitForFunction(() => window.harness?.ready === true);

  const pending = await page.evaluate(() => window.harness.pending());
  expect(pending.length).toBeGreaterThanOrEqual(1);
  expect(pending[0]!.chunks).toBeGreaterThanOrEqual(2);

  const file = await page.evaluate((id) => window.harness.recover(id), pending[0]!.id);
  expect(file?.bytes).toBeGreaterThan(200_000);
  const seconds = await page.evaluate((url) => window.harness.duration(url), file!.url);
  expect(seconds).toBeGreaterThan(8);
});

test('a double click on « Enregistrer » starts one recorder, not two', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.harness.startTwiceQuickly());
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => window.harness.recorderConstructions)).toBe(1);
  await page.evaluate(() => window.harness.stop());
});

test('« Arrêter » pressed while still starting leaves nothing running', async ({ page }) => {
  await open(page);
  const state = await page.evaluate(() => window.harness.stopWhileStarting());
  expect(state).toBe('idle');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.harness.recorderConstructions)).toBe(0);
});

test('a lost microphone is opened again', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.harness.start());
  await page.waitForTimeout(2_000);
  expect(await page.evaluate(() => window.harness.micRequests)).toBe(1);
  await page.evaluate(() => window.harness.loseMic());
  await page.waitForFunction(() => window.harness.micRequests === 2);
  await page.evaluate(() => window.harness.stop());
});

test('« Quitter » right after « Arrêter » still delivers the whole file', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.harness.start({ realDownload: true }));
  await page.waitForTimeout(8_000);

  const downloading = page.waitForEvent('download');
  // Stop, then navigate away the moment the save resolves — what the room's
  // « Quitter » and « Terminer » buttons do.
  void page.evaluate(() => window.harness.stopAndLeave()).catch(() => {});
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('cours-test.webm');
  const file = await download.path();
  const { size } = await import('node:fs').then((fs) => fs.promises.stat(file));
  expect(size).toBeGreaterThan(300_000);
  expect(await download.failure()).toBeNull();
});
