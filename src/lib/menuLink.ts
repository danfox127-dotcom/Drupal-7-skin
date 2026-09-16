/**
 * Placing a node in a menu, as one rule in one place.
 *
 * Drupal 7 gates the entire menu fieldset on `menu[enabled]` — the "Provide a menu link"
 * checkbox, unticked by default and captioned "Not in menu". While it is unticked,
 * menu_node_save() discards the parent and the link title on save and reports nothing
 * back. Writing `menu[parent]` on its own therefore sets a value Drupal has already
 * decided to ignore, and the editor finds out only by returning to the page later.
 *
 * The two-pane node editor handled this. The standalone searchable parent picker did not,
 * and the picker is ON by default while the editor is OFF by default — so the path almost
 * everyone actually used was the broken one, and the fix that existed was in the path
 * almost nobody had switched on. That is why this lives here rather than in either
 * component: the rule is Drupal's, not a property of whichever widget set the parent.
 *
 * Works on raw DOM rather than the schema's FieldDescriptors, so the standalone picker
 * can call it on pages where full schema discovery is not attempted.
 */

/** Core's menu module always renders these names, so they are safe to match on. */
const ENABLED = 'menu[enabled]';
const LINK_TITLE = 'menu[link_title]';

/**
 * Where the node's own title lives, best first.
 *
 * These sites run the Title module, which replaces core's `title` with a real field —
 * so `title_field[und][0][value]` is what is actually present. Core's `title` is kept as
 * a fallback for any site that does not.
 */
const NODE_TITLE_NAMES = ['title_field[und][0][value]', 'title'];

export interface MenuLinkOutcome {
  /** True only when this call changed the checkbox from unticked to ticked. */
  ticked: boolean;
  /** The link title written, or null when none was needed or none was available. */
  titleWritten: string | null;
  /** Expected controls that were not on the form. Empty on a normal node form. */
  missing: string[];
}

/** Drupal's #states JavaScript listens for these; assigning the property is not enough. */
function notify(el: HTMLElement) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function find<T extends HTMLElement>(root: ParentNode, name: string): T | null {
  // Drupal names carry brackets, which are valid inside an attribute selector's quotes.
  return root.querySelector<T>(`[name=${JSON.stringify(name)}]`);
}

function nodeTitleOf(root: ParentNode): string {
  for (const name of NODE_TITLE_NAMES) {
    const el = find<HTMLInputElement>(root, name);
    const value = el?.value?.trim();
    if (value) return value;
  }
  return '';
}

/**
 * Makes a chosen menu parent actually stick.
 *
 * Call after writing `menu[parent]`. Safe to call when the controls are absent — not
 * every content type exposes the menu fieldset, and an editor without "administer menu"
 * gets the form without it — so it reports what it could not find instead of throwing.
 */
export function enableMenuLink(root: ParentNode = document): MenuLinkOutcome {
  const outcome: MenuLinkOutcome = { ticked: false, titleWritten: null, missing: [] };

  const enabled = find<HTMLInputElement>(root, ENABLED);
  if (!enabled) {
    outcome.missing.push(ENABLED);
  } else if (!enabled.checked) {
    enabled.checked = true;
    notify(enabled);
    outcome.ticked = true;
  }

  /**
   * And a link title, which Drupal requires once the link is enabled.
   *
   * Ticking the box alone would trade silent loss for a validation error on save, which
   * is more visible but no more useful. The node's own title is what an editor would
   * type, and the field stays editable if they want something shorter.
   */
  const linkTitle = find<HTMLInputElement>(root, LINK_TITLE);
  if (!linkTitle) {
    outcome.missing.push(LINK_TITLE);
  } else if (!linkTitle.value.trim()) {
    // Never overwrite a title the editor typed themselves — that would be worse than
    // the bug this fixes.
    const title = nodeTitleOf(root);
    if (title) {
      linkTitle.value = title;
      notify(linkTitle);
      outcome.titleWritten = title;
    }
  }

  return outcome;
}
