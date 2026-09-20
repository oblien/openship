import { AppError, NotFoundError, OperationError, type AppProjectSchemas } from "@repo/contracts";
import { UNKNOWN_CAPACITY } from "@repo/core";
import { repos } from "@repo/db";
import type { AppDependencies } from "../../../apps";
import type { ExecutionContext } from "../../../context";
import type { ResourceServices } from "../../../resource-operations";
import { authorization } from "../../lib/authorization";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { resolveProjectAuthority } from "../../lib/cloud/project-authority";
import { assertServerExecution } from "../system/server-access";
import * as install from "./app-install.service";
import * as custom from "./custom-app.service";
import * as settings from "./app-settings.service";
import { getTemplateForOrg } from "./catalog-source";

function record(ctx: ExecutionContext, operation: string, resourceId: string, after: unknown) {
  audit.recordAsync(operationAuditContext(ctx), { eventType: "project:write", resourceType: "project", resourceId, after: { operation, ...after as object } });
}
async function projectAuthority(ctx: ExecutionContext, id: string) {
  if (ctx.scopeMode === "fixed" && await resolveProjectAuthority(id, ctx.organizationId) === "cloud")
    throw new AppError("This cloud link has no tenant mapping. Connect directly with the cloud organizationId.", 409, "CLOUD_SCOPE_UNAVAILABLE");
}

export const appDependencies: AppDependencies = {
  collection: {
    listCatalog: install.getAppCatalog,
    listCustom: custom.listCustomApps,
    async saveCustom(ctx, input) {
      const result = await custom.saveCustomApp(ctx, input);
      record(ctx, "saveCustomApp", "*", result);
      return result;
    },
    async install(ctx, input) {
      try {
        const result = await install.installApp(ctx, input, {
          async assertDraft(projectId) {
            await authorization.authorize({ ...ctx, scopeMode: "fixed" }, { resourceType: "project", resourceId: projectId, action: "write" });
          },
        });
        record(ctx, "installApp", result.kind === "template" ? result.projectId : "*", { templateId: input.templateId, ...result });
        return result;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new OperationError(error instanceof Error ? error.message : "Failed to install app", 400, "APP_INSTALL_FAILED");
      }
    },
  },
  resources: {
    async getCatalogEntry(ctx, id) {
      const template = await getTemplateForOrg(ctx.organizationId, id);
      if (!template) throw new NotFoundError("App", id);
      let draft = await install.findOpenAppDraft(ctx, template.id);
      if (draft && !await authorization.checkPermissionOnResource(ctx, { resourceType: "project", resourceId: draft.projectId, action: "read" })) draft = null;
      return { template, draft };
    },
    async hostFit(ctx, id, input = {}) {
      if (input.serverId) {
        await authorization.authorize({ ...ctx, scopeMode: "fixed" }, { resourceType: "server", resourceId: input.serverId, action: "read" });
        const server = await repos.server.getInOrganization(input.serverId, ctx.organizationId);
        if (!server) throw new NotFoundError("Server", input.serverId);
        await assertServerExecution(server);
      } else if (process.env.OPENSHIP_NATIVE === "true" && process.env.OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION !== "true") {
        const template = await getTemplateForOrg(ctx.organizationId, id);
        return { minResources: template?.minResources ?? null, capacity: { ...UNKNOWN_CAPACITY }, fit: { ok: true } };
      }
      return install.getAppHostFit(ctx, id, input);
    },
    async removeCustom(ctx, id) {
      await custom.deleteCustomApp(ctx, id);
      record(ctx, "removeCustomApp", "*", { appId: id });
      return { ok: true };
    },
  },
};

export const appProjectOperations: ResourceServices<typeof AppProjectSchemas> = {
  async getAppSettings(ctx, id) {
    await projectAuthority(ctx, id);
    return settings.getAppProjectSettings(ctx, id);
  },
  async updateAppSettings(ctx, id, input) {
    await projectAuthority(ctx, id);
    const changes = input.changes ?? [];
    const result = await settings.updateAppProjectSettings(ctx, id, changes);
    record(ctx, "updateAppSettings", id, { fields: changes.map(({ service, key }) => ({ service, key })), ...result });
    return result;
  },
  async getAppConnection(ctx, id) {
    await projectAuthority(ctx, id);
    const result = await settings.getAppConnectionView(ctx, id);
    record(ctx, "getAppConnection", id, { revealedOutputs: result.outputs.filter(output => output.secret).map(output => output.id) });
    return result;
  },
};
