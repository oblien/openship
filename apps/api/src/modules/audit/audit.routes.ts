/** HTTP query/envelope adapters over the shared organization audit operations. */
import { Hono, type Context } from "hono";
import { AuditSettingsInput } from "@repo/contracts";
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
r.get("/", { tag: "audit:read" }, async c => {
  const { items, ...rest } = await operationData(c, audit().list(operationContext(c), query(c)));
  return c.json({ data: items, ...rest });
});
r.get("/facets", { tag: "audit:read" }, async c => c.json(await operationData(c, audit().facets(operationContext(c), query(c)))));
r.get("/settings", { tag: "audit:read" }, async c => c.json(await operationData(c, audit().getSettings(operationContext(c)))));
r.patch("/settings", { tag: "audit:write", body: AuditSettingsInput, auditHandledByOperation: true }, async c =>
  c.json(await operationData(c, audit().updateSettings(operationContext(c), await c.req.json()))));
export const auditRoutes = r.hono;
