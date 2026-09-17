import { FormSchema, FieldDescriptor } from '../formSchema';
import { readValue, syncRichEditorsToDom } from '../fieldBinding';
import { findTarget } from '../import/targets';
import { denyReason } from './denyList';
import { optionLabelsFor } from './values';
import { describeMediaRefs } from './media';
import {
  CapturedField, CapturedParagraphField, NodeSnapshot, SNAPSHOT_VERSION,
} from './types';

/**
 * Lifts the node form currently on screen into a NodeSnapshot.
 *
 * Reads only. Nothing is written, nothing is sent anywhere, and the source form is left
 * exactly as it was found.
 */

/** A Paragraphs widget found on the form, and the bundles it can build. */
export interface ParagraphWidget {
  baseName: string;
  label: string;
  bundles: { value: string; label: string }[];
  /** Deltas present on THIS form, ascending. */
  deltas: number[];
  /** The add-more bundle chooser. */
  typeSelect: HTMLSelectElement;
}

/** `field_page_paragraphs` -> "Page Paragraphs", when no label can be read. */
function prettify(baseName: string): string {
  return baseName
    .replace(/^field_/, '')
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Finds the Paragraphs widgets on a form.
 *
 * Anchored on `select.field-add-more-type`, which is the bundle chooser Drupal renders
 * for every Paragraphs field — verified in the captured Page and Landing forms, where it
 * is named `field_page_paragraphs_add_more_type` and offers eleven bundles. The field's
 * own base name is that name with the suffix removed.
 *
 * Deltas are counted from control NAMES rather than from subform markup. The markup of a
 * populated subform has not been captured yet, and counting `[und][N]` prefixes needs no
 * knowledge of it — so this reports a truthful item count without guessing at a
 * structure. See paragraphs.ts for the rebuild, which does need that structure.
 */
export function findParagraphWidgets(form: HTMLFormElement): ParagraphWidget[] {
  const selects = Array.from(
    form.querySelectorAll<HTMLSelectElement>('select.field-add-more-type')
  );

  const names = Array.from(form.querySelectorAll<HTMLElement>('input, select, textarea'))
    .map(el => (el as HTMLInputElement).name || '')
    .filter(Boolean);

  return selects.map(select => {
    const baseName = (select.name || '').replace(/_add_more_type$/, '');

    const host = form.querySelector<HTMLElement>(`#edit-${baseName.replace(/_/g, '-')}`);
    const label = (host?.querySelector(':scope > label')?.textContent ?? '').trim();

    const deltas = new Set<number>();
    const prefix = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[und\\]\\[(\\d+)\\]\\[`);
    for (const name of names) {
      const match = name.match(prefix);
      if (match) deltas.add(Number(match[1]));
    }

    return {
      baseName,
      label: label || prettify(baseName),
      bundles: Array.from(select.options)
        .map(o => ({ value: o.value, label: o.text.trim() }))
        .filter(o => o.value && o.value !== '_none'),
      deltas: [...deltas].sort((a, b) => a - b),
      typeSelect: select,
    };
  }).filter(widget => widget.baseName);
}

/** True when this field is a control inside one of the given Paragraphs widgets. */
function belongsToParagraph(field: FieldDescriptor, bases: string[]): boolean {
  return bases.some(base =>
    field.machineName.startsWith(`${base}[`) || field.machineName.startsWith(`${base}_add_more`));
}

function captureField(field: FieldDescriptor): CapturedField {
  const value = readValue(field);
  return {
    machineName: field.machineName,
    baseName: field.baseName,
    label: field.label,
    kind: field.kind,
    section: field.section,
    required: field.required,
    multiValue: field.multiValue,
    value,
    optionLabels: optionLabelsFor(field, value),
  };
}

/** True when a captured value holds nothing worth carrying across. */
function isEmpty(captured: CapturedField): boolean {
  const { value } = captured;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'boolean') return value === false;
  return String(value).trim() === '';
}

export async function captureNode(
  schema: FormSchema,
  location: Pick<Location, 'href' | 'origin'> = window.location
): Promise<NodeSnapshot> {
  /**
   * Before anything is read, not after.
   *
   * CKEditor holds the body in its own instance and only writes it back to the textarea
   * on submit. Reading the DOM first captures whatever the textarea held when the page
   * loaded — which, on an edit form, is the previously saved revision rather than what
   * is on screen. Every copy of a body would be subtly stale and nothing would say so.
   */
  await syncRichEditorsToDom();

  const widgets = findParagraphWidgets(schema.form);
  const paragraphBases = widgets.map(w => w.baseName);

  const fields: CapturedField[] = [];
  const omitted: { label: string; reason: string }[] = [];
  const seenReasons = new Set<string>();

  const note = (label: string, reason: string) => {
    const key = `${label}::${reason}`;
    if (seenReasons.has(key)) return;
    seenReasons.add(key);
    omitted.push({ label, reason });
  };

  for (const field of schema.fields) {
    if (belongsToParagraph(field, paragraphBases)) continue;   // handled below

    const denied = denyReason(field.machineName);
    if (denied) {
      /**
       * Not captured at all, rather than captured and filtered later.
       *
       * These values sit in chrome.storage.local until someone pastes them, and some of
       * them name a person. Storing an author's username in order to refuse to write it
       * would be keeping data for no purpose.
       */
      note(denied.label, denied.reason);
      continue;
    }

    // Images are references, not values — describeMediaRefs handles them below.
    if (field.kind === 'file') continue;

    const captured = captureField(field);
    if (isEmpty(captured)) continue;
    fields.push(captured);
  }

  /**
   * Paragraph items are COUNTED here, not yet captured.
   *
   * The rebuild needs the markup of a populated subform, and no such fixture exists —
   * every serious bug in this project has come from a hand-authored fixture agreeing
   * with broken code, so the structure is not being invented. Until then this reports
   * how many items the source had, which is the difference between a paste that looks
   * complete and one that tells the truth.
   */
  const paragraphs: CapturedParagraphField[] = [];
  for (const widget of widgets) {
    if (widget.deltas.length === 0) continue;
    paragraphs.push({ baseName: widget.baseName, label: widget.label, items: [] });
    note(
      widget.label,
      `${widget.deltas.length} content item${widget.deltas.length === 1 ? '' : 's'} on the source page. `
      + 'Copying these is not built yet, so they have to be rebuilt by hand for now.'
    );
  }

  const media = describeMediaRefs(schema.fields, location.href);

  const titleField = findTarget(schema, 'title');
  const title = titleField ? String(readValue(titleField)).trim() : '';

  return {
    version: SNAPSHOT_VERSION,
    sourceUrl: location.href,
    sourceOrigin: location.origin,
    contentType: schema.contentType,
    title,
    capturedAt: Date.now(),
    fields,
    paragraphs,
    media,
    omitted,
  };
}
