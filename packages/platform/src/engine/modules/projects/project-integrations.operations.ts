import { NotFoundError, safeErrorMessage } from "@repo/core";
import type { ProjectIntegrationSchemas } from "@repo/contracts";
import { repos } from "@repo/db";
import type { ProjectDependencies } from "../../../projects";
import type { ResourceServices } from "../../../resource-operations";
import { env } from "../../config";
import { assertResourceInOrg } from "../../lib/resource-access";
import * as connections from "./project-connection.service";
import * as storage from "./project-storage.service";
import { readProjectEdgeConfig } from "./edge-config.service";

/** Controller-independent operations over the retained connection/storage implementations. */
export function createProjectIntegrationOperations(recordAudit: ProjectDependencies["recordAudit"]): ResourceServices<typeof ProjectIntegrationSchemas> {
  const audit = (ctx: Parameters<typeof recordAudit>[0], id: string, action: "write" | "admin", after: unknown) =>
    recordAudit(ctx, { eventType: `project:${action}`, resourceType: "project", resourceId: id, after });
  return {
    listConnectionCandidates: (ctx, id) => connections.listConnectionCandidates(ctx, id),
    listConnections: (ctx, id) => connections.listConnections(ctx, id),
    listConnectionConsumers: (ctx, id) => connections.listConsumers(ctx, id),
    async createConnection(ctx, id, input) {
      const result = await connections.createConnection(ctx, id, input);
      audit(ctx, id, "write", { operation: "connection.create", sourceProjectId: input.sourceProjectId, outputId: input.outputId, envKey: input.envKey, mode: result.connection.mode });
      return result;
    },
    async connectBundle(ctx, id, input) {
      const result = await connections.connectBundle(ctx, id, input);
      audit(ctx, id, "write", { operation: "connection.bundle", sourceProjectId: input.sourceProjectId, items: input.items });
      return result;
    },
    async removeConnection(ctx, id, linkId) {
      const result = await connections.deleteConnection(ctx, id, linkId);
      audit(ctx, id, "admin", { operation: "connection.remove", linkId });
      return result;
    },
    getStorage: (ctx, id) => storage.getObjectStorage(ctx, id),
    async bindStorage(ctx, id, input) {
      const result = await storage.bindObjectStorage(ctx, id, input);
      audit(ctx, id, "write", { operation: "storage.bind", provider: result.binding.provider, bucket: result.binding.bucket, sourceProjectId: result.binding.sourceProjectId ?? null, envKeys: result.binding.envKeys });
      return result;
    },
    async unbindStorage(ctx, id) {
      const result = await storage.unbindObjectStorage(ctx, id);
      audit(ctx, id, "admin", { operation: "storage.unbind", removed: result.removed });
      return result;
    },
    async getEdgeConfig(ctx, id) {
      if (env.CLOUD_MODE) throw new NotFoundError("Operation");
      const project = await repos.project.findById(id);
      assertResourceInOrg(project, "Project", ctx.organizationId, id);
      try { return await readProjectEdgeConfig(project); }
      catch (error) {
        return { reachable: false, error: safeErrorMessage(error), saved: project.routingConfig?.proxy ?? {}, hosts: [] };
      }
    },
  };
}
