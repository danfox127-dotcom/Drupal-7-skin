import React, { useState, useCallback } from 'react';
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
import { GitBranch, ExternalLink, Trash2, Save, RefreshCw, GripVertical, ChevronRight, ArrowLeft, ArrowRight } from 'lucide-react';

export interface MenuItem {
  id: string;
  title: string;
  path: string;
  depth: number;
  enabled: boolean;
}

interface Props {
  items: MenuItem[];
  onSave: (items: MenuItem[]) => void;
}

interface SortableRowProps {
  item: MenuItem;
  onDepthChange: (id: string, delta: number) => void;
  onToggleEnabled: (id: string) => void;
  onDelete: (id: string) => void;
  maxDepth: number;
  isDragging?: boolean;
}

const INDENT_PX = 32;
const MAX_DEPTH = 5;

function SortableRow({ item, onDepthChange, onToggleEnabled, onDelete, isDragging }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isSorting } = useSortable({ id: item.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isSorting ? transition : undefined,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 px-3 py-2 border-b border-rule-faint group transition-colors duration-200 ease-studio ${
        item.enabled ? 'bg-white hover:bg-cu-tint' : 'bg-rail hover:bg-legacy-200'
      }`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-ink-muted hover:text-ink-secondary shrink-0 touch-none"
        tabIndex={-1}
        type="button"
      >
        <GripVertical size={18} />
      </button>

      {/* Indent controls */}
      <div className="flex items-center gap-1 shrink-0" style={{ marginLeft: item.depth * INDENT_PX }}>
        <button
          type="button"
          disabled={item.depth === 0}
          onClick={() => onDepthChange(item.id, -1)}
          className="text-ink-muted hover:text-cu-blue hover:bg-cu-tint disabled:opacity-20 disabled:cursor-not-allowed w-6.5 h-6.5 rounded flex items-center justify-center transition-colors duration-200 ease-studio"
          title="Decrease indent"
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          disabled={item.depth >= MAX_DEPTH}
          onClick={() => onDepthChange(item.id, 1)}
          className="text-ink-muted hover:text-cu-blue hover:bg-cu-tint disabled:opacity-20 disabled:cursor-not-allowed w-6.5 h-6.5 rounded flex items-center justify-center transition-colors duration-200 ease-studio"
          title="Increase indent"
        >
          <ArrowRight size={13} />
        </button>
      </div>

      {/* Hierarchy indicator */}
      {item.depth > 0 && (
        <ChevronRight size={12} className="text-ink-muted shrink-0" />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className={`font-medium text-row-title truncate ${item.enabled ? 'text-ink' : 'text-ink-placeholder'}`}>
          {item.title}
        </p>
        <p className="text-help text-ink-help font-mono truncate">{item.path}</p>
      </div>

      {/* Enabled toggle */}
      <label className="flex items-center gap-1.5 text-control text-ink-secondary cursor-pointer shrink-0 select-none">
        <div
          onClick={() => onToggleEnabled(item.id)}
          className={`w-8 h-4 rounded-full transition-colors duration-200 ease-studio relative ${item.enabled ? 'bg-olive' : 'bg-rule'}`}
        >
          <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform duration-200 ease-studio ${item.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </div>
      </label>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <a
          href={item.path}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1.5 text-ink-muted hover:text-cu-blue hover:bg-cu-tint rounded transition-colors duration-200 ease-studio"
          title="Open link"
        >
          <ExternalLink size={14} />
        </a>
        <button
          type="button"
          onClick={() => onDelete(item.id)}
          className="p-1.5 text-ink-muted hover:text-burnt hover:bg-cu-tint rounded transition-colors duration-200 ease-studio"
          title="Remove"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

export const MenuTree = ({ items: initialItems, onSave }: Props) => {
  const [items, setItems] = useState<MenuItem[]>(initialItems);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

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

  const handleToggleEnabled = useCallback((id: string) => {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, enabled: !item.enabled } : item
    ));
  }, []);

  const handleDelete = useCallback((id: string) => {
    setItems(prev => prev.filter(item => item.id !== id));
  }, []);

  const activeItem = activeId ? items.find(i => i.id === activeId) : null;

  return (
    <div className="bg-white border border-rule shadow-card overflow-hidden font-sans flex flex-col" style={{ maxHeight: '800px' }}>
      {/* Header */}
      <div className="bg-white border-b border-rule px-6 py-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <GitBranch size={20} className="text-cu-blue shrink-0" />
          <div>
            <h2 className="font-serif text-heading text-ink">Main Menu Manager</h2>
            <p className="text-eyebrow-wide text-ink-secondary uppercase font-semibold">Modern Proxy UI</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-2 px-3 py-1.5 bg-white hover:bg-cu-tint text-cu-blue border border-cu-blue rounded transition-colors duration-200 ease-studio text-control font-semibold"
            onClick={() => window.location.reload()}
          >
            <RefreshCw size={14} />
            Reset
          </button>
          <button
            type="button"
            className="flex items-center gap-2 px-5 py-1.5 bg-cu-blue hover:bg-cu-navy text-white rounded transition-colors duration-200 ease-studio text-control font-semibold"
            onClick={() => onSave(items)}
          >
            <Save size={14} />
            Save Changes
          </button>
        </div>
      </div>

      {/* Item count */}
      <div className="px-6 py-2 bg-rail border-b border-rule-hair shrink-0">
        <p className="text-help text-ink-help">{items.length} items · drag to reorder · arrows to change depth</p>
      </div>

      {/* Tree Area */}
      <div className="flex-1 overflow-y-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={items.map(i => i.id)} strategy={verticalListSortingStrategy}>
            {items.map(item => (
              <SortableRow
                key={item.id}
                item={item}
                onDepthChange={handleDepthChange}
                onToggleEnabled={handleToggleEnabled}
                onDelete={handleDelete}
                maxDepth={MAX_DEPTH}
                isDragging={item.id === activeId}
              />
            ))}
          </SortableContext>

          <DragOverlay>
            {activeItem && (
              <div className="flex items-center gap-2 px-3 py-2 bg-white border border-cu-blue shadow-card" style={{ marginLeft: activeItem.depth * INDENT_PX }}>
                <GripVertical size={18} className="text-cu-blue" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-ink text-row-title truncate">{activeItem.title}</p>
                  <p className="text-help text-ink-help font-mono truncate">{activeItem.path}</p>
                </div>
              </div>
            )}
          </DragOverlay>
        </DndContext>

        {items.length === 0 && (
          <div className="text-center py-12 text-ink-help text-control">
            All items removed. Reset to restore.
          </div>
        )}
      </div>
    </div>
  );
};
