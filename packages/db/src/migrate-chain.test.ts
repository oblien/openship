import { describe, expect, test } from "vitest";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";

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
