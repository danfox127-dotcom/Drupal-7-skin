import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Search, RefreshCw, AlertCircle, ChevronRight } from 'lucide-react';
import {
  MenuIndexItem, searchMenuIndex, countMenuMatches, menuItemEditUrl,
} from '../lib/menuIndex';

/**
 * Search across a whole menu, on a page that renders almost none of it.
 *
 * This sits ABOVE Drupal's own table and leaves it alone. That is the point: on a BigMenu
 * menu the native table is faster than anything reimplemented over it, and it already does
 * expand-in-place well. What it has never had is a way to find one item among 3,000 without
 * clicking down through the tree guessing which branch it is in.
 *
 * The index comes from the menu's parent-link select, which Drupal builds from the full tree
 * regardless of BigMenu — so this costs ONE request, not one per subtree.
 */

interface Props {
  menuName: string;
  /** Null while loading; an empty array means the source page had no parent select. */
  items: MenuIndexItem[] | null;
  error?: string | null;
  fetchedAt?: number | null;
  onRefresh: () => void;
}

const RESULT_LIMIT = 50;

const ageOf = (fetchedAt: number, now: number): string => {
  const seconds = Math.round((now - fetchedAt) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export const MenuSearch = ({ menuName, items, error, fetchedAt, onRefresh }: Props) => {
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const results = useMemo(
    () => (items ? searchMenuIndex(items, query, RESULT_LIMIT) : []),
    [items, query]
  );
  const total = useMemo(
    () => (items ? countMenuMatches(items, query) : 0),
    [items, query]
  );

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') setQuery('');
  }, []);

  return (
    <div className="mb-4 bg-white border border-rule font-sans">
      <div className="px-4 py-3 border-b border-rule-hair flex items-center gap-3 flex-wrap">
        <span className="text-eyebrow-wide font-semibold uppercase text-ink-secondary shrink-0">
          Search this menu
        </span>

        <div className="relative flex-1 min-w-[220px]">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!items || items.length === 0}
            placeholder={
              items === null
                ? 'Building the index…'
                : `Find any of the ${items.length} items in ${menuName}`
            }
            aria-label="Search this menu"
            className="w-full pl-8 pr-3 py-1.5 bg-white border border-rule-control rounded text-control text-ink placeholder:text-ink-placeholder disabled:bg-legacy-200"
          />
        </div>

        <span className="text-help text-ink-help shrink-0">
          {items === null
            ? 'reading the full menu from its parent list'
            : `${items.length} items${fetchedAt ? ` · indexed ${ageOf(fetchedAt, now)}` : ''}`}
        </span>

        <button
          type="button"
          onClick={onRefresh}
          title="Rebuild the index"
          className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-rule-control rounded text-help font-semibold text-ink hover:bg-legacy-200 transition-colors duration-200 ease-studio"
        >
          <RefreshCw size={12} className={items === null ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 flex items-start gap-2.5 bg-white border-b border-rule-hair">
          <AlertCircle size={15} className="text-burnt mt-0.5 shrink-0" />
          <div>
            <p className="text-control text-ink">{error}</p>
            <p className="text-help text-ink-help mt-0.5">
              Drupal’s own table below is untouched, so nothing here has stopped working.
            </p>
          </div>
        </div>
      )}

      {items !== null && items.length === 0 && !error && (
        <p className="px-4 py-3 text-help text-ink-help">
          No parent list was found on this menu’s add-link form, so there is nothing to
          search. Drupal’s table below is unaffected.
        </p>
      )}

      {query.trim() !== '' && (
        <div data-menu-search-results>
          <p className="px-4 py-2 text-help text-ink-help border-b border-rule-hair">
            {total === 0
              ? `Nothing in ${menuName} matches “${query}”.`
              : total > results.length
                ? `Showing ${results.length} of ${total} matches — narrow the search to see the rest.`
                : `${total} match${total === 1 ? '' : 'es'}`}
          </p>

          <ul className="max-h-[420px] overflow-y-auto">
            {results.map(item => (
              <li key={item.mlid} className="border-b border-rule-faint last:border-b-0">
                <a
                  href={menuItemEditUrl(item.mlid)}
                  data-result={item.mlid}
                  className="flex items-baseline gap-2 px-4 py-2 hover:bg-cu-tint transition-colors duration-200 ease-studio"
                >
                  <span className="font-medium text-row-title text-ink shrink-0">
                    {item.title}
                  </span>
                  {item.ancestors.length > 0 && (
                    <span className="flex items-center gap-1 text-help text-ink-help min-w-0">
                      {item.ancestors.map((ancestor, i) => (
                        <React.Fragment key={i}>
                          <ChevronRight size={10} className="shrink-0 text-ink-muted" />
                          <span className="truncate">{ancestor}</span>
                        </React.Fragment>
                      ))}
                    </span>
                  )}
                  <span className="flex-1" />
                  <span className="shrink-0 text-help font-semibold text-cu-blue">Edit</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="px-4 py-2 text-help text-ink-help border-t border-rule-hair">
        Searches every item in the menu, including the ones Drupal has not loaded below.
        Opening a result goes straight to that item’s edit form.
      </p>
    </div>
  );
};
