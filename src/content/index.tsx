import { injectComponent, injectOverlay } from './inject';
import { TaxonomyCombobox } from '../components/TaxonomyCombobox';
import { HtmlExport } from '../components/HtmlExport';
import { MenuTree, MenuItem } from '../components/MenuTree';
import { CommandPalette } from '../components/CommandPalette';
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
    if (weightInput) weightInput.value = (index - 50).toString();

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

const init = async () => {
  const settings = await getSettings();
  const url = window.location.href;

  if (settings.commandPalette) {
    registerCommandPalette();
  }

  // Feature 1: Taxonomy Combobox
  if (settings.combobox && (url.includes('/node/add/') || (url.includes('/node/') && url.includes('/edit')))) {
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
  if (settings.htmlExport && url.includes('/node/') && url.includes('/edit')) {
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

      injectComponent(menuTable, (
        <MenuTree
          items={items}
          onSave={(updatedItems) => syncTreeToDrupal(menuTable, updatedItems)}
        />
      ), 'before');
    }
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
