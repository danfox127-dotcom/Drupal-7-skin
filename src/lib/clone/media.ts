import { FieldDescriptor } from '../formSchema';
import { MediaRef } from './types';

/**
 * Reads the images attached to a node form, as references rather than as values.
 *
 * Why references: every image field on these sites is a Media-module widget. Checked
 * against all nine captured content types — there is not a single `<input type="file">`
 * among them, only `media[field_image_teaser_und_0]` text inputs and hidden
 * `field_image_teaser[und][0][fid]` inputs. A file id names a row in ONE site's
 * database, so nothing here can be copied to another site as a field value. What can
 * travel is the filename and a URL a person can fetch.
 */

/** Style derivative path segment: /styles/<style>/public/ or /private/. */
const STYLE_SEGMENT = /\/styles\/[^/]+\/(public|private)\//;

/**
 * The original file behind an image-style derivative.
 *
 * Drupal serves a resized copy from
 * `/sites/default/files/styles/thumbnail/public/2019/04/x.jpg`, and the original sits at
 * `/sites/default/files/2019/04/x.jpg`. The widget only ever shows the derivative, so
 * the original has to be derived — handing someone a 60x40 thumbnail to re-upload would
 * silently degrade every migrated image.
 *
 * Returns null for anything that is not a fetchable file: a `data:` URI (which is what
 * the scrubbed fixtures carry) is a placeholder, not an image on the source site.
 */
export function originalFileUrl(src: string, base: string): string | null {
  const raw = (src ?? '').trim();
  if (!raw) return null;
  if (/^data:/i.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  /**
   * The image-style token goes with the derivative, not the original. Left on, `?itok=`
   * makes the original 403 on sites that enforce it.
   */
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(STYLE_SEGMENT, '/');

  return url.toString();
}

/** Filename from a URL, without the query or path. */
function filenameFromUrl(url: string | null): string {
  if (!url) return '';
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return '';
  }
}

/**
 * The element that holds one image widget's parts.
 *
 * The field's own control may be the hidden fid (on a populated edit form, which is the
 * only place walkForm finds one) or the Media text input (on an add form), and the
 * thumbnail and filename are siblings of neither in a predictable way. So this walks out
 * to the widget wrapper Drupal builds around the whole thing.
 */
function widgetWrapper(el: HTMLElement): HTMLElement {
  return (el.closest(
    '.field-widget-media-generic, .media-widget, .form-type-media, .field-type-image, .form-item'
  ) as HTMLElement | null) ?? el.parentElement ?? el;
}

/** The first thumbnail in a widget that is a real file rather than a placeholder. */
function thumbnailIn(wrapper: HTMLElement, base: string): { src: string; original: string | null } | null {
  for (const img of Array.from(wrapper.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    const original = originalFileUrl(src, base);
    if (original) {
      let absolute = src;
      try { absolute = new URL(src, base).toString(); } catch { /* keep raw */ }
      return { src: absolute, original };
    }
  }
  return null;
}

/**
 * Describes every image field on the form, attached or not.
 *
 * An EMPTY field is included deliberately. "This content type has a Hero Image and the
 * source had none" is worth knowing, and it is the difference between the review saying
 * nothing and the review saying the source page had no hero.
 */
export function describeMediaRefs(fields: FieldDescriptor[], baseUrl: string): MediaRef[] {
  const refs: MediaRef[] = [];

  for (const field of fields) {
    if (field.kind !== 'file') continue;
    const el = field.elements[0];
    if (!el) continue;

    const wrapper = widgetWrapper(el);

    // The fid may be the field's own control, or a sibling inside the wrapper.
    const fidInput = /\[fid\]$/.test((el as HTMLInputElement).name ?? '')
      ? (el as HTMLInputElement)
      : wrapper.querySelector<HTMLInputElement>('input[name$="[fid]"]');
    const fid = realFid(fidInput?.value);

    const thumb = thumbnailIn(wrapper, baseUrl);
    const declared = (wrapper.querySelector('.filename')?.textContent ?? '').trim();

    refs.push({
      baseName: field.baseName,
      label: field.label,
      fid,
      filename: declared || filenameFromUrl(thumb?.original ?? null),
      url: thumb?.original ?? null,
      thumbnailUrl: thumb?.src ?? null,
    });
  }

  return refs;
}

/**
 * Drupal's "no file here" value.
 *
 * An unset Media field does not render an EMPTY fid — it renders `value="0"`. As a
 * string that is truthy, so an empty Featured Image counted as an attachment and the
 * review listed a file that does not exist, with no filename and no URL and a red line
 * telling the editor to go and find it on the source page. There was nothing to find.
 * Reported from a real paste: "9 filled, 2 images to attach" where only one was real.
 */
function realFid(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value || value === '0') return null;
  return value;
}

/** True when the source actually had a file attached to this field. */
export function hasAttachment(ref: MediaRef): boolean {
  return Boolean(ref.fid || ref.url);
}
