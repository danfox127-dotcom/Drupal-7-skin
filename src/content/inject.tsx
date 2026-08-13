import React from 'react';
import ReactDOM from 'react-dom/client';
import stylesheet from '../styles/main.css?inline';

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
export function relocateWidget(
  host: HTMLElement,
  element: HTMLElement,
  machineName: string
): string | null {
  const wrapper = element.closest<HTMLElement>(
    '.form-item, .field-widget, .field-type-image, .field-type-file, .field-type-paragraphs'
  );
  if (!wrapper || wrapper === host || host.contains(wrapper)) return null;

  const slot = slotNameFor(machineName);
  wrapper.setAttribute('slot', slot);

  // Undo the blanket hide applied to the form's children if this wrapper happened to be
  // one of them, then reparent it.
  wrapper.style.display = '';
  delete wrapper.dataset.d7Hidden;
  host.appendChild(wrapper);

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
