import { test, expect, type Page } from '@playwright/test';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * Which Drupal field a Varys suggestion fills, filling it, and taking it back.
 *
 * Every test needs real controls, so each runs bundled in a page against a real <form> read
 * by discoverSchema(), as editor-binding.spec.ts does. Nothing here reaches the extension or
 * Varys: this is the pure module underneath the suggestions panel.
 */

let bundle: string;

test.beforeAll(async () => {
  const result = await esbuild.build({
    stdin: {
      contents: `export * from './src/lib/varys/suggestionFill';
                 export * from './src/lib/varys/filled';
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
 * holding "description" or a summary is a textarea; anything else is a text input. Names in
 * `disabled` are rendered disabled, as Drupal renders the alias box while pathauto is ticked.
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
    } else if (/description|summary/.test(name)) {
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
  return window.Fill.discoverSchema(document, { pathname: '/node/123/edit' }).fields;
};
`;

/** A blank page with the module and the form helper loaded. */
async function ready(page: Page) {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: HELPER });
}

/** Runs `fn` in the page with the module's API and the form helper in hand. */
function run<T>(page: Page, fn: (api: any, form: (values: Record<string, string | boolean>, disabled?: string[]) => any[]) => T) {
  // A string is evaluated as an expression in the page, so `fn` runs there with the module's
  // API and the helper as its arguments.
  return page.evaluate(`(${fn.toString()})(window.Fill, window.form)`) as Promise<T>;
}

test.beforeEach(async ({ page }) => ready(page));

// ----------------------------------------------------------------------- which field

test.describe('descriptionTarget', () => {
  test('description goes to Summary when the override follows it', async ({ page }) => {
    expect(await run(page, (A, form) => A.descriptionTarget(form({
      'metatags[und][description][value]': '[node:summary]',
      'field_summary[und][0][value]': 'S',
    })))).toBe('summary');
  });

  test('description goes to the override when it has its own text', async ({ page }) => {
    expect(await run(page, (A, form) => A.descriptionTarget(form({
      'metatags[und][description][value]': 'Own',
      'field_summary[und][0][value]': 'S',
    })))).toBe('override');
  });

  test('the override is used when it exists and Summary does not', async ({ page }) => {
    expect(await run(page, (A, form) => A.descriptionTarget(form({
      'metatags[und][description][value]': '[node:summary]',
    })))).toBe('override');
    expect(await run(page, (A, form) => A.descriptionTarget(form({
      'metatags[und][description][value]': '',
    })))).toBe('override');
  });

  test('an empty override is filled, not left to a default, when Summary exists too', async ({ page }) => {
    expect(await run(page, (A, form) => A.descriptionTarget(form({
      'metatags[und][description][value]': '',
      'field_summary[und][0][value]': 'S',
    })))).toBe('override');
  });

  test('Summary alone is the target', async ({ page }) => {
    expect(await run(page, (A, form) => A.descriptionTarget(form({
      'field_summary[und][0][value]': 'S',
    })))).toBe('summary');
  });

  test('a form with neither has no target', async ({ page }) => {
    expect(await run(page, (A, form) => A.descriptionTarget(form({ title: 'Old' })))).toBeNull();
  });
});

test.describe('titleField', () => {
  test('the live sites call it title_field, an older form calls it title', async ({ page }) => {
    expect(await run(page, (A, form) => A.titleField(form({ 'title_field[und][0][value]': 'T', title: 'U' }))?.machineName))
      .toBe('title_field[und][0][value]');
    expect(await run(page, (A, form) => A.titleField(form({ title: 'U' }))?.machineName)).toBe('title');
    expect(await run(page, (A, form) => A.titleField(form({ 'metatags[und][title][value]': 'M' })) ?? null)).toBeNull();
  });
});

// ------------------------------------------------------------------------- filling

test.describe('fillOne', () => {
  test('a search title is written to the field and marked as filled from Varys', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const f = form({ 'metatags[und][title][value]': 'Old' });
      const rec = A.fillOne('meta_title', 'New', f);
      return {
        rec,
        now: A.readValue(A.findField(f, 'metatags[und][title][value]')),
        marked: A.filledFields(),
      };
    });
    expect(r.now).toBe('New');
    expect(r.marked).toEqual(['meta_title']);
    expect(r.rec).toMatchObject({
      kind: 'meta_title', machineName: 'metatags[und][title][value]',
      previous: 'Old', filled: 'New', pathautoWasTicked: false,
    });
  });

  test('a description is written to Summary when the override follows it, and the override is left alone', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const f = form({
        'metatags[und][description][value]': '[node:summary]',
        'field_summary[und][0][value]': 'Old summary',
      });
      const rec = A.fillOne('meta_description', 'New summary', f);
      return {
        machineName: rec.machineName,
        summary: A.readValue(A.findField(f, 'field_summary[und][0][value]')),
        override: A.readValue(A.findField(f, 'metatags[und][description][value]')),
        marked: A.filledFields(),
      };
    });
    expect(r).toEqual({
      machineName: 'field_summary[und][0][value]',
      summary: 'New summary',
      override: '[node:summary]',
      marked: ['meta_description'],
    });
  });

  test('a description is written to the override when it has its own text', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({
        'metatags[und][description][value]': 'Own',
        'field_summary[und][0][value]': 'S',
      });
      const rec = A.fillOne('meta_description', 'New', f);
      return {
        machineName: rec.machineName,
        previous: rec.previous,
        override: A.readValue(A.findField(f, 'metatags[und][description][value]')),
        summary: A.readValue(A.findField(f, 'field_summary[und][0][value]')),
      };
    });
    expect(r).toEqual({
      machineName: 'metatags[und][description][value]', previous: 'Own', override: 'New', summary: 'S',
    });
  });

  test('a field the form does not have is not filled, and nothing is marked', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const f = form({ 'body[und][0][value]': 'x' });
      return {
        title: A.fillOne('title', 'T', f),
        metaTitle: A.fillOne('meta_title', 'T', f),
        description: A.fillOne('meta_description', 'D', f),
        marked: A.filledFields(),
      };
    });
    expect(r).toEqual({ title: null, metaTitle: null, description: null, marked: [] });
  });

  test('a form without pathauto only fills the title', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({ title: 'Old', 'path[alias]': 'specialties/x' });
      const rec = A.fillOne('title', 'New', f);
      return {
        pathautoWasTicked: rec.pathautoWasTicked,
        previousAlias: rec.previousAlias,
        title: A.readValue(A.titleField(f)),
        alias: A.readValue(A.findField(f, 'path[alias]')),
      };
    });
    expect(r).toEqual({
      pathautoWasTicked: false, previousAlias: 'specialties/x',
      title: 'New', alias: 'specialties/x',
    });
  });

  test('a title fill with pathauto already off leaves the address box alone', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({ 'title_field[und][0][value]': 'Old', 'path[pathauto]': false, 'path[alias]': '' });
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/foo' });
      return {
        pathautoWasTicked: rec.pathautoWasTicked,
        alias: A.readValue(A.findField(f, 'path[alias]')),
      };
    });
    expect(r).toEqual({ pathautoWasTicked: false, alias: '' });
  });

  test('filling the title leaves the other fields alone', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({
        'title_field[und][0][value]': 'Old',
        'metatags[und][title][value]': 'Meta',
        'path[pathauto]': true,
        'path[alias]': 'news/foo',
      });
      A.fillOne('title', 'New', f);
      return A.readValue(A.findField(f, 'metatags[und][title][value]'));
    });
    expect(r).toBe('Meta');
  });
});

// --------------------------------------------------------------------- pathauto, undo

test.describe('the title and the address', () => {
  test('filling the title unticks pathauto and undo re-ticks it', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const f = form({ 'title_field[und][0][value]': 'Old', 'path[pathauto]': true });
      const rec = A.fillOne('title', 'New', f);
      const during = {
        pathauto: A.readValue(A.findField(f, 'path[pathauto]')),
        title: A.readValue(A.titleField(f)),
        marked: A.filledFields(),
        pathautoWasTicked: rec.pathautoWasTicked,
      };
      const undone = A.undoFill(rec, f);
      return {
        during,
        undone,
        pathauto: A.readValue(A.findField(f, 'path[pathauto]')),
        title: A.readValue(A.titleField(f)),
        marked: A.filledFields(),
      };
    });
    expect(r.during).toEqual({ pathauto: false, title: 'New', marked: ['title'], pathautoWasTicked: true });
    expect(r.undone).toBe(true);
    expect(r.pathauto).toBe(true);
    expect(r.title).toBe('Old');
    expect(r.marked).toEqual([]);
  });

  // Drupal 7 deletes a page's alias when it saves with pathauto OFF and an empty alias box,
  // which would move the page to /node/N: the thing keeping the address exists to prevent.
  test('with pathauto ticked and an empty alias box, the page\'s current address goes into the box', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({
        'title_field[und][0][value]': 'Old',
        'path[pathauto]': true,
        'path[alias]': '',
      });
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/caf%C3%A9' });
      const during = {
        alias: A.readValue(A.findField(f, 'path[alias]')),
        pathauto: A.readValue(A.findField(f, 'path[pathauto]')),
        previousAlias: rec.previousAlias,
        aliasWasDisabled: rec.aliasWasDisabled,
      };
      const undone = A.undoFill(rec, f);
      return {
        during,
        undone,
        alias: A.readValue(A.findField(f, 'path[alias]')),
        pathauto: A.readValue(A.findField(f, 'path[pathauto]')),
        title: A.readValue(A.titleField(f)),
      };
    });
    expect(r.during).toEqual({ alias: 'news/café', pathauto: false, previousAlias: '', aliasWasDisabled: false });
    expect(r.undone).toBe(true);
    expect(r.alias).toBe('');
    expect(r.pathauto).toBe(true);
    expect(r.title).toBe('Old');
  });

  test('a whitespace-only alias box counts as empty', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({ 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '  ' });
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/foo' });
      const during = A.readValue(A.findField(f, 'path[alias]'));
      A.undoFill(rec, f);
      return { during, after: A.readValue(A.findField(f, 'path[alias]')) };
    });
    expect(r).toEqual({ during: 'news/foo', after: '  ' });
  });

  test('with pathauto ticked and the alias box already holding the address, the box is not touched', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({
        'title_field[und][0][value]': 'Old',
        'path[pathauto]': true,
        'path[alias]': 'news/foo',
      });
      let aliasEvents = 0;
      f.find((x: any) => x.machineName === 'path[alias]').elements[0]
        .addEventListener('change', () => { aliasEvents++; });
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/other' });
      const during = {
        alias: A.readValue(A.findField(f, 'path[alias]')),
        previousAlias: rec.previousAlias,
        aliasWasDisabled: rec.aliasWasDisabled,
        pathauto: A.readValue(A.findField(f, 'path[pathauto]')),
        aliasEvents,
      };
      A.undoFill(rec, f);
      return {
        during,
        alias: A.readValue(A.findField(f, 'path[alias]')),
        aliasEventsAfterUndo: aliasEvents,
      };
    });
    expect(r.during).toEqual({
      alias: 'news/foo', previousAlias: 'news/foo', aliasWasDisabled: false, pathauto: false, aliasEvents: 0,
    });
    expect(r.alias).toBe('news/foo');
    expect(r.aliasEventsAfterUndo).toBe(0);
  });

  // R8a: Drupal renders the alias box disabled while pathauto is ticked, and a disabled input is
  // not submitted, so a filled alias would still be dropped on save.
  test('a disabled alias box is enabled to take the address, and undo disables it again', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form(
        { 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '' },
        ['path[alias]'],
      );
      const box = f.find((x: any) => x.machineName === 'path[alias]').elements[0] as HTMLInputElement;
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/foo' });
      const during = { value: box.value, disabled: box.disabled, aliasWasDisabled: rec.aliasWasDisabled };
      const undone = A.undoFill(rec, f);
      return {
        during, undone, value: box.value, disabled: box.disabled,
        pathauto: A.readValue(A.findField(f, 'path[pathauto]')), title: A.readValue(A.titleField(f)),
      };
    });
    expect(r.during).toEqual({ value: 'news/foo', disabled: false, aliasWasDisabled: true });
    expect(r.undone).toBe(true);
    expect(r.value).toBe('');
    expect(r.disabled).toBe(true);
    expect(r.pathauto).toBe(true);
    expect(r.title).toBe('Old');
  });

  test('an alias box that was already enabled is left enabled, and undo does not disable it', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({ 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '' });
      const box = f.find((x: any) => x.machineName === 'path[alias]').elements[0] as HTMLInputElement;
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/foo' });
      A.undoFill(rec, f);
      return { aliasWasDisabled: rec.aliasWasDisabled, disabled: box.disabled };
    });
    expect(r).toEqual({ aliasWasDisabled: false, disabled: false });
  });

  test('a disabled alias box is not touched when no alias is written', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form(
        { 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': 'news/foo' },
        ['path[alias]'],
      );
      const box = f.find((x: any) => x.machineName === 'path[alias]').elements[0] as HTMLInputElement;
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/other' });
      const during = { value: box.value, disabled: box.disabled, aliasWasDisabled: rec.aliasWasDisabled };
      A.undoFill(rec, f);
      return { during, value: box.value, disabled: box.disabled };
    });
    expect(r).toEqual({
      during: { value: 'news/foo', disabled: true, aliasWasDisabled: false }, value: 'news/foo', disabled: true,
    });
  });

  // R8b: unticking pathauto over an empty alias box with nothing to put in it would delete the
  // page's alias on save. Refuse outright instead of half-applying.
  test('with pathauto ticked, an empty box and no current address, nothing is filled', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const f = form({ 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '' });
      const wouldLose = A.titleFillWouldLoseAddress(f);
      const rec = A.fillOne('title', 'New', f);
      return {
        wouldLose,
        rec,
        title: A.readValue(A.titleField(f)),
        pathauto: A.readValue(A.findField(f, 'path[pathauto]')),
        alias: A.readValue(A.findField(f, 'path[alias]')),
        marked: A.filledFields(),
      };
    });
    expect(r).toEqual({ wouldLose: true, rec: null, title: 'Old', pathauto: true, alias: '', marked: [] });
  });

  test('a null, empty or /node/N current address is no address, and the fill is refused', async ({ page }) => {
    // Each form replaces the last, so each is read before the next is built.
    const r = await run(page, (A, form) => {
      const out: Record<string, unknown> = {};
      const cases: [string, string | null | undefined][] = [
        ['null', null], ['empty', ''], ['spaces', '   '], ['slash', '/'],
        ['node', '/node/123'], ['bare', 'node/9/'], ['url', 'https://www.cuimc.columbia.edu/node/123'],
      ];
      for (const [label, currentAlias] of cases) {
        A.resetFilled();
        const f = form({ 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '' });
        const wouldLose = A.titleFillWouldLoseAddress(f, { currentAlias });
        const rec = A.fillOne('title', 'New', f, { currentAlias });
        out[label] = {
          wouldLose, rec,
          title: A.readValue(A.titleField(f)),
          pathauto: A.readValue(A.findField(f, 'path[pathauto]')),
          alias: A.readValue(A.findField(f, 'path[alias]')),
          marked: A.filledFields(),
        };
      }
      return out;
    });
    const refused = { wouldLose: true, rec: null, title: 'Old', pathauto: true, alias: '', marked: [] };
    expect(r).toEqual({
      null: refused, empty: refused, spaces: refused, slash: refused,
      node: refused, bare: refused, url: refused,
    });
  });

  test('titleFillWouldLoseAddress is false everywhere the address is kept or was never at risk', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const named = { 'title_field[und][0][value]': 'Old' };
      return {
        // an address to put in the box
        withAddress: A.titleFillWouldLoseAddress(
          form({ ...named, 'path[pathauto]': true, 'path[alias]': '' }), { currentAlias: '/news/foo' }),
        // the box already holds one
        boxHolds: A.titleFillWouldLoseAddress(
          form({ ...named, 'path[pathauto]': true, 'path[alias]': 'news/foo' })),
        // pathauto is already off: nothing is unticked
        pathautoOff: A.titleFillWouldLoseAddress(
          form({ ...named, 'path[pathauto]': false, 'path[alias]': '' })),
        // no pathauto on the form at all
        noPathauto: A.titleFillWouldLoseAddress(form({ ...named, 'path[alias]': '' })),
        // no alias box to lose anything from
        noAliasBox: A.titleFillWouldLoseAddress(form({ ...named, 'path[pathauto]': true })),
      };
    });
    expect(r).toEqual({
      withAddress: false, boxHolds: false, pathautoOff: false, noPathauto: false, noAliasBox: false,
    });
  });

  test('if the page will not keep the address in the box, everything is put back', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const f = form(
        { 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '' },
        ['path[alias]'],
      );
      const box = f.find((x: any) => x.machineName === 'path[alias]').elements[0] as HTMLInputElement;
      // Something on the page empties the box as soon as it is written.
      box.addEventListener('input', () => { box.value = ''; });
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/foo' });
      return {
        rec,
        title: A.readValue(A.titleField(f)),
        pathauto: A.readValue(A.findField(f, 'path[pathauto]')),
        value: box.value,
        disabled: box.disabled,
        marked: A.filledFields(),
      };
    });
    expect(r).toEqual({ rec: null, title: 'Old', pathauto: true, value: '', disabled: true, marked: [] });
  });

  test('with pathauto ticked and no alias box at all there is nothing to keep, so the fill goes ahead', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({ 'title_field[und][0][value]': 'Old', 'path[pathauto]': true });
      const rec = A.fillOne('title', 'New', f);
      return { previousAlias: rec.previousAlias, ticked: rec.pathautoWasTicked, aliasWasDisabled: rec.aliasWasDisabled };
    });
    expect(r).toEqual({ previousAlias: null, ticked: true, aliasWasDisabled: false });
  });

  test('the title fill does not refuse when only another kind of field is involved', async ({ page }) => {
    // A search title never touches the address, whatever the alias box holds.
    const r = await run(page, (A, form) => {
      const f = form({
        'metatags[und][title][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '',
      });
      const rec = A.fillOne('meta_title', 'New', f);
      return { filled: rec?.filled, pathauto: A.readValue(A.findField(f, 'path[pathauto]')) };
    });
    expect(r).toEqual({ filled: 'New', pathauto: true });
  });

  test('the address may arrive as a full web address, or with a stray escape, and is still a usable alias', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const full = form({ 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '' });
      A.fillOne('title', 'New', full, { currentAlias: 'https://www.cuimc.columbia.edu/news/caf%C3%A9' });
      const aliasFromUrl = A.readValue(A.findField(full, 'path[alias]'));

      const broken = form({ 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '' });
      A.fillOne('title', 'New', broken, { currentAlias: '/news/100%' });
      return { aliasFromUrl, aliasKeptRaw: A.readValue(A.findField(broken, 'path[alias]')) };
    });
    expect(r).toEqual({ aliasFromUrl: 'news/café', aliasKeptRaw: 'news/100%' });
  });

  test('if the page refuses the untick, the title is put back and nothing is filled', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const f = form({ 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '' });
      // Something on the page puts the tick straight back.
      const box = f.find((x: any) => x.machineName === 'path[pathauto]').elements[0] as HTMLInputElement;
      box.addEventListener('change', () => { box.checked = true; });
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/foo' });
      return {
        rec,
        title: A.readValue(A.titleField(f)),
        alias: A.readValue(A.findField(f, 'path[alias]')),
        marked: A.filledFields(),
      };
    });
    expect(r).toEqual({ rec: null, title: 'Old', alias: '', marked: [] });
  });

  test('letting the address change re-ticks pathauto without touching the title', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({ 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '' });
      A.fillOne('title', 'New', f, { currentAlias: '/news/foo' });
      A.letAddressChange(f);
      const out = { pathauto: A.readValue(A.findField(f, 'path[pathauto]')), title: A.readValue(A.titleField(f)) };
      // And a form with no pathauto box is simply left as it is.
      A.letAddressChange(form({ title: 'x' }));
      return out;
    });
    expect(r).toEqual({ pathauto: true, title: 'New' });
  });
});

// -------------------------------------------------------------------------- undo

test.describe('undo', () => {
  test('undo is withdrawn once the field no longer holds the filled text', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({ 'metatags[und][title][value]': 'Old' });
      const rec = A.fillOne('meta_title', 'New', f);
      const before = A.canUndo(rec, f);
      A.writeValue(A.findField(f, 'metatags[und][title][value]'), 'New, edited by hand');
      return { before, after: A.canUndo(rec, f) };
    });
    expect(r).toEqual({ before: true, after: false });
  });

  test('a withdrawn undo changes nothing', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const f = form({ 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '' });
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/foo' });
      A.writeValue(A.titleField(f), 'Typed over it');
      const undone = A.undoFill(rec, f);
      return {
        undone,
        title: A.readValue(A.titleField(f)),
        pathauto: A.readValue(A.findField(f, 'path[pathauto]')),
        alias: A.readValue(A.findField(f, 'path[alias]')),
        marked: A.filledFields(),
      };
    });
    expect(r).toEqual({
      undone: false, title: 'Typed over it', pathauto: false, alias: 'news/foo', marked: ['title'],
    });
  });

  test('undo of a search title or description restores the old text and takes the mark back', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const f = form({
        'metatags[und][title][value]': 'Old title',
        'metatags[und][description][value]': '[node:summary]',
        'field_summary[und][0][value]': 'Old summary',
      });
      const a = A.fillOne('meta_title', 'New title', f);
      const b = A.fillOne('meta_description', 'New summary', f);
      const marked = A.filledFields();
      const undoneB = A.undoFill(b, f);
      const afterB = A.filledFields();
      const undoneA = A.undoFill(a, f);
      return {
        marked, undoneB, afterB, undoneA, afterA: A.filledFields(),
        title: A.readValue(A.findField(f, 'metatags[und][title][value]')),
        summary: A.readValue(A.findField(f, 'field_summary[und][0][value]')),
        override: A.readValue(A.findField(f, 'metatags[und][description][value]')),
      };
    });
    expect(r).toEqual({
      marked: ['meta_description', 'meta_title'], undoneB: true, afterB: ['meta_title'],
      undoneA: true, afterA: [],
      title: 'Old title', summary: 'Old summary', override: '[node:summary]',
    });
  });

  test('undo is not offered for a field that has left the form', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({ 'metatags[und][title][value]': 'Old' });
      const rec = A.fillOne('meta_title', 'New', f);
      return { gone: A.canUndo(rec, form({ title: 'Other' })), undone: A.undoFill(rec, form({ title: 'Other' })) };
    });
    expect(r).toEqual({ gone: false, undone: false });
  });
});
