/**
 * Restore an Openship DB dump into the current database.
 *
 *   bun --cwd packages/db db:restore --in backup.json
 *   bun --cwd packages/db db:restore --in backup.json --wipe-first
 *   bun --cwd packages/db db:restore --in backup.json --mode merge --remap-org <orgId>
 *
 * Pre-conditions:
 *   - The current install has run the SAME schema migrations as the
 *     dump's source (verified via dumpFormatVersion + Drizzle's own
 *     migration check at boot).
 *   - `--wipe-first` (the default) truncates every table before
 *     re-inserting; only valid for instance-scope dumps.
 *   - `--mode merge` skips truncation and inserts. PK conflicts roll
 *     back the whole transaction. Use for organization / project-scope
 *     dumps.
 *
 * Used by the path-A wizard (operator's VPS receives the dump and
 * restores it during `openship migrate-to`) and the reverse-migration
 * flow (download from remote, restore locally).
 */

import { readFileSync } from "node:fs";
import type { DatabaseDump } from "../src/dump";

async function main() {
  const args = process.argv.slice(2);
  const inIdx = args.indexOf("--in");
  const inPath = inIdx >= 0 ? args[inIdx + 1] : null;
  const noWipe = args.includes("--no-wipe-first");
  const modeIdx = args.indexOf("--mode");
  const modeArg = modeIdx >= 0 ? args[modeIdx + 1] : null;
  const remapOrgIdx = args.indexOf("--remap-org");
  const remapOrgId = remapOrgIdx >= 0 ? args[remapOrgIdx + 1] : undefined;

  if (!inPath) {
    console.error(
      "[db:restore] --in <path/to/dump.json> is required. Use - to read from stdin.",
    );
    process.exit(1);
  }

  const raw =
    inPath === "-"
      ? await readStdin()
      : readFileSync(inPath, { encoding: "utf-8" });

  let dump: DatabaseDump;
  try {
    dump = JSON.parse(raw) as DatabaseDump;
  } catch (err) {
    console.error("[db:restore] dump is not valid JSON:", err);
    process.exit(1);
  }

  const totalRows = Object.values(dump.tables).reduce(
    (n, rows) => n + rows.length,
    0,
  );
  console.error(
    `[db:restore] restoring ${totalRows} rows across ${Object.keys(dump.tables).length} tables (source: ${dump.sourceDriver}, scope: ${dump.scope?.kind ?? "unknown"}, exported ${dump.exportedAt})`,
  );

  let mode: "wipe" | "merge";
  if (modeArg === "merge") mode = "merge";
  else if (modeArg === "wipe") mode = "wipe";
  else mode = noWipe ? "merge" : "wipe";

  // NOTE: restoreSubgraph now ALWAYS nulls columns listed in
  // ENCRYPTED_COLUMNS on the receive side (cross-instance ciphertext
  // wouldn't decrypt anyway, and accepting it lets a tampered dump plant
  // arbitrary bytes in slots downstream code trusts as encrypted blobs).
  // For a same-host round-trip — `db:dump` followed immediately by
  // `db:restore` on the SAME instance — encrypted columns will come back
  // as NULL even though they were valid ciphertext on dump. Re-link those
  // secrets via the app (settings / env-var editors / backup destinations)
  // after restore. There is intentionally no flag to disable this.
  // Source-only command: use this installed PGlite package's own assets.
  delete process.env.OPENSHIP_PGLITE_ASSETS_DIR;
  const { restoreSubgraph } = await import("../src/dump");
  await restoreSubgraph(dump, { mode, ...(remapOrgId ? { remapOrgId } : {}) });

  console.error("[db:restore] done.");
  process.exit(0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

main().catch((err) => {
  console.error("[db:restore] failed:", err);
  process.exit(1);
});
