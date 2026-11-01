import type { ComposeEnvironmentMeta } from "@repo/core";

export type EnvironmentVariableMeta = ComposeEnvironmentMeta;

/** Scan metadata describes the original preview. A nonempty edit supplies a
 * value, but an unchanged, partially interpolated preview is still unresolved. */
export function isEnvironmentValueMissing(
  meta: EnvironmentVariableMeta | undefined,
  value: string | undefined,
): boolean {
  if (!meta) return false;
  return Boolean(
    (meta.required || meta.source === "missing") &&
    (!value || (meta.required && value === meta.resolvedValue)),
  );
}
