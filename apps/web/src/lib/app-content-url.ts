/** Public catalog links never navigate to executable schemes or credential URLs. */
export function safeAppContentUrl(value: string, allowRelative = false): string | null {
  if (/[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return null;
  if (allowRelative && (value.startsWith("#") || /^\/(?!\/)/.test(value))) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    /* diagnostics-ignore: Invalid authored URLs are validation results, not operation failures. */
    return null;
  }
}
