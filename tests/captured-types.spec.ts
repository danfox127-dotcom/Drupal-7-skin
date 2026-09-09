import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURED = path.join(__dirname, 'fixtures', 'captured');

/**
 * Every content type on the site, from captured markup.
 *
 * This is the file the project needed from the start. Every significant bug it has had
 * was a hand-authored fixture disagreeing with a real form — and the fixtures agreed with
 * the broken code, so nothing failed until someone hit it in production:
 *
 *   - Three fixtures each had ONE submit button, `edit-submit` = "Save". Every real form
 *     has `edit-submit` = "Save as draft" plus a separate `edit-submit-publish`. The old
 *     selector led with `#edit-submit`, so it looked right against every fixture while
 *     the extension saved a pending revision on every real Publish for months.
 *   - Fixtures had a plain `title`. Every real form uses the Title module's `title_field`.
 *   - A fixture invented `field_specialty_summary`, which exists nowhere.
 *   - One fixture's body class was just `logged-in`, so content-type detection could never
 *     run against it at all.
 *
 * These fixtures cannot drift that way: they came off the site. When the site changes,
 * re-capture and the diff is the changelog.
 *
 * Scrubbed by src/lib/captureFixture.ts and re-checked by scripts/check-capture.mjs
 * before committing. Field values are blank, security fields removed, usernames replaced.
 */

const TYPES = fs.readdirSync(CAPTURED)
  .filter(f => f.endsWith('.html'))
  .map(f => f.replace('.html', ''))
  .sort();

let bundle: string;

test.beforeAll(async () => {
  const entry = path.join(__dirname, 'fixtures', '.captured-entry.ts');
  fs.writeFileSync(entry, `
    export { discoverSchema } from '../../src/lib/formSchema';
    export { findTarget } from '../../src/lib/import/targets';
    export { submitForm, writeValue, readValue } from '../../src/lib/fieldBinding';
  `);
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true, write: false, format: 'iife', globalName: 'S',
    platform: 'browser', target: 'es2020',
  });
  bundle = built.outputFiles[0].text;
  fs.unlinkSync(entry);
});

async function load(page: import('@playwright/test').Page, type: string) {
  await page.goto('data:text/html,<body>host</body>');
  await page.setContent(fs.readFileSync(path.join(CAPTURED, `${type}.html`), 'utf8'));
  await page.addScriptTag({ content: bundle });
}

test('the captured set covers the whole site', () => {
  // A guard on the guard: if this directory empties, every test below silently passes.
  expect(TYPES.length, 'no captured fixtures found').toBeGreaterThanOrEqual(9);
});

for (const type of TYPES) {
  test.describe(`content type: ${type}`, () => {
    test('the form is found and its type detected', async ({ page }) => {
      await load(page, type);
      const out = await page.evaluate(t => {
        const s = (window as any).S.discoverSchema(document, { pathname: `/node/add/${t}` });
        return s ? { type: s.contentType, fields: s.fields.length } : null;
      }, type);

      expect(out, 'discoverSchema returned nothing — the extension does nothing here').not.toBeNull();
      expect(out!.type).toBe(type);
      expect(out!.fields).toBeGreaterThan(10);
    });

    test('Publish clicks the publish button, not the draft one', async ({ page }) => {
      // The bug that shipped. Worth asserting per type rather than once: a single content
      // type configured differently would reintroduce it silently.
      await load(page, type);
      const clicked = await page.evaluate(t => {
        const api = (window as any).S;
        const s = api.discoverSchema(document, { pathname: `/node/add/${t}` });
        const seen: string[] = [];
        s.form.addEventListener('submit', (e: Event) => e.preventDefault());
        s.form.querySelectorAll('input[type=submit]').forEach((b: HTMLInputElement) => {
          b.addEventListener('click', () => seen.push(b.id));
        });
        api.submitForm(s.form, { publish: true });
        api.submitForm(s.form, { publish: false });
        return seen;
      }, type);

      expect(clicked).toEqual(['edit-submit-publish', 'edit-submit']);
    });

    test('an import resolves Title, Summary and Body to real fields', async ({ page }) => {
      await load(page, type);
      const targets = await page.evaluate(t => {
        const api = (window as any).S;
        const s = api.discoverSchema(document, { pathname: `/node/add/${t}` });
        const of = (k: string) => api.findTarget(s, k)?.machineName ?? null;
        return { title: of('title'), summary: of('summary'), body: of('body') };
      }, type);

      // title_field, not title: the Title module is site-wide, which no fixture knew.
      expect(targets.title).toBe('title_field[und][0][value]');
      // field_summary, not core's body summary — which is present in the markup on some
      // types and folded out of the schema because the body carries a rich editor.
      expect(targets.summary).toBe('field_summary[und][0][value]');
      expect(targets.body).toBe('body[und][0][value]');
    });

    test('every field is claimed by a rule and carries a label', async ({ page }) => {
      /**
       * Two ways the overlay quietly loses a field: no rule claims it, so it falls into
       * [other] and reads as junk; or it has no label, so it renders as an unnamed box.
       * Both were true of invented fixtures and neither is true of any real form here.
       */
      await load(page, type);
      const problems = await page.evaluate(t => {
        const s = (window as any).S.discoverSchema(document, { pathname: `/node/add/${t}` });
        return {
          unclaimed: s.fields.filter((f: any) => f.section === 'other')
            .map((f: any) => f.machineName),
          unlabelled: s.fields.filter((f: any) => !f.label || !f.label.trim())
            .map((f: any) => f.machineName),
        };
      }, type);

      expect(problems.unclaimed).toEqual([]);
      expect(problems.unlabelled).toEqual([]);
    });
  });
}
