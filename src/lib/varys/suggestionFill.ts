/**
 * Filling a Varys suggestion into the Drupal form, and taking it back.
 *
 * Pure logic with no panel and no extension API, so it can be tested against a real form on
 * its own. The panel decides WHEN to fill; this decides WHICH field, writes it, remembers what
 * Undo needs, and keeps the page's web address from changing when the title does. Plain text
 * fields only: the body is never written here.
 */

import type { FieldDescriptor } from '../formSchema/types';
import { liveElements, readValue, writeValue } from '../fieldBinding';
import { markFilled, unmarkFilled } from './filled';

export type FillKind = 'meta_title' | 'meta_description' | 'title';

/** What Undo needs to put a fill back exactly as it was. */
export type FillRecord = {
  kind: FillKind;
  /** The field that was written: for a description, Summary or the override, whichever took it. */
  machineName: string;
  previous: string;
  filled: string;
  /** Filling the title unticked "Generate automatic URL alias"; Undo ticks it again. */
  pathautoWasTicked: boolean;
  /**
   * The alias box before the fill, or null when the form has no alias box. Undo restores it
   * only when the fill unticked pathauto, which is the one case a fill touches the box.
   */
  previousAlias: string | null;
  /**
   * What the alias box held right after the fill, whether the fill wrote it or it was already
   * there; null when the form has no alias box. The box is editable once pathauto is off, so
   * Undo puts it back only while it still holds this: an alias typed since is the person's.
   */
  aliasFilled: string | null;
  /**
   * Filling the title unticked pathauto while the alias box was disabled, so the box was
   * enabled: a disabled input is not submitted, and Drupal would then delete the alias.
   * Undo disables it again. False when pathauto was not unticked or the box was enabled.
   */
  aliasWasDisabled: boolean;
};

const TITLE_FIELD = 'title_field[und][0][value]';
const TITLE_PLAIN = 'title';
const META_TITLE = 'metatags[und][title][value]';
const META_DESCRIPTION = 'metatags[und][description][value]';
const SUMMARY = 'field_summary[und][0][value]';
const PATHAUTO = 'path[pathauto]';
const ALIAS = 'path[alias]';

const SUMMARY_TOKEN = '[node:summary]';
/** A Drupal token: `[node:summary]`, `[site:name]`, `[current-page:title]`. Always type:name. */
const TOKEN = /\[[\w-]+:[^[\]\s]+\]/;

export function findField(fields: FieldDescriptor[], machineName: string): FieldDescriptor | undefined {
  return fields.find(f => f.machineName === machineName);
}

/** The title control: the live sites call it `title_field`, an older form calls it `title`. */
export function titleField(fields: FieldDescriptor[]): FieldDescriptor | undefined {
  return findField(fields, TITLE_FIELD) ?? findField(fields, TITLE_PLAIN);
}

/**
 * Where a suggested description goes.
 *
 * The page's description is the override box when it has text of its own, and otherwise
 * whatever the override follows: the live sites default it to `[node:summary]`, so the
 * description IS the Summary and writing the override would stop it following. An override
 * that is empty, or holds some other token, is written to as the override: that always
 * becomes the description, where Summary does so only if the site's default points there.
 *
 * Null when the form has neither box.
 */
export function descriptionTarget(fields: FieldDescriptor[]): 'summary' | 'override' | null {
  const override = findField(fields, META_DESCRIPTION);
  const summary = findField(fields, SUMMARY);

  if (override) {
    const text = String(readValue(override)).trim();
    if (text !== '' && !TOKEN.test(text)) return 'override';
    if (text === SUMMARY_TOKEN && summary) return 'summary';
    return 'override';
  }
  return summary ? 'summary' : null;
}

/**
 * The field a suggestion of this kind would be written into right now: the one `fillOne`
 * writes, so the panel's "Now" is read from the same place. Undefined when the form has none.
 */
export function fieldFor(kind: FillKind, fields: FieldDescriptor[]): FieldDescriptor | undefined {
  switch (kind) {
    case 'title':
      return titleField(fields);
    case 'meta_title':
      return findField(fields, META_TITLE);
    case 'meta_description': {
      const target = descriptionTarget(fields);
      if (target === 'summary') return findField(fields, SUMMARY);
      return target === 'override' ? findField(fields, META_DESCRIPTION) : undefined;
    }
  }
}

/** What separates a search title from the site's name in Drupal's metatag pattern. */
const TAIL_SEPARATOR = ' | ';

/**
 * The trailing ` | <segment>` of a search title, when that segment holds a token: the
 * metatag module's stock default is `[node:title] | [site:name]`, and its `| [site:name]` is
 * how such a site puts its name on every search result. Empty otherwise. A LITERAL tail is
 * not returned: Varys serves a suggestion without the site's name precisely because a site
 * like that appends its name itself, so keeping a literal one would name it twice.
 */
function tokenTail(current: string): string {
  const text = current.trim();
  const at = text.lastIndexOf(TAIL_SEPARATOR);
  if (at <= 0) return '';
  const tail = text.slice(at);
  return TOKEN.test(tail.slice(TAIL_SEPARATOR.length)) ? tail : '';
}

/**
 * What Use would write for a suggestion of this kind: the suggestion itself, except that a
 * search title keeps the field's token tail after it (see `tokenTail`, ruling R16), so the
 * live title does not lose the site's name. The panel shows this as "Varys suggests", so
 * what is on screen is what Use writes.
 */
export function valueToFill(kind: FillKind, value: string, fields: FieldDescriptor[]): string {
  if (kind !== 'meta_title') return value;
  const field = findField(fields, META_TITLE);
  const tail = field ? tokenTail(String(readValue(field))) : '';
  if (tail === '' || value.trimEnd().endsWith(tail)) return value;
  return value.trimEnd() + tail;
}

export type DescriptionPlacement = 'summary_followed' | 'summary_only' | 'override_over_summary' | 'override_only';

/**
 * Where a suggested description goes, for the panel to say in words: Summary, which the
 * override follows (`summary_followed`); Summary on a form with no override box
 * (`summary_only`); an override holding text of its own on a form that also has Summary,
 * which it overrides (`override_over_summary`); or the override otherwise: empty, holding
 * another token, or on a form without Summary (`override_only`). Null when neither exists.
 */
export function descriptionPlacement(fields: FieldDescriptor[]): DescriptionPlacement | null {
  const override = findField(fields, META_DESCRIPTION);
  switch (descriptionTarget(fields)) {
    case 'summary':
      return override ? 'summary_followed' : 'summary_only';
    case 'override': {
      const text = String(readValue(override!)).trim();
      const own = text !== '' && !TOKEN.test(text);
      return own && findField(fields, SUMMARY) ? 'override_over_summary' : 'override_only';
    }
    default:
      return null;
  }
}

/**
 * The page's current address as an alias the box can hold: percent-decoded, no leading
 * slash. Null when there is nothing usable, which includes `/node/N`: that is where a page
 * with NO alias lives, so writing it into the box would make the page's address `node/N`.
 *
 * Accepts a path or a full web address (`publicUrlFor` gives the latter).
 */
function usableAlias(currentAlias: string | null | undefined): string | null {
  if (!currentAlias) return null;
  let alias = currentAlias.trim();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(alias)) {
    try {
      alias = new URL(alias).pathname;
    } catch {
      return null;
    }
  }
  try {
    alias = decodeURIComponent(alias);
  } catch {
    // A stray "%" that is not an escape: the raw text is the best reading there is.
  }

  alias = alias.replace(/^\/+/, '').trim();
  if (alias === '' || /^node\/\d+\/?$/.test(alias)) return null;
  return alias;
}

const isBlank = (value: string | null): boolean => (value ?? '').trim() === '';

/**
 * True when filling the title would lose the page's address: pathauto is ticked, the alias
 * box is empty, and there is no usable `currentAlias` to put in it. `fillOne` refuses in
 * exactly this case, so the panel can ask first and disable the title's Use with a reason.
 *
 * A form with no alias box, or with pathauto off or absent, is not this case: there is
 * nothing for unticking to lose.
 */
export function titleFillWouldLoseAddress(
  fields: FieldDescriptor[],
  opts: { currentAlias?: string | null } = {},
): boolean {
  const pathauto = findField(fields, PATHAUTO);
  if (!pathauto || readValue(pathauto) !== true) return false;

  const alias = findField(fields, ALIAS);
  if (!alias || !isBlank(String(readValue(alias)))) return false;

  return usableAlias(opts.currentAlias) === null;
}

/** The alias box's control as it is in the page right now (Drupal's AJAX can replace it). */
function aliasInput(alias: FieldDescriptor): HTMLInputElement | undefined {
  return liveElements(alias).find(el => el.isConnected) as HTMLInputElement | undefined;
}

/**
 * Writes `value` into the field a suggestion of this kind belongs in: for a search title,
 * with the field's token tail kept after it (`valueToFill`).
 *
 * Returns what Undo needs, or null when nothing was filled: the form has no such field, the
 * title fill was refused (below), or the page refused a write (whatever was written is put
 * back). A null leaves the form exactly as it was and marks nothing.
 *
 * Filling the TITLE also unticks "Generate automatic URL alias": with it ticked, Drupal
 * rebuilds the address from the new title on save, which changes the page's address and
 * breaks every link to it. Unticking keeps the address, but Drupal 7 then saves the alias
 * box as it stands, and an EMPTY box deletes the alias, moving the page to /node/N. The
 * box can be empty while pathauto is ticked (pathauto owns the alias, and the form need not
 * show it), so the page's current address, from `opts.currentAlias`, goes in first. The box
 * is enabled if it was disabled, whether or not it needed the address: a disabled input is
 * not submitted. With no usable address the fill is REFUSED rather than half-applied (see
 * `titleFillWouldLoseAddress`).
 */
export function fillOne(
  kind: FillKind,
  value: string,
  fields: FieldDescriptor[],
  opts: { currentAlias?: string | null } = {},
): FillRecord | null {
  const field = fieldFor(kind, fields);
  if (!field) return null;
  if (kind === 'title' && titleFillWouldLoseAddress(fields, opts)) return null;

  const alias = findField(fields, ALIAS);
  const previous = String(readValue(field));
  // Read before anything is written, in case the page reacts to the title or the untick.
  const previousAlias = alias ? String(readValue(alias)) : null;
  if (!writeValue(field, valueToFill(kind, value, fields))) return null;

  const record: FillRecord = {
    kind,
    machineName: field.machineName,
    previous,
    // What the field holds now, which is what Undo is offered on: the suggestion with any
    // token tail kept (valueToFill), as the control took it.
    filled: String(readValue(field)),
    pathautoWasTicked: false,
    previousAlias,
    aliasFilled: null,
    aliasWasDisabled: false,
  };

  if (kind === 'title') {
    const pathauto = findField(fields, PATHAUTO);
    if (pathauto && readValue(pathauto) === true) {
      if (!writeValue(pathauto, false)) {
        writeValue(field, previous);
        return null;
      }
      record.pathautoWasTicked = true;

      if (alias) {
        // Whatever the box holds, it must be submitted: Drupal's own script is expected to
        // enable it when pathauto is unticked, but one that does not would drop the alias.
        const input = aliasInput(alias);
        if (input?.disabled === true) {
          input.disabled = false;
          record.aliasWasDisabled = true;
        }

        if (isBlank(previousAlias)) {
          // Not null: the refusal above covers every way this can be empty-handed.
          const keep = usableAlias(opts.currentAlias) as string;
          const written = writeValue(alias, keep);
          record.aliasFilled = String(readValue(alias));
          if (!written || isBlank(record.aliasFilled)) {
            // The address could not be kept, so nothing is kept of the fill.
            restore(record, fields);
            return null;
          }
        }
      }
    }
  }

  record.aliasFilled = alias ? String(readValue(alias)) : null;
  markFilled(kind);
  return record;
}

/** True only while the field still holds exactly what was filled: not after anyone edited it. */
export function canUndo(record: FillRecord, fields: FieldDescriptor[]): boolean {
  const field = findField(fields, record.machineName);
  return field !== undefined && String(readValue(field)) === record.filled;
}

/**
 * Puts a fill's changes back. The title always goes back. The alias box and the pathauto
 * tick go back together, and only while the box still holds what the fill left in it.
 *
 * Once the person has typed another alias, that alias is theirs, and so is the unticked
 * pathauto it depends on: in Drupal 7 a ticked pathauto regenerates the alias on save and
 * ignores the box, so re-ticking it would throw their typing away later instead of now. Both
 * are left exactly as they were left. Shared by Undo and by a fill that had to give up
 * part-way (where the box still holds what was just written, so everything goes back).
 */
function restore(record: FillRecord, fields: FieldDescriptor[]): boolean {
  const field = findField(fields, record.machineName);
  if (!field || !writeValue(field, record.previous)) return false;
  if (!record.pathautoWasTicked) return true;

  let ok = true;
  const alias = findField(fields, ALIAS);
  if (alias) {
    if (String(readValue(alias)) !== record.aliasFilled) return true;

    if (record.previousAlias !== null && String(readValue(alias)) !== record.previousAlias) {
      ok = writeValue(alias, record.previousAlias) && ok;
    }
    if (record.aliasWasDisabled) {
      const input = aliasInput(alias);
      if (input) input.disabled = true;
      else ok = false;
    }
  }
  const pathauto = findField(fields, PATHAUTO);
  return (pathauto ? writeValue(pathauto, true) : false) && ok;
}

/**
 * Puts the fill back: the old text, and (while the alias box still holds what the fill left
 * there) the alias box with whether it was disabled, and the pathauto tick the fill removed.
 * Does nothing and returns false when Undo is no longer safe (see `canUndo`), so it can never
 * overwrite the title typed since; an alias typed since is left alone too (see `restore`).
 */
export function undoFill(record: FillRecord, fields: FieldDescriptor[]): boolean {
  if (!canUndo(record, fields)) return false;
  const ok = restore(record, fields);
  // Marked as filled only while it is; a restore that failed on the title leaves it so.
  const field = findField(fields, record.machineName);
  if (field && String(readValue(field)) === record.previous) unmarkFilled(record.kind);
  return ok;
}

/** Ticks "Generate automatic URL alias" again, for "Let the address change instead". */
export function letAddressChange(fields: FieldDescriptor[]): void {
  const pathauto = findField(fields, PATHAUTO);
  if (pathauto) writeValue(pathauto, true);
}

// ------------------------------------------------------- carried through a re-render (R18)

/**
 * The panel's live fills, kept by the worker with the form as it first opened (`OpenedForm`
 * in submissions.ts) while the tab stays on that form. Drupal's Preview and a save it rejects
 * both re-render the same form with what was submitted, so the fills are still in the form;
 * this lets the panel on the re-render still offer their Undo, the keep-address note and the
 * "filled from Varys" marks. A save that goes through, or leaving the form, drops it.
 */
export interface CarriedFills {
  records: FillRecord[];
  /** The panel was showing "Using this title keeps the current web address." */
  addressKept: boolean;
  /** A heading was inserted from the panel. */
  headings: boolean;
}

/** What the panel on a re-render starts with. */
export interface AdoptedFills {
  records: Partial<Record<FillKind, FillRecord>>;
  addressKept: boolean;
  headings: boolean;
}

const KINDS: readonly FillKind[] = ['meta_title', 'meta_description', 'title'];
const isStringOrNull = (v: unknown) => v === null || typeof v === 'string';

/**
 * Whether a stored value is a FillRecord. It comes back from the worker's session storage,
 * which can outlive the version of the extension that wrote it, so it is checked before it
 * is trusted with Undo.
 */
function isFillRecord(v: unknown): v is FillRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return KINDS.includes(r.kind as FillKind) && typeof r.machineName === 'string'
    && typeof r.previous === 'string' && typeof r.filled === 'string'
    && typeof r.pathautoWasTicked === 'boolean' && typeof r.aliasWasDisabled === 'boolean'
    && isStringOrNull(r.previousAlias) && isStringOrNull(r.aliasFilled);
}

/**
 * Takes up the fills carried from before a re-render of this same form.
 *
 * A record is adopted only while its field still holds exactly what was filled (`canUndo`):
 * anything else in the field is the person's, or the form is not the one the fill was made
 * in. Each adopted record's field is marked filled again; `headings` is marked again when it
 * had been. The keep-address note comes back only while pathauto is still off, since that is
 * what it describes. Anything that is not a carried record adopts nothing.
 */
export function adoptCarriedFills(carried: unknown, fields: FieldDescriptor[]): AdoptedFills {
  const adopted: AdoptedFills = { records: {}, addressKept: false, headings: false };
  if (typeof carried !== 'object' || carried === null) return adopted;
  const c = carried as Record<string, unknown>;
  if (!Array.isArray(c.records) || typeof c.addressKept !== 'boolean' || typeof c.headings !== 'boolean') {
    return adopted;
  }

  for (const record of c.records) {
    if (!isFillRecord(record) || adopted.records[record.kind] || !canUndo(record, fields)) continue;
    adopted.records[record.kind] = record;
    markFilled(record.kind);
  }

  const pathauto = findField(fields, PATHAUTO);
  adopted.addressKept = c.addressKept && pathauto !== undefined && readValue(pathauto) === false;
  if (c.headings) {
    adopted.headings = true;
    markFilled('headings');
  }
  return adopted;
}
