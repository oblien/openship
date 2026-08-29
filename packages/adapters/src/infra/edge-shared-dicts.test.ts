import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EDGE_SHARED_DICTS } from "./openresty-lua";

/**
 * `EDGE_SHARED_DICTS` is the one declaration of the edge's shared-dict sizes, and
 * `edge-baked-conf.test.ts` already pins the generated container config against it.
 * That guard cannot see the OTHER writer: an openresty module migration, which is
 * a shell asset that resizes a dict in place on an already-installed box.
 *
 * The two disagreed. `rl_counters` was declared 16m while migration 1.1.0 existed
 * solely to raise it to 32m, so a fresh install wrote the size the migration
 * exists to correct, and only a bare box whose operator consented to a
 * consent-gated migration ever reached 32m. The container edge — the default
 * install — had no path there at all.
 *
 * Both writers stay: the `grep || sed` convergence in `ensureOpenRestyConfig` is
 * append-only by design and cannot resize an existing directive, so the migration
 * is how legacy boxes move. This pins that they agree on the DESTINATION.
 */

const CATALOG_DIR = join(__dirname, "../system/modules/catalog/openresty");

type Catalog = {
  versions: { version: string; steps: { asset?: string }[] }[];
};

const catalog: Catalog = JSON.parse(readFileSync(join(CATALOG_DIR, "catalog.json"), "utf8"));

/** Every `sed`/`grep` size a migration asset writes, as dict name → size. */
function migrationTargets(): Map<string, { size: string; asset: string }> {
  const out = new Map<string, { size: string; asset: string }>();
  for (const v of catalog.versions) {
    for (const step of v.steps) {
      if (!step.asset) continue;
      const body = readFileSync(join(CATALOG_DIR, step.asset), "utf8");
      // A mutating resize is `s/lua_shared_dict <name> <old>/lua_shared_dict <name> <new>/`;
      // the REPLACEMENT half is the size the box ends up at.
      for (const m of body.matchAll(
        /s\/lua_shared_dict\s+(\w+)\s+\w+\/lua_shared_dict\s+(\w+)\s+(\w+)\//g,
      )) {
        expect(m[1], `${step.asset} renames a dict mid-resize`).toBe(m[2]);
        out.set(m[1]!, { size: m[3]!, asset: step.asset });
      }
    }
  }
  return out;
}

describe("EDGE_SHARED_DICTS vs openresty module migrations", () => {
  it("finds the resize migrations it is meant to guard", () => {
    // If this fails the regex has drifted from the asset, and the test below is
    // passing vacuously — which is worse than the bug it was written to catch.
    expect(migrationTargets().size).toBeGreaterThan(0);
  });

  it("declares the same size a migration resizes each dict TO", () => {
    for (const [name, { size, asset }] of migrationTargets()) {
      const declared = EDGE_SHARED_DICTS.find((d) => d.name === name);
      expect(declared, `${asset} resizes '${name}', absent from EDGE_SHARED_DICTS`).toBeDefined();
      expect(
        declared!.size,
        `${asset} takes '${name}' to ${size}, but EDGE_SHARED_DICTS declares ` +
          `${declared!.size} — a fresh install would get the size the migration corrects`,
      ).toBe(size);
    }
  });
});
