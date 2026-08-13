import React, { useState, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { FieldDescriptor, FieldOption } from '../../lib/formSchema';
import { readValue, writeValue } from '../../lib/fieldBinding';
import { filterTreeRetainingAncestors, ancestorIndices } from '../../lib/treeFilter';
import { FieldControl } from './FieldControl';

/**
 * Menu Placement — an evolution of TaxonomyCombobox, per the handoff: keep its filter
 * behavior, add ancestor retention and a breadcrumb confirmation.
 *
 * Reuses the same `treeFilter` the menu manager uses, which is why that was built as
 * a shared utility: a parent-item filter that drops parents is the exact bug the menu
 * manager was designed to avoid, and it would be just as wrong here.
 */

interface Props {
  /** The `menu[parent]` select. */
  parent?: FieldDescriptor;
  /** Menu link title, "Provide a menu link", and anything else menu-related. */
  others: FieldDescriptor[];
  errorFor: (field: FieldDescriptor) => string | null;
}

/** Depth clamp for the parent picker, per the handoff (0–3 here, 0–5 in the manager). */
const MAX_PARENT_DEPTH = 3;

export const MenuSection = ({ parent, others, errorFor }: Props) => {
  const [value, setValue] = useState<string>(() => (parent ? String(readValue(parent)) : ''));
  const [query, setQuery] = useState('');

  const options = useMemo(
    () => (parent?.options ?? []).filter(o => o.depth <= MAX_PARENT_DEPTH),
    [parent]
  );

  const filtered = useMemo(
    () => filterTreeRetainingAncestors(options, query, o => o.label),
    [options, query]
  );

  /**
   * Breadcrumb for the current selection: "Will appear under About Us › Annual Report
   * › Dean's Message". Built from the same ancestor walk the filter uses, so the two
   * cannot disagree about who a parent is.
   */
  const breadcrumb = useMemo(() => {
    const index = options.findIndex(o => o.value === value);
    if (index === -1) return null;
    const chain = ancestorIndices(options, index).map(i => options[index === i ? index : i]);
    // ancestorIndices returns nearest-first; the trail reads outermost-first.
    return [...chain.reverse().map(o => o.label), options[index].label];
  }, [options, value]);

  const select = (option: FieldOption) => {
    setValue(option.value);
    if (parent) writeValue(parent, option.value);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Menu link title and the enable checkbox come first — they gate the rest. */}
      {others.map(field => (
        <FieldControl key={field.machineName} field={field} dense error={errorFor(field)} />
      ))}

      {parent && (
        <>
          <div className="flex flex-col gap-1.5">
            <label className="text-eyebrow font-semibold uppercase text-ink-secondary">
              {parent.label}
            </label>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Filter parent items"
              className="w-full px-3 py-2 bg-white border border-rule-control rounded text-control text-ink placeholder:text-ink-placeholder"
            />
          </div>

          <div className="max-h-[250px] overflow-y-auto border border-rule rounded">
            {filtered.items.length === 0 ? (
              <p className="px-3 py-3 text-help text-ink-help">Nothing matches “{query}”.</p>
            ) : (
              filtered.items.map(option => {
                const isSelected = option.value === value;
                // A row present only to preserve hierarchy is dimmed, so it reads as
                // context rather than a result.
                const isContext = !filtered.isMatch(option);
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => select(option)}
                    className={`w-full text-left px-2 py-1 text-control transition-colors duration-200 ease-studio ${
                      isSelected ? 'bg-cu-tint text-cu-blue font-semibold' : 'text-ink hover:bg-cu-tint'
                    } ${isContext ? 'opacity-60' : ''}`}
                    style={{ paddingLeft: 8 + option.depth * 18 }}
                  >
                    {option.label}
                  </button>
                );
              })
            )}
          </div>

          {breadcrumb && breadcrumb.length > 0 && (
            <p className="flex items-center flex-wrap gap-1 text-help text-ink-help">
              Will appear under
              {breadcrumb.map((crumb, i) => (
                <span key={`${crumb}-${i}`} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight size={10} className="text-ink-placeholder" />}
                  <span className="text-ink-secondary font-medium">{crumb}</span>
                </span>
              ))}
            </p>
          )}

          {errorFor(parent) && (
            <p className="text-help text-burnt font-semibold">{errorFor(parent)}</p>
          )}
        </>
      )}
    </div>
  );
};
