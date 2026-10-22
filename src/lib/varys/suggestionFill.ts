/**
 * Filling a Varys suggestion into the Drupal form, and taking it back.
 *
 * Pure logic with no panel and no extension API, so it can be tested against a real form on
 * its own. The panel decides WHEN to fill; this decides WHICH field, writes it, remembers what
 * Undo needs, and keeps the page's web address from changing when the title does. Plain text
 * fields only: the body is never written here.
 */

import type { FieldDescriptor } from '../formSchema/types';
import { readValue, writeValue } from '../fieldBinding';
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
   * The title was filled with pathauto unticked, but the alias box holds nothing and no
   * address was available to put in it. Saving like that deletes the page's alias in
   * Drupal 7, so the panel must not leave the title filled in that state.
   */
  aliasMissing: boolean;
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

function fieldFor(kind: FillKind, fields: FieldDescriptor[]): FieldDescriptor | undefined {
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

/**
 * Writes `value` into the field a suggestion of this kind belongs in.
 *
 * Returns what Undo needs, or null when nothing was filled: the form has no such field, or
 * the page refused a write (in which case whatever was written is put back).
 *
 * Filling the TITLE also unticks "Generate automatic URL alias": with it ticked, Drupal
 * rebuilds the address from the new title on save, which changes the page's address and
 * breaks every link to it. Unticking keeps the address, but Drupal 7 then saves the alias
 * box as it stands, and an EMPTY box deletes the alias, moving the page to /node/N. The
 * box can be empty while pathauto is ticked (pathauto owns the alias, and the form need not
 * show it), so the page's current address, from `opts.currentAlias`, goes in first. With no
 * usable address the title is still filled and pathauto still unticked, and `aliasMissing`
 * says the address is not safe.
 */
export function fillOne(
  kind: FillKind,
  value: string,
  fields: FieldDescriptor[],
  opts: { currentAlias?: string | null } = {},
): FillRecord | null {
  const field = fieldFor(kind, fields);
  if (!field) return null;

  const alias = findField(fields, ALIAS);
  const previous = String(readValue(field));
  // Read before anything is written, in case the page reacts to the title or the untick.
  const previousAlias = alias ? String(readValue(alias)) : null;
  if (!writeValue(field, value)) return null;

  const record: FillRecord = {
    kind,
    machineName: field.machineName,
    previous,
    filled: value,
    pathautoWasTicked: false,
    previousAlias,
    aliasMissing: false,
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
        if ((previousAlias ?? '').trim() === '') {
          const keep = usableAlias(opts.currentAlias);
          if (keep !== null) writeValue(alias, keep);
        }
        record.aliasMissing = String(readValue(alias)).trim() === '';
      } else {
        record.aliasMissing = true;
      }
    }
  }

  markFilled(kind);
  return record;
}

/** True only while the field still holds exactly what was filled: not after anyone edited it. */
export function canUndo(record: FillRecord, fields: FieldDescriptor[]): boolean {
  const field = findField(fields, record.machineName);
  return field !== undefined && String(readValue(field)) === record.filled;
}

/**
 * Puts the fill back: the old text, the alias box, and the pathauto tick if the fill
 * removed it. Does nothing and returns false when Undo is no longer safe (see `canUndo`),
 * so it can never overwrite something typed since.
 */
export function undoFill(record: FillRecord, fields: FieldDescriptor[]): boolean {
  const field = findField(fields, record.machineName);
  if (!field || !canUndo(record, fields)) return false;
  if (!writeValue(field, record.previous)) return false;

  let ok = true;
  if (record.pathautoWasTicked) {
    const alias = findField(fields, ALIAS);
    if (alias && record.previousAlias !== null && String(readValue(alias)) !== record.previousAlias) {
      ok = writeValue(alias, record.previousAlias) && ok;
    }
    const pathauto = findField(fields, PATHAUTO);
    ok = (pathauto ? writeValue(pathauto, true) : false) && ok;
  }

  unmarkFilled(record.kind);
  return ok;
}

/** Ticks "Generate automatic URL alias" again, for "Let the address change instead". */
export function letAddressChange(fields: FieldDescriptor[]): void {
  const pathauto = findField(fields, PATHAUTO);
  if (pathauto) writeValue(pathauto, true);
}
