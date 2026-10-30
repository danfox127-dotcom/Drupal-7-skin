import { FormSchema, FieldDescriptor } from '../formSchema';
import { readValue, syncRichEditorsToDom } from '../fieldBinding';
import { findTarget } from '../import/targets';
import { denyReason } from './denyList';
import { optionLabelsFor } from './values';
import { describeMediaRefs } from './media';
import { allItems, captureParagraphItems } from './paragraphs';
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

function captureField(field: FieldDescriptor, machineName = field.machineName): CapturedField {
  const value = readValue(field);
  return {
    machineName,
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

/**
 * Images inside structured content items — a People List's portraits — as file fields.
 *
 * Read off the page rather than from the walked fields. The walker files everything in a
 * Paragraphs widget under `paragraphs`, and a widget that already HOLDS a photo has no
 * text control at all — just the preview, a Remove button and a hidden fid — so it walks
 * as nothing. A pasted People List lost every photo with nothing saying so. One per Media
 * widget, named for the item it belongs to, because "Image" eight times over says nothing
 * about which person goes with which file.
 */
function nestedImageFields(form: HTMLFormElement): FieldDescriptor[] {
  return Array.from(form.querySelectorAll<HTMLElement>('.field-widget-paragraphs-embed .field-widget-media-generic'))
    .map(widget => {
      const control = widget.querySelector<HTMLElement>('input[name$="[fid]"], input, select') ?? widget;
      const label = (widget.querySelector('label')?.textContent ?? 'Image').replace(/\*/g, '').trim() || 'Image';
      const row = widget.closest('tr[class*="paragraphs-item-type-"], .paragraphs-item');
      const owner = Array.from(row?.querySelectorAll<HTMLInputElement>('input.form-text:not(.form-autocomplete)') ?? [])
        .filter(input => !input.closest('.field-widget-media-generic'))
        .map(input => input.value.trim())
        .find(Boolean);
      const name = (control as HTMLInputElement).name ?? '';
      return {
        machineName: name || widget.id,
        baseName: widget.id || name,
        label: owner ? `${label} — ${owner}` : label,
        kind: 'file',
        required: false,
        help: '',
        section: 'multimedia',
        matchedBy: 'nested media widget',
        group: null,
        groupPath: [],
        elements: [control],
        multiValue: false,
        advanced: false,
      } as FieldDescriptor;
    });
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
    // Handled by captureParagraphItems below, as items rather than flat fields.
    if (belongsToParagraph(field, paragraphBases)) continue;

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

    // Images are references, not values — describeMediaRefs handles them below. Including
    // the Media controls inside content items, whose names do not mark them as nested.
    if (field.kind === 'file' || field.elements[0]?.closest('.field-widget-media-generic')) continue;

    const captured = captureField(field);
    if (isEmpty(captured)) continue;
    fields.push(captured);
  }

  /**
   * Structured content items.
   *
   * Captured generically: an item's subform is just fields, so whatever fields it has
   * are read and stored with names made RELATIVE to the item — no per-type code. That
   * covers `text` and `faq`, the two that get real use and both backed by an HTML
   * editor, without either being a special case.
   *
   * An item whose type could not be determined is still captured. It cannot be
   * recreated, but its values can be shown, and dropping it here would mean the review
   * could not even say what was lost.
   */
  const paragraphs: CapturedParagraphField[] = [];
  for (const widget of widgets) {
    if (widget.deltas.length === 0) continue;

    /**
     * The same deny list as the top-level fields, judged on the name the paste will write.
     * Without it an item carried its source `[format]` across sites (security scan
     * 2026-10-30, F1).
     */
    const items = captureParagraphItems(schema, widget, (field, relative) => {
      const denied = denyReason(relative);
      if (denied) {
        note(denied.label, denied.reason);
        return null;
      }
      return captureField(field, relative);
    });

    paragraphs.push({ baseName: widget.baseName, label: widget.label, items });

    const every = allItems(items);
    const unknown = every.filter(item => !item.bundle);
    if (unknown.length) {
      note(
        widget.label,
        `${unknown.length} of ${every.length} content item${every.length === 1 ? '' : 's'} `
        + 'could not be identified by type, so they cannot be recreated automatically. '
        + 'Their values are shown so you can rebuild them.'
      );
    }
  }

  const media = [
    ...describeMediaRefs(schema.fields, location.href),
    ...describeMediaRefs(nestedImageFields(schema.form), location.href),
  ];

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
