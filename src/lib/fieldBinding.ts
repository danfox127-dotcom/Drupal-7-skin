import { hasRichEditorOn } from './richEditorPresence';
import { FieldDescriptor, findNodeForm } from './formSchema';

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
 * Asks the service worker to push the value into the page's rich-text editor.
 *
 * CKEditor holds content in its own instance and only syncs to the textarea on submit,
 * so assigning `textarea.value` alone is discarded. That instance lives in the page's
 * JavaScript world, unreachable from a content script.
 *
 * This deliberately does NOT append an inline <script> to the page. That approach was
 * tried and fails on any site whose CSP omits 'unsafe-inline' — verified in testing
 * with "Executing inline script violates the following Content Security Policy
 * directive". The service worker uses chrome.scripting with `world: 'MAIN'`, which is
 * injected by the extension and so is not subject to page CSP.
 *
 * Fire-and-forget: the textarea write always happens first and is correct on its own
 * when no rich editor is attached.
 */
function syncRichEditor(el: HTMLTextAreaElement, value: string): void {
  if (!el.id) return;

  try {
    void chrome.runtime.sendMessage({ type: 'syncRichEditor', elementId: el.id, value });
  } catch {
    // An invalidated extension context (reloaded mid-session) is not worth surfacing;
    // the textarea already holds the value.
  }
}

/**
 * Pushes every rich editor's content into its underlying textarea.
 *
 * Call before reading values for anything that is not a form submit. On submit the
 * editor's own handler does this, but a draft read straight from the DOM would otherwise
 * capture whatever the textarea held before the user started typing.
 */
export async function syncRichEditorsToDom(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'richEditorLifecycle', elementId: '*', op: 'sync',
    });
  } catch {
    // No editor bridge available; the textareas are already authoritative.
  }
}

/** True when a rich editor is attached to this field. */
export function hasRichEditor(field: FieldDescriptor): boolean {
  return hasRichEditorOn(field.elements[0]);
}

/**
 * The field's controls as they exist in the page RIGHT NOW.
 *
 * The schema captures element references at discovery. Drupal then re-renders parts of
 * the form — its AJAX answers an interaction by replacing a widget wrapper outright, as
 * inject.tsx already notes for slot stability — and every reference into that wrapper is
 * left pointing at a detached node.
 *
 * Assigning to a detached input is silent: no error, no exception, and the input Drupal
 * will actually submit is untouched. That is how the overlay came to show "Provide a menu
 * link" ticked while Drupal's own menu[enabled] read false, and the placement was dropped
 * on save with nothing reported anywhere.
 *
 * So the stored references are treated as a hint. When they have gone stale, the name is
 * re-resolved against the live form — a name survives any number of AJAX replacements,
 * which is exactly why Drupal keys its own form state on it.
 */
function liveElements(field: FieldDescriptor): HTMLElement[] {
  const els = field.elements;
  if (els.length === 0) return els;
  if (els.some(el => el.isConnected)) return els;
  if (!field.machineName) return els;

  const form = findNodeForm(document);
  if (!form) return els;

  // JSON.stringify for the quoting, not CSS.escape: this is an attribute VALUE, and
  // Drupal names carry brackets — [name="menu[enabled]"] is already valid.
  const fresh = Array.from(
    form.querySelectorAll<HTMLElement>(`[name=${JSON.stringify(field.machineName)}]`)
  );
  return fresh.length > 0 ? fresh : els;
}

/** Current value of a field, read from its native control(s). */
export function readValue(field: FieldDescriptor): FieldValue {
  const els = liveElements(field);
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
  const els = liveElements(field);
  if (els.length === 0) return false;

  /**
   * Refuse to claim success when writing to an element that has left the document.
   *
   * The schema holds direct element references taken at discovery. If Drupal's AJAX
   * replaces a wrapper afterwards — or anything else re-renders that part of the form —
   * those references point at detached nodes. Assigning to a detached input succeeds
   * silently: no error, no exception, and the live input Drupal will submit is untouched.
   *
   * That is exactly how the overlay came to show "Provide a menu link" ticked while
   * Drupal's own menu[enabled] stayed false, and the placement was discarded on save with
   * nothing reported. Returning false surfaces it as a failed write instead, which
   * FieldControl already renders as a warning.
   */
  if (!els.some(el => el.isConnected)) return false;

  switch (field.kind) {
    case 'checkbox': {
      const el = els[0] as HTMLInputElement;
      const wanted = Boolean(value);
      el.checked = wanted;
      notify(el);
      // Confirmed rather than assumed. If anything on the page rejects or reverts the
      // change, this reports a failed write and the control shows a warning, instead of
      // the overlay quietly disagreeing with the form Drupal is about to save.
      return el.checked === wanted;
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

  const button = chooseSubmit(form, Boolean(opts.publish));
  if (!button) return false;

  button.click();
  return true;
}

/** An input's value or a button's text, whichever carries the label. */
function submitLabel(el: HTMLElement): string {
  return ((el as HTMLInputElement).value || el.textContent || '').trim();
}

/**
 * Buttons a save must never press, whatever was asked for.
 *
 * "Delete (all revisions)" is a submit input named `op` sitting in the same actions block
 * as the saves, so anything selecting by name or by position can reach it.
 */
const NEVER_CLICK = /delete|remove|preview|view changes|cancel/i;

/**
 * Picks the button that does what the caller asked.
 *
 * The old selector led with `#edit-submit`, which is fine on a stock Drupal form where
 * that is the only Save. On a site with a moderation workflow it is not: vagelos.columbia.edu
 * offers
 *
 *   edit-submit          op="Save as draft"
 *   edit-submit-publish  op="Save and publish"
 *
 * and no moderation-state field at all — the choice IS the button. So the overlay's
 * Publish saved a pending revision every single time. The live node never changed, and a
 * menu placement set in the same edit looked like it had silently failed to hold, because
 * reopening the form shows the live revision rather than the pending one. Nothing was
 * reported, because clicking a real save button genuinely does succeed.
 *
 * Matching on the visible label rather than on an id: `edit-submit-publish` is this site's
 * id, not a Drupal convention, whereas the wording of a publish button is what any editor
 * would recognise and what a themer is least likely to change silently.
 */
function chooseSubmit(form: HTMLFormElement, publish: boolean): HTMLElement | null {
  const candidates = Array.from(
    form.querySelectorAll<HTMLElement>('input[type="submit"][name="op"], button[name="op"]')
  ).filter(el => !NEVER_CLICK.test(submitLabel(el)));

  // Field widgets ("Attach", "Add another item") are submit inputs too, but they carry
  // their own names rather than `op`, so the selector above already excludes them. Keep
  // #edit-submit as a last resort for forms that name their button something else.
  if (candidates.length === 0) {
    const fallback = form.querySelector<HTMLElement>('#edit-submit');
    return fallback && !NEVER_CLICK.test(submitLabel(fallback)) ? fallback : null;
  }

  const wanted = publish ? /publish/i : /draft/i;
  const match = candidates.find(el => wanted.test(submitLabel(el)));
  if (match) return match;

  /**
   * No button for that intent. On a stock form there is one Save which is both — and for
   * publishing, the `status` checkbox handled above is what makes it a publish.
   */
  const plain = candidates.find(el => !/draft|publish/i.test(submitLabel(el)));
  return plain ?? candidates[0];
}
