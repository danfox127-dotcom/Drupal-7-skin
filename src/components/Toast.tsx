import React, { useEffect } from 'react';

interface Props {
  message: string;
  onDismiss: () => void;
  /** Auto-dismiss delay. The handoff shows a Dismiss action, so this is a
   *  backstop rather than the primary way out. */
  timeoutMs?: number;
}

/**
 * Bottom-center toast: #1A1A1A surface, white 500 14px, 12px 20px padding, with a
 * Columbia Blue Dismiss action — the handoff's spec.
 *
 * Dismiss is a real button rather than only a timeout, so a slow reader is not
 * forced to catch it.
 */
export const Toast = ({ message, onDismiss, timeoutMs = 6000 }: Props) => {
  useEffect(() => {
    const id = window.setTimeout(onDismiss, timeoutMs);
    return () => window.clearTimeout(id);
  }, [onDismiss, timeoutMs]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6.5 left-1/2 -translate-x-1/2 z-[2147483647] flex items-center gap-4 bg-ink text-white font-sans font-medium text-[14px] px-5 py-3"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-cu-light font-semibold uppercase text-eyebrow tracking-[.1em] hover:text-white transition-colors duration-200 ease-studio"
      >
        Dismiss
      </button>
    </div>
  );
};
