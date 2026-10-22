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
        aliasFilled: rec.aliasFilled,
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
    expect(r.during).toEqual({
      alias: 'news/café', pathauto: false, previousAlias: '', aliasFilled: 'news/café', aliasWasDisabled: false,
    });
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
        aliasFilled: rec.aliasFilled,
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
      alias: 'news/foo', previousAlias: 'news/foo', aliasFilled: 'news/foo', aliasWasDisabled: false,
      pathauto: false, aliasEvents: 0,
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

  // R8a': the box needs enabling whether or not it needed the address, or it is not submitted.
  test('a disabled alias box that already holds the address is enabled, and undo disables it again', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form(
        { 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': 'news/foo' },
        ['path[alias]'],
      );
      const box = f.find((x: any) => x.machineName === 'path[alias]').elements[0] as HTMLInputElement;
      let aliasEvents = 0;
      box.addEventListener('change', () => { aliasEvents++; });
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/other' });
      const during = {
        value: box.value, disabled: box.disabled, aliasWasDisabled: rec.aliasWasDisabled, aliasEvents,
      };
      const undone = A.undoFill(rec, f);
      return {
        during, undone, value: box.value, disabled: box.disabled, aliasEvents,
        pathauto: A.readValue(A.findField(f, 'path[pathauto]')), title: A.readValue(A.titleField(f)),
      };
    });
    expect(r.during).toEqual({ value: 'news/foo', disabled: false, aliasWasDisabled: true, aliasEvents: 0 });
    expect(r.undone).toBe(true);
    expect(r.value).toBe('news/foo');
    expect(r.disabled).toBe(true);
    expect(r.aliasEvents).toBe(0);
    expect(r.pathauto).toBe(true);
    expect(r.title).toBe('Old');
  });

  test('a disabled alias box is left alone when pathauto was not ticked', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form(
        { 'title_field[und][0][value]': 'Old', 'path[pathauto]': false, 'path[alias]': 'news/foo' },
        ['path[alias]'],
      );
      const box = f.find((x: any) => x.machineName === 'path[alias]').elements[0] as HTMLInputElement;
      const rec = A.fillOne('title', 'New', f);
      return { disabled: box.disabled, aliasWasDisabled: rec.aliasWasDisabled };
    });
    expect(r).toEqual({ disabled: true, aliasWasDisabled: false });
  });

  // Once pathauto is off the box is editable, and what is typed there is the person's. So is the
  // unticked pathauto: ticked, Drupal 7 regenerates the alias on save and ignores the box.
  test('undo leaves an alias typed after the fill alone: the box, its enabled state and pathauto', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const f = form(
        { 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': '' },
        ['path[alias]'],
      );
      const box = f.find((x: any) => x.machineName === 'path[alias]').elements[0] as HTMLInputElement;
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/foo' });
      const filled = { aliasFilled: rec.aliasFilled, value: box.value, disabled: box.disabled };
      A.writeValue(A.findField(f, 'path[alias]'), 'news/bar');
      const canUndo = A.canUndo(rec, f);
      const undone = A.undoFill(rec, f);
      return {
        filled, canUndo, undone,
        title: A.readValue(A.titleField(f)),
        pathauto: A.readValue(A.findField(f, 'path[pathauto]')),
        value: box.value,
        disabled: box.disabled,
        marked: A.filledFields(),
      };
    });
    expect(r.filled).toEqual({ aliasFilled: 'news/foo', value: 'news/foo', disabled: false });
    expect(r.canUndo).toBe(true);
    expect(r.undone).toBe(true);
    expect(r.title).toBe('Old');
    expect(r.pathauto).toBe(false);
    expect(r.value).toBe('news/bar');
    expect(r.disabled).toBe(false);
    expect(r.marked).toEqual([]);
  });

  test('undo leaves an alias edited after the fill alone, and pathauto unticked, when the box already held one', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form(
        { 'title_field[und][0][value]': 'Old', 'path[pathauto]': true, 'path[alias]': 'news/foo' },
        ['path[alias]'],
      );
      const box = f.find((x: any) => x.machineName === 'path[alias]').elements[0] as HTMLInputElement;
      const rec = A.fillOne('title', 'New', f, { currentAlias: '/news/foo' });
      A.writeValue(A.findField(f, 'path[alias]'), 'news/foo-2');
      const undone = A.undoFill(rec, f);
      return { undone, value: box.value, disabled: box.disabled, pathauto: A.readValue(A.findField(f, 'path[pathauto]')) };
    });
    expect(r).toEqual({ undone: true, value: 'news/foo-2', disabled: false, pathauto: false });
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

// ------------------------------------------------- a search title and the site's own name

test.describe("a search title and the site's own name (ruling R16)", () => {
  /**
   * Drupal's metatag module ships the search title as `[node:title] | [site:name]`. Varys serves
   * its suggestion without the site's name, so writing it over the whole field would drop the
   * name from the live title. A token tail stays; a literal one goes, since the site appends its
   * own name there itself.
   */
  test('a token tail is kept after the suggestion, and that is what Undo is offered on', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const f = form({ 'metatags[und][title][value]': '[node:title] | [site:name]' });
      const shown = A.valueToFill('meta_title', 'New Title', f);
      const rec = A.fillOne('meta_title', 'New Title', f);
      return {
        shown,
        rec,
        now: A.readValue(A.findField(f, 'metatags[und][title][value]')),
        canUndo: A.canUndo(rec, f),
        marked: A.filledFields(),
      };
    });
    expect(r.shown).toBe('New Title | [site:name]');
    expect(r.now).toBe('New Title | [site:name]');
    expect(r.rec).toMatchObject({ previous: '[node:title] | [site:name]', filled: 'New Title | [site:name]' });
    expect(r.canUndo).toBe(true);
    expect(r.marked).toEqual(['meta_title']);
  });

  test('Undo puts the token pattern back', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({ 'metatags[und][title][value]': '[node:title] | [site:name]' });
      const rec = A.fillOne('meta_title', 'New Title', f);
      const undone = A.undoFill(rec, f);
      return { undone, now: A.readValue(A.findField(f, 'metatags[und][title][value]')) };
    });
    expect(r).toEqual({ undone: true, now: '[node:title] | [site:name]' });
  });

  test('a literal tail is not kept', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({ 'metatags[und][title][value]': 'Old Title | ColumbiaDoctors' });
      const rec = A.fillOne('meta_title', 'New Title', f);
      return { filled: rec.filled, now: A.readValue(A.findField(f, 'metatags[und][title][value]')) };
    });
    expect(r).toEqual({ filled: 'New Title', now: 'New Title' });
  });

  test('a field with no tail, or a token with no separator, takes the suggestion as it is', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const plain = form({ 'metatags[und][title][value]': 'Old Title' });
      const a = A.fillOne('meta_title', 'New Title', plain).filled;
      const empty = form({ 'metatags[und][title][value]': '' });
      const b = A.fillOne('meta_title', 'New Title', empty).filled;
      const bare = form({ 'metatags[und][title][value]': '[node:title]' });
      const c = A.fillOne('meta_title', 'New Title', bare).filled;
      return [a, b, c];
    });
    expect(r).toEqual(['New Title', 'New Title', 'New Title']);
  });

  test('only the LAST segment counts, and a suggestion already ending in the tail is not doubled', async ({ page }) => {
    const r = await run(page, (A, form) => {
      // One form at a time: form() replaces the page's form, and fields are found by name.
      const literalLast = form({ 'metatags[und][title][value]': '[node:title] | [site:name] | Columbia' });
      const a = A.valueToFill('meta_title', 'New', literalLast);
      const tokenLast = form({ 'metatags[und][title][value]': 'Old | Section | [site:name]' });
      return [a, A.valueToFill('meta_title', 'New', tokenLast), A.valueToFill('meta_title', 'New | [site:name]', tokenLast)];
    });
    expect(r).toEqual(['New', 'New | [site:name]', 'New | [site:name]']);
  });

  test('the page title and the description are written as they are, whatever they hold', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const f = form({
        'title_field[und][0][value]': 'Old | [site:name]',
        'metatags[und][description][value]': 'Old | [site:name]',
      });
      return [A.valueToFill('title', 'New', f), A.valueToFill('meta_description', 'New', f)];
    });
    expect(r).toEqual(['New', 'New']);
  });
});

// ------------------------------------------------------- where a description goes, in words

test.describe('descriptionPlacement', () => {
  test('each of the four cases', async ({ page }) => {
    const r = await run(page, (A, form) => ({
      summaryFollowed: A.descriptionPlacement(form({
        'metatags[und][description][value]': '[node:summary]', 'field_summary[und][0][value]': 'S',
      })),
      summaryOnly: A.descriptionPlacement(form({ 'field_summary[und][0][value]': 'S' })),
      overrideOverSummary: A.descriptionPlacement(form({
        'metatags[und][description][value]': 'Own', 'field_summary[und][0][value]': 'S',
      })),
      overrideEmpty: A.descriptionPlacement(form({
        'metatags[und][description][value]': '', 'field_summary[und][0][value]': 'S',
      })),
      overrideOtherToken: A.descriptionPlacement(form({
        'metatags[und][description][value]': '[node:body]', 'field_summary[und][0][value]': 'S',
      })),
      overrideNoSummary: A.descriptionPlacement(form({ 'metatags[und][description][value]': 'Own' })),
      neither: A.descriptionPlacement(form({ title: 'T' })),
    }));
    expect(r).toEqual({
      summaryFollowed: 'summary_followed',
      summaryOnly: 'summary_only',
      overrideOverSummary: 'override_over_summary',
      overrideEmpty: 'override_only',
      overrideOtherToken: 'override_only',
      overrideNoSummary: 'override_only',
      neither: null,
    });
  });
});

// ------------------------------------------------- fills carried through a re-render (R18)

test.describe('adoptCarriedFills', () => {
  test('a record is adopted, and its field marked, only while the field still holds the fill', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const before = form({ 'metatags[und][title][value]': 'Old', 'title_field[und][0][value]': 'T' });
      const meta = A.fillOne('meta_title', 'New', before);
      const title = A.fillOne('title', 'Better', before);
      A.resetFilled();
      // The re-render: the search title still holds the fill, the title was edited by hand.
      const after = form({ 'metatags[und][title][value]': 'New', 'title_field[und][0][value]': 'Better, by hand' });
      const adopted = A.adoptCarriedFills({ records: [meta, title], addressKept: false, headings: false }, after);
      return { kinds: Object.keys(adopted.records), meta: adopted.records.meta_title, marked: A.filledFields() };
    });
    expect(r.kinds).toEqual(['meta_title']);
    expect(r.meta).toMatchObject({ previous: 'Old', filled: 'New' });
    expect(r.marked).toEqual(['meta_title']);
  });

  test('an adopted record undoes as it would have before the re-render', async ({ page }) => {
    const r = await run(page, (A, form) => {
      const before = form({ 'metatags[und][title][value]': 'Old' });
      const meta = A.fillOne('meta_title', 'New', before);
      const after = form({ 'metatags[und][title][value]': 'New' });
      const adopted = A.adoptCarriedFills({ records: [meta], addressKept: false, headings: false }, after);
      const undone = A.undoFill(adopted.records.meta_title, after);
      return { undone, now: A.readValue(A.findField(after, 'metatags[und][title][value]')), marked: A.filledFields() };
    });
    expect(r).toEqual({ undone: true, now: 'Old', marked: [] });
  });

  test('the keep-address note comes back only while pathauto is still off; headings come back if marked', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const off = A.adoptCarriedFills({ records: [], addressKept: true, headings: true },
        form({ 'path[pathauto]': false, 'path[alias]': 'a/b' }));
      const marked = A.filledFields();
      A.resetFilled();
      const on = A.adoptCarriedFills({ records: [], addressKept: true, headings: false },
        form({ 'path[pathauto]': true, 'path[alias]': 'a/b' }));
      return { off: off.addressKept, headings: off.headings, marked, on: on.addressKept, after: A.filledFields() };
    });
    expect(r).toEqual({ off: true, headings: true, marked: ['headings'], on: false, after: [] });
  });

  test('nothing carried, or something that is not a carried record, adopts nothing', async ({ page }) => {
    const r = await run(page, (A, form) => {
      A.resetFilled();
      const f = form({ 'metatags[und][title][value]': 'New' });
      const bogus = { kind: 'meta_title', machineName: 'metatags[und][title][value]', filled: 'New' };
      return [
        A.adoptCarriedFills(null, f),
        A.adoptCarriedFills({ records: [bogus], addressKept: false, headings: false }, f),
        A.adoptCarriedFills({ records: 'no', addressKept: true, headings: true }, f),
        A.filledFields(),
      ];
    });
    const empty = { records: {}, addressKept: false, headings: false };
    expect(r).toEqual([empty, empty, empty, []]);
  });
});
