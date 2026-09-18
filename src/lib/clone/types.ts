import { FieldValue } from '../fieldBinding';
import { FieldKind, SectionId } from '../formSchema';

/**
 * A page lifted off one site's node form, in a shape the other site can be matched
 * against.
 *
 * The whole design rests on one fact: NOTHING site-local may be stored as a value to
 * write. A term id, a node id, a file id and a menu position all mean something
 * different (or nothing) on the destination, so the snapshot stores the human-readable
 * identity instead — option LABELS rather than option values, filenames and URLs rather
 * than file ids. Matching then resolves those against whatever the destination calls
 * them. See match.ts.
 */

/**
 * An image attached to the source node.
 *
 * Deliberately NOT a field value. Every image field on these sites is a Media-module
 * widget backed by a file id, verified across all nine captured content types — there is
 * not one `<input type="file">` among them. A file id is a row in the source site's
 * database, so it can never be written to the destination. What travels is enough
 * information for a person to find and re-attach the file.
 */
export interface MediaRef {
  /** e.g. `field_image_teaser`. */
  baseName: string;
  label: string;
  /**
   * The source site's file id. Recorded for provenance only, and never written
   * anywhere. It is in the snapshot so the review can say which file it was.
   */
  fid: string | null;
  filename: string;
  /** Absolute URL of the ORIGINAL file, derived from the thumbnail. Null when undecidable. */
  url: string | null;
  /** The derivative actually found in the widget, absolute. */
  thumbnailUrl: string | null;
}

export interface CapturedField {
  machineName: string;
  baseName: string;
  label: string;
  kind: FieldKind;
  section: SectionId;
  required: boolean;
  multiValue: boolean;
  value: FieldValue;
  /**
   * Labels of the SELECTED options, for choice widgets — the cross-site identity of a
   * taxonomy term.
   *
   * Two sites both have a "Nephrology" term and both call it that; the term ids will not
   * agree, and writing the source's id would either select the wrong term or silently
   * select nothing. Null for widgets that have no options.
   */
  optionLabels: string[] | null;
}

/** One item inside a Paragraphs widget. */
export interface CapturedParagraph {
  /** Bundle machine name, e.g. `text`. Must exist on the destination to be rebuilt. */
  bundle: string;
  /** What the add-more select called it, e.g. "Text". For the review. */
  bundleLabel: string;
  /**
   * How the type was determined — see BundleSource in paragraphs.ts.
   *
   * Carried through to the review because the markup of a populated subform has not been
   * captured from a real site. An item whose type was INFERRED from its field names is a
   * weaker claim than one that read Drupal's own record of it, and the difference has to
   * be visible rather than averaged away.
   */
  bundleFrom: 'bundle-input' | 'subform-class' | 'field-name' | 'unknown';
  /** Position in the source widget, so order survives the rebuild. */
  delta: number;
  /**
   * The subform's own fields, with names made RELATIVE to the paragraph prefix — so
   * `field_page_paragraphs[und][2][field_text][und][0][value]` is stored as
   * `field_text[und][0][value]`. The destination will render this item at a different
   * delta, and an absolute name would point at the wrong one.
   */
  fields: CapturedField[];
}

export interface CapturedParagraphField {
  /** e.g. `field_page_paragraphs`. */
  baseName: string;
  label: string;
  items: CapturedParagraph[];
}

/**
 * Bumped whenever the shape above changes incompatibly.
 *
 * A copy sits in chrome.storage.local until it is used, which may be across an extension
 * update. Reading an older shape as though it were current is how a paste would fill
 * fields from a structure it has misunderstood, so an unrecognised version is refused
 * outright rather than best-guessed.
 */
export const SNAPSHOT_VERSION = 1;

export interface NodeSnapshot {
  version: number;
  sourceUrl: string;
  sourceOrigin: string;
  /** Machine name of the source content type, e.g. `page`. Null when undetectable. */
  contentType: string | null;
  /** The source node's title, so the clipboard list is readable. */
  title: string;
  capturedAt: number;
  fields: CapturedField[];
  paragraphs: CapturedParagraphField[];
  media: MediaRef[];
  /**
   * Things seen on the source form and deliberately not captured, with the reason.
   *
   * Reported rather than dropped: a paste that quietly omits something looks complete
   * while being wrong, and this is the list the review shows under "Left for you".
   */
  omitted: { label: string; reason: string }[];
}
