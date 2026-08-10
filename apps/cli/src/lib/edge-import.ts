/**
 * Hand the sites migrated off a foreign proxy to the running stack's api, which
 * registers them into the CONTAINER edge (the host CLI can't — that needs the
 * running edge container, the shared routing volumes and the docker socket).
 *
 * This is phase 2 of the compose takeover, and it is NOT optional: without it a
 * "Migrate N sites & take over" run stops the operator's nginx, binds 80/443, and
 * silently serves nothing for those N hostnames. Shared by `openship up` and the
 * interactive wizard so the two can't diverge on it again — the wizard used to
 * collect the sites and drop them on the floor.
 */
import chalk from "chalk";
import ora from "ora";
import { EDGE_CONTAINER_NAME, edgeCrashReason, type ImportedSite } from "@repo/adapters/proxy";
import { LocalExecutor } from "@repo/adapters";
import { composeInternalToken } from "./compose";

/** Wait for the compose api container to answer its health stub. */
export async function waitForApiHealth(port: string, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Wait for the EDGE container to actually be running — not just the API.
 *
 * Registration reloads the edge via `docker exec <edge> …`, which throws a raw
 * `(HTTP code 409) … container is not running` against a container that is still
 * starting. `compose up` reports the edge "Started" the instant it's created, and
 * we only waited on API health, so the import could fire into that gap and every
 * site failed with an identical, misleading 409 — then the edge finished starting
 * and served fine. Gating on the edge's actual running state closes that race.
 */
export async function waitForEdgeRunning(tries: number): Promise<boolean> {
  const exec = new LocalExecutor();
  for (let i = 0; i < tries; i++) {
    const out = await exec
      .exec(`docker inspect -f '{{.State.Running}}' ${EDGE_CONTAINER_NAME}`)
      .catch(() => "");
    if (out.trim() === "true") return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export interface EdgeImportOutcome {
  ok: boolean;
  registered: string[];
  /** Human-readable reason when ok is false (already surfaced to the operator). */
  error?: string;
}

/**
 * POST the parsed sites + host-read cert PEMs to the api's internal edge-import
 * endpoint. Uses the compose stack's INTERNAL_TOKEN (from compose/.env — NOT the
 * bare-mode token file). Never throws; the outcome tells the caller whether the
 * migrated hostnames are actually being served.
 */
export async function importMigratedSites(
  apiPort: string,
  sites: ImportedSite[],
  certPems?: Record<string, { certPem: string; keyPem: string }>,
  staticRootOverrides?: Record<string, string>,
): Promise<EdgeImportOutcome> {
  const token = composeInternalToken();
  if (!token) {
    const error = "couldn't read the stack's internal token";
    console.log(chalk.yellow(`  Skipping site import — ${error}. Re-run to retry.\n`));
    return { ok: false, registered: [], error };
  }
  const spinner = ora(
    `Importing ${sites.length} migrated site${sites.length === 1 ? "" : "s"} into the edge…`,
  ).start();
  if (!(await waitForApiHealth(apiPort, 60))) {
    const error = "API didn't become healthy in time";
    spinner.warn(`${error} — migrated sites not imported. Re-run \`openship up\` to retry.`);
    return { ok: false, registered: [], error };
  }
  // The edge must be RUNNING before we register: the reload execs into it, and a
  // container that's still starting 409s. Without this gate the whole import
  // fails against the edge's own not-yet-running container (the migration race).
  if (!(await waitForEdgeRunning(60))) {
    const error = `the ${EDGE_CONTAINER_NAME} container isn't running yet`;
    spinner.warn(`${error} — migrated sites not imported. Re-run \`openship up\` to retry.`);
    return { ok: false, registered: [], error };
  }
  try {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/system/edge/import-sites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": token },
      body: JSON.stringify({ sites, certPems, staticRootOverrides }),
      signal: AbortSignal.timeout(120000),
    });
    const data = (await r.json().catch(() => ({}))) as {
      registered?: string[];
      warnings?: string[];
      error?: string;
    };
    if (!r.ok) {
      const error = data.error ?? `HTTP ${r.status}`;
      spinner.warn(`Site import failed: ${error}. Re-run to retry.`);
      return { ok: false, registered: [], error };
    }
    const registered = data.registered ?? [];
    const warnings = data.warnings ?? [];
    const missed = sites.length - registered.length;

    // A 200 with an empty `registered` is a TOTAL failure, not a success: the
    // operator's proxy is already stopped and we now hold :80/:443, so every one
    // of those hostnames is dark. This used to `spinner.succeed("Migrated 0
    // sites")` with the per-site errors dimmed underneath, which read as "fine".
    if (sites.length > 0 && registered.length === 0) {
      spinner.fail(
        `Migrated NONE of the ${sites.length} site${sites.length === 1 ? "" : "s"} — ` +
          `Openship holds :80/:443 and ${sites.length === 1 ? "that hostname is" : "those hostnames are"} NOT being served.`,
      );
      for (const w of warnings.slice(0, 8)) console.log(chalk.red(`    • ${w}`));
      // Every per-site error being "container is restarting" means ONE thing: the
      // edge itself is crash-looping, and the reason is in its log, not in the six
      // identical 409s above. Print it — otherwise "the cause above" names nothing
      // and the operator is left guessing at a config error they can't see.
      const edgeLog = await edgeCrashReason(new LocalExecutor());
      if (edgeLog) {
        console.log(chalk.red(`\n  The edge container is not running. Its log says:`));
        console.log(chalk.red(`    ${edgeLog}`));
      }
      console.log(
        chalk.yellow(
          `\n  Retry the import with \`openship up\` once the cause above is fixed, or put your\n` +
            `  previous proxy back:  docker stop ${EDGE_CONTAINER_NAME} && sudo systemctl enable --now nginx\n`,
        ),
      );
      return { ok: false, registered, error: warnings[0] ?? "no sites were registered" };
    }

    if (missed > 0) {
      spinner.warn(
        `Migrated ${registered.length}/${sites.length} sites — ${missed} not served (see below).`,
      );
      for (const w of warnings.slice(0, 8)) console.log(chalk.yellow(`    • ${w}`));
      return { ok: false, registered, error: `${missed} site(s) not registered` };
    }

    spinner.succeed(
      `Migrated ${registered.length} site${registered.length === 1 ? "" : "s"} into Openship's edge.`,
    );
    for (const w of warnings.slice(0, 8)) console.log(chalk.dim(`    • ${w}`));
    return { ok: true, registered };
  } catch (e) {
    const error = (e as Error).message;
    spinner.warn(`Site import failed: ${error}. Re-run to retry.`);
    return { ok: false, registered: [], error };
  }
}
