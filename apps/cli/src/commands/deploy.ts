import { exitCommand, rethrowCommandExit } from "../lib/command-exit";
/**
 * `openship deploy` — deploy the current project.
 *
 * Two paths:
 *   - Git repo  → POST /api/deployments (git-source build of the linked project).
 *   - --folder (or --name outside Git) → stage the current directory through
 *                 the shared SDK source workflow.
 *
 * The git path's controller accepts an allowlist body ({ projectId, branch,
 * commitSha, environment, serverId, forceAll, serviceIds, smartRoute, refresh }) and
 * responds 202 with { data: { deployment_id, project_id } }; --watch attaches
 * to the GET /:id/stream SSE path.
 */
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import ora from "ora";
import { getShipClient, assertLinkedProjectConnection, ApiError } from "../lib/ship-client";
import type { CreateDeploymentInput, CreateDeploymentResult } from "@repo/sdk/client";
import { readProjectLink } from "../lib/project-link";
import { streamDeploymentLogs } from "../lib/deploy-stream";
import { isJsonMode, printJson, err, info } from "../lib/output";

/** Read a value from git, or undefined when not in a repo / git missing. */
function git(args: string[]): string | undefined {
  try {
    return (
      execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export const deployCommand = new Command("deploy")
  .description("Trigger a deployment for the current project")
  .option("--project <id>", "Project ID (defaults to the linked project in .openship/project.json)")
  .option("--branch <name>", "Git branch to deploy (defaults to the current branch)")
  .option("--commit <sha>", "Specific commit SHA (defaults to the latest commit on the branch)")
  .option("--env <environment>", "Variable set: production | preview (project ID selects the runtime)", "production")
  .option("--force-all", "Rebuild every enabled service (skip smart per-service routing)")
  .option("--service-ids <ids>", "Comma-separated service IDs to deploy (smart routing)")
  .option("--smart-route", "Rebuild only services changed since the active deploy")
  .option("--refresh", "Re-apply current env to the active deploy (no git pull, no rebuild)")
  .option("--folder", "Upload the current folder as source (also works inside a Git repository)")
  .option(
    "--name <name>",
    "Project name for a folder (non-git) deploy (defaults to the directory name)",
  )
  .option("--server <id>", "Registered server ID (see `openship server list`)")
  .option("--watch", "Stream the deployment logs until it finishes")
  .action(async (opts) => {
    const link = readProjectLink();
    if (!opts.project) assertLinkedProjectConnection(link);

    const env: string = opts.env;
    if (env !== "production" && env !== "preview") {
      err(`Invalid --env "${env}". Must be "production" or "preview".`);
      exitCommand(1);
    }

    // Never turn a redeploy from the wrong directory into an implicit upload.
    // --name remains an opt-in for existing folder-deploy scripts outside Git.
    const inGitRepo = git(["rev-parse", "--is-inside-work-tree"]) === "true";
    // --service-ids scopes BOTH a git redeploy and a folder redeploy (so a
    // backend-only change doesn't recreate stateful services), so it is NOT
    // git-only; commit/smart-route/refresh genuinely need git history.
    const gitOnlyFlags = opts.branch || opts.commit || opts.smartRoute || opts.refresh;
    if (opts.folder && gitOnlyFlags) {
      err("--folder cannot be combined with --branch, --commit, --smart-route, or --refresh.");
      exitCommand(1);
    }
    const folderUpload = opts.folder || (!inGitRepo && !gitOnlyFlags && opts.name);
    const targetProjectId: string | undefined = opts.project || link?.projectId;
    if (!inGitRepo && !gitOnlyFlags && !folderUpload && !targetProjectId) {
      err(
        "No linked project in this directory. Pass --project <id> to redeploy a project. " +
          "To upload this directory, pass --folder or --name <name>.",
      );
      exitCommand(1);
    }
    const serviceIds: string[] | undefined = opts.serviceIds
      ? opts.serviceIds
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined;

    let deploymentId: string | undefined;
    let payload: Record<string, unknown> | undefined;

    if (folderUpload) {
      const spinner = isJsonMode() ? null : ora("Deploying folder").start();
      try {
        const result = await getShipClient().deploy({
          source: { type: "directory", path: process.cwd() },
          name: opts.name,
          projectId: opts.project || link?.projectId,
          environment: env as "production" | "preview",
          serverId: opts.server,
          serviceIds,
          onStep: (m) => {
            if (spinner) spinner.text = m;
          },
        });
        deploymentId = result.deployment_id;
        payload = {
          success: true,
          deployment_id: result.deployment_id,
          project_id: result.project_id,
          ...(result.configDiagnostics && { configDiagnostics: result.configDiagnostics }),
        };
        spinner?.succeed(deploymentId ? `Deployment queued: ${deploymentId}` : "Deployment queued");
        // AFTER the spinner resolves, or these lines land mid-spinner-frame. The
        // deploy already went ahead on whatever parsed (#641) — this only says
        // which parts of openship.json didn't apply. The server strips control
        // characters from these strings, so they cannot repaint the line.
        if (result.configDiagnostics?.wholeFile) {
          err("  ✗ openship.json was ignored entirely — deployed with detected settings:");
        }
        for (const e of result.configDiagnostics?.errors ?? []) err(`    • ${e}`);
        for (const w of result.configDiagnostics?.warnings ?? []) info(`    ⚠ ${w}`);
      } catch (e) {
      rethrowCommandExit(e);
        spinner?.fail("Folder deploy failed");
        err(e instanceof ApiError ? e.message : String(e));
        exitCommand(1);
      }
    } else {
      const projectId: string | undefined = opts.project || link?.projectId;
      if (!projectId) {
        err("No project specified. Pass --project <id> or run `openship init` to link one.");
        exitCommand(1);
      }

      const branch: string | undefined =
        opts.branch || link?.branch || git(["rev-parse", "--abbrev-ref", "HEAD"]);

      const body: CreateDeploymentInput = {
        projectId,
        branch,
        commitSha: opts.commit || undefined,
        environment: env,
        serverId: opts.server || undefined,
        forceAll: opts.forceAll || undefined,
        serviceIds,
        smartRoute: opts.smartRoute || undefined,
        refresh: opts.refresh || undefined,
      };

      const spinner = isJsonMode() ? null : ora("Triggering deployment").start();
      let result: CreateDeploymentResult;
      try {
        result = await getShipClient().deployments.create(body);
      } catch (e) {
      rethrowCommandExit(e);
        spinner?.fail("Deployment failed to start");
        err(e instanceof ApiError ? e.message : String(e));
        exitCommand(1);
      }

      deploymentId = result.deployment_id;
      payload = { ...result };
      spinner?.succeed(deploymentId ? `Deployment queued: ${deploymentId}` : "Deployment queued");
    }

    if (isJsonMode() && !opts.watch) {
      printJson(payload ?? {});
      return;
    }

    if (!deploymentId) {
      info("No deployment id returned; nothing to watch.");
      return;
    }

    if (!opts.watch) {
      info(`Follow with: openship logs ${deploymentId} --follow`);
      return;
    }

    const result = await streamDeploymentLogs(deploymentId);
    if (result.success === false || result.status === "cancelled") exitCommand(1);
  });
