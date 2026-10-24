import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { injectOverlay } from './inject';
import { publicUrlFor, varysIsConnected } from './varysCapture';
import { nodeIdFromPath } from '../lib/extractPublicHtml';
import { discoverSchema, findNodeForm, type FieldDescriptor } from '../lib/formSchema';
import { readValue } from '../lib/fieldBinding';
import {
  adoptCarriedFills, canUndo, descriptionPlacement, fieldFor, fillOne, letAddressChange, titleFillWouldLoseAddress,
  undoFill, valueToFill,
  type AdoptedFills, type CarriedFills, type FillKind, type FillRecord,
} from '../lib/varys/suggestionFill';
import { markFilled } from '../lib/varys/filled';
import { fetchSitePage, isNodeAddress, resolvePublicAddress } from '../lib/varys/publicAddress';
import {
  SUGGESTIONS_ERROR_COPY, SUGGESTIONS_NO_CURSOR_COPY,
  type SuggestionsAnswer, type SuggestionsReply, type VarysCarriedFillsRequest, type VarysCarryFillsMessage,
  type VarysSiteTrackedRequest, type VarysSiteTrackedResponse, type VarysSuggestionsRequest,
} from '../lib/varys/suggestions';
import { ACTION_EXPIRED_COPY, ACTION_NOT_CONNECTED_COPY, ACTION_UNREACHABLE_COPY } from '../lib/varys/submissions';
import { SuggestionsPanel, type PanelBody, type SuggestionRow } from '../components/varys/SuggestionsPanel';
import type { InsertRichEditorHtmlRequest, InsertRichEditorHtmlResponse } from '../background';

/**
 * Varys's Page Health suggestions on a live page's edit form, with Use, Undo, Copy and Insert.
 *
 * The firm rules, all kept here: Varys fills and the person presses Save, so nothing here
 * presses a Drupal button or submits the form; every fill can be undone while the field
 * still holds it; and nothing is sent while this browser is not connected, or for a site
 * Varys does not track (the worker decides that, and answers `not_tracked`, before the page's
 * address leaves the browser).
 *
 * Mounted from src/content/index.tsx, the same content script as the save capture, so the
 * fields marked filled here (src/lib/varys/filled.ts) are the ones the next save reports.
 */

/** How long an Ask Varys is waited on, from the press, and how often Varys is asked meanwhile. */
const ASK_WINDOW_MS = 3 * 60_000;
const POLL_MS = 5_000;
/** Polls in a row that may fail before the panel says Varys can't be reached. */
const POLL_FAILURES_ALLOWED = 3;

/**
 * Where a pending Ask Varys is remembered, followed by the page's public address. In the
 * tab's sessionStorage, so a reload within the window goes on waiting instead of asking
 * Varys to start a second generation (Varys cannot report one already running).
 */
export const PENDING_ASK_KEY = 'd7-varys-ask:';

const NO_EDITOR_COPY = 'The body has no editor to insert into here. Use Copy instead.';
const INSERT_FAILED_COPY = "The heading couldn't be inserted. Use Copy instead.";
const INSERTED_COPY = 'Inserted into the body.';
const COPIED_COPY = 'Copied.';
const COPY_FAILED_COPY = "Couldn't copy. Select the heading and copy it instead.";
const FILL_FAILED_COPY = "This field couldn't be filled, so nothing changed.";
const NO_ADDRESS_COPY = "Varys can't tell this page's current web address, so it won't change the title here. "
  + 'Change it by hand if you need to.';
const INTO_SUMMARY_FOLLOWED_COPY = 'Goes into Summary, which is also the search description.';
const INTO_SUMMARY_ONLY_COPY = 'Goes into Summary.';
const INTO_OVERRIDE_OVER_SUMMARY_COPY = 'Goes into the search description field, which overrides Summary on this page.';
const INTO_OVERRIDE_ONLY_COPY = 'Goes into the search description field.';

/** The body's textarea, by name: its id is the one its rich editor is registered under. */
const BODY_FIELD = 'textarea[name="body[und][0][value]"]';

const ROWS: { kind: FillKind; label: string; pick: (s: Ready['suggested']) => string | null }[] = [
  { kind: 'meta_title', label: 'Search result title', pick: s => s.meta_title },
  { kind: 'meta_description', label: 'Search result description', pick: s => s.meta_description },
  { kind: 'title', label: 'Title', pick: s => s.h1 },
];

type Ready = Extract<SuggestionsAnswer, { status: 'ready' }>;

/** An answer the panel shows as it is. */
type Shown = Ready | { status: 'none' | 'not_crawled' };

/** What the panel is showing, before the live form is read into it. */
type Phase =
  | { kind: 'answer'; answer: Shown }
  | { kind: 'generating'; since: number }
  | { kind: 'still_writing' }
  | { kind: 'message'; message: string };

// ------------------------------------------------------------------------------ the worker

/** Asks the worker. Null when it did not answer with a reply (an invalidated context, a closed port). */
async function askWorker(message: VarysSuggestionsRequest): Promise<SuggestionsReply | null> {
  try {
    const reply: SuggestionsReply | undefined = await chrome.runtime.sendMessage(message);
    return typeof reply === 'object' && reply !== null && typeof reply.ok === 'boolean' ? reply : null;
  } catch {
    return null;
  }
}

type Failure = Extract<SuggestionsReply, { ok: false }>;

/**
 * The extension's own words for a reply that is not an answer. Varys's own detail on an
 * error is for whoever debugs it, so it goes to the console, never on screen (ruling R12).
 */
function copyFor(reply: Failure): string {
  switch (reply.reason) {
    case 'expired': return ACTION_EXPIRED_COPY;
    case 'not_connected': return ACTION_NOT_CONNECTED_COPY;
    case 'unreachable': return ACTION_UNREACHABLE_COPY;
    case 'error':
      console.warn('[D7 Studio] Varys could not answer for this page:', reply.message);
      return SUGGESTIONS_ERROR_COPY;
    default: {
      const unknown: never = reply.reason;
      console.warn('[D7 Studio] Varys suggestions: a failure this version does not know', unknown);
      return SUGGESTIONS_ERROR_COPY;
    }
  }
}

// ---------------------------------------------------------------------- the pending marker

function readPending(pageUrl: string, now = Date.now()): number | null {
  try {
    const at = Number(sessionStorage.getItem(PENDING_ASK_KEY + pageUrl));
    if (Number.isFinite(at) && at > 0 && at <= now && now - at < ASK_WINDOW_MS) return at;
    sessionStorage.removeItem(PENDING_ASK_KEY + pageUrl);
  } catch {
    // Storage the page has refused: there is simply nothing remembered.
  }
  return null;
}

function writePending(pageUrl: string, at: number): void {
  try {
    sessionStorage.setItem(PENDING_ASK_KEY + pageUrl, String(at));
  } catch {
    // Not remembered across a reload; this page still waits.
  }
}

function clearPending(pageUrl: string): void {
  try {
    sessionStorage.removeItem(PENDING_ASK_KEY + pageUrl);
  } catch {
    // Nothing to clear.
  }
}

// --------------------------------------------------------------------------- the decisions

/**
 * Where the panel starts, from the first reply and any Ask Varys still pending in this tab.
 * Null when there is to be no panel at all (ruling R11): only an answer about a tracked page,
 * or an expired key on a page the last list says is tracked, is worth a panel. Not tracked,
 * not connected, unreachable and an error on the first look all mount nothing, so a Varys
 * that is down does not put a panel on every Drupal page this person opens.
 */
function initialPhase(reply: SuggestionsReply, pageUrl: string): Phase | null {
  if (!reply.ok) {
    if (reply.reason === 'error') console.warn('[D7 Studio] Varys could not answer for this page:', reply.message);
    if (reply.reason !== 'expired') return null;
    clearPending(pageUrl);
    return { kind: 'message', message: copyFor(reply) };
  }

  const pending = readPending(pageUrl);
  const { answer } = reply;
  switch (answer.status) {
    case 'not_tracked':
      return null;
    case 'generating': {
      const since = pending ?? Date.now();
      writePending(pageUrl, since);
      return { kind: 'generating', since };
    }
    case 'none':
      return pending !== null ? { kind: 'generating', since: pending } : { kind: 'answer', answer: { status: 'none' } };
    case 'ready':
    case 'not_crawled':
      clearPending(pageUrl);
      return { kind: 'answer', answer: shown(answer)! };
    default: {
      const unknown: never = answer;
      console.warn('[D7 Studio] Varys suggestions: a status this version does not know', unknown);
      return null;
    }
  }
}

/**
 * An answer the panel shows as it stands, or null for one it does not (not tracked, or still
 * generating). Exhaustive, so a status added later cannot fall into another's words.
 */
function shown(answer: SuggestionsAnswer): Shown | null {
  switch (answer.status) {
    case 'ready': return answer;
    case 'none': return { status: 'none' };
    case 'not_crawled': return { status: 'not_crawled' };
    case 'not_tracked':
    case 'generating':
      return null;
    default: {
      const unknown: never = answer;
      console.warn('[D7 Studio] Varys suggestions: a status this version does not know', unknown);
      return null;
    }
  }
}

/** Escapes text for use inside HTML, so a heading is always text and never markup. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const same = (a: string, b: string) => a.trim() === b.trim();

/**
 * Says which field a suggested description goes into, since the form has two that can be it,
 * and claims only what is true of this form: that Summary is also the search description only
 * where the override follows it, and that the override overrides Summary only where it holds
 * its own text and there is a Summary to override.
 */
function whereDescriptionGoes(fields: FieldDescriptor[]): string | null {
  switch (descriptionPlacement(fields)) {
    case 'summary_followed': return INTO_SUMMARY_FOLLOWED_COPY;
    case 'summary_only': return INTO_SUMMARY_ONLY_COPY;
    case 'override_over_summary': return INTO_OVERRIDE_OVER_SUMMARY_COPY;
    case 'override_only': return INTO_OVERRIDE_ONLY_COPY;
    default: return null;
  }
}

/** The page's address as a path, for keeping it when the title changes. Never a full URL. */
function pathOf(address: string): string | null {
  try {
    return new URL(address).pathname;
  } catch {
    return null;
  }
}

/**
 * True only when the worker says, by the list Varys last gave, that this page's site is one
 * Varys tracks. Anything else (untracked, no telling, no answer) is false. Shared with the
 * drafts panel on a new page's form (varysDraftPanel.tsx).
 */
export async function siteIsTracked(pageUrl: string): Promise<boolean> {
  try {
    const reply: VarysSiteTrackedResponse | undefined = await chrome.runtime.sendMessage(
      { type: 'varysSiteTracked', pageUrl } satisfies VarysSiteTrackedRequest);
    return reply?.tracked === true;
  } catch {
    return false;
  }
}

/** What the panel had on this form before a re-render, as the worker kept it; null for none. */
async function askCarried(formPath: string): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage({ type: 'varysCarriedFills', formPath } satisfies VarysCarriedFillsRequest);
  } catch {
    return null;
  }
}

/** Hands the panel's live fills to the worker to keep with the form (see CarriedFills). Not waited on. */
function carryFills(formPath: string, fills: CarriedFills): void {
  try {
    Promise.resolve(chrome.runtime.sendMessage({ type: 'varysCarryFills', formPath, fills } satisfies VarysCarryFillsMessage))
      .catch(() => undefined);
  } catch {
    // No worker to keep them: a re-render then starts without them, as it always did.
  }
}

// ---------------------------------------------------------------------------- the placement

/** Drupal's admin toolbar, which the panel stays below (the extension's overlays all start at 44px). */
const TOP_LIMIT = 52;
const EDGE = 16;
const GAP = 8;
const PANEL_WIDTH = 440;
/** Below this there is no room for even the header line, and the panel steps aside. */
const MIN_HEIGHT = 48;

/**
 * Where the buttons that save are on screen: Drupal's own (`op` submits), or the Two-Pane
 * Editor's Save draft and Publish, which press Drupal's.
 */
function saveButtonRects(): DOMRect[] {
  const rects: DOMRect[] = [];
  findNodeForm()?.querySelectorAll<HTMLElement>('input[type="submit"][name="op"], button[name="op"]')
    .forEach(el => rects.push(el.getBoundingClientRect()));
  document.querySelectorAll<HTMLElement>('.d7-proxy-ui-form-host').forEach(host => {
    host.shadowRoot?.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      if (/save|publish|preview/i.test(button.textContent ?? '')) rects.push(button.getBoundingClientRect());
    });
  });
  return rects.filter(r => r.width > 0 && r.height > 0);
}

type Placement = { bottom: number; maxHeight: number; hidden: boolean };

/**
 * Bottom-right, away from Drupal's left-aligned Save row and the Two-Pane Editor's top bar,
 * and moved clear of either whenever they share the panel's columns: the panel sits on the
 * side of them with more room, capped to fit there. With no room on either side it steps
 * aside rather than cover a Save button.
 */
function placement(): Placement {
  const height = window.innerHeight;
  const width = document.documentElement.clientWidth;
  const right = width - EDGE;
  const left = right - Math.min(PANEL_WIDTH, width - 2 * EDGE);

  const blockers = saveButtonRects().filter(r =>
    r.right > left - GAP && r.left < right + GAP && r.bottom > 0 && r.top < height);
  if (blockers.length === 0) {
    return { bottom: EDGE, maxHeight: height - EDGE - TOP_LIMIT, hidden: false };
  }

  const top = Math.min(...blockers.map(r => r.top));
  const bottom = Math.max(...blockers.map(r => r.bottom));
  const roomBelow = height - EDGE - (bottom + GAP);
  const roomAbove = top - GAP - TOP_LIMIT;
  const place = roomBelow >= roomAbove
    ? { bottom: EDGE, maxHeight: roomBelow }
    : { bottom: height - (top - GAP), maxHeight: roomAbove };
  return { ...place, hidden: place.maxHeight < MIN_HEIGHT };
}

/** Where a Varys panel sits right now; shared with the drafts panel (varysDraftPanel.tsx). */
export function usePlacement(deps: unknown[]): Placement {
  const [place, setPlace] = useState<Placement>(placement);
  const frame = useRef(0);

  const update = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const next = placement();
      setPlace(prev => (prev.bottom === next.bottom && prev.maxHeight === next.maxHeight && prev.hidden === next.hidden
        ? prev
        : next));
    });
  }, []);

  useEffect(() => {
    // Capture, so scrolling inside the Two-Pane Editor's own scroller counts too.
    window.addEventListener('scroll', update, { capture: true, passive: true });
    window.addEventListener('resize', update);
    // The page changing under the panel: the Two-Pane Editor mounting its Save bar once the
    // rich editors are ready (often after this panel), or Drupal's AJAX moving the form.
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [update]);

  // After every change of content: the panel's size and Drupal's layout both move.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(update, deps);
  return place;
}

// ------------------------------------------------------------------------------ the panel

function VarysPanel({ pageUrl, currentAlias, formPath, adopted, first, onClose }: {
  pageUrl: string;
  /** The page's address as a path, which a title fill keeps in the alias box. */
  currentAlias: string | null;
  /** The edit form's own path, under which the worker keeps this panel's fills. */
  formPath: string;
  /** Fills taken up from before a re-render of this same form (see adoptCarriedFills). */
  adopted: AdoptedFills;
  first: Phase;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(first);
  const [records, setRecords] = useState<Partial<Record<FillKind, FillRecord>>>(adopted.records);
  const [notes, setNotes] = useState<Partial<Record<FillKind, string>>>({});
  const [addressKept, setAddressKept] = useState(adopted.addressKept);
  const [headingsInserted, setHeadingsInserted] = useState(adopted.headings);
  const [headingMessage, setHeadingMessage] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // Bumped by any edit in the page, so "Now" and Undo follow what the person types.
  const [edits, setEdits] = useState(0);

  const failures = useRef(0);
  // What is on screen now, for an answer that arrives after the wait it belongs to has moved on.
  const phaseNow = useRef(phase);
  phaseNow.current = phase;
  const fieldsCache = useRef<FieldDescriptor[] | null>(null);

  /**
   * The form's fields, read once. The controls are re-found by name whenever Drupal's AJAX
   * replaces them (see liveElements), so one reading serves the page's life.
   */
  const fields = useCallback((): FieldDescriptor[] => {
    if (fieldsCache.current === null) {
      const found = discoverSchema()?.fields ?? [];
      if (found.length > 0) fieldsCache.current = found;
      return found;
    }
    return fieldsCache.current;
  }, []);

  useEffect(() => {
    const edited = () => setEdits(n => n + 1);
    document.addEventListener('input', edited, true);
    document.addEventListener('change', edited, true);
    return () => {
      document.removeEventListener('input', edited, true);
      document.removeEventListener('change', edited, true);
    };
  }, []);

  // Whatever the fills are now, the worker keeps them with the form, so a Preview or a save
  // Drupal rejects (both re-render this form with the fills still in it) does not lose them.
  useEffect(() => {
    carryFills(formPath, {
      records: Object.values(records).filter((r): r is FillRecord => r !== undefined),
      addressKept,
      headings: headingsInserted,
    });
  }, [formPath, records, addressKept, headingsInserted]);

  // A fill the person has since edited is theirs: its Undo goes, and Use comes back.
  useEffect(() => {
    const stale = (Object.keys(records) as FillKind[]).filter(kind => !canUndo(records[kind]!, fields()));
    if (stale.length === 0) return;
    setRecords(prev => {
      const next = { ...prev };
      for (const kind of stale) delete next[kind];
      return next;
    });
  }, [edits, records, fields]);

  // ------------------------------------------------------------------- waiting on Varys

  const generatingSince = phase.kind === 'generating' ? phase.since : null;

  useEffect(() => {
    if (generatingSince === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const stop = (next: Phase, forget: boolean) => {
      if (forget) clearPending(pageUrl);
      setPhase(next);
    };

    const poll = async () => {
      const reply = await askWorker({ type: 'varysSuggestions', pageUrl });
      if (cancelled) return;

      if (reply?.ok) {
        failures.current = 0;
        const { answer } = reply;
        if (answer.status === 'not_tracked') {
          clearPending(pageUrl);
          onClose();
          return;
        }
        const done = answer.status === 'none' ? null : shown(answer);
        if (done) {
          stop({ kind: 'answer', answer: done }, true);
          return;
        }
        // `none` or `generating`: still writing, as far as anyone can tell.
      } else if (reply && (reply.reason === 'expired' || reply.reason === 'not_connected')) {
        stop({ kind: 'message', message: copyFor(reply) }, true);
        return;
      } else if (++failures.current >= POLL_FAILURES_ALLOWED) {
        // Kept pending: a reload within the window looks again rather than asking again.
        stop({ kind: 'message', message: reply ? copyFor(reply) : ACTION_UNREACHABLE_COPY }, false);
        return;
      }

      if (Date.now() - generatingSince >= ASK_WINDOW_MS) {
        stop({ kind: 'still_writing' }, true);
        return;
      }
      timer = setTimeout(poll, POLL_MS);
    };

    timer = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [generatingSince, pageUrl, onClose]);

  const ask = useCallback(() => {
    const since = Date.now();
    writePending(pageUrl, since);
    failures.current = 0;
    setPhase({ kind: 'generating', since });

    void askWorker({ type: 'varysGenerateSuggestions', pageUrl }).then(reply => {
      // Only what ends the wait is acted on, and only if this is still the wait it started.
      // No answer, or Varys unreachable: it may have started writing, so the polls decide.
      const current = phaseNow.current;
      if (current.kind !== 'generating' || current.since !== since || reply === null) return;
      if (!reply.ok) {
        if (reply.reason === 'unreachable') return;
        clearPending(pageUrl);
        setPhase({ kind: 'message', message: copyFor(reply) });
        return;
      }
      const { answer } = reply;
      const done = answer.status === 'none' ? null : shown(answer);
      if (answer.status === 'not_tracked') {
        clearPending(pageUrl);
        onClose();
      } else if (done) {
        clearPending(pageUrl);
        setPhase({ kind: 'answer', answer: done });
      }
    });
  }, [pageUrl, onClose]);

  // ------------------------------------------------------------------------ the fills

  const use = useCallback((kind: FillKind) => {
    if (phase.kind !== 'answer' || phase.answer.status !== 'ready') return;
    const row = ROWS.find(r => r.kind === kind)!;
    const value = row.pick(phase.answer.suggested);
    // Never a second fill of a kind while the first can still be undone.
    const live = records[kind];
    if (value === null || (live && canUndo(live, fields()))) return;

    // Read afresh: a field Drupal's AJAX has added since is found.
    fieldsCache.current = null;
    const record = fillOne(kind, value, fields(), { currentAlias });
    setNotes(prev => ({ ...prev, [kind]: record ? undefined : FILL_FAILED_COPY }));
    if (!record) return;
    setRecords(prev => ({ ...prev, [kind]: record }));
    if (kind === 'title' && record.pathautoWasTicked) setAddressKept(true);
  }, [phase, records, fields, currentAlias]);

  const undo = useCallback((kind: FillKind) => {
    const record = records[kind];
    if (!record) return;
    undoFill(record, fields());
    setRecords(prev => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
    // Whatever Undo managed, this no longer describes a fill: say nothing more about it.
    if (kind === 'title') setAddressKept(false);
  }, [records, fields]);

  const letItChange = useCallback(() => {
    letAddressChange(fields());
    setAddressKept(false);
  }, [fields]);

  // ----------------------------------------------------------------------- the headings

  const copy = useCallback((text: string) => {
    try {
      navigator.clipboard.writeText(text).then(
        () => setHeadingMessage(COPIED_COPY),
        () => setHeadingMessage(COPY_FAILED_COPY),
      );
    } catch {
      // No clipboard here at all (a page served over plain http).
      setHeadingMessage(COPY_FAILED_COPY);
    }
  }, []);

  const insert = useCallback(async (text: string) => {
    const elementId = document.querySelector<HTMLTextAreaElement>(BODY_FIELD)?.id;
    if (!elementId) {
      setHeadingMessage(NO_EDITOR_COPY);
      return;
    }
    let reply: InsertRichEditorHtmlResponse | undefined;
    try {
      reply = await chrome.runtime.sendMessage({
        type: 'insertRichEditorHtml', elementId, html: `<h2>${escapeHtml(text)}</h2>`,
      } satisfies InsertRichEditorHtmlRequest);
    } catch {
      reply = undefined;
    }
    switch (reply?.result) {
      case 'inserted':
        markFilled('headings');
        setHeadingsInserted(true);
        setHeadingMessage(INSERTED_COPY);
        return;
      case 'no-cursor':
        setHeadingMessage(SUGGESTIONS_NO_CURSOR_COPY);
        return;
      case 'no-editor':
        setHeadingMessage(NO_EDITOR_COPY);
        return;
      default:
        setHeadingMessage(INSERT_FAILED_COPY);
    }
  }, []);

  // ------------------------------------------------------------------------- rendering

  const body = ((): PanelBody => {
    switch (phase.kind) {
      case 'generating': return { state: 'generating' };
      case 'still_writing': return { state: 'still_writing' };
      case 'message': return { state: 'message', message: phase.message };
    }
    const { answer } = phase;
    if (answer.status !== 'ready') return { state: answer.status };

    const all = fields();
    const rows = ROWS.map(({ kind, label, pick }): SuggestionRow => {
      // What Use would write, which for a search title keeps the field's token tail.
      const offered = pick(answer.suggested);
      const suggested = offered === null ? null : valueToFill(kind, offered, all);
      const field = fieldFor(kind, all);
      const now = field ? String(readValue(field)) : null;
      const record = records[kind];
      const where = kind === 'meta_description' ? whereDescriptionGoes(all) : null;

      if (record && canUndo(record, all)) return { kind, label, now, suggested, action: 'undo', where };
      if (now === null || suggested === null || same(now, suggested)) {
        return { kind, label, now, suggested, action: 'none', where, note: notes[kind] };
      }
      if (kind === 'title' && titleFillWouldLoseAddress(all, { currentAlias })) {
        return { kind, label, now, suggested, action: 'blocked', where, note: NO_ADDRESS_COPY };
      }
      return { kind, label, now, suggested, action: 'use', where, note: notes[kind] };
    });

    return {
      state: 'ready',
      madeAt: answer.made_at,
      clinicalNote: answer.clinical_review_note,
      rows,
      addressKept,
      headings: { current: answer.current.h2s, suggested: answer.suggested.h2s },
      headingMessage,
    };
  })();

  const place = usePlacement([body, collapsed]);

  return (
    <div
      className="fixed right-4 z-[2147483645] pointer-events-none [&>*]:pointer-events-auto"
      style={{ bottom: place.bottom, display: place.hidden ? 'none' : undefined }}
    >
      <SuggestionsPanel
        body={body}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed(c => !c)}
        now={Date.now()}
        onAsk={ask}
        onUse={use}
        onUndo={undo}
        onLetAddressChange={letItChange}
        onCopy={copy}
        onInsert={text => { void insert(text); }}
        maxHeight={place.maxHeight}
      />
    </div>
  );
}

/**
 * Shows the panel on a live page's edit form, when this browser is connected to Varys and
 * the page's site is one Varys tracks. Not awaited by anything, and never lets a fault of its
 * own reach the person editing: the panel is an extra.
 *
 * The first answer decides whether there is a panel at all (see initialPhase), so the panel
 * is mounted only after it. It also waits for the page's rich editors, asked for in the same
 * breath, so the form is first read with CKEditor in place and Insert at cursor works from
 * the panel's first moment: pressed while CKEditor is still loading, it would find no editor.
 * `editorsReady` is index.tsx's one shared wait, called only once this browser is connected.
 */
export async function startVarysPanel(editorsReady: () => Promise<unknown>): Promise<void> {
  try {
    const formPath = window.location.pathname;
    if (nodeIdFromPath(formPath) === null) return;
    if (!(await varysIsConnected())) return;
    const address = publicUrlFor(window.location, document);
    if (address === null) return;

    // Bounded by the wait itself; a fault in it only means the editors are as ready as they get.
    const editors = editorsReady().catch(() => undefined);
    // A form whose View tab was not found names its page /node/N, which Varys never crawled:
    // the page itself says where it lives (ruling R17). It is read only on a site Varys tracks,
    // settled first and without sending the address anywhere (ruling R19): untracked, or no
    // telling, and the panel goes on with /node/N exactly as before, as it does on any failure.
    const pageUrl = isNodeAddress(address) && await siteIsTracked(address)
      ? await resolvePublicAddress(address, fetchSitePage)
      : address;

    const [reply, carried] = await Promise.all([
      askWorker({ type: 'varysSuggestions', pageUrl }),
      askCarried(formPath),
      editors,
    ]);
    // Taken up whether or not there is a panel this time: the marks are what the next save
    // reports, and a Preview's fills are still in the form (ruling R18).
    const adopted = adoptCarriedFills(carried, discoverSchema()?.fields ?? []);
    if (reply === null) return;
    const first = initialPhase(reply, pageUrl);
    if (first === null) return;

    const overlay = injectOverlay(
      <VarysPanel
        pageUrl={pageUrl}
        currentAlias={pathOf(pageUrl)}
        formPath={formPath}
        adopted={adopted}
        first={first}
        onClose={() => overlay.unmount()}
      />,
    );
  } catch (err) {
    console.warn('[D7 Studio] Could not show Varys suggestions', err);
  }
}
