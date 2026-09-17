import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

/**
 * Lifting a page off one site's node form.
 *
 * What these tests are really guarding: that nothing site-local is stored as a value to
 * write. A term id, a file id, an author's name and a menu position are all either
 * meaningless or wrong on the destination, and the ways they leak in are quiet.
 */

let bundle: string;

test.beforeAll(async () => {
  const entry = path.join(FIXTURES, '.clone-snapshot-entry.ts');
  fs.writeFileSync(entry, `
    export { discoverSchema } from '../../src/lib/formSchema';
    export { captureNode, findParagraphWidgets } from '../../src/lib/clone/snapshot';
  `);
  const built = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, format: 'iife',
    globalName: 'S', platform: 'browser', target: 'es2020',
  });
  bundle = built.outputFiles[0].text;
  fs.unlinkSync(entry);
});

/**
 * Loads a fixture with a recording stub in place of the extension APIs.
 *
 * The stub is how the CKEditor-sync test below can assert a message was sent, rather
 * than assuming it. Without it `chrome` is simply undefined, which the production code
 * swallows on purpose.
 */
async function load(page: import('@playwright/test').Page, fixture: string) {
  await page.goto('data:text/html,<body>host</body>');
  await page.setContent(fs.readFileSync(path.join(FIXTURES, fixture), 'utf8'));
  await page.evaluate(() => {
    (window as any).__sent = [];
    (window as any).chrome = {
      runtime: {
        sendMessage: (message: unknown) => {
          (window as any).__sent.push(message);
          return Promise.resolve({ ok: true });
        },
      },
    };
  });
  await page.addScriptTag({ content: bundle });
}

const capture = (page: import('@playwright/test').Page, pathname: string) =>
  page.evaluate(async (p) => {
    const api = (window as any).S;
    const schema = api.discoverSchema(document, { pathname: p });
    if (!schema) return null;
    return api.captureNode(schema, {
      href: `https://source.example.edu${p}`,
      origin: 'https://source.example.edu',
    });
  }, pathname);

test.describe('what a copy carries', () => {
  test('the node title is read for the clipboard list', async ({ page }) => {
    await load(page, 'node-edit-media-populated.html');
    const snapshot = await capture(page, '/node/451/edit');
    expect(snapshot.title).toBe('Why Are Girls Starting Puberty Earlier?');
  });

  test('the rich editor is flushed to the DOM before anything is read', async ({ page }) => {
    /**
     * The staleness bug this prevents: CKEditor keeps the body in its own instance and
     * only writes it back to the textarea on submit. Read the DOM first and every copied
     * body is the previously saved revision rather than what is on screen — wrong, and
     * completely silent.
     *
     * Asserted by observing the message, because the alternative is trusting that the
     * call is still there.
     */
    await load(page, 'captured/page.html');
    await capture(page, '/node/add/page');
    const sent = await page.evaluate(() => (window as any).__sent);
    expect(
      sent.some((m: any) => m?.type === 'richEditorLifecycle' && m?.op === 'sync'),
      'captureNode did not ask the editor bridge to sync — copied bodies will be stale'
    ).toBe(true);
  });

  test('choice fields carry option labels, never the source ids alone', async ({ page }) => {
    await load(page, 'captured/news.html');
    await page.evaluate(() => {
      // Select a real term through the DOM, as a user would.
      const select = document.querySelector<HTMLSelectElement>(
        'select[name="field_news_categories_primary[und]"], select[name^="field_news_categories"]'
      );
      if (select) {
        const option = Array.from(select.options).find(o => o.value && o.value !== '_none');
        if (option) select.value = option.value;
      }
    });

    const snapshot = await capture(page, '/node/add/news');
    const choice = snapshot.fields.filter((f: any) => f.optionLabels !== null);
    expect(choice.length, 'no choice field was captured with labels').toBeGreaterThan(0);

    for (const field of choice) {
      for (const label of field.optionLabels) {
        expect(label, `${field.machineName} stored an empty label`).not.toBe('');
        // A bare integer is a term id masquerading as a label, which is the exact
        // failure this design exists to prevent.
        expect(/^\d+$/.test(label),
          `${field.machineName} stored "${label}" as a label — that is an id, not a name`).toBe(false);
      }
    }
  });

  test('empty fields are not carried, so a paste does not blank the destination', async ({ page }) => {
    await load(page, 'captured/page.html');
    const snapshot = await capture(page, '/node/add/page');
    const blank = snapshot.fields.filter((f: any) =>
      typeof f.value === 'string' && f.value.trim() === '');
    expect(blank).toEqual([]);
  });

  test('images are references, never field values', async ({ page }) => {
    await load(page, 'node-edit-media-populated.html');
    const snapshot = await capture(page, '/node/451/edit');

    expect(snapshot.media.length).toBe(2);
    // Nothing that could be written into a widget.
    const leaked = snapshot.fields.filter((f: any) =>
      f.kind === 'file' || /\[fid\]$|^media\[|^files\[/.test(f.machineName));
    expect(leaked, 'a file id or media widget was captured as a writable value').toEqual([]);
  });
});

test.describe('what a copy refuses to carry', () => {
  test('denied fields are absent from the values AND explained', async ({ page }) => {
    await load(page, 'captured/news.html');
    const snapshot = await capture(page, '/node/add/news');

    const names = snapshot.fields.map((f: any) => f.machineName);
    for (const forbidden of ['status', 'name', 'date', 'path[alias]']) {
      expect(names, `${forbidden} was captured`).not.toContain(forbidden);
    }
    for (const menuField of names.filter((n: string) => n.startsWith('menu['))) {
      throw new Error(`menu field ${menuField} was captured`);
    }

    // Absent is not enough: the review has to be able to say why.
    expect(snapshot.omitted.length, 'nothing was reported as deliberately skipped')
      .toBeGreaterThan(0);
    for (const item of snapshot.omitted) {
      expect(item.label.trim()).not.toBe('');
      expect(item.reason.trim()).not.toBe('');
    }
  });

  test('a text format is never carried', async ({ page }) => {
    // Formats are configured per site and permission-gated; writing the wrong one gets
    // content stripped on save.
    await load(page, 'captured/specialty.html');
    const snapshot = await capture(page, '/node/add/specialty');
    const formats = snapshot.fields.filter((f: any) => /\[format\]$/.test(f.machineName));
    expect(formats).toEqual([]);
  });
});

test.describe('finding the Paragraphs widgets', () => {
  test('the bundle chooser gives the field name and the buildable types', async ({ page }) => {
    await load(page, 'captured/page.html');
    const widgets = await page.evaluate(() => {
      const api = (window as any).S;
      const form = document.querySelector('form.node-form, form[id$="-node-form"]');
      return api.findParagraphWidgets(form).map((w: any) => ({
        baseName: w.baseName, label: w.label,
        bundles: w.bundles.map((b: any) => b.value), deltas: w.deltas,
      }));
    });

    expect(widgets.length, 'Page has a Paragraphs field and none was found').toBe(1);
    expect(widgets[0].baseName).toBe('field_page_paragraphs');
    // The eleven bundles the real form offers. A destination missing one of these cannot
    // rebuild that item, which is why the list is read rather than assumed.
    expect(widgets[0].bundles).toContain('text');
    expect(widgets[0].bundles).toContain('faq');
    expect(widgets[0].bundles.length).toBe(11);
    // An add form has no items yet.
    expect(widgets[0].deltas).toEqual([]);
  });

  test('items are counted from control names, in order', async ({ page }) => {
    /**
     * This tests the COUNTER, not the subform markup — the inputs below are named the way
     * Drupal names a delta, which is all the counter reads. The real structure of a
     * populated subform has not been captured yet, and is deliberately not invented here.
     */
    await load(page, 'captured/page.html');
    const deltas = await page.evaluate(() => {
      const form = document.querySelector('form.node-form, form[id$="-node-form"]') as HTMLFormElement;
      for (const delta of [2, 0, 1]) {
        const input = document.createElement('input');
        input.type = 'text';
        input.name = `field_page_paragraphs[und][${delta}][field_text][und][0][value]`;
        form.appendChild(input);
      }
      return (window as any).S.findParagraphWidgets(form)[0].deltas;
    });
    expect(deltas).toEqual([0, 1, 2]);
  });

  test('a page with paragraph items says so instead of looking complete', async ({ page }) => {
    await load(page, 'captured/page.html');
    const snapshot = await page.evaluate(async () => {
      const api = (window as any).S;
      const form = document.querySelector('form.node-form, form[id$="-node-form"]') as HTMLFormElement;
      for (const delta of [0, 1]) {
        const input = document.createElement('input');
        input.type = 'text';
        input.name = `field_page_paragraphs[und][${delta}][field_text][und][0][value]`;
        input.value = `item ${delta}`;
        form.appendChild(input);
      }
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      return api.captureNode(schema, {
        href: 'https://source.example.edu/node/add/page',
        origin: 'https://source.example.edu',
      });
    });

    expect(snapshot.paragraphs.length).toBe(1);
    expect(snapshot.paragraphs[0].baseName).toBe('field_page_paragraphs');

    const note = snapshot.omitted.find((o: any) => /content item/i.test(o.reason));
    expect(note, 'the paragraph items were dropped without telling anyone').toBeTruthy();
    expect(note.reason).toContain('2 content items');
  });

  test('paragraph controls do not leak into the flat field list', async ({ page }) => {
    // They belong to their item, and a paste that wrote them by absolute name would fill
    // whichever item happened to sit at that delta on the destination.
    await load(page, 'captured/page.html');
    const snapshot = await page.evaluate(async () => {
      const api = (window as any).S;
      const form = document.querySelector('form.node-form, form[id$="-node-form"]') as HTMLFormElement;
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'field_page_paragraphs[und][0][field_text][und][0][value]';
      input.value = 'nested';
      form.appendChild(input);
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      return api.captureNode(schema, {
        href: 'https://source.example.edu/node/add/page', origin: 'https://source.example.edu',
      });
    });

    const leaked = snapshot.fields.filter((f: any) =>
      f.machineName.startsWith('field_page_paragraphs'));
    expect(leaked).toEqual([]);
  });
});
