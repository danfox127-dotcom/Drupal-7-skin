/**
 * What the copy/paste commands can do at a given URL.
 *
 * Its own module because TWO callers need the same answer and neither should own it: the
 * content script knows the DOM but not the popup, and the popup knows the active tab's
 * URL but cannot read its DOM. Both decide button state from the path alone, so the
 * rules live here once rather than being re-derived and drifting apart.
 */

/** True on a node edit form, which is the only page with a page worth copying. */
export function canCopyFrom(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return /\/node\/\d+\/edit/.test(pathname);
}

/**
 * True on any node form, add or edit.
 *
 * Edit is included deliberately: pasting over a half-finished page is a real thing to
 * want, and every write still goes through the review first.
 */
export function canPasteInto(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (/\/node\/add\/[a-z0-9-_]+/i.test(pathname)) return true;
  return /\/node\/\d+\/edit/.test(pathname);
}

/** A short description of the form, for a button that has to say where it will act. */
export function describeTarget(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const add = pathname.match(/\/node\/add\/([a-z0-9-_]+)/i);
  if (add) return `new ${add[1].replace(/-/g, ' ')}`;
  const edit = pathname.match(/\/node\/(\d+)\/edit/);
  if (edit) return `node ${edit[1]}`;
  return null;
}
