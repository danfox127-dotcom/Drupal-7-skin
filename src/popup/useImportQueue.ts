import { useState, useEffect, useCallback } from 'react';

/**
 * The migration queue: URLs the editor has collected to import later.
 *
 * Stored under its own key rather than mixed into the settings object, so the
 * feature toggles stay a flat set of booleans.
 *
 * Scope note: this phase persists, de-duplicates, and manages the queue. Opening
 * a URL currently opens the source page in a new tab; Phase 6 changes the click
 * target to the mapping-review screen, which is where the design's "open a URL to
 * review its mapping" wording becomes true.
 */

const QUEUE_KEY = 'importQueue';

export interface QueuedUrl {
  /** Normalized absolute URL, also the identity used for de-duplication. */
  url: string;
  /** Epoch ms, so the queue can render in the order things were added. */
  addedAt: number;
}

/**
 * Accepts what someone would realistically paste — with or without a scheme —
 * and rejects anything that is not an http(s) URL. Returns null when invalid, so
 * the caller can show a message rather than queueing garbage.
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    // A bare word like "news" parses as https://news, which is not a real target.
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Strips the scheme for display, as the prototype shows. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function useImportQueue() {
  const [queue, setQueue] = useState<QueuedUrl[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    chrome.storage.local.get({ [QUEUE_KEY]: [] }, result => {
      const stored = result[QUEUE_KEY];
      setQueue(Array.isArray(stored) ? stored : []);
      setLoaded(true);
    });
  }, []);

  const persist = useCallback((next: QueuedUrl[]) => {
    setQueue(next);
    chrome.storage.local.set({ [QUEUE_KEY]: next });
  }, []);

  /** Returns an error string, or null on success. */
  const add = useCallback((raw: string): string | null => {
    const url = normalizeUrl(raw);
    if (!url) return 'That does not look like a URL.';
    if (queue.some(item => item.url === url)) return 'Already in the queue.';
    persist([...queue, { url, addedAt: Date.now() }]);
    return null;
  }, [queue, persist]);

  const remove = useCallback((url: string) => {
    persist(queue.filter(item => item.url !== url));
  }, [queue, persist]);

  return { queue, add, remove, loaded };
}
