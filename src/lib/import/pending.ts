/**
 * Hand-off between the popup (which fetches) and the node form (which fills).
 *
 * The review has to happen on the node form page, because approving it fills that
 * form's fields. But fetching has to happen from the extension, so the popup does the
 * fetch and parks the raw HTML here for the content script to pick up.
 *
 * RAW HTML, not a parsed extraction, and deliberately so: the body must be filtered to
 * the allowed-tag list of the text format it is headed for, and that list is only
 * readable on the node form. Extracting in the popup would filter against a list it
 * cannot know, and re-filtering later would mean two code paths that can disagree.
 *
 * Stored under one key: the handoff specifies one URL at a time.
 */

const PENDING_KEY = 'pendingImport';

export interface PendingImport {
  /** Unparsed source markup, filtered later against the target form's tag list. */
  html: string;
  /** Final URL after redirects — what provenance should cite. */
  sourceUrl: string;
  /** Content type the editor should be filling, when known. */
  targetType: string | null;
  createdAt: number;
  /** Set once the editor has applied it, so a reload does not re-prompt. */
  applied: boolean;
}

export async function setPendingImport(pending: PendingImport): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.local.set({ [PENDING_KEY]: pending }, () => resolve());
  });
}

export async function getPendingImport(): Promise<PendingImport | null> {
  return new Promise(resolve => {
    chrome.storage.local.get({ [PENDING_KEY]: null }, result => {
      const pending = result[PENDING_KEY];
      resolve(pending && typeof pending === 'object' ? (pending as PendingImport) : null);
    });
  });
}

export async function clearPendingImport(): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.local.remove(PENDING_KEY, () => resolve());
  });
}

/**
 * Requests read access to one origin.
 *
 * Must run from an extension page during a user gesture — chrome.permissions.request
 * throws from a service worker and is unavailable to content scripts. Scoped to the
 * single origin being imported rather than all-URLs, so granting access to one source
 * site does not grant access to every site.
 */
export async function requestOriginAccess(url: string): Promise<boolean> {
  let origin: string;
  try {
    origin = new URL(url).origin + '/*';
  } catch {
    return false;
  }

  const already = await chrome.permissions.contains({ origins: [origin] });
  if (already) return true;

  return chrome.permissions.request({ origins: [origin] });
}

/**
 * Where an import should be reviewed, given the tab the user started it from.
 *
 * Extracted from the popup so the decision is testable and its intent is stated once.
 *
 * The rule that matters: if the tab is ALREADY on a node form, stay there. Navigating
 * unconditionally to /node/add/news threw away a Page form the user had open and switched
 * content type under them. A reload is enough, because the content script reads the pending
 * import at startup.
 */
export interface ImportTarget {
  /** Reload the current tab rather than navigating away. */
  stay: boolean;
  /** Content type of the form already open, when there is one. */
  targetType: string | null;
}

export function importTarget(tabPath: string | null): ImportTarget {
  if (!tabPath) return { stay: false, targetType: null };

  const add = tabPath.match(/\/node\/add\/([a-z0-9-_]+)/i);
  if (add) {
    // Drupal's URLs hyphenate machine names.
    return { stay: true, targetType: add[1].replace(/-/g, '_').toLowerCase() };
  }

  // An edit form is also a form worth staying on; its type comes from the body class,
  // which only the content script can read.
  if (/\/node\/\d+\/edit/.test(tabPath)) return { stay: true, targetType: null };

  return { stay: false, targetType: null };
}
