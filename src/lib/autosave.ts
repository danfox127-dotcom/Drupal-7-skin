import { FieldValue } from './fieldBinding';

/**
 * Local draft persistence for the node editor.
 *
 * The handoff is explicit: autosave is LOCAL ONLY, into chrome.storage.local, keyed
 * by URL plus node id. "Save draft to Drupal" is the only thing that writes a
 * revision. Nothing here ever touches the site.
 */

const PREFIX = 'draft:';

export interface Draft {
  values: Record<string, FieldValue>;
  /** Epoch ms of the last local save. */
  savedAt: number;
  /**
   * Drupal's `changed` timestamp as it was when this draft started, used for the
   * conflict check. Null when the form did not expose one (a node/add form).
   */
  baseChanged: string | null;
  contentType: string | null;
  sourceUrl: string;
}

/**
 * Draft key. Node id is included explicitly rather than relying on the URL alone, so
 * `/node/451/edit` and `/node/451/edit?destination=…` share one draft instead of
 * silently forking into two.
 */
export function draftKey(location: Pick<Location, 'pathname' | 'origin'>): string {
  const nodeMatch = location.pathname.match(/\/node\/(\d+)\/edit/);
  if (nodeMatch) return `${PREFIX}${location.origin}/node/${nodeMatch[1]}`;

  const addMatch = location.pathname.match(/\/node\/add\/([a-z0-9-_]+)/i);
  if (addMatch) return `${PREFIX}${location.origin}/node/add/${addMatch[1].toLowerCase()}`;

  return `${PREFIX}${location.origin}${location.pathname}`;
}

/** Reads Drupal's `changed` hidden input, which is how a stale draft is detected. */
export function readChangedStamp(form: HTMLFormElement): string | null {
  const input = form.querySelector<HTMLInputElement>('input[name="changed"]');
  return input?.value || null;
}

export async function loadDraft(key: string): Promise<Draft | null> {
  return new Promise(resolve => {
    chrome.storage.local.get({ [key]: null }, result => {
      const draft = result[key];
      resolve(draft && typeof draft === 'object' ? (draft as Draft) : null);
    });
  });
}

export async function saveDraft(key: string, draft: Draft): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: draft }, () => resolve());
  });
}

export async function clearDraft(key: string): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.local.remove(key, () => resolve());
  });
}

export type ConflictState =
  | { kind: 'none' }
  /** A local draft exists and matches the revision it was based on. */
  | { kind: 'restorable'; draft: Draft }
  /**
   * Someone saved in Drupal after this draft was taken. The draft is NOT applied;
   * the editor offers a choice, because silently overwriting a newer revision with a
   * stale local draft is the one outcome that loses another person's work.
   */
  | { kind: 'stale'; draft: Draft; currentChanged: string };

/**
 * Decides what to do with a stored draft, without applying anything.
 *
 * Answers the handoff's open question #5. Note the deliberate asymmetry: when the
 * timestamps cannot be compared (a node/add form has no `changed`), the draft is
 * treated as restorable, because there is no other revision to conflict with.
 */
export function assessDraft(draft: Draft | null, currentChanged: string | null): ConflictState {
  if (!draft) return { kind: 'none' };

  if (draft.baseChanged && currentChanged && draft.baseChanged !== currentChanged) {
    return { kind: 'stale', draft, currentChanged };
  }

  return { kind: 'restorable', draft };
}

/** "12s ago" / "4m ago" — the sticky bar's autosave status. */
export function formatAge(savedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - savedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
