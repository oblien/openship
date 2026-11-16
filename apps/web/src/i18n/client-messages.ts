import keys from "./client-message-keys.json";

/** Client components only receive the copy they can use; server content stays on the server. */
export function clientMessages(messages: { Copy: Record<string, string> }) {
  return { Copy: Object.fromEntries(keys.map((key) => [key, messages.Copy[key]])) };
}
