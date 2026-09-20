import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./destination.controller";
import { CreateBackupDestinationSchema, UpdateBackupDestinationSchema, PreflightBackupDestinationSchema } from "@repo/contracts";

const r = secureRouter(new Hono(), {
  module: "backup-destinations",
  basePath: "/api/backup-destinations",
});


r.get("/", { tag: "backup_destination:list" }, ctrl.listAll);
r.post("/", { tag: "backup_destination:write", collection: true, body: CreateBackupDestinationSchema, auditHandledByOperation: true }, ctrl.create);
r.post("/preflight", { tag: "backup_destination:write", collection: true, body: PreflightBackupDestinationSchema, auditHandledByOperation: true }, ctrl.preflightDraft);
r.get("/:id", { tag: "backup_destination:read" }, ctrl.getOne);
r.get("/:id/usage", { tag: "backup_destination:read" }, ctrl.getUsage);
r.patch("/:id", { tag: "backup_destination:write", body: UpdateBackupDestinationSchema, auditHandledByOperation: true }, ctrl.update);
r.delete("/:id", { tag: "backup_destination:admin", auditHandledByOperation: true }, ctrl.remove);
r.post("/:id/preflight", { tag: "backup_destination:write", auditHandledByOperation: true }, ctrl.preflight);

export const backupDestinationRoutes = r.hono;
