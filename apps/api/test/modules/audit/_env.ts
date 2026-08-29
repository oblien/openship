/**
 * Env the audit E2E harness needs set BEFORE `config/env` (and anything that
 * imports it) is first evaluated. Imported first by `_harness.ts`.
 *
 *  - INTERNAL_TOKEN     — config/env's boot guard throws without it (non-desktop).
 *  - BETTER_AUTH_SECRET — required by the same guard.
 * CLOUD_MODE stays unset so nothing takes a SaaS branch.
 */
process.env.INTERNAL_TOKEN ||= "test-internal-token";
process.env.BETTER_AUTH_SECRET ||= "test-better-auth-secret-please-ignore-0123456789";
process.env.DEPLOY_MODE ||= "docker";
