import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { encrypt, decrypt } from "../../lib/encryption";
import { resolveExecutionAuthority } from "../../lib/execution-authority";
import { authorizeActionRun } from "./access";
import { refreshActionRunAdmission } from "./run-access";
import { actionRuntimeUrl } from "./storage";
import { ActionRuntimeTokens } from "./runtime-identity";
import { ActionOidcService } from "./oidc-service";
import { actionOidcCache } from "./oidc-cache";
export { invalidateActionOidcKeyCache } from "./oidc-cache";

export function actionOidcIssuer() {
  const url = new URL(actionRuntimeUrl());
  if (url.protocol !== "https:")
    throw new AppError(
      "Publish this controller at a stable HTTPS address to use Actions OIDC",
      409,
      "ACTIONS_OIDC_UNAVAILABLE",
    );
  return `${url.origin}/api/actions/oidc`;
}

export function actionOidcService() {
  return (actionOidcCache.service ??= new ActionOidcService({
    issuer: actionOidcIssuer,
    tokens: new ActionRuntimeTokens(env.BETTER_AUTH_SECRET),
    key: repos.actionOidc.key,
    ensureKey: repos.actionOidc.ensureKey,
    encrypt,
    decrypt,
    async authorize(identity) {
      const run = await repos.actions.run(identity.organizationId, identity.runId);
      if (!run)
        throw new AppError(
          "This job cannot request an identity token",
          403,
          "ACTIONS_OIDC_FORBIDDEN",
        );
      const ctx = await resolveExecutionAuthority(run.authority, `actions-oidc:${identity.jobId}`);
      await authorizeActionRun(ctx, run, true);
      const workflow = await repos.actions.workflow(run.organizationId, run.workflowId);
      if (workflow?.accessPolicy) await refreshActionRunAdmission(ctx, workflow, run);
      const grant = await repos.actions.oidcGrant(
        identity.organizationId,
        identity.runId,
        identity.jobId,
      );
      if (!grant)
        throw new AppError(
          "This job's identity access has ended or changed",
          403,
          "ACTIONS_OIDC_FORBIDDEN",
        );
      return grant;
    },
  }));
}
