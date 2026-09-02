import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Which field an approved proposal actually lands in.
 *
 * This had no coverage because findTarget lived inside a React module. The Specialty form
 * carries THREE fields whose label is "Summary" — core's body summary, field_summary, and
 * field_specialty_summary — so "the first field labelled Summary" is a coin toss decided
 * by DOM order and by whether the body-summary fold happened to run.
 *
 * The site's answer is that the required one is the real summary; it is also what feeds the
 * page's meta description. Requiredness is a property Drupal publishes in the markup, so it
 * is a far better signal than a label three fields share.
 */

/**
 * Two fields labelled "Summary", the non-required one first. Drupal's own markup shape:
 * a .form-item wrapper, a <label for>, and <span class="form-required"> for the marker.
 */
const AMBIGUOUS = `<!DOCTYPE html>
<html><body class="node-type-specialty">
  <form id="specialty-node-form">
    <div class="form-item form-type-textfield">
      <label for="edit-title">Title <span class="form-required">*</span></label>
      <input type="text" id="edit-title" name="title" value="" class="form-text required" required="required" />
    </div>
    <div class="form-item form-type-textarea">
      <label for="edit-teaser">Summary</label>
      <textarea id="edit-teaser" name="field_teaser[und][0][value]" class="form-textarea"></textarea>
    </div>
    <div class="form-item form-type-textarea">
      <label for="edit-real-summary">Summary <span class="form-required">*</span></label>
      <textarea id="edit-real-summary" name="field_real_summary[und][0][value]" class="form-textarea required" required="required"></textarea>
    </div>
  </form>
</body></html>`;

/**
 * A Page form as it really is on vagelos.columbia.edu — Summary is a required node field
 * present on every content type, and the Metatags module adds a "Description" textarea
 * whose default is the token [node:summary].
 *
 * The metatags block below is verbatim from the live form. It matters because filling the
 * metatag field directly would be wrong: it derives from Summary, and overwriting the
 * token breaks that link. The summary proposal must land on Summary and nowhere else.
 */
const PAGE_WITH_METATAGS = `<!DOCTYPE html>
<html><body class="node-type-page">
  <form id="page-node-form">
    <div class="form-item form-type-textfield">
      <label for="edit-title">Title <span class="form-required">*</span></label>
      <input type="text" id="edit-title" name="title" value="" class="form-text required" required="required" />
    </div>
    <div class="form-item form-type-textfield">
      <label for="edit-subtitle">Subtitle</label>
      <input type="text" id="edit-subtitle" name="field_subtitle[und][0][value]" value="" class="form-text" />
    </div>
    <div class="form-item form-type-textarea">
      <label for="edit-summary">Summary <span class="form-required">*</span></label>
      <div class="form-textarea-wrapper resizable"><textarea id="edit-summary" name="field_summary[und][0][value]" class="form-textarea required" required="required" cols="60" rows="5"></textarea></div>
      <div class="description">Enter a short plain text description about this page. This summary text will be used when the page is featured on the site. This summary is also used as the default text for the page's metadata description used by external search engines and some social media sites.</div>
    </div>
    <input type="hidden" name="metatags[und][title][default]" value="[node:title]" />
    <div class="form-item form-type-textarea form-item-metatags-und-description-value">
      <label for="edit-metatags-und-description-value">Description </label>
     <div class="form-textarea-wrapper resizable"><textarea maxlength="380" class="maxlength form-textarea" id="edit-metatags-und-description-value" name="metatags[und][description][value]" cols="60" rows="2">[node:summary]</textarea></div>
    <div class="description">A brief and concise summary of the page's content that is a maximum of 160 characters in length.</div>
    </div>
    <input type="hidden" name="metatags[und][description][default]" value="[node:summary]" />
  </form>
</body></html>`;

let bundle: string;
let specialty: string;

test.beforeAll(async () => {
  const entry = path.join(__dirname, 'fixtures', '.targets-entry.ts');
  fs.writeFileSync(entry, `
    export { discoverSchema } from '../../src/lib/formSchema';
    export { findTarget } from '../../src/lib/import/targets';
  `);
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true, write: false, format: 'iife', globalName: 'Targets',
    platform: 'browser', target: 'es2020',
  });
  bundle = result.outputFiles[0].text;
  fs.unlinkSync(entry);

  specialty = fs.readFileSync(path.join(__dirname, 'fixtures', 'node-edit-specialty.html'), 'utf8');
});

/** Builds the schema from a fixture in the page, then resolves one proposal key. */
async function target(page: import('@playwright/test').Page, html: string, key: string) {
  await page.goto('data:text/html,<body>host</body>');
  await page.setContent(html);
  await page.addScriptTag({ content: bundle });
  return page.evaluate(([k]) => {
    const api = (window as any).Targets;
    // discoverSchema gates on the path, which a data: URL does not satisfy.
    const schema = api.discoverSchema(document, { pathname: '/node/17176/edit' });
    if (!schema) return { error: 'no schema' };
    const field = api.findTarget(schema, k);
    const candidates = schema.fields
      .filter((f: any) => /^summary$/.test(f.label.toLowerCase()))
      .map((f: any) => ({ baseName: f.baseName, required: f.required }));
    return field
      ? { baseName: field.baseName, required: field.required, candidates }
      : { error: 'no target', candidates };
  }, [key] as const);
}

test.describe('where an approved proposal lands', () => {
  test('the summary goes to the REQUIRED Summary field, not the first one', async ({ page }) => {
    const t = await target(page, specialty, 'summary');

    // Guard the guard: if the fixture stops having an ambiguity, this test proves nothing.
    expect(
      (t.candidates ?? []).length,
      'fixture must carry more than one field labelled Summary for this to mean anything'
    ).toBeGreaterThan(1);

    expect(t.error).toBeUndefined();
    expect(t.baseName).toBe('field_summary');
    expect(t.required).toBe(true);
  });

  test('the title still resolves, and is unaffected by the tiebreak', async ({ page }) => {
    const t = await target(page, specialty, 'title');
    expect(t.error).toBeUndefined();
    // Specialty runs the Title module, which replaces core's title with a real field —
    // hence title_field rather than title. Matching on the label is what survives that.
    expect(t.baseName).toBe('title_field');
  });

  /**
   * The case the Specialty fixture cannot prove.
   *
   * There, the required field happens to come first once the body-summary fold has run, so
   * "first match" and "required match" agree and the outcome is luck rather than a rule.
   * Here they DISAGREE: the non-required Summary is first in the DOM. Anything picking by
   * document order lands on field_teaser.
   */
  test('a non-required Summary earlier in the form does not win', async ({ page }) => {
    const t = await target(page, AMBIGUOUS, 'summary');

    expect(
      (t.candidates ?? []).length,
      'fixture must carry more than one field labelled Summary'
    ).toBeGreaterThan(1);
    expect((t.candidates ?? [])[0]?.baseName,
      'the non-required one must come FIRST or this proves nothing').toBe('field_teaser');

    expect(t.baseName).toBe('field_real_summary');
    expect(t.required).toBe(true);
  });
  test('the summary lands on the required Summary field, not the metatag Description', async ({ page }) => {
    const t = await target(page, PAGE_WITH_METATAGS, 'summary');
    expect(t.error).toBeUndefined();
    expect(t.baseName).toBe('field_summary');
    expect(t.required).toBe(true);
  });

  test('nothing routes a proposal into the metatags Description field', async ({ page }) => {
    // It defaults to [node:summary]. Writing a literal value there severs the token, so no
    // proposal key may ever resolve to it.
    for (const key of ['summary', 'title', 'subtitle', 'body', 'byline', 'date']) {
      const t = await target(page, PAGE_WITH_METATAGS, key);
      expect(t.baseName, `${key} must not target the metatag field`).not.toBe('metatags');
    }
  });
});
