import React, { useId } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { DraftRowKind } from '../../lib/varys/draftFill';
import { relativeTime } from './SuggestionsPanel';

/**
 * The person's Varys drafts on a new page's form, and what picking one fills in.
 *
 * Presentational: everything it shows and every control's effect comes in as props, so the
 * rules about what is offered, what starts ticked and when Undo is safe live in
 * src/content/varysDraftPanel.tsx. Nothing here touches the form or the extension.
 *
 * Varys fills; the person presses Save. No control here saves, submits, previews or
 * publishes, and the panel says so beside every fill.
 */

/** A tickbox: whether it is ticked, and whether the person may change it. */
export interface DraftTick {
  checked: boolean;
  disabled: boolean;
}

/** What happened to a row, or a doctor, once Fill was pressed. */
export interface DraftOutcome {
  text: string;
  /** Offers Undo beside it. */
  undo: boolean;
}

/** One doctor the draft names, in the Related Profiles row. */
export interface DraftDoctorLine {
  /** The line, which is also the name of its tickbox. */
  text: string;
  /** Null for a doctor who can only be added by hand: there is nothing to tick. */
  tick: DraftTick | null;
  outcome: DraftOutcome | null;
}

/** One field the draft fills. */
export interface DraftPanelRow {
  kind: DraftRowKind;
  label: string;
  /** What goes in, in words. Empty for a row that says it through `doctors` or `notes`. */
  preview: string;
  /** Said under the preview: why a row is not filled, or what it leaves out. */
  notes: string[];
  /** The row's own tickbox; null for Related Profiles (a tickbox per doctor) and after Fill. */
  tick: DraftTick | null;
  outcome: DraftOutcome | null;
  doctors?: DraftDoctorLine[];
}

export interface DraftListItem {
  id: string;
  title: string;
  madeAt: string;
}

/** What the panel's body shows. */
export type DraftPanelBody =
  | {
    state: 'list';
    drafts: DraftListItem[];
    /** Said above the list: why the last draft picked could not be opened. */
    message: string | null;
    appUrl: string;
  }
  | { state: 'opening'; title: string }
  | {
    state: 'review';
    /** The draft's own name in Varys, for the heading only. It is never written into the form. */
    label: string;
    madeAt: string;
    rows: DraftPanelRow[];
    /** Fill has not been pressed: the tickboxes and Fill are offered. */
    before: boolean;
    filling: boolean;
    /** How many fields Fill would write now. */
    ticked: number;
  }
  | { state: 'message'; message: string };

export interface DraftPanelProps {
  body: DraftPanelBody;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Now, in ms, for "made 2 days ago". */
  now: number;
  onPick: (id: string) => void;
  onBack: () => void;
  onToggle: (kind: DraftRowKind) => void;
  onToggleDoctor: (index: number) => void;
  onFill: () => void;
  onUndo: (kind: DraftRowKind) => void;
  onUndoDoctor: (index: number) => void;
  /** Caps the panel's height so it stays clear of Drupal's Save buttons. */
  maxHeight?: number;
}

export const NOTHING_SAVED_COPY = "Nothing is saved: review, then press Drupal's own Save.";
export const REPLACES_COPY = 'If a field already has text, filling replaces it, and Undo puts it back.';
export const OPENING_COPY = 'Opening the draft…';
export const FILLING_COPY = 'Filling…';
export const OPEN_APP_COPY = 'Open Draft Assistant';

const BUTTON = 'px-3 py-1 rounded text-help font-semibold transition-colors duration-200 ease-studio '
  + 'disabled:opacity-40 disabled:cursor-not-allowed';
const PRIMARY = `${BUTTON} bg-cu-blue hover:bg-cu-navy text-white`;
const QUIET = `${BUTTON} bg-white border border-rule-control text-ink hover:bg-legacy-200`;
const LINK = 'font-semibold text-cu-blue hover:underline';

function Outcome({ outcome, onUndo }: { outcome: DraftOutcome; onUndo: () => void }) {
  return (
    <span className="shrink-0 flex items-center gap-2">
      <span className="text-help text-ink-secondary">{outcome.text}</span>
      {outcome.undo && <button type="button" className={QUIET} onClick={onUndo}>Undo</button>}
    </span>
  );
}

function Doctor({ line, index, disabled, onToggle, onUndo }: {
  line: DraftDoctorLine;
  index: number;
  disabled: boolean;
  onToggle: (index: number) => void;
  onUndo: (index: number) => void;
}) {
  return (
    <li className="flex items-start gap-2 text-control text-ink">
      {line.tick
        ? (
          <label className="flex-1 min-w-0 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0"
              checked={line.tick.checked}
              disabled={disabled || line.tick.disabled}
              onChange={() => onToggle(index)}
            />
            <span className="break-words">{line.text}</span>
          </label>
        )
        : <span className={`flex-1 min-w-0 break-words${line.outcome ? '' : ' text-ink-secondary'}`}>{line.text}</span>}
      {line.outcome && <Outcome outcome={line.outcome} onUndo={() => onUndo(index)} />}
    </li>
  );
}

function Row({ row, disabled, onToggle, onUndo, onToggleDoctor, onUndoDoctor }: {
  row: DraftPanelRow;
  disabled: boolean;
} & Pick<DraftPanelProps, 'onToggle' | 'onUndo' | 'onToggleDoctor' | 'onUndoDoctor'>) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="py-3 border-t border-rule-hair first:border-t-0">
      <div className="flex items-start gap-2">
        {row.tick && (
          <input
            type="checkbox"
            className="mt-1 shrink-0"
            aria-labelledby={labelId}
            checked={row.tick.checked}
            disabled={disabled || row.tick.disabled}
            onChange={() => onToggle(row.kind)}
          />
        )}
        <p id={labelId} className="flex-1 text-eyebrow font-semibold uppercase text-ink-secondary pt-1">{row.label}</p>
        {row.outcome && <Outcome outcome={row.outcome} onUndo={() => onUndo(row.kind)} />}
      </div>
      {row.preview && <p className="mt-1 text-control text-ink break-words">{row.preview}</p>}
      {row.notes.map(note => <p key={note} className="mt-1 text-help text-ink-secondary">{note}</p>)}
      {row.doctors && row.doctors.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1.5">
          {row.doctors.map((line, index) => (
            <Doctor
              // The doctors' order is Varys's, fixed for the life of the panel.
              key={index}
              line={line}
              index={index}
              disabled={disabled}
              onToggle={onToggleDoctor}
              onUndo={onUndoDoctor}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Review({ body, onBack, onFill, onToggle, onUndo, onToggleDoctor, onUndoDoctor }: {
  body: Extract<DraftPanelBody, { state: 'review' }>;
} & Pick<DraftPanelProps, 'onBack' | 'onFill' | 'onToggle' | 'onUndo' | 'onToggleDoctor' | 'onUndoDoctor'>) {
  const handlers = { onToggle, onUndo, onToggleDoctor, onUndoDoctor };
  return (
    <>
      <div className="flex items-start gap-2 pb-1">
        <p className="flex-1 min-w-0 text-section font-semibold text-ink break-words">{body.label} → fill these fields</p>
        {body.before && !body.filling && (
          <button type="button" className={`${LINK} text-help shrink-0 pt-0.5`} onClick={onBack}>Back to drafts</button>
        )}
      </div>

      {body.rows.map(row => <Row key={row.kind} row={row} disabled={body.filling} {...handlers} />)}

      <div className="pt-3 border-t border-rule flex flex-col items-start gap-2">
        {body.before && (
          <button type="button" className={PRIMARY} disabled={body.filling || body.ticked === 0} onClick={onFill}>
            {`Fill ${body.ticked} ${body.ticked === 1 ? 'field' : 'fields'}`}
          </button>
        )}
        {body.filling && <p className="text-help text-ink" role="status">{FILLING_COPY}</p>}
        {body.before && <p className="text-help text-ink-help">{REPLACES_COPY}</p>}
        <p className="text-help text-ink">{NOTHING_SAVED_COPY}</p>
      </div>
    </>
  );
}

function List({ body, now, onPick }: {
  body: Extract<DraftPanelBody, { state: 'list' }>;
  now: number;
  onPick: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {body.message && <p className="text-control text-ink" role="status">{body.message}</p>}
      {body.drafts.length > 0 && (
        <ul className="flex flex-col gap-1">
          {body.drafts.map(draft => {
            const made = relativeTime(draft.madeAt, now);
            return (
              <li key={draft.id}>
                <button
                  type="button"
                  className="w-full text-left px-2 py-1.5 rounded border border-rule-hair hover:bg-cu-tint transition-colors duration-200 ease-studio"
                  onClick={() => onPick(draft.id)}
                >
                  <span className="block text-control font-semibold text-ink break-words">{draft.title}</span>
                  {made && <span className="block text-help text-ink-help">made {made}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <a className={`${LINK} text-help self-start`} href={body.appUrl} target="_blank" rel="noopener noreferrer">
        {OPEN_APP_COPY}
      </a>
      <p className="text-help text-ink">{NOTHING_SAVED_COPY}</p>
    </div>
  );
}

export function DraftPanel(props: DraftPanelProps) {
  const { body, collapsed, onToggleCollapsed, now, onPick, maxHeight } = props;
  const made = body.state === 'review' ? relativeTime(body.madeAt, now) : null;

  return (
    <section
      data-varys-draft-panel=""
      aria-label="Varys drafts"
      className="w-[440px] max-w-[calc(100vw-32px)] flex flex-col bg-white border border-rule shadow-modal font-sans"
      style={maxHeight !== undefined ? { maxHeight } : undefined}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
        className="shrink-0 w-full flex items-center gap-2 px-3.5 py-2.5 text-left bg-cu-tint hover:bg-cu-tintDeep transition-colors duration-200 ease-studio"
      >
        <span className="flex-1 min-w-0 truncate">
          <span className="text-control font-semibold text-cu-onLight">Varys · start from a draft</span>
          {made && <span className="text-help text-ink-help"> · made {made}</span>}
        </span>
        {collapsed
          ? <ChevronUp size={16} className="text-cu-onLight shrink-0" aria-hidden="true" />
          : <ChevronDown size={16} className="text-cu-onLight shrink-0" aria-hidden="true" />}
      </button>

      {!collapsed && (
        <div className="min-h-0 overflow-y-auto px-3.5 py-3">
          {body.state === 'list' && <List body={body} now={now} onPick={onPick} />}
          {body.state === 'opening' && (
            <p className="text-control text-ink" role="status">{OPENING_COPY} <span className="text-ink-help">{body.title}</span></p>
          )}
          {body.state === 'review' && <Review {...props} body={body} />}
          {body.state === 'message' && <p className="text-control text-ink" role="status">{body.message}</p>}
        </div>
      )}
    </section>
  );
}
