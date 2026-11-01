import { repos } from "@repo/db";
import { diagnostics } from "@repo/core/diagnostics";
import { resolveExecutionAuthority } from "../../lib/execution-authority";
import { calledSecrets } from "./reusable";
import { actionOidcService } from "./oidc";
import { decrypt } from "../../lib/encryption";
import { getInstallationToken } from "../github/github.auth";
import { authorizeActionRun } from "./access";
import { ActionController, type ActionControllerPorts } from "./controller";
import { syncActionCheck } from "./github-checks";
import { actionRuntimeEnvironment, authorizeActionStorage } from "./storage";
import { completeActionRun } from "./notifications";
import { refreshActionRunAdmission } from "./run-access";

export { actionWorkerAssets } from "./worker-execution";
import { openActionWorker, removeActionWorker } from "./worker-execution";

export const actionControllerPorts: ActionControllerPorts = {
  repo: repos.actions,
  async authorize(run) {
    const ctx = await resolveExecutionAuthority(run.authority, `actions:${run.id}`);
    await authorizeActionRun(ctx, run, true);
    const workflow = await repos.actions.workflow(run.organizationId, run.workflowId);
    if (workflow?.accessPolicy) await refreshActionRunAdmission(ctx, workflow, run);
    if (run.configuration.storageDestinationId)
      await authorizeActionStorage(ctx, run.configuration.storageDestinationId, true);
  },
  open: (run, job, runner, owner) =>
    openActionWorker(job, runner, owner, (patch) =>
      repos.actions.updateJob(run.organizationId, job.id, owner, patch),
    ),
  async secrets(run, job) {
    let secrets: Record<string, string> = {};
    if (!run.untrusted)
      for (const [key, value] of Object.entries(run.configuration.secrets ?? {}))
        secrets[key] = decrypt(value);
    if (!run.configuration.owner || !run.configuration.repo)
      return calledSecrets(run, job.spec?.scope, secrets);
    const ctx = await resolveExecutionAuthority(run.authority, `actions-token:${run.id}`);
    // Untrusted forks get no stored secrets and no write credential, even after approval.
    const permissions = Object.fromEntries(
      Object.entries(job.spec?.permissions ?? {})
        .filter(([key]) => key !== "id-token")
        .map(([key, value]) => [
          key.replaceAll("-", "_"),
          run.untrusted ? ("read" as const) : value,
        ]),
    );
    const token = await getInstallationToken(ctx, run.configuration.owner, undefined, {
      repositories: [run.configuration.repo],
      permissions,
      noCache: true,
    });
    // Named mappings may use the automatic token, with this leaf job's reduced
    // grant. Neither token values nor evaluated secret mappings enter snapshots.
    secrets = calledSecrets(run, job.spec?.scope, secrets, token ?? undefined);
    if (token) secrets.GITHUB_TOKEN = token;
    return secrets;
  },
  environment: async (run, job) => ({
    ...(await actionRuntimeEnvironment(run, job)),
    ...(await actionOidcService().environment(run, job)),
  }),
  cleanup: (run, job, runner, owner) =>
    removeActionWorker(job, runner, owner, (patch) =>
      repos.actions.updateJob(run.organizationId, job.id, owner, patch),
    ),
  check: syncActionCheck,
  completed: completeActionRun,
  reportError(error, context) {
    diagnostics.warn("actions/controller", "Workflow reconciliation failed", error, context);
  },
};

export const actionController = new ActionController(actionControllerPorts);
