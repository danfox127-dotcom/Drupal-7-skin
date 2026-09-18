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
 * toolbar icon plus a line in the popup.
 *
 * SINCE PUBLICATION, this is a migration tool rather than a permanent fixture. The
 * extension now lives on the Chrome Web Store (unlisted), where Chrome updates it
 * automatically — so a store build does not check at all, and a hand-loaded copy is told
 * to move to the store rather than to fetch another zip. The zip is what caused someone
 * to load the wrong folder twice and get a card that looked installed and did nothing;
 * pointing at it forever would keep that failure available.
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
  /**
   * Where to get it properly — the store listing.
   *
   * Set whenever an update is available to a hand-loaded copy, because moving to the
   * store is the fix for the whole class of problem the zip caused: the wrong folder,
   * a stale folder, a folder that was moved, and a build nobody remembers loading.
   */
  storeUrl?: string;
  /** Epoch ms of the last successful check, for showing staleness. */
  checkedAt?: number;
}

/** Storage key the background writes and the popup reads. */
export const UPDATE_STATE_KEY = 'updateState';

/** Where the published version lives. Public repo, so no auth and no rate limit. */
export const LATEST_URL =
  'https://raw.githubusercontent.com/danfox127-dotcom/Drupal-7-skin/main/latest.json';

/**
 * The Chrome Web Store item, now that the extension is published there (unlisted).
 *
 * The id is how a build identifies ITSELF. Chrome assigns a store-installed extension
 * this fixed id, and gives an unpacked one an id derived from its folder path — so
 * comparing chrome.runtime.id against this is a reliable, permission-free answer to
 * "am I the store build or a hand-loaded copy?". chrome.management.getSelf() would say
 * the same thing and costs a permission.
 */
export const STORE_ID = 'ebooneiidohdlmcddhnlnnolhjehpcec';

/**
 * The listing. Unlisted, so it never appears in store search and this link is the only
 * way in — which is exactly why it belongs in the code rather than in someone's notes.
 */
export const STORE_URL = `https://chromewebstore.google.com/detail/${STORE_ID}`;

/** True when this build was installed from the Chrome Web Store. */
export function isStoreInstall(extensionId: string | undefined): boolean {
  return extensionId === STORE_ID;
}

/**
 * Whether this build should poll for updates at all.
 *
 * A store install must NOT: Chrome updates it, so the notifier could only ever tell the
 * user to go and do by hand something that has already happened — and it would keep
 * saying so until latest.json was pushed, which is a lie with a badge on it.
 *
 * A hand-loaded copy still checks, because Chrome will never update it. What changed is
 * what the notice SAYS: the way out is now the store, not another zip.
 */
export function shouldCheckForUpdates(extensionId: string | undefined): boolean {
  return !isStoreInstall(extensionId);
}

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
    storeUrl: STORE_URL,
  };
}
