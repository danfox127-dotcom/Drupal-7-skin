import { FieldDescriptor } from '../formSchema';
import { explodeTags, implodeTags, stripEntityId, labelKey } from './values';

/**
 * Asking the destination site whether it has the thing being referenced.
 *
 * Without this, a reference field can only be filled by writing the source's title and
 * hoping. That is not good enough in either direction:
 *
 *   - For Related Conditions and friends, a title the destination does not have makes
 *     Drupal REFUSE THE SAVE — "There are no entities matching X" — so a paste that was
 *     meant to save typing instead blocks the form until someone clears the field.
 *   - For Groups the instruction was explicit: if it does not match, leave it blank. You
 *     cannot honour that by writing a guess.
 *
 * Drupal 7 hands us the means to check. Every autocomplete is rendered with a hidden
 * sibling input whose value is the callback URL:
 *
 *   <input type="hidden" id="edit-field-conditions-und-0-target-id-autocomplete"
 *          value="https://site/entityreference/autocomplete/tags/field_conditions/..."
 *          disabled class="autocomplete">
 *
 * So the destination can be asked, same-origin, with the session already attached —
 * before anything is written.
 *
 * NOTE: the committed fixtures cannot prove this end to end. captureFixture blanks the
 * value of every non-structural input, including this one, so the path is empty in all
 * of them. That is fixed in captureFixture.ts, but a fixture captured BEFORE that change
 * still has no path — hence `unavailable` being a first-class outcome rather than an
 * error, and hence the live-site step in the plan's verification.
 */

export type ProbeStatus = 'match' | 'no-match' | 'unavailable';

export interface ProbeResult {
  status: ProbeStatus;
  /**
   * The exact string to write, when matched.
   *
   * This is the destination's OWN autocomplete value, including its own entity id — the
   * key Drupal returned, e.g. `IgA Nephropathy (4417)`. Writing what the site just told
   * us is more reliable than writing a bare title and trusting its validator to
   * re-resolve it.
   */
  value: string | null;
  /** Why the check could not run, for the provenance line. */
  reason: string | null;
}

/**
 * How long a single lookup may take before it is treated as unavailable.
 *
 * Overridable per call so the timeout branch is testable without a five-second test. A
 * slow site is the likeliest real cause of `unavailable`, and it decides whether a value
 * is written unchecked or dropped, so it needs a test rather than an argument.
 */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * The callback URL for this autocomplete, or null when the form does not expose one.
 *
 * Looks for the hidden sibling by id first — that is the relationship Drupal actually
 * builds — and falls back to searching the widget wrapper, because a themer moving the
 * element does not change what it is.
 */
export function autocompletePathFor(
  field: FieldDescriptor,
  root: Document = document
): string | null {
  const el = field.elements[0];
  if (!el) return null;

  const direct = el.id ? root.getElementById(`${el.id}-autocomplete`) : null;
  const sibling = direct ?? (el.closest('.form-item, .field-widget') ?? root)
    .querySelector<HTMLInputElement>('input.autocomplete[id$="-autocomplete"]');

  const raw = (sibling as HTMLInputElement | null)?.value?.trim();
  return raw || null;
}

/**
 * Looks one title up against the destination.
 *
 * Refuses anything that is not same-origin. The path comes from the page currently open,
 * so it should always be this site — but a fetch built from DOM content should be
 * checked rather than trusted, and an autocomplete pointing elsewhere is not something
 * to follow with the user's session cookies attached.
 */
export async function probeReference(
  path: string,
  title: string,
  location: Pick<Location, 'origin' | 'href'> = window.location,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<ProbeResult> {
  let url: URL;
  try {
    url = new URL(`${path.replace(/\/$/, '')}/${encodeURIComponent(title)}`, location.href);
  } catch {
    return { status: 'unavailable', value: null, reason: 'the lookup address could not be read' };
  }

  if (url.origin !== location.origin) {
    return {
      status: 'unavailable', value: null,
      reason: 'the lookup address points at another site, so it was not followed',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: 'unavailable', value: null, reason: `the site answered ${response.status}` };
    }

    /**
     * Drupal answers with an object keyed by the value to submit:
     *   { "IgA Nephropathy (4417)": "IgA Nephropathy" }
     * Taxonomy autocomplete answers { "Nephrology": "Nephrology" }.
     */
    const data = await response.json() as unknown;
    if (!data || typeof data !== 'object') {
      return { status: 'unavailable', value: null, reason: 'the site\'s answer could not be read' };
    }

    const wanted = labelKey(title);
    for (const key of Object.keys(data as Record<string, string>)) {
      if (labelKey(stripEntityId(key)) === wanted) {
        return { status: 'match', value: key, reason: null };
      }
    }

    return { status: 'no-match', value: null, reason: null };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      status: 'unavailable', value: null,
      reason: aborted ? 'the lookup timed out' : 'the lookup could not be completed',
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ResolvedReference {
  /** What to write. Empty string means write nothing. */
  value: string;
  /** Titles this site does not have. */
  missing: string[];
  /** True when the destination confirmed every title. */
  verified: boolean;
  /** Shown in the review when the outcome needs explaining. */
  note: string | null;
}

/**
 * Resolves every title in a reference field against the destination.
 *
 * `blankOnMiss` is the decision that differs per field, not a global policy:
 *
 *   - Groups: blank. A wrong group changes who can see the page, and group names rarely
 *     survive between sites, so an unconfirmed value is left out.
 *   - Everything else: when the site cannot be asked at all, the titles are written
 *     anyway and flagged. Drupal will then either resolve them or refuse the save with
 *     a message naming the field — loud, recoverable, and better than silently dropping
 *     the references a migration is largely made of.
 *
 * A title the site was asked about and does NOT have is always dropped, whatever the
 * field: there is nothing to be gained from writing a value known to be invalid.
 */
export async function resolveReference(
  rawValue: string,
  path: string | null,
  blankOnMiss: boolean,
  location: Pick<Location, 'origin' | 'href'> = window.location,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<ResolvedReference> {
  const titles = explodeTags(rawValue).map(stripEntityId).filter(Boolean);
  if (titles.length === 0) {
    return { value: '', missing: [], verified: true, note: null };
  }

  if (!path) {
    if (blankOnMiss) {
      return {
        value: '', missing: titles, verified: false,
        note: 'This form does not offer a way to look the group up, so it was left blank.',
      };
    }
    return {
      value: implodeTags(titles), missing: [], verified: false,
      note: 'Could not check these against this site. If they do not exist here, Drupal will say so when you save.',
    };
  }

  const resolved: string[] = [];
  const missing: string[] = [];
  const unavailable: string[] = [];
  /** One lookup per distinct title, however many times it appears. */
  const seen = new Map<string, ProbeResult>();

  for (const title of titles) {
    const key = labelKey(title);
    let result = seen.get(key);
    if (!result) {
      result = await probeReference(path, title, location, timeoutMs);
      seen.set(key, result);
    }

    if (result.status === 'match' && result.value) resolved.push(result.value);
    else if (result.status === 'no-match') missing.push(title);
    else unavailable.push(title);
  }

  /**
   * A lookup that could not run is not a miss. For a group it still means blank; for
   * anything else the title is written and flagged, same as having no path at all.
   */
  if (unavailable.length > 0 && !blankOnMiss) resolved.push(...unavailable);

  const notes: string[] = [];
  if (missing.length > 0) {
    notes.push(`This site has no ${missing.map(m => `“${m}”`).join(', ')}.`);
  }
  if (unavailable.length > 0) {
    notes.push(blankOnMiss
      ? 'Some lookups did not answer, so nothing was written.'
      : 'Some lookups did not answer; those values were written unchecked.');
  }

  return {
    value: implodeTags(resolved),
    missing,
    verified: missing.length === 0 && unavailable.length === 0,
    note: notes.length ? notes.join(' ') : null,
  };
}
