import { FieldOption } from './formSchema';

/**
 * Where a node's menu link lands among its siblings, and which weight moves it.
 *
 * The node form carries only THIS link's `menu[weight]`. Its siblings' ORDER is in the
 * parent select, which Drupal builds from the sorted tree, but their WEIGHTS are not — and
 * siblings very often share a weight (usually 0, then alphabetical), so the order alone
 * cannot say which weight lands the page between two of them. The weights come from the
 * menu's admin page instead, fetched read-only; nothing here ever writes to a sibling.
 */

export interface MenuSibling {
  mlid: string;
  title: string;
  disabled: boolean;
}

export interface WeightedSibling extends MenuSibling {
  weight: number;
}

/** This page's own link: its title and weight, and its mlid once it has been saved. */
export interface SelfLink {
  title: string;
  weight: number;
  mlid?: string;
}

/** `main-menu:1234`, the parent select's option value. */
const OPTION_VALUE = /^([a-z0-9_-]+):(\d+)$/i;

/** Drupal appends this to a disabled link's label in the parent select. */
const DISABLED_SUFFIX = /\s*\(disabled\)$/i;

export function parseOptionValue(value: string): { menuName: string; mlid: string } | null {
  const match = OPTION_VALUE.exec(value.trim());
  return match ? { menuName: match[1], mlid: match[2] } : null;
}

/**
 * The direct children of `parentValue`, in the parent select's own order.
 *
 * The select is in tree order, so a parent's children are the entries one level deeper
 * that follow it, up to the next entry at or above its own depth. The node's own link is
 * never among them: Drupal leaves an item out of its own parent list.
 *
 * "One level deeper" is taken from the first entry under the parent, not assumed to be
 * depth + 1: the live menu select marks each level with TWO hyphens, so the walker's
 * depths step by two there, while taxonomy-style selects step by one.
 */
export function siblingsUnder(options: FieldOption[], parentValue: string): MenuSibling[] {
  const at = options.findIndex(o => o.value === parentValue);
  if (at === -1) return [];

  const depth = options[at].depth;
  const childDepth = options[at + 1]?.depth;
  if (childDepth === undefined || childDepth <= depth) return [];

  const siblings: MenuSibling[] = [];
  for (let i = at + 1; i < options.length && options[i].depth > depth; i++) {
    if (options[i].depth !== childDepth) continue;
    const parsed = parseOptionValue(options[i].value);
    if (!parsed) continue;
    const label = options[i].label.trim();
    siblings.push({
      mlid: parsed.mlid,
      title: label.replace(DISABLED_SUFFIX, ''),
      disabled: DISABLED_SUFFIX.test(label),
    });
  }
  return siblings;
}

/**
 * Drupal 7's own sibling sort key, from _menu_tree_check_access:
 * `(50000 + weight) . ' ' . title . ' ' . mlid`, ksorted as a string.
 *
 * Mirrored exactly rather than approximated as "weight, then title", because the string
 * form has consequences a numeric sort does not: mlid compares as a string ("12" < "5"),
 * and a title is compared up to the space that separates it from the mlid.
 *
 * A link not saved yet has no mlid. It gets one higher than any existing link on save,
 * but that is only decidable as a number, so it is keyed last; this matters only for two
 * links with the same weight AND the same title.
 */
const sortKey = (weight: number, title: string, mlid?: string) =>
  `${50000 + weight} ${title} ${mlid ?? '￿'}`;

export function orderSiblings<T extends WeightedSibling>(siblings: T[]): T[] {
  return [...siblings].sort((a, b) => {
    const ka = sortKey(a.weight, a.title, a.mlid);
    const kb = sortKey(b.weight, b.title, b.mlid);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** The index this page lands at among `siblings`, 0 meaning above all of them. */
export function positionOf(siblings: WeightedSibling[], self: SelfLink): number {
  const own = sortKey(self.weight, self.title, self.mlid);
  return siblings.filter(s => sortKey(s.weight, s.title, s.mlid) < own).length;
}

/**
 * A weight that lands this page at `index`, or null when no weight can.
 *
 * Null is a real answer: between two siblings that share a weight, only this page's title
 * decides, and a title that sorts elsewhere cannot be placed there by weight alone. Moving
 * the siblings would, but that is the menu manager's job and never done from a node form.
 *
 * The current weight wins when it already lands there. Otherwise the offered weight
 * nearest the gap is chosen — just below the first sibling, just above the last, or
 * midway between two — so a move changes as little as it can.
 */
export function weightForPosition(
  siblings: WeightedSibling[],
  self: SelfLink,
  index: number,
  allowedWeights: number[]
): number | null {
  const lands = (weight: number) => positionOf(siblings, { ...self, weight }) === index;
  if (lands(self.weight) && allowedWeights.includes(self.weight)) return self.weight;

  const ordered = orderSiblings(siblings);
  const before = ordered[index - 1];
  const after = ordered[index];
  const target = !before && !after
    ? self.weight
    : !before
      ? after.weight - 1
      : !after
        ? before.weight + 1
        : (before.weight + after.weight) / 2;

  let best: number | null = null;
  for (const weight of allowedWeights) {
    if (!lands(weight)) continue;
    if (best === null
      || Math.abs(weight - target) < Math.abs(best - target)
      || (Math.abs(weight - target) === Math.abs(best - target) && Math.abs(weight) < Math.abs(best))) {
      best = weight;
    }
  }
  return best;
}

/**
 * Reads every `…mlid:N…[weight]` select out of a menu admin page, as mlid → weight.
 *
 * Works on the raw HTML, not a DOM, so it runs the same on a fetched page and in a unit
 * test. Two name shapes are accepted — core's `mlid:N[weight]` and the
 * `menu[mlid:N][weight]` seen on BigMenu's table — because a capture of the live BigMenu
 * markup is not on hand to settle which one ships. A Drupal AJAX response (BigMenu loads
 * subtrees that way) is unwrapped to the HTML its commands carry first.
 *
 * A select with nothing marked selected submits its first option; for Drupal's weight
 * selects that is never what is saved, so an unmarked select reads as 0, the default.
 */
export function parseMenuWeights(source: string): Map<string, number> {
  const html = unwrapAjax(source);
  const weights = new Map<string, number>();
  const selectPattern = /<select\b[^>]*\bname="[^"]*mlid:(\d+)\]?\[weight\]"[^>]*>([\s\S]*?)<\/select>/gi;

  let select: RegExpExecArray | null;
  while ((select = selectPattern.exec(html))) {
    const [, mlid, body] = select;
    const selected = /<option\b[^>]*\bselected\b[^>]*>/i.exec(body);
    const value = selected && /\bvalue="(-?\d+)"/i.exec(selected[0]);
    weights.set(mlid, value ? Number(value[1]) : 0);
  }
  return weights;
}

function unwrapAjax(source: string): string {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return source;
  try {
    const parsed = JSON.parse(trimmed);
    const commands: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    return commands
      .map(c => (c && typeof c === 'object' && typeof (c as { data?: unknown }).data === 'string'
        ? (c as { data: string }).data
        : ''))
      .join('\n');
  } catch {
    return source;
  }
}

export type Fetcher = (url: string) => Promise<string>;

const sameOriginFetch: Fetcher = async url => {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
};

/**
 * Weights for exactly these siblings, or null when any cannot be read.
 *
 * The overview page first: without BigMenu it holds the whole tree. With BigMenu it holds
 * only the top level, and a deeper parent's children come from BigMenu's own subtree
 * endpoint — one request for the one parent, never a crawl of the menu.
 *
 * Partial answers are refused. A position computed from some siblings' real weights and
 * some guessed ones can land the page somewhere other than where the list showed it, which
 * is worse than admitting the list is unavailable.
 */
export async function fetchSiblingWeights(
  menuName: string,
  parentMlid: string,
  siblingMlids: string[],
  fetcher: Fetcher = sameOriginFetch
): Promise<Map<string, number> | null> {
  if (siblingMlids.length === 0) return new Map();

  const base = `/admin/structure/menu/manage/${menuName}`;
  const pick = (all: Map<string, number>) =>
    siblingMlids.every(mlid => all.has(mlid))
      ? new Map(siblingMlids.map(mlid => [mlid, all.get(mlid)!]))
      : null;

  try {
    const overview = pick(parseMenuWeights(await fetcher(base)));
    if (overview) return overview;
    if (parentMlid === '0') return null;
    return pick(parseMenuWeights(await fetcher(`${base}/bigmenu-customize/subform/${parentMlid}`)));
  } catch {
    return null;
  }
}
