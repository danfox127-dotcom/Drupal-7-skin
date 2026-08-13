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
/**
 * How many rows in this table link to a node.
 *
 * Counts aliased links too, which is the difference between working and not working on a
 * site with Pathauto — i.e. nearly all of them. A view's title column renders through
 * `l()`, so on demo-dean every row linked to `/events/some-title` and NOT ONE href
 * contained `/node/`; this returned 0 for a 51-row content list and every caller that
 * depended on it fell through to the wrong table.
 *
 * The operations column is the reliable part: `node/N/edit` and `node/N/delete` are never
 * aliased, because Pathauto aliases the node path itself and not its subpaths. Any anchor
 * whose href looks like a content destination is counted as a weaker signal.
 */
function nodeLinkCount(table: HTMLTableElement): number {
  const anchors = Array.from(table.querySelectorAll<HTMLAnchorElement>('tbody a[href]'));

  const nodePaths = anchors.filter(a => /\/node\/\d+/.test(a.getAttribute('href') ?? '')).length;
  if (nodePaths > 0) return nodePaths;

  // Aliased listing: count rows that link somewhere site-local at all.
  return anchors.filter(a => {
    const href = a.getAttribute('href') ?? '';
    return href.startsWith('/') && !href.startsWith('//') && href.length > 1;
  }).length;
}

/** Rows that are furniture rather than content. */
function contentRowCount(table: HTMLTableElement): number {
  return Array.from(table.querySelectorAll('tbody tr')).filter(isContentRow).length;
}

/**
 * Drupal's tableheader.js clones the content table to make a floating header, and inserts
 * `<table class="sticky-header">` BEFORE the real one. The clone carries the same headers
 * and an empty tbody, so every header-based heuristic matches it first and then finds
 * nothing to parse. It is never the table we want.
 */
function isStickyHeaderClone(table: HTMLTableElement): boolean {
  return table.classList.contains('sticky-header');
}

export function findContentTable(root: ParentNode = document): HTMLTableElement | null {
  const byId = root.querySelector<HTMLTableElement>('#node-admin-content table, table#node-admin-content');
  if (byId && !isStickyHeaderClone(byId)) return byId;

  const tables = Array.from(root.querySelectorAll<HTMLTableElement>('table'))
    .filter(table => !isStickyHeaderClone(table));

  /**
   * A Title header alone is not enough to identify the table.
   *
   * `name` is one of the title aliases, so an exposed-filter or admin block with a "Name"
   * column matched first and the parser then took over the wrong table. A candidate must
   * also actually link to nodes; among those, the one with the most links wins.
   */
  const byHeader = tables.filter(table => {
    const headers = Array.from(table.querySelectorAll('thead th')).map(th => norm(th.textContent).toLowerCase());
    return headers.some(h => COLUMN_ALIASES.title.includes(h) || h.startsWith('title'));
  });

  const headerWithLinks = byHeader
    .filter(table => nodeLinkCount(table) > 0)
    .sort((a, b) => nodeLinkCount(b) - nodeLinkCount(a));
  if (headerWithLinks.length) return headerWithLinks[0];

  /**
   * Fallback that does not depend on header labels at all.
   *
   * /admin/content is frequently a View rather than core's node_admin_content, and a view
   * can rename or omit its headers entirely. But any content listing links to nodes, so
   * the table with the most `/node/N` links in its body is the content table.
   */
  const scored = tables
    .map(table => ({ table, links: nodeLinkCount(table) }))
    .filter(entry => entry.links > 0)
    .sort((a, b) => b.links - a.links);

  if (scored.length) return scored[0].table;

  /**
   * Last resort: among tables with a Title header, take the one with the most CONTENT rows.
   *
   * Taking `byHeader[0]` was wrong whenever more than one table carried a Title header,
   * because it silently preferred DOM order over having any data — which is exactly how
   * the empty sticky-header clone got chosen over a 51-row listing.
   */
  const byRows = byHeader
    .map(table => ({ table, rows: contentRowCount(table) }))
    .sort((a, b) => b.rows - a.rows);

  return byRows[0]?.table ?? null;
}

/**
 * Infers which column holds the title, when the headers did not say.
 *
 * Picks the cell index that most often contains a link to a node. Views commonly also tag
 * it `views-field-title`, which is checked first as a cheaper, stronger hint.
 */
export function inferTitleColumn(bodyRows: Element[]): number | null {
  const tagged = bodyRows[0]?.querySelector('td.views-field-title, td.views-field-title-field');
  if (tagged) {
    const index = Array.from(bodyRows[0].querySelectorAll('td')).indexOf(tagged as HTMLTableCellElement);
    if (index !== -1) return index;
  }

  const counts = new Map<number, number>();
  for (const row of bodyRows) {
    const cells = Array.from(row.querySelectorAll('td'));
    cells.forEach((cell, index) => {
      if (cell.querySelector('a[href*="/node/"]')) {
        counts.set(index, (counts.get(index) ?? 0) + 1);
      }
    });
  }

  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Whether a `<tr>` holds content rather than table furniture.
 *
 * Views Bulk Operations prepends a full-width control row — on demo-dean it reads
 * "Selected 50 rows in this page. [Select all 11760 rows in this view.]" as a single
 * `<td colspan="16">`. It sits in the tbody and parses as a row whose title is that
 * sentence, so the listing opened with one nonsense entry.
 *
 * The colspan test also covers Drupal's "No content available." placeholder and the
 * pager row, without needing to know each module's class names.
 */
function isContentRow(tr: Element): boolean {
  if (tr.classList.contains('views-table-row-select-all')) return false;

  const cells = Array.from(tr.querySelectorAll('td'));
  if (cells.length === 0) return false;

  // A single cell spanning the table is a message or control strip, not a record.
  if (cells.length === 1) {
    const span = Number(cells[0].getAttribute('colspan') ?? '1');
    if (span > 1) return false;
  }

  return true;
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

  const bodyRows = Array.from(table.querySelectorAll('tbody tr')).filter(isContentRow);

  // Headers did not resolve a title column — infer it from the data instead of giving up.
  if (columns.title === undefined) {
    const inferred = inferTitleColumn(bodyRows);
    if (inferred === null) return null;
    columns.title = inferred;
  }

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


/**
 * Human-readable account of what the parser saw and why it did or did not take over.
 *
 * The previous diagnostic logged an object, which Chrome's extension error page renders as
 * "[object Object]" — useless in the one place someone would go looking. This returns a
 * string so it survives whatever renders it.
 */
export function diagnoseContentList(root: ParentNode = document): string {
  const tables = Array.from(root.querySelectorAll<HTMLTableElement>('table'));
  const lines: string[] = [`${tables.length} table(s) on the page`];

  tables.forEach((table, index) => {
    const headers = Array.from(table.querySelectorAll('thead th')).map(th => norm(th.textContent));
    const bodyRows = table.querySelectorAll('tbody tr').length;
    const links = table.querySelectorAll('tbody a[href*="/node/"]').length;
    lines.push(
      `  [${index}] id="${table.id || '-'}" class="${table.className || '-'}" ` +
      `rows=${bodyRows} nodeLinks=${links}`
    );
    lines.push(`       headers: ${headers.length ? headers.join(' | ') : '(none)'}`);
  });

  const chosen = findContentTable(root);
  if (!chosen) {
    lines.push('chose: none — no table had a Title header or any /node/N links');
    return lines.join('\n');
  }

  lines.push(`chose: id="${chosen.id || '-'}" class="${chosen.className || '-'}"`);

  const headerCells = Array.from(chosen.querySelectorAll('thead th')).map(th => th.textContent ?? '');
  const columns = mapColumns(headerCells);
  lines.push(`mapped columns: ${JSON.stringify(columns)}`);

  if (columns.title === undefined) {
    const inferred = inferTitleColumn(Array.from(chosen.querySelectorAll('tbody tr')));
    lines.push(`title column inferred from node links: ${inferred ?? 'FAILED'}`);
  }

  const rows = parseContentList(root);
  lines.push(`rows parsed: ${rows === null ? 'null (gave up)' : rows.length}`);
  if (rows && rows.length) {
    lines.push(`first row: ${JSON.stringify(rows[0])}`);
  }

  return lines.join('\n');
}
