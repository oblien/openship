import { createPersistedValue } from "./persisted-value";

/** A remembered destination is only a hint; the live authorized list decides
 * whether it can be selected. Keep hints separate for each account and org. */
export function serverPreference(contextKey: string) {
  return createPersistedValue<string>(
    `openship.deploy-server:${contextKey}`,
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
