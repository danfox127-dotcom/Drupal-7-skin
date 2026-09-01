import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Exercises the field-discovery engine against the reconstructed node forms.
 *
 * The walker needs a real DOM, so the module is bundled at test time and evaluated
 * inside the page rather than stubbing a document. That means these tests run the
 * same code the extension ships, against markup in a browser's own parser.
 *
 * Fixture provenance, restated because it bounds what these tests prove: labels,
 * help text, tab structure and summaries come from the handoff's screenshots of the
 * live forms; `name` attributes are inferred. The rules table matches labels first
 * for exactly that reason, and these tests assert that a wrong machine name is
 * survivable.
 */

let bundle: string;

test.beforeAll(async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '../src/lib/formSchema/index.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'FormSchema',
    platform: 'browser',
    target: 'es2020',
  });
  bundle = result.outputFiles[0].text;
});

/** Loads a fixture, injects the engine, and returns a page ready to evaluate. */
async function open(page: import('@playwright/test').Page, fixture: string) {
  await page.goto(`file://${path.join(__dirname, 'fixtures', fixture)}`);
  await page.addScriptTag({ content: bundle });
}

/** Runs discovery in the page and returns a serializable view of the schema. */
async function schemaOf(page: import('@playwright/test').Page, pathname: string) {
  return page.evaluate((p) => {
    const api = (window as any).FormSchema;
    const schema = api.discoverSchema(document, { pathname: p });
    if (!schema) return null;
    return {
      contentType: schema.contentType,
      detectedFrom: schema.detectedFrom,
      fields: schema.fields.map((f: any) => ({
        machineName: f.machineName,
        baseName: f.baseName,
        label: f.label,
        kind: f.kind,
        required: f.required,
        help: f.help,
        section: f.section,
        matchedBy: f.matchedBy,
        group: f.group,
        multiValue: f.multiValue,
        optionCount: f.options ? f.options.length : null,
        options: f.options ? f.options.slice(0, 4) : null,
      })),
      verticalTabs: schema.verticalTabs.map((t: any) => ({ legend: t.legend, summary: t.summary })),
      explain: api.explainSchema(schema),
    };
  }, pathname);
}

test.describe('content type detection', () => {
  test('reads the type from /node/add/{type}', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() =>
      (window as any).FormSchema.detectContentType({ pathname: '/node/add/news' }, document.body));
    expect(result).toEqual({ contentType: 'news', detectedFrom: 'url-add' });
  });

  test('converts hyphens in the URL to machine-name underscores', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() =>
      (window as any).FormSchema.detectContentType({ pathname: '/node/add/timeline-entry' }, document.body));
    // The live site has a Timeline Entry type; its URL is hyphenated.
    expect(result.contentType).toBe('timeline_entry');
  });

  test('falls back to the node-type body class on an edit page', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() =>
      (window as any).FormSchema.detectContentType({ pathname: '/node/451/edit' }, document.body));
    expect(result).toEqual({ contentType: 'news', detectedFrom: 'body-class' });
  });

  test('returns null rather than guessing', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() => {
      const body = document.createElement('body');
      return (window as any).FormSchema.detectContentType({ pathname: '/admin/content' }, body);
    });
    expect(result).toEqual({ contentType: null, detectedFrom: null });
  });

  test('the content-type chooser at /node/add is not a form path', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const flags = await page.evaluate(() => ({
      chooser: (window as any).FormSchema.isNodeFormPath({ pathname: '/node/add' }),
      add: (window as any).FormSchema.isNodeFormPath({ pathname: '/node/add/news' }),
      edit: (window as any).FormSchema.isNodeFormPath({ pathname: '/node/451/edit' }),
      view: (window as any).FormSchema.isNodeFormPath({ pathname: '/node/451' }),
      admin: (window as any).FormSchema.isNodeFormPath({ pathname: '/admin/content' }),
    }));
    expect(flags).toEqual({ chooser: false, add: true, edit: true, view: false, admin: false });
  });

  test('discovery returns null off a node form path', async ({ page }) => {
    await open(page, 'node-add-news.html');
    expect(await schemaOf(page, '/admin/content')).toBeNull();
  });
});

test.describe('News form discovery', () => {
  test('finds the form and detects the type', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    expect(schema.contentType).toBe('news');
    expect(schema.detectedFrom).toBe('url-add');
  });

  test('collapses the 36-term Topics widget into ONE field, not 38 fields', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    const topics = schema.fields.filter(f => f.baseName === 'field_topics');
    expect(topics).toHaveLength(1);
    expect(topics[0].kind).toBe('checkboxGroup');
    // 36 top-level terms plus the two children under Health Insights.
    expect(topics[0].optionCount).toBe(38);
    expect(topics[0].label).toBe('Topics');
  });

  test('preserves taxonomy hierarchy depth in Topics options', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    const depths = await page.evaluate(() => {
      const api = (window as any).FormSchema;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const topics = schema.fields.find((f: any) => f.baseName === 'field_topics');
      return topics.options
        .filter((o: any) => ['Health Insights', 'Nutrition', 'Exercise', 'Allergy'].includes(o.label))
        .map((o: any) => ({ label: o.label, depth: o.depth }));
    });
    expect(depths).toEqual([
      { label: 'Allergy', depth: 0 },
      { label: 'Health Insights', depth: 0 },
      { label: 'Nutrition', depth: 1 },
      { label: 'Exercise', depth: 1 },
    ]);
    expect(schema).toBeTruthy();
  });

  test('routes fields into the rail sections the handoff specifies', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    const sectionOf = (base: string) => schema.fields.find(f => f.baseName === base)?.section;

    expect(sectionOf('title')).toBe('primary');
    expect(sectionOf('field_subtitle')).toBe('primary');
    expect(sectionOf('body')).toBe('primary');
    expect(sectionOf('field_byline')).toBe('typeFields');
    expect(sectionOf('field_display_date')).toBe('typeFields');
    expect(sectionOf('field_topics')).toBe('topics');
    expect(sectionOf('field_primary_topic')).toBe('topics');
    expect(sectionOf('field_tags')).toBe('topics');
    expect(sectionOf('field_related_conditions')).toBe('related');
    expect(sectionOf('field_references')).toBe('related');
    expect(sectionOf('field_teaser_image')).toBe('multimedia');
    expect(sectionOf('field_sitewide_news')).toBe('groups');
    expect(sectionOf('og_group_ref')).toBe('groups');
  });

  test('the summary and body are distinguished, both under primary', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    const summary = schema.fields.find(f => f.machineName.includes('[summary]'))!;
    const body = schema.fields.find(f => f.machineName === 'body[und][0][value]')!;

    expect(summary.section).toBe('primary');
    expect(summary.label).toBe('Summary');
    expect(summary.kind).toBe('textarea');
    expect(body.section).toBe('primary');
    expect(body.label).toBe('Body');
    // The CKEditor wrapper must be recognized, or the rail renders a bare textarea.
    expect(body.kind).toBe('wysiwyg');
  });

  test('required fields are detected, and optional ones are not', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    const req = (base: string) => schema.fields.find(f => f.baseName === base)?.required;

    expect(req('title')).toBe(true);
    expect(req('body')).toBe(true);          // required on News
    expect(req('field_subtitle')).toBe(false);
    expect(req('field_byline')).toBe(false);
  });

  test('the required marker is stripped from labels', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    // Not "Title *" or "Title:".
    expect(schema.fields.find(f => f.baseName === 'title')!.label).toBe('Title');
    for (const field of schema.fields) {
      expect(field.label).not.toContain('*');
      expect(field.label.endsWith(':')).toBe(false);
    }
  });

  test('help text is captured', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    expect(schema.fields.find(f => f.baseName === 'field_sitewide_news')!.help)
      .toBe('Whether or not to include this article in the sitewide list.');
    expect(schema.fields.find(f => f.machineName.includes('[summary]'))!.help)
      .toContain('One or two sentences');
  });

  test('widget kinds are classified', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    const kind = (base: string) => schema.fields.find(f => f.baseName === base)?.kind;

    expect(kind('field_primary_topic')).toBe('select');
    expect(kind('field_topics')).toBe('checkboxGroup');
    expect(kind('field_teaser_image')).toBe('file');
    expect(kind('field_display_date')).toBe('date');
    expect(kind('field_paragraphs')).toBe('paragraphs');
    // Related content and groups are autocompletes, not plain text.
    expect(kind('field_related_conditions')).toBe('autocomplete');
    expect(kind('og_group_ref')).toBe('autocomplete');
    expect(kind('field_tags')).toBe('autocomplete');
  });

  test('multi-value widgets are flagged', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    expect(schema.fields.find(f => f.baseName === 'field_related_conditions')!.multiValue).toBe(true);
  });

  test('structural and security inputs are excluded', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    const names = schema.fields.map(f => f.baseName);
    for (const junk of ['form_build_id', 'form_token', 'form_id', 'changed', 'op']) {
      expect(names).not.toContain(junk);
    }
  });

  test('reads the vertical tabs with their summaries', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    expect(schema.verticalTabs).toEqual([
      { legend: 'Meta tags', summary: 'Using defaults' },
      { legend: 'URL path settings', summary: 'Automatic alias' },
      { legend: 'XML sitemap', summary: 'Inclusion: Default (included) | Priority: Default (0.5)' },
      { legend: 'Revision information', summary: 'New revision' },
      { legend: 'Shield settings', summary: 'Not hidden' },
    ]);
  });

  test('vertical-tab fields collapse into seo / revision / display, not the left column', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    const sectionOf = (base: string) => schema.fields.find(f => f.baseName === base)?.section;
    const sectionOfName = (name: string) =>
      schema.fields.find(f => f.machineName === name)?.section;

    /**
     * The metatags fall in two places on purpose. The search result title and description
     * go to 'search', which leads the rail and opens by default; everything else about
     * metatags stays in 'seo'. Asserting on baseName alone cannot tell them apart, since
     * every metatag shares the base name `metatags`.
     */
    expect(sectionOfName('metatags[und][title][value]')).toBe('search');
    expect(sectionOfName('metatags[und][description][value]')).toBe('search');
    expect(sectionOfName('metatags[und][keywords][value]')).toBe('seo');
    expect(sectionOf('path')).toBe('seo');
    expect(sectionOf('xmlsitemap')).toBe('seo');
    expect(sectionOf('revision')).toBe('revision');
    expect(sectionOf('log')).toBe('revision');
    expect(sectionOf('shield')).toBe('display');
  });

  test('News has no menu section, per the field matrix', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    expect(schema.fields.filter(f => f.section === 'menu')).toHaveLength(0);
  });

  test('nothing lands in the "other" bucket for a known type', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    const unclaimed = schema.fields.filter(f => f.section === 'other');
    expect(
      unclaimed.map(f => `${f.label} (${f.machineName})`),
      'every News field should be claimed by a rule'
    ).toEqual([]);
  });
});

test.describe('Page form discovery', () => {
  test('differs from News exactly where the field matrix says', async ({ page }) => {
    await open(page, 'node-add-page.html');
    const schema = (await schemaOf(page, '/node/add/page'))!;
    const has = (base: string) => schema.fields.some(f => f.baseName === base);

    expect(schema.contentType).toBe('page');
    // Absent on Page
    expect(has('field_byline')).toBe(false);
    expect(has('field_display_date')).toBe(false);
    expect(has('field_topics')).toBe(false);
    expect(has('field_references')).toBe(false);
    expect(has('field_related_conditions')).toBe(false);
    // Present on Page
    expect(has('field_featured_image')).toBe(true);
    expect(has('menu')).toBe(true);
    expect(has('field_full_page_override')).toBe(true);
  });

  test('body is optional on Page but required on News', async ({ page }) => {
    await open(page, 'node-add-page.html');
    const pageSchema = (await schemaOf(page, '/node/add/page'))!;
    expect(pageSchema.fields.find(f => f.machineName === 'body[und][0][value]')!.required).toBe(false);
    expect(pageSchema.fields.find(f => f.machineName.includes('[summary]'))!.required).toBe(true);
  });

  test('menu fields land in the menu section', async ({ page }) => {
    await open(page, 'node-add-page.html');
    const schema = (await schemaOf(page, '/node/add/page'))!;
    const menu = schema.fields.filter(f => f.section === 'menu');
    expect(menu.length).toBeGreaterThanOrEqual(3);
    expect(menu.map(f => f.label)).toEqual(
      expect.arrayContaining(['Provide a menu link', 'Menu link title', 'Parent item'])
    );
  });

  test('the menu parent select keeps its hierarchy depth', async ({ page }) => {
    await open(page, 'node-add-page.html');
    const depths = await page.evaluate(() => {
      const api = (window as any).FormSchema;
      const schema = api.discoverSchema(document, { pathname: '/node/add/page' });
      const parent = schema.fields.find((f: any) => f.label === 'Parent item');
      return parent.options.map((o: any) => ({ label: o.label, depth: o.depth }));
    });
    // Drupal encodes depth as leading hyphens; they must be parsed off, not shown.
    // The fixture now mirrors the live main menu, which reaches five levels.
    expect(depths).toEqual([
      { label: '<Main menu>', depth: 0 },
      { label: 'About Us', depth: 1 },
      { label: 'Annual Report 2021-2022', depth: 2 },
      { label: "Dean's Message", depth: 3 },
      { label: 'Specialties', depth: 1 },
      { label: 'Cardiology & Cardiac Surgery', depth: 2 },
      { label: 'Our Services', depth: 3 },
      { label: 'Active BP Blood Pressure Monitoring', depth: 4 },
      { label: 'Video Tutorial', depth: 5 },
      { label: 'FAQ', depth: 5 },
      { label: 'Patient Resources', depth: 1 },
    ]);
    // Depth must be parsed correctly beyond three levels, which is where the picker
    // previously stopped offering options at all.
    expect(Math.max(...depths.map((d: any) => d.depth))).toBe(5);
  });

  test('the required Full page override is found and marked required', async ({ page }) => {
    await open(page, 'node-add-page.html');
    const schema = (await schemaOf(page, '/node/add/page'))!;
    const field = schema.fields.find(f => f.baseName === 'field_full_page_override')!;
    expect(field.section).toBe('display');
    expect(field.required).toBe(true);
    expect(field.kind).toBe('select');
  });

  test('the Customize display radio group is one field with options', async ({ page }) => {
    await open(page, 'node-add-page.html');
    const schema = (await schemaOf(page, '/node/add/page'))!;
    const field = schema.fields.find(f => f.baseName === 'display_mode')!;
    expect(field.kind).toBe('radioGroup');
    expect(field.optionCount).toBe(2);
    expect(field.section).toBe('display');
  });

  test('nothing lands in "other" for Page either', async ({ page }) => {
    await open(page, 'node-add-page.html');
    const schema = (await schemaOf(page, '/node/add/page'))!;
    expect(schema.fields.filter(f => f.section === 'other').map(f => f.machineName)).toEqual([]);
  });
});

test.describe('resilience to unknown and malformed markup', () => {
  test('an unknown content type still yields a usable schema', async ({ page }) => {
    await open(page, 'node-add-news.html');
    // Same DOM, a type the rules have never seen. The fields must still route.
    const schema = (await schemaOf(page, '/node/add/timeline-entry'))!;
    expect(schema.contentType).toBe('timeline_entry');
    expect(schema.fields.length).toBeGreaterThan(10);
    expect(schema.fields.some(f => f.section === 'primary')).toBe(true);
  });

  test('a field with no label falls back to its machine name instead of being blank', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const label = await page.evaluate(() => {
      const form = document.querySelector('form.node-form')!;
      const item = document.createElement('div');
      item.className = 'form-item';
      item.innerHTML = '<input type="text" name="field_mystery[und][0][value]" />';
      form.appendChild(item);
      const api = (window as any).FormSchema;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      return schema.fields.find((f: any) => f.baseName === 'field_mystery')?.label;
    });
    expect(label).toBe('field_mystery');
  });

  test('an unclaimed field is still surfaced rather than disappearing', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const result = await page.evaluate(() => {
      const form = document.querySelector('form.node-form')!;
      const item = document.createElement('div');
      item.className = 'form-item';
      item.innerHTML = '<label for="zz">Widget Frobnicator</label><input type="text" id="zz" name="field_frobnicator[und][0][value]" />';
      form.appendChild(item);
      const api = (window as any).FormSchema;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const f = schema.fields.find((x: any) => x.baseName === 'field_frobnicator');
      return { section: f?.section, matchedBy: f?.matchedBy, label: f?.label };
    });
    // Appended outside any vertical tab, so it reads as content and joins the left
    // column. The guarantee being tested is that it is surfaced at all — see the live
    // News form tests for the vertical-tab case, which routes to `other`.
    expect(result).toEqual({
      section: 'typeFields',
      matchedBy: 'fallback:contentTab',
      label: 'Widget Frobnicator',
    });
  });

  test('a form with no readable fields yields null, so Drupal keeps its own form', async ({ page }) => {
    await page.goto('data:text/html,<body class="node-type-news"><form class="node-form"><input type="hidden" name="form_id" value="x"/></form></body>');
    await page.addScriptTag({ content: bundle });
    const schema = await page.evaluate(() =>
      (window as any).FormSchema.discoverSchema(document, { pathname: '/node/add/news' }));
    expect(schema).toBeNull();
  });

  test('no node form at all yields null', async ({ page }) => {
    await page.goto('data:text/html,<body class="node-type-news"><div>no form here</div></body>');
    await page.addScriptTag({ content: bundle });
    const schema = await page.evaluate(() =>
      (window as any).FormSchema.discoverSchema(document, { pathname: '/node/add/news' }));
    expect(schema).toBeNull();
  });

  test('label matching survives an unrecognized machine name', async ({ page }) => {
    // The core bet of the design: names are inferred, labels are observed. A field
    // renamed beyond recognition must still route on its label alone.
    await open(page, 'node-add-news.html');
    const section = await page.evaluate(() => {
      const form = document.querySelector('form.node-form')!;
      const item = document.createElement('div');
      item.className = 'form-item';
      item.innerHTML = '<label for="qq">Teaser Image</label><input type="file" id="qq" name="totally_unexpected_name[0]" />';
      form.appendChild(item);
      const api = (window as any).FormSchema;
      const schema = api.discoverSchema(document, { pathname: '/node/add/news' });
      const f = schema.fields.find((x: any) => x.baseName === 'totally_unexpected_name');
      return { section: f?.section, matchedBy: f?.matchedBy };
    });
    expect(section.section).toBe('multimedia');
    expect(section.matchedBy).toContain(':label');
  });
});

test.describe('explainSchema diagnostics', () => {
  test('prints the content type, counts, and the rule that claimed each field', async ({ page }) => {
    await open(page, 'node-add-news.html');
    const schema = (await schemaOf(page, '/node/add/news'))!;
    expect(schema.explain).toContain('content type: news (via url-add)');
    expect(schema.explain).toContain('[topics]');
    expect(schema.explain).toContain('rule=');
    expect(schema.explain).toContain('Meta tags — Using defaults');
  });
});

test.describe('live News form — regressions from the real site', () => {
  /**
   * These assert against machine names and structures observed on
   * cuimc.columbia.edu, not inferred ones. Every bug below was found by running the
   * schema diagnostic on the real form; the fixture reproduces only the shapes that
   * broke.
   */
  const live = (page: import('@playwright/test').Page) => schemaOf(page, '/node/add/news');

  test('the i18n Title field is found even though it is named title_field', async ({ page }) => {
    await open(page, 'node-add-news-live.html');
    const schema = (await live(page))!;
    const title = schema.fields.find(f => f.machineName === 'title_field[und][0][value]')!;
    // The whole label-first bet: a /^title$/ name pattern would have missed this.
    expect(title.section).toBe('primary');
    expect(title.matchedBy).toContain(':label');
    expect(title.required).toBe(true);
  });

  test('a metatag labelled "Title" does NOT land in the writing surface', async ({ page }) => {
    await open(page, 'node-add-news-live.html');
    const schema = (await live(page))!;
    const twitter = schema.fields.find(f => f.machineName.includes('twitter:title'))!;
    expect(twitter.section).toBe('seo');
    expect(twitter.matchedBy).toContain('seo.byName');

    // And exactly one field is in primary per role — no duplicate "Title".
    const primaryTitles = schema.fields.filter(f => f.section === 'primary' && /^title$/i.test(f.label));
    expect(primaryTitles).toHaveLength(1);
  });

  test('multi-value row-weight selects are not treated as fields', async ({ page }) => {
    await open(page, 'node-add-news-live.html');
    const schema = (await live(page))!;
    expect(schema.fields.filter(f => /Weight for row/i.test(f.label))).toEqual([]);
    expect(schema.fields.filter(f => f.machineName.includes('_weight'))).toEqual([]);
  });

  test('Media module image fields are recognized as files, not editable text', async ({ page }) => {
    await open(page, 'node-add-news-live.html');
    const schema = (await live(page))!;
    const teaser = schema.fields.find(f => f.label === 'Teaser Image')!;
    const hero = schema.fields.find(f => f.label === 'Hero Image')!;

    // media[...] renders a textfield plus a browse button; left as text the overlay
    // would invite typing into a media reference.
    expect(teaser.kind).toBe('file');
    expect(hero.kind).toBe('file');
    expect(teaser.section).toBe('multimedia');
    // And the two stay distinct rather than collapsing to a shared `media` base.
    expect(teaser.baseName).toBe('field_image_teaser');
    expect(hero.baseName).toBe('field_image_hero');
  });

  test('the date cluster takes its label from the legend, not from "Year"', async ({ page }) => {
    await open(page, 'node-add-news-live.html');
    const schema = (await live(page))!;
    const dates = schema.fields.filter(f => f.kind === 'date');
    expect(dates).toHaveLength(1);
    expect(dates[0].label).toBe('Date');
    expect(dates[0].section).toBe('typeFields');
  });

  test('an unclaimed content field joins the left column, not a rail section', async ({ page }) => {
    await open(page, 'node-add-news-live.html');
    const schema = (await live(page))!;
    const type = schema.fields.find(f => f.baseName === 'field_news_types')!;
    // "Type" is content on the Overview tab; exiling it to `other` hides it behind a
    // rail section an editor may never open.
    expect(type.section).toBe('typeFields');
    expect(type.matchedBy).toBe('fallback:contentTab');
  });

  test('an unclaimed field inside a vertical tab still goes to other', async ({ page }) => {
    await open(page, 'node-add-news-live.html');
    const schema = (await live(page))!;
    const depth = schema.fields.find(f => f.baseName === 'comment_thread_depth')!;
    expect(depth.section).toBe('other');
    expect(depth.matchedBy).toBe('fallback:verticalTab');
  });

  test('Summary is recognized as a rich text field, so writes go through CKEditor', async ({ page }) => {
    await open(page, 'node-add-news-live.html');
    const schema = (await live(page))!;
    const summary = schema.fields.find(f => f.baseName === 'field_summary')!;
    expect(summary.section).toBe('primary');
    expect(summary.kind).toBe('wysiwyg');
    expect(summary.required).toBe(true);
  });

  test('cuimc News has one Related field — a per-site fact, not a general one', async ({ page }) => {
    /**
     * SCOPED TO CUIMC DELIBERATELY. columbiadoctors.org has four related fields
     * (Conditions, Profiles/Providers, Treatments, Specialties) per the handoff's
     * matrix; cuimc has a single "Related Services". The field list differs by site,
     * so this asserts what THIS fixture contains, not what every site contains.
     */
    await open(page, 'node-add-news-live.html');
    const schema = (await live(page))!;
    const related = schema.fields.filter(f => f.section === 'related');
    expect(related.map(f => f.label)).toEqual(['Related Services']);
    expect(related[0].kind).toBe('autocomplete');
  });

  test('the related rules cover both sites\' entity types', async ({ page }) => {
    // The rules must not encode either site's field list. Conditions, Providers,
    // Profiles, Treatments and Specialties all belong in `related` whether they arrive
    // prefixed with "Related" or bare.
    await open(page, 'node-add-news-live.html');
    const sections = await page.evaluate(() => {
      const api = (window as any).FormSchema;
      const labels = [
        'Related Conditions', 'Related Providers', 'Related Specialties',
        'Conditions', 'Providers', 'Profiles', 'Treatments', 'Specialties',
      ];
      return labels.map(label => ({
        label,
        section: api.assignSection({ label, baseName: 'field_unknown_name', groupPath: [] }).section,
      }));
    });
    for (const { label, section } of sections) {
      expect(section, `"${label}" should route to related`).toBe('related');
    }
  });

  test('framework fields route by name where their labels are generic', async ({ page }) => {
    await open(page, 'node-add-news-live.html');
    const schema = (await live(page))!;
    const sectionOf = (base: string) => schema.fields.find(f => f.baseName === base)?.section;
    const sectionOfName = (name: string) =>
      schema.fields.find(f => f.machineName === name)?.section;
    // The search-result title leads the rail; other metatags stay in seo. This fixture
    // carries only title and twitter:title, which is enough to prove the split.
    expect(sectionOfName('metatags[und][title][value]')).toBe('search');
    expect(sectionOfName('metatags[und][twitter:title][value]')).toBe('seo');
    expect(sectionOf('path')).toBe('seo');
    expect(sectionOf('log')).toBe('revision');
    expect(sectionOf('shield')).toBe('display');
  });
});

test.describe('labels that would otherwise appear twice', () => {
  /**
   * Reported: two boxes on the Specialty form both reading "Summary", one of which is the
   * default meta description. Drupal gets away with identical labels because its tabs and
   * fieldsets supply the context; the overlay removes those, so it has to put it back.
   *
   * Derived from the machine name rather than listed, because which labels collide differs
   * per site and per content type — columbiadoctors Specialty has two Summaries where cuimc
   * News has one, and a hardcoded pair would be wrong on the next form.
   */
  const labelsIn = (page: import('@playwright/test').Page, pathname: string) =>
    page.evaluate((p) => {
      const api = (window as any).FormSchema;
      const schema = api.discoverSchema(document, { pathname: p });
      return schema.fields.map((f: any) => ({
        name: f.machineName,
        label: f.label,
        shown: api.displayLabelFor(f),
        relabelled: api.wasRelabelled(f),
        // Set ONLY by the collision pass. wasRelabelled is also true for the metatag
        // overrides, which are deliberate and unrelated, so it cannot stand in for this.
        qualified: f.displayLabel ?? null,
      }));
    }, pathname);

  test('two Summaries become distinguishable, and only one is renamed', async ({ page }) => {
    await open(page, 'node-edit-specialty.html');
    const fields = await labelsIn(page, '/node/17176/edit');

    const meta = fields.find((f: any) => f.name.startsWith('field_summary'));
    const other = fields.find((f: any) => f.name.startsWith('field_specialty_summary'));

    // The required one — the default meta description — keeps Drupal's wording, so anyone
    // who knows the native form still recognises it.
    expect(meta.shown).toBe('Summary');
    expect(meta.relabelled).toBe(false);
    // The other takes the one token that distinguishes its machine name.
    expect(other.shown).toBe('Specialty summary');
    expect(other.relabelled).toBe(true);
    expect(other.qualified).toBe('Specialty summary');
    expect(meta.qualified).toBeNull();
  });

  test('no two fields in a section end up showing the same label', async ({ page }) => {
    await open(page, 'node-edit-specialty.html');
    const collisions = await page.evaluate(() => {
      const api = (window as any).FormSchema;
      const schema = api.discoverSchema(document, { pathname: '/node/17176/edit' });
      const seen = new Map<string, string[]>();
      for (const f of schema.fields) {
        const key = `${f.section}|${api.displayLabelFor(f).toLowerCase()}`;
        seen.set(key, [...(seen.get(key) ?? []), f.machineName]);
      }
      return [...seen.entries()].filter(([, names]) => names.length > 1);
    });
    expect(collisions).toEqual([]);
  });

  test('Drupal\'s own label is preserved for rule matching and diagnostics', async ({ page }) => {
    await open(page, 'node-edit-specialty.html');
    const fields = await labelsIn(page, '/node/17176/edit');
    const other = fields.find((f: any) => f.name.startsWith('field_specialty_summary'));
    // `label` is what the section rules match on and what the schema dump reports; only
    // the shown label changes. Overwriting it would silently reroute the field.
    expect(other.label).toBe('Summary');
  });

  test('a label that is already unique is never qualified', async ({ page }) => {
    await open(page, 'node-add-news-live.html');
    const fields = await labelsIn(page, '/node/add/news');
    // Renaming fields nobody asked about would be worse than the problem being fixed.
    // News has one Summary, so nothing on this form should pick up a qualifier — the
    // metatag renames still apply, but those come from the explicit override table.
    expect(fields.filter((f: any) => f.qualified)).toEqual([]);
  });

  test('the diagnostic prints both labels when they differ', async ({ page }) => {
    await open(page, 'node-edit-specialty.html');
    const dump = await page.evaluate(() => {
      const api = (window as any).FormSchema;
      return api.explainSchema(api.discoverSchema(document, { pathname: '/node/17176/edit' }));
    });
    // So a misfiled field can still be traced back to what Drupal called it.
    expect(dump).toContain('Specialty summary (Drupal: Summary)');
  });
});
