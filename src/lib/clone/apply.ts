import { writeValue } from '../fieldBinding';
import { FieldMatch } from './match';
import { MediaRef } from './types';
import { hasAttachment } from './media';
import { autocompletePathFor, resolveReference } from './references';
import { rebuildParagraphs, ParagraphOutcome } from './paragraphs';
import { NodeSnapshot } from './types';

/**
 * Writing the approved matches into the form.
 *
 * Writes to the FORM ONLY. Nothing is sent to Drupal — the editor still presses Save,
 * which is the guarantee the whole product is built around. The publish state is never
 * touched, so a pasted page saves as a draft and is published by hand afterwards.
 */

export interface AppliedField {
  /** What this form calls the field. */
  label: string;
  /** What the source called it, when the two differ. */
  sourceLabel: string;
  machineName: string;
  /** Anything worth telling the editor about this one. */
  note: string | null;
}

export interface CloneOutcome {
  filled: AppliedField[];
  /**
   * Written, but not everything the source had — a taxonomy field where one term of
   * three exists here, or a reference list that lost an entry.
   */
  partial: AppliedField[];
  /** Deliberately left empty, with a reason. Groups that could not be confirmed. */
  blanked: AppliedField[];
  /**
   * The native control rejected the write.
   *
   * Surfaced rather than assumed: writeValue returns false for a select given a value
   * with no matching option, and for an element that has left the document after one of
   * Drupal's AJAX re-renders. Both look like success if the result is ignored.
   */
  failed: AppliedField[];
  /** Images the source had, for the checklist. Never written by this function. */
  images: MediaRef[];
  /**
   * Structured content items, recreated one at a time through Drupal's own
   * "Add another item". Empty when the source had none.
   */
  paragraphs: ParagraphOutcome[];
}

const describe = (match: FieldMatch, note: string | null): AppliedField => ({
  label: match.target.label,
  sourceLabel: match.sourceLabel,
  machineName: match.target.machineName,
  note,
});

export async function applyMatches(
  matches: FieldMatch[],
  media: MediaRef[] = [],
  location: Pick<Location, 'origin' | 'href'> = window.location,
  paragraphs: NodeSnapshot['paragraphs'] = []
): Promise<CloneOutcome> {
  const outcome: CloneOutcome = {
    filled: [], partial: [], blanked: [], failed: [],
    images: media.filter(hasAttachment),
    paragraphs: [],
  };

  for (const match of matches) {
    if (!match.accepted) continue;

    let value = match.value;
    let note: string | null = null;
    let missing = match.missing;

    /**
     * References are resolved against THIS site first, one field at a time.
     *
     * Sequential on purpose: these are network lookups against the site the editor is
     * working in, and firing a dozen at once to save a second is not a trade worth
     * making on a Drupal admin page.
     */
    if (match.needsProbe) {
      const path = autocompletePathFor(match.target);
      const resolved = await resolveReference(
        String(value), path, match.blankOnMiss, location
      );
      value = resolved.value;
      note = resolved.note;
      missing = resolved.missing;

      if (resolved.value === '') {
        /**
         * Nothing to write. Reported as blanked rather than failed — the field is empty
         * because that was the correct outcome, not because a write went wrong, and
         * conflating the two would send someone looking for a bug.
         */
        outcome.blanked.push(describe(match, note ?? 'Nothing here matched this site.'));
        continue;
      }
    }

    if (!writeValue(match.target, value)) {
      outcome.failed.push(describe(
        match,
        note ?? 'This form’s own control would not take the value, so it was left as it was.'
      ));
      continue;
    }

    if (missing.length > 0) {
      outcome.partial.push(describe(
        match,
        note ?? `Filled, except: ${missing.map(m => `“${m}”`).join(', ')} — this site has no match.`
      ));
      continue;
    }

    outcome.filled.push(describe(match, note));
  }

  /**
   * Content items LAST, and after the plain fields are in.
   *
   * Each one is a server round-trip that re-renders the whole widget, and Drupal's AJAX
   * replaces the wrapper — so every element reference into it goes stale. Doing this
   * before the ordinary writes would mean writing through references the rebuild had
   * already detached, which writeValue would report as failures for fields that were
   * perfectly fine.
   */
  for (const widget of paragraphs) {
    if (widget.items.length === 0) continue;
    outcome.paragraphs.push(await rebuildParagraphs(widget));
  }

  return outcome;
}

/** Items that could not be recreated, flattened for the banner. */
export function paragraphProblems(outcome: CloneOutcome): string[] {
  return outcome.paragraphs.flatMap(widget =>
    widget.items
      .filter(item => !item.ok)
      .map(item => `${widget.label} — ${item.bundleLabel}: ${item.reason ?? 'not recreated'}`));
}

/** "18 filled, 2 partly, 1 left blank" — the line the banner shows. */
export function summarise(outcome: CloneOutcome): string {
  const parts = [`${outcome.filled.length} filled`];
  if (outcome.partial.length) parts.push(`${outcome.partial.length} partly`);
  if (outcome.blanked.length) parts.push(`${outcome.blanked.length} left blank`);
  if (outcome.failed.length) parts.push(`${outcome.failed.length} refused by the form`);
  const items = outcome.paragraphs.flatMap(w => w.items);
  const rebuilt = items.filter(item => item.ok).length;
  if (rebuilt) parts.push(`${rebuilt} content item${rebuilt === 1 ? '' : 's'} rebuilt`);
  if (items.length > rebuilt) parts.push(`${items.length - rebuilt} needing a look`);
  if (outcome.images.length) {
    parts.push(`${outcome.images.length} image${outcome.images.length === 1 ? '' : 's'} to attach`);
  }
  return parts.join(', ');
}
