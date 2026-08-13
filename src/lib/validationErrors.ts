import { FieldDescriptor, SectionId } from './formSchema';

/**
 * Maps Drupal's server-side validation errors back onto overlay fields.
 *
 * This answers the handoff's open question #6, and it is not optional polish: the
 * overlay hides the native inputs, so a rejected save would otherwise show a message
 * about a field the user cannot see, with nothing indicating where to look.
 *
 * Two independent signals, because neither is reliable alone:
 *   1. Drupal adds `.error` to the offending elements — precise, but some validation
 *      paths only produce a message.
 *   2. The `div.messages.error` list names fields in prose — always present, but
 *      matched by label text, which is fuzzier.
 */

export interface FieldError {
  field: FieldDescriptor;
  /** The message matched to this field, when one could be attributed. */
  message: string | null;
  source: 'element' | 'message';
}

export interface FormErrors {
  /** Every error message Drupal rendered, in order. */
  messages: string[];
  fieldErrors: FieldError[];
  /** Messages that could not be attributed to a field — must still be shown. */
  unattributed: string[];
  /** Sections to auto-open, so the offending field is visible. */
  sections: SectionId[];
}

const norm = (s: string | null | undefined) =>
  (s ?? '').replace(/\s+/g, ' ').trim();

/** Reads the messages out of Drupal's error region. */
export function readErrorMessages(root: ParentNode = document): string[] {
  const regions = Array.from(root.querySelectorAll('.messages.error, .messages--error'));
  const messages: string[] = [];

  for (const region of regions) {
    const items = Array.from(region.querySelectorAll('li'));
    if (items.length) {
      items.forEach(li => {
        const text = norm(li.textContent);
        if (text) messages.push(text);
      });
      continue;
    }

    // A single-error region has no <ul>. Drop the "Error message" heading Drupal
    // adds for screen readers.
    const clone = region.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('h2.element-invisible, .visually-hidden').forEach(el => el.remove());
    const text = norm(clone.textContent);
    if (text) messages.push(text);
  }

  return messages;
}

/** True when the field's own control was flagged by Drupal. */
function elementFlagged(field: FieldDescriptor): boolean {
  return field.elements.some(el =>
    el.classList.contains('error')
    || el.getAttribute('aria-invalid') === 'true'
  );
}

/**
 * Attributes a message to a field by label.
 *
 * Drupal's phrasing is "<em class="placeholder">Title</em> field is required." so the
 * label appears verbatim. Longest label first, so "Related Conditions" is not claimed
 * by a field labeled "Conditions".
 */
function attributeByLabel(
  messages: string[],
  fields: FieldDescriptor[]
): Map<FieldDescriptor, string> {
  const byField = new Map<FieldDescriptor, string>();
  const candidates = [...fields]
    .filter(f => f.label && f.label.length > 2)
    .sort((a, b) => b.label.length - a.label.length);

  for (const message of messages) {
    const haystack = message.toLowerCase();
    const hit = candidates.find(f => haystack.includes(f.label.toLowerCase()));
    if (hit && !byField.has(hit)) byField.set(hit, message);
  }

  return byField;
}

export function readFormErrors(
  fields: FieldDescriptor[],
  root: ParentNode = document
): FormErrors {
  const messages = readErrorMessages(root);
  const byLabel = attributeByLabel(messages, fields);

  const fieldErrors: FieldError[] = [];
  const claimed = new Set<string>();

  // Element flags first — they are the precise signal.
  for (const field of fields) {
    if (!elementFlagged(field)) continue;
    const message = byLabel.get(field) ?? null;
    fieldErrors.push({ field, message, source: 'element' });
    if (message) claimed.add(message);
  }

  // Then messages that named a field Drupal did not flag in the DOM.
  for (const [field, message] of byLabel) {
    if (fieldErrors.some(e => e.field === field)) continue;
    fieldErrors.push({ field, message, source: 'message' });
    claimed.add(message);
  }

  const unattributed = messages.filter(m => !claimed.has(m));

  // Section order follows the rail, so the topmost offending section opens first.
  const sections = [...new Set(fieldErrors.map(e => e.field.section))];

  return { messages, fieldErrors, unattributed, sections };
}

/** True when Drupal rejected the submission. */
export function hasErrors(errors: FormErrors): boolean {
  return errors.messages.length > 0 || errors.fieldErrors.length > 0;
}
