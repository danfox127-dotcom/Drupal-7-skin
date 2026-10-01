import React, { useId } from 'react';
import { Info } from 'lucide-react';

/**
 * Help text behind an info icon, for the rail.
 *
 * The condensed rail moves each field's paragraph of help into an icon beside its label,
 * so the rail reads as a list of controls rather than a wall of captions. The text has to
 * stay reachable without a mouse — WCAG 2.2 AA is mandatory here — so the icon is a real
 * button, the tooltip opens on focus as well as hover, and the text is wired to the
 * button with aria-describedby so a screen reader announces it without opening anything.
 *
 * No aria-expanded: the tooltip is not a disclosure, and tests (and the editor's own
 * slot check) treat every aria-expanded="false" control as something to open.
 */
export function InfoTip({ text, about }: { text: string; about: string }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={`About ${about}`}
        aria-describedby={id}
        data-info-tip
        className="inline-flex text-ink-muted hover:text-cu-blue focus-visible:text-cu-blue"
      >
        <Info size={14} aria-hidden />
      </button>
      <span
        id={id}
        role="tooltip"
        className="invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 transition-opacity duration-200 ease-studio absolute left-0 top-full mt-1 z-50 w-64 px-3 py-2 bg-ink text-white text-help font-normal normal-case tracking-normal rounded shadow-modal"
      >
        {text}
      </span>
    </span>
  );
}

/**
 * Whether fields render their help as an InfoTip rather than a caption.
 *
 * Context, like SlottedFieldsContext, so the rail can switch every field inside it at once
 * — TopicsSection and MenuSection included — without each one threading a prop. The
 * writing column leaves it off: help under the title or body is read, not looked up.
 */
export const HelpAsTipContext = React.createContext(false);
