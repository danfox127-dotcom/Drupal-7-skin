import React, { useId } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { FillKind } from '../../lib/varys/suggestionFill';

/**
 * Varys's Page Health suggestions for the page being edited, beside Drupal's form.
 *
 * Presentational: everything it shows and every button's effect comes in as props, so the
 * rules about which field a suggestion fills, when Undo is safe and what Varys said live in
 * src/content/varysPanel.tsx. Nothing here touches the form or the extension.
 *
 * Varys fills; the person presses Save. No button here saves, and none writes the body
 * except Insert at cursor, which puts one heading where the person clicked.
 */

/** One of the three text suggestions: what the page has now against what Varys suggests. */
export interface SuggestionRow {
  kind: FillKind;
  label: string;
  /** The live field's value; null when this form has no field for it. */
  now: string | null;
  suggested: string | null;
  /**
   * `use` offers Use, `undo` offers Undo (a fill is live and still undoable), `blocked`
   * shows Use disabled with `note` saying why, `none` shows no button.
   */
  action: 'use' | 'undo' | 'blocked' | 'none';
  /** Where the suggestion goes, when that needs saying (the description). */
  where?: string | null;
  /** Why Use is disabled, or why a fill did not happen. */
  note?: string | null;
}

/**
 * A doctor the article names who is not in Related Profiles (or who was just added there).
 * Offered with Add, and once added with Undo.
 */
export interface DoctorRow {
  /** The directory's full name, as Varys gave it. */
  fullName: string;
  /** `add` offers Add, `undo` offers Undo (the doctor was added here and the row still holds it), `none` no button. */
  action: 'add' | 'undo' | 'none';
  /** An Add is under way, so Related Profiles is not changed again until it ends. */
  disabled: boolean;
  /** What the last Add came to, in words, or null. */
  message: string | null;
}

/** What the panel's body shows. */
export type PanelBody =
  | {
    state: 'ready';
    /** ISO time Varys made the suggestions, or null when it has none. */
    madeAt: string | null;
    clinicalNote: string | null;
    rows: SuggestionRow[];
    /** Doctors the article names that Related Profiles lacks; empty when the form has no such field. */
    doctors: DoctorRow[];
    /** A title fill unticked "Generate automatic URL alias", so the address stays as it is. */
    addressKept: boolean;
    headings: { current: string[]; suggested: string[] };
    /** What the last Copy or Insert did, in words, or null. */
    headingMessage: string | null;
  }
  | { state: 'none' }
  | { state: 'generating' }
  | { state: 'still_writing' }
  | { state: 'not_crawled' }
  | { state: 'message'; message: string };

export interface SuggestionsPanelProps {
  body: PanelBody;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Now, in ms, for "made 2 days ago". */
  now: number;
  onAsk: () => void;
  onUse: (kind: FillKind) => void;
  onUndo: (kind: FillKind) => void;
  onAddDoctor: (fullName: string) => void;
  onUndoDoctor: (fullName: string) => void;
  onLetAddressChange: () => void;
  onCopy: (text: string) => void;
  onInsert: (text: string) => void;
  /** Caps the panel's height so it stays clear of Drupal's Save buttons (see varysPanel). */
  maxHeight?: number;
}

export const NONE_COPY = "Varys hasn't written suggestions for this page yet.";
export const GENERATING_COPY = 'Varys is writing suggestions. This takes about a minute.';
export const STILL_WRITING_COPY = 'Still writing. Check back in a few minutes.';
export const NOT_CRAWLED_COPY = "Varys hasn't read this page yet, so it has no suggestions. It reads each site weekly.";
export const KEEPS_ADDRESS_COPY = 'Using this title keeps the current web address.';
export const LET_ADDRESS_CHANGE_COPY = 'Let the address change instead';
export const doctorCopy = (fullName: string) => `Named in this article but not in Related Profiles: ${fullName}`;

/**
 * "2 days ago", "yesterday", "just now". Null when the time cannot be read, so nothing is
 * claimed. A time in the future (a clock ahead of this one) reads as just now.
 */
export function relativeTime(iso: string, now: number): string | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const seconds = (now - then) / 1000;
  if (seconds < 60) return 'just now';

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 30) return rtf.format(-days, 'day');
  const months = Math.round(days / 30);
  if (months < 12) return rtf.format(-months, 'month');
  return rtf.format(-Math.round(days / 365), 'year');
}

const BUTTON = 'px-3 py-1 rounded text-help font-semibold transition-colors duration-200 ease-studio '
  + 'disabled:opacity-40 disabled:cursor-not-allowed';
const PRIMARY = `${BUTTON} bg-cu-blue hover:bg-cu-navy text-white`;
const SECONDARY = `${BUTTON} bg-white border border-cu-blue text-cu-blue hover:bg-cu-tint`;
const QUIET = `${BUTTON} bg-white border border-rule-control text-ink hover:bg-legacy-200`;

function Value({ text }: { text: string | null }) {
  if (text === null) return <span className="text-ink-help italic">Not on this form</span>;
  if (text.trim() === '') return <span className="text-ink-help italic">Empty</span>;
  return <span className="text-ink break-words">{text}</span>;
}

function Row({ row, onUse, onUndo }: {
  row: SuggestionRow;
  onUse: (kind: FillKind) => void;
  onUndo: (kind: FillKind) => void;
}) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="py-3 border-t border-rule-hair first:border-t-0">
      <div className="flex items-start gap-3">
        <p id={labelId} className="flex-1 text-eyebrow font-semibold uppercase text-ink-secondary pt-1">
          {row.label}
        </p>
        {row.action === 'undo' && (
          <button type="button" className={QUIET} onClick={() => onUndo(row.kind)}>Undo</button>
        )}
        {(row.action === 'use' || row.action === 'blocked') && (
          <button
            type="button"
            className={PRIMARY}
            disabled={row.action === 'blocked'}
            onClick={() => onUse(row.kind)}
          >
            Use
          </button>
        )}
      </div>
      <dl className="mt-1 grid gap-x-3 gap-y-0.5 text-control" style={{ gridTemplateColumns: 'auto 1fr' }}>
        <dt className="text-help text-ink-help">Now</dt>
        <dd><Value text={row.now} /></dd>
        <dt className="text-help text-ink-help">Varys suggests</dt>
        <dd>{row.suggested === null
          ? <span className="text-ink-help italic">No suggestion</span>
          : <span className="text-ink break-words">{row.suggested}</span>}
        </dd>
      </dl>
      {row.where && <p className="mt-1 text-help text-ink-help">{row.where}</p>}
      {row.note && <p className="mt-1 text-help text-ink-secondary">{row.note}</p>}
    </div>
  );
}

function Doctor({ doctor, onAdd, onUndo }: {
  doctor: DoctorRow;
  onAdd: (fullName: string) => void;
  onUndo: (fullName: string) => void;
}) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="py-3 border-t border-rule-hair">
      <div className="flex items-start gap-3">
        <p id={labelId} className="flex-1 text-control text-ink break-words pt-1">{doctorCopy(doctor.fullName)}</p>
        {doctor.action === 'add' && (
          <button type="button" className={PRIMARY} disabled={doctor.disabled} onClick={() => onAdd(doctor.fullName)}>
            Add
          </button>
        )}
        {doctor.action === 'undo' && (
          <button type="button" className={QUIET} disabled={doctor.disabled} onClick={() => onUndo(doctor.fullName)}>
            Undo
          </button>
        )}
      </div>
      {doctor.message && <p role="status" className="mt-1 text-help text-ink-secondary">{doctor.message}</p>}
    </div>
  );
}

function HeadingColumn({ title, headings, actions }: {
  title: string;
  headings: string[];
  actions?: (text: string) => React.ReactNode;
}) {
  const titleId = useId();
  return (
    <div className="min-w-0">
      <p id={titleId} className="text-eyebrow font-semibold uppercase text-ink-secondary">{title}</p>
      {headings.length === 0
        ? <p className="mt-1 text-help text-ink-help italic">None</p>
        : (
          <ul aria-labelledby={titleId} className="mt-1 flex flex-col gap-2">
            {headings.map((text, index) => (
              <li key={`${index}:${text}`} className="text-control text-ink break-words">
                {text}
                {actions && <div className="mt-1 flex flex-wrap gap-1.5">{actions(text)}</div>}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

function Ready({ body, onUse, onUndo, onAddDoctor, onUndoDoctor, onLetAddressChange, onCopy, onInsert }: {
  body: Extract<PanelBody, { state: 'ready' }>;
} & Pick<SuggestionsPanelProps,
  'onUse' | 'onUndo' | 'onAddDoctor' | 'onUndoDoctor' | 'onLetAddressChange' | 'onCopy' | 'onInsert'>) {
  return (
    <>
      {body.clinicalNote && (
        <div className="mb-2 p-2.5 bg-legacy-100 border-l-2 border-burnt">
          <p className="text-eyebrow font-semibold uppercase text-ink-secondary">Clinical review</p>
          <p className="mt-0.5 text-control text-ink">{body.clinicalNote}</p>
        </div>
      )}

      {body.rows.map(row => <Row key={row.kind} row={row} onUse={onUse} onUndo={onUndo} />)}

      {body.doctors.map(doctor => (
        <Doctor key={doctor.fullName} doctor={doctor} onAdd={onAddDoctor} onUndo={onUndoDoctor} />
      ))}

      {body.addressKept && (
        <p className="pb-3 text-help text-ink">
          {KEEPS_ADDRESS_COPY}{' '}
          <button type="button" className="font-semibold text-cu-blue hover:underline" onClick={onLetAddressChange}>
            {LET_ADDRESS_CHANGE_COPY}
          </button>
        </p>
      )}

      <div className="pt-3 border-t border-rule">
        <p className="text-section font-semibold text-ink">Headings</p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <HeadingColumn title="On the page now" headings={body.headings.current} />
          <HeadingColumn
            title="Varys suggests"
            headings={body.headings.suggested}
            actions={text => (
              <>
                <button type="button" className={QUIET} onClick={() => onCopy(text)}>Copy</button>
                <button
                  type="button"
                  className={SECONDARY}
                  // Keeps the focus, and with it the cursor, in the body's editor.
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => onInsert(text)}
                >
                  Insert at cursor
                </button>
              </>
            )}
          />
        </div>
        {body.headingMessage && (
          <p role="status" className="mt-2 text-help text-ink">{body.headingMessage}</p>
        )}
      </div>
    </>
  );
}

export function SuggestionsPanel(props: SuggestionsPanelProps) {
  const { body, collapsed, onToggleCollapsed, now, onAsk, maxHeight } = props;
  const made = body.state === 'ready' && body.madeAt ? relativeTime(body.madeAt, now) : null;

  return (
    <section
      data-varys-panel=""
      aria-label="Varys suggestions"
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
          <span className="text-control font-semibold text-cu-onLight">Varys · suggestions for this page</span>
          {made && <span className="text-help text-ink-help"> · made {made}</span>}
        </span>
        {collapsed
          ? <ChevronUp size={16} className="text-cu-onLight shrink-0" aria-hidden="true" />
          : <ChevronDown size={16} className="text-cu-onLight shrink-0" aria-hidden="true" />}
      </button>

      {!collapsed && (
        <div className="min-h-0 overflow-y-auto px-3.5 py-3">
          {body.state === 'ready' && <Ready {...props} body={body} />}

          {(body.state === 'none' || body.state === 'generating') && (
            <div className="flex flex-col items-start gap-2">
              <p className="text-control text-ink" role="status">
                {body.state === 'none' ? NONE_COPY : GENERATING_COPY}
              </p>
              <button type="button" className={PRIMARY} disabled={body.state === 'generating'} onClick={onAsk}>
                Ask Varys
              </button>
            </div>
          )}

          {body.state === 'still_writing' && <p className="text-control text-ink" role="status">{STILL_WRITING_COPY}</p>}
          {body.state === 'not_crawled' && <p className="text-control text-ink">{NOT_CRAWLED_COPY}</p>}
          {body.state === 'message' && <p className="text-control text-ink" role="status">{body.message}</p>}
        </div>
      )}
    </section>
  );
}
