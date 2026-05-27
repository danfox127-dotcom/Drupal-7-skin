import React, { useState } from 'react';
import { SortableTree, removeNodeAtPath } from '@nosferatu500/react-sortable-tree';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { GitBranch, ExternalLink, Trash2, Save, RefreshCw } from 'lucide-react';
import { flatToTree } from '../utils';

// Note: @nosferatu500 fork seems to handle styles differently or doesn't bundle a CSS file.
// We'll rely on our custom Tailwind styles.

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

export const MenuTree = ({ items: initialItems, onSave }: Props) => {
  const [treeData, setTreeData] = useState<any[]>(flatToTree(initialItems));

  const handleSave = () => {
    const flatten = (data: any[], depth = 0): MenuItem[] => {
      let result: MenuItem[] = [];
      data.forEach(node => {
        const { children, expanded, ...rest } = node;
        result.push({ ...rest, depth });
        if (children && children.length > 0) {
          result = result.concat(flatten(children, depth + 1));
        }
      });
      return result;
    };

    onSave(flatten(treeData));
  };

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="bg-white border border-slate-200 rounded-3xl shadow-2xl overflow-hidden font-sans flex flex-col h-[800px]">
        {/* Header */}
        <div className="bg-slate-900 p-6 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <div className="bg-indigo-500 p-2 rounded-xl">
              <GitBranch size={24} />
            </div>
            <div>
              <h2 className="text-xl font-black tracking-tight">Main Menu Manager</h2>
              <p className="text-slate-400 text-xs uppercase font-bold tracking-widest">Modern Proxy UI</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
             <button 
              className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition-all text-sm font-bold border border-slate-700"
              onClick={() => window.location.reload()}
            >
              <RefreshCw size={16} />
              Reset
            </button>
            <button 
              className="flex items-center gap-2 px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-lg transition-all text-sm font-bold"
              onClick={handleSave}
            >
              <Save size={16} />
              Save Changes
            </button>
          </div>
        </div>

        {/* Tree Area */}
        <div className="flex-1 bg-slate-50 overflow-hidden relative p-4">
          <SortableTree
            treeData={treeData}
            onChange={(data: any) => setTreeData(data)}
            canNodeHaveChildren={() => true}
            rowHeight={70}
            scaffoldBlockPxWidth={40}
            generateNodeProps={({ node, path }: any) => ({
              title: (
                <div className="flex items-center justify-between w-full group py-2">
                  <div className="flex flex-col">
                    <span className="font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">
                      {node.title}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono italic">
                      {node.path}
                    </span>
                  </div>
                </div>
              ),
              buttons: [
                <div className="flex items-center gap-1 pr-4">
                   <button className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all">
                    <ExternalLink size={16} />
                  </button>
                  <button 
                    className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                    onClick={() => {
                       setTreeData(removeNodeAtPath({
                        treeData,
                        path,
                        getNodeKey: ({ treeIndex }: any) => treeIndex,
                      }));
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ],
              className: 'modern-tree-node',
              style: {
                backgroundColor: 'white',
                borderRadius: '12px',
                border: '1px solid #e2e8f0',
                boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1)',
              }
            })}
          />
        </div>

        {/* Help Footer */}
        <div className="px-8 py-4 bg-white text-slate-400 text-[11px] text-center border-t border-slate-100 uppercase tracking-widest font-bold shrink-0">
          Drag nodes horizontally to change hierarchy • Drag vertically to reorder
        </div>
      </div>
      
      <style>{`
        .rst__tree {
          height: 100% !important;
        }
        .rst__row {
          padding-left: 0 !important;
        }
        .rst__rowContents {
          min-width: 300px !important;
          background-color: white !important;
          border-radius: 12px !important;
          border: 1px solid #e2e8f0 !important;
          box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1) !important;
          transition: all 0.2s !important;
        }
        .rst__rowContents:hover {
          border-color: #6366f1 !important;
          box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1) !important;
        }
        .rst__moveHandle {
          background: #f8fafc url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM5NGExYjAiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSI5IiBjeT0iMTIiIHI9IjEiPjwvY2lyY2xlPjxjaXJjbGUgY3g9IjkiIGN5PSI1IiByPSIxIj48L2NpcmNsZT48Y2lyY2xlIGN4PSI5IiBjeT0iMTkiIHI9IjEiPjwvY2lyY2xlPjxjaXJjbGUgY3g9IjE1IiBjeT0iMTIiIHI9IjEiPjwvY2lyY2xlPjxjaXJjbGUgY3g9IjE1IiBjeT0iNSIgcj0iMSI+PC9jaXJjbGU+PGNpcmNsZSBjeD0iMTUiIGN5PSIxOSIgcj0iMSI+PC9jaXJjbGU+PC9zdmc+') no-repeat center !important;
          border-right: 1px solid #e2e8f0 !important;
          width: 44px !important;
          border-radius: 12px 0 0 12px !important;
        }
        .rst__lineBlock {
          width: 40px !important;
        }
      `}</style>
    </DndProvider>
  );
};
