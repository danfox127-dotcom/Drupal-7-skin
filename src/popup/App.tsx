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
      className={`w-9 h-5 rounded-full transition-colors duration-200 ease-studio relative shrink-0 ${on ? 'bg-cu-blue' : 'bg-rule'}`}
    >
      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-studio ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
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
    <div className="w-80 bg-white flex flex-col font-sans text-ink divide-y divide-rule-faint">
      {/* Header */}
      <div className="px-4 py-3 bg-cu-blue text-white flex items-center gap-3">
        <Layers size={18} className="shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-display font-semibold text-control uppercase tracking-[.12em]">D7 Studio</p>
          {displayOrigin ? (
            <div className="flex items-center gap-1.5 mt-0.5">
              {/* On Primary Blue, white is AA-compliant; Columbia Blue is used
                  for the muted variant rather than a low-contrast gray. */}
              {isActive
                ? <Wifi size={10} className="text-white shrink-0" />
                : <WifiOff size={10} className="text-cu-light shrink-0" />}
              <p className="text-help truncate">
                {isActive ? (
                  <span className="text-white">Active · {displayOrigin}</span>
                ) : (
                  <span className="text-cu-light">{displayOrigin} · navigate to an admin page</span>
                )}
              </p>
            </div>
          ) : (
            <p className="text-help text-cu-light mt-0.5">No Drupal tab detected</p>
          )}
        </div>
      </div>

      {/* Quick Links */}
      <div>
        <p className="px-4 pt-3 pb-1 text-eyebrow-wide font-semibold uppercase text-ink-secondary">
          Quick Links
        </p>
        <ul className="pb-2">
          {QUICK_LINKS.map(link => (
            <li key={link.path}>
              <button
                type="button"
                disabled={!tabOrigin}
                onClick={() => openLink(link.path)}
                className="w-full flex items-center gap-3 px-4 py-1.5 text-control text-ink hover:bg-cu-tint hover:text-cu-blue transition-colors duration-200 ease-studio disabled:opacity-40 disabled:cursor-not-allowed text-left group"
              >
                <span className="text-ink-muted group-hover:text-cu-blue transition-colors duration-200 ease-studio shrink-0">
                  {link.icon}
                </span>
                <span className="flex-1">{link.label}</span>
                <ExternalLink size={11} className="text-ink-muted group-hover:text-cu-blue transition-colors duration-200 ease-studio shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Feature Toggles */}
      <div className="pb-3">
        <p className="px-4 pt-3 pb-1 text-eyebrow-wide font-semibold uppercase text-ink-secondary">
          Features
        </p>
        {!loaded ? (
          <div className="px-4 py-2 text-help text-ink-help">Loading…</div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {FEATURES.map(f => (
              <li key={f.key} className="flex items-center gap-3 px-4 py-2 hover:bg-rail transition-colors duration-200 ease-studio">
                <div className="flex-1 min-w-0">
                  <p className="text-control font-semibold text-ink">{f.label}</p>
                  <p className="text-help text-ink-help truncate">{f.description}</p>
                </div>
                <Toggle on={settings[f.key]} onChange={v => update(f.key, v)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 flex items-center justify-between">
        <span className="text-eyebrow-wide text-ink-help uppercase font-semibold">v0.1.0</span>
        <span className="text-eyebrow-wide text-ink-help uppercase font-semibold truncate ml-2">{displayOrigin ?? 'drupal 7'}</span>
      </div>
    </div>
  );
}
