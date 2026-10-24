import React, { useCallback, useEffect, useRef, useState } from 'react';
import { injectOverlay } from './inject';
import { readBodyHtml, varysIsConnected } from './varysCapture';
import { usePlacement } from './varysPanel';
import { nodeIdFromPath } from '../lib/extractPublicHtml';
import { discoverSchema, findNodeForm, type FieldDescriptor } from '../lib/formSchema';
import { readValue, writeValue } from '../lib/fieldBinding';
import { canUndo, fillOne, findField, titleField, undoFill, type FillRecord } from '../lib/varys/suggestionFill';
import {
  bodyToFill, canUndoBody, canUndoText, DRAFT_FIELDS, fillText, planDraftFill, undoText,
  type BodyFillRecord, type DraftRow, type DraftRowKind, type ReadyDraft, type TextFillRecord,
} from '../lib/varys/draftFill';
import {
  addProfiles, profileInputs, profileStillAdded, undoProfiles, type ProfileOutcome, type ProfileResult,
} from '../lib/varys/profileFill';
import { markFilled, unmarkFilled } from '../lib/varys/filled';
import type {
  DraftDoctor, DraftReply, DraftsReply, DraftSummary, RichEditorAllowsRequest, RichEditorAllowsResponse,
  VarysDraftRequest, VarysDraftsRequest,
} from '../lib/varys/drafts';
import { ACTION_EXPIRED_COPY, ACTION_NOT_CONNECTED_COPY, ACTION_UNREACHABLE_COPY } from '../lib/varys/submissions';
import { VARYS_APP_ORIGINS } from '../lib/varys/config';
import {
  DraftPanel, type DraftDoctorLine, type DraftOutcome, type DraftPanelBody, type DraftPanelRow,
} from '../components/varys/DraftPanel';

/**
 * The person's Varys drafts on a new page's form, and Fill: the title, Summary, search title,
 * body (with the site's Overview box) and Related Profiles, each with its own Undo.
 *
 * The firm rules, all kept here. Varys fills and the person presses Save: nothing here
 * presses a Drupal button, submits, previews or publishes. Every fill can be undone while
 * its field still holds it. The web address is never touched: a new page has none to keep,
 * and Drupal makes one on save. Nothing is asked of Varys while this browser is not
 * connected, or for a site Varys does not track; what is asked carries the site's address
 * (`location.origin + '/'`) and nothing of the page.
 *
 * Mounted from src/content/index.tsx, in the same content script as the save capture, so the
 * fields marked filled here (src/lib/varys/filled.ts) are the ones the next save reports.
 */

/** The body's textarea, by name: its id is the one its rich editor is registered under. */
const BODY_FIELD = `textarea[name=${JSON.stringify(DRAFT_FIELDS.body)}]`;

/**
 * The Overview box is the site's callout: an aside with these classes, titled by an id. Only
 * an editor whose content filter says it KEEPS this gets it (see overviewBoxHtml).
 */
const CALLOUT_RULE = 'aside(ck-callout,ck-callout--background-sky,ck-callout--center)[aria-labelledby]';

/** How long the body's editor is given to take a fill, and how often it is read meanwhile. */
const BODY_SETTLE_MS = 3000;
const BODY_POLL_MS = 100;

const NOT_FOUND_COPY = 'That draft is no longer available in Varys.';
const OPEN_ERROR_COPY = "Varys couldn't open that draft right now. Try again in a moment.";
const FILL_FAILED_COPY = "This field couldn't be filled, so nothing changed.";
const ALREADY_HOLDS_COPY = 'The body already holds this draft.';
const UNDO_FAILED_COPY = "This couldn't be put back. Use the editor's own undo.";
const BODY_CHANGED_COPY = "You've changed the body since it was filled, so Undo left it as it is.";
const NO_DOCTORS_TICKED_COPY = 'Not added';
const DOCTOR_BY_HAND = (name: string) => `Quoted, not matched — add by hand: ${name}`;
const dropped = (tables: number, images: number) =>
  `Tables (${tables}) and images (${images}) aren't carried over; add them in Drupal.`;

/** What a Related Profiles lookup came to, in the panel's words (Ruling R). */
const PROFILE_COPY: Record<ProfileResult, string> = {
  added: 'Added',
  already: 'Already in Related Profiles',
  ambiguous: 'More than one match — add by hand',
  not_found: 'Not found in Related Profiles — add by hand',
  unavailable: "Couldn't check — add by hand",
};

// ------------------------------------------------------------------------------ the worker

/** Asks the worker. Null when it did not answer with a reply (an invalidated context, a closed port). */
async function askWorker<T extends { ok: boolean }>(message: VarysDraftsRequest | VarysDraftRequest): Promise<T | null> {
  try {
    const reply: T | undefined = await chrome.runtime.sendMessage(message);
    return typeof reply === 'object' && reply !== null && typeof reply.ok === 'boolean' ? reply : null;
  } catch {
    return null;
  }
}

/** Whether the body's editor would keep the Overview callout. Anything but a plain yes is no. */
async function editorKeepsCallout(): Promise<boolean> {
  const elementId = document.querySelector<HTMLTextAreaElement>(BODY_FIELD)?.id;
  if (!elementId) return false;
  try {
    const reply: RichEditorAllowsResponse | undefined = await chrome.runtime.sendMessage(
      { type: 'richEditorAllows', elementId, rule: CALLOUT_RULE } satisfies RichEditorAllowsRequest);
    return reply?.allowed === true;
  } catch {
    return false;
  }
}

type Failure = Extract<DraftReply, { ok: false }>;

/**
 * The extension's own words for a reply that is not a draft. Varys's own detail on an error
 * is for whoever debugs it, so it goes to the console, never on screen.
 */
function copyFor(reply: Failure): string {
  switch (reply.reason) {
    case 'expired': return ACTION_EXPIRED_COPY;
    case 'not_connected': return ACTION_NOT_CONNECTED_COPY;
    case 'unreachable': return ACTION_UNREACHABLE_COPY;
    case 'not_found': return NOT_FOUND_COPY;
    case 'error':
      console.warn('[D7 Studio] Varys could not give this draft:', reply.message);
      return OPEN_ERROR_COPY;
    default: {
      const unknown: never = reply.reason;
      console.warn('[D7 Studio] Varys drafts: a failure this version does not know', unknown);
      return OPEN_ERROR_COPY;
    }
  }
}

// ----------------------------------------------------------------------------- the doctors

/**
 * One doctor the draft names, as the panel offers them (Ruling R). Only a doctor the site's
 * directory matched can be added, and only one quoted by the very name the directory has
 * starts ticked: a likely match, or one suggested by the page's topic, is the person's call.
 */
type DoctorChoice =
  | { kind: 'add'; fullName: string; text: string; ticked: boolean }
  | { kind: 'by_hand'; text: string };

function doctorChoice(doctor: DraftDoctor): DoctorChoice {
  const fullName = doctor.full_name?.trim() ?? '';
  if (doctor.status !== 'matched' || fullName === '') return { kind: 'by_hand', text: DOCTOR_BY_HAND(doctor.name) };
  if (doctor.source === 'topic') return { kind: 'add', fullName, text: `${fullName} (suggested by topic)`, ticked: false };
  if (!doctor.exact) return { kind: 'add', fullName, text: `${fullName} — quoted as “${doctor.name}”`, ticked: false };
  return { kind: 'add', fullName, text: fullName, ticked: true };
}

// -------------------------------------------------------------------------------- the body

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A body's words alone: tags dropped (each a space, so "<h2>A</h2><p>B" is not "AB"), entities
 * decoded, whitespace collapsed. CKEditor rewrites markup it is given, so two bodies that read
 * the same are compared this way, never character for character.
 */
function bodyText(html: string): string {
  const spaced = html.replace(/<[^>]*>/g, ' ');
  const decoded = new DOMParser().parseFromString(spaced, 'text/html').documentElement.textContent ?? spaced;
  return decoded.replace(/\s+/g, ' ').trim();
}

/**
 * The body as the editor holds it once it has moved off `from`, or as it stands when it has
 * not within BODY_SETTLE_MS. CKEditor takes a new body a moment after it is given one, and
 * rewrites its markup on the way in, so the editor is read rather than the value sent.
 */
async function bodyMovedOff(form: HTMLFormElement, from: string): Promise<string> {
  const until = Date.now() + BODY_SETTLE_MS;
  let now = await readBodyHtml(form);
  while (now === from && Date.now() < until) {
    await sleep(BODY_POLL_MS);
    now = await readBodyHtml(form);
  }
  return now;
}

// ------------------------------------------------------------------------------ the panel

/** What one row's fill came to. The records are what Undo needs. */
type Result =
  | { status: 'filled'; text: TextFillRecord }
  | { status: 'filled'; search: FillRecord }
  | { status: 'filled'; body: BodyFillRecord; note?: string }
  /** The body already read as this draft, so the fill changed nothing there is to undo. */
  | { status: 'already' }
  | { status: 'skipped' | 'failed' | 'undone' }
  | { status: 'kept'; note: string };

type Review = { draft: ReadyDraft; callout: boolean; rows: DraftRow[] };

type Phase =
  | { kind: 'list'; message: string | null }
  | { kind: 'opening'; id: string }
  | { kind: 'review'; review: Review }
  | { kind: 'message'; message: string };

/** Which doctors start ticked, by their place in the draft's list. */
const initialDoctorTicks = (draft: ReadyDraft): boolean[] =>
  (draft.doctors ?? []).map(d => {
    const choice = doctorChoice(d);
    return choice.kind === 'add' && choice.ticked;
  });

/** Which rows start ticked: every row offered, except one carrying a note (Ruling Q). */
const initialTicks = (rows: DraftRow[]): Partial<Record<DraftRowKind, boolean>> =>
  Object.fromEntries(rows.filter(r => r.kind !== 'profiles').map(r => [r.kind, r.note === null]));

function DraftsPanel({ pageUrl, drafts: firstDrafts, first, editorsReady, onClose }: {
  pageUrl: string;
  drafts: DraftSummary[];
  first: Phase;
  editorsReady: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(first);
  const [drafts, setDrafts] = useState(firstDrafts);
  const [ticks, setTicks] = useState<Partial<Record<DraftRowKind, boolean>>>({});
  const [doctorTicks, setDoctorTicks] = useState<boolean[]>([]);
  const [filling, setFilling] = useState(false);
  const [results, setResults] = useState<Partial<Record<DraftRowKind, Result>> | null>(null);
  const [outcomes, setOutcomes] = useState<ProfileOutcome[]>([]);
  const [profilesUndone, setProfilesUndone] = useState<number[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  // Bumped by any edit in the page, so Undo follows what the person types.
  const [, setEdits] = useState(0);

  const fieldsRef = useRef<FieldDescriptor[]>([]);
  const fields = useCallback((): FieldDescriptor[] => fieldsRef.current, []);
  // The draft being opened now, so an answer for one the person has moved on from is dropped.
  const opening = useRef<string | null>(null);

  useEffect(() => {
    const edited = () => setEdits(n => n + 1);
    document.addEventListener('input', edited, true);
    document.addEventListener('change', edited, true);
    return () => {
      document.removeEventListener('input', edited, true);
      document.removeEventListener('change', edited, true);
    };
  }, []);

  // ------------------------------------------------------------------- picking a draft

  const pick = useCallback(async (id: string) => {
    opening.current = id;
    setPhase({ kind: 'opening', id });
    const [reply] = await Promise.all([
      askWorker<DraftReply>({ type: 'varysDraft', pageUrl, id }),
      // Bounded by the wait itself; a fault in it means the editors are as ready as they get.
      editorsReady().catch(() => undefined),
    ]);
    if (opening.current !== id) return;

    if (reply === null) {
      setPhase({ kind: 'list', message: ACTION_UNREACHABLE_COPY });
      return;
    }
    if (!reply.ok) {
      const message = copyFor(reply);
      if (reply.reason === 'expired' || reply.reason === 'not_connected') {
        setPhase({ kind: 'message', message });
        return;
      }
      if (reply.reason === 'not_found') setDrafts(prev => prev.filter(d => d.id !== id));
      setPhase({ kind: 'list', message });
      return;
    }
    const { answer } = reply;
    if (answer.status === 'not_tracked') {
      onClose();
      return;
    }

    const callout = await editorKeepsCallout();
    if (opening.current !== id) return;
    // Read now, with the rich editors in place: the form is the one Fill will write.
    fieldsRef.current = discoverSchema()?.fields ?? [];
    const rows = planDraftFill(answer, fieldsRef.current).filter(r => r.available);
    setTicks(initialTicks(rows));
    setDoctorTicks(initialDoctorTicks(answer));
    setResults(null);
    setOutcomes([]);
    setProfilesUndone([]);
    setPhase({ kind: 'review', review: { draft: answer, callout, rows } });
  }, [pageUrl, editorsReady, onClose]);

  const back = useCallback(() => {
    opening.current = null;
    setPhase({ kind: 'list', message: null });
  }, []);

  // ---------------------------------------------------------------------------- Fill

  const review = phase.kind === 'review' ? phase.review : null;

  const fill = useCallback(async () => {
    if (!review || filling || results !== null) return;
    const { draft, callout, rows } = review;
    const offered = (kind: DraftRowKind) => rows.some(r => r.kind === kind);
    const wanted = (kind: DraftRowKind) => {
      const row = rows.find(r => r.kind === kind);
      // A row carrying a note is never filled, whatever its tickbox says (Ruling Q).
      return row !== undefined && row.note === null && ticks[kind] === true;
    };

    setFilling(true);
    // Read afresh: a field Drupal's AJAX has added or replaced since is found.
    const all = discoverSchema()?.fields ?? fieldsRef.current;
    fieldsRef.current = all;
    const done: Partial<Record<DraftRowKind, Result>> = {};

    try {
      // 1. Title, only ever from the title the person confirmed (Ruling G).
      if (offered('title')) {
        const field = titleField(all);
        if (!wanted('title')) done.title = { status: 'skipped' };
        else {
          const record = field && draft.title !== null ? fillText(field, draft.title) : null;
          done.title = record ? { status: 'filled', text: record } : { status: 'failed' };
          if (record) markFilled('title');
        }
      }

      // 2. Summary, which a new page always fills (it is also the search description).
      if (offered('summary')) {
        const field = findField(all, DRAFT_FIELDS.summary);
        if (!wanted('summary')) done.summary = { status: 'skipped' };
        else {
          const record = field && draft.summary !== null ? fillText(field, draft.summary) : null;
          done.summary = record ? { status: 'filled', text: record } : { status: 'failed' };
          if (record) markFilled('meta_description');
        }
      }

      // 3. The search result title, with the field's site-name token kept (fillOne marks it).
      if (offered('meta_title')) {
        if (!wanted('meta_title')) done.meta_title = { status: 'skipped' };
        else {
          const record = draft.meta_title !== null ? fillOne('meta_title', draft.meta_title, all) : null;
          done.meta_title = record ? { status: 'filled', search: record } : { status: 'failed' };
        }
      }

      // 4. The body: the Overview box, then the draft, read back as the editor holds it.
      if (offered('body')) {
        if (!wanted('body')) done.body = { status: 'skipped' };
        else {
          const field = findField(all, DRAFT_FIELDS.body);
          const form = findNodeForm();
          let result: Result = { status: 'failed' };
          if (field && form) {
            const previous = await readBodyHtml(form);
            const html = bodyToFill(draft, callout);
            if (writeValue(field, html)) {
              const filled = html === previous ? previous : await bodyMovedOff(form, previous);
              if (filled !== previous) {
                result = { status: 'filled', body: { previous, filled } };
                markFilled('body');
              } else if (bodyText(previous) === bodyText(html)) {
                // Nothing moved because there was nothing to move: the body is this draft
                // already (filled before a Preview reloaded the form, say). Filled, with no Undo.
                result = { status: 'already' };
                markFilled('body');
              } else {
                // The editor never took it; the textarea alone would be overwritten on save.
                writeValue(field, previous);
              }
            }
          }
          done.body = result;
        }
      }

      // 5. Related Profiles: the ticked doctors, each added only on one exact match.
      if (offered('profiles') && draft.doctors !== null) {
        const names = draft.doctors.flatMap((d, i) => {
          const choice = doctorChoice(d);
          return choice.kind === 'add' && doctorTicks[i] ? [choice.fullName] : [];
        });
        // Any row will do: `addProfiles` finds the widget from it.
        const [anyInput] = profileInputs();
        let found: ProfileOutcome[] = [];
        if (names.length > 0) {
          found = anyInput
            ? await addProfiles(names, anyInput)
            : names.map(name => ({ name, result: 'unavailable' as const, delta: null }));
        }
        if (found.some(o => o.result === 'added')) markFilled('related_profiles');
        setOutcomes(found);
      }
    } catch (err) {
      // A fault part-way: what was filled stays filled, with its Undo; the rest says so.
      console.warn('[D7 Studio] Filling from a Varys draft failed part-way', err);
      for (const row of rows) if (row.kind !== 'profiles' && !done[row.kind]) done[row.kind] = { status: 'failed' };
    } finally {
      setResults(done);
      setFilling(false);
    }
  }, [review, filling, results, ticks, doctorTicks]);

  // ---------------------------------------------------------------------------- Undo

  const undo = useCallback(async (kind: DraftRowKind) => {
    const result = results?.[kind];
    if (!result || result.status !== 'filled') return;
    const all = fields();
    const settle = (next: Result) => setResults(prev => ({ ...prev, [kind]: next }));

    if ('text' in result) {
      const field = findField(all, result.text.machineName);
      if (!undoText(result.text, all) || !field || String(readValue(field)) !== result.text.previous) {
        settle({ status: 'kept', note: UNDO_FAILED_COPY });
        return;
      }
      unmarkFilled(kind === 'title' ? 'title' : 'meta_description');
      settle({ status: 'undone' });
      return;
    }
    if ('search' in result) {
      // undoFill unmarks the search title itself.
      settle(undoFill(result.search, all) ? { status: 'undone' } : { status: 'kept', note: UNDO_FAILED_COPY });
      return;
    }

    const form = findNodeForm();
    const field = findField(all, DRAFT_FIELDS.body);
    if (!form || !field) {
      settle({ status: 'kept', note: UNDO_FAILED_COPY });
      return;
    }
    const current = await readBodyHtml(form);
    if (!canUndoBody(result.body, current)) {
      settle({ status: 'kept', note: BODY_CHANGED_COPY });
      return;
    }
    if (!writeValue(field, result.body.previous)) {
      settle({ status: 'kept', note: UNDO_FAILED_COPY });
      return;
    }
    const now = result.body.previous === current ? current : await bodyMovedOff(form, current);
    if (now === current && result.body.previous !== current) {
      settle({ ...result, note: UNDO_FAILED_COPY });
      return;
    }
    unmarkFilled('body');
    settle({ status: 'undone' });
  }, [results, fields]);

  const undoDoctor = useCallback((index: number) => {
    const doctor = review?.draft.doctors?.[index];
    const choice = doctor ? doctorChoice(doctor) : null;
    const outcome = choice?.kind === 'add' ? outcomes.find(o => o.name === choice.fullName) : undefined;
    if (!outcome || !profileStillAdded(outcome)) return;
    undoProfiles([outcome]);
    if (profileStillAdded(outcome)) return;
    const undone = [...profilesUndone, outcome.delta as number];
    setProfilesUndone(undone);
    // Marked while any doctor added from the draft is still where it was put.
    const added = outcomes.filter(o => o.result === 'added');
    if (added.every(o => undone.includes(o.delta as number))) unmarkFilled('related_profiles');
  }, [review, outcomes, profilesUndone]);

  // ------------------------------------------------------------------------ rendering

  const body = ((): DraftPanelBody => {
    switch (phase.kind) {
      case 'message': return { state: 'message', message: phase.message };
      case 'list':
        return {
          state: 'list',
          drafts: drafts.map(d => ({ id: d.id, title: d.title, madeAt: d.made_at })),
          message: phase.message,
          appUrl: `${VARYS_APP_ORIGINS[0]}/draft-assistant`,
        };
      case 'opening':
        return { state: 'opening', title: drafts.find(d => d.id === phase.id)?.title ?? '' };
    }

    const { draft, rows } = phase.review;
    const before = results === null;
    const all = fields();

    const outcomeFor = (kind: DraftRowKind): { outcome: DraftOutcome | null; note: string | null } => {
      const result = results?.[kind];
      if (!result) return { outcome: null, note: null };
      switch (result.status) {
        case 'skipped': return { outcome: { text: 'Not filled', undo: false }, note: null };
        case 'failed': return { outcome: { text: 'Not filled', undo: false }, note: FILL_FAILED_COPY };
        case 'undone': return { outcome: { text: 'Undone', undo: false }, note: null };
        case 'kept': return { outcome: { text: 'Filled', undo: false }, note: result.note };
        case 'already': return { outcome: { text: 'Filled', undo: false }, note: ALREADY_HOLDS_COPY };
        case 'filled': {
          // Undo while the field still holds the fill. The body's editor cannot be read here,
          // so its Undo checks when pressed (canUndoBody), and says so if it is too late.
          const undoable = 'text' in result ? canUndoText(result.text, all)
            : 'search' in result ? canUndo(result.search, all)
              : true;
          return { outcome: { text: 'Filled', undo: undoable }, note: 'body' in result ? result.note ?? null : null };
        }
      }
    };

    const panelRows = rows.map((row): DraftPanelRow => {
      const notes = row.note !== null ? [row.note] : [];
      if (row.kind === 'body' && (draft.dropped.tables > 0 || draft.dropped.images > 0)) {
        notes.push(dropped(draft.dropped.tables, draft.dropped.images));
      }

      if (row.kind === 'profiles') {
        const doctors = (draft.doctors ?? []).map((doctor, index): DraftDoctorLine => {
          const choice = doctorChoice(doctor);
          if (choice.kind === 'by_hand') return { text: choice.text, tick: null, outcome: null };
          if (before) return { text: choice.text, tick: { checked: doctorTicks[index] === true, disabled: false }, outcome: null };
          if (!doctorTicks[index]) return { text: choice.text, tick: null, outcome: { text: NO_DOCTORS_TICKED_COPY, undo: false } };
          const found = outcomes.find(o => o.name === choice.fullName);
          if (!found) return { text: choice.text, tick: null, outcome: { text: PROFILE_COPY.unavailable, undo: false } };
          if (found.result === 'added' && found.delta !== null && profilesUndone.includes(found.delta)) {
            return { text: choice.text, tick: null, outcome: { text: 'Undone', undo: false } };
          }
          return {
            text: choice.text,
            tick: null,
            outcome: { text: PROFILE_COPY[found.result], undo: profileStillAdded(found) },
          };
        });
        return { kind: row.kind, label: row.label, preview: '', notes, tick: null, outcome: null, doctors };
      }

      const { outcome, note } = outcomeFor(row.kind);
      if (note !== null && !notes.includes(note)) notes.push(note);
      return {
        kind: row.kind,
        label: row.label,
        preview: row.preview,
        notes,
        tick: before ? { checked: ticks[row.kind] === true, disabled: row.note !== null } : null,
        outcome,
      };
    });

    const ticked = rows.filter(r => r.kind !== 'profiles' && r.note === null && ticks[r.kind] === true).length
      + (rows.some(r => r.kind === 'profiles') && doctorTicks.some(Boolean) ? 1 : 0);
    return { state: 'review', label: draft.label, madeAt: draft.made_at, rows: panelRows, before, filling, ticked };
  })();

  const place = usePlacement([body, collapsed]);

  return (
    <div
      className="fixed right-4 z-[2147483645] pointer-events-none [&>*]:pointer-events-auto"
      style={{ bottom: place.bottom, display: place.hidden ? 'none' : undefined }}
    >
      <DraftPanel
        body={body}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed(c => !c)}
        now={Date.now()}
        onPick={id => { void pick(id); }}
        onBack={back}
        onToggle={kind => setTicks(prev => ({ ...prev, [kind]: !prev[kind] }))}
        onToggleDoctor={index => setDoctorTicks(prev => prev.map((t, i) => (i === index ? !t : t)))}
        onFill={() => { void fill(); }}
        onUndo={kind => { void undo(kind); }}
        onUndoDoctor={undoDoctor}
        maxHeight={place.maxHeight}
      />
    </div>
  );
}

/**
 * Shows the person's Varys drafts on a new page's form, when this browser is connected, the
 * form's site is one Varys tracks, and Varys has at least one draft of theirs for it. An
 * expired key shows the reconnect copy instead, and nothing else, whether it had expired
 * already or Varys refuses it now. Every other answer (none, not tracked, unreachable, an
 * error) mounts nothing, so a Varys that is down does not put a panel on every new page this
 * person opens. Not awaited by anything, and never lets a fault of its own reach the person
 * editing: the panel is an extra.
 *
 * Whether the site is tracked is the worker's to say, inside `varysDrafts`, as it is for Part
 * 1's suggestions: it checks connected, then expired, then the list of tracked sites, and
 * sends nothing to Varys about a site it does not track, or at all for an expired key (an
 * expired key on a site the last list does not track is "not tracked", so no panel).
 *
 * `editorsReady` is index.tsx's one shared wait for the page's rich editors, called only once
 * a draft is picked, so the body is filled and asked about with its editor in place.
 */
export async function startVarysDraftPanel(editorsReady: () => Promise<unknown>): Promise<void> {
  try {
    if (nodeIdFromPath(window.location.pathname) !== null) return;
    if (!(await varysIsConnected())) return;
    // The site's address, and nothing of the page: a new page has no address of its own yet.
    const pageUrl = `${window.location.origin}/`;
    const reply = await askWorker<DraftsReply>({ type: 'varysDrafts', pageUrl });
    if (reply === null) return;

    let first: Phase;
    let drafts: DraftSummary[] = [];
    if (!reply.ok) {
      if (reply.reason === 'error') console.warn('[D7 Studio] Varys could not list drafts for this site:', reply.message);
      if (reply.reason !== 'expired') return;
      first = { kind: 'message', message: ACTION_EXPIRED_COPY };
    } else {
      if (reply.answer.status !== 'ok' || reply.answer.drafts.length === 0) return;
      drafts = reply.answer.drafts;
      first = { kind: 'list', message: null };
    }

    const overlay = injectOverlay(
      <DraftsPanel
        pageUrl={pageUrl}
        drafts={drafts}
        first={first}
        editorsReady={editorsReady}
        onClose={() => overlay.unmount()}
      />,
    );
  } catch (err) {
    console.warn('[D7 Studio] Could not show Varys drafts', err);
  }
}
