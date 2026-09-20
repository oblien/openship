import { repos } from "@repo/db";
import { ProjectControlSchemas } from "@repo/contracts";
import { presentProject, type ProjectDependencies } from "../../../projects";
import type { ResourceServices } from "../../../resource-operations";
import { authorization } from "../../lib/authorization";
import { encrypt } from "../../lib/encryption";
import { assertResourceInOrg } from "../../lib/resource-access";
import { createProjectLifecycleOperations } from "./project-lifecycle.operations";
import { createProjectGitOperations } from "./project-git.operations";
import { createProjectInspectionOperations } from "./project-inspection.operations";
import { createProjectIntegrationOperations } from "./project-integrations.operations";
import { projectRoutingOperations } from "./project-routing.operations";
import { projectLogOperations } from "./project-logs.operations";
import { createProjectTransferOperations } from "./project-transfer.operations";
import { appProjectOperations } from "../apps/app.operations";

/** Existing services, with the controller's audit/presentation duties shared by all callers. */
export function createProjectControls(
  recordAudit: ProjectDependencies["recordAudit"],
): ResourceServices<typeof ProjectControlSchemas> {
  const service = () => import("./project.service");
  const updated = (ctx: Parameters<typeof recordAudit>[0], id: string, after: unknown) =>
    recordAudit(ctx, {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after,
    });
  return {
    ...appProjectOperations,
    ...createProjectTransferOperations(recordAudit),
    ...projectLogOperations,
    ...projectRoutingOperations,
    ...createProjectIntegrationOperations(recordAudit),
    ...createProjectLifecycleOperations(recordAudit),
    ...createProjectGitOperations(recordAudit),
    ...createProjectInspectionOperations(recordAudit),
    async getRollbackCapacity(ctx, id) {
      return (await import("./rollback-capacity.service")).getRollbackCapacity(
        id,
        ctx.organizationId,
      );
    },
    async checkPorts(ctx, id) {
      return (await import("./port-check.service")).checkProjectPorts(ctx, id);
    },
    async checkOutput(ctx, id) {
      return (await import("./output-check.service")).checkProjectOutput(ctx, id);
    },
    async getPendingActions(ctx, id) {
      return {
        actions: await (
          await import("./pending-actions.service")
        ).getProjectPendingActions(id, ctx.organizationId),
      };
    },
    async getCommitStatus(ctx, id) {
      return (await import("../updates/updates.service")).getProjectDrift(ctx, id);
    },
    async listEnvironments(ctx, id) {
      return (await service()).listProjectEnvironments(id, ctx.organizationId, (projectId) =>
        authorization.checkPermissionOnResource(ctx, {
          resourceType: "project",
          resourceId: projectId,
          action: "read",
        }),
      );
    },
    async createEnvironment(ctx, id, input) {
      const data = await (await service()).createProjectEnvironment(id, ctx, input);
      updated(ctx, id, {
        action: "environment.created",
        environmentId: data.id,
        environmentName: data.name,
        environmentSlug: data.slug,
        environmentType: data.type,
        gitBranch: data.gitBranch,
      });
      return data;
    },
    async listEnvVars(ctx, id, input) {
      return (await service()).listEnvVars(id, ctx.organizationId, input?.environment);
    },
    async mergeEnvVars(ctx, id, input) {
      const data = await (await service()).mergeEnvVars(id, ctx.organizationId, input);
      // Names only: values must never enter audit history, including non-secrets.
      updated(ctx, id, {
        action: "envVars.merge",
        environment: input.environment,
        upsertedNames: input.upserts.map((v) => v.key),
        deletedNames: input.deletes,
      });
      return data;
    },
    async getResources(ctx, id) {
      return (await service()).getResources(id, ctx.organizationId);
    },
    async updateResources(ctx, id, input) {
      const data = await (await service()).updateResources(id, input, ctx.organizationId);
      updated(ctx, id, {
        action: "resources.updated",
        production: input.production ?? null,
        build: input.build ?? null,
        sleepMode: input.sleepMode ?? null,
        port: input.port ?? null,
      });
      return data;
    },
    async setSleepMode(ctx, id, input) {
      const data = await (await service()).setSleepMode(id, input.sleep_mode, ctx.organizationId);
      updated(ctx, id, { action: "sleepMode.set", sleepMode: input.sleep_mode });
      return data;
    },
    async setOptions(ctx, id, input) {
      const data = presentProject(
        await (await service()).updateOptions(id, input, ctx.organizationId),
      );
      updated(ctx, id, { action: "options.set", keys: Object.keys(input) });
      return data;
    },
    async setBranch(ctx, id, input) {
      const data = await (await service()).setBranch(id, input.branch, ctx.organizationId);
      updated(ctx, id, { action: "branch.set", gitBranch: input.branch });
      return data;
    },
    async enable(ctx, id) {
      const data = await (await service()).enableProject(id, ctx.organizationId);
      updated(ctx, id, { action: "enabled" });
      return data;
    },
    async disable(ctx, id) {
      const data = await (await service()).disableProject(id, ctx.organizationId);
      updated(ctx, id, { action: "disabled" });
      return data;
    },
    async retryRouting(ctx, id) {
      const { canRouteSelfApp } = await import("../../lib/self-app-routing");
      const isSelfApp = await canRouteSelfApp(ctx, id);
      const data = await (
        await service()
      ).retryProjectRouting(id, ctx.organizationId, { isSelfApp });
      if (data.ok) updated(ctx, id, { action: "routing_retried" });
      return data;
    },
    async runtimeLogs(ctx, id, input) {
      return (await service()).getRuntimeLogs(id, ctx.organizationId, input?.tail);
    },
    async getCloneToken(ctx, id) {
      const project = await (await service()).getProject(id, ctx.organizationId);
      return {
        hasToken: !!project.cloneTokenEncrypted,
        setAt: project.cloneTokenSetAt?.toISOString() ?? null,
      };
    },
    async updateCloneToken(ctx, id, input) {
      const project = await (await service()).getProject(id, ctx.organizationId);
      const setAt = input.token ? new Date() : null;
      await repos.project.update(project.id, {
        cloneTokenEncrypted: input.token ? encrypt(input.token) : null,
        cloneTokenSetAt: setAt,
      });
      const data = { hasToken: !!input.token, setAt: setAt?.toISOString() ?? null };
      updated(
        ctx,
        id,
        input.token
          ? { action: "cloneToken.set", setAt: data.setAt }
          : { action: "cloneToken.cleared" },
      );
      return data;
    },
    async deletionPreview(ctx, id) {
      const project = await repos.project.findById(id);
      assertResourceInOrg(project, "Project", ctx.organizationId, id);
      return (await service()).previewProjectDeletion(project);
    },
  };
}
