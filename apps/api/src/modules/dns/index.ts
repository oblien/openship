/**
 * DNS module surface for other modules (the domains module, mainly).
 *
 * Deliberately does NOT re-export `dns.routes`. `secureRouter` registers routes
 * at module-eval time and drags the auth/permission/rate-limit graph in with it,
 * so a service that imports this barrel would mount the HTTP route table as a
 * side effect of being imported — which is how a unit test that partially mocks
 * `@repo/db` starts failing in a file that never mentions DNS. `app.ts` imports
 * `./dns.routes` directly, which is the only place that should.
 */

export * from "./types";
export { resolveDnsProvider, listDnsProviders, describeDnsProviders } from "./registry";
export * from "./dns-credential.service";
