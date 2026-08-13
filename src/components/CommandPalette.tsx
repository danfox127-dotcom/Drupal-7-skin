import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Command, availableCommands, filterCommands } from '../lib/commands';
import { Toast } from './Toast';

interface Props {
  /** Called when the palette should close (Escape, scrim click, or after a run). */
  onClose: () => void;
}

/**
 * ⌘K command palette.
 *
 * Rows are not focusable: focus stays in the search input and selection is
 * conveyed with aria-activedescendant, which is the listbox pattern and makes the
 * focus trap trivial — there is only one focusable element inside the panel.
 */
export const CommandPalette = ({ onClose }: Props) => {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(
    () => filterCommands(availableCommands(), query),
    [query]
  );

  // Keep the selection in range as the query narrows the list.
  useEffect(() => {
    setSelected(prev => (prev >= results.length ? 0 : prev));
  }, [results.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runCommand = useCallback(async (command: Command) => {
    if (command.path) {
      window.location.href = window.location.origin + command.path;
      return;
    }

    if (!command.run) return;

    try {
      await command.run();
      if (command.toast) {
        // Keep the palette open just long enough to show the confirmation, since
        // a side-effect command has no other visible result.
        setToast(command.toast);
        return;
      }
      onClose();
    } catch (err) {
      setToast(err instanceof Error ? `Could not run that: ${err.message}` : 'Could not run that.');
    }
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(i => (results.length ? (i + 1) % results.length : 0));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(i => (results.length ? (i - 1 + results.length) % results.length : 0));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const command = results[selected];
      if (command) void runCommand(command);
      return;
    }

    // Only one focusable element inside the panel, so Tab has nowhere to go.
    // Swallowing it keeps focus from escaping to the underlying Drupal page.
    if (e.key === 'Tab') {
      e.preventDefault();
    }
  };

  // Scroll the selected row into view without moving focus off the input.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  let lastGroup: string | null = null;

  return (
    <>
      {/* Scrim. Clicking it closes, matching the prototype. */}
      <div
        className="fixed inset-0 z-[2147483646] flex justify-center"
        style={{ background: 'rgba(20, 32, 64, .45)', paddingTop: '130px' }}
        onMouseDown={e => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          className="w-[620px] max-w-[calc(100vw-32px)] h-fit bg-white border border-rule shadow-modal font-sans"
          onKeyDown={onKeyDown}
        >
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="d7-palette-list"
            aria-activedescendant={results[selected] ? `d7-cmd-${results[selected].id}` : undefined}
            aria-autocomplete="list"
            placeholder="Type a command…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full px-4.5 py-4 border-0 border-b border-rule-hair text-[16px] leading-[18px] text-ink placeholder:text-ink-placeholder outline-none"
          />

          <div
            ref={listRef}
            id="d7-palette-list"
            role="listbox"
            aria-label="Commands"
            className="max-h-80 overflow-y-auto"
          >
            {results.length === 0 ? (
              <div className="px-4.5 py-4 text-control text-ink-help">
                Nothing matches “{query}”.
              </div>
            ) : (
              results.map((command, index) => {
                // Group label renders once per group, in a fixed 74px column.
                const showGroup = command.group !== lastGroup;
                lastGroup = command.group;
                const isSelected = index === selected;

                return (
                  <div
                    key={command.id}
                    id={`d7-cmd-${command.id}`}
                    data-index={index}
                    role="option"
                    aria-selected={isSelected}
                    onMouseMove={() => setSelected(index)}
                    onMouseDown={e => {
                      // Keep focus in the input so the trap is not broken.
                      e.preventDefault();
                      void runCommand(command);
                    }}
                    className={`flex items-baseline gap-3 px-4.5 py-2 cursor-pointer transition-colors duration-200 ease-studio ${
                      isSelected ? 'bg-cu-tint' : 'bg-white'
                    }`}
                  >
                    <span className="w-[74px] shrink-0 text-[10.5px] leading-[1.2] font-semibold uppercase tracking-[.07em] text-cu-blue">
                      {showGroup ? command.group : ''}
                    </span>
                    <span className="flex-1 text-row-title text-ink">{command.label}</span>
                    <span className="shrink-0 font-mono text-help text-ink-placeholder">
                      {command.keys}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          <div className="px-4.5 py-2 border-t border-rule-hair text-help text-ink-help">
            ↑↓ to move · ⏎ to run · esc to close
          </div>
        </div>
      </div>

      {toast && (
        <Toast
          message={toast}
          onDismiss={() => {
            setToast(null);
            onClose();
          }}
        />
      )}
    </>
  );
};
