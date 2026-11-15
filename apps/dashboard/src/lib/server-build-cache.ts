import { BUILD_CACHE_BUDGET_MAX_BYTES, BUILD_CACHE_BUDGET_MIN_BYTES } from "@repo/contracts";

const GIB = 1024 ** 3;
export const BUILD_CACHE_BUDGET_MIN_GIB = BUILD_CACHE_BUDGET_MIN_BYTES / GIB;
export const BUILD_CACHE_BUDGET_MAX_GIB = BUILD_CACHE_BUDGET_MAX_BYTES / GIB;

/**
 * A stored budget in GiB for the input, to two decimals so a value set through the API is shown
 * as it is; null (automatic) has no value to show.
 */
export function budgetBytesToGib(bytes: number | null | undefined): string {
  return typeof bytes === "number" ? String(Math.round((bytes / GIB) * 100) / 100) : "";
}

/**
 * GiB typed by the operator (up to two decimals, with a point or a comma) → bytes the API accepts,
 * or null if invalid.
 */
export function parseBudgetGib(input: string): number | null {
  const text = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const gib = Number(text);
  if (gib < BUILD_CACHE_BUDGET_MIN_GIB || gib > BUILD_CACHE_BUDGET_MAX_GIB) return null;
  return Math.round(gib * GIB);
}
