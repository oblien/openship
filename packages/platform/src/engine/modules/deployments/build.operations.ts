import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { join } from "node:path";
import { assertCloudProxyScope } from "../../lib/cloud/scope";
import { AppError, NotFoundError, ValidationError, CLOUD_UNREACHABLE_CODE } from "@repo/core";
import { isAcceptedDeploymentResult, type PrepareDeploymentInput } from "@repo/contracts";
import type { BuildDependencies } from "../../../builds";
import type { ExecutionContext } from "../../../context";
import type { Source } from "./prepare.service";
import { env } from "../../config/index";
import { assertNativeSourcePath } from "../../native/source-policy";
import { resolveProjectAuthority } from "../../lib/cloud/project-authority";
import { cloudFetchAsOrgOwner } from "../../lib/cloud/transport";
import { repos, reconcileComposeSpec, toComposeSpec } from "@repo/db";
import { assertResourceInOrg } from "../../lib/resource-access";
import { decryptEnvMap } from "../../lib/encryption";
import { mergeServiceEnv, publicScanService } from "../../lib/secret-env";
import { composeSourceChanges, composeSourceRevision } from "./compose-review";
import { projectServicesToDeployableServices } from "./compose/project-services";
import { audit } from "../../lib/audit-emitter";
import { assertLocalSourceContentAccess } from "../../lib/local-source-authority";

/** Validate the source and permission to include editable values in its scan. */
async function preparationSource(ctx: ExecutionContext, body: PrepareDeploymentInput): Promise<Source> {
  const source = body.source ?? (body.owner && body.repo ? "github" : undefined);
  const composePath = body.composePath?.trim() || undefined;
  const envVars = body.env && Object.keys(body.env).length ? body.env : undefined;
  if (source === "github") {
    if (!body.owner || !body.repo) throw new ValidationError("owner and repo are required");
    if (body.includeEnv) {
      // Values can combine Compose, .env and openship.json. A deployment or
      // metadata grant alone must not expose the contents of those files.
      const { checkSourceTier } = await import("../github/github-access");
      const { ok } = await checkSourceTier(ctx, { owner: body.owner, repo: body.repo }, "content-whole", "");
      if (!ok) throw new NotFoundError("github", `${body.owner}/${body.repo}`);
    }
    return {
      source,
      serverId: body.serverId,
      owner: body.owner,
      repo: body.repo,
      branch: body.branch,
      ctx,
      composePath,
      rootDirectory: body.rootDirectory,
      env: envVars,
    };
  }
  if (source === "local") {
    if (env.CLOUD_MODE) throw new AppError("Local projects are not available in cloud mode", 403);
    if (!body.path) throw new ValidationError("path is required");
    // A local path reads server-side files. Native callers are confined to
    // sourceRoots; outside that runtime, revealing values needs instance authority.
    if (body.includeEnv) await assertLocalSourceContentAccess(ctx);
    const native = process.env.OPENSHIP_NATIVE === "true";
    const path = native ? await assertNativeSourcePath(body.path) : body.path;
    // A relative folder can resolve through a symlink beyond the approved roots.
    if (native && body.rootDirectory) await assertNativeSourcePath(join(path, body.rootDirectory));
    return { source, path, composePath, rootDirectory: body.rootDirectory, env: envVars };
  }
  throw new ValidationError("source must be 'github' or 'local'");
}

export const buildDependencies: BuildDependencies = {
  async prepare(ctx, body) {
    const prepare = await import("./prepare.service");
    const project = body.projectId ? await repos.project.findById(body.projectId) : undefined;
    if (body.projectId) assertResourceInOrg(project, "Project", ctx.organizationId, body.projectId);
    const storedEnv = project
      ? decryptEnvMap(await repos.project.getEnvMap(project.id, "production", null))
      : undefined;
    const input = await preparationSource(ctx, {
      ...body,
      ...(storedEnv && { env: mergeServiceEnv(storedEnv, body.env) }),
    });
    const info = await prepare.resolveProjectInfo(input);
    const response = prepare.projectInfoToPublicResponse(info, body);
    if (!project || !info.services?.length) return JSON.parse(JSON.stringify(response));

    // Preview the same three-way merge that deployment uses, without changing
    // rows or import baselines. Saved credentials always stay masked; includeEnv
    // authorizes source reads, not revealing another store's secrets.
    const rows = await repos.service.listByProject(project.id);
    const byName = new Map(rows.filter(row => row.kind === "compose").map(row => [row.name, row]));
    const names = new Set(info.services.map(service => service.name));
    const services = info.services.map(source => {
      const saved = byName.get(source.name);
      if (!saved) return publicScanService(source, body.includeEnv);
      const merged = reconcileComposeSpec(toComposeSpec(saved), saved.importedSpec, toComposeSpec(source), source);
      const [definition] = projectServicesToDeployableServices([{ ...saved, ...merged }]);
      return publicScanService({ ...source, ...definition, serviceId: saved.id });
    });
    // Independently attached services are not owned by the Compose source.
    const attached = rows.filter(row => row.kind === "compose" && !row.importedSpec && !names.has(row.name));
    return JSON.parse(JSON.stringify({
      ...response,
      services: [...services, ...projectServicesToDeployableServices(attached).map((definition, i) =>
        publicScanService({ ...definition, serviceId: attached[i]!.id }))],
      composeRevision: composeSourceRevision(project.id, info.services),
      composeChanges: composeSourceChanges(rows, info.services),
    }));
  },
  async access(ctx, input) {
    if (process.env.OPENSHIP_NATIVE === "true" && process.env.OPENSHIP_NATIVE_ROUTING === "none" && input.publicEndpoints === undefined) input.publicEndpoints = [];
    const source = await resolveProjectAuthority(input.projectId, ctx.organizationId);
    // A destination changes where commands run, never where a project is stored.
    // Only projects explicitly owned by Cloud are forwarded to its control plane.
    if (source === "cloud") {
      assertCloudProxyScope(ctx);
      const response = await cloudFetchAsOrgOwner(ctx.organizationId, "/api/deployments/build/access", { method: "POST", body: JSON.stringify(input) });
      if (!response) throw new AppError("Openship Cloud is unreachable", 503, CLOUD_UNREACHABLE_CODE);
      const body = await response.json().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/build.operations"); return null; }) as Record<string, unknown> | null;
      if (!response.ok) throw new AppError(typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "Cloud deployment failed", response.status, typeof body?.code === "string" ? body.code : undefined);
      if (!isAcceptedDeploymentResult(body)) throw new AppError("Invalid cloud build response", 502, "INVALID_CLOUD_RESPONSE");
      return body;
    }
    await (await import("./host-mount-policy")).assertHostMountWriteAccess(ctx, input);
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
