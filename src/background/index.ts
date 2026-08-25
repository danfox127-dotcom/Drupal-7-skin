/**
 * Service worker. Its only job is the cross-origin fetch the import flow needs.
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
  op: 'detach' | 'attach' | 'sync';
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
  op: 'detach' | 'attach' | 'sync'
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

chrome.runtime.onMessage.addListener((
  message: FetchSourceRequest | SyncRichEditorRequest | RichEditorLifecycleRequest,
  sender,
  sendResponse
) => {
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
