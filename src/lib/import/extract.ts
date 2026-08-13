/**
 * Extracts a field mapping from a fetched source page.
 *
 * Scope is deliberately narrow, per the handoff: Title, Subtitle, Summary, Body, and
 * images only. It does NOT guess Topics, Related Content, Menu Placement, or Groups —
 * and the reasons it declined are reported, because "Left for you" is the honesty of
 * the feature.
 *
 * Nothing here writes anywhere. It returns proposals for a human to accept or reject.
 */

export type Confidence = 'high' | 'medium' | 'low';

export interface Proposal {
  key: string;
  label: string;
  value: string;
  /** Where it came from, shown verbatim as the provenance line. */
  source: string;
  confidence: Confidence;
  /** Low-confidence values default to skipped, per the handoff. */
  accepted: boolean;
  /** Which region of the rendered source this came from, for outlining. */
  regionId: string | null;
}

export interface ProposedImage {
  id: string;
  src: string;
  name: string;
  /** "1200×630 · 148 KB" when known, else dimensions or empty. */
  meta: string;
  role: 'teaser' | 'featured' | 'skip';
  /** Why it was pre-set to skip, when it was. */
  reason: string | null;
}

export interface Unmapped {
  label: string;
  reason: string;
}

export interface BodyStats {
  paragraphs: number;
  headings: number;
  lists: number;
  linksKept: number;
  inlineStylesRemoved: number;
  embedsRemoved: number;
  classesRemoved: number;
  tagsStripped: string[];
  /** href/src values dropped for using a disallowed scheme. */
  unsafeUrlsRemoved: number;
}

export interface ExtractionResult {
  sourceUrl: string;
  proposals: Proposal[];
  images: ProposedImage[];
  unmapped: Unmapped[];
  bodyStats: BodyStats;
  /** Sanitized source markup for the review pane, with regions annotated. */
  annotatedHtml: string;
  /** The allowed tag list actually used, and where it came from. */
  allowedTags: { tags: string[]; source: 'drupal-filter-tips' | 'default' };
}

/**
 * Fallback allowed tags.
 *
 * Only used when Drupal's own filter guidelines could not be read. Matches Drupal 7's
 * default "Filtered HTML" set, which is conservative — better to strip something the
 * site would have allowed than to propose markup that gets silently dropped on save.
 */
export const DEFAULT_ALLOWED = ['a', 'em', 'strong', 'cite', 'blockquote', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd'];

/** Attributes worth keeping; everything else is noise or tracking. */
const KEEP_ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'width', 'height'],
};

/**
 * URL-bearing attributes, and the schemes each may use.
 *
 * An allowlist of tags and attributes is not sufficient on its own: `href` survives the
 * attribute filter, so `<a href="javascript:...">` from a source page would be carried
 * into the proposed body, written into the node, and saved. Drupal's output filter would
 * often catch it, but a Full HTML format would not — and this tool should not be the
 * thing that introduces stored XSS into the CMS.
 *
 * mailto: is permitted on links because editorial content legitimately uses it. Media
 * is stricter: no data: URIs, which can carry SVG script payloads.
 */
const URL_ATTRS: Record<string, { attr: string; protocols: Set<string> }> = {
  a: { attr: 'href', protocols: new Set(['http:', 'https:', 'mailto:']) },
  img: { attr: 'src', protocols: new Set(['http:', 'https:']) },
};

/**
 * Returns a safe value for a URL attribute, or null if it should be dropped.
 *
 * Control characters are stripped BEFORE the scheme is examined, because browsers
 * ignore them inside a scheme — `java\nscript:alert(1)` executes as `javascript:`, so
 * checking the raw string would be bypassable. The cleaned value is what gets written
 * back, since those characters have no legitimate purpose in a URL.
 *
 * Relative URLs are resolved against the source page only to determine the scheme; the
 * value itself is left relative so the markup is not silently rewritten.
 */
export function safeUrlAttribute(raw: string, base: string, protocols: Set<string>): string | null {
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!cleaned) return null;

  try {
    const url = new URL(cleaned, base);
    return protocols.has(url.protocol) ? cleaned : null;
  } catch {
    // An unparseable URL is not worth guessing at.
    return null;
  }
}

const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'object', 'embed', 'form',
  'nav', 'header', 'footer', 'aside',
  '.share', '.social', '.related', '.newsletter', '.advert', '.ad',
];

/**
 * Reads the allowed tag list from Drupal's own filter guidelines on the node form.
 *
 * Answers the handoff's open question #4 without guessing: Drupal renders
 * "Allowed HTML tags: <a> <em> <strong> …" beneath a filtered text area, so the real
 * configuration is available on the page the import is filling.
 */
export function readAllowedTags(root: ParentNode = document): { tags: string[]; source: 'drupal-filter-tips' | 'default' } {
  const candidates = Array.from(root.querySelectorAll(
    '.filter-guidelines, .filter-help, .tips, .filter-guidelines-item, .form-item .description'
  ));

  for (const node of candidates) {
    const text = node.textContent ?? '';
    if (!/allowed html tags/i.test(text)) continue;

    const tags = [...text.matchAll(/<\s*([a-z][a-z0-9]*)\s*>/gi)].map(m => m[1].toLowerCase());
    if (tags.length) {
      return { tags: [...new Set(tags)], source: 'drupal-filter-tips' };
    }
  }

  return { tags: DEFAULT_ALLOWED, source: 'default' };
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Picks the most plausible article container. */
function findArticle(doc: Document): Element | null {
  const candidates = [
    'article',
    '[role="article"]',
    'main .content',
    '.article-body',
    '.node-content',
    'main',
    '#content',
  ];

  for (const selector of candidates) {
    const el = doc.querySelector(selector);
    // Guard against a wrapper that is really the whole page.
    if (el && norm(el.textContent).length > 200) return el;
  }

  return doc.body ?? null;
}

/**
 * Filters markup down to the allowed tag set, counting what it removed so the
 * provenance line can state it.
 */
function filterBody(
  article: Element,
  allowed: string[],
  baseUrl: string
): { html: string; stats: BodyStats } {
  // An empty list means "nothing allowed", which would silently strip every link and
  // list from the article. That is never what a caller intends, so treat it as
  // "unknown" and use the conservative default.
  const effective = allowed.length > 0 ? allowed : DEFAULT_ALLOWED;
  const allowedSet = new Set(effective.map(t => t.toLowerCase()));
  // Structural tags are always kept; the allowed list governs inline markup, and
  // stripping <p> would collapse the article into one blob.
  ['p', 'h2', 'h3', 'h4', 'br'].forEach(t => allowedSet.add(t));

  const clone = article.cloneNode(true) as Element;

  NOISE_SELECTORS.forEach(selector => {
    clone.querySelectorAll(selector).forEach(el => el.remove());
  });

  /**
   * Drop anything already proposed as its own field.
   *
   * The headline, dek, byline and date normally live INSIDE the article element, so a
   * naive body extraction ships them twice — once as Title/Subtitle/Byline/Date and
   * again as the first lines of the body. Every import would then need the same manual
   * cleanup, which defeats the point.
   *
   * These were annotated with data-d7-region before the body was read, so they can be
   * identified precisely rather than guessed at by position.
   */
  ['region-title', 'region-subtitle', 'region-byline', 'region-date'].forEach(region => {
    clone.querySelectorAll(`[data-d7-region="${region}"]`).forEach(el => el.remove());
  });

  const stats: BodyStats = {
    paragraphs: 0, headings: 0, lists: 0, linksKept: 0,
    inlineStylesRemoved: 0, embedsRemoved: 0, classesRemoved: 0, tagsStripped: [],
    unsafeUrlsRemoved: 0,
  };

  const stripped = new Set<string>();

  // Snapshot first: unwrapping mutates the tree while walking it.
  for (const el of Array.from(clone.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();

    if (el.hasAttribute('style')) stats.inlineStylesRemoved++;
    if (el.hasAttribute('class')) stats.classesRemoved++;

    if (!allowedSet.has(tag)) {
      stripped.add(tag);
      // Unwrap rather than delete: the text inside a disallowed <span> is content.
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
      continue;
    }

    const keep = KEEP_ATTRS[tag] ?? [];
    for (const attr of Array.from(el.attributes)) {
      if (!keep.includes(attr.name.toLowerCase())) el.removeAttribute(attr.name);
    }

    /**
     * Surviving URL attributes still need their scheme checked. The attribute
     * allowlist above keeps `href`, so without this a `javascript:` link from the
     * source page would ride into the node body and be saved.
     */
    const urlAttr = URL_ATTRS[tag];
    if (urlAttr) {
      const raw = el.getAttribute(urlAttr.attr);
      if (raw !== null) {
        const safe = safeUrlAttribute(raw, baseUrl, urlAttr.protocols);
        if (safe === null) {
          el.removeAttribute(urlAttr.attr);
          stats.unsafeUrlsRemoved++;
        } else if (safe !== raw) {
          el.setAttribute(urlAttr.attr, safe);
        }
      }
    }
  }

  stats.paragraphs = clone.querySelectorAll('p').length;
  stats.headings = clone.querySelectorAll('h1,h2,h3,h4,h5,h6').length;
  stats.lists = clone.querySelectorAll('ul,ol').length;
  stats.linksKept = clone.querySelectorAll('a[href]').length;
  stats.embedsRemoved = article.querySelectorAll('iframe,object,embed').length;
  stats.tagsStripped = [...stripped].sort();

  return { html: clone.innerHTML.trim(), stats };
}

/** Filenames and any dimensions the markup declared. */
function describeImage(img: HTMLImageElement, index: number, base: string): ProposedImage {
  const src = img.getAttribute('src') ?? '';
  let absolute = src;
  try { absolute = new URL(src, base).toString(); } catch { /* keep as-is */ }

  // The review renders these as <img src>, so an unsafe scheme must not survive here
  // either. A rejected src leaves the entry visible but unusable rather than silently
  // dropping an image the editor might be looking for.
  const safeSrc = safeUrlAttribute(absolute, base, URL_ATTRS.img.protocols);

  const name = absolute.split('/').pop()?.split('?')[0] || `image-${index + 1}`;
  const width = img.getAttribute('width');
  const height = img.getAttribute('height');
  const meta = width && height ? `${width}×${height}` : '';

  /**
   * Site chrome is detectable and pre-set to Skip with a reason, per the handoff.
   * Logos, sprites, icons and tracking pixels are never article content.
   */
  const chromeHints = /logo|sprite|icon|favicon|placeholder|avatar|banner|pixel|spacer/i;
  const tiny = Number(width) > 0 && Number(width) < 100;
  const isChrome = chromeHints.test(absolute) || tiny;

  if (safeSrc === null) {
    return {
      id: `img-${index}`,
      src: '',
      name,
      meta,
      role: 'skip',
      reason: 'unsupported image URL scheme',
    };
  }

  return {
    id: `img-${index}`,
    src: safeSrc,
    name,
    meta,
    role: isChrome ? 'skip' : 'teaser',
    reason: isChrome
      ? (tiny ? 'likely chrome, not content — under 100px wide' : 'likely chrome, not content')
      : null,
  };
}

/** Fields the extractor deliberately does not guess, and why. */
const UNMAPPED: Unmapped[] = [
  { label: 'Topics', reason: 'Topic terms are site-specific; guessing would tag content wrongly.' },
  { label: 'Related Content', reason: 'Requires matching real nodes on this site, which the source page cannot tell us.' },
  { label: 'Menu Placement', reason: 'Where this belongs in the menu is an editorial decision.' },
  { label: 'Groups', reason: 'Group membership is a permissions decision, not content.' },
];

export function extract(
  html: string,
  sourceUrl: string,
  allowedTags: { tags: string[]; source: 'drupal-filter-tips' | 'default' }
): ExtractionResult {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const proposals: Proposal[] = [];

  // --- Title -------------------------------------------------------------
  const h1 = doc.querySelector('h1');
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const title = norm(h1?.textContent) || norm(ogTitle) || norm(doc.title);
  if (title) {
    proposals.push({
      key: 'title',
      label: 'Title',
      value: title,
      source: h1 ? 'From the page <h1>' : ogTitle ? 'From <meta property="og:title">' : 'From <title>',
      confidence: h1 ? 'high' : 'medium',
      accepted: true,
      regionId: h1 ? 'region-title' : null,
    });
    if (h1) h1.setAttribute('data-d7-region', 'region-title');
  }

  // --- Subtitle / dek ----------------------------------------------------
  const dek = doc.querySelector('.dek, .subtitle, .standfirst, .article-dek, h1 + h2, h1 + p.lead');
  const dekText = norm(dek?.textContent);
  if (dekText && dekText !== title) {
    proposals.push({
      key: 'subtitle',
      label: 'Subtitle',
      value: dekText,
      source: 'From .article-dek, directly under the headline',
      confidence: 'medium',
      accepted: true,
      regionId: 'region-subtitle',
    });
    dek?.setAttribute('data-d7-region', 'region-subtitle');
  }

  // --- Summary -----------------------------------------------------------
  const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content');
  const ogDesc = doc.querySelector('meta[property="og:description"]')?.getAttribute('content');
  const summary = norm(metaDesc) || norm(ogDesc);
  if (summary) {
    proposals.push({
      key: 'summary',
      label: 'Summary',
      value: summary,
      source: metaDesc ? 'From <meta name="description">' : 'From <meta property="og:description">',
      confidence: 'high',
      accepted: true,
      regionId: null,
    });
  }

  // --- Byline ------------------------------------------------------------
  const bylineEl = doc.querySelector('.byline, [rel="author"], .author, [itemprop="author"]');
  const byline = norm(bylineEl?.textContent).replace(/^by\s+/i, '');
  if (byline) {
    proposals.push({
      key: 'byline',
      label: 'Byline',
      value: byline,
      // Low confidence by design: a byline with no matching author node on this site
      // cannot be verified, so it defaults to skipped.
      source: 'From .byline — no matching author exists on this site yet',
      confidence: 'low',
      accepted: false,
      regionId: 'region-byline',
    });
    bylineEl?.setAttribute('data-d7-region', 'region-byline');
  }

  // --- Display date ------------------------------------------------------
  const timeEl = doc.querySelector('time[datetime]');
  const dateValue = timeEl?.getAttribute('datetime') ?? '';
  if (dateValue) {
    proposals.push({
      key: 'date',
      label: 'Display Date',
      value: dateValue,
      source: 'From <time datetime>',
      confidence: 'high',
      accepted: true,
      regionId: 'region-date',
    });
    timeEl?.setAttribute('data-d7-region', 'region-date');
  }

  // --- Body --------------------------------------------------------------
  const article = findArticle(doc);
  let bodyStats: BodyStats = {
    paragraphs: 0, headings: 0, lists: 0, linksKept: 0,
    inlineStylesRemoved: 0, embedsRemoved: 0, classesRemoved: 0, tagsStripped: [],
    unsafeUrlsRemoved: 0,
  };

  if (article) {
    article.setAttribute('data-d7-region', 'region-body');
    const filtered = filterBody(article, allowedTags.tags, sourceUrl);
    bodyStats = filtered.stats;

    if (filtered.html) {
      const parts = [
        `${bodyStats.paragraphs} paragraphs`,
        `${bodyStats.headings} headings`,
        `${bodyStats.lists} list${bodyStats.lists === 1 ? '' : 's'}`,
        `${bodyStats.linksKept} links kept`,
      ];
      const removed = [
        bodyStats.inlineStylesRemoved ? `${bodyStats.inlineStylesRemoved} inline styles` : null,
        bodyStats.embedsRemoved ? `${bodyStats.embedsRemoved} embeds` : null,
        bodyStats.classesRemoved ? `${bodyStats.classesRemoved} classes` : null,
        bodyStats.unsafeUrlsRemoved
          ? `${bodyStats.unsafeUrlsRemoved} unsafe link${bodyStats.unsafeUrlsRemoved === 1 ? '' : 's'}`
          : null,
      ].filter(Boolean);

      proposals.push({
        key: 'body',
        label: 'Body',
        value: filtered.html,
        source: `From <${article.tagName.toLowerCase()}> — ${parts.join(', ')}`
          + (removed.length ? `; ${removed.join(', ')} removed` : '')
          + (bodyStats.tagsStripped.length ? `; stripped <${bodyStats.tagsStripped.join('> <')}>` : ''),
        confidence: 'high',
        accepted: true,
        regionId: 'region-body',
      });
    }
  }

  // --- Images ------------------------------------------------------------
  const images = Array.from(doc.querySelectorAll('img'))
    .map((img, i) => describeImage(img as HTMLImageElement, i, sourceUrl));

  // --- Annotated source for the review pane ------------------------------
  // The design specifies a live iframe of the source. That does not work: most sites
  // send X-Frame-Options or a restrictive frame-ancestors CSP and refuse to render,
  // and even when framing succeeds, outlining a region requires reading into a
  // cross-origin document, which is blocked. Rendering our own sanitized copy in a
  // sandboxed iframe both always works and makes region outlining possible, because
  // the regions were annotated above.
  const shell = doc.body?.cloneNode(true) as HTMLElement | undefined;
  if (shell) {
    shell.querySelectorAll('script, style, noscript, iframe, object, embed, link').forEach(el => el.remove());
  }

  return {
    sourceUrl,
    proposals,
    images,
    unmapped: UNMAPPED,
    bodyStats,
    annotatedHtml: shell?.innerHTML ?? '',
    allowedTags,
  };
}

/** "Fetched · 7 of 11 fields matched" — the count the sticky bar shows. */
export function matchSummary(result: ExtractionResult): { matched: number; total: number } {
  const total = result.proposals.length + result.unmapped.length;
  return { matched: result.proposals.length, total };
}

/** How many fields the primary button will apply. */
export function acceptedCount(proposals: Proposal[]): number {
  return proposals.filter(p => p.accepted).length;
}
