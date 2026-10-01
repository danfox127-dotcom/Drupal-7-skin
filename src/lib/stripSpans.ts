/**
 * Removes every <span> from a piece of HTML, keeping what was inside it.
 *
 * Spans are what pasting from Word, Google Docs or another web page leaves behind:
 * `<span style="font-family: Calibri; font-size: 11pt">` around every run of text. They
 * carry nothing the site's own styles want, and they fight them. Unwrapped rather than
 * deleted, because the text inside a span is content.
 *
 * Parsed in a <template>, whose content is inert: nothing in it loads or runs, so markup
 * from a paste can be handled safely.
 *
 * `removed` is reported so a caller can say what happened, and so it can leave the field
 * untouched when there was nothing to remove: a round trip through the DOM re-serialises
 * the markup (`<br />` comes back as `<br>`), which is harmless but is still a change
 * nobody asked for.
 */
export function stripSpans(html: string, doc: Document = document): { html: string; removed: number } {
  const template = doc.createElement('template');
  template.innerHTML = html;

  const spans = Array.from(template.content.querySelectorAll('span'));
  for (const span of spans) span.replaceWith(...Array.from(span.childNodes));

  return { html: spans.length ? template.innerHTML : html, removed: spans.length };
}
