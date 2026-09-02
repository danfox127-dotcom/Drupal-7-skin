import React, { useState, useMemo, useCallback } from 'react';
import { ChevronRight, ChevronUp, ChevronDown } from 'lucide-react';
import { FieldDescriptor, FieldOption } from '../../lib/formSchema';
import { readValue, writeValue } from '../../lib/fieldBinding';
import { filterTreeRetainingAncestors } from '../../lib/treeFilter';
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
  /**
   * The node's own Title, used to default the menu link title.
   *
   * Passed in rather than looked up here because it lives in a different section, and
   * because its machine name varies — a site running the Title module calls it
   * title_field, so only the label identifies it.
   */
  nodeTitle?: FieldDescriptor;
  errorFor: (field: FieldDescriptor) => string | null;
}

/**
 * Indent per level, in px.
 *
 * Smaller than the menu manager's 26px because the rail is only 451px wide and real
 * menus run deep — the live main menu nests Specialties › Cardiology & Cardiac Surgery ›
 * Our Services › Active BP Monitoring › Video Tutorial, which is five levels before you
 * reach a leaf.
 */
const INDENT_PX = 14;

/** Beyond this, extra levels stop adding indent so labels keep usable width. */
const MAX_VISUAL_DEPTH = 8;

/**
 * Above this many parents, nothing is listed until the editor types.
 *
 * Measured on the live Vagelos form: menu[parent] offers 3,149 options across two menus,
 * nested up to 16 levels. Rendering that many rows is both slow and useless — no one
 * scrolls three thousand items. Searching is the only sane entry point at that size.
 */
const SEARCH_FIRST_THRESHOLD = 150;

/** Never render more than this many rows at once, however broad the query. */
const MAX_RENDERED = 120;

/**
 * How many ancestors to name on a row.
 *
 * The rail is 451px and the live main menu nests 16 deep, so a full trail wraps to three
 * lines and buries the item you are trying to read. The nearest two are what disambiguate
 * — "Our Services" under Cardiology is a different thing from "Our Services" under
 * Radiology — and anything above that is signalled with a leading ellipsis.
 */
const TRAIL_SHOWN = 2;

export const MenuSection = ({ parent, others, nodeTitle, errorFor }: Props) => {
  const [value, setValue] = useState<string>(() => (parent ? String(readValue(parent)) : ''));
  const [query, setQuery] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Menu-attribute fields: real, but not what anyone opens this section for.
  const advancedOthers = useMemo(() => others.filter(f => f.advanced), [others]);

  /** The two controls a parent selection writes to, shown right under the picker. */
  const gating = useMemo(
    () => others.filter(f => !f.advanced
      && (f.machineName === 'menu[enabled]' || f.machineName === 'menu[link_title]')),
    [others]
  );
  /** Everything else non-advanced, including any fields a site has added of its own. */
  const otherPlain = useMemo(
    () => others.filter(f => !f.advanced
      && f.machineName !== 'menu[enabled]' && f.machineName !== 'menu[link_title]'),
    [others]
  );

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

  const ancestorsByValue = useMemo(() => {
    /**
     * One pass, not an ancestor walk per row.
     *
     * The select is in tree order, so the running trail indexed by depth IS the ancestry:
     * truncate it to the item's depth, and what remains are its ancestors. Calling
     * ancestorIndices per option instead is O(n²), and at 3,331 options that ran on every
     * keystroke once matching moved to the full path.
     */
    const trail: string[] = [];
    const map = new Map<string, string[]>();
    for (const option of options) {
      trail.length = option.depth;
      map.set(option.value, trail.slice(0, option.depth));
      trail[option.depth] = option.label;
    }
    return map;
  }, [options]);

  /**
   * Match against the whole path, not just the item's own title.
   *
   * Typing "gharavi" used to find only items with "gharavi" in their own name — the
   * Gharavi Lab menu root and one unrelated news item — while every page actually inside
   * that section stayed invisible, because none of them repeat the section's name. There
   * was no way to reach a child of a section you had just found.
   *
   * Menu roots are deliberately included in the path. On this site the thing you search
   * for IS often a root ("Gharavi Lab"), and it is what its descendants have in common.
   */
  const pathText = useCallback(
    (option: FieldOption) =>
      [...(ancestorsByValue.get(option.value) ?? []), option.label].join(' '),
    [ancestorsByValue]
  );

  const trailOf = useCallback((option: FieldOption): { labels: string[]; deeper: boolean } => {
    const chain = ancestorsByValue.get(option.value) ?? [];    // outermost first
    return {
      labels: chain.slice(-TRAIL_SHOWN),                       // nearest few
      deeper: chain.length > TRAIL_SHOWN,
    };
  }, [ancestorsByValue]);

  const filtered = useMemo(
    () => filterTreeRetainingAncestors(options, query, pathText),
    [options, query, pathText]
  );

  const searching = query.trim().length > 0;
  /** With a huge menu, an empty query lists nothing rather than everything. */
  const searchFirst = options.length > SEARCH_FIRST_THRESHOLD && !searching;
  const visible = useMemo(
    () => (searchFirst ? [] : filtered.items.slice(0, MAX_RENDERED)),
    [filtered.items, searchFirst]
  );
  const truncated = !searchFirst && filtered.items.length > visible.length;

  /**
   * Breadcrumb for the current selection: "Will appear under About Us › Annual Report
   * › Dean's Message". Built from the same ancestor walk the filter uses, so the two
   * cannot disagree about who a parent is.
   */
  const breadcrumb = useMemo(() => {
    const selected = options.find(o => o.value === value);
    if (!selected) return null;
    // Same ancestry map the filter and the row trails use, so the three cannot disagree
    // about who a parent is.
    return [...(ancestorsByValue.get(value) ?? []), selected.label];
  }, [options, value, ancestorsByValue]);

  /** Deepest level present, for the "N levels deep" hint. */
  const maxDepth = useMemo(
    () => options.reduce((deepest, o) => Math.max(deepest, o.depth), 0),
    [options]
  );

  /**
   * Matched on machine name, not label.
   *
   * These come from core's menu module, so `menu[enabled]` and `menu[link_title]` are
   * fixed — unlike a content type's own fields, whose names vary and whose labels are the
   * only stable handle. A label would also break under translation or a theme override.
   * (baseName is no use here: every menu control shares the base name `menu`.)
   */
  const enabled = useMemo(
    () => others.find(f => f.machineName === 'menu[enabled]'), [others]);
  const linkTitle = useMemo(
    () => others.find(f => f.machineName === 'menu[link_title]'), [others]);

  /**
   * Ancestor labels for one option, nearest last, capped at TRAIL_SHOWN.
   *
   * Indentation alone was not enough to tell rows apart: a search shows matches next to
   * dimmed ancestors, and once the list scrolls the parent rows leave the viewport, so a
   * row carrying only its own title gives no way to know which of six "Our Services" it
   * is. Built from the same ancestor walk as the breadcrumb and the filter, so the three
   * cannot disagree about who a parent is.
   */
  const select = (option: FieldOption) => {
    setValue(option.value);
    if (parent) writeValue(parent, option.value);

    /**
     * Choosing a parent IS placing the node in the menu, so enable the link.
     *
     * Drupal 7 gates the entire menu fieldset on menu[enabled] — "Provide a menu link",
     * unchecked by default and captioned "Not in menu". With it unchecked,
     * menu_node_save() discards the parent and the title, so a placement chosen here
     * vanished on save with nothing reported. Writing the parent alone was setting a
     * value Drupal had already decided to ignore.
     */
    if (enabled && readValue(enabled) !== true) writeValue(enabled, true);

    /**
     * And a link title, which Drupal requires once the link is enabled.
     *
     * Without this, fixing the checkbox alone would trade silent loss for a validation
     * error on save. The node's own title is what an editor would type, and it stays
     * editable in the field above.
     */
    if (linkTitle && nodeTitle && !String(readValue(linkTitle)).trim()) {
      const title = String(readValue(nodeTitle)).trim();
      if (title) writeValue(linkTitle, title);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/*
        The picker leads, then the two controls it writes to, then anything else.

        Marking core's menu-attribute fields advanced was supposed to keep them from
        burying the picker, and it does — but a site can add its own non-advanced menu
        fields, and Vagelos has two ("Menu modal: NID", "Link tooltip"). That pushed the
        placement control to fifth in a section called Menu Placement, below the fold of
        the panel, where an editor never saw it.

        "Provide a menu link" and the link title sit directly beneath the picker rather
        than above it, so the values selecting a parent writes appear where the click
        happened.
      */}
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
            {searchFirst ? (
              <p className="px-3 py-3 text-help text-ink-help">
                Type above to search {options.length.toLocaleString()} possible parents.
              </p>
            ) : filtered.items.length === 0 ? (
              <p className="px-3 py-3 text-help text-ink-help">Nothing matches “{query}”.</p>
            ) : (
              visible.map(option => {
                const isSelected = option.value === value;
                // A row present only to preserve hierarchy is dimmed, so it reads as
                // context rather than a result.
                const isContext = !filtered.isMatch(option);
                // Only real results carry a trail. A dimmed context row IS an ancestor,
                // so restating its own lineage would be noise on the rows that need it least.
                const trail = isContext ? { labels: [], deeper: false } : trailOf(option);
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => select(option)}
                    data-parent-option={option.value}
                    className={`w-full text-left px-2 py-1 text-control transition-colors duration-200 ease-studio ${
                      isSelected ? 'bg-cu-tint text-cu-blue font-semibold' : 'text-ink hover:bg-cu-tint'
                    } ${isContext ? 'opacity-60' : ''}`}
                    style={{ paddingLeft: 8 + Math.min(option.depth, MAX_VISUAL_DEPTH) * INDENT_PX }}
                  >
                    <span data-parent-label className="block">{option.label}</span>
                    {trail.labels.length > 0 && (
                      <span data-parent-trail className="block text-help text-ink-help truncate">
                        in {trail.deeper ? '… › ' : ''}{trail.labels.join(' › ')}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>

          <p className="text-help text-ink-help">
            {/* Not searching: state the size and depth of the menu, whether or not it is
                big enough to withhold the list. Searching: report the match count. */}
            {!searching
              ? `${options.length.toLocaleString()} possible parents, ${maxDepth + 1} levels deep.`
              : truncated
                ? `Showing ${visible.length} of ${filtered.items.length} rows for ${filtered.matchCount} match${filtered.matchCount === 1 ? '' : 'es'} — keep typing to narrow.`
                : `${filtered.matchCount} of ${options.length.toLocaleString()} match. Parents are kept visible for context.`}
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


      {gating.map(field => (
        <FieldControl key={field.machineName} field={field} dense error={errorFor(field)} />
      ))}

      {otherPlain.map(field => (
        <FieldControl key={field.machineName} field={field} dense error={errorFor(field)} />
      ))}

      {advancedOthers.length > 0 && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowAdvanced(v => !v)}
            aria-expanded={showAdvanced}
            className="self-start flex items-center gap-1.5 text-help font-semibold text-cu-blue hover:underline"
          >
            {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {showAdvanced
              ? `Hide ${advancedOthers.length} rarely-used fields`
              : `Show ${advancedOthers.length} rarely-used fields`}
          </button>
          {showAdvanced && (
            <div data-advanced-fields="menu" className="flex flex-col gap-3 pl-2 border-l-2 border-rule">
              {advancedOthers.map(field => (
                <FieldControl key={field.machineName} field={field} dense error={errorFor(field)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
