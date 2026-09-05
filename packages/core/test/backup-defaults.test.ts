import { describe, it, expect } from "vitest";
import { planAppBackupDefaults, staggeredCron } from "../src/apps/backup-defaults";
import { DEFAULT_RETAIN_COUNT } from "../src/constants";
import { APP_TEMPLATES } from "../src/app-templates";
import type { AppTemplate } from "../src/app-templates";

/**
 * The planner decides what a fresh install gets backed up, from data catalog
 * entries already carry. Two failure modes are worth guarding: covering nothing
 * (an app installs and its data is unprotected, the bug this feature exists to
 * fix), and covering the wrong things (six dumps in one minute, or a cache
 * volume shipped to S3 nightly for no reason).
 */

const template = (overrides: Partial<AppTemplate>): AppTemplate =>
  ({
    id: "t",
    name: "T",
    description: "",
    kind: "template",
    logo: "t",
    category: "other",
    ...overrides,
  }) as AppTemplate;

describe("planAppBackupDefaults", () => {
  it("covers every service that declares a volume", () => {
    const plan = planAppBackupDefaults(
      template({
        services: [
          { name: "db", image: "postgres:16", volumes: ["data:/var/lib/postgresql/data"] },
          { name: "cache", image: "redis:7", volumes: ["r:/data"] },
        ],
      }),
    );
    expect(plan.map((p) => p.serviceName)).toEqual(["db", "cache"]);
  });

  it("leaves stateless services alone", () => {
    const plan = planAppBackupDefaults(
      template({ services: [{ name: "web", image: "nginx", ports: ["80"] }] }),
    );
    expect(plan).toEqual([]);
  });

  it("defers the producer choice to the registry rather than guessing from the image", () => {
    // "auto" is the point: `resolveProducerForService` detects pg_dump for this
    // service at run time. A planner that hardcoded "volume" here would copy the
    // data directory of a running Postgres — a torn, possibly unrestorable copy.
    const [policy] = planAppBackupDefaults(
      template({ services: [{ name: "db", image: "postgres:16", volumes: ["d:/data"] }] }),
    );
    expect(policy.payloadKind).toBe("auto");
  });

  it("defaults retention to the shared constant, and treats explicit null as unlimited", () => {
    const [derived] = planAppBackupDefaults(
      template({ services: [{ name: "db", image: "postgres:16", volumes: ["d:/data"] }] }),
    );
    expect(derived.retainCount).toBe(DEFAULT_RETAIN_COUNT);

    const [authored] = planAppBackupDefaults(
      template({
        services: [{ name: "db", image: "postgres:16", volumes: ["d:/data"] }],
        backup: { services: [{ service: "db", retainCount: null }] },
      }),
    );
    expect(authored.retainCount).toBeNull();
  });

  it("staggers schedules so one app can't start every dump in the same minute", () => {
    const plan = planAppBackupDefaults(
      template({
        services: Array.from({ length: 6 }, (_, i) => ({
          name: `s${i}`,
          image: "x",
          volumes: [`v${i}:/data`],
        })),
      }),
    );
    const crons = plan.map((p) => p.cronExpression);
    expect(new Set(crons).size).toBe(6);
    // Still inside the quiet hours, not spilling into the working day.
    for (const cron of crons) {
      const hour = Number(cron.split(" ")[1]);
      expect(hour).toBeGreaterThanOrEqual(3);
      expect(hour).toBeLessThanOrEqual(4);
    }
  });

  it("does not leave gaps in the stagger when a service is skipped", () => {
    // Staggering by index-in-`services` rather than index-in-plan would leave the
    // second policy on the third slot — harmless but arbitrary, and it makes the
    // schedule depend on how many services were filtered out.
    const plan = planAppBackupDefaults(
      template({
        services: [
          { name: "a", image: "x", volumes: ["a:/d"] },
          { name: "skipped", image: "x", volumes: ["b:/d"] },
          { name: "c", image: "x", volumes: ["c:/d"] },
        ],
        backup: { services: [{ service: "skipped", skip: true }] },
      }),
    );
    expect(plan.map((p) => p.cronExpression)).toEqual([staggeredCron(0), staggeredCron(1)]);
  });

  it("honours skip, and an authored rule overrides every derived field", () => {
    const plan = planAppBackupDefaults(
      template({
        services: [
          { name: "cache", image: "redis:7", volumes: ["r:/data"] },
          { name: "db", image: "postgres:16", volumes: ["d:/data"] },
        ],
        backup: {
          services: [
            { service: "cache", skip: true, reason: "rebuildable" },
            {
              service: "db",
              payloadKind: "pg_dump",
              cronExpression: "23 1 * * *",
              retainCount: 30,
              retainDays: 90,
              payloadConfig: { exclude: ["audit"] },
            },
          ],
        },
      }),
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      serviceName: "db",
      payloadKind: "pg_dump",
      cronExpression: "23 1 * * *",
      retainCount: 30,
      retainDays: 90,
      payloadConfig: { exclude: ["audit"] },
      authored: true,
    });
  });

  it("covers a service the app named even when it declares no volume", () => {
    // The escape hatch for data that isn't in a declared volume — a dump piped
    // out of the service rather than a directory copied off disk.
    const plan = planAppBackupDefaults(
      template({
        services: [{ name: "api", image: "x" }],
        backup: {
          services: [
            {
              service: "api",
              payloadKind: "custom_command",
              payloadConfig: { command: "dump.sh" },
            },
          ],
        },
      }),
    );
    expect(plan.map((p) => p.serviceName)).toEqual(["api"]);
  });

  it("does not mutate the template's payloadConfig", () => {
    const config = { exclude: ["x"] };
    const [policy] = planAppBackupDefaults(
      template({
        services: [{ name: "db", image: "x", volumes: ["d:/data"] }],
        backup: { services: [{ service: "db", payloadConfig: config }] },
      }),
    );
    (policy.payloadConfig as Record<string, unknown>).exclude = ["mutated"];
    expect(config.exclude).toEqual(["x"]);
  });
});

describe("the bundled catalog", () => {
  /**
   * The number that motivated the feature: most of the catalog is stateful, and
   * before this planner every one of those services needed the ten-field policy
   * form by hand. If a refactor ever makes this return nothing, installs go back
   * to shipping unprotected data — silently.
   */
  it("plans a policy for the apps that actually hold data", () => {
    const planned = APP_TEMPLATES.filter((t) => planAppBackupDefaults(t).length > 0);
    expect(planned.length).toBeGreaterThanOrEqual(20);
  });

  it("skips PostHog's broker tier and keeps its stores", () => {
    const posthog = APP_TEMPLATES.find((t) => t.id === "posthog");
    expect(posthog).toBeDefined();
    const names = planAppBackupDefaults(posthog!).map((p) => p.serviceName);
    expect(names).toContain("db");
    expect(names).toContain("clickhouse");
    expect(names).toContain("objectstorage");
    expect(names).not.toContain("redis");
    expect(names).not.toContain("kafka");
    expect(names).not.toContain("zookeeper");
  });

  it("never plans two policies over one shared volume", () => {
    // Supabase mounts supabase_storage_data into both `storage` and `imgproxy`;
    // covering both would upload the same bytes twice, every night, forever.
    for (const app of APP_TEMPLATES) {
      const planned = new Set(planAppBackupDefaults(app).map((p) => p.serviceName));
      const seen = new Map<string, string>();
      for (const service of app.services ?? []) {
        if (!planned.has(service.name)) continue;
        for (const volume of service.volumes ?? []) {
          const named = volume.split(":")[0];
          // Bind mounts (host paths) aren't named volumes and can't collide this way.
          if (named.startsWith("/") || named.startsWith(".")) continue;
          const owner = seen.get(named);
          expect(
            owner,
            `${app.id}: volume "${named}" is planned for both "${owner}" and "${service.name}"`,
          ).toBeUndefined();
          seen.set(named, service.name);
        }
      }
    }
  });
});
