/** Open only a real payment URL. Blocked popups retain the visible checkout
 * action; failed requests never leave blank tabs or discard project drafts. */
export function navigateToCheckout(value: string, preserveProject: boolean) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Invalid checkout URL");
  if (preserveProject) {
    try { window.open(url.href, "_blank", "noopener,noreferrer"); }
    catch { /* Keep the validated manual checkout link when popups are refused. */ }
  } else window.location.href = url.href;
  return url.href;
}
