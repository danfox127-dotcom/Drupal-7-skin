import { FieldDescriptor } from '../formSchema';
import { FieldValue } from '../fieldBinding';

/**
 * Translating one site's values into another's.
 *
 * Two problems live here, and both come from the same place: Drupal stores references as
 * numeric ids, and those ids are local to one database.
 *
 * 1. CHOICE WIDGETS. A `<select>` of taxonomy terms submits term ids. Both sites have a
 *    "Nephrology" term; neither agrees on its id. So the snapshot carries the option
 *    LABEL and the destination resolves it back to whatever id it uses. Writing the
 *    source's id would select the wrong term, or — because writeValue reports a select
 *    that rejected its value — select nothing and say so.
 *
 * 2. AUTOCOMPLETES. Drupal renders an entity reference as `Some Title (1234)` and parses
 *    the id back out on submit. The title is the part that can travel.
 */

/** Drupal's `(123)` entity-id suffix on an autocomplete value. */
const ID_SUFFIX = /\s*\((\d+)\)\s*$/;

/** Strips the entity id Drupal appends, leaving the title a person would recognise. */
export function stripEntityId(raw: string): string {
  return raw.replace(ID_SUFFIX, '').trim();
}

/** The id Drupal had appended, when there was one. Recorded for provenance, never written. */
export function entityIdOf(raw: string): string | null {
  return raw.match(ID_SUFFIX)?.[1] ?? null;
}

/**
 * Splits a Drupal tags value into its parts, honouring quoting.
 *
 * Mirrors core's drupal_explode_tags. This is not pedantry: a comma inside a single tag
 * is wrapped in double quotes, and real content hits it constantly — `"Smith, John"` is
 * one author, and a naive split on commas turns it into two references, neither of which
 * resolves. Doubled quotes inside a quoted tag are an escaped quote.
 */
export function explodeTags(value: string): string[] {
  const tags: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (quoted) {
      if (char === '"') {
        if (value[i + 1] === '"') { current += '"'; i++; }
        else quoted = false;
      } else current += char;
      continue;
    }

    if (char === '"') { quoted = true; continue; }
    if (char === ',') { tags.push(current); current = ''; continue; }
    current += char;
  }
  tags.push(current);

  return tags.map(tag => tag.trim()).filter(Boolean);
}

/** Joins tags back into a Drupal tags value, quoting any that need it. */
export function implodeTags(tags: string[]): string {
  return tags
    .map(tag => (/[",]/.test(tag) ? `"${tag.replace(/"/g, '""')}"` : tag))
    .join(', ');
}

/** Comparison key for a label: case, surrounding space and inner runs of space ignored. */
export function labelKey(label: string): string {
  return label.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True for the placeholder option Drupal adds to an optional select. */
function isNoneOption(value: string, label: string): boolean {
  return value === '' || value === '_none' || /^-\s*(none|select|any)\b/i.test(label.trim());
}

/**
 * The labels of the options currently selected on a choice field.
 *
 * Derived from the field's CURRENT value rather than from the `selected` flags captured
 * at discovery. Discovery may have run before the user changed anything, and on an edit
 * form the two can disagree — the value is what Drupal would submit.
 */
export function optionLabelsFor(field: FieldDescriptor, value: FieldValue): string[] | null {
  if (!field.options || field.options.length === 0) return null;

  const wanted = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'boolean' ? [] : [String(value)];

  const labels: string[] = [];
  for (const want of wanted) {
    const option = field.options.find(o => o.value === want);
    if (!option) continue;
    if (isNoneOption(option.value, option.label)) continue;
    labels.push(option.label);
  }

  return labels;
}

/**
 * Resolves captured labels back to this form's own option values.
 *
 * `missing` is the point of the return shape. A term the destination does not have is
 * not a failed write to be retried — it is a fact about the two sites that a person has
 * to see, so it is reported by name rather than dropped.
 */
export function valueForLabels(
  field: FieldDescriptor,
  labels: string[]
): { value: FieldValue; missing: string[] } {
  const options = field.options ?? [];
  const byLabel = new Map<string, string>();
  for (const option of options) {
    if (isNoneOption(option.value, option.label)) continue;
    // First wins: a duplicate label is ambiguous, and the earlier option is the one
    // Drupal renders first, which is what a person picking by hand would land on.
    const key = labelKey(option.label);
    if (!byLabel.has(key)) byLabel.set(key, option.value);
  }

  const resolved: string[] = [];
  const missing: string[] = [];
  for (const label of labels) {
    const match = byLabel.get(labelKey(label));
    if (match === undefined) missing.push(label);
    else resolved.push(match);
  }

  const multi = field.kind === 'checkboxGroup';
  return {
    value: multi ? resolved : (resolved[0] ?? ''),
    missing,
  };
}
