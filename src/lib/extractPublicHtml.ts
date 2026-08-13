/**
 * Fetches a node's public-facing page and returns its sanitized main content.
 *
 * Extracted from HtmlExport so the command palette can run the same operation —
 * two implementations of "copy the public HTML" would drift. The content list's
 * per-row Copy HTML button (Phase 3) reuses this too.
 *
 * Same-origin only: it fetches `/node/{nid}` on the current host, which the page
 * is already allowed to read. Cross-origin fetching (the import flow) is a
 * different problem and belongs in a background service worker.
 */

/** Wrappers Drupal 7 themes commonly use for the main content region. */
const CONTENT_SELECTORS = ['article', '#content', '.region-content', 'main'];

/** Chrome and scripting that should never end up in exported markup. */
const NOISE_SELECTORS = [
  'script', 'style', 'header', 'footer', 'nav',
  '.admin-tabs', '.contextual-links-wrapper',
  '#skip-link', '.breadcrumb',
];

/** Drupal-internal attributes that are meaningless outside the CMS. */
const NOISE_ATTRIBUTES = ['data-drupal-selector', 'data-contextual-id'];

/** Reads the node id out of a Drupal path such as `/node/123/edit`. */
export function nodeIdFromPath(pathname: string): string | null {
  const match = pathname.match(/\/node\/(\d+)/);
  return match ? match[1] : null;
}

/** True when the current location is a node page the export can run against. */
export function canExportHere(location: Location = window.location): boolean {
  return nodeIdFromPath(location.pathname) !== null;
}

export async function extractPublicHtml(location: Location = window.location): Promise<string> {
  const nodeId = nodeIdFromPath(location.pathname);
  if (!nodeId) throw new Error('Could not determine Node ID from URL');

  // /node/{id} directly, to bypass the admin theme.
  const publicUrl = `${location.origin}/node/${nodeId}`;
  const response = await fetch(publicUrl);
  if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

  const doc = new DOMParser().parseFromString(await response.text(), 'text/html');

  let mainContent: Element | null = null;
  for (const selector of CONTENT_SELECTORS) {
    mainContent = doc.querySelector(selector);
    if (mainContent) break;
  }

  if (!mainContent) {
    throw new Error('Could not locate main content wrapper (<article> or #content) in the fetched page.');
  }

  NOISE_SELECTORS.forEach(selector => {
    mainContent!.querySelectorAll(selector).forEach(el => el.remove());
  });

  mainContent.querySelectorAll('*').forEach(el => {
    NOISE_ATTRIBUTES.forEach(attr => el.removeAttribute(attr));
  });

  return mainContent.innerHTML.trim();
}

/** Fetch, sanitize, and put the result on the clipboard. */
export async function copyPublicHtml(location: Location = window.location): Promise<void> {
  const html = await extractPublicHtml(location);
  await navigator.clipboard.writeText(html);
}
