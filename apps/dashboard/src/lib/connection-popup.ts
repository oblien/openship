export const connectionResultType = "openship:connection";

/** Same-origin callback signal for providers that sever window.opener. */
export function openConnectionResultChannel() {
  return typeof window.BroadcastChannel === "function"
    ? new window.BroadcastChannel(connectionResultType)
    : null;
}
