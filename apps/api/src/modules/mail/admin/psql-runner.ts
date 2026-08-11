/**
 * SSH+psql wrapper for the mail admin panel.
 *
 * All `vmail.*` reads and writes go through this module. Every other admin
 * service composes SQL strings via `q()` and hands them to `queryRows` /
 * `execute`. There is intentionally no Drizzle / pg-driver layer here - we
 * picked the SSH-over-psql path so we don't have to expose the mail VPS's
 * Postgres port or store a separate DB credential. See `mail-admin-panel`
 * memory and `apps/email/ARCHITECTURE.md` for the long-term picture.
 *
 * Read shape:
 *   queryRows wraps the caller's SELECT with `SELECT json_agg(row_to_json(t))
 *   FROM (<sql>) t`. That collapses the result to one JSON document so we
 *   never have to parse psql's tab-separated dump format. Empty result → [].
 *
 * Write shape:
 *   execute() runs DML/DDL with `ON_ERROR_STOP=1` so errors bubble up as
 *   thrown exceptions (the underlying executor throws on non-zero exit).
 *
 * Quoting:
 *   `q()` is the ONLY way user input enters SQL. It single-quote-wraps the
 *   value and doubles inner `'` per the PostgreSQL standard. Identifiers
 *   (table / column names) are NEVER taken from user input - they're hard-
 *   coded in the service files.
 *
 * Transport:
 *   HOW psql is reached is not decided here. `runMailCommand` resolves the box's
 *   mail topology and `mailPsqlCommand` renders the right invocation (the engine's
 *   pg sidecar, or `sudo -u postgres` on a legacy pre-container install) — see
 *   `../mail-engine.ts`. This file was hardcoded to the sidecar, which is why
 *   every admin read on a legacy box 500'd with "No such container". Same SQL
 *   either way; the whole difference is the prefix, and it lives in one place.
 */

import type { CommandExecutor } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { mailPsqlCommand, runMailCommand, type MailTarget } from "../mail-engine";

/**
 * Quote a value as a PostgreSQL string literal. Escapes embedded single
 * quotes per the SQL standard (`'` → `''`). Use for any user-supplied
 * value that goes into a SQL string.
 *
 *   q("alice")           → 'alice'
 *   q("o'malley")        → 'o''malley'
 */
export function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Quote an integer for SQL. Truncates floats and rejects NaN / Infinity so
 * we never inject `NaN` or `Infinity` into a query (PostgreSQL would reject,
 * but better to fail before sending).
 */
export function qInt(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`qInt refused non-finite value: ${value}`);
  }
  return String(Math.trunc(value));
}

/**
 * Run a SELECT and parse the result as rows of T. The caller writes their
 * SELECT normally (with WHERE / ORDER BY / LIMIT as needed); this function
 * wraps it in `json_agg(row_to_json(...))` and parses the JSON.
 *
 * Caller is responsible for column-name → JSON-key mapping. Use SQL aliases
 * if the DB column doesn't match the desired JSON shape (e.g.
 * `SELECT created::text AS "createdAt"`).
 *
 *   const rows = await queryRows<{ domain: string; mailboxes: number }>(
 *     serverId,
 *     "SELECT domain, mailboxes FROM domain WHERE active = 1",
 *   );
 */
export async function queryRows<T>(
  serverIdOrExec: string | CommandExecutor,
  sql: string,
): Promise<T[]> {
  const wrapped = `SELECT COALESCE(json_agg(row_to_json(__t)), '[]'::json) FROM (${sql}) __t`;
  const out = await runSql(serverIdOrExec, wrapped);
  const trimmed = out.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Expected JSON array from psql, got ${typeof parsed}`,
      );
    }
    return parsed as T[];
  } catch (err) {
    throw new Error(
      `Failed to parse psql output as JSON: ${
        safeErrorMessage(err)
      }\nOutput head: ${trimmed.slice(0, 200)}`,
    );
  }
}

/**
 * Convenience for queries that return exactly one row (or zero).
 * Returns null when the result set is empty.
 */
export async function queryOne<T>(
  serverIdOrExec: string | CommandExecutor,
  sql: string,
): Promise<T | null> {
  const rows = await queryRows<T>(serverIdOrExec, sql);
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error(
      `queryOne expected ≤1 row, got ${rows.length}. SQL head: ${sql.slice(0, 120)}`,
    );
  }
  return rows[0];
}

/**
 * Run a mutation (INSERT / UPDATE / DELETE / DDL). Returns the raw psql
 * output (usually empty or "UPDATE N"). Throws on SQL error.
 *
 * For mutations that need to return inserted rows, use `RETURNING *` plus
 * `queryRows` instead - psql's `-c "INSERT … RETURNING …"` outputs the
 * returning rows as plain text, and we want JSON.
 */
export async function execute(
  serverIdOrExec: string | CommandExecutor,
  sql: string,
): Promise<string> {
  return runSql(serverIdOrExec, sql);
}

/**
 * Run multiple statements as a single transactional psql invocation. The
 * caller passes a list of statements; we wrap them in BEGIN/COMMIT and
 * stream them via stdin. If any one fails (ON_ERROR_STOP), the whole
 * block rolls back.
 *
 * Use this when an admin operation needs to keep two tables consistent
 * (e.g. INSERT mailbox + INSERT forwardings - they must both succeed or
 * both be rolled back).
 */
export async function transaction(
  serverIdOrExec: string | CommandExecutor,
  statements: string[],
): Promise<void> {
  const body = ["BEGIN;", ...statements.map((s) => s.replace(/;?\s*$/, ";")), "COMMIT;"].join("\n");

  // Pass the whole transaction as a single shell-quoted `-c` argument — the
  // same safe path `execute()` uses. NEVER a heredoc: a heredoc with a fixed
  // delimiter lets any value containing a line equal to that delimiter close it
  // early and turn the following lines into shell commands (OS command
  // injection). The `-c` value is wrapped in one inert argv string, so newlines
  // and any delimiter-looking text stay literal data. psql `-c` runs a
  // multi-statement BEGIN;…COMMIT; string in one transaction; ON_ERROR_STOP=1
  // still rolls the whole block back and surfaces the error.
  await runSql(serverIdOrExec, body);
}

/**
 * Internal: run SQL on whichever mail engine this box has. Accepts either a
 * serverId (the executor is acquired for us) or an already-acquired executor
 * (when the caller reuses one across several calls).
 *
 * A stopped engine / gone container surfaces as a typed
 * `MailEngineUnavailableError` (→ 409 + a code the dashboard branches on), not as
 * a raw shell error the panel prints as "API 500".
 */
async function runSql(serverIdOrExec: MailTarget, sql: string): Promise<string> {
  const { output } = await runMailCommand(serverIdOrExec, (flavor) =>
    mailPsqlCommand(flavor, sql),
  );
  return output;
}
