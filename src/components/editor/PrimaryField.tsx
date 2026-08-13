import React, { useState, useCallback } from 'react';
import { AlertCircle } from 'lucide-react';
import { FieldDescriptor } from '../../lib/formSchema';
import { readValue, writeValue } from '../../lib/fieldBinding';

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

  // Body: a toolbar strip over a tall serif editing surface.
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-eyebrow font-semibold uppercase text-ink-secondary">{field.label}</span>
        {required}
      </div>

      {/* Presentational strip matching the design. The real formatting controls stay
          in Drupal's editor; claiming otherwise with live-looking buttons would be
          worse than showing the surface plainly. */}
      <div className="flex items-center gap-0 bg-legacy-100 border border-rule border-b-0 px-1">
        {['B', 'I', 'Link', 'H2', 'H3', 'List', 'Table', 'Image'].map(tool => (
          <span
            key={tool}
            aria-hidden="true"
            // Min-width rather than a fixed 26px: "Table" and "Image" overflowed a
            // fixed cell and collided with their neighbours.
            className="min-w-6.5 h-6.5 px-1.5 flex items-center justify-center text-help text-ink-placeholder"
          >
            {tool}
          </span>
        ))}
      </div>

      <textarea
        value={value}
        onChange={e => commit(e.target.value)}
        aria-label={field.label}
        className="w-full min-h-[300px] -mt-1.5 px-4 py-3 bg-white border border-rule-control font-serif text-body-surface text-ink"
      />

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
