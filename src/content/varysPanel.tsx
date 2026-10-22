import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { injectOverlay } from './inject';
import { publicUrlFor, varysIsConnected } from './varysCapture';
import { nodeIdFromPath } from '../lib/extractPublicHtml';
import { discoverSchema, findNodeForm, type FieldDescriptor } from '../lib/formSchema';
import { readValue } from '../lib/fieldBinding';
import {
  canUndo, descriptionTarget, fieldFor, fillOne, letAddressChange, titleFillWouldLoseAddress, undoFill,
  type FillKind, type FillRecord,
} from '../lib/varys/suggestionFill';
import { markFilled } from '../lib/varys/filled';
import {
  SUGGESTIONS_NO_CURSOR_COPY,
  type SuggestionsAnswer, type SuggestionsReply, type VarysSuggestionsRequest,
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
const INTO_SUMMARY_COPY = 'Goes into Summary, which is also the search description.';
const INTO_OVERRIDE_COPY = 'Goes into the search description field, which overrides Summary on this page.';

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

/** The extension's own words for a reply that is not an answer. */
function copyFor(reply: Extract<SuggestionsReply, { ok: false }>): string {
  switch (reply.reason) {
    case 'expired': return ACTION_EXPIRED_COPY;
    case 'not_connected': return ACTION_NOT_CONNECTED_COPY;
    case 'unreachable': return ACTION_UNREACHABLE_COPY;
    default: return reply.message || ACTION_UNREACHABLE_COPY;
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
 * Where the panel starts, from the first answer and any Ask Varys still pending in this tab.
 * Null for an answer that means no panel at all (not tracked).
 */
function initialPhase(reply: SuggestionsReply, pageUrl: string): { phase: Phase; failures: number } | null {
  const pending = readPending(pageUrl);
  if (!reply.ok) {
    if (pending !== null && (reply.reason === 'unreachable' || reply.reason === 'error')) {
      // Varys may be writing still: this counts as the first failed look, not the last.
      return { phase: { kind: 'generating', since: pending }, failures: 1 };
    }
    if (reply.reason === 'expired' || reply.reason === 'not_connected') clearPending(pageUrl);
    return { phase: { kind: 'message', message: copyFor(reply) }, failures: 0 };
  }

  const { answer } = reply;
  switch (answer.status) {
    case 'not_tracked':
      return null;
    case 'generating': {
      const since = pending ?? Date.now();
      writePending(pageUrl, since);
      return { phase: { kind: 'generating', since }, failures: 0 };
    }
    case 'none':
      return pending !== null
        ? { phase: { kind: 'generating', since: pending }, failures: 0 }
        : { phase: { kind: 'answer', answer: { status: 'none' } }, failures: 0 };
    default:
      clearPending(pageUrl);
      return { phase: { kind: 'answer', answer: shown(answer) }, failures: 0 };
  }
}

/** A ready or not-crawled answer, as the panel holds it. */
function shown(answer: SuggestionsAnswer): Shown {
  return answer.status === 'ready' ? answer : { status: answer.status === 'none' ? 'none' : 'not_crawled' };
}

/** Escapes text for use inside HTML, so a heading is always text and never markup. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const same = (a: string, b: string) => a.trim() === b.trim();

/** Says which field a suggested description goes into, since the form has two that can be it. */
function whereDescriptionGoes(fields: FieldDescriptor[]): string | null {
  switch (descriptionTarget(fields)) {
    case 'summary': return INTO_SUMMARY_COPY;
    case 'override': return INTO_OVERRIDE_COPY;
    default: return null;
  }
}

/** The page's current address as a path, for keeping it when the title changes. Never a full URL. */
function currentAliasPath(): string | null {
  const address = publicUrlFor(window.location, document);
  if (address === null) return null;
  try {
    return new URL(address).pathname;
  } catch {
    return null;
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

function usePlacement(deps: unknown[]): Placement {
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

function VarysPanel({ pageUrl, first, onClose }: {
  pageUrl: string;
  first: { phase: Phase; failures: number };
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(first.phase);
  const [records, setRecords] = useState<Partial<Record<FillKind, FillRecord>>>({});
  const [notes, setNotes] = useState<Partial<Record<FillKind, string>>>({});
  const [addressKept, setAddressKept] = useState(false);
  const [headingMessage, setHeadingMessage] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // Bumped by any edit in the page, so "Now" and Undo follow what the person types.
  const [edits, setEdits] = useState(0);

  const failures = useRef(first.failures);
  // What is on screen now, for an answer that arrives after the wait it belongs to has moved on.
  const phaseNow = useRef(phase);
  phaseNow.current = phase;
  const fieldsCache = useRef<FieldDescriptor[] | null>(null);
  const currentAlias = useRef(currentAliasPath());

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
        if (answer.status === 'ready' || answer.status === 'not_crawled') {
          stop({ kind: 'answer', answer: shown(answer) }, true);
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
      if (answer.status === 'not_tracked') {
        clearPending(pageUrl);
        onClose();
      } else if (answer.status === 'ready' || answer.status === 'not_crawled') {
        clearPending(pageUrl);
        setPhase({ kind: 'answer', answer: shown(answer) });
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
    const record = fillOne(kind, value, fields(), { currentAlias: currentAlias.current });
    setNotes(prev => ({ ...prev, [kind]: record ? undefined : FILL_FAILED_COPY }));
    if (!record) return;
    setRecords(prev => ({ ...prev, [kind]: record }));
    if (kind === 'title' && record.pathautoWasTicked) setAddressKept(true);
  }, [phase, records, fields]);

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
      const suggested = pick(answer.suggested);
      const field = fieldFor(kind, all);
      const now = field ? String(readValue(field)) : null;
      const record = records[kind];
      const where = kind === 'meta_description' ? whereDescriptionGoes(all) : null;

      if (record && canUndo(record, all)) return { kind, label, now, suggested, action: 'undo', where };
      if (now === null || suggested === null || same(now, suggested)) {
        return { kind, label, now, suggested, action: 'none', where, note: notes[kind] };
      }
      if (kind === 'title' && titleFillWouldLoseAddress(all, { currentAlias: currentAlias.current })) {
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
 * The first answer decides whether there is a panel at all, so the panel is mounted only
 * after it: an untracked site, or a worker that cannot be asked, shows nothing.
 */
export async function startVarysPanel(): Promise<void> {
  try {
    if (nodeIdFromPath(window.location.pathname) === null) return;
    if (!(await varysIsConnected())) return;
    const pageUrl = publicUrlFor(window.location, document);
    if (pageUrl === null) return;

    const reply = await askWorker({ type: 'varysSuggestions', pageUrl });
    if (reply === null) return;
    const first = initialPhase(reply, pageUrl);
    if (first === null) return;

    const overlay = injectOverlay(<VarysPanel pageUrl={pageUrl} first={first} onClose={() => overlay.unmount()} />);
  } catch (err) {
    console.warn('[D7 Studio] Could not show Varys suggestions', err);
  }
}
