import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { originalFileUrl } from '../src/lib/clone/media';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://www.columbiadoctors.org/node/18948/edit';

/**
 * Images cannot travel as field values, so what travels is a URL. These tests are about
 * that URL being the ORIGINAL file rather than the 60x40 thumbnail Drupal shows in the
 * widget — hand someone the thumbnail to re-upload and every migrated image is silently
 * degraded, with nothing in the UI to suggest it.
 */

test.describe('deriving the original file from a style derivative', () => {
  test('the image-style segment is removed', () => {
    expect(originalFileUrl(
      '/sites/default/files/styles/thumbnail/public/2019/04/puberty.jpg', BASE
    )).toBe('https://www.columbiadoctors.org/sites/default/files/2019/04/puberty.jpg');
  });

  test('any style name is handled, not a known list', () => {
    expect(originalFileUrl(
      '/sites/default/files/styles/teaser_16x9_large/public/hero.png', BASE
    )).toBe('https://www.columbiadoctors.org/sites/default/files/hero.png');
  });

  test('private-scheme derivatives are handled too', () => {
    expect(originalFileUrl(
      '/system/files/styles/medium/private/report.pdf', BASE
    )).toBe('https://www.columbiadoctors.org/system/files/report.pdf');
  });

  test('the image-style token is dropped', () => {
    /**
     * `?itok=` authenticates the DERIVATIVE. Carried onto the original it is not merely
     * useless — on a site enforcing image-style tokens the request 403s, so the URL in
     * the review would look right and fail when clicked.
     */
    expect(originalFileUrl(
      '/sites/default/files/styles/thumbnail/public/x.jpg?itok=AbC123', BASE
    )).toBe('https://www.columbiadoctors.org/sites/default/files/x.jpg');
  });

  test('a URL with no style segment is already the original', () => {
    expect(originalFileUrl('/sites/default/files/plain.jpg', BASE))
      .toBe('https://www.columbiadoctors.org/sites/default/files/plain.jpg');
  });

  test('an absolute URL on another host keeps that host', () => {
    expect(originalFileUrl('https://cdn.example.edu/styles/big/public/a.jpg', BASE))
      .toBe('https://cdn.example.edu/a.jpg');
  });
});

test.describe('what is not a file on the source site', () => {
  test('a data URI is not an image that can be fetched', () => {
    // The scrubbed fixtures carry a 1x1 gif placeholder. Treating it as a real image
    // would put an unusable entry in the checklist for every image field.
    expect(originalFileUrl(
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7', BASE
    )).toBeNull();
  });

  test('a javascript: URL is refused', () => {
    expect(originalFileUrl('javascript:alert(1)', BASE)).toBeNull();
  });

  test('an empty or unparseable src is refused', () => {
    expect(originalFileUrl('', BASE)).toBeNull();
    expect(originalFileUrl('   ', BASE)).toBeNull();
  });
});

test.describe('reading the widgets on a populated form', () => {
  let bundle: string;

  test.beforeAll(async () => {
    const entry = path.join(__dirname, 'fixtures', '.clone-media-entry.ts');
    fs.writeFileSync(entry, `
      export { discoverSchema } from '../../src/lib/formSchema';
      export { describeMediaRefs, hasAttachment } from '../../src/lib/clone/media';
    `);
    const built = await esbuild.build({
      entryPoints: [entry], bundle: true, write: false, format: 'iife',
      globalName: 'M', platform: 'browser', target: 'es2020',
    });
    bundle = built.outputFiles[0].text;
    fs.unlinkSync(entry);
  });

  const load = async (page: import('@playwright/test').Page, fixture: string) => {
    await page.goto('data:text/html,<body>host</body>');
    await page.setContent(fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8'));
    await page.addScriptTag({ content: bundle });
  };

  test('an attached image reports its field, file id and filename', async ({ page }) => {
    await load(page, 'node-edit-media-populated.html');
    const refs = await page.evaluate(() => {
      const api = (window as any).M;
      const schema = api.discoverSchema(document, { pathname: '/node/451/edit' });
      return api.describeMediaRefs(schema.fields, 'https://example.edu/node/451/edit');
    });

    const teaser = refs.find((r: any) => r.baseName === 'field_image_teaser');
    expect(teaser, 'the teaser image field was not found at all').toBeTruthy();
    expect(teaser.fid).toBe('44120');
    expect(teaser.filename).toBe('puberty-study-teaser.jpg');
    expect(teaser.label).toBe('Teaser Image');
  });

  test('every image field on the form is reported, not just the first', async ({ page }) => {
    await load(page, 'node-edit-media-populated.html');
    const bases = await page.evaluate(() => {
      const api = (window as any).M;
      const schema = api.discoverSchema(document, { pathname: '/node/451/edit' });
      return api.describeMediaRefs(schema.fields, 'https://example.edu/node/451/edit')
        .map((r: any) => r.baseName).sort();
    });
    expect(bases).toEqual(['field_image_hero', 'field_image_teaser']);
  });

  test('a placeholder thumbnail yields no URL rather than a broken one', async ({ page }) => {
    // This fixture's thumbnails are scrubbed to a data URI, so there is genuinely no
    // fetchable original. Reporting the fid and filename with url=null is the honest
    // outcome; inventing a URL from the filename would guess at a path.
    await load(page, 'node-edit-media-populated.html');
    const urls = await page.evaluate(() => {
      const api = (window as any).M;
      const schema = api.discoverSchema(document, { pathname: '/node/451/edit' });
      return api.describeMediaRefs(schema.fields, 'https://example.edu/node/451/edit')
        .map((r: any) => r.url);
    });
    expect(urls).toEqual([null, null]);
  });

  test('an add form with no image attached reports the field as empty', async ({ page }) => {
    await load(page, 'captured/page.html');
    const refs = await page.evaluate(() => {
      const api = (window as any).M;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      const found = api.describeMediaRefs(schema.fields, 'https://example.edu/node/add/page');
      return found.map((r: any) => ({ base: r.baseName, attached: api.hasAttachment(r) }));
    });

    expect(refs.length, 'Page has two image fields and neither was found').toBeGreaterThan(0);
    expect(refs.every((r: any) => r.attached === false)).toBe(true);
  });
});
