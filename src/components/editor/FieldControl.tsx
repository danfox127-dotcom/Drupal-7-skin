import React, { useState, useCallback } from 'react';
import { AlertCircle } from 'lucide-react';
import { FieldDescriptor } from '../../lib/formSchema';
import { readValue, writeValue, FieldValue } from '../../lib/fieldBinding';
import { slotNameFor } from '../../content/inject';

/**
 * Renders one discovered field and writes changes straight to its native control.
 *
 * Deliberately generic: it handles every FieldKind the walker can produce, including
 * kinds the rail has no bespoke design for. That is what keeps the overlay honest on
 * the ten-plus content types nobody has designed screens for — an unrecognized field
 * still renders and still saves, rather than being dropped.
 */

/**
 * The set of fields whose native widget was relocated into the overlay host.
 *
 * This is context rather than a prop because getting it wrong FAILS SILENTLY AND LOSES
 * DATA, and it was already wrong in three places. A relocated widget is a light-DOM child
 * of the shadow host carrying a `slot` attribute; if nothing renders a matching `<slot>`,
 * the browser does not render that child AT ALL. So the editor showed a reimplemented text
 * box, the user typed into it, and — because controls inside a shadow root are not
 * form-associated and so are never submitted — the real field kept its old value and the
 * typing was discarded with no error anywhere.
 *
 * TopicsSection and MenuSection both rendered FieldControl without threading the prop,
 * which is how Tags became invisible on both demo sites. Reading from context means a
 * section cannot forget.
 */
/** Stable identity, so providing "nothing relocated" does not re-render on every pass. */
export const EMPTY_SLOTTED: ReadonlySet<string> = new Set();
export const SlottedFieldsContext = React.createContext<ReadonlySet<string>>(EMPTY_SLOTTED);

interface Props {
  field: FieldDescriptor;
  error?: string | null;
  /** Compact layout for the right rail; roomier in the left column. */
  dense?: boolean;
  /**
   * Overrides the context. Only needed when rendering a field whose widget was not
   * relocated by the usual pass; leave unset and the context decides.
   */
  slotted?: boolean;
  onChange?: (field: FieldDescriptor, value: FieldValue) => void;
}

/** Label plus the word "Required" in burnt orange, never a bare asterisk. */
export function FieldLabel({ field, htmlFor }: { field: FieldDescriptor; htmlFor?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <label htmlFor={htmlFor} className="text-eyebrow font-semibold uppercase text-ink-secondary">
        {field.label}
      </label>
      {field.required && (
        <span className="text-help font-semibold text-burnt">Required</span>
      )}
    </div>
  );
}

export const FieldControl = ({ field, error, dense, slotted: slottedProp, onChange }: Props) => {
  const relocated = React.useContext(SlottedFieldsContext);
  const slotted = slottedProp ?? relocated.has(field.machineName);

  const [value, setValue] = useState<FieldValue>(() => readValue(field));
  const [writeFailed, setWriteFailed] = useState(false);

  const commit = useCallback((next: FieldValue) => {
    setValue(next);
    const ok = writeValue(field, next);
    // A failed write means the native control rejected the value — most often a
    // select with no matching option. Surfacing it beats a silent mismatch between
    // what the editor shows and what Drupal will receive.
    setWriteFailed(!ok);
    onChange?.(field, next);
  }, [field, onChange]);

  const inputId = `d7-field-${field.machineName.replace(/[^a-z0-9]/gi, '-')}`;
  const inputClass =
    'w-full px-3 py-2 bg-white border border-rule-control rounded text-input text-ink placeholder:text-ink-placeholder';

  let control: React.ReactNode;

  /**
   * A Paragraphs widget's visible control is its "add another" type select, so it
   * renders as one when it has options. Falling through to a text input showed the
   * raw machine value (`contact_map`) in a box, which is worse than useless.
   */
  const kind = slotted
    // A relocated widget renders through its slot regardless of what it is made of.
    ? 'file'
    : field.kind === 'paragraphs' && field.options?.length
      ? 'select'
      : field.kind;

  switch (kind) {
    case 'checkbox':
      control = (
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            id={inputId}
            type="checkbox"
            checked={Boolean(value)}
            onChange={e => commit(e.target.checked)}
            className="mt-0.5 shrink-0"
          />
          <span className="text-control text-ink">{field.label}</span>
        </label>
      );
      break;

    case 'select':
      control = (
        <select
          id={inputId}
          value={String(value)}
          onChange={e => commit(e.target.value)}
          className={inputClass}
        >
          {field.options?.map(opt => (
            <option key={opt.value} value={opt.value}>
              {/* Non-breaking spaces preserve taxonomy depth inside <option>, which
                  cannot carry padding. */}
              {' '.repeat(opt.depth * 2)}{opt.label}
            </option>
          ))}
        </select>
      );
      break;

    case 'radioGroup':
      control = (
        <div className="flex flex-col gap-1">
          {field.options?.map(opt => (
            <label key={opt.value} className="flex items-center gap-2 px-2 py-1.5 border border-rule rounded cursor-pointer hover:bg-cu-tint transition-colors duration-200 ease-studio">
              <input
                type="radio"
                name={inputId}
                checked={String(value) === opt.value}
                onChange={() => commit(opt.value)}
                className="shrink-0"
              />
              <span className="text-control text-ink">{opt.label}</span>
            </label>
          ))}
        </div>
      );
      break;

    case 'checkboxGroup': {
      const selected = new Set(Array.isArray(value) ? value : []);
      control = (
        <div className="max-h-56 overflow-y-auto border border-rule rounded">
          {field.options?.map(opt => (
            <label
              key={opt.value}
              className="flex items-center gap-2 px-2 py-1 hover:bg-cu-tint cursor-pointer transition-colors duration-200 ease-studio"
              style={{ paddingLeft: 8 + opt.depth * 18 }}
            >
              <input
                type="checkbox"
                checked={selected.has(opt.value)}
                onChange={e => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(opt.value);
                  else next.delete(opt.value);
                  commit([...next]);
                }}
                className="shrink-0"
              />
              <span className="text-control text-ink">{opt.label}</span>
            </label>
          ))}
        </div>
      );
      break;
    }

    case 'paragraphs':
    case 'textarea':
      control = (
        <textarea
          id={inputId}
          value={String(value)}
          onChange={e => commit(e.target.value)}
          className={`${inputClass} min-h-[78px]`}
        />
      );
      break;

    case 'wysiwyg':
      control = (
        <textarea
          id={inputId}
          value={String(value)}
          onChange={e => commit(e.target.value)}
          className="w-full min-h-[300px] px-4 py-3 bg-white border border-rule-control rounded font-serif text-body-surface text-ink"
        />
      );
      break;

    case 'file':
      /**
       * Drupal's own widget, projected in through a slot — not a reimplementation.
       * It keeps its Browse button, media browser, thumbnail and Remove link because it
       * is the same element with the same handlers, still inside the form.
       *
       * The note is only the fallback for a widget whose wrapper could not be located.
       */
      control = slotted ? (
        <div className="d7-slot-host border border-rule rounded p-2 bg-white">
          <slot name={slotNameFor(field.machineName)} />
        </div>
      ) : (
        <div className="px-3 py-2 border border-dashed border-rule-control rounded text-help text-ink-help">
          Uploads use Drupal's own file widget. Use the underlying form for this field.
        </div>
      );
      break;

    case 'date':
      control = (
        <input
          id={inputId}
          type="text"
          value={String(value)}
          onChange={e => commit(e.target.value)}
          placeholder="month-day-year"
          className={inputClass}
        />
      );
      break;

    default:
      control = (
        <input
          id={inputId}
          type="text"
          value={String(value)}
          onChange={e => commit(e.target.value)}
          className={inputClass}
        />
      );
  }

  return (
    <div className={dense ? 'flex flex-col gap-1' : 'flex flex-col gap-1.5'}>
      {/* A relocated widget carries Drupal's own label, so ours would duplicate it. */}
      {field.kind !== 'checkbox' && !slotted && <FieldLabel field={field} htmlFor={inputId} />}
      {control}

      {field.help && !slotted && (
        <p className="text-help text-ink-help">{field.help}</p>
      )}

      {writeFailed && (
        <p className="flex items-start gap-1.5 text-help text-burnt">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          This value was not accepted by the underlying form field, so it will not be saved.
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
};
