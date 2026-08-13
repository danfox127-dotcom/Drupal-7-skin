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

chrome.runtime.onMessage.addListener((
  message: FetchSourceRequest | SyncRichEditorRequest,
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

  return false;
});
