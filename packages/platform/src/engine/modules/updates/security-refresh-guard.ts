import { createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isMutableImageRef, securityImageIdentity, ValidationError } from "@repo/core";
import { repos, type Project, type Service } from "@repo/db";
import { env } from "../../config/env";
import { authorization } from "../../lib/authorization";
import { buildBackgroundContext } from "../../lib/background-context";
import { projectServicesToDeployableServices } from "../deployments/compose/project-services";
import type { DeploymentConfigSnapshot } from "../deployments/build.service";
import { assertSyncedServiceEnvironment } from "../services/service-environment-state";

/** A one-run precondition, not a configuration or environment snapshot. */
export interface SecurityUpdateApproval {
  deploymentId: string;
  approvedBy: string;
  expiresAt: string;
  serviceId: string;
  image: string;
  environmentFingerprint: string;
}
type ApprovalRequest = Omit<SecurityUpdateApproval, "environmentFingerprint">;

function environmentFingerprint(
  projectId: string,
  serviceId: string,
  values: Record<string, string>,
) {
  // Keyed and resource-scoped: metadata must not become an offline password oracle.
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(
      JSON.stringify([
        "openship-security-environment-v1",
        projectId,
        serviceId,
        Object.entries(values).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
}

/** Compare the environment produced by the ordinary deploy resolver; never replace it. */
export function assertSecurityUpdateEnvironment(
  projectId: string,
  approval: SecurityUpdateApproval | undefined,
  service: Pick<Service, "id" | "exposedPort">,
  environment: Record<string, string>,
) {
  if (!approval || service.id !== approval.serviceId) return;
  const values = { ...environment };
  const port = Number(service.exposedPort);
  if (values.PORT === undefined && Number.isInteger(port) && port > 0 && port <= 65535)
    values.PORT = String(port);
  if (environmentFingerprint(projectId, service.id, values) !== approval.environmentFingerprint)
    throw new ValidationError(
      "The environment changed after security refresh admission. Review the update manually.",
    );
}

/** The same checks run at admission and against the rows the worker will use. */
async function verifyApproval(
  project: Project | null | undefined,
  approval: ApprovalRequest,
  capturedServices?: Service[],
) {
  if (!(Date.parse(approval.expiresAt) > Date.now()))
    throw new ValidationError(
      "The signed security update instruction expired. Check the advisory again.",
    );
  if (!project || project.deletedAt || project.deletionInProgress)
    throw new ValidationError("The project is no longer available for automatic security updates.");
  const policy = await repos.securityAdvisory.project(project.id);
  if (
    !policy?.autoRefresh ||
    policy.approvedBy !== approval.approvedBy ||
    project.activeDeploymentId !== approval.deploymentId
  )
    throw new ValidationError(
      "Security refresh consent or active deployment changed. Review this update manually.",
    );
  const actor = buildBackgroundContext({
    userId: approval.approvedBy,
    organizationId: project.organizationId,
    role: "restricted",
    label: "security:verify-consent",
  });
  if (
    !(await authorization.checkPermissionOnResource(actor, {
      resourceType: "project",
      resourceId: project.id,
      action: "write",
    }))
  )
    throw new ValidationError("Security refresh authorization was revoked.");
  const active = await repos.deployment.findById(approval.deploymentId);
  if (!active) throw new ValidationError("The original runtime is unavailable.");
  const snapshot = active.meta as DeploymentConfigSnapshot | null;
  const services = capturedServices ?? (await repos.service.listByProject(project.id));
  const service = services.find((item) => item.id === approval.serviceId && item.enabled);
  if (!service) throw new ValidationError("Security refresh services changed.");
  if (
    !service.image ||
    !isMutableImageRef(service.image) ||
    service.build ||
    service.dockerfile ||
    service.advanced?.build ||
    !/@sha256:[a-f0-9]{64}$/.test(approval.image) ||
    securityImageIdentity(approval.image)?.repository !==
      securityImageIdentity(service.image)?.repository
  )
    throw new ValidationError("This image requires manual review before updating.");
  const normalize = (value: unknown) =>
    JSON.parse(JSON.stringify(value, (key, item) => (key === "everDeployed" ? undefined : item)));
  const { buildConfigSnapshot, resolveSnapshotTarget } =
    await import("../deployments/build.service");
  const currentConfig = {
    ...buildConfigSnapshot(project, active.branch ?? undefined),
    ...(await resolveSnapshotTarget(project)),
  };
  const capturedConfig = Object.fromEntries(
    Object.keys(currentConfig).map((key) => [
      key,
      snapshot?.[key as keyof DeploymentConfigSnapshot],
    ]),
  );
  if (!isDeepStrictEqual(normalize(currentConfig), normalize(capturedConfig)))
    throw new ValidationError(
      "Project configuration changed since deployment. Review and deploy saved changes before automatic security updates.",
    );
  const frozen = snapshot?.composeServices?.find((item) => item.name === service.name);
  if (
    !frozen ||
    !isDeepStrictEqual(
      normalize(projectServicesToDeployableServices([service])[0]),
      normalize(frozen),
    )
  )
    throw new ValidationError(
      "Service configuration changed since deployment. Review and deploy the saved changes before automatic security updates.",
    );
  const changes = await repos.project.listEnvVarChangeMeta(project.id, active.environment);
  if (
    changes.some(
      (row) =>
        row.updatedAt > active.createdAt &&
        (row.serviceId === null || row.serviceId === service.id),
    )
  )
    throw new ValidationError(
      "Environment settings changed since deployment. Apply them before automatic security updates.",
    );
  const environment = await assertSyncedServiceEnvironment(actor, project.id, service.id);
  return { project, service, environment };
}

export async function approveSecurityUpdate(
  project: Project,
  request: ApprovalRequest,
): Promise<SecurityUpdateApproval> {
  const { service, environment } = await verifyApproval(project, request);
  return {
    ...request,
    environmentFingerprint: environmentFingerprint(project.id, service.id, environment),
  };
}

export async function assertSecurityRefreshConfiguration(
  project: Project | null | undefined,
  snapshot: DeploymentConfigSnapshot,
  capturedServices?: Service[],
) {
  const approval = snapshot.securityApproval;
  if (!approval) return;
  if (
    snapshot.targetServiceIds?.length !== 1 ||
    snapshot.targetServiceIds[0] !== approval.serviceId
  )
    throw new ValidationError("Automatic update requires exactly its approved service.");
  const checked = await verifyApproval(project, approval, capturedServices);
  if (snapshot.handoverImages?.[checked.service.name] !== approval.image)
    throw new ValidationError("The approved update artifact changed.");
  assertSecurityUpdateEnvironment(
    checked.project.id,
    approval,
    checked.service,
    checked.environment,
  );
}
