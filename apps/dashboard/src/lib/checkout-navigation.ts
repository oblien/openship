import { reportCaughtError } from "@repo/core/diagnostics";

/** The API validates payment hosts. Open only its final HTTPS URL.
 * Blocked popups retain the visible checkout
 * action; failed requests never leave blank tabs or discard project drafts. */
export function navigateToCheckout(value: string, preserveProject: boolean) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Invalid checkout URL");
  if (preserveProject) {
    try { window.open(url.href, "_blank", "noopener,noreferrer"); }
    catch {
      // Browser errors can embed the payment URL. Report no hosted-session data.
      reportCaughtError(new Error("Browser refused to open hosted checkout"), "dashboard/lib/checkout-navigation");
      // Keep the validated manual action available when popups are refused.
    }
  } else window.location.href = url.href;
  return url.href;
}
