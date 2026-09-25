import { AppError, NotFoundError, OperationError } from "@repo/contracts";
import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import type { BackupDestinationDependencies } from "../../../backup-destinations";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { authorization } from "../../lib/authorization";
import * as service from "./destination.service";

async function result<T>(work: () => Promise<T>, status: number): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof AppError) throw error;
    throw new OperationError(safeErrorMessage(error), status, "BACKUP_DESTINATION_FAILED");
  }
}
function record(ctx: ExecutionContext, id: string, operation: string, after: object = {}, action = "write") {
  audit.recordAsync(operationAuditContext(ctx), { eventType: `backup_destination:${action}`, resourceType: "backup_destination", resourceId: id, after: { operation, ...after } });
}
async function stored(ctx: ExecutionContext, id: string) {
  const row = await repos.backupDestination.findById(id);
  if (!row || row.organizationId !== ctx.organizationId) throw new NotFoundError("Backup destination", id);
  return row;
}
async function serverAccess(ctx: ExecutionContext, kind: string, serverId: string | null | undefined) {
  if (kind === "openship_server" && serverId) {
    await authorization.authorize({ ...ctx, scopeMode: "fixed" }, { resourceType: "server", resourceId: serverId, action: "write" });
  }
}

/** The existing service remains responsible for encryption, adapter probes, and storage rules. */
export const backupDestinationDependencies: BackupDestinationDependencies = {
  collection: {
    list: service.listDestinations,
    history: (ctx, input) => result(() => service.listDestinationHistory(ctx, undefined, input), 500),
    async create(ctx, input) {
      await serverAccess(ctx, input.kind, input.serverId);
      const destination = await result(() => service.createDestination(ctx, input), 400);
      record(ctx, destination.id, "create", { name: destination.name, kind: destination.kind });
      return destination;
    },
    async preflightDraft(ctx, input) {
      const { id, ...draft } = input;
      const existing = id ? await (async () => {
        await authorization.authorize({ ...ctx, scopeMode: "fixed" }, { resourceType: "backup_destination", resourceId: id, action: "write" });
        return stored(ctx, id);
      })() : undefined;
      await serverAccess(ctx, draft.kind, draft.serverId ?? existing?.serverId);
      const output = await result(() => service.preflightDraft(ctx, { ...draft, name: draft.name ?? "draft" }, id), 400);
      record(ctx, id ?? "*", "preflightDraft", { kind: draft.kind, ok: output.ok });
      return output;
    },
  },
  resources: {
    get: (ctx, id) => result(() => service.getDestination(ctx, id), 500),
    usage: (ctx, id) => result(() => service.getDestinationUsage(ctx, id), 500),
    runs: (ctx, id, input) => result(() => service.listDestinationHistory(ctx, id, input), 500),
    async update(ctx, id, input) {
      const existing = await stored(ctx, id);
      await serverAccess(ctx, existing.kind, input.serverId !== undefined ? input.serverId : existing.serverId);
      const destination = await result(() => service.updateDestination(ctx, id, input), 400);
      record(ctx, id, "update", { fields: Object.keys(input) });
      return destination;
    },
    async remove(ctx, id) {
      await result(() => service.deleteDestination(ctx, id), 400);
      record(ctx, id, "remove", {}, "admin");
      return { ok: true };
    },
    async preflight(ctx, id) {
      const existing = await stored(ctx, id);
      await serverAccess(ctx, existing.kind, existing.serverId);
      const output = await result(() => service.preflightDestination(ctx, id), 404);
      record(ctx, id, "preflight", { ok: output.ok });
      return output;
    },
  },
};
