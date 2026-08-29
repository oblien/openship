/**
 * The grantable surface, for the API.
 *
 * The list itself lives in @repo/core (`access-grants.ts`) because the dashboard
 * needs it too and cannot import from `apps/api`. This module stays as the API's
 * import point so the existing call sites — the permissions controller, the token
 * minter, and the satisfiability ratchet — keep resolving.
 *
 * `test/lib/permission-grant-satisfiability.test.ts` pins the invariant that
 * makes this list load-bearing: every entry must be provably authorized through
 * `checkPermission` or `canUseGitHubRepo`. A grantable type that nothing can
 * satisfy is a UI lie — the owner picks it, the mint accepts it, every call 404s.
 */

export {
  GRANTABLE_RESOURCE_TYPES,
  isGrantableResourceType,
  type GrantableResourceType,
} from "@repo/core";
