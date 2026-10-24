/**
 * Which fields the person filled in from Varys on this page, so a save can say so.
 *
 * The Varys panel calls `markFilled` when it writes a suggestion into the form and
 * `unmarkFilled` when the person takes it back. The capture (src/content/varysCapture.ts)
 * reads `filledFields()` at Save and sends the list with the save, and Varys shows it beside
 * the change as "Filled from Varys: search title". Only the panel marks or unmarks.
 *
 * Plain module state, with no extension API: it lives as long as the page does. The panel and
 * the capture are in the same content script, so they share it. Every submit reloads the page
 * and the list starts empty; when the reload is the same form re-rendered (a Preview, or a
 * save Drupal rejected), the panel marks again the fills still in it, which the worker kept
 * for it (`adoptCarriedFills` in suggestionFill.ts). After a save that goes through, nothing
 * is kept, and the reopened form starts with none.
 *
 * Varys keeps only these six (it drops anything else), so this is their whole vocabulary:
 * `body` and `related_profiles` are the two a draft filled into a new page adds, and
 * `meta_description` is also what a draft's Summary is marked as.
 */

export type VarysFilledField =
  | 'title' | 'meta_title' | 'meta_description' | 'headings' | 'body' | 'related_profiles';

const filled = new Set<VarysFilledField>();

export function markFilled(field: VarysFilledField): void {
  filled.add(field);
}

export function unmarkFilled(field: VarysFilledField): void {
  filled.delete(field);
}

/** The fields marked, each once, in alphabetical order. A copy: changing it changes nothing here. */
export function filledFields(): VarysFilledField[] {
  return Array.from(filled).sort();
}

/** Forgets every mark. For tests; a page never needs it. */
export function resetFilled(): void {
  filled.clear();
}
