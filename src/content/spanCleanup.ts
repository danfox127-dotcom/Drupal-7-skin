import { stripSpans } from '../lib/stripSpans';
import type { ReadRichEditorResponse } from '../background';

/**
 * A "Remove span tags" button under every formatted text field.
 *
 * Pasting from Word, Google Docs or another web page wraps the text in
 * `<span style="…">`, and the only native way out is the Source view, by hand. The button
 * unwraps every span in the field and keeps the text. It only runs when clicked, and it
 * offers its own Undo, because the editor's undo history cannot be counted on to include
 * a change made from outside it.
 *
 * Light DOM, inside the field's own text-format wrapper. That wrapper is what the two-pane
 * editor relocates, so the button moves with the field and shows in both the native form
 * and the editor. It has no name, so the form walker does not mistake it for a field, and
 * it is type="button", so it never submits the form.
 */

const MARK = 'data-d7-span-cleanup';

/**
 * The value textareas of formatted text fields. The summary shares the body's wrapper but
 * is a plain-text teaser, so it is left out.
 */
const candidates = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLTextAreaElement>('.text-format-wrapper textarea'))
    .filter(textarea => !textarea.classList.contains('text-summary') && !textarea.hasAttribute(MARK));

async function readHtml(textarea: HTMLTextAreaElement): Promise<{ html: string; rich: boolean }> {
  if (textarea.id) {
    try {
      const res: ReadRichEditorResponse | undefined = await chrome.runtime.sendMessage({
        type: 'readRichEditor', elementId: textarea.id,
      });
      if (res?.ok && res.editor !== 'none' && typeof res.value === 'string') {
        return { html: res.value, rich: true };
      }
    } catch {
      // No bridge (an invalidated context); the textarea is the best answer left.
    }
  }
  return { html: textarea.value, rich: false };
}

/** Writes the textarea first, then the editor that owns it, as the field binder does. */
async function writeHtml(textarea: HTMLTextAreaElement, html: string, rich: boolean): Promise<boolean> {
  textarea.value = html;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  if (!rich) return true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'syncRichEditor', elementId: textarea.id, value: html });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

function addButton(textarea: HTMLTextAreaElement): void {
  textarea.setAttribute(MARK, '');

  const bar = document.createElement('div');
  bar.className = 'd7-span-cleanup';
  bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin:6px 0;font-size:13px;line-height:1.4;';

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Remove span tags';
  button.setAttribute(MARK + '-button', '');
  button.style.cssText = 'font:inherit;font-size:13px;padding:4px 10px;border:1px solid #9aa5b1;'
    + 'border-radius:3px;background:#fff;color:#1d4f91;cursor:pointer;';

  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.setAttribute(MARK + '-status', '');
  status.style.color = '#4a4a4a';

  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = 'Undo';
  undo.hidden = true;
  undo.setAttribute(MARK + '-undo', '');
  undo.style.cssText = 'font:inherit;font-size:13px;padding:0;border:0;background:none;'
    + 'color:#1d4f91;text-decoration:underline;cursor:pointer;';

  let previous: { html: string; rich: boolean } | null = null;

  button.addEventListener('click', async () => {
    button.disabled = true;
    undo.hidden = true;
    try {
      const current = await readHtml(textarea);
      const { html, removed } = stripSpans(current.html);
      if (removed === 0) {
        status.textContent = 'No span tags to remove.';
        return;
      }
      if (!(await writeHtml(textarea, html, current.rich))) {
        status.textContent = 'Could not update the editor. Nothing was changed.';
        await writeHtml(textarea, current.html, false);
        return;
      }
      previous = current;
      status.textContent = `Removed ${removed} span tag${removed === 1 ? '' : 's'}.`;
      undo.hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  undo.addEventListener('click', async () => {
    if (!previous) return;
    undo.hidden = true;
    const ok = await writeHtml(textarea, previous.html, previous.rich);
    status.textContent = ok ? 'Span tags put back.' : 'Could not put the span tags back.';
    if (ok) previous = null;
  });

  bar.append(button, status, undo);

  // Below the editor, above the text format selector.
  const anchor = textarea.closest('.form-textarea-wrapper') ?? textarea;
  anchor.after(bar);
}

/** Adds the button now, and to any formatted field Drupal's AJAX adds later. */
export function mountSpanCleanup(form: HTMLElement): () => void {
  candidates(form).forEach(addButton);

  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      candidates(form).forEach(addButton);
    });
  });
  observer.observe(form, { childList: true, subtree: true });
  return () => observer.disconnect();
}
