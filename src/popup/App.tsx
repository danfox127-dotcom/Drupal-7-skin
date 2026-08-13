import React, { useEffect, useState } from 'react';
import {
  LayoutList, FilePlus, GitBranch, Tags, Users, Settings,
  ExternalLink, Layers, Wifi, WifiOff, X, Command,
} from 'lucide-react';
import { useSettings, Settings as SettingsShape } from './useSettings';
import { useImportQueue, displayUrl } from './useImportQueue';

interface QuickLink {
  label: string;
  path: string;
  icon: React.ReactNode;
}

/**
 * Quick links follow the prototype: All Content, Create News, Create Page, Main
 * Menu. "Import from URL" is deliberately absent until Phase 6 ships the review
 * screen — linking to a path that 404s is worse than not offering it.
 */
const QUICK_LINKS: QuickLink[] = [
  { label: 'All Content',   path: '/admin/content',                         icon: <LayoutList size={14} /> },
  { label: 'Create News',   path: '/node/add/news',                         icon: <FilePlus size={14} /> },
  { label: 'Create Page',   path: '/node/add/page',                         icon: <FilePlus size={14} /> },
  { label: 'Main Menu',     path: '/admin/structure/menu/manage/main-menu', icon: <GitBranch size={14} /> },
  { label: 'Taxonomy',      path: '/admin/structure/taxonomy',              icon: <Tags size={14} /> },
  { label: 'Users',         path: '/admin/people',                          icon: <Users size={14} /> },
  { label: 'Configuration', path: '/admin/config',                          icon: <Settings size={14} /> },
];

interface Feature {
  key: keyof SettingsShape;
  label: string;
  description: string;
}

const FEATURES: Feature[] = [
  { key: 'combobox',       label: 'Menu Parent Combobox', description: 'Searchable dropdown on node edit forms' },
  { key: 'htmlExport',     label: 'HTML Content Export',  description: 'Copy sanitized public HTML from node edit pages' },
  { key: 'menuTree',       label: 'Menu Tree Manager',    description: 'Drag-and-drop tree on main menu admin page' },
  { key: 'commandPalette', label: 'Command Palette',      description: 'Press ⌘K on any admin page' },
  { key: 'contentList',    label: 'Modern Content List',  description: 'Live filtering and row actions on /admin/content' },
  { key: 'nodeEditor',     label: 'Two-Pane Node Editor', description: 'Replaces the node form. Unvalidated against live markup — off by default' },
  { key: 'debugSchema',    label: 'Log Form Schema',      description: 'Print discovered fields to the console on node forms' },
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
  const { queue, add, remove, loaded: queueLoaded } = useImportQueue();
  const [draftUrl, setDraftUrl] = useState('');
  const [queueError, setQueueError] = useState<string | null>(null);

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

  const handleAdd = () => {
    const error = add(draftUrl);
    setQueueError(error);
    if (!error) setDraftUrl('');
  };

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

      {/* Import Queue */}
      <div className="pb-2">
        <p className="px-4 pt-3 pb-1 text-eyebrow-wide font-semibold uppercase text-ink-secondary">
          Import Queue
        </p>

        <div className="px-4 flex items-center gap-2">
          <input
            type="text"
            placeholder="Paste a URL"
            value={draftUrl}
            onChange={e => { setDraftUrl(e.target.value); setQueueError(null); }}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
            className="flex-1 min-w-0 px-2 py-1.5 bg-white border border-rule-control rounded text-control text-ink placeholder:text-ink-placeholder"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={!draftUrl.trim()}
            className="px-3 py-1.5 bg-cu-blue hover:bg-cu-navy text-white rounded text-control font-semibold transition-colors duration-200 ease-studio disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            Add
          </button>
        </div>

        {queueError && (
          <p className="px-4 pt-1 text-help text-burnt">{queueError}</p>
        )}

        {queueLoaded && queue.length > 0 && (
          <ul className="mt-2">
            {queue.map(item => (
              <li key={item.url} className="flex items-center gap-2 px-4 py-1.5 hover:bg-rail transition-colors duration-200 ease-studio group">
                {/* Phase 6 repoints this at the mapping review. For now it opens
                    the source page, which is genuinely useful and honest. */}
                <button
                  type="button"
                  onClick={() => chrome.tabs.create({ url: item.url })}
                  title={item.url}
                  className="flex-1 min-w-0 text-left text-control text-cu-blue truncate hover:underline"
                >
                  {displayUrl(item.url)}
                </button>
                <button
                  type="button"
                  onClick={() => remove(item.url)}
                  aria-label={`Remove ${displayUrl(item.url)} from the queue`}
                  className="shrink-0 p-0.5 text-ink-muted hover:text-burnt hover:bg-cu-tint rounded transition-colors duration-200 ease-studio"
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {queueLoaded && (
          <p className="px-4 pt-1.5 text-help text-ink-help">
            {queue.length === 0
              ? 'Nothing queued. Paste URLs as you find them.'
              : `${queue.length} page${queue.length === 1 ? '' : 's'} waiting. One at a time.`}
          </p>
        )}
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

      {/* Footer. The active host is already in the header, so it is not repeated
          here — at 320px there is only room for two items. */}
      <div className="px-4 py-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-eyebrow-wide text-ink-help uppercase font-semibold">
          <Command size={10} />
          K for commands
        </span>
        <span className="text-eyebrow-wide text-ink-help uppercase font-semibold shrink-0">v0.1.0</span>
      </div>
    </div>
  );
}
