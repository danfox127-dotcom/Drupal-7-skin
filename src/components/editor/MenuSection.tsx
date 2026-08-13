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

/**
 * Indent per level, in px.
 *
 * Smaller than the menu manager's 26px because the rail is only 392px wide and real
 * menus run deep — the live main menu nests Specialties › Cardiology & Cardiac Surgery ›
 * Our Services › Active BP Monitoring › Video Tutorial, which is five levels before you
 * reach a leaf.
 */
const INDENT_PX = 14;

/** Beyond this, extra levels stop adding indent so labels keep usable width. */
const MAX_VISUAL_DEPTH = 8;

export const MenuSection = ({ parent, others, errorFor }: Props) => {
  const [value, setValue] = useState<string>(() => (parent ? String(readValue(parent)) : ''));
  const [query, setQuery] = useState('');

  /**
   * EVERY option Drupal offers, at any depth.
   *
   * This previously filtered to depth <= 3, which silently removed most of the menu from
   * the picker — only top-level items and their immediate children could be chosen. On
   * the live main menu that excludes almost everything worth selecting.
   *
   * Filtering by depth was the wrong idea at any number: Drupal's `menu[parent]` select
   * already contains exactly the legal parents, having excluded anything that would push
   * the tree past MENU_MAX_DEPTH. Second-guessing that list can only remove valid
   * choices.
   */
  const options = useMemo(() => parent?.options ?? [], [parent]);

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

  /** Deepest level present, for the "N levels deep" hint. */
  const maxDepth = useMemo(
    () => options.reduce((deepest, o) => Math.max(deepest, o.depth), 0),
    [options]
  );

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
                    style={{ paddingLeft: 8 + Math.min(option.depth, MAX_VISUAL_DEPTH) * INDENT_PX }}
                  >
                    {option.label}
                  </button>
                );
              })
            )}
          </div>

          <p className="text-help text-ink-help">
            {filtered.items.length === options.length
              ? `${options.length} possible parents, ${maxDepth + 1} levels deep.`
              : `${filtered.matchCount} of ${options.length} match. Parents are kept visible for context.`}
          </p>

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
