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

  /**
   * Markup copied from the real captured add form, not invented.
   *
   * The first version of this fixture put the hidden fid OUTSIDE `.media-widget`, and
   * widgetWrapper stops at `.media-widget` — so the fid was never found, `fid` came back
   * null either way, and the test passed with the bug restored. It was caught by
   * reverting. On a real form the fid lives INSIDE that div, as `<input class="fid">`
   * alongside the upload input and the Browse button.
   */
  const emptyMediaWidget = (fidValue: string) => `
    <form class="node-form">
      <div class="field-type-image field-name-field-image-featured field-widget-media-generic form-wrapper"
           id="edit-field-image-featured">
        <div class="form-item form-type-media">
          <label for="edit-ff-upload">Featured Image</label>
          <div class="media-widget form-media clearfix" id="edit-ff-upload--widget">
            <div class="preview"></div>
            <input class="upload form-text" type="text" id="edit-ff-upload"
                   name="media[field_image_featured_und_0]" value="" style="display: none;">
            <a href="#" class="button browse">Browse</a>
            <input class="fid" type="hidden"
                   name="field_image_featured[und][0][fid]" value="${fidValue}">
            <input type="hidden" name="field_image_featured[und][0][display]" value="">
          </div>
        </div>
      </div>
    </form>`;

  for (const [label, value] of [['0', '0'], ['empty', '']] as const) {
    test(`an unset image field (fid="${label}") is not mistaken for a file`, async ({ page }) => {
      /**
       * Reported from a real paste: "9 filled, 2 images to attach" where the source page
       * had one. The second row showed no filename, no URL, and a red line telling the
       * editor to open the source page and find it. There was nothing to find.
       *
       * Both spellings are covered because the captured add form writes `value=""` while
       * Drupal's Form API default for the field is 0, and which one reaches the browser
       * is not something to rely on.
       */
      await page.goto('data:text/html,<body></body>');
      await page.setContent(emptyMediaWidget(value));
      await page.addScriptTag({ content: bundle });

      const refs = await page.evaluate(() => {
        const api = (window as any).M;
        const schema = api.discoverSchema(document, { pathname: '/node/1313/edit' });
        return api.describeMediaRefs(schema.fields, 'https://source.example.edu/node/1313/edit')
          .map((r: any) => ({ fid: r.fid, attached: api.hasAttachment(r) }));
      });

      expect(refs.length, 'the field itself should still be discovered').toBe(1);
      expect(refs[0].fid, 'an unset fid must not be carried').toBeNull();
      expect(refs[0].attached, 'an empty image field was reported as an attachment').toBe(false);
    });
  }

  test('the fid really is reachable from the widget wrapper', async ({ page }) => {
    /**
     * Guards the assumption the two tests above depend on. If widgetWrapper ever stops
     * reaching the fid, those tests would pass for the wrong reason — fid null because
     * nothing was found rather than because the value was rejected.
     */
    await page.goto('data:text/html,<body></body>');
    await page.setContent(emptyMediaWidget('44120'));
    await page.addScriptTag({ content: bundle });

    const refs = await page.evaluate(() => {
      const api = (window as any).M;
      const schema = api.discoverSchema(document, { pathname: '/node/1313/edit' });
      return api.describeMediaRefs(schema.fields, 'https://source.example.edu/node/1313/edit');
    });
    expect(refs[0].fid, 'the fid was not found in this widget at all').toBe('44120');
  });

  test('a real file id is still carried', async ({ page }) => {
    // The other direction, so the fix above cannot be "report nothing, ever".
    await load(page, 'node-edit-media-populated.html');
    const attached = await page.evaluate(() => {
      const api = (window as any).M;
      const schema = api.discoverSchema(document, { pathname: '/node/451/edit' });
      return api.describeMediaRefs(schema.fields, 'https://example.edu/node/451/edit')
        .filter((r: any) => api.hasAttachment(r))
        .map((r: any) => r.fid);
    });
    expect(attached).toEqual(['44120', '44121']);
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
