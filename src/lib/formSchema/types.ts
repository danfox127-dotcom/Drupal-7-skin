/**
 * Normalized description of a Drupal 7 node form, derived by reading the rendered
 * DOM rather than from a hardcoded per-type matrix.
 *
 * Why derived: the handoff documents News / Page / Specialty, but the live site has
 * at least ten more types (Condition, Event Importer, Gallery, Landing, List,
 * Testimonial, Timeline Entry, Profile, Treatment). A hardcoded matrix would need
 * editing for every new type and was already flagged as unconfirmed for Specialty.
 */

/** Which rail section (or the left column) a field belongs to. */
export type SectionId =
  | 'primary'      // left column: title, subtitle, summary, body
  | 'typeFields'   // left column: the type's own fields (byline, date, …)
  | 'topics'
  | 'related'
  | 'multimedia'
  | 'menu'
  | 'display'
  | 'seo'
  | 'groups'
  | 'revision'
  | 'other';       // recognized as a field, but no rule claimed it

/** Control shape, which decides how the rail renders it. */
export type FieldKind =
  | 'text'
  | 'textarea'
  | 'wysiwyg'
  | 'select'
  | 'checkbox'
  | 'checkboxGroup'
  | 'radioGroup'
  | 'autocomplete'
  | 'file'
  | 'date'
  | 'paragraphs'
  | 'unknown';

export interface FieldOption {
  value: string;
  label: string;
  /** Depth for hierarchical taxonomy widgets; 0 for flat lists. */
  depth: number;
  selected: boolean;
}

export interface FieldDescriptor {
  /**
   * Drupal's form element name, e.g. `field_topics[und][]`. Identity for
   * write-back. Falls back to the element id when a control has no name.
   */
  machineName: string;
  /** Bare field name without the language/delta suffix, e.g. `field_topics`. */
  baseName: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  /** Drupal's `.description` help text, when present. */
  help: string;
  section: SectionId;
  /** Which rule matched, for debugging a misfiled field. */
  matchedBy: string;
  /** Legend of the nearest enclosing fieldset / vertical tab, when any. */
  group: string | null;
  /** Every ancestor legend, nearest first — what the rules table matches against. */
  groupPath: string[];
  /** Live elements to write back to. More than one for radio/checkbox groups. */
  elements: HTMLElement[];
  /** Present for select / checkboxGroup / radioGroup. */
  options?: FieldOption[];
  /** True when Drupal rendered an "Add another item" multi-value widget. */
  multiValue: boolean;
  /**
   * Rarely-used field, rendered behind a disclosure so it does not crowd out the fields
   * an editor actually reaches for. Still fully editable.
   */
  advanced: boolean;
}

/** A vertical tab (Meta tags, URL path settings, …) and its collapsed summary. */
export interface VerticalTab {
  legend: string;
  /** Drupal's own summary text, e.g. "Automatic alias". */
  summary: string;
  element: HTMLElement;
}

export interface FormSchema {
  /** Machine name of the content type, e.g. `news`. Null when undetectable. */
  contentType: string | null;
  /** How the type was determined, for diagnosing a wrong guess. */
  detectedFrom: 'url-add' | 'body-class' | 'form-id' | null;
  fields: FieldDescriptor[];
  verticalTabs: VerticalTab[];
  /** The form element the fields belong to. */
  form: HTMLFormElement;
}

/** Fields in a given section, in DOM order. */
export function fieldsIn(schema: FormSchema, section: SectionId): FieldDescriptor[] {
  return schema.fields.filter(f => f.section === section);
}

/** Sections that actually have fields, so the rail renders nothing empty. */
export function populatedSections(schema: FormSchema): SectionId[] {
  const order: SectionId[] = [
    'primary', 'typeFields', 'topics', 'related', 'multimedia',
    'menu', 'display', 'seo', 'groups', 'revision', 'other',
  ];
  return order.filter(section => schema.fields.some(f => f.section === section));
}
