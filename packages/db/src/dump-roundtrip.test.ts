import { beforeAll, describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import { db, type DatabaseTransaction } from "./client";
import {
  countInstanceSubgraphTables,
  dumpSubgraph,
  restoreSubgraph,
  restoreSubgraphInTransaction,
  topoOrderedTables,
  type TableSpec,
} from "./dump";

// The test the data-transfer feature never had: does a whole-instance dump actually
// RESTORE?
//
// Everything that existed before this file tested the crypto (passphrase seal,
// per-column codecs) and the pure helpers. Nothing put a dump through a real
// database, so four foreign-key ordering violations and a missing parent table
// shipped, and `POST /api/system/data-transfer/import` 500'd on any instance whose
// domains were bound to services — which is every project with more than one
// service.
//
// The fixture is GENERATED from the catalogue rather than hand-written, for two
// reasons. A hand-written one covers the FKs whoever wrote it thought of (the
// original hole was a NULLABLE fk, `domain.serviceId`, exactly the kind a fixture
// leaves null). And a generated one automatically covers a table added next month,
// which is the same drift EXCLUDED_TABLES exists to catch.
//
// Under VITEST, `db` is a fresh in-memory PGlite with every migration applied
// (see createPgliteClient), so this is real Postgres DDL and real FK enforcement.

/** Every FK on `table`, as local field name -> {parent sql name, parent field}. */
function foreignKeyFields(
  table: PgTable,
): Array<{ field: string; parentTable: string; parentColumn: string }> {
  const fieldByColumnName = new Map(
    Object.entries(getTableColumns(table)).map(([field, col]) => [(col as { name: string }).name, field]),
  );
  const out: Array<{ field: string; parentTable: string; parentColumn: string }> = [];
  for (const fk of getTableConfig(table).foreignKeys) {
    const ref = fk.reference();
    const parentTable = getTableConfig(ref.foreignTable).name;
    ref.columns.forEach((col, i) => {
      const field = fieldByColumnName.get((col as { name: string }).name);
      const parentColumn = (ref.foreignColumns[i] as { name: string } | undefined)?.name;
      if (field && parentColumn) out.push({ field, parentTable, parentColumn });
    });
  }
  return out;
}

/** A value the column will accept. The schema has no CHECK constraints and no
 *  enums, so type-correct is sufficient — this fixture proves referential
 *  integrity, not domain semantics. */
function sampleValue(column: { dataType: string; name: string }, tableName: string): unknown {
  switch (column.dataType) {
    case "string":
      return `${tableName}.${column.name}`;
    case "number":
      return 1;
    case "bigint":
      return 1;
    case "boolean":
      return false;
    case "date":
      return new Date("2026-01-02T03:04:05.000Z");
    case "json":
      return {};
    case "array":
      return [];
    default:
      return `${tableName}.${column.name}`;
  }
}

/**
 * A parent-before-child order computed HERE, independently of `topoOrderedTables()`.
 *
 * The fixture must not seed in the order it is testing. When it did, a wrong
 * production order also made the seeder skip the nullable FKs it could not resolve
 * yet — so `domain.serviceId` was seeded null, the restore had nothing to violate,
 * and the test failed on a weak assertion instead of the FK error it exists to catch.
 * Deriving the seed order separately keeps the fixture fully populated no matter what
 * the code under test claims the order is.
 */
function independentTopoOrder(): TableSpec[] {
  const specs = topoOrderedTables();
  const names = new Set(specs.map((s) => s.sqlName));
  const parents = new Map(
    specs.map((s) => [s.sqlName, new Set(fkParentNames(s.table, s.sqlName).filter((p) => names.has(p)))]),
  );

  const ordered: TableSpec[] = [];
  const placed = new Set<string>();
  while (placed.size < specs.length) {
    const next = specs.find(
      (s) => !placed.has(s.sqlName) && [...parents.get(s.sqlName)!].every((p) => placed.has(p)),
    );
    if (!next) throw new Error("fixture: FK cycle, cannot seed");
    ordered.push(next);
    placed.add(next.sqlName);
  }
  return ordered;
}

function fkParentNames(table: PgTable, self: string): string[] {
  return getTableConfig(table)
    .foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name)
    .filter((parent) => parent !== self);
}

/**
 * Insert exactly one row into every catalogued table, with EVERY foreign key
 * populated — nullable ones included, since that is where the ordering bug lived.
 * Returns the values assigned per table so assertions can check specific edges
 * survived.
 */
async function seedOneRowPerTable(): Promise<Map<string, Record<string, unknown>>> {
  // sql table name -> { sql column name: value }, so a child can resolve an FK that
  // targets a non-`id` column (oauth_consent.clientId -> oauth_application.clientId).
  const assignedBySqlColumn = new Map<string, Record<string, unknown>>();
  const assignedByField = new Map<string, Record<string, unknown>>();

  for (const spec of independentTopoOrder()) {
    const columns = getTableColumns(spec.table);
    const fks = foreignKeyFields(spec.table);
    const fkByField = new Map(fks.map((f) => [f.field, f]));

    const row: Record<string, unknown> = {};
    for (const [field, rawCol] of Object.entries(columns)) {
      const col = rawCol as { name: string; notNull: boolean; hasDefault: boolean; dataType: string };

      const fk = fkByField.get(field);
      if (fk) {
        // Populate every FK, nullable included — an unpopulated nullable FK is
        // precisely what let `domain.serviceId` stay broken.
        const parent = assignedBySqlColumn.get(fk.parentTable);
        const value = parent?.[fk.parentColumn];
        if (value !== undefined) {
          row[field] = value;
          continue;
        }
        if (!col.notNull) continue; // parent not catalogued and column is optional
      }

      if (col.notNull && !col.hasDefault) row[field] = sampleValue(col, spec.sqlName);
      else if (field === "id") row[field] = `${spec.sqlName}_1`;
    }

    await db.insert(spec.table).values(row as never);

    const bySqlColumn: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(row)) {
      bySqlColumn[(columns[field] as unknown as { name: string }).name] = value;
    }
    assignedBySqlColumn.set(spec.sqlName, bySqlColumn);
    assignedByField.set(spec.sqlName, row);
  }

  return assignedByField;
}

async function rowCount(spec: TableSpec): Promise<number> {
  return (await db.select().from(spec.table)).length;
}

describe("whole-instance dump → restore round trip", () => {
  let seeded: Map<string, Record<string, unknown>>;

  beforeAll(async () => {
    seeded = await seedOneRowPerTable();
  });

  it("previews per-table counts without materializing a dump", async () => {
    const counts = await countInstanceSubgraphTables();
    expect(counts.project).toBe(1);
    expect(counts.servers).toBe(1);
    expect(counts.resource_usage).toBe(1);
  });

  it("restores a fully FK-populated instance through the JSON envelope", async () => {
    // Guard the FIXTURE first. If the seeder failed to populate the FK that broke in
    // production, everything below would pass on a dump that never exercised it.
    expect(seeded.get("domain")?.serviceId, "fixture did not bind a domain to a service").toBeTruthy();

    // Every catalogued table must have produced a row, or the assertions below
    // would pass on an empty database.
    for (const spec of topoOrderedTables()) {
      expect(await rowCount(spec), `${spec.sqlName} was not seeded`).toBe(1);
    }

    const dump = await dumpSubgraph({ kind: "instance" });

    // Exactly what importInstance receives: the dump after a trip through a JSON
    // file. This also exercises the ISO-string → Date revival, which an in-process
    // restore skips entirely.
    const overTheWire = JSON.parse(JSON.stringify(dump)) as typeof dump;

    // The failure this whole suite exists for: a raw
    // "violates foreign key constraint" out of the insert loop.
    await restoreSubgraph(overTheWire, { mode: "wipe" });

    for (const spec of topoOrderedTables()) {
      expect(await rowCount(spec), `${spec.sqlName} did not survive the restore`).toBe(1);
    }

    // Spot-check the exact edge that broke in production: a domain bound to a
    // service, restored with its binding intact rather than nulled or dropped.
    const [domain] = (await db.select().from(
      topoOrderedTables().find((s) => s.sqlName === "domain")!.table,
    )) as Array<Record<string, unknown>>;
    expect(domain?.serviceId).toBe(seeded.get("domain")?.serviceId);
    expect(domain?.serviceId).toBeTruthy();
  });

  it("lets callers include follow-up work in the same atomic restore transaction", async () => {
    const projectSpec = topoOrderedTables().find((s) => s.sqlName === "project")!;
    const [before] = (await db.select().from(projectSpec.table)) as Array<Record<string, unknown>>;
    const dump = JSON.parse(JSON.stringify(await dumpSubgraph({ kind: "instance" }))) as Awaited<
      ReturnType<typeof dumpSubgraph>
    >;
    dump.tables.project![0]!.name = "must-roll-back";

    await expect(
      db.transaction(async (rawTx) => {
        await restoreSubgraphInTransaction(rawTx as DatabaseTransaction, dump, { mode: "wipe" });
        throw new Error("follow-up write failed");
      }),
    ).rejects.toThrow("follow-up write failed");

    const [after] = (await db.select().from(projectSpec.table)) as Array<Record<string, unknown>>;
    expect(after?.name).toBe(before?.name);
    expect(after?.name).not.toBe("must-roll-back");
  });

  it("skips explicitly excluded history tables at query time", async () => {
    const excluded = [
      "server_analytics",
      "server_analytics_geo",
      "resource_usage",
      "audit_event",
      "notification_delivery",
      "backup_run",
      "backup_restore",
      "service_incident",
      "docker_migration_run",
    ];
    const dump = await dumpSubgraph(
      { kind: "instance" },
      { excludeTables: excluded },
    );

    for (const table of excluded) expect(dump.tables).not.toHaveProperty(table);
    expect(dump.tables["project"]).toHaveLength(1);
    expect(dump.tables["servers"]).toHaveLength(1);

    // A core-only filtered file remains a valid wipe import: omitted history is
    // cleared, while the durable graph restores without dangling FKs.
    await restoreSubgraph(JSON.parse(JSON.stringify(dump)) as typeof dump, { mode: "wipe" });
    for (const table of excluded) {
      const spec = topoOrderedTables().find((entry) => entry.sqlName === table)!;
      expect(await rowCount(spec), `${table} should stay omitted`).toBe(0);
    }
    expect(await rowCount(topoOrderedTables().find((entry) => entry.sqlName === "project")!)).toBe(1);
  });

  it("chunks inserts past the bind-parameter cap", async () => {
    // `audit_event` is 13 columns, so ONE insert statement tops out at 5041 rows
    // (65535 / 13) and the unchunked restore died there with "bind message has N
    // parameter formats but 0 parameters" — an error that names neither the table
    // nor the row count. Any instance with a few thousand audit rows hit it, i.e.
    // any instance that had been running for a while.
    //
    // Clone the seeded row so the org/actor FKs stay valid, and insert in batches
    // because the SEEDING side has the same 65535 ceiling this test is about.
    const auditSpec = topoOrderedTables().find((s) => s.sqlName === "audit_event")!;
    const template = { ...seeded.get("audit_event")! };
    const rows = Array.from({ length: 6000 }, (_, i) => ({ ...template, id: `ae_${i}` }));
    for (let i = 0; i < rows.length; i += 2000) {
      await db.insert(auditSpec.table).values(rows.slice(i, i + 2000) as never);
    }

    const dump = await dumpSubgraph({ kind: "instance" });
    expect(dump.tables["audit_event"]!.length).toBeGreaterThan(5041);

    await restoreSubgraph(JSON.parse(JSON.stringify(dump)) as typeof dump, { mode: "wipe" });
    expect(await rowCount(auditSpec)).toBeGreaterThan(5041);
  });
});
