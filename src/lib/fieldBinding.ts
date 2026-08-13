import { FieldDescriptor } from './formSchema';

/**
 * Reads and writes the native Drupal controls behind the overlay.
 *
 * The contract from the handoff: every visible control in the overlay maps to the
 * hidden native input; set `.value` and dispatch a bubbling change event, exactly as
 * TaxonomyCombobox already does for `menu[parent]`. Drupal's own submit performs the
 * save, and nothing is ever written to Drupal implicitly.
 *
 * Binding is to the ELEMENTS captured during discovery, not to machine names. That
 * matters: the machine names in the rules table are inferred from screenshots, but
 * the element references are real, so write-back is correct even where a name guess
 * is wrong.
 */

/** Value shapes, by field kind. */
export type FieldValue = string | boolean | string[];

/** Fires the events Drupal's own JS and validation listen for. */
function notify(el: HTMLElement) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * CKEditor keeps its content in its own instance and only syncs to the textarea on
 * submit, so assigning `textarea.value` alone is silently discarded.
 *
 * The instance lives in the page's JavaScript world, which a content script cannot
 * reach directly, so this injects a one-shot script into the page to call setData.
 * Best-effort by design: the textarea write below always happens, which is correct
 * when no rich editor is attached.
 */
function syncRichEditor(el: HTMLTextAreaElement, value: string): void {
  if (!el.id) return;

  const script = document.createElement('script');
  script.textContent = `
    (function () {
      var id = ${JSON.stringify(el.id)};
      var value = ${JSON.stringify(value)};
      try {
        if (window.CKEDITOR && window.CKEDITOR.instances && window.CKEDITOR.instances[id]) {
          window.CKEDITOR.instances[id].setData(value);
        } else if (window.tinyMCE && window.tinyMCE.get(id)) {
          window.tinyMCE.get(id).setContent(value);
        }
      } catch (e) { /* leave the textarea value as the source of truth */ }
    })();
  `;
  document.documentElement.appendChild(script);
  script.remove();
}

/** True when a rich editor is attached to this field. */
export function hasRichEditor(field: FieldDescriptor): boolean {
  const el = field.elements[0];
  if (!el) return false;
  return Boolean(
    el.closest('.text-format-wrapper')?.querySelector('.cke, .ckeditor')
    || el.closest('.form-item')?.querySelector('.cke, .ckeditor')
  );
}

/** Current value of a field, read from its native control(s). */
export function readValue(field: FieldDescriptor): FieldValue {
  const els = field.elements;
  if (els.length === 0) return '';

  switch (field.kind) {
    case 'checkbox':
      return (els[0] as HTMLInputElement).checked;

    case 'checkboxGroup':
      return els
        .filter(el => (el as HTMLInputElement).checked)
        .map(el => (el as HTMLInputElement).value);

    case 'radioGroup': {
      const checked = els.find(el => (el as HTMLInputElement).checked);
      return checked ? (checked as HTMLInputElement).value : '';
    }

    case 'date':
      // Joined in element order, which is the order Drupal rendered the parts.
      return els.map(el => (el as HTMLSelectElement).value).join('-');

    default:
      return (els[0] as HTMLInputElement).value ?? '';
  }
}

/**
 * Writes a value back to the native control(s).
 *
 * Returns false when the write did not take effect — most importantly when a
 * `<select>` is given a value with no matching `<option>`, which silently leaves it
 * empty. That failure mode already bit the menu manager's weight selects, so it is
 * reported rather than assumed.
 */
export function writeValue(field: FieldDescriptor, value: FieldValue): boolean {
  const els = field.elements;
  if (els.length === 0) return false;

  switch (field.kind) {
    case 'checkbox': {
      const el = els[0] as HTMLInputElement;
      el.checked = Boolean(value);
      notify(el);
      return true;
    }

    case 'checkboxGroup': {
      const wanted = new Set(Array.isArray(value) ? value : [String(value)]);
      let ok = true;
      for (const el of els) {
        const input = el as HTMLInputElement;
        const shouldCheck = wanted.has(input.value);
        if (input.checked !== shouldCheck) {
          input.checked = shouldCheck;
          notify(input);
        }
      }
      // Any requested value with no matching checkbox is a failed write.
      const available = new Set(els.map(el => (el as HTMLInputElement).value));
      for (const v of wanted) if (!available.has(v)) ok = false;
      return ok;
    }

    case 'radioGroup': {
      const target = String(value);
      const match = els.find(el => (el as HTMLInputElement).value === target);
      if (!match) return false;
      (match as HTMLInputElement).checked = true;
      notify(match);
      return true;
    }

    case 'date': {
      const parts = String(value).split('-');
      let ok = true;
      els.forEach((el, i) => {
        const select = el as HTMLSelectElement;
        const part = parts[i];
        if (part === undefined) return;
        select.value = part;
        if (select.value !== part) ok = false;
        notify(select);
      });
      return ok;
    }

    case 'wysiwyg': {
      const el = els[0] as HTMLTextAreaElement;
      el.value = String(value);
      notify(el);
      // The textarea write above is the fallback; this is what makes it stick when
      // CKEditor owns the field.
      syncRichEditor(el, String(value));
      return true;
    }

    case 'select': {
      const el = els[0] as HTMLSelectElement;
      const target = String(value);
      el.value = target;
      notify(el);
      // Assigning an absent option leaves the select empty rather than erroring.
      return el.value === target;
    }

    default: {
      const el = els[0] as HTMLInputElement;
      el.value = String(value);
      notify(el);
      return true;
    }
  }
}

/** Snapshot of every field's current value, keyed by machine name. */
export function readAll(fields: FieldDescriptor[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const field of fields) out[field.machineName] = readValue(field);
  return out;
}

/**
 * Applies a snapshot, returning the machine names that failed to write.
 *
 * A non-empty result must be surfaced, not swallowed: it means the restored draft
 * does not match what Drupal will receive.
 */
export function writeAll(
  fields: FieldDescriptor[],
  values: Record<string, FieldValue>
): string[] {
  const failed: string[] = [];
  for (const field of fields) {
    if (!(field.machineName in values)) continue;
    if (!writeValue(field, values[field.machineName])) failed.push(field.machineName);
  }
  return failed;
}

/**
 * Submits the form through Drupal's own button so its handlers, tokens, and
 * validation all run. Never posts directly.
 *
 * `publish` chooses Drupal's status control when the form exposes one; otherwise the
 * caller's Save is the only action available and publishing is whatever the form's
 * default status is.
 */
export function submitForm(form: HTMLFormElement, opts: { publish?: boolean } = {}): boolean {
  /**
   * Disable native constraint validation before submitting.
   *
   * This is not a shortcut — it is required for the overlay to work at all. The
   * native form is hidden with `display:none`, and Chrome refuses to submit a form
   * containing an invalid control it cannot focus, failing with "An invalid form
   * control with name='…' is not focusable" and no submit event. A single empty
   * `required` field would therefore make Save do nothing, with no error the user
   * could see.
   *
   * Nothing is lost by turning it off: Drupal validates server-side regardless, and
   * readFormErrors maps whatever it returns back onto the overlay's fields. The
   * overlay also shows its own "Required" markers.
   */
  form.noValidate = true;

  if (opts.publish) {
    const status = form.querySelector<HTMLInputElement>('input[name="status"][type="checkbox"]');
    if (status && !status.checked) {
      status.checked = true;
      notify(status);
    }
  }

  const button = form.querySelector<HTMLElement>('#edit-submit, input[name="op"][type="submit"], button[name="op"]');
  if (!button) return false;

  button.click();
  return true;
}
