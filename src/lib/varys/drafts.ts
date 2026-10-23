/**
 * What the Drafts panel on a `node/add/*` form and the worker say to each other.
 *
 * The panel (a content script) cannot reach Varys: the key lives in the worker, and so does the
 * check that the form's site is one Varys tracks. It sends the worker one of the requests below
 * and gets a reply back. The answer shapes are Varys's own, from GET /api/extension/drafts and
 * GET /api/extension/drafts/{id}; what the worker hands the panel is checked here once, so
 * neither the panel nor the fill looks again.
 */

/** One draft in the list: enough to choose it. `title` is the list's label, not Drupal's Title. */
export type DraftSummary = {
  id: string;
  title: string;
  /** ISO time Varys made the draft. */
  made_at: string;
};

/** One person a draft names, and what Varys could match them to in the physician directory. */
export type DraftDoctor = {
  name: string;
  status: 'matched' | 'ambiguous' | 'not_matched';
  full_name: string | null;
  source: 'quoted' | 'topic';
  /** True when the match is the same name, not only a likely one. */
  exact: boolean;
};

/** What Varys has for the form's site. `not_tracked` says why there is nothing else. */
export type DraftListAnswer =
  | { status: 'not_tracked' }
  | { status: 'ok'; drafts: DraftSummary[] };

/**
 * One draft, ready to fill in. Drupal's Title field is only ever filled from `title`, which is
 * the one the person confirmed (null when they did not); `label` is for showing the draft in a
 * list and is never written into the form.
 */
export type DraftAnswer =
  | { status: 'not_tracked' }
  | {
    status: 'ready';
    id: string;
    title: string | null;
    label: string;
    made_at: string;
    body_html: string;
    overview_bullets: string[];
    summary: string | null;
    meta_title: string | null;
    doctors: DraftDoctor[] | null;
    /** What Varys could not carry into the body: tables and images the draft had. */
    dropped: { tables: number; images: number };
    counts: { words: number; headings: number; lists: number; links: number };
  };

/** Why the worker has no answer. `message` is for the person, in the extension's words. */
export type DraftFailureReason = 'not_connected' | 'expired' | 'unreachable' | 'error';

/** The worker's reply to `varysDrafts`. */
export type DraftsReply =
  | { ok: true; answer: DraftListAnswer }
  | { ok: false; reason: DraftFailureReason; message: string };

/** The worker's reply to `varysDraft`; `not_found` is Varys's 404 for a draft it does not have. */
export type DraftReply =
  | { ok: true; answer: DraftAnswer }
  | { ok: false; reason: DraftFailureReason | 'not_found'; message: string };

/** Asks Varys for the drafts this person has for a form's site. */
export interface VarysDraftsRequest {
  type: 'varysDrafts';
  /** `location.origin + '/'` on an add form. Varys uses only the host. */
  pageUrl: string;
}

/** Asks Varys for one draft, ready to fill in. */
export interface VarysDraftRequest {
  type: 'varysDraft';
  /** `location.origin + '/'` on an add form. Varys uses only the host. */
  pageUrl: string;
  id: string;
}

/**
 * Asks the page's CKEditor whether its content filter would keep a piece of markup, by the
 * editor's own rule syntax (e.g. `p(lead)[title]`). Run in the page's own world, since
 * CKEDITOR is not visible to a content script.
 */
export interface RichEditorAllowsRequest {
  type: 'richEditorAllows';
  elementId: string;
  rule: string;
}

/** `allowed` is null when there is no telling: no CKEditor instance for that field, or none that can say. */
export interface RichEditorAllowsResponse {
  allowed: boolean | null;
}

/** Shown when Varys answers 404 for a draft and gives no words of its own. */
export const DRAFT_NOT_FOUND_COPY = "Varys can't find that draft.";

const isText = (v: unknown): v is string => typeof v === 'string';
const isTextOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseSummary(v: unknown): DraftSummary | null {
  if (!isRecord(v)) return null;
  return isText(v.id) && isText(v.title) && isText(v.made_at)
    ? { id: v.id, title: v.title, made_at: v.made_at }
    : null;
}

function parseDoctor(v: unknown): DraftDoctor | null {
  if (!isRecord(v)) return null;
  const { name, status, full_name, source, exact } = v;
  if (!isText(name) || !isTextOrNull(full_name) || typeof exact !== 'boolean') return null;
  if (status !== 'matched' && status !== 'ambiguous' && status !== 'not_matched') return null;
  if (source !== 'quoted' && source !== 'topic') return null;
  return { name, status, full_name, source, exact };
}

/** The doctors as an array, `null` for Varys's own null, and `undefined` for anything else. */
function parseDoctors(v: unknown): DraftDoctor[] | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  const doctors = v.map(parseDoctor);
  return doctors.every((d): d is DraftDoctor => d !== null) ? doctors : undefined;
}

/**
 * Varys's list of drafts if it is one of the shapes above, else null. One draft of the wrong
 * shape spoils the list, since a shorter list shown without saying so would be a wrong one.
 */
export function parseDraftList(json: unknown): DraftListAnswer | null {
  if (!isRecord(json)) return null;
  if (json.status === 'not_tracked') return { status: 'not_tracked' };
  if (json.status !== 'ok' || !Array.isArray(json.drafts)) return null;
  const drafts = json.drafts.map(parseSummary);
  return drafts.every((d): d is DraftSummary => d !== null) ? { status: 'ok', drafts } : null;
}

/**
 * Varys's draft if it is one of the shapes above, else null. `body_html` must be text: a ready
 * draft without a body has nothing to fill in, and the fill writes it into the form unread.
 */
export function parseDraft(json: unknown): DraftAnswer | null {
  if (!isRecord(json)) return null;
  if (json.status === 'not_tracked') return { status: 'not_tracked' };
  if (json.status !== 'ready') return null;

  const { id, title, label, made_at, body_html, overview_bullets, summary, meta_title, dropped, counts } = json;
  const doctors = parseDoctors(json.doctors);
  if (!isText(id) || !isTextOrNull(title) || !isText(label) || !isText(made_at) || !isText(body_html)) return null;
  if (!Array.isArray(overview_bullets) || !overview_bullets.every(isText)) return null;
  if (!isTextOrNull(summary) || !isTextOrNull(meta_title) || doctors === undefined) return null;
  if (!isRecord(dropped) || !isCount(dropped.tables) || !isCount(dropped.images)) return null;
  if (!isRecord(counts) || !isCount(counts.words) || !isCount(counts.headings)
    || !isCount(counts.lists) || !isCount(counts.links)) return null;

  return {
    status: 'ready',
    id,
    title,
    label,
    made_at,
    body_html,
    overview_bullets,
    summary,
    meta_title,
    doctors,
    dropped: { tables: dropped.tables, images: dropped.images },
    counts: { words: counts.words, headings: counts.headings, lists: counts.lists, links: counts.links },
  };
}
