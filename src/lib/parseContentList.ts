/**
 * Parses Drupal 7's /admin/content table into rows the modern list can render.
 *
 * IMPORTANT: built against Drupal 7 core's `node_admin_nodes` markup, not against
 * a captured copy of the live page — that DOM is still outstanding from Phase 0.
 * It is therefore written to degrade rather than break:
 *
 *   - Columns are located by their header label, not a fixed index, so a site that
 *     adds, removes, or reorders columns still parses.
 *   - Every field is optional. A row missing its type or date still renders with
 *     what was found.
 *   - `parseContentList` returns null when it cannot find a plausible table, and
 *     the caller leaves Drupal's own table in place. Failing to a working legacy
 *     page beats replacing it with an empty one.
 */

export interface ContentRow {
  /** Node id, or null for a row whose title link is a path alias. */
  nodeId: string | null;
  title: string;
  /** Absolute or root-relative href from the title link. */
  href: string;
  type: string;
  author: string;
  /** Raw status text as Drupal rendered it, e.g. "published". */
  status: string;
  /** Raw updated text as Drupal rendered it. Not re-parsed into a Date: D7's
   *  format is site-configurable and misparsing it would silently mis-sort. */
  updated: string;
}

/** Status buckets the UI colors differently. */
export type StatusKind = 'published' | 'draft' | 'review' | 'unknown';

/**
 * Maps Drupal's status text onto a bucket.
 *
 * Core only emits published / not published. "Needs review" and "Draft" come from
 * moderation modules, so this matches on keywords rather than an exact set — an
 * unrecognized state falls through to `unknown` and renders uncolored instead of
 * being mislabeled.
 */
export function statusKind(status: string): StatusKind {
  const s = status.trim().toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('review')) return 'review';
  if (s.includes('not published') || s.includes('unpublished') || s.includes('draft')) return 'draft';
  if (s.includes('published')) return 'published';
  return 'unknown';
}

/** Human label for a bucket, falling back to whatever Drupal said. */
export function statusLabel(status: string): string {
  switch (statusKind(status)) {
    case 'published': return 'Published';
    case 'draft': return 'Draft';
    case 'review': return 'Needs review';
    default: return status.trim() || '—';
  }
}

const norm = (s: string | null | undefined) =>
  (s ?? '').replace(/\s+/g, ' ').trim();

/** Header aliases, so a renamed column still resolves. */
const COLUMN_ALIASES: Record<string, string[]> = {
  title: ['title', 'name'],
  type: ['content type', 'type'],
  author: ['author', 'submitted by', 'user'],
  status: ['status', 'published', 'state', 'moderation state'],
  updated: ['updated', 'last updated', 'changed', 'post date', 'date'],
};

/**
 * Builds label → column index from the header row.
 *
 * Sortable D7 headers wrap their label in an <a>, so textContent is read rather
 * than looking for a text node.
 */
export function mapColumns(headerCells: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  const normalized = headerCells.map(h => norm(h).toLowerCase());

  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    // Exact match first; fall back to a prefix match for headers carrying extra
    // markup such as a sort-direction indicator.
    let index = normalized.findIndex(h => aliases.includes(h));
    if (index === -1) {
      index = normalized.findIndex(h => aliases.some(a => h.startsWith(a)));
    }
    if (index !== -1) map[key] = index;
  }

  return map;
}

/** Reads the node id from an href, tolerating query strings and aliases. */
export function nodeIdFromHref(href: string): string | null {
  const match = href.match(/\/node\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Finds the content table. Prefers an explicit id, then any table whose header
 * contains a Title column — avoids grabbing an unrelated table such as the
 * exposed-filter form.
 */
export function findContentTable(root: ParentNode = document): HTMLTableElement | null {
  const byId = root.querySelector<HTMLTableElement>('#node-admin-content table, table#node-admin-content');
  if (byId) return byId;

  const tables = Array.from(root.querySelectorAll<HTMLTableElement>('table'));
  return tables.find(table => {
    const headers = Array.from(table.querySelectorAll('thead th')).map(th => norm(th.textContent).toLowerCase());
    return headers.some(h => COLUMN_ALIASES.title.includes(h) || h.startsWith('title'));
  }) ?? null;
}

/**
 * Returns parsed rows, or null when the page does not look like a content list —
 * in which case the caller must leave Drupal's table alone.
 */
export function parseContentList(root: ParentNode = document): ContentRow[] | null {
  const table = findContentTable(root);
  if (!table) return null;

  const headerCells = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent ?? '');
  const columns = mapColumns(headerCells);

  // Without a title column there is nothing worth rendering.
  if (columns.title === undefined) return null;

  const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
  const rows: ContentRow[] = [];

  for (const tr of bodyRows) {
    const cells = Array.from(tr.querySelectorAll('td'));
    if (cells.length === 0) continue;

    const titleCell = cells[columns.title];
    if (!titleCell) continue;

    const link = titleCell.querySelector('a');
    const title = norm(link?.textContent ?? titleCell.textContent);

    // A row with no title is Drupal's "no content available" placeholder.
    if (!title) continue;

    const href = link?.getAttribute('href') ?? '';

    const at = (key: string) =>
      columns[key] !== undefined ? norm(cells[columns[key]]?.textContent) : '';

    rows.push({
      nodeId: nodeIdFromHref(href),
      title,
      href,
      type: at('type'),
      author: at('author'),
      status: at('status'),
      updated: at('updated'),
    });
  }

  return rows;
}

/**
 * Best-effort read of the logged-in username from Drupal 7's admin toolbar.
 *
 * Used only to offer the "My recent edits" saved view; when it cannot be
 * determined the caller hides that chip rather than showing one that filters to
 * nothing.
 */
export function currentUsername(root: ParentNode = document): string | null {
  const candidates = [
    '#toolbar-user a[href^="/user/"]',
    '.toolbar-user a[href^="/user/"]',
    '#toolbar a.toolbar-user-link',
    '#admin-menu-account a[href^="/user/"]',
  ];

  for (const selector of candidates) {
    const el = root.querySelector(selector);
    const name = norm(el?.textContent);
    if (name) return name;
  }

  return null;
}
