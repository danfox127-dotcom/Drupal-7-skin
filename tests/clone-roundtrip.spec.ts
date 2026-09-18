import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const OLD = 'https://old.example.edu';
const NEW = 'https://new.example.edu';

/**
 * The whole pipeline, on real captured forms: copy a page off one site's node form and
 * fill another site's form with it.
 *
 * Every other clone spec tests one stage. This one exists because the stages can each be
 * right and the chain still wrong — a value captured correctly, matched correctly, and
 * then written to a detached element; or an option resolved to a label the destination
 * does not render. So every assertion here reads the DESTINATION'S DOM, which is the only
 * thing Drupal will actually receive.
 */

/** Names a paste must leave exactly as it found them. */
const DENIED = /^menu\[|^path\[|^status$|^promote$|^sticky$|^name$|^date$|\[format\]$|\[fid\]$|^media\[/;

let bundle: string;

test.beforeAll(async () => {
  const entry = path.join(FIXTURES, '.clone-roundtrip-entry.ts');
  fs.writeFileSync(entry, `
    export { discoverSchema } from '../../src/lib/formSchema';
    export { captureNode } from '../../src/lib/clone/snapshot';
    export { matchFields } from '../../src/lib/clone/match';
    export { applyMatches, summarise } from '../../src/lib/clone/apply';
    export { readValue } from '../../src/lib/fieldBinding';
  `);
  const built = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, format: 'iife',
    globalName: 'RT', platform: 'browser', target: 'es2020',
  });
  bundle = built.outputFiles[0].text;
  fs.unlinkSync(entry);
});

/**
 * Serves a captured fixture from a named origin.
 *
 * Two real origins rather than one page swapped in place: the copy records where it came
 * from, the reference lookup refuses anything off-origin, and a single-origin test would
 * quietly pass on both counts.
 */
async function serve(
  page: import('@playwright/test').Page,
  origin: string,
  fixture: string,
  pathname: string
) {
  await page.route(`${origin}/**`, route => {
    const url = new URL(route.request().url());
    if (url.pathname === pathname) {
      return route.fulfill({
        status: 200, contentType: 'text/html',
        body: fs.readFileSync(path.join(FIXTURES, fixture), 'utf8'),
      });
    }
    // No autocomplete endpoint on these fixtures, which is the real state of them.
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${origin}${pathname}`);
  await page.evaluate(() => {
    (window as any).chrome = { runtime: { sendMessage: () => Promise.resolve({ ok: true }) } };
  });
  await page.addScriptTag({ content: bundle });
}

/** The values an editor would have typed on the source page. */
const SOURCE_VALUES: Record<string, string> = {
  'title_field[und][0][value]': 'Understanding IgA Nephropathy',
  'field_summary[und][0][value]': 'How the condition is diagnosed and treated at Columbia.',
  'body[und][0][value]': '<p>IgA nephropathy is a kidney disease.</p><p>It is diagnosed by biopsy.</p>',
  'field_subtitle[und][0][value]': 'What patients should know',
};

async function copyFrom(
  page: import('@playwright/test').Page,
  fixture: string,
  type: string
) {
  await serve(page, OLD, fixture, `/node/add/${type}`);
  return page.evaluate(async ([t, values]) => {
    const api = (window as any).RT;
    for (const [name, value] of Object.entries(values as Record<string, string>)) {
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
      if (el) el.value = value;
    }
    // Pick the first real option on every choice field, as an editor would.
    document.querySelectorAll<HTMLSelectElement>('select').forEach(select => {
      if (select.classList.contains('field-add-more-type')) return;
      const option = Array.from(select.options).find(o => o.value && o.value !== '_none');
      if (option) select.value = option.value;
    });

    const schema = api.discoverSchema(document, { pathname: `/node/add/${t}` });
    return api.captureNode(schema, {
      href: `https://old.example.edu/node/add/${t}`, origin: 'https://old.example.edu',
    });
  }, [type, SOURCE_VALUES] as const);
}

async function pasteInto(
  page: import('@playwright/test').Page,
  fixture: string,
  type: string,
  snapshot: unknown
) {
  await serve(page, NEW, fixture, `/node/add/${type}`);
  return page.evaluate(async ([t, snap]) => {
    const api = (window as any).RT;
    const schema = api.discoverSchema(document, { pathname: `/node/add/${t}` });

    const readAllNow = () => schema.fields.reduce((acc: any, f: any) => {
      acc[f.machineName] = api.readValue(f);
      return acc;
    }, {});

    /**
     * Read BEFORE applying. A blank Drupal form is not empty — menu[parent] arrives with
     * "Main menu" already selected, and several selects have defaults. Asserting that a
     * denied field is empty afterwards therefore fails on the form's own defaults, and
     * asserting it is unchanged is the claim that actually matters.
     */
    const before = readAllNow();

    const matched = api.matchFields(snap, schema);
    const outcome = await api.applyMatches(matched.matches, (snap as any).media, {
      origin: location.origin, href: location.href,
    });

    return {
      outcome, summary: api.summarise(outcome),
      unmapped: matched.unmapped.map((u: any) => u.label),
      before,
      // What Drupal would receive, read back off the live controls.
      written: readAllNow(),
    };
  }, [type, snapshot] as const);
}

test.describe('Page to Page, same content type', () => {
  test('the page arrives with its text intact', async ({ page }) => {
    const copied = await copyFrom(page, 'captured/page.html', 'page');
    const result = await pasteInto(page, 'captured/page.html', 'page', copied);

    for (const [name, value] of Object.entries(SOURCE_VALUES)) {
      expect(result.written[name], `${name} did not arrive`).toBe(value);
    }
    expect(result.outcome.failed, 'a write was refused by the form').toEqual([]);
  });

  test('the body keeps its markup rather than arriving as flat text', async ({ page }) => {
    // The body is the field most of a migration is made of, and the one most easily
    // flattened by a translation step that stringifies too eagerly.
    const copied = await copyFrom(page, 'captured/page.html', 'page');
    const result = await pasteInto(page, 'captured/page.html', 'page', copied);
    expect(result.written['body[und][0][value]']).toContain('<p>');
  });

  test('no image widget is touched', async ({ page }) => {
    const copied = await copyFrom(page, 'captured/page.html', 'page');
    const result = await pasteInto(page, 'captured/page.html', 'page', copied);

    for (const [name, value] of Object.entries(result.written)) {
      if (/^media\[|\[fid\]$/.test(name)) {
        expect(value, `${name} was written to`).toBe('');
      }
    }
  });

  test('nothing denied is written, on a real form', async ({ page }) => {
    /**
     * The end-to-end version of the deny list. Asserted on the destination DOM rather
     * than on the match list, because "never matched" and "never written" are different
     * claims and only the second one matters.
     */
    const copied = await copyFrom(page, 'captured/page.html', 'page');
    const result = await pasteInto(page, 'captured/page.html', 'page', copied);

    for (const name of Object.keys(result.written)) {
      if (!DENIED.test(name)) continue;
      expect(
        JSON.stringify(result.written[name]),
        `${name} was changed by the paste`
      ).toBe(JSON.stringify(result.before[name]));
    }
  });
});

test.describe('News to Page, across content types', () => {
  test('the shared fields arrive and the rest is reported', async ({ page }) => {
    const copied = await copyFrom(page, 'captured/news.html', 'news');
    const result = await pasteInto(page, 'captured/page.html', 'page', copied);

    expect(result.written['title_field[und][0][value]']).toBe('Understanding IgA Nephropathy');
    expect(result.written['body[und][0][value]']).toContain('IgA nephropathy is a kidney disease');
    expect(result.written['field_summary[und][0][value]']).toContain('diagnosed and treated');

    // News carries fields Page does not, and they must be named rather than dropped.
    expect(result.unmapped.length).toBeGreaterThan(0);
    expect(result.outcome.filled.length).toBeGreaterThan(0);
  });

  test('a News-only field does not find a home on a Page', async ({ page }) => {
    const copied = await copyFrom(page, 'captured/news.html', 'news');
    const result = await pasteInto(page, 'captured/page.html', 'page', copied);

    const filled = result.outcome.filled.map((f: any) => f.machineName);
    expect(filled.some((n: string) => /news_byline|news_date|news_categories/.test(n))).toBe(false);
  });

  test('groups are left blank when they cannot be checked', async ({ page }) => {
    /**
     * Both fixtures expose no autocomplete endpoint — which is the real state of every
     * committed capture, since the path was blanked when they were taken. So this is the
     * "cannot be asked at all" branch, and for a group that means blank.
     */
    const copied = await copyFrom(page, 'captured/news.html', 'news');
    await page.evaluate(() => {});
    const result = await pasteInto(page, 'captured/page.html', 'page', copied);

    const groupFields = Object.keys(result.written).filter(n => n.startsWith('og_group_ref'));
    for (const name of groupFields) {
      expect(result.written[name], `${name} was filled with an unchecked group`).toBe('');
    }
  });
});

test.describe('every captured type can be pasted into every other', () => {
  /**
   * A sweep rather than a pair, because the matcher's job is to survive field lists that
   * differ — and the interesting failures are the combinations nobody thought to try. The
   * bar is deliberately low and absolute: never throw, never write something denied, and
   * always fill the title, which every one of the nine types has.
   */
  const TYPES = ['page', 'news', 'specialty', 'condition', 'treatment', 'unit', 'list', 'testimonial', 'landing'];

  for (const from of ['news', 'condition', 'landing']) {
    for (const to of TYPES.filter(t => t !== from)) {
      test(`${from} -> ${to}`, async ({ page }) => {
        const copied = await copyFrom(page, `captured/${from}.html`, from);
        const result = await pasteInto(page, `captured/${to}.html`, to, copied);

        expect(result.written['title_field[und][0][value]'],
          `the title did not survive ${from} -> ${to}`).toBe('Understanding IgA Nephropathy');
        expect(result.outcome.failed.map((f: any) => f.machineName),
          `a control refused a value on ${to}`).toEqual([]);

        for (const name of Object.keys(result.written)) {
          if (!DENIED.test(name)) continue;
          expect(
            JSON.stringify(result.written[name]),
            `${name} was changed by the paste into ${to}`
          ).toBe(JSON.stringify(result.before[name]));
        }
      });
    }
  }
});
