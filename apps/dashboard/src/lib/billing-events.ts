export const PAYMENTS_CHANGED = "openship:payments-changed";

/** Refresh payment warnings after mutations, including uncertain responses. */
export function invalidatePayments() {
  window.dispatchEvent(new Event(PAYMENTS_CHANGED));
}
