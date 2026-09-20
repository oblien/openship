/**
 * Dump the current Openship DB to a JSON file.
 *
 *   bun --cwd packages/db db:dump > backup.json
 *   bun --cwd packages/db db:dump --out path/to/dump.json
 *   bun --cwd packages/db db:dump --scope instance
 *   bun --cwd packages/db db:dump --scope organization --org <orgId>
 *   bun --cwd packages/db db:dump --scope project --project <projectId>
 *
 * The output is a `DatabaseDump` envelope — drop it into another
 * Openship install (same migration version) via `db:restore`. Written
 * to stdout when --out is omitted so it can be piped to ssh / pv / etc.
 *
 * Used by the team-mode migration wizards (path A: copy to operator's
 * VPS; path B: upload to Openship Cloud) but works standalone for
 * ad-hoc snapshots too.
 */

import { writeFileSync } from "node:fs";
import type { SubgraphScope } from "../src/dump";

function parseScope(args: string[]): SubgraphScope {
  const scopeIdx = args.indexOf("--scope");
  const kind = scopeIdx >= 0 ? args[scopeIdx + 1] : "instance";
  if (!kind || kind === "instance") return { kind: "instance" };
  if (kind === "organization") {
    const orgIdx = args.indexOf("--org");
    const organizationId = orgIdx >= 0 ? args[orgIdx + 1] : undefined;
    if (!organizationId) {
      console.error("[db:dump] --scope organization requires --org <organizationId>");
      process.exit(1);
    }
    return { kind: "organization", organizationId };
  }
  if (kind === "project") {
    const projIdx = args.indexOf("--project");
    const projectId = projIdx >= 0 ? args[projIdx + 1] : undefined;
    if (!projectId) {
      console.error("[db:dump] --scope project requires --project <projectId>");
      process.exit(1);
    }
    return { kind: "project", projectId };
  }
  console.error(`[db:dump] unknown --scope value: ${kind} (expected: instance | organization | project)`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  // `--strip-encrypted` nulls every column listed in ENCRYPTED_COLUMNS
  // (cloud session token, clone tokens, env var values, backup creds,
  // notification channel configs) and records the affected fields in
  // dump.strippedEncryptedFields. Required for any cross-host
  // migration — the destination has a different BETTER_AUTH_SECRET and
  // can't decrypt the source's blobs.
  const stripEncrypted = args.includes("--strip-encrypted");
  const scope = parseScope(args);

  // Source-only command: use this installed PGlite package's own assets.
  delete process.env.OPENSHIP_PGLITE_ASSETS_DIR;
  const { dumpSubgraph } = await import("../src/dump");
  const dump = await dumpSubgraph(scope, { stripEncrypted });
  const payload = JSON.stringify(dump, null, 2);

  if (outPath) {
    writeFileSync(outPath, payload, { encoding: "utf-8", mode: 0o600 });
    const totalRows = Object.values(dump.tables).reduce(
      (n, rows) => n + rows.length,
      0,
    );
    console.error(
      `[db:dump] wrote ${totalRows} rows across ${Object.keys(dump.tables).length} tables to ${outPath} (driver=${dump.sourceDriver}, scope=${dump.scope.kind})`,
    );
  } else {
    process.stdout.write(payload);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[db:dump] failed:", err);
  process.exit(1);
});
