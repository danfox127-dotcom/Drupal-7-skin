import { detectContentType } from '../lib/formSchema';
import { nodeIdFromPath } from '../lib/extractPublicHtml';
import { NEVER_CLICK, submitLabel } from '../lib/fieldBinding';
import {
  bodyChangeRatio, buttonKind, pageStateFrom, textOfHtml,
  type RawFormValues, type VarysFormOpenedMessage, type VarysFormOpenedResponse, type VarysSubmitMessage,
} from '../lib/varys/pageState';
import type { ReadRichEditorResponse } from '../background';
import type { VarysStatus, VarysStatusRequest } from '../lib/varys/connection';

/**
 * Recording a node form's before and after, for Varys.
 *
 * Only when this person has connected the extension to Varys, and only ever as a bystander:
 * the form is read when it opens and again as it is saved, and the pair is handed to the
 * service worker, which posts it. Nothing here delays, changes or cancels Drupal's own Save.
 *
 * Type-only imports from the connection module, on purpose. The stored connection holds the
 * key, which only the service worker may read; this file asks the worker for a status.
 */

/** Set on the form while a capture is listening, so a test can tell it from an idle page. */
export const CAPTURE_MARK = 'data-d7-varys-capture';

/**
 * The body's textarea, found by its field name rather than its id. Drupal derives the id
 * from the name (edit-body-und-0-value) but suffixes it when an AJAX rebuild leaves a twin in
 * the page (edit-body-und-0-value--2); the name does not move, and the id read off the
 * element found is the one the rich editor is registered under.
 */
const BODY_FIELD = 'textarea[name="body[und][0][value]"]';

/**
 * Whether this browser is connected to Varys, as the worker says.
 *
 * Connected means a status came back and it is not expired. An expired key cannot post, so
 * recording for it would only queue saves that are never sent. Any failure to ask (a worker
 * that does not answer, an invalidated context) is "not connected": the safe answer is to do
 * nothing.
 */
export async function varysIsConnected(): Promise<boolean> {
  try {
    const status: VarysStatus | null | undefined = await chrome.runtime.sendMessage(
      { type: 'varysStatus' } satisfies VarysStatusRequest);
    return status?.expired === false;
  } catch {
    return false;
  }
}

const bodyTextarea = (form: HTMLFormElement) =>
  form.querySelector<HTMLTextAreaElement>(BODY_FIELD);

const isStringOrNull = (v: unknown) => v === null || typeof v === 'string';

/**
 * Whether the worker's answer is a set of form values for this site. It came from this
 * extension, but from storage that outlives a version of it, so its shape is checked before
 * it replaces anything.
 */
function isRawFormValues(v: unknown): v is RawFormValues {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.title === 'string' && isStringOrNull(r.metaTitle) && isStringOrNull(r.metaDescription)
    && isStringOrNull(r.alias) && typeof r.pathauto === 'boolean' && typeof r.bodyHtml === 'string'
    && r.host === window.location.host;
}

/**
 * The form's values, read by field name.
 *
 * `title_field` is what the live sites call the title; an older form calls it `title`. A
 * field the form does not have is null, never an empty string, so "no search title field"
 * and "a search title left blank" stay apart. Disabled fields are read too: the alias box
 * is disabled while pathauto is on, and the caller needs to see both facts.
 */
export function readRawValues(form: HTMLFormElement, bodyHtml: string): RawFormValues {
  const value = (name: string) =>
    form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value ?? null;

  return {
    title: value('title_field[und][0][value]') ?? value('title') ?? '',
    metaTitle: value('metatags[und][title][value]'),
    metaDescription: value('metatags[und][description][value]'),
    alias: value('path[alias]'),
    pathauto: form.querySelector<HTMLInputElement>('[name="path[pathauto]"]')?.checked === true,
    bodyHtml,
    host: window.location.host,
  };
}

/**
 * The body as the editor holds it, which is not what the textarea holds until Save.
 *
 * CKEditor keeps its content in its own object and copies it to the textarea on submit, so
 * the textarea of an open form is the body as the page LOADED. The editor lives in the
 * page's JavaScript world, so it is read through the worker (see readRichEditor there). The
 * textarea is the answer when there is no editor, no answer, or the worker cannot be reached.
 */
export async function readBodyHtml(form: HTMLFormElement): Promise<string> {
  const textarea = bodyTextarea(form);
  if (!textarea) return '';
  try {
    const res: ReadRichEditorResponse | undefined = await chrome.runtime.sendMessage({
      type: 'readRichEditor', elementId: textarea.id,
    });
    if (res?.ok && res.editor !== 'none' && typeof res.value === 'string') return res.value;
  } catch {
    // No bridge (an invalidated context); the textarea is the best answer left.
  }
  return textarea.value;
}

/**
 * The first tab that is the page itself: not an edit tab, not one of the node's sub-pages, and
 * on this host. A tab pointing at another host is not this page, whatever it is called.
 */
function viewTab(anchors: HTMLAnchorElement[], base: string, host: string): string | null {
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (url.host !== host) continue;
    const path = url.pathname.replace(/\/+$/, '');
    // /node/N/edit, but also /node/N/revisions, /node/N/devel and an aliased .../edit.
    if (/\/edit$/.test(path) || /^\/node\/\d+\//.test(path)) continue;
    return url.origin + url.pathname;
  }
  return null;
}

/**
 * The page's public address, which is what Varys tracks. Never the edit form's.
 *
 * The View tab, when the page has one, because it carries the page's alias. Otherwise
 * /node/<id>, which Drupal serves for every node and redirects to the alias. An add form
 * has no page yet: null, and the worker works the address out from where Save lands.
 */
export function publicUrlFor(
  location: Pick<Location, 'pathname' | 'host'> & Partial<Pick<Location, 'protocol'>>,
  doc: Document,
): string | null {
  const nodeId = nodeIdFromPath(location.pathname);
  if (nodeId === null) return null;

  const scheme = location.protocol === 'http:' ? 'http:' : 'https:';
  const base = `${scheme}//${location.host}${location.pathname}`;

  for (const selector of ['ul.tabs.primary a', '.tabs a']) {
    const tab = viewTab(Array.from(doc.querySelectorAll<HTMLAnchorElement>(selector)), base, location.host);
    if (tab) return tab;
  }
  return `${scheme}//${location.host}/node/${nodeId}`;
}

/**
 * Starts recording this form.
 *
 * Nothing is awaited by the save. The form's own values are read now, synchronously, so a
 * save at any moment has a before to send; the body is then re-read from the rich editor
 * once `editorsReady` settles, since the editor holds the body in a normalised form and is
 * the more faithful copy. (The two read the same words, which is all that is compared.)
 *
 * The listener is on `document`, in the BUBBLE phase, deliberately. CKEditor writes its
 * content to the textarea from a submit handler on the form itself, and a bubble listener
 * on `document` runs after it, so the textarea already holds the final body and the after
 * values can be read without waiting. A capture-phase listener would see the page as it was
 * before the editor's last keystroke was copied over.
 *
 * It never calls preventDefault, never awaits before sending, and never lets a fault of its
 * own out: a save that Varys cannot be told about is still a save.
 *
 * Once the before is settled the worker is told the form opened (`varysFormOpened`), and it
 * answers with the values the form FIRST opened with in this tab. They differ when this page
 * is a re-render: Drupal's Preview and a save that failed validation both come back to the
 * same edit form filled with what was submitted, which is not what the page held. The answer
 * is then adopted as the before, so the before, the body comparison and the new sentences are
 * all measured against the page as it really was. (The worker also puts its first before into
 * the save itself, so a Save before this answer arrives is still sent with it.)
 */
export function mountVarysCapture(
  form: HTMLFormElement,
  editorsReady: Promise<unknown> = Promise.resolve(),
): void {
  const formPath = window.location.pathname;
  const isNew = nodeIdFromPath(formPath) === null;
  // Set at Save. After it, the before is final, and this page has nothing more to announce.
  let saved = false;

  let before = readRawValues(form, bodyTextarea(form)?.value ?? '');

  const announceOpened = async () => {
    if (saved) return;
    const message: VarysFormOpenedMessage = {
      type: 'varysFormOpened',
      formPath,
      before: isNew ? null : pageStateFrom(before, null),
      raw: before,
    };
    const answer: VarysFormOpenedResponse | null | undefined = await chrome.runtime.sendMessage(message);
    if (!saved && isRawFormValues(answer?.raw)) before = answer.raw;
  };

  void editorsReady
    .then(() => readBodyHtml(form))
    .then(html => { before = { ...before, bodyHtml: html }; })
    .catch(() => undefined)
    .then(announceOpened)
    // No worker, or a context that has gone: this page's own before stands.
    .catch(() => undefined);

  document.addEventListener('submit', event => {
    try {
      // Another form on the page, or a submit something else has already stopped.
      if (event.target !== form || event.defaultPrevented) return;

      // A submitter is a button; with none (requestSubmit() alone) it is a plain save.
      const submitter = (event as SubmitEvent).submitter as HTMLInputElement | HTMLButtonElement | null;
      // Attach, Add another item and the like are not named `op`: they work the form, not save it.
      if (submitter && submitter.name !== 'op') return;
      const label = submitter ? submitLabel(submitter) : '';
      if (NEVER_CLICK.test(label)) return;

      const after = readRawValues(form, bodyTextarea(form)?.value ?? '');
      const message: VarysSubmitMessage = {
        type: 'varysSubmit',
        formPath: window.location.pathname,
        pageUrl: publicUrlFor(window.location, document),
        nodeId: nodeIdFromPath(window.location.pathname),
        contentType: detectContentType().contentType,
        button: buttonKind(label),
        isNew,
        before: isNew ? null : pageStateFrom(before, null),
        after: pageStateFrom(after, before.bodyHtml),
        bodyChangeRatio: bodyChangeRatio(textOfHtml(before.bodyHtml), textOfHtml(after.bodyHtml)),
      };

      saved = true;
      // Fire and forget. A worker that is not there answers with a rejection, and nobody is
      // waiting on it.
      Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => undefined);
    } catch (err) {
      // Recording is an extra. Whatever went wrong, Drupal's Save carries on; it is only said.
      console.warn('[D7 Studio] Varys capture failed', err);
    }
  });

  form.setAttribute(CAPTURE_MARK, '');
}
