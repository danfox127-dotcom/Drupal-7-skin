/**
 * What the Varys panel and the worker say to each other about a page's broken links.
 *
 * The panel (a content script) cannot reach Varys: the key lives in the worker, and so does the
 * check that the page's site is one Varys tracks. It sends the worker `VarysBrokenLinksRequest`
 * and gets a `BrokenLinksAnswer` back. The answer is Varys's own, from
 * GET /api/extension/broken-links: the page's confirmed broken and moved links, broken first.
 */

/** One dead or moved address this page links to, as the panel reads it. */
export type BrokenLink = {
  /** The address Varys checked: absolute, and what it reports as dead. */
  url: string;
  /** The link's href as the page has it, which may be relative ("/our-faculty"). */
  href: string;
  /** The link's words. */
  text: string;
  /** True in the page's own text, false in a menu or footer, null when the crawl did not say. */
  inBody: boolean | null;
  /** On so many of the site's pages that it comes from a template, not this page's text. */
  sitewide: boolean;
  state: 'broken' | 'moved';
  /** Varys's reason code (`not_found`, `home_redirect`...); the panel words it. */
  reason: string | null;
  /** ISO time Varys first saw it fail; null when it has none. */
  since: string | null;
  /** For a mistyped address on the site's own host, what it probably meant. */
  suggestion: string | null;
};

/**
 * `not_tracked`: a site Varys does not track. `unchecked`: Varys has not checked this page's
 * links yet, which is never "none broken". `error`: no answer to show, for any reason (not
 * connected, an expired key, unreachable, or a shape this version does not know). The panel
 * shows the section only for `ok`.
 */
export type BrokenLinksAnswer =
  | { kind: 'not_tracked' }
  | { kind: 'unchecked' }
  | { kind: 'ok'; links: BrokenLink[] }
  | { kind: 'error' };

/** Asks Varys for a page's broken links. */
export interface VarysBrokenLinksRequest {
  type: 'varysBrokenLinks';
  /** Absolute public address of the page being edited. Never the edit form's. */
  pageUrl: string;
}

/**
 * Show me: select the first of the body's links to `url`, scroll to it, and outline every one
 * for a few seconds. `pageUrl` is the page's public address, which relative hrefs resolve
 * against, as they did for Varys's crawler.
 */
export interface ShowRichEditorLinkRequest {
  type: 'showRichEditorLink';
  elementId: string;
  url: string;
  pageUrl: string;
}

/**
 * 'not-found': no link in the body goes there (it comes from a listing or block). 'no-editor':
 * no CKEditor 4 instance has that id, or it is showing its source rather than the page.
 */
export interface ShowRichEditorLinkResponse {
  result: 'shown' | 'not-found' | 'no-editor' | 'error';
}

/** Remove link: unwrap every link in the body to `url`, keeping its words. Never saves. */
export interface UnlinkRichEditorLinkRequest {
  type: 'unlinkRichEditorLink';
  elementId: string;
  url: string;
  pageUrl: string;
}

/** `before` and `after` are the editor's data either side of the removal, which Undo needs; null unless removed. */
export interface UnlinkRichEditorLinkResponse {
  result: 'removed' | 'not-found' | 'no-editor' | 'error';
  count: number;
  before: string | null;
  after: string | null;
}

/** Undo: put `html` back, only while the body still holds `expected` (what the removal left). */
export interface RestoreRichEditorHtmlRequest {
  type: 'restoreRichEditorHtml';
  elementId: string;
  html: string;
  expected: string;
}

/** 'changed': the body is no longer what the removal left (the person has typed), so nothing was put back. */
export interface RestoreRichEditorHtmlResponse {
  result: 'restored' | 'changed' | 'no-editor' | 'error';
}

const isText = (v: unknown): v is string => typeof v === 'string';
const isTextOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function parseLink(v: unknown): BrokenLink | null {
  if (typeof v !== 'object' || v === null) return null;
  const l = v as Record<string, unknown>;
  if (!isText(l.url) || l.url === '' || !isText(l.href) || !isText(l.text)) return null;
  if (!(l.in_body === null || typeof l.in_body === 'boolean') || typeof l.sitewide !== 'boolean') return null;
  if (l.state !== 'broken' && l.state !== 'moved') return null;
  if (!isTextOrNull(l.reason) || !isTextOrNull(l.since) || !isTextOrNull(l.suggestion)) return null;
  return {
    url: l.url, href: l.href, text: l.text, inBody: l.in_body, sitewide: l.sitewide, state: l.state,
    reason: l.reason, since: l.since, suggestion: l.suggestion,
  };
}

/**
 * Varys's answer in the panel's terms. Anything that is not a shape Varys documents is `error`,
 * and so is an `ok` with any malformed link: the panel reads these fields without looking again.
 * `checked: false` is `unchecked` whatever else came with it.
 */
export function parseBrokenLinksAnswer(json: unknown): BrokenLinksAnswer {
  if (typeof json !== 'object' || json === null) return { kind: 'error' };
  const a = json as Record<string, unknown>;
  if (a.status === 'not_tracked') return { kind: 'not_tracked' };
  if (a.status !== 'ok' || typeof a.checked !== 'boolean' || !Array.isArray(a.links)) return { kind: 'error' };
  if (!a.checked) return { kind: 'unchecked' };
  const links: BrokenLink[] = [];
  for (const raw of a.links) {
    const link = parseLink(raw);
    if (!link) return { kind: 'error' };
    links.push(link);
  }
  return { kind: 'ok', links };
}
