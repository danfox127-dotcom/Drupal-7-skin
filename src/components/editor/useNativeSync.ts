import { useEffect, useRef } from 'react';
import { FieldDescriptor } from '../../lib/formSchema';
import { readValue, FieldValue } from '../../lib/fieldBinding';

/**
 * Keeps an overlay control in step with the native Drupal field it mirrors.
 *
 * PrimaryField and FieldControl read their value once, in a `useState` initializer, and
 * never again. Anything that wrote to the native input afterwards was therefore invisible:
 * the importer applied a title to Drupal's real field and the overlay went on showing the
 * empty box it had captured at mount. The data was correct and saved correctly — but an
 * empty title box is indistinguishable from an import that failed, so an editor would
 * reasonably retype it.
 *
 * `writeValue()` already dispatches a bubbling input/change pair through `notify()`, so
 * there is nothing to add on the writing side; this only listens for it.
 *
 * Same-value writes are ignored. The overlay's own `commit` goes native-ward through
 * `writeValue` and comes straight back through this listener, and re-setting state with an
 * identical value on every keystroke is how a controlled input loses its caret position.
 */

function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : [a];
    const right = Array.isArray(b) ? b : [b];
    return left.length === right.length && left.every((v, i) => v === right[i]);
  }
  return a === b;
}

export function useNativeSync(
  field: FieldDescriptor,
  current: FieldValue,
  apply: (next: FieldValue) => void
): void {
  // Held in refs so the subscription depends only on the field. Taking `current` or
  // `apply` as effect dependencies would tear down and rebuild every listener on each
  // keystroke, which is both wasteful and a way to miss an event mid-swap.
  const currentRef = useRef(current);
  currentRef.current = current;
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    const els = field.elements;
    if (els.length === 0) return;

    const onExternalWrite = () => {
      const next = readValue(field);
      if (!sameValue(next, currentRef.current)) applyRef.current(next);
    };

    for (const el of els) {
      el.addEventListener('input', onExternalWrite);
      el.addEventListener('change', onExternalWrite);
    }
    return () => {
      for (const el of els) {
        el.removeEventListener('input', onExternalWrite);
        el.removeEventListener('change', onExternalWrite);
      }
    };
  }, [field]);
}
