import { test, expect, type Page } from '@playwright/test';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * Which rows a Varys draft offers on a new page, the Overview box, and the Undo records for
 * the title, Summary and body.
 *
 * Every test needs real controls, so each runs bundled in a page against a real <form> read
 * by discoverSchema(), as varys-suggestion-fill.spec.ts does. Nothing here reaches the
 * extension or Varys: this is the pure module underneath the draft panel.
 */

let bundle: string;

test.beforeAll(async () => {
  const result = await esbuild.build({
    stdin: {
      contents: `export * from './src/lib/varys/draftFill';
                 export * from './src/lib/varys/suggestionFill';
                 export * from './src/lib/fieldBinding';
                 export * from './src/lib/formSchema/index';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true, write: false, format: 'iife', globalName: 'Fill',
    platform: 'browser', target: 'es2020',
  });
  bundle = result.outputFiles[0].text;
});

/**
 * `form(values)` builds a real node form holding those named controls and returns what
 * discoverSchema() reads from it. A boolean value is a checkbox (path[pathauto]); a name
 * holding "description", "summary" or "body" is a textarea; anything else is a text input.
 * Names in `disabled` are rendered disabled, as Drupal renders the alias box while pathauto
 * is ticked. `ready(overrides)` is a ready draft with every row's value set.
 */
const HELPER = `
window.form = function (values, disabled = []) {
  document.body.replaceChildren();
  const form = document.createElement('form');
  form.className = 'node-form';
  for (const [name, value] of Object.entries(values)) {
    const item = document.createElement('div');
    item.className = 'form-item';
    let el;
    if (typeof value === 'boolean') {
      el = document.createElement('input');
      el.type = 'checkbox';
      el.checked = value;
    } else if (/description|summary|body/.test(name)) {
      el = document.createElement('textarea');
      el.value = value;
    } else {
      el = document.createElement('input');
      el.type = 'text';
      el.value = value;
    }
    el.name = name;
    el.disabled = disabled.includes(name);
    item.appendChild(el);
    form.appendChild(item);
  }
  document.body.appendChild(form);
  return window.Fill.discoverSchema(document, { pathname: '/node/add/news' }).fields;
};
window.ready = function (overrides = {}) {
  return {
    status: 'ready',
    id: 'd1',
    title: 'Why your knee clicks',
    label: 'knee-draft.docx',
    made_at: '2026-10-23T12:00:00Z',
    body_html: '<p>Body text.</p>',
    overview_bullets: ['First point', 'Second point'],
    summary: 'A short summary.',
    meta_title: 'Why your knee clicks',
    doctors: [{ name: 'Jane Doe', status: 'matched', full_name: 'Jane Doe, MD', source: 'quoted', exact: true }],
    dropped: { tables: 0, images: 0 },
    counts: { words: 1234, headings: 3, lists: 1, links: 2 },
    ...overrides,
  };
};
`;

/** Every field a new News page carries that a draft can fill. */
const FULL_FORM = {
  'title_field[und][0][value]': '',
  'body[und][0][value]': '',
  'field_summary[und][0][value]': '',
  'metatags[und][title][value]': '[node:title] | [site:name]',
  'field_cola_cups_profiles[und][0][target_id]': '',
  'path[alias]': '',
  'path[pathauto]': true,
};

/** A CUIMC-like form: no Summary, no Related Profiles. */
const CUIMC_FORM = {
  'title_field[und][0][value]': '',
  'body[und][0][value]': '',
  'metatags[und][title][value]': '[node:title] | [site:name]',
};

/** A blank page with the module and the form helper loaded. */
async function ready(page: Page) {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: HELPER });
}

type Api = any;
type Form = (values: Record<string, string | boolean>, disabled?: string[]) => any[];
type Ready = (overrides?: Record<string, unknown>) => any;

/** Runs `fn` in the page with the module's API, the form helper and the draft helper in hand. */
function run<T>(page: Page, fn: (api: Api, form: Form, ready: Ready) => T) {
  // A string is evaluated as an expression in the page, so `fn` runs there with the module's
  // API and the helpers as its arguments.
  return page.evaluate(`(${fn.toString()})(window.Fill, window.form, window.ready)`) as Promise<T>;
}

test.beforeEach(async ({ page }) => ready(page));

const CALLOUT_1000 = '<aside aria-labelledby="ck-callout--1000" class="ck-callout ck-callout--background-sky ck-callout--center"><h2 class="ck-callout__title" id="ck-callout--1000">Overview</h2><div class="ck-callout__content"><ul><li>A</li><li>B</li></ul></div></aside>';
const CALLOUT_1001 = '<aside aria-labelledby="ck-callout--1001" class="ck-callout ck-callout--background-sky ck-callout--center"><h2 class="ck-callout__title" id="ck-callout--1001">Overview</h2><div class="ck-callout__content"><ul><li>A</li><li>B</li></ul></div></aside>';

// ------------------------------------------------------------------ the Overview box

test.describe('overviewBoxHtml', () => {
  test('overview uses the site callout with an unused id', async ({ page }) => {
    expect(await run(page, A => A.overviewBoxHtml(['A', 'B'], '<aside aria-labelledby="ck-callout--1000"></aside>', true)))
      .toBe(CALLOUT_1001);
  });

  test('overview falls back to a plain heading when the editor would strip the callout', async ({ page }) => {
    expect(await run(page, A => A.overviewBoxHtml(['A & B'], '', false)))
      .toBe('<h2>Overview</h2><ul><li>A &amp; B</li></ul>');
  });

  test('the first id is 1000 when the body has no callout', async ({ page }) => {
    const html = await run(page, A => A.overviewBoxHtml(['A'], '<p>Plain.</p>', true));
    expect(html).toContain('aria-labelledby="ck-callout--1000"');
    expect(html).toContain('id="ck-callout--1000"');
  });

  test('the id is the smallest unused one from 1000, counting ids and aria-labelledby alike', async ({ page }) => {
    // 1000 is taken by an id, 1001 only by an aria-labelledby, 1003 by an id: 1002 is free.
    const body = '<h2 id="ck-callout--1000">x</h2><p aria-labelledby="ck-callout--1001"></p><h2 id="ck-callout--1003">y</h2>';
    const out = await page.evaluate(
      (b) => (window as any).Fill.overviewBoxHtml(['A'], b, true), body);
    expect(out).toContain('id="ck-callout--1002"');
  });

  test('an aria-labelledby that lists several ids counts each of them', async ({ page }) => {
    const body = '<section aria-labelledby="intro ck-callout--1000 ck-callout--1001"></section>';
    const out = await page.evaluate(
      (b) => (window as any).Fill.overviewBoxHtml(['A'], b, true), body);
    expect(out).toContain('id="ck-callout--1002"');
  });

  test('ids below 1000 and non-numeric ones do not count', async ({ page }) => {
    const body = '<h2 id="ck-callout--5">x</h2><h2 id="ck-callout--abc">y</h2><p id="other-1000"></p>';
    const out = await page.evaluate(
      (b) => (window as any).Fill.overviewBoxHtml(['A'], b, true), body);
    expect(out).toContain('id="ck-callout--1000"');
  });

  test('every bullet is escaped, whichever markup is used', async ({ page }) => {
    const bullet = `<b>"Tom" & 'Jerry'</b>`;
    const escaped = '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;';
    const out = await page.evaluate((b) => ({
      callout: (window as any).Fill.overviewBoxHtml([b], '', true),
      plain: (window as any).Fill.overviewBoxHtml([b], '', false),
    }), bullet);
    expect(out.callout).toContain(`<li>${escaped}</li>`);
    expect(out.plain).toBe(`<h2>Overview</h2><ul><li>${escaped}</li></ul>`);
  });

  test('no bullets means no box at all, in either form', async ({ page }) => {
    expect(await run(page, A => [
      A.overviewBoxHtml([], '<p>x</p>', true),
      A.overviewBoxHtml([], '<p>x</p>', false),
    ])).toEqual(['', '']);
  });
});

test.describe('bodyToFill', () => {
  test('no bullets means no overview box', async ({ page }) => {
    expect(await run(page, (A, _f, ready) => {
      const draft = ready({ overview_bullets: [] });
      return A.bodyToFill(draft, true) === draft.body_html;
    })).toBe(true);
  });

  test('the box comes first and the draft follows it directly', async ({ page }) => {
    expect(await run(page, (A, _f, ready) => A.bodyToFill(ready({ overview_bullets: ['A', 'B'], body_html: '<p>Body.</p>' }), true)))
      .toBe(CALLOUT_1000 + '<p>Body.</p>');
  });

  test('the box id is chosen against the draft body, not the form', async ({ page }) => {
    const out = await run(page, (A, _f, ready) => A.bodyToFill(ready({
      overview_bullets: ['A', 'B'],
      body_html: '<aside aria-labelledby="ck-callout--1000"></aside>',
    }), true));
    expect(out.startsWith('<aside aria-labelledby="ck-callout--1001"')).toBe(true);
    expect(out.endsWith('<aside aria-labelledby="ck-callout--1000"></aside>')).toBe(true);
  });

  test('the fallback is the plain heading and list, then the draft', async ({ page }) => {
    expect(await run(page, (A, _f, ready) => A.bodyToFill(ready({ overview_bullets: ['A'], body_html: '<p>Body.</p>' }), false)))
      .toBe('<h2>Overview</h2><ul><li>A</li></ul><p>Body.</p>');
  });
});

// ------------------------------------------------------------------ which rows exist

test.describe('planDraftFill', () => {
  test('a full form offers five rows in order, each available', async ({ page }) => {
    const rows = await run(page, (A, form, ready) => A.planDraftFill(ready(), form({
      'title_field[und][0][value]': '',
      'body[und][0][value]': '',
      'field_summary[und][0][value]': '',
      'metatags[und][title][value]': '',
      'field_cola_cups_profiles[und][0][target_id]': '',
    })));
    expect(rows.map((r: any) => [r.kind, r.label, r.available])).toEqual([
      ['title', 'Title', true],
      ['body', 'Body', true],
      ['summary', 'Summary', true],
      ['meta_title', 'Search result title', true],
      ['profiles', 'Related Profiles', true],
    ]);
    expect(rows[0].preview).toBe('Why your knee clicks');
    expect(rows[2].preview).toBe('A short summary.');
    expect(rows[2].note).toBeNull();
  });

  test('rows are hidden for fields the form lacks', async ({ page }) => {
    // A CUIMC-like form: no Summary and no Related Profiles.
    const rows = await run(page, (A, form, ready) => A.planDraftFill(ready(), form({
      'title_field[und][0][value]': '',
      'body[und][0][value]': '',
      'metatags[und][title][value]': '',
    })));
    const by = Object.fromEntries(rows.map((r: any) => [r.kind, r.available]));
    expect(by).toEqual({ title: true, body: true, summary: false, meta_title: true, profiles: false });
    expect(rows.map((r: any) => r.kind)).toEqual(['title', 'body', 'summary', 'meta_title', 'profiles']);
  });

  test('the Summary row is hidden when the form has no Summary field', async ({ page }) => {
    const rows = await run(page, (A, form, ready) => A.planDraftFill(ready({ summary: 'There is one in the draft.' }), form({
      'title_field[und][0][value]': '',
      'body[und][0][value]': '',
      'field_cola_cups_profiles[und][0][target_id]': '',
    })));
    const summary = rows.find((r: any) => r.kind === 'summary');
    expect(summary.available).toBe(false);
    expect(summary.note).toBeNull();
  });

  test('a form with no body field hides the Body row', async ({ page }) => {
    const rows = await run(page, (A, form, ready) => A.planDraftFill(ready(), form({
      'title_field[und][0][value]': '',
    })));
    expect(rows.find((r: any) => r.kind === 'body').available).toBe(false);
  });

  test('the Title row is not offered when the draft has no confirmed title', async ({ page }) => {
    const rows = await run(page, (A, form, ready) => A.planDraftFill(
      ready({ title: null, label: 'knee-draft.docx' }), form({ 'title_field[und][0][value]': '', 'body[und][0][value]': '' })));
    const title = rows.find((r: any) => r.kind === 'title');
    expect(title.available).toBe(false);
    // The file name the draft was listed under is never offered as the Title.
    expect(title.preview).not.toContain('knee-draft');
  });

  test('the Title row also works on an older form whose title is called "title"', async ({ page }) => {
    const rows = await run(page, (A, form, ready) => A.planDraftFill(ready(), form({ title: '', 'body[und][0][value]': '' })));
    expect(rows.find((r: any) => r.kind === 'title').available).toBe(true);
  });

  test('a draft with no summary or no search title leaves those rows hidden', async ({ page }) => {
    const rows = await run(page, (A, form, ready) => A.planDraftFill(
      ready({ summary: null, meta_title: null }), form({
        'title_field[und][0][value]': '',
        'body[und][0][value]': '',
        'field_summary[und][0][value]': '',
        'metatags[und][title][value]': '',
      })));
    const by = Object.fromEntries(rows.map((r: any) => [r.kind, r.available]));
    expect(by.summary).toBe(false);
    expect(by.meta_title).toBe(false);
    expect(by.title).toBe(true);
    expect(by.body).toBe(true);
  });

  test('a summary over 380 characters is shown but not fillable', async ({ page }) => {
    const rows = await run(page, (A, form, ready) => A.planDraftFill(
      ready({ summary: 'x'.repeat(381) }), form({ 'field_summary[und][0][value]': '' })));
    const summary = rows.find((r: any) => r.kind === 'summary');
    expect(summary.available).toBe(true);
    expect(summary.note).toBe('Too long for Summary (381 characters; the limit is 380).');
  });

  test('a summary of exactly 380 characters is fine', async ({ page }) => {
    const rows = await run(page, (A, form, ready) => A.planDraftFill(
      ready({ summary: 'x'.repeat(380) }), form({ 'field_summary[und][0][value]': '' })));
    const summary = rows.find((r: any) => r.kind === 'summary');
    expect(summary.available).toBe(true);
    expect(summary.note).toBeNull();
  });

  test('the search title row shows what Use writes, with the field\'s token tail kept', async ({ page }) => {
    const rows = await run(page, (A, form, ready) => A.planDraftFill(
      ready({ meta_title: 'Why your knee clicks' }), form({ 'metatags[und][title][value]': '[node:title] | [site:name]' })));
    expect(rows.find((r: any) => r.kind === 'meta_title').preview).toBe('Why your knee clicks | [site:name]');
  });

  test('Related Profiles needs the field and at least one doctor', async ({ page }) => {
    const out = await run(page, (A, form, ready) => {
      const withField = form({ 'field_cola_cups_profiles[und][0][target_id]': '' });
      const kind = (rows: any[]) => rows.find(r => r.kind === 'profiles');
      const some = kind(A.planDraftFill(ready(), withField));
      const none = kind(A.planDraftFill(ready({ doctors: [] }), withField));
      const noField = kind(A.planDraftFill(ready(), form({ 'title_field[und][0][value]': '' })));
      return { some, none, noField };
    });
    expect(out.some.available).toBe(true);
    expect(out.some.note).toBeNull();
    expect(out.none.available).toBe(false);
    expect(out.noField.available).toBe(false);
  });

  test('a draft whose doctors Varys could not check keeps the row and says so', async ({ page }) => {
    const out = await run(page, (A, form, ready) => {
      const rows = A.planDraftFill(ready({ doctors: null }), form({ 'field_cola_cups_profiles[und][0][target_id]': '' }));
      const noField = A.planDraftFill(ready({ doctors: null }), form({ 'title_field[und][0][value]': '' }));
      return { row: rows.find((r: any) => r.kind === 'profiles'), noField: noField.find((r: any) => r.kind === 'profiles') };
    });
    expect(out.row.available).toBe(true);
    expect(out.row.note).toBe("Varys couldn't check the quoted doctors.");
    expect(out.noField.available).toBe(false);
  });

  test('planning reads the form and writes nothing to it', async ({ page }) => {
    const after = await run(page, (A, form, ready) => {
      const fields = form({ 'title_field[und][0][value]': 'Mine', 'body[und][0][value]': '<p>mine</p>', 'field_summary[und][0][value]': 'Mine too' });
      A.planDraftFill(ready(), fields);
      return fields.map((f: any) => A.readValue(f));
    });
    expect(after).toEqual(['Mine', '<p>mine</p>', 'Mine too']);
  });

  test('the body row says what will be written', async ({ page }) => {
    const rows = await run(page, (A, form, ready) => [
      A.planDraftFill(ready(), form({ 'body[und][0][value]': '' })).find((r: any) => r.kind === 'body').preview,
      A.planDraftFill(ready({ overview_bullets: [], counts: { words: 1, headings: 1, lists: 0, links: 0 } }), form({ 'body[und][0][value]': '' }))
        .find((r: any) => r.kind === 'body').preview,
    ]);
    expect(rows[0]).toBe('Overview box (2 points), then the draft: 1,234 words · 3 headings · 1 list · 2 links');
    expect(rows[1]).toBe('The draft: 1 word · 1 heading · 0 lists · 0 links');
  });
});

// ------------------------------------------------------------------ title and Summary

test.describe('fillText and undoText', () => {
  test('fills the field and records what Undo needs', async ({ page }) => {
    const out = await run(page, (A, form) => {
      const fields = form({ 'title_field[und][0][value]': 'Old title' });
      const f = A.findField(fields, 'title_field[und][0][value]');
      const record = A.fillText(f, 'New title');
      return { record, now: A.readValue(f) };
    });
    expect(out.record).toEqual({ machineName: 'title_field[und][0][value]', previous: 'Old title', filled: 'New title' });
    expect(out.now).toBe('New title');
  });

  test('undo puts the old text back while the field still holds what was filled', async ({ page }) => {
    const out = await run(page, (A, form) => {
      const fields = form({ 'field_summary[und][0][value]': 'Before' });
      const f = A.findField(fields, 'field_summary[und][0][value]');
      const record = A.fillText(f, 'From the draft');
      const could = A.canUndoText(record, fields);
      const undone = A.undoText(record, fields);
      return { could, undone, now: A.readValue(f) };
    });
    expect(out).toEqual({ could: true, undone: true, now: 'Before' });
  });

  test('title undo is withdrawn once the person typed in the field', async ({ page }) => {
    const out = await run(page, (A, form) => {
      const fields = form({ 'title_field[und][0][value]': '' });
      const f = A.findField(fields, 'title_field[und][0][value]');
      const record = A.fillText(f, 'From the draft');
      (f.elements[0] as HTMLInputElement).value = 'From the draft, and then I typed';
      const could = A.canUndoText(record, fields);
      const undone = A.undoText(record, fields);
      return { could, undone, now: A.readValue(f) };
    });
    expect(out).toEqual({ could: false, undone: false, now: 'From the draft, and then I typed' });
  });

  test('filling the title never touches the alias or pathauto', async ({ page }) => {
    const out = await run(page, (A, form) => {
      const fields = form({
        'title_field[und][0][value]': '',
        'path[alias]': 'news/existing-alias',
        'path[pathauto]': true,
      }, ['path[alias]']);
      const alias = A.findField(fields, 'path[alias]');
      const pathauto = A.findField(fields, 'path[pathauto]');
      const before = [A.readValue(alias), A.readValue(pathauto), (alias.elements[0] as HTMLInputElement).disabled];
      const record = A.fillText(A.titleField(fields), 'A brand new title');
      const during = [A.readValue(alias), A.readValue(pathauto), (alias.elements[0] as HTMLInputElement).disabled];
      A.undoText(record, fields);
      const after = [A.readValue(alias), A.readValue(pathauto), (alias.elements[0] as HTMLInputElement).disabled];
      return { before, during, after, filled: record && record.filled };
    });
    expect(out.filled).toBe('A brand new title');
    expect(out.before).toEqual(['news/existing-alias', true, true]);
    expect(out.during).toEqual(out.before);
    expect(out.after).toEqual(out.before);
  });

  test('a write the page refuses returns null and leaves the form as it was', async ({ page }) => {
    const out = await run(page, (A, form) => {
      const fields = form({ 'title_field[und][0][value]': 'Keep me' });
      const f = A.findField(fields, 'title_field[und][0][value]');
      // The form is gone from the page, so the write cannot take effect.
      document.body.replaceChildren();
      return { record: A.fillText(f, 'New'), now: (f.elements[0] as HTMLInputElement).value };
    });
    expect(out).toEqual({ record: null, now: 'Keep me' });
  });

  test('undo is not possible for a field the form no longer has', async ({ page }) => {
    const out = await run(page, (A, form) => {
      const fields = form({ 'title_field[und][0][value]': '' });
      const record = A.fillText(A.titleField(fields), 'Draft title');
      return { could: A.canUndoText(record, []), undone: A.undoText(record, []) };
    });
    expect(out).toEqual({ could: false, undone: false });
  });
});

// ------------------------------------------------------------------ the body

test.describe('canUndoBody', () => {
  test('body undo is withdrawn once the editor content changed', async ({ page }) => {
    expect(await run(page, A => A.canUndoBody({ previous: '', filled: '<p>x</p>' }, '<p>x</p><p>typed</p>'))).toBe(false);
  });

  test('body undo is offered while the editor still holds exactly what was filled', async ({ page }) => {
    expect(await run(page, A => A.canUndoBody({ previous: '<p>old</p>', filled: '<p>x</p>' }, '<p>x</p>'))).toBe(true);
  });

  test('the previous text is not what Undo is offered on', async ({ page }) => {
    expect(await run(page, A => A.canUndoBody({ previous: '<p>old</p>', filled: '<p>x</p>' }, '<p>old</p>'))).toBe(false);
  });
});
