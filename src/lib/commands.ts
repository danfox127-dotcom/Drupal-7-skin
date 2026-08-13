import { canExportHere, copyPublicHtml } from './extractPublicHtml';

/**
 * The command registry behind the ⌘K palette.
 *
 * Only commands that actually work are registered. The prototype's palette also
 * lists "Save draft to Drupal", "Publish", and "Import from URL"; those belong to
 * the Phase 5 editor and Phase 6 import flow, and listing them now would render
 * rows that do nothing. They get added when their feature lands.
 *
 * `isAvailable` keeps context-specific commands out of the list rather than
 * letting them fail — "Copy public HTML of this node" is meaningless off a node
 * page, so it does not appear there.
 */

export type CommandGroup = 'Create' | 'Go to' | 'Run';

export interface Command {
  id: string;
  group: CommandGroup;
  label: string;
  /** Display-only shortcut hint, as the design specifies. Not bound yet. */
  keys: string;
  /** Path to navigate to, relative to the current origin. */
  path?: string;
  /** Side effect to run instead of navigating. */
  run?: () => Promise<void> | void;
  /** Confirmation shown on success, when the command has no visible result. */
  toast?: string;
  /** Omitted from the list when this returns false. Defaults to always shown. */
  isAvailable?: (location: Location) => boolean;
}

export const COMMANDS: Command[] = [
  // --- Create -------------------------------------------------------------
  // Content types confirmed against the real forms in the handoff's field
  // matrix. More types are coming; this list grows with the Phase 4 discovery
  // layer rather than being hand-maintained forever.
  { id: 'new-news',      group: 'Create', label: 'New News item',  keys: 'N then W', path: '/node/add/news' },
  { id: 'new-page',      group: 'Create', label: 'New Page',       keys: 'N then P', path: '/node/add/page' },
  { id: 'new-specialty', group: 'Create', label: 'New Specialty',  keys: 'N then S', path: '/node/add/specialty' },

  // --- Go to --------------------------------------------------------------
  { id: 'goto-content',  group: 'Go to', label: 'All content',        keys: 'G then C', path: '/admin/content' },
  { id: 'goto-menu',     group: 'Go to', label: 'Main menu manager',  keys: 'G then M', path: '/admin/structure/menu/manage/main-menu' },
  { id: 'goto-taxonomy', group: 'Go to', label: 'Taxonomy',           keys: 'G then T', path: '/admin/structure/taxonomy' },
  { id: 'goto-people',   group: 'Go to', label: 'Users',              keys: 'G then U', path: '/admin/people' },
  { id: 'goto-config',   group: 'Go to', label: 'Configuration',      keys: 'G then S', path: '/admin/config' },

  // --- Run ----------------------------------------------------------------
  {
    id: 'copy-html',
    group: 'Run',
    label: 'Copy public HTML of this node',
    keys: '⇧⌘C',
    isAvailable: canExportHere,
    run: () => copyPublicHtml(),
    toast: 'Public HTML copied to the clipboard.',
  },
];

/** Group order in the palette, matching the prototype. */
export const GROUP_ORDER: CommandGroup[] = ['Create', 'Go to', 'Run'];

/** Commands valid at this location, in group order. */
export function availableCommands(location: Location = window.location): Command[] {
  const usable = COMMANDS.filter(c => !c.isAvailable || c.isAvailable(location));
  return [...usable].sort(
    (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)
  );
}

/**
 * Case-insensitive substring match on the label, the uniform search behavior the
 * handoff specifies for every filter in the product. The group name is matched
 * too, so typing "go to" narrows to navigation.
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    c => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
  );
}
