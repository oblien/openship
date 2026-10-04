import { AppError, NotFoundError, ValidationError, CLOUD_UNREACHABLE_CODE } from "@repo/core";
import { isCreateDeploymentResult, type PrepareDeploymentInput } from "@repo/contracts";
import type { BuildDependencies } from "../../../builds";
import type { ExecutionContext } from "../../../context";
import type { Source } from "./prepare.service";
import { env } from "../../config/index";
import { assertNativeSourcePath } from "../../native/source-policy";
import { resolveProjectAuthority } from "../../lib/cloud/project-authority";
import { cloudFetchAsOrgOwner } from "../../lib/cloud/transport";
import { audit } from "../../lib/audit-emitter";

/** Validate the source and permission to include editable values in its scan. */
async function preparationSource(ctx: ExecutionContext, body: PrepareDeploymentInput): Promise<Source> {
  const source = body.source ?? (body.owner && body.repo ? "github" : undefined);
  const composePath = body.composePath?.trim() || undefined;
  const envVars = body.env && Object.keys(body.env).length ? body.env : undefined;
  if (source === "github") {
    if (!body.owner || !body.repo) throw new ValidationError("owner and repo are required");
    const provider = body.provider ?? "github";
    if (body.includeEnv && provider === "github") {
      // Values can combine Compose, .env and openship.json. A deployment or
      // metadata grant alone must not expose the contents of those files. This
      // check is GitHub-specific; other providers enforce access in their own
      // strategy before returning source content.
      const { checkSourceTier } = await import("../github/github-access");
      const { ok } = await checkSourceTier(ctx, { owner: body.owner, repo: body.repo }, "content-whole", "");
      if (!ok) throw new NotFoundError("github", `${body.owner}/${body.repo}`);
    }
    return {
      source,
      provider,
      owner: body.owner,
      repo: body.repo,
      branch: body.branch,
      ctx,
      composePath,
      env: envVars,
    };
  }
  if (source === "local") {
    if (env.CLOUD_MODE) throw new AppError("Local projects are not available in cloud mode", 403);
    if (!body.path) throw new ValidationError("path is required");
    const path = process.env.OPENSHIP_NATIVE === "true" ? await assertNativeSourcePath(body.path) : body.path;
    return { source, path, composePath, env: envVars };
  }
  throw new ValidationError("source must be 'github' or 'local'");
}

export const buildDependencies: BuildDependencies = {
  async prepare(ctx, body) {
    const prepare = await import("./prepare.service");
    const input = await preparationSource(ctx, body);
    return JSON.parse(JSON.stringify(prepare.projectInfoToPublicResponse(await prepare.resolveProjectInfo(input), body)));
  },
  async access(ctx, input) {
    if (process.env.OPENSHIP_NATIVE === "true" && process.env.OPENSHIP_NATIVE_ROUTING === "none" && input.publicEndpoints === undefined) input.publicEndpoints = [];
    const source = await resolveProjectAuthority(input.projectId, ctx.organizationId);
    const promotion = !env.CLOUD_MODE && env.DEPLOY_MODE !== "cloud" && input.deployTarget === "cloud" && input.buildStrategy !== "local";
    if (source === "cloud" || promotion) {
      // A fixed scope cannot use an owner-account link that has no verified
      // organization mapping. Deny before transfer or resource creation.
      if (ctx.scopeMode === "fixed") throw new AppError("This cloud link has no tenant mapping. Connect directly with the cloud organizationId.", 409, "CLOUD_SCOPE_UNAVAILABLE");
      if (promotion && source !== "cloud") {
        const { promoteProjectToCloud, TransferConflictError } = await import("../projects/transfer.service");
        try { await promoteProjectToCloud(ctx, input.projectId); }
        catch (error) {
          if (error instanceof TransferConflictError) {
            if (error.conflictKind === "slug") throw new AppError(`The name "${error.conflictValue}" is already taken on Openship Cloud. Rename this project and try again.`, 409, "CLOUD_SLUG_TAKEN");
            throw new AppError("This project already has a copy on Openship Cloud (leftover from an earlier transfer). Clean it up and retry to promote this local copy.", 409, "CLOUD_PROMOTE_CONFLICT");
          }
          throw error;
        }
      }
      const response = await cloudFetchAsOrgOwner(ctx.organizationId, "/api/deployments/build/access", { method: "POST", body: JSON.stringify(input) });
      if (!response) throw new AppError("Openship Cloud is unreachable", 503, CLOUD_UNREACHABLE_CODE);
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) throw new AppError(typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "Cloud deployment failed", response.status, typeof body?.code === "string" ? body.code : undefined);
      if (!isCreateDeploymentResult(body)) throw new AppError("Invalid cloud build response", 502, "INVALID_CLOUD_RESPONSE");
      return body;
    }
    const service = await import("./build.service");
    return service.requestBuildAccess(ctx, input);
  },
  async start(_ctx, id) {
    return (await import("./build.service")).startBuild(id);
  },
  recordAudit(ctx, id, after) {
    audit.recordAsync({ organizationId: ctx.organizationId, actorUserId: ctx.userId, source: ctx.source ?? "api", ipAddress: ctx.clientIp, userAgent: ctx.userAgent, sourceClientId: ctx.sourceClientId }, { eventType: "deployment:write", resourceType: "deployment", resourceId: id, ...(after && { after }) });
  },
};
