import { FieldDescriptor } from './types';

/**
 * Orders a re-read of the form the way it was FIRST read.
 *
 * walkForm reports fields in DOM order, which is only the form's real order until the
 * Two-Pane Editor relocates widgets into its host — a host that sits at the top of the
 * form. After that, a fresh walk reads every relocated widget (the body's rich editor,
 * media, autocompletes) ahead of fields that stayed put, which is how News came to
 * show Body above Title once the editor's rescan re-rendered it.
 *
 * Fields already known keep their `previous` order. A field that did not exist before
 * — one Drupal's AJAX has just rendered — goes after whichever known field precedes it
 * in the fresh walk, which is its real neighbour for anything not relocated.
 */
export function keepFieldOrder(
  previous: FieldDescriptor[],
  fresh: FieldDescriptor[]
): FieldDescriptor[] {
  const rank = new Map(previous.map((field, index) => [field.machineName, index]));

  const known: FieldDescriptor[] = [];
  // New fields keyed by the known field they follow; null for ones ahead of all of them.
  const following = new Map<string | null, FieldDescriptor[]>();
  let anchor: string | null = null;

  for (const field of fresh) {
    if (rank.has(field.machineName)) {
      known.push(field);
      anchor = field.machineName;
    } else {
      const list = following.get(anchor) ?? [];
      list.push(field);
      following.set(anchor, list);
    }
  }

  known.sort((a, b) => rank.get(a.machineName)! - rank.get(b.machineName)!);

  const ordered = [...(following.get(null) ?? [])];
  for (const field of known) {
    ordered.push(field, ...(following.get(field.machineName) ?? []));
  }
  return ordered;
}
