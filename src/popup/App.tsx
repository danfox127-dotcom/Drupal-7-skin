import React, { useEffect, useState } from 'react';
import {
  LayoutList, FilePlus, GitBranch, Tags, Users, Settings,
  ExternalLink, Layers, ToggleLeft, ToggleRight, Wifi, WifiOff,
} from 'lucide-react';
import { useSettings } from './useSettings';

interface QuickLink {
  label: string;
  path: string;
  icon: React.ReactNode;
}

const QUICK_LINKS: QuickLink[] = [
  { label: 'All Content',   path: '/admin/content',                              icon: <LayoutList size={14} /> },
  { label: 'Add Content',   path: '/node/add',                                   icon: <FilePlus size={14} /> },
  { label: 'Main Menu',     path: '/admin/structure/menu/manage/main-menu',      icon: <GitBranch size={14} /> },
  { label: 'Taxonomy',      path: '/admin/structure/taxonomy',                   icon: <Tags size={14} /> },
  { label: 'Users',         path: '/admin/people',                               icon: <Users size={14} /> },
  { label: 'Configuration', path: '/admin/config',                               icon: <Settings size={14} /> },
];

interface Feature {
  key: 'combobox' | 'htmlExport' | 'menuTree';
  label: string;
  description: string;
}

const FEATURES: Feature[] = [
  { key: 'combobox',    label: 'Menu Parent Combobox', description: 'Searchable dropdown on node edit forms' },
  { key: 'htmlExport',  label: 'HTML Content Export',  description: 'Copy sanitized public HTML from node edit pages' },
  { key: 'menuTree',    label: 'Menu Tree Manager',    description: 'Drag-and-drop tree on main menu admin page' },
];

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${on ? 'bg-indigo-500' : 'bg-slate-300'}`}
    >
      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

export function App() {
  const [tabOrigin, setTabOrigin] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(false);
  const { settings, update, loaded } = useSettings();

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.url) return;
      try {
        const url = new URL(tab.url);
        setTabOrigin(url.origin);
        // Active if the tab URL matches our host_permissions pattern
        setIsActive(tab.url.includes('/admin/') || tab.url.includes('/node/'));
      } catch {
        // non-URL tab (e.g. chrome://)
      }
    });
  }, []);

  const openLink = (path: string) => {
    if (!tabOrigin) return;
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) {
        chrome.tabs.update(tab.id, { url: tabOrigin + path });
      }
    });
  };

  const displayOrigin = tabOrigin
    ? tabOrigin.replace(/^https?:\/\//, '')
    : null;

  return (
    <div className="w-72 bg-white flex flex-col font-sans text-slate-800 divide-y divide-slate-100">
      {/* Header */}
      <div className="px-4 py-3 bg-slate-900 text-white flex items-center gap-3">
        <div className="bg-indigo-500 p-1.5 rounded-lg shrink-0">
          <Layers size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-black text-sm tracking-tight">D7 Admin Proxy</p>
          {displayOrigin ? (
            <div className="flex items-center gap-1.5 mt-0.5">
              {isActive
                ? <Wifi size={10} className="text-green-400 shrink-0" />
                : <WifiOff size={10} className="text-slate-500 shrink-0" />}
              <p className="text-[10px] truncate font-medium text-slate-400">
                {isActive ? (
                  <span><span className="text-green-400">Active</span> · {displayOrigin}</span>
                ) : (
                  <span className="text-slate-500">{displayOrigin} · navigate to an admin page</span>
                )}
              </p>
            </div>
          ) : (
            <p className="text-[10px] text-slate-500 mt-0.5">No Drupal tab detected</p>
          )}
        </div>
      </div>

      {/* Quick Links */}
      <div>
        <p className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
          Quick Links
        </p>
        <ul className="pb-2">
          {QUICK_LINKS.map(link => (
            <li key={link.path}>
              <button
                type="button"
                disabled={!tabOrigin}
                onClick={() => openLink(link.path)}
                className="w-full flex items-center gap-3 px-4 py-1.5 text-sm text-slate-700 hover:bg-indigo-50 hover:text-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-left group"
              >
                <span className="text-slate-400 group-hover:text-indigo-500 transition-colors shrink-0">
                  {link.icon}
                </span>
                <span className="flex-1">{link.label}</span>
                <ExternalLink size={11} className="text-slate-300 group-hover:text-indigo-400 transition-colors shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Feature Toggles */}
      <div className="pb-3">
        <p className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
          Features
        </p>
        {!loaded ? (
          <div className="px-4 py-2 text-xs text-slate-400 italic">Loading…</div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {FEATURES.map(f => (
              <li key={f.key} className="flex items-center gap-3 px-4 py-2 hover:bg-slate-50 transition-colors rounded-lg mx-1">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-700">{f.label}</p>
                  <p className="text-[10px] text-slate-400 truncate">{f.description}</p>
                </div>
                <Toggle on={settings[f.key]} onChange={v => update(f.key, v)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 flex items-center justify-between">
        <span className="text-[9px] text-slate-300 uppercase tracking-widest font-bold">v0.1.0</span>
        <span className="text-[9px] text-slate-300 uppercase tracking-widest font-bold">columbiadoctors.org</span>
      </div>
    </div>
  );
}
