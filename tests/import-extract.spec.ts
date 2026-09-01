import { test, expect } from '@playwright/test';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The import extraction engine. Needs a real DOMParser, so it runs in the page.
 *
 * The source page below stands in for an external article: it deliberately mixes
 * content with the things that must be stripped — inline styles, tracking pixels, a
 * share widget, an iframe embed, a nav and footer, and a logo.
 */

let bundle: string;

const SOURCE = `<!DOCTYPE html>
<html><head>
  <title>Cardiac Team Reports New Findings | Heart Research Today</title>
  <meta name="description" content="Researchers followed 1,240 patients over five years and found catheter ablation held its advantage." />
  <meta property="og:title" content="OG headline that should lose to the h1" />
</head><body>
  <nav><a href="/">Home</a><a href="/news">News</a></nav>
  <header><img src="/assets/logo.svg" width="120" height="40" alt="Logo" /></header>
  <article class="article">
    <h1>Cardiac Team Reports New Findings in Atrial Fibrillation Care</h1>
    <h2 class="article-dek">A five-year study of catheter ablation outcomes across three hospitals</h2>
    <p class="byline">By Amanda R. Whitfield</p>
    <time datetime="2024-03-04">March 4, 2024</time>
    <img src="/uploads/hero-ablation.jpg" width="1200" height="630" alt="Operating room" />
    <p style="color:red" class="lead">Researchers following <a href="/study">1,240 patients</a> across three hospitals report better outcomes.</p>
    <p>The study, published this week, is among the longest follow-ups of its kind.</p>
    <h3>Method</h3>
    <ul><li>Randomized</li><li>Multi-site</li></ul>
    <p>Investigators note that patients treated within a year fared measurably better.</p>
    <div class="share"><a href="https://twitter.com/share">Share</a></div>
    <iframe src="https://player.example.com/embed"></iframe>
    <span style="font-weight:bold">Funding was provided by two foundations.</span>
    <img src="/assets/icons/sprite-arrow.png" width="16" height="16" alt="" />
  </article>
  <footer><p>© Heart Research Today</p></footer>
  <script>tracking();</script>
</body></html>`;

test.beforeAll(async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '../src/lib/import/extract.ts')],
    bundle: true, write: false, format: 'iife', globalName: 'Extract',
    platform: 'browser', target: 'es2020',
  });
  bundle = result.outputFiles[0].text;
});

/** Runs extraction in the page and returns a serializable result. */
async function run(
  page: import('@playwright/test').Page,
  html = SOURCE,
  allowed: { tags: string[]; source: 'drupal-filter-tips' | 'default' } = { tags: [], source: 'default' }
) {
  await page.goto('data:text/html,<body>host</body>');
  await page.addScriptTag({ content: bundle });
  return page.evaluate(([h, a]) => {
    const api = (window as any).Extract;
    const result = api.extract(h, 'https://heartresearchtoday.org/news/ablation-five-year-outcomes', a);
    return {
      proposals: result.proposals,
      images: result.images,
      unmapped: result.unmapped,
      bodyStats: result.bodyStats,
      allowedTags: result.allowedTags,
      annotatedHtml: result.annotatedHtml,
      summary: api.matchSummary(result),
      accepted: api.acceptedCount(result.proposals),
    };
  }, [html, allowed] as const);
}

test.describe('field proposals', () => {
  test('prefers the h1 over og:title and <title>', async ({ page }) => {
    const r = await run(page);
    const title = r.proposals.find(p => p.key === 'title')!;
    expect(title.value).toBe('Cardiac Team Reports New Findings in Atrial Fibrillation Care');
    expect(title.confidence).toBe('high');
    expect(title.source).toContain('<h1>');
    expect(title.accepted).toBe(true);
  });

  test('reads the dek as the subtitle', async ({ page }) => {
    const r = await run(page);
    const subtitle = r.proposals.find(p => p.key === 'subtitle')!;
    expect(subtitle.value).toBe('A five-year study of catheter ablation outcomes across three hospitals');
    expect(subtitle.accepted).toBe(true);
  });

  test('takes the summary from the meta description', async ({ page }) => {
    const r = await run(page);
    const summary = r.proposals.find(p => p.key === 'summary')!;
    expect(summary.value).toContain('1,240 patients');
    expect(summary.source).toContain('meta name="description"');
    expect(summary.confidence).toBe('high');
  });

  test('a byline is low confidence and defaults to SKIPPED', async ({ page }) => {
    // The handoff is specific: a byline with no matching author node cannot be
    // verified, so it must not be accepted by default.
    const r = await run(page);
    const byline = r.proposals.find(p => p.key === 'byline')!;
    expect(byline.value).toBe('Amanda R. Whitfield');
    expect(byline.confidence).toBe('low');
    expect(byline.accepted).toBe(false);
    expect(byline.source).toContain('no matching author');
  });

  test('strips the "By " prefix from the byline', async ({ page }) => {
    const r = await run(page);
    expect(r.proposals.find(p => p.key === 'byline')!.value).not.toMatch(/^by/i);
  });

  test('reads the date from time[datetime], not the visible text', async ({ page }) => {
    const r = await run(page);
    const date = r.proposals.find(p => p.key === 'date')!;
    expect(date.value).toBe('2024-03-04');
  });

  test('the accepted count excludes the skipped byline', async ({ page }) => {
    const r = await run(page);
    expect(r.accepted).toBe(r.proposals.length - 1);
  });

  test('falls back to og:title, then <title>, when there is no h1', async ({ page }) => {
    const r = await run(page, SOURCE.replace(/<h1>.*?<\/h1>/, ''));
    const title = r.proposals.find(p => p.key === 'title')!;
    expect(title.value).toBe('OG headline that should lose to the h1');
    expect(title.confidence).toBe('medium');
  });

  test('proposes nothing it cannot find, rather than empty values', async ({ page }) => {
    const r = await run(page, '<html><body><article><p>Just a paragraph of text that is long enough to be treated as an article body by the extractor.</p></article></body></html>');
    const keys = r.proposals.map(p => p.key);
    expect(keys).not.toContain('subtitle');
    expect(keys).not.toContain('byline');
    expect(keys).not.toContain('summary');
    expect(keys).not.toContain('date');
    expect(keys).toContain('body');
  });
});

test.describe('body filtering', () => {
  test('keeps structural tags so the article does not collapse', async ({ page }) => {
    const r = await run(page);
    const body = r.proposals.find(p => p.key === 'body')!;
    expect(body.value).toContain('<p>');
    expect(body.value).toContain('<h3>');
    expect(body.value).toContain('<ul>');
    expect(body.value).toContain('<li>');
  });

  test('removes scripts, iframes, share widgets, nav and footer', async ({ page }) => {
    const r = await run(page);
    const body = r.proposals.find(p => p.key === 'body')!;
    expect(body.value).not.toContain('<iframe');
    expect(body.value).not.toContain('tracking()');
    expect(body.value).not.toContain('twitter.com/share');
    expect(body.value).not.toContain('Heart Research Today');
  });

  test('strips inline styles and classes but keeps the text inside', async ({ page }) => {
    const r = await run(page);
    const body = r.proposals.find(p => p.key === 'body')!;
    expect(body.value).not.toContain('style=');
    expect(body.value).not.toContain('class=');
    // A disallowed <span> is unwrapped, not deleted — its text is content.
    expect(body.value).toContain('Funding was provided by two foundations.');
    expect(body.value).not.toContain('<span');
  });

  test('keeps links when the allowed list permits them', async ({ page }) => {
    const r = await run(page, SOURCE, { tags: ['a', 'em', 'strong'], source: 'drupal-filter-tips' });
    const body = r.proposals.find(p => p.key === 'body')!;
    expect(body.value).toContain('<a href="/study"');
    expect(r.bodyStats.linksKept).toBeGreaterThan(0);
  });

  test('honours a restrictive allowed list by unwrapping links', async ({ page }) => {
    const r = await run(page, SOURCE, { tags: ['em', 'strong'], source: 'drupal-filter-tips' });
    const body = r.proposals.find(p => p.key === 'body')!;
    expect(body.value).not.toContain('<a ');
    // The link text survives even though the tag did not.
    expect(body.value).toContain('1,240 patients');
    expect(r.bodyStats.tagsStripped).toContain('a');
  });

  test('does not duplicate the headline, dek, byline or date into the body', async ({ page }) => {
    // These live inside <article>, so a naive extraction ships them twice — once as
    // their own proposal and again as the opening lines of the body.
    const r = await run(page);
    const body = r.proposals.find(p => p.key === 'body')!;
    expect(body.value).not.toContain('Cardiac Team Reports New Findings');
    expect(body.value).not.toContain('A five-year study of catheter ablation');
    expect(body.value).not.toContain('Amanda R. Whitfield');
    expect(body.value).not.toContain('March 4, 2024');
    // The actual article prose is still there.
    expect(body.value).toContain('1,240 patients');
    expect(body.value).toContain('longest follow-ups');
  });

  test('the provenance line states what was kept and what was removed', async ({ page }) => {
    const r = await run(page);
    const body = r.proposals.find(p => p.key === 'body')!;
    expect(body.source).toMatch(/\d+ paragraphs/);
    expect(body.source).toMatch(/\d+ headings/);
    expect(body.source).toMatch(/removed|stripped/);
  });

  test('counts reflect the filtered output', async ({ page }) => {
    const r = await run(page);
    expect(r.bodyStats.paragraphs).toBeGreaterThanOrEqual(3);
    expect(r.bodyStats.headings).toBeGreaterThanOrEqual(1);
    expect(r.bodyStats.lists).toBe(1);
    expect(r.bodyStats.inlineStylesRemoved).toBeGreaterThan(0);
    expect(r.bodyStats.embedsRemoved).toBeGreaterThan(0);
  });
});

test.describe('URL scheme validation', () => {
  /**
   * The threat: source HTML is arbitrary and attacker-influenced (anyone can be asked
   * to import a URL). `href` survives the attribute allowlist, so without a scheme
   * check a javascript: link rides into the proposed body, gets written into the node,
   * and is saved — stored XSS introduced by the migration tool itself. Drupal's output
   * filter often catches it, but a Full HTML format does not.
   */
  const withLink = (href: string) => `<html><body><article>
    <p>Some prose long enough to be treated as the article body by the extractor here.</p>
    <p><a href="${href}">click me</a></p>
    <p>More prose so the container passes the length guard comfortably.</p>
  </article></body></html>`;

  const bodyFor = async (page: import('@playwright/test').Page, href: string) => {
    const r = await run(page, withLink(href), { tags: ['a', 'p'], source: 'drupal-filter-tips' });
    return r.proposals.find(p => p.key === 'body')!;
  };

  test('drops a javascript: href but keeps the link text', async ({ page }) => {
    const body = await bodyFor(page, 'javascript:alert(1)');
    expect(body.value).not.toContain('javascript:');
    expect(body.value).not.toContain('href');
    expect(body.value).toContain('click me');
  });

  test('drops javascript: obfuscated with control characters', async ({ page }) => {
    // Browsers ignore embedded newlines/tabs inside a scheme, so this executes as
    // javascript: even though a naive string comparison would not match.
    for (const payload of ['java\nscript:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)']) {
      const body = await bodyFor(page, payload);
      expect(body.value, `payload ${JSON.stringify(payload)}`).not.toMatch(/href/i);
    }
  });

  test('drops data: and vbscript: hrefs', async ({ page }) => {
    for (const payload of ['data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', 'file:///etc/passwd']) {
      const body = await bodyFor(page, payload);
      expect(body.value, `payload ${payload}`).not.toContain('href');
    }
  });

  test('keeps http, https, mailto and relative hrefs', async ({ page }) => {
    for (const href of ['https://example.org/a', 'http://example.org/a', 'mailto:someone@example.org', '/relative/path']) {
      const body = await bodyFor(page, href);
      expect(body.value, `href ${href}`).toContain(`href="${href}"`);
    }
  });

  test('leaves relative hrefs relative rather than silently rewriting them', async ({ page }) => {
    const body = await bodyFor(page, '/study');
    expect(body.value).toContain('href="/study"');
    expect(body.value).not.toContain('heartresearchtoday.org/study');
  });

  test('counts removals and states them in the provenance line', async ({ page }) => {
    const r = await run(page, withLink('javascript:alert(1)'), { tags: ['a', 'p'], source: 'drupal-filter-tips' });
    expect(r.bodyStats.unsafeUrlsRemoved).toBe(1);
    // Stripping must be visible, not silent.
    expect(r.proposals.find(p => p.key === 'body')!.source).toContain('unsafe link');
  });

  test('rejects an unsafe image src instead of rendering it', async ({ page }) => {
    const r = await run(page, `<html><body><article>
      <p>Prose long enough to satisfy the article length guard for this extraction test.</p>
      <img src="javascript:alert(1)" width="600" height="400" />
    </article></body></html>`);
    const img = r.images[0];
    expect(img.src).toBe('');
    expect(img.role).toBe('skip');
    expect(img.reason).toContain('unsupported image URL scheme');
  });

  test('safeUrlAttribute is exported and enforces the allowlist directly', async ({ page }) => {
    await page.goto('data:text/html,<body></body>');
    await page.addScriptTag({ content: bundle });
    const result = await page.evaluate(() => {
      const api = (window as any).Extract;
      const links = new Set(['http:', 'https:', 'mailto:']);
      return {
        js: api.safeUrlAttribute('javascript:alert(1)', 'https://a.example/', links),
        obfuscated: api.safeUrlAttribute('java\u0000script:alert(1)', 'https://a.example/', links),
        https: api.safeUrlAttribute('https://b.example/x', 'https://a.example/', links),
        relative: api.safeUrlAttribute('/x', 'https://a.example/', links),
        empty: api.safeUrlAttribute('   ', 'https://a.example/', links),
      };
    });
    expect(result.js).toBeNull();
    expect(result.obfuscated).toBeNull();
    expect(result.https).toBe('https://b.example/x');
    expect(result.relative).toBe('/x');
    expect(result.empty).toBeNull();
  });
});

test.describe('images', () => {
  test('finds content images and site chrome alike', async ({ page }) => {
    const r = await run(page);
    expect(r.images.length).toBe(3);
  });

  test('resolves relative src against the source URL', async ({ page }) => {
    const r = await run(page);
    const hero = r.images.find(i => i.name === 'hero-ablation.jpg')!;
    expect(hero.src).toBe('https://heartresearchtoday.org/uploads/hero-ablation.jpg');
  });

  test('pre-sets a logo to skip, with a reason', async ({ page }) => {
    const r = await run(page);
    const logo = r.images.find(i => i.name === 'logo.svg')!;
    expect(logo.role).toBe('skip');
    expect(logo.reason).toContain('likely chrome');
  });

  test('pre-sets a tiny sprite to skip and says why', async ({ page }) => {
    const r = await run(page);
    const sprite = r.images.find(i => i.name === 'sprite-arrow.png')!;
    expect(sprite.role).toBe('skip');
    expect(sprite.reason).toContain('100px');
  });

  test('a real content image defaults to teaser and reports dimensions', async ({ page }) => {
    const r = await run(page);
    const hero = r.images.find(i => i.name === 'hero-ablation.jpg')!;
    expect(hero.role).toBe('teaser');
    expect(hero.meta).toBe('1200×630');
    expect(hero.reason).toBeNull();
  });
});

test.describe('what it refuses to guess', () => {
  test('lists Topics, Related Content, Menu Placement and Groups with reasons', async ({ page }) => {
    const r = await run(page);
    expect(r.unmapped.map(u => u.label)).toEqual([
      'Topics', 'Related Content', 'Menu Placement', 'Groups',
    ]);
    for (const item of r.unmapped) {
      expect(item.reason.length).toBeGreaterThan(20);
    }
  });

  test('the match summary counts unmapped fields in the total', async ({ page }) => {
    const r = await run(page);
    expect(r.summary.total).toBe(r.proposals.length + r.unmapped.length);
    expect(r.summary.matched).toBe(r.proposals.length);
  });
});

test.describe('source pane markup', () => {
  test('annotates regions so a selected field can be outlined', async ({ page }) => {
    const r = await run(page);
    expect(r.annotatedHtml).toContain('data-d7-region="region-title"');
    expect(r.annotatedHtml).toContain('data-d7-region="region-body"');
  });

  test('the rendered copy carries no scripts, styles or frames', async ({ page }) => {
    // It is injected into a sandboxed iframe, but it should not contain executable
    // content in the first place.
    const r = await run(page);
    expect(r.annotatedHtml).not.toContain('<script');
    expect(r.annotatedHtml).not.toContain('<iframe');
    expect(r.annotatedHtml).not.toContain('<style');
  });
});

test.describe('reading Drupal\'s allowed tags off the form', () => {
  test('parses the tag list out of filter guidelines', async ({ page }) => {
    await page.goto(`data:text/html,${encodeURIComponent(`
      <form class="node-form">
        <div class="filter-guidelines">
          <p>Allowed HTML tags: &lt;a&gt; &lt;em&gt; &lt;strong&gt; &lt;blockquote&gt; &lt;ul&gt; &lt;li&gt;</p>
        </div>
      </form>`)}`);
    await page.addScriptTag({ content: bundle });
    const result = await page.evaluate(() => (window as any).Extract.readAllowedTags(document));
    expect(result.source).toBe('drupal-filter-tips');
    expect(result.tags).toEqual(['a', 'em', 'strong', 'blockquote', 'ul', 'li']);
  });

  test('falls back to a conservative default when the form publishes nothing', async ({ page }) => {
    await page.goto('data:text/html,<form class="node-form"><textarea></textarea></form>');
    await page.addScriptTag({ content: bundle });
    const result = await page.evaluate(() => (window as any).Extract.readAllowedTags(document));
    expect(result.source).toBe('default');
    expect(result.tags).toContain('a');
    expect(result.tags).toContain('strong');
  });

  test('de-duplicates repeated tags', async ({ page }) => {
    await page.goto(`data:text/html,${encodeURIComponent(`
      <div class="tips"><p>Allowed HTML tags: &lt;a&gt; &lt;a&gt; &lt;em&gt;</p></div>`)}`);
    await page.addScriptTag({ content: bundle });
    const result = await page.evaluate(() => (window as any).Extract.readAllowedTags(document));
    expect(result.tags).toEqual(['a', 'em']);
  });
});
