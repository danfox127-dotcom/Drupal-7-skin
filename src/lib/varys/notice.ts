/**
 * The notice shown in the page after a save is sent to Varys.
 *
 * ⚠️ SELF-CONTAINED, and it must stay so. The service worker passes showVarysNotice to
 * chrome.scripting.executeScript as `func`, which sends the function's SOURCE TEXT to the tab
 * and runs it there. Anything it names from outside its own body (an import, a constant in
 * this file, a helper) does not exist on the other side, and the call throws in the page. So
 * there are no imports, and the parameter's type is spelled out here rather than imported.
 * tests/varys-notice.spec.ts runs it from its minified source text in a bare page to hold
 * this, and tests/extension.test.ts runs it through the real injection.
 *
 * Inline styles in a shadow root: no stylesheet travels with the function, and the page's own
 * CSS cannot reach in. The colours are the tokens' (src/styles/tokens.js), written out for the
 * same reason: ink #1A1A1A on white, Columbia Blue #1D4F91 for the action, and the control
 * border #8B8B8A.
 *
 * The action button asks the worker (varysUndo / varysLogAnyway), which calls Varys, and the
 * notice then says what Varys answered. Log it anyway turns into Undo once the save counts;
 * an action that did not go through keeps its button, so it can be tried again.
 */
export function showVarysNotice(n: {
  message: string;
  action?: { label: 'Undo' | 'Log it anyway'; type: 'varysUndo' | 'varysLogAnyway'; saveId: number };
}): void {
  const HOST_ID = 'd7-varys-notice';
  const VISIBLE_MS = 10_000;

  // One notice at a time: a second save's answer replaces the first's.
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });

  const panel = document.createElement('div');
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');
  panel.style.cssText = [
    'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:2147483647', 'box-sizing:border-box', 'max-width:calc(100vw - 32px)',
    'display:flex', 'align-items:center', 'gap:16px', 'padding:12px 12px 12px 20px',
    'background:#FFFFFF', 'color:#1A1A1A', 'border:1px solid #8B8B8A',
    'box-shadow:0 4px 16px rgba(26,26,26,0.18)',
    'font:500 14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
  ].join(';');

  const text = document.createElement('span');
  text.textContent = n.message;
  panel.appendChild(text);

  let timer = 0;
  const dismiss = () => {
    window.clearTimeout(timer);
    host.remove();
  };
  const startTimer = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(dismiss, VISIBLE_MS);
  };
  // Held open while it is being used: a notice that vanishes under the pointer, or from under
  // keyboard focus on its button, takes the Undo with it.
  panel.addEventListener('mouseenter', () => window.clearTimeout(timer));
  panel.addEventListener('mouseleave', startTimer);
  panel.addEventListener('focusin', () => window.clearTimeout(timer));
  panel.addEventListener('focusout', startTimer);

  const buttonStyle = 'flex:none;cursor:pointer;font:inherit;font-weight:600;padding:6px 14px;';

  let action = n.action;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.style.cssText = `${buttonStyle}border:1px solid #1D4F91;background:#1D4F91;color:#FFFFFF`;
    button.addEventListener('click', () => {
      const asked = action;
      if (!asked) return;
      button.disabled = true;
      Promise.resolve(chrome.runtime.sendMessage({ type: asked.type, saveId: asked.saveId }))
        .then(
          (answer: { ok?: boolean; message?: unknown; action?: typeof action } | null | undefined) => {
            if (answer && typeof answer.message === 'string' && answer.message !== '') {
              text.textContent = answer.message;
            }
            if (answer?.ok && answer.action) {
              action = answer.action;
              button.textContent = answer.action.label;
              button.disabled = false;
            } else if (answer?.ok) {
              action = undefined;
              button.remove();
            } else {
              button.disabled = false;
            }
          },
          () => { button.disabled = false; },
        )
        .then(() => { if (!panel.matches(':hover') && !panel.contains(root.activeElement)) startTimer(); });
    });
    panel.appendChild(button);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Dismiss';
  close.style.cssText = `${buttonStyle}border:1px solid transparent;background:transparent;color:#1D4F91`;
  close.addEventListener('click', dismiss);
  panel.appendChild(close);

  root.appendChild(panel);
  (document.body ?? document.documentElement).appendChild(host);
  startTimer();
}
