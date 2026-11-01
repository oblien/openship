import { Hono } from "hono";
import {
  ListBackupDestinationRunsSchema,
  CreateBackupDestinationSchema,
  UpdateBackupDestinationSchema,
  PreflightBackupDestinationSchema,
} from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./destination.controller";

const r = secureRouter(new Hono(), {
  module: "backup-destinations",
  basePath: "/api/backup-destinations",
});

r.get("/", { tag: "backup_destination:list", mcp: { description: "List accessible backup destinations with stored-byte/run statistics and availability. Destination secrets are masked." } }, ctrl.listAll);
r.get("/history", { tag: "backup_destination:list", mcp: { description: "Read backup history across accessible destinations, newest first. Use query.limit and the returned next cursor as query.before for further pages." }, query: ListBackupDestinationRunsSchema }, ctrl.listHistory);
r.post("/", { tag: "backup_destination:write", collection: true, body: CreateBackupDestinationSchema, auditHandledByOperation: true, mcp: { description: "Create an S3, SFTP or local backup destination using the existing destination contract. Preflight it before attaching a policy; creating a destination does not create a backup." } }, ctrl.create);
r.post("/preflight", { tag: "backup_destination:write", collection: true, body: PreflightBackupDestinationSchema, auditHandledByOperation: true, mcp: { description: "Test draft backup-destination connectivity and permissions without saving the destination. Returns checks and errors to resolve before policy setup." } }, ctrl.preflightDraft);
r.get("/:id", { tag: "backup_destination:read", mcp: { description: "Read one backup destination’s configuration and statistics with credentials masked." } }, ctrl.getOne);
r.get("/:id/usage", { tag: "backup_destination:read", mcp: { description: "List projects, services and policies using this backup destination so changes or deletion can be reviewed." } }, ctrl.getUsage);
r.get("/:id/runs", { tag: "backup_destination:read", mcp: { description: "List backups stored at this destination, newest first. Use query.limit and query.before to continue history." }, query: ListBackupDestinationRunsSchema }, ctrl.listRuns);
r.patch("/:id", { tag: "backup_destination:write", body: UpdateBackupDestinationSchema, auditHandledByOperation: true, mcp: { description: "Update a backup destination’s settings. Omitted credentials are preserved. Destination address changes are refused while dependent backups or cluster databases require the original location." } }, ctrl.update);
r.delete("/:id", { tag: "backup_destination:admin", auditHandledByOperation: true, mcp: { description: "Remove an unused backup destination from Openship. Check usage first; dependencies can block removal. This does not erase backup objects from external storage." } }, ctrl.remove);
r.post("/:id/preflight", { tag: "backup_destination:write", auditHandledByOperation: true, mcp: { description: "Test this saved backup destination’s connectivity and required access, returning the actual checks and errors." } }, ctrl.preflight);

export const backupDestinationRoutes = r.hono;
