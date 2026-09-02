import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';
import { draftKey, assessDraft, formatAge, Draft } from '../src/lib/autosave';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Write-back, autosave conflict handling, and validation-error mapping.
 *
 * Write-back and error mapping need a real DOM, so those run bundled in the page
 * against the reconstructed forms. The autosave decision logic is pure and runs in
 * Node.
 */

let bundle: string;

test.beforeAll(async () => {
  const result = await esbuild.build({
    stdin: {
      contents: `
        export * from './src/lib/formSchema/index';
        export * from './src/lib/fieldBinding';
        export * from './src/lib/validationErrors';
      `,
      resolveDir: path.join(__dirname, '..'),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'Editor',
    platform: 'browser',
    target: 'es2020',
  });
  bundle = result.outputFiles[0].text;
});

async function open(page: import('@playwright/test').Page, fixture: string) {
  await page.goto(`file://${path.join(__dirname, 'fixtures', fixture)}`);
  await page.addScriptTag({ content: bundle });
}

test.describe('write-back to native controls', () => {
  test('a text field writes through and fires a bubbling change event', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const title = schema.fields.find((f: any) => f.baseName === 'title');

      // Drupal's own JS listens for change on the form, so it must bubble.
      let sawChange = false;
      schema.form.addEventListener('change', () => { sawChange = true; });

      const ok = api.writeValue(title, 'Ablation outcomes at five years');
      return {
        ok,
        native: (document.getElementById('edit-title') as HTMLInputElement).value,
        readBack: api.readValue(title),
        sawChange,
      };
    });
    expect(result.ok).toBe(true);
    expect(result.native).toBe('Ablation outcomes at five years');
    expect(result.readBack).toBe('Ablation outcomes at five years');
    expect(result.sawChange).toBe(true);
  });

  test('a checkbox group writes exactly the requested set', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const topics = schema.fields.find((f: any) => f.baseName === 'field_topics');

      api.writeValue(topics, ['12', '34']);
      const checked = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[name="field_topics[und][]"]')
      ).filter(i => i.checked).map(i => i.value);

      return { checked, readBack: api.readValue(topics) };
    });
    expect(result.checked.sort()).toEqual(['12', '34']);
    expect((result.readBack as string[]).sort()).toEqual(['12', '34']);
  });

  test('rewriting a checkbox group unchecks what is no longer selected', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const checked = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const topics = schema.fields.find((f: any) => f.baseName === 'field_topics');
      api.writeValue(topics, ['1', '2', '3']);
      api.writeValue(topics, ['2']);
      return Array.from(
        document.querySelectorAll<HTMLInputElement>('input[name="field_topics[und][]"]')
      ).filter(i => i.checked).map(i => i.value);
    });
    expect(checked).toEqual(['2']);
  });

  test('a select reports failure when the value has no matching option', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const primary = schema.fields.find((f: any) => f.baseName === 'field_primary_topic');
      return {
        valid: api.writeValue(primary, '12'),
        // The exact silent-failure mode that scrambled the menu manager's weights.
        invalid: api.writeValue(primary, '99999'),
      };
    });
    expect(result.valid).toBe(true);
    expect(result.invalid).toBe(false);
  });

  test('a checkbox group reports failure for values with no checkbox', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const ok = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const topics = schema.fields.find((f: any) => f.baseName === 'field_topics');
      return api.writeValue(topics, ['12', 'not-a-term']);
    });
    expect(ok).toBe(false);
  });

  test('a radio group selects the matching option', async ({ page }) => {
    await open(page, 'node-add-page.html');
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      const mode = schema.fields.find((f: any) => f.baseName === 'display_mode');
      const ok = api.writeValue(mode, 'wide');
      return {
        ok,
        checked: (document.getElementById('dm2') as HTMLInputElement).checked,
        previous: (document.getElementById('dm1') as HTMLInputElement).checked,
        readBack: api.readValue(mode),
      };
    });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(true);
    expect(result.previous).toBe(false);
    expect(result.readBack).toBe('wide');
  });

  test('a date widget round-trips across its month/day/year selects', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const date = schema.fields.find((f: any) => f.kind === 'date');
      const before = api.readValue(date);
      const ok = api.writeValue(date, '9-13-2026');
      return {
        before,
        ok,
        after: api.readValue(date),
        month: (document.getElementById('edit-field-display-date-month') as HTMLSelectElement).value,
        day: (document.getElementById('edit-field-display-date-day') as HTMLSelectElement).value,
      };
    });
    expect(result.before).toBe('8-12-2026');
    expect(result.ok).toBe(true);
    expect(result.after).toBe('9-13-2026');
    expect(result.month).toBe('9');
    expect(result.day).toBe('13');
  });

  test('a single checkbox round-trips as a boolean', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const flag = schema.fields.find((f: any) => f.baseName === 'field_sitewide_news');
      const before = api.readValue(flag);
      api.writeValue(flag, false);
      const after = api.readValue(flag);
      return { before, after, native: (document.getElementById('edit-field-sitewide-news') as HTMLInputElement).checked };
    });
    expect(result.before).toBe(true);
    expect(result.after).toBe(false);
    expect(result.native).toBe(false);
  });

  test('readAll / writeAll round-trip the whole form', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });

      const snapshot = api.readAll(schema.fields);
      // Mutate the page, then restore from the snapshot.
      (document.getElementById('edit-title') as HTMLInputElement).value = 'scribble';
      (document.getElementById('t1') as HTMLInputElement).checked = true;

      const failed = api.writeAll(schema.fields, snapshot);
      return {
        failed,
        title: (document.getElementById('edit-title') as HTMLInputElement).value,
        t1: (document.getElementById('t1') as HTMLInputElement).checked,
      };
    });
    expect(result.failed).toEqual([]);
    expect(result.title).toBe('');
    expect(result.t1).toBe(false);
  });

  test('a write to a detached element is reported as failed, not silently dropped', async ({ page }) => {
    // Assigning to an input that has left the document throws nothing and changes nothing
    // the form will submit. Claiming success there let the overlay diverge from Drupal.
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const title = schema.fields.find((f: any) => /^title$/i.test(f.label));
      const el = title.elements[0];

      const okWhileAttached = api.writeValue(title, 'still in the page');
      el.remove();
      const okAfterDetach = api.writeValue(title, 'no longer in the page');

      return { okWhileAttached, okAfterDetach, connected: el.isConnected };
    });
    expect(result.okWhileAttached).toBe(true);
    expect(result.connected).toBe(false);
    expect(result.okAfterDetach, 'a detached write must not report success').toBe(false);
  });

  test('a wrapper replaced by Drupal AJAX does not break write-back', async ({ page }) => {
    /**
     * The real failure, reproduced: Drupal answers an interaction by replacing a widget
     * wrapper, so the schema's element reference goes stale while an identically-named
     * input takes its place. Writes were landing on the discarded node — which is how the
     * overlay showed a checkbox ticked that Drupal read as false.
     */
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const title = schema.fields.find((f: any) => /^title$/i.test(f.label));
      const stale = title.elements[0] as HTMLInputElement;

      // Swap in a fresh input under the same name, exactly as an AJAX replace would.
      const replacement = stale.cloneNode(true) as HTMLInputElement;
      replacement.value = '';
      stale.replaceWith(replacement);

      const ok = api.writeValue(title, 'written after the swap');
      return {
        ok,
        staleValue: stale.value,
        liveValue: replacement.value,
        readsBack: api.readValue(title),
      };
    });

    expect(result.ok, 'the write must be reported as succeeding').toBe(true);
    // The value has to land on the input Drupal will submit, not the discarded one.
    expect(result.liveValue).toBe('written after the swap');
    expect(result.staleValue).toBe('');
    expect(result.readsBack).toBe('written after the swap');
  });

  test('writeAll names the fields that failed rather than silently dropping them', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const failed = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      return api.writeAll(schema.fields, { 'field_primary_topic[und]': 'nonexistent-term' });
    });
    expect(failed).toEqual(['field_primary_topic[und]']);
  });

  test('submitForm clicks Drupal\'s own button rather than posting directly', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      let submitted = false;
      schema.form.addEventListener('submit', (e: Event) => { e.preventDefault(); submitted = true; });
      const ok = api.submitForm(schema.form);
      return { ok, submitted, noValidate: schema.form.noValidate };
    });
    expect(result.ok).toBe(true);
    expect(result.submitted).toBe(true);
    expect(result.noValidate).toBe(true);
  });

  test('submits even with an empty required field on a hidden form', async ({ page }) => {
    // The regression this guards: with the native form display:none and a required
    // field empty, Chrome refuses to submit a form it cannot focus and fires no
    // submit event at all, so Save would silently do nothing.
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      schema.form.style.display = 'none';
      (document.getElementById('edit-title') as HTMLInputElement).value = '';

      let submitted = false;
      schema.form.addEventListener('submit', (e: Event) => { e.preventDefault(); submitted = true; });
      const ok = api.submitForm(schema.form);
      return { ok, submitted };
    });
    expect(result.ok).toBe(true);
    expect(result.submitted).toBe(true);
  });

  test('submitForm reports failure when there is no save button', async ({ page }) => {
    await page.goto('data:text/html,<body class="node-type-news"><form class="node-form"><input name="title"/></form></body>');
    await page.addScriptTag({ content: bundle });
    const ok = await page.evaluate(() =>
      (window as any).Editor.submitForm(document.querySelector('form')));
    expect(ok).toBe(false);
  });
});

test.describe('validation error mapping', () => {
  /** Injects the markup Drupal produces on a rejected submit. */
  const withErrors = (messages: string[], flagIds: string[]) => `
    (function () {
      const region = document.createElement('div');
      region.className = 'messages error';
      region.innerHTML = '<ul>' + ${JSON.stringify(messages)}.map(m => '<li>' + m + '</li>').join('') + '</ul>';
      document.body.insertBefore(region, document.body.firstChild);
      ${JSON.stringify(flagIds)}.forEach(id => document.getElementById(id)?.classList.add('error'));
    })();
  `;

  test('maps a flagged element to its field and section', async ({ page }) => {
    await open(page, 'node-add-news.html');
    await page.addScriptTag({ content: withErrors(['Title field is required.'], ['edit-title']) });
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const errors = api.readFormErrors(schema.fields);
      return {
        messages: errors.messages,
        fields: errors.fieldErrors.map((e: any) => ({
          label: e.field.label, section: e.field.section, source: e.source, message: e.message,
        })),
        sections: errors.sections,
        unattributed: errors.unattributed,
      };
    });
    expect(result.messages).toEqual(['Title field is required.']);
    expect(result.fields).toEqual([
      { label: 'Title', section: 'primary', source: 'element', message: 'Title field is required.' },
    ]);
    expect(result.sections).toEqual(['primary']);
    expect(result.unattributed).toEqual([]);
  });

  test('attributes a message by label when Drupal flagged no element', async ({ page }) => {
    await open(page, 'node-add-news.html');
    await page.addScriptTag({ content: withErrors(['Summary field is required.'], []) });
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const errors = api.readFormErrors(schema.fields);
      return errors.fieldErrors.map((e: any) => ({ label: e.field.label, source: e.source }));
    });
    expect(result).toEqual([{ label: 'Summary', source: 'message' }]);
  });

  test('opens rail sections for errors on hidden fields', async ({ page }) => {
    await open(page, 'node-add-news.html');
    // A Groups field — drawn under Related Content, and invisible until that opens.
    await page.addScriptTag({ content: withErrors(['Your Groups field is required.'], ['edit-og-your-groups']) });
    const sections = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      return api.readFormErrors(schema.fields).sections;
    });
    expect(sections).toEqual(['groups']);
  });

  test('prefers the longest label so a specific field is not claimed by a generic one', async ({ page }) => {
    await open(page, 'node-add-news.html');
    await page.addScriptTag({ content: withErrors(['Related Conditions field is required.'], []) });
    const labels = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      return api.readFormErrors(schema.fields).fieldErrors.map((e: any) => e.field.label);
    });
    expect(labels).toEqual(['Related Conditions']);
  });

  test('keeps messages that match no field, rather than dropping them', async ({ page }) => {
    await open(page, 'node-add-news.html');
    await page.addScriptTag({ content: withErrors(['You are not authorized to do that.'], []) });
    const result = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const errors = api.readFormErrors(schema.fields);
      return { unattributed: errors.unattributed, fieldCount: errors.fieldErrors.length, has: api.hasErrors(errors) };
    });
    expect(result.unattributed).toEqual(['You are not authorized to do that.']);
    expect(result.fieldCount).toBe(0);
    expect(result.has).toBe(true);
  });

  test('a clean form reports no errors', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const has = await page.evaluate(() => {
      const api = (window as any).Editor;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      return api.hasErrors(api.readFormErrors(schema.fields));
    });
    expect(has).toBe(false);
  });
});

test.describe('autosave draft keys and conflict handling', () => {
  const loc = (pathname: string) =>
    ({ pathname, origin: 'https://www.cuimc.columbia.edu' } as Location);

  test('an edit page and its destination-suffixed twin share one draft', async ({}) => {
    const a = draftKey(loc('/node/451/edit'));
    const b = draftKey(loc('/node/451/edit'));
    expect(a).toBe(b);
    expect(a).toContain('/node/451');
  });

  test('different nodes get different drafts', async ({}) => {
    expect(draftKey(loc('/node/451/edit'))).not.toBe(draftKey(loc('/node/452/edit')));
  });

  test('add forms are keyed per content type', async ({}) => {
    expect(draftKey(loc('/node/add/news'))).not.toBe(draftKey(loc('/node/add/page')));
    expect(draftKey(loc('/node/add/news'))).toContain('/node/add/news');
  });

  const draft = (baseChanged: string | null): Draft => ({
    values: { title: 'x' },
    savedAt: 1_000_000,
    baseChanged,
    contentType: 'news',
    sourceUrl: 'https://example.org/node/451/edit',
  });

  test('no draft means nothing to decide', () => {
    expect(assessDraft(null, '123')).toEqual({ kind: 'none' });
  });

  test('a draft on the same revision is restorable', () => {
    const result = assessDraft(draft('123'), '123');
    expect(result.kind).toBe('restorable');
  });

  test('a draft older than the current revision is stale, not applied', () => {
    // Someone else saved in between. This is the case that must never silently win.
    const result = assessDraft(draft('123'), '456');
    expect(result.kind).toBe('stale');
    if (result.kind === 'stale') expect(result.currentChanged).toBe('456');
  });

  test('an add form with no changed stamp is restorable, since there is no revision to conflict with', () => {
    expect(assessDraft(draft(null), null).kind).toBe('restorable');
  });

  test('formatAge reads as the design specifies', () => {
    const now = 1_000_000_000;
    expect(formatAge(now - 12_000, now)).toBe('12s ago');
    expect(formatAge(now - 4 * 60_000, now)).toBe('4m ago');
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2d ago');
    // A clock skewed into the future must not render a negative age.
    expect(formatAge(now + 5_000, now)).toBe('0s ago');
  });
});
