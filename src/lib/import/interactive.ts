/**
 * Reports interactive content the importer strips but cannot carry.
 *
 * `NOISE_SELECTORS` in extract.ts removes `form` and `script` wholesale, and nothing
 * counted or named the loss. A legacy calculator page therefore imported as clean prose
 * with its entire reason for existing missing, and the review said nothing.
 *
 * This does not attempt to port anything. It names what was dropped, which is the same
 * contract as the rest of the "Left for you" panel.
 */

import type { Unmapped } from './extract';

/** Containers whose forms are navigation furniture, not page content. */
const CHROME = 'nav, header, footer, aside, [role="search"]';

/** Control types that carry no data: buttons, and search boxes we deliberately ignore. */
const INERT_TYPES = new Set(['submit', 'button', 'reset', 'image', 'search', 'hidden']);

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function contentControls(form: Element): Element[] {
  return Array.from(form.querySelectorAll('input, select, textarea')).filter(control => {
    if (control.tagName.toLowerCase() !== 'input') return true;
    const type = (control.getAttribute('type') ?? 'text').toLowerCase();
    return !INERT_TYPES.has(type);
  });
}

/**
 * A form worth reporting.
 *
 * The >= 2 threshold is doing the real work, not the type list. Drupal's search block is
 * `<input type="text" name="search_block_form">` plus a submit — excluding `type="search"`
 * would not touch it, and it can sit in a `<div id="header">` that no element-name chrome
 * selector catches. What separates it from a calculator is that it asks one question.
 *
 * The cost is a genuine single-field calculator going unreported. Accepted: a rule that
 * fires on every page in the site would be ignored within a week, which is strictly worse
 * than a rule with a known gap.
 */
function isContentForm(form: Element): boolean {
  if (form.closest(CHROME)) return false;
  return contentControls(form).length >= 2;
}

/**
 * Scripts sharing an origin with the source page.
 *
 * Origin, not position: both calculators load their logic from the end of <body>, outside
 * any article container, so location tells us nothing. A protocol-relative CDN URL such as
 * `//ajax.googleapis.com/...` resolves against the source's scheme and lands on a different
 * origin, which is how third-party libraries stay out of this list.
 */
function firstPartyScripts(doc: Document, sourceUrl: string): string[] {
  let base: URL;
  try { base = new URL(sourceUrl); } catch { return []; }

  const found: string[] = [];
  for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
    const raw = norm(script.getAttribute('src'));
    if (!raw) continue;
    try {
      if (new URL(raw, base).origin !== base.origin) continue;
    } catch { continue; }
    found.push(raw);
  }
  return [...new Set(found)];
}

/**
 * The nearest heading before the element, for naming the finding.
 *
 * Headings inside <noscript> are excluded deliberately: both calculator pages open with
 * `<noscript><h2>This calculator requires Javascript.</h2></noscript>`, which sits between
 * the h1 and the form and would otherwise win.
 */
function headingFor(el: Element, doc: Document): string {
  const headings = Array.from(doc.querySelectorAll('h1, h2, h3'))
    .filter(h => !h.closest('noscript'));

  let best = '';
  for (const heading of headings) {
    if (el.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_PRECEDING) {
      best = norm(heading.textContent);
    }
  }
  return best
    || norm(doc.querySelector('h1:not(noscript h1)')?.textContent)
    || norm(doc.title)
    || 'this page';
}

/** "A form with 4 text inputs, 1 dropdown" — what the editor would have seen. */
function describeForm(form: Element): string {
  const texts = contentControls(form).filter(
    c => c.tagName.toLowerCase() === 'input'
      && (c.getAttribute('type') ?? 'text').toLowerCase() === 'text'
  ).length;
  const selects = form.querySelectorAll('select').length;
  const radioGroups = new Set(
    Array.from(form.querySelectorAll('input[type="radio"]')).map(r => r.getAttribute('name'))
  ).size;

  const parts = [
    texts ? `${texts} text input${texts === 1 ? '' : 's'}` : null,
    selects ? `${selects} dropdown${selects === 1 ? '' : 's'}` : null,
    radioGroups ? `${radioGroups} option group${radioGroups === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  return parts.length ? `A form with ${parts.join(', ')}` : 'A form';
}

export function findInteractive(doc: Document, sourceUrl: string): Unmapped[] {
  const form = Array.from(doc.querySelectorAll('form')).find(isContentForm) ?? null;
  if (!form) return [];

  const scripts = firstPartyScripts(doc, sourceUrl);
  const driven = scripts.length ? ` driven by ${scripts.join(' and ')}` : '';

  return [{
    label: `Interactive content — “${headingFor(form, doc)}”`,
    reason: `${describeForm(form)}${driven}. Forms and scripts cannot live in a node body; `
      + `this needs a Full HTML block or a module.`,
  }];
}
