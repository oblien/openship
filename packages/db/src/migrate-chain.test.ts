import { describe, expect, test } from "vitest";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";
import { createProjectConnectionRepo } from "./repos/project-connection.repo";

// Does the migration chain actually APPLY to a database that already exists and
// already holds rows?
//
// Everything else in the repo answers a weaker question. Every other suite calls
// migrate() against an empty PGlite, which proves the chain applies to NOTHING —
// and `migrations-additive.test.ts` reads the SQL as text, so it can only catch the
// one pattern it greps for. Neither sees an ALTER that fails on a populated table, a
// unique index an existing row violates, or a backfill whose assumption doesn't hold.
// That is the entire class of "the update crash-looped on migrations", and until this
// file it had no coverage anywhere, in CI or out.
//
// Cheap enough to run on every PR because PGlite is in-process: no daemon, no
// container, no ports (the same reason the repo's other real-SQL tests use it).

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as Journal;
}

/**
 * A migrations folder holding only the first `count` entries — i.e. the database as
 * an older release left it.
 *
 * This is a real upgrade and not an approximation of one: drizzle records each applied
 * migration's `when` in `drizzle.__drizzle_migrations` and on the next run applies
 * exactly those the journal lists after it. Pointing it at a truncated journal, then at
 * the real one, is the same two-step an operator's box performs across an update.
 */
function migrationsPrefix(count: number): string {
  const journal = readJournal();
  const entries = journal.entries.slice(0, count);
  const dir = mkdtempSync(join(tmpdir(), "osh-migrate-chain-"));
  mkdirSync(join(dir, "meta"), { recursive: true });
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return dir;
}

/**
 * The full chain plus one migration that is only unsafe on a populated table — the
 * defect class this file exists to catch, so the suite can prove it is able to fail.
 */
function mutatedChain(): string {
  const dir = mkdtempSync(join(tmpdir(), "osh-migrate-chain-bad-"));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  const last = journal.entries[journal.entries.length - 1]!;
  writeFileSync(
    join(dir, "9999_populated_only_failure.sql"),
    `ALTER TABLE "project" ADD COLUMN "chain_probe" text NOT NULL;`,
  );
  journal.entries.push({
    idx: last.idx + 1,
    version: last.version,
    when: last.when + 1_000,
    tag: "9999_populated_only_failure",
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return dir;
}

async function freshDb() {
  const client = new PGlite("memory://");
  return { client, db: drizzle(client, { schema }) };
}

async function appliedMigrations(client: PGlite): Promise<number> {
  const res = await client.query<{ n: number }>(
    `select count(*)::int as n from drizzle."__drizzle_migrations"`,
  );
  return res.rows[0]?.n ?? 0;
}

async function tableExists(client: PGlite, table: string): Promise<boolean> {
  const res = await client.query<{ n: number }>(
    `select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return (res.rows[0]?.n ?? 0) > 0;
}

/** A literal that satisfies a column of this type — enough to make a row exist. */
function fillerFor(table: string, column: string, dataType: string): string {
  switch (dataType) {
    case "text":
    case "character varying":
    case "character":
      return `'seed'`;
    case "uuid":
      return `'00000000-0000-0000-0000-000000000001'`;
    case "timestamp with time zone":
    case "timestamp without time zone":
    case "date":
      return "now()";
    case "boolean":
      return "false";
    case "integer":
    case "bigint":
    case "smallint":
    case "numeric":
    case "real":
    case "double precision":
      return "0";
    case "json":
    case "jsonb":
      return `'{}'`;
    case "ARRAY":
      return `'{}'`;
    default:
      // Loud rather than skipped: a type we can't fill means this table silently
      // stopped being seeded, and an unseeded table proves nothing.
      throw new Error(
        `migrate-chain: no filler for ${table}.${column} (${dataType}) — add one above`,
      );
  }
}

/**
 * Insert exactly one row into `table`, by introspecting what the schema requires AT
 * THIS POINT IN THE CHAIN rather than from the current TypeScript schema (which
 * describes columns the older database doesn't have yet).
 *
 * Introspection is what keeps this test from rotting: the cutoffs below are relative to
 * HEAD, so they move every release, and a hardcoded column list would break on the
 * first migration that touched any of these tables.
 */
async function seedRow(client: PGlite, table: string, id: string): Promise<void> {
  const cols = await client.query<{
    column_name: string;
    data_type: string;
  }>(
    `select column_name, data_type
       from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
        and is_nullable = 'NO'
        and column_default is null
        and is_generated = 'NEVER'
        and identity_generation is null`,
    [table],
  );

  const names: string[] = [];
  const values: string[] = [];
  for (const col of cols.rows) {
    names.push(`"${col.column_name}"`);
    values.push(
      col.column_name === "id" ? `'${id}'` : fillerFor(table, col.column_name, col.data_type),
    );
  }
  // `id` may carry a default (so it's excluded above) — force ours in anyway, because
  // the assertions find the row by it.
  if (!names.includes(`"id"`)) {
    names.push(`"id"`);
    values.push(`'${id}'`);
  }
  // Managed servers made ssh_host nullable, but a non-local server still needs
  // an SSH address or a workspace binding. Keep the seed valid when the moving
  // upgrade window starts after that constraint was introduced.
  if (table === "servers" && !names.includes(`"ssh_host"`)) {
    names.push(`"ssh_host"`);
    values.push(`'192.0.2.1'`);
  }

  await client.exec(
    `insert into "${table}" (${names.join(", ")}) values (${values.join(", ")});`,
  );
}

async function rowExists(client: PGlite, table: string, id: string): Promise<boolean> {
  const res = await client.query<{ n: number }>(
    `select count(*)::int as n from "${table}" where id = $1`,
    [id],
  );
  return (res.rows[0]?.n ?? 0) > 0;
}

// Long-lived core tables (all present since 0000_init) that later migrations keep
// touching. Rows here are what turn "the SQL parses" into "the SQL applies".
const SEEDED_TABLES = [
  "organization",
  "project",
  "deployment",
  "servers",
  "user",
  "domain",
  "env_var",
  "service",
];

const SEED_ID = "migrate-chain-seed";

/**
 * How many migrations back the "recent upgrade" case starts — roughly a release's
 * worth, so it covers the hop an operator actually takes (e.g. 0.6.1 → 0.6.5).
 */
const RECENT_WINDOW = 12;

describe("migration chain applies to an existing, populated database", () => {
  const journal = readJournal();
  const total = journal.entries.length;

  // Guards the two cases below against passing vacuously — a journal that stopped
  // resolving would make every "upgrade" a no-op on an empty chain.
  test("journal resolves and every entry has its .sql file", () => {
    expect(total).toBeGreaterThan(10);
    for (const entry of journal.entries) {
      expect(
        readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8").length,
        `${entry.tag}.sql is empty or missing`,
      ).toBeGreaterThan(0);
    }
  });

  test("a fresh apply converges and is idempotent", async () => {
    const { client, db } = await freshDb();
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    expect(await appliedMigrations(client)).toBe(total);

    // Second run must be a no-op. A migration that re-applies is how an update that
    // "already worked" fails the next time the api restarts.
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    expect(await appliedMigrations(client)).toBe(total);
  });

  test("upgrades the published Cloud Pages schema without losing project state", async () => {
    const cutoff =
      journal.entries.findIndex((entry) => entry.tag === "0168_cloud_static_hosting") + 1;
    expect(cutoff).toBeGreaterThan(0);
    const legacy = migrationsPrefix(cutoff);
    const { client, db } = await freshDb();
    try {
      await migrate(db, { migrationsFolder: legacy });
      await client.exec("SET session_replication_role = replica;");
      await seedRow(client, "project", SEED_ID);
      await client.exec(
        "UPDATE project SET cloud_static_hosting = 'server', active_deployment_id = 'retained-release'",
      );
      const projects = (await client.query("SELECT * FROM project")).rows;
      const applied = (
        await client.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")
      ).rows;
      expect(await tableExists(client, "instance_controller")).toBe(false);
      expect(await tableExists(client, "instance_handoff")).toBe(false);

      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      expect(await appliedMigrations(client)).toBe(total);
      // Schema-backed reads must include the fields startup and recovery require.
      expect(await db.select().from(schema.instanceController)).toEqual([]);
      expect(await db.select().from(schema.instanceHandoff)).toEqual([]);
      expect((await client.query("SELECT * FROM project")).rows).toEqual(
        projects.map((project) => ({ ...project, external_config: null })),
      );
      expect(
        (await client.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows.slice(
          0,
          applied.length,
        ),
      ).toEqual(applied);
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      expect(await appliedMigrations(client)).toBe(total);
    } finally {
      await client.close();
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  for (const missingFields of [true, false]) {
    test(`upgrades an applied instance controller migration with portable fields ${missingFields ? "missing" : "already present"}`, async () => {
      const controllerMigration = "0169_instance_controller";
      const cutoff = journal.entries.findIndex((entry) => entry.tag === "0168_cloud_static_hosting");
      expect(cutoff).toBeGreaterThan(0);
      const legacy = migrationsPrefix(cutoff);
      const { client, db } = await freshDb();
      try {
        // Reproduce the PR's original journal, before main occupied 0168. Its
        // timestamps and recorded rows must survive the reordered migrations.
        const earlierEntries: JournalEntry[] = [{
          idx: cutoff,
          version: "7",
          when: 1791331200000,
          tag: "0168_instance_controller",
          breakpoints: true,
        }];
        const path = join(legacy, "0168_instance_controller.sql");
        writeFileSync(
          path,
          readFileSync(join(MIGRATIONS_DIR, controllerMigration + ".sql"), "utf8")
            .replaceAll("CREATE TABLE IF NOT EXISTS", "CREATE TABLE"),
        );
        if (missingFields) {
          // A dev instance can have applied 0168 before these fields were added.
          // Its recorded migration must stay intact; only a new migration runs.
          writeFileSync(
            path,
            readFileSync(path, "utf8")
              .split("\n")
              .filter(
                (line) =>
                  !/^\s*"(?:environment|desktop_user_id|project_id|recovery|provisioning)" /.test(
                    line,
                  ),
              )
              .join("\n"),
          );
        } else {
          earlierEntries.push({
            idx: cutoff + 1,
            version: "7",
            when: 1791379680000,
            tag: "0169_instance_controller_fields",
            breakpoints: true,
          });
          copyFileSync(
            join(MIGRATIONS_DIR, "0170_instance_controller_fields.sql"),
            join(legacy, "0169_instance_controller_fields.sql"),
          );
        }
        writeFileSync(
          join(legacy, "meta", "_journal.json"),
          JSON.stringify({
            ...journal,
            entries: [...journal.entries.slice(0, cutoff), ...earlierEntries],
          }, null, 2),
        );
        const expectedMigrations = total + earlierEntries.length;
        await migrate(db, { migrationsFolder: legacy });
        await client.exec(`
          INSERT INTO instance_controller (installation_id, role, handoff_id, revision, connection)
            VALUES ('existing-installation', 'retired', 'existing-handoff', 7, 'sealed-device-connection');
          INSERT INTO instance_handoff (id, direction, owner_user_id, token_hash, secrets, status, expires_at)
            VALUES ('existing-handoff', 'source', 'existing-owner', 'existing-token-hash', 'sealed-transfer-key', 'prepared', '2026-10-08');
        `);
        if (missingFields) {
          await expect(
            db
              .select({ environment: schema.instanceController.environment })
              .from(schema.instanceController)
              .limit(1),
          ).rejects.toThrow(/environment/);
        } else {
          await client.exec(`
            UPDATE instance_controller SET environment = 'sealed-environment', desktop_user_id = 'existing-owner', project_id = 'hosted-api';
            UPDATE instance_handoff SET recovery = '{"sha256":"saved-checksum"}', provisioning = '{"serverId":"existing-server"}';
          `);
        }
        const controllers = (
          await client.query<Record<string, unknown>>("SELECT * FROM instance_controller")
        ).rows;
        const handoffs = (
          await client.query<Record<string, unknown>>("SELECT * FROM instance_handoff")
        ).rows;
        const applied = (
          await client.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")
        ).rows;

        await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
        expect(await appliedMigrations(client)).toBe(expectedMigrations);
        // These are the same schema-backed reads used during startup and recovery.
        expect(await db.select().from(schema.instanceController)).toMatchObject([
          {
            installationId: "existing-installation",
            role: "retired",
            revision: 7,
            environment: missingFields ? null : "sealed-environment",
            desktopUserId: missingFields ? null : "existing-owner",
            projectId: missingFields ? null : "hosted-api",
          },
        ]);
        expect(await db.select().from(schema.instanceHandoff)).toMatchObject([
          {
            id: "existing-handoff",
            status: "prepared",
            recovery: missingFields ? null : { sha256: "saved-checksum" },
            provisioning: missingFields ? null : { serverId: "existing-server" },
          },
        ]);
        await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
        expect(await appliedMigrations(client)).toBe(expectedMigrations);
        expect((await client.query("SELECT * FROM instance_controller")).rows).toEqual(
          controllers.map((row) => ({
            environment: null,
            desktop_user_id: null,
            project_id: null,
            ...row,
          })),
        );
        expect((await client.query("SELECT * FROM instance_handoff")).rows).toEqual(
          handoffs.map((row) => ({ recovery: null, provisioning: null, ...row })),
        );
        expect(
          (await client.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows.slice(
            0,
            applied.length,
          ),
        ).toEqual(applied);
      } finally {
        await client.close();
        rmSync(legacy, { recursive: true, force: true });
      }
    });
  }

  test("upgrades managed server identities and drops retired native placement fields", async () => {
    const cutoff = journal.entries.findIndex((entry) => entry.tag === "0156_managed_servers");
    expect(cutoff).toBeGreaterThan(0);
    const legacy = migrationsPrefix(cutoff);
    const { client, db } = await freshDb();
    try {
      await migrate(db, { migrationsFolder: legacy });
      await client.exec(`
        INSERT INTO organization (id, name) VALUES ('org', 'Existing organization');
        INSERT INTO project_app (id, organization_id, name, slug) VALUES ('group', 'org', 'Apps', 'apps');
        INSERT INTO servers (id, organization_id, name, ssh_host, is_local) VALUES
          ('ssh-host', 'org', 'SSH host', '192.0.2.1', false),
          ('local-host', 'org', 'Local host', '127.0.0.1', true);
        INSERT INTO cloud_workspace (id, organization_id, name, namespace, mode, runtime, plan_tier_id) VALUES
          ('shared', 'org', 'Shared', 'shared-namespace', 'shared', 'docker', 'hobby'),
          ('dedicated', 'org', 'Native', 'native-namespace', 'dedicated', 'native', 'starter');
        INSERT INTO project (id, organization_id, app_id, environment_slug, name, slug, server_id, workspace_id, cloud_workspace_id) VALUES
          ('ssh-app', 'org', 'group', 'ssh', 'SSH app', 'ssh-app', 'ssh-host', NULL, NULL),
          ('local-app', 'org', 'group', 'local', 'Local app', 'local-app', 'local-host', NULL, NULL),
          ('direct-app', 'org', 'group', 'direct', 'Direct app', 'direct-app', NULL, NULL, 'direct-provider-vm'),
          ('shared-a', 'org', 'group', 'a', 'Shared A', 'shared-a', NULL, 'shared', NULL),
          ('shared-b', 'org', 'group', 'b', 'Shared B', 'shared-b', NULL, 'shared', NULL),
          ('native-app', 'org', 'group', 'native', 'Native app', 'native-app', NULL, 'dedicated', 'native-provider-vm');
        INSERT INTO cloud_docker_workspace (owner_workspace_id, namespace, provision_key, workspace_id, image, resources, state)
          VALUES ('shared', 'shared-namespace', 'existing-provision-key', 'shared-provider-vm', 'docker', '{"cpuCores":1,"memoryMb":4096,"diskMb":25600}', 'ready');
      `);
      const selectProjects = () =>
        client.query<{ id: string; server_id: string | null; workspace_id: string | null }>(
          "SELECT * FROM project ORDER BY id",
        );
      const original = (await selectProjects()).rows;
      const bindings = (await client.query<Record<string, unknown>>("SELECT * FROM cloud_docker_workspace")).rows;
      const workspaces = (await client.query<Record<string, unknown>>("SELECT * FROM cloud_workspace ORDER BY id")).rows;
      const connected = (
        await client.query<Record<string, unknown>>("SELECT * FROM servers ORDER BY id")
      ).rows;

      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      const managed = (
        await client.query<{ id: string; workspace_id: string }>(
          "SELECT id, workspace_id FROM servers WHERE workspace_id IS NOT NULL ORDER BY id",
        )
      ).rows;
      expect(managed).toHaveLength(2);
      for (const row of (await selectProjects()).rows) {
        const old = original.find((project) => project.id === row.id)!;
        const { cloud_workspace_id: _native, cloud_archive_strategy: _archive, ...previous } = old as typeof old & Record<string, unknown>;
        expect(row).toEqual({
          ...previous,
          cloud_promotion: null,
          cloud_static_hosting: "pages",
          external_config: null,
          server_id: previous.workspace_id
            ? managed.find((server) => server.workspace_id === previous.workspace_id)!.id
            : previous.server_id,
        });
      }
      expect((await client.query("SELECT * FROM cloud_docker_workspace")).rows).toEqual(bindings.map(({ project_id: _, ...host }) => host));
      expect((await client.query("SELECT * FROM cloud_workspace ORDER BY id")).rows).toEqual(
        workspaces.map(({ mode: _mode, runtime: _runtime, ...owner }) => ({ ...owner, remote: null, activity: null, linked_projects: [], subscription_change: null })),
      );
      expect(
        (await client.query("SELECT * FROM servers WHERE workspace_id IS NULL ORDER BY id")).rows,
      ).toEqual(connected.map((server) => ({
        ...server,
        workspace_id: null,
        purpose: "deployment",
        ssh_host_key: null,
      })));
      // Repeated startup retains execution IDs and cannot detach a managed project.
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      expect(
        (
          await client.query(
            "SELECT id, workspace_id FROM servers WHERE workspace_id IS NOT NULL ORDER BY id",
          )
        ).rows,
      ).toEqual(managed);
      await client.exec("UPDATE project SET workspace_id = NULL WHERE id = 'shared-a'");
      expect(
        (await selectProjects()).rows.find((project) => project.id === "shared-a")?.workspace_id,
      ).toBe("shared");
      await expect(
        client.exec("UPDATE project SET server_id = 'ssh-host' WHERE id = 'shared-a'"),
      ).rejects.toThrow(/explicit migration/);
    } finally {
      await client.close();
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  for (const missingNetworkFlag of [true, false]) {
    test(`upgrades shared connections with the network flag ${missingNetworkFlag ? "missing" : "already present"}`, async () => {
      const sharedMigration = "0128_shared_service_connections";
      const cutoff = journal.entries.findIndex((entry) => entry.tag === sharedMigration) + 1;
      expect(cutoff).toBeGreaterThan(0);
      const legacy = migrationsPrefix(cutoff);
      const { client, db } = await freshDb();
      try {
        if (missingNetworkFlag) {
          // Early installs recorded 0128 before this column was added to its SQL.
          // Editing that applied migration cannot repair those databases.
          const path = join(legacy, `${sharedMigration}.sql`);
          const statements = readFileSync(path, "utf8").split("--> statement-breakpoint");
          writeFileSync(path, statements
            .filter((statement) => !statement.includes("uses_private_network"))
            .join("--> statement-breakpoint"));
        }
        await migrate(db, { migrationsFolder: legacy });
        await client.exec("SET session_replication_role = replica;");
        await seedRow(client, "project_connection", "existing-connection");
        await client.exec(`UPDATE project_connection SET source_service_id = 'existing-service', mode = 'internal'`);
        const repo = createProjectConnectionRepo(db);
        if (missingNetworkFlag) {
          await expect(repo.listByTarget("seed")).rejects.toThrow(/uses_private_network/);
        } else {
          await client.exec("UPDATE project_connection SET uses_private_network = false");
        }

        await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
        expect(await appliedMigrations(client)).toBe(total);
        expect(await repo.listByTarget("seed")).toMatchObject([{
          id: "existing-connection",
          sourceServiceId: "existing-service",
          envKey: "seed",
          mode: "internal",
          usesPrivateNetwork: missingNetworkFlag,
        }]);
        const links = await repo.listByTarget("seed");
        await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
        expect(await repo.listByTarget("seed")).toEqual(links);
      } finally {
        await client.close();
        rmSync(legacy, { recursive: true, force: true });
      }
    });
  }

  // Without this, the two cases below are unfalsifiable: they'd pass just as happily if
  // the seeding silently stopped working or drizzle swallowed migration errors.
  test("catches a migration that is only unsafe once rows exist", async () => {
    const bad = mutatedChain();

    // Against an empty database it applies without complaint — which is precisely what
    // every other migration test in this repo, and a text scan of the SQL, would report.
    const empty = await freshDb();
    await migrate(empty.db, { migrationsFolder: bad });

    // Against the same schema holding one row, it must fail.
    const { client, db } = await freshDb();
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    await client.exec("SET session_replication_role = replica;");
    await seedRow(client, "project", SEED_ID);
    expect(await rowExists(client, "project", SEED_ID), "probe row must exist").toBe(true);

    // Matched on the injected column, not just "it threw": proves the failure came from
    // the migration under test rather than incidentally from the seeding.
    await expect(migrate(db, { migrationsFolder: bad })).rejects.toThrow(/chain_probe/);
  });

  // The cases that matter: stop partway, put rows in, then finish the chain.
  for (const [label, cutoff] of [
    [`the last ${RECENT_WINDOW} migrations`, total - RECENT_WINDOW],
    ["half the chain", Math.floor(total / 2)],
  ] as const) {
    test(`upgrades a populated database across ${label}`, async () => {
      expect(cutoff, "cutoff must leave migrations on both sides").toBeGreaterThan(0);
      expect(cutoff).toBeLessThan(total);

      const { client, db } = await freshDb();
      await migrate(db, { migrationsFolder: migrationsPrefix(cutoff) });
      expect(await appliedMigrations(client)).toBe(cutoff);

      // FKs off so one row per table needs no parent graph — same approach as the
      // repo's other real-SQL repo tests.
      await client.exec("SET session_replication_role = replica;");
      for (const table of SEEDED_TABLES) {
        expect(await tableExists(client, table), `${table} missing at migration ${cutoff}`).toBe(
          true,
        );
        await seedRow(client, table, SEED_ID);
        expect(await rowExists(client, table, SEED_ID), `seed into ${table} did not land`).toBe(
          true,
        );
      }

      // The upgrade itself. Runs with rows present, which is the whole point.
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      expect(await appliedMigrations(client)).toBe(total);
      for (const table of SEEDED_TABLES) {
        expect(await rowExists(client, table, SEED_ID), `${table} lost its row`).toBe(true);
      }
    });
  }
});
