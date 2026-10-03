import "../modules/jobs/_env";
import { afterEach, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ cloud: true }));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get CLOUD_MODE() {
        return mode.cloud;
      },
    },
  };
});

// Import the production app and every mounted route. Only host startup and
// background integrations are disabled; permissions, schemas and the scanner
// are real. @repo/db supplies its isolated PGlite database under Vitest.
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<typeof import("@repo/adapters")>()),
  initPlatform: async () => {},
}));
vi.mock("@repo/platform/engine/modules/jobs/job.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/jobs/job.service")>()),
  reconcileJobs: async () => ({ registered: 0, total: 0 }),
}));
vi.mock("@repo/platform/engine/lib/job-runner/index", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/job-runner/index")>()),
  getJobRunner: async () => ({ start: async () => {}, describe: () => "boot-test" }),
}));
vi.mock("@repo/platform/engine/modules/backups/triggers/cron", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/backups/triggers/cron")>()),
  reconcileAllSchedules: async () => ({ registered: 0, skipped: 0 }),
}));
vi.mock("@repo/platform/engine/modules/billing/billing-anniversary.cron", () => ({
  scheduleBillingAnniversary: async () => {},
}));
vi.mock("@repo/platform/engine/modules/billing/billing-namespace.provision", () => ({
  backfillOrgNamespaces: async () => ({ done: 0, failed: 0 }),
}));
vi.mock("@repo/platform/engine/lib/openship-cloud", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/openship-cloud")>()),
  ensureOblienWebhook: async () => {},
}));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", async (original) => ({
  ...(await original<
    typeof import("@repo/platform/engine/modules/billing/billing-oblien-quota")
  >()),
  ensureOblienDefaultQuota: async () => {},
}));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienBillingApi: () => ({ assertResellerSupport: async () => {} }),
  getOblienClient: () => {
    throw new Error("A route boot test must not contact Oblien");
  },
}));
vi.mock("@repo/platform/engine/modules/cloud-support/index", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/cloud-support/index")>()),
  startCloudSupport: async () => {},
}));
vi.mock("@repo/platform/engine/modules/cloud-analytics/index", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/cloud-analytics/index")>()),
  startCloudAnalytics: async () => {},
}));
vi.mock("@repo/platform/engine/modules/github/github.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/github/github.service")>()),
  backfillWebhookSecrets: async () => {},
}));
vi.mock("@repo/platform/engine/lib/notification-workers", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/notification-workers")>()),
  startNotificationRunner: () => {},
}));
vi.mock("@repo/platform/engine/modules/migration/migration.orchestrator", async (original) => {
  const actual =
    await original<
      typeof import("@repo/platform/engine/modules/migration/migration.orchestrator")
    >();
  return {
    ...actual,
    migrationOrchestrator: {
      ...actual.migrationOrchestrator,
      recoverInterruptedMigrations: async () => {},
    },
  };
});
vi.mock("@repo/platform/engine/lib/startup/index", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/startup/index")>()),
  runStartupHooks: async () => {},
}));

afterEach(() => vi.restoreAllMocks());

it.each([true, false])(
  "boots the complete production route tree (Cloud=%s)",
  async (cloud) => {
    mode.cloud = cloud;
    vi.resetModules();
    const { app } = await import("../../src/app");
    const { scanRoutes, enforceRouteScanAtBoot } = await import("../../src/lib/route-scanner");
    const result = scanRoutes(app);
    expect(result.summary.permissionGated).toBeGreaterThan(300);
    expect(result.errors).toEqual([]);
    const paths = new Set(app.routes.map((route) => route.path));
    expect(paths.has("/api/system/servers/:id/ensure")).toBe(true);
    expect(paths.has("/api/system/servers/:id/resize")).toBe(true);
    expect(paths.has("/api/system/onboarding")).toBe(!cloud);
    expect(paths.has("/api/migration/sources")).toBe(true);
    expect(paths.has("/api/migration/migrate")).toBe(true);
    const { getMcpTools, resetMcpToolCache } = await import("../../src/modules/mcp/mcp-tools");
    resetMcpToolCache();
    const names = getMcpTools().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.includes("get_system_servers")).toBe(true);
    expect(names.includes("get_jobs")).toBe(true);
    expect(names.includes("get_migration_sources")).toBe(true);
    expect(names.includes("post_migration_migrate")).toBe(true);
    expect(names.includes("post_migration_adopt")).toBe(!cloud);
    expect(names.includes("post_migration_reimport")).toBe(!cloud);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("The production route scanner refused startup");
    });
    enforceRouteScanAtBoot(app);
    expect(exit).not.toHaveBeenCalled();
    // Imports the entire application graph. Leave room for cold CI transforms
    // alongside the database integration suite; the scanner itself stays synchronous.
  },
  120_000,
);
