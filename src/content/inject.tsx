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
