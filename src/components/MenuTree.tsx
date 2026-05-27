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
import { GitBranch, ExternalLink, Trash2, Save, RefreshCw, GripVertical, ChevronRight } from 'lucide-react';

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
      className={`flex items-center gap-2 px-3 py-2.5 bg-white border border-slate-200 rounded-xl shadow-sm mb-2 group transition-shadow hover:border-indigo-300 hover:shadow-md ${isDragging ? '' : ''}`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 shrink-0 touch-none"
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
          className="text-[10px] font-mono text-slate-400 hover:text-indigo-600 disabled:opacity-20 disabled:cursor-not-allowed w-5 h-5 rounded hover:bg-indigo-50 flex items-center justify-center"
          title="Decrease indent"
        >
          ←
        </button>
        <button
          type="button"
          disabled={item.depth >= MAX_DEPTH}
          onClick={() => onDepthChange(item.id, 1)}
          className="text-[10px] font-mono text-slate-400 hover:text-indigo-600 disabled:opacity-20 disabled:cursor-not-allowed w-5 h-5 rounded hover:bg-indigo-50 flex items-center justify-center"
          title="Increase indent"
        >
          →
        </button>
      </div>

      {/* Hierarchy indicator */}
      {item.depth > 0 && (
        <ChevronRight size={12} className="text-slate-300 shrink-0" />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-slate-800 text-sm truncate group-hover:text-indigo-700 transition-colors">
          {item.title}
        </p>
        <p className="text-[10px] text-slate-400 font-mono truncate">{item.path}</p>
      </div>

      {/* Enabled toggle */}
      <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer shrink-0 select-none">
        <div
          onClick={() => onToggleEnabled(item.id)}
          className={`w-8 h-4 rounded-full transition-colors relative ${item.enabled ? 'bg-green-500' : 'bg-slate-300'}`}
        >
          <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${item.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </div>
      </label>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <a
          href={item.path}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all"
          title="Open link"
        >
          <ExternalLink size={14} />
        </a>
        <button
          type="button"
          onClick={() => onDelete(item.id)}
          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
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
    <div className="bg-white border border-slate-200 rounded-3xl shadow-2xl overflow-hidden font-sans flex flex-col" style={{ maxHeight: '800px' }}>
      {/* Header */}
      <div className="bg-slate-900 px-6 py-4 text-white flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-500 p-2 rounded-xl">
            <GitBranch size={20} />
          </div>
          <div>
            <h2 className="text-lg font-black tracking-tight">Main Menu Manager</h2>
            <p className="text-slate-400 text-[10px] uppercase font-bold tracking-widest">Modern Proxy UI</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition-all text-xs font-bold border border-slate-700"
            onClick={() => window.location.reload()}
          >
            <RefreshCw size={14} />
            Reset
          </button>
          <button
            type="button"
            className="flex items-center gap-2 px-5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-lg transition-all text-xs font-bold"
            onClick={() => onSave(items)}
          >
            <Save size={14} />
            Save Changes
          </button>
        </div>
      </div>

      {/* Item count */}
      <div className="px-6 py-2 bg-slate-50 border-b border-slate-100 shrink-0">
        <p className="text-[11px] text-slate-400 font-medium">{items.length} items · drag to reorder · ← → to change depth</p>
      </div>

      {/* Tree Area */}
      <div className="flex-1 overflow-y-auto p-4">
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
              <div className="flex items-center gap-2 px-3 py-2.5 bg-white border-2 border-indigo-400 rounded-xl shadow-xl opacity-90" style={{ marginLeft: activeItem.depth * INDENT_PX }}>
                <GripVertical size={18} className="text-indigo-400" />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-slate-800 text-sm truncate">{activeItem.title}</p>
                  <p className="text-[10px] text-slate-400 font-mono truncate">{activeItem.path}</p>
                </div>
              </div>
            )}
          </DragOverlay>
        </DndContext>

        {items.length === 0 && (
          <div className="text-center py-12 text-slate-400 text-sm italic">
            All items removed. Reset to restore.
          </div>
        )}
      </div>
    </div>
  );
};
