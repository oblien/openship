/** HTTP query/envelope adapters over the shared organization audit operations. */
import { Hono, type Context } from "hono";
import { AuditQuerySchema, AuditSettingsInput } from "@repo/contracts";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { secureRouter } from "../../lib/secure-router";
import { operationContext, operationData } from "../../lib/operation-context";

const r = secureRouter(new Hono(), { module: "audit", basePath: "/api/audit" });
const audit = () => getPlatformKernel().audit;
function query(c: Context) {
  const raw = c.req.query();
  return { ...raw,
    limit: raw.limit === undefined ? undefined : Math.min(Number(raw.limit), 200),
    perPage: raw.perPage === undefined ? undefined : Math.min(Number(raw.perPage), 200),
    page: raw.page === undefined ? undefined : Number(raw.page),
  };
}
r.get("/", { tag: "audit:read", mcp: { description: "List workspace audit events with actor, resource and source filters. Use page/perPage or cursor/limit for pagination; inspect sourceClientId to identify MCP activity." }, query: AuditQuerySchema }, async c => {
  const { items, ...rest } = await operationData(c, audit().list(operationContext(c), query(c)));
  return c.json({ data: items, ...rest });
});
r.get("/facets", { tag: "audit:read", mcp: { description: "Read available audit filters, event counts, actors and client names for this workspace." }, query: AuditQuerySchema }, async c => c.json(await operationData(c, audit().facets(operationContext(c), query(c)))));
r.get("/settings", { tag: "audit:read", mcp: { description: "Read whether audit logging is enabled, its retention period and whether the caller can manage it." } }, async c => c.json(await operationData(c, audit().getSettings(operationContext(c)))));
r.patch("/settings", { tag: "audit:write", body: AuditSettingsInput, auditHandledByOperation: true, mcp: { description: "Change workspace audit logging and retention. Reducing retention can remove older audit history." } }, async c =>
  c.json(await operationData(c, audit().updateSettings(operationContext(c), await c.req.json()))));
export const auditRoutes = r.hono;
