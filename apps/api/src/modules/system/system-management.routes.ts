/** HTTP authentication enters the same settings and instance authorization as native calls. */
import { Hono } from "hono";
import {
  BrowseDirectoriesInputSchema,
  UpdateInstanceSettingsInputSchema,
  UpdateInstanceEmailSettingsInputSchema,
  InstanceTestEmailInputSchema,
  RemoveEdgeOrphanInputSchema,
} from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import { operationContext, operationData } from "../../lib/operation-context";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import * as setup from "./setup.controller";
import * as edgeOrphans from "./edge-orphans.controller";
import * as fs from "./filesystem.controller";

const r = secureRouter(new Hono(), { module: "system", basePath: "/api/system", localOnly: true });

// These two reads expose only public configuration. Mutations and diagnostics
// additionally require the persisted instance role in the shared operation.
r.get("/settings", { tag: "settings:read", authorizationHandledByOperation: true, mcp: { description: "Read public instance settings and setup state, with secrets masked." } }, setup.getSetup);
r.patch("/settings", { tag: "settings:write", body: UpdateInstanceSettingsInputSchema, authorizationHandledByOperation: true, auditHandledByOperation: true, mcpExcluded: "Instance identity and authentication settings are operator-controlled through Settings; workspace deployment preferences have dedicated MCP tools." }, setup.updateSettings);
r.delete("/settings", { tag: "settings:admin", authorizationHandledByOperation: true, auditHandledByOperation: true, mcpExcluded: "Instance reset/recovery is an operator workflow in Settings, not a tenant automation operation." }, setup.deleteSettings);
r.get("/settings/email", { tag: "settings:read", authorizationHandledByOperation: true, mcp: { description: "Read instance email-delivery configuration with credentials masked." } }, setup.getEmailSettings);
r.put("/settings/email", { tag: "settings:write", body: UpdateInstanceEmailSettingsInputSchema, authorizationHandledByOperation: true, auditHandledByOperation: true, mcpExcluded: "Instance-wide email identity and credentials are configured by the instance administrator in Settings." }, setup.updateEmailSettings);
r.post("/settings/email/test", { tag: "settings:write", body: InstanceTestEmailInputSchema, authorizationHandledByOperation: true, auditHandledByOperation: true, mcpExcluded: "Instance email setup test sends to an arbitrary recipient; use the instance administrator’s Settings workflow." }, setup.sendTestEmail);

// The orphan scan compares every organization's domains. Read and removal both
// require instance authority; removal still names and rechecks a single hostname.
r.get("/edge/untracked", { tag: "settings:read", authorizationHandledByOperation: true, mcp: { description: "Inspect edge hostnames that are not owned by any project in this instance. Requires instance administrator authority; compare ownership before removing anything." } }, edgeOrphans.listUntrackedEdgeSites);
r.post("/edge/untracked/remove", { tag: "settings:admin", body: RemoveEdgeOrphanInputSchema, authorizationHandledByOperation: true, auditHandledByOperation: true, mcp: { description: "Remove one untracked hostname from the edge after rechecking that no project owns it. Requires instance administrator authority. Never use this to repair a domain still owned by a project." } }, edgeOrphans.removeUntrackedEdgeSite);
r.get("/browse", { tag: "settings:read", authorizationHandledByOperation: true, mcp: { description: "Browse source directories on this Openship controller, not the MCP client. Requires instance administrator authority; use folder upload for a client-side directory." }, query: BrowseDirectoriesInputSchema }, fs.browse);
r.get("/diagnostics", { tag: "settings:read", authorizationHandledByOperation: true, mcp: { description: "Read instance health, database/migration status and resource counts. Requires instance administrator authority. This does not inspect every remote workload." } }, async c =>
  c.json(await operationData(c, getPlatformKernel().system.health(operationContext(c)))));

export const systemManagementRoutes = r.hono;
