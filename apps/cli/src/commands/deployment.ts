import { exitCommand, rethrowCommandExit } from "../lib/command-exit";
/**
 * `openship deployment …` — manage existing deployments.
 *
 * Every subcommand maps to a real /api/deployments route
 * (deployment.routes.ts / deployment.controller.ts):
 *   list      GET    /deployments?projectId=&environment=
 *   get       GET    /deployments/:id
 *   info      GET    /deployments/:id/info      (container info)
 *   usage     GET    /deployments/:id/usage     (container usage)
 *   redeploy  POST   /deployments/:id/redeploy  { useExistingCommit? }
 *   rollback  POST   /deployments/:id/rollback
 *   pin       POST   /deployments/:id/pin       { pinned }
 *   cancel    POST   /deployments/:id/cancel
 *   restart   POST   /deployments/:id/restart
 *   reject    POST   /deployments/:id/reject
 *   keep      POST   /deployments/:id/keep
 *   rm        DELETE /deployments/:id
 *   ssl status POST  /deployments/ssl/status    { domain }
 *   ssl renew  POST  /deployments/ssl/renew     { domain, includeWww? }
 */
import { Command } from "commander";
import { createInterface } from "node:readline";
import { getShipClient, assertLinkedProjectConnection, ApiError } from "../lib/ship-client";
import { readProjectLink } from "../lib/project-link";
import { isJsonMode, printJson, printTable, ok, err } from "../lib/output";

/** Wrap a subcommand action so ApiError surfaces cleanly and exits non-zero. */
function run<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      rethrowCommandExit(e);
      err(e instanceof ApiError ? e.message : String(e));
      exitCommand(1);
    }
  };
}

/** Print a response as JSON (json mode) or a one-line success note otherwise. */
function report(res: unknown, message: string): void {
  if (isJsonMode()) printJson(res);
  else ok(message);
}

function shortSha(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 7) : "";
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

const list = new Command("list")
  .description("List deployments (org-wide, or scoped to a project)")
  .option("--project <id>", "Scope to a project (defaults to the linked project)")
  .option("--env <environment>", "Filter by environment: production | preview")
  .option("--limit <n>", "Max rows to fetch", "50")
  .action(
    run(async (opts) => {
      const link = opts.project ? null : readProjectLink();
      assertLinkedProjectConnection(link);
      const projectId: string | undefined = opts.project || link?.projectId;
      const res = await getShipClient().deployments.list({
        projectId, environment: opts.env, perPage: Math.min(Number(opts.limit) || 50, 100),
      });
      const rows = (res.data ?? []).map((d) => ({
        id: d.id,
        status: d.status,
        env: d.environment,
        branch: d.branch,
        commit: shortSha(d.commitSha),
        active: d.isActive ? "*" : "",
        created: d.createdAt,
      }));
      printTable(rows, ["id", "status", "env", "branch", "commit", "active", "created"]);
    }),
  );

const get = new Command("get")
  .description("Show a single deployment")
  .argument("<id>", "Deployment ID")
  .action(
    run(async (id: string) => {
      const d = await getShipClient().deployments.get(id);
      if (isJsonMode()) return printJson(d);
      printTable(
        [
          { field: "id", value: d.id },
          { field: "status", value: d.status },
          { field: "environment", value: d.environment },
          { field: "branch", value: d.branch },
          { field: "commitSha", value: d.commitSha },
          { field: "framework", value: d.framework },
          { field: "url", value: d.url },
          { field: "pinned", value: d.pinned },
          { field: "createdAt", value: d.createdAt },
        ],
        ["field", "value"],
      );
    }),
  );

const info = new Command("info")
  .description("Show container info for a deployment")
  .argument("<id>", "Deployment ID")
  .action(
    run(async (id: string) => {
      printJson(await getShipClient().deployments.containerInfo(id));
    }),
  );

const usage = new Command("usage")
  .description("Show container resource usage for a deployment")
  .argument("<id>", "Deployment ID")
  .action(
    run(async (id: string) => {
      printJson(await getShipClient().deployments.containerUsage(id));
    }),
  );

const redeploy = new Command("redeploy")
  .description("Redeploy from an existing deployment")
  .argument("<id>", "Deployment ID")
  .option("--use-existing-commit", "Rebuild the same commit instead of the latest on the branch")
  .action(
    run(async (id: string, opts) => {
      const res = await getShipClient().deployments.redeploy(id, { useExistingCommit: opts.useExistingCommit === true });
      report({ success: true, ...res }, `Redeploy triggered for ${id}`);
    }),
  );

const rollback = new Command("rollback")
  .description("Roll back to a previous deployment")
  .argument("<id>", "Deployment ID to roll back to")
  .action(
    run(async (id: string) => {
      const res = { data: await getShipClient().deployments.rollback(id) };
      report(res, `Rolled back to ${id}`);
    }),
  );

const pin = new Command("pin")
  .description("Pin (or unpin) a deployment's rollback artifact")
  .argument("<id>", "Deployment ID")
  .option("--off", "Unpin instead of pin")
  .action(
    run(async (id: string, opts) => {
      const pinned = !opts.off;
      const res = { data: await getShipClient().deployments.pin(id, { pinned }) };
      report(res, `${pinned ? "Pinned" : "Unpinned"} ${id}`);
    }),
  );

const cancel = new Command("cancel")
  .description("Cancel an in-progress deployment")
  .argument("<id>", "Deployment ID")
  .action(
    run(async (id: string) => {
      const res = await getShipClient().deployments.cancel(id);
      if (res.pending || !res.success) {
        throw new Error(
          res.message ||
            "Cancellation is still pending; wait for the deployment worker to stop before redeploying.",
        );
      }
      report(res, `Cancelled ${id}`);
    }),
  );

const restart = new Command("restart")
  .description("Restart a deployment's container")
  .argument("<id>", "Deployment ID")
  .action(
    run(async (id: string) => {
      const res = { data: await getShipClient().deployments.restart(id) };
      report(res, `Restarted ${id}`);
    }),
  );

const reject = new Command("reject")
  .description("Reject a finished deployment awaiting a keep/reject decision")
  .argument("<id>", "Deployment ID")
  .action(
    run(async (id: string) => {
      const res = await getShipClient().deployments.reject(id);
      report(res, `Rejected ${id}`);
    }),
  );

const keep = new Command("keep")
  .description("Keep a finished deployment awaiting a keep/reject decision")
  .argument("<id>", "Deployment ID")
  .action(
    run(async (id: string) => {
      const res = await getShipClient().deployments.keep(id);
      report(res, `Kept ${id}`);
    }),
  );

const rm = new Command("rm")
  .description("Delete a deployment")
  .argument("<id>", "Deployment ID")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(
    run(async (id: string, opts) => {
      if (!opts.yes && !isJsonMode() && !(await confirm(`Delete deployment ${id}?`))) {
        err("Aborted.");
        exitCommand(1);
      }
      const res = await getShipClient().deployments.remove(id);
      report(res, `Deleted ${id}`);
    }),
  );

/* ── SSL ────────────────────────────────────────────────────────────── */
const sslStatus = new Command("status")
  .description("Check SSL certificate status for a domain")
  .argument("<domain>", "Domain to probe")
  .action(
    run(async (domain: string) => {
      const res = await getShipClient().deployments.sslStatus({ domain });
      printJson(res);
    }),
  );

const sslRenew = new Command("renew")
  .description("Renew (issue) an SSL certificate for a domain")
  .argument("<domain>", "Domain to renew")
  .option("--www", "Also renew the www subdomain (separately — its own certificate)")
  .action(
    run(async (domain: string, opts) => {
      const res = await getShipClient().deployments.renewSsl({ domain, includeWww: opts.www === true });
      // `--www` renews TWO independent certificates, so report both. Collapsing
      // them into one line hid the case where the apex succeeded and the sibling
      // (not pointed here yet) didn't.
      if (!isJsonMode() && res.results && res.results.length > 1) {
        for (const r of res.results) {
          if (r.success) ok(`${r.domain}: ${r.status}`);
          else err(`${r.domain}: ${r.message ?? r.status}`);
        }
        return;
      }
      report(res, `SSL renewal requested for ${domain}`);
    }),
  );

const ssl = new Command("ssl")
  .description("SSL certificate operations")
  .addCommand(sslStatus)
  .addCommand(sslRenew);

const pending = new Command("pending")
  .description("Show a deployment's current prompt and pending decisions")
  .argument("<id>", "Deployment ID")
  .action(run(async (id: string) => {
    const status = await getShipClient().deployments.buildStatus(id);
    printJson({ status: status.deploymentStatus, pendingPrompt: status.pendingPrompt, decisionPending: status.decisionPending });
  }));

const respond = new Command("respond")
  .description("Answer a pending deployment prompt")
  .argument("<id>", "Deployment ID")
  .requiredOption("--action <action>", "An action ID offered by the pending prompt")
  .action(run(async (id: string, opts) => {
    const result = await getShipClient().deployments.respond(id, { action: opts.action });
    if (!result.success) throw new Error("The prompt expired or was already answered");
    report(result, `Response accepted for ${id}`);
  }));

export const deploymentCommand = new Command("deployment")
  .alias("deployments")
  .description("Manage deployments (list, inspect, redeploy, rollback, …)")
  .addCommand(list)
  .addCommand(get)
  .addCommand(info)
  .addCommand(usage)
  .addCommand(redeploy)
  .addCommand(rollback)
  .addCommand(pin)
  .addCommand(cancel)
  .addCommand(restart)
  .addCommand(reject)
  .addCommand(keep)
  .addCommand(pending)
  .addCommand(respond)
  .addCommand(rm)
  .addCommand(ssl);
