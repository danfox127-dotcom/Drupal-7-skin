import { test, expect, type Page } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * Adding the doctors a Varys draft quotes to Related Profiles, and taking them back.
 *
 * A wrong doctor on a medical site is worse than none, so a name goes in only when the site's
 * own autocomplete answers with exactly ONE entry whose name is the directory full name. Every
 * other answer — two people with that name, only a longer name, an error — adds nobody.
 *
 * The page is the real ColumbiaDoctors `node/add/news` capture, served from a real origin so the
 * lookup is an actual same-origin fetch (as in clone-references.spec.ts), with the one thing a
 * capture cannot hold: Drupal's AJAX. "Add another item" appends the next row after a delay the
 * test controls, bound to MOUSEDOWN with the click swallowed as Drupal 7 does it.
 */

const ORIGIN = 'https://doctors.example.edu';
const ENDPOINT_Q = 'entityreference/autocomplete/single/field_cola_cups_profiles/node/news/NULL/';
const NEWS_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'captured', 'news.html'), 'utf8');

let bundle: string;

test.beforeAll(async () => {
  const result = await esbuild.build({
    stdin: {
      contents: `export * from './src/lib/varys/profileFill';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true, write: false, format: 'iife', globalName: 'F',
    platform: 'browser', target: 'es2020',
  });
  bundle = result.outputFiles[0].text;
});

interface Options {
  /** Milliseconds before "Add another item" renders the next row; null never renders one. */
  addDelayMs?: number | null;
  /** Values of rows already on the form, first row first. */
  prefilled?: string[];
  /** Answers the lookup with this status instead of the autocomplete. */
  status?: number;
  /** Leaves the hidden lookup address blank, as the capture itself does. */
  noPath?: boolean;
}

/** `answers` maps the requested name to what Drupal's entityreference autocomplete returns. */
async function openNewsForm(
  page: Page,
  answers: Record<string, Record<string, string>>,
  options: Options = {}
) {
  const asked: string[] = [];

  // Registered first so the specific route below wins; this one only catches what leaks.
  await page.route('**', route => route.abort());
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/node/add/news') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: NEWS_HTML });
    }
    const q = url.searchParams.get('q') ?? '';
    if (url.pathname === '/index.php' && q.startsWith(ENDPOINT_Q)) {
      asked.push(q.slice(ENDPOINT_Q.length));
      if (options.status) return route.fulfill({ status: options.status, body: 'nope' });
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(answers[q.slice(ENDPOINT_Q.length)] ?? {}),
      });
    }
    return route.abort();
  });

  await page.goto(`${ORIGIN}/node/add/news`);

  await page.evaluate(({ lookup, delayMs, prefilled }) => {
    const w = window as any;
    w.__adds = 0;
    w.__submits = 0;

    const form = document.getElementById('news-node-form')!;
    form.addEventListener('submit', event => { event.preventDefault(); w.__submits++; });

    if (lookup) {
      (document.getElementById('edit-field-cola-cups-profiles-und-0-target-id-autocomplete') as HTMLInputElement)
        .value = lookup;
    }

    const tbody = document.getElementById('field-cola-cups-profiles-values')!.querySelector('tbody')!;
    const addRow = () => {
      const rows = tbody.querySelectorAll('tr');
      const next = rows.length;
      const row = rows[0].cloneNode(true) as HTMLElement;
      row.querySelectorAll('[name], [id], [for]').forEach(el => {
        for (const attr of ['name', 'id', 'for']) {
          const old = el.getAttribute(attr);
          if (old === null) continue;
          el.setAttribute(attr, old.replace('[und][0]', `[und][${next}]`).replace('-und-0-', `-und-${next}-`));
        }
      });
      row.querySelectorAll<HTMLInputElement>('input[type="text"]').forEach(input => { input.value = ''; });
      tbody.appendChild(row);
    };

    const button = document.querySelector<HTMLInputElement>('input[name="field_cola_cups_profiles_add_more"]')!;
    // Drupal 7 answers the MOUSEDOWN and swallows the click.
    button.addEventListener('click', event => event.preventDefault());
    button.addEventListener('mousedown', event => {
      event.preventDefault();
      w.__adds++;
      if (delayMs !== null) setTimeout(addRow, delayMs);
    });

    prefilled.forEach((value, index) => {
      if (index > 0) addRow();
      document.querySelector<HTMLInputElement>(
        `[name="field_cola_cups_profiles[und][${index}][target_id]"]`
      )!.value = value;
    });
  }, {
    lookup: options.noPath ? '' : `${ORIGIN}/index.php?q=${ENDPOINT_Q.slice(0, -1)}`,
    delayMs: options.addDelayMs === undefined ? 30 : options.addDelayMs,
    prefilled: options.prefilled ?? [],
  });

  await page.addScriptTag({ content: bundle });

  return { asked: () => asked };
}

const NO_ID = (name: string) => ({ [name]: name });

/** What the form holds now: every Related Profiles row, and how many times the form was driven. */
function formState(page: Page) {
  return page.evaluate(() => ({
    values: Array.from(document.querySelectorAll<HTMLInputElement>(
      '[name^="field_cola_cups_profiles[und]"][name$="[target_id]"]'
    )).map(input => [input.name, input.value]),
    adds: (window as any).__adds as number,
    submits: (window as any).__submits as number,
  }));
}

function add(page: Page, names: string[], addTimeoutMs?: number) {
  return page.evaluate(([list, timeout]) => (window as any).F.addProfiles(
    list,
    document.querySelector('[name="field_cola_cups_profiles[und][0][target_id]"]'),
    ...(timeout === null ? [] : [timeout])
  ), [names, addTimeoutMs ?? null] as const);
}

const ROW = (delta: number) => `field_cola_cups_profiles[und][${delta}][target_id]`;

test.describe('adding a quoted doctor', () => {
  test('one exact match fills the empty first row without pressing "Add another item"', async ({ page }) => {
    await openNewsForm(page, { 'Jacqueline L Steele, MD': NO_ID('Jacqueline L Steele, MD (1234)') });

    const outcomes = await add(page, ['Jacqueline L Steele, MD']);

    expect(outcomes).toMatchObject([{ name: 'Jacqueline L Steele, MD', result: 'added', delta: 0 }]);
    const state = await formState(page);
    // The value written is the site's own key, id included — never the bare name.
    expect(state.values).toEqual([[ROW(0), 'Jacqueline L Steele, MD (1234)']]);
    expect(state.adds).toBe(0);
    expect(state.submits).toBe(0);
  });

  test('a second doctor goes in a row added after the first, and the form is never submitted', async ({ page }) => {
    await openNewsForm(page, {
      'Jane Doe, MD': NO_ID('Jane Doe, MD (1)'),
      'John Roe, DO': NO_ID('John Roe, DO (2)'),
    });

    const outcomes = await add(page, ['Jane Doe, MD', 'John Roe, DO']);

    expect(outcomes).toMatchObject([
      { name: 'Jane Doe, MD', result: 'added', delta: 0 },
      { name: 'John Roe, DO', result: 'added', delta: 1 },
    ]);
    const state = await formState(page);
    expect(state.values).toEqual([[ROW(0), 'Jane Doe, MD (1)'], [ROW(1), 'John Roe, DO (2)']]);
    expect(state.adds).toBe(1);
    expect(state.submits).toBe(0);
  });

  test('two exact autocomplete matches add nobody', async ({ page }) => {
    const endpoint = await openNewsForm(page, {
      'Jane Doe, MD': { 'Jane Doe, MD (1)': 'Jane Doe, MD', 'Jane Doe, MD (2)': 'Jane Doe, MD' },
      'John Roe, DO': NO_ID('John Roe, DO (2)'),
    });

    const outcomes = await add(page, ['Jane Doe, MD', 'John Roe, DO']);

    expect(outcomes[0]).toMatchObject({ name: 'Jane Doe, MD', result: 'ambiguous', delta: null });
    // Nobody was added for the ambiguous name, so the empty first row was still free for the next.
    expect(outcomes[1]).toMatchObject({ name: 'John Roe, DO', result: 'added', delta: 0 });
    const state = await formState(page);
    expect(state.values).toEqual([[ROW(0), 'John Roe, DO (2)']]);
    expect(state.adds).toBe(0);
    expect(endpoint.asked()).toEqual(['Jane Doe, MD', 'John Roe, DO']);
  });

  test('a near match is not an exact match', async ({ page }) => {
    await openNewsForm(page, { 'Jane Doe, MD': { 'Jane Doe, MD, PhD (1)': 'Jane Doe, MD, PhD' } });

    const outcomes = await add(page, ['Jane Doe, MD']);

    expect(outcomes).toMatchObject([{ name: 'Jane Doe, MD', result: 'not_found', delta: null }]);
    const state = await formState(page);
    expect(state.values).toEqual([[ROW(0), '']]);
    expect(state.adds).toBe(0);
  });

  test('a doctor already in Related Profiles is not added twice', async ({ page }) => {
    const endpoint = await openNewsForm(page, {
      'Jane Doe, MD': NO_ID('Jane Doe, MD (1)'),
    }, { prefilled: ['jane  doe, MD (1)'] });

    const outcomes = await add(page, ['Jane Doe, MD']);

    expect(outcomes).toMatchObject([{ name: 'Jane Doe, MD', result: 'already', delta: null }]);
    const state = await formState(page);
    expect(state.values).toEqual([[ROW(0), 'jane  doe, MD (1)']]);
    expect(state.adds).toBe(0);
    // Not even asked about: the form already answers it.
    expect(endpoint.asked()).toEqual([]);
  });

  test('the site\'s quoted key (every name with a comma) is found and written exactly as given', async ({ page }) => {
    // Drupal 7 quotes the whole key when the label holds a comma, as every doctor's does.
    await openNewsForm(page, { 'Jacqueline L Steele, MD': NO_ID('"Jacqueline L Steele, MD (1234)"') });

    const outcomes = await add(page, ['Jacqueline L Steele, MD']);

    expect(outcomes).toMatchObject([
      { name: 'Jacqueline L Steele, MD', result: 'added', delta: 0, value: '"Jacqueline L Steele, MD (1234)"' },
    ]);
    expect((await formState(page)).values).toEqual([[ROW(0), '"Jacqueline L Steele, MD (1234)"']]);
  });

  test('a doctor already in Related Profiles as Drupal quotes it is not added twice', async ({ page }) => {
    const endpoint = await openNewsForm(page, {
      'Jane Doe, MD': NO_ID('"Jane Doe, MD (1)"'),
    }, { prefilled: ['"Jane  Doe, MD (1)"'] });

    const outcomes = await add(page, ['Jane Doe, MD']);

    expect(outcomes).toMatchObject([{ name: 'Jane Doe, MD', result: 'already', delta: null }]);
    expect((await formState(page)).values).toEqual([[ROW(0), '"Jane  Doe, MD (1)"']]);
    expect(endpoint.asked()).toEqual([]);
  });

  test('a name repeated in one call is handled once', async ({ page }) => {
    const endpoint = await openNewsForm(page, { 'Jane Doe, MD': NO_ID('Jane Doe, MD (1)') });

    const outcomes = await add(page, ['Jane Doe, MD', 'Jane Doe, MD']);

    expect(outcomes).toMatchObject([{ name: 'Jane Doe, MD', result: 'added', delta: 0 }]);
    expect((await formState(page)).values).toEqual([[ROW(0), 'Jane Doe, MD (1)']]);
    expect(endpoint.asked()).toEqual(['Jane Doe, MD']);
  });

  test('a lookup that fails writes nothing and adds no row', async ({ page }) => {
    await openNewsForm(page, {}, { status: 500, prefilled: ['Existing Doc, MD (9)'] });

    const outcomes = await add(page, ['Jane Doe, MD']);

    expect(outcomes).toMatchObject([{ name: 'Jane Doe, MD', result: 'unavailable', delta: null }]);
    const state = await formState(page);
    expect(state.values).toEqual([[ROW(0), 'Existing Doc, MD (9)']]);
    expect(state.adds).toBe(0);
  });

  test('a form that exposes no lookup address is unavailable, not guessed', async ({ page }) => {
    const endpoint = await openNewsForm(page, { 'Jane Doe, MD': NO_ID('Jane Doe, MD (1)') }, { noPath: true });

    const outcomes = await add(page, ['Jane Doe, MD']);

    expect(outcomes).toMatchObject([{ name: 'Jane Doe, MD', result: 'unavailable', delta: null }]);
    expect((await formState(page)).values).toEqual([[ROW(0), '']]);
    expect(endpoint.asked()).toEqual([]);
  });

  test('a failed add-another leaves later names attempted', async ({ page }) => {
    // The first row is taken, so the first name needs "Add another item" — which never answers.
    const endpoint = await openNewsForm(page, {
      'Jane Doe, MD': NO_ID('Jane Doe, MD (1)'),
    }, { addDelayMs: null, prefilled: ['Existing Doc, MD (9)'] });

    const outcomes = await add(page, ['Jane Doe, MD', 'Nobody Here, MD'], 300);

    expect(outcomes).toMatchObject([
      { name: 'Jane Doe, MD', result: 'unavailable', delta: null },
      { name: 'Nobody Here, MD', result: 'not_found', delta: null },
    ]);
    expect(endpoint.asked()).toEqual(['Jane Doe, MD', 'Nobody Here, MD']);
    expect((await formState(page)).values).toEqual([[ROW(0), 'Existing Doc, MD (9)']]);
  });
});

test.describe('taking the added doctors back', () => {
  function undo(page: Page, outcomes: unknown) {
    return page.evaluate(list => (window as any).F.undoProfiles(list), outcomes);
  }

  test('undo clears only the rows it added', async ({ page }) => {
    await openNewsForm(page, {
      'Jane Doe, MD': NO_ID('Jane Doe, MD (1)'),
      'John Roe, DO': NO_ID('John Roe, DO (2)'),
    }, { prefilled: ['Existing Doc, MD (9)'] });

    const outcomes = await add(page, ['Jane Doe, MD', 'John Roe, DO', 'Existing Doc, MD']);
    expect(outcomes.map((o: { result: string }) => o.result)).toEqual(['added', 'added', 'already']);
    expect((await formState(page)).values).toEqual([
      [ROW(0), 'Existing Doc, MD (9)'], [ROW(1), 'Jane Doe, MD (1)'], [ROW(2), 'John Roe, DO (2)'],
    ]);

    await undo(page, outcomes);

    // The person's own row stays; the two rows this call added are emptied (Drupal ignores an
    // empty row on save), and no row is removed.
    expect((await formState(page)).values).toEqual([
      [ROW(0), 'Existing Doc, MD (9)'], [ROW(1), ''], [ROW(2), ''],
    ]);
  });

  test('undo does not clear a row the person changed', async ({ page }) => {
    await openNewsForm(page, {
      'Jane Doe, MD': NO_ID('Jane Doe, MD (1)'),
      'John Roe, DO': NO_ID('John Roe, DO (2)'),
    });

    const outcomes = await add(page, ['Jane Doe, MD', 'John Roe, DO']);
    await page.evaluate(() => {
      document.querySelector<HTMLInputElement>('[name="field_cola_cups_profiles[und][0][target_id]"]')!
        .value = 'Someone Else, MD (5)';
    });

    await undo(page, outcomes);

    expect((await formState(page)).values).toEqual([
      [ROW(0), 'Someone Else, MD (5)'], [ROW(1), ''],
    ]);
  });

  test('undo clears a quoted value it wrote, and one it has no record of by its quoted name', async ({ page }) => {
    await openNewsForm(page, { 'Jane Doe, MD': NO_ID('"Jane Doe, MD (1)"') });

    const outcomes = await add(page, ['Jane Doe, MD']);
    expect((await formState(page)).values).toEqual([[ROW(0), '"Jane Doe, MD (1)"']]);
    await undo(page, outcomes);
    expect((await formState(page)).values).toEqual([[ROW(0), '']]);

    // An outcome from before `value` was recorded is compared by name: quoted, it still matches.
    await page.evaluate(() => {
      document.querySelector<HTMLInputElement>('[name="field_cola_cups_profiles[und][0][target_id]"]')!
        .value = '"Jane Doe, MD (1)"';
    });
    await undo(page, [{ name: 'Jane Doe, MD', result: 'added', delta: 0 }]);
    expect((await formState(page)).values).toEqual([[ROW(0), '']]);
  });

  test('undo of a call that added nothing changes nothing', async ({ page }) => {
    await openNewsForm(page, { 'Jane Doe, MD': { 'Jane Doe, MD, PhD (1)': 'x' } }, { prefilled: ['Existing Doc, MD (9)'] });

    const outcomes = await add(page, ['Jane Doe, MD', 'Existing Doc, MD']);
    await undo(page, outcomes);

    expect((await formState(page)).values).toEqual([[ROW(0), 'Existing Doc, MD (9)']]);
  });
});
