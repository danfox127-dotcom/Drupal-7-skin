import React, { useState, useCallback, useMemo } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GripVertical, ArrowLeft, ArrowRight, ArrowUp, ArrowDown,
} from 'lucide-react';
import { filterTreeRetainingAncestors } from '../lib/treeFilter';

export interface MenuItem {
  id: string;
  title: string;
  path: string;
  depth: number;
  enabled: boolean;
}

/** A collapsed subtree that lives on another page, so its rows are not in this form. */
export interface UnreachableSubtree {
  label: string;
  href: string;
  /** True when the link expands the subtree in Drupal's own table instead of navigating. */
  expandsInDrupal?: boolean;
}

interface Props {
  items: MenuItem[];
  onSave: (items: MenuItem[]) => void;
  /**
   * Subtrees Drupal collapsed behind a link to a DIFFERENT page.
   *
   * Listed rather than loaded. Saving writes weights and plids into this form's own
   * inputs, and rows fetched from another page have none — so mixing them into the tree
   * would show them as editable while silently dropping every change made to them.
   *
   * NOT for on-demand subtrees: those are expandable per row now. Listing them here as
   * well produced a panel of nine links repeating the nine rows above it, which was worse
   * than saying nothing.
   */
  unreachable?: UnreachableSubtree[];
}

/** 26px per depth level, and 26px square row controls, per the handoff. */
const INDENT_PX = 26;
/**
 * Drupal's MENU_MAX_DEPTH is 9, i.e. depths 0–8.
 *
 * This was 5, which is below what the live main menu already uses — Specialties ›
 * Cardiology › Our Services › Active BP Monitoring › Video Tutorial reaches depth 4, and
 * clamping at 5 would block legitimate nesting one level further down.
 */
const MAX_DEPTH = 8;

/** A row control: 26px square, icon-only, Columbia Blue on hover. */
function RowControl({
  label, disabled, onClick, children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="w-6.5 h-6.5 shrink-0 flex items-center justify-center rounded text-ink-muted hover:text-cu-blue hover:bg-cu-tint disabled:opacity-20 disabled:cursor-not-allowed transition-colors duration-200 ease-studio"
    >
      {children}
    </button>
  );
}

interface SortableRowProps {
  item: MenuItem;
  isMatch: boolean;
  dragDisabled: boolean;
  onDepthChange: (id: string, delta: number) => void;
  onMove: (id: string, delta: number) => void;
  onToggleEnabled: (id: string) => void;
  isDragging?: boolean;
}

function SortableRow({
  item, isMatch, dragDisabled, onDepthChange, onMove, onToggleEnabled, isDragging,
}: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isSorting } =
    useSortable({ id: item.id, disabled: dragDisabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isSorting ? transition : undefined,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-menu-row={item.id}
      className={`flex items-center gap-2 px-2.5 py-2 border-b border-rule-faint transition-colors duration-200 ease-studio ${
        item.enabled ? 'bg-white hover:bg-cu-tint' : 'bg-rail hover:bg-legacy-200'
      } ${isMatch ? '' : 'opacity-60'}`}
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        tabIndex={-1}
        disabled={dragDisabled}
        title={dragDisabled ? 'Clear the filter to reorder by dragging' : 'Drag to reorder'}
        className="shrink-0 touch-none text-ink-muted hover:text-ink-secondary disabled:opacity-20 disabled:cursor-not-allowed cursor-grab active:cursor-grabbing"
      >
        <GripVertical size={16} />
      </button>

      <div className="flex-1 min-w-0 flex items-baseline gap-3" style={{ paddingLeft: item.depth * INDENT_PX }}>
        <span className={`font-medium text-row-title truncate ${item.enabled ? 'text-ink' : 'text-ink-placeholder'}`}>
          {item.title}
        </span>
        <span className="shrink-0 font-mono text-help text-ink-help truncate">{item.path}</span>

      </div>

      {/* Five controls, in the handoff's order: outdent, indent, up, down, enabled. */}
      <RowControl label="Outdent" disabled={item.depth === 0} onClick={() => onDepthChange(item.id, -1)}>
        <ArrowLeft size={13} />
      </RowControl>
      <RowControl label="Indent" disabled={item.depth >= MAX_DEPTH} onClick={() => onDepthChange(item.id, 1)}>
        <ArrowRight size={13} />
      </RowControl>
      <RowControl label="Move up" onClick={() => onMove(item.id, -1)}>
        <ArrowUp size={13} />
      </RowControl>
      <RowControl label="Move down" onClick={() => onMove(item.id, 1)}>
        <ArrowDown size={13} />
      </RowControl>

      <button
        type="button"
        onClick={() => onToggleEnabled(item.id)}
        aria-pressed={item.enabled}
        className={`shrink-0 px-2 h-6.5 rounded border text-help font-semibold transition-colors duration-200 ease-studio ${
          item.enabled
            ? 'border-cu-blue text-cu-blue hover:bg-cu-tint'
            : 'border-rule-control text-ink-help hover:bg-legacy-200'
        }`}
      >
        {item.enabled ? 'Enabled' : 'Disabled'}
      </button>
    </div>
  );
}

/** How many rows differ from the parsed original in order, depth, or enabled state. */
export function countChanges(current: MenuItem[], original: MenuItem[]): number {
  const originalIndex = new Map(original.map((item, i) => [item.id, i]));
  let changes = 0;

  current.forEach((item, index) => {
    const before = original.find(o => o.id === item.id);
    if (!before) { changes++; return; }
    if (originalIndex.get(item.id) !== index) { changes++; return; }
    if (before.depth !== item.depth || before.enabled !== item.enabled) changes++;
  });

  return changes;
}

export const MenuTree = ({ items: initialItems, onSave, unreachable = [] }: Props) => {
  // The parsed original, kept for Revert and for the dirty count.
  const [original] = useState<MenuItem[]>(initialItems);
  const [items, setItems] = useState<MenuItem[]>(initialItems);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const filtered = useMemo(
    () => filterTreeRetainingAncestors(items, query, i => `${i.title} ${i.path}`),
    [items, query]
  );

  // Reordering a filtered subset cannot be mapped back to the full list
  // unambiguously, so dragging is disabled while a filter is active. The up/down
  // controls stay available because they act on full-list adjacency, which is
  // well defined either way.
  const dragDisabled = query.trim().length > 0;

  const dirtyCount = useMemo(() => countChanges(items, original), [items, original]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    setItems(prev => {
      const oldIndex = prev.findIndex(i => i.id === active.id);
      const newIndex = prev.findIndex(i => i.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  const handleDepthChange = useCallback((id: string, delta: number) => {
    setItems(prev => prev.map(item =>
      item.id === id
        ? { ...item, depth: Math.max(0, Math.min(MAX_DEPTH, item.depth + delta)) }
        : item
    ));
  }, []);

  /** Swap with the adjacent row in the full list. */
  const handleMove = useCallback((id: string, delta: number) => {
    setItems(prev => {
      const index = prev.findIndex(i => i.id === id);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= prev.length) return prev;
      return arrayMove(prev, index, target);
    });
  }, []);

  const handleToggleEnabled = useCallback((id: string) => {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, enabled: !item.enabled } : item
    ));
  }, []);

  const handleRevert = useCallback(() => {
    setItems(original);
    setQuery('');
  }, [original]);

  const activeItem = activeId ? items.find(i => i.id === activeId) : null;

  return (
    <div className="bg-white border border-rule font-sans flex flex-col mx-auto" style={{ maxWidth: '1060px', maxHeight: '800px' }}>
      {/* Sticky action bar */}
      <div className="sticky top-0 z-10 bg-white border-b border-rule px-5.5 py-3 flex items-center gap-4 shrink-0">
        <h2 className="font-serif text-heading text-ink shrink-0">Main Menu</h2>
        <span className="text-help text-ink-help shrink-0">{items.length} items</span>

        <input
          type="text"
          placeholder="Filter menu items"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="w-56 px-3 py-1.5 bg-white border border-rule-control rounded text-control text-ink placeholder:text-ink-placeholder"
        />

        <div className="flex-1" />

        <span className={`text-help shrink-0 ${dirtyCount > 0 ? 'text-burnt font-semibold' : 'text-ink-help'}`}>
          {dirtyCount === 0
            ? 'No changes'
            : `${dirtyCount} change${dirtyCount === 1 ? '' : 's'}`}
        </span>

        <button
          type="button"
          onClick={handleRevert}
          disabled={dirtyCount === 0}
          className="shrink-0 px-3 py-1.5 bg-white border border-cu-blue text-cu-blue rounded text-control font-semibold hover:bg-cu-tint disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-200 ease-studio"
        >
          Revert
        </button>
        <button
          type="button"
          onClick={() => onSave(items)}
          className="shrink-0 px-4 py-1.5 bg-cu-blue hover:bg-cu-navy text-white rounded text-control font-semibold transition-colors duration-200 ease-studio"
        >
          Save menu
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={filtered.items.map(i => i.id)} strategy={verticalListSortingStrategy}>
            {filtered.items.map(item => (
              <SortableRow
                key={item.id}
                item={item}
                isMatch={filtered.isMatch(item)}
                dragDisabled={dragDisabled}
                onDepthChange={handleDepthChange}
                onMove={handleMove}
                onToggleEnabled={handleToggleEnabled}
                isDragging={item.id === activeId}
              />
            ))}
          </SortableContext>

          <DragOverlay>
            {activeItem && (
              <div className="flex items-center gap-2 px-2.5 py-2 bg-white border border-cu-blue shadow-card">
                <GripVertical size={16} className="text-cu-blue" />
                <div className="flex-1 min-w-0" style={{ paddingLeft: activeItem.depth * INDENT_PX }}>
                  <span className="font-medium text-ink text-row-title truncate">{activeItem.title}</span>
                </div>
              </div>
            )}
          </DragOverlay>
        </DndContext>

        {filtered.items.length === 0 && (
          <div className="text-center py-12 text-control text-ink-help">
            {query.trim()
              ? `Nothing matches “${query}”.`
              : 'All items removed. Revert to restore.'}
          </div>
        )}
      </div>

      {unreachable.length > 0 && (
        <div data-unreachable-subtrees className="px-5.5 py-3 border-t border-rule bg-cu-tint shrink-0">
          <p className="text-eyebrow font-semibold uppercase text-cu-onLight">
            {unreachable.length} subtree{unreachable.length === 1 ? '' : 's'} not shown here
          </p>
          <p className="text-help text-ink mt-0.5">
            {unreachable.some(s => s.expandsInDrupal)
              ? 'Drupal loads these on demand, because this menu is too large to render at '
                + 'once. Expanding them all here would mean thousands of requests, so each is '
                + 'linked instead — the link opens it in Drupal\u2019s own table.'
              : 'Drupal keeps these on their own page. Reordering here writes into this form, '
                + 'which those rows are not part of, so they are linked rather than mixed in — '
                + 'a change made to them here could not be saved.'}
          </p>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {unreachable.map(subtree => (
              <li key={subtree.href}>
                <a
                  href={subtree.href}
                  className="text-control text-cu-blue hover:underline"
                >
                  {subtree.label || subtree.href}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="px-5.5 py-2 border-t border-rule-hair shrink-0">
        <p className="text-help text-ink-help">
          {dragDisabled
            ? 'Filtering keeps parents visible so you never lose your place. Clear the filter to reorder by dragging.'
            : 'Filtering keeps parents visible so you never lose your place. Weights and parent ids are written back on save.'}
        </p>
      </div>
    </div>
  );
};
