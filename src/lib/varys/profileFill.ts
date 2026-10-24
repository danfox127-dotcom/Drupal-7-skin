/**
 * Adding the doctors a Varys draft quotes to a page's Related Profiles, and taking them back.
 *
 * Related Profiles is a Drupal entity-reference autocomplete with an "Add another item" button.
 * A WRONG doctor on a medical site is worse than none, so a name is written only when the
 * site's own autocomplete answers with exactly ONE entry whose name is the directory full name
 * (`probeReferenceExact`). Two entries with that name, only a longer name, or no answer at all
 * add nobody, and each says so. This never goes through `resolveReference`: when the site
 * cannot be asked, that function writes the name unchecked, which is the opposite of the rule.
 *
 * It fills the way `DoctorBatchAdder` does — one name at a time, the lookup BEFORE any row is
 * added, because every add-more is a server round trip that rebuilds the widget and rows must
 * not be created for names that will not be written. It never submits the form.
 */

import type { FieldDescriptor } from '../formSchema/types';
import { writeValue } from '../fieldBinding';
import { autocompletePathFor, probeReferenceExact } from '../clone/references';
import { addAnotherRow, relativeName, widgetBaseName } from '../clone/paragraphs';
import { labelKey, stripEntityId } from '../clone/values';

/** The Drupal field every doctor goes into. */
const PROFILES_FIELD = 'field_cola_cups_profiles';

/** How long to wait for "Add another item" to render a row; `addAnotherRow`'s own default. */
const ADD_ROW_TIMEOUT_MS = 15000;

export type ProfileResult = 'added' | 'already' | 'ambiguous' | 'not_found' | 'unavailable';

export interface ProfileOutcome {
  /** The directory full name, exactly as Varys gave it. */
  name: string;
  result: ProfileResult;
  /** The row written to. Set only for `added`, and the only thing `undoProfiles` acts on. */
  delta: number | null;
  /**
   * What was written into that row (the site's own key, id included), so Undo can tell whether
   * the person has changed it since. Optional: an outcome without it is compared by name.
   */
  value?: string;
}

/** A descriptor for one control, enough for `writeValue`. */
const asField = (el: HTMLInputElement): FieldDescriptor =>
  ({ kind: 'autocomplete', elements: [el] }) as unknown as FieldDescriptor;

/** The widget's `target_id` inputs, lowest delta first (drag-and-drop can reorder the DOM). */
function rowsOf(doc: Document, baseName: string): { input: HTMLInputElement; delta: number }[] {
  const rows: { input: HTMLInputElement; delta: number }[] = [];
  for (const input of Array.from(doc.querySelectorAll<HTMLInputElement>(
    `[name^=${JSON.stringify(`${baseName}[und]`)}][name$="[target_id]"]`
  ))) {
    const parsed = relativeName(baseName, input.name);
    if (parsed?.relative === 'target_id') rows.push({ input, delta: parsed.delta });
  }
  return rows.sort((a, b) => a.delta - b.delta);
}

const isEmpty = (input: HTMLInputElement): boolean => input.value.trim() === '';

/** True when a row already holds this doctor, whatever id the site gave them. */
const holds = (rows: { input: HTMLInputElement }[], key: string): boolean =>
  rows.some(({ input }) => labelKey(stripEntityId(input.value)) === key);

/**
 * Adds each name to Related Profiles when the site finds exactly one match for it.
 *
 * `anyInput` is any `target_id` input of the field; the widget is found from it. An empty row
 * is filled before "Add another item" is ever pressed, so a new page's blank first row is used
 * rather than left behind. A name already in a row is `already` and is not looked up. A name
 * repeated in `fullNames` is handled once. If a row cannot be added that name is `unavailable`
 * and the rest are still attempted.
 */
export async function addProfiles(
  fullNames: string[],
  anyInput: HTMLInputElement,
  addTimeoutMs: number = ADD_ROW_TIMEOUT_MS
): Promise<ProfileOutcome[]> {
  const doc = anyInput.ownerDocument;
  const baseName = widgetBaseName(anyInput.name ?? '');
  const handled = new Set<string>();
  const outcomes: ProfileOutcome[] = [];

  const outcome = (name: string, result: ProfileResult, delta: number | null = null, value?: string): ProfileOutcome =>
    value === undefined ? { name, result, delta } : { name, result, delta, value };

  for (const name of fullNames) {
    const key = labelKey(name);
    if (key === '' || handled.has(key)) continue;
    handled.add(key);

    if (!baseName) {
      outcomes.push(outcome(name, 'unavailable'));
      continue;
    }

    // Re-read every time: the add-more that served the previous name rebuilt this widget.
    const before = rowsOf(doc, baseName);
    if (before.length === 0) {
      outcomes.push(outcome(name, 'unavailable'));
      continue;
    }
    if (holds(before, key)) {
      outcomes.push(outcome(name, 'already'));
      continue;
    }

    const asker = before.find(({ input }) => isEmpty(input)) ?? before[before.length - 1];
    const path = autocompletePathFor({ elements: [asker.input] } as unknown as FieldDescriptor, doc);
    if (!path) {
      outcomes.push(outcome(name, 'unavailable'));
      continue;
    }

    const probe = await probeReferenceExact(path, name);
    if (probe.status !== 'match' || probe.value === null) {
      outcomes.push(outcome(
        name,
        probe.status === 'ambiguous' ? 'ambiguous' : probe.status === 'no-match' ? 'not_found' : 'unavailable'
      ));
      continue;
    }

    // The lookup took a moment; read the rows again before choosing where to write.
    const now = rowsOf(doc, baseName);
    if (holds(now, key)) {
      outcomes.push(outcome(name, 'already'));
      continue;
    }

    let target: HTMLInputElement | null;
    let delta: number;
    const free = now.find(({ input }) => isEmpty(input));
    if (free) {
      target = free.input;
      delta = free.delta;
    } else {
      const last = now[now.length - 1];
      const added = last ? await addAnotherRow(last.input, baseName, addTimeoutMs, doc) : null;
      if (!added || !added.ok || added.delta === null) {
        outcomes.push(outcome(name, 'unavailable'));
        continue;
      }
      delta = added.delta;
      target = doc.querySelector<HTMLInputElement>(
        `[name=${JSON.stringify(`${baseName}[und][${delta}][target_id]`)}]`
      );
    }

    if (!target || !writeValue(asField(target), probe.value) || target.value !== probe.value) {
      outcomes.push(outcome(name, 'unavailable'));
      continue;
    }
    outcomes.push(outcome(name, 'added', delta, probe.value));
  }

  return outcomes;
}

/**
 * Empties the rows `addProfiles` added. Drupal ignores an empty row on save, so none is removed.
 *
 * A row is cleared only while it still holds what was written there: a row the person has
 * since changed is theirs now. Rows that were `already` there, or never added, are not touched.
 */
export function undoProfiles(outcomes: ProfileOutcome[], root: Document = document): void {
  for (const added of outcomes) {
    if (added.result !== 'added' || added.delta === null) continue;

    // A suffix match, so a field nested inside a paragraph item is found as well as a top-level one.
    const inputs = root.querySelectorAll<HTMLInputElement>(
      `[name$=${JSON.stringify(`${PROFILES_FIELD}[und][${added.delta}][target_id]`)}]`
    );
    for (const input of Array.from(inputs)) {
      const unchanged = added.value !== undefined
        ? input.value === added.value
        : labelKey(stripEntityId(input.value)) === labelKey(added.name);
      if (unchanged) writeValue(asField(input), '');
    }
  }
}
