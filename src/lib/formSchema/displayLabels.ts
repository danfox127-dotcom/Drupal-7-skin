import { FieldDescriptor } from './types';

/**
 * Clearer labels for fields whose own label is ambiguous or actively misleading.
 *
 * A Specialty form carries six fields that all render as some form of "Title", and three
 * of them are literally the word "Title":
 *
 *   title_field[und][0][value]              the article headline
 *   metatags[und][title][value]             "Page title"    — browser tab and Google
 *   metatags[und][og:title][value]          "Content title" — Facebook, LinkedIn
 *   metatags[und][twitter:title][value]     "Title"         — Twitter card
 *   menu[link_title]                        "Menu link title"
 *   menu[options][attributes][title]        "Title"         — the link's tooltip
 *
 * Drupal's own labels are only unambiguous in context: inside the Meta tags tab, next to
 * an Open Graph heading, "Title" is clear enough. The overlay deliberately removes those
 * tabs, so it has to put the context back into the label — otherwise the editor shows
 * three identical "Title" boxes and no way to tell which is which.
 *
 * Keyed on machine name, because that is the only thing here that is unambiguous. The
 * underlying label is left untouched: section rules match on it, and the schema
 * diagnostic should keep reporting what Drupal actually said.
 */
const OVERRIDES: [RegExp, string][] = [
  // --- the ones that appear in search results and shares ---
  [/^metatags\[[^\]]*\]\[title\]/, 'Search result title'],
  [/^metatags\[[^\]]*\]\[description\]/, 'Search result description'],
  [/^metatags\[[^\]]*\]\[og:title\]/, 'Share title (Facebook, LinkedIn)'],
  [/^metatags\[[^\]]*\]\[og:description\]/, 'Share description (Facebook, LinkedIn)'],
  [/^metatags\[[^\]]*\]\[twitter:title\]/, 'Share title (Twitter/X)'],
  [/^metatags\[[^\]]*\]\[twitter:description\]/, 'Share description (Twitter/X)'],
  [/^metatags\[[^\]]*\]\[keywords\]/, 'Meta keywords'],
  [/^metatags\[[^\]]*\]\[canonical\]/, 'Canonical URL'],

  // --- menu link attributes, where "Title" means the hover tooltip ---
  [/^menu\[options\]\[attributes\]\[title\]/, 'Link tooltip'],
  [/^menu\[options\]\[attributes\]\[name\]/, 'Link name attribute'],
  [/^menu\[options\]\[attributes\]\[id\]/, 'Link ID attribute'],
  [/^menu\[options\]\[item_attributes\]\[id\]/, 'Menu item ID attribute'],
];

type Labelled = Pick<FieldDescriptor, 'label' | 'machineName'> & { displayLabel?: string };

/**
 * The label to show. Falls back to Drupal's, so an unrecognised field is never renamed
 * into something invented.
 */
export function displayLabelFor(field: Labelled): string {
  // Set by assignDisplayLabels when a label collided with another field's; it already
  // has the OVERRIDES below applied, so it wins.
  if (field.displayLabel) return field.displayLabel;

  const name = (field.machineName ?? '').toLowerCase();
  for (const [pattern, label] of OVERRIDES) {
    if (pattern.test(name)) return label;
  }
  return field.label;
}

/** Tokens that carry no meaning of their own in a Drupal field name. */
const NOISE_TOKENS = new Set(['field', 'value', 'und', 'node', 'item', 'default', 'target', 'id']);

/**
 * Qualifier for a field whose label is shared with another, taken from its machine name.
 *
 * `field_specialty_summary` next to `field_summary` differ by exactly one token, and that
 * token is the answer: one is the Summary, the other is the Specialty summary. Derived
 * rather than listed, because the colliding pairs differ per site and per content type —
 * columbiadoctors Specialty has two Summaries where cuimc News has one.
 */
function qualifierFor(field: Labelled, label: string): string {
  const inLabel = new Set(label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const base = (field.machineName ?? '').split('[')[0].toLowerCase();

  const distinct = base
    .split('_')
    .filter(Boolean)
    .filter(token => !NOISE_TOKENS.has(token) && !inLabel.has(token));

  return distinct.join(' ');
}

/**
 * Qualifies labels that would otherwise appear twice in the same section.
 *
 * Two boxes both reading "Summary" tell an editor nothing about which one they are filling
 * in, and on a Specialty form one of them is the default meta description while the other
 * is not. Drupal gets away with identical labels because its tabs and fieldsets supply the
 * context; the overlay removes those, so it has to put the context back.
 *
 * Only collisions are touched. A label that is already unique is left exactly as Drupal
 * wrote it — renaming fields nobody asked about would be worse than the problem.
 */
export function assignDisplayLabels(fields: FieldDescriptor[]): void {
  const byLabel = new Map<string, FieldDescriptor[]>();
  for (const field of fields) {
    const key = `${field.section}\u0000${displayLabelFor(field).toLowerCase()}`;
    const list = byLabel.get(key) ?? [];
    list.push(field);
    byLabel.set(key, list);
  }

  for (const group of byLabel.values()) {
    if (group.length < 2) continue;

    for (const field of group) {
      const label = displayLabelFor(field);
      const qualifier = qualifierFor(field, label);
      if (!qualifier) continue;
      // "Specialty summary", not "Summary (specialty)" — it reads as a name rather than
      // as an annotation, and stays short enough for a rail label.
      field.displayLabel = `${qualifier.charAt(0).toUpperCase()}${qualifier.slice(1)} ${label.toLowerCase()}`;
    }
  }
}

/**
 * True when the shown label differs from Drupal's, so the UI can note the original.
 * An editor who knows the Drupal form should still be able to map one to the other.
 */
export function wasRelabelled(field: Labelled): boolean {
  return displayLabelFor(field) !== field.label;
}
