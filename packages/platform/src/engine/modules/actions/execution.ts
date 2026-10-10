import { repos } from "@repo/db";
import { diagnostics } from "@repo/core/diagnostics";
import { resolveExecutionAuthority } from "../../lib/execution-authority";
import { decrypt } from "../../lib/encryption";
import { getInstallationToken } from "../github/github.auth";
import { authorizeActionRun } from "./access";
import { ActionController, type ActionControllerPorts } from "./controller";
import { syncActionCheck } from "./github-checks";
import { actionRuntimeEnvironment, authorizeActionStorage } from "./storage";

export { actionWorkerAssets } from "./worker-execution";
import { openActionWorker, removeActionWorker } from "./worker-execution";

export const actionControllerPorts: ActionControllerPorts = {
  repo: repos.actions,
  async authorize(run) {
    const ctx = await resolveExecutionAuthority(run.authority, `actions:${run.id}`);
    await authorizeActionRun(ctx, run, true);
    if (run.configuration.storageDestinationId)
      await authorizeActionStorage(ctx, run.configuration.storageDestinationId, true);
  },
  open: (run, job, runner, owner) =>
    openActionWorker(job, runner, owner, (patch) =>
      repos.actions.updateJob(run.organizationId, job.id, owner, patch),
    ),
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
  cleanup: (run, job, runner, owner) =>
    removeActionWorker(job, runner, owner, (patch) =>
      repos.actions.updateJob(run.organizationId, job.id, owner, patch),
    ),
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
