import { test, expect } from '@playwright/test';
import {
  parseMenuWeights, siblingsUnder, orderSiblings, positionOf, weightForPosition,
  fetchSiblingWeights, MenuSibling,
} from '../src/lib/menuPosition';

/**
 * Menu Placement's Position list: where this page lands among its siblings, and which
 * weight puts it somewhere else.
 *
 * The node form carries only THIS link's weight. Sibling order comes from the parent
 * select, which Drupal sorts; sibling weights come from the menu admin page. The ordering
 * rule mirrors Drupal 7's _menu_tree_check_access, which sorts siblings by the string key
 * `(50000 + weight) . ' ' . title . ' ' . mlid`.
 */

const weightSelect = (name: string, selected: number) =>
  `<select name="${name}" class="menu-weight">`
  + [-2, -1, 0, 1, 2].map(w => `<option value="${w}"${w === selected ? ' selected="selected"' : ''}>${w}</option>`).join('')
  + '</select>';

test.describe('parseMenuWeights', () => {
  test('reads core\'s mlid:N[weight] selects', () => {
    const html = weightSelect('mlid:12[weight]', -1) + weightSelect('mlid:40[weight]', 2);
    expect(parseMenuWeights(html)).toEqual(new Map([['12', -1], ['40', 2]]));
  });

  test('reads the menu[mlid:N][weight] shape too', () => {
    expect(parseMenuWeights(weightSelect('menu[mlid:900][weight]', 1))).toEqual(new Map([['900', 1]]));
  });

  test('a select with no selected option is weight 0, which is what the browser submits', () => {
    const html = '<select name="mlid:7[weight]"><option value="0">0</option><option value="1">1</option></select>';
    expect(parseMenuWeights(html).get('7')).toBe(0);
  });

  test('selected can come before value', () => {
    const html = '<select name="mlid:7[weight]"><option value="0">0</option><option selected value="1">1</option></select>';
    expect(parseMenuWeights(html).get('7')).toBe(1);
  });

  test('pulls rows out of a Drupal AJAX response, which BigMenu subtrees arrive as', () => {
    const json = JSON.stringify([
      { command: 'settings', settings: {} },
      { command: 'insert', method: 'replaceWith', data: weightSelect('mlid:55[weight]', 2) },
    ]);
    expect(parseMenuWeights(json)).toEqual(new Map([['55', 2]]));
  });
});

const PARENT_OPTIONS = [
  { value: 'main-menu:0', label: '<Main Menu>', depth: 0, selected: false },
  { value: 'main-menu:10', label: 'About Us', depth: 1, selected: false },
  { value: 'main-menu:11', label: 'Annual Report', depth: 2, selected: false },
  { value: 'main-menu:12', label: "Dean's Message", depth: 3, selected: false },
  { value: 'main-menu:13', label: 'Leadership', depth: 2, selected: false },
  { value: 'main-menu:20', label: 'Our Locations', depth: 1, selected: false },
];

test.describe('siblingsUnder', () => {
  test('lists direct children only, not grandchildren', () => {
    expect(siblingsUnder(PARENT_OPTIONS, 'main-menu:10').map(s => s.title))
      .toEqual(['Annual Report', 'Leadership']);
  });

  test('the menu root\'s children are the top level', () => {
    expect(siblingsUnder(PARENT_OPTIONS, 'main-menu:0').map(s => s.mlid)).toEqual(['10', '20']);
  });

  test('a leaf has no siblings under it', () => {
    expect(siblingsUnder(PARENT_OPTIONS, 'main-menu:12')).toEqual([]);
  });

  test('works on the live select, which marks each level with TWO hyphens', () => {
    // Shape from captured/page.html: "-- About Us", "---- Annual Report …", so the walker's
    // raw hyphen count steps 0, 2, 4, 6 rather than 0, 1, 2, 3.
    const live = [
      { value: 'main-menu:0', label: '<Main Menu>', depth: 0, selected: true },
      { value: 'main-menu:12216', label: 'About Us', depth: 2, selected: false },
      { value: 'main-menu:71365', label: 'Annual Report 2021-2022 (disabled)', depth: 4, selected: false },
      { value: 'main-menu:71368', label: "Dean's Message", depth: 6, selected: false },
      { value: 'main-menu:71369', label: 'Leadership Message', depth: 6, selected: false },
      { value: 'main-menu:12300', label: 'Patient Care', depth: 2, selected: false },
    ];
    expect(siblingsUnder(live, 'main-menu:0').map(s => s.title)).toEqual(['About Us', 'Patient Care']);
    expect(siblingsUnder(live, 'main-menu:71365').map(s => s.title))
      .toEqual(["Dean's Message", 'Leadership Message']);
  });

  test('strips Drupal\'s "(disabled)" suffix from the title but remembers it', () => {
    const options = [
      { value: 'main-menu:0', label: '<Main Menu>', depth: 0, selected: false },
      { value: 'main-menu:5', label: 'Old page (disabled)', depth: 1, selected: false },
    ];
    expect(siblingsUnder(options, 'main-menu:0')).toEqual([{ mlid: '5', title: 'Old page', disabled: true }]);
  });
});

const sib = (mlid: string, title: string, weight: number): MenuSibling & { weight: number } =>
  ({ mlid, title, disabled: false, weight });

test.describe('Drupal\'s sibling order', () => {
  test('weight first, then title, then mlid as a STRING', () => {
    const order = orderSiblings([
      sib('5', 'Beta', 0), sib('12', 'Alpha', 0), sib('3', 'Zed', -1), sib('40', 'Alpha', 0),
    ]).map(s => s.mlid);
    // "12" < "40" as strings, and Zed's -1 beats every title.
    expect(order).toEqual(['3', '12', '40', '5']);
  });

  test('a new link, with no mlid yet, sorts after an existing one of the same weight and title', () => {
    const siblings = [sib('9', 'Same', 0)];
    expect(positionOf(siblings, { title: 'Same', weight: 0 })).toBe(1);
  });
});

test.describe('weightForPosition', () => {
  const WEIGHTS = [-2, -1, 0, 1, 2];
  const siblings = [sib('1', 'Apple', 0), sib('2', 'Cherry', 0), sib('3', 'Plum', 1)];

  test('keeps the current weight when the page is already there', () => {
    // "Banana" at weight 0 already sorts between Apple and Cherry.
    expect(weightForPosition(siblings, { title: 'Banana', weight: 0 }, 1, WEIGHTS)).toBe(0);
  });

  test('moving to the top picks a weight below the first sibling', () => {
    expect(weightForPosition(siblings, { title: 'Banana', weight: 0 }, 0, WEIGHTS)).toBe(-1);
  });

  test('moving to the bottom picks a weight above the last sibling', () => {
    expect(weightForPosition(siblings, { title: 'Banana', weight: 0 }, 3, WEIGHTS)).toBe(2);
  });

  test('a slot between two equal-weight siblings that the title cannot reach is null', () => {
    // Between Apple(0) and Cherry(0) needs weight 0 and a title between them; "Zucchini" is not.
    expect(weightForPosition(siblings, { title: 'Zucchini', weight: 2 }, 1, WEIGHTS)).toBeNull();
  });

  test('every weight it returns really lands the page at that index', () => {
    const self = { title: 'Mango', weight: 0 };
    for (let index = 0; index <= siblings.length; index++) {
      const weight = weightForPosition(siblings, self, index, WEIGHTS);
      if (weight === null) continue;
      expect(positionOf(siblings, { ...self, weight })).toBe(index);
    }
  });

  test('never returns a weight the select does not offer', () => {
    const heavy = [sib('1', 'A', 2), sib('2', 'B', 2)];
    // "Aa" at weight 2 sorts between A and B. Above A is reachable at 1, the offered
    // weight nearest the gap; below B would need 3, which is not offered.
    const self = { title: 'Aa', weight: 2 };
    expect(positionOf(heavy, self)).toBe(1);
    expect(weightForPosition(heavy, self, 0, WEIGHTS)).toBe(1);
    expect(weightForPosition(heavy, self, 2, WEIGHTS)).toBeNull();
  });
});

test.describe('fetchSiblingWeights', () => {
  test('reads the overview page when it already holds every sibling', async () => {
    const urls: string[] = [];
    const weights = await fetchSiblingWeights('main-menu', '0', ['10', '20'], async url => {
      urls.push(url);
      return weightSelect('mlid:10[weight]', 1) + weightSelect('mlid:20[weight]', -1);
    });
    expect(weights).toEqual(new Map([['10', 1], ['20', -1]]));
    expect(urls).toEqual(['/admin/structure/menu/manage/main-menu']);
  });

  test('falls through to BigMenu\'s subtree for a parent the overview did not render', async () => {
    const urls: string[] = [];
    const weights = await fetchSiblingWeights('main-menu', '950', ['951', '952'], async url => {
      urls.push(url);
      return url.endsWith('/subform/950')
        ? JSON.stringify([{ command: 'insert', data: weightSelect('mlid:951[weight]', 0) + weightSelect('mlid:952[weight]', 2) }])
        : weightSelect('mlid:950[weight]', 0);
    });
    expect(weights).toEqual(new Map([['951', 0], ['952', 2]]));
    expect(urls).toEqual([
      '/admin/structure/menu/manage/main-menu',
      '/admin/structure/menu/manage/main-menu/bigmenu-customize/subform/950',
    ]);
  });

  test('returns null rather than a partial answer', async () => {
    const weights = await fetchSiblingWeights('main-menu', '0', ['10', '20'], async () =>
      weightSelect('mlid:10[weight]', 1));
    expect(weights).toBeNull();
  });

  test('a failed request is null, not a throw', async () => {
    const weights = await fetchSiblingWeights('main-menu', '0', ['10'], async () => {
      throw new Error('403');
    });
    expect(weights).toBeNull();
  });

  test('no siblings needs no request', async () => {
    let called = false;
    const weights = await fetchSiblingWeights('main-menu', '0', [], async () => { called = true; return ''; });
    expect(weights).toEqual(new Map());
    expect(called).toBe(false);
  });
});
