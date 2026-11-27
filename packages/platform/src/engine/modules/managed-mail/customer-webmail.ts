import { CLOUD_DOCKER_IMAGE } from "@repo/adapters";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { buildBackgroundContext } from "../../lib/background-context";
import { requireWorkspaceServer } from "../../lib/cloud-workspace-scope";
import { resolveOrgOwner } from "../../lib/org-actor";
import { requestBuildAccess } from "../deployments/build.service";
import { installDedicatedWebmailApp, summarizeWebmailProject, WEBMAIL_TEMPLATE_ID } from "../mail/webmail/webmail-install.service";
import { orderLock } from "./dedicated";
import { dedicated, type Binding, type Order } from "./dedicated-contract";

async function assignedProject(row: Order) {
  const id = row.order.webmailProjectId;
  if (!id || !row.cloudServerId) return null;
  const [project, workspace] = await Promise.all([
    repos.project.findByIdInOrganization(id, row.organizationId),
    repos.cloudWorkspace.findByNamespace(row.billingNamespace),
  ]);
  if (!project || project.deletedAt || project.deletionInProgress || !project.isApp || project.appTemplateId !== WEBMAIL_TEMPLATE_ID ||
      !workspace || workspace.organizationId !== row.organizationId || workspace.remote || workspace.deletionInProgress ||
      project.workspaceId !== workspace.id) return null;
  const [server, vm] = await Promise.all([
    requireWorkspaceServer(row.organizationId, workspace.id),
    repos.cloudDockerWorkspace.find({ ownerWorkspaceId: workspace.id }, row.organizationId),
  ]);
  return project.serverId === server.id && vm?.workspaceId === row.cloudServerId && vm.namespace === row.billingNamespace
    ? project : null;
}

export async function customerWebmailStatus(row: Binding) {
  dedicated(row);
  const project = await assignedProject(row);
  if (!project || !row.hostname) return null;
  return summarizeWebmailProject(project, row.hostname.replace(/^mail\./, ""));
}

/** Called under the fleet slot lock, after the worker observes a clean, running mail engine. */
export async function prepareCustomerWebmail(row: Binding) {
  dedicated(row);
  if (row.orderState !== "funded" || !row.cloudServerId || !row.hostname) return null;
  const org = row.organizationId;
  const owner = await resolveOrgOwner(org, "throw");
  const ctx = buildBackgroundContext({ organizationId: org, userId: owner!.userId, membershipId: owner!.id, label: "dedicated-mail" });
  if (row.order.webmailProjectId) {
    const project = await assignedProject(row);
    if (!project) return null;
    const state = await summarizeWebmailProject(project, row.hostname.replace(/^mail\./, ""));
    if (state.installed && state.verifiedUrl) return project.id;
    // Recover the interval between saving the project link and queueing its first build.
    // Once a deployment exists, ordinary Apps redeploy controls own further attempts.
    if (!await repos.deployment.findLatestByProject(project.id)) {
      await requestBuildAccess(ctx, { projectId: project.id, serverId: project.serverId!, deployTarget: "cloud", serviceDeploymentMode: "services" });
    }
    return null;
  }
  const workspace = await repos.cloudWorkspace.attachDedicatedMailVm(org, row.id, row.cloudServerId, CLOUD_DOCKER_IMAGE);
  const server = await requireWorkspaceServer(org, workspace.id);
  await installDedicatedWebmailApp(ctx, {
    serverId: server.id,
    hostname: row.hostname,
    beforeDeploy: projectId => orderLock(org).run(async () => {
      const latest = await repos.managedMail.service(org, row.id);
      dedicated(latest);
      if (!latest.provisioning || latest.orderState !== "funded" || latest.cloudServerId !== row.cloudServerId ||
          (latest.order.webmailProjectId && latest.order.webmailProjectId !== projectId))
        throw new AppError("The dedicated mail assignment changed during installation.", 409);
      await repos.managedMail.updateOrder(org, row.id, { order: { ...latest.order, webmailProjectId: projectId } });
    }),
  });
  return null;
}
