import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Turning a live form into a committable fixture.
 *
 * Every significant bug this project has had came from a fixture that did not match the
 * real markup — a missing publish button, a form Drupal re-renders, three fields sharing
 * a label. Hand-authoring them is the root cause, so this captures the real thing.
 *
 * Which makes the scrubbing the whole risk. The output is meant to be committed to a
 * PUBLIC repository, and a live Drupal admin form carries a session CSRF token, a cached
 * form-build id, the editor's username, and the page's unpublished body text. A capture
 * tool that leaks any of those is worse than hand-authored fixtures.
 */

let bundle: string;

test.beforeAll(async () => {
  const entry = path.join(__dirname, 'fixtures', '.capture-entry.ts');
  fs.writeFileSync(entry, `
    export { captureFixture } from '../../src/lib/captureFixture';
  `);
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true, write: false, format: 'iife', globalName: 'Capture',
    platform: 'browser', target: 'es2020',
  });
  bundle = built.outputFiles[0].text;
  fs.unlinkSync(entry);
});

/**
 * A form carrying every category of thing that must not be committed, in the shapes
 * Drupal actually renders them.
 */
const LIVE_FORM = `<!DOCTYPE html>
<html><head><title>Edit Page | Vagelos</title></head>
<body class="node-type-page logged-in page-node-edit">
  <div id="toolbar"><span class="username">ab1234</span></div>
  <form id="page-node-form" action="/node/26981/edit" method="post" accept-charset="UTF-8">
    <div class="form-item form-type-textfield">
      <label for="edit-title">Title <span class="form-required">*</span></label>
      <input type="text" id="edit-title" name="title" value="Unannounced Reorganisation Memo" class="form-text required" required="required" />
    </div>

    <div class="form-item form-type-textarea">
      <label for="edit-body">Body</label>
      <textarea id="edit-body" name="body[und][0][value]" class="form-textarea">Confidential draft text that has not been published.</textarea>
    </div>

    <div class="form-item form-type-textfield">
      <label for="edit-name">Authored by</label>
      <input type="text" id="edit-name" name="name" value="ab1234" class="form-text form-autocomplete" />
    </div>

    <div class="form-item form-type-select">
      <label for="edit-menu-parent">Parent item</label>
      <select id="edit-menu-parent" name="menu[parent]">
        <option value="main-menu:0">&lt;Main menu&gt;</option>
        <option value="main-menu:100" selected="selected">-Gharavi Lab</option>
        <option value="main-menu:101">--Calculators</option>
      </select>
    </div>

    <div class="form-item form-type-checkbox">
      <input type="checkbox" id="edit-menu-enabled" name="menu[enabled]" value="1" checked="checked" class="form-checkbox" />
      <label for="edit-menu-enabled">Provide a menu link</label>
    </div>

    <input type="hidden" name="changed" value="1788537071" />
    <input type="hidden" name="form_build_id" value="form-8Kd93jXmQpLzR4tVnB2wYcHs7fGaE1oU" />
    <input type="hidden" name="form_token" value="aQ7pR2mNvK9xLtB4wYcHs3fGaE1oUzJd5" />
    <input type="hidden" name="form_id" value="page_node_form" />
    <input type="hidden" name="honeypot_time" value="1788537071|xYzAbC" />

    <script>CKEDITOR.replace('edit-body', {"token":"INFORM_SECRET"});</script>

    <div class="form-actions">
      <input type="submit" id="edit-submit" name="op" value="Save as draft" class="form-submit" />
      <input type="submit" id="edit-submit-publish" name="op" value="Save and publish" class="form-submit" />
    </div>
  </form>
  <script>Drupal.settings = {"ajaxPageState":{"token":"SECRET"},"user":{"uid":"4471"}};</script>
</body></html>`;

/** 600 options across 5 depths, in Drupal's leading-hyphen encoding. */
function bigMenuForm(): string {
  const options: string[] = ['<option value="main-menu:0">&lt;Main menu&gt;</option>'];
  let id = 100;
  for (let top = 0; top < 20; top++) {
    options.push(`<option value="main-menu:${id++}">-Section ${top}</option>`);
    for (let mid = 0; mid < 5; mid++) {
      options.push(`<option value="main-menu:${id++}">--Area ${top}.${mid}</option>`);
      for (let leaf = 0; leaf < 5; leaf++) {
        options.push(`<option value="main-menu:${id++}">---Page ${top}.${mid}.${leaf}</option>`);
      }
    }
  }
  return `<!DOCTYPE html><html><body class="node-type-page">
    <form id="page-node-form">
      <div class="form-item"><label for="edit-title">Title</label>
      <input type="text" id="edit-title" name="title" value="" /></div>
      <div class="form-item"><label for="edit-menu-parent">Parent item</label>
      <select id="edit-menu-parent" name="menu[parent]">${options.join('')}</select></div>
    </form></body></html>`;
}

async function capture(
  page: import('@playwright/test').Page,
  html = LIVE_FORM,
  keepValues = false,
) {
  await page.goto('data:text/html,<body>host</body>');
  await page.setContent(html);
  await page.addScriptTag({ content: bundle });
  return page.evaluate(keep => {
    const api = (window as any).Capture;
    return api.captureFixture(document, {
      sourceUrl: 'https://vagelos.columbia.edu/node/26981/edit',
      capturedOn: '2026-09-04',
      keepValues: keep,
    });
  }, keepValues);
}

test.describe('what must never be committed', () => {
  test('the CSRF token and form build id are gone entirely', async ({ page }) => {
    const result = await capture(page);
    /*
      The INPUTS are gone, not merely blanked — a committed name=form_token is an
      invitation to fill it in. The names still appear once, in the provenance comment
      that tells a reviewer what was stripped; that is the point of it, so these check
      for the element and for the secret values rather than the bare string.
    */
    expect(result.html).not.toContain('name="form_token"');
    expect(result.html).not.toContain('name="form_build_id"');
    expect(result.html).not.toContain('aQ7pR2mNvK9xLtB4wYcHs3fGaE1oUzJd5');
    expect(result.html).not.toContain('form-8Kd93jXmQpLzR4tVnB2wYcHs7fGaE1oU');
    expect(result.report.removedFields).toContain('form_token');
    expect(result.report.removedFields).toContain('form_build_id');
  });

  test('the honeypot field is gone', async ({ page }) => {
    const result = await capture(page);
    expect(result.html).not.toContain('name="honeypot_time"');
    expect(result.html).not.toContain('xYzAbC');
  });

  test('page content is blanked, not committed', async ({ page }) => {
    // The body of an unpublished node is the single most sensitive thing on the form.
    const result = await capture(page);
    expect(result.html).not.toContain('Confidential draft text');
    expect(result.html).not.toContain('Unannounced Reorganisation Memo');
    expect(result.report.blankedValues).toBeGreaterThan(0);
  });

  test('the editor username is replaced, everywhere it appears', async ({ page }) => {
    const result = await capture(page);
    expect(result.html).not.toContain('ab1234');
    expect(result.report.anonymisedFields).toContain('name');
  });

  test('scripts inside the form are dropped, tokens and all', async ({ page }) => {
    // Drupal renders inline scripts within forms — CKEditor init, #states wiring — and
    // they carry tokens. These ARE in the captured region, so they must be removed.
    const result = await capture(page);
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('INFORM_SECRET');
    expect(result.report.scriptsRemoved).toBeGreaterThan(0);
  });

  test('Drupal.settings outside the form is never captured in the first place', async ({ page }) => {
    /*
      This passes by construction, not by scrubbing: only the form is cloned, and
      Drupal.settings sits beside it. Worth pinning anyway — it is where the ajaxPageState
      token and the user's uid live, and a later change that captured a wider region would
      start including it with nothing to catch that.
    */
    const result = await capture(page);
    expect(result.html).not.toContain('ajaxPageState');
    expect(result.html).not.toContain('SECRET');
  });
});

test.describe('what must survive, or the fixture is useless', () => {
  test('both save buttons keep their labels', async ({ page }) => {
    // Exactly what the Publish bug needed and no fixture had.
    const result = await capture(page);
    expect(result.html).toContain('Save as draft');
    expect(result.html).toContain('Save and publish');
    expect(result.html).toContain('edit-submit-publish');
  });

  test('field names, ids, labels and required markers survive', async ({ page }) => {
    const result = await capture(page);
    expect(result.html).toContain('name="title"');
    expect(result.html).toContain('name="body[und][0][value]"');
    expect(result.html).toContain('for="edit-title"');
    expect(result.html).toContain('form-required');
    expect(result.html).toContain('Provide a menu link');
  });

  test('select options survive, values included', async ({ page }) => {
    // Option values ARE the structure — menu[parent] is unusable without them.
    const result = await capture(page);
    expect(result.html).toContain('main-menu:101');
    expect(result.html).toContain('Calculators');
  });

  test('checked and selected states survive', async ({ page }) => {
    const result = await capture(page);
    expect(result.html).toMatch(/id="edit-menu-enabled"[^>]*checked/);
    expect(result.html).toMatch(/main-menu:100"[^>]*selected/);
  });

  test('the body class survives, since content type is read from it', async ({ page }) => {
    const result = await capture(page);
    expect(result.html).toContain('node-type-page');
  });

  test('the output is a standalone document with provenance', async ({ page }) => {
    const result = await capture(page);
    expect(result.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(result.html).toContain('vagelos.columbia.edu/node/26981/edit');
    expect(result.html).toContain('2026-09-04');
    // The report belongs in the file too, so a reviewer sees what was stripped without
    // having to diff it against a form they can no longer see.
    expect(result.html).toContain('Removed:');
    expect(result.html).toContain('form_token');
  });
});

test.describe('when there is nothing to capture', () => {
  test('a page with no node form returns null', async ({ page }) => {
    const result = await capture(page, '<html><body><p>Not a node form.</p></body></html>');
    expect(result).toBeNull();
  });
});

test.describe('keeping page text, on purpose', () => {
  /**
   * Opt-in, because blanking everything means hand-typing content back whenever a bug
   * needs realistic text — and hand-editing a captured fixture is the manual work this
   * tool exists to remove.
   *
   * What must NOT relax with it: credentials and personal data.
   */
  test('page text survives when asked for', async ({ page }) => {
    const result = await capture(page, LIVE_FORM, true);
    expect(result.html).toContain('Confidential draft text');
    expect(result.html).toContain('Unannounced Reorganisation Memo');
    expect(result.report.valuesKept).toBe(true);
    expect(result.report.blankedValues).toBe(0);
  });

  test('security fields are still removed, keepValues or not', async ({ page }) => {
    const result = await capture(page, LIVE_FORM, true);
    expect(result.html).not.toContain('name="form_token"');
    expect(result.html).not.toContain('name="form_build_id"');
    expect(result.html).not.toContain('aQ7pR2mNvK9xLtB4wYcHs3fGaE1oUzJd5');
    expect(result.html).not.toContain('name="honeypot_time"');
  });

  test('the username is still replaced, keepValues or not', async ({ page }) => {
    // Page copy is one thing; whose account edited it is another.
    const result = await capture(page, LIVE_FORM, true);
    expect(result.html).not.toContain('ab1234');
    expect(result.report.anonymisedFields).toContain('name');
  });

  test('in-form scripts are still dropped, keepValues or not', async ({ page }) => {
    const result = await capture(page, LIVE_FORM, true);
    expect(result.html).not.toContain('INFORM_SECRET');
    expect(result.html).not.toContain('<script');
  });

  test('the file says loudly that text was kept', async ({ page }) => {
    // The reviewer is the only remaining check, and published text and an unpublished
    // draft are indistinguishable from here.
    const result = await capture(page, LIVE_FORM, true);
    expect(result.html).toContain('PAGE TEXT WAS KEPT');
    expect(result.html).toContain('unpublished draft is not');
  });

  test('the default is still to blank', async ({ page }) => {
    const result = await capture(page);
    expect(result.report.valuesKept).toBe(false);
    expect(result.html).not.toContain('PAGE TEXT WAS KEPT');
  });
});

test.describe('trimming huge option lists', () => {
  /**
   * The menu parent select is the same 3,333 options on every content type, and 77% of a
   * capture's bytes. Capturing every type whole would commit that list once per type.
   *
   * Trimming must not become a plain truncation: the first N options are one branch of the
   * tree, and the menu tests read depth, ancestor chains and indentation.
   */
  async function bigCapture(page: import('@playwright/test').Page, trim: boolean) {
    await page.goto('data:text/html,<body>host</body>');
    await page.setContent(bigMenuForm());
    await page.addScriptTag({ content: bundle });
    return page.evaluate(t => (window as any).Capture.captureFixture(document, {
      sourceUrl: 'https://vagelos.columbia.edu/node/add/page',
      capturedOn: '2026-09-04',
      trimLargeSelects: t,
    }), trim);
  }

  test('untrimmed keeps every option', async ({ page }) => {
    const r = await bigCapture(page, false);
    expect(r.report.largeSelects[0].options).toBe(621);
    expect(r.report.largeSelects[0].kept).toBeUndefined();
    expect((r.html.match(/<option/g) ?? []).length).toBe(621);
  });

  test('trimmed keeps a sample from EVERY depth, not the first N', async ({ page }) => {
    const r = await bigCapture(page, true);
    const kept = r.report.largeSelects[0].kept as number;
    expect(kept).toBeLessThan(621);
    expect(kept).toBeGreaterThan(0);

    const labels = [...r.html.matchAll(/<option[^>]*>([^<]*)</g)].map(m => m[1].trim());
    const depths = new Set(labels.map(l => (/^(-+)/.exec(l)?.[1].length ?? 0)));
    expect([...depths].sort()).toEqual([0, 1, 2, 3]);

    /**
     * BREADTH is the assertion that discriminates.
     *
     * A first version checked only that all four depths survived, and it passed with
     * first-N truncation restored: the first six options in tree order are
     * "<Main menu>", "-Section 0", "--Area 0.0", "---Page 0.0.0"… which spans every
     * depth by accident. First-N gives ONE branch; per-depth sampling gives siblings at
     * each level, and siblings are what the ancestor-chain and deep-selection tests read.
     */
    const sections = new Set(labels.filter(l => /^-[^-]/.test(l)));
    expect(sections.size, 'several top-level sections, not just the first').toBeGreaterThan(1);
    const areas = new Set(labels.filter(l => /^--[^-]/.test(l)));
    expect(areas.size, 'several areas, not just one branch').toBeGreaterThan(1);
  });

  test('the selected option is never trimmed away', async ({ page }) => {
    // Dropping the current value would change what the form says it holds.
    await page.goto('data:text/html,<body>host</body>');
    await page.setContent(bigMenuForm().replace(
      '<option value="main-menu:600">', '<option selected="selected" value="main-menu:600">'));
    await page.addScriptTag({ content: bundle });
    const r = await page.evaluate(() => (window as any).Capture.captureFixture(document, {
      sourceUrl: 'https://vagelos.columbia.edu/node/add/page',
      capturedOn: '2026-09-04',
      trimLargeSelects: true,
    }));
    expect(r.html).toContain('main-menu:600');
  });

  test('the file says what was trimmed', async ({ page }) => {
    const r = await bigCapture(page, true);
    expect(r.html).toContain('TRIMMED');
    expect(r.html).toMatch(/menu\[parent\]: \d+ of 621 options kept/);
  });

  test('the content type names the file, from the URL when the body class does not', async ({ page }) => {
    // On /node/add/page the body class is page-node-add-page, not node-type-page. Naming
    // by body class alone made every capture "form", which in a batch overwrites the last.
    await page.goto('data:text/html,<body>host</body>');
    await page.setContent(bigMenuForm().replace('class="node-type-page"', 'class="page-node-add page-node-add-page"'));
    await page.addScriptTag({ content: bundle });
    const r = await page.evaluate(() => (window as any).Capture.captureFixture(document, {
      sourceUrl: 'https://vagelos.columbia.edu/node/add/specialty',
      capturedOn: '2026-09-04',
    }));
    expect(r.report.contentType).toBe('specialty');
  });
});
