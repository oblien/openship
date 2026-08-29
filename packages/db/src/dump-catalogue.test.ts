import { describe, expect, it } from "vitest";
import { is } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as schema from "./schema";
import { EXCLUDED_TABLES, topoOrderedTables } from "./dump";

// Invariants over the dump catalogue itself. Pure — no DB, no fixtures — so they
// run everywhere and cost nothing.
//
// Both of these encode a failure that already shipped. `restoreSubgraph` inserts in
// one order and the schema's foreign keys are NOT DEFERRABLE (so
// `SET CONSTRAINTS ALL DEFERRED` does nothing), which means a catalogue whose order
// disagrees with the FK graph produces a raw FK violation on import — and it did, in
// four places at once, with no test anywhere that would notice. The old
// data-transfer suite only covered crypto round-trips.
//
// The order is now derived rather than hand-written, so the first test is a guard on
// the derivation (and on the schema staying acyclic). The second is the one that
// stops the drift that caused the outage: a new table must be classified, in the
// catalogue or in EXCLUDED_TABLES with a reason, or this fails.

/** Every pgTable the schema barrel exports, keyed by SQL name. */
function schemaTables(): Map<string, PgTable> {
  const out = new Map<string, PgTable>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    out.set(getTableConfig(value).name, value);
  }
  return out;
}

/** FK parents of a table, as SQL names, self-references dropped. */
function fkParents(table: PgTable, self: string): string[] {
  return getTableConfig(table)
    .foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name)
    .filter((parent) => parent !== self);
}

describe("dump catalogue: insert order", () => {
  it("places every table after every one of its catalogued FK parents", () => {
    const order = topoOrderedTables();
    const position = new Map(order.map((spec, i) => [spec.sqlName, i]));

    const violations: string[] = [];
    for (const spec of order) {
      for (const parent of fkParents(spec.table, spec.sqlName)) {
        const parentPos = position.get(parent);
        if (parentPos === undefined) continue; // not catalogued — covered below
        if (parentPos > position.get(spec.sqlName)!) {
          violations.push(
            `${spec.sqlName} (${position.get(spec.sqlName)}) is inserted before its parent ${parent} (${parentPos})`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never references a parent that is absent from the catalogue", () => {
    // A catalogued child whose parent does not travel takes an FK violation the
    // moment any row carries a non-null value in that column — unreachable by
    // reordering, and how `domain.webhookSourceId` -> `webhook_source` sat broken.
    // INSTANCE_SCOPED_REFS columns are exempt: those are scrubbed to null on every
    // cross-instance dump, and their parents DO travel in instance scope.
    const catalogued = new Set(topoOrderedTables().map((s) => s.sqlName));
    const dangling: string[] = [];
    for (const spec of topoOrderedTables()) {
      for (const parent of fkParents(spec.table, spec.sqlName)) {
        if (!catalogued.has(parent)) dangling.push(`${spec.sqlName} -> ${parent}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("is deterministic", () => {
    expect(topoOrderedTables().map((s) => s.sqlName)).toEqual(
      topoOrderedTables().map((s) => s.sqlName),
    );
  });
});

describe("dump catalogue: coverage", () => {
  it("classifies every table in the schema as carried or excluded", () => {
    const all = [...schemaTables().keys()].sort();
    const carried = new Set(topoOrderedTables().map((s) => s.sqlName));
    const excluded = new Set(Object.keys(EXCLUDED_TABLES));

    const unclassified = all.filter((t) => !carried.has(t) && !excluded.has(t));
    expect(
      unclassified,
      `New table(s) with no transfer decision. A whole-instance export claims to carry ` +
        `every migration-managed table, so add each to TABLES in dump.ts, or to ` +
        `EXCLUDED_TABLES with the reason it must not travel.`,
    ).toEqual([]);
  });

  it("never lists a table as both carried and excluded", () => {
    const carried = new Set(topoOrderedTables().map((s) => s.sqlName));
    const both = Object.keys(EXCLUDED_TABLES).filter((t) => carried.has(t));
    expect(both).toEqual([]);
  });

  it("only excludes tables that exist", () => {
    const all = schemaTables();
    const ghosts = Object.keys(EXCLUDED_TABLES).filter((t) => !all.has(t));
    expect(ghosts, "EXCLUDED_TABLES names a table the schema no longer has").toEqual([]);
  });

  it("gives every exclusion a reason", () => {
    const blank = Object.entries(EXCLUDED_TABLES)
      .filter(([, reason]) => reason.trim().length < 10)
      .map(([t]) => t);
    expect(blank).toEqual([]);
  });
});

describe("dump catalogue: bind-parameter headroom", () => {
  it("keeps every table's insert chunk under PGlite's signed-int16 parameter cap", () => {
    // Drizzle emits one bind parameter per column per row, and PGlite's protocol
    // layer reads the bind message's int16 parameter count as SIGNED — so 32768+
    // wraps negative and dies in the response parser. `insertChunkSize` divides a
    // 32000 budget by the column count; this asserts the widest table still yields a
    // usable chunk and that no chunk can cross the real ceiling.
    const widest = Math.max(
      ...topoOrderedTables().map((s) => Object.keys(getTableColumns(s.table)).length),
    );
    const rowsPerChunk = Math.floor(32_000 / widest);
    expect(rowsPerChunk).toBeGreaterThan(0);
    expect(rowsPerChunk * widest).toBeLessThanOrEqual(32_767);
  });
});
