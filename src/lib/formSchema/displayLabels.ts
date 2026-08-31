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

/**
 * The label to show. Falls back to Drupal's, so an unrecognised field is never renamed
 * into something invented.
 */
export function displayLabelFor(field: Pick<FieldDescriptor, 'label' | 'machineName'>): string {
  const name = (field.machineName ?? '').toLowerCase();
  for (const [pattern, label] of OVERRIDES) {
    if (pattern.test(name)) return label;
  }
  return field.label;
}

/**
 * True when the shown label differs from Drupal's, so the UI can note the original.
 * An editor who knows the Drupal form should still be able to map one to the other.
 */
export function wasRelabelled(field: Pick<FieldDescriptor, 'label' | 'machineName'>): boolean {
  return displayLabelFor(field) !== field.label;
}
