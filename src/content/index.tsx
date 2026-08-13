import React from 'react';
import { injectComponent, injectOverlay, injectInsideForm, relocateWidget } from './inject';
import { TaxonomyCombobox } from '../components/TaxonomyCombobox';
import { HtmlExport } from '../components/HtmlExport';
import { MenuTree, MenuItem } from '../components/MenuTree';
import { CommandPalette } from '../components/CommandPalette';
import { ContentList } from '../components/ContentList';
import { NodeEditor } from '../components/editor/NodeEditor';
import { findContentTable, parseContentList, currentUsername, diagnoseContentList } from '../lib/parseContentList';
import { discoverSchema, explainSchema, isNodeFormPath } from '../lib/formSchema';
import { getPendingImport } from '../lib/import/pending';
import { maybeShowImportReview } from './importFlow';
import { SETTING_DEFAULTS, Settings } from '../popup/useSettings';

const getSettings = (): Promise<Settings> =>
  new Promise(resolve =>
    chrome.storage.local.get(SETTING_DEFAULTS as unknown as { [k: string]: unknown }, result => resolve(result as unknown as Settings))
  );

const parseDrupalSelect = (select: HTMLSelectElement) => {
  return Array.from(select.options).map(opt => {
    const originalLabel = opt.text;
    const match = originalLabel.match(/^(\-+)\s*(.+)$/);
    const depth = match ? match[1].length : 0;
    const label = match ? match[2] : originalLabel;
    return { value: opt.value, label, originalLabel, depth };
  });
};

const parseDrupalMenuTable = (table: HTMLTableElement): MenuItem[] => {
  const items: MenuItem[] = [];
  const rows = table.querySelectorAll('tr.draggable');

  rows.forEach(row => {
    // Drupal renders top-level items with 1 .indentation div; subtract 1 so root = 0.
    const depth = Math.max(0, row.querySelectorAll('.indentation').length - 1);
    const linkEl = row.querySelector('td:nth-child(1) a') as HTMLAnchorElement;
    const title = linkEl?.innerText || 'Untitled';
    const path = linkEl?.getAttribute('href') || '#';

    const mlidInput = row.querySelector('input[name*="[mlid]"]') as HTMLInputElement;
    const id = mlidInput?.value || Math.random().toString(36).substring(7);

    const enabledCheckbox = row.querySelector('input[type="checkbox"].form-checkbox') as HTMLInputElement;
    const enabled = enabledCheckbox ? enabledCheckbox.checked : true;

    items.push({ id, title, path, depth, enabled });
  });

  return items;
};

const syncTreeToDrupal = (table: HTMLTableElement, items: MenuItem[]) => {
  const drupalRows = Array.from(table.querySelectorAll('tr.draggable'));

  items.forEach((item, index) => {
    const row = drupalRows.find(r => {
      const input = r.querySelector('input[name*="[mlid]"]') as HTMLInputElement;
      return input?.value === item.id;
    }) as HTMLTableRowElement;

    if (!row) {
      console.warn(`[D7 Proxy] Could not find Drupal row for mlid: ${item.id}`);
      return;
    }

    const weightInput = row.querySelector('select.menu-weight, input.menu-weight') as HTMLSelectElement | HTMLInputElement;
    if (weightInput) {
      const weight = (index - 50).toString();
      weightInput.value = weight;

      // Assigning a <select> a value with no matching <option> silently leaves it
      // empty, which would submit a blank weight and scramble the menu order with
      // no visible error. Drupal's weight selects normally span -50..50, so this
      // only trips if the range is narrower than the menu is long — worth
      // surfacing rather than discovering after a save.
      if (weightInput.value !== weight) {
        console.warn(
          `[D7 Proxy] Weight ${weight} is not an available option for mlid ${item.id}; ` +
          `menu may be longer than Drupal's weight range. Order was not written for this row.`
        );
      }
    }

    let plid = '0';
    if (item.depth > 0) {
      for (let i = index - 1; i >= 0; i--) {
        if (items[i].depth === item.depth - 1) {
          plid = items[i].id;
          break;
        }
      }
    }

    const plidInput = row.querySelector('input[name*="[plid]"], select[name*="[plid]"]') as HTMLInputElement | HTMLSelectElement;
    if (plidInput) plidInput.value = plid;

    const enabledCheckbox = row.querySelector('input[type="checkbox"].form-checkbox') as HTMLInputElement;
    if (enabledCheckbox) enabledCheckbox.checked = item.enabled;
  });

  const saveBtn = document.querySelector('#edit-actions-submit, #edit-submit') as HTMLButtonElement;
  if (saveBtn) saveBtn.click();
};

/**
 * Wires ⌘K / Ctrl+K to the command palette.
 *
 * The overlay is mounted on demand and unmounted on close, rather than kept in the
 * DOM hidden — a permanently mounted fixed-position element on someone else's page
 * is a good way to break their layout.
 *
 * Listens in the capture phase so Drupal's own key handlers (and CKEditor's, which
 * binds plenty) cannot swallow the chord first.
 */
const registerCommandPalette = () => {
  let overlay: { unmount: () => void } | null = null;

  const close = () => {
    overlay?.unmount();
    overlay = null;
  };

  document.addEventListener('keydown', (e) => {
    const isChord = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k';
    if (!isChord) return;

    e.preventDefault();
    e.stopPropagation();

    // Toggle, so a second ⌘K dismisses rather than stacking overlays.
    if (overlay) {
      close();
      return;
    }

    overlay = injectOverlay(<CommandPalette onClose={close} />);
  }, true);
};

/**
 * Local time and page, prefixed to anything logged.
 *
 * Chrome's extension Errors page never clears itself: entries persist across page reloads
 * AND across extension reloads, so a warning fixed three builds ago still sits there
 * looking current. A timestamp makes stale entries obvious at a glance instead of needing
 * the message text compared against the source.
 */
const logStamp = () => {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  return `[D7 Studio ${time}] ${window.location.pathname}`;
};

const init = async () => {
  const settings = await getSettings();
  const url = window.location.href;

  if (settings.commandPalette) {
    registerCommandPalette();
  }

  // Field discovery (Phase 4). Read-only for now: it does not change the page. The
  // Phase 5 editor consumes the schema; until then this exists so the rules can be
  // validated against real forms, which is the one thing fixtures cannot prove.
  if (isNodeFormPath()) {
    const schema = discoverSchema();

    if (!schema) {
      if (settings.debugSchema) {
        console.warn(`${logStamp()} No node form schema could be discovered on this page.`);
      }
    } else if (settings.debugSchema) {
      console.info(
        `%c${logStamp()} Form schema\n%c${explainSchema(schema)}`,
        'font-weight:bold',
        'font-family:monospace'
      );
      console.info(
        '[D7 Studio] Copy the block above and send it back to verify the discovery ' +
        'rules against this form. Fields listed under [other] are ones no rule claimed.'
      );
    }

    // Feature 5: two-pane node editor overlay.
    //
    // The native form is hidden rather than removed: every overlay control writes to
    // the real input beneath it, and Drupal's own submit does the save. Removing it
    // would break both.
    if (schema && settings.nodeEditor) {
      // Drupal's tab strips are superseded by the two-pane layout.
      schema.form.parentElement
        ?.querySelectorAll('.field-group-tabs-wrapper > ul, ul.tabs')
        .forEach(el => { (el as HTMLElement).style.display = 'none'; });

      /**
       * Widgets we do not reimplement are RELOCATED rather than described.
       *
       * A media or file field needs Drupal's AJAX upload and media browser; Paragraphs
       * needs its add-more AJAX. Rebuilding either would mean reimplementing the file
       * API, and would break whenever the site's media config changed. Moving the real
       * widget into the overlay keeps Drupal's Browse button, thumbnail, Remove link and
       * validation working, because they are the same DOM nodes with the same handlers.
       *
       * The host must exist before relocating, hence injectInsideForm first with an empty
       * render, then relocate, then render the editor knowing which fields are slotted.
       */
      /**
       * Autocompletes are relocated for the same reason as media widgets: Drupal's
       * type-to-select is jQuery bound to the ORIGINAL input, so a re-rendered text box
       * looks the same and has no type-ahead at all. That behavior is load-bearing on
       * Related Content, where an editor is matching against real node titles.
       */
      const RELOCATE_KINDS = new Set(['file', 'paragraphs', 'autocomplete']);
      const mount = injectInsideForm(schema.form, null);

      const slotted = new Set<string>();
      for (const field of schema.fields) {
        if (!RELOCATE_KINDS.has(field.kind)) continue;
        const element = field.elements[0];
        if (!element) continue;
        if (relocateWidget(mount.container, element, field.machineName, field.baseName)) {
          slotted.add(field.machineName);
        }
      }

      mount.root.render(
        <React.StrictMode>
          <NodeEditor schema={schema} slottedFields={slotted} />
        </React.StrictMode>
      );
    }

  }

  /**
   * Feature 6: import review.
   *
   * Deliberately OUTSIDE the schema block above, and it reports when it cannot run.
   *
   * A waiting import that silently fails to appear is the worst outcome: the fetch
   * succeeded, the user was navigated somewhere, and nothing happened with no explanation.
   * Previously this required a discovered schema and said nothing when there wasn't one,
   * and said nothing at all if the tab was not on a node form.
   */
  {
    const pending = await getPendingImport();

    if (pending && !pending.applied) {
      if (!isNodeFormPath()) {
        console.warn(
          `${logStamp()} An import from ${pending.sourceUrl} is waiting, but this page is `
          + 'not a node add/edit form. Open the form you want to fill and it will appear.'
        );
      } else {
        const schema = discoverSchema();
        if (!schema) {
          console.warn(
            `${logStamp()} An import from ${pending.sourceUrl} is waiting, but the fields on `
            + 'this form could not be read, so there is nothing to fill.\n'
            + 'Turn on "Log Form Schema" in the extension popup and reload to see why.'
          );
        } else {
          maybeShowImportReview(pending, schema);
        }
      }
    }
  }

  /**
   * The editor supersedes the standalone widgets below.
   *
   * They inject as siblings of the native controls, which live inside the form content the
   * editor hides — so with the editor on they would render inside a display:none ancestor
   * and be invisible, while still hiding the native select they replaced. The editor's own
   * rail covers both: Menu Placement has a filter and breadcrumb, and Copy public HTML is
   * on the command palette.
   */
  const editorActive = Boolean(settings.nodeEditor && document.querySelector('.d7-proxy-ui-form-host'));

  // Feature 1: Taxonomy Combobox
  if (!editorActive && settings.combobox && (url.includes('/node/add/') || (url.includes('/node/') && url.includes('/edit')))) {
    const parentSelect = document.querySelector('select[name="menu[parent]"]') as HTMLSelectElement;
    if (parentSelect) {
      const options = parseDrupalSelect(parentSelect);
      const defaultValue = parentSelect.value;
      parentSelect.style.display = 'none';

      injectComponent(parentSelect, (
        <TaxonomyCombobox
          options={options}
          defaultValue={defaultValue}
          onSelect={(value) => {
            parentSelect.value = value;
            parentSelect.dispatchEvent(new Event('change', { bubbles: true }));
          }}
        />
      ), 'before');
    }
  }

  // Feature 2: HTML Export
  if (!editorActive && settings.htmlExport && url.includes('/node/') && url.includes('/edit')) {
    const pageTitle = document.querySelector('#page-title');
    if (pageTitle) {
      injectComponent(pageTitle as HTMLElement, <HtmlExport />, 'after');
    }
  }

  // Feature 3: Menu Tree
  if (settings.menuTree && url.includes('/admin/structure/menu/manage/main-menu')) {
    const menuTable = document.querySelector('table#menu-overview') as HTMLTableElement;
    if (menuTable) {
      const items = parseDrupalMenuTable(menuTable);
      menuTable.style.display = 'none';

      const actions = document.querySelector('.form-actions');
      if (actions) (actions as HTMLElement).style.display = 'none';

      /**
       * Drupal collapses subtrees behind "Show children (N)" links, and only the visible
       * rows are in the DOM. On the live main menu that is 6 rows out of 3,000+, so the
       * manager can only reorder what is shown. Saying so beats appearing to manage a
       * whole menu it cannot see.
       */
      const collapsed = Array.from(document.querySelectorAll('a'))
        .filter(a => /show children/i.test(a.textContent ?? '')).length;
      if (collapsed > 0) {
        console.info(
          `${logStamp()} Menu manager is showing the ${items.length} rows Drupal rendered. `
          + `${collapsed} subtree(s) are collapsed behind "Show children" and are not included — `
          + 'expand them in Drupal first if you need to reorder across them.'
        );
      }

      injectComponent(menuTable, (
        <MenuTree
          items={items}
          onSave={(updatedItems) => syncTreeToDrupal(menuTable, updatedItems)}
        />
      ), 'before');
    }
  }

  // Feature 4: Content list
  if (settings.contentList && new URL(url).pathname.startsWith('/admin/content')) {
    const table = findContentTable();
    const rows = parseContentList();

    // Only take over when the table was found AND parsed into something. On a
    // markup shape we do not recognize, leave Drupal's own table working rather
    // than replacing it with an empty list.
    if (table && rows && rows.length > 0) {
      table.style.display = 'none';

      // Drupal's exposed filter form and bulk-operations block are superseded by
      // the live filters and per-row actions.
      document.querySelectorAll('#node-admin-filter, .node-admin-filter').forEach(el => {
        (el as HTMLElement).style.display = 'none';
      });

      injectComponent(table, (
        <ContentList rows={rows} currentUser={currentUsername()} />
      ), 'before');
    } else {
      // A string, not an object: Chrome's extension error page renders a logged object
      // as "[object Object]", which is exactly where someone goes looking for this.
      console.warn(
        `${logStamp()} Content list not replaced — leaving Drupal's table in place.\n`
        + diagnoseContentList()
        + '\n\nSend the block above to get the parser fixed for this page.'
      );
    }
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
