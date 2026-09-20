/**
 * The two halves of "edit a container healthcheck as one line of text".
 *
 * A stored `test` (ComposeHealthcheck) is either a shell string or an array, and
 * an array MAY still carry Docker's own `CMD` / `CMD-SHELL` / `NONE` prefix — the
 * compose parser strips it, but app-catalog services and API callers store
 * compose's form verbatim. The settings form has one command field, so it has to
 * render that array, and whatever it renders it can be asked to save back.
 *
 * Doing either naively breaks a working healthcheck. Joining `["CMD",
 * "pg_isready", "-U", "postgres"]` shows the engine prefix as if it were part of
 * the command; saving that line stores `test: "CMD pg_isready -U postgres"`, which
 * the runtime hands to `sh -c`, so Docker looks for a binary named `CMD` and every
 * probe fails — #502 from the other end. Flattening argv also changes what runs as
 * soon as an argument carries shell syntax (`--eval db.adminCommand('ping')`).
 */

import type { ComposeHealthcheck } from "@repo/core";

/** Timing inputs as the form holds them — raw strings, trimmed here. */
export type HealthcheckFormFields = {
  test: string;
  interval: string;
  timeout: string;
  startPeriod: string;
  retries: string;
};

/**
 * Render a stored `test` as the command a user would type: engine prefix dropped,
 * argv joined. `["NONE"]` means "no check", so it renders empty.
 */
export function healthcheckTestToText(test: ComposeHealthcheck["test"]): string {
  if (!test) return "";
  if (typeof test === "string") return test;
  const head = test[0];
  if (head === "NONE") return "";
  return (head === "CMD" || head === "CMD-SHELL" ? test.slice(1) : test).join(" ");
}

/**
 * The `advanced.healthcheck` value to PATCH, or null to remove the key.
 *
 * An untouched command field echoes the stored `test` back unchanged rather than
 * rebuilding it from the text — that keeps argv (and its prefix) exactly as the
 * catalog or API author wrote it, and it's the only way `disable`, which has no
 * field here, survives a save of the surrounding timings. An edited field is the
 * user's own shell command and is stored as the string they typed.
 */
export function healthcheckFromForm(
  fields: HealthcheckFormFields,
  stored?: ComposeHealthcheck | null,
): ComposeHealthcheck | null {
  const text = fields.test.trim();
  const untouched = text === healthcheckTestToText(stored?.test).trim();

  let healthcheck: ComposeHealthcheck | null = null;
  if (untouched && (stored?.test !== undefined || stored?.disable)) {
    healthcheck = {
      ...(stored.disable && { disable: true }),
      ...(stored.test !== undefined && { test: stored.test }),
    };
  } else if (text) {
    healthcheck = { test: text };
  }
  if (!healthcheck) return null;

  if (fields.interval.trim()) healthcheck.interval = fields.interval.trim();
  if (fields.timeout.trim()) healthcheck.timeout = fields.timeout.trim();
  if (fields.startPeriod.trim()) healthcheck.startPeriod = fields.startPeriod.trim();
  const retries = Number(fields.retries);
  if (fields.retries.trim() && Number.isInteger(retries) && retries >= 0) {
    healthcheck.retries = retries;
  }
  return healthcheck;
}
