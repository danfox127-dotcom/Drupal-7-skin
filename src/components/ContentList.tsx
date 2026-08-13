import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Plus, Command } from 'lucide-react';
import { ContentRow, statusKind, statusLabel } from '../lib/parseContentList';
import { copyPublicHtml } from '../lib/extractPublicHtml';
import { Toast } from './Toast';

interface SavedView {
  id: string;
  label: string;
  matches: (row: ContentRow) => boolean;
}

interface Props {
  rows: ContentRow[];
  /** Username for the "My recent edits" view; the chip is hidden when null. */
  currentUser: string | null;
}

const STATUS_CLASS: Record<string, string> = {
  published: 'text-olive-text',
  draft: 'text-burnt',
  review: 'text-cu-blue',
  unknown: 'text-ink-help',
};

/** Row action button: small, outline, Columbia Blue. */
function RowAction({ label, onClick, href }: { label: string; onClick?: () => void; href?: string }) {
  const className =
    'px-2 py-1 rounded border border-rule-control text-help font-semibold text-ink hover:border-cu-blue hover:text-cu-blue hover:bg-cu-tint transition-colors duration-200 ease-studio whitespace-nowrap';

  if (href) {
    return <a href={href} className={className}>{label}</a>;
  }
  return <button type="button" onClick={onClick} className={className}>{label}</button>;
}

export const ContentList = ({ rows, currentUser }: Props) => {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [savedView, setSavedView] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Types come from the data, not a hardcoded list — the site has ten-plus content
  // types and more are coming.
  const types = useMemo(() => {
    const seen = new Set(rows.map(r => r.type).filter(Boolean));
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const savedViews = useMemo<SavedView[]>(() => {
    const views: SavedView[] = [];
    if (currentUser) {
      views.push({
        id: 'mine',
        label: 'My recent edits',
        matches: row => row.author === currentUser,
      });
    }
    views.push({
      id: 'drafts',
      label: 'Unpublished drafts',
      matches: row => statusKind(row.status) === 'draft',
    });
    views.push({
      id: 'review',
      label: 'Needs review',
      matches: row => statusKind(row.status) === 'review',
    });
    return views;
  }, [currentUser]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const view = savedViews.find(v => v.id === savedView);

    return rows.filter(row => {
      if (q && !row.title.toLowerCase().includes(q)) return false;
      if (typeFilter && row.type !== typeFilter) return false;
      if (view && !view.matches(row)) return false;
      return true;
    });
  }, [rows, query, typeFilter, savedView, savedViews]);

  // Keep the keyboard cursor in range as filters narrow the list.
  useEffect(() => {
    setCursor(prev => (prev >= visible.length ? 0 : prev));
  }, [visible.length]);

  const editHref = useCallback((row: ContentRow) => {
    if (!row.nodeId) return row.href;
    return `/node/${row.nodeId}/edit?destination=admin/content`;
  }, []);

  const handleCopyHtml = useCallback(async (row: ContentRow) => {
    if (!row.nodeId) {
      setToast('That row has no node id, so its public HTML cannot be fetched.');
      return;
    }
    try {
      // Same sanitizer as the node-edit button and the ⌘K command.
      await copyPublicHtml({
        origin: window.location.origin,
        pathname: `/node/${row.nodeId}`,
      } as Location);
      setToast(`Public HTML of “${row.title}” copied to the clipboard.`);
    } catch (err) {
      setToast(err instanceof Error ? `Could not copy: ${err.message}` : 'Could not copy.');
    }
  }, []);

  /**
   * J/K to move, ⏎ to edit.
   *
   * Bound on the document, not the container: a div is not focusable, so a React
   * onKeyDown on it never fires until something inside it has focus — the shortcuts
   * would silently require clicking a row first. The list is the page's main
   * content, so the keys should work on arrival.
   *
   * Three guards keep it from stealing keystrokes it has no business handling.
   */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 1. Never while a modifier is held — ⌘K belongs to the palette.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // 2. Never while the command palette is open. Its events retarget to the
      //    overlay host on the way to document, so checking the target's tag is
      //    not enough.
      if (document.querySelector('.d7-proxy-ui-overlay')) return;

      // 3. Never while typing. The target may be the shadow host, so read the
      //    composed path to find the real focused element.
      const path = e.composedPath();
      const typing = path.some(node => {
        const el = node as HTMLElement;
        if (!el?.tagName) return false;
        return el.tagName === 'INPUT'
          || el.tagName === 'TEXTAREA'
          || el.tagName === 'SELECT'
          || el.isContentEditable;
      });
      if (typing) return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor(i => (visible.length ? Math.min(i + 1, visible.length - 1) : 0));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        const row = visible[cursor];
        if (row) {
          e.preventDefault();
          window.location.href = editHref(row);
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, cursor, editHref]);

  useEffect(() => {
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-row-index="${cursor}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const GRID = '1fr 150px 130px 150px 210px';

  return (
    <div
      ref={containerRef}
      className="bg-white border border-rule font-sans mx-auto"
      style={{ maxWidth: '1440px' }}
    >
      {/* Header */}
      <div className="px-5.5 py-3 flex items-center gap-4 border-b border-rule">
        <h1 className="font-serif text-heading text-ink shrink-0">Content</h1>
        <span className="text-help text-ink-help shrink-0">
          {visible.length === rows.length
            ? `${rows.length} of ${rows.length} items`
            : `${visible.length} of ${rows.length} items`}
        </span>
        <div className="flex-1" />
        <span className="hidden sm:flex items-center gap-1 px-2 py-1 rounded border border-rule-control text-help text-ink-help">
          <Command size={11} />K
        </span>
        <a
          href="/node/add"
          className="shrink-0 flex items-center gap-1.5 px-4 py-1.5 bg-cu-blue hover:bg-cu-navy text-white rounded text-control font-semibold transition-colors duration-200 ease-studio"
        >
          <Plus size={14} />
          Add content
        </a>
      </div>

      {/* Search — filters apply as you type, no Apply button. */}
      <div className="px-5.5 pt-3">
        <input
          type="text"
          placeholder="Search titles — filters as you type, no Apply button"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="w-full px-3 py-2 bg-white border border-rule-control rounded text-input text-ink placeholder:text-ink-placeholder"
        />
      </div>

      {/* Type chips, then saved views behind a divider. */}
      <div className="px-5.5 py-3 flex items-center flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setTypeFilter(null)}
          className={`px-3 py-1 rounded border text-help font-semibold transition-colors duration-200 ease-studio ${
            typeFilter === null
              ? 'border-cu-blue bg-cu-tint text-cu-blue'
              : 'border-rule-control text-ink hover:bg-cu-tint hover:border-cu-blue hover:text-cu-blue'
          }`}
        >
          All types
        </button>

        {types.map(type => (
          <button
            key={type}
            type="button"
            onClick={() => setTypeFilter(type === typeFilter ? null : type)}
            className={`px-3 py-1 rounded border text-help font-semibold transition-colors duration-200 ease-studio ${
              typeFilter === type
                ? 'border-cu-blue bg-cu-tint text-cu-blue'
                : 'border-rule-control text-ink hover:bg-cu-tint hover:border-cu-blue hover:text-cu-blue'
            }`}
          >
            {type}
          </button>
        ))}

        <span className="w-px h-5 bg-rule mx-1 shrink-0" aria-hidden="true" />

        {savedViews.map(view => (
          <button
            key={view.id}
            type="button"
            onClick={() => setSavedView(view.id === savedView ? null : view.id)}
            className={`px-3 py-1 rounded border border-dashed text-help font-semibold transition-colors duration-200 ease-studio ${
              savedView === view.id
                ? 'border-cu-blue bg-cu-tint text-cu-blue'
                : 'border-rule-control text-ink hover:bg-cu-tint hover:border-cu-blue hover:text-cu-blue'
            }`}
          >
            {view.label}
          </button>
        ))}
      </div>

      {/* Table header */}
      <div
        className="grid gap-4 px-5.5 py-2 bg-rail border-y border-rule-hair text-eyebrow font-semibold uppercase text-ink-secondary"
        style={{ gridTemplateColumns: GRID }}
      >
        <span>Title</span>
        <span>Type</span>
        <span>Status</span>
        <span>Updated</span>
        <span />
      </div>

      {/* Rows */}
      {visible.length === 0 ? (
        <div className="px-5.5 py-12 text-center text-control text-ink-help">
          Nothing matches the current filters.
        </div>
      ) : (
        <ul>
          {visible.map((row, index) => (
            <li
              key={`${row.nodeId ?? row.href}-${index}`}
              data-row-index={index}
              // The keyboard cursor is the "current item in a set", which is what
              // aria-current denotes. It also gives tests a signal that does not
              // depend on class names, since hover: variants make the class string
              // an unreliable indicator.
              aria-current={index === cursor ? true : undefined}
              onMouseMove={() => setCursor(index)}
              className={`grid gap-4 items-center px-5.5 py-2.5 border-b border-rule-faint transition-colors duration-200 ease-studio ${
                index === cursor ? 'bg-cu-tint' : 'bg-white hover:bg-cu-tint'
              }`}
              style={{ gridTemplateColumns: GRID }}
            >
              <a href={row.href} className="text-cu-blue font-medium text-row-title truncate hover:underline">
                {row.title}
              </a>
              <span className="text-control text-ink-secondary truncate">{row.type || '—'}</span>
              <span className={`text-control font-medium ${STATUS_CLASS[statusKind(row.status)]}`}>
                {statusLabel(row.status)}
              </span>
              <span className="text-control text-ink-help truncate">{row.updated || '—'}</span>
              <span className="flex items-center gap-1.5 justify-end">
                <RowAction label="Edit" href={editHref(row)} />
                <RowAction label="View" href={row.href} />
                <RowAction label="Copy HTML" onClick={() => void handleCopyHtml(row)} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="px-5.5 py-2 border-t border-rule-hair">
        <p className="text-help text-ink-help">
          Row actions appear on every row instead of a bulk Operations dropdown.
          Filters apply live; keyboard: J/K to move, ⏎ to edit.
        </p>
      </div>

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
};
