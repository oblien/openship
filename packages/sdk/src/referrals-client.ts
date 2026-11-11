import {
  ReferralOperationSchemas,
  ReferralRoutes,
  type ReferralOperations,
} from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteScopedOperations } from "./resource-client";

export function createRemoteReferralOperations(http: HttpClient): ReferralOperations {
  const routes = Object.fromEntries(
    Object.entries(ReferralRoutes).map(([name, route]) => [
      name,
      { method: route.method, path: () => route.path, envelope: "data" as const },
    ]),
  );
  return createRemoteScopedOperations(
    http,
    ReferralOperationSchemas,
    routes as Parameters<typeof createRemoteScopedOperations<typeof ReferralOperationSchemas>>[2],
  );
}
