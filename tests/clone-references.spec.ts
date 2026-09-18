import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

/**
 * Asking the destination whether it has the thing being referenced.
 *
 * Two outcomes matter and they are not symmetrical. A missed Related Condition makes
 * Drupal refuse the save, which is recoverable but blocks the form. A missed Group is a
 * permissions field, and the instruction was that it should simply be blank. So the
 * tests below check the DECISION, not just the lookup.
 */

let bundle: string;

test.beforeAll(async () => {
  const entry = path.join(FIXTURES, '.clone-refs-entry.ts');
  fs.writeFileSync(entry, `
    export { discoverSchema } from '../../src/lib/formSchema';
    export {
      autocompletePathFor, probeReference, resolveReference,
    } from '../../src/lib/clone/references';
  `);
  const built = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, format: 'iife',
    globalName: 'R', platform: 'browser', target: 'es2020',
  });
  bundle = built.outputFiles[0].text;
  fs.unlinkSync(entry);
});

/**
 * A page served from the destination's own origin, with a real autocomplete endpoint.
 *
 * page.route rather than a window.fetch stub, deliberately. The first version of this
 * harness stubbed fetch after a goto that could not resolve, so every test ran on
 * about:blank with a null origin and the same-origin check refused everything. Routing
 * serves the page and the endpoint from the real origin, so what is under test is the
 * actual fetch — including credentials and the origin comparison.
 *
 * `answers` maps a requested title to what Drupal would return. Anything absent answers
 * `{}`, which is exactly how Drupal reports "no such entity".
 */
const ORIGIN = 'https://dest.example.edu';

async function withEndpoint(
  page: import('@playwright/test').Page,
  answers: Record<string, Record<string, string>>,
  options: { status?: number; hang?: boolean; body?: string } = {}
) {
  const seen: string[] = [];

  /**
   * Registered FIRST, because Playwright matches handlers most-recently-added first — so
   * the specific route below takes precedence and this one only catches what it misses.
   * Registered the other way round, this aborted the destination page itself and every
   * test failed on the navigation rather than on anything under test.
   *
   * Its job: a request that leaks off this origin fails the test instead of quietly
   * succeeding against the real internet.
   */
  await page.route('**', route => route.abort());

  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());

    if (url.pathname === '/node/add/page') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<body></body>' });
    }

    seen.push(route.request().url());

    if (options.hang) return new Promise<void>(() => {});
    if (options.status && options.status !== 200) {
      return route.fulfill({ status: options.status, body: 'nope' });
    }
    if (options.body !== undefined) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: options.body });
    }

    const title = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(answers[title] ?? {}),
    });
  });

  await page.goto(`${ORIGIN}/node/add/page`);
  await page.addScriptTag({ content: bundle });

  return { requests: () => seen };
}

const PATH = `${ORIGIN}/entityreference/autocomplete/tags/field_conditions/node/page/NULL`;
const HERE = { origin: ORIGIN, href: `${ORIGIN}/node/add/page` };

test.describe('reading the lookup address off the form', () => {
  test('the hidden sibling Drupal renders is found by id', async ({ page }) => {
    await page.goto('data:text/html,<body></body>');
    await page.setContent(`
      <form class="node-form">
        <div class="form-item">
          <label for="edit-field-conditions-und-0-target-id">Conditions</label>
          <input type="text" id="edit-field-conditions-und-0-target-id"
                 name="field_conditions[und][0][target_id]" class="form-text form-autocomplete">
          <input type="hidden" id="edit-field-conditions-und-0-target-id-autocomplete"
                 value="${PATH}" disabled class="autocomplete">
        </div>
      </form>`);
    await page.addScriptTag({ content: bundle });

    const found = await page.evaluate(() => {
      const api = (window as any).R;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      const field = schema.fields.find((f: any) => f.baseName === 'field_conditions');
      return { kind: field.kind, path: api.autocompletePathFor(field, document) };
    });

    expect(found.kind).toBe('autocomplete');
    expect(found.path).toBe(PATH);
  });

  test('each delta of a multi-value field gets its OWN lookup address', async ({ page }) => {
    /**
     * Why the id lookup exists, rather than just searching the widget wrapper.
     *
     * A multi-value reference renders several deltas, and og_group_ref puts them in one
     * field-multiple-table. Where the deltas are not each wrapped in their own
     * .form-item, searching outwards finds the FIRST hidden sibling for every delta — so
     * delta 1 would be looked up against delta 0's endpoint. Drupal builds the
     * `<id>-autocomplete` relationship precisely so this is unambiguous.
     */
    await page.goto('data:text/html,<body></body>');
    await page.setContent(`
      <form class="node-form">
        <div class="field-widget">
          <label>Your groups</label>
          <input type="text" id="edit-og-group-ref-und-0-default-0-target-id"
                 name="og_group_ref[und][0][default][0][target_id]" class="form-autocomplete">
          <input type="hidden" id="edit-og-group-ref-und-0-default-0-target-id-autocomplete"
                 value="${ORIGIN}/lookup/delta-0" disabled class="autocomplete">
          <input type="text" id="edit-og-group-ref-und-1-default-0-target-id"
                 name="og_group_ref[und][1][default][0][target_id]" class="form-autocomplete">
          <input type="hidden" id="edit-og-group-ref-und-1-default-0-target-id-autocomplete"
                 value="${ORIGIN}/lookup/delta-1" disabled class="autocomplete">
        </div>
      </form>`);
    await page.addScriptTag({ content: bundle });

    const paths = await page.evaluate(() => {
      const api = (window as any).R;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      return schema.fields
        .filter((f: any) => f.baseName === 'og_group_ref')
        .map((f: any) => api.autocompletePathFor(f, document));
    });

    expect(paths.length, 'both deltas should be discovered as fields').toBe(2);
    expect(paths[0], 'delta 0 got the wrong endpoint').toContain('delta-0');
    expect(paths[1], 'delta 1 was looked up against delta 0\'s endpoint').toContain('delta-1');
  });

  test('a form with no lookup address reports null rather than guessing one', async ({ page }) => {
    await page.goto('data:text/html,<body></body>');
    /**
     * This is the state of every committed fixture: captureFixture blanks the value of
     * non-structural inputs, so the path is empty. Returning null is what makes
     * `unavailable` a real code path rather than a crash.
     */
    await page.setContent(`
      <form class="node-form">
        <div class="form-item">
          <label for="a">Conditions</label>
          <input type="text" id="a" name="field_conditions[und][0][target_id]" class="form-autocomplete">
          <input type="hidden" id="a-autocomplete" value="" disabled class="autocomplete">
        </div>
      </form>`);
    await page.addScriptTag({ content: bundle });

    const result = await page.evaluate(() => {
      const api = (window as any).R;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      const field = schema.fields.find((f: any) => f.baseName === 'field_conditions');
      return api.autocompletePathFor(field, document);
    });
    expect(result).toBeNull();
  });
});

test.describe('one lookup', () => {
  test('a match returns the DESTINATION\'s own value, id included', async ({ page }) => {
    /**
     * The key insight of this design. The site answers with the exact string its own
     * form expects — `IgA Nephropathy (4417)` — so that is what gets written, rather
     * than a bare title we hope its validator re-resolves. The source's id (8821) never
     * appears anywhere.
     */
    await withEndpoint(page, { 'IgA Nephropathy': { 'IgA Nephropathy (4417)': 'IgA Nephropathy' } });
    const result = await page.evaluate(
      ([p, here]) => (window as any).R.probeReference(p, 'IgA Nephropathy', here),
      [PATH, HERE] as const);

    expect(result.status).toBe('match');
    expect(result.value).toBe('IgA Nephropathy (4417)');
  });

  test('an empty answer is a clean no-match, not an error', async ({ page }) => {
    await withEndpoint(page, {});
    const result = await page.evaluate(
      ([p, here]) => (window as any).R.probeReference(p, 'Nothing Here', here),
      [PATH, HERE] as const);
    expect(result.status).toBe('no-match');
  });

  test('matching ignores case and spacing', async ({ page }) => {
    await withEndpoint(page, { 'iga nephropathy': { 'IgA  Nephropathy (7)': 'x' } });
    const result = await page.evaluate(
      ([p, here]) => (window as any).R.probeReference(p, 'iga nephropathy', here),
      [PATH, HERE] as const);
    expect(result.status).toBe('match');
  });

  test('an error response is unavailable, not a no-match', async ({ page }) => {
    // The distinction decides whether a value is dropped or written unchecked.
    await withEndpoint(page, {}, { status: 403 });
    const result = await page.evaluate(
      ([p, here]) => (window as any).R.probeReference(p, 'Anything', here),
      [PATH, HERE] as const);
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('403');
  });

  test('a lookup pointing at another site is refused, not followed', async ({ page }) => {
    /**
     * The path is read out of the page, and a fetch built from DOM content carries the
     * user's session cookies. Same-origin is checked rather than assumed.
     */
    const endpoint = await withEndpoint(page, {});
    const result = await page.evaluate(
      (here) => (window as any).R.probeReference(
        'https://elsewhere.example.com/entityreference/autocomplete/x', 'Title', here),
      HERE);

    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('another site');
    expect(endpoint.requests(), 'a cross-origin lookup was actually attempted').toEqual([]);
  });
});

test.describe('resolving a whole field', () => {
  test('every title confirmed gives a verified value', async ({ page }) => {
    await withEndpoint(page, {
      'IgA Nephropathy': { 'IgA Nephropathy (4417)': 'x' },
      'Lupus Nephritis': { 'Lupus Nephritis (4418)': 'x' },
    });
    const result = await page.evaluate(
      ([p, here]) => (window as any).R.resolveReference(
        'IgA Nephropathy (8821), Lupus Nephritis (8822)', p, false, here),
      [PATH, HERE] as const);

    expect(result.value).toBe('IgA Nephropathy (4417), Lupus Nephritis (4418)');
    expect(result.verified).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test('a title this site lacks is dropped and named', async ({ page }) => {
    await withEndpoint(page, { 'IgA Nephropathy': { 'IgA Nephropathy (4417)': 'x' } });
    const result = await page.evaluate(
      ([p, here]) => (window as any).R.resolveReference(
        'IgA Nephropathy (1), Invented Condition (2)', p, false, here),
      [PATH, HERE] as const);

    expect(result.value).toBe('IgA Nephropathy (4417)');
    expect(result.missing).toEqual(['Invented Condition']);
    expect(result.note).toContain('Invented Condition');
  });

  test('a repeated title is looked up once', async ({ page }) => {
    const endpoint = await withEndpoint(page, { Asthma: { 'Asthma (3)': 'x' } });
    await page.evaluate(
      ([p, here]) => (window as any).R.resolveReference(
        'Asthma (1), Asthma (2), Asthma (9)', p, false, here),
      [PATH, HERE] as const);
    expect(endpoint.requests().length).toBe(1);
  });

  test('a quoted title with a comma is looked up as one reference', async ({ page }) => {
    await withEndpoint(page, { 'Smith, John': { 'Smith, John (55)': 'x' } });
    const result = await page.evaluate(
      ([p, here]) => (window as any).R.resolveReference('"Smith, John" (12)', p, false, here),
      [PATH, HERE] as const);
    expect(result.value).toBe('"Smith, John (55)"');
    expect(result.missing).toEqual([]);
  });
});

test.describe('groups are blanked rather than guessed', () => {
  test('a group this site does not have is left blank', async ({ page }) => {
    await withEndpoint(page, {});
    const result = await page.evaluate(
      ([p, here]) => (window as any).R.resolveReference(
        'Nephrology Division (55)', p, true, here),
      [PATH, HERE] as const);

    expect(result.value).toBe('');
    expect(result.missing).toEqual(['Nephrology Division']);
  });

  test('a group is left blank when the site cannot be asked at all', async ({ page }) => {
    /**
     * The case the committed fixtures are all in. With no lookup address, an ordinary
     * reference is written unchecked — but a group is not, because a wrong group changes
     * who can see the page.
     */
    await withEndpoint(page, {});
    const result = await page.evaluate(
      (here) => (window as any).R.resolveReference('Nephrology Division (55)', null, true, here),
      HERE);

    expect(result.value).toBe('');
    expect(result.note).toContain('left blank');
  });

  test('a group is left blank when the lookup errors', async ({ page }) => {
    await withEndpoint(page, {}, { status: 500 });
    const result = await page.evaluate(
      ([p, here]) => (window as any).R.resolveReference('Nephrology Division (55)', p, true, here),
      [PATH, HERE] as const);
    expect(result.value).toBe('');
  });

  test('an ordinary reference IS written when the site cannot be asked', async ({ page }) => {
    /**
     * The asymmetry, stated as its own test. Dropping every reference on a site whose
     * form exposes no lookup would gut the feature for exactly the content a migration
     * is made of; Drupal refusing the save is loud and recoverable.
     */
    await withEndpoint(page, {});
    const result = await page.evaluate(
      (here) => (window as any).R.resolveReference('IgA Nephropathy (8821)', null, false, here),
      HERE);

    expect(result.value).toBe('IgA Nephropathy');
    expect(result.verified).toBe(false);
    expect(result.note).toContain('Drupal will say so when you save');
  });
});

test('nothing referenced means nothing written and nothing fetched', async ({ page }) => {
  const endpoint = await withEndpoint(page, {});
  const result = await page.evaluate(
    ([p, here]) => (window as any).R.resolveReference('', p, false, here),
    [PATH, HERE] as const);

  expect(result.value).toBe('');
  expect(endpoint.requests()).toEqual([]);
});

test.describe('a lookup that does not answer', () => {
  test('a timeout is unavailable, and a group is still blanked', async ({ page }) => {
    /**
     * The likeliest real cause of `unavailable` on a busy Drupal site. The timeout is
     * injectable so this costs 150ms rather than five seconds.
     */
    await withEndpoint(page, {}, { hang: true });
    const result = await page.evaluate(
      ([p, here]) => (window as any).R.resolveReference(
        'Nephrology Division (55)', p, true, here, 150),
      [PATH, HERE] as const);

    expect(result.value).toBe('');
    expect(result.verified).toBe(false);
  });

  test('a timeout writes an ordinary reference unchecked', async ({ page }) => {
    await withEndpoint(page, {}, { hang: true });
    const result = await page.evaluate(
      ([p, here]) => (window as any).R.resolveReference(
        'IgA Nephropathy (8821)', p, false, here, 150),
      [PATH, HERE] as const);

    expect(result.value).toBe('IgA Nephropathy');
    expect(result.note).toContain('unchecked');
  });

  test('an answer that is not JSON is unavailable rather than a crash', async ({ page }) => {
    await withEndpoint(page, {}, { body: '<html>login page</html>' });
    const result = await page.evaluate(
      ([p, here]) => (window as any).R.probeReference('' + p, 'Anything', here),
      [PATH, HERE] as const);
    expect(result.status).toBe('unavailable');
  });
});
