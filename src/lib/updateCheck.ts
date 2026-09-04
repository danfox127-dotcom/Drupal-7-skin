/**
 * Tells the user when their copy of the extension is out of date.
 *
 * It does NOT update anything, and cannot: Chrome only honours a self-hosted
 * `update_url` for extensions installed by enterprise policy, and ignores it entirely
 * for the "Load unpacked" install this is distributed as. Adding one to the manifest
 * would look like an auto-updater and do nothing.
 *
 * So the honest version of the feature is a notifier. It reads a small file published
 * alongside the source, compares it to the running build, and puts a badge on the
 * toolbar icon plus a line in the popup. The human still downloads and reloads — but
 * they find out, instead of quietly running a build from weeks ago.
 *
 * Deliberately requires no new permission. raw.githubusercontent.com serves
 * `access-control-allow-origin: *`, so a plain fetch from the extension's own context
 * is allowed under CORS without a host permission, and the check runs on browser start
 * rather than on a timer, which avoids `alarms` too.
 */

/** The published file's shape, after validation. */
export interface LatestRelease {
  version: string;
  notes?: string;
  /** https only — the popup renders this as a link the user clicks. */
  download?: string;
}

export interface UpdateState {
  available: boolean;
  /** The running build, always set. */
  current: string;
  /** Only when a newer version was found. */
  latest?: string;
  notes?: string;
  download?: string;
  /** Epoch ms of the last successful check, for showing staleness. */
  checkedAt?: number;
}

/** Storage key the background writes and the popup reads. */
export const UPDATE_STATE_KEY = 'updateState';

/** Where the published version lives. Public repo, so no auth and no rate limit. */
export const LATEST_URL =
  'https://raw.githubusercontent.com/danfox127-dotcom/Drupal-7-skin/main/latest.json';

/**
 * Chrome permits one to four dot-separated integers, each 0–65535.
 *
 * Anything else — an empty string, a word, an HTML error page served with a 200 — is
 * rejected rather than coerced, because a bad parse that lands on the high side would
 * nag on every browser start with no way for the user to make it stop.
 */
function parseVersion(value: string): number[] | null {
  const parts = value.trim().split('.');
  if (parts.length === 0 || parts.length > 4) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 65535) return null;
    numbers.push(n);
  }
  return numbers;
}

/**
 * True when `latest` is strictly greater than `current`.
 *
 * Compared component by component as numbers. A string compare puts "0.10.0" below
 * "0.9.0", which would leave everyone stranded on 0.9.x the moment the minor hit double
 * digits — silently, since nothing would ever report an update again.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;

  const width = Math.max(a.length, b.length);
  for (let i = 0; i < width; i++) {
    // A missing trailing component is zero: "1.2" and "1.2.0" are the same version.
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/** Only https, so a published file cannot turn the popup's link into a script. */
function safeDownload(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validates whatever came back from the network.
 *
 * The file is fetched from a URL, so it is untrusted input by definition — a redirect,
 * a captive portal, or a mistyped commit can all return a 200 with something else in it.
 */
export function parseLatest(raw: unknown): LatestRelease | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const source = raw as Record<string, unknown>;
  if (typeof source.version !== 'string' || !parseVersion(source.version)) return null;

  return {
    version: source.version.trim(),
    notes: typeof source.notes === 'string' && source.notes.trim()
      ? source.notes.trim()
      : undefined,
    download: safeDownload(source.download),
  };
}

/**
 * Decides what to show, given the running version and whatever was published.
 *
 * A locally-built copy ahead of the published version reports nothing: telling a
 * developer to downgrade would be worse than saying nothing.
 */
export function evaluateUpdate(current: string, raw: unknown): UpdateState {
  const latest = parseLatest(raw);
  if (!latest || !isNewer(latest.version, current)) {
    return { available: false, current };
  }
  return {
    available: true,
    current,
    latest: latest.version,
    notes: latest.notes,
    download: latest.download,
  };
}
