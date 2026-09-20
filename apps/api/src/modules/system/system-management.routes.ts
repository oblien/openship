/** HTTP authentication enters the same settings and instance authorization as native calls. */
import { Hono } from "hono";
import { UpdateInstanceSettingsInputSchema, UpdateInstanceEmailSettingsInputSchema, InstanceTestEmailInputSchema, RemoveEdgeOrphanInputSchema } from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import { operationContext, operationData } from "../../lib/operation-context";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import * as setup from "./setup.controller";
import * as edgeOrphans from "./edge-orphans.controller";
import * as fs from "./filesystem.controller";

const r = secureRouter(new Hono(), { module: "system", basePath: "/api/system" });

// These two reads expose only public configuration. Mutations and diagnostics
// additionally require the persisted instance role in the shared operation.
r.get("/settings", { tag: "settings:read", authorizationHandledByOperation: true }, setup.getSetup);
r.patch("/settings", { tag: "settings:write", body: UpdateInstanceSettingsInputSchema, authorizationHandledByOperation: true, auditHandledByOperation: true }, setup.updateSettings);
r.delete("/settings", { tag: "settings:admin", authorizationHandledByOperation: true, auditHandledByOperation: true }, setup.deleteSettings);
r.get("/settings/email", { tag: "settings:read", authorizationHandledByOperation: true }, setup.getEmailSettings);
r.put("/settings/email", { tag: "settings:write", body: UpdateInstanceEmailSettingsInputSchema, authorizationHandledByOperation: true, auditHandledByOperation: true }, setup.updateEmailSettings);
r.post("/settings/email/test", { tag: "settings:write", body: InstanceTestEmailInputSchema, authorizationHandledByOperation: true, auditHandledByOperation: true }, setup.sendTestEmail);

// The orphan scan compares every organization's domains. Read and removal both
// require instance authority; removal still names and rechecks a single hostname.
r.get("/edge/untracked", { tag: "settings:read", authorizationHandledByOperation: true }, edgeOrphans.listUntrackedEdgeSites);
r.post("/edge/untracked/remove", { tag: "settings:admin", body: RemoveEdgeOrphanInputSchema, authorizationHandledByOperation: true, auditHandledByOperation: true }, edgeOrphans.removeUntrackedEdgeSite);
r.get("/browse", { tag: "settings:read", authorizationHandledByOperation: true }, fs.browse);
r.get("/diagnostics", { tag: "settings:read", authorizationHandledByOperation: true }, async c =>
  c.json(await operationData(c, getPlatformKernel().system.health(operationContext(c)))));

export const systemManagementRoutes = r.hono;
