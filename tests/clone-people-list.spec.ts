import { test, expect, Page } from '@playwright/test';
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

/**
 * Copying a People List from one site to another — the structured content that came
 * across as nothing at all.
 *
 * Both forms are REAL captures: the source is vagelos.columbia.edu/node/26237/edit (a
 * People List of eight people), the destination nursing.columbia.edu/node/5050/edit
 * (no content items yet). A People List nests three deep: the list, its Persons, and each
 * Person's Phones and Emails, every level with its own Add button.
 *
 * Drupal's "Add" requests are stood in for, built from the source's own rows, and they
 * behave like Drupal 7's: they answer MOUSEDOWN and swallow the click. The paste used to
 * click, which is why nothing arrived.
 */

let bundle: string;

test.beforeAll(async () => {
  const built = await esbuild.build({
    stdin: {
      contents: `
        export { discoverSchema } from './src/lib/formSchema';
        export { captureNode } from './src/lib/clone/snapshot';
        export { rebuildParagraphs } from './src/lib/clone/paragraphs';`,
      resolveDir: path.join(__dirname, '..'),
      loader: 'ts',
    },
    bundle: true, write: false, format: 'iife', globalName: 'C', platform: 'browser', target: 'es2020',
  });
  bundle = built.outputFiles[0].text;
});

const VAGELOS = 'https://www.vagelos.columbia.edu/node/26237/edit';
const NURSING = 'https://www.nursing.columbia.edu/node/5050/edit';

async function load(page: Page, url: string, fixture: string) {
  await page.route(url, route => route.fulfill({
    contentType: 'text/html', body: fs.readFileSync(path.join(FIXTURES, fixture), 'utf8'),
  }));
  await page.goto(url);
  await page.evaluate(() => {
    (window as any).__sent = [];
    (window as any).chrome = {
      runtime: {
        sendMessage: async (message: unknown) => {
          (window as any).__sent.push(message);
          return { ok: true };
        },
      },
    };
  });
  await page.addScriptTag({ content: bundle });
}

/** Fills the scrubbed source with recognisable values and copies it. */
async function copySource(page: Page) {
  await load(page, VAGELOS, 'clone/page-people-list.html');
  return page.evaluate(async () => {
    const set = (name: string, value: string) => {
      const el = document.querySelector<HTMLInputElement>(`[name="${name}"]`);
      if (!el) throw new Error(`no ${name}`);
      el.value = value;
    };
    const item = 'field_page_paragraphs[und][0]';
    set(`${item}[field_title][und][0][value]`, 'Our Team');
    for (let k = 0; k < 8; k++) {
      const person = `${item}[field_persons_paragraphs][und][${k}]`;
      set(`${person}[field_person_full_name][und][0][value]`, `Person ${k + 1}`);
      set(`${person}[field_person_position][und][0][value]`, `Role ${k + 1}`);
      set(`${person}[field_person_bio][und][0][value]`, `<p>Bio ${k + 1}</p>`);
    }
    set(`${item}[field_persons_paragraphs][und][1][field_person_position][und][1][value]`, 'Second role');
    set(`${item}[field_persons_paragraphs][und][0][field_cola_cups_pofile][und][0][target_id]`, 'Some Profile (123)');

    // The template Drupal would answer an "Add" with: this list, holding one blank person.
    const listRow = document.querySelector('tr.paragraphs-item-type-persons')!.cloneNode(true) as HTMLElement;
    const people = Array.from(listRow.querySelectorAll('tr.paragraphs-item-type-person'));
    people.slice(1).forEach(row => row.remove());
    listRow.querySelectorAll<HTMLInputElement>('input[type="text"], textarea').forEach(el => {
      el.value = '';
      el.removeAttribute('value');
      el.textContent = '';
    });
    const personRow = listRow.querySelector('tr.paragraphs-item-type-person')!.outerHTML;

    const api = (window as any).C;
    const snapshot = await api.captureNode(api.discoverSchema());
    return { snapshot, listRow: listRow.outerHTML, personRow };
  });
}

/**
 * Drupal 7's add-more, from the source's own markup. Each button answers mousedown, after
 * a delay, by rendering the next delta; each click is swallowed.
 */
async function installDrupalAjax(page: Page, templates: { listRow: string; personRow: string }) {
  await page.evaluate(({ listRow, personRow }) => {
    const renumber = (html: string, base: string, flat: string, idPart: string, from: number, to: number) => html
      .split(`${base}[und][${from}]`).join(`${base}[und][${to}]`)
      .split(`${flat}_und_${from}_`).join(`${flat}_und_${to}_`)
      .split(`${idPart}-und-${from}-`).join(`${idPart}-und-${to}-`);
    const later = (fn: () => void) => setTimeout(fn, 40);
    const swallowClick = (event: Event) => {
      const target = event.target as HTMLElement;
      if (target.matches('input[type="submit"]')) event.preventDefault();
    };
    document.addEventListener('click', swallowClick, true);

    document.addEventListener('mousedown', event => {
      const button = event.target as HTMLInputElement;
      if (!button.matches?.('input[type="submit"]')) return;
      const name = button.name;

      if (name === 'field_page_paragraphs_add_more_add_more') {
        const type = (document.querySelector('select[name="field_page_paragraphs_add_more_type"]') as HTMLSelectElement).value;
        if (type !== 'persons') return;
        const wrapper = document.getElementById('field-page-paragraphs-add-more-wrapper')!;
        let tbody = wrapper.querySelector('tbody.d7-test-items');
        const delta = tbody ? tbody.children.length : 0;
        later(() => {
          if (!tbody) {
            wrapper.querySelector('p')?.remove();
            const table = document.createElement('table');
            table.innerHTML = '<tbody class="d7-test-items"></tbody>';
            wrapper.prepend(table);
            tbody = table.querySelector('tbody');
          }
          tbody!.insertAdjacentHTML('beforeend', renumber(listRow, 'field_page_paragraphs', 'field_page_paragraphs', 'edit-field-page-paragraphs', 0, delta));
        });
        return;
      }

      const person = name.match(/^(field_page_paragraphs_und_(\d+)_field_persons_paragraphs)_add_more_add_more_bundle_person$/);
      if (person) {
        const outer = Number(person[2]);
        const base = `field_page_paragraphs[und][${outer}][field_persons_paragraphs]`;
        const rows = button.closest('.field-widget-paragraphs-embed')!.querySelector('tbody')!;
        const delta = rows.querySelectorAll(':scope > tr.paragraphs-item-type-person').length;
        later(() => {
          const html = renumber(
            renumber(personRow, 'field_page_paragraphs', 'field_page_paragraphs', 'edit-field-page-paragraphs', 0, outer),
            base, `field_page_paragraphs_und_${outer}_field_persons_paragraphs`, `edit-field-page-paragraphs-und-${outer}-field-persons-paragraphs`, 0, delta,
          );
          rows.insertAdjacentHTML('beforeend', html);
        });
        return;
      }

      const role = name.match(/^(.+)_field_person_position_add_more$/);
      if (role) {
        const table = button.closest('.field-widget-text-textfield')!.querySelector('tbody')!;
        const rows = table.querySelectorAll(':scope > tr');
        const last = rows[rows.length - 1];
        later(() => {
          const from = rows.length - 1;
          const html = last.outerHTML
            .split(`[field_person_position][und][${from}]`).join(`[field_person_position][und][${from + 1}]`)
            .split(`-field-person-position-und-${from}-`).join(`-field-person-position-und-${from + 1}-`);
          table.insertAdjacentHTML('beforeend', html);
          const added = table.lastElementChild!.querySelector<HTMLInputElement>('input[type="text"]');
          if (added) { added.value = ''; added.removeAttribute('value'); }
        });
      }
    }, true);
  }, templates);
}

test.describe('copying a People List between sites', () => {
  test('the copy keeps its shape: the list, its people, and each person\'s own fields', async ({ page }) => {
    const { snapshot } = await copySource(page);
    const [widget] = snapshot.paragraphs;
    expect(widget.baseName).toBe('field_page_paragraphs');
    expect(widget.items).toHaveLength(1);

    const [list] = widget.items;
    expect(list.bundle).toBe('persons');
    expect(list.bundleFrom).toBe('row-class');
    // Only the list's own fields — no person's fields flattened into it.
    expect(list.fields.every((f: any) => !f.machineName.startsWith('field_persons_paragraphs'))).toBe(true);

    const persons = list.children.find((c: any) => c.baseName === 'field_persons_paragraphs');
    expect(persons.label).toBe('Persons');
    expect(persons.items).toHaveLength(8);
    expect(persons.items.every((p: any) => p.bundle === 'person' && p.bundleFrom === 'row-class')).toBe(true);
    const names = (p: any) => p.fields.map((f: any) => f.machineName);
    expect(names(persons.items[1])).toContain('field_person_position[und][1][value]');
  });

  test('the people\'s photos are in the image checklist, named for each person', async ({ page }) => {
    const { snapshot } = await copySource(page);
    const portraits = snapshot.media.filter((m: any) => m.label.startsWith('Image —'));
    expect(portraits).toHaveLength(8);
    expect(portraits.map((m: any) => m.label)).toContain('Image — Person 1');
    // Six of the eight have a photo on the source.
    expect(portraits.filter((m: any) => m.fid || m.url)).toHaveLength(6);
  });

  test('pasting rebuilds all eight people, with their roles and bios', async ({ page }) => {
    const { snapshot, listRow, personRow } = await copySource(page);
    await load(page, NURSING, 'clone/page-nursing-empty-paragraphs.html');
    await installDrupalAjax(page, { listRow, personRow });

    const outcome = await page.evaluate(widget => (window as any).C.rebuildParagraphs(widget), snapshot.paragraphs[0]);
    const form = await page.evaluate(() => {
      const value = (name: string) => (document.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.value ?? null;
      const person = (k: number) => `field_page_paragraphs[und][0][field_persons_paragraphs][und][${k}]`;
      return {
        title: value('field_page_paragraphs[und][0][field_title][und][0][value]'),
        names: Array.from({ length: 8 }, (_, k) => value(`${person(k)}[field_person_full_name][und][0][value]`)),
        secondRole: value(`${person(1)}[field_person_position][und][1][value]`),
        profile: value(`${person(0)}[field_cola_cups_pofile][und][0][target_id]`),
        bios: (window as any).__sent.filter((m: any) => m.type === 'syncRichEditor').map((m: any) => m.value),
      };
    });

    expect(outcome.items).toHaveLength(1);
    expect(outcome.items[0].nested[0]).toEqual({ label: 'Persons', added: 8, total: 8 });
    expect(form.title).toBe('Our Team');
    expect(form.names).toEqual(['Person 1', 'Person 2', 'Person 3', 'Person 4', 'Person 5', 'Person 6', 'Person 7', 'Person 8']);
    expect(form.secondRole).toBe('Second role');
    expect(form.bios).toContain('<p>Bio 8</p>');
    // Never the SOURCE site's node id: that number names a different node here.
    expect(form.profile ?? '').not.toContain('(123)');
  });
});
