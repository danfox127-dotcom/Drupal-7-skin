import React, { useState, useCallback } from 'react';
import { AlertCircle } from 'lucide-react';
import { FieldDescriptor } from '../../lib/formSchema';
import { readValue, writeValue } from '../../lib/fieldBinding';
import { SlottedFieldsContext } from './FieldControl';
import { slotNameFor } from '../../content/inject';

/**
 * The left column's writing surface.
 *
 * Title, Subtitle, Summary, and Body get bespoke treatment because they ARE the
 * design's centrepiece — a borderless serif title at 40px reading as a headline, not
 * a form field. Rendering them through the generic FieldControl produced four
 * identical labelled boxes, which loses the whole point of screen 1.
 *
 * Everything else still goes through FieldControl, so unrecognized fields keep
 * working.
 */

interface Props {
  field: FieldDescriptor;
  role: 'title' | 'subtitle' | 'summary' | 'body';
  error?: string | null;
  onChange?: () => void;
}

/**
 * Summary length limit.
 *
 * The handoff ties the summary to the meta description, and the live form's meta
 * description help text reads "Content limited to 380 characters". Ideally this is
 * read from that field rather than hardcoded — noted as a follow-up, since the
 * relationship is only visible in the reference screenshot.
 */
const SUMMARY_LIMIT = 380;

export const PrimaryField = ({ field, role, error, onChange }: Props) => {
  /**
   * Whether the native widget was relocated here. Read from context for the same reason
   * FieldControl does: a missed prop renders a control that looks fine and silently
   * cannot save, because the real widget is left unslotted and therefore unrendered.
   */
  const relocated = React.useContext(SlottedFieldsContext);
  const slotted = relocated.has(field.machineName);

  const [value, setValue] = useState<string>(() => String(readValue(field)));

  const commit = useCallback((next: string) => {
    setValue(next);
    writeValue(field, next);
    onChange?.();
  }, [field, onChange]);

  // The word "Required", not an asterisk and not shouted — matching FieldControl so
  // the two do not render the same concept differently.
  const required = field.required && (
    <span className="text-help font-semibold text-burnt">Required</span>
  );

  /**
   * Any relocated field renders through its slot, whatever its role.
   *
   * Only the body branch did this, so a relocated Summary — Drupal's core "Edit summary"
   * has a rich editor attached on Specialty — produced no <slot>, and an unslotted
   * light-DOM child of a shadow host is not rendered at all. The real widget went
   * invisible while still submitting, which is the same silent failure the orphan check
   * was added to catch. It caught it: "field-body-und--0--summary-".
   *
   * No eyebrow label here, for the reason FieldControl leaves one out too: the relocated
   * wrapper brings Drupal's own <label> with it, so ours renders the field name twice.
   */
  if (slotted) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="d7-slot-host bg-white">
          <slot name={slotNameFor(field.machineName)} />
        </div>

        {role === 'summary' && (
          /*
           * The caption stays, the live counter cannot: Drupal's editor holds the value
           * in its own object, so any number here would be stale the moment it was typed.
           * Better to state the limit than to display a count that is quietly wrong.
           */
          <p className="text-help text-ink-help">
            Doubles as the meta description, limit {SUMMARY_LIMIT} characters. Drupal's own
            editor owns this field, so it is not counted here as you type.
          </p>
        )}

        {error && (
          <p className="flex items-start gap-1.5 text-help text-burnt font-semibold">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    );
  }

  if (role === 'title') {
    return (
      <div className="flex flex-col gap-1">
        <input
          type="text"
          value={value}
          onChange={e => commit(e.target.value)}
          placeholder={field.label}
          aria-label={field.label}
          className="w-full bg-transparent border-0 border-b border-rule pb-2 font-serif text-title text-ink placeholder:text-ink-placeholder outline-none"
        />
        {(required || error) && (
          <div className="flex items-center gap-2">
            {required}
            {error && <span className="text-help font-semibold text-burnt">{error}</span>}
          </div>
        )}
      </div>
    );
  }

  if (role === 'subtitle') {
    return (
      <input
        type="text"
        value={value}
        onChange={e => commit(e.target.value)}
        placeholder={`${field.label} (optional)`}
        aria-label={field.label}
        className="w-full bg-transparent border-0 font-serif italic text-subtitle text-ink-secondary placeholder:text-ink-placeholder outline-none"
      />
    );
  }

  if (role === 'summary') {
    const remaining = SUMMARY_LIMIT - value.length;
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-eyebrow font-semibold uppercase text-ink-secondary">{field.label}</span>
          {required}
        </div>
        <textarea
          value={value}
          onChange={e => commit(e.target.value)}
          aria-label={field.label}
          className="w-full min-h-[78px] px-3 py-2 bg-white border border-rule-control rounded text-input text-ink"
        />
        <p className={`text-help ${remaining < 0 ? 'text-burnt font-semibold' : 'text-ink-help'}`}>
          Doubles as the meta description.{' '}
          {remaining >= 0
            ? `${remaining} characters remaining.`
            : `${Math.abs(remaining)} characters over the ${SUMMARY_LIMIT}-character limit.`}
        </p>
        {error && (
          <p className="flex items-start gap-1.5 text-help text-burnt font-semibold">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    );
  }

  // Body: Drupal's own editor when it has one, otherwise a plain writing surface.
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-eyebrow font-semibold uppercase text-ink-secondary">{field.label}</span>
        {required}
      </div>

      {/*
        Reached only when Drupal has NO rich editor on this field — a relocated one is
        handled by the slotted branch above.

        There is deliberately no toolbar drawn here. This used to render a row of grey
        aria-hidden spans reading "B I Link H2 H3 List Table Image", none of which did
        anything; and where Drupal accepts only plain text, buttons would promise
        formatting that gets stripped on save.
      */}
      <textarea
        value={value}
        onChange={e => commit(e.target.value)}
        aria-label={field.label}
        className="w-full min-h-[300px] px-4 py-3 bg-white border border-rule-control font-serif text-body-surface text-ink"
      />
      <p className="text-help text-ink-help">
        This field has no rich text editor in Drupal, so it takes plain text.
      </p>

      {error && (
        <p className="flex items-start gap-1.5 text-help text-burnt font-semibold">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
};

/** Classifies a primary field by label, or null when it is not one of the four. */
export function primaryRole(field: FieldDescriptor): Props['role'] | null {
  const label = field.label.toLowerCase();
  if (/^title$/.test(label)) return 'title';
  if (/^subtitle/.test(label)) return 'subtitle';
  if (/^summary$/.test(label)) return 'summary';
  if (/^body$/.test(label)) return 'body';
  return null;
}
