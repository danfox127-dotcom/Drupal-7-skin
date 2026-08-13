import {
  FieldDescriptor, FieldKind, FieldOption, FormSchema, VerticalTab,
} from './types';
import { assignSection, isAdvancedField } from './sectionRules';

/**
 * Reads a rendered Drupal 7 node form into a normalized schema.
 *
 * Everything here is defensive: a field missing a label, an input with no name, a
 * fieldset with no legend, and unknown widget types all degrade rather than throw,
 * because the live markup has not been captured yet and the shapes below are
 * inferred from Drupal 7 core plus the handoff's reference screenshots.
 */

const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Strips Drupal's required marker and trailing colon from a label. */
function cleanLabel(label: Element | null): string {
  if (!label) return '';
  const clone = label.cloneNode(true) as HTMLElement;
  // Drupal renders <span class="form-required">*</span> inside the label.
  clone.querySelectorAll('.form-required, .field-required, .marker').forEach(el => el.remove());
  return text(clone).replace(/\s*[:*]\s*$/, '').trim();
}

/**
 * Drupal element names carry language and delta: `field_topics[und][0][value]`.
 * The base name is what rules match against.
 *
 * One special case: `managed_file` widgets are named `files[field_x_und_0]`, so the
 * naive prefix would be `files` for every image field on the form — collapsing
 * Teaser Image and Featured Image into one indistinguishable base. The real field
 * name is inside the brackets.
 */
export function baseNameOf(name: string): string {
  if (!name) return '';

  // files[field_teaser_image_und_0] -> field_teaser_image  (core managed_file)
  // media[field_image_teaser_und_0] -> field_image_teaser   (Media module, which the
  // live site actually uses — it renders a textfield plus a browse button, not an
  // <input type=file>)
  const wrapped = name.match(/^(?:files|media)\[(.+?)\]$/);
  if (wrapped) {
    return wrapped[1].replace(/_und(_\d+)?$/, '').trim();
  }

  const bracket = name.indexOf('[');
  return (bracket === -1 ? name : name.slice(0, bracket)).trim();
}

/** Trailing segments Drupal uses for the parts of one date/time widget. */
const DATE_PART = /\[(month|day|year|hour|minute|second|ampm)\]$/i;

/** True when the wrapper or its control is marked required. */
function isRequired(wrapper: Element, controls: HTMLElement[]): boolean {
  if (wrapper.querySelector('.form-required, .field-required')) return true;
  return controls.some(c => (c as HTMLInputElement).required === true
    || c.getAttribute('aria-required') === 'true');
}

/** Drupal puts help text in `.description`, sometimes outside the form-item. */
function helpFor(wrapper: Element): string {
  return text(wrapper.querySelector('.description, .field-suffix .description'));
}

/**
 * Classifies the widget.
 *
 * Autocomplete detection matters: Drupal marks these with `.form-autocomplete`
 * plus a hidden `*-autocomplete` sibling, and the handoff's Related Content and
 * Groups fields are all autocompletes that must not be mistaken for plain text.
 */
function classify(controls: HTMLElement[], wrapper: Element): FieldKind {
  if (controls.length === 0) return 'unknown';

  const first = controls[0];
  const tag = first.tagName;

  if (wrapper.querySelector('.paragraphs-subform, [class*="paragraph-type"]')
    || /paragraph/i.test(first.getAttribute('name') ?? '')) {
    return 'paragraphs';
  }

  if (tag === 'SELECT') {
    // Drupal renders date fields as a cluster of selects inside .container-inline-date
    if (wrapper.closest('.container-inline-date') || wrapper.querySelector('.date-no-float')) {
      return 'date';
    }
    return 'select';
  }

  if (tag === 'TEXTAREA') {
    // CKEditor/BUEditor attach to a textarea; the rich flag is on the wrapper.
    if (wrapper.querySelector('.cke, .ckeditor, .text-format-wrapper, .filter-wrapper')
      || first.classList.contains('text-full')) {
      return 'wysiwyg';
    }
    return 'textarea';
  }

  if (tag === 'INPUT') {
    const input = first as HTMLInputElement;
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();

    /**
     * The Media module renders a reference field as a TEXT input with a browse button,
     * so type=file never appears. Left as text, the overlay would show an editable box
     * over a media reference and invite someone to type into it.
     */
    if (/^media\[/.test(input.name ?? '')
      || wrapper.querySelector('.media-widget, .launcher, a.button-yellow')) {
      return 'file';
    }

    if (type === 'checkbox') {
      return controls.length > 1 ? 'checkboxGroup' : 'checkbox';
    }
    if (type === 'radio') return 'radioGroup';
    if (type === 'file') return 'file';
    if (input.classList.contains('form-autocomplete')
      || wrapper.querySelector('.form-autocomplete')
      || wrapper.querySelector('input.autocomplete')) {
      return 'autocomplete';
    }
    if (type === 'date') return 'date';
    return 'text';
  }

  return 'unknown';
}

/** Options for select / checkbox / radio widgets, with taxonomy depth preserved. */
function readOptions(controls: HTMLElement[], kind: FieldKind, wrapper: Element): FieldOption[] | undefined {
  // A date widget's "options" are month/day/year values — meaningless to the rail,
  // and listing them would look like a choice field.
  if (kind === 'date') return undefined;

  // Keyed on the actual element, not just the semantic kind: a Paragraphs widget is
  // classified as `paragraphs` but is backed by a <select>, and reading options only
  // for kind === 'select' left it with none to render.
  if (kind === 'select' || controls[0]?.tagName === 'SELECT') {
    const select = controls[0] as HTMLSelectElement;
    return Array.from(select.options).map(opt => {
      // Drupal encodes taxonomy depth as leading hyphens in the option label.
      const match = opt.text.match(/^(-+)\s*(.*)$/);
      return {
        value: opt.value,
        label: match ? match[2] : opt.text.trim(),
        depth: match ? match[1].length : 0,
        selected: opt.selected,
      };
    });
  }

  if (kind === 'checkboxGroup' || kind === 'radioGroup') {
    return controls.map(control => {
      const input = control as HTMLInputElement;
      // The label may wrap the input or follow it, and hierarchical taxonomy
      // widgets nest them in <ul>, which is where depth comes from.
      const label = input.closest('label')
        ?? wrapper.querySelector(`label[for="${input.id}"]`)
        ?? input.parentElement?.querySelector('label')
        ?? null;

      let depth = 0;
      let node: Element | null = input.parentElement;
      while (node && node !== wrapper) {
        if (node.tagName === 'UL' || node.tagName === 'OL') depth++;
        node = node.parentElement;
      }

      return {
        value: input.value,
        label: cleanLabel(label) || input.value,
        depth: Math.max(0, depth - 1),
        selected: input.checked,
      };
    });
  }

  return undefined;
}

/**
 * Resolves the label and owning wrapper for a checkbox/radio group.
 *
 * These need separate handling because each option is itself wrapped in a
 * `.form-item` carrying the option's own label. Taking the nearest `.form-item` and
 * asking for "a label" returns "Allergy" — the first Topics term — instead of
 * "Topics". So this walks OUT from the options container and accepts only a direct
 * child label or a legend, never a descendant label.
 */
function labelForGroupWidget(
  first: HTMLElement,
  fallback: HTMLElement
): { label: string; host: HTMLElement } {
  const container = (first.closest(
    '.form-checkboxes, .form-radios, .field-widget, .container-inline-date, .date-no-float'
  ) as HTMLElement | null) ?? fallback;

  let node: HTMLElement | null = container.parentElement;
  // A small cap: the field's own label is one or two levels out. Walking further
  // would reach the field-group tab legend ("Overview") and mislabel the field.
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const direct = node.querySelector(':scope > label');
    if (direct) return { label: cleanLabel(direct), host: node };

    const legend = node.querySelector(':scope > legend');
    if (legend) {
      return {
        label: text(legend.querySelector('.fieldset-legend') ?? legend),
        host: node,
      };
    }

    if (node.tagName === 'FORM') break;
  }

  return { label: '', host: fallback };
}

/**
 * Finds the nearest enclosing group legend — a vertical-tab legend, a field-group
 * tab, or a plain fieldset. Used by the rules table for fields whose own label is
 * ambiguous but whose container is not.
 */
function groupPathOf(wrapper: Element, form: Element): string[] {
  const path: string[] = [];
  let node: Element | null = wrapper.parentElement;

  while (node && node !== form) {
    if (node.tagName === 'FIELDSET' || node.tagName === 'DETAILS') {
      const legend = node.querySelector(':scope > legend');
      const label = text(legend?.querySelector('.fieldset-legend') ?? legend);
      if (label) path.push(label);
    }
    node = node.parentElement;
  }

  // Nearest first, outermost last.
  return path;
}

/**
 * Groups controls into logical fields.
 *
 * A `.form-item` is usually one field, but checkbox and radio groups render as many
 * `.form-item`s inside one `.form-checkboxes` / `.form-radios` container, and a
 * multi-value field wraps its deltas in `table.field-multiple-table`. Collapsing by
 * base name is what turns 36 Topics checkboxes into one field.
 */
function collectFieldGroups(form: HTMLFormElement): Map<string, HTMLElement[]> {
  const controls = Array.from(
    form.querySelectorAll<HTMLElement>('input, select, textarea')
  ).filter(el => {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute('type') ?? '').toLowerCase();
    // Structural and security inputs are not user fields.
    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) return false;
    if (/^(form_build_id|form_token|form_id|op|changed)$/.test(input.name ?? '')) return false;
    /**
     * Multi-value fields render a "Weight for row N" select per row so the rows can be
     * dragged. It is UI plumbing, not content — three of them showed up as fields on the
     * live News form, under Related Content and Groups.
     */
    if (/\[_weight\]$/.test(input.name ?? '')) return false;
    return true;
  });

  const groups = new Map<string, HTMLElement[]>();

  for (const control of controls) {
    const name = (control as HTMLInputElement).name || control.id;
    if (!name) continue;

    const type = (control.getAttribute('type') ?? '').toLowerCase();

    // Checkbox/radio groups share a base name; keep them together. A date widget is
    // three or more selects (month/day/year) that are one logical field, so they
    // collapse too — otherwise "Display Date" appears three times in the rail.
    // Everything else is keyed by full name so a multi-value text field's deltas
    // stay distinct.
    const key = (type === 'checkbox' || type === 'radio' || DATE_PART.test(name))
      ? baseNameOf(name)
      : name;

    const existing = groups.get(key);
    if (existing) existing.push(control);
    else groups.set(key, [control]);
  }

  return groups;
}

/** Reads the vertical tabs and Drupal's own collapsed summaries. */
export function readVerticalTabs(form: HTMLFormElement): VerticalTab[] {
  const panes = Array.from(form.querySelectorAll<HTMLElement>(
    'fieldset.vertical-tabs-pane, .vertical-tabs-pane, details.vertical-tabs__pane'
  ));

  return panes.map(pane => {
    const legend = pane.querySelector(':scope > legend');
    return {
      legend: text(legend?.querySelector('.fieldset-legend') ?? legend),
      // Drupal writes the collapsed summary into .summary / .vertical-tabs-summary.
      summary: text(pane.querySelector('.summary, .vertical-tabs-summary')),
      element: pane,
    };
  }).filter(tab => tab.legend);
}

/** Locates the node form, preferring an explicit node-form id. */
export function findNodeForm(root: ParentNode = document): HTMLFormElement | null {
  return root.querySelector<HTMLFormElement>('form.node-form')
    ?? root.querySelector<HTMLFormElement>('form[id$="-node-form"]')
    ?? root.querySelector<HTMLFormElement>('form#node-form')
    ?? null;
}

/**
 * Walks a form into field descriptors, in DOM order.
 */
export function walkForm(form: HTMLFormElement): FieldDescriptor[] {
  const groups = collectFieldGroups(form);
  const fields: FieldDescriptor[] = [];

  for (const [key, controls] of groups) {
    const first = controls[0];

    // The label lives on the enclosing .form-item, or the field wrapper for
    // multi-value fields.
    const wrapper =
      (first.closest('.form-item, .field-type-text, .field-widget, .form-checkboxes, .form-radios') as HTMLElement | null)
      ?? (first.parentElement as HTMLElement | null)
      ?? form;

    const kindProbe = classify(controls, wrapper);

    /**
     * Widgets built from several controls cannot take their label from the first one.
     * A checkbox group would be named after its first option ("Allergy" instead of
     * "Topics"), and a date cluster after its first select — the live News form's date
     * field came through labelled "Year" rather than from its "Date" legend.
     */
    const isMultiControl = kindProbe === 'checkboxGroup'
      || kindProbe === 'radioGroup'
      || (kindProbe === 'date' && controls.length > 1);

    let label: string;
    let labelHost: HTMLElement;

    if (isMultiControl) {
      const resolved = labelForGroupWidget(first, wrapper);
      label = resolved.label;
      labelHost = resolved.host;
    } else {
      labelHost = wrapper;
      label = cleanLabel(
        labelHost.querySelector(':scope > label')
        ?? labelHost.querySelector('label')
        ?? null
      );
    }

    const machineName = (first as HTMLInputElement).name || first.id || key;
    const baseName = baseNameOf(machineName) || key;

    // The whole ancestor legend chain, not just the nearest. A radio group inside
    // "Customize display" > "Display mode" must still be recognized as belonging to
    // the display tab; matching only the nearest legend missed it.
    const groupPath = groupPathOf(wrapper, form);
    const { section, matchedBy } = assignSection({ label, baseName, groupPath });

    // Multi-value means Drupal rendered an "Add another item" button for THIS
    // field's widget. Scoping to the field's own widget wrapper matters: looking at
    // wrapper.parentElement caught a sibling field's button, which flagged the
    // single "Sitewide News" checkbox as multi-value.
    const widgetWrapper = first.closest(
      'table.field-multiple-table, .field-widget-entityreference-autocomplete, .field-multiple-drag'
    ) as HTMLElement | null;

    const multiValue = Boolean(
      first.closest('table.field-multiple-table')
      || (widgetWrapper?.parentElement?.querySelector('input[value="Add another item"]'))
    );

    fields.push({
      machineName,
      baseName,
      label: label || baseName,
      kind: kindProbe,
      required: isRequired(labelHost, controls),
      help: helpFor(wrapper) || helpFor(labelHost),
      section,
      matchedBy,
      group: groupPath[0] ?? null,
      groupPath,
      elements: controls,
      options: readOptions(controls, kindProbe, labelHost),
      multiValue,
      advanced: isAdvancedField({ label: label || baseName, baseName }),
    });
  }

  return fields;
}

/** Full discovery: find the form, walk it, read its tabs. */
export function buildSchema(
  form: HTMLFormElement,
  contentType: string | null,
  detectedFrom: FormSchema['detectedFrom']
): FormSchema {
  return {
    contentType,
    detectedFrom,
    fields: walkForm(form),
    verticalTabs: readVerticalTabs(form),
    form,
  };
}
