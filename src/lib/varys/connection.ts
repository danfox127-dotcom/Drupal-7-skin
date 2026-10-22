/**
 * The optional connection to Varys: what is stored, and who may create it.
 *
 * Nothing in this extension talks to Varys until someone connects. Connecting means
 * granting the Varys API host permission from the popup, then signing in on the Varys
 * connect page, which hands a key to the service worker through
 * chrome.runtime.sendMessage (answered by the worker's onMessageExternal listener).
 *
 * The key is a bearer credential for this person's Varys account. It lives in
 * chrome.storage.local under its own key, apart from the feature toggles, and nothing
 * outside the service worker is shown it: the popup asks for a status, which is built by
 * toStatus() and has no key in it.
 */

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
 * `revoked` is false when Varys could not be told, so the key may still be live there.
 * The key is forgotten locally either way.
 */
export interface VarysDisconnectResponse {
  ok: true;
  revoked: boolean;
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

/** Strips the key. The popup is built from this and cannot show what it was not given. */
export function toStatus(c: VarysConnection | null): VarysStatus | null {
  return c ? { email: c.email, connectedAt: c.connectedAt, expired: c.expired === true } : null;
}

/**
 * Reads the stored connection, or null.
 *
 * A record that is not exactly what setConnection writes is treated as no connection at
 * all. Storage outlives a version of the extension, and a mangled key must be neither
 * sent as a bearer token nor shown as "connected".
 */
export async function getConnection(): Promise<VarysConnection | null> {
  const stored = (await chrome.storage.local.get(CONNECTION_KEY))[CONNECTION_KEY] as
    Partial<VarysConnection> | null | undefined;

  if (
    typeof stored !== 'object' || stored === null || Array.isArray(stored)
    || !isValidKey(stored.key)
    || typeof stored.email !== 'string'
    || typeof stored.connectedAt !== 'string'
  ) {
    return null;
  }

  return {
    key: stored.key,
    email: stored.email,
    connectedAt: stored.connectedAt,
    ...(stored.expired === true ? { expired: true } : {}),
  };
}

/** Stores a connection, or with null forgets it, key and all. */
export async function setConnection(c: VarysConnection | null): Promise<void> {
  if (c === null) {
    await chrome.storage.local.remove(CONNECTION_KEY);
  } else {
    await chrome.storage.local.set({ [CONNECTION_KEY]: c });
  }
}
