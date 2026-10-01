import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * "Remove span tags": the body button and the export option share stripSpans. Needs a
 * real DOM, so it runs in the page.
 */

let bundle: string;

test.beforeAll(async () => {
  const result = await esbuild.build({
    stdin: {
      contents: `export { stripSpans } from './src/lib/stripSpans';
                 export { extractPublicHtml } from './src/lib/extractPublicHtml';`,
      resolveDir: path.join(__dirname, '..'),
      loader: 'ts',
    },
    bundle: true, write: false, format: 'iife', globalName: 'Spans',
    platform: 'browser', target: 'es2020',
  });
  bundle = result.outputFiles[0].text;
});

const strip = async (page: import('@playwright/test').Page, html: string) => {
  await page.goto('data:text/html,<body>host</body>');
  await page.addScriptTag({ content: bundle });
  return page.evaluate(h => (window as any).Spans.stripSpans(h), html);
};

test.describe('stripSpans', () => {
  test('unwraps a pasted span and keeps its text', async ({ page }) => {
    const result = await strip(page,
      '<p><span style="font-family: Calibri; font-size: 11pt">Our clinic opens at 9.</span></p>');
    expect(result).toEqual({ html: '<p>Our clinic opens at 9.</p>', removed: 1 });
  });

  test('nested spans all go, and the markup around them stays', async ({ page }) => {
    const result = await strip(page,
      '<p><span class="a"><span lang="en">Read <strong>this</strong></span> and <a href="/x"><span>that</span></a>.</span></p>');
    expect(result).toEqual({ html: '<p>Read <strong>this</strong> and <a href="/x">that</a>.</p>', removed: 3 });
  });

  test('an empty span disappears entirely', async ({ page }) => {
    expect(await strip(page, '<p>One<span style="mso-tab-count:1"></span> two</p>'))
      .toEqual({ html: '<p>One two</p>', removed: 1 });
  });

  test('a non-breaking space inside a span survives as &nbsp;', async ({ page }) => {
    expect((await strip(page, '<p>Dr.<span>&nbsp;</span>Smith</p>')).html).toBe('<p>Dr.&nbsp;Smith</p>');
  });

  test('HTML with no spans comes back exactly as it went in', async ({ page }) => {
    // Not re-serialised: `<br />` would come back as `<br>`, a change nobody asked for.
    const html = '<p>Line one<br />Line two</p>';
    expect(await strip(page, html)).toEqual({ html, removed: 0 });
  });

  test('nothing in the markup runs while it is being cleaned', async ({ page }) => {
    await strip(page, '<span><img src="x" onerror="window.__ran = true"></span>');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).__ran)).toBeUndefined();
  });
});

test.describe('exporting public HTML without span tags', () => {
  const ORIGIN = 'https://site.test';
  const PUBLIC = `<!DOCTYPE html><html><body><article>
    <p><span style="color: #222">Pasted copy.</span></p><p>Plain copy.</p>
  </article></body></html>`;

  const exportHtml = async (page: import('@playwright/test').Page, options: object) => {
    await page.route(`${ORIGIN}/**`, route => route.fulfill({
      contentType: 'text/html',
      body: route.request().url().endsWith('/node/5') ? PUBLIC : '<body>edit form</body>',
    }));
    await page.goto(`${ORIGIN}/node/5/edit`);
    await page.addScriptTag({ content: bundle });
    return page.evaluate(o => (window as any).Spans.extractPublicHtml(window.location, o), options);
  };

  test('removes them when asked', async ({ page }) => {
    const html = await exportHtml(page, { stripSpans: true });
    expect(html).not.toContain('<span');
    expect(html).toContain('<p>Pasted copy.</p>');
  });

  test('keeps them by default', async ({ page }) => {
    expect(await exportHtml(page, {})).toContain('<span style="color: #222">Pasted copy.</span>');
  });
});
