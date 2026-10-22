import { test, expect, type Page } from '@playwright/test';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * The public address of the page an edit form belongs to, when the form shows only /node/N
 * (ruling R17): the page itself is read, and its canonical link or og:url says where it
 * lives. Bundled into a blank page for DOMParser; the fetch is a stand-in, so nothing here
 * reaches a site. The wiring into the panel is covered in tests/extension.test.ts.
 */

const HOST = 'https://www.cuimc.columbia.edu';
const NODE = `${HOST}/node/23110`;

let bundle: string;

test.beforeAll(async () => {
  const result = await esbuild.build({
    stdin: { contents: `export * from './src/lib/varys/publicAddress';`, resolveDir: ROOT, loader: 'ts' },
    bundle: true, write: false, format: 'iife', globalName: 'Address',
    platform: 'browser', target: 'es2020',
  });
  bundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle });
});

const head = (inner: string) => `<!doctype html><html><head>${inner}</head><body><h1>Our list</h1></body></html>`;

/** resolvePublicAddress(address) against a site that answers every request with `html` (null: no page). */
function resolve(page: Page, address: string, html: string | null) {
  return page.evaluate(async ([a, h]) => {
    const asked: string[] = [];
    const resolved = await (window as any).Address.resolvePublicAddress(a, async (url: string) => {
      asked.push(url);
      return h;
    });
    return { resolved, asked };
  }, [address, html] as const);
}

test('a /node/N address is read for its canonical link', async ({ page }) => {
  expect(await resolve(page, NODE, head(`<link rel="canonical" href="${HOST}/faculty/our-list">`)))
    .toEqual({ resolved: `${HOST}/faculty/our-list`, asked: [NODE] });
});

test('a relative canonical, a shortlink beside it, and a query or fragment are all handled', async ({ page }) => {
  const html = head('<link rel="shortlink" href="/node/23110"><link rel="canonical" href="/faculty/our-list?x=1#top">');
  expect((await resolve(page, NODE, html)).resolved).toBe(`${HOST}/faculty/our-list`);
});

test('og:url answers when there is no canonical link', async ({ page }) => {
  const html = head(`<meta property="og:url" content="${HOST}/faculty/our-list">`);
  expect((await resolve(page, NODE, html)).resolved).toBe(`${HOST}/faculty/our-list`);
});

test('the www twin of the host is the same site, and the address stays on the form\'s own host', async ({ page }) => {
  const html = head('<link rel="canonical" href="https://cuimc.columbia.edu/faculty/our-list">');
  expect((await resolve(page, NODE, html)).resolved).toBe(`${HOST}/faculty/our-list`);
});

test('an address that is not this page of this site is refused, and /node/N stands', async ({ page }) => {
  for (const href of [
    'https://www.columbiadoctors.org/faculty/our-list',  // another site: syndicated content says so
    `${HOST}/node/23110`,                                  // no alias: there is nothing better
    `${HOST}/node/23110/`,
    `${HOST}/`,                                            // a site that points everything home
    `${HOST}/user/login`,                                  // the session had gone
    `${HOST}/admin/content`,
    'javascript:alert(1)',
  ]) {
    expect((await resolve(page, NODE, head(`<link rel="canonical" href="${href}">`))).resolved, href).toBe(NODE);
  }
});

test('a refused canonical gives way to a good og:url', async ({ page }) => {
  const html = head(`<link rel="canonical" href="${HOST}/node/23110"><meta property="og:url" content="${HOST}/faculty/our-list">`);
  expect((await resolve(page, NODE, html)).resolved).toBe(`${HOST}/faculty/our-list`);
});

test('no page, or a page that names no address, leaves /node/N', async ({ page }) => {
  expect(await resolve(page, NODE, null)).toEqual({ resolved: NODE, asked: [NODE] });
  expect((await resolve(page, NODE, head('<title>Our list</title>'))).resolved).toBe(NODE);
});

test('a fetch that throws leaves /node/N', async ({ page }) => {
  const resolved = await page.evaluate(n => (window as any).Address.resolvePublicAddress(n, async () => {
    throw new Error('offline');
  }), NODE);
  expect(resolved).toBe(NODE);
});

test('an address that is already the page\'s alias is not fetched at all', async ({ page }) => {
  expect(await resolve(page, `${HOST}/faculty/our-list`, head(`<link rel="canonical" href="${HOST}/elsewhere">`)))
    .toEqual({ resolved: `${HOST}/faculty/our-list`, asked: [] });
});
