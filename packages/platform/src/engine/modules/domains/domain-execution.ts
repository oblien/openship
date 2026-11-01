import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { findActiveDeployment } from "../../lib/active-deployment";
import { isLocalHostRow } from "../../lib/box-org";
import { resolveEffectiveTarget, type DeploymentMeta } from "../../lib/deployment-runtime";
import { needsDomainSslCheck } from "../../lib/domain-ssl";
import { platform } from "../../lib/platform-config";
import { getDomain } from "./domain.service";

/** Reused at operation admission and before detached work mutates the target. */
export async function domainExecution(ctx: ExecutionContext, id: string, verifying = false) {
  if (
    process.env.OPENSHIP_NATIVE !== "true" ||
    process.env.OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION === "true"
  )
    return;
  const domain = await getDomain(ctx, id);
  if (verifying && (domain.externalIngress || (domain.verified && !needsDomainSslCheck(domain))))
    return;
  const project = domain.projectId ? await repos.project.findById(domain.projectId) : null;
  if (!project || project.organizationId !== ctx.organizationId)
    throw new NotFoundError("Domain", id);
  const deployment = project.activeDeploymentId ? await findActiveDeployment(project) : null;
  const meta = (deployment?.meta ?? {}) as DeploymentMeta;
  if (resolveEffectiveTarget(platform().target, meta) === "cloud") return;
  if (meta.serverId) {
    const server = await repos.server.getInOrganization(meta.serverId, ctx.organizationId);
    if (server && !(await isLocalHostRow(server))) return;
  }
  throw new AppError(
    "Host execution is disabled by this native installation's policy",
    403,
    "HOST_EXECUTION_DISABLED",
  );
}
