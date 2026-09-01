/**
 * A searchable index of an entire Drupal menu, built without loading the menu.
 *
 * The problem this solves: columbiadoctors.org runs BigMenu, so the menu overview page
 * renders 9 rows out of 3,000+ and fetches each subtree on demand. A filter over the 9
 * visible rows is useless, and expanding everything to make it work means thousands of
 * requests — which is what BigMenu exists to prevent.
 *
 * The way out is that Drupal builds its "Parent link" select from the FULL menu tree,
 * whatever BigMenu does to the overview table. One page — the menu's own add-link form —
 * therefore carries every item in the menu, as `<option value="menu-name:mlid">` with the
 * depth encoded as leading hyphens in the label. That is the whole index in a single
 * request, and it is the same data Drupal would show if it rendered the table in full.
 */

export interface MenuIndexItem {
  mlid: string;
  title: string;
  depth: number;
  /** Ancestor titles, outermost first. Empty for a top-level item. */
  ancestors: string[];
}

export interface MenuIndex {
  menuName: string;
  items: MenuIndexItem[];
  /** Epoch ms, so the UI can say how stale the index is. */
  fetchedAt: number;
}

/** `main-menu:1234` — Drupal's parent-select option value. */
const OPTION_VALUE = /^([a-z0-9_-]+):(\d+)$/i;

/**
 * Reads every menu item out of a parent-link select.
 *
 * Deliberately not anchored to a select NAME. Drupal 7 calls it `menu[parent]` on a node
 * form and `parent` on the menu link form, and contrib themes have been seen to rename it;
 * the option VALUES are the reliable signal, since `main-menu:1234` is a shape nothing else
 * on these pages uses.
 */
export function parseMenuIndex(root: ParentNode, menuName?: string): MenuIndexItem[] {
  const selects = Array.from(root.querySelectorAll('select'));

  let best: MenuIndexItem[] = [];
  for (const select of selects) {
    const options = Array.from(select.querySelectorAll('option'));
    const items: MenuIndexItem[] = [];

    for (const option of options) {
      const match = OPTION_VALUE.exec((option.getAttribute('value') ?? '').trim());
      if (!match) continue;
      if (menuName && match[1].toLowerCase() !== menuName.toLowerCase()) continue;

      // Drupal encodes depth as leading hyphens on the label: "--Cardiology".
      const raw = (option.textContent ?? '').replace(/\s+/g, ' ').trim();
      const hyphens = /^(-+)\s*(.*)$/.exec(raw);

      items.push({
        mlid: match[2],
        title: hyphens ? hyphens[2].trim() : raw,
        depth: hyphens ? hyphens[1].length : 0,
        ancestors: [],
      });
    }

    // A page can carry more than one such select — the node form has one per menu. The
    // longest list is the menu being looked at.
    if (items.length > best.length) best = items;
  }

  /**
   * If naming the menu excluded everything, index what is there anyway.
   *
   * The URL segment IS the machine name in stock Drupal, so this should not happen — but
   * the failure it prevents is the whole feature silently reporting "nothing to search"
   * while a perfectly good parent list sits on the page, which is exactly what a fixture
   * with a mismatched prefix produced. Falling back to unfiltered is safe on this page:
   * the add-link form's parent select covers one menu.
   */
  if (best.length === 0 && menuName) return parseMenuIndex(root);

  /**
   * `<menu>:0` is "the menu itself", offered as a parent so an item can sit at the top
   * level. It is not a menu item and must not appear in search results.
   */
  return withAncestors(best.filter(item => item.mlid !== '0'));
}

/**
 * Fills in each item's ancestor titles from the depth sequence.
 *
 * The select is in tree order, so an item's parent is the nearest preceding entry one level
 * shallower. That is the only place the hierarchy is recorded — the option values carry no
 * parent id — and it is what lets a search result say "Specialties › Cardiology › …"
 * instead of a bare title that could be one of six.
 */
export function withAncestors(items: MenuIndexItem[]): MenuIndexItem[] {
  const trail: string[] = [];

  return items.map(item => {
    trail.length = item.depth;
    const ancestors = trail.slice(0, item.depth).filter(t => t !== undefined);
    trail[item.depth] = item.title;
    return { ...item, ancestors };
  });
}

/**
 * Matches on title and ancestor path, so "cardiology surgery" finds a child of Cardiology
 * whose own title is Surgery. Every term must appear somewhere in the item's full path.
 */
export function searchMenuIndex(
  items: MenuIndexItem[],
  query: string,
  limit = 50
): MenuIndexItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const hits: MenuIndexItem[] = [];
  for (const item of items) {
    const haystack = [...item.ancestors, item.title].join(' ').toLowerCase();
    if (terms.every(term => haystack.includes(term))) {
      hits.push(item);
      // Capped rather than rendering 3,000 rows: a query matching everything must not
      // freeze the page. The count reported to the user is the true total, not this.
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/** True count of matches, for saying "showing 50 of 214". */
export function countMenuMatches(items: MenuIndexItem[], query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;

  return items.filter(item => {
    const haystack = [...item.ancestors, item.title].join(' ').toLowerCase();
    return terms.every(term => haystack.includes(term));
  }).length;
}

/** Drupal's edit page for one menu link. */
export const menuItemEditUrl = (mlid: string): string =>
  `/admin/structure/menu/item/${mlid}/edit`;

/**
 * The page whose parent-select carries the whole menu.
 *
 * The menu's own add-link form, rather than a node form: it is guaranteed to exist for any
 * menu being looked at, needs no guess about which content types the site has, and is
 * already inside the section the user is in.
 */
export const menuIndexSourceUrl = (menuName: string): string =>
  `/admin/structure/menu/manage/${menuName}/add`;
