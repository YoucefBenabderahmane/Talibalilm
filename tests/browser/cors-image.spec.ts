import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';

/**
 * Slides load with CORS first so the class recorder may draw them. That must
 * never cost the class the slide itself: against a bucket that does not answer
 * CORS — R2 as configured today — the image has to fall back and show.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const SLIDE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQ0lEQVR42u3PMQ0AAAgDoC251a3gHFQgmnSSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSdLoBX38AQZMpQi4AAAAASUVORK5CYII=',
  'base64',
);

let pageServer: http.Server;
let bucket: http.Server;
let pageUrl = '';
let bucketUrl = '';
const requests: { path: string; origin: string | undefined }[] = [];

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [path.join(here, 'cors-image.harness.tsx')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { '@': path.join(root, 'src') },
  });
  const html = `<!doctype html><html><body><script>${bundle.outputFiles[0]!.text}</script></body></html>`;
  pageServer = http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  bucket = http.createServer((req, res) => {
    requests.push({ path: req.url ?? '', origin: req.headers.origin });
    const cors = req.url?.startsWith('/cors/');
    res.writeHead(200, {
      'content-type': 'image/png',
      ...(cors ? { 'access-control-allow-origin': '*' } : {}),
    });
    res.end(SLIDE);
  });
  await new Promise<void>((r) => pageServer.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => bucket.listen(0, 'localhost', r));
  pageUrl = `http://127.0.0.1:${(pageServer.address() as { port: number }).port}/`;
  bucketUrl = `http://localhost:${(bucket.address() as { port: number }).port}`;
});

test.afterAll(() => {
  pageServer?.close();
  bucket?.close();
});

async function mount(page: Page, src: string) {
  await page.goto(pageUrl);
  await page.evaluate((s) => window.mountSlide(s), src);
  const img = page.getByTestId('slide');
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);
  return img;
}

test('a bucket without CORS still shows the slide, as a plain image', async ({ page }) => {
  const img = await mount(page, `${bucketUrl}/plain/a.png?sig=1`);
  expect(await img.evaluate((el: HTMLImageElement) => el.crossOrigin)).toBeNull();
  // It tried CORS first (an Origin header), then fell back.
  const hits = requests.filter((r) => r.path === '/plain/a.png?sig=1');
  expect(hits.some((r) => r.origin)).toBe(true);
});

test('a bucket with CORS shows the slide readable for the recorder', async ({ page }) => {
  const img = await mount(page, `${bucketUrl}/cors/b.png?sig=2`);
  expect(await img.evaluate((el: HTMLImageElement) => el.crossOrigin)).toBe('anonymous');
});
