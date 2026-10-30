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
 * those scripts CAN read (and write); migrateLegacyConnection moves it across once. Nothing
 * outside the service worker is shown it: the popup asks for a status, which is built by
 * toStatus() and has no key in it.
 */

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

/** Set in the trusted store once 0.7.x's chrome.storage.local record has been dealt with. */
export const MIGRATED_KEY = 'legacyConnectionMigrated';

/** The part of chrome.storage.local the move needs. */
type LegacyArea = Pick<chrome.storage.StorageArea, 'get' | 'remove'>;

/** One move per store object, i.e. per worker lifetime; a failed one is forgotten and retried. */
const moves = new WeakMap<TrustedStore, Promise<void>>();

/**
 * Moves a connection 0.7.x kept in chrome.storage.local into the trusted store, once per
 * profile, and from then on deletes anything found there unread.
 *
 * Content scripts can write chrome.storage.local, so after the move a record there is never a
 * credential: trusting one would let a compromised page point this person's extension at
 * another account. Before the move, the record there is the one 0.7.x's worker wrote.
 *
 * Order matters: copy, then the marker, then the delete. A failure leaves the old record and no
 * marker, so the next attempt starts again; a record already in the trusted store is never
 * replaced by the old one.
 */
export function migrateLegacyConnection(
  store: TrustedStore = trustedStore,
  local: LegacyArea = chrome.storage.local,
): Promise<void> {
  let move = moves.get(store);
  if (!move) {
    move = (async () => {
      if ((await store.get(MIGRATED_KEY)) === true) {
        await local.remove(CONNECTION_KEY);
        return;
      }
      // Validated on the way across, so only what setConnection writes ever reaches the store.
      const legacy = asConnection((await local.get(CONNECTION_KEY))[CONNECTION_KEY]);
      if (legacy && asConnection(await store.get(CONNECTION_KEY)) === null) {
        await store.set(CONNECTION_KEY, legacy);
      }
      await store.set(MIGRATED_KEY, true);
      await local.remove(CONNECTION_KEY);
    })();
    moves.set(store, move);
    move.catch(() => moves.delete(store));
  }
  return move;
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
 * Reads the stored connection, or null. A move that could not finish reads as not connected,
 * never as whatever chrome.storage.local holds.
 */
export async function getConnection(store: TrustedStore = trustedStore): Promise<VarysConnection | null> {
  try {
    await migrateLegacyConnection(store);
  } catch (err) {
    console.warn('[D7 Studio] Varys: the stored key could not be moved yet; reading as not connected', err);
    return null;
  }
  return asConnection(await store.get(CONNECTION_KEY));
}

/** Stores a connection, or with null forgets it, key and all. */
export async function setConnection(c: VarysConnection | null, store: TrustedStore = trustedStore): Promise<void> {
  if (c === null) await store.remove(CONNECTION_KEY);
  else await store.set(CONNECTION_KEY, c);
}
