import {
  AffiliateOperationSchemas,
  AffiliateRoutes,
  type AffiliateOperations,
} from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations } from "./resource-client";

export function createRemoteAffiliateOperations(http: HttpClient): AffiliateOperations {
  const routes = Object.fromEntries(
    Object.entries(AffiliateRoutes).map(([name, route]) => [
      name,
      { method: route.method, path: () => route.path, envelope: "data" as const },
    ]),
  );
  return createRemoteScopedOperations(
    http,
    AffiliateOperationSchemas,
    routes as Parameters<typeof createRemoteScopedOperations<typeof AffiliateOperationSchemas>>[2],
  );
}
