import { isNodeFormPath } from '../formSchema';
import { loadCopies } from './clipboard';

/**
 * Whether a paste is possible here, and how the palette reaches it.
 *
 * An indirection, for one reason: commands.ts must stay free of React. It is imported
 * directly by tests that run in Node, and the review panel it would otherwise have to
 * import pulls in React, ReactDOM and the overlay injector. So the content script
 * registers the handler at startup and the command calls through this.
 */

/**
 * How many copies are waiting.
 *
 * Cached rather than read on demand because Command.isAvailable is synchronous — the
 * palette decides what to list without awaiting anything. Refreshed at content-script
 * startup and again whenever a copy is made, so the only staleness left is another tab
 * copying a page while this one sits open.
 */
let copies = 0;

export function copiesAvailable(): number {
  return copies;
}

export async function refreshCopies(): Promise<number> {
  try {
    const state = await loadCopies();
    copies = state.copies.length;
  } catch {
    // An invalidated extension context is not worth surfacing here; the command simply
    // will not be offered.
    copies = 0;
  }
  return copies;
}

/** Called after a successful copy, so the palette offers Paste without a reload. */
export function noteCopySaved(count: number): void {
  copies = Math.max(copies, count);
}

/**
 * Offered on any node form, add or edit.
 *
 * Edit is deliberately included: pasting over a half-finished page is a real thing to
 * want, and every write still goes through the review first.
 */
export function canPasteHere(location: Pick<Location, 'pathname'> = window.location): boolean {
  return isNodeFormPath(location) && copiesAvailable() > 0;
}

type PasteHandler = () => Promise<void>;

let handler: PasteHandler | null = null;

export function registerPasteHandler(next: PasteHandler): void {
  handler = next;
}

export async function runPaste(): Promise<void> {
  if (!handler) {
    throw new Error(
      'The paste review could not start on this page. Reload and try again.'
    );
  }
  await handler();
}
