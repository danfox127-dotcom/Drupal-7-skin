/**
 * The optional connection to Varys: what is stored, and who may create it.
 *
 * Nothing in this extension talks to Varys until someone connects. Connecting means
 * granting the Varys API host permission from the popup, then signing in on the Varys
 * connect page, which hands a key to the service worker through
 * chrome.runtime.sendMessage (answered by the worker's onMessageExternal listener).
 *
 * The key is a bearer credential for this person's Varys account. It lives in the trusted
 * store (./trustedStore.ts), IndexedDB in the extension's own origin, which the scripts the
 * extension runs inside Drupal pages cannot open. 0.7.x kept it in chrome.storage.local, which
 * those scripts CAN read (and write); moveLegacyConnection moves it across once, on that update. Nothing
 * outside the service worker is shown it: the popup asks for a status, which is built by
 * toStatus() and has no key in it.
 */

import { isNewer } from '../updateCheck';
import { trustedStore, type TrustedStore } from './trustedStore';

export interface VarysConnection {
  key: string;
  email: string;
  /** ISO timestamp of when the key was accepted. */
  connectedAt: string;
  /** Set when Varys has rejected the key (a 401), so the popup offers Reconnect. */
  expired?: boolean;
}

/** What the popup may know about a connection. Never the key. */
export interface VarysStatus {
  email: string;
  connectedAt: string;
  expired: boolean;
}

/** Popup asking the worker whether this browser is connected. */
export interface VarysStatusRequest {
  type: 'varysStatus';
}

/** Popup asking the worker to revoke the key, forget it, and drop the host permission. */
export interface VarysDisconnectRequest {
  type: 'varysDisconnect';
}

/**
 * Whether Varys was told to cancel the key. The key is forgotten locally either way.
 *
 * - `revoked`: Varys said yes, or said 401 (the key was already dead).
 * - `unreachable`: no answer at all (offline, blocked, timed out), so it may still be live.
 * - `refused`: Varys answered, but not with success or 401 (404, 5xx). Not "unreachable":
 *   saying so would send someone to check their network for a fault that is on the server.
 */
export type VarysRevocation = 'revoked' | 'unreachable' | 'refused';

export interface VarysDisconnectResponse {
  ok: true;
  revocation: VarysRevocation;
}

export const CONNECTION_KEY = 'varysConnection';

/** `vxk_` and then at least 40 url-safe characters; Varys issues 43. */
const KEY_PATTERN = /^vxk_[A-Za-z0-9_-]{40,}$/;

/** Longest address accepted from the hand-off. RFC 5321 caps one at 254. */
const MAX_EMAIL = 254;

export function isValidKey(k: unknown): k is string {
  return typeof k === 'string' && KEY_PATTERN.test(k);
}

export type ConnectVerdict =
  | { ok: true; key: string; email: string }
  | { ok: false; error: 'origin' | 'type' | 'key' | 'email' };

/**
 * Decides whether a message may create the connection. Pure, so the rules are testable.
 *
 * The origin is judged FIRST and against an exact match, so a page that is not the Varys
 * app learns nothing about what a valid message looks like. Chrome has already refused
 * pages the manifest's externally_connectable does not list; this is the second lock, and
 * the one that still holds if that list is ever widened by mistake.
 *
 * Only `key` and `email` are carried out. Anything else the page sent is dropped.
 */
export function acceptConnectMessage(
  msg: unknown,
  senderOrigin: string | undefined,
  allowed: string[],
): ConnectVerdict {
  if (!senderOrigin || !allowed.includes(senderOrigin)) return { ok: false, error: 'origin' };

  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    return { ok: false, error: 'type' };
  }
  const { type, key, email } = msg as Record<string, unknown>;
  if (type !== 'varysConnect') return { ok: false, error: 'type' };
  if (!isValidKey(key)) return { ok: false, error: 'key' };

  if (typeof email !== 'string' || email.trim() === '' || email.length > MAX_EMAIL) {
    return { ok: false, error: 'email' };
  }
  return { ok: true, key, email };
}

/**
 * Whether a hand-off may replace what is stored. A connection to a DIFFERENT account is never
 * replaced silently, expired or not: anything able to send the hand-off (a script injected into
 * the Varys app, say) could otherwise repoint a person's extension at someone else's key, and
 * that account's drafts would then fill their pages. The person disconnects first. The same
 * account may always refresh its key.
 */
export function mayReplaceConnection(existing: VarysConnection | null, email: string): boolean {
  return !existing || existing.email.trim().toLowerCase() === email.trim().toLowerCase();
}

/** Strips the key. The popup is built from this and cannot show what it was not given. */
export function toStatus(c: VarysConnection | null): VarysStatus | null {
  return c ? { email: c.email, connectedAt: c.connectedAt, expired: c.expired === true } : null;
}

/**
 * Every version before this kept the key in chrome.storage.local; this one and later keep it in
 * the trusted store. It must be the version this change ships in: set too HIGH, a later update
 * would read chrome.storage.local again, which is the hole this closes; too low, people updating
 * from the versions in between would have to reconnect, which is the safe direction.
 */
export const KEY_LEFT_LOCAL_BEFORE = '0.7.2';

/** The part of chrome.storage.local the move needs. */
type LegacyArea = Pick<chrome.storage.StorageArea, 'get' | 'remove'>;

/** What chrome.runtime.onInstalled says. */
type InstalledDetails = Pick<chrome.runtime.InstalledDetails, 'reason' | 'previousVersion'>;

/** The move in progress, if any: a read waits for it rather than racing it. */
let moving: Promise<void> = Promise.resolve();

/**
 * Called from chrome.runtime.onInstalled. On the update from a version that kept the key in
 * chrome.storage.local, copies it into the trusted store; in every case, removes any key found
 * there.
 *
 * Whether chrome.storage.local may be read is decided by Chrome's install event, which no page
 * can raise, and never by what that area holds: content scripts can WRITE it, and adopting a
 * record from it would let a compromised page point this person's extension at another account.
 * So it is read once, on that update, when what it holds is what 0.7.x's own worker wrote.
 *
 * A record already in the trusted store is never replaced. A failed copy is not retried (a later
 * start has no install event to permit another read): the person reads as not connected and
 * reconnects, and the old key is removed regardless.
 */
export function moveLegacyConnection(
  details: InstalledDetails,
  store: TrustedStore = trustedStore,
  local: LegacyArea = chrome.storage.local,
): Promise<void> {
  moving = (async () => {
    try {
      const fromLocalEra = details.reason === 'update' && typeof details.previousVersion === 'string'
        && isNewer(KEY_LEFT_LOCAL_BEFORE, details.previousVersion);
      if (!fromLocalEra) return;
      // Validated on the way across, so only what setConnection writes ever reaches the store.
      const legacy = asConnection((await local.get(CONNECTION_KEY))[CONNECTION_KEY]);
      if (legacy && asConnection(await store.get(CONNECTION_KEY)) === null) {
        await store.set(CONNECTION_KEY, legacy);
      }
    } catch (err) {
      console.warn('[D7 Studio] Varys: the key 0.7.x stored could not be moved, so this browser must reconnect', err);
    } finally {
      try {
        await local.remove(CONNECTION_KEY);
      } catch (err) {
        console.warn('[D7 Studio] Varys: could not remove the key 0.7.x stored', err);
      }
    }
  })();
  return moving;
}

/**
 * A stored record as a connection, or null when it is not exactly what setConnection writes.
 * Storage outlives a version of the extension, and a mangled key must be neither sent as a
 * bearer token nor shown as "connected".
 */
function asConnection(stored: unknown): VarysConnection | null {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;
  const c = stored as Partial<VarysConnection>;
  if (!isValidKey(c.key) || typeof c.email !== 'string' || typeof c.connectedAt !== 'string') return null;
  return {
    key: c.key,
    email: c.email,
    connectedAt: c.connectedAt,
    ...(c.expired === true ? { expired: true } : {}),
  };
}

/**
 * Reads the stored connection from the trusted store, or null. Never from chrome.storage.local.
 * Waits for a move from 0.7.x that is still running, so the first message after an update does
 * not read as "not connected".
 */
export async function getConnection(store: TrustedStore = trustedStore): Promise<VarysConnection | null> {
  await moving;
  return asConnection(await store.get(CONNECTION_KEY));
}

/** Stores a connection, or with null forgets it, key and all. */
export async function setConnection(c: VarysConnection | null, store: TrustedStore = trustedStore): Promise<void> {
  if (c === null) await store.remove(CONNECTION_KEY);
  else await store.set(CONNECTION_KEY, c);
}
