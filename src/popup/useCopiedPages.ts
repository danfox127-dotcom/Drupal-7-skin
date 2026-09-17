import { useState, useEffect, useCallback } from 'react';
import { NodeSnapshot } from '../lib/clone/types';
import { loadCopies, removeCopy, clearCopies } from '../lib/clone/clipboard';

/**
 * The pages waiting to be pasted onto another site.
 *
 * The popup shows these for one reason: a copy is invisible otherwise. It lives in
 * extension storage, survives page loads and browser restarts, and the only place it
 * shows up is a command-palette entry on a node form. Someone who copied a page last
 * week and has forgotten deserves to be told before they paste it over something.
 */
export function useCopiedPages() {
  const [copies, setCopies] = useState<NodeSnapshot[]>([]);
  const [refused, setRefused] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const state = await loadCopies();
      setCopies(state.copies);
      setRefused(state.refused);
    } catch {
      setCopies([]);
      setRefused(0);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const forget = useCallback(async (sourceUrl: string) => {
    await removeCopy(sourceUrl);
    await reload();
  }, [reload]);

  const forgetAll = useCallback(async () => {
    await clearCopies();
    await reload();
  }, [reload]);

  return { copies, refused, loaded, forget, forgetAll };
}
