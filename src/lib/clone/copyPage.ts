import { discoverSchema, isNodeFormPath } from '../formSchema';
import { captureNode } from './snapshot';
import { saveCopy } from './clipboard';

/**
 * The "Copy this page" action behind the command palette.
 *
 * Lives here rather than in commands.ts for the same reason copyPublicHtml does: the
 * palette should register behaviour, not contain it.
 */

/**
 * True only on an EDIT form.
 *
 * A node/add form is a node form, so isNodeFormPath accepts it — but there is nothing on
 * it to copy. Offering the command there would store an empty snapshot and then report
 * success, which is worse than the command being absent.
 */
export function canCopyHere(location: Pick<Location, 'pathname'> = window.location): boolean {
  return isNodeFormPath(location) && /\/node\/\d+\/edit/.test(location.pathname);
}

export async function copyPage(): Promise<void> {
  const schema = discoverSchema();
  if (!schema) {
    throw new Error(
      'The fields on this form could not be read, so there is nothing to copy. '
      + 'Turn on "Log Form Schema" in the extension popup and reload to see why.'
    );
  }

  const snapshot = await captureNode(schema);

  if (snapshot.fields.length === 0) {
    throw new Error('No filled fields were found on this form, so nothing was copied.');
  }

  await saveCopy(snapshot);
}
