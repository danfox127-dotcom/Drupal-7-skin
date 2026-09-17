import { NodeSnapshot, SNAPSHOT_VERSION } from './types';

/**
 * Where a copied page waits between the two sites.
 *
 * chrome.storage.local, for the same reason src/lib/import/pending.ts uses it: the copy
 * happens on one site and the paste on another, so it cannot live in a page. Both sites
 * are already in host_permissions, so the content script runs on each and this storage
 * is shared between them — nothing is fetched cross-origin and no new permission is
 * needed.
 *
 * A short stack rather than a single slot. Migrating pages one at a time means copying,
 * navigating, pasting, going back — and a single slot silently loses a copy if someone
 * copies twice before pasting. Five is enough to be forgiving without turning into a
 * feature that needs managing.
 */

const KEY = 'clone:clipboard';
const MAX_COPIES = 5;

export interface ClipboardState {
  copies: NodeSnapshot[];
  /**
   * Copies discarded for being written by a different version of the extension.
   *
   * Surfaced rather than swallowed: "your copy disappeared" is a bug report, "that copy
   * was made by an older version, please copy it again" is an explanation.
   */
  refused: number;
}

function get(): Promise<unknown> {
  return new Promise(resolve => {
    chrome.storage.local.get({ [KEY]: [] }, result => resolve(result[KEY]));
  });
}

function set(copies: NodeSnapshot[]): Promise<string | null> {
  return new Promise(resolve => {
    chrome.storage.local.set({ [KEY]: copies }, () => {
      resolve(chrome.runtime.lastError?.message ?? null);
    });
  });
}

/** Reads the stack, dropping anything this build cannot safely interpret. */
export async function loadCopies(): Promise<ClipboardState> {
  const raw = await get();
  if (!Array.isArray(raw)) return { copies: [], refused: 0 };

  const copies: NodeSnapshot[] = [];
  let refused = 0;

  for (const entry of raw) {
    if (entry && typeof entry === 'object' && (entry as NodeSnapshot).version === SNAPSHOT_VERSION) {
      copies.push(entry as NodeSnapshot);
    } else {
      refused++;
    }
  }

  return { copies, refused };
}

/** The most recent copy, which is what a paste offers by default. */
export async function latestCopy(): Promise<NodeSnapshot | null> {
  const { copies } = await loadCopies();
  return copies[0] ?? null;
}

/**
 * Pushes a copy onto the stack, newest first.
 *
 * On a quota failure it retries with this copy alone. A page whose body runs to
 * megabytes is unusual but not impossible, and the copy someone just asked for matters
 * more than the four before it — failing the whole operation to preserve history would
 * be the wrong trade.
 */
export async function saveCopy(snapshot: NodeSnapshot): Promise<{ stored: number; trimmed: boolean }> {
  const { copies } = await loadCopies();

  // Replace rather than stack a repeat copy of the same node, so copying twice to be
  // sure does not push the other copies out.
  const withoutSame = copies.filter(c => c.sourceUrl !== snapshot.sourceUrl);
  const next = [snapshot, ...withoutSame].slice(0, MAX_COPIES);

  const error = await set(next);
  if (!error) return { stored: next.length, trimmed: false };

  const retry = await set([snapshot]);
  if (retry) throw new Error(`Could not store the copied page: ${retry}`);
  return { stored: 1, trimmed: true };
}

export async function clearCopies(): Promise<void> {
  return new Promise(resolve => chrome.storage.local.remove(KEY, () => resolve()));
}

/** Drops one copy, identified by the source it came from. */
export async function removeCopy(sourceUrl: string): Promise<void> {
  const { copies } = await loadCopies();
  await set(copies.filter(c => c.sourceUrl !== sourceUrl));
}
