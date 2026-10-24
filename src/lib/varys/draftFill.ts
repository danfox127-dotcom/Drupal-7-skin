/**
 * Which rows a Varys draft offers on a new page, the Overview box, and what Undo needs.
 *
 * Pure logic with no panel and no extension API, so it can be tested against a real form on
 * its own. The panel decides WHEN to fill and in what order; this decides which rows exist,
 * builds the markup for the body, and keeps a record of the title, Summary and body that Undo
 * can safely reverse.
 *
 * Title and Summary are written by `fillText`, never by Part 1's `fillOne`: its title path
 * manages the web address, which an add form leaves alone (a new page has none to lose), and
 * its description path chooses between Summary and the search override, where a new page
 * always fills Summary. The search result title does go through `fillOne('meta_title', …)`,
 * for its token tail (` | [site:name]`); `planDraftFill` shows the same value `valueToFill`
 * will write.
 */

import type { FieldDescriptor } from '../formSchema/types';
import { readValue, writeValue } from '../fieldBinding';
import type { DraftAnswer } from './drafts';
import { fieldFor, findField, titleField, valueToFill } from './suggestionFill';

/** A draft that is ready to fill in. */
export type ReadyDraft = Extract<DraftAnswer, { status: 'ready' }>;

export type DraftRowKind = 'title' | 'body' | 'summary' | 'meta_title' | 'profiles';

/**
 * One row of the plan. `available: false` hides the row. A row that is available and carries
 * a `note` is shown with it: for Summary the note says why it will not be filled (and the row
 * is never ticked), and for Related Profiles it is a caution only.
 */
export type DraftRow = {
  kind: DraftRowKind;
  label: string;
  preview: string;
  available: boolean;
  note: string | null;
};

/** The machine names of the add-form fields a draft fills besides Title and the search title. */
export const DRAFT_FIELDS = {
  body: 'body[und][0][value]',
  summary: 'field_summary[und][0][value]',
  profiles: 'field_cola_cups_profiles[und][0][target_id]',
} as const;

/** The most Drupal's Summary takes; a longer draft summary is not filled. */
export const SUMMARY_LIMIT = 380;

const COULD_NOT_CHECK_DOCTORS = "Varys couldn't check the quoted doctors.";

const hasText = (value: string | null): value is string => value !== null && value.trim() !== '';

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** What the body row says will be written: the Overview box if there is one, then the draft. */
function bodyPreview(draft: ReadyDraft): string {
  const { words, headings, lists, links } = draft.counts;
  const counts = [plural(words, 'word'), plural(headings, 'heading'), plural(lists, 'list'), plural(links, 'Varys link')]
    .join(' · ');
  const points = draft.overview_bullets.length;
  return points > 0
    ? `Overview box (${plural(points, 'point')}), then the draft: ${counts}`
    : `The draft: ${counts}`;
}

/**
 * The rows a draft offers on this form, always in the order Title, Body, Summary, Search
 * result title, Related Profiles. A row is unavailable (hidden) when the form lacks its field
 * or the draft has nothing for it.
 *
 * Title is filled only from `draft.title`, the title the person confirmed. When there is none
 * the row is not offered: the draft's `label` is a list entry, often a file name, and is never
 * written into the form. The Summary row is the one case of an available row that must not be
 * filled: over `SUMMARY_LIMIT` it carries a note saying so.
 */
export function planDraftFill(draft: ReadyDraft, fields: FieldDescriptor[]): DraftRow[] {
  const title = draft.title ?? '';
  const summary = draft.summary ?? '';
  const metaTitle = draft.meta_title ?? '';
  const names = draft.doctors === null ? '' : draft.doctors.map(d => d.name).join(', ');

  const summaryNote = summary.length > SUMMARY_LIMIT
    ? `Too long for Summary (${summary.length} characters; the limit is ${SUMMARY_LIMIT}).`
    : null;

  return [
    {
      kind: 'title',
      label: 'Title',
      preview: title,
      available: titleField(fields) !== undefined && hasText(draft.title),
      note: null,
    },
    {
      kind: 'body',
      label: 'Body',
      preview: bodyPreview(draft),
      available: findField(fields, DRAFT_FIELDS.body) !== undefined
        && (hasText(draft.body_html) || draft.overview_bullets.length > 0),
      note: null,
    },
    {
      kind: 'summary',
      label: 'Summary',
      preview: summary,
      available: findField(fields, DRAFT_FIELDS.summary) !== undefined && hasText(draft.summary),
      note: summaryNote,
    },
    {
      kind: 'meta_title',
      label: 'Search result title',
      preview: hasText(draft.meta_title) ? valueToFill('meta_title', metaTitle, fields) : '',
      available: fieldFor('meta_title', fields) !== undefined && hasText(draft.meta_title),
      note: null,
    },
    {
      kind: 'profiles',
      label: 'Related Profiles',
      preview: names,
      available: findField(fields, DRAFT_FIELDS.profiles) !== undefined
        && (draft.doctors === null || draft.doctors.length > 0),
      note: draft.doctors === null ? COULD_NOT_CHECK_DOCTORS : null,
    },
  ];
}

// ------------------------------------------------------------------ the Overview box

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, c => ESCAPES[c]);

/** The first number a callout id may take, and so the one every box starts from. */
const FIRST_CALLOUT_ID = 1000;

/** The numbers already used as `ck-callout--N` by an `id` or an `aria-labelledby` in the markup. */
function usedCalloutIds(html: string): Set<number> {
  const used = new Set<number>();
  for (const attr of html.matchAll(/\b(?:id|aria-labelledby)\s*=\s*(["'])(.*?)\1/gis)) {
    // aria-labelledby may name several ids, separated by spaces.
    for (const token of attr[2].split(/\s+/)) {
      const n = /^ck-callout--(\d+)$/.exec(token);
      if (n) used.add(Number(n[1]));
    }
  }
  return used;
}

/**
 * The Overview box for a page's opening bullets, or '' when there are none.
 *
 * With `callout` it is the site's own callout (a sky-blue aside whose title is wired to it by
 * an id), numbered with the smallest integer from 1000 that no `ck-callout--N` id in
 * `existingBodyHtml` already uses, so the box never collides with one the page has. Without
 * it, a plain heading and list, for an editor whose content filter would strip the aside.
 * Bullets are text: every one is escaped.
 */
export function overviewBoxHtml(bullets: string[], existingBodyHtml: string, callout: boolean): string {
  if (bullets.length === 0) return '';
  const items = bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('');
  if (!callout) return `<h2>Overview</h2><ul>${items}</ul>`;

  const used = usedCalloutIds(existingBodyHtml);
  let n = FIRST_CALLOUT_ID;
  while (used.has(n)) n++;
  return `<aside aria-labelledby="ck-callout--${n}" class="ck-callout ck-callout--background-sky ck-callout--center">`
    + `<h2 class="ck-callout__title" id="ck-callout--${n}">Overview</h2>`
    + `<div class="ck-callout__content"><ul>${items}</ul></div></aside>`;
}

/** What goes in the body: the Overview box, if the draft has bullets, then the draft itself. */
export function bodyToFill(draft: ReadyDraft, callout: boolean): string {
  return overviewBoxHtml(draft.overview_bullets, draft.body_html, callout) + draft.body_html;
}

// ------------------------------------------------------------------ title and Summary

/** What Undo needs to put a Title or Summary fill back exactly as it was. */
export type TextFillRecord = {
  machineName: string;
  previous: string;
  /** What the field held right after the fill, as the control took it. */
  filled: string;
};

/**
 * Writes `value` into one text field and remembers what was there. Used for Title and
 * Summary, and for nothing else: it touches no other control, so on an add form the web
 * address and "Generate automatic URL alias" are left exactly as they are.
 *
 * Returns null when the page refused the write, and then nothing was written.
 */
export function fillText(field: FieldDescriptor, value: string): TextFillRecord | null {
  const previous = String(readValue(field));
  if (!writeValue(field, value)) return null;
  return { machineName: field.machineName, previous, filled: String(readValue(field)) };
}

/** True only while the field still holds exactly what was filled: not after anyone edited it. */
export function canUndoText(record: TextFillRecord, fields: FieldDescriptor[]): boolean {
  const field = findField(fields, record.machineName);
  return field !== undefined && String(readValue(field)) === record.filled;
}

/**
 * Puts the old text back. Does nothing and returns false when Undo is no longer safe (see
 * `canUndoText`), so it can never overwrite what the person typed since.
 */
export function undoText(record: TextFillRecord, fields: FieldDescriptor[]): boolean {
  if (!canUndoText(record, fields)) return false;
  const field = findField(fields, record.machineName) as FieldDescriptor;
  return writeValue(field, record.previous);
}

// ------------------------------------------------------------------ the body

/**
 * What Undo needs for the body. The editor holds the body, not the textarea, and CKEditor
 * rewrites markup it is given, so `filled` is what the editor reports AFTER the fill, not
 * what was sent to it.
 */
export type BodyFillRecord = { previous: string; filled: string };

/** True only while the editor still holds exactly what the fill left in it (`current`). */
export function canUndoBody(record: BodyFillRecord, current: string): boolean {
  return current === record.filled;
}
