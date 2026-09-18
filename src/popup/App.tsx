import React, { useEffect, useState } from 'react';
import { ArrowDownToLine, ClipboardCopy, Command, Copy, ExternalLink, FilePlus, GitBranch, Layers, LayoutList, RefreshCw, Settings, Tags, Users, Wifi, WifiOff, X } from 'lucide-react';
import { useSettings, Settings as SettingsShape } from './useSettings';
import { useImportQueue, displayUrl } from './useImportQueue';
import { useCopiedPages } from './useCopiedPages';
import { canCopyFrom, canPasteInto, describeTarget } from '../lib/clone/whereAmI';
import { formatAge } from '../lib/autosave';
import { requestOriginAccess, setPendingImport, importTarget } from '../lib/import/pending';
import { UPDATE_STATE_KEY, UpdateState } from '../lib/updateCheck';
import { Capture } from '../lib/captureFixture';

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
  const [updateInfo, setUpdateInfo] = useState<UpdateState | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [captureNote, setCaptureNote] = useState<string | null>(null);
  const [keepText, setKeepText] = useState(false);
  const [trimLists, setTrimLists] = useState(true);

  /**
   * Copy the current node form as a test fixture.
   *
   * The scrubbing happens in the content script (captureFixture); this only moves the
   * result to the clipboard, which needs the popup's own focus and gesture. The report is
   * shown rather than hidden because the output is destined for a PUBLIC repository and
   * someone has to read it before committing.
   */
  const captureForm = () => {
    setCaptureNote('Reading the form…');
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) { setCaptureNote('No active tab.'); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'captureFixture', keepValues: keepText, trimLargeSelects: trimLists }, async (result: Capture | null) => {
        if (chrome.runtime.lastError || result === undefined) {
          setCaptureNote('The extension is not running on this page.');
          return;
        }
        if (result === null) {
          setCaptureNote('No node form on this page — open one for editing first.');
          return;
        }
        /**
         * Downloaded to a file, AND copied to the clipboard.
         *
         * The clipboard alone was a trap: retrieving the capture means running a command,
         * and copying that command overwrites the clipboard with the command itself. A
         * file does not have that failure mode.
         *
         * An <a download> works from a popup with no extra permission, unlike
         * chrome.downloads. The clipboard copy stays as a convenience and is allowed to
         * fail silently — the file is the reliable path.
         */
        const slug = (result.report.contentType || 'form').replace(/[^a-z0-9]+/gi, '-');
        try {
          const url = URL.createObjectURL(new Blob([result.html], { type: 'text/html' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = `capture-${slug}.html`;
          a.click();
          URL.revokeObjectURL(url);
        } catch {
          setCaptureNote('Could not save the file.');
          return;
        }
        try {
          await navigator.clipboard.writeText(result.html);
        } catch { /* the file is what matters */ }
        const r = result.report;
        const big = r.largeSelects.length
          ? ` ${r.largeSelects.length} large option list${r.largeSelects.length === 1 ? '' : 's'} kept in full — check the size.`
          : '';
        setCaptureNote(
          `Saved to Downloads as capture-${slug}.html. ` +
          `Removed ${[...new Set(r.removedFields)].length} security field(s), ` +
          (r.valuesKept
            ? 'KEPT this page\'s text — check for anything unpublished before committing.'
            : `blanked ${r.blankedValues} value(s),`) +
          ` dropped ${r.scriptsRemoved} script(s).${big}` +
          (r.valuesKept ? '' : ' Read it before committing.')
        );
      });
    });
  };

  /**
   * Read whatever the service worker last wrote. The popup does not fetch: the worker
   * owns the one code path that talks to the network, so both cannot disagree about what
   * the latest version is.
   */
  useEffect(() => {
    chrome.storage.local.get({ [UPDATE_STATE_KEY]: null }, result => {
      setUpdateInfo((result[UPDATE_STATE_KEY] as UpdateState | null) ?? null);
    });
  }, []);

  const recheck = () => {
    setRechecking(true);
    chrome.runtime.sendMessage({ type: 'checkForUpdate' }, (state: UpdateState) => {
      setUpdateInfo(state ?? null);
      setRechecking(false);
    });
  };
  const [tabPath, setTabPath] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(false);
  const { settings, update, loaded } = useSettings();
  const { queue, add, remove, loaded: queueLoaded } = useImportQueue();
  const copied = useCopiedPages();
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneNote, setCloneNote] = useState<string | null>(null);

  /**
   * Copy and paste, asked of the content script.
   *
   * The popup cannot read the page, so it cannot do either itself — but it is where
   * someone looks for a feature. Until now both lived only behind ⌘K, which made them
   * undiscoverable to anyone who did not already know the shortcut.
   */
  const askPage = (type: 'clonePage' | 'clonePaste', onOk: () => void) => {
    setCloneBusy(true);
    setCloneNote(null);
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) {
        setCloneBusy(false);
        setCloneNote('No active tab.');
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type }, (result?: { ok: boolean; error?: string }) => {
        setCloneBusy(false);
        if (chrome.runtime.lastError || result === undefined) {
          setCloneNote('The extension is not running on this page. Reload the page and try again.');
          return;
        }
        if (!result.ok) {
          setCloneNote(result.error ?? 'That did not work.');
          return;
        }
        onOk();
      });
    });
  };
  const [draftUrl, setDraftUrl] = useState('');
  const [queueError, setQueueError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState<string | null>(null);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.url) return;
      try {
        const url = new URL(tab.url);
        setTabOrigin(url.origin);
        setTabPath(url.pathname);
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

  /**
   * Starts an import: asks for access to that one origin, fetches through the service
   * worker, extracts, and parks the result for the node form to review.
   *
   * The permission request must happen here — chrome.permissions.request needs a user
   * gesture in an extension page, and is unavailable to service workers and content
   * scripts.
   */
  const startImport = async (url: string) => {
    setImportBusy(url);
    setQueueError(null);

    try {
      const granted = await requestOriginAccess(url);
      if (!granted) {
        setQueueError('Access to that site was declined, so it cannot be fetched.');
        return;
      }

      const response = await chrome.runtime.sendMessage({ type: 'fetchSource', url });
      if (!response?.ok || !response.html) {
        setQueueError(response?.error ?? 'Could not fetch that page.');
        return;
      }

      // Raw HTML is parked as-is. Extraction happens on the node form, where the
      // text format's allowed-tag list can actually be read — filtering here would
      // guess at it.
      const target = importTarget(tabPath);

      await setPendingImport({
        html: response.html,
        sourceUrl: response.finalUrl ?? url,
        targetType: target.targetType,
        createdAt: Date.now(),
        applied: false,
      });

      if (!tabOrigin) {
        setQueueError('Open a Drupal admin tab first — the review fills that form.');
        return;
      }

      /**
       * Stay on the form you are already on.
       *
       * This used to navigate unconditionally to /node/add/news, so starting an import
       * from a Page form threw away that form and switched content type. The review only
       * needs SOME node form to fill; if the tab is already showing one, reload it so the
       * content script picks up the pending import, and leave the type alone.
       */
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab?.id) { window.close(); return; }

        if (target.stay) {
          chrome.tabs.reload(tab.id);
        } else {
          // Not on a form, so there is nothing to preserve. News is the common case; the
          // review reports whichever type it actually lands on.
          chrome.tabs.update(tab.id, { url: `${tabOrigin}/node/add/news` });
        }
        window.close();
      });
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setImportBusy(null);
    }
  };

  return (
    <div className="w-[360px] bg-white flex flex-col font-sans text-ink divide-y divide-rule-faint">
      {/* Header */}
      <div className="px-4 py-3 bg-cu-blue text-white flex items-center gap-3">
        <Layers size={18} className="shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-display font-semibold text-section uppercase tracking-[.08em]">D7 Studio</p>
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

      {/*
        Update notice.

        Only rendered when there IS one — a permanent "you are up to date" row trains
        people to ignore this area, which is the opposite of the point.

        This can now only appear on a HAND-LOADED copy: the extension is on the Chrome
        Web Store, a store install updates itself, and checkForUpdate returns early for
        it. So the banner's job has changed from "fetch a zip" to "move to the store",
        which also retires the folder-picking mistake the zip kept inviting.
      */}
      {updateInfo?.available && (
        <div data-update-banner className="px-4 py-3 bg-cu-tint">
          <div className="flex items-start gap-2">
            <ArrowDownToLine size={14} className="mt-0.5 shrink-0 text-cu-onLight" />
            <div className="min-w-0 flex-1">
              <p className="text-control font-semibold text-cu-onLight">
                Version {updateInfo.latest} is available
              </p>
              <p className="text-help text-ink-secondary mt-0.5">
                You have {updateInfo.current}.
              </p>
              {updateInfo.notes && (
                <p className="text-help text-ink-secondary mt-1">{updateInfo.notes}</p>
              )}
              {/**
                * The store first, and the zip only as a fallback.
                *
                * This banner only ever reaches a hand-loaded copy now — a store install
                * does not check. So the useful instruction is "stop hand-loading it",
                * not "here is another zip". The zip is exactly what produced a card that
                * looked installed and did nothing, twice, by being the wrong folder.
                */}
              {updateInfo.storeUrl && (
                <a
                  href={updateInfo.storeUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-2 inline-flex items-center gap-1.5 text-help font-semibold text-cu-blue hover:underline"
                >
                  Install it from the Chrome Web Store
                  <ExternalLink size={11} />
                </a>
              )}
              <p className="text-help text-ink-help mt-1.5">
                Installing from the store replaces this hand-loaded copy and keeps itself
                up to date, so this is the last time you have to do this. Remove the
                unpacked copy at chrome://extensions afterwards, or you will be running
                two at once.
              </p>
              {updateInfo.download && (
                <a
                  href={updateInfo.download}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1.5 inline-flex items-center gap-1.5 text-help text-ink-help hover:underline"
                >
                  Or download the zip, as before
                  <ExternalLink size={11} />
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Import Queue */}
      <div className="pb-2">
        <p className="px-4 pt-3 pb-1 text-eyebrow-wide font-semibold uppercase text-ink-secondary">
          Import From a URL
        </p>
        {/**
          * One line on which tool to reach for. These two were previously adjacent with
          * nothing to distinguish them, and the importer is the weaker of the pair for
          * anything already on a Drupal site — it reads a themed page and recovers title,
          * summary and body, where the copier reads the form and gets every field.
          */}
        <p className="px-4 pb-2 text-help text-ink-secondary">
          For a page that is <strong>not</strong> on a Columbia Drupal site. For one that
          is, use Copy a Drupal Node above.
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
                {/* Clicking a queued URL now opens its mapping review, which is what
                    the design always specified. */}
                <button
                  type="button"
                  onClick={() => void startImport(item.url)}
                  disabled={importBusy !== null}
                  title={item.url}
                  className="flex-1 min-w-0 text-left text-control text-cu-blue truncate hover:underline disabled:opacity-50"
                >
                  {importBusy === item.url ? 'Fetching…' : displayUrl(item.url)}
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
              : `${queue.length} page${queue.length === 1 ? '' : 's'} waiting. One at a time — open a URL to review its mapping.`}
          </p>
        )}
      </div>

      {/**
        * Copy a Drupal node — its own tool, on its own surface.
        *
        * Deliberately separated from Import from URL and placed first. They read as the
        * same thing and are not: this one reads another Drupal site's node FORM, where
        * every field's real value is available, while the importer scrapes a themed page
        * and can only recover title, summary and body. Sharing one heading invited
        * picking the weaker tool for the job.
        */}
      <div className="border-t border-rule-hair bg-cu-tint border-l-2 border-l-cu-blue">
        <div className="px-4 pt-3 pb-1 flex items-center gap-2">
          <Copy size={13} className="shrink-0 text-cu-onLight" />
          <p className="text-eyebrow-wide font-semibold uppercase text-cu-onLight">
            Copy a Drupal Node
          </p>
          <div className="flex-1" />
          {copied.copies.length > 0 && (
            <button
              type="button"
              onClick={() => { void copied.forgetAll(); setCloneNote(null); }}
              className="text-help font-semibold text-cu-blue hover:underline"
            >
              Clear
            </button>
          )}
        </div>

        <p className="px-4 pb-2 text-help text-ink-secondary">
          Duplicate a whole page from one Columbia Drupal site to another.
        </p>

        <div className="px-4 pb-2 flex flex-col gap-1.5">
          <button
            type="button"
            disabled={cloneBusy || !canCopyFrom(tabPath)}
            onClick={() => askPage('clonePage', () => {
              void copied.reload();
              setCloneNote('Copied. Open the form on the other site, then press Paste.');
            })}
            title={canCopyFrom(tabPath)
              ? undefined
              : 'Open the page you want to duplicate on its edit form first'}
            className="px-3 py-1.5 bg-cu-blue hover:bg-cu-navy text-white rounded text-control font-semibold transition-colors duration-200 ease-studio disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {cloneBusy ? 'Working…' : 'Copy this page'}
          </button>

          {/**
            * The paste button names what it will paste and where.
            *
            * "Paste" alone does not say which of five copies is about to be applied, and
            * a paste fills a form the editor may already have work in.
            */}
          <button
            type="button"
            disabled={cloneBusy || !canPasteInto(tabPath) || copied.copies.length === 0}
            onClick={() => askPage('clonePaste', () => window.close())}
            title={copied.copies.length === 0
              ? 'Nothing copied yet'
              : canPasteInto(tabPath) ? undefined : 'Open a node form to paste into'}
            className="px-3 py-1.5 bg-white border border-cu-blue text-cu-blue rounded text-control font-semibold hover:bg-white/60 transition-colors duration-200 ease-studio disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {copied.copies.length === 0
              ? 'Paste — nothing copied yet'
              : `Paste “${copied.copies[0].title || 'the copied page'}”${
                  describeTarget(tabPath) ? ` into this ${describeTarget(tabPath)}` : ''}`}
          </button>
        </div>

        {cloneNote && (
          <p className="px-4 pb-2 text-help text-cu-onLight">{cloneNote}</p>
        )}

        {copied.copies.length > 0 && (
          <ul className="pb-1">
            {copied.copies.map((copy, index) => (
              <li key={copy.sourceUrl} className="px-4 py-1.5">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-control text-ink truncate" title={copy.sourceUrl}>
                      {index === 0 && copied.copies.length > 1 && (
                        <span className="text-eyebrow font-semibold uppercase text-cu-onLight mr-1">
                          newest
                        </span>
                      )}
                      {copy.title || displayUrl(copy.sourceUrl)}
                    </p>
                    <p className="text-help text-ink-secondary truncate">
                      {copy.contentType ?? 'unknown type'} · {new URL(copy.sourceOrigin).host}
                      {' · '}{formatAge(copy.capturedAt, Date.now())}
                      {' · '}{copy.fields.length} field{copy.fields.length === 1 ? '' : 's'}
                      {copy.paragraphs.some(w => w.items.length > 0) && (() => {
                        const items = copy.paragraphs.reduce((n, w) => n + w.items.length, 0);
                        return ` · ${items} content item${items === 1 ? '' : 's'}`;
                      })()}
                    </p>

                    {/**
                      * The image URLs live here as well as in the review.
                      *
                      * The review's summary can be dismissed, and should be — it covers
                      * the form. Without a second home, dismissing it would throw away
                      * the only list of which images the old page used and where to get
                      * them, and the only way back would be to paste again over a form
                      * already filled in.
                      */}
                    {copy.media.filter(m => m.fid || m.url).map(image => (
                      <div key={image.baseName} className="mt-1 flex items-center gap-2">
                        <span className="text-help text-ink-help truncate flex-1 min-w-0">
                          {image.label}: {image.filename || 'file'}
                        </span>
                        {image.url && (
                          <a
                            href={image.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="shrink-0 text-help font-semibold text-cu-blue hover:underline"
                          >
                            Open
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => void copied.forget(copy.sourceUrl)}
                    aria-label={`Forget the copy of ${copy.title || copy.sourceUrl}`}
                    className="shrink-0 p-0.5 text-ink-muted hover:text-burnt rounded transition-colors duration-200 ease-studio"
                  >
                    <X size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {copied.loaded && copied.copies.length === 0 && (
          <p className="px-4 pb-3 text-help text-ink-help">
            Open the page you want to duplicate on its <strong>edit</strong> form, then
            press Copy.
            {copied.refused > 0 && (
              <>
                {' '}{copied.refused} older cop{copied.refused === 1 ? 'y was' : 'ies were'}{' '}
                discarded — made by a previous version of the extension.
              </>
            )}
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
                  {/* Wraps rather than truncating. "Replaces the node form. Unvalidated agai…"
                      hid the part that mattered; a second line costs nothing. */}
                  <p className="text-help text-ink-help">{f.description}</p>
                </div>
                <Toggle on={settings[f.key]} onChange={v => update(f.key, v)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        Fixture capture — a developer action, deliberately plain and last.

        Every significant bug in this extension came from a hand-authored fixture that
        disagreed with the real form. This turns a real form into a test fixture so that
        stops being the default.
      */}
      <div className="px-4 py-3">
        <button
          type="button"
          onClick={captureForm}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-white border border-rule-control rounded text-control font-semibold text-ink hover:bg-legacy-200 transition-colors duration-200 ease-studio"
        >
          <ClipboardCopy size={13} />
          Copy this form as a test fixture
        </button>
        {/*
          Off by default. Blanking is the safe default for a public repo, but a bug that
          needs realistic text otherwise means hand-typing it back in — which is the manual
          work this whole action exists to remove. Security fields and usernames are
          stripped either way.
        */}
        {/*
          On by default. The menu parent select is the same 3,333 options on every content
          type and 77% of a capture's bytes; one full copy already exists in
          node-add-page-bigmenu.html, so repeating it per type is waste. Trimming keeps a
          sample from each depth so the tree still has its shape.
        */}
        <label className="mt-2 flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={trimLists}
            onChange={e => setTrimLists(e.target.checked)}
            className="mt-0.5 shrink-0"
          />
          <span className="text-help text-ink-secondary">
            Trim huge option lists
            <span className="block text-ink-help">
              Keeps a sample from every depth instead of all 3,000+ menu parents.
            </span>
          </span>
        </label>
        <label className="mt-2 flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={keepText}
            onChange={e => setKeepText(e.target.checked)}
            className="mt-0.5 shrink-0"
          />
          <span className="text-help text-ink-secondary">
            Keep this page’s text
            <span className="block text-ink-help">
              For bugs that need real content. Tokens and usernames are removed either way —
              but check for unpublished text before committing.
            </span>
          </span>
        </label>
        {captureNote && (
          <p data-capture-note className="mt-2 text-help text-ink-secondary">{captureNote}</p>
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
      {/* Version footer — quiet, but it answers "what am I running?" without a hunt. */}
      <div className="px-4 py-2 flex items-center justify-between gap-2">
        <p className="text-help text-ink-help">
          v{updateInfo?.current ?? chrome.runtime.getManifest().version}
          {updateInfo?.checkedAt ? ` · checked ${new Date(updateInfo.checkedAt).toLocaleDateString()}` : ''}
        </p>
        <button
          type="button"
          onClick={recheck}
          disabled={rechecking}
          className="inline-flex items-center gap-1 text-help font-semibold text-cu-blue hover:underline disabled:text-ink-help"
        >
          <RefreshCw size={11} className={rechecking ? 'animate-spin' : ''} />
          {rechecking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

    </div>
  );
}
