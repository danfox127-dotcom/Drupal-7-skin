import { FieldDescriptor, FormSchema, FieldKind, findNodeForm, walkForm } from '../formSchema';
import { writeValue } from '../fieldBinding';
import { hasRichEditorOn } from '../richEditorPresence';
import { CapturedField, CapturedParagraph } from './types';
import { autocompletePathFor, resolveReference } from './references';
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
export type BundleSource = 'row-class' | 'bundle-input' | 'subform-class' | 'field-name' | 'unknown';

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

/** A name inside double quotes in a CSS attribute selector. */
const attr = (value: string) => value.replace(/["\\]/g, '\\$&');

/**
 * The type of the item at `prefix`, read off the row Drupal renders for it.
 *
 * Verified against a real People List (vagelos.columbia.edu/node/26237/edit): every item
 * is a `<tr class="draggable paragraphs-item-type-persons">`, its nested people
 * `paragraphs-item-type-person`, and the row holds the item's own `[_weight]` select —
 * which is what ties a row to an exact prefix when rows nest inside rows. Drupal's class
 * swaps the machine name's underscores for hyphens, so it is swapped back.
 */
export function rowBundle(form: ParentNode, prefix: string): string | null {
  const weight = form.querySelector(`[name="${attr(prefix)}[_weight]"]`);
  const row = weight?.closest('tr, .paragraphs-item');
  const match = row?.className.match(/paragraphs-item-type-([a-z0-9_-]+)/i);
  return match ? match[1].replace(/-/g, '_') : null;
}

/**
 * The structured content widgets directly inside one item: relative base names such as
 * `field_persons_paragraphs`. Recognised by their own item rows, so a plain multi-value
 * field (a person's several Titles, which also carry `[_weight]`) is not mistaken for one.
 */
function nestedWidgetsOf(form: ParentNode, prefix: string): string[] {
  const found = new Set<string>();
  const own = new RegExp(`^${escapeRe(prefix)}\\[([a-z0-9_]+)\\]\\[und\\]\\[\\d+\\]\\[_weight\\]$`);
  for (const el of Array.from(form.querySelectorAll<HTMLElement>(`[name^="${attr(prefix)}["][name$="[_weight]"]`))) {
    const match = ((el as HTMLInputElement).name ?? '').match(own);
    if (match && el.closest('tr, .paragraphs-item')?.className.match(/paragraphs-item-type-/)) found.add(match[1]);
  }
  return [...found];
}

/** "Persons", from the nested widget's own table header. */
function nestedLabel(form: ParentNode, absBase: string, fallback: string): string {
  const any = form.querySelector(`[name^="${attr(absBase)}[und]"]`);
  const widget = any?.closest('.field-widget-paragraphs-embed');
  const label = widget?.querySelector('th.field-label label, label');
  const text = (label?.textContent ?? '').replace(/\*/g, '').trim();
  return text || fallback;
}

/** `person` -> "Person", for a nested item whose type has no chooser to name it. */
const bundleTitle = (bundle: string) =>
  bundle.split('_').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/** A Media widget's controls: a reference, listed for re-attaching, never a value to copy. */
const isMediaControl = (field: FieldDescriptor) =>
  Boolean(field.elements[0]?.closest('.field-widget-media-generic, .media-widget'));

/** Paragraphs' own bookkeeping is not content. */
const BOOKKEEPING = /\[(bundle|_bundle|paragraph_bundle|_weight|_remove)\]$/;

/**
 * Reads the items of one widget, and of every widget nested in them.
 *
 * Each item keeps only its OWN fields; whatever sits in a nested widget becomes that
 * widget's items, recursively. Flattened, a People List of eight people was one item of
 * 56 fields — and the paste could only ever create the outer item.
 */
function captureLevel(
  form: HTMLFormElement,
  fields: FieldDescriptor[],
  absBase: string,
  bundles: { value: string; label: string }[],
  capture: (field: FieldDescriptor, relative: string) => CapturedField
): CapturedParagraph[] {
  const deltas = new Set<number>();
  for (const field of fields) {
    const parsed = relativeName(absBase, field.machineName);
    if (parsed) deltas.add(parsed.delta);
  }

  return [...deltas].sort((a, b) => a - b).map(delta => {
    const prefix = `${absBase}[und][${delta}]`;
    const nested = nestedWidgetsOf(form, prefix);
    const insideNested = (name: string) => nested.some(base => name.startsWith(`${prefix}[${base}][`));

    const own: CapturedField[] = [];
    for (const field of fields) {
      if (!field.machineName.startsWith(`${prefix}[`) || insideNested(field.machineName)) continue;
      if (BOOKKEEPING.test(field.machineName) || isMediaControl(field)) continue;
      const parsed = relativeName(absBase, field.machineName);
      if (parsed) own.push(capture(field, parsed.relative));
    }

    const offered = bundles.map(b => b.value);
    const fromRow = rowBundle(form, prefix);
    const detected = fromRow && (offered.length === 0 || offered.includes(fromRow))
      ? { bundle: fromRow, from: 'row-class' as BundleSource }
      : detectBundle(form, absBase, delta, offered);
    const label = bundles.find(b => b.value === detected.bundle)?.label
      ?? (detected.bundle ? bundleTitle(detected.bundle) : '');

    const children = nested.map(base => {
      const childBase = `${prefix}[${base}]`;
      return {
        baseName: base,
        label: nestedLabel(form, childBase, bundleTitle(base.replace(/^field_|_paragraphs$/g, ''))),
        items: captureLevel(form, fields, childBase, [], capture),
      };
    }).filter(child => child.items.length > 0);

    return {
      bundle: detected.bundle ?? '',
      bundleLabel: label || 'unknown type',
      bundleFrom: detected.from,
      delta,
      fields: own,
      ...(children.length ? { children } : {}),
    };
  });
}

/** Reads the items of one Paragraphs widget off the form currently open. */
export function captureParagraphItems(
  schema: FormSchema,
  widget: ParagraphWidget,
  capture: (field: FieldDescriptor, relative: string) => CapturedField
): CapturedParagraph[] {
  return captureLevel(schema.form, schema.fields, widget.baseName, widget.bundles, capture);
}

/** Every item in a captured tree, depth first — for counts and checks. */
export function allItems(items: CapturedParagraph[]): CapturedParagraph[] {
  return items.flatMap(item => [item, ...allItems((item.children ?? []).flatMap(c => c.items))]);
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

/**
 * Presses one of Drupal's AJAX buttons the way a person does.
 *
 * `button.click()` does NOTHING to an AJAX button in Drupal 7. Core binds a button's
 * #ajax to MOUSEDOWN (so Enter in a text field cannot fire it) and adds a handler that
 * swallows the click, so a click neither runs the request nor submits the form. Every
 * "Add another item" the paste pressed was a no-op: it waited out its timeout and the
 * People List never arrived. The test stand-ins listened for click, so they agreed.
 *
 * Mousedown, then click. A button bound the core way answers the mousedown and drops the
 * click; one bound to click instead ignores the mousedown and answers the click. Either
 * way it fires exactly once.
 */
export function pressDrupalButton(button: HTMLElement): void {
  const view = button.ownerDocument.defaultView ?? window;
  button.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  button.click();
}

export interface AddItemResult {
  ok: boolean;
  /** The delta Drupal rendered for the new item. */
  delta: number | null;
  reason: string | null;
}

/**
 * Clicks an add-more button and waits for a new delta to appear.
 *
 * Shared by addAnotherItem (which first has to choose a bundle) and addAnotherRow
 * (which has none to choose) — everything after the button is found is identical.
 */
async function clickAddMoreAndWait(
  button: HTMLInputElement,
  form: HTMLFormElement,
  baseName: string,
  timeoutMs: number,
  root: Document
): Promise<AddItemResult> {
  const before = new Set(deltasOf(form, baseName));
  pressDrupalButton(button);

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

  return clickAddMoreAndWait(button, form, baseName, timeoutMs, root);
}

/**
 * The field's own "add more" base — the machine name up to and including its last
 * `[und][N]` delta marker, stripped of the delta and everything after. Greedy on
 * purpose: for a field nested inside a paragraph item, e.g.
 * `field_generic_paragraphs_single[und][0][field_cola_cups_profiles][und][0][target_id]`,
 * the greedy match backtracks to the LAST `[und][digit]` in the string, landing on
 * `field_generic_paragraphs_single[und][0][field_cola_cups_profiles]` — the field's own
 * delta container, not its paragraph ancestor's.
 */
export function widgetBaseName(machineName: string): string | null {
  return machineName.match(/^(.+)\[und\]\[\d+\]/)?.[1] ?? null;
}

/**
 * Adds another delta to a plain multi-value widget that has no bundle to choose —
 * an ordinary "Add another item" field, such as a multi-value entityreference-
 * autocomplete table. Verified against a real capture of List's "Individual Profiles"
 * widget: it renders exactly this shape, with no `_add_more_type` select at all, because
 * every item is the same kind of thing.
 *
 * `anyElement` is any control already known to belong to the widget — the caller has
 * one from discovery, and locating the add-more button by walking up from it is more
 * robust than reconstructing an id, because Drupal's id and name conventions diverge in
 * exactly this case (button name strips brackets to underscores; the wrapper id does
 * the same but the two are not always the mechanical inverse of each other).
 */
export async function addAnotherRow(
  anyElement: HTMLElement,
  baseName: string,
  timeoutMs = 15000,
  root: Document = document
): Promise<AddItemResult> {
  const form = root.querySelector<HTMLFormElement>('form.node-form, form[id$="-node-form"]');
  if (!form) return { ok: false, delta: null, reason: 'the node form is no longer on the page' };

  const widget = anyElement.closest<HTMLElement>('[class*="field-widget-"]');
  if (!widget) return { ok: false, delta: null, reason: 'could not find this field’s own widget wrapper' };

  const button = widget.querySelector<HTMLInputElement>(
    'input[type="submit"].field-add-more-submit, input[type="submit"][name$="_add_more"]'
  );
  if (!button) return { ok: false, delta: null, reason: 'this form has no "Add another item" button' };

  return clickAddMoreAndWait(button, form, baseName, timeoutMs, root);
}

/**
 * Asks Drupal to add one item to a NESTED widget — a Person to a People List, a Phone to
 * a Person.
 *
 * A nested widget offering one type renders a button per type instead of a chooser,
 * named for its position: `field_page_paragraphs_und_0_field_persons_paragraphs` +
 * `_add_more_add_more_bundle_person`, verified on the real People List. One offering
 * several types renders the same chooser and button as the outer widget, so that is
 * tried second.
 */
export async function addNestedItem(
  absBase: string,
  bundle: string,
  timeoutMs = 15000,
  root: Document = document
): Promise<AddItemResult> {
  const form = root.querySelector<HTMLFormElement>('form.node-form, form[id$="-node-form"]');
  if (!form) return { ok: false, delta: null, reason: 'the node form is no longer on the page' };

  const flat = absBase.replace(/\]\[/g, '_').replace(/\[/g, '_').replace(/\]/g, '');
  const perType = form.querySelector<HTMLInputElement>(
    `input[type="submit"][name="${attr(flat)}_add_more_add_more_bundle_${attr(bundle)}"]`
  );
  if (perType) return clickAddMoreAndWait(perType, form, absBase, timeoutMs, root);

  const select = form.querySelector<HTMLSelectElement>(`select[name="${attr(flat)}_add_more_type"]`);
  const button = form.querySelector<HTMLInputElement>(`input[type="submit"][name="${attr(flat)}_add_more_add_more"]`);
  if (select && button) {
    select.value = bundle;
    if (select.value !== bundle) {
      return { ok: false, delta: null, reason: `this site does not offer a “${bundle}” item here` };
    }
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return clickAddMoreAndWait(button, form, absBase, timeoutMs, root);
  }
  return { ok: false, delta: null, reason: `this site has no way to add a “${bundleTitle(bundle)}” here` };
}

export interface ItemOutcome {
  bundleLabel: string;
  /** Relative names written into the new item, its nested items included. */
  written: string[];
  /** Fields the new item does not have, or whose control refused the value. */
  problems: string[];
  /** Items recreated in each widget directly inside this one: "Persons: 8 of 8". Deeper misses are in `problems`. */
  nested: { label: string; added: number; total: number }[];
  ok: boolean;
  reason: string | null;
}

export interface ParagraphOutcome {
  label: string;
  items: ItemOutcome[];
}

interface FillResult {
  written: string[];
  problems: string[];
  nested: { label: string; added: number; total: number }[];
}

/** The fields under `prefix` on the live form, by name relative to the item. */
function liveSlots(root: Document, absBase: string, delta: number): Map<string, FieldDescriptor> {
  const slots = new Map<string, FieldDescriptor>();
  const liveForm = findNodeForm(root);
  if (!liveForm) return slots;
  for (const field of walkForm(liveForm)) {
    const parsed = relativeName(absBase, field.machineName);
    if (parsed?.delta === delta) slots.set(parsed.relative, field);
  }
  return slots;
}

/** `field_person_position[und][1][value]` -> the field and the row it needs. */
const MULTI_ROW = /^([a-z0-9_]+)\[und\]\[(\d+)\]/;

/**
 * Writes one value, the way the top-level paste does.
 *
 * A reference inside an item — a Person's Symplr Profile — is looked up on THIS site
 * first. Written as copied it would carry the source site's node id, and Drupal would link
 * whatever node has that number here, with nothing on screen to say so.
 *
 * A rich text value is written and then AWAITED into its editor. Fire-and-forget was fine
 * for one item, but each nested add submits the form, and Drupal's editor integration
 * copies the editor's content over the textarea on the way out; an editor that had not
 * received the value yet would empty the Bio it was just given.
 */
async function writeItemField(target: FieldDescriptor, value: CapturedField['value']): Promise<{ ok: boolean; note?: string }> {
  const el = target.elements[0];
  if (el?.classList.contains('form-autocomplete')) {
    const resolved = await resolveReference(String(value), autocompletePathFor(target), true);
    if (!resolved.value) return { ok: true, note: resolved.note ?? 'not found on this site, so left empty' };
    return { ok: writeValue({ ...target, kind: 'autocomplete' }, resolved.value) };
  }

  const kind = effectiveKind(target);
  // Rich text: the textarea through writeValue as plain text, then the editor once, awaited.
  if (!writeValue({ ...target, kind: kind === 'wysiwyg' ? 'text' : kind }, value)) return { ok: false };
  if (kind === 'wysiwyg' && el?.id) {
    try {
      await chrome.runtime.sendMessage({ type: 'syncRichEditor', elementId: el.id, value: String(value) });
    } catch {
      // No bridge: the textarea already holds the value, which is all a plain one needs.
    }
  }
  return { ok: true };
}

/** True when a captured value has nothing in it worth writing. */
const blank = (value: CapturedField['value']) =>
  Array.isArray(value) ? value.length === 0 : typeof value === 'boolean' ? !value : String(value).trim() === '';

/**
 * Fills the item Drupal just rendered at `absBase[und][delta]`, then recreates everything
 * nested in it, depth first — a People List's people, each person's phones and emails.
 */
async function fillItem(
  absBase: string,
  delta: number,
  item: CapturedParagraph,
  root: Document
): Promise<FillResult> {
  const prefix = `${absBase}[und][${delta}]`;
  const result: FillResult = { written: [], problems: [], nested: [] };
  let slots = liveSlots(root, absBase, delta);

  for (const source of item.fields) {
    let target = slots.get(source.machineName);

    /**
     * A second Title on a person: the new item renders one row, so another has to be
     * asked for with the field's own "Add another item" first.
     */
    const row = source.machineName.match(MULTI_ROW);
    if (!target && row && Number(row[2]) > 0 && !blank(source.value)) {
      const anchor = [...slots.entries()].find(([name]) => name.startsWith(`${row[1]}[und][`))?.[1];
      for (let tries = 0; !target && anchor?.elements[0] && tries < Number(row[2]); tries++) {
        const added = await addAnotherRow(anchor.elements[0], `${prefix}[${row[1]}]`, 15000, root);
        if (!added.ok) break;
        slots = liveSlots(root, absBase, delta);
        target = slots.get(source.machineName);
      }
    }

    if (!target) {
      if (!blank(source.value)) result.problems.push(source.label || source.machineName);
      continue;
    }
    if (blank(source.value)) continue;

    const wrote = await writeItemField(target, source.value);
    if (wrote.ok) result.written.push(source.machineName);
    else result.problems.push(target.label || source.machineName);
  }

  for (const child of item.children ?? []) {
    const childBase = `${prefix}[${child.baseName}]`;
    const tally = { label: child.label, added: 0, total: child.items.length };

    /**
     * A new People List arrives with an empty Person already in it when Persons is
     * required. Those are used first, in order; only past them is another one asked for.
     */
    const waiting = deltasOf(findNodeForm(root) ?? root, childBase);
    for (const [index, childItem] of child.items.entries()) {
      const label = `${child.label} ${index + 1}`;
      if (!childItem.bundle) {
        result.problems.push(`${label}: its type could not be told, so it was not recreated`);
        continue;
      }

      let childDelta: number | null = null;
      if (index < waiting.length && (rowBundle(findNodeForm(root) ?? root, `${childBase}[und][${waiting[index]}]`) ?? childItem.bundle) === childItem.bundle) {
        childDelta = waiting[index];
      } else {
        const added = await addNestedItem(childBase, childItem.bundle, 15000, root);
        if (!added.ok || added.delta === null) {
          result.problems.push(`${label}: ${added.reason ?? 'not added'}`);
          continue;
        }
        childDelta = added.delta;
      }

      const filled = await fillItem(childBase, childDelta, childItem, root);
      tally.added++;
      result.written.push(...filled.written.map(name => `${child.baseName}[und][${childDelta}][${name}]`));
      result.problems.push(...filled.problems.map(problem => `${label}: ${problem}`));
    }
    result.nested.push(tally);
  }

  return result;
}

/**
 * Recreates a widget's items on the destination, in order, and everything nested in them.
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
        bundleLabel: item.bundleLabel, written: [], problems: [], nested: [], ok: false,
        reason: 'Could not tell what type of content item this is, so it was not recreated.',
      });
      continue;
    }

    const added = await addAnotherItem(captured.baseName, item.bundle, 15000, root);
    if (!added.ok || added.delta === null) {
      outcome.items.push({
        bundleLabel: item.bundleLabel, written: [], problems: [], nested: [], ok: false,
        reason: added.reason,
      });
      continue;
    }

    /**
     * Every read goes back to the live form: this item's fields did not exist when the
     * page was first walked, and Drupal's AJAX replaces the widget's wrapper on every add,
     * leaving earlier references detached. walkForm rather than discoverSchema, because
     * whether this is a node form was settled when its own button was pressed.
     */
    if (!findNodeForm(root)) {
      outcome.items.push({
        bundleLabel: item.bundleLabel, written: [], problems: [], nested: [], ok: false,
        reason: 'The form could not be read again after the item was added.',
      });
      continue;
    }

    const filled = await fillItem(captured.baseName, added.delta, item, root);
    outcome.items.push({
      bundleLabel: item.bundleLabel,
      written: filled.written,
      problems: filled.problems,
      nested: filled.nested,
      ok: filled.problems.length === 0,
      reason: filled.problems.length
        ? `Added, but ${filled.problems.length} part${filled.problems.length === 1 ? '' : 's'} did not take: ${filled.problems.join('; ')}.`
        : null,
    });
  }

  return outcome;
}

export { findParagraphWidgets };
