import React from 'react';
import { injectComponent, injectOverlay, injectInsideForm, relocateWidget } from './inject';
import { TaxonomyCombobox } from '../components/TaxonomyCombobox';
import { HtmlExport } from '../components/HtmlExport';
import { MenuTree, MenuItem } from '../components/MenuTree';
import { CommandPalette } from '../components/CommandPalette';
import { ContentList } from '../components/ContentList';
import { NodeEditor } from '../components/editor/NodeEditor';
import {
  findContentTable, parseContentList, currentUsername, diagnoseContentList, totalRowsInView,
} from '../lib/parseContentList';
import { discoverSchema, explainSchema, isNodeFormPath } from '../lib/formSchema';
import { hasRichEditor } from '../lib/fieldBinding';
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
/**
 * Asks the service worker to tear down or rebuild a rich editor.
 *
 * Routed through the worker because only it can call chrome.scripting with
 * `world: 'MAIN'`, and only the page's own world can reach the editor instance. A
 * content script sees the textarea but not CKEDITOR.
 */
async function sendRichEditorLifecycle(
  elementId: string,
  op: 'detach' | 'attach' | 'probe'
): Promise<{ ok: boolean; editor?: string }> {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'richEditorLifecycle', elementId, op });
    return res ?? { ok: false, editor: 'no-response' };
  } catch {
    // An invalidated extension context (reloaded mid-session) cannot be recovered here.
    return { ok: false, editor: 'context-invalidated' };
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Waits for the page's rich editors to finish building before the form is read.
 *
 * CKEditor is asynchronous: `CKEDITOR.replace()` registers the instance at once, then
 * loads config and plugins before firing instanceReady and inserting its container. This
 * content script runs at DOMContentLoaded, so a single sample of the DOM finds no
 * container and concludes the body has no editor — and then renders a plain textarea over
 * a field that was about to get CKEditor, complete with a note saying Drupal has no editor
 * here. Reported twice from the live Specialty form as "the body needs the html editor".
 *
 * Every fixture attached CKEditor synchronously from an inline script, so the whole suite
 * passed while the live site failed. That is the real lesson here, and it is why
 * node-edit-specialty-async.html exists.
 *
 * Nothing is waited for when the page has no editor library at all, which is the common
 * case for a form with no rich text field.
 */
async function waitForRichEditors(): Promise<string> {
  const probe = async () => {
    const res = await sendRichEditorLifecycle('*', 'probe');
    if (!res.ok || !res.editor) return null;
    try {
      return JSON.parse(res.editor) as { hasLibrary: boolean; total: number; ready: number };
    } catch {
      return null;
    }
  };

  // A short look for the library itself. Page scripts have run by DOMContentLoaded, so
  // this is about the bridge being ready rather than about Drupal being slow.
  let state = await probe();
  for (let attempt = 0; attempt < 3 && !state?.hasLibrary; attempt++) {
    await sleep(150);
    state = await probe();
  }
  if (!state) return 'no-bridge';
  if (!state.hasLibrary) return 'no-library';

  // Then wait for the instances to finish. Bounded: a library that never builds anything
  // must not hold the overlay hostage, and falling through renders a working plain
  // textarea rather than nothing.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (state && state.total > 0 && state.ready >= state.total) {
      return `ready:${state.ready}`;
    }
    await sleep(120);
    state = await probe();
  }
  return `timeout:${state?.ready ?? 0}/${state?.total ?? 0}`;
}

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
    /**
     * Before the form is read, not after.
     *
     * Whether a field HAS a rich editor decides three things at once: that the body is
     * relocated rather than reimplemented, that its Edit-summary folds into it instead of
     * becoming a separate box, and whether the "no rich text editor in Drupal" note is
     * shown. Reading the form while CKEditor is still loading gets all three wrong
     * together, which is exactly what was reported.
     *
     * Skipped when nothing downstream consumes the schema, so a user who has the node
     * editor switched off does not pay a wait that cannot change anything for them.
     */
    const needsSchema = settings.nodeEditor || settings.debugSchema;
    const editorState = needsSchema ? await waitForRichEditors() : 'not-needed';
    if (settings.debugSchema) {
      console.log(`${logStamp()} rich editors: ${editorState}`);
    }
    if (editorState.startsWith('timeout')) {
      console.warn(
        `${logStamp()} A rich editor library is present but did not finish loading `
        + `(${editorState}). Fields it owns will show as plain text.`
      );
    }

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

      /**
       * A rich text field is relocated too, but ONLY when Drupal really has an editor on
       * it — and it has to be destroyed before the move and rebuilt after.
       *
       * The body previously rendered a plain textarea under a row of grey, aria-hidden
       * spans reading "B I Link H2 H3 List Table Image". That strip was decoration: no
       * button did anything, so the body had no formatting controls at all. Reimplementing
       * a toolbar would not fix it either, because it could not match this site's
       * configured button set, its format list, or the media browser wired into the
       * editor. Moving the real editor is the only version of "the same buttons".
       *
       * `hasRichEditor` is checked rather than the field KIND, because walkForm classifies
       * anything inside a `.text-format-wrapper` as wysiwyg — including a plain textarea
       * that merely has a format selector under it. Relocating one of those would drop the
       * designed writing surface and gain nothing.
       */
      const richFields = schema.fields.filter(
        field => field.kind === 'wysiwyg' && hasRichEditor(field) && field.elements[0]?.id
      );

      // Detach BEFORE the host is built, so the editors are already torn down by the time
      // anything is moved. An iframe-based editing area does not survive reparenting.
      const detached = new Set<string>();
      for (const field of richFields) {
        const id = field.elements[0].id;
        const res = await sendRichEditorLifecycle(id, 'detach');
        if (res.ok && res.editor !== 'none') detached.add(field.machineName);
        else if (!res.ok) {
          console.warn(
            `${logStamp()} Could not detach the rich editor on "${field.label}" `
            + `(${res.editor}); leaving it in Drupal's form rather than moving it.`
          );
        }
      }

      const mount = injectInsideForm(schema.form, null);

      const slotted = new Set<string>();
      for (const field of schema.fields) {
        const isRich = detached.has(field.machineName);
        if (!isRich && !RELOCATE_KINDS.has(field.kind)) continue;
        const element = field.elements[0];
        if (!element) continue;
        if (relocateWidget(mount.container, element, field.machineName, field.baseName)) {
          slotted.add(field.machineName);
        } else if (isRich) {
          // The move failed, so put the editor back rather than leaving it destroyed.
          void sendRichEditorLifecycle(element.id, 'attach');
          detached.delete(field.machineName);
        }
      }

      mount.root.render(
        <React.StrictMode>
          <NodeEditor schema={schema} slottedFields={slotted} />
        </React.StrictMode>
      );

      /**
       * Rebuild the editors now that React has rendered the slots that project them.
       *
       * Order matters: re-attaching while the textarea is still unslotted means the
       * editor builds itself inside an element the browser is not rendering, and CKEditor
       * measures a zero-height container and comes up collapsed.
       */
      if (detached.size) {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        for (const field of schema.fields) {
          if (!detached.has(field.machineName)) continue;
          const res = await sendRichEditorLifecycle(field.elements[0].id, 'attach');
          if (!res.ok || res.editor === 'behaviors-ran-no-editor') {
            console.error(
              `${logStamp()} The rich editor on "${field.label}" did not come back after `
              + `being moved (${res.editor}). The field is still editable as plain text and `
              + 'still saves, but its formatting toolbar is missing. Turn off the Two-Pane '
              + 'Node Editor in the extension popup to get Drupal\'s own editor back.'
            );
          }
        }
      }

      /**
       * Verifies every relocated widget can actually be seen.
       *
       * A light-DOM child with `slot="x"` renders ONLY if some `<slot name="x">` exists in
       * the shadow tree. When it does not, the browser hides the child with no error, the
       * editor shows a reimplemented control in its place, and anything typed there is
       * dropped — controls inside a shadow root are not form-associated, so they are never
       * submitted. That is silent data loss, and it shipped: Tags was invisible on both
       * demo sites because two sections did not thread `slottedFields`.
       *
       * Collapsed sections legitimately have no slot yet, so the check EXPANDS everything
       * first. It only reports, never repairs — a wrong repair here would move a live
       * widget out of the form and stop it saving.
       */
      if (settings.debugSchema) {
        // Two frames: one for React's commit, one for layout after expanding.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const shadow = mount.container.shadowRoot;
        if (shadow) {
          shadow.querySelectorAll<HTMLElement>('[aria-expanded="false"]').forEach(el => el.click());
          await new Promise(resolve => setTimeout(resolve, 250));

          const rendered = new Set(
            Array.from(shadow.querySelectorAll('slot'))
              .map(s => s.getAttribute('name'))
              .filter((name): name is string => !!name)
          );

          const orphans = Array.from(mount.container.children)
            .map(child => child.getAttribute('slot'))
            .filter((name): name is string => !!name && !rendered.has(name));

          if (orphans.length) {
            console.error(
              `${logStamp()} ${orphans.length} relocated widget(s) have no matching slot and are `
              + 'therefore INVISIBLE, while still being submitted with the form:\n  '
              + orphans.join('\n  ')
              + '\nThe section rendering these fields is not passing them through '
              + 'SlottedFieldsContext. Report this output.'
            );
          }
        }
      }
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

      // tableheader.js leaves a cloned header table behind. Hiding only the real table
      // leaves that clone floating as a stray bar above the replacement.
      document.querySelectorAll('table.sticky-header').forEach(el => {
        (el as HTMLElement).style.display = 'none';
      });

      /**
       * Drupal's own filter is superseded ONLY when this page is the whole list.
       *
       * When the View paginates, Drupal's Title filter is the one control that searches
       * every row; ours searches the 50 that were rendered. Hiding it on demo-dean would
       * have removed the only way to find anything among 11,760 nodes, and left the
       * replacement quietly less capable than what it covered up.
       */
      const total = totalRowsInView();
      const paginated = typeof total === 'number' && total > rows.length;

      if (!paginated) {
        document.querySelectorAll('#node-admin-filter, .node-admin-filter').forEach(el => {
          (el as HTMLElement).style.display = 'none';
        });
      }

      injectComponent(table, (
        <ContentList rows={rows} currentUser={currentUsername()} totalInView={total} />
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
