/**
 * Following a Drupal save to Varys: the decisions, kept pure so they can be tested without a
 * browser. The service worker (src/background/index.ts) does the storage, the network and the
 * tab events, and asks this file what each of them means.
 *
 * The flow, end to end:
 *  1. The content script records the form when it opens (`varysFormOpened`) and again at Save
 *     (`varysSubmit`), and hands both to the worker without waiting for anything.
 *  2. The worker keeps the submission as a PendingSubmit and watches the tab. Drupal answers a
 *     save with a redirect; a failed one re-renders the form at the same address.
 *  3. When the tab finishes loading, outcomeOfNavigation says whether the save went through
 *     and what the page's public address is, and the worker posts it to Varys, or queues it.
 *
 * Nothing here touches chrome.* or the network.
 */

import type { VarysFilledField } from './filled';
import type { CarriedFills } from './suggestionFill';
import { bareHost, type ButtonKind, type PageState, type RawFormValues, type VarysSubmitMessage } from './pageState';

// ------------------------------------------------------------------------------------- copy

/** The notices the extension writes itself. Every other notice is Varys's own `message`. */
export const UNTRACKED_COPY = "This site isn't in Varys, so nothing was logged.";
export const UNREACHABLE_COPY = "Varys couldn't be reached. This save will be sent when it can.";
export const EXPIRED_COPY =
  'Your Varys connection has expired. Reconnect from the extension menu to log this save.';

/** What Undo or Log it anyway says when it could not do what it was asked. */
export const ACTION_EXPIRED_COPY = 'Your Varys connection has expired. Reconnect from the extension menu.';
export const ACTION_UNREACHABLE_COPY = "Varys couldn't be reached, so nothing changed. Try again in a moment.";
export const ACTION_NOT_CONNECTED_COPY = "This browser isn't connected to Varys any more, so nothing changed.";

// -------------------------------------------------------------------------- the save itself

/** A save as the worker holds it while it waits to learn the page's address. */
export type SavePayload = Omit<VarysSubmitMessage, 'type' | 'formPath' | 'submittedAt'>;

/** The Save request Varys accepts at POST /api/extension/saves, in its own snake_case. */
export interface SaveRequest {
  /** Absolute public address of the page. Never the edit form's. */
  page_url: string;
  node_id: string | null;
  content_type: string | null;
  button: ButtonKind;
  body_change_ratio: number;
  /** Always present: null for a new node, which Varys diffs against an empty page. */
  before: PageState | null;
  after: PageState;
  /** What the person filled from Varys's panel: Varys keeps title, meta_title, meta_description, headings, body and related_profiles. */
  varys_filled: VarysFilledField[];
}

export function toSaveRequest(payload: SavePayload, pageUrl: string, nodeId: string | null): SaveRequest {
  const ratio = Number.isFinite(payload.bodyChangeRatio) ? payload.bodyChangeRatio : 0;
  return {
    page_url: pageUrl,
    node_id: nodeId,
    content_type: payload.contentType,
    button: payload.button,
    // Varys refuses anything outside 0..1 with a 422, which no retry can fix.
    body_change_ratio: Math.min(1, Math.max(0, ratio)),
    before: payload.before,
    after: payload.after,
    varys_filled: payload.varysFilled,
  };
}

// ------------------------------------------------------------------- following the navigation

/** A save the worker is following, kept in chrome.storage.session under varysPending:<tabId>. */
export interface PendingSubmit {
  tabId: number;
  /** The form's own path, e.g. /node/23110/edit. */
  formPath: string;
  /**
   * The form page's whole address, query string included. A `destination` in it is where
   * Drupal sends the person after saving, which is then not the page that was saved.
   */
  formUrl: string;
  /** When Save was pressed, by the page's clock (the same machine's as the worker's). */
  submittedAt: number;
  /**
   * Whose save it is: the connection's email when it was pressed. A save is only ever sent
   * under that same person's key; a pending save outlives a connection otherwise.
   */
  email: string;
  /**
   * Whether the tab has started loading since Save was pressed. Only a load that started
   * after it can say how the save went (see outcomeWhenLoaded).
   */
  loadingSeen: boolean;
  payload: SavePayload;
}

/** A pending submission with no finished navigation after this long is sent anyway. */
export const PENDING_TIMEOUT_MS = 60_000;

export type NavigationOutcome =
  | { kind: 'failed' }
  | { kind: 'saved'; pageUrl: string; nodeId: string | null }
  /** It went through, but nothing says which page it was: a new node sent to an admin page. */
  | { kind: 'noAddress' }
  /**
   * It did not happen: Save landed on the login page (Drupal's session had expired) or on
   * another site (a single sign-on). Not a failed save of the form either: the person saves
   * again once logged in, and the form's original before is kept for that.
   */
  | { kind: 'interrupted' };

/** Drupal's login and account pages. Save landing here means the session had expired. */
const LOGIN = /^\/user(?:\/|$)/;

/**
 * Paths that are not a page someone reads: admin screens, node forms and a node's own
 * sub-pages (/node/N/edit, /node/N/revisions). /node/N itself is a page.
 */
const NOT_A_PAGE = /^\/admin(?:\/|$)|^\/node\/add(?:\/|$)|^\/node\/\d+\/./;

const nodeIdOfPagePath = (path: string): string | null => path.match(/^\/node\/(\d+)\/?$/)?.[1] ?? null;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * What a finished navigation says about a save, and the page's public address if it went
 * through.
 *
 * - On another site, or on the login page: it was INTERRUPTED (see NavigationOutcome).
 * - Back on the form's own path: Drupal re-rendered the form, so the save FAILED (validation)
 *   and nothing is sent.
 * - Anywhere else on the site, it went through. The address is, in order:
 *   1. where Drupal landed, when that is a page on the same site and the form carried no
 *      `?destination`. A node save then redirects to the node itself, under its CURRENT alias,
 *      which is better than anything the form knew: the form only had /node/N when it showed
 *      no View tab, and an alias changed by this very save is only right here.
 *   2. the page address the form knew (its View tab, or /node/N);
 *   3. /node/<id>, when only the id is known;
 *   and otherwise there is no address and nothing can be sent.
 *
 * The `?destination` rule is why (1) is not simply "wherever it landed": an Edit link in a
 * listing carries `?destination=<the listing>`, and the save then lands on the listing.
 */
export function outcomeOfNavigation(p: PendingSubmit, finalUrl: string): NavigationOutcome {
  const form = parse(p.formUrl);
  const final = parse(finalUrl);
  if (form === null || final === null || bareHost(final.host) !== bareHost(form.host)) {
    return { kind: 'interrupted' };
  }
  if (final.pathname === p.formPath) return { kind: 'failed' };
  if (LOGIN.test(final.pathname)) return { kind: 'interrupted' };

  const nodeId = p.payload.nodeId ?? nodeIdOfPagePath(final.pathname);
  if (!form.searchParams.has('destination') && !NOT_A_PAGE.test(final.pathname)) {
    return { kind: 'saved', pageUrl: final.origin + final.pathname, nodeId };
  }
  return addressFromForm(p, nodeId);
}

/**
 * The tab started loading at `at`. Only a load that began after Save was pressed is the
 * answer to it.
 */
export function noteLoading(p: PendingSubmit, at: number): PendingSubmit {
  return !p.loadingSeen && at >= p.submittedAt ? { ...p, loadingSeen: true } : p;
}

/**
 * What a finished load says about a save, or null when it says nothing: the load had started
 * before Save was pressed (the form page's own, finishing just after). Back on the form's
 * path, that load would read as a failed save, and the real one would never be sent.
 */
export function outcomeWhenLoaded(p: PendingSubmit, finalUrl: string): NavigationOutcome | null {
  return p.loadingSeen ? outcomeOfNavigation(p, finalUrl) : null;
}

/**
 * The address for a save whose navigation was never seen to finish (see PENDING_TIMEOUT_MS):
 * what the form knew, or /node/<id>.
 */
export function outcomeOfTimeout(p: PendingSubmit): NavigationOutcome {
  return addressFromForm(p, p.payload.nodeId);
}

function addressFromForm(p: PendingSubmit, nodeId: string | null): NavigationOutcome {
  if (p.payload.pageUrl) return { kind: 'saved', pageUrl: p.payload.pageUrl, nodeId };
  const form = parse(p.formUrl);
  if (nodeId && form) return { kind: 'saved', pageUrl: `${form.origin}/node/${nodeId}`, nodeId };
  return { kind: 'noAddress' };
}

// --------------------------------------------------------------- the before a form opened with

/**
 * The form as it FIRST opened in a tab, kept in chrome.storage.session under varysForm:<tabId>.
 *
 * Drupal's Preview and a save that fails validation both re-render /node/N/edit with the
 * values just submitted, and the content script on that re-render reads THOSE as its before.
 * Sent as they are, Varys would be told the page started out as the person's own unsaved
 * edit. So the first before is kept while the tab stays on the form, and wins.
 */
export interface OpenedForm {
  origin: string;
  formPath: string;
  /** The before Varys is sent: null on an add form. */
  before: PageState | null;
  /**
   * The raw values it was read from, handed back to the content script on a re-render so its
   * body comparisons are against the original too. Null when the first thing the worker heard
   * from this form was its Save. Never sent to Varys.
   */
  raw: RawFormValues | null;
  /**
   * The suggestions panel's live fills (their Undo records, the keep-address note, whether a
   * heading was inserted), so the panel on a re-render of this same form can take them up
   * again: a Preview, or a save Drupal rejected, re-renders the form with the fills still in
   * it. They go with the record, so a save that goes through drops them. Never sent to Varys.
   * Absent on a record no panel has written to, or from a version before the panel had them.
   */
  fills?: CarriedFills | null;
}

export type FormEvent =
  /** The content script read the form (varysFormOpened), or a Save arrived with no record. */
  | { kind: 'opened'; url: string; formPath: string; before: PageState | null; raw: RawFormValues | null }
  /** The tab is now at `url`. */
  | { kind: 'navigated'; url: string }
  /** A save from this form went through. */
  | { kind: 'saved' }
  /** The panel on the form at `url` has these fills now (varysCarryFills). */
  | { kind: 'fills'; url: string; formPath: string; fills: CarriedFills | null };

const originOf = (url: string): string | null => parse(url)?.origin ?? null;

/**
 * The tab's opened form after an event.
 *
 * - opened: the FIRST record for a form wins. A re-render (a preview, a failed save) is the
 *   same origin and path, so it changes nothing; a different form replaces it.
 * - navigated: kept while the tab is on the same form, gone once it is on another page of the
 *   site. A failed save or a preview reloads the same path, so it survives them. So does a
 *   detour to log in, on the site's /user pages or another site's sign-on: nothing on the
 *   site changed meanwhile, and the person comes back to the form to save again.
 * - saved: gone. The page has a new before now.
 * - fills: set on the record when it is for the same form, and nothing otherwise. Never a
 *   record of its own: one without a before would win as the form's first.
 */
export function nextOpenedForm(current: OpenedForm | undefined, event: FormEvent): OpenedForm | undefined {
  if (event.kind === 'saved') return undefined;

  if (event.kind === 'fills') {
    if (!current || current.origin !== originOf(event.url) || current.formPath !== event.formPath) return current;
    return { ...current, fills: event.fills };
  }

  if (event.kind === 'navigated') {
    if (!current) return undefined;
    const url = parse(event.url);
    const site = parse(current.origin);
    if (!url || !site || bareHost(url.host) !== bareHost(site.host)) return current;
    return url.pathname === current.formPath || LOGIN.test(url.pathname) ? current : undefined;
  }

  const origin = originOf(event.url);
  if (origin === null) return current;
  if (current && current.origin === origin && current.formPath === event.formPath) return current;
  return { origin, formPath: event.formPath, before: event.before, raw: event.raw };
}

/**
 * The fills the panel left on this tab's record of the form at `url` (path `formPath`), or
 * null: there is no record, it is some other form's, or no panel wrote any.
 */
export function carriedFillsFor(opened: OpenedForm | undefined, url: string, formPath: string): CarriedFills | null {
  if (!opened || opened.origin !== originOf(url) || opened.formPath !== formPath) return null;
  return opened.fills ?? null;
}

/**
 * A submission with the before its form FIRST opened with, in place of the one the content
 * script read on this render. Unchanged when the record is for some other form.
 */
export function mergeCarriedBefore(opened: OpenedForm | undefined, next: PendingSubmit): PendingSubmit {
  if (!opened || opened.origin !== originOf(next.formUrl) || opened.formPath !== next.formPath) return next;
  return { ...next, payload: { ...next.payload, before: opened.before } };
}

// ------------------------------------------------------------------------- talking to Varys

/** What a failed request means. A status of null is no answer at all. */
export type SendFailure = 'expired' | 'malformed' | 'retry';

/**
 * - 401: the key is invalid or expired. Reconnecting is the only remedy.
 * - 422: Varys says the request breaks its contract. That is a bug here and will fail the
 *   same way forever, so it is never queued.
 * - Anything else, a 5xx above all (Varys's deliberate answer when its database fails), is
 *   worth trying again later.
 */
export function failureOf(status: number | null): SendFailure {
  if (status === 401) return 'expired';
  if (status === 422) return 'malformed';
  return 'retry';
}

/** What sending one queued save says about it, and about the rest of the queue. */
export type QueueVerdict = 'sent' | 'dropped' | 'kept' | 'stop';

/**
 * - sent: Varys took it.
 * - dropped: 422, malformed. This extension's bug, and it would fail the same way for ever.
 * - kept: another 4xx. Varys refused this one for a reason of its own (the save is not this
 *   person's to send, say). It stays, but the next one is tried: one bad entry must not hold
 *   up the queue behind it. The queue's own limits (7 days, 50 saves) bound how long it stays.
 * - stop: no answer, a 5xx, or a 401. Varys is away or the key is dead, so nothing after this
 *   can go either, and this and the rest wait for the next flush.
 */
export function queueVerdict(status: number | null): QueueVerdict {
  if (status !== null && status >= 200 && status < 300) return 'sent';
  if (status === 422) return 'dropped';
  if (status === null || status === 401 || status >= 500) return 'stop';
  return 'kept';
}

/** Whether Varys keeps a workspace for the page's site. `sites` are bare, lowercased hosts. */
export function isTrackedSite(pageUrl: string, sites: readonly string[]): boolean {
  const url = parse(pageUrl);
  return url !== null && sites.includes(bareHost(url.host));
}

/** The answer to GET /api/extension/connection, cached in chrome.storage.session. */
export interface SitesCache {
  email: string;
  sites: string[];
  fetchedAt: number;
}

export const SITES_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * With an expired key Varys cannot be asked which sites it tracks, so the list it last gave
 * this person is the only answer, at any age (it is what the worker falls back to whenever
 * Varys cannot be asked). True when that list exists and lacks the page's site: queued, the
 * save would tell the editor to reconnect and then be dropped by the flush without a word.
 * False when there is no list for this person, so the save is queued as before.
 */
export function knownUntracked(pageUrl: string, cache: SitesCache | undefined, email: string): boolean {
  return cache !== undefined && cache.email === email && Array.isArray(cache.sites)
    && !isTrackedSite(pageUrl, cache.sites);
}

/** The list Varys last gave this person, at any age, or undefined when there is none for them. */
export function cachedSitesFor(cache: SitesCache | undefined, email: string): string[] | undefined {
  return cache !== undefined && cache.email === email && Array.isArray(cache.sites) ? cache.sites : undefined;
}

// -------------------------------------------------------------------------------- the notice

export interface VarysNoticeAction {
  label: 'Undo' | 'Log it anyway';
  type: 'varysUndo' | 'varysLogAnyway';
  saveId: number;
}

export interface VarysNotice {
  message: string;
  action?: VarysNoticeAction;
}

/**
 * The notice for Varys's answer to a save (or to Log it anyway): its own message, with Undo
 * when the save counts and Log it anyway when it does not. Null when there is no message.
 */
export function noticeForResult(result: unknown): VarysNotice | null {
  if (typeof result !== 'object' || result === null) return null;
  const { message, outcome, save_id: saveId } = result as Record<string, unknown>;
  if (typeof message !== 'string' || message.trim() === '') return null;
  if (typeof saveId === 'number' && Number.isInteger(saveId)) {
    if (outcome === 'logged') return { message, action: { label: 'Undo', type: 'varysUndo', saveId } };
    if (outcome === 'not_logged') {
      return { message, action: { label: 'Log it anyway', type: 'varysLogAnyway', saveId } };
    }
  }
  return { message };
}

/** Undo or Log it anyway, from the notice's button, and the worker's answer to it. */
export interface VarysActionRequest {
  type: 'varysUndo' | 'varysLogAnyway';
  saveId: number;
}

export interface VarysActionResponse {
  ok: boolean;
  message: string;
  /** What the button becomes: Log it anyway turns into Undo once the save counts. */
  action?: VarysNoticeAction;
}

/**
 * A notice the worker could not show on the page it was for (it may not inject there). The
 * content script shows it on its next run on the same site, then deletes it. Kept in
 * chrome.storage.local, which content scripts can read; it holds only the notice's own text.
 */
export const PENDING_NOTICE_KEY = 'varysPendingNotice';

export interface StoredNotice {
  /** The site the save was on. */
  host: string;
  notice: VarysNotice;
  storedAt: number;
}

/** Older than this, a stored notice is about a save nobody remembers making. */
export const STORED_NOTICE_MAX_AGE_MS = 60 * 60 * 1000;

/** The stored notice to show on a page of `host` now, or null. */
export function storedNoticeFor(stored: unknown, host: string, now: number): VarysNotice | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const { host: forHost, notice, storedAt } = stored as Partial<StoredNotice>;
  if (typeof forHost !== 'string' || bareHost(forHost) !== bareHost(host)) return null;
  if (typeof storedAt !== 'number' || now - storedAt > STORED_NOTICE_MAX_AGE_MS) return null;
  if (typeof notice?.message !== 'string') return null;
  return { message: notice.message };
}

// --------------------------------------------------------------------------------- the queue

/** A save Varys could not take, kept in chrome.storage.local under varysQueue until it can. */
export interface QueuedSave {
  request: SaveRequest;
  queuedAt: number;
  /**
   * Who made it. A queue outlives a connection, and a save must never be sent under someone
   * else's key, which would credit them with it.
   */
  email: string;
}

export const QUEUE_KEY = 'varysQueue';
export const QUEUE_MAX_ENTRIES = 50;
export const QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const isQueuedSave = (e: unknown): e is QueuedSave => {
  if (typeof e !== 'object' || e === null) return false;
  const { request, queuedAt, email } = e as Partial<QueuedSave>;
  return typeof queuedAt === 'number' && typeof email === 'string'
    && typeof request === 'object' && request !== null && typeof request.page_url === 'string';
};

/**
 * The queue with what is no longer worth sending dropped: entries over seven days old, and all
 * but the newest fifty. Oldest first, which is the order they are sent in.
 *
 * Seven days because a verdict measures from when a change went live, and a save a week late
 * is a week of clicks credited to the wrong side of it; fifty because a queue that long means
 * Varys has been gone for days, not minutes. Anything that is not a well-formed entry is
 * dropped too: storage outlives a version of the extension.
 */
export function pruneQueue(q: unknown, now: number): QueuedSave[] {
  if (!Array.isArray(q)) return [];
  return q
    .filter(isQueuedSave)
    .filter(e => now - e.queuedAt <= QUEUE_MAX_AGE_MS)
    .sort((a, b) => a.queuedAt - b.queuedAt)
    .slice(-QUEUE_MAX_ENTRIES);
}
