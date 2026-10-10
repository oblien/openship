import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionsWorker, probeActionCapabilities } from "@repo/adapters";
import { AppError, actionContainerPlatform, actionRunnerMismatch } from "@repo/core";
import { repos } from "@repo/db";
import { diagnostics } from "@repo/core/diagnostics";
import { acquireServerExecution } from "../../lib/server-execution";
import { resolveExecutionAuthority } from "../../lib/execution-authority";
import { decrypt } from "../../lib/encryption";
import { getInstallationToken } from "../github/github.auth";
import { authorizeActionRun } from "./access";
import { ActionController, type ActionControllerPorts } from "./controller";
import { syncActionCheck } from "./github-checks";
import { actionRuntimeEnvironment, authorizeActionStorage } from "./storage";

export function actionWorkerAssets(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.OPENSHIP_ACTIONS_RUNNER_DIR,
    join(here, "assets/actions-runner"),
    join(here, "../assets/actions-runner"),
    join(here, "../server/assets/actions-runner"),
    join(here, "../../../../../actions-runner/dist"),
    join(process.cwd(), "packages/actions-runner/dist"),
    join(process.cwd(), "../../packages/actions-runner/dist"),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(join(p, "manifest.json")));
  if (!found)
    throw new AppError(
      "The Actions runner assets are missing. Build or install the Actions runner before starting workflows.",
      503,
      "ACTIONS_RUNNER_ASSET_MISSING",
    );
  return found;
}

export const actionControllerPorts: ActionControllerPorts = {
  repo: repos.actions,
  async authorize(run) {
    const ctx = await resolveExecutionAuthority(run.authority, `actions:${run.id}`);
    await authorizeActionRun(ctx, run, true);
    if (run.configuration.storageDestinationId)
      await authorizeActionStorage(ctx, run.configuration.storageDestinationId, true);
  },
  async open(run, job, runner, owner) {
    if (runner.cloudPoolId)
      return (await import("./cloud-runner")).openCloudActionWorker(
        run,
        job,
        runner,
        owner,
        actionWorkerAssets(),
      );
    if (!runner.serverId)
      throw new AppError(
        "Actions runner has no execution destination",
        409,
        "ACTIONS_RUNNER_UNAVAILABLE",
      );
    const connection = await acquireServerExecution(run.organizationId, runner.serverId);
    try {
      const worker = new ActionsWorker(connection.executor, actionWorkerAssets());
      if (job.workerBinary && job.directory && job.workerStartedAt)
        return {
          worker,
          binary: job.workerBinary,
          directory: job.directory,
          release: connection.release,
        };
      const capabilities = await connection.run(probeActionCapabilities);
      const mismatch = actionRunnerMismatch(capabilities, runner.config, job.spec!);
      if (mismatch) throw new AppError(mismatch, 409, "ACTIONS_RUNNER_UNSUPPORTED");
      const prepared = await worker.prepare(capabilities);
      return {
        worker,
        binary: prepared.binary,
        containerPlatform: actionContainerPlatform(capabilities, runner.config, job.spec!),
        directory: `${prepared.root}/jobs/${job.id}`,
        release: connection.release,
      };
    } catch (error) {
      await connection.release();
      throw error;
    }
  },
  async secrets(run, job) {
    const secrets: Record<string, string> = {};
    if (!run.untrusted)
      for (const [key, value] of Object.entries(run.configuration.secrets ?? {}))
        secrets[key] = decrypt(value);
    if (!run.configuration.owner || !run.configuration.repo) return secrets;
    const ctx = await resolveExecutionAuthority(run.authority, `actions-token:${run.id}`);
    // Untrusted forks get no stored secrets and no write credential, even after approval.
    const permissions = Object.fromEntries(
      Object.entries(job.spec?.permissions ?? {}).map(([key, value]) => [
        key.replaceAll("-", "_"),
        run.untrusted ? ("read" as const) : value,
      ]),
    );
    const token = await getInstallationToken(ctx, run.configuration.owner, undefined, {
      repositories: [run.configuration.repo],
      permissions,
      noCache: true,
    });
    if (token) secrets.GITHUB_TOKEN = token;
    return secrets;
  },
  environment: actionRuntimeEnvironment,
  async cleanup(run, job, runner, owner) {
    if (runner.cloudPoolId)
      return (await import("./cloud-runner")).removeCloudActionWorker(run, job, runner, owner);
    else if (runner.serverId && job.workerBinary && job.directory && !job.workerStartedAt) {
      const connection = await acquireServerExecution(run.organizationId, runner.serverId);
      try {
        await new ActionsWorker(connection.executor, actionWorkerAssets()).clean(
          job.workerBinary,
          job.directory,
        );
      } finally {
        await connection.release();
      }
    }
    return true;
  },
  check: syncActionCheck,
  completed: (run) =>
    run.configuration.sourceJob
      ? import("../jobs/job-workflow").then((m) => m.workflowJobCompleted(run))
      : Promise.resolve(),
  reportError(error, context) {
    diagnostics.warn("actions/controller", "Workflow reconciliation failed", error, context);
  },
};

export const actionController = new ActionController(actionControllerPorts);
