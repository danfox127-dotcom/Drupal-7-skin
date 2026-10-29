/**
 * A draft body reduced to the markup it may carry into Drupal's editor.
 *
 * The same allow-list as Varys's `safe_body_html` (backend/app/services/draft_review.py), which
 * every draft already passes through before it leaves Varys. Applied again here, just before
 * CKEditor's setData, because the editor's page is published: a body that did not come through
 * that path (a compromised Varys, or an account someone else connected this extension to) must
 * still not put script into it.
 *
 * Allowed: p, h2, h3, ul, ol, li, strong, em, br, a. On `a` only an http, https, mailto or tel
 * href survives; any other link is unwrapped and keeps its words. Script-bearing and raw-text
 * elements go with their content; every other element is unwrapped, keeping its text. Nothing
 * else keeps an attribute, and comments are dropped. The tree is REBUILT from what is allowed
 * rather than edited, and text is copied as text, so nothing escaped can become markup.
 */

const ALLOWED = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'br', 'a']);

const DROPPED_WITH_CONTENT = new Set([
  'script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math',
  'textarea', 'title', 'xmp', 'noembed', 'noframes', 'select', 'head',
]);

/** Matched against the attribute as written, so `java\tscript:` fails by not matching. */
const SAFE_HREF = /^(?:https?|mailto|tel):/i;

function rebuild(source: Node, into: Node, doc: Document): void {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(doc.createTextNode(child.nodeValue ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.localName.toLowerCase();
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || DROPPED_WITH_CONTENT.has(tag)) continue;
    if (!ALLOWED.has(tag)) {
      rebuild(el, into, doc);
      continue;
    }
    if (tag === 'a') {
      const href = (el.getAttribute('href') ?? '').trim();
      if (!SAFE_HREF.test(href)) {
        rebuild(el, into, doc);
        continue;
      }
      const a = doc.createElement('a');
      a.setAttribute('href', href);
      rebuild(el, a, doc);
      into.appendChild(a);
      continue;
    }
    const copy = doc.createElement(tag);
    rebuild(el, copy, doc);
    into.appendChild(copy);
  }
}

export function safeBodyHtml(html: string | null | undefined): string {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html ?? ''}`, 'text/html');
  const out = document.implementation.createHTMLDocument('');
  const root = out.createElement('div');
  rebuild(parsed.body, root, out);
  return root.innerHTML;
}
