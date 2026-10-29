import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * What a Varys draft body may carry into Drupal's editor.
 *
 * Varys already reduces a draft body to this allow-list before it leaves (safe_body_html in
 * backend/app/services/draft_review.py); the extension applies the same list again before
 * CKEditor's setData, so a body that did not come through that path (a Varys that was
 * compromised, or an account an attacker connected the extension to) still cannot put script
 * into a page that will be published. Needs a real DOM, so it runs in the page.
 */

let bundle: string;

test.beforeAll(async () => {
  const result = await esbuild.build({
    stdin: {
      contents: `export { safeBodyHtml } from './src/lib/varys/safeBody';
                 export { bodyToFill } from './src/lib/varys/draftFill';`,
      resolveDir: path.join(__dirname, '..'),
      loader: 'ts',
    },
    bundle: true, write: false, format: 'iife', globalName: 'Safe',
    platform: 'browser', target: 'es2020',
  });
  bundle = result.outputFiles[0].text;
});

async function load(page: import('@playwright/test').Page) {
  await page.goto('data:text/html,<body>host</body>');
  await page.addScriptTag({ content: bundle });
}

const safe = async (page: import('@playwright/test').Page, html: string) => {
  await load(page);
  return page.evaluate(h => (window as any).Safe.safeBodyHtml(h), html) as Promise<string>;
};

test.describe('safeBodyHtml', () => {
  test('keeps the markup a draft is made of', async ({ page }) => {
    const html = '<h2>Heading</h2><h3>Sub</h3><p>A <strong>b</strong> <em>c</em><br>d</p>'
      + '<ul><li>one</li></ul><ol><li>two</li></ol><p><a href="https://www.columbiadoctors.org/x">link</a></p>';
    expect(await safe(page, html)).toBe(html);
  });

  test('drops script and style with their contents', async ({ page }) => {
    expect(await safe(page, '<p>a</p><script>alert(1)</script><style>p{}</style><p>b</p>')).toBe('<p>a</p><p>b</p>');
  });

  test('unwraps anything else and keeps its words; images and frames vanish', async ({ page }) => {
    expect(await safe(page, '<div><p>kept <span style="x">words</span></p></div><img src=x onerror="alert(1)"><iframe src="https://x.example"></iframe>'))
      .toBe('<p>kept words</p>');
  });

  test('drops every attribute but a safe href', async ({ page }) => {
    expect(await safe(page, '<p onclick="x" class="c"><a href="https://a.org" onmouseover="x" target="_blank">t</a></p>'))
      .toBe('<p><a href="https://a.org">t</a></p>');
  });

  for (const href of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x', '/relative', '']) {
    test(`unwraps a link whose href is ${JSON.stringify(href)}`, async ({ page }) => {
      expect(await safe(page, `<p>see <a href="${href}">this</a></p>`)).toBe('<p>see this</p>');
    });
  }

  test('keeps mailto and tel links', async ({ page }) => {
    expect(await safe(page, '<p><a href="mailto:a@b.org">m</a><a href="tel:+1212">t</a></p>'))
      .toBe('<p><a href="mailto:a@b.org">m</a><a href="tel:+1212">t</a></p>');
  });

  test('never turns escaped text into markup, and drops comments', async ({ page }) => {
    expect(await safe(page, '<p>&lt;script&gt;x&lt;/script&gt;<!-- <img src=x onerror=y> --></p>'))
      .toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
  });

  test('is idempotent, as the server copy is', async ({ page }) => {
    const once = await safe(page, '<div><p>a <a href="https://a.org" onclick="x">b</a></p><img src=x></div>');
    expect(await safe(page, once)).toBe(once);
  });
});

test.describe('bodyToFill', () => {
  test('filters the draft body but keeps the Overview box the extension itself builds', async ({ page }) => {
    await load(page);
    const out = await page.evaluate(() => (window as any).Safe.bodyToFill({
      overview_bullets: ['First point'],
      body_html: '<p>Body</p><img src=x onerror="alert(1)"><script>alert(2)</script>',
    }, true)) as string;
    expect(out).toContain('<aside aria-labelledby="ck-callout--1000" class="ck-callout');
    expect(out).toContain('<li>First point</li>');
    expect(out).toContain('<p>Body</p>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
  });
});
