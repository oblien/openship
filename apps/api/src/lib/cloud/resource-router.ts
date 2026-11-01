import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { MiddlewareHandler } from "hono";
import { resolveResourceAuthority, type CloudResourceType } from "@repo/platform/engine/lib/cloud/resource-authority";
import { assertCloudProxyScope } from "@repo/platform/engine/lib/cloud/scope";
import { permission } from "../permission";
import { getRequestContext } from "../request-context";
import { DEFAULT_ID_PARAMS, parsePermissionTag, type PermissionSpec } from "../route-permission";
import { proxyToSaaS } from "./project-router";

/** Resource authority belongs to the existing route, not to a second set of
 * Cloud controllers. JSON and SSE use the same authenticated transport. */
export function cloudResourceRouter(path: string, spec: PermissionSpec): MiddlewareHandler | null {
  const tag = parsePermissionTag(spec.tag);
  if (spec.skipAuth || spec.localOnly || ((spec.collection || tag.isList) && tag.root === tag.leaf)) return null;
  const types: readonly string[] = ["project", "deployment", "domain", "service", "server"];
  if (!types.includes(spec.cloudResource ?? tag.root)) return null;
  const type = (spec.cloudResource ?? tag.root) as CloudResourceType;
  const param = spec.ids?.[type] ?? DEFAULT_ID_PARAMS[type] ?? "id";
  // Cluster/network IDs also have server permission tags, but are not server
  // identities. Never infer a host from those infrastructure-resource paths.
  const inPath = path.includes(`:${param}`) && (type !== "server" || /\/servers?\/:/.test(path));
  const field = `${type}Id`;
  const inBody = !!spec.body?.properties?.[field];
  const inQuery = !!spec.query?.properties?.[field];
  if (!inPath && !inBody && !inQuery) return null;
  return async (c, next) => {
    const id = inPath ? c.req.param(param) : inQuery ? c.req.query(field)
      : (await c.req.json().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/lib/cloud/resource-router"); return ({}); }) as Record<string, unknown>)[field];
    if (typeof id !== "string" || !id) return next();
    const ctx = getRequestContext(c);
    if (await resolveResourceAuthority(type, id, ctx.organizationId) !== "cloud") return next();
    assertCloudProxyScope(ctx);
    // Some routes delegate authorization to their application operation. The
    // gateway replaces that operation, so it must apply the same resource gate.
    await permission.assert(ctx, { resourceType: type, resourceId: id, action: tag.action === "list" ? "read" : tag.action });
    c.set("operationContextApplied", true);
    c.set("routeResourceId", id);
    return proxyToSaaS(c, getRequestContext(c).organizationId);
  };
}
