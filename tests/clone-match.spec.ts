import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { matchFields, translate, normalizeLabel, isGroupField } from '../src/lib/clone/match';
import { FieldDescriptor, FieldOption, FormSchema } from '../src/lib/formSchema';
import { CapturedField, NodeSnapshot } from '../src/lib/clone/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

/**
 * Deciding which box on this form receives each field from the copy.
 *
 * The failure mode worth guarding is not "nothing matched" — that is visible. It is a
 * confident wrong match: a term id in a date field, a body filled from a subtitle, or
 * two source fields fighting over one target and the loser vanishing without a word.
 */

const field = (over: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  machineName: 'field_x[und][0][value]', baseName: 'field_x', label: 'X', kind: 'text',
  required: false, help: '', section: 'typeFields', matchedBy: 'test',
  group: null, groupPath: [], elements: [], multiValue: false, advanced: false, ...over,
});

const captured = (over: Partial<CapturedField> = {}): CapturedField => ({
  machineName: 'field_x[und][0][value]', baseName: 'field_x', label: 'X', kind: 'text',
  section: 'typeFields', required: false, multiValue: false,
  value: 'a value', optionLabels: null, ...over,
});

const snapshot = (fields: CapturedField[], over: Partial<NodeSnapshot> = {}): NodeSnapshot => ({
  version: 1, sourceUrl: 'https://old.example.edu/node/1/edit',
  sourceOrigin: 'https://old.example.edu', contentType: 'page', title: 'T',
  capturedAt: 0, fields, paragraphs: [], media: [], omitted: [], ...over,
});

const schema = (fields: FieldDescriptor[], contentType = 'page'): FormSchema => ({
  contentType, detectedFrom: 'url-add', fields, verticalTabs: [],
  form: {} as HTMLFormElement,
});

const opts = (pairs: [string, string][]): FieldOption[] =>
  pairs.map(([value, label]) => ({ value, label, depth: 0, selected: false }));

test.describe('which tier claims a field', () => {
  test('an exact name match beats a label match for the same box', () => {
    /**
     * Order-independence matters: the source fields arrive in DOM order, so without
     * strongest-tier-first the field that happened to come earlier would win and the
     * exact match would be reported as having no home.
     */
    const target = field({ machineName: 'body[und][0][value]', baseName: 'body', label: 'Body' });
    const result = matchFields(
      snapshot([
        captured({ machineName: 'field_intro[und][0][value]', baseName: 'field_intro', label: 'Body' }),
        captured({ machineName: 'body[und][0][value]', baseName: 'body', label: 'Body copy' }),
      ]),
      schema([target])
    );

    expect(result.matches.length).toBe(1);
    expect(result.matches[0].sourceMachineName).toBe('body[und][0][value]');
    expect(result.matches[0].tier).toBe('machine-name');
    // The loser is reported, not dropped.
    expect(result.unmapped.some(u => u.label === 'Body')).toBe(true);
  });

  test('the same field with a different delta still matches', () => {
    const result = matchFields(
      snapshot([captured({
        machineName: 'field_summary[und][2][value]', baseName: 'field_summary', label: 'Summary',
      })]),
      schema([field({
        machineName: 'field_summary[und][0][value]', baseName: 'field_summary', label: 'Summary',
      })])
    );
    expect(result.matches[0].tier).toBe('base-name');
  });

  test('a shared label is not enough when the widgets are unrelated', () => {
    /**
     * "Date" as free text on one site and a date cluster here. Filling it would put a
     * string into a widget that submits month/day/year parts.
     */
    const result = matchFields(
      snapshot([captured({ label: 'Date', kind: 'text', value: 'last Tuesday' })]),
      schema([field({
        machineName: 'field_d[und][0][value][month]', baseName: 'field_d',
        label: 'Date', kind: 'date',
      })])
    );
    expect(result.matches).toEqual([]);
    expect(result.unmapped[0].reason).toContain('no matching field');
  });

  test('a plural difference in the label still matches, at low confidence', () => {
    const result = matchFields(
      snapshot([captured({
        machineName: 'field_topics[und]', baseName: 'field_topics', label: 'Topics',
        kind: 'checkboxGroup', value: ['1'], optionLabels: ['Allergy'],
      })]),
      schema([field({
        machineName: 'field_topic[und]', baseName: 'field_topic', label: 'Topic:',
        kind: 'checkboxGroup', options: opts([['77', 'Allergy']]),
      })])
    );
    expect(result.matches[0].tier).toBe('label-normalized');
    expect(result.matches[0].confidence).toBe('low');
  });

  test('a low-confidence match is still accepted by default', () => {
    /**
     * The deliberate inversion of src/lib/import/extract.ts. A value shown but not
     * filled has done none of the work this feature exists to do; the review is the
     * guard, and the provenance line says the match is a guess.
     */
    const result = matchFields(
      snapshot([captured({ label: 'Teaser Text', baseName: 'field_teaser_text' })]),
      schema([field({ label: 'Teaser texts', baseName: 'field_tt', machineName: 'field_tt[und][0][value]' })])
    );
    expect(result.matches[0].accepted).toBe(true);
    expect(result.matches[0].source).toMatch(/best guess/i);
  });

  test('one target cannot be filled twice', () => {
    const target = field({ machineName: 'field_s[und][0][value]', baseName: 'field_s', label: 'Summary' });
    const result = matchFields(
      snapshot([
        captured({ machineName: 'a[und][0][value]', baseName: 'a', label: 'Summary' }),
        captured({ machineName: 'b[und][0][value]', baseName: 'b', label: 'Summary' }),
      ]),
      schema([target])
    );
    expect(result.matches.length).toBe(1);
    expect(result.unmapped.length).toBe(1);
  });

  test('a denied source field is never copied', () => {
    const result = matchFields(
      snapshot([captured({ machineName: 'status', baseName: 'status', label: 'Published', kind: 'checkbox', value: true })]),
      schema([field({ machineName: 'status', baseName: 'status', label: 'Published', kind: 'checkbox' })])
    );
    expect(result.matches).toEqual([]);
  });

  test('a denied target is never filled, even from an allowed source', () => {
    /**
     * The other half, and the half that needs stating separately: here the SOURCE field
     * is an ordinary content field that happens to be labelled "Published", so the
     * source-side deny check does not fire. Only the target-side filter stops this, and
     * without it the label tier matches an editorial flag straight onto Drupal's publish
     * checkbox — which would publish a pasted page on save.
     *
     * The first version of this test used `status` on both sides, so the source check
     * caught it and the test passed with the target filter deleted.
     */
    const result = matchFields(
      snapshot([captured({
        machineName: 'field_published_flag[und]', baseName: 'field_published_flag',
        label: 'Published', kind: 'checkbox', value: true,
      })]),
      schema([field({ machineName: 'status', baseName: 'status', label: 'Published', kind: 'checkbox' })])
    );
    expect(result.matches, 'an editorial flag was matched onto the publish checkbox').toEqual([]);
  });

  test('a cross-type paste names both content types in the reason', () => {
    const result = matchFields(
      snapshot([captured({ label: 'Byline', baseName: 'field_news_byline' })], { contentType: 'news' }),
      schema([], 'page')
    );
    expect(result.unmapped[0].reason).toContain('news');
    expect(result.unmapped[0].reason).toContain('page');
  });

  test('what the capture refused to carry is passed through to the review', () => {
    const result = matchFields(
      snapshot([], { omitted: [{ label: 'Menu placement', reason: 'Different structure here.' }] }),
      schema([])
    );
    expect(result.unmapped).toEqual([{ label: 'Menu placement', reason: 'Different structure here.' }]);
  });
});

test.describe('translating a value for this form', () => {
  test('a term resolves to this site\'s own id', () => {
    const t = translate(
      captured({ kind: 'select', value: '101', optionLabels: ['Nephrology'] }),
      field({ kind: 'select', options: opts([['88', 'Nephrology']]) })
    );
    expect(t.value).toBe('88');
    expect(t.refusal).toBeNull();
  });

  test('a term this site lacks is refused by name, not written as an id', () => {
    const t = translate(
      captured({ kind: 'select', value: '101', optionLabels: ['Hepatology'] }),
      field({ kind: 'select', options: opts([['88', 'Nephrology']]) })
    );
    expect(t.value).toBe('');
    expect(t.refusal).toContain('Hepatology');
  });

  test('a partial match keeps what resolved and reports the rest', () => {
    const t = translate(
      captured({ kind: 'checkboxGroup', value: ['1', '2'], optionLabels: ['Allergy', 'Asthma'] }),
      field({ kind: 'checkboxGroup', options: opts([['9', 'Allergy']]) })
    );
    expect(t.value).toEqual(['9']);
    expect(t.missing).toEqual(['Asthma']);
    expect(t.refusal).toBeNull();
  });

  test('an entity reference carries the title and asks to be checked', () => {
    const t = translate(
      captured({ kind: 'autocomplete', value: 'IgA Nephropathy (8821)' }),
      field({ kind: 'autocomplete' })
    );
    expect(t.value).toBe('IgA Nephropathy');
    expect(t.needsProbe).toBe(true);
  });

  test('several references keep their quoting', () => {
    const t = translate(
      captured({ kind: 'autocomplete', value: '"Smith, John" (12), Jones (13)' }),
      field({ kind: 'autocomplete' })
    );
    expect(t.value).toBe('"Smith, John", Jones');
  });

  test('a date widget of a different shape is refused rather than half-filled', () => {
    const t = translate(
      captured({ kind: 'date', value: '2019-04-11' }),
      field({ kind: 'date', elements: [{} as HTMLElement, {} as HTMLElement] })
    );
    expect(t.refusal).toContain('widgets differ');
  });

  test('a matching date widget passes through', () => {
    const t = translate(
      captured({ kind: 'date', value: '2019-04-11' }),
      field({ kind: 'date', elements: [{}, {}, {}] as HTMLElement[] })
    );
    expect(t.value).toBe('2019-04-11');
  });

  test('a choice value arriving at a text field writes the name, not the number', () => {
    const t = translate(
      captured({ kind: 'select', value: '101', optionLabels: ['Nephrology'] }),
      field({ kind: 'text' })
    );
    expect(t.value).toBe('Nephrology');
  });

  test('free text arriving at a choice field is tried as a label', () => {
    const t = translate(
      captured({ kind: 'text', value: 'Nephrology' }),
      field({ kind: 'select', options: opts([['88', 'Nephrology']]) })
    );
    expect(t.value).toBe('88');
  });
});

test.describe('groups', () => {
  test('a group field is marked to blank rather than guess', () => {
    /**
     * The explicit instruction: groups rarely match across sites, and a wrong value
     * changes who can see the page, so a miss leaves the field empty.
     */
    const result = matchFields(
      snapshot([captured({
        machineName: 'og_group_ref[und][0][default][0][target_id]',
        baseName: 'og_group_ref', label: 'Your groups',
        kind: 'autocomplete', value: 'Nephrology Division (55)',
      })]),
      schema([field({
        machineName: 'og_group_ref[und][0][default][0][target_id]',
        baseName: 'og_group_ref', label: 'Your groups', kind: 'autocomplete',
      })])
    );
    expect(result.matches[0].blankOnMiss).toBe(true);
    expect(result.matches[0].value).toBe('Nephrology Division');
  });

  test('an ordinary reference is not marked blank-on-miss', () => {
    const result = matchFields(
      snapshot([captured({
        machineName: 'field_conditions[und][0][target_id]', baseName: 'field_conditions',
        label: 'Conditions', kind: 'autocomplete', value: 'IgA Nephropathy (1)',
      })]),
      schema([field({
        machineName: 'field_conditions[und][0][target_id]', baseName: 'field_conditions',
        label: 'Conditions', kind: 'autocomplete',
      })])
    );
    expect(result.matches[0].blankOnMiss).toBe(false);
  });

  test('group detection covers the names these sites use', () => {
    expect(isGroupField('og_group_ref')).toBe(true);
    expect(isGroupField('field_conditions')).toBe(false);
    expect(isGroupField('field_groups_of_people')).toBe(false);
  });
});

test('normalising a label drops case, punctuation and a trailing plural', () => {
  expect(normalizeLabel('Topics:')).toBe(normalizeLabel('Topic'));
  expect(normalizeLabel('Teaser  Image')).toBe('teaser image');
  // Not so aggressive that different fields collide.
  expect(normalizeLabel('Summary')).not.toBe(normalizeLabel('Subtitle'));
});

test.describe('a real copy onto a real form', () => {
  let bundle: string;

  test.beforeAll(async () => {
    const entry = path.join(FIXTURES, '.clone-match-entry.ts');
    fs.writeFileSync(entry, `
      export { discoverSchema } from '../../src/lib/formSchema';
      export { captureNode } from '../../src/lib/clone/snapshot';
      export { matchFields } from '../../src/lib/clone/match';
    `);
    const built = await esbuild.build({
      entryPoints: [entry], bundle: true, write: false, format: 'iife',
      globalName: 'C', platform: 'browser', target: 'es2020',
    });
    bundle = built.outputFiles[0].text;
    fs.unlinkSync(entry);
  });

  const open = async (page: import('@playwright/test').Page, fixture: string) => {
    await page.setContent(fs.readFileSync(path.join(FIXTURES, fixture), 'utf8'));
    await page.evaluate(() => {
      (window as any).chrome = { runtime: { sendMessage: () => Promise.resolve({ ok: true }) } };
    });
    await page.addScriptTag({ content: bundle });
  };

  /** Fills the fields an editor would, then copies the page. */
  const copyFrom = async (page: import('@playwright/test').Page, fixture: string, type: string) => {
    await open(page, fixture);
    return page.evaluate(async (t) => {
      const api = (window as any).C;
      const set = (name: string, value: string) => {
        const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
        if (el) { el.value = value; return true; }
        return false;
      };
      set('title_field[und][0][value]', 'Understanding IgA Nephropathy');
      set('field_summary[und][0][value]', 'A short summary of the condition.');
      set('body[und][0][value]', '<p>The body of the page.</p>');
      set('field_subtitle[und][0][value]', 'What patients should know');

      const schema = api.discoverSchema(document, { pathname: `/node/add/${t}` });
      return api.captureNode(schema, {
        href: `https://old.example.edu/node/add/${t}`, origin: 'https://old.example.edu',
      });
    }, type);
  };

  test('the shared core fills by name, across different content types', async ({ page }) => {
    await page.goto('data:text/html,<body>host</body>');
    const copied = await copyFrom(page, 'captured/news.html', 'news');

    await open(page, 'captured/page.html');
    const result = await page.evaluate((snap) => {
      const api = (window as any).C;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      const matched = api.matchFields(snap, schema);
      return {
        filled: matched.matches.map((m: any) => ({
          target: m.target.machineName, tier: m.tier, value: String(m.value).slice(0, 40),
        })),
        unmapped: matched.unmapped.map((u: any) => u.label),
      };
    }, copied);

    const byTarget = new Map(result.filled.map((f: any) => [f.target, f]));
    for (const name of [
      'title_field[und][0][value]', 'field_summary[und][0][value]',
      'body[und][0][value]', 'field_subtitle[und][0][value]',
    ]) {
      expect(byTarget.get(name), `${name} was not filled from the copy`).toBeTruthy();
      expect((byTarget.get(name) as any).tier).toBe('machine-name');
    }
    expect((byTarget.get('title_field[und][0][value]') as any).value)
      .toBe('Understanding IgA Nephropathy');
  });

  test('news-only fields are reported rather than forced into a Page', async ({ page }) => {
    await page.goto('data:text/html,<body>host</body>');
    const copied = await copyFrom(page, 'captured/news.html', 'news');

    await open(page, 'captured/page.html');
    const result = await page.evaluate((snap) => {
      const api = (window as any).C;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      const matched = api.matchFields(snap, schema);
      return {
        targets: matched.matches.map((m: any) => m.target.machineName),
        unmapped: matched.unmapped.map((u: any) => `${u.label}: ${u.reason}`),
      };
    }, copied);

    // Page has no byline or news date, and must not have invented a home for them.
    expect(result.targets.some((t: string) => /byline|news_date/.test(t))).toBe(false);
    expect(result.unmapped.length).toBeGreaterThan(0);
  });

  test('pasting into the same content type matches everything by name', async ({ page }) => {
    await page.goto('data:text/html,<body>host</body>');
    const copied = await copyFrom(page, 'captured/page.html', 'page');

    await open(page, 'captured/page.html');
    const tiers = await page.evaluate((snap) => {
      const api = (window as any).C;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      return api.matchFields(snap, schema).matches.map((m: any) => m.tier);
    }, copied);

    expect(tiers.length).toBeGreaterThan(0);
    expect(tiers.every((t: string) => t === 'machine-name')).toBe(true);
  });

  test('no image field is ever a target', async ({ page }) => {
    await page.goto('data:text/html,<body>host</body>');
    const copied = await copyFrom(page, 'captured/page.html', 'page');

    await open(page, 'captured/page.html');
    const targets = await page.evaluate((snap) => {
      const api = (window as any).C;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      return api.matchFields(snap, schema).matches.map((m: any) => m.target.machineName);
    }, copied);

    expect(targets.some((t: string) => /\[fid\]$|^media\[|^files\[/.test(t))).toBe(false);
  });
});
