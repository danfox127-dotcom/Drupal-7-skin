import React from 'react';
import { discoverSchema, FieldDescriptor, isAddableParagraphsWidget } from '../lib/formSchema';
import { injectComponent } from './inject';
import { FieldControl } from '../components/editor/FieldControl';
import { DoctorBatchAdder } from '../components/editor/DoctorBatchAdder';

/**
 * Enhances the native List form in place — no relocation, no hidden form, nothing that
 * competes with the (off-by-default, unvalidated) Two-Pane Node Editor. Every native
 * control stays exactly where Drupal put it and still submits normally; this only adds
 * a nicer front end beside two specific pain points:
 *
 *   - "Filtered Profiles" renders each choice as a plain `<select multiple>`, a four-row
 *     window over as many as 190 options that only ctrl-click can operate. Replaced in
 *     place with the same searchable checklist FieldControl already renders for kind
 *     'multiSelect' — reading and writing the SAME native select, so nothing about what
 *     Drupal submits changes.
 *   - "Individual Profiles" adds one profile at a time through Drupal's own "Add another
 *     item" cycle. A batch adder sits above the table so several can be queued at once,
 *     each checked against this site before a row is created.
 *
 * Scoped to the List content type by requiring `field_list_type[und]` on the form, and
 * to the "Individual Profiles" table specifically by requiring it sit inside a Paragraphs
 * widget that offers no way to add ANOTHER paragraph item — the same real-markup signal
 * that keeps List's fixed filter-criteria paragraph out of the generic Paragraphs
 * capture/rebuild pipeline (see isAddableParagraphsWidget). That is what tells this apart
 * from og_group_ref, which is also a multi-value autocomplete but sits at the form root
 * and already works fine one entry at a time.
 *
 * The filter fields do not exist until List Type and Display have been chosen and
 * Drupal's AJAX has rendered them — so this re-scans on every form mutation rather than
 * running once at page load.
 */

const ENHANCED_ATTR = 'data-d7-list-enhanced';

function alreadyEnhanced(el: Element): boolean {
  return el.hasAttribute(ENHANCED_ATTR);
}

function markEnhanced(el: Element): void {
  el.setAttribute(ENHANCED_ATTR, 'true');
}

function enhanceMultiSelect(field: FieldDescriptor): void {
  const el = field.elements[0] as HTMLSelectElement | undefined;
  if (!el || alreadyEnhanced(el)) return;
  markEnhanced(el);

  // The native select stays in the DOM — still submitted — just visually replaced.
  el.style.display = 'none';
  injectComponent(el, <FieldControl field={field} dense />, 'before');
}

/** True when this field is a leaf inside List's fixed, un-addable filter-criteria item. */
export function isFixedConfigParagraphField(field: FieldDescriptor): boolean {
  const el = field.elements[0];
  const ancestor = el?.closest('.field-widget-paragraphs-embed');
  return Boolean(ancestor) && !isAddableParagraphsWidget(el as Element);
}

function enhanceProfilesTable(field: FieldDescriptor): void {
  const el = field.elements[0];
  const widget = el?.closest<HTMLElement>('[class*="field-widget-"]');
  if (!widget || alreadyEnhanced(widget)) return;
  markEnhanced(widget);

  injectComponent(widget, <DoctorBatchAdder anyElement={el as HTMLElement} fieldLabel={field.label} />, 'before');
}

function scan(): void {
  const schema = discoverSchema();
  if (!schema) return;
  if (!schema.fields.some(f => f.machineName === 'field_list_type[und]')) return;

  for (const field of schema.fields) {
    if (field.kind === 'multiSelect') {
      enhanceMultiSelect(field);
    } else if (field.kind === 'autocomplete' && field.multiValue && isFixedConfigParagraphField(field)) {
      enhanceProfilesTable(field);
    }
  }
}

/**
 * Call once during content-script init. A no-op on any form that is not a List, or
 * before Drupal has rendered anything to enhance yet — the observer below re-scans as
 * soon as it does.
 */
export function enhanceListForm(): void {
  scan();

  const form = document.querySelector<HTMLFormElement>('form.node-form, form[id$="-node-form"]');
  if (!form) return;

  // Debounced: Drupal's AJAX touches many nodes in one go, and re-scanning after every
  // individual mutation would run dozens of times for one List Type change.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; scan(); }, 100);
  });
  observer.observe(form, { childList: true, subtree: true });
}
