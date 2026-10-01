/**
 * Keeps Drupal's autocomplete suggestions next to the relocated input they belong to.
 *
 * misc/autocomplete.js inserts its `#autocomplete` popup just before the input and places
 * it with `position: absolute` at jQuery's `$input.position()` — offsets measured against
 * the input's offsetParent. For an input relocated into the overlay, that offsetParent is
 * <body>: the shadow tree it is projected into is invisible to offsetParent. But the
 * browser lays the popup out against the nearest POSITIONED ancestor in the flat tree,
 * and the rail is sticky, so the rail's own offset was counted twice and the suggestions
 * rendered off the right edge of the screen. Every related field is a relocated
 * autocomplete, so none of them could be picked from.
 *
 * Re-anchored as `position: fixed` at the input's on-screen box, which no ancestor in
 * the rail affects (none of them transform), and which also escapes the rail's own
 * scroll clipping. Moved again whenever anything scrolls or the window resizes, since a
 * fixed popup would otherwise stay put while its input scrolled away.
 */
export function anchorAutocompletePopups(host: HTMLElement): () => void {
  const place = (popup: HTMLElement) => {
    // Drupal inserts the popup immediately before its input.
    const input = popup.nextElementSibling;
    if (!(input instanceof HTMLInputElement)) return;
    const box = input.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.top = `${box.bottom}px`;
    popup.style.left = `${box.left}px`;
    popup.style.width = `${box.width}px`;
    // Above the editor's sticky action bar (z-40) and the rail.
    popup.style.zIndex = '1000';
  };

  const placeAll = () =>
    host.querySelectorAll<HTMLElement>('#autocomplete').forEach(place);

  const observer = new MutationObserver(records => {
    for (const record of records) {
      record.addedNodes.forEach(node => {
        if (node instanceof HTMLElement && node.id === 'autocomplete') place(node);
      });
    }
  });
  observer.observe(host, { childList: true, subtree: true });

  /**
   * Captured on the document for page scrolls, AND on the editor's shadow root: the rail
   * scrolls inside it, and a scroll event is not composed, so the document never hears
   * it. Without the second listener the popup stayed put while its input scrolled away.
   */
  document.addEventListener('scroll', placeAll, true);
  host.shadowRoot?.addEventListener('scroll', placeAll, true);
  window.addEventListener('resize', placeAll);

  return () => {
    observer.disconnect();
    document.removeEventListener('scroll', placeAll, true);
    host.shadowRoot?.removeEventListener('scroll', placeAll, true);
    window.removeEventListener('resize', placeAll);
  };
}
