import { useEffect, useRef } from 'react';

export interface ComposerHeaders {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
}

type Field = keyof ComposerHeaders;
type Value = ComposerHeaders[Field];

function equal(left: Value | undefined, right: Value): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index])
    : left === right;
}

/** Refresh defaults arriving from a message, alias lookup or draft without replacing edits. */
export function useComposerHeaders(
  defaults: ComposerHeaders,
  read: (field: Field) => Value | undefined,
  write: (field: Field, value: Value) => void,
  showRecipients: (field: 'cc' | 'bcc') => void,
) {
  const previous = useRef(defaults);
  useEffect(() => {
    for (const field of ['to', 'cc', 'bcc', 'subject'] as const) {
      const before = previous.current[field];
      const next = defaults[field];
      if (equal(before, next) || !equal(read(field), before)) continue;
      write(field, next);
      if ((field === 'cc' || field === 'bcc') && next.length > 0) showRecipients(field);
    }
    previous.current = defaults;
  }, [defaults, read, write, showRecipients]);
}
