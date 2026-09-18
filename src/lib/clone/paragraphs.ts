import { FieldDescriptor, FormSchema, FieldKind, findNodeForm, walkForm } from '../formSchema';
import { writeValue } from '../fieldBinding';
import { hasRichEditorOn } from '../richEditorPresence';
import { CapturedField, CapturedParagraph } from './types';
import { ParagraphWidget, findParagraphWidgets } from './snapshot';

/**
 * Copying a page's structured content items.
 *
 * ONE generic mechanism, and deliberately no per-type code. A content item's subform is
 * just fields, so capturing whatever fields an item has and writing them back by name
 * handles `text` and `faq` — the two that get real use, both backed by an HTML editor —
 * without either being special-cased, and handles the rarer types too whenever their
 * fields are ordinary. A type this site does not offer is reported rather than
 * approximated.
 *
 * The part that is genuinely not a plain write: the destination form arrives with ZERO
 * item slots. There is nothing in the DOM to write into, so each item has to be created
 * by setting the type dropdown and clicking Drupal's "Add another item", which is a
 * server round-trip that rebuilds the whole widget. Hence the sequential loop below.
 */

/** Escapes a Drupal field name for use inside a RegExp. */
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `field_x[und][2][field_text][und][0][value]` -> `field_text[und][0][value]`. */
export function relativeName(baseName: string, machineName: string): { delta: number; relative: string } | null {
  const match = machineName.match(new RegExp(`^${escapeRe(baseName)}\\[und\\]\\[(\\d+)\\](.+)$`));
  if (!match) return null;

  // The remainder starts `[field_text]`; the field's own name is not bracketed.
  const relative = match[2].replace(/^\[([^\]]+)\]/, '$1');
  return { delta: Number(match[1]), relative };
}

/**
 * How an existing item's type was worked out.
 *
 * Recorded and surfaced because the markup of a populated subform has not been captured
 * from a real site. Rather than block on that, this tries the plausible places in order
 * and says which one answered — so a wrong guess is visible in the review instead of
 * producing an item of the wrong type.
 */
export type BundleSource = 'bundle-input' | 'subform-class' | 'field-name' | 'unknown';

/**
 * Works out which type an existing item is.
 *
 * `bundles` is the list the DESTINATION offers, read from the add-more select, so the
 * inference can only ever land on a type that actually exists.
 */
export function detectBundle(
  form: ParentNode,
  baseName: string,
  delta: number,
  bundles: string[]
): { bundle: string | null; from: BundleSource } {
  const prefix = `${baseName}[und][${delta}]`;

  /**
   * 1. Paragraphs' own record of the type. The convention is a hidden
   *    `field_x[und][N][bundle]`, but accept any control under this delta whose name
   *    ends in a bundle key rather than insisting on the exact spelling.
   */
  const bundleInput = Array.from(
    form.querySelectorAll<HTMLInputElement>(`[name^="${prefix}"]`)
  ).find(el => /\[(bundle|_bundle|paragraph_bundle)\]$/.test(el.name ?? ''));
  if (bundleInput?.value && bundles.includes(bundleInput.value)) {
    return { bundle: bundleInput.value, from: 'bundle-input' };
  }

  /**
   * 2. A class on the subform wrapper. Drupal themes the item with its type, which is
   *    what walkForm's own classifier already looks for.
   */
  const anyControl = form.querySelector<HTMLElement>(`[name^="${prefix}"]`);
  const wrapper = anyControl?.closest('.paragraphs-subform, [class*="paragraph-type"], [class*="paragraphs-item"]');
  if (wrapper) {
    for (const className of Array.from(wrapper.classList)) {
      const match = className.match(/(?:paragraph-type|paragraphs-item|paragraphs-subform)[-_]{1,2}(.+)$/);
      const candidate = match?.[1]?.replace(/-/g, '_');
      if (candidate && bundles.includes(candidate)) {
        return { bundle: candidate, from: 'subform-class' };
      }
    }
  }

  /**
   * 3. Last resort: the item's own field names. An `faq` item carries fields named for
   *    it, so a field whose name contains a bundle key is decent evidence. Reported as
   *    an inference so it can be disbelieved.
   */
  const names = Array.from(form.querySelectorAll<HTMLElement>(`[name^="${prefix}"]`))
    .map(el => (el as HTMLInputElement).name ?? '');
  for (const bundle of [...bundles].sort((a, b) => b.length - a.length)) {
    if (names.some(name => name.includes(`field_${bundle}`) || name.includes(`_${bundle}_`))) {
      return { bundle, from: 'field-name' };
    }
  }

  return { bundle: null, from: 'unknown' };
}

/**
 * The kind a nested field really is.
 *
 * walkForm's classifier returns `paragraphs` for ANY control whose name matches
 * /paragraph/i, which is every field inside `field_page_paragraphs[...]`. That is right
 * for the widget and wrong for its contents, and writeValue has no `paragraphs` case —
 * so an item's body would be written straight to the textarea and never handed to the
 * rich-editor bridge. CKEditor replaces the textarea's content from its own instance on
 * submit, so the HTML would be silently dropped on exactly the two item types that get
 * used.
 *
 * Corrected here rather than in classify(), which the two-pane editor relies on to find
 * the add-more select.
 */
export function effectiveKind(field: FieldDescriptor): FieldKind {
  if (field.kind !== 'paragraphs') return field.kind;

  const el = field.elements[0];
  if (!el) return 'text';
  if (hasRichEditorOn(el)) return 'wysiwyg';
  if (el.tagName === 'TEXTAREA') return 'wysiwyg';
  if (el.tagName === 'SELECT') return 'select';
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  if (type === 'checkbox') return 'checkbox';
  return 'text';
}

/** Reads the items of one Paragraphs widget off the form currently open. */
export function captureParagraphItems(
  schema: FormSchema,
  widget: ParagraphWidget,
  capture: (field: FieldDescriptor, relative: string) => CapturedField
): CapturedParagraph[] {
  const bundleValues = widget.bundles.map(b => b.value);
  const byDelta = new Map<number, CapturedField[]>();

  for (const field of schema.fields) {
    const parsed = relativeName(widget.baseName, field.machineName);
    if (!parsed) continue;
    // Paragraphs' own bookkeeping is not content.
    if (/\[(bundle|_bundle|paragraph_bundle|_weight|_remove)\]$/.test(field.machineName)) continue;

    const list = byDelta.get(parsed.delta);
    const captured = capture(field, parsed.relative);
    if (list) list.push(captured);
    else byDelta.set(parsed.delta, [captured]);
  }

  return [...byDelta.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([delta, fields]) => {
      const detected = detectBundle(schema.form, widget.baseName, delta, bundleValues);
      const label = widget.bundles.find(b => b.value === detected.bundle)?.label ?? '';
      return {
        bundle: detected.bundle ?? '',
        bundleLabel: label || detected.bundle || 'unknown type',
        bundleFrom: detected.from,
        delta,
        fields,
      };
    });
}

/**
 * Waits for the DOM to satisfy a predicate, bounded.
 *
 * A MutationObserver rather than a sleep. Drupal's add-more is a server round-trip whose
 * duration depends on the site, and a fixed delay is either a flake or a stall — the
 * same reasoning as waitForRichEditors in the content script.
 */
async function waitFor(
  predicate: () => boolean,
  root: Node,
  timeoutMs: number
): Promise<boolean> {
  if (predicate()) return true;

  return new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(value);
    };

    const observer = new MutationObserver(() => { if (predicate()) finish(true); });
    observer.observe(root, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(predicate()), timeoutMs);
  });
}

/** Deltas currently rendered for a widget. */
function deltasOf(form: ParentNode, baseName: string): number[] {
  const seen = new Set<number>();
  for (const el of Array.from(form.querySelectorAll<HTMLElement>('input, select, textarea'))) {
    const parsed = relativeName(baseName, (el as HTMLInputElement).name ?? '');
    if (parsed) seen.add(parsed.delta);
  }
  return [...seen].sort((a, b) => a - b);
}

export interface AddItemResult {
  ok: boolean;
  /** The delta Drupal rendered for the new item. */
  delta: number | null;
  reason: string | null;
}

/**
 * Asks Drupal to add one item of a given type, and waits for it to appear.
 *
 * The type select is set through Drupal's own control and change is dispatched, because
 * the add-more submit reads it from form state.
 */
export async function addAnotherItem(
  baseName: string,
  bundle: string,
  timeoutMs = 15000,
  root: Document = document
): Promise<AddItemResult> {
  const form = root.querySelector<HTMLFormElement>('form.node-form, form[id$="-node-form"]');
  if (!form) return { ok: false, delta: null, reason: 'the node form is no longer on the page' };

  const select = form.querySelector<HTMLSelectElement>(
    `select[name="${baseName}_add_more_type"], select.field-add-more-type`
  );
  if (!select) return { ok: false, delta: null, reason: 'this form has no content-item type chooser' };

  select.value = bundle;
  if (select.value !== bundle) {
    return { ok: false, delta: null, reason: `this site does not offer a “${bundle}” content item` };
  }
  select.dispatchEvent(new Event('change', { bubbles: true }));

  const button = form.querySelector<HTMLInputElement>(
    `input[type="submit"][name^="${baseName}"][name$="_add_more"], input[type="submit"][name="${baseName}_add_more_add_more"]`
  );
  if (!button) return { ok: false, delta: null, reason: 'this form has no "Add another item" button' };

  const before = new Set(deltasOf(form, baseName));
  button.click();

  const appeared = await waitFor(
    () => deltasOf(form, baseName).some(delta => !before.has(delta)),
    root.body ?? form,
    timeoutMs
  );

  if (!appeared) {
    return {
      ok: false, delta: null,
      reason: 'Drupal did not add the item in time — the site may be slow, or the request failed',
    };
  }

  const added = deltasOf(form, baseName).filter(delta => !before.has(delta));
  return { ok: true, delta: added[added.length - 1], reason: null };
}

export interface ItemOutcome {
  bundleLabel: string;
  /** Relative names written into the new item. */
  written: string[];
  /** Fields the new item does not have, or whose control refused the value. */
  problems: string[];
  ok: boolean;
  reason: string | null;
}

export interface ParagraphOutcome {
  label: string;
  items: ItemOutcome[];
}

/**
 * Recreates a widget's items on the destination, in order.
 *
 * Sequential, never parallel. Drupal rebuilds form state on every add-more, so
 * overlapping requests drop items — and the order of content items is the order they
 * appear on the published page, which is content, not incidental.
 */
export async function rebuildParagraphs(
  captured: { baseName: string; label: string; items: CapturedParagraph[] },
  root: Document = document
): Promise<ParagraphOutcome> {
  const outcome: ParagraphOutcome = { label: captured.label, items: [] };

  for (const item of captured.items) {
    if (!item.bundle) {
      outcome.items.push({
        bundleLabel: item.bundleLabel, written: [], problems: [], ok: false,
        reason: 'Could not tell what type of content item this is, so it was not recreated.',
      });
      continue;
    }

    const added = await addAnotherItem(captured.baseName, item.bundle, 15000, root);
    if (!added.ok || added.delta === null) {
      outcome.items.push({
        bundleLabel: item.bundleLabel, written: [], problems: [], ok: false,
        reason: added.reason,
      });
      continue;
    }

    /**
     * Re-read, because this item's fields did not exist when the page was first walked —
     * and because Drupal's AJAX replaces the whole widget wrapper, which leaves every
     * earlier reference into it detached.
     *
     * walkForm rather than discoverSchema: discoverSchema first checks the URL looks
     * like a node form, and that question is already settled — we just clicked this
     * form's own "Add another item". Depending on the path made the re-read fail
     * wherever the URL was not a Drupal path, which is every test that serves the form
     * directly, and would also have failed on any admin path shaped differently.
     */
    const liveForm = findNodeForm(root);
    if (!liveForm) {
      outcome.items.push({
        bundleLabel: item.bundleLabel, written: [], problems: [], ok: false,
        reason: 'The form could not be read again after the item was added.',
      });
      continue;
    }

    const slots = new Map<string, FieldDescriptor>();
    for (const field of walkForm(liveForm)) {
      const parsed = relativeName(captured.baseName, field.machineName);
      if (parsed?.delta === added.delta) slots.set(parsed.relative, field);
    }

    const written: string[] = [];
    const problems: string[] = [];

    for (const source of item.fields) {
      const target = slots.get(source.machineName);
      if (!target) {
        problems.push(source.label || source.machineName);
        continue;
      }

      /**
       * effectiveKind, not target.kind. Everything inside a Paragraphs widget is
       * classified `paragraphs`, and writeValue has no case for it — so an item's HTML
       * would reach the textarea and never the rich editor, which overwrites it on
       * submit.
       */
      const corrected: FieldDescriptor = { ...target, kind: effectiveKind(target) };
      if (writeValue(corrected, source.value)) written.push(source.machineName);
      else problems.push(target.label || source.machineName);
    }

    outcome.items.push({
      bundleLabel: item.bundleLabel,
      written,
      problems,
      ok: problems.length === 0,
      reason: problems.length
        ? `Added, but ${problems.length} field${problems.length === 1 ? '' : 's'} did not take: ${problems.join(', ')}.`
        : null,
    });
  }

  return outcome;
}

export { findParagraphWidgets };
