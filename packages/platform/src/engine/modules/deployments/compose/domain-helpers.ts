/**
 * Compose domain helpers - currently only port helpers, which live in
 * lib/deployable-service.ts so lib/ can use them without reaching into
 * modules/. Re-exported here for the compose modules that already
 * imported them at this path.
 *
 * Older subdomain helpers (`normalizeSubdomain`, `defaultServiceSubdomain`)
 * were removed - neither had any callers and resolveServiceHostnameLabel
 * from @repo/core covers the same job inline at the use sites.
 */

// Port helpers moved to lib/deployable-service.ts so lib/routing-domains.ts
// can use them without reaching into modules/. Re-exported here for the
// compose modules that already imported them at this path.
export { parseServicePort, resolveServicePort } from "../../../lib/deployable-service";
