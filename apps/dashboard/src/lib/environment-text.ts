import { ENV_MASK, isMaskedValue } from "@repo/core";
import type { EnvironmentVariableRow } from "@/components/import-project/types";
import { parseDotenv, serializeDotenv } from "./dotenv";

export function environmentToText(rows: readonly EnvironmentVariableRow[]) {
  return serializeDotenv(
    rows
      .filter(
        (row) =>
          row.key.trim() || row.value || row.preserveValue || row.originalKey || row.sourceId,
      )
      .map((row) => ({
        key: row.key,
        value: row.preserveValue ? ENV_MASK : row.value,
      })),
  );
}

/** Match existing rows by name to retain saved-value and service-source identities. */
export function environmentFromText(
  text: string,
  rows: readonly EnvironmentVariableRow[],
  readOnlyKeys: readonly string[] = [],
): EnvironmentVariableRow[] {
  const parsed = parseDotenv(text, { strict: true });
  const previous = new Map(rows.map((row) => [row.key.trim(), row]));
  const next = new Map(parsed.map((row) => [row.key, row]));
  for (const row of rows) {
    const replacement = next.get(row.key.trim());
    if (row.removalDisabled && !replacement) throw new Error("Protected variable removed");
    if (
      readOnlyKeys.includes(row.key) &&
      (!replacement || replacement.value !== (row.preserveValue ? ENV_MASK : row.value))
    )
      throw new Error("Linked variable changed");
  }
  return parsed.map(({ key, value }) => {
    const original = previous.get(key);
    const preserved = original?.preserveValue || (original && isMaskedValue(original.value));
    if (isMaskedValue(value) && !preserved)
      throw new Error("Saved value placeholder has no source");
    if (preserved && isMaskedValue(value)) return { ...original, key };
    if (original && value === original.value && !original.preserveValue)
      return { ...original, key };
    return { ...original, key, value, preserveValue: false, visible: true };
  });
}
