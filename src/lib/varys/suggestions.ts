/**
 * What the Page Health suggestions panel and the worker say to each other, and the one piece
 * of copy the extension writes itself for it.
 *
 * The panel (a content script) cannot reach Varys: the key lives in the worker, and so does
 * the check that the page's site is one Varys tracks. It sends the worker one of the two
 * requests below and gets a `SuggestionsReply` back. The answer shapes are Varys's own, from
 * GET /api/extension/suggestions and POST /api/extension/suggestions/generate.
 */

import type { CarriedFills } from './suggestionFill';

/** One side of the comparison: what the page has, or what Varys suggests. */
export type ScaffoldSide = {
  meta_title: string | null;
  meta_description: string | null;
  h1: string | null;
  h2s: string[];
};

/**
 * What Varys knows about a page's suggestions. `not_tracked` and `not_crawled` say why there
 * are none; `none` that Varys looked and has nothing to suggest; `generating` that it is
 * making them now (only the generate request answers that).
 */
export type SuggestionsAnswer =
  | { status: 'not_tracked' | 'not_crawled' | 'generating' }
  /** The doctors the article names, as on `ready`: the reminder needs no suggestions. */
  | { status: 'none'; named_doctors: string[] }
  | {
      status: 'ready';
      /** ISO time Varys made them; null when Varys has no time for them. */
      made_at: string | null;
      clinical_review_note: string | null;
      current: ScaffoldSide;
      suggested: ScaffoldSide;
      /**
       * Full names (the directory's: "Jacqueline L Steele, MD") of the doctors the crawled
       * article names. Empty when it names none, and when this Varys is older than the field.
       */
      named_doctors: string[];
    };

/** The worker's reply to either request. `message` is for the person, in the extension's words. */
export type SuggestionsReply =
  | { ok: true; answer: SuggestionsAnswer }
  | { ok: false; reason: 'not_connected' | 'expired' | 'unreachable' | 'error'; message: string };

/** Asks Varys for the suggestions it already has for a page, or to make them. */
export interface VarysSuggestionsRequest {
  type: 'varysSuggestions' | 'varysGenerateSuggestions';
  /** Absolute public address of the page being edited. Never the edit form's. */
  pageUrl: string;
}

/**
 * The panel's live fills, for the worker to keep with the form as it first opened, so a
 * Preview or a rejected save does not lose their Undo (ruling R18). No reply. `formPath` is
 * the edit form's own path; the worker keeps them only for that form, in that tab.
 */
export interface VarysCarryFillsMessage {
  type: 'varysCarryFills';
  formPath: string;
  fills: CarriedFills | null;
}

/** What the panel on this form had before a re-render. The reply is the CarriedFills, or null. */
export interface VarysCarriedFillsRequest {
  type: 'varysCarriedFills';
  formPath: string;
}

/**
 * Whether a page's site is one Varys tracks, by the list Varys last gave this person, asked
 * before the panel reads anything of the page from the site (ruling R19). The page's address
 * is never sent to Varys for this: the list is the one the worker caches, of any age, and is
 * fetched (a request that names no page) only when there is none.
 */
export interface VarysSiteTrackedRequest {
  type: 'varysSiteTracked';
  pageUrl: string;
}

/** True or false by that list; null when there is no telling: not connected, an expired key, or no list to be had. */
export interface VarysSiteTrackedResponse {
  tracked: boolean | null;
}

/** Shown when Insert finds nowhere to put the heading. */
export const SUGGESTIONS_NO_CURSOR_COPY = 'Click in the body where the heading should go, then press Insert again.';

/**
 * Shown when Varys answered with an error. Its own detail ("Not Found") means nothing to the
 * person editing, so it goes to the console instead (ruling R12).
 */
export const SUGGESTIONS_ERROR_COPY = "Varys couldn't answer for this page right now.";

const isText = (v: unknown): v is string => typeof v === 'string';
const isTextOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** Optional: an older Varys omits it. Not text all through means none, never a rejected answer. */
const namedDoctors = (v: unknown): string[] => (Array.isArray(v) && v.every(isText) ? v : []);

function isScaffoldSide(v: unknown): v is ScaffoldSide {
  if (typeof v !== 'object' || v === null) return false;
  const side = v as Record<string, unknown>;
  return isTextOrNull(side.meta_title) && isTextOrNull(side.meta_description) && isTextOrNull(side.h1)
    && Array.isArray(side.h2s) && side.h2s.every(isText);
}

/**
 * Varys's answer if it is one of the shapes above, else null. The panel reads these fields
 * without looking again, so what the worker hands it is checked here once.
 */
export function parseSuggestionsAnswer(json: unknown): SuggestionsAnswer | null {
  if (typeof json !== 'object' || json === null) return null;
  const a = json as Record<string, unknown>;
  switch (a.status) {
    case 'not_tracked':
    case 'not_crawled':
    case 'generating':
      return { status: a.status };
    case 'none':
      return { status: 'none', named_doctors: namedDoctors(a.named_doctors) };
    case 'ready':
      return isTextOrNull(a.made_at) && isTextOrNull(a.clinical_review_note)
        && isScaffoldSide(a.current) && isScaffoldSide(a.suggested)
        ? {
          status: 'ready',
          made_at: a.made_at,
          clinical_review_note: a.clinical_review_note,
          current: a.current,
          suggested: a.suggested,
          named_doctors: namedDoctors(a.named_doctors),
        }
        : null;
    default:
      return null;
  }
}
