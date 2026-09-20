import { AppError, NotFoundError } from "@repo/core";
import { OperationError } from "@repo/contracts";
import { repos } from "@repo/db";
import type { ServiceDependencies } from "../../../services";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { audit } from "../../lib/audit-emitter";
import { parseRevealKeys, pickRevealed } from "../../lib/env-reveal";
import { sshManager } from "../../lib/ssh-manager";
import * as service from "./service.service";
import { applyServiceEnvironment } from "./service-environment";

function record(
  ctx: ExecutionContext,
  id: string,
  action: "write" | "admin",
  after: unknown,
  eventType = `project:service:${action}`,
) {
  audit.recordAsync(
    {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
      source: ctx.source ?? "api",
      sourceClientId: ctx.sourceClientId,
    },
    {
      eventType,
      resourceType: "service",
      resourceId: id,
      after,
    },
  );
}

/** Preserve legacy service validation failures, without masking authorization or structured errors. */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message === "service-not-found")
      throw new NotFoundError("Service");
    throw new OperationError(
      error instanceof Error ? error.message : "Service operation failed",
      400,
      "SERVICE_OPERATION_FAILED",
      { success: false },
    );
  }
}

async function visible<T>(ctx: ExecutionContext, rows: T[], id: (row: T) => string): Promise<T[]> {
  const permitted = await Promise.all(
    rows.map((row) =>
      authorization.checkPermissionOnResource(ctx, {
        resourceType: "service",
        resourceId: id(row),
        action: "read",
      }),
    ),
  );
  return rows.filter((_, index) => permitted[index]);
}

export const serviceDependencies: ServiceDependencies = {
  parentFor: async (_ctx, id) => (await repos.service.findById(id))?.projectId,
  collection: {
    list: (ctx, id) =>
      run(async () => visible(ctx, await service.listServices(ctx, id), (row) => row.id)),
    async create(ctx, id, input) {
      const result = await run(() => service.createService(ctx, id, input));
      record(ctx, result.id, "write", { operation: "create", projectId: id, name: result.name });
      return result;
    },
    async sync(ctx, id, input) {
      if (input.services.length === 0)
        throw new OperationError(
          "Refusing to sync an empty compose service list",
          400,
          "SERVICE_OPERATION_FAILED",
          { success: false },
        );
      // The retained importer rebuilds rows field by field. Compose's open input
      // contract is intentional, and its extended fields remain intact.
      const result = await run(() =>
        service.syncComposeServices(
          ctx,
          id,
          input.services as Parameters<typeof service.syncComposeServices>[2],
        ),
      );
      record(ctx, "*", "write", {
        operation: "sync",
        projectId: id,
        serviceNames: input.services.map((row) => row.name),
      });
      return result;
    },
    activeContainers: (ctx, id) =>
      run(async () =>
        visible(ctx, await service.getActiveServiceContainers(ctx, id), (row) => row.serviceId),
      ),
  },
  resources: {
    get: (ctx, projectId, id) => run(() => service.getService(ctx, projectId, id)),
    async update(ctx, projectId, id, input) {
      const result = await run(() => service.updateService(ctx, projectId, id, input));
      record(ctx, id, "write", { operation: "update", projectId, fields: Object.keys(input) });
      return result;
    },
    async remove(ctx, projectId, id) {
      await run(() => service.deleteService(ctx, projectId, id));
      record(ctx, id, "admin", { operation: "remove", projectId });
      return { success: true };
    },
    async acceptDrift(ctx, projectId, id) {
      const result = await run(() => service.acceptServiceDrift(ctx, projectId, id));
      record(ctx, id, "write", { operation: "drift.accept", projectId });
      return result;
    },
    async keepDrift(ctx, projectId, id) {
      const result = await run(() => service.keepServiceDrift(ctx, projectId, id));
      record(ctx, id, "write", { operation: "drift.keep", projectId });
      return result;
    },
    listEnvVars: (ctx, projectId, id, input) =>
      run(() => service.listServiceEnvVars(ctx, projectId, id, input?.environment)),
    async setEnvVars(ctx, projectId, id, input) {
      const result = await run(() => service.setServiceEnvVars(ctx, projectId, id, input));
      record(ctx, id, "write", {
        operation: "env.replace",
        projectId,
        environment: input.environment,
        keys: input.vars.map((row) => row.key),
      });
      return { success: true, ...result };
    },
    async revealEnv(ctx, projectId, id, input) {
      const keys = parseRevealKeys(input.keys);
      const stored = await run(() =>
        input.environment
          ? service.revealServiceEnvVars(ctx, projectId, id, input.environment)
          : service.revealServiceEnv(ctx, projectId, id),
      );
      const result = pickRevealed(stored, keys);
      record(ctx, id, "write", { projectId, revealedEnvKeys: Object.keys(result) });
      return result;
    },
    volumeSizes: (ctx, projectId, id) =>
      run(async () => ({
        success: true,
        ...(await service.getServiceVolumeSizes(ctx, projectId, id)),
      })),
    async start(ctx, projectId, id) {
      await run(() => service.startServiceContainer(ctx, projectId, id));
      record(ctx, id, "write", { operation: "start", projectId });
      return { success: true };
    },
    async stop(ctx, projectId, id) {
      await run(() => service.stopServiceContainer(ctx, projectId, id));
      record(ctx, id, "write", { operation: "stop", projectId });
      return { success: true };
    },
    async restart(ctx, projectId, id, input) {
      const result = await run(() => service.restartServiceContainer(ctx, projectId, id, input));
      record(ctx, id, "write", { operation: "restart", projectId, force: input?.force ?? false });
      return { success: true, ...result };
    },
    async applyEnvironment(ctx, projectId, id) {
      const result = await run(() => applyServiceEnvironment(ctx, projectId, id));
      record(ctx, id, "write", { operation: "env.apply", projectId, containerId: result.containerId });
      return result;
    },
    runtimeLogs: (ctx, projectId, id, input) =>
      run(() => service.getServiceRuntimeLogs(ctx, projectId, id, input?.tail)),
    async exec(ctx, projectId, id, input) {
      const command = input.command.trim();
      if (!command) throw new OperationError("command required", 400, "COMMAND_REQUIRED");
      const result = await run(() =>
        service.execInServiceContainer(ctx, projectId, id, { ...input, command }),
      );
      record(
        ctx,
        id,
        "write",
        {
          projectId,
          command,
          cwd: input.cwd ?? null,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          durationMs: result.durationMs,
          outputBytes: result.output.length,
        },
        "service.exec",
      );
      return result;
    },
  },
  subscribe: (ctx, projectId, id, input) => async (write) => {
    const stream = await run(() =>
      service.streamServiceRuntimeLogs(
        ctx,
        projectId,
        id,
        (entry) => {
          write(
            "log",
            JSON.stringify({
              type: "log",
              data: entry.rawData,
              message: entry.message,
              timestamp: entry.timestamp,
              level: entry.level,
            }),
          );
        },
        input,
      ),
    );
    if (stream.serverId) sshManager.retain(stream.serverId);
    let closed = false;
    return {
      success: true,
      async unsubscribe() {
        if (closed) return;
        closed = true;
        try {
          await stream.cleanup();
        } finally {
          if (stream.serverId) sshManager.release(stream.serverId);
        }
      },
    };
  },
};
