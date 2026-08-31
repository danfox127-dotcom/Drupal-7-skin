/**
 * Whether a rich editor is attached to a specific element.
 *
 * Its own module, and typed on the element rather than on a FieldDescriptor, so both the
 * form walker and the field binder can ask without importing each other.
 */

/**
 * True when a rich editor is attached to THIS element.
 *
 * Scoped to the element, not to its wrapper. The previous version searched
 * `.text-format-wrapper` for any `.cke`, and core's text_textarea_with_summary puts the
 * value textarea, the Edit-summary textarea and the text-format select inside ONE such
 * wrapper — so all three reported an editor because the body had one. The summary was then
 * treated as a rich field it is not, and the format select likewise.
 *
 * CKEditor 4 names its container after the element it replaced, as both an id
 * (`cke_<id>`) and a class (`cke_editor_<id>`), so either is an exact answer.
 */
export function hasRichEditorOn(el: HTMLElement | undefined | null): boolean {
  if (!el || !el.id) return false;

  const doc = el.ownerDocument;
  if (doc.getElementById(`cke_${el.id}`)) return true;
  try {
    if (doc.querySelector(`.cke_editor_${CSS.escape(el.id)}`)) return true;
  } catch {
    // An id that cannot be escaped into a selector; fall through to the scoped search.
  }

  /**
   * Fallback for editors that do not name their container after the element: only trust a
   * `.cke`/`.ckeditor` inside a form-item holding exactly ONE control, which is what rules
   * out the shared text-format wrapper.
   */
  const item = el.closest('.form-item');
  if (!item) return false;
  if (item.querySelectorAll('textarea, input, select').length > 1) return false;
  return Boolean(item.querySelector('.cke, .ckeditor'));
}
