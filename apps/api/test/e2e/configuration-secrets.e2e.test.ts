/** Real PostgreSQL lock races: startup conversion must not replace a newer edit. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  createDatabase,
  createRepositories,
  schema,
  type DatabaseConnection,
} from "@repo/db/factory";
import { createEncryption } from "@repo/db/encryption";
import { createConfigurationSecrets } from "@repo/db/configuration-secrets";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const container = `openship-e2e-config-secrets-${process.pid}`;
const encryption = createEncryption("configuration-e2e-key-844");
const codec = createConfigurationSecrets(encryption);
let connection: DatabaseConnection;
let repos: ReturnType<typeof createRepositories>;

describeDockerE2E("encrypted configuration conversion (GH-844, real PostgreSQL)", () => {
  beforeAll(async () => {
    await requireDocker();
    await exec(
      "docker",
      [
        "run",
        "-d",
        "--name",
        container,
        "-e",
        "POSTGRES_PASSWORD=config-test-password",
        "-p",
        "127.0.0.1::5432",
        "postgres:16-alpine",
      ],
      { timeout: 120_000 },
    );
    const port = (await exec("docker", ["port", container, "5432/tcp"])).stdout
      .trim()
      .split(":")
      .at(-1);
    connection = await createDatabase({
      driver: "pg",
      url: `postgresql://postgres:config-test-password@127.0.0.1:${port}/postgres`,
      migrationsDir: resolve(import.meta.dirname, "../../../../packages/db/drizzle"),
      poolMax: 4,
      registerExitHook: false,
    });
    repos = createRepositories(connection.db, encryption);
    await connection.db.insert(schema.organization).values({ id: "org", name: "Config test" });
    await connection.db
      .insert(schema.projectGroup)
      .values({ id: "group", organizationId: "org", name: "Test", slug: "test" });
    await connection.db
      .insert(schema.project)
      .values({
        id: "project",
        groupId: "group",
        organizationId: "org",
        name: "Test",
        slug: "test",
      });
  });
  afterAll(async () => {
    try {
      await connection?.close();
    } finally {
      encryption.close();
      await exec("docker", ["rm", "-fv", container]).catch(() => {});
    }
  });

  it.each(["service", "deployment"] as const)(
    "does not overwrite a concurrent %s edit",
    async (table) => {
      const id = `legacy-${table}`;
      if (table === "service") {
        await connection.db
          .insert(schema.service)
          .values({
            id,
            projectId: "project",
            name: "web",
            environment: { PASSWORD: "legacy-844" },
          });
      } else {
        await connection.db
          .insert(schema.deployment)
          .values({
            id,
            projectId: "project",
            organizationId: "org",
            branch: "main",
            status: "ready",
            meta: {
              serverId: "before",
              composeServices: [{ name: "web", environment: { PASSWORD: "legacy-844" } }],
            },
          });
      }
      const locker = await connection.pool!.connect();
      let pending: ReturnType<typeof repos.configurationSecrets.backfillLegacy> | undefined;
      try {
        await locker.query("BEGIN");
        // Identifiers are a fixed test union; only the id/value is user-shaped.
        await locker.query(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, [id]);
        pending = repos.configurationSecrets.backfillLegacy();
        await vi.waitFor(
          async () => {
            const blocked = await connection.pool!.query(
              "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1",
              [`update "${table}"%`],
            );
            expect(blocked.rowCount).toBeGreaterThan(0);
          },
          { timeout: 15_000, interval: 50 },
        );
        if (table === "service") {
          await locker.query('UPDATE "service" SET environment = $1::jsonb WHERE id = $2', [
            JSON.stringify(codec.sealJson({ PASSWORD: "rotated-844" })),
            id,
          ]);
        } else {
          const updated = codec.sealDeploymentMeta({
            serverId: "after",
            composeServices: [{ name: "web", environment: { PASSWORD: "rotated-844" } }],
          });
          await locker.query('UPDATE "deployment" SET meta = $1::jsonb WHERE id = $2', [
            JSON.stringify(updated),
            id,
          ]);
        }
        await locker.query("COMMIT");
        expect(await pending).toEqual({ services: 0, deployments: 0 });
        const raw = (await connection.pool!.query(`SELECT * FROM "${table}" WHERE id = $1`, [id]))
          .rows[0];
        expect(JSON.stringify(raw)).not.toContain("rotated-844");
        if (table === "service") {
          expect((await repos.service.findById(id))?.environment).toEqual({
            PASSWORD: "rotated-844",
          });
        } else {
          expect((await repos.deployment.findById(id))?.meta).toEqual({
            serverId: "after",
            composeServices: [{ name: "web", environment: { PASSWORD: "rotated-844" } }],
          });
        }
        expect(await repos.configurationSecrets.backfillLegacy()).toEqual({
          services: 0,
          deployments: 0,
        });
      } finally {
        await locker.query("ROLLBACK").catch(() => {});
        locker.release();
        await pending?.catch(() => {});
      }
    },
  );
});
