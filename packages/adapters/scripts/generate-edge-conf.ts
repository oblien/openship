/**
 * Write apps/edge/nginx.conf from `bakedEdgeNginxConf()`.
 *
 * The conf is COPYed into the edge image and so can't read a TS constant at
 * runtime; this is how the shared values (dict sizes, the ACME loopback port, the
 * challenge docroot, the sites-enabled path) get into it without a hand-kept copy.
 * `src/infra/edge-baked-conf.test.ts` fails if the checked-in file drifts from this
 * output, so run it after touching any of those constants.
 *
 *   bun run edge:conf        # from packages/adapters
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bakedEdgeNginxConf } from "../src/infra/edge-baked-conf";

const target = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/edge/nginx.conf");
const next = bakedEdgeNginxConf();
const current = (() => {
  try {
    return readFileSync(target, "utf-8");
  } catch {
    return null;
  }
})();

if (current === next) {
  console.log(`edge conf already up to date: ${target}`);
} else {
  writeFileSync(target, next, "utf-8");
  console.log(`${current === null ? "created" : "updated"} ${target}`);
}
