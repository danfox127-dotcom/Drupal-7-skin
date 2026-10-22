/**
 * What Varys is told about a Drupal page when someone saves it: the page as it stood when
 * the form opened, and as it stands at Save.
 *
 * Pure, and free of any extension API. Reading a form is src/content/varysCapture.ts; this
 * file turns what was read into the PageState Varys expects (snake_case, because it is
 * posted as it is), and says how much of the body changed.
 *
 * The body is HTML from the rich editor. It is parsed in a <template>, whose content is
 * inert: nothing in it loads or runs, so markup from a paste can be read safely. The same
 * trick is in stripSpans.ts.
 *
 * Full body text never leaves the browser. Varys is sent how many words there are, how much
 * of the body changed, and up to three sentences that are new, which are the only way to
 * confirm a body-only edit went live.
 */

export interface PageState {
  title: string;
  /** Raw values: tokens such as [node:title] are kept, as typed. */
  meta_title: string | null;
  meta_description: string | null;
  /** No leading slash. Null when the alias is generated (pathauto) or blank. */
  alias: string | null;
  /** The body's h2 and h3, in order. */
  headings: { level: 2 | 3; text: string }[];
  /** Internal body links as paths, once each, in order. */
  links: string[];
  body_words: number;
  /** At most three, each at most 200 characters: sentences in this body and not the before. */
  new_sentences: string[];
}

/** What was read off the form, before it is turned into a PageState. */
export interface RawFormValues {
  title: string;
  /** Null when the form has no such field, which is not the same as an empty one. */
  metaTitle: string | null;
  metaDescription: string | null;
  alias: string | null;
  pathauto: boolean;
  bodyHtml: string;
  /** The site's host, for telling an internal link from an external one. */
  host: string;
}

export type ButtonKind = 'publish' | 'draft' | 'save';

/**
 * The message the content script gives the service worker when a node form is saved.
 *
 * `before` is always present and is null for a new node: Varys diffs a new node against an
 * empty page and reads a missing key as a malformed request. The worker maps the top-level
 * keys to the API's snake_case; the PageStates are already in that shape.
 */
export interface VarysSubmitMessage {
  type: 'varysSubmit';
  /** The form's own path, e.g. /node/23110/edit, so the save can be followed from it. */
  formPath: string;
  /** The page's public address, never the edit form's. Null on an add form. */
  pageUrl: string | null;
  nodeId: string | null;
  contentType: string | null;
  button: ButtonKind;
  isNew: boolean;
  before: PageState | null;
  after: PageState;
  bodyChangeRatio: number;
}

export function buttonKind(label: string): ButtonKind {
  if (/publish/i.test(label)) return 'publish';
  if (/draft/i.test(label)) return 'draft';
  return 'save';
}

// ------------------------------------------------------------------------ the body's text

/**
 * Elements that start a new line of text. A bare `textContent` joins `<p>one</p><p>two</p>`
 * into "onetwo", which would count one word and read two sentences as one.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
  'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH',
  'THEAD', 'TR', 'UL',
]);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The text under `root`, one entry per block, whitespace collapsed, empty blocks dropped. */
function blocksOf(root: Node): string[] {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === TEXT_NODE) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const tag = (node as Element).tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') return;
    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push('\n');
    node.childNodes.forEach(walk);
    if (block) parts.push('\n');
  };
  root.childNodes.forEach(walk);
  return parts.join('').split('\n').map(collapse).filter(Boolean);
}

function parseBody(html: string, doc: Document): DocumentFragment {
  const template = doc.createElement('template');
  template.innerHTML = html;
  return template.content;
}

/** Letters and digits, with an inner apostrophe or hyphen kept: "don't" and "well-known" are one word. */
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const wordsIn = (text: string): string[] => text.match(WORD) ?? [];

/** A body's text as plain lines, for measuring how much of it changed. */
export function textOfHtml(html: string, doc: Document = document): string {
  return blocksOf(parseBody(html, doc)).join('\n');
}

// ------------------------------------------------------------------------ how much changed

/** Word 3-grams, lowercased. Under three words there is one gram: all of them. */
function grams(text: string): Set<string> {
  const words = wordsIn(text.toLowerCase());
  if (words.length === 0) return new Set();
  if (words.length < 3) return new Set([words.join(' ')]);
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/**
 * How much of a body changed, from 0 (the same) to 1 (nothing in common): the Jaccard
 * distance between the two texts' word 3-gram sets.
 *
 * Three-word runs rather than single words, so moving paragraphs about counts as little and
 * rewording counts as much. Case and punctuation are not changes. When one side is empty and
 * the other is not, it is 1; two empty sides are 0.
 */
export function bodyChangeRatio(beforeText: string, afterText: string): number {
  const a = grams(beforeText);
  const b = grams(afterText);
  if (a.size === 0 && b.size === 0) return 0;
  if (a.size === 0 || b.size === 0) return 1;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return 1 - shared / (a.size + b.size - shared);
}

// ---------------------------------------------------------------------------- the PageState

const MAX_NEW_SENTENCES = 3;
const MAX_SENTENCE_CHARS = 200;
const MIN_SENTENCE_WORDS = 6;

/** The body's sentences, in order. A block ends a sentence whether or not it has a full stop. */
const sentencesOf = (blocks: string[]): string[] =>
  blocks.flatMap(block => block.split(/(?<=[.!?])\s+/)).map(s => s.trim()).filter(Boolean);

const key = (s: string) => collapse(s).toLowerCase();

/**
 * Sentences in the after body that the before body does not contain.
 *
 * "Contain" is a substring test on the before body's whole text, not a match against its
 * sentences, so a sentence survives being re-wrapped, re-cased or split across two
 * paragraphs. Short fragments (headings, a list's "Call us.") are not sentences worth
 * looking for on the live page, and a long one is cut: Varys looks for the cut text, which
 * is still inside the live sentence.
 */
function newSentences(afterBlocks: string[], beforeBlocks: string[] | null): string[] {
  if (beforeBlocks === null) return [];
  const before = key(beforeBlocks.join(' '));
  const found: string[] = [];
  for (const sentence of sentencesOf(afterBlocks)) {
    if (found.length === MAX_NEW_SENTENCES) break;
    if (wordsIn(sentence).length < MIN_SENTENCE_WORDS) continue;
    if (before.includes(key(sentence))) continue;
    const cut = sentence.slice(0, MAX_SENTENCE_CHARS).trimEnd();
    if (!found.includes(cut)) found.push(cut);
  }
  return found;
}

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '');

/**
 * Links in the body that point at pages on this site, as paths, once each, in order.
 *
 * A path and nothing else: the query string and fragment do not name a different page, and
 * Varys compares paths. `www.` is not part of a site's identity here, which is how Varys
 * lists hosts too. mailto:, tel:, javascript: and in-page `#` links are not pages.
 */
function internalLinks(root: ParentNode, host: string): string[] {
  const here = bareHost(host);
  const paths: string[] = [];
  for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
    const href = (anchor.getAttribute('href') ?? '').trim();
    if (href === '' || href.startsWith('#')) continue;
    let url: URL;
    try {
      url = new URL(href, 'https://' + host + '/');
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (bareHost(url.host) !== here) continue;
    if (!paths.includes(url.pathname)) paths.push(url.pathname);
  }
  return paths;
}

/**
 * Turns what was read off a form into a PageState.
 *
 * `beforeBodyHtml` is the body the form opened with, for finding the new sentences. Pass
 * null for the before state itself, which has none; pass '' for a page that began empty, so
 * its first sentences are the new ones.
 */
export function pageStateFrom(
  raw: RawFormValues,
  beforeBodyHtml: string | null,
  doc: Document = document,
): PageState {
  const body = parseBody(raw.bodyHtml, doc);
  const blocks = blocksOf(body);

  const headings: PageState['headings'] = [];
  for (const el of Array.from(body.querySelectorAll('h2, h3'))) {
    const text = collapse(blocksOf(el).join(' '));
    if (text !== '') headings.push({ level: el.tagName === 'H2' ? 2 : 3, text });
  }

  const alias = raw.pathauto ? null : (raw.alias ?? '').trim().replace(/^\/+/, '') || null;

  return {
    title: raw.title,
    meta_title: raw.metaTitle,
    meta_description: raw.metaDescription,
    alias,
    headings,
    links: internalLinks(body, raw.host),
    body_words: wordsIn(blocks.join(' ')).length,
    new_sentences: newSentences(
      blocks, beforeBodyHtml === null ? null : blocksOf(parseBody(beforeBodyHtml, doc))),
  };
}
