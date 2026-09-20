import type { DockerMigrationRun } from "@repo/db";

/**
 * The live migration a project payload is allowed to carry.
 *
 * Four fields, and the explicit allowlist is the point of this module. The run row also holds
 * `confirmationToken` — the secret that authorises the destructive cutover — and
 * `inputSnapshot`, a verbatim copy of the start request (env overrides included). A project
 * payload is read with `project:read`, while every migration route is `server:write`; spreading
 * the row into the project would hand a project-only reader the token that finishes a
 * cross-server teardown. So the projection is an allowlist, not an omission list: a field
 * added to the run row later cannot leak through here by default.
 *
 * `id` is what lets a client re-open the run's own (`server:read`-gated) endpoints — a
 * pointer, not an authorisation. `status` and `mode` are what a status pill renders, while
 * `needsAction` is a server-derived boolean that lets project-only readers see a failed
 * cutover without exposing its error details.
 */
export type ActiveMigrationSummary = {
  id: string;
  status: string;
  /** `project_move` | `project_copy` — a move is relocating THIS project, a copy is
   *  building a second one. Different sentences for the operator, same pill. */
  mode: string;
  needsAction: boolean;
};

/**
 * Project a live run down to what a project payload may say about it — or null when there
 * is none, which is the overwhelmingly common answer.
 */
export function readActiveMigration(
  run: DockerMigrationRun | null | undefined,
): ActiveMigrationSummary | null {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    mode: run.mode,
    needsAction:
      run.status === "awaiting_cutover" ||
      run.status === "partial" ||
      (run.status === "cutover" && Boolean(run.errorMessage)),
  };
}
