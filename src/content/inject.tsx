import React from 'react';
import ReactDOM from 'react-dom/client';
import stylesheet from '../styles/main.css?inline';
import { baseNameOf } from '../lib/formSchema/walkForm';

/**
 * One parsed stylesheet shared by every shadow root via `adoptedStyleSheets`.
 *
 * Previously each root got its own <style> element holding the whole compiled
 * sheet — fine for three injections, but D7 Studio adds several more surfaces
 * per page and that duplicates the full ~18KB of CSS into each one, parsed
 * separately every time. A single constructed sheet is parsed once and shared by
 * reference.
 *
 * Built lazily so a browser without CSSStyleSheet support (or a parse failure)
 * falls back per root rather than throwing at module load.
 */
let sharedSheet: CSSStyleSheet | null | undefined;

function getSharedSheet(): CSSStyleSheet | null {
  if (sharedSheet !== undefined) return sharedSheet;

  // `adoptedStyleSheets` needs both the constructor and the array to be
  // writable; Chrome has supported both since 99, but content scripts can run
  // in older embedded views.
  const supported =
    typeof CSSStyleSheet !== 'undefined' &&
    'replaceSync' in CSSStyleSheet.prototype &&
    'adoptedStyleSheets' in ShadowRoot.prototype;

  if (!supported) {
    sharedSheet = null;
    return sharedSheet;
  }

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(stylesheet);
    sharedSheet = sheet;
  } catch (err) {
    console.warn('[D7 Proxy] Could not build shared stylesheet, falling back to <style>', err);
    sharedSheet = null;
  }

  return sharedSheet;
}

function applyStyles(shadow: ShadowRoot) {
  const sheet = getSharedSheet();

  if (sheet) {
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    return;
  }

  const style = document.createElement('style');
  style.textContent = stylesheet;
  shadow.appendChild(style);
}

/**
 * Mounts a component in its own shadow root appended to <body>.
 *
 * Overlays (the command palette, toasts) cannot live inside another component's
 * root: a fixed-position scrim is clipped by any ancestor with a transform or
 * overflow, and Drupal's admin theme has plenty of both. Appending to body keeps
 * the containing block the viewport.
 *
 * Returns a handle so the caller can unmount — an overlay's lifetime is driven by
 * open/close, unlike the injected form widgets which live as long as the page.
 */
export function injectOverlay(component: React.ReactNode) {
  const container = document.createElement('div');
  container.className = 'd7-proxy-ui-overlay';
  container.id = `d7-proxy-ui-overlay-${crypto.randomUUID()}`;
  document.body.appendChild(container);

  const shadow = container.attachShadow({ mode: 'open' });
  applyStyles(shadow);

  const rootElement = document.createElement('div');
  shadow.appendChild(rootElement);

  const root = ReactDOM.createRoot(rootElement);
  root.render(<React.StrictMode>{component}</React.StrictMode>);

  return {
    root,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

/**
 * Mounts a component as the form's own first child, so native widgets can be moved
 * into it and still be submitted.
 *
 * Three constraints force this shape, and they are worth stating because the obvious
 * approaches all fail:
 *
 *  1. A form control is only submitted when it is a DESCENDANT of the form (absent a
 *     `form=` attribute, which Drupal does not set). So a widget relocated into an
 *     overlay that sits beside the form silently stops saving.
 *  2. You cannot reveal a descendant of a `display:none` ancestor — the subtree is gone
 *     from rendering. So the form cannot be hidden wholesale if any of its widgets need
 *     to stay visible.
 *  3. Page CSS does not cross a shadow boundary, so a widget moved INTO the shadow root
 *     would render unstyled. Slotted light-DOM children keep page styling, which is
 *     exactly what `<slot>` is for.
 *
 * Hence: host inside the form, siblings hidden individually, widgets relocated as
 * light-DOM children of the host and projected into the layout through named slots.
 */
export function injectInsideForm(form: HTMLFormElement, component: React.ReactNode) {
  const container = document.createElement('div');
  container.className = 'd7-proxy-ui-container d7-proxy-ui-form-host';
  container.id = `d7-proxy-ui-${crypto.randomUUID()}`;

  form.insertBefore(container, form.firstChild);

  // Hide the form's original content, but not the form itself — see constraint 2.
  const hidden: HTMLElement[] = [];
  for (const child of Array.from(form.children)) {
    if (child === container) continue;
    const el = child as HTMLElement;
    hidden.push(el);
    el.dataset.d7Hidden = 'true';
    el.style.display = 'none';
  }

  const shadow = container.attachShadow({ mode: 'open' });
  applyStyles(shadow);

  const rootElement = document.createElement('div');
  shadow.appendChild(rootElement);

  const root = ReactDOM.createRoot(rootElement);
  root.render(<React.StrictMode>{component}</React.StrictMode>);

  return {
    container,
    root,
    /** Restores the form to its original state. */
    restore() {
      root.unmount();
      hidden.forEach(el => {
        el.style.display = '';
        delete el.dataset.d7Hidden;
      });
      container.remove();
    },
  };
}

/** Slot name for a field, stable and safe as an attribute value. */
export function slotNameFor(machineName: string): string {
  return `field-${machineName.replace(/[^a-z0-9]/gi, '-')}`;
}

/**
 * Moves a native widget into the overlay host so Drupal's own control stays usable.
 *
 * Used for widgets that cannot be responsibly reimplemented — media/file pickers need
 * Drupal's AJAX upload flow and media browser; Paragraphs needs its add-more AJAX. The
 * element and its handlers are untouched; only its parent changes, and it remains inside
 * the form, so Drupal's ajax framework still finds the form via closest().
 *
 * Returns the slot name on success, or null when no wrapper could be identified — in
 * which case the caller should fall back to rendering a note.
 */
/**
 * Finds the outermost wrapper that belongs to THIS field and nothing else.
 *
 * Taking the nearest `.form-item` is not enough for a multi-value field: Drupal puts each
 * delta in its own `.form-item` inside a table, with the "Add another item" button as a
 * SIBLING of that table. Relocating only the inner item leaves the Add button behind in
 * the hidden form content, so an editor could type one related item and never add a
 * second — which is most of the point of the field.
 *
 * So it climbs while every control inside the candidate still belongs to this field, by
 * name prefix. That keeps the deltas, the row-weight selects and the add-more button
 * together, and stops before swallowing a neighbouring field.
 */
function widgetWrapperFor(element: HTMLElement, baseName: string): HTMLElement | null {
  let best = (element.closest<HTMLElement>('.form-item') ?? element.parentElement) as HTMLElement | null;
  if (!best) return null;

  /**
   * Whether a control belongs to this field.
   *
   * A plain prefix test is not enough, and getting it wrong is what made a chosen image
   * never appear. The Media module names its launcher `media[field_image_teaser_und_0]`
   * while its siblings — the hidden fid, the preview, the Remove button — are named
   * `field_image_teaser[und][0][fid]`. Since baseName is `field_image_teaser`, the
   * launcher's own name does not start with it, so the climb broke at the very first
   * step and relocated only the innermost .form-item.
   *
   * Everything else stayed behind, INCLUDING Drupal's AJAX wrapper. So when Media
   * answered a selection by replacing that wrapper with the thumbnail markup, the
   * replacement landed in the part of the form we had hidden: the file attached and saved
   * correctly, and the editor simply never showed it as selected.
   *
   * Normalising through baseNameOf makes `media[x_und_0]` and `x[und][0][fid]` both
   * resolve to `x`, so they are recognised as the same field — while a neighbouring
   * field still resolves differently and stops the climb.
   */
  const belongsToField = (name: string) =>
    name.startsWith(baseName) || baseNameOf(name) === baseName;

  let node = best.parentElement;
  while (node && node.tagName !== 'FORM' && !node.classList.contains('d7-proxy-ui-form-host')) {
    const names = Array.from(node.querySelectorAll<HTMLElement>('input, select, textarea'))
      .map(el => (el as HTMLInputElement).name)
      .filter(Boolean);

    if (names.length === 0 || !names.every(belongsToField)) break;

    best = node;
    node = node.parentElement;
  }

  return best;
}

export function relocateWidget(
  host: HTMLElement,
  element: HTMLElement,
  machineName: string,
  baseName: string
): string | null {
  const wrapper = widgetWrapperFor(element, baseName);
  if (!wrapper || wrapper === host || host.contains(wrapper)) return null;

  const slot = slotNameFor(machineName);

  // Undo the blanket hide applied to the form's children if this wrapper happened to be
  // one of them.
  wrapper.style.display = '';
  delete wrapper.dataset.d7Hidden;

  /**
   * The slot attribute goes on a carrier WE own, not on Drupal's element.
   *
   * Drupal's AJAX commonly answers an interaction by replacing the widget wrapper
   * outright (`replaceWith` on its ajax-wrapper id). A slot attribute set on that element
   * goes with it, and the fresh markup — the thumbnail, the Remove button — arrives with
   * no slot, which means the browser does not render it at all: an unslotted light-DOM
   * child of a shadow host is invisible. Owning the carrier keeps the projection stable
   * across as many AJAX round trips as the widget cares to make.
   */
  const carrier = document.createElement('div');
  carrier.setAttribute('slot', slot);
  carrier.className = 'd7-relocated-widget';
  carrier.appendChild(wrapper);
  host.appendChild(carrier);

  return slot;
}

export function injectComponent(
  targetElement: HTMLElement,
  component: React.ReactNode,
  position: 'before' | 'after' | 'replace' = 'before'
) {
  const container = document.createElement('div');
  container.className = 'd7-proxy-ui-container';
  container.id = `d7-proxy-ui-${crypto.randomUUID()}`;

  if (position === 'before') {
    targetElement.parentNode?.insertBefore(container, targetElement);
  } else if (position === 'after') {
    targetElement.parentNode?.insertBefore(container, targetElement.nextSibling);
  } else {
    targetElement.parentNode?.replaceChild(container, targetElement);
  }

  const shadow = container.attachShadow({ mode: 'open' });

  applyStyles(shadow);

  // Root element for React
  const rootElement = document.createElement('div');
  shadow.appendChild(rootElement);

  const root = ReactDOM.createRoot(rootElement);
  root.render(<React.StrictMode>{component}</React.StrictMode>);

  return root;
}
