import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

/**
 * Recreating a page's structured content items on another site.
 *
 * One generic mechanism and no per-type code: an item's subform is just fields, so
 * `text` and `faq` — the two that get real use, both backed by an HTML editor — are
 * handled without either being a special case.
 *
 * The markup below is a STAND-IN. A populated Paragraphs subform has not been captured
 * from a real site, so these fixtures assert the mechanism (delta parsing, type
 * detection, the add-more cycle, the rich-editor correction) rather than claiming to
 * know what Drupal renders. That is exactly why detectBundle reports HOW it decided —
 * a wrong guess against real markup shows up in the review instead of silently
 * producing an item of the wrong type.
 */

let bundle: string;

test.beforeAll(async () => {
  const entry = path.join(FIXTURES, '.clone-paragraphs-entry.ts');
  fs.writeFileSync(entry, `
    export { discoverSchema } from '../../src/lib/formSchema';
    export {
      relativeName, detectBundle, effectiveKind, addAnotherItem, rebuildParagraphs,
    } from '../../src/lib/clone/paragraphs';
  `);
  const built = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, format: 'iife',
    globalName: 'P', platform: 'browser', target: 'es2020',
  });
  bundle = built.outputFiles[0].text;
  fs.unlinkSync(entry);
});

const BUNDLES = ['cta', 'faq', 'image', 'text', 'timeline'];

/**
 * A node form whose "Add another item" behaves like Drupal's.
 *
 * The handler appends the new subform ASYNCHRONOUSLY, after a delay the test controls.
 * That is the point: a rebuild that waited on a fixed sleep would pass against a
 * synchronous stub and then race a real server. `delayMs: null` never appends, which is
 * how the timeout path is reached.
 */
async function openForm(
  page: import('@playwright/test').Page,
  options: { delayMs?: number | null; existing?: string; richEditor?: boolean } = {}
) {
  const { delayMs = 30, existing = '', richEditor = false } = options;

  await page.goto('data:text/html,<body></body>');
  await page.setContent(`
    <body>
      <form class="node-form" id="page-node-form">
        <div class="form-item">
          <label for="edit-title">Title</label>
          <input type="text" id="edit-title" name="title_field[und][0][value]">
        </div>
        <div id="edit-field-page-paragraphs">
          <label>Page Paragraphs</label>
          <div id="paragraph-items">${existing}</div>
          <div class="form-item">
            <label for="edit-add-type">Content Item type</label>
            <select class="field-add-more-type form-select" id="edit-add-type"
                    name="field_page_paragraphs_add_more_type">
              ${BUNDLES.map(b => `<option value="${b}">${b[0].toUpperCase() + b.slice(1)}</option>`).join('')}
            </select>
          </div>
          <input type="submit" name="field_page_paragraphs_add_more_add_more" value="Add another item">
        </div>
      </form>
    </body>`);

  await page.evaluate(([delay, rich]) => {
    (window as any).__sent = [];
    (window as any).chrome = {
      runtime: {
        sendMessage: (message: unknown) => {
          (window as any).__sent.push(message);
          return Promise.resolve({ ok: true });
        },
      },
    };

    const button = document.querySelector<HTMLInputElement>('input[name$="_add_more"]')!;
    const host = document.querySelector('#paragraph-items')!;
    let next = document.querySelectorAll('[data-paragraph-delta]').length;

    button.addEventListener('click', event => {
      event.preventDefault();
      if (delay === null) return;   // models a request that never comes back

      const type = (document.querySelector('#edit-add-type') as HTMLSelectElement).value;
      const delta = next++;

      window.setTimeout(() => {
        const wrapper = document.createElement('div');
        wrapper.className = `paragraphs-subform paragraph-type-${type.replace(/_/g, '-')}`;
        wrapper.setAttribute('data-paragraph-delta', String(delta));

        const id = `edit-pp-${delta}-body`;
        wrapper.innerHTML = `
          <input type="hidden" name="field_page_paragraphs[und][${delta}][bundle]" value="${type}">
          <div class="form-item">
            <label for="${id}">Body</label>
            <textarea id="${id}"
              name="field_page_paragraphs[und][${delta}][field_body][und][0][value]"></textarea>
            ${rich ? `<div class="cke" id="cke_${id}"></div>` : ''}
          </div>
          <div class="form-item">
            <label for="edit-pp-${delta}-heading">Heading</label>
            <input type="text" id="edit-pp-${delta}-heading"
              name="field_page_paragraphs[und][${delta}][field_heading][und][0][value]">
          </div>`;
        host.appendChild(wrapper);
      }, delay as number);
    });
  }, [delayMs, richEditor] as const);

  await page.addScriptTag({ content: bundle });
}

test.describe('reading an item apart from its widget', () => {
  test('a nested name yields its delta and a relative name', async ({ page }) => {
    await openForm(page);
    const parsed = await page.evaluate(() => (window as any).P.relativeName(
      'field_page_paragraphs',
      'field_page_paragraphs[und][2][field_body][und][0][value]'
    ));
    expect(parsed).toEqual({ delta: 2, relative: 'field_body[und][0][value]' });
  });

  test('a name belonging to another field is not claimed', async ({ page }) => {
    await openForm(page);
    const parsed = await page.evaluate(() => (window as any).P.relativeName(
      'field_page_paragraphs', 'field_summary[und][0][value]'
    ));
    expect(parsed).toBeNull();
  });

  test('a two-digit delta parses as itself, not as its first digit', async ({ page }) => {
    await openForm(page);
    const parsed = await page.evaluate(() => (window as any).P.relativeName(
      'field_page_paragraphs',
      'field_page_paragraphs[und][11][field_body][und][0][value]'
    ));
    expect(parsed.delta).toBe(11);
  });
});

test.describe('working out what type an item is', () => {
  const detect = (page: import('@playwright/test').Page, delta = 0) =>
    page.evaluate(([bundles, d]) => {
      const form = document.querySelector('form.node-form')!;
      return (window as any).P.detectBundle(form, 'field_page_paragraphs', d, bundles);
    }, [BUNDLES, delta] as const);

  test("Drupal's own record of the type is preferred", async ({ page }) => {
    await openForm(page, { existing: `
      <div class="paragraphs-subform paragraph-type-cta" data-paragraph-delta="0">
        <input type="hidden" name="field_page_paragraphs[und][0][bundle]" value="faq">
        <textarea name="field_page_paragraphs[und][0][field_body][und][0][value]"></textarea>
      </div>` });

    // The class says cta and the hidden field says faq. The hidden field wins, because a
    // theme class is decoration and that input is what Drupal submits.
    expect(await detect(page)).toEqual({ bundle: 'faq', from: 'bundle-input' });
  });

  test('the subform class is used when there is no record', async ({ page }) => {
    await openForm(page, { existing: `
      <div class="paragraphs-subform paragraph-type-timeline" data-paragraph-delta="0">
        <textarea name="field_page_paragraphs[und][0][field_body][und][0][value]"></textarea>
      </div>` });
    expect(await detect(page)).toEqual({ bundle: 'timeline', from: 'subform-class' });
  });

  test('a hyphenated class maps back to the machine name', async ({ page }) => {
    // Drupal hyphenates machine names in classes; the bundle list uses underscores.
    await openForm(page, { existing: `
      <div class="paragraphs-subform paragraph-type-contact-information" data-paragraph-delta="0">
        <textarea name="field_page_paragraphs[und][0][field_body][und][0][value]"></textarea>
      </div>` });
    const result = await page.evaluate(() => {
      const form = document.querySelector('form.node-form')!;
      return (window as any).P.detectBundle(form, 'field_page_paragraphs', 0,
        ['contact_information', 'text']);
    });
    expect(result).toEqual({ bundle: 'contact_information', from: 'subform-class' });
  });

  test('field names are a last resort, and say so', async ({ page }) => {
    await openForm(page, { existing: `
      <div data-paragraph-delta="0">
        <textarea name="field_page_paragraphs[und][0][field_faq_answer][und][0][value]"></textarea>
      </div>` });
    expect(await detect(page)).toEqual({ bundle: 'faq', from: 'field-name' });
  });

  test('a type the destination does not offer is never inferred', async ({ page }) => {
    /**
     * The bundle list comes from the destination's own add-more select, so detection can
     * only ever land on something this site can actually build.
     */
    await openForm(page, { existing: `
      <div class="paragraphs-subform paragraph-type-payment-button" data-paragraph-delta="0">
        <input type="hidden" name="field_page_paragraphs[und][0][bundle]" value="payment_button">
        <textarea name="field_page_paragraphs[und][0][field_body][und][0][value]"></textarea>
      </div>` });
    expect(await detect(page)).toEqual({ bundle: null, from: 'unknown' });
  });

  test('nothing to go on reports unknown rather than picking one', async ({ page }) => {
    await openForm(page, { existing: `
      <div data-paragraph-delta="0">
        <textarea name="field_page_paragraphs[und][0][field_zzz][und][0][value]"></textarea>
      </div>` });
    expect(await detect(page)).toEqual({ bundle: null, from: 'unknown' });
  });
});

test.describe('the kind a nested field really is', () => {
  test("a rich-text item field is corrected from 'paragraphs' to 'wysiwyg'", async ({ page }) => {
    /**
     * The bug this prevents, and it would have hit the two item types that matter.
     *
     * walkForm classifies ANY control whose name matches /paragraph/i as kind
     * `paragraphs` — which is every field inside field_page_paragraphs[...]. writeValue
     * has no case for that, so the value would be assigned to the textarea and never
     * handed to the rich-editor bridge. CKEditor replaces the textarea's content from its
     * own instance on submit, so a `text` or `faq` item's HTML would be silently dropped.
     */
    await openForm(page, { richEditor: true, existing: `
      <div class="paragraphs-subform paragraph-type-text" data-paragraph-delta="0">
        <div class="form-item">
          <label for="edit-pp-0-body">Body</label>
          <textarea id="edit-pp-0-body"
            name="field_page_paragraphs[und][0][field_body][und][0][value]"></textarea>
          <div class="cke" id="cke_edit-pp-0-body"></div>
        </div>
      </div>` });

    const kinds = await page.evaluate(() => {
      const api = (window as any).P;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      const field = schema.fields.find((f: any) =>
        f.machineName === 'field_page_paragraphs[und][0][field_body][und][0][value]');
      return { raw: field.kind, corrected: api.effectiveKind(field) };
    });

    // The raw classification is the thing being corrected; if walkForm ever stops
    // reporting `paragraphs` here, this test should be revisited rather than deleted.
    expect(kinds.raw).toBe('paragraphs');
    expect(kinds.corrected).toBe('wysiwyg');
  });

  test('a plain text item field is not turned into a rich one', async ({ page }) => {
    await openForm(page, { existing: `
      <div class="paragraphs-subform paragraph-type-text" data-paragraph-delta="0">
        <div class="form-item">
          <label for="edit-pp-0-heading">Heading</label>
          <input type="text" id="edit-pp-0-heading"
            name="field_page_paragraphs[und][0][field_heading][und][0][value]">
        </div>
      </div>` });

    const corrected = await page.evaluate(() => {
      const api = (window as any).P;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      const field = schema.fields.find((f: any) => /field_heading/.test(f.machineName));
      return api.effectiveKind(field);
    });
    expect(corrected).toBe('text');
  });
});

test.describe('asking Drupal to add an item', () => {
  test('the wait is on the DOM, not on a timer', async ({ page }) => {
    /**
     * The stub appends after 300ms — far longer than any sleep worth writing. A rebuild
     * that guessed a delay would either miss this or have to be slower than every real
     * site.
     */
    await openForm(page, { delayMs: 300 });
    const result = await page.evaluate(() =>
      (window as any).P.addAnotherItem('field_page_paragraphs', 'text', 5000, document));

    expect(result.ok).toBe(true);
    expect(result.delta).toBe(0);
  });

  test('the item is built as the type that was asked for', async ({ page }) => {
    await openForm(page);
    const type = await page.evaluate(async () => {
      await (window as any).P.addAnotherItem('field_page_paragraphs', 'faq', 5000, document);
      return document.querySelector<HTMLInputElement>(
        'input[name="field_page_paragraphs[und][0][bundle]"]')?.value;
    });
    expect(type).toBe('faq');
  });

  test('a type this site does not offer is refused before clicking', async ({ page }) => {
    await openForm(page);
    const result = await page.evaluate(() =>
      (window as any).P.addAnotherItem('field_page_paragraphs', 'payment_button', 5000, document));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('payment_button');
    // Nothing was added, so nothing has to be undone.
    expect(await page.locator('[data-paragraph-delta]').count()).toBe(0);
  });

  test('a request that never returns is reported, not waited on forever', async ({ page }) => {
    await openForm(page, { delayMs: null });
    const result = await page.evaluate(() =>
      (window as any).P.addAnotherItem('field_page_paragraphs', 'text', 400, document));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('did not add the item in time');
  });

  test('each item gets its own delta, ascending', async ({ page }) => {
    await openForm(page);
    const deltas = await page.evaluate(async () => {
      const api = (window as any).P;
      const out = [];
      for (const b of ['text', 'faq', 'cta']) {
        out.push((await api.addAnotherItem('field_page_paragraphs', b, 5000, document)).delta);
      }
      return out;
    });
    expect(deltas).toEqual([0, 1, 2]);
  });
});

test.describe('rebuilding a whole widget', () => {
  const captured = (items: any[]) =>
    ({ baseName: 'field_page_paragraphs', label: 'Page Paragraphs', items });

  const item = (bundle: string, body: string, heading = '', over: any = {}) => ({
    bundle, bundleLabel: bundle, bundleFrom: 'bundle-input', delta: 0,
    fields: [
      { machineName: 'field_body[und][0][value]', baseName: 'field_body', label: 'Body',
        kind: 'wysiwyg', section: 'typeFields', required: false, multiValue: false,
        value: body, optionLabels: null },
      ...(heading ? [{
        machineName: 'field_heading[und][0][value]', baseName: 'field_heading',
        label: 'Heading', kind: 'text', section: 'typeFields', required: false,
        multiValue: false, value: heading, optionLabels: null }] : []),
    ],
    ...over,
  });

  test('an item is added and its fields filled', async ({ page }) => {
    await openForm(page);
    const result = await page.evaluate(async (payload) => {
      const outcome = await (window as any).P.rebuildParagraphs(payload, document);
      return {
        outcome,
        body: document.querySelector<HTMLTextAreaElement>(
          'textarea[name="field_page_paragraphs[und][0][field_body][und][0][value]"]')?.value,
        heading: document.querySelector<HTMLInputElement>(
          'input[name="field_page_paragraphs[und][0][field_heading][und][0][value]"]')?.value,
      };
    }, captured([item('text', '<p>The prose.</p>', 'A heading')]));

    expect(result.outcome.items[0].ok).toBe(true);
    expect(result.body).toBe('<p>The prose.</p>');
    expect(result.heading).toBe('A heading');
  });

  test('items arrive in the order the source had them', async ({ page }) => {
    // The order of content items is the order they appear on the published page.
    await openForm(page);
    const bodies = await page.evaluate(async (payload) => {
      await (window as any).P.rebuildParagraphs(payload, document);
      return Array.from(document.querySelectorAll<HTMLTextAreaElement>(
        'textarea[name*="[field_body]"]')).map(el => el.value);
    }, captured([
      item('text', 'first'),
      item('faq', 'second'),
      item('text', 'third'),
    ]));

    expect(bodies).toEqual(['first', 'second', 'third']);
  });

  test("an HTML item's markup reaches the rich editor, not just the textarea", async ({ page }) => {
    /**
     * The other half of the effectiveKind fix, asserted on the message rather than
     * inferred. Without it the textarea holds the right HTML and CKEditor overwrites it
     * on submit, which loses the content with nothing to show for it.
     */
    await openForm(page, { richEditor: true });
    const sent = await page.evaluate(async (payload) => {
      await (window as any).P.rebuildParagraphs(payload, document);
      return (window as any).__sent;
    }, captured([item('text', '<p>Must reach CKEditor.</p>')]));

    const synced = sent.filter((m: any) => m?.type === 'syncRichEditor');
    expect(synced.length, 'the item body was never handed to the editor bridge').toBe(1);
    expect(synced[0].value).toBe('<p>Must reach CKEditor.</p>');
  });

  test('an item of unknown type is reported rather than silently skipped', async ({ page }) => {
    await openForm(page);
    const outcome = await page.evaluate(
      (payload) => (window as any).P.rebuildParagraphs(payload, document),
      captured([item('', 'orphaned', '', { bundle: '', bundleFrom: 'unknown', bundleLabel: 'unknown type' })]));

    expect(outcome.items[0].ok).toBe(false);
    expect(outcome.items[0].reason).toContain('Could not tell what type');
    expect(await page.locator('[data-paragraph-delta]').count()).toBe(0);
  });

  test('one failing item does not stop the ones after it', async ({ page }) => {
    /**
     * A rare type the destination lacks sits in the middle of a page of prose. Abandoning
     * the rest would lose content that could have been carried.
     */
    await openForm(page);
    const outcome = await page.evaluate(
      (payload) => (window as any).P.rebuildParagraphs(payload, document),
      captured([
        item('text', 'before'),
        item('payment_button', 'unsupported'),
        item('text', 'after'),
      ]));

    expect(outcome.items.map((i: any) => i.ok)).toEqual([true, false, true]);
    const bodies = await page.evaluate(() => Array.from(
      document.querySelectorAll<HTMLTextAreaElement>('textarea[name*="[field_body]"]')
    ).map(el => el.value));
    expect(bodies).toEqual(['before', 'after']);
  });

  test('a field the new item does not have is named, not swallowed', async ({ page }) => {
    await openForm(page);
    const outcome = await page.evaluate((payload) =>
      (window as any).P.rebuildParagraphs(payload, document),
      captured([{
        bundle: 'text', bundleLabel: 'Text', bundleFrom: 'bundle-input', delta: 0,
        fields: [{
          machineName: 'field_absent_here[und][0][value]', baseName: 'field_absent_here',
          label: 'Caption', kind: 'text', section: 'typeFields', required: false,
          multiValue: false, value: 'x', optionLabels: null,
        }],
      }]));

    expect(outcome.items[0].ok).toBe(false);
    expect(outcome.items[0].problems).toEqual(['Caption']);
  });
});
