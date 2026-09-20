import { withAdvisoryLock } from "@repo/db";
import { withKeyedMutex } from "./provision-lock";

/** One lock shared by native operations and the authentication protocol adapter. */
export function withInvitationLifecycleLock<T>(invitationId: string, run: () => Promise<T>): Promise<T> {
  const key = `invitation-lifecycle:${invitationId}`;
  return withKeyedMutex(key, () => withAdvisoryLock(key, run));
}
