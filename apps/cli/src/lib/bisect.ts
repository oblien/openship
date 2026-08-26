/**
 * Pure binary-search core for `openship deployment bisect`. No I/O here —
 * fetching the deployment list, prompting good/bad/skip, and the rollback
 * call all live in commands/deployment.ts. Kept separate so the actual
 * search logic is unit-testable without mocking @clack/prompts.
 *
 * Contract: `range` is chronological ascending, index 0 = known good,
 * last index = known bad.
 */

export type BisectAnswer = "good" | "bad" | "skip";

/** Index of the next candidate to test, or -1 once `range` can't be
 *  narrowed further (down to just the good/bad boundary pair). */
export function bisectMidpoint<T>(range: T[]): number {
  return range.length > 2 ? Math.floor(range.length / 2) : -1;
}

export function bisectDone<T>(range: T[]): boolean {
  return bisectMidpoint(range) === -1;
}

/** Narrow `range` given the answer for `range[mid]`. "good" moves the good
 *  boundary up to the candidate; "bad" moves the bad boundary down to it;
 *  "skip" drops the candidate and keeps both boundaries as-is. */
export function bisectStep<T>(range: T[], mid: number, answer: BisectAnswer): T[] {
  if (answer === "good") return range.slice(mid);
  if (answer === "bad") return range.slice(0, mid + 1);
  return [...range.slice(0, mid), ...range.slice(mid + 1)];
}
