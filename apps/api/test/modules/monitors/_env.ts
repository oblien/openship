/**
 * Env the monitors E2E harness needs set BEFORE `config/env` (and anything that
 * imports it) is first evaluated. Imported first by `_harness.ts`, which every
 * monitors test file imports before touching the real modules.
 *
 *  - INTERNAL_TOKEN     — config/env's boot guard throws without it (non-desktop).
 *  - BETTER_AUTH_SECRET — auth-derived encryption key material.
 *  - OPENSHIP_JOB_RUNNER — force in-process so job-event imports never probe Redis.
 * CLOUD_MODE stays unset (false) so the monitor routes' `localOnly` doesn't 404.
 */
process.env.INTERNAL_TOKEN ||= "test-internal-token";
process.env.BETTER_AUTH_SECRET ||= "test-better-auth-secret-please-ignore-0123456789";
process.env.OPENSHIP_JOB_RUNNER ||= "in-process";
process.env.DEPLOY_MODE ||= "docker";
