/**
 * The public address of the page an edit form belongs to, when the form does not show it.
 *
 * Varys knows a page by the address it crawled, which is the page's alias. The edit form
 * shows that address in its View tab (`publicUrlFor` in src/content/varysCapture.ts), but a
 * theme whose tabs that does not find leaves only /node/N, which Varys never crawled: every
 * question about the page would be answered "Varys hasn't read this page yet", and a title
 * fill could not keep the page's address. Drupal serves /node/N for every node, so the page
 * itself is read, on the site the person is already signed in to, and its canonical link (or
 * failing that its og:url) says where it lives. Nothing read here goes to Varys except that
 * address, which is what would have gone anyway (ruling R17).
 */

import { bareHost } from './pageState';

const NODE_PAGE = /^\/node\/\d+\/?$/;

/**
 * Paths that cannot be a node's own address: /node/N and its sub-pages, the front page (a
 * site whose canonical points everything home would otherwise put the home page's
 * suggestions on every form), the login pages (where a lapsed session lands) and admin.
 */
const NOT_THIS_PAGE = /^\/node\/\d+(?:\/|$)|^\/$|^\/user(?:\/|$)|^\/admin(?:\/|$)/;

/** Fetches a page of the site and answers its HTML, or null when there is none to read. */
export type PageFetcher = (url: string) => Promise<string | null>;

/** True for a page address that is /node/N: the address of a node with no alias, or of one the form could not name. */
export function isNodeAddress(address: string): boolean {
  try {
    return NODE_PAGE.test(new URL(address).pathname);
  } catch {
    return false;
  }
}

/**
 * The address a page states for itself: its canonical link, then its og:url. Only a page of
 * the same site (the www twin counts) and never one of NOT_THIS_PAGE. It is answered on the
 * host the form is on, path only: the query and fragment are not part of a page's address.
 */
export function statedAddress(doc: Document, pageUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return null;
  }

  const stated = [
    doc.querySelector('link[rel~="canonical" i]')?.getAttribute('href'),
    doc.querySelector('meta[property="og:url" i]')?.getAttribute('content'),
  ];
  for (const raw of stated) {
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw.trim(), base);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (bareHost(url.host) !== bareHost(base.host)) continue;
    if (NOT_THIS_PAGE.test(url.pathname)) continue;
    return base.origin + url.pathname;
  }
  return null;
}

/**
 * The page's public address: `address` itself unless it is /node/N, in which case the page is
 * fetched and asked (see statedAddress). Whatever goes wrong, `address` is the answer, so
 * nothing is worse than without this.
 */
export async function resolvePublicAddress(address: string, fetchPage: PageFetcher): Promise<string> {
  if (!isNodeAddress(address)) return address;
  let html: string | null;
  try {
    html = await fetchPage(address);
  } catch {
    return address;
  }
  if (!html) return address;
  // Parsed inert: the page's scripts do not run and its markup never touches this one.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return statedAddress(doc, address) ?? address;
}

/**
 * The site's own page, as this signed-in browser sees it: a same-origin GET, with the site's
 * cookies so an unpublished page can be read too, and given up after `timeoutMs`. Null for
 * another origin, an error status, something that is not HTML, or no answer.
 *
 * It never leaves the site, redirects included (ruling R19). `mode: 'same-origin'` makes the
 * browser refuse a redirect to any other origin before sending anything there (measured
 * against real servers: the other one is never hit; see varys-public-address.spec.ts), while
 * a redirect on the same site, as Global Redirect sends /node/N to its alias, is still
 * followed. `redirect: 'manual'` would refuse both, losing the second for nothing.
 */
export async function fetchSitePage(url: string, timeoutMs = 5_000): Promise<string | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.origin !== window.location.origin) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target.toString(), {
      credentials: 'same-origin', mode: 'same-origin', redirect: 'follow', signal: controller.signal,
    });
    if (!response.ok) return null;
    // Belt and braces: same-origin mode already refuses any other origin.
    if (response.url && new URL(response.url).origin !== window.location.origin) return null;
    const type = response.headers.get('content-type') ?? '';
    if (type && !/text\/html|application\/xhtml/i.test(type)) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
