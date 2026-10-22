import { test, expect, type Page } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { bodyChangeRatio, buttonKind } from '../src/lib/varys/pageState';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * Capturing a Drupal node form's before and after, for Varys.
 *
 * The arithmetic (button kind, how much of the body changed) is pure and runs in Node.
 * Everything that reads a document runs bundled in a page, as strip-spans.spec.ts does,
 * with chrome.runtime stubbed so the messages the capture would send can be read back.
 * The wiring through the real worker is covered in tests/extension.test.ts.
 */

const HOST = 'https://www.cuimc.columbia.edu';

let bundle: string;

test.beforeAll(async () => {
  const result = await esbuild.build({
    stdin: {
      contents: `export * from './src/lib/varys/pageState';
                 export * from './src/content/varysCapture';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true, write: false, format: 'iife', globalName: 'Capture',
    platform: 'browser', target: 'es2020',
  });
  bundle = result.outputFiles[0].text;
});

/** A served page at a Drupal-shaped path, so location is real and the form can be anything. */
async function open(page: Page, pathname: string, body: string, bodyClass = '') {
  await page.route(`${HOST}/**`, route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body class="${bodyClass}">${body}</body></html>`,
  }));
  await page.goto(HOST + pathname);
  await page.addScriptTag({ content: bundle });
}

/**
 * Replaces chrome.runtime.sendMessage with one that records every message on
 * window.__sent and answers readRichEditor with `richEditor` (a response object), or
 * with `undefined` (as a worker that does not answer would). varysFormOpened is answered
 * with `formOpened` the same way.
 */
async function stubRuntime(page: Page, richEditor?: unknown, formOpened?: unknown) {
  await page.evaluate(([editorAnswer, openedAnswer]) => {
    const w = window as any;
    w.__sent = [];
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          sendMessage: (message: any) => {
            w.__sent.push(message);
            if (message?.type === 'readRichEditor') return Promise.resolve(editorAnswer);
            if (message?.type === 'varysFormOpened') return Promise.resolve(openedAnswer);
            return Promise.resolve(undefined);
          },
        },
      },
    });
  }, [richEditor, formOpened] as const);
}

const sent = (page: Page) => page.evaluate(() => (window as any).__sent as any[]);
const submits = async (page: Page) => (await sent(page)).filter(m => m.type === 'varysSubmit');

/** A node form with the field names Drupal 7 and the live sites use. */
const FORM = (extra: { pathauto?: boolean; body?: string; title?: string } = {}) => `
<form class="node-form node-condition-form" id="condition-node-form" method="post" action="">
  <input type="text" name="title_field[und][0][value]" value="${extra.title ?? 'Asthma in adults'}">
  <input type="text" name="metatags[und][title][value]" value="Asthma | [site:name]">
  <textarea name="metatags[und][description][value]">Learn about asthma care.</textarea>
  <input type="checkbox" name="path[pathauto]" value="1" ${extra.pathauto === false ? '' : 'checked'}>
  <input type="text" name="path[alias]" value="${extra.pathauto === false ? '/conditions/asthma' : ''}" ${extra.pathauto === false ? '' : 'disabled'}>
  <textarea id="edit-body-und-0-value" name="body[und][0][value]">${
    extra.body ?? '<h2>Symptoms</h2><p>Wheezing and a tight chest are common signs of asthma in adults.</p>'
  }</textarea>
  <input type="submit" id="edit-submit" name="op" value="Save as draft">
  <input type="submit" id="edit-submit-publish" name="op" value="Save and publish">
  <input type="submit" id="edit-preview-changes" name="op" value="View changes">
  <input type="submit" id="edit-delete" name="op" value="Delete (all revisions)">
  <input type="submit" id="edit-remove" name="op" value="Remove">
  <input type="submit" id="edit-cancel" name="op" value="Cancel">
  <input type="submit" id="edit-attach" name="field_image_und_0_attach_button" value="Attach">
  <input type="submit" id="edit-more" name="field_x_add_more" value="Add another item">
</form>
<form id="search-form" action="/search"><input type="text" name="q"><input type="submit" name="op" value="Search"></form>`;

/** Dispatches a submit event on `selector`'s form the way the browser would, with a submitter. */
const submitWith = (page: Page, submitterSelector: string | null, formSelector = '.node-form') =>
  page.evaluate(([submitter, form]) => {
    const f = document.querySelector(form as string) as HTMLFormElement;
    const s = submitter ? document.querySelector(submitter) as HTMLElement : null;
    const ev = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: s });
    f.dispatchEvent(ev);
    return { defaultPrevented: ev.defaultPrevented };
  }, [submitterSelector, formSelector] as const);

/**
 * Mounts the capture on the node form and waits for its (asynchronous) before read.
 * With `editorsReady` the capture is told the editors are built at once; without it, it
 * is not told anything and reads straight away.
 */
const mount = (page: Page, editorsReady = false) =>
  page.evaluate(async withReady => {
    const form = document.querySelector('.node-form') as HTMLFormElement;
    (window as any).Capture.mountVarysCapture(form, withReady ? Promise.resolve() : undefined);
    await new Promise(resolve => setTimeout(resolve, 50));
  }, editorsReady);

const words = (n: number, seed = 'w') => Array.from({ length: n }, (_, i) => `${seed}${i}`);

// ---------------------------------------------------------------------------- pure

test.describe('buttonKind', () => {
  test('publish and draft are told apart, and anything else is a plain save', () => {
    expect(buttonKind('Save and publish')).toBe('publish');
    expect(buttonKind('Save as draft')).toBe('draft');
    expect(buttonKind('Save')).toBe('save');
    expect(buttonKind('')).toBe('save');
    expect(buttonKind('PUBLISH')).toBe('publish');
    expect(buttonKind('Draft')).toBe('draft');
  });
});

test.describe('bodyChangeRatio', () => {
  test('identical text is 0', () => {
    const t = words(300).join(' ');
    expect(bodyChangeRatio(t, t)).toBe(0);
  });

  test('changing one word of 300 barely moves it', () => {
    const before = words(300);
    const after = [...before];
    after[150] = 'changed';
    const ratio = bodyChangeRatio(before.join(' '), after.join(' '));
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(0.05);
  });

  test('replacing half of the paragraphs is well past the rewrite line', () => {
    const paragraph = (seed: string) => words(30, seed).join(' ');
    const before = Array.from({ length: 10 }, (_, i) => paragraph(`a${i}x`));
    const after = before.map((p, i) => (i < 5 ? p : paragraph(`b${i}y`)));
    expect(bodyChangeRatio(before.join('\n'), after.join('\n'))).toBeGreaterThan(0.3);
  });

  test('an empty side against a non-empty one is 1, and two empty sides are 0', () => {
    expect(bodyChangeRatio('', 'some new words here')).toBe(1);
    expect(bodyChangeRatio('some old words here', '')).toBe(1);
    expect(bodyChangeRatio('', '')).toBe(0);
    expect(bodyChangeRatio('  \n ', '')).toBe(0);
  });

  test('case and punctuation are not changes', () => {
    expect(bodyChangeRatio('The quick brown fox jumps.', 'the QUICK brown, fox jumps')).toBe(0);
  });

  test('text too short to hold a 3-gram still compares: same is 0, different is 1', () => {
    expect(bodyChangeRatio('Hello there', 'hello there')).toBe(0);
    expect(bodyChangeRatio('Hello there', 'Goodbye now')).toBe(1);
  });
});

// ------------------------------------------------------------------- pageStateFrom

test.describe('pageStateFrom', () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    title: 'Asthma', metaTitle: null, metaDescription: null, alias: null, pathauto: false,
    bodyHtml: '', host: 'www.cuimc.columbia.edu', ...over,
  });

  const stateFrom = async (page: Page, r: object, beforeHtml: string | null) => {
    await open(page, '/node/1/edit', '');
    return page.evaluate(([rv, b]) => (window as any).Capture.pageStateFrom(rv, b), [r, beforeHtml] as const);
  };

  test('reads headings and internal links from the body, in order', async ({ page }) => {
    const state = await stateFrom(page, raw({
      bodyHtml: '<h2>Symptoms</h2><p>Text.</p><a href="/doctors">x</a><a href="https://other.org/y">z</a>',
    }), null);
    expect(state.headings).toEqual([{ level: 2, text: 'Symptoms' }]);
    expect(state.links).toEqual(['/doctors']);
  });

  test('h2 and h3 only, in document order, with inline markup and empty headings handled', async ({ page }) => {
    const state = await stateFrom(page, raw({
      bodyHtml: '<h1>Page</h1><h2>First  <em>one</em></h2><h4>Skip</h4><h3>Sub\n heading</h3>'
        + '<h2>&nbsp;</h2><h2></h2><h2>Second</h2>',
    }), null);
    expect(state.headings).toEqual([
      { level: 2, text: 'First one' },
      { level: 3, text: 'Sub heading' },
      { level: 2, text: 'Second' },
    ]);
  });

  test('a link counts when it is relative or on this host, as a path, once', async ({ page }) => {
    const state = await stateFrom(page, raw({
      bodyHtml: [
        '<a href="/doctors">a</a>',
        '<a href="https://www.cuimc.columbia.edu/conditions/asthma?tab=2#top">b</a>',
        '<a href="https://cuimc.columbia.edu/about">c</a>',
        '<a href="care/plans">d</a>',
        '<a href="/doctors">again</a>',
        '<a href="HTTPS://WWW.CUIMC.COLUMBIA.EDU/Shouting">e</a>',
        // None of these is an internal link to a page.
        '<a href="https://other.org/y">f</a>',
        '<a href="//other.org/z">g</a>',
        '<a href="https://www.cuimc.columbia.edu.evil.org/x">h</a>',
        '<a href="mailto:a@b.org">i</a>',
        '<a href="tel:+12125551212">j</a>',
        '<a href="javascript:void(0)">k</a>',
        '<a href="#section">l</a>',
        '<a>no href</a>',
      ].join(''),
    }), null);
    expect(state.links).toEqual(['/doctors', '/conditions/asthma', '/about', '/care/plans', '/Shouting']);
  });

  test('the alias is null when pathauto is on or the value is blank, and has no leading slash', async ({ page }) => {
    const alias = async (r: object) => (await stateFrom(page, raw(r), null)).alias;
    expect(await alias({ alias: 'conditions/asthma', pathauto: true })).toBeNull();
    expect(await alias({ alias: '', pathauto: false })).toBeNull();
    expect(await alias({ alias: '   ', pathauto: false })).toBeNull();
    expect(await alias({ alias: null, pathauto: false })).toBeNull();
    expect(await alias({ alias: '/conditions/asthma', pathauto: false })).toBe('conditions/asthma');
    expect(await alias({ alias: ' conditions/asthma ', pathauto: false })).toBe('conditions/asthma');
  });

  test('the title and the raw search title and description pass through, tokens and all', async ({ page }) => {
    const state = await stateFrom(page, raw({
      title: 'Asthma in adults', metaTitle: '[node:title] | [site:name]', metaDescription: null,
    }), null);
    expect(state.title).toBe('Asthma in adults');
    expect(state.meta_title).toBe('[node:title] | [site:name]');
    expect(state.meta_description).toBeNull();
  });

  test('words are counted across blocks, not glued together at their edges', async ({ page }) => {
    const count = async (html: string) => (await stateFrom(page, raw({ bodyHtml: html }), null)).body_words;
    expect(await count('<p>one two</p><p>three</p>')).toBe(3);
    expect(await count('<h2>Care</h2><ul><li>first item</li><li>second item</li></ul>')).toBe(5);
    expect(await count('line one<br>line two')).toBe(4);
    expect(await count('Dr.&nbsp;Smith <strong>joined</strong> us')).toBe(4);
    expect(await count('')).toBe(0);
    expect(await count('<p> </p>')).toBe(0);
  });

  test('new sentences are only those the before body lacks, six words or more, at most three', async ({ page }) => {
    const before = '<p>Our clinic opens at nine every weekday morning. Call ahead to book a visit today.</p>';
    const after = '<h2>Overview</h2>'
      + '<p>Our clinic opens at nine every weekday morning. <strong>Call ahead</strong> to  book a visit today.</p>'
      + '<p>New patients are seen within two weeks of calling. Parking is free for all patients and visitors. '
      + 'We accept most major insurance plans here. Interpreters are available in over forty languages. Call us.</p>';
    const state = await stateFrom(page, raw({ bodyHtml: after }), before);
    expect(state.new_sentences).toEqual([
      'New patients are seen within two weeks of calling.',
      'Parking is free for all patients and visitors.',
      'We accept most major insurance plans here.',
    ]);
  });

  test('a before state has no new sentences, and neither does a body that only lost text', async ({ page }) => {
    const html = '<p>Our clinic opens at nine every weekday morning. Call ahead to book a visit today.</p>';
    expect((await stateFrom(page, raw({ bodyHtml: html }), null)).new_sentences).toEqual([]);
    expect((await stateFrom(page, raw({ bodyHtml: '<p>Our clinic opens at nine every weekday morning.</p>' }), html))
      .new_sentences).toEqual([]);
  });

  test('on a page that began empty, the first sentences are the new ones', async ({ page }) => {
    const state = await stateFrom(page, raw({
      bodyHtml: '<p>Welcome to the new asthma program at our center.</p>',
    }), '');
    expect(state.new_sentences).toEqual(['Welcome to the new asthma program at our center.']);
  });

  test('a sentence is cut to 200 characters, and repeated ones are listed once', async ({ page }) => {
    const long = `${words(60, 'longword').join(' ')}.`;
    const repeated = 'This sentence appears twice in the new body text.';
    const state = await stateFrom(page, raw({
      bodyHtml: `<p>${long}</p><p>${repeated}</p><p>${repeated}</p>`,
    }), '<p></p>');
    expect(state.new_sentences).toHaveLength(2);
    expect(state.new_sentences[0].length).toBeLessThanOrEqual(200);
    expect(long.startsWith(state.new_sentences[0])).toBe(true);
    expect(state.new_sentences[1]).toBe(repeated);
  });

  test('a cut never splits a character in two', async ({ page }) => {
    // 199 characters, then an emoji: a cut at 200 UTF-16 units would keep half of it, a lone
    // surrogate that is not text at all. Varys counts 200 characters, not 200 units.
    const lead = 'alpha beta gamma delta epsilon zeta ';
    const sentence = `${lead}${'x'.repeat(199 - lead.length)}\u{1F600}\u{1F600} and more words follow it.`;
    const state = await stateFrom(page, raw({ bodyHtml: `<p>${sentence}</p>` }), '<p></p>');
    const [cut] = state.new_sentences;
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut.endsWith('\u{1F600}')).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  test('nothing in the body markup runs while it is read', async ({ page }) => {
    await stateFrom(page, raw({ bodyHtml: '<p>Text</p><img src="x" onerror="window.__ran = true">' }), null);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).__ran)).toBeUndefined();
  });
});

// ------------------------------------------------------------------- publicUrlFor

test.describe('publicUrlFor', () => {
  const urlFor = async (page: Page, pathname: string, tabsHtml = '') => {
    await open(page, pathname, tabsHtml);
    return page.evaluate(p => (window as any).Capture.publicUrlFor(
      { pathname: p, host: 'www.cuimc.columbia.edu' }, document), pathname);
  };

  test('page url never points at the edit form', async ({ page }) => {
    expect(await urlFor(page, '/node/23110/edit')).toBe(`${HOST}/node/23110`);
    expect(await urlFor(page, '/node/add/news')).toBeNull();
  });

  test('the View tab is the public page, whatever its alias is', async ({ page }) => {
    const tabs = `<ul class="tabs primary">
      <li><a href="/conditions/asthma">View</a></li>
      <li class="active"><a href="/node/23110/edit" class="active">Edit</a></li>
      <li><a href="/node/23110/revisions">Revisions</a></li></ul>`;
    expect(await urlFor(page, '/node/23110/edit', tabs)).toBe(`${HOST}/conditions/asthma`);
  });

  test('tabs that are edit or node sub-pages are passed over, wherever View sits', async ({ page }) => {
    const tabs = `<ul class="tabs primary">
      <li><a href="/node/23110/edit">Edit</a></li>
      <li><a href="/some/alias/edit">Edit (aliased)</a></li>
      <li><a href="/node/23110/devel">Devel</a></li>
      <li><a href="/conditions/asthma?destination=admin/content#top">View</a></li></ul>`;
    expect(await urlFor(page, '/node/23110/edit', tabs)).toBe(`${HOST}/conditions/asthma`);
  });

  test('a bare .tabs container is read when there is no primary list', async ({ page }) => {
    const tabs = '<div class="tabs"><a href="/conditions/asthma">View</a><a href="/node/23110/edit">Edit</a></div>';
    expect(await urlFor(page, '/node/23110/edit', tabs)).toBe(`${HOST}/conditions/asthma`);
  });

  test('with only edit tabs it falls back to the node address', async ({ page }) => {
    const tabs = '<ul class="tabs primary"><li><a href="/node/23110/edit">Edit</a></li></ul>';
    expect(await urlFor(page, '/node/23110/edit', tabs)).toBe(`${HOST}/node/23110`);
  });

  test('a tab on another host is not this page, so the node address is used', async ({ page }) => {
    for (const href of ['https://evil.example/conditions/asthma', '//other.columbia.edu/conditions/asthma',
      'https://cuimc.columbia.edu/conditions/asthma']) {
      const tabs = `<ul class="tabs primary"><li><a href="${href}">View</a></li></ul>`;
      expect(await urlFor(page, '/node/23110/edit', tabs), href).toBe(`${HOST}/node/23110`);
    }
    // The same host written out in full is still this site.
    const own = `<ul class="tabs primary"><li><a href="${HOST}/conditions/asthma">View</a></li></ul>`;
    expect(await urlFor(page, '/node/23110/edit', own)).toBe(`${HOST}/conditions/asthma`);
  });
});

// ------------------------------------------------------------------- reading a form

test.describe('readRawValues', () => {
  test('reads the live field names', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM({ pathauto: false }));
    const raw = await page.evaluate(() => (window as any).Capture.readRawValues(
      document.querySelector('.node-form'), '<p>body</p>'));
    expect(raw).toEqual({
      title: 'Asthma in adults',
      metaTitle: 'Asthma | [site:name]',
      metaDescription: 'Learn about asthma care.',
      alias: '/conditions/asthma',
      pathauto: false,
      bodyHtml: '<p>body</p>',
      host: 'www.cuimc.columbia.edu',
    });
  });

  test('pathauto on reads as true even though the alias box is disabled', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    const raw = await page.evaluate(() => (window as any).Capture.readRawValues(
      document.querySelector('.node-form'), ''));
    expect(raw.pathauto).toBe(true);
  });

  test('an older form names its title "title" and has no metatags or path fields', async ({ page }) => {
    await open(page, '/node/1/edit', `<form class="node-form"><input name="title" value="Old form"></form>`);
    const raw = await page.evaluate(() => (window as any).Capture.readRawValues(
      document.querySelector('.node-form'), ''));
    expect(raw).toMatchObject({
      title: 'Old form', metaTitle: null, metaDescription: null, alias: null, pathauto: false,
    });
  });

  test('title_field wins over a plain title when a form has both', async ({ page }) => {
    await open(page, '/node/1/edit', `<form class="node-form">
      <input name="title" value="Hidden machine title"><input name="title_field[und][0][value]" value="Shown title"></form>`);
    const raw = await page.evaluate(() => (window as any).Capture.readRawValues(
      document.querySelector('.node-form'), ''));
    expect(raw.title).toBe('Shown title');
  });

  test('reads a real captured form', async ({ page }) => {
    await page.goto(`file://${path.join(__dirname, 'fixtures', 'captured', 'news.html')}`);
    await page.addScriptTag({ content: bundle });
    const raw = await page.evaluate(() => {
      const form = document.querySelector('form.node-form') as HTMLFormElement;
      (form.querySelector('[name="title_field[und][0][value]"]') as HTMLInputElement).value = 'A news story';
      return (window as any).Capture.readRawValues(form, '');
    });
    expect(raw).toMatchObject({
      title: 'A news story', metaTitle: '', metaDescription: expect.any(String), pathauto: true,
    });
  });
});

test.describe('readBodyHtml', () => {
  test('reads the rich editor through the worker, by the body textarea id', async ({ page }) => {
    await open(page, '/node/1/edit', FORM());
    await stubRuntime(page, { ok: true, editor: 'ckeditor', value: '<p>from the editor</p>' });
    const html = await page.evaluate(() => (window as any).Capture.readBodyHtml(document.querySelector('.node-form')));
    expect(html).toBe('<p>from the editor</p>');
    expect(await sent(page)).toEqual([{ type: 'readRichEditor', elementId: 'edit-body-und-0-value' }]);
  });

  test('falls back to the textarea when there is no editor, no answer, or the worker fails', async ({ page }) => {
    await open(page, '/node/1/edit', FORM({ body: '<p>plain textarea</p>' }));
    const read = () => page.evaluate(() => (window as any).Capture.readBodyHtml(document.querySelector('.node-form')));

    await stubRuntime(page, { ok: true, editor: 'none' });
    expect(await read()).toBe('<p>plain textarea</p>');
    await stubRuntime(page, { ok: false });
    expect(await read()).toBe('<p>plain textarea</p>');
    await stubRuntime(page, undefined);
    expect(await read()).toBe('<p>plain textarea</p>');

    await page.evaluate(() => {
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        value: { runtime: { sendMessage: () => Promise.reject(new Error('gone')) } },
      });
    });
    expect(await read()).toBe('<p>plain textarea</p>');
  });

  test('finds the body by its field name, and asks for the editor under the id it actually has', async ({ page }) => {
    // An AJAX rebuild can leave Drupal's id suffixed; the editor is registered under that one.
    await open(page, '/node/1/edit', `<form class="node-form">
      <textarea id="edit-body-und-0-value--2" name="body[und][0][value]"><p>suffixed</p></textarea></form>`);
    await stubRuntime(page, { ok: true, editor: 'none' });
    const html = await page.evaluate(() => (window as any).Capture.readBodyHtml(document.querySelector('.node-form')));
    expect(html).toBe('<p>suffixed</p>');
    expect(await sent(page)).toEqual([{ type: 'readRichEditor', elementId: 'edit-body-und-0-value--2' }]);
  });

  test('is empty when the form has no body field', async ({ page }) => {
    await open(page, '/node/1/edit', '<form class="node-form"><input name="title" value="x"></form>');
    await stubRuntime(page);
    expect(await page.evaluate(() => (window as any).Capture.readBodyHtml(document.querySelector('.node-form')))).toBe('');
  });
});

// --------------------------------------------------------------- the connection check

test.describe('varysIsConnected', () => {
  const ask = (page: Page, answer: unknown) =>
    page.evaluate(async a => {
      const w = window as any;
      w.__sent = [];
      // No chrome.storage here at all: a check that reached for it would throw.
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        value: { runtime: { sendMessage: (m: any) => { w.__sent.push(m); return a instanceof Error ? Promise.reject(a) : Promise.resolve(a); } } },
      });
      return w.Capture.varysIsConnected();
    }, answer);

  test('asks the worker for the status, and is true only for a live connection', async ({ page }) => {
    await open(page, '/node/1/edit', '');
    expect(await ask(page, { email: 'x@cumc.columbia.edu', connectedAt: 'then', expired: false })).toBe(true);
    expect(await sent(page)).toEqual([{ type: 'varysStatus' }]);
  });

  test('is false when not connected, expired, unanswered or the worker is unreachable', async ({ page }) => {
    await open(page, '/node/1/edit', '');
    expect(await ask(page, null)).toBe(false);
    expect(await ask(page, undefined)).toBe(false);
    expect(await ask(page, { email: 'x@cumc.columbia.edu', connectedAt: 'then', expired: true })).toBe(false);
    expect(await ask(page, { email: 'x@cumc.columbia.edu', connectedAt: 'then' })).toBe(false);
    expect(await ask(page, new Error('Receiving end does not exist'))).toBe(false);
  });
});

// ------------------------------------------------------------------ the submit listener

test.describe('mountVarysCapture', () => {
  test('a save sends the before and after state to the worker, with the page address', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM(), 'html node-type-condition');
    await stubRuntime(page);
    await mount(page);

    await page.evaluate(() => {
      const set = (name: string, value: string) =>
        ((document.querySelector(`[name="${name}"]`)) as HTMLInputElement).value = value;
      set('title_field[und][0][value]', 'Asthma care for adults');
      set('metatags[und][description][value]', 'Where to get asthma care.');
      set('body[und][0][value]', '<h2>Symptoms</h2><p>Wheezing and a tight chest are common signs of asthma in adults.</p>'
        + '<h2>Treatment</h2><p>Controller inhalers are the mainstay of treatment for most people.</p>'
        + '<a href="/doctors">find a doctor</a>');
    });
    await submitWith(page, '#edit-submit-publish');

    const [message] = await submits(page);
    expect(await submits(page)).toHaveLength(1);
    expect(message).toMatchObject({
      type: 'varysSubmit',
      formPath: '/node/23110/edit',
      pageUrl: `${HOST}/node/23110`,
      nodeId: '23110',
      contentType: 'condition',
      button: 'publish',
      isNew: false,
    });
    expect(message.before).toEqual({
      title: 'Asthma in adults',
      meta_title: 'Asthma | [site:name]',
      meta_description: 'Learn about asthma care.',
      alias: null,
      headings: [{ level: 2, text: 'Symptoms' }],
      links: [],
      body_words: 13,
      new_sentences: [],
    });
    expect(message.after).toMatchObject({
      title: 'Asthma care for adults',
      meta_description: 'Where to get asthma care.',
      headings: [{ level: 2, text: 'Symptoms' }, { level: 2, text: 'Treatment' }],
      links: ['/doctors'],
      new_sentences: ['Controller inhalers are the mainstay of treatment for most people.'],
    });
    expect(message.bodyChangeRatio).toBeGreaterThan(0.3);
    expect(message.bodyChangeRatio).toBeLessThanOrEqual(1);
  });

  test('a new page has a before of null, always present, and its first sentences as new', async ({ page }) => {
    await open(page, '/node/add/news', FORM({ body: '' }), 'html node-type-news');
    await stubRuntime(page);
    await mount(page);
    await page.evaluate(() => {
      (document.querySelector('[name="body[und][0][value]"]') as HTMLTextAreaElement).value =
        '<p>Columbia opens a new asthma program for adults this fall.</p>';
    });
    await submitWith(page, '#edit-submit');

    const [message] = await submits(page);
    expect('before' in message).toBe(true);
    expect(message.before).toBeNull();
    expect(message).toMatchObject({
      formPath: '/node/add/news', pageUrl: null, nodeId: null, contentType: 'news',
      button: 'draft', isNew: true, bodyChangeRatio: 1,
    });
    expect(message.after.new_sentences).toEqual(['Columbia opens a new asthma program for adults this fall.']);
  });

  test('before is what the form held when it opened, not what it held at Save', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    await stubRuntime(page);
    await mount(page);
    await page.evaluate(() => {
      (document.querySelector('[name="title_field[und][0][value]"]') as HTMLInputElement).value = 'Changed';
    });
    await submitWith(page, '#edit-submit');
    const [message] = await submits(page);
    expect(message.before.title).toBe('Asthma in adults');
    expect(message.after.title).toBe('Changed');
  });

  test('the body before comes from the rich editor once the editors are ready', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM({ body: '<p>What the textarea said.</p>' }));
    await stubRuntime(page, { ok: true, editor: 'ckeditor', value: '<h2>Rich heading</h2><p>Two words</p>' });
    await mount(page, true);
    await submitWith(page, '#edit-submit');
    const [message] = await submits(page);
    expect(message.before.headings).toEqual([{ level: 2, text: 'Rich heading' }]);
    expect(message.before.body_words).toBe(4);
  });

  test('the editor is not read until the editors are ready, and a save before then still goes out', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM({ body: '<p>What the textarea said here today.</p>' }));
    await stubRuntime(page, { ok: true, editor: 'ckeditor', value: '<p>Editor text</p>' });
    // Editors that never finish building.
    await page.evaluate(() => {
      (window as any).Capture.mountVarysCapture(
        document.querySelector('.node-form'), new Promise<void>(() => undefined));
    });
    await page.waitForTimeout(50);
    expect((await sent(page)).filter(m => m.type === 'readRichEditor')).toHaveLength(0);

    await submitWith(page, '#edit-submit');
    const [message] = await submits(page);
    expect(message.before.body_words).toBe(6);
  });

  test('reads the after values only once the form-level handlers have run', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    await stubRuntime(page);
    await mount(page);
    // The rich editor writes its content into the textarea from a handler on the form.
    await page.evaluate(() => {
      document.querySelector('.node-form')!.addEventListener('submit', () => {
        (document.querySelector('[name="body[und][0][value]"]') as HTMLTextAreaElement).value =
          '<h2>Written at submit</h2>';
      });
    });
    await submitWith(page, '#edit-submit');
    const [message] = await submits(page);
    expect(message.after.headings).toEqual([{ level: 2, text: 'Written at submit' }]);
  });

  test('it sends before the event finishes, and never cancels the save', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    await stubRuntime(page);
    await mount(page);
    const result = await page.evaluate(() => {
      const form = document.querySelector('.node-form') as HTMLFormElement;
      const button = document.querySelector('#edit-submit') as HTMLElement;
      const ev = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: button });
      form.dispatchEvent(ev);
      // Nothing has been awaited since dispatch: if the message is not here it never will be.
      return {
        sentByNow: ((window as any).__sent as any[]).filter(m => m.type === 'varysSubmit').length,
        defaultPrevented: ev.defaultPrevented,
      };
    });
    expect(result).toEqual({ sentByNow: 1, defaultPrevented: false });
  });

  test('a worker that rejects, or throws, never breaks the save', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    const unhandled: string[] = [];
    page.on('pageerror', e => unhandled.push(String(e)));
    await page.evaluate(() => {
      (window as any).__later = false;
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        value: { runtime: { sendMessage: (m: any) => {
          if (m?.type === 'varysSubmit') return Promise.reject(new Error('Receiving end does not exist'));
          return Promise.resolve(undefined);
        } } },
      });
    });
    await mount(page);
    await page.evaluate(() => {
      document.addEventListener('submit', () => { (window as any).__later = true; });
    });
    await submitWith(page, '#edit-submit');
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).__later)).toBe(true);

    await page.evaluate(() => {
      (window as any).__later = false;
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        value: { runtime: { sendMessage: () => { throw new Error('Extension context invalidated.'); } } },
      });
    });
    await submitWith(page, '#edit-submit');
    expect(await page.evaluate(() => (window as any).__later)).toBe(true);
    expect(unhandled).toEqual([]);
  });

  test('only a Save is logged: delete, preview, remove, cancel and the AJAX buttons are not', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    await stubRuntime(page);
    await mount(page);
    for (const id of ['#edit-delete', '#edit-preview-changes', '#edit-remove', '#edit-cancel', '#edit-attach', '#edit-more']) {
      await submitWith(page, id);
    }
    expect(await submits(page)).toHaveLength(0);

    await submitWith(page, '#edit-submit');
    expect(await submits(page)).toHaveLength(1);
  });

  test('another form on the page is none of its business', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    await stubRuntime(page);
    await mount(page);
    await submitWith(page, null, '#search-form');
    expect(await submits(page)).toHaveLength(0);
  });

  test('a submit with no submitter is a plain save', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    await stubRuntime(page);
    await mount(page);
    await submitWith(page, null);
    const [message] = await submits(page);
    expect(message.button).toBe('save');
  });

  test('a submit another handler already cancelled is not a save, so it is not sent', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    await stubRuntime(page);
    // Registered first, so it runs first: a validation script stopping the form.
    await page.evaluate(() => {
      document.addEventListener('submit', e => e.preventDefault());
    });
    await mount(page);
    await submitWith(page, '#edit-submit');
    expect(await submits(page)).toHaveLength(0);
  });

  test('a real click on Save and publish is captured, with the browser\'s own submitter', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    // The page is about to navigate away, taking window with it, so the stub keeps its
    // record in sessionStorage, which survives a same-origin navigation.
    await page.evaluate(() => {
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        value: { runtime: { sendMessage: (m: any) => {
          const log = JSON.parse(sessionStorage.getItem('sent') ?? '[]');
          log.push(m);
          sessionStorage.setItem('sent', JSON.stringify(log));
          return Promise.resolve(undefined);
        } } },
      });
    });
    await mount(page);
    await Promise.all([
      page.waitForNavigation(),
      page.evaluate(() => (document.querySelector('#edit-submit-publish') as HTMLElement).click()),
    ]);
    const log = await page.evaluate(() => JSON.parse(sessionStorage.getItem('sent') ?? '[]'));
    const [message] = log.filter((m: any) => m.type === 'varysSubmit');
    expect(message).toMatchObject({ button: 'publish', nodeId: '23110', isNew: false });
  });

  test('a fault in the capture is reported in the console, and still never reaches the save', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    const warnings: string[] = [];
    page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
    await page.evaluate(() => {
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        value: { runtime: { sendMessage: (m: any) => {
          if (m?.type === 'varysSubmit') throw new Error('Extension context invalidated.');
          return Promise.resolve(undefined);
        } } },
      });
    });
    await mount(page);
    expect((await submitWith(page, '#edit-submit')).defaultPrevented).toBe(false);
    await expect.poll(() => warnings.some(w => w.includes('[D7 Studio] Varys capture failed'))).toBe(true);
  });
});

// ------------------------------------------------------- the before the form FIRST opened with

test.describe('the form tells the worker it opened', () => {
  const opened = async (page: Page) => (await sent(page)).filter(m => m.type === 'varysFormOpened');

  test('once its before is settled, with the before Varys is sent and the values it was read from', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    await stubRuntime(page, { ok: true, editor: 'ckeditor', value: '<h2>Rich heading</h2><p>From the editor.</p>' });
    await mount(page, true);

    await expect.poll(async () => (await opened(page)).length).toBe(1);
    const [message] = await opened(page);
    expect(message).toMatchObject({
      formPath: '/node/23110/edit',
      before: { title: 'Asthma in adults', headings: [{ level: 2, text: 'Rich heading' }] },
      raw: { title: 'Asthma in adults', bodyHtml: '<h2>Rich heading</h2><p>From the editor.</p>', pathauto: true },
    });
    // Sent after the editor was read, so the body in it is the editor's, not the textarea's.
    const types = (await sent(page)).map(m => m.type);
    expect(types.indexOf('readRichEditor')).toBeLessThan(types.indexOf('varysFormOpened'));
  });

  test('a new page announces a before of null, and the values it opened with', async ({ page }) => {
    await open(page, '/node/add/news', FORM({ body: '', title: '' }));
    await stubRuntime(page);
    await mount(page);
    await expect.poll(async () => (await opened(page)).length).toBe(1);
    const [message] = await opened(page);
    expect('before' in message).toBe(true);
    expect(message.before).toBeNull();
    expect(message.raw).toMatchObject({ title: '', bodyHtml: '' });
  });

  test('a re-render compares against the form as it FIRST opened, which the worker hands back', async ({ page }) => {
    // The page is a failed save's re-render: Drupal filled the form with what was submitted.
    const resubmitted = '<p>Wheezing and a tight chest are common signs of asthma in adults.</p>'
      + '<p>Controller inhalers are the mainstay of treatment for most people.</p>';
    await open(page, '/node/23110/edit', FORM({ title: 'Attempt one', body: resubmitted }));
    // The worker kept the values from when the form first opened, before any of this.
    const original = {
      title: 'Asthma in adults', metaTitle: 'Asthma | [site:name]', metaDescription: 'Learn about asthma care.',
      alias: '', pathauto: true, host: 'www.cuimc.columbia.edu',
      bodyHtml: '<p>Wheezing and a tight chest are common signs of asthma in adults.</p>',
    };
    await stubRuntime(page, undefined, { raw: original });
    await mount(page);
    await expect.poll(async () => (await opened(page)).length).toBe(1);

    await submitWith(page, '#edit-submit');
    const [message] = await submits(page);
    expect(message.before.title).toBe('Asthma in adults');
    expect(message.after.title).toBe('Attempt one');
    // Against the ORIGINAL body the second paragraph is new. Against the re-render it is not,
    // and the body would read as unchanged.
    expect(message.after.new_sentences).toEqual(['Controller inhalers are the mainstay of treatment for most people.']);
    expect(message.bodyChangeRatio).toBeGreaterThan(0);
  });

  test('an answer that is not a set of form values is ignored', async ({ page }) => {
    await open(page, '/node/23110/edit', FORM());
    await stubRuntime(page, undefined, { raw: { title: 42 } });
    await mount(page);
    await expect.poll(async () => (await opened(page)).length).toBe(1);
    await submitWith(page, '#edit-submit');
    const [message] = await submits(page);
    expect(message.before.title).toBe('Asthma in adults');
  });
});

// --------------------------------------------------------------- what the content script may read

test.describe('the content script and the stored key', () => {
  /**
   * The stored connection holds the key, and nothing outside the worker is shown it. The
   * content script asks the worker for a status instead. Imports of types are erased, so
   * only a VALUE import of the connection module, or a read of its storage key, would
   * ever put the key within reach of a page script.
   */
  const contentFiles = () => fs.readdirSync(path.join(ROOT, 'src/content'))
    .filter(f => /\.tsx?$/.test(f))
    .map(f => ({ f, text: fs.readFileSync(path.join(ROOT, 'src/content', f), 'utf8') }));

  const withoutComments = (text: string) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');

  test('no content file reads the stored connection', () => {
    for (const { f, text } of contentFiles()) {
      const code = withoutComments(text);
      expect(code, f).not.toMatch(/getConnection|CONNECTION_KEY|['"`]varysConnection['"`]/);
      const valueImports = code.match(/^import\s+(?!type\b)[^;]*from\s+['"][^'"]*varys\/connection['"]/gm);
      expect(valueImports, f).toBeNull();
    }
  });
});
