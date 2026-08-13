/**
 * Ancestor-retaining filter for depth-encoded flat trees.
 *
 * Drupal renders menu hierarchies as a flat row list where nesting is carried by
 * a depth number, not by containment. Filtering such a list naively drops parents
 * whose labels do not match, which detaches children from their context — you see
 * "Dean's Message" with no indication it lives under Annual Report.
 *
 * So a match pulls its ancestor chain along with it. Used by both the menu manager
 * (Phase 3) and the menu-parent picker in the node editor's rail (Phase 5); the
 * two must behave identically, hence one implementation.
 */

export interface DepthNode {
  depth: number;
}

/** Indices of the ancestor chain of `index`, nearest parent first. */
export function ancestorIndices<T extends DepthNode>(items: T[], index: number): number[] {
  const chain: number[] = [];
  let wanted = items[index]?.depth ?? 0;

  // Walk backwards; the first row at each shallower depth is that level's parent.
  for (let i = index - 1; i >= 0 && wanted > 0; i--) {
    if (items[i].depth === wanted - 1) {
      chain.push(i);
      wanted = items[i].depth;
    }
  }

  return chain;
}

export interface FilterResult<T> {
  /** Matches plus retained ancestors, in original order. */
  items: T[];
  /** How many items matched the query directly, excluding retained ancestors. */
  matchCount: number;
  /**
   * Identity set of the direct matches, so the UI can distinguish a hit from a
   * parent that is only present to preserve hierarchy.
   */
  isMatch: (item: T) => boolean;
}

/**
 * Case-insensitive substring filter — the uniform search behavior the handoff
 * specifies for every filter in the product, applied on keystroke with no Apply
 * step.
 *
 * An empty query returns everything and reports every item as a match, so callers
 * do not need a special case.
 */
export function filterTreeRetainingAncestors<T extends DepthNode>(
  items: T[],
  query: string,
  getText: (item: T) => string
): FilterResult<T> {
  const q = query.trim().toLowerCase();

  if (!q) {
    return { items, matchCount: items.length, isMatch: () => true };
  }

  const matched = new Set<number>();
  const retained = new Set<number>();

  items.forEach((item, index) => {
    if (!getText(item).toLowerCase().includes(q)) return;
    matched.add(index);
    retained.add(index);
    ancestorIndices(items, index).forEach(i => retained.add(i));
  });

  // Preserve original order rather than match order; the tree must still read top
  // to bottom the way it does unfiltered.
  const keptIndices = [...retained].sort((a, b) => a - b);
  const matchedItems = new Set(keptIndices.filter(i => matched.has(i)).map(i => items[i]));

  return {
    items: keptIndices.map(i => items[i]),
    matchCount: matched.size,
    isMatch: (item: T) => matchedItems.has(item),
  };
}
