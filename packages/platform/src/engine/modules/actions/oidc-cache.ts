import type { ActionOidcService } from "./oidc-service";

/** Import reconciliation can invalidate keys without initializing auth or the
 * execution engine. The next request reloads the committed instance identity. */
export const actionOidcCache: { service?: ActionOidcService } = {};

export function invalidateActionOidcKeyCache() {
  actionOidcCache.service = undefined;
}
