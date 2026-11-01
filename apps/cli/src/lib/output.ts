/**
 * Output helpers. A single process-wide "JSON mode" flag switches structured
 * output on (set by the global --json flag in index.ts, or the OPENSHIP_JSON
 * env var). In JSON mode, stdout is reserved for machine-readable data only —
 * ok/info/err always go to stderr so they never corrupt a piped JSON stream.
 */
import { reportError, errorReporter } from "@repo/core/diagnostics";
import chalk from "chalk";

/** Retain human CLI output while also producing the shared structured event. */
export function reportCliMessage(level: "warn" | "error", ...values: unknown[]): void {
  errorReporter.log(level, "cli", ...values);
  console[level](...values);
}

let jsonMode = process.env.OPENSHIP_JSON === "1" || process.env.OPENSHIP_JSON === "true";

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Pretty-print any value as JSON to stdout. */
export function printJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

/** One record per line for streaming commands. */
export function printJsonLine(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * Render rows as an aligned text table on stdout. In JSON mode, emits the rows
 * as JSON instead. Columns default to the union of keys across all rows.
 */
export function printTable(rows: Record<string, unknown>[], columns?: string[]): void {
  if (jsonMode) {
    printJson(rows);
    return;
  }
  if (rows.length === 0) {
    process.stderr.write(chalk.dim("  (no rows)\n"));
    return;
  }
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const widths = cols.map((col) =>
    Math.max(col.length, ...rows.map((r) => cell(r[col]).length)),
  );
  const line = (cells: string[]) =>
    "  " + cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd() + "\n";

  process.stdout.write(chalk.bold(line(cols)));
  for (const r of rows) process.stdout.write(line(cols.map((c) => cell(r[c]))));
}

/** Success message (stderr, green). Suppressed in JSON mode. */
export function ok(msg: string): void {
  if (!jsonMode) process.stderr.write(chalk.green(msg) + "\n");
}

/** Error message (stderr, red). Always shown, even in JSON mode. */
export function err(msg: string, error?: unknown): void {
  reportError(error ?? msg, { source: "cli", component: "cli", handled: true });
  process.stderr.write(chalk.red(msg) + "\n");
}

/** Informational message (stderr, dim). Suppressed in JSON mode. */
export function info(msg: string): void {
  if (!jsonMode) process.stderr.write(chalk.dim(msg) + "\n");
}
