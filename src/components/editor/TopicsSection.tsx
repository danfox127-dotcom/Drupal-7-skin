import React, { useState, useMemo } from 'react';
import { X } from 'lucide-react';
import { FieldDescriptor } from '../../lib/formSchema';
import { readValue, writeValue } from '../../lib/fieldBinding';
import { FieldControl } from './FieldControl';

/**
 * Topics & Tags — replaces the 36-checkbox list plus the separate Primary Topic
 * select, per the handoff.
 *
 * The two are genuinely coupled: "First topic selected becomes the primary topic",
 * so choosing a topic here also writes the Primary Topic select. That coupling is the
 * reason this section is bespoke rather than a stack of generic controls.
 */

interface Props {
  /** The multi-select topics field. */
  topics: FieldDescriptor;
  /** The Primary Topic select, when the type has one. */
  primary?: FieldDescriptor;
  /** Tags autocomplete and anything else the topics rules claimed. */
  others: FieldDescriptor[];
  errorFor: (field: FieldDescriptor) => string | null;
}

export const TopicsSection = ({ topics, primary, others, errorFor }: Props) => {
  const [selected, setSelected] = useState<string[]>(() => {
    const value = readValue(topics);
    return Array.isArray(value) ? value : [];
  });
  const [query, setQuery] = useState('');

  const options = topics.options ?? [];
  const labelFor = useMemo(() => {
    const map = new Map(options.map(o => [o.value, o.label]));
    return (value: string) => map.get(value) ?? value;
  }, [options]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [options, query]);

  /**
   * Writes the topics field, and keeps Primary Topic pointed at the first selection.
   *
   * Order matters and is preserved: `selected` is an ordered list, so the primary
   * topic is the one chosen first, not the lowest term id.
   */
  const commit = (next: string[]) => {
    setSelected(next);
    writeValue(topics, next);

    if (primary) {
      const first = next[0];
      // Falls back to Drupal's "none" value when everything is deselected.
      const noneOption = primary.options?.find(o => /^_none$/i.test(o.value) || o.value === '');
      writeValue(primary, first ?? noneOption?.value ?? '');
    }
  };

  const toggle = (value: string) => {
    commit(selected.includes(value)
      ? selected.filter(v => v !== value)
      : [...selected, value]);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Selected values as removable chips, above the search. */}
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((value, index) => (
            <li key={value}>
              <span className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 bg-cu-tint border border-cu-light rounded text-help text-cu-blue">
                {index === 0 && (
                  <span className="text-eyebrow font-semibold uppercase text-cu-onLight">1st</span>
                )}
                {labelFor(value)}
                <button
                  type="button"
                  onClick={() => toggle(value)}
                  aria-label={`Remove ${labelFor(value)}`}
                  className="p-0.5 hover:text-cu-navy transition-colors duration-200 ease-studio"
                >
                  <X size={11} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={`Search ${options.length} topics`}
        className="w-full px-3 py-2 bg-white border border-rule-control rounded text-control text-ink placeholder:text-ink-placeholder"
      />

      <div className="max-h-56 overflow-y-auto border border-rule rounded">
        {visible.length === 0 ? (
          <p className="px-3 py-3 text-help text-ink-help">Nothing matches “{query}”.</p>
        ) : (
          visible.map(option => (
            <label
              key={option.value}
              className="flex items-center gap-2 px-2 py-1 hover:bg-cu-tint cursor-pointer transition-colors duration-200 ease-studio"
              style={{ paddingLeft: 8 + option.depth * 18 }}
            >
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={() => toggle(option.value)}
                className="shrink-0"
              />
              <span className="text-control text-ink">{option.label}</span>
            </label>
          ))
        )}
      </div>

      <p className="text-help text-ink-help">
        {selected.length} of {options.length} selected. First topic selected becomes the primary topic.
      </p>

      {errorFor(topics) && (
        <p className="text-help text-burnt font-semibold">{errorFor(topics)}</p>
      )}

      {/* Tags and anything else the topics rules claimed. */}
      {others.map(field => (
        <FieldControl key={field.machineName} field={field} dense error={errorFor(field)} />
      ))}
    </div>
  );
};
