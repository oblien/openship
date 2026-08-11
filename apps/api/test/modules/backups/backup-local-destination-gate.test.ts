import "../mail/_setup-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * `kind: "local"` backup destinations write and DELETE on the filesystem of the box
 * the API runs on (`packages/adapters/src/backup/destinations/local.ts` → `fs.rename`,
 * `fs.unlink`). The adapter is deliberately env-blind — its own docblock says the gate
 * is "enforced at the apps/api layer, not here" — so apps/api is the only thing
 * standing between a destination row and the control-plane filesystem.
 *
 * That gate used to live ONLY where a row is written (create / update / draft
 * preflight in destination.service.ts). The three paths that CONSUME a row went
 * straight to `toAdapterRow` with no check:
 *   - a backup run          (backups/backup.orchestrator.ts)
 *   - the retention prune   (backups/retention-prune.ts, run by the
 *                            `retention-prune-daily` system job, which declares no
 *                            `available()` and therefore runs on every instance)
 *   - both restore phases   (backups/restore.orchestrator.ts)
 *
 * A write-path gate only constrains rows that took the write path, and
 * `backup_destination` is organization-scope dumpable — so an ingested row arrives
 * complete, having taken no path at all. The fix is that the gate now lives at the
 * consumer funnel every one of those shares.
 *
 * Asserted structurally for the reason deployment-status.test.ts gives: reaching
 * these through their orchestrators needs the DB + adapter + job graph, while the
 * invariant is a call-shape that source pins exactly as well. The two behavioural
 * assertions that DON'T need that graph are exercised directly below.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

/**
 * Comments AND import lines stripped. Both matter: the comments here NAME the gate
 * while explaining it, and — the reason this exists — an `import { assertLocal… }`
 * line matches a bare identifier search just as well as the call does. Anchoring on
 * the identifier alone made this file pass with the call deleted and only the import
 * left behind, which is the exact failure mode a structural guard is supposed not to
 * have.
 */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/^\s*import\s[\s\S]*?;\s*$/gm, "");

describe("local backup destinations are gated at the consumer", () => {
  it("toAdapterRow is the funnel, and it asks before hydrating", () => {
    const src = code(read("apps/api/src/modules/backup-destinations/hydrate-server.ts"));

    // The CALL, not the identifier — see `code()` above for why that distinction
    // is load-bearing. Must also be guarded by the local-kind check.
    const gateAt = src.search(/assertLocalDestinationAllowed\s*\(/);
    const localBranchAt = src.search(/row\.kind\s*===\s*["']local["']/);
    const serverBranchAt = src.indexOf('row.kind === "openship_server"');
    const passThroughAt = src.indexOf("return {");

    expect(gateAt, "toAdapterRow no longer CALLS the local-destination gate").toBeGreaterThan(-1);
    expect(localBranchAt, "the gate is no longer scoped to kind local").toBeGreaterThan(-1);
    expect(localBranchAt).toBeLessThan(gateAt);
    expect(serverBranchAt).toBeGreaterThan(-1);
    // Before BOTH exits — the openship_server branch and the pass-through return.
    // A gate after the return is not a gate.
    expect(gateAt).toBeLessThan(serverBranchAt);
    expect(gateAt).toBeLessThan(passThroughAt);
  });

  // If a consumer stops going through toAdapterRow, the gate above silently stops
  // covering it. This is the assertion that keeps that from happening quietly.
  const CONSUMERS: Array<{ what: string; file: string }> = [
    { what: "backup run", file: "apps/api/src/modules/backups/backup.orchestrator.ts" },
    { what: "retention prune", file: "apps/api/src/modules/backups/retention-prune.ts" },
    { what: "restore", file: "apps/api/src/modules/backups/restore.orchestrator.ts" },
  ];

  for (const { what, file } of CONSUMERS) {
    it(`${what} resolves its destination through toAdapterRow`, () => {
      const src = code(read(file));
      expect(src).toContain("toAdapterRow");
      // No consumer may build an adapter row by hand and skip the gate.
      expect(src).not.toMatch(/kind:\s*["']local["']/);
    });
  }

  it("the adapter stays env-blind, so apps/api remains the only gate", () => {
    const src = code(read("packages/adapters/src/backup/destinations/local.ts"));
    // If this ever gains its own env check, the comment in local-gate.ts explaining
    // why the gate lives in apps/api is stale and should be revisited.
    expect(src).not.toContain("CLOUD_MODE");
    expect(src).not.toContain("BACKUP_ALLOW_LOCAL_DESTINATION");
  });

  it("the write-path check and the consumer check are the same implementation", () => {
    const src = code(read("apps/api/src/modules/backup-destinations/destination.service.ts"));
    // destination.service.ts must DELEGATE, not carry a second copy of the policy —
    // two copies is how they came to disagree, with only one of them existing.
    expect(src).toMatch(/assertLocalDestinationAllowed\s*\(/);
    expect(src).not.toContain("Local destinations are disabled in cloud mode");
  });
});

describe("assertLocalDestinationAllowed", () => {
  it("refuses in cloud mode regardless of the allow flag", async () => {
    process.env.CLOUD_MODE = "true";
    process.env.BACKUP_ALLOW_LOCAL_DESTINATION = "true";
    process.env.BACKUP_LOCAL_ROOT = "/var/lib/openship/backups";
    vi.resetModules();
    const { assertLocalDestinationAllowed } = await import(
      "../../../src/modules/backup-destinations/local-gate"
    );
    await expect(
      assertLocalDestinationAllowed("/var/lib/openship/backups/x"),
    ).rejects.toThrow(/disabled in cloud mode/i);
  });

  it("refuses a local row with no endpoint rather than resolving against CWD", async () => {
    process.env.CLOUD_MODE = "";
    process.env.BACKUP_ALLOW_LOCAL_DESTINATION = "true";
    process.env.BACKUP_LOCAL_ROOT = "/var/lib/openship/backups";
    vi.resetModules();
    const { assertLocalDestinationAllowed } = await import(
      "../../../src/modules/backup-destinations/local-gate"
    );
    await expect(assertLocalDestinationAllowed(null)).rejects.toThrow(/no endpoint/i);
  });
});
