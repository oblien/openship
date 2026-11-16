import { readActiveConnectionId } from "./auth-client";

/** Undo drafts belong to the signed-in connection and the current tab. */
export function undoStorageKey() {
  const id = readActiveConnectionId();
  return id ? `openship-mail-undo:${id}` : null;
}
