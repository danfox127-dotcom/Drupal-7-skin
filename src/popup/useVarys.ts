import { useCallback, useEffect, useState } from 'react';
import { VARYS_API, VARYS_APP_ORIGINS } from '../lib/varys/config';
import type { VarysDisconnectResponse, VarysStatus } from '../lib/varys/connection';

/**
 * The popup's view of the optional Varys connection.
 *
 * It is told a STATUS by the service worker, which owns the key: the popup is never given
 * the key, so there is nothing here to leak into the page. `status` is undefined until the
 * worker has answered, null when not connected.
 */
export function useVarys() {
  const [status, setStatus] = useState<VarysStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const answer = await chrome.runtime.sendMessage({ type: 'varysStatus' });
      setStatus((answer as VarysStatus | null | undefined) ?? null);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * Asks for access to the Varys API, then opens the Varys connect page.
   *
   * The permission request is the FIRST thing this does, with nothing awaited before it:
   * chrome.permissions.request needs the click's user gesture, and is unavailable to the
   * service worker. If access was already granted it resolves true without a prompt.
   * Reconnect is the same action.
   */
  const connect = async () => {
    setNote(null);
    setBusy(true);
    try {
      const granted = await chrome.permissions.request({ origins: [VARYS_API + '/*'] });
      if (!granted) {
        setNote('Access to Varys was declined, so it cannot be connected.');
        return;
      }
      await chrome.tabs.create({
        url: `${VARYS_APP_ORIGINS[0]}/connect-extension?ext=${encodeURIComponent(chrome.runtime.id)}`,
      });
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not open Varys.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setNote(null);
    setBusy(true);
    try {
      const answer = await chrome.runtime.sendMessage({ type: 'varysDisconnect' }) as
        VarysDisconnectResponse | undefined;
      if (answer?.ok && !answer.revoked) {
        // Forgotten here, but the key is still live on the server, and they should know.
        setNote('Disconnected here. Varys could not be reached to cancel the key, so it still works there.');
      } else if (!answer?.ok) {
        setNote('Could not disconnect. Try again.');
      }
    } catch {
      setNote('Could not disconnect. Try again.');
    } finally {
      // Read the truth rather than assuming it.
      await refresh();
      setBusy(false);
    }
  };

  return { status, busy, note, connect, disconnect };
}
