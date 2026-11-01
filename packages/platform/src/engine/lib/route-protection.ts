import { AppError, NotFoundError, normalizeCustomHostname, isWildcardHostname } from "@repo/core";
import {
  createRouteProtection,
  revokeRouteSessions,
  assertRouteProtection,
  type RouteProtection,
  type RouteConfig,
} from "@repo/adapters";
import { repos, type Project } from "@repo/db";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { assertResourceInOrg } from "./resource-access";
import { withProjectRuntimeLock } from "./project-runtime-lock";
import { createProvisionLock } from "./provision-lock";
import { findActiveDeployment } from "./active-deployment";
import {
  disposePlatform,
  resolveDeploymentPlatform,
  type DeploymentMeta,
} from "./deployment-runtime";
import { resolveProjectDeployTarget } from "../modules/projects/project-deploy-target";
import { domainExecution } from "../modules/domains/domain-execution";
import { env } from "../config";
import type { ExecutionContext } from "../../context";
import type { RouteProtectionInput, RouteProtectionStatus } from "@repo/contracts";

/** Policy edits and publication share ownership without upgrading host/build admission. */
export function withRouteProtectionLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  return createProvisionLock(`route-protection:${projectId}`).run(work);
}

function hostnameOf(input: string): string {
  const hostname = normalizeCustomHostname(input);
  if (!hostname || hostname !== input.trim().toLowerCase() || isWildcardHostname(hostname))
    throw new AppError(
      "Choose an exact hostname, without a URL or wildcard.",
      400,
      "INVALID_DOMAIN",
    );
  return hostname;
}

async function selfHostedProject(
  ctx: Pick<ExecutionContext, "organizationId">,
  id: string,
): Promise<Project> {
  const project = await repos.project.findById(id);
  assertResourceInOrg(project, "Project", ctx.organizationId, id);
  const target = await resolveProjectDeployTarget(project);
  if (
    env.CLOUD_MODE ||
    project.workspaceId ||
    target.deployTarget === "cloud" ||
    project.clusterId ||
    (project.serverId &&
      !(await repos.server.getInOrganization(project.serverId, ctx.organizationId)))
  ) {
    throw new AppError(
      "Password protection requires a self-hosted HTTPS edge. Cloud and cluster edges are not supported yet.",
      400,
      "ROUTE_PROTECTION_UNSUPPORTED",
    );
  }
  if (project.deletionInProgress)
    throw new AppError("Project cleanup is pending.", 409, "PROJECT_DELETION_PENDING");
  return project;
}

export async function listRouteProtection(
  ctx: ExecutionContext,
  projectId: string,
): Promise<RouteProtectionStatus[]> {
  await selfHostedProject(ctx, projectId);
  return (await repos.routeProtection.list(projectId)).map((row) => ({
    hostname: row.hostname,
    enabled: row.enabled,
    status:
      (!row.enabled || row.hasSecret) && row.revision === row.appliedRevision
        ? "applied"
        : "pending",
  }));
}

function privatePolicy(row: { enabled: boolean; secret: string | null }): RouteProtection | null {
  if (!row.enabled) return null;
  if (!row.secret)
    throw new AppError(
      "This private route has no restored password. Save a new password before publishing it.",
      409,
      "ROUTE_PROTECTION_SECRET_MISSING",
    );
  try {
    const policy: unknown = JSON.parse(row.secret);
    assertRouteProtection(policy);
    return policy;
  } catch {
    // Never include the serialized verifier or signing key in an error.
    throw new AppError(
      "The saved route protection is invalid. Save a new password before publishing it.",
      409,
      "ROUTE_PROTECTION_SECRET_INVALID",
    );
  }
}

/** Preview settings contain only a reference to an existing encrypted policy. */
export async function readPreviewRouteProtection(
  ctx: Pick<ExecutionContext, "organizationId">,
  source: Project,
  settings = source.previewSettings,
) {
  if (!settings?.protectionHostname) return null;
  const hostname = hostnameOf(settings.protectionHostname);
  if (!settings.baseDomain)
    throw new AppError(
      "Protected previews require a custom preview base domain.",
      400,
      "PREVIEW_ROUTE_PROTECTION_REQUIRED",
    );
  await selfHostedProject(ctx, source.id);
  const owner = await repos.domain.findByHostname(hostname);
  if (
    owner &&
    (owner.projectId !== source.id || owner.externalIngress || owner.domainType === "free")
  )
    throw new AppError(
      "Choose a protected custom hostname owned by this source project.",
      400,
      "PREVIEW_ROUTE_PROTECTION_REQUIRED",
    );
  const row = await repos.routeProtection.readPrivate(source.id, hostname);
  const policy = row && privatePolicy(row);
  if (!row || !policy)
    throw new AppError(
      "Save a password for the selected source hostname before enabling protected previews.",
      409,
      "PREVIEW_ROUTE_PROTECTION_REQUIRED",
    );
  return { row, policy };
}

/** No plaintext password or source session key is copied into a preview. A
 * deterministic child key makes duplicate deliveries and concurrent retries safe. */
export async function inheritPreviewRouteProtection(projectId: string, hostname: string) {
  const intent = await repos.pullRequestPreview.findByProject(projectId);
  if (!intent) return;
  const source = await repos.project.findByIdInOrganization(
    intent.sourceProjectId,
    intent.organizationId,
  );
  if (!source)
    throw new AppError("Preview source is unavailable.", 409, "PREVIEW_ROUTE_PROTECTION_REQUIRED");
  if (!source.previewSettings?.protectionHostname) return;
  if (!source.previewSettings.enabled || source.deletedAt || source.deletionInProgress)
    throw new AppError(
      "Preview deployments are disabled.",
      409,
      "PREVIEW_ROUTE_PROTECTION_REQUIRED",
    );
  const child = await repos.project.findByIdInOrganization(projectId, intent.organizationId);
  if (!child || child.environmentType !== "preview")
    throw new AppError("Preview ownership is invalid.", 409, "PREVIEW_ROUTE_PROTECTION_REQUIRED");
  await selfHostedProject({ organizationId: intent.organizationId }, child.id);
  const inherited = await readPreviewRouteProtection(
    { organizationId: intent.organizationId },
    source,
  );
  if (!inherited)
    throw new AppError(
      "Preview password protection is unavailable.",
      409,
      "PREVIEW_ROUTE_PROTECTION_REQUIRED",
    );
  const domain = hostnameOf(hostname);
  const scope = JSON.stringify([source.id, inherited.row.revision, child.id, domain]);
  const revision = createHash("sha256").update(scope).digest("hex");
  const prior = await repos.routeProtection.readPrivate(child.id, domain);
  if (prior?.revision === revision && prior.enabled && prior.secret) {
    privatePolicy(prior);
    return prior;
  }
  const derive = (purpose: string) =>
    createHmac("sha256", Buffer.from(inherited.policy.signingKey, "hex"))
      .update(`${purpose}:${scope}`)
      .digest("hex");
  const policy = {
    ...inherited.policy,
    version: derive("preview-version").slice(0, 32),
    signingKey: derive("preview-signing-key"),
  };
  const secret = JSON.stringify(policy);
  await repos.routeProtection.save(child.id, domain, revision, secret);
  return { hostname: domain, revision, appliedRevision: null, enabled: true, secret };
}

/** Rotation/revocation is retried by the existing durable preview reconciler. */
export async function syncPreviewRouteProtection(ctx: ExecutionContext, projectId: string) {
  for (const domain of await repos.domain.listByProject(projectId)) {
    const row = await inheritPreviewRouteProtection(projectId, domain.hostname);
    if (row && row.appliedRevision !== row.revision) {
      const status = await changeRouteProtection(ctx, projectId, {
        hostname: domain.hostname,
        action: "retry",
      });
      if (status.status !== "applied")
        throw new AppError(
          "Preview password protection is pending on the edge.",
          409,
          "PREVIEW_ROUTE_PROTECTION_REQUIRED",
        );
    }
  }
}

/** Resolve the saved policy once; acknowledge that revision only after publication. */
export async function resolveProjectRouteProtection(
  projectId: string,
  hostname: string,
): Promise<{
  routeOptions: Pick<RouteConfig, "protection" | "terminatesTlsLocally">;
  onApplied?: () => Promise<void>;
}> {
  await inheritPreviewRouteProtection(projectId, hostname);
  const row = await repos.routeProtection.readPrivate(projectId, hostname.toLowerCase());
  // The database owns the policy for managed project routes. Do not inherit a
  // sidecar password left by a previous project that used this hostname.
  if (!row) return { routeOptions: { protection: null } };
  const owner = await repos.domain.findByHostname(hostname);
  if (owner?.projectId !== projectId)
    throw new AppError(
      "Route protection requires this project to own the hostname.",
      409,
      "ROUTE_OWNER_CHANGED",
    );
  const protection = privatePolicy(row);
  const { hostname: savedHostname, revision, appliedRevision } = row;
  return {
    routeOptions: {
      protection,
      ...(protection
        ? { terminatesTlsLocally: !owner.externalIngress && owner.domainType !== "free" }
        : {}),
    },
    onApplied:
      appliedRevision !== revision
        ? () => repos.routeProtection.markApplied(projectId, savedHostname, revision)
        : undefined,
  };
}

/** A durable intent precedes edge publication. Only an acknowledged, validated
 * reload is reported applied. A crash/error keeps an explicit retryable pending
 * state; an old protected vhost remains protected on a failed update. */
export async function changeRouteProtection(
  ctx: ExecutionContext,
  projectId: string,
  input: RouteProtectionInput,
): Promise<RouteProtectionStatus> {
  const hostname = hostnameOf(input.hostname);
  // Expensive derivation happens after authorization, before acquiring the route lock.
  await selfHostedProject(ctx, projectId);
  const prepared =
    input.action === "protect" ? await createRouteProtection(input.password) : undefined;
  return withProjectRuntimeLock(projectId, () =>
    withRouteProtectionLock(projectId, async () => {
      const project = await selfHostedProject(ctx, projectId);
      const intent = await repos.pullRequestPreview.findByProject(projectId);
      if (intent) {
        const source = await repos.project.findByIdInOrganization(
          intent.sourceProjectId,
          ctx.organizationId,
        );
        if (source?.previewSettings?.protectionHostname && input.action !== "retry")
          throw new AppError(
            "Manage inherited preview passwords and sessions on the source hostname.",
            409,
            "PREVIEW_ROUTE_PROTECTION_MANAGED",
          );
      }
      if (input.action === "unlock" && project.previewSettings?.protectionHostname === hostname)
        throw new AppError(
          "Remove the preview protection reference after cleaning up its previews before unlocking this hostname.",
          409,
          "PREVIEW_ROUTE_PROTECTION_MANAGED",
        );
      const domain = await repos.domain.findByHostname(hostname);
      if (domain && domain.projectId !== projectId)
        throw new NotFoundError("Project domain", hostname);
      if (domain && (domain.externalIngress || domain.domainType === "free"))
        throw new AppError(
          "This hostname must terminate HTTPS on your own edge to use a password.",
          400,
          "ROUTE_PROTECTION_HTTPS_REQUIRED",
        );
      if (domain) await domainExecution(ctx, domain.id);
      const prior = await repos.routeProtection.readPrivate(projectId, hostname);
      if (input.action === "revoke" && !prior?.secret)
        throw new AppError(
          "This route has no saved password.",
          400,
          "ROUTE_PROTECTION_NOT_ENABLED",
        );
      if (input.action === "retry" && !prior) throw new NotFoundError("Route protection", hostname);
      const policy =
        prepared ??
        (input.action === "unlock"
          ? null
          : input.action === "revoke"
            ? revokeRouteSessions(privatePolicy(prior!)!)
            : privatePolicy(prior!));
      const revision = input.action === "retry" ? prior!.revision : randomBytes(16).toString("hex");
      if (input.action !== "retry")
        await repos.routeProtection.save(
          projectId,
          hostname,
          revision,
          policy === null ? null : JSON.stringify(policy),
        );
      if (project.previewSettings?.protectionHostname === hostname)
        for (const preview of await repos.pullRequestPreview.list(project.id, ctx.organizationId))
          if (preview.projectId) await repos.pullRequestPreview.enqueue(preview);
      const result: RouteProtectionStatus = {
        hostname,
        enabled: policy !== null,
        status: "pending",
      };
      const deployment = await findActiveDeployment(project);
      if (!domain || !deployment) return result;
      const resolved = await resolveDeploymentPlatform((deployment.meta ?? {}) as DeploymentMeta, {
        organizationId: ctx.organizationId,
      });
      try {
        const routing = resolved.platform.routing;
        if (!routing?.setRouteProtection)
          throw new AppError(
            "This edge does not support password protection.",
            400,
            "ROUTE_PROTECTION_UNSUPPORTED",
          );
        if (await routing.setRouteProtection(hostname, policy)) {
          await repos.routeProtection.markApplied(projectId, hostname, revision);
          return { ...result, status: "applied" };
        }
        return result;
      } finally {
        await disposePlatform(resolved);
      }
    }),
  );
}

/** Admission guard for target changes: never move a private site to an edge that
 * cannot enforce its policy. Unlock first, or keep it on a self-hosted target. */
export async function assertRouteProtectionTarget(
  project: Pick<Project, "id">,
  target: string | undefined | null,
) {
  if (
    (target === "cloud" || target === "cluster") &&
    (await repos.routeProtection.list(project.id)).some((row) => row.enabled)
  ) {
    throw new AppError(
      "This project has password-protected routes. Keep it on a self-hosted HTTPS edge, or remove protection before changing targets.",
      409,
      "ROUTE_PROTECTION_UNSUPPORTED",
    );
  }
}
