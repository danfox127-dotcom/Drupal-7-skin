import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const ORIGIN = 'https://dest.example.edu';

/**
 * Writing the approved matches into the form.
 *
 * The outcomes are deliberately four, not two. "Left blank because this site has no such
 * group" and "the control refused the value" both end with an empty field, and telling
 * them apart is the difference between a correct result and a bug to chase.
 */

let bundle: string;

test.beforeAll(async () => {
  const entry = path.join(FIXTURES, '.clone-apply-entry.ts');
  fs.writeFileSync(entry, `
    export { discoverSchema } from '../../src/lib/formSchema';
    export { matchFields } from '../../src/lib/clone/match';
    export { applyMatches, summarise } from '../../src/lib/clone/apply';
    export { readValue } from '../../src/lib/fieldBinding';
  `);
  const built = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, format: 'iife',
    globalName: 'A', platform: 'browser', target: 'es2020',
  });
  bundle = built.outputFiles[0].text;
  fs.unlinkSync(entry);
});

/** Serves a destination page with a scripted autocomplete endpoint. */
async function open(
  page: import('@playwright/test').Page,
  body: string,
  answers: Record<string, Record<string, string>> = {}
) {
  await page.route('**', route => route.abort());
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/node/add/page') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: `<body>${body}</body>` });
    }
    const title = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(answers[title] ?? {}),
    });
  });
  await page.goto(`${ORIGIN}/node/add/page`);
  await page.evaluate(() => {
    (window as any).chrome = { runtime: { sendMessage: () => Promise.resolve({ ok: true }) } };
  });
  await page.addScriptTag({ content: bundle });
}

const snapshot = (fields: any[], media: any[] = []) => ({
  version: 1, sourceUrl: 'https://old.example.edu/node/1/edit',
  sourceOrigin: 'https://old.example.edu', contentType: 'page', title: 'T',
  capturedAt: 0, fields, paragraphs: [], media, omitted: [],
});

const captured = (over: any = {}) => ({
  machineName: 'field_x[und][0][value]', baseName: 'field_x', label: 'X', kind: 'text',
  section: 'typeFields', required: false, multiValue: false,
  value: 'a value', optionLabels: null, ...over,
});

/** Matches the snapshot onto the open form and applies it, returning the outcome. */
const run = (page: import('@playwright/test').Page, snap: any) =>
  page.evaluate(async (s) => {
    const api = (window as any).A;
    const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
    const matched = api.matchFields(s, schema);
    const outcome = await api.applyMatches(matched.matches, s.media, {
      origin: location.origin, href: location.href,
    });
    return {
      outcome,
      summary: api.summarise(outcome),
      unmapped: matched.unmapped.map((u: any) => u.label),
      values: schema.fields.reduce((acc: any, f: any) => {
        acc[f.machineName] = api.readValue(f);
        return acc;
      }, {}),
    };
  }, snap);

test.describe('values reach the native controls', () => {
  test('text lands where Drupal will read it', async ({ page }) => {
    await open(page, `
      <form class="node-form">
        <div class="form-item"><label for="t">Title</label>
          <input type="text" id="t" name="title_field[und][0][value]"></div>
      </form>`);

    const result = await run(page, snapshot([captured({
      machineName: 'title_field[und][0][value]', baseName: 'title_field',
      label: 'Title', value: 'Understanding IgA Nephropathy',
    })]));

    expect(result.values['title_field[und][0][value]']).toBe('Understanding IgA Nephropathy');
    expect(result.outcome.filled.length).toBe(1);
  });

  test('a term is written as this site\'s own option value', async ({ page }) => {
    /**
     * The source's id was 101; this site calls the same term 88. Asserted on the DOM
     * rather than on the match, because the match being right and the write being wrong
     * is a distinct failure.
     */
    await open(page, `
      <form class="node-form">
        <div class="form-item"><label for="s">Specialty</label>
          <select id="s" name="field_specialty[und]">
            <option value="_none">- None -</option>
            <option value="88">Nephrology</option>
            <option value="89">Cardiology</option>
          </select></div>
      </form>`);

    const result = await run(page, snapshot([captured({
      machineName: 'field_specialty[und]', baseName: 'field_specialty', label: 'Specialty',
      kind: 'select', value: '101', optionLabels: ['Nephrology'],
    })]));

    expect(result.values['field_specialty[und]']).toBe('88');
  });

  test('writing fires the events Drupal\'s own JS listens for', async ({ page }) => {
    /**
     * Drupal's #states machinery watches for change. A value assigned without it leaves
     * dependent fieldsets collapsed and conditional fields hidden — the exact bug that
     * lost menu placements through the taxonomy combobox.
     */
    await open(page, `
      <form class="node-form">
        <div class="form-item"><label for="t">Title</label>
          <input type="text" id="t" name="title_field[und][0][value]"></div>
      </form>`);

    await page.evaluate(() => {
      (window as any).__events = [];
      document.querySelector('#t')!.addEventListener('change', () => (window as any).__events.push('change'));
      document.querySelector('#t')!.addEventListener('input', () => (window as any).__events.push('input'));
    });

    await run(page, snapshot([captured({
      machineName: 'title_field[und][0][value]', baseName: 'title_field', label: 'Title', value: 'X',
    })]));

    expect(await page.evaluate(() => (window as any).__events)).toContain('change');
  });

  test('a match the editor rejected is not written', async ({ page }) => {
    await open(page, `
      <form class="node-form">
        <div class="form-item"><label for="t">Title</label>
          <input type="text" id="t" name="title_field[und][0][value]" value="untouched"></div>
      </form>`);

    const result = await page.evaluate(async (s) => {
      const api = (window as any).A;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      const matched = api.matchFields(s, schema);
      // What pressing "Skipped" in the review does.
      matched.matches.forEach((m: any) => { m.accepted = false; });
      const outcome = await api.applyMatches(matched.matches, [], {
        origin: location.origin, href: location.href,
      });
      return { outcome, value: (document.querySelector('#t') as HTMLInputElement).value };
    }, snapshot([captured({
      machineName: 'title_field[und][0][value]', baseName: 'title_field', label: 'Title', value: 'NEW',
    })]));

    expect(result.value).toBe('untouched');
    expect(result.outcome.filled).toEqual([]);
  });
});

test.describe('the four outcomes are told apart', () => {
  test('a control that refuses the value reports failed, not filled', async ({ page }) => {
    /**
     * A select assigned a value with no matching option silently stays empty. Reporting
     * it as filled is how the review comes to disagree with the form Drupal will save.
     */
    await open(page, `
      <form class="node-form">
        <div class="form-item"><label for="s">Status label</label>
          <select id="s" name="field_pick[und]"><option value="a">A</option></select></div>
      </form>`);

    const result = await page.evaluate(async (s) => {
      const api = (window as any).A;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      const matched = api.matchFields(s, schema);
      // Force a value the option list cannot hold, as a rebuilt vocabulary would.
      matched.matches.forEach((m: any) => { m.value = 'zzz'; });
      return api.applyMatches(matched.matches, [], { origin: location.origin, href: location.href });
    }, snapshot([captured({
      machineName: 'field_pick[und]', baseName: 'field_pick', label: 'Status label',
      kind: 'select', value: 'a', optionLabels: ['A'],
    })]));

    expect(result.failed.length).toBe(1);
    expect(result.filled).toEqual([]);
    expect(result.failed[0].note).toContain('would not take the value');
  });

  test('a partly-filled taxonomy field says what was left out', async ({ page }) => {
    /**
     * Two checkboxes, not one. walkForm classifies a lone checkbox as a boolean flag
     * rather than a group, and correctly so — it cannot tell a single-term taxonomy
     * widget from a "Sitewide news" tick. A one-checkbox fixture therefore tested a
     * different code path than the one this test is about.
     *
     * This site has Allergy and Eczema; the source page had Allergy and Asthma.
     */
    await open(page, `
      <form class="node-form">
        <fieldset><legend><span class="fieldset-legend">Topics</span></legend>
          <div class="form-checkboxes">
            <div class="form-item"><input type="checkbox" id="c1" name="field_topics[und][]" value="9">
              <label for="c1">Allergy</label></div>
            <div class="form-item"><input type="checkbox" id="c2" name="field_topics[und][]" value="10">
              <label for="c2">Eczema</label></div>
          </div>
        </fieldset>
      </form>`);

    const result = await run(page, snapshot([captured({
      machineName: 'field_topics[und][]', baseName: 'field_topics', label: 'Topics',
      kind: 'checkboxGroup', value: ['1', '2'], optionLabels: ['Allergy', 'Asthma'],
    })]));

    expect(result.outcome.partial.length).toBe(1);
    expect(result.outcome.partial[0].note).toContain('Asthma');
    expect(result.values['field_topics[und][]']).toEqual(['9']);
  });

  test('a group this site lacks is blanked, and blank is not failure', async ({ page }) => {
    await open(page, `
      <form class="node-form">
        <div class="form-item"><label for="g">Your groups</label>
          <input type="text" id="g" name="og_group_ref[und][0][default][0][target_id]"
                 class="form-autocomplete">
          <input type="hidden" id="g-autocomplete" value="${ORIGIN}/lookup" disabled class="autocomplete">
        </div>
      </form>`, { /* the endpoint knows of no groups */ });

    const result = await run(page, snapshot([captured({
      machineName: 'og_group_ref[und][0][default][0][target_id]', baseName: 'og_group_ref',
      label: 'Your groups', kind: 'autocomplete', value: 'Nephrology Division (55)',
    })]));

    expect(result.outcome.blanked.length).toBe(1);
    expect(result.outcome.failed).toEqual([]);
    expect(result.values['og_group_ref[und][0][default][0][target_id]']).toBe('');
    expect(result.outcome.blanked[0].note).toContain('Nephrology Division');
  });

  test('a confirmed reference is written with this site\'s own id', async ({ page }) => {
    await open(page, `
      <form class="node-form">
        <div class="form-item"><label for="c">Conditions</label>
          <input type="text" id="c" name="field_conditions[und][0][target_id]" class="form-autocomplete">
          <input type="hidden" id="c-autocomplete" value="${ORIGIN}/lookup" disabled class="autocomplete">
        </div>
      </form>`, { 'IgA Nephropathy': { 'IgA Nephropathy (4417)': 'IgA Nephropathy' } });

    const result = await run(page, snapshot([captured({
      machineName: 'field_conditions[und][0][target_id]', baseName: 'field_conditions',
      label: 'Conditions', kind: 'autocomplete', value: 'IgA Nephropathy (8821)',
    })]));

    expect(result.values['field_conditions[und][0][target_id]']).toBe('IgA Nephropathy (4417)');
    expect(result.outcome.filled.length).toBe(1);
  });
});

test.describe('images', () => {
  test('are handed back for the checklist and never written', async ({ page }) => {
    await open(page, `
      <form class="node-form">
        <div class="form-item"><label for="t">Title</label>
          <input type="text" id="t" name="title_field[und][0][value]"></div>
        <div class="field-widget-media-generic">
          <label>Teaser Image</label>
          <div class="media-widget"><input class="upload" type="text" id="m"
            name="media[field_image_teaser_und_0]" value=""></div>
        </div>
      </form>`);

    const result = await run(page, snapshot(
      [captured({ machineName: 'title_field[und][0][value]', baseName: 'title_field', label: 'Title', value: 'T' })],
      [{
        baseName: 'field_image_teaser', label: 'Teaser Image', fid: '44120',
        filename: 'puberty-teaser.jpg',
        url: 'https://old.example.edu/sites/default/files/puberty-teaser.jpg',
        thumbnailUrl: 'https://old.example.edu/sites/default/files/styles/thumbnail/public/puberty-teaser.jpg',
      }]
    ));

    expect(result.outcome.images.length).toBe(1);
    expect(result.outcome.images[0].filename).toBe('puberty-teaser.jpg');
    // The widget is left for Drupal's own Browse button.
    expect(result.values['media[field_image_teaser_und_0]']).toBe('');
    expect(result.summary).toContain('1 image to attach');
  });

  test('an image field the source never filled is not listed', async ({ page }) => {
    await open(page, `
      <form class="node-form">
        <div class="form-item"><label for="t">Title</label>
          <input type="text" id="t" name="title_field[und][0][value]"></div>
      </form>`);

    const result = await run(page, snapshot(
      [captured({ machineName: 'title_field[und][0][value]', baseName: 'title_field', label: 'Title', value: 'T' })],
      [{
        baseName: 'field_image_hero', label: 'Hero Image', fid: null,
        filename: '', url: null, thumbnailUrl: null,
      }]
    ));
    expect(result.outcome.images).toEqual([]);
  });
});

test('the summary counts every outcome it is given', async ({ page }) => {
  await open(page, '<form class="node-form"></form>');
  const line = await page.evaluate(() => (window as any).A.summarise({
    filled: [1, 2, 3], partial: [1], blanked: [1, 2], failed: [], images: [1, 2],
  }));
  expect(line).toBe('3 filled, 1 partly, 2 left blank, 2 images to attach');
});
