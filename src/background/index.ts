/**
 * Service worker: the cross-origin fetch the import flow needs, the rich-editor bridge, the
 * update check, and, once someone connects it, everything that talks to Varys (see "Varys:
 * following a save" below).
 *
 * Why it exists: a content script runs in the page's origin and cannot read a
 * foreign site, so migration source pages must be fetched from the extension's own
 * context. The handoff says as much.
 *
 * Why the permission is optional: source domains for a migration cannot be
 * enumerated in advance — that is the whole point of "paste any URL" — but requesting
 * all-URLs access at install time would show every user a frightening all-sites prompt
 * for a feature most never touch. So it lives in `optional_host_permissions` and
 * is requested from the popup on first use, where a user gesture is available.
 * chrome.permissions.request() cannot be called from a service worker or a content
 * script, which is why the popup asks and the worker only fetches.
 */

import {
  LATEST_URL, UPDATE_STATE_KEY, evaluateUpdate, shouldCheckForUpdates,
} from '../lib/updateCheck';
import { VARYS_API, VARYS_APP_ORIGINS } from '../lib/varys/config';
import {
  acceptConnectMessage, getConnection, setConnection, toStatus,
  type VarysConnection, type VarysDisconnectRequest, type VarysDisconnectResponse, type VarysRevocation,
  type VarysStatusRequest,
} from '../lib/varys/connection';
import type {
  VarysFormOpenedMessage, VarysFormOpenedResponse, VarysSubmitMessage,
} from '../lib/varys/pageState';
import { showVarysNotice } from '../lib/varys/notice';
import { parseSuggestionsAnswer, type SuggestionsReply, type VarysSuggestionsRequest } from '../lib/varys/suggestions';
import {
  ACTION_EXPIRED_COPY, ACTION_NOT_CONNECTED_COPY, ACTION_UNREACHABLE_COPY, EXPIRED_COPY,
  PENDING_NOTICE_KEY, PENDING_TIMEOUT_MS, QUEUE_KEY, SITES_TTL_MS, UNREACHABLE_COPY, UNTRACKED_COPY,
  failureOf, isTrackedSite, knownUntracked, mergeCarriedBefore, nextOpenedForm, noteLoading, noticeForResult,
  outcomeOfTimeout, outcomeWhenLoaded, pruneQueue, queueVerdict, toSaveRequest,
  type FormEvent, type NavigationOutcome, type OpenedForm, type PendingSubmit, type QueuedSave,
  type SaveRequest, type SitesCache, type StoredNotice, type VarysActionRequest, type VarysActionResponse,
  type VarysNotice,
} from '../lib/varys/submissions';

/** Popup asking for a fresh check, so "Check again" reuses the worker's one fetch path. */
export interface CheckForUpdateRequest {
  type: 'checkForUpdate';
}

export interface FetchSourceRequest {
  type: 'fetchSource';
  url: string;
}

export interface FetchSourceResponse {
  ok: boolean;
  /** Raw HTML on success. */
  html?: string;
  /** Final URL after redirects, which is what provenance should cite. */
  finalUrl?: string;
  status?: number;
  error?: string;
}

/** Only http(s) is fetchable; anything else is a mistake or an attack. */
function isFetchable(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

async function fetchSource(url: string): Promise<FetchSourceResponse> {
  if (!isFetchable(url)) {
    return { ok: false, error: 'Only http and https URLs can be imported.' };
  }

  // Confirm the optional permission was actually granted before fetching, so the
  // failure is a clear message rather than an opaque network error.
  const granted = await chrome.permissions.contains({ origins: [new URL(url).origin + '/*'] });
  if (!granted) {
    return { ok: false, error: 'Permission to read that site has not been granted yet.' };
  }

  try {
    const response = await fetch(url, { credentials: 'omit', redirect: 'follow' });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `The source returned HTTP ${response.status}.` };
    }

    const type = response.headers.get('content-type') ?? '';
    if (type && !/text\/html|application\/xhtml/i.test(type)) {
      return { ok: false, error: `That URL returned ${type.split(';')[0]}, not an HTML page.` };
    }

    return { ok: true, html: await response.text(), finalUrl: response.url, status: response.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Fetch failed.' };
  }
}

export interface RichEditorLifecycleRequest {
  type: 'richEditorLifecycle';
  elementId: string;
  op: 'detach' | 'attach' | 'sync' | 'probe';
}

/** Reads a field's HTML from its rich editor, which holds it until the form submits. */
export interface ReadRichEditorRequest {
  type: 'readRichEditor';
  elementId: string;
}

export interface ReadRichEditorResponse {
  ok: boolean;
  /** 'none' when no editor is attached, and the textarea is the value. */
  editor?: 'ckeditor' | 'tinymce' | 'none';
  value?: string;
}

export interface SyncRichEditorRequest {
  type: 'syncRichEditor';
  elementId: string;
  value: string;
}

/**
 * Pushes a value into the page's rich-text editor instance.
 *
 * CKEditor keeps its content in its own object and only syncs to the textarea on
 * submit, so assigning `textarea.value` alone is discarded. That instance lives in the
 * page's JavaScript world, which a content script cannot reach.
 *
 * The obvious workaround — appending an inline <script> to the page — does NOT work:
 * any site with a `script-src` CSP that lacks 'unsafe-inline' blocks it, which is most
 * of them. Observed failing in testing with "Executing inline script violates the
 * following Content Security Policy directive".
 *
 * chrome.scripting with `world: 'MAIN'` is the supported path. It runs in the page's
 * world but is injected by the extension, so page CSP does not apply.
 */
async function syncRichEditor(tabId: number, elementId: string, value: string): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [elementId, value],
      func: (id: string, text: string) => {
        const w = window as unknown as {
          CKEDITOR?: { instances?: Record<string, { setData(v: string): void }> };
          tinyMCE?: { get(id: string): { setContent(v: string): void } | null };
        };
        try {
          const ck = w.CKEDITOR?.instances?.[id];
          if (ck) { ck.setData(text); return 'ckeditor'; }
          const tiny = w.tinyMCE?.get(id);
          if (tiny) { tiny.setContent(text); return 'tinymce'; }
          return 'none';
        } catch {
          return 'error';
        }
      },
    });

    // 'none' means no rich editor was attached, in which case the content script's
    // textarea write is already correct and complete.
    return result?.result === 'ckeditor' || result?.result === 'tinymce' || result?.result === 'none';
  } catch (err) {
    console.warn('[D7 Studio] Could not sync the rich text editor', err);
    return false;
  }
}

/** The counterpart of syncRichEditor: the editor's current HTML, in the page's world. */
async function readRichEditor(tabId: number, elementId: string): Promise<ReadRichEditorResponse> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [elementId],
      func: (id: string) => {
        const w = window as unknown as {
          CKEDITOR?: { instances?: Record<string, { getData(): string }> };
          tinyMCE?: { get(id: string): { getContent(): string } | null };
        };
        const ck = w.CKEDITOR?.instances?.[id];
        if (ck) return { editor: 'ckeditor', value: ck.getData() };
        const tiny = w.tinyMCE?.get(id);
        if (tiny) return { editor: 'tinymce', value: tiny.getContent() };
        return { editor: 'none' };
      },
    });
    const read = result?.result as { editor: ReadRichEditorResponse['editor']; value?: string } | undefined;
    return read ? { ok: true, ...read } : { ok: false };
  } catch (err) {
    console.warn('[D7 Studio] Could not read the rich text editor', err);
    return { ok: false };
  }
}

/** Puts HTML into a field's rich editor at the cursor, which the person placed by clicking in the body. */
export interface InsertRichEditorHtmlRequest {
  type: 'insertRichEditorHtml';
  elementId: string;
  html: string;
}

export interface InsertRichEditorHtmlResponse {
  /** True only when the HTML went in. */
  ok: boolean;
  /**
   * 'no-cursor': the editor has no selection (nobody has clicked in the body), so nothing was
   * inserted, and the answer is to tell the person to click where it should go.
   * 'no-editor': no CKEditor 4 instance has that id.
   */
  result: 'inserted' | 'no-cursor' | 'no-editor' | 'error';
}

/**
 * The counterpart of syncRichEditor for adding to what is there instead of replacing it.
 *
 * CKEditor 4 only, which is what Drupal's rich fields are. It never guesses a place: without a
 * range to insert at (`getSelection()` is null, or has no ranges), nothing is inserted.
 * The panel's button takes focus from the editing surface, so this relies on CKEditor still
 * reporting the range the person last had there (checked against a stub, not a live editor).
 * `html` goes in as markup: whoever builds it escapes any text that is not meant as markup.
 */
async function insertRichEditorHtml(
  tabId: number, elementId: string, html: string,
): Promise<InsertRichEditorHtmlResponse> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [elementId, html],
      func: (id: string, markup: string) => {
        const w = window as unknown as {
          CKEDITOR?: {
            instances?: Record<string, {
              getSelection(): { getRanges(): unknown[] } | null;
              focus(): void;
              insertHtml(html: string): void;
              updateElement(): void;
            }>;
          };
        };
        try {
          const ck = w.CKEDITOR?.instances?.[id];
          if (!ck) return 'no-editor';
          if (!ck.getSelection()?.getRanges().length) return 'no-cursor';
          ck.focus();
          ck.insertHtml(markup);
          // The textarea is what the form submits, and CKEditor only syncs it on submit.
          ck.updateElement();
          return 'inserted';
        } catch {
          return 'error';
        }
      },
    });
    const result = injection?.result;
    return result === 'inserted' || result === 'no-cursor' || result === 'no-editor'
      ? { ok: result === 'inserted', result }
      : { ok: false, result: 'error' };
  } catch (err) {
    console.warn('[D7 Studio] Could not insert into the rich text editor', err);
    return { ok: false, result: 'error' };
  }
}

/**
 * Detaches or re-attaches Drupal's own rich text editor around a DOM move.
 *
 * Needed because the two-pane editor relocates the real editor into its layout so the
 * user gets the site's ACTUAL toolbar. A rich editor cannot simply be reparented:
 * CKEditor 4 and TinyMCE both build their editing area as an <iframe>, and moving an
 * iframe in the DOM forces the browser to reload it — which blanks the editing surface
 * and leaves the instance pointing at a document that no longer exists.
 *
 * So the move is bracketed: 'detach' writes the editor's data back to the textarea and
 * destroys the instance, then the content script moves the plain textarea, then 'attach'
 * re-initialises in the new location.
 *
 * Re-initialising goes through Drupal.attachBehaviors rather than CKEDITOR.replace,
 * deliberately: attachBehaviors re-runs whatever editor module the site actually
 * configured, with that site's toolbar, buttons, format list and media integration.
 * Calling CKEDITOR.replace ourselves would produce a DEFAULT toolbar — visibly not the
 * buttons the user had before, which is the whole complaint this fixes. It is also
 * editor-agnostic: CKEditor, TinyMCE or BUEditor all re-attach the same way.
 */
async function richEditorLifecycle(
  tabId: number,
  elementId: string,
  op: 'detach' | 'attach' | 'sync' | 'probe'
): Promise<{ ok: boolean; editor?: string }> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [elementId, op],
      func: (id: string, operation: string) => {
        const w = window as unknown as {
          CKEDITOR?: {
            instances?: Record<string, {
              updateElement(): void;
              destroy(noUpdate?: boolean): void;
            }>;
            replace?: (el: HTMLElement | string) => unknown;
          };
          tinyMCE?: {
            get(id: string): { triggerSave(): void; remove(): void } | null;
            EditorManager?: unknown;
          };
          Drupal?: { attachBehaviors?: (context?: Element) => void };
          jQuery?: unknown;
        };

        /**
         * 'sync' pushes every editor's content into its textarea.
         *
         * A rich editor holds its content in its own object and only writes it back on
         * submit. Real saves are fine (the submit button is clicked, so that handler
         * runs), but the local autosave reads the textarea directly — so without this it
         * would draft an EMPTY body while the user was typing into a full one.
         */
        /**
         * 'probe' reports whether the page has a rich-editor library and how many of its
         * registered instances have finished building their editing surface.
         *
         * Needed because CKEditor is ASYNCHRONOUS. `CKEDITOR.replace()` registers the
         * instance immediately but then loads config and plugins before firing
         * instanceReady and inserting the container. The content script runs at
         * DOMContentLoaded, samples the DOM once, sees no container, and concludes the
         * body has no editor — so it renders a plain textarea over a field that was about
         * to get CKEditor a moment later. Every fixture attaches synchronously in an
         * inline script, which is why this never showed up in a test.
         */
        if (operation === 'probe') {
          const ck = w.CKEDITOR as undefined | {
            instances?: Record<string, unknown>;
          };
          const tiny = (w as unknown as { tinymce?: { editors?: { id: string }[] } }).tinymce;

          const ckIds = Object.keys(ck?.instances ?? {});
          const ckReady = ckIds.filter(instanceId => {
            if (document.getElementById(`cke_${instanceId}`)) return true;
            // An element id is not necessarily a valid CSS identifier — one starting with
            // a digit makes this selector throw. An exception here would reject the whole
            // executeScript, the probe would report no bridge, and the wait would silently
            // switch itself off, which is the bug this op exists to prevent.
            try {
              return Boolean(document.querySelector(`.cke_editor_${instanceId}`));
            } catch {
              return false;
            }
          }).length;
          const tinyIds = (tiny?.editors ?? []).map(e => e.id);

          return JSON.stringify({
            hasLibrary: Boolean(ck || tiny),
            total: ckIds.length + tinyIds.length,
            // A TinyMCE editor in `editors` has already built its UI.
            ready: ckReady + tinyIds.length,
          });
        }

        if (operation === 'sync') {
          let synced = 0;
          const instances = w.CKEDITOR?.instances ?? {};
          for (const key of Object.keys(instances)) {
            try { instances[key].updateElement(); synced++; } catch { /* skip one bad instance */ }
          }
          const tinyAll = (w as unknown as { tinymce?: { editors?: { triggerSave(): void }[] } }).tinymce;
          for (const ed of tinyAll?.editors ?? []) {
            try { ed.triggerSave(); synced++; } catch { /* as above */ }
          }
          return synced > 0 ? 'synced' : 'none';
        }

        const textarea = document.getElementById(id) as HTMLTextAreaElement | null;
        if (!textarea) return 'no-element';

        if (operation === 'detach') {
          const ck = w.CKEDITOR?.instances?.[id];
          if (ck) {
            // updateElement first: destroy(true) skips the write-back, and without it
            // everything already typed is lost.
            try { ck.updateElement(); } catch { /* keep going; destroy matters more */ }
            ck.destroy(true);
            return 'ckeditor';
          }
          const tiny = w.tinyMCE?.get(id);
          if (tiny) {
            try { tiny.triggerSave(); } catch { /* as above */ }
            tiny.remove();
            return 'tinymce';
          }
          return 'none';
        }

        // attach
        const wrapper = textarea.closest('.text-format-wrapper')
          ?? textarea.closest('.form-item')
          ?? textarea.parentElement;

        // Drupal marks processed elements so behaviors do not double-attach. The move
        // carried those markers along, so they have to be cleared or attachBehaviors
        // will skip the very element we want re-initialised.
        (wrapper ?? textarea).querySelectorAll?.('.ckeditor-processed, .wysiwyg-processed')
          .forEach(el => el.classList.remove('ckeditor-processed', 'wysiwyg-processed'));
        textarea.classList.remove('ckeditor-processed', 'wysiwyg-processed');

        if (typeof w.Drupal?.attachBehaviors === 'function') {
          try {
            w.Drupal.attachBehaviors((wrapper ?? textarea) as Element);
          } catch {
            return 'attach-threw';
          }
          // Did anything actually take? A silent no-op would leave a bare textarea
          // looking exactly like the bug being fixed, so it is reported.
          const attached = !!w.CKEDITOR?.instances?.[id] || !!w.tinyMCE?.get(id);
          return attached ? 'attached' : 'behaviors-ran-no-editor';
        }

        return 'no-drupal';
      },
    });

    const outcome = String(result?.result ?? 'unknown');
    return {
      ok: outcome !== 'attach-threw' && outcome !== 'no-element' && outcome !== 'unknown',
      editor: outcome,
    };
  } catch (err) {
    console.warn('[D7 Studio] Rich editor ' + op + ' failed', err);
    return { ok: false, editor: 'error' };
  }
}

/**
 * Forgets the Varys connection: tells Varys to revoke the key, drops it here, and gives
 * back the host permission the connect step asked for.
 *
 * The revoke is best effort and bounded. A person who cannot reach Varys still has to be
 * able to disconnect, so a failure never stops the local steps; it is reported instead,
 * because the key is then still live on the server and they should know. A 401 counts as
 * revoked: the key was already dead. A server that answered with anything else is
 * `refused`, which is a different fault from `unreachable` and is reported as one.
 */
async function varysDisconnect(): Promise<VarysDisconnectResponse> {
  const connection = await getConnection();

  // With no stored connection there is nothing to cancel.
  let revocation: VarysRevocation = 'revoked';
  if (connection) {
    revocation = 'unreachable';
    try {
      const response = await fetch(`${VARYS_API}/api/extension/connection`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${connection.key}` },
        credentials: 'omit',
        signal: AbortSignal.timeout(10_000),
      });
      revocation = response.ok || response.status === 401 ? 'revoked' : 'refused';
    } catch {
      // Offline, blocked or timed out: stays `unreachable`. Falls through to forgetting
      // the key locally.
    }
  }

  await setConnection(null);
  // Nothing of this person's is left waiting to go to Varys: saves queued under this key, saves
  // and forms the worker was still following, the site list it fetched, and a notice not yet
  // shown. A later connection, possibly someone else's, starts clean. (A pending save also
  // names its owner and is never sent under anyone else's key, which covers one written while
  // this ran.)
  await withQueue(() => chrome.storage.local.remove([QUEUE_KEY, PENDING_NOTICE_KEY]));
  const followed = Object.keys(await chrome.storage.session.get(null))
    .filter(k => k.startsWith('varysPending:') || k.startsWith('varysForm:'));
  await chrome.storage.session.remove([SITES_KEY, ...followed]);
  try {
    await chrome.permissions.remove({ origins: [VARYS_API + '/*'] });
  } catch (err) {
    console.warn('[D7 Studio] Could not drop the Varys host permission', err);
  }
  return { ok: true, revocation };
}

// ===================================================================== Varys: following a save
//
// The content script tells the worker when a node form opens (varysFormOpened) and when it is
// saved (varysSubmit), and never waits for an answer to the second. Everything after that is
// here: following the tab to see whether the save went through, working out the page's public
// address, sending it to Varys or queueing it, and showing the result in the tab. The
// decisions are pure functions in src/lib/varys/submissions.ts; this is their storage, network
// and tab events.
//
// Nothing here can delay Drupal's Save: the worker only listens to the tab, it never blocks a
// request, and the content script has already let the submit go by the time any of it runs.
//
// State that lives between events is in chrome.storage.session, because a service worker can
// be stopped between any two of them: the form a tab opened with (varysForm:<tabId>) and the
// save being followed (varysPending:<tabId>). It is cleared when the browser closes. The queue
// is in chrome.storage.local, because it must outlive a restart.

const formKey = (tabId: number) => `varysForm:${tabId}`;
const pendingKey = (tabId: number) => `varysPending:${tabId}`;
const SITES_KEY = 'varysSites';
const VARYS_TIMEOUT_MS = 15_000;
/**
 * Longer than the usual 15 s because Varys reads the page before it answers 202, and below the
 * 30 s at which Chrome stops a service worker that is still waiting on a fetch (that would close
 * the panel's message port with no reply, where a timeout answers `unreachable`).
 */
const VARYS_GENERATE_TIMEOUT_MS = 25_000;

/**
 * Runs a tab's state changes one after another, in the order their events arrived. Each is a
 * read-modify-write of that tab's session storage, and two interleaved would lose one. Only
 * the bookkeeping runs in this order; sending to Varys happens outside it, so a slow Varys
 * never holds up the next event.
 */
const tabWork = new Map<number, Promise<void>>();

function inTabOrder(tabId: number, work: () => Promise<void>): Promise<void> {
  const next = (tabWork.get(tabId) ?? Promise.resolve())
    .then(work)
    .catch(err => console.warn('[D7 Studio] Varys: could not follow a save', err));
  tabWork.set(tabId, next);
  void next.then(() => { if (tabWork.get(tabId) === next) tabWork.delete(tabId); });
  return next;
}

async function sessionGet<T>(key: string): Promise<T | undefined> {
  return (await chrome.storage.session.get(key))[key] as T | undefined;
}

async function putOpenedForm(tabId: number, opened: OpenedForm | undefined): Promise<void> {
  if (opened) await chrome.storage.session.set({ [formKey(tabId)]: opened });
  else await chrome.storage.session.remove(formKey(tabId));
}

async function applyFormEvent(tabId: number, event: FormEvent): Promise<OpenedForm | undefined> {
  const opened = nextOpenedForm(await sessionGet<OpenedForm>(formKey(tabId)), event);
  await putOpenedForm(tabId, opened);
  return opened;
}

/**
 * A node form opened in a tab. The worker keeps the first one, and answers with the values it
 * was first read from (see OpenedForm). Nothing is kept for someone who is not connected.
 */
async function formOpened(
  tabId: number, url: string, m: VarysFormOpenedMessage,
): Promise<VarysFormOpenedResponse | null> {
  if (!(await getConnection())) return null;
  const opened = await applyFormEvent(tabId, {
    kind: 'opened', url, formPath: m.formPath, before: m.before, raw: m.raw,
  });
  return { raw: opened?.raw ?? null };
}

/**
 * A node form was saved. Held as the tab's pending submission, with the before the form FIRST
 * opened with, until the tab shows where Drupal sent it.
 *
 * The connection is checked here and again when sending: the page decided whether to record
 * only once, when it loaded. The save is stamped with whose it is, and is only ever sent
 * under that person's key.
 */
async function submitted(tabId: number, formUrl: string, m: VarysSubmitMessage): Promise<void> {
  const connection = await getConnection();
  if (!connection) return;
  // The first record of this form wins, so this only stores the message's before when the
  // form's opening was never heard (a Save before the page had finished reading itself).
  const opened = await applyFormEvent(tabId, {
    kind: 'opened', url: formUrl, formPath: m.formPath, before: m.before, raw: null,
  });
  const { type: _type, formPath, submittedAt: pressedAt, ...payload } = m;
  const submittedAt = Number.isFinite(pressedAt) ? pressedAt : Date.now();
  const pending = mergeCarriedBefore(opened, {
    tabId, formPath, formUrl, submittedAt, email: connection.email,
    // The save's own load may already have reached the worker: tab events and messages do
    // not arrive in a guaranteed order.
    loadingSeen: (lastLoadingAt.get(tabId) ?? -Infinity) >= submittedAt,
    payload,
  });
  await chrome.storage.session.set({ [pendingKey(tabId)]: pending });

  // Best effort: a worker still running then sends a save whose navigation never finished.
  // One that has been stopped is caught by the next sweep instead.
  setTimeout(() => { void sweepStalePending(); }, PENDING_TIMEOUT_MS + 1_000);
}

/**
 * When each tab last started loading, by the worker's clock, kept the moment the event arrives.
 * A Save's own load can reach the worker before the Save message does; `submitted` reads this
 * to know. Lost if the worker stops, which costs at worst a save sent by the sweep instead.
 */
const lastLoadingAt = new Map<number, number>();

/** The tab started loading at `at`: the answer to its save, if Save was pressed before. */
async function tabLoading(tabId: number, at: number): Promise<void> {
  const pending = await sessionGet<PendingSubmit>(pendingKey(tabId));
  if (!pending) return;
  const next = noteLoading(pending, at);
  if (next !== pending) await chrome.storage.session.set({ [pendingKey(tabId)]: next });
}

/** The tab is at `url`, and with `complete` it has finished loading it. */
async function tabUpdated(tabId: number, url: string, complete: boolean): Promise<void> {
  const got = await chrome.storage.session.get([formKey(tabId), pendingKey(tabId)]);
  const opened = got[formKey(tabId)] as OpenedForm | undefined;
  const pending = got[pendingKey(tabId)] as PendingSubmit | undefined;
  if (!opened && !pending) return;

  let nextOpened = nextOpenedForm(opened, { kind: 'navigated', url });
  // Null while the load that finished began before Save: the save's own is still to come.
  const outcome = pending && complete ? outcomeWhenLoaded(pending, url) : null;
  if (pending && outcome) {
    await chrome.storage.session.remove(pendingKey(tabId));
    // Failed: the form re-rendered, and its next Save is a new submission that carries the
    // original before anyway. Interrupted: the login page or another site, so it did not
    // happen, and the form's record is kept for the save the person makes next.
    if (outcome.kind === 'saved' || outcome.kind === 'noAddress') {
      nextOpened = nextOpenedForm(nextOpened, { kind: 'saved' });
      void send(pending, outcome, tabId);
    }
  }
  if (nextOpened !== opened) await putOpenedForm(tabId, nextOpened);
}

/**
 * Sends the saves whose navigation was never seen to finish within PENDING_TIMEOUT_MS (a tab
 * closed mid-save, a server slower than that), with the address the form knew. There is no
 * alarm to run this on time, which would need the `alarms` permission for one rare case, so it
 * runs whenever the worker next hears about a form or a closed tab.
 */
async function sweepStalePending(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const now = Date.now();
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('varysPending:')) continue;
    const pending = value as PendingSubmit;
    if (now - pending.submittedAt < PENDING_TIMEOUT_MS) continue;
    await inTabOrder(pending.tabId, async () => {
      // Re-read inside the tab's order: its navigation may have been handled meanwhile.
      const still = await sessionGet<PendingSubmit>(pendingKey(pending.tabId));
      if (!still || still.submittedAt !== pending.submittedAt) return;
      await chrome.storage.session.remove(pendingKey(pending.tabId));
      void send(still, outcomeOfTimeout(still), still.tabId);
    });
  }
}

function send(pending: PendingSubmit, outcome: NavigationOutcome, tabId: number): Promise<void> {
  if (outcome.kind !== 'saved') {
    if (outcome.kind === 'noAddress') {
      console.warn('[D7 Studio] Varys: a new page was saved, but where it lives could not be told, so it was not sent.');
    }
    return Promise.resolve();
  }
  return sendSave(toSaveRequest(pending.payload, outcome.pageUrl, outcome.nodeId), tabId, pending.email)
    .catch(err => console.warn('[D7 Studio] Varys: could not send a save', err));
}

// ---------------------------------------------------------------------------------- the network

interface VarysAnswer {
  /** Null when there was no answer at all: offline, blocked, refused by CORS, timed out. */
  status: number | null;
  json: unknown;
}

async function callVarys(
  connection: VarysConnection, method: 'GET' | 'POST', path: string, body?: unknown,
  timeoutMs: number = VARYS_TIMEOUT_MS,
): Promise<VarysAnswer> {
  try {
    const response = await fetch(`${VARYS_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${connection.key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // Not JSON, or no body. The status still says what happened.
    }
    return { status: response.status, json };
  } catch {
    return { status: null, json: null };
  }
}

const succeeded = (a: VarysAnswer) => a.status !== null && a.status >= 200 && a.status < 300;

/** Marks the key Varys refused as expired, unless it has been replaced since. */
async function markExpired(refused: VarysConnection): Promise<void> {
  const current = await getConnection();
  if (current && current.key === refused.key && !current.expired) {
    await setConnection({ ...current, expired: true });
  }
}

/**
 * The sites Varys keeps a workspace for, cached for a day. `expired` when Varys refused the
 * key; null when it could not be asked, in which case the save itself is sent and Varys,
 * which checks the site again anyway, decides.
 */
async function trackedSites(connection: VarysConnection): Promise<string[] | 'expired' | null> {
  const cached = await sessionGet<SitesCache>(SITES_KEY);
  const ours = cached && cached.email === connection.email ? cached : undefined;
  if (ours && Date.now() - ours.fetchedAt < SITES_TTL_MS) return ours.sites;

  const answer = await callVarys(connection, 'GET', '/api/extension/connection');
  const sites = (answer.json as { sites?: unknown } | null)?.sites;
  if (succeeded(answer) && Array.isArray(sites) && sites.every(s => typeof s === 'string')) {
    const fresh: SitesCache = { email: connection.email, sites: sites as string[], fetchedAt: Date.now() };
    await chrome.storage.session.set({ [SITES_KEY]: fresh });
    return fresh.sites;
  }
  if (answer.status === 401) return 'expired';
  return ours?.sites ?? null;
}

// ------------------------------------------------------------------------------------ the queue

/**
 * The queue is read, changed and written back by more than one path (a failed send adds to
 * it, a flush drains it), so every change to it goes through this one line.
 */
let queueWork: Promise<unknown> = Promise.resolve();

function withQueue<T>(work: () => Promise<T>): Promise<T> {
  const run = queueWork.then(work, work);
  queueWork = run.catch(() => undefined);
  return run;
}

const readQueue = async (): Promise<QueuedSave[]> =>
  pruneQueue((await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY], Date.now());

/** An empty queue is no queue: nothing is kept for someone with nothing waiting. */
const writeQueue = (queue: QueuedSave[]): Promise<void> => queue.length === 0
  ? chrome.storage.local.remove(QUEUE_KEY)
  : chrome.storage.local.set({ [QUEUE_KEY]: queue });

function enqueue(request: SaveRequest, email: string): Promise<void> {
  return withQueue(async () => {
    await writeQueue(pruneQueue([...await readQueue(), { request, queuedAt: Date.now(), email }], Date.now()));
  });
}

/**
 * Sends what the queue holds, oldest first, and stops at the first failure that says Varys is
 * still unreachable or the key is dead (no answer, a 5xx, a 401), keeping that save and
 * everything after it. One that Varys refuses for a reason of its own (another 4xx) is kept
 * and the next is tried, so it cannot hold up the saves behind it (see queueVerdict).
 *
 * A queued save is dropped without being sent when it was made under a different person's
 * connection, or Varys no longer tracks its site; it is dropped after sending when Varys took
 * it, or called it malformed (a 422 fails the same way however often it is retried).
 */
function flushQueue(): Promise<void> {
  return withQueue(async () => {
    const queue = await readQueue();
    const connection = await getConnection();
    if (queue.length === 0 || !connection || connection.expired) {
      await writeQueue(queue);
      return;
    }

    const sites = await trackedSites(connection);
    if (sites === 'expired') {
      await markExpired(connection);
      await writeQueue(queue);
      return;
    }

    const kept: QueuedSave[] = [];
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i];
      if (entry.email !== connection.email) continue;
      if (sites && !isTrackedSite(entry.request.page_url, sites)) continue;

      const answer = await callVarys(connection, 'POST', '/api/extension/saves', entry.request);
      const verdict = queueVerdict(answer.status);
      if (verdict === 'sent') continue;
      if (verdict === 'dropped') {
        console.warn('[D7 Studio] Varys refused a queued save as malformed, so it was dropped', answer.json);
        continue;
      }
      if (verdict === 'kept') {
        kept.push(entry);
        continue;
      }
      if (answer.status === 401) await markExpired(connection);
      kept.push(...queue.slice(i));
      break;
    }
    await writeQueue(kept);
  });
}

// ---------------------------------------------------------------------------------- sending one

/**
 * Sends one save to Varys and tells the editor how it went.
 *
 * - Not connected: nothing at all.
 * - Connected as someone other than `owner`, the person who pressed Save: nothing at all. It is
 *   their save, and it is never sent under another person's key.
 * - An expired key: queued, and the editor is told to reconnect. Unless the site list Varys
 *   last gave this person (read without asking Varys, which the dead key cannot) lacks the
 *   page's site: then it is treated as below, since the flush would only drop it.
 * - A site Varys does not track: nothing is sent, and the editor is told so.
 * - Otherwise posted, after anything already queued. Varys's answer is the notice. A 401
 *   expires the key and queues the save; a 422 is this extension's bug and is only logged;
 *   anything else (no answer, a 5xx, another 4xx) queues it for later.
 */
async function sendSave(request: SaveRequest, tabId: number | null, owner: string): Promise<void> {
  const host = new URL(request.page_url).host;
  const show = (notice: VarysNotice) => showNotice(tabId, host, notice);
  const ours = (c: VarysConnection | null): c is VarysConnection => {
    if (c && c.email !== owner) {
      console.warn('[D7 Studio] Varys: a save made under another connection was dropped, not sent.');
    }
    return c !== null && c.email === owner;
  };

  let connection = await getConnection();
  if (!ours(connection)) return;
  if (!connection.expired) {
    await flushQueue();
    connection = await getConnection();
    if (!ours(connection)) return;
  }
  if (connection.expired) return queueUntilReconnected(request, connection, show);

  const sites = await trackedSites(connection);
  if (sites === 'expired') {
    await markExpired(connection);
    return queueUntilReconnected(request, connection, show);
  }
  if (sites && !isTrackedSite(request.page_url, sites)) return show({ message: UNTRACKED_COPY });

  const answer = await callVarys(connection, 'POST', '/api/extension/saves', request);
  if (succeeded(answer)) {
    const notice = noticeForResult(answer.json);
    if (notice) await show(notice);
    return;
  }
  switch (failureOf(answer.status)) {
    case 'expired':
      await markExpired(connection);
      await enqueue(request, connection.email);
      return show({ message: EXPIRED_COPY });
    case 'malformed':
      console.warn('[D7 Studio] Varys refused a save as malformed; it was not queued', answer.json);
      return;
    case 'retry':
      await enqueue(request, connection.email);
      return show({ message: UNREACHABLE_COPY });
  }
}

/**
 * A save made under an expired key waits in the queue for the same person to reconnect, and
 * the editor is told so. Not when the site list Varys last gave this person, at any age, says
 * it does not track the site (`knownUntracked`): the flush would drop that save without a
 * word after the editor had reconnected for it, so they are told now instead. No list: queued.
 */
async function queueUntilReconnected(
  request: SaveRequest, connection: VarysConnection, show: (notice: VarysNotice) => Promise<void>,
): Promise<void> {
  if (knownUntracked(request.page_url, await sessionGet<SitesCache>(SITES_KEY), connection.email)) {
    return show({ message: UNTRACKED_COPY });
  }
  await enqueue(request, connection.email);
  return show({ message: EXPIRED_COPY });
}

/**
 * Shows a notice in the tab the save was made in, injected by the worker: after a save Drupal
 * usually lands on the page's public alias, where the content script does not run.
 *
 * If it cannot be injected (the tab has gone, or is on a page the extension may not touch),
 * the notice is kept for the content script to show on its next page on the same site.
 */
async function showNotice(tabId: number | null, host: string, notice: VarysNotice): Promise<void> {
  if (tabId !== null) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: showVarysNotice, args: [notice] });
      return;
    } catch (err) {
      console.warn('[D7 Studio] Varys: could not show the notice in the tab; keeping it for the next page', err);
    }
  }
  // The text only: the content script shows no action (see showStoredVarysNotice there).
  const stored: StoredNotice = { host, notice: { message: notice.message }, storedAt: Date.now() };
  await chrome.storage.local.set({ [PENDING_NOTICE_KEY]: stored });
}

/** Undo or Log it anyway, from the notice's button. */
async function actOnSave(request: VarysActionRequest): Promise<VarysActionResponse> {
  const { saveId } = request;
  if (!Number.isInteger(saveId) || saveId <= 0) return { ok: false, message: ACTION_UNREACHABLE_COPY };

  const connection = await getConnection();
  if (!connection) return { ok: false, message: ACTION_NOT_CONNECTED_COPY };
  if (connection.expired) return { ok: false, message: ACTION_EXPIRED_COPY };

  const verb = request.type === 'varysUndo' ? 'undo' : 'log';
  const answer = await callVarys(connection, 'POST', `/api/extension/saves/${saveId}/${verb}`);
  if (succeeded(answer)) {
    const notice = noticeForResult(answer.json);
    return {
      ok: true,
      message: notice?.message ?? '',
      // Log it anyway answers like a save: once it counts, the button becomes Undo.
      ...(notice?.action?.type === 'varysUndo' ? { action: notice.action } : {}),
    };
  }
  if (answer.status === 401) {
    await markExpired(connection);
    return { ok: false, message: ACTION_EXPIRED_COPY };
  }
  // Varys answered, and said why (a save that is not this person's, or has gone): its words.
  const detail = (answer.json as { detail?: unknown } | null)?.detail;
  if (answer.status !== null && typeof detail === 'string') return { ok: false, message: detail };
  return { ok: false, message: ACTION_UNREACHABLE_COPY };
}

/**
 * What Varys has for a page's Page Health suggestions, or asks it to make them, for the panel.
 * The same steps as a save, in the same order, and the panel is told which one stopped it:
 *
 * - Not connected, or the key already expired: nothing is sent.
 * - A site Varys does not track: `not_tracked`, and nothing is sent. The page's address leaves
 *   the browser only for a site on the list Varys gave this person. When that list is unknown
 *   (Varys could not be asked and none is cached) nothing is sent either, and the panel is told
 *   Varys is unreachable: unlike a save, this request is passive and the next form open retries.
 * - A 401, on the list or on the request: the key is marked expired.
 * - No answer at all: unreachable. Another status, or an answer that is not a shape Varys
 *   documents: an error, with Varys's own words when it gave any.
 */
async function suggestionsFor(request: VarysSuggestionsRequest): Promise<SuggestionsReply> {
  const { pageUrl } = request;
  const connection = await getConnection();
  if (!connection) return { ok: false, reason: 'not_connected', message: ACTION_NOT_CONNECTED_COPY };
  if (connection.expired) return { ok: false, reason: 'expired', message: ACTION_EXPIRED_COPY };

  const sites = await trackedSites(connection);
  if (sites === 'expired') {
    await markExpired(connection);
    return { ok: false, reason: 'expired', message: ACTION_EXPIRED_COPY };
  }
  if (sites === null) return { ok: false, reason: 'unreachable', message: ACTION_UNREACHABLE_COPY };
  if (!isTrackedSite(pageUrl, sites)) return { ok: true, answer: { status: 'not_tracked' } };

  const answer = request.type === 'varysGenerateSuggestions'
    ? await callVarys(connection, 'POST', '/api/extension/suggestions/generate', { page_url: pageUrl }, VARYS_GENERATE_TIMEOUT_MS)
    : await callVarys(connection, 'GET', `/api/extension/suggestions?page_url=${encodeURIComponent(pageUrl)}`);
  if (succeeded(answer)) {
    const parsed = parseSuggestionsAnswer(answer.json);
    if (parsed) return { ok: true, answer: parsed };
    console.warn('[D7 Studio] Varys answered suggestions with a shape this version does not know', answer.json);
    return { ok: false, reason: 'error', message: ACTION_UNREACHABLE_COPY };
  }
  if (answer.status === 401) {
    await markExpired(connection);
    return { ok: false, reason: 'expired', message: ACTION_EXPIRED_COPY };
  }
  if (answer.status === null) return { ok: false, reason: 'unreachable', message: ACTION_UNREACHABLE_COPY };
  const detail = (answer.json as { detail?: unknown } | null)?.detail;
  return { ok: false, reason: 'error', message: typeof detail === 'string' ? detail : ACTION_UNREACHABLE_COPY };
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    // Stamped as it arrives, before any queued work, so the time is the event's own.
    // Measured: Chrome reports a fresh 'loading' for every navigation, including a Save
    // pressed while the form page itself was still loading.
    const at = Date.now();
    lastLoadingAt.set(tabId, at);
    void inTabOrder(tabId, () => tabLoading(tabId, at));
  }
  const complete = changeInfo.status === 'complete';
  const url = complete ? tab.url : changeInfo.url;
  if (!url) return;
  void inTabOrder(tabId, () => tabUpdated(tabId, url, complete));
});

chrome.tabs.onRemoved.addListener(tabId => {
  // The form's record goes with its tab. A save it was following is left for the sweep,
  // which sends it with the address the form knew.
  lastLoadingAt.delete(tabId);
  void inTabOrder(tabId, () => chrome.storage.session.remove(formKey(tabId)));
  void sweepStalePending();
});

/**
 * The Varys connect page hands over the key here.
 *
 * Only pages the manifest's externally_connectable lists can reach this at all, and the
 * origin is checked again in acceptConnectMessage. The answer says why a hand-off was
 * refused so the connect page can show it; it never echoes the key back.
 */
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const verdict = acceptConnectMessage(message, sender.origin, VARYS_APP_ORIGINS);
  if (!verdict.ok) {
    sendResponse({ ok: false, error: verdict.error });
    return false;
  }

  void setConnection({ key: verdict.key, email: verdict.email, connectedAt: new Date().toISOString() })
    .then(
      () => {
        sendResponse({ ok: true });
        // A new key may be a different person's, with a different list of sites. Then send
        // what was queued while the old one was expired or Varys was away.
        void chrome.storage.session.remove(SITES_KEY).then(flushQueue);
      },
      () => sendResponse({ ok: false, error: 'storage' }),
    );
  return true;
});

chrome.runtime.onMessage.addListener((
  message: FetchSourceRequest | SyncRichEditorRequest | RichEditorLifecycleRequest
    | CheckForUpdateRequest | ReadRichEditorRequest | VarysStatusRequest | VarysDisconnectRequest
    | VarysFormOpenedMessage | VarysSubmitMessage | VarysActionRequest | VarysSuggestionsRequest
    | InsertRichEditorHtmlRequest,
  sender,
  sendResponse
) => {
  if (message?.type === 'varysFormOpened') {
    const tabId = sender.tab?.id;
    const url = sender.url;
    if (tabId === undefined || !url || sender.frameId !== 0) {
      sendResponse(null);
      return false;
    }
    void inTabOrder(tabId, async () => {
      let answer: VarysFormOpenedResponse | null = null;
      try {
        answer = await formOpened(tabId, url, message);
      } finally {
        sendResponse(answer);
      }
    });
    void sweepStalePending();
    return true;
  }

  if (message?.type === 'varysSubmit') {
    // No answer: the page is navigating away and nobody is waiting for one.
    const tabId = sender.tab?.id;
    const url = sender.url;
    if (tabId !== undefined && url && sender.frameId === 0) {
      void inTabOrder(tabId, () => submitted(tabId, url, message));
      void sweepStalePending();
    }
    return false;
  }

  if (message?.type === 'varysUndo' || message?.type === 'varysLogAnyway') {
    void actOnSave(message).then(sendResponse);
    return true;
  }

  if (message?.type === 'varysSuggestions' || message?.type === 'varysGenerateSuggestions') {
    void suggestionsFor(message).then(sendResponse);
    return true;
  }

  if (message?.type === 'fetchSource') {
    void fetchSource(message.url).then(sendResponse);
    // Keeps the message channel open for the async reply.
    return true;
  }

  if (message?.type === 'syncRichEditor') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, error: 'No tab to inject into.' });
      return false;
    }
    void syncRichEditor(tabId, message.elementId, message.value)
      .then(ok => sendResponse({ ok }));
    return true;
  }

  if (message?.type === 'insertRichEditorHtml') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, result: 'error' } satisfies InsertRichEditorHtmlResponse);
      return false;
    }
    void insertRichEditorHtml(tabId, message.elementId, message.html).then(sendResponse);
    return true;
  }

  if (message?.type === 'readRichEditor') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false });
      return false;
    }
    void readRichEditor(tabId, message.elementId).then(sendResponse);
    return true;
  }

  if (message?.type === 'checkForUpdate') {
    void checkForUpdate().then(() =>
      chrome.storage.local.get({ [UPDATE_STATE_KEY]: null }, r =>
        sendResponse(r[UPDATE_STATE_KEY])));
    return true;
  }

  if (message?.type === 'varysStatus') {
    void getConnection().then(c => sendResponse(toStatus(c)));
    return true;
  }

  if (message?.type === 'varysDisconnect') {
    void varysDisconnect().then(sendResponse);
    return true;
  }

  if (message?.type === 'richEditorLifecycle') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, error: 'No tab to inject into.' });
      return false;
    }
    void richEditorLifecycle(tabId, message.elementId, message.op).then(sendResponse);
    return true;
  }

  return false;
});

/**
 * Update check — on browser start and on install, never on a timer.
 *
 * Chrome ignores a self-hosted `update_url` for a Load-unpacked install, so the
 * extension cannot update itself; the most it can honestly do is say it is out of date.
 * See src/lib/updateCheck.ts.
 *
 * Once per browser launch is enough for a tool released every week or two, and it avoids
 * asking for the `alarms` permission to run a schedule nobody needs. The fetch needs no
 * host permission either: raw.githubusercontent.com sends
 * `access-control-allow-origin: *`, so CORS allows it from the extension's own context.
 */
async function checkForUpdate(): Promise<void> {
  const current = chrome.runtime.getManifest().version;

  /**
   * A store install never checks.
   *
   * Chrome keeps it current, so the only thing this could produce is a badge telling
   * someone to go and do by hand what has already happened — and it would keep saying so
   * until latest.json was pushed. Any state left from a previous hand-loaded copy in the
   * same profile is cleared, so a stale badge does not outlive the migration.
   */
  if (!shouldCheckForUpdates(chrome.runtime.id)) {
    await chrome.storage.local.set({
      [UPDATE_STATE_KEY]: { available: false, current, checkedAt: Date.now() },
    });
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  let raw: unknown = null;
  try {
    const response = await fetch(LATEST_URL, { cache: 'no-cache' });
    if (response.ok) raw = await response.json();
  } catch {
    // Offline, blocked, or malformed. Staying silent is right: an update prompt that
    // appears because the network hiccuped is worse than one that arrives a day late.
  }

  const state = evaluateUpdate(current, raw);
  await chrome.storage.local.set({
    [UPDATE_STATE_KEY]: { ...state, checkedAt: Date.now() },
  });

  /**
   * A dot on the icon, not a number. There is only ever one thing to report, and a
   * count would imply otherwise.
   */
  await chrome.action.setBadgeText({ text: state.available ? '\u2022' : '' });
  if (state.available) {
    await chrome.action.setBadgeBackgroundColor({ color: '#B8562F' });
    await chrome.action.setTitle({
      title: `D7 Studio ${current} \u2014 version ${state.latest} is available`,
    });
  } else {
    await chrome.action.setTitle({ title: `D7 Studio ${current}` });
  }
}

chrome.runtime.onStartup.addListener(() => {
  void checkForUpdate();
  // Saves queued in an earlier session, while Varys was away.
  void flushQueue();
});
chrome.runtime.onInstalled.addListener(() => { void checkForUpdate(); });
